/** Phiếu đề nghị: cấp số, in lại, danh sách. */

function requestCode_(year, seq) {
  let s = String(seq);
  while (s.length < CONFIG.CODE_PAD) s = '0' + s;
  return CONFIG.CODE_PREFIX + year + '-' + s;
}

function distinct_(values) {
  const out = [];
  values.forEach(function (v) {
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

/** Ảnh chụp đầu phiếu lúc xuất — in lại luôn ra đúng nội dung này dù danh mục/dòng thay đổi sau đó. */
function buildHeader_(lines, extra) {
  const join = function (field) {
    return distinct_(lines.map(function (l) { return l[field]; })).filter(String).join('; ');
  };
  const dates = lines.map(function (l) { return l.need_date; }).filter(Boolean).sort();
  return {
    unit: join('unit'),
    project_code: join('project_code'),
    project_name: join('project_name'),
    delivery_location: join('delivery_location'),
    requester: join('requester'),
    request_date: todayStr_(),
    need_date: dates.length ? dates[0] : null,
    note: cleanStr_(extra && extra.note, 'Ghi chú') || '',
  };
}

/** Đọc các dòng sắp đưa vào phiếu và kiểm tra: còn tồn tại, chưa có phiếu, đủ tên + số lượng. */
function issuableLines_(lineIds) {
  const ids = cleanIds_(lineIds);
  if (!ids.length) fail_('Chưa chọn dòng nào.');
  if (ids.length > CONFIG.MAX_LINES_PER_REQUEST) fail_('Một phiếu tối đa ' + CONFIG.MAX_LINES_PER_REQUEST + ' dòng.');
  const found = tableFind_('lines', ids);
  const missing = ids.filter(function (id) { return !found[id]; });
  if (missing.length) fail_('Không tìm thấy dòng #' + missing.join(', #') + ' (có thể đã bị xóa).', 'NOT_FOUND');
  const lines = ids.map(function (id) { return found[id]; }).sort(function (a, b) { return a.id - b.id; });

  const coded = lines.filter(function (l) { return l.request_code; });
  if (coded.length) {
    fail_('Có ' + coded.length + ' dòng đã có số phiếu (' + distinct_(coded.map(function (l) { return l.request_code; })).join(', ') +
      '). Hãy bỏ chọn các dòng này hoặc dùng "In lại".', 'ALREADY_ISSUED', { line_ids: coded.map(function (l) { return l.id; }) });
  }
  const invalid = lines.filter(function (l) { return !l.name || !(l.qty_requested > 0); });
  if (invalid.length) {
    fail_('Dòng #' + invalid.map(function (l) { return l.id; }).join(', #') + ' thiếu tên vật tư hoặc số lượng yêu cầu.', 'INVALID',
      { line_ids: invalid.map(function (l) { return l.id; }) });
  }
  return lines;
}

/** Các dòng khác hạng mục / nơi giao mà chưa xác nhận → lỗi MIXED để client hỏi lại. */
function checkMixed_(lines, confirmed) {
  const projects = distinct_(lines.map(function (l) { return l.project_code || l.project_name; }));
  const locations = distinct_(lines.map(function (l) { return l.delivery_location; }));
  if (!confirmed && (projects.length > 1 || locations.length > 1)) {
    const parts = [];
    if (projects.length > 1) parts.push(projects.length + ' hạng mục');
    if (locations.length > 1) parts.push(locations.length + ' nơi giao');
    fail_(lines.length + ' dòng thuộc ' + parts.join(' và ') + ', vẫn gộp vào 1 phiếu?', 'MIXED',
      { lines: lines.length, projects: projects.length, locations: locations.length });
  }
}

/**
 * Cấp số phiếu mới cho các dòng chưa có phiếu. Chạy trong withLock_ nên 2 người bấm cùng lúc
 * sẽ được xử lý lần lượt → 2 số liên tiếp, không trùng, không nhảy. Mọi kiểm tra chạy TRƯỚC khi tăng số.
 */
function apiRequestsIssue_(p, ctx) {
  const lines = issuableLines_(p.line_ids);
  checkMixed_(lines, p.confirm_mixed);

  const year = Number(Utilities.formatDate(now_(), CONFIG.TIMEZONE, 'yyyy'));
  const existingCodes = {};
  tableAll_('requests').forEach(function (r) { existingCodes[r.code] = true; });
  let seq = seqNext_(CONFIG.CODE_PREFIX + year, CONFIG.INITIAL_SEQ[year] || 0, 1);
  // An toàn: nếu số đã tồn tại (vd. import tay), nhảy tới số trống kế tiếp.
  while (existingCodes[requestCode_(year, seq)]) seq = seqNext_(CONFIG.CODE_PREFIX + year, 0, 1);
  const code = requestCode_(year, seq);
  const now = nowStr_();

  tableInsert_('requests', [{
    code: code, year: year, seq: seq, issued_at: now, issued_by: ctx.user.full_name || ctx.user.username,
    header_json: buildHeader_(lines, p.header), line_count: lines.length, legacy_flag: false,
  }]);
  updateObjs_('lines', lines.map(function (l) { return { id: l.id, patch: { request_code: code, updated_at: now } }; }));
  audit_(ctx, 'requests', code, '(xuất phiếu)', '', lines.map(function (l) { return l.id; }).join(','));
  return { code: code, line_ids: lines.map(function (l) { return l.id; }) };
}

function findRequest_(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) fail_('Chưa nhập số phiếu.');
  const req = tableAll_('requests').find(function (r) { return String(r.code).toUpperCase() === c; });
  if (!req) fail_('Không tìm thấy phiếu ' + c + '.', 'NOT_FOUND');
  return req;
}

/** Kiểm tra trước khi thêm `lines` vào phiếu `code` (chạy trước mọi lệnh ghi). Trả {req, current: các dòng đang có}. */
function appendCheck_(code, lines, confirmed) {
  const req = findRequest_(code);
  if (req.legacy_flag) fail_('Phiếu ' + req.code + ' là phiếu lịch sử (nhập từ Sheet cũ), không thêm dòng được.');
  const current = tableAll_('lines').filter(function (l) { return l.request_code === req.code; });
  if (current.length + lines.length > CONFIG.MAX_LINES_PER_REQUEST) {
    fail_('Phiếu ' + req.code + ' đã có ' + current.length + ' dòng, thêm ' + lines.length + ' dòng sẽ vượt quá ' + CONFIG.MAX_LINES_PER_REQUEST + ' dòng/phiếu.');
  }
  checkMixed_(current.concat(lines), confirmed);
  return { req: req, current: current };
}

/**
 * Thêm dòng chưa có phiếu vào một phiếu ĐÃ CÓ (quên vật tư sau khi xuất) — giữ nguyên số phiếu, không tốn số mới.
 * Đầu phiếu: giữ ngày đề nghị + ghi chú cũ, chỉ bổ sung đơn vị / hạng mục / nơi giao / người yêu cầu mới (nếu có).
 */
function apiRequestsAppend_(p, ctx) {
  const lines = issuableLines_(p.line_ids);
  const pre = appendCheck_(p.code, lines, p.confirm_mixed);
  const req = pre.req;
  const current = pre.current;
  const now = nowStr_();
  const old = req.header_json || {};
  const added = buildHeader_(lines);
  const header = Object.assign({}, old);
  ['unit', 'project_code', 'project_name', 'delivery_location', 'requester'].forEach(function (f) {
    header[f] = distinct_(String(old[f] || '').split('; ').concat(String(added[f] || '').split('; '))).filter(String).join('; ');
  });
  header.need_date = [old.need_date, added.need_date].filter(Boolean).sort()[0] || null;
  updateObjs_('requests', [{ id: req.id, patch: { header_json: header, line_count: current.length + lines.length } }]);
  updateObjs_('lines', lines.map(function (l) { return { id: l.id, patch: { request_code: req.code, updated_at: now } }; }));
  audit_(ctx, 'requests', req.code, '(thêm dòng vào phiếu)', '', lines.map(function (l) { return l.id; }).join(','));
  return { code: req.code, line_ids: lines.map(function (l) { return l.id; }) };
}

/** Quản trị: gỡ dòng khỏi phiếu (dòng trở lại "chưa có phiếu", giữ nguyên dữ liệu và lần nhận). Số phiếu không cấp lại. */
function apiRequestsDetach_(p, ctx) {
  const ids = cleanIds_(p.line_ids);
  if (!ids.length) fail_('Chưa chọn dòng nào.');
  const found = tableFind_('lines', ids);
  const lines = ids.map(function (id) { return found[id]; }).filter(function (l) { return l && l.request_code; });
  if (!lines.length) fail_('Các dòng đã chọn chưa thuộc phiếu nào.');
  const perCode = {};
  lines.forEach(function (l) { perCode[l.request_code] = (perCode[l.request_code] || 0) + 1; });
  tableAll_('requests').filter(function (r) { return perCode[r.code]; }).forEach(function (r) {
    updateObjs_('requests', [{ id: r.id, patch: { line_count: Math.max(0, (r.line_count || 0) - perCode[r.code]) } }]);
  });
  const now = nowStr_();
  updateObjs_('lines', lines.map(function (l) { return { id: l.id, patch: { request_code: null, updated_at: now } }; }));
  lines.forEach(function (l) { audit_(ctx, 'lines', l.id, 'request_code', l.request_code, '(gỡ khỏi phiếu)'); });
  return { line_ids: lines.map(function (l) { return l.id; }), requests: Object.keys(perCode) };
}

/** Lấy 1 hoặc nhiều phiếu kèm dòng để in. */
function apiRequestsGet_(p) {
  if (!Array.isArray(p.codes) || !p.codes.length) fail_('Chưa có số phiếu.');
  if (p.codes.length > 100) fail_('Tối đa 100 phiếu mỗi lần in.');
  const codes = distinct_(p.codes.map(function (c) { return String(c).trim().toUpperCase(); })).filter(String);
  const reqs = {};
  tableAll_('requests').forEach(function (r) { if (codes.indexOf(String(r.code).toUpperCase()) >= 0) reqs[String(r.code).toUpperCase()] = r; });
  const notFound = codes.filter(function (c) { return !reqs[c]; });
  if (notFound.length) fail_('Không tìm thấy phiếu: ' + notFound.join(', '), 'NOT_FOUND');
  const agg = receiptAgg_();
  const byCode = {};
  tableAll_('lines').forEach(function (l) {
    const c = String(l.request_code || '').toUpperCase();
    if (reqs[c]) (byCode[c] = byCode[c] || []).push(withReceipts_(l, agg));
  });
  return codes.map(function (c) {
    const lines = (byCode[c] || []).sort(function (a, b) { return a.id - b.id; });
    return { request: reqs[c], lines: lines };
  });
}

function apiRequestsList_() {
  const totals = {};
  tableAll_('lines').forEach(function (l) {
    if (!l.request_code) return;
    const t = totals[l.request_code] || (totals[l.request_code] = { count: 0, amount: 0, suppliers: [] });
    t.count++;
    t.amount += (l.qty_requested || 0) * (l.unit_price || 0);
    if (l.supplier && t.suppliers.indexOf(l.supplier) < 0) t.suppliers.push(l.supplier);
  });
  return tableAll_('requests').map(function (r) {
    const t = totals[r.code] || { count: 0, amount: 0, suppliers: [] };
    return Object.assign({}, r, { line_count: t.count, amount: t.amount, suppliers: t.suppliers.join('; ') });
  }).sort(function (a, b) { return String(b.issued_at || '').localeCompare(String(a.issued_at || '')) || (b.id - a.id); });
}
