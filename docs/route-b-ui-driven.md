# 路 B:界面驱动那条桥(备选)—— 状态照实说

这一条**没有跑完整**。写它是因为它在某些情况下是唯一选择,而它已经有一半是成品、协议层也验过。
**读完这份你会知道:哪一半能直接搬、哪一半必须按你的环境重写、以及哪些格子还是空的。**

**它是什么**:云侧(或本机)跑**真的 QQ 客户端**(有界面),桥改成用**看屏幕 + 搬音频**来通话
—— 用 `xdotool` 点接听/挂断那两颗钮,用 `parec`/`pacat` 抬音频。好处是**不再逐 build 审计原生地址**
(界面就是接口);代价是它**只能像素级操作**,而且"屏幕长什么样"是新的脆弱面。

**代码在**:`cloud/sl-bridge.mjs`(单文件,约 842 行)。它对外**逐字复刻**原桥的协议,所以
`cortico-world-phone` 那一侧**一个字节都不用改**。

---

## 0. 三件照实说的事(先看这个)

1. **协议层:在真实环境验过。** 握手四种情形(正确令牌 101 / 错令牌 401 / 带 `Origin` 403 /
   路径不对 404)、单对端(第二对端 403)、同 id 幂等(回保留的那份)—— 都在**真容器**里验过。
   (`真机验过`,见 design/cortico-world-phone-交接8 §4.1、交接9 §1.4、交接10 §1.6)
2. **端到端:没验过。** "真来电窗 + 他的手机 + 她决定接不接"这一整条**没有走通过**。界面驱动那条
   链在 Linux 上量到过"发现来电 → 点接听 → 双向音频 → 挂断"(见第 5 节),但最后那次真打的一通
   **没接通**(被一个模态框吃掉点击,见 3.3)。(`真机验过` + 未验,见 交接9 §1.2、交接11 §1)
3. **Windows 版:没写过。** `sl-bridge.mjs` 是 Linux/X11 + PulseAudio 专用。要在 Windows 上跑,
   "看屏幕 + 搬音频"那半**必须另写**(见第 3 节);那一半在这台 Windows 上**只有形状、没有实测**。
   (`只是推断`,见 交接12 §3)

**已知缺口两条(写在文件头,别当 bug)**:

- **认不出打电话的人是谁**。来电窗是像素,标题只有「语音通话」,QQ 不把"谁打来的"落进任何我们能读
  的接口。⇒ `callerUin` 报的是配置里那个**预设** `expectedCallerUin`(**是预设,不是事实**);
  `acceptUnknown:false` 时桥会**拒接一切来电**。**这条会削弱 World 那侧"拒接陌生号"的保护。**
- **`dial`(她主动拨)不支持**。界面上拨号是另一套导航,而且同样认不出对象。这一版直接回错误,
  World 会照实投 `phone.outgoingFailed`。

**一条债务(必须补)**:桥**点完就报成功**,没有任何验证(见 3.3)。这是"控制台说接了、他手机没接"的
根因。任何像素驱动都必须"点完要验"。
(出处:`cloud/sl-bridge.mjs` 文件头;交接8 §4.2;交接11 §1.2。(`真机验过`))

---

## 1. 什么时候才考虑它(A 与 B 的分水岭)

分水岭是**同一个未知数:你能不能/愿不愿意按 build 审计原生地址**(见 `route-a-cloud-linux-napcat.md`
第 2 节)。倾向选 B 的情形:

- 你的 QQ 哈希对不上审计名单,而你**不想重审计**(那是"几天"的量级);
- 你想要**一个客户端同时服务文字与电话**(不再是"两套互斥");
- 你担心"逐 build 审计"这条链太脆(QQ 一升级就要重做)。

倾向选 A 的情形:

- 你想要**稳**:A 在 Linux 上是真机跑通过两次的,B 的端到端没人走通过;
- 你的环境没有真客户端界面(比如 QQ 是"纯壳"形态 —— 当年就是因为这个,B 被否过一次:
  **UI 代码在但不加载**,所以"给它加一个窗口管理器"救不了)。

★ 一个**别重复的错**:那次否掉 B 的原因("没有客户端界面")在**换成真有界面的客户端**
(SnowLuma 那类"注入真客户端"的运行时)之后**不成立**了。所以 B 的死因不是永恒的
—— 它取决于你的 QQ 是不是真在跑这个客户端。先量:**来电时会不会多出一个独立窗**。
(出处:design/cortico-world-phone-plan §9/§11;交接7 §1;交接8 §4。(`真机验过`))

---

## 2. 哪些部分可以**直接搬**(约一半)

`cloud/sl-bridge.mjs` 里这几块**与环境无关,原样能留**:

1. **自己写的最小 WebSocket 服务端**(只做握手 + 文本帧收发 + ping/pong + close;按 RFC6455)。
   **为什么自己写而不用 `ws`**:这一份要扔进容器跑,而容器里没有 npm;**单一文件 + 只用 Node 内建**
   ⇒ 部署就是"拷过去 + `node` 起它",也便于逐行审。
2. **协议层**:路径 `/v1/stream` + `Authorization: Bearer` + **不能带 `Origin`** + **单对端**;
   包封 `{type:'request',id,op,args}` → `{type:'reply',id,ok,data|error}`;同 id 幂等;
   五类推送 `hello` / `call` / `audio` / `status` / `error`;7 个 op
   `accept` / `reject` / `hangup` / `dial` / `audio.write` / `audio.clear` / **`screenshot`**。
3. **通话状态机**:通话相位、响铃超时、`pollMs` 盯屏轮询、"窗口消失 ⇒ 收尾"那套。

★ **`screenshot` 是这一版桥自己加的 op**(原桥没有)。它抓一张来电窗的 PNG 回来,
**同时补上了缺口一**:图上是写着名字的,她读图就知道是谁打来的。老桥收到 `screenshot` 会回
`UNKNOWN_OP`,World 就当"这次没图",照常往下走(正文退回到报桥给的号)—— 所以这条改动**换成老桥也
没有风险**。
(出处:交接8 §4;交接9 §1.4;`cloud/sl-bridge.mjs` 文件头;交接10 §1.3。(`真机验过`))

### 协议契约(照这张清单对,别漏)

- **World 的容错边界**:`normalizeCall` 认 `phase|state`、`callerUin|peerUin|targetId`、
  `inviteAt|createdAt`、`endedAt|updatedAt`、`nativeEndEvent|endReason`;`playback` 那条推送它
  **从不注册**,可以不推。
- `call.id` **原样回带**;`phase` 词表
  `ringing/accepted/connected/dialing/ending/rejecting/ended/error/failed`。
- **同一 id 只执行一次**:断线重发复用 id,服务端必须返回保留的回执、**不重发命令**
  (`cloud/sl-bridge.mjs` 里那条日志是"同一个 id 又来了,回保留的那份")。
- ★ 一条**真 bug**(已修,但抄的时候记住):上一个对端若只发 FIN、不发 WS close 帧,
  `bridge.peer` 迟迟不清,把后来的对端全挡在 403 外面 ⇒ "已死但没触发 close"也算没有对端,
  并要处理 `'end'`。

---

## 3. 哪些部分**必须按你的环境重写**(另一半)

`cloud/sl-bridge.mjs` 里 `── 外部程序(xdotool / parec / pacat)──` 那一节(约三百行)
就是"看屏幕 + 搬音频"。**这一节是环境专有的,换一个平台就要重写。**

### 3.1 Linux / X11(现有实现)

- **找窗**:找标题带「语音」的窗口 → 抬窗 → 按**窗口内相对坐标**点接听/挂断。
  ★ **别把中文交给 `xdotool --name`**:容器里只有 C/POSIX locale,`--name 语` / `--name 语音通话`
  全返回空,而日志里**一句错都没有**(见 field-notes 7.9)。现有实现是"快路先试 `--name`,
  空手就列出所有可见窗 → 把名字拉回来在 JS 里 `includes`"。
- **点**:`xdotool` 合成点击。**抬窗 + 等一拍再点**(`windowraise`/`windowactivate` + `readyDelayMs`)
  不能省:窗口刚映射就点会点空。
- **抓图**:`ffmpeg -f x11grab -draw_mouse 0 -video_size WxH -i :1+X,Y -frames:v 1 -f image2 -vcodec png`。
  **实测连启动约 1.5 秒/张** —— 响铃那几秒够用,别拿它做逐帧。窗口顶着屏幕边时会把区域裁进屏幕
  (x11grab 抓不到屏幕外)。`xwd` 也能抓,但还得转一道 PNG,所以选 ffmpeg。
- **悬着的取舍**:Xvfb 里 Chromium 起不了 GPU 进程,而镜像默认参数里有 `--disable-software-rasterizer`
  —— 那条堵死了软件渲染这条退路。**去掉它会治好白板,但会换来"渲染资源初始化失败"的模态框**
  (见 3.3)。两条是同一处权衡的两头。
  (`真机验过`,见 交接9 §1.2/§2.3、交接10 §1.3、交接11 §1.3)

### 3.2 Windows(要另写的半,只有形状、没有实测)

- **找窗 + 前台 + 置顶**:按标题找窗 → **临时置顶**(★ 不能省:别的窗口盖在 QQ 上时,
  直接抓屏抓到的是**别的窗口**)→ 按窗口内相对坐标点一下 → `CopyFromScreen` 抓图。
- **坐标**:窗口内 `(118,508)` 接听、`(292,508)` 挂断 —— 与 Linux 量到的**尺寸一致(360×640)**,
  所以同一套相对坐标两边都能用。**但跟着 QQ 版本/皮肤/语言走,必须每次抓图自检,不许写死当契约。**
- **UIA(语义化)那条可选**:QQ 现在**没开** Chromium 可访问性,所以 UIA 只看得到一个
  `Chrome Legacy Window` **空壳**,拿不到控件。想要语义化元素,得给 QQ 加
  `--force-renderer-accessibility` 然后**重启 QQ**(代价:重登一次)。**本机是像素和语义都能走,
  云上 X11 只能像素** —— 所以别为它设计依赖。
  (`只是推断`,见 交接7 附/§附;交接12 §3.2)

### 3.3 ★ 两条"像素驱动"的必踩坑(两类环境都要带)

1. **点完必须验**。桥现在**点完就把 `phase` 设成 `connected` 并推给 World,没有任何"点到了没有"的
   验证** —— 所以控制台显示"接通了",而他手机在响。真实成因:来电窗上弹了一个**模态对话框**
   (「渲染资源初始化失败,显示驱动不兼容」),Qt 模态**拦住下层窗口的鼠标事件**,把点接听那一下吃掉了。
   ⇒ 修法:**点完之后要验**(弹窗是否消失 / 窗口布局是否变成通话中 / PulseAudio 里是否真出现了通话流),
   验不过就照实报失败。**这条还没修,是第 0 节那条债务。**
   (绕开症状的临时办法:弹窗上「我知道了」在窗口内约 `(275,378)`,点掉它再点接听。)
2. **"点下去本该发生什么"要一件一件量清**。主动拨那条路上量到:搜索框 `xdotool type` 喂不进中文
   (多字节序列报错);喂纯数字能进框但**不弹结果下拉**,按 `Return` 只把搜索清空;联系人列表
   状态太飘(同一坐标一次落在一个好友、另一次落在另一个),**每次点击前必须抓图定位**;
   双击好友不一定出资料卡,而资料卡上那颗「音视频通话」**点了两次都没拨出去**。
   ⇒ 所以它**不是"写个脚本就行"**,是一次需要安静环境的界面自动化 spike:固定窗口几何 →
   每步抓图自检 → 一次只验一个动作。
   (`真机验过`,见 交接11 §1.2/§1.3;交接9 §2.2;交接10 §6)

---

## 4. 音频地基(照这个做,云上已经验过)

容器里 `apt install pulseaudio pulseaudio-utils libasound2-plugins`;
★ **另需三个库,缺了来电连界面都不画**:`libpulse-mainloop-glib0 libegl1 libopengl0`
(缺时的现象:`Failed to load Pepper module from libAVSDKPlugin.so (error:
libpulse-mainloop-glib.so.0: cannot open …)`,聊天下只留一条「[语音通话] 未接听」)。

以 **uid 1000 + `XDG_RUNTIME_DIR=/tmp/runtime-1000`**(与 QQ 自己的 uid 一致)起 PulseAudio,
配置里建两条 null sink(`sl_speaker` / `sl_mic`)+
`module-remap-source master=sl_mic.monitor source_name=sl_mic_source`,
`set-default-sink sl_speaker` / `set-default-source sl_mic_source` ⇒ **QQ 自动就用**
(**"选设备"这一步可以完全不点界面**,让 QQ 起来就用默认设备)。

流格式:播放 `s16le 1ch 44100Hz` / 采集 `s16le 2ch 44100Hz`。
★ **不需要 `qq-pulse-guard.so`**(那是路 A 的 AV Host 用的)。
⇒ 与路 A 的差别:**B 白拿了 PulseAudio 两条 null sink;Windows 上没有,得用 VoiceMeeter 那两条
独立虚拟声卡**(VAIO 一对 + AUX 一对,正好两个方向;不用另装 VB-CABLE)。
★ Windows 的一条坑:**"通话设备"(`eCommunications` 角色)与平时那套是分开的** ——
"他平时能听见"不等于"电话能听见";要么在 **QQ 自己的通话设置**里把扬声器/麦克风指到 VoiceMeeter
那一对(首选),要么改系统 `eCommunications` 默认(会波及他别的语音软件,要先同意)。
(`真机验过`(Linux);`只是推断`(Windows),见 交接9 §1.3;交接7 附二;交接12 §3.3)

---

## 5. 部署法(Linux 容器,真装过)

桥是**单文件 + 一条 supervisord 配置**,加进去**不重启 QQ**(所以不触发重扫码):

```bash
# 1) 文件
docker cp sl-bridge.mjs <容器名>:/opt/sl/sl-bridge.mjs
# 2) 配置(照 cloud/sl-bridge.json.template 写;600,属主=跑桥的那个 uid)
# 3) 交给 supervisord 看住(别去改主配置,用它自带的 include 目录)
#    /etc/supervisor/conf.d/sl-bridge.conf:
#    [program:sl-bridge]
#    command=/usr/local/bin/node /opt/sl/sl-bridge.mjs /opt/sl/bridge.json
#    user=<跑 QQ 的那个用户>          ← 与 QQ / PulseAudio 同一个 uid(1000)
#    environment=HOME="…",DISPLAY=":1",XDG_RUNTIME_DIR="/tmp/runtime-1000"
docker exec -u 0 <容器名> supervisorctl -c /etc/supervisord.conf reread
docker exec -u 0 <容器名> supervisorctl -c /etc/supervisord.conf update   # 只起新程序,不碰 qq
```
★ **`update` 不会重启 qq**(它没变化)⇒ **不触发重扫码**。加这条之前先记下
`supervisorctl pid qq`,加完再比一次,**两次一样才叫"没碰它"**。

**监听绑哪**:容器在 **bridge 网络**时绑 `0.0.0.0`(容器没发布端口 ⇒ 外面够不着,只有宿主够得着);
桥跑在**宿主网络**(`--network host`)时**必须换回 `127.0.0.1`**,否则等于把口暴露在公网上。
(见 `sl-bridge.json.template` 的注释 —— 注意这与路 A 恰好相反,路 A 的桥**只肯绑回环**。)

**依赖**(缺了就起不来或画不出界面):`xdotool` / `parec` / `pacat` / `pactl` / **`ffmpeg`**
(截图走 `-f x11grab`)/ 两条 null sink + `sl_mic_source`。

**验收(协议层,不需要他打电话)**:

```bash
corepack pnpm bridgeprobe --url ws://127.0.0.1:<本机端口>/v1/stream --token-file <令牌文件>
#   期望:握手成功、报 pcm_s16le 48000Hz 2ch、能力表里 receiveAudio/sendAudio/screenshot 都 supported
```
**World 那一层**:把真 World 挂到真桥上,用一个叫「语音通话」的替身窗(`xmessage`)冒充来电窗,看它
有没有投出带附件的 `phone.ringing` —— 这一档**真跑过、全过**(替身窗那条唯一动的只有本机端口)。
(出处:cloud/README 第九节;交接10 §1.1/§1.5;`cloud/sl-bridge.json.template`。(`真机验过`))

### 换线时 World 侧要跟着改的几格

| 键 | 到界面驱动版 | 为什么 |
|---|---|---|
| `PHONE_BRIDGE_TOKEN` | 换成**这个桥**的令牌 | 两个桥的令牌**不是同一个**;401 是**静默**的,只在 `phone_status` 里看得见(field-notes 7.8) |
| `ssh.remoteHost` | 桥在容器里时填**容器地址**(`docker inspect …` 现取);桥在 host 网络时 `127.0.0.1` | 容器重建后地址会变(field-notes 7.7) |
| `ssh.recoverCommand` | **置空**(界面驱动版**没有 AV Host**) | 那条命令指着的是停着的另一个容器,留着就是"静默失败" |
| `autoAnswer` / `rejectUnknown` / `callers` | 看你要不要"她看图决定接不接" | 界面驱动版**看不出号码**,桥一律报预设 `expectedCallerUin`;名单里必须有它,否则被当陌生号拒 |
| `ringTimeoutSec` | 30 → 45 | 她"看了图再决定"要花时间(一次模型调用几秒到十几秒),30 秒太贴脸 |
| `ssh.enabled` | 本机跑时 `false`;云上经隧道 `true` | —— |

(出处:交接10 §2;交接11 §2。(`真机验过`))

---

## 6. 验证到哪一级(汇总,别含糊)

| 层 | 到哪一级 |
|---|---|
| **协议层**(握手/单对端/幂等/op 与推送) | **真机验过**(真容器) |
| **界面驱动链**(发现来电 → 点接听 → 双向音频 → 挂断) | **在 Linux 上量到过**(人工/脚本):来电窗 `360×640`、接听在窗口内 `(118,508)`、双向音频实测、挂断红钮 `(288,509)`;**但最后一次真打的一通没接通**(见 3.3) |
| **端到端**(真来电窗 + 他的手机 + 她决定接不接) | **没验过** |
| **World 侧那一遍**(真 World + 真隧道 + 真桥,替身窗冒充) | **真机验过、全过**(不需要他打电话) |
| **Windows 版** | **没写过**;音频那半**只有形状、没有实测** |

⇒ 按本工作区的纪律:交给开发者看第三级之前,前两级要自己跑完;这一条的第三级**从来没到过**。
如果你要接手,第一步就是**补 3.3 那条"点完要验"**,再把端到端走一遍。
(出处:交接8 §4.1;交接9 §1.2;交接10 §1.5/§3;交接11 §1;交接12 §3。(`真机验过` + 未验))

---

## 7. 回落 / 退路

- 桥是**单文件 + 一条 supervisord 配置**:`supervisorctl stop sl-bridge` + 删掉那份 conf 就回到原样
  (**QQ 全程没动过**)。
- 容器全清:`docker rm -f <容器名>`(镜像同理)。
- **回到路 A**:起 A 那个容器 + 扫一次码(A 那套原封不动);World 那边把 `remoteHost` 改回
  `127.0.0.1`、令牌换回 A 的、`recoverCommand` 填回 `docker exec <A 的容器名> pkill -f av-host-profile`。
- **假窗口提醒**:自检时在容器里放过 `xmessage` 替身窗,**用完要清掉** —— 你要是发现屏上多一个叫
  「语音通话」的空白窗,那就是没清干净。

---

## 8. 与另外两份文档的关系

- 坑与判据(尤其是模态框吃点击、`xdotool --name` 中文、白板、401 静默、超时窗口):`field-notes.md`。
- 已跑通的那条(云上 Linux + NapCat + 上游桥 + 逐 build 审计):`route-a-cloud-linux-napcat.md`。
- 装进部署、配置、persona 那一环:同目录 `cortico-side.md`。
