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
    seedList('material_groups', ['Thép', 'Bulong - Ốc vít', 'Vật tư điện', 'Sơn - Hóa chất', 'Dụng cụ', 'Bảo hộ lao động']);
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
