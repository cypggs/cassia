#!/bin/bash
# cassia-lite 的 start_cmd。E2B 会在沙箱启动时执行它。
#
# 这里刻意不做「等 API key 就位」之类的事 —— runtime 起来时不需要密钥，
# 它是在控制面 attach 之后才 spawn pi，密钥那时才随 attach 一起到。
#
# 以 `user` 身份跑（E2B 在模板末尾自动追加 USER user），
# 所以日志只能落在 $HOME 下 —— /var/log 是没有写权限的。
set -euo pipefail

export WORKSPACE="${WORKSPACE:-/home/user/workspace}"
export PORT="${PORT:-8330}"
export HOME="${HOME:-/home/user}"
mkdir -p "$WORKSPACE"

# tee 而不是纯重定向：既留一份给沙箱里排查，也让 E2B 收得到 stdout
exec node /opt/cassia/runtime/index.js 2>&1 | tee -a "$HOME/agent-runtime.log"
