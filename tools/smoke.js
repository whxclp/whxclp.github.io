'use strict';
/* 本地冒烟测试：不依赖浏览器，验证浏览器数据层 + 缠论分析是否可用 */
global.window = globalThis;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
global.window.process = { env: {} };
require('../docs/js/static/chan-core.js');

const S = window.__chanLoad('sources');
const C = window.__chanLoad('chan');
const G = window.__chanLoad('game');

(async () => {
  const cases = [
    ['A', '600519', 'day'],
    ['A', '600519', '5m'],
    ['HK', '00700', 'day'],
    ['US', 'AAPL', 'day'],
    ['CR', 'BTCUSDT', 'day'],
    ['CNF', 'RB0', 'day'],
  ];
  for (const [market, code, period] of cases) {
    try {
      const kl = await S.klines({ market, code, period, limit: 300 });
      const a = C.analyze(kl.bars, { market, code, period });
      console.log(`OK  ${market} ${code} ${period}: bars=${kl.bars.length} src=${kl.source} last=${new Date(kl.bars[kl.bars.length - 1].t).toISOString().slice(0, 10)} pivots=${a.pivots.length} signals=${a.signals.length}`);
    } catch (e) {
      console.log(`FAIL ${market} ${code} ${period}: ${e.message}`);
    }
  }
  try {
    const q = await S.quotes([{ market: 'A', code: '600519' }, { market: 'US', code: 'AAPL' }, { market: 'CR', code: 'BTCUSDT' }]);
    console.log('quotes:', q.map((x) => `${x.market}/${x.code} ${x.name} ${x.price} ${x.pct}%`).join(' | '));
  } catch (e) {
    console.log('quotes FAIL:', e.message);
  }
  try {
    console.log('search 600519:', JSON.stringify(await S.search('600519')));
  } catch (e) {
    console.log('search FAIL:', e.message);
  }
  try {
    const lv = await G.makeLevel(window.__chanLoad('chan-lessons'), 1);
    console.log('game level ok:', !!lv && !!lv.token);
  } catch (e) {
    console.log('game FAIL:', e.message);
  }
})();
