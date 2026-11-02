#!/usr/bin/env bash
# 一键部署脚本：把本目录的 farm-monitor 装到服务器并注册为 systemd 服务
# 用法（在服务器上执行）：
#   sudo bash install.sh /opt/farm-monitor
# 不传参数时默认装到 /opt/farm-monitor
set -euo pipefail

APP_DIR="${1:-/opt/farm-monitor}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"          # deploy 的上一级 = 项目根目录
RUN_USER="${SUDO_USER:-$USER}"              # 用 sudo 执行时取实际登录用户
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "[错误] 未检测到 Node.js。请先安装 Node.js 18+："
  echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "  CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs"
  exit 1
fi

echo "==> 安装 Node.js: $("$NODE_BIN" --version)  运行用户: $RUN_USER"
echo "==> 部署目录: $APP_DIR"

mkdir -p "$APP_DIR"
cp -r "$SRC_DIR/server.js" "$SRC_DIR/config.json" "$SRC_DIR/public" "$SRC_DIR/package.json" "$APP_DIR/"
mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER" "$APP_DIR/data"   # 数据目录需对运行用户可写

# 写入 systemd 服务单元
cat > /etc/systemd/system/farm-monitor.service <<EOF
[Unit]
Description=Farm Environment Monitor
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now farm-monitor
sleep 1
systemctl status farm-monitor --no-pager || true

echo ""
echo "部署完成。验证："
echo "  本机:   curl http://localhost:3000/api/health"
echo "  公网:   http://<你的公网IP>:3000"
echo "  ESP32:  POST http://<你的公网IP>:3000/api/data"
echo "日志:    journalctl -u farm-monitor -f"
