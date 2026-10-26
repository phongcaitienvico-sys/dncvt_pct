const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseBackend } = require('../dev/supabase_pglite');

let sharedBackendPromise = null;
async function getSharedBackend() {
  if (!sharedBackendPromise) sharedBackendPromise = createSupabaseBackend();
  return sharedBackendPromise;
}

test.after(async () => {
  if (sharedBackendPromise) {
    const b = await sharedBackendPromise;
    await b.close();
  }
});

async function fresh(nowIso) {
  const b = await getSharedBackend();
  await b.reset();
  await b.setNow(nowIso || '2026-10-23T08:00:00+07:00');
  const { adminPassword } = await b.setup();
  const admin = (await b.call('login', { username: 'admin', password: adminPassword })).token;
  await b.call('users.save', {
    user: { username: 'nam', full_name: 'Nguyễn Nam', role: 'user', password: 'matkhau123' },
  }, admin);
  const user = (await b.call('login', { username: 'nam', password: 'matkhau123' })).token;
  return { b, admin, user, adminPassword };
}

async function addLines(b, token, n, extra) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(Object.assign({
      key: 'k' + i,
      name: 'Thép tấm ' + i,
      uom: 'Tấm',
      qty_requested: i + 1,
      unit_price: 1000,
      project_code: 'HM01',
      project_name: 'Hạng mục 1',
      delivery_location: 'Xưởng 1',
      need_date: '2026-10-30',
    }, extra || {}));
  }
  return (await b.call('lines.save', { lines }, token)).map((r) => r.line);
}

const errCode = (code) => (e) => e.code === code;

// ============================================================================
// PHẦN 1: 29 KỊCH BẢN NGHIỆP VỤ TƯƠNG ĐƯƠNG tests/backend.test.js TRÊN POSTGRES
// ============================================================================

test('1. setup chạy lại không nhân đôi dữ liệu', async () => {
  const { b, admin } = await fresh();
  const unitsBefore = (await b.call('bootstrap', {}, admin)).catalogs.units.length;
  const again = await b.setup();
  assert.equal(again.adminPassword, null);
  const unitsAfter = (await b.call('bootstrap', {}, admin)).catalogs.units.length;
  assert.equal(unitsAfter, unitsBefore);
  assert.equal((await b.call('users.list', {}, admin)).length, 2);
});

test('2. đăng nhập sai bị khóa sau 5 lần, token giả bị từ chối', async () => {
  const { b } = await fresh();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => b.call('login', { username: 'nam', password: 'sai' }), errCode('LOGIN'));
  }
  await assert.rejects(() => b.call('login', { username: 'nam', password: 'matkhau123' }), errCode('LOCKED'));
  await assert.rejects(() => b.call('lines.list', {}, 'abc.def'), errCode('AUTH'));
  await assert.rejects(() => b.call('lines.list', {}), errCode('AUTH'));
});

test('3. token hết hạn sau TOKEN_TTL_HOURS', async () => {
  const { b, user } = await fresh();
  await b.setNow('2026-10-23T19:59:00+07:00');
  assert.ok(await b.call('lines.list', {}, user));
  await b.setNow('2026-10-23T20:01:00+07:00');
  await assert.rejects(() => b.call('lines.list', {}, user), errCode('AUTH'));
});

test('4. user thường không gọi được thao tác quản trị', async () => {
  const { b, user } = await fresh();
  await assert.rejects(() => b.call('users.list', {}, user), errCode('FORBIDDEN'));
  await assert.rejects(() => b.call('catalog.save', { table: 'units', row: { name: 'X' } }, user), errCode('FORBIDDEN'));
});

test('5. thêm, sửa, liệt kê dòng; kiểm tra đầu vào', async () => {
  const { b, user } = await fresh();
  const [l] = await addLines(b, user, 1);
  assert.equal(l.id, 1);
  assert.equal(l.created_by, 'nam');
  const [r] = await b.call('lines.save', { lines: [{ id: l.id, qty_requested: '7', need_date: '05/11/2026' }] }, user);
  assert.equal(r.line.qty_requested, 7);
  assert.equal(r.line.need_date, '2026-11-05');
  const list = await b.call('lines.list', {}, user);
  assert.equal(list.rows.length, 1);
  await assert.rejects(() => b.call('lines.save', { lines: [{ id: l.id, qty_requested: -1 }] }, user), /không được âm/);
  await assert.rejects(() => b.call('lines.save', { lines: [{ id: l.id, need_date: '31/02/2026' }] }, user), /ngày hợp lệ/);
  await assert.rejects(() => b.call('lines.save', { lines: [{ id: l.id, need_date: '2026-02-31' }] }, user), /ngày hợp lệ/);
  // Trường lạ bị bỏ qua, không ghi đè được số phiếu
  await b.call('lines.save', { lines: [{ id: l.id, request_code: 'YC2026-999', created_by: 'hacker' }] }, user);
  const again = await b.call('lines.list', {}, user);
  assert.equal(again.rows[0][again.columns.indexOf('request_code')], null);
  assert.equal(again.rows[0][again.columns.indexOf('created_by')], 'nam');
});

test('6. chuỗi bắt đầu bằng = được lưu như chữ', async () => {
  const { b, user } = await fresh();
  const [l] = await addLines(b, user, 1, { note: '=HYPERLINK("http://x")' });
  assert.equal(l.note, '=HYPERLINK("http://x")');
});

test('7. cấp số phiếu liên tiếp từ 294 và gán vào dòng', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addLines(b, user, 5);
  const r1 = await b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  assert.equal(r1.code, 'YC2026-295');
  const more = await addLines(b, user, 2);
  const r2 = await b.call('requests.issue', { line_ids: more.map((l) => l.id) }, admin);
  assert.equal(r2.code, 'YC2026-296');
  const list = await b.call('lines.list', {}, user);
  const codeIdx = list.columns.indexOf('request_code');
  assert.deepEqual(
    list.rows.map((r) => r[codeIdx]),
    ['YC2026-295', 'YC2026-295', 'YC2026-295', 'YC2026-295', 'YC2026-295', 'YC2026-296', 'YC2026-296']
  );
});

test('8. 100 lần xuất liên tiếp: không trùng, không nhảy số', async () => {
  const { b, user } = await fresh();
  const lines = await addLines(b, user, 100);
  const codes = [];
  for (const l of lines) {
    codes.push((await b.call('requests.issue', { line_ids: [l.id] }, user)).code);
  }
  assert.equal(new Set(codes).size, 100);
  codes.forEach((c, i) => assert.equal(c, 'YC2026-' + (295 + i)));
});

test('9. lỗi kiểm tra không tiêu tốn số phiếu', async () => {
  const { b, user } = await fresh();
  const [a] = await addLines(b, user, 1);
  const [bad] = (await b.call('lines.save', { lines: [{ key: 'x', name: '' }] }, user)).map((r) => r.line);
  await assert.rejects(() => b.call('requests.issue', { line_ids: [bad.id] }, user), (e) => {
    assert.equal(e.code, 'INVALID');
    assert.deepEqual(e.details, { line_ids: [bad.id] });
    return true;
  });
  await assert.rejects(() => b.call('requests.issue', { line_ids: [999] }, user), errCode('NOT_FOUND'));
  await b.call('requests.issue', { line_ids: [a.id] }, user);
  await assert.rejects(() => b.call('requests.issue', { line_ids: [a.id] }, user), (e) => {
    assert.equal(e.code, 'ALREADY_ISSUED');
    assert.deepEqual(e.details, { line_ids: [a.id] });
    return true;
  });
  const [c] = await addLines(b, user, 1);
  assert.equal((await b.call('requests.issue', { line_ids: [c.id] }, user)).code, 'YC2026-296');
});

test('10. khác hạng mục / nơi giao → cần xác nhận', async () => {
  const { b, user } = await fresh();
  const a = await addLines(b, user, 3);
  const c = await addLines(b, user, 2, { project_code: 'HM02', project_name: 'Hạng mục 2' });
  const ids = a.concat(c).map((l) => l.id);
  await assert.rejects(() => b.call('requests.issue', { line_ids: ids }, user), (e) => {
    assert.equal(e.code, 'MIXED');
    assert.equal(e.message, '5 dòng thuộc 2 hạng mục, vẫn gộp vào 1 phiếu?');
    assert.deepEqual(e.details, { lines: 5, projects: 2, locations: 1 });
    return true;
  });
  assert.equal((await b.call('requests.issue', { line_ids: ids, confirm_mixed: true }, user)).code, 'YC2026-295');
});

test('11. bỏ qua số đã có sẵn trong dữ liệu import (YC2026-295)', async () => {
  const { b, user } = await fresh();
  await b.sqlAsService(
    `INSERT INTO public.requests (id, code, year, seq, legacy_flag) VALUES (99, 'YC2026-295', 2026, 295, false)`
  );
  const [l] = await addLines(b, user, 1);
  assert.equal((await b.call('requests.issue', { line_ids: [l.id] }, user)).code, 'YC2026-296');
});

test('12. năm mới bắt đầu lại từ 001', async () => {
  const { b, user } = await fresh('2027-01-02T08:00:00+07:00');
  const [l] = await addLines(b, user, 1);
  assert.equal((await b.call('requests.issue', { line_ids: [l.id] }, user)).code, 'YC2027-001');
});

test('13. khóa tên + số lượng sau khi có phiếu; admin sửa được và có nhật ký', async () => {
  const { b, user, admin } = await fresh();
  const [l] = await addLines(b, user, 1);
  await b.call('requests.issue', { line_ids: [l.id] }, user);
  await assert.rejects(() => b.call('lines.save', { lines: [{ id: l.id, name: 'Đổi tên' }] }, user), errCode('LOCKED_FIELD'));
  await assert.rejects(() => b.call('lines.save', { lines: [{ id: l.id, qty_requested: 99 }] }, user), errCode('LOCKED_FIELD'));
  // Gửi lại đúng giá trị cũ thì không coi là sửa
  await b.call('lines.save', { lines: [{ id: l.id, name: l.name, purpose: 'Sửa máy' }] }, user);
  await b.call('lines.save', { lines: [{ id: l.id, qty_requested: 99 }] }, admin);
  const log = await b.call('audit.list', {}, admin);
  const fields = log.filter((a) => a.table === 'lines').map((a) => a.field + ':' + a.user);
  assert.ok(fields.includes('purpose:nam'));
  assert.ok(fields.includes('qty_requested:admin'));
  await assert.rejects(() => b.call('lines.delete', { ids: [l.id] }, user), errCode('HAS_REQUEST'));
});

test('14. in lại ra đúng số và đầu phiếu cũ dù danh mục đổi', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addLines(b, user, 2, { unit: 'Phòng Kỹ thuật' });
  const { code } = await b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  const before = (await b.call('requests.get', { codes: [code] }, user))[0];
  const unit = (await b.call('bootstrap', {}, admin)).catalogs.units.find((u) => u.name === 'Phòng Kỹ thuật');
  await b.call('catalog.save', { table: 'units', row: { id: unit.id, name: 'Phòng KT mới' } }, admin);
  await b.call('lines.save', { lines: [{ id: lines[0].id, unit: 'Phòng KT mới' }] }, user);
  const after = (await b.call('requests.get', { codes: [code.toLowerCase()] }, user))[0];
  assert.equal(after.request.code, code);
  assert.deepEqual(after.request.header_json, before.request.header_json);
  assert.equal(after.request.header_json.unit, 'Phòng Kỹ thuật');
  assert.equal(after.lines.length, 2);
});

test('15. xóa và nhân bản dòng', async () => {
  const { b, user } = await fresh();
  const lines = await addLines(b, user, 3);
  const copies = await b.call('lines.duplicate', { ids: [lines[0].id] }, user);
  assert.equal(copies[0].name, lines[0].name);
  assert.equal(copies[0].request_code, null);
  assert.equal((await b.call('lines.delete', { ids: [lines[1].id, copies[0].id] }, user)).deleted, 2);
  assert.equal((await b.call('lines.list', {}, user)).rows.length, 2);
  // id không dùng lại sau khi xóa
  assert.equal((await addLines(b, user, 1))[0].id, 5);
});

test('16. nhận hàng nhiều đợt cộng dồn', async () => {
  const { b, user, adminPassword } = await fresh();
  let admin = (await b.call('login', { username: 'admin', password: adminPassword })).token;
  const [l] = await addLines(b, user, 1, { qty_requested: 10 });
  await b.call('receipts.add', { line_id: l.id, qty: 4, received_date: '2026-10-24' }, user);
  const r = await b.call('receipts.add', { line_id: l.id, qty: 6, received_date: '2026-10-26' }, user);
  assert.equal(r.line.qty_received, 10);
  assert.equal(r.line.last_received_date, '2026-10-26');
  await assert.rejects(() => b.call('receipts.add', { line_id: l.id, qty: 0 }, user), /lớn hơn 0/);
  const recs = await b.call('receipts.list', { line_id: l.id }, user);
  assert.equal(recs.length, 2);
  // người ghi nhận tự xóa được lần nhận của mình trong ngày; sang hôm sau thì chỉ Quản trị
  assert.equal((await b.call('receipts.delete', { id: recs[0].id }, user)).line.qty_received, 6);
  await b.setNow('2026-10-24T08:00:00+07:00');
  const user2 = (await b.call('login', { username: 'nam', password: 'matkhau123' })).token;
  admin = (await b.call('login', { username: 'admin', password: adminPassword })).token;
  await assert.rejects(() => b.call('receipts.delete', { id: recs[1].id }, user2), errCode('FORBIDDEN'));
  assert.equal((await b.call('receipts.delete', { id: recs[1].id }, admin)).line.qty_received, 0);
  const r3 = (await b.call('receipts.add', { line_id: l.id, qty: 1 }, admin)).receipt;
  await assert.rejects(() => b.call('receipts.delete', { id: r3.id }, user2), errCode('FORBIDDEN'));
});

test('17. đổi mật khẩu', async () => {
  const { b, user } = await fresh();
  await assert.rejects(
    () => b.call('auth.changePassword', { old_password: 'sai', new_password: 'abcdefgh' }, user),
    /không đúng/
  );
  await b.call('auth.changePassword', { old_password: 'matkhau123', new_password: 'moi12345' }, user);
  assert.ok((await b.call('login', { username: 'nam', password: 'moi12345' })).token);
});

test('18. form thêm nhiều vật tư: tạo dòng + cấp phiếu trong một lệnh, lỗi không để lại dòng', async () => {
  const { b, user } = await fresh();
  const common = {
    unit: 'Phòng Kỹ thuật',
    project_code: 'HM01',
    project_name: 'Hạng mục 1',
    delivery_location: 'Xưởng 1',
    need_date: '2026-10-30',
  };
  const items = [
    { name: 'Bulong M12', uom: 'Bộ', qty_requested: 10 },
    { name: 'Ốc M12', uom: 'Cái', qty_requested: '5', note: 'gấp' },
  ];
  // lỗi: dòng 2 thiếu số lượng → không dòng nào được ghi, không tốn số phiếu
  await assert.rejects(
    () => b.call('lines.create', { common, items: [items[0], { name: 'X' }], issue: true }, user),
    /Dòng 2/
  );
  assert.equal((await b.call('lines.list', {}, user)).rows.length, 0);
  const only = await b.call('lines.create', { common, items }, user);
  assert.equal(only.code, null);
  assert.equal(only.lines.length, 2);
  assert.equal(only.lines[0].project_code, 'HM01');
  const res = await b.call('lines.create', { common, items, issue: true }, user);
  assert.equal(res.code, 'YC2026-295');
  assert.ok(res.lines.every((l) => l.request_code === 'YC2026-295'));
  const list = await b.call('lines.list', {}, user);
  const ci = list.columns.indexOf('request_code');
  assert.deepEqual(list.rows.map((r) => r[ci]), [null, null, 'YC2026-295', 'YC2026-295']);
  const header = (await b.call('requests.get', { codes: ['YC2026-295'] }, user))[0].request.header_json;
  assert.equal(header.unit, 'Phòng Kỹ thuật');
});

test('19. lines.sync: lần đầu đủ dòng, lần sau chỉ phần đổi + id còn lại + tổng nhận hàng (trigger receipts chạm updated_at)', async () => {
  const { b, user } = await fresh();
  const lines = await addLines(b, user, 4, { qty_requested: 5 });
  const first = await b.call('lines.sync', {}, user);
  assert.equal(first.full, true);
  assert.equal(first.rows.length, 4);
  assert.deepEqual(first.ids, lines.map((l) => l.id));

  // trong vòng 2 phút sau lần ghi vẫn gửi lại (biên an toàn); sau đó không đổi gì → không có dòng nào, vẫn trả đủ id
  await b.setNow('2026-10-23T08:01:00+07:00');
  assert.equal((await b.call('lines.sync', { since: first.now }, user)).rows.length, 4);
  await b.setNow('2026-10-23T09:00:00+07:00');
  const none = await b.call('lines.sync', { since: '2026-10-23T08:30:00' }, user);
  assert.equal(none.rows.length, 0);
  assert.equal(none.ids.length, 4);

  // sửa 1 dòng, xóa 1 dòng, nhận hàng 1 dòng (trigger receipts chạm updated_at của dòng nhận hàng)
  await b.setNow('2026-10-23T09:30:00+07:00');
  await b.call('lines.save', { lines: [{ id: lines[0].id, purpose: 'Mới sửa' }] }, user);
  await b.call('lines.delete', { ids: [lines[3].id] }, user);
  await b.call('receipts.add', { line_id: lines[1].id, qty: 2, received_date: '2026-10-23' }, user);
  const delta = await b.call('lines.sync', { since: none.now }, user);
  const idIdx = delta.columns.indexOf('id');
  const pi = delta.columns.indexOf('purpose');
  assert.equal(delta.full, false);
  assert.deepEqual(delta.rows.map((r) => r[idIdx]), [lines[0].id, lines[1].id]);
  assert.equal(delta.rows[0][pi], 'Mới sửa');
  assert.deepEqual(delta.ids, [lines[0].id, lines[1].id, lines[2].id]); // dòng 4 đã xóa
  assert.deepEqual(delta.recv[lines[1].id], [2, '2026-10-23']);
  await assert.rejects(() => b.call('lines.sync', { since: 'không phải ngày' }, user), /không hợp lệ/);
});

test('20. nhân bản dòng: người yêu cầu là người đang đăng nhập', async () => {
  const { b, user } = await fresh();
  const [l] = await addLines(b, user, 1, { requester: 'Người khác' });
  const [copy] = await b.call('lines.duplicate', { ids: [l.id] }, user);
  assert.equal(copy.requester, 'Nguyễn Nam');
});

test('21. lines.sync theo đợt: tháng này + dòng chưa có phiếu trước, phần cũ sau, hai đợt ghép lại đủ', async () => {
  const { b, user } = await fresh();
  const old1 = await addLines(b, user, 2, { request_date: '2026-08-10' });
  const cur = await addLines(b, user, 2, { request_date: '2026-10-05' });
  const oldIssued = await addLines(b, user, 1, { request_date: '2026-09-01' });
  await b.call('requests.issue', { line_ids: oldIssued.map((l) => l.id), confirm_mixed: true }, user);
  await b.call('requests.issue', { line_ids: old1.map((l) => l.id), confirm_mixed: true }, user);
  const noCode = await addLines(b, user, 1, { request_date: '2026-07-01' }); // cũ nhưng chưa có phiếu → vẫn vào đợt 1
  const recent = await b.call('lines.sync', { mode: 'recent', from: '2026-10-01' }, user);
  const older = await b.call('lines.sync', { mode: 'older', from: '2026-10-01' }, user);
  const idOf = (r, x) => x.rows.map((row) => row[r.columns.indexOf('id')]);
  assert.equal(recent.partial, true);
  assert.deepEqual(
    idOf(recent, recent).sort((a, b2) => a - b2),
    cur.concat(noCode).map((l) => l.id).sort((a, b2) => a - b2)
  );
  assert.deepEqual(
    idOf(older, older).sort((a, b2) => a - b2),
    old1.concat(oldIssued).map((l) => l.id).sort((a, b2) => a - b2)
  );
  assert.equal(recent.rows.length + older.rows.length, 6);
  await assert.rejects(() => b.call('lines.sync', { mode: 'recent', from: 'xyz' }, user), /không hợp lệ/);
});

test('22. Quản trị xóa được dòng đã có số phiếu: giảm số dòng của phiếu, xóa lần nhận, ghi nhật ký; phiếu hết dòng vẫn giữ số', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addLines(b, user, 3);
  const { code } = await b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  await b.call('receipts.add', { line_id: lines[0].id, qty: 1, received_date: '2026-10-24' }, user);
  const res = await b.call('lines.delete', { ids: [lines[0].id, lines[1].id] }, admin);
  assert.equal(res.deleted, 2);
  assert.deepEqual(res.requests, [code]);
  assert.equal(res.receipts_removed, 1);
  assert.equal((await b.call('receipts.list', { line_id: lines[0].id }, user)).length, 0);
  const req = (await b.call('requests.get', { codes: [code] }, user))[0];
  assert.equal(req.lines.length, 1);
  assert.equal(req.request.line_count, 1);
  const log = (await b.call('audit.list', {}, admin)).filter((a) => a.field === '(xóa dòng)');
  assert.ok(log.some((a) => a.old.includes(code)));
  // xóa nốt: phiếu rỗng nhưng số phiếu không bị cấp lại
  await b.call('lines.delete', { ids: [lines[2].id] }, admin);
  assert.equal((await b.call('requests.get', { codes: [code] }, user))[0].lines.length, 0);
  const [n] = await addLines(b, user, 1);
  assert.equal((await b.call('requests.issue', { line_ids: [n.id] }, user)).code, 'YC2026-296');
});

test('23. danh mục nhóm vật tư: setup tạo mã C/E kèm giải thích và catalog.save lưu được cột description', async () => {
  const { b, admin } = await fresh();
  const groups = (await b.call('bootstrap', {}, admin)).catalogs.material_groups;
  assert.deepEqual(groups.map((g) => g.name), ['C', 'E']);
  assert.match(groups[0].description, /Thiết bị, máy móc sản xuất/);
  assert.match(groups[1].description, /Văn phòng phẩm/);

  const added = await b.call('catalog.save', {
    table: 'material_groups',
    row: { name: 'A', description: 'Nguyên vật liệu chính' },
  }, admin);
  assert.equal(added.name, 'A');
  assert.equal(added.description, 'Nguyên vật liệu chính');

  const updated = await b.call('catalog.save', {
    table: 'material_groups',
    row: { id: added.id, name: 'A', description: 'Nguyên vật liệu sản xuất chính' },
  }, admin);
  assert.equal(updated.description, 'Nguyên vật liệu sản xuất chính');
});

test('24. setup chuẩn hóa bảng material_groups bị tách dòng và dữ liệu Nhóm VT lịch sử trong Sheet cũ', async () => {
  const b = await getSharedBackend();
  await b.reset();
  await b.setNow('2026-10-26T09:00:00+07:00');
  await b.sqlAsService(`
    INSERT INTO public.material_groups (id, name, description) VALUES
      (1, 'C', NULL),
      (2, 'Thiết bị, máy móc sản xuất, vật tư cải tạo, chế tạo.', NULL),
      (3, 'Công cụ, dụng cụ, vật tư phục vụ sửa chữa.', NULL),
      (4, 'Vật tư phục vụ thi công xây dựng.', NULL),
      (5, 'E', NULL),
      (6, 'Văn phòng phẩm', NULL),
      (7, 'Bảo hộ lao động.', NULL),
      (8, 'Đá mài, đá cắt', NULL),
      (9, 'Các vật tư khác', NULL);
    INSERT INTO public.lines (id, request_code, name, material_group, created_at, updated_at) VALUES
      (1, 'YC2020-001', 'Kẹp File còng A4', 'Văn phòng phẩm', '2020-08-27T00:00:00+07:00', '2020-08-27T00:00:00+07:00'),
      (2, 'YC2020-005', 'Thép tấm', 'VT chế tạo', '2020-09-01T00:00:00+07:00', '2020-09-01T00:00:00+07:00'),
      (3, 'YC2022-010', 'Ống thép', 'c', '2022-01-10T00:00:00+07:00', '2022-01-10T00:00:00+07:00'),
      (4, 'YC2026-100', 'Vật tư nhóm riêng', 'A', '2026-10-01T00:00:00+07:00', '2026-10-01T00:00:00+07:00');
  `);

  const { adminPassword } = await b.setup();
  const admin = (await b.call('login', { username: 'admin', password: adminPassword })).token;
  const groups = (await b.call('bootstrap', {}, admin)).catalogs.material_groups;
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

  const list = await b.call('lines.list', {}, admin);
  const mgIdx = list.columns.indexOf('material_group');
  const upIdx = list.columns.indexOf('updated_at');
  assert.deepEqual(list.rows.map((r) => r[mgIdx]), ['E', 'C', 'C', 'A']);
  assert.equal(list.rows[0][upIdx], '2026-10-26T09:00:00');
  assert.equal(list.rows[3][upIdx], '2026-10-01T00:00:00');

  await b.call('catalog.save', { table: 'material_groups', row: { name: 'Nhóm dự phòng' } }, admin);
  await b.setup();
  assert.deepEqual(
    (await b.call('bootstrap', {}, admin)).catalogs.material_groups.map((g) => g.name),
    ['C', 'E', 'Nhóm dự phòng']
  );
});

test('25. thêm dòng vào phiếu đã có: giữ số phiếu, không tốn số mới, đầu phiếu bổ sung, kiểm tra trước khi ghi', async () => {
  const { b, user, admin } = await fresh();
  const common = {
    unit: 'Phòng Kỹ thuật',
    project_code: 'HM01',
    project_name: 'Hạng mục 1',
    delivery_location: 'Xưởng 1',
    need_date: '2026-10-30',
  };
  const items = [1, 2, 3, 4].map((i) => ({ name: 'Vật tư ' + i, uom: 'Cái', qty_requested: i }));
  const first = await b.call('lines.create', { common, items, issue: true, header: { note: 'gấp' } }, user);
  assert.equal(first.code, 'YC2026-295');
  const more = await b.call('lines.create', {
    common: Object.assign({}, common, { need_date: '2026-10-28' }),
    items: [{ name: 'Vật tư 5', qty_requested: 5 }],
    append_code: 'yc2026-295',
  }, user);
  assert.equal(more.code, 'YC2026-295');
  assert.equal(more.lines[0].request_code, 'YC2026-295');
  const got = (await b.call('requests.get', { codes: ['YC2026-295'] }, user))[0];
  assert.equal(got.lines.length, 5);
  assert.equal(got.request.line_count, 5);
  assert.equal(got.request.header_json.note, 'gấp');
  assert.equal(got.request.header_json.need_date, '2026-10-28');
  assert.equal(got.request.header_json.unit, 'Phòng Kỹ thuật');

  const [x] = await addLines(b, user, 1, { project_code: 'HM02', project_name: 'Hạng mục 2' });
  await assert.rejects(() => b.call('requests.append', { code: 'YC2026-295', line_ids: [x.id] }, user), errCode('MIXED'));
  await assert.rejects(() => b.call('requests.append', { code: 'YC2026-999', line_ids: [x.id] }, user), errCode('NOT_FOUND'));
  await assert.rejects(() => b.call('requests.append', { code: 'YC2026-295', line_ids: [first.lines[0].id] }, user), errCode('ALREADY_ISSUED'));
  assert.equal((await b.call('requests.append', { code: 'YC2026-295', line_ids: [x.id], confirm_mixed: true }, user)).code, 'YC2026-295');
  const h = (await b.call('requests.get', { codes: ['YC2026-295'] }, user))[0].request.header_json;
  assert.equal(h.project_code, 'HM01; HM02');

  const before = (await b.call('lines.list', {}, user)).rows.length;
  await assert.rejects(
    () => b.call('lines.create', { common, items: [{ name: 'Y', qty_requested: 1 }], append_code: 'YC2026-999' }, user),
    errCode('NOT_FOUND')
  );
  await assert.rejects(
    () => b.call('lines.create', { common: { project_code: 'HM03' }, items: [{ name: 'Y', qty_requested: 1 }], append_code: 'YC2026-295' }, user),
    errCode('MIXED')
  );
  assert.equal((await b.call('lines.list', {}, user)).rows.length, before);
  const [z] = await addLines(b, user, 1);
  assert.equal((await b.call('requests.issue', { line_ids: [z.id] }, admin)).code, 'YC2026-296');
});

test('26. Quản trị gỡ dòng khỏi phiếu: dòng về "chưa có phiếu", giữ dữ liệu, có nhật ký; user thường bị chặn', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addLines(b, user, 3);
  await b.call('requests.issue', { line_ids: lines.map((l) => l.id) }, user);
  await assert.rejects(() => b.call('requests.detach', { line_ids: [lines[0].id] }, user), errCode('FORBIDDEN'));
  const res = await b.call('requests.detach', { line_ids: [lines[0].id] }, admin);
  assert.deepEqual(res.requests, ['YC2026-295']);
  const got = (await b.call('requests.get', { codes: ['YC2026-295'] }, user))[0];
  assert.equal(got.lines.length, 2);
  assert.equal(got.request.line_count, 2);
  await b.call('lines.save', { lines: [{ id: lines[0].id, qty_requested: 9 }] }, user);
  assert.equal((await b.call('requests.append', { code: 'YC2026-295', line_ids: [lines[0].id] }, user)).code, 'YC2026-295');
  const audit = await b.call('audit.list', { q: 'gỡ khỏi phiếu' }, admin);
  assert.equal(audit.length, 1);
});

test('27. danh mục: không lưu mục trống, không trùng tên; sửa trường khác của mục cũ vẫn được', async () => {
  const { b, admin } = await fresh();
  await assert.rejects(() => b.call('catalog.save', { table: 'units', row: { name: '  ' } }, admin), /mục trống/);
  await assert.rejects(() => b.call('catalog.save', { table: 'project_items', row: { owner: 'Nam' } }, admin), /mục trống/);
  const u = await b.call('catalog.save', { table: 'units', row: { name: 'Phòng Thử' } }, admin);
  await assert.rejects(() => b.call('catalog.save', { table: 'units', row: { name: 'phòng  thử ' } }, admin), errCode('DUPLICATE'));
  await assert.rejects(() => b.call('catalog.save', { table: 'units', row: { id: u.id, name: '' } }, admin), /mục trống/);
  assert.equal((await b.call('catalog.save', { table: 'units', row: { id: u.id, name: 'Phòng Thử' } }, admin)).name, 'Phòng Thử');
  const s1 = await b.call('catalog.save', { table: 'suppliers', row: { code: 'NCC1', name: 'A' } }, admin);
  await assert.rejects(() => b.call('catalog.save', { table: 'suppliers', row: { code: 'ncc1', name: 'B' } }, admin), errCode('DUPLICATE'));
  assert.equal((await b.call('catalog.save', { table: 'suppliers', row: { id: s1.id, code: 'NCC1', name: 'A mới' } }, admin)).name, 'A mới');
  const units = (await b.call('bootstrap', {}, admin)).catalogs.units;
  assert.ok(units.every((x) => x.name));
});

test('28. dọn dữ liệu cũ: xem trước không xóa; xóa dòng trước mốc + lần nhận + phiếu hết dòng; giữ phiếu vắt mốc, dòng không ngày; có sao lưu snapshot', async () => {
  const { b, user, admin } = await fresh();
  const old1 = await addLines(b, user, 2, { request_date: '2024-10-15' });
  const r1 = (await b.call('requests.issue', { line_ids: old1.map((l) => l.id) }, user)).code;
  await b.call('receipts.add', { line_id: old1[0].id, qty: 1 }, user);
  const [straddleOld] = await addLines(b, user, 1, { request_date: '2024-09-01' });
  const [straddleNew] = await addLines(b, user, 1, { request_date: '2024-11-05' });
  const r2 = (await b.call('requests.issue', { line_ids: [straddleOld.id, straddleNew.id] }, user)).code;
  const [noDate] = (await b.call('lines.save', { lines: [{ key: 'x', name: 'Không ngày', qty_requested: 1, request_date: null }] }, user)).map((r) => r.line);
  await b.call('lines.save', { lines: [{ id: noDate.id, request_date: '' }] }, user);
  const [loose] = await addLines(b, user, 1, { request_date: '2023-01-01' });
  const recent = await addLines(b, user, 2, { request_date: '2025-01-01' });

  await assert.rejects(() => b.call('data.purge', { before: '2024-11-01' }, user), errCode('FORBIDDEN'));
  const prev = await b.call('data.purge', { before: '2024-11-01' }, admin);
  assert.equal(prev.preview, true);
  assert.equal(prev.lines, 3);
  assert.equal(prev.requests, 1);
  assert.equal(prev.receipts, 1);
  assert.equal((await b.call('lines.list', {}, user)).rows.length, 8);

  const done = await b.call('data.purge', { before: '2024-11-01', confirm: true }, admin);
  assert.equal(done.preview, false);
  assert.ok(done.backup);
  const snapCount = await b.sqlAsService(`SELECT count(*)::int AS c FROM private.backup_snapshots`);
  assert.equal(snapCount.rows[0].c, 1);

  const list = await b.call('lines.list', {}, user);
  const ids = list.rows.map((r) => r[list.columns.indexOf('id')]);
  assert.deepEqual(
    ids.sort((a, b2) => a - b2),
    [straddleOld.id, straddleNew.id, noDate.id, recent[0].id, recent[1].id].sort((a, b2) => a - b2)
  );
  assert.ok(!ids.includes(loose.id));
  await assert.rejects(() => b.call('requests.get', { codes: [r1] }, user), errCode('NOT_FOUND'));
  assert.equal((await b.call('requests.get', { codes: [r2] }, user))[0].lines.length, 2);
  const recLeft = await b.sqlAsService(`SELECT count(*)::int AS c FROM public.receipts`);
  assert.equal(recLeft.rows[0].c, 0);
  assert.equal((await b.call('requests.issue', { line_ids: [recent[0].id] }, user)).code, 'YC2026-297');
  assert.equal((await b.call('lines.sync', { since: null }, user)).ids.length, 5);
  assert.equal((await b.call('audit.list', { q: 'dọn dữ liệu' }, admin)).length, 1);
  await assert.rejects(() => b.call('data.purge', { before: '2099-01-01' }, admin), /sau hôm nay/);
});

test('29. người ký phiếu: setup điền bộ mặc định; bootstrap không lỗi khi bảng trống; seed điền mặc định không nhân đôi', async () => {
  const { b, admin, user } = await fresh();
  const signers = (await b.call('bootstrap', {}, user)).catalogs.signers;
  assert.equal(signers.length, 8);
  assert.ok(signers.some((s) => s.unit_contains === 'Cải tiến' && s.title === 'T.P Cải tiến' && s.name === 'Trần Việt Tiệp'));
  assert.ok(signers.some((s) => !s.unit_contains && s.title === 'T.P Thiết bị' && s.name === 'Vũ Văn Trường'));
  await assert.rejects(() => b.call('catalog.save', { table: 'signers', row: { name: 'X' } }, admin), /Chức danh/);

  await b.sqlAsService(`DELETE FROM public.signers`);
  assert.deepEqual((await b.call('bootstrap', {}, user)).catalogs.signers, []);
  await assert.rejects(() => b.call('signers.seed', {}, user), errCode('FORBIDDEN'));
  assert.equal((await b.call('signers.seed', {}, admin)).length, 8);
  assert.equal((await b.call('signers.seed', {}, admin)).length, 8);
});

// ============================================================================
// PHẦN 2: 10 BÀI TEST BẢO MẬT RLS & EDGE CASES ĐẶC THÙ SUPABASE / POSTGRESQL
// ============================================================================

const PUBLIC_TABLES = [
  'lines',
  'requests',
  'receipts',
  'suppliers',
  'project_items',
  'material_groups',
  'signers',
  'units',
  'uoms',
  'profiles',
  'audit_log',
  'sequences',
];

test('RLS #1: anon bị từ chối SELECT/INSERT/UPDATE/DELETE trực tiếp trên cả 12 bảng nhưng gọi public.healthcheck() thành công', async () => {
  const { b, user } = await fresh();
  await addLines(b, user, 1);
  for (const tbl of PUBLIC_TABLES) {
    await assert.rejects(() => b.sqlAsAnon(`SELECT * FROM public.${tbl}`), /permission denied/i);
    await assert.rejects(() => b.sqlAsAnon(`DELETE FROM public.${tbl}`), /permission denied/i);
  }
  await assert.rejects(() => b.sqlAsAnon(`INSERT INTO public.units (name) VALUES ('Hack')`), /permission denied/i);
  await assert.rejects(() => b.sqlAsAnon(`UPDATE public.lines SET name = 'Hack'`), /permission denied/i);

  const hc = await b.sqlAsAnon(`SELECT public.healthcheck() AS ok`);
  assert.equal(hc.rows[0].ok, true);
  const t1 = (await b.sqlAsService(`SELECT pinged_at FROM private.heartbeat WHERE id = 1`)).rows[0].pinged_at;
  // Gọi lại trong vòng 1 giờ không ghi đè pinged_at; sau > 1 giờ mới cập nhật
  await b.setNow('2026-10-23T08:30:00+07:00');
  await b.sqlAsAnon(`SELECT public.healthcheck() AS ok`);
  const t2 = (await b.sqlAsService(`SELECT pinged_at FROM private.heartbeat WHERE id = 1`)).rows[0].pinged_at;
  assert.equal(new Date(t2).getTime(), new Date(t1).getTime());
  await b.setNow('2026-10-23T09:05:00+07:00');
  await b.sqlAsAnon(`SELECT public.healthcheck() AS ok`);
  const t3 = (await b.sqlAsService(`SELECT pinged_at FROM private.heartbeat WHERE id = 1`)).rows[0].pinged_at;
  assert.ok(new Date(t3).getTime() > new Date(t2).getTime());
});

test('RLS #2: anon bị từ chối gọi trực tiếp mọi hàm RPC nghiệp vụ và rpc_admin_*', async () => {
  const { b } = await fresh();
  const rpcs = [
    'rpc_bootstrap',
    'rpc_lines_list',
    'rpc_lines_sync',
    'rpc_lines_save',
    'rpc_requests_issue',
    'rpc_users_list',
    'rpc_export_all',
  ];
  for (const fn of rpcs) {
    await assert.rejects(() => b.sqlAsAnon(`SELECT public.${fn}('{}'::jsonb)`), /permission denied/i);
  }
  await assert.rejects(() => b.sqlAsAnon(`SELECT public.rpc_admin_check_login('admin')`), /permission denied/i);
});

test('RLS #3: authenticated cố tình gọi SQL UPDATE public.lines trực tiếp ngoài RPC bị chặn', async () => {
  const { b, user } = await fresh();
  const [l] = await addLines(b, user, 1);
  await assert.rejects(
    () => b.sqlAsUser(user, `UPDATE public.lines SET name = 'Hack', request_code = 'YC2026-999' WHERE id = $1`, [l.id]),
    /permission denied/i
  );
  const check = (await b.call('lines.list', {}, user)).rows[0];
  assert.equal(check[4], 'Thép tấm 0');
  assert.equal(check[1], null);
});

test('RLS #4: authenticated cố tình gọi SQL INSERT hoặc DELETE trực tiếp trên các bảng đều bị chặn', async () => {
  const { b, user, admin } = await fresh();
  await addLines(b, user, 1);
  for (const token of [user, admin]) {
    await assert.rejects(() => b.sqlAsUser(token, `DELETE FROM public.lines`), /permission denied/i);
    await assert.rejects(() => b.sqlAsUser(token, `INSERT INTO public.lines (name) VALUES ('Hack')`), /permission denied/i);
    await assert.rejects(() => b.sqlAsUser(token, `DELETE FROM public.audit_log`), /permission denied/i);
    await assert.rejects(() => b.sqlAsUser(token, `UPDATE public.sequences SET last_value = 1`), /permission denied/i);
  }
});

test('RLS #5: authenticated (user thường) không đọc được audit_log/sequences và không gọi được rpc_admin_*', async () => {
  const { b, user } = await fresh();
  await assert.rejects(() => b.sqlAsUser(user, `SELECT public.rpc_admin_check_login('admin')`), /permission denied/i);
  await assert.rejects(() => b.sqlAsUser(user, `SELECT public.rpc_admin_record_login('admin', true)`), /permission denied/i);
  await assert.rejects(() => b.sqlAsUser(user, `SELECT public.rpc_admin_save_profile_and_sessions('{}'::jsonb)`), /permission denied/i);
  await assert.rejects(() => b.sqlAsUser(user, `SELECT * FROM public.sequences`), /permission denied/i);
  // audit_log bị khóa với user thường (hoặc permission denied hoặc RLS trả 0 dòng)
  let rows = [];
  try {
    rows = (await b.sqlAsUser(user, `SELECT * FROM public.audit_log`)).rows;
  } catch (e) {
    assert.match(e.message, /permission denied/i);
  }
  assert.equal(rows.length, 0);
});

test('RLS #6: User đang có token hợp lệ bị Admin khóa active=false → chặn ngay AUTH + xóa auth.sessions; mở khóa lại đăng nhập bình thường', async () => {
  const { b, admin, user } = await fresh();
  const users = await b.call('users.list', {}, admin);
  const nam = users.find((u) => u.username === 'nam');
  assert.match(String(nam.id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const namEmail = (await b.sqlAsService(`SELECT email FROM auth.users WHERE id = $1::uuid`, [nam.id])).rows[0].email;
  assert.equal(namEmail, 'nam@dncvt.local');

  const beforeSess = (await b.sqlAsService(`SELECT count(*)::int AS c FROM auth.sessions WHERE user_id = $1::uuid`, [nam.id])).rows[0].c;
  assert.ok(beforeSess >= 1);

  await b.call('users.save', { user: Object.assign({}, nam, { active: false }) }, admin);

  const afterSess = (await b.sqlAsService(`SELECT count(*)::int AS c FROM auth.sessions WHERE user_id = $1::uuid`, [nam.id])).rows[0].c;
  assert.equal(afterSess, 0);

  // Token cũ chưa hết hạn nhưng gọi RPC bị chặn ngay lập tức với mã AUTH
  await assert.rejects(() => b.call('bootstrap', {}, user), errCode('AUTH'));
  await assert.rejects(() => b.call('lines.save', { lines: [{ name: 'X', qty_requested: 1 }] }, user), errCode('AUTH'));
  await assert.rejects(() => b.call('login', { username: 'nam', password: 'matkhau123' }), errCode('LOGIN'));

  // Mở khóa lại active = true → đăng nhập lại bình thường
  await b.call('users.save', { user: Object.assign({}, nam, { active: true }) }, admin);
  const relogin = await b.call('login', { username: 'nam', password: 'matkhau123' });
  assert.ok(relogin.token);
  assert.equal((await b.call('bootstrap', {}, relogin.token)).user.username, 'nam');
});

test('RLS #7: Admin không thể tự hạ quyền hoặc tự khóa mình; đặt lại mật khẩu user khác thu hồi phiên 0ms, xóa auth.sessions và ghi audit_log', async () => {
  const { b, admin, user } = await fresh();
  const users = await b.call('users.list', {}, admin);
  const adminProf = users.find((u) => u.username === 'admin');
  const namProf = users.find((u) => u.username === 'nam');

  await assert.rejects(
    () => b.call('users.save', { user: Object.assign({}, adminProf, { role: 'user' }) }, admin),
    /Không thể tự bỏ quyền Quản trị/
  );
  await assert.rejects(
    () => b.call('users.save', { user: Object.assign({}, adminProf, { active: false }) }, admin),
    /Không thể tự bỏ quyền Quản trị/
  );

  await b.call('users.save', { user: Object.assign({}, namProf, { password: 'resetpassword99' }) }, admin);
  const sess = (await b.sqlAsService(`SELECT count(*)::int AS c FROM auth.sessions WHERE user_id = $1::uuid`, [namProf.id])).rows[0].c;
  assert.equal(sess, 0);

  // Token cũ của nam dù còn hạn 12h phải bị chặn ngay lập tức (0ms) với mã AUTH
  await assert.rejects(() => b.call('lines.list', {}, user), errCode('AUTH'));
  await assert.rejects(() => b.call('lines.save', { lines: [{ name: 'Hack', qty_requested: 1 }] }, user), errCode('AUTH'));

  const audit = await b.call('audit.list', { q: '(đặt lại)' }, admin);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].table, 'users');
  assert.equal(audit[0].field, 'password');

  // export.all không lộ mật khẩu và giữ tối đa 10,000 audit_log
  const exported = await b.call('export.all', {}, admin);
  assert.ok(exported.users.every((u) => !('password' in u) && !('password_hash' in u) && !('salt' in u)));

  // Đổi username qua users.save giữ email_confirmed_at khác NULL (email_confirm: true) và khóa active=false chặn 0ms
  const renamed = await b.call('users.save', { user: Object.assign({}, namProf, { username: 'nam.moi' }) }, admin);
  const authRow = (await b.sqlAsService(`SELECT email, email_confirmed_at FROM auth.users WHERE id = $1::uuid`, [namProf.id])).rows[0];
  assert.equal(authRow.email, 'nam.moi@dncvt.local');
  assert.ok(authRow.email_confirmed_at);
  const namNewToken = (await b.call('login', { username: 'nam.moi', password: 'resetpassword99' })).token;
  assert.ok(await b.call('lines.list', {}, namNewToken));
  await b.call('users.save', { user: Object.assign({}, renamed, { active: false }) }, admin);
  await assert.rejects(() => b.call('lines.list', {}, namNewToken), errCode('AUTH'));
});

test('RLS #8: auth.changePassword kiểm tra mật khẩu cũ + độ dài >= 8, cấp phiên mới cho thiết bị hiện tại và thu hồi 0ms mọi phiên cũ', async () => {
  const { b, admin, user } = await fresh();
  const secondDevice = await b.call('login', { username: 'nam', password: 'matkhau123' });
  assert.ok(secondDevice.token);
  const namId = (await b.call('bootstrap', {}, user)).user.id;
  const sessBefore = (await b.sqlAsService(`SELECT count(*)::int AS c FROM auth.sessions WHERE user_id = $1::uuid`, [namId])).rows[0].c;
  assert.equal(sessBefore, 2);

  await assert.rejects(
    () => b.call('auth.changePassword', { old_password: 'wrong', new_password: 'newpassword123' }, user),
    /Mật khẩu cũ không đúng/
  );
  await assert.rejects(
    () => b.call('auth.changePassword', { old_password: 'matkhau123', new_password: '1234567' }, user),
    /ít nhất 8 ký tự/
  );
  const changed = await b.call('auth.changePassword', { old_password: 'matkhau123', new_password: 'newpassword123' }, user);
  assert.equal(changed.changed, true);
  assert.ok(changed.token);
  assert.ok(changed.refresh_token);

  const sessAfter = (await b.sqlAsService(`SELECT count(*)::int AS c FROM auth.sessions WHERE user_id = $1::uuid`, [namId])).rows[0].c;
  assert.equal(sessAfter, 1);

  // Phiên mới cấp lại cho thiết bị hiện tại hoạt động ngay lập tức
  assert.ok(await b.call('lines.list', {}, changed.token));

  // Thiết bị thứ 2 LẪN token cũ của thiết bị hiện tại đều bị thu hồi ngay lập tức (0ms) với mã AUTH
  await assert.rejects(() => b.call('lines.list', {}, secondDevice.token), errCode('AUTH'));
  await assert.rejects(() => b.call('lines.list', {}, user), errCode('AUTH'));
  await assert.rejects(
    () => b.call('auth.changePassword', { old_password: 'newpassword123', new_password: 'anotherpassword123' }, secondDevice.token),
    errCode('AUTH')
  );
  await assert.rejects(
    () => b.call('auth.changePassword', { old_password: 'newpassword123', new_password: 'anotherpassword123' }, user),
    errCode('AUTH')
  );

  const audit = await b.call('audit.list', { q: '(đã đổi)' }, admin);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user, 'nam');
  assert.equal(audit[0].table, 'users');
  assert.equal(audit[0].field, 'password');
  assert.equal(audit[0].new, '(đã đổi)');
  await assert.rejects(() => b.call('login', { username: 'nam', password: 'matkhau123' }), errCode('LOGIN'));
  assert.ok((await b.call('login', { username: 'nam', password: 'newpassword123' })).token);
});

test('RLS #9: khóa đăng nhập tạm thời 15 phút tự mở khóa sau 15 phút và backup.run giới hạn 30 bản', async () => {
  const { b, admin } = await fresh('2026-10-23T08:00:00+07:00');
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => b.call('login', { username: 'nam', password: 'bad' }), errCode('LOGIN'));
  }
  await assert.rejects(() => b.call('login', { username: 'nam', password: 'matkhau123' }), (e) => {
    assert.equal(e.code, 'LOCKED');
    assert.equal(e.message, 'Sai mật khẩu quá 5 lần. Thử lại sau 15 phút.');
    return true;
  });
  await b.setNow('2026-10-23T08:16:00+07:00');
  const ok = await b.call('login', { username: 'nam', password: 'matkhau123' });
  assert.ok(ok.token);

  for (let i = 0; i < 33; i++) {
    const bk = await b.call('backup.run', {}, admin);
    assert.ok(bk.name);
  }
  const snapCount = (await b.sqlAsService(`SELECT count(*)::int AS c FROM private.backup_snapshots`)).rows[0].c;
  assert.equal(snapCount, 30);
});

test('RLS #10: nạp dữ liệu lịch sử có 8 dị thường vào schema mới thành công 100% không lỗi constraint', async () => {
  const { b, user } = await fresh();
  // 1. LS-0001 (legacy_flag = true) trùng (year=2021, seq=1) với YC2021-001 (legacy_flag = false), issued_at = NULL
  await b.sqlAsService(`
    INSERT INTO public.requests (code, year, seq, issued_at, issued_by, header_json, line_count, legacy_flag) VALUES
      ('YC2021-001', 2021, 1, '2021-01-10T00:00:00+07:00', 'Nguyễn Văn A', '{"unit":"Phòng KT"}'::jsonb, 1, false),
      ('LS-0001', 2021, 1, NULL, NULL, '{"unit":"Xưởng cũ"}'::jsonb, 2, true);
  `);

  // 2. Dòng lịch sử: qty_requested = 0, qty_requested = NULL, số thập phân 5065.888, đơn vị/nhà CC ngoài danh mục (không FK)
  await b.sqlAsService(`
    INSERT INTO public.lines (request_code, unit, material_group, name, uom, qty_requested, qty_on_hand, unit_price, legacy_flag, created_by) VALUES
      ('LS-0001', 'Đơn vị lịch sử không còn trong danh mục', 'Z_CU', 'Vật tư SL bằng 0', 'Cái', 0, 0, 0, true, 'import'),
      ('LS-0001', 'Xưởng cũ', 'C', 'Vật tư SL NULL', 'Kg', NULL, NULL, 12500.5, true, 'import'),
      ('YC2021-001', 'Phòng KT', 'C', 'Thép hình lẻ thập phân', 'Kg', 5065.888, 7.000, 100.250, false, 'import');
  `);

  const linesRes = await b.call('lines.list', {}, user);
  const nameIdx = linesRes.columns.indexOf('name');
  const qtyIdx = linesRes.columns.indexOf('qty_requested');
  const onHandIdx = linesRes.columns.indexOf('qty_on_hand');
  const priceIdx = linesRes.columns.indexOf('unit_price');
  const decRow = linesRes.rows.find((r) => r[nameIdx] === 'Thép hình lẻ thập phân');
  const decId = decRow[linesRes.columns.indexOf('id')];

  // Kiểm tra trim_scale(): 5065.888 giữ nguyên 5065.888; 7.000 ra 7; 100.250 ra 100.25
  assert.equal(decRow[qtyIdx], 5065.888);
  assert.equal(decRow[onHandIdx], 7);
  assert.equal(decRow[priceIdx], 100.25);

  // 3. Lần nhận lịch sử received_date = NULL, created_by = NULL → trigger vẫn cộng dồn qty_received chuẩn
  await b.sqlAsService(`
    INSERT INTO public.receipts (line_id, received_date, qty, received_by, note, created_by)
    VALUES ($1, NULL, 100.500, NULL, 'import', NULL)
  `, [decId]);

  const got = (await b.call('requests.get', { codes: ['YC2021-001', 'LS-0001'] }, user));
  assert.equal(got[0].lines[0].qty_received, 100.5);
  assert.equal(got[0].lines[0].last_received_date, null);
  assert.equal(got[1].request.issued_at, null);
  assert.equal(got[1].lines.length, 2);

  // 4. Phiếu lịch sử LS-0001 bị chặn không cho requests.append
  const [newLine] = await addLines(b, user, 1);
  await assert.rejects(
    () => b.call('requests.append', { code: 'LS-0001', line_ids: [newLine.id], confirm_mixed: true }, user),
    /phiếu lịch sử/
  );

  // 5. requests.list tính đúng tổng tiền, nhà cung cấp, line_count thực tế và không lỗi khi issued_at = NULL
  const reqList = await b.call('requests.list', {}, user);
  const yc2021 = reqList.find((r) => r.code === 'YC2021-001');
  const ls0001 = reqList.find((r) => r.code === 'LS-0001');
  assert.equal(yc2021.line_count, 1);
  assert.equal(yc2021.amount, 5065.888 * 100.25);
  assert.equal(ls0001.line_count, 2);
  assert.equal(ls0001.issued_at, null);

  // 6. receipts.delete fallback cho dữ liệu cũ không có created_by (so khớp received_by + trong ngày Asia/Ho_Chi_Minh)
  const legacyRecIns = await b.sqlAsService(`
    INSERT INTO public.receipts (line_id, received_date, qty, received_by, note, created_by, created_at)
    VALUES ($1, '2026-10-23', 5, 'Nguyễn Nam', 'legacy-today', NULL, '2026-10-23T08:00:00+07:00')
    RETURNING id
  `, [decId]);
  const delLegacy = await b.call('receipts.delete', { id: legacyRecIns.rows[0].id }, user);
  assert.equal(delLegacy.line.qty_received, 100.5);

  // 7. catalog.delete và audit_log trim_scale cho số thập phân
  const { adminPassword } = await b.setup();
  assert.equal(adminPassword, null);
});

test('RLS #11: catalog.delete phân quyền admin + ghi audit_log; audit_log dùng trim_scale() không sinh 7.000', async () => {
  const { b, admin, user } = await fresh();
  const [l] = await addLines(b, user, 1, { qty_requested: 7 });
  await b.call('requests.issue', { line_ids: [l.id] }, user);
  // Ép lưu dạng 7.000 trong DB rồi cập nhật thành 5065.888 qua admin → kiểm tra old='7', new='5065.888'
  await b.sqlAsService(`UPDATE public.lines SET qty_requested = 7.000 WHERE id = $1`, [l.id]);
  await b.call('lines.save', { lines: [{ id: l.id, qty_requested: 5065.888 }] }, admin);
  const logs = await b.call('audit.list', { q: 'qty_requested' }, admin);
  assert.equal(logs[0].old, '7');
  assert.equal(logs[0].new, '5065.888');

  const cat = await b.call('catalog.save', { table: 'uoms', row: { name: 'Thùng' } }, admin);
  await assert.rejects(() => b.call('catalog.delete', { table: 'uoms', ids: [cat.id] }, user), errCode('FORBIDDEN'));
  const delRes = await b.call('catalog.delete', { table: 'uoms', ids: [cat.id] }, admin);
  assert.equal(delRes.deleted, 1);
  const delAudit = await b.call('audit.list', { q: 'Thùng' }, admin);
  assert.ok(delAudit.some((a) => a.table === 'uoms' && a.field === '(xóa)'));
});

test('RLS #12: kết nối PostgREST chạy múi giờ UTC như Supabase Cloud nhưng today_vn/fmt_ts và Cutover migrate_to_supabase.py vẫn chuẩn giờ Việt Nam', async () => {
  const { b, user } = await fresh('2026-03-15T01:30:00+07:00'); // = 2026-03-14T18:30:00Z trên UTC
  // 1. Xác nhận kết nối authenticated chạy ở múi giờ UTC (giống role authenticator trên Supabase Cloud)
  const tzRow = (await b.sqlAsUser(user, `SELECT current_setting('TIMEZONE') AS tz`)).rows[0];
  assert.equal(tzRow.tz, 'UTC');

  // Nhưng hàm ngày/giờ nghiệp vụ vẫn tính chuẩn theo Asia/Ho_Chi_Minh (không lệch +7h hay -7h)
  const vnCheck = (await b.sqlAsService(
    `SELECT private.today_vn() AS today_vn, private.fmt_ts('2026-03-15T18:30:00+07:00'::timestamptz) AS ts_vn`
  )).rows[0];
  assert.equal(vnCheck.today_vn, '2026-03-15');
  assert.equal(vnCheck.ts_vn, '2026-03-15T18:30:00');
  assert.equal((await b.call('bootstrap', {}, user)).today, '2026-03-15');

  // 2. Giả lập migrate_to_supabase.py --execute tạo auth.users + upsert public.profiles theo UUID
  const migAuth = await b.sqlAsService(`
    INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
    VALUES ('11111111-2222-4333-8444-555555555555'::uuid, 'ha@dncvt.local', 'scrypt$00$00', '{"username":"ha"}'::jsonb)
    RETURNING id
  `);
  const uid = migAuth.rows[0].id;
  await b.sqlAsService(`
    INSERT INTO public.profiles (id, username, full_name, role, active)
    VALUES ($1::uuid, 'ha', 'Trần Thu Hà', 'user', true)
    ON CONFLICT (id) DO UPDATE
      SET username = EXCLUDED.username,
          full_name = EXCLUDED.full_name,
          role = EXCLUDED.role,
          active = EXCLUDED.active
  `, [uid]);

  // 3. Giả lập SQL Cutover (OVERRIDING SYSTEM VALUE + chuỗi datetime gắn hậu tố +07:00 trên kết nối UTC)
  await b.sqlAsService(`
    INSERT INTO public.lines ("id", "request_code", "unit", "material_group", "name", "uom", "qty_requested", "qty_on_hand", "need_date", "project_code", "project_name", "purpose", "equipment_name", "delivery_location", "requester", "request_date", "supplier", "unit_price", "note", "legacy_flag", "created_by", "created_at", "updated_at", "qty_received", "last_received_date") OVERRIDING SYSTEM VALUE VALUES
      (10, 'LS-0001', 'P.Cải tiến', 'C', 'Ống thép đúc', 'cây', 5, 1, '2021-12-23', 'MS027', 'Hệ thống Lò NL', 'Sửa lò', NULL, 'PX Cơ điện', 'Nam', '2021-12-20', 'KHVT', 120000, NULL, TRUE, 'import', '2021-12-20T00:00:00+07:00', '2022-01-15T08:30:00+07:00', 3.334, '2021-12-25');
    INSERT INTO public.receipts ("id", "line_id", "received_date", "qty", "received_by", "note", "created_at", "created_by") OVERRIDING SYSTEM VALUE VALUES
      (1, 10, '2021-12-22', 2.1114, 'Nam', 'Đợt 1', '2021-12-22T10:00:00+07:00', NULL),
      (2, 10, '2021-12-25', 1.2224, 'Nam', 'Đợt 2', '2021-12-25T15:00:00+07:00', NULL);
  `);

  const list = await b.call('lines.list', {}, user);
  const cols = list.columns;
  const row10 = list.rows.find((r) => r[cols.indexOf('id')] === 10);
  assert.ok(row10);
  // Chuỗi datetime không lệch +7h/-7h và không bị lùi updated_at bởi receipts cũ hơn
  assert.equal(row10[cols.indexOf('created_at')], '2021-12-20T00:00:00');
  assert.equal(row10[cols.indexOf('updated_at')], '2022-01-15T08:30:00');
  assert.equal(row10[cols.indexOf('qty_received')], 3.334);
  assert.equal(row10[cols.indexOf('last_received_date')], '2021-12-25');

  // Bộ đếm identity tự nhảy qua 10 nên thêm dòng mới tiếp theo nhận id = 11
  const [nextLine] = await addLines(b, user, 1);
  assert.equal(nextLine.id, 11);
});
