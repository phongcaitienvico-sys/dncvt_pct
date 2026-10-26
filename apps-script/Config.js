/**
 * Cấu hình chung của backend. Sửa ở đây rồi triển khai lại (Deploy > Manage deployments > Edit > New version).
 */
const CONFIG = {
  APP_NAME: 'Đề nghị cấp vật tư',
  TIMEZONE: 'Asia/Ho_Chi_Minh',
  CODE_PREFIX: 'YC',
  CODE_PAD: 3, // YC2026-001 … YC2026-295 (giống Sheet cũ)
  // Số thứ tự đã dùng tới thời điểm chuyển sang app (YC2026-294 → phiếu tiếp theo là YC2026-295).
  INITIAL_SEQ: { 2026: 294 },
  TOKEN_TTL_HOURS: 12,
  LOGIN_MAX_FAILS: 5,
  LOGIN_BLOCK_MINUTES: 15,
  PASSWORD_ITERATIONS: 300,
  MAX_LINES_PER_REQUEST: 200,
  MAX_TEXT_LENGTH: 1000,
  BACKUP_FOLDER: 'NCVT_backup',
  BACKUP_KEEP: 30,
  // Bật true vào ngày Cutover sang Supabase để chặn ghi trên tab trình duyệt cũ (vẫn cho phép đọc / export.all đối soát)
  MAINTENANCE_MODE: false,
};
