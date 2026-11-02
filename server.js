'use strict';

/**
 * 养殖环境实时监测系统 —— 后端服务
 *
 * 功能：
 *  1. 接收 ESP32 通过 POST 发送的环境数据（JSON），并自动按设备分隔存储
 *  2. 提供 REST 接口查询设备数据
 *  3. 通过 SSE（Server-Sent Events）实时推送数据到网页状态栏
 *  4. 预留 /api/chat 智能体接口（可转发到你自己的智能体）
 *  5. 数据持久化到本地 JSON 文件
 *
 * 无第三方依赖，纯 Node.js 内置模块实现。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { URL } = require('url');

// 配置
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('[启动] 读取 config.json 失败，使用默认配置：', e.message);
  config = {};
}

const PORT = Number(process.env.PORT) || config.port || 3000;
const HOST = process.env.HOST || config.host || '0.0.0.0';
const DATA_DIR = path.join(ROOT, config.dataDir || 'data');
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const ILLNESS_FILE = path.join(DATA_DIR, 'illness.json');
const ILLNESS_DIR = path.join(DATA_DIR, 'illness');
const WARNING_DIR = path.join(DATA_DIR, 'warnings');
const HISTORY_LIMIT = Number(config.historyLimit) || 500;
const OFFLINE_AFTER_MS = Number(config.offlineAfterMs) || 120000;
const THRESHOLDS = config.thresholds || {};
// 智能体配置：环境变量优先，便于部署时不把密钥写入配置文件
const AGENT = Object.assign({}, config.agent || {}, {
  apiKey: process.env.COZE_API_KEY || (config.agent && config.agent.apiKey) || '',
  botId: process.env.COZE_BOT_ID || (config.agent && config.agent.botId) || ''
});
const SPECIES = require('./species');   // 家禽家畜物种知识库
const MARKET = require('./market');     // 市场行情模块
const AUTH = config.auth || { username: '1', password: '1' };

// 物种未单独定义时使用的通用正常范围（CO2 / 土壤 / 饲料槽）
const DEFAULT_NORMAL = {
  co2: { min: 0, max: 2500, unit: 'ppm' },
  soil: { min: 20, max: 100, unit: '%' },
  feed_level: { min: 20, max: 100, unit: '%' }
};

function normalFor(speciesName, key) {
  const sp = SPECIES.find((s) => s.name === speciesName);
  return (sp && sp.normal && sp.normal[key]) || DEFAULT_NORMAL[key] || null;
}

// 状态存储
// devices: { [deviceId]: { id, name, lastSeen, latest, history[], meta } }
let devices = new Map();
let sseClients = new Set();
// cameraFrames: deviceId -> { buf: Buffer, ts: number }  最新摄像头画面
let cameraFrames = new Map();
// 识别节流：deviceId -> 上次识别时间戳
let lastRecognize = new Map();
// 个体对话档案：个体编号 -> [{role, content, ts}]
let conversations = new Map();

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 从磁盘恢复数据
function loadDevices() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [id, d] of Object.entries(raw)) {
        devices.set(id, d);
      }
      console.log(`[启动] 已从磁盘恢复 ${devices.size} 台设备数据`);
    }
  } catch (e) {
    console.error('[启动] 恢复设备数据失败：', e.message);
  }
}

// 个体对话档案：加载/保存
function loadConversations() {
  try {
    if (fs.existsSync(CONV_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
      for (const [id, list] of Object.entries(raw)) {
        if (Array.isArray(list)) conversations.set(id, list);
      }
      console.log(`[启动] 已恢复 ${conversations.size} 个个体对话档案`);
    }
  } catch (e) {
    console.error('[启动] 恢复对话档案失败：', e.message);
  }
}

let convSaveTimer = null;
function saveConversations() {
  if (convSaveTimer) return;
  convSaveTimer = setTimeout(() => {
    convSaveTimer = null;
    try {
      fs.writeFileSync(CONV_FILE, JSON.stringify(Object.fromEntries(conversations), null, 2), 'utf8');
    } catch (e) {
      console.error('[会话] 写入失败：', e.message);
    }
  }, 300);
}

// 患病记录（本地文本 + 真实知识库）
let illnessRecords = [];

function loadIllness() {
  try {
    if (fs.existsSync(ILLNESS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ILLNESS_FILE, 'utf8'));
      if (Array.isArray(raw)) illnessRecords = raw;
    }
  } catch (e) { console.error('[患病] 加载失败：', e.message); }
  if (!fs.existsSync(ILLNESS_DIR)) fs.mkdirSync(ILLNESS_DIR, { recursive: true });
}

function saveIllness() {
  try { fs.writeFileSync(ILLNESS_FILE, JSON.stringify(illnessRecords, null, 2), 'utf8'); }
  catch (e) { console.error('[患病] 保存失败：', e.message); }
}

function recordIllness(body) {
  const b = body || {};
  const deviceId = String(b.deviceId || '').trim();
  const dev = deviceId ? devices.get(deviceId) : null;
  const latest = (dev && dev.latest) || {};
  const ts = now();
  const rec = {
    id: 'ill-' + ts,
    ts,
    time: isoTime(ts),
    individualId: String(b.individualId || '').trim(),
    deviceId,
    deviceName: (dev && dev.name) || '',
    species: (dev && dev.meta && dev.meta.species) || String(b.species || ''),
    disease: String(b.disease || '').trim(),
    symptoms: String(b.symptoms || '').trim(),
    note: String(b.note || '').trim(),
    env: {
      temperature: latest.temperature,
      humidity: latest.humidity,
      co2: latest.co2,
      ammonia: latest.ammonia,
      light: latest.light,
      soil: latest.soil,
      flame: latest.flame
    }
  };
  illnessRecords.push(rec);
  if (illnessRecords.length > 2000) illnessRecords.shift();
  saveIllness();

  // 每个事件写一个本地文本文件
  const safeName = (rec.individualId || rec.deviceId || 'record').replace(/[\\/:*?"<>|]/g, '_');
  const fname = new Date(ts).toISOString().replace(/[:.]/g, '-') + '_' + safeName + '.txt';
  const lines = [
    '患病记录',
    '============================================',
    '时间：' + rec.time,
    '个体档案：' + (rec.individualId || '未填写'),
    '设备：' + (rec.deviceName || rec.deviceId || '未关联'),
    '物种：' + (rec.species || '未知'),
    '患病类型：' + (rec.disease || '未填写'),
    '症状：' + (rec.symptoms || '未填写'),
    '备注：' + (rec.note || '无'),
    '',
    '【患病时的环境数据】',
    ...Object.entries(rec.env).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => '  ' + k + '：' + v),
    ''
  ];
  try { fs.writeFileSync(path.join(ILLNESS_DIR, fname), lines.join('\n'), 'utf8'); }
  catch (e) { console.error('[患病] 文本写入失败：', e.message); }
  return rec;
}

function listIllness() {
  return illnessRecords.slice(-300).reverse();
}

function buildRealKnowledge() {
  const byDisease = {};
  for (const r of illnessRecords) {
    const d = r.disease || '未分类';
    if (!byDisease[d]) byDisease[d] = { disease: d, count: 0, temp: [], hum: [], co2: [], symptoms: {}, species: {} };
    const g = byDisease[d];
    g.count++;
    if (r.env && r.env.temperature !== undefined) g.temp.push(Number(r.env.temperature));
    if (r.env && r.env.humidity !== undefined) g.hum.push(Number(r.env.humidity));
    if (r.env && r.env.co2 !== undefined) g.co2.push(Number(r.env.co2));
    if (r.symptoms) g.symptoms[r.symptoms] = (g.symptoms[r.symptoms] || 0) + 1;
    if (r.species) g.species[r.species] = (g.species[r.species] || 0) + 1;
  }
  const avg = (arr) => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  const parameters = Object.values(byDisease).map((g) => ({
    disease: g.disease,
    count: g.count,
    avgTemperature: avg(g.temp),
    avgHumidity: avg(g.hum),
    avgCo2: avg(g.co2),
    symptoms: Object.entries(g.symptoms).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ symptom: k, count: v })),
    species: Object.entries(g.species).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, count: v }))
  }));
  return { total: illnessRecords.length, parameters, records: listIllness() };
}

function buildRealKnowledgeContext() {
  const rk = buildRealKnowledge();
  if (!rk.total) return '';
  const lines = rk.parameters.slice(0, 8).map((p) => {
    const env = [];
    if (p.avgTemperature !== null) env.push('平均温度 ' + p.avgTemperature + '°C');
    if (p.avgHumidity !== null) env.push('平均湿度 ' + p.avgHumidity + '%');
    if (p.avgCo2 !== null) env.push('平均CO2 ' + p.avgCo2 + 'ppm');
    return '· ' + p.disease + '：本地记录 ' + p.count + ' 次；' + (env.join('，') || '无环境数据');
  });
  return '【本场真实患病记录（本地知识库）】\n' + lines.join('\n');
}

// 健康预警：结合个体状态 + 环境 + 知识库，让模型判断可能的疾病与预防方法
function buildHealthPrompt(device) {
  const summary = deviceSummary(device);
  const sp = SPECIES.find((s) => s.name === summary.meta.species);
  const latest = device.latest || {};
  const env = [];
  if (latest.temperature !== undefined) env.push('温度 ' + latest.temperature + '°C');
  if (latest.humidity !== undefined) env.push('湿度 ' + latest.humidity + '%');
  if (latest.co2 !== undefined) env.push('二氧化碳 ' + latest.co2 + 'ppm');
  if (latest.ammonia !== undefined) env.push('氨气 ' + latest.ammonia + 'ppm');
  if (latest.light !== undefined) env.push('光照 ' + latest.light + '%');
  if (latest.camera_count !== undefined) env.push('摄像头识别数量 ' + latest.camera_count + ' 只');
  const dinfo = densityInfo(device);
  if (dinfo.actual != null) env.push('种群密度 ' + dinfo.actual + ' 只/㎡');

  const diseases = ((sp && sp.diseases) || [])
    .map((d) => '- ' + d.name + '：症状 ' + d.symptoms + '；诱因 ' + d.factors)
    .join('\n');
  const real = buildRealKnowledgeContext();

  return [
    '【任务】你是养殖场智能预警助手。请根据以下个体状态、环境数据与知识库，判断该个体/群体可能患哪些病，给出可能性排序和对应的预防方法。',
    '',
    '【个体状态】',
    '物种：' + (summary.meta.species || '未知'),
    '成长阶段：' + (summary.meta.stage || '未填写'),
    '体重：' + (summary.meta.weight ? summary.meta.weight + ' kg' : '未填写'),
    '数量：' + (summary.meta.count || '未知') + ' 只/头',
    '面积：' + (summary.meta.area || '未知') + ' ㎡',
    '',
    '【当前环境数据】',
    env.join('，') || '暂无数据',
    '',
    '【该物种常见疫病与诱因】',
    diseases || '暂无',
    '',
    real,
    '',
    '【输出要求】请务必详细、分点展开，不要只写一两句。',
    '一、总体风险判断：给出风险等级（低/中/高）和判断依据。',
    '二、可能疾病清单：按可能性从高到低排列，每种疾病给出：可能性（百分比）、判断依据（结合环境数据、成长阶段、体重、病前征兆）、典型症状。',
    '三、防治方案：针对每种疾病，分三个阶段详细给出：',
    '  【病前预防】环境管理（温湿度/通风/密度/光照）、免疫程序、消毒制度、饲料营养、日常观察要点；',
    '  【病中处置】隔离观察、对症治疗、用药方向（注明需兽医确认）、环境调整、防止扩散；',
    '  【病后恢复】彻底消毒、康复期营养、复检与观察、防复发措施、记录归档。',
    '四、若信息不足，请说明还需要补充哪些数据，不要编造。'
  ].join('\n');
}

// 保存 AI 预警结论为本地文本（每个文件记录设备与时间）
function saveWarning(dev, content) {
  try {
    if (!fs.existsSync(WARNING_DIR)) fs.mkdirSync(WARNING_DIR, { recursive: true });
    const ts = now();
    const deviceLabel = (dev.name || dev.id || 'device').replace(/[\\/:*?"<>|]/g, '_');
    const fname = new Date(ts).toISOString().replace(/[:.]/g, '-') + '_' + deviceLabel + '.txt';
    const lines = [
      'AI 健康预警记录',
      '============================================',
      '设备名称：' + (dev.name || ''),
      '设备 ID：' + (dev.id || ''),
      '物种：' + ((dev.meta && dev.meta.species) || '未知'),
      '成长阶段：' + ((dev.meta && dev.meta.stage) || '未填写'),
      '体重：' + ((dev.meta && dev.meta.weight) ? dev.meta.weight + ' kg' : '未填写'),
      '记录时间：' + isoTime(ts),
      '',
      '【预警结论】',
      String(content || ''),
      ''
    ];
    fs.writeFileSync(path.join(WARNING_DIR, fname), lines.join('\n'), 'utf8');
    return fname;
  } catch (e) {
    console.error('[预警] 写入失败：', e.message);
    return null;
  }
}

// 持久化（节流：最多每秒写一次）
let saveTimer = null;
let dirty = false;
function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(devices), null, 2), 'utf8');
    } catch (e) {
      console.error('[持久化] 写入失败：', e.message);
    }
  }, 1000);
}

// 工具函数
function now() {
  return Date.now();
}

function isoTime(ts) {
  return new Date(ts).toISOString();
}

// 从 IP 生成默认设备名（形如 esp32-192.168.1.5）
function deviceNameFromIp(ip) {
  return ip ? 'esp32-' + ip.replace(/[^0-9a-zA-Z]/g, '-') : 'esp32-unknown';
}

// 解析设备 ID：优先 URL 路径 > 查询参数 > JSON body > 客户端 IP
function resolveDeviceId(req, body) {
  const parsed = url.parse(req.url, true);
  const q = parsed.query || {};

  // 1) URL 路径 /api/data/:deviceId
  const m = parsed.pathname.match(/^\/api\/data\/([^/]+)$/);
  if (m && m[1] && m[1].trim()) return decodeURIComponent(m[1].trim());

  // 2) 查询参数
  const qKey = q.device || q.device_id || q.deviceId || q.id;
  if (qKey) return String(qKey).trim();

  // 3) JSON body 字段
  if (body && typeof body === 'object') {
    const bKey = body.device_id || body.deviceId || body.device || body.id || body.mac || body.esp_id;
    if (bKey) return String(bKey).trim();
  }

  // 4) 回退：客户端 IP
  const ip = getClientIp(req);
  return deviceNameFromIp(ip);
}

// 解析设备自定义名称
function resolveDeviceName(body) {
  if (body && typeof body === 'object') {
    const n = body.name || body.device_name || body.alias;
    if (n && String(n).trim()) return String(n).trim();
  }
  return null;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// 判断字段是否为数值
function isNumeric(v) {
  return typeof v === 'number' && isFinite(v);
}

// 提取环境指标（温度、湿度，以及其它数值字段）
function extractMetrics(body) {
  const metrics = {};
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      if (isNumeric(v) && !['id', 'device_id', 'deviceId', 'mac', 'timestamp', 'ts', 'time', 'rssi'].includes(k)) {
        metrics[k] = v;
      }
    }
  }
  return metrics;
}

// 判断某个指标是否越限
function evaluateMetric(key, value) {
  const t = THRESHOLDS[key];
  if (!t) return 'normal';
  if (value < t.min) return 'low';
  if (value > t.max) return 'high';
  return 'normal';
}

// 数据写入
function upsertDevice(deviceId, name, body, ip) {
  const ts = now();
  let device = devices.get(deviceId);
  if (!device) {
    device = {
      id: deviceId,
      name: deviceId,
      createdAt: ts,
      lastSeen: ts,
      ip: ip || '',
      latest: {},
      history: [],
      meta: {}
    };
    devices.set(deviceId, device);
  }

  device.lastSeen = ts;
  if (ip) device.ip = ip;
  // 设备名称由用户在「编辑设备」中填写，不采用 ESP32 上报的 name

  // 记录设备元数据（物种/数目/面积/自定义阈值）
  if (body && typeof body === 'object') {
    for (const key of ['min_temperature', 'max_temperature', 'min_humidity', 'max_humidity']) {
      if (isNumeric(body[key])) device.meta[key] = body[key];
    }
    if (body.species != null && String(body.species).trim()) device.meta.species = String(body.species).trim();
    if (body.count != null && !isNaN(Number(body.count))) device.meta.count = Number(body.count);
    if (body.area != null && !isNaN(Number(body.area))) device.meta.area = Number(body.area);
    if (body.stage != null && String(body.stage).trim()) device.meta.stage = String(body.stage).trim();
    if (body.weight != null && !isNaN(Number(body.weight))) device.meta.weight = Number(body.weight);
    if (body.local_ip != null && String(body.local_ip).trim()) device.meta.local_ip = String(body.local_ip).trim();
    if (body.stream_port != null) device.meta.stream_port = Number(body.stream_port) || 81;
  }

  const metrics = extractMetrics(body);
  const latest = { time: ts, ...metrics };

  device.latest = latest;
  device.history.push(latest);
  if (device.history.length > HISTORY_LIMIT) {
    device.history.splice(0, device.history.length - HISTORY_LIMIT);
  }

  markDirty();
  return device;
}

// 广播到所有 SSE 客户端
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      // 忽略写入失败，客户端断开时由 close 清理
    }
  }
}

// 组装返回给前端/接口的设备摘要
// 种群密度：数量 / 面积，并与物种参考密度对比
function parseDensityRange(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*[~\-－—～]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2]) };
}

function computeDensity(device) {
  const count = Number(device.meta && device.meta.count) || 0;
  const area = Number(device.meta && device.meta.area) || 0;
  if (count > 0 && area > 0) return Number((count / area).toFixed(2));
  return null;
}

function densityInfo(device) {
  const sp = SPECIES.find((s) => s.name === (device.meta && device.meta.species));
  const actual = computeDensity(device);
  const ref = sp ? parseDensityRange(sp.density) : null;
  let status = 'unknown';
  if (actual != null && ref) {
    status = actual < ref.min ? 'low' : actual > ref.max ? 'high' : 'normal';
  }
  return { actual, ref, status, refText: (sp && sp.density) || '' };
}

// 成长阶段对适宜环境的影响（幼年需更暖、更湿；老年略偏暖）
function stageAdjustedNormal(speciesName, stage) {
  const sp = SPECIES.find((s) => s.name === speciesName);
  const base = Object.assign({}, DEFAULT_NORMAL, (sp && sp.normal) || {});
  const adj = { temperature: 0, humidity: 0, co2: 0, soil: 0, feed_level: 0 };
  if (stage === '幼年' || stage === '幼崽') { adj.temperature = 2; adj.humidity = 3; adj.co2 = -500; }
  else if (stage === '老年') { adj.temperature = 1; adj.co2 = -300; }
  const out = {};
  for (const [k, r] of Object.entries(base)) {
    out[k] = { min: Math.max(0, r.min + (adj[k] || 0)), max: r.max + (adj[k] || 0), unit: r.unit };
  }
  return out;
}

// 超标程度：轻微超出为 mild（黄），超出范围 20% 以上为 severe（红）
function severityOf(key, value, speciesName) {
  const sp = SPECIES.find((s) => s.name === speciesName);
  const norm = sp && sp.normal && sp.normal[key];
  const t = norm || THRESHOLDS[key];
  if (!t) return 'normal';
  const range = (t.max - t.min) || 1;
  let over = 0;
  if (value < t.min) over = (t.min - value) / range;
  else if (value > t.max) over = (value - t.max) / range;
  else return 'normal';
  return over >= 0.2 ? 'severe' : 'mild';
}

function deviceSummary(device) {
  const latest = device.latest || {};
  const metrics = {};
  const speciesName = (device.meta && device.meta.species) || '';
  for (const [k, v] of Object.entries(latest)) {
    if (k === 'time') continue;
    metrics[k] = { value: v, status: evaluateMetric(k, v), severity: severityOf(k, v, speciesName) };
  }
  const online = now() - (device.lastSeen || 0) < OFFLINE_AFTER_MS;
  return {
    id: device.id,
    name: device.name,
    ip: device.ip || '',
    status: online ? 'online' : 'offline',
    lastSeen: device.lastSeen,
    lastSeenText: isoTime(device.lastSeen),
    createdAt: device.createdAt,
    metrics,
    meta: {
      species: (device.meta && device.meta.species) || '',
      count: (device.meta && device.meta.count) || 0,
      area: (device.meta && device.meta.area) || 0,
      stage: (device.meta && device.meta.stage) || '',
      weight: (device.meta && device.meta.weight) || 0,
      local_ip: (device.meta && device.meta.local_ip) || '',
      stream_port: (device.meta && device.meta.stream_port) || 81
    },
    normal: stageAdjustedNormal((device.meta && device.meta.species) || '', (device.meta && device.meta.stage) || ''),
    density: densityInfo(device),
    history: (device.history || []).slice(-200)
  };
}

// 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: '资源不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
}

// HTTP 响应
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20MB（支持图片上传）
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error('JSON 解析失败：' + e.message);
    err.status = 400;
    throw err;
  }
}

// 路由
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  try {
    // 1. 接收 ESP32 数据
    if (req.method === 'POST' && (pathname === '/api/data' || /^\/api\/data\/[^/]+$/.test(pathname))) {
      const body = await parseJsonBody(req);
      const deviceId = resolveDeviceId(req, body);
      const name = resolveDeviceName(body) || deviceId;
      const device = upsertDevice(deviceId, name, body, getClientIp(req));
      const summary = deviceSummary(device);
      broadcast('device-data', summary);
      sendJson(res, 200, { ok: true, device: summary });
      return;
    }

    // 2. 查询设备列表
    if (req.method === 'GET' && pathname === '/api/devices') {
      const list = [...devices.values()]
        .map(deviceSummary)
        .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      sendJson(res, 200, { ok: true, count: list.length, devices: list });
      return;
    }

    // 3. 查询单台设备
    const singleMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (req.method === 'GET' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1]);
      const device = devices.get(id);
      if (!device) {
        sendJson(res, 404, { ok: false, error: '设备不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, device: deviceSummary(device) });
      return;
    }

    // 4. 删除设备
    if (req.method === 'DELETE' && singleMatch) {
      const id = decodeURIComponent(singleMatch[1]);
      if (devices.delete(id)) {
        markDirty();
        broadcast('device-removed', { id });
        sendJson(res, 200, { ok: true, removed: id });
      } else {
        sendJson(res, 404, { ok: false, error: '设备不存在' });
      }
      return;
    }

    // 4.5 更新设备元数据（物种/数目/面积/名称）
    const metaMatch = pathname.match(/^\/api\/devices\/([^/]+)\/meta$/);
    if ((req.method === 'POST' || req.method === 'PUT') && metaMatch) {
      const id = decodeURIComponent(metaMatch[1]);
      let device = devices.get(id);
      if (!device) {
        // 允许通过「添加设备」预先创建（尚无数据）
        device = {
          id: id, name: id, createdAt: now(), lastSeen: 0,
          ip: '', latest: {}, history: [], meta: {}
        };
        devices.set(id, device);
      }
      const body = await parseJsonBody(req);
      if (body && typeof body === 'object') {
        if (body.species != null) device.meta.species = String(body.species).trim();
        if (body.count != null && !isNaN(Number(body.count))) device.meta.count = Number(body.count);
        if (body.area != null && !isNaN(Number(body.area))) device.meta.area = Number(body.area);
        if (body.stage != null) device.meta.stage = String(body.stage).trim();
        if (body.weight != null && !isNaN(Number(body.weight))) device.meta.weight = Number(body.weight);
        if (body.name != null && String(body.name).trim()) {
          device.name = String(body.name).trim();
          device.meta.nameSet = true;   // 用户自定义名称，ESP32 上报不再覆盖
        }
      }
      markDirty();
      const summary = deviceSummary(device);
      broadcast('device-updated', summary);
      sendJson(res, 200, { ok: true, device: summary });
      return;
    }

    // 5. 清空全部设备
    if (req.method === 'DELETE' && pathname === '/api/devices') {
      devices.clear();
      markDirty();
      broadcast('devices-cleared', {});
      sendJson(res, 200, { ok: true });
      return;
    }

    // 6. SSE 实时推送
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': connected\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ time: now() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // 7. 上传图片（上传到扣子，返回 file_id）
    if (req.method === 'POST' && pathname === '/api/upload') {
      const body = await parseJsonBody(req);
      const data = (body && (body.data || body.base64)) || '';
      const name = (body && body.name) || 'image.png';
      if (!data) {
        sendJson(res, 400, { ok: false, error: '缺少图片数据' });
        return;
      }
      try {
        const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
        const fileId = await uploadToCoze(buf, name);
        sendJson(res, 200, { ok: true, file_id: fileId });
      } catch (e) {
        console.error('[上传图片] 失败：', e.message);
        sendJson(res, 500, { ok: false, error: '图片上传失败：' + e.message });
      }
      return;
    }

    // 7.9 个体对话档案
    if (req.method === 'GET' && pathname === '/api/conversations') {
      const list = [...conversations.entries()].map(([id, msgs]) => ({
        id,
        count: msgs.length,
        lastTs: msgs.length ? (msgs[msgs.length - 1].ts || 0) : 0
      })).sort((a, b) => b.lastTs - a.lastTs);
      sendJson(res, 200, { ok: true, conversations: list });
      return;
    }
    const convMatch = pathname.match(/^\/api\/conversations\/(.+)$/);
    if (convMatch) {
      const id = decodeURIComponent(convMatch[1]).trim();
      if (!id) { sendJson(res, 400, { ok: false, error: '缺少个体编号' }); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, id, messages: conversations.get(id) || [] });
        return;
      }
      if (req.method === 'POST') {
        const body = await parseJsonBody(req);
        const list = conversations.get(id) || [];
        const incoming = Array.isArray(body && body.messages) ? body.messages
          : (body && body.role ? [{ role: body.role, content: body.content }] : []);
        for (const m of incoming) {
          if (!m || !m.role) continue;
          list.push({ role: String(m.role), content: String(m.content || ''), ts: m.ts || now() });
        }
        while (list.length > 400) list.shift();
        conversations.set(id, list);
        saveConversations();
        sendJson(res, 200, { ok: true, id, count: list.length, messages: list });
        return;
      }
      if (req.method === 'DELETE') {
        conversations.delete(id);
        saveConversations();
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    // 7.95 市场行情
    if (req.method === 'GET' && pathname === '/api/market') {
      const date = MARKET.dayStr();
      const remote = await MARKET.fetchRemote((config.market && config.market.url) || '');
      const remoteMap = new Map((remote || []).map((r) => [r.name, r]));
      const list = SPECIES.map((sp) => {
        const p = MARKET.priceFor(sp.name, date);
        const r = remoteMap.get(sp.name);
        return {
          id: sp.id,
          name: sp.name,
          icon: sp.icon,
          unit: (r && r.unit) || p.unit,
          purchase: r ? r.purchase : p.purchase,
          sale: r ? r.sale : p.sale,
          change: r ? 0 : p.change,
          breeds: (sp.breeds || []).length
        };
      });
      sendJson(res, 200, {
        ok: true,
        date,
        source: remote ? '远程行情源' : '本地行情模型（示例数据）',
        updatedAt: now(),
        species: list
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/market/breeds') {
      const spName = new URL(req.url, 'http://x').searchParams.get('species') || '';
      const sp = SPECIES.find((s) => s.name === spName);
      if (!sp) { sendJson(res, 404, { ok: false, error: '物种不存在' }); return; }
      const date = MARKET.dayStr();
      const list = (sp.breeds || []).map((b) => {
        const p = MARKET.breedPrice(sp.name, b.name, date);
        return { name: b.name, unit: p.unit, purchase: p.purchase, sale: p.sale };
      });
      sendJson(res, 200, { ok: true, date, species: sp.name, breeds: list });
      return;
    }

    // 7.96 患病记录（本地文本）
    if (req.method === 'POST' && pathname === '/api/illness') {
      const body = await parseJsonBody(req);
      const rec = recordIllness(body);
      sendJson(res, 200, { ok: true, record: rec });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/illness') {
      sendJson(res, 200, { ok: true, records: listIllness() });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/real-knowledge') {
      sendJson(res, 200, Object.assign({ ok: true }, buildRealKnowledge()));
      return;
    }

    // 7.99 今日天气（Open-Meteo 免费接口）
    if (req.method === 'GET' && pathname === '/api/weather') {
      const cityParam = new URL(req.url, 'http://x').searchParams.get('city') || '';
      let lat = (config.weather && config.weather.lat) || 23.13;
      let lon = (config.weather && config.weather.lon) || 113.26;
      let city = process.env.WEATHER_CITY || (config.weather && config.weather.city) || '广州';
      try {
        if (cityParam) {
          // 先地理编码城市名
          const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
            encodeURIComponent(cityParam) + '&count=1&language=zh&format=json';
          const geoResp = await fetch(geoUrl);
          const geoData = await geoResp.json();
          const hit = geoData.results && geoData.results[0];
          if (hit) {
            lat = hit.latitude;
            lon = hit.longitude;
            city = hit.name || cityParam;
          } else {
            city = cityParam + '（未找到，使用默认地区）';
          }
        }
        const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
          '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,surface_pressure&timezone=Asia%2FShanghai';
        const resp = await fetch(u);
        const data = await resp.json();
        const cur = data.current || {};
        sendJson(res, 200, {
          ok: true,
          city,
          lat,
          lon,
          temperature: cur.temperature_2m,
          humidity: cur.relative_humidity_2m,
          wind: cur.wind_speed_10m,
          pressure: cur.surface_pressure,
          code: cur.weather_code,
          updatedAt: now()
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, city, error: '天气获取失败：' + e.message });
      }
      return;
    }

    // 7.97 健康预警分析（大模型）
    const healthMatch = pathname.match(/^\/api\/health\/([^/]+)$/);
    if (req.method === 'POST' && healthMatch) {
      const id = decodeURIComponent(healthMatch[1]);
      const dev = devices.get(id);
      if (!dev) { sendJson(res, 404, { ok: false, error: '设备不存在' }); return; }
      const prompt = buildHealthPrompt(dev);
      try {
        const reply = await handleCozeChat(prompt, [], []);
        const result = reply.ok ? (reply.reply && reply.reply.content) : (reply.error || '分析失败');
        let file = null;
        if (reply.ok && result) file = saveWarning(dev, result);
        sendJson(res, 200, { ok: reply.ok, result, warningFile: file });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '分析失败：' + e.message });
      }
      return;
    }

    // 7.98 预警记录查询
    if (req.method === 'GET' && pathname === '/api/warnings') {
      let files = [];
      try {
        if (fs.existsSync(WARNING_DIR)) files = fs.readdirSync(WARNING_DIR).filter((f) => f.endsWith('.txt')).sort().reverse();
      } catch (e) {}
      sendJson(res, 200, { ok: true, files });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/warnings/file') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      const safe = path.basename(name);
      const fp = path.join(WARNING_DIR, safe);
      if (!safe || !fp.startsWith(WARNING_DIR) || !fs.existsSync(fp)) { sendJson(res, 404, { ok: false, error: '文件不存在' }); return; }
      sendJson(res, 200, { ok: true, name: safe, content: fs.readFileSync(fp, 'utf8') });
      return;
    }
    if (req.method === 'DELETE' && pathname === '/api/warnings/file') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      const safe = path.basename(name);
      const fp = path.join(WARNING_DIR, safe);
      if (!safe || !fp.startsWith(WARNING_DIR) || !fs.existsSync(fp)) { sendJson(res, 404, { ok: false, error: '文件不存在' }); return; }
      try { fs.unlinkSync(fp); } catch (e) { sendJson(res, 500, { ok: false, error: '删除失败' }); return; }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/warnings') {
      const body = await parseJsonBody(req);
      const content = String((body && body.content) || '').trim();
      const device = String((body && body.device) || '手动记录');
      if (!content) { sendJson(res, 400, { ok: false, error: '内容不能为空' }); return; }
      const fname = saveWarning({ name: device, id: '' }, content);
      sendJson(res, 200, { ok: true, file: fname });
      return;
    }
    // 删除患病记录
    const illnessDel = pathname.match(/^\/api\/illness\/([^/]+)$/);
    if (req.method === 'DELETE' && illnessDel) {
      const iid = decodeURIComponent(illnessDel[1]);
      const before = illnessRecords.length;
      illnessRecords = illnessRecords.filter((r) => r.id !== iid);
      if (illnessRecords.length === before) { sendJson(res, 404, { ok: false, error: '记录不存在' }); return; }
      saveIllness();
      sendJson(res, 200, { ok: true });
      return;
    }

    // 8. 智能体聊天接口
    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await parseJsonBody(req);
      const message = (body && (body.message || body.text || body.prompt)) || '';
      const images = (body && Array.isArray(body.images)) ? body.images : [];
      if (!String(message).trim() && images.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少 message 或图片' });
        return;
      }
      const reply = await handleChat(body);
      sendJson(res, 200, reply);
      return;
    }

    // 8. 登录校验
    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await parseJsonBody(req);
      const u = String(body && (body.username || body.user) || '');
      const p = String(body && (body.password || body.pwd) || '');
      if (u === AUTH.username && p === AUTH.password) {
        sendJson(res, 200, { ok: true, token: 'farm-session-' + Date.now() });
      } else {
        sendJson(res, 401, { ok: false, error: '账号或密码错误' });
      }
      return;
    }

    // 8.1 摄像头：接收实时画面帧
    const camMatch = pathname.match(/^\/api\/camera\/([^/]+)$/);
    if (req.method === 'POST' && camMatch) {
      const id = decodeURIComponent(camMatch[1]);
      const body = await parseJsonBody(req);
      const data = (body && (body.data || body.base64 || body.frame)) || '';
      if (!data) { sendJson(res, 400, { ok: false, error: '缺少画面数据' }); return; }
      const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
      const prev = cameraFrames.get(id);
      cameraFrames.set(id, { buf, ts: now(), prevBuf: prev ? prev.buf : null, prevTs: prev ? prev.ts : 0 });
      broadcast('camera-frame', { id, ts: now() });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && camMatch) {
      const id = decodeURIComponent(camMatch[1]);
      const f = cameraFrames.get(id);
      if (!f) { sendJson(res, 404, { ok: false, error: '暂无画面' }); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(f.buf);
      return;
    }

    // 8.2 摄像头：AI 识别预警
    const recMatch = pathname.match(/^\/api\/camera\/([^/]+)\/recognize$/);
    if (req.method === 'POST' && recMatch) {
      const id = decodeURIComponent(recMatch[1]);
      const f = cameraFrames.get(id);
      if (!f) { sendJson(res, 400, { ok: false, error: '暂无画面，无法识别' }); return; }
      const last = lastRecognize.get(id) || 0;
      if (now() - last < 10000) {
        sendJson(res, 200, { ok: true, throttled: true, result: '识别过于频繁，请稍候…' });
        return;
      }
      lastRecognize.set(id, now());
      try {
        const images = [];
        if (f.prevBuf) images.push(await uploadToCoze(f.prevBuf, 'frame_prev.jpg'));
        images.push(await uploadToCoze(f.buf, 'frame_now.jpg'));
        const prompt = '这是养殖监控的连续两帧画面（相隔约1秒）。请严格按以下格式回答：\n第一行只写「数量：X」（X 为画面中动物总数，阿拉伯数字，不要写其他内容）；\n然后识别动物种类（鸡/鸭/鹅/猪/牛/羊等）；\n然后对比两帧判断动物是否移动、移动快慢；\n如有动物长时间静止不动（可能生病、死亡或异常），请明确预警。';
        const reply = await handleCozeChat(prompt, [], images);
        const content = reply.ok ? (reply.reply && reply.reply.content) : (reply.error || '识别失败');
        // 解析 AI 返回的数量，写入设备（供页面与智能体使用）
        let detected = null;
        const dm = String(content || '').match(/(?:数量|总数|共计|共)\s*[:：]?\s*(\d+)/);
        if (dm) detected = Number(dm[1]);
        if (detected != null && devices.has(id)) {
          const dev = devices.get(id);
          dev.latest = dev.latest || {};
          dev.latest.camera_count = detected;
          markDirty();
          broadcast('device-update', deviceSummary(dev));
        }
        sendJson(res, 200, { ok: reply.ok, result: content, detectedCount: detected });
      } catch (e) {
        console.error('[识别] 失败：', e.message);
        sendJson(res, 500, { ok: false, error: '识别失败：' + e.message });
      }
      return;
    }

    // 9. 物种知识库
    if (req.method === 'GET' && pathname === '/api/species') {
      sendJson(res, 200, { ok: true, species: SPECIES });
      return;
    }

    // 8.5 数据分析（异常识别 + 正常值对比 + 结论）
    if (req.method === 'GET' && pathname === '/api/analysis') {
      const results = [...devices.values()].map(analyzeDevice);
      const alerts = [];
      for (const r of results) {
        for (const a of r.anomalies) {
          alerts.push({ deviceId: r.id, device: r.name, species: r.species, key: a.key, label: a.label, value: a.value, unit: a.unit, normal: a.normal, status: a.status });
        }
      }
      sendJson(res, 200, { ok: true, results, alerts, alertCount: alerts.length });
      return;
    }

    // 9. 公开配置（不含密钥）
    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, {
        ok: true,
        agentConnected: Boolean(AGENT.apiUrl || (AGENT.type === 'coze' && AGENT.botId)),
        thresholds: THRESHOLDS,
        offlineAfterMs: OFFLINE_AFTER_MS
      });
      return;
    }

    // 9. 健康检查
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), devices: devices.size });
      return;
    }

    // 10. 静态文件
    if (req.method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (e) {
    console.error('[请求错误]', req.method, req.url, e.message);
    sendJson(res, e.status || 500, { ok: false, error: e.message || '服务器内部错误' });
  }
});

// 智能体
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 生成当前环境数据摘要，供智能体判断病因
function buildEnvironmentContext() {
  const list = [...devices.values()].filter(
    (d) => d.latest && Object.keys(d.latest).some((k) => k !== 'time')
  );
  if (list.length === 0) return '';

  const lines = [];
  for (const d of list) {
    const l = d.latest;
    const parts = [];
    if (l.temperature !== undefined) parts.push(`温度 ${l.temperature}°C`);
    if (l.humidity !== undefined) parts.push(`湿度 ${l.humidity}%`);
    if (l.soil !== undefined) parts.push(`土壤湿度 ${l.soil}%`);
    if (l.water !== undefined) parts.push(`水位 ${l.water}%`);
    if (l.light !== undefined) parts.push(`光照 ${l.light}%`);
    if (l.flame !== undefined) parts.push(l.flame === 1 ? '火焰：⚠️有火情' : '火焰：安全');
    if (l.co2 !== undefined) parts.push(`二氧化碳 ${l.co2}ppm`);
    if (l.h2s !== undefined) parts.push(`硫化氢 ${l.h2s}ppm`);
    if (l.wind !== undefined) parts.push(`风速 ${l.wind}m/s`);
    if (l.pressure !== undefined) parts.push(`气压 ${l.pressure}hPa`);
    if (l.rain !== undefined) parts.push(`降雨${l.rain}mm`);
    if (l.pm25 !== undefined) parts.push(`PM2.5 ${l.pm25}μg/m³`);
    if (l.noise !== undefined) parts.push(`噪声 ${l.noise}dB`);
    if (l.o2 !== undefined) parts.push(`氧气 ${l.o2}%`);
    if (l.soil_temp !== undefined) parts.push(`土壤温度 ${l.soil_temp}°C`);
    if (l.feed_level !== undefined) parts.push(`饲料槽余量 ${l.feed_level}%`);
    if (l.feed_weight !== undefined) parts.push(`饲料槽重量 ${l.feed_weight}kg`);
    if (l.feed_activity !== undefined) parts.push(`进食活动 ${l.feed_activity}`);
    if (l.camera_count !== undefined) parts.push(`摄像头识别数量 ${l.camera_count} 只`);
    const dinfo = densityInfo(d);
    if (dinfo.actual != null) {
      const ref = dinfo.ref ? `，参考 ${dinfo.ref.min}~${dinfo.ref.max} 只/㎡` : '';
      parts.push(`种群密度 ${dinfo.actual} 只/㎡${ref}`);
    }
    if (d.meta && d.meta.stage) parts.push('成长阶段 ' + d.meta.stage);
    if (d.meta && d.meta.weight) parts.push('体重 ' + d.meta.weight + 'kg');
    const online = (Date.now() - (d.lastSeen || 0)) < OFFLINE_AFTER_MS ? '在线' : '离线';
    if (parts.length) lines.push(`· ${d.name || d.id}（${online}）：${parts.join('，')}`);
  }
  return lines.length ? lines.join('\n') : '';
}

// 生成养殖对象（物种）的正常环境/饮食/患病因子摘要
function buildSpeciesContext() {
  const speciesSet = new Set();
  for (const d of devices.values()) {
    const s = d.meta && d.meta.species;
    if (s) speciesSet.add(s);
  }
  if (speciesSet.size === 0) return '';

  const labels = { temperature: '温度', humidity: '湿度', ammonia: '氨气', soil: '土壤湿度', water: '水位', light: '光照' };
  const parts = [];
  for (const name of speciesSet) {
    const sp = SPECIES.find((s) => s.name === name);
    if (!sp) continue;
    const norm = Object.entries(sp.normal || {})
      .map(([k, r]) => `${labels[k] || k} ${r.min}~${r.max}${r.unit}`)
      .join('，');
    const diseases = (sp.diseases || []).map((d) => `${d.name}（症状：${d.symptoms}；诱因：${d.factors}）`).join('；');
    const extra = [];
    if (sp.density) extra.push('养殖密度：' + sp.density);
    if (sp.ventilation) extra.push('通风：' + sp.ventilation);
    if (sp.lighting) extra.push('光照：' + sp.lighting);
    if (sp.water) extra.push('饮水：' + sp.water);
    if (sp.immunity) extra.push('免疫：' + sp.immunity);
    if (sp.hygiene) extra.push('卫生消毒：' + sp.hygiene);
    if (sp.mistakes) extra.push('常见误区：' + sp.mistakes);
    const breedCount = (sp.breeds || []).length;
    const breedNames = (sp.breeds || []).slice(0, 8).map((b) => b.name).join('、');
    parts.push(`【${sp.name}】正常环境：${norm}。环境要求：${sp.environment} 饮食：${sp.diet} ${extra.join(' ')} 常见疫病与诱因：${diseases} 该物种含 ${breedCount} 个品种（如 ${breedNames} 等），请结合品种特性与实时数据综合判断。`);
  }
  return parts.join('\n');
}
function analyzeDevice(device) {
  const summary = deviceSummary(device);
  const latest = device.latest || {};
  const species = SPECIES.find((s) => s.name === summary.meta.species);
  const anomalies = [];
  const comparisons = [];

  const defs = [
    { key: 'temperature', label: '温度', unit: '°C' },
    { key: 'humidity', label: '湿度', unit: '%' },
    { key: 'ammonia', label: '氨气', unit: 'ppm' },
    { key: 'soil', label: '土壤湿度', unit: '%' },
    { key: 'water', label: '水位', unit: '%' },
    { key: 'light', label: '光照', unit: '%' },
    { key: 'flame', label: '火焰', unit: '' },
    { key: 'co2', label: '二氧化碳', unit: 'ppm' },
    { key: 'h2s', label: '硫化氢', unit: 'ppm' },
    { key: 'wind', label: '风速', unit: 'm/s' },
    { key: 'pressure', label: '气压', unit: 'hPa' },
    { key: 'rain', label: '降雨量', unit: 'mm' },
    { key: 'pm25', label: 'PM2.5', unit: 'μg/m³' },
    { key: 'noise', label: '噪声', unit: 'dB' },
    { key: 'o2', label: '氧气', unit: '%' },
    { key: 'soil_temp', label: '土壤温度', unit: '°C' },
    { key: 'feed_level', label: '饲料槽余量', unit: '%' },
    { key: 'feed_weight', label: '饲料槽重量', unit: 'kg' },
    { key: 'feed_activity', label: '进食活动', unit: '' }
  ];

  for (const def of defs) {
    const v = latest[def.key];
    if (v === undefined) continue;
    let status = evaluateMetric(def.key, v);   // 全局阈值判断
    const entry = { key: def.key, label: def.label, value: v, unit: def.unit, status };
    const normal = normalFor(species && species.name, def.key);
    if (normal) {
      entry.normal = { min: normal.min, max: normal.max };
      if (v < normal.min) status = 'low';
      else if (v > normal.max) status = 'high';
      else status = 'normal';
      entry.status = status;
    }
    comparisons.push(entry);
    if (status !== 'normal') anomalies.push(entry);
  }

  // 种群密度（数量 / 面积，与物种参考密度对比）
  const dinfo = densityInfo(device);
  if (dinfo.actual != null) {
    const entry = {
      key: 'density', label: '种群密度', value: dinfo.actual, unit: '只/㎡',
      status: dinfo.status === 'unknown' ? 'normal' : dinfo.status,
      note: dinfo.refText
    };
    if (dinfo.ref) entry.normal = { min: dinfo.ref.min, max: dinfo.ref.max };
    comparisons.push(entry);
    if (entry.status !== 'normal') anomalies.push(entry);
  }

  let conclusion;
  if (anomalies.length === 0) {
    conclusion = species
      ? `${summary.name}：各项环境指标均在 ${species.name} 的正常范围内，环境良好。`
      : `${summary.name}：环境正常。`;
  } else {
    const parts = anomalies.map((a) => {
      const norm = a.normal ? `（正常 ${a.normal.min}~${a.normal.max}${a.unit}）` : '';
      const dir = a.status === 'high' ? '偏高' : '偏低';
      return `${a.label} ${a.value}${a.unit}${norm} ${dir}`;
    });
    conclusion = `${summary.name}：存在 ${anomalies.length} 项环境异常——${parts.join('；')}。请排查通风、温控、湿度与卫生状况，避免诱发疫病。`;
  }

  return { id: summary.id, name: summary.name, species: summary.meta.species, anomalies, comparisons, conclusion };
}

// 将扣子的多模态内容（object_string）转成可显示的 markdown
function cozeContentToMarkdown(content, contentType) {
  if (contentType !== 'object_string') return String(content);
  try {
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return String(content);
    const parts = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && item.text) {
        parts.push(item.text);
      } else if (item.type === 'image') {
        if (item.file_url) parts.push(`![图片](${item.file_url})`);
        // 仅 file_id 的图片无法直接公开展示（需账号授权），这里跳过
      }
    }
    return parts.join('\n');
  } catch (e) {
    return String(content);
  }
}

// 上传图片到扣子，返回 file_id
async function uploadToCoze(buffer, filename) {
  const baseUrl = AGENT.baseUrl || 'https://api.coze.cn';
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(baseUrl + '/v1/files/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (AGENT.apiKey || AGENT.token || '') },
      body: form,
      signal: ctrl.signal
    });
    const data = await resp.json();
    if (!data || data.code !== 0) {
      throw new Error((data && (data.msg || data.code)) || '上传失败');
    }
    return data.data && data.data.id;
  } finally {
    clearTimeout(timer);
  }
}

async function handleChat(body) {
  const message = String(body.message || body.text || body.prompt || '');
  const individualId = String((body && body.individualId) || '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const images = Array.isArray(body.images) ? body.images : [];

  // 个体档案：若指定编号且已有记录，载入该个体最近 20 条对话作为上下文
  let hist = history;
  if (individualId && conversations.has(individualId)) {
    hist = (conversations.get(individualId) || []).slice(-20)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  }

  // 对话规则：信息不全时先提问，避免臆测
  const rules = [
    '【工作规则】',
    '1. 如果用户提供的信息不完整（缺少物种/品种、日龄、症状、持续时间、环境数据等关键信息），请先暂停分析，用简洁的问题向用户询问缺失的信息；得到补充后再继续，绝不编造或假设。',
    '2. 回答先给结论，再给依据，最后给具体处置建议，分点简洁。',
    '3. 必须结合实时环境数据和物种知识库判断。',
    '4. 必须优先参考该个体的既往病史；如果是复诊，请说明与上次相比的变化（好转/恶化/无变化）。',
    '5. 给出治疗方案后，提醒用户：等个体好转后回来告知，以便记录疗效、更新档案。'
  ].join('\n');
  const profile = individualId ? `【当前个体档案】${individualId}\n` : '';
  const historySummary = hist.length
    ? '【该个体既往记录（请优先参考）】\n' + hist
        .map((m) => (m.role === 'user' ? '主人：' : '兽医：') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 160))
        .join('\n') + '\n\n'
    : '';
  const fullMessage = rules + '\n' + profile + historySummary + message;

  // 扣子（Coze）智能体
  if (AGENT.type === 'coze' && AGENT.botId) {
    return await handleCozeChat(fullMessage, hist, images);
  }

  // 已配置外部智能体：转发请求
  if (AGENT.apiUrl) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (AGENT.apiKey) headers['Authorization'] = `Bearer ${AGENT.apiKey}`;

      const resp = await fetchAgent(AGENT.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, history })
      });
      const data = await resp.json().catch(() => null);
      if (data && typeof data === 'object') return { ok: true, reply: data, from: 'agent' };
      return { ok: true, reply: { role: 'assistant', content: String(data) }, from: 'agent' };
    } catch (e) {
      console.error('[智能体] 转发失败：', e.message);
      return { ok: false, error: '智能体接口调用失败：' + e.message, from: 'agent' };
    }
  }

  // 未配置：返回占位回复
  return {
    ok: true,
    from: 'placeholder',
    reply: {
      role: 'assistant',
      content: '【智能体占位回复】\n\n这里是预留的智能体聊天区。接入扣子（Coze）智能体：在 config.json 里把 agent.type 设为 "coze"，并填上 botId 和 apiKey。\n\n你可以先问我：\n· 鸡出现精神萎靡、拉稀，可能是什么病？\n· 猪圈温度过高会有什么影响？'
    }
  };
}

// 扣子（Coze）智能体：流式对话，解析 SSE 取回复
async function handleCozeChat(message, history, images) {
  const baseUrl = AGENT.baseUrl || 'https://api.coze.cn';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (AGENT.apiKey || AGENT.token || '')
  };

  // 组装消息（历史 + 本次）
  const msgs = [];
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const c = String(h.content || h.text || '');
    if (c.trim()) msgs.push({ role, content: c, content_type: 'text' });
  }

  // 注入当前环境数据 + 养殖对象患病因子，让智能体结合实时环境判断病因
  const envCtx = buildEnvironmentContext();
  const speciesCtx = buildSpeciesContext();
  const realCtx = buildRealKnowledgeContext();
  let contextBlock = '';
  if (envCtx) contextBlock += `【当前养殖环境实时数据】\n${envCtx}\n\n`;
  if (speciesCtx) contextBlock += `【养殖对象与患病因子】\n${speciesCtx}\n\n`;
  if (realCtx) contextBlock += `${realCtx}\n\n`;
  const questionText = contextBlock
    ? `${contextBlock}【用户问题】${message}\n\n请结合以上实时环境数据与养殖对象信息，辅助判断家禽家畜的病因。`
    : message;

  // 本次消息：有图片用 object_string（多模态），否则纯文本
  if (images && images.length > 0) {
    const objs = [];
    if (questionText.trim()) objs.push({ type: 'text', text: questionText });
    for (const id of images) {
      if (id) objs.push({ type: 'image', file_id: String(id) });
    }
    msgs.push({ role: 'user', content: JSON.stringify(objs), content_type: 'object_string' });
  } else {
    msgs.push({ role: 'user', content: questionText, content_type: 'text' });
  }

  try {
    const resp = await fetchAgent(baseUrl + '/v3/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bot_id: AGENT.botId,
        user_id: AGENT.userId || 'web-user',
        stream: true,             // 流式（auto_save_history=false 时必须是 true）
        auto_save_history: false,
        additional_messages: msgs
      })
    });

    const text = await resp.text();

    // 非流式错误会返回 JSON
    if (text.trim().startsWith('{')) {
      let errData;
      try { errData = JSON.parse(text); } catch (e) { errData = null; }
      const err = (errData && (errData.msg || errData.code)) || '未知错误';
      return { ok: false, error: '扣子接口返回错误：' + err, from: 'coze' };
    }

    // 解析 SSE：event 名在单独一行，data 在下一行
    let answer = '';
    let currentEvent = '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('event:')) {
        currentEvent = t.slice(6).trim();
      } else if (t.startsWith('data:')) {
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const ev = JSON.parse(payload);
          if (currentEvent === 'conversation.message.delta' && ev && typeof ev.content === 'string' && ev.content && ev.content_type === 'text') {
            answer += ev.content;
          } else if (currentEvent === 'conversation.message.completed' && ev && ev.type === 'answer' && ev.content) {
            answer = cozeContentToMarkdown(ev.content, ev.content_type);   // 完整答案，覆盖累加结果
          }
        } catch (e) { /* 跳过无法解析的行 */ }
      }
    }

    if (!answer.trim()) answer = '（未收到回复）';
    return { ok: true, from: 'coze', reply: { role: 'assistant', content: answer } };
  } catch (e) {
    console.error('[扣子] 调用失败：', e.message);
    return { ok: false, error: '扣子接口调用失败：' + e.message, from: 'coze' };
  }
}

function fetchAgent(url, options) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(u, { method: options.method, headers: options.headers, timeout: AGENT.timeoutMs || 30000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch (e) {
          body = raw;
        }
        resolve({
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(raw),
          status: res.statusCode
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// 启动
loadDevices();
loadConversations();
loadIllness();
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  养殖环境实时监测系统已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  console.log('  局域网访问: http://' + HOST + ':' + PORT);
  console.log('----------------------------------------------------');
  console.log('  ESP32 上报接口:  POST http://<本机IP>:' + PORT + '/api/data');
  console.log('  多设备区分:      通过 URL 路径 /api/data/<设备ID>、');
  console.log('                    查询参数 ?device=<设备ID>、');
  console.log('                    或 JSON 里的 device_id 字段');
  console.log('  智能体接口:      POST http://<本机IP>:' + PORT + '/api/chat');
  console.log('====================================================');
});

// 定时检查离线状态并推送（每 30 秒）
setInterval(() => {
  const changed = [];
  for (const d of devices.values()) {
    if (now() - d.lastSeen >= OFFLINE_AFTER_MS && d._onlineFlag !== false) {
      d._onlineFlag = false;
      changed.push(deviceSummary(d));
    } else if (now() - d.lastSeen < OFFLINE_AFTER_MS && d._onlineFlag !== true) {
      d._onlineFlag = true;
      changed.push(deviceSummary(d));
    }
  }
  if (changed.length) broadcast('device-status', { devices: changed });
}, 30000);
