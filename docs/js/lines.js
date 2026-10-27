/** Màn hình chính: bảng vật tư chung (Tabulator) + lưu tự động + xuất phiếu. */

const EDITABLE_FIELDS = ['unit', 'material_group', 'name', 'uom', 'qty_requested', 'qty_on_hand', 'need_date',
  'project_code', 'project_name', 'purpose', 'equipment_name', 'delivery_location', 'requester', 'request_date',
  'supplier', 'unit_price', 'note'];
const LOCKED_AFTER_ISSUE = ['name', 'qty_requested'];
const NUM_FIELDS = ['qty_requested', 'qty_on_hand', 'unit_price'];
const DATE_FIELDS = ['need_date', 'request_date'];

// Cột xuất Excel: [field, tiêu đề, hàm lấy giá trị?]
const EXPORT_COLUMNS = [
  ['id', 'STT'], ['request_code', 'Số phiếu'], ['unit', 'Đơn vị đề xuất'], ['material_group', 'Nhóm VT'],
  ['name', 'Tên vật tư'], ['uom', 'ĐVT'], ['qty_requested', 'Số lượng yêu cầu'], ['qty_on_hand', 'SL tồn kho'],
  ['need_date', 'Ngày cần có', (r) => Logic.fmtDate(r.need_date)], ['project_code', 'Mã hạng mục'],
  ['project_name', 'Hạng mục'], ['purpose', 'Mục đích sử dụng'], ['equipment_name', 'Tên thiết bị'],
  ['delivery_location', 'Địa điểm giao'], ['supplier', 'Nhà CC / Người cấp'],
  ['request_date', 'Ngày yêu cầu', (r) => Logic.fmtDate(r.request_date)], ['requester', 'Người yêu cầu'],
  ['last_received_date', 'Ngày nhận', (r) => Logic.fmtDate(r.last_received_date)], ['qty_received', 'Số lượng thực nhận'],
  ['qty_missing', 'Số lượng còn thiếu'], ['_status', 'Trạng thái', (r) => r._st.label], ['unit_price', 'Đơn giá'],
  ['amount', 'Thành tiền'], ['week', 'Tuần'], ['month', 'Tháng'], ['note', 'Ghi chú'], ['created_by', 'Người tạo'],
];

function linesPage() {
  let table = null;
  let today = Logic.todayIso();
  let keySeq = 0;
  const pending = new Map(); // _key -> Set(field)
  const inflight = new Set(); // _key của dòng mới đang được tạo trên server
  let saveTimer = null;
  let saving = false;
  let lastCell = null; // ô được nhấp gần nhất (để dán)
  let lastCode = ''; // số phiếu vừa cấp / vừa thêm dòng trong phiên này (gợi ý khi thêm vật tư bị quên)
  let historyCache = null;
  let placeholderText = 'Đang tải dữ liệu…';
  let formKey = 0;
  const newFormItem = () => ({
    k: ++formKey, name: '', uom: '', material_group: '', qty_requested: '', qty_on_hand: '', need_date: '', project: '',
    purpose: '', equipment_name: '', supplier: '', unit_price: '', note: '',
  });
  let formProjects = new Map();
  let ui = null; // proxy Alpine (gán trong init) — ghi qua đây thì giao diện mới cập nhật
  let projectByCode = {};
  let projectByName = {};
  const normProjectCode = (c) => { const s = String(c || '').trim(); return /^[Mm][Ss]\d+$/.test(s) ? s.toUpperCase() : s; };
  const findProjectName = (c) => (c ? projectByCode[c] || projectByCode[String(c).trim().toUpperCase()] : undefined);

  const newKey = () => 'n' + Date.now().toString(36) + (keySeq++);
  const isAdmin = () => App.user && App.user.role === 'admin';

  function derive(d) {
    const st = Logic.computeStatus(d, today);
    return {
      amount: Logic.amount(d),
      qty_missing: Logic.qtyMissing(d),
      week: d.request_date ? Logic.isoWeek(d.request_date) + '/' + d.request_date.slice(0, 4) : '',
      month: Logic.monthKey(d.request_date),
      _st: st,
      _s: Logic.fold([d.request_code, d.name, d.purpose, d.project_code, d.project_name, d.supplier, d.equipment_name,
        d.requester, d.delivery_location, d.unit, d.material_group, d.note].join(' ')),
    };
  }
  const prepare = (d) => Object.assign(d, { _key: d._key || 'i' + d.id }, derive(d));

  /** Gợi ý từ lịch sử: tên vật tư → ĐVT, nhóm VT, đơn giá gần nhất; danh sách giá trị đã dùng. */
  function history() {
    if (historyCache) return historyCache;
    const rows = table ? table.getData() : [];
    const byName = {};
    const sets = { name: new Set(), purpose: new Set(), equipment_name: new Set(), delivery_location: new Set(), requester: new Set(), supplier: new Set() };
    rows.slice().sort((a, b) => (a.id || 1e12) - (b.id || 1e12)).forEach((r) => {
      Object.keys(sets).forEach((k) => { if (r[k]) sets[k].add(r[k]); });
      if (!r.name) return;
      const k = Logic.fold(r.name);
      const h = byName[k] || (byName[k] = {});
      if (r.uom) h.uom = r.uom;
      if (r.material_group) h.material_group = r.material_group;
      if (r.unit_price) h.unit_price = r.unit_price;
    });
    (App.boot.users || []).forEach((u) => sets.requester.add(u.full_name));
    App.boot.catalogs.suppliers.forEach((s) => sets.supplier.add(s.code || s.name));
    const lists = {};
    Object.keys(sets).forEach((k) => { lists[k] = Array.from(sets[k]).sort((a, b) => a.localeCompare(b, 'vi')); });
    historyCache = { byName, lists };
    return historyCache;
  }

  /**
   * Tabulator lọc danh sách theo chữ đang có trong ô ngay lúc mở trình sửa → ô đã có giá trị chỉ thấy đúng 1 lựa chọn,
   * hoặc "No Results Found" nếu giá trị cũ không có trong danh mục. Khi người dùng chưa gõ gì (chữ trong ô vẫn là
   * giá trị cũ / nhãn của nó) thì hiện đủ danh sách; gõ chữ khác mới lọc.
   */
  let editStart = null; // giá trị ô (đã bỏ dấu) lúc bắt đầu sửa
  const makeFilter = (labelOf) => (term, label) => {
    const t = Logic.fold(term);
    if (editStart !== null && t && (t === editStart || (labelOf && t === labelOf[editStart]))) return true;
    return Logic.fold(label).includes(t);
  };
  const listEditor = (raw, freetext, extra) => {
    // Bỏ mục trống / trùng của danh mục: Tabulator gặp giá trị null thì lỗi và không hiện được danh sách
    const seen = new Set();
    const values = raw.filter((v) => {
      const key = v && typeof v === 'object' ? v.value : v;
      if (key === null || key === undefined || String(key).trim() === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const labelOf = {};
    values.forEach((v) => { if (v && typeof v === 'object') labelOf[Logic.fold(v.value)] = Logic.fold(v.label); });
    return Object.assign({
      values, autocomplete: true, allowEmpty: true, listOnEmpty: true, freetext: !!freetext, filterFunc: makeFilter(labelOf), clearable: true,
    }, extra || {});
  };
  const historyEditor = (field, listOnEmpty) => ({
    valuesLookup: () => history().lists[field], autocomplete: true, allowEmpty: true, freetext: true,
    listOnEmpty: listOnEmpty !== false, filterFunc: makeFilter(null), filterDelay: 150,
  });

  function canEdit(cell) {
    const d = cell.getRow().getData();
    if (d.request_code && !isAdmin() && LOCKED_AFTER_ISSUE.includes(cell.getField())) return false;
    return true;
  }

  const fmtDateCell = (cell) => Logic.fmtDate(cell.getValue());
  const fmtNumCell = (cell) => Logic.fmtNum(cell.getValue());
  const numCol = (field, title, width, editable) => Object.assign({
    field, title, width, hozAlign: 'right', formatter: fmtNumCell, sorter: 'number',
  }, editable ? { editor: 'input', editable: canEdit, mutatorEdit: (v) => Logic.parseNum(v) } : {});

  function columns(cat) {
    const projectValues = cat.project_items.filter((p) => p.item_code || p.project_code).map((p) => {
      const code = p.item_code || p.project_code;
      return { value: code, label: code + ' — ' + (p.item_name || p.project_name || '') };
    });
    return [
      { formatter: 'rowSelection', titleFormatter: 'rowSelection', titleFormatterParams: { rowRange: 'active' },
        hozAlign: 'center', headerSort: false, width: 36, frozen: true },
      { field: 'id', title: 'STT', width: 62, hozAlign: 'right', sorter: 'number', frozen: true },
      { field: 'request_code', title: 'Số phiếu', width: 112, frozen: true, cssClass: 'code col-code' },
      { field: '_status', title: 'Trạng thái', width: 122, sorter: (a, b, ra, rb) => ra.getData()._st.label.localeCompare(rb.getData()._st.label),
        formatter: (cell) => { const s = cell.getRow().getData()._st; return `<span class="st ${s.color}">${App.esc(s.label)}</span>`; } },
      { field: 'unit', title: 'Đơn vị đề xuất', width: 140, editor: 'list', editorParams: listEditor(cat.units.map((u) => u.name), true) },
      { field: 'material_group', title: 'Nhóm VT', width: 95, editor: 'list',
        editorParams: listEditor(cat.material_groups.map((g) => ({ value: g.name, label: g.description ? g.name + ' — ' + g.description : g.name })), true),
        mutatorEdit: (v) => Logic.normalizeMaterialGroup(v, cat.material_groups),
        tooltip: (e, cell) => { const v = cell.getValue(); const g = cat.material_groups.find((x) => x.name === v); return g && g.description ? v + ' — ' + g.description : (v || false); } },
      { field: 'name', title: 'Tên vật tư', width: 240, editor: 'list', editable: canEdit, editorParams: historyEditor('name', false) },
      { field: 'uom', title: 'ĐVT', width: 70, editor: 'list', editorParams: listEditor(cat.uoms.map((u) => u.name), true) },
      numCol('qty_requested', 'SL yêu cầu', 90, true),
      numCol('qty_on_hand', 'SL tồn kho', 85, true),
      { field: 'need_date', title: 'Ngày cần có', width: 110, editor: 'date', formatter: fmtDateCell, mutatorEdit: (v) => Logic.parseDate(v) },
      { field: 'project_code', title: 'Mã HM', width: 95, editor: 'list', editorParams: listEditor(projectValues, true) },
      { field: 'project_name', title: 'Hạng mục', width: 180, editor: 'list', editorParams: listEditor(projectValues.map((p) => findProjectName(p.value) || p.label), true) },
      { field: 'purpose', title: 'Mục đích sử dụng', width: 200, editor: 'list', editorParams: historyEditor('purpose', false) },
      { field: 'equipment_name', title: 'Tên thiết bị', width: 140, editor: 'list', editorParams: historyEditor('equipment_name', false) },
      { field: 'delivery_location', title: 'Địa điểm giao', width: 130, editor: 'list', editorParams: historyEditor('delivery_location') },
      { field: 'requester', title: 'Người yêu cầu', width: 130, editor: 'list', editorParams: historyEditor('requester') },
      { field: 'request_date', title: 'Ngày yêu cầu', width: 110, editor: 'date', formatter: fmtDateCell, mutatorEdit: (v) => Logic.parseDate(v) },
      { field: 'supplier', title: 'NCC / Người cấp', width: 120, editor: 'list', editorParams: historyEditor('supplier') },
      numCol('unit_price', 'Đơn giá', 100, true),
      numCol('amount', 'Thành tiền', 110),
      numCol('qty_received', 'Đã nhận', 75),
      numCol('qty_missing', 'Còn thiếu', 80),
      { field: 'last_received_date', title: 'Ngày nhận', width: 100, formatter: fmtDateCell },
      { field: 'note', title: 'Ghi chú', width: 160, editor: 'input' },
      { field: 'week', title: 'Tuần', width: 75 },
      { field: 'month', title: 'Tháng', width: 80 },
      { field: 'created_by', title: 'Người tạo', width: 95 },
    ];
  }

  function rowFormatter(row) {
    const d = row.getData();
    const el = row.getElement();
    el.classList.toggle('has-code', !!d.request_code);
    el.classList.toggle('saving', pending.has(d._key) || inflight.has(d._key));
    if (d.request_code && !isAdmin()) {
      LOCKED_AFTER_ISSUE.forEach((f) => { const c = row.getCell(f); if (c) c.getElement().classList.add('locked'); });
    }
  }

  // ---------- Lưu tự động ----------

  function markDirty(row, fields) {
    const key = row.getData()._key;
    const set = pending.get(key) || new Set();
    fields.forEach((f) => set.add(f));
    pending.set(key, set);
    row.reformat();
    scheduleSave(500);
  }

  function scheduleSave(ms) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, ms);
  }

  /**
   * row.update khi một ô đang mở trình sửa có thể ném lỗi 'removeChild … blur' của Tabulator (dữ liệu vẫn đúng).
   * Không để lỗi hiển thị nhầm là "chưa lưu được": thử lại sau khi ô đóng.
   */
  function safeUpdate(row, data) {
    try { row.update(data); return; } catch (e) { /* thử lại bên dưới */ }
    setTimeout(() => { try { row.update(data); } catch (e) { console.warn('row.update', e); } }, 250);
  }

  async function flushSaves() {
    if (saving) { scheduleSave(300); return; }
    const batch = [];
    pending.forEach((fields, key) => {
      const row = table.getRow(key);
      if (!row) { pending.delete(key); return; }
      const d = row.getData();
      if (!d.id && inflight.has(key)) return; // chờ dòng mới được tạo xong rồi mới gửi tiếp (tránh tạo trùng)
      const out = d.id ? { id: d.id, key } : { key };
      (d.id ? Array.from(fields) : EDITABLE_FIELDS).forEach((f) => { out[f] = d[f] === undefined ? null : d[f]; });
      batch.push(out);
      pending.delete(key);
      if (!d.id) inflight.add(key);
    });
    if (!batch.length) return;
    saving = true;
    ui.unsaved = pending.size + batch.length;
    try {
      const res = await Api.call('lines.save', { lines: batch });
      res.forEach((r) => {
        inflight.delete(r.key);
        const row = table.getRow(r.key);
        if (!row) return;
        // giữ giá trị người dùng vừa gõ trong lúc chờ (nếu có)
        const dirty = pending.get(r.key) || new Set();
        const local = row.getData();
        const merged = Object.assign({}, r.line);
        dirty.forEach((f) => { merged[f] = local[f]; });
        safeUpdate(row, Object.assign(merged, derive(merged)));
        try { row.getElement().classList.remove('save-error'); row.reformat(); } catch (err) { /* bảng đang vẽ lại, bỏ qua */ }
      });
      historyCache = null;
    } catch (e) {
      batch.forEach((b) => {
        inflight.delete(b.key);
        const set = pending.get(b.key) || new Set();
        Object.keys(b).forEach((f) => { if (f !== 'id' && f !== 'key') set.add(f); });
        pending.set(b.key, set);
        const row = table.getRow(b.key);
        if (row) row.getElement().classList.add('save-error');
      });
      App.toast('Chưa lưu được: ' + e.message, 'error');
    } finally {
      saving = false;
      ui.unsaved = pending.size;
      if (pending.size && Array.from(pending.keys()).some((k) => !inflight.has(k))) {
        // còn sửa mới trong lúc lưu → lưu tiếp; lỗi thì chờ người dùng sửa/bấm "Lưu lại"
        const anyNew = Array.from(pending.keys()).some((k) => { const r = table.getRow(k); return r && !r.getElement().classList.contains('save-error'); });
        if (anyNew) scheduleSave(300);
      }
    }
  }

  /** Chờ mọi thay đổi được lưu xong (trước khi xuất phiếu…). */
  async function flushAll() {
    clearTimeout(saveTimer);
    for (let i = 0; i < 20 && (pending.size || saving); i++) {
      if (saving) await new Promise((r) => setTimeout(r, 200));
      else {
        const before = pending.size;
        await flushSaves();
        if (pending.size && pending.size >= before) break; // lỗi lặp lại
      }
    }
    if (pending.size) throw new Error('Còn ' + pending.size + ' dòng chưa lưu được — hãy sửa lỗi trước.');
  }

  function onCellEdited(cell) {
    const field = cell.getField();
    const row = cell.getRow();
    const d = row.getData();
    const changes = {};
    if (field === 'name' && d.name) {
      const h = history().byName[Logic.fold(d.name)];
      if (h) ['uom', 'material_group', 'unit_price'].forEach((f) => { if ((d[f] === null || d[f] === undefined || d[f] === '') && h[f]) changes[f] = h[f]; });
    }
    if (field === 'project_code' && d.project_code) {
      const normCode = normProjectCode(d.project_code);
      if (normCode !== d.project_code) changes.project_code = normCode;
      const pName = findProjectName(normCode);
      if (pName) changes.project_name = pName;
    }
    if (field === 'project_name' && d.project_name && projectByName[d.project_name]) changes.project_code = projectByName[d.project_name];
    Object.assign(changes, derive(Object.assign({}, d, changes)));
    safeUpdate(row, changes);
    markDirty(row, [field].concat(Object.keys(changes).filter((f) => EDITABLE_FIELDS.includes(f))));
    updateInfo();
  }

  // ---------- Bàn phím + dán ----------

  function editCellOf(row, field) {
    const c = row && row.getCell(field);
    if (c) { row.scrollTo().then(() => c.edit()).catch(() => c.edit()); }
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey) return;
    const cellEl = e.target.closest && e.target.closest('.tabulator-cell');
    if (!cellEl || !e.target.matches('input, select, textarea')) return;
    const field = cellEl.getAttribute('tabulator-field');
    const rows = table.getRows('active');
    const rowEl = cellEl.closest('.tabulator-row');
    const idx = rows.findIndex((r) => r.getElement() === rowEl);
    if (idx < 0) return;
    setTimeout(() => {
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (err) { /* bỏ qua */ }
      setTimeout(() => {
        if (idx === rows.length - 1) ui.addRow(field);
        else editCellOf(rows[idx + 1], field);
      }, 120);
    }, 30);
  }

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

  function onPaste(e) {
    if (e.target.matches && e.target.matches('input, select, textarea')) return; // đang sửa 1 ô: dán bình thường
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    e.preventDefault();
    const data = parseTsv(text);
    if (!data.length) return;
    const editCols = table.getColumns().filter((c) => EDITABLE_FIELDS.includes(c.getField()) && c.isVisible()).map((c) => c.getField());
    let startCol = 0;
    let rows = table.getRows('active');
    let startRow = rows.length; // không chọn ô → thêm dòng mới ở cuối
    if (lastCell) {
      const ci = editCols.indexOf(lastCell.field);
      const ri = rows.findIndex((r) => r.getData()._key === lastCell.key);
      if (ci >= 0 && ri >= 0) { startCol = ci; startRow = ri; }
    }
    let skipped = 0;
    let created = 0;
    data.forEach((vals, i) => {
      let row = rows[startRow + i];
      if (!row) {
        table.addRow(defaultsForNewRow(), false);
        rows = table.getRows('active');
        row = rows[rows.length - 1];
        created++;
      }
      const d = row.getData();
      const changes = {};
      vals.forEach((raw, j) => {
        const field = editCols[startCol + j];
        if (!field) return;
        if (d.request_code && !isAdmin() && LOCKED_AFTER_ISSUE.includes(field)) { skipped++; return; }
        const v = raw.trim();
        changes[field] = NUM_FIELDS.includes(field) ? Logic.parseNum(v)
          : DATE_FIELDS.includes(field) ? Logic.parseDate(v) : field === 'material_group' ? Logic.normalizeMaterialGroup(v, App.boot.catalogs.material_groups) : (v || null);
      });
      const fields = Object.keys(changes);
      if (!fields.length) return;
      safeUpdate(row, Object.assign(changes, derive(Object.assign({}, d, changes))));
      markDirty(row, fields);
    });
    historyCache = null;
    scheduleSave(100);
    updateInfo();
    App.toast('Đã dán ' + data.length + ' dòng' + (created ? ' (thêm mới ' + created + ')' : '') +
      (skipped ? '; bỏ qua ' + skipped + ' ô bị khóa vì đã có số phiếu' : '') + '. Đang lưu…', skipped ? 'error' : 'ok');
  }

  function defaultsForNewRow() {
    return prepare({
      _key: newKey(), id: null, request_code: null, requester: App.user.full_name, request_date: today,
      created_by: App.user.username, qty_received: 0, last_received_date: null,
    });
  }

  // ---------- Bộ lọc ----------

  function filterFn(d) {
    const f = ui.f;
    if (!d.id) return true; // dòng mới luôn hiện
    if (f.noCode && d.request_code) return false;
    if (f.mine && d.created_by !== App.user.username) return false;
    if (f.code && !Logic.fold(d.request_code).includes(Logic.fold(f.code))) return false;
    if (f.project && (d.project_code || d.project_name) !== f.project && d.project_name !== f.project) return false;
    if (f.unit && d.unit !== f.unit) return false;
    if (f.week && d.week !== f.week) return false;
    if (f.month && d.month !== f.month) return false;
    if (f.status && !Logic.matchStatus(d._st, f.status)) return false;
    if (f.q) {
      const words = Logic.fold(f.q).split(/\s+/).filter(Boolean);
      if (!words.every((w) => d._s.includes(w))) return false;
    }
    return true;
  }

  function buildOptions(rows) {
    const projects = new Set();
    const units = new Set();
    const weeks = new Set();
    const months = new Set();
    rows.forEach((r) => {
      if (r.project_code || r.project_name) projects.add(r.project_code || r.project_name);
      if (r.unit) units.add(r.unit);
      if (r.week) weeks.add(r.week);
      if (r.month) months.add(r.month);
    });
    const byYearDesc = (a, b) => { const [x1, y1] = a.split('/').map(Number); const [x2, y2] = b.split('/').map(Number); return y2 - y1 || x2 - x1; };
    ui.opts = {
      projects: Array.from(projects).sort((a, b) => a.localeCompare(b, 'vi')),
      units: Array.from(units).sort((a, b) => a.localeCompare(b, 'vi')),
      weeks: Array.from(weeks).sort(byYearDesc),
      months: Array.from(months).sort(byYearDesc),
    };
  }

  function updateInfo() {
    if (!table) return;
    const total = table.getDataCount();
    const shown = table.getDataCount('active');
    const sel = table.getSelectedRows().length;
    ui.info = total + ' dòng' + (shown !== total ? ' · đang hiện ' + shown : '') + (sel ? ' · đã chọn ' + sel : '');
  }

  /**
   * Chỉnh độ rộng cột theo dữ liệu thật để không bị cắt "…": đo bằng canvas, lấy mức đủ cho ~97% dòng
   * (tối đa AUTO_MAX px, dòng dài hơn tự xuống dòng) và luôn đủ rộng cho tiêu đề (tiêu đề dài tự xuống 2 dòng).
   */
  const AUTO_MAX = 440;
  const FIXED_FIELDS = ['id', 'request_code'];
  function autoFitColumns(rows) {
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (text, bold) => { ctx.font = (bold ? '600 ' : '') + '14px "Noto Sans", system-ui, sans-serif'; return ctx.measureText(text).width; };
    const cache = new Map();
    const w = (s) => { let v = cache.get(s); if (v === undefined) { v = measure(s); cache.set(s, v); } return v; };
    const text = {
      _status: (d) => d._st.label,
      need_date: (d) => Logic.fmtDate(d.need_date), request_date: (d) => Logic.fmtDate(d.request_date),
      last_received_date: (d) => Logic.fmtDate(d.last_received_date),
    };
    NUM_FIELDS.concat(['amount', 'qty_received', 'qty_missing']).forEach((f) => { text[f] = (d) => Logic.fmtNum(d[f]); });
    table.blockRedraw();
    table.getColumns().forEach((col) => {
      const field = col.getField();
      if (!field || FIXED_FIELDS.includes(field)) return;
      const title = col.getDefinition().title || '';
      const words = title.split(/\s+/);
      const headMin = Math.max(...words.map((s) => measure(s, true))) + 36;
      const headFull = measure(title, true) + 36;
      const get = text[field] || ((d) => d[field]);
      const widths = [];
      for (let i = 0; i < rows.length; i++) {
        const v = get(rows[i]);
        if (v !== null && v !== undefined && v !== '') widths.push(w(String(v)));
      }
      widths.sort((a, b) => a - b);
      const content = widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.97))] + 24 : 0;
      col.setWidth(Math.round(Math.max(headMin, Math.min(headFull, 150), Math.min(content, AUTO_MAX))));
    });
    table.restoreRedraw();
  }

  /** Nối phần dữ liệu cũ vào ĐẦU bảng (id nhỏ hơn) mà không làm nhảy vị trí người dùng đang xem. */
  async function addOlder(older) {
    const holder = document.querySelector('#grid .tabulator-tableholder');
    const fromBottom = holder ? holder.scrollHeight - holder.scrollTop : 0;
    const have = new Set(table.getData().map((d) => d.id).filter(Boolean));
    const rows = older.filter((o) => !have.has(o.id)).map((o) => prepare(Object.assign({}, o)));
    try {
      if (rows.length) await table.addData(rows, true);
    } catch (e) { console.warn('addOlder', e); }
    if (holder) holder.scrollTop = holder.scrollHeight - fromBottom;
    autoFitColumns(table.getData());
    historyCache = null;
    buildOptions(table.getData());
    ui.loadingMore = false;
    updateInfo();
  }

  /** Áp phần thay đổi từ máy chủ lên bảng đang hiển thị (không đụng dòng đang có sửa chưa lưu). */
  async function applyDiff(diff) {
    const byId = new Map();
    table.getData().forEach((d) => { if (d.id) byId.set(d.id, d._key); });
    const up = [];
    diff.upsert.forEach((o) => {
      const key = byId.get(o.id) || ('i' + o.id);
      if (pending.has(key) || inflight.has(key)) return;
      up.push(prepare(Object.assign({}, o, { _key: key })));
    });
    const rm = diff.removed.map((id) => byId.get(id)).filter(Boolean);
    try {
      if (up.length + rm.length > 200) {
        // Đổi nhiều (vd. Quản trị vừa dọn dữ liệu cũ): vẽ lại cả bảng một lần — xóa/sửa từng dòng hàng nghìn lần sẽ treo trình duyệt
        const gone = new Set(rm);
        const byKey = new Map();
        table.getData().forEach((d) => { if (!gone.has(d._key)) byKey.set(d._key, d); });
        up.forEach((d) => byKey.set(d._key, d));
        await table.replaceData(Array.from(byKey.values()));
      } else {
        if (up.length) await table.updateOrAddData(up);
        if (rm.length) await table.deleteRow(rm);
      }
    } catch (e) { console.warn('applyDiff', e); }
    if (up.length || rm.length) {
      historyCache = null;
      buildOptions(table.getData());
      updateInfo();
    }
  }

  // ---------- Phiếu: cấp số / thêm vào phiếu cũ / gỡ khỏi phiếu ----------

  /** Gọi API; nếu máy chủ báo khác hạng mục / nơi giao (MIXED) thì hỏi rồi gọi lại. Người dùng không đồng ý → null. */
  async function callMixed(action, params) {
    try {
      return await Api.call(action, params);
    } catch (e) {
      if (e.code !== 'MIXED') throw e;
      if (!confirm(e.message)) return null;
      return Api.call(action, Object.assign({}, params, { confirm_mixed: true }));
    }
  }

  function checkIssuable(data) {
    const bad = data.filter((d) => !d.name || !(d.qty_requested > 0));
    if (bad.length) App.toast(bad.length + ' dòng thiếu tên vật tư hoặc số lượng yêu cầu.', 'error');
    return !bad.length;
  }

  /** Lưu hết thay đổi đang chờ rồi trả id của các dòng (dòng mới cần được tạo xong trên máy chủ). */
  async function savedIds(rows) {
    await flushAll();
    const ids = rows.map((r) => r.getData().id);
    if (ids.some((id) => !id)) throw new Error('Có dòng chưa lưu xong, thử lại sau giây lát.');
    return ids;
  }

  function markIssued(rows, code) {
    rows.forEach((r) => {
      const d = Object.assign({}, r.getData(), { request_code: code });
      safeUpdate(r, Object.assign({ request_code: code }, derive(d)));
      r.deselect();
      r.reformat();
    });
    if (code) lastCode = code;
    updateInfo();
  }

  /** Thêm các dòng (chưa có phiếu) vào phiếu `code` đã xuất, rồi mở phiếu để in lại với đủ dòng. */
  async function appendRows(rows, code) {
    if (!checkIssuable(rows.map((r) => r.getData()))) return;
    const win = App.openPrintWindow();
    if (win) win.document.write('<p style="font:16px sans-serif;padding:24px">Đang thêm vào phiếu ' + App.esc(code) + '…</p>');
    try {
      const ids = await savedIds(rows);
      const res = await callMixed('requests.append', { code, line_ids: ids });
      if (!res) { if (win) win.close(); return; }
      markIssued(rows, res.code);
      table.deselectRow(); // bỏ tick cả dòng của phiếu cũ đã chọn kèm
      App.toast('Đã thêm ' + ids.length + ' dòng vào phiếu ' + res.code + '.', 'ok', 6000);
      if (win) win.location.href = App.printUrl([res.code]);
      else window.open(App.printUrl([res.code]), '_blank');
    } catch (e) {
      if (win) win.close();
      App.toast(e.message, 'error');
    }
  }

  /** Ô "Hạng mục" của form → {code, name}: khớp danh mục, hoặc tách dạng "mã — tên", còn lại coi là tên. */
  function formProjectOf(text) {
    const t = (text || '').trim();
    if (!t) return { code: null, name: null };
    if (formProjects.has(t)) return formProjects.get(t);
    const i = t.indexOf(' — ');
    if (i > 0) return { code: t.slice(0, i).trim() || null, name: t.slice(i + 3).trim() || null };
    return { code: null, name: t };
  }

  /** Số phiếu đang có trên bảng (mới nhất trước) để gợi ý ô "Thêm vào phiếu có sẵn" của form. */
  function knownCodes() {
    const set = new Set();
    table.getData().forEach((d) => { if (d.request_code && !/^LS-/i.test(d.request_code)) set.add(d.request_code); });
    return Array.from(set).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 300);
  }

  // ---------- Trạng thái Alpine ----------

  const state = {
    f: { q: '', noCode: false, mine: false, code: '', project: '', unit: '', week: '', month: '', status: '' },
    opts: { projects: [], units: [], weeks: [], months: [] },
    statusFilters: Logic.STATUS_FILTERS,
    info: 'Đang tải…',
    unsaved: 0,
    loadingMore: false, // đang tải phần dữ liệu cũ hơn ở nền

    // ---------- Form thêm nhiều vật tư ----------
    fm: { open: false, busy: false, error: '', pasteOpen: false, paste: '', c: {}, items: [], lastCode: '' },
    dl: { units: [], projects: [], uoms: [], loc: [], req: [], purpose: [], sup: [], name: [], equip: [], groups: [], codes: [] },
    isAdmin: false,

    /** Danh sách gợi ý dùng chung cho form thêm và form sửa. */
    fillLists() {
      const cat = App.boot.catalogs;
      const h = history().lists;
      const projects = new Map();
      cat.project_items.forEach((p) => {
        const code = p.item_code || p.project_code;
        const name = p.item_name || p.project_name;
        if (code || name) projects.set([code, name].filter(Boolean).join(' — '), { code: code || null, name: name || null });
      });
      formProjects = projects;
      this.dl = {
        units: cat.units.map((u) => u.name).filter(Boolean), projects: Array.from(projects.keys()), uoms: cat.uoms.map((u) => u.name).filter(Boolean),
        loc: h.delivery_location, req: h.requester, purpose: h.purpose, sup: h.supplier, name: h.name,
        equip: h.equipment_name, groups: cat.material_groups.filter((g) => g.name).map((g) => ({ code: g.name, desc: g.description || '' })),
        codes: knownCodes(),
      };
    },
    openForm() {
      this.fillLists();
      if (!this.fm.items.length) { this.fm.items = []; this.formAddRow(3); }
      this.fm.c = Object.assign({
        unit: '', project: '', delivery_location: '', requester: App.user.full_name, request_date: today, need_date: '', purpose: '', supplier: '', equipment_name: '', material_group: '',
        append_code: '',
      }, this.fm.c.unit !== undefined ? this.fm.c : {});
      this.fm.lastCode = lastCode;
      this.fm.prevNeed = this.fm.c.need_date || '';
      this.formNeedDate();
      this.fm.error = '';
      this.fm.open = true;
      setTimeout(() => { const el = document.getElementById('fm-name-0'); if (el) el.focus(); }, 100);
    },
    // ---------- Form sửa một dòng ----------
    ef: { open: false, key: null, error: '', locked: false, code: '', d: {} },

    /** Tick đúng 1 dòng rồi bấm "Sửa dòng": mở form đầy đủ các trường của dòng đó. */
    openEdit() {
      const rows = table.getSelectedRows();
      if (rows.length !== 1) { App.toast(rows.length ? 'Chỉ chọn 1 dòng để sửa bằng form (sửa nhiều dòng: nhấp thẳng vào ô).' : 'Hãy tick chọn 1 dòng cần sửa.', 'error'); return; }
      const r = rows[0].getData();
      this.fillLists();
      const d = {};
      EDITABLE_FIELDS.forEach((f) => { d[f] = r[f] === null || r[f] === undefined ? '' : r[f]; });
      d.project = [r.project_code, r.project_name].filter(Boolean).join(' — ');
      this.ef = { open: true, key: r._key, error: '', locked: !!r.request_code && !isAdmin(), code: r.request_code || '', id: r.id, d };
      setTimeout(() => { const el = document.getElementById('ef-name'); if (el) el.focus(); }, 100);
    },
    saveEdit() {
      const e = this.ef;
      const row = table.getRow(e.key);
      if (!row) { e.error = 'Không tìm thấy dòng (có thể đã bị xóa).'; return; }
      const cur = row.getData();
      const t = (v) => (v === null || v === undefined ? '' : String(v)).trim() || null;
      const next = {
        unit: t(e.d.unit), material_group: Logic.normalizeMaterialGroup(t(e.d.material_group), App.boot.catalogs.material_groups) || t(e.d.material_group),
        name: t(e.d.name), uom: t(e.d.uom), qty_requested: Logic.parseNum(e.d.qty_requested), qty_on_hand: Logic.parseNum(e.d.qty_on_hand),
        need_date: e.d.need_date || null, purpose: t(e.d.purpose), equipment_name: t(e.d.equipment_name), delivery_location: t(e.d.delivery_location),
        requester: t(e.d.requester), request_date: e.d.request_date || null, supplier: t(e.d.supplier), unit_price: Logic.parseNum(e.d.unit_price), note: t(e.d.note),
      };
      const pj = formProjectOf(e.d.project);
      next.project_code = pj.code; next.project_name = pj.name;
      if (!next.name) { e.error = 'Thiếu tên vật tư.'; return; }
      if (!(next.qty_requested > 0)) { e.error = 'Số lượng yêu cầu phải lớn hơn 0.'; return; }
      const same = (a, b) => (a === null || a === undefined || a === '' ? null : a) === (b === null || b === undefined || b === '' ? null : b);
      const changes = {};
      Object.keys(next).forEach((f) => {
        if (e.locked && LOCKED_AFTER_ISSUE.includes(f)) return; // dòng đã có phiếu: người thường không đổi được tên/số lượng
        if (!same(next[f], cur[f])) changes[f] = next[f];
      });
      const fields = Object.keys(changes);
      if (!fields.length) { e.open = false; App.toast('Không có thay đổi.', 'ok'); return; }
      safeUpdate(row, Object.assign(changes, derive(Object.assign({}, cur, changes))));
      markDirty(row, fields);
      historyCache = null;
      updateInfo();
      e.open = false;
      App.toast('Đã sửa ' + fields.length + ' trường, đang lưu…', 'ok');
    },
    closeForm() {
      if (this.fm.busy) return;
      const filled = this.fm.items.some((i) => (i.name || '').trim());
      if (filled && !confirm('Đóng form? Các vật tư đang nhập chưa lưu sẽ giữ lại cho lần mở sau.')) return;
      this.fm.open = false;
    },
    formAddRow(n) { for (let i = 0; i < n; i++) { const it = newFormItem(); it.need_date = this.fm.c.need_date || ''; this.fm.items.push(it); } },
    formRemove(i) { this.fm.items.splice(i, 1); if (!this.fm.items.length) this.formAddRow(1); },
    formEnter(i) {
      if (i === this.fm.items.length - 1) this.formAddRow(1);
      setTimeout(() => { const el = document.getElementById('fm-name-' + (i + 1)); if (el) el.focus(); }, 60);
    },
    formName(it) {
      const hit = history().byName[Logic.fold(it.name)];
      if (hit && !it.uom && hit.uom) it.uom = hit.uom;
    },
    formProject() { /* nhận diện lúc lưu */ },
    /** Ngày cần có chung → điền xuống mọi dòng chưa có ngày riêng (hoặc đang mang ngày chung cũ), để nhìn thấy ngay. */
    formNeedDate() {
      const now = this.fm.c.need_date || '';
      const prev = this.fm.prevNeed || '';
      this.fm.items.forEach((it) => { if (!it.need_date || it.need_date === prev) it.need_date = now; });
      this.fm.prevNeed = now;
    },
    /** Chọn phiếu cũ để thêm vào: ô thông tin chung nào đang trống thì lấy theo dòng của phiếu đó. */
    formAppendCode() {
      const code = (this.fm.c.append_code || '').trim().toUpperCase();
      this.fm.c.append_code = code;
      const first = code && table.getData().find((d) => d.request_code === code);
      if (!first) return;
      const c = this.fm.c;
      const fill = (k, v) => { if (!(c[k] || '').trim() && v) c[k] = v; };
      ['unit', 'delivery_location', 'requester', 'purpose', 'supplier', 'equipment_name', 'material_group'].forEach((k) => fill(k, first[k]));
      fill('need_date', first.need_date);
      fill('project', [first.project_code, first.project_name].filter(Boolean).join(' — '));
    },
    formPaste() {
      const rows = parseTsv(this.fm.paste.replace(/\s+$/, '')).filter((r) => (r[0] || '').trim());
      if (!rows.length) { this.fm.error = 'Chưa có dòng nào để thêm.'; return; }
      // bỏ các dòng trống đang có ở cuối rồi nối thêm
      while (this.fm.items.length && !(this.fm.items[this.fm.items.length - 1].name || '').trim()) this.fm.items.pop();
      rows.forEach((r) => {
        const it = Object.assign(newFormItem(), { name: r[0].trim(), uom: (r[1] || '').trim(), qty_requested: (r[2] || '').trim(), note: (r[3] || '').trim() });
        this.formName(it);
        this.fm.items.push(it);
      });
      this.fm.paste = ''; this.fm.pasteOpen = false; this.fm.error = '';
    },
    async formSubmit(issue) {
      this.fm.error = '';
      const c = this.fm.c;
      const items = [];
      for (let i = 0; i < this.fm.items.length; i++) {
        const it = this.fm.items[i];
        if (!(it.name || '').trim() && !String(it.qty_requested || '').trim()) continue; // dòng trống bỏ qua
        const name = (it.name || '').trim();
        const qty = Logic.parseNum(it.qty_requested);
        if (!name) { this.fm.error = 'Dòng ' + (i + 1) + ': thiếu tên vật tư.'; return; }
        if (!(qty > 0)) { this.fm.error = 'Dòng ' + (i + 1) + ' (' + name + '): nhập số lượng lớn hơn 0.'; return; }
        const hit = history().byName[Logic.fold(name)] || {};
        const t = (v) => (v || '').trim() || null;
        const price = Logic.parseNum(it.unit_price);
        const row = {
          name, uom: t(it.uom) || hit.uom || null, qty_requested: qty, qty_on_hand: Logic.parseNum(it.qty_on_hand), note: t(it.note),
          material_group: Logic.normalizeMaterialGroup(t(it.material_group), App.boot.catalogs.material_groups) || (t(c.material_group) ? null : hit.material_group) || null,
          unit_price: price !== null ? price : (hit.unit_price || null),
          need_date: it.need_date || null, purpose: t(it.purpose), equipment_name: t(it.equipment_name), supplier: t(it.supplier),
        };
        if (t(it.project)) {
          const pj = formProjectOf(it.project);
          row.project_code = pj.code; row.project_name = pj.name;
        }
        items.push(row);
      }
      if (!items.length) { this.fm.error = 'Chưa có vật tư nào.'; return; }
      const proj = formProjectOf(c.project);
      const common = {
        unit: c.unit || null, project_code: proj.code, project_name: proj.name, delivery_location: c.delivery_location || null,
        requester: c.requester || null, request_date: c.request_date || null, need_date: c.need_date || null,
        purpose: c.purpose || null, supplier: c.supplier || null, equipment_name: c.equipment_name || null, material_group: Logic.normalizeMaterialGroup(c.material_group, App.boot.catalogs.material_groups),
      };
      // có chọn phiếu cũ → thêm vào phiếu đó (giữ số); không thì lưu thường / cấp số mới
      const appendCode = (c.append_code || '').trim().toUpperCase();
      if (appendCode) issue = false;
      if (appendCode && !confirm('Lưu ' + items.length + ' vật tư và thêm vào phiếu ' + appendCode + ' (giữ nguyên số phiếu)?')) return;
      if (issue && !confirm('Lưu ' + items.length + ' vật tư và cấp số phiếu mới?')) return;
      const win = issue || appendCode ? App.openPrintWindow() : null;
      if (win) win.document.write('<p style="font:16px sans-serif;padding:24px">' + (appendCode ? 'Đang thêm vào phiếu ' + App.esc(appendCode) : 'Đang cấp số phiếu') + '…</p>');
      this.fm.busy = true;
      try {
        const res = await callMixed('lines.create', { common, items, issue: !!issue, append_code: appendCode || null });
        if (!res) { if (win) win.close(); this.fm.busy = false; return; }
        await table.addData(res.lines.map((l) => prepare(l)), false);
        historyCache = null;
        updateInfo();
        this.fm.items = []; this.formAddRow(3);
        this.fm.c.append_code = '';
        if (res.code) { lastCode = res.code; this.fm.lastCode = res.code; }
        this.fm.open = false;
        table.scrollToRow('i' + res.lines[res.lines.length - 1].id, 'bottom', false).catch(() => {});
        App.toast('Đã thêm ' + res.lines.length + ' vật tư' + (res.code ? (appendCode ? ' vào phiếu ' : ' — phiếu ') + res.code : '') + '.', 'ok', 6000);
        if (res.code) {
          if (win) win.location.href = App.printUrl([res.code]);
          else window.open(App.printUrl([res.code]), '_blank');
        }
      } catch (e) {
        if (win) win.close();
        this.fm.error = e.message;
      }
      this.fm.busy = false;
    },

    async init() {
      ui = this;
      App.prefetchRecent(); // chạy song song với tải danh mục để hiện dữ liệu tháng này sớm hơn
      const boot = await App.init();
      today = boot.today || today;
      this.isAdmin = isAdmin();
      boot.catalogs.project_items.forEach((p) => {
        const code = p.item_code || p.project_code;
        const name = p.item_name || p.project_name;
        if (code) {
          projectByCode[code] = name;
          projectByCode[String(code).trim().toUpperCase()] = name;
        }
        if (name) projectByName[name] = code;
      });
      table = new Tabulator('#grid', {
        index: '_key',
        height: 'max(360px, calc(100vh - 190px))', // chiều cao cố định → bảng ảo hóa, chỉ vẽ dòng đang thấy
        layout: 'fitData',
        renderVertical: 'virtual',
        placeholder: () => placeholderText,
        selectableRows: 'highlight', // chỉ chọn bằng ô tick, nhấp ô khác để sửa
        columnDefaults: { headerTooltip: true, headerWordWrap: true, resizable: true, variableHeight: true },
        editTriggerEvent: 'click',
        rowFormatter,
        columns: columns(boot.catalogs),
      });
      table.on('cellEdited', onCellEdited);
      table.on('cellEditing', (cell) => {
        const v = cell.getValue();
        editStart = v === null || v === undefined || v === '' ? null : Logic.fold(v);
        // bôi đen chữ cũ: gõ là thay luôn, không phải xóa tay từng ký tự
        setTimeout(() => { const inp = cell.getElement().querySelector('input'); if (inp && inp.select) inp.select(); }, 30);
      });
      table.on('cellClick', (e, cell) => { lastCell = { key: cell.getRow().getData()._key, field: cell.getField() }; });
      table.on('rowSelectionChanged', updateInfo);
      table.on('dataFiltered', () => setTimeout(updateInfo));
      const el = document.getElementById('grid');
      el.addEventListener('keydown', onKeyDown, true);
      el.addEventListener('paste', onPaste);
      el.setAttribute('tabindex', '0');
      window.addEventListener('beforeunload', (e) => { if (pending.size || inflight.size) { e.preventDefault(); e.returnValue = ''; } });
      await new Promise((r) => table.on('tableBuilt', r));
      await this.reload();
    },

    async reload() {
      placeholderText = 'Chưa có dòng nào khớp. Bấm "+ Thêm dòng" hoặc dán từ Excel.';
      const render = async (objects) => {
        // sao chép để các trường phụ của bảng (_st, _s…) không lẫn vào bản lưu trong trình duyệt
        const rows = objects.map((o) => prepare(Object.assign({}, o)));
        await table.setData(rows);
        autoFitColumns(rows);
        historyCache = null;
        buildOptions(rows);
        table.setFilter(filterFn);
        updateInfo();
        if (rows.length) table.scrollToRow(rows[rows.length - 1]._key, 'bottom', false).catch(() => {});
      };
      let cachedRender = null;
      let partialRender = null;
      try {
        const res = await App.loadLines(
          (cached) => { cachedRender = render(cached); },
          // Lần đầu: hiện ngay dữ liệu tháng này, phần cũ hơn nối vào sau
          { onPartial: (p) => { ui.loadingMore = true; partialRender = render(p.objects); } },
        );
        if (cachedRender) await cachedRender;
        if (partialRender) await partialRender;
        if (res.older) await addOlder(res.older);
        else if (!res.diff) await render(res.objects);
        else await applyDiff(res.diff);
      } catch (e) {
        ui.loadingMore = false;
        if (partialRender) { App.toast('Mới tải được dữ liệu tháng này; chưa tải được phần cũ hơn (' + e.message + '). Bấm "↻ Cập nhật" để thử lại.', 'error'); return; }
        if (cachedRender) { App.toast('Đang hiển thị dữ liệu đã lưu; chưa cập nhật được: ' + e.message, 'error'); return; }
        placeholderText = 'Lỗi tải dữ liệu: ' + e.message;
        table.redraw(true);
        App.toast(e.message, 'error');
      }
    },

    applyFilters() { table.refreshFilter(); },
    clearFilters() {
      Object.keys(this.f).forEach((k) => { this.f[k] = typeof this.f[k] === 'boolean' ? false : ''; });
      table.refreshFilter();
    },

    addRow(field) {
      table.addRow(defaultsForNewRow(), false).then((row) => {
        updateInfo();
        editCellOf(row, typeof field === 'string' ? field : 'name');
      });
    },

    retrySave() {
      table.getRows().forEach((r) => r.getElement().classList.remove('save-error'));
      flushSaves();
    },

    /**
     * Xuất phiếu: dòng chưa có phiếu → cấp số mới; dòng đã có phiếu → in lại đúng số cũ;
     * chọn dòng mới + dòng của MỘT phiếu cũ → thêm các dòng mới vào phiếu cũ đó (giữ số).
     */
    async issue() {
      const rows = table.getSelectedRows();
      if (!rows.length) { App.toast('Hãy tick chọn các dòng cần xuất phiếu.', 'error'); return; }
      const data = rows.map((r) => r.getData());
      const codes = Array.from(new Set(data.map((d) => d.request_code).filter(Boolean)));
      const uncoded = rows.filter((r) => !r.getData().request_code);
      if (codes.length && uncoded.length) {
        if (codes.length > 1) {
          App.toast('Đang chọn ' + uncoded.length + ' dòng chưa có phiếu cùng dòng của ' + codes.length + ' phiếu khác nhau (' +
            codes.slice(0, 3).join(', ') + '). Muốn thêm vào phiếu cũ thì chỉ chọn kèm dòng của đúng 1 phiếu.', 'error');
          return;
        }
        if (!confirm('Thêm ' + uncoded.length + ' dòng chưa có phiếu vào phiếu ' + codes[0] + ' (giữ nguyên số phiếu)?')) return;
        await appendRows(uncoded, codes[0]);
        return;
      }
      if (codes.length) { window.open(App.printUrl(codes), '_blank'); return; }
      if (!checkIssuable(data)) return;

      const win = App.openPrintWindow();
      if (win) win.document.write('<p style="font:16px sans-serif;padding:24px">Đang cấp số phiếu…</p>');
      try {
        const ids = await savedIds(rows);
        const res = await callMixed('requests.issue', { line_ids: ids });
        if (!res) { if (win) win.close(); return; }
        markIssued(rows, res.code);
        App.toast('Đã cấp số phiếu ' + res.code + ' cho ' + ids.length + ' dòng.', 'ok', 6000);
        if (win) win.location.href = App.printUrl([res.code]);
        else window.open(App.printUrl([res.code]), '_blank');
      } catch (e) {
        if (win) win.close();
        App.toast(e.message, 'error');
      }
    },

    /** Nút "Thêm vào phiếu có sẵn…": các dòng chưa có phiếu đang chọn → vào một phiếu đã xuất (quên vật tư). */
    async appendPrompt() {
      const rows = table.getSelectedRows();
      const uncoded = rows.filter((r) => !r.getData().request_code);
      if (!uncoded.length) { App.toast('Hãy tick chọn các dòng CHƯA có số phiếu cần thêm vào phiếu cũ.', 'error'); return; }
      if (uncoded.length < rows.length) { App.toast('Có ' + (rows.length - uncoded.length) + ' dòng đã có số phiếu — hãy bỏ chọn các dòng đó.', 'error'); return; }
      const s = prompt('Thêm ' + uncoded.length + ' dòng vào phiếu số (vd. ' + (lastCode || 'YC2026-295') + '):', lastCode || '');
      if (!s || !s.trim()) return;
      await appendRows(uncoded, s.trim().toUpperCase());
    },

    /** Quản trị: gỡ các dòng đã chọn khỏi phiếu (dòng trở lại "chưa có phiếu" để sửa / xuất lại / thêm vào phiếu khác). */
    async detach() {
      const rows = table.getSelectedRows().filter((r) => r.getData().request_code);
      if (!rows.length) { App.toast('Hãy tick chọn các dòng đã có số phiếu cần gỡ.', 'error'); return; }
      const codes = Array.from(new Set(rows.map((r) => r.getData().request_code)));
      if (!confirm('Gỡ ' + rows.length + ' dòng khỏi phiếu ' + codes.slice(0, 6).join(', ') + (codes.length > 6 ? '…' : '') +
        '?\n\nDòng vẫn giữ nguyên dữ liệu và lần nhận hàng, chỉ trở lại trạng thái "chưa có phiếu". Số phiếu không được cấp lại. Việc này được ghi vào nhật ký.')) return;
      try {
        await flushAll();
        await Api.call('requests.detach', { line_ids: rows.map((r) => r.getData().id) });
        markIssued(rows, null);
        App.toast('Đã gỡ ' + rows.length + ' dòng khỏi phiếu ' + codes.join(', ') + '.', 'ok', 6000);
      } catch (e) { App.toast(e.message, 'error'); }
    },

    reprintPrompt() {
      const s = prompt('Nhập số phiếu cần in lại (nhiều số cách nhau bằng dấu phẩy):', '');
      if (!s) return;
      const codes = s.split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (codes.length) window.open(App.printUrl(codes), '_blank');
    },

    async duplicate() {
      const rows = table.getSelectedRows();
      if (!rows.length) { App.toast('Hãy chọn dòng cần nhân bản.', 'error'); return; }
      try {
        await flushAll();
        const ids = rows.map((r) => r.getData().id).filter(Boolean);
        const copies = await Api.call('lines.duplicate', { ids });
        await table.addData(copies.map(prepare), false);
        rows.forEach((r) => r.deselect());
        historyCache = null;
        updateInfo();
        table.scrollToRow('i' + copies[copies.length - 1].id, 'bottom', false).catch(() => {});
        App.toast('Đã nhân bản ' + copies.length + ' dòng (xuống cuối bảng).', 'ok');
      } catch (e) { App.toast(e.message, 'error'); }
    },

    async remove() {
      const rows = table.getSelectedRows();
      if (!rows.length) { App.toast('Hãy chọn dòng cần xóa.', 'error'); return; }
      const coded = rows.filter((r) => r.getData().request_code);
      if (coded.length && !isAdmin()) {
        App.toast(coded.length + ' dòng đã có số phiếu: chỉ Quản trị được xóa. Hãy bỏ chọn các dòng này hoặc nhờ Quản trị.', 'error');
        return;
      }
      if (coded.length) {
        const codes = Array.from(new Set(coded.map((r) => r.getData().request_code)));
        const list = codes.slice(0, 6).join(', ') + (codes.length > 6 ? ' … (+' + (codes.length - 6) + ' phiếu)' : '');
        if (!confirm('CẢNH BÁO: ' + coded.length + ' dòng đã thuộc phiếu ' + list + '.\n\nXóa sẽ làm các phiếu này mất những dòng đó khi in lại (số phiếu vẫn giữ nguyên, không cấp lại), ' +
          'và xóa cả lần nhận hàng của các dòng đó. Việc này được ghi vào nhật ký.\n\nVẫn xóa ' + rows.length + ' dòng đã chọn?')) return;
      } else if (!confirm('Xóa ' + rows.length + ' dòng đã chọn?')) return;
      try {
        // dòng mới đang được tạo trên máy chủ: chờ có id rồi mới xóa, kẻo xóa trên màn hình mà máy chủ vẫn còn
        if (rows.some((r) => inflight.has(r.getData()._key))) { try { await flushAll(); } catch (e) { /* dòng lỗi lưu: chỉ có trên máy này */ } }
        const ids = rows.map((r) => r.getData().id).filter(Boolean);
        if (ids.length) await Api.call('lines.delete', { ids });
        rows.forEach((r) => { pending.delete(r.getData()._key); r.delete(); });
        ui.unsaved = pending.size;
        historyCache = null;
        updateInfo();
        App.toast('Đã xóa ' + rows.length + ' dòng.', 'ok');
      } catch (e) { App.toast(e.message, 'error'); }
    },

    exportExcel() {
      const rows = table.getData('active').filter((r) => r.id);
      App.exportExcel('vat-tu-' + today + '.xlsx', [{ name: 'Vật tư', rows, columns: EXPORT_COLUMNS }]);
    },
  };
  return state;
}
