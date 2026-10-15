import { StreamingMonoResampler, durationMs } from './pcm.ts';
import { billableChars } from './sentences.ts';
import type { TtsDeps, TtsResult } from './tts.ts';
import { describe } from './util.ts';

/** MiniMax HTTP SSE。status=2 默认携带整句汇总，只验完成、不再播放一次。
 * 协议：https://platform.minimax.cn/docs/api-reference/speech-t2a-http
 */
export async function synthesizeStreamingPcm(text: string, deps: TtsDeps): Promise<TtsResult> {
  const { settings } = deps;
  const started = Date.now();
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1000, settings.timeoutMs)), ...(deps.signal ? [deps.signal] : [])]);
  const chunks: Buffer[] = [];
  let firstMs: number | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    const response = await (deps.fetchImpl ?? fetch)(settings.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.apiKey.trim()}`, 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: settings.model, text, stream: true,
        // 保留最终汇总用于识别结束包；它绝不作为增量播放。
        stream_options: { exclude_aggregated_audio: false },
        voice_setting: { voice_id: settings.voiceId, speed: settings.speed, vol: settings.vol, pitch: settings.pitch },
        audio_setting: { sample_rate: settings.sampleRate, format: 'pcm', channel: 1 },
      }),
    });
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
      throw new Error('TTS 未返回 SSE 音频流；可将 tts.streaming 设为 false 使用 WAV 兼容模式');
    }
    reader = response.body.getReader();
    const resampler = new StreamingMonoResampler(settings.sampleRate, deps.targetRate);
    const emit = (pcm: Buffer): void => {
      signal.throwIfAborted();
      if (!pcm.length) return;
      if (firstMs === undefined) firstMs = Date.now() - started;
      chunks.push(pcm);
      deps.onPcm?.(pcm);
    };
    const event = (block: string): void => {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const p = JSON.parse(data) as { base_resp?: { status_code?: number; status_msg?: string }; data?: { audio?: string; status?: number }; extra_info?: { audio_sample_rate?: number; audio_channel?: number; audio_format?: string } };
      if (p.base_resp?.status_code !== undefined && p.base_resp.status_code !== 0) throw new Error(`TTS ${p.base_resp.status_code}: ${p.base_resp.status_msg ?? ''}`);
      const info = p.extra_info;
      if (info && ((info.audio_sample_rate !== undefined && info.audio_sample_rate !== settings.sampleRate) ||
        (info.audio_channel !== undefined && info.audio_channel !== 1) || (info.audio_format !== undefined && info.audio_format !== 'pcm'))) {
        throw new Error('TTS 流式音频规格与请求不一致');
      }
      if (p.data?.status === 2) { complete = true; return; }
      const hex = p.data?.audio;
      if (!hex) return;
      if (p.data?.status !== 1 || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error('TTS 音频块格式无效');
      emit(resampler.push(Buffer.from(hex, 'hex')));
    };
    const decoder = new TextDecoder();
    let buffer = '';
    while (!complete) {
      signal.throwIfAborted();
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      // 保留跨 read 的 CR，避免把 CRLF 的边界误判成两个换行。
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        event(block);
        if (complete) break;
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error('TTS 事件过大');
      if (part.done) { if (!complete && buffer.trim()) event(buffer); break; }
    }
    if (!complete) throw new Error('TTS 音频流提前断开，未收到合成完成标志');
    emit(resampler.push(Buffer.alloc(0), true));
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) throw new Error('TTS 完成但没有增量音频');
    deps.log?.info?.('语音合成计时', { streaming: true, firstAudioMs: firstMs, totalMs: Date.now() - started, bytes: pcm.length });
    return { ok: true, pcm, sampleRate: deps.targetRate, ms: durationMs(pcm, deps.targetRate), chars: billableChars(text) };
  } catch (error) {
    return { ok: false, kind: 'network', error: `语音合成未完成:${describe(error)}` };
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
