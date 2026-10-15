#!/bin/bash
# 构建 cassia（桌面版）模板。必须在仓库根目录跑 —— Dockerfile 要 COPY
# shared/ 和 agent-runtime/，构建 context 得覆盖到它们。
#
# ready-cmd 同时查 runtime 和画面通道：只查 8330 的话，
# 一个 X 起不来、画面全黑的镜像也会被判成「构建成功」。
#
# 注意：仓库根的 .dockerignore 是给 socket-server 镜像用的，排除了
# agent-runtime/ 等目录。E2B 构建会尊重 .dockerignore，导致 COPY 失败。
# 构建时临时移走它。
set -euo pipefail
cd "$(dirname "$0")/.."

# 两个模板构建都动 .dockerignore,并行会 TOCTOU 互踩(实测翻车)。
# flock 串行化,与启动方式无关。
exec 9> /tmp/cassia-tpl-build.lock
flock 9

# 临时移走 .dockerignore（E2B 构建需要 agent-runtime/）
DOCKERIGNORE_BAK=""
if [ -f .dockerignore ]; then
  DOCKERIGNORE_BAK=$(mktemp)
  mv .dockerignore "$DOCKERIGNORE_BAK"
  trap 'mv "$DOCKERIGNORE_BAK" .dockerignore' EXIT
fi

# 注意:**不要 exec** —— 见 sandbox-lite/build.sh 同名注释(EXIT trap)。
e2b template create cassia \
  -d sandbox-desktop/e2b.Dockerfile \
  -c "/opt/cassia-desktop/start.sh" \
  --ready-cmd "curl -sf http://localhost:8330/healthz && curl -sf http://localhost:9222/json/version && (echo > /dev/tcp/127.0.0.1/5901)" \
  --cpu-count 2 \
  --memory-mb 4096 \
  "$@"
