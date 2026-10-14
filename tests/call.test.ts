import { describe, expect, it } from 'vitest';
import { normalizeCall, isTerminal, type BridgeCall } from '../src/bridge.ts';
import {
  callerOf,
  currentCall,
  decideOnRing,
  describeConnected,
  describeEnded,
  describeLive,
  describeRinging,
  ringTimedOut,
  stuckFor,
  type CallPolicy,
} from '../src/call.ts';

const HIM = 10002;

const policy = (over: Partial<CallPolicy> = {}): CallPolicy => ({
  callers: [HIM],
  autoAnswer: true,
  rejectUnknown: true,
  ringTimeoutSec: 30,
  stuckSec: 20,
  ...over,
});

function call(over: Record<string, unknown> = {}): BridgeCall {
  const normalized = normalizeCall({
    id: 'c1',
    phase: 'ringing',
    callerUin: String(HIM),
    direction: 'incoming',
    kind: 'private',
    media: 'audio',
    inviteAt: 1_700_000_000_000,
    acceptReady: true,
    ...over,
  });
  if (!normalized) throw new Error('假通话没造出来');
  return normalized;
}

describe('normalizeCall:收成我们认得的形状', () => {
  it('缺 id 或缺 phase 的都当无效', () => {
    expect(normalizeCall({ phase: 'ringing' })).toBeNull();
    expect(normalizeCall({ id: 'x' })).toBeNull();
    expect(normalizeCall(null)).toBeNull();
  });

  it('phase 不是 state(**上游就是这么写的**)', () => {
    const c = call({ state: 'connected' });
    expect(c?.phase).toBe('ringing');
  });

  it('终态判定', () => {
    expect(isTerminal('ended')).toBe(true);
    expect(isTerminal('rejecting')).toBe(false);
    expect(isTerminal('connected')).toBe(false);
  });
});

describe('decideOnRing:先判名单,再谈自动接', () => {
  it('白名单 + 自动接起 → 接', () => {
    expect(decideOnRing(call(), policy()).kind).toBe('accept');
  });

  it('白名单 + 手动模式 → 不动作(等她调 phone_answer)', () => {
    expect(decideOnRing(call(), policy({ autoAnswer: false })).kind).toBe('none');
  });

  it('陌生号 + 直接拒 → 拒,且理由写清楚', () => {
    const decision = decideOnRing(call({ callerUin: '999999' }), policy());
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.reason).toBe('unknown');
      expect(decision.note).toContain('999999');
    }
  });

  it('陌生号 + 自动接起开着 + 不直接拒 → 照接(名字单子不是门槛时)', () => {
    const decision = decideOnRing(call({ callerUin: '999999' }), policy({ rejectUnknown: false }));
    expect(decision.kind).toBe('accept');
  });

  it('名单空着 = 谁都不接,不是谁都接', () => {
    const decision = decideOnRing(call(), policy({ callers: [] }));
    expect(decision.kind).toBe('reject');
  });

  it('★ 名单里可以放 uid(`u_…`)—— 这套 QQ 报的就是 uid 而不是手机号', () => {
    const uid = 'u_example000000000000000';
    const decision = decideOnRing(call({ callerUin: undefined, peerUin: uid, targetId: uid } as never), policy({ callers: [HIM, uid] }));
    expect(decision.kind).toBe('accept');
  });

  it('★ 拒的时候要说清"它报的是什么" —— 报 uid 时得让他知道该往名单里填哪一串', () => {
    const uid = 'u_example000000000000000';
    const decision = decideOnRing(call({ callerUin: undefined, peerUin: uid, targetId: uid } as never), policy());
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.note).toContain(uid);
      expect(decision.note).toContain('内部 id');
      expect(decision.note).toContain('worlds.phone.callers');
    }
  });

  it('号写成字符串也能对上 UIN(配置里两种写法都见过)', () => {
    const decision = decideOnRing(call(), policy({ callers: [String(HIM)] as unknown as number[] }));
    expect(decision.kind).toBe('accept');
  });
});

describe('ringTimedOut 与 stuckFor:两条闸门', () => {
  it('响铃没超时不拒', () => {
    const c = call();
    expect(ringTimedOut(c, policy(), 1_700_000_000_000 + 29_000)).toBe(false);
    expect(ringTimedOut(c, policy(), 1_700_000_000_000 + 31_000)).toBe(true);
  });

  it('已经接通了就不该再按响铃判', () => {
    const c = call({ phase: 'connected' });
    expect(ringTimedOut(c, policy(), 1_700_000_000_000 + 999_999)).toBe(false);
  });

  it('inviteAt 是毫秒:一秒前响的不算超时,31 秒前的才算', () => {
    // 这条是防回归:inviteAt 若被当成秒,这两个断言会同时为真(或同时为假)。
    const now = Date.now();
    expect(ringTimedOut(call({ inviteAt: now - 1000 }), policy(), now)).toBe(false);
    expect(ringTimedOut(call({ inviteAt: now - 31_000 }), policy(), now)).toBe(true);
  });

  it('卡在 rejecting 够久才算卡住', () => {
    const c = call({ phase: 'rejecting' });
    const since = 1_000_000;
    expect(stuckFor(c, policy(), since, since + 19_000)).toBeNull();
    expect(stuckFor(c, policy(), since, since + 21_000)).toBe(21_000);
  });

  it('★ `ending` 也算卡住 —— 拒绝那一侧同样会停在过渡状态上(2026-10-09 实测)', () => {
    const c = call({ phase: 'ending' });
    const since = 1_000_000;
    expect(stuckFor(c, policy(), since, since + 21_000)).toBe(21_000);
  });

  it('`accepted`(接起后没走到 connected)也算', () => {
    const c = call({ phase: 'accepted' });
    expect(stuckFor(c, policy(), 1000, 25_000)).toBe(24_000);
  });

  it('不是在过渡状态就不算卡住(接通的通话可以停很久)', () => {
    expect(stuckFor(call({ phase: 'connected' }), policy(), 0, 9_999_999)).toBeNull();
    expect(stuckFor(call({ phase: 'ringing' }), policy(), 0, 9_999_999)).toBeNull();
    expect(stuckFor(call({ phase: 'ending' }), policy(), 0, 9_999_999)).toBeNull(); // 没起表就不判
  });
});

describe('currentCall:通话表里取"当前这一通"', () => {
  it('优先取非终态的那条', () => {
    const ended = call({ id: 'old', phase: 'ended' });
    const live = call({ id: 'now', phase: 'connected' });
    expect(currentCall([ended!, live!])?.id).toBe('now');
  });

  it('全结束了就报最后一条(这样收尾还能读到它的 endedAt)', () => {
    const a = call({ id: 'a', phase: 'ended' });
    const b = call({ id: 'b', phase: 'ended' });
    expect(currentCall([a!, b!])?.id).toBe('b');
  });

  it('空表没有当前通话', () => {
    expect(currentCall([])).toBeUndefined();
  });
});

describe('事件正文', () => {
  it('接通那句把谁打来的说清楚,并标上【电话】前缀', () => {
    const text = describeConnected(call({ phase: 'connected' }));
    expect(text).toContain('【电话】');
    expect(text).toContain(String(HIM));
  });

  it('★ 接通那句必须点明"你从哪儿出声" —— 只讲入站那一半,她整通都会沉默(2026-10-14 实测)', () => {
    const text = describeConnected(call({ phase: 'connected' }));
    expect(text).toContain('phone_say');
    expect(text).toContain('别沉默');
  });

  it('挂断那句带历时与两边各说了多少', () => {
    const text = describeEnded(
      call({ phase: 'ended', endedAt: 1_700_000_000_000 + 95_000, nativeEndEvent: 'peer.hangup' }),
      'Asia/Shanghai',
      { heard: 7, spoke: 3 },
    );
    expect(text).toContain('1 分 35 秒');
    expect(text).toContain('peer.hangup');
    expect(text).toContain('你听到了对方 7 句');
  });

  it('没有桥报的结束时,把我们这边看到的原因补进去(不冒充事实)', () => {
    const text = describeEnded(call({ phase: 'ended' }), 'Asia/Shanghai', { heard: 0, spoke: 0 }, '桥重连后这通已经没了');
    expect(text).toContain('我们这边看到的收尾原因是');
  });

  it('实况:没有通话时说没有,有通话时报对方与已多久', () => {
    expect(describeLive(undefined, 0, '')).toContain('现在没有通话');
    const text = describeLive(call({ phase: 'connected' }), 1_700_000_000_000 + 65_000, '');
    expect(text).toContain('通话中');
    expect(text).toContain('01:05');
  });

  it('callerOf 在只有 peerUin 时也认', () => {
    expect(callerOf(call({ callerUin: undefined, peerUin: '555' })!)).toBe('555');
  });
  /**
   * 响铃那条正文的两种写法。有截图那条**不提桥给的号** —— 界面驱动版桥看不出号码,
   * 它报的只是配置里预设的人,当真会认错人(图上有名字,以图为准)。
   */
  describe('describeRinging:有图看号、没图报号', () => {
    it('拿到截图:指出截图在哪、以图为准,并且不拿预设号当事实', () => {
      const text = describeRinging('10001', true);
      expect(text).toContain('截图');
      expect(text).toContain('以图为准');
      expect(text).not.toContain('10001');
      expect(text).toContain('phone_answer');
    });

    it('没有截图:照实报桥给的号(老桥那条路)', () => {
      expect(describeRinging('10002', false)).toContain('10002');
      expect(describeRinging('', false)).toContain('没报出号');
    });
  });
});
