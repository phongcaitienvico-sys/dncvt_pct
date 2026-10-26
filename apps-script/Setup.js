const DEFAULT_MATERIAL_GROUPS = [
  { name: 'C', description: 'Thiết bị, máy móc sản xuất, vật tư cải tạo, chế tạo; Công cụ, dụng cụ, vật tư phục vụ sửa chữa; Vật tư phục vụ thi công xây dựng' },
  { name: 'E', description: 'Văn phòng phẩm; Bảo hộ lao động; Đá mài, đá cắt; Các vật tư khác' },
];

const LEGACY_GROUP_ALIASES = {
  'vt che tao': 'C',
  'bulong': 'C',
  'gcck': 'C',
  'vbi': 'C',
  'cat ton': 'C',
  'cong cu ca nhan': 'C',
  'thiet bi': 'C',
  'van phong pham': 'E',
  'vt van phong': 'E',
  'do gia dung': 'E',
};

function foldKey_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Chuẩn hóa danh mục Nhóm vật tư & cột material_group lịch sử:
 * - Nếu trống: tạo mẫu C, E kèm giải thích.
 * - Nếu tab material_groups bị tách phẳng từ Excel cũ (chưa dòng nào có description, có mã ngắn C/E xen dòng giải thích dài):
 *   gộp các dòng giải thích vào cột description của mã nhóm đứng trước và xóa dòng thừa.
 * - Đổi các tên nhóm kiểu cũ trong bảng lines ("Văn phòng phẩm" → "E", "VT chế tạo" → "C"…) về mã nhóm.
 */
function migrateMaterialGroups_(store) {
  let groups = tableAll_('material_groups');
  if (!groups.length) {
    tableInsert_('material_groups', DEFAULT_MATERIAL_GROUPS);
    groups = tableAll_('material_groups');
  } else if (
    groups.every(function (g) { return !g.description; }) &&
    groups.some(function (g) { return /^[A-Z0-9]{1,3}$/i.test(g.name || ''); }) &&
    groups.some(function (g) { return String(g.name || '').length > 3; })
  ) {
    const kept = [];
    const removeIds = [];
    let cur = null;
    groups.forEach(function (g) {
      const text = String(g.name || '').trim();
      if (/^[A-Z0-9]{1,3}$/i.test(text)) {
        cur = { id: g.id, name: text, parts: [] };
        kept.push(cur);
      } else if (cur) {
        const part = text.replace(/[.;]+$/, '').trim();
        if (part && cur.parts.indexOf(part) < 0) cur.parts.push(part);
        removeIds.push(g.id);
      }
    });
    if (removeIds.length) {
      updateObjs_('material_groups', kept.map(function (k) {
        return { id: k.id, patch: { description: k.parts.join('; ') || null } };
      }));
      tableDelete_('material_groups', removeIds);
      groups = tableAll_('material_groups');
    }
  }

  const codeByFold = {};
  groups.forEach(function (g) {
    if (g.name) codeByFold[foldKey_(g.name)] = g.name;
  });
  const lookup = Object.assign({}, codeByFold);
  groups.forEach(function (g) {
    String(g.description || '').split(';').forEach(function (seg) {
      const k = foldKey_(seg);
      if (k && !lookup[k]) lookup[k] = g.name;
    });
  });
  Object.keys(LEGACY_GROUP_ALIASES).forEach(function (alias) {
    const target = foldKey_(LEGACY_GROUP_ALIASES[alias]);
    if (codeByFold[target] && !lookup[alias]) lookup[alias] = codeByFold[target];
  });

  const mgCol = store.readCol('lines', 'material_group');
  if (mgCol.length) {
    const upCol = store.readCol('lines', 'updated_at');
    const now = nowStr_();
    let changed = 0;
    for (let i = 0; i < mgCol.length; i++) {
      const raw = mgCol[i] === null || mgCol[i] === undefined ? '' : String(mgCol[i]).trim();
      if (!raw) continue;
      const mapped = lookup[foldKey_(raw)];
      if (mapped && mapped !== raw) {
        mgCol[i] = mapped;
        if (i < upCol.length) upCol[i] = now;
        changed++;
      }
    }
    if (changed > 0) {
      store.writeCol('lines', 'material_group', mgCol);
      if (upCol.length) store.writeCol('lines', 'updated_at', upCol);
    }
  }
}

/**
 * Chạy MỘT LẦN từ trình soạn Apps Script: chọn hàm `setup` → Run.
 * Tạo các tab còn thiếu, seed danh mục mẫu + tài khoản admin (mật khẩu in ra ở Execution log),
 * khởi tạo bộ đếm số phiếu. Chạy lại không làm hỏng/nhân đôi dữ liệu đã có.
 */
function setup() {
  const result = setupStore_(store_());
  if (result.adminPassword) {
    console.log('Tài khoản quản trị: admin / ' + result.adminPassword + '  (đăng nhập rồi đổi mật khẩu ngay)');
  }
  console.log('Xong. Các tab: ' + Object.keys(SCHEMA).join(', '));
}

/**
 * Chỉ tạo các tab + dòng tiêu đề (định dạng chữ), không seed gì.
 * Dùng khi nạp dữ liệu cũ bằng cách dán từ out/db_khoi_tao.xlsx: createTabs → dán dữ liệu → setup.
 */
function createTabs() {
  const store = store_();
  Object.keys(SCHEMA).forEach(function (t) {
    store.ensure(t, SCHEMA[t].map(function (c) { return c[0]; }));
  });
  console.log('Đã tạo tab: ' + Object.keys(SCHEMA).join(', '));
}

/** Cài trigger sao lưu hằng đêm (23:00). Chạy một lần. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightlyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightlyBackup').timeBased().everyDays(1).atHour(23).create();
  console.log('Đã cài sao lưu tự động lúc 23h hằng ngày.');
}

function setupStore_(store) {
  Object.keys(SCHEMA).forEach(function (t) {
    store.ensure(t, SCHEMA[t].map(function (c) { return c[0]; }));
  });
  secret_();
  const ctx = { user: null, audit: [] };
  return withLock_(ctx, function () {
    const out = { adminPassword: null };
    const seedList = function (table, names) {
      if (tableAll_(table).length) return;
      tableInsert_(table, names.map(function (n) { return { name: n }; }));
    };
    seedList('units', ['Phòng Kỹ thuật', 'Xưởng Cơ khí', 'Phòng Kế hoạch vật tư']);
    seedList('uoms', ['Cái', 'Bộ', 'Chiếc', 'Kg', 'Mét', 'Tấm', 'Cây', 'Lít', 'Hộp', 'Cuộn', 'Đôi']);
    migrateMaterialGroups_(store);
    if (!tableAll_('suppliers').length) {
      tableInsert_('suppliers', [{ code: 'KHVT', name: 'Phòng Kế hoạch vật tư', field: 'Nội bộ' }]);
    }
    if (!tableAll_('project_items').length) {
      tableInsert_('project_items', [{ project_code: 'DA01', project_name: 'Dự án mẫu', item_code: 'HM01', item_name: 'Hạng mục mẫu', status: 'Đang làm' }]);
    }
    if (!tableAll_('users').length) {
      out.adminPassword = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
      const salt = newSalt_();
      tableInsert_('users', [{
        username: 'admin', full_name: 'Quản trị', role: 'admin', active: true,
        salt: salt, password_hash: hashPassword_(out.adminPassword, salt), created_at: nowStr_(),
      }]);
    }
    Object.keys(CONFIG.INITIAL_SEQ).forEach(function (year) {
      const key = CONFIG.CODE_PREFIX + year;
      if (!tableAll_('sequences').some(function (s) { return s.key === key; })) {
        seqNext_(key, CONFIG.INITIAL_SEQ[year], 0);
      }
    });
    return out;
  });
}
