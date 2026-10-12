# 路 A:云上 Linux + NapCat + 上游桥 —— 已跑通的那条

这一条是**已经真机跑通过**的:云上一台 Linux,容器里跑 QQ + NapCat + 一个第三方桥
(KoishiRTC 那条,基于 QQ 自带的 `libAVSDKPlugin.so`),桥对外给一条 WebSocket;本机的
`cortico-world-phone` World 连它,于是她能接真来电、听见对方、说出话、挂断。

**它不做什么**:这个包不产生通话能力,它只是**本机对端**。真正的通话在云上那个桥手里。
所以这一份文档有一半在讲云上那半怎么起、怎么看住、怎么退回去。

**红线**:上游那套是 **GPL-3.0-only**。**只跑它、只按它公开的协议跟它说话,不抄它的代码。**
我们的包仍是 MIT。

## 0. 先立一张占位符表(下面出现就照这张表换)

| 占位符 | 它是什么 | 这个值从哪里来 |
|---|---|---|
| `<你的主机>` | 那台 Linux 的地址(IP 或域名) | 你的云控制台;或在机器上 `uname -n` / `hostname -I` |
| `<你的用户名>` | 登录那台的用户(桥的场景通常是 root) | 你自己定的 |
| `<你的 SSH 私钥>` | 给隧道用的私钥文件路径,本机 | 你自己一条 `ssh-keygen` 生成(见第 3 节) |
| `<桥令牌>` | 桥的 Bearer 令牌 | 桥运行时目录里的 `control.token` 的内容;或你自己设的随机串(界面驱动版才这样)。取值命令见第 5、6 节 |
| `<容器名>` | 你怎么叫那个容器 | 你 `docker run` 时起的名字;本文举例用 `napcat-rtc` |
| `<你的 QQ 号>` | 话机那个号(NapCat 的 `selfId`,必须是真实 UIN) | 你自己的号 |
| `<接听名单>` | 允许打进来的号 / uid | 你要接的那些人(uid 与 uin 都放,见 field-notes 1.3) |
| `<上游桥源码树>` | KoishiRTC 的源码树,里面才有 `bridge/daemon.mjs` | 从上游仓库取(见第 4 节;`daemon.mjs` **不在安装目录**) |
| `<审计版 QQ 的 deb>` | 上游审计过的那个 QQ 版本的官方 deb | 官网下载;**脚本客户端会被 403,要真浏览器**(见第 2 节) |
| `<审计构建号>` | 上游钉的 QQ 版本字符串 | 上游 `bridge/qq/native-profile.mjs` 里的 `qqVersion` |
| `<AVSDK 库哈希>` | 上游钉的 `libAVSDKPlugin.so` 的 SHA256 | 上游 `native-profile.mjs` 里的 `librarySHA256` |

**端口**(这些是协议默认值,不是环境专有的):插件口 `6110`、AV Host `6111`、桥守护进程 `6120`
(WS 在 `/v1/stream`)、QQ 文字线 OneBot `3001`、NapCat WebUI `6099`。6110/6111/6120 上游自己就
绑 `127.0.0.1`。

---

## 1. 先量四样,再选路(不写一行代码)

上游文档只对 **Linux ARM64** 给过真机验收;x64 与 Windows 它只有静态核对。所以先在这台机器上
量四样,它们决定这条路到底可不可行。**全部只读,零风险。**

```bash
# ① 架构
uname -m && uname -a

# ② QQ 是不是完整官方包(有没有 AVSDK 那棵树)
sudo ls -l <QQ 安装路径>/resources/app/avsdk/libAVSDKPlugin.so
#   期望:文件在,几十 MB。不在 ⇒ 这个 QQ 不是一个完整官方包,路 A 直接不成立。

# ③ QQ 版本与它的库哈希
python3 -c "import json;print(json.load(open('<QQ 安装路径>/resources/app/package.json'))['version'])"
sha256sum <QQ 安装路径>/resources/app/avsdk/libAVSDKPlugin.so
#   期望:版本 == <审计构建号>,哈希 == <AVSDK 库哈希>。对不上 ⇒ 见第 2 节(要换 QQ)。

# ④ NapCat 是不是能挂插件的形态,以及有没有 PulseAudio 与 C 编译器
ls -l <QQ 安装路径>/resources/app/loadNapCat.js
cat  <QQ 安装路径>/resources/app/loadNapCat.js
command -v cc gcc make pulseaudio pactl parec pacat
```

| 量到的 | 判定 | 走哪条 |
|---|---|---|
| x64(或 arm64) | A 在"真机跑通过的只有 ARM64"那一栏之外 | 继续,**但你可能是第一批**,见第 2 节 |
| 完整官方包 + 哈希对得上 | 原生能力会被认 | ✅ 继续 |
| 哈希对不上 | 原生能力**整片 unavailable** | 换 QQ(第 2 节),或改走 `route-b-ui-driven.md` |
| `loadNapCat.js` 是 CommonJS 形态(`require` + `import('./napcat/napcat.mjs')`) | 能挂本地插件 | ✅ 继续 |
| 是 pure-shell / bytecode(一行 ESM import) | 形态不同 | ⚠️ 未必拦路,**但换 QQ 时本来就要重装 NapCat,以那次为准** |
| 有 `cc`/`gcc`/`make` | 能在目标机上现编两个 `.so` | ✅ |
| 有 PulseAudio 全套 | 音频地基在 | ✅;缺了要装(第 4 节镜像里带了) |

> 出处:design/cortico-world-phone 附二、附三;plan 第十节。(`真机验过`)

---

## 2. ★ 硬约束:原生能力是**逐 build 审计**的,以及它的账单

桥的原生通话命令(接听/拒接/挂断/拨号)不是"接口",是**逆出来的原生函数地址**。所以上游
`bridge/qq/native-profile.mjs` 里钉的**不只是版本号**:

- `qqVersion`(`<审计构建号>`);
- `librarySHA256`(`<AVSDK 库哈希>`,那个 `libAVSDKPlugin.so` 的哈希);
- 还有几个**原生函数偏移**(x64/arm64 各一份)。

**它按精确 SHA256 认构建,不按相似度。** 对不上时,代码里那行的后果是:

```
cap('unavailable', 'Requires an exact audited QQ library, build, platform and architecture.')
```

⇒ 电话能力**整片**是 `unavailable`(不是"部分不好用")。所以:

- **必须把 QQ 换成审计过的那一版**(拿 `<审计版 QQ 的 deb>` 装一整棵树,不是把新库单独塞进旧安装
  —— 上游当初在 ARM64 上踩过"应用目录被剥掉、没有 avsdk"的坑);
- **x64 那一栏没有公开的真机验收记录**(它公开的成功记录只有 Linux ARM64)。你去做可能就是第一批,
  可能白做 —— **先用一个测试号在隔离副本上跑通,再谈切生产**(上游文档也是这么要求的)。

### 这条约束的账单:QQ 每升级一次都要重做一遍

"一行升级"就是从这里来的,不是故障。QQ 升级时要重做:

1. 拿官方 deb(**官网直链对脚本客户端一律 403** —— 裸 curl、伪装浏览器指纹全 403,是**按客户端**
   判的;得用**真浏览器**点官网下载按钮);
2. **重新审计原生地址**(对 ELF 符号表/重定位/反汇编取偏移 —— 上游做这件事的量级是"几天");
3. 改 `native-profile.mjs` 的 `qqVersion` / `librarySHA256` / 偏移;
4. 重建安装副本、**在现场重编两个 `.so`**;
5. **重装插件补丁**(它的 hook 哈希会变)。

⇒ **把这条写进你的部署说明**:以后每次 QQ/NapCat 升级,都要重装、重诊断、**用测试号重打一遍**,
"不要未经验证直接替换正在运行的生产链路"。
(出处:整合A-评估 §约束一/§4;plan §10.1;交接 §4.1/§11。(`真机验过` + `只读过代码`))

---

## 3. 本机这一侧要什么

1. **一把能登那台的 SSH 密钥**。**只有密码登录不够** —— 隧道要开机就在、断了自己起,而 `ssh` 在
   没有终端时会挂在那儿等输入,表现成"看起来在跑、其实连不上"。装法(不向开发者要密码,走云控制台
   那条已认证的通道把公钥送进去):

   ```bash
   # 本机生成一把专门给隧道用的钥匙(不设密码:无人值守要它免交互)
   ssh-keygen -t ed25519 -N '' -C cortina-phone-tunnel -f <你的 SSH 私钥>
   # 把这把公钥追加到那台的 authorized_keys(用你那台机器能用的通道:云控制台 / 已有的会话)
   # 本机验一次:能免密登上去就算成
   ssh -i <你的 SSH 私钥> -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
       <你的用户名>@<你的主机> 'echo TUNNEL_KEY_OK && uname -n'
   ```
   期望最后一行回 `TUNNEL_KEY_OK` + 主机名。
   ★ Windows 自带的 `ssh` 会因为"私钥权限太开放"**直接忽略私钥**,而某些 Git 自带的 `ssh` 不看这个
   —— 把私钥的 NTFS 权限收紧成只有你本人可读。

2. **`<桥令牌>`** —— 桥运行时目录里那份 `control.token` 的内容(第 5 节给出 `cat` 的命令)。
   **别贴到聊天里**;把它填进部署的 `.env`。

3. 本机还要:`node` ≥ 22、`ssh`、能连上那台。
(出处:cloud/README 第二节;`cloud/install-tunnel-key.md`。(`真机验过`))

---

## 4. 云侧:装栈的四个文件(都在包的 `cloud/` 里)

> 这一节是**路 A1**:让**同一个容器**同时供文字线(3001)与电话线(6110/6120)。
> 部署事实(容器名、路径、账号)全在脚本的参数里,包里不写死。

| 文件 | 在哪跑 | 干什么 |
|---|---|---|
| `cloud/Dockerfile.rtc` | 宿主(**构建**) | 官方 napcat 镜像 + apt 换源 + `xdg-utils` + pulseaudio/gcc + AVSDK 缺的三个库 + Node 22 + 解出 NapCat + 把 RTC 的启动钩子插进 entrypoint + **把 QQ 换成审计版并在构建时校验库哈希** |
| `cloud/boot-rtc.sh` | **容器里** | entrypoint 在 QQ 起来**之前**调它一次 `prep`:装文件(幂等)+ 起隔离音频 + AV Host + 桥;另有 `files`(只装文件,给干跑用)与 `status` |
| `cloud/up-rtc.sh` | 宿主 | 建镜像(缺则建)+ 搬令牌与 AV Host 登录态 + 停生产 + 起 `<容器名>` + 等两条线 |
| `cloud/down-rtc.sh` | 宿主 | 回滚:停 `<容器名>`,把生产容器起回来 |

**为什么 QQ 与 NapCat 都随容器走(烤进镜像),而不是挂宿主目录**:桥要改 QQ 的加载器
(`resources/app/loadNapCat.js`)+ 改 NapCat 的 `napcat.mjs`,这两处必须在**同一次容器生命里成套
出现/成套消失**(一半持久、一半不持久会让"重装"变成报错)。所以:**镜像装软件与那两个被改的文件,
宿主只挂"要留住的东西"**(令牌、AV Host 登录态、日志)。⇒ **换 QQ 版本 = 换构建上下文 + 重打镜像**
(与"重审计"本来就是同一步)。

### 为什么必须"先换 QQ 版本"(最要紧的一条)

见第 2 节。`Dockerfile.rtc` 第 6 步会把 `<审计版 QQ 的 deb>` 解出的整棵树烤进 `/opt/QQ`,并在**构建时
校验** `<AVSDK 库哈希>` —— **哈希不对就让构建失败**,不会带着错版本上线。

### 宿主上要摆的东西(路径都可改,别写死进包)

```
<桥源码树>            # 上游桥源码树,含 node_modules/ws
<构建上下文>/ctx/      # Dockerfile.rtc + qq/(审计版 QQ 树,cp -al 硬链接不占盘)
<桥安装目录>           # 桥的安装目录 → 容器 /opt/rtc(runtime/ 与 logs/ 要留住)
```
容器挂四处(以 A1 的路径为例):QQ 账号数据、NapCat 配置(这两处**与生产完全一样**,所以回滚只是
换个容器名)、桥安装目录、上游桥源码树。网络**必须 `--network host`**(见 field-notes 7.1)。

### 干跑验证(不占窗口、不碰那个账号)

镜像建好之后,可以在一个**抛弃式容器**里只走"装文件"那三步:

```bash
docker run --rm --entrypoint bash \
  -v <桥源码树>:<桥源码树挂载点> -v /tmp/rtc-dry:/opt/rtc \
  <镜像名> -c 'bash <桥源码树挂载点>/boot-rtc.sh files && cat /opt/rtc/runtime/install-manifest.json'
```
期望:`install.py` 报 `media` 模式 + x64 + `loaderChange:true`,`enable-local-plugin.py` 报
`installed:true`,两个 `.so` 编出来,`bridge.json` 写好。
**不要**在这里跑 `prep`(那会起 AV Host 去登那个号)。
(出处:cloud/README 第八节;`cloud/Dockerfile.rtc` 注释;整合A-实施 §1/§3。(`真机验过`))

---

## 5. 起一次栈(云上跑)与验收

```bash
bash up-rtc.sh                 # 缺镜像就建;默认把你"可以让位"的其它容器停掉腾内存(--keep-ln 可保留)
                               # ★ 那几个容器名是**部署者自己的**:这一轮那台机器上写的是
                               #   ln-web/ln-backend/ln-mysql,换成你的(写进 cloud/local.env 的
                               #   FREE_MEMORY_CONTAINERS)。名字不存在也不会坏任何事。
```

它做的事与顺序(每步都有它的理由):
1. 建镜像(缺则建);
2. 从老副本搬**令牌**与 **AV Host 登录态**(令牌搬过来,他 `.env` 里就不用改;登录态搬过来,**
   可能**省一次扫码);
3. **停生产容器**(★ **同一个 QQ 号不能同时登两处**,不然后续登录必然被挤掉);
4. 起 `<容器名>`,`--network host`;
5. 等两条线起来(轮询 3001 与 6110,最多 200 秒);
6. 取二维码(见下);
7. 打印现状。

### 验收判据(每一步都给命令 + 期望输出)

```bash
# ① 容器形态:必须是 host 网络、必须带自启
docker inspect <容器名> --format '网络={{.HostConfig.NetworkMode}} 自启={{.HostConfig.RestartPolicy.Name}}'
#   期望:网络=host  自启=unless-stopped      ← 自启不设的话,机器一重启这条线就再也不回来,而且不报错

# ② 三条端口都在听
ss -tlnp | grep -E '3001|6099|6110|6111|6120'
#   期望:3001/6099/6110/6111/6120 都在

# ③ 插件真的挂上了 —— 看这三行日志(缺了就是没挂上)
docker logs <容器名> 2>&1 | grep -aE 'PluginManager|bridge listening|Loaded .* plugins'
#   期望:
#   [PluginManager] Opening plugin manager...
#   [Plugin: napcat-plugin-koishi-rtc-qq] Koishi RTC QQ bridge listening on 127.0.0.1:6110; media=true
#   [PluginManager] Loaded 1 plugins ...
#   ★ 这三行只在**登录成功之后**才出现 —— 没扫码之前看不到是正常的(见 field-notes 7.6)

# ④ 电话能力(插件口)—— 必须有 supported:true
docker exec <容器名> curl -sS -H "Authorization: Bearer $(cat <桥安装目录>/runtime/control.token)" \
  http://127.0.0.1:6110/v1/capabilities | head -c 400

# ⑤ 桥守护进程
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6120/healthz
#   期望:200

# ⑥ 音频那个守卫在不在(不在 = 声音整条哑,见 field-notes 4.1)
docker exec <容器名> ls -la <桥源码树挂载点>/bridge/audio/pulse-no-move.so
#   期望:文件在。不在 ⇒ docker exec <容器名> bash -lc 'cd <桥源码树挂载点> && node bridge/audio/build-pulse-shim.mjs'
```

### 要扫码时

二维码在容器 `/app/napcat/cache/qrcode.png`(**约每 2 分钟自动换一张**,所以抢时间):

```bash
docker cp <容器名>:/app/napcat/cache/qrcode.png <宿主上的路径>
# 再把它取到本机给他扫;失败就再取一张(码是会换的)
```
★ **登录被拒一次(`ErrType 1 ErrCode 10`)不是风控** —— 见 field-notes 7.5。
(出处:cloud/README 第三/四节;`cloud/up-rtc.sh`;整合A-实施 §0.1/§4。(`真机验过`))

---

## 6. 本机接上(隧道 + 配置 + 自查)

隧道由 World 自己拉起并看护(用户要的是"打完电话就完了",不该让他每次开机先开一条隧道)。

```
worlds.phone.ssh.enabled        = true
worlds.phone.ssh.host           = <你的主机>
worlds.phone.ssh.user           = <你的用户名>
worlds.phone.ssh.keyFile        = <你的 SSH 私钥>
worlds.phone.ssh.remoteHost     = 127.0.0.1     # 容器用 host 网络时就是宿主的回环;
                                                # 容器用 bridge 网络时填容器地址(见 field-notes 7.7)
worlds.phone.ssh.recoverCommand = docker exec <容器名> pkill -f av-host-profile
```
部署 `.env` 里给 `PHONE_BRIDGE_TOKEN=<桥令牌>`(变量名可改,见 `tokenSecret`);本机还要有
`MINIMAX_API_KEY`(嗓子)与本机识别服务(`127.0.0.1:50001`)。

**自查(本机跑,先看它、再看她)**:

```bash
# ① 本机有没有那条隧道
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6120/healthz      # 期望 200
# ② 按 World 走的那条路连一次 WS,把握手与状态摊开
corepack pnpm bridgeprobe
#   期望:握手成功;报账号、pcm_s16le 48000Hz 2ch、receiveAudio/sendAudio 都 supported
```
★ **查能力/查历史别用 `bridgeprobe`** —— 桥同时只允许一个对端,他的 World 正连着时 probe 会被 403。
用桥的只读 HTTP 口:`curl -H "Authorization: Bearer <桥令牌>" http://127.0.0.1:6120/v1/status`
(里面有 `capabilities` / `calls` / `diagnostics`)。

★ **嗓子那一环还有一个独立自查**:通话里要有个"关思考"的端点给她用,而"切端点"住在 Persona 侧。
跑 `corepack pnpm endpointcheck --deployment <部署目录> --call`。**少了它她一句都说不出,而三道
验证一道都看不见**(见 field-notes 5.1)。
(出处:cloud/README 第六节;design/cortico-world-phone 第三节;交接2 §3。(`真机验过`))

---

## 7. 第三级(只有开发者能看)

前两级(构建过、装载过)自己跑完才给他看第三级。第三级是他打一通,看四件:

1. 她**接起**(不是 `submitted`,是 phase 变 `connected`);
2. **双向声音**:他说她听得见,她说他听得见;
3. 他喊"停"她当场停(或 `bargeIn` 关着时,她调 `phone_stop` 停);
4. 挂断后时间线里有 `phone.connected` / `phone.speech` / `phone.ended`(收尾那条正文里带着这一通
   的逐句记录)。

**前两级没绿不给他看第三级。**
(出处:design/cortico-world-phone 第五节;README「三级验证」。(`真机验过`))

---

## 8. 常开要有的三件

1. **自启**(必须有):`--restart unless-stopped`。不设的话机器一重启这条线就再也不回来,**而且不报错**。
2. **AV Host 的自愈**(上游自带):它的 `run-av-host.sh` 是个 `while true … sleep 2` 监督循环,
   "宿主自杀重启"就是它拉回来的。
3. **`watchdog.sh` 的定时器**(建议):治"卡在过渡态"(见 field-notes 3.1),靠宿主上一个
   cron/systemd timer 每分钟跑一次 `docker exec <容器名> sh <watchdog 路径>`。替代是 World 那侧的
   `ssh.recoverCommand`(她能自己救);**两条路不冲突,都挂着更稳**。
(出处:整合A-实施 §0.3;cloud/README 第四节;`cloud/watchdog.sh`。(`真机验过`))

---

## 9. 退回去(回滚)

```bash
bash down-rtc.sh               # 停 <容器名>,把生产容器起回来(它重启后可能要重扫一次码)
```
彻底不留痕迹:

```bash
docker rm -f <容器名>
docker rmi <镜像名>
rm -rf <桥安装目录> <桥源码树>
```

★ **生产那一侧全程没被改过版本**:生产容器的 QQ 版本与 `/opt/napcat/{qq,config}` 两处挂载都没动,
只在配置里换过 token。所以**回滚不需要恢复生产 QQ** —— 唯一要人配合的是它重启后可能又要扫一次码。
(出处:cloud/README 第五/八节;整合A-实施 §5。(`真机验过`))

---

## 10. 每一步会骗你的地方

这一份只给"怎么走";**每一步的坑与判据**都在 `field-notes.md`,走之前至少过一遍这几条:

- 那句 `Requires an exact audited QQ library…` 的两种含义(field-notes 2.1)
- `submitted` ≠ 接通(2.2)
- 卡住的两张脸 + 过期邀请不许接(3.1 / 3.2)
- 缺 `pulse-no-move.so` ⇒ 整条声音哑,而 `/healthz` 会骗你(4.1)
- 队列上限 2000ms ⇒ 外发要配速(4.2)
- 关思考的端点缺失 ⇒ 她一句都说不出,且三道验证看不见(5.1)
- `--network host` / WS 握手三条硬条件(7.1 / 7.2)
- 换容器名/换桥之后那些**静默失败**(7.7 / 7.8)

> **路线选择的另一条**:如果你的 QQ 哈希对不上、又**不想**按 build 审计原生地址,或者你的平台是
> Windows 且想要"看屏幕点按钮"而不是逆原生库 —— 看 `route-b-ui-driven.md`。那一份状态照实说:
> 协议层验过、端到端没验、Windows 版没写过。
