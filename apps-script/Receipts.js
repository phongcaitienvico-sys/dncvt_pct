/** Nhận hàng nhiều đợt (tab `receipts`). */

function apiReceiptsAdd_(p, ctx) {
  const lineId = cleanIds_([p.line_id])[0];
  const qty = cleanNum_(p.qty, 'Số lượng nhận');
  if (!(qty > 0)) fail_('Số lượng nhận phải lớn hơn 0.');
  const date = cleanDate_(p.received_date, 'Ngày nhận') || todayStr_();
  const line = tableFind_('lines', [lineId])[lineId];
  if (!line) fail_('Không tìm thấy dòng #' + lineId, 'NOT_FOUND');
  const rec = tableInsert_('receipts', [{
    line_id: lineId, received_date: date, qty: qty, received_by: ctx.user.full_name || ctx.user.username,
    note: cleanStr_(p.note, 'Ghi chú'), created_at: nowStr_(),
  }])[0];
  return { receipt: rec, line: withReceipts_(line, receiptAgg_()) };
}

function apiReceiptsList_(p) {
  const lineId = cleanIds_([p.line_id])[0];
  return tableAll_('receipts').filter(function (r) { return r.line_id === lineId; })
    .sort(function (a, b) { return String(a.received_date).localeCompare(String(b.received_date)) || a.id - b.id; });
}

/** Nhập nhầm thì tự sửa được: người thường xóa lần nhận của chính mình, ghi trong hôm nay. */
function canDeleteReceipt_(rec, user) {
  if (user.role === 'admin') return true;
  const me = user.full_name || user.username;
  return rec.received_by === me && String(rec.created_at || '').slice(0, 10) === todayStr_();
}

function apiReceiptsDelete_(p, ctx) {
  const id = cleanIds_([p.id])[0];
  const rec = tableFind_('receipts', [id])[id];
  if (!rec) fail_('Không tìm thấy lần nhận #' + id, 'NOT_FOUND');
  if (!canDeleteReceipt_(rec, ctx.user)) {
    fail_('Chỉ Quản trị, hoặc chính người ghi nhận trong ngày, được xóa lần nhận này.', 'FORBIDDEN');
  }
  tableDelete_('receipts', [id]);
  audit_(ctx, 'receipts', id, '(xóa lần nhận)', JSON.stringify(rec), '');
  const line = tableFind_('lines', [rec.line_id])[rec.line_id];
  return { line: line ? withReceipts_(line, receiptAgg_()) : null };
}
