import { resolve } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { PHONE_DEFAULTS, type PhoneConfigSection } from './config.ts';
import { PHONE_TOOL_DECLS, PhoneWorld } from './world.ts';

export const PHONE: WorldDefinition<PhoneConfigSection> = {
  id: 'phone',
  label: '电话',
  defaults: () => ({ ...PHONE_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.phone` 的活引用:热改的键现读即生效。
  create: (ctx) =>
    new PhoneWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      // 通话音频与诊断落盘都放这儿;`logAudio` 默认关，所以平时不会用上。
      dataDir: resolve(ctx.dataDir),
      secret: (name) => ctx.secret(name),
    }),

  describe: {
    tools: describeTools(PHONE_TOOL_DECLS, {
      phone_say: {
        zh: '在接通的话里念一句（进合成队列，回执不代表已播放）。',
        en: 'Speaks one short line into a connected call; the receipt means queued, not played.',
      },
      phone_answer: {
        zh: '接起正在响的那一通（只在没自动接起时才需要）。',
        en: 'Answers the ringing call when auto-answer is off.',
      },
      phone_dial: {
        zh: '主动拨一通语音电话给配置里那一个人。',
        en: 'Dials the one configured callee.',
      },
      phone_hangup: {
        zh: '说完再挂：正在念的这句念完才真挂，道别写在这一轮里。',
        en: 'Hangs up after the current line finishes; say the goodbye in this turn.',
      },
      phone_stop: {
        zh: '立刻停住正在念的话，这一轮剩下的正文也不再念。',
        en: 'Stops the line being spoken now and mutes the rest of the turn.',
      },
      phone_status: {
        zh: '看这一路的实况：通话、对方、桥、合成与播放各到哪一步。',
        en: 'Reports the live state: call, peer, bridge, synthesis and playback.',
      },
    }),
    events: [
      { type: 'phone.ringing', description: { zh: '有电话打进来（带一张来电界面截图，若桥抓得到）。', en: 'An incoming call is ringing; carries a screenshot of the call UI when the bridge can capture one.' }, trigger: 'preempt' },
      { type: 'phone.connected', description: { zh: '这一通接通了，可以说话了。', en: 'The call connected; speaking is possible now.' }, trigger: 'flush' },
      { type: 'phone.ended', description: { zh: '一通结束：附上他说的与她真正念出去的逐句记录。', en: 'A call ended, with the per-line record of what he said and what she actually spoke.' }, trigger: 'flush' },
      { type: 'phone.outgoingFailed', description: { zh: '她拨出去的那通从头到尾没接通。', en: 'A call she placed never connected.' }, trigger: 'flush' },
      { type: 'phone.speech', description: { zh: '认出来一句他说的（听不清的段也会如实报一句）。', en: 'One recognized line from him; unclear segments are reported as such.' }, trigger: 'flush' },
      { type: 'phone.context', description: { zh: '上下文交接完成、通话仍在：补上最近记录。', en: 'Session handoff finished while a call is live; appends the recent record.' }, trigger: 'flush' },
      { type: 'phone.notice', description: { zh: '机制通知：桥断了、卡住了、合成失败这类内部消息。', en: 'Internal notice: bridge down, stalled, synthesis failure.' }, trigger: 'debounce' },
    ],
  },
};
