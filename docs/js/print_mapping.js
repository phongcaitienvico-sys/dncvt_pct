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
 * group: cột con cùng nhóm (vd. 'Số lượng' gồm 'Yêu cầu' + 'Tồn kho') → tiêu đề 2 tầng.
 */
window.PRINT_MAPPING = {
  company: {
    name: 'CÔNG TY TNHH THẮNG LỢI',
    address: '',
    logo: 'img/logo.png',          // để '' nếu không in logo
    place: 'Ninh Bình',            // "Ninh Bình, ngày … tháng … năm …"
  },

  // Tên gọi tắt trong dữ liệu cũ (cột "Người yêu cầu") → họ tên đầy đủ khi in chữ ký. So khớp không dấu, không phân biệt hoa thường.
  // Dòng mới nhập sau này lấy theo "Họ tên" của tài khoản nên đã đầy đủ, không cần thêm vào đây.
  name_aliases: {
    'Hà': 'Hoàng Ngọc Hà',
    'Hiếu': 'Nguyễn Văn Hiếu',
    'Nam': 'Phan Thành Nam',
    'Tiệp': 'Trần Việt Tiệp',
    'Duy': 'Tống Đức Duy',
    'Huynh': 'Vũ Thế Huynh',
  },

  // ---------- Phiếu đề nghị cấp vật tư — theo tab Form1 (BM.KHVT.04.01) ----------
  phieu_de_nghi: {
    title_lines: ['PHIẾU', 'ĐỀ NGHỊ CẤP VẬT TƯ'],
    form_code: 'Mã hiệu: BM.KHVT.04.01',
    unit_label: 'Đơn vị đề nghị:',
    rows_per_page: 5,             // A5 ngang; trang in gợi ý số dòng theo khổ giấy
    min_rows: 0,                  // thêm dòng trống cho đủ số này ở trang cuối (0 = không thêm)
    // Tổng 100%; ưu tiên tên vật tư, hạng mục và mục đích, giữ đủ 14 cột Form1.
    columns: [
      { label: 'TT', field: 'stt', width: '3%', align: 'center' },
      { label: 'Tên vật tư', field: 'name', width: '17%' },
      { label: 'ĐVT', field: 'uom', width: '4%', align: 'center' },
      { label: 'Nhóm VT', field: 'material_group', width: '4%', align: 'center' },
      { label: 'Yêu cầu', group: 'Số lượng', field: 'qty_requested', format: 'num', width: '5%', align: 'right' },
      { label: 'Tồn kho', group: 'Số lượng', field: 'qty_on_hand', format: 'num', width: '5%', align: 'right' },
      { label: 'Ngày cần có', field: 'need_date', format: 'date', width: '9%', align: 'center' },
      { label: 'Mã/Tên hạng mục', field: 'project_name', width: '12%' },
      { label: 'Nhóm chi phí', field: '', width: '9%' },            // Sheet cũ để trống
      { label: 'Mục đích sử dụng', field: 'purpose', width: '11%' },
      { label: 'Vị trí giao', field: 'delivery_location', width: '5%' },
      { label: 'Nhận và Ktra hàng', field: 'requester', width: '6%' },
      { label: 'Người mua /NCC', field: 'supplier', width: '6%' },
      { label: 'Yêu cầu chào giá', field: '', width: '4%' },        // ghi tay
    ],
    // NGƯỜI KÝ giờ sửa trong Quản trị → Danh mục → "Người ký phiếu đề nghị". Hai bộ dưới đây chỉ dùng khi Sheet
    // chưa có danh mục đó (chưa bấm "Tạo bộ người ký mặc định" / chưa chạy lại setup).
    // Khối chữ ký mặc định = phòng Thiết bị (và mọi đơn vị khác). name_from: 'requester' → lấy tên ở cột "Người yêu cầu".
    signatures: [
      { title: 'Người lập phiếu', name_from: 'requester' },
      { title: 'Người xem xét', name: 'Vũ Văn Trường' },
      { title: 'T.P Thiết bị', name: 'Vũ Văn Trường' },
      { title: 'Giám đốc duyệt', name: 'Phạm Danh Mạnh' },
    ],
    // Bộ chữ ký riêng theo đơn vị đề nghị (so khớp không dấu, không phân biệt hoa thường; bộ đầu tiên khớp được dùng)
    signature_sets: [
      {
        unit_contains: 'cai tien',   // P.Cải tiến
        signatures: [
          { title: 'Người lập phiếu', name_from: 'requester' },
          { title: 'Người xem xét', name: 'Trần Việt Tiệp' },
          { title: 'T.P Cải tiến', name: 'Trần Việt Tiệp' },
          { title: 'Giám đốc duyệt', name: 'Phạm Danh Mạnh' },
        ],
      },
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
