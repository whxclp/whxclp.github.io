/* 自动生成：node tools/build-bundle.js —— 请勿手改 */
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
      if (rel.charAt(0) === '.') rel = rel.replace(/^\.\//, '');
      return load(rel);
    };
    defs[id](mod, mod.exports, localRequire);
    return mod.exports;
  }

  window.__chanLoad = load;

  /* ---- chan (chan.js) ---- */
  define("chan", function (module, exports, require) {
'use strict';
/**
 * 缠论结构引擎（零依赖）
 *
 * 处理链：原始K线 → 包含处理 → 分型 → 笔 → 线段(特征序列) → 中枢 → 走势类型
 *        → 背驰(MACD 面积/黄白线) → 一/二/三类买卖点 → 区间套与状态叙述
 *
 * 简化声明（诚实标注）：
 * 1) 线段用标准特征序列法判定，缺口（第二种情况）按简化处理，不做二次确认；
 * 2) 中枢以「笔中枢」为主（连续三笔重叠），线段中枢作为升级提示；
 * 3) 背驰用 MACD 红绿柱面积 + DIF 极值做同向两段力度比较，属于缠论标准做法的
 *    常用数值化近似，非唯一实现。
 */

const PERIOD_META = {
  '1m': { levelNo: 1, levelName: '1分钟级别', short: '1F' },
  '5m': { levelNo: 2, levelName: '5分钟级别', short: '5F' },
  '15m': { levelNo: 3, levelName: '15分钟级别', short: '15F' },
  '30m': { levelNo: 4, levelName: '30分钟级别', short: '30F' },
  '60m': { levelNo: 5, levelName: '60分钟级别', short: '60F' },
  '4h': { levelNo: 5, levelName: '4小时级别', short: '4H' },
  day: { levelNo: 6, levelName: '日线级别', short: 'D' },
  week: { levelNo: 7, levelName: '周线级别', short: 'W' },
  month: { levelNo: 8, levelName: '月线级别', short: 'M' },
};

const SIGNAL_NAME = {
  '1B': '第一类买点', '2B': '第二类买点', '3B': '第三类买点',
  '1S': '第一类卖点', '2S': '第二类卖点', '3S': '第三类卖点',
};

/* ------------------------------------------------------------------ */
/* 指标                                                                */
/* ------------------------------------------------------------------ */

function emaSeries(vals, n) {
  const k = 2 / (n + 1);
  const out = new Array(vals.length);
  let prev = vals[0] || 0;
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const dif = closes.map((_, i) => ef[i] - es[i]);
  const dea = emaSeries(dif, sig);
  const hist = dif.map((v, i) => (v - dea[i]) * 2);
  return { dif, dea, hist };
}

/* ------------------------------------------------------------------ */
/* 1. 包含处理                                                         */
/* ------------------------------------------------------------------ */

function mergeBars(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!out.length) {
      out.push({ h: b.h, l: b.l, i0: i, i1: i, dir: 1, c: b.c });
      continue;
    }
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    let dir = last.dir;
    if (prev) {
      if (last.h > prev.h && last.l > prev.l) dir = 1;
      else if (last.h < prev.h && last.l < prev.l) dir = -1;
    }
    const includes = (last.h >= b.h && last.l <= b.l) || (b.h >= last.h && b.l <= last.l);
    if (includes) {
      if (dir > 0) {
        last.h = Math.max(last.h, b.h);
        last.l = Math.max(last.l, b.l);
      } else {
        last.h = Math.min(last.h, b.h);
        last.l = Math.min(last.l, b.l);
      }
      last.i1 = i;
      last.c = b.c;
      last.dir = dir;
    } else {
      out.push({ h: b.h, l: b.l, i0: i, i1: i, dir, c: b.c });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 分型                                                             */
/* ------------------------------------------------------------------ */

function findFractals(merged, bars) {
  const list = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1];
    const b = merged[i];
    const c = merged[i + 1];
    const isTop = b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l;
    const isBottom = b.l < a.l && b.l < c.l && b.h < a.h && b.h < c.h;
    if (!isTop && !isBottom) continue;
    let extremeIdx = b.i0;
    let extreme = bars[b.i0].h;
    for (let k = b.i0; k <= b.i1; k++) {
      if (isTop ? bars[k].h > extreme : bars[k].l < extreme) {
        extreme = isTop ? bars[k].h : bars[k].l;
        extremeIdx = k;
      }
    }
    list.push({
      type: isTop ? 'top' : 'bottom',
      mi: i,
      price: isTop ? bars[extremeIdx].h : bars[extremeIdx].l,
      barIdx: extremeIdx,
      h: b.h,
      l: b.l,
    });
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* 3. 笔                                                               */
/* ------------------------------------------------------------------ */

function buildBis(fractals) {
  const bis = [];
  if (fractals.length < 2) return bis;
  let cur = fractals[0];
  for (let i = 1; i < fractals.length; i++) {
    const f = fractals[i];
    if (f.type === cur.type) {
      const better = cur.type === 'top' ? f.price > cur.price : f.price < cur.price;
      if (better) {
        // 同类型更极端的分型 → 延长最后一笔（保持笔首尾相连）
        const lastBi = bis[bis.length - 1];
        if (lastBi && lastBi._e === cur) {
          lastBi.p1 = f.price;
          lastBi.i1 = f.barIdx;
          lastBi.endBar = f.barIdx;
          lastBi.h = Math.max(lastBi.p0, f.price);
          lastBi.l = Math.min(lastBi.p0, f.price);
          lastBi.len = f.barIdx - lastBi.startBar;
          lastBi._e = f;
        } else if (!bis.length) {
          cur = f;
          continue;
        }
        cur = f;
      }
      continue;
    }
    // 严格笔：顶底之间至少间隔一根独立K线（合并后索引差 >= 4）
    if (f.mi - cur.mi < 4) continue;
    const p0 = cur.price;
    const p1 = f.price;
    const dir = f.type === 'top' ? 1 : -1;
    const bar0 = bis.length ? bis[bis.length - 1].i1 : cur.barIdx;
    bis.push({
      dir, // 1 向上笔, -1 向下笔
      i0: cur.barIdx,
      i1: f.barIdx,
      p0,
      p1,
      h: Math.max(p0, p1),
      l: Math.min(p0, p1),
      from: cur.type,
      to: f.type,
      startBar: cur.barIdx,
      endBar: f.barIdx,
      len: f.barIdx - cur.barIdx,
      _bar0: bar0,
      _s: cur,
      _e: f,
    });
    cur = f;
  }
  return bis;
}

/* ------------------------------------------------------------------ */
/* 4. 线段（特征序列法）                                                */
/* ------------------------------------------------------------------ */

/**
 * 线段（近似划分：把「笔」当作 K 线，做包含处理 + 分型，端点交替取极值）
 *
 * 严格的特征序列法需要处理缺口第二种情况与二次确认，实盘软件多数采用本近似：
 * 线段至少包含 3 笔；相邻线段首尾相接；端点取该区间内同向笔的极值。
 */
function buildSegments(bis) {
  const segs = [];
  if (bis.length < 4) return segs;
  // 线段分型：连续三笔中，第三笔未能创新高/新低 → 前一笔的极值为线段端点
  const cands = [];
  for (let i = 0; i + 2 < bis.length; i++) {
    if (bis[i].dir === 1 && bis[i + 2].dir === 1 && bis[i].p1 > bis[i + 2].p1) {
      cands.push({ type: 'top', bi: i, price: bis[i].p1, bar: bis[i].i1 });
    } else if (bis[i].dir === -1 && bis[i + 2].dir === -1 && bis[i].p1 < bis[i + 2].p1) {
      cands.push({ type: 'bottom', bi: i, price: bis[i].p1, bar: bis[i].i1 });
    }
  }
  const pts = [];
  for (const f of cands) {
    const last = pts[pts.length - 1];
    if (!last) {
      pts.push(f);
      continue;
    }
    if (f.type === last.type) {
      const better = f.type === 'top' ? f.price > last.price : f.price < last.price;
      if (better) pts[pts.length - 1] = f;
      continue;
    }
    if (f.bi - last.bi < 2) continue;
    pts.push(f);
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    segs.push(makeSegment(bis, a.bi, b.bi, a.type === 'bottom' ? 1 : -1, true));
  }
  const lastPt = pts[pts.length - 1];
  const startBi = lastPt ? lastPt.bi : 0;
  if (startBi < bis.length - 1) {
    segs.push(makeSegment(bis, startBi, bis.length - 1, bis[startBi].dir, false));
  }
  return segs;
}

function makeSegment(bis, a, b, dir, done) {
  if (b < a) {
    const t = a;
    a = b;
    b = t;
  }
  const slice = bis.slice(a, b + 1);
  return {
    dir,
    startBi: a,
    endBi: b,
    i0: bis[a].i0,
    i1: bis[b].i1,
    p0: bis[a].p0,
    p1: bis[b].p1,
    h: Math.max(...slice.map((x) => x.h)),
    l: Math.min(...slice.map((x) => x.l)),
    bars: bis[b].i1 - bis[a].i0,
    done,
  };
}

/* ------------------------------------------------------------------ */
/* 5. 中枢                                                             */
/* ------------------------------------------------------------------ */

function buildPivots(bis, bars) {
  /*
    缠论中枢定义（严格版）：
      ① 中枢本体由「至少三段次级别走势」相互重叠构成；
      ② 区间 ZG = min(各段高点)，ZD = max(各段低点)，且要求 ZG > ZD；
      ③ 区间在**形成那一刻就固定**：之后的震荡只要不完全离开，就只是"延伸"，
         不得扩大/收缩 ZG、ZD（这是最常见的画错点）；
      ④ 中枢之前与中枢首段反向的那一段是「进入段」；
         中枢之后第一条**终点离开中枢区间**（p1 > ZG 或 p1 < ZD）的笔是「离开段」。
         注意：离开段的**起点必然贴着中枢边界**（走势从中枢里走出来），所以不能要求
         "整段都在区间外"——那是自相矛盾（实测 600519 的 12 个中枢全部不满足）。
         判据只看终点，这与"延伸=终点仍在内"互为补集；
      ⑤ 中枢内段数 ≥ 9 时升级为高一级别中枢。
  */
  const out = [];
  let i = 1; // 从第 1 段开始：需要前面有段可以当"进入段"
  let guard = 0;
  while (i + 2 < bis.length && guard++ < 500) {
    const tri = [bis[i], bis[i + 1], bis[i + 2]];
    const zg = Math.min(...tri.map((b) => b.h));
    const zd = Math.max(...tri.map((b) => b.l));
    if (!(zg > zd)) {
      i += 1;
      continue;
    }
    let gg = Math.max(...tri.map((b) => b.h));
    let dd = Math.min(...tri.map((b) => b.l));

    // —— 延伸：后续段的**终点**仍落在中枢区间内 = 还在中枢里震荡（不是离开）
    //    判据必须看端点而不是"整段是否与区间相交"：像 1142→1806 这种整段穿越中枢的，
    //    是典型的「离开段」，绝不能被吞进中枢（否则中枢会被拉成长条，画面全错）。
    let j = i + 3;
    while (j < bis.length) {
      const b = bis[j];
      const endsInside = b.p1 <= zg && b.p1 >= zd;
      if (!endsInside) break;
      gg = Math.max(gg, b.h);
      dd = Math.min(dd, b.l);
      j++;
    }

    const endBi = j - 1; // 中枢内最后一段
    const innerCount = endBi - i + 1;
    const enterBi = i - 1 >= 0 ? i - 1 : null;
    const leaveBi = j < bis.length ? j : null;
    out.push({
      idx: out.length,
      startBi: i,
      endBi,
      enterBi,
      leaveBi,
      zg,
      zd,
      gg,
      dd,
      height: zg - zd,
      count: innerCount,
      i0: bis[i].i0,
      i1: bis[endBi].i1,
      t0: bars[bis[i].i0].t,
      t1: bars[bis[endBi].i1].t,
      // 进/离段的极值，画图时用来标注进入段、离开段
      enter: enterBi != null ? { bi: enterBi, i0: bis[enterBi].i0, i1: bis[enterBi].i1, p0: bis[enterBi].p0, p1: bis[enterBi].p1, dir: bis[enterBi].dir } : null,
      leave: leaveBi != null ? { bi: leaveBi, i0: bis[leaveBi].i0, i1: bis[leaveBi].i1, p0: bis[leaveBi].p0, p1: bis[leaveBi].p1, dir: bis[leaveBi].dir } : null,
      upgraded: innerCount >= 9,
      status: leaveBi != null ? 'done' : 'ongoing',
    });
    /*
      下一轮从「离开段之后」开始找：离开段 j 是中枢 A 的离开段，
      它同时也是中枢 B 的进入段（enterBi = j）。若从 j 本身开始扫，
      B 就会把 j 当成本体第一笔，于是出现「A 的离开段 = B 的区间首笔」，
      画出来就是一堆首尾相接、互相套娃的中枢（用户一开始就指出的问题）。
    */
    i = Math.max(i + 1, j + 1);
  }
  return mergeAdjacent(out, bis);
}

/*
  中枢扩展 / 合并（缠论）
  ------------------------------------------------------------------
  **不合并**。两个中枢就是两个中枢——哪怕区间有重叠。
  理由：
    ① 每个中枢的 ZG/ZD 是它自己前三段的重叠区，合并后无论取交集还是并集，
       都会让**其中一个中枢的边界失真**（取交集变窄→把震荡区划到中枢外；
       取并集变宽→把不属于它的走势吞进来）；
    ② 缠论里"中枢扩展/升级"是**级别**概念，不是把两个中枢压成一个；
    ③ 图上并排画两个中枢 + 各自的进/离段，才是真实的走势结构。

  这里只做一件轻量的事：给相邻且区间重叠的中枢打上 `overlapPrev: true`，
  让前端可以提示"这两个中枢有重叠，属于中枢扩展形态"，但**不改几何**。
*/
function mergeAdjacent(pivots, bis) {
  if (pivots.length < 2) return pivots.map((p, idx) => annotate(p, idx, bis, null));
  const out = [];
  for (let k = 0; k < pivots.length; k++) {
    const prev = k > 0 ? pivots[k - 1] : null;
    out.push(annotate(pivots[k], k, bis, prev));
  }
  return out;
}

/** 补 enter/leave 细节 + 相邻重叠提示（不改几何） */
function annotate(p, idx, bis, prev) {
  const overlapPrev = !!prev && Math.min(p.zg, prev.zg) > Math.max(p.zd, prev.zd);
  return {
    ...p,
    idx,
    enter: p.enterBi != null ? { bi: p.enterBi, i0: bis[p.enterBi].i0, i1: bis[p.enterBi].i1, p0: bis[p.enterBi].p0, p1: bis[p.enterBi].p1, dir: bis[p.enterBi].dir } : null,
    leave: p.leaveBi != null ? { bi: p.leaveBi, i0: bis[p.leaveBi].i0, i1: bis[p.leaveBi].i1, p0: bis[p.leaveBi].p0, p1: bis[p.leaveBi].p1, dir: bis[p.leaveBi].dir } : null,
    overlapPrev,
  };
}

function classifyTrend(pivots) {
  const rels = [];
  for (let i = 1; i < pivots.length; i++) {
    const a = pivots[i - 1];
    const b = pivots[i];
    if (b.zd > a.zg) rels.push('up');
    else if (b.zg < a.zd) rels.push('down');
    else rels.push('overlap');
  }
  let dir = null;
  let run = 0;
  for (let i = rels.length - 1; i >= 0; i--) {
    if (rels[i] === 'overlap') break;
    if (dir == null) {
      dir = rels[i];
      run = 1;
    } else if (rels[i] === dir) run++;
    else break;
  }
  let type = '盘整';
  let sub = '中枢震荡';
  if (pivots.length < 2) {
    type = '盘整';
    sub = '单一中枢的盘整走势';
  } else if (dir === 'up') {
    type = '上涨趋势';
    sub = run >= 2 ? `连续 ${run + 1} 个中枢依次抬高` : '两个中枢不重叠且依次抬高';
  } else if (dir === 'down') {
    type = '下跌趋势';
    sub = run >= 2 ? `连续 ${run + 1} 个中枢依次降低` : '两个中枢不重叠且依次降低';
  } else if (pivots.length >= 2) {
    type = '盘整';
    sub = '中枢重叠扩展/升级中';
  }
  return { type, sub, relations: rels };
}

/* ------------------------------------------------------------------ */
/* 6. 力度比较与背驰                                                    */
/* ------------------------------------------------------------------ */

function moveEnergy(from, to, dir, macdData) {
  const { dif, hist } = macdData;
  let area = 0;
  let peak = dir > 0 ? -Infinity : Infinity;
  for (let k = from; k <= to; k++) {
    const h = hist[k] || 0;
    area += dir > 0 ? Math.max(0, h) : Math.max(0, -h);
    if (dir > 0) peak = Math.max(peak, dif[k] || 0);
    else peak = Math.min(peak, dif[k] || 0);
  }
  return { area, peak };
}

/**
 * 背驰判定
 * 1) 段背驰（主）：相邻同向线段比较，价格创新高/新低但 MACD 面积缩小 → 背驰
 * 2) 笔背驰（辅）：两个中枢之间的同向笔比较，同样以面积缩小 + 极值创新为准
 * 都是「同向、同级别、后一段力度明显弱于前一段」这一条缠论核心规则的数值化近似。
 */
function detectBeichi(bis, segs, pivots, macdData, bars) {
  const out = [];
  const segE = (s) => moveEnergy(s.i0, s.i1, s.dir, macdData);
  const biE = (b) => moveEnergy(b.i0, b.i1, b.dir, macdData);
  const push = (o) => {
    if (out.some((x) => x.barIdx === o.barIdx && x.kind === o.kind)) return;
    const bi = bis.find((b) => b.i1 === o.barIdx);
    out.push({ ...o, biIdx: bi ? bis.indexOf(bi) : null });
  };

  // 段背驰：线段方向天然交替，只能与「同向的前一段」比较（相隔一段）
  for (let i = 2; i < segs.length; i++) {
    const a = segs[i - 2];
    const b = segs[i];
    if (a.dir !== b.dir) continue;
    const newExtreme = b.dir > 0 ? b.p1 > a.p1 : b.p1 < a.p1;
    if (!newExtreme) continue;
    const ea = segE(a);
    const eb = segE(b);
    if (!(ea.area > 0)) continue;
    const areaRatio = +(eb.area / ea.area).toFixed(3);
    const peakRatio = +(Math.abs(eb.peak) / Math.max(1e-9, Math.abs(ea.peak))).toFixed(3);
    if (areaRatio >= 0.92) continue;
    push({
      kind: '段背驰',
      dir: b.dir,
      barIdx: b.i1,
      price: b.p1,
      t: bars[b.i1].t,
      areaRatio,
      peakRatio,
      segIdx: i,
      note: `前段面积 ${ea.area.toFixed(1)} → 本段 ${eb.area.toFixed(1)}`,
    });
  }

  // 笔背驰（跨中枢）
  for (let i = 1; i < bis.length; i++) {
    const b = bis[i];
    let j = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (bis[k].dir === b.dir) {
        j = k;
        break;
      }
    }
    if (j < 0) continue;
    const a = bis[j];
    const between = pivots.filter((p) => p.startBi > j && p.endBi < i);
    if (!between.length) continue;
    const newExtreme = b.dir > 0 ? b.p1 > a.p1 : b.p1 < a.p1;
    if (!newExtreme) continue;
    const ea = biE(a);
    const eb = biE(b);
    if (!(ea.area > 0)) continue;
    const areaRatio = +(eb.area / ea.area).toFixed(3);
    const peakRatio = +(Math.abs(eb.peak) / Math.max(1e-9, Math.abs(ea.peak))).toFixed(3);
    if (areaRatio >= 0.85) continue;
    push({
      kind: '笔背驰',
      dir: b.dir,
      barIdx: b.i1,
      price: b.p1,
      t: bars[b.i1].t,
      areaRatio,
      peakRatio,
      segIdx: null,
      note: `跨中枢力度衰减（面积比 ${areaRatio}）`,
    });
  }
  return out.sort((x, y) => x.barIdx - y.barIdx);
}

/* ------------------------------------------------------------------ */
/* 7. 买卖点                                                           */
/* ------------------------------------------------------------------ */

function detectSignals(bis, segs, pivots, beichi, bars) {
  const sigs = [];
  const seen = new Set();
  const add = (type, barIdx, price, extra = {}) => {
    const key = type + ':' + barIdx;
    if (seen.has(key)) return;
    seen.add(key);
    sigs.push({
      type,
      name: SIGNAL_NAME[type],
      barIdx,
      price,
      t: bars[barIdx].t,
      ...extra,
    });
  };

  // 一类买卖点：段背驰 / 笔背驰 的终点
  const firsts = [];
  for (const b of beichi) {
    const type = b.dir < 0 ? '1B' : '1S';
    add(type, b.barIdx, b.price, {
      beichi: b.kind,
      areaRatio: b.areaRatio,
      note: `${b.kind}（同向力度比 ${b.areaRatio}）`,
    });
    if (b.kind === '段背驰' || b.kind === '笔背驰') firsts.push({ type, barIdx: b.barIdx, price: b.price });
  }

  // 二类买卖点：一类点之后的第一次反向次级别回抽不破前低/不过前高
  for (const f of firsts) {
    for (let i = 0; i < bis.length; i++) {
      if (bis[i].i1 <= f.barIdx) continue;
      if (f.type === '1B' && bis[i].dir === -1 && bis[i].p1 > f.price) {
        add('2B', bis[i].i1, bis[i].p1, { refBar: f.barIdx, note: '一买后回抽不破前低 ' + fmt(f.price) });
        break;
      }
      if (f.type === '1S' && bis[i].dir === 1 && bis[i].p1 < f.price) {
        add('2S', bis[i].i1, bis[i].p1, { refBar: f.barIdx, note: '一卖后反抽不过前高 ' + fmt(f.price) });
        break;
      }
    }
  }

  // 三类买卖点：离开中枢后回抽不回中枢
  for (const p of pivots) {
    if (p.leaveBi == null) continue;
    const leave = bis[p.leaveBi];
    const pull = p.leaveBi + 1 < bis.length ? bis[p.leaveBi + 1] : null;
    if (!leave || !pull) continue;
    if (leave.dir === 1 && pull.dir === -1 && pull.l > p.zg) {
      add('3B', pull.i1, pull.l, { pivot: p.idx, note: '回抽低点 ' + fmt(pull.l) + ' 未跌破中枢上沿 ' + fmt(p.zg) });
    }
    if (leave.dir === -1 && pull.dir === 1 && pull.h < p.zd) {
      add('3S', pull.i1, pull.h, { pivot: p.idx, note: '反抽高点 ' + fmt(pull.h) + ' 未回到中枢下沿 ' + fmt(p.zd) });
    }
  }

  return sigs.sort((a, b) => a.barIdx - b.barIdx);
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(2);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

/* ------------------------------------------------------------------ */
/* 8. 状态叙述                                                         */
/* ------------------------------------------------------------------ */

function describe({ bars, bis, segs, pivots, trend, beichi, signals, period }) {
  const meta = PERIOD_META[period] || PERIOD_META.day;
  const last = bars[bars.length - 1];
  const price = last.c;
  const parts = [];
  const lastPivot = pivots[pivots.length - 1] || null;
  const pos = lastPivot
    ? price > lastPivot.zg
      ? '中枢上方'
      : price < lastPivot.zd
      ? '中枢下方'
      : '中枢内部'
    : '尚未形成有效中枢';
  parts.push(
    `${meta.levelName}：当前价 ${fmt(price)}，${pos}` +
      (lastPivot
        ? `（最近中枢 [${fmt(lastPivot.zd)}, ${fmt(lastPivot.zg)}]，${lastPivot.count} 笔，${lastPivot.upgraded ? '已达九笔升级条件' : '未升级'}）`
        : '')
  );
  parts.push(`走势类型：${trend.type}（${trend.sub}）`);
  const lastBi = bis[bis.length - 1];
  if (lastBi) {
    parts.push(
      `最后一笔：${lastBi.dir > 0 ? '向上' : '向下'}笔 ${fmt(lastBi.p0)} → ${fmt(lastBi.p1)}，含 ${lastBi.i1 - lastBi.i0 + 1} 根K线`
    );
  }
  const lastSeg = segs[segs.length - 1];
  if (lastSeg) parts.push(`最后线段：${lastSeg.dir > 0 ? '向上' : '向下'}${lastSeg.done ? '（已完成）' : '（未完成）'}`);
  const recent = signals.filter((s) => s.barIdx >= bars.length - 60);
  if (recent.length) {
    parts.push('近 60 根K线内买卖点：' + recent.map((s) => `${s.name}@${fmt(s.price)}`).join('、'));
  } else {
    parts.push('近 60 根K线内无有效买卖点信号（等待中枢完成或背驰确认）');
  }
  const lb = beichi.filter((b) => b.barIdx >= bars.length - 120);
  if (lb.length) {
    const b = lb[lb.length - 1];
    parts.push(`最近背驰：${b.kind}（${b.dir > 0 ? '顶部' : '底部'}，${new Date(b.t).toISOString().slice(0, 10)}，力度比 ${b.areaRatio}）`);
  }
  return parts.join('｜');
}

function structureLabel(pivots) {
  const n = pivots.length;
  if (n === 0) return '无线段中枢结构（可能处于单边延伸或数据不足）';
  if (n === 1) return 'a + A + b（一个中枢的盘整结构）';
  return 'a + A + b + B + c …（' + n + ' 个中枢的走势连接）';
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

function analyze(rawBars, opts = {}) {
  const period = opts.period || 'day';
  const limit = opts.limit || 800;
  const bars = (rawBars || [])
    .filter((b) => b && Number.isFinite(b.c) && b.c > 0 && Number.isFinite(b.t))
    .sort((a, b) => a.t - b.t)
    .slice(-limit);
  const meta = PERIOD_META[period] || PERIOD_META.day;
  if (bars.length < 20) {
    return {
      period,
      level: meta,
      ok: false,
      reason: 'K线数量不足（至少 20 根）',
      bars: bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
      macd: { dif: [], dea: [], hist: [] },
      bis: [], segments: [], pivots: [], beichi: [], signals: [], fractals: [],
    };
  }
  const md = macd(bars.map((b) => b.c));
  const merged = mergeBars(bars);
  const frx = findFractals(merged, bars);
  const bis = buildBis(frx);
  const segments = buildSegments(bis);
  const pivots = buildPivots(bis, bars);
  const trend = classifyTrend(pivots);
  const beichi = detectBeichi(bis, segments, pivots, md, bars);
  const signals = detectSignals(bis, segments, pivots, beichi, bars);
  const summary = describe({ bars, bis, segs: segments, pivots, trend, beichi, signals, period });
  const lastPivot = pivots[pivots.length - 1] || null;
  const price = bars[bars.length - 1].c;

  return {
    ok: true,
    period,
    level: meta,
    market: opts.market || '',
    code: opts.code || '',
    name: opts.name || '',
    bars: bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
    macd: {
      dif: md.dif.map((v) => +v.toFixed(4)),
      dea: md.dea.map((v) => +v.toFixed(4)),
      hist: md.hist.map((v) => +v.toFixed(4)),
    },
    fractals: frx.map((f) => ({ type: f.type, barIdx: f.barIdx, price: f.price, mi: f.mi })),
    bis: bis.map((b) => ({
      dir: b.dir,
      i0: b.i0,
      i1: b.i1,
      p0: b.p0,
      p1: b.p1,
      h: b.h,
      l: b.l,
      startBar: b.startBar,
      endBar: b.endBar,
    })),
    segments: segments.map((s) => ({ dir: s.dir, i0: s.i0, i1: s.i1, p0: s.p0, p1: s.p1, done: s.done, startBi: s.startBi, endBi: s.endBi })),
    // 保留全部字段（enter/leave/status 等新增信息不能被白名单吃掉）
    pivots: pivots.map((p) => ({ ...p, active: p === lastPivot })),
    beichi: beichi.map((b) => ({ ...b })),
    signals: signals.map((s) => ({ ...s, typeName: s.name })),
    trend,
    structure: structureLabel(pivots),
    summary,
    stats: {
      bars: bars.length,
      mergedBars: merged.length,
      bis: bis.length,
      segments: segments.length,
      pivots: pivots.length,
      trend: trend.type,
      position: lastPivot ? (price > lastPivot.zg ? 'above' : price < lastPivot.zd ? 'below' : 'inside') : 'none',
      price,
      lastSignal: signals.length ? signals[signals.length - 1] : null,
      activePivot: lastPivot
        ? { zg: lastPivot.zg, zd: lastPivot.zd, count: lastPivot.count, upgraded: lastPivot.upgraded }
        : null,
    },
  };
}

/** 把一段级别结果压缩成「区间套」用的一行摘要 */
function summarizeForSuite(res) {
  if (!res || !res.ok) return { period: res && res.period, ok: false };
  const lastBi = res.bis[res.bis.length - 1];
  const p = res.pivots[res.pivots.length - 1];
  const price = res.stats.price;
  const pos = !p ? 'none' : price > p.zg ? 'above' : price < p.zd ? 'below' : 'inside';
  const recentSig = [...res.signals].reverse().find((s) => s.barIdx >= res.bars.length - 40) || null;
  const recentBei = [...res.beichi].reverse().find((b) => b.barIdx >= res.bars.length - 40) || null;
  return {
    period: res.period,
    levelName: res.level.levelName,
    ok: true,
    price,
    trend: res.trend.type,
    position: pos,
    pivot: p ? { zg: p.zg, zd: p.zd, count: p.count } : null,
    lastBiDir: lastBi ? lastBi.dir : 0,
    signal: recentSig ? { type: recentSig.type, name: recentSig.name, price: recentSig.price, barIdx: recentSig.barIdx } : null,
    beichi: recentBei ? { kind: recentBei.kind, dir: recentBei.dir, areaRatio: recentBei.areaRatio } : null,
    bars: res.bars.length,
  };
}

module.exports = { analyze, summarizeForSuite, macd, PERIOD_META, SIGNAL_NAME, mergeBars, findFractals, buildBis, buildSegments, buildPivots };

  });

  /* ---- sectors (sectors.js) ---- */
  define("sectors", function (module, exports, require) {
'use strict';
/**
 * 商品板块（Sector）目录
 * ------------------------------------------------------------------
 * 把期货品种按产业链分组，用于「板块页」浏览。分组依据是交易所主流分类：
 *   有色金属 / 贵金属 / 黑色系 / 能源化工 / 农产品 / 金融期货 / 指数与汇率（外盘）
 * 每个品种标注：代码、中文名、交易所、是否主力连续、有没有实测数据。
 * 数据可用性由 matrixcheck / srcaudit 定期复核，这里只做目录。
 */

const FUTURES_META = {
  // ===== 上期所 SHFE =====
  CU0: { name: '沪铜', ex: 'SHFE', sector: 'base' },
  AL0: { name: '沪铝', ex: 'SHFE', sector: 'base' },
  ZN0: { name: '沪锌', ex: 'SHFE', sector: 'base' },
  PB0: { name: '沪铅', ex: 'SHFE', sector: 'base' },
  NI0: { name: '沪镍', ex: 'SHFE', sector: 'base' },
  SN0: { name: '沪锡', ex: 'SHFE', sector: 'base' },
  AU0: { name: '沪金', ex: 'SHFE', sector: 'precious' },
  AG0: { name: '沪银', ex: 'SHFE', sector: 'precious' },
  RB0: { name: '螺纹钢', ex: 'SHFE', sector: 'ferrous' },
  HC0: { name: '热卷', ex: 'SHFE', sector: 'ferrous' },
  SS0: { name: '不锈钢', ex: 'SHFE', sector: 'ferrous' },
  BU0: { name: '沥青', ex: 'SHFE', sector: 'energy' },
  RU0: { name: '橡胶', ex: 'SHFE', sector: 'energy' },
  SP0: { name: '纸浆', ex: 'SHFE', sector: 'light' },
  FU0: { name: '燃油', ex: 'SHFE', sector: 'energy' },

  // ===== 能源中心 INE =====
  SC0: { name: '原油', ex: 'INE', sector: 'energy' },
  LU0: { name: '低硫燃油', ex: 'INE', sector: 'energy' },
  NR0: { name: '20号胶', ex: 'INE', sector: 'energy' },
  BC0: { name: '国际铜', ex: 'INE', sector: 'base' },

  // ===== 大商所 DCE =====
  M0: { name: '豆粕', ex: 'DCE', sector: 'agri' },
  Y0: { name: '豆油', ex: 'DCE', sector: 'agri' },
  P0: { name: '棕榈油', ex: 'DCE', sector: 'agri' },
  A0: { name: '豆一', ex: 'DCE', sector: 'agri' },
  B0: { name: '豆二', ex: 'DCE', sector: 'agri' },
  C0: { name: '玉米', ex: 'DCE', sector: 'agri' },
  CS0: { name: '淀粉', ex: 'DCE', sector: 'agri' },
  JD0: { name: '鸡蛋', ex: 'DCE', sector: 'agri' },
  LH0: { name: '生猪', ex: 'DCE', sector: 'agri' },
  RR0: { name: '粳米', ex: 'DCE', sector: 'agri' },
  L0: { name: '塑料', ex: 'DCE', sector: 'energy' },
  V0: { name: 'PVC', ex: 'DCE', sector: 'energy' },
  PP0: { name: '聚丙烯', ex: 'DCE', sector: 'energy' },
  EG0: { name: '乙二醇', ex: 'DCE', sector: 'energy' },
  EB0: { name: '苯乙烯', ex: 'DCE', sector: 'energy' },
  PG0: { name: 'LPG', ex: 'DCE', sector: 'energy' },
  J0: { name: '焦炭', ex: 'DCE', sector: 'ferrous' },
  JM0: { name: '焦煤', ex: 'DCE', sector: 'ferrous' },
  I0: { name: '铁矿石', ex: 'DCE', sector: 'ferrous' },
  FB0: { name: '纤维板', ex: 'DCE', sector: 'light' },
  BB0: { name: '胶合板', ex: 'DCE', sector: 'light' },

  // ===== 郑商所 CZCE =====
  SR0: { name: '白糖', ex: 'CZCE', sector: 'agri' },
  CF0: { name: '棉花', ex: 'CZCE', sector: 'agri' },
  CY0: { name: '棉纱', ex: 'CZCE', sector: 'agri' },
  RM0: { name: '菜粕', ex: 'CZCE', sector: 'agri' },
  OI0: { name: '菜油', ex: 'CZCE', sector: 'agri' },
  AP0: { name: '苹果', ex: 'CZCE', sector: 'agri' },
  CJ0: { name: '红枣', ex: 'CZCE', sector: 'agri' },
  PK0: { name: '花生', ex: 'CZCE', sector: 'agri' },
  TA0: { name: 'PTA', ex: 'CZCE', sector: 'energy' },
  MA0: { name: '甲醇', ex: 'CZCE', sector: 'energy' },
  FG0: { name: '玻璃', ex: 'CZCE', sector: 'energy' },
  SA0: { name: '纯碱', ex: 'CZCE', sector: 'energy' },
  UR0: { name: '尿素', ex: 'CZCE', sector: 'energy' },
  PF0: { name: '短纤', ex: 'CZCE', sector: 'energy' },
  SH0: { name: '烧碱', ex: 'CZCE', sector: 'energy' },
  PX0: { name: '对二甲苯', ex: 'CZCE', sector: 'energy' },
  SF0: { name: '硅铁', ex: 'CZCE', sector: 'ferrous' },
  SM0: { name: '锰硅', ex: 'CZCE', sector: 'ferrous' },

  // ===== 中金所 CFFEX =====
  IF0: { name: '沪深300', ex: 'CFFEX', sector: 'fin' },
  IC0: { name: '中证500', ex: 'CFFEX', sector: 'fin' },
  IH0: { name: '上证50', ex: 'CFFEX', sector: 'fin' },
  IM0: { name: '中证1000', ex: 'CFFEX', sector: 'fin' },
  TS0: { name: '2年国债', ex: 'CFFEX', sector: 'fin' },
  TF0: { name: '5年国债', ex: 'CFFEX', sector: 'fin' },
  T0: { name: '10年国债', ex: 'CFFEX', sector: 'fin' },
  TL0: { name: '30年国债', ex: 'CFFEX', sector: 'fin' },

  // ===== 外盘 CME/COMEX/NYMEX/CBOT =====
  ES: { name: '标普500', ex: 'CME', sector: 'index' },
  NQ: { name: '纳指100', ex: 'CME', sector: 'index' },
  YM: { name: '道指', ex: 'CBOT', sector: 'index' },
  GC: { name: '黄金', ex: 'COMEX', sector: 'precious' },
  SI: { name: '白银', ex: 'COMEX', sector: 'precious' },
  HG: { name: '铜', ex: 'COMEX', sector: 'base' },
  CL: { name: 'WTI原油', ex: 'NYMEX', sector: 'energy' },
  NG: { name: '天然气', ex: 'NYMEX', sector: 'energy' },
  HO: { name: '取暖油', ex: 'NYMEX', sector: 'energy' },
  QM: { name: '迷你原油', ex: 'NYMEX', sector: 'energy' },
  KC: { name: '咖啡', ex: 'ICE', sector: 'agri' },
  CC: { name: '可可', ex: 'ICE', sector: 'agri' },
  CT: { name: '棉花', ex: 'ICE', sector: 'agri' },
  OJ: { name: '橙汁', ex: 'ICE', sector: 'agri' },
  LE: { name: '活牛', ex: 'CME', sector: 'agri' },
  GF: { name: '育肥牛', ex: 'CME', sector: 'agri' },
};

const SECTORS = [
  { id: 'base', name: '有色金属', desc: '铜铝锌铅镍锡，跟宏观与库存周期走', color: '#c08a3e' },
  { id: 'precious', name: '贵金属', desc: '金银，避险与实际利率驱动', color: '#d4af37' },
  { id: 'ferrous', name: '黑色系', desc: '螺纹热卷铁矿焦炭焦煤，地产与基建链条', color: '#8a8f9c' },
  { id: 'energy', name: '能源化工', desc: '原油燃料油聚烯烃芳烃，最贴近成本推动', color: '#4a8fd4' },
  { id: 'agri', name: '农产品', desc: '油脂油料软商品养殖，天气与库存驱动', color: '#5fa564' },
  { id: 'fin', name: '金融期货', desc: '股指与国债，直接对应 A 股 beta 与利率', color: '#a06fd4' },
  { id: 'index', name: '外盘指数', desc: '美股与日经期货，夜盘风向标', color: '#d4685f' },
  { id: 'light', name: '林木轻工', desc: '纸浆板材，成交清淡、样本少', color: '#9a9a9a' },
];

/** 某市场下的全部品种（按板块分组） */
function bySector(market) {
  const out = new Map();
  for (const [code, meta] of Object.entries(FUTURES_META)) {
    // 国内代码以 0 结尾，外盘不是
    const mk = code.endsWith('0') ? 'CNF' : 'USF';
    if (market && mk !== market) continue;
    const sector = meta.sector;
    if (!out.has(sector)) out.set(sector, []);
    out.get(sector).push({ market: mk, code, name: meta.name, ex: meta.ex });
  }
  return out;
}

/** 完整目录：板块 → 品种，附带每个板块的品种数 */
function catalog() {
  const groups = bySector();
  return SECTORS.map((s) => ({
    ...s,
    items: (groups.get(s.id) || []).sort((a, b) => a.code.localeCompare(b.code)),
    count: (groups.get(s.id) || []).length,
  })).filter((s) => s.count > 0);
}

module.exports = { FUTURES_META, SECTORS, bySector, catalog };

  });

  /* ---- backtest (backtest.js) ---- */
  define("backtest", function (module, exports, require) {
'use strict';
/**
 * 信号与择时方法的历史检验（不是承诺胜率，而是把"准不准"变成可测量的数字）
 *
 * 两个能力：
 *  1) signalStats —— 缠论买卖点在**同一标的、同一级别**上的历史表现
 *     （命中率 / 平均前向收益 / 最大不利偏移 / 盈亏比 / 样本数）
 *  2) timingStats —— 任一择时方法的每日评分与次日涨跌的相关性检验
 *
 * 全部基于已有 K 线，不发新请求；交易成本按 bps 计。
 */

/* ------------------------------------------------------------------ */
/* 1. 买卖点历史表现                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {Array} bars      与分析结果同序的 K 线
 * @param {Array} signals   analyze() 输出的 signals
 * @param {Object} opts     { horizon=5, feeBps=8, stopAtr? }
 */
function signalStats(bars, signals, opts = {}) {
  const horizon = Math.max(1, Math.min(60, opts.horizon || 5));
  const feeBps = Number.isFinite(opts.feeBps) ? opts.feeBps : 8;
  const byType = {};
  const rows = [];

  for (const s of signals || []) {
    const entryIdx = s.barIdx;
    const exitIdx = entryIdx + horizon;
    if (exitIdx >= bars.length) continue; // 还没走完的样本不计入
    const isBuy = s.type.endsWith('B');
    const entry = bars[entryIdx].c;
    const exit = bars[exitIdx].c;
    // 买入：涨为赢；卖出（做空/离场）：跌为赢
    const raw = isBuy ? (exit - entry) / entry : (entry - exit) / entry;
    const net = raw - feeBps / 10000;
    // 最不利偏移（买入看最低价，卖出看最高价）
    let mae = 0;
    for (let i = entryIdx + 1; i <= exitIdx; i++) {
      const b = bars[i];
      const adv = isBuy ? (b.l - entry) / entry : (entry - b.h) / entry;
      if (adv < mae) mae = adv;
    }
    const row = {
      type: s.type,
      barIdx: entryIdx,
      t: bars[entryIdx].t,
      entry,
      exit,
      ret: +net.toFixed(5),
      mae: +mae.toFixed(5),
      win: net > 0,
      horizon,
    };
    rows.push(row);
    const cur = byType[s.type] || (byType[s.type] = { type: s.type, n: 0, wins: 0, sumRet: 0, sumWin: 0, sumLoss: 0, worst: 0, best: 0 });
    cur.n++;
    if (row.win) {
      cur.wins++;
      cur.sumWin += net;
    } else {
      cur.sumLoss += Math.abs(net);
    }
    cur.sumRet += net;
    cur.worst = Math.min(cur.worst, net);
    cur.best = Math.max(cur.best, net);
  }

  const summary = {};
  for (const [type, r] of Object.entries(byType)) {
    const avg = r.sumRet / r.n;
    const pf = r.sumLoss > 0 ? r.sumWin / r.sumLoss : r.sumWin > 0 ? Infinity : 0;
    summary[type] = {
      type,
      n: r.n,
      winRate: +(r.wins / r.n).toFixed(4),
      avgRet: +avg.toFixed(5),
      profitFactor: Number.isFinite(pf) ? +pf.toFixed(2) : null,
      best: +r.best.toFixed(5),
      worst: +r.worst.toFixed(5),
      expectancy: +avg.toFixed(5),
    };
  }
  const all = rows.length
    ? {
        n: rows.length,
        winRate: +(rows.filter((r) => r.win).length / rows.length).toFixed(4),
        avgRet: +(rows.reduce((a, b) => a + b.ret, 0) / rows.length).toFixed(5),
      }
    : { n: 0, winRate: null, avgRet: null };

  // 基线：同级别随机持有 horizon 根的平均收益，用于判断信号是否有超额
  const baseline = baselineReturn(bars, horizon, feeBps);

  return {
    horizon,
    feeBps,
    byType: summary,
    overall: all,
    baseline,
    edge: all.avgRet != null && baseline.avgRet != null ? +(all.avgRet - baseline.avgRet).toFixed(5) : null,
    samples: rows.slice(-40),
  };
}

function baselineReturn(bars, horizon, feeBps) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + horizon < bars.length; i++) {
    const a = bars[i].c;
    const b = bars[i + horizon].c;
    sum += (b - a) / a - feeBps / 10000;
    n++;
  }
  return { n, avgRet: n ? +(sum / n).toFixed(5) : null };
}

/* ------------------------------------------------------------------ */
/* 2. 择时方法的历史检验                                                */
/* ------------------------------------------------------------------ */

/**
 * 对过去 days 个交易日逐日打分，检验"高分日次日是否更容易涨"。
 * @param {Array} bars         日线（或任意级别）K 线
 * @param {Function} scoreFn   (ts) => { composite: 0..100, methods: {...} }
 * @param {Object} opts        { days=120, horizon=1, feeBps=0, threshold=60 }
 */
function timingStats(bars, scoreFn, opts = {}) {
  const days = Math.max(30, Math.min(750, opts.days || 160));
  const horizon = Math.max(1, Math.min(20, opts.horizon || 1));
  const start = Math.max(0, bars.length - days - horizon);
  const rows = []; // { score, fwd, methods: {id: score} }

  for (let i = start; i + horizon < bars.length; i++) {
    let res = null;
    try {
      res = scoreFn(bars[i].t);
    } catch (e) {
      continue;
    }
    if (!res || !Number.isFinite(res.composite)) continue;
    rows.push({
      t: bars[i].t,
      score: res.composite,
      fwd: (bars[i + horizon].c - bars[i].c) / bars[i].c,
      methods: Object.fromEntries(Object.entries(res.methods || {}).map(([id, m]) => [id, m.score])),
    });
  }

  const n = rows.length;
  const base = baselineReturn(bars.slice(start), horizon, 0);
  const q = (arr, p) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
  };
  const scores = rows.map((r) => r.score);
  const hiTh = Number.isFinite(opts.threshold) ? opts.threshold : q(scores, 0.7);
  const loTh = Number.isFinite(opts.lowThreshold) ? opts.lowThreshold : q(scores, 0.3);

  const bucket = (list, fn) => {
    const sel = list.filter(fn);
    if (!sel.length) return { n: 0, winRate: null, avgRet: null };
    const wins = sel.filter((r) => r.fwd > 0).length;
    return {
      n: sel.length,
      winRate: +(wins / sel.length).toFixed(4),
      avgRet: +(sel.reduce((a, b) => a + b.fwd, 0) / sel.length).toFixed(5),
    };
  };

  const corr = pearson(
    rows.map((r) => r.score),
    rows.map((r) => r.fwd)
  );

  const per = {};
  for (const id of Object.keys(rows[0] ? rows[0].methods : {})) {
    const rs = rows.filter((r) => Number.isFinite(r.methods[id]));
    per[id] = {
      id,
      corr: pearson(
        rs.map((r) => r.methods[id]),
        rs.map((r) => r.fwd)
      ),
      high: bucket(rs, (r) => r.methods[id] >= hiTh),
      low: bucket(rs, (r) => r.methods[id] <= loTh),
      n: rs.length,
    };
  }
  for (const m of Object.values(per)) {
    m.spread = m.high.winRate != null && m.low.winRate != null ? +(m.high.winRate - m.low.winRate).toFixed(4) : null;
    m.edge = m.high.avgRet != null && base.avgRet != null ? +(m.high.avgRet - base.avgRet).toFixed(5) : null;
  }

  const compositeStats = {
    high: bucket(rows, (r) => r.score >= hiTh),
    mid: bucket(rows, (r) => r.score > loTh && r.score < hiTh),
    low: bucket(rows, (r) => r.score <= loTh),
  };

  return {
    days: n,
    horizon,
    thresholds: { high: hiTh, low: loTh },
    baseline: base,
    corr,
    composite: compositeStats,
    methods: Object.values(per).sort((a, b) => Math.abs(b.corr || 0) - Math.abs(a.corr || 0)),
    verdict: buildVerdict(compositeStats, Object.values(per), base, corr, n),
  };
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 8) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return +(sxy / Math.sqrt(sxx * syy)).toFixed(4);
}

function buildVerdict(composite, methods, base, corr, n) {
  if (!n || n < 20) return { level: 'insufficient', text: `样本不足（${n || 0} 个交易日），不足以判断这个方法是否有效` };
  const best = methods.filter((m) => m.n >= 15).sort((a, b) => Math.abs(b.corr || 0) - Math.abs(a.corr || 0))[0];
  const hi = composite.high;
  const parts = [];
  parts.push(`样本 ${n} 日，综合分与次日收益相关系数 r=${corr == null ? '—' : corr}`);
  if (hi.n) parts.push(`高分组胜率 ${(hi.winRate * 100).toFixed(1)}%（n=${hi.n}），相对随机基线 ${((hi.avgRet - base.avgRet) * 100).toFixed(2)}pp/次`);
  if (best) parts.push(`分方法相关性最高：${best.id}（r=${best.corr == null ? '—' : best.corr}，n=${best.n}）`);
  let level = 'neutral';
  if (corr != null && corr >= 0.1) level = 'positive';
  else if (corr != null && corr <= -0.1) level = 'negative';
  parts.push(
    level === 'positive'
      ? '样本内呈现弱正相关，但很可能是多重比较的偶然结果——必须用样本外数据复验后才可参考'
      : level === 'negative'
      ? '分值越高反而越弱（负相关），本标的/本级别上不应据此择时'
      : '与随机无显著差异；把它当纪律工具，不要当信号源'
  );
  return { level, text: parts.join('；') };
}

module.exports = { signalStats, timingStats, baselineReturn };

  });

  /* ---- divination (divination.js) ---- */
  define("divination", function (module, exports, require) {
'use strict';
/**
 * 算卦择时引擎：干支历 → 梅花易数起卦 → 六爻纳甲排盘 → 期市解读
 *
 * 纯娱乐与文化向模块：所有结论仅作「择时冥想」，不构成任何投资建议。
 */

const G = require('./ganzhi');
const D = require('./gua-data');

const WX_SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' }; // 我生
const WX_KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' }; // 我克
const WX_BY_SHENG = { 火: '木', 土: '火', 金: '土', 水: '金', 木: '水' }; // 生我
const WX_BY_KE = { 土: '木', 水: '土', 火: '水', 金: '火', 木: '金' }; // 克我

function trigramByNum(n) {
  const i = ((n - 1) % 8 + 8) % 8;
  return D.TRIGRAMS[i];
}
function trigramByName(name) {
  return D.TRIGRAMS.find((t) => t.name === name) || D.TRIGRAMS[0];
}
function trigramByLines(lines) {
  const key = lines.join('');
  return D.TRIGRAMS.find((t) => t.lines.join('') === key) || D.TRIGRAMS[0];
}
function findHex(upper, lower) {
  return D.HEXAGRAMS.find((h) => h.upper === upper && h.lower === lower) || D.HEXAGRAMS[0];
}
function hexLines(hex) {
  const u = trigramByName(hex.upper);
  const l = trigramByName(hex.lower);
  return [...l.lines, ...u.lines]; // 自下而上 6 爻
}
function hexFromLines(lines) {
  const lower = trigramByLines(lines.slice(0, 3));
  const upper = trigramByLines(lines.slice(3, 6));
  return findHex(upper.name, lower.name);
}

function relation(selfEl, otherEl) {
  if (selfEl === otherEl) return { key: 'same', text: '比和', level: '平', score: 0.5 };
  if (WX_SHENG[selfEl] === otherEl) return { key: 'selfSheng', text: `体（${selfEl}）生用（${otherEl}）`, level: '泄', score: 0.35 };
  if (WX_SHENG[otherEl] === selfEl) return { key: 'otherSheng', text: `用（${otherEl}）生体（${selfEl}）`, level: '吉', score: 0.8 };
  if (WX_KE[selfEl] === otherEl) return { key: 'selfKe', text: `体（${selfEl}）克用（${otherEl}）`, level: '吉', score: 0.7 };
  if (WX_KE[otherEl] === selfEl) return { key: 'otherKe', text: `用（${otherEl}）克体（${selfEl}）`, level: '凶', score: 0.2 };
  return { key: 'unknown', text: '关系未定', level: '平', score: 0.5 };
}

const JIANCHU_ADVICE = {
  建: { good: ['开市', '试仓'], bad: ['重仓'], note: '万物始建，宜小仓试探，忌一次压满' },
  除: { good: ['止损', '换股', '调仓'], bad: ['追涨'], note: '除旧布新，适合清掉走坏的仓位' },
  满: { good: ['减仓', '止盈'], bad: ['加仓'], note: '圆满则溢，宜落袋为安' },
  平: { good: ['观察', '复盘'], bad: ['开新仓'], note: '平常之日，行情多为无序震荡，守拙为上' },
  定: { good: ['定投', '持仓'], bad: ['频繁交易'], note: '宜定不宜动，让仓位安静待着' },
  执: { good: ['持有'], bad: ['割肉'], note: '执持之日，趋势仓位宜守，不必被日内波动惊出' },
  破: { good: ['空仓', '休息'], bad: ['开仓', '加杠杆'], note: '破日易生意外，最好不交易' },
  危: { good: ['观望', '风控'], bad: ['追高', '抄底'], note: '危日多陷阱，等结构走完再说' },
  成: { good: ['建仓', '加仓'], bad: ['犹豫'], note: '成日利于成事，结构确认后可果断' },
  收: { good: ['收线', '减仓'], bad: ['追单'], note: '收日宜收不宜放，逐步落袋' },
  开: { good: ['新开仓', '布局'], bad: ['满仓'], note: '开日适合开新方向，但留足后手' },
  闭: { good: ['空仓', '学习', '等信号'], bad: ['开仓'], note: '闭日主闭塞，交易信号易失真' },
};

const LIUQIN_TRADE = {
  妻财: '妻财持世/发动：主财利与盈亏线，财动则仓位变，宜算清赔率再动',
  官鬼: '官鬼主压力与主力：官鬼发动多为消息面冲击或主力洗盘，忌勉强追单',
  子孙: '子孙为福神：子孙旺相多助，适合持有与等待，忌被短线噪音打乱',
  父母: '父母主文书消息：父母发动提示消息面驱动，宜先核事实再做决定',
  兄弟: '兄弟主劫财竞争：兄弟发动多为震荡消耗，宜减频、缩仓、看结构',
};

function liuQin(gongEl, yaoEl) {
  if (yaoEl === gongEl) return '兄弟';
  if (WX_BY_SHENG[gongEl] === yaoEl) return '父母'; // 生我者父母
  if (WX_SHENG[gongEl] === yaoEl) return '子孙'; // 我生者子孙
  if (WX_BY_KE[gongEl] === yaoEl) return '官鬼'; // 克我者官鬼
  if (WX_KE[gongEl] === yaoEl) return '妻财'; // 我克者妻财
  return '兄弟';
}

const LIUSHEN_QIDIAN = { 甲: 0, 乙: 0, 丙: 1, 丁: 1, 戊: 2, 己: 3, 庚: 4, 辛: 4, 壬: 5, 癸: 5 };

function palaceOf(hexName) {
  for (const [palace, list] of Object.entries(D.PALACES)) {
    const i = list.indexOf(hexName);
    if (i >= 0) return { palace, index: i };
  }
  return { palace: '乾', index: 0 };
}

/** FNV-1a 32 位哈希：让标的代码真正参与起卦（数字/字母代码都能区分，且不会撞卦） */
function hash32(str) {
  let h = 2166136261 >>> 0;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function fmtP(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

/**
 * 起卦取数（梅花易数的「以时起卦 + 以数起卦」通用化）
 *  - mode='price'（默认，随市）：四柱支序 + 标的哈希 + 现价分桶 + 涨跌基点 + 占次
 *      → 同标的重复点击必变；价格变动到 0.05% 档位也会变卦
 *  - mode='time'（稳定）：四柱支序 + 标的哈希 → 同一时辰内同一标的固定一卦
 */
function castSeed({ market, code, pillars, price, pct, nonce = 0, mode = 'price' }) {
  const n = (z) => G.ZHI.indexOf(z) + 1;
  const yz = n(pillars.year.zhi);
  const mz = n(pillars.month.zhi);
  const dz = n(pillars.day.zhi);
  const hz = n(pillars.hour.zhi);
  const symbolKey = `${market || 'A'}:${String(code || '').toUpperCase()}`;
  const symHash = hash32(symbolKey);
  const hasPrice = Number.isFinite(price) && price > 0;
  // 价格按「量级 1%」分档：茅台约 10 元一档、BTC 约 100 一档，避免每个 tick 都跳卦
  const priceStep = hasPrice ? Math.pow(10, Math.floor(Math.log10(price)) - 2) : 1;
  const priceBucket = hasPrice ? Math.round(price / priceStep) : 0;
  const pctBp = Number.isFinite(pct) ? Math.round(pct * 100) : 0;
  const timeSum = yz + mz + dz + hz;

  // 摇卦数：标的 + 现价档 + 涨跌 + 时辰 + 占次 一次性混合，保证「换标的必换卦、再起必换卦」
  const seedStr =
    mode === 'time'
      ? `${symbolKey}|${timeSum}`
      : `${symbolKey}|${priceBucket}|${pctBp}|${timeSum}|${nonce}`;
  const R = hash32(seedStr);

  const up = (timeSum + (R % 97)) % 8 || 8;
  const down = (timeSum + ((R >>> 8) % 89) + hz) % 8 || 8;
  const dong = (timeSum + ((R >>> 16) % 7)) % 6 || 6;

  const parts = [
    { label: '四柱支序', value: timeSum, detail: `${pillars.year.zhi}${pillars.month.zhi}${pillars.day.zhi}${pillars.hour.zhi}` },
    { label: '标的哈希', value: symHash % 1000000, detail: symbolKey },
    { label: '摇卦数', value: R % 1000000, detail: seedStr },
  ];
  if (mode !== 'time') {
    parts.push(
      {
        label: '价格档',
        value: priceBucket,
        detail: hasPrice ? `${fmtP(price)}，换档区间 ${fmtP((priceBucket - 0.5) * priceStep)} ~ ${fmtP((priceBucket + 0.5) * priceStep)}` : '未取到实时价',
      },
      { label: '涨跌基点', value: pctBp, detail: Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—' },
      { label: '占次', value: nonce, detail: `第 ${nonce + 1} 次起卦` }
    );
  }

  return {
    upperNum: up,
    lowerNum: down,
    dong,
    parts,
    mode,
    symbolHash: symHash,
    symbolKey,
    priceBucket,
    priceStep,
    bucketLow: hasPrice ? (priceBucket - 0.5) * priceStep : null,
    bucketHigh: hasPrice ? (priceBucket + 0.5) * priceStep : null,
    pctBp,
    nonce,
    timeSum,
    shakeNo: R,
    seedStr,
  };
}

function buildChart({ upper, lower, dong, dayG }) {
  const ben = findHex(upper.name, lower.name);
  const lines = hexLines(ben);
  // 互卦：二三四爻为下卦，三四五爻为上卦
  const hu = hexFromLines([lines[1], lines[2], lines[3], lines[2], lines[3], lines[4]]);
  // 变卦：动爻阴阳互变
  const changedLines = lines.slice();
  changedLines[dong - 1] = changedLines[dong - 1] === 1 ? 0 : 1;
  const bian = hexFromLines(changedLines);
  // 体用：动爻所在之卦为用
  const useIsLower = dong <= 3;
  const tiTri = useIsLower ? upper : lower;
  const yongTri = useIsLower ? lower : upper;
  const rel = relation(tiTri.element, yongTri.element);
  return { ben, hu, bian, lines, changedLines, dong, useIsLower, tiTri, yongTri, rel };
}

function liuYaoChart(hex, { dong, dayG, kong }) {
  const { palace, index } = palaceOf(hex.name);
  const gongEl = D.PALACE_ELEMENT[palace];
  const upperT = trigramByName(hex.upper);
  const lowerT = trigramByName(hex.lower);
  const nj = D.NAJIA;
  const upperNa = nj[upperT.name];
  const lowerNa = nj[lowerT.name];
  const shi = D.SHI_YING[index];
  const ying = shi > 3 ? shi - 3 : shi + 3;
  const shenStart = LIUSHEN_QIDIAN[dayG.gan] ?? 0;
  const yaos = [];
  for (let i = 0; i < 6; i++) {
    const isLower = i < 3;
    const zhi = isLower ? lowerNa.inner[i] : upperNa.outer[i - 3];
    const el = G.ZHI_WUXING[zhi];
    const pos = i + 1;
    yaos.push({
      pos,
      yin: hexLines(hex)[i] === 1 ? '阳' : '阴',
      zhi,
      element: el,
      liuqin: liuQin(gongEl, el),
      liushen: D.LIU_SHEN[(shenStart + i) % 6],
      shi: pos === shi,
      ying: pos === ying,
      dong: pos === dong,
      kong: kong.includes(zhi),
    });
  }
  yaos.sort((a, b) => b.pos - a.pos); // 上爻在前，便于阅读
  return { palace, gongEl, shi, ying, yaos };
}

function analyze({ symbol, market, code, name, ts, method, price, pct, nonce = 0, mode } = {}) {
  const whenMs = Number(ts);
  const when = Number.isFinite(whenMs) && whenMs > 0 ? new Date(whenMs) : new Date();
  const ag = G.agenda(when);
  const m = mode || (method === 'time' ? 'time' : 'price');
  const targetCode = code || symbol || '';
  const nums = castSeed({
    market: market || 'A',
    code: targetCode,
    pillars: ag.pillars,
    price,
    pct,
    nonce: Math.max(0, Math.trunc(Number(nonce) || 0)),
    mode: m,
  });
  const upper = trigramByNum(nums.upperNum);
  const lower = trigramByNum(nums.lowerNum);
  const chart = buildChart({ upper, lower, dong: nums.dong, dayG: ag.pillars.day });
  const ly = liuYaoChart(chart.ben, { dong: nums.dong, dayG: ag.pillars.day, kong: ag.kong });
  const lyBian = liuYaoChart(chart.bian, { dong: -1, dayG: ag.pillars.day, kong: ag.kong });
  const dongYao = ly.yaos.find((y) => y.dong) || null;
  const advice = JIANCHU_ADVICE[ag.jianchu] || JIANCHU_ADVICE.平;

  // 体用解读
  const rel = chart.rel;
  const tiEl = chart.tiTri.element;
  const yongEl = chart.yongTri.element;
  const score = Math.round(
    (rel.score * 0.5 +
      (chart.ben.id ? 0.5 : 0.5) * 0.1 +
      (dongYao && dongYao.liuqin === '妻财' ? 0.85 : 0.5) * 0.2 +
      (dongYao && dongYao.liuqin === '子孙' ? 0.75 : 0.5) * 0.1 +
      (dongYao && dongYao.liuqin === '官鬼' ? 0.3 : 0.5) * 0.1) *
      100
  );

  const shichenAdvice = ag.shichen.map((s) => {
    const r2 = relation(tiEl, s.wuxing);
    return {
      ...s,
      relation: r2.text,
      label: r2.level,
      score: r2.score,
      hint:
        r2.level === '吉'
          ? '顺体之时的窗口，宜处理既定计划'
          : r2.level === '凶'
          ? '逆体之时，少动多看'
          : r2.level === '泄'
          ? '泄体之时，容易手痒，慎开新仓'
          : '比和之时，结构没走完就等',
    };
  });

  const narrative = [];
  const basisTitle =
    m === 'time'
      ? `以四柱支序＋标的哈希起卦（${nums.symbolKey}，${ag.pillars.day.text}日${ag.pillars.hour.name}）`
      : `以四柱支序＋标的哈希＋现价起卦（${nums.symbolKey}${Number.isFinite(price) && price > 0 ? `，现价 ${fmtP(price)}` : ''}${Number.isFinite(pct) ? `，${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}，第 ${nums.nonce + 1} 占）`;
  narrative.push(`${basisTitle}，得上卦「${upper.name}」下卦「${lower.name}」，成卦「${chart.ben.name}」（第 ${chart.ben.id} 卦，${chart.ben.dun}）。`);
  narrative.push(`卦辞：「${chart.ben.guaCi}」。象义：${chart.ben.baiHua}`);
  narrative.push(`动爻在第 ${nums.dong} 爻（${dongYao ? dongYao.liuqin + '·' + dongYao.zhi + dongYao.element : '-'}），变卦「${chart.bian.name}」，互卦「${chart.hu.name}」——内里（互卦）与结果（变卦）合看，是「${chart.ben.trade} → ${chart.bian.trade}」的路径。`);
  narrative.push(`体卦「${chart.tiTri.name}·${tiEl}」，用卦「${chart.yongTri.name}·${yongEl}」，${rel.text}，属「${rel.level}」。${rel.level === '吉' ? '体得用助，盘中若有结构好的位置，可按计划执行。' : rel.level === '凶' ? '用克体，今日易被行情反制，仓位优先于点位。' : rel.level === '泄' ? '体生用，是花钱买教训的配置，宜小仓、短打、不恋战。' : '比和之象，多是区间震荡，宜以缠论中枢上下沿做高抛低吸。'}`);
  if (dongYao) narrative.push(`${LIUQIN_TRADE[dongYao.liuqin] || ''}（动爻六亲：${dongYao.liuqin}）。${dongYao.kong ? '动爻逢空，信号容易落空，等填实再动。' : ''}`);
  narrative.push(`今日${ag.pillars.day.text}日，建除十二神为「${ag.jianchu}」：${advice.note}。冲${ag.chong.animal}（${ag.chong.zhi}），旬空 ${ag.kong.join('、') || '无'}。`);

  return {
    ok: true,
    when: ag.beijingTime,
    weekday: ag.weekday,
    target: { symbol: targetCode, market: market || 'A', name: name || '' },
    method: m,
    methodLabel: m === 'time' ? '四柱·时辰起卦（同时辰稳定）' : '四柱·随市起卦（代码＋现价＋占次）',
    seed: {
      mode: m,
      symbolKey: nums.symbolKey,
      symbolHash: nums.symbolHash,
      priceBucket: nums.priceBucket,
      priceStep: nums.priceStep,
      bucketLow: nums.bucketLow,
      bucketHigh: nums.bucketHigh,
      pctBp: nums.pctBp,
      nonce: nums.nonce,
      timeSum: nums.timeSum,
      parts: nums.parts,
      shakeNo: nums.shakeNo,
      seedStr: nums.seedStr,
    },
    quote: {
      price: Number.isFinite(price) && price > 0 ? price : null,
      pct: Number.isFinite(pct) ? pct : null,
      name: name || '',
    },
    basisText: nums.parts.map((x) => `${x.label} ${x.value}`).join(' · '),
    pillars: ag.pillars,
    jianchu: ag.jianchu,
    chong: ag.chong,
    kong: ag.kong,
    terms: ag.terms,
    hexagram: {
      ben: { ...chart.ben },
      hu: { ...chart.hu },
      bian: { ...chart.bian },
      upper: { name: upper.name, element: upper.element, nature: upper.nature, lines: upper.lines },
      lower: { name: lower.name, element: lower.element, nature: lower.nature, lines: lower.lines },
      lines: chart.lines,
      dong: nums.dong,
      ti: { name: chart.tiTri.name, element: tiEl, nature: chart.tiTri.nature },
      yong: { name: chart.yongTri.name, element: yongEl, nature: chart.yongTri.nature },
      relation: rel,
      score,
    },
    liuyao: ly,
    liuyaoChanged: lyBian,
    dongYao,
    shichen: shichenAdvice,
    narrative,
    advice: { tip: advice.note, good: advice.good, bad: advice.bad },
    disclaimer: '本模块为传统文化娱乐，起卦结果不构成任何投资建议，也不可用于实盘决策依据。',
  };
}

/** 今日黄历简报（首页 / 算卦页头部使用） */
function daily() {
  const ag = G.agenda(new Date());
  const advice = JIANCHU_ADVICE[ag.jianchu] || JIANCHU_ADVICE.平;
  return {
    ...ag,
    advice: { tip: advice.note, good: advice.good, bad: advice.bad },
    disclaimer: '传统文化娱乐，不构成投资建议。',
  };
}

module.exports = { analyze, daily, castSeed, hash32, buildChart, liuYaoChart, relation, trigramByNum };

  });

  /* ---- ganzhi (ganzhi.js) ---- */
  define("ganzhi", function (module, exports, require) {
'use strict';
/**
 * 干支历 / 节气 / 建除 / 旬空（零依赖，天文算法自洽）
 *
 * 说明：
 * - 节气用 Meeus 低精度太阳视黄经算法反解（误差约 15 分钟），用于判定年、月边界；
 * - 年柱以「立春」换年，月柱以「节」换月，日柱按儒略日推算（锚点 2000-01-01 = 戊午日）；
 * - 时辰以北京时间（UTC+8）为准，子时 23:00 起。
 */

const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const GAN_WUXING = ['木', '木', '火', '火', '土', '土', '金', '金', '水', '水'];
const ZHI_WUXING = {
  子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火',
  午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水',
};
const ZHI_ANIMAL = { 子: '鼠', 丑: '牛', 寅: '虎', 卯: '兔', 辰: '龙', 巳: '蛇', 午: '马', 未: '羊', 申: '猴', 酉: '鸡', 戌: '狗', 亥: '猪' };
const SHICHEN_NAME = ['子时', '丑时', '寅时', '卯时', '辰时', '巳时', '午时', '未时', '申时', '酉时', '戌时', '亥时'];
const SHICHEN_RANGE = ['23:00-01:00', '01:00-03:00', '03:00-05:00', '05:00-07:00', '07:00-09:00', '09:00-11:00', '11:00-13:00', '13:00-15:00', '15:00-17:00', '17:00-19:00', '19:00-21:00', '21:00-23:00'];
const JIANCHU = ['建', '除', '满', '平', '定', '执', '破', '危', '成', '收', '开', '闭'];

// 24 节气：名字 → 太阳视黄经
const TERMS = [
  { name: '春分', lon: 0 }, { name: '清明', lon: 15 }, { name: '谷雨', lon: 30 },
  { name: '立夏', lon: 45 }, { name: '小满', lon: 60 }, { name: '芒种', lon: 75 },
  { name: '夏至', lon: 90 }, { name: '小暑', lon: 105 }, { name: '大暑', lon: 120 },
  { name: '立秋', lon: 135 }, { name: '处暑', lon: 150 }, { name: '白露', lon: 165 },
  { name: '秋分', lon: 180 }, { name: '寒露', lon: 195 }, { name: '霜降', lon: 210 },
  { name: '立冬', lon: 225 }, { name: '小雪', lon: 240 }, { name: '大雪', lon: 255 },
  { name: '冬至', lon: 270 }, { name: '小寒', lon: 285 }, { name: '大寒', lon: 300 },
  { name: '立春', lon: 315 }, { name: '雨水', lon: 330 }, { name: '惊蛰', lon: 345 },
];
// 「节」：月首边界（立春、惊蛰、清明……）
const JIE_LONS = [315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255, 285];

function julianDay(date) {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  const d = date.getUTCDate() + (date.getUTCHours() + date.getUTCMinutes() / 60) / 24;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + b - 1524.5;
}

function jdToDate(jd) {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e) + f;
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  const dayInt = Math.floor(day);
  const frac = day - dayInt;
  return new Date(Date.UTC(year, month - 1, dayInt) + Math.round(frac * 86400000));
}

/** 太阳视黄经（度，0-360） */
function sunLongitude(jd) {
  const T = (jd - 2451545.0) / 36525;
  const rad = Math.PI / 180;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * rad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M * rad) +
    0.000289 * Math.sin(3 * M * rad);
  const omega = 125.04 - 1934.136 * T;
  let lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
  lambda = ((lambda % 360) + 360) % 360;
  return lambda;
}

const termCache = new Map();

/** 某公历年的 24 节气（北京时间 Date） */
function solarTerms(year) {
  if (termCache.has(year)) return termCache.get(year);
  const start = julianDay(new Date(Date.UTC(year, 0, 1) - 8 * 3600000));
  const out = [];
  for (const t of TERMS) {
    // 找到从年初起第一次经过该黄经的时刻
    let lo = start;
    let hi = start + 370;
    const at = (jd) => {
      let d = sunLongitude(jd) - t.lon;
      d = ((d + 180) % 360 + 360) % 360 - 180;
      return d; // 负数表示还没到
    };
    // 粗扫
    let found = null;
    for (let jd = lo; jd < hi; jd += 1) {
      if (at(jd) >= 0 && at(jd - 1) < 0) {
        found = [jd - 1, jd];
        break;
      }
    }
    if (!found) continue;
    let a = found[0];
    let b = found[1];
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      if (at(m) >= 0) b = m;
      else a = m;
    }
    const utcMs = (b - 2440587.5) * 86400000;
    out.push({ name: t.name, lon: t.lon, date: new Date(utcMs + 8 * 3600000), jie: JIE_LONS.includes(t.lon) });
  }
  out.sort((x, y) => x.date - y.date);
  termCache.set(year, out);
  return out;
}

/** 附近三年节气合并列表（按时间升序） */
function termWindow(year) {
  const list = [];
  for (const y of [year - 1, year, year + 1]) list.push(...solarTerms(y));
  return list.sort((a, b) => a.date - b.date);
}

function beijingParts(date) {
  const bj = new Date(date.getTime() + 8 * 3600000);
  return {
    y: bj.getUTCFullYear(),
    m: bj.getUTCMonth() + 1,
    d: bj.getUTCDate(),
    hh: bj.getUTCHours(),
    mm: bj.getUTCMinutes(),
    ss: bj.getUTCSeconds(),
  };
}

function ganzhiOf(index) {
  const i = ((index % 60) + 60) % 60;
  return { gan: GAN[i % 10], zhi: ZHI[i % 12], index: i, text: GAN[i % 10] + ZHI[i % 12] };
}

/** 日柱：JD(当天正午) + 49 对 60 取模（锚点 2000-01-01 戊午日） */
function dayGanzhi(date) {
  const p = beijingParts(date);
  const jd = julianDay(new Date(Date.UTC(p.y, p.m - 1, p.d, 12)));
  const idx = (Math.floor(jd + 0.5) + 49) % 60;
  return ganzhiOf(idx);
}

function yearGanzhi(date) {
  const p = beijingParts(date);
  const terms = termWindow(p.y);
  const lichun = terms.find((t) => t.name === '立春' && beijingParts(t.date).y === p.y);
  const bj = new Date(date.getTime() + 8 * 3600000);
  let y = p.y;
  if (lichun && bj < new Date(lichun.date.getTime())) y -= 1;
  return ganzhiOf(y - 4);
}

function monthGanzhi(date, yearG) {
  const p = beijingParts(date);
  const terms = termWindow(p.y);
  const bj = new Date(date.getTime() + 8 * 3600000);
  const jies = terms.filter((t) => t.jie);
  let cur = jies[0];
  for (const j of jies) if (bj >= j.date) cur = j;
  // 月支：立春→寅、惊蛰→卯 …
  const order = [315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255, 285];
  const seq = order.indexOf(cur.lon); // 0=寅月
  const zhiIdx = (2 + seq) % 12;
  const yearGanIdx = GAN.indexOf(yearG.gan);
  const ganIdx = ((yearGanIdx % 5) * 2 + 2 + seq) % 10;
  return { gan: GAN[ganIdx], zhi: ZHI[zhiIdx], text: GAN[ganIdx] + ZHI[zhiIdx], jie: cur.name, jieAt: cur.date };
}

function hourGanzhi(date, dayG) {
  const p = beijingParts(date);
  const zhiIdx = Math.floor(((p.hh + 1) % 24) / 2);
  const dayGanIdx = GAN.indexOf(dayG.gan);
  const ganIdx = ((dayGanIdx % 5) * 2 + zhiIdx) % 10;
  return {
    gan: GAN[ganIdx],
    zhi: ZHI[zhiIdx],
    text: GAN[ganIdx] + ZHI[zhiIdx],
    name: SHICHEN_NAME[zhiIdx],
    range: SHICHEN_RANGE[zhiIdx],
    index: zhiIdx,
  };
}

function xunKong(dayG) {
  const idx = dayG.index;
  const xunStart = Math.floor(idx / 10) * 10;
  const covered = new Set();
  for (let i = 0; i < 10; i++) covered.add((xunStart + i) % 12);
  const kong = [];
  for (let i = 0; i < 12; i++) if (!covered.has(i)) kong.push(ZHI[i]);
  return kong;
}

function jianChu(monthZ, dayZ) {
  const mi = ZHI.indexOf(monthZ);
  const di = ZHI.indexOf(dayZ);
  return JIANCHU[((di - mi) % 12 + 12) % 12];
}

function chong(dayZ) {
  const i = ZHI.indexOf(dayZ);
  const c = ZHI[(i + 6) % 12];
  return { zhi: c, animal: ZHI_ANIMAL[c] };
}

/** 完整四柱 + 当日信息 */
function agenda(date = new Date()) {
  const y = yearGanzhi(date);
  const m = monthGanzhi(date, y);
  const d = dayGanzhi(date);
  const h = hourGanzhi(date, d);
  const terms = termWindow(beijingParts(date).y);
  const bj = new Date(date.getTime() + 8 * 3600000);
  const nextTerm = terms.find((t) => t.date > bj) || null;
  const prevTerm = [...terms].reverse().find((t) => t.date <= bj) || null;
  const kong = xunKong(d);
  const jc = jianChu(m.zhi, d.zhi);
  const shichenList = [];
  for (let i = 0; i < 12; i++) {
    const ganIdx = ((GAN.indexOf(d.gan) % 5) * 2 + i) % 10;
    shichenList.push({
      name: SHICHEN_NAME[i],
      range: SHICHEN_RANGE[i],
      zhizhi: ZHI[i],
      gang: GAN[ganIdx],
      text: GAN[ganIdx] + ZHI[i],
      wuxing: ZHI_WUXING[ZHI[i]],
      jianchu: JIANCHU[((ZHI.indexOf(d.zhi) + i) % 12 + 12) % 12],
      active: i === h.index,
    });
  }
  return {
    timestamp: date.getTime(),
    beijingTime: `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`,
    weekday: '日一二三四五六'[new Date(date.getTime() + 8 * 3600000).getUTCDay()],
    pillars: {
      year: { ...y, wuxing: GAN_WUXING[GAN.indexOf(y.gan)] + ZHI_WUXING[y.zhi] },
      month: { ...m, wuxing: GAN_WUXING[GAN.indexOf(m.gan)] + ZHI_WUXING[m.zhi] },
      day: { ...d, wuxing: GAN_WUXING[GAN.indexOf(d.gan)] + ZHI_WUXING[d.zhi], animal: ZHI_ANIMAL[d.zhi] },
      hour: { ...h, wuxing: GAN_WUXING[GAN.indexOf(h.gan)] + ZHI_WUXING[h.zhi] },
    },
    kong,
    jianchu: jc,
    chong: chong(d.zhi),
    terms: {
      prev: prevTerm ? { name: prevTerm.name, at: prevTerm.date.toISOString(), daysAgo: daysBetween(prevTerm.date, bj) } : null,
      next: nextTerm ? { name: nextTerm.name, at: nextTerm.date.toISOString(), daysTo: daysBetween(bj, nextTerm.date) } : null,
    },
    shichen: shichenList,
    shichenNow: h,
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

module.exports = {
  GAN, ZHI, GAN_WUXING, ZHI_WUXING, ZHI_ANIMAL, SHICHEN_NAME, SHICHEN_RANGE, JIANCHU, TERMS,
  agenda, dayGanzhi, yearGanzhi, monthGanzhi, hourGanzhi, xunKong, jianChu, chong, solarTerms, sunLongitude, julianDay,
};

  });

  /* ---- lunar (lunar.js) ---- */
  define("lunar", function (module, exports, require) {
'use strict';
/**
 * 农历（天文算法，零依赖）
 *
 * 规则：
 *  1. 朔（新月）用 Meeus 第 49 章均朔 + 主要摄动项，精度约分钟级；
 *  2. 日期一律按北京时间（UTC+8）切日；
 *  3. 以「含冬至之月为十一月」定月序；一个"岁"（冬至月 → 下一个冬至月）若有 13 个月，
 *     其中第一个**无中气**的月为闰月，沿用上一月序号；
 *  4. 农历年 = 正月初一所在公历年；十一月/十二月属上一农历年。
 *
 * 校验：测试里用 2023–2027 的春节（正月初一）与 2025 年闰六月做锚点。
 */

const G = require('./ganzhi');

const RAD = Math.PI / 180;
const TZ = 8 / 24; // 北京时间相对 UTC 的日偏移

/** ΔT（TT-UT，秒），2005–2050 Espenak-Meeus 多项式 */
function deltaT(year) {
  const t = year - 2000;
  return 62.92 + 0.32217 * t + 0.005589 * t * t;
}

const toJD = (date) => date.getTime() / 86400000 + 2440587.5;
const fromJD = (jd) => new Date((jd - 2440587.5) * 86400000);
const bjDateOfJD = (jd) => new Date((jd - 2440587.5) * 86400000 + 8 * 3600000);
/** JD（UT）→ 北京时间日期序号（整数，按 UTC+8 切日） */
const bjDayNumber = (jd) => Math.floor(jd + 0.5 + TZ);

/** 第 k 个朔的 JD（UT） */
function newMoonJD(k) {
  const year = 2000 + (k * 29.530588861) / 365.25;
  const T = (year - 2000) / 100;
  const jde0 = 2451550.09766 + 29.530588861 * k + 0.00015437 * T * T - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T * T - 0.00000011 * T ** 3) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T ** 3 - 0.000000058 * T ** 4) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T ** 3 + 0.000000011 * T ** 4) * RAD;
  const Om = (124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T ** 3) * RAD;
  const s = Math.sin;
  const corr =
    -0.4072 * s(Mp) +
    0.17241 * E * s(M) +
    0.01608 * s(2 * Mp) +
    0.01039 * s(2 * F) +
    0.00739 * E * s(Mp - M) -
    0.00514 * E * s(Mp + M) +
    0.00208 * E * E * s(2 * M) -
    0.00111 * s(Mp - 2 * F) -
    0.00057 * s(Mp + 2 * F) +
    0.00056 * E * s(2 * Mp + M) -
    0.00042 * s(3 * Mp) +
    0.00042 * E * s(M + 2 * F) +
    0.00038 * E * s(M - 2 * F) -
    0.00024 * E * s(2 * Mp - M) -
    0.00017 * s(Om) -
    0.00007 * s(Mp + 2 * M) +
    0.00004 * s(2 * Mp - 2 * F) +
    0.00004 * s(3 * M) +
    0.00003 * s(Mp + M - 2 * F) +
    0.00003 * s(2 * Mp + 2 * F) -
    0.00003 * s(Mp + M + 2 * F) +
    0.00003 * s(Mp - M + 2 * F) -
    0.00002 * s(Mp - M - 2 * F) -
    0.00002 * s(3 * Mp + M) +
    0.00002 * s(4 * Mp);
  return jde0 + corr - deltaT(year) / 86400;
}

const ZHONGQI = new Set([330, 0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);

const termCache = new Map();
function termsOf(year) {
  if (!termCache.has(year)) {
    termCache.set(
      year,
      G.solarTerms(year).map((t) => ({ name: t.name, lon: t.lon, jd: toJD(new Date(t.date.getTime() - 8 * 3600000)) }))
    );
  }
  return termCache.get(year);
}

/** 冬至的 JD（UT） */
function winterSolsticeJD(year) {
  const t = termsOf(year).find((x) => x.name === '冬至');
  return t.jd;
}

function newMoonIndexNear(jd) {
  return Math.round((jd - 2451550.1) / 29.530588861);
}

/** 所有覆盖 [startJD, endJD] 的朔月 */
function monthsBetween(startJD, endJD) {
  let k = newMoonIndexNear(startJD) - 1;
  while (newMoonJD(k) >= startJD) k--;
  const out = [];
  const guard = Math.ceil((endJD - startJD) / 29) + 4;
  while (out.length < guard) {
    const a = newMoonJD(k);
    const b = newMoonJD(k + 1);
    if (a > endJD) break;
    if (b > startJD) out.push({ k, start: a, end: b });
    k++;
  }
  return out;
}

/**
 * 公历 → 农历
 * @param {Date} date 真实时间戳
 */
function solarToLunar(date) {
  const jd = toJD(date);
  const dayNum = bjDayNumber(jd);
  const gYear = new Date((dayNum - 2440587.5) * 86400000).getUTCFullYear();

  const months = monthsBetween(jd - 800, jd + 800);
  const monthOf = (x) => months.find((m) => bjDayNumber(m.start) <= bjDayNumber(x) && bjDayNumber(x) < bjDayNumber(m.end));

  // 岁：从「含冬至之月」的初一，到下一个「含冬至之月」的初一（不含）
  let sy = gYear - 1;
  for (let y = gYear - 2; y <= gYear + 1; y++) {
    const a = monthOf(winterSolsticeJD(y));
    const b = monthOf(winterSolsticeJD(y + 1));
    if (!a || !b) continue;
    if (bjDayNumber(a.start) <= dayNum && dayNum < bjDayNumber(b.start)) {
      sy = y;
      break;
    }
  }
  const dzStartMonth = monthOf(winterSolsticeJD(sy));
  const dzNextMonth = monthOf(winterSolsticeJD(sy + 1));
  if (process.env.LUNAR_DEBUG) {
    const f = (m) => (m ? new Date((m.start - 2440587.5) * 86400000 + 8 * 3600000).toISOString().slice(0, 10) : 'undef');
    console.error('[lunar] sy', sy, 'months', months.length, 'dza', f(dzStartMonth), 'dzb', f(dzNextMonth), 'si', months.indexOf(dzStartMonth), 'ei', months.indexOf(dzNextMonth));
  }
  if (!dzStartMonth || !dzNextMonth) throw new Error('岁边界定位失败');

  const si = months.indexOf(dzStartMonth);
  const ei = months.indexOf(dzNextMonth);
  const scope = months.slice(si, ei); // 下一个十一月之前（不含）

  const target = monthOf(jd);
  if (!target) throw new Error('农历定位失败');

  // 中气按北京日期归属
  const terms = [...termsOf(sy), ...termsOf(sy + 1)].filter((t) => ZHONGQI.has(t.lon));
  const hasZhongqi = (m) =>
    terms.some((t) => {
      const d = bjDayNumber(t.jd);
      return d >= bjDayNumber(m.start) && d < bjDayNumber(m.end);
    });

  // 闰月：岁内 13 个月时，第一个无中气者
  let leapPos = -1;
  if (scope.length === 13) leapPos = scope.findIndex((m) => !hasZhongqi(m));

  // 逐月编号：scope[0] = 十一月
  let no = 0;
  let monthNo = 11;
  let isLeap = false;
  let yearFlag = 1;
  for (let i = 0; i < scope.length; i++) {
    const m = scope[i];
    const isThis = m.k === target.k;
    if (i === leapPos) {
      if (isThis) {
        isLeap = true;
        monthNo = ((no + 9) % 12) + 1;
        yearFlag = no;
        break;
      }
      continue;
    }
    no++;
    if (isThis) {
      monthNo = ((no + 9) % 12) + 1;
      yearFlag = no;
      break;
    }
  }

  const day = dayNum - bjDayNumber(target.start) + 1;
  const lunarYear = yearFlag <= 2 ? sy : sy + 1;

  return {
    year: lunarYear,
    month: monthNo,
    day,
    isLeap,
    monthDays: bjDayNumber(target.end) - bjDayNumber(target.start),
    dayIndex: day - 1,
    gregorian: new Date((dayNum - 2440587.5) * 86400000).toISOString().slice(0, 10),
  };
}

module.exports = { solarToLunar, newMoonJD, deltaT, toJD, fromJD, bjDayNumber, winterSolsticeJD };

  });

  /* ---- gua-data (gua-data.js) ---- */
  define("gua-data", function (module, exports, require) {
/**
 * gua-data.js —— 易经（周易）基础数据
 *
 * 供「算卦择时」模块使用。纯数据 + 无第三方依赖，CommonJS 导出。
 *
 * 数据约定
 *  - TRIGRAMS.lines：自下而上（初爻→上爻），1 = 阳，0 = 阴
 *  - HEXAGRAMS.id：通行本（王弼本 / 周易）卦序 1..64
 *  - HEXAGRAMS.name：「上卦自然象 + 下卦自然象 + 卦名」，八纯卦用「乾为天」式写法
 *  - PALACES：京房八宫，每宫 8 卦，顺序为本宫、一世、二世、三世、四世、五世、游魂、归魂
 *  - NAJIA：八经卦纳甲纳支（内卦初二三爻 / 外卦四五六爻）
 *  - SHI_YING：八宫卦序（本宫..归魂）对应的世爻位置
 */
"use strict";

// ---------------------------------------------------------------------------
// 1. 八卦（八经卦）：先天数 1..8
// ---------------------------------------------------------------------------
const TRIGRAMS = [
  { num: 1, name: "乾", symbol: "☰", nature: "天", element: "金", lines: [1, 1, 1] },
  { num: 2, name: "兑", symbol: "☱", nature: "泽", element: "金", lines: [1, 1, 0] },
  { num: 3, name: "离", symbol: "☲", nature: "火", element: "火", lines: [1, 0, 1] },
  { num: 4, name: "震", symbol: "☳", nature: "雷", element: "木", lines: [1, 0, 0] },
  { num: 5, name: "巽", symbol: "☴", nature: "风", element: "木", lines: [0, 1, 1] },
  { num: 6, name: "坎", symbol: "☵", nature: "水", element: "水", lines: [0, 1, 0] },
  { num: 7, name: "艮", symbol: "☶", nature: "山", element: "土", lines: [0, 0, 1] },
  { num: 8, name: "坤", symbol: "☷", nature: "地", element: "土", lines: [0, 0, 0] }
];

// ---------------------------------------------------------------------------
// 2. 六十四卦（通行本卦序）
//    upper = 上卦 / 外卦；lower = 下卦 / 内卦
// ---------------------------------------------------------------------------
const HEXAGRAMS = [
  {
    id: 1, name: "乾为天", upper: "乾", lower: "乾",
    guaCi: "乾：元亨利贞。",
    baiHua: "纯阳刚健，天道运行不息，万物创始之时。",
    trade: "刚健上行，趋势初动，宜顺势不宜逆势。",
    dun: "元亨利贞"
  },
  {
    id: 2, name: "坤为地", upper: "坤", lower: "坤",
    guaCi: "坤：元亨，利牝马之贞。",
    baiHua: "纯阴柔顺，承载万物，宜守不宜先。",
    trade: "绵延下行或横盘，柔顺承势，宜低吸待转不宜抢反弹。",
    dun: "厚德载物"
  },
  {
    id: 3, name: "水雷屯", upper: "坎", lower: "震",
    guaCi: "屯：元亨利贞，勿用有攸往，利建侯。",
    baiHua: "云雷交动，万物初生，艰难中蕴含生机。",
    trade: "趋势初起多震荡，底部反复，宜小仓试探。",
    dun: "初生之难"
  },
  {
    id: 4, name: "山水蒙", upper: "艮", lower: "坎",
    guaCi: "蒙：亨。匪我求童蒙，童蒙求我。初筮告，再三渎，渎则不告。利贞。",
    baiHua: "山下出泉，蒙昧未开，须求师启发。",
    trade: "方向不明、信息混乱，宜观望待明信号。",
    dun: "蒙昧待启"
  },
  {
    id: 5, name: "水天需", upper: "坎", lower: "乾",
    guaCi: "需：有孚，光亨，贞吉。利涉大川。",
    baiHua: "云上于天，需待雨降，耐心等待时机。",
    trade: "盘整蓄势，等回踩确认再进，忌追高。",
    dun: "待时而动"
  },
  {
    id: 6, name: "天水讼", upper: "乾", lower: "坎",
    guaCi: "讼：有孚窒惕，中吉，终凶。利见大人，不利涉大川。",
    baiHua: "天与水违行，争端生，宜和解不宜强争。",
    trade: "多空对峙、分歧加大，宜止损离场莫硬扛。",
    dun: "慎争戒讼"
  },
  {
    id: 7, name: "地水师", upper: "坤", lower: "坎",
    guaCi: "师：贞，丈人吉，无咎。",
    baiHua: "地中有水，聚众成军，须有纪律统御。",
    trade: "资金集结成势，宜有纪律分批进出。",
    dun: "师出以律"
  },
  {
    id: 8, name: "水地比", upper: "坎", lower: "坤",
    guaCi: "比：吉。原筮元永贞，无咎。不宁方来，后夫凶。",
    baiHua: "水在地上，亲密无间，宜择善而从。",
    trade: "量价配合顺畅，跟随主流资金方向。",
    dun: "亲比相辅"
  },
  {
    id: 9, name: "风天小畜", upper: "巽", lower: "乾",
    guaCi: "小畜：亨。密云不雨，自我西郊。",
    baiHua: "风行天上，密云未雨，力小只能小蓄。",
    trade: "小幅蓄势未成趋势，宜轻仓短做。",
    dun: "蓄小待大"
  },
  {
    id: 10, name: "天泽履", upper: "乾", lower: "兑",
    guaCi: "履：履虎尾，不咥人，亨。",
    baiHua: "上天下泽，循礼而行，如履虎尾而慎。",
    trade: "贴近关键位、波动加大，须设好止损。",
    dun: "履虎尾"
  },
  {
    id: 11, name: "地天泰", upper: "坤", lower: "乾",
    guaCi: "泰：小往大来，吉亨。",
    baiHua: "天地交而万物通，上下交而其志同。",
    trade: "上下贯通、趋势顺遂，宜持有宜加仓。",
    dun: "小往大来"
  },
  {
    id: 12, name: "天地否", upper: "乾", lower: "坤",
    guaCi: "否：否之匪人，不利君子贞，大往小来。",
    baiHua: "天地不交，万物不通，宜守正待时。",
    trade: "上下背离、量能萎缩，宜观望不宜进场。",
    dun: "闭塞不通"
  },
  {
    id: 13, name: "天火同人", upper: "乾", lower: "离",
    guaCi: "同人：同人于野，亨。利涉大川，利君子贞。",
    baiHua: "天与火同明，与人同心，利涉大川。",
    trade: "共识形成合力向上，可顺势跟多。",
    dun: "同人于野"
  },
  {
    id: 14, name: "火天大有", upper: "离", lower: "乾",
    guaCi: "大有：元亨。",
    baiHua: "火在天上，普照万物，所有者大。",
    trade: "强势普涨、人气旺盛，但防高位兑现。",
    dun: "顺天休命"
  },
  {
    id: 15, name: "地山谦", upper: "坤", lower: "艮",
    guaCi: "谦：亨，君子有终。",
    baiHua: "山藏地中，卑而不可逾，谦者受益。",
    trade: "低调稳步抬升，宜潜伏不宜张扬。",
    dun: "谦尊而光"
  },
  {
    id: 16, name: "雷地豫", upper: "震", lower: "坤",
    guaCi: "豫：利建侯行师。",
    baiHua: "雷出地奋，万物欣悦，宜顺时而动。",
    trade: "情绪升温、交投活跃，顺势但防过热。",
    dun: "顺时而豫"
  },
  {
    id: 17, name: "泽雷随", upper: "兑", lower: "震",
    guaCi: "随：元亨利贞，无咎。",
    baiHua: "泽中有雷，随时而动，宜择善而随。",
    trade: "跟随趋势随波逐流，莫猜顶底。",
    dun: "随时之义"
  },
  {
    id: 18, name: "山风蛊", upper: "艮", lower: "巽",
    guaCi: "蛊：元亨，利涉大川。先甲三日，后甲三日。",
    baiHua: "山下有风，物腐生蛊，须治乱除弊。",
    trade: "积弱需洗盘整顿，耐心等结构修复。",
    dun: "整饬积弊"
  },
  {
    id: 19, name: "地泽临", upper: "坤", lower: "兑",
    guaCi: "临：元亨利贞。至于八月有凶。",
    baiHua: "泽上有地，居高临下，阳气渐长。",
    trade: "趋势抬头初显强，可逐步建仓。",
    dun: "临事以诚"
  },
  {
    id: 20, name: "风地观", upper: "巽", lower: "坤",
    guaCi: "观：盥而不荐，有孚颙若。",
    baiHua: "风行地上，遍观万物，宜静观其变。",
    trade: "多看少动，等信号明确再参与。",
    dun: "观民设教"
  },
  {
    id: 21, name: "火雷噬嗑", upper: "离", lower: "震",
    guaCi: "噬嗑：亨。利用狱。",
    baiHua: "雷电交加，啮合去梗，宜决断除障。",
    trade: "震荡洗盘、破位反复，须果断止盈止损。",
    dun: "明罚敕法"
  },
  {
    id: 22, name: "山火贲", upper: "艮", lower: "离",
    guaCi: "贲：亨。小利有攸往。",
    baiHua: "山下有火，文饰光明，重质不重华。",
    trade: "表面热闹、实质有限，防虚涨假突破。",
    dun: "文饰以质"
  },
  {
    id: 23, name: "山地剥", upper: "艮", lower: "坤",
    guaCi: "剥：不利有攸往。",
    baiHua: "山附于地，剥落将倾，宜顺止不宜进。",
    trade: "趋势破位下行，宜空仓避跌不抄底。",
    dun: "剥落倾颓"
  },
  {
    id: 24, name: "地雷复", upper: "坤", lower: "震",
    guaCi: "复：亨。出入无疾，朋来无咎。反复其道，七日来复，利有攸往。",
    baiHua: "雷在地中，一阳复始，生机渐回。",
    trade: "底部初现转机，宜轻仓试多待确认。",
    dun: "一阳来复"
  },
  {
    id: 25, name: "天雷无妄", upper: "乾", lower: "震",
    guaCi: "无妄：元亨利贞。其匪正有眚，不利有攸往。",
    baiHua: "天下雷行，物与无妄，守正则无咎。",
    trade: "突发消息扰动，莫盲目追涨杀跌。",
    dun: "无妄之灾"
  },
  {
    id: 26, name: "山天大畜", upper: "艮", lower: "乾",
    guaCi: "大畜：利贞。不家食吉，利涉大川。",
    baiHua: "天在山中，大畜其德，蓄而后发。",
    trade: "长期蓄势待突破，突破后再加仓。",
    dun: "刚健笃实"
  },
  {
    id: 27, name: "山雷颐", upper: "艮", lower: "震",
    guaCi: "颐：贞吉。观颐，自求口实。",
    baiHua: "山下有雷，颐养之道，自求口实。",
    trade: "量能养育价格，关注增量入场信号。",
    dun: "慎言节食"
  },
  {
    id: 28, name: "泽风大过", upper: "兑", lower: "巽",
    guaCi: "大过：栋桡，利有攸往，亨。",
    baiHua: "泽水灭木，栋梁弯曲，过甚则危。",
    trade: "涨跌过度需修正，别接飞刀别追高。",
    dun: "栋桡之危"
  },
  {
    id: 29, name: "坎为水", upper: "坎", lower: "坎",
    guaCi: "坎：习坎，有孚，维心亨，行有尚。",
    baiHua: "重险相叠，水流不盈，守信可出险。",
    trade: "连续下行险中求稳，宜严格风控。",
    dun: "习坎有孚"
  },
  {
    id: 30, name: "离为火", upper: "离", lower: "离",
    guaCi: "离：利贞，亨。畜牝牛，吉。",
    baiHua: "明两作离，附丽而生，柔顺则吉。",
    trade: "热点扩散亮眼，宜快进快出防熄火。",
    dun: "附丽光明"
  },
  {
    id: 31, name: "泽山咸", upper: "兑", lower: "艮",
    guaCi: "咸：亨，利贞，取女吉。",
    baiHua: "山上有泽，二气感应，少男少女相悦。",
    trade: "资金情绪共振、人气聚拢，可跟。",
    dun: "感而遂通"
  },
  {
    id: 32, name: "雷风恒", upper: "震", lower: "巽",
    guaCi: "恒：亨，无咎，利贞，利有攸往。",
    baiHua: "雷风相与，恒久不变，守常则有成。",
    trade: "趋势稳定持久，宜持有勿频繁操作。",
    dun: "恒久之道"
  },
  {
    id: 33, name: "天山遁", upper: "乾", lower: "艮",
    guaCi: "遁：亨，小利贞。",
    baiHua: "天下有山，阴长阳退，宜退避守正。",
    trade: "趋势转弱宜减仓退守，不恋战。",
    dun: "遁世无闷"
  },
  {
    id: 34, name: "雷天大壮", upper: "震", lower: "乾",
    guaCi: "大壮：利贞。",
    baiHua: "雷在天上，其势壮盛，壮而守正。",
    trade: "放量强势上攻，顺势但防冲高回落。",
    dun: "非礼弗履"
  },
  {
    id: 35, name: "火地晋", upper: "离", lower: "坤",
    guaCi: "晋：康侯用锡马蕃庶，昼日三接。",
    baiHua: "明出地上，顺而丽乎大明，进而有获。",
    trade: "温和放量上行，可顺势加仓跟进。",
    dun: "明出地上"
  },
  {
    id: 36, name: "地火明夷", upper: "坤", lower: "离",
    guaCi: "明夷：利艰贞。",
    baiHua: "明入地中，光明受伤，宜晦藏自守。",
    trade: "下跌中的反弹多为诱多，宜守现金不抢。",
    dun: "晦以自守"
  },
  {
    id: 37, name: "风火家人", upper: "巽", lower: "离",
    guaCi: "家人：利女贞。",
    baiHua: "风自火出，由内及外，先整齐内部。",
    trade: "板块内部轮动，宜坚守熟悉标的。",
    dun: "正家而后"
  },
  {
    id: 38, name: "火泽睽", upper: "离", lower: "兑",
    guaCi: "睽：小事吉。",
    baiHua: "火上泽下，二女异行，睽违而小成。",
    trade: "多空分歧背离，宜低吸高抛做区间。",
    dun: "睽而能通"
  },
  {
    id: 39, name: "水山蹇", upper: "坎", lower: "艮",
    guaCi: "蹇：利西南，不利东北；利见大人，贞吉。",
    baiHua: "山上有水，前险后阻，宜反身修德。",
    trade: "上行受阻、步履艰难，宜观望不硬闯。",
    dun: "反身修德"
  },
  {
    id: 40, name: "雷水解", upper: "震", lower: "坎",
    guaCi: "解：利西南。无所往，其来复吉。有攸往，夙吉。",
    baiHua: "雷雨作解，险难消释，宜速决不留。",
    trade: "利空落地、风险释放，可择机介入。",
    dun: "赦过宥罪"
  },
  {
    id: 41, name: "山泽损", upper: "艮", lower: "兑",
    guaCi: "损：有孚，元吉，无咎，可贞。利有攸往。曷之用？二簋可用享。",
    baiHua: "山下有泽，损下益上，损而有孚。",
    trade: "短期让利换量，宜减仓不宜增仓。",
    dun: "损下益上"
  },
  {
    id: 42, name: "风雷益", upper: "巽", lower: "震",
    guaCi: "益：利有攸往，利涉大川。",
    baiHua: "风雷相益，损上益下，利有攸往。",
    trade: "量能增益、趋势扩张，宜加仓顺势。",
    dun: "损上益下"
  },
  {
    id: 43, name: "泽天夬", upper: "兑", lower: "乾",
    guaCi: "夬：扬于王庭，孚号有厉。告自邑，不利即戎，利有攸往。",
    baiHua: "泽上于天，决然而行，去邪务尽。",
    trade: "急涨之后需决断，宜顺势莫逆势。",
    dun: "刚决柔"
  },
  {
    id: 44, name: "天风姤", upper: "乾", lower: "巽",
    guaCi: "姤：女壮，勿用取女。",
    baiHua: "天下有风，不期而遇，一阴始生。",
    trade: "高位现分歧苗头，宜减仓防回撤。",
    dun: "防微杜渐"
  },
  {
    id: 45, name: "泽地萃", upper: "兑", lower: "坤",
    guaCi: "萃：亨，王假有庙。利见大人，亨利贞。用大牲吉，利有攸往。",
    baiHua: "泽上于地，万物荟萃，聚则须以正。",
    trade: "资金聚集、热点成团，顺势参与龙头。",
    dun: "萃聚以正"
  },
  {
    id: 46, name: "地风升", upper: "坤", lower: "巽",
    guaCi: "升：元亨，用见大人，勿恤，南征吉。",
    baiHua: "地中生木，积小以高大，渐进则吉。",
    trade: "稳步逐级抬升，宜持仓待涨。",
    dun: "积小成高"
  },
  {
    id: 47, name: "泽水困", upper: "兑", lower: "坎",
    guaCi: "困：亨，贞，大人吉，无咎。有言不信。",
    baiHua: "泽中无水，处困境中，守正乃吉。",
    trade: "缩量低迷被困，宜休息等待新机。",
    dun: "守正不受"
  },
  {
    id: 48, name: "水风井", upper: "坎", lower: "巽",
    guaCi: "井：改邑不改井，无丧无得，往来井井。汔至亦未繘井，羸其瓶，凶。",
    baiHua: "木上有水，井养不穷，取之不竭。",
    trade: "存量资金循环，宜做熟不做生。",
    dun: "井养不穷"
  },
  {
    id: 49, name: "泽火革", upper: "兑", lower: "离",
    guaCi: "革：己日乃孚。元亨利贞，悔亡。",
    baiHua: "泽中有火，变革之时，顺天而应人。",
    trade: "格局生变、趋势换轨，宜及时调仓。",
    dun: "顺天应人"
  },
  {
    id: 50, name: "火风鼎", upper: "离", lower: "巽",
    guaCi: "鼎：元吉，亨。",
    baiHua: "木上有火，鼎新之象，正位以凝命。",
    trade: "结构重塑、主升开启，可顺势介入。",
    dun: "正位凝命"
  },
  {
    id: 51, name: "震为雷", upper: "震", lower: "震",
    guaCi: "震：亨。震来虩虩，笑言哑哑。震惊百里，不丧匕鬯。",
    baiHua: "重雷相叠，震动奋起，惊而后定。",
    trade: "突发巨震、波动剧烈，宜轻仓控风险。",
    dun: "震惊百里"
  },
  {
    id: 52, name: "艮为山", upper: "艮", lower: "艮",
    guaCi: "艮：艮其背，不获其身；行其庭，不见其人，无咎。",
    baiHua: "两山相重，止而不动，时止则止。",
    trade: "横盘滞涨宜停手，不动优于乱动。",
    dun: "艮其背"
  },
  {
    id: 53, name: "风山渐", upper: "巽", lower: "艮",
    guaCi: "渐：女归吉，利贞。",
    baiHua: "山上有木，渐进而高，女归则吉。",
    trade: "缓步爬升不急不躁，宜耐心持有。",
    dun: "渐进以正"
  },
  {
    id: 54, name: "雷泽归妹", upper: "震", lower: "兑",
    guaCi: "归妹：征凶，无攸利。",
    baiHua: "泽上有雷，少女归嫁，失序则凶。",
    trade: "追高易套、失序难成，宜谨慎克制。",
    dun: "归妹征凶"
  },
  {
    id: 55, name: "雷火丰", upper: "震", lower: "离",
    guaCi: "丰：亨，王假之。勿忧，宜日中。",
    baiHua: "雷电皆至，丰大光明，宜照宜中。",
    trade: "放量高潮、量价齐升，防见顶回落。",
    dun: "丰大宜中"
  },
  {
    id: 56, name: "火山旅", upper: "离", lower: "艮",
    guaCi: "旅：小亨，旅贞吉。",
    baiHua: "山上有火，行旅在外，柔顺则小亨。",
    trade: "短暂反弹如行旅，宜短做不恋战。",
    dun: "旅次之慎"
  },
  {
    id: 57, name: "巽为风", upper: "巽", lower: "巽",
    guaCi: "巽：小亨，利有攸往，利见大人。",
    baiHua: "两风相随，巽顺而入，小有亨通。",
    trade: "随风摇摆无主趋势，宜顺势轻仓。",
    dun: "随风巽入"
  },
  {
    id: 58, name: "兑为泽", upper: "兑", lower: "兑",
    guaCi: "兑：亨，利贞。",
    baiHua: "两泽相丽，和悦相说，朋友讲习。",
    trade: "情绪和暖、人气回归，可温和做多。",
    dun: "和悦以说"
  },
  {
    id: 59, name: "风水涣", upper: "巽", lower: "坎",
    guaCi: "涣：亨。王假有庙，利涉大川，利贞。",
    baiHua: "风行水上，涣然离散，宜聚人心。",
    trade: "筹码松动、人心涣散，宜等重新凝聚。",
    dun: "涣散以聚"
  },
  {
    id: 60, name: "水泽节", upper: "坎", lower: "兑",
    guaCi: "节：亨。苦节不可贞。",
    baiHua: "泽上有水，节而有度，苦节则凶。",
    trade: "涨跌有度、节奏收敛，宜守纪律。",
    dun: "节以制度"
  },
  {
    id: 61, name: "风泽中孚", upper: "巽", lower: "兑",
    guaCi: "中孚：豚鱼吉，利涉大川，利贞。",
    baiHua: "泽上有风，中虚有孚，信及豚鱼。",
    trade: "量价诚实、信号可信，宜按计划执行。",
    dun: "中孚诚信"
  },
  {
    id: 62, name: "雷山小过", upper: "震", lower: "艮",
    guaCi: "小过：亨，利贞。可小事，不可大事。飞鸟遗之音，不宜上，宜下，大吉。",
    baiHua: "山上有雷，小过之象，可小事不可大。",
    trade: "小级别波动可做，大事勿重仓。",
    dun: "小过可为"
  },
  {
    id: 63, name: "水火既济", upper: "坎", lower: "离",
    guaCi: "既济：亨小，利贞。初吉终乱。",
    baiHua: "水在火上，事既已成，守成则吉。",
    trade: "趋势走完、守成为上，宜止盈勿贪。",
    dun: "既济守成"
  },
  {
    id: 64, name: "火水未济", upper: "离", lower: "坎",
    guaCi: "未济：亨。小狐汔济，濡其尾，无攸利。",
    baiHua: "火在水上，事未成也，慎终则吉。",
    trade: "趋势未明悬而未决，宜等最后一击。",
    dun: "未济慎终"
  }
];

// ---------------------------------------------------------------------------
// 3. 京房八宫（每宫 8 卦：本宫、一世、二世、三世、四世、五世、游魂、归魂）
// ---------------------------------------------------------------------------
const PALACES = {
  "乾": ["乾为天", "天风姤", "天山遁", "天地否", "风地观", "山地剥", "火地晋", "火天大有"],
  "坎": ["坎为水", "水泽节", "水雷屯", "水火既济", "泽火革", "雷火丰", "地火明夷", "地水师"],
  "艮": ["艮为山", "山火贲", "山天大畜", "山泽损", "火泽睽", "天泽履", "风泽中孚", "风山渐"],
  "震": ["震为雷", "雷地豫", "雷水解", "雷风恒", "地风升", "水风井", "泽风大过", "泽雷随"],
  "巽": ["巽为风", "风天小畜", "风火家人", "风雷益", "天雷无妄", "火雷噬嗑", "山雷颐", "山风蛊"],
  "离": ["离为火", "火山旅", "火风鼎", "火水未济", "山水蒙", "风水涣", "天水讼", "天火同人"],
  "坤": ["坤为地", "地雷复", "地泽临", "地天泰", "雷天大壮", "泽天夬", "水天需", "水地比"],
  "兑": ["兑为泽", "泽水困", "泽地萃", "泽山咸", "水山蹇", "地山谦", "雷山小过", "雷泽归妹"]
};

// 八宫所属五行
const PALACE_ELEMENT = {
  "乾": "金", "坎": "水", "艮": "土", "震": "木",
  "巽": "木", "离": "火", "坤": "土", "兑": "金"
};

// ---------------------------------------------------------------------------
// 4. 纳甲纳支（八经卦内卦初二三爻 / 外卦四五六爻的地支）
//    乾纳甲壬、坎纳戊、艮纳丙、震纳庚、巽纳辛、离纳己、坤纳乙癸、兑纳丁
// ---------------------------------------------------------------------------
const NAJIA = {
  "乾": { inner: ["子", "寅", "辰"], outer: ["午", "申", "戌"], stem: "甲/壬" },
  "坎": { inner: ["寅", "辰", "午"], outer: ["申", "戌", "子"], stem: "戊" },
  "艮": { inner: ["辰", "午", "申"], outer: ["戌", "子", "寅"], stem: "丙" },
  "震": { inner: ["子", "寅", "辰"], outer: ["午", "申", "戌"], stem: "庚" },
  "巽": { inner: ["丑", "亥", "酉"], outer: ["未", "巳", "卯"], stem: "辛" },
  "离": { inner: ["卯", "丑", "亥"], outer: ["酉", "未", "巳"], stem: "己" },
  "坤": { inner: ["未", "巳", "卯"], outer: ["丑", "亥", "酉"], stem: "乙/癸" },
  "兑": { inner: ["巳", "卯", "丑"], outer: ["亥", "酉", "未"], stem: "丁" }
};

// 世爻位置：本宫 6、一世 1、二世 2、三世 3、四世 4、五世 5、游魂 4、归魂 3
// （应爻 = 世爻 ±3，如世 6 应 3、世 1 应 4）
const SHI_YING = [6, 1, 2, 3, 4, 5, 4, 3];

// ---------------------------------------------------------------------------
// 5. 地支五行 / 生肖 / 六神
// ---------------------------------------------------------------------------
const ZHI_ELEMENT = {
  "子": "水", "丑": "土", "寅": "木", "卯": "木",
  "辰": "土", "巳": "火", "午": "火", "未": "土",
  "申": "金", "酉": "金", "戌": "土", "亥": "水"
};

const ZHI_ANIMAL = {
  "子": "鼠", "丑": "牛", "寅": "虎", "卯": "兔",
  "辰": "龙", "巳": "蛇", "午": "马", "未": "羊",
  "申": "猴", "酉": "鸡", "戌": "狗", "亥": "猪"
};

// 六神：依日干起，甲乙日从青龙起，依次顺行
const LIU_SHEN = ["青龙", "朱雀", "勾陈", "螣蛇", "白虎", "玄武"];

module.exports = {
  TRIGRAMS,
  HEXAGRAMS,
  PALACES,
  PALACE_ELEMENT,
  NAJIA,
  SHI_YING,
  ZHI_ELEMENT,
  ZHI_ANIMAL,
  LIU_SHEN
};

  });

  /* ---- qimen (qimen.js) ---- */
  define("qimen", function (module, exports, require) {
'use strict';
/**
 * 奇门遁甲 · 时家（简盘）
 *
 * 实现的规则（均为公开通行做法）：
 *  1. 阴阳遁：冬至后阳遁、夏至后阴遁；
 *  2. 局数：节气 × 三元（上/中/下元，由日干支的符头地支决定：子午卯酉上、寅申巳亥中、辰戌丑未下）；
 *  3. 地盘三奇六仪：戊己庚辛壬癸丁丙乙，阳遁顺布、阴遁逆布，起于局数宫；
 *  4. 值符 / 值使：时干支所在旬的旬首所遁之仪 → 其地盘宫之星为值符、之门为值使；
 *  5. 天盘九星随值符：值符星飞到时干所临之宫，其余按序跟转；
 *  6. 人盘八门随值使：值使门从旬首宫按时支数飞宫（阳遁顺、阴遁逆）；
 *  7. 八神：值符起于值符宫，阳遁顺排、阴遁逆排。
 *
 * 简化声明：不做拆补/置闰法、不做暗干、不做中宫寄宫的两套流派取舍（中宫不排门星神）。
 * 打分只用于"择时结构分"，不是吉凶定论。
 */

const G = require('./ganzhi');

/** 洛书九宫（1..9）→ 宫名与方位 */
const PALACE = {
  1: { name: '坎', dir: '北', star: '天蓬', door: '休门' },
  2: { name: '坤', dir: '西南', star: '天芮', door: '死门' },
  3: { name: '震', dir: '东', star: '天冲', door: '伤门' },
  4: { name: '巽', dir: '东南', star: '天辅', door: '杜门' },
  5: { name: '中', dir: '中', star: '天禽', door: null },
  6: { name: '乾', dir: '西北', star: '天心', door: '开门' },
  7: { name: '兑', dir: '西', star: '天柱', door: '惊门' },
  8: { name: '艮', dir: '东北', star: '天任', door: '生门' },
  9: { name: '离', dir: '南', star: '天英', door: '景门' },
};
const YI_ORDER = ['戊', '己', '庚', '辛', '壬', '癸', '丁', '丙', '乙']; // 六仪三奇
const DOOR_ORDER = ['休门', '生门', '伤门', '杜门', '景门', '死门', '惊门', '开门'];
const GOD_ORDER = ['值符', '腾蛇', '太阴', '六合', '白虎', '玄武', '九地', '九天'];
const XUN_YI = { 0: '戊', 10: '己', 20: '庚', 30: '辛', 40: '壬', 50: '癸' }; // 甲子/甲戌/甲申/甲午/甲辰/甲寅 旬首所遁

/** 节气 → 三元局数 [上,中,下] */
const JU_TABLE = {
  冬至: { dun: '阳', ju: [1, 7, 4] },
  小寒: { dun: '阳', ju: [2, 8, 5] },
  大寒: { dun: '阳', ju: [3, 9, 6] },
  立春: { dun: '阳', ju: [8, 5, 2] },
  雨水: { dun: '阳', ju: [9, 6, 3] },
  惊蛰: { dun: '阳', ju: [1, 7, 4] },
  春分: { dun: '阳', ju: [3, 9, 6] },
  清明: { dun: '阳', ju: [4, 1, 7] },
  谷雨: { dun: '阳', ju: [5, 2, 8] },
  立夏: { dun: '阳', ju: [4, 1, 7] },
  小满: { dun: '阳', ju: [5, 2, 8] },
  芒种: { dun: '阳', ju: [6, 3, 9] },
  夏至: { dun: '阴', ju: [9, 3, 6] },
  小暑: { dun: '阴', ju: [8, 2, 5] },
  大暑: { dun: '阴', ju: [7, 1, 4] },
  立秋: { dun: '阴', ju: [2, 5, 8] },
  处暑: { dun: '阴', ju: [1, 4, 7] },
  白露: { dun: '阴', ju: [9, 3, 6] },
  秋分: { dun: '阴', ju: [7, 1, 4] },
  寒露: { dun: '阴', ju: [6, 9, 3] },
  霜降: { dun: '阴', ju: [5, 8, 2] },
  立冬: { dun: '阴', ju: [6, 9, 3] },
  小雪: { dun: '阴', ju: [5, 8, 2] },
  大雪: { dun: '阴', ju: [4, 7, 1] },
};

const fix9 = (n) => ((((n - 1) % 9) + 9) % 9) + 1;
const step = (from, k, dir) => fix9(from + k * dir);

/** 由日干支确定三元（0=上元 1=中元 2=下元） */
function yuanOf(dayGanzhi) {
  const idx = G.GAN.indexOf(dayGanzhi.gan) >= 0 ? dayGanzhiIndex(dayGanzhi) : 0;
  return Math.floor((idx % 15) / 5);
}
function dayGanzhiIndex(gz) {
  // 由 干、支 反推 60 甲子序号
  const gi = G.GAN.indexOf(gz.gan);
  const zi = G.ZHI.indexOf(gz.zhi);
  for (let i = 0; i < 60; i++) if (i % 10 === gi && i % 12 === zi) return i;
  return 0;
}

/** 当前节气（最近一个"节/气"） */
function currentTerm(agenda) {
  const name = agenda.terms.prev ? agenda.terms.prev.name : '冬至';
  return JU_TABLE[name] ? name : '冬至';
}

/**
 * 排盘
 * @param {Date} date 真实时间戳
 */
const RING = [1, 2, 3, 4, 6, 7, 8, 9]; // 八宫环（中宫 5 不排门/星/神，寄坤二宫）
function ringStep(from, k, dir) {
  let start = from;
  if (!RING.includes(start)) start = 2; // 5 中宫 → 寄坤
  const i = RING.indexOf(start);
  return RING[(((i + k * dir) % 8) + 8) % 8];
}

/**
 * 排盘
 * @param {Date} date 真实时间戳
 */
function chart(date) {
  const ag = G.agenda(date);
  const term = currentTerm(ag);
  const { dun, ju } = JU_TABLE[term];
  const dir = dun === '阳' ? 1 : -1;

  const dgz = ag.pillars.day;
  const yuan = yuanOf(dgz);
  const juNo = ju[yuan];

  // 地盘三奇六仪（含中宫）
  const diPan = {};
  for (let i = 0; i < 9; i++) diPan[step(juNo, i, dir)] = YI_ORDER[i];

  const hgz = ag.pillars.hour;
  const hIdx = dayGanzhiIndex(hgz);
  const xunStart = Math.floor(hIdx / 10) * 10;
  const xunYi = XUN_YI[xunStart];
  const xunPalace = Number(Object.keys(diPan).find((k) => diPan[k] === xunYi));

  // 旬首落中宫时，天禽寄坤二宫：值符取天禽、值使取坤宫死门
  const xunIsCenter = xunPalace === 5;
  const zhiFuStar = xunIsCenter ? '天禽' : PALACE[xunPalace].star;
  const zhiShiDoor = xunIsCenter ? '死门' : PALACE[xunPalace].door;

  const hourStemPalaceRaw = Number(Object.keys(diPan).find((k) => diPan[k] === hgz.gan)) || xunPalace;
  const hourStemPalace = RING.includes(hourStemPalaceRaw) ? hourStemPalaceRaw : 2;

  // 天盘九星：值符星加时干宫，其余八星按九星序跟转（天禽寄坤，不参与飞布）
  const STAR8 = ['天蓬', '天芮', '天冲', '天辅', '天心', '天柱', '天任', '天英'];
  const fillStar = zhiFuStar === '天禽' ? '天芮' : zhiFuStar;
  const startIdx = Math.max(0, STAR8.indexOf(fillStar));
  const tianPan = {};
  for (let i = 0; i < 8; i++) tianPan[ringStep(hourStemPalace, i, dir)] = STAR8[(startIdx + i) % 8];

  // 人盘八门：值使门从（旬首宫寄坤）起，按时支数飞宫
  const hourZhiIdx = G.ZHI.indexOf(hgz.zhi);
  const doorStart = ringStep(xunPalace, hourZhiIdx, dir);
  const menPan = {};
  const doorIdx = DOOR_ORDER.indexOf(zhiShiDoor || '休门');
  for (let i = 0; i < 8; i++) menPan[ringStep(doorStart, i, dir)] = DOOR_ORDER[(doorIdx + i) % 8];

  // 八神：值符起于值符宫，阳遁顺、阴遁逆
  const shenPan = {};
  for (let i = 0; i < 8; i++) shenPan[ringStep(xunPalace, i, dir)] = GOD_ORDER[i];

  const cells = [];
  for (let p = 1; p <= 9; p++) {
    cells.push({
      palace: p,
      name: PALACE[p].name,
      dir: PALACE[p].dir,
      yi: diPan[p] || null,
      star: p === 5 ? '天禽' : tianPan[p] || null,
      door: p === 5 ? null : menPan[p] || null,
      god: p === 5 ? null : shenPan[p] || null,
      hourStem: p === hourStemPalace,
      tianqin: p === 2,
    });
  }

  return {
    term,
    dun,
    ju: juNo,
    yuan: ['上元', '中元', '下元'][yuan],
    hourGanZhi: hgz.text,
    dayGanZhi: dgz.text,
    xun: G.GAN[xunStart % 10] + G.ZHI[xunStart % 12] + '旬',
    xunYi,
    zhiFu: { star: zhiFuStar, palace: xunPalace },
    zhiShi: { door: zhiShiDoor, palace: doorStart },
    hourStemPalace,
    cells,
    layout: [4, 9, 2, 3, 5, 7, 8, 1, 6],
  };
}

/** 门/星/神 吉凶权重（用于打分） */
const DOOR_SCORE = { 开门: 12, 休门: 8, 生门: 10, 景门: 2, 杜门: -2, 伤门: -10, 惊门: -8, 死门: -12 };
const STAR_SCORE = { 天心: 6, 天任: 5, 天辅: 5, 天禽: 4, 天冲: 2, 天英: -2, 天柱: -5, 天蓬: -6, 天芮: -6 };
const GOD_SCORE = { 值符: 8, 九地: 5, 九天: 5, 太阴: 4, 六合: 3, 腾蛇: -5, 白虎: -6, 玄武: -6 };

function score(date, jitter = 0) {
  const c = chart(date);
  const cell = c.cells.find((x) => x.hourStem) || c.cells[0];
  let s = 50;
  const reasons = [
    `${c.dun}遁${c.ju}局（${c.term}·${c.yuan}），值符${c.zhiFu.star}、值使${c.zhiShi.door}`,
    `时干落${cell.name}宫（${cell.dir}）：门${cell.door || '—'}、星${cell.star}、神${cell.god || '—'}`,
  ];
  s += DOOR_SCORE[cell.door] || 0;
  s += STAR_SCORE[cell.star] || 0;
  s += GOD_SCORE[cell.god] || 0;
  s += jitter;
  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons, chart: c };
}

module.exports = { chart, score, JU_TABLE, DOOR_SCORE, STAR_SCORE, GOD_SCORE };

  });

  /* ---- ziwei (ziwei.js) ---- */
  define("ziwei", function (module, exports, require) {
'use strict';
/**
 * 紫微斗数排盘（本命盘 / 当日盘）
 *
 * 规则来源：传统安星诀，并用 iztro（MIT）公开实现中的公式交叉核对：
 *  - 命宫：寅起正月顺数至生月，再逆数生时；身宫：顺数生时
 *  - 命宫天干：五虎遁（甲己丙寅、乙庚戊寅、丙辛庚寅、丁壬壬寅、戊癸甲寅）
 *  - 五行局：纳音巧记（干数＋支数，过五减五；木1金2水3火4土5）
 *  - 紫微星：起紫微星诀（局数除日数，商数宫前走；奇偶定进退）
 *  - 天府星：与紫微相对；紫微诸星逆行、天府诸星顺行
 *  - 四化：南派口诀（甲廉破武阳…癸破巨阴贪）
 *
 * 简化声明：不做大限/流年四化、不再安辅曜（左辅右弼文昌文曲等）——四化若落在未安放的
 * 星曜上会以"未安此星"标注。这套盘用于**结构化择时打分**，不是命理定论。
 */

const L = require('./lunar');
const G = require('./ganzhi');

const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const PALACE_NAMES = ['命宫', '兄弟', '夫妻', '子女', '财帛', '疾厄', '迁移', '仆役', '官禄', '田宅', '福德', '父母'];

/** 寅宫（index 0）天干：五虎遁 */
const TIGER = { 甲: 2, 己: 2, 乙: 4, 庚: 4, 丙: 6, 辛: 6, 丁: 8, 壬: 8, 戊: 0, 癸: 0 };

/** 四化（南派） */
const SIHUA = {
  甲: { 禄: '廉贞', 权: '破军', 科: '武曲', 忌: '太阳' },
  乙: { 禄: '天机', 权: '天梁', 科: '紫微', 忌: '太阴' },
  丙: { 禄: '天同', 权: '天机', 科: '文昌', 忌: '廉贞' },
  丁: { 禄: '太阴', 权: '天同', 科: '天机', 忌: '巨门' },
  戊: { 禄: '贪狼', 权: '太阴', 科: '右弼', 忌: '天机' },
  己: { 禄: '武曲', 权: '贪狼', 科: '天梁', 忌: '文曲' },
  庚: { 禄: '太阳', 权: '武曲', 科: '太阴', 忌: '天同' },
  辛: { 禄: '巨门', 权: '太阳', 科: '文曲', 忌: '文昌' },
  壬: { 禄: '天梁', 权: '紫微', 科: '左辅', 忌: '武曲' },
  癸: { 禄: '破军', 权: '巨门', 科: '太阴', 忌: '贪狼' },
};

const ZIWEI_GROUP = ['紫微', '天机', '', '太阳', '武曲', '天同', '', '', '廉贞'];
const TIANFU_GROUP = ['天府', '太阴', '贪狼', '巨门', '天相', '天梁', '七杀', '', '', '', '破军'];

const fix12 = (n) => ((n % 12) + 12) % 12;
const fix10 = (n) => ((n % 10) + 10) % 10;

/** 纳音巧记 → 五行局 */
function fiveElementsClass(stem, branch) {
  const hs = Math.floor(STEMS.indexOf(stem) / 2) + 1;
  const eb = Math.floor((BRANCHES.indexOf(branch) % 6) / 2) + 1;
  let sum = hs + eb;
  while (sum > 5) sum -= 5;
  return ['木三局', '金四局', '水二局', '火六局', '土五局'][sum - 1];
}

const CLASS_N = { 水二局: 2, 木三局: 3, 金四局: 4, 土五局: 5, 火六局: 6 };

/**
 * 起紫微星诀
 * @param {number} fiveN 局数 2..6
 * @param {number} day 农历日 1..30
 * @returns {{ziweiIndex:number, tianfuIndex:number, steps:number}}
 */
function ziweiIndex(fiveN, day) {
  let offset = 0;
  while ((day + offset) % fiveN !== 0) offset++;
  const q = (day + offset) / fiveN;
  let idx = fix12(q % 12 - 1 + (offset % 2 === 0 ? offset : -offset));
  return { ziweiIndex: idx, tianfuIndex: fix12(12 - idx), steps: offset };
}

/**
 * 排盘
 * @param {Date} date 真实时间戳（北京时间）
 * @param {number} hourIndex 时辰索引 0=子 … 11=亥
 */
function chart(date, hourIndex) {
  const lunar = L.solarToLunar(date);
  const hIdx = fix12(hourIndex == null ? new Date(date.getTime() + 8 * 3600000).getUTCHours() : hourIndex);
  const yearGz = G.ganzhiOf ? null : null;
  // 年干支按农历年（春节换年）
  const idx = ((((lunar.year - 4) % 60) + 60) % 60);
  const yearStem = STEMS[idx % 10];
  const yearBranch = BRANCHES[idx % 12];

  const monthIdx = lunar.month - 1;
  const soulIndex = fix12(monthIdx - hIdx);
  const bodyIndex = fix12(monthIdx + hIdx);

  const stemStart = TIGER[yearStem];
  const soulStem = STEMS[fix10(stemStart + soulIndex)];
  const soulBranch = BRANCHES[fix12(soulIndex + 2)];

  const cls = fiveElementsClass(soulStem, soulBranch);
  const n = CLASS_N[cls];
  const dayForZiwei = lunar.day;
  const { ziweiIndex: zw, tianfuIndex: tf } = ziweiIndex(n, dayForZiwei);

  // 12 宫：index 0 = 寅
  const palaces = [];
  for (let i = 0; i < 12; i++) {
    palaces.push({
      index: i,
      branch: BRANCHES[fix12(i + 2)],
      stem: STEMS[fix10(stemStart + i)],
      name: PALACE_NAMES[fix12(soulIndex - i)], // 命宫起逆时针
      stars: [],
      isSoul: i === soulIndex,
      isBody: i === bodyIndex,
    });
  }

  ZIWEI_GROUP.forEach((s, i) => {
    if (s) palaces[fix12(zw - i)].stars.push(s);
  });
  TIANFU_GROUP.forEach((s, i) => {
    if (s) palaces[fix12(tf + i)].stars.push(s);
  });

  const hua = SIHUA[yearStem] || {};
  const huaByStar = {};
  for (const [k, v] of Object.entries(hua)) huaByStar[v] = k;

  // 命宫 / 身宫 摘要
  const soul = palaces[soulIndex];
  const body = palaces[bodyIndex];
  const soulHua = soul.stars.map((s) => huaByStar[s]).filter(Boolean);
  const bodyHua = body.stars.map((s) => huaByStar[s]).filter(Boolean);

  return {
    lunar: { year: lunar.year, month: lunar.month, day: lunar.day, isLeap: lunar.isLeap },
    yearGanZhi: yearStem + yearBranch,
    hour: { index: hIdx, branch: BRANCHES[hIdx], name: BRANCHES[hIdx] + '时' },
    soul: { index: soulIndex, branch: soulBranch, stem: soulStem, stars: soul.stars, hua: soulHua },
    body: { index: bodyIndex, branch: BRANCHES[fix12(bodyIndex + 2)], stars: body.stars, hua: bodyHua },
    fiveElements: cls,
    fiveN: n,
    ziwei: { index: zw, branch: BRANCHES[fix12(zw + 2)], tianfu: BRANCHES[fix12(tf + 2)] },
    sihua: hua,
    palaces: palaces.map((p) => ({
      ...p,
      hua: p.stars.map((s) => huaByStar[s]).filter(Boolean),
      starsHua: p.stars.map((s) => (huaByStar[s] ? `${s}化${huaByStar[s]}` : s)),
    })),
    missingHua: Object.values(hua).filter((s) => !['文昌', '文曲', '左辅', '右弼'].includes(s) && !ZIWEI_GROUP.includes(s) && !TIANFU_GROUP.includes(s)),
  };
}

/** 吉凶权重（用于择时打分，非命理定论） */
const STAR_SCORE = {
  紫微: 8, 天府: 8, 太阳: 6, 太阴: 6, 天同: 5, 天梁: 5, 天相: 5, 天机: 4, 武曲: 4, 贪狼: 1, 廉贞: -2, 巨门: -4, 七杀: -5, 破军: -6,
};
const HUA_SCORE = { 禄: 10, 权: 6, 科: 5, 忌: -12 };

/**
 * 择时打分：0-100
 * 取命宫主星、四化、身宫同宫情况；不含大限流年
 */
function score(date, hourIndex, jitter = 0) {
  const c = chart(date, hourIndex);
  const reasons = [];
  let s = 50;
  const starSum = c.soul.stars.reduce((a, x) => a + (STAR_SCORE[x] || 0), 0);
  s += starSum;
  reasons.push(`命宫在${c.soul.branch}（${c.soul.stem}${c.soul.branch}），主星：${c.soul.stars.join('、') || '无'}`);
  if (c.soul.hua.length) {
    for (const h of c.soul.hua) {
      s += HUA_SCORE[h] || 0;
      reasons.push(`命宫${h}（${c.sihua[h]}化${h}）`);
    }
  }
  if (c.body.index === c.soul.index) {
    s += 4;
    reasons.push('命身同宫，意志集中');
  } else {
    const bodyStar = c.body.stars.reduce((a, x) => a + (STAR_SCORE[x] || 0), 0);
    s += Math.round(bodyStar / 2);
    reasons.push(`身宫在${c.body.branch}：${c.body.stars.join('、') || '无主星'}`);
  }
  s += jitter;
  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons, chart: c };
}

module.exports = { chart, score, fiveElementsClass, ziweiIndex, SIHUA, PALACE_NAMES, BRANCHES, STAR_SCORE };

  });

  /* ---- timing (timing.js) ---- */
  define("timing", function (module, exports, require) {
'use strict';
/**
 * 择时方法实验室
 *
 * 设计原则（重要）：
 *  1. 每个方法只输出 0-100 的「顺逆分」+ 可读理由，**不做买卖结论**；
 *  2. 标的对分数的影响来自确定性哈希（同标的同日同分，可复现），不来自"玄学直觉"；
 *  3. 所有方法都能被 backtest.timingStats 逐日检验 —— 有本事就用数据证明，没本事就诚实说没有；
 *  4. 组合分（composite）只是加权平均 + 一致性，不代表统计显著的胜率。
 */

const G = require('./ganzhi');
const V = require('./divination');
const ZW = require('./ziwei');
const QM = require('./qimen');
const { hash32 } = require('./divination');

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, Math.round(v)));

/** 方法注册表：权重可在 /api/timing?weights=... 覆盖 */
const METHODS = [
  {
    id: 'ganzhi',
    name: '四柱·节气五行',
    school: '干支历法',
    weight: 0.2,
    desc: '以当日四柱与月令五行的生克、节气过渡期的稳定性打分',
  },
  {
    id: 'meihua',
    name: '梅花易数',
    school: '卦象',
    weight: 0.25,
    desc: '以四柱支序＋标的哈希起卦，按体用生克与卦象吉凶打分',
  },
  {
    id: 'liuyao',
    name: '六爻纳甲',
    school: '卦象',
    weight: 0.2,
    desc: '看动爻六亲、世应、空亡与六神，给出当日进退分',
  },
  {
    id: 'jianchu',
    name: '建除十二神',
    school: '黄历',
    weight: 0.15,
    desc: '按建除值日（建/除/满/平/定/执/破/危/成/收/开/闭）打分',
  },
  {
    id: 'cycle',
    name: '日历周期因子',
    school: '量化',
    weight: 0.2,
    desc: '节气窗口、月初月末、周内效应等可回测的日历因子（作为对照组）',
  },
  {
    id: 'ziwei',
    name: '紫微斗数·流日',
    school: '星曜',
    weight: 0.15,
    desc: '以当日农历排紫微命盘（十二宫＋十四主星＋四化），按命宫主星与四化打分',
  },
  {
    id: 'qimen',
    name: '奇门遁甲·时家',
    school: '历法',
    weight: 0.15,
    desc: '按节气三元起阴阳遁局数，排地盘三奇六仪、天盘九星、八门八神，取时干宫打分',
  },
];

const JIANCHU_SCORE = {
  建: 52, 除: 54, 满: 46, 平: 49, 定: 56, 执: 53,
  破: 26, 危: 34, 成: 70, 收: 52, 开: 64, 闭: 30,
};

const WX_SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const WX_KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };

function methodById(id) {
  return METHODS.find((m) => m.id === id) || null;
}

/** 标的哈希抖动：确定性、可复现，幅度 ±5 分，避免所有标的同分 */
function symbolJitter(market, code, salt = '') {
  const h = hash32(`${market || 'A'}:${String(code || '').toUpperCase()}|${salt}`);
  return (h % 11) - 5;
}

/* ------------------------------------------------------------------ */
/* 各方法打分                                                          */
/* ------------------------------------------------------------------ */

function scoreGanzhi(ctx) {
  const p = ctx.agenda.pillars;
  const dayEl = p.day.wuxing; // 如 "水金"
  const monthEl = p.month.wuxing;
  const dayGanEl = dayEl[0];
  const dayZhiEl = dayEl[1];
  const monthGanEl = monthEl[0];
  const monthZhiEl = monthEl[1];
  const reasons = [];
  let score = 50;

  // 日支 vs 月令：相生为顺，相克为逆
  if (WX_SHENG[dayZhiEl] === monthZhiEl) {
    score += 10;
    reasons.push(`日支${dayZhiEl}生月令${monthZhiEl}，气势顺`);
  } else if (WX_SHENG[monthZhiEl] === dayZhiEl) {
    score += 6;
    reasons.push(`月令${monthZhiEl}生日支${dayZhiEl}，有外援`);
  } else if (WX_KE[dayZhiEl] === monthZhiEl) {
    score -= 10;
    reasons.push(`日支${dayZhiEl}克月令${monthZhiEl}，易犯冲`);
  } else if (WX_KE[monthZhiEl] === dayZhiEl) {
    score -= 12;
    reasons.push(`月令${monthZhiEl}克日支${dayZhiEl}，受制`);
  } else {
    reasons.push(`日支与月令${dayZhiEl === monthZhiEl ? '比和' : '无直接生克'}，中性`);
  }

  // 节气过渡期（±1 天）不确定性高
  const toTerm = ctx.agenda.terms.next ? ctx.agenda.terms.next.daysTo : null;
  const fromTerm = ctx.agenda.terms.prev ? ctx.agenda.terms.prev.daysAgo : null;
  if (toTerm != null && toTerm <= 1) {
    score -= 9;
    reasons.push(`距${ctx.agenda.terms.next.name}仅 ${toTerm} 天，节气换月窗口，结构易断`);
  } else if (fromTerm != null && fromTerm <= 1) {
    score += 4;
    reasons.push(`${ctx.agenda.terms.prev.name}刚过 ${fromTerm} 天，月令已定`);
  }

  score += symbolJitter(ctx.market, ctx.code, 'ganzhi');
  return { score: clamp(score), reasons };
}

function scoreMeihua(ctx) {
  const r = V.analyze({ market: ctx.market, code: ctx.code, mode: 'time', ts: ctx.ts });
  const rel = r.hexagram.relation;
  const reasons = [
    `本卦「${r.hexagram.ben.name}」动第 ${r.hexagram.dong} 爻，变「${r.hexagram.bian.name}」`,
    `${r.hexagram.ti.name}(${r.hexagram.ti.element}) 与 ${r.hexagram.yong.name}(${r.hexagram.yong.element})：${rel.text}（${rel.level}）`,
  ];
  let score = r.hexagram.score;
  if (rel.key === 'otherKe') reasons.push('用克体，今日不宜强攻');
  if (rel.key === 'otherSheng') reasons.push('用生体，有外部助力');
  return { score: clamp(score), reasons, detail: { ben: r.hexagram.ben.name, bian: r.hexagram.bian.name, dong: r.hexagram.dong } };
}

function scoreLiuyao(ctx) {
  const r = V.analyze({ market: ctx.market, code: ctx.code, mode: 'time', ts: ctx.ts });
  const ly = r.liuyao;
  const dong = ly.yaos.find((y) => y.dong);
  const reasons = [`${ly.palace}宫·${ly.gongEl}，世${ly.shi}应${ly.ying}`];
  let score = 50;
  const LQ = { 妻财: 14, 子孙: 12, 父母: -4, 兄弟: -8, 官鬼: -12 };
  if (dong) {
    score += LQ[dong.liuqin] || 0;
    reasons.push(`动爻第 ${dong.pos} 爻：${dong.liuqin}（${dong.zhi}${dong.element}），${dong.kong ? '逢空' : '不空'}`);
    if (dong.kong) {
      score -= 6;
      reasons.push('动爻逢空，信号易落空');
    }
    const LS = { 青龙: 4, 白虎: -4, 玄武: -3, 朱雀: -2, 勾陈: -1, 螣蛇: -1 };
    score += LS[dong.liushen] || 0;
    reasons.push(`六神：${dong.liushen}`);
  }
  const shi = ly.yaos.find((y) => y.shi);
  const ying = ly.yaos.find((y) => y.ying);
  if (shi && ying) {
    if (yinSheng(ying.element, shi.element)) {
      score += 3;
      reasons.push('应生世，外部条件配合');
    } else if (yinSheng(shi.element, ying.element)) {
      score -= 2;
      reasons.push('世生应，自身耗力');
    }
  }
  score += symbolJitter(ctx.market, ctx.code, 'liuyao');
  return { score: clamp(score), reasons, detail: { palace: ly.palace, dong: dong ? dong.liuqin : null } };
}

function yinSheng(a, b) {
  return WX_SHENG[a] === b; // a 生 b
}

function scoreJianchu(ctx) {
  const jc = ctx.agenda.jianchu;
  const base = JIANCHU_SCORE[jc] != null ? JIANCHU_SCORE[jc] : 50;
  const reasons = [`建除值日：${jc}`, jcNote(jc)];
  return { score: clamp(base + symbolJitter(ctx.market, ctx.code, 'jianchu') / 2), reasons, detail: { jianchu: jc } };
}

function jcNote(jc) {
  const map = {
    建: '万物始建，宜小仓试探',
    除: '除旧布新，宜调仓',
    满: '圆满则溢，宜减不宜加',
    平: '平常之日，多为无序震荡',
    定: '宜定不宜动',
    执: '宜守持仓',
    破: '易生意外，最好不交易',
    危: '多陷阱，等结构走完',
    成: '利于成事，结构确认可执行',
    收: '宜收不宜放',
    开: '适合开新方向，留后手',
    闭: '主闭塞，信号易失真',
  };
  return map[jc] || '';
}

function scoreCycle(ctx) {
  const d = new Date(ctx.ts);
  const dow = new Date(d.getTime() + 8 * 3600000).getUTCDay(); // 0=周日
  const p = ctx.agenda.pillars;
  let score = 50;
  const reasons = [];
  const toTerm = ctx.agenda.terms.next ? ctx.agenda.terms.next.daysTo : null;
  const fromTerm = ctx.agenda.terms.prev ? ctx.agenda.terms.prev.daysAgo : null;
  if (toTerm != null && toTerm <= 2) {
    score -= 6;
    reasons.push(`距下一节气 ${toTerm} 天，换月窗口波动放大`);
  }
  if (fromTerm != null && fromTerm <= 2) {
    score += 3;
    reasons.push(`节气后 ${fromTerm} 天，方向常延续`);
  }
  if (dow === 1) {
    score -= 2;
    reasons.push('周一，隔夜跳空风险偏高');
  } else if (dow === 5) {
    score += 1;
    reasons.push('周五，持仓过周末需控风险');
  }
  // 月相：农历日近似用朔望周期（只在研究层面使用，标注为近似）
  const phase = ((ctx.ts / 86400000 + 8) % 29.53) / 29.53;
  if (phase < 0.05 || phase > 0.95) {
    score -= 3;
    reasons.push('朔日附近（近似），历史上波动略高');
  }
  reasons.push(`四柱 ${p.year.text} ${p.month.text} ${p.day.text}，周${'日一二三四五六'[dow]}`);
  score += symbolJitter(ctx.market, ctx.code, 'cycle') / 2;
  return { score: clamp(score), reasons };
}

function scoreZiwei(ctx) {
  const d = new Date(ctx.ts + 8 * 3600000);
  const hourIdx = Math.floor((((d.getUTCHours() + 1) % 24) / 2));
  const r = ZW.score(new Date(ctx.ts), hourIdx, symbolJitter(ctx.market, ctx.code, 'ziwei'));
  const c = r.chart;
  return {
    score: clamp(r.score),
    reasons: r.reasons,
    detail: {
      lunar: `${c.lunar.year}年${c.lunar.isLeap ? '闰' : ''}${c.lunar.month}月${c.lunar.day}日`,
      hour: c.hour.name,
      soul: { branch: c.soul.branch, stem: c.soul.stem, stars: c.soul.stars, hua: c.soul.hua },
      body: { branch: c.body.branch, stars: c.body.stars },
      fiveElements: c.fiveElements,
      ziwei: c.ziwei.branch,
      palaces: c.palaces.map((p) => ({ name: p.name, stem: p.stem, branch: p.branch, stars: p.starsHua })),
      sihua: c.sihua,
    },
  };
}

function scoreQimen(ctx) {
  const r = QM.score(new Date(ctx.ts), symbolJitter(ctx.market, ctx.code, 'qimen'));
  const c = r.chart;
  return {
    score: clamp(r.score),
    reasons: r.reasons,
    detail: {
      dun: c.dun,
      ju: c.ju,
      term: c.term,
      yuan: c.yuan,
      xun: c.xun,
      zhiFu: c.zhiFu,
      zhiShi: c.zhiShi,
      cells: c.cells.map((x) => ({ palace: x.palace, name: x.name, dir: x.dir, yi: x.yi, star: x.star, door: x.door, god: x.god, hourStem: x.hourStem })),
      layout: c.layout,
    },
  };
}

const SCORERS = { ganzhi: scoreGanzhi, meihua: scoreMeihua, liuyao: scoreLiuyao, jianchu: scoreJianchu, cycle: scoreCycle, ziwei: scoreZiwei, qimen: scoreQimen };

function labelOf(score) {
  if (score >= 68) return '顺';
  if (score >= 58) return '偏顺';
  if (score > 42) return '中性';
  if (score > 32) return '偏逆';
  return '逆';
}

/**
 * 综合评估
 * @param {Object} o { market, code, ts=Date.now(), methods?:string[], weights?:{} }
 */
function evaluate(o = {}) {
  const ts = Number.isFinite(o.ts) && o.ts > 0 ? o.ts : Date.now();
  const market = (o.market || 'A').toUpperCase();
  const code = o.code || '';
  const ids = Array.isArray(o.methods) && o.methods.length ? o.methods.filter((x) => SCORERS[x]) : METHODS.map((m) => m.id);
  const ctx = { ts, market, code, agenda: G.agenda(new Date(ts)) };
  const weights = { ...Object.fromEntries(METHODS.map((m) => [m.id, m.weight])), ...(o.weights || {}) };

  const methods = {};
  let wsum = 0;
  let acc = 0;
  for (const id of ids) {
    const meta = methodById(id);
    const r = SCORERS[id](ctx);
    methods[id] = {
      id,
      name: meta.name,
      school: meta.school,
      desc: meta.desc,
      weight: weights[id] || 0,
      score: r.score,
      label: labelOf(r.score),
      reasons: r.reasons,
      detail: r.detail || null,
    };
    if (weights[id] > 0) {
      acc += r.score * weights[id];
      wsum += weights[id];
    }
  }
  const composite = wsum > 0 ? +(acc / wsum).toFixed(1) : 0;
  const scores = Object.values(methods).map((m) => m.score);
  const above = scores.filter((s) => s > 50).length;
  const below = scores.filter((s) => s < 50).length;
  const agreement = scores.length ? +(Math.max(above, below) / scores.length).toFixed(2) : 0;
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;

  return {
    ts,
    beijingTime: ctx.agenda.beijingTime,
    pillars: ctx.agenda.pillars,
    jianchu: ctx.agenda.jianchu,
    target: { market, code },
    methods,
    composite,
    label: labelOf(composite),
    agreement,
    spread,
    weights,
    verdict: buildVerdict(composite, agreement, spread, methods),
    disclaimer: '择时分数是传统历法/卦象方法的结构化表达，没有任何统计证据表明可稳定提高胜率；请把它当纪律与观察工具，不是信号源。',
  };
}

function buildVerdict(composite, agreement, spread, methods) {
  const detail = Object.values(methods)
    .sort((a, b) => b.weight * (b.score - 50) - a.weight * (a.score - 50))
    .slice(0, 2)
    .map((m) => `${m.name} ${m.score}（${m.label}）`)
    .join(' · ');
  if (agreement >= 0.8 && spread <= 25) {
    return { level: 'consistent', text: `多数方法方向一致（一致性 ${(agreement * 100).toFixed(0)}%），分差仅 ${Math.round(spread)}；越一致越可能只是日历效应，别当成信号：${detail}` };
  }
  if (spread >= 45) {
    return { level: 'conflict', text: `方法间分歧极大（${Math.round(spread)} 分），今日更适合观望或降仓位：${detail}` };
  }
  return { level: 'mixed', text: `方法间部分一致（一致性 ${(agreement * 100).toFixed(0)}%）：${detail}` };
}

module.exports = { METHODS, evaluate, labelOf, SCORERS };

  });

  /* ---- drawing (drawing.js) ---- */
  define("drawing", function (module, exports, require) {
/**
 * 用户手绘线 · 校验引擎（AI 辅助纠错的"规则层"）
 *
 * 输入：手绘线 [{type,x1,y1,x2,y2,label}]（x = K 线序号，y = 价格）+ 缠论分析结果
 * 输出：{score, verdict, findings[], stats} —— 完全确定，可复现，可单测
 *
 * 设计取向（重要）：
 *   缠论不靠趋势线交易，判的是"笔/线段/中枢/背驰/买卖点"。所以这里不是"猜你想画什么"，
 *   而是把用户画的线放到结构坐标里对齐：端点是否落在笔的端点上、平线是否就是中枢上下沿、
 *   框是否框住了中枢、线是否穿中枢（震荡而非趋势）、端点是否贴着买卖点……
 *   每条结论都给出可核对的数值，不做玄学解释。
 */
'use strict';

const TOL_PRICE = 0.004; // 价格容差 0.4%（吸附判定）
const TOL_BAR = 2; // K 线序号容差

const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const pct = (a, b) => (b ? (a - b) / b : 0);

function nearestBiEndpoint(bis, idx, price) {
  let best = null;
  for (const bi of bis) {
    for (const [i, p] of [
      [bi.i0, bi.p0],
      [bi.i1, bi.p1]
    ]) {
      const dIdx = Math.abs(i - idx);
      const dPrice = Math.abs(pct(price, p));
      const score = dIdx + dPrice * 200; // 序号差 + 价格差加权
      if (!best || score < best.score) best = { score, idx: i, price: p, dIdx, dPrice, dir: bi.dir, bi };
    }
  }
  return best;
}

function nearestSignal(signals, idx, price) {
  let best = null;
  for (const s of signals) {
    const dIdx = Math.abs(s.barIdx - idx);
    const dPrice = Math.abs(pct(price, s.price));
    const score = dIdx + dPrice * 200;
    if (!best || score < best.score) best = { score, s, dIdx, dPrice };
  }
  return best;
}

function pivotAt(pivots, idx) {
  return pivots.find((p) => idx >= p.i0 && idx <= p.i1) || null;
}

/**
 * @param {{type:string,x1:number,y1:number,x2?:number,y2?:number,label?:string,id?:string}} line
 * @param {object} a  analyze() 的结果
 * @param {{bars?:number}} [opts]
 */
function checkLine(line, a, opts = {}) {
  const findings = [];
  const bars = a.bars || [];
  const bis = a.bis || [];
  const pivots = a.pivots || [];
  const signals = a.signals || [];
  const add = (level, code, text, extra) => findings.push({ level, code, text, ...extra });

  if (!bars.length) {
    add('fail', 'no-data', '没有 K 线数据，无法校验');
    return { findings, score: 0 };
  }
  const last = bars.length - 1;
  const clampIdx = (i) => Math.max(0, Math.min(last, Math.round(i)));
  const priceOf = (i) => bars[clampIdx(i)].c;
  let score = 70; // 基准分：一条合法但无特别含义的线
  const stats = {};

  if (!Number.isFinite(Number(line.x1)) || !Number.isFinite(Number(line.y1)) ||
      (line.type !== 'hline' && line.x2 != null && !Number.isFinite(Number(line.x2))) ||
      (line.type !== 'hline' && line.y2 != null && !Number.isFinite(Number(line.y2)))) {
    add('fail', 'bad-value', '坐标不是有效数值（可能画到画布外或数据未加载），这条线不计入结论');
    return { findings, score: 0, stats: {} };
  }
  const x1 = clampIdx(line.x1);
  const y1 = Number(line.y1);
  const isLevel = line.type === 'hline';
  const isRect = line.type === 'rect';
  const x2 = clampIdx(line.x2 != null ? line.x2 : x1);
  const y2 = Number(line.y2 != null ? line.y2 : y1);

  if (!Number.isFinite(y1) || !Number.isFinite(y2)) {
    add('fail', 'bad-value', '坐标不是有效数值，画线未保存成功');
    return { findings, score: 0 };
  }

  /* ---- 1. 端点是否落在笔的端点上（缠论里线段/笔的转折点才是"有效点位"） ---- */
  if (!isLevel && !isRect) {
  const ep1 = nearestBiEndpoint(bis, x1, y1);
  if (ep1 && ep1.dIdx <= TOL_BAR && ep1.dPrice <= TOL_PRICE) {
    score += 8;
    add('ok', 'snap-bi', `起点正好落在笔的端点（第 ${ep1.idx} 根，${round(ep1.price)}），这是结构里有效的转折点`, { bar: ep1.idx });
    stats.snapStart = true;
  } else if (ep1) {
    add(
      'warn',
      'off-bi',
      `起点离最近的笔端点有 ${ep1.dIdx} 根、${(ep1.dPrice * 100).toFixed(2)}% 的价格差——缠论的意义点位是笔的端点，建议吸附过去`,
      { bar: ep1.idx }
    );
    score -= 6;
    stats.snapStart = false;
  }
  }

  if (!isLevel && !isRect) {
    const ep2 = nearestBiEndpoint(bis, x2, y2);
    if (ep2 && ep2.dIdx <= TOL_BAR && ep2.dPrice <= TOL_PRICE) {
      score += 8;
      add('ok', 'snap-bi-end', `终点落在笔的端点（第 ${ep2.idx} 根，${round(ep2.price)}）`, { bar: ep2.idx });
      stats.snapEnd = true;
    } else if (ep2) {
      add('warn', 'off-bi-end', `终点离最近的笔端点有 ${ep2.dIdx} 根、${(ep2.dPrice * 100).toFixed(2)}% 的价格差`, { bar: ep2.idx });
      score -= 6;
      stats.snapEnd = false;
    }
    /* ---- 2. 方向与结构是否一致 ---- */
    const slope = y2 - y1;
    const spanBars = Math.max(1, x2 - x1);
    const dirWord = slope > 0 ? '向上' : '向下';
    const trendType = (a.trend && a.trend.type) || '';
    const isUp = /上涨/.test(trendType);
    const isDown = /下跌/.test(trendType);
    if (isUp && slope < 0) add('warn', 'against-trend', `当前走势是「${trendType}」，这条线却是${dirWord}的——逆势线在缠论里只能当"次级别回抽"看，不能当主趋势`);
    else if (isDown && slope > 0) add('warn', 'against-trend', `当前走势是「${trendType}」，这条线却是${dirWord}的——同上，只能算次级别反抽`);
    else if (isUp || isDown) add('ok', 'with-trend', `线的方向与「${trendType}」一致`);
    else add('info', 'trend-neutral', `当前是「${trendType || '走势未定'}」，没有明确方向可以对照——这类线只能当区间参考`);
    stats.slopePerBar = round(slope / spanBars, 4);

    /* ---- 3. 是否穿过中枢（穿中枢 = 中枢震荡，不是趋势） ---- */
    const mid = pivots.filter((p) => p.i1 >= Math.min(x1, x2) && p.i0 <= Math.max(x1, x2));
    const crossing = mid.filter((p) => {
      const pAtStart = y1;
      const pAtEnd = y2;
      const lowAt = Math.min(pAtStart, pAtEnd);
      const highAt = Math.max(pAtStart, pAtEnd);
      return !(highAt < p.zd || lowAt > p.zg);
    });
    if (crossing.length) {
      add('warn', 'cross-pivot', `这条线横穿了 ${crossing.length} 个中枢的价格带（${crossing.map((p) => `${round(p.zd)}~${round(p.zg)}`).join('、')}）——穿中枢的走势是中枢震荡，不是趋势，别当成趋势线用`);
      score -= 8;
    }
  }

  /* ---- 4. 水平线 vs 中枢边界 / 前高前低 ---- */
  if (isLevel) {
    const nearPivotEdge = pivots
      .map((p) => ({ p, d: Math.min(Math.abs(pct(y1, p.zg)), Math.abs(pct(y1, p.zd))), edge: Math.abs(pct(y1, p.zg)) < Math.abs(pct(y1, p.zd)) ? '上沿 ZG' : '下沿 ZD' }))
      .filter((x) => x.d <= TOL_PRICE)
      .sort((a2, b2) => a2.d - b2.d)[0];
    if (nearPivotEdge) {
      score += 10;
      add('ok', 'pivot-edge', `这条水平线就是第 ${nearPivotEdge.p.idx + 1} 个中枢的${nearPivotEdge.edge}（${round(nearPivotEdge.edge.includes('ZG') ? nearPivotEdge.p.zg : nearPivotEdge.p.zd)}），是有结构含义的支撑/压力`);
    } else {
      const highs = bars.map((b) => b.h);
      const lows = bars.map((b) => b.l);
      const nearHigh = Math.min(...highs.map((h) => Math.abs(pct(y1, h))));
      const nearLow = Math.min(...lows.map((l) => Math.abs(pct(y1, l))));
      if (Math.min(nearHigh, nearLow) <= TOL_PRICE / 3) {
        score += 4;
        add('ok', 'extreme', `水平线贴近区间${nearHigh < nearLow ? '最高价' : '最低价'}，可作前高/前低参考`);
      } else {
        add('warn', 'floating-level', '这条水平线既不贴中枢上下沿，也不贴前高前低——缠论里"任意价位"没有结构意义');
        score -= 5;
      }
    }
  }

  /* ---- 5. 矩形是否框住中枢 ---- */
  if (isRect) {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    const i0 = Math.min(x1, x2);
    const i1 = Math.max(x1, x2);
    const inside = pivots.filter((p) => p.i0 >= i0 - TOL_BAR && p.i1 <= i1 + TOL_BAR && p.zd >= lo * (1 - 0.01) && p.zg <= hi * (1 + 0.01));
    if (inside.length) {
      score += 15;
      add('ok', 'box-pivot', `这个框正好圈住第 ${inside.map((p) => p.idx + 1).join('、')} 个中枢 —— 中枢是缠论的核心对象，框对了就抓住了结构`);
    } else {
      const overlap = pivots.filter((p) => p.i1 >= i0 && p.i0 <= i1);
      if (overlap.length) {
        score += 4;
        add('warn', 'box-partial', `框与 ${overlap.length} 个中枢有重叠但没对齐（中枢带是 ${overlap.map((p) => `${round(p.zd)}~${round(p.zg)}`).join('、')}）`, {});
      } else {
        add('warn', 'box-empty', '这个框里没有任何中枢，只是一段价格区间，参考价值有限');
        score -= 5;
      }
    }
  }

  /* ---- 6. 端点是否贴着买卖点 ---- */
  const epPairs = isLevel ? [[x1, y1, '价格']] : [[x1, y1, '起点'], [x2, y2, '终点']];
  for (const [idx, price, tag] of epPairs) {
    const ns = nearestSignal(signals, idx, price);
    if (ns && ns.dIdx <= TOL_BAR && ns.dPrice <= TOL_PRICE) {
      score += 12;
      add('ok', 'near-signal', `${tag}贴着「${ns.s.name}」（第 ${ns.s.barIdx} 根，${round(ns.s.price)}），这是缠论的买卖点，比趋势线更有操作意义`, { bar: ns.s.barIdx });
    }
  }

  /* ---- 7. 数据量兜底 ---- */
  if (bars.length < 60) {
    add('warn', 'few-bars', `当前只有 ${bars.length} 根 K 线，结构（笔/中枢）可能还在形成中，结论置信度下降`);
    score -= 8;
  }

  /* ---- 8. 常识性拐点识别 ---- */
  if (!isLevel && !isRect) {
    const between = bars.slice(Math.min(x1, x2), Math.max(x1, x2) + 1);
    if (between.length > 4) {
      const hi = Math.max(...between.map((b) => b.h));
      const lo = Math.min(...between.map((b) => b.l));
      const overshoot = Math.max(...between.map((b) => Math.max(b.h - Math.max(y1, y2), Math.min(y1, y2) - b.l)));
      const beyond = between.filter((b) => b.h > Math.max(y1, y2) + (hi - lo) * 0.05 || b.l < Math.min(y1, y2) - (hi - lo) * 0.05).length;
      if (hi > lo && beyond >= 3 && beyond / between.length > 0.25) {
        add('warn', 'cut-candles', `${beyond} 根 K 线穿到了线的另一侧（占这段 ${Math.round((beyond / between.length) * 100)}%），线没有贴着这波走势的边界`, {});
        score -= 4;
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { findings, score, stats };
}

/**
 * 校验一整组手绘线
 * @param {{drawings:Array, analysis:object}} input
 */
function verify({ drawings = [], analysis, market, code, period }) {
  const a = analysis || {};
  const results = drawings.map((d, i) => {
    const r = checkLine(d, a, {});
    return {
      id: d.id || 'line-' + (i + 1),
      type: d.type,
      label: d.label || '',
      score: r.score,
      findings: r.findings,
      stats: r.stats
    };
  });

  const all = results.flatMap((r) => r.findings);
  const okN = all.filter((f) => f.level === 'ok').length;
  const warnN = all.filter((f) => f.level === 'warn').length;
  const failN = all.filter((f) => f.level === 'fail').length;
  const avg = results.length ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0;

  let verdict;
  if (!results.length) verdict = { level: 'info', text: '还没有画线。先用工具栏画一条趋势线或水平线，我再帮你和笔/中枢/买卖点对齐。' };
  else if (failN) verdict = { level: 'fail', text: `有 ${failN} 条硬错误（坐标无效等），先修掉再看结论。` };
  else if (avg >= 80) {
    const hitsPivot = all.some((f) => f.code === 'pivot-edge' || f.code === 'box-pivot');
    const hitsSignal = all.some((f) => f.code === 'near-signal');
    const snaps = all.filter((f) => f.code === 'snap-bi' || f.code === 'snap-bi-end').length;
    const facts = [
      snaps ? `有 ${snaps} 个端点落在笔端点上` : '',
      hitsPivot ? '有线的价位/框与中枢对齐' : '',
      hitsSignal ? '有端点贴着买卖点' : ''
    ].filter(Boolean);
    verdict = { level: 'ok', text: `画法与结构基本吻合（平均 ${avg} 分）：${facts.join('，') || '整体没有明显冲突'}。` };
  }
  else if (avg >= 60) verdict = { level: 'warn', text: `画法大致合理（平均 ${avg} 分），但还有 ${warnN} 处可以对齐：优先把端点吸到笔的端点、把水平线贴到中枢上下沿。` };
  else verdict = { level: 'warn', text: `画法与结构偏离较多（平均 ${avg} 分）：${warnN} 处提示。缠论不看趋势线，建议改用"框住中枢 + 标出买卖点"的方式。` };

  const method = {
    ok: okN,
    warn: warnN,
    fail: failN,
    steps: [
      '把每个端点吸附到最近的"笔端点"（缠论的有效转折点）',
      '把水平线贴到中枢的 ZG/ZD，而不是任意价位',
      '用它框住中枢，再在买卖点上标注，比画趋势线更接近缠论的用法',
      '穿中枢的线要当"中枢震荡"看，不要当趋势'
    ]
  };
  return {
    ok: true,
    market,
    code,
    period,
    level: a.level || period,
    lines: results,
    score: avg,
    verdict,
    method,
    engine: 'rule-based (deterministic)',
    disclaimer: '这是结构对齐检查，不是投资建议；缠论的买卖点结论以结构本身为准，手绘线只作辅助理解。'
  };
}

module.exports = { verify, checkLine, TOL_PRICE, TOL_BAR };

  });

  /* ---- game (game.js) ---- */
  define("game", function (module, exports, require) {
/**
 * 「缠关 · 108」闯关小游戏 · 关卡引擎（服务端）
 *
 * 设计要点
 *   1. 关卡由 **真实最新行情** 生成：每次取现在能拿到的最新 K 线，随机截断到某个位置，
 *      让玩家判断"接下来会怎么走 / 买卖点在哪 / 中枢在哪"。
 *   2. 答案绝不下发给客户端：出题只给截断前的 K 线 + 一张 token；
 *      判分时服务端用同一份数据重算答案（同一 code/period/cutoff 数据稳定），再比对。
 *   3. 完全确定性：level = f(no, cutoff, data)，同样的输入永远同样的题与分。
 *
 * 关卡结构：108 关，按 14 个主题分章，难度分四档（青铜/白银/黄金/王者），
 * 题型按主题分配：看未来（predict）/ 找买卖点（signal）/ 框中枢（pivot）/ 判背驰（beichi）。
 */
'use strict';

const crypto = require('crypto');
const S = require('./sources');
const C = require('./chan');

let SECRET = process.env.GAME_SECRET || null;
function secret() {
  if (!SECRET) {
    // 惰性生成：避免 require 阶段就产生副作用（单测/脚本 require 时会刷警告）
    SECRET = crypto.randomBytes(16).toString('hex');
    console.warn('[game] GAME_SECRET 未设置，已随机生成（重启后旧关卡会失效，属预期）');
  }
  return SECRET;
}
const HIDDEN = 12; // 每关隐藏 12 根 K 线等着玩家判断

/* 题库素材：四市场轮换，保证"最新行情"覆盖各市场 */
const POOL = {
  A: ['600519', '300750', '000001', '601899', '002594', '688981', '600036', '601318', '000858', '002415'],
  HK: ['00700', '09988', '03690', '01810', '00981', '02318'],
  US: ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'GOOGL', 'META'],
  CR: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  CNF: ['RB0', 'AU0', 'IF0', 'CU0', 'M0', 'TA0', 'SR0', 'AG0'],
  USF: ['ES', 'NQ', 'GC', 'CL', 'SI', 'HG', 'YM', 'NG']
};

const RANKS = [
  { key: 'bronze', name: '青铜', range: [1, 27], color: '#b08d57' },
  { key: 'silver', name: '白银', range: [28, 54], color: '#9aa7b8' },
  { key: 'gold', name: '黄金', range: [55, 81], color: '#e0b15a' },
  { key: 'king', name: '王者', range: [82, 108], color: '#a78bfa' }
];

/* 主题 id → 题型（chan-lessons 的 14 个主题） */
const THEME_MECHANIC = {
  guide: 'predict',
  basics: 'predict',
  pivot: 'pivot',
  signal: 'signal',
  beichi: 'beichi',
  multi: 'pivot',
  zhongyin: 'predict',
  macro: 'predict',
  money: 'predict',
  daily: 'signal',
  mind: 'predict',
  art: 'predict',
  misc: 'signal',
  early: 'predict'
};

const hash = (s) => crypto.createHash('sha1').update(s + SECRET).digest('hex');
const pick = (arr, seed) => arr[parseInt(seed.slice(0, 8), 16) % arr.length];

function rankOf(no) {
  return RANKS.find((r) => no >= r.range[0] && no <= r.range[1]) || RANKS[0];
}

/**
 * 关卡地图：108 关，每关绑定一课（来自 chan-lessons 的课程索引）
 */
function buildMap(K) {
  const themes = (K.THEMES || []).slice(0, 14);
  const lessons = (K.LESSONS || []).slice(0, 108);
  const byTheme = new Map(themes.map((t) => [t.id, { idx: themes.indexOf(t) + 1, id: t.id, name: t.name, desc: t.desc, mechanic: THEME_MECHANIC[t.id] || 'predict', levels: [] }]));
  const chapters = [...byTheme.values()];
  for (let no = 1; no <= 108; no++) {
    const lesson = lessons[no - 1] || {};
    const ch = byTheme.get(lesson.theme) || chapters[0];
    ch.levels.push({
      no,
      rank: rankOf(no).key,
      mechanic: ch.mechanic,
      title: lesson.title || `${ch.name} · 第 ${no} 练`,
      theme: ch.id,
      themeName: ch.name,
      gist: lesson.gist || ch.desc || '',
      confirmed: !!lesson.confirmed
    });
  }
  return { chapters, ranks: RANKS, total: 108, hiddenBars: HIDDEN };
}

function levelPlan(no) {
  const seed = hash('level:' + no);
  // 六个市场轮换：A股权重稍高（用户主要是国内），期货占 1/3
  const markets = ['A', 'A', 'A', 'HK', 'US', 'US', 'CR', 'CNF', 'CNF', 'USF', 'USF'];
  const market = markets[parseInt(seed.slice(0, 2), 16) % markets.length];
  const code = pick(POOL[market], seed.slice(2));
  const rank = rankOf(no).key;
  const hidden = rank === 'king' ? 20 : rank === 'gold' ? 16 : rank === 'silver' ? 14 : 12;
  // 截断点在历史里随机（同一关固定）：否则每关都截在最后一段，108 关会大量重复
  const offset = parseInt(seed.slice(8, 12), 16) % 90;
  return { seed, market, code, hidden, rank, offset };
}

async function fetchBars(market, code) {
  const kl = await S.klines({ market, code, period: 'day', limit: 320 });
  if (!kl || !kl.bars || kl.bars.length < 120) throw new Error('行情样本不足，暂时开不了这一关');
  return kl;
}

/* ---------------- 答题凭据（单次有效） ----------------
   同一个 token 不能被反复提交（否则"看走势"只有三选一，试三次必中）。
   这里保存 attempt：{no, market, code, cutoffT, used, at}，
   判分时按 cutoffT 在最新数据里重新定位那根 K 线（数据只会往后追加，时间戳不会变）。 */
const ATTEMPTS = new Map();
const ATTEMPT_TTL = 20 * 60 * 1000;
const ATTEMPT_MAX = 300;

function purgeAttempts() {
  const now = Date.now();
  for (const [k, v] of ATTEMPTS) if (now - v.at > ATTEMPT_TTL) ATTEMPTS.delete(k);
  while (ATTEMPTS.size > ATTEMPT_MAX) ATTEMPTS.delete(ATTEMPTS.keys().next().value);
}

/** 从 K 线里算这一关的"正确答案"（服务端专用） */
function computeAnswer(plan, bars, offset) {
  const off = offset == null ? plan.offset || 0 : offset;
  const cutoff = Math.max(130, Math.min(bars.length - plan.hidden, bars.length - plan.hidden - off)); // 隐藏起点（随机靠前）
  const a = C.analyze(bars.slice(0, cutoff), { period: 'day', market: plan.market, code: plan.code });
  const future = bars.slice(cutoff, cutoff + plan.hidden);
  const firstClose = bars[cutoff - 1].c;
  const lastClose = future[future.length - 1].c;
  const ret = (lastClose - firstClose) / firstClose;
  const hi = Math.max(...future.map((b) => b.h));
  const lo = Math.min(...future.map((b) => b.l));
  const amp = (hi - lo) / firstClose;
  // 震荡带：按"同样长度的历史窗口"的中位绝对涨幅自适应（A股/加密/美股差异很大）
  const windowRets = [];
  for (let i = 40; i + plan.hidden < cutoff; i += 7) {
    const a0 = bars[i].c;
    const a1 = bars[i + plan.hidden].c;
    if (a0 > 0) windowRets.push(Math.abs((a1 - a0) / a0));
  }
  windowRets.sort((x, y) => x - y);
  const median = windowRets.length ? windowRets[Math.floor(windowRets.length / 2)] : 0.04;
  const flatBand = Math.max(0.015, Math.min(0.05, median * 0.6));
  const dir = ret > flatBand ? 'up' : ret < -flatBand ? 'down' : 'flat';
  // 截断处最近的结构信号（用于讲解 + 加分）
  const lastSignal = (a.signals || []).slice(-1)[0] || null;
  const lastPivot = (a.pivots || []).filter((p) => p.i1 <= cutoff - 1).slice(-1)[0] || null;
  const lastBi = (a.bis || []).slice(-1)[0] || null;
  return { cutoff, future, ret, amp, dir, flatBand, hi, lo, analysis: a, lastSignal, lastPivot, lastBi, firstClose, lastClose };
}

function tokenFor(no, market, code, cutoff) {
  return crypto.createHmac('sha256', secret()).update(`${no}|${market}|${code}|${cutoff}`).digest('hex').slice(0, 24);
}

/**
 * 出一关：只返回截断前可见的数据 + 题目 + token
 */
async function makeLevel(K, no) {
  if (!(no >= 1 && no <= 108)) throw new Error('关卡号需在 1–108 之间');
  const plan = levelPlan(no);
  const kl = await fetchBars(plan.market, plan.code);
  const bars = kl.bars;
  const ans = computeAnswer(plan, bars, plan.offset);
  // 匿名化：出题阶段不告诉玩家是哪个标的，也不给真实时间轴，
  // 否则玩家可以直接查 /api/kline 把隐藏段读出来（等于开卷）。
  const visible = bars.slice(0, ans.cutoff).map((b, i) => ({
    t: Date.UTC(2020, 0, 1) + i * 86400000,
    o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
  }));
  const map = buildMap(K);
  const level = map.chapters.flatMap((c) => c.levels).find((l) => l.no === no) || {};

  purgeAttempts();
  const attemptId = crypto.randomUUID();
  const cutoffT = bars[ans.cutoff - 1].t;
  ATTEMPTS.set(attemptId, { no, market: plan.market, code: plan.code, cutoffT, used: false, at: Date.now() });

  const base = {
    ok: true,
    no,
    rank: plan.rank,
    rankName: rankOf(no).name,
    mechanic: level.mechanic,
    theme: level.theme,
    title: level.title,
    gist: level.gist,
    market: plan.market,
    marketLabel: { A: 'A股', HK: '港股', US: '美股', CR: '加密' }[plan.market] || plan.market,
    period: 'day',
    visibleBars: visible,
    hidden: plan.hidden,
    attemptId,
    token: tokenFor(no, plan.market, plan.code, ans.cutoff) // 仅用于完整性校验，含尝试 id 之外的指纹
  };

  if (level.mechanic === 'predict') {
    base.question = {
      type: 'predict',
      text: `接下来 ${plan.hidden} 根日线（已隐藏），你判断怎么走？`,
      options: [
        { k: 'up', label: '看涨 ↑', desc: '向上突破 / 延续上涨' },
        { k: 'down', label: '看跌 ↓', desc: '向下破位 / 转跌' },
        { k: 'flat', label: '震荡 →', desc: '区间内震荡，方向不明' }
      ]
    };
  } else if (level.mechanic === 'signal') {
    base.question = { type: 'signal', text: '在这张图上点出你觉得的「买卖点」所在 K 线（点最近的一根）' };
  } else if (level.mechanic === 'pivot') {
    base.question = { type: 'pivot', text: '拖一个框，把这段走势里的「中枢」框出来' };
  } else {
    base.question = {
      type: 'beichi',
      text: '这段走势的最后一段，出现了背驰吗？',
      options: [
        { k: 'yes', label: '有背驰', desc: '力度衰减，趋势可能结束' },
        { k: 'no', label: '没有背驰', desc: '力度延续，趋势未完' }
      ]
    };
  }
  return base;
}

/** 判分：答案由服务端重算，客户端只提交选择/点击位置 */
async function gradeLevel(K, { no, token, attemptId, answer }) {
  purgeAttempts();
  const att = ATTEMPTS.get(attemptId);
  if (!att) throw new Error('这道题已过期，请重新开一关');
  if (att.used) throw new Error('这道题已经判过分了，同一题不能重复作答');
  if (Number(no) !== att.no) throw new Error('关卡号不匹配');
  const plan = levelPlan(Number(no));
  const kl = await fetchBars(att.market, att.code);
  const cutoffIdx = kl.bars.findIndex((b) => b.t === att.cutoffT);
  if (cutoffIdx < 0) throw new Error('行情数据已更新，这题失效了，重新开一关吧');
  // cutoff = cutoffIdx + 1 → offset = len - hidden - cutoff
  const ans = computeAnswer(plan, kl.bars, kl.bars.length - plan.hidden - (cutoffIdx + 1));
  const expect = tokenFor(Number(no), att.market, att.code, ans.cutoff);
  if (!token || token !== expect) throw new Error('校验失败，请重新开一关');
  att.used = true; // 单次有效：判完即作废
  const map = buildMap(K);
  const level = map.chapters.flatMap((c) => c.levels).find((l) => l.no === Number(no)) || {};
  const revealed = kl.bars;
  let score = 0;
  let verdict = '';
  const explain = [];

  const sd = (ans.lastSignal && ans.lastSignal.name) || '暂无买卖点';
  const pv = ans.lastPivot ? `中枢 ${ans.lastPivot.zd.toFixed(2)}~${ans.lastPivot.zg.toFixed(2)}` : '尚无中枢形成';

  if (level.mechanic === 'predict') {
    const correct = answer === ans.dir;
    const agree = ans.lastSignal && ((ans.dir === 'up' && /B$/.test(ans.lastSignal.type)) || (ans.dir === 'down' && /S$/.test(ans.lastSignal.type)));
    if (correct) {
      score = 70 + Math.min(28, Math.round((Math.abs(ans.ret) / 0.06) * 28));
      if (agree) score = Math.min(100, score + 8); // 与结构信号一致，额外加分
      verdict = agree ? '方向对，而且还和缠论信号同向' : '方向判断正确';
    } else if (answer === 'flat' || ans.dir === 'flat') {
      score = 45; // 方向与震荡互判，算半对
      verdict = '方向把握偏了（震荡与趋势混淆）';
    } else {
      score = 8;
      verdict = '方向判断反了';
    }
    explain.push(`实际走势：${(ans.ret * 100).toFixed(2)}%（振幅 ${(ans.amp * 100).toFixed(1)}%），震荡带 ±${(ans.flatBand * 100).toFixed(1)}%，判为「${ans.dir}」；你选的是「${answer}」。`);
    explain.push(`截断时的结构：${sd}；${pv}。`);
    if (ans.lastBi) explain.push(`最后一笔：${ans.lastBi.dir > 0 ? '向上' : '向下'}（${ans.lastBi.p0.toFixed(2)} → ${ans.lastBi.p1.toFixed(2)}）。`);
  } else if (level.mechanic === 'signal') {
    const target = ans.lastSignal;
    if (!target) {
      score = answer && answer.idx != null ? 40 : 0;
      verdict = '隐藏段里其实没有标准买卖点';
      explain.push('这段走势没有形成规范的 1/2/3 类买卖点，游戏不计较你点哪儿，记住"没有信号也是一种信号"。');
    } else {
      const d = Math.abs(Number(answer && answer.idx) - target.barIdx);
      score = d <= 1 ? 100 : Math.max(0, Math.round(96 - d * 6));
      verdict = d <= 1 ? '正中买卖点！' : d <= 4 ? '离得很近' : d <= 10 ? '有点偏' : '偏得比较远';
      explain.push(`标准答案是「${target.name}」在第 ${target.barIdx} 根（价格 ${target.price.toFixed(2)}），你点在第 ${answer && answer.idx} 根，差 ${d} 根。`);
      explain.push('提示：买卖点一定贴着笔的端点，而且三类买卖点各有前置条件（中枢位置）。');
    }
  } else if (level.mechanic === 'pivot') {
    const target = ans.lastPivot;
    if (!target) {
      score = 40;
      verdict = '这段走势还没形成中枢';
      explain.push('中枢需要至少三段次级别走势重叠，样本不足时不该硬框。');
    } else {
      const box = answer && answer.box;
      if (!box) {
        score = 0;
        verdict = '没有框';
      } else {
        /*
          分维度判分（时间 × 价格各占一半），并给合理容差：
          - 时间轴：允许 ±2 根，框大一点（把震荡区一起圈进去）不该重罚
          - 价格轴：允许 ±(中枢高度 × 0.25)
          只用 IoU 会把"按缠论把整个震荡区框住"判成低分——那是标准答案太窄，不是玩家错。
        */
        const i0 = Math.min(box.x1, box.x2), i1 = Math.max(box.x1, box.x2);
        const lo = Math.min(box.y1, box.y2), hi = Math.max(box.y1, box.y2);
        const tCap = Math.max(1, target.i1 - target.i0);
        const pCap = Math.max(1e-9, target.zg - target.zd);

        /*
          覆盖度模型（复审核出过"框一半得 95 分"的非单调问题，这里按定义重写）：
            coverage = 标准区间被你的框盖住的比例（时间、价格各算再取平均）→ 决定得分
            over     = 你的框超出标准区间的相对量 → 只做扣分项（不给基础分）
            score    = 100 × coverage × (1 - 0.3×min(over,1))
          性质（单调）：
            · 精确框 → coverage=1, over=0 → 100
            · 框得更大但完整覆盖 → coverage=1, over 小 → 90 左右
            · 价格只框住下半 50% → coverage≈0.5 → 50 左右
            · 时间只框一半 → ≈50
            · 乱框（不相交）→ coverage=0 → 0
        */
        const tInter = Math.max(0, Math.min(i1, target.i1) - Math.max(i0, target.i0));
        const pInter = Math.max(0, Math.min(hi, target.zg) - Math.max(lo, target.zd));
        const tCover = tInter / tCap;         // 时间覆盖率 0..1
        const pCover = pInter / pCap;         // 价格覆盖率 0..1
        const coverage = Math.max(0, Math.min(1, (tCover + pCover) / 2));
        // 超出量：框比标准大多少（相对于标准自身尺寸）
        const tOver = Math.max(0, (i1 - i0) - tCap) / tCap;
        const pOver = Math.max(0, (hi - lo) - pCap) / pCap;
        const over = Math.min(1, (tOver + pOver) / 2);
        score = Math.round(100 * coverage * (1 - 0.3 * over));
        verdict = score >= 85 ? '框得很准' : score >= 60 ? '大致框住了' : score > 0 ? '偏离较多' : '没框到中枢';
        explain.push(`标准中枢：第 ${target.i0}~${target.i1} 根，价格 ${target.zd.toFixed(2)}~${target.zg.toFixed(2)}（${target.count} 笔）。`);
        explain.push(`你的框：第 ${i0}~${i1} 根，${lo.toFixed(2)}~${hi.toFixed(2)}。时间覆盖 ${(tCover * 100).toFixed(0)}%、价格覆盖 ${(pCover * 100).toFixed(0)}%${coverage >= 0.999 ? '（完整框住标准中枢）' : '（没框全，把范围放大一点）'}${over > 0.05 ? `，框子偏大 ${(over * 100).toFixed(0)}% 略有扣分` : ''}。`);
        explain.push('对照要点：中枢区间是前三笔的重叠区，后续笔只要还在区间附近震荡就算中枢延伸——框住整个震荡区也是对的。');
      }
    }
  } else {
    // beichi：以最后一笔与前一同向笔的 MACD 面积比判断
    const bis = ans.analysis.bis || [];
    const last = bis[bis.length - 1];
    const prevSame = bis.slice(0, -1).reverse().find((b) => b.dir === (last && last.dir));
    let isBeichi = false;
    if (last && prevSame) {
      const area = (b) => Math.abs((b.p1 - b.p0) * (b.i1 - b.i0));
      isBeichi = area(last) < area(prevSame) * 0.8 && Math.abs(last.p1 - last.p0) < Math.abs(prevSame.p1 - prevSame.p0) * 0.9;
    }
    const picked = answer === 'yes';
    score = picked === isBeichi ? 100 : 0;
    verdict = picked === isBeichi ? '判断正确' : '判断错了';
    explain.push(
      isBeichi
        ? '最后一笔的力度明显弱于前一同向笔（价格幅度与持续时间都缩小），符合背驰的直观特征。'
        : '最后一笔的力度没有明显衰减，按简化判据不算背驰（注意：严格背驰要比同级别两段，这里用的是简化判据）。'
    );
    if (prevSame && last) explain.push(`最后一笔：${last.p0.toFixed(2)} → ${last.p1.toFixed(2)}（${last.i1 - last.i0} 根）；前一同向笔：${prevSame.p0.toFixed(2)} → ${prevSame.p1.toFixed(2)}（${prevSame.i1 - prevSame.i0} 根）。`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const stars = score >= 90 ? 3 : score >= 70 ? 2 : score >= 45 ? 1 : 0;
  return {
    ok: true,
    no: Number(no),
    score,
    stars,
    verdict,
    explain,
    answer: {
      dir: ans.dir,
      ret: +(ans.ret * 100).toFixed(2),
      signal: ans.lastSignal ? { name: ans.lastSignal.name, barIdx: ans.lastSignal.barIdx, price: ans.lastSignal.price, type: ans.lastSignal.type } : null,
      pivot: ans.lastPivot ? { i0: ans.lastPivot.i0, i1: ans.lastPivot.i1, zd: ans.lastPivot.zd, zg: ans.lastPivot.zg } : null,
      cutoff: ans.cutoff
    },
    target: { market: att.market, code: att.code, name: kl.name || '' },
    revealedBars: revealed.slice(Math.max(0, ans.cutoff - 60)),
    revealedFrom: Math.max(0, ans.cutoff - 60),
    // 揭示段的结构（下标已平移到揭示窗口内），让玩家看到笔/中枢/买卖点是怎么落在这段走势里的
    revealedStructure: (() => {
      const from = Math.max(0, ans.cutoff - 60);
      const shift = (i) => i - from;
      const a2 = C.analyze(revealed, { period: 'day', market: plan.market, code: plan.code });
      return {
        bis: (a2.bis || []).filter((b) => b.i0 >= from).map((b) => ({ ...b, i0: shift(b.i0), i1: shift(b.i1) })),
        segments: (a2.segments || []).filter((sg) => sg.i0 >= from).map((sg) => ({ ...sg, i0: shift(sg.i0), i1: shift(sg.i1) })),
        pivots: (a2.pivots || []).filter((p) => p.i0 >= from).map((p) => ({ ...p, i0: shift(p.i0), i1: shift(p.i1) })),
        signals: (a2.signals || []).filter((sg) => sg.barIdx >= from).map((sg) => ({ ...sg, barIdx: shift(sg.barIdx) })),
        beichi: (a2.beichi || []).filter((b) => (b.i1 != null ? b.i1 >= from : true)).map((b) => ({ ...b, i1: b.i1 != null ? shift(b.i1) : b.i1 }))
      };
    })(),
    gist: level.gist || '',
    note: '关卡由实时行情生成；同一关刷新行情后题目会变，这是有意的（练的是结构识别，不是背答案）。'
  };
}

module.exports = { buildMap, makeLevel, gradeLevel, levelPlan, RANKS, POOL };

  });

  /* ---- chan-lessons (chan-lessons.js) ---- */
  define("chan-lessons", function (module, exports, require) {
'use strict';
/**
 * 《教你炒股票 108 课》课程索引 + 缠中说禅言论集（天涯/博客）
 *
 * 立场（重要）：
 *  - 这里只做**索引与摘要**，不收录原文；原文请参阅正式出版本。
 *  - `title` 仅在公开索引中可核对的课程才填写（约 40 余课）；其余留空，绝不编造标题。
 *  - `gist` 是本库的要点概括（归纳自公开的学习大纲与社区整理），不是逐字引用。
 *  - 14 个专题是学习路线分组（公开资料里的常见分法），**不是原文编排**。
 */

/* ------------------------------------------------------------------ */
/* 一、108 课索引                                                      */
/* ------------------------------------------------------------------ */

/** 专题（学习路线分组，非原文编排） */
const THEMES = [
  { id: 'guide', name: '导引与总纲', desc: '先把学习路线与「市场哲学的数学原理」的总纲立起来', lessons: [72] },
  { id: 'basics', name: '分型·笔·线段', desc: 'K 线包含处理、分型、笔、线段四件套，是全体系的原子层', lessons: [62, 65, 67, 69, 71, 77, 78, 81, 82] },
  { id: 'pivot', name: '中枢·走势类型', desc: '中枢的生灭、延伸扩展，走势类型的划分与级别', lessons: [18, 20, 21, 35, 63, 101, 102] },
  { id: 'signal', name: '三类买卖点', desc: '买卖点的完备性与实战分辨', lessons: [53, 56] },
  { id: 'beichi', name: '背驰·力度', desc: '趋势背驰、盘整背驰、转折的力度与级别，动力学的核心', lessons: [24, 25, 29, 37, 43, 44] },
  { id: 'multi', name: '多义性·同级别分解', desc: '走势的多义性、同级别分解、区间套与级别递增', lessons: [33, 39, 40, 41, 45, 49, 50] },
  { id: 'zhongyin', name: '中阴·转折', desc: '中阴状态的研判，转折与延伸的区分', lessons: [99] },
  { id: 'macro', name: '大盘·板块·轮动', desc: '大盘与板块强弱、轮动与三个独立程序', lessons: [46, 47, 48, 52, 54, 55, 59] },
  { id: 'money', name: '资金管理·仓位', desc: '资金管理与仓位分配，技术之外的第二条腿', lessons: [31, 36, 38, 57, 58] },
  { id: 'daily', name: '每日走势分类', desc: '把每天盘面拆成可分类的走势类型，而不是猜涨跌', lessons: [60, 61, 64, 68, 70, 73, 74, 75, 76] },
  { id: 'mind', name: '心态与执行', desc: '技术解决不了的人的问题：恐惧、贪婪、赌徒心理、当机立断', lessons: [19, 23, 34, 42, 80, 94, 95, 96, 105] },
  { id: 'art', name: '兵法·阅历', desc: '中医、兵法、诗歌与操作的关系，属于「功夫在诗外」', lessons: [28, 51, 66, 97, 98, 100] },
  { id: 'misc', name: '综合与答疑', desc: '各期答疑与补充说明', lessons: [79, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 103, 104, 106, 107, 108] },
  { id: 'early', name: '早期股市闲谈', desc: '108 课之前的早期随笔：心态、市场观与入门', lessons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 22, 26, 27, 30, 32] },
];

/** 可核对的课程标题（来自公开学习大纲/索引，未核实的一律留空） */
const TITLES = {
  1: '不会赢钱的经济人，只是废人',
  2: '没有庄家，有的只是赢家和输家',
  3: '你的喜好，你的死亡陷阱',
  4: '什么是理性？今早买 N 中工就是理性',
  5: '市场无须分析，只要看和干',
  18: '不被面首的雏男是不完美的（中枢的生与死）',
  19: '学习缠中说禅技术分析理论的关键',
  20: '缠中说禅走势中枢级别扩张及第三类买卖点',
  21: '缠中说禅买卖点分析的完备性',
  23: '市场与人生',
  24: 'MACD 对背驰的辅助判断',
  25: '吻、M 部',
  26: '市场风险如何回避',
  28: '下一目标 摧毁基金',
  29: '转折的力度与级别',
  31: '资金的管理方法',
  33: '走势的多义性',
  34: '宁当面首 莫成怨男',
  35: '给基础差的同学补补课',
  37: '背驰的再分辨',
  42: '有些人是不适合参与市场的',
  43: '有关背驰的补习课',
  44: '小级别背驰引发大级别转折',
  46: '怎样判读每天盘面的强弱',
  51: '短线股评荐股者的传销把戏',
  53: '三个买卖点的再分辨',
  56: '530 印花税当日行情图解',
  62: '分型、笔与线段',
  63: '替各位理理基本概念',
  65: '再说说分型、笔、线段',
  66: '主力资金的食物链',
  67: '线段的划分标准',
  69: '月线分段与上海大走势分析、预判',
  71: '线段划分标准的再分辨',
  72: '本 ID 已有课程的再梳理',
  77: '一些概念的再分辨（缺口、分型、笔、线段）',
  78: '继续说线段的划分',
  80: '市场没有同情、不信眼泪',
  81: '线段划分的精确度',
  82: '顶底分型的形成原因和研判',
  94: '当机立断',
  95: '修炼自己',
  96: '无处不在的赌徒心理',
  97: '中医、兵法、诗歌、操作 1',
  98: '中医、兵法、诗歌、操作 2',
  99: '中阴状态的研判和操作',
  100: '中医、兵法、诗歌、操作 3',
  101: '答疑 1（二买与走势必完美）',
  102: '再说走势必完美',
  105: '远离聪明、机械操作',
};

/** 有把握的逐课要点（其余仅给专题级说明） */
const GISTS = {
  18: '中枢如何生、如何死：出生由三笔重叠，死亡由离开后不再回来。',
  20: '中枢级别扩张与三买的因果关系：中枢扩张后照样可以出三买。',
  21: '买卖点为什么只有三类：由走势分解的完备性推出，不是经验总结。',
  24: '用 MACD 黄白线回拉 0 轴与红绿柱面积辅助判断背驰。',
  29: '转折的力度决定转折的级别：没有力度就没有真正的转折。',
  31: '资金管理与仓位：先活下来，才谈收益。',
  33: '走势的多义性：同一段走势可有多种合理划分，需固定级别与主划分。',
  37: '背驰的再分辨：同级别、同方向、两次比较，缺一不可。',
  43: '背驰补习：面积、黄白线、成交量三者互相验证。',
  44: '小级别背驰如何引发大级别转折（小转大）。',
  46: '每天盘面的强弱判断：看分类而不是猜方向。',
  53: '三类买卖点的再分辨，尤其二买与次级别一买的关系。',
  56: '突发事件（530 印花税）当天如何用走势分类应对。',
  62: '分型、笔与线段的定义连成一条链，是全部结构的地基。',
  63: '用比喻把「级别」讲清楚：级别是观察的放大倍数。',
  67: '线段划分标准：特征序列与两种破坏情形。',
  71: '线段划分再分辨：缺口与第二种情况的处理。',
  72: '把前面课程重新梳理成一条学习路线（懒人路线图）。',
  77: '缺口、分型、笔、线段几个易混概念的再分辨。',
  78: '继续说线段的划分：边界情形怎么定。',
  82: '顶底分型为什么会形成，以及如何研判其有效性。',
  99: '中阴状态：前一段已完、后一段未立的过渡期怎么操作。',
  101: '二买与走势必完美的答疑。',
  102: '走势必完美的三种含义与完全分类。',
};

const LESSONS = Array.from({ length: 108 }, (_, i) => {
  const no = i + 1;
  const theme = THEMES.find((t) => t.lessons.includes(no)) || THEMES[THEMES.length - 1];
  return {
    no,
    theme: theme.id,
    themeName: theme.name,
    title: TITLES[no] || null,
    gist: GISTS[no] || null,
    confirmed: !!TITLES[no],
  };
});

const COVERAGE = {
  total: 108,
  titles: Object.keys(TITLES).length,
  gists: Object.keys(GISTS).length,
  themes: THEMES.length,
  note:
    '课号为通行编排（1–108），标题仅收录公开索引中可核对者，其余留空；要点为本库概括。' +
    '原文请参阅正式出版本（见书目），本站不转载。',
};

/* ------------------------------------------------------------------ */
/* 二、言论集（天涯论坛 / 新浪博客）                                     */
/* ------------------------------------------------------------------ */

const LORE = [
  {
    era: '2005-2008',
    source: '天涯论坛',
    kind: '史料',
    text: '早期《教你炒股票》系列在天涯股市论坛连载时是**配图讲解中枢**的，后来博客与出版本才逐步体系化。',
    insight: '说明「缠论」不是一开始就完整的教科书，而是边写边建体系：先有中枢图示，再有分型/笔/线段的严格定义。',
    link: 'zhongshu',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: '在买点买、在卖点卖；买点不一定是某一个点，级别越大，可容忍的区间越大。',
    insight: '把「精确点位」换成「同级别的买卖点区间」，这是缠论与形态学的根本差别。',
    link: 'buy1',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '纪律',
    text: '在某级别买点买入，就在同级别卖点卖出。',
    insight: '级别错配是散户最常见的亏损来源；本站的「区间套」页面就是用来对齐级别的。',
    link: 'zoushi_jibie',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: '离开级别，无所谓趋势；没有趋势，没有背驰。',
    insight: '背驰必须同级别、同方向、两段比较；跨级别比较是本项目明确拒绝的做法。',
    link: 'beichi',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: 'MACD 定律：一类买点多在 0 轴之下背驰形成；二类买点是第一次上 0 轴后回抽确认。',
    insight: '本站一买=段背驰终点、二买=不破前低的回抽，与之对应，但用几何条件而非 MACD 单一指标。',
    link: 'buy2',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '心态',
    text: '不追高：等调整结束、启动时介入；均线向下发散时不要买。',
    insight: '本站不提供「追不追」的建议，只给结构位置（中枢上/下/内）让你自己判断。',
    link: 'zhongshu',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '心态',
    text: '买了就要随时监控卖点；股票是用来卖的。',
    insight: '这也是本站每个买点都附「失效条件 / 止损参考线」的原因。',
    link: 'zhisun_jiegou',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: '任何非盘整性的转折性上涨，多是某级别「下跌＋盘整＋下跌」之后形成的。',
    insight: '对应 a+A+b 结构与一买：先有两段下跌与中间中枢，才谈得上背驰转折。',
    link: 'a_A_b',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: '不做预测，做分类：把每天的走势分到已定义的类型里。',
    insight: '本站的走势类型判定（上涨/下跌/盘整）就是这一条的实现。',
    link: 'zoushi_leixing',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '纪律',
    text: '一般没必要看 1 分钟图，先看大级别。',
    insight: '本站默认日线、并把 1 分钟放在最后；级别越大，信号越稳、噪音越少。',
    link: 'zoushi_jibie',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '技法',
    text: '5 周线是中线生命线，5 日线是短线生命线。',
    insight: '均线是缠论的辅助而非核心；本站把它放在「成交量/均线辅助」概念卡里。',
    link: 'chengjiaoliang_fuzhu',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '技法',
    text: '一个日线级别的调整，必然在 30 分钟上有三段走势。',
    insight: '这就是级别递归：大级别的一段，在小级别上是一个完整走势。',
    link: 'zoushi_digui',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '心态',
    text: '市场没有同情，不信眼泪；不适合的人不必参与。',
    insight: '本站不做收益承诺、不做荐股，也是同一个立场。',
    link: 'chanlun_bianjie',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: '走势终完美：任何级别的走势类型，最终都会完成。',
    insight: '「终完美」不是预测，而是要求你等到结构走完再动手。',
    link: 'zoushi_wanmei',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '技法',
    text: '区间套：大级别定区间，小级别定买点。',
    insight: '本站的「区间套 · 多级别联立」页面就是按这个思路做的。',
    link: 'qujian_tao',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '心态',
    text: '不要为券商打工：频繁交易只会把利润交给手续费。',
    insight: '本站的雷达会标出「信号新鲜度」，提示你不要为了交易而交易。',
    link: 'buy1_sanzhong',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '方法论',
    text: '中阴阶段最难做：前一段已完、后一段未立。',
    insight: '本站把它做成「中阴阶段」概念卡，并在结构页标注中枢延伸。',
    link: 'zhongyin',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '技法',
    text: '三买的意义：中枢被有效突破后，回抽不回到中枢。',
    insight: '本站三买严格取「回抽低点 > ZG」，并把 ZG 线画在图上给你核对。',
    link: 'buy3',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '心态',
    text: '当机立断、修炼自己、机械操作——技术之外的那一半。',
    insight: '本站把「纪律」写进页脚与免责声明，而不是给你一个「稳赚」的按钮。',
    link: 'chanlun_bianjie',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '史料',
    text: '缠中说禅博客总共约 1134 篇文章，内容远超 108 课。',
    insight: '所以「108 课」是筛选后的技术主线，不是全部；本站只围绕技术主线建库。',
    link: 'zoushi_leixing',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '技法',
    text: '盘整背驰与趋势背驰要分开：前者只做一段，后者才谈反转。',
    insight: '本站的背驰检测同时标注「段背驰/笔背驰」，并在概念卡里讲清区别。',
    link: 'panzheng_beichi',
  },
  {
    era: '2005-2008',
    source: '新浪博客',
    kind: '纪律',
    text: '在做的级别上不出现买卖点就不动手。',
    insight: '本站雷达的「近期无信号」不是坏事，它就是在告诉你别动。',
    link: 'buy1',
  },
];

const LORE_META = {
  count: LORE.length,
  note:
    '本集为**社区整理与转述**：来源标注为天涯论坛/新浪博客，但未做逐字校对，' +
    '凡带引号感强的表述均为要点转述，不是原文引用。原文请查阅出版本或原始博客存档。',
  disclaimer: '这些言论是理解缠论思路的辅助材料，不是交易信号。',
};

module.exports = { THEMES, LESSONS, TITLES, GISTS, COVERAGE, LORE, LORE_META };

  });

  /* ---- metaphysics (metaphysics.js) ---- */
  define("metaphysics", function (module, exports, require) {
'use strict';
/**
 * 命理知识库（天干地支 / 紫微斗数 / 奇门遁甲 / 梅花易数 / 六爻纳甲）
 *
 * 这里放的是**结构化知识**：每套体系的原理、本站的取数规则、对应的代码与接口、
 * 常见误解，以及可供索引的书目。它不是命理结论库，目的是让"我们怎么算的"可被核对。
 */

const SYSTEMS = [
  {
    id: 'ganzhi',
    name: '天干地支 · 四柱',
    school: '历法',
    oneLine: '把时间编码成 60 甲子，是一切东方术数的共同底座。',
    principle:
      '十天干（甲乙丙丁戊己庚辛壬癸）与十二地支（子丑寅卯辰巳午未申酉戌亥）两两相配成 60 甲子，' +
      '用于纪年、月、日、时。四柱即把某一时刻拆成「年柱·月柱·日柱·时柱」四组干支。' +
      '换年的界是立春，换月的界是节（不是中气），换日按北京时间 00:00，换时按两小时一个时辰。',
    rules: [
      '年柱：以立春为界（立春前仍算上一年）',
      '月柱：以「节」为界，月干由年干五虎遁推出（甲己之年丙作首）',
      '日柱：由儒略日推算，锚点 2000-01-01 为戊午日、1949-10-01 为甲子日',
      '时柱：五鼠遁（甲己还加甲），子时 23:00 起',
      '节气：用太阳视黄经反解，误差约分钟级',
    ],
    howTo: [
      '在「算卦择时」页顶部能看到当前四柱与建除值日',
      '「数据源」页可以看到节气时间是否正常',
      '四柱会同时进入梅花、六爻、紫微的取数，所以它是先决条件',
    ],
    code: { module: 'server/lib/ganzhi.js', api: '/api/daily', tests: 'test/ganzhi.test.js' },
    pitfalls: [
      '把农历月当节气月：月柱换的是「节」，不是初一换月',
      '忽略时区：本站统一按北京时间切日、切时辰',
      '以为四柱能直接预测涨跌：它只是时间编码，没有统计证据表明可预测价格',
    ],
  },
  {
    id: 'ziwei',
    name: '紫微斗数 · 流日盘',
    school: '星曜',
    oneLine: '以农历生日起命盘，用十二宫与十四主星描述一张盘的结构。',
    principle:
      '紫微斗数以农历的年、月、日、时排出十二宫与星曜：先以「寅起正月顺数至生月，再逆数生时」定命宫，' +
      '五虎遁定宫干，纳音定五行局，再用「起紫微星诀」安紫微、天府，其余主星按紫微系逆布、天府系顺布。' +
      '四化（化禄、化权、化科、化忌）按年干起。',
    rules: [
      '命宫 = 寅起正月顺数至生月，再逆数生时；身宫顺数生时',
      '五行局：纳音巧记（干数＋支数过五减五）→ 水二/木三/金四/土五/火六局',
      '起紫微星诀：局数除日数，商数宫前走，奇偶定进退',
      '四化：南派口诀（甲廉破武阳、乙机梁紫阴……）',
      '本站用「当日农历」排一张流日盘，取命宫主星与四化打分',
    ],
    howTo: [
      '算卦页 → 择时方法实验室 → 勾选「紫微斗数」，下方会显示十二宫盘',
      '看命宫（高亮格）里有哪些主星、有没有化禄/化忌',
      '把盘面与「综合分」对照看，而不是只看单宫吉凶',
    ],
    code: { module: 'server/lib/ziwei.js', api: '/api/timing?methods=ziwei', tests: 'test/lunar-ziwei-qimen.test.js' },
    pitfalls: [
      '不同流派的安星与四化表不同（南派/中州派），跨软件比对常常对不上',
      '闰月如何算「生月」各派有分歧，本站直接用农历月序，不做置闰调整',
      '紫微斗数描述的是「盘的结构」，不是价格方向；本站只把它当 0-100 分之一票',
    ],
  },
  {
    id: 'qimen',
    name: '奇门遁甲 · 时家',
    school: '历法·九宫',
    oneLine: '以节气定阴阳遁与局数，把九宫排成一张「时空盘」。',
    principle:
      '奇门遁甲把时间映射到九宫：冬至后为阳遁、夏至后为阴遁；每个节气配三元（上/中/下元），' +
      '由日干支的符头（甲或己）地支决定用哪一元，从而定局数（1-9）。地盘按局数排三奇六仪，' +
      '天盘九星随值符、人盘八门随值使飞布，八神自值符宫起。',
    rules: [
      '阴阳遁：冬至 → 夏至 阳遁；夏至 → 冬至 阴遁',
      '三元：符头地支子午卯酉上元、寅申巳亥中元、辰戌丑未下元',
      '地盘：戊己庚辛壬癸丁丙乙，阳遁顺布、阴遁逆布，起于局数宫',
      '值符/值使：时干支所在旬的旬首所遁之仪，其宫之星为值符、之门为值使',
      '中宫不排门神，天禽寄坤二宫',
    ],
    howTo: [
      '算卦页 → 勾选「奇门遁甲」，下方显示三乘三九宫盘',
      '先看标题的「阴遁/阳遁 + 局数」，再看时干所临之宫（高亮）的门、星、神',
      '把「值符/值使」当作当日主线的象征，不要单独用某一门下结论',
    ],
    code: { module: 'server/lib/qimen.js', api: '/api/timing?methods=qimen', tests: 'test/lunar-ziwei-qimen.test.js' },
    pitfalls: [
      '拆补法、置闰法、茅山道派等差异很大，同一时刻不同软件局数可能不同',
      '中宫寄宫有两套流派（寄坤/寄艮），本站取寄坤',
      '九宫吉凶不是涨跌预测；本站只用它做「盘面感」的结构分',
    ],
  },
  {
    id: 'meihua',
    name: '梅花易数',
    school: '卦象',
    oneLine: '以数起卦，用体用生克判断一件事的顺逆。',
    principle:
      '梅花易数把时间、数字、方位等转换成八卦，上卦、下卦成六十四卦，再取动爻，' +
      '由本卦、互卦、变卦与体用生克关系判断吉凶。它的优点是快、可自定义取数，' +
      '缺点是取数随意性大，难以横向比较。',
    rules: [
      '本站取数：四柱支序 + 标的哈希 + 现价分桶 + 占次 → 摇卦数，再取模定上卦、下卦、动爻',
      '体用：动爻所在的卦为用，另一卦为体；体克用/用生体偏顺，用克体/体生用偏逆',
      '互卦取二三四爻为下、三四五爻为上；变卦为动爻阴阳互变',
    ],
    howTo: [
      '算卦页默认就是梅花起卦，能看到本卦、互卦、变卦与体用关系',
      '同标的点「起卦」占次 +1，必得新卦；「时辰模式」则同一时辰内固定一卦',
      '看「取数依据」核对每个输入，结果可复现',
    ],
    code: { module: 'server/lib/divination.js', api: '/api/divination', tests: 'test/divination.test.js' },
    pitfalls: [
      '同一个问题反复起卦（传统上不建议），本站用占次明示这一点',
      '把体用生克当成概率：它没有频率含义',
      '不同取数方法会得到不同卦，跨方法比对没有意义',
    ],
  },
  {
    id: 'liuyao',
    name: '六爻纳甲',
    school: '卦象',
    oneLine: '给卦装上六亲、世应、六神，用动爻判断事情的着力点。',
    principle:
      '六爻在梅花的基础上进一步「纳甲」：按八宫确定卦宫五行，按纳甲给每爻配地支，' +
      '再以宫五行与爻五行的生克定六亲（父母、兄弟、子孙、妻财、官鬼），配合世应、六神、旬空与动爻判断。',
    rules: [
      '宫：按京房八宫定，宫五行决定六亲',
      '纳甲：乾纳甲壬、坎纳戊、艮纳丙、震纳庚、巽纳辛、离纳己、坤纳乙癸、兑纳丁',
      '六亲：生我父母、我生子孙、克我官鬼、我克妻财、同我兄弟',
      '六神：按日干起（甲乙青龙、丙丁朱雀、戊勾陈、己螣蛇、庚辛白虎、壬癸玄武）',
      '旬空：按日干支所在旬，空亡两支在盘中标注',
    ],
    howTo: [
      '算卦页下方「六爻排盘」看六亲、世应、六神与空亡',
      '重点看动爻的六亲：财动主盈亏、官鬼动主压力、子孙动主助力',
      '配合「世应」看内外：应生世为外部配合，世生应为自身耗力',
    ],
    code: { module: 'server/lib/divination.js', api: '/api/divination', tests: 'test/divination.test.js' },
    pitfalls: [
      '把六亲当行业标签：六亲是关系，不是板块',
      '忽略旬空：动爻逢空信号容易落空',
      '用六爻直接给买卖点：本站只把它作为一票',
    ],
  },
];

const BOOKS = [
  {
    title: '缠中说禅：教你炒股票 108 课（完全解读版）',
    domain: '缠论',
    era: '2005–2008 连载 / 2021 出版',
    attributed: '缠中说禅（李彪）原著；禅世雕龙 解读',
    note: '108 课原文的解读本，780 页；本书目仅作索引，本站不转载原文。',
    module: 'theory',
  },
  {
    title: '缠中说禅教你炒股票大全集（6 册）',
    domain: '缠论',
    era: '2020',
    attributed: '培峰 编著',
    note: '108 课原文 + 解盘答问 + K 线技术 + 实战应用 + 陷阱论与交易心理。',
    module: 'theory',
  },
  {
    title: '缠论缠中说禅李彪原著文集',
    domain: '缠论',
    era: '2023',
    attributed: '缠中说禅',
    note: '含《论语》详解与 108 课原文，适合作原文对照。',
    module: 'theory',
  },
  {
    title: '渊海子平',
    domain: '干支',
    era: '宋',
    attributed: '徐升（据徐子平说）',
    note: '子平八字的奠基之作，四柱生克格局的源头。',
    module: 'ganzhi',
  },
  {
    title: '三命通会',
    domain: '干支',
    era: '明',
    attributed: '万民英',
    note: '命理百科式汇编，干支神煞与格局的集大成。',
    module: 'ganzhi',
  },
  {
    title: '滴天髓',
    domain: '干支',
    era: '传宋·京图撰，明清注本流行',
    attributed: '传 京图；刘基（刘伯温）注本流传最广',
    note: '以「气」论命，讲旺衰与调候，注本比原文更常被引用。',
    module: 'ganzhi',
  },
  {
    title: '紫微斗数全书',
    domain: '紫微',
    era: '明代刊本',
    attributed: '托名 陈抟（希夷先生）',
    note: '紫微斗数最常被引用的古籍底本之一，含安星与格局。',
    module: 'ziwei',
  },
  {
    title: '十八飞星策天紫微斗数全集',
    domain: '紫微',
    era: '明清',
    attributed: '佚名（坊刻本）',
    note: '另一路紫微流派底本，安星与四化与全书派略有差异。',
    module: 'ziwei',
  },
  {
    title: '紫微斗数讲义（中州派）',
    domain: '紫微',
    era: '现代',
    attributed: '王亭之',
    note: '现代中州派体系化讲义，四化与星情讲解清晰。',
    module: 'ziwei',
  },
  {
    title: '烟波钓叟歌',
    domain: '奇门',
    era: '传宋',
    attributed: '传 赵普',
    note: '奇门遁甲最著名的歌诀，讲阴阳遁、局数与九宫布法。',
    module: 'qimen',
  },
  {
    title: '奇门遁甲统宗',
    domain: '奇门',
    era: '明清辑本',
    attributed: '旧题 明·程道生 等（版本复杂）',
    note: '奇门体系汇编，拆补/置闰等排法分歧的重要来源。',
    module: 'qimen',
  },
  {
    title: '梅花易数',
    domain: '卦象',
    era: '传宋',
    attributed: '托名 邵雍',
    note: '以数起卦、体用生克的经典，本站梅花取数的源头。',
    module: 'meihua',
  },
  {
    title: '增删卜易',
    domain: '六爻',
    era: '清',
    attributed: '野鹤老人（李文辉）',
    note: '六爻最实用的临床式著作，重实例、重取舍。',
    module: 'liuyao',
  },
  {
    title: '卜筮正宗',
    domain: '六爻',
    era: '清',
    attributed: '王洪绪',
    note: '六爻体系的规范化之作，六亲世应与用神取舍讲得最细。',
    module: 'liuyao',
  },
];

const CORPUS = {
  systems: SYSTEMS.length,
  books: BOOKS.length,
  modules: ['ganzhi', 'ziwei', 'qimen', 'meihua', 'liuyao'],
  note: '书目仅作阅读索引与出处标注；所有排盘算法均为本站自实现，代码可核对。',
  disclaimer: '命理与术数属传统文化，没有统计证据表明可稳定预测价格；本站把它们做成可回测的评分输入，而不是结论。',
};

function list() {
  return { systems: SYSTEMS, books: BOOKS, corpus: CORPUS };
}

function get(id) {
  const sys = SYSTEMS.find((s) => s.id === id);
  if (!sys) return null;
  return { ...sys, books: BOOKS.filter((b) => b.module === id) };
}

module.exports = { SYSTEMS, BOOKS, CORPUS, list, get };

  });

  /* ---- sources (sources-browser.js) ---- */
  define("sources", function (module, exports, require) {
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

  });

  /* ---- crypto (crypto-shim.js) ---- */
  define("crypto", function (module, exports, require) {
'use strict';
/**
 * 浏览器端 crypto 垫片：只实现 server/lib/game.js 用到的同步接口。
 * createHash('sha1') / createHmac('sha256', key) / randomBytes(n).toString('hex') / randomUUID()
 */

function utf8(s) {
  return new TextEncoder().encode(String(s));
}

function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function sha1Bytes(msgBytes) {
  const ml = msgBytes.length;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  const withPad = new Uint8Array((((ml + 9) + 63) >> 6) << 6);
  withPad.set(msgBytes);
  withPad[ml] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLenHi);
  dv.setUint32(withPad.length - 4, bitLenLo);

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3); odv.setUint32(16, h4);
  return out;
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Bytes(msgBytes) {
  const ml = msgBytes.length;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  const withPad = new Uint8Array((((ml + 9) + 63) >> 6) << 6);
  withPad.set(msgBytes);
  withPad[ml] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLenHi);
  dv.setUint32(withPad.length - 4, bitLenLo);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

function hashFactory(alg, data) {
  const bytes = alg === 'sha1' ? sha1Bytes(data) : sha256Bytes(data);
  return {
    update(s) { return hashFactory(alg, utf8(s)); },
    digest(enc) { return enc === 'hex' ? hex(bytes) : bytes; },
  };
}

class Hash {
  constructor(alg) { this.alg = alg; this.buf = ''; }
  update(s) { this.buf += String(s); return this; }
  digest(enc) { return hashFactory(this.alg, utf8(this.buf)).digest(enc); }
}

class Hmac {
  constructor(alg, key) { this.alg = alg; this.key = utf8(key); this.buf = ''; }
  update(s) { this.buf += String(s); return this; }
  digest(enc) {
    const block = 64;
    let key = this.key;
    if (key.length > block) key = this.alg === 'sha1' ? sha1Bytes(key) : sha256Bytes(key);
    const ipad = new Uint8Array(block);
    const opad = new Uint8Array(block);
    for (let i = 0; i < block; i++) { ipad[i] = (key[i] || 0) ^ 0x36; opad[i] = (key[i] || 0) ^ 0x5c; }
    const inner = utf8(this.buf);
    const msg1 = new Uint8Array(block + inner.length);
    msg1.set(ipad); msg1.set(inner, block);
    const innerHash = this.alg === 'sha1' ? sha1Bytes(msg1) : sha256Bytes(msg1);
    const msg2 = new Uint8Array(block + innerHash.length);
    msg2.set(opad); msg2.set(innerHash, block);
    const out = this.alg === 'sha1' ? sha1Bytes(msg2) : sha256Bytes(msg2);
    return enc === 'hex' ? hex(out) : out;
  }
}

module.exports = {
  createHash: (alg) => new Hash(alg),
  createHmac: (alg, key) => new Hmac(alg, key),
  randomBytes: (n) => {
    const b = new Uint8Array(n);
    (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(b) : b.forEach((_, i) => (b[i] = (Math.random() * 256) | 0));
    return { toString: () => hex(b) };
  },
  randomUUID: () =>
    (globalThis.crypto && globalThis.crypto.randomUUID)
      ? globalThis.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        }),
};

  });

})();
