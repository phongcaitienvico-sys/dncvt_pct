/**
 * Gắn số phiên bản (?v=...) vào mọi <script src> / <link href> nội bộ trong docs/*.html
 * để trình duyệt lấy ngay bản mới sau mỗi lần phát hành (GitHub Pages cho lưu đệm tới 10 phút).
 *   npm run stamp     (chạy trước khi commit/đẩy)
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'docs');
const v = Date.now().toString(36);
let n = 0;
fs.readdirSync(dir).filter((f) => f.endsWith('.html')).forEach((f) => {
  const p = path.join(dir, f);
  const s = fs.readFileSync(p, 'utf8');
  const out = s.replace(/((?:src|href)="(?:js|css)\/[\w.\-]+\.(?:js|css))(?:\?v=[\w]+)?"/g, (m, a) => { n++; return `${a}?v=${v}"`; });
  if (out !== s) fs.writeFileSync(p, out);
});
console.log('Đã gắn phiên bản ' + v + ' vào ' + n + ' liên kết.');
