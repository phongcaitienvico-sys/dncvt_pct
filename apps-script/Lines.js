/** Bảng vật tư chung (tab `lines`). */

const LINE_FIELDS = {
  unit: ['str', 'Đơn vị đề xuất'],
  material_group: ['str', 'Nhóm VT'],
  name: ['str', 'Tên vật tư'],
  uom: ['str', 'ĐVT'],
  qty_requested: ['num', 'SL yêu cầu'],
  qty_on_hand: ['num', 'SL tồn kho'],
  need_date: ['date', 'Ngày cần có'],
  project_code: ['str', 'Mã hạng mục'],
  project_name: ['str', 'Hạng mục'],
  purpose: ['str', 'Mục đích sử dụng'],
  equipment_name: ['str', 'Tên thiết bị'],
  delivery_location: ['str', 'Địa điểm giao'],
  requester: ['str', 'Người yêu cầu'],
  request_date: ['date', 'Ngày yêu cầu'],
  supplier: ['str', 'Nhà CC / Người cấp'],
  unit_price: ['num', 'Đơn giá'],
  note: ['str', 'Ghi chú'],
};

// Sau khi dòng đã có số phiếu, chỉ Quản trị được sửa các trường này.
const LINE_LOCKED_AFTER_ISSUE = ['name', 'qty_requested'];

/** Chỉ giữ các trường cho phép sửa, ép kiểu và kiểm tra. */
function cleanLinePatch_(input) {
  if (!input || typeof input !== 'object') fail_('Dữ liệu dòng không hợp lệ');
  const patch = {};
  Object.keys(LINE_FIELDS).forEach(function (f) {
    if (!(f in input)) return;
    const type = LINE_FIELDS[f][0];
    const label = LINE_FIELDS[f][1];
    patch[f] = type === 'num' ? cleanNum_(input[f], label)
      : type === 'date' ? cleanDate_(input[f], label)
        : cleanStr_(input[f], label);
  });
  return patch;
}

function receiptAgg_() {
  const agg = {};
  tableAll_('receipts').forEach(function (r) {
    const a = agg[r.line_id] || (agg[r.line_id] = { qty: 0, last: null });
    a.qty += r.qty || 0;
    if (r.received_date && (!a.last || r.received_date > a.last)) a.last = r.received_date;
  });
  return agg;
}

function withReceipts_(line, agg) {
  const a = agg[line.id] || { qty: 0, last: null };
  return Object.assign({}, line, { qty_received: Math.round(a.qty * 1000) / 1000, last_received_date: a.last });
}

/** Trả về dạng cột + mảng để gói tin nhỏ (8.000+ dòng). */
function apiLinesList_() {
  const agg = receiptAgg_();
  const cols = SCHEMA.lines.map(function (c) { return c[0]; }).concat(['qty_received', 'last_received_date']);
  const rows = tableAll_('lines').map(function (l) {
    const full = withReceipts_(l, agg);
    return cols.map(function (c) { return full[c]; });
  });
  return { columns: cols, rows: rows };
}

/**
 * Lưu nhiều dòng: có id → cập nhật các trường gửi lên; không id → thêm mới.
 * p.lines = [{id?, key?, ...fields}] ; trả về [{key, line}] để client khớp dòng mới.
 */
function apiLinesSave_(p, ctx) {
  if (!Array.isArray(p.lines) || !p.lines.length) fail_('Không có dòng nào để lưu');
  if (p.lines.length > 2000) fail_('Mỗi lần lưu tối đa 2000 dòng');
  const isAdmin = ctx.user.role === 'admin';
  const now = nowStr_();
  const updates = [];
  const inserts = [];
  p.lines.forEach(function (input) {
    const patch = cleanLinePatch_(input);
    if (input.id) updates.push({ id: Number(input.id), key: input.key, patch: patch });
    else inserts.push({ key: input.key, patch: patch });
  });

  const result = [];
  if (updates.length) {
    const existing = tableFind_('lines', updates.map(function (u) { return u.id; }));
    const patches = [];
    updates.forEach(function (u) {
      const before = existing[u.id];
      if (!before) fail_('Dòng #' + u.id + ' không còn tồn tại (có thể đã bị xóa).', 'NOT_FOUND');
      const changed = Object.keys(u.patch).filter(function (f) { return u.patch[f] !== before[f]; });
      if (before.request_code && !isAdmin) {
        changed.forEach(function (f) {
          if (LINE_LOCKED_AFTER_ISSUE.indexOf(f) >= 0) {
            fail_('Dòng #' + u.id + ' đã thuộc phiếu ' + before.request_code + ': chỉ Quản trị được sửa "' + LINE_FIELDS[f][1] + '".', 'LOCKED_FIELD');
          }
        });
      }
      if (!changed.length) { result.push({ key: u.key, line: before }); return; }
      const patch = { updated_at: now };
      changed.forEach(function (f) {
        patch[f] = u.patch[f];
        if (before.request_code) audit_(ctx, 'lines', u.id, f, before[f], u.patch[f]);
      });
      patches.push({ id: u.id, key: u.key, patch: patch });
    });
    const done = updateObjs_('lines', patches);
    done.forEach(function (d, i) { result.push({ key: patches[i].key, line: d.after }); });
  }

  if (inserts.length) {
    const rows = tableInsert_('lines', inserts.map(function (ins) {
      return Object.assign({ request_code: null, legacy_flag: false }, ins.patch, {
        created_by: ctx.user.username, created_at: now, updated_at: now,
      });
    }));
    rows.forEach(function (r, i) { result.push({ key: inserts[i].key, line: r }); });
  }

  const agg = receiptAgg_();
  return result.map(function (r) { return { key: r.key, line: withReceipts_(r.line, agg) }; });
}

function apiLinesDelete_(p, ctx) {
  const ids = cleanIds_(p.ids);
  const lines = tableFind_('lines', ids);
  ids.forEach(function (id) {
    const l = lines[id];
    if (!l) return;
    if (l.request_code) fail_('Không xóa được dòng #' + id + ' vì đã thuộc phiếu ' + l.request_code + '.', 'HAS_REQUEST');
  });
  ids.forEach(function (id) { if (lines[id]) audit_(ctx, 'lines', id, '(xóa dòng)', lines[id].name, ''); });
  return { deleted: tableDelete_('lines', ids) };
}

/** Nhân bản dòng: chép các trường nhập liệu, không chép số phiếu. */
function apiLinesDuplicate_(p, ctx) {
  const ids = cleanIds_(p.ids);
  const lines = tableFind_('lines', ids);
  const now = nowStr_();
  const copies = ids.filter(function (id) { return lines[id]; }).map(function (id) {
    const copy = { request_code: null, legacy_flag: false, created_by: ctx.user.username, created_at: now, updated_at: now };
    Object.keys(LINE_FIELDS).forEach(function (f) { copy[f] = lines[id][f]; });
    copy.request_date = todayStr_();
    return copy;
  });
  const agg = {};
  return tableInsert_('lines', copies).map(function (l) { return withReceipts_(l, agg); });
}
