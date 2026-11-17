/* 静态模式 API 兼容层
 *
 * GitHub Pages 只能托管静态文件，没有 Node 后端。
 * 这里在浏览器里把原 server/index.js 的业务逻辑原样跑起来，并拦截 /api/* 请求，
 * 于是原前端（包括 ?m=&c=&p=#page 这套 URL 参数）完全不用改。
 *
 * 行情来源见 server/lib/sources-browser.js（只选允许跨域的公开接口）。
 */
(function () {
  'use strict';

  window.process = window.process || { env: {} };

  const S = window.__chanLoad('sources');
  const SECTORS = window.__chanLoad('sectors');
  const C = window.__chanLoad('chan');
  const V = window.__chanLoad('divination');
  const TIMING = window.__chanLoad('timing');
  const BT = window.__chanLoad('backtest');
  const META = window.__chanLoad('metaphysics');
  const K = window.__chanLoad('chan-lessons');
  const DRAW = window.__chanLoad('drawing');
  const GAME = window.__chanLoad('game');

  /* ---------------- 本地持久化 ---------------- */
  const LS_KEY = { watchlist: 'chan-watchlist', pool: 'chan-pool', drawings: 'chan-drawings' };
  const lsGet = (k, def) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : def;
    } catch (e) { return def; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  };

  /* ---------------- 自选 / 观察池 ---------------- */
  const WATCHLIST = {
    A: [
      { code: '600519', name: '贵州茅台' },
      { code: '300750', name: '宁德时代' },
      { code: '000001', name: '平安银行' },
      { code: '601899', name: '紫金矿业' },
      { code: '002594', name: '比亚迪' },
      { code: '688981', name: '中芯国际' },
    ],
    HK: [
      { code: '00700', name: '腾讯控股' },
      { code: '09988', name: '阿里巴巴-W' },
      { code: '03690', name: '美团-W' },
      { code: '01810', name: '小米集团-W' },
    ],
    US: [
      { code: 'NVDA', name: '英伟达' },
      { code: 'AAPL', name: '苹果' },
      { code: 'TSLA', name: '特斯拉' },
      { code: 'MSFT', name: '微软' },
    ],
    CR: [
      { code: 'BTCUSDT', name: 'BTC/USDT' },
      { code: 'ETHUSDT', name: 'ETH/USDT' },
      { code: 'SOLUSDT', name: 'SOL/USDT' },
      { code: 'BNBUSDT', name: 'BNB/USDT' },
    ],
    CNF: [],
    USF: [
      { code: 'ES', name: '标普500期货' },
      { code: 'NQ', name: '纳指100期货' },
      { code: 'GC', name: '黄金期货' },
      { code: 'CL', name: '原油期货' },
      { code: 'YM', name: '道指期货' },
    ],
  };

  const ALL_MK = ['A', 'HK', 'US', 'CR', 'CNF', 'USF'];
  const defaultWatchlist = () => JSON.parse(JSON.stringify(WATCHLIST));

  function normalizeWatchlist(raw) {
    const out = { A: [], HK: [], US: [], CR: [], CNF: [], USF: [] };
    for (const m of ALL_MK) {
      const list = Array.isArray(raw && raw[m]) ? raw[m] : [];
      const seen = new Set();
      for (const it of list) {
        if (!it || !it.code) continue;
        const code = S.normCode(m, it.code);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out[m].push({ code, name: String(it.name || code).slice(0, 28) });
        if (out[m].length >= 60) break;
      }
    }
    return out;
  }

  let WL = null;
  function loadWatchlist() {
    if (WL) return WL;
    const raw = lsGet(LS_KEY.watchlist, null);
    if (!raw) { WL = defaultWatchlist(); return WL; }
    const out = normalizeWatchlist(raw);
    const defs = defaultWatchlist();
    for (const m of ALL_MK) {
      if (!Object.prototype.hasOwnProperty.call(raw, m)) out[m] = defs[m] || [];
    }
    WL = out;
    return WL;
  }
  const saveWatchlist = () => lsSet(LS_KEY.watchlist, WL);

  /* 观察池默认名单：个人持仓（只放代码+名称，成本/持仓量属隐私，不进公开仓库） */
  const DEFAULT_POOL = {
    A: [
      { code: '300059', name: '东方财富' },
      { code: '000563', name: '陕国投A' },
      { code: '300622', name: '博士眼镜' },
      { code: '603759', name: '海天股份' },
      { code: '300210', name: '森远股份' },
      { code: '513010', name: '恒生科技ETF易方达' },
      { code: '159607', name: '中概互联网ETF嘉实' },
    ],
    HK: [],
    US: [],
    CR: [],
    CNF: [],
    USF: [],
  };

  const emptyPool = () => ({ A: [], HK: [], US: [], CR: [], CNF: [], USF: [] });

  /* 旧版本可能把观察池存成扁平数组 [{market,code,name,cost}]，转成按市场分组 */
  function poolFromFlatArray(arr) {
    const out = emptyPool();
    for (const it of arr) {
      if (!it || it.code == null) continue;
      const m = String(it.market || 'A').toUpperCase();
      if (!out[m]) continue;
      out[m].push(it);
    }
    return out;
  }

  let POOL = null;
  function loadPool() {
    if (POOL) return POOL;
    const raw = lsGet(LS_KEY.pool, null);
    if (!raw) { POOL = normalizeWatchlist(DEFAULT_POOL); return POOL; }
    const src = Array.isArray(raw) ? poolFromFlatArray(raw) : raw;
    POOL = normalizeWatchlist(src);
    // 归一化会丢 cost 等扩展字段，按「归一化后的代码」从原始数据回填；
    // 旧数据可能存的是 sh600519 / 600519.SH 这类写法，不能只做字符串相等比较。
    for (const m of ALL_MK) {
      const list = Array.isArray(src[m]) ? src[m] : [];
      const byCode = new Map();
      for (const x of list) {
        if (!x || x.code == null) continue;
        const c = S.normCode(m, x.code);
        if (c && !byCode.has(c)) byCode.set(c, x);
      }
      for (const it of POOL[m]) {
        const hit = byCode.get(it.code);
        if (hit && hit.cost != null && isFinite(Number(hit.cost))) it.cost = Number(hit.cost);
        if (hit && hit.qty != null && isFinite(Number(hit.qty)) && Number(hit.qty) > 0) it.qty = Number(hit.qty);
      }
    }
    return POOL;
  }
  const savePool = () => lsSet(LS_KEY.pool, POOL);

  /* 云端兜底：手机本地观察池为空时（清缓存/换机/无痕），自动从 chan-pools 快照拉回来 */
  (function syncPoolFromCloud() {
    try {
      if (lsGet(LS_KEY.pool, null)) return;
      if (sessionStorage.getItem('chan-pool-cloud-check') === '2') return;
      sessionStorage.setItem('chan-pool-cloud-check', '1');
      fetch('/chan-pools/data/latest.json?ts=' + Date.now(), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const p = j && j.pools && j.pools.pool;
          const codes = p && Array.isArray(p.codes) ? p.codes : null;
          if (!codes || !codes.length) {
            sessionStorage.setItem('chan-pool-cloud-check', '2');
            return;
          }
          const next = emptyPool();
          next.A = codes.map((x) => ({ code: String(x[0]), name: String(x[1] || x[0]) }));
          lsSet(LS_KEY.pool, next);
          POOL = null;
          sessionStorage.setItem('chan-pool-cloud-check', '2');
          location.replace(location.href);
        })
        .catch(() => {
          sessionStorage.setItem('chan-pool-cloud-check', '2');
        });
    } catch (e) {}
  })();

  /* ---------------- 手绘线 ---------------- */
  let DRAWINGS = null;
  function loadDrawings() {
    if (!DRAWINGS) DRAWINGS = lsGet(LS_KEY.drawings, {}) || {};
    return DRAWINGS;
  }
  const saveDrawings = () => lsSet(LS_KEY.drawings, DRAWINGS);
  const drawKey = (market, code, period) => {
    const m = String(market || 'A').toUpperCase();
    const norm = code ? S.normCode(m, code) || String(code).toUpperCase() : '';
    return `${m}:${norm}:${String(period || 'day')}`;
  };
  function sanitizeDrawing(d) {
    const type = ['trend', 'hline', 'rect', 'ray', 'note'].includes(d && d.type) ? d.type : 'trend';
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      id: String((d && d.id) || 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      type,
      x1: num(d && d.x1),
      y1: num(d && d.y1),
      ...(type === 'hline' ? {} : { x2: num(d && d.x2), y2: num(d && d.y2) }),
      label: String((d && d.label) || '').slice(0, 40),
      color: String((d && d.color) || '').slice(0, 16),
    };
  }

  /* ---------------- 业务组合（与原 server/index.js 一致） ---------------- */
  const INDEX_BOARD = [
    { market: 'A', code: 'sh000001', name: '上证指数' },
    { market: 'A', code: 'sz399001', name: '深证成指' },
    { market: 'A', code: 'sz399006', name: '创业板指' },
    { market: 'HK', code: 'hkHSI', name: '恒生指数' },
    { market: 'HK', code: 'hkHSCEI', name: '国企指数' },
    { market: 'US', code: 'usDJI', name: '道琼斯' },
    { market: 'US', code: 'usIXIC', name: '纳斯达克' },
    { market: 'US', code: 'usINX', name: '标普500' },
    { market: 'CR', code: 'BTCUSDT', name: 'BTC' },
    { market: 'CR', code: 'ETHUSDT', name: 'ETH' },
    { market: 'CNF', code: 'IF0', name: '沪深300主连' },
    { market: 'CNF', code: 'RB0', name: '螺纹钢主连' },
    { market: 'CNF', code: 'AU0', name: '沪金主连' },
    { market: 'USF', code: 'ES', name: '标普500期货' },
    { market: 'USF', code: 'NQ', name: '纳指期货' },
    { market: 'USF', code: 'GC', name: '黄金期货' },
  ];
  const SUITE_PERIODS = {
    A: ['day', '60m', '30m', '15m', '5m', '1m'],
    HK: ['day', 'week'],
    US: ['day', 'week'],
    CR: ['day', '4h', '60m', '15m', '5m', '1m'],
    CNF: ['day', '60m', '30m', '15m', '5m'],
    USF: ['day', '60m', '30m', '15m', '5m'],
  };
  const SIGNAL_WEIGHT = { '1B': 100, '2B': 92, '3B': 86, '1S': 100, '2S': 92, '3S': 86 };

  async function mapPool(list, limit, fn) {
    const out = new Array(list.length);
    let i = 0;
    const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
      while (i < list.length) {
        const idx = i++;
        out[idx] = await fn(list[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  function toItem(raw) {
    const p = String(raw).split(':');
    if (p.length === 2) return { market: p[0].toUpperCase(), code: p[1] };
    return { market: 'A', code: raw };
  }

  async function getQuoteMap(items) {
    const list = await S.quotes(items.map((it) => ({ market: it.market, code: it.code })));
    const map = new Map();
    for (const q of list) map.set(q.market + ':' + S.normCode(q.market, q.code), q);
    return map;
  }

  async function analyzeOne({ market, code, period, limit, withQuote = true }) {
    const m = String(market || 'A').toUpperCase();
    const kl = await S.klines({ market: m, code, period: period || 'day', limit: limit || 600 });
    const res = C.analyze(kl.bars, { period: kl.period, market: m, code: S.normCode(m, code) });
    res.quote = null;
    res.source = kl.source;
    res.stale = !!kl.stale;
    if (withQuote) {
      try {
        const qs = await S.quotes([{ market: m, code }]);
        res.quote = qs[0] || null;
        if (res.quote && res.quote.name && !res.name) res.name = res.quote.name;
      } catch (e) {}
    }
    return res;
  }

  async function radarScan({ scope = 'all', period = 'day', limit = 480 } = {}) {
    const markets = scope === 'all' ? ALL_MK.slice() : [scope.toUpperCase()];
    const wl = loadWatchlist();
    const items = [];
    for (const m of markets) for (const it of wl[m] || []) items.push({ market: m, ...it });

    const rows = await mapPool(items, 3, async (it) => {
      try {
        const r = await analyzeOne({ market: it.market, code: it.code, period, limit, withQuote: true });
        const bars = r.bars || [];
        const n = bars.length;
        const recent = (r.signals || []).filter((s) => s.barIdx >= n - 90);
        const last = recent[recent.length - 1] || null;
        const beichi = (r.beichi || []).filter((b) => b.barIdx >= n - 90);
        const score = last ? Math.max(0, SIGNAL_WEIGHT[last.type] + Math.max(-40, Math.round((last.barIdx - (n - 90)) / 3))) : 0;
        return {
          market: it.market,
          code: r.code || it.code,
          name: (r.quote && r.quote.name) || it.name,
          price: r.stats ? r.stats.price : null,
          pct: r.quote ? r.quote.pct : null,
          source: r.source,
          period,
          levelName: r.level.levelName,
          trend: r.trend.type,
          position: r.stats ? r.stats.position : 'none',
          pivot: r.stats && r.stats.activePivot ? r.stats.activePivot : null,
          signals: recent.slice(-3).map((s) => ({ type: s.type, name: s.name, price: s.price, barIdx: s.barIdx, t: s.t, note: s.note })),
          last,
          beichi: beichi.slice(-2).map((b) => ({ kind: b.kind, dir: b.dir, areaRatio: b.areaRatio, barIdx: b.barIdx, price: b.price })),
          summary: r.summary,
          score,
          bars: n,
        };
      } catch (e) {
        return { market: it.market, code: it.code, name: it.name, error: String(e.message || e), score: -1 };
      }
    });
    return { period, scope, generatedAt: Date.now(), cached: false, stale: false, rows: rows.sort((a, b) => (b.score || 0) - (a.score || 0)) };
  }

  async function suite({ market, code }) {
    const m = String(market || 'A').toUpperCase();
    const periods = SUITE_PERIODS[m] || ['day'];
    const results = await mapPool(periods, 3, async (p) => {
      try {
        const limit = ['day', 'week', 'month'].includes(p) ? 600 : 320;
        const kl = await S.klines({ market: m, code, period: p, limit });
        const res = C.analyze(kl.bars, { period: p, market: m, code });
        const sum = C.summarizeForSuite(res);
        return { ...sum, source: kl.source };
      } catch (e) {
        return { period: p, ok: false, error: String(e.message || e) };
      }
    });
    const ok = results.filter((r) => r.ok);
    const bullish = ok.filter((r) => r.beichi && r.beichi.dir < 0).length;
    const bearish = ok.filter((r) => r.beichi && r.beichi.dir > 0).length;
    const buySig = ok.filter((r) => r.signal && r.signal.type.endsWith('B')).length;
    const sellSig = ok.filter((r) => r.signal && r.signal.type.endsWith('S')).length;
    let resonance = '无多级别共振';
    if (buySig >= 2 || bullish >= 2) resonance = '多级别底部共振（买点窗口）';
    if (sellSig >= 2 || bearish >= 2) resonance = '多级别顶部共振（卖点窗口）';
    return { market: m, code: S.normCode(m, code), periods, levels: results, resonance };
  }

  async function overview() {
    const items = INDEX_BOARD.map((x) => ({ market: x.market, code: x.code }));
    const qm = await getQuoteMap(items);
    const indices = INDEX_BOARD.map((x) => {
      const q = qm.get(x.market + ':' + S.normCode(x.market, x.code));
      return {
        market: x.market, code: x.code, name: x.name,
        price: q ? q.price : null, pct: q ? q.pct : null, change: q ? q.change : null,
        high: q ? q.high : null, low: q ? q.low : null, timeText: q ? q.timeText : '',
      };
    });
    const wl = loadWatchlist();
    const watchItems = [];
    for (const m of ALL_MK) for (const it of wl[m] || []) watchItems.push({ market: m, ...it });
    const wm = await getQuoteMap(watchItems);
    const watch = watchItems.map((it) => {
      const q = wm.get(it.market + ':' + S.normCode(it.market, it.code));
      return {
        market: it.market, code: it.code, name: (q && q.name) || it.name,
        price: q ? q.price : null, pct: q ? q.pct : null, change: q ? q.change : null,
        high: q ? q.high : null, low: q ? q.low : null, prevClose: q ? q.prevClose : null,
        timeText: q ? q.timeText : '',
      };
    });
    const pulse = {};
    for (const m of ALL_MK) {
      const rows = watch.filter((w) => w.market === m && Number.isFinite(w.pct));
      const avg = rows.length ? rows.reduce((a, b) => a + b.pct, 0) / rows.length : 0;
      pulse[m] = {
        avgPct: +avg.toFixed(2),
        up: rows.filter((r) => r.pct > 0).length,
        down: rows.filter((r) => r.pct < 0).length,
        flat: rows.filter((r) => r.pct === 0).length,
        count: rows.length,
        heat: Math.max(0, Math.min(100, Math.round(50 + avg * 12))),
      };
    }
    return { asof: Date.now(), indices, watch, pulse };
  }

  /* ---------------- 路由 ---------------- */
  const routes = {
    '/api/health': async () => ({ ok: true, uptimeSec: Math.round(performance.now() / 1000), cache: { entries: 0 }, node: 'browser', assetVersion: 'static' }),
    '/api/markets': async () => ({ markets: S.MARKETS, watchlist: WATCHLIST, indices: INDEX_BOARD, periods: S.PERIOD_NAME, suite: SUITE_PERIODS }),
    '/api/overview': async () => overview(),
    '/api/macro': async () => ({
      asof: Date.now(),
      series: {
        DGS10: { name: '10年期美债收益率', error: '静态模式不支持 FRED' },
        DGS2: { name: '2年期美债收益率', error: '静态模式不支持 FRED' },
        VIXCLS: { name: 'VIX 恐慌指数', error: '静态模式不支持 FRED' },
      },
    }),
    '/api/sectors': async () => ({ sectors: SECTORS.catalog(), total: SECTORS.catalog().reduce((n, s) => n + s.count, 0) }),
    '/api/sector': async (u) => {
      const id = String(u.searchParams.get('id') || '').toLowerCase();
      const sec = SECTORS.catalog().find((s) => s.id === id);
      if (!sec) throw new Error('未知板块: ' + id);
      const qm = await getQuoteMap(sec.items.map((i) => ({ market: i.market, code: i.code })));
      return {
        id: sec.id, name: sec.name, desc: sec.desc,
        items: sec.items.map((it) => {
          const q = qm.get(it.market + ':' + S.normCode(it.market, it.code));
          return { ...it, price: q ? q.price : null, pct: q ? q.pct : null, change: q ? q.change : null, timeText: q ? q.timeText : '' };
        }),
      };
    },
    '/api/watchlist': async () => ({ list: loadWatchlist(), defaults: WATCHLIST }),
    '/api/pool': async () => ({ list: loadPool() }),
    '/api/keys': async () => ({ providers: {}, envFile: '（静态模式）' }),
    '/api/sources': async () => ({ probedAt: Date.now(), sources: await S.probe() }),
    '/api/search': async (u) => ({ q: u.searchParams.get('q') || '', items: await S.search(u.searchParams.get('q') || '') }),
    '/api/quote': async (u) => {
      const list = (u.searchParams.get('list') || '').split(',').filter(Boolean).map(toItem);
      if (!list.length) throw new Error('缺少 list 参数');
      return { quotes: await S.quotes(list) };
    },
    '/api/kline': async (u) => {
      const market = u.searchParams.get('market') || 'A';
      const code = u.searchParams.get('code') || u.searchParams.get('symbol');
      const period = u.searchParams.get('period') || 'day';
      const limit = Math.min(Number(u.searchParams.get('limit') || 600), 1000);
      return await S.klines({ market, code, period, limit });
    },
    '/api/chan': async (u) => {
      const market = u.searchParams.get('market') || 'A';
      const code = u.searchParams.get('code') || u.searchParams.get('symbol');
      const period = u.searchParams.get('period') || 'day';
      const limit = Math.min(Number(u.searchParams.get('limit') || 600), 1000);
      return await analyzeOne({ market, code, period, limit, withQuote: true });
    },
    '/api/suite': async (u) => suite({ market: u.searchParams.get('market'), code: u.searchParams.get('code') || u.searchParams.get('symbol') }),
    '/api/radar': async (u) => radarScan({ scope: u.searchParams.get('scope') || 'all', period: u.searchParams.get('period') || 'day' }),
    '/api/game/map': async () => ({ ok: true, ...GAME.buildMap(K), generatedAt: Date.now() }),
    '/api/game/level': async (u) => await GAME.makeLevel(K, Number(u.searchParams.get('no') || 1)),
    '/api/drawings': async (u) => {
      const key = drawKey(u.searchParams.get('market'), u.searchParams.get('code'), u.searchParams.get('period'));
      const rec = loadDrawings()[key] || { drawings: [], updatedAt: null };
      return { ok: true, key, drawings: rec.drawings || [], updatedAt: rec.updatedAt || null };
    },
    '/api/daily': async () => V.daily(),
    '/api/chan-lessons': async () => ({ themes: K.THEMES, lessons: K.LESSONS, coverage: K.COVERAGE }),
    '/api/chan-lore': async () => ({ lore: K.LORE, meta: K.LORE_META }),
    '/api/metaphysics': async (u) => {
      const id = u.searchParams.get('id');
      return id ? META.get(id) || { error: '未知体系' } : META.list();
    },
    '/api/timing': async (u) => {
      const methods = (u.searchParams.get('methods') || '').split(',').map((x) => x.trim()).filter(Boolean);
      return TIMING.evaluate({
        market: (u.searchParams.get('market') || 'A').toUpperCase(),
        code: u.searchParams.get('code') || u.searchParams.get('symbol') || '',
        ts: u.searchParams.get('ts') ? Number(u.searchParams.get('ts')) : Date.now(),
        methods: methods.length ? methods : undefined,
        weights: u.searchParams.get('weights') ? JSON.parse(u.searchParams.get('weights')) : undefined,
      });
    },
    '/api/timing/validate': async (u) => {
      const market = (u.searchParams.get('market') || 'A').toUpperCase();
      const code = u.searchParams.get('code') || u.searchParams.get('symbol') || '';
      const period = u.searchParams.get('period') || 'day';
      const kl = await S.klines({ market, code, period, limit: 800 });
      const methods = (u.searchParams.get('methods') || '').split(',').map((x) => x.trim()).filter(Boolean);
      const stats = BT.timingStats(kl.bars, (ts) => TIMING.evaluate({ market, code, ts, methods: methods.length ? methods : undefined }), {
        days: Number(u.searchParams.get('days') || 160),
        horizon: Number(u.searchParams.get('horizon') || 1),
      });
      return { market, code: S.normCode(market, code), period, periodName: kl.periodName, source: kl.source, bars: kl.bars.length, methodMeta: TIMING.METHODS, ...stats };
    },
    '/api/backtest': async (u) => {
      const market = (u.searchParams.get('market') || 'A').toUpperCase();
      const code = u.searchParams.get('code') || u.searchParams.get('symbol') || '';
      const period = u.searchParams.get('period') || 'day';
      const kl = await S.klines({ market, code, period, limit: 800 });
      const ana = C.analyze(kl.bars, { period, market, code });
      const stats = BT.signalStats(ana.bars, ana.signals, {
        horizon: Number(u.searchParams.get('horizon') || 5),
        feeBps: Number(u.searchParams.get('feeBps') || 8),
      });
      return { market, code: S.normCode(market, code), period, level: ana.level, source: kl.source, bars: ana.bars.length, signals: ana.signals.length, ...stats };
    },
    '/api/divination': async (u) => {
      const market = (u.searchParams.get('market') || 'A').toUpperCase();
      const code = u.searchParams.get('code') || u.searchParams.get('symbol') || '';
      const mode = u.searchParams.get('mode') || (u.searchParams.get('method') === 'time' ? 'time' : 'price');
      const nonce = Math.max(0, Math.trunc(Number(u.searchParams.get('nonce') || 0)));
      const ts = u.searchParams.get('ts') ? Number(u.searchParams.get('ts')) : undefined;
      let price = null;
      let pct = null;
      let qName = u.searchParams.get('name') || '';
      if (code && mode !== 'time') {
        try {
          const qs = await S.quotes([{ market, code }]);
          const q = qs[0];
          if (q && Number.isFinite(q.price) && q.price > 0) {
            price = q.price;
            pct = q.pct;
            qName = qName || q.name || '';
          }
        } catch (e) {}
      }
      return V.analyze({ market, code, name: qName, mode, nonce, ts, price, pct });
    },
  };

  /* ---------------- 写操作 ---------------- */
  async function handleWrite(path, method, body) {
    if (path === '/api/watchlist/reset' && method === 'POST') {
      WL = defaultWatchlist();
      saveWatchlist();
      return { ok: true, list: WL, message: '已恢复默认自选池' };
    }
    if (path === '/api/watchlist') {
      const wl = loadWatchlist();
      if (method === 'POST') {
        const market = String(body.market || 'A').toUpperCase();
        const code = body.code != null ? String(body.code) : '';
        if (!['A', 'HK', 'US', 'CR'].includes(market)) throw new Error('不支持的市场');
        if (!code.trim()) throw new Error('请填写代码');
        const norm = S.normCode(market, code);
        if (!norm) throw new Error('代码格式不正确');
        if (!wl[market]) wl[market] = [];
        if (wl[market].length >= 60) throw new Error('该市场自选已达 60 个上限');
        if (wl[market].some((x) => x.code === norm)) throw new Error('该标的已在自选池中');
        let name = String(body.name || '').trim();
        let quote = null;
        try {
          const qs = await S.quotes([{ market, code: norm }]);
          quote = qs && qs[0];
        } catch (e) {}
        if (quote && quote.price > 0) {
          if (!name) name = quote.name || norm;
        } else if (!name) {
          throw new Error('查不到该标的的行情，请检查代码');
        }
        if (wl[market].some((x) => x.code === norm)) throw new Error('该标的已在自选池中');
        wl[market].push({ code: norm, name: name || norm });
        saveWatchlist();
        return { ok: true, list: wl, added: { market, code: norm, name: name || norm } };
      }
      if (method === 'DELETE') {
        const market = String((body && body.market) || '').toUpperCase();
        const code = String((body && body.code) || '');
        if (!market || !code) throw new Error('缺少 market / code');
        const norm = S.normCode(market, code);
        if (wl[market]) wl[market] = wl[market].filter((x) => x.code !== norm);
        saveWatchlist();
        return { ok: true, list: wl, removed: { market, code: norm } };
      }
      return { ok: true, list: wl, defaults: WATCHLIST };
    }

    if (path === '/api/pool') {
      const pool = loadPool();
      if (method === 'POST') {
        const market = String(body.market || 'A').toUpperCase();
        const code = body.code != null ? String(body.code) : '';
        if (!ALL_MK.includes(market)) throw new Error('不支持的市场');
        if (!code.trim()) throw new Error('请填写代码');
        const norm = S.normCode(market, code);
        if (!norm) throw new Error('代码格式不正确');
        if (!pool[market]) pool[market] = [];
        if (pool[market].length >= 60) throw new Error('该市场观察池已达 60 个上限');
        if (pool[market].some((x) => x.code === norm)) throw new Error('该标的已在观察池中');
        let name = String(body.name || '').trim();
        let quote = null;
        try {
          const qs = await S.quotes([{ market, code: norm }]);
          quote = qs && qs[0];
        } catch (e) {}
        if (quote && quote.price > 0) {
          if (!name) name = quote.name || norm;
        } else if (!name) {
          throw new Error('查不到该标的的行情，请检查代码');
        }
        if (pool[market].some((x) => x.code === norm)) throw new Error('该标的已在观察池中');
        pool[market].push({ code: norm, name: name || norm });
        savePool();
        return { ok: true, list: pool, added: { market, code: norm, name: name || norm } };
      }
      if (method === 'DELETE') {
        const market = String((body && body.market) || '').toUpperCase();
        const code = String((body && body.code) || '');
        if (!market || !code) throw new Error('缺少 market / code');
        const norm = S.normCode(market, code);
        if (pool[market]) pool[market] = pool[market].filter((x) => x.code !== norm);
        savePool();
        return { ok: true, list: pool, removed: { market, code: norm } };
      }
      return { ok: true, list: pool };
    }

    if (path === '/api/pool/cost') {
      if (method !== 'POST') throw new Error('不支持的方法');
      const market = String(body.market || '').toUpperCase();
      const norm = S.normCode(market, String(body.code || ''));
      const pool = loadPool();
      const item = (pool[market] || []).find((x) => x.code === norm);
      if (!item) throw new Error('该标的不在观察池中');
      const raw = body.cost;
      const hasQty = Object.prototype.hasOwnProperty.call(body, 'qty');
      let costN = null;
      let qtyN = null;
      if (raw !== null && raw !== '' && raw !== undefined) {
        costN = Number(raw);
        if (!Number.isFinite(costN) || costN <= 0) throw new Error('成本价需为正数，留空则清除');
      }
      if (hasQty) {
        const rq = body.qty;
        if (rq !== null && rq !== '' && rq !== undefined) {
          qtyN = Number(rq);
          if (!Number.isFinite(qtyN) || qtyN <= 0) throw new Error('持仓数量需为正数，留空则清除');
        }
      }
      if (costN == null) delete item.cost;
      else item.cost = costN;
      if (hasQty) {
        if (qtyN == null) delete item.qty;
        else item.qty = qtyN;
      }
      savePool();
      return {
        ok: true,
        list: pool,
        updated: { market, code: norm, cost: item.cost != null ? item.cost : null, qty: item.qty != null ? item.qty : null },
      };
    }

    if (path === '/api/drawings') {
      if (method === 'POST') {
        const key = drawKey(body.market, body.code, body.period);
        if (!body.code) throw new Error('缺少 code');
        const all = Array.isArray(body.drawings) ? body.drawings : [];
        const kept = all.length > 40 ? all.slice(-40) : all;
        const list = kept.map(sanitizeDrawing);
        loadDrawings()[key] = { drawings: list, updatedAt: Date.now() };
        saveDrawings();
        return { ok: true, key, count: list.length, dropped: Math.max(0, all.length - 40), drawings: list };
      }
      const key = drawKey((body && body.market), (body && body.code), (body && body.period));
      const rec = loadDrawings()[key] || { drawings: [], updatedAt: null };
      return { ok: true, key, drawings: rec.drawings || [], updatedAt: rec.updatedAt || null };
    }

    if (path === '/api/drawings/verify' && method === 'POST') {
      const market = String(body.market || 'A').toUpperCase();
      const code = body.code || '';
      const period = body.period || 'day';
      const drawings = Array.isArray(body.drawings) ? body.drawings.slice(0, 40) : [];
      const res = await analyzeOne({ market, code, period, limit: 600, withQuote: false });
      if (!res || !res.ok) throw new Error('行情不可用，暂时无法校验');
      const out = DRAW.verify({ drawings, analysis: res, market, code, period });
      out.target = { market, code, name: res.name || '', price: res.quote ? res.quote.price : null };
      out.analysisSummary = {
        trend: res.trend && res.trend.type,
        bis: (res.bis || []).length,
        pivots: (res.pivots || []).length,
        signals: (res.signals || []).slice(-3).map((s) => ({ type: s.type, name: s.name, barIdx: s.barIdx, price: s.price })),
      };
      return out;
    }

    if (path === '/api/game/answer' && method === 'POST') {
      return await GAME.gradeLevel(K, { no: body.no, token: body.token, attemptId: body.attemptId, answer: body.answer });
    }

    if (path === '/api/daily') return V.daily();
    throw new Error('未知接口: ' + path);
  }

  async function handleApi(u, method, body) {
    if (method !== 'GET') return await handleWrite(u.pathname, method, body || {});
    if (u.pathname === '/api/pool') return { ok: true, list: loadPool() };
    const fn = routes[u.pathname];
    if (!fn) throw new Error('未知接口: ' + u.pathname);
    return await fn(u);
  }

  /* ---------------- 拦截 fetch ---------------- */
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    let url;
    let method = (init && init.method) || 'GET';
    let rawBody = '';
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else {
      url = input.url;
      method = input.method || method;
    }
    if (init && init.method) method = init.method;
    if (init && init.body != null) rawBody = String(init.body);

    const u = new URL(url, location.href);
    if (!u.pathname.startsWith('/api/')) return nativeFetch(input, init);

    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch (e) { body = {}; }
    }
    try {
      const data = await handleApi(u, method.toUpperCase(), body);
      return new Response(JSON.stringify({ ok: true, ...data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const status = /未知|不支持|非法|无效|参数|缺少/.test(msg) ? 400 : 500;
      return new Response(JSON.stringify({ ok: false, error: msg, path: u.pathname }), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  };
})();
