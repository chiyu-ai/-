# 养殖环境实时监测系统

基于 ESP32-S3 的养殖环境监测与智能诊断平台。系统采集舍内温湿度、二氧化碳、土壤湿度、光照、火焰等环境数据，结合摄像头画面与 AI 模型，为养殖户提供实时监控、异常预警和病因辅助诊断。

## 一、项目简介

系统由三部分组成：

- **终端（ESP32-S3）**：采集环境数据与摄像头画面，通过 WiFi 上报，并在本机提供 MJPEG 视频流；
- **服务端（Node.js）**：接收并持久化数据，通过 SSE 实时推送到网页，调用扣子（Coze）智能体做诊断；
- **前端（Web）**：展示实时数据、趋势曲线、诊断分析、养殖手册，并内置 AI 兽医助手。

## 二、功能特性

### 环境监测
- 接收多台 ESP32 上报的环境数据，按设备 ID 分开存储与展示
- 指标越限分级告警：轻微超出显示黄色，严重超出显示红色
- 点击指标查看历史曲线，并叠加正常范围对比带
- 设备支持录入物种、数量、面积、成长阶段、体重，自动计算种群密度

### 摄像头
- ESP32 定时上传 JPEG 快照，供外网查看
- 局域网内提供 MJPEG 视频流（`http://<ESP32-IP>:81/stream`），延迟低
- 支持 AI 识别画面内容（动物种类、数量、移动状态）

### 智能诊断
- AI 兽医助手：结合实时环境、物种手册、本场患病记录判断病因
- 健康预警：根据个体状态与环境数据给出风险等级、可能疾病及病前/病中/病后方案
- 个体档案：每个个体单独保存对话与病史，复诊时自动带上既往记录
- 患病记录与预警记录以文本形式落盘，可在页面查询、新增、删除

### 其他
- 养殖手册：34 类物种、近 3000 个品种，支持模糊搜索与两级浏览
- 市场行情：展示各物种与品种的收购价、出售价，可按日变化，支持接入外部数据源
- 今日天气：接入 Open-Meteo，可按用户所在城市显示实时天气

## 三、技术架构

| 层次 | 技术选型 |
|------|---------|
| 终端 | ESP32-S3（N16R8）、Arduino 框架、DHT11、OV3660 摄像头、SSD1306 OLED |
| 通信 | HTTP（数据上报、快照）、SSE（实时推送）、MJPEG（视频流） |
| 服务端 | Node.js 18+，仅使用内置模块（`http`、`fs`、`path` 等），无第三方依赖 |
| 前端 | 原生 HTML / CSS / JavaScript，Canvas 绘制图表 |
| AI | 扣子（Coze）v3 Chat API |

服务端不引入任何 npm 依赖，降低部署与评审环境的搭建成本。

## 四、目录结构

```
farm-monitor/
├── server.js              # 后端服务入口
├── market.js              # 市场行情数据模块
├── species.js             # 物种与品种知识库
├── config.json            # 运行配置（含密钥，不提交仓库）
├── config.example.json    # 配置模板
├── .env.example           # 环境变量模板
├── package.json
├── README.md
├── data/                  # 运行数据（自动生成，不提交仓库）
│   ├── devices.json       # 设备数据
│   ├── conversations.json # 个体对话档案
│   ├── illness.json       # 患病记录
│   ├── illness/           # 每个患病事件一个 txt
│   └── warnings/          # 每次 AI 预警一个 txt
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── deploy/
│   ├── install.sh         # 一键部署脚本
│   ├── farm-monitor.service
│   └── DEPLOY.md
└── esp32/
    └── esp32_s3_farm_camera.ino
```

## 五、环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows / Linux / macOS |
| Node.js | 18.0 及以上（需内置 `fetch`） |
| 浏览器 | Chrome / Edge / Safari 最新版 |
| 终端（可选） | ESP32-S3 开发板 + Arduino IDE 2.x |

## 六、快速开始

```bash
git clone <仓库地址>
cd farm-monitor
cp config.example.json config.json   # 按需填写智能体密钥
node server.js
```

启动后访问 `http://localhost:3000`，使用演示账号登录：

- 账号：`1`
- 密码：`1`

页面右上角可点击「模拟上报」生成测试数据，无需连接硬件即可查看完整效果。

## 七、配置说明

### 7.1 配置文件

复制 `config.example.json` 为 `config.json` 后按需修改：

| 字段 | 说明 |
|------|------|
| `port` | 服务端口，默认 3000 |
| `host` | 监听地址，默认 0.0.0.0 |
| `thresholds` | 各指标告警阈值（min / max / unit） |
| `agent` | 智能体配置（扣子 botId、apiKey、接口地址） |
| `market.url` | 外部行情数据源地址，留空使用本地模型 |
| `weather` | 天气位置（纬度、经度、城市名） |
| `auth` | 登录账号与密码 |

### 7.2 环境变量

配置文件中的敏感项可用环境变量覆盖，便于部署时避免把密钥写入文件：

```bash
cp .env.example .env
# 编辑 .env 后通过 export 或进程管理器注入
```

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口 |
| `HOST` | 监听地址 |
| `COZE_API_KEY` | 扣子 API Token，覆盖 `config.agent.apiKey` |
| `COZE_BOT_ID` | 扣子 Bot ID，覆盖 `config.agent.botId` |
| `WEATHER_CITY` | 默认天气城市，覆盖 `config.weather.city` |

### 7.3 依赖清单

无第三方 npm 依赖，`package.json` 中 `dependencies` 为空。终端固件依赖以下 Arduino 库：

- DHT sensor library
- Adafruit Unified Sensor
- Adafruit SSD1306
- Adafruit GFX Library
- esp32-camera（随 ESP32 Arduino 核心提供）

## 八、接口文档

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/data` | 接收 ESP32 环境数据 |
| `GET` | `/api/devices` | 查询全部设备 |
| `DELETE` | `/api/devices` | 清空全部设备 |
| `GET` | `/api/events` | SSE 实时推送 |
| `POST` | `/api/devices/:id/meta` | 更新设备元数据（物种、数量、面积、阶段、体重） |
| `POST` | `/api/camera/:id` | 上传摄像头快照 |
| `GET` | `/api/camera/:id` | 读取最新快照 |
| `POST` | `/api/camera/:id/recognize` | AI 识别画面 |
| `POST` | `/api/health/:id` | AI 健康预警分析 |
| `POST` | `/api/chat` | 智能体对话 |
| `GET` | `/api/conversations` | 个体档案列表 |
| `GET/POST/DELETE` | `/api/conversations/:id` | 个体对话读写与删除 |
| `POST/GET` | `/api/illness` | 患病记录写入与查询 |
| `DELETE` | `/api/illness/:id` | 删除患病记录 |
| `GET` | `/api/real-knowledge` | 聚合后的真实知识库 |
| `GET` | `/api/warnings` | 预警记录列表 |
| `GET/DELETE` | `/api/warnings/file` | 读取或删除预警文本 |
| `GET` | `/api/market` | 市场行情 |
| `GET` | `/api/market/breeds` | 品种行情 |
| `GET` | `/api/weather` | 今日天气 |
| `GET` | `/api/species` | 物种知识库 |
| `GET` | `/api/analysis` | 数据诊断分析 |
| `POST` | `/api/login` | 登录校验 |
| `GET` | `/api/health` | 服务健康检查 |

数据上报示例：

```bash
curl -X POST http://localhost:3000/api/data \
  -H "Content-Type: application/json" \
  -d '{"device_id":"esp32-01","temperature":25.5,"humidity":60,"co2":800,"soil":45,"light":70,"flame":0}'
```

## 九、硬件接入

### 9.1 接线

| 模块 | 针脚 | 接到 ESP32-S3 |
|------|------|--------------|
| DHT11 温湿度 | DATA / VCC / GND | GPIO47 / 3V3 / GND |
| 土壤湿度 | AO / VCC / GND | GPIO1 / 3V3 / GND |
| 光敏 | AO / VCC / GND | GPIO3 / 3V3 / GND |
| 火焰 | DO / VCC / GND | GPIO21 / 3V3 / GND |
| OLED（I2C） | SDA / SCL / VCC / GND | GPIO41 / GPIO42 / 3V3 / GND |
| JW01 二氧化碳（UART） | B(TX) / VCC / GND | GPIO2 / 5V / GND |
| SC7A20H（UART） | TX / VCC / GND | GPIO38 / 3V3 / GND |
| OV3660 摄像头 | 板载 FPC | 无需手动接线 |

所有传感器统一使用 3.3V 供电（JW01 需 5V），避免超过 ESP32 的 IO 耐压。

### 9.2 固件编译

使用 Arduino IDE 打开 `esp32/esp32_s3_farm_camera.ino`：

1. 开发板选择 `ESP32S3 Dev Module`
2. PSRAM 选择 `OPI PSRAM`（摄像头帧缓冲必需）
3. 端口选择实际串口
4. 修改文件顶部的 WiFi 账号、密码与服务器地址
5. 编译上传

### 9.3 视频流

固件在 81 端口提供 MJPEG 视频流，局域网内可直接访问：

```
http://<ESP32的IP>:81/stream
```

## 十、部署

Linux 服务器部署见 `deploy/DEPLOY.md`，其中包含一键安装脚本与 systemd 服务配置。

```bash
sudo cp deploy/farm-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now farm-monitor
```

## 十一、常见问题

**Q：摄像头初始化失败？**
检查 Arduino IDE 的 PSRAM 是否选择了 `OPI PSRAM`，以及摄像头 FPC 排线是否插紧。

**Q：页面数据不更新？**
确认 ESP32 已连接到与服务端同一网络，且 `serverUrl` 指向正确的服务端地址与端口。

**Q：智能体回复为空或报错？**
检查 `config.json` 中的 `agent.apiKey` 是否有效、该 Token 是否已过期。

**Q：页面刷新后仍是旧版本？**
浏览器可能缓存了静态资源，使用 `Ctrl + F5` 强制刷新。

## 十二、团队信息

| 项目 | 内容 |
|------|------|
| 团队名称 | （待填写） |
| 成员 | （待填写） |
| 指导教师 | （待填写） |
| 联系方式 | （待填写） |

## 十三、许可证

本项目采用 MIT 许可证。
