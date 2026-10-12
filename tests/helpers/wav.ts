/** 测试用的音频原料:一段正弦波、以及"MiniMax 会回给我们的那种 WAV"。 */
import { pcmToWav } from '../../src/pcm.ts';

/** 一段单声道 16 位正弦。用来当"有人在说话"。 */
export function tone(ms: number, sampleRate: number, freq = 440, amplitude = 12000): Buffer {
  const frames = Math.round((sampleRate * ms) / 1000);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

/** 静音(底噪)一段。 */
export function silence(ms: number, sampleRate: number, amplitude = 0): Buffer {
  const frames = Math.round((sampleRate * ms) / 1000);
  const out = Buffer.alloc(frames * 2);
  if (amplitude > 0) for (let i = 0; i < frames; i += 1) out.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return out;
}

/** 立体声交错:把单声道复制成双声道。 */
export function stereo(mono: Buffer): Buffer {
  const frames = Math.floor(mono.length / 2);
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const v = mono.readInt16LE(i * 2);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** MiniMax 那种回执:十六进制字符串,内容是带头的 WAV。 */
export function wavHex(pcm: Buffer, sampleRate: number, channels = 1): string {
  return pcmToWav(pcm, sampleRate, channels).toString('hex');
}
