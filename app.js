"use strict";

/* 股指基差监控 · GitHub Pages 静态版
 * 数据来自 GitHub Actions 定时生成的静态快照：data/basis.json、data/synth_XX.json
 * 前端每 60 秒检查一次快照；页面隐藏时暂停，回到前台立即刷新。
 * 数据源与口径不变：新浪财经；基差 = 现货指数 − 期货价（正值为贴水），合成 = 0.6×次月 + 0.4×当季
 */
const POLL_MS = 60000;

const PRODUCTS = [
  { code: "IF", name: "沪深300" },
  { code: "IH", name: "上证50" },
  { code: "IC", name: "中证500" },
  { code: "IM", name: "中证1000" }
];
const WEIGHT_NM = 0.6, WEIGHT_CQ = 0.4;
const SLOT_NAMES = ["当月", "下月", "当季", "下季"];
const COLORS = { IF: "var(--p-if)", IH: "var(--p-ih)", IC: "var(--p-ic)", IM: "var(--p-im)" };

const state = {
  basis: null,
  synth: {},
  synthLoading: {},
  chartProduct: "IF",
  histRange: {},
  showIndex: true,
  histPoints: [],
  termPoints: [],
  term: { metric: "ann", mode: "compare", showFront: true, single: "IF", hidden: {} },
  lastSuccess: 0,
  errorCount: 0,
  loadingQuotes: false
};

const $ = (id) => document.getElementById(id);
const role = (card, name) => card.querySelector('[data-role="' + name + '"]');
const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "—" : Number(v).toFixed(d));
const sgn = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
const dirClass = (v) => (typeof v === "number" && isFinite(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function bjNow() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function bjDateStr() {
  const d = bjNow();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
/* 按当前北京时间本地判断交易状态，避免快照滞后时仍显示旧状态 */
function localMarketStatus(quoteDate) {
  const d = bjNow();
  if (d.getDay() === 0 || d.getDay() === 6) return "休市";
  if (quoteDate && quoteDate !== bjDateStr()) return "休市";
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < 9 * 60 + 30) return "未开盘";
  if (mins <= 11 * 60 + 30) return "交易中";
  if (mins < 13 * 60) return "午间休市";
  if (mins <= 15 * 60) return "交易中";
  return "已收盘";
}
function percentile(value, arr) {
  if (!arr || !arr.length || value == null || !isFinite(value)) return null;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] <= value) cnt++;
  return (cnt / arr.length) * 100;
}
function quantileLocal(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

/* 通用悬停提示：按视口坐标换算到 SVG viewBox 坐标，找最近的数据点 */
function bindHover(svg, tip, points, renderTip, yWeight) {
  const wrap = svg.closest(".chart-wrap");
  const cross = svg.querySelector(".hover-cross");
  const dot = svg.querySelector(".hover-dot");
  const wy = yWeight == null ? 0.3 : yWeight;
  svg.onmousemove = (e) => {
    if (!points.length || !wrap) return;
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const vx = (e.clientX - r.left) / r.width * vb.width;
    const vy = (e.clientY - r.top) / r.height * vb.height;
    let best = null, bestD = Infinity;
    points.forEach((p) => {
      const dx = p.x - vx, dy = (p.y - vy) * wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    });
    if (!best) return;
    if (cross) { cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x); cross.style.display = "block"; }
    if (dot) { dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y); dot.style.display = "block"; }
    tip.innerHTML = renderTip(best);
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect();
    let left = e.clientX - wr.left + 15;
    let top = e.clientY - wr.top - 14;
    if (left + 235 > wr.width) left = e.clientX - wr.left - 245;
    if (top + 118 > wr.height) top = wr.height - 122;
    if (top < 0) top = 0;
    if (left < 0) left = 0;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };
  svg.onmouseleave = () => {
    tip.hidden = true;
    if (cross) cross.style.display = "none";
    if (dot) dot.style.display = "none";
  };
}

/* 卡片默认只统计近 1 年（大图仍使用完整 5 年序列） */
function sliceLastYear(h) {
  if (!h || !h.synth || !h.dates || !h.dates.length) return h;
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  let i = 0;
  while (i < h.dates.length && h.dates[i] < cutoff) i++;
  if (!i) return h;
  return {
    dates: h.dates.slice(i),
    synth: h.synth.slice(i),
    nm: (h.nm || []).slice(i),
    cq: (h.cq || []).slice(i)
  };
}

function productData(code) {
  if (!state.basis) return null;
  return state.basis.products.filter((p) => p.product === code)[0] || null;
}
function legsOf(p) {
  const cs = (p && p.contracts) || [];
  return { nm: cs[1] || null, cq: cs[2] || null };
}
function compOf(p) {
  const { nm, cq } = legsOf(p);
  if (!nm || !cq || nm.annualizedBasis == null || cq.annualizedBasis == null) return null;
  return WEIGHT_NM * nm.annualizedBasis + WEIGHT_CQ * cq.annualizedBasis;
}

async function getJSON(path) {
  const url = path + (path.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(j.message || ("HTTP " + res.status));
  return j;
}

/* ---------------- 数据加载 ---------------- */

async function loadAll() {
  if (state.loadingQuotes) return;
  state.loadingQuotes = true;
  try {
    const data = await getJSON("data/basis.json");
    state.basis = data;
    state.lastSuccess = Date.now();
    state.errorCount = 0;
    updateHeader();
    renderCards();
    renderTerm();
    PRODUCTS.forEach((p) => ensureSynth(p.code));
  } catch (e) {
    state.errorCount++;
    updateHeader(e);
    if (state.errorCount < 2) {
      PRODUCTS.forEach((p) => {
        const card = $("card-" + p.code);
        if (card) role(card, "error").hidden = false;
      });
    }
  } finally {
    state.loadingQuotes = false;
  }
}

function ensureSynth(code) {
  if (state.synth[code]) return Promise.resolve(state.synth[code]);
  if (state.synthLoading[code]) return state.synthLoading[code];
  state.synthLoading[code] = getJSON("data/synth_" + code + ".json")
    .then((j) => {
      state.synth[code] = j.data || {};
      renderCards();
      if (state.chartProduct === code) renderChart();
      return state.synth[code];
    })
    .catch(() => null)
    .finally(() => { delete state.synthLoading[code]; });
  return state.synthLoading[code];
}

/* ---------------- 顶部状态 ---------------- */

function updateHeader(error) {
  const pill = $("market-status");
  const note = $("data-note");
  if (error) {
    pill.textContent = "连接异常";
    pill.dataset.state = "error";
    note.dataset.state = "error";
    note.textContent = "行情连接中断：" + (error.message || error) + "，正在重试…";
    return;
  }
  if (!state.basis) {
    pill.textContent = "连接中";
    pill.dataset.state = "loading";
    return;
  }
  const ms = localMarketStatus(state.basis.quoteDate) || state.basis.marketStatus || "";
  pill.textContent = ms;
  pill.dataset.state = ms === "交易中" ? "trading" : "closed";

  const qd = state.basis.quoteDate || "";
  const qt = state.basis.quoteTime || "";
  let snap = "";
  if (state.basis.updatedAt) {
    try {
      snap = new Date(state.basis.updatedAt).toLocaleTimeString("zh-CN", {
        hour12: false, timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit"
      });
    } catch (e) { snap = ""; }
  }
  $("update-info").textContent = "行情 " + qd + " " + qt + (snap ? " · 快照 " + snap : "") + " · 每分钟检查";
  const today = qd === bjDateStr();
  note.dataset.state = ms === "交易中" && today ? "live" : "closed";
  note.textContent = today
    ? (ms === "交易中"
        ? "交易时段行情快照每 15 分钟更新一次，页面每 60 秒自动检查"
        : "当前非连续交易时段，显示最近行情 " + qd + " " + qt)
    : "当前显示最近交易日收盘数据 " + qd + " " + qt;
}

/* ---------------- 概览卡 ---------------- */

function renderCards() {
  if (!state.basis) return;
  for (const p of PRODUCTS) {
    const card = $("card-" + p.code);
    const q = productData(p.code);
    if (!card || !q) continue;
    role(card, "index-price").textContent = fmt(q.index.value, 2);
    const chg = role(card, "index-chg");
    chg.textContent = sgn(q.index.changePct, 2) + "%";
    chg.className = "chg-badge " + dirClass(q.index.changePct);

    const comp = compOf(q);
    const compEl = role(card, "comp-ann");
    compEl.innerHTML = (comp == null ? "—" : sgn(comp, 2)) + '<span class="unit">%</span>';
    compEl.className = "hero-value " + dirClass(comp);

    const h = sliceLastYear(state.synth[p.code]);
    const cpct = h ? percentile(comp, h.synth) : null;
    role(card, "comp-pct").textContent = cpct == null ? "—" : fmt(cpct, 1) + "%";
    role(card, "comp-marker").style.left = (cpct == null ? 50 : cpct) + "%";
    role(card, "comp-gauge").style.opacity = cpct == null ? 0.35 : 0.9;

    const note = role(card, "sample-note");
    if (h && h.synth && h.synth.length) {
      const ds = h.dates || [];
      note.textContent = "样本 " + (ds[0] || "—") + " ~ " + (ds[ds.length - 1] || "—") + " · " + h.synth.length + " 个交易日";
    } else if (state.synthLoading[p.code]) {
      note.textContent = "历史样本加载中…";
    } else {
      note.textContent = "暂无历史样本";
    }

    const legBox = role(card, "legs");
    if (legBox) {
      const defs = [
        { i: 0, tag: "当月", weight: "参考", arr: null },
        { i: 1, tag: "次月", weight: "×0.6", arr: h && h.nm },
        { i: 2, tag: "当季", weight: "×0.4", arr: h && h.cq },
        { i: 3, tag: "下季", weight: "", arr: null }
      ];
      legBox.innerHTML = defs.map((d) => {
        const c = (q.contracts || [])[d.i];
        if (!c) return "";
        const lp = d.arr ? percentile(c.annualizedBasis, d.arr) : null;
        return '<div class="leg">' +
          '<div class="leg-top"><span class="leg-tag">' + d.tag + (d.weight ? ' <i>' + d.weight + "</i>" : "") + "</span>" +
          '<span class="leg-contract">' + esc(c.code) + "</span>" +
          '<span class="leg-expiry">' + (c.remainingDays == null ? "—" : c.remainingDays) + " 天后到期</span></div>" +
          '<div class="leg-nums"><span class="leg-price">' + fmt(c.price, 1) + "</span>" +
          '<span class="leg-basis">基差 ' + sgn(c.basis, 1) + "</span>" +
          '<span class="leg-ann ' + dirClass(c.annualizedBasis) + '">' + sgn(c.annualizedBasis, 2) + "%</span>" +
          '<span class="leg-pct">分位 ' + (lp == null ? "—" : fmt(lp, 1) + "%") + "</span></div></div>";
      }).join("");
    }
    if (state.errorCount < 2) role(card, "error").hidden = true;
  }
}

function renderSpark(card, h) {
  const svg = role(card, "spark");
  if (!svg) return;
  const vals = (h && h.synth) || [];
  if (vals.length < 2) { svg.innerHTML = ""; return; }
  const W = 300, H = 48, pad = 4;
  let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (min > 0) min = 0;
  if (max < 0) max = 0;
  if (max - min < 1e-6) { max += 1; min -= 1; }
  const x = (i) => pad + i / (vals.length - 1) * (W - pad * 2);
  const y = (v) => pad + (max - v) / (max - min) * (H - pad * 2);
  let line = "";
  vals.forEach((v, i) => { line += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); });
  const zeroY = y(0).toFixed(1);
  const area = line + "L" + x(vals.length - 1).toFixed(1) + " " + zeroY + "L" + x(0).toFixed(1) + " " + zeroY + "Z";
  svg.innerHTML =
    '<path class="spark-area" d="' + area + '"/>' +
    '<line class="spark-zero" x1="0" y1="' + zeroY + '" x2="' + W + '" y2="' + zeroY + '"/>' +
    '<path class="spark-line" d="' + line + '"/>' +
    '<circle class="spark-dot" cx="' + x(vals.length - 1).toFixed(1) + '" cy="' + y(vals[vals.length - 1]).toFixed(1) + '" r="2.4"/>';
}

/* ---------------- 历史走势图 ---------------- */

/* 时间范围选择条：把选中下标同步到两个滑块与日期标签 */
function syncRangeInputs(a, b, fullDates) {
  const s = $("range-start"), e = $("range-end");
  if (!s || !e) return;
  const n = fullDates.length;
  s.max = e.max = String(Math.max(0, n - 1));
  s.value = String(a);
  e.value = String(b);
  $("range-start-label").textContent = fullDates[a] || "—";
  $("range-end-label").textContent = fullDates[b] || "—";
}

/* 1年/3年/5年快捷区间：以样本最后一个交易日为终点向前推 */
function presetStart(dates, years) {
  if (!dates || dates.length < 2) return 0;
  const end = new Date(dates[dates.length - 1] + "T00:00:00Z").getTime();
  const cutoff = new Date(end - Number(years) * 365 * 86400000).toISOString().slice(0, 10);
  let i = 0;
  while (i < dates.length && dates[i] < cutoff) i++;
  return Math.min(i, dates.length - 2);
}
function syncYearButtons(a, b, fullDates) {
  document.querySelectorAll(".year-seg button").forEach((btn) => {
    const s = presetStart(fullDates, btn.dataset.years);
    btn.classList.toggle("active", a === s && b === fullDates.length - 1);
  });
}

function renderChart() {
  const svg = $("history-chart");
  if (!svg) return;
  const code = state.chartProduct;
  const d = state.synth[code];
  document.querySelectorAll(".chart-section .tab").forEach((b) => {
    const on = b.dataset.product === code;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (!d || !d.synth || d.synth.length < 2) {
    svg.innerHTML = "";
    $("chart-meta").textContent = d && d.synth ? "样本不足" : "样本加载中…";
    $("chart-empty").hidden = false;
    $("range-start").disabled = $("range-end").disabled = true;
    return;
  }
  $("chart-empty").hidden = true;
  $("range-start").disabled = $("range-end").disabled = false;
  const full = d.synth, fullDates = d.dates || [], fullIdx = d.index || [];
  const n = full.length;
  const r = state.histRange[code] || { a: 0, b: 1 };
  let a = Math.max(0, Math.min(n - 2, Math.round(r.a * (n - 1))));
  let b = Math.max(a + 1, Math.min(n - 1, Math.round(r.b * (n - 1))));
  if (b - a < 1) b = Math.min(n - 1, a + 1);
  state.histRange[code] = { a: a / (n - 1), b: b / (n - 1) };
  syncRangeInputs(a, b, fullDates);
  syncYearButtons(a, b, fullDates);

  const vals = full.slice(a, b + 1);
  const dates = fullDates.slice(a, b + 1);
  const idx = fullIdx.slice(a, b + 1);
  const sortedVals = vals.slice().sort((x, y) => x - y);
  const p10 = quantileLocal(sortedVals, 0.1);
  const p50 = quantileLocal(sortedVals, 0.5);
  const p90 = quantileLocal(sortedVals, 0.9);
  const last = vals[vals.length - 1];
  const lastPct = percentile(last, sortedVals);
  const idxPairs = idx.map((v, i) => ({ i, v })).filter((p) => p.v != null && isFinite(p.v));

  $("chart-meta").textContent = "区间 " + (dates[0] || "—") + " ~ " + (dates[dates.length - 1] || "—") +
    " · " + vals.length + " 个交易日 · 期末 " + sgn(last, 2) + "% · 区间分位 " +
    (lastPct == null ? "—" : fmt(lastPct, 1) + "%") + " · 中位数 " + sgn(p50, 2) + "%";

  const showIndex = state.showIndex && idxPairs.length > 1;
  const W = 860, H = 300, L = 54, R = showIndex ? 62 : 22, T = 16, B = 38, iw = W - L - R, ih = H - T - B;
  const candidates = vals.concat([p10, p90, p50, 0]).filter((v) => v != null && isFinite(v));
  let lo = Math.min.apply(null, candidates), hi = Math.max.apply(null, candidates);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  let ilo = 0, ihi = 1;
  if (showIndex) {
    const iv = idxPairs.map((p) => p.v);
    ilo = Math.min.apply(null, iv); ihi = Math.max.apply(null, iv);
    const ipad = (ihi - ilo) * 0.12 || 1;
    ilo -= ipad; ihi += ipad;
  }
  const X = (i) => L + (vals.length === 1 ? 0 : i / (vals.length - 1) * iw);
  const Y = (v) => T + (hi - v) / (hi - lo) * ih;
  const YI = (v) => T + (ihi - v) / (ihi - ilo) * ih;
  state.histPoints = vals.map((v, i) => ({
    x: X(i), y: Y(v), value: v,
    date: dates[i] || "",
    idx: idx[i] != null && isFinite(idx[i]) ? idx[i] : null
  }));

  let out = '<defs><linearGradient id="histBand" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="var(--site-accent)" stop-opacity="0.20"/>' +
    '<stop offset="100%" stop-color="var(--site-accent)" stop-opacity="0.02"/>' +
    "</linearGradient></defs>";
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4, y = Y(v);
    out += '<line class="grid" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '"/>';
    out += '<text class="axis-label" x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + v.toFixed(1) + "%</text>";
    if (showIndex) {
      const iv = ilo + (ihi - ilo) * i / 4;
      out += '<text class="axis-label" x="' + (W - R + 8) + '" y="' + y.toFixed(1) + '" text-anchor="start" fill="var(--p-ih)">' + Math.round(iv) + "</text>";
    }
  }
  if (lo < 0 && hi > 0) {
    out += '<line class="zero" x1="' + L + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(0).toFixed(1) + '"/>';
  }
  if (p10 != null && p90 != null) {
    out += '<rect x="' + L + '" y="' + Y(p90).toFixed(1) + '" width="' + iw + '" height="' + Math.max(0, Y(p10) - Y(p90)).toFixed(1) + '" fill="url(#histBand)"/>';
  }
  if (p50 != null) {
    out += '<line x1="' + L + '" y1="' + Y(p50).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(p50).toFixed(1) +
      '" stroke="var(--site-muted)" stroke-width="1.2" stroke-dasharray="6 5"/>';
  }
  if (showIndex) {
    let ipath = "";
    idxPairs.forEach((p, k) => { ipath += (k ? "L" : "M") + X(p.i).toFixed(1) + " " + YI(p.v).toFixed(1); });
    out += '<path d="' + ipath + '" fill="none" stroke="var(--p-ih)" stroke-width="1.6" opacity="0.85" stroke-linejoin="round"/>';
    const lp = idxPairs[idxPairs.length - 1];
    out += '<circle cx="' + X(lp.i).toFixed(1) + '" cy="' + YI(lp.v).toFixed(1) + '" r="3.5" fill="var(--p-ih)"/>';
  }
  let path = "";
  vals.forEach((v, i) => { path += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); });
  out += '<path d="' + path + '" fill="none" stroke="var(--site-accent)" stroke-width="2.2" stroke-linejoin="round"/>';
  out += '<circle cx="' + X(vals.length - 1).toFixed(1) + '" cy="' + Y(last).toFixed(1) + '" r="4.5" fill="var(--site-fg)" stroke="var(--site-accent)" stroke-width="2"/>';
  out += '<text class="axis-label" x="' + L + '" y="' + (H - 12) + '" text-anchor="start">' + (dates[0] || "") + "</text>";
  out += '<text class="axis-label" x="' + (W - R) + '" y="' + (H - 12) + '" text-anchor="end">' + (dates[dates.length - 1] || "") + "</text>";
  out += '<line class="hover-cross" x1="-10" y1="' + T + '" x2="-10" y2="' + (T + ih) + '" stroke="var(--site-accent)" stroke-width="1" stroke-dasharray="4 4" style="display:none"/>';
  out += '<circle class="hover-dot" cx="-10" cy="-10" r="8" fill="none" stroke="var(--site-fg)" stroke-width="1.5" style="display:none"/>';
  out += '<rect class="hist-hit" x="' + L + '" y="' + T + '" width="' + iw + '" height="' + ih + '"/>';
  svg.innerHTML = out;
  bindHover(svg, $("hist-tip"), state.histPoints, (p) =>
    '<div class="tip-head"><i style="background:var(--site-accent)"></i>' + esc(p.date) + " · " + state.chartProduct + "</div>" +
    '<div class="tip-big ' + dirClass(p.value) + '">' + sgn(p.value, 2) + "%</div>" +
    '<div class="tip-row"><span>合成年化升贴水率</span><span class="mono">' + sgn(p.value, 2) + "%</span></div>" +
    (p.idx != null ? '<div class="tip-row"><span>指数收盘</span><span class="mono">' + fmt(p.idx, 2) + "</span></div>" : "") +
    '<div class="tip-row"><span>区间分位</span><span class="mono">' + fmt(percentile(p.value, sortedVals), 1) + "%</span></div>", 0.2);
}

/* ---------------- 期限结构图 ---------------- */

function termPoints(p) {
  const metric = state.term.metric;
  const cs = p.contracts || [];
  return cs.map((c, i) => ({
    slot: SLOT_NAMES[i] || c.label,
    code: c.code,
    label: c.label,
    days: c.remainingDays,
    price: c.price,
    basis: c.basis,
    ann: c.annualizedBasis,
    value: metric === "ann" ? c.annualizedBasis : c.basis
  })).filter((pt) => pt.value != null && pt.days != null);
}

function renderTerm() {
  const svg = $("term-chart");
  if (!svg || !state.basis) return;
  const t = state.term;
  const products = PRODUCTS.map((p) => ({ code: p.code, name: p.name, pts: termPoints(productData(p.code)) }))
    .filter((x) => x.pts.length);
  const compare = t.mode === "compare";
  $("term-tabs").hidden = compare;
  document.querySelectorAll("#term-tabs .tab").forEach((b) => {
    const on = b.dataset.product === t.single;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".term-seg button[data-metric]").forEach((b) => b.classList.toggle("active", b.dataset.metric === t.metric));
  document.querySelectorAll(".term-seg button[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === t.mode));
  $("term-front").checked = t.showFront;

  const shown = compare
    ? products.filter((x) => !t.hidden[x.code] && (t.showFront ? x.pts : x.pts.slice(1)).length)
    : products.filter((x) => x.code === t.single);
  const activePts = shown.map((x) => (t.showFront ? x.pts : x.pts.slice(1)));
  const allVals = activePts.reduce((a, b) => a.concat(b.map((p) => p.value)), []);
  const allDays = activePts.reduce((a, b) => a.concat(b.map((p) => p.days)), []);
  if (!allVals.length) {
    svg.innerHTML = "";
    $("term-empty").hidden = false;
    $("term-legend").innerHTML = "";
    $("term-table-wrap").hidden = true;
    return;
  }
  $("term-empty").hidden = true;
  const W = 860, H = 330, L = 58, R = 24, T = 18, B = 54, iw = W - L - R, ih = H - T - B;
  let xmin = Math.min.apply(null, allDays), xmax = Math.max.apply(null, allDays);
  if (xmax === xmin) xmax = xmin + 1;
  let lo = Math.min(0, Math.min.apply(null, allVals)), hi = Math.max(0, Math.max.apply(null, allVals));
  const pad = (hi - lo) * 0.16 || 1;
  lo -= pad; hi += pad;
  const X = (d) => L + (d - xmin) / (xmax - xmin) * iw;
  const Y = (v) => T + (hi - v) / (hi - lo) * ih;
  const unit = t.metric === "ann" ? "%" : " 点";

  let out = "";
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4, y = Y(v);
    out += '<line class="grid" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '"/>';
    out += '<text class="axis-label" x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + v.toFixed(1) + (t.metric === "ann" ? "%" : "") + "</text>";
  }
  if (lo < 0 && hi > 0) {
    out += '<line class="zero" x1="' + L + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(0).toFixed(1) + '"/>';
  }

  state.termPoints = [];
  shown.forEach((x, si) => {
    const pts = t.showFront ? x.pts : x.pts.slice(1);
    const col = COLORS[x.code];
    const line = pts.map((p) => X(p.days).toFixed(1) + "," + Y(p.value).toFixed(1)).join(" ");
    if (pts.length > 1) {
      if (t.showFront && pts.length > 2) {
        out += '<polyline class="term-line term-front-link" points="' + pts.slice(0, 2).map((p) => X(p.days).toFixed(1) + "," + Y(p.value).toFixed(1)).join(" ") + '" stroke="' + col + '"/>';
        out += '<polyline class="term-line" points="' + pts.slice(1).map((p) => X(p.days).toFixed(1) + "," + Y(p.value).toFixed(1)).join(" ") + '" stroke="' + col + '"/>';
      } else {
        out += '<polyline class="term-line" points="' + line + '" stroke="' + col + '"/>';
      }
    }
    pts.forEach((p, i) => {
      const hollow = t.showFront && i === 0;
      out += '<circle class="term-pt' + (hollow ? " hollow" : "") + '" cx="' + X(p.days).toFixed(1) + '" cy="' + Y(p.value).toFixed(1) +
        '" r="' + (hollow ? 4.5 : 5.5) + '" fill="' + (hollow ? "var(--site-surface)" : col) + '" stroke="' + col + '"><title>' +
        esc(x.code + " " + p.slot + " " + p.code + " · " + sgn(p.value, 2) + unit + " · " + p.days + "天") + "</title></circle>";
      state.termPoints.push({
        x: X(p.days), y: Y(p.value),
        product: x.code, productName: x.name, color: col,
        slot: p.slot, contract: p.code, label: p.label,
        days: p.days, price: p.price, basis: p.basis, ann: p.ann,
        value: p.value, front: hollow
      });
      if (!compare) {
        const dy = p.value >= 0 ? -13 : 21;
        out += '<text class="term-val" x="' + X(p.days).toFixed(1) + '" y="' + (Y(p.value) + dy).toFixed(1) +
          '" text-anchor="middle" fill="' + col + '">' + sgn(p.value, 2) + "</text>";
        out += '<text class="term-slot" x="' + X(p.days).toFixed(1) + '" y="' + (H - 32) + '" text-anchor="middle">' + esc(p.slot) + "</text>";
        out += '<text class="axis-label term-month" x="' + X(p.days).toFixed(1) + '" y="' + (H - 16) + '" text-anchor="middle">' + esc(p.label) + " · " + p.days + "天</text>";
      }
    });
  });
  out += '<line class="hover-cross" x1="-10" y1="' + T + '" x2="-10" y2="' + (T + ih) + '" stroke="var(--site-accent)" stroke-width="1" stroke-dasharray="4 4" style="display:none"/>';
  out += '<circle class="hover-dot" cx="-10" cy="-10" r="9" fill="none" stroke="var(--site-fg)" stroke-width="1.5" style="display:none"/>';
  out += '<rect class="term-hit" x="' + L + '" y="' + T + '" width="' + iw + '" height="' + ih + '"/>';
  svg.innerHTML = out;
  bindHover(svg, $("term-tip"), state.termPoints, (p) =>
    '<div class="tip-head"><i style="background:' + p.color + '"></i>' + esc(p.product + " " + p.productName + " · " + p.slot + " " + p.contract) + "</div>" +
    '<div class="tip-big ' + dirClass(p.value) + '">' + sgn(p.value, 2) + (t.metric === "ann" ? "%" : " 点") + "</div>" +
    '<div class="tip-row"><span>最新价</span><span class="mono">' + fmt(p.price, 2) + "</span></div>" +
    '<div class="tip-row"><span>基差</span><span class="mono">' + sgn(p.basis, 2) + " 点</span></div>" +
    '<div class="tip-row"><span>年化基差</span><span class="mono">' + sgn(p.ann, 2) + "%</span></div>" +
    '<div class="tip-row"><span>剩余天数</span><span class="mono">' + p.days + " 天</span></div>" +
    (p.front ? '<div class="tip-row"><span>当月</span><span class="mono">仅参考，不参与合成</span></div>' : ""), 1);

  $("term-meta").textContent = "纵轴：" + (t.metric === "ann" ? "年化升贴水率（%）" : "基差点数") +
    " · " + (compare ? "四品种对比" : PRODUCTS.filter((p) => p.code === t.single)[0].name + " 单品种明细") +
    " · " + (t.showFront ? "含当月参考点（不参与合成）" : "已隐藏当月参考点") + " · 数据来源：新浪财经";

  $("term-legend").innerHTML = compare
    ? PRODUCTS.map((p) => '<button class="legend-chip' + (t.hidden[p.code] ? " off" : "") + '" data-code="' + p.code +
        '" type="button"><i style="background:' + COLORS[p.code] + '"></i>' + p.code + " " + p.name + "</button>").join("")
    : '<span class="legend-chip"><i style="background:' + COLORS[t.single] + '"></i>' + t.single + " " +
      PRODUCTS.filter((p) => p.code === t.single)[0].name + "（实心为次月×0.6与当季×0.4）</span>";

  const wrap = $("term-table-wrap");
  if (!compare) {
    const p = productData(t.single);
    const rows = (p && p.contracts || []).map((c, i) => {
      const clsRow = i === 1 || i === 2 ? "weighted-row" : "muted-row";
      return "<tr class='" + clsRow + "'><td>" + SLOT_NAMES[i] + "</td><td>" + esc(c.code) + "</td><td>" + c.remainingDays +
        "</td><td>" + fmt(c.price, 1) + "</td><td class='" + dirClass(c.basis) + "'>" + sgn(c.basis, 2) +
        "</td><td class='" + dirClass(c.annualizedBasis) + "'>" + sgn(c.annualizedBasis, 2) + "%</td></tr>";
    }).join("");
    wrap.innerHTML = '<table class="term-table"><thead><tr><th>类别</th><th>合约</th><th>剩余天数</th><th>最新价</th><th>基差（点）</th><th>年化升贴水率</th></tr></thead><tbody>' + rows + "</tbody></table>";
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

/* ---------------- 交互 ---------------- */

function bindEvents() {
  $("refresh-btn").addEventListener("click", () => { loadAll(); PRODUCTS.forEach((p) => ensureSynth(p.code)); });
  document.querySelectorAll(".term-seg button[data-metric]").forEach((b) => {
    b.addEventListener("click", () => { state.term.metric = b.dataset.metric; renderTerm(); });
  });
  document.querySelectorAll(".term-seg button[data-mode]").forEach((b) => {
    b.addEventListener("click", () => { state.term.mode = b.dataset.mode; renderTerm(); });
  });
  $("term-front").addEventListener("change", (e) => { state.term.showFront = e.target.checked; renderTerm(); });
  $("term-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-product]");
    if (!b) return;
    state.term.single = b.dataset.product;
    document.querySelectorAll("#term-tabs .tab").forEach((x) => {
      const on = x.dataset.product === state.term.single;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderTerm();
  });
  $("term-legend").addEventListener("click", (e) => {
    const b = e.target.closest(".legend-chip[data-code]");
    if (!b) return;
    const code = b.dataset.code;
    state.term.hidden[code] = !state.term.hidden[code];
    renderTerm();
  });
  document.querySelectorAll(".year-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = state.synth[state.chartProduct];
      if (!d || !d.dates || !d.synth || d.synth.length < 2) return;
      const a = presetStart(d.dates, btn.dataset.years);
      const b = d.dates.length - 1;
      state.histRange[state.chartProduct] = { a: a / (d.synth.length - 1), b: 1 };
      renderChart();
    });
  });
  const applyRange = () => {
    const d = state.synth[state.chartProduct];
    if (!d || !d.synth || d.synth.length < 2) return;
    const n = d.synth.length;
    const s = $("range-start"), e = $("range-end");
    let a = Number(s.value), b = Number(e.value);
    if (a >= b) {
      if (document.activeElement === s) { a = Math.max(0, b - 1); s.value = String(a); }
      else { b = Math.min(n - 1, a + 1); e.value = String(b); }
    }
    state.histRange[state.chartProduct] = { a: a / (n - 1), b: b / (n - 1) };
    renderChart();
  };
  $("range-start").addEventListener("input", applyRange);
  $("range-end").addEventListener("input", applyRange);
  $("range-reset").addEventListener("click", () => {
    delete state.histRange[state.chartProduct];
    renderChart();
  });
  $("show-index").addEventListener("change", (e) => { state.showIndex = e.target.checked; renderChart(); });
  document.querySelectorAll(".chart-section .tab").forEach((b) => {
    b.addEventListener("click", () => {
      state.chartProduct = b.dataset.product;
      renderChart();
      ensureSynth(state.chartProduct);
    });
  });
  document.querySelectorAll(".card [data-action='retry']").forEach((b) => {
    b.addEventListener("click", () => { loadAll(); PRODUCTS.forEach((p) => ensureSynth(p.code)); });
  });
}

function init() {
  const qs = new URLSearchParams(location.search);
  if (qs.get("term") === "single") {
    state.term.mode = "single";
    state.term.single = (qs.get("product") || "IF").toUpperCase();
  }
  if (qs.get("chart")) state.chartProduct = qs.get("chart").toUpperCase();
  bindEvents();
  const clock = () => {
    const d = bjNow();
    $("bj-clock").textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    if (state.basis) updateHeader();
  };
  clock();
  setInterval(clock, 1000);
  /* 分钟级轮询：页面不可见时暂停，回到前台立即检查 */
  function poll() {
    if (document.hidden) return;
    loadAll();
    PRODUCTS.forEach((p) => ensureSynth(p.code));
  }
  loadAll();
  PRODUCTS.forEach((p) => ensureSynth(p.code));
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
}

document.addEventListener("DOMContentLoaded", init);
