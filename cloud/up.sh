#!/bin/bash
# 起一次测试栈:停生产 + 腾内存 + 重建容器(host 网络) + 起栈登录 + 起守护进程
#
# 在**云上**跑(宿主上)。跑之前确认:开发者已经约好断线窗口 ——
# 生产 napcat 要停,那期间他的 QQ 线是断的(他实例上的文字消息也不通)。
#
# 用法:bash up.sh [--account <UIN>]
set -euo pipefail

# 账号:命令行 `--account <UIN>` 优先,其次环境变量 ACCOUNT / local.env(见 _account.sh)。
ACCOUNT="${2:-${ACCOUNT:-}}"
# shellcheck source=./_account.sh
. "$(dirname "$0")/_account.sh"
HOST_TEST=/opt/phone
T=/work/test                     # 容器里的路径(= 宿主的 /opt/phone/test)
IMAGE=phone-test:1

say() { echo "[$(date +%T)] $*"; }

say "=== 1) 停生产,腾内存 ==="
# 同一个 QQ 号不能同时登两处;不先停,后面登录一定被挤掉。
docker stop napcat >/dev/null 2>&1 && say "napcat 已停" || say "napcat 本来就没在跑"
# 这台机器上"可以让位"的其它服务(小内存机器上双 QQ + AV Host 要腾位置)。
# 这是**部署者自己的**服务名:换成你的写进 local.env 的 FREE_MEMORY_CONTAINERS。
# 名单里的容器不存在也不会坏任何事(`docker stop` 对着不存在的名字只会安静失败)。
FREE_MEMORY_CONTAINERS="${FREE_MEMORY_CONTAINERS:-ln-web ln-backend ln-mysql}"
for c in $FREE_MEMORY_CONTAINERS; do
  docker stop "$c" >/dev/null 2>&1 && say "$c 已停" || true
done
free -m | sed -n '2p'

say "=== 2) 重建容器(--network host) ==="
# 为什么 host:上游守护进程拒绝绑非回环地址,容器 bridge 网络的回环宿主够不着。
docker rm -f phone-test >/dev/null 2>&1 || true
docker run -d --name phone-test --network host \
  -v "$HOST_TEST:/work" \
  -e TZ=Asia/Shanghai \
  --entrypoint sleep "$IMAGE" infinity >/dev/null
docker inspect phone-test --format '网络={{.HostConfig.NetworkMode}} 绑定={{json .HostConfig.Binds}}'

say "=== 2.5) 编译 PulseAudio no-move 守卫(**漏过这一步,声音整条是哑的**) ==="
# 守护进程会 access() 一个叫 pulse-no-move.so 的小守卫(给我们自己的 parec/pacat 用),
# 它**不在**源码包里,得现编 —— 不编的话桥的状态里 receiveAudio/sendAudio 会是 supported=false,
# 诊断里一行 "refusing unpinned PulseAudio capture."。★ 这与 install.py 编的 qq-pulse-guard.so
# (给 QQ 用的)是**两个不同的文件**,别以为编过一个就够了。2026-10-09 实测:漏了这一步,
# 打电话时她一个字也听不见、也说不出。
docker exec phone-test bash -lc 'ls /work/koishi/bridge/audio/pulse-no-move.so >/dev/null 2>&1 || (cd /work/koishi && node bridge/audio/build-pulse-shim.mjs)'
docker exec phone-test bash -lc 'ls -la /work/koishi/bridge/audio/pulse-no-move.so'

say "=== 3) 起栈并登录(要扫码就人工配合) ==="
docker exec -d phone-test bash -lc 'nohup bash /work/p3-login.sh > /work/login.log 2>&1 &'
say "等插件口 6110 起来(最多 180 秒)……"
tok=$(docker exec phone-test bash -lc "cat $T/bridge/runtime/control.token")
for i in $(seq 1 60); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" http://127.0.0.1:6110/v1/capabilities 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then say "6110 已就绪"; break; fi
  sleep 3
done
echo "--- capabilities ---"
curl -sS -H "Authorization: Bearer $tok" http://127.0.0.1:6110/v1/capabilities | head -c 800; echo
echo "--- 若要扫码:二维码在容器里,拷到宿主再下载给他 ---"
docker exec phone-test bash -lc "ls -la /app/napcat/cache/qrcode.png 2>/dev/null || echo '(还没有二维码:要么已经登录过,要么还没到那一步)'"

say "=== 4) 起守护进程 ==="
docker exec phone-test bash -lc "pkill -f '[d]aemon\.mjs' >/dev/null 2>&1 || true"
docker exec -d phone-test bash -lc "cd $T/bridge && nohup node daemon.mjs $T/bridge/bridge.json > $T/bridge/logs/daemon.log 2>&1 &"
sleep 4
curl -sS -o /dev/null -w '守护进程 /healthz http=%{http_code}\n' http://127.0.0.1:6120/healthz || true

say "=== 完 ==="
echo "下一步:本机这边开 worlds.phone.ssh.enabled(隧道由 World 自己拉起),或先用 cloud/tunnel.sh 人工验一次。"
echo "账号: $ACCOUNT"
