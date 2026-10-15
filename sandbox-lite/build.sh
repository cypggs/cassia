#!/bin/bash
# 构建 cassia-lite 模板。必须在仓库根目录跑 —— Dockerfile 要 COPY
# shared/ 和 agent-runtime/，构建 context 得覆盖到它们。
#
# 注意：仓库根的 .dockerignore 是给 socket-server 镜像用的，排除了
# agent-runtime/ 等目录。E2B 构建会尊重 .dockerignore，导致 COPY 失败
# （"No files found in .../agent-runtime/src"）。构建时临时移走它。
set -euo pipefail
cd "$(dirname "$0")/.."

# 两个模板构建都动 .dockerignore,并行会 TOCTOU 互踩(实测:一个 mv 走,
# 另一个 mv 失败、trap 又把空文件盖回来)。flock 串行化,与启动方式无关。
exec 9> /tmp/cassia-tpl-build.lock
flock 9

# 临时移走 .dockerignore（E2B 构建需要 agent-runtime/）
DOCKERIGNORE_BAK=""
if [ -f .dockerignore ]; then
  DOCKERIGNORE_BAK=$(mktemp)
  mv .dockerignore "$DOCKERIGNORE_BAK"
  trap 'mv "$DOCKERIGNORE_BAK" .dockerignore' EXIT
fi

# 注意:**不要 exec** —— exec 会替换 shell,上面的 EXIT trap 永远不跑,
# .dockerignore 就丢了(只能靠下次 git reset 捡回来,实测踩过)。
e2b template create cassia-lite \
  -d sandbox-lite/e2b.Dockerfile \
  -c "/opt/cassia/start.sh" \
  --ready-cmd "curl -sf http://localhost:8330/healthz" \
  --cpu-count 2 \
  --memory-mb 2048 \
  "$@"
