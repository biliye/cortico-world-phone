/**
 * 桥的探针:按 World 走的那条路连一次 WS,把握手与状态摊开。
 *
 * 与 `ttscheck` 同一种工具:**二级验证唯一验不到的那一段**在这里补上 ——
 * 单测里的桥是假的,而真桥的握手有三条硬条件(路径、Bearer、不带 Origin)加"同时只允许一个对端"。
 * 电话不通的时候先跑这个:它能把"路不通"与"她没反应"分开。
 *
 * 跑法(在部署目录里,令牌从 .env 取):
 *   PHONE_BRIDGE_TOKEN=$(grep '^PHONE_BRIDGE_TOKEN=' .env | cut -d= -f2) \
 *     corepack pnpm --dir <包目录> bridgeprobe
 * 或者显式给:
 *   corepack pnpm bridgeprobe --url ws://127.0.0.1:6120/v1/stream --token-file <文件>
 *
 * **不打印令牌**。
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = arg('url') ?? process.env.PHONE_BRIDGE_URL ?? 'ws://127.0.0.1:6120/v1/stream';
const tokenFile = arg('token-file');
const token = (tokenFile ? readFileSync(tokenFile, 'utf8') : (process.env.PHONE_BRIDGE_TOKEN ?? '')).trim();

if (token === '') {
  console.error('没有令牌:设 PHONE_BRIDGE_TOKEN,或用 --token-file 指一个文件。');
  process.exit(1);
}

console.log(`桥地址: ${url}`);
console.log(`令牌:已给(${token.length} 字节,不打印)`);

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${token}` },
  perMessageDeflate: false,
  handshakeTimeout: 10000,
});

let seen = false;
const done = (code: number, note: string): void => {
  console.log(`\n${note}`);
  try {
    ws.close();
  } catch {
    /* 已经关了 */
  }
  setTimeout(() => process.exit(code), 100);
};

ws.on('open', () => console.log('握手成功(路径对、令牌对、没带 Origin)。'));

ws.on('message', (data: Buffer) => {
  let packet: Record<string, unknown>;
  try {
    packet = JSON.parse(String(data)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (packet.type !== 'hello' && packet.type !== 'status') return;
  if (seen) return;
  seen = true;
  const account = (packet.account ?? {}) as Record<string, unknown>;
  const format = (packet.audioFormat ?? {}) as Record<string, unknown>;
  const caps = (packet.capabilities ?? {}) as Record<string, { supported?: boolean; reason?: string }>;
  const calls = Array.isArray(packet.calls) ? packet.calls : [];
  const diagnostics = Array.isArray(packet.diagnostics) ? packet.diagnostics : [];
  console.log(`\n桥报的状态(${String(packet.type)}):`);
  console.log(`  账号      ${String(account.selfId ?? '(没报)')} / ${String(account.platform ?? '?')}`);
  console.log(`  音频格式  ${String(format.encoding ?? '?')} ${String(format.sampleRate ?? '?')}Hz ${String(format.channels ?? '?')}ch`);
  for (const key of ['private.accept', 'private.receive', 'private.hangup', 'private.reject', 'receiveAudio', 'sendAudio']) {
    const cap = caps[key];
    if (cap) console.log(`  能力 ${key.padEnd(18)} ${cap.supported ? 'supported' : `不支持(${cap.reason ?? '没给原因'})`}`);
  }
  console.log(`  当前通话  ${calls.length === 0 ? '没有' : JSON.stringify(calls).slice(0, 300)}`);
  if (diagnostics.length > 0) {
    for (const item of diagnostics as Array<{ id?: string; level?: string; message?: string }>) {
      console.log(`  诊断 [${item.level ?? '?'}] ${item.message ?? ''}`);
    }
  }
  done(0, '路是通的:World 能连上桥,而且在读状态。');
});

ws.on('error', (error: Error) => {
  const message = error.message;
  // 401/403 是握手被拒 —— 这三种原因要分开说，不然只会看到"连不上"。
  if (/401|403|Unexpected server response/.test(message)) {
    done(1, `不通:握手被拒(${message})。多半是令牌不对,或路径不是 /v1/stream,或带了 Origin。`);
    return;
  }
  done(1, `不通:${message}。隧道没起来、或云上的守护进程没跑,都会是这样。`);
});

ws.on('close', () => {
  if (!seen) done(1, '不通:连上了但没等到桥的状态包(它可能正在启动)。');
});

setTimeout(() => {
  if (!seen) done(1, '不通:10 秒内既没成功也没失败(隧道那头没人应)。');
}, 10000);
