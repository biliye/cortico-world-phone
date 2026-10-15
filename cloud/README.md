# 电话:云侧那半的部署胶水

这一目录是**我们自己的脚本与说明**,不是上游的代码(上游那套 `KoishiRTC` 是 GPL-3.0,我们只跑、
按它公开的协议跟它说话;`daemon.mjs` 那些一行都不抄)。这里放的是:怎么把那台机器上的桥
**可靠地起起来、接得到、看得住、退得回**。

### 连续播放修复（2026-10-15）

本地400ms发送帧与 Pulse 后端默认100ms空队列关闭不兼容。新 `boot-rtc.sh` 设置
`audio.idleDrainMs=1500`；已有部署在容器内运行 `python3 configure-playback-idle.py`
先预检，再经部署者确认加 `--apply`，同时更新 `/opt/rtc/bridge.json` 与
`/opt/rtc-src/boot-rtc.sh`。脚本要求无活动通话，先保存600权限备份，不重启任何服务。
之后只重启读取这份配置的桥守护进程，不需重启 QQ、AV Host 或容器。若回退，使用输出的备份路径
恢复这两个文件并重新加载桥。完成回执最多多等约1.5秒空闲；显式 clear 不等待该计时。
这是模块模拟验证过的启停修复，真实听感仍需通话验收。

## 一、拓扑(先把东西摆清楚)

```
他的 QQ ──► 协议端那台机器(<那台的地址> / <实例 id>,这一轮的参照环境是 Ubuntu 24.04 x86_64)
            容器 phone-test(--network host)
              ├─ QQ 3.2.34-53644(官方 deb,带 libAVSDKPlugin.so)
              ├─ NapCat + KoishiRTC 插件        → 127.0.0.1:6110(插件控制口)
              ├─ AV Host                         → 127.0.0.1:6111
              ├─ 隔离 PulseAudio(socket 在 /work/test/bridge/runtime/pulse/native)
              └─ 桥守护进程 node daemon.mjs      → 127.0.0.1:6120(WS 在 /v1/stream)
                                ▲
    本机 Cortico 进程 ──────────┘  ssh -N -L 6120:127.0.0.1:6120
      cortico-world-phone 连的就是 ws://127.0.0.1:6120/v1/stream
```

**为什么必须 `--network host`**:上游 `daemon.mjs` 里有一条硬约束 ——
`桥接仅监听本机；远程部署请使用 SSH 隧道或本机 TLS 反向代理`,它**拒绝绑非回环地址**。
容器用 bridge 网络时,它的 `127.0.0.1` 是容器自己的,宿主的回环够不着,而发布端口又解决不了
(它不肯听 `0.0.0.0`)。用 host 网络后容器的回环就是宿主的回环,隧道直连即可。

**这条不新增对外暴露面**:插件口(6110)与 AV Host(6111)在上游自己的安装里就写着
`controlHost: '127.0.0.1'`,也是回环。所以对外一个端口都没多开。

## 二、本机这一侧要什么

1. **一把能登那台的 SSH 密钥**(只有密码登录不够:无人值守的隧道不能每次等人敲密码)。
   装法见 `install-tunnel-key.md` —— 走 workbench 那条已经认证过的通道,不经过对话记录,
   也不要求开发者手写密码。
2. 部署 `.env` 里 `PHONE_BRIDGE_TOKEN=<桥的令牌>` —— 令牌就是容器里
   `/work/test/bridge/runtime/control.token` 的内容(`cat` 出来填进去,**别贴到聊天里**)。
3. `worlds.phone.ssh` 填上主机、用户、私钥路径,`enabled: true`。之后隧道由 World 自己拉起并看护。

想先用一次性的方式验隧道,用 `tunnel.sh`(本机跑,人工看着)。

## 三、起一次栈(云上跑)

```
bash cloud/up.sh          # 停生产 napcat + 腾内存 + 重建容器(host 网络) + 起栈 + 起守护进程
```

它会:
1. `docker stop napcat`(**同一个 QQ 号不能同时登两处**,不然后续登录必然被挤掉);
2. `docker stop ln-web ln-backend ln-mysql`(那台只有 1.6G 内存,双 QQ + AV Host 要腾位置);
3. `docker rm -f phone-test` 并用 `--network host` 重建(绑 `/opt/phone:/work`,entrypoint `sleep infinity`);
4. 容器内跑 `/work/p3-login.sh` 起栈并登录(可能要扫码:二维码在容器的
   `/app/napcat/cache/qrcode.png`,拷到宿主再下载给他扫);
5. 起守护进程并探 `/healthz`。

登录那个坑记着:**账号被拒一次(`ErrType 1 ErrCode 10`)不是风控** ——
NapCat 只在 `ErrCode 3`(码过期)时才换新码,别的错误码当普通失败就停住。人工重起一次登录、
让同一个人再扫就成。

## 四、看住它

- `watchdog.sh`(**在容器里**跑,建议交给宿主的一个 systemd timer 或 cron 每分钟一次):
  查插件口的通话状态,**卡在 `ending` / `rejecting` / `accepted` / `dialing` 任何一种超过 60 秒就
  `pkill -f av-host-profile`**(`rejecting` 是常见那种,但 `ending` 那一侧也卡过,所以认四种;
  以 `watchdog.sh` 里的 `case` 为准),它的 supervisor 会拉起来,换 bootId 后那通才会走到 `ended`。
  World 那边也认这个状态(`worlds.phone.ssh.recoverCommand` 填同一条命令),两边都行、不冲突。
- 出问题时先跑 `probe.sh`(只读):它把容器网络模式、三处端口、进程、日志尾巴一次列出来。

## 五、退回去(回滚)

```
bash cloud/down.sh        # 停测试栈:停守护进程 + 停容器 + 把生产容器起回来
```

彻底不留痕迹(测试那套整个删掉):

```
docker rm -f phone-test
docker rmi phone-test:1
rm -rf /opt/phone /opt/phone-deb
```

**生产那一侧从没被改过版本**:生产容器还是 `3.2.30-50969`,只动过配置里的两个 token
(旧文件在 `/opt/napcat/config/*.bak-20261009`)。所以回滚不需要恢复生产 QQ。

## 六、验一遍"路通不通"(本机跑)

```bash
# ① 本机有没有那条隧道(World 自己会拉;没有就先查 worlds.phone.ssh)
curl -sS -o /dev/null -w '%{http_code}
' http://127.0.0.1:6120/healthz      # 期望 200
# ② 按 World 那条路连一次 WS,把握手与状态摊开(包里的小工具)
corepack pnpm bridgeprobe
```

`bridgeprobe` 会报账号、音频格式、`receiveAudio`/`sendAudio` 是否 supported、当前有没有通话。
**先看它,再看她**:电话不响有七八种原因,这个工具能把"路不通"与"她没反应"分开。

## 七、别踩的坑(一条都别重踩)

- ★ **`pulse-no-move.so` 必须现编,漏了它声音整条是哑的**(桥会说 `receiveAudio: supported=false`,
  诊断里一行 `refusing unpinned PulseAudio capture.`)。它**不在**源码包里,由 `/work/koishi` 下的
  `node bridge/audio/build-pulse-shim.mjs` 编出来。与 `install.py` 编的 `qq-pulse-guard.so`(给 QQ 用)
  是**两个不同的文件** —— 2026-10-09 实测:只编过后者,桥照样是哑的。`up.sh` 已经带上这一步了。

- `docker restart/stop+start napcat` 会**登出**,要重扫码。
- `pkill -f daemon.mjs` 会**把执行它的那个 shell 自己也匹配掉**(命令行里含这个字符串)⇒ 脚本自杀、
  后半段静默不跑。用 `pkill -f '[d]aemon\.mjs'`。
- ★ **状态字段有两套**:容器内**插件口**叫 `phase`,**守护进程那条 WS**(World 连的那条)叫 `state`;
  对方是谁也分 `callerUin` / `targetId`。解析器要"有什么认什么",只读一个会**静默忽略每一通**。
  `inviteAt`/`endedAt` 是**毫秒**。
- 回执 `submitted` 只表示"提交给了 AVSDK",不等于接通;接通看状态字变成 `connected`。
- 别用 `apt-get -f install`(会把 `linuxqq` 卸掉);apt 源已换阿里云(原源解析成 IPv6,这台没 IPv6)。
- 上游 `scripts/probe.py` 用了 Python 3.11 的 `hashlib.file_digest`,容器是 3.10 ⇒ 报错。
  **是它的 bug**,别去改配置。
- 别再打印令牌。旧 OneBot token 就是被 `head -c 400` 打进会话记录才换的。
- workbench CLI v1.0.0 的 exec 通道是坏的(v1.0.1 修好);它是 Windows 程序,
  本地路径写 `/tmp/x` 会被解析成当前盘根,`download` 跑在**宿主**上、
  容器里的 `/work/...` 要写成宿主的 `/opt/phone/...`,目标文件已存在时它会交互式问覆盖。

## 八、路 A1:把电话并进生产容器(文字 + 电话同一个号、同一个容器)

上面第一到第七节讲的是**测试那套**(`phone-test`,与生产互斥、要用时手动切)。
这一节是 2026-10-10 他选定并做完的**整合**:生产那份容器直接变成「文字 + 电话」合一的
`napcat-rtc` —— 一个号既跑 OneBot 文字(3001)又跑语音(6110),不再需要切来切去。

### 为什么必须先换 QQ 版本(这一条最要紧)

桥的原生能力是**逐 build 审计**的:插件里 `native-profile.mjs` 钉着
`qq-linux-3.2.34-53644-x64` 与那版 `libAVSDKPlugin.so` 的 SHA256(还有几个原生函数偏移)。
生产容器原来是 `3.2.30-50969`,库哈希对不上 ⇒ 电话能力整片 `unavailable`
(代码里那句 `Requires an exact audited QQ library, build, platform and architecture.`)。
所以镜像构建时把 **`3.2.34-53644` 那棵树烤进 `/opt/QQ`**(`Dockerfile.rtc` 第 6 步),
并在构建时校验库哈希 —— 哈希不对就让构建失败,不会带着错版本上线。

⇒ **代价照实说:QQ 以后每升一次,都要重做一遍**(拿新 deb → 重审计原生地址 →
改 `native-profile.mjs` 的 `qqVersion`/`librarySHA256`/偏移 → 换构建上下文里的 `qq/` → 重打镜像)。
这就是"一行升级"的账单,不是故障。

### 四个文件

| 文件 | 在哪跑 | 干什么 |
|---|---|---|
| `Dockerfile.rtc` | 宿主(构建) | 官方 napcat 镜像 + pulseaudio/gcc/Node22 + 换 QQ + 把钩子插进 entrypoint |
| `boot-rtc.sh` | **容器里** | entrypoint 在 QQ 起来**之前**调它一次 `prep`:装文件(幂等)+ 起隔离音频 + AV Host + 桥 |
| `up-rtc.sh` | 宿主 | 建镜像(缺则建)+ 搬令牌与 AV Host 登录态 + 停生产 + 起 `napcat-rtc` + 等两条线 |
| `down-rtc.sh` | 宿主 | 回滚:停 `napcat-rtc`,把生产 `napcat` 起回来 |

### 宿主上要摆的东西

```
/opt/rtc-src/            # 这四个脚本 + koishi/(上游桥源码树,含 node_modules/ws)
/opt/rtc-src/ctx/        # 构建上下文:Dockerfile.rtc + qq/(审计版 QQ 树,cp -al 硬链接不占盘)
/opt/napcat/rtc/         # 桥的安装目录 → 容器 /opt/rtc(runtime/ 与 logs/ 要留住)
```
容器挂四处:`/opt/napcat/qq → /app/.config/QQ`、`/opt/napcat/config → /app/napcat/config`
(这两处与生产**完全一样**,所以回滚只是换个容器名)、`/opt/napcat/rtc → /opt/rtc`、`/opt/rtc-src → /opt/rtc-src`。
网络必须 `--network host`(上游桥拒绝绑非回环;生产原来是 bridge + 发布端口,换 host 后
文字线客户端连的 `ws://<那台的地址>:3001` 照旧)。

### ★ 一次切换的顺序(这就是断线窗口里做的)

```
bash up-rtc.sh                 # 缺镜像就建;默认把 learn-notes 停掉腾内存(--keep-ln 可保留)
#  → 停生产 napcat → 起 napcat-rtc → 等 3001/6110
#  → 要二维码就取:/opt/napcat/qr/rtc-qr.png(约 2 分钟换一张)
#  → 他扫码之后的验收四件:
#     ① 文字线照常收发(他那边随口发一句,QQ 上要有回复)
#     ② 电话能力不是 unavailable:
#        docker exec napcat-rtc curl -sS -H "Authorization: Bearer $(cat /opt/napcat/rtc/runtime/control.token)" \
#          http://127.0.0.1:6110/v1/capabilities
#     ③ 他打一通:她接得起、听得到、说得出(World 收尾日志里 heard/spoke 都 > 0)
#     ④ 顺手试「说轻一点/周围很吵会不会被当成没听清」
bash down-rtc.sh               # 任何一步不对:回滚(生产起回,可能要重扫码)
```

★ **切完之后有一格必须跟着改**:部署 `config.json` 里的
`worlds.phone.ssh.recoverCommand` 原来指着老容器(`docker exec phone-test pkill -f av-host-profile`),
A1 之后要改成 `docker exec napcat-rtc pkill -f av-host-profile`。
**它不报错,只会在她想自愈的时候静默地失败** —— 每换一次容器名都要记得改。

### 干跑验证(不占窗口、不碰那个账号)

镜像建好之后,可以在一个**抛弃式容器**里只走"装文件"那三步,提前把安装路径验一遍:

```
docker run --rm --entrypoint bash \
  -v /opt/rtc-src:/opt/rtc-src -v /tmp/rtc-dry:/opt/rtc \
  napcat-rtc:1 -c 'bash /opt/rtc-src/boot-rtc.sh files && cat /opt/rtc/runtime/install-manifest.json'
```
它不会起 QQ、不连网、不占账号(所以**不要**在这里跑 `prep`,那会起 AV Host 去登那个号)。

### 一条纪律

**回滚不用恢复生产 QQ**:生产那份镜像、QQ 与 `/opt/napcat/{qq,config}` 两处挂载全程没动过,
`docker start napcat` 就是回到今天早上;唯一要人配合的是它重启后可能又要扫一次码。

## 九、路 B:SnowLuma 那条桥(界面驱动,`sl-bridge.mjs`)

A1 那条桥靠的是「插件口 + AV Host」,而它钉死在 QQ `3.2.34-53644` 那个 build 上(见上一节)。
2026-10-11 起还有**另一条路**:容器里跑**真的 QQ 客户端**(SnowLuma 注入),桥改成
「**看屏幕 + 搬音频**」—— 用 `xdotool` 点接听/挂断那两颗钮,用 `parec`/`pacat` 抬音频。
好处是不再逐 build 审计原生地址(界面就是接口);代价是它**只能像素级操作**。

### 它与老桥的关系

- **协议逐字一致**:路径 `/v1/stream` + `Bearer` + 不许带 `Origin` + 单对端 +
  `{type:'request',id,op,args}` ↔ `{type:'reply',id,ok,data|error}` + 同 id 幂等 + 五类推送。
  ⇒ **World 那侧一个字节都不用改**(除了多出来的 `screenshot`,见下)。
- **多一个 op:`screenshot`** —— 抓一张来电窗的 PNG(base64)回来。原桥没有这个 op,
  老桥收到它会回 `UNKNOWN_OP`,World 就当"这次没图",照常往下走(正文退回到报桥给的号)。
- **已知缺口两条**(写在文件头,别当 bug):①**看不出谁打来的** —— 来电窗是像素,
  `callerUin` 报的是配置里那个 `expectedCallerUin`(**预设,不是事实**);
  ②`dial`(她主动拨)不支持,回错误,World 会投 `phone.outgoingFailed`。
  ★ 缺口①现在由 `screenshot` 补上:World 把图挂在她收到的响铃事件上,她读图上的名字。

### 部署(容器里四件事)

```bash
# 1) 文件(单一文件,只用 Node 内建 —— 容器里没有 npm,不装任何依赖)
docker cp sl-bridge.mjs  <容器>:/opt/sl/sl-bridge.mjs
# 2) 配置(照 cloud/sl-bridge.json.template 写;600,属主=跑桥的 uid)
# 3) 交给 supervisord 看住(别去改主配置,用它自带的 include 目录)
#    /etc/supervisor/conf.d/sl-bridge.conf:
#    [program:sl-bridge]
#    command=/usr/local/bin/node /opt/sl/sl-bridge.mjs /opt/sl/bridge.json
#    user=snowluma            ← 与 QQ / PulseAudio 同一个 uid(1000)
#    environment=HOME="/app",DISPLAY=":1",XDG_RUNTIME_DIR="/tmp/runtime-1000"
docker exec -u 0 <容器> supervisorctl -c /etc/supervisord.conf reread
docker exec -u 0 <容器> supervisorctl -c /etc/supervisord.conf update   # 只起新程序,不碰 qq
```

★ `update` **不会重启 qq**(它没变化)⇒ **不触发重扫码**。加这一条之前先记下
`supervisorctl pid qq`,加完再比一次,两次一样才叫"没碰它"。

**依赖**(缺了就起不来或画不出界面):`xdotool` / `parec` / `pacat` / `pactl` /
**`ffmpeg`**(截图走 `-f x11grab`,比 `xwd` 少一道转码)/ 两条 null sink
(`sl_speaker` + `sl_mic`,另加 `module-remap-source` 的 `sl_mic_source` —— 见交接 9 §1.3)。
缺 `libpulse-mainloop-glib0 libegl1 libopengl0` 时**连来电界面都不画**。

### 隧道怎么够着它(两个网络位置)

桥在**容器里**(`--network bridge`,试炼那套)时,容器的回环不是宿主的回环:

```
worlds.phone.ssh.remoteHost = <容器地址>       # docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <容器>
```
桥跑在**宿主网络**(`--network host`,将来并进生产时)才保持默认的 `127.0.0.1`。
⇒ 这一格就是为这件事加的(`worlds.phone.ssh.remoteHost`,默认 `127.0.0.1`)。

### 坑(2026-10-11 实测,别重踩)

- ★ **别把中文交给 `xdotool --name`**:容器里只有 C/POSIX locale,`--name 语`/`--name 语音通话`
  全返回空(同一串字节用 `grep` 比就对)。`sl-bridge.mjs` 里已经改成"快路先试、空手就列窗+
  在 JS 里比名字"。**没修的症状是:整条界面驱动永远看不见来电窗,而日志里一句错都没有。**
- **抓图用 `ffmpeg -f x11grab`**(`-draw_mouse 0`,`-video_size` 用窗的宽高,`-i :1+X,Y`),
  连拉进程约 1.5 秒/张 —— 响铃那几秒够用,别拿它做逐帧。
- **`pkill -f "xmessage -title"` 会把自己也匹配掉**(那条 shell 的命令行里就有这串)——
  跟 README 第七节 `daemon.mjs` 那条一个道理,用 `pkill -f "[x]message -title"`。
- 抬窗 + 等一拍再点(`windowraise`/`windowactivate` + `readyDelayMs`)不能省:窗口刚映射就点会点空。

### 验一遍(两级,都不需要他打电话)

```bash
corepack pnpm bridgeprobe --url ws://127.0.0.1:6120/v1/stream --token-file <令牌文件>   # 协议层
# World 那一层:把真 World 挂到真桥上,用一个叫「语音通话」的替身窗(xmessage)冒充来电窗,
# 看它有没有投出带附件的 phone.ringing(脚本见交接 10)
```


