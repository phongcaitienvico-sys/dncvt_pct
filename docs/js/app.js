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
      const oldPw = prompt('Mật khẩu hiện tại:');
      if (!oldPw) return;
      const newPw = prompt('Mật khẩu mới (ít nhất 8 ký tự):');
      if (!newPw) return;
      if (prompt('Nhập lại mật khẩu mới:') !== newPw) { App.toast('Hai lần nhập không khớp.', 'error'); return; }
      try {
        await Api.call('auth.changePassword', { old_password: oldPw, new_password: newPw });
        App.toast('Đã đổi mật khẩu.', 'ok');
      } catch (e) { App.toast(e.message, 'error'); }
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
    async loadLines(onCached) {
      const key = 'lines:' + (App.user ? App.user.username : '');
      const cache = await idb.get(key);
      const byId = new Map();
      if (cache && cache.objs) {
        cache.objs.forEach((o) => byId.set(o.id, o));
        if (onCached) onCached(Array.from(byId.values()));
      }
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
})();
