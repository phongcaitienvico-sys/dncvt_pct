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

/**
 * Cấp số phiếu mới cho các dòng chưa có phiếu. Chạy trong withLock_ nên 2 người bấm cùng lúc
 * sẽ được xử lý lần lượt → 2 số liên tiếp, không trùng, không nhảy. Mọi kiểm tra chạy TRƯỚC khi tăng số.
 */
function apiRequestsIssue_(p, ctx) {
  const ids = cleanIds_(p.line_ids);
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

  const projects = distinct_(lines.map(function (l) { return l.project_code || l.project_name; }));
  const locations = distinct_(lines.map(function (l) { return l.delivery_location; }));
  if (!p.confirm_mixed && (projects.length > 1 || locations.length > 1)) {
    const parts = [];
    if (projects.length > 1) parts.push(projects.length + ' hạng mục');
    if (locations.length > 1) parts.push(locations.length + ' nơi giao');
    fail_(lines.length + ' dòng thuộc ' + parts.join(' và ') + ', vẫn gộp vào 1 phiếu?', 'MIXED',
      { lines: lines.length, projects: projects.length, locations: locations.length });
  }

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
