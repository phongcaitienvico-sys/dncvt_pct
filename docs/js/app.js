/** Gọi API + khung trang chung (thanh menu, thông báo). Dùng ở mọi trang. */
(function () {
  const TOKEN_KEY = 'ncvt_token';
  const USER_KEY = 'ncvt_user';

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* trình duyệt chặn lưu trữ */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* bỏ qua */ } },
  };

  // ---------- Bản lưu dữ liệu trong trình duyệt (IndexedDB) để mở trang là có dữ liệu ngay ----------
  const idb = {
    db: null,
    open() {
      if (idb.db) return idb.db;
      idb.db = new Promise((resolve) => {
        try {
          const rq = indexedDB.open('ncvt', 1);
          rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
          rq.onsuccess = () => resolve(rq.result);
          rq.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
      return idb.db;
    },
    async run(mode, fn) {
      const db = await idb.open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('kv', mode);
          const rq = fn(tx.objectStore('kv'));
          tx.oncomplete = () => resolve(rq ? rq.result : null);
          tx.onerror = tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    get: (k) => idb.run('readonly', (st) => st.get(k)),
    set: (k, v) => idb.run('readwrite', (st) => st.put(v, k)),
    clear: () => idb.run('readwrite', (st) => st.clear()),
  };

  const Api = {
    token: () => storage.get(TOKEN_KEY),
    user() { try { return JSON.parse(storage.get(USER_KEY) || 'null'); } catch (e) { return null; } },
    saveLogin(data) { storage.set(TOKEN_KEY, data.token); storage.set(USER_KEY, JSON.stringify(data.user)); },
    logout() { storage.del(TOKEN_KEY); storage.del(USER_KEY); idb.clear(); },

    async call(action, params) {
      let res;
      try {
        res = await fetch(window.APP_CONFIG.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tránh preflight CORS với Apps Script
          body: JSON.stringify({ action, params: params || {}, token: Api.token() }),
          redirect: 'follow',
        });
      } catch (e) {
        throw Object.assign(new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'), { code: 'NETWORK' });
      }
      let j;
      try { j = await res.json(); } catch (e) {
        throw Object.assign(new Error('Máy chủ trả về dữ liệu lạ (HTTP ' + res.status + ').'), { code: 'BAD_RESPONSE' });
      }
      if (!j.ok) {
        if (j.code === 'AUTH') { Api.logout(); App.goLogin(); }
        throw Object.assign(new Error(j.error), { code: j.code, details: j.details });
      }
      return j.data;
    },
  };

  const PAGES = [
    ['lines.html', 'Bảng vật tư'],
    ['receive.html', 'Nhận hàng'],
    ['project.html', 'Theo hạng mục'],
    ['requests.html', 'Phiếu đã xuất'],
    ['admin.html', 'Quản trị', true],
  ];

  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const App = {
    esc,
    user: null,
    boot: null,

    currentPage: () => location.pathname.split('/').pop() || 'index.html',

    goLogin() {
      const next = App.currentPage() + location.search;
      location.href = 'index.html?next=' + encodeURIComponent(next);
    },

    /** Kiểm tra đăng nhập, vẽ menu, tải danh mục. Trả về dữ liệu bootstrap. */
    async init(opts) {
      opts = opts || {};
      App.user = Api.user();
      if (!Api.token() || !App.user) { App.goLogin(); return new Promise(() => {}); }
      App.renderNav();
      const bootKey = 'boot:' + App.user.username;
      const refresh = async () => {
        const fresh = await Api.call('bootstrap');
        fresh.today = Logic.todayIso();
        idb.set(bootKey, fresh);
        if (fresh.user.role !== App.user.role) { Api.saveLogin({ token: Api.token(), user: fresh.user }); }
        App.user = fresh.user; // quyền mới nhất từ máy chủ
        App.boot = fresh;
        App.renderNav();
        return fresh;
      };
      // Danh mục ít đổi: có bản lưu thì dùng ngay, làm mới ngầm (trang admin luôn chờ bản mới để kiểm tra quyền)
      const cached = opts.admin ? null : await idb.get(bootKey);
      if (cached) {
        cached.today = Logic.todayIso();
        App.boot = cached;
        refresh().catch(() => { /* lỗi mạng: tiếp tục dùng bản lưu; hết phiên thì Api.call tự chuyển về đăng nhập */ });
        return App.boot;
      }
      await refresh();
      if (opts.admin && App.user.role !== 'admin') { location.href = 'lines.html'; return new Promise(() => {}); }
      return App.boot;
    },

    renderNav() {
      const el = document.getElementById('topbar');
      if (!el) return;
      const cur = App.currentPage();
      const links = PAGES.filter((p) => !p[2] || App.user.role === 'admin')
        .map((p) => `<a href="${p[0]}" class="${p[0] === cur ? 'active' : ''}">${esc(p[1])}</a>`).join('');
      el.innerHTML = `
        <div class="brand">ĐNCVT</div>
        <nav>${links}</nav>
        <div class="me">
          <span title="${esc(App.user.username)}">${esc(App.user.full_name)}${App.user.role === 'admin' ? ' · QT' : ''}</span>
          <button type="button" class="link" id="btn-pass">Đổi mật khẩu</button>
          <button type="button" class="link" id="btn-logout">Đăng xuất</button>
        </div>`;
      el.querySelector('#btn-logout').onclick = () => { Api.logout(); location.href = 'index.html'; };
      el.querySelector('#btn-pass').onclick = App.changePassword;
    },

    async changePassword() {
      const v = await App.askPasswords('Đổi mật khẩu', [
        { name: 'old', label: 'Mật khẩu hiện tại', autocomplete: 'current-password' },
        { name: 'new', label: 'Mật khẩu mới (ít nhất 8 ký tự)', autocomplete: 'new-password', min: 8 },
        { name: 'again', label: 'Nhập lại mật khẩu mới', autocomplete: 'new-password' },
      ], (x) => (x.new !== x.again ? 'Hai lần nhập mật khẩu mới không khớp.' : ''));
      if (!v) return;
      try {
        await Api.call('auth.changePassword', { old_password: v.old, new_password: v.new });
        App.toast('Đã đổi mật khẩu.', 'ok');
      } catch (e) { App.toast(e.message, 'error'); }
    },

    /**
     * Hộp thoại nhập mật khẩu có nút con mắt (hiện/ẩn). fields = [{name, label, autocomplete?, min?}];
     * check(values) trả chuỗi lỗi (hoặc '') để kiểm tra trước khi đóng. Trả về {name: giá trị} hoặc null nếu hủy.
     */
    askPasswords(title, fields, check) {
      return new Promise((resolve) => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        back.innerHTML = `
          <form class="modal" style="width:min(420px,100%)" role="dialog" aria-modal="true" aria-label="${esc(title)}">
            <div class="modal-head"><b>${esc(title)}</b></div>
            <div class="modal-body" style="display:grid;gap:12px">
              ${fields.map((f) => `<label style="display:grid;gap:4px;font-weight:600;font-size:14px">${esc(f.label)}
                <input name="${esc(f.name)}" type="password" required autocomplete="${esc(f.autocomplete || 'off')}" ${f.min ? 'minlength="' + f.min + '"' : ''} style="padding:9px"></label>`).join('')}
              <div class="error-text" data-err></div>
            </div>
            <div class="modal-foot"><span class="spacer"></span>
              <button type="button" data-cancel>Hủy</button><button type="submit" class="primary">Xác nhận</button>
            </div>
          </form>`;
        document.body.appendChild(back);
        App.enhancePasswordInputs(back);
        const form = back.querySelector('form');
        const done = (val) => { back.remove(); resolve(val); };
        back.querySelector('[data-cancel]').onclick = () => done(null);
        back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const vals = {};
          fields.forEach((f) => { vals[f.name] = form.elements[f.name].value; });
          const err = check ? check(vals) : '';
          if (err) { form.querySelector('[data-err]').textContent = err; return; }
          done(vals);
        });
        form.elements[fields[0].name].focus();
      });
    },

    /** Gắn nút con mắt (hiện/ẩn) vào mọi ô mật khẩu trong `root` (mặc định cả trang). Gọi lại nhiều lần vẫn an toàn. */
    enhancePasswordInputs(root) {
      const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
      const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.06-5.94M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 7 11 7a19.7 19.7 0 0 1-3.17 4.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
      (root || document).querySelectorAll('input[type="password"]').forEach((input) => {
        if (input.dataset.eye) return;
        input.dataset.eye = '1';
        const wrap = document.createElement('span');
        wrap.className = 'pw-wrap';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pw-eye';
        btn.tabIndex = -1; // không chen vào thứ tự Tab giữa các ô nhập
        const paint = () => {
          const shown = input.type === 'text';
          btn.innerHTML = shown ? EYE_OFF : EYE;
          btn.title = btn.ariaLabel = shown ? 'Ẩn mật khẩu' : 'Hiện mật khẩu';
        };
        btn.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; paint(); input.focus(); });
        paint();
        wrap.appendChild(btn);
      });
    },

    toast(msg, type, ms) {
      let box = document.getElementById('toasts');
      if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
      const t = document.createElement('div');
      t.className = 'toast ' + (type || '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(() => t.remove(), ms || (type === 'error' ? 7000 : 3000));
    },

    /**
     * Tải danh sách dòng vật tư nhanh: có bản lưu → gọi onCached(objects) NGAY, rồi chỉ tải phần thay đổi (lines.sync).
     * Trả {objects, diff}: diff = null khi không có bản lưu (tải đầy đủ), ngược lại {upsert: [object], removed: [id]}.
     */
    async loadLines(onCached, opts) {
      opts = opts || {};
      const key = 'lines:' + (App.user ? App.user.username : '');
      const cache = await idb.get(key);
      const byId = new Map();
      if (cache && cache.objs) {
        cache.objs.forEach((o) => byId.set(o.id, o));
        if (onCached) onCached(Array.from(byId.values()));
      }
      // Lần đầu (chưa có bản lưu) và nơi gọi muốn tải theo đợt: hiện ngay dữ liệu tháng này, phần cũ hơn tải tiếp ở nền
      if (!cache && opts.onPartial) return App.loadLinesProgressive(key, opts.onPartial);
      const res = await Api.call('lines.sync', { since: cache && cache.now ? cache.now : null });
      const upsertIds = new Set();
      res.rows.forEach((r) => {
        const o = {};
        res.columns.forEach((c, i) => { o[c] = r[i]; });
        byId.set(o.id, Object.assign(byId.get(o.id) || {}, o));
        upsertIds.add(o.id);
      });
      const alive = new Set(res.ids);
      const removed = [];
      Array.from(byId.keys()).forEach((id) => { if (!alive.has(id)) { byId.delete(id); removed.push(id); } });
      byId.forEach((o, id) => {
        const rv = res.recv[id];
        const qty = rv ? rv[0] : 0;
        const last = rv ? rv[1] : null;
        if (o.qty_received !== qty || (o.last_received_date || null) !== (last || null) || !('qty_received' in o)) {
          o.qty_received = qty; o.last_received_date = last || null;
          upsertIds.add(id);
        }
      });
      const objects = Array.from(byId.values()).sort((a, b) => a.id - b.id);
      idb.set(key, { now: res.now, objs: objects });
      return {
        objects,
        diff: cache ? { upsert: Array.from(upsertIds).filter((id) => byId.has(id)).map((id) => byId.get(id)), removed } : null,
      };
    },

    /** Gọi sớm đợt 1 (tháng này) ngay khi trang mở, chạy song song với tải danh mục; loadLines sẽ dùng lại. */
    prefetchRecent() {
      if (!Api.token()) return;
      const from = Logic.todayIso().slice(0, 8) + '01';
      App._early = { from, p: Api.call('lines.sync', { mode: 'recent', from }).catch(() => null) };
    },

    /**
     * Tải lần đầu theo 2 đợt. Đợt 1 (tháng này + dòng chưa có phiếu) → onPartial({objects, loadingMore:true}) NGAY;
     * đợt 2 (cũ hơn) xong thì gộp, lưu bản lưu và trả {objects, diff:null, older:[...]}.
     */
    async loadLinesProgressive(key, onPartial) {
      const from = Logic.todayIso().slice(0, 8) + '01';
      const toObjs = (res) => res.rows.map((r) => { const o = {}; res.columns.forEach((c, i) => { o[c] = r[i]; }); return o; });
      const withRecv = (objs, recv) => objs.forEach((o) => {
        const rv = recv[o.id];
        o.qty_received = rv ? rv[0] : 0; o.last_received_date = rv ? (rv[1] || null) : null;
      });
      // dùng kết quả đã tải sẵn song song với danh mục (prefetchRecent) nếu có
      const early = App._early && App._early.from === from ? await App._early.p : null;
      App._early = null;
      const r1 = early || await Api.call('lines.sync', { mode: 'recent', from });
      const recent = toObjs(r1);
      withRecv(recent, r1.recv);
      recent.sort((a, b) => a.id - b.id);
      onPartial({ objects: recent, loadingMore: true, from });
      const r2 = await Api.call('lines.sync', { mode: 'older', from });
      const older = toObjs(r2);
      withRecv(older, r2.recv);
      older.sort((a, b) => a.id - b.id);
      const all = older.concat(recent).sort((a, b) => a.id - b.id);
      // mốc đồng bộ = lúc bắt đầu đợt 1: lần sau chỉ lấy các thay đổi từ đó (có lùi 2 phút) nên không sót dòng ghi giữa 2 đợt
      idb.set(key, { now: r1.now, objs: all });
      return { objects: all, diff: null, older };
    },

    /** Chuyển kết quả lines.list (cột + mảng) thành mảng object. */
    rowsToObjects(data) {
      return data.rows.map((r) => {
        const o = {};
        data.columns.forEach((c, i) => { o[c] = r[i]; });
        return o;
      });
    },

    /** Mở trang in ở tab mới (mở tab trước khi chờ API để không bị chặn popup). */
    openPrintWindow() {
      return window.open('about:blank', '_blank');
    },

    printUrl(codes, tpl) {
      return 'print.html?tpl=' + encodeURIComponent(tpl || 'phieu_de_nghi') + '&codes=' + encodeURIComponent(codes.join(','));
    },

    /** Xuất Excel bằng SheetJS: sheets = [{name, rows: [obj], columns: [[field, header]]}] */
    exportExcel(fileName, sheets) {
      const wb = XLSX.utils.book_new();
      sheets.forEach((s) => {
        const aoa = [s.columns.map((c) => c[1])].concat(s.rows.map((r) => s.columns.map((c) => {
          const v = typeof c[2] === 'function' ? c[2](r) : r[c[0]];
          return v === null || v === undefined ? '' : v;
        })));
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = s.columns.map((c) => ({ wch: Math.min(40, Math.max(8, String(c[1]).length + 2)) }));
        XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
      });
      XLSX.writeFile(wb, fileName);
    },
  };

  window.Api = Api;
  window.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.enhancePasswordInputs());
  else App.enhancePasswordInputs();
})();
