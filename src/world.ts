/**
 * 电话这个 World:把"话机"接上她的耳朵和嘴。
 *
 * 一句话的形状:桥推来的音频 → 切句 → 认字 → 当事件给她;她的输出增量 → 切句 → 合成 → 发回桥。
 *
 * 三条贯穿整份代码的纪律:
 *
 * 1. **桥是权威,这里只有镜像。** 通话在不在、什么状态,一律以上游那份为准(它的 `phase`)。
 *    我们从不"想当然地"以为接上了 —— 回执 `submitted` 只表示命令提交给了 AVSDK,
 *    真正接通要看 `phase` 变成 `connected`。
 * 2. **采样率与声道的换算只调 `pcm.ts`。** 这一层里不许出现 `/ 48000` 这种算式。
 * 3. **失败要说出来,不要静默。** 合成失败、识别不下来、桥断了 —— 都变成事件或回执里的一句话。
 *    电话这种"对面在等"的场景里,静默失败比报错难查得多。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { spawn } from 'node:child_process';
import type WebSocket from 'ws';
import type {
  BlobInput,
  OutputTap,
  ToolDef,
  ToolOutcome,
  World,
  WorldConsoleDecl,
  WorldHost,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { PHONE_CONFIG_GROUP, callerAllowed, dialTarget, type PhoneConfigSection } from './config.ts';
import { BridgeClient, screenshotBlob, type BridgeAudioFrame, type BridgeCall, type BridgeStatus, isTerminal, normalizeCall } from './bridge.ts';
import {
  callerOf,
  isTransientPhase,
  currentCall,
  decideOnRing,
  describeConnected,
  describeEnded,
  describeLive,
  describeRinging,
  ringTimedOut,
  stuckFor,
  type CallPolicy,
  type TranscriptLine,
} from './call.ts';
import { Segmenter, frameDb, hasWords, looksLikeWrongLanguage, transcribe } from './ear.ts';
import { downmixToMono, durationMs, pcmToWav, resampleMono, StreamingPcmFramer, toChannels } from './pcm.ts';
import { flushSentence, speechKey, takeSentences, worthSpeaking } from './sentences.ts';
import { SshTunnel } from './ssh.ts';
import { synthesizePcm } from './tts.ts';
import { PlaybackLedger, type Utterance } from './playback.ts';
import { clock, describe, humanSeconds, sleep, type VoiceLoggerLike } from './util.ts';

/** 桥那一头要求的音频格式(与 bridge.json 的 audio 段一致)。连上后由它报的 status 核对。 */
const BRIDGE_RATE = 48000;
const BRIDGE_CHANNELS = 2;
/** 耳朵(识别)那一头要的格式。 */
const EAR_RATE = 16000;
/** 看护那一拍的间隔。 */
const WATCH_MS = 1000;
/**
 * 响铃时身份还没报准,等多久再判。
 *
 * 从实测记录里量的:那条只带 uid 的更新之后,**真号大约 5 秒**才补上(2026-10-09 18:16 那条:
 * 18:16:57 判成陌生号,18:17:02 才认出号码),所以 3 秒等不到。
 */
const RING_GRACE_MS = 6000;

/** 写入领先量的保守上限；桥的队列容量为 2 秒，不能在静默时积攒额度。 */
const PACE_LEAD_MS = 500;

/**
 * 一段音频长到这个时长、却一个字都没认出来,就**当成"没听清"告诉她**(而不是静默丢掉)。
 *
 * 定这个数的依据:脉冲噪声那类假起音都不到 400 毫秒(见 `bargeInMinMs`),而实测里
 * "没认出来"的那些段是 1.9~4.5 秒。1.5 秒开在中间 —— 短于它当噪声丢掉,长于它就得让她知道。
 */
const UNHEARD_MIN_MS = 1500;
/** 卡住多久才值得惊动她(几帧的抖动不算)。 */
const STALL_NOTICE_MS = 3000;
/** 同一件事别连着说:两次"没听清"至少隔这么久(毫秒)。 */
const UNHEARD_REPEAT_MS = 8000;
/**
 * 连着这么多段"长到像一句话却一个字都没认出来",就认定**这一通他几乎没被听见**,
 * 跟她明说一次(一通只说一次)。
 *
 * 为什么要有这一条:2026-10-09 他那一通里,他说的几乎全没被转写(整通只认出 1 句),
 * 而**她那一侧什么都不知道** —— 她只看到"他没说话",于是安静地等着。真相是"声音在网上碎了"。
 * 三种成因(他真没说 / 网上碎了 / 门限太高)在她看来长得一模一样,所以必须有人把这一层说出来。
 * 取 3 是因为单次没认出来可能是噪声或口误,连着 3 段就一定不是了。
 */
const DEAF_STREAK = 3;
/** 记录里"没听清"那一行的写法。 */
const unheardLine = (ms: number): string => `(这一句没听清,${(ms / 1000).toFixed(1)} 秒)`;

/**
 * 挂断第一次没成功之后等多久再试(毫秒)。
 *
 * 取 2.5 秒是因为上游那个监督脚本自己就 `sleep 2` 再拉宿主,加起进程要几秒 ——
 * 等太短(1 秒)等于撞在同一个窗口里,等太长她会以为工具卡住了。
 */
const HANGUP_RETRY_DELAY_MS = 2500;

/** 回执里那句"为什么没成":上游的原话 + 它给的码。**码先看** —— 2026-10-10 那次就是靠它认出来的。 */
function whyFailed(reply: { error?: { code?: string; message?: string } }): string {
  const message = reply.error?.message ?? '桥没给原因';
  const code = reply.error?.code;
  return code ? `${message}(${code})` : message;
}

/**
 * 桥这么回，其实是"这一条我已经拿着了"。
 *
 * 上游对同一个 id 有两句挡回来的话:`REQUEST_ID_REUSED`(同一个 id 换了参数)和播放队列那句
 * `Playback ID … unique while pending`(同一块还排在队里)。我们重问时参数一字不改,
 * 所以撞上这两条只可能是**它已经收下了这一块** —— 当成失败反而会把已经念出去的话记成丢了。
 */
function alreadyHasBlock(reply: { error?: { code?: string; message?: string } }): boolean {
  return reply.error?.code === 'REQUEST_ID_REUSED' || /unique while pending/i.test(reply.error?.message ?? '');
}

/**
 * `audio.write` 的**请求 id**:短、且同一块恒定。
 *
 * 两个约束叠起来才有这个形状:
 * ① 上游 `request.id` 上限 **80 字符**(`daemon.mjs:511`,超了回 `INVALID_REQUEST`);
 * ② 重问必须用**同一个 id**(上游按 id 记住在办的那一条,复用 id 才算安全重问)。
 * 真实部署的通话 id 是 75 字符的 `<linkEpoch>:<n>:<nativeId>`,拼进去必超 ⇒ 用它的短哈希 + 序号。
 */
function audioRequestId(callId: string, sequence: number): string {
  return `aw-${sequence}-${createHash('sha1').update(callId).digest('hex').slice(0, 8)}`;
}

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export interface PhoneWorldOptions {
  cfg: PhoneConfigSection;
  timezone: string;
  dataDir: string;
  /** `ctx.secret`：桥的令牌、MiniMax 的 key 都从这儿取(值住部署 .env)。 */
  secret: (name: string) => string;
  log?: VoiceLoggerLike;
  /** 测试注入;生产都用默认。 */
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

/** 一块待发出的音频。`sequence` 在切片时就定好，保证与入队顺序一致。 */
interface AudioChunk {
  utterance: Utterance;
  pcm: Buffer;
  sequence: number;
  /** 入队时刻：测到写入回执的等待，不冒充听到的时间。 */
  atMs: number;
}

/**
 * 输出增量里我们看得懂的那几个字段。
 *
 * 不 import 框架的 `StreamEvent`:它是整个 Responses 流事件的大联合,而我们只关心
 * "新一轮开始 / 正文增量 / 正文结束"三件事。自己声明一个小形状,与 pet 包同一个做法 ——
 * 以后上游加协议事件时,这里不会被它的类型变动拖着走。
 */
interface PhoneStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
}

export class PhoneWorld implements World {
  readonly id = 'phone';

  private readonly opts: PhoneWorldOptions;
  /**
   * 日志口。**构造函数里先拿注入的,`start()` 一进来就换成宿主的那个。**
   *
   * 为什么必须换:`WorldDefinition.create(ctx)` 拿不到 logger(`WorldContext` 里没有 log),
   * 而 `start(host)` 里的 `host.log` 才是框架的日志。2026-10-09 实测:因为一直用的是
   * 空日志,隧道起不来时**一声不响**(Windows 自带 ssh 拒了私钥权限那件事查了半天),
   * 所以这一条不是装饰。
   */
  private log: VoiceLoggerLike;
  private readonly now: () => number;

  private host?: WorldHost;
  private bridge?: BridgeClient;
  private tunnel?: SshTunnel;
  private segmenter?: Segmenter;
  private started = false;

  /** 当前这通(镜像)。 */
  private current?: BridgeCall;
  /** 这通上次处理过的 phase，用来只在**变化**时动作。 */
  private lastPhase = '';
  private heard = 0;
  private spoke = 0;
  private callStartedMs = 0;
  /** 进入"过渡状态"的时刻(卡住判定用);非过渡状态时是 0。 */
  private transientSince = 0;
  private stuckHandled = false;
  private ringRejected = false;
  /**
   * 这一通**跟她说过了吗**。
   *
   * 只有说过才在收尾时投 `phone.ended`。不然每个陌生号打来、被我们直接拒掉的那一通，
   * 都会在她上下文里留一句"通话结束:999999,历时 0 秒,你说了 0 段" ——
   * 一条她从未知道发生过的通话的总结,纯噪声。
   */
  private announced = false;

  private watchTimer?: NodeJS.Timeout;
  private bridgeOnline = false;
  /** 桥上一次报的状态说明；给工具回执用。 */
  private bridgeNote = '还没连上桥。';

  /** 耳朵。 */
  private transcribing = 0;

  /** 嘴:待合成的句子与待发出的音频。 */
  private speakBuffer = '';
  private speakQueue: Utterance[] = [];
  private audioQueue: AudioChunk[] = [];
  private sequence = 0;
  private synthBusy = false;
  private writerBusy = false;
  private speechAbort = new AbortController();
  private clearPending?: Promise<void>;
  /**
   * 桥没确认收到的音频块数(2026-10-15 改)。
   *
   * 这里原来是 `outputBlocked`:一块音频没拿到回执就把**整通电话封住** —— 后续不再合成、
   * 不再发送,`phone_say` 也直接拒绝。2026-10-15 那通第一块就撞上桥不回执,于是整通一个字
   * 没出去。用户定的规矩是「宁可晚、一个字都不丢」,而"没回执"本身说明不了没念
   * (桥自己那段注释也写着这句);拿它来封住整通,代价远大于晚几秒。
   * 现在:按原 id 多问几次,还问不到就**记下来、说清楚、继续往下说**。
   */
  private unconfirmedBlocks = 0;
  /** 这一通里"接起后第一句之前垫静音"做过没有(2026-10-15)。接起时复位。 */
  private warmupSent = false;
  /** 这一通里"有音频没被确认"这件事只当面说一次,别把她的上下文刷满。 */
  private unconfirmedNoted = false;
  private qqDiagnostic = '';
  private playback = new PlaybackLedger();
  /** 换代:抢话或通话结束时 +1，正在跑的合成/发送据此自己停下。 */
  private speakGeneration = 0;
  private plannedSpeechMs = 0;
  private roundCapNoted = false;
  private preemptArmed = false;
  /**
   * "他开口了、而她当时正在说"的起音时刻是不是她正忙的时候(候选抢话)。
   * 响够 `bargeInMinMs` 才真动手 —— 见 config 里 `bargeInMinMs` 那条注释。
   */
  private bargeOnsetHerActive = false;
  /** 这一段起音以来,他的声音连着响了多久(毫秒,只算过门限的音频)。 */
  private bargeRunMs = 0;
  /** 上一块音频过没过门限(判"新的起音")。 */
  private bargeLoud = false;
  /** 上一次"这一句没听清"是什么时候(同一件事别连着说)。 */
  private lastUnheardAt = 0;
  /** 连着多少段"像一句话却没认出来"(认出来了就归零)。见 `DEAF_STREAK`。 */
  private unheardStreak = 0;
  /** 这一通已经因为"几乎听不见他"说过一次了(一通只说一次)。 */
  private deafNoticed = false;
  /**
   * 这一通的逐句记录:他说的(认出来的正文)与她提交的句子及播放状态,按发生先后排。
   * 收尾时整块附在 `phone.ended` 后面给她 —— 记不记进她的记忆由她自己决定,这一包不替她写。
   */
  private transcript: TranscriptLine[] = [];
  /** 桥那条播放队列从什么时候开始一直满(0 = 没卡)。用它决定"还等还是认栽"。 */
  private stalledSinceMs = 0;
  /** 这一通已经因为"卡住"提醒过她了(一通只说一次)。 */
  private stallNoticed = false;
  /** 音频块从本地入队到写入回执的等待峰值(毫秒)，不含声学播放确认。 */
  private maxLagMs = 0;
  /** 这一通取得成功写入回执的音频毫秒数；不代表实际播放时长。 */
  private wroteAudioMs = 0;
  /** 按成功提交量估算的队尾播放时刻；不作为播放凭据。 */
  private paceEndMs = 0;
  /**
   * 她自己按了停(`phone_stop`):这一轮剩下的正文不再念。
   * 下一轮(`response.created`)自己解开 —— 她要接着说话，随时可以说。
   */
  private roundMuted = false;
  /**
   * **这一轮**里已经交出去的句子(正文那条路与 `phone_say` 都记在这儿)。
   *
   * 为什么要有它:她出声有两条路(直接写正文 / 调 `phone_say`),两条都通,所以完全可能
   * 把同一句既写进正文又塞进工具参数 —— 不去重,他那边就听两遍。
   * 粒度是**一轮**:下一轮她再说同一句是她的本意,照念。
   */
  private saidThisRound = new Set<string>();

  private bridgeRate = BRIDGE_RATE;
  private bridgeChannels = BRIDGE_CHANNELS;

  constructor(opts: PhoneWorldOptions) {
    this.opts = opts;
    this.log = opts.log ?? {};
    this.now = opts.now ?? (() => Date.now());
  }

  // ───────────────────────── 契约:前缀与工具 ─────────────────────────

  /** 环境提示词里那两个占位符的当前值。**不许做 I/O**:前缀重建时会被调。 */
  envPromptVars(): Record<string, string> {
    const callers = this.opts.cfg.callers.map((c) => String(c)).join('、') || '(还没配)';
    const bridge = this.bridgeOnline ? '' : this.bridgeNote;
    const dial = dialTarget(this.opts.cfg);
    return {
      'phone.callers': callers,
      'phone.state': describeLive(this.current, this.now(), bridge),
      // 拨号目标没配就说没配 —— 空着会让提示词读成"她随时能拨",而实际拨不出去。
      'phone.dialTo': dial.target === '' ? '(这一路没配拨号目标)' : dial.label,
      // 打断这件事两套行为完全不一样,提示词里照实说,免得她自己猜(见 bargeIn / phone_stop)。
      'phone.interrupt': this.opts.cfg.bargeIn
        ? '他一开口，你正在念的那半句会当场停下——这是设计好的，不用觉得被打断就该道歉或重来。'
        : '他不会打断你，你可以把话说完。他要你停时会喊停（"停""停停停"），那时你调 phone_stop 自己停下。',
    };
  }

  tools(): ToolDef[] {
    return [this.sayTool(), this.answerTool(), this.dialTool(), this.hangupTool(), this.statusTool(), this.stopTool()];
  }

  /**
   * 通话开始/结束时通知外面一声。
   *
   * 谁需要它:**Persona**。理由与电话本身无关 —— 通话里一轮 20~38 秒没法用,
   * 而"关掉思考"这件事住在 provider 的 `spec` 里(全局一个 `activeProvider`),
   * **World 够不着**(`ctx.cfg` 只有 `worlds.<id>` 这一段,见 `world.ts` 的 `context()`),
   * 所以只能由拿着整份配置的 Persona 去切。
   *
   * 做成"回调注册"而不是让 World 去写配置:World 只报告**发生了什么**,
   * 拿配置做什么由 Persona 决定 —— 边界不被这一包捅破。
   * 不实现它的宿主(比如旧版本的 bot)什么都不会发生,电话照常工作。
   */
  onCallStateChange(callback: (active: boolean) => void): void {
    this.callStateListeners.push(callback);
  }

  private readonly callStateListeners: Array<(active: boolean) => void> = [];

  private notifyCallState(active: boolean): void {
    for (const listener of this.callStateListeners) {
      try {
        listener(active);
      } catch (error) {
        this.log.warn?.('通话状态通知里出错(不影响通话本身)', { error: describe(error) });
      }
    }
  }

  console(): WorldConsoleDecl {
    return {
      config: [PHONE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.phone.envPrompt',
          title: '电话 · 环境提示词',
          description: '打电话那一段进 system 前缀的说明;留空则这个 World 不进入前缀(工具照旧在)。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'phone.callers', description: '接听名单里的号,此刻的值。' },
            { name: 'phone.state', description: '这一通电话的实况:有没有通话、对方是谁、已经多久。' },
            { name: 'phone.dialTo', description: '她能主动拨给谁(拨号目标);没配时写着没配。' },
            { name: 'phone.interrupt', description: '打断这件事此刻是哪种行为(他一开口就打断 / 他要你停时喊停)。' },
          ],
        },
      ],
    };
  }

  // ───────────────────────── 契约:生命周期 ─────────────────────────

  /** 挂载时接收宿主并开始连接平台、推送事件。 */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 框架的日志从这里才拿得到(见 `log` 字段那段注释),先换上再往下做任何事。
    if (host.log) this.log = host.log;
    this.started = true;

    const ssh = this.opts.cfg.ssh;
    if (ssh.enabled && ssh.host.trim() !== '') {
      this.tunnel = new SshTunnel({
        exePath: ssh.exePath || 'ssh',
        host: ssh.host.trim(),
        user: ssh.user || 'root',
        // 端口这类数字字段在部署配置里可能缺项或写成空,落到默认值,**别拼出 `-p null`**。
        port: Number(ssh.port) || 22,
        keyFile: ssh.keyFile ?? '',
        localPort: Number(ssh.localPort) || 6120,
        remotePort: Number(ssh.remotePort) || 6120,
        // 空/缺这一格时按 `127.0.0.1` 走(旧配置里根本没有这一项)。
        remoteHost: (ssh.remoteHost ?? '').trim() || '127.0.0.1',
        log: this.log,
        spawnImpl: this.opts.spawnImpl,
        onProblem: (text) => void this.reportTunnelProblem(text),
      });
      this.tunnel.start();
    }

    const token = this.readToken();
    if (token === '') {
      this.bridgeNote = `没拿到桥的令牌:在部署 .env 里配 ${this.opts.cfg.tokenSecret}(或给 worlds.phone.tokenFile 指一个文件)。`;
      await this.note(`没有桥的令牌，电话这一路连着也没用:${this.bridgeNote}`);
      return;
    }

    this.bridge = new BridgeClient({
      url: this.opts.cfg.bridgeUrl,
      token,
      reconnectBaseMs: this.opts.cfg.reconnectBaseMs,
      reconnectMaxMs: this.opts.cfg.reconnectMaxMs,
      WebSocketImpl: this.opts.WebSocketImpl,
      log: this.log,
      handlers: {
        onOpen: () => {
          // 只在**状态变化**时说一句(桥断线会反复重连,每次都报会把她的上下文填满)。
          const wasOffline = !this.bridgeOnline;
          this.bridgeOnline = true;
          this.bridgeNote = '';
          if (wasOffline) void this.note('桥连上了。');
        },
        onClose: () => {
          const wasOnline = this.bridgeOnline;
          this.bridgeOnline = false;
          this.bridgeNote = '桥的连接断了，正在重连。';
          if (wasOnline) void this.note('桥的连接断了(正在重连)。');
        },
        onCall: (call) => {
          void this.onCall(call).catch((error) => this.log.warn?.('处理通话变化出错', { error: describe(error) }));
        },
        onAudio: (frame) => this.onAudioFrame(frame),
        onPlayback: (receipt) => this.playback.receipt(receipt),
        onStatus: (status, kind) => this.onStatus(status, kind),
        onError: (message) => {
          void this.note(`桥报了一个错:${message}`);
        },
      },
    });
    this.bridge.start();

    // 名单是空的就说出来:那样**谁都打不进来**(空名单不等于"谁都接"),而这正是
    // 最容易悄悄配错的**那一格** —— 电话不响的原因有七八种,先把这一种排掉。
    const callers = this.opts.cfg.callers ?? [];
    await this.note(
      callers.length === 0
        ? '电话已就绪,但接听名单是空的,现在谁都打不进来:在部署 config.json 的 worlds.phone.callers 里填上允许打进来的号(表单里没有这一格)。'
        : `电话已就绪:桥一连上就会接这几个号打来的来电(${callers.map((c) => String(c)).join('、')})。`,
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopWatch();
    this.finishCall('world 停了');
    this.bridge?.stop();
    this.bridge = undefined;
    this.tunnel?.stop();
    this.tunnel = undefined;
  }

  /**
   * 她这一轮的输出往哪儿去。
   *
   * **刻意不实现 `externalizes`**:那个方法返回 true 会让主循环在这一轮里不再允许抢占,
   * 而电话里"对方一开口就把她打断"正是靠抢占实现的。这里要的恰恰相反。
   */
  outputTap(): OutputTap | undefined {
    if (!this.started) return undefined;
    return {
      onEvent: (event) => this.onStreamEvent(event),
      onRoundEnd: () => this.finishRound(),
      onAbort: () => this.finishRound(),
    };
  }

  /** 上下文交接只补当前通话的短快照，不另开人格、不自动写记忆。 */
  onHandoffEnded(): void {
    if (!this.onCallNow()) return;
    const recent = this.transcript.slice(-8).map(line =>
      `${line.who === 'him' ? '他' : '她'}${line.playback ? `（${line.playback}）` : ''}：${line.text}`,
    ).join('\n').slice(-1200);
    void this.emit('phone.context', `【电话】上下文已交接，当前通话仍在。${this.playback.summary()}。\n最近记录（可能省略更早内容）：\n${recent}`, 'flush', 'phone');
  }

  // ───────────────────────── 桥推来的东西 ─────────────────────────

  private async onCall(call: BridgeCall): Promise<void> {
    const previous = this.current;
    const isNew = !previous || previous.id !== call.id;
    const previousPhase = isNew ? '' : this.lastPhase;

    if (isNew) {
      if (previous && !isTerminal(previous.phase)) this.finishCall('被新的一通顶掉了');
      this.current = call;
      this.heard = 0;
      this.spoke = 0;
      this.callStartedMs = call.inviteAt ?? this.now();
      this.transientSince = 0;
      this.stuckHandled = false;
      this.ringRejected = false;
      this.announced = false;
      this.lastPhase = '';
      // 记录是**每一通**的账:新的一通进来就换一本(上一本已在 finishCall 里交出去了)。
      this.transcript = [];
      this.playback = new PlaybackLedger();
      this.unheardStreak = 0;
      this.deafNoticed = false;
    } else {
      this.current = call;
    }

    this.learnIdentity(call);

    if (call.phase === 'ringing') {
      // 响铃**不走"只在变化时动作"那道闸**:上游可能先推一条只有 id 的更新,
      // 号码要下一条才到(实测:先 `targetId:"unknown"`,80 毫秒后才是真号)。
      // 见 `decideRingOnce` —— 那里面自己保证"同一通只决一次"+"号码没到就等几秒"。
      this.startWatch();
      await this.decideRingOnce(call);
      this.lastPhase = call.phase;
      return;
    }
    if (call.phase === previousPhase) return;

    // "卡住"的计时:凡进入**天生过渡**的状态就起表,走掉了就清。
    if (isTransientPhase(call.phase)) {
      if (previousPhase !== call.phase) {
        this.transientSince = this.now();
        this.stuckHandled = false;
        this.startWatch();
      }
    } else {
      this.transientSince = 0;
    }

    if (call.phase === 'connected' && previousPhase !== 'connected') {
      await this.onConnected(call);
    } else if (isTerminal(call.phase)) {
      this.finishCall(call.nativeEndEvent ?? '正常结束');
      return;
    }
    this.lastPhase = call.phase;
  }

  /**
   * 响铃那一通该怎么办:**同一通只决一次**,但号码没到就等一会儿再决。
   *
   * 两条都是实测逼出来的(2026-10-09 他那通"直接被拒绝了"):
   * 1. **已经过期的邀请不许接**。他 18:16 重启时,17:14 那通早没人等的邀请还挂着"响铃",
   *    新加的"晚一步也接"照着接了 → 那个接听命令永远等不到原生应答 →
   *    桥卡在 `Another control is pending`,之后**每一通命令都发不出去**。所以超过响铃超时线的一律拒。
   * 2. **身份没到先别判**。上游会先推一条 `targetId:"unknown"`,真号 80 毫秒后才来;
   *    按"名单里没有就拒"会在第一瞬间把正经来电拒掉。所以身份不明时先等几秒。
   */
  /**
   * 同一通里"身份会变全"这件事学到的东西:`u_…`(uid) → 手机号(uin)。
   *
   * 上游有时候先只报 uid、过几秒才补上号码(实测:18:16:57 只有 uid,18:17:02 已经是号码)。
   * 学到一次之后,以后再看到这个 uid 就能立刻认出是谁 —— 不用每次都在"等一轮"里耗着。
   */
  private readonly uidToUin = new Map<string, string>();
  /** 每一通上一次看到的身份,用来发现"uid → 号码"这个变化。 */
  private readonly lastTargetByCall = new Map<string, string>();
  private ringDecision = { id: '', decided: false };
  private ringGraceTimer?: NodeJS.Timeout;
  /** 这一通**已经等过一轮**了 —— 不然宽限到点后又判一次"身份不明",会无限等下去。 */
  private ringGraceUsed = false;

  private async decideRingOnce(call: BridgeCall): Promise<void> {
    if (call.id !== this.current?.id) return;
    if (this.ringDecision.id !== call.id) {
      this.ringDecision = { id: call.id, decided: false };
      this.ringGraceUsed = false;
    }
    if (this.ringDecision.decided) return;

    const policy = this.policy();
    const ageMs = this.now() - (call.inviteAt ?? this.now());
    if (ageMs > policy.ringTimeoutSec * 1000) {
      this.ringDecision.decided = true;
      this.ringRejected = true;
      const reply = await this.send('reject', { callId: call.id });
      await this.note(
        `这通邀请已经挂了 ${humanSeconds(ageMs / 1000)},早没人等了(超过响铃超时线 ${policy.ringTimeoutSec} 秒),直接拒` +
          `——接一个过期的邀请会把桥卡住。${reply.ok ? '' : `(拒绝命令也没发成功:${reply.error?.message})`}`,
      );
      return;
    }

    const resolved = this.resolveCaller(call);
    const caller = callerOf(resolved);
    const listed = callerAllowed(this.opts.cfg.callers, caller);
    const looksLikeUin = /^\d{4,}$/.test(caller);
    if (!listed && !looksLikeUin && policy.rejectUnknown && !this.ringGraceUsed) {
      // 号码还没到(空、`unknown`、或只有 `u_…` 这种内部 id):**等一轮**,等一条更全的更新。
      this.ringGraceUsed = true;
      if (!this.ringGraceTimer) {
        this.ringGraceTimer = setTimeout(() => {
          this.ringGraceTimer = undefined;
          const latest = this.current;
          if (latest && latest.id === call.id && latest.phase === 'ringing') void this.decideRingOnce(latest);
        }, RING_GRACE_MS);
        this.ringGraceTimer.unref?.();
      }
      return;
    }
    if (this.ringGraceTimer) {
      clearTimeout(this.ringGraceTimer);
      this.ringGraceTimer = undefined;
    }
    this.ringDecision.decided = true;

    const decision = decideOnRing(this.resolveCaller(call), this.policy());
    if (decision.kind === 'accept') {
      const reply = await this.send('accept', { callId: call.id });
      await this.note(
        reply.ok
          ? `有来电(${callerOf(call) || '没报出号'})，已提交接听。`
          : `有来电但自动接起没成功:${reply.error?.message ?? '桥没给原因'}`,
      );
      return;
    }
    if (decision.kind === 'reject') {
      this.ringRejected = true;
      const reply = await this.send('reject', { callId: call.id });
      await this.note(`${decision.note}${reply.ok ? '' : `(拒绝命令也没发成功:${reply.error?.message})`}`);
      return;
    }
    // 手动模式:告诉她有人在打，让她自己决定。
    this.announced = true;
    // 先试着把来电界面抓一张 —— 桥那一侧看不出号码,而图上是写着谁打来的。
    const shot = await this.ringScreenshot();
    await this.emit(
      'phone.ringing',
      describeRinging(callerOf(call), shot !== undefined),
      'preempt',
      'phone',
      undefined,
      shot ? [shot] : undefined,
    );
  }

  /**
   * 响铃时抓一张来电界面的截图,当附件交给她。
   *
   * 这一格是**界面驱动那条路**才有的:老桥(koishi 那条)没有 `screenshot` 这个 op,
   * 回的是 `UNKNOWN_OP`;那三种失败(没这个 op / 屏幕上没窗 / 抓图失败)都只是"这次没图",
   * 不影响接电话,所以只落一条日志,不打扰她。
   *
   * 为什么值得抓:这一版桥只看得见像素、**报不出谁打来的**,它给的号是配置里预设的那个。
   * 把图交给她,她读得出图上的名字 —— 顺带把"看不出谁打来"那个缺口补上了。
   */
  private async ringScreenshot(): Promise<BlobInput | undefined> {
    const bridge = this.bridge;
    if (!bridge) return undefined;
    // 不复用 id 重试:这里要的是**此刻**的屏幕,断了就算了(下一通还会再抓)。
    const reply = await bridge.request('screenshot', {}, { retrySameId: false });
    if (!reply.ok) {
      this.log.info?.('来电截图没拿到', { code: reply.error?.code, message: reply.error?.message });
      return undefined;
    }
    const blob = screenshotBlob(reply.data);
    if (!blob) this.log.warn?.('桥回的截图形状不对,当没有这回事', { dataType: typeof reply.data });
    return blob;
  }

  private async onConnected(call: BridgeCall): Promise<void> {
    this.segmenter = this.makeSegmenter();
    this.speakGeneration += 1;
    this.speechAbort.abort();
    this.speechAbort = new AbortController();
    this.unconfirmedBlocks = 0;
    this.unconfirmedNoted = false;
    this.warmupSent = false;
    this.speakBuffer = '';
    this.speakQueue = [];
    this.audioQueue = [];
    this.plannedSpeechMs = 0;
    this.roundCapNoted = false;
    this.saidThisRound.clear();
    this.bargeRunMs = 0;
    this.bargeOnsetHerActive = false;
    this.bargeLoud = false;
    this.lastUnheardAt = 0;
    this.stalledSinceMs = 0;
    // 这几笔是**一整通**的账:在这里(接起)清,收尾时**不要**清 ——
    // 收尾也清的话,收尾日志里那三个数永远是 0(2026-10-09 就是这么错的)。
    this.stallNoticed = false;
    this.wroteAudioMs = 0;
    this.maxLagMs = 0;
    this.roundMuted = false;
    this.paceEndMs = 0;
    this.unheardStreak = 0;
    this.deafNoticed = false;
    this.startWatch();
    this.pumpWriter();
    this.announced = true;
    // 先通知外面(把思考关掉)，再投事件 —— 这样她那句"喂"就是按电话配置生成的。
    this.notifyCallState(true);
    await this.emit('phone.connected', describeConnected(call), 'flush', 'phone');
  }

  /**
   * 收尾:统计说给她听，然后把这一通的暂态清干净。
   * `reason` 只在日志里用 —— 事件正文里说的是**桥报的事实**。
   */
  private finishCall(reason: string): void {
    const call = this.current;
    if (!call) return;
    this.stopWatch();
    if (this.ringGraceTimer) {
      clearTimeout(this.ringGraceTimer);
      this.ringGraceTimer = undefined;
    }
    this.speakGeneration += 1;
    this.speechAbort.abort();
    this.speakBuffer = '';
    this.speakQueue = [];
    this.audioQueue = [];
    this.saidThisRound.clear();
    this.bargeRunMs = 0;
    this.bargeOnsetHerActive = false;
    this.bargeLoud = false;
    this.lastUnheardAt = 0;
    this.stalledSinceMs = 0;
    this.roundMuted = false;
    this.paceEndMs = 0;
    this.segmenter = undefined;
    this.current = undefined;
    this.lastPhase = '';
    const stats = { heard: this.heard, spoke: this.spoke };
    this.heard = 0;
    this.spoke = 0;
    const announced = this.announced;
    this.announced = false;
    // 记录**在这里交出去**,然后换一本(下一通自己会再清一次,两处都清是故意的:
    // 这一处管"交出去之后不留尾巴",那一处管"桥那边先有新通话时也对得上")。
    const transcript = this.transcript;
    this.transcript = [];
    const outgoing = call.direction === 'outgoing';
    this.log.info?.('通话收尾', {
      reason,
      phase: call.phase,
      heard: stats.heard,
      spoke: stats.spoke,
      announced,
      transcriptLines: transcript.length,
      // wroteAudioMs 是成功提交量，通话包含静默，二者不能相除当播放速度。
      // maxLagMs 是本地排队到写入回执的等待峰值。
      wroteAudioMs: Math.round(this.wroteAudioMs),
      callDurationMs: Math.round(this.now() - this.callStartedMs),
      maxLagMs: Math.round(this.maxLagMs),
    });
    // 先通知外面(把思考切回来)，再投收尾事件 —— 收尾那一句按她平时的配置生成更自然。
    this.notifyCallState(false);
    // 没跟她说过的通话(被直接拒掉的陌生号)不留总结:她知道都没知道，何况总结。
    if (announced) {
      void this.emit(
        'phone.ended',
        describeEnded(call, this.opts.timezone, stats, reason, transcript),
        'flush',
        'phone',
      );
    } else if (outgoing) {
      // 她拨出去的那通**从头到尾没接通**(她从没被告知"接通"),所以上一条不会发。
      // 但这一通是她自己发起的 —— 不说的话她会以为打成了,然后等一个永远不来的回复。
      const why = call.nativeEndEvent ? `,桥报的原因是「${call.nativeEndEvent}」` : '';
      void this.emit(
        'phone.outgoingFailed',
        `【电话】你拨出去的那通**没接通**(收尾时桥报的状态是「${call.phase}」${why})。` +
          '他没在手机边、或者没接。要再试就再调一次 phone_dial。',
        'flush',
        'phone',
      );
    }
  }

  /** 桥推来一块对方的音频。 */
  private onAudioFrame(frame: BridgeAudioFrame): void {
    const call = this.current;
    if (!call || frame.callId !== call.id || call.phase !== 'connected') return;
    const segmenter = this.segmenter;
    if (!segmenter) return;
    const raw = Buffer.from(frame.data, 'base64');
    if (raw.length === 0) return;

    // 桥说是多少就是多少(连上时已用 status 核对过);换算全交给 pcm.ts。
    const channels = frame.channels || this.bridgeChannels;
    const rate = frame.sampleRate || this.bridgeRate;
    const ear = resampleMono(downmixToMono(raw, channels), rate, EAR_RATE);

    const segments = segmenter.push(ear);

    // 抢话判据是**他连着响够久**,不是起音那一刻。
    //
    // 为什么:2026-10-09 那两通里唯一一次"打断她"的,是一块 -48 dBFS、不到 400 毫秒的响动
    // (而且它最后什么都没认出来)—— 却把她说了一半的 5.6 秒整句清掉了,听起来就是"她被打断/反应慢"。
    // 真人说话最短的一句是 860 毫秒,门开在中间。
    //
    // 两处讲究:①只算**过门限**的音频,不能拿 `segmenter.speaking` 算 —— 那个带 700ms 拖尾,
    // 一块脉冲噪声靠拖尾就能自己凑够时长;②按时长算,不按墙上时钟,这样"他连着说了多久"
    // 与帧来的快慢无关。
    const chunkMs = (ear.length / 2 / EAR_RATE) * 1000;
    const loudNow = frameDb(ear) > segmenter.threshold;
    if (loudNow && !this.bargeLoud) {
      // 一次新的起音:只有"她当时正在说"才算候选(与老行为一致 —— 她没在说就没什么可抢的)。
      this.bargeOnsetHerActive = this.herAudioActive();
      this.bargeRunMs = 0;
    }
    if (loudNow) this.bargeRunMs += chunkMs;
    else {
      this.bargeRunMs = 0;
      this.bargeOnsetHerActive = false;
    }
    this.bargeLoud = loudNow;
    if (
      this.opts.cfg.bargeIn
      && this.bargeOnsetHerActive
      && this.herAudioActive()
      && this.bargeRunMs >= this.opts.cfg.bargeInMinMs
    ) {
      this.bargeOnsetHerActive = false; // 一轮只抢一次
      this.log.info?.('抢话:他连着说了够久,清掉她没放完的', { runMs: Math.round(this.bargeRunMs) });
      void this.bargeIn();
    }

    if (this.opts.cfg.logAudio) this.dumpAudio('in', pcmToWav(ear, EAR_RATE));
    for (const segment of segments) void this.hear(segment.pcm, segment.durationMs);
  }

  private onStatus(status: BridgeStatus, kind: 'hello' | 'status'): void {
    // 轮询失败的具体原因在 diagnostics，call.error 只有笼统的“控制连接丢失”。
    const qq = status.diagnostics?.find(d => d.id === 'qq');
    if (qq) {
      const detail = { level: qq.level, message: qq.message?.slice(0, 1000) };
      const signature = JSON.stringify(detail);
      if (signature !== this.qqDiagnostic) {
        this.qqDiagnostic = signature;
        this.log.info?.('QQ 控制诊断变化', detail);
      }
    }
    const format = status.audioFormat;
    if (typeof format?.sampleRate === 'number' && format.sampleRate > 0 && format.sampleRate !== this.bridgeRate) {
      this.bridgeRate = format.sampleRate;
      this.log.info?.('桥报的采样率与默认不同,按桥的来', { rate: this.bridgeRate });
    }
    if (typeof format?.channels === 'number' && format.channels > 0 && format.channels !== this.bridgeChannels) {
      this.bridgeChannels = format.channels;
      this.log.info?.('桥报的声道数与默认不同,按桥的来', { channels: this.bridgeChannels });
    }
    if (kind !== 'hello') return;

    // 刚连上(或重连):用桥给的当前状态对齐，不拿我们记得的那份当准。
    const calls = (status.calls ?? [])
      .map((raw) => normalizeCall(raw))
      .filter((c): c is BridgeCall => c !== null);
    const live = currentCall(calls);
    const remembered = this.current;
    if (!live || isTerminal(live.phase)) {
      if (remembered && !isTerminal(remembered.phase)) this.finishCall('桥重连后这通已经没了');
      return;
    }
    // hello 与实时 call 走同一生命周期，避免恢复时遗漏端点通知或保留旧音频。
    void this.onCall(live).catch(error => this.log.warn?.('恢复通话状态失败', { error: describe(error) }));
  }

  /** 对方说完一句:送去认字,认出来就当事件给她。 */
  private async hear(pcm: Buffer, ms: number): Promise<void> {
    const call = this.current;
    if (!call) return;
    this.transcribing += 1;
    try {
      const asr = await transcribe(pcmToWav(pcm, EAR_RATE), this.opts.cfg.asr, this.opts.fetchImpl);
      if (this.current?.id !== call.id || !this.onCallNow()) return;
      if (!asr) {
        this.log.warn?.('这一句没认出来(识别服务不在或超时)');
        return;
      }
      const text = (asr.text ?? '').trim();
      const wordless = text === '' || !hasWords(text);
      // 第三张脸:正文**有字**,但不是这一通该说的话 —— 碎片段被识别猜成了别的语言
      // (实测出过 `Yeah.` / `やて。` / `그.`)。这种字投给她比"没听清"更坏:她会照着一句
      // 没头没尾的话回答,而他其实什么都没被听见。判据只取高精确度的那两种,见 ear.ts。
      const wrongLanguage = !wordless && looksLikeWrongLanguage(text, this.opts.cfg.asr?.language ?? 'auto');
      // 还有一张脸:**长到不像脉冲,正文却短得不可能是一句话**。
      // 实测:他连着说了 15~20 秒,出来的是「段。」「说一段什么。」(每秒钟不到半个字)。
      // 那种正文投给她只会让她猜错,不如老实说没听清。
      const tooShortForLength =
        !wordless && !wrongLanguage && ms >= UNHEARD_MIN_MS && text.length * 2 < ms / 1000;
      if (wordless || wrongLanguage || tooShortForLength) {
        // 纯乐器、掌声这类段，正文里只剩一个记号 —— 对她是噪声，不投，也不花钱。
        // 记在 info 上(带时长与原文):这条是"没认出来"的唯一现场,排查时全靠它。
        this.log.info?.(
          wordless ? '滤掉一段没有话的音频' : wrongLanguage ? '这一段被认成了别的语言,当成没听清' : '这一段认出来太短,当成没听清',
          {
            durationMs: Math.round(ms),
            text: text.slice(0, 30),
            // 记下当时配的语言:这条判据是"中文线"才生效的,排查时先看它。
            language: this.opts.cfg.asr?.language ?? 'auto',
          },
        );
        // 但如果这一段**长到不像脉冲**(1.5 秒以上),那多半不是噪声,而是他那句话在网上碎了、
        // 衰减了(2026-10-09 实测:4.5 秒的段识别出空串,电平是断续的中等音量)。
        // 这时**静默丢掉是最坏的选择** —— 他那边只会看到"她又不回我"。告诉她"没听清",
        // 她就会说一句"再说一遍"(人就是这么做的),他至少知道是这一环没接住。
        if (ms >= UNHEARD_MIN_MS) {
          // 记录与"这一通几乎听不见他"的判定都按**每一段**算,不跟着那条限流走:
          // 限流管的是"别连着刷屏",而记录与判定要的是真相。
          this.unheardStreak += 1;
          this.transcript.push({ who: 'him', text: unheardLine(ms) });
          if (this.now() - this.lastUnheardAt >= UNHEARD_REPEAT_MS) {
            this.lastUnheardAt = this.now();
            this.heard += 1;
            await this.emit('phone.speech', `【电话·对方】${unheardLine(ms)}`, 'flush', 'other', {
              unintelligible: true,
              durationMs: Math.round(ms),
            });
          }
          await this.maybeNoticeDeafness(ms);
        }
        return;
      }
      this.heard += 1;
      // 认出来一句,前面那一串"没听见"就到此为止。
      this.unheardStreak = 0;
      this.transcript.push({ who: 'him', text });
      const preempt = this.consumePreempt();
      await this.emit(
        'phone.speech',
        `【电话·对方】${text}(说了 ${(ms / 1000).toFixed(1)} 秒)`,
        preempt ? 'preempt' : 'flush',
        'other',
        { asrEvent: asr.event ?? '', durationMs: Math.round(ms) },
      );
    } finally {
      this.transcribing -= 1;
    }
  }

  /**
   * 连着好几段话一个字都没认出来 —— 认定**这一通他几乎没被听见**,跟她说一次。
   *
   * 为什么要有这一条:2026-10-09 他那一通里他说的几乎全没被转写(整通只认出 1 句),
   * 而**她那一侧什么都不知道** —— 她只看到"他没说话",于是安静地等着。真相是声音在网上碎了。
   * 三种成因(他真没说 / 网上碎了 / 起音门限太高)在她看来长得一模一样,所以必须有人替这一层说话。
   * 一通只说一次(`deafNoticed`),否则刷屏;认出来一句就把这一串清零(见 `hear`)。
   */
  private async maybeNoticeDeafness(ms: number): Promise<void> {
    if (this.unheardStreak < DEAF_STREAK || this.deafNoticed) return;
    this.deafNoticed = true;
    this.log.warn?.('这一通他几乎没被听见', { streak: this.unheardStreak, lastMs: Math.round(ms) });
    await this.note(
      `这一通里连着 ${this.unheardStreak} 段话我一个字都没认出来(最近这段 ${(ms / 1000).toFixed(1)} 秒)` +
        '——多半是他那侧的声音在网上碎了、或者太吵,不是他没说话。' +
        '你可以直接在电话里跟他说"这边听不清",让他靠近一点、换个地方;或者让他在别处打字给你(打字说的同样算他说的话)。',
    );
  }

  // ───────────────────────── 嘴:她的正文 → 声音 ─────────────────────────

  private onStreamEvent(event: unknown): void {
    const e = event as PhoneStreamEvent;
    if (e.type === 'response.created') {
      // 新一轮:上一轮的尾巴先收掉，免得两轮的话粘在一起。
      this.finishRound();
      // 这条闸门是**每一轮**的额度(不是整通电话的)—— 见 config 里 maxSpeakSec 的说明。
      this.plannedSpeechMs = 0;
      this.roundCapNoted = false;
      // 去重也是**每一轮**的:新一轮里同一句话照念(她可能是真要再说一遍)。
      this.saidThisRound.clear();
      // 上一轮她按过停 —— 那是"这一轮"的事,新一轮照常能说。
      this.roundMuted = false;
      return;
    }
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string' && e.delta !== '') {
      this.feedHerText(e.delta);
      return;
    }
    if (e.type === 'response.output_text.done') this.finishRound();
  }

  /** 一轮结束:把没标点的尾巴也合成掉。 */
  private finishRound(): void {
    if (!this.onCallNow() || this.roundMuted) {
      this.speakBuffer = '';
      return;
    }
    const tail = flushSentence(this.speakBuffer);
    this.speakBuffer = '';
    // 尾巴也要过一遍去重:她写半句不带句号(一直留在缓冲里)、又用 `phone_say` 说同一句时,
    // 漏了这一道就会把同一句念两遍 —— 2026-10-14 补 `phone_say` 时正是从这个缝里漏进来的。
    if (tail && worthSpeaking(tail) && !this.saidThisRound.has(speechKey(tail))) {
      this.enqueue([tail]);
    }
  }

  private feedHerText(delta: string): void {
    if (!this.onCallNow() || this.roundMuted) return;
    this.speakBuffer += delta;
    // 缓冲别无限长:她说一大段而标点少的时候，靠 takeSentences 的安全阀切。
    if (this.speakBuffer.length > 8000) this.speakBuffer = this.speakBuffer.slice(-4000);
    const { sentences, rest } = takeSentences(this.speakBuffer, 120);
    this.speakBuffer = rest;
    const usable = sentences.filter(worthSpeaking);
    if (sentences.length > usable.length) {
      // 没字母/数字的正文(纯标点、纯记号)不值得念 —— 但**别静默**:留一条,
      // 否则"控制台看得见、电话里没声音"就又是一桩无头案。
      this.log.info?.('她写的东西里有一段不值得念(没有字母/数字)，跳过了', {
        text: sentences.filter((s) => !worthSpeaking(s)).join(' ').slice(0, 40),
      });
    }
    // 这一轮里 `phone_say` 已经交过的句子,这里不再念第二遍(两条路说同一句只出一声)。
    const fresh = usable.filter((s) => !this.saidThisRound.has(speechKey(s)));
    if (fresh.length < usable.length) {
      this.log.info?.('这一轮里重复的句子不念第二遍', { skipped: usable.length - fresh.length });
    }
    if (fresh.length > 0) this.enqueue(fresh);
  }

  /**
   * 把句子排进合成链。返回**实际进去几段**、以及有没有被"这一轮说够了"那道闸门挡下 ——
   * `phone_say` 要照着这个数给她回执(挡下的没到他耳朵里,不能说成念了)。
   */
  private enqueue(sentences: string[]): { queued: number; capped: boolean } {
    let queued = 0;
    let capped = false;
    for (const sentence of sentences) {
      if (this.opts.cfg.maxSpeakSec > 0 && this.plannedSpeechMs > this.opts.cfg.maxSpeakSec * 1000) {
        capped = true;
        if (!this.roundCapNoted) {
          this.roundCapNoted = true;
          this.log.info?.('这一轮她说的已经够长了，剩下的不念了', { spokeMs: Math.round(this.plannedSpeechMs) });
        }
        continue;
      }
      const utterance = this.playback.add(sentence, this.current!.id, this.speakGeneration, this.now());
      this.speakQueue.push(utterance);
      this.transcript.push(utterance.line);
      this.saidThisRound.add(speechKey(sentence));
      // 粗估:一个汉字约 0.18 秒。只为把"这一轮说够了"这条闸门算出来，
      // 不参与任何音频计算 —— 真正的时长以合成结果为准。
      this.plannedSpeechMs += sentence.length * 180;
      queued += 1;
    }
    this.pumpSynthesis();
    this.pumpWriter();
    return { queued, capped };
  }

  /** 合成走一条链:一句接一句。播放侧独立排空，所以两句之间不会因为等合成而空一拍。 */
  private pumpSynthesis(): void {
    if (this.synthBusy || !this.onCallNow()) return;
    this.synthBusy = true;
    const generation = this.speakGeneration;
    const signal = this.speechAbort.signal;
    const ledger = this.playback;
    void (async () => {
      try {
        while (this.speakQueue.length && generation === this.speakGeneration && this.onCallNow()) {
          const utterance = this.speakQueue.shift()!;
          const startedAt = this.now();
          let first = true;
          const framer = new StreamingPcmFramer(this.bridgeRate, this.bridgeChannels, this.opts.cfg.frameMs);
          const queueFrames = (frames: Buffer[]): void => {
            for (const slice of frames) {
              this.sequence++;
              ledger.frame(utterance, 'utt-' + utterance.callId + '-' + this.sequence);
              this.audioQueue.push({ pcm: slice, sequence: this.sequence, atMs: this.now(), utterance });
            }
            this.pumpWriter();
          };
          // **接起后的第一句之前垫一小段静音**(2026-10-15 他报的):他实测第一句开头被吞
          // ("喂，我在"只听到"我在")。音频本身是完整进了声卡的(逐句标记是"桥确认播放完成"),
          // 丢在 QQ 那条媒体通道刚起来的时候 ⇒ 拿静音去暖它,而不是拿她的第一个字。
          // 垫在**同一帧里**(先喂 framer,再由她的话把这一帧填满),所以不会因此多开一次播放流。
          if (!this.warmupSent && (this.opts.cfg.warmupMs ?? 0) > 0) {
            this.warmupSent = true;
            const bytes = Math.round((this.bridgeRate * this.bridgeChannels * 2 * (this.opts.cfg.warmupMs ?? 0)) / 1000);
            queueFrames(framer.push(Buffer.alloc(bytes), false));
          }
          const result = await synthesizePcm(utterance.text, {
            settings: this.opts.cfg.tts,
            apiKey: this.opts.secret(this.opts.cfg.tts.apiKeySecret),
            targetRate: this.bridgeRate,
            fetchImpl: this.opts.fetchImpl,
            log: this.log,
            signal,
            onPcm: (pcm) => {
              if (signal.aborted || generation !== this.speakGeneration) return;
              if (first) {
                first = false;
                this.log.info?.('首段音频可用', { utteranceId: utterance.id, queueWaitMs: startedAt - utterance.queuedAt, firstAudioMs: this.now() - startedAt });
              }
              queueFrames(framer.push(toChannels(pcm, this.bridgeChannels)));
            },
          });
          if (generation !== this.speakGeneration || signal.aborted) return;
          queueFrames(framer.push(Buffer.alloc(0), true));
          ledger.finish(utterance, result.ok);
          if (!result.ok) {
            void this.note(result.error + '。可能已有部分音频提交；没有自动重播整句。');
            continue;
          }
          if (this.opts.cfg.logAudio) this.dumpAudio('out', pcmToWav(result.pcm, result.sampleRate));
          this.spoke++;
        }
      } catch (error) {
        if (!signal.aborted) this.log.warn?.('合成这一路出错', { error: describe(error) });
      } finally {
        this.synthBusy = false;
        if (this.speakQueue.length && this.onCallNow()) this.pumpSynthesis();
      }
    })();
  }

  private pumpWriter(): void {
    if (this.writerBusy || !this.onCallNow()) return;
    this.writerBusy = true;
    const generation = this.speakGeneration;
    const signal = this.speechAbort.signal;
    void (async () => {
      try {
        while (generation === this.speakGeneration && this.onCallNow()) {
          if (this.clearPending) await this.clearPending;
          if (generation !== this.speakGeneration) break;
          const chunk = this.audioQueue.shift();
          if (!chunk) break;
          await this.writeChunk(chunk, generation, signal);
        }
      } catch (error) {
        if (!signal.aborted) this.log.warn?.('发送音频出错', { error: describe(error) });
      } finally {
        this.writerBusy = false;
        if (this.audioQueue.length && this.onCallNow()) this.pumpWriter();
      }
    })();
  }

  /**
   * 送一块音频。
   *
   * 「没回执」怎么办是 2026-10-15 改的,原因写在 `unconfirmedBlocks` 那段:桥自己的请求
   * 队列会堵,堵住时 `audio.write` 十几秒不给回执 —— 而那不等于没念。所以这一路现在
   * **按原 id 多问几次**(桥按 id 记住在办的那一条,重问只会把已有的结果给回来,不会把
   * 同一块念两遍),问遍了还是没有,就如实记成"没确认",**继续往下说** ——
   * 绝不因为一块没回执就把整通电话封住(那天就是这么一字不出)。
   */
  private async writeChunk(chunk: AudioChunk, generation: number, signal: AbortSignal): Promise<void> {
    const call = this.current;
    const bridge = this.bridge;
    if (!call || !bridge || call.phase !== 'connected' || signal.aborted) return;
    const ms = durationMs(chunk.pcm, this.bridgeRate, this.bridgeChannels);
    // 只计算尚未经过的播放时间。静默不积攒额度；发送之前留出空间。
    const waitMs = Math.max(0, this.paceEndMs + ms - this.now() - Math.max(PACE_LEAD_MS, ms));
    if (waitMs > 0) await this.waitAudio(waitMs, signal);
    if (signal.aborted || generation !== this.speakGeneration) return;
    const id = 'utt-' + call.id + '-' + chunk.sequence;
    const ledger = this.playback;
    if (!chunk.utterance.frames.has(id)) ledger.frame(chunk.utterance, id);
    const sentAt = this.now();
    // **请求 id 与播放编号是两件事**(2026-10-15 实测栽在这上面):上游对 `request.id` 有
    // 80 字符上限(`daemon.mjs:511` 的 `request.id.length>80` ⇒ INVALID_REQUEST),
    // 而这套部署的通话 id 是 75 字符的 `<linkEpoch>:<n>:<nativeId>` —— 拿 `utt-<通话id>-<序号>`
    // 当请求 id 一加前缀就超,桥每一块都回"无效请求",她一个字都出不去(而单测全绿)。
    const requestId = audioRequestId(call.id, chunk.sequence);
    // 参数**只拼一次**:重问必须连 timestamp 都一字不改 —— 上游按 id + 参数指纹去重,
    // 参数一变它就成了"同一个 id 换了内容",既去不了重,还可能把同一句念两遍。
    const frame = {
      callId: call.id, encoding: 'pcm_s16le', sampleRate: this.bridgeRate, channels: this.bridgeChannels,
      sequence: chunk.sequence, timestamp: this.now(), data: chunk.pcm.toString('base64'),
    };
    // 兜底写死一遍(和 config 的默认值一致):老部署那份 config.json 里没有这几个键,
    // 框架虽然会把 defaults 铺在前面,但"没有重试"和"有重试"是两种行为,不留给合并细节赌。
    const attempts = Math.max(1, 1 + (this.opts.cfg.audioWriteRetries ?? 2));
    let reply = await this.sendChunk(frame, id, requestId, signal);
    for (let attempt = 2; attempt <= attempts; attempt += 1) {
      if (reply.ok || signal.aborted) break;
      // "队列满"有它自己那条重试(见下),别混在一起。
      if (reply.error?.message?.includes('queue is full')) break;
      // 桥说这一条已经在办/已经办过 —— 那就是收到了。
      if (alreadyHasBlock(reply)) { reply = { ok: true, data: { state: 'queued' } }; break; }
      this.log.info?.('这一块音频没拿到回执，按原 id 再问一次', {
        attempt, code: reply.error?.code, message: reply.error?.message,
      });
      await this.waitAudio(Math.max(0, this.opts.cfg.audioWriteRetryWaitMs ?? 2000), signal);
      if (signal.aborted) break;
      reply = await this.sendChunk(frame, id, requestId, signal);
    }
    if (signal.aborted || generation !== this.speakGeneration || this.current?.id !== call.id) return;
    this.maxLagMs = Math.max(this.maxLagMs, this.now() - chunk.atMs);
    if (!reply.ok) {
      this.log.info?.('这一块音频没写进去', { code: reply.error?.code, message: reply.error?.message });
      if (reply.error?.message?.includes('queue is full')) {
        if (!this.stalledSinceMs) this.stalledSinceMs = this.now();
        if (!this.stallNoticed && this.now() - this.stalledSinceMs >= STALL_NOTICE_MS) {
          this.stallNoticed = true;
          void this.note('桥的音频队列持续满，正在保留原音频等待重试；需要停止时调 phone_stop。');
        }
        this.audioQueue.unshift(chunk);
        await this.waitAudio(300, signal);
        return;
      }
      // 问遍了还是没回执。这一块**不重播**(不知道念没念,重播可能念两遍),
      // 也**不封住后面** —— 记成"没确认"、如实告诉她一句,然后继续往下说。
      ledger.receipt({ id, callId: call.id, state: 'uncertain' });
      this.unconfirmedBlocks += 1;
      if (!this.unconfirmedNoted) {
        this.unconfirmedNoted = true;
        void this.note(
          '有一块音频桥那边一直没确认收到(可能没念出去，也可能只是回执丢了)。**我接着说了** —— ' +
            '他要是说没听见，调 phone_stop 清了再重说一遍。',
        );
      }
      return;
    }
    const receipt = reply.data as { state?: string } | undefined;
    ledger.receipt({ id, callId: call.id, state: receipt?.state ?? 'queued' });
    this.paceEndMs = Math.max(this.paceEndMs, this.now()) + ms;
    this.wroteAudioMs += ms;
    this.log.info?.('音频块提交', { utteranceId: chunk.utterance.id, sequence: chunk.sequence, audioMs: Math.round(ms), queuedMs: this.now() - chunk.atMs, replyMs: this.now() - sentAt });
    if (this.stalledSinceMs) {
      this.log.info?.('桥重新接受音频', { stalledMs: this.now() - this.stalledSinceMs });
      this.stalledSinceMs = 0;
    }
  }

  /**
   * 把一块交给桥。
   *
   * `playbackId` 是**播放编号**(上游上限 160 字符),`requestId` 是**请求 id**(上限 80 字符),
   * 两者别混 —— 它们的上限不同,拿前者当后者的那天桥当场回了 INVALID_REQUEST。
   * `frame` 由调用方拼一次、几次重问共用同一份(见 `writeChunk` 那段)。
   */
  private sendChunk(frame: Record<string, unknown>, playbackId: string, requestId: string, signal: AbortSignal) {
    return this.bridge!.request(
      'audio.write',
      { callId: frame.callId, playbackId, frame },
      { signal, id: requestId, timeoutMs: this.opts.cfg.audioWriteTimeoutMs ?? 30000 },
    );
  }

  private waitAudio(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async clearSpeech(): Promise<boolean> {
    this.speakGeneration++;
    this.speechAbort.abort();
    this.speechAbort = new AbortController();
    this.speakQueue = [];
    this.audioQueue = [];
    this.speakBuffer = '';
    this.playback.interrupt();
    this.paceEndMs = 0;
    const callId = this.current?.id;
    if (!callId) return true;
    const attempts = Math.max(1, this.opts.cfg.audioClearRetries ?? 2);
    let ok = false;
    const previous = this.clearPending;
    const pending = (async () => {
      if (previous) await previous;
      // 喊停这件事值得多试一次:桥的请求队列堵着时第一次常常拿不到回执(2026-10-15 实测)。
      // 本地队列上面已经清空了,所以重试只是"再问一遍远端",不会多说一个字。
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const reply = await this.send('audio.clear', { callId });
        ok = reply.ok;
        if (ok) break;
        this.log.warn?.('桥端停止未确认', { attempt, code: reply.error?.code, message: reply.error?.message });
        if (attempt < attempts) await this.waitAudio(1000, this.speechAbort.signal);
      }
      // 拿不到回执也**不封住下一轮**:本地确实已经停了,远端最多还剩嘴上那两三秒,
      // 为此把整通后面的说话全断掉,代价比这几秒大得多(那天就是这么哑掉的)。
      if (!ok) this.unconfirmedBlocks += 1;
    })();
    this.clearPending = pending;
    try { await pending; return ok; }
    finally { if (this.clearPending === pending) this.clearPending = undefined; this.pumpWriter(); }
  }

  /**
   * 抢话:把还没放出去的全丢掉，并让这一代作废。
   *
   * 用 `audio.clear` 而不是 `mute` 的理由:要的是"**立刻**停下来听"，
   * 而 mute 只挡住后续写入，已经交给桥排队的那几块还会继续播。
   */
  private async bargeIn(): Promise<void> {
    if (!this.herAudioActive()) return;
    this.preemptArmed = true;
    const ok = await this.clearSpeech();
    if (!ok) void this.note('本地已停止，桥端清队列未确认，可能仍有声音。');
  }

  // ───────────────────────── 看护与自愈 ─────────────────────────

  private startWatch(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      void this.tick().catch((error) => this.log.warn?.('看护这一拍出错', { error: describe(error) }));
    }, WATCH_MS);
    // 看护不该拖着进程不让退;它只是每秒钟看一眼。
    this.watchTimer.unref?.();
  }

  private stopWatch(): void {
    if (!this.watchTimer) return;
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  private async tick(): Promise<void> {
    const call = this.current;
    if (!call) {
      this.stopWatch();
      return;
    }
    const policy = this.policy();
    // 响铃超时:没人接就自动拒(用户定的 30 秒)。
    if (!this.ringRejected && ringTimedOut(call, policy, this.now())) {
      this.ringRejected = true;
      const reply = await this.send('reject', { callId: call.id });
      await this.note(
        `响铃超过 ${policy.ringTimeoutSec} 秒没人接，自动拒了。${reply.ok ? '' : `(拒收命令也没发成功:${reply.error?.message})`}`,
      );
      return;
    }
    // 卡在过渡状态(ending / rejecting / accepted / dialing):它在等一个永远不来的原生 ACK，
    // 而且**挡住新通话**(他的表现就是"打了没反应,桥那边连记录都没有")。
    if (!this.stuckHandled && this.transientSince > 0) {
      const held = stuckFor(call, policy, this.transientSince, this.now());
      if (held !== null) {
        this.stuckHandled = true;
        await this.selfHeal(held, call.phase);
      }
    }
  }

  /**
   * 自愈:重启 AV Host 换 bootId，那通才会从 `rejecting` 走到 `ended`。
   * 命令从配置来(容器名、路径都是部署事实，不是这一包的判断)。
   */
  private async selfHeal(heldMs: number, phase: string): Promise<void> {
    const command = this.opts.cfg.ssh.recoverCommand.trim();
    if (command === '') {
      await this.note(
        `通话卡在「${phase}」已经 ${humanSeconds(heldMs / 1000)}，而且它会挡住下一通。` +
          '这一路没配自愈命令(worlds.phone.ssh.recoverCommand)，需要人工重启 AV Host。',
      );
      return;
    }
    if (!this.tunnel) {
      await this.note(
        `通话卡住了 ${humanSeconds(heldMs / 1000)}，但隧道不在这一路手里(ssh.enabled 关着)，自愈命令发不出去。`,
      );
      return;
    }
    const result = await this.tunnel.runRemote(command, 30000);
    await this.note(
      result.ok
        ? `通话卡在「${phase}」${humanSeconds(heldMs / 1000)}，已经重启 AV Host 自愈(${command})。`
        : `通话卡住了(${phase})，自愈命令没跑成(${result.output.slice(-200) || '没有输出'})，需要人工看一眼。`,
    );
  }

  // ───────────────────────── 工具 ─────────────────────────

  /**
   * 她主动说一句(`phone_say`)。
   *
   * **为什么要这个工具(2026-10-14 定的)。** 这一包以前只有一条出声的路:**她写下的正文**。
   * 而框架给她的常驻规矩是「Text you output directly, without a tool, is private thought…
   * To be heard, use a speaking tool」(不经工具写的正文是内心活动,要说话得用说话工具),
   * 而 qq2 / pet / terminal 都各有自己的说话工具,**只有电话没有** ——
   * 于是"电话要出声就得写正文"这件事一直跟那条规矩正面对撞。那天实测了三通:
   * 她每轮都只调 `end_turn`、一个字不写,他那边整通静音(而她的思考链里写着
   * "in a call, my written text in a turn IS my voice. I should just write!")。
   * 补上这个工具,那条规矩在电话上就成立了 —— 说话是一个**动作**,不再靠她记住例外。
   *
   * 正文那条路**保留不动**(兼容改写之前的用法),两条路说同一句不会念两遍(见 `saidThisRound`)。
   *
   * 四条边界写死在代码里,不靠她记:没接通时说出去没人听(回执明说"这一句没有被念出去")、
   * 她自己按过停的这一轮不再出声(`roundMuted`)、一轮的额度照旧管着(`maxSpeakSec`,
   * 被挡下的如实告诉她"他没听到")、纯记号(只有 emoji/标点)不值得花钱念。
   *
   * 回执只说**交给合成了** —— 合成是异步的,失败会另发一条通知(`pumpSynthesis` 那条),
   * 与那一路上"submitted ≠ 接通"的口径一致:不把"交出去"说成"他听见了"。
   */
  private sayTool(): ToolDef {
    return {
      name: 'phone_say',
      description:
        '在已接通的电话里说话。text 只放要念的短句；回执确认进入合成队列，不代表已经播放或对方听见。没接通或本轮已停止时失败；某一块音频没拿到回执不会让整通停住，只会如实记一笔。',
      tags: ['speak'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            description: '要说给他听的这句话本身。短句最好 —— 一个人张口就是一句,别一次塞一整段。',
          },
        },
        required: ['text'],
      },
      handler: async (args): Promise<string | ToolOutcome> => {
        const call = this.current;
        if (!call || call.phase !== 'connected') {
          // 最常见的一种:她刚调过 phone_dial,那头还没接起来。这一条必须说死,
          // 否则她会以为"我说过了"而其实一个字都没出去。
          const live = describeLive(call, this.now(), this.bridgeOnline ? '' : this.bridgeNote);
          return {
            text:
              `现在没有接通的话,**这一句没有被念出去**(${live})。` +
              (call ? '等它变成"通话中"再调,或者先调 phone_answer 接起来。' : '要打给他就先调 phone_dial。'),
            failed: true,
          };
        }
        const raw = typeof args.text === 'string' ? args.text : '';
        if (raw.trim() === '') return { text: 'text 是空的,这一句没念。', failed: true };
        if (this.roundMuted) {
          return {
            text:
              '这一轮你刚调过 phone_stop,这一轮剩下的不再出声。要接着说就等他再开口 —— 那是新一轮,那时照常能说。',
            failed: true,
          };
        }

        // 与正文那条路同一套切句/过滤:长句照切,尾巴也交出去(她没写句号的那半句照样念)。
        const { sentences, rest } = takeSentences(raw, 120);
        const tail = flushSentence(rest);
        const all = [...sentences, ...(tail === null ? [] : [tail])].filter(worthSpeaking);
        if (all.length === 0) {
          return { text: '这一句里没有能念的字(只有记号或表情),他那头听不到任何东西。', failed: true };
        }
        const fresh = all.filter((s) => !this.saidThisRound.has(speechKey(s)));
        if (fresh.length === 0) {
          return `这一句这一轮已经提交过,不重复入队:「${all[0]}」。`;
        }

        const { queued, capped } = this.enqueue(fresh);
        if (queued === 0) {
          return {
            text:
              `**没念出去**:这一轮你说的话已经够长了(worlds.phone.maxSpeakSec 管着,现在 ${this.opts.cfg.maxSpeakSec} 秒)。` +
              '想接着说就等他再开口 —— 那是新一轮。',
            failed: true,
          };
        }
        const est = Math.round((fresh.slice(0, queued).reduce((n, s) => n + s.length, 0) * 180) / 1000);
        const parts = [`已经交给合成念了:「${fresh[0]}」`];
        if (queued > 1) parts.push(`(这一句被切成 ${queued} 段,一起念出去)`);
        parts.push(`,预计音频约 ${est} 秒（不含排队和合成等待），尚未确认播放。`);
        if (capped) parts.push('**后面那几段被"这一轮说够了"挡下了,他没听到** —— 想接着说等他再开口。');
        parts.push('合成要是没成,我会单独告诉你一句。');
        return parts.join('');
      },
    };
  }

  private answerTool(): ToolDef {
    return {
      name: 'phone_answer',
      description:
        '接起当前正在响的那通电话。只在没有自动接起(配置里 autoAnswer 关着)时才需要你调；' +
        '没有来电或已经不在响铃阶段时会明确告诉你。',
      tags: ['act'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (): Promise<string | ToolOutcome> => {
        const call = this.current;
        if (!call) return { text: '现在没有来电。', failed: true };
        if (call.phase !== 'ringing') {
          return { text: `这通已经不在响铃阶段了(现在是 ${call.phase})，不用接。`, failed: true };
        }
        const reply = await this.send('accept', { callId: call.id });
        if (!reply.ok) return { text: `没接上:${reply.error?.message ?? '桥没给原因'}`, failed: true };
        return '已提交接听。"submitted" 只表示命令交出去了，它变成"通话中"才算真接通——那之后对方说的话会作为事件到你这里。';
      },
    };
  }

  /**
   * 她主动拨出去。
   *
   * 只有一条路:拨给配置里那一个人(用户定的"只打给你、不设限")。不做名单、不做时段限制 ——
   * 出站的唯一用途就是"她想起什么、想跟他说",多一层门只会多一层要维护的判断。
   *
   * 上游那条限制先在这里拦一道:**已经有未结束的通话时 `dial` 直接被拒**(`CALL_BUSY`),
   * 与其把上游那句英文原样抛给她,不如本地就说清"现在有一通在"。
   */
  private dialTool(): ToolDef {
    return {
      name: 'phone_dial',
      description:
        '主动拨一通语音电话给开发者(这一路只有这一个拨号目标,就是配置里那个人)。' +
        '不在通话里时才能拨。拨出去他接起之后你们就在一通里:要说什么就调 phone_say(直接写下的正文这一路也会被念出去),' +
        '他说的会作为事件给你。',
      tags: ['act'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (): Promise<string | ToolOutcome> => {
        const dial = dialTarget(this.opts.cfg);
        if (dial.target === '') {
          return {
            text: '这一路还没配拨号目标(worlds.phone.dial.target),所以拨不出去。要他先在部署配置里填上那一格。',
            failed: true,
          };
        }
        if (!this.bridgeOnline) {
          return { text: `桥没连着,拨不出去:${this.bridgeNote}`, failed: true };
        }
        const call = this.current;
        if (call && !isTerminal(call.phase)) {
          return { text: `现在有一通在(${callerOf(call) || '没报出号'},${call.phase}),不能同时拨。`, failed: true };
        }
        // 上游那条帧:`{op:'dial', args:{kind:'direct', targetId:<对端的 uid>, media:'audio'}}`
        // (`daemon.mjs` 把它送成 `{peerUid: args.targetId}`)。**目标是 uid,不是手机号。**
        const reply = await this.send('dial', { kind: 'direct', targetId: dial.target, media: 'audio' });
        if (!reply.ok) return { text: `拨号没发成功:${whyFailed(reply)}`, failed: true };
        return (
          `已经在拨给${dial.label}了。` +
          '"submitted" 只表示命令交出去了 —— 他接起来(状态变成"通话中")你们才算在一通里,' +
          '那之后他说的每一句都会作为事件给你。他没接的话,收尾时我会告诉你一声。'
        );
      },
    };
  }

  private hangupTool(): ToolDef {
    return {
      name: 'phone_hangup',
      description: '挂断当前这通电话。可以带一句为什么挂(只进你的上下文与日志，不会被念给对方)。',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string', description: '挂断的原因，给自己与日志看。' } },
      },
      handler: async (args): Promise<string | ToolOutcome> => {
        const call = this.current;
        if (!call) return { text: '现在没有通话可挂。', failed: true };
        const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? `(原因:${args.reason.trim()})` : '';
        const first = await this.send('hangup', { callId: call.id });
        if (first.ok) return `已提交挂断${reason}。真正结束以 phone.ended 事件为准。`;

        // 第一次失败就**自动再试一次**,不是让她自己猜。
        // 为什么值得这一次重试:上游那个电话宿主在通话**由对方结束**时(或它自己出问题时)会主动退出,
        // 被监督脚本 2 秒后拉起 —— 而它从起进程到原生能力就绪要好几秒,那几秒里这道命令会被一句
        // 会误导人的理由拒掉。2026-10-10 实测:她挂断失败的那两次正落在那个窗口里,理由是
        // `Requires an exact audited QQ library…`(看着像"这个 QQ 版本不支持",其实只是"还没就绪")。
        await sleep(HANGUP_RETRY_DELAY_MS);
        const second = await this.send('hangup', { callId: call.id });
        if (second.ok) {
          return `第一次挂断没成功(${whyFailed(first)}),等一下又试了一次,这次提交上了${reason}。真正结束以 phone.ended 事件为准。`;
        }
        return {
          text:
            `挂断命令没发成功:${whyFailed(second)},又试一次也是同一个原因。` +
            '这一路偶尔会被上游拒 —— 云上那个电话宿主在通话结束时会自己重启一次,那几秒里它的原生能力还没就绪。' +
            '**直接跟他说一句「我这边挂不掉,你挂一下」** —— 他挂了这通一样会结束。' +
            '要是他那边也不方便,过一会儿再调一次 phone_hangup。',
          failed: true,
        };
      },
    };
  }

  /**
   * 她自己按停。
   *
   * 为什么要有这个工具:他说「我一说话就自动打断」不好用(噪声也会按那个键),
   * 想要的是**他喊停("停停停"),由她自己停下**。语义只有她懂,所以停这件事
   * 归她判断;World 只负责执行:把手上没念完的收掉,并且**这一轮剩下的正文不再念**
   * (否则她一边说"好,我停了"一边把后半段念完,更怪)。下一轮她照常能说话。
   */
  private stopTool(): ToolDef {
    return {
      name: 'phone_stop',
      description:
        '**立刻停下你正在念的话**(把还没念完的收掉),这一轮剩下的正文也不再念。' +
        '对方说「停」「停停停」「先别说了」这类意思时调它。调完这一轮就安静下来,下一次他开口你照常能说。',
      tags: ['act'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (): Promise<string | ToolOutcome> => {
        const hadCall = !!this.current;
        this.roundMuted = true;
        const ok = await this.clearSpeech();
        if (!hadCall) return '现在没有通话，本地合成和待发音频已清理。';
        return ok ? '本地合成和待发音频已停，桥已确认清队列。这一轮不再出声。' :
          { text: '本地合成和待发音频已停；桥那边清队列没拿到回执，不能确认远端已安静（最多还余两三秒）。这一轮不再出声，下一轮照常说。', failed: true };
      },
    };
  }

  private statusTool(): ToolDef {
    return {
      name: 'phone_status',
      description: '现在电话这一路的实况:有没有通话、对方是谁、已经多久、桥通不通、合成和播放各确认到哪一步。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async (): Promise<string> => {
        const call = this.current;
        const noise = this.segmenter?.noiseFloor;
        const since = call ? clock((this.now() - (call.inviteAt ?? this.callStartedMs)) / 1000) : '';
        const bits = [
          describeLive(call, this.now(), this.bridgeOnline ? '' : this.bridgeNote),
          this.bridgeOnline ? '桥连着。' : `桥没连着:${this.bridgeNote}`,
          `接听名单:${this.opts.cfg.callers.map((c) => String(c)).join('、') || '(没配，谁都不接)'}`,
          call ? `这一通已 ${since}，听到对方 ${this.heard} 句，完整合成 ${this.spoke} 段；${this.playback.summary()}。` : '',
          // 没被确认的块单独说一句:她(和他)据此判断"要不要清了重说一遍"。
          this.unconfirmedBlocks > 0
            ? `有 ${this.unconfirmedBlocks} 块音频桥那边一直没确认收到(可能没念出去)。说话照常；他要是说没听见，可 phone_stop 清了重说。`
            : '',
          typeof noise === 'number' ? `环境噪声底约 ${noise.toFixed(0)} dBFS。` : '',
          this.tunnel ? '隧道由这一路自己看着。' : '',
        ].filter((s) => s !== '');
        return bits.join('\n');
      },
    };
  }

  // ───────────────────────── 小工具 ─────────────────────────

  private makeSegmenter(): Segmenter {
    const vad = this.opts.cfg.vad;
    return new Segmenter({
      sampleRate: EAR_RATE,
      marginDb: vad.marginDb,
      hangoverMs: vad.hangoverMs,
      minSpeechMs: vad.minSpeechMs,
      maxSegmentMs: vad.maxSegmentMs,
    });
  }

  /** 这一通的身份变了没有:从 `u_…` 变成号码就记下来。 */
  private learnIdentity(call: BridgeCall): void {
    const target = callerOf(call);
    const last = this.lastTargetByCall.get(call.id);
    if (last !== undefined && last !== target && /^u_/.test(last) && /^\d{4,}$/.test(target)) {
      this.uidToUin.set(last, target);
      this.log.info?.('记下了这个人的 uid 与号码的对应', { uid: last, uin: target });
    }
    this.lastTargetByCall.set(call.id, target);
  }

  /** 认出来是谁:报的是 uid 而我们知道它对应哪个号码时,换成号码再判名单。 */
  private resolveCaller(call: BridgeCall): BridgeCall {
    const caller = callerOf(call);
    if (!/^u_/.test(caller)) return call;
    const known = this.uidToUin.get(caller);
    if (!known) return call;
    return { ...call, callerUin: known, peerUin: call.peerUin === caller ? known : call.peerUin };
  }

  private policy(): CallPolicy {
    const cfg = this.opts.cfg;
    return {
      callers: cfg.callers,
      autoAnswer: cfg.autoAnswer,
      rejectUnknown: cfg.rejectUnknown,
      ringTimeoutSec: cfg.ringTimeoutSec,
      stuckSec: cfg.stuckSec,
    };
  }

  /** 此刻能不能跟她说话:有当前通话且已接通。 */
  private onCallNow(): boolean {
    return this.current?.phase === 'connected';
  }

  /** 她手上还有没有没放完的声音(抢话判据)。 */
  private herAudioActive(): boolean {
    return this.playback.pending || this.audioQueue.length > 0 || this.speakQueue.length > 0 || this.synthBusy || this.speakBuffer.trim() !== '';
  }

  /** 这一句要不要用 `preempt` 投(接了抢话那一脚)。 */
  private consumePreempt(): boolean {
    const value = this.preemptArmed;
    this.preemptArmed = false;
    return value;
  }

  private readToken(): string {
    const cfg = this.opts.cfg;
    if (cfg.tokenFile.trim() !== '') {
      try {
        return readFileSync(cfg.tokenFile.trim(), 'utf8').trim();
      } catch (error) {
        this.log.warn?.('读桥令牌文件失败', { error: describe(error) });
      }
    }
    return this.opts.secret(cfg.tokenSecret).trim();
  }

  /** 上游"还有一条命令没完成"这类失败连着出现的次数;够几次就认为桥卡住了。 */
  private pendingControlFailures = 0;
  private wedgeHandled = false;

  private async send(
    op: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: { code?: string; message?: string } }> {
    if (!this.bridge) return { ok: false, error: { code: 'NO_BRIDGE', message: this.bridgeNote || '桥还没建起来' } };
    // 这几个命令都要求"重发是安全的":上游对同一个 id 返回保留的回执、不重发命令。
    const reply = await this.bridge.request(op, args, { retrySameId: true });
    if (reply.ok) {
      this.pendingControlFailures = 0;
      this.wedgeHandled = false;
      return { ok: true };
    }
    const message = reply.error?.message ?? '';
    // ★ `code` 一定要落日志。2026-10-10 她挂断失败那两次,回执里只剩上游那句会误导人的
    // "Requires an exact audited QQ library…",而 `code`(CAPABILITY_UNAVAILABLE)被我丢掉了 ——
    // 结果排查时得去云上翻原始日志才认得出它不是"版本不支持"。**回执给人看,日志给排查用**,两边都要。
    this.log.warn?.('电话的控制命令失败', { op, code: reply.error?.code, message });
    if (/another control is pending|wrong phase/i.test(message)) {
      this.pendingControlFailures += 1;
      // 这就是"桥卡住了"的样子:一条命令挂在那儿没完成,后面每一道命令都发不出去。
      // 2026-10-09 实测:他因此"就打不通了" —— 唯一解套是重启 AV Host 换 bootId。
      if (this.pendingControlFailures >= 3 && !this.wedgeHandled) {
        this.wedgeHandled = true;
        void this.selfHealWedge().catch((error) => this.log.warn?.('解卡时出错', { error: describe(error) }));
      }
    }
    return { ok: false, error: reply.error };
  }

  /** 桥卡在"还有一条命令没完成"上时解套(与卡在 rejecting 一样,只有重启 AV Host 能解)。 */
  private async selfHealWedge(): Promise<void> {
    const command = this.opts.cfg.ssh.recoverCommand.trim();
    if (command === '') {
      await this.note(
        '桥卡住了:还有一条命令挂在那边没完成,后面每一道命令都被它挡住(现象是他打不通)。' +
          '这一路没配自愈命令(worlds.phone.ssh.recoverCommand),需要人工重启 AV Host。',
      );
      return;
    }
    if (!this.tunnel) {
      await this.note('桥卡住了(还有一条命令没完成),但隧道不在这一路手里,自愈命令发不出去,需要人工处理。');
      return;
    }
    const result = await this.tunnel.runRemote(command, 30000);
    await this.note(
      result.ok
        ? `桥卡住了,已经重启 AV Host 解套(${command})。下一通可以再打。`
        : `桥卡住了,自愈命令没跑成(${result.output.slice(-200) || '没有输出'}),需要人工看一眼。`,
    );
  }

  private async emit(
    type: string,
    text: string,
    trigger: 'flush' | 'preempt' | 'debounce',
    senderKey: string,
    meta?: Record<string, unknown>,
    /** 附件(目前只有响铃那条带一张来电截图)。没给就一个字都不加。 */
    blobs?: BlobInput[],
  ): Promise<void> {
    const host = this.host;
    if (!host) return;
    const external = senderKey !== 'internal';
    await host.pushEvent(
      {
        type,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: external ? 'external' : 'internal',
        senderKey,
        text,
        meta,
        ...(blobs && blobs.length > 0 ? { blobs } : {}),
      },
      { trigger },
    );
  }

  /** 内部机制的通知:桥断了、卡住了、合成失败。**不冒充外部消息**。 */
  private async note(text: string): Promise<void> {
    this.log.info?.(text);
    await this.emit('phone.notice', `【电话·机制】${text}`, 'debounce', 'internal');
  }

  /**
   * 隧道起不来时那一条。
   *
   * **同一句只报一次**:隧道会按退避反复重起,同一句 ssh 报错每次都推一遍会把她的上下文填满。
   * 措辞按原文来 —— ssh 自己的话最有诊断价值(比如"bad permissions"那句直接指出是私钥权限)。
   */
  private lastTunnelProblem = '';
  private async reportTunnelProblem(raw: string): Promise<void> {
    const text = raw.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (text === '' || text === this.lastTunnelProblem) return;
    this.lastTunnelProblem = text;
    await this.note(
      `SSH 隧道起不来,所以够不着桥:${text}` +
        '(隧道是连上云上那台机器的桥用的;这条不修,电话会一直连不上 127.0.0.1)',
    );
  }

  private dumpAudio(direction: 'in' | 'out', wav: Buffer): void {
    try {
      const dir = join(this.opts.dataDir, 'phone');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${direction}.wav`), wav);
    } catch (error) {
      this.log.warn?.('音频落盘失败', { error: describe(error) });
    }
  }
}
