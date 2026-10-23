/**
 * Gộp apps-script/*.js thành dist/Code.gs (1 file) để dán vào trình soạn Apps Script.
 *   npm run bundle
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'apps-script');
const out = path.join(__dirname, '..', 'dist');
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith('.js')).sort();
const header = '// Đề nghị cấp vật tư — backend Apps Script. FILE SINH TỰ ĐỘNG bằng `npm run bundle`,\n' +
  '// đừng sửa ở đây: sửa trong apps-script/*.js rồi bundle lại.\n// Gồm: ' + files.join(', ') + '\n';
const body = files.map((f) => `\n// ===== ${f} =====\n` + fs.readFileSync(path.join(src, f), 'utf8')).join('');
fs.writeFileSync(path.join(out, 'Code.gs'), header + body);
fs.copyFileSync(path.join(src, 'appsscript.json'), path.join(out, 'appsscript.json'));
console.log('Đã tạo dist/Code.gs (' + files.length + ' file) và dist/appsscript.json');
