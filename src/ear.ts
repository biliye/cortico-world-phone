/**
 * 耳朵:把桥推来的音频切成"一句一句",送去本机 SenseVoice。
 *
 * 分段器**与 hearing 包同源**(`cortico-world-hearing/src/vad.ts`)。照抄那份而不是
 * 自己重写,是因为它的两个关键判断是实测出来的,重写一遍等于把那些坑再踩一次:
 *
 * - **门限跟着噪声底走**(噪声底 + marginDb),不写死绝对值。写死的阈值换个房间、
 *   换个增益就废;电话这一路的音量还取决于 QQ 与 pulse 的增益,更飘。
 * - **噪声底只在非语音帧更新**。说话时也更新的话,她自己的声音会把门限越顶越高,
 *   后半句被判成静音。
 *
 * 唯一与 hearing 不同的是**去向**:那边投给她当"听见了",这边是电话里对方在说话。
 */

export interface SpeechSegment {
  /** 16 位小端单声道 PCM */
  pcm: Buffer;
  durationMs: number;
}

export interface SegmenterOptions {
  sampleRate: number;
  frameMs?: number;
  marginDb?: number;
  hangoverMs?: number;
  minSpeechMs?: number;
  maxSegmentMs?: number;
  tailMs?: number;
}

const DEFAULT_FRAME_MS = 20;
/** 起音要连续这么多帧确认，挡掉单个脉冲噪声 */
const ONSET_FRAMES = 3;
/** 噪声底 EMA 的更新系数：越小越稳，越大越跟手 */
const NOISE_ALPHA = 0.05;
/** 算 dB 时垫在底下的极小值，防止 log(0) */
const DB_FLOOR = 1e-9;
/**
 * 噪声底的下限（dBFS）。设备被静音时会送全零，噪声底一路掉到 -180 dB，
 * 门限跟着塌下去，之后任何一点响动都被判成说话。低于 -75 dBFS 那不是环境噪声，是数字静音。
 */
const NOISE_FLOOR_MIN_DB = -75;
/** 句尾默认保留的拖尾长度。收句靠的是静音窗口，但那段时间不算进"说了多久"。 */
const DEFAULT_TAIL_MS = 200;

/** 一帧的均方根，转成 dBFS（满量程 0 dB）。 */
export function frameDb(frame: Buffer): number {
  const count = frame.length >> 1;
  if (count === 0) return -120;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const value = frame.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return 20 * Math.log10(Math.sqrt(sum / count) + DB_FLOOR);
}

export class Segmenter {
  private readonly sampleRate: number;
  private readonly frameBytes: number;
  private readonly frameMs: number;
  private readonly marginDb: number;
  private readonly onsetFrames = ONSET_FRAMES;
  private readonly releaseFrames: number;
  private readonly minDurationMs: number;
  private readonly maxDurationMs: number;
  private readonly tailBytes: number;

  private pending: Buffer = Buffer.alloc(0);
  private noiseFloorDb: number | null = null;
  private inSpeech = false;
  private frames: Buffer[] = [];
  private segmentBytes = 0;
  /** 最后一个有声帧之后的累计字节数，用来把拖尾静音裁掉。 */
  private lastLoudBytes = 0;
  private aboveCount = 0;
  private belowCount = 0;

  constructor(options: SegmenterOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    this.frameBytes = Math.max(2, Math.round((options.sampleRate * this.frameMs) / 1000) * 2);
    this.marginDb = options.marginDb ?? 9;
    this.releaseFrames = Math.max(1, Math.ceil((options.hangoverMs ?? 700) / this.frameMs));
    this.minDurationMs = options.minSpeechMs ?? 400;
    this.maxDurationMs = options.maxSegmentMs ?? 25000;
    this.tailBytes = Math.round(((options.tailMs ?? DEFAULT_TAIL_MS) / 1000) * options.sampleRate) * 2;
  }

  /** 当前估计的噪声底（dBFS）；还没测出来时是 null。给状态与日志看。 */
  get noiseFloor(): number | null {
    return this.noiseFloorDb;
  }

  /** 现在是不是正在录一句话。**抢话就靠它**——不等转写，一起音就停。 */
  get speaking(): boolean {
    return this.inSpeech;
  }

  /**
   * 此刻的过门限电平(dBFS)：噪声底(夹在 -75)+ marginDb。
   * 外面要判"这一块到底是不是人声"时用它 —— 别拿 `speaking`,那个带 trailing 拖尾。
   */
  get threshold(): number {
    return (this.noiseFloorDb ?? NOISE_FLOOR_MIN_DB) + this.marginDb;
  }

  /** 喂一块 PCM，返回这一步凑齐的所有完整句子（通常是 0 或 1 条）。 */
  push(chunk: Buffer): SpeechSegment[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const done: SpeechSegment[] = [];
    let offset = 0;
    while (this.pending.length - offset >= this.frameBytes) {
      const frame = this.pending.subarray(offset, offset + this.frameBytes);
      offset += this.frameBytes;
      const segment = this.consume(frame);
      if (segment) done.push(segment);
    }
    this.pending = offset > 0 ? Buffer.from(this.pending.subarray(offset)) : this.pending;
    return done;
  }

  /** 流断了：把手里没说完的半句也交出来（够长的话）。 */
  flush(): SpeechSegment[] {
    if (!this.inSpeech) return [];
    const segment = this.close();
    return segment ? [segment] : [];
  }

  /**
   * 把手上攒的音频丢掉，一句都不交出来；`noiseFloorDb` 保留。
   *
   * 与 hearing 那份同一个理由:**保留噪声底是要紧的**。新建一个 Segmenter 会让门限从零
   * 开始,而冷启动头几帧 `门限 = 当前帧 + marginDb` 恒不成立,于是"一开始就在说话"会被
   * 整段吞掉。电话这一路每次接起都要 reset,踩这一脚的概率比 hearing 高得多。
   */
  reset(): void {
    this.pending = Buffer.alloc(0);
    this.frames = [];
    this.segmentBytes = 0;
    this.lastLoudBytes = 0;
    this.inSpeech = false;
    this.aboveCount = 0;
    this.belowCount = 0;
  }

  private consume(frame: Buffer): SpeechSegment | null {
    const db = frameDb(frame);

    if (!this.inSpeech) {
      const measured = Math.max(db, NOISE_FLOOR_MIN_DB);
      this.noiseFloorDb =
        this.noiseFloorDb === null ? measured : this.noiseFloorDb * (1 - NOISE_ALPHA) + measured * NOISE_ALPHA;
    }
    const threshold = (this.noiseFloorDb ?? db) + this.marginDb;
    const loud = db > threshold;

    if (!this.inSpeech) {
      if (!loud) {
        this.aboveCount = 0;
        this.frames = [];
        this.segmentBytes = 0;
        return null;
      }
      this.frames.push(Buffer.from(frame));
      this.segmentBytes += frame.length;
      this.lastLoudBytes = this.segmentBytes;
      this.aboveCount += 1;
      if (this.aboveCount >= this.onsetFrames) {
        this.inSpeech = true;
        this.belowCount = 0;
      }
      return null;
    }

    this.frames.push(Buffer.from(frame));
    this.segmentBytes += frame.length;
    if (loud) this.lastLoudBytes = this.segmentBytes;
    this.belowCount = loud ? 0 : this.belowCount + 1;

    const durationMs = (this.segmentBytes / 2 / this.sampleRate) * 1000;
    if (durationMs >= this.maxDurationMs || this.belowCount >= this.releaseFrames) {
      return this.close();
    }
    return null;
  }

  private close(): SpeechSegment | null {
    const all = Buffer.concat(this.frames);
    const keep = Math.min(all.length, this.lastLoudBytes + this.tailBytes);
    const pcm = all.subarray(0, keep);
    const durationMs = (pcm.length / 2 / this.sampleRate) * 1000;
    this.frames = [];
    this.segmentBytes = 0;
    this.lastLoudBytes = 0;
    this.inSpeech = false;
    this.aboveCount = 0;
    this.belowCount = 0;
    return durationMs >= this.minDurationMs ? { pcm, durationMs } : null;
  }
}

/** 识别服务的回执（只取我们要的两个字段）。 */
export interface AsrResponse {
  text?: string;
  event?: string;
}

export interface AsrSettings {
  serviceHost: string;
  servicePort: number;
  language: string;
  useItn: boolean;
  requestTimeoutMs: number;
}

/**
 * 把一句音频送去转写。**不抛错**：失败返回 null，调用方照旧过自己的日子
 * (电话里丢一句比炸掉整通电话轻)。
 */
export async function transcribe(
  wav: Buffer,
  settings: AsrSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<AsrResponse | null> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
  form.append('language', settings.language || 'auto');
  form.append('use_itn', String(settings.useItn));
  // 我们已经分好段了，明确告诉服务别再切一次，免得它的 VAD 把句边界改掉。
  form.append('vad', 'false');
  try {
    const res = await fetchImpl(`http://${settings.serviceHost}:${settings.servicePort}/asr`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(Math.max(1000, settings.requestTimeoutMs)),
    });
    if (!res.ok) return null;
    return (await res.json()) as AsrResponse;
  } catch {
    return null;
  }
}

/**
 * 正文里有没有"话"——至少要有一个字母或数字。
 *
 * 纯乐器、掌声这类段，SenseVoice 的正文里只剩一个记号：funasr 的
 * `rich_transcription_postprocess` 会把 `<|BGM|>` 印成 `🎼`、`<|nospeech|>` 印成 `❓`，
 * 一个字都没有。这种段投给她只是噪声，也白花钱，所以在送出去之前丢掉。
 * 判断**不写死 emoji 清单**：凡是"一个字母/数字都没有"的正文都算没有话。
 */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** 汉字(含扩展 A 与兼容区)。判断"这句是不是中文"用它。 */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text);
}

/** 日文假名 / 韩文谚文:一场中文对话里出现它们,只可能是识别猜错了。 */
const KANA_OR_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/u;

/**
 * 这一句的正文**不像这一通该说的话**吗(该当"没听清",而不是当他说的话投给她)。
 *
 * 为什么要有这一条:QQ/AVSDK 把他那侧的声音送成**碎片**时,识别服务会拿碎片去猜语言,
 * `auto` 下实测出过 `Yeah.` / `やて。` / `그.` 这种 —— 一个字都不是他说的,却会被当成
 * 正文投给她、写进通话记录。**猜错的语言比"没听清"更坏**:她会照着回一句牛头不对马嘴的话。
 *
 * 判据刻意**只取高精确度的那两种**,宁可漏也不误杀真人话:
 * 1. 出现假名或谚文 —— 中文电话里不可能,一定是猜错;
 * 2. 明确配了中文(`zh…`)而正文里**一个汉字都没有** —— 也不是他说的话。
 *
 * **不猜 `auto` 下的拉丁文**:`OK`、`Yeah` 这种短词本身可能是他真说的(她也可能这么说),
 * 拿"短"去判会把真话误杀。`auto` 落在这条判据外 —— 要让这一层生效,把
 * `worlds.phone.asr.language` 配成 `zh`。
 */
export function looksLikeWrongLanguage(text: string, language: string): boolean {
  if (!hasWords(text)) return false;
  if (KANA_OR_HANGUL.test(text)) return true;
  const lang = (language || 'auto').trim().toLowerCase();
  if (lang.startsWith('zh')) return !hasCjk(text);
  return false;
}
