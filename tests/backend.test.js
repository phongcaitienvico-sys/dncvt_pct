const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('../dev/gas');

function fresh(nowIso) {
  const b = createBackend(null);
  b.setNow(nowIso || '2026-10-23T08:00:00+07:00');
  const { adminPassword } = b.setup();
  const admin = b.call('login', { username: 'admin', password: adminPassword }).token;
  b.call('users.save', { user: { username: 'nam', full_name: 'Nguyễn Nam', role: 'user', password: 'matkhau123' } }, admin);
  const user = b.call('login', { username: 'nam', password: 'matkhau123' }).token;
  return { b, admin, user, adminPassword };
}

function addLines(b, token, n, extra) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(Object.assign({ key: 'k' + i, name: 'Thép tấm ' + i, uom: 'Tấm', qty_requested: i + 1, unit_price: 1000,
      project_code: 'HM01', project_name: 'Hạng mục 1', delivery_location: 'Xưởng 1', need_date: '2026-10-30' }, extra || {}));
  }
  return b.call('lines.save', { lines }, token).map((r) => r.line);
}

const errCode = (code) => (e) => e.code === code;

test('setup chạy lại không nhân đôi dữ liệu', () => {
  const { b } = fresh();
  const units = b.store.db.tabs.units.rows.length;
  const again = b.setup();
  assert.equal(again.adminPassword, null);
  assert.equal(b.store.db.tabs.units.rows.length, units);
  assert.equal(b.store.db.tabs.users.rows.length, 2);
});

test('đăng nhập sai bị khóa sau 5 lần, token giả bị từ chối', () => {
  const { b } = fresh();
  for (let i = 0; i < 5; i++) assert.throws(() => b.call('login', { username: 'nam', password: 'sai' }), errCode('LOGIN'));
  assert.throws(() => b.call('login', { username: 'nam', password: 'matkhau123' }), errCode('LOCKED'));
  assert.throws(() => b.call('lines.list', {}, 'abc.def'), errCode('AUTH'));
  assert.throws(() => b.call('lines.list', {}), errCode('AUTH'));
});

test('token hết hạn sau TOKEN_TTL_HOURS', () => {
  const { b, user } = fresh();
  b.setNow('2026-10-23T19:59:00+07:00');
  assert.ok(b.call('lines.list', {}, user));
  b.setNow('2026-10-23T20:01:00+07:00');
  assert.throws(() => b.call('lines.list', {}, user), errCode('AUTH'));
});

test('user thường không gọi được thao tác quản trị', () => {
  const { b, user } = fresh();
  assert.throws(() => b.call('users.list', {}, user), errCode('FORBIDDEN'));
  assert.throws(() => b.call('catalog.save', { table: 'units', row: { name: 'X' } }, user), errCode('FORBIDDEN'));
});

test('thêm, sửa, liệt kê dòng; kiểm tra đầu vào', () => {
  const { b, user } = fresh();
  const [l] = addLines(b, user, 1);
  assert.equal(l.id, 1);
  assert.equal(l.created_by, 'nam');
  const [r] = b.call('lines.save', { lines: [{ id: l.id, qty_requested: '7', need_date: '05/11/2026' }] }, user);
  assert.equal(r.line.qty_requested, 7);
  assert.equal(r.line.need_date, '2026-11-05');
  const list = b.call('lines.list', {}, user);
  assert.equal(list.rows.length, 1);
  assert.throws(() => b.call('lines.save', { lines: [{ id: l.id, qty_requested: -1 }] }, user), /không được âm/);
  assert.throws(() => b.call('lines.save', { lines: [{ id: l.id, need_date: '31/02/2026' }] }, user), /ngày hợp lệ/);
  // Trường lạ bị bỏ qua, không ghi đè được số phiếu
  b.call('lines.save', { lines: [{ id: l.id, request_code: 'YC2026-999', created_by: 'hacker' }] }, user);
  const again = b.call('lines.list', {}, user);
  assert.equal(again.rows[0][again.columns.indexOf('request_code')], null);
  assert.equal(again.rows[0][again.columns.indexOf('created_by')], 'nam');
});

test('chuỗi bắt đầu bằng = được lưu như chữ', () => {
  const { b, user } = fresh();
  const [l] = addLines(b, user, 1, { note: '=HYPERLINK("http://x")' });
  assert.equal(l.note, '=HYPERLINK("http://x")');
});

test('cấp số phiếu liên tiếp từ 294 và gán vào dòng', () => {
  const { b, user, admin } = fresh();
  const lines = addLines(b, user, 5);
  const r1 = b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  assert.equal(r1.code, 'YC2026-295');
  const more = addLines(b, user, 2);
  const r2 = b.call('requests.issue', { line_ids: more.map((l) => l.id) }, admin);
  assert.equal(r2.code, 'YC2026-296');
  const list = b.call('lines.list', {}, user);
  const codeIdx = list.columns.indexOf('request_code');
  assert.deepEqual(list.rows.map((r) => r[codeIdx]), ['YC2026-295', 'YC2026-295', 'YC2026-295', 'YC2026-295', 'YC2026-295', 'YC2026-296', 'YC2026-296']);
});

test('100 lần xuất liên tiếp: không trùng, không nhảy số', () => {
  const { b, user } = fresh();
  const lines = addLines(b, user, 100);
  const codes = lines.map((l) => b.call('requests.issue', { line_ids: [l.id] }, user).code);
  assert.equal(new Set(codes).size, 100);
  codes.forEach((c, i) => assert.equal(c, 'YC2026-' + (295 + i)));
});

test('lỗi kiểm tra không tiêu tốn số phiếu', () => {
  const { b, user } = fresh();
  const [a] = addLines(b, user, 1);
  const [bad] = b.call('lines.save', { lines: [{ key: 'x', name: '' }] }, user).map((r) => r.line);
  assert.throws(() => b.call('requests.issue', { line_ids: [bad.id] }, user), errCode('INVALID'));
  assert.throws(() => b.call('requests.issue', { line_ids: [999] }, user), errCode('NOT_FOUND'));
  b.call('requests.issue', { line_ids: [a.id] }, user);
  assert.throws(() => b.call('requests.issue', { line_ids: [a.id] }, user), errCode('ALREADY_ISSUED'));
  const [c] = addLines(b, user, 1);
  assert.equal(b.call('requests.issue', { line_ids: [c.id] }, user).code, 'YC2026-296');
});

test('khác hạng mục / nơi giao → cần xác nhận', () => {
  const { b, user } = fresh();
  const a = addLines(b, user, 3);
  const c = addLines(b, user, 2, { project_code: 'HM02', project_name: 'Hạng mục 2' });
  const ids = a.concat(c).map((l) => l.id);
  assert.throws(() => b.call('requests.issue', { line_ids: ids }, user), (e) => {
    assert.equal(e.code, 'MIXED');
    assert.equal(e.message, '5 dòng thuộc 2 hạng mục, vẫn gộp vào 1 phiếu?');
    return true;
  });
  assert.equal(b.call('requests.issue', { line_ids: ids, confirm_mixed: true }, user).code, 'YC2026-295');
});

test('bỏ qua số đã có sẵn trong dữ liệu import (YC2026-295)', () => {
  const { b, user } = fresh();
  const headers = b.store.db.tabs.requests.headers;
  b.store.db.tabs.requests.rows.push(headers.map((h) => ({ id: '99', code: 'YC2026-295', year: '2026', seq: '295' }[h] || '')));
  const [l] = addLines(b, user, 1);
  assert.equal(b.call('requests.issue', { line_ids: [l.id] }, user).code, 'YC2026-296');
});

test('năm mới bắt đầu lại từ 001', () => {
  const { b, user } = fresh('2027-01-02T08:00:00+07:00');
  const [l] = addLines(b, user, 1);
  assert.equal(b.call('requests.issue', { line_ids: [l.id] }, user).code, 'YC2027-001');
});

test('khóa tên + số lượng sau khi có phiếu; admin sửa được và có nhật ký', () => {
  const { b, user, admin } = fresh();
  const [l] = addLines(b, user, 1);
  b.call('requests.issue', { line_ids: [l.id] }, user);
  assert.throws(() => b.call('lines.save', { lines: [{ id: l.id, name: 'Đổi tên' }] }, user), errCode('LOCKED_FIELD'));
  assert.throws(() => b.call('lines.save', { lines: [{ id: l.id, qty_requested: 99 }] }, user), errCode('LOCKED_FIELD'));
  // Gửi lại đúng giá trị cũ thì không coi là sửa
  b.call('lines.save', { lines: [{ id: l.id, name: l.name, purpose: 'Sửa máy' }] }, user);
  b.call('lines.save', { lines: [{ id: l.id, qty_requested: 99 }] }, admin);
  const log = b.call('audit.list', {}, admin);
  const fields = log.filter((a) => a.table === 'lines').map((a) => a.field + ':' + a.user);
  assert.ok(fields.includes('purpose:nam'));
  assert.ok(fields.includes('qty_requested:admin'));
  assert.throws(() => b.call('lines.delete', { ids: [l.id] }, admin), errCode('HAS_REQUEST'));
});

test('in lại ra đúng số và đầu phiếu cũ dù danh mục đổi', () => {
  const { b, user, admin } = fresh();
  const lines = addLines(b, user, 2, { unit: 'Phòng Kỹ thuật' });
  const { code } = b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  const before = b.call('requests.get', { codes: [code] }, user)[0];
  const unit = b.call('bootstrap', {}, admin).catalogs.units.find((u) => u.name === 'Phòng Kỹ thuật');
  b.call('catalog.save', { table: 'units', row: { id: unit.id, name: 'Phòng KT mới' } }, admin);
  b.call('lines.save', { lines: [{ id: lines[0].id, unit: 'Phòng KT mới' }] }, user);
  const after = b.call('requests.get', { codes: [code.toLowerCase()] }, user)[0];
  assert.equal(after.request.code, code);
  assert.deepEqual(after.request.header_json, before.request.header_json);
  assert.equal(after.request.header_json.unit, 'Phòng Kỹ thuật');
  assert.equal(after.lines.length, 2);
});

test('xóa và nhân bản dòng', () => {
  const { b, user } = fresh();
  const lines = addLines(b, user, 3);
  const copies = b.call('lines.duplicate', { ids: [lines[0].id] }, user);
  assert.equal(copies[0].name, lines[0].name);
  assert.equal(copies[0].request_code, null);
  assert.equal(b.call('lines.delete', { ids: [lines[1].id, copies[0].id] }, user).deleted, 2);
  assert.equal(b.call('lines.list', {}, user).rows.length, 2);
  // id không dùng lại sau khi xóa
  assert.equal(addLines(b, user, 1)[0].id, 5);
});

test('nhận hàng nhiều đợt cộng dồn', () => {
  const { b, user, admin } = fresh();
  const [l] = addLines(b, user, 1, { qty_requested: 10 });
  b.call('receipts.add', { line_id: l.id, qty: 4, received_date: '2026-10-24' }, user);
  const r = b.call('receipts.add', { line_id: l.id, qty: 6, received_date: '2026-10-26' }, user);
  assert.equal(r.line.qty_received, 10);
  assert.equal(r.line.last_received_date, '2026-10-26');
  assert.throws(() => b.call('receipts.add', { line_id: l.id, qty: 0 }, user), /lớn hơn 0/);
  const recs = b.call('receipts.list', { line_id: l.id }, user);
  assert.equal(recs.length, 2);
  assert.throws(() => b.call('receipts.delete', { id: recs[0].id }, user), errCode('FORBIDDEN'));
  assert.equal(b.call('receipts.delete', { id: recs[0].id }, admin).line.qty_received, 6);
});

test('đổi mật khẩu', () => {
  const { b, user } = fresh();
  assert.throws(() => b.call('auth.changePassword', { old_password: 'sai', new_password: 'abcdefgh' }, user), /không đúng/);
  b.call('auth.changePassword', { old_password: 'matkhau123', new_password: 'moi12345' }, user);
  assert.ok(b.call('login', { username: 'nam', password: 'moi12345' }).token);
});

test('form thêm nhiều vật tư: tạo dòng + cấp phiếu trong một lệnh, lỗi không để lại dòng', () => {
  const { b, user } = fresh();
  const common = { unit: 'Phòng Kỹ thuật', project_code: 'HM01', project_name: 'Hạng mục 1', delivery_location: 'Xưởng 1', need_date: '2026-10-30' };
  const items = [{ name: 'Bulong M12', uom: 'Bộ', qty_requested: 10 }, { name: 'Ốc M12', uom: 'Cái', qty_requested: '5', note: 'gấp' }];
  // lỗi: dòng 2 thiếu số lượng → không dòng nào được ghi, không tốn số phiếu
  assert.throws(() => b.call('lines.create', { common, items: [items[0], { name: 'X' }], issue: true }, user), /Dòng 2/);
  assert.equal(b.call('lines.list', {}, user).rows.length, 0);
  const only = b.call('lines.create', { common, items }, user);
  assert.equal(only.code, null);
  assert.equal(only.lines.length, 2);
  assert.equal(only.lines[0].project_code, 'HM01');
  const res = b.call('lines.create', { common, items, issue: true }, user);
  assert.equal(res.code, 'YC2026-295');
  assert.ok(res.lines.every((l) => l.request_code === 'YC2026-295'));
  const list = b.call('lines.list', {}, user);
  const ci = list.columns.indexOf('request_code');
  assert.deepEqual(list.rows.map((r) => r[ci]), [null, null, 'YC2026-295', 'YC2026-295']);
  const header = b.call('requests.get', { codes: ['YC2026-295'] }, user)[0].request.header_json;
  assert.equal(header.unit, 'Phòng Kỹ thuật');
});
