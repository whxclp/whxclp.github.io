/* 观察池：用户个人观察名单，独立于程序自带自选池（雷达扫描用），互不影响 */
(function () {
  const MK_ORDER = ['A', 'HK', 'US', 'CR', 'CNF', 'USF'];

  function key(m, c) {
    return m + ':' + c;
  }

  async function quoteMap(list) {
    const items = [];
    for (const m of MK_ORDER) for (const it of list[m] || []) items.push(key(m, it.code));
    if (!items.length) return {};
    try {
      const r = await API.get('/api/quote', { list: items.join(',') });
      const map = {};
      (r.quotes || []).forEach((q) => {
        if (q && q.market && q.code) map[key(q.market, q.code)] = q;
      });
      return map;
    } catch (e) {
      return {};
    }
  }

  function rowHtml(m, it, q) {
    const priceNum = q && q.price != null && Number(q.price) > 0 ? Number(q.price) : null;
    const price = priceNum != null ? priceNum : '—';
    const pct = q && q.pct != null ? q.pct : null;
    const cls = pct > 0 ? 'up-c' : pct < 0 ? 'down-c' : '';
    const pctTxt = pct != null ? (pct > 0 ? '+' : '') + Number(pct).toFixed(2) + '%' : '';
    const cost = it.cost != null && isFinite(it.cost) ? Number(it.cost) : null;
    let pnlTxt = '';
    let pnlCls = '';
    if (cost != null && priceNum != null) {
      const p = ((priceNum - cost) / cost) * 100;
      pnlTxt = (p > 0 ? '+' : '') + p.toFixed(2) + '%';
      pnlCls = p > 0 ? 'up-c' : p < 0 ? 'down-c' : '';
    }
    const chg = q && q.change != null ? Number(q.change) : null;
    const chgTxt = chg != null ? (chg > 0 ? '+' : '') + chg.toFixed(2) : '';
    const chgCls = chg > 0 ? 'up-c' : chg < 0 ? 'down-c' : '';
    const vol = q && q.volume != null && Number(q.volume) > 0 ? Number(q.volume) : null;
    const volTxt = vol != null ? (vol >= 10000 ? (vol / 10000).toFixed(1) + '万手' : vol + '手') : '';
    return `<div class="pool-row" data-m="${m}" data-c="${U.esc(it.code)}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.18);cursor:pointer">
      <span class="mk" style="display:inline-block;min-width:44px;text-align:center">${U.esc(U.MK[m] || m)}</span>
      <span style="width:170px;min-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${U.esc(it.name)}">${U.esc(it.name)}</span>
      <span class="hint" style="min-width:56px">${U.esc(it.code)}</span>
      <b class="${cls}" style="min-width:70px;text-align:right">${price}</b>
      <span class="${chgCls}" style="min-width:56px;text-align:right" title="当天涨跌额">${chgTxt}</span>
      <span class="${cls}" style="min-width:62px;text-align:right">${pctTxt}</span>
      <span class="hint" style="min-width:70px;text-align:right" title="当天成交量">${volTxt}</span>
      <input class="pool-cost" data-m="${m}" data-c="${U.esc(it.code)}" type="number" step="any" min="0" placeholder="成本" value="${cost != null ? cost : ''}" title="点击填入你的成本价，回车或移开保存；清空则移除" style="width:78px;text-align:right">
      <span class="${pnlCls}" style="min-width:62px;text-align:right">${pnlTxt}</span>
      <button class="btn ghost sm pool-del" data-m="${m}" data-c="${U.esc(it.code)}" title="移出观察池">删</button>
    </div>`;
  }

  async function render() {
    const body = U.$('#poolBody');
    if (!body) return;
    const { list } = await API.pool();
    const quotes = await quoteMap(list);
    const total = MK_ORDER.reduce((n, m) => n + (list[m] || []).length, 0);
    const mkOpts = MK_ORDER.map((m) => `<option value="${m}">${U.esc(U.MK[m] || m)}</option>`).join('');

    let html = `<div style="display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid rgba(128,128,128,.18);flex-wrap:wrap">
      <select id="poolMarket" class="btn sm" style="padding:6px 10px">${mkOpts}</select>
      <div class="search-wrap" style="flex:1;min-width:200px">
        <input id="poolInput" placeholder="输入名称/代码搜索后点选，或精确代码直接添加" autocomplete="off" style="width:100%">
        <div class="search-pop" id="poolPop"></div>
      </div>
      <button class="btn sm" id="poolAddBtn">＋ 添加</button>
      <span class="hint">${total} 只 · 与程序自选池互不影响</span>
    </div>`;

    if (!total) {
      html += '<div class="hint" style="padding:28px 12px;text-align:center">观察池还是空的 —— 在上方搜索并添加你的第一批标的</div>';
    } else {
      html += `<div class="hint" style="display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.18)">
        <span class="mk" style="display:inline-block;min-width:44px;text-align:center;visibility:hidden">市场</span>
        <span style="width:170px;min-width:170px">名称</span>
        <span style="min-width:56px">代码</span>
        <span style="min-width:70px;text-align:right">现价</span>
        <span style="min-width:56px;text-align:right">涨跌额</span>
        <span style="min-width:62px;text-align:right">涨幅</span>
        <span style="min-width:70px;text-align:right">成交量</span>
        <span style="width:78px;text-align:right">成本</span>
        <span style="min-width:62px;text-align:right">持仓盈亏</span>
        <span style="min-width:30px"></span>
      </div>`;
      for (const m of MK_ORDER) {
        const arr = list[m] || [];
        if (!arr.length) continue;
        html += `<div class="hint" style="padding:10px 12px 4px">${U.esc(U.MK[m] || m)} · ${arr.length}</div>`;
        html += arr.map((it) => rowHtml(m, it, quotes[key(m, it.code)])).join('');
      }
    }
    body.innerHTML = html;
    bind();
  }

  function bind() {
    const body = U.$('#poolBody');
    const input = U.$('#poolInput');
    const pop = U.$('#poolPop');
    const mkSel = U.$('#poolMarket');
    const addBtn = U.$('#poolAddBtn');

    U.$$('.pool-row', body).forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.pool-del') || e.target.closest('.pool-cost')) return;
        App.openStructure(el.dataset.m, el.dataset.c, 'day');
      });
    });
    U.$$('.pool-cost', body).forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') inp.blur();
      });
      inp.addEventListener('change', async () => {
        const v = inp.value.trim();
        try {
          await API.poolCost({ market: inp.dataset.m, code: inp.dataset.c, cost: v === '' ? '' : Number(v) });
          U.toast(v === '' ? '已清除成本价' : '已保存成本价：' + v);
          render();
        } catch (e) {
          U.toast('保存失败：' + e.message);
          render();
        }
      });
    });
    U.$$('.pool-del', body).forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await API.poolDel({ market: btn.dataset.m, code: btn.dataset.c });
          U.toast('已移出观察池');
          render();
        } catch (e) {
          U.toast('删除失败：' + e.message);
        }
      })
    );

    async function addExact() {
      const code = input.value.trim();
      if (!code) {
        U.toast('请先输入代码');
        return;
      }
      try {
        const r = await API.poolAdd({ market: mkSel.value, code });
        U.toast('已加入观察池：' + (r.added ? r.added.name : code));
        input.value = '';
        render();
      } catch (e) {
        U.toast('添加失败：' + e.message);
      }
    }
    if (addBtn) addBtn.addEventListener('click', addExact);

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const first = pop.querySelector('.search-item[data-m]');
          if (first) first.click();
          else addExact();
        }
        if (e.key === 'Escape') pop.classList.remove('show');
      });
      input.addEventListener(
        'input',
        U.debounce(async () => {
          const q = input.value.trim();
          if (!q) {
            pop.classList.remove('show');
            return;
          }
          try {
            const res = await API.search(q);
            pop.innerHTML = res.items.length
              ? res.items
                  .map(
                    (it) =>
                      `<div class="search-item pool-pick" data-m="${it.market}" data-c="${U.esc(it.code)}" data-n="${U.esc(it.name)}"><span class="mk">${U.esc(U.MK[it.market] || it.market)}</span><span>${U.esc(it.name)}</span><span class="cd">${U.esc(it.code)}</span></div>`
                  )
                  .join('')
              : '<div class="search-item">没有匹配结果</div>';
            pop.classList.add('show');
            U.$$('.pool-pick', pop).forEach((el) =>
              el.addEventListener('click', async () => {
                pop.classList.remove('show');
                try {
                  const r = await API.poolAdd({ market: el.dataset.m, code: el.dataset.c, name: el.dataset.n });
                  U.toast('已加入观察池：' + (r.added ? r.added.name : el.dataset.n));
                  input.value = '';
                  render();
                } catch (e) {
                  U.toast('添加失败：' + e.message);
                }
              })
            );
          } catch (e) {
            pop.innerHTML = '<div class="search-item">搜索失败</div>';
            pop.classList.add('show');
          }
        }, 260)
      );
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#poolBody .search-wrap')) pop.classList.remove('show');
      });
    }
  }

  window.PagePool = { render };
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'poolRefresh') render();
  });
})();
