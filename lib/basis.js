'use strict';
/**
 * 股指基差指标计算
 *
 * 全部公式根据「基差监控计算器」界面数值逐项反推并验证（详见 README）：
 *   基差        = 现货指数 - 期货价格
 *   涨跌        = 期货最新价 - 期货昨结算价
 *   基差变化    = 今日基差 - (昨收指数 - 期货昨结算价)
 *   剩余天数    = 交割日(到期月第三个周五) - 当日 + 1   （自然日）
 *   年化基差(%) = 基差 / 期货价格 * 365 / 剩余天数 * 100
 *   日均折价    = 基差 / 剩余天数
 *   年化每点    = 基差 / 年化基差(百分数值)   （= 期货价 * 剩余天数 / 36500）
 */

const QUARTER_MONTHS = [3, 6, 9, 12];

/** 中金所股指期货四个挂牌月份：当月 / 下月 / 当季 / 下季 */
function ymAdd(y, m, add) {
  const t = y * 12 + (m - 1) + add;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

function makeCode(prefix, y, m) {
  return prefix + String(y).slice(2) + String(m).padStart(2, '0');
}

/** 返回 { 当月, 下月, 当季, 下季 } 的 {y, m} */
function contractMonths(y, m) {
  const cur = { y, m };
  const nxt = ymAdd(y, m, 1);
  let q1 = null;
  let q2 = null;
  // 季月从「下月之后」取（i=2 起）：若下月本身是季月（如 11 月的下月 12 月），
  // 不能把下月重复算作当季，应顺延到其后的季月，保证当月/下月/当季/下季四个合约互不相同。
  for (let i = 2; i <= 16; i++) {
    const t = ymAdd(y, m, i);
    if (QUARTER_MONTHS.indexOf(t.m) >= 0) {
      if (!q1) q1 = t;
      else { q2 = t; break; }
    }
  }
  return { cur, nxt, q1, q2 };
}

/**
 * 当前交易月（按交易所规则滚动）：
 * 股指期货挂牌「当月 / 下月 / 随后两个季月」，合约在到期月第三个周五交割；
 * 若今天已超过本月第三个周五（交割日），则“当月”立即滚动到下月。
 * 返回 { y, m }，作为 contractMonths 的基准月。
 */
function currentTradingMonth(nowMs, holidays) {
  const t = shanghaiToday(nowMs);
  const tf = thirdFriday(t.y, t.m, holidays || []);
  const todayMs = Date.UTC(t.y, t.m - 1, t.d);
  const expMs = Date.UTC(tf.y, tf.m - 1, tf.d);
  if (todayMs > expMs) return ymAdd(t.y, t.m, 1);
  return { y: t.y, m: t.m };
}

/** 到期月第三个周五（返回 {y, m, d}），遇法定节假日顺延由 holidays 控制 */
function thirdFriday(y, m, holidays) {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const dow = first.getUTCDay(); // 0=周日
  const firstFriday = 1 + ((5 - dow + 7) % 7);
  let day = firstFriday + 14;
  let yy = y;
  let mm = m;
  for (let guard = 0; guard < 10; guard++) {
    const d = new Date(Date.UTC(yy, mm - 1, day));
    const iso = d.toISOString().slice(0, 10);
    const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (!isWeekend && !(holidays && holidays.indexOf(iso) >= 0)) {
      return { y: yy, m: mm, d: day };
    }
    day += 1;
    const dd = new Date(Date.UTC(yy, mm - 1, day));
    if (dd.getUTCMonth() !== mm - 1) { yy = dd.getUTCFullYear(); mm = dd.getUTCMonth() + 1; day = dd.getUTCDate(); }
  }
  return { y, m, d: firstFriday + 14 };
}

function toUTCms(y, m, d) {
  return Date.UTC(y, m - 1, d);
}

/** 上海时区「今天」的 {y, m, d, dow} */
function shanghaiToday(nowMs) {
  const d = new Date((nowMs == null ? Date.now() : nowMs) + 8 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}

/** 剩余天数 = 交割日 - 当日 + 1 */
function remainingDays(delivery, today) {
  const a = toUTCms(delivery.y, delivery.m, delivery.d);
  const b = toUTCms(today.y, today.m, today.d);
  return Math.round((a - b) / 86400000) + 1;
}

/** 市场状态（中金所股指期货/现货指数：09:30-11:30, 13:00-15:00） */
function marketStatus(quoteDate, today) {
  const iso = today.y + '-' + String(today.m).padStart(2, '0') + '-' + String(today.d).padStart(2, '0');
  if (today.dow === 0 || today.dow === 6) return '休市';
  if (quoteDate && quoteDate !== iso) return '休市';
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins < 9 * 60 + 30) return '未开盘';
  if (mins <= 11 * 60 + 30) return '交易中';
  if (mins < 13 * 60) return '午间休市';
  if (mins <= 15 * 60) return '交易中';
  return '已收盘';
}

const round = (v, n) => (v == null || !isFinite(v) ? null : Number(v.toFixed(n)));

/**
 * 计算单个品种的基差表
 * @param {object} p
 *  - prefix      'IF'
 *  - indexQuote  { name, code, value, change, changePct, prevClose }
 *  - contracts   [{ code, monthLabel, price, prevSettle, volume, openInterest }]
 *  - annualDays  默认 365
 *  - holidays    法定节假日 'YYYY-MM-DD' 数组
 *  - nowMs
 */
function computeProduct(p) {
  const annualDays = p.annualDays || 365;
  const nowMs = p.nowMs == null ? Date.now() : p.nowMs;
  const today = shanghaiToday(nowMs);
  const idx = p.indexQuote;
  if (!idx || idx.value == null) return null;

  const S = idx.value;
  const SPrev = idx.prevClose != null ? idx.prevClose : S - (idx.change || 0);

  const rows = (p.contracts || []).map((c) => {
    const delivery = thirdFriday(c.year, c.month, p.holidays);
    const n = remainingDays(delivery, today);
    const P = c.price;
    const prevClose = c.prevClose;
    const basis = P == null ? null : S - P;
    const basisPrev = prevClose == null ? null : SPrev - prevClose;
    const basisChange = basis == null || basisPrev == null ? null : basis - basisPrev;
    const change = P == null || prevClose == null ? null : P - prevClose;
    const changePct = change == null || !prevClose ? null : (change / prevClose) * 100;

    let annualizedBasis = null;
    let dailyDiscount = null;
    if (basis != null && P && n > 0) {
      annualizedBasis = (basis / P) * (annualDays / n) * 100;
      dailyDiscount = basis / n;
    }
    let annualizedPerPoint = null;
    if (basis != null && annualizedBasis != null && Math.abs(annualizedBasis) > 1e-9) {
      annualizedPerPoint = basis / annualizedBasis;
    }

    return {
      code: c.code,
      label: c.label || String(c.year).slice(2) + String(c.month).padStart(2, '0'),
      deliveryDate: delivery.y + '-' + String(delivery.m).padStart(2, '0') + '-' + String(delivery.d).padStart(2, '0'),
      remainingDays: n,
      price: round(P, 2),
      change: round(change, 2),
      changePct: round(changePct, 2),
      prevClose: round(prevClose, 2),
      volume: c.volume == null ? null : Math.round(c.volume),
      openInterest: c.openInterest == null ? null : Math.round(c.openInterest),
      basis: round(basis, 2),
      basisChange: round(basisChange, 2),
      annualizedBasis: round(annualizedBasis, 2),
      dailyDiscount: round(dailyDiscount, 2),
      annualizedPerPoint: round(annualizedPerPoint, 2),
    };
  });

  return {
    product: p.prefix,
    productName: p.indexQuote.name,
    index: {
      code: idx.code,
      name: idx.name,
      value: round(idx.value, 2),
      change: round(idx.change, 2),
      changePct: round(idx.changePct, 2),
      prevClose: round(SPrev, 2),
    },
    contracts: rows,
  };
}

module.exports = {
  QUARTER_MONTHS,
  ymAdd,
  makeCode,
  contractMonths,
  currentTradingMonth,
  thirdFriday,
  remainingDays,
  shanghaiToday,
  marketStatus,
  computeProduct,
};
