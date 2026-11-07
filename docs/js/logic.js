/**
 * Hàm thuần dùng chung (trình duyệt + test Node): ngày tháng, số, trạng thái dòng.
 * Muốn đổi cách tính trạng thái → chỉ sửa computeStatus() và chạy `npm test`.
 */
(function (root) {
  const L = {};

  const pad2 = (n) => ('0' + n).slice(-2);

  /** yyyy-mm-dd → số ngày kể từ 1970 (UTC), null nếu rỗng/sai. */
  L.dayNumber = function (iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
  };

  /** Số ngày từ a đến b (b - a). */
  L.daysBetween = (a, b) => L.dayNumber(b) - L.dayNumber(a);

  L.todayIso = function (d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };

  L.fmtDate = function (iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  };

  /** Nhận dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy, yyyy-mm-dd, d/m → yyyy-mm-dd (null nếu sai). */
  L.parseDate = function (s, defaultYear) {
    if (s === null || s === undefined) return null;
    s = String(s).trim();
    if (!s) return null;
    let y, mo, d, m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2}|\d{4}))?$/.exec(s))) {
      d = +m[1]; mo = +m[2];
      y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : (defaultYear || new Date().getFullYear());
    } else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  };

  /** Tuần ISO 8601 (thứ Hai đầu tuần). */
  L.isoWeek = function (iso) {
    const n = L.dayNumber(iso);
    if (n === null) return null;
    const d = new Date(n * 86400000);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  };

  L.monthKey = function (iso) {
    const m = /^(\d{4})-(\d{2})/.exec(iso || '');
    return m ? m[2] + '/' + m[1] : '';
  };

  /** Chuyển chuỗi số kiểu Việt/Anh ("1.234,5" / "1,234.5" / "1.500" = 1500 / "2.5") → số; null nếu rỗng/sai. */
  L.parseNum = function (v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma >= 0) {
      // "1,5" là thập phân; "1,500" (đúng 3 số sau dấu phẩy) là phân cách nghìn
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, ''); // kiểu Việt Nam: "1.500" = 1500
    }
    const n = Number(s);
    return isFinite(n) ? n : null;
  };

  const numFormats = {}; // tạo Intl.NumberFormat 1 lần, dùng lại (gọi hàng nghìn lần khi vẽ bảng)
  L.fmtNum = function (v, digits) {
    if (v === null || v === undefined || v === '') return '';
    const d = digits === undefined ? 3 : digits;
    const f = numFormats[d] || (numFormats[d] = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: d }));
    return f.format(Number(v));
  };

  L.amount = (line) => (Number(line.qty_requested) || 0) * (Number(line.unit_price) || 0);

  L.qtyMissing = function (line) {
    const miss = (Number(line.qty_requested) || 0) - (Number(line.qty_received) || 0);
    return Math.max(0, Math.round(miss * 1000) / 1000);
  };

  L.isFullyReceived = function (line) {
    const req = Number(line.qty_requested) || 0;
    const rec = Number(line.qty_received) || 0;
    return req > 0 ? rec >= req : rec > 0;
  };

  /**
   * Trạng thái dòng (suy luận từ Sheet cũ):
   *  - Đã nhận đủ: so ngày nhận cuối với ngày cần có → "Trễ n ngày" (đỏ) / "Đúng hạn" (xanh lá).
   *  - Chưa nhận đủ: ngày cần - hôm nay = n; n ≥ 0 → "Còn n ngày" (vàng nếu n ≤ 2); n < 0 → "Quá hạn n ngày" (đỏ).
   * key dùng cho bộ lọc: ontime, late, received, due, soon, overdue, nodate.
   */
  L.computeStatus = function (line, today) {
    if (L.isFullyReceived(line)) {
      if (!line.need_date || !line.last_received_date) return { key: 'received', label: 'Đã nhận đủ', color: 'green' };
      const late = L.daysBetween(line.need_date, line.last_received_date);
      return late > 0
        ? { key: 'late', label: 'Trễ ' + late + ' ngày', color: 'red' }
        : { key: 'ontime', label: 'Đúng hạn', color: 'green' };
    }
    if (!line.need_date) return { key: 'nodate', label: 'Chưa có ngày cần', color: 'gray' };
    const n = L.daysBetween(today, line.need_date);
    if (n >= 0) return n <= 2
      ? { key: 'soon', label: 'Còn ' + n + ' ngày', color: 'yellow' }
      : { key: 'due', label: 'Còn ' + n + ' ngày', color: 'blue' };
    return { key: 'overdue', label: 'Quá hạn ' + -n + ' ngày', color: 'red' };
  };

  L.STATUS_FILTERS = [
    ['open', 'Chưa nhận đủ'], ['soon', 'Sắp đến hạn (≤ 2 ngày)'], ['overdue', 'Quá hạn'],
    ['done', 'Đã nhận đủ'], ['late', 'Nhận trễ'], ['ontime', 'Đúng hạn'], ['nodate', 'Chưa có ngày cần'],
  ];

  L.matchStatus = function (status, filter) {
    if (!filter) return true;
    if (filter === 'open') return ['due', 'soon', 'overdue', 'nodate'].includes(status.key);
    if (filter === 'done') return ['received', 'late', 'ontime'].includes(status.key);
    return status.key === filter;
  };

  /** Bỏ dấu tiếng Việt để tìm kiếm. */
  L.fold = function (s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  };

  /** Hai phòng ban đề xuất hợp lệ (quyết định bộ người ký trên phiếu). */
  L.UNITS = ['Phòng Cải tiến', 'Phòng Thiết bị'];

  /** Tên phòng ban (kể cả tên viết tắt cũ: P.Cải tiến, P.CT, P.TB, P. Thiết bị…) → tên chuẩn; không nhận ra → null. */
  L.normalizeUnit = function (v) {
    const s = L.fold(v).replace(/\s+/g, ' ').trim();
    if (/^(phong|p\.?)\s*(cai tien|ct)$/.test(s)) return L.UNITS[0];
    if (/^(phong|p\.?)\s*(thiet bi|tb)$/.test(s)) return L.UNITS[1];
    return null;
  };

  /**
   * Khối chữ ký phiếu đề nghị theo Đơn vị đề xuất. ctx = { mapping: PRINT_MAPPING.phieu_de_nghi, signers: danh mục Người ký, aliases: name_aliases }.
   * Bộ mặc định (unit_contains trống) làm nền, bộ của phòng khớp chỉ ghi đè các vị trí nó khai báo; name_from:'requester' → tên người yêu cầu.
   * Danh mục Người ký rỗng thì dùng bộ trong mapping.
   */
  L.signaturesFor = function (unit, requester, ctx) {
    ctx = ctx || {};
    const m = ctx.mapping || {};
    const aliasMap = {};
    Object.keys(ctx.aliases || {}).forEach((k) => { aliasMap[L.fold(k)] = ctx.aliases[k]; });
    const fullName = (v) => String(v || '').split(/\s*;\s*/).filter(Boolean).map((n) => aliasMap[L.fold(n)] || n)
      .filter((n, i, arr) => arr.findIndex((x) => L.fold(x) === L.fold(n)) === i).join('; ');
    const signerSlot = (r, fallbackPos) => {
      const t = L.fold(r.title || '').trim();
      if (t.includes('lap phieu')) return 1;
      if (t.includes('xem xet')) return 2;
      if (t.startsWith('t.p') || t.includes('truong phong') || t.includes('tp ')) return 3;
      if (t.includes('giam doc')) return 4;
      const p = Number(r.position);
      return p >= 1 ? p : fallbackPos;
    };
    const matchUnitKey = (u, k) => {
      if (!u || !k) return false;
      if (u.includes(k) || k.includes(u)) return true;
      const isTB = (s) => /\bp\.?\s*tb\b|\bthiet bi\b/.test(s);
      const isCT = (s) => /\bp\.?\s*ct\b|\bcai tien\b/.test(s);
      return (isTB(u) && isTB(k)) || (isCT(u) && isCT(k));
    };
    let signerSets = null;
    const rows = (ctx.signers || []).filter((r) => r.title);
    if (rows.length) {
      signerSets = new Map();
      rows.slice().sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || a.id - b.id).forEach((r) => {
        const key = L.fold(r.unit_contains || '').trim();
        if (!signerSets.has(key)) signerSets.set(key, []);
        const arr = signerSets.get(key);
        arr.push({ pos: signerSlot(r, arr.length + 1), title: r.title, name: r.name || '', name_from: r.name ? null : 'requester' });
      });
    }
    const u = L.fold(unit || '').trim();
    const set = (m.signature_sets || []).find((x) => matchUnitKey(u, L.fold(x.unit_contains || '').trim()));
    const base = (set && set.signatures) || m.signatures || [];
    const byPos = new Map();
    base.forEach((s, i) => byPos.set(i + 1, Object.assign({}, s)));
    if (signerSets) {
      (signerSets.get('') || []).forEach((s) => byPos.set(s.pos, Object.assign({}, s)));
      const key = Array.from(signerSets.keys()).find((k) => k && matchUnitKey(u, k));
      if (key !== undefined) (signerSets.get(key) || []).forEach((s) => byPos.set(s.pos, Object.assign({}, s)));
    }
    const list = Array.from(byPos.keys()).sort((a, b) => a - b).map((pos) => byPos.get(pos));
    return list.map((s) => Object.assign({}, s, {
      name: s.name_from === 'requester' ? fullName(requester) : (s.name || ''),
    }));
  };

  /** Chuẩn hóa giá trị Nhóm VT (gõ chữ thường, chọn nhãn "C — Giải thích" hoặc dán tên giải thích) về đúng mã nhóm. */
  L.normalizeMaterialGroup = function (raw, groups) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const cleanKey = (x) => L.fold(x).replace(/[^a-z0-9]+/g, ' ').trim();
    const list = Array.isArray(groups) ? groups : [];
    const wanted = cleanKey(s);
    const prefix = cleanKey(s.split(/\s+[—\-]\s+/)[0]);
    for (let i = 0; i < list.length; i++) {
      const code = String(list[i].name || '').trim();
      if (!code) continue;
      const ck = cleanKey(code);
      if (wanted === ck || prefix === ck) return code;
    }
    for (let i = 0; i < list.length; i++) {
      const code = String(list[i].name || '').trim();
      const parts = String(list[i].description || '').split(';');
      for (let j = 0; j < parts.length; j++) {
        const pk = cleanKey(parts[j]);
        if (pk && wanted === pk) return code;
      }
    }
    return s;
  };

  /**
   * Đọc số tiền thành chữ — viết lại đúng công thức tab "doc so thanh chu" của Sheet Đề nghị thanh toán
   * (12 chữ số chia 4 nhóm tỷ/triệu/ngàn/đơn vị; "lẻ", "mốt", "lăm", "mười"; viết hoa chữ đầu; thêm " đồng./.").
   * Ví dụ: 1310000 → "Một triệu ba trăm mười ngàn đồng./.". Riêng 0 → "Không đồng./.".
   */
  L.numToVietnameseWords = function (n) {
    const v = Math.round(Math.abs(Number(n) || 0));
    if (!v) return 'Không đồng./.';
    const DIG = ['', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
    const s = ('000000000000' + v).slice(-12); // giống RIGHT("000000000000"&ROUND(A8,0),12)
    const units = ['tỷ', 'triệu', 'ngàn', ''];
    const parts = [];
    for (let g = 0; g < 4; g++) {
      const a = +s[g * 3];
      const b = +s[g * 3 + 1];
      const c = +s[g * 3 + 2];
      // hàng trăm
      parts.push(a ? DIG[a] : '', a ? 'trăm' : '');
      // hàng chục
      parts.push(b === 0 ? (a !== 0 && c !== 0 ? 'lẻ' : '') : b === 1 ? 'mười' : DIG[b], b > 1 ? 'mươi' : '');
      // hàng đơn vị
      let w = '';
      if (c === 1) w = b > 1 ? 'mốt' : 'một';
      else if (c === 5) w = b === 0 ? 'năm' : 'lăm';
      else if (c) w = DIG[c];
      parts.push(w, units[g] && (a + b + c) ? units[g] : '');
    }
    const t = parts.join(' ').replace(/\s+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1) + ' đồng./.';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.Logic = L;
})(this);
