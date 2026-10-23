// Địa chỉ Web App Apps Script (Deploy > New deployment > Web app → copy URL kết thúc bằng /exec).
// Khi chạy dev server trên máy (localhost) sẽ tự dùng /api giả lập.
window.APP_CONFIG = {
  API_URL: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '/api'
    : 'https://script.google.com/macros/s/AKfycbxKC1kTR18flqPhAB_2r7gE0T1jp6FUmoEC7mB-mxuqP_Mrv5g-Vz8D04ld1Rwv0IlL-A/exec',
};
