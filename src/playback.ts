import type { TranscriptLine } from './call.ts';
import type { BridgePlaybackReceipt } from './bridge.ts';

export interface Utterance {
  id: number;
  callId: string;
  generation: number;
  text: string;
  queuedAt: number;
  line: TranscriptLine;
  complete: boolean;
  interrupted: boolean;
  failed: boolean;
  frames: Map<string, string>;
}

/** 只解释桥的回执，不把成功入队或合成完成写成用户已经听见。 */
export class PlaybackLedger {
  private next = 0;
  readonly utterances: Utterance[] = [];
  private frames = new Map<string, Utterance>();

  add(text: string, callId: string, generation: number, now: number): Utterance {
    const line: TranscriptLine = { who: 'her', text, playback: '待合成' };
    const u: Utterance = { id: ++this.next, callId, generation, text, queuedAt: now, line, complete: false, interrupted: false, failed: false, frames: new Map() };
    this.utterances.push(u);
    return u;
  }
  frame(u: Utterance, id: string): void {
    u.frames.set(id, 'pending');
    this.frames.set(id, u);
    this.refresh(u);
  }
  receipt(r: BridgePlaybackReceipt): void {
    const u = this.frames.get(r.id);
    if (!u || r.callId !== u.callId || u.interrupted) return;
    const old = u.frames.get(r.id);
    if (old === 'played' || old === 'cancelled' || old === 'failed') return;
    if (old === 'playing' && r.state === 'queued') return;
    if (!['queued', 'playing', 'played', 'cancelled', 'failed', 'uncertain'].includes(r.state)) return;
    u.frames.set(r.id, r.state);
    this.refresh(u);
  }
  finish(u: Utterance, ok: boolean): void { u.complete = ok; u.failed = !ok; this.refresh(u); }
  interrupt(): void {
    for (const u of this.utterances) {
      if (u.line.playback === '桥确认播放完成') continue;
      u.interrupted = true;
      this.refresh(u);
    }
  }
  get pending(): boolean { return this.utterances.some(u => !u.interrupted && !u.failed && u.line.playback !== '桥确认播放完成'); }
  summary(): string {
    const counts = new Map<string, number>();
    for (const u of this.utterances) counts.set(u.line.playback!, (counts.get(u.line.playback!) ?? 0) + 1);
    return [...counts].map(([state, n]) => `${state} ${n} 段`).join('；') || '尚未提交说话';
  }
  private refresh(u: Utterance): void {
    const states = [...u.frames.values()];
    u.line.playback = u.interrupted ? '已停止，可能只播出部分' :
      u.failed || states.includes('failed') ? '未完整合成或发送，可能只播出部分' :
      states.includes('uncertain') ? '发送结果不明' :
      states.includes('cancelled') ? '桥已取消，可能只播出部分' :
      u.complete && states.length > 0 && states.every(s => s === 'played') ? '桥确认播放完成' :
      u.complete && states.length > 0 && states.every(s => ['queued', 'playing', 'played'].includes(s)) ? '已提交桥，播放未确认' :
      states.length > 0 ? '合成或发送中，未完整确认' : '待合成';
  }
}
