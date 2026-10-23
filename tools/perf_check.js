/**
 * Đo hiệu năng bảng vật tư bằng Edge/Chrome headless (có bố cục thật, cửa sổ 1400x900).
 *   node tools/perf_check.js <base_url> <username> <password>
 *   vd: node tools/perf_check.js http://localhost:8787 admin xxxxx
 * In ra: thời gian tải bảng, tìm kiếm, lọc trạng thái, cuộn; số dòng DOM đang vẽ (ảo hóa).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [base, username, password] = process.argv.slice(2);
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!base || !username || !password || !exe) {
  console.error('Cách dùng: node tools/perf_check.js <base_url> <username> <password>  (cần Edge hoặc Chrome)');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await fetch(base + '/api', { method: 'POST', body: JSON.stringify({ action: 'login', params: { username, password } }) }).then((r) => r.json());
  if (!login.ok) throw new Error(login.error);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvt-perf-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1400,900', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())).find((t) => t.type === 'page'); } catch (e) { /* chưa sẵn sàng */ }
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const pending = {};
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } });
    const send = (method, params) => new Promise((r) => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result.result.value;
    };

    await send('Page.navigate', { url: base + '/index.html' });
    await sleep(1000);
    await evaluate(`localStorage.setItem('ncvt_token', ${JSON.stringify(login.data.token)}); localStorage.setItem('ncvt_user', ${JSON.stringify(JSON.stringify(login.data.user))}); 1`);
    const t0 = Date.now();
    await send('Page.navigate', { url: base + '/lines.html' });
    const result = await evaluate(`(async () => {
      const info = () => document.querySelector('.toolbar .muted').textContent;
      const until = async (fn, max = 60000) => { const s = performance.now(); while (!fn() && performance.now() - s < max) await new Promise(r => setTimeout(r, 20)); };
      // rAF không chạy ở tab headless → ép tính bố cục rồi nhường 1 vòng sự kiện
      const frame = () => { void document.body.offsetHeight; return new Promise(r => setTimeout(r, 0)); };
      await until(() => document.querySelector('.toolbar .muted') && /^[1-9]\\d* dòng/.test(info()));
      await frame();
      const loadedAt = performance.now();
      const out = { loadMs: Math.round(loadedAt), rows: info(), domRowsAfterLoad: document.querySelectorAll('.tabulator-row').length };
      const q = document.querySelector('.filters input[type=search]');
      let s = performance.now();
      q.value = 'thep tam'; q.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => /đang hiện/.test(info())); await frame();
      out.searchMs = Math.round(performance.now() - s - 300) + ' (sau 300ms chờ gõ)'; out.searchResult = info();
      q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); await until(() => !/đang hiện/.test(info()));
      const st = document.querySelectorAll('.filters select')[4];
      s = performance.now(); st.value = 'overdue'; st.dispatchEvent(new Event('change')); await frame();
      out.statusFilterMs = Math.round(performance.now() - s); out.statusResult = info();
      st.value = ''; st.dispatchEvent(new Event('change')); await frame();
      const holder = document.querySelector('.tabulator-tableholder');
      s = performance.now(); let worst = 0;
      for (let i = 0; i < 30; i++) { const f = performance.now(); holder.scrollTop = (i * 7919) % holder.scrollHeight; await frame(); worst = Math.max(worst, performance.now() - f); }
      out.scroll30JumpsMs = Math.round(performance.now() - s); out.worstFrameMs = Math.round(worst);
      out.domRowsAfterScroll = document.querySelectorAll('.tabulator-row').length;
      return out;
    })()`);
    result.totalWallMs = Date.now() - t0;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (ws) ws.close();
    proc.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
