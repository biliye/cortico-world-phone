#!/bin/bash
# 登录期的小帮手:让 /opt/napcat/qr/rtc-qr.png 一直是容器里**刚生成的那张**登录二维码。
#
# 为什么需要它:NapCat 的登录码约每 2 分钟换一张,人手去"取一次"经常取到一张已经过期的;
# 这个循环每 8 秒把容器里的 cache/qrcode.png 同步到宿主,所以任何时候去下载都是新的。
#
# 在宿主上跑:`nohup bash /opt/rtc-src/qr-refresh.sh >/dev/null 2>&1 &`
# 登进去之后就可以杀掉它:`pkill -f '[q]r-refresh.sh'`
set -uo pipefail

NAME=${RTC_NAME:-napcat-rtc}
OUT=${QR_OUT:-/opt/napcat/qr/rtc-qr.png}
SRC=/app/napcat/cache/qrcode.png

mkdir -p "$(dirname "$OUT")"
echo "[qr-refresh] 开始:每 8 秒把 $NAME:$SRC 同步到 $OUT"
while true; do
  if docker cp "$NAME:$SRC" "$OUT.tmp" >/dev/null 2>&1; then
    mv -f "$OUT.tmp" "$OUT"
  fi
  sleep 8
done
