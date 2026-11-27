'use strict';
/**
 * GitHub Pages 静态快照生成器
 *
 * 仍使用新浪财经数据源，不改动计算口径：
 *   基差 = 现货指数 - 期货价格
 *   合成年化 = 0.6 × 次月年化 + 0.4 × 当季年化
 *
 * 由 GitHub Actions 定时运行，生成：
 *   data/basis.json          实时基差表（与 /api/basis 同结构）
 *   data/synth_IF.json       近 5 年合成序列（与 /api/synth 同结构）
 *   data/synth_IH.json
 *   data/synth_IC.json
 *   data/synth_IM.json
 *
 * data/contracts/*.json 是已到期合约日线缓存，随仓库一起提交，
 * 避免每次定时运行都全量抓取旧合约。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONTRACT_DIR = path.join(DATA_DIR, 'contracts');

const { fetchSina, parseIndex, parseFuture } = require(path.join(ROOT, 'lib', 'quotes'));
const {
  contractMonths,
  currentTradingMonth,
  makeCode,
  computeProduct,
  shanghaiToday,
  marketStatus,
} = require(path.join(ROOT, 'lib', 'basis'));
const { buildSynthSeries } = require(path.join(ROOT, 'lib', 'synth'));

const PRODUCTS = [
  { key: 'IF', name: '沪深300', indexSymbol: 's_sh000300', mainSymbol: 'IF0' },
  { key: 'IH', name: '上证50', indexSymbol: 's_sh000016', mainSymbol: 'IH0' },
  { key: 'IC', name: '中证500', indexSymbol: 's_sh000905', mainSymbol: 'IC0' },
  { key: 'IM', name: '中证1000', indexSymbol: 's_sh000852', mainSymbol: 'IM0' },
];

const ANNUAL_DAYS = 365;
const SYNTH_DAYS = 1825; // 近 5 年

function loadHolidays() {
  const f = path.join(ROOT, 'holidays.json');
  try {
    if (!fs.existsSync(f)) return [];
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.holidays)) return j.holidays;
  } catch (e) { /* ignore */ }
  return [];
}

function ensureDirs() {
  fs.mkdirSync(CONTRACT_DIR, { recursive: true });
}

function buildCodes(holidays) {
  const base = currentTradingMonth(Date.now(), holidays);
  const m = contractMonths(base.y, base.m);
  const list = [];
  PRODUCTS.forEach((p) => {
    [m.cur, m.nxt, m.q1, m.q2].forEach((t) => {
      if (!t) return;
      list.push({
        product: p.key,
        y: t.y,
        mo: t.m,
        sina: 'nf_' + makeCode(p.key, t.y, t.m),
      });
    });
  });
  return list;
}

async function collectBasis(holidays) {
  const codeDefs = buildCodes(holidays);
  const indexCodes = PRODUCTS.map((p) => p.indexSymbol);
  const codes = indexCodes.concat(codeDefs.map((c) => c.sina));
  const raw = await fetchSina(codes);

  const today = shanghaiToday();
  let quoteDate = '';
  let quoteTime = '';

  const products = PRODUCTS.map((p) => {
    const idx = parseIndex(p.indexSymbol, raw[p.indexSymbol]);
    const mine = codeDefs.filter((c) => c.product === p.key);
    const contracts = [];
    mine.forEach((c) => {
      const f = parseFuture(c.sina, raw[c.sina]);
      if (!f || f.price == null) return;
      if (!quoteDate && f.quoteDate) {
        quoteDate = f.quoteDate;
        quoteTime = f.quoteTime;
      }
      contracts.push({
        code: f.code,
        label: String(c.y).slice(2) + String(c.mo).padStart(2, '0'),
        year: c.y,
        month: c.mo,
        price: f.price,
        prevClose: f.prevClose,
        prevSettle: f.prevSettle,
        volume: f.volume,
        openInterest: f.openInterest,
      });
    });
    return computeProduct({
      prefix: p.key,
      indexQuote: idx,
      contracts,
      annualDays: ANNUAL_DAYS,
      holidays,
    });
  }).filter(Boolean);

  if (!products.length) throw new Error('新浪行情返回为空，保留上次快照');

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    quoteDate,
    quoteTime,
    marketStatus: marketStatus(quoteDate, today),
    annualDays: ANNUAL_DAYS,
    products,
  };
}

/** 先写临时文件再原子替换，避免生成中途失败破坏上次快照 */
function writeJson(name, obj) {
  const target = path.join(DATA_DIR, name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, target);
}

async function main() {
  ensureDirs();
  const holidays = loadHolidays();

  const basis = await collectBasis(holidays);

  const synths = {};
  for (const p of PRODUCTS) {
    synths[p.key] = await buildSynthSeries(
      { key: p.key, klineSymbol: p.indexSymbol.replace(/^s_/, '') },
      SYNTH_DAYS,
      holidays
    );
  }

  writeJson('basis.json', basis);
  PRODUCTS.forEach((p) => {
    writeJson('synth_' + p.key + '.json', {
      ok: true,
      product: p.key,
      days: SYNTH_DAYS,
      data: synths[p.key],
    });
  });

  console.log(
    '[ok] 快照已生成:',
    basis.quoteDate, basis.quoteTime,
    '| synth samples:',
    PRODUCTS.map((p) => p.key + '=' + (synths[p.key].dates || []).length).join(' ')
  );
}

main().catch((e) => {
  console.error('[error] 生成快照失败:', e && e.message);
  process.exit(1);
});
