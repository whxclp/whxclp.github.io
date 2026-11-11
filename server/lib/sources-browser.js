'use strict';
/**
 * 行情适配层（浏览器版）
 *
 * 与原 server/lib/sources.js 的接口保持一致（quotes / klines / search / probe），
 * 但只使用允许跨域（CORS）的公开接口，才能在 GitHub Pages 这种纯静态环境里跑：
 *
 *   A/港/美 实时报价  腾讯 qt.gtimg.cn           （Access-Control-Allow-Origin: *）
 *   A/港 日周月 K 线  腾讯 ifzq.gtimg.cn          （*）
 *   A 分钟 K 线       腾讯 ifzq mkline            （*）
 *   美股/期货 K 线    东财 push2his               （回显 Origin）
 *   加密 报价/K 线    币安 data-api.binance.vision（*）
 *
 * 注意：新浪（quotes.sina.cn / hq.sinajs.cn）、纳斯达克官方接口不带 CORS 头，
 * 浏览器直连会被拦，因此不作为数据源。
 */

const MARKETS = {
  A: { key: 'A', name: 'A股', currency: 'CNY', tz: 8, intraday: true, periods: ['1m', '5m', '15m', '30m', '60m', 'day', 'week', 'month'] },
  HK: { key: 'HK', name: '港股', currency: 'HKD', tz: 8, intraday: false, periods: ['day', 'week', 'month'] },
  US: { key: 'US', name: '美股', currency: 'USD', tz: -4, intraday: false, periods: ['day', 'week', 'month'] },
  CR: { key: 'CR', name: '加密', currency: 'USDT', tz: 0, intraday: true, periods: ['1m', '5m', '15m', '30m', '60m', '4h', 'day', 'week'] },
  CNF: { key: 'CNF', name: '国内期货', currency: 'CNY', tz: 8, intraday: true, periods: ['1m', '5m', '15m', '30m', '60m', 'day', 'week', 'month'] },
  USF: { key: 'USF', name: '美期货', currency: 'USD', tz: -5, intraday: true, periods: ['1m', '5m', '15m', '30m', '60m', 'day', 'week', 'month'] },
};

const PERIOD_NAME = {
  '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟',
  '1h': '1小时', '4h': '4小时', day: '日线', week: '周线', month: '月线',
};
const PERIOD_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1h': 60, '4h': 240, day: 1440, week: 10080, month: 30240 };

const A_SH_PREFIX = /^(60|68|9|5|11|13|50|51|58)/;
const A_SZ_PREFIX = /^(00|30|20|15|16|12|39)/;

function normCode(market, raw) {
  let c = String(raw || '').trim().toUpperCase();
  if (market === 'A') {
    if (/^(SH|SZ|BJ)/.test(c)) return c.toLowerCase();
    return c.replace(/\.(SH|SZ|BJ)$/, '');
  }
  if (market === 'HK') {
    if (/^HK[0-9]/.test(c)) return c.slice(2).padStart(5, '0');
    if (/^HK[A-Z]+$/.test(c)) return c.slice(2);
    if (/^[A-Z]{2,6}$/.test(c)) return c;
    return c.replace(/\.HK$/, '').padStart(5, '0');
  }
  if (market === 'US') return c.replace(/^US\.?/, '').replace(/\.(OQ|N|US)$/, '');
  if (market === 'CNF') return c.replace(/^CNF\.?/, '').replace(/[^A-Z0-9]/g, '');
  if (market === 'USF') return c.replace(/^USF\.?/, '').replace(/[^A-Z0-9]/g, '');
  return c.replace(/[-/_]/g, '');
}

function tcCode(market, code) {
  const c = normCode(market, code);
  if (market === 'A') {
    if (/^(sh|sz|bj)/.test(c)) return c;
    const p = A_SH_PREFIX.test(c) ? 'sh' : 'sz';
    return p + c;
  }
  if (market === 'HK') return 'hk' + c;
  if (market === 'US') return 'us' + c;
  return null;
}

function bnSymbol(code) {
  const c = String(code || '').toUpperCase().replace(/[-/_]/g, '');
  if (/(USDT|USDC|BTC|ETH|BUSD)$/.test(c)) return c;
  return c + 'USDT';
}

const num = (v) => {
  const n = parseFloat(String(v).replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/* ---------------- 缓存 / 请求 ---------------- */
const MEM = new Map();
async function cached(key, ttl, fn) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < ttl) return { value: hit.value, cached: true };
  const value = await fn();
  MEM.set(key, { at: Date.now(), value });
  return { value, cached: false };
}

async function request(url, { encoding = 'utf-8', timeout = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    return new TextDecoder(encoding).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url, opts) {
  const txt = await request(url, opts);
  try {
    return JSON.parse(txt);
  } catch (e) {
    const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
    throw new Error('返回不是 JSON');
  }
}

/* ---------------- 报价 ---------------- */
function parseTencentQuote(line, market, wantCode) {
  const m = line.match(/^v_([a-zA-Z0-9]+)="([^"]*)"/);
  if (!m) return null;
  const f = m[2].split('~');
  if (f.length < 40) return null;
  const price = num(f[3]);
  const prev = num(f[4]);
  if (!price && !prev) return null;
  const pct = num(f[32]);
  const chg = num(f[31]) || (prev ? price - prev : 0);
  const tsRaw = String(f[30] || '');
  let ts = 0;
  const d1 = tsRaw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  const d2 = tsRaw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (d1) ts = Date.UTC(+d1[1], +d1[2] - 1, +d1[3], +d1[4] - 8, +d1[5], +d1[6]);
  else if (d2) ts = Date.UTC(+d2[1], +d2[2] - 1, +d2[3], +d2[4] - 8, +d2[5], +d2[6]);
  return {
    market,
    code: normCode(market, wantCode || f[2] || m[1].replace(/^[a-z]{2}/, '')),
    name: f[1] || f[2] || m[1],
    price,
    prevClose: prev,
    open: num(f[5]),
    high: num(f[33]),
    low: num(f[34]),
    change: chg,
    pct,
    volume: num(f[6]),
    amount: num(f[37]),
    ts,
    timeText: tsRaw,
    source: 'tencent',
  };
}

async function fetchTencentQuotes(items) {
  const map = new Map();
  const valid = items.filter((it) => it.market !== 'CR' && it.market !== 'CNF' && it.market !== 'USF');
  if (!valid.length) return map;
  const tcs = valid.map((it) => tcCode(it.market, it.code));
  const txt = await request('https://qt.gtimg.cn/q=' + tcs.join(','), { encoding: 'gbk', timeout: 9000 });
  const byTc = new Map(valid.map((it, i) => [tcs[i], it]));
  for (const line of txt.split('\n')) {
    const m = line.match(/^v_([a-zA-Z0-9]+)=/);
    if (!m || !byTc.has(m[1])) continue;
    const it = byTc.get(m[1]);
    const q = parseTencentQuote(line, it.market, normCode(it.market, it.code));
    if (q) map.set(it.market + ':' + normCode(it.market, it.code), q);
  }
  return map;
}

async function fetchCryptoQuotes(items) {
  const map = new Map();
  if (!items.length) return map;
  const symbols = items.map((it) => bnSymbol(it.code));
  const arr = await getJSON(
    'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(symbols)),
    { timeout: 9000 }
  );
  for (const t of Array.isArray(arr) ? arr : [arr]) {
    const code = String(t.symbol || '').toUpperCase();
    const price = num(t.lastPrice);
    const open = num(t.openPrice);
    const prev = open || price - num(t.priceChange);
    const pct = num(t.priceChangePercent) || (open ? ((price - open) / open) * 100 : 0);
    map.set('CR:' + code, {
      market: 'CR', code, name: code.replace(/USDT$/, '') + '/USDT',
      price, prevClose: prev, open, high: num(t.highPrice), low: num(t.lowPrice),
      change: num(t.priceChange) || price - prev, pct,
      volume: num(t.volume), amount: num(t.quoteVolume),
      ts: num(t.closeTime) || Date.now(),
      timeText: new Date(num(t.closeTime) || Date.now()).toISOString().slice(0, 16).replace('T', ' '),
      source: 'binance',
    });
  }
  return map;
}

/* 期货：东财 K 线取数（secid 见下），报价由 K 线收盘价兜底 */
function emSecids(market, code) {
  const c = normCode(market, code);
  if (market === 'A') {
    if (/^sh/.test(c)) return ['1.' + c.slice(2)];
    if (/^sz|^bj/.test(c)) return ['0.' + c.slice(2)];
    return [(A_SH_PREFIX.test(c) ? '1.' : '0.') + c];
  }
  if (market === 'HK') return ['116.' + c];
  if (market === 'US') return ['105.' + c];
  if (market === 'USF') {
    const map = { ES: '103.ES00Y', NQ: '103.NQ00Y', YM: '103.YM00Y', GC: '101.GC00Y', SI: '101.SI00Y', CL: '102.CL00Y', NG: '102.NG00Y' };
    return map[c] ? [map[c]] : [];
  }
  return [];
}

async function quotes(items) {
  const uniq = [];
  const seen = new Set();
  for (const it of items) {
    const k = it.market + ':' + normCode(it.market, it.code);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({ market: it.market, code: normCode(it.market, it.code) });
  }
  const key = 'quotes:' + uniq.map((i) => i.market + i.code).join(',');
  const res = await cached(key, 4000, async () => {
    const out = {};
    const futures = uniq.filter((i) => i.market === 'CNF' || i.market === 'USF');
    const jobs = [];
    if (uniq.some((i) => i.market !== 'CR' && i.market !== 'CNF' && i.market !== 'USF')) jobs.push(fetchTencentQuotes(uniq));
    jobs.push(fetchCryptoQuotes(uniq.filter((i) => i.market === 'CR')));
    const maps = await Promise.allSettled(jobs);
    for (const r of maps) if (r.status === 'fulfilled') for (const [k, v] of r.value) out[k] = v;

    // 期货兜底：用日线最新两根重算价格与涨跌
    const missing = uniq.filter((i) => (i.market === 'CNF' || i.market === 'USF') && !out[i.market + ':' + i.code]);
    await Promise.allSettled(missing.map(async (i) => {
      try {
        const k = await klines({ market: i.market, code: i.code, period: 'day', limit: 3 });
        const bars = k.bars || [];
        if (!bars.length) return;
        const last = bars[bars.length - 1];
        const prev = bars.length > 1 ? bars[bars.length - 2] : last;
        out[i.market + ':' + i.code] = {
          market: i.market, code: i.code, name: i.code,
          price: last.c, prevClose: prev.c,
          high: last.h, low: last.l, open: last.o,
          change: +(last.c - prev.c).toFixed(4),
          pct: prev.c ? +(((last.c - prev.c) / prev.c) * 100).toFixed(2) : 0,
          ts: last.t, timeText: '', source: 'eastmoney-kline',
        };
      } catch (e) {}
    }));
    return out;
  });

  const data = res.value;
  return uniq.map((i) => data[i.market + ':' + i.code] || { market: i.market, code: i.code, name: i.code, price: 0, pct: 0, error: '无报价' });
}

/* ---------------- K 线 ---------------- */
function bar(t, o, h, l, c, v) {
  return { t, o, h, l, c, v };
}

function parseTencentDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00Z');
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Date.parse(s);
}

async function tencentFq(market, code, period, limit) {
  const tc = tcCode(market, code);
  const n = Math.min(Math.max(limit, 60), 800);
  const hosts = market === 'HK'
    ? ['https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get', 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/hkfqkline/get']
    : ['https://ifzq.gtimg.cn/appstock/app/fqkline/get', 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get'];
  const errs = [];
  for (const host of hosts) {
    try {
      const j = await getJSON(`${host}?param=${tc},${period},,,${n},qfq`, { timeout: 10000 });
      const node = j && j.data && j.data[tc];
      if (!node) throw new Error('无数据节点');
      const arr = node[period] || node['qfq' + period] || node['hfq' + period];
      if (!Array.isArray(arr) || !arr.length) throw new Error('空数据');
      const bars = arr
        .filter((r) => Array.isArray(r) && r.length >= 6 && !isNaN(parseFloat(r[1])))
        .map((r) => bar(parseTencentDate(r[0]), num(r[1]), num(r[3]), num(r[4]), num(r[2]), num(r[5])));
      if (bars.length < 5) throw new Error('数据不足');
      return { bars, source: 'tencent' };
    } catch (e) { errs.push(String(e.message || e)); }
  }
  throw new Error('tencent: ' + errs.join(' / '));
}

const NC_MKLINE = { '1m': 'm1', '5m': 'm5', '15m': 'm15', '30m': 'm30', '60m': 'm60' };

async function tencentMinute(code, period, limit) {
  const tc = tcCode('A', code);
  const m = NC_MKLINE[period];
  if (!m) throw new Error('不支持的周期');
  const j = await getJSON(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tc},${m},,${Math.min(limit, 640)}`, { timeout: 9000 });
  const node = j && j.data && j.data[tc];
  const arr = node && node[m];
  if (!Array.isArray(arr) || !arr.length) throw new Error('tencent 分钟线无数据');
  const bars = arr
    .filter((r) => Array.isArray(r) && r.length >= 5)
    .map((r) => bar(parseTencentDate(r[0]), num(r[1]), num(r[3]), num(r[4]), num(r[2]), num(r[5])))
    .sort((a, b) => a.t - b.t);
  return { bars, source: 'tencent-mkline' };
}

const EM_KLT = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, day: 101, week: 102, month: 103 };

async function emKline(market, code, period, limit) {
  const klt = EM_KLT[period];
  if (!klt) throw new Error('东财不支持周期 ' + period);
  let lastErr = null;
  for (const secid of emSecids(market, code).slice(0, 2)) {
    try {
      const j = await getJSON(
        'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid + '&klt=' + klt + '&fqt=1&lmt=' + limit +
        '&end=20500101&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57',
        { timeout: 8000 }
      );
      const rows = j && j.data && j.data.klines;
      if (!Array.isArray(rows) || !rows.length) throw new Error('eastmoney 无数据');
      const bars = rows.map((r) => {
        const p = String(r).split(',');
        const t = p[0].length <= 10 ? Date.parse(p[0] + 'T00:00:00Z') : Date.parse(p[0].replace(' ', 'T') + '+08:00');
        return bar(t, num(p[1]), num(p[3]), num(p[4]), num(p[2]), num(p[5]));
      }).filter((b) => b.c > 0);
      return { bars, source: 'eastmoney' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('eastmoney 无数据');
}

const BINANCE_INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '60m': '1h', '1h': '1h', '4h': '4h', day: '1d', week: '1w', month: '1M' };

async function binanceKline(code, period, limit) {
  const interval = BINANCE_INTERVAL[period] || '1d';
  const arr = await getJSON(
    `https://data-api.binance.vision/api/v3/klines?symbol=${bnSymbol(code)}&interval=${interval}&limit=${Math.min(limit, 1000)}`,
    { timeout: 10000 }
  );
  if (!Array.isArray(arr) || !arr.length) throw new Error('binance 无数据');
  return { bars: arr.map((r) => bar(Number(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), num(r[5]))), source: 'binance' };
}

function aggBars(bars, keyFn) {
  const map = new Map();
  for (const b of bars) {
    const k = keyFn(b.t);
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, t: k });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}
const weekKey = (t) => {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
};
const monthKey = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

async function klines({ market, code, period = 'day', limit = 600 }) {
  const m = String(market || 'A').toUpperCase();
  const c = normCode(m, code);
  if (!PERIOD_MINUTES[period]) throw new Error('不支持的周期: ' + period);
  if (!MARKETS[m]) throw new Error('不支持的市场: ' + market);

  const key = `kl:${m}:${c}:${period}:${limit}`;
  const ttl = ['day', 'week', 'month'].includes(period) ? 60000 : 20000;
  const res = await cached(key, ttl, async () => {
    const errors = [];
    const tryEach = async (fns) => {
      for (const f of fns) {
        try {
          const r = await f();
          if (r && r.bars && r.bars.length >= 5) return r;
          errors.push('数据不足');
        } catch (e) { errors.push(String(e.message || e)); }
      }
      throw new Error(errors.join(' | '));
    };

    if (m === 'CR') return tryEach([() => binanceKline(c, period, limit)]);

    if (m === 'CNF') throw new Error('静态版暂不支持国内期货（数据源在浏览器端无跨域接口）');

    if (m === 'USF') {
      if (period !== 'day' && period !== 'week' && period !== 'month') return tryEach([() => emKline(m, c, period, limit)]);
      const daily = await tryEach([() => emKline(m, c, 'day', Math.min(limit * 2, 900))]);
      if (period === 'day') return { ...daily, bars: daily.bars.slice(-limit) };
      const agg = period === 'week' ? aggBars(daily.bars, weekKey) : aggBars(daily.bars, monthKey);
      return { bars: agg.slice(-limit), source: daily.source + '+agg' };
    }

    if (period === 'day' || period === 'week' || period === 'month') {
      if (m === 'A') return tryEach([() => tencentFq(m, c, period, limit), () => emKline(m, c, period, limit)]);
      if (m === 'HK') return tryEach([() => tencentFq(m, c, period, limit), () => emKline(m, c, period, limit)]);
      if (m === 'US') {
        const daily = await tryEach([() => emKline(m, c, 'day', Math.min(limit * 2 + 60, 900))]);
        if (period === 'day') return { ...daily, bars: daily.bars.slice(-limit) };
        const agg = period === 'week' ? aggBars(daily.bars, weekKey) : aggBars(daily.bars, monthKey);
        return { bars: agg.slice(-limit), source: daily.source + '+agg' };
      }
    }

    if (m === 'A') return tryEach([() => tencentMinute(c, period, limit), () => emKline(m, c, period, limit)]);
    return tryEach([() => emKline(m, c, period, limit)]);
  });

  const out = res.value;
  const bars = out.bars || [];
  const lastT = bars.length ? bars[bars.length - 1].t : 0;
  const dataAgeDays = lastT ? Math.round((Date.now() - lastT) / 86400000) : null;
  const staleLimit = ['day', 'week', 'month'].includes(period) ? 10 : 3;
  return {
    market: m,
    code: c,
    period,
    periodName: PERIOD_NAME[period],
    source: out.source,
    stale: !!res.stale,
    intradayOnly: !!out.intradayOnly,
    dataAgeDays,
    staleData: dataAgeDays != null && dataAgeDays > staleLimit,
    bars,
  };
}

/* ---------------- 搜索（无跨域接口，改为代码直查 + 期货/币静态表） ---------------- */
const FUTURES_NAMES = {
  ES: '标普500期货', NQ: '纳指100期货', YM: '道指期货', GC: '黄金期货', SI: '白银期货', CL: '原油期货', NG: '天然气期货',
  CU0: '沪铜主力', AL0: '沪铝主力', AU0: '沪金主力', AG0: '沪银主力', RB0: '螺纹钢主力', HC0: '热卷主力',
  M0: '豆粕主力', Y0: '豆油主力', P0: '棕榈油主力', I0: '铁矿石主力', J0: '焦炭主力', JM0: '焦煤主力',
  SR0: '白糖主力', CF0: '棉花主力', TA0: 'PTA主力', MA0: '甲醇主力', FG0: '玻璃主力', SA0: '纯碱主力',
  IF0: '沪深300股指主力', IC0: '中证500股指主力', IH0: '上证50股指主力', IM0: '中证1000股指主力',
};
const COIN_ALIAS = { 比特币: 'BTC', 以太坊: 'ETH', 币安币: 'BNB', 索拉纳: 'SOL', 瑞波: 'XRP', 狗狗币: 'DOGE', 莱特币: 'LTC' };

async function search(q) {
  const raw = String(q || '').trim();
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  const push = (market, code, name, type) => {
    const k = market + ':' + code;
    if (seen.has(k) || out.length >= 16) return;
    seen.add(k);
    out.push({ market, code, name: name || code, type });
  };

  // 期货代码 / 名称
  const kw = raw.toUpperCase();
  for (const [code, name] of Object.entries(FUTURES_NAMES)) {
    if (code.includes(kw) || name.includes(raw)) push(code.endsWith('0') ? 'CNF' : 'USF', code, name, 'futures');
  }
  // 加密货币
  for (const [alias, base] of Object.entries(COIN_ALIAS)) {
    if (raw.includes(alias) || alias.includes(raw) || kw === base) push('CR', base + 'USDT', alias + ' (' + base + ')', 'crypto');
  }

  // A 股：6 位数字直接查腾讯报价拿名称
  if (/^\d{6}$/.test(raw)) {
    try {
      const qs = await quotes([{ market: 'A', code: raw }]);
      const hit = qs[0];
      if (hit && hit.price) push('A', hit.code, hit.name, 'stock');
    } catch (e) {}
  } else if (/^\d{5}$/.test(raw)) {
    try {
      const qs = await quotes([{ market: 'HK', code: raw }]);
      const hit = qs[0];
      if (hit && hit.price) push('HK', hit.code, hit.name, 'stock');
    } catch (e) {}
  } else if (/^[A-Za-z.]{1,6}$/.test(raw)) {
    const sym = raw.toUpperCase();
    try {
      const qs = await quotes([{ market: 'US', code: sym }]);
      const hit = qs[0];
      if (hit && hit.price) push('US', hit.code, hit.name, 'stock');
    } catch (e) {}
  }
  return out;
}

/* ---------------- 数据源探测（静态模式只能给出能力说明） ---------------- */
const PROBES = [
  { id: 'tencent-quote', name: '腾讯行情（A/港/美 实时）', url: 'https://qt.gtimg.cn/q=sh000001', markets: ['A', 'HK', 'US'] },
  { id: 'tencent-kline', name: '腾讯K线（A/港 日周月）', url: 'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,5,qfq', markets: ['A', 'HK'] },
  { id: 'tencent-minute', name: '腾讯分钟线（A股）', url: 'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m5,,5', markets: ['A'] },
  { id: 'eastmoney', name: '东财K线（美股/期货兜底）', url: 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=105.AAPL&klt=101&fqt=1&lmt=5', markets: ['US', 'CNF', 'USF'] },
  { id: 'binance', name: '币安公共行情（加密）', url: 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT', markets: ['CR'] },
];

async function probe() {
  const list = [];
  for (const p of PROBES) {
    const t0 = Date.now();
    try {
      const r = await fetch(p.url, { cache: 'no-store' });
      list.push({ ...p, ok: r.ok, status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      list.push({ ...p, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
    }
  }
  return list;
}

async function fredSeries() {
  throw new Error('静态模式不支持 FRED 宏观序列');
}

module.exports = {
  MARKETS, PERIOD_NAME, PERIOD_MINUTES, normCode, tcCode, bnSymbol,
  quotes, klines, search, probe, fredSeries,
  FRED_SERIES: { DGS10: '10年期美债收益率', DGS2: '2年期美债收益率', VIXCLS: 'VIX 恐慌指数' },
};
