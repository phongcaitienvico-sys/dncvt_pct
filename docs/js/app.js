/** Gọi API + khung trang chung (thanh menu, thông báo). Dùng ở mọi trang. */
(function () {
  const TOKEN_KEY = 'ncvt_token';
  const USER_KEY = 'ncvt_user';

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* trình duyệt chặn lưu trữ */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* bỏ qua */ } },
  };

  const Api = {
    token: () => storage.get(TOKEN_KEY),
    user() { try { return JSON.parse(storage.get(USER_KEY) || 'null'); } catch (e) { return null; } },
    saveLogin(data) { storage.set(TOKEN_KEY, data.token); storage.set(USER_KEY, JSON.stringify(data.user)); },
    logout() { storage.del(TOKEN_KEY); storage.del(USER_KEY); },

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
      App.boot = await Api.call('bootstrap');
      App.user = App.boot.user; // quyền mới nhất từ máy chủ
      Api.saveLogin({ token: Api.token(), user: App.user });
      App.renderNav();
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
