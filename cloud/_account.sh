# 账号(那个跑 QQ 的号)从哪来 —— 云侧几个脚本共用这一小段。
#
# 顺序:环境变量 `ACCOUNT` > 同目录下**不进 git** 的 `local.env` 里的 `PHONE_ACCOUNT`。
#
# 为什么要有这一层:这个号是**每个部署自己的**东西。以前脚本里写死过一个默认值,
# 那种"静默兜底"在别人的机器上会安静地登错号 —— 所以现在没配就停下,并且说清怎么配。
#
# 自己用:把 `local.env.example` 拷成 `local.env` 填上真实值。
# 搬到别的机器时**别搬 local.env**(那是你这套部署的东西)。

_ACCOUNT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$_ACCOUNT_HERE/local.env" ] && . "$_ACCOUNT_HERE/local.env"

UIN="${ACCOUNT:-${PHONE_ACCOUNT:-}}"
if [ -z "$UIN" ]; then
  echo "!! 没有账号。请二选一:" >&2
  echo "   ① 临时:ACCOUNT=<QQ号> bash <脚本>" >&2
  echo "   ② 长期:把 cloud/local.env.example 拷成 cloud/local.env 并填 PHONE_ACCOUNT=<QQ号>" >&2
  echo "   (这个号就是 QQ 上跑着的那个;同一个号只能有一处在线。)" >&2
  exit 2
fi

# 归一:下游脚本有的读 UIN 有的读 ACCOUNT,这里统一成两个都有。
ACCOUNT="$UIN"
