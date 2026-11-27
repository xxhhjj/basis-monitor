'use strict';
/**
 * 历史基差序列（主力连续）
 *
 * 主力基差 = 现货指数收盘 - 主力连续期货收盘
 * 数据源：
 *   指数日线  https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh000300&scale=240&ma=no&datalen=250
 *   期货日线  https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/InnerFuturesNewService.getDailyKLine?symbol=IF0
 *
 * 注意：主力连续价格在移仓换月处存在跳空（拼接序列），基差序列用于统计分位时
 * 属于行业通行做法，但需知悉该口径限制。
 */

const { httpGet, HEADERS } = require('./quotes');

const IDX_KLINE = (symbol, len) =>
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' +
  symbol + '&scale=240&ma=no&datalen=' + len;
const FUT_KLINE = (symbol) =>
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/InnerFuturesNewService.getDailyKLine?symbol=' + symbol;

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

async function fetchIndexDaily(symbol, len) {
  const text = await httpGet(IDX_KLINE(symbol, len), HEADERS, 15000);
  const arr = pickJsonArray(text, false);
  const map = {};
  arr.forEach((r) => {
    if (r && r.day) map[String(r.day).slice(0, 10)] = Number(r.close);
  });
  return map;
}

async function fetchFutDaily(symbol) {
  const text = await httpGet(FUT_KLINE(symbol), HEADERS, 15000);
  const arr = pickJsonArray(text, true);
  const map = {};
  arr.forEach((r) => {
    if (r && r.d) map[String(r.d).slice(0, 10)] = { close: Number(r.c), volume: Number(r.v), oi: Number(r.p) };
  });
  return map;
}

function percentile(sortedAsc, x) {
  if (!sortedAsc.length) return null;
  let cnt = 0;
  for (let i = 0; i < sortedAsc.length; i++) if (sortedAsc[i] <= x) cnt++;
  return (cnt / sortedAsc.length) * 100;
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

/**
 * @returns {{dates:string[], basis:number[], rate:number[], stats:object, latest:object}}
 */
async function buildHistory(indexSymbol, mainSymbol, days) {
  const n = Math.max(30, Math.min(Number(days) || 250, 500));
  const [idxMap, futMap] = await Promise.all([
    fetchIndexDaily(indexSymbol, n + 40),
    fetchFutDaily(mainSymbol),
  ]);

  const dates = Object.keys(futMap).filter((d) => idxMap[d] != null).sort();
  const use = dates.slice(-n);

  const out = { dates: [], basis: [], rate: [], index: [], futures: [] };
  use.forEach((d) => {
    const f = futMap[d];
    const s = idxMap[d];
    if (f == null || s == null || !f.close || !s) return;
    out.dates.push(d);
    out.index.push(Number(s.toFixed(2)));
    out.futures.push(Number(f.close.toFixed(2)));
    const b = s - f.close;
    out.basis.push(Number(b.toFixed(2)));
    out.rate.push(Number(((b / s) * 100).toFixed(3)));
  });

  const sorted = out.basis.slice().sort((a, b) => a - b);
  const sortedRate = out.rate.slice().sort((a, b) => a - b);
  const last = out.basis.length ? out.basis[out.basis.length - 1] : null;
  const lastRate = out.rate.length ? out.rate[out.rate.length - 1] : null;

  const stats = {
    count: out.basis.length,
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    mean: sorted.length ? Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)) : null,
    p10: sorted.length ? Number(quantile(sorted, 0.1).toFixed(2)) : null,
    p25: sorted.length ? Number(quantile(sorted, 0.25).toFixed(2)) : null,
    p50: sorted.length ? Number(quantile(sorted, 0.5).toFixed(2)) : null,
    p75: sorted.length ? Number(quantile(sorted, 0.75).toFixed(2)) : null,
    p90: sorted.length ? Number(quantile(sorted, 0.9).toFixed(2)) : null,
    rateMin: sortedRate.length ? sortedRate[0] : null,
    rateMax: sortedRate.length ? sortedRate[sortedRate.length - 1] : null,
    rateP50: sortedRate.length ? Number(quantile(sortedRate, 0.5).toFixed(3)) : null,
  };

  const latest = {
    date: out.dates.length ? out.dates[out.dates.length - 1] : null,
    basis: last,
    rate: lastRate,
    percentile: last == null ? null : Number(percentile(sorted, last).toFixed(1)),
    ratePercentile: lastRate == null ? null : Number(percentile(sortedRate, lastRate).toFixed(1)),
  };

  return Object.assign(out, { stats, latest });
}


module.exports = { buildHistory };
