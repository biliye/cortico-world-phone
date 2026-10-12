/**
 * 采样率与声道的换算**只在这一处**负责。
 *
 * 沿用 mouse 包那条习惯("坐标只有一个地方负责"):桥那一头是 48000/双声道交错,
 * 耳朵那头要 16000/单声道,嗓子那头 MiniMax 最多给 32000 且是单声道。
 * 三处各写一遍重采样,迟早有一处算错而另外两处看着都对 —— 所以换算全收在这里,
 * 别的模块只许调这里的函数。
 *
 * 一律 16 位小端(`pcm_s16le`),没有别的样本格式;真出现了就得在这里明说、别在别处猜。
 */

/** 每个样本的字节数。 */
const SAMPLE_BYTES = 2;

/** 交错多声道 → 单声道(按声道求平均)。 */
export function downmixToMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / (SAMPLE_BYTES * channels));
  const out = Buffer.alloc(frames * SAMPLE_BYTES);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((i * channels + c) * SAMPLE_BYTES);
    // 先整除再写:平均值落在 int16 范围内，直接取整比先浮点再转更省事也更稳。
    out.writeInt16LE(Math.round(sum / channels), i * SAMPLE_BYTES);
  }
  return out;
}

/** 单声道 → 交错多声道(复制同一份样本)。 */
export function toChannels(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / SAMPLE_BYTES);
  const out = Buffer.alloc(frames * SAMPLE_BYTES * channels);
  for (let i = 0; i < frames; i += 1) {
    const value = pcm.readInt16LE(i * SAMPLE_BYTES);
    for (let c = 0; c < channels; c += 1) out.writeInt16LE(value, (i * channels + c) * SAMPLE_BYTES);
  }
  return out;
}

/**
 * 单声道重采样(线性插值)。
 *
 * 线性插值对**说话**够用:16k↔48k 这个比例上它引入的误差在语音频段里听不出来,
 * 而真正的代价是"要不要为它拉一个 ffmpeg 子进程"——那要起进程(约几十毫秒)且要
 * 保证目标机上有 ffmpeg。这条路是打电话,每句话都多几十毫秒不划算,所以自己算。
 *
 * 两端采样率相同时原样返回(不复制),调用方不必特判。
 */
export function resampleMono(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return pcm;
  const inFrames = Math.floor(pcm.length / SAMPLE_BYTES);
  if (inFrames === 0) return Buffer.alloc(0);
  const outFrames = Math.max(1, Math.round((inFrames * toRate) / fromRate));
  const out = Buffer.alloc(outFrames * SAMPLE_BYTES);
  const ratio = (inFrames - 1) / Math.max(1, outFrames - 1);
  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const frac = pos - i0;
    const a = pcm.readInt16LE(i0 * SAMPLE_BYTES);
    const b = pcm.readInt16LE(i1 * SAMPLE_BYTES);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * SAMPLE_BYTES);
  }
  return out;
}

/** 按毫秒把一段 PCM 切成若干片；最后一片可以短于 frameMs。 */
export function sliceFrames(pcm: Buffer, sampleRate: number, channels: number, frameMs: number): Buffer[] {
  const bytes = Math.max(2 * channels, Math.round((sampleRate * frameMs) / 1000) * SAMPLE_BYTES * channels);
  // 桥那一头要求长度是 2*channels 的整数倍；片长按帧对齐，天然满足。
  const out: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += bytes) {
    const slice = pcm.subarray(offset, Math.min(pcm.length, offset + bytes));
    // 尾巴只有半个样本就丢掉——它连一个样本都凑不齐，写过去只会被桥拒。
    const usable = slice.length - (slice.length % (SAMPLE_BYTES * channels));
    if (usable > 0) out.push(Buffer.from(slice.subarray(0, usable)));
  }
  return out;
}

/** 峰值(0..32768)。用来在工具回执与日志里说"声音到底有没有过来"。 */
export function peak(pcm: Buffer): number {
  let max = 0;
  for (let i = 0; i + 1 < pcm.length; i += SAMPLE_BYTES) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > max) max = v;
  }
  return max;
}

/** 一段 PCM 的毫秒数。 */
export function durationMs(pcm: Buffer, sampleRate: number, channels = 1): number {
  const frames = pcm.length / SAMPLE_BYTES / Math.max(1, channels);
  return (frames / sampleRate) * 1000;
}

/** 给裸 PCM 套一个 WAV 头——识别服务收的是文件，所以得包一层。 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * SAMPLE_BYTES, 28);
  header.writeUInt16LE(channels * SAMPLE_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

/**
 * 读一个 WAV。
 *
 * 为什么要自己解而不是"反正知道是多少":MiniMax 回给我们的音频是**它说了算**的,
 * 采样率、位深、声道都可能变。对着一个自己假设的格式去重采样,错了听上去只是"声音怪",
 * 不报错。所以这里从文件头读事实,读不出来就返回 null 让调用方明确失败。
 */
export function parseWav(bytes: Buffer): WavData | null {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let format: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + size));
    }
    // chunk 按偶数字节对齐，奇数长度要补一字节。
    offset = body + size + (size % 2);
  }
  if (!format || !data || format.bitsPerSample !== 16 || format.channels < 1) return null;
  return { ...format, pcm: data };
}
