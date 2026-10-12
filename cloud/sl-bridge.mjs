#!/usr/bin/env node
/**
 * 云侧桥(界面驱动版)—— 替代 koishi-rtc 那条桥。
 *
 * 它对外**复刻**原桥的协议,所以 `cortico-world-phone` 一个字节都不用改:
 *   - 一条 WebSocket,路径 `/v1/stream`,必须带 `Authorization: Bearer <token>`,
 *     **不能有 `Origin`**(有就 403),**同时只允许一个对端**(第二条 403);
 *   - 包封 `{type:'request',id,op,args}` → `{type:'reply',id,ok,data|error}`;
 *   - **同一个 id 只执行一次**,重发同一个 id 返回保留的那份回执(World 断线重试就靠它);
 *   - 推 `hello`(连上即发,带 calls 与 audioFormat)/ `call` / `audio` / `status` / `error`;
 *   - 只接受这 7 个 op:`accept` / `reject` / `hangup` / `dial` / `audio.write` / `audio.clear`
 *     / `screenshot`(`screenshot` 是**这一版桥自己加的**,原桥没有;老桥收到它会回 UNKNOWN_OP,
 *     World 就当"没有截图"照常往下走)。
 *
 * 对内它做的是"看屏幕 + 搬音频":
 *   - 用 `xdotool` 找标题带「语音」的窗口 → 抬窗 → 点接听/挂断那两颗钮(像素坐标);
 *   - 用 `parec` 从 `sl_speaker.monitor` 采他的声音,用 `pacat` 把她的声音播进 `sl_mic`;
 *   - 两边都是 48000/2ch 的 pcm_s16le(见 audioFormat)。
 *
 * 为什么自己写 WebSocket 服务端而不用 `ws`:这一份要扔进容器里跑,而容器里没有 npm。
 * 单一文件 + 只用 Node 内建 ⇒ 部署就是"拷过去 + node 起它",也便于逐行审。
 *
 * ★ 已知缺口(照实写在注释里,别让下一个人以为是 bug):
 *   1. **看不出打电话的人是谁**。来电窗是像素,标题只有「语音通话」;
 *      QQ 把"谁打来的"只画在窗口里、不落进任何我们能读的接口。
 *      所以 `callerUin` 报的是配置里那个"已知的那个人";`acceptUnknown=false` 时,
 *      桥会**拒接一切来电**——因为无从判断是不是他。要放开就把这一项设 true。
 *   2. **`dial`(她主动拨)暂不支持**:界面上拨号要"开会话→点通话→再点语音",是另一套导航,
 *      而且同样认不出对象。所以这一版直接回错误,World 会照实投 `phone.outgoingFailed`。
 *   3. **`audio.clear` 只能尽力**:能立刻掐掉我们这边还没写进 PulseAudio 的音频;
 *      已经进到 QQ 缓冲里的那一点收不回来(那条缓冲不归我们管)。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ───────────────────────────── 配置 ─────────────────────────────

const cfgPath = process.argv[2] ?? process.env.SL_BRIDGE_CONFIG ?? '/opt/sl/bridge.json';
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

const HOST = cfg.host ?? '127.0.0.1';
const PORT = cfg.port ?? 6120;
const PATH = '/v1/stream';
const LOG = (level, msg, extra) => {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  console.log(extra === undefined ? line : `${line} ${JSON.stringify(extra)}`);
};
const log = {
  info: (m, e) => LOG('INFO', m, e),
  warn: (m, e) => LOG('WARN', m, e),
  error: (m, e) => LOG('ERROR', m, e),
};

const token = (() => {
  if (cfg.token) return cfg.token;
  if (cfg.tokenFile) return readFileSync(cfg.tokenFile, 'utf8').trim();
  throw new Error('配置里既没有 token 也没有 tokenFile');
})();

const AUD = {
  rate: cfg.audio?.sampleRate ?? 48000,
  channels: cfg.audio?.channels ?? 2,
  sinkMonitor: cfg.audio?.sinkMonitor ?? 'sl_speaker.monitor',
  micSink: cfg.audio?.micSink ?? 'sl_mic',
  pulseServer: cfg.audio?.pulseServer ?? 'unix:/tmp/runtime-1000/pulse/native',
  frameMs: cfg.audio?.frameMs ?? 100,
};

const GUI = {
  display: cfg.gui?.display ?? ':1',
  windowName: cfg.gui?.windowName ?? '语音',
  // 窗口内相对坐标:接听那颗绿钮 / 通话中那颗红钮 / 响铃时的拒接钮。
  // 本机 Windows 与云上 Linux 量到的尺寸一致(360x640),所以同一套相对坐标两边都能用。
  acceptAt: cfg.gui?.acceptAt ?? [118, 508],
  hangupAt: cfg.gui?.hangupAt ?? [288, 509],
  rejectAt: cfg.gui?.rejectAt ?? [292, 508],
  readyDelayMs: cfg.gui?.readyDelayMs ?? 400,
  pollMs: cfg.gui?.pollMs ?? 1000,
};

const CALL = {
  expectedCallerUin: cfg.call?.expectedCallerUin ?? '',
  acceptUnknown: cfg.call?.acceptUnknown === true,
  ringTimeoutSec: cfg.call?.ringTimeoutSec ?? 60,
};

// ───────────────────── 外部程序(xdotool / parec / pacat)─────────────────────

const ENV = { ...process.env, DISPLAY: GUI.display, PULSE_SERVER: AUD.pulseServer };

/** 跑一条命令,拿走 stdout(短命令用)。 */
function run(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: ENV });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: '', err: String(e?.message ?? e) });
    });
  });
}

/**
 * 找「语音通话」窗,返回 {id, x, y, w, h} 或 null。
 *
 * ★ **别把中文交给 `xdotool --name`**:2026-10-11 在云上这台容器里实测,多字节模式
 * **一个都匹配不上** —— `--name 语`、`--name 语音通话`、`--name $'\\xe8\\xaf\\xad...'` 全是
 * `rc=1`,同一串字节用 `grep` 比就对得上(窗口的名字本身也是好 UTF-8)。xdotool 拿 locale
 * 处理模式,而这个容器只有 C/POSIX。所以这里留快路(多数机器上 `--name` 是好用的),
 * 快路空手就退到"列出所有可见窗 → 逐个把名字拉回来,在 JS 里 `includes`"。
 * ★ 这条要是没修,现象是**整条界面驱动永远看不见来电窗**(桥一直说没窗、World 一直没事件),
 * 而日志里一句错都没有 —— 正是最难查的那种。
 */
async function findCallWindow() {
  const id = await searchByXdotoolName();
  if (!id) return null;
  const g = await run('xdotool', ['getwindowgeometry', '--shell', id]);
  if (g.code !== 0) return null;
  const pick = (k) => {
    const m = new RegExp(`^${k}=(-?\\d+)$`, 'm').exec(g.out);
    return m ? Number(m[1]) : NaN;
  };
  const x = pick('X');
  const y = pick('Y');
  const w = pick('WIDTH');
  const h = pick('HEIGHT');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { id, x, y, w, h };
}

/** 快路:`xdotool search --name`;空手回 null(见 findCallWindow 那段注释)。 */
async function searchByXdotoolName() {
  const fast = await run('xdotool', ['search', '--onlyvisible', '--name', GUI.windowName]);
  if (fast.code === 0 && fast.out) {
    const first = fast.out.split('\n')[0].trim();
    if (/^\d+$/.test(first)) return first;
  }
  const all = await run('xdotool', ['search', '--onlyvisible', '--name', '.']);
  if (all.code !== 0 || !all.out) return null;
  for (const raw of all.out.split('\n')) {
    const winId = raw.trim();
    if (!/^\d+$/.test(winId)) continue;
    const name = await run('xdotool', ['getwindowname', winId]);
    if (name.code === 0 && name.out.includes(GUI.windowName)) return winId;
  }
  return null;
}

/**
 * 点窗口内某个相对位置。
 *
 * ★ 抬窗 + 等一拍再点,这一步不能省 —— 2026-10-11 实测:窗口刚映射就点会**点空**
 * (它还在动/还没拿到焦点)。加 `windowraise` + `windowactivate` + 400ms 才稳定命中。
 */
async function clickInWindow(win, [dx, dy]) {
  const ax = win.x + dx;
  const ay = win.y + dy;
  await run('xdotool', ['windowraise', win.id]);
  await run('xdotool', ['windowactivate', win.id]);
  await sleep(GUI.readyDelayMs);
  await run('xdotool', ['mousemove', String(ax), String(ay), 'click', '1']);
  return { x: ax, y: ay };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 屏幕尺寸:x11grab 抓不到屏幕外的部分,抓图前要拿它把区域裁进来。 */
async function displayGeometry() {
  const s = await run('xdotool', ['getdisplaygeometry']);
  const m = /^(\d+)\s+(\d+)/.exec(s.out);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 800 };
}

/**
 * 抓一张「语音通话」窗的图,回 PNG 的 base64。
 *
 * **给谁用**:World 把这张图挂在来电事件上 —— 她读得出图上的名字,于是"谁打来的"这个
 * 这一版桥看不出来的事(见文件头缺口 1)就由她来看图回答。
 *
 * 为什么用 ffmpeg 而不是 `xwd`:容器里两个都有,但 xwd 吐的是 XWD 格式、还得再转一道 PNG;
 * ffmpeg 一条命令直接出 PNG。代价是每次拉一个新进程(实测连启动约 1.5 秒,响铃那几秒里不碍事)。
 * 抓之前先抬窗 —— 被别的窗口压着的区域拍出来是别人。
 */
async function captureCallWindow(win) {
  await run('xdotool', ['windowraise', win.id]);
  await run('xdotool', ['windowactivate', win.id]);
  await sleep(GUI.readyDelayMs);
  const screen = await displayGeometry();
  const x = Math.max(0, Math.min(win.x, screen.w - 1));
  const y = Math.max(0, Math.min(win.y, screen.h - 1));
  const w = Math.min(win.w, screen.w - x);
  const h = Math.min(win.h, screen.h - y);
  if (!(w > 0) || !(h > 0)) return null;
  const out = `/tmp/sl-shot-${process.pid}.png`;
  const r = await run(
    'ffmpeg',
    [
      '-loglevel', 'error', '-y',
      '-f', 'x11grab', '-draw_mouse', '0',
      '-video_size', `${w}x${h}`,
      '-i', `${GUI.display}+${x},${y}`,
      '-frames:v', '1',
      '-f', 'image2', '-vcodec', 'png',
      out,
    ],
    { timeoutMs: 15000 },
  );
  if (r.code !== 0) {
    log.warn('抓图失败', { code: r.code, err: r.err.slice(0, 200) });
    return null;
  }
  const bytes = readFileSync(out);
  log.info('抓了一张来电窗的图', { w, h, bytes: bytes.length });
  return {
    mime: 'image/png',
    width: w,
    height: h,
    bytes: bytes.length,
    takenAt: Date.now(),
    window: { x, y, w, h },
    pngBase64: bytes.toString('base64'),
  };
}

// ───────────────────────────── 音频 ─────────────────────────────

/**
 * 往麦里写(她的声音)。保持一条 pacat 常驻,省掉每次开进程的抖动。
 * `flush()` 用来尽力实现 audio.clear:掐掉进程 ⇒ 我们这边还没写出去的音频就没了。
 */
class MicWriter {
  constructor() {
    this.child = null;
    this.bytesIn = 0;
  }
  ensure() {
    if (this.child && !this.child.killed) return;
    this.child = spawn(
      'pacat',
      [
        '--playback',
        `--device=${AUD.micSink}`,
        '--format=s16le',
        `--rate=${AUD.rate}`,
        `--channels=${AUD.channels}`,
      ],
      { env: ENV, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.child.on('error', (e) => log.warn('pacat 起不来', { error: String(e?.message ?? e) }));
    this.child.stderr.on('data', (d) => log.warn('pacat stderr', { msg: String(d).trim().slice(0, 200) }));
    this.child.on('close', () => {
      this.child = null;
    });
    log.info('pacat 已起(她说话的出口)');
  }
  write(buf) {
    this.ensure();
    if (!this.child?.stdin?.writable) return false;
    this.bytesIn += buf.length;
    return this.child.stdin.write(buf);
  }
  flush() {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      /* 已经没了就算了 */
    }
    this.child = null;
    log.info('audio.clear:已掐断出口进程', { bytesIn: this.bytesIn });
    this.bytesIn = 0;
  }
  stop() {
    this.child?.stdin?.end();
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
    this.child = null;
  }
}

/** 从 sink 的 monitor 采他的声音。 */
class SpeakerReader {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.child = null;
    this.bytesOut = 0;
  }
  start() {
    if (this.child) return;
    this.child = spawn(
      'parec',
      [
        `--device=${AUD.sinkMonitor}`,
        '--format=s16le',
        `--rate=${AUD.rate}`,
        `--channels=${AUD.channels}`,
      ],
      { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child.on('error', (e) => log.warn('parec 起不来', { error: String(e?.message ?? e) }));
    this.child.stderr.on('data', (d) => log.warn('parec stderr', { msg: String(d).trim().slice(0, 200) }));
    this.child.stdout.on('data', (d) => {
      this.bytesOut += d.length;
      this.onChunk(d);
    });
    this.child.on('close', () => {
      this.child = null;
      log.info('parec 退出', { bytesOut: this.bytesOut });
    });
    log.info('parec 已起(他的声音的入口)');
  }
  stop() {
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
    this.child = null;
    this.bytesOut = 0;
  }
}

// ───────────────────── 最小 WebSocket 服务端(RFC6455 子集)─────────────────────
//
// 只做我们真的要的那几样:握手(带 Bearer 鉴权、拒 Origin、单对端)、
// 文本帧的收发、ping/pong、close。不压、不分片发,但**能收**分片。

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 把一段 payload 包成服务端→客户端的文本帧(不掩码)。 */
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

/** 收流式分帧器:喂字节,吐出完整的消息(仅文本)。 */
function makeFrameParser(onMessage, onControl) {
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let frags = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off);
        if (big > 8_000_000n) {
          onControl('too-big');
          return;
        }
        len = Number(big);
        off += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];

      if (opcode === 0x8) return onControl('close');
      if (opcode === 0x9) return onControl('ping', payload);
      if (opcode === 0xa) continue; // pong:不理
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) fragOp = opcode;
        frags.push(payload);
        if (fin) {
          const whole = Buffer.concat(frags);
          frags = [];
          const op = fragOp;
          fragOp = 0;
          if (op === 0x1) onMessage(whole.toString('utf8'));
          // 二进制帧我们不用,直接丢
        }
      }
    }
  };
}

// ───────────────────────────── 通话状态机 ─────────────────────────────

const TERMINAL = new Set(['ended', 'error', 'failed']);

class Call {
  constructor({ id, direction, phase, callerUin }) {
    this.id = id;
    this.kind = 'direct';
    this.direction = direction;
    this.phase = phase;
    this.callerUin = callerUin;
    this.peerUin = callerUin;
    this.inviteAt = Date.now();
    this.endedAt = undefined;
    this.media = 'audio';
    this.acceptReady = phase === 'ringing';
    this.nativeEndEvent = undefined;
    this.winId = null;
  }
  toWire() {
    // 字段名按 World 的 `normalizeCall` 认的那一套给(`phase` / `callerUin` / `inviteAt` …)。
    return {
      id: this.id,
      kind: this.kind,
      direction: this.direction,
      phase: this.phase,
      callerUin: this.callerUin,
      peerUin: this.peerUin,
      inviteAt: this.inviteAt,
      endedAt: this.endedAt,
      acceptReady: this.acceptReady,
      media: this.media,
      muted: false,
      nativeEndEvent: this.nativeEndEvent,
    };
  }
}

let seq = 0;
const nextCallId = () => `sl-${Date.now().toString(36)}-${(seq += 1)}`;

// ───────────────────────────── 桥本体 ─────────────────────────────

class Bridge {
  constructor() {
    /** 当前这通(只支持一通;第二条窗口出现时按新的一通处理)。 */
    this.call = null;
    this.peer = null; // 唯一的那个 WebSocket 对端
    this.replies = new Map(); // id → 已发出的回执(同 id 幂等)
    this.mic = new MicWriter();
    this.reader = new SpeakerReader((chunk) => this.onMicChunk(chunk));
    this.audioSeq = 0;
    this.pendingAudio = Buffer.alloc(0);
    this.timer = null;
    this.stopping = false;
  }

  // ---- 对外推 ----

  send(packet) {
    const p = this.peer;
    if (!p || p.socket.destroyed) return;
    try {
      p.socket.write(encodeTextFrame(JSON.stringify(packet)));
    } catch (e) {
      log.warn('发不出去', { error: String(e?.message ?? e) });
    }
  }

  status() {
    return {
      account: { selfId: '', platform: 'qq' },
      audioFormat: { sampleRate: AUD.rate, channels: AUD.channels, encoding: 'pcm_s16le' },
      capabilities: {
        accept: { supported: true },
        reject: { supported: true },
        hangup: { supported: true },
        dial: { supported: false, reason: '界面驱动版暂不支持主动拨号' },
        sendAudio: { supported: true },
        receiveAudio: { supported: true },
        // 这一版桥自己加的(原桥没有):把来电窗抓成 PNG,让模型自己看是谁打来的。
        screenshot: { supported: true },
      },
      calls: this.call ? [this.call.toWire()] : [],
      diagnostics: [],
    };
  }

  hello() {
    this.send({ type: 'hello', ...this.status() });
  }

  pushStatus() {
    this.send({ type: 'status', ...this.status() });
  }

  pushCall(call) {
    this.send({ type: 'call', call: call.toWire() });
  }

  /**
   * 从 monitor 采到的字节切成一帧帧推出去。
   * 帧长 `frameMs` × 48000 × 2ch × 2B;World 那一侧会把它们喂给 VAD。
   */
  onMicChunk(chunk) {
    if (!this.call || this.call.phase !== 'connected') return;
    this.pendingAudio = Buffer.concat([this.pendingAudio, chunk]);
    const frameBytes = Math.floor((AUD.rate * AUD.frameMs) / 1000) * AUD.channels * 2;
    while (this.pendingAudio.length >= frameBytes) {
      const slice = this.pendingAudio.subarray(0, frameBytes);
      this.pendingAudio = this.pendingAudio.subarray(frameBytes);
      this.audioSeq += 1;
      this.send({
        type: 'audio',
        frame: {
          callId: this.call.id,
          encoding: 'pcm_s16le',
          sampleRate: AUD.rate,
          channels: AUD.channels,
          sequence: this.audioSeq,
          timestamp: Date.now(),
          data: Buffer.from(slice).toString('base64'),
        },
      });
    }
  }

  // ---- 命令 ----

  async handle(op, args) {
    switch (op) {
      case 'accept': {
        if (!this.call || this.call.id !== args?.callId) this.fail('STALE_CALL', '没有这通电话');
        if (this.call.phase !== 'ringing') this.fail('WRONG_PHASE', `现在是 ${this.call.phase}`);
        const win = await findCallWindow();
        if (!win) this.fail('NO_WINDOW', '来电窗口已经不在了');
        const at = await clickInWindow(win, GUI.acceptAt);
        log.info('点了接听', { callId: this.call.id, at });
        this.call.phase = 'connected';
        this.call.acceptReady = false;
        this.pushCall(this.call);
        // 音频两条管道一起开
        this.reader.start();
        this.mic.ensure();
        return { at };
      }
      case 'reject': {
        if (!this.call || this.call.id !== args?.callId) this.fail('STALE_CALL', '没有这通电话');
        if (this.call.phase !== 'ringing') this.fail('WRONG_PHASE', `现在是 ${this.call.phase}`);
        const win = await findCallWindow();
        if (win) {
          const at = await clickInWindow(win, GUI.rejectAt);
          log.info('点了拒接', { callId: this.call.id, at });
        }
        this.end('rejected', 'local-reject');
        return { ok: true };
      }
      case 'hangup': {
        if (!this.call || this.call.id !== args?.callId) this.fail('STALE_CALL', '没有这通电话');
        if (TERMINAL.has(this.call.phase)) this.fail('WRONG_PHASE', '这通已经结束了');
        const win = await findCallWindow();
        if (!win) {
          // 窗口没了 = 对方已经挂了(或界面自己收了),照实收尾而不是报错。
          log.warn('挂断时窗口已不在,按对方已挂处理', { callId: this.call.id });
          this.end('ended', 'window-gone');
          return { ok: true, note: '窗口已不在' };
        }
        const at = await clickInWindow(win, GUI.hangupAt);
        log.info('点了挂断', { callId: this.call.id, at });
        await sleep(1200);
        if (!(await findCallWindow())) this.end('ended', 'local-hangup');
        else log.warn('挂断后窗口还在,等下一轮轮询收尾');
        return { at };
      }
      case 'dial':
        this.fail('UNSUPPORTED', '界面驱动版暂不支持主动拨号(见文件头"已知缺口")');
        return null;
      case 'screenshot': {
        // 只要求"窗在",不要求"已接通":她需要在**响铃那几秒里**就看图决定接不接。
        const win = await findCallWindow();
        if (!win) this.fail('NO_WINDOW', '屏幕上没有「语音通话」窗,没什么可抓的');
        const shot = await captureCallWindow(win);
        if (!shot) this.fail('CAPTURE_FAILED', '图没抓出来(原因在桥的日志里)');
        return shot;
      }
      case 'audio.write': {
        if (!this.call || this.call.id !== args?.callId) this.fail('STALE_CALL', '没有这通电话');
        if (this.call.phase !== 'connected') this.fail('WRONG_PHASE', `现在是 ${this.call.phase}`);
        const frame = args?.frame;
        if (!frame || frame.encoding !== 'pcm_s16le') this.fail('BAD_FRAME', '音频帧形状不对');
        if (frame.sampleRate !== AUD.rate || frame.channels !== AUD.channels) {
          this.fail('BAD_FORMAT', `要求 ${AUD.rate}/${AUD.channels},收到 ${frame.sampleRate}/${frame.channels}`);
        }
        const buf = Buffer.from(frame.data ?? '', 'base64');
        if (buf.length % (2 * AUD.channels) !== 0) this.fail('BAD_FRAME', '字节数不是整帧的整数倍');
        const ok = this.mic.write(buf);
        if (!ok) this.fail('AUDIO_BACKPRESSURE', '出口写不进去了');
        return { accepted: buf.length, playbackId: args?.playbackId ?? '' };
      }
      case 'audio.clear': {
        if (!this.call || this.call.id !== args?.callId) this.fail('STALE_CALL', '没有这通电话');
        this.mic.flush();
        this.mic.ensure();
        return { cleared: true };
      }
      default:
        this.fail('UNKNOWN_OP', `不认这个 op:${op}`);
        return null;
    }
  }

  /** 抛给上层的失败(会被包成 ok:false 的回执)。 */
  fail(code, message) {
    const e = new Error(message);
    e.bridgeCode = code;
    throw e;
  }

  end(phase, reason) {
    if (!this.call) return;
    this.call.phase = phase;
    this.call.nativeEndEvent = reason;
    this.call.endedAt = Date.now();
    this.pushCall(this.call);
    this.reader.stop();
    this.mic.stop();
    log.info('这一通结束', { callId: this.call.id, phase, reason });
    this.call = null;
    this.pendingAudio = Buffer.alloc(0);
    this.pushStatus();
  }

  // ---- 盯屏轮询 ----

  async tick() {
    const win = await findCallWindow();
    if (!this.call && win) {
      // 新来电:只认"响铃窗"。是不是他打的?—— 看不出来,见文件头缺口 1。
      const caller = CALL.expectedCallerUin || 'unknown';
      if (!CALL.acceptUnknown && !CALL.expectedCallerUin) {
        log.warn('有来电,但没有配 expectedCallerUin 且不接受陌生人 ⇒ 不接', { winId: win.id });
        return;
      }
      this.call = new Call({ id: nextCallId(), direction: 'incoming', phase: 'ringing', callerUin: caller });
      this.call.winId = win.id;
      log.info('★ 来电窗口出现', { id: this.call.id, win: win.id, geom: `${win.x},${win.y} ${win.w}x${win.h}` });
      this.pushCall(this.call);
      this.pushStatus();
      return;
    }
    if (!this.call) return;

    // 响铃超时
    if (this.call.phase === 'ringing' && Date.now() - this.call.inviteAt > CALL.ringTimeoutSec * 1000) {
      log.info('响铃超时,收尾');
      this.end('ended', 'ring-timeout');
      return;
    }
    // 窗口没了 = 结束了(对方挂断、界面自己收)
    if (!win) {
      log.info('窗口消失,收尾');
      this.end('ended', 'window-gone');
      return;
    }
    // 通话中窗口还在:更新几何(窗口可能被挪动过)
    this.call.winId = win.id;
  }

  start() {
    const self = this;
    this.timer = setInterval(() => {
      self.tick().catch((e) => log.error('轮询出错', { error: String(e?.message ?? e) }));
    }, GUI.pollMs);
    log.info('盯屏轮询已起', { every: `${GUI.pollMs}ms`, window: GUI.windowName });
  }

  stop() {
    clearInterval(this.timer);
    this.reader.stop();
    this.mic.stop();
  }
}

// ───────────────────────────── HTTP + WS 入口 ─────────────────────────────

const bridge = new Bridge();

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, call: bridge.call?.phase ?? null }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, socket) => {
  const reject = (code, why) => {
    log.warn('拒了一条连接', { why });
    socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== PATH) return reject(404, 'Not Found');
  if (req.headers.origin) return reject(403, 'Forbidden (Origin)'); // 和上游一样:不许带 Origin
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) return reject(401, 'Unauthorized');
  // 同时只允许一个对端。★ 这里要连"已经死掉但还没触发 close 的"也算作没有对端 ——
  // 2026-10-11 本地自检抓到过:上一条连接只发了 FIN(没发 WS close 帧),
  // `close` 迟迟不来,`bridge.peer` 就一直占位,把后来的对端全挡在 403 外面。
  const stale = bridge.peer && (bridge.peer.socket.destroyed || bridge.peer.socket.readableEnded);
  if (stale) {
    log.warn('上一个对端已经死了但没触发 close,这里直接清掉');
    bridge.peer = null;
  }
  if (bridge.peer) return reject(403, 'Forbidden (busy)');
  const key = req.headers['sec-websocket-key'];
  if (!key) return reject(400, 'Bad Request');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(String(key))}\r\n\r\n`,
  );

  const peer = { socket };
  bridge.peer = peer;
  log.info('对端连上了');

  const parser = makeFrameParser(
    (text) => {
      let packet;
      try {
        packet = JSON.parse(text);
      } catch {
        return;
      }
      if (packet?.type !== 'request') return;
      const id = typeof packet.id === 'string' ? packet.id : '';
      const op = typeof packet.op === 'string' ? packet.op : '';
      // ★ 同 id 幂等:回执留一份,重发同一个 id 直接把它再回一遍,命令**不重复执行**。
      if (id && bridge.replies.has(id)) {
        log.info('同一个 id 又来了,回保留的那份', { id, op });
        socket.write(encodeTextFrame(JSON.stringify(bridge.replies.get(id))));
        return;
      }
      (async () => {
        let reply;
        try {
          const data = await bridge.handle(op, packet.args ?? {});
          reply = { type: 'reply', id, ok: true, data };
        } catch (e) {
          reply = {
            type: 'reply',
            id,
            ok: false,
            error: { code: e?.bridgeCode ?? 'INTERNAL', message: String(e?.message ?? e) },
          };
        }
        if (id) {
          bridge.replies.set(id, reply);
          if (bridge.replies.size > 500) {
            const first = bridge.replies.keys().next().value;
            bridge.replies.delete(first);
          }
        }
        if (!socket.destroyed) socket.write(encodeTextFrame(JSON.stringify(reply)));
      })();
    },
    (kind, payload) => {
      if (kind === 'ping' && !socket.destroyed) {
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length & 0x7f]), payload]);
        socket.write(pong);
        return;
      }
      if (kind === 'close' || kind === 'too-big') {
        if (bridge.peer === peer) bridge.peer = null;
        socket.destroy();
        log.info('对端断开了', { kind });
      }
    },
  );

  socket.on('data', (d) => parser(d));
  socket.on('end', () => {
    // 对端半关(只发 FIN、不发 WS close 帧):也要把位子让出来。
    if (bridge.peer === peer) bridge.peer = null;
    log.info('对端半关了(end)');
  });
  socket.on('error', () => {
    if (bridge.peer === peer) bridge.peer = null;
  });
  socket.on('close', () => {
    if (bridge.peer === peer) bridge.peer = null;
    log.info('对端的 socket 关了');
  });

  bridge.hello();
});

bridge.start();
server.listen(PORT, HOST, () => {
  log.info(`桥在听 ws://${HOST}:${PORT}${PATH}`, { tokenLen: token.length });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`收到 ${sig},收工`);
    bridge.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
