/**
 * 桥的客户端:和云上那个守护进程的一条 WebSocket。
 *
 * 为什么要用 `ws` 这个包而不是 Node 自带的 `WebSocket`:上游握手时**必须**带
 * `Authorization: Bearer <token>`,而 Node 自带的 WebSocket(undici)按 WHATWG 规范
 * 不允许设自定义请求头。`ws` 允许。框架内建 qq World 的 driver 也是这个选择。
 *
 * 上游握手还有三条硬条件(读 `daemon.mjs` 得到的,不是猜的):
 * 1. 路径必须是 `/v1/stream`;
 * 2. **不能有 `Origin` 头**(有就 403)。Node 端的 `ws` 默认不发 Origin,正合适;
 * 3. **同时只允许一个对端** —— 第二条连接直接被 403。所以这一包里只允许存在一个
 *    BridgeClient,别的地方不许再连一次。
 *
 * 命令与回执是一问一答:`{type:'request', id, op, args}` → `{type:'reply', id, ok, data|error}`。
 * 上游对**同一个 id** 的处理是"返回保留的那份回执、不重发命令",所以断线重试必须复用 id,
 * 不能换新 id —— 换了就会把同一条命令真的执行第二次(挂断发两遍、音频写两遍)。
 */
import WebSocket from 'ws';
import { describe, type VoiceLoggerLike } from './util.ts';

/** 通话对象。上游的字段比这多,这里只留我们要用的,外加一个 `raw` 兜底。 */
export interface BridgeCall {
  id: string;
  kind: string;
  direction: string;
  /** ⚠️ 是 `phase` 不是 `state`。值见过:ringing / accepted / connected / rejecting / ended。 */
  phase: string;
  callerUin?: string;
  callerUid?: string;
  peerUin?: string;
  peerUid?: string;
  inviteAt?: number;
  endedAt?: number;
  acceptReady?: boolean;
  media?: string;
  muted?: boolean;
  nativeEndEvent?: string;
  raw: Record<string, unknown>;
}

export interface BridgeAudioFrame {
  callId: string;
  encoding: string;
  sampleRate: number;
  channels: number;
  sequence: number;
  timestamp: number;
  data: string;
}

export interface BridgeStatus {
  account?: { selfId?: string; platform?: string };
  audioFormat?: { sampleRate?: number; channels?: number; encoding?: string };
  capabilities?: Record<string, { supported?: boolean; reason?: string }>;
  calls?: BridgeCall[];
  diagnostics?: Array<{ id?: string; level?: string; message?: string }>;
}

export interface BridgePlaybackReceipt {
  id: string;
  callId: string;
  state: string;
  [key: string]: unknown;
}

export interface BridgeError {
  code: string;
  message: string;
}

export interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: BridgeError;
}

export interface BridgeHandlers {
  onOpen?(): void;
  onClose?(willReconnect: boolean): void;
  onCall?(call: BridgeCall): void;
  onAudio?(frame: BridgeAudioFrame): void;
  onPlayback?(receipt: BridgePlaybackReceipt): void;
  onStatus?(status: BridgeStatus, kind: 'hello' | 'status'): void;
  /** 桥自己报的错误(音频后端坏了、媒体运行时出错等)。 */
  onError?(message: string): void;
}

export interface BridgeClientOptions {
  url: string;
  token: string;
  handlers: BridgeHandlers;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  log?: VoiceLoggerLike;
  /** 测试用的替身;生产用 `ws`。 */
  WebSocketImpl?: typeof WebSocket;
  /** 单条命令的等待上限(毫秒)。 */
  requestTimeoutMs?: number;
}

/**
 * 把上游那份通话对象收敛成我们认得的几个字段。缺 id 或缺状态字的直接当无效。
 *
 * ⚠️ **上游有**两**种形状,这里两种都认** —— 2026-10-09 实测踩过一次:
 *
 * | 谁给的 | 状态字 | 对方是谁 | id |
 * |---|---|---|---|
 * | 容器内的**插件口**(`/v1/calls/current`) | `phase` | `callerUin` | 裸 id |
 * | **守护进程那条 WS**(我们要连的就是它) | `state` | `targetId` | `${bootId}:${linkEpoch}:${id}` |
 *
 * 上一份交接记的是**插件口**的形状(因为它当时是拿 curl 读的),而我们的 World 连的是**守护进程**,
 * 那一侧的组装在 `daemon.mjs:119`:`state` / `targetId`(来电时 = `callerUin||callerUid`)/ `createdAt`。
 * 结果:World 读 `phase` 永远读到空 ⇒ 返回 null ⇒ **每一通电话都被静静忽略**(他打过去"没接听")。
 *
 * 所以这里按"**有什么认什么**"来收敛,而不是死认一套字段名;id 必须原样带走 ——
 * 上游对 `accept`/`hangup` 校验 `id.startsWith(bootId:epoch:)`,拿裸 id 去发会被判 `STALE_CALL`。
 */
export function normalizeCall(raw: unknown): BridgeCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  // `phase` 是插件口的写法,`state` 是守护进程的写法。
  const phase = (typeof r.phase === 'string' && r.phase) || (typeof r.state === 'string' && r.state) || '';
  if (!id || !phase) return null;
  // 号码这类字段上游有时给字符串、有时给数字(实测两种都见过)，所以数字也认。
  const str = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v === '' ? undefined : v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return undefined;
  };
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  // 来电时 `targetId` 就是打来的那个号(守护进程那句 `c.callerUin||c.callerUid`);拨出时是对方。
  const target = str(r.targetId);
  const callerUin = str(r.callerUin) ?? str(r.peerUin) ?? target;
  return {
    id,
    kind: str(r.kind) ?? 'unknown',
    direction: str(r.direction) ?? 'unknown',
    phase,
    callerUin,
    callerUid: str(r.callerUid),
    peerUin: str(r.peerUin) ?? target,
    peerUid: str(r.peerUid),
    // 守护进程用的是 `createdAt`(它自己按插件的 `inviteAt` 换算好的毫秒值)。
    inviteAt: num(r.inviteAt) ?? num(r.createdAt),
    // 结束时刻:没有 `endedAt` 时用 `updatedAt`(终态那一刻它就等于结束时刻)。
    endedAt: num(r.endedAt) ?? num(r.updatedAt),
    acceptReady: r.acceptReady === true,
    media: str(r.media),
    muted: r.muted === true,
    // 原生结束原因:插件口叫 `nativeEndEvent`,守护进程那一侧叫 `endReason`。
    nativeEndEvent: str(r.nativeEndEvent) ?? str(r.endReason) ?? str(r.error),
    raw: r,
  };
}

/** 已经结束、不可能再动的状态。 */
export function isTerminal(phase: string): boolean {
  return phase === 'ended' || phase === 'error' || phase === 'failed';
}

/**
 * 桥回的那张截图(`screenshot` op 的 `data`)→ 事件附件;**形状不对就当没有**,绝不猜。
 *
 * 为什么要单独成函数:这一段是"外面给的东西",而它进的是**模型的眼睛**(多模态图片块)——
 * 半张图、空串、base64 解出来几个字节,都会变成一条看着像回事的假证据。
 * 所以宁可返回 undefined(World 那边就当没有截图,正文退回到照实报桥给的号)。
 *
 * 谁给的:界面驱动版桥(它看得见屏幕、报不出号码,只好把图交出来)。老桥没有这个 op,
 * 连这一步都到不了 —— 调用方先看 `reply.ok`。
 */
export function screenshotBlob(data: unknown): { bytes: Uint8Array; mime: string; name: string; fallbackText: string } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const raw = data as { pngBase64?: unknown; mime?: unknown };
  if (typeof raw.pngBase64 !== 'string' || raw.pngBase64.trim() === '') return undefined;
  const bytes = Buffer.from(raw.pngBase64, 'base64');
  // 一张空白小窗也有几 KB;几十个字节只能是"解错了"(base64 里混了非 base64 的字符会被静默丢掉)。
  if (bytes.length < 512) return undefined;
  const mime = typeof raw.mime === 'string' && raw.mime.startsWith('image/') ? raw.mime : 'image/png';
  return {
    bytes,
    mime,
    name: 'incoming-call.png',
    fallbackText: '来电界面的截图(谁打来的写在这张图上)',
  };
}

export class BridgeClient {
  private readonly opts: BridgeClientOptions;
  private readonly log: VoiceLoggerLike;
  private readonly timeoutMs: number;
  private ws?: WebSocket;
  private stopped = false;
  private backoffMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { settle: (reply: BridgeReply) => void; timer: NodeJS.Timeout; op: string; args: Record<string, unknown> }
  >();
  /** 最近一次收到的状态快照(hello 或 status)。`hello` 是连上时必发的那一份。 */
  private lastStatus?: BridgeStatus;

  constructor(opts: BridgeClientOptions) {
    this.opts = opts;
    this.log = opts.log ?? {};
    this.timeoutMs = Math.max(1000, opts.requestTimeoutMs ?? 15000);
    this.backoffMs = Math.max(200, opts.reconnectBaseMs ?? 1000);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get status(): BridgeStatus | undefined {
    return this.lastStatus;
  }

  start(): void {
    this.stopped = false;
    this.connectAttempt();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending('桥已停止');
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      /* 关不掉就算了:进程退出时它会跟着走 */
    }
  }

  /**
   * 发一条命令。
   *
   * `retrySameId` 用来处理"连接断了、命令可能已经提交了"这种不确定:
   * 上游对同一个 id 会返回保留的回执而不重发命令,所以复用 id 是**安全的重试**。
   */
  async request(
    op: string,
    args: Record<string, unknown> = {},
    opts: { retrySameId?: boolean; signal?: AbortSignal } = {},
  ): Promise<BridgeReply> {
    const cancelled = (): BridgeReply => ({ ok: false, error: { code: 'CANCELLED', message: '本次请求已取消等待' } });
    if (opts.signal?.aborted) return cancelled();
    const id = this.nextRequestId(op);
    if (!opts.signal) return this.sendOnce(id, op, args, opts.retrySameId === true);
    const signal = opts.signal;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<BridgeReply>(resolve => {
      onAbort = () => {
        const entry = this.pending.get(id);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(id); entry.settle(cancelled()); }
        resolve(cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // 取消只结束本地等待；已提交给桥的操作要由 audio.clear 撤销。
    try { return await Promise.race([this.sendOnce(id, op, args, false), aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  /** 只给"重试复用 id"用:把 id 与内容再发一次。 */
  private async sendOnce(id: string, op: string, args: Record<string, unknown>, allowRetry: boolean): Promise<BridgeReply> {
    const first = await this.sendRaw(id, op, args);
    if (first) return first;
    // 第一次没等到回执(多半是连接断了)。连接重连成功后,用同一个 id 再发一次。
    if (!allowRetry || this.stopped) return { ok: false, error: { code: 'NO_CONNECTION', message: '桥没连着' } };
    const back = await this.waitForConnection(Math.min(this.timeoutMs, 20000));
    if (!back) return { ok: false, error: { code: 'NO_CONNECTION', message: '桥没连着(等重连超时)' } };
    return (
      (await this.sendRaw(id, op, args)) ?? {
        ok: false,
        error: { code: 'NO_REPLY', message: '重发后仍没有回执' },
      }
    );
  }

  private sendRaw(id: string, op: string, args: Record<string, unknown>): Promise<BridgeReply> | null {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    return new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'TIMEOUT', message: `等 ${op} 的回执超时` } });
      }, this.timeoutMs);
      this.pending.set(id, { settle: resolve, timer, op, args });
      try {
        ws.send(JSON.stringify({ type: 'request', id, op, args }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'SEND_FAILED', message: describe(error) } });
      }
    });
  }

  private waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        if (this.connected) return resolve(true);
        if (this.stopped || Date.now() > deadline) return resolve(false);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  private nextRequestId(op: string): string {
    this.seq += 1;
    // 上游要求 id 是 1..80 字符的非空串。带上 op 便于日志里认人。
    return `${op}-${Date.now().toString(36)}-${this.seq}`;
  }

  private connectAttempt(): void {
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
        // 音频帧不值得再压一遍;而且压缩会把小块攒起来,增加延迟。
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      });
    } catch (error) {
      this.log.warn?.('桥连接起不来', { error: describe(error) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) return;
      this.backoffMs = Math.max(200, this.opts.reconnectBaseMs ?? 1000);
      this.log.info?.('桥已连上');
      this.opts.handlers.onOpen?.();
      // 连上时上游一定会发一份 `hello` 状态,里面带全部通话 ——
      // 断线期间漏掉的通话/挂断就靠它对齐,不必自己补事件。
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (this.stopped || this.ws !== ws) return;
      let packet: Record<string, unknown>;
      try {
        packet = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.dispatch(packet);
    });

    ws.on('error', (error: Error) => {
      this.log.warn?.('桥连接出错', { error: describe(error) });
    });

    ws.on('close', () => {
      const isCurrent = this.ws === ws;
      if (isCurrent) this.ws = undefined;
      this.rejectAllPending('桥的连接断开了');
      if (!isCurrent || this.stopped) return;
      this.log.info?.('桥断开了,等重连');
      this.opts.handlers.onClose?.(true);
      this.scheduleReconnect();
    });
  }

  private dispatch(packet: Record<string, unknown>): void {
    const type = typeof packet.type === 'string' ? packet.type : '';
    switch (type) {
      case 'reply': {
        const id = typeof packet.id === 'string' ? packet.id : '';
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.settle({
          ok: packet.ok === true,
          data: packet.data,
          error: (packet.error as BridgeError | undefined) ?? undefined,
        });
        return;
      }
      case 'call': {
        const call = normalizeCall(packet.call);
        if (call) this.opts.handlers.onCall?.(call);
        return;
      }
      case 'audio': {
        const frame = packet.frame as BridgeAudioFrame | undefined;
        if (frame && typeof frame.data === 'string') this.opts.handlers.onAudio?.(frame);
        return;
      }
      case 'playback': {
        const receipt = packet.receipt as BridgePlaybackReceipt | undefined;
        if (receipt) this.opts.handlers.onPlayback?.(receipt);
        return;
      }
      case 'status':
      case 'hello': {
        this.lastStatus = packet as unknown as BridgeStatus;
        this.opts.handlers.onStatus?.(this.lastStatus, type === 'hello' ? 'hello' : 'status');
        return;
      }
      case 'error': {
        this.opts.handlers.onError?.(typeof packet.message === 'string' ? packet.message : '桥报了一个错');
        return;
      }
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, Math.max(1000, this.opts.reconnectMaxMs ?? 30000));
    this.log.info?.(`${delay}ms 后重连桥`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectAttempt();
    }, delay);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.settle({ ok: false, error: { code: 'DISCONNECTED', message: reason } });
      this.pending.delete(id);
    }
  }
}
