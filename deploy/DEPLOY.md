# 部署到 Linux 服务器（公网 IP + 裸 HTTP）

本文档假设：Linux 服务器（Ubuntu/Debian/CentOS 均可）+ 有公网 IP + 暂不配域名/HTTPS。

部署后 ESP32 上报地址为：

```
http://<你的公网IP>:3000/api/data
```

---

## 方式一：一键脚本（推荐）

1. 把整个 `farm-monitor` 文件夹传到服务器（在你**本机**执行）：

```bash
# 从本机上传（Windows 用 scp 或 WinSCP / Xftp 都行）
scp -r farm-monitor 用户名@服务器IP:/home/用户名/
```

2. 在**服务器**上执行：

```bash
cd ~/farm-monitor
sudo bash deploy/install.sh /opt/farm-monitor
```

脚本会自动：检测 Node.js → 复制文件到 `/opt/farm-monitor` → 注册 systemd 服务 → 开机自启并启动。

---

## 方式二：手动部署

### 1. 安装 Node.js 18+

Ubuntu / Debian：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # 应显示 v20.x 或更高
```

CentOS / RHEL：

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

### 2. 上传并测试运行

```bash
# 本机上传
scp -r farm-monitor 用户名@服务器IP:/opt/

# 服务器上先手动跑一次验证
cd /opt/farm-monitor
node server.js
# 看到 "养殖环境实时监测系统已启动" 即成功，Ctrl+C 退出
```

测试接口：

```bash
curl -X POST http://localhost:3000/api/data \
  -H "Content-Type: application/json" \
  -d '{"device_id":"esp32-01","name":"1号鸡舍","temperature":25.5,"humidity":60}'
```

### 3. 注册为 systemd 服务（后台常驻 + 开机自启）

```bash
# 复制服务文件，并按需修改里面的 User 和路径
sudo cp /opt/farm-monitor/deploy/farm-monitor.service /etc/systemd/system/farm-monitor.service
sudo nano /etc/systemd/system/farm-monitor.service   # 改 User= 和 WorkingDirectory=/ExecStart=

sudo systemctl daemon-reload
sudo systemctl enable --now farm-monitor
sudo systemctl status farm-monitor
```

常用命令：

```bash
sudo systemctl restart farm-monitor   # 重启（改了 config.json 后执行）
sudo systemctl stop farm-monitor
journalctl -u farm-monitor -f         # 实时看日志
```

### 4. 放行防火墙端口 3000

Ubuntu / Debian（ufw）：

```bash
sudo ufw allow 3000/tcp
sudo ufw status
# 若 ufw 尚未开启，先确保放行 SSH 再开启：sudo ufw allow 22/tcp && sudo ufw enable
```

CentOS / RHEL（firewalld）：

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### 5. 验证公网访问

在本机浏览器打开：

```
http://<服务器公网IP>:3000
```

应能看到仪表盘；再用 curl 从本机向公网 IP 上报一条数据，确认网页实时刷新。

---

## ESP32 端要改什么

把上报地址改成你的公网 IP：

```cpp
const char* serverUrl = "http://<你的公网IP>:3000/api/data";
```

每块 ESP32 给不同 `device_id` 即可自动分栏显示。

---

## 常见问题

**Q：为什么用 3000 端口，能不能用 80？**
可以。改 `config.json` 的 `port` 为 80，或给服务加 `Environment=PORT=80`。但 Linux 下监听 1024 以下端口需要 root 权限，简单起见建议：先用 3000 跑通，后续要 80/443 时加 Nginx 反向代理即可（我可以再给你 Nginx 配置）。

**Q：公网 IP 会变怎么办？**
家用宽带公网 IP 常变动。长期稳定建议：① 买域名做 DDNS 动态解析；② 或向运营商申请固定 IP。配置好域名后我再帮你上 HTTPS（Let's Encrypt 免费证书）。

**Q：数据安全吗？**
裸 HTTP 下环境数据是明文传输的。温湿度这类数据不敏感，问题不大；但 `/api/chat` 里如果接了智能体，密钥一定要放在**服务器端**的 `config.json`（已按此设计，前端不暴露密钥）。正式使用建议尽快配 HTTPS。

**Q：改了 config.json（比如接入智能体）怎么生效？**
```bash
sudo systemctl restart farm-monitor
```

---

## 后续可选（需要时告诉我）

- [ ] Nginx 反向代理 + 80/443 端口
- [ ] 域名 + DDNS + HTTPS（Let's Encrypt）
- [ ] 多设备告警推送（微信/钉钉/邮件）
- [ ] 历史数据存 SQLite/数据库
- [ ] 接入你自己的智能体后做病因判断联调
