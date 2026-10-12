/**
 * 嗓子体检:真调一次 MiniMax,把结果摊开给人看。
 *
 * 为什么要这么一个脚本:合成那一路是**二级验证唯一验不到的地方** ——
 * 单测里 MiniMax 是替身,而这条路有三个只能靠真接口确认的假设:
 *
 * 1. **端点对不对**(`api.minimax.cn` 与 `api.minimax.chat` 都在用,取决于账号);
 * 2. **`format: "wav"` 回的是不是真的带头的 16 位 WAV**(我们靠文件头读采样率,读不出就明确失败);
 * 3. **它自报的 `audio_length` 与按文件头算出来的时长对不对得上**(对不上说明我们读错了格式)。
 *
 * 跑法:
 *   MINIMAX_API_KEY=xxx corepack pnpm ttscheck
 *   MINIMAX_API_KEY=xxx corepack pnpm ttscheck --endpoint https://api.minimax.cn/v1/t2a_v2
 * 在部署目录里跑时,密钥可以直接从 `.env` 读:
 *   MINIMAX_API_KEY=$(grep '^MINIMAX_API_KEY=' .env | cut -d= -f2) corepack pnpm ttscheck
 *
 * **不打印密钥**,只打印成败与音频的事实。
 */
import { synthesizePcm, type TtsSettings } from '../src/tts.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const key = process.env.MINIMAX_API_KEY?.trim() ?? '';
const endpoint = arg('endpoint') ?? process.env.PHONE_TTS_ENDPOINT ?? 'https://api.minimax.chat/v1/t2a_v2';
const voiceId = arg('voice') ?? process.env.PHONE_TTS_VOICE ?? 'Chinese (Mandarin)_Sweet_Lady';

if (key === '') {
  console.error('没有密钥:设 MINIMAX_API_KEY(也可从部署 .env 里取)。');
  process.exit(1);
}

const settings: TtsSettings = {
  apiKeySecret: 'MINIMAX_API_KEY',
  endpoint,
  model: arg('model') ?? 'speech-2.8-turbo',
  voiceId,
  speed: 1,
  vol: 1,
  pitch: 0,
  timeoutMs: 20000,
  maxCharsPerSay: 200,
  sampleRate: 32000,
};

console.log(`端点 : ${endpoint}`);
console.log(`音色 : ${voiceId}`);
console.log(`模型 : ${settings.model}`);

const started = Date.now();
const result = await synthesizePcm('喂,听得见吗?我这边测试一下嗓子。', {
  settings,
  apiKey: key,
  targetRate: 48000,
  log: { info: (m, meta) => console.log('  info', m, meta ?? ''), warn: (m, meta) => console.log('  warn', m, meta ?? '') },
});
const spent = Date.now() - started;

if (!result.ok) {
  console.log(`\n结果:没合成出来(${result.kind})打了 ${spent} 毫秒`);
  console.log('  ', result.error);
  if (result.detail) console.log('   detail:', result.detail);
  process.exitCode = 1;
} else {
  console.log(`\n结果:成功,打了 ${spent} 毫秒`);
  console.log(`  音频时长(按桥要的 48k 单声道算) ${Math.round(result.ms)} 毫秒`);
  console.log(`  重采样后的字节数 ${result.pcm.length}(48k × 16 位 × 1 声道 ⇒ 约 ${Math.round(result.pcm.length / 2 / 48000)} 秒)`);
  console.log(`  计费字符数 ${result.chars}(一个汉字算 2)`);
  console.log('  文件头与自报时长已交叉核对过(不合就会在这里报失败)。');
}
