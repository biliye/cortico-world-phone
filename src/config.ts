/** config.json 的 worlds.phone 段，默认禁用；bot 或部署可启用。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

/** 本机 SenseVoice(语音识别)那一段。非流式，一句一送。 */
export interface PhoneAsrSection {
  serviceHost: string;
  servicePort: number;
  /** 送进识别服务的 language 参数；`auto` 是它的自动判。 */
  language: string;
  /** 数字转文字(`use_itn`)——电话里念数字的场景多，默认开。 */
  useItn: boolean;
  requestTimeoutMs: number;
  /** 启动时等识别服务起来的窗口；它冷启动实测要十几秒。 */
  readyWaitMs: number;
}

/** 分段(VAD)那一段。门限是**相对的**(噪声底 + marginDb)，不是写死的绝对阈值。 */
export interface PhoneVadSection {
  marginDb: number;
  hangoverMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
}

/** 嗓子(MiniMax 合成)那一段。密钥名写在这里，值住部署 .env。 */
export interface PhoneTtsSection {
  streaming?: boolean;
  apiKeySecret: string;
  endpoint: string;
  model: string;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  timeoutMs: number;
  /** 单次合成的字符上限(一个汉字算 2)；0 = 不设。 */
  maxCharsPerSay: number;
  /** 向 MiniMax 要的采样率；它不给 48000，所以这一路仍要重采样。 */
  sampleRate: number;
}

/**
 * 隧道那一段。桥**只肯绑回环**(上游 `createDaemon` 里那条硬约束)，所以出了容器就得靠隧道。
 * 默认关：只有确认这台机器能拿密钥登上去之后才该开。
 */
export interface PhoneSshSection {
  enabled: boolean;
  host: string;
  user: string;
  port: number;
  /** 私钥文件路径。密码登录撑不起无人值守，所以这条路只走密钥。 */
  keyFile: string;
  /** 本机这一头的端口(World 连的就是它)。 */
  localPort: number;
  /** 云上那一头的端口(守护进程在容器里绑的那个)。 */
  remotePort: number;
  /**
   * 云上那一头往**哪个地址**连(默认 `127.0.0.1`)。
   *
   * 桥在容器里(`--network bridge`)时,`127.0.0.1` 是宿主自己的回环、够不着容器;
   * 这时填容器地址(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <容器>`)。
   * 桥在生产那套宿主网络里(`--network host`)就保持 `127.0.0.1`。
   */
  remoteHost: string;
  /** ssh 可执行文件；Windows 自带 OpenSSH 时就是 `ssh`。 */
  exePath: string;
  /**
   * 通话卡在 `rejecting` 时用来换 bootId 的命令(在**云上**执行)。
   * 空串 = 不在 World 里自愈，只报告。
   */
  recoverCommand: string;
}

/**
 * 「她主动拨出去」那一段。
 *
 * 只打给一个人(用户定的:只打给他、不设限)。之所以是个**目标**而不是一张名单:
 * 这一路唯一的出站用途就是"她想起什么、拨给他",名单只会多出一层要维护的东西。
 * 空着 = 拨不出去(`phone_dial` 会明确说没配,不是静默失败)。
 */
export interface PhoneDialSection {
  /**
   * 拨给谁。**填 uid**(`u_…`)—— 上游那条 `dial` 帧走的是 `peerUid`
   * (`daemon.mjs` 里 `{peerUid: args.targetId}`),不是手机号。
   * 拿不准就照接听名单里那一串原样抄。
   */
  target: string;
  /** 称呼,只用于事件与工具回执里好认人;空着就用 target 本身。 */
  label: string;
}

export interface PhoneConfigSection {
  enabled: boolean;
  /** 守护进程的 WS 地址。默认指本机那一头(隧道)。 */
  bridgeUrl: string;
  /** 桥的令牌：值住部署 .env，名字写这里。 */
  tokenSecret: string;
  /** 也可以直接指一个本机文件(内容是令牌)；非空时优先读它。 */
  tokenFile: string;
  /**
   * 只接这些号打来的电话。空数组 = 谁都不接(不是"谁都接")。
   *
   * **放 UIN(手机号)还是 UID(`u_…`),看桥报的是哪个** —— 2026-10-09 实测:这套部署的 QQ
   * 能力里写着 `loginIdentityMode: uid`,来电在守护进程那条线上给的 `targetId` 就是
   * `u_xxxxxxxx…` 这种内部 id,而 UIN 要好几秒后才可能出现(有时根本不出现)。
   * 所以**两种都可以放**,拿不准就把两个都放进去(手机号 + uid)。
   */
  callers: Array<number | string>;
  /** 白名单里的人打进来就自动接起。关掉则要她调 phone_answer。 */
  autoAnswer: boolean;
  /** 非白名单直接拒，不让它响。 */
  rejectUnknown: boolean;
  /** 响铃超过这么久没人接就自动拒(只在没自动接起时有意义)。 */
  ringTimeoutSec: number;
  /** 她主动拨出去那一段。**部署里可能没有这个键**(旧配置),读的时候要容错。 */
  dial: PhoneDialSection;
  /** 通话在 rejecting 停这么久就当作卡住，报告并(若配了)自愈。 */
  stuckSec: number;
  /** 她说话时对方一开口就停下来听。 */
  bargeIn: boolean;
  /**
   * 抢话的门槛:对方的声音要**连续**响够这么久才算抢话(毫秒)。
   *
   * 起音就抢话在实测里被脉冲噪声骗过:2026-10-09 那两通里唯一一次"打断她"的
   * 是一块 **-48 dBFS、不到 400 毫秒**的响动(而且那一句最后什么都没认出来),
   * 却把她说了一半的 5.6 秒整句清掉了。真人说话最短的一句是 860 毫秒,门开在中间。
   */
  bargeInMinMs: number;
  /** **每一轮**她最多说多久(秒)；到点这一轮剩下的不念了(下一轮额度重来)，免得一次念一大段。 */
  maxSpeakSec: number;
  /** 往外发音频一帧多少毫秒。上游单帧硬上限是 1 秒。 */
  frameMs: number;
  /**
   * 一块音频等回执的上限(毫秒)。**比别的命令长得多**，理由见下。
   *
   * 2026-10-15 实测:桥自己的请求队列会**堵**(通话期间它会反复起停音频设备、重查诊断)，
   * 堵住时 `audio.write` 十几秒不给回执。而"没回执"意味着什么桥自己也说不准 ——
   * 可能收到了只是晚回，也可能压根没收到。用户定的规矩是**宁可晚、一个字都不丢**，
   * 所以这一路该多等一会儿，而不是过十几秒就把整通电话判成哑巴(那天正是这么哑掉的)。
   */
  audioWriteTimeoutMs: number;
  /** 一块音频最多重问几次。同一个 id 重问是安全的:桥按 id 记住在办的那条，不会念两遍。 */
  audioWriteRetries: number;
  /** 两次重问之间等多久(毫秒)。 */
  audioWriteRetryWaitMs: number;
  /** 清队列(`audio.clear`)最多试几次 —— 喊停这件事值得多试一次。 */
  audioClearRetries: number;
  /**
   * 她调 `phone_hangup` 之后，最多等多少毫秒把这一句说完再挂（0 = 不等，当场挂）。
   *
   * 2026-10-15 他提的：他要挂、她正在说，旧行为当场切断。现在挂断分两步 —— 工具只排队，
   * 看护等"这一轮的话说完 + 播放时间过去 + 连着安静两拍"再发真正的命令；这个数是兜底的上限，
   * 免得她一直有新话就把挂断无限推迟。
   */
  hangupGraceMs: number;
  /**
   * **接起后第一句之前**先垫多少毫秒静音(0 = 不垫)。
   *
   * 2026-10-15 他实测:第一句的开头被吞("喂，我在"只听到"我在"),而音频是完整进了声卡的
   * (逐句标记是"桥确认播放完成")⇒ 丢在 QQ 那条媒体通道刚起来的时候。垫静音是拿闲着的
   * 时间把那几帧暖掉,而不是拿她的第一个字去暖。静音垫在**同一帧**里,不会多开播放流。
   */
  warmupMs: number;
  /** 桥重连的退避起点与上限(毫秒)。 */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** 把过手的音频落盘(诊断用)；默认关，通话音频不该留在盘上。 */
  logAudio: boolean;
  asr: PhoneAsrSection;
  vad: PhoneVadSection;
  tts: PhoneTtsSection;
  ssh: PhoneSshSection;
}

export const PHONE_DEFAULTS: PhoneConfigSection = {
  enabled: false,
  bridgeUrl: 'ws://127.0.0.1:6120/v1/stream',
  tokenSecret: 'PHONE_BRIDGE_TOKEN',
  tokenFile: '',
  callers: [],
  autoAnswer: true,
  rejectUnknown: true,
  ringTimeoutSec: 30,
  stuckSec: 20,
  dial: { target: '', label: '' },
  bargeIn: true,
  bargeInMinMs: 500,
  maxSpeakSec: 30,
  frameMs: 400,
  audioWriteTimeoutMs: 30000,
  audioWriteRetries: 2,
  audioWriteRetryWaitMs: 2000,
  audioClearRetries: 2,
  warmupMs: 300,
  hangupGraceMs: 12000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  logAudio: false,
  asr: {
    serviceHost: '127.0.0.1',
    servicePort: 50001,
    language: 'auto',
    useItn: true,
    requestTimeoutMs: 8000,
    readyWaitMs: 20000,
  },
  vad: {
    marginDb: 9,
    hangoverMs: 700,
    minSpeechMs: 400,
    maxSegmentMs: 15000,
  },
  tts: {
    streaming: true,
    apiKeySecret: 'MINIMAX_API_KEY',
    endpoint: 'https://api.minimax.chat/v1/t2a_v2',
    model: 'speech-2.8-turbo',
    voiceId: '',
    speed: 1,
    vol: 1,
    pitch: 0,
    timeoutMs: 15000,
    maxCharsPerSay: 200,
    sampleRate: 32000,
  },
  ssh: {
    enabled: false,
    host: '',
    user: 'root',
    port: 22,
    keyFile: '',
    localPort: 6120,
    remotePort: 6120,
    remoteHost: '127.0.0.1',
    exePath: 'ssh',
    recoverCommand: '',
  },
};

/** World 配置的 JSON Schema 声明。隧道那段的嵌套不逐个列旋钮，免得表单长到没人看。 */
export const PHONE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:phone',
  owner: 'world:phone',
  schema: {
    type: 'object',
    title: '电话',
    properties: {
      'worlds.phone.bridgeUrl': {
        type: 'string',
        title: '桥地址',
        description: '守护进程的 WebSocket 地址；默认指本机(隧道)那一头。',
        'x-hot': false,
      },
      'worlds.phone.tokenSecret': {
        type: 'string',
        title: '桥令牌的环境变量名',
        description: '令牌值住部署 .env，这里只写名字。',
        'x-hot': false,
      },
      'worlds.phone.tokenFile': {
        type: 'string',
        title: '桥令牌文件',
        description: '填了就从这个本机文件读令牌，优先于环境变量。',
        'x-hot': false,
      },
      // ⚠️ `callers`(接听名单)**故意不在这里声明**:框架的 `type:'array'` 不是通用列表 ——
      // `readGroupValues` 会把它强制成 `[数, 数]` 这一对,写入侧还要求长度必须等于 2
      // (`config-schema.ts` 的 `needsPair`)。把白名单挂进表单只会被压成 `[号, 0]`。
      // 与 mouse 的 `screens`/`extraBlocked`/`clipRoots` 同一条规矩:**列表只从 config.json 改**。
      'worlds.phone.autoAnswer': {
        type: 'boolean',
        title: '白名单自动接起',
        description: '关上就要她自己调 phone_answer。',
        'x-hot': true,
      },
      'worlds.phone.rejectUnknown': {
        type: 'boolean',
        title: '非白名单直接拒',
        description: '不让陌生号有机会占线。',
        'x-hot': true,
      },
      'worlds.phone.ringTimeoutSec': {
        type: 'integer',
        title: '响铃超时(秒)',
        description: '没人接就自动拒；只在没自动接起时有意义。',
        'x-hot': true,
      },
      'worlds.phone.stuckSec': {
        type: 'integer',
        title: '卡住判定(秒)',
        description: '通话在 rejecting 停这么久算卡住。',
        'x-hot': true,
      },
      'worlds.phone.dial.target': {
        type: 'string',
        title: '她能拨给谁',
        description: '填 uid(u_…),不是手机号;留空则 phone_dial 拨不出去。',
        'x-hot': true,
      },
      'worlds.phone.dial.label': {
        type: 'string',
        title: '拨号目标的称呼',
        description: '只用在事件正文与工具回执里;留空就用上面那串本身。',
        'x-hot': true,
      },
      'worlds.phone.bargeIn': {
        type: 'boolean',
        title: '允许插嘴',
        description: '对方一开口就停下来听。',
        'x-hot': true,
      },
      'worlds.phone.bargeInMinMs': {
        type: 'integer',
        title: '插嘴门槛(毫秒)',
        description: '对方要连着响够这么久才算插嘴；调小更容易被打断(噪声也能打断)，调大更不容易。',
        'x-hot': true,
      },
      'worlds.phone.maxSpeakSec': {
        type: 'integer',
        title: '她一次最多说多少秒',
        description: '每一轮的额度:到点这一轮剩下的不念了(下一轮重来)。',
        'x-hot': true,
      },
      'worlds.phone.frameMs': {
        type: 'integer',
        title: '发声帧长(毫秒)',
        description: '往外发音频的切片长度；上游单帧硬上限 1000。',
        'x-hot': false,
      },
      'worlds.phone.logAudio': {
        type: 'boolean',
        title: '把音频落盘',
        description: '诊断用，默认关。',
        'x-hot': true,
      },
      'worlds.phone.asr.servicePort': {
        type: 'integer',
        title: '识别服务端口',
        description: '本机 SenseVoice 的 HTTP 口。',
        'x-hot': true,
      },
      'worlds.phone.asr.language': {
        type: 'string',
        title: '识别语言',
        description: 'auto / zh / en …',
        'x-hot': true,
      },
      'worlds.phone.asr.useItn': {
        type: 'boolean',
        title: '数字转文字',
        description: '把「一二三」归成「123」。',
        'x-hot': true,
      },
      'worlds.phone.vad.marginDb': {
        type: 'number',
        title: '起音门限(高于噪声底多少 dB)',
        description: '环境静就调小，环境吵就调大。',
        'x-hot': true,
      },
      'worlds.phone.vad.hangoverMs': {
        type: 'integer',
        title: '静音收句(毫秒)',
        description: '说完这么久没声就送去识别。',
        'x-hot': true,
      },
      'worlds.phone.tts.voiceId': {
        type: 'string',
        title: '音色',
        description: 'MiniMax 的 voice_id；空着合成会失败并告诉你。',
        'x-hot': true,
      },
      'worlds.phone.tts.streaming': {
        type: 'boolean',
        title: '流式语音合成',
        description: '收到音频块就开始发送；关闭可退回整句 WAV 兼容模式。',
        'x-hot': true,
      },
      'worlds.phone.tts.speed': {
        type: 'number',
        title: '语速',
        'x-hot': true,
      },
      'worlds.phone.tts.maxCharsPerSay': {
        type: 'integer',
        title: '一次说话的字数上限',
        description: '一个汉字算 2 个字符；0 = 不设。',
        'x-hot': true,
      },
      'worlds.phone.ssh.enabled': {
        type: 'boolean',
        title: '自己拉起 SSH 隧道',
        description: '这台机器能用密钥登进云上那台时才开。',
        'x-hot': false,
      },
      'worlds.phone.ssh.host': {
        type: 'string',
        title: '隧道主机',
        'x-hot': false,
      },
      'worlds.phone.ssh.user': {
        type: 'string',
        title: '隧道用户',
        'x-hot': false,
      },
      'worlds.phone.ssh.keyFile': {
        type: 'string',
        title: '私钥文件',
        description: '密码登录撑不起无人值守，这条路只走密钥。',
        'x-hot': false,
      },
      'worlds.phone.ssh.localPort': {
        type: 'integer',
        title: '本机端口',
        'x-hot': false,
      },
      'worlds.phone.ssh.remotePort': {
        type: 'integer',
        title: '云上端口',
        'x-hot': false,
      },
      'worlds.phone.ssh.remoteHost': {
        type: 'string',
        title: '云上那一头连的地址',
        description: '默认 127.0.0.1;桥在容器里时填容器的地址。',
        'x-hot': false,
      },
      'worlds.phone.ssh.recoverCommand': {
        type: 'string',
        title: '卡死自愈命令',
        description: '在云上执行；空着则只报告不自愈。',
        'x-hot': true,
      },
    },
  },
};

/** 白名单里的电话号码；UIN 是数字，但配置里可能被写成字符串，两种都认。 */
export function callerAllowed(callers: readonly unknown[], uin: string): boolean {
  const want = uin.trim();
  if (want === '') return false;
  return callers.some((item) => String(item).trim() === want);
}

/**
 * 读拨号目标。**必须是容错的**:这一格是后加的,而他部署里那份 `config.json`
 * 是在这之前写的(键根本不存在),直接读 `cfg.dial.target` 会在这里崩掉整通启动。
 * 所以缺键、写成别的类型、留空,一律当"没配"。
 */
export function dialTarget(cfg: { dial?: Partial<PhoneDialSection> } | undefined): { target: string; label: string } {
  const raw = cfg?.dial;
  const target = typeof raw?.target === 'string' ? raw.target.trim() : '';
  const label = typeof raw?.label === 'string' ? raw.label.trim() : '';
  return { target, label: label || target };
}
