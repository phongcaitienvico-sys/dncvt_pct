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

test('config.js giữ tương thích ngược mặc định BACKEND_MODE = gas và cầu dao Rollback', () => {
  const { sandbox } = createBrowserEnv({ hostname: 'localhost' });
  assert.equal(sandbox.APP_CONFIG.BACKEND_MODE, 'gas');
  assert.equal(sandbox.APP_CONFIG.SUPABASE_URL, 'https://unbrchhbfughabmkorxt.supabase.co');
  assert.match(sandbox.APP_CONFIG.SUPABASE_ANON_KEY, /^eyJ/);
  assert.equal(sandbox.APP_CONFIG.API_URL, '/api');

  const prod = createBrowserEnv({ hostname: 'example.github.io' });
  assert.equal(prod.sandbox.APP_CONFIG.BACKEND_MODE, 'gas');
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
