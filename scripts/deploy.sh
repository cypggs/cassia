#!/usr/bin/env bash
# Cassia all-in-one 部署脚本：把本仓库推到一台 Ubuntu 服务器并重启服务。
#
# 服务器上的一次性准备（首次部署前手动做一次）：
#   1. 装 Node 22 + pnpm：https://nodejs.org（或 nvm），npm i -g pnpm
#   2. 装 Caddy：https://caddyserver.com/docs/install（自动签证书）
#   3. sudo cp deploy/cassia-socket.service deploy/cassia-web.service /etc/systemd/system/
#      sudo systemctl daemon-reload && sudo systemctl enable --now cassia-socket cassia-web
#   4. 把 deploy/Caddyfile 的 YOUR_DOMAIN 换成你的域名，sudo cp 到 /etc/caddy/Caddyfile
#      sudo systemctl reload caddy
#   5. 在服务器 ~/cassia/.env.production 写好密钥（见 .env.example，至少 E2B_API_KEY
#      和模型 key；NEXT_PUBLIC_* 变量在构建时 baked 进前端，改了要重跑本脚本）
#
# 用法：VM_USER=ubuntu VM_HOST=1.2.3.4 ./scripts/deploy.sh
#   小内存机器（<2GB）：本脚本在本机先 pnpm install + next build，产物再 rsync 上去，
#   服务器上只需要裸 node + systemd，不跑构建。
set -euo pipefail
cd "$(dirname "$0")/.."

VM_USER="${VM_USER:-ubuntu}"
VM_HOST="${VM_HOST:?请设置 VM_HOST（服务器 IP 或域名）}"
VM="$VM_USER@$VM_HOST"
STAGE=/tmp/cassia-prebuilt

# 1. 干净源码树（密钥与构建产物永不进包）
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .workspace \
  --exclude .git --exclude .env --exclude '.env.*' --exclude .insforge \
  ./ "$STAGE/"

# 2. 本机安装依赖并构建前端（按 linux/x64 拉 optional deps）
cd "$STAGE"
cat >> pnpm-workspace.yaml << 'EOF'
supportedArchitectures:
  os: [linux]
  cpu: [x64]
EOF
pnpm install --frozen-lockfile
pnpm --filter @cassia/socket-server... install --frozen-lockfile 2>/dev/null || true
pnpm build

# 3. 推上服务器并重启（.env.production 是服务器上的一次性密钥文件，不覆盖）
synced=0
for i in $(seq 1 8); do
  rsync -az --delete --partial --timeout=30 \
    --exclude '.env.*' --exclude '.insforge' \
    "$STAGE"/ "$VM":~/cassia/ && { synced=1; break; }
  echo "rsync 被链路打断，第 $i 次重试…" >&2
  sleep 3
done
[ "$synced" = 1 ] || { echo 'rsync 重试 8 次仍失败，放弃部署' >&2; exit 1; }

ssh "$VM" 'sudo -n systemctl restart cassia-socket cassia-web &&
  sleep 3 && curl -s http://127.0.0.1:4000/healthz && echo &&
  curl -s -o /dev/null -w "web: %{http_code}\n" http://127.0.0.1:3000/'
