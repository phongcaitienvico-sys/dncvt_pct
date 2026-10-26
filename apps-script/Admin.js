/** Danh mục, người dùng, nhật ký, xuất toàn bộ, sao lưu. */

function apiBootstrap_(p, ctx) {
  const catalogs = {};
  CATALOG_TABLES.forEach(function (t) { catalogs[t] = tableAll_(t); });
  return {
    user: publicUser_(ctx.user),
    catalogs: catalogs,
    users: tableAll_('users').filter(function (u) { return u.active; }).map(function (u) { return { username: u.username, full_name: u.full_name }; }),
    today: todayStr_(),
  };
}

function cleanCatalogRow_(table, row) {
  if (CATALOG_TABLES.indexOf(table) < 0) fail_('Danh mục không hợp lệ: ' + table);
  if (!row || typeof row !== 'object') fail_('Dữ liệu không hợp lệ');
  const out = {};
  columnsOf_(table).forEach(function (c) {
    if (c[0] === 'id' || !(c[0] in row)) return;
    out[c[0]] = cleanStr_(row[c[0]], c[0]);
  });
  return out;
}

// Mỗi mục danh mục phải có ít nhất một trong các trường này (mục trống làm hỏng danh sách chọn trên bảng vật tư)
const CATALOG_REQUIRED = {
  units: ['name'], uoms: ['name'], material_groups: ['name'], suppliers: ['code', 'name'],
  project_items: ['item_code', 'item_name', 'project_code', 'project_name'],
};
// Trường không được trùng giữa các mục (so không phân biệt hoa/thường, khoảng trắng)
const CATALOG_UNIQUE = { units: 'name', uoms: 'name', material_groups: 'name', suppliers: 'code', project_items: 'item_code' };
const CATALOG_LABELS = {
  name: 'Tên', code: 'Mã', item_code: 'Mã hạng mục', item_name: 'Tên hạng mục', project_code: 'Mã dự án', project_name: 'Tên dự án',
};

function catalogKey_(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Kiểm tra mục danh mục sau khi sửa (`after`) TRƯỚC khi ghi: không trống, không trùng. */
function checkCatalogRow_(table, after, before) {
  const req = CATALOG_REQUIRED[table];
  if (!req.some(function (f) { return after[f]; })) {
    fail_('Chưa nhập ' + req.map(function (f) { return '"' + CATALOG_LABELS[f] + '"'; }).join(' hoặc ') + ' — mục trống không được lưu.');
  }
  const u = CATALOG_UNIQUE[table];
  if (!after[u] || (before && catalogKey_(before[u]) === catalogKey_(after[u]))) return;
  const dup = tableAll_(table).find(function (r) { return r.id !== after.id && catalogKey_(r[u]) === catalogKey_(after[u]); });
  if (dup) fail_('"' + after[u] + '" đã có trong danh mục.', 'DUPLICATE');
}

function apiCatalogSave_(p, ctx) {
  const table = String(p.table || '');
  const patch = cleanCatalogRow_(table, p.row);
  if (p.row.id) {
    const before = tableFind_(table, [Number(p.row.id)])[Number(p.row.id)];
    if (!before) fail_('Không tìm thấy bản ghi', 'NOT_FOUND');
    checkCatalogRow_(table, Object.assign({}, before, patch), before);
    const done = updateObjs_(table, [{ id: Number(p.row.id), patch: patch }]);
    if (!done.length) fail_('Không tìm thấy bản ghi', 'NOT_FOUND');
    Object.keys(patch).forEach(function (f) {
      if (done[0].before[f] !== patch[f]) audit_(ctx, table, p.row.id, f, done[0].before[f], patch[f]);
    });
    return done[0].after;
  }
  checkCatalogRow_(table, patch, null);
  const rec = tableInsert_(table, [patch])[0];
  audit_(ctx, table, rec.id, '(thêm)', '', JSON.stringify(patch));
  return rec;
}

function apiCatalogDelete_(p, ctx) {
  const table = String(p.table || '');
  if (CATALOG_TABLES.indexOf(table) < 0) fail_('Danh mục không hợp lệ');
  const ids = cleanIds_(p.ids);
  const rows = tableFind_(table, ids);
  ids.forEach(function (id) { if (rows[id]) audit_(ctx, table, id, '(xóa)', JSON.stringify(rows[id]), ''); });
  return { deleted: tableDelete_(table, ids) };
}

function apiUsersList_() {
  return tableAll_('users').map(publicUser_);
}

function apiUsersSave_(p, ctx) {
  const u = p.user || {};
  const username = cleanStr_(u.username, 'Tên đăng nhập');
  if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) fail_('Tên đăng nhập 3–40 ký tự: chữ không dấu, số, . _ -');
  const role = u.role === 'admin' ? 'admin' : 'user';
  const fullName = cleanStr_(u.full_name, 'Họ tên') || username;
  const active = u.active !== false;
  const dup = findUser_(username);
  if (u.id) {
    const id = Number(u.id);
    if (dup && dup.id !== id) fail_('Tên đăng nhập đã tồn tại');
    if (id === ctx.user.id && (role !== 'admin' || !active)) fail_('Không thể tự bỏ quyền Quản trị hoặc tự khóa tài khoản của mình.');
    const patch = { username: username, full_name: fullName, role: role, active: active };
    if (u.password) {
      checkPasswordStrength_(String(u.password));
      patch.salt = newSalt_();
      patch.password_hash = hashPassword_(String(u.password), patch.salt);
    }
    const done = updateObjs_('users', [{ id: id, patch: patch }]);
    if (!done.length) fail_('Không tìm thấy người dùng', 'NOT_FOUND');
    ['username', 'full_name', 'role', 'active'].forEach(function (f) {
      if (done[0].before[f] !== patch[f]) audit_(ctx, 'users', id, f, done[0].before[f], patch[f]);
    });
    if (u.password) audit_(ctx, 'users', id, 'password', '', '(đặt lại)');
    return publicUser_(done[0].after);
  }
  if (dup) fail_('Tên đăng nhập đã tồn tại');
  checkPasswordStrength_(String(u.password || ''));
  const salt = newSalt_();
  const rec = tableInsert_('users', [{
    username: username, full_name: fullName, role: role, active: active,
    salt: salt, password_hash: hashPassword_(String(u.password), salt), created_at: nowStr_(),
  }])[0];
  audit_(ctx, 'users', rec.id, '(thêm)', '', username);
  return publicUser_(rec);
}

function apiAuditList_(p) {
  const limit = Math.min(Number(p.limit) || 500, 5000);
  const q = String(p.q || '').toLowerCase();
  return tableAll_('audit_log').reverse().filter(function (a) {
    return !q || [a.user, a.table, a.row_id, a.field, a.old, a.new].join(' ').toLowerCase().indexOf(q) >= 0;
  }).slice(0, limit);
}

/** Toàn bộ dữ liệu (trừ mật khẩu) để client dựng file Excel. */
function apiExportAll_() {
  const out = {};
  Object.keys(SCHEMA).forEach(function (t) {
    if (t === 'users') out[t] = apiUsersList_();
    else out[t] = tableAll_(t);
  });
  return out;
}

function apiBackupRun_() {
  return { name: store_().backup() };
}

/** Sao chép cả file Sheet vào thư mục Drive BACKUP_FOLDER, giữ BACKUP_KEEP bản mới nhất. */
function backupSpreadsheet_(ss) {
  const file = DriveApp.getFileById(ss.getId());
  const folders = DriveApp.getFoldersByName(CONFIG.BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.BACKUP_FOLDER);
  const name = ss.getName() + ' - backup ' + Utilities.formatDate(now_(), CONFIG.TIMEZONE, 'yyyy-MM-dd HHmm');
  file.makeCopy(name, folder);
  const copies = [];
  const it = folder.getFiles();
  while (it.hasNext()) copies.push(it.next());
  copies.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  copies.slice(CONFIG.BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  return name;
}

/** Hàm cho trigger hằng đêm (cài bằng installTriggers()). */
function nightlyBackup() {
  backupSpreadsheet_(SpreadsheetApp.getActiveSpreadsheet());
}
