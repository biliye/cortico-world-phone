/**
 * 假桥:按上游 `daemon.mjs` 的**外部可观察契约**做一个最小的守护进程。
 *
 * 它只实现"我们的 World 会用到的那一部分",但**三条握手硬条件一个不少**:
 * 路径必须是 `/v1/stream`、必须带 `Authorization: Bearer <token>`、不能带 `Origin`。
 * 少实现哪一条,真机上的失败就会跑到第三级(他打电话时)才发现 —— 那是最贵的地方。
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/**
 * 假桥里的通话对象**要与守护进程那条 WS 上那份同形**(`daemon.mjs:119`):
 * `state`(不是 `phase`)、`targetId`(来电时是来电号)、id 带 `${bootId}:${linkEpoch}:` 前缀。
 *
 * 为什么较这个真:2026-10-09 实测过一件事 —— 单测里的假桥一开始用的是**我们自己假设的**形状
 * (`phase`/`callerUin`),于是真机上桥发的是 `state`/`targetId` 时,World 一个字段都读不到,
 * **每一通电话都被静静忽略**,而 94 条测试全绿。假件与真件不同形,等于没测。
 */
export interface FakeCall {
  /** 带 `${bootId}:0:` 前缀 —— 上游对 accept/hangup 校验这个前缀,拿裸 id 会被判 STALE_CALL。 */
  id: string;
  /** 插件那一侧给的裸 id。 */
  nativeId: string;
  kind: 'direct' | 'group';
  direction: 'incoming' | 'outgoing';
  state: string;
  /** 来电时 = 来电号;拨出时 = 对方。 */
  targetId: string;
  createdAt: number;
  participants: Array<{ id: string; identity: string }>;
  muted: boolean;
  updatedAt: number;
  /** 终态上可能带的错误(守护进程那一侧是 `error`,不是 `endReason`)。 */
  error?: unknown;
}

export interface RecordedRequest {
  op: string;
  args: Record<string, unknown>;
  /** 请求 id —— 上游对它有 80 字符上限，测试要能量到它。 */
  id?: string;
}

export class FakeBridge {
  readonly requests: RecordedRequest[] = [];
  readonly calls = new Map<string, FakeCall>();
  readonly token: string;
  private server?: WebSocketServer;
  private peer?: WebSocket;
  private rejected = 0;
  private seq = 0;
  /** 命令的行为可以按测试需要替换;默认都成功。 */
  onRequest?: (op: string, args: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: { code: string; message: string } } | undefined;
  /**
   * 哪些命令**不回执**。测"命令在断线时立刻失败"要用它 ——
   * 真桥在音频后端卡住时也会出现"收到命令但长时间不给回执"。
   */
  holdOps = new Set<string>();
  /**
   * `audio.write` 的回执慢多少毫秒。
   *
   * 默认真桥"很快给回执",那样播放队列会瞬间被排空,
   * 抢话(它考查的正是"队列里还有没有没放完的东西")就没法稳定地测。
   */
  audioWriteDelayMs = 0;

  constructor(token = 'x'.repeat(48)) {
    this.token = token;
  }

  async listen(): Promise<string> {
    const server = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    this.server = server;
    const http = (await import('node:http')).createServer();
    http.on('upgrade', (req, socket, head) => {
      const auth = req.headers.authorization ?? '';
      const badPath = req.url !== '/v1/stream';
      const badAuth = auth !== `Bearer ${this.token}`;
      const hasOrigin = typeof req.headers.origin === 'string' && req.headers.origin !== '';
      if (badPath || badAuth || hasOrigin || this.peer) {
        this.rejected += 1;
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      server.handleUpgrade(req, socket, head, (client) => server.emit('connection', client, req));
    });
    server.on('connection', (socket) => {
      this.peer = socket;
      socket.on('close', () => {
        if (this.peer === socket) this.peer = undefined;
      });
      socket.on('message', (data) => this.dispatch(socket, String(data)));
      this.push({ type: 'hello', ...this.status('hello') });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    this.http = http;
    return `ws://127.0.0.1:${port}/v1/stream`;
  }

  private http?: import('node:http').Server;

  /** 被拒的连接数(测握手那三条用)。 */
  get rejectedCount(): number {
    return this.rejected;
  }

  get connected(): boolean {
    return this.peer !== undefined && this.peer.readyState === 1;
  }

  async close(): Promise<void> {
    this.peer?.close();
    this.peer = undefined;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  /** 把当前对端踢掉(测重连)。 */
  dropPeer(): void {
    this.peer?.terminate();
    this.peer = undefined;
  }

  push(packet: unknown): void {
    if (this.peer?.readyState === 1) this.peer.send(JSON.stringify(packet));
  }

  status(type = 'status'): Record<string, unknown> {
    return {
      type,
      version: 1,
      account: { selfId: '10001', platform: 'qq' },
      audioFormat: { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le' },
      capabilities: {},
      calls: [...this.calls.values()],
      diagnostics: [],
    };
  }

  /** 模拟一通来电:从 ringing 开始。`callId` 是插件那一侧的裸 id。 */
  readonly bootId = 'boot';
  private fullId(nativeId: string): string {
    return `${this.bootId}:0:${nativeId}`;
  }

  ring(callId: string, callerUin: string, extra: Partial<FakeCall> = {}): FakeCall {
    const call: FakeCall = {
      id: this.fullId(callId),
      nativeId: callId,
      kind: 'direct',
      direction: 'incoming',
      state: 'ringing',
      targetId: callerUin,
      createdAt: Date.now(),
      participants: [],
      muted: false,
      updatedAt: Date.now(),
      ...extra,
    };
    this.calls.set(callId, call);
    this.push({ type: 'call', call });
    return call;
  }

  /**
   * 推一条**同一通的更新**(不改 id)——
   * 上游就会这样先推一条只有 id 的、号码过几十毫秒才补上(2026-10-09 实测)。
   */
  update(callId: string, patch: Partial<FakeCall>): FakeCall {
    const nativeId = this.nativeOf(callId);
    const previous = this.calls.get(nativeId) ?? this.ring(nativeId, 'unknown');
    const call: FakeCall = { ...previous, ...patch, updatedAt: Date.now() };
    this.calls.set(nativeId, call);
    this.push({ type: 'call', call });
    return call;
  }

  /**
   * 取一通。**两种 id 都认**:World 从 WS 上拿到的是带前缀的那个(bootId:epoch:裸id),
   * 它发 accept/hangup 时原样带回来,而测试里用手写的裸 id 更顺手。
   */
  get(callId: string): FakeCall | undefined {
    return this.calls.get(this.nativeOf(callId));
  }

  /** `boot:0:c1` → `c1`;裸 id 原样返回。 */
  private nativeOf(id: string): string {
    const parts = id.split(':');
    return parts.length >= 3 ? parts.slice(2).join(':') : id;
  }

  /** 把一通的状态改掉并推出去(与守护进程一样:同时更新 updatedAt)。 */
  setPhase(callId: string, state: string, extra: Partial<FakeCall> = {}): FakeCall {
    const nativeId = this.nativeOf(callId);
    const previous = this.calls.get(nativeId) ?? this.ring(nativeId, 'unknown');
    const call: FakeCall = { ...previous, ...extra, state, updatedAt: Date.now() };
    this.calls.set(nativeId, call);
    this.push({ type: 'call', call });
    return call;
  }

  /** 推一帧对方的音频(裸 PCM，会被 base64 包起来)。 */
  pushAudioFrame(callId: string, pcm: Buffer, sampleRate = 48000, channels = 2): void {
    this.seq += 1;
    // 守护进程推音频时带的是**带前缀的 call.id**(它按 `activeAudio.id` 填),World 也按它比对。
    this.push({
      type: 'audio',
      frame: {
        callId: this.fullId(this.nativeOf(callId)),
        encoding: 'pcm_s16le',
        sampleRate,
        channels,
        sequence: this.seq,
        timestamp: Date.now(),
        data: pcm.toString('base64'),
      },
    });
  }

  private async dispatch(socket: WebSocket, raw: string): Promise<void> {
    let packet: { type?: string; id?: string; op?: string; args?: Record<string, unknown> };
    try {
      packet = JSON.parse(raw) as typeof packet;
    } catch {
      return;
    }
    if (packet.type !== 'request' || typeof packet.id !== 'string' || typeof packet.op !== 'string') return;
    const args = packet.args ?? {};
    this.requests.push({ op: packet.op, args, id: packet.id });
    // 上游对请求形状的**硬校验**(`daemon.mjs:511`)。照抄它的判据是拿代价换来的:
    // 2026-10-15 World 把 81 字符的**播放编号**当成了**请求 id**(桥的 `request.id` 上限 80),
    // 桥每一块都回 INVALID_REQUEST、她一个字都出不去,而当时 189 条单测全绿 ——
    // 假桥没校这一条。契约在假件里漏一格,就得等到第三级(他打电话时)才暴露。
    if (!packet.id || packet.id.length > 80) {
      this.reply(socket, packet.id, { ok: false, error: { code: 'INVALID_REQUEST', message: '无效请求' } });
      return;
    }
    if (packet.op === 'audio.write') {
      // `daemon.mjs:575` 音频字段校验里最容易写错的两条:id 的上限、以及帧与通话对不上。
      const frame = (args.frame ?? {}) as { data?: unknown; callId?: unknown };
      const playbackId = typeof args.playbackId === 'string' ? args.playbackId : '';
      const bad =
        !playbackId || playbackId.length > 160 || typeof frame.data !== 'string' ||
        frame.callId !== args.callId ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data);
      if (bad) {
        this.reply(socket, packet.id, { ok: false, error: { code: 'INVALID_AUDIO', message: '音频格式必须与桥接配置相同' } });
        return;
      }
    }
    if (packet.op === 'audio.write' && this.audioWriteDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.audioWriteDelayMs));
    }
    if (this.holdOps.has(packet.op)) return;
    const custom = this.onRequest?.(packet.op, args);
    this.reply(socket, packet.id, custom ?? this.defaultReply(packet.op, args));
  }

  private reply(
    socket: WebSocket,
    id: string,
    reply: { ok: boolean; data?: unknown; error?: { code: string; message: string } },
  ): void {
    if (socket.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        type: 'reply',
        id,
        ok: reply.ok,
        ...(reply.ok ? { data: reply.data ?? {} } : { error: reply.error }),
      }),
    );
  }

  private defaultReply(
    op: string,
    args: Record<string, unknown>,
  ): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const callId = typeof args.callId === 'string' ? args.callId : undefined;
    switch (op) {
      case 'accept': {
        if (callId) this.setPhase(callId, 'accepted');
        // 真桥是异步接通的:这里也慢一拍,好让测试看见"submitted ≠ connected"。
        if (callId) setTimeout(() => this.setPhase(callId, 'connected'), 10);
        return { ok: true, data: { status: 'submitted' } };
      }
      case 'reject':
      case 'hangup': {
        if (callId) setTimeout(() => this.setPhase(callId, 'ended'), 5);
        return { ok: true, data: { status: 'submitted' } };
      }
      case 'audio.write':
        return { ok: true, data: { id: String(args.playbackId ?? ''), callId: callId ?? '', state: 'queued' } };
      default:
        return { ok: true, data: {} };
    }
  }
}
