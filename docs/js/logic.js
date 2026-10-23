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

  /** Chuyển chuỗi số kiểu Việt/Anh ("1.234,5" / "1,234.5" / "12") → số; null nếu rỗng/sai. */
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
    } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
      s = s.replace(/\./g, '');
    }
    const n = Number(s);
    return isFinite(n) ? n : null;
  };

  L.fmtNum = function (v, digits) {
    if (v === null || v === undefined || v === '') return '';
    return Number(v).toLocaleString('vi-VN', { maximumFractionDigits: digits === undefined ? 3 : digits });
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

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.Logic = L;
})(this);
