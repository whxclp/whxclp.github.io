/* 白屏兜底：8 秒内 mobile.js 没把 __mBooted 置位，就弹一个可见的修复面板
   —— 独立版（添加到主屏幕）没有地址栏，白屏时用户无从下手，这里给按钮。
   放在独立文件里，避免内联脚本的编码/解析问题。 */
(function () {
  var shown = false;
  function show() {
    if (window.__mBooted || shown) return;
    var g = document.getElementById('bootGuard');
    if (!g) return;
    shown = true;
    g.style.display = 'block';
    var info = document.getElementById('bgInfo');
    if (info) {
      info.textContent = '地址 ' + location.href + ' · 版本 ' + (window.__ASSET_V__ || '未加载到 js');
    }
  }
  setTimeout(show, 8000);
  window.addEventListener('error', function () { setTimeout(show, 300); });

  var fix = document.getElementById('bgFix');
  if (fix) {
    fix.addEventListener('click', function () {
      var b = fix;
      b.disabled = true;
      b.textContent = '正在清理…';
      var done = false;
      function go() {
        if (done) return;
        done = true;
        location.replace('/m/?fresh=' + Date.now());
      }
      try {
        if (window.caches && window.caches.keys) {
          caches.keys().then(function (ks) {
            return Promise.all(ks.map(function (k) { return caches.delete(k); }));
          }).catch(function () {});
        }
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          navigator.serviceWorker.getRegistrations().then(function (rs) {
            return Promise.all(rs.map(function (r) { return r.unregister(); }));
          }).catch(function () {});
        }
        try { localStorage.removeItem('chan-m-pooltab'); } catch (e) {}
      } catch (e) {}
      setTimeout(go, 1200);
    });
  }

  var rl = document.getElementById('bgReload');
  if (rl) rl.addEventListener('click', function () { location.reload(); });
})();
