'use strict';
/**
 * 合成升贴水率历史序列
 *
 *   合成年化升贴水率(t) = 0.6 × 次月年化(t) + 0.4 × 当季年化(t)
 *   年化(t, 合约)      = (S(t) − P(t)) / P(t) × 365 / 剩余天数(t) × 100
 *   剩余天数(t)        = 交割日(到期月第三个周五) − t + 1（自然日）
 *
 * 历史逐日使用「当日实际的次月 / 当季」合约收盘价重建（随时间移仓换月），
 * 已到期合约的日线磁盘永久缓存，仅在市合约每次短暂缓存后刷新。
 * 数据源：新浪财经日线（与 lib/history.js 相同通道）。
 */

const fs = require('fs');
const path = require('path');
const { httpGet, HEADERS } = require('./quotes');
const { contractMonths, currentTradingMonth, thirdFriday, remainingDays, shanghaiToday } = require('./basis');

const IDX_KLINE = (symbol, len) =>
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' +
  symbol + '&scale=240&ma=no&datalen=' + len;
const FUT_KLINE = (symbol) =>
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/InnerFuturesNewService.getDailyKLine?symbol=' + symbol;

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONTRACT_DIR = path.join(DATA_DIR, 'contracts');
const ACTIVE_TTL_MS = 10 * 60 * 1000; // 在市合约缓存 10 分钟

const pad2 = (n) => String(n).padStart(2, '0');
const ymLabel = (c) => String(c.y).slice(2) + pad2(c.m);

function ensureDirs() {
  try { fs.mkdirSync(CONTRACT_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

/** 简单并发池：失败项返回 null，不中断整体 */
async function pool(items, n, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { ret[idx] = await fn(items[idx], idx); } catch (e) { ret[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return ret;
}

function pickJsonArray(text, wantJsonp) {
  let s = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (wantJsonp) {
    const a = s.indexOf('(');
    const b = s.lastIndexOf(')');
    if (a < 0 || b < 0) throw new Error('无法解析日线数据（JSONP 包裹缺失）');
    s = s.slice(a + 1, b);
  }
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error('无法解析日线数据（未找到数组）');
  return JSON.parse(s.slice(start, end + 1));
}

async function fetchIndexDailyMap(symbol, len) {
  const text = await httpGet(IDX_KLINE(symbol, len), HEADERS, 15000);
  const arr = pickJsonArray(text, false);
  const map = {};
  arr.forEach((r) => { if (r && r.day) map[String(r.day).slice(0, 10)] = Number(r.close); });
  return map;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 抓取单合约日线，返回 { date: close }。
 * 已到期合约 → 磁盘永久缓存；在市合约 → 磁盘缓存 ACTIVE_TTL_MS。
 * 新浪对突发并发有限流，失败按退避重试。
 */
async function fetchContractDaily(prefix, y, m, todayIso) {
  ensureDirs();
  const label = prefix + ymLabel({ y, m });
  const file = path.join(CONTRACT_DIR, label + '.json');
  const delivery = thirdFriday(y, m, []);
  const deliveryIso = delivery.y + '-' + pad2(delivery.m) + '-' + pad2(delivery.d);
  const delivered = deliveryIso < todayIso;

  if (fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const fresh = delivered || (Date.now() - (j.savedAt || 0) < ACTIVE_TTL_MS);
      if (fresh && j.rows) return j.rows;
    } catch (e) { /* 重抓 */ }
  }

  let rows = null;
  const backoffs = [200, 700, 1500, 2500];
  for (let attempt = 0; attempt < backoffs.length && !rows; attempt++) {
    if (attempt) await sleep(backoffs[attempt - 1]);
    try {
      const text = await httpGet(FUT_KLINE(label), HEADERS, 15000);
      const arr = pickJsonArray(text, true);
      rows = {};
      arr.forEach((r) => { if (r && r.d && r.c != null) rows[String(r.d).slice(0, 10)] = Number(r.c); });
      if (!Object.keys(rows).length) rows = null;
    } catch (e) { /* 重试 */ }
  }
  if (!rows) return null;
  try { fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), delivery: deliveryIso, rows })); } catch (e) { /* ignore */ }
  return rows;
}

/** [startIso, endIso] 区间内逐日所需的「次月 / 当季」合约标签集合 */
function neededLabels(startIso, endIso) {
  const a = startIso.split('-').map(Number);
  const b = endIso.split('-').map(Number);
  const startMi = a[0] * 12 + (a[1] - 1); // 0 基月份索引
  const endMi = b[0] * 12 + (b[1] - 1) + 1; // 多含一个月，覆盖月末相邻换月
  const set = new Set();
  for (let mi = startMi; mi <= endMi; mi++) {
    const y = Math.floor(mi / 12);
    const m = (mi % 12) + 1;
    const cm = contractMonths(y, m);
    set.add(ymLabel(cm.nxt));
    set.add(ymLabel(cm.q1));
  }
  return Array.from(set);
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] !== undefined) {
    return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
  }
  return sortedAsc[base];
}

function percentileOf(sortedAsc, x) {
  if (!sortedAsc.length) return null;
  let cnt = 0;
  for (let i = 0; i < sortedAsc.length; i++) if (sortedAsc[i] <= x) cnt++;
  return (cnt / sortedAsc.length) * 100;
}

const r2 = (v) => (v == null || !isFinite(v) ? null : Number(v.toFixed(2)));
const r3 = (v) => (v == null || !isFinite(v) ? null : Number(v.toFixed(3)));

/**
 * 构建单品种合成升贴水率历史序列
 * @param {object} p { key, klineSymbol }  klineSymbol 如 'sh000300'
 * @param {number} days 自然日回溯窗口
 */
async function buildSynthSeries(p, days, holidays) {
  const today = shanghaiToday();
  const todayIso = today.y + '-' + pad2(today.m) + '-' + pad2(today.d);

  const startMs = Date.now() - days * 86400000;
  const sd = new Date(startMs + 8 * 3600 * 1000);
  let startIso = sd.getUTCFullYear() + '-' + pad2(sd.getUTCMonth() + 1) + '-' + pad2(sd.getUTCDate());
  // 各品种上市月份之前没有合约日线，避免无谓请求
  const LAUNCH = { IF: '2010-04-01', IH: '2015-04-01', IC: '2015-04-01', IM: '2022-07-01' };
  if (LAUNCH[p.key] && startIso < LAUNCH[p.key]) startIso = LAUNCH[p.key];

  const labels = neededLabels(startIso, todayIso);
  const ymOf = (lb) => ({ y: 2000 + Number(lb.slice(0, 2)), m: Number(lb.slice(2, 4)) });

  async function fetchAll(list, concurrency) {
    const maps = await pool(list, concurrency, async (lb) => {
      const c = ymOf(lb);
      return fetchContractDaily(p.key, c.y, c.m, todayIso);
    });
    const map = {};
    list.forEach((lb, i) => { if (maps[i]) map[lb] = maps[i]; });
    return map;
  }

  let cmap = await fetchAll(labels, 4);
  // 限流漏抓的标签串行补抓一轮
  const missing = labels.filter((lb) => !cmap[lb]);
  if (missing.length) {
    console.warn('[synth] 补抓缺失合约:', p.key, missing.join(','));
    const extra = await fetchAll(missing, 1);
    Object.assign(cmap, extra);
  }

  const idxLen = Math.min(6000, Math.ceil((days / 365) * 270) + 80);
  const idxMap = await fetchIndexDailyMap(p.klineSymbol, idxLen);

  const dates = Object.keys(idxMap).filter((d) => d >= startIso && d <= todayIso).sort();

  const out = { dates: [], synth: [], nm: [], cq: [], index: [] };
  dates.forEach((d) => {
    const ymd = d.split('-').map(Number);
    // 当日点按交易所规则滚动（已越过本月第三个周五则当月→下月），与实时卡片口径一致
    const baseMonth = (d === todayIso) ? currentTradingMonth(Date.now(), holidays) : { y: ymd[0], m: ymd[1] };
    const cm = contractMonths(baseMonth.y, baseMonth.m);
    const nxLb = ymLabel(cm.nxt), q1Lb = ymLabel(cm.q1);
    const nxMap = cmap[nxLb], q1Map = cmap[q1Lb];
    const Pn = nxMap ? nxMap[d] : null;
    const Pq = q1Map ? q1Map[d] : null;
    const S = idxMap[d];
    if (!Pn || !Pq || !S) return;

    const dnx = thirdFriday(cm.nxt.y, cm.nxt.m, holidays || []);
    const dq1 = thirdFriday(cm.q1.y, cm.q1.m, holidays || []);
    const remN = remainingDays(dnx, { y: ymd[0], m: ymd[1], d: ymd[2] });
    const remQ = remainingDays(dq1, { y: ymd[0], m: ymd[1], d: ymd[2] });
    if (remN <= 0 || remQ <= 0) return;

    const annN = ((S - Pn) / Pn) * (365 / remN) * 100;
    const annQ = ((S - Pq) / Pq) * (365 / remQ) * 100;
    const synth = 0.6 * annN + 0.4 * annQ;

    out.dates.push(d);
    out.synth.push(r3(synth));
    out.nm.push(r3(annN));
    out.cq.push(r3(annQ));
    out.index.push(r2(S));
  });

  const sorted = out.synth.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : null;
  let std = null;
  if (n) {
    const variance = sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    std = Math.sqrt(variance);
  }
  const lastSynth = n ? out.synth[n - 1] : null;

  const stats = {
    count: n,
    min: n ? sorted[0] : null,
    max: n ? sorted[n - 1] : null,
    mean: r2(mean),
    std: r2(std),
    p10: r2(quantile(sorted, 0.1)),
    p30: r2(quantile(sorted, 0.3)),
    p50: r2(quantile(sorted, 0.5)),
    p70: r2(quantile(sorted, 0.7)),
    p90: r2(quantile(sorted, 0.9)),
    s1p: mean != null && std != null ? r2(mean + std) : null,
    s1m: mean != null && std != null ? r2(mean - std) : null,
    s2p: mean != null && std != null ? r2(mean + 2 * std) : null,
    s2m: mean != null && std != null ? r2(mean - 2 * std) : null,
  };

  const latest = {
    date: n ? out.dates[n - 1] : null,
    synth: lastSynth,
    percentile: lastSynth == null ? null : Number(percentileOf(sorted, lastSynth).toFixed(1)),
  };

  return Object.assign(out, { stats, latest });
}

module.exports = { buildSynthSeries };
