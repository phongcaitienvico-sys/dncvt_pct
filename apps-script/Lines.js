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
    copy.requester = ctx.user.full_name || ctx.user.username; // người nhân bản là người yêu cầu của dòng mới
    return copy;
  });
  const agg = {};
  return tableInsert_('lines', copies).map(function (l) { return withReceipts_(l, agg); });
}

/**
 * Form "Thêm vật tư": tạo NHIỀU dòng một lần trong cùng một khóa, tùy chọn cấp số phiếu ngay (issue=true).
 * p.common = các trường chung áp cho mọi dòng; p.items = [{name, uom, qty_requested, qty_on_hand, note, ...}] (trường riêng đè trường chung).
 * Kiểm tra TRƯỚC khi ghi nên lỗi không để lại dòng dở dang hoặc tiêu hao số phiếu.
 */
function apiLinesCreate_(p, ctx) {
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) fail_('Chưa có vật tư nào để thêm.');
  if (items.length > CONFIG.MAX_LINES_PER_REQUEST) fail_('Mỗi lần thêm tối đa ' + CONFIG.MAX_LINES_PER_REQUEST + ' dòng.');
  const common = p.common && typeof p.common === 'object' ? p.common : {};
  const lines = items.map(function (it, i) {
    const merged = Object.assign({}, common);
    Object.keys(it || {}).forEach(function (k) { if (it[k] !== null && it[k] !== undefined && it[k] !== '') merged[k] = it[k]; });
    const clean = cleanLinePatch_(merged);
    if (!clean.name) fail_('Dòng ' + (i + 1) + ': thiếu tên vật tư.');
    if (!(clean.qty_requested > 0)) fail_('Dòng ' + (i + 1) + ' (' + clean.name + '): số lượng phải lớn hơn 0.');
    if (!clean.request_date) clean.request_date = todayStr_();
    return clean;
  });
  const now = nowStr_();
  const rows = tableInsert_('lines', lines.map(function (l) {
    return Object.assign({ request_code: null, legacy_flag: false }, l, { created_by: ctx.user.username, created_at: now, updated_at: now });
  }));
  let code = null;
  if (p.issue) {
    code = apiRequestsIssue_({ line_ids: rows.map(function (r) { return r.id; }), confirm_mixed: true, header: p.header }, ctx).code;
    rows.forEach(function (r) { r.request_code = code; });
  }
  audit_(ctx, 'lines', rows.map(function (r) { return r.id; }).join(','), '(thêm bằng form)', '', rows.length + ' dòng' + (code ? ', phiếu ' + code : ''));
  const agg = receiptAgg_();
  return { code: code, lines: rows.map(function (r) { return withReceipts_(r, agg); }) };
}

/**
 * Đồng bộ danh sách dòng cho client có bản lưu sẵn: chỉ gửi các dòng đổi từ `since`
 * (+ danh sách id hiện có để client biết dòng nào đã bị xóa, + tổng nhận hàng của mọi dòng).
 * since = null → gửi tất cả. Chỉ đọc 2 cột (id, updated_at) rồi đọc đúng các dòng đổi nên nhanh hơn lines.list nhiều.
 */
function apiLinesSync_(p) {
  const nowIso = nowStr_();
  let threshold = null;
  if (p.since) {
    const t = new Date(String(p.since) + '+07:00');
    if (isNaN(t.getTime())) fail_('Mốc đồng bộ không hợp lệ');
    // lùi 2 phút để không sót dòng ghi sát thời điểm đồng bộ trước
    threshold = Utilities.formatDate(new Date(t.getTime() - 120000), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
  }
  const s = store_();
  const idCol = s.readCol('lines', 'id');
  const ids = [];
  const changed = [];
  const partial = p.mode === 'recent' || p.mode === 'older';
  if (partial) {
    // Tải lần đầu theo đợt: 'recent' = dòng từ ngày `from` trở đi + dòng chưa có phiếu/chưa có ngày; 'older' = phần còn lại
    const from = toIsoDate_(p.from);
    if (!from) fail_('Mốc ngày không hợp lệ');
    const rd = s.readCol('lines', 'request_date').map(function (v) { return toIsoDate_(v) || ''; });
    const rc = s.readCol('lines', 'request_code');
    for (let i = 0; i < idCol.length; i++) {
      if (idCol[i] === '' || idCol[i] === null) continue;
      const recent = rc[i] === '' || rc[i] === null || rd[i] === '' || rd[i] >= from;
      if ((p.mode === 'recent') === recent) { ids.push(Number(idCol[i])); changed.push(i); }
    }
  } else if (threshold === null) {
    for (let i = 0; i < idCol.length; i++) { if (idCol[i] !== '' && idCol[i] !== null) { ids.push(Number(idCol[i])); changed.push(i); } }
  } else {
    const upd = s.readCol('lines', 'updated_at').map(function (v) { return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss") : String(v || ''); });
    for (let i = 0; i < idCol.length; i++) {
      if (idCol[i] === '' || idCol[i] === null) continue;
      ids.push(Number(idCol[i]));
      if (upd[i] >= threshold) changed.push(i);
    }
  }
  const cols = SCHEMA.lines.map(function (c) { return c[0]; });
  const got = changed.length ? s.readRowsAt('lines', changed) : { headers: [], rows: [] };
  const rows = got.rows.map(function (r) {
    const o = rowToObj_('lines', got.headers, r);
    return cols.map(function (c) { return o[c]; });
  });
  const recv = {};
  const agg = receiptAgg_();
  Object.keys(agg).forEach(function (k) { recv[k] = [Math.round(agg[k].qty * 1000) / 1000, agg[k].last]; });
  return { now: nowIso, full: threshold === null && !partial, partial: partial, columns: cols, rows: rows, ids: ids, recv: recv };
}
