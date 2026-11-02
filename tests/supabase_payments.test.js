// Kiểm thử backend "Đề nghị thanh toán" (supabase/migrations/002_payments.sql) trên PGlite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
  await b.setNow(nowIso || '2026-11-02T08:00:00+07:00');
  const { adminPassword } = await b.setup();
  const admin = (await b.call('login', { username: 'admin', password: adminPassword })).token;
  await b.call('users.save', {
    user: { username: 'nam', full_name: 'Nguyễn Nam', role: 'user', password: 'matkhau123' },
  }, admin);
  const user = (await b.call('login', { username: 'nam', password: 'matkhau123' })).token;
  return { b, admin, user };
}

function row(i, extra) {
  return Object.assign({
    pay_date: '2026-11-0' + ((i % 9) + 1),
    content: 'Cước xe vận chuyển ' + i,
    amount: (i + 1) * 10000,
    orderer: 'Tiệp',
    requester: 'Hoàng Ngọc Hà',
  }, extra || {});
}

async function addPayLines(b, token, n, extra) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(row(i, extra));
  return b.call('payments.create', { rows }, token);
}

const HEADER = { requester: 'Hoàng Ngọc Hà', position: 'Nhân viên', unit: 'P. Cải tiến' };
const errCode = (code) => (e) => e.code === code;

test('P1. migration 002 nạp sau 001, chạy lại được (idempotent) và seed 6 người đề nghị', async () => {
  const { b, user } = await fresh();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '002_payments.sql'), 'utf8');
  await b.db.exec(sql);
  await b.db.exec(sql);
  const list = await b.call('payments.list', {}, user);
  assert.deepEqual(list.lines, []);
  assert.equal(list.payers.length, 6);
  assert.deepEqual(list.payers[0], { id: list.payers[0].id, name: 'Trần Việt Tiệp', position: 'Trưởng phòng', unit: 'P. Cải tiến' });
  assert.deepEqual(
    list.payers.map((p) => p.name),
    ['Trần Việt Tiệp', 'Hoàng Ngọc Hà', 'Tống Đức Duy', 'Vũ Thế Huynh', 'Phan Thành Nam', 'Vũ Văn Hiếu']
  );
  assert.ok(list.payers.slice(1).every((p) => p.position === 'Nhân viên' && p.unit === 'P. Cải tiến'));
});

test('P2. create / list / save / delete dòng thanh toán', async () => {
  const { b, user } = await fresh();
  const created = await b.call('payments.create', {
    rows: [
      { pay_date: '05/11/2026', content: '  Mua dây curoa ', amount: '150000', orderer: 'Tiệp', requester: 'Tống Đức Duy',
        supplier: 'NCC A', driver_phone: '0912', plate_no: '18C-123', receive_time: '9h', receive_place: 'Cổng', note: 'gấp',
        request_code: 'DN2026-999', created_by: 'hacker' },
      { content: 'Không ngày', amount: 0 },
    ],
  }, user);
  assert.equal(created.length, 2);
  const [a, c] = created;
  assert.equal(a.content, 'Mua dây curoa');
  assert.equal(a.pay_date, '2026-11-05');
  assert.equal(a.amount, 150000);
  assert.equal(a.request_code, null);
  assert.equal(a.created_by, 'Nguyễn Nam');
  assert.equal(a.legacy_flag, false);
  for (const k of ['id', 'request_code', 'pay_date', 'content', 'amount', 'orderer', 'requester', 'supplier',
    'driver_phone', 'plate_no', 'receive_time', 'receive_place', 'note', 'legacy_flag', 'created_by', 'created_at', 'updated_at']) {
    assert.ok(k in a, 'thiếu trường ' + k);
  }
  assert.equal(c.pay_date, '2026-11-02'); // mặc định hôm nay (giờ VN)
  assert.equal(c.amount, 0);

  const saved = await b.call('payments.save', { id: a.id, patch: { amount: 200000, note: '', request_code: 'X', bogus: 1 } }, user);
  assert.equal(saved.amount, 200000);
  assert.equal(saved.note, null);
  assert.equal(saved.request_code, null);

  await assert.rejects(() => b.call('payments.save', { id: a.id, patch: { amount: -1 } }, user), /không được âm/);
  await assert.rejects(() => b.call('payments.save', { id: a.id, patch: { pay_date: '31/02/2026' } }, user), /ngày hợp lệ/);
  await assert.rejects(() => b.call('payments.save', { id: 9999, patch: { amount: 1 } }, user), errCode('NOT_FOUND'));
  await assert.rejects(() => b.call('payments.create', { rows: [] }, user));
  const tooMany = Array.from({ length: 501 }, (_, i) => row(i));
  await assert.rejects(() => b.call('payments.create', { rows: tooMany }, user), /500/);

  const list = await b.call('payments.list', {}, user);
  assert.deepEqual(list.lines.map((l) => l.id), [a.id, c.id]);

  assert.deepEqual(await b.call('payments.delete', { ids: [c.id] }, user), { deleted: 1 });
  assert.equal((await b.call('payments.list', {}, user)).lines.length, 1);
});

test('P3. xuất giấy: số DN2026-016 rồi 017; tổng tiền, header, khóa dòng đã xuất', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addPayLines(b, user, 3);
  const r1 = await b.call('payreq.issue', { line_ids: lines.map((l) => l.id), header: HEADER }, user);
  assert.equal(r1.code, 'DN2026-016');
  assert.deepEqual(r1.line_ids, lines.map((l) => l.id));
  const more = await addPayLines(b, user, 1);
  const r2 = await b.call('payreq.issue', { line_ids: [more[0].id], header: HEADER }, admin);
  assert.equal(r2.code, 'DN2026-017');

  const list = await b.call('payreq.list', {}, user);
  assert.equal(list.length, 2);
  assert.equal(list[0].code, 'DN2026-017'); // mới nhất trước
  const one = list.find((r) => r.code === 'DN2026-016');
  assert.equal(one.line_count, 3);
  assert.equal(one.total, 10000 + 20000 + 30000);
  assert.equal(one.requester, 'Hoàng Ngọc Hà');
  assert.equal(one.position, 'Nhân viên');
  assert.equal(one.unit, 'P. Cải tiến');
  assert.equal(one.paid, false);
  assert.equal(one.paid_date, null);
  assert.equal(one.paid_by, null);
  assert.equal(one.legacy_flag, false);
  assert.equal(one.issued_by, 'Nguyễn Nam');
  assert.equal(one.issued_at, '2026-11-02T08:00:00');

  // không xuất lại dòng đã có số
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [lines[0].id], header: HEADER }, user), (e) => {
    assert.equal(e.code, 'ALREADY_ISSUED');
    assert.deepEqual(e.details, { line_ids: [lines[0].id] });
    return true;
  });
  // lỗi không tiêu tốn số
  const [noAmt] = await b.call('payments.create', { rows: [{ content: 'Thiếu tiền' }] }, user);
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [noAmt.id], header: HEADER }, user), errCode('INVALID'));
  const [noContent] = await b.call('payments.create', { rows: [{ amount: 5 }] }, user);
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [noContent.id], header: HEADER }, user), errCode('INVALID'));
  const [ok] = await addPayLines(b, user, 1);
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [ok.id], header: { position: 'X' } }, user), errCode('INVALID'));
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [ok.id] }, user), errCode('INVALID'));
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [99999], header: HEADER }, user), errCode('NOT_FOUND'));
  await assert.rejects(() => b.call('payreq.issue', { line_ids: [], header: HEADER }, user));
  assert.equal((await b.call('payreq.issue', { line_ids: [ok.id], header: HEADER }, user)).code, 'DN2026-018');

  // dòng đã xuất: user thường không sửa/xóa được
  await assert.rejects(() => b.call('payments.save', { id: lines[0].id, patch: { content: 'Đổi' } }, user), errCode('LOCKED_FIELD'));
  await assert.rejects(() => b.call('payments.delete', { ids: [lines[0].id] }, user), errCode('HAS_REQUEST'));
  await assert.rejects(() => b.call('payments.delete', { ids: [lines[0].id] }, admin), errCode('HAS_REQUEST'));
  // gửi lại đúng giá trị cũ thì không coi là sửa
  await b.call('payments.save', { id: lines[0].id, patch: { content: lines[0].content } }, user);
});

test('P4. admin sửa dòng đã xuất → ghi nhật ký từng trường và cập nhật tổng tiền', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addPayLines(b, user, 2);
  const { code } = await b.call('payreq.issue', { line_ids: lines.map((l) => l.id), header: HEADER }, user);
  const saved = await b.call('payments.save', { id: lines[0].id, patch: { amount: 55000, content: 'Nội dung mới' } }, admin);
  assert.equal(saved.amount, 55000);
  assert.equal(saved.content, 'Nội dung mới');
  const req = (await b.call('payreq.list', {}, user)).find((r) => r.code === code);
  assert.equal(req.total, 55000 + 20000);

  const log = await b.call('audit.list', {}, admin);
  const rows = log.filter((a) => a.table === 'payment_lines' && a.row_id === String(lines[0].id));
  const byField = Object.fromEntries(rows.map((a) => [a.field, a]));
  assert.equal(byField.amount.user, 'admin');
  assert.equal(byField.amount.old, '10000');
  assert.equal(byField.amount.new, '55000');
  assert.equal(byField.content.old, 'Cước xe vận chuyển 0');
  assert.equal(byField.content.new, 'Nội dung mới');
  assert.ok(log.some((a) => a.table === 'payment_requests' && a.row_id === code));
});

test('P5. bấm xuất song song không trùng số', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addPayLines(b, user, 10);
  const results = await Promise.all(lines.map((l, i) =>
    b.call('payreq.issue', { line_ids: [l.id], header: HEADER }, i % 2 ? admin : user)));
  const codes = results.map((r) => r.code).sort();
  assert.equal(new Set(codes).size, 10);
  assert.deepEqual(codes, Array.from({ length: 10 }, (_, i) => 'DN2026-' + String(16 + i).padStart(3, '0')));
});

test('P6. bỏ qua số đã tồn tại (import) và năm mới bắt đầu từ 001', async () => {
  const { b, user } = await fresh();
  await b.sqlAsService(`INSERT INTO public.payment_requests (code, year, seq, legacy_flag) VALUES ('DN2026-016', 2026, 16, false)`);
  const [l] = await addPayLines(b, user, 1);
  assert.equal((await b.call('payreq.issue', { line_ids: [l.id], header: HEADER }, user)).code, 'DN2026-017');

  const n = await fresh('2027-01-02T08:00:00+07:00');
  const [l2] = await addPayLines(n.b, n.user, 1);
  assert.equal((await n.b.call('payreq.issue', { line_ids: [l2.id], header: HEADER }, n.user)).code, 'DN2027-001');
});

test('P7. append / detach tính lại tổng tiền và số dòng', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addPayLines(b, user, 4); // 10k, 20k, 30k, 40k
  const { code } = await b.call('payreq.issue', { line_ids: [lines[0].id], header: HEADER }, user);
  const ap = await b.call('payreq.append', { code: code.toLowerCase(), line_ids: [lines[1].id, lines[2].id] }, user);
  assert.equal(ap.code, code);
  assert.deepEqual(ap.line_ids, [lines[1].id, lines[2].id]);
  let req = (await b.call('payreq.list', {}, user)).find((r) => r.code === code);
  assert.equal(req.line_count, 3);
  assert.equal(req.total, 60000);

  await assert.rejects(() => b.call('payreq.append', { code, line_ids: [lines[1].id] }, user), errCode('ALREADY_ISSUED'));
  await assert.rejects(() => b.call('payreq.append', { code: 'DN2026-999', line_ids: [lines[3].id] }, user), errCode('NOT_FOUND'));

  await assert.rejects(() => b.call('payreq.detach', { line_ids: [lines[1].id] }, user), errCode('FORBIDDEN'));
  const dt = await b.call('payreq.detach', { line_ids: [lines[1].id, lines[3].id] }, admin);
  assert.deepEqual(dt, { detached: 1 });
  req = (await b.call('payreq.list', {}, user)).find((r) => r.code === code);
  assert.equal(req.line_count, 2);
  assert.equal(req.total, 40000);
  const l1 = (await b.call('payments.list', {}, user)).lines.find((l) => l.id === lines[1].id);
  assert.equal(l1.request_code, null);
  const log = await b.call('audit.list', {}, admin);
  assert.ok(log.some((a) => a.table === 'payment_lines' && a.row_id === String(lines[1].id) && a.field === 'request_code' && a.old === code));

  // phiếu đã thanh toán: chỉ Quản trị được thêm dòng
  await b.call('payreq.setPaid', { code, paid: true, paid_date: '2026-11-03' }, user);
  await assert.rejects(() => b.call('payreq.append', { code, line_ids: [lines[3].id] }, user), errCode('PAID'));
  await b.call('payreq.append', { code, line_ids: [lines[3].id] }, admin);
  req = (await b.call('payreq.list', {}, user)).find((r) => r.code === code);
  assert.equal(req.line_count, 3);
  assert.equal(req.total, 80000);
});

test('P8. setPaid true/false, ngày mặc định hôm nay, có nhật ký', async () => {
  const { b, user, admin } = await fresh();
  const lines = await addPayLines(b, user, 1);
  const { code } = await b.call('payreq.issue', { line_ids: [lines[0].id], header: HEADER }, user);
  let r = await b.call('payreq.setPaid', { code, paid: true }, user);
  assert.equal(r.code, code);
  assert.equal(r.paid, true);
  assert.equal(r.paid_date, '2026-11-02');
  assert.equal(r.paid_by, 'Nguyễn Nam');
  assert.equal(r.total, 10000);
  r = await b.call('payreq.setPaid', { code, paid: true, paid_date: '28/10/2026' }, user);
  assert.equal(r.paid_date, '2026-10-28');
  await assert.rejects(() => b.call('payreq.setPaid', { code, paid: true, paid_date: '2026-02-31' }, user), /ngày hợp lệ/);
  r = await b.call('payreq.setPaid', { code, paid: false }, user);
  assert.equal(r.paid, false);
  assert.equal(r.paid_date, null);
  assert.equal(r.paid_by, null);
  await assert.rejects(() => b.call('payreq.setPaid', { code: 'DN2026-999', paid: true }, user), errCode('NOT_FOUND'));
  await assert.rejects(() => b.call('payreq.setPaid', { code, paid: 'abc' }, user));
  const log = await b.call('audit.list', {}, admin);
  assert.ok(log.filter((a) => a.table === 'payment_requests' && a.row_id === code && a.field === 'paid').length >= 3);
});

test('P9. payreq.get trả đúng thứ tự yêu cầu, dòng sắp theo ngày rồi id', async () => {
  const { b, user } = await fresh();
  const a = await b.call('payments.create', { rows: [
    row(0, { pay_date: '2026-11-05' }), row(1, { pay_date: '2026-11-01' }), row(2, { pay_date: '2026-11-05' }),
  ] }, user);
  const c = await addPayLines(b, user, 1);
  const r1 = await b.call('payreq.issue', { line_ids: a.map((l) => l.id), header: HEADER }, user);
  const r2 = await b.call('payreq.issue', { line_ids: [c[0].id], header: { requester: 'Trần Việt Tiệp', position: 'Trưởng phòng', unit: 'P. Cải tiến' } }, user);
  const got = await b.call('payreq.get', { codes: [r2.code, r1.code.toLowerCase()] }, user);
  assert.deepEqual(got.map((g) => g.code), [r2.code, r1.code]);
  assert.deepEqual(got[0].header, { requester: 'Trần Việt Tiệp', position: 'Trưởng phòng', unit: 'P. Cải tiến' });
  assert.deepEqual(got[1].lines.map((l) => l.id), [a[1].id, a[0].id, a[2].id]);
  assert.equal(got[1].total, 60000);
  assert.equal(got[1].paid, false);
  assert.equal(got[1].paid_date, null);
  assert.equal(got[1].issued_by, 'Nguyễn Nam');
  assert.ok(got[1].issued_at);
  await assert.rejects(() => b.call('payreq.get', { codes: ['DN2026-999'] }, user), errCode('NOT_FOUND'));
  await assert.rejects(() => b.call('payreq.get', { codes: Array.from({ length: 101 }, (_, i) => 'X' + i) }, user), /100/);
});

test('P10. catalog.save / delete cho payers; bootstrap có payers; export + backup có bảng mới', async () => {
  const { b, user, admin } = await fresh();
  await assert.rejects(() => b.call('catalog.save', { table: 'payers', row: { name: 'X' } }, user), errCode('FORBIDDEN'));
  const saved = await b.call('catalog.save', { table: 'payers', row: { name: 'Nguyễn Văn A', position: 'Tổ trưởng', unit: 'Xưởng Đúc' } }, admin);
  assert.equal(saved.name, 'Nguyễn Văn A');
  await assert.rejects(() => b.call('catalog.save', { table: 'payers', row: { name: 'nguyễn văn a' } }, admin), errCode('DUPLICATE'));
  const upd = await b.call('catalog.save', { table: 'payers', row: { id: saved.id, position: 'Quản đốc' } }, admin);
  assert.equal(upd.position, 'Quản đốc');
  let boot = await b.call('bootstrap', {}, user);
  assert.equal(boot.catalogs.payers.length, 7);
  assert.deepEqual(Object.keys(boot.catalogs.payers[0]).sort(), ['id', 'name', 'position', 'unit']);
  assert.deepEqual(await b.call('catalog.delete', { table: 'payers', ids: [saved.id] }, admin), { deleted: 1 });
  boot = await b.call('bootstrap', {}, user);
  assert.equal(boot.catalogs.payers.length, 6);
  // danh mục cũ vẫn chạy
  assert.ok(Array.isArray(boot.catalogs.units));

  const lines = await addPayLines(b, user, 2);
  await b.call('payreq.issue', { line_ids: [lines[0].id], header: HEADER }, user);
  const exp = await b.call('export.all', {}, admin);
  assert.equal(exp.payers.length, 6);
  assert.equal(exp.payment_lines.length, 2);
  assert.equal(exp.payment_requests.length, 1);
  assert.equal(exp.payment_requests[0].code, 'DN2026-016');
  assert.ok(Array.isArray(exp.lines) && Array.isArray(exp.suppliers));

  await b.call('backup.run', {}, admin);
  const snap = (await b.sqlAsService(`SELECT payload FROM private.backup_snapshots ORDER BY id DESC LIMIT 1`)).rows[0].payload;
  assert.equal(snap.payers.length, 6);
  assert.equal(snap.payment_lines.length, 2);
  assert.equal(snap.payment_requests.length, 1);
});

test('P11. RLS: anon không đụng được bảng mới; authenticated không ghi trực tiếp; anon không gọi RPC', async () => {
  const { b, user } = await fresh();
  await addPayLines(b, user, 1);
  for (const tbl of ['payers', 'payment_requests', 'payment_lines']) {
    await assert.rejects(() => b.sqlAsAnon(`SELECT * FROM public.${tbl}`), /permission denied/i);
    await assert.rejects(() => b.sqlAsUser(user, `DELETE FROM public.${tbl}`), /permission denied/i);
  }
  await assert.rejects(() => b.sqlAsUser(user, `UPDATE public.payment_lines SET request_code = 'DN2026-001'`), /permission denied/i);
  await assert.rejects(() => b.sqlAsUser(user, `INSERT INTO public.payers (name) VALUES ('Hack')`), /permission denied/i);
  for (const fn of ['rpc_payments_list', 'rpc_payments_create', 'rpc_payreq_issue', 'rpc_payreq_set_paid', 'rpc_payreq_get']) {
    await assert.rejects(() => b.sqlAsAnon(`SELECT public.${fn}('{}'::jsonb)`), /permission denied/i);
  }
  await assert.rejects(() => b.sqlAsAnon(`SELECT private.seed_payers()`), /permission denied/i);
  await assert.rejects(() => b.call('payments.list', {}), errCode('AUTH'));
});
