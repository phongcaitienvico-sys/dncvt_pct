# Đề nghị cấp vật tư (ĐNCVT)

Web app nhỏ thay cho Google Sheet "Đề nghị cấp vật tư": nhập vật tư vào một bảng chung, tick dòng, **Xuất phiếu PDF** (tự cấp số `YC<năm>-<số>`), in lại đúng số cũ, nhận hàng nhiều đợt.

**Kiến trúc:** giao diện tĩnh trên **GitHub Pages** (`docs/`) → gọi **Google Apps Script** (`apps-script/`) → dữ liệu nằm trong **một Google Sheet** (mỗi bảng một tab). Cấp số phiếu chạy trong `LockService`, nên hai người bấm cùng lúc không bị trùng hay nhảy số. Phiếu PDF mặc định **A5 ngang** (210 × 148 mm), có thể chọn **A4 ngang** (297 × 210 mm) để các cột rộng hơn, hoặc khổ dọc. Người dùng bấm "In / Lưu PDF" trên trình duyệt; khổ giấy và số dòng mỗi trang được nhớ trên máy đang dùng.

## 1. Cài đặt lần đầu (≈ 20 phút)

1. **Tạo Google Sheet dữ liệu**
   - Có dữ liệu cũ: làm mục 2 trước, rồi tải `out/db_khoi_tao.xlsx` lên Google Drive → *Mở bằng Google Trang tính*.
   - Bắt đầu trống: tạo một Google Sheet mới.
2. **Gắn backend:** trong Sheet chọn *Tiện ích mở rộng → Apps Script*.
   - Chạy `npm run bundle`, rồi dán toàn bộ `dist/Code.gs` vào file `Code.gs`.
   - *Cài đặt dự án* → bật "Hiển thị tệp kê khai appsscript.json" → dán nội dung `dist/appsscript.json`.
3. Chọn hàm **`setup`** → *Chạy* → cấp quyền. Mật khẩu `admin` hiện ở *Nhật ký thực thi*: đăng nhập rồi đổi ngay.
   Chạy thêm **`installTriggers`** để sao lưu tự động lúc 23h mỗi đêm.
4. **Triển khai:** *Triển khai → Triển khai mới → Ứng dụng web*, "Thực thi với tư cách: **Tôi**", "Ai có quyền truy cập: **Bất kỳ ai**". Chép URL kết thúc bằng `/exec`.
5. Dán URL đó vào `docs/js/config.js` (`API_URL`).
6. **GitHub Pages:** đẩy repo lên GitHub → *Settings → Pages → Branch `main`, thư mục `/docs`*. Mở `https://<tên>.github.io/<repo>/`.
7. Vào **Quản trị → Người dùng** để tạo tài khoản cho 5–6 người.

> Sửa code backend: sửa `apps-script/*.js` → `npm run bundle` → dán lại → *Triển khai → Quản lý triển khai → Chỉnh sửa → Phiên bản mới* (giữ nguyên URL).

## 2. Import dữ liệu từ Sheet cũ

```bash
python scripts/import_sheet.py samples/QL_De_nghi_cap_vat_tu.xlsx --dry-run
```
```bash
python scripts/import_sheet.py samples/QL_De_nghi_cap_vat_tu.xlsx
```
- Lệnh đầu chỉ in **báo cáo đối soát**: tổng dòng, tổng thành tiền so với cột "Thành tiền", số phiếu theo tháng, số dòng lỗi.
- Lệnh sau ghi `out/db_khoi_tao.xlsx`, `out/import_errors.xlsx` (dòng, cột, giá trị, lý do) và `out/import_report.txt`. Chạy lại bao nhiêu lần cũng không nhân đôi dữ liệu, file gốc chỉ được đọc.
- Dòng có số phiếu sai mẫu (vd. "Nam làm phiếu"), hoặc để trống mà đã cũ, được gán phiếu lịch sử `LS-0001…` (`legacy_flag`). Dòng trống số phiếu trong 30 ngày gần nhất (`--pending-days`) được giữ lại để xuất phiếu trong app.
- Bộ đếm số phiếu năm 2026 bắt đầu từ **294** (`CONFIG.INITIAL_SEQ` trong `apps-script/Config.js`) → phiếu tiếp theo là YC2026-295.

## 3. Dùng hằng ngày

| Màn hình | Việc chính |
|---|---|
| **Bảng vật tư** | Nhấp ô để sửa, tự lưu. Enter xuống dòng (ở dòng cuối sẽ thêm dòng mới). Ctrl+V dán nhiều dòng từ Excel. Tick dòng → **Xuất phiếu PDF**. Dòng đã có phiếu chỉ Quản trị sửa được tên và số lượng, mọi sửa đều ghi nhật ký. **Quên vật tư sau khi xuất phiếu:** tick dòng mới + 1 dòng của phiếu cũ rồi bấm Xuất phiếu (hoặc *Thêm vào phiếu đã xuất…*, hoặc ô "Thêm vào phiếu đã xuất" trong form) → giữ nguyên số phiếu. Quản trị có *Gỡ khỏi phiếu*. |
| **Nhận hàng** | Dùng được trên điện thoại. Nhập SL + ngày nhận, nhận nhiều đợt. Nhập nhầm thì tự xóa lần nhận của mình trong ngày rồi nhận lại. |
| **Theo hạng mục** | Tổng tiền, % đã nhận, xuất Excel. |
| **Phiếu đã xuất** | Mở/in lại phiếu; chọn nhiều phiếu → 1 file PDF; Đơn đặt hàng theo NCC; Phiếu bàn giao. |
| **Quản trị** | Danh mục (kể cả **Người ký phiếu đề nghị**: chức danh + họ tên theo đơn vị), người dùng, nhật ký, Sao lưu ngay, Xuất toàn bộ ra Excel, **Dọn dữ liệu cũ** (xem trước → tự sao lưu → xóa dòng trước một ngày). |

**Chỉnh mẫu in:** chỉ sửa `docs/js/print_mapping.js` (tên công ty, mã biểu mẫu, ô đầu phiếu, cột, số dòng/trang, chữ ký) và các template `docs/print/*.html` (cú pháp Jinja/Nunjucks). Số dòng mỗi trang chọn được 10–40 ngay trên trang in. Trạng thái dòng tính trong `computeStatus()` ở `docs/js/logic.js`.

## 4. Chạy thử trên máy & kiểm thử

```bash
npm run dev
```
Mở http://localhost:8787. Dev server chạy **đúng code Apps Script** với Sheet giả lập (`dev/data/db.json`), mật khẩu admin ghi trong `dev/data/DEV_CREDENTIALS.txt`. Xóa thư mục `dev/data/` để làm lại từ đầu.

```bash
npm test
```
```bash
python -m pytest tests_py
```
- `npm test`: cấp số phiếu (liên tiếp, không trùng, lỗi không tiêu số, sang năm mới), khóa sửa, nhật ký, in lại, đăng nhập, trạng thái.
- `pytest`: import.
- `tools/concurrency_check.js`: bắn N lệnh xuất phiếu song song vào một URL. Chỉ chạy trên **bản Sheet thử**.
- `tools/perf_check.js`: đo tốc độ bảng bằng Edge headless.
- `node tools/layout_check.js`: kiểm tra bảng 8.000 dòng, kéo hẹp cột, nội dung dài và PDF A5/A4 ngang bằng dữ liệu giả; cần Chrome, `playwright` và `pdf-lib`. Ảnh và PDF kiểm tra nằm trong `out/layout-check/` (không đưa lên Git).

## 5. Sao lưu & bảo mật

- Sao lưu tự động mỗi đêm vào thư mục Drive `NCVT_backup`, giữ 30 bản; ngoài ra có nút **Sao lưu ngay**. Google Sheet cũng có sẵn *Lịch sử phiên bản*.
- **Mật khẩu:** băm HMAC-SHA256 lặp 300 vòng, có salt riêng (Apps Script không có bcrypt).
- **Đăng nhập:** sai 5 lần thì khóa 15 phút. Phiên là token ký HMAC, hạn 12 giờ, gửi trong thân request (không dùng cookie nên không bị CSRF).
- **Ghi dữ liệu:** chỉ các trường cho phép, có kiểm tra kiểu/độ dài. Chuỗi bắt đầu bằng `=` được ghi như chữ, không thành công thức.
- **Bí mật:** `SECRET_KEY` nằm trong *Script Properties*, không có trong repo. Repo GitHub Pages là public, nên **không** đưa `samples/`, `out/`, `dev/data/` lên (đã có trong `.gitignore`).
