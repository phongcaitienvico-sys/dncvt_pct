const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../docs/js/logic.js');

const st = (line, today) => L.computeStatus(line, today || '2026-10-23').label;

test('ví dụ nghiệm thu: cần 23/12/2021, nhận đủ 24/12/2021 → Trễ 1 ngày', () => {
  const line = { qty_requested: 5, qty_received: 5, need_date: '2021-12-23', last_received_date: '2021-12-24' };
  assert.equal(st(line), 'Trễ 1 ngày');
  assert.equal(L.computeStatus(line, '2026-10-23').color, 'red');
});

test('nhận đủ đúng hoặc trước hạn → Đúng hạn', () => {
  assert.equal(st({ qty_requested: 5, qty_received: 6, need_date: '2021-12-23', last_received_date: '2021-12-23' }), 'Đúng hạn');
  assert.equal(st({ qty_requested: 5, qty_received: 5, need_date: '2021-12-23', last_received_date: '2021-12-20' }), 'Đúng hạn');
});

test('chưa nhận đủ: còn n ngày / quá hạn', () => {
  const base = { qty_requested: 10, qty_received: 3 };
  assert.equal(st({ ...base, need_date: '2026-10-23' }), 'Còn 0 ngày');
  assert.equal(L.computeStatus({ ...base, need_date: '2026-10-25' }, '2026-10-23').color, 'yellow');
  assert.equal(L.computeStatus({ ...base, need_date: '2026-10-26' }, '2026-10-23').color, 'blue');
  assert.equal(st({ ...base, need_date: '2026-10-20' }), 'Quá hạn 3 ngày');
  assert.equal(st({ ...base, need_date: null }), 'Chưa có ngày cần');
});

test('chênh lệch ngày qua tháng/năm nhuận', () => {
  assert.equal(L.daysBetween('2024-02-28', '2024-03-01'), 2);
  assert.equal(L.daysBetween('2021-12-31', '2022-01-01'), 1);
});

test('parseDate nhiều dạng', () => {
  assert.equal(L.parseDate('23/12/2021'), '2021-12-23');
  assert.equal(L.parseDate('23-12-2021'), '2021-12-23');
  assert.equal(L.parseDate('5.1.26'), '2026-01-05');
  assert.equal(L.parseDate('24/12', 2021), '2021-12-24');
  assert.equal(L.parseDate('2021-12-23'), '2021-12-23');
  assert.equal(L.parseDate('31/02/2021'), null);
  assert.equal(L.parseDate('abc'), null);
  assert.equal(L.fmtDate('2021-12-23'), '23/12/2021');
});

test('parseNum kiểu Việt và kiểu Anh', () => {
  assert.equal(L.parseNum('1.234,5'), 1234.5);
  assert.equal(L.parseNum('1,234.5'), 1234.5);
  assert.equal(L.parseNum('1,5'), 1.5);
  assert.equal(L.parseNum('1,500'), 1500);
  assert.equal(L.parseNum('1.500.000'), 1500000);
  assert.equal(L.parseNum('2.5'), 2.5);
  assert.equal(L.parseNum('1.500'), 1500);
  assert.equal(L.parseNum('0.500'), 0.5);
  assert.equal(L.parseNum(''), null);
  assert.equal(L.parseNum('x'), null);
});

test('tuần ISO, tháng, số còn thiếu, bỏ dấu', () => {
  assert.equal(L.isoWeek('2026-01-01'), 1);
  assert.equal(L.isoWeek('2021-01-03'), 53);
  assert.equal(L.monthKey('2026-10-23'), '10/2026');
  assert.equal(L.qtyMissing({ qty_requested: 10, qty_received: 4 }), 6);
  assert.equal(L.qtyMissing({ qty_requested: 10, qty_received: 12 }), 0);
  assert.equal(L.fold('Thép Đen'), 'thep den');
});
