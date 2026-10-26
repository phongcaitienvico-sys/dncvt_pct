# Hướng dẫn Triển khai & Chuyển đổi (Cutover) sang Supabase

Tài liệu vận hành dành cho Quản trị / IT khi nâng cấp hệ thống **Đề nghị cấp vật tư** từ Google Apps Script + Google Sheet sang **Supabase (PostgreSQL + RLS + Edge Functions)** trên gói miễn phí (Free Tier), giữ nguyên giao diện GitHub Pages.

---

## 1. Tạo Project Supabase Singapore (Free Tier)

1. Đăng nhập [https://supabase.com/dashboard](https://supabase.com/dashboard) → bấm **New project**.
2. Chọn cấu hình:
   - **Name**: `dncvt-pct`
   - **Region**: **Southeast Asia (Singapore)** (`ap-southeast-1`) để độ trễ mạng từ Việt Nam thấp nhất.
   - **Pricing Plan**: **Free**.
   - Lưu lại mật khẩu Database (`DB Password`) vào trình quản lý mật khẩu nội bộ.
3. Vào **Project Settings → API**, lấy 3 thông tin:
   - `Project URL` (`SUPABASE_URL`, dạng `https://<project-ref>.supabase.co`)
   - `anon` `public` key (`SUPABASE_ANON_KEY`) — được phép điền vào `docs/js/config.js` vì mọi bảng đều khóa bằng RLS + RPC `SECURITY DEFINER`.
   - `service_role` `secret` key (`SUPABASE_SERVICE_ROLE_KEY`) — **TUYỆT ĐỐI BÍ MẬT**, chỉ dùng trên máy IT lúc chạy script di chuyển dữ liệu và tự động có sẵn trong môi trường Edge Function.
4. Vào **Authentication → Sign In / Providers** (hoặc **Authentication → Providers → Email**):
   - **TẮT (OFF)** công tắc **"Allow new users to sign up"** để chặn tuyệt đối người lạ dùng `SUPABASE_ANON_KEY` công khai tự đăng ký trước các địa chỉ `<username>@dncvt.local` (chỉ Quản trị mới được tạo tài khoản qua Edge Function `admin-ops`).
   - Bật **Enable Email provider**.
   - **TẮT (OFF)** *Confirm email* (hệ thống dùng tài khoản nội bộ `username` ánh xạ sang `<username>@dncvt.local`, không gửi thư xác nhận ra ngoài).

---

## 2. Khởi tạo CSDL (`001_schema_rls_rpc.sql`) & Deploy Edge Function `admin-ops`

### 2.1. Chạy Migration SQL
Cách 1 — Qua giao diện **SQL Editor** trên Supabase Dashboard:
- Mở file `supabase/migrations/001_schema_rls_rpc.sql`, dán toàn bộ nội dung vào **SQL Editor** và bấm **Run**.

Cách 2 — Qua Supabase CLI:
```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```

Kiểm tra nhanh hàm giữ ấm CSDL:
```bash
curl -fsS -X POST "https://<PROJECT_REF>.supabase.co/rest/v1/rpc/healthcheck" \
  -H "apikey: <SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d "{}"
```

### 2.2. Triển khai Edge Function `admin-ops`
Edge Function `admin-ops` xử lý 3 thao tác nhạy cảm (`login`, `auth.changePassword`, `users.save`) kèm chống dò mật khẩu và khóa tài khoản tức thì:
```bash
npx supabase functions deploy admin-ops --project-ref <PROJECT_REF> --no-verify-jwt
```
*(Hàm tự xác thực chữ ký JWT nội bộ cho `auth.changePassword` và `users.save`, đồng thời cho phép `login` đi qua bằng `apikey` công khai.)*

---

## 3. Quy trình Cutover 5 Phút Không Trùng Số Phiếu & Keepalive / Sao Lưu

Thực hiện vào giờ nghỉ trưa hoặc cuối giờ chiều (tổng thời gian ngừng ghi ~5 phút):

### Bước 3.1. Bật khóa bảo trì trên Apps Script cũ (Chống Split-Brain)
1. Mở Apps Script của Google Sheet cũ, trong `Config.js` đổi:
   ```js
   MAINTENANCE_MODE: true,
   ```
2. Bấm **Deploy → Manage deployments → Edit → Version: New version → Deploy**.
   - Từ giây này, mọi tab trình duyệt cũ nếu bấm lưu/xuất phiếu sẽ nhận thông báo: *"Hệ thống đã nâng cấp sang máy chủ mới. Vui lòng bấm Ctrl+F5 để tải lại trang."*
   - Thao tác đọc và **Xuất toàn bộ ra Excel (`export.all`)** vẫn mở để IT lấy bản chốt cuối cùng.

### Bước 3.2. Xuất bản chốt & Nạp sang Supabase (Giữ nguyên số phiếu liên tiếp)
1. Vào trang **Quản trị → Dữ liệu & sao lưu → Xuất toàn bộ ra Excel** để tải file chốt `ncvt-toan-bo-YYYY-MM-DD.xlsx` (hoặc tải file Google Sheet `.xlsx`).
2. Chạy công cụ chuyển dữ liệu sang Supabase (chạy thử `--dry-run` trước để đối soát số dòng, tổng tiền và số thứ tự phiếu `request_seq` lớn nhất, sau đó chạy thật):
   ```bash
   export SUPABASE_URL="https://<PROJECT_REF>.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="<SERVICE_ROLE_SECRET>"

   # Kiểm tra đối soát trước (không ghi DB)
   python scripts/migrate_to_supabase.py ncvt-toan-bo-YYYY-MM-DD.xlsx --dry-run

   # Nạp chính thức và đồng bộ bộ đếm số phiếu YC2026-xxx
   python scripts/migrate_to_supabase.py ncvt-toan-bo-YYYY-MM-DD.xlsx --execute
   ```
3. Kiểm tra trên **SQL Editor** để chắc chắn bộ đếm phiếu (`sequences`) khớp đúng số phiếu cuối cùng vừa cấp trên Sheet cũ:
   ```sql
   SELECT * FROM public.sequences ORDER BY id DESC;
   ```

### Bước 3.3. Mở cấu hình Frontend trên GitHub Pages
1. Mở `docs/js/config.js`, điền thông tin project và chuyển `BACKEND_MODE` sang `'supabase'`:
   ```js
   window.APP_CONFIG = {
     BACKEND_MODE: 'supabase',
     SUPABASE_URL: 'https://<PROJECT_REF>.supabase.co',
     SUPABASE_ANON_KEY: '<SUPABASE_ANON_KEY>',
     API_URL: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
       ? '/api'
       : 'https://script.google.com/macros/s/.../exec',
   };
   ```
2. Gắn mã phiên bản mới cho toàn bộ tài nguyên tĩnh để trình duyệt tải ngay bản mới, rồi đẩy lên nhánh phát hành:
   ```bash
   npm run stamp
   git add docs/js/config.js docs/*.html
   git commit -m "chore: cutover frontend sang Supabase"
   git push
   ```
3. Đăng nhập thử tài khoản Quản trị trên trang web, kiểm tra bảng vật tư, in thử 1 phiếu cũ và bấm **Quản trị → Sao lưu ngay** để xác nhận cả 2 lớp sao lưu hoạt động tốt.

### Bước 3.4. Chống ngủ đông gói Free (Keepalive 2 lớp mỗi 12 giờ)
Supabase Free tạm dừng project nếu 7 ngày không có truy vấn; GitHub Actions trên repo ít commit có thể tự tắt lịch cron sau 60 ngày. Vì vậy cần bật song song 2 kênh:
1. **Trên GitHub (Repo hiện tại)**: Vào **Settings → Secrets and variables → Actions → Variables**, tạo 2 Repository Variables:
   - `SUPABASE_URL` = `https://<PROJECT_REF>.supabase.co`
   - `SUPABASE_ANON_KEY` = `<SUPABASE_ANON_KEY>`
   *(Workflow `.github/workflows/supabase-keepalive.yml` sẽ tự ping `/rest/v1/rpc/healthcheck` mỗi 12 giờ, hoàn toàn không chứa dữ liệu nhạy cảm trên repo Public.)*
2. **Trên [cron-job.org](https://cron-job.org) (Miễn phí, độc lập với GitHub)**:
   - Tạo 1 Cronjob chạy mỗi **12 giờ** (`0 */12 * * *`).
   - **URL**: `https://<PROJECT_REF>.supabase.co/rest/v1/rpc/healthcheck`
   - **Request method**: `POST`
   - **Headers**:
     - `apikey`: `<SUPABASE_ANON_KEY>`
     - `Authorization`: `Bearer <SUPABASE_ANON_KEY>`
     - `Content-Type`: `application/json`
   - **Request body**: `{}`
   - Bật cảnh báo email nếu phản hồi khác `200 OK`.

### Bước 3.5. Mẫu Sao lưu `pg_dump` Tự động Hàng đêm (CHỈ ĐẶT TRÊN REPO PRIVATE)
> **CẢNH BÁO BẢO MẬT**: Tuyệt đối **KHÔNG** chạy `pg_dump` hoặc upload file sao lưu trên repository Public! Hãy tạo một repository GitHub **Private** riêng (ví dụ `dncvt-pct-backup-private`), khai báo Secret `SUPABASE_DB_URL` (chuỗi Session Pooler port `5432` trong **Database → Connect**) và tạo file `.github/workflows/nightly-backup.yml` trên repo **Private** đó:

```yaml
name: Nightly PostgreSQL Backup (Private Repo Only)

on:
  schedule:
    - cron: '0 16 * * *' # 23:00 giờ Việt Nam (UTC+7)
  workflow_dispatch:

permissions:
  contents: write

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Dump Supabase PostgreSQL database
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
        run: |
          mkdir -p backups
          STAMP=$(TZ=Asia/Ho_Chi_Minh date +%Y-%m-%d_%H%M)
          pg_dump "$SUPABASE_DB_URL" \
            --schema=public \
            --no-owner \
            --no-privileges \
            --format=plain \
            | gzip -9 > "backups/ncvt_${STAMP}.sql.gz"
          ls -1t backups/ncvt_*.sql.gz | tail -n +31 | xargs -r rm -f
      - name: Commit encrypted/compressed backups to Private repo
        run: |
          git config user.name "ncvt-backup-bot"
          git config user.email "backup@ncvt.local"
          git add backups/
          git diff --cached --quiet || git commit -m "backup: nightly dump"
          git push
```

---

## 4. Cầu dao Rollback Khẩn cấp trong 60 Giây

Nếu phát sinh sự cố bất khả kháng ngay sau khi Cutover và cần quay lại Google Sheet ngay lập tức:

1. **Mở lại quyền ghi trên Apps Script**:
   - Trong Apps Script `Config.js`, đổi `MAINTENANCE_MODE: false` → **Deploy → Manage deployments → Edit → New version → Deploy**.
2. **Gạt cầu dao 1 dòng trên Frontend**:
   - Trong `docs/js/config.js`, đổi duy nhất 1 dòng:
     ```js
     BACKEND_MODE: 'gas',
     ```
   - Chạy `npm run stamp`, commit và `git push` lên GitHub Pages.
3. Người dùng tải lại trang (`Ctrl+F5`) và đăng nhập lại để làm việc bình thường trên Google Sheet mà không cần thay đổi bất kỳ trang HTML hay nghiệp vụ nào.
