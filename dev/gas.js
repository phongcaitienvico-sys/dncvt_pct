/**
 * Chạy code Apps Script (apps-script/*.js) trong Node với các dịch vụ Google giả lập,
 * dữ liệu lưu ở một file JSON thay cho Google Sheet. Dùng cho dev server và test.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC_DIR = path.join(__dirname, '..', 'apps-script');

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return Buffer.from(v.map((b) => b & 0xff));
  return Buffer.from(String(v), 'utf8');
}
const toBytes = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b)); // byte[] kiểu Java như Apps Script

function formatDate(date, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (m, lit) => {
    if (lit !== undefined) return lit;
    return { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second }[m];
  });
}

function makeUtilities() {
  return {
    Charset: { UTF_8: 'UTF-8' },
    formatDate,
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: (value, key) => toBytes(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
    base64Encode: (v) => toBuf(v).toString('base64'),
    base64EncodeWebSafe: (v) => toBuf(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64DecodeWebSafe: (s) => toBytes(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: (bytes) => ({ getDataAsString: () => toBuf(bytes).toString('utf8') }),
  };
}

function makeServices(props) {
  const cache = new Map();
  return {
    Utilities: makeUtilities(),
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => { const e = cache.get(k); return e && e.exp > Date.now() ? e.v : null; },
        put: (k, v, ttl) => cache.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }),
        remove: (k) => cache.delete(k),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
    },
  };
}

/** Store thay cho Google Sheet: {tabs: {name: {headers, rows}}, props: {...}} trong 1 file JSON (hoặc chỉ trong RAM). */
function makeJsonStore(file) {
  let db = { tabs: {}, props: {} };
  if (file && fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
  db.props = db.props || {};
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(db));
    fs.renameSync(file + '.tmp', file);
  };
  const tab = (name) => {
    const t = db.tabs[name];
    if (!t) { const e = new Error('Thiếu tab "' + name + '" — hãy chạy setup()'); e.code = 'SETUP'; throw e; }
    return t;
  };
  return {
    db,
    ensure(name, headers) {
      const t = db.tabs[name] || (db.tabs[name] = { headers: [], rows: [] });
      headers.forEach((h) => { if (!t.headers.includes(h)) t.headers.push(h); });
      save();
    },
    read(name) {
      const t = tab(name);
      return { headers: t.headers.slice(), rows: t.rows.map((r) => t.headers.map((_, i) => (r[i] === undefined ? '' : r[i]))) };
    },
    readCol(name, field) {
      const t = tab(name);
      const c = t.headers.indexOf(field);
      return c < 0 ? [] : t.rows.map((r) => (r[c] === undefined ? '' : r[c]));
    },
    readRowsAt(name, indexes) {
      const t = tab(name);
      return { headers: t.headers.slice(), rows: indexes.map((i) => t.headers.map((_, k) => (t.rows[i][k] === undefined ? '' : t.rows[i][k]))) };
    },
    findRows(name, ids) {
      const t = tab(name);
      const want = new Set(ids.map(String));
      const col = t.headers.indexOf('id');
      const found = [];
      t.rows.forEach((r, i) => { if (want.has(String(r[col]))) found.push({ index: i, values: r.slice() }); });
      return { headers: t.headers.slice(), found };
    },
    append(name, rows) { tab(name).rows.push(...rows.map((r) => r.slice())); },
    writeRow(name, index, values) { tab(name).rows[index] = values.slice(); },
    writeCol(name, field, values) {
      const t = tab(name);
      const c = t.headers.indexOf(field);
      if (c < 0) return;
      values.forEach((v, i) => { if (t.rows[i]) t.rows[i][c] = v === null || v === undefined ? '' : String(v); });
    },
    keepRows(name, keep) {
      const t = tab(name);
      t.rows = keep.map((i) => t.rows[i]);
    },
    deleteRows(name, indexes) {
      const t = tab(name);
      indexes.slice().sort((a, b) => b - a).forEach((i) => t.rows.splice(i, 1));
    },
    flush: save,
    backup() {
      if (!file) return 'memory-backup';
      const dir = path.join(path.dirname(file), 'backup');
      fs.mkdirSync(dir, { recursive: true });
      const name = 'db-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      fs.copyFileSync(file, path.join(dir, name));
      const all = fs.readdirSync(dir).sort().reverse();
      all.slice(30).forEach((f) => fs.unlinkSync(path.join(dir, f)));
      return name;
    },
  };
}

/** Nạp backend. file = đường dẫn JSON (null = chỉ trong RAM, dùng cho test). */
function createBackend(file) {
  const store = makeJsonStore(file);
  const context = { console, Date, JSON, Math, Number, String, Object, Array, Error, isNaN, isFinite, __DEV_STORE__: store };
  Object.assign(context, makeServices(store.db.props));
  context.globalThis = context;
  vm.createContext(context);
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
  const code = files.map((f) => `// ---- ${f}\n` + fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n');
  vm.runInContext(code, context, { filename: 'apps-script-bundle.js' });

  const backend = {
    context,
    store,
    setup: () => context.setupStore_(store),
    // JSON khứ hồi giống như qua mạng (và đưa object ra khỏi realm của vm)
    handle: (body) => JSON.parse(JSON.stringify(context.handle_(typeof body === 'string' ? body : JSON.stringify(body)))),
    setNow: (iso) => { context.__NOW__ = iso || null; },
    /** Gọi API như client; trả data hoặc ném lỗi có .code */
    call(action, params, token) {
      const res = backend.handle({ action, params: params || {}, token });
      if (!res.ok) { const e = new Error(res.error); e.code = res.code; e.details = res.details; throw e; }
      return res.data;
    },
  };
  return backend;
}

module.exports = { createBackend };
