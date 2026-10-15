import { describe, it, expect } from 'vitest';
import { PlaybackLedger } from '../src/playback.ts';
describe('播放凭据', () => {
  it('全部帧 played 且合成完整才确认完成；晚到的 queued 不降级', () => {
    const p = new PlaybackLedger(); const u = p.add('你好', 'c', 1, 0);
    p.frame(u, 'a'); p.frame(u, 'b'); p.finish(u, true);
    for (const id of ['a', 'b']) p.receipt({ id, callId: 'c', state: 'queued' });
    expect(u.line.playback).toBe('已提交桥，播放未确认');
    p.receipt({ id: 'a', callId: 'c', state: 'played' });
    expect(u.line.playback).not.toBe('桥确认播放完成');
    p.receipt({ id: 'b', callId: 'c', state: 'played' });
    p.receipt({ id: 'b', callId: 'c', state: 'queued' });
    expect(u.line.playback).toBe('桥确认播放完成');
  });
  it('跨通话、取消后的回执不能把未完成句子改成成功', () => {
    const p = new PlaybackLedger(); const u = p.add('你好', 'c', 1, 0);
    p.frame(u, 'a'); p.finish(u, true);
    p.receipt({ id: 'a', callId: 'other', state: 'played' });
    expect(u.line.playback).not.toBe('桥确认播放完成');
    p.interrupt(); p.receipt({ id: 'a', callId: 'c', state: 'played' });
    expect(u.line.playback).toContain('已停止');
  });
  it('合成中断，即使已有块 played，也不能说整句播完', () => {
    const p = new PlaybackLedger(); const u = p.add('你好', 'c', 1, 0);
    p.frame(u, 'a'); p.receipt({ id: 'a', callId: 'c', state: 'played' }); p.finish(u, false);
    expect(u.line.playback).toContain('未完整');
  });
});
