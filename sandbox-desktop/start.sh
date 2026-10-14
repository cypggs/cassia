#!/bin/bash
# cassia（桌面版）的 start_cmd。E2B 在沙箱启动时执行它。
#
# 和 lite 的区别只有一处：这里不是直接 exec node，而是交给 supervisord
# 管一组进程（X / 窗口管理器 / VNC / websockify / Chromium / runtime）。
#
# DISPLAY 在这里导出，agent-runtime 继承它，pi 再传给 bash ——
# 所以 Agent 在终端里敲 `xdotool` 或 `chromium` 就直接作用在画面上，
# 不需要每条命令自己带 DISPLAY=:1。这一层继承是「终端」和「画面」
# 是同一台电脑的关键。
set -euo pipefail

export HOME="${HOME:-/home/user}"
export DISPLAY=:1
export SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1280x800x24}"
export WORKSPACE="${WORKSPACE:-/home/user/workspace}"
export PORT="${PORT:-8330}"

mkdir -p "$WORKSPACE" "$HOME/.supervisor" "$HOME/.chromium"

exec supervisord -c /opt/cassia-desktop/supervisord.conf
