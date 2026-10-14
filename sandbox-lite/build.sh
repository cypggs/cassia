#!/bin/bash
# 构建 cassia-lite 模板。必须在仓库根目录跑 —— Dockerfile 要 COPY
# shared/ 和 agent-runtime/，构建 context 得覆盖到它们。
set -euo pipefail
cd "$(dirname "$0")/.."

exec e2b template create cassia-lite \
  -d sandbox-lite/e2b.Dockerfile \
  -c "/opt/cassia/start.sh" \
  --ready-cmd "curl -sf http://localhost:8330/healthz" \
  --cpu-count 2 \
  --memory-mb 2048 \
  "$@"
