// Địa chỉ Web App Apps Script (Deploy > New deployment > Web app → copy URL kết thúc bằng /exec).
// Khi chạy dev server trên máy (localhost) sẽ tự dùng /api giả lập.
window.APP_CONFIG = {
  // 'gas' (Apps Script / dev server hiện tại) hoặc 'supabase' (khi đã điền SUPABASE_URL & SUPABASE_ANON_KEY)
  BACKEND_MODE: 'gas',
  SUPABASE_URL: 'https://unbrchhbfughabmkorxt.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuYnJjaGhiZnVnaGFibWtvcnh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwNDU4NDUsImV4cCI6MjEwODYyMTg0NX0.RfnJ-prGJOgkbZdxzypTBpSpbknUK8tu6-WXWTF1Pbo',
  API_URL: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '/api'
    : 'https://script.google.com/macros/s/AKfycbxKC1kTR18flqPhAB_2r7gE0T1jp6FUmoEC7mB-mxuqP_Mrv5g-Vz8D04ld1Rwv0IlL-A/exec',
};
