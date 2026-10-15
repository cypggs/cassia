#!/bin/bash
# 切换 E2B 模板：更新 .env.production 的 E2B_TEMPLATE 并重启 socket-server。
# 用法：sudo bash deploy/switch-template.sh cassia-lite
# 日志：/var/log/cassia-switch.log
set -euo pipefail
exec > /var/log/cassia-switch.log 2>&1
set -x

NEW_TEMPLATE="${1:?用法: $0 <template-name>}"
ENV_FILE=/home/ubuntu/cassia/.env.production

echo "SWITCH_START $(date -u +%FT%TZ) -> $NEW_TEMPLATE"

# 更新 .env.production
if grep -q "^E2B_TEMPLATE=" "$ENV_FILE"; then
  sed -i "s/^E2B_TEMPLATE=.*/E2B_TEMPLATE=$NEW_TEMPLATE/" "$ENV_FILE"
else
  echo "E2B_TEMPLATE=$NEW_TEMPLATE" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
grep "^E2B_TEMPLATE=" "$ENV_FILE"

# 重启 socket-server（web 不用动）
systemctl restart cassia-socket
sleep 5
curl -sf http://127.0.0.1:4000/healthz && echo " socket OK"

echo "SWITCH_DONE $(date -u +%FT%TZ)"
