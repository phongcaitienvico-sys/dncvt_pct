/**
 * Lớp truy cập dữ liệu. Mọi đọc/ghi Sheet đi qua "store" (sheetStore_ khi chạy trên Google,
 * store JSON giả lập khi chạy dev server/test), rồi qua các hàm table*_ bên dưới.
 */

let LOCK_HELD_ = false;

function fail_(message, code, details) {
  const e = new Error(message);
  e.code = code || 'ERR';
  e.details = details || null;
  throw e;
}

function now_() {
  return globalThis.__NOW__ ? new Date(globalThis.__NOW__) : new Date();
}

function nowStr_() {
  return Utilities.formatDate(now_(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

function todayStr_() {
  return Utilities.formatDate(now_(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}

/** Chuẩn hóa về yyyy-mm-dd; trả null nếu không hiểu. */
function toIsoDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s);
  if (m) return m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
  return null;
}

function store_() {
  return globalThis.__DEV_STORE__ || sheetStore_();
}

// ---------- Chuyển đổi ô <-> giá trị ----------

function parseCell_(type, v) {
  if (v === '' || v === null || v === undefined) return type === 'bool' ? false : null;
  switch (type) {
    case 'int':
    case 'num': {
      if (typeof v === 'number') return v;
      const n = Number(String(v).trim());
      return isNaN(n) ? null : n;
    }
    case 'bool':
      return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
    case 'date':
      return toIsoDate_(v);
    case 'datetime':
      return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss") : String(v);
    case 'json':
      try { return JSON.parse(v); } catch (e) { return null; }
    default: {
      const s = String(v);
      return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
    }
  }
}

function serializeCell_(type, v) {
  if (v === null || v === undefined) return '';
  if (type === 'bool') return v ? 'TRUE' : '';
  if (type === 'json') return JSON.stringify(v);
  return String(v);
}

function typeOf_(table, field) {
  const c = columnsOf_(table).find(function (c) { return c[0] === field; });
  return c ? c[1] : null;
}

function rowToObj_(table, headers, row) {
  const o = {};
  columnsOf_(table).forEach(function (c) {
    const i = headers.indexOf(c[0]);
    o[c[0]] = parseCell_(c[1], i < 0 ? '' : row[i]);
  });
  return o;
}

/** Giữ nguyên giá trị các cột lạ (người dùng tự thêm vào Sheet) khi cập nhật. */
function objToRow_(table, headers, obj, baseRow) {
  return headers.map(function (h, i) {
    const type = typeOf_(table, h);
    if (!type || !(h in obj)) return baseRow ? baseRow[i] : '';
    return serializeCell_(type, obj[h]);
  });
}

// ---------- Bảng ----------

function tableAll_(table) {
  const t = store_().read(table);
  const idIdx = t.headers.indexOf('id');
  return t.rows
    .filter(function (r) { return r[idIdx] !== '' && r[idIdx] !== null && r[idIdx] !== undefined; })
    .map(function (r) { return rowToObj_(table, t.headers, r); });
}

/** Trả về map id -> object cho các id tìm thấy. */
function tableFind_(table, ids) {
  const res = store_().findRows(table, ids);
  const out = {};
  res.found.forEach(function (f) {
    const o = rowToObj_(table, res.headers, f.values);
    out[o.id] = o;
  });
  return out;
}

function appendObjs_(table, objs) {
  if (!objs.length) return;
  const headers = store_().read(table).headers;
  store_().append(table, objs.map(function (o) { return objToRow_(table, headers, o, null); }));
}

/** patches: [{id, patch}] → [{before, after}] (bỏ qua id không tồn tại). */
function updateObjs_(table, patches) {
  if (!patches.length) return [];
  const res = store_().findRows(table, patches.map(function (p) { return p.id; }));
  const byId = {};
  res.found.forEach(function (f) { byId[String(rowToObj_(table, res.headers, f.values).id)] = f; });
  const out = [];
  patches.forEach(function (p) {
    const f = byId[String(p.id)];
    if (!f) return;
    const before = rowToObj_(table, res.headers, f.values);
    const after = Object.assign({}, before, p.patch);
    const row = objToRow_(table, res.headers, after, f.values);
    store_().writeRow(table, f.index, row);
    f.values = row;
    out.push({ before: before, after: after });
  });
  return out;
}

function nextIds_(table, count) {
  const last = seqNext_('id:' + table, function () {
    return tableAll_(table).reduce(function (m, r) { return Math.max(m, r.id || 0); }, 0);
  }, count);
  const ids = [];
  for (let i = last - count + 1; i <= last; i++) ids.push(i);
  return ids;
}

function tableInsert_(table, objs) {
  if (!objs.length) return [];
  const ids = nextIds_(table, objs.length);
  const rows = objs.map(function (o, i) { return Object.assign({}, o, { id: ids[i] }); });
  appendObjs_(table, rows);
  return rows;
}

function tableDelete_(table, ids) {
  const res = store_().findRows(table, ids);
  store_().deleteRows(table, res.found.map(function (f) { return f.index; }));
  return res.found.length;
}

/** Tăng bộ đếm `key` thêm `count`, trả về giá trị mới. Chỉ gọi khi đang giữ khóa. */
function seqNext_(key, initial, count) {
  if (!LOCK_HELD_) fail_('seqNext_ phải chạy trong withLock_', 'INTERNAL');
  if (count === undefined) count = 1;
  const rows = tableAll_('sequences');
  const row = rows.find(function (r) { return r.key === key; });
  if (!row) {
    const start = typeof initial === 'function' ? initial() : (initial || 0);
    const maxId = rows.reduce(function (m, r) { return Math.max(m, r.id || 0); }, 0);
    appendObjs_('sequences', [{ id: maxId + 1, key: key, last_value: start + count }]);
    return start + count;
  }
  const next = (row.last_value || 0) + count;
  updateObjs_('sequences', [{ id: row.id, patch: { last_value: next } }]);
  return next;
}

// ---------- Khóa + nhật ký ----------

/** Chạy fn trong khóa toàn script: mọi thao tác ghi đều tuần tự, không thể trùng/nhảy số. */
function withLock_(ctx, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) fail_('Hệ thống đang bận, vui lòng thử lại sau vài giây.', 'BUSY');
  LOCK_HELD_ = true;
  if (store_().reset) store_().reset(); // đọc lại dữ liệu mới nhất sau khi có khóa
  try {
    const result = fn();
    if (ctx.audit && ctx.audit.length) {
      tableInsert_('audit_log', ctx.audit);
      ctx.audit = [];
    }
    store_().flush();
    return result;
  } finally {
    LOCK_HELD_ = false;
    lock.releaseLock();
  }
}

function audit_(ctx, table, rowId, field, oldVal, newVal) {
  const str = function (v) { return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); };
  ctx.audit = ctx.audit || [];
  ctx.audit.push({
    at: nowStr_(), user: ctx.user ? ctx.user.username : '', table: table, row_id: String(rowId),
    field: field, old: str(oldVal).slice(0, 5000), new: str(newVal).slice(0, 5000),
  });
}

// ---------- Kiểm tra đầu vào ----------

function cleanStr_(v, label) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') fail_('Giá trị không hợp lệ ở "' + label + '"');
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (s.length > CONFIG.MAX_TEXT_LENGTH) fail_('"' + label + '" quá dài (tối đa ' + CONFIG.MAX_TEXT_LENGTH + ' ký tự)');
  return s === '' ? null : s;
}

function cleanNum_(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  if (!isFinite(n)) fail_('"' + label + '" phải là số');
  if (n < 0) fail_('"' + label + '" không được âm');
  return n;
}

function cleanDate_(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const iso = toIsoDate_(v);
  if (!iso) fail_('"' + label + '" không phải ngày hợp lệ');
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) fail_('"' + label + '" không phải ngày hợp lệ');
  return iso;
}

function cleanIds_(v) {
  if (!Array.isArray(v)) fail_('Danh sách id không hợp lệ');
  const out = [];
  v.forEach(function (x) {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0) fail_('Id không hợp lệ: ' + x);
    if (out.indexOf(n) < 0) out.push(n);
  });
  return out;
}

// ---------- Store thật: Google Sheet ----------

function sheetStore_() {
  if (globalThis.__SHEET_STORE__) return globalThis.__SHEET_STORE__;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) fail_('Thiếu tab "' + name + '" trong Sheet — hãy chạy hàm setup().', 'SETUP');
    return sh;
  };
  const headersOf = function (sh) {
    const lc = sh.getLastColumn();
    return lc ? sh.getRange(1, 1, 1, lc).getValues()[0].map(String) : [];
  };
  // Chặn chèn công thức: chuỗi bắt đầu bằng = + - @ được ghi kèm dấu nháy để Sheet coi là chữ.
  const safe = function (v) {
    return typeof v === 'string' && /^[=+\-@]/.test(v) && isNaN(Number(v)) ? "'" + v : v;
  };
  const cache = {};
  const store = {
    ensure: function (name, headers) {
      let sh = ss.getSheetByName(name);
      if (!sh) sh = ss.insertSheet(name);
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
      const existing = headersOf(sh).filter(String);
      const missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
      if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
      sh.setFrozenRows(1);
    },
    read: function (name) {
      if (cache[name]) return cache[name];
      const sh = sheet(name);
      const lr = sh.getLastRow();
      const lc = sh.getLastColumn();
      if (lr < 1) return { headers: [], rows: [] };
      const values = sh.getRange(1, 1, lr, lc).getValues();
      cache[name] = { headers: values[0].map(String), rows: values.slice(1) };
      return cache[name];
    },
    /** Đọc 1 cột (rất rẻ so với đọc cả bảng). Trả mảng giá trị theo thứ tự dòng. */
    readCol: function (name, field) {
      const sh = sheet(name);
      const headers = headersOf(sh);
      const col = headers.indexOf(field) + 1;
      const lr = sh.getLastRow();
      if (!col || lr < 2) return [];
      return sh.getRange(2, col, lr - 1, 1).getValues().map(function (r) { return r[0]; });
    },
    /** Đọc các dòng theo chỉ số (0 = dòng dữ liệu đầu); gom dòng liên tiếp để ít lệnh gọi. */
    readRowsAt: function (name, indexes) {
      const sh = sheet(name);
      const headers = headersOf(sh);
      const out = [];
      let i = 0;
      while (i < indexes.length) {
        let j = i;
        while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++;
        const vals = sh.getRange(indexes[i] + 2, 1, j - i + 1, headers.length).getValues();
        vals.forEach(function (v) { out.push(v); });
        i = j + 1;
      }
      return { headers: headers, rows: out };
    },
    findRows: function (name, ids) {
      const sh = sheet(name);
      const headers = headersOf(sh);
      const col = headers.indexOf('id') + 1;
      const lr = sh.getLastRow();
      if (lr < 2 || !col) return { headers: headers, found: [] };
      const want = {};
      ids.forEach(function (id) { want[String(id)] = true; });
      const idx = [];
      sh.getRange(2, col, lr - 1, 1).getValues().forEach(function (v, i) {
        if (want[String(v[0])]) idx.push(i);
      });
      let found;
      if (idx.length > 20) {
        const all = sh.getRange(2, 1, lr - 1, headers.length).getValues();
        found = idx.map(function (i) { return { index: i, values: all[i] }; });
      } else {
        found = idx.map(function (i) { return { index: i, values: sh.getRange(i + 2, 1, 1, headers.length).getValues()[0] }; });
      }
      return { headers: headers, found: found };
    },
    append: function (name, rows) {
      if (!rows.length) return;
      delete cache[name];
      const sh = sheet(name);
      const start = sh.getLastRow() + 1;
      const need = start + rows.length - 1 - sh.getMaxRows();
      if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 200);
      sh.getRange(start, 1, rows.length, rows[0].length).setNumberFormat('@')
        .setValues(rows.map(function (r) { return r.map(safe); }));
    },
    writeRow: function (name, index, values) {
      delete cache[name];
      sheet(name).getRange(index + 2, 1, 1, values.length).setNumberFormat('@').setValues([values.map(safe)]);
    },
    /** Ghi đè 1 cột bằng một lệnh duy nhất (dùng khi chuẩn hóa hàng nghìn dòng lịch sử). */
    writeCol: function (name, field, values) {
      if (!values.length) return;
      delete cache[name];
      const sh = sheet(name);
      const col = headersOf(sh).indexOf(field) + 1;
      if (!col) return;
      sh.getRange(2, col, values.length, 1).setNumberFormat('@')
        .setValues(values.map(function (v) { return [safe(v === null || v === undefined ? '' : String(v))]; }));
    },
    deleteRows: function (name, indexes) {
      delete cache[name];
      const sh = sheet(name);
      indexes.slice().sort(function (a, b) { return b - a; }).forEach(function (i) { sh.deleteRow(i + 2); });
    },
    flush: function () {
      SpreadsheetApp.flush();
    },
    reset: function () {
      Object.keys(cache).forEach(function (k) { delete cache[k]; });
    },
    backup: function () {
      return backupSpreadsheet_(ss);
    },
  };
  globalThis.__SHEET_STORE__ = store;
  return store;
}
