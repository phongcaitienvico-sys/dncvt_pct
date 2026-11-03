/** Đề nghị thanh toán: bảng dòng thanh toán (Tabulator, tự lưu, dán Excel, xuất giấy DN…) + danh sách giấy đã xuất. */

const PAY_FIELDS = ['pay_date', 'content', 'amount', 'orderer', 'requester', 'supplier', 'driver_phone', 'plate_no',
  'receive_time', 'receive_place', 'note'];
// Cột ẩn mặc định, bật lên được (nhớ trong trình duyệt)
const PAY_OPTIONAL = [
  ['supplier', 'NCC'], ['driver_phone', 'SĐT nhà xe'], ['plate_no', 'Biển số'], ['receive_time', 'Thời gian nhận'],
  ['receive_place', 'Địa điểm nhận'], ['note', 'Ghi chú'],
];
const PAY_COLS_KEY = 'ncvt_pay_cols';
const PAY_TPL = 'giay_de_nghi_thanh_toan';

function paymentsPage() {
  let table = null;
  let reqTable = null;
  let ui = null;
  let today = Logic.todayIso();
  let keySeq = 0;
  let payers = [];
  let lastCell = null;
  let lastCode = '';
  let placeholderText = 'Đang tải dữ liệu…';
  let reqPlaceholder = 'Đang tải…';
  let reqStale = true;
  const pending = new Map(); // _key -> Set(field) chờ lưu
  const chains = new Map(); // _key -> Promise: lưu tuần tự từng dòng (dòng mới không bị tạo 2 lần)
  const failed = new Set(); // _key lưu lỗi
  const pendingFailed = new Map(); // _key -> Set(field) lưu lỗi, chờ "Lưu lại"

  const isAdmin = () => App.user && App.user.role === 'admin';
  const newKey = () => 'n' + Date.now().toString(36) + (keySeq++);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } },
  };
  const visibleOptional = () => {
    try { const v = JSON.parse(store.get(PAY_COLS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  };

  const derive = (d) => ({
    _s: Logic.fold([d.request_code, d.content, d.orderer, d.requester, d.supplier, d.driver_phone, d.plate_no,
      d.receive_time, d.receive_place, d.note, Logic.fmtDate(d.pay_date)].join(' ')),
  });
  const prepare = (d) => Object.assign(d, { _key: d._key || 'i' + d.id, amount: d.amount === null || d.amount === undefined || d.amount === '' ? null : Number(d.amount) }, derive(d));
  const payerOf = (name) => {
    const k = Logic.fold(name).trim();
    return k ? payers.find((p) => Logic.fold(p.name).trim() === k) : null;
  };
  /** Ngày dán từ Excel có thể kèm giờ ("06/01/2019 14:35:02") → chỉ lấy phần ngày. */
  const parseDateLoose = (v) => Logic.parseDate(String(v || '').trim().split(/\s+/)[0]);
  const clean = (field, raw) => {
    if (field === 'amount') return Logic.parseNum(raw);
    if (field === 'pay_date') return parseDateLoose(raw);
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    return s || null;
  };

  // ---------- Cột ----------
  const canEdit = (cell) => !cell.getRow().getData().request_code || isAdmin();
  let editStart = null;
  const filterFunc = (term, label) => {
    const t = Logic.fold(term);
    if (editStart !== null && t && t === editStart) return true; // chưa gõ gì: hiện đủ danh sách
    return Logic.fold(label).includes(t);
  };
  const historyOf = (field) => {
    const set = new Set();
    (table ? table.getData() : []).forEach((r) => { if (r[field]) set.add(r[field]); });
    if (field === 'requester') payers.forEach((p) => { if (p.name) set.add(p.name); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
  };
  const listEditor = (field) => ({
    valuesLookup: () => (field === 'requester'
      ? payers.map((p) => p.name).filter(Boolean).concat(historyOf('requester').filter((n) => !payerOf(n)))
      : historyOf(field)),
    autocomplete: true, allowEmpty: true, freetext: true, listOnEmpty: true, filterFunc, filterDelay: 150, clearable: true,
  });
  const optionalOn = new Set(visibleOptional());

  function columns() {
    const txt = (field, title, width, extra) => Object.assign({ field, title, width, editor: 'input', editable: canEdit, visible: true }, extra || {});
    const cols = [
      { formatter: 'rowSelection', titleFormatter: 'rowSelection', titleFormatterParams: { rowRange: 'active' },
        hozAlign: 'center', headerSort: false, width: 36, frozen: true },
      txt('pay_date', 'Ngày', 105, { editor: 'date', formatter: (c) => Logic.fmtDate(c.getValue()), mutatorEdit: (v) => parseDateLoose(v), sorter: 'string' }),
      txt('content', 'Nội dung', 380, { editor: 'textarea', bottomCalc: 'count', bottomCalcFormatter: (c) => (c.getValue() ? c.getValue() + ' dòng' : '') }),
      txt('amount', 'Số tiền', 120, {
        hozAlign: 'right', sorter: 'number', formatter: (c) => Logic.fmtNum(c.getValue(), 0), mutatorEdit: (v) => Logic.parseNum(v),
        bottomCalc: 'sum', bottomCalcFormatter: (c) => Logic.fmtNum(c.getValue(), 0),
      }),
      txt('orderer', 'Người đặt hàng', 140, { editor: 'list', editorParams: listEditor('orderer') }),
      txt('requester', 'Người đề nghị', 150, { editor: 'list', editorParams: listEditor('requester') }),
      { field: 'request_code', title: 'Số phiếu', width: 115, cssClass: 'code col-code' },
    ];
    PAY_OPTIONAL.forEach(([field, title]) => {
      const extra = { visible: optionalOn.has(field) };
      if (field === 'supplier' || field === 'receive_place') Object.assign(extra, { editor: 'list', editorParams: listEditor(field) });
      cols.push(txt(field, title, field === 'note' || field === 'receive_place' ? 170 : 130, extra));
    });
    cols.push({ field: 'created_by', title: 'Người tạo', width: 110, visible: false });
    return cols;
  }

  function rowFormatter(row) {
    const d = row.getData();
    const el = row.getElement();
    el.classList.toggle('has-code', !!d.request_code);
    el.classList.toggle('saving', pending.has(d._key));
    el.classList.toggle('save-error', failed.has(d._key));
    const lock = !!d.request_code && !isAdmin();
    PAY_FIELDS.forEach((f) => { const c = row.getCell(f); if (c) c.getElement().classList.toggle('locked', lock); });
  }

  // ---------- Lưu tự động ----------
  const safeUpdate = (row, data) => {
    try { row.update(data); return; } catch (e) { /* ô đang sửa: thử lại sau */ }
    setTimeout(() => { try { row.update(data); } catch (e) { console.warn('row.update', e); } }, 250);
  };
  const refreshUnsaved = () => { ui.unsaved = new Set([...pending.keys(), ...failed]).size; };

  function markDirty(row, fields) {
    const key = row.getData()._key;
    const set = pending.get(key) || new Set();
    fields.forEach((f) => set.add(f));
    pending.set(key, set);
    failed.delete(key);
    setTimeout(() => { try { row.reformat(); } catch (e) { /* bỏ qua */ } });
    refreshUnsaved();
    queueSave(key);
  }

  function queueSave(key) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(() => saveRow(key));
    chains.set(key, next);
    next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
    return next;
  }

  async function saveRow(key) {
    const row = table.getRow(key);
    const fields = pending.get(key);
    if (!row || !fields || !fields.size) { pending.delete(key); return; }
    pending.delete(key);
    const d = row.getData();
    try {
      let line;
      if (!d.id) {
        // dòng mới còn trống (vừa bấm "+ Thêm dòng" rồi bỏ đó): chưa tạo trên máy chủ
        if (PAY_FIELDS.every((f) => f === 'pay_date' || d[f] === null || d[f] === undefined || String(d[f]).trim() === '')) return;
        const out = {};
        PAY_FIELDS.forEach((f) => { out[f] = d[f] === undefined || d[f] === '' ? null : d[f]; });
        const res = await Api.call('payments.create', { rows: [out] });
        line = res[0];
      } else {
        const patch = {};
        fields.forEach((f) => { patch[f] = d[f] === undefined || d[f] === '' ? null : d[f]; });
        line = await Api.call('payments.save', { id: d.id, patch });
      }
      failed.delete(key);
      // giữ giá trị người dùng vừa gõ thêm trong lúc chờ
      const local = row.getData();
      const merged = Object.assign({}, line, { _key: key });
      (pending.get(key) || new Set()).forEach((f) => { merged[f] = local[f]; });
      safeUpdate(row, prepare(merged));
    } catch (e) {
      // dừng tự lưu dòng này đến khi người dùng sửa tiếp / bấm "Lưu lại"
      const set = pendingFailed.get(key) || new Set();
      fields.forEach((f) => set.add(f));
      pendingFailed.set(key, set);
      failed.add(key);
      App.toast('Chưa lưu được: ' + e.message, 'error');
    } finally {
      try { row.reformat(); } catch (err) { /* bảng đang vẽ lại */ }
      refreshUnsaved();
      updateInfo();
    }
  }

  /** Chờ mọi thay đổi được lưu xong (trước khi xuất giấy…). */
  async function flushAll() {
    for (let i = 0; i < 5 && chains.size; i++) await Promise.all(Array.from(chains.values()).map((p) => p.catch(() => {})));
    if (failed.size) throw new Error('Còn ' + failed.size + ' dòng chưa lưu được — hãy sửa lỗi hoặc bấm "Lưu lại" trước.');
  }

  function onCellEdited(cell) {
    const row = cell.getRow();
    const field = cell.getField();
    const d = row.getData();
    // gộp thay đổi trước đó bị lỗi (nếu có) vào lần lưu này
    const old = pendingFailed.get(d._key);
    pendingFailed.delete(d._key);
    d._s = derive(d)._s; // chỉ là chỉ mục tìm kiếm: gán thẳng, không vẽ lại dòng khi ô đang đóng trình sửa
    markDirty(row, [field].concat(old ? Array.from(old) : []));
  }

  // ---------- Dán từ Excel ----------
  function parseTsv(text) {
    const rows = [];
    let row = [''];
    let i = 0;
    let quoted = false;
    text = text.replace(/\r\n?/g, '\n');
    while (i < text.length) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i += 2; continue; }
        if (ch === '"') { quoted = false; i++; continue; }
        row[row.length - 1] += ch; i++; continue;
      }
      if (ch === '"' && row[row.length - 1] === '') { quoted = true; i++; continue; }
      if (ch === '\t') { row.push(''); i++; continue; }
      if (ch === '\n') { rows.push(row); row = ['']; i++; continue; }
      row[row.length - 1] += ch; i++;
    }
    if (row.length > 1 || row[0] !== '') rows.push(row);
    return rows;
  }

  async function onPaste(e) {
    if (e.target.matches && e.target.matches('input, select, textarea')) return; // đang sửa 1 ô: dán bình thường
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    e.preventDefault();
    const data = parseTsv(text).filter((r) => r.some((v) => String(v).trim()));
    if (!data.length) return;
    const editCols = table.getColumns().filter((c) => PAY_FIELDS.includes(c.getField()) && c.isVisible()).map((c) => c.getField());
    const rows = table.getRows('active');
    let startCol = 0;
    let startRow = rows.length; // không chọn ô → thêm dòng mới ở cuối
    if (lastCell) {
      const ci = editCols.indexOf(lastCell.field);
      const ri = rows.findIndex((r) => r.getData()._key === lastCell.key);
      if (ci >= 0 && ri >= 0) { startCol = ci; startRow = ri; }
    }
    let skipped = 0;
    const creates = [];
    data.forEach((vals, i) => {
      const row = rows[startRow + i];
      const changes = {};
      vals.forEach((raw, j) => {
        const field = editCols[startCol + j];
        if (field) changes[field] = clean(field, raw);
      });
      if (!Object.keys(changes).length) return;
      if (!row) { creates.push(changes); return; }
      const d = row.getData();
      if (d.request_code && !isAdmin()) { skipped++; return; }
      safeUpdate(row, Object.assign(changes, derive(Object.assign({}, d, changes))));
      markDirty(row, Object.keys(changes).filter((f) => PAY_FIELDS.includes(f)));
    });
    if (creates.length) {
      const full = creates.map((c) => {
        const o = { pay_date: today };
        PAY_FIELDS.forEach((f) => { if (c[f] !== undefined) o[f] = c[f]; });
        return o;
      });
      try {
        const made = [];
        for (let i = 0; i < full.length; i += 500) made.push(...(await Api.call('payments.create', { rows: full.slice(i, i + 500) })));
        await table.addData(made.map((l) => prepare(l)), false);
        table.scrollToRow('i' + made[made.length - 1].id, 'bottom', false).catch(() => {});
      } catch (err) { App.toast('Chưa thêm được các dòng dán: ' + err.message, 'error'); return; }
    }
    updateInfo();
    App.toast('Đã dán ' + data.length + ' dòng' + (creates.length ? ' (thêm mới ' + creates.length + ')' : '') +
      (skipped ? '; bỏ qua ' + skipped + ' dòng đã có số phiếu' : '') + '.', skipped ? 'error' : 'ok');
  }

  // ---------- Lọc / thông tin ----------
  function filterFn(d) {
    const f = ui.f;
    if (!d.id) return true; // dòng mới luôn hiện
    if (f.noCode && d.request_code) return false;
    if (f.code && !Logic.fold(d.request_code).includes(Logic.fold(f.code))) return false;
    if (f.q) {
      const words = Logic.fold(f.q).split(/\s+/).filter(Boolean);
      if (!words.every((w) => d._s.includes(w))) return false;
    }
    return true;
  }
  function updateInfo() {
    if (!table) return;
    const total = table.getDataCount();
    const shown = table.getDataCount('active');
    const sel = table.getSelectedData();
    const sum = sel.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    ui.info = total + ' dòng' + (shown !== total ? ' · đang hiện ' + shown : '') +
      (sel.length ? ' · đã chọn ' + sel.length + ', tổng ' + Logic.fmtNum(sum, 0) + ' đ' : '');
  }

  function markIssued(rows, code) {
    rows.forEach((r) => {
      safeUpdate(r, Object.assign({ request_code: code }, derive(Object.assign({}, r.getData(), { request_code: code }))));
      r.deselect();
      try { r.reformat(); } catch (e) { /* bỏ qua */ }
    });
    if (code) lastCode = code;
    reqStale = true;
    updateInfo();
  }

  function checkIssuable(data) {
    // Số tiền 0 vẫn hợp lệ (máy chủ chấp nhận); chỉ chặn khi để trống
    const bad = data.filter((d) => !String(d.content || '').trim() || d.amount === null || d.amount === undefined || d.amount === '' || !(Number(d.amount) >= 0));
    if (bad.length) App.toast(bad.length + ' dòng thiếu Nội dung hoặc Số tiền.', 'error');
    return !bad.length;
  }
  async function savedIds(rows) {
    await flushAll();
    const ids = rows.map((r) => r.getData().id);
    if (ids.some((id) => !id)) throw new Error('Có dòng chưa lưu xong, thử lại sau giây lát.');
    return ids;
  }
  const waitWin = (text) => {
    const win = App.openPrintWindow();
    if (win) win.document.write('<p style="font:16px sans-serif;padding:24px">' + App.esc(text) + '</p>');
    return win;
  };
  const openPrint = (win, codes) => {
    const url = App.printUrl(codes, PAY_TPL);
    if (win) win.location.href = url; else window.open(url, '_blank');
  };

  async function appendRows(rows, code) {
    if (!checkIssuable(rows.map((r) => r.getData()))) return;
    const win = waitWin('Đang thêm vào giấy ' + code + '…');
    try {
      const ids = await savedIds(rows);
      const res = await Api.call('payreq.append', { code, line_ids: ids });
      markIssued(rows, res.code);
      table.deselectRow();
      App.toast('Đã thêm ' + ids.length + ' dòng vào giấy ' + res.code + '.', 'ok', 6000);
      openPrint(win, [res.code]);
    } catch (e) {
      if (win) win.close();
      App.toast(e.message, 'error');
      if (e.code === 'ALREADY_ISSUED') ui.reload(); // máy khác vừa xuất các dòng này: tải lại cho đúng số phiếu
    }
  }

  // ---------- Tab Giấy đã xuất ----------
  const fmtDT = (s) => (s ? Logic.fmtDate(s) + (s.length > 10 && s.slice(11, 16) !== '00:00' ? ' ' + s.slice(11, 16) : '') : '');
  const paidLabel = (d) => (d.paid ? 'Đã TT' + (d.paid_date ? ' ' + Logic.fmtDate(d.paid_date) : '') : 'Chưa TT');
  const prepReq = (r) => Object.assign(r, {
    _s: Logic.fold([r.code, r.requester, r.position, r.unit, r.issued_by, paidLabel(r)].join(' ')),
  });

  async function buildReqTable() {
    reqTable = new Tabulator('#req-grid', {
      height: 'max(320px, calc(100vh - 200px))', layout: 'fitData', placeholder: () => reqPlaceholder, selectableRows: 'highlight', index: 'code',
      columns: [
        { formatter: 'rowSelection', titleFormatter: 'rowSelection', titleFormatterParams: { rowRange: 'active' }, hozAlign: 'center', headerSort: false, width: 36 },
        { field: 'code', title: 'Số phiếu', width: 120, cssClass: 'code' },
        { field: 'issued_at', title: 'Ngày xuất', width: 130, formatter: (c) => fmtDT(c.getValue()) },
        { field: 'requester', title: 'Người đề nghị', width: 170 },
        { field: 'position', title: 'Chức vụ', width: 130 },
        { field: 'unit', title: 'Đơn vị', width: 150 },
        { field: 'line_count', title: 'Số dòng', width: 80, hozAlign: 'right', sorter: 'number' },
        { field: 'total', title: 'Tổng tiền', width: 130, hozAlign: 'right', sorter: 'number', formatter: (c) => Logic.fmtNum(c.getValue(), 0),
          bottomCalc: 'sum', bottomCalcFormatter: (c) => Logic.fmtNum(c.getValue(), 0) },
        { field: 'paid', title: 'Trạng thái TT', width: 150, sorter: (a, b, ra, rb) => paidLabel(ra.getData()).localeCompare(paidLabel(rb.getData())),
          formatter: (c) => { const d = c.getRow().getData(); return `<span class="st ${d.paid ? 'green' : 'yellow'}">${App.esc(paidLabel(d))}</span>`; } },
        { field: 'issued_by', title: 'Người xuất', width: 130 },
      ],
    });
    reqTable.on('rowSelectionChanged', reqInfoUpdate);
    reqTable.on('dataFiltered', () => setTimeout(reqInfoUpdate));
    reqTable.on('rowDblClick', (e, row) => window.open(App.printUrl([row.getData().code], PAY_TPL), '_blank'));
    await new Promise((r) => reqTable.on('tableBuilt', r));
  }
  function reqFilterFn(d) {
    const f = ui.rf;
    if (f.status === 'paid' && !d.paid) return false;
    if (f.status === 'unpaid' && d.paid) return false;
    const words = Logic.fold(f.q).split(/\s+/).filter(Boolean);
    return words.every((w) => d._s.includes(w));
  }
  function reqInfoUpdate() {
    if (!reqTable) return;
    const sel = reqTable.getSelectedData();
    ui.reqInfo = reqTable.getDataCount('active') + ' giấy' + (sel.length ? ' · chọn ' + sel.length + ', tổng ' + Logic.fmtNum(sel.reduce((s, d) => s + (Number(d.total) || 0), 0), 0) + ' đ' : '');
  }
  function selectedCodes() {
    const codes = reqTable ? reqTable.getSelectedData().map((d) => d.code) : [];
    if (!codes.length) App.toast('Hãy tick chọn ít nhất một giấy.', 'error');
    if (codes.length > 100) { App.toast('Tối đa 100 giấy mỗi lần.', 'error'); return []; }
    return codes;
  }
  async function setPaid(codes, paid, date) {
    let ok = 0;
    for (const code of codes) {
      try {
        const r = await Api.call('payreq.setPaid', Object.assign({ code, paid }, paid ? { paid_date: date } : {}));
        const row = reqTable.getRow(code);
        if (row && r) await row.update(prepReq(Object.assign({}, row.getData(), r)));
        ok++;
      } catch (e) { App.toast(code + ': ' + e.message, 'error'); }
    }
    reqTable.deselectRow();
    reqInfoUpdate();
    if (ok) App.toast((paid ? 'Đã đánh dấu đã thanh toán ' : 'Đã bỏ đánh dấu ') + ok + ' giấy.', 'ok');
    return ok;
  }

  // ---------- Trạng thái Alpine ----------
  return {
    tab: 'lines',
    unsupported: '',
    isAdmin: false,
    info: 'Đang tải…',
    reqInfo: '',
    unsaved: 0,
    colOpen: false,
    optionalCols: PAY_OPTIONAL.map(([field, title]) => ({ field, title, on: optionalOn.has(field) })),
    f: { q: '', noCode: false, code: '' },
    rf: { q: '', status: '' },
    payerNames: [],
    dlg: { open: false, busy: false, error: '', requester: '', position: '', unit: '', count: 0, total: 0, mixed: false, keys: [] },
    pd: { open: false, busy: false, error: '', date: '', codes: [] },
    dl: { orderers: [], suppliers: [], places: [] },
    fm: { open: false, busy: false, error: '', more: false, c: {}, items: [] },
    ef: { open: false, busy: false, key: null, id: null, code: '', locked: false, error: '', d: {} },

    // ----- Form thêm nhiều khoản -----
    fillLists() {
      this.dl = { orderers: historyOf('orderer'), suppliers: historyOf('supplier'), places: historyOf('receive_place') };
    },
    formOpen() {
      this.fillLists();
      this.fm = {
        open: true, busy: false, error: '', more: false,
        c: { pay_date: today, orderer: '', requester: '', supplier: '', driver_phone: '', plate_no: '', receive_time: '', receive_place: '', note: '' },
        items: [0, 1, 2].map(() => ({ k: newKey(), content: '', amount: '' })),
      };
      setTimeout(() => { const el = document.getElementById('fm-content-0'); if (el) el.focus(); }, 80);
    },
    fmTotal() { return (this.fm.items || []).reduce((s, it) => s + (Logic.parseNum(it.amount) || 0), 0); },
    formAddRow(n) {
      for (let i = 0; i < n; i++) this.fm.items.push({ k: newKey(), content: '', amount: '' });
    },
    formRemove(i) {
      this.fm.items.splice(i, 1);
      if (!this.fm.items.length) this.formAddRow(1);
    },
    formEnter(i, col) {
      if (col === 'content') { const el = document.getElementById('fm-amount-' + i); if (el) el.focus(); return; }
      if (i === this.fm.items.length - 1) this.formAddRow(1);
      setTimeout(() => { const el = document.getElementById('fm-content-' + (i + 1)); if (el) el.focus(); }, 30);
    },
    async formSubmit(issue) {
      const f = this.fm;
      if (f.busy) return;
      const items = f.items.filter((it) => String(it.content).trim() || String(it.amount).trim());
      if (!items.length) { f.error = 'Hãy nhập ít nhất một khoản (Nội dung và Số tiền).'; return; }
      const bad = items.findIndex((it) => !String(it.content).trim() || (issue && Logic.parseNum(it.amount) === null) ||
        (String(it.amount).trim() && Logic.parseNum(it.amount) === null) || (Logic.parseNum(it.amount) !== null && Logic.parseNum(it.amount) < 0));
      if (bad >= 0) { f.error = 'Khoản thứ ' + (bad + 1) + ' thiếu Nội dung hoặc Số tiền chưa hợp lệ.'; return; }
      const date = Logic.parseDate(f.c.pay_date) || today;
      const requester = String(f.c.requester || '').trim();
      if (issue && !requester) { f.error = 'Hãy nhập Người đề nghị để xuất giấy.'; return; }
      const t = (v) => String(v === null || v === undefined ? '' : v).trim() || null;
      const rows = items.map((it) => ({
        pay_date: date, content: String(it.content).trim(), amount: Logic.parseNum(it.amount),
        orderer: t(f.c.orderer), requester: t(requester), supplier: t(f.c.supplier), driver_phone: t(f.c.driver_phone),
        plate_no: t(f.c.plate_no), receive_time: t(f.c.receive_time), receive_place: t(f.c.receive_place), note: t(f.c.note),
      }));
      const win = issue ? waitWin('Đang lưu và cấp số giấy đề nghị…') : null; // mở cửa sổ ngay trong thao tác bấm nút
      f.busy = true; f.error = '';
      let added = [];
      try {
        const lines = await Api.call('payments.create', { rows });
        added = await table.addData(lines.map((l) => prepare(Object.assign({}, l))), false);
        updateInfo();
        if (added.length) table.scrollToRow(added[added.length - 1].getData()._key, 'bottom', false).catch(() => {});
        if (!issue) {
          f.open = false;
          App.toast('Đã thêm ' + lines.length + ' khoản thanh toán.', 'ok');
        } else {
          const p = payerOf(requester);
          const res = await Api.call('payreq.issue', {
            line_ids: lines.map((l) => l.id),
            header: { requester, position: p ? p.position || '' : '', unit: p ? p.unit || '' : '' },
          });
          markIssued(added, res.code);
          f.open = false;
          App.toast('Đã lưu ' + lines.length + ' khoản và cấp số ' + res.code + '.', 'ok', 6000);
          openPrint(win, [res.code]);
        }
      } catch (e) {
        if (win) win.close();
        if (added.length) { // đã lưu dòng nhưng bước sau lỗi: không để người dùng bấm lưu lần nữa gây trùng
          f.open = false;
          App.toast('Đã lưu ' + added.length + ' khoản nhưng chưa xuất giấy: ' + e.message + ' Hãy tick các dòng mới rồi bấm "Xuất giấy đề nghị".', 'error', 9000);
        } else f.error = e.message;
      }
      f.busy = false;
    },

    // ----- Form sửa / xóa một dòng -----
    openEdit() {
      const rows = table.getSelectedRows();
      if (rows.length !== 1) { App.toast(rows.length ? 'Chỉ chọn 1 dòng để sửa bằng form (sửa nhiều dòng: nhấp thẳng vào ô).' : 'Hãy tick chọn 1 dòng cần sửa.', 'error'); return; }
      const r = rows[0].getData();
      this.fillLists();
      const d = {};
      PAY_FIELDS.forEach((f) => { d[f] = r[f] === null || r[f] === undefined ? '' : r[f]; });
      d.pay_date = Logic.parseDate(r.pay_date) || '';
      this.ef = { open: true, busy: false, key: r._key, id: r.id, code: r.request_code || '', locked: !!r.request_code && !isAdmin(), error: '', d };
      setTimeout(() => { const el = document.getElementById('ef-content'); if (el) el.focus(); }, 80);
    },
    async saveEdit() {
      const e = this.ef;
      if (e.busy || e.locked) return;
      const row = table.getRow(e.key);
      if (!row) { e.error = 'Không tìm thấy dòng (có thể đã bị xóa).'; return; }
      const t = (v) => (v === null || v === undefined ? '' : String(v)).trim() || null;
      const next = {
        pay_date: Logic.parseDate(e.d.pay_date) || null, content: t(e.d.content), amount: Logic.parseNum(e.d.amount),
        orderer: t(e.d.orderer), requester: t(e.d.requester), supplier: t(e.d.supplier), driver_phone: t(e.d.driver_phone),
        plate_no: t(e.d.plate_no), receive_time: t(e.d.receive_time), receive_place: t(e.d.receive_place), note: t(e.d.note),
      };
      if (!next.content) { e.error = 'Thiếu Nội dung.'; return; }
      if (String(e.d.amount).trim() && next.amount === null) { e.error = 'Số tiền không hợp lệ.'; return; }
      if (next.amount !== null && next.amount < 0) { e.error = 'Số tiền không được âm.'; return; }
      if (e.code && next.amount === null) { e.error = 'Dòng đã có số giấy: Số tiền không được để trống.'; return; }
      const same = (a, b) => (a === null || a === undefined || a === '' ? null : a) === (b === null || b === undefined || b === '' ? null : b);
      const cur = row.getData();
      const patch = {};
      Object.keys(next).forEach((f) => { if (!same(next[f], f === 'pay_date' ? Logic.parseDate(cur[f]) : cur[f])) patch[f] = next[f]; });
      if (!Object.keys(patch).length) { e.open = false; return; }
      e.busy = true; e.error = '';
      try {
        await flushAll();
        const id = row.getData().id;
        if (!id) throw new Error('Dòng chưa lưu xong, thử lại sau giây lát.');
        const line = await Api.call('payments.save', { id, patch });
        safeUpdate(row, prepare(Object.assign({}, line, { _key: e.key })));
        if (e.code) reqStale = true; // tổng tiền của giấy có thể đã đổi
        updateInfo();
        e.open = false;
        App.toast('Đã lưu thay đổi.', 'ok');
      } catch (err) { e.error = err.message; }
      e.busy = false;
    },
    async deleteEdit() {
      const e = this.ef;
      if (e.busy || e.code) return;
      const row = table.getRow(e.key);
      if (!row) { e.open = false; return; }
      if (!confirm('Xóa dòng thanh toán này?\n\n' + String(row.getData().content || '').slice(0, 120))) return;
      e.busy = true; e.error = '';
      try {
        try { await flushAll(); } catch (err) { /* dòng lỗi lưu: chỉ có trên máy này */ }
        const id = row.getData().id;
        if (id) await Api.call('payments.delete', { ids: [id] });
        const k = e.key; pending.delete(k); failed.delete(k); pendingFailed.delete(k);
        row.delete();
        refreshUnsaved();
        updateInfo();
        e.open = false;
        App.toast('Đã xóa dòng.', 'ok');
      } catch (err) { e.error = err.message; }
      e.busy = false;
    },

    async init() {
      ui = this;
      const boot = await App.init();
      today = boot.today || today;
      this.isAdmin = isAdmin();
      if (!App.isSupabaseMode()) {
        this.unsupported = App.SUPABASE_ONLY_MSG + '.';
        document.getElementById('pay-wrap').style.display = 'none';
        return;
      }
      if (location.hash === '#giay') this.tab = 'reqs';
      payers = (boot.catalogs && boot.catalogs.payers) || boot.payers || [];
      this.payerNames = payers.map((p) => p.name).filter(Boolean);
      table = new Tabulator('#pay-grid', {
        index: '_key',
        height: 'max(360px, calc(100vh - 260px))',
        layout: 'fitData',
        renderVertical: 'virtual',
        placeholder: () => placeholderText,
        selectableRows: 'highlight',
        columnDefaults: { headerTooltip: true, headerWordWrap: true, resizable: true, variableHeight: true },
        editTriggerEvent: 'click',
        rowFormatter,
        columns: columns(),
      });
      table.on('cellEdited', onCellEdited);
      table.on('cellEditing', (cell) => {
        const v = cell.getValue();
        editStart = v === null || v === undefined || v === '' ? null : Logic.fold(v);
        setTimeout(() => { const inp = cell.getElement().querySelector('input, textarea'); if (inp && inp.select) inp.select(); }, 30);
      });
      table.on('cellClick', (e, cell) => { lastCell = { key: cell.getRow().getData()._key, field: cell.getField() }; });
      table.on('rowSelectionChanged', updateInfo);
      table.on('dataFiltered', () => setTimeout(updateInfo));
      const el = document.getElementById('pay-grid');
      el.addEventListener('paste', onPaste);
      el.setAttribute('tabindex', '0');
      window.addEventListener('beforeunload', (e) => { if (pending.size || chains.size || failed.size) { e.preventDefault(); e.returnValue = ''; } });
      await new Promise((r) => table.on('tableBuilt', r));
      await this.reload();
      if (this.tab === 'reqs') this.show('reqs');
    },

    async show(t) {
      this.tab = t;
      history.replaceState(null, '', t === 'reqs' ? '#giay' : location.pathname + location.search);
      if (this.unsupported) return;
      document.getElementById('pay-wrap').style.display = t === 'lines' ? '' : 'none';
      document.getElementById('req-wrap').style.display = t === 'reqs' ? '' : 'none';
      if (t === 'lines' && table) setTimeout(() => table.redraw(true));
      if (t === 'reqs') {
        if (!reqTable) await buildReqTable();
        else setTimeout(() => reqTable.redraw(true));
        if (reqStale) await this.loadRequests();
      }
    },

    async reload() {
      try {
        const res = await Api.call('payments.list', {});
        if (res.payers && res.payers.length) { payers = res.payers; this.payerNames = payers.map((p) => p.name).filter(Boolean); }
        // giữ lại dòng mới chưa lưu / đang sửa dở trên máy này
        const keep = table.getData().filter((d) => !d.id || pending.has(d._key) || failed.has(d._key));
        const keepIds = new Set(keep.map((d) => d.id).filter(Boolean));
        const rows = (res.lines || []).filter((l) => !keepIds.has(l.id)).map((l) => prepare(Object.assign({}, l)))
          .sort((a, b) => String(a.pay_date || '9999').localeCompare(String(b.pay_date || '9999')) || a.id - b.id).concat(keep);
        placeholderText = 'Chưa có dòng nào khớp. Bấm "+ Thêm dòng" hoặc dán từ Excel.';
        await table.setData(rows);
        table.setFilter(filterFn);
        updateInfo();
        if (rows.length) table.scrollToRow(rows[rows.length - 1]._key, 'bottom', false).catch(() => {});
      } catch (e) {
        placeholderText = 'Lỗi tải dữ liệu: ' + e.message;
        table.redraw(true);
        App.toast(e.message, 'error');
      }
    },

    applyFilters() { table.refreshFilter(); },
    clearFilters() { this.f = { q: '', noCode: false, code: '' }; table.refreshFilter(); },

    toggleCol(field, on) {
      const col = table && table.getColumn(field);
      if (col) { if (on) col.show(); else col.hide(); }
      if (on) optionalOn.add(field); else optionalOn.delete(field);
      this.optionalCols = this.optionalCols.map((c) => (c.field === field ? Object.assign({}, c, { on }) : c));
      store.set(PAY_COLS_KEY, JSON.stringify(Array.from(optionalOn)));
    },

    addRow() {
      const d = prepare({ _key: newKey(), id: null, request_code: null, pay_date: today, created_by: App.user.username });
      table.addRow(d, false).then((row) => {
        updateInfo();
        const c = row.getCell('content');
        if (c) row.scrollTo().then(() => c.edit()).catch(() => c.edit());
      });
    },

    retrySave() {
      Array.from(failed).forEach((key) => {
        const row = table.getRow(key);
        const set = pendingFailed.get(key);
        pendingFailed.delete(key);
        failed.delete(key);
        if (row && set) markDirty(row, Array.from(set));
      });
      refreshUnsaved();
    },

    async remove() {
      const rows = table.getSelectedRows();
      if (!rows.length) { App.toast('Hãy chọn dòng cần xóa.', 'error'); return; }
      const coded = rows.filter((r) => r.getData().request_code);
      if (coded.length) { App.toast(coded.length + ' dòng đã có số phiếu: không xóa được. Quản trị có thể "Gỡ khỏi giấy" trước rồi mới xóa.', 'error'); return; }
      if (!confirm('Xóa ' + rows.length + ' dòng đã chọn?')) return;
      try {
        try { await flushAll(); } catch (e) { /* dòng lỗi lưu: chỉ có trên máy này */ }
        const ids = rows.map((r) => r.getData().id).filter(Boolean);
        if (ids.length) await Api.call('payments.delete', { ids });
        rows.forEach((r) => { const k = r.getData()._key; pending.delete(k); failed.delete(k); pendingFailed.delete(k); r.delete(); });
        refreshUnsaved();
        updateInfo();
        App.toast('Đã xóa ' + rows.length + ' dòng.', 'ok');
      } catch (e) { App.toast(e.message, 'error'); }
    },

    /** Xuất giấy: dòng chưa có số → hỏi người đề nghị rồi cấp số mới; dòng đã có số → in lại đúng số cũ. */
    async issue() {
      const rows = table.getSelectedRows();
      if (!rows.length) { App.toast('Hãy tick chọn các dòng cần xuất giấy đề nghị.', 'error'); return; }
      const data = rows.map((r) => r.getData());
      const codes = Array.from(new Set(data.map((d) => d.request_code).filter(Boolean)));
      const uncoded = data.filter((d) => !d.request_code);
      if (codes.length && uncoded.length) {
        App.toast('Đang chọn lẫn dòng chưa có số và dòng đã có số. Muốn thêm vào giấy cũ hãy dùng "Thêm vào giấy đã xuất…".', 'error');
        return;
      }
      if (codes.length) { window.open(App.printUrl(codes, PAY_TPL), '_blank'); return; }
      if (!checkIssuable(data)) return;
      const names = Array.from(new Set(data.map((d) => String(d.requester || '').trim()).filter(Boolean)));
      const one = names.length === 1 ? names[0] : '';
      const p = payerOf(one);
      this.dlg = {
        open: true, busy: false, error: '', requester: p ? p.name : one, position: p ? p.position || '' : '', unit: p ? p.unit || '' : '',
        count: data.length, total: data.reduce((s, d) => s + (Number(d.amount) || 0), 0), mixed: names.length > 1,
        keys: data.map((d) => d._key),
      };
      setTimeout(() => { const i = document.getElementById('dlg-requester'); if (i) i.focus(); }, 60);
    },
    dlgPayer() {
      const p = payerOf(this.dlg.requester);
      if (p) { this.dlg.position = p.position || ''; this.dlg.unit = p.unit || ''; }
    },
    async issueConfirm() {
      const g = this.dlg;
      const header = { requester: g.requester.trim(), position: g.position.trim(), unit: g.unit.trim() };
      if (!header.requester) { g.error = 'Hãy chọn Người đề nghị.'; return; }
      const rows = g.keys.map((k) => table.getRow(k)).filter(Boolean);
      if (!rows.length) { g.error = 'Không còn dòng nào (có thể đã bị xóa).'; return; }
      const win = waitWin('Đang cấp số giấy đề nghị…');
      g.busy = true; g.error = '';
      try {
        const ids = await savedIds(rows);
        const res = await Api.call('payreq.issue', { line_ids: ids, header });
        markIssued(rows, res.code);
        g.open = false;
        App.toast('Đã cấp số ' + res.code + ' cho ' + ids.length + ' dòng.', 'ok', 6000);
        openPrint(win, [res.code]);
      } catch (e) {
        if (win) win.close();
        g.error = e.message;
        if (e.code === 'ALREADY_ISSUED') { g.open = false; App.toast(e.message, 'error'); this.reload(); }
      }
      g.busy = false;
    },

    async appendPrompt() {
      const rows = table.getSelectedRows();
      const uncoded = rows.filter((r) => !r.getData().request_code);
      if (!uncoded.length) { App.toast('Hãy tick chọn các dòng CHƯA có số phiếu cần thêm vào giấy cũ.', 'error'); return; }
      if (uncoded.length < rows.length) { App.toast('Có ' + (rows.length - uncoded.length) + ' dòng đã có số phiếu — hãy bỏ chọn các dòng đó.', 'error'); return; }
      const s = prompt('Thêm ' + uncoded.length + ' dòng vào giấy đề nghị số (vd. ' + (lastCode || 'DN2026-016') + '):', lastCode || '');
      if (!s || !s.trim()) return;
      await appendRows(uncoded, s.trim().toUpperCase());
    },

    async detach() {
      const rows = table.getSelectedRows().filter((r) => r.getData().request_code);
      if (!rows.length) { App.toast('Hãy tick chọn các dòng đã có số phiếu cần gỡ.', 'error'); return; }
      const codes = Array.from(new Set(rows.map((r) => r.getData().request_code)));
      if (!confirm('Gỡ ' + rows.length + ' dòng khỏi giấy ' + codes.slice(0, 6).join(', ') + (codes.length > 6 ? '…' : '') +
        '?\n\nDòng vẫn giữ nguyên dữ liệu, chỉ trở lại trạng thái "chưa có số". Số giấy không được cấp lại. Việc này được ghi vào nhật ký.')) return;
      try {
        await flushAll();
        await Api.call('payreq.detach', { line_ids: rows.map((r) => r.getData().id) });
        markIssued(rows, null);
        App.toast('Đã gỡ ' + rows.length + ' dòng khỏi giấy ' + codes.join(', ') + '.', 'ok', 6000);
      } catch (e) { App.toast(e.message, 'error'); }
    },

    // ----- Giấy đã xuất -----
    async loadRequests() {
      if (!reqTable) return;
      reqPlaceholder = 'Đang tải…';
      try {
        const list = await Api.call('payreq.list', {});
        reqStale = false;
        reqPlaceholder = 'Không có giấy nào khớp.';
        await reqTable.setData((list || []).map(prepReq));
        reqTable.setFilter(reqFilterFn);
      } catch (e) {
        reqPlaceholder = 'Lỗi tải dữ liệu: ' + e.message;
        reqTable.redraw(true);
        App.toast(e.message, 'error');
      }
      reqInfoUpdate();
    },
    applyReqFilters() { if (reqTable) reqTable.refreshFilter(); },
    openSelected() { const c = selectedCodes(); if (c.length) window.open(App.printUrl(c, PAY_TPL), '_blank'); },
    paidPrompt() {
      const codes = selectedCodes();
      if (!codes.length) return;
      this.pd = { open: true, busy: false, error: '', date: today, codes };
    },
    async paidConfirm() {
      if (!this.pd.date) { this.pd.error = 'Hãy chọn ngày thanh toán.'; return; }
      this.pd.busy = true;
      await setPaid(this.pd.codes, true, this.pd.date);
      this.pd.busy = false;
      this.pd.open = false;
    },
    async unpaid() {
      const codes = selectedCodes();
      if (!codes.length) return;
      const paid = reqTable.getSelectedData().filter((d) => d.paid).map((d) => d.code);
      if (!paid.length) { App.toast('Các giấy đã chọn đều chưa đánh dấu thanh toán.', 'error'); return; }
      if (!confirm('Bỏ đánh dấu đã thanh toán cho ' + paid.length + ' giấy: ' + paid.slice(0, 8).join(', ') + (paid.length > 8 ? '…' : '') + '?')) return;
      await setPaid(paid, false);
    },
  };
}
