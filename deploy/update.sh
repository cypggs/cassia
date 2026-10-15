#!/bin/bash
# Cassia 迭代更新脚本：在 EC2 上拉最新代码、重建、重启。
# 由 EC2 user-data 调用（每次部署改 user-data 后 reboot 触发），
# 也可以在机器上手动 sudo bash deploy/update.sh
#
# 环境变量（user-data 里 export，或已存在于 .env.production）：
#   REBUILD_TEMPLATES=1  时重建 E2B 模板（约 10-20 分钟，后台跑，不阻塞上线）
#
# 日志：/var/log/cassia-update.log
set -euo pipefail
exec > /var/log/cassia-update.log 2>&1
set -x

cd /home/ubuntu/cassia
echo "UPDATE_START $(date -u +%FT%TZ) commit=$(git rev-parse --short HEAD)"

# ── 1. 拉代码 ──
sudo -u ubuntu git fetch origin
sudo -u ubuntu git reset --hard origin/main
echo "更新到 $(git rev-parse --short HEAD)"

# ── 2. 依赖 ──
sudo -u ubuntu pnpm install

# ── 3. 前端重建（NEXT_PUBLIC_* 从 .env.production 读）──
set -a; source /home/ubuntu/cassia/.env.production; set +a
sudo -u ubuntu -E bash -c 'cd /home/ubuntu/cassia && pnpm build'

# ── 4. systemd 服务文件可能有变，重装并重启 ──
cp /home/ubuntu/cassia/deploy/cassia-socket.service /home/ubuntu/cassia/deploy/cassia-web.service \
   /etc/systemd/system/
systemctl daemon-reload
systemctl restart cassia-socket cassia-web

# ── 5. 健康检查 ──
sleep 5
curl -sf http://127.0.0.1:4000/healthz && echo " socket OK"
curl -sf -o /dev/null http://127.0.0.1:3000/ && echo " web OK"

# ── 6. 可选：后台重建 E2B 模板 ──
if [ "${REBUILD_TEMPLATES:-0}" = "1" ]; then
  echo "后台重建 E2B 模板（pi 版本已更新）…"
  sudo -u ubuntu -E bash -c \
    'cd /home/ubuntu/cassia && nohup ./sandbox-lite/build.sh > /home/ubuntu/template-build.log 2>&1 &'
  sudo -u ubuntu -E bash -c \
    'cd /home/ubuntu/cassia && nohup ./sandbox-desktop/build.sh > /home/ubuntu/template-build-desktop.log 2>&1 &'
fi

echo "UPDATE_DONE $(date -u +%FT%TZ)"
