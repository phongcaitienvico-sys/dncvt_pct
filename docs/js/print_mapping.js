/**
 * ÁNH XẠ MẪU IN — muốn chỉnh mẫu phiếu chỉ cần sửa file này và file template trong docs/print/.
 *
 * field: đường dẫn tới dữ liệu
 *   - đầu phiếu: 'request.code', 'request.issued_by', 'header.unit', 'header.project' (mã — tên),
 *                'header.project_code', 'header.project_name', 'header.delivery_location',
 *                'header.requester', 'header.request_date', 'header.note'
 *   - cột bảng: 'stt' hoặc tên trường của dòng: name, uom, qty_requested, need_date, purpose, note,
 *               material_group, equipment_name, supplier, unit_price, amount, qty_on_hand, project_name…
 * format: 'date' (dd/mm/yyyy) | 'num' | 'money' | bỏ trống
 */
window.PRINT_MAPPING = {
  company: {
    name: 'CÔNG TY ...',          // TODO: thay theo Form1
    address: '',
  },

  // ---------- Phiếu đề nghị cấp vật tư (MẪU TẠM — chờ Form1) ----------
  phieu_de_nghi: {
    title: 'PHIẾU ĐỀ NGHỊ CẤP VẬT TƯ',
    form_code: 'Mã hiệu: BM-…',   // TODO: mã hiệu biểu mẫu theo Form1
    rows_per_page: 20,            // mặc định; trên trang in chọn được 10–40
    min_rows: 0,                  // thêm dòng trống cho đủ số này ở trang cuối (0 = không thêm)
    header: [
      { label: 'Đơn vị đề xuất', field: 'header.unit' },
      { label: 'Ngày đề nghị', field: 'header.request_date', format: 'date' },
      { label: 'Hạng mục', field: 'header.project' },
      { label: 'Địa điểm giao', field: 'header.delivery_location' },
      { label: 'Người đề nghị', field: 'header.requester' },
      { label: 'Ghi chú', field: 'header.note' },
    ],
    columns: [
      { label: 'STT', field: 'stt', width: '10mm', align: 'center' },
      { label: 'Tên vật tư', field: 'name', width: '56mm' },
      { label: 'ĐVT', field: 'uom', width: '13mm', align: 'center' },
      { label: 'SL yêu cầu', field: 'qty_requested', format: 'num', width: '16mm', align: 'right' },
      { label: 'Ngày cần có', field: 'need_date', format: 'date', width: '22mm', align: 'center' },
      { label: 'Mục đích sử dụng', field: 'purpose' },
      { label: 'Ghi chú', field: 'note', width: '24mm' },
    ],
    signatures: [
      { title: 'Người đề nghị', name_field: 'header.requester' },
      { title: 'Trưởng phòng' },
      { title: 'KHVT' },
      { title: 'Giám đốc' },
    ],
  },

  // ---------- Đơn đặt hàng theo nhà cung cấp (phiếu nội bộ) ----------
  don_dat_hang: {
    title: 'ĐƠN ĐẶT HÀNG',
    form_code: '',
    rows_per_page: 25,
    columns: [
      { label: 'STT', field: 'stt', width: '9mm', align: 'center' },
      { label: 'Số phiếu YC', field: 'request_code', width: '23mm' },
      { label: 'Tên vật tư', field: 'name' },
      { label: 'ĐVT', field: 'uom', width: '12mm', align: 'center' },
      { label: 'Số lượng', field: 'qty_requested', format: 'num', width: '15mm', align: 'right' },
      { label: 'Đơn giá', field: 'unit_price', format: 'money', width: '20mm', align: 'right' },
      { label: 'Thành tiền', field: 'amount', format: 'money', width: '24mm', align: 'right' },
      { label: 'Ngày cần', field: 'need_date', format: 'date', width: '21mm', align: 'center' },
    ],
    signatures: [{ title: 'Người lập' }, { title: 'KHVT' }, { title: 'Giám đốc' }],
  },

  // ---------- Phiếu bàn giao (danh sách số phiếu + cột ký nhận) ----------
  phieu_ban_giao: {
    title: 'PHIẾU BÀN GIAO',
    form_code: '',
    rows_per_page: 25,
    columns: [
      { label: 'STT', field: 'stt', width: '10mm', align: 'center' },
      { label: 'Số phiếu', field: 'code', width: '28mm' },
      { label: 'Đơn vị đề xuất', field: 'unit', width: '35mm' },
      { label: 'Hạng mục', field: 'project' },
      { label: 'Số dòng', field: 'line_count', format: 'num', width: '15mm', align: 'center' },
      { label: 'Ngày xuất', field: 'issued_date', format: 'date', width: '23mm', align: 'center' },
      { label: 'Ký nhận', field: '', width: '30mm' },
    ],
    signatures: [{ title: 'Người giao' }, { title: 'Người nhận' }],
  },
};
