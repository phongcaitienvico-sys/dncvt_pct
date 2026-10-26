/**
 * Mỗi bảng = một tab trong Google Sheet, dòng 1 là tiêu đề cột (tên tiếng Anh bên dưới).
 * Kiểu: int, num, str, date (yyyy-mm-dd), datetime, bool, json.
 * Thứ tự cột trong Sheet không quan trọng — đọc theo tên tiêu đề, nên thêm cột mới chỉ cần thêm ở đây.
 */
const SCHEMA = {
  lines: [
    ['id', 'int'], ['request_code', 'str'], ['unit', 'str'], ['material_group', 'str'], ['name', 'str'],
    ['uom', 'str'], ['qty_requested', 'num'], ['qty_on_hand', 'num'], ['need_date', 'date'],
    ['project_code', 'str'], ['project_name', 'str'], ['purpose', 'str'], ['equipment_name', 'str'],
    ['delivery_location', 'str'], ['requester', 'str'], ['request_date', 'date'], ['supplier', 'str'],
    ['unit_price', 'num'], ['note', 'str'], ['legacy_flag', 'bool'], ['created_by', 'str'],
    ['created_at', 'datetime'], ['updated_at', 'datetime'],
  ],
  requests: [
    ['id', 'int'], ['code', 'str'], ['year', 'int'], ['seq', 'int'], ['issued_at', 'datetime'],
    ['issued_by', 'str'], ['header_json', 'json'], ['line_count', 'int'], ['legacy_flag', 'bool'],
  ],
  receipts: [
    ['id', 'int'], ['line_id', 'int'], ['received_date', 'date'], ['qty', 'num'],
    ['received_by', 'str'], ['note', 'str'], ['created_at', 'datetime'],
  ],
  suppliers: [
    ['id', 'int'], ['code', 'str'], ['name', 'str'], ['address', 'str'], ['phone', 'str'],
    ['email', 'str'], ['tax_code', 'str'], ['field', 'str'],
  ],
  project_items: [
    ['id', 'int'], ['project_code', 'str'], ['project_name', 'str'], ['item_code', 'str'],
    ['item_name', 'str'], ['owner', 'str'], ['status', 'str'],
  ],
  material_groups: [['id', 'int'], ['name', 'str'], ['description', 'str']],
  // Người ký trên phiếu đề nghị: unit_contains trống = bộ mặc định; name trống = lấy "Người yêu cầu" của phiếu
  signers: [['id', 'int'], ['unit_contains', 'str'], ['position', 'str'], ['title', 'str'], ['name', 'str']],
  units: [['id', 'int'], ['name', 'str']],
  uoms: [['id', 'int'], ['name', 'str']],
  users: [
    ['id', 'int'], ['username', 'str'], ['full_name', 'str'], ['role', 'str'],
    ['password_hash', 'str'], ['salt', 'str'], ['active', 'bool'], ['created_at', 'datetime'],
  ],
  audit_log: [
    ['id', 'int'], ['at', 'datetime'], ['user', 'str'], ['table', 'str'], ['row_id', 'str'],
    ['field', 'str'], ['old', 'str'], ['new', 'str'],
  ],
  // key = 'YC2026' (số phiếu theo năm) hoặc 'id:<bảng>' (id tự tăng)
  sequences: [['id', 'int'], ['key', 'str'], ['last_value', 'int']],
};

const CATALOG_TABLES = ['suppliers', 'project_items', 'material_groups', 'units', 'uoms', 'signers'];

const DEFAULT_SIGNERS = [
  { unit_contains: '', position: '1', title: 'Người lập phiếu', name: '' },
  { unit_contains: '', position: '2', title: 'Người xem xét', name: 'Vũ Văn Trường' },
  { unit_contains: '', position: '3', title: 'T.P Thiết bị', name: 'Vũ Văn Trường' },
  { unit_contains: '', position: '4', title: 'Giám đốc duyệt', name: 'Phạm Danh Mạnh' },
  { unit_contains: 'Cải tiến', position: '1', title: 'Người lập phiếu', name: '' },
  { unit_contains: 'Cải tiến', position: '2', title: 'Người xem xét', name: 'Trần Việt Tiệp' },
  { unit_contains: 'Cải tiến', position: '3', title: 'T.P Cải tiến', name: 'Trần Việt Tiệp' },
  { unit_contains: 'Cải tiến', position: '4', title: 'Giám đốc duyệt', name: 'Phạm Danh Mạnh' },
];

function columnsOf_(table) {
  const cols = SCHEMA[table];
  if (!cols) fail_('Bảng không hợp lệ: ' + table);
  return cols;
}
