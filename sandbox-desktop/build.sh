#!/bin/bash
# 构建 cassia（桌面版）模板。必须在仓库根目录跑 —— Dockerfile 要 COPY
# shared/ 和 agent-runtime/，构建 context 得覆盖到它们。
#
# ready-cmd 同时查 runtime 和画面通道：只查 8330 的话，
# 一个 X 起不来、画面全黑的镜像也会被判成「构建成功」。
set -euo pipefail
cd "$(dirname "$0")/.."

exec e2b template create cassia \
  -d sandbox-desktop/e2b.Dockerfile \
  -c "/opt/cassia-desktop/start.sh" \
  --ready-cmd "curl -sf http://localhost:8330/healthz && curl -sf http://localhost:9222/json/version && (echo > /dev/tcp/127.0.0.1/5901)" \
  --cpu-count 2 \
  --memory-mb 4096 \
  "$@"
