'use strict';
/**
 * 把 server/lib 下可在浏览器运行的 CommonJS 模块打包成一个静态文件。
 * 这些模块只依赖彼此（扁平目录），因此用 30 行的模块加载器即可，无需 npm 依赖。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'server', 'lib');
const OUT = path.join(ROOT, 'docs', 'js', 'static', 'chan-core.js');

const MAP = [
  ['chan', 'chan.js'],
  ['sectors', 'sectors.js'],
  ['backtest', 'backtest.js'],
  ['divination', 'divination.js'],
  ['ganzhi', 'ganzhi.js'],
  ['lunar', 'lunar.js'],
  ['gua-data', 'gua-data.js'],
  ['qimen', 'qimen.js'],
  ['ziwei', 'ziwei.js'],
  ['timing', 'timing.js'],
  ['drawing', 'drawing.js'],
  ['game', 'game.js'],
  ['chan-lessons', 'chan-lessons.js'],
  ['metaphysics', 'metaphysics.js'],
  ['sources', 'sources-browser.js'],
  ['crypto', 'crypto-shim.js'],
];

let out = `/* 自动生成：node tools/build-bundle.js —— 请勿手改 */
(function () {
  'use strict';
  var defs = Object.create(null);
  var cache = Object.create(null);

  function define(id, fn) { defs[id] = fn; }

  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error('[chan-core] 模块不存在: ' + id);
    var mod = { exports: {} };
    cache[id] = mod;
    var localRequire = function (rel) {
      if (rel.charAt(0) === '.') rel = rel.replace(/^\\.\\//, '');
      return load(rel);
    };
    defs[id](mod, mod.exports, localRequire);
    return mod.exports;
  }

  window.__chanLoad = load;

`;

for (const [id, file] of MAP) {
  const full = path.join(LIB, file);
  const src = fs.readFileSync(full, 'utf8').replace(/<\/script/gi, '<\\/script');
  out += `  /* ---- ${id} (${file}) ---- */\n`;
  out += `  define(${JSON.stringify(id)}, function (module, exports, require) {\n`;
  out += src;
  out += `\n  });\n\n`;
}

out += `})();\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log('已生成', path.relative(ROOT, OUT), (out.length / 1024).toFixed(1) + ' KB');
