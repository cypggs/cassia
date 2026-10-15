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

# git reset 会替换本脚本文件，而 bash 边执行边读 —— 先复制到 /tmp re-exec，
# 保证整个运行用的是触发时刻的版本（修复「webhook 要触发两次」的坑）
if [ "${UPDATE_SH_REEXEC:-0}" != "1" ]; then
  TMP=/tmp/cassia-update-$$.sh
  cp "$0" "$TMP"
  UPDATE_SH_REEXEC=1 exec bash "$TMP" "$@"
fi

exec > /var/log/cassia-update.log 2>&1
set -x

cd /home/ubuntu/cassia
echo "UPDATE_START $(date -u +%FT%TZ) commit=$(git rev-parse --short HEAD)"

# ── 1. 拉代码 ──
sudo -u ubuntu git fetch origin
sudo -u ubuntu git reset --hard origin/main
echo "更新到 $(git rev-parse --short HEAD)"

# ── 1.5 SSH 公钥（deploy/ssh-keys/*.pub 幂等写入 ubuntu 的 authorized_keys）──
# 注意：此脚本可能以 ubuntu（webhook）或 root（user-data/手动 sudo）运行，
# 用 $SUDO_USER 或 whoami 判断，避免 sudo 嵌套失败
RUN_USER=$(whoami)
echo "运行用户: $RUN_USER"
SSH_DIR=/home/ubuntu/.ssh
AUTH_KEYS=$SSH_DIR/authorized_keys
mkdir -p $SSH_DIR
chmod 700 $SSH_DIR
touch $AUTH_KEYS
chmod 600 $AUTH_KEYS
KEY_COUNT=0
for pub in /home/ubuntu/cassia/deploy/ssh-keys/*.pub; do
  [ -f "$pub" ] || continue
  key=$(cat "$pub")
  if grep -qF "$key" $AUTH_KEYS 2>/dev/null; then
    echo "SSH key 已存在: $(basename $pub)"
  else
    echo "$key" >> $AUTH_KEYS
    echo "SSH key 已写入: $(basename $pub)"
    KEY_COUNT=$((KEY_COUNT+1))
  fi
done
chown -R ubuntu:ubuntu $SSH_DIR
echo "SSH keys 新增: $KEY_COUNT, authorized_keys 行数: $(wc -l < $AUTH_KEYS)"

# ── 2. 依赖 ──
sudo -u ubuntu -H pnpm install

# ── 3. 前端重建（NEXT_PUBLIC_* 从 .env.production 读）──
# 注意：-H 把 HOME 设为 ubuntu 的家目录。root 调用（user-data / 手动 sudo）时
# 不带 -H 会让 ubuntu 身份的 pnpm 去读 /root/.config/pnpm，permission denied。
set -a; source /home/ubuntu/cassia/.env.production; set +a
sudo -u ubuntu -HE bash -c 'cd /home/ubuntu/cassia && pnpm build'

# ── 4. systemd 服务文件可能有变，重装并重启 ──
# 脚本可能以 root（手动 sudo）或 ubuntu（webhook）运行，特权操作统一走 SUDO
SUDO=""
[ "$(whoami)" != "root" ] && SUDO="sudo -n"
$SUDO cp /home/ubuntu/cassia/deploy/cassia-socket.service /home/ubuntu/cassia/deploy/cassia-web.service \
   /etc/systemd/system/
$SUDO systemctl daemon-reload
$SUDO systemctl restart cassia-socket cassia-web

# ── 5. 健康检查 ──
sleep 5
curl -sf http://127.0.0.1:4000/healthz && echo " socket OK"
curl -sf -o /dev/null http://127.0.0.1:3000/ && echo " web OK"

# ── 6. 可选：重建 E2B 模板 ──
# 构建必须也走 systemd-run:本脚本自己被 webhook 以 systemd-run 启动时,
# nohup & 的后台子进程仍在本 unit 的 cgroup 里,脚本一退出就被 systemd
# 株连杀掉(实测:构建秒死、trap 没跑、.dockerignore 丢在 /tmp)。
if [ "${REBUILD_TEMPLATES:-0}" = "1" ]; then
  echo "后台重建 E2B 模板（pi 版本已更新）…"
  TS=$(date +%s)
  $SUDO systemd-run --quiet --collect --uid=ubuntu \
    --unit="cassia-tpl-lite-$TS" \
    --setenv="E2B_API_KEY=${E2B_API_KEY:-}" --setenv="HOME=/home/ubuntu" \
    bash -c '/home/ubuntu/cassia/sandbox-lite/build.sh > /home/ubuntu/template-build.log 2>&1'
  $SUDO systemd-run --quiet --collect --uid=ubuntu \
    --unit="cassia-tpl-desktop-$TS" \
    --setenv="E2B_API_KEY=${E2B_API_KEY:-}" --setenv="HOME=/home/ubuntu" \
    bash -c '/home/ubuntu/cassia/sandbox-desktop/build.sh > /home/ubuntu/template-build-desktop.log 2>&1'
fi

echo "UPDATE_DONE $(date -u +%FT%TZ)"
