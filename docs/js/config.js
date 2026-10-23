// Địa chỉ Web App Apps Script (Deploy > New deployment > Web app → copy URL kết thúc bằng /exec).
// Khi chạy dev server trên máy (localhost) sẽ tự dùng /api giả lập.
window.APP_CONFIG = {
  API_URL: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '/api'
    : 'https://script.google.com/macros/s/DAN_URL_WEB_APP_VAO_DAY/exec',
};
