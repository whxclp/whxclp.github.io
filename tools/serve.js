'use strict';
/* 仅用于本地预览静态版：node tools/serve.js [port] */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'docs');
const PORT = Number(process.argv[2] || 8932);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let file = decodeURIComponent(u.pathname);
    if (file.endsWith('/')) file += 'index.html';
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(full, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + file);
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log('static preview: http://127.0.0.1:' + PORT));
