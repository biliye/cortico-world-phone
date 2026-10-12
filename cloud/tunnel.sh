#!/bin/bash
# 一次性隧道:人工验一次"本机能不能够着云上的桥"。
#
# 平时**不需要它** —— World 自己会拉起并看护这条隧道(worlds.phone.ssh.enabled)。
# 这个脚本的用处是:开 `ssh.enabled` 之前先确认登录方式与端口都对,
# 或者 World 那条隧道出问题时在旁边手工验一下。
#
# 在本机跑。本机这一头会监听 127.0.0.1:6120。
set -euo pipefail

# 协议端那台的地址不写死在脚本里:环境变量 PHONE_HOST,或同目录下不进 git 的 local.env(见 local.env.example)。
# shellcheck source=/dev/null
[ -f "$(dirname "$0")/local.env" ] && . "$(dirname "$0")/local.env"
HOST="${PHONE_HOST:?没给主机:PHONE_HOST=<协议端那台的地址>,或写进 cloud/local.env}"
USER="${PHONE_USER:-root}"
KEY="${PHONE_KEY:?没给私钥:PHONE_KEY=<私钥路径>(World 自己拉隧道时对应 worlds.phone.ssh.keyFile)}"
LOCAL_PORT="${PHONE_LOCAL_PORT:-6120}"
REMOTE_PORT="${PHONE_REMOTE_PORT:-6120}"

[ -f "$KEY" ] || { echo "私钥不存在:$KEY(用 PHONE_KEY=<路径> 指定)"; exit 1; }

echo "开隧道 127.0.0.1:$LOCAL_PORT → $HOST 的 127.0.0.1:$REMOTE_PORT (用户 $USER)"
echo "这个窗口要一直开着;想停就 Ctrl-C。"
echo
echo "另开一个终端验一下:"
echo "  curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:$LOCAL_PORT/healthz   # 期望 200"
echo "  curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:$LOCAL_PORT/          # 期望 401(没带令牌)"

# BatchMode=yes:密钥不对就立刻报错退出,绝不弹密码提示(弹了也没人答,子进程会挂着不动)。
exec ssh -N -T \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -i "$KEY" \
  -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
  "$USER@$HOST"
