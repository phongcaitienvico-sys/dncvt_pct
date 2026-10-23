/**
 * Đăng nhập: mật khẩu băm HMAC-SHA256 lặp nhiều vòng + salt riêng (Apps Script không có bcrypt),
 * phiên = token ký HMAC bằng SECRET_KEY (Script Properties), hết hạn sau TOKEN_TTL_HOURS.
 * Token gửi trong thân request (không dùng cookie) nên không bị CSRF.
 */

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SECRET_KEY');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SECRET_KEY', s);
  }
  return s;
}

function hmac_(value, key) {
  return Utilities.computeHmacSha256Signature(value, key, Utilities.Charset.UTF_8);
}

function hashPassword_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < CONFIG.PASSWORD_ITERATIONS; i++) h = Utilities.base64Encode(hmac_(h, salt));
  return h;
}

function newSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function makeToken_(user) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    u: user.username, exp: now_().getTime() + CONFIG.TOKEN_TTL_HOURS * 3600 * 1000,
  }), Utilities.Charset.UTF_8);
  return payload + '.' + Utilities.base64EncodeWebSafe(hmac_(payload, secret_()));
}

function publicUser_(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, active: u.active };
}

function findUser_(username) {
  const name = String(username || '').trim().toLowerCase();
  return tableAll_('users').find(function (u) { return String(u.username).toLowerCase() === name; }) || null;
}

/** Trả về user (object đầy đủ) hoặc ném lỗi AUTH. */
function verifyToken_(token) {
  const bad = function () { fail_('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.', 'AUTH'); };
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) bad();
  const parts = token.split('.');
  const expect = Utilities.base64EncodeWebSafe(hmac_(parts[0], secret_()));
  if (!safeEqual_(parts[1] || '', expect)) bad();
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));
  } catch (e) { bad(); }
  if (!payload || payload.exp < now_().getTime()) bad();
  const user = findUser_(payload.u);
  if (!user || !user.active) bad();
  return user;
}

function apiLogin_(p) {
  const username = cleanStr_(p.username, 'Tên đăng nhập') || '';
  const password = String(p.password || '');
  const cache = CacheService.getScriptCache();
  const key = 'loginfail:' + username.toLowerCase();
  const fails = Number(cache.get(key) || 0);
  if (fails >= CONFIG.LOGIN_MAX_FAILS) {
    fail_('Sai mật khẩu quá ' + CONFIG.LOGIN_MAX_FAILS + ' lần. Thử lại sau ' + CONFIG.LOGIN_BLOCK_MINUTES + ' phút.', 'LOCKED');
  }
  const user = findUser_(username);
  if (!user || !user.active || !safeEqual_(hashPassword_(password, user.salt || ''), user.password_hash || '')) {
    cache.put(key, String(fails + 1), CONFIG.LOGIN_BLOCK_MINUTES * 60);
    fail_('Sai tên đăng nhập hoặc mật khẩu.', 'LOGIN');
  }
  cache.remove(key);
  return { token: makeToken_(user), user: publicUser_(user) };
}

function apiChangePassword_(p, ctx) {
  const oldPw = String(p.old_password || '');
  const newPw = String(p.new_password || '');
  if (!safeEqual_(hashPassword_(oldPw, ctx.user.salt || ''), ctx.user.password_hash || '')) fail_('Mật khẩu cũ không đúng.');
  checkPasswordStrength_(newPw);
  const salt = newSalt_();
  updateObjs_('users', [{ id: ctx.user.id, patch: { salt: salt, password_hash: hashPassword_(newPw, salt) } }]);
  audit_(ctx, 'users', ctx.user.id, 'password', '', '(đã đổi)');
  return true;
}

function checkPasswordStrength_(pw) {
  if (pw.length < 8) fail_('Mật khẩu mới phải có ít nhất 8 ký tự.');
}
