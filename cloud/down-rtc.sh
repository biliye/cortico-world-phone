#!/bin/bash
# 把电话那套收掉,生产 napcat 起回来。**在云上跑**。这就是 A1 的回滚。
#
# 为什么这一步很轻:napcat-rtc 只多用了四处挂载与一个容器名,**生产那份镜像、那份 QQ
# 与 /opt/napcat/{qq,config} 两处挂载一点没动** ⇒ 起回老容器就等于回到今天早上。
# 唯一要人配合的是:生产容器一重启就有可能要重扫码。
set -uo pipefail

say() { echo "[$(date +%T)] $*"; }

say "=== 1) 停 napcat-rtc(桥、AV Host、隔离音频都在这个容器里,一起走) ==="
if docker stop napcat-rtc >/dev/null 2>&1; then
  say "napcat-rtc 已停"
else
  say "napcat-rtc 本来就没在跑"
fi

say "=== 2) 把生产起回来 ==="
docker start ln-mysql ln-backend ln-web >/dev/null 2>&1 && say "learn-notes 已起" || true
if docker start napcat >/dev/null 2>&1; then
  say "napcat 已起(登录态可能失效,要重扫码)"
else
  say "napcat 起不来 —— 去看 docker logs napcat"
fi

say "=== 3) 现状 ==="
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

echo
echo "彻底不要电话那套了(注意:这会删掉桥的令牌与 AV Host 登录态):"
echo "  docker rm -f napcat-rtc"
echo "  docker rmi napcat-rtc:1"
echo "  rm -rf /opt/napcat/rtc /opt/rtc-src"
echo "（审计版 QQ 的原始树在 /opt/phone/qq-src,老测试栈那套仍在 /opt/phone) "
