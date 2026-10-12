import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient, normalizeCall, screenshotBlob } from '../src/bridge.ts';
import { FakeBridge } from './helpers/fake-bridge.ts';
import { silence, stereo, tone } from './helpers/wav.ts';

let bridge: FakeBridge | undefined;
let client: BridgeClient | undefined;

afterEach(async () => {
  client?.stop();
  client = undefined;
  await bridge?.close();
  bridge = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等不到那个状态');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('BridgeClient:握手那三条硬条件', () => {
  it('带着对令牌、走对路径就连上', async () => {
    bridge = new FakeBridge();
    const url = await bridge.listen();
    let opened = false;
    client = new BridgeClient({ url, token: bridge.token, handlers: { onOpen: () => (opened = true) } });
    client.start();
    await waitFor(() => opened);
    expect(bridge.rejectedCount).toBe(0);
    expect(bridge.connected).toBe(true);
  });

  it('令牌不对:被 403 顶回来,不算连上', async () => {
    bridge = new FakeBridge('right-token-right-token-right-token!');
    const url = await bridge.listen();
    let opened = false;
    client = new BridgeClient({
      url,
      token: 'wrong-token-wrong-token-wrong-token!',
      handlers: { onOpen: () => (opened = true) },
      reconnectMaxMs: 30000,
    });
    client.start();
    await waitFor(() => bridge!.rejectedCount > 0);
    expect(opened).toBe(false);
    expect(client.connected).toBe(false);
  });

  it('路径不对:同样被顶回来', async () => {
    bridge = new FakeBridge();
    const url = await bridge.listen();
    let opened = false;
    client = new BridgeClient({
      url: url.replace('/v1/stream', '/nope'),
      token: bridge.token,
      handlers: { onOpen: () => (opened = true) },
    });
    client.start();
    await waitFor(() => bridge!.rejectedCount > 0);
    expect(opened).toBe(false);
  });
});

describe('BridgeClient:一来一往', () => {
  it('命令拿到回执,且回执按 id 对上', async () => {
    bridge = new FakeBridge();
    const url = await bridge.listen();
    client = new BridgeClient({ url, token: bridge.token, handlers: {} });
    client.start();
    await waitFor(() => client!.connected);
    const reply = await client.request('accept', { callId: 'c1' });
    expect(reply.ok).toBe(true);
    expect(bridge.requests.at(-1)?.op).toBe('accept');
  });

  it('回执里带上游给的 data', async () => {
    bridge = new FakeBridge();
    bridge.onRequest = (op) => (op === 'devices' ? { ok: true, data: { devices: ['a', 'b'] } } : undefined);
    const url = await bridge.listen();
    client = new BridgeClient({ url, token: bridge.token, handlers: {} });
    client.start();
    await waitFor(() => client!.connected);
    const reply = await client.request('devices');
    expect(reply.ok).toBe(true);
    expect(reply.data).toEqual({ devices: ['a', 'b'] });
  });

  it('命令报错时 ok=false 且带 code(**上游的 CALL_BUSY / NOT_CONNECTED 就是这么回来的**)', async () => {
    bridge = new FakeBridge();
    bridge.onRequest = (op) =>
      op === 'dial' ? { ok: false, error: { code: 'CALL_BUSY', message: '此账号已有未结束的通话' } } : undefined;
    const url = await bridge.listen();
    client = new BridgeClient({ url, token: bridge.token, handlers: {} });
    client.start();
    await waitFor(() => client!.connected);
    const reply = await client.request('dial', { kind: 'direct' });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('CALL_BUSY');
  });

  it('没有回执就超时,不会永远挂着', async () => {
    bridge = new FakeBridge();
    bridge.holdOps.add('diagnostics');
    const url = await bridge.listen();
    client = new BridgeClient({ url, token: bridge.token, handlers: {}, requestTimeoutMs: 300 });
    client.start();
    await waitFor(() => client!.connected);
    const reply = await client.request('diagnostics');
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('TIMEOUT');
  });
});

describe('BridgeClient:推送的分发', () => {
  it('call / audio / status / hello 各走各的手', async () => {
    bridge = new FakeBridge();
    const url = await bridge.listen();
    const calls: string[] = [];
    const audios: number[] = [];
    const statuses: string[] = [];
    client = new BridgeClient({
      url,
      token: bridge.token,
      handlers: {
        onCall: (c) => calls.push(c.phase),
        onAudio: (f) => audios.push(f.data.length),
        onStatus: (_s, kind) => statuses.push(kind),
      },
    });
    client.start();
    await waitFor(() => client!.connected);
    bridge.ring('c1', '10002');
    bridge.setPhase('c1', 'connected');
    bridge.pushAudioFrame('c1', stereo(tone(20, 48000)));
    await waitFor(() => calls.length >= 2 && audios.length >= 1);
    expect(calls).toEqual(['ringing', 'connected']);
    expect(statuses).toContain('hello');
  });

  it('断线会自己重连(退避起点由配置给)', async () => {
    bridge = new FakeBridge();
    const url = await bridge.listen();
    let closes = 0;
    client = new BridgeClient({ url, token: bridge.token, handlers: { onClose: () => (closes += 1) }, reconnectBaseMs: 100 });
    client.start();
    await waitFor(() => client!.connected);
    bridge.dropPeer();
    await waitFor(() => closes > 0);
    await waitFor(() => client!.connected, 5000);
    expect(closes).toBeGreaterThan(0);
  });

  it('断线时挂着的命令立刻拿到失败,而不是等到超时', async () => {
    bridge = new FakeBridge();
    bridge.holdOps.add('accept');
    const url = await bridge.listen();
    client = new BridgeClient({ url, token: bridge.token, handlers: {}, requestTimeoutMs: 10000 });
    client.start();
    await waitFor(() => client!.connected);
    const pending = client.request('accept', { callId: 'c1' });
    await new Promise((r) => setTimeout(r, 50));
    bridge.dropPeer();
    const reply = await pending;
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('DISCONNECTED');
  });
});

describe('normalizeCall:上游那份对象的字段形状', () => {
  it('phase 之外还认 callerUin / media / nativeEndEvent', () => {
    const call = normalizeCall({
      id: 'c9',
      phase: 'connected',
      callerUin: '10002',
      media: 'audio',
      nativeEndEvent: 'peer.hangup',
      acceptReady: true,
      participantsKnown: true,
    });
    expect(call?.callerUin).toBe('10002');
    expect(call?.media).toBe('audio');
    expect(call?.nativeEndEvent).toBe('peer.hangup');
    expect(call?.raw.participantsKnown).toBe(true);
  });

  it('数字号也认(上游有时给字符串有时给数字)', () => {
    expect(normalizeCall({ id: 'x', phase: 'ringing', callerUin: 10002 })?.callerUin).toBe('10002');
  });
});


describe('真机上抓下来的两份 payload(**回归护栏**)', () => {
  it('守护进程那条 WS 的形状:state / targetId / 带 bootId 的 id / createdAt', () => {
    // 这份是 2026-10-09 从云上那个守护进程的 /v1/status 里**原文抓下来的**。
    // 上一版就是没按它写(normalizeCall 读 phase/callerUin),于是真机上每一通电话都被静静忽略。
    const call = normalizeCall({
      id: '56d3cdf4-780d-4606-8972-b711079ddfab:0:61879a4c-e5a5-49de-b4b1-01f311ad50c8',
      kind: 'direct',
      direction: 'incoming',
      state: 'ringing',
      targetId: '10002',
      createdAt: 1791537243725,
      participants: [],
      muted: false,
      updatedAt: 1791537244220,
    });
    expect(call).not.toBeNull();
    expect(call!.phase).toBe('ringing');
    expect(call!.callerUin).toBe('10002');
    expect(call!.inviteAt).toBe(1791537243725);
    // id 必须原样带走:上游按 `bootId:epoch:` 前缀校验,拿裸 id 去发会被判 STALE_CALL。
    expect(call!.id.startsWith('56d3cdf4-780d-4606-8972-b711079ddfab:0:')).toBe(true);
  });

  it('容器内插件口的形状(phase / callerUin)也照认 —— 两条路我们都可能读', () => {
    // 这份是从插件口 /v1/calls/current 抓的。
    const call = normalizeCall({
      id: '61879a4c-e5a5-49de-b4b1-01f311ad50c8',
      kind: 'private',
      direction: 'incoming',
      phase: 'ringing',
      callerUid: 'u_example000000000000000',
      callerUin: '10002',
      callerName: null,
      nativeInviteType: 1,
      acceptReady: true,
      endedAt: null,
      endReason: null,
      media: 'audio',
      peerUin: '10002',
    });
    expect(call!.phase).toBe('ringing');
    expect(call!.callerUin).toBe('10002');
    expect(call!.media).toBe('audio');
  });

  it('终态的两种叫法都认:endReason 与 nativeEndEvent', () => {
    expect(normalizeCall({ id: 'x', state: 'ended', endReason: 'peer.hangup' })!.nativeEndEvent).toBe('peer.hangup');
    expect(normalizeCall({ id: 'x', phase: 'ended', nativeEndEvent: 'host.restarted' })!.nativeEndEvent).toBe('host.restarted');
  });
});

/**
 * 桥回的那张截图 → 事件附件。这一段进的是**模型的眼睛**(多模态图片块),
 * 半张图/空 base64 都会变成一条看着像回事的假证据 —— 所以形状不对必须当没有。
 */
describe('screenshotBlob:形状不对就当没有', () => {
  const png = Buffer.alloc(2048, 7).toString('base64');

  it('正常的图:原样带出去,mime 默认 image/png', () => {
    const blob = screenshotBlob({ pngBase64: png, width: 360, height: 640, mime: 'image/png' });
    expect(blob).toBeDefined();
    expect(blob!.bytes.length).toBe(2048);
    expect(blob!.mime).toBe('image/png');
    expect(blob!.fallbackText).toContain('截图');
  });

  it('桥报了别的图片类型就照它的,报的不是图片类型就退回 png', () => {
    expect(screenshotBlob({ pngBase64: png, mime: 'image/jpeg' })!.mime).toBe('image/jpeg');
    expect(screenshotBlob({ pngBase64: png, mime: 'text/plain' })!.mime).toBe('image/png');
  });

  it('空串/缺项/几个字节/根本不是对象 ⇒ undefined(宁可当没有,不许猜)', () => {
    expect(screenshotBlob({ pngBase64: '' })).toBeUndefined();
    expect(screenshotBlob({ pngBase64: '   ' })).toBeUndefined();
    expect(screenshotBlob({})).toBeUndefined();
    // 几十个字节解出来是不是图都难说;真图(哪怕是空白来电窗)也有几 KB。
    expect(screenshotBlob({ pngBase64: Buffer.alloc(64, 1).toString('base64') })).toBeUndefined();
    expect(screenshotBlob(undefined)).toBeUndefined();
    expect(screenshotBlob(null)).toBeUndefined();
    expect(screenshotBlob('image/png')).toBeUndefined();
    expect(screenshotBlob(42)).toBeUndefined();
  });
});
