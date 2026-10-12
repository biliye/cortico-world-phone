import { describe, expect, it } from 'vitest';
import {
  downmixToMono,
  durationMs,
  parseWav,
  pcmToWav,
  peak,
  resampleMono,
  sliceFrames,
  toChannels,
} from '../src/pcm.ts';
import { silence, stereo, tone } from './helpers/wav.ts';

describe('pcm:声道', () => {
  it('下混:左右不同时取平均', () => {
    const interleaved = Buffer.alloc(8);
    interleaved.writeInt16LE(1000, 0);
    interleaved.writeInt16LE(3000, 2);
    interleaved.writeInt16LE(-1000, 4);
    interleaved.writeInt16LE(1000, 6);
    const mono = downmixToMono(interleaved, 2);
    expect(mono.length).toBe(4);
    expect(mono.readInt16LE(0)).toBe(2000);
    expect(mono.readInt16LE(2)).toBe(0);
  });

  it('复制成双声道时两个声道一模一样', () => {
    const mono = Buffer.alloc(4);
    mono.writeInt16LE(1234, 0);
    mono.writeInt16LE(-2345, 2);
    const doubled = toChannels(mono, 2);
    expect(doubled.length).toBe(8);
    expect(doubled.readInt16LE(0)).toBe(1234);
    expect(doubled.readInt16LE(2)).toBe(1234);
    expect(doubled.readInt16LE(6)).toBe(-2345);
  });

  it('单声道进来时原样返回(不做无谓的复制)', () => {
    const mono = tone(10, 16000);
    expect(downmixToMono(mono, 1)).toBe(mono);
    expect(toChannels(mono, 1)).toBe(mono);
  });
});

describe('pcm:重采样', () => {
  it('16k→48k 的长度是 3 倍,48k→16k 是 1/3', () => {
    const at16 = tone(100, 16000);
    const up = resampleMono(at16, 16000, 48000);
    expect(Math.abs(up.length - at16.length * 3)).toBeLessThanOrEqual(2);
    const back = resampleMono(up, 48000, 16000);
    expect(Math.abs(back.length - at16.length)).toBeLessThanOrEqual(2);
  });

  it('两端相同则原样返回同一个对象', () => {
    const pcm = tone(10, 48000);
    expect(resampleMono(pcm, 48000, 48000)).toBe(pcm);
  });

  it('直流也能插值对:一段常量重采样后还是那个常量', () => {
    const flat = Buffer.alloc(300);
    for (let i = 0; i < 150; i += 1) flat.writeInt16LE(8000, i * 2);
    const up = resampleMono(flat, 16000, 32000);
    for (let i = 0; i < up.length / 2; i += 1) expect(up.readInt16LE(i * 2)).toBe(8000);
  });

  it('空输入不炸', () => {
    expect(resampleMono(Buffer.alloc(0), 48000, 16000).length).toBe(0);
  });
});

describe('pcm:切片', () => {
  it('按毫秒切,每片长度对齐 2*声道,单片不超过 1 秒这个上游硬上限', () => {
    const oneSecond = tone(1000, 48000);
    const stereoPcm = toChannels(oneSecond, 2);
    const frames = sliceFrames(stereoPcm, 48000, 2, 400);
    // 1 秒 = 192000 字节;400 毫秒一片 = 76800 → 两片整的加一片 38400 的尾巴。
    expect(frames.length).toBe(3);
    for (const frame of frames) {
      expect(frame.length % 4).toBe(0);
      expect(frame.length).toBeLessThanOrEqual(48000 * 2 * 2);
    }
    expect(frames[0]!.length).toBe(76800);
    expect(frames[1]!.length).toBe(76800);
    expect(frames[2]!.length).toBe(38400);
  });

  it('切不整时丢掉凑不满一个样本的尾巴,而不是写过去被桥拒', () => {
    const odd = Buffer.concat([tone(20, 48000), Buffer.from([1, 2, 3])]);
    const frames = sliceFrames(toChannels(odd, 2), 48000, 2, 1000);
    for (const frame of frames) expect(frame.length % 4).toBe(0);
  });
});

describe('pcm:WAV', () => {
  it('包头写对、解回来还是那些字节', () => {
    const pcm = tone(50, 16000);
    const wav = pcmToWav(pcm, 16000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    const parsed = parseWav(wav);
    expect(parsed?.sampleRate).toBe(16000);
    expect(parsed?.channels).toBe(1);
    expect(parsed?.bitsPerSample).toBe(16);
    expect(parsed?.pcm.equals(pcm)).toBe(true);
  });

  it('不是 WAV 就返回 null(宁可明确失败,也不要拿它当 PCM 播)', () => {
    expect(parseWav(Buffer.from('not a wav at all, really'))).toBeNull();
    expect(parseWav(Buffer.alloc(0))).toBeNull();
  });

  it('时长换算:1 秒 48k 双声道就是 1000 毫秒', () => {
    expect(durationMs(toChannels(tone(1000, 48000), 2), 48000, 2)).toBeCloseTo(1000, 3);
  });

  it('峰值:静音的峰值是 0,有声音的峰值接近给它的幅度', () => {
    expect(peak(silence(50, 16000))).toBe(0);
    expect(peak(tone(50, 16000, 440, 9000))).toBeGreaterThan(8000);
    expect(peak(stereo(tone(50, 16000)))).toBeGreaterThan(8000);
  });
});
