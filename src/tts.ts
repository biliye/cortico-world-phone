/**
 * 嗓子:MiniMax 的文字→音频。与 pet / qq2 同源,只有一处不同 —— **要的是裸 PCM**。
 *
 * 为什么不要 mp3:这一路的终点是桥的 `audio.write`,它只吃 `pcm_s16le`。
 * 要 mp3 就得在这台机器上解码一次(mp3 解码器不是 Node 自带的),白加一个依赖与一次解码。
 *
 * 为什么要 `wav` 而不是 `pcm`:MiniMax 的 `pcm` 是**没有元信息**的裸流 ——
 * 采样率、位深、声道全靠我们自己假设。它要是哪天改了位深,我们听上去只是"声音怪",
 * 不会报错。`wav` 自带头,采样率与声道从文件里读出来,不猜。
 */
import { describe, type VoiceLoggerLike } from './util.ts';
import { billableChars } from './sentences.ts';
import { downmixToMono, parseWav, resampleMono } from './pcm.ts';

export interface TtsSettings {
  /** 密钥的环境变量名，只用来在报错时把话说明白。 */
  apiKeySecret: string;
  endpoint: string;
  model: string;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  timeoutMs: number;
  maxCharsPerSay: number;
  /** 向 MiniMax 要的采样率(它不给 48000)。 */
  sampleRate: number;
}

export interface TtsOk {
  ok: true;
  /** 单声道 16 位小端、已经重采样到 `targetRate` 的 PCM。 */
  pcm: Buffer;
  sampleRate: number;
  ms: number;
  chars: number;
}

export interface TtsFail {
  ok: false;
  kind: 'config' | 'too-long' | 'api' | 'network';
  /** 给她的回执原文(她会照着这句决定下一步)。 */
  error: string;
  detail?: string;
}

export type TtsResult = TtsOk | TtsFail;

export interface TtsDeps {
  settings: TtsSettings;
  /** 密钥;空串 = 没配(回执里要说清缺什么)。 */
  apiKey: string;
  /** 最终要交给桥的采样率(与 bridge.json 的 sampleRate 一致)。 */
  targetRate: number;
  fetchImpl?: typeof fetch;
  log?: VoiceLoggerLike;
}

interface MiniMaxResponse {
  data?: { audio?: unknown } | null;
  extra_info?: { audio_length?: unknown } | null;
  base_resp?: { status_code?: unknown; status_msg?: unknown } | null;
}

/**
 * 合成一句话并交回目标采样率的单声道 PCM。
 * **不抛错**:每一种失败都变成一条能直接念给她听的 `error`。
 */
export async function synthesizePcm(text: string, deps: TtsDeps): Promise<TtsResult> {
  const { settings } = deps;

  if (deps.apiKey.trim() === '') {
    return {
      ok: false,
      kind: 'config',
      error: `没配 MiniMax 的密钥:往部署的 .env 里加一行 ${settings.apiKeySecret}=<你的 key> 再重启进程。`,
    };
  }
  if (settings.voiceId.trim() === '') {
    return {
      ok: false,
      kind: 'config',
      error: '没配音色:worlds.phone.tts.voiceId 要填一个 MiniMax 的 voice_id,否则合成一定失败。',
    };
  }

  const chars = billableChars(text);
  if (settings.maxCharsPerSay > 0 && chars > settings.maxCharsPerSay) {
    return {
      ok: false,
      kind: 'too-long',
      error: `这句话按账单口径算 ${chars} 个字符,超过单次上限 ${settings.maxCharsPerSay}。拆短一点再说。`,
    };
  }

  const body = {
    model: settings.model,
    text,
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: settings.voiceId,
      speed: settings.speed,
      vol: settings.vol,
      pitch: settings.pitch,
    },
    audio_setting: { sample_rate: settings.sampleRate, format: 'wav', channel: 1 },
  };

  const doFetch = deps.fetchImpl ?? fetch;
  let payload: MiniMaxResponse;
  let http = 0;
  try {
    const res = await doFetch(settings.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, settings.timeoutMs)),
    });
    http = res.status;
    payload = (await res.json()) as MiniMaxResponse;
  } catch (error) {
    const reason = describe(error);
    deps.log?.warn?.('合成请求没走通', { reason });
    return {
      ok: false,
      kind: 'network',
      error: `没做到:MiniMax 那边没连上(${reason})。联网或代理不通时会这样,过一会儿再试。`,
      detail: reason,
    };
  }

  // HTTP 200 不代表业务成功:成败以 base_resp.status_code 为准(官方文档明说)。
  const code = Number(payload?.base_resp?.status_code ?? NaN);
  if (code !== 0) {
    const msg = String(payload?.base_resp?.status_msg ?? '没给原因');
    deps.log?.warn?.('MiniMax 拒了这一句', { code, msg, http });
    return {
      ok: false,
      kind: 'api',
      error: `没做到:MiniMax 回了错误 ${Number.isFinite(code) ? code : http}:${msg}。`,
      detail: `${code} ${msg}`,
    };
  }

  const hex = payload?.data?.audio;
  if (typeof hex !== 'string' || hex.trim() === '') {
    return { ok: false, kind: 'api', error: '没做到:MiniMax 的回执里没有音频。', detail: 'data.audio missing' };
  }

  const bytes = Buffer.from(hex, 'hex');
  const wav = parseWav(bytes);
  if (!wav) {
    // 这条主要是防"它换了一种我们没读过的封装":与其把一段看不懂的字节当 PCM 播放,
    // 不如明确说"读不出格式",这样问题在回执里就能看见,而不是变成电话那头的一声怪响。
    return {
      ok: false,
      kind: 'api',
      error: `没做到:MiniMax 回的音频读不出格式(${bytes.length} 字节,不是 16 位 WAV)。`,
      detail: `wav parse failed, bytes=${bytes.length}`,
    };
  }

  // 交叉核对:它自报的时长与字节数应当对得上。对不上说明我们读错了格式。
  const selfMs = Math.max(0, Math.round(Number(payload?.extra_info?.audio_length ?? 0)) || 0);
  const actualMs = (wav.pcm.length / 2 / wav.sampleRate) * 1000;
  if (selfMs > 0 && Math.abs(actualMs - selfMs) > Math.max(200, selfMs * 0.2)) {
    return {
      ok: false,
      kind: 'api',
      error: `没做到:MiniMax 自报 ${selfMs} 毫秒,按文件头算出来是 ${Math.round(actualMs)} 毫秒,对不上,不敢播。`,
      detail: `audio_length=${selfMs} computed=${Math.round(actualMs)} rate=${wav.sampleRate} bits=${wav.bitsPerSample}`,
    };
  }

  // wav 是自描述的自述格式,但声道数仍要按文件头说的来(它给 mono,这里不假设)。
  const mono = downmixToMono(wav.pcm, wav.channels);
  const pcm = resampleMono(mono, wav.sampleRate, deps.targetRate);
  if (pcm.length < 1024) {
    // 几百字节不可能是这句话的音频;当真写下去只会让桥那边播出一声爆音。
    return {
      ok: false,
      kind: 'api',
      error: `没做到:MiniMax 回的音频只有 ${pcm.length} 字节,不像一句话,丢掉。`,
      detail: `audio too small: ${pcm.length}`,
    };
  }

  deps.log?.info?.('合成好了', { chars, bytes: pcm.length, rate: deps.targetRate, voice: settings.voiceId });
  return { ok: true, pcm, sampleRate: deps.targetRate, ms: (pcm.length / 2 / deps.targetRate) * 1000, chars };
}
