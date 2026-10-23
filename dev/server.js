/**
 * Dev server: phục vụ giao diện trong docs/ và giả lập Web App Apps Script tại POST /api.
 *   npm run dev            → http://localhost:8787
 *   PORT=9000 DEV_LATENCY=800 npm run dev   (giả lập độ trễ Apps Script, ms)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBackend } = require('./gas');

const PORT = Number(process.env.PORT || 8787);
const LATENCY = Number(process.env.DEV_LATENCY || 0);
const ROOT = path.join(__dirname, '..', 'docs');
const DATA_FILE = path.join(__dirname, 'data', 'db.json');

const firstRun = !fs.existsSync(DATA_FILE);
const backend = createBackend(DATA_FILE);
const setup = backend.setup();
if (setup.adminPassword) {
  const credFile = path.join(__dirname, 'data', 'DEV_CREDENTIALS.txt');
  fs.writeFileSync(credFile, 'admin / ' + setup.adminPassword + '\n');
  console.log('Đã tạo DB dev mới. Tài khoản quản trị ghi trong ' + credFile);
} else if (firstRun) {
  console.log('Đã tạo DB dev mới.');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => setTimeout(() => {
      const out = backend.handle(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    }, LATENCY));
    return;
  }
  if (req.method === 'POST' && req.url === '/__snapshot') {
    // Chỉ dùng khi dev: lưu HTML trang in đã dựng để kiểm tra PDF bằng trình duyệt headless
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fs.writeFileSync(path.join(__dirname, 'data', 'snapshot.html'), body);
      res.writeHead(204); res.end();
    });
    return;
  }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(ROOT, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Dev server: http://localhost:' + PORT));
