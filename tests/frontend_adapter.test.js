const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createBackend } = require('../dev/gas');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
// Đưa object tạo trong vm context về realm hiện tại để assert.deepEqual(strict) so sánh đúng prototype
const fromVm = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

function makeIndexedDB() {
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    stores,
    open(dbName) {
      const rq = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        const db = {
          name: dbName,
          createObjectStore: (sName) => getStore(sName),
          transaction(sName) {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore(target) {
                const st = getStore(target);
                return {
                  get(k) {
                    const r = { result: st.has(k) ? st.get(k) : undefined };
                    queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
                    return r;
                  },
                  put(v, k) {
                    st.set(k, v);
                    const r = { result: k };
                    queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
                    return r;
                  },
                  clear() {
                    st.clear();
                    const r = { result: undefined };
                    queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
                    return r;
                  },
                };
              },
            };
            return tx;
          },
        };
        rq.result = db;
        if (rq.onupgradeneeded) rq.onupgradeneeded();
        if (rq.onsuccess) rq.onsuccess();
      });
      return rq;
    },
  };
}

function createBrowserEnv(opts = {}) {
  const localStorage = makeStorage();
  const indexedDB = makeIndexedDB();
  const location = {
    hostname: opts.hostname || 'localhost',
    pathname: opts.pathname || '/lines.html',
    search: opts.search || '',
    href: (opts.pathname || '/lines.html') + (opts.search || ''),
    replace(url) { location.href = url; },
  };
  const document = {
    readyState: 'complete',
    body: { appendChild() {} },
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      className: '',
      style: {},
      dataset: {},
      appendChild() {},
      remove() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      getContext: () => ({ font: '', measureText: (t) => ({ width: String(t).length * 7 }) }),
    }),
    addEventListener() {},
  };
  const fetchCalls = [];
  const fetchImpl = opts.fetch || (async () => ({
    status: 200, ok: true, json: async () => ({ ok: true, data: { mocked: true } }),
  }));

  const sandbox = {
    console,
    setTimeout: (fn, ms, ...args) => {
      const t = setTimeout(fn, ms, ...args);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    setInterval: (fn, ms, ...args) => {
      const t = setInterval(fn, ms, ...args);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    WebSocket: globalThis.WebSocket || function WebSocket() {},
    crypto: globalThis.crypto,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Error,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    localStorage,
    indexedDB,
    location,
    history: { replaceState(st, title, url) { location.search = url.startsWith('?') ? url : ''; } },
    document,
    addEventListener() {},
    removeEventListener() {},
    confirm: opts.confirm || (() => true),
    prompt: opts.prompt || (() => ''),
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (opts.supabase) sandbox.supabase = opts.supabase;
  vm.createContext(sandbox);

  const runScript = (relPath) => {
    const full = path.join(DOCS, relPath);
    const code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, sandbox, { filename: relPath });
  };

  runScript('js/config.js');
  runScript('js/logic.js');
  if (opts.appConfig) Object.assign(sandbox.APP_CONFIG, opts.appConfig);
  runScript('js/app.js');

  return { sandbox, localStorage, indexedDB, location, fetchCalls, runScript };
}

function makeFakeSupabase(overrides = {}) {
  const calls = {
    createClient: [],
    setSession: [],
    getSession: 0,
    refreshSession: 0,
    signOut: [],
    rpc: [],
  };
  let authListener = null;
  let currentSession = overrides.initialSession !== undefined ? overrides.initialSession : {
    access_token: 'jwt-valid-token',
    refresh_token: 'rt-valid-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  const client = {
    auth: {
      onAuthStateChange(cb) {
        authListener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async setSession(sess) {
        calls.setSession.push(sess);
        currentSession = {
          access_token: sess.access_token,
          refresh_token: sess.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
        if (authListener) authListener('SIGNED_IN', currentSession);
        return { data: { session: currentSession }, error: null };
      },
      async getSession() {
        calls.getSession++;
        if (overrides.onGetSession) return overrides.onGetSession(currentSession);
        return { data: { session: currentSession }, error: null };
      },
      async refreshSession() {
        calls.refreshSession++;
        if (overrides.onRefreshSession) return overrides.onRefreshSession();
        currentSession = {
          access_token: 'jwt-refreshed-after-lunch',
          refresh_token: 'rt-refreshed',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
        if (authListener) authListener('TOKEN_REFRESHED', currentSession);
        return { data: { session: currentSession }, error: null };
      },
      async signOut(opts) {
        calls.signOut.push(opts);
        currentSession = null;
        return { error: null };
      },
    },
    async rpc(fnName, args) {
      calls.rpc.push({ fnName, args });
      if (overrides.onRpc) return overrides.onRpc(fnName, args);
      return { data: { rpcOk: fnName, echoed: args.p_params }, error: null, status: 200 };
    },
  };

  return {
    calls,
    emitAuth: (ev, sess) => authListener && authListener(ev, sess),
    setCurrentSession: (s) => { currentSession = s; },
    supabaseGlobal: {
      createClient(url, key, options) {
        calls.createClient.push({ url, key, options });
        return client;
      },
    },
  };
}

test('config.js kích hoạt BACKEND_MODE = supabase và giữ nguyên API_URL làm cầu dao Rollback', () => {
  const { sandbox } = createBrowserEnv({ hostname: 'localhost' });
  assert.equal(sandbox.APP_CONFIG.BACKEND_MODE, 'supabase');
  assert.equal(sandbox.APP_CONFIG.SUPABASE_URL, 'https://unbrchhbfughabmkorxt.supabase.co');
  assert.match(sandbox.APP_CONFIG.SUPABASE_ANON_KEY, /^eyJ/);
  assert.equal(sandbox.APP_CONFIG.API_URL, '/api');

  const prod = createBrowserEnv({ hostname: 'example.github.io' });
  assert.equal(prod.sandbox.APP_CONFIG.BACKEND_MODE, 'supabase');
  assert.match(prod.sandbox.APP_CONFIG.API_URL, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
});

test('chế độ gas và cầu dao Rollback: gọi đúng API_URL kiểu text/plain và chuyển tức thì khi đổi BACKEND_MODE', async () => {
  const fake = makeFakeSupabase();
  const { sandbox, fetchCalls } = createBrowserEnv({
    supabase: fake.supabaseGlobal,
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: '', // chưa điền URL → vẫn chạy chế độ gas an toàn
      SUPABASE_ANON_KEY: '',
    },
  });
  sandbox.Api.saveLogin({ token: 'gas-tok', user: { username: 'nam', role: 'user' } });
  const res = await sandbox.Api.call('lines.list', { page: 1 });
  assert.deepEqual(res, { mocked: true });
  assert.equal(fake.calls.createClient.length, 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api');
  assert.equal(fetchCalls[0].init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    action: 'lines.list',
    params: { page: 1 },
    token: 'gas-tok',
  });

  // Bật Supabase → đi qua RPC; sau đó gạt cầu dao Rollback về 'gas' → lập tức quay về API_URL
  Object.assign(sandbox.APP_CONFIG, {
    BACKEND_MODE: 'supabase',
    SUPABASE_URL: 'https://demo.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
  });
  const sbRes = await sandbox.Api.call('lines.list', { page: 2 });
  assert.equal(sbRes.rpcOk, 'rpc_lines_list');
  sandbox.APP_CONFIG.BACKEND_MODE = 'gas';
  const rbRes = await sandbox.Api.call('lines.list', { page: 3 });
  assert.deepEqual(rbRes, { mocked: true });
  assert.equal(fetchCalls.length, 2);
});

test('Supabase lazy singleton, đồng bộ phiên saveLogin / onAuthStateChange / logout và làm mới chủ động < 120s', async () => {
  const fake = makeFakeSupabase();
  const { sandbox, localStorage, indexedDB } = createBrowserEnv({
    supabase: fake.supabaseGlobal,
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: 'https://demo-project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public-key',
    },
  });

  // Lazy singleton: chưa gọi gì thì chưa khởi tạo client
  assert.equal(fake.calls.createClient.length, 0);

  await sandbox.Api.saveLogin({
    token: 'jwt-initial',
    refresh_token: 'rt-initial',
    user: { username: 'admin', full_name: 'Quản trị', role: 'admin' },
  });
  assert.equal(sandbox.Api.token(), 'jwt-initial');
  assert.equal(sandbox.Api.user().username, 'admin');
  assert.equal(fake.calls.createClient.length, 1);
  assert.deepEqual(fromVm(fake.calls.createClient[0]), {
    url: 'https://demo-project.supabase.co',
    key: 'anon-public-key',
    options: {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'ncvt_sb_auth',
      },
    },
  });
  assert.deepEqual(fromVm(fake.calls.setSession[0]), {
    access_token: 'jwt-initial',
    refresh_token: 'rt-initial',
  });

  // Giả lập người dùng nghỉ trưa quay lại: access token chỉ còn 45 giây (< 120s)
  fake.setCurrentSession({
    access_token: 'jwt-expiring-soon',
    refresh_token: 'rt-initial',
    expires_at: Math.floor(Date.now() / 1000) + 45,
  });
  await sandbox.Api.call('bootstrap');
  assert.equal(fake.calls.refreshSession, 1);
  assert.equal(localStorage.getItem('ncvt_token'), 'jwt-refreshed-after-lunch');
  assert.equal(fake.calls.createClient.length, 1); // singleton không tạo lại

  // Khi phiên còn dài (> 120s), không gọi refreshSession thừa
  await sandbox.Api.call('lines.list');
  assert.equal(fake.calls.refreshSession, 1);

  // Ghi thử dữ liệu vào IndexedDB rồi kiểm tra logout xóa sạch cả localStorage + IndexedDB + sb.auth.signOut
  indexedDB.stores.set('kv', new Map([['lines:admin', { objs: [{ id: 1 }] }]]));
  sandbox.Api.logout();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sandbox.Api.token(), null);
  assert.equal(sandbox.Api.user(), null);
  assert.equal(indexedDB.stores.get('kv').size, 0);
  assert.deepEqual(fromVm(fake.calls.signOut), [{ scope: 'local' }]);

  // Kiểm tra sự kiện SIGNED_OUT từ onAuthStateChange
  localStorage.setItem('ncvt_token', 'temp-tok');
  localStorage.setItem('ncvt_user', '{"username":"x"}');
  fake.emitAuth('SIGNED_OUT', null);
  assert.equal(localStorage.getItem('ncvt_token'), null);
  assert.equal(localStorage.getItem('ncvt_user'), null);
});

test('Định tuyến chính xác 100% toàn bộ 26 actions (3 Edge Function admin-ops + 23 RPC)', async () => {
  const fake = makeFakeSupabase();
  const edgeRequests = [];
  const { sandbox } = createBrowserEnv({
    supabase: fake.supabaseGlobal,
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: 'https://demo-project.supabase.co/',
      SUPABASE_ANON_KEY: 'anon-key-123',
    },
    fetch: async (url, init) => {
      edgeRequests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          data: { edgeAction: JSON.parse(init.body).action, token: 'jwt-login', refresh_token: 'rt-login', user: { username: 'nam', role: 'user' } },
        }),
      };
    },
  });

  // 1) login: không gọi getSession/refreshSession trước, dùng SUPABASE_ANON_KEY khi chưa có token
  const loginRes = await sandbox.Api.call('login', { username: 'nam', password: 'secret' });
  assert.equal(loginRes.edgeAction, 'login');
  assert.equal(fake.calls.getSession, 0);
  assert.equal(edgeRequests[0].url, 'https://demo-project.supabase.co/functions/v1/admin-ops');
  assert.equal(edgeRequests[0].headers.apikey, 'anon-key-123');
  assert.equal(edgeRequests[0].headers.Authorization, 'Bearer anon-key-123');
  assert.deepEqual(edgeRequests[0].body, { action: 'login', params: { username: 'nam', password: 'secret' } });

  await sandbox.Api.saveLogin(loginRes);

  // 2) auth.changePassword & users.save qua Edge Function với Bearer user JWT
  for (const act of ['auth.changePassword', 'users.save']) {
    const r = await sandbox.Api.call(act, { sample: act });
    assert.equal(r.edgeAction, act);
    const last = edgeRequests[edgeRequests.length - 1];
    assert.equal(last.url, 'https://demo-project.supabase.co/functions/v1/admin-ops');
    assert.equal(last.headers.Authorization, 'Bearer jwt-login');
    assert.deepEqual(last.body, { action: act, params: { sample: act } });
  }

  // 3) 23 RPC actions khớp tuyệt đối bảng ánh xạ với Dev #1
  const expectedRpcMap = [
    ['bootstrap', 'rpc_bootstrap'],
    ['lines.list', 'rpc_lines_list'],
    ['lines.sync', 'rpc_lines_sync'],
    ['lines.save', 'rpc_lines_save'],
    ['lines.create', 'rpc_lines_create'],
    ['lines.delete', 'rpc_lines_delete'],
    ['lines.duplicate', 'rpc_lines_duplicate'],
    ['requests.issue', 'rpc_requests_issue'],
    ['requests.append', 'rpc_requests_append'],
    ['requests.detach', 'rpc_requests_detach'],
    ['requests.get', 'rpc_requests_get'],
    ['requests.list', 'rpc_requests_list'],
    ['receipts.add', 'rpc_receipts_add'],
    ['receipts.list', 'rpc_receipts_list'],
    ['receipts.delete', 'rpc_receipts_delete'],
    ['catalog.save', 'rpc_catalog_save'],
    ['catalog.delete', 'rpc_catalog_delete'],
    ['signers.seed', 'rpc_signers_seed'],
    ['data.purge', 'rpc_data_purge'],
    ['users.list', 'rpc_users_list'],
    ['audit.list', 'rpc_audit_list'],
    ['export.all', 'rpc_export_all'],
    ['backup.run', 'rpc_backup_run'],
  ];
  assert.equal(expectedRpcMap.length, 23);

  for (const [action, rpcName] of expectedRpcMap) {
    const out = await sandbox.Api.call(action, { check: action });
    assert.equal(out.rpcOk, rpcName);
    assert.deepEqual(fromVm(out.echoed), { check: action });
  }
  assert.deepEqual(fake.calls.rpc.map((c) => c.fnName), expectedRpcMap.map((x) => x[1]));
});

test('Giải mã lỗi PL/pgSQL P0001 chuẩn & xóa trắng IndexedDB ngay lập tức khi tài khoản bị khóa / hết hạn JWT', async () => {
  let nextRpcResponse = null;
  const fake = makeFakeSupabase({
    onRpc: async () => nextRpcResponse,
  });
  const { sandbox, indexedDB, location } = createBrowserEnv({
    pathname: '/lines.html',
    search: '?filter=1',
    supabase: fake.supabaseGlobal,
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: 'https://demo-project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key-123',
    },
  });

  await sandbox.Api.saveLogin({
    token: 'jwt-active',
    refresh_token: 'rt-active',
    user: { username: 'nam', role: 'user' },
  });
  indexedDB.stores.set('kv', new Map([
    ['boot:nam', { user: { username: 'nam' } }],
    ['lines:nam', { objs: [{ id: 99, name: 'Dữ liệu nhạy cảm trong cache' }] }],
  ]));

  // Lỗi nghiệp vụ P0001 (vd: MIXED): giữ nguyên phiên và cache, ném đúng code + details
  nextRpcResponse = {
    data: null,
    status: 400,
    error: {
      code: 'P0001',
      message: 'Các dòng đang chọn thuộc nhiều hạng mục khác nhau.',
      details: JSON.stringify({ code: 'MIXED', details: { projects: ['MS027', 'MS028'] } }),
    },
  };
  await assert.rejects(
    () => sandbox.Api.call('requests.issue', { line_ids: [1, 2] }),
    (err) => {
      assert.equal(err.code, 'MIXED');
      assert.deepEqual(err.details, { projects: ['MS027', 'MS028'] });
      assert.match(err.message, /nhiều hạng mục/);
      return true;
    },
  );
  assert.equal(sandbox.Api.token(), 'jwt-active');
  assert.equal(indexedDB.stores.get('kv').size, 2);

  // Lỗi xác thực / khóa tài khoản (P0001 AUTH, PGRST301, 401, user_banned...): xóa sạch IndexedDB + chuyển về đăng nhập
  for (const authFailure of [
    { status: 400, error: { code: 'P0001', message: 'Tài khoản đã bị khóa.', details: '{"code":"AUTH"}' } },
    { status: 401, error: { code: 'PGRST301', message: 'JWT expired', details: null } },
    { status: 403, error: { code: '42501', message: 'user_banned', details: null } },
  ]) {
    await sandbox.Api.saveLogin({
      token: 'jwt-active',
      refresh_token: 'rt-active',
      user: { username: 'nam', role: 'user' },
    });
    indexedDB.stores.set('kv', new Map([['lines:nam', { objs: [{ id: 99 }] }]]));
    location.href = '/lines.html?filter=1';
    nextRpcResponse = { data: null, ...authFailure };

    await assert.rejects(
      () => sandbox.Api.call('lines.sync', {}),
      (err) => err.code === 'AUTH',
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sandbox.Api.token(), null);
    assert.equal(sandbox.Api.user(), null);
    assert.equal(indexedDB.stores.get('kv').size, 0, 'IndexedDB phải bị xóa trắng ngay khi bị khóa tài khoản');
    assert.match(location.href, /^index\.html\?next=/);
  }
});

test('Bản UMD supabase.min.js và 7 trang HTML nhúng đúng thứ tự script', () => {
  const vendorPath = path.join(DOCS, 'js', 'vendor', 'supabase.min.js');
  const nodeModulePath = path.join(ROOT, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
  assert.equal(fs.existsSync(vendorPath), true, 'Thiếu docs/js/vendor/supabase.min.js');
  assert.equal(fs.readFileSync(vendorPath).equals(fs.readFileSync(nodeModulePath)), true, 'supabase.min.js phải khớp nguyên bản UMD');

  const htmlFiles = ['index.html', 'lines.html', 'receive.html', 'project.html', 'requests.html', 'admin.html', 'print.html'];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(DOCS, file), 'utf8');
    const supaIdx = html.indexOf('js/vendor/supabase.min.js');
    const appIdx = html.indexOf('js/app.js');
    assert.ok(supaIdx > 0, `${file} chưa nhúng js/vendor/supabase.min.js`);
    assert.ok(appIdx > supaIdx, `${file} phải nhúng supabase.min.js trước js/app.js`);
    assert.match(html, /js\/vendor\/supabase\.min\.js\?v=[\w]+/, `${file} chưa gắn mã phiên bản stamp cho supabase.min.js`);
    assert.match(html, /js\/app\.js\?v=[\w]+/, `${file} chưa được gắn mã phiên bản stamp`);
  }
});

test('admin.html ở chế độ Supabase hiển thị sao lưu 2 lớp và tự tải Excel trước khi data.purge', async () => {
  const adminHtml = fs.readFileSync(path.join(DOCS, 'admin.html'), 'utf8');
  assert.match(adminHtml, /Sao lưu 2 lớp: bản chụp nguyên tử lưu trực tiếp trên cơ sở dữ liệu \(giữ 30 bản gần nhất\) \+ tải file Excel toàn bộ 12 bảng về máy tính/);

  const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch, 'Không tìm thấy inline script của admin.html');

  const { sandbox } = createBrowserEnv({
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: 'https://demo.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
    },
  });

  const callOrder = [];
  sandbox.Logic.todayIso = () => '2026-10-26';
  sandbox.Api.call = async (action, params) => {
    callOrder.push({ type: 'api', action, params });
    if (action === 'export.all') {
      return {
        lines: [{ id: 1, name: 'Bulong M12' }],
        requests: [{ id: 1, code: 'YC2026-295', header_json: { unit: 'PX1' } }],
      };
    }
    if (action === 'data.purge') {
      return { backup: 'snapshot-2026-10-26', deleted_lines: 5 };
    }
    throw new Error('Unexpected action ' + action);
  };
  sandbox.App.exportExcel = (fileName, sheets) => {
    callOrder.push({ type: 'excel', fileName, sheetNames: sheets.map((s) => s.name) });
  };

  vm.runInContext(scriptMatch[1], sandbox, { filename: 'admin-inline.js' });
  const page = sandbox.adminPage();
  page.purge.before = '2025-01-01';
  page.purge.preview = { before: '2025-01-01', lines: 5, requests: 2, receipts: 3, lines_left: 100, requests_left: 20 };

  await page.purgeRun();

  assert.equal(callOrder.length, 3);
  assert.deepEqual(fromVm(callOrder[0]), { type: 'api', action: 'export.all' });
  assert.deepEqual(fromVm(callOrder[1]), {
    type: 'excel',
    fileName: 'ncvt-truoc-khi-xoa-2026-10-26.xlsx',
    sheetNames: ['lines', 'requests'],
  });
  assert.deepEqual(fromVm(callOrder[2]), {
    type: 'api',
    action: 'data.purge',
    params: { before: '2025-01-01', confirm: true },
  });

  // Nếu tải sao lưu Excel bị lỗi mạng thì TUYỆT ĐỐI không được gọi data.purge xóa dữ liệu!
  const failOrder = [];
  sandbox.Api.call = async (action) => {
    failOrder.push(action);
    if (action === 'export.all') throw new Error('Mất kết nối khi tải bản sao lưu');
    return {};
  };
  page.purge.preview = { before: '2025-01-01', lines: 5, requests: 2, receipts: 3, lines_left: 100, requests_left: 20 };
  await page.purgeRun();
  assert.deepEqual(failOrder, ['export.all'], 'Không được xóa dữ liệu khi chưa tải xong file Excel sao lưu');
});

test('project.html và lines.js chuẩn hóa mã hạng mục ^[Mm][Ss]\\d+$ không phân biệt hoa/thường', async () => {
  const projectHtml = fs.readFileSync(path.join(DOCS, 'project.html'), 'utf8');
  const scriptMatch = projectHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch, 'Không tìm thấy inline script của project.html');

  const { sandbox, runScript } = createBrowserEnv({
    pathname: '/project.html',
    search: '?hm=ms027',
  });
  let tableRows = [];
  sandbox.Tabulator = function () {
    return { setData(rows) { tableRows = rows; }, getData: () => tableRows };
  };
  sandbox.App.init = async () => ({
    today: '2026-10-26',
    user: { username: 'nam', full_name: 'Nam', role: 'user' },
    catalogs: {
      project_items: [{ item_code: 'MS027', item_name: 'Cải tiến máy cắt' }],
      units: [], material_groups: [], uoms: [], suppliers: [],
    },
  });
  sandbox.App.loadLines = async () => ({
    objects: [
      { id: 1, request_code: 'YC2026-001', name: 'Thép', qty_requested: 2, qty_received: 2, unit_price: 100, project_code: 'MS027', project_name: 'Cải tiến máy cắt' },
      { id: 2, request_code: 'YC2026-002', name: 'Ốc', qty_requested: 3, qty_received: 0, unit_price: 50, project_code: 'Ms027', project_name: 'Cải tiến máy cắt' },
      { id: 3, request_code: 'YC2026-003', name: 'Đai ốc', qty_requested: 5, qty_received: 1, unit_price: 20, project_code: 'ms027', project_name: '' },
    ],
  });

  runScript('js/lines.js');
  vm.runInContext(scriptMatch[1], sandbox, { filename: 'project-inline.js' });
  const pPage = sandbox.projectPage();
  await pPage.init();

  assert.equal(pPage.projects.length, 1, 'Ms027 / ms027 / MS027 không được tách thành nhiều hạng mục');
  assert.equal(pPage.projects[0].key, 'MS027');
  assert.equal(tableRows.length, 3);
  assert.equal(pPage.s.count, 3);

  // Kiểm tra lines.js tra cứu projectByCode không phân biệt hoa/thường khi gõ tay 'ms027'
  let capturedCellEdited = null;
  sandbox.Tabulator = function () {
    return {
      on(ev, fn) {
        if (ev === 'cellEdited') capturedCellEdited = fn;
        if (ev === 'tableBuilt') setTimeout(fn, 0);
      },
      setData: async () => {},
      getData: () => [],
      getDataCount: () => 0,
      getSelectedRows: () => [],
      getColumns: () => [],
      setFilter() {},
      redraw() {},
      blockRedraw() {},
      restoreRedraw() {},
    };
  };
  sandbox.document.getElementById = () => ({
    addEventListener() {},
    setAttribute() {},
  });
  sandbox.App.prefetchRecent = () => {};
  sandbox.App.loadLines = async () => ({ objects: [], diff: null });
  const lPage = sandbox.linesPage();
  await lPage.init();

  const rowData = { _key: 'n1', id: 10, project_code: 'ms027', project_name: '', qty_requested: 1 };
  capturedCellEdited({
    getField: () => 'project_code',
    getRow: () => ({
      getData: () => rowData,
      update: (patch) => Object.assign(rowData, patch),
      reformat() {},
    }),
  });
  assert.equal(rowData.project_code, 'MS027');
  assert.equal(rowData.project_name, 'Cải tiến máy cắt');
});

test('Tích hợp thật với bản UMD docs/js/vendor/supabase.min.js qua Api.call RPC', async () => {
  const rpcCaptures = [];
  const { sandbox } = createBrowserEnv({
    fetch: async (url, init) => {
      const u = String(url);
      rpcCaptures.push({ url: u, method: init && init.method });
      const makeHeaders = () => ({ get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) });
      if (u.includes('/rest/v1/rpc/rpc_bootstrap')) {
        const body = JSON.stringify({ user: { username: 'admin', role: 'admin' }, catalogs: {} });
        return { status: 200, statusText: 'OK', ok: true, headers: makeHeaders(), text: async () => body, json: async () => JSON.parse(body) };
      }
      const empty = JSON.stringify({});
      return { status: 200, statusText: 'OK', ok: true, headers: makeHeaders(), text: async () => empty, json: async () => ({}) };
    },
  });
  // Nạp file UMD thật từ docs/js/vendor/supabase.min.js
  const umdCode = fs.readFileSync(path.join(DOCS, 'js', 'vendor', 'supabase.min.js'), 'utf8');
  vm.runInContext(umdCode, sandbox, { filename: 'js/vendor/supabase.min.js' });
  assert.equal(typeof sandbox.supabase.createClient, 'function');

  Object.assign(sandbox.APP_CONFIG, {
    BACKEND_MODE: 'supabase',
    SUPABASE_URL: 'https://real-umd-check.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig',
  });

  const data = await sandbox.Api.call('bootstrap', { ping: 1 });
  assert.equal(data.user.username, 'admin');
  assert.ok(rpcCaptures.some((c) => c.url === 'https://real-umd-check.supabase.co/rest/v1/rpc/rpc_bootstrap' && c.method === 'POST'));
});

test('Apps Script MAINTENANCE_MODE chặn tuyệt đối thao tác ghi nhưng vẫn cho phép đọc và export.all đối soát', () => {
  const b = createBackend(null);
  assert.equal(vm.runInContext('CONFIG.MAINTENANCE_MODE', b.context), false);

  const { adminPassword } = b.setup();
  const adminToken = b.call('login', { username: 'admin', password: adminPassword }).token;
  b.call('lines.save', { lines: [{ key: 'k1', name: 'Vật tư trước Cutover', qty_requested: 2 }] }, adminToken);

  // Bật cầu dao bảo trì chống Split-Brain ngày Cutover
  vm.runInContext('CONFIG.MAINTENANCE_MODE = true', b.context);

  // Đọc / đăng nhập / xuất đối soát vẫn hoạt động bình thường
  const loginAgain = b.call('login', { username: 'admin', password: adminPassword });
  assert.ok(loginAgain.token);
  assert.equal(b.call('lines.list', {}, adminToken).rows.length, 1);
  const exported = b.call('export.all', {}, adminToken);
  assert.equal(exported.lines.length, 1);

  // Mọi thao tác ghi đều bị chặn với mã MAINTENANCE
  for (const [act, params] of [
    ['lines.save', { lines: [{ key: 'k2', name: 'Ghi nhầm tab cũ', qty_requested: 1 }] }],
    ['requests.issue', { line_ids: [1] }],
    ['receipts.add', { line_id: 1, qty: 1 }],
    ['catalog.save', { table: 'units', row: { name: 'Đơn vị mới' } }],
    ['data.purge', { before: '2025-01-01', confirm: true }],
  ]) {
    assert.throws(
      () => b.call(act, params, adminToken),
      (err) => {
        assert.equal(err.code, 'MAINTENANCE');
        assert.equal(err.message, 'Hệ thống đã nâng cấp sang máy chủ mới. Vui lòng bấm Ctrl+F5 để tải lại trang.');
        return true;
      },
    );
  }
});

test('Workflow supabase-keepalive.yml an toàn cho repo Public và supabase/README.md đủ hướng dẫn Cutover/Rollback', () => {
  const wfPath = path.join(ROOT, '.github', 'workflows', 'supabase-keepalive.yml');
  assert.equal(fs.existsSync(wfPath), true, 'Thiếu .github/workflows/supabase-keepalive.yml');
  const wf = fs.readFileSync(wfPath, 'utf8');
  assert.match(wf, /0 \*\/12 \* \* \*/);
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /vars\.SUPABASE_URL/);
  assert.match(wf, /vars\.SUPABASE_ANON_KEY/);
  assert.match(wf, /\/rest\/v1\/rpc\/healthcheck/);
  assert.doesNotMatch(wf, /pg_dump/i, 'Tuyệt đối không chạy pg_dump trên repo Public');
  assert.doesNotMatch(wf, /upload-artifact/i, 'Tuyệt đối không upload artifact dữ liệu trên repo Public');

  const readmePath = path.join(ROOT, 'supabase', 'README.md');
  assert.equal(fs.existsSync(readmePath), true, 'Thiếu supabase/README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert.match(readme, /Singapore/i);
  assert.match(readme, /001_schema_rls_rpc\.sql/);
  assert.match(readme, /admin-ops/);
  assert.match(readme, /cron-job\.org/i);
  assert.match(readme, /pg_dump/);
  assert.match(readme, /Rollback/i);
  assert.match(readme, /Allow new users to sign up/i);
});

test('[SEC-01] Api.logout() xóa đồng bộ ngay lập tức khóa ncvt_sb_auth trước khi chuyển trang', () => {
  const fake = makeFakeSupabase();
  const { sandbox, localStorage } = createBrowserEnv({
    supabase: fake.supabaseGlobal,
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: 'https://demo-project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public-key',
    },
  });

  localStorage.setItem('ncvt_token', 'jwt-secret');
  localStorage.setItem('ncvt_user', '{"username":"nam"}');
  localStorage.setItem('ncvt_refresh', 'refresh-secret');
  localStorage.setItem('ncvt_sb_auth', '{"access_token":"secret","refresh_token":"refresh-secret"}');

  // Gọi đồng bộ KHÔNG await (y hệt onclick Đăng xuất trước khi gán location.href = 'index.html')
  sandbox.Api.logout();

  assert.equal(localStorage.getItem('ncvt_sb_auth'), null, 'ncvt_sb_auth phải bị xóa đồng bộ ngay lập tức');
  assert.equal(localStorage.getItem('ncvt_token'), null);
  assert.equal(localStorage.getItem('ncvt_user'), null);
  assert.equal(localStorage.getItem('ncvt_refresh'), null);
});

test('[BLOCKER #3] auth.changePassword tự động lưu token + session mới trên Supabase và tương thích ngược với GAS', async () => {
  const fake = makeFakeSupabase();
  let edgeReply = {
    changed: true,
    token: 'new.jwt.tok',
    access_token: 'new.jwt.tok',
    refresh_token: 'new-ref',
    session: { access_token: 'new.jwt.tok', refresh_token: 'new-ref' },
  };
  const { sandbox, localStorage } = createBrowserEnv({
    supabase: fake.supabaseGlobal,
    appConfig: {
      BACKEND_MODE: 'supabase',
      SUPABASE_URL: 'https://demo-project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-public-key',
    },
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, data: edgeReply }),
    }),
  });

  await sandbox.Api.saveLogin({
    token: 'old.jwt.tok',
    refresh_token: 'old-ref',
    user: { username: 'nam', full_name: 'Nguyễn Nam', role: 'user' },
  });
  assert.equal(sandbox.Api.token(), 'old.jwt.tok');

  // Đổi mật khẩu qua App.changePassword()
  sandbox.App.askPasswords = async () => ({ old: 'matkhaucu', new: 'matkhaumoi123', again: 'matkhaumoi123' });
  await sandbox.App.changePassword();

  assert.equal(sandbox.Api.token(), 'new.jwt.tok', 'Phải cập nhật token mới sau khi đổi mật khẩu trên Supabase');
  assert.equal(localStorage.getItem('ncvt_refresh'), 'new-ref');
  assert.equal(sandbox.Api.user().username, 'nam', 'Giữ nguyên thông tin user đang đăng nhập');
  assert.deepEqual(fromVm(fake.calls.setSession[fake.calls.setSession.length - 1]), {
    access_token: 'new.jwt.tok',
    refresh_token: 'new-ref',
  });

  // Trường hợp phản hồi chỉ đặt token bên trong object session
  edgeReply = {
    changed: true,
    session: { access_token: 'nested.jwt.tok', refresh_token: 'nested-ref' },
  };
  await sandbox.Api.call('auth.changePassword', { old_password: 'x', new_password: 'y' });
  assert.equal(sandbox.Api.token(), 'nested.jwt.tok');
  assert.deepEqual(fromVm(fake.calls.setSession[fake.calls.setSession.length - 1]), {
    access_token: 'nested.jwt.tok',
    refresh_token: 'nested-ref',
  });

  // Tương thích ngược với GAS (chỉ trả { changed: true }, không có token mới → giữ nguyên token hiện tại)
  const gasEnv = createBrowserEnv({
    appConfig: { BACKEND_MODE: 'gas' },
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, data: { changed: true } }),
    }),
  });
  gasEnv.sandbox.Api.saveLogin({ token: 'gas-session-tok', user: { username: 'nam', role: 'user' } });
  await gasEnv.sandbox.Api.call('auth.changePassword', { old_password: 'a', new_password: 'b' });
  assert.equal(gasEnv.sandbox.Api.token(), 'gas-session-tok');
  assert.equal(gasEnv.sandbox.Api.user().username, 'nam');
});

test('Đề nghị thanh toán: 10 action payments/payreq đi đúng RPC ở Supabase, báo lỗi thân thiện ở chế độ gas', async () => {
  const fake = makeFakeSupabase();
  const { sandbox, fetchCalls } = createBrowserEnv({
    supabase: fake.supabaseGlobal,
    appConfig: { BACKEND_MODE: 'supabase', SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_ANON_KEY: 'anon-key' },
  });
  await sandbox.Api.saveLogin({ token: 'jwt', refresh_token: 'rt', user: { username: 'nam', role: 'user' } });
  const map = [
    ['payments.list', 'rpc_payments_list'], ['payments.create', 'rpc_payments_create'],
    ['payments.save', 'rpc_payments_save'], ['payments.delete', 'rpc_payments_delete'],
    ['payreq.issue', 'rpc_payreq_issue'], ['payreq.append', 'rpc_payreq_append'],
    ['payreq.detach', 'rpc_payreq_detach'], ['payreq.list', 'rpc_payreq_list'],
    ['payreq.get', 'rpc_payreq_get'], ['payreq.setPaid', 'rpc_payreq_set_paid'],
  ];
  for (const [action, rpcName] of map) {
    const out = await sandbox.Api.call(action, { check: action });
    assert.equal(out.rpcOk, rpcName);
    assert.deepEqual(fromVm(out.echoed), { check: action });
  }

  sandbox.APP_CONFIG.BACKEND_MODE = 'gas';
  const before = fetchCalls.length;
  await assert.rejects(() => sandbox.Api.call('payments.list', {}), (e) => {
    assert.equal(e.message, 'Tính năng Đề nghị thanh toán chỉ hỗ trợ bản Supabase');
    assert.equal(e.code, 'UNSUPPORTED');
    return true;
  });
  await assert.rejects(() => sandbox.Api.call('payreq.get', { codes: ['DN2026-016'] }), /chỉ hỗ trợ bản Supabase/);
  assert.equal(fetchCalls.length, before, 'Không được gửi yêu cầu Đề nghị thanh toán tới Apps Script');

  const html = fs.readFileSync(path.join(DOCS, 'payments.html'), 'utf8');
  assert.ok(html.indexOf('js/vendor/supabase.min.js') > 0 && html.indexOf('js/app.js') > html.indexOf('js/vendor/supabase.min.js'));
  assert.match(html, /js\/payments\.js\?v=[\w]+/);
});

// ---------- Bảng vật tư: nút thao tác ở đầu mỗi dòng, nhấp đúp mở form, thanh chọn nhiều dòng ----------

async function setupLinesPage(rowsData, { selected = [], confirmResult = true, load = false } = {}) {
  const { sandbox, runScript } = createBrowserEnv({ pathname: '/lines.html' });
  const handlers = {};
  const calls = [];
  let config = null;
  let tableFilter = null;
  const rows = rowsData.map((data) => ({
    data,
    deleted: false,
    getData() { return data; },
    update(patch) { Object.assign(data, patch); },
    reformat() {},
    deselect() {},
    delete() { this.deleted = true; },
    getElement: () => ({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false } }),
    getCell: () => null,
  }));
  const byKey = (k) => rows.find((r) => r.data._key === k);
  sandbox.Tabulator = function (_sel, cfg) {
    config = cfg;
    return {
      on(ev, fn) { handlers[ev] = fn; if (ev === 'tableBuilt') setTimeout(fn, 0); },
      setData: async () => {}, addData: async () => {}, setFilter(fn) { tableFilter = fn; }, refreshFilter() {}, redraw() {}, blockRedraw() {}, restoreRedraw() {},
      getData: () => rows.map((r) => r.data),
      getDataCount: () => rows.length,
      getSelectedRows: () => selected.map(byKey),
      getRow: byKey,
      getColumns: () => ['unit', 'name'].map((f) => ({ getField: () => f, isVisible: () => true, getDefinition: () => ({ title: f }), setWidth() {} })),
      getRows: () => rows,
      deselectRow() { calls.push({ deselectAll: true }); },
      scrollToRow: async () => {},
    };
  };
  sandbox.document.getElementById = () => ({ addEventListener(ev, fn) { handlers['dom_' + ev] = fn; }, setAttribute() {}, focus() {} });
  sandbox.window.open = () => null;
  sandbox.App.openPrintWindow = () => null;
  sandbox.App.printUrl = (codes) => 'print.html?codes=' + codes.join(',');
  const confirms = [];
  sandbox.confirm = (msg) => { confirms.push(msg); return confirmResult; };
  sandbox.App.prefetchRecent = () => {};
  const boot = {
    today: '2026-10-26', users: [],
    user: { username: 'nam', full_name: 'Nam', role: 'user' },
    catalogs: { project_items: [], units: [{ name: 'PX1' }], material_groups: [], uoms: [], suppliers: [] },
  };
  sandbox.App.init = async () => { sandbox.App.boot = boot; sandbox.App.user = boot.user; return boot; };
  sandbox.App.loadLines = async () => ({ objects: load ? rowsData.map((d) => Object.assign({}, d)) : [], diff: null });
  sandbox.App.toast = (msg, kind) => calls.push({ toast: msg, kind });
  sandbox.Api.call = async (action, params) => { calls.push({ action, params }); return action === 'lines.delete' ? {} : []; };
  runScript('js/lines.js');
  const page = sandbox.linesPage();
  await page.init();
  return { page, config, handlers, calls, rows, confirms, sandbox, filterFn: tableFilter, fromVm };
}

test('Bảng vật tư: cột thao tác ✎ ⧉ 🗑 ở đầu dòng; 🗑 xóa đúng dòng đó mà không cần tick', async () => {
  const t = await setupLinesPage([
    { _key: 'i1', id: 1, name: 'Bulong' }, { _key: 'i2', id: 2, name: 'Đai ốc' },
  ]);
  const act = t.config.columns.find((c) => c.field === '_act');
  assert.ok(act, 'phải có cột thao tác _act');
  const html = act.formatter();
  ['edit', 'dup', 'del'].forEach((a) => assert.ok(html.includes('data-a="' + a + '"'), 'thiếu nút ' + a));

  const clickAction = (a, row) => act.cellClick(
    { target: { closest: () => ({ getAttribute: () => a }) } },
    { getRow: () => row },
  );
  clickAction('del', t.rows[1]);
  await new Promise((r) => setTimeout(r, 20));
  const del = t.calls.find((c) => c.action === 'lines.delete');
  assert.ok(del, 'phải gọi lines.delete');
  assert.deepEqual(fromVm(del.params.ids), [2]);
  assert.equal(t.rows[1].deleted, true);
  assert.equal(t.rows[0].deleted, false);
});

test('Bảng vật tư: ✎ và nhấp đúp ô không sửa trực tiếp được mở form sửa dòng đó (không cần tick)', async () => {
  const t = await setupLinesPage([{ _key: 'i7', id: 7, name: 'Thép', qty_requested: 3, unit: 'PX1' }]);
  const act = t.config.columns.find((c) => c.field === '_act');
  act.cellClick({ target: { closest: () => ({ getAttribute: () => 'edit' }) } }, { getRow: () => t.rows[0] });
  assert.equal(t.page.ef.open, true);
  assert.equal(t.page.ef.id, 7);
  assert.equal(t.page.ef.d.name, 'Thép');

  t.page.ef.open = false;
  const cellFor = (field, editor) => ({
    getField: () => field,
    getRow: () => t.rows[0],
    getColumn: () => ({ getDefinition: () => ({ editor }) }),
    getElement: () => ({ classList: { contains: () => false } }),
  });
  t.handlers.cellDblClick({}, cellFor('amount', undefined)); // ô không sửa được → mở form
  assert.equal(t.page.ef.open, true);
  t.page.ef.open = false;
  t.handlers.cellDblClick({}, cellFor('name', 'list')); // ô đang sửa trực tiếp → không mở form
  assert.equal(t.page.ef.open, false);
});

test('Bảng vật tư: form sửa có nút Xóa dòng này; số dòng đang tick được theo dõi cho thanh thao tác nổi', async () => {
  const t = await setupLinesPage([
    { _key: 'i1', id: 1, name: 'A', unit: 'PX1' }, { _key: 'i2', id: 2, name: 'B', unit: 'PX1' },
  ], { selected: ['i1', 'i2'] });
  assert.equal(typeof t.page.deleteFromEdit, 'function');
  t.page.openEdit(t.rows[0]);
  t.page.deleteFromEdit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.page.ef.open, false);
  assert.deepEqual(fromVm(t.calls.find((c) => c.action === 'lines.delete').params.ids), [1]);

  t.handlers.rowSelectionChanged();
  assert.equal(t.page.sel, 2);
  t.page.deselectAll();
  assert.ok(t.calls.some((c) => c.deselectAll));
});

// ---------- Đơn vị đề xuất: chỉ 2 phòng ban, người ký đổi theo phòng ban ----------

const LogicNode = require('../docs/js/logic.js');
const PRINT_M = (() => { const sb = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(DOCS, 'js', 'print_mapping.js'), 'utf8'), sb); return sb.window.PRINT_MAPPING; })();
const SEED_SIGNERS = [
  { id: 1, unit_contains: '', position: '1', title: 'Người lập phiếu', name: '' },
  { id: 2, unit_contains: '', position: '2', title: 'Người xem xét', name: 'Vũ Văn Trường' },
  { id: 3, unit_contains: '', position: '3', title: 'T.P Thiết bị', name: 'Vũ Văn Trường' },
  { id: 4, unit_contains: '', position: '4', title: 'Giám đốc duyệt', name: 'Phạm Danh Mạnh' },
  { id: 5, unit_contains: 'Cải tiến', position: '1', title: 'Người lập phiếu', name: '' },
  { id: 6, unit_contains: 'Cải tiến', position: '2', title: 'Người xem xét', name: 'Trần Việt Tiệp' },
  { id: 7, unit_contains: 'Cải tiến', position: '3', title: 'T.P Cải tiến', name: 'Trần Việt Tiệp' },
  { id: 8, unit_contains: 'Cải tiến', position: '4', title: 'Giám đốc duyệt', name: 'Phạm Danh Mạnh' },
];
const signCtx = (signers) => ({ mapping: PRINT_M.phieu_de_nghi, signers, aliases: PRINT_M.name_aliases });
const signAt = (list, pos) => list[pos - 1];

test('Logic.normalizeUnit: gộp tên cũ về 2 phòng chuẩn, tên khác trả null', () => {
  assert.deepEqual(fromVm(LogicNode.UNITS), ['Phòng Cải tiến', 'Phòng Thiết bị']);
  ['P.Cải tiến', 'P.CT', 'phòng cải tiến', 'P. Cải  tiến', 'Phong Cai Tien', 'Phòng Cải tiến'].forEach((v) => assert.equal(LogicNode.normalizeUnit(v), 'Phòng Cải tiến', v));
  ['P.TB', 'P. Thiết bị', 'Phòng Thiết bị', 'phong tb', ' P.Thiết bị '].forEach((v) => assert.equal(LogicNode.normalizeUnit(v), 'Phòng Thiết bị', v));
  ['Xưởng Cơ khí', 'Xưởng sửa chữa thiết bị', '', null, undefined, 'Phòng Kế toán', 'Phòng Cải tiến 2'].forEach((v) => assert.equal(LogicNode.normalizeUnit(v), null, String(v)));
});

test('Logic.signaturesFor: đổi phòng ban thì người ký đổi đúng, tên cũ và mới cho cùng bộ ký', () => {
  const ctx = signCtx(SEED_SIGNERS);
  ['Phòng Cải tiến', 'P.Cải tiến', 'P.CT'].forEach((u) => {
    const l = LogicNode.signaturesFor(u, 'Nam', ctx);
    assert.equal(l.length, 4, u);
    assert.equal(signAt(l, 1).name, 'Phan Thành Nam', u + ' vị trí 1 = tên người yêu cầu (đổi tên đầy đủ)');
    assert.equal(signAt(l, 2).name, 'Trần Việt Tiệp', u);
    assert.equal(signAt(l, 3).title, 'T.P Cải tiến', u);
    assert.equal(signAt(l, 3).name, 'Trần Việt Tiệp', u);
    assert.equal(signAt(l, 4).name, 'Phạm Danh Mạnh', u);
  });
  ['Phòng Thiết bị', 'P.TB', 'P. Thiết bị'].forEach((u) => {
    const l = LogicNode.signaturesFor(u, 'Nguyễn Văn A', ctx);
    assert.equal(signAt(l, 1).name, 'Nguyễn Văn A', u);
    assert.equal(signAt(l, 2).name, 'Vũ Văn Trường', u);
    assert.equal(signAt(l, 3).title, 'T.P Thiết bị', u);
    assert.equal(signAt(l, 3).name, 'Vũ Văn Trường', u);
    assert.equal(signAt(l, 4).name, 'Phạm Danh Mạnh', u);
  });
  // đổi qua lại: không sót tiêu đề / tên của phòng cũ
  const ct = LogicNode.signaturesFor('Phòng Cải tiến', 'A', ctx);
  const tb = LogicNode.signaturesFor('Phòng Thiết bị', 'A', ctx);
  assert.ok(!tb.some((s) => /Cải tiến|Tiệp/.test(s.title + s.name)), 'bộ Thiết bị không chứa Cải tiến/Tiệp');
  assert.ok(!ct.some((s) => /Thiết bị|Trường/.test(s.title + s.name)), 'bộ Cải tiến không chứa Thiết bị/Trường');
  assert.notDeepEqual(fromVm(ct), fromVm(tb));
});

test('Logic.signaturesFor: phòng chỉ khai 1 vị trí thì các vị trí còn lại kế thừa bộ mặc định; danh mục rỗng dùng print_mapping', () => {
  const partial = SEED_SIGNERS.slice(0, 4).concat([{ id: 9, unit_contains: 'Cải tiến', position: '3', title: 'T.P Cải tiến', name: 'Trần Việt Tiệp' }]);
  const l = LogicNode.signaturesFor('P.Cải tiến', 'Nam', signCtx(partial));
  assert.equal(signAt(l, 1).name, 'Phan Thành Nam');
  assert.equal(signAt(l, 2).name, 'Vũ Văn Trường');
  assert.equal(signAt(l, 3).title + '|' + signAt(l, 3).name, 'T.P Cải tiến|Trần Việt Tiệp');
  assert.equal(signAt(l, 4).name, 'Phạm Danh Mạnh');

  const fb = LogicNode.signaturesFor('P.Cải tiến', 'Nam', signCtx([]));
  assert.equal(signAt(fb, 3).title, 'T.P Cải tiến');
  assert.equal(signAt(fb, 2).name, 'Trần Việt Tiệp');
  const fb2 = LogicNode.signaturesFor('Phòng Thiết bị', 'Nam', signCtx(undefined));
  assert.equal(signAt(fb2, 3).title, 'T.P Thiết bị');
  assert.equal(signAt(fb2, 1).name, 'Phan Thành Nam');
});

test('print.html: gọi Logic.signaturesFor, gộp đơn vị theo normalizeUnit và nạp logic.js trước script inline', () => {
  const html = fs.readFileSync(path.join(DOCS, 'print.html'), 'utf8');
  assert.match(html, /Logic\.signaturesFor\(/);
  assert.match(html, /Logic\.normalizeUnit\(/);
  assert.ok(!/const matchUnitKey|const signerSets/.test(html), 'logic ký đã chuyển sang logic.js');
  const logicIdx = html.indexOf('js/logic.js');
  const inlineIdx = html.indexOf('<script>');
  assert.ok(logicIdx > 0 && inlineIdx > logicIdx, 'logic.js phải nạp trước script inline');
});

test('lines.html: Đơn vị đề xuất ở form thêm / sửa là select bắt buộc', () => {
  const html = fs.readFileSync(path.join(DOCS, 'lines.html'), 'utf8');
  assert.match(html, /<select id="fm-unit"[^>]*required/);
  assert.match(html, /<select id="ef-unit"[^>]*required/);
  assert.ok(!html.includes('dl-unit'));
});

const unitCol = (t) => t.config.columns.find((c) => c.field === 'unit');
const hasToast = (t, re) => t.calls.some((c) => c.toast && re.test(c.toast));

test('Bảng vật tư: ô Đơn vị chỉ chọn 2 phòng (không gõ tự do, không xóa); giữ tên cũ khi hiển thị', async () => {
  const t = await setupLinesPage([{ _key: 'i1', id: 1, name: 'A', qty_requested: 1, unit: 'P.Cải tiến' }]);
  const col = unitCol(t);
  const p = col.editorParams;
  assert.deepEqual(fromVm(p.values), ['Phòng Cải tiến', 'Phòng Thiết bị']);
  assert.equal(p.freetext, false);
  assert.equal(p.clearable, false);
  assert.equal(p.allowEmpty, false);
  assert.equal(col.mutatorEdit('P.TB'), 'Phòng Thiết bị');
  assert.equal(col.mutatorEdit('linh tinh'), null);
  assert.equal(t.rows[0].data.unit, 'P.Cải tiến');
});

test('Bảng vật tư: ô Đơn vị nhận giá trị lạ thì giữ giá trị cũ, không xóa trắng', async () => {
  const t = await setupLinesPage([{ _key: 'i1', id: 1, name: 'A', qty_requested: 1, unit: 'P.Cải tiến' }]);
  const row = t.rows[0];
  const cell = { getField: () => 'unit', getRow: () => row, getOldValue: () => 'P.Cải tiến', getValue: () => null, setValue(v) { row.data.unit = v; } };
  row.data.unit = null; // mutatorEdit trả null khi gõ giá trị lạ
  t.handlers.cellEdited(cell);
  assert.equal(row.data.unit, 'P.Cải tiến', 'ô không bị xóa trắng');
});

test('Bảng vật tư: bộ lọc Đơn vị gộp tên cũ và mới', async () => {
  const t = await setupLinesPage([
    { _key: 'i1', id: 1, name: 'A', unit: 'P.Cải tiến' }, { _key: 'i2', id: 2, name: 'B', unit: 'Phòng Cải tiến' },
    { _key: 'i3', id: 3, name: 'C', unit: 'P.TB' }, { _key: 'i4', id: 4, name: 'D', unit: 'Xưởng Cơ khí' },
  ], { load: true });
  assert.deepEqual(fromVm(t.page.opts.units), ['Phòng Cải tiến', 'Phòng Thiết bị', 'Xưởng Cơ khí']);
  const filt = t.filterFn;
  assert.equal(typeof filt, 'function');
  const res = (u) => { t.page.f.unit = u; return t.rows.map((r) => !!filt(r.data)); };
  assert.deepEqual(res('Phòng Cải tiến'), [true, true, false, false]);
  assert.deepEqual(res('Phòng Thiết bị'), [false, false, true, false]);
  assert.deepEqual(res('Xưởng Cơ khí'), [false, false, false, true]);
});

test('Bảng vật tư: xuất phiếu chặn unit rỗng / ngoài 2 phòng và phiếu trộn 2 phòng', async () => {
  const run = async (units) => {
    const rows = units.map((u, i) => ({ _key: 'i' + (i + 1), id: i + 1, name: 'V' + i, qty_requested: 1, unit: u }));
    const t = await setupLinesPage(rows, { selected: rows.map((r) => r._key) });
    await t.page.issue();
    return t;
  };
  let t = await run(['']);
  assert.ok(hasToast(t, /Phòng Cải tiến hoặc Phòng Thiết bị/));
  assert.ok(!t.calls.some((c) => c.action === 'requests.issue'));
  t = await run(['Xưởng Cơ khí']);
  assert.ok(hasToast(t, /Phòng Cải tiến hoặc Phòng Thiết bị/));
  t = await run(['P.Cải tiến', 'Phòng Thiết bị']);
  assert.ok(hasToast(t, /Một phiếu chỉ được thuộc 1 phòng ban/));
  assert.ok(!t.calls.some((c) => c.action === 'requests.issue'));
  t = await run(['P.Cải tiến', 'Phòng Cải tiến']); // cùng phòng khác cách viết → hợp lệ
  assert.ok(!hasToast(t, /phòng ban/));
});

test('Bảng vật tư: thêm vào phiếu đã xuất chặn khi khác phòng ban', async () => {
  const mk = () => [
    { _key: 'i1', id: 1, name: 'Cũ', qty_requested: 1, unit: 'P.TB', request_code: 'YC2026-001' },
    { _key: 'i2', id: 2, name: 'Mới', qty_requested: 1, unit: 'Phòng Cải tiến' },
    { _key: 'i3', id: 3, name: 'Mới2', qty_requested: 1, unit: 'Phòng Thiết bị' },
  ];
  let t = await setupLinesPage(mk(), { selected: ['i1', 'i2'] });
  await t.page.issue();
  assert.ok(hasToast(t, /Một phiếu chỉ được thuộc 1 phòng ban/));
  assert.ok(!t.calls.some((c) => c.action === 'requests.append'));
  t = await setupLinesPage(mk(), { selected: ['i3'] });
  t.sandbox.prompt = () => 'YC2026-001';
  await t.page.appendPrompt();
  assert.ok(!hasToast(t, /Một phiếu chỉ được thuộc 1 phòng ban/), 'cùng phòng (P.TB = Phòng Thiết bị) thì cho thêm');
  t = await setupLinesPage(mk(), { selected: ['i2'] });
  t.sandbox.prompt = () => 'YC2026-001';
  await t.page.appendPrompt();
  assert.ok(hasToast(t, /Một phiếu chỉ được thuộc 1 phòng ban/), 'appendPrompt cũng chặn khác phòng');
  assert.ok(!t.calls.some((c) => c.action === 'requests.append'));
});

test('Bảng vật tư: sửa bằng form không ghi đè tên phòng cũ; select hiện "(cũ) …"', async () => {
  const t = await setupLinesPage([{ _key: 'i1', id: 1, name: 'A', qty_requested: 2, unit: 'P.Cải tiến', note: '' }]);
  t.page.openEdit(t.rows[0]);
  assert.equal(t.page.ef.d.unit, 'P.Cải tiến');
  const opts = fromVm(t.page.efUnits());
  assert.ok(opts.some((o) => o.value === 'P.Cải tiến' && o.label === '(cũ) P.Cải tiến'));
  assert.ok(opts.some((o) => o.value === 'Phòng Cải tiến') && opts.some((o) => o.value === 'Phòng Thiết bị'));
  t.page.ef.d.note = 'ghi chú mới';
  t.page.saveEdit();
  assert.equal(t.page.ef.open, false);
  assert.equal(t.rows[0].data.unit, 'P.Cải tiến', 'không bị ghi đè');
  assert.equal(t.rows[0].data.note, 'ghi chú mới');
  const t2 = await setupLinesPage([{ _key: 'i1', id: 1, name: 'A', qty_requested: 2, unit: 'Phòng Cải tiến' }]);
  t2.page.openEdit(t2.rows[0]);
  assert.deepEqual(fromVm(t2.page.efUnits()).map((o) => o.label), ['Phòng Cải tiến', 'Phòng Thiết bị']);
});

test('Bảng vật tư: đổi phòng ban của dòng đã có phiếu phải xác nhận; hủy thì không lưu', async () => {
  const mk = () => [{ _key: 'i1', id: 1, name: 'A', qty_requested: 2, unit: 'P.Cải tiến', request_code: 'YC2026-009' }];
  let t = await setupLinesPage(mk(), { confirmResult: false });
  t.page.openEdit(t.rows[0]);
  t.page.ef.d.unit = 'Phòng Thiết bị';
  t.page.saveEdit();
  assert.equal(t.confirms.length, 1);
  assert.match(t.confirms[0], /YC2026-009/);
  assert.match(t.confirms[0], /người ký/);
  assert.equal(t.rows[0].data.unit, 'P.Cải tiến');
  t = await setupLinesPage(mk(), { confirmResult: true });
  t.page.openEdit(t.rows[0]);
  t.page.ef.d.unit = 'Phòng Thiết bị';
  t.page.saveEdit();
  assert.equal(t.rows[0].data.unit, 'Phòng Thiết bị');
  // cùng phòng nhưng viết khác: không hỏi, không ghi
  t = await setupLinesPage(mk(), { confirmResult: false });
  t.page.openEdit(t.rows[0]);
  t.page.ef.d.unit = 'Phòng Cải tiến';
  t.page.saveEdit();
  assert.equal(t.confirms.length, 0);
  assert.equal(t.rows[0].data.unit, 'P.Cải tiến');
});

test('Bảng vật tư: form thêm bắt buộc phòng ban chuẩn; thêm vào phiếu cũ chép unit đã chuẩn hóa', async () => {
  const t = await setupLinesPage([
    { _key: 'i1', id: 1, name: 'A', unit: 'P.TB', request_code: 'YC2026-001' },
    { _key: 'i2', id: 2, name: 'B', unit: 'Xưởng Cơ khí', request_code: 'YC2026-002' },
  ]);
  t.page.openForm();
  t.page.fm.items[0].name = 'X'; t.page.fm.items[0].qty_requested = '1';
  t.page.fm.c.unit = 'P.TB'; // tên cũ không được nhận ở form thêm
  await t.page.formSubmit(false);
  assert.match(t.page.fm.error, /Phòng Cải tiến hoặc Phòng Thiết bị/);
  assert.ok(!t.calls.some((c) => c.action === 'lines.create'));
  t.page.fm.c.unit = '';
  t.page.fm.c.append_code = 'YC2026-001';
  t.page.formAppendCode();
  assert.equal(t.page.fm.c.unit, 'Phòng Thiết bị');
  t.page.fm.c.unit = '';
  t.page.fm.c.append_code = 'YC2026-002';
  t.page.formAppendCode();
  assert.equal(t.page.fm.c.unit, '');
});

// ---------- Form "Thêm vật tư": gợi ý trên dòng, lưu nháp, phím tắt, dán lưới, cảnh báo trùng ----------

const DRAFT_KEY = (u) => 'ncvt.lines.draft.v1:' + u;
const histRows = () => [
  { _key: 'i1', id: 1, name: 'Bulong M12', uom: 'Bộ', material_group: 'C', unit_price: 5000, qty_requested: 100, qty_received: 60, request_code: 'YC2026-290', project_code: 'MS1', project_name: 'Dự án 1' },
  { _key: 'i2', id: 2, name: 'Đai ốc', uom: 'Cái', qty_requested: 10, qty_received: 10, request_code: 'YC2026-291', project_code: 'MS1', project_name: 'Dự án 1' },
  { _key: 'i3', id: 3, name: 'Bulong M12', uom: 'Bộ', qty_requested: 20, qty_received: 0, request_code: '', project_code: 'MS2', project_name: 'Dự án 2' },
];
const openedForm = async (rows, opts) => {
  const t = await setupLinesPage(rows || histRows(), Object.assign({ load: true }, opts));
  t.page.openForm();
  return t;
};

test('Form thêm: gõ tên khớp lịch sử thì điền ĐVT/nhóm/đơn giá ngay trên dòng, không ghi đè ô đã có', async () => {
  const t = await openedForm();
  const a = t.page.fm.items[0];
  a.name = 'bulong m12';
  t.page.formName(a);
  assert.equal(a.uom, 'Bộ');
  assert.equal(a.material_group, 'C');
  assert.equal(String(a.unit_price), '5000');
  const b = t.page.fm.items[1];
  Object.assign(b, { name: 'Bulong M12', uom: 'Cặp', material_group: 'D', unit_price: '7' });
  t.page.formName(b);
  assert.deepEqual([b.uom, b.material_group, b.unit_price], ['Cặp', 'D', '7']);
  t.page.fm.c.material_group = 'E';
  const c = t.page.fm.items[2];
  c.name = 'Bulong M12';
  t.page.formName(c);
  assert.equal(c.uom, 'Bộ');
  assert.equal(c.material_group, '', 'nhóm chung đã có thì không điền nhóm riêng');
});

test('Nháp: lưu theo username, khôi phục khi mở form, người khác không thấy', async () => {
  const t = await openedForm();
  const ls = t.sandbox.localStorage;
  t.page.fm.c.unit = 'Phòng Thiết bị';
  t.page.fm.c.append_code = 'YC2026-1';
  t.page.fm.items[0].name = 'Ống thép';
  t.page.fm.items[0].qty_requested = '3';
  t.page.draftSave();
  const raw = ls.getItem(DRAFT_KEY('nam'));
  assert.ok(raw, 'phải lưu nháp theo username');
  const saved = JSON.parse(raw);
  assert.equal(saved.items[0].name, 'Ống thép');
  assert.equal(saved.c.append_code, undefined);
  assert.equal(ls.getItem(DRAFT_KEY('khac')), null);

  const t2 = await setupLinesPage(histRows(), { load: true });
  t2.sandbox.localStorage.setItem(DRAFT_KEY('nam'), JSON.stringify({
    c: { unit: 'Kho X', project: 'MS1' }, items: [{ k: 1, name: 'Ống thép', qty_requested: '3' }, { k: 1, name: 'Van', qty_requested: '1' }],
  }));
  t2.page.openForm();
  assert.equal(t2.page.fm.items[0].name, 'Ống thép');
  assert.equal(t2.page.fm.items.length, 2);
  assert.notEqual(t2.page.fm.items[0].k, t2.page.fm.items[1].k, 'khóa k phải duy nhất');
  assert.equal(t2.page.fm.c.unit, '', 'đơn vị cũ không hợp lệ → rỗng');
  assert.equal(t2.page.fm.c.project, 'MS1');
  assert.ok(t2.calls.some((c) => c.toast === 'Đã khôi phục bản nháp'));

  const t3 = await setupLinesPage(histRows(), { load: true });
  t3.sandbox.localStorage.setItem(DRAFT_KEY('nam'), JSON.stringify({ c: {}, items: [{ name: 'Ống thép', qty_requested: '3' }] }));
  t3.sandbox.App.user = { username: 'lan', full_name: 'Lan', role: 'user' };
  t3.page.openForm();
  assert.equal(t3.page.fm.items[0].name, '');
});

test('Nháp: đơn vị chuẩn được giữ; lưu thành công xóa nháp; không lưu nháp rỗng', async () => {
  const t = await setupLinesPage(histRows(), { load: true });
  const ls = t.sandbox.localStorage;
  ls.setItem(DRAFT_KEY('nam'), JSON.stringify({ c: { unit: 'Phòng Cải tiến' }, items: [{ name: 'Van', qty_requested: '1' }] }));
  t.page.openForm();
  assert.equal(t.page.fm.c.unit, 'Phòng Cải tiến');
  t.sandbox.Api.call = async (action) => (action === 'lines.create'
    ? { code: null, lines: [{ id: 99, name: 'Van', qty_requested: 1 }] } : []);
  await t.page.formSubmit(false);
  assert.equal(t.page.fm.error, '');
  assert.equal(t.page.fm.open, false);
  assert.equal(ls.getItem(DRAFT_KEY('nam')), null, 'lưu xong phải xóa nháp');
  t.page.draftSave();
  assert.equal(ls.getItem(DRAFT_KEY('nam')), null, 'form rỗng thì không lưu nháp');
});

test('Nháp: localStorage ném lỗi không làm vỡ form', async () => {
  const t = await setupLinesPage(histRows(), { load: true });
  const boom = () => { throw new Error('blocked'); };
  Object.assign(t.sandbox.localStorage, { getItem: boom, setItem: boom, removeItem: boom });
  assert.doesNotThrow(() => t.page.openForm());
  t.page.fm.items[0].name = 'Van';
  assert.doesNotThrow(() => t.page.draftSave());
  assert.equal(t.page.fm.open, true);
});

test('Nháp: init đăng ký $watch để lưu có debounce khi fm.c / fm.items đổi', async () => {
  const watched = [];
  const t0 = await setupLinesPage(histRows(), { load: true });
  const page = t0.sandbox.linesPage();
  page.$watch = (expr, cb) => watched.push([expr, cb]);
  await page.init();
  assert.deepEqual(watched.map((w) => w[0]).sort(), ['fm.c', 'fm.items']);
});

test('Esc / closeForm khi form đã đóng không hiện confirm; đang mở và có dữ liệu thì vẫn hỏi', async () => {
  const t = await openedForm();
  t.page.fm.items[0].name = 'Van';
  t.page.fm.open = false;
  t.page.closeForm();
  assert.equal(t.confirms.length, 0);
  t.page.fm.open = true;
  t.page.closeForm();
  assert.equal(t.confirms.length, 1);
});

test('Ctrl+Enter lưu (không xuất phiếu); bỏ qua khi isComposing / ef.open / busy / form đóng / ô dán', async () => {
  const t = await openedForm();
  const calls = [];
  t.page.formSubmit = (issue) => { calls.push(issue); };
  const ev = (o) => Object.assign({ key: 'Enter', ctrlKey: true, preventDefault() {}, target: {} }, o);
  t.page.formKeydown(ev({}));
  t.page.formKeydown(ev({ ctrlKey: false, metaKey: true }));
  assert.deepEqual(calls, [false, false]);
  t.page.formKeydown(ev({ isComposing: true }));
  t.page.formKeydown(ev({ ctrlKey: false }));
  t.page.formKeydown(ev({ target: { tagName: 'TEXTAREA' } }));
  t.page.ef.open = true; t.page.formKeydown(ev({})); t.page.ef.open = false;
  t.page.fm.busy = true; t.page.formKeydown(ev({})); t.page.fm.busy = false;
  t.page.fm.open = false; t.page.formKeydown(ev({}));
  assert.equal(calls.length, 2);
});

test('Dán nhiều ô vào lưới form: điền đúng hàng-cột, thêm dòng khi thiếu; 1 giá trị không bị chặn', async () => {
  const t = await openedForm();
  t.page.fm.items.length = 0;
  t.page.formAddRow(2);
  let prevented = 0;
  const paste = (field, i, text) => t.page.formGridPaste({
    target: { getAttribute: (a) => (a === 'data-f' ? field : String(i)) },
    clipboardData: { getData: () => text },
    preventDefault() { prevented++; },
  });
  paste('name', 1, 'Bulong M12\tBộ\t\t1.500,5\nVan\tCái\tD\t2\nTê\tCái\tE\t3');
  assert.equal(prevented, 1);
  const it = t.page.fm.items;
  assert.equal(it.length, 4, 'thêm dòng khi thiếu');
  assert.equal(it[1].name, 'Bulong M12');
  assert.equal(it[1].uom, 'Bộ');
  assert.equal(it[1].material_group, 'C', 'điền từ lịch sử vì ô nhóm trống');
  assert.equal(it[1].qty_requested, '1.500,5');
  assert.equal(it[2].name, 'Van');
  assert.equal(it[2].material_group, 'D');
  assert.equal(it[3].qty_requested, '3');
  assert.equal(it[0].name, '');
  paste('need_date', 0, '5/11/2026\t1\t2');
  assert.equal(it[0].need_date, '2026-11-05');
  assert.deepEqual([it[0].project, it[0].purpose], ['1', '2']);
  paste('name', 0, 'chỉ một giá trị');
  paste('name', 0, 'một giá trị\n');
  assert.equal(prevented, 2, 'giá trị đơn không bị chặn');
  assert.equal(it[0].name, '');
});

test('Cảnh báo trùng: cùng tên + cùng hạng mục + chưa nhận đủ; đã đủ / khác hạng mục thì không', async () => {
  const t = await openedForm();
  const f = t.page.fm;
  f.items[0].name = 'bulong m12';
  f.c.project = 'MS1 — Dự án 1';
  let w = t.page.formDupes();
  assert.equal(w.length, 1);
  assert.match(w[0], /^Dòng 1 \(bulong m12\)/);
  assert.match(w[0], /phiếu YC2026-290/);
  assert.match(w[0], /còn thiếu 40/);
  assert.ok(!/chưa có phiếu/.test(w[0]));

  f.c.project = 'MS2 — Dự án 2';
  w = t.page.formDupes();
  assert.equal(w.length, 1);
  assert.match(w[0], /chưa có phiếu/);
  assert.match(w[0], /còn thiếu 20/);

  f.c.project = 'MS9 — Khác';
  assert.equal(t.page.formDupes().length, 0);

  f.items[0].project = 'MS1 — Dự án 1'; // hạng mục riêng của dòng ưu tiên
  assert.equal(t.page.formDupes().length, 1);

  f.items[0].name = 'Đai ốc'; // đã nhận đủ
  assert.equal(t.page.formDupes().length, 0);
});

test('Cảnh báo trùng: nhiều hơn 3 dòng thì gom "và N dòng nữa"; cả hai không có hạng mục thì coi là cùng', async () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ _key: 'i' + n, id: n, name: 'Van', qty_requested: 5, qty_received: 0, request_code: 'YC' + n }));
  const t = await openedForm(rows);
  t.page.fm.items[0].name = 'Van';
  const w = t.page.formDupes();
  assert.equal(w.length, 1);
  assert.match(w[0], /và 2 dòng nữa/);
});

// ---------- Sửa theo review: đổi phòng ban qua ô bảng / dán / form sửa; gợi ý theo tên; nháp; phím tắt ----------

const unitCell = (row, old) => ({ getField: () => 'unit', getRow: () => row, getOldValue: () => old, getValue: () => row.data.unit, setValue(v) { row.data.unit = v; } });
const coded3 = () => [
  { _key: 'i1', id: 1, name: 'A', qty_requested: 1, unit: 'Phòng Cải tiến', request_code: 'YC2026-001' },
  { _key: 'i2', id: 2, name: 'B', qty_requested: 1, unit: 'Phòng Cải tiến', request_code: 'YC2026-001' },
  { _key: 'i3', id: 3, name: 'C', qty_requested: 1, unit: 'Phòng Thiết bị', request_code: 'YC2026-002' },
  { _key: 'i4', id: 4, name: 'D', qty_requested: 1, unit: 'Phòng Cải tiến', request_code: null },
];
const MIXED_RE = /Một phiếu chỉ được thuộc 1 phòng ban/;

test('Ô bảng: đổi phòng dòng đã có phiếu → chặn nếu tạo phiếu trộn, hỏi confirm nếu không, hủy thì trả giá trị cũ', async () => {
  let t = await setupLinesPage(coded3(), { confirmResult: true });
  t.rows[0].data.unit = 'Phòng Thiết bị';
  t.handlers.cellEdited(unitCell(t.rows[0], 'Phòng Cải tiến'));
  assert.equal(t.rows[0].data.unit, 'Phòng Cải tiến', 'chặn: còn dòng khác của phiếu ở phòng cũ');
  assert.ok(hasToast(t, MIXED_RE));
  assert.equal(t.confirms.length, 0);
  t = await setupLinesPage(coded3(), { confirmResult: false });
  t.rows[2].data.unit = 'Phòng Cải tiến'; // phiếu 002 chỉ có 1 dòng
  t.handlers.cellEdited(unitCell(t.rows[2], 'Phòng Thiết bị'));
  assert.equal(t.confirms.length, 1);
  assert.match(t.confirms[0], /YC2026-002/);
  assert.match(t.confirms[0], /người ký/);
  assert.equal(t.rows[2].data.unit, 'Phòng Thiết bị', 'từ chối → trả lại');
  t = await setupLinesPage(coded3(), { confirmResult: true });
  t.rows[2].data.unit = 'Phòng Cải tiến';
  t.handlers.cellEdited(unitCell(t.rows[2], 'Phòng Thiết bị'));
  assert.equal(t.rows[2].data.unit, 'Phòng Cải tiến');
  t = await setupLinesPage(coded3(), { confirmResult: false }); // dòng chưa có phiếu: không hỏi
  t.rows[3].data.unit = 'Phòng Thiết bị';
  t.handlers.cellEdited(unitCell(t.rows[3], 'Phòng Cải tiến'));
  assert.equal(t.confirms.length, 0);
  assert.equal(t.rows[3].data.unit, 'Phòng Thiết bị');
});

test('Dán vào cột Đơn vị: gom theo phiếu, hỏi 1 lần; phiếu bị trộn thì bỏ qua ô đó và báo', async () => {
  const paste = (t, text) => {
    t.handlers.cellClick({}, { getRow: () => t.rows[0], getField: () => 'unit' });
    t.handlers.dom_paste({ target: { matches: () => false }, preventDefault() {}, clipboardData: { getData: () => text } });
  };
  let t = await setupLinesPage(coded3(), { confirmResult: true });
  paste(t, 'Phòng Thiết bị\nPhòng Thiết bị\nPhòng Cải tiến\nPhòng Thiết bị');
  assert.equal(t.confirms.length, 1, 'hỏi 1 lần cho cả lần dán');
  assert.match(t.confirms[0], /YC2026-001/);
  assert.match(t.confirms[0], /YC2026-002/);
  assert.deepEqual(t.rows.map((r) => r.data.unit), ['Phòng Thiết bị', 'Phòng Thiết bị', 'Phòng Cải tiến', 'Phòng Thiết bị']);
  t = await setupLinesPage(coded3(), { confirmResult: false });
  paste(t, 'Phòng Thiết bị\nPhòng Thiết bị\nPhòng Cải tiến\nPhòng Thiết bị');
  assert.equal(t.confirms.length, 1);
  assert.deepEqual(t.rows.map((r) => r.data.unit), ['Phòng Cải tiến', 'Phòng Cải tiến', 'Phòng Thiết bị', 'Phòng Thiết bị'], 'từ chối: giữ ô có phiếu, dòng chưa phiếu vẫn đổi');
  t = await setupLinesPage(coded3(), { confirmResult: true });
  paste(t, 'Phòng Thiết bị'); // chỉ 1/2 dòng của phiếu 001 → trộn
  assert.equal(t.rows[0].data.unit, 'Phòng Cải tiến');
  assert.ok(hasToast(t, MIXED_RE));
  assert.equal(t.confirms.length, 0);
});

test('Form sửa: đổi phòng làm phiếu trộn bị chặn dù xác nhận', async () => {
  const t = await setupLinesPage(coded3(), { confirmResult: true });
  t.page.openEdit(t.rows[0]);
  t.page.ef.d.unit = 'Phòng Thiết bị';
  t.page.saveEdit();
  assert.match(t.page.ef.error, MIXED_RE);
  assert.equal(t.rows[0].data.unit, 'Phòng Cải tiến');
  assert.equal(t.page.ef.open, true);
});

test('Đổi phòng: phiếu vốn đã trộn mà việc đổi không thêm phòng mới thì cho phép (hỏi confirm); phiếu đồng nhất đổi 1 dòng vẫn chặn', async () => {
  const mixed = () => [
    ...['a', 'b', 'c'].map((n, i) => ({ _key: 'm' + i, id: 10 + i, name: n, qty_requested: 1, unit: 'Phòng Thiết bị', request_code: 'YC2026-050' })),
    ...['d', 'e'].map((n, i) => ({ _key: 'n' + i, id: 20 + i, name: n, qty_requested: 1, unit: 'P.Cải tiến', request_code: 'YC2026-050' })),
  ];
  let t = await setupLinesPage(mixed(), { confirmResult: true });
  t.rows[3].data.unit = 'Phòng Thiết bị';
  t.handlers.cellEdited(unitCell(t.rows[3], 'P.Cải tiến'));
  assert.equal(t.confirms.length, 1, 'phiếu cũ trộn: hỏi confirm');
  assert.ok(!hasToast(t, MIXED_RE));
  assert.equal(t.rows[3].data.unit, 'Phòng Thiết bị');
  t = await setupLinesPage(coded3(), { confirmResult: true });
  t.page.openEdit(t.rows[0]);
  t.page.ef.d.unit = 'Phòng Thiết bị';
  t.page.saveEdit();
  assert.match(t.page.ef.error, MIXED_RE, 'phiếu 2 dòng cùng phòng đổi 1 dòng vẫn chặn');
  t = await setupLinesPage(coded3(), { confirmResult: true });
  t.rows[0].data.unit = 'Phòng Cải tiến';
  t.handlers.cellEdited(unitCell(t.rows[0], 'P.Cải tiến')); // cùng phòng (tên cũ)
  assert.equal(t.confirms.length, 0);
});

test('Form thêm: đổi tên giữa chừng cập nhật ĐVT/nhóm/đơn giá do gợi ý điền, giữ ô sửa tay', async () => {
  const rows = histRows().concat([{ _key: 'i9', id: 9, name: 'Ống thép', uom: 'Cây', unit_price: 50000, qty_requested: 1, qty_received: 1 },
    { _key: 'i10', id: 10, name: 'Ống thép D21', uom: 'Mét', material_group: 'D', unit_price: 12000, qty_requested: 1, qty_received: 1 }]);
  const t = await openedForm(rows);
  const a = t.page.fm.items[0];
  a.name = 'Ống thép'; t.page.formName(a);
  assert.deepEqual([a.uom, String(a.unit_price)], ['Cây', '50000']);
  a.name = 'Ống thép D21'; t.page.formName(a);
  assert.deepEqual([a.uom, a.material_group, String(a.unit_price)], ['Mét', 'D', '12000']);
  a.name = 'Tên không có'; t.page.formName(a);
  assert.deepEqual([a.uom, a.material_group, a.unit_price], ['', '', ''], 'tên mới không có lịch sử → xóa phần tự điền');
  const b = t.page.fm.items[1];
  b.name = 'Ống thép'; t.page.formName(b);
  b.uom = 'Bó'; // sửa tay
  b.name = 'Ống thép D21'; t.page.formName(b);
  assert.equal(b.uom, 'Bó');
  assert.equal(String(b.unit_price), '12000');
  const html = fs.readFileSync(path.join(DOCS, 'lines.html'), 'utf8');
  assert.ok(!/@input="formName/.test(html), 'không điền theo từng phím gõ');
});

test('Nháp: khôi phục đặt lại ngày yêu cầu = hôm nay; ngày cần có cũ hơn hôm nay bị bỏ', async () => {
  const mk = async (need) => {
    const t = await setupLinesPage(histRows(), { load: true });
    t.sandbox.localStorage.setItem(DRAFT_KEY('nam'), JSON.stringify({
      c: { unit: 'Phòng Cải tiến', request_date: '2026-01-01', need_date: need }, items: [{ name: 'Van', qty_requested: '1', need_date: need }],
    }));
    t.page.openForm();
    return t;
  };
  let t = await mk('2026-01-05');
  assert.equal(t.page.fm.c.request_date, '2026-10-26');
  assert.equal(t.page.fm.c.need_date, '');
  assert.equal(t.page.fm.items[0].need_date, '');
  t = await mk('2026-12-05');
  assert.equal(t.page.fm.c.request_date, '2026-10-26');
  assert.equal(t.page.fm.c.need_date, '2026-12-05');
  assert.equal(t.page.fm.items[0].need_date, '2026-12-05');
});

test('Ô Đơn vị trên bảng: giá trị cũ hợp lệ + bấm ra không chọn gì thì không báo lỗi; giá trị cũ không hợp lệ thì vẫn báo', async () => {
  const t = await setupLinesPage([{ _key: 'i1', id: 1, name: 'A', qty_requested: 1, unit: 'P.TB' }, { _key: 'i2', id: 2, name: 'B', qty_requested: 1, unit: 'Xưởng' }]);
  t.rows[0].data.unit = null;
  t.handlers.cellEdited(unitCell(t.rows[0], 'P.TB'));
  assert.equal(t.rows[0].data.unit, 'P.TB');
  assert.ok(!hasToast(t, /chỉ nhận/));
  t.rows[1].data.unit = null;
  t.handlers.cellEdited(unitCell(t.rows[1], 'Xưởng'));
  assert.ok(hasToast(t, /chỉ nhận/));
});

test('lines.html: select #ef-unit có option "(cũ)" cố định trước x-model; ô tên/SL không chạy Enter khi Ctrl/Cmd', async () => {
  const html = fs.readFileSync(path.join(DOCS, 'lines.html'), 'utf8');
  const sel = html.match(/<select id="ef-unit"[\s\S]*?<\/select>/)[0];
  assert.match(sel, /<option[^>]*:value="efLegacy\(\) \? ef\.legacyUnit : ''"/);
  assert.ok(!/x-for="u in efUnits\(\)"/.test(sel));
  // Mô phỏng: tập value các option không được trùng (trừ value rỗng) với mọi trạng thái legacyUnit
  const t0 = await setupLinesPage([]);
  const units = ['Phòng Cải tiến', 'Phòng Thiết bị'];
  for (const legacy of ['', 'P.TB', 'Phòng Thiết bị', 'Phòng Cải tiến']) {
    t0.page.ef.legacyUnit = legacy;
    const vals = [];
    for (const m of sel.matchAll(/<option([^>]*)>/g)) {
      const attrs = m[1];
      if (/:value="u"/.test(attrs)) { vals.push(...units); continue; }
      const q = attrs.match(/:value="efLegacy\(\) \? ef\.legacyUnit : ''"/);
      if (q) { vals.push(t0.page.efLegacy() ? legacy : ''); continue; }
      const v = attrs.match(/\bvalue="([^"]*)"/);
      vals.push(v ? v[1] : '');
    }
    const nonEmpty = vals.filter((v) => v !== '');
    assert.equal(new Set(nonEmpty).size, nonEmpty.length, 'option trùng value với legacy=' + JSON.stringify(legacy) + ': ' + vals);
  }
  assert.match(sel, /\$nextTick/);
  const t = await openedForm();
  t.page.formEnter(0, { ctrlKey: true });
  t.page.formEnter(0, { metaKey: true });
  assert.equal(t.page.fm.items.length, 3, 'Ctrl/Cmd+Enter không thêm dòng');
  t.page.formEnter(2, {});
  assert.equal(t.page.fm.items.length, 4);
  assert.match(html, /formEnter\(i, \$event\)/);
});
