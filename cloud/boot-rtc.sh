#!/bin/bash
# 电话(路 A1):容器里跑的准备脚本。entrypoint 在 **QQ 起来之前** 调一次 `prep`。
#
# 顺序要紧 —— QQ 一启动就会把 napcat.mjs 读进去,所以插件补丁必须在它之前落盘。
#
#   1) 文件安装(幂等):QQ 的加载器钩子 + NapCat 的插件 + 现场编 qq-pulse-guard.so
#   2) 让 NapCat 认这个本地插件(改 napcat.mjs;幂等)
#   3) 编第二个 .so(给桥自己用)+ 写 bridge.json + 起隔离音频
#   4) 起 AV Host(它自带 while true 监督循环)+ 起桥守护进程
#
# 为什么每次开容器都重装一遍:容器重建时 /opt/QQ 与 /app/napcat 会回到镜像里的样子,
# 而 /opt/rtc 是挂进来的、留着上一轮的令牌与登录态 —— 一半持久一半不持久最难对付,
# 所以干脆让"文件部分"每次从零装、"状态部分"一直留着,两边各自干净。
set -uo pipefail

SRC=${RTC_SRC:-/opt/rtc-src}     # 我们的脚本 + 上游桥源码树(宿主挂进来)
T=${RTC_DIR:-/opt/rtc}           # 安装目录(宿主挂进来:runtime/ 与 logs/ 要留着)
K=$SRC/koishi                    # 上游桥的源码树(daemon.mjs 与安装脚本都在这儿)
QQ_DIR=/opt/QQ
NAPCAT_DIR=/app/napcat
BRIDGE_PORT=6110
AV_PORT=6111
DAO_PORT=6120

say() { echo "[$(date +%T)] [rtc] $*"; }
fail() { say "!! $*"; exit 1; }

# bridge.json:守护进程读的那份。设备名与 48000/2 是隔离音频那两条 null sink 的名字。
# ★ 这份**不放进包目录、也不进 git**:它写着这个部署自己的端口与账号。
write_bridge_json() {
  # 账号只在这一步要:放在函数里,`boot-rtc.sh files` 那种干跑就不会被账号挡住。
  # shellcheck source=./_account.sh
  . "$(dirname "$0")/_account.sh"
  cat >"$T/bridge.json" <<JSON
{
  "host": "127.0.0.1",
  "port": $DAO_PORT,
  "tokenFile": "$T/runtime/control.token",
  "account": { "selfId": "$UIN", "platform": "qq" },
  "qq": {
    "url": "http://127.0.0.1:$BRIDGE_PORT",
    "tokenFile": "$T/runtime/control.token",
    "selfId": "$UIN"
  },
  "audio": {
    "backend": "pulse",
    "sampleRate": 48000,
    "channels": 2,
    "frameMs": 20,
    "inputDevice": "koishi_rtc_qq_speaker.monitor",
    "outputDevice": "koishi_rtc_qq_mic",
    "pulseServer": "unix:$T/runtime/pulse/native"
  }
}
JSON
  chmod 600 "$T/bridge.json"
}

prep() {
  files_only

  say "4/5 隔离音频"
  bash "$T/scripts/audio-control.sh" start || fail "隔离音频起不来"

  say "5/5 起 AV Host 与桥守护进程"
  pkill -f '[r]un-av-host\.sh' 2>/dev/null || true
  nohup bash "$T/scripts/run-av-host.sh" >>"$T/logs/av-host.log" 2>&1 &
  pkill -f '[d]aemon\.mjs' 2>/dev/null || true
  ( cd "$K" && nohup node bridge/daemon.mjs "$T/bridge.json" >>"$T/logs/daemon.log" 2>&1 & )

  say "准备完 —— 6110/6111/6120 要等 QQ 起来并登进去才真的就绪"
}

# 只装文件、不起任何进程。给"干跑验证"用:在抛弃式容器里把这三步走一遍,
# 不动 QQ、不连网、不占那个账号 —— 真正的窗口留给切换那一次。
files_only() {
  [ -f "$K/bridge/qq/scripts/install.py" ] || fail "桥源码树不在 $K —— 宿主是不是没挂 /opt/rtc-src?"
  install -d -m 0700 "$T/runtime" "$T/logs"

  say "1/3 文件安装(QQ 加载器钩子 + NapCat 插件 + 现场编 qq-pulse-guard.so)"
  python3 "$K/bridge/qq/scripts/install.py" install \
    --qq-dir "$QQ_DIR" --napcat-dir "$NAPCAT_DIR" --install-dir "$T" \
    --port "$BRIDGE_PORT" --av-port "$AV_PORT" \
    || fail "install.py 失败(看上面的输出;它自己会回滚,不留半套)"

  say "2/3 让 NapCat 认这个本地插件"
  # ★ loader 要指**备份那份**(install.py 刚建的 .koishi-rtc-qq.backup.cjs),不是钩子本身:
  #   上游就是这么调的 —— NapCat 真正加载的是备份那份,而钩子必须保持 install.py 记下的哈希
  #   (以后 uninstall 会拿这个哈希核对,改了就拒绝卸)。
  python3 "$K/bridge/qq/scripts/enable-local-plugin.py" \
    --napcat-dir "$NAPCAT_DIR" --loader "$QQ_DIR/resources/app/loadNapCat.koishi-rtc-qq.backup.cjs" \
    || fail "enable-local-plugin.py 失败"

  say "3/3 编 pulse-no-move.so(★ 漏了它,声音整条是哑的)"
  if [ ! -f "$K/bridge/audio/pulse-no-move.so" ]; then
    ( cd "$K" && node bridge/audio/build-pulse-shim.mjs ) || fail "pulse-no-move.so 编译失败"
  fi

  write_bridge_json
}

status() {
  echo "--- 端口 ---"
  ss -tlnp 2>/dev/null | grep -E '3001|6099|6110|6111|6120' || echo "(一个都没在听)"
  echo "--- 插件口能力 ---"
  curl -sS -o /dev/null -w '6110 http=%{http_code}\n' \
    -H "Authorization: Bearer $(cat "$T/runtime/control.token" 2>/dev/null)" \
    http://127.0.0.1:6110/v1/capabilities || true
  echo "--- 桥 ---"
  curl -sS -o /dev/null -w '6120 /healthz http=%{http_code}\n' http://127.0.0.1:6120/healthz || true
  echo "--- 日志尾巴 ---"
  tail -5 "$T/logs/daemon.log" 2>/dev/null || echo "(没有 daemon.log)"
  tail -5 "$T/logs/av-host.log" 2>/dev/null || echo "(没有 av-host.log)"
}

case "${1:-prep}" in
  prep) prep ;;
  files) files_only ;;
  status) status ;;
  *) echo "用法: boot-rtc.sh [prep|files|status]" >&2; exit 2 ;;
esac
