#!/bin/bash
# Cassia all-in-one EC2 自举脚本（Ubuntu 24.04）。
#
# 由 EC2 user-data 调用，全程无人值守。需要的环境变量（user-data 里 export）：
#   E2B_API_KEY      E2B 沙箱算力 key（https://e2b.dev）
#   DEEPSEEK_API_KEY 模型 key（或换成 ANTHROPIC_API_KEY，下文自行改）
#   PUBLIC_IP        本机公网 IP（配 Elastic IP 后是固定的）
#
# 做完什么：一台机器上跑起 Next.js :3000 + socket-server :4000，
# Caddy 把公网 80 反代到两者（单域名/IP all-in-one），SQLite 零外部依赖。
# E2B 模板（cassia-lite）在后台单独构建，约 10-20 分钟，不阻塞上线。
#
# 日志：/var/log/cassia-bootstrap.log ；模板构建：/home/ubuntu/template-build.log
set -euo pipefail
exec > /var/log/cassia-bootstrap.log 2>&1
set -x

E2B_API_KEY="${E2B_API_KEY:?E2B_API_KEY 未设置}"
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY 未设置}"
PUBLIC_IP="${PUBLIC_IP:?PUBLIC_IP 未设置}"
export E2B_API_KEY DEEPSEEK_API_KEY

# ── 0. swap：t3.small 只有 2GB，next build 需要兜底 ──
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 1. Node 22 + pnpm + git + Caddy ──
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl ca-certificates
if ! command -v node >/dev/null || ! node -e 'process.exit(process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm i -g pnpm @e2b/cli
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# ── 2. 拉代码、装依赖 ──
if [ ! -d /home/ubuntu/cassia/.git ]; then
  sudo -u ubuntu git clone https://github.com/cypggs/cassia.git /home/ubuntu/cassia
fi
cd /home/ubuntu/cassia
sudo -u ubuntu git pull --ff-only || true
sudo -u ubuntu pnpm install

# ── 3. .env.production：密钥只落在这个文件（600），永不进 git ──
cat > /home/ubuntu/cassia/.env.production <<EOF
# 由 deploy/bootstrap-ec2.sh 生成（$(date -u +%FT%TZ)）
E2B_API_KEY=${E2B_API_KEY}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
PI_MODEL=deepseek/deepseek-chat
E2B_TEMPLATE=cassia-lite
SOCKET_PORT=4000
NEXT_PUBLIC_SOCKET_URL=http://${PUBLIC_IP}
NEXT_PUBLIC_SUPPORT_EMAIL=support@example.com
CORS_ORIGIN=http://${PUBLIC_IP}
EOF
chmod 600 /home/ubuntu/cassia/.env.production
chown ubuntu:ubuntu /home/ubuntu/cassia/.env.production

# ── 4. 构建前端（NEXT_PUBLIC_* 在此 baked 进产物）──
set -a; source /home/ubuntu/cassia/.env.production; set +a
sudo -u ubuntu -E bash -c 'cd /home/ubuntu/cassia && pnpm build'

# ── 5. systemd ──
cp /home/ubuntu/cassia/deploy/cassia-socket.service /home/ubuntu/cassia/deploy/cassia-web.service \
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cassia-socket cassia-web

# ── 6. Caddy：单 IP 反代（有域名后把 Caddyfile 换成 deploy/Caddyfile 的域名版拿证书）──
cat > /etc/caddy/Caddyfile <<EOF
http://${PUBLIC_IP} {
	handle /socket.io/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle /sessions/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
EOF
systemctl reload caddy || systemctl restart caddy

# ── 7. 后台构建 E2B 模板（约 10-20 分钟，不阻塞）──
sudo -u ubuntu -E bash -c \
  'cd /home/ubuntu/cassia && nohup ./sandbox-lite/build.sh > /home/ubuntu/template-build.log 2>&1 &'

echo "BOOTSTRAP_DONE $(date -u +%FT%TZ)"
