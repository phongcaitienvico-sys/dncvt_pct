/** Browser regression check with synthetic data only.
 * Requires Playwright, pdf-lib and Chrome: node tools/layout_check.js
 * Screenshots and PDF samples are written to ignored out/layout-check/.
 */
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '../docs');
const out = path.resolve(__dirname, '../out/layout-check');
fs.mkdirSync(out, { recursive: true });
const user = { username: 'layout-test', full_name: 'Kiểm tra giao diện', role: 'admin' };
const longName = 'Phụ kiện máy mài, bulong M16x100 và bộ dụng cụ sửa chữa dự phòng có thông số kỹ thuật đầy đủ '.repeat(4);
const lines = Array.from({ length: 8000 }, (_, i) => ({
  id: i + 1, request_code: 'YC2026-TEST', unit: 'P.Cải tiến', material_group: 'C',
  name: i % 10 === 9 ? longName : 'Phụ kiện máy mài 1 619 P15 297', uom: 'cái',
  qty_requested: 20, qty_on_hand: 0, qty_received: 0, need_date: '2026-10-24',
  project_code: 'MS332', project_name: 'Sửa chữa máy công cụ và thiết bị trong phân xưởng',
  purpose: 'Sửa chữa và dự phòng thay thế thiết bị', delivery_location: 'Xưởng cơ khí',
  requester: 'Người kiểm tra', request_date: '2026-10-23', supplier: 'Nhà cung cấp thử nghiệm',
  note: 'Ghi chú nhiều dòng\nDòng thứ hai cần hiển thị đầy đủ', created_by: user.username,
}));
let printLines = lines.slice(-6);
const boot = { user, today: '2026-10-23', users: [user], catalogs: {
  project_items: [], units: [], material_groups: [], uoms: [], suppliers: [],
} };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404).end(); return; }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)];
    res.writeHead(200, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8' }).end(content);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1790, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ user }) => {
      localStorage.setItem('ncvt_token', 'synthetic-layout-test');
      localStorage.setItem('ncvt_user', JSON.stringify(user));
    }, { user });
    await page.route('**/api', async route => {
      const { action, params } = route.request().postDataJSON();
      let data;
      if (action === 'bootstrap') data = boot;
      else if (action === 'lines.list') {
        const columns = Object.keys(lines[0]);
        data = { columns, rows: lines.map(row => columns.map(key => row[key])) };
      } else if (action === 'lines.sync') {
        const columns = Object.keys(lines[0]);
        const from = (params && params.from) || '';
        const subset = params && params.mode === 'recent'
          ? lines.filter(r => !r.request_date || !r.request_code || r.request_date >= from)
          : params && params.mode === 'older'
            ? lines.filter(r => r.request_date && r.request_code && r.request_date < from)
            : lines;
        data = {
          mode: (params && params.mode) || 'full',
          columns,
          rows: subset.map(row => columns.map(key => row[key])),
          ids: lines.map(row => row.id),
          recv: {},
          now: '2026-04-20T09:00:00',
          server_now: '2026-04-20T09:00:00',
        };
      } else if (action === 'requests.get') data = [{
        request: { code: 'YC2026-TEST', header_json: lines[0] }, lines: printLines,
      }];
      else if (action === 'lines.save') data = params.lines.map(row => ({ key: row.key, line: { ...lines[row.id - 1], ...row } }));
      else throw new Error('Unexpected API action: ' + action);
      await route.fulfill({ json: { ok: true, data } });
    });
    await page.goto(base + '/lines.html');
    await page.waitForFunction(() => document.querySelector('.toolbar')?.textContent.includes('8000 dòng'));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, 'grid.png') });
    const inspectGrid = () => page.evaluate(() => {
      const table = Tabulator.findTable('#grid')[0];
      const clipped = [...document.querySelectorAll('.tabulator-cell, .tabulator-col-title')]
        .filter(el => el.clientWidth && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2))
        .map(el => ({ field: el.getAttribute('tabulator-field'), text: el.textContent.slice(0, 60), h: el.clientHeight, sh: el.scrollHeight, w: el.clientWidth, sw: el.scrollWidth }));
      return { clipped, renderedRows: document.querySelectorAll('.tabulator-row').length, total: table.getData().length };
    });
    const initial = await inspectGrid();
    console.log('GRID', JSON.stringify(initial));
    assert.deepEqual(initial.clipped, [], 'Grid content must not be clipped');
    assert(initial.renderedRows < 200, 'Keep virtual rendering for 8000 rows');
    assert.equal(initial.total, 8000);
    const nameHeader = await page.locator('.tabulator-col[tabulator-field="name"]').boundingBox();
    await page.mouse.move(nameHeader.x + nameHeader.width - 2, nameHeader.y + 12);
    await page.mouse.down();
    await page.mouse.move(nameHeader.x + 160, nameHeader.y + 12, { steps: 10 });
    await page.mouse.up();
    assert((await page.locator('.tabulator-col[tabulator-field="name"]').boundingBox()).width < 200, 'Actually resize the column');
    await page.evaluate(async () => {
      const table = Tabulator.findTable('#grid')[0];
      await table.scrollToRow('i7980', 'center', false);
    });
    assert.deepEqual((await inspectGrid()).clipped, [], 'Resizing must recalculate wrapped row heights');
    await page.evaluate(async () => {
      const table = Tabulator.findTable('#grid')[0];
      await table.getRow('i7981').update({ name: 'Nội dung sau khi sửa '.repeat(30) });
      await table.scrollToRow('i7981', 'center', false);
    });
    assert.deepEqual((await inspectGrid()).clipped, [], 'Updated long values must remain visible');
    await page.setViewportSize({ width: 900, height: 750 });
    assert.deepEqual((await inspectGrid()).clipped, [], 'Smaller screens must retain complete cell contents');
    await page.screenshot({ path: path.join(out, 'grid-resized.png') });
    await page.setViewportSize({ width: 1790, height: 950 });
    await page.goto(base + '/print.html?codes=YC2026-TEST');
    await page.waitForSelector('.sheet');
    await page.waitForSelector('#btn-print:enabled');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('#paper').inputValue(), 'a5l', 'Default to A5 landscape');
    for (const paper of ['a5l', 'a4l']) {
      await page.selectOption('#paper', paper);
      await page.waitForSelector('#btn-print:enabled');
      const printLayout = await page.evaluate(() => ({
        widths: [...document.querySelectorAll('.items col')].slice(0, 14).reduce((sum, col) => sum + parseFloat(col.style.width), 0),
        clipped: [...document.querySelectorAll('.sheet th, .sheet td')].filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.textContent),
      }));
      assert.equal(printLayout.widths, 100, 'Print column widths add up to 100%');
      assert.deepEqual(printLayout.clipped, [], 'PDF cells must not overflow horizontally');
      await page.screenshot({ path: path.join(out, paper + '.png'), fullPage: true });
      const pdfBytes = await page.pdf({ path: path.join(out, paper + '.pdf'), preferCSSPageSize: true, printBackground: true });
      const pdf = await PDFDocument.load(pdfBytes);
      const sheets = await page.locator('.sheet').count();
      assert.equal(pdf.getPageCount(), sheets, 'PDF must not add orphan footer/signature pages');
      const mm = paper === 'a5l' ? [210, 148] : [297, 210];
      for (const pdfPage of pdf.getPages()) {
        const size = pdfPage.getSize();
        assert(Math.abs(size.width - mm[0] * 72 / 25.4) < 1, 'Correct PDF width');
        assert(Math.abs(size.height - mm[1] * 72 / 25.4) < 1, 'Correct PDF height');
      }
      const printedRows = await page.locator('.items tbody tr td:first-child').allTextContents();
      assert.deepEqual(printedRows, ['1', '2', '3', '4', '5', '6'], 'Pagination must preserve all rows in order');
      assert.equal(await page.locator('.sheet:last-child .signs').count(), 1, 'Signatures stay on final page');
      console.log('PRINT', paper, sheets, 'pages; dimensions, row order and signatures OK');
    }
    await page.reload();
    await page.waitForSelector('.sheet');
    await page.waitForSelector('#btn-print:enabled');
    assert.equal(await page.locator('#paper').inputValue(), 'a4l', 'Remember paper selection');
    for (const count of [18, 35]) {
      printLines = Array.from({ length: count }, (_, i) => ({
        ...lines[0], id: i + 1, name: 'Phụ kiện máy mài 1 619 P15 297',
        project_name: 'Sửa chữa máy công cụ', purpose: 'Sửa chữa + dự phòng',
        requester: 'Nam', supplier: 'KHVT', delivery_location: '',
      }));
      await page.reload();
      await page.waitForSelector('#btn-print:enabled');
      await page.selectOption('#rpp', '20');
      await page.waitForSelector('#btn-print:enabled');
      assert.equal(await page.locator('.items thead tr').count(), 2 * await page.locator('.sheet').count(), 'Only column labels remain; no 1–14 numbering row');
      const layout = await page.evaluate(() => [...document.querySelectorAll('.sheet')].map(sheet => {
        const style = getComputedStyle(sheet);
        const rows = [...sheet.querySelectorAll('.items tbody tr')];
        const footer = sheet.querySelector('.pageno');
        const limit = parseFloat(style.minHeight) - parseFloat(style.paddingBottom) - footer.getBoundingClientRect().height - 12;
        return {
          count: rows.length,
          minHeight: Math.min(...rows.map(row => row.getBoundingClientRect().height)),
          final: !!sheet.querySelector('.signs'),
          unused: limit - (sheet.querySelector('.items').getBoundingClientRect().bottom - sheet.getBoundingClientRect().top),
        };
      }));
      for (const sheet of layout) {
        if (!sheet.final) assert(sheet.unused < 10, 'Non-final pages must use the space below the table');
        assert(sheet.minHeight > 25, 'Short rows get more room to read');
      }
      assert.equal(layout.reduce((sum, sheet) => sum + sheet.count, 0), count);
      if (count === 18 && layout.length > 1) assert(layout.at(-1).count >= 3, 'Avoid an isolated final row with signatures');
      await page.screenshot({ path: path.join(out, 'a4l-' + count + '.png'), fullPage: true });
      const pdf = await PDFDocument.load(await page.pdf({ path: path.join(out, 'a4l-' + count + '.pdf'), preferCSSPageSize: true, printBackground: true }));
      assert.equal(pdf.getPageCount(), layout.length, 'Expanded rows must not cause extra PDF pages');
      console.log('ROW SPACING', count, JSON.stringify(layout));
    }
    assert.deepEqual(errors, [], 'No browser errors');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
