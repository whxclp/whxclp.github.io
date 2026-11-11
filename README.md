# Chan Station · 静态托管版

缠论工作站的 **纯静态部署副本**，发布于 GitHub Pages，手机/任何设备随时可打开。

- 站点入口：https://whxclp.github.io/
- 示例：https://whxclp.github.io/?m=A&c=600519&p=day#structure
- 手机版：https://whxclp.github.io/m/

## 与原版的区别

原版依赖本地 Node 服务（`server/index.js`，端口 8931）实时抓取行情。GitHub Pages 只托管静态文件，
因此本副本在浏览器内实现了一个 `/api/*` 兼容层：

- `docs/js/static/chan-core.js`：由 `server/lib` 中的缠论/择时/六爻等纯 JS 模块打包而成；
- `docs/js/static/api-shim.js`：拦截 `/api/*`，用浏览器直接请求允许跨域的公开行情接口，并在本地完成缠论计算；
- 自选池、观察池、手绘线保存在浏览器 `localStorage`；
- 前端页面、URL 参数（`?m=A&c=600519&p=day#theory`）与交互保持不变。

## 行情来源与限制

| 市场 | 数据源 | 说明 |
| --- | --- | --- |
| A 股 | 腾讯 `qt.gtimg.cn` / `ifzq.gtimg.cn` | 报价、日/周/月/分钟线均可用 |
| 港股 | 腾讯 | 可用 |
| 美股 | 东财 `push2his.eastmoney.com` | 可用 |
| 加密 | 币安 `data-api.binance.vision` | 中国大陆网络通常不可达 |
| 美期货 | 东财 | 可用 |
| 国内期货 | — | 暂无允许跨域的公开数据源，静态版不支持 |

另外：新浪、纳斯达克官方接口不带 CORS 头，浏览器直连会被拦截，因此不再作为数据源；
批量扫描（雷达）时非 A 股标的可能因对方限频偶发失败。

## 本地预览

```bash
node tools/serve.js 8932
# 打开 http://127.0.0.1:8932/
```

重新生成浏览器端模块包：

```bash
node tools/build-bundle.js
```

## 说明

本项目仅作个人自用的静态镜像，原始项目版权归其作者所有。
