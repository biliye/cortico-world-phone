#!/bin/bash
# 路 A1:把生产 napcat 换成「文字 + 电话」合一的 napcat-rtc。**在云上跑**。
#
# 跑之前确认:开发者已经约好断线窗口 —— 那期间他的 QQ 文字线是断的,而且 QQ 换了版本,
# 多半要重扫一次码(登出不是故障,是已知代价)。回滚就一条:`bash down-rtc.sh`。
#
# 用法:
#   bash up-rtc.sh              # 缺镜像就建;默认把 learn-notes 那套停掉腾内存
#   bash up-rtc.sh --keep-ln    # 保留 ln-mysql/ln-backend/ln-web(内存够时用)
#   bash up-rtc.sh --no-build   # 镜像已经建好了,直接用
set -euo pipefail

SRC=/opt/rtc-src              # 我们的脚本 + 上游桥源码树 + 构建上下文
RTCDIR=/opt/napcat/rtc        # 桥的安装目录(= 容器 /opt/rtc)
IMAGE=napcat-rtc:1
NAME=napcat-rtc
OLD=napcat                    # 生产那份(不动它的镜像与配置,回滚就是起它回来)
TESTDIR=/opt/phone/test       # 老测试栈:令牌与 AV Host 登录态从这儿搬
# 那个跑 QQ 的号不写死在脚本里:环境变量 ACCOUNT,或同目录下不进 git 的 local.env(见 _account.sh)。
# shellcheck source=./_account.sh
. "$(dirname "$0")/_account.sh"
KEEP_LN=0
BUILD=1
for a in "$@"; do
  case "$a" in
    --keep-ln) KEEP_LN=1 ;;
    --no-build) BUILD=0 ;;
    *) echo "不认识的参数:$a" >&2; exit 2 ;;
  esac
done

say() { echo "[$(date +%T)] $*"; }

say "=== 0) 要挂的几处都得在 ==="
[ -f "$SRC/boot-rtc.sh" ] || { say "缺 $SRC/boot-rtc.sh —— 先把 cloud/ 那几个脚本传上去"; exit 1; }
[ -d "$SRC/koishi/bridge" ] || { say "缺 $SRC/koishi —— 桥的源码树没放上去"; exit 1; }
mkdir -p "$RTCDIR/runtime" "$RTCDIR/logs"
echo "SRC=$SRC  RTCDIR=$RTCDIR  ACCOUNT=$ACCOUNT"

say "=== 1) 镜像 $IMAGE ==="
if [ "$BUILD" = "1" ]; then
  if [ ! -d "$SRC/ctx/qq" ]; then
    say "准备构建上下文:审计版 QQ 树(硬链接,不占磁盘)"
    mkdir -p "$SRC/ctx"
    cp -al /opt/phone/qq-src/opt/QQ "$SRC/ctx/qq" 2>/dev/null \
      || cp -a /opt/phone/qq-src/opt/QQ "$SRC/ctx/qq"
  fi
  cp -f "$SRC/Dockerfile.rtc" "$SRC/ctx/Dockerfile.rtc"
  ( cd "$SRC/ctx" && docker build -f Dockerfile.rtc -t "$IMAGE" . ) \
    || { say "镜像没建出来 —— 看上面的构建输出"; exit 1; }
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || { say "$IMAGE 不存在,去掉 --no-build 再跑"; exit 1; }
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep "^$IMAGE"

say "=== 2) 从老测试栈搬要留住的两样(令牌 + AV Host 登录态) ==="
# 令牌搬过来,他 .env 里的 PHONE_BRIDGE_TOKEN 就不用改;AV Host 那份登录态搬过来,**可能**省一次扫码。
if [ -f "$TESTDIR/bridge/runtime/control.token" ] && [ ! -f "$RTCDIR/runtime/control.token" ]; then
  cp -a "$TESTDIR/bridge/runtime/control.token" "$RTCDIR/runtime/control.token"
  say "令牌已搬(他那边不用改配置)"
fi
if [ -d "$TESTDIR/bridge/runtime/av-host-profile" ] && [ ! -d "$RTCDIR/runtime/av-host-profile" ]; then
  cp -a "$TESTDIR/bridge/runtime/av-host-profile" "$RTCDIR/runtime/av-host-profile"
  say "AV Host 登录态已搬"
fi

say "=== 3) 停生产容器(同一个 QQ 号不能同时登两处) ==="
docker stop "$OLD" >/dev/null 2>&1 && say "napcat 已停" || say "napcat 本来就没在跑"
if [ "$KEEP_LN" = "0" ]; then
  # 这是**部署者自己的**服务名(小内存机器上要腾位置);换成你的写进 local.env 的
  # FREE_MEMORY_CONTAINERS。名单里的容器不存在也不坏任何事。
  for c in ${FREE_MEMORY_CONTAINERS:-ln-web ln-backend ln-mysql}; do
    docker stop "$c" >/dev/null 2>&1 && say "$c 已停(腾内存;--keep-ln 可保留)" || true
  done
fi
free -m | sed -n '2p'

say "=== 4) 起 napcat-rtc(--network host) ==="
# 为什么必须 host:上游桥拒绝绑非回环地址,容器 bridge 网络的回环宿主够不着。
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network host \
  -v /opt/napcat/qq:/app/.config/QQ \
  -v /opt/napcat/config:/app/napcat/config \
  -v "$RTCDIR:/opt/rtc" \
  -v "$SRC:/opt/rtc-src" \
  -e TZ=Asia/Shanghai \
  -e ACCOUNT="$ACCOUNT" \
  --restart unless-stopped \
  "$IMAGE" >/dev/null
# 自启一定要设:这是常开的那条线,机器重启后它得自己回来(生产那份原来就是 unless-stopped)。
docker inspect "$NAME" --format '网络={{.HostConfig.NetworkMode}}  自启={{.HostConfig.RestartPolicy.Name}}  绑定={{json .HostConfig.Binds}}'

say "=== 5) 等两条线起来(最多 200 秒) ==="
tok=$(cat "$RTCDIR/runtime/control.token" 2>/dev/null || echo '')
for i in $(seq 1 40); do
  onebot=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3001/ 2>/dev/null || echo 000)
  plug=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    -H "Authorization: Bearer $tok" http://127.0.0.1:6110/v1/capabilities 2>/dev/null || echo 000)
  say "[$i] OneBot 3001 -> $onebot ; 插件口 6110 -> $plug"
  [ "$plug" = "200" ] && break
  sleep 5
done

say "=== 6) 要不要扫码 ==="
docker exec "$NAME" bash -lc 'ls -la /app/napcat/cache/qrcode.png 2>/dev/null || echo "(还没有二维码:要么已经在自动登录,要么还没走到那一步)"' || true
mkdir -p /opt/napcat/qr
if docker cp "$NAME":/app/napcat/cache/qrcode.png /opt/napcat/qr/rtc-qr.png 2>/dev/null; then
  say "二维码已拷到 /opt/napcat/qr/rtc-qr.png(约 2 分钟换一张,失效就再执行这一步重取)"
fi

say "=== 7) 现状 ==="
docker exec "$NAME" bash -lc 'bash /opt/rtc-src/boot-rtc.sh status' || true
echo
echo "--- 文字线(客户端连的是 ws://<那台的地址>:3001)---"
ss -tlnp 2>/dev/null | grep -E '3001|6099|6110|6111|6120' || echo "(还没在听)"
echo
echo "回滚:bash down-rtc.sh   (停 napcat-rtc,把生产 napcat 起回来)"
