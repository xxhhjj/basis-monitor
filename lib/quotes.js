'use strict';
/**
 * 行情抓取（新浪财经）—— 服务端抓取，规避小程序 wx.request 无法设置 Referer 的限制。
 *
 * 指数：https://hq.sinajs.cn/list=s_sh000300
 *   返回 "名称,当前点位,涨跌,涨跌幅,成交量,成交额"
 * 期货：https://hq.sinajs.cn/list=nf_IF2610
 *   返回 50 个字段，本服务使用：
 *     [3]  最新价（收盘后即收盘价）
 *     [4]  成交量（手）
 *     [13] 昨收盘价（已用日K交叉验证：IF2610 10-13 收盘 4270.4 = 快照[13]）
 *     [14] 昨结算价
 *     [15] 持仓量（未平仓量）
 *     [36] 行情日期  [37] 行情时间
 */

const https = require('https');

const SINA_HQ = 'https://hq.sinajs.cn/list=';
const HEADERS = {
  Referer: 'https://finance.sina.com.cn',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

function httpGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {}, timeout: timeoutMs || 12000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        }
        resolve(decodeBody(buf, res.headers['content-type']));
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', reject);
  });
}

function decodeBody(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.indexOf('gb') >= 0 || ct.indexOf('gbk') >= 0 || ct.indexOf('gb2312') >= 0) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { /* fallthrough */ }
  }
  const utf8 = buf.toString('utf8');
  // 新浪行情默认 GBK：若 UTF-8 解码出现大量替换字符，则回退 GBK 解码
  if ((utf8.match(/\uFFFD/g) || []).length > 2) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { /* ignore */ }
  }
  return utf8;
}

/** 批量抓取新浪行情，返回 { code: [fields...] } */
async function fetchSina(codes) {
  if (!codes.length) return {};
  const url = SINA_HQ + codes.join(',');
  const text = await httpGet(url, HEADERS, 12000);
  const out = {};
  text.split('\n').forEach((line) => {
    const m = line.match(/var\s+hq_str_([A-Za-z0-9_]+)\s*=\s*"(.*)"/);
    if (!m) return;
    out[m[1]] = m[2] ? m[2].split(',') : [];
  });
  return out;
}

const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
};

/** 解析指数行情 s_xxx */
function parseIndex(code, arr) {
  if (!arr || arr.length < 4) return null;
  const value = num(arr[1]);
  const change = num(arr[2]);
  return {
    code: code.replace(/^s_/, '').replace(/^sh/, ''),
    name: arr[0] || code,
    value,
    change,
    changePct: num(arr[3]),
    volume: num(arr[4]),
    amount: num(arr[5]),
    prevClose: value == null || change == null ? null : value - change,
  };
}

/** 解析期货行情 nf_xxx */
function parseFuture(code, arr) {
  if (!arr || arr.length < 38) return null;
  return {
    code: code.replace(/^nf_/, ''),
    price: num(arr[3]),
    volume: num(arr[4]),
    amount: num(arr[5]),
    prevClose: num(arr[13]),
    prevSettle: num(arr[14]),
    openInterest: num(arr[15]),
    quoteDate: (arr[36] || '').trim(),
    quoteTime: (arr[37] || '').trim(),
    name: arr[49] || '',
  };
}

module.exports = { httpGet, fetchSina, parseIndex, parseFuture, HEADERS };
