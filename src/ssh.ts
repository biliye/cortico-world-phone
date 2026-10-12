/**
 * SSH 隧道:把云上容器回环上的桥端口,搬到本机回环上。
 *
 * 为什么必须有这一层:桥**只肯绑回环**(上游 `createDaemon` 里那条硬约束),
 * 而它在云上的容器里。想够着它,要么隧道,要么在云上做 TLS 反代。
 * 隧道这条不新增对外暴露面,所以是默认。
 *
 * 为什么只走密钥:密码登录每次都要人输密码,而这条隧道得开机就在、断了自己起。
 * 另有一道保险:`BatchMode=yes` 让它**绝不弹密码提示** —— 弹了也没人答,
 * 子进程会挂在那儿一动不动,那种"看起来在跑、其实连不上"最难查。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, type VoiceLoggerLike } from './util.ts';

export interface TunnelOptions {
  exePath: string;
  host: string;
  user: string;
  port: number;
  keyFile: string;
  localPort: number;
  remotePort: number;
  /**
   * 从**云上那一头**往哪个地址连(默认 `127.0.0.1`)。
   *
   * 为什么要有这一格:`-L` 的另一端是在云上解析的。桥跑在容器里时,容器自己的回环
   * 与宿主的回环不是同一个,`127.0.0.1` 够不着它 —— 这时要填容器的地址(如 `172.17.0.2`)。
   * 桥跑在宿主网络里(生产那套 `--network host`)就保持默认。
   */
  remoteHost?: string;
  log?: VoiceLoggerLike;
  /** 测试用替身。 */
  spawnImpl?: typeof spawn;
  /** 起来之后多久算"站稳了"(毫秒)。早于它退出会记一条明确的警告。 */
  settleMs?: number;
  /**
   * 隧道**起不来**时说一句(带 ssh 自己吐的原文)。
   *
   * 为什么要有这个回调而不是只写日志:**这一条最容易静默**。
   * 2026-10-09 实测踩到:Windows 自带的 ssh 会因为私钥权限太开放而
   * "ignore this key"(Git 自带的 ssh 不看这个),于是隧道进程起来就死、
   * 而 World 那一侧只会一直连不上 127.0.0.1 —— 没有这条回调,查起来无从下手。
   * World 把它变成一条 `phone.notice` 事件,他就能在时间线上看见原因。
   */
  onProblem?: (text: string) => void;
}

export interface RemoteRun {
  ok: boolean;
  output: string;
}

export class SshTunnel {
  private readonly opts: TunnelOptions;
  private readonly log: VoiceLoggerLike;
  private child?: ChildProcess;
  private stopped = false;
  private backoffMs = 1000;
  private restartTimer?: NodeJS.Timeout;
  private lastStderr = '';
  private startedAt = 0;

  constructor(opts: TunnelOptions) {
    this.opts = opts;
    this.log = opts.log ?? {};
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  start(): void {
    this.stopped = false;
    this.spawnTunnel();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    // Windows 上 `ssh.exe` 收到 SIGTERM 不一定走,直接 kill 更干脆;这里的隧道是无状态转发,杀掉没有副作用。
    try {
      child.kill();
    } catch {
      /* 已经没了 */
    }
  }

  /** 在云上跑一条命令(自愈那次用)。**每次一条独立连接**,不占隧道。 */
  runRemote(command: string, timeoutMs = 20000): Promise<RemoteRun> {
    const impl = this.opts.spawnImpl ?? spawn;
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (result: RemoteRun): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = impl(
        this.opts.exePath,
        [...this.baseArgs(), `${this.target()}`, command],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经没了 */
        }
        finish({ ok: false, output: `等 ${timeoutMs} 毫秒没有结果` });
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', (error) => finish({ ok: false, output: describe(error) }));
      child.on('close', (code) => finish({ ok: code === 0, output: out.trim() }));
    });
  }

  /** 隧道能不能开起来,等价于"这条连接登不登得上、转发建不建得成"。 */
  async probe(timeoutMs = 15000): Promise<RemoteRun> {
    const result = await this.runRemote('echo PHONE_TUNNEL_OK', timeoutMs);
    return { ok: result.ok && result.output.includes('PHONE_TUNNEL_OK'), output: result.output };
  }

  private target(): string {
    return `${this.opts.user}@${this.opts.host}`;
  }

  private baseArgs(): string[] {
    return [
      '-T',
      '-o',
      'BatchMode=yes',
      // 第一次见这台机器时不交互确认指纹;指纹变了会让 ssh 失败(那是另一回事,日志里看得见)。
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      ...(this.opts.keyFile ? ['-i', this.opts.keyFile] : []),
      '-p',
      String(this.opts.port),
    ];
  }

  private spawnTunnel(): void {
    if (this.stopped) return;
    const impl = this.opts.spawnImpl ?? spawn;
    this.lastStderr = '';
    this.startedAt = Date.now();
    const args = [
      ...this.baseArgs(),
      '-N',
      '-L',
      `${this.opts.localPort}:${this.opts.remoteHost ?? '127.0.0.1'}:${this.opts.remotePort}`,
      this.target(),
    ];
    let child: ChildProcess;
    try {
      child = impl(this.opts.exePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      this.log.warn?.('隧道起不来', { error: describe(error) });
      this.opts.onProblem?.(describe(error));
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.lastStderr = (this.lastStderr + chunk.toString('utf8')).slice(-500);
    });
    child.on('error', (error) => {
      // ENOENT 走这条路:命令名不对、或 ssh 不在 PATH 上。说清是"起不来"而不是"连不上"。
      const text = describe(error);
      this.log.warn?.('隧道进程出错', { error: text });
      this.opts.onProblem?.(text);
    });
    child.on('close', () => {
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = undefined;
      if (!wasCurrent || this.stopped) return;
      const lived = Date.now() - this.startedAt;
      if (lived < (this.opts.settleMs ?? 3000) && this.lastStderr.trim()) {
        // 起来就死,多半是密钥/端口被占/主机不对。把它当成一条要紧的话说出来,别让它无声循环。
        this.log.warn?.('隧道起来就退出了,看这句:', { stderr: this.lastStderr.trim() });
        this.opts.onProblem?.(this.lastStderr.trim());
      }
      this.log.info?.('隧道断了,准备重启');
      this.scheduleRestart();
    });
    this.log.info?.('隧道已拉起', { host: this.opts.host, local: this.opts.localPort });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnTunnel();
    }, delay);
  }
}
