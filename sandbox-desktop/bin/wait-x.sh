#!/bin/bash
# 等 X 服务器真的能连上，再 exec 后面的命令。
#
# supervisord 的 priority 只排「开始启动」的先后，不等「已经就绪」。
# Xvfb 从 fork 到 socket 可连有几百毫秒，x11vnc / openbox 抢在那之前起来
# 会直接退出，然后 autorestart 反复重试 —— 最后是能起来，但用户会看到
# 画面黑好几秒。宁可在这里等准。
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"

for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    exec "$@"
  fi
  sleep 0.1
done

echo "wait-x: $DISPLAY 10 秒内没就绪" >&2
exit 1
