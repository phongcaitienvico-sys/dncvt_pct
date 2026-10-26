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
  assert.throws(() => b.call('lines.delete', { ids: [l.id] }, user), errCode('HAS_REQUEST')); // người dùng thường bị chặn
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
  const { b, user, adminPassword } = fresh();
  let admin = b.call('login', { username: 'admin', password: adminPassword }).token;
  const [l] = addLines(b, user, 1, { qty_requested: 10 });
  b.call('receipts.add', { line_id: l.id, qty: 4, received_date: '2026-10-24' }, user);
  const r = b.call('receipts.add', { line_id: l.id, qty: 6, received_date: '2026-10-26' }, user);
  assert.equal(r.line.qty_received, 10);
  assert.equal(r.line.last_received_date, '2026-10-26');
  assert.throws(() => b.call('receipts.add', { line_id: l.id, qty: 0 }, user), /lớn hơn 0/);
  const recs = b.call('receipts.list', { line_id: l.id }, user);
  assert.equal(recs.length, 2);
  // người ghi nhận tự xóa được lần nhận của mình trong ngày; sang hôm sau thì chỉ Quản trị
  assert.equal(b.call('receipts.delete', { id: recs[0].id }, user).line.qty_received, 6);
  b.setNow('2026-10-24T08:00:00+07:00');
  const user2 = b.call('login', { username: 'nam', password: 'matkhau123' }).token;
  admin = b.call('login', { username: 'admin', password: adminPassword }).token;
  assert.throws(() => b.call('receipts.delete', { id: recs[1].id }, user2), errCode('FORBIDDEN'));
  assert.equal(b.call('receipts.delete', { id: recs[1].id }, admin).line.qty_received, 0);
  const r3 = b.call('receipts.add', { line_id: l.id, qty: 1 }, admin).receipt;
  assert.throws(() => b.call('receipts.delete', { id: r3.id }, user2), errCode('FORBIDDEN'));
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

test('lines.sync: lần đầu đủ dòng, lần sau chỉ phần đổi + id còn lại + tổng nhận hàng', () => {
  const { b, user } = fresh();
  const lines = addLines(b, user, 4, { qty_requested: 5 });
  const first = b.call('lines.sync', {}, user);
  assert.equal(first.full, true);
  assert.equal(first.rows.length, 4);
  assert.deepEqual(first.ids, lines.map((l) => l.id));

  // trong vòng 2 phút sau lần ghi vẫn gửi lại (biên an toàn); sau đó không đổi gì → không có dòng nào, vẫn trả đủ id
  b.setNow('2026-10-23T08:01:00+07:00');
  assert.equal(b.call('lines.sync', { since: first.now }, user).rows.length, 4);
  b.setNow('2026-10-23T09:00:00+07:00');
  const none = b.call('lines.sync', { since: '2026-10-23T08:30:00' }, user);
  assert.equal(none.rows.length, 0);
  assert.equal(none.ids.length, 4);

  // sửa 1 dòng, xóa 1 dòng, nhận hàng 1 dòng
  b.setNow('2026-10-23T09:30:00+07:00');
  b.call('lines.save', { lines: [{ id: lines[0].id, purpose: 'Mới sửa' }] }, user);
  b.call('lines.delete', { ids: [lines[3].id] }, user);
  b.call('receipts.add', { line_id: lines[1].id, qty: 2, received_date: '2026-10-23' }, user);
  const delta = b.call('lines.sync', { since: none.now }, user);
  const pi = delta.columns.indexOf('purpose');
  assert.equal(delta.full, false);
  assert.deepEqual(delta.rows.map((r) => r[pi]), ['Mới sửa']);
  assert.deepEqual(delta.ids, [lines[0].id, lines[1].id, lines[2].id]); // dòng 4 đã xóa
  assert.deepEqual(delta.recv[lines[1].id], [2, '2026-10-23']);
  assert.throws(() => b.call('lines.sync', { since: 'không phải ngày' }, user), /không hợp lệ/);
});

test('nhân bản dòng: người yêu cầu là người đang đăng nhập', () => {
  const { b, user } = fresh();
  const [l] = addLines(b, user, 1, { requester: 'Người khác' });
  const [copy] = b.call('lines.duplicate', { ids: [l.id] }, user);
  assert.equal(copy.requester, 'Nguyễn Nam');
});

test('lines.sync theo đợt: tháng này + dòng chưa có phiếu trước, phần cũ sau, hai đợt ghép lại đủ', () => {
  const { b, user } = fresh();
  const old1 = addLines(b, user, 2, { request_date: '2026-08-10' });
  const cur = addLines(b, user, 2, { request_date: '2026-10-05' });
  const oldIssued = addLines(b, user, 1, { request_date: '2026-09-01' });
  b.call('requests.issue', { line_ids: oldIssued.map((l) => l.id), confirm_mixed: true }, user);
  b.call('requests.issue', { line_ids: old1.map((l) => l.id), confirm_mixed: true }, user);
  const noCode = addLines(b, user, 1, { request_date: '2026-07-01' }); // cũ nhưng chưa có phiếu → vẫn vào đợt 1
  const recent = b.call('lines.sync', { mode: 'recent', from: '2026-10-01' }, user);
  const older = b.call('lines.sync', { mode: 'older', from: '2026-10-01' }, user);
  const idOf = (r, x) => x.rows.map((row) => row[r.columns.indexOf('id')]);
  assert.equal(recent.partial, true);
  assert.deepEqual(idOf(recent, recent).sort((a, b) => a - b), cur.concat(noCode).map((l) => l.id).sort((a, b) => a - b));
  assert.deepEqual(idOf(older, older).sort((a, b) => a - b), old1.concat(oldIssued).map((l) => l.id).sort((a, b) => a - b));
  assert.equal(recent.rows.length + older.rows.length, 6);
  assert.throws(() => b.call('lines.sync', { mode: 'recent', from: 'xyz' }, user), /không hợp lệ/);
});

test('Quản trị xóa được dòng đã có số phiếu: giảm số dòng của phiếu, xóa lần nhận, ghi nhật ký; phiếu hết dòng vẫn giữ số', () => {
  const { b, user, admin } = fresh();
  const lines = addLines(b, user, 3);
  const { code } = b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  b.call('receipts.add', { line_id: lines[0].id, qty: 1, received_date: '2026-10-24' }, user);
  const res = b.call('lines.delete', { ids: [lines[0].id, lines[1].id] }, admin);
  assert.equal(res.deleted, 2);
  assert.deepEqual(res.requests, [code]);
  assert.equal(res.receipts_removed, 1);
  assert.equal(b.call('receipts.list', { line_id: lines[0].id }, user).length, 0);
  const req = b.call('requests.get', { codes: [code] }, user)[0];
  assert.equal(req.lines.length, 1);
  assert.equal(req.request.line_count, 1);
  const log = b.call('audit.list', {}, admin).filter((a) => a.field === '(xóa dòng)');
  assert.ok(log.some((a) => a.old.includes(code)));
  // xóa nốt: phiếu rỗng nhưng số phiếu không bị cấp lại
  b.call('lines.delete', { ids: [lines[2].id] }, admin);
  assert.equal(b.call('requests.get', { codes: [code] }, user)[0].lines.length, 0);
  const [n] = addLines(b, user, 1);
  assert.equal(b.call('requests.issue', { line_ids: [n.id] }, user).code, 'YC2026-296');
});

test('danh mục nhóm vật tư: setup tạo mã C/E kèm giải thích và catalog.save lưu được cột description', () => {
  const { b, admin } = fresh();
  const groups = b.call('bootstrap', {}, admin).catalogs.material_groups;
  assert.deepEqual(groups.map((g) => g.name), ['C', 'E']);
  assert.match(groups[0].description, /Thiết bị, máy móc sản xuất/);
  assert.match(groups[1].description, /Văn phòng phẩm/);

  const added = b.call('catalog.save', {
    table: 'material_groups',
    row: { name: 'A', description: 'Nguyên vật liệu chính' },
  }, admin);
  assert.equal(added.name, 'A');
  assert.equal(added.description, 'Nguyên vật liệu chính');

  const updated = b.call('catalog.save', {
    table: 'material_groups',
    row: { id: added.id, name: 'A', description: 'Nguyên vật liệu sản xuất chính' },
  }, admin);
  assert.equal(updated.description, 'Nguyên vật liệu sản xuất chính');
});

test('setup chuẩn hóa bảng material_groups bị tách dòng và dữ liệu Nhóm VT lịch sử trong Sheet cũ', () => {
  const b = createBackend(null);
  b.setNow('2026-10-26T09:00:00+07:00');
  // Giả lập Sheet đã import theo cấu trúc cũ (chưa có cột description, 9 dòng bị tách rời)
  b.store.db.tabs.material_groups = {
    headers: ['id', 'name'],
    rows: [
      ['1', 'C'],
      ['2', 'Thiết bị, máy móc sản xuất, vật tư cải tạo, chế tạo.'],
      ['3', 'Công cụ, dụng cụ, vật tư phục vụ sửa chữa.'],
      ['4', 'Vật tư phục vụ thi công xây dựng.'],
      ['5', 'E'],
      ['6', 'Văn phòng phẩm'],
      ['7', 'Bảo hộ lao động.'],
      ['8', 'Đá mài, đá cắt'],
      ['9', 'Các vật tư khác'],
    ],
  };
  b.store.db.tabs.lines = {
    headers: ['id', 'request_code', 'name', 'material_group', 'updated_at'],
    rows: [
      ['1', 'YC2020-001', 'Kẹp File còng A4', 'Văn phòng phẩm', '2020-08-27T00:00:00'],
      ['2', 'YC2020-005', 'Thép tấm', 'VT chế tạo', '2020-09-01T00:00:00'],
      ['3', 'YC2022-010', 'Ống thép', 'c', '2022-01-10T00:00:00'],
      ['4', 'YC2026-100', 'Vật tư nhóm riêng', 'A', '2026-10-01T00:00:00'],
    ],
  };

  const { adminPassword } = b.setup();
  const admin = b.call('login', { username: 'admin', password: adminPassword }).token;
  const groups = b.call('bootstrap', {}, admin).catalogs.material_groups;
  assert.deepEqual(groups, [
    {
      id: 1,
      name: 'C',
      description: 'Thiết bị, máy móc sản xuất, vật tư cải tạo, chế tạo; Công cụ, dụng cụ, vật tư phục vụ sửa chữa; Vật tư phục vụ thi công xây dựng',
    },
    {
      id: 5,
      name: 'E',
      description: 'Văn phòng phẩm; Bảo hộ lao động; Đá mài, đá cắt; Các vật tư khác',
    },
  ]);

  const list = b.call('lines.list', {}, admin);
  const mgIdx = list.columns.indexOf('material_group');
  const upIdx = list.columns.indexOf('updated_at');
  assert.deepEqual(list.rows.map((r) => r[mgIdx]), ['E', 'C', 'C', 'A']);
  assert.equal(list.rows[0][upIdx], '2026-10-26T09:00:00');
  assert.equal(list.rows[3][upIdx], '2026-10-01T00:00:00');

  // Sau khi đã chuẩn hóa, quản trị thêm nhóm mới không có giải thích thì chạy lại setup() không được gộp nhầm
  b.call('catalog.save', { table: 'material_groups', row: { name: 'Nhóm dự phòng' } }, admin);
  b.setup();
  assert.deepEqual(b.call('bootstrap', {}, admin).catalogs.material_groups.map((g) => g.name), ['C', 'E', 'Nhóm dự phòng']);
});

test('thêm dòng vào phiếu đã có: giữ số phiếu, không tốn số mới, đầu phiếu bổ sung, kiểm tra trước khi ghi', () => {
  const { b, user, admin } = fresh();
  const common = { unit: 'Phòng Kỹ thuật', project_code: 'HM01', project_name: 'Hạng mục 1', delivery_location: 'Xưởng 1', need_date: '2026-10-30' };
  const items = [1, 2, 3, 4].map((i) => ({ name: 'Vật tư ' + i, uom: 'Cái', qty_requested: i }));
  const first = b.call('lines.create', { common, items, issue: true, header: { note: 'gấp' } }, user);
  assert.equal(first.code, 'YC2026-295');
  // quên 1 vật tư → thêm bằng form vào đúng phiếu cũ
  const more = b.call('lines.create', { common: Object.assign({}, common, { need_date: '2026-10-28' }), items: [{ name: 'Vật tư 5', qty_requested: 5 }], append_code: 'yc2026-295' }, user);
  assert.equal(more.code, 'YC2026-295');
  assert.equal(more.lines[0].request_code, 'YC2026-295');
  const got = b.call('requests.get', { codes: ['YC2026-295'] }, user)[0];
  assert.equal(got.lines.length, 5);
  assert.equal(got.request.line_count, 5);
  assert.equal(got.request.header_json.note, 'gấp');
  assert.equal(got.request.header_json.need_date, '2026-10-28');
  assert.equal(got.request.header_json.unit, 'Phòng Kỹ thuật');
  // thêm dòng đã lưu trên bảng (requests.append); khác hạng mục → hỏi lại; sai số phiếu / dòng đã có phiếu → lỗi
  const [x] = addLines(b, user, 1, { project_code: 'HM02', project_name: 'Hạng mục 2' });
  assert.throws(() => b.call('requests.append', { code: 'YC2026-295', line_ids: [x.id] }, user), errCode('MIXED'));
  assert.throws(() => b.call('requests.append', { code: 'YC2026-999', line_ids: [x.id] }, user), errCode('NOT_FOUND'));
  assert.throws(() => b.call('requests.append', { code: 'YC2026-295', line_ids: [first.lines[0].id] }, user), errCode('ALREADY_ISSUED'));
  assert.equal(b.call('requests.append', { code: 'YC2026-295', line_ids: [x.id], confirm_mixed: true }, user).code, 'YC2026-295');
  const h = b.call('requests.get', { codes: ['YC2026-295'] }, user)[0].request.header_json;
  assert.equal(h.project_code, 'HM01; HM02');
  // form với số phiếu sai / khác hạng mục chưa xác nhận: không ghi dòng nào
  const before = b.call('lines.list', {}, user).rows.length;
  assert.throws(() => b.call('lines.create', { common, items: [{ name: 'Y', qty_requested: 1 }], append_code: 'YC2026-999' }, user), errCode('NOT_FOUND'));
  assert.throws(() => b.call('lines.create', { common: { project_code: 'HM03' }, items: [{ name: 'Y', qty_requested: 1 }], append_code: 'YC2026-295' }, user), errCode('MIXED'));
  assert.equal(b.call('lines.list', {}, user).rows.length, before);
  // không tốn số: phiếu mới tiếp theo vẫn là 296
  const [z] = addLines(b, user, 1);
  assert.equal(b.call('requests.issue', { line_ids: [z.id] }, admin).code, 'YC2026-296');
});

test('Quản trị gỡ dòng khỏi phiếu: dòng về "chưa có phiếu", giữ dữ liệu, có nhật ký; user thường bị chặn', () => {
  const { b, user, admin } = fresh();
  const lines = addLines(b, user, 3);
  b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  assert.throws(() => b.call('requests.detach', { line_ids: [lines[0].id] }, user), errCode('FORBIDDEN'));
  const res = b.call('requests.detach', { line_ids: [lines[0].id] }, admin);
  assert.deepEqual(res.requests, ['YC2026-295']);
  const got = b.call('requests.get', { codes: ['YC2026-295'] }, user)[0];
  assert.equal(got.lines.length, 2);
  assert.equal(got.request.line_count, 2);
  // dòng gỡ ra sửa được và xuất lại vào phiếu khác / thêm lại vào phiếu cũ
  b.call('lines.save', { lines: [{ id: lines[0].id, qty_requested: 9 }] }, user);
  assert.equal(b.call('requests.append', { code: 'YC2026-295', line_ids: [lines[0].id] }, user).code, 'YC2026-295');
  const audit = b.call('audit.list', { q: 'gỡ khỏi phiếu' }, admin);
  assert.equal(audit.length, 1);
});

test('danh mục: không lưu mục trống, không trùng tên; sửa trường khác của mục cũ vẫn được', () => {
  const { b, admin } = fresh();
  assert.throws(() => b.call('catalog.save', { table: 'units', row: { name: '  ' } }, admin), /mục trống/);
  assert.throws(() => b.call('catalog.save', { table: 'project_items', row: { owner: 'Nam' } }, admin), /mục trống/);
  const u = b.call('catalog.save', { table: 'units', row: { name: 'Phòng Thử' } }, admin);
  assert.throws(() => b.call('catalog.save', { table: 'units', row: { name: 'phòng  thử ' } }, admin), errCode('DUPLICATE'));
  assert.throws(() => b.call('catalog.save', { table: 'units', row: { id: u.id, name: '' } }, admin), /mục trống/);
  assert.equal(b.call('catalog.save', { table: 'units', row: { id: u.id, name: 'Phòng Thử' } }, admin).name, 'Phòng Thử');
  const s1 = b.call('catalog.save', { table: 'suppliers', row: { code: 'NCC1', name: 'A' } }, admin);
  assert.throws(() => b.call('catalog.save', { table: 'suppliers', row: { code: 'ncc1', name: 'B' } }, admin), errCode('DUPLICATE'));
  assert.equal(b.call('catalog.save', { table: 'suppliers', row: { id: s1.id, code: 'NCC1', name: 'A mới' } }, admin).name, 'A mới');
  const units = b.call('bootstrap', {}, admin).catalogs.units;
  assert.ok(units.every((x) => x.name));
});
