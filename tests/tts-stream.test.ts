import { describe, it, expect } from 'vitest';
import { synthesizePcm } from '../src/tts.ts';
import { StreamingMonoResampler } from '../src/pcm.ts';
import { PHONE_DEFAULTS } from '../src/config.ts';
import { tone } from './helpers/wav.ts';

const settings = { ...PHONE_DEFAULTS.tts, voiceId: 'test', streaming: true };
const sse = (audio: Buffer, status = 1) => `data: ${JSON.stringify({ data: { audio: audio.toString('hex'), status }, base_resp: { status_code: 0 } })}\r\n\r\n`;
const mock = (body: ReadableStream<Uint8Array>): typeof fetch => (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

describe('流式 TTS 协议', () => {
  it('首块立即交给播放器；跨网络块的 SSE 和最后汇总不重播', async () => {
    const pcm = tone(200, 32000);
    const got: Buffer[] = [];
    let finish!: () => void;
    const gate = new Promise<void>(r => { finish = r; });
    const body = new ReadableStream<Uint8Array>({ async start(c) {
      const raw = Buffer.from(sse(pcm));
      // 在 CRLF 之间切开。
      c.enqueue(raw.subarray(0, raw.length - 3));
      c.enqueue(raw.subarray(raw.length - 3));
      await gate;
      c.enqueue(Buffer.from(sse(pcm, 2))); c.close();
    } });
    const result = synthesizePcm('你好', { settings, apiKey: 'test', targetRate: 48000, fetchImpl: mock(body), onPcm: p => got.push(p) });
    await new Promise(r => setTimeout(r, 20));
    expect(got.length).toBeGreaterThan(0);
    finish();
    const done = await result;
    expect(done.ok).toBe(true);
    expect(Buffer.concat(got).length).toBe(19200); // 200ms, mono 48k
  });
  it('提前断流和坏 hex 必须失败，不能宣称整句完成', async () => {
    for (const text of [sse(tone(80, 32000)), 'data: {"data":{"status":1,"audio":"oops"}}\n\n']) {
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } });
      const r = await synthesizePcm('你好', { settings, apiKey: 'test', targetRate: 48000, fetchImpl: mock(body), onPcm: () => {} });
      expect(r.ok).toBe(false);
    }
  });
  it('停止会中止正在等待的网络请求', async () => {
    const abort = new AbortController();
    let networkAborted = false;
    const fetchImpl = ((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { networkAborted = true; reject(new Error('aborted')); });
    })) as typeof fetch;
    const work = synthesizePcm('你好', { settings, apiKey: 'test', targetRate: 48000, fetchImpl, signal: abort.signal, onPcm: () => {} });
    abort.abort();
    expect((await work).ok).toBe(false);
    expect(networkAborted).toBe(true);
  });
});

describe('流式重采样跨块连续', () => {
  it.each([16000, 22050, 32000, 44100, 48000])('%iHz：任意字节边界与一次输入结果一致', rate => {
    const pcm = tone(137, rate);
    const whole = new StreamingMonoResampler(rate, 48000).push(pcm, true);
    const r = new StreamingMonoResampler(rate, 48000);
    const parts: Buffer[] = [];
    for (let i = 0; i < pcm.length; i += 131) parts.push(r.push(pcm.subarray(i, i + 131)));
    parts.push(r.push(Buffer.alloc(0), true));
    expect(Buffer.concat(parts)).toEqual(whole);
  });
});
