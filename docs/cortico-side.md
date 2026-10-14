# Cortico 那一侧:World、配置、persona 的一致性约定

这一份讲的是**通话能力之外**的三件事:把 World 装进一个部署、它要哪些配置、以及
"她能不能出声"那一环为什么住在 Persona 里。协议端(QQ + 桥)怎么起,见
`route-a-cloud-linux-napcat.md` / `route-b-ui-driven.md`。

## 一、装进一个部署(四步)

前置:这台机器有 `node` ≥ 22 与 `ssh`;识别那半默认指本机语音识别服务(`127.0.0.1:50001`)。

1. **包装进部署的 `extensions/`** —— 控制台「扩展」页选本机目录,或
   `cd extensions && corepack pnpm add --ignore-workspace <这个目录>`。
   它有一个运行时依赖 `ws`:桥的握手要求 `Authorization` 头,而 Node 自带的 WebSocket 设不了头。
2. **重启进程**。她会多出 `phone_say` / `phone_answer` / `phone_dial` / `phone_hangup` / `phone_status` /
   `phone_stop` 六个工具;系统前缀里多出"电话"那一段(下一轮前缀重建时生效)。
   **通话中开口走 `phone_say`**(她写下的正文也会被念出去,但别只指望那一条 —— 理由见
   `field-notes.md` §5.5)。
3. **部署的 `.env` 里给两样东西**:
   - `PHONE_BRIDGE_TOKEN=<桥的令牌>`(变量名可改,见 `tokenSecret`);
   - `<TTS 服务商的密钥>`(嗓子;若与别的 World 共用已经有了就不必再写)。
4. **部署的 `config.json` 里填 `worlds.phone`**。**至少**要填 `callers`(接听名单),
   否则谁都打不进来。

配置键的完整表(默认值、说人话的解释)在包根的 **`README.md`「配置」一节**,不在这里重复。
三条最容易漏的:

- `callers` 是**数组**,框架的表单塞不下列表 ⇒ **只能在 `config.json` 里改**(与 mouse 的
  `screens` 同一条规矩);
- `dial.target` 填的是 **uid**(`u_…`)不是手机号 —— 上游那条 `dial` 走的是对端 uid;
- `enabled` 默认 `false`:装上去不会自己开始打电话。

## 二、她看见什么(事件)

| 事件 | 时机 | 投递 |
|---|---|---|
| `phone.ringing` | 手动模式下有人打进来 | `preempt` |
| `phone.connected` | 接通(来电是"来电",她自己拨的是"拨出") | `flush` |
| `phone.speech` | 对方说完一句(带转写正文);"长到不像脉冲却一个字都没认出来"或"猜成了别的语言"时,正文是「(这一句没听清,N 秒)」 | `flush`(被她插嘴打断那次是 `preempt`) |
| `phone.ended` | 通话结束(历时、各说了多少,**外加这一通的逐句记录:他说的 / 她真正念出去的**) | `flush` |
| `phone.outgoingFailed` | 她拨出去的那一通从头到尾没接通 | `flush` |
| `phone.notice` | 桥断了 / 卡住 / 合成失败 / 这一通几乎没听见他 | `debounce`,标 `origin: internal` |

正文都带 `【电话】` 前缀 —— 电话里的事件与她文字线进的是**同一个上下文**(框架规定只有一个
session 收事件),不标清楚会串。

**记不记进记忆是她的事**:`phone.ended` 只把"这一通说了什么"交到她手里,这个包不替她写任何文件。

## 三、★ persona 的一致性约定:`<当前端点名>-phone`

**要你做的一件事**:部署的 `providers/` 下要有一份**真端点** `<当前端点名>-phone`
(例如当前用 `deepseek`,就是 `deepseek-phone`):配置与它相同,只把 `spec.thinking` 改成 `false`,
并**放一份自己的 `.env`**。

为什么需要它:通话里一轮 20~38 秒没法用,所以要"关思考";而"关思考"住在 provider 的 `spec` 里、
全局只有一个 `activeProvider` —— **World 够不着端点表**(它拿到的配置只有 `worlds.<id>` 那一段),
所以这件事只能由拿着整份配置的 Persona 做。**没装电话 World 时这段接线根本不会注册。**

两个不许走偏的地方(都是真机实测换来的):

- ★ **绝不允许"临时合成"一份派生端点**。密钥是**按端点名**读的(`providers/<名>/.env`),
  临时派生的那个名字下面没有 `.env` ⇒ 每次模型调用都不带密钥 ⇒ **整通电话她一句都说不出**
  (而她那边看起来只是"卡住")。所以:存在就切过去、挂断切回;**不存在就什么都不做**
  (照原端点评跑:思考没关、答得慢一点,但能出声),并留一条日志 + 一条她看得见的通知。
- **原条目一个字节不动**。切的是 `cfg.activeProvider` 这个名字。所以最坏的方向永远是"没切",
  绝不会是"悄悄把他平时的思考关掉了"。

自查(在 persona 那个包的目录里跑;`--call` 会真发一次请求,花几个 token):

```bash
corepack pnpm endpointcheck --deployment <部署目录>            # 端点表 + 切/切回
corepack pnpm endpointcheck --deployment <部署目录> --call     # 再加上"思考是不是真关了"
```

## 四、识别与嗓子:两个可换的零件

- **耳朵**:本机语音识别(默认 `127.0.0.1:50001`,由 `asr.servicePort` 指)。
  识别语言建议显式填 `zh`:自动判定会把中文碎片猜成英/日/韩,而配成 `zh` 时
  "一个汉字都没有的正文"会被当成没听清。
- **嗓子**:走 TTS 服务合成,要**带头的 WAV** 而不是裸 PCM(不猜格式)。`tts.voiceId` 必须填,
  否则合成一定失败。
- **她的话要过一道筛**:markdown、代码、链接、emoji 会被去掉才合成(括号里的内容保留,
  那可能是真话)。要她别写旁白是**写法**的事(见 `src/ENV_PROMPT.md`),不是筛子的事。
- `logAudio` 默认关:通话音频不该留在盘上。打开是调试手段,不是常态。

## 五、验证到哪一级(照本工作区的纪律)

1. **构建过**(任何人在任何机器上都能跑):`corepack pnpm typecheck` + `corepack pnpm test`
   (152 条:换算、切句、规矩、插嘴门槛、往外写的配速、"没听清要说出来"、猜错的语言不当他说的话、
   队列满的块重试不丢、主动拨号与"没接通要说一声"、收尾的逐句记录、桥的一问一答与重连、
   以及整条路的假桥冒烟)。
2. **装载过**:框架 checkout 下 `corepack pnpm check:extension <这个目录>`;另有
   `corepack pnpm smoke`(假桥 + 假识别 + 假嗓子,13 项全过才算)。**这两级也不需要协议端**。
3. **行为目击**(只有部署的人能看):电话响起 → 她接起 → 她说话 → 他听见;他打断她,她当场停;
   挂断后时间线里有 `phone.connected` / `phone.speech` / `phone.ended`。

⇒ **第 3 级没法由代码仓库代劳,也没法从第 1、2 级推断出来**。这也是为什么这个仓库里
逐条标着"真机验过 / 只读过代码 / 只是推断"。
