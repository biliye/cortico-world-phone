#!/usr/bin/env node
/**
 * env-probe.mjs —— 把 cortico-world-phone 这套东西装到一台**陌生机器**上时,先跑它。
 *
 * 它解决一件事:这套电话有两个完全不同的落点,「云上 Linux + 协议桥」或「本机图形界面驱动」,
 * 外加一条退路「只走文字线」。人(和 agent)在动手之前,得先知道这台机器手里有什么牌,
 * 才知道该走哪条。手册里那些前置条件散在好几处,这个脚本把它们一次性摊平,并且**每一行都给出
 * 它决定什么** —— 事实和判断分开写,是因为"发现没有 ffmpeg"与"所以走不了界面驱动"是两件事,
 * 混在一起读的人分不清哪句是量的、哪句是推的。
 *
 * 纪律(别破坏):
 *   1. **只读**。不装东西、不改配置、不写文件、不连任何外部网络。唯一的网络动作是**本机回环**
 *      上的 TCP connect(问一句"这个口在不在听"),连上就立刻断开,不发任何数据。
 *   2. **零依赖**,只用 Node 内建模块,`node probes/env-probe.mjs` 直接能跑。
 *   3. **跨平台**:win32 / linux / darwin 都要能跑完不崩;某条判据在这个平台上判不了,就**明说判不了**,
 *      不许猜、不许拿别的平台的经验套。
 *   4. 脚本里**不许出现任何真实的 IP、账号、令牌**。下面所有端口与路径都是**通用常量**,
 *      不是任何人的部署 —— 打印时都会说明它是什么。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { platform, arch, release, cpus, homedir } from 'node:os';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';

// ───────────────────────────── 输出小工具 ─────────────────────────────

/** 一条事实。`fact`/`why` 分开:先给量到的东西,再给它的含义。 */
const fact = (text) => console.log(`· ${text}`);
const why = (text) => console.log(`    → 这条决定:${text}`);
const head = (text) => console.log(`\n== ${text} ==`);

// ───────────────────────────── 常量(通用,不是谁的机器) ─────────────────────────────

/**
 * 要探的回环端口。为什么是这几个:
 *   6120  —— 桥的 WebSocket 口。它是"这台机器够不够得着那台话机"的信号;在听 = 隧道已经通了。
 *   3001  —— OneBot / 协议端的口(QQ 文字线)。在听 = 文字那条线已经有人跑着。
 *   6110  —— 桥的插件控制口(在云上的容器里;本机若在听,多半是本机自己起了测试桥)。
 *   50001 —— 本机语音识别 SenseVoice 的 HTTP 口。在听 = 耳朵能就近认字,不必另建识别服务。
 *   5099  —— SnowLuma 面板口(界面驱动那套的可视化/管理界面)。
 * 全部只探 127.0.0.1:够不着外网,也不新增任何对外行为。
 */
const PORTS = [
  { port: 6120, what: '桥的 WebSocket 口(话机那头;本机侧经 SSH 隧道映射到这儿)' },
  { port: 3001, what: 'OneBot / 协议端口(QQ 文字线)' },
  { port: 6110, what: '桥的插件控制口(通常在云上的容器里)' },
  { port: 50001, what: '本机语音识别 SenseVoice 的 HTTP 口(耳朵)' },
  { port: 5099, what: 'SnowLuma 面板口(界面驱动那套的管理界面)' },
];

/**
 * 要找的可执行文件。**只在 PATH 上找,不真的去跑它们** —— 跑起来会有副作用
 * (比如 `docker` 会起 daemon 的客户端、`powershell` 会加载 profile),而这一步只要"在不在"。
 * 每个都附一句"它决定什么",这样输出的每一行都能落到路线上。
 */
const TOOLS = [
  { name: 'ssh', why: '隧道与云上自愈命令都靠它;没有它,云上那台就够不着' },
  { name: 'docker', why: '在 Linux 上起桥/QQ 容器;它是"云上 Linux + 协议桥"这条路的硬前置' },
  { name: 'ffmpeg', why: '界面驱动桥抓来电窗截图用它(x11grab);缺它就没有"截图认人"那一手' },
  { name: 'ffplay', why: '人工试听对方的声音;非必需,缺了只是不好人耳验收' },
  { name: 'pactl', why: 'Linux 上查/配音频设备(隔离音频那两条 null sink 也靠它)' },
  { name: 'parec', why: '界面驱动桥采对方的声音;与 pactl 同一套,缺一不可' },
  { name: 'xdotool', why: '界面驱动桥点"接听/挂断"那两颗钮;只有图形 Linux 才有' },
  { name: 'powershell', why: 'Windows 上探音频设备、做界面自动化的入口' },
  { name: 'pwsh', why: 'PowerShell 7 的另一种叫法;与 powershell 有一个就够' },
];

/**
 * 各平台查一种**最常见的** QQ 客户端安装痕迹。查不到就说查不到,不猜、不遍历整块盘。
 * 用途:判断"QQ 装没装在本机"——它决定本机界面驱动那条路能不能就地走起来。
 */
const QQ_MARKS = {
  win32: ['C:\\Program Files\\Tencent\\QQNT\\QQ.exe', 'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe'],
  linux: ['/opt/QQ', '/opt/qq', join(homedir(), '.config', 'QQ')],
  darwin: ['/Applications/QQ.app'],
};

// ───────────────────────────── 量 ─────────────────────────────

const OS = platform();

/** PATH 上找可执行文件。Windows 要按 PATHEXT 补后缀。不执行任何东西。 */
function which(name) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts =
    OS === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    // 先按原样试一次(name 可能已经带后缀),再按 PATHEXT 补。
    if (existsSync(join(dir, name))) return join(dir, name);
    for (const ext of exts) if (existsSync(join(dir, name + ext))) return join(dir, name + ext);
  }
  return null;
}

/** 只探本机回环的这个口在不在听。连上即断,不写一个字节。 */
function portOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* 已经没了 */
      }
      resolve(value);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/**
 * 是不是在容器里。Linux 才有可靠的标记(`/.dockerenv` 与 `/proc/1/cgroup`);
 * 别的平台没有这套约定,老实说判不了 —— 拿"没找到标记"当"不是容器"是错的。
 */
function detectContainer() {
  if (OS !== 'linux' && OS !== 'darwin') {
    // Windows 上没有 /.dockerenv / /proc 这套标记;只能看有没有人显式设过 container 变量。
    return process.env.container
      ? { known: true, value: `容器(环境变量 container=${process.env.container})` }
      : { known: false };
  }
  try {
    if (existsSync('/.dockerenv')) return { known: true, value: '容器(有 /.dockerenv)' };
  } catch {
    /* 打不开就算了 */
  }
  try {
    const cg = readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|kubepods|containerd|podman/.test(cg)) {
      return { known: true, value: '容器(/proc/1/cgroup 里有 docker/k8s/podman 字样)' };
    }
  } catch {
    /* 非 Linux 或没权限,正常 */
  }
  return { known: false };
}

/**
 * Windows:用一条**只读**的 PowerShell 命令列出音频设备名。
 * 选 `Get-CimInstance Win32_SoundDevice` 而不是 WinMM/COM:它只读、不打开设备、不改设置。
 * 查不到原因(没 PowerShell / 命令失败)照实回,不拿"应该有声音"糊过去。
 */
function audioWindows() {
  const exe = which('powershell') || which('pwsh');
  if (!exe) return { ok: false, note: '没找到 powershell/pwsh,判不了' };
  let r;
  try {
    // ★ 先设 `[Console]::OutputEncoding = UTF8`:Windows PowerShell 5.1 默认按控制台代码页
    //   往 stdout 写,设备名里有中文时按 utf8 读会变成乱码。这条只改子进程自己的输出编码,
    //   不碰系统设置、不写文件。
    r = spawnSync(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_SoundDevice | Select-Object -ExpandProperty Name',
      ],
      { timeout: 15000, encoding: 'utf8', windowsHide: true },
    );
  } catch (e) {
    return { ok: false, note: `命令没跑起来(${e?.message ?? e})` };
  }
  if (r.error) return { ok: false, note: `命令没跑成(${r.error.message})` };
  const names = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return { ok: true, names: [], note: '命令跑通了,但一个设备名都没报' };
  return { ok: true, names };
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  console.log('电话 World · 环境探测(只读:不装、不改、不写、不连外网;只探本机回环)');

  const collected = {
    nodeOk: false,
    tools: {},
    portsUp: [],
    container: { known: false },
    qqFound: null,
    audio: null,
  };

  // 1) 系统 / 架构 / Node / 容器
  head('系统');
  const nodeMajor = Number((process.versions.node || '0').split('.')[0]);
  collected.nodeOk = nodeMajor >= 22;
  fact(`系统 ${OS} ${release()} / 架构 ${arch()} / Node ${process.versions.node} / CPU ${cpus().length} 核`);
  why(collected.nodeOk ? 'Node 够(≥22),这一包两侧的脚本都能跑' : 'Node 低于 22 —— **先升 Node**,包内所有脚本都要求 ≥22');

  const container = detectContainer();
  collected.container = container;
  if (container.known) {
    fact(`运行环境:${container.value}`);
    why('已经在容器里 ⇒ "云上 Linux + 协议桥"这一路大概率就落在这台(或它的宿主)上,不用另找机器');
  } else {
    fact('运行环境:判不了是不是容器(这个平台没有可靠标记)');
    why('说不准就按"裸机"处理,需要时用 `docker info` 或问机器主人来确认');
  }

  // 2) 可执行文件(只查 PATH,不执行)
  head('可执行文件(只在 PATH 上找,不运行)');
  for (const tool of TOOLS) {
    const path = which(tool.name);
    collected.tools[tool.name] = path;
    fact(`${tool.name.padEnd(12)} ${path ? '有' : '没有'}${path ? `  (${path})` : ''}`);
    why(path ? tool.why : `缺 ${tool.name}:${tool.why}`);
  }

  // 3) 本机回环端口
  head('本机回环端口(127.0.0.1,只 connect 一下就断)');
  for (const { port, what } of PORTS) {
    const open = await portOpen(port);
    if (open) collected.portsUp.push(port);
    fact(`${String(port).padEnd(6)} ${open ? '在听' : '没在听'}   —— ${what}`);
  }
  if (collected.portsUp.length === 0) {
    why('五个口一个都没在听 ⇒ 现在这台机器上没有任何一条线是活的;要么还没起,要么环境变量里的地址指的是别处');
  } else {
    why(`${collected.portsUp.join(' / ')} 在听 ⇒ 线的"另一端"已经有东西跑着了,先跑 bridgeprobe 验协议,再谈别的`);
  }

  // 4) QQ 客户端痕迹
  head('本机 QQ 客户端痕迹(各平台只查一种最常见的安装位置)');
  const marks = QQ_MARKS[OS] || [];
  let qqFound = null;
  for (const p of marks) {
    try {
      if (existsSync(p)) {
        qqFound = p;
        break;
      }
    } catch {
      /* 权限之类,跳过 */
    }
  }
  collected.qqFound = qqFound;
  if (qqFound) {
    fact(`找到了:${qqFound}`);
    why('本机装了 QQ ⇒ "本机界面驱动"这条路有就地起的可能(还得有 xdotool/pactl/parec/ffmpeg 与图形桌面)');
  } else if (marks.length === 0) {
    fact('这个平台没有可查的常见路径,判不了');
    why('判不了就当本机没有 —— 界面驱动那条路不作指望');
  } else {
    fact(`查不到(找过:${marks.join('、')})`);
    why('本机没装 QQ(或装在别处)⇒ 界面驱动那条路要么先装 QQ,要么把 QQ 放到云上');
  }

  // 5) 音频设备
  head('音频输出 / 输入设备');
  if (OS === 'win32') {
    const r = audioWindows();
    collected.audio = r;
    if (r.ok && r.names.length > 0) {
      fact(`Windows 上查到 ${r.names.length} 个音频设备:`);
      for (const n of r.names.slice(0, 12)) console.log(`      - ${n}`);
      why('有音频设备 ⇒ 本机可以出声、可以采声(界面驱动/本机试听都可用)');
    } else if (r.ok) {
      fact('Windows 命令跑通了,但没报出任何设备名');
      why('可能真没有音频设备,也可能是驱动/权限问题 ⇒ 这条请机器主人复核');
    } else {
      fact(`Windows 上没法判:${r.note}`);
      why('判不了就不作指望;需要时手动看「声音设置」里的播放/录音设备');
    }
  } else if (OS === 'linux') {
    if (collected.tools['pactl']) {
      fact('pactl 在(audio 栈是 PulseAudio/PipeWire)');
      fact('要看清设备,自己跑这两条(只读):`pactl list short sinks`(输出)/ `pactl list short sources`(输入)');
      why('有 pactl ⇒ Linux 这一侧的音频方案可用;界面驱动桥的隔离音频就是拿它搭的');
    } else {
      fact('没有 pactl,判不了有没有音频设备');
      why('装 pulseaudio-utils(或确认用 PipeWire)之后再看;在此之前本机音频不作指望');
    }
  } else if (OS === 'darwin') {
    fact('macOS 上这里不代跑音频查询(那条命令慢)');
    fact('要看清设备,自己跑:`system_profiler SPAudioDataType`(只读)');
    why('这台机器上与电话相关的那套脚本(隧道/桥/界面驱动)都是 Linux/Windows 线,macOS 只到"能当本机文字线客户端"这一层');
  } else {
    fact(`这个平台(${OS})没有对应的音频查法,判不了`);
    why('判不了就不作指望');
  }

  // 6) 结论:走哪条路
  head('结论');

  const t = collected.tools;
  const hasSsh = Boolean(t['ssh']);
  const hasDocker = Boolean(t['docker']);
  // 界面驱动要凑齐:图形 Linux(DISPLAY)+ xdotool + pactl + parec + ffmpeg + 本机装了 QQ。
  const linuxGui =
    OS === 'linux' &&
    Boolean(process.env.DISPLAY) &&
    Boolean(t['xdotool']) &&
    Boolean(t['pactl']) &&
    Boolean(t['parec']) &&
    Boolean(t['ffmpeg']);
  const hasOneBot = collected.portsUp.includes(3001);

  const ready = [];
  const missing = [];
  (collected.nodeOk ? ready : missing).push('Node ≥ 22');
  (hasSsh ? ready : missing).push('ssh');
  if (linuxGui && collected.qqFound) ready.push('本机图形桌面 + xdotool/pactl/parec/ffmpeg + QQ');
  else missing.push('本机图形驱动器(需要 Linux 桌面 + xdotool/pactl/parec/ffmpeg + 本机 QQ)');
  if (hasDocker) ready.push('docker(能起桥容器)');
  else missing.push('docker(没有它,起不了"云上 Linux + 协议桥")');

  console.log('\n前置齐了:');
  for (const x of ready) console.log(`  ✓ ${x}`);
  console.log('还缺:');
  if (missing.length === 0) console.log('  (没有缺口)');
  for (const x of missing) console.log(`  ✗ ${x}`);

  console.log('\n建议走哪条路:');
  if (collected.portsUp.includes(6120)) {
    console.log('  → 桥(6120)已经在听:这一套的"另一端"已经就位。');
    console.log('     先跑 `corepack pnpm bridgeprobe`(或包里同名脚本)把钩子与鉴权验一遍;');
    console.log('     World 那侧按就绪的桥配 `worlds.phone.bridgeUrl` 即可。');
  } else if (linuxGui && collected.qqFound) {
    console.log('  → **本机界面驱动(B)**:你这台就是图形 Linux,QQ 也装在本机。');
    console.log('     走 cloud/sl-bridge.mjs 那一套(看屏幕 + 搬音频),端口与服务都就地起。');
  } else if (hasDocker && hasSsh) {
    console.log('  → **云上 Linux + 协议桥(A)**:有 docker 又有 ssh。');
    console.log('     起一套"QQ + 桥"的容器(cloud/Dockerfile.rtc + boot-rtc.sh 那条线),');
    console.log('     再从本机用 SSH 隧道把 6120 拉过来;World 侧 ssh.enabled 打开。');
  } else if (hasSsh) {
    console.log('  → **云上 Linux + 协议桥(A)的变体**:本机没有 docker,但能 ssh。');
    console.log('     去一台**已经跑着桥**的 Linux 上连(隧道拉到本机 6120),本机只当客户端。');
  } else if (hasOneBot) {
    console.log('  → **本机文字线(C)**:3001 上已经有协议端,先只走文字,不动语音。');
  } else {
    console.log('  → **本机文字线(C)**:语音两路的前置都不够,先把文字线接通。');
    console.log('     最低要求:Node ≥ 22 + 一个能连的 OneBot/协议端地址。');
  }
  console.log('     (三条路都要 Node ≥ 22;语音那两条还都要求那台跑 QQ 的机器能被 SSH 到。)');

  console.log('\n提示:某几行写着"判不了",是这台机器上确实分不出来 —— 别拿别处的经验套,先补这个信息。');
}

main().catch((e) => {
  // 探针自己不许把整台机器的事弄得像崩了:出错也要给一句能读的话。
  console.error(`探针本身出错(这是脚本的 bug,不是你的机器的问题):${e?.stack ?? e}`);
  process.exitCode = 1;
});
