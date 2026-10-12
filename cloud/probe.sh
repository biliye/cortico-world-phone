#!/bin/bash
# 只读体检。在**云上**跑;不改任何东西,不登录,不碰生产。
#
# 出问题时先跑这个:它把"东西在不在、绑在哪、跑没跑、日志说什么"一次列出来。
set -uo pipefail
T=/work/test

echo "=== 0) 容器 ==="
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'phone-test|napcat|ln-' || true
echo "--- phone-test 的形态 ---"
docker inspect phone-test --format '网络={{.HostConfig.NetworkMode}} 绑定={{json .HostConfig.Binds}} 起于={{.State.StartedAt}} 退出码={{.State.ExitCode}}' 2>/dev/null || echo '(没有 phone-test 容器)'

echo
echo "=== 1) 三个口绑在哪(容器内看) ==="
# 期望:6110 / 6111 / 6120 都是 127.0.0.1 —— 一个都不该是 0.0.0.0。
docker exec phone-test bash -lc 'ss -lntp 2>/dev/null | grep -E ":(6110|6111|6120|59)" || echo "(没在听:进程没起)"' 2>/dev/null

echo
echo "=== 2) 进程 ==="
docker exec phone-test bash -lc 'ps -eo pid,etime,args | grep -E "[d]aemon\.mjs|[a]v-host|[p]ulseaudio|[q]q |[X]vfb" | head -12' 2>/dev/null

echo
echo "=== 3) 镜像与副本 ==="
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep phone-test || echo '(没有 phone-test 镜像)'
docker exec phone-test bash -lc "ls -d $T/QQ $T/napcat $T/bridge 2>/dev/null; echo ---; du -sh $T 2>/dev/null" 2>/dev/null

echo
echo "=== 4) QQ 构建(必须是 3.2.34-53644) ==="
docker exec phone-test bash -lc "cat $T/QQ/versions/* 2>/dev/null; grep -o '\"version\":\"[^\"]*\"' $T/QQ/resources/app/package.json 2>/dev/null | head -2" 2>/dev/null

echo
echo "=== 5) 桥的连通性 ==="
tok=$(docker exec phone-test bash -lc "cat $T/bridge/runtime/control.token" 2>/dev/null || echo '')
if [ -n "$tok" ]; then
  echo -n '插件口 6110 /v1/capabilities -> '
  curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $tok" http://127.0.0.1:6110/v1/capabilities || echo '连不上'
  echo -n 'AV Host 6111 /healthz -> '
  curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6111/healthz || echo '连不上'
  echo -n '守护进程 6120 /healthz -> '
  curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6120/healthz || echo '连不上'
  echo '--- 现在有没有通话(看 phase)---'
  curl -sS -H "Authorization: Bearer $tok" http://127.0.0.1:6110/v1/calls/current | head -c 600; echo
else
  echo '(读不到令牌:副本还没装好,或者没起过)'
fi

echo
echo "=== 5.5) 音频那个守卫在不在(不在 = 声音整条哑) ==="
docker exec phone-test bash -lc 'ls -la /work/koishi/bridge/audio/pulse-no-move.so 2>/dev/null || echo "缺 pulse-no-move.so:在 /work/koishi 下跑 node bridge/audio/build-pulse-shim.mjs"' 2>/dev/null

echo "=== 6) 日志尾巴 ==="
for f in run-napcat av-host daemon p3-call; do
  echo "--- $f.log ---"
  tail -8 "/opt/phone/test/bridge/logs/$f.log" 2>/dev/null || echo '(没有)'
done

echo
echo "=== 7) 内存(这台只有 1.6G) ==="
free -m
