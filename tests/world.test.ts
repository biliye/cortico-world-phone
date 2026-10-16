/**
 * World 的一级验证(不碰真电话):假桥 + 假识别 + 假嗓子,把整条路走一遍。
 *
 * 用的都是**真的那几份实现**:真的分段器、真的重采样、真的状态机、真的 `ws` 客户端。
 * 只有三个"外面"被换掉:桥、识别服务、合成服务 —— 那三个是别人的东西,
 * 而在这一级要验的是"我们这边接得对不对"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PHONE } from '../src/definition.ts';
import { PHONE_DEFAULTS, type PhoneConfigSection } from '../src/config.ts';
import { PhoneWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakeBridge } from './helpers/fake-bridge.ts';
import { silence, stereo, tone, wavHex } from './helpers/wav.ts';

const HIM = 10002;
const TOKEN = 'phone-bridge-token-for-tests-0123456789';

let scratch: string;
let bridge: FakeBridge | undefined;
let world: PhoneWorld | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'phone-world-'));
});
afterEach(async () => {
  await world?.stop();
  world = undefined;
  await bridge?.close();
  bridge = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 6000, what = '那个状态'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 假识别 + 假嗓子。按 URL 分流:走 `/asr` 的是耳朵,其余的当嗓子。 */
function fakeServices(options: { herSpeech?: Buffer; speakDelayMs?: number; asrText?: string } = {}): typeof fetch {
  const herSpeech = options.herSpeech ?? tone(2000, 32000, 520);
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/asr')) return new Response(JSON.stringify({ text: options.asrText ?? '你好呀,我听着呢' }), { status: 200 });
    if (options.speakDelayMs) await new Promise((r) => setTimeout(r, options.speakDelayMs));
    void init;
    return new Response(
      JSON.stringify({
        data: { audio: wavHex(herSpeech, 32000) },
        extra_info: { audio_length: (herSpeech.length / 2 / 32000) * 1000 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

async function startWorld(over: Partial<PhoneConfigSection> = {}, services = fakeServices(), now?: () => number): Promise<FakeHost> {
  bridge = new FakeBridge(TOKEN);
  const url = await bridge.listen();
  const cfg: PhoneConfigSection = {
    ...structuredClone(PHONE_DEFAULTS),
    enabled: true,
    bridgeUrl: url,
    tokenSecret: 'TEST_PHONE_TOKEN',
    callers: [HIM],
    tts: { ...PHONE_DEFAULTS.tts, streaming: false, voiceId: 'test-voice' },
    ...over,
  };
  world = new PhoneWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: scratch,
    secret: () => TOKEN,
    fetchImpl: services,
    now,
  });
  const host = new FakeHost();
  await world.start(host);
  // start() 只是**开始**连:等桥真连上再往下走，否则测的是"还没连上时会怎样"。
  await waitFor(() => bridge!.connected, 5000, '桥连上');
  return host;
}

/** 喂一段"有人在说话":先给底噪立门限,再给声音,最后用静音收句。 */
async function feedSpeech(callId: string, ms = 1200): Promise<void> {
  bridge!.pushAudioFrame(callId, stereo(silence(300, 48000, 30)));
  await new Promise((r) => setTimeout(r, 30));
  bridge!.pushAudioFrame(callId, stereo(tone(ms, 48000)));
  await new Promise((r) => setTimeout(r, 30));
  bridge!.pushAudioFrame(callId, stereo(silence(1000, 48000, 30)));
}

/** 调一个工具,把回执统一成 `{ text, failed }`(字符串回执 = 成功)。 */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; failed: boolean }> {
  const tool = world!.tools().find((t) => t.name === name)!;
  const outcome = await tool.handler(args, {} as never);
  return typeof outcome === 'string'
    ? { text: outcome, failed: false }
    : { text: outcome.text, failed: outcome.failed === true };
}

/** 接通一通来电(接听命令交出去、桥那边变成 connected,**并等到 World 真处理完**
 *  —— 只等桥那个状态的话,World 可能还没进 connected,那时说话会被当成"没接通")。 */
async function connect(host: FakeHost, callId = 'c1'): Promise<void> {
  bridge!.ring(callId, String(HIM));
  await waitFor(() => host.events.some((e) => e.type === 'phone.connected'), 6000, 'phone.connected');
}

describe('干装载与声明', () => {
  it('装载器接受它:默认配置、无密钥也能构造', async () => {
    const report = await dryMountWorld(PHONE, { scratchDir: scratch });
    expect(report.failures).toEqual([]);
  });

  it('六个工具都在,名字带 phone_ 前缀', () => {
    const instance = PHONE.create(fakeWorldContext(PHONE, { scratchDir: scratch }));
    expect(instance.tools().map((t) => t.name).sort()).toEqual([
      'phone_answer',
      'phone_dial',
      'phone_hangup',
      'phone_say',
      'phone_status',
      'phone_stop',
    ]);
  });

  it('默认禁用:装上去不会自己开始打电话', () => {
    expect(PHONE_DEFAULTS.enabled).toBe(false);
  });

  it('环境提示词的四个占位符都有值(没通话时也说清楚)', () => {
    const instance = PHONE.create(fakeWorldContext(PHONE, { scratchDir: scratch }));
    const vars = instance.envPromptVars() as Record<string, string>;
    expect(vars['phone.callers']).toBeDefined();
    expect(vars['phone.state']).toContain('没有通话');
    // 拨号目标没配时要写"没配" —— 空着会让提示词读成"她随时能拨",而实际拨不出去。
    expect(vars['phone.dialTo']).toContain('没配');
    // 打断这件事两种配置下的说法不一样,但都得有字。
    expect(vars['phone.interrupt']!.length).toBeGreaterThan(10);
  });

  it('配了拨号目标:那个称呼进提示词', () => {
    const ctx = fakeWorldContext(PHONE, { scratchDir: scratch });
    // `ctx.cfg` 是活引用(与部署里那份同一个对象),所以就地改它等于改配置。
    (ctx.cfg as { dial?: { target: string; label: string } }).dial = { target: 'u_x', label: '主人' };
    const instance = PHONE.create(ctx);
    expect((instance.envPromptVars() as Record<string, string>)['phone.dialTo']).toBe('主人');
  });
});

describe('实机复核的回归边界', () => {
  it('一块没回执不封住整通:按原 id 再问几次,还问不到就记一笔继续往下说', async () => {
    let synths = 0;
    const base = fakeServices({ herSpeech: tone(800, 32000) });
    const services = (async (...args: Parameters<typeof fetch>) => { synths++; return base(...args); }) as typeof fetch;
    // 重问之间等 10ms —— 生产里是 2000ms，这里只关心"会不会再问"。
    const host = await startWorld({ audioWriteRetryWaitMs: 10, audioWriteRetries: 2 }, services);
    await connect(host);
    bridge!.onRequest = op => op === 'audio.write' ? { ok: false, error: { code: 'TIMEOUT', message: 'lost acknowledgement' } } : undefined;
    await callTool('phone_say', { text: '第一次。' });
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write');
    // 同一块按原 id 问 1+2 次 —— 桥按 id 记住在办的那条，重问不会把话念两遍。
    // 只盯**第一块**自己：后面的块可以因为别的原因插进来(比如环境声触发抢话)，不该算进这条断言。
    await waitFor(() => {
      const first = writes()[0]?.args.playbackId;
      return !!first && writes().filter(r => r.args.playbackId === first).length >= 3;
    });
    await waitFor(() => host.events.some(e => e.text?.includes('一直没确认收到')));
    // 关键:以前这里是"暂停后续发送 + phone_say 直接拒绝"，整通就哑了
    // (2026-10-15 那通就是这么一字不出的)。现在必须还能接着说。
    const again = await callTool('phone_say', { text: '接着说的下一句。' });
    expect(again.failed).toBe(false);
    await waitFor(() => synths === 2);
    expect((await callTool('phone_status')).text).toContain('发送结果不明');
  });
  it('★ 她正说着时挂断:先把这句说完再发挂断命令,不是当场切断', async () => {
    // 他 2026-10-15 报的:他让她挂的时候她正说到一半,旧行为当场切断。
    // 4 秒长的一句:这样"还没说完"是**确定**的,不受机器快慢影响(1.6 秒那种在全量跑时会来不及)。
    const host = await startWorld({ hangupWaitMs: 20000 }, fakeServices({ herSpeech: tone(4000, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '这一句还没说完。' });
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write');
    await waitFor(() => writes().length >= 1);
    const hung = () => bridge!.requests.filter(r => r.op === 'hangup');
    const reply = await callTool('phone_hangup', { reason: '他说挂吧' });
    expect(reply.failed).toBe(false);
    expect(reply.text).toContain('说完就挂');
    expect(reply.text).toContain('大约还要');
    await new Promise((r) => setTimeout(r, 500));
    // 话还没说完 ⇒ 挂断命令一个字都还没发出去
    expect(hung().length).toBe(0);
    // 说完了它自己发出去(不用她再调一次)
    await waitFor(() => hung().length >= 1, 15000, '挂断命令');
    expect(String(hung()[0]!.args.callId)).toBe(String(bridge!.calls.get('c1')!.id));
    // 挂了以后不再接新句子(等 phone.ended 到了再问 —— 命令发出与通话真正结束之间有几毫秒)
    await waitFor(() => host.events.some((e) => e.type === 'phone.ended'), 8000, 'phone.ended');
    expect((await callTool('phone_say', { text: '挂了以后还想说。' })).failed).toBe(true);
  });

  it('★ 排了很长的一段时挂断:等它说完,不按固定秒数切(2026-10-16 他复测的那条)', async () => {
    // 他那次:她排了约 48 秒的 8 段,挂断请求在开口后 1 秒就到了,旧的 12 秒固定上限把话切在第 13 秒。
    // 现在超过"估算剩余 + hangupWaitMs"才判定卡住 —— 这里给 2 秒余量,6 秒的音频必须念完才挂。
    const host = await startWorld({ hangupWaitMs: 60000 }, fakeServices({ herSpeech: tone(6000, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '这一段很长,不许切。' });
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '开始发音频');
    await callTool('phone_hangup', { reason: '复测' });
    const hung = () => bridge!.requests.filter((r) => r.op === 'hangup');
    await new Promise((r) => setTimeout(r, 3000));
    // 3 秒时(旧行为早就炸了)它一个字都还没发出去:音频还在念
    expect(hung().length).toBe(0);
    await waitFor(() => hung().length >= 1, 15000, '说完了才挂');
    // 而且是在音频基本放完之后才挂的(不是当场)
    const lastWrite = bridge!.requests.filter((r) => r.op === 'audio.write').length;
    expect(lastWrite).toBeGreaterThan(5);
  });

  it('安全上限:她说个不停时,到了 hangupWaitMs 也会挂(不会永远等下去)', async () => {
    // 常规出路是"说完了",上限只在"真的一直说"时兜底 —— 但必须真的兜住:他 2026-10-15 担心的是
    // "挂断迟迟不生效"。这里 8 秒的音频配 3 秒上限 ⇒ 3 秒左右就该挂,并且如实说清为什么。
    const host = await startWorld({ hangupWaitMs: 3000 }, fakeServices({ herSpeech: tone(8000, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '这一段说个不停。' });
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '开始发音频');
    await callTool('phone_hangup', {});
    await waitFor(() => bridge!.requests.some((r) => r.op === 'hangup'), 15000, '到上限之后挂');
    await waitFor(() => host.events.some((e) => e.text?.includes('最多等了')), 8000, '如实说清为什么挂');
  });

  it('★ 桥说"未确认音频到顶"(写死的 60 秒)时:停一下让它排空,换新请求 id 重发同一块,不丢话', async () => {
    // 2026-10-16 实测:她连续说了约 55 秒,桥拒收第 155 块(Too much unconfirmed audio),
    // 后面的音频一个字都没进去(他听到"看看"就断了)。桥的 played 回执只在空闲 drain 时产生,
    // 连续说话就永远不 drain ⇒ 只能主动停一下让它排空。
    let rejectCount = 0;
    const host = await startWorld(
      { flushPauseMs: 20, audioWriteRetries: 2 },
      fakeServices({ herSpeech: tone(1200, 32000) }),
    );
    await connect(host);
    bridge!.onRequest = (op) => {
      if (op !== 'audio.write') return undefined;
      rejectCount += 1;
      return rejectCount <= 2
        ? { ok: false, error: { code: 'BRIDGE_ERROR', message: 'Too much unconfirmed audio; flush before sending more.' } }
        : undefined;
    };
    await callTool('phone_say', { text: '这一块不能被丢掉。' });
    const writes = () => bridge!.requests.filter((r) => r.op === 'audio.write');
    await waitFor(() => writes().length >= 3, 8000, '重发之后被收下');
    const firstPlaybackId = String(writes()[0]!.args.playbackId);
    const forFirst = writes().filter((w) => String(w.args.playbackId) === firstPlaybackId);
    // 同一块问了不止一次,而且**每次都用新的请求 id** —— 上游按"id+参数"把这条拒收也缓存了,
    // 同 id 重问只会把拒收回执原样还回来。
    expect(forFirst.length).toBeGreaterThanOrEqual(2);
    expect(new Set(forFirst.map((w) => w.id)).size).toBe(forFirst.length);
    // 桥后来收下了:没有"发送结果不明"那条通知(即那一块没被丢掉)
    await new Promise((r) => setTimeout(r, 300));
    expect(host.events.some((e) => e.text?.includes('一直没确认收到'))).toBe(false);
  });

  it('★ 接起后第一句之前垫一段静音(暖 QQ 那条媒体通道),而且只垫一次', async () => {
    // 他实测第一句开头被吞("喂，我在"只听到"我在")。音频是完整进了声卡的(逐句标记是
    // "桥确认播放完成"),丢在 QQ 那条通道刚起的时候 ⇒ 垫静音去暖它,而不是拿她的第一个字去暖。
    const host = await startWorld({ warmupMs: 300 }, fakeServices({ herSpeech: tone(800, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '第一句。' });
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write');
    await waitFor(() => writes().length >= 3);
    const bytes = (w: { args: Record<string, unknown> }) =>
      Buffer.from((w.args.frame as { data: string }).data, 'base64');
    const silenceBytes = Math.round(48000 * 2 * 2 * 0.3);   // 桥报的 48k/2ch
    const toneBytes = 48000 * 2 * 2 * 0.8;                  // 800ms 的测试音
    // 第一帧 = 300ms 静音 + 她话的头 100ms ⇒ 开头这一段必须是全零,后面才是声音
    const first = bytes(writes()[0]!);
    expect(first.length).toBe(76800);
    expect(first.subarray(0, silenceBytes).every(b => b === 0)).toBe(true);
    expect(first.subarray(silenceBytes).some(b => b !== 0)).toBe(true);
    expect(writes().slice(0, 3).reduce((n, w) => n + bytes(w).length, 0)).toBe(silenceBytes + toneBytes);
    // 第二句不再垫:它的字节数正好是音频本身
    await callTool('phone_say', { text: '第二句。' });
    await waitFor(() => writes().length >= 5);
    expect(writes().slice(3).reduce((n, w) => n + bytes(w).length, 0)).toBe(toneBytes);
  });

  it('★ 真实那串 75 字符的通话 id 下,请求 id 不越桥的 80 字符上限(那天哑的直接原因)', async () => {
    // 上游 `daemon.mjs:511`:`request.id.length>80` ⇒ INVALID_REQUEST。
    // 真实部署的通话 id 是 `<linkEpoch>:<n>:<nativeId>` 共 75 字符 —— 拿它拼
    // `utt-<通话id>-<序号>` 当**请求 id**,一加前缀就超,桥于是每一块都回"无效请求",
    // 她一个字都出不去(2026-10-15 夜那一通就是这个,而当时 189 条单测全绿:
    // 假桥没校这一条)。播放编号(上限 160)可以有 81 字符,请求 id 不行 —— 两者不是一回事。
    const longCallId = '7e438e01-d9ae-49f9-bf6f-ad6440ada573:0:688b7518-8cd3-4743-9df4-7661c0aa81ac';
    const host = await startWorld({}, fakeServices({ herSpeech: tone(800, 32000) }));
    await connect(host, longCallId);
    await callTool('phone_say', { text: '短句子。' });
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write');
    await waitFor(() => writes().length >= 1);
    for (const write of writes()) {
      expect(write.id).toBeTruthy();
      expect(write.id!.length).toBeLessThanOrEqual(80);
    }
    expect(String(writes()[0]!.args.playbackId).length).toBeGreaterThan(80); // 播放编号本来就长
    await new Promise(r => setTimeout(r, 200));
    // 桥收下了(不是被判无效)⇒ 不会有"没确认收到"那条通知。
    expect(host.events.some(e => e.text?.includes('一直没确认收到'))).toBe(false);
  });
  it('流式多次增量只发固定帧和一个句末尾帧，PCM 总量不变', async () => {
    const pcm = tone(925, 32000);
    const packets: string[] = [];
    for (let i = 0; i < pcm.length; i += 1000) {
      packets.push('data: ' + JSON.stringify({ data: { status: 1, audio: pcm.subarray(i, i + 1000).toString('hex') } }) + '\n\n');
    }
    packets.push('data: {"data":{"status":2}}\n\n');
    const services = (async () => new Response(packets.join(''), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    // 这一条只考"网络分片不改样本",所以把接起后垫的那段静音关掉(它单有一条测试)。
    const host = await startWorld({ warmupMs: 0, tts: { ...PHONE_DEFAULTS.tts, voiceId: 'test', streaming: true } }, services);
    await connect(host);
    await callTool('phone_say', { text: '完整连续。' });
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write');
    await waitFor(() => writes().length >= 3);
    await new Promise(r => setTimeout(r, 100));
    expect(writes().map(r => Buffer.from((r.args.frame as { data: string }).data, 'base64').length)).toEqual([76800, 76800, 24000]);
  });
  it('队列满超过旧的 20 秒截止线，仍重试原块而不跳到下一块', async () => {
    let offset = 0;
    const host = await startWorld({}, fakeServices({ herSpeech: tone(800, 32000) }), () => Date.now() + offset);
    await connect(host);
    bridge!.onRequest = op => op === 'audio.write' ? { ok: false, error: { code: 'FULL', message: 'Audio output queue is full.' } } : undefined;
    await callTool('phone_say', { text: '不自动丢掉。' });
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write');
    await waitFor(() => writes().length >= 2);
    offset = 25000;
    await waitFor(() => writes().length >= 4);
    expect(new Set(writes().map(r => (r.args.frame as { sequence: number }).sequence)).size).toBe(1);
  });
  it('静默后开始长句，也不会积累可突发发送的额度', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(2400, 32000) }));
    await connect(host);
    const writes = () => bridge!.requests.filter(r => r.op === 'audio.write').length;
    await callTool('phone_say', { text: '第一句。' });
    await waitFor(() => writes() === 6);
    // 等前句播放完并留下静默，旧实现会一次塞入新句的几乎全部帧。
    await new Promise(r => setTimeout(r, 1600));
    world!.outputTap()!.onEvent({ type: 'response.created' } as never);
    const before = writes();
    await callTool('phone_say', { text: '第二句。' });
    await new Promise(r => setTimeout(r, 550));
    expect(writes() - before).toBeLessThanOrEqual(3);
  });
  it('本地队列已空但桥仅确认 queued，停止仍清桥；失败如实返回', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(100, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '你好。' });
    await waitFor(() => bridge!.requests.some(r => r.op === 'audio.write'));
    await new Promise(r => setTimeout(r, 80));
    bridge!.onRequest = op => op === 'audio.clear' ? { ok: false, error: { code: 'FAIL', message: 'clear failed' } } : undefined;
    const stop = await callTool('phone_stop');
    expect(stop.failed).toBe(true);
    expect(stop.text).toContain('不能确认');
    expect(bridge!.requests.some(r => r.op === 'audio.clear')).toBe(true);
    bridge!.onRequest = undefined;
    expect((await callTool('phone_stop')).failed).toBe(false);
  });
  it('停止取消未回执的 write，迟到的失败不能让旧块回到队列', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(800, 32000) }));
    await connect(host);
    bridge!.holdOps.add('audio.write');
    await callTool('phone_say', { text: '旧句。' });
    await waitFor(() => bridge!.requests.some(r => r.op === 'audio.write'));
    await callTool('phone_stop');
    bridge!.holdOps.delete('audio.write');
    world!.outputTap()!.onEvent({ type: 'response.created' } as never);
    await callTool('phone_say', { text: '新句。' });
    await waitFor(() => bridge!.requests.filter(r => r.op === 'audio.write').length === 3, 3000);
    expect((await callTool('phone_status')).text).not.toContain('发送结果不明');
  });
  it('交接补当前通话和近期记录，不另建会话、不把 queued 当 played', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(100, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '留在同一通。' });
    await waitFor(() => bridge!.requests.some(r => r.op === 'audio.write'));
    await new Promise(r => setTimeout(r, 40));
    world!.onHandoffEnded();
    await waitFor(() => host.events.some(e => e.type === 'phone.context'));
    const context = host.events.find(e => e.type === 'phone.context')!;
    expect(context.text).toContain('留在同一通');
    expect(context.text).toContain('播放未确认');
    expect(context.text).not.toContain('桥确认播放完成');
  });
  it('真实形状的播放回执更新逐句记录，旧 callId 的回执不算', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(100, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '播放证据。' });
    await waitFor(() => bridge!.requests.some(r => r.op === 'audio.write'));
    const args = bridge!.requests.find(r => r.op === 'audio.write')!.args;
    bridge!.push({ type: 'playback', receipt: { id: args.playbackId, callId: args.callId, state: 'played' } });
    await waitFor(() => (world!.envPromptVars()['phone.state'] ?? '').includes('通话中'));
    await new Promise(r => setTimeout(r, 40));
    bridge!.setPhase('c1', 'ended');
    await waitFor(() => host.events.some(e => e.type === 'phone.ended'));
    expect(host.events.find(e => e.type === 'phone.ended')!.text).toContain('她（桥确认播放完成）：播放证据。');
  });
  it('只播完第一块时，不把尚在本地队列的长句误记为全部完成', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(2000, 32000) }));
    await connect(host);
    await callTool('phone_say', { text: '这句话还有后半段。' });
    await waitFor(() => bridge!.requests.some(r => r.op === 'audio.write'));
    const a = bridge!.requests.find(r => r.op === 'audio.write')!.args;
    bridge!.push({ type: 'playback', receipt: { id: a.playbackId, callId: a.callId, state: 'played' } });
    await new Promise(r => setTimeout(r, 50));
    expect((await callTool('phone_status')).text).not.toContain('桥确认播放完成 1 段');
  });
  it('SSE 首块在结束包到达前进入桥，停止后流不能再喂旧音频', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const services = (async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      init!.signal!.addEventListener('abort', () => { aborted = true; });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const host = await startWorld({ tts: { ...PHONE_DEFAULTS.tts, voiceId: 'test', streaming: true } }, services);
    await connect(host);
    await callTool('phone_say', { text: '流式测试。' });
    await waitFor(() => !!controller);
    controller.enqueue(Buffer.from('data: ' + JSON.stringify({ data: { status: 1, audio: tone(500, 32000).toString('hex') } }) + '\n\n'));
    await waitFor(() => bridge!.requests.some(r => r.op === 'audio.write'));
    expect((await callTool('phone_status')).text).toContain('完整合成 0 段');
    await callTool('phone_stop');
    expect(aborted).toBe(true);
    controller.enqueue(Buffer.from('data: {"data":{"status":2}}\n\n'));
    controller.close();
    await new Promise(r => setTimeout(r, 50));
    expect(bridge!.requests.filter(r => r.op === 'audio.write')).toHaveLength(1);
  });
});

describe('来电 → 接起 → 听见 → 她说话 → 挂断', () => {
  it('白名单来电自动接起,接通后投 phone.connected', async () => {
    const host = await startWorld();
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.requests.some((r) => r.op === 'accept'), 4000, '接听命令');
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    const connected = host.events.find((e) => e.type === 'phone.connected')!;
    expect(connected.text).toContain('【电话】');
    expect(connected.text).toContain(String(HIM));
    expect(connected.origin).toBe('external');
  });

  it('对方说完一句 → 识别 → 当成事件给她', async () => {
    const host = await startWorld();
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1');
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '她听到的一句');
    const speech = host.events.find((e) => e.type === 'phone.speech')!;
    expect(speech.text).toContain('你好呀,我听着呢');
    expect(speech.text).toContain('【电话·对方】');
    expect(speech.origin).toBe('external');
  });

  it('她的正文被切句、合成、写成音频帧发回桥', async () => {
    await startWorld();
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.requests.some((r) => r.op === 'accept'), 6000, '接听命令');
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected', 6000, '桥这边变成已接通');
    const tap = world!.outputTap()!;
    tap.onEvent({ type: 'response.output_text.delta', delta: '我听着呢。你说吧。' } as never);
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '发回桥的音频');
    const write = bridge!.requests.find((r) => r.op === 'audio.write')!;
    const frame = write.args.frame as Record<string, unknown>;
    expect(frame.encoding).toBe('pcm_s16le');
    expect(frame.sampleRate).toBe(48000);
    expect(frame.channels).toBe(2);
    const pcm = Buffer.from(String(frame.data), 'base64');
    expect(pcm.length % 4).toBe(0);
    expect(pcm.length).toBeLessThanOrEqual(48000 * 2 * 2);
    expect(typeof write.args.playbackId).toBe('string');
  });

  it('挂断后投 phone.ended,里面带历时与两边各说了多少', async () => {
    const host = await startWorld();
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1');
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '她听到的一句');
    bridge!.setPhase('c1', 'ended');
    await waitFor(() => host.events.some((e) => e.type === 'phone.ended'));
    const ended = host.events.find((e) => e.type === 'phone.ended')!;
    expect(ended.text).toContain('通话结束');
    expect(ended.text).toContain(String(HIM));
    expect(ended.text).toContain('收到对方 1 条语音事件');
  });
});

describe('规矩', () => {
  it('陌生号直接拒,连响都不让她知道', async () => {
    const host = await startWorld();
    bridge!.ring('c2', '999999');
    await waitFor(() => bridge!.requests.some((r) => r.op === 'reject'), 4000, '拒绝命令');
    expect(bridge!.requests.some((r) => r.op === 'accept')).toBe(false);
    expect(host.events.some((e) => e.type === 'phone.connected')).toBe(false);
    expect(host.events.some((e) => e.text.includes('不在接听名单里'))).toBe(true);
  });

  it('手动模式下不自动接,而是问她一句', async () => {
    const host = await startWorld({ autoAnswer: false });
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.ringing'), 4000, '响铃事件');
    expect(bridge!.requests.some((r) => r.op === 'accept')).toBe(false);
    expect(host.pushOpts.find((_, i) => host.events[i]?.type === 'phone.ringing')?.trigger).toBe('preempt');
  });

  /**
   * 想法一(2026-10-11 他提的):界面驱动那版桥**只看得见像素、报不出号码**,
   * 于是响铃时抓一张来电界面交给她 —— 她读得出图上的名字,自己决定接不接。
   */
  it('★ 响铃时把来电截图当附件投给她,正文指向图、不拿预设号当事实', async () => {
    const host = await startWorld({ autoAnswer: false });
    const png = Buffer.alloc(4096, 9).toString('base64');
    bridge!.onRequest = (op) =>
      op === 'screenshot' ? { ok: true, data: { pngBase64: png, mime: 'image/png', width: 360, height: 640 } } : undefined;
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.ringing'), 4000, '响铃事件');
    const ring = host.events.find((e) => e.type === 'phone.ringing')!;
    expect(bridge!.requests.some((r) => r.op === 'screenshot')).toBe(true);
    expect(ring.blobs).toHaveLength(1);
    expect(ring.blobs![0]!.mime).toBe('image/png');
    expect(ring.blobs![0]!.fallbackText).toContain('截图');
    expect(ring.text).toContain('以图为准');
  });

  it('老桥(不认 screenshot 这个 op)照常响:没有附件,正文里还是桥报的那个号', async () => {
    const host = await startWorld({ autoAnswer: false });
    bridge!.onRequest = (op) =>
      op === 'screenshot' ? { ok: false, error: { code: 'UNKNOWN_OP', message: '不认这个 op' } } : undefined;
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.ringing'), 4000, '响铃事件');
    const ring = host.events.find((e) => e.type === 'phone.ringing')!;
    expect(ring.blobs ?? []).toHaveLength(0);
    expect(ring.text).toContain(String(HIM));
  });

  it('响铃超时自动拒(用户定的 30 秒,测试里改成 1 秒)', async () => {
    const host = await startWorld({ autoAnswer: false, ringTimeoutSec: 1 });
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.requests.some((r) => r.op === 'reject'), 6000, '超时拒绝');
    expect(host.events.some((e) => e.text.includes('自动拒了'))).toBe(true);
  });

  it('她说话时对方一开口:清掉还没放出去的音频,并把这一句按 preempt 投', async () => {
    bridge = new FakeBridge(TOKEN);
    bridge.audioWriteDelayMs = 150;
    const url = await bridge.listen();
    const cfg: PhoneConfigSection = {
      ...structuredClone(PHONE_DEFAULTS),
      enabled: true,
      bridgeUrl: url,
      tokenSecret: 'TEST_PHONE_TOKEN',
      callers: [HIM],
      tts: { ...PHONE_DEFAULTS.tts, streaming: false, voiceId: 'test-voice' },
    };
    world = new PhoneWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir: scratch,
      secret: () => TOKEN,
      fetchImpl: fakeServices({ herSpeech: tone(6000, 32000, 520) }),
    });
    const host = new FakeHost();
    await world.start(host);
    await waitFor(() => bridge!.connected, 5000, '桥连上');

    bridge.ring('c1', String(HIM));
    await waitFor(() => bridge!.requests.some((r) => r.op === 'accept'), 6000, '接听命令');
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    // 她一开口就是一大段(6 秒):发送侧因为写回执慢,队列一直有货。
    world.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我跟你讲啊,这件事是这样的。' } as never);
    await waitFor(() => bridge!.requests.filter((r) => r.op === 'audio.write').length >= 2, 8000, '开始发音频');

    await feedSpeech('c1', 900);
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.clear'), 8000, '清队列');
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '她听到的那一句');
    const index = host.events.findIndex((e) => e.type === 'phone.speech');
    expect(host.pushOpts[index]?.trigger).toBe('preempt');
  });

  it('★ 一小块响动不到门槛就不算抢话 —— 实测那次打断她的是一块不到 400 毫秒的脉冲', async () => {
    await startWorld({}, fakeServices({ herSpeech: tone(6000, 32000, 520) }));
    bridge!.audioWriteDelayMs = 150;
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我跟你讲啊,这件事是这样的。' } as never);
    await waitFor(() => bridge!.requests.filter((r) => r.op === 'audio.write').length >= 2, 8000, '开始发音频');

    await feedSpeech('c1', 300); // 300 毫秒 < 门槛 500
    await new Promise((r) => setTimeout(r, 400));
    expect(bridge!.requests.some((r) => r.op === 'audio.clear')).toBe(false);

    await feedSpeech('c1', 900); // 够久了 —— 这时才该清
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.clear'), 8000, '清队列');
  });

  it('门槛是旋钮:调大到 2000 毫秒,900 毫秒的话就不算抢话', async () => {
    await startWorld({ bargeInMinMs: 2000 }, fakeServices({ herSpeech: tone(6000, 32000, 520) }));
    bridge!.audioWriteDelayMs = 150;
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我跟你讲啊,这件事是这样的。' } as never);
    await waitFor(() => bridge!.requests.filter((r) => r.op === 'audio.write').length >= 2, 8000, '开始发音频');

    await feedSpeech('c1', 900);
    await new Promise((r) => setTimeout(r, 400));
    expect(bridge!.requests.some((r) => r.op === 'audio.clear')).toBe(false);
  });

  it('往外写音频按播放的速度走:一整句不会一口气灌满桥那条 2 秒队列', async () => {
    await startWorld({}, fakeServices({ herSpeech: tone(6000, 32000, 520) }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    const writes = (): number => bridge!.requests.filter((r) => r.op === 'audio.write').length;

    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '这一句话很长,长到要分成十几块才发得完。' } as never);
    await waitFor(() => writes() >= 2, 8000, '开始发音频');
    await new Promise((r) => setTimeout(r, 700));

    // 6 秒音频 = 15 块(每块 400ms)。配速之后 700 毫秒里发不出十几块;没配速时会一口气全灌进去
    // —— 那正是 2026-10-09 "Audio output queue is full" 丢掉她 2.8 秒音频的成因。
    expect(writes()).toBeLessThanOrEqual(6);
  });

  it('★ 长到不像脉冲却一个字都没认出来:告诉她"没听清",不静默丢掉', async () => {
    const host = await startWorld({}, fakeServices({ asrText: '' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');

    await feedSpeech('c1', 2000); // 2 秒 —— 不像脉冲,该说"没听清"
    await waitFor(() => host.events.some((e) => e.text.includes('没听清')), 8000, '没听清那条');

    await feedSpeech('c1', 600); // 短的那一段照旧当噪声丢掉
    await new Promise((r) => setTimeout(r, 600));
    expect(host.events.filter((e) => e.text.includes('没听清'))).toHaveLength(1);
  });

  it('★ 桥那条队列满时:那一块放回队首重试,**一块都不丢**', async () => {
    await startWorld({}, fakeServices({ herSpeech: tone(2400, 32000, 520) })); // 2.4 秒 = 6 块
    let full = true;
    bridge!.onRequest = (op) =>
      op === 'audio.write' && full
        ? { ok: false, error: { code: 'BRIDGE_ERROR', message: 'Audio output queue is full.' } }
        : undefined;
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我跟你讲啊,这件事是这样的。' } as never);

    const sequences = (): Set<number> =>
      new Set(
        bridge!.requests
          .filter((r) => r.op === 'audio.write')
          .map((r) => (r.args.frame as { sequence?: number } | undefined)?.sequence)
          .filter((s): s is number => typeof s === 'number'),
      );
    await waitFor(() => bridge!.requests.filter((r) => r.op === 'audio.write').length >= 3, 8000, '撞上满队列');

    full = false; // 队列通了
    await waitFor(() => sequences().size >= 6, 15000, '把丢掉的那几块补上来');
  });

  it('★ 她自己按停(phone_stop):没念完的收掉,这一轮剩下的不再念', async () => {
    await startWorld({}, fakeServices({ herSpeech: tone(4000, 32000, 520) }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    const writes = (): number => bridge!.requests.filter((r) => r.op === 'audio.write').length;
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我跟你讲啊,这件事是这样的。' } as never);
    await waitFor(() => writes() >= 2, 8000, '开始发音频');

    const stop = world!.tools().find((t) => t.name === 'phone_stop')!;
    expect(String(await stop.handler({}, {} as never))).toContain('停');
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.clear'), 8000, '清队列');

    // 这一轮剩下的话不再念(否则她会一边说"好我停了"一边把后半段念完)
    const before = writes();
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '后半段不该念出来。' } as never);
    await new Promise((r) => setTimeout(r, 600));
    expect(writes()).toBe(before);

    // 下一轮照常能说
    world!.outputTap()!.onEvent({ type: 'response.created' } as never);
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '下一轮可以说了。' } as never);
    await waitFor(() => writes() > before, 8000, '新一轮出声');
  });

  it('★ 长到不像脉冲、正文却短得不可能:当成"没听清"投给她', async () => {
    const host = await startWorld({}, fakeServices({ asrText: '段。' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    await feedSpeech('c1', 6000); // 6 秒却只有两个字的正文 ⇒ 每秒钟不到半个字,不可能是一句话
    await waitFor(() => host.events.some((e) => e.text.includes('没听清')), 8000, '没听清那条');
  });

  it('★ "说够了"的闸门是**每一轮**的额度:下一轮照常出声(整通只复位一次会让后面全哑)', async () => {
    await startWorld({ maxSpeakSec: 1 }, fakeServices({ herSpeech: tone(1200, 32000, 520) }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    const writes = (): number => bridge!.requests.filter((r) => r.op === 'audio.write').length;

    // 第一轮说两句:第一句就把额度(1 秒)用掉了,第二句该被拦住
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '第一句我多说几个字。' } as never);
    await waitFor(() => writes() >= 3, 8000, '第一句出声');
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '第二句应该被拦下。' } as never);
    await new Promise((r) => setTimeout(r, 500));
    const afterFirstRound = writes();
    expect(afterFirstRound).toBeLessThanOrEqual(4);

    // 新一轮:额度重来 —— 这是他那通"看得到回复听不到声"的那一条
    world!.outputTap()!.onEvent({ type: 'response.created' } as never);
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '新一轮我还能说话。' } as never);
    await waitFor(() => writes() > afterFirstRound + 1, 8000, '新一轮出声');
  });

  it('★ 桥那条队列一直满:卡够久才提醒她一次(几帧抖动不惊动,一通也只说一次)', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(800, 32000, 520) }));
    bridge!.onRequest = (op) =>
      op === 'audio.write'
        ? { ok: false, error: { code: 'BRIDGE_ERROR', message: 'Audio output queue is full.' } }
        : undefined;
    bridge!.ring('c1', String(HIM));
    await waitFor(() => bridge!.calls.get('c1')?.state === 'connected');
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我说一句。' } as never);
    await waitFor(() => host.events.some((e) => e.text.includes('音频队列持续满')), 10000, '那一声提醒');
    await new Promise((r) => setTimeout(r, 1200));
    expect(host.events.filter((e) => e.text.includes('音频队列持续满'))).toHaveLength(1);
  });

  it('通话卡在 rejecting 太久:报出来,并说清自愈命令没配', async () => {
    const host = await startWorld({ stuckSec: 1 });
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    bridge!.setPhase('c1', 'rejecting');
    await waitFor(() => host.events.some((e) => e.text.includes('卡在')), 6000, '卡住那条通知');
    const notice = host.events.find((e) => e.text.includes('卡在'))!;
    expect(notice.type).toBe('phone.notice');
    expect(notice.origin).toBe('internal');
    expect(notice.text).toContain('recoverCommand');
  });
});

describe('工具回执', () => {
  it('phone_status 说清有没有通话、名单、桥通不通', async () => {
    await startWorld();
    const status = world!.tools().find((t) => t.name === 'phone_status')!;
    const text = String(await status.handler({}, {} as never));
    expect(text).toContain('现在没有通话');
    expect(text).toContain(String(HIM));
    expect(text).toContain('桥连着');
  });

  it('phone_hangup 在没有通话时明确失败', async () => {
    await startWorld();
    const hangup = world!.tools().find((t) => t.name === 'phone_hangup')!;
    const outcome = (await hangup.handler({}, {} as never)) as { text: string; failed?: boolean };
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('没有通话');
  });

  it('phone_answer 在无来电时明确失败', async () => {
    await startWorld();
    const answer = world!.tools().find((t) => t.name === 'phone_answer')!;
    const outcome = (await answer.handler({}, {} as never)) as { text: string; failed?: boolean };
    expect(outcome.failed).toBe(true);
  });

  it('接起时的回执说清"submitted ≠ 接通"', async () => {
    const host = await startWorld({ autoAnswer: false });
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.ringing'), 4000, '响铃事件');
    const answer = world!.tools().find((t) => t.name === 'phone_answer')!;
    const outcome = String(await answer.handler({}, {} as never));
    expect(outcome).toContain('submitted');
    expect(outcome).toContain('通话中');
  });

  /**
   * 2026-10-10 实测:她两次 phone_hangup 都失败,上游那句理由是
   * 「Requires an exact audited QQ library…」—— 看着像"这个 QQ 版本不支持挂断",
   * 其实是云上那个宿主正在自杀重启(通话由对方结束时它就这样),那几秒原生能力没就绪。
   */
  const AUDIT_REFUSAL = {
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'Requires an exact audited QQ library, build, platform and architecture.',
  };

  it('★ 挂断第一次失败会**自动再试一次**;两次都失败就把出路说清,并带上上游的码', async () => {
    // 2026-10-15 起挂断是"排队 + 看护发命令",所以那两条结果走**通知**告诉她,不再是工具回执。
    const host = await startWorld({ hangupWaitMs: 20000 }, fakeServices({ herSpeech: tone(300, 32000) }));
    await connect(host);
    bridge!.onRequest = (op) => (op === 'hangup' ? { ok: false, error: AUDIT_REFUSAL } : undefined);
    const reply = await callTool('phone_hangup', { reason: '他说挂吧' });
    expect(reply.failed).toBe(false);
    await waitFor(() => host.events.some((e) => e.text?.includes('挂断没发成功')), 12000, '挂断失败的通报');
    // 试了两次(不是试一次就放手)
    expect(bridge!.requests.filter((r) => r.op === 'hangup')).toHaveLength(2);
    const note = host.events.find((e) => e.text?.includes('挂断没发成功'))!.text!;
    // 码要在里面:那条误导人的理由光看 message 认不出是什么毛病
    expect(note).toContain('CAPABILITY_UNAVAILABLE');
    // 出路要给她:让他挂,而不是让她自己反复试
    expect(note).toContain('你挂一下');
  });

  it('挂断第一次失败、第二次成了:如实说是哪一次成的', async () => {
    const host = await startWorld({ hangupWaitMs: 20000 }, fakeServices({ herSpeech: tone(300, 32000) }));
    await connect(host);
    let attempts = 0;
    bridge!.onRequest = (op) => {
      if (op !== 'hangup') return undefined;
      attempts += 1;
      return attempts === 1 ? { ok: false, error: AUDIT_REFUSAL } : undefined; // 第二次走默认回执 = 成功
    };
    await callTool('phone_hangup', {});
    await waitFor(() => host.events.some((e) => e.text?.includes('这次发出去了')), 12000, '挂断第二次成功的通报');
    expect(attempts).toBe(2);
    const note = host.events.find((e) => e.text?.includes('这次发出去了'))!.text!;
    expect(note).toContain('第一次没成功');
  });
});

describe('phone_say:她自己开口(2026-10-14 补的那条路)', () => {
  it('通话中调它:那句话被合成、写成音频帧发回桥 —— 与正文同一条路', async () => {
    const host = await startWorld();
    await connect(host);
    const receipt = await callTool('phone_say', { text: '喂,我在。' });
    expect(receipt.failed).toBe(false);
    expect(receipt.text).toContain('喂,我在');
    expect(receipt.text).toContain('交给合成');
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '发回桥的音频');
  });

  it('没接通时调:回执明说"这一句没有被念出去"(刚拨出去、那头还没接起就是这一种)', async () => {
    await startWorld();
    const none = await callTool('phone_say', { text: '喂?' });
    expect(none.failed).toBe(true);
    expect(none.text).toContain('没有被念出去');
    expect(none.text).toContain('没有通话');

    // 拨出去、还在 dialing —— 她最容易在这几秒里以为自己在说话。
    bridge!.ring('c2', String(HIM), { direction: 'outgoing', state: 'dialing' });
    await new Promise((r) => setTimeout(r, 200));
    const dialing = await callTool('phone_say', { text: '喂,你接一下?' });
    expect(dialing.failed).toBe(true);
    expect(dialing.text).toContain('没有被念出去');
    expect(bridge!.requests.some((r) => r.op === 'audio.write')).toBe(false);
  });

  it('text 是空的:明确回绝,不发音频', async () => {
    const host = await startWorld();
    await connect(host);
    const receipt = await callTool('phone_say', { text: '   ' });
    expect(receipt.failed).toBe(true);
    expect(receipt.text).toContain('空的');
    expect(bridge!.requests.some((r) => r.op === 'audio.write')).toBe(false);
  });

  it('只有表情/记号的一句不值得花钱念:如实回绝', async () => {
    const host = await startWorld();
    await connect(host);
    const receipt = await callTool('phone_say', { text: '😊😊' });
    expect(receipt.failed).toBe(true);
    expect(receipt.text).toContain('没有能念的字');
    expect(bridge!.requests.some((r) => r.op === 'audio.write')).toBe(false);
  });

  it('★ 一轮里同一句只说一遍:正文与 phone_say 撞同一句,不去重他就会听两遍', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(400, 32000, 520) }));
    await connect(host);
    const writes = (): number => bridge!.requests.filter((r) => r.op === 'audio.write').length;

    // 正文这条路照旧会被念(兼容改写之前的用法)
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我在呢。' } as never);
    await waitFor(() => writes() >= 1, 8000, '正文念出去');
    await new Promise((r) => setTimeout(r, 300));
    const afterProse = writes();

    const receipt = await callTool('phone_say', { text: '我在呢。' });
    expect(receipt.failed).toBe(false);
    expect(receipt.text).toContain('已经提交过');
    await new Promise((r) => setTimeout(r, 500));
    expect(writes()).toBe(afterProse);

    // 新一轮里同一句照念(那是她的本意,不是重复)
    world!.outputTap()!.onEvent({ type: 'response.created' } as never);
    const again = await callTool('phone_say', { text: '我在呢。' });
    expect(again.failed).toBe(false);
    await waitFor(() => writes() > afterProse, 8000, '新一轮里同一句照念');
  });

  it('★ 半句不带句号的正文(留在一轮收尾时才念的那条尾巴)也不算第二遍', async () => {
    const host = await startWorld({}, fakeServices({ herSpeech: tone(400, 32000, 520) }));
    await connect(host);
    const writes = (): number => bridge!.requests.filter((r) => r.op === 'audio.write').length;

    // 正文没有句末标点 ⇒ 它一直留在缓冲里,要到"一轮收尾"才合成(那条尾巴最容易漏去重)
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '我在呢' } as never);
    await new Promise((r) => setTimeout(r, 200));
    expect(writes()).toBe(0);

    const receipt = await callTool('phone_say', { text: '我在呢' });
    expect(receipt.failed).toBe(false);
    await waitFor(() => writes() >= 1, 8000, 'phone_say 出声');
    await new Promise((r) => setTimeout(r, 300));
    const afterSay = writes();

    // 收尾:那条尾巴与 phone_say 说的是同一句,不该再念一遍
    world!.outputTap()!.onRoundEnd!();
    await new Promise((r) => setTimeout(r, 500));
    expect(writes()).toBe(afterSay);
  });

  it('她自己按过停(phone_stop)之后,这一轮再调 phone_say:回绝,不出声', async () => {
    const host = await startWorld();
    await connect(host);
    const stop = await callTool('phone_stop');
    expect(stop.failed).toBe(false);

    const muted = await callTool('phone_say', { text: '再说一句。' });
    expect(muted.failed).toBe(true);
    expect(muted.text).toContain('phone_stop');
    expect(bridge!.requests.some((r) => r.op === 'audio.write')).toBe(false);

    // 下一轮照常能说 —— 停只是一轮的事
    world!.outputTap()!.onEvent({ type: 'response.created' } as never);
    const next = await callTool('phone_say', { text: '下一轮我说这句。' });
    expect(next.failed).toBe(false);
  });

  it('★ 这一轮的额度用完了:如实说"没念出去",不骗她说他听到了', async () => {
    const host = await startWorld({ maxSpeakSec: 1 }, fakeServices({ herSpeech: tone(400, 32000, 520) }));
    await connect(host);
    const first = await callTool('phone_say', { text: '第一句我多说几个字。' });
    expect(first.failed).toBe(false);

    const second = await callTool('phone_say', { text: '第二句应该被挡下。' });
    expect(second.failed).toBe(true);
    expect(second.text).toContain('没念出去');
  });

  it('电话接通那条通知里就写着"你从哪儿出声"(她第一次能开口的现场提示)', async () => {
    const host = await startWorld();
    await connect(host);
    const connected = host.events.find((e) => e.type === 'phone.connected')!;
    expect(connected.text).toContain('phone_say');
    expect(connected.text).toContain('别沉默');
  });

  it('她调 phone_say 说的那句算进"你出声 N 段",并进这一通的逐句记录', async () => {
    const host = await startWorld();
    await connect(host);
    await callTool('phone_say', { text: '我在呢。' });
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '发回桥的音频');
    bridge!.setPhase('c1', 'ended');
    await waitFor(() => host.events.some((e) => e.type === 'phone.ended'));
    const ended = host.events.find((e) => e.type === 'phone.ended')!;
    expect(ended.text).toContain('完整合成 1 段');
    expect(ended.text).toContain('我在呢。');
  });
});

describe('隧道起不来时不许装死(2026-10-09 云上实测过的那件事)', () => {
  it('ssh 一起就死:那条原因要变成一条她能看见的事件,而不是只在空气里', async () => {
    bridge = new FakeBridge(TOKEN);
    const url = await bridge.listen();
    // 假 ssh:立刻吐一句错然后死掉(真事:Windows 自带 ssh 嫌私钥权限太开放)。
    const children: Array<import('node:events').EventEmitter & { stderr: import('node:events').EventEmitter; exitCode: number | null; killed: boolean; kill(): boolean }> = [];
    const spawnImpl = (() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        exitCode: null as number | null,
        killed: false,
        kill() {
          this.killed = true;
          return true;
        },
      });
      children.push(child);
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('Bad permissions. UNPROTECTED PRIVATE KEY FILE!'));
        child.emit('close', 255);
      }, 5);
      return child;
    }) as never;

    const cfg: PhoneConfigSection = {
      ...structuredClone(PHONE_DEFAULTS),
      enabled: true,
      bridgeUrl: url,
      tokenSecret: 'TEST_PHONE_TOKEN',
      callers: [HIM],
      ssh: { ...PHONE_DEFAULTS.ssh, enabled: true, host: '203.0.113.10', keyFile: 'C:/keys/phone-tunnel-key' },
    };
    world = new PhoneWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir: scratch,
      secret: () => TOKEN,
      fetchImpl: fakeServices(),
      spawnImpl,
    });
    const host = new FakeHost();
    await world.start(host);
    await waitFor(() => host.events.some((e) => e.text.includes('隧道起不来')), 4000, '隧道那条通知');
    const notice = host.events.find((e) => e.text.includes('隧道起不来'))!;
    expect(notice.type).toBe('phone.notice');
    expect(notice.origin).toBe('internal');
    expect(notice.text).toContain('UNPROTECTED PRIVATE KEY FILE');
  });
});

describe('三处实测踩出来的规矩(2026-10-09 他打过来"被拒绝 / 打不通")', () => {
  it('★ 已经过期的邀请**不许接** —— 接了会把桥卡住', async () => {
    const host = await startWorld({ ringTimeoutSec: 30 });
    // 一通躺在那里 5 分钟的"响铃"(他重启时那通 17:14 的邀请就是这样)
    bridge!.ring('c1', String(HIM), { createdAt: Date.now() - 5 * 60_000 });
    await waitFor(() => bridge!.requests.some((r) => r.op === 'reject'), 6000, '拒绝命令');
    expect(bridge!.requests.some((r) => r.op === 'accept')).toBe(false);
    const notice = host.events.find((e) => e.text.includes('早没人等了'))!;
    expect(notice.text).toContain('会把桥卡住');
  });

  it('★ 号码还没报上来时先等一等,别把正经来电当陌生号拒掉', async () => {
    bridge = new FakeBridge(TOKEN);
    const url = await bridge.listen();
    const cfg: PhoneConfigSection = {
      ...structuredClone(PHONE_DEFAULTS),
      enabled: true,
      bridgeUrl: url,
      tokenSecret: 'TEST_PHONE_TOKEN',
      callers: [HIM],
      tts: { ...PHONE_DEFAULTS.tts, streaming: false, voiceId: 'test-voice' },
    };
    world = new PhoneWorld({ cfg, timezone: 'Asia/Shanghai', dataDir: scratch, secret: () => TOKEN, fetchImpl: fakeServices() });
    const host = new FakeHost();
    await world.start(host);
    await waitFor(() => bridge!.connected, 5000, '桥连上');

    // 上游的真实顺序:先一条只有 id 的(号码是 unknown),几十毫秒后才补上真号。
    bridge.ring('c1', 'unknown');
    await new Promise((r) => setTimeout(r, 120));
    bridge.update('c1', { targetId: String(HIM) });
    await waitFor(() => bridge!.requests.some((r) => r.op === 'accept'), 6000, '接听命令');
    expect(bridge!.requests.some((r) => r.op === 'reject')).toBe(false);
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'), 6000, '接通事件');
  });

  it('★ 学会一次映射:先只报 uid、随后补上号码 ⇒ 下一通只报 uid 也认得', async () => {
    const UID = 'u_example000000000000000';
    const host = await startWorld();
    // 第一通:先 uid,再补号码 —— 这一通应该在宽限期内被接起,顺便把映射学到。
    bridge!.ring('c1', UID);
    await new Promise((r) => setTimeout(r, 120));
    bridge!.update('c1', { targetId: String(HIM) });
    await waitFor(() => bridge!.requests.some((r) => r.op === 'accept'), 6000, '第一通接听');
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'), 6000, '第一通接通');
    bridge!.setPhase('c1', 'ended');

    // 第二通:只报 uid,**不再补号码** —— 靠学到的映射也要接。
    bridge!.ring('c2', UID);
    await waitFor(() => bridge!.requests.filter((r) => r.op === 'accept').length >= 2, 6000, '第二通接听(靠学到的映射)');
    expect(bridge!.requests.filter((r) => r.op === 'reject').length).toBe(0);
  });

  it('号码一直没报上来:等过头了还是按陌生号处理(不能永远不响)', async () => {
    await startWorld({ autoAnswer: true, rejectUnknown: true });
    bridge!.ring('c2', 'unknown');
    await waitFor(() => bridge!.requests.some((r) => r.op === 'reject'), 9000, '等到宽限过去后拒绝');
    expect(bridge!.requests.some((r) => r.op === 'accept')).toBe(false);
  });

  it('★ 卡在 `ending` 上也要认出来(拒绝那一侧的卡法,上一版不认识它)', async () => {
    const host = await startWorld({ stuckSec: 1 });
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    bridge!.setPhase('c1', 'ending');
    await waitFor(() => host.events.some((e) => e.text.includes('卡在「ending」')), 6000, '卡在 ending 那条通知');
    expect(host.events.find((e) => e.text.includes('卡在「ending」'))!.text).toContain('recoverCommand');
  });

  it('★ 桥卡在"还有一条命令没完成"上:连败三次就说出来(并尝试自愈)', async () => {
    const host = await startWorld();
    bridge!.onRequest = (op) =>
      op === 'reject' || op === 'accept'
        ? { ok: false, error: { code: 'BUSY', message: 'Another control is pending or the call is in the wrong phase' } }
        : undefined;
    // 三次陌生号 = 三次 reject 全失败。
    for (const id of ['x1', 'x2', 'x3']) {
      bridge!.ring(id, '999999');
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitFor(() => host.events.some((e) => e.text.includes('桥卡住')), 6000, '卡住那条通知');
    const notice = host.events.find((e) => e.text.includes('桥卡住'))!;
    expect(notice.type).toBe('phone.notice');
    expect(notice.text).toContain('recoverCommand');
  });
});

describe('World 比来电晚一步也能接上(2026-10-09 栽过的那个坑)', () => {
  it('连上时桥那边正响着一通在名单里的来电 ⇒ 照样接', async () => {
    bridge = new FakeBridge(TOKEN);
    const url = await bridge.listen();
    // 先把来电摆在桥那边(**World 还没连上**,所以这条推送没人收)。
    bridge.ring('late', String(HIM));
    const cfg: PhoneConfigSection = {
      ...structuredClone(PHONE_DEFAULTS),
      enabled: true,
      bridgeUrl: url,
      tokenSecret: 'TEST_PHONE_TOKEN',
      callers: [HIM],
      tts: { ...PHONE_DEFAULTS.tts, streaming: false, voiceId: 'test-voice' },
    };
    world = new PhoneWorld({ cfg, timezone: 'Asia/Shanghai', dataDir: scratch, secret: () => TOKEN, fetchImpl: fakeServices() });
    const host = new FakeHost();
    await world.start(host);
    // 连上时那包 `hello` 里带着这通 —— 要能认出来并接。
    await waitFor(() => bridge!.requests.some((r) => r.op === 'accept'), 6000, '接听命令');
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'), 6000, '接通事件');
    expect(host.events.find((e) => e.type === 'phone.connected')!.text).toContain(String(HIM));
  });
});

describe('连不上桥时不许装死', () => {
  it('接听名单空着:启动时就把这件事说出来(谁都打不进来是配错,不是静音)', async () => {
    const host = await startWorld({ callers: [] });
    const notice = host.events.find((e) => e.type === 'phone.notice' && e.text.includes('接听名单是空的'));
    expect(notice).toBeDefined();
    expect(notice!.text).toContain('config.json');
  });

  it('填了名单:启动时把接谁说出来', async () => {
    const host = await startWorld();
    expect(host.events.some((e) => e.text.includes(String(HIM)))).toBe(true);
  });

  it('没配令牌:明确说缺什么,而不是静静什么都不发生', async () => {
    bridge = new FakeBridge(TOKEN);
    const url = await bridge.listen();
    const cfg: PhoneConfigSection = { ...structuredClone(PHONE_DEFAULTS), enabled: true, bridgeUrl: url, tokenSecret: 'MISSING' };
    world = new PhoneWorld({ cfg, timezone: 'Asia/Shanghai', dataDir: scratch, secret: () => '', fetchImpl: fakeServices() });
    const host = new FakeHost();
    await world.start(host);
    expect(host.events.some((e) => e.text.includes('没拿到桥的令牌'))).toBe(true);
    expect(host.events[0]!.origin).toBe('internal');
  });
});

describe('她主动拨给他(phone_dial)', () => {
  const ME = 'u_example000000000000000';
  const dial = () => world!.tools().find((t) => t.name === 'phone_dial')!;
  /**
   * 真桥在 dial 之后会把这一通当 `outgoing` 推回来(守护进程先 ingest 再回执),
   * 而且**接通是异步的**:先 `dialing`,他真接了才是 `connected`。
   * `connect: false` 就是"拨出去了、但他没接"那条路。
   */
  const answerDialWithCall = (callId: string, connect = true): void => {
    bridge!.onRequest = (op, args) => {
      if (op === 'dial') {
        bridge!.ring(callId, String(args.targetId), { direction: 'outgoing', state: 'dialing' });
        if (connect) setTimeout(() => bridge!.setPhase(callId, 'connected'), 10);
      }
      return undefined;
    };
  };

  it('没配拨号目标:明确说拨不出去,一个命令都不发', async () => {
    await startWorld(); // 默认 dial.target = ''
    const outcome = (await dial().handler({}, {} as never)) as { text: string; failed?: boolean };
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('没配拨号目标');
    expect(bridge!.requests.some((r) => r.op === 'dial')).toBe(false);
  });

  it('配了目标:按上游那条帧发出去 —— 目标是 uid、media 是 audio', async () => {
    await startWorld({ dial: { target: ME, label: '他' } });
    const text = String(await dial().handler({}, {} as never));
    await waitFor(() => bridge!.requests.some((r) => r.op === 'dial'), 4000, '拨号命令');
    expect(bridge!.requests.find((r) => r.op === 'dial')!.args).toMatchObject({
      kind: 'direct',
      targetId: ME,
      media: 'audio',
    });
    expect(text).toContain('他');
    // 回执必须保持"命令交出去了 ≠ 接通了"那个口径(与接听一样)。
    expect(text).toContain('submitted');
  });

  it('通话中不能拨:本地先拦下,不把上游那句英文错误抛给她', async () => {
    const host = await startWorld({ dial: { target: ME, label: '他' } });
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    const outcome = (await dial().handler({}, {} as never)) as { text: string; failed?: boolean };
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('不能同时拨');
    expect(bridge!.requests.some((r) => r.op === 'dial')).toBe(false);
  });

  it('桥没连着:也说清楚,不是静默失败', async () => {
    world = new PhoneWorld({
      cfg: {
        ...structuredClone(PHONE_DEFAULTS),
        enabled: true,
        // 指一个没人听的口:桥这一路永远连不上。
        bridgeUrl: 'ws://127.0.0.1:1/v1/stream',
        tokenSecret: 'TEST_PHONE_TOKEN',
        callers: [HIM],
        dial: { target: ME, label: '他' },
      },
      timezone: 'Asia/Shanghai',
      dataDir: scratch,
      secret: () => TOKEN,
      fetchImpl: fakeServices(),
    });
    await world.start(new FakeHost());
    const outcome = (await world.tools().find((t) => t.name === 'phone_dial')!.handler({}, {} as never)) as {
      text: string;
      failed?: boolean;
    };
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('桥没连着');
  });

  it('★ 她拨的那通他接了:事件说"拨出",通话本身照常跑', async () => {
    const host = await startWorld({ dial: { target: ME, label: '他' } });
    answerDialWithCall('out1');
    await dial().handler({}, {} as never);
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'), 6000, '接通事件');
    const connected = host.events.find((e) => e.type === 'phone.connected')!;
    expect(connected.text).toContain('拨出');
    expect(connected.text).toContain(ME);
    expect(host.events.some((e) => e.type === 'phone.outgoingFailed')).toBe(false);
  });

  it('★ 她拨的那通从头到尾没接通:必须说一声(不然她会以为打成了)', async () => {
    const host = await startWorld({ dial: { target: ME, label: '他' } });
    answerDialWithCall('out2', false);
    await dial().handler({}, {} as never);
    await waitFor(() => bridge!.calls.get('out2') !== undefined, 4000, '那通出现');
    bridge!.setPhase('out2', 'ended');
    await waitFor(() => host.events.some((e) => e.type === 'phone.outgoingFailed'), 6000, '没接通那条');
    const failed = host.events.find((e) => e.type === 'phone.outgoingFailed')!;
    expect(failed.text).toContain('没接通');
    expect(failed.text).toContain('phone_dial');
    // 没接通就没有"通话结束"那条(她压根没进过这一通)。
    expect(host.events.some((e) => e.type === 'phone.ended')).toBe(false);
  });
});

describe('通话记录:挂断时把两边说过的话打包给她', () => {
  it('★ 他说的与她真正念出去的都在 phone.ended 正文里', async () => {
    const host = await startWorld({}, fakeServices({ asrText: '你吃饭了吗' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1');
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '她听到的一句');
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '吃了，你呢。' } as never);
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '她的声音发出去');
    bridge!.setPhase('c1', 'ended');
    await waitFor(() => host.events.some((e) => e.type === 'phone.ended'), 6000, '收尾事件');
    const ended = host.events.find((e) => e.type === 'phone.ended')!;
    expect(ended.text).toContain('这一通的记录');
    expect(ended.text).toContain('他：你吃饭了吗');
    expect(ended.text).toContain('吃了，你呢。');
  });

  it('没念出去的话不进记录 —— 记录是"他真听到的",不是"她写了什么"', async () => {
    const host = await startWorld({ maxSpeakSec: 1 }, fakeServices({ herSpeech: tone(1200, 32000, 520) }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    // 第一句就把这一轮的额度用掉,第二句会被那道闸门拦在门外、一个字都不会念出去。
    world!.outputTap()!.onEvent({ type: 'response.output_text.delta', delta: '第一句我多说几个字。第二句应该被拦下。' } as never);
    await waitFor(() => bridge!.requests.some((r) => r.op === 'audio.write'), 8000, '第一句出声');
    await new Promise((r) => setTimeout(r, 500));
    bridge!.setPhase('c1', 'ended');
    await waitFor(() => host.events.some((e) => e.type === 'phone.ended'), 6000, '收尾事件');
    const ended = host.events.find((e) => e.type === 'phone.ended')!;
    expect(ended.text).toContain('第一句我多说几个字');
    expect(ended.text).not.toContain('第二句应该被拦下');
  });

  it('一句都没说过的一通:不挂一个空的记录壳', async () => {
    const host = await startWorld();
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    bridge!.setPhase('c1', 'ended');
    await waitFor(() => host.events.some((e) => e.type === 'phone.ended'), 6000, '收尾事件');
    expect(host.events.find((e) => e.type === 'phone.ended')!.text).not.toContain('这一通的记录');
  });
});

describe('耳朵那两条:猜错的语言 / 他一直没被听见', () => {
  it('★ 碎片段被猜成日文:不投给她,而是当成"没听清"', async () => {
    const host = await startWorld({}, fakeServices({ asrText: 'やて。' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1', 2000);
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '一句');
    const speech = host.events.find((e) => e.type === 'phone.speech')!;
    expect(speech.text).toContain('没听清');
    expect(speech.text).not.toContain('やて');
  });

  it('配成中文之后:一个汉字都没有的正文也算"没听清"', async () => {
    const host = await startWorld({ asr: { ...PHONE_DEFAULTS.asr, language: 'zh' } }, fakeServices({ asrText: 'Yeah.' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1', 2000);
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '一句');
    expect(host.events.find((e) => e.type === 'phone.speech')!.text).toContain('没听清');
  });

  it('auto 下的英文短词**不误杀** —— 那可能就是他真说的', async () => {
    const host = await startWorld({}, fakeServices({ asrText: 'OK' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1', 1200);
    await waitFor(() => host.events.some((e) => e.type === 'phone.speech'), 8000, '一句');
    const speech = host.events.find((e) => e.type === 'phone.speech')!;
    expect(speech.text).toContain('OK');
    expect(speech.text).not.toContain('没听清');
  });

  it('★ 连着三段一个字都没认出来:明说"他这一通几乎没被听见",而且只说一次', async () => {
    const host = await startWorld({}, fakeServices({ asrText: '' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    for (let i = 0; i < 3; i += 1) await feedSpeech('c1', 2000);
    await waitFor(
      () => host.events.some((e) => e.type === 'phone.notice' && e.text.includes('没认出来')),
      10000,
      '那一句提醒',
    );
    const notes = host.events.filter((e) => e.type === 'phone.notice' && e.text.includes('没认出来'));
    expect(notes).toHaveLength(1);
    // 要给她**可行动**的出路,不能只说"听不见"。
    expect(notes[0]!.text).toContain('打字');
    expect(notes[0]!.origin).toBe('internal');
    // 再来一段也不会说第二遍(一通只说一次)。
    await feedSpeech('c1', 2000);
    await new Promise((r) => setTimeout(r, 400));
    expect(host.events.filter((e) => e.type === 'phone.notice' && e.text.includes('没认出来'))).toHaveLength(1);
  });

  it('认出来一句就把那一串清零:三段的门槛不会被"两段 + 一句"凑出来', async () => {
    const host = await startWorld({}, fakeServices({ asrText: '' }));
    bridge!.ring('c1', String(HIM));
    await waitFor(() => host.events.some((e) => e.type === 'phone.connected'));
    await feedSpeech('c1', 2000);
    await feedSpeech('c1', 2000);
    expect(host.events.some((e) => e.text.includes('没认出来'))).toBe(false);
  });
});
