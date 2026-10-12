#!/bin/sh
# 卡死自愈。**在容器里**跑(宿主上也可以 `docker exec phone-test bash /work/watchdog.sh`)。
#
# 为什么需要它:对方挂断后,桥里那通会停在 `rejecting` **永不结束** ——
# 它在等一个永远不会来的原生 ACK,而且**挡住新通话**。
# 唯一释放方式是重启 AV Host 换 bootId(supervisor 会把它拉起来),
# 换完之后那通才会走到 `ended`(带 `nativeEndEvent: host.restarted`)。
#
# 建议:宿主上每分钟跑一次(`* * * * * docker exec phone-test sh /work/watchdog.sh`)。
# World 那边也能做同一件事(worlds.phone.ssh.recoverCommand),两边都行、不冲突。
#
# 用法:sh watchdog.sh [卡住多久算卡住,秒,默认 60]
set -u
THRESHOLD="${1:-60}"
T=/work/test
TOKEN_FILE="$T/bridge/runtime/control.token"
STATE=/tmp/watchdog-rejecting-since

[ -f "$TOKEN_FILE" ] || exit 0
TOK=$(cat "$TOKEN_FILE")

# 插件口只在 QQ 跑起来时才有;起不来就什么都别做。
STATUS=$(curl -sS --max-time 5 -H "Authorization: Bearer $TOK" http://127.0.0.1:6110/v1/calls/current 2>/dev/null) || exit 0
[ -n "$STATUS" ] || exit 0

PHASE=$(printf '%s' "$STATUS" | sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
NOW=$(date +%s)

# 天生过渡的状态:本该几秒内走掉。停久了就是卡住,而且**挡住新通话**。
# 2026-10-09 实测:拒绝那一侧卡在 `ending`(上一版只看 `rejecting`,所以没救它),
# 表现是他再打时**桥这边连记录都没有** —— 新的邀请根本进不来。
case "$PHASE" in
  ending|rejecting|accepted|dialing) : ;;
  *) rm -f "$STATE"; exit 0 ;;
esac

if [ ! -f "$STATE" ]; then
  echo "$NOW" > "$STATE"
  echo "[$(date +%T)] 一通进入 $PHASE,开始计时"
  exit 0
fi

SINCE=$(cat "$STATE" 2>/dev/null || echo "$NOW")
HELD=$((NOW - SINCE))
if [ "$HELD" -lt "$THRESHOLD" ]; then
  exit 0
fi

echo "[$(date +%T)] 卡在 $PHASE 已 ${HELD}s(阈值 ${THRESHOLD}s)⇒ 重启 AV Host 换 bootId"
# 注意模式里的 [a]:不要让这条命令把自己的 shell 也匹配上(那样脚本会自杀,后半段静默不跑)。
pkill -f '[a]v-host-profile' 2>/dev/null || pkill -f '[a]v-host' 2>/dev/null || true
rm -f "$STATE"
echo "[$(date +%T)] 已发出重启;supervisor 会拉起来,之后那通会变 ended(host.restarted)"
