/**
 * Điểm vào Web App. Client gửi POST (Content-Type: text/plain để tránh preflight CORS)
 * với thân JSON {action, params, token}; nhận về {ok, data} hoặc {ok:false, error, code, details}.
 */

function routes_() {
  return {
    'login': { auth: false, fn: apiLogin_ },
    'auth.changePassword': { write: true, fn: apiChangePassword_ },
    'bootstrap': { fn: apiBootstrap_ },
    'lines.list': { fn: apiLinesList_ },
    'lines.sync': { fn: apiLinesSync_ },
    'lines.save': { write: true, fn: apiLinesSave_ },
    'lines.create': { write: true, fn: apiLinesCreate_ },
    'lines.delete': { write: true, fn: apiLinesDelete_ },
    'lines.duplicate': { write: true, fn: apiLinesDuplicate_ },
    'requests.issue': { write: true, fn: apiRequestsIssue_ },
    'requests.get': { fn: apiRequestsGet_ },
    'requests.list': { fn: apiRequestsList_ },
    'receipts.add': { write: true, fn: apiReceiptsAdd_ },
    'receipts.list': { fn: apiReceiptsList_ },
    'receipts.delete': { write: true, admin: true, fn: apiReceiptsDelete_ },
    'catalog.save': { write: true, admin: true, fn: apiCatalogSave_ },
    'catalog.delete': { write: true, admin: true, fn: apiCatalogDelete_ },
    'users.list': { admin: true, fn: apiUsersList_ },
    'users.save': { write: true, admin: true, fn: apiUsersSave_ },
    'audit.list': { admin: true, fn: apiAuditList_ },
    'export.all': { admin: true, fn: apiExportAll_ },
    'backup.run': { admin: true, fn: apiBackupRun_ },
  };
}

function dispatch_(req) {
  if (!req || typeof req !== 'object') fail_('Yêu cầu không hợp lệ');
  const route = routes_()[req.action];
  if (!route) fail_('Thao tác không hợp lệ: ' + req.action);
  const params = req.params && typeof req.params === 'object' ? req.params : {};
  const ctx = { user: null, audit: [] };
  if (route.auth !== false) ctx.user = verifyToken_(req.token);
  if (route.admin && ctx.user.role !== 'admin') fail_('Chỉ Quản trị được thực hiện thao tác này.', 'FORBIDDEN');
  if (route.write) return withLock_(ctx, function () { return route.fn(params, ctx); });
  return route.fn(params, ctx);
}

function handle_(body) {
  try {
    return { ok: true, data: dispatch_(JSON.parse(body)) };
  } catch (err) {
    if (!err.code) console.error(err && err.stack ? err.stack : err);
    return { ok: false, error: err.code ? err.message : 'Lỗi hệ thống: ' + err.message, code: err.code || 'INTERNAL', details: err.details || null };
  }
}

function doPost(e) {
  const res = handle_(e && e.postData ? e.postData.contents : '');
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: CONFIG.APP_NAME }))
    .setMimeType(ContentService.MimeType.JSON);
}
