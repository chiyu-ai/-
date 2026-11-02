'use strict';

// 市场行情模块
// 说明：真实的畜禽价格数据需要接入第三方市场接口（各网站格式不一、多有反爬）。
// 本模块提供：
//   1) 可配置的实时数据源（config.market.url，返回 JSON 数组/对象时自动采用）
//   2) 无真实源时，使用「按日期确定性变化」的本地行情模型（同一天同一物种价格固定，逐日波动）

const fs = require('fs');

// 物种基准价与单位（元）
const BASE = {
  '鸡': { price: 12, unit: '元/斤' },
  '鸭': { price: 11, unit: '元/斤' },
  '鹅': { price: 22, unit: '元/斤' },
  '鸽': { price: 18, unit: '元/只' },
  '鹌鹑': { price: 8, unit: '元/只' },
  '猪': { price: 16, unit: '元/斤' },
  '牛': { price: 32, unit: '元/斤' },
  '羊': { price: 28, unit: '元/斤' },
  '兔': { price: 14, unit: '元/斤' },
  '马': { price: 8000, unit: '元/匹' },
  '驴': { price: 6000, unit: '元/头' },
  '鹿': { price: 5000, unit: '元/头' },
  '犬': { price: 800, unit: '元/只' },
  '猫': { price: 600, unit: '元/只' },
  '鸟': { price: 60, unit: '元/只' },
  '淡水鱼': { price: 8, unit: '元/斤' },
  '海水鱼': { price: 25, unit: '元/斤' },
  '蜜蜂': { price: 300, unit: '元/箱' },
  '蚕': { price: 40, unit: '元/公斤' },
  '骆驼': { price: 15000, unit: '元/峰' },
  '火鸡': { price: 20, unit: '元/斤' },
  '鸵鸟': { price: 2000, unit: '元/只' },
  '蛙': { price: 15, unit: '元/斤' },
  '蟹': { price: 40, unit: '元/斤' },
  '虾': { price: 30, unit: '元/斤' },
  '龟': { price: 100, unit: '元/只' },
  '蚯蚓': { price: 10, unit: '元/斤' },
  '观赏鱼': { price: 5, unit: '元/条' },
  '毛皮动物': { price: 300, unit: '元/只' },
  '蜗牛': { price: 12, unit: '元/斤' },
  '雉鸡野禽': { price: 50, unit: '元/只' },
  '竹鼠': { price: 80, unit: '元/斤' },
  '鹧鸪': { price: 15, unit: '元/只' },
  '鸸鹋': { price: 1500, unit: '元/只' }
};

function hash(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function round(n) {
  if (n >= 1000) return Math.round(n);
  if (n >= 100) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

function dayStr(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}

// 按日期确定性生成某物种当日价格
function priceFor(speciesName, date) {
  const base = BASE[speciesName] || { price: 20, unit: '元/斤' };
  const seed = hash(date + '|' + speciesName);
  const r1 = (seed % 10000) / 10000;
  const r2 = (hash('sale|' + date + '|' + speciesName) % 10000) / 10000;
  // 收购价相对基准 ±6% 波动，出售价在收购价基础上加 8%~15%
  const change = (r1 - 0.5) * 0.12;
  const purchase = base.price * (1 + change);
  const sale = purchase * (1 + 0.08 + r2 * 0.07);
  return {
    unit: base.unit,
    purchase: round(purchase),
    sale: round(sale),
    change: Math.round(change * 10000) / 100
  };
}

// 品种价格：在所属物种当日价格基础上，按品种名做小幅溢价/折价
function breedPrice(speciesName, breedName, date) {
  const p = priceFor(speciesName, date);
  const seed = hash('breed|' + date + '|' + breedName);
  const factor = 0.9 + (seed % 1000) / 1000 * 0.25; // 0.90 ~ 1.15
  return {
    unit: p.unit,
    purchase: round(p.purchase * factor),
    sale: round(p.sale * factor)
  };
}

// 尝试从配置的真实数据源获取（JSON）
async function fetchRemote(url) {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    // 支持 { data: [...] } 或直接数组
    const list = Array.isArray(data) ? data : (Array.isArray(data && data.data) ? data.data : null);
    if (!list) return null;
    return list.map((it) => ({
      name: String(it.name || it.species || ''),
      purchase: Number(it.purchase || it.buy || it.price || 0),
      sale: Number(it.sale || it.sell || it.price || 0),
      unit: String(it.unit || '元/斤')
    })).filter((x) => x.name);
  } catch (e) {
    return null;
  }
}

module.exports = { BASE, priceFor, breedPrice, fetchRemote, dayStr };
