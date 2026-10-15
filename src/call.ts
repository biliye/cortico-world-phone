/**
 * 通话的规矩:谁能打进来、响了多久该拒、什么算卡住。
 *
 * 这一层刻意做成**纯的**(不碰网络、不碰定时器),理由是这样"为什么拒了这通"只有一个出处,
 * 而且能拿假数据直接测。World 只负责在状态变化时调用它。
 */
import { callerAllowed } from './config.ts';
import type { BridgeCall } from './bridge.ts';
import { clock, humanSeconds } from './util.ts';

export interface CallPolicy {
  /** 接听名单:UIN(手机号)或 UID(`u_…`)都行 —— 看桥报的是哪个(见 config.ts 那条注释)。 */
  callers: readonly (number | string)[];
  /** 白名单里的人打进来就自动接起。 */
  autoAnswer: boolean;
  /** 非白名单直接拒。 */
  rejectUnknown: boolean;
  /** 响铃超过这么久没人接就自动拒。 */
  ringTimeoutSec: number;
  /** 通话在 `rejecting` 停这么久算卡住。 */
  stuckSec: number;
}

export type CallDecision =
  | { kind: 'none' }
  | { kind: 'accept' }
  | { kind: 'reject'; reason: 'unknown' | 'ring-timeout'; note: string };

/** 打来的那个号。来电场景下 `callerUin` 是主字段,没有就退回 `peerUin`。 */
export function callerOf(call: BridgeCall): string {
  return (call.callerUin ?? call.peerUin ?? '').trim();
}

/**
 * 响铃那条事件的正文。
 *
 * `hasShot` = 这次拿到了**来电界面截图**(只有界面驱动版桥会给,见 world.ts 的 `ringScreenshot`)。
 * 有图就把"谁打来的"交给图:这一版桥只看得见屏幕像素,**报不出号码**
 * —— 它给的号只是配置里预设的那个人,当真会看错人。没图才照实报桥给的号(老桥那条路)。
 */
export function describeRinging(caller: string, hasShot: boolean): string {
  if (hasShot) {
    return (
      '【电话】有人打进来了 —— 来电界面的**截图附在这条里**,是谁打的以图为准' +
      '(电话那头只看得见屏幕、报不出号码)。要接就调 phone_answer,不接就等它超时。'
    );
  }
  return `【电话】有人打进来了:${caller || '没报出号'}。要接就调 phone_answer,不接就等它超时。`;
}

/**
 * 刚进入 `ringing` 时该做什么。
 *
 * 顺序要紧:**先判白名单,再看要不要自动接**。反过来的话,一个陌生号会先被自动接起,
 * 然后才发现不该接 —— 那就已经接通了。
 */
export function decideOnRing(call: BridgeCall, policy: CallPolicy): CallDecision {
  const caller = callerOf(call);
  const known = callerAllowed(policy.callers, caller);
  if (!known) {
    if (policy.rejectUnknown) {
      // 拒的时候要把**它报的是什么**说清楚:这套部署的 QQ 报 uid(`u_…`)而不是手机号,
      // 照抄这一串(或手机号)就能放行 —— 不然他只会看到"被拒绝了"而不知道该往名单里填什么。
      const what = caller === ''
        ? '这通没报出号码'
        : /^u_/.test(caller)
          ? `这通报的是内部 id「${caller}」(不是手机号)`
          : `这个号「${caller}」`;
      return {
        kind: 'reject',
        reason: 'unknown',
        note: `${what},不在接听名单里,直接拒了。要放行就把这一串照原样加进 worlds.phone.callers。`,
      };
    }
    return policy.autoAnswer ? { kind: 'accept' } : { kind: 'none' };
  }
  return policy.autoAnswer ? { kind: 'accept' } : { kind: 'none' };
}

/** 响铃超时:只在"还挂着、没被接"的时候成立。 */
export function ringTimedOut(call: BridgeCall, policy: CallPolicy, nowMs: number): boolean {
  if (call.phase !== 'ringing') return false;
  const since = call.inviteAt ?? 0;
  if (!Number.isFinite(since) || since <= 0) return false;
  // 上游的 inviteAt 与 endedAt 是**毫秒**时间戳(实测过;别当秒读)。
  return nowMs - since >= policy.ringTimeoutSec * 1000;
}

/**
 * 这些状态是**天生过渡的**:本该几秒内走掉,停久了就是卡住了。
 *
 * - `rejecting`:对方挂断后那通会停在这儿永不结束(它在等一个永远不会来的原生 ACK);
 * - `ending`:同理,只是发生在"我们去挂/拒"的那一侧 —— **2026-10-09 实测踩到**:
 *   他 18:24 那通被判成陌生号拒掉之后,通话卡在 `ending`,而他后面打的每一通
 *   **桥这一侧连记录都没有**(新的邀请进不来)。我上一版只认 `rejecting`,所以没救它。
 * - `accepted` / `dialing`:接起后本该几秒内变 `connected`(实测 3 秒),停久了也是卡住。
 *
 * 两种情况**都会挡住新通话**。唯一释放方式是重启 AV Host 换 bootId。
 * 这里只负责"认出来",怎么处理由 World 决定(报告,可能还有一条配置好的自愈命令)。
 */
const TRANSIENT_STATES: readonly string[] = ['ending', 'rejecting', 'accepted', 'dialing'];

export function isTransientPhase(phase: string): boolean {
  return TRANSIENT_STATES.includes(phase);
}

export function stuckFor(call: BridgeCall, policy: CallPolicy, sinceMs: number, nowMs: number): number | null {
  if (!isTransientPhase(call.phase) || sinceMs <= 0) return null;
  const held = nowMs - sinceMs;
  return held >= policy.stuckSec * 1000 ? held : null;
}

/**
 * 接起这一句,给事件正文用。
 *
 * **除了"他说的会变成事件",这一句还必须说清"你从哪儿出声"。**
 * 2026-10-14 实测:三通电话她每轮都只调 `end_turn`、一个字不写 —— 因为框架那条常驻规矩
 * (「不经工具写的正文是内心活动,要说话得用说话工具」)压过了"正文会被念出去"这件事,
 * 而这一段通知当时只讲了入站方向。于是接通这一条成了"她第一次能开口"的现场提示,
 * 出声的两条路都在这一句里点明。
 */
export function describeConnected(call: BridgeCall): string {
  const who = callerOf(call) || '没报出号';
  const how = call.direction === 'outgoing' ? '拨出' : '来电';
  const media = call.media ? `,${call.media === 'video' ? '视频' : '语音'}` : '';
  return (
    `【电话】${how}接通了:${who}${media}。现在开始,他说的每一句都会作为事件给你。` +
    '你要说话就调 `phone_say`(直接写下的正文这一路也会被念出去)——' +
    '**别沉默**:你什么都不说,他那头就是一段静音,他分不出你是"不用回"还是"没听见"。'
  );
}

/** 通话记录里的一行。`him` = 对方说的(识别出来的正文),`her` = 她提交的句子，播放状态另列。 */
export interface TranscriptLine {
  who: 'him' | 'her';
  text: string;
  playback?: string;
}

/**
 * 记录块的字符上限。
 *
 * 这条事件进的是**她的上下文**(每一轮都要重发),所以不能让一通长电话把前缀撑爆:
 * 实测一通十几分钟的闲聊逐句抄下来能到一两万字。四千字大约是一通正常通话的量,
 * 超了就明说"还有 N 行"(不静默截断 —— 静默截断读起来像"通话就到这儿",那是假话)。
 */
export const TRANSCRIPT_MAX_CHARS = 4000;

/** 把记录渲染成事件正文里的那一段。没有记录就不加,免得每通电话都挂一个空壳。 */
export function renderTranscript(lines: readonly TranscriptLine[]): string {
  if (lines.length === 0) return '';
  const out: string[] = ['\n——这一通的记录(他说 / 她说)——'];
  let used = 0;
  let cut = 0;
  for (const line of lines) {
    const who = line.who === 'her' ? '她' : '他';
    const row = `${who}${line.playback ? `（${line.playback}）` : ''}：${line.text.replace(/\s+/g, ' ').trim()}`;
    if (used + row.length > TRANSCRIPT_MAX_CHARS) {
      cut += 1;
      continue;
    }
    used += row.length;
    out.push(row);
  }
  if (cut > 0) out.push(`……(还有 ${cut} 行，太长不列了)`);
  return out.join('\n');
}

/**
 * 挂断这一句。
 *
 * 正文里说的是**桥报的事实**(谁、多久、原生结束事件),`reason` 只在她没挂干净时补一句
 * 我们这边的说明(被新的一通顶掉、world 停了、重连后这通没了)——
 * 那是我们观察到的事实,不是她的猜测。
 *
 * `transcript` 是这一通的逐句记录(他说的 / 她念出去的),附在最后。
 * **要不要把它记进记忆由她自己决定** —— 这一包不替她写任何东西,只把事实交到手里。
 */
export function describeEnded(
  call: BridgeCall,
  timezone: string,
  stats: { heard: number; spoke: number },
  reason = '正常结束',
  transcript: readonly TranscriptLine[] = [],
): string {
  const who = callerOf(call) || '没报出号';
  const end = call.endedAt ?? Date.now();
  const seconds = Math.max(0, (end - (call.inviteAt ?? end))) / 1000;
  const native = call.nativeEndEvent ? `,桥报结束信息 ${call.nativeEndEvent}` : '';
  const odd = reason === '正常结束' ? '' : `,我们这边看到的收尾原因是「${reason}」`;
  return (
    `【电话】通话结束:${who},历时 ${humanSeconds(seconds)}${native}${odd}。` +
    `这一通里收到对方 ${stats.heard} 条语音事件,你完整合成 ${stats.spoke} 段。播放情况见逐句标记；桥确认完成也不代表对方实际听见。` +
    renderTranscript(transcript)
  );
}

/** 现在这通电话的一句话实况,给 `phone_status` 与环境提示词用。 */
export function describeLive(call: BridgeCall | undefined, nowMs: number, note: string): string {
  if (!call) return `现在没有通话。${note}`;
  const who = callerOf(call) || '没报出号';
  const since = call.inviteAt ?? nowMs;
  const held = clock((nowMs - since) / 1000);
  const phaseText: Record<string, string> = {
    ringing: '还在响(没接通)',
    accepted: '已受理,正在接通',
    connected: '通话中',
    rejecting: '正在挂断(卡在这里就说明桥需要自愈)',
    ended: '已经结束',
  };
  return `现在这通:${who},${phaseText[call.phase] ?? call.phase},已 ${held}。${note}`;
}

/**
 * 一串通话里"当前这一通"。上游的 `calls` 里可能同时有已结束的历史条目,
 * 所以这里挑第一个非终态的;全结束了就取最后一个(它的 phase 是 ended)。
 */
export function currentCall(calls: readonly BridgeCall[]): BridgeCall | undefined {
  const live = calls.find((c) => c.phase !== 'ended' && c.phase !== 'error' && c.phase !== 'failed');
  return live ?? calls[calls.length - 1];
}
