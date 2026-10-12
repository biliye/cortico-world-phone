#!/bin/bash
# 停掉测试栈,把生产起回来。在**云上**跑。
#
# 顺序要紧:先停守护进程与容器(释放那个 QQ 号),再把生产起回来 ——
# 反了的话两边会抢登录。
set -uo pipefail

say() { echo "[$(date +%T)] $*"; }

say "=== 1) 停测试栈 ==="
docker exec phone-test bash -lc "pkill -f '[d]aemon\.mjs' >/dev/null 2>&1 || true" 2>/dev/null && say "守护进程已停" || true
docker exec phone-test bash -lc "/work/test/bridge/scripts/audio-control.sh stop >/dev/null 2>&1 || true" 2>/dev/null || true
docker stop phone-test >/dev/null 2>&1 && say "phone-test 已停" || say "phone-test 本来就没在跑"

say "=== 2) 把生产起回来 ==="
# 生产容器一重启就要重扫码 —— 这是已知的代价,不是故障。
docker start ln-mysql ln-backend ln-web >/dev/null 2>&1 && say "learn-notes 已起" || true
docker start napcat >/dev/null 2>&1 && say "napcat 已起(登录态可能失效,要重扫码)" || say "napcat 起不来,去看 docker logs napcat"

say "=== 3) 现状 ==="
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

echo
echo '回滚到「什么都没有」的地步(测试那套整个删掉):'
echo '  docker rm -f phone-test'
echo '  docker rmi phone-test:1'
echo '  rm -rf /opt/phone /opt/phone-deb'
