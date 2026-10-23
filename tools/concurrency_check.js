/**
 * Kiểm thử "2 người xuất phiếu cùng lúc": tạo N dòng rồi gửi N lệnh cấp số SONG SONG.
 * Kết quả đúng: N số phiếu khác nhau, liên tiếp, không trùng/không nhảy.
 *
 *   node tools/concurrency_check.js <API_URL> <username> <password> [N=5]
 *   vd: node tools/concurrency_check.js http://localhost:8787/api admin xxxxx 5
 *
 * CẢNH BÁO: script tạo dòng + phiếu thật. Chỉ chạy với bản Sheet thử nghiệm, không chạy trên dữ liệu thật.
 */
const [url, username, password, nArg] = process.argv.slice(2);
if (!url || !username || !password) {
  console.error('Cách dùng: node tools/concurrency_check.js <API_URL> <username> <password> [N]');
  process.exit(2);
}
const N = Number(nArg || 5);

async function api(action, params, token) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, params, token }), redirect: 'follow',
  });
  const j = await res.json();
  if (!j.ok) throw new Error(action + ': ' + j.error);
  return j.data;
}

(async () => {
  const { token } = await api('login', { username, password });
  const lines = [];
  for (let i = 0; i < N; i++) lines.push({ key: 'c' + i, name: 'TEST đồng thời ' + i, qty_requested: 1, uom: 'Cái' });
  const saved = await api('lines.save', { lines }, token);
  const t0 = Date.now();
  const results = await Promise.allSettled(saved.map((s) => api('requests.issue', { line_ids: [s.line.id] }, token)));
  const codes = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.code);
  results.filter((r) => r.status === 'rejected').forEach((r) => console.log('Lỗi:', r.reason.message));
  const seqs = codes.map((c) => Number(c.split('-')[1])).sort((a, b) => a - b);
  const unique = new Set(codes).size === codes.length;
  const consecutive = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  console.log('Số phiếu:', codes.join(', '), '(' + (Date.now() - t0) + ' ms)');
  console.log(unique && consecutive && codes.length === N ? 'ĐẠT: không trùng, không nhảy số' : 'KHÔNG ĐẠT');
  process.exit(unique && consecutive && codes.length === N ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
