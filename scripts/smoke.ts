/**
 * 冒烟:不用真电话，把"来电 → 接起 → 听见 → 她说话 → 对方插嘴 → 挂断"整条路走一遍。
 *
 * 与单测的分工:单测验的是"每一块的规矩对不对"(纯函数、边界)，这里验的是
 * **整条路连起来通不通**，并把每一步打印出来给人看 —— 这就是第二级要交给开发者的那种证据。
 *
 * 跑法:`corepack pnpm smoke`（可选 `--real-asr` 用本机真的 SenseVoice，前提是它开着）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, PushOptions } from 'cortico/core/types.ts';
import { PHONE_DEFAULTS, type PhoneConfigSection } from '../src/config.ts';
import { PhoneWorld } from '../src/world.ts';
import { FakeBridge } from '../tests/helpers/fake-bridge.ts';
import { silence, stereo, tone, wavHex } from '../tests/helpers/wav.ts';

const HIM = 10002;
/** 拨号目标:上游那条 `dial` 走的是 uid,不是手机号。 */
const ME = 'u_example000000000000000';
const TOKEN = 'smoke-token-0123456789abcdefghijklmnopqrstuvwxyz';
const realAsr = process.argv.includes('--real-asr');

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  败  ${name}${detail ? `  — ${detail}` : ''}`);
  }
};

/** 记录推送的假宿主，同时把时间线打出来。 */
const timeline: string[] = [];
const events: EventEnvelope[] = [];
const opts: Array<PushOptions | undefined> = [];
const host = {
  events,
  pushOpts: opts,
  pushDeferred: () => {},
  store: {} as never,
  blob: () => null,
  modelFacts: { model: () => 'smoke', accepts: () => false, contextWindow: () => 128000 },
  log: { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as never,
  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, o?: PushOptions) {
    const full = { ...e, cursor: events.length + 1 } as EventEnvelope;
    events.push(full);
    opts.push(o);
    timeline.push(`${full.origin === 'internal' ? '内部' : '外部'} ${full.type}: ${full.text}`);
    return full;
  },
  async drainPendingEvents() {
    return [];
  },
  reportUsage() {},
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 6000, what = '那个状态'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`);
    await sleep(20);
  }
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'phone-smoke-'));
  const bridge = new FakeBridge(TOKEN);
  bridge.audioWriteDelayMs = 120; // 让播放队列有货，好看见抢话那一步
  const url = await bridge.listen();

  // 假识别 + 假嗓子。`--real-asr` 时识别改成打本机服务(仍用假嗓子，免得真花钱)。
  const herSpeech = tone(4000, 32000, 520);
  const fakeFetch = (async (input: string | URL) => {
    const target = String(input);
    if (target.includes('/asr')) {
      if (realAsr) return fetch(target, arguments[1] as RequestInit);
      return new Response(JSON.stringify({ text: '喂?你听得到我吗' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        data: { audio: wavHex(herSpeech, 32000) },
        extra_info: { audio_length: (herSpeech.length / 2 / 32000) * 1000 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const cfg: PhoneConfigSection = {
    ...structuredClone(PHONE_DEFAULTS),
    enabled: true,
    bridgeUrl: url,
    tokenSecret: 'SMOKE_PHONE_TOKEN',
    callers: [HIM],
    stuckSec: 1,
    // 拨号目标配着:冒烟里要能真把那条 `dial` 帧发出去。
    dial: { target: ME, label: '他' },
    tts: { ...PHONE_DEFAULTS.tts, streaming: false, voiceId: 'smoke-voice' },
  };
  const world = new PhoneWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: scratch,
    secret: () => TOKEN,
    fetchImpl: fakeFetch,
  });

  console.log(`电话 World 冒烟（识别=${realAsr ? '本机真服务' : '假'}，嗓子=假，话机=假桥）\n`);
  await world.start(host);
  await waitFor(() => bridge.connected, 5000, '桥连上');
  check('桥连上、工具就位', world.tools().length === 6, `工具 ${world.tools().map((t) => t.name).join(' / ')}`);

  // ① 白名单来电 → 自动接起 → 接通事件
  bridge.ring('c1', String(HIM));
  await waitFor(() => bridge.requests.some((r) => r.op === 'accept'), 4000, '接听命令');
  await waitFor(() => events.some((e) => e.type === 'phone.connected'));
  check('白名单来电自动接起', bridge.requests.some((r) => r.op === 'accept'));
  check('接通后有 phone.connected 事件', events.some((e) => e.type === 'phone.connected'));

  // ② 对方说话 → 识别 → 事件
  bridge.pushAudioFrame('c1', stereo(silence(300, 48000, 30)));
  await sleep(40);
  bridge.pushAudioFrame('c1', stereo(tone(1200, 48000)));
  await sleep(40);
  bridge.pushAudioFrame('c1', stereo(silence(1000, 48000, 30)));
  await waitFor(() => events.some((e) => e.type === 'phone.speech'), 10000, '听到对方一句');
  const speech = events.find((e) => e.type === 'phone.speech')!;
  check('对方那句进了上下文', speech.text.includes('【电话·对方】'), speech.text.slice(0, 40));

  // ③ 她说话 → 合成 → 发回桥
  world.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我听得见,你说吧。' });
  await waitFor(() => bridge.requests.filter((r) => r.op === 'audio.write').length >= 2, 10000, '发回桥的音频');
  const write = bridge.requests.find((r) => r.op === 'audio.write')!;
  const frame = write.args.frame as Record<string, unknown>;
  const pcm = Buffer.from(String(frame.data), 'base64');
  check(
    '她的声音按桥要的格式发回去',
    frame.encoding === 'pcm_s16le' && frame.sampleRate === 48000 && frame.channels === 2 && pcm.length % 4 === 0,
    `${pcm.length} 字节/帧,${frame.sampleRate}Hz ${String(frame.channels)}ch`,
  );

  // ③b 她调 phone_say 说话:这是 2026-10-14 补的那条出声通道(那条常驻规矩要的"说话工具")
  const sayTool = world.tools().find((t) => t.name === 'phone_say')!;
  const sayBefore = bridge.requests.filter((r) => r.op === 'audio.write').length;
  const sayOut = await sayTool.handler({ text: '嗯,我在。' }, {} as never);
  const sayText = typeof sayOut === 'string' ? sayOut : sayOut.text;
  await waitFor(() => bridge.requests.filter((r) => r.op === 'audio.write').length > sayBefore, 10000, 'phone_say 的音频');
  check('她调 phone_say 说的那句也发回桥了', sayText.includes('我在'), sayText.slice(0, 50));

  // ④ 对方插嘴 → 清掉没放完的音频
  bridge.pushAudioFrame('c1', stereo(silence(300, 48000, 30)));
  await sleep(40);
  bridge.pushAudioFrame('c1', stereo(tone(900, 48000)));
  await waitFor(() => bridge.requests.some((r) => r.op === 'audio.clear'), 8000, '清队列');
  check('他插嘴时她的声音当场停住', bridge.requests.some((r) => r.op === 'audio.clear'));

  // ⑤ 挂断
  bridge.setPhase('c1', 'ended');
  await waitFor(() => events.some((e) => e.type === 'phone.ended'), 4000, '挂断事件');
  const ended = events.find((e) => e.type === 'phone.ended')!;
  check('挂断后有 phone.ended 事件', true, ended.text.slice(0, 60));
  // 收尾要把**这一通说过的话**打包给她(他要的"通话记录"),而不是只留一个"历时多久"。
  check(
    '收尾的正文里带着逐句记录',
    ended.text.includes('这一通的记录') && ended.text.includes('他：') && ended.text.includes('她（'),
  );

  // ⑥ 工具回执
  const status = world.tools().find((t) => t.name === 'phone_status')!;
  const statusText = String(await status.handler({}, {} as never));
  check('phone_status 报得清没有通话', statusText.includes('现在没有通话'));

  // ⑦ 陌生号直接拒
  bridge.ring('c2', '999999');
  await waitFor(() => bridge.requests.some((r) => r.op === 'reject'), 4000, '拒绝命令');
  check('陌生号直接拒', !events.some((e) => e.text.includes('999999') && e.type === 'phone.connected'));

  // ⑧ 卡住自愈:配了命令但没有隧道时要说清发不出去
  bridge.ring('c3', String(HIM));
  await waitFor(() => bridge.calls.get('c3')?.state === 'connected');
  bridge.setPhase('c3', 'rejecting');
  await waitFor(() => events.some((e) => e.text.includes('卡在')), 6000, '卡住那条通知');
  check('卡在 rejecting 会说清楚', events.find((e) => e.text.includes('卡在'))!.text.includes('recoverCommand'));
  bridge.setPhase('c3', 'ended');
  await sleep(50);

  // ⑨ 她主动拨出去:走上游那条 `dial`(目标是 uid),接通之后说的照常念给他听
  bridge.onRequest = (op, args) => {
    if (op === 'dial') {
      bridge.ring('out1', String(args.targetId), { direction: 'outgoing', state: 'dialing' });
      setTimeout(() => bridge.setPhase('out1', 'connected'), 10);
    }
    return undefined;
  };
  const dialTool = world.tools().find((t) => t.name === 'phone_dial')!;
  const dialReply = String(await dialTool.handler({}, {} as never));
  await waitFor(() => bridge.requests.some((r) => r.op === 'dial'), 4000, '拨号命令');
  const dialFrame = bridge.requests.find((r) => r.op === 'dial')!.args;
  check(
    '她主动拨出去:按上游那条帧发(direct / uid / audio)',
    dialFrame.kind === 'direct' && dialFrame.targetId === ME && dialFrame.media === 'audio',
    dialReply.slice(0, 40),
  );
  await waitFor(() => events.some((e) => e.type === 'phone.connected' && e.text.includes('拨出')), 6000, '拨出接通');
  check('拨出的那一通接通后,事件也说是"拨出"', true);
  bridge.setPhase('out1', 'ended');

  await world.stop();
  await bridge.close();

  console.log('\n时间线:');
  for (const line of timeline) console.log(`  ${line}`);

  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} 过 / ${failed} 败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('冒烟本身炸了:', error);
  process.exitCode = 1;
});
