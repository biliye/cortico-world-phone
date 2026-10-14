# cortico-world-phone

> ★ **非即插即用。** 装它之前,请**先把它交给一个 coding agent**,从 **`AGENTS.md`** 读起:
> 它不是一个"装完就能打电话"的包,而是一份**按你的环境分支**的作战手册 —— 真正的通话能力在
> **另一个进程**手里(一台跑着 QQ 的机器 + 一个桥),那半要怎么起、哪些前提必须先量,都在
> `docs/` 里。**没读过就装,最可能的结果是"看起来装好了、实际一句都说不出"**,而且不报错。
>
> 一句话给 agent 的开场:`读 AGENTS.md,先跑 probes/env-probe.mjs,再按决策树选路。`

电话:她接得起真来电、听得见对方说话、也说得出自己的话,然后挂断。

**这一份只解决"话机的耳朵与嘴"。** 真正的通话能力在**另一个东西**手里:一台 Linux 上跑的
QQ 客户端加一个桥(第三方,`KoishiRTC` 那一套,GPL-3.0 —— 我们只跑它、按它公开的协议跟它说话,
**不抄它的代码**)。这一包是那台机器的**本机对端**。

许可:本仓库是 **MIT**(见 `LICENSE`);"哪些是上游的、哪些是我们的"写在 `THIRD_PARTY.md`。

```
他打进来 ──► 协议端那台机器                跑 Cortico 的这台
           ┌────────────┐  WS    ┌──────────────────────────────┐
           │ QQ + 桥    │◄──────►│ cortico-world-phone          │
           │ 守护进程    │ 隧道   │  耳朵:分段 → 16k → SenseVoice  │
           │  :6120     │        │  嘴  :她的正文 → MiniMax → PCM  │
           └────────────┘        └──────────────────────────────┘
```

## 你是 agent 的话,先从这两份进

- **`AGENTS.md`** —— 入口:三条硬纪律(探测先行 / 判据不过不许往下走 / 第 3 级只有部署者能看)、
  决策树(量出什么走哪条路)、五个里程碑各自的验收判据、必须问用户不许替他决定的事。
- **`docs/field-notes.md`** —— 现场笔记:每条都是"现象 → 真因 → 怎么判 → 别怎么误读"。
  **这条线上静默失败的密度比普通项目高,先读它比先读装法划算。**

## 这条线现在是什么状态(照实说)

| 路线 | 做到哪 | 验证级别 |
|---|---|---|
| **Linux + 上游原生桥** | 全流程跑通:来电识别、接起、双向音频、挂断、她主动拨号、收尾逐句记录 | **三级全过**(行为目击在真机上,2026-10-09~10) |
| **界面驱动桥**(`cloud/sl-bridge.mjs`) | 协议层 + "看屏幕点接听 + 搬音频"在真机上验过 | 端到端**未验**;Windows 版**没写**;两个已知缺口写在文件头 |
| **Windows 本机** | 只接了文字线;通话这条路留着没做 | 未验 |

上面三行是**三种环境**,不是三个阶段 —— 选哪条取决于用户的机器,见 `AGENTS.md` 的决策树。
**"我们这边验过"不等于"你那边会成"**:每一份文档里的结论都带着它的验证级别。

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 给 agent 的入口(硬纪律 / 决策树 / 里程碑与判据) |
| `docs/field-notes.md` | 现场笔记:会骗人的地方与判据 |
| `docs/route-a-cloud-linux-napcat.md` | 已跑通那条路的可执行步骤(每步带验收判据) |
| `docs/route-b-ui-driven.md` | 界面驱动那条备选路(可复用什么、必须重写什么、验到哪一级) |
| `docs/cortico-side.md` | World 装法、事件表、persona 那条"关思考端点"的约定 |
| `probes/env-probe.mjs` | 到任何机器上先跑它(只读、零依赖、跨平台) |
| `src/definition.ts` | `WorldDefinition`:id、默认配置段(`enabled: false`)、`create()` |
| `src/world.ts` | World 本体:接通状态机、耳朵、嘴、三个工具、看护与自愈 |
| `src/bridge.ts` | 桥的 WebSocket 客户端(握手三条硬条件、一问一答、断线退避重连) |
| `src/call.ts` | 通话的规矩(谁能打进来、响多久该拒、什么算卡住)—— 纯函数,好测 |
| `src/ear.ts` | 能量门限分段(VAD)+ 送本机 SenseVoice |
| `src/tts.ts` | MiniMax 合成,要**带头的 WAV** 而不是裸 PCM(不猜格式) |
| `src/pcm.ts` | 采样率与声道的换算,**只在这一个地方负责** |
| `src/sentences.ts` | 可念的句子:删排版记号、切句、长流水句安全阀 |
| `src/ssh.ts` | SSH 隧道的拉起与看护(只走密钥;密码撑不起无人值守) |
| `src/ENV_PROMPT.md` | 电话那一段进 system 前缀的说明 |
| `cloud/` | 协议端那半的部署胶水(我们自己的脚本与说明,**不是**上游的代码) |
| `scripts/smoke.ts` | 冒烟:假桥 + 假识别 + 假嗓子,把整条路走一遍(`pnpm smoke`) |

## 装进一个实例

这台机器上要有:`node` ≥ 22、`ssh`(Windows 自带 OpenSSH 就有)、能连上**协议端那台**。
识别那半默认指本机 SenseVoice(`127.0.0.1:50001`)。

1. 把包装进部署的 `extensions/`(控制台「扩展」页选本机目录,或
   `cd extensions && corepack pnpm add --ignore-workspace <这个目录>`)。
   它带一个运行时依赖 `ws`(理由:桥的握手要求 `Authorization` 头,而 Node 自带的 WebSocket 设不了头)。
2. 重启进程。她会多出 `phone_say` / `phone_answer` / `phone_dial` / `phone_hangup` / `phone_status` /
   `phone_stop` 六个工具,前缀里多出"电话"那一段(下一轮前缀重建时生效)。
3. 部署 `.env` 里给两样东西:
   - `PHONE_BRIDGE_TOKEN=<桥的令牌>`(名字可改,见下 `tokenSecret`);
   - `MINIMAX_API_KEY=<嗓子>`(若与别的 World 共用,已经有了就不必再写)。
4. 部署 `config.json` 的 `worlds.phone` 段(见下)。**至少**要填 `callers`(接听名单),
   否则谁都打不进来。

## 配置

要点几个(全部在 `worlds.phone` 下;控制台「扩展 → 电话」也有表单):

| 键 | 默认 | 说人话 |
|---|---|---|
| `enabled` | `false` | 装上去不会自己开始打电话 |
| `bridgeUrl` | `ws://127.0.0.1:6120/v1/stream` | 指本机(隧道)那一头;别直接指公网 |
| `tokenSecret` | `PHONE_BRIDGE_TOKEN` | 令牌住在部署 `.env` 里,这里只写名字 |
| `tokenFile` | 空 | 也可以指一个本机文件;填了就优先读它 |
| `callers` | `[]` | **接听名单**(UIN)。空着 = 谁都不接。**这一格只在 `config.json` 里改**:框架的 `array` 只支持「数,数」一对,表单塞不下列表(与 mouse 的 `screens` 同一条规矩) |
| `autoAnswer` | `true` | 名单里的人打进来就自动接 |
| `rejectUnknown` | `true` | 陌生号直接拒,不让它响 |
| `ringTimeoutSec` | `30` | 响这么久没人接就自动拒 |
| `stuckSec` | `20` | 卡在"正在挂断"这么久算卡住 |
| `dial.target` | 空 | **她能拨给谁**。填 **uid**(`u_…`),不是手机号 —— 上游那条 `dial` 走的是 `peerUid`。空着 = `phone_dial` 拨不出去(它会明说没配) |
| `dial.label` | 空 | 拨号目标的称呼,只用在事件与回执里;空着就用上面那串本身 |
| `bargeIn` | `true` | **你说话,她当场停下听**(按声音判的)。想改成「你喊停她才停」就把这格关掉:她会把话说完,你喊「停停停」时她自己调 `phone_stop` 停下 |
| `bargeInMinMs` | `500` | `bargeIn` 开着时:**要连着说够这么久才算插嘴**。调小更容易被打断(短促噪声也能打断她),调大更不容易 |
| `maxSpeakSec` | `30` | **一轮**里她最多说多久,到点截断(她调 `phone_say` 被挡下时会收到"没念出去",不会以为说过了) |
| `frameMs` | `400` | 往外发音频的帧长(上游硬上限 1000) |
| `asr.servicePort` | `50001` | 本机 SenseVoice 的口 |
| `asr.language` | `auto` | 识别语言。**建议填 `zh`**:`auto` 会把中文碎片猜成英/日/韩(`Yeah.` / `やて。` / `그.`),而 `zh` 下"一个汉字都没有的正文"会被当成没听清(见下"三个工具"那段与 `src/ear.ts`) |
| `vad.marginDb` | `9` | 起音要比环境噪声高多少 dB;环境静就调小 |
| `vad.hangoverMs` | `700` | 说完这么久没声就送去认字 |
| `tts.voiceId` | 空 | MiniMax 的 voice_id,**必须填**否则合成一定失败 |
| `tts.maxCharsPerSay` | `200` | 一次说话的字数上限(一个汉字算 2) |
| `ssh.enabled` | `false` | 让 World 自己拉起隧道(先用 `cloud/` 里的 `probe.sh` 验过再开) |
| `ssh.host` / `ssh.keyFile` | 空 | 隧道主机与私钥 |
| `ssh.recoverCommand` | 空 | 通话卡住时在协议端那台执行的自愈命令;空着则只报告 |

## 三级验证

1. **构建过**:`corepack pnpm typecheck` + `corepack pnpm test`(165 条:换算、切句、规矩、
   插嘴门槛、往外写的配速、没听清要说出来、**猜错的语言不当他说的话**、**这一通几乎听不见他时说一次**、
   队列满的块重试不丢、**她主动拨出去的帧与"没接通要说一声"**、**收尾的逐句记录**、
   **`phone_say` 的四条边界(没接通/空文本/纯记号/被停过)与一轮里的去重**、
   桥的一问一答与重连、以及整条路的假桥冒烟)。
2. **装载过**:框架 checkout 下 `corepack pnpm check:extension <这个目录>`;另有
   `corepack pnpm smoke`(假桥 + 假识别 + 假嗓子,14 项全过才算)。
3. **行为目击(只有开发者能看)**:电话响起 → 她接起 → 她说一句 → 你听见;你说她接得上;
   你打断她,她当场停下;挂断后时间线里有 `phone.connected` / `phone.speech` / `phone.ended`
   (收尾那条正文里带着这一通的逐句记录)。**她主动拨给你**:调 `phone_dial` → 你手机上响 →
   接通后照常对话。★ **"她开口了没有"就是"你听见了没有"** —— 这一条只能你听,回执里的
   "接通了"不代表她说过话(见下"她怎么说话")。

第三级要的协议端前置都在 `cloud/README.md` 里(起栈、隧道、令牌、卡死自愈、回滚)。

**她能不能出声,还有一环不在这一个包里**:通话里要有个"关思考"的端点给她用
(一轮 20~38 秒没法通话),而"切端点"这件事住在 Persona 那一侧(`cortico-bot-prts` 的
`persona/phoneEndpoint.ts`)。那一环的配法与自查(`pnpm endpointcheck`)写在
**`cortico-bot-prts` 的 README**「与电话 World 的关系」一节 —— 少了它她会**一句都说不出**,
而这条链的三道验证一道都看不见。

### 她怎么说话(两条路,别只留一条)

- `phone_say { text }` —— **通话中开口走这条**。它和 qq2 / pet / terminal 各自的说话工具是同一个位置:
  框架给她的常驻规矩是「不经工具写下的正文是内心活动,要说话得用说话工具」,所以**说话必须是一个动作**。
- **她写下的正文也会被念出去**(这一条只有电话例外,是 0.1.x 的老行为,保留)。两条路说同一句**不会念两遍**
  (粒度是"一轮":新一轮里同一句照念,那是她的本意)。
- 只留正文那一条路的真机事故(2026-10-14):他打进来三通、每通都接通了,而回执三次都写「你出声 0 段」
  —— 她每轮只调了 `end_turn`、一个字没写,因为那条常驻规矩压过了"正文会被念出去"。
  现象与"线不通"一模一样。见 `docs/field-notes.md` §5.5。
- 没接通时调 `phone_say` 会明确回一句"**这一句没有被念出去**"(最常见:她刚 `phone_dial`,那头还没接起);
  她自己按过 `phone_stop` 的那一轮也不再出声 —— 都要等下一轮。

## 她看见什么(事件)

| 事件 | 时机 | 投递 |
|---|---|---|
| `phone.ringing` | 手动模式下有人打进来 | `preempt` |
| `phone.connected` | 接通(来电话是"来电",她自己拨的是"拨出") | `flush` |
| `phone.speech` | 对方说完一句(带转写正文);**长到不像脉冲却一个字都没认出来时**、**猜成了别的语言时**投的是「(这一句没听清,N 秒)」 | `flush`(被他插嘴打断时那次是 `preempt`) |
| `phone.ended` | 通话结束(历时、各说了多少,**外加这一通的逐句记录:他说的 / 她真正念出去的**) | `flush` |
| `phone.outgoingFailed` | **她拨出去的那一通从头到尾没接通**(她只会知道"我在拨",不说明的话她会以为打成了) | `flush` |
| `phone.notice` | 桥断了/卡住/合成失败/**这一通几乎没听见他**这类机制通知 | `debounce`,标 `origin: internal` |

正文都带 `【电话】` 前缀 —— 因为**电话里的事件与她文字线进的是同一个上下文**
(框架规定只有一个 session 收事件),不标清楚会串。

**记不记进记忆是她的事**:`phone.ended` 只把"这一通说了什么"交到她手里,这一包不替她写任何文件。

## 动手前该知道的

- ★ **协议端那半必须编过 `pulse-no-move.so`**,否则桥会报 `receiveAudio/sendAudio: supported=false`、
  诊断一行 `refusing unpinned PulseAudio capture.` —— 那样她**一个字也听不见、也说不出**。
  它不在源码包里,由 `/work/koishi` 下 `node bridge/audio/build-pulse-shim.mjs` 编出来;
  与 QQ 用的 `qq-pulse-guard.so` 是两个不同的文件。`cloud/up.sh` 会做这一步。
- **桥那头放得慢时,我们一个字都不丢**:音频排队等它,不自动丢弃(2026-10-09 他定的规矩:宁可晚、不可丢;
  听不下去时他自己喊「停」,她调 `phone_stop` 把堆着的收掉)。收尾日志里有 `wroteAudioMs / maxLagMs`,
  那两个数就是"桥吃不吃得下"的实况。
- **她说话时不要一口气把整句灌进桥**:桥那边的播放队列硬上限是 **2000 毫秒**
  (上游 `bridge/audio/common.mjs` 的 `maxQueueMs`,它是抖动缓冲)。灌满了会
  `Audio output queue is full.` 把她的声音丢掉(2026-10-09 实测丢过 2.8 秒),所以往外写要跟着播放速度走。
- **电话不响时先跑 `pnpm bridgeprobe`**:它按 World 走的那条路连一次桥,把账号、音频格式、
  两条音频能力、当前通话摊开 —— 把"路不通"与"她没反应"分开。
- **桥只肯绑回环**(上游 `daemon.mjs` 里那句 `桥接仅监听本机；远程部署请使用 SSH 隧道`)。
  所以部署桥的容器得用 `--network host`(容器的回环才是宿主的回环),隧道 `-L 6120:127.0.0.1:6120` 才够得着。
- **WS 握手三条硬条件**:路径 `/v1/stream`、必须带 `Authorization: Bearer`、不能带 `Origin`、
  同时只允许一个对端。这也是为什么用 `ws` 这个包当客户端。
- **她主动拨出去走的是上游那条 `dial`**:帧形状 `{op:'dial', args:{kind:'direct', targetId:<对端的 uid>, media:'audio'}}`
  (`daemon.mjs` 把它送成 `{peerUid: args.targetId}`)。两条讲究:**目标是 uid 不是手机号**;
  上游在**已经有未结束通话时直接拒**(`CALL_BUSY`),所以本地先拦一道、把原因说成人话。
- **"猜错的语言"与"这一通几乎没听见他"是两条独立的判据**(都在 `src/ear.ts` 与 `world.ts` 里):
  出现假名/谚文 ⇒ 一定不是他说的话;配成 `zh` 时"一个汉字都没有的正文"同理(这两条**宁可漏、不误杀**,
  所以 `auto` 下的拉丁短词照旧放行)。连着 **3** 段"像一句话却没认出来"就认定他这一通没被听见,
  跟她说一次 —— 三种成因(他真没说 / 网上碎了 / 门限太高)在她看来长得一模一样,必须有人替这一层说话。
- ★ **协议端那个电话宿主会在通话结束时主动退出、被监督脚本重启**,重启那几秒里控制命令(`accept`/`hangup`/`dial`)
  都会被拒,理由是 `Requires an exact audited QQ library, build, platform and architecture.` ——
  **那句别读成"这个 QQ 版本不支持"**(能力表里写着 `supported`,同一通的上一通也可能刚挂成功);
  它只是"原生能力还没就绪"。证据链(2026-10-10 实测):`run-av-host.sh` 是个 `while true` 监督循环,
  它自己的日志写着 `ppapi-process-missing: native-process-exited; restarting isolated media Host` →
  `exited with status 0; restarting`,而 QQ 那侧的进程启动时间正好落在她挂断失败的那几秒里。
  ⇒ 所以 `phone_hangup` **第一次失败会自动再试一次**;再失败就把出路交给她(让他挂)。
  另外:`send()` 会把上游的 **`code` 落进日志**(回执只带 message,而那句 message 会误导人)。
- **`submitted` ≠ 接通**:命令回执只说明提交给了 AVSDK;接通要看通话的 `phase` 变成 `connected`。
- ★ **状态字段有两套写法**:容器内**插件口**叫 `phase`,而**守护进程那条 WS**(我们要连的就是它)
  叫 `state`;对方是谁也分 `callerUin` 与 `targetId`。解析器必须"有什么认什么"
  (`phase|state`、`callerUin|peerUin|targetId`、`inviteAt|createdAt`、`endedAt|updatedAt`)——
   只读 `phase` 会让**每一通电话都被静静地忽略**(连"陌生号直接拒"都不会发生)。
  时间戳是**毫秒**。
- **对方挂断后桥里那通会卡在 `rejecting`**,而且挡住新通话;唯一释放是重启 AV Host 换 bootId
  (`ssh.recoverCommand` 就是干这个的)。
- **`logAudio` 默认关**:通话音频不该留在盘上。
- **她的话要过一道筛**:markdown、代码、链接、emoji 会被去掉才合成 —— 但括号里的内容保留
  (那可能是真话)。要她别写旁白,是写法的事(见 `ENV_PROMPT.md`),不是筛子的事。

## 不做的事

- **"真的没在录"**:闭麦那类语义没有;`bargeIn` 只影响她出声,不影响对方音频进来。
- **通话记录只交给她,不替她落盘**:挂断时把这一通说过的话打包进 `phone.ended` 正文,
  记不记进记忆、要不要写进便签,由她自己决定 —— 这一包不碰她的记忆。
- **她拨给谁不做成名单**:只有一个目标(`dial.target`)。出站的唯一用途是"她想起什么、拨给他",
  名单只会多出一层要维护的东西。
