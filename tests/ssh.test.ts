/**
 * 隧道那一层:参数拼装与"起不来时要说话"。
 *
 * 为什么专门测这个:2026-10-09 云上实测时,隧道起不来是**静默**的 ——
 * World 一直用着空日志,而 Windows 自带的 ssh 因为私钥权限太开放直接忽略那把钥匙
 * ("UNPROTECTED PRIVATE KEY FILE"),进程起来就死。整条链上没有任何人说话。
 * 所以这里两条都钉住:**参数不许拼错**(`-p null` 这种)、**失败必须往外喊一声**。
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SshTunnel } from '../src/ssh.ts';

/** 假 ssh 进程:记下参数,然后由测试决定它怎么"死"。 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    return true;
  }
}

function makeSpawn(): { spawn: never; calls: Array<{ exe: string; args: string[] }>; children: FakeChild[] } {
  const calls: Array<{ exe: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawn = ((exe: string, args: string[]) => {
    calls.push({ exe, args });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as never;
  return { spawn, calls, children };
}

const base = {
  exePath: 'ssh',
  host: '203.0.113.10',
  user: 'root',
  port: 22,
  keyFile: 'C:/keys/phone-tunnel-key',
  localPort: 6120,
  remotePort: 6120,
};

describe('隧道的参数', () => {
  it('端口/转发/密钥都拼对,而且绝不出现 null', () => {
    const io = makeSpawn();
    const tunnel = new SshTunnel({ ...base, spawnImpl: io.spawn });
    tunnel.start();
    const args = io.calls[0]!.args.join(' ');
    expect(io.calls[0]!.exe).toBe('ssh');
    expect(args).toContain('-L 6120:127.0.0.1:6120');
    expect(args).toContain('-p 22');
    expect(args).toContain('-i C:/keys/phone-tunnel-key');
    expect(args).not.toMatch(/null|undefined/);
    // 绝不弹密码提示:弹了没人答,子进程会挂在那儿一动不动(最难查的一种坏)。
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain('ServerAliveInterval=15');
    tunnel.stop();
  });

  it('密钥为空时不带 -i(交给 ssh 自己的默认值)', () => {
    const io = makeSpawn();
    const tunnel = new SshTunnel({ ...base, keyFile: '', spawnImpl: io.spawn });
    tunnel.start();
    expect(io.calls[0]!.args.join(' ')).not.toContain('-i ');
    tunnel.stop();
  });

  /**
   * 桥在容器里跑时(`--network bridge`),容器自己的回环与宿主的回环不是同一个 ——
   * `-L ...:127.0.0.1:...` 够不着它,得指容器地址。这一格是 2026-10-11 试炼容器
   * (SnowLuma 那条界面驱动的路)逼出来的。
   */
  it('给了 remoteHost 就转发到那个地址;没给还是 127.0.0.1', () => {
    const io = makeSpawn();
    const tunnel = new SshTunnel({ ...base, remoteHost: '172.17.0.2', spawnImpl: io.spawn });
    tunnel.start();
    expect(io.calls[0]!.args.join(' ')).toContain('-L 6120:172.17.0.2:6120');
    tunnel.stop();

    const io2 = makeSpawn();
    const plain = new SshTunnel({ ...base, spawnImpl: io2.spawn });
    plain.start();
    expect(io2.calls[0]!.args.join(' ')).toContain('-L 6120:127.0.0.1:6120');
    plain.stop();
  });
});

describe('起不来时必须说话', () => {
  it('ssh 起来就死并吐了原因 ⇒ onProblem 拿到原文', async () => {
    const io = makeSpawn();
    const problems: string[] = [];
    const tunnel = new SshTunnel({ ...base, spawnImpl: io.spawn, settleMs: 60_000, onProblem: (t) => problems.push(t) });
    tunnel.start();
    const child = io.children[0]!;
    child.stderr.emit('data', Buffer.from('Bad permissions. UNPROTECTED PRIVATE KEY FILE!\n'));
    child.exitCode = 255;
    child.emit('close', 255);
    await new Promise((r) => setTimeout(r, 10));
    expect(problems.join()).toContain('UNPROTECTED PRIVATE KEY FILE');
    tunnel.stop();
  });

  it('spawn 报 ENOENT(ssh 不在 PATH 上)⇒ onProblem 也说一声', async () => {
    const io = makeSpawn();
    const problems: string[] = [];
    const tunnel = new SshTunnel({ ...base, spawnImpl: io.spawn, onProblem: (t) => problems.push(t) });
    tunnel.start();
    io.children[0]!.emit('error', new Error('spawn ssh ENOENT'));
    await new Promise((r) => setTimeout(r, 10));
    expect(problems.join()).toContain('ENOENT');
    tunnel.stop();
  });

  it('稳稳跑着的时候不喊(别把正常握手当成故障)', async () => {
    const io = makeSpawn();
    const problems: string[] = [];
    const tunnel = new SshTunnel({ ...base, spawnImpl: io.spawn, onProblem: (t) => problems.push(t) });
    tunnel.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(problems).toEqual([]);
    expect(tunnel.running).toBe(true);
    tunnel.stop();
    expect(tunnel.running).toBe(false);
  });
});

describe('runRemote(自愈那条路)', () => {
  it('跑一次独立连接,回的是命令输出', async () => {
    const calls: string[][] = [];
    const spawn = ((_exe: string, args: string[]) => {
      calls.push(args);
      const child = new FakeChild();
      setTimeout(() => {
        child.emit('close', 0);
      }, 5);
      // stdout 用一个最小的替身即可(只需要能挂 data 监听)。
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      return child as unknown as ChildProcess;
    }) as unknown as never;
    const tunnel = new SshTunnel({ ...base, spawnImpl: spawn });
    const result = await tunnel.runRemote('docker exec phone-test pkill -f av-host-profile');
    expect(result.ok).toBe(true);
    // 最后一段参数就是要在云上跑的命令;前面是那串 ssh 选项。
    expect(calls[0]!.at(-1)).toBe('docker exec phone-test pkill -f av-host-profile');
    expect(calls[0]!.at(-2)).toBe('root@203.0.113.10');
  });
});
