/**
 * Nhân xử lý nghiệp vụ xác thực & quản trị tài khoản (dùng chung cho Deno Edge Function
 * `supabase/functions/admin-ops/index.ts` và bộ kiểm thử Node/PGlite `dev/supabase_pglite.js`).
 */

export function appError(message, code = 'ERR', details = null) {
  const err = new Error(message);
  err.code = code || 'ERR';
  err.details = details ?? null;
  return err;
}

export function normalizeRpcError(err) {
  if (!err) return appError('Lỗi không xác định', 'INTERNAL');
  if (err.code && err.code !== 'P0001') {
    if (typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) return err;
  }
  const rawDetail = err.details ?? err.detail;
  if (err.code === 'P0001' || (typeof rawDetail === 'string' && rawDetail.startsWith('{'))) {
    try {
      const parsed = JSON.parse(rawDetail || '{}');
      return appError(err.message || 'Lỗi nghiệp vụ', parsed.code || 'ERR', parsed.details ?? null);
    } catch (_) {
      return appError(err.message || 'Lỗi nghiệp vụ', 'ERR', null);
    }
  }
  return appError('Lỗi hệ thống: ' + (err.message || String(err)), 'INTERNAL', null);
}

function extractBearer(authHeader, bodyToken) {
  if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
    const t = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (t) return t;
  }
  if (typeof bodyToken === 'string' && bodyToken.trim()) return bodyToken.trim();
  return null;
}

function extractSessionIdFromJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json);
    return typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null;
  } catch (_) {
    return null;
  }
}

function checkPasswordStrength(pw) {
  if (String(pw || '').length < 8) {
    throw appError('Mật khẩu mới phải có ít nhất 8 ký tự.');
  }
}

async function callServiceRpc(deps, fnName, args) {
  try {
    return await deps.serviceRpc(fnName, args);
  } catch (err) {
    throw normalizeRpcError(err);
  }
}

async function requireCallerAuth(deps, token) {
  if (!token) throw appError('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.', 'AUTH');
  const authUser = await deps.getUserByToken(token);
  if (!authUser || !authUser.id) {
    throw appError('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.', 'AUTH');
  }
  return authUser;
}

export async function dispatchAdminOps(body, authHeader, deps) {
  if (!body || typeof body !== 'object') throw appError('Yêu cầu không hợp lệ');
  const action = body.action;
  const params = body.params && typeof body.params === 'object' ? body.params : body;
  const token = extractBearer(authHeader, body.token);
  const emailDomain = deps.emailDomain || 'dncvt.local';

  if (action === 'login') {
    const rawUsername = params.username ?? '';
    const password = String(params.password || '');
    const check = await callServiceRpc(deps, 'rpc_admin_check_login', { p_username: rawUsername });

    if (!check || !check.found || !check.active || !check.email || !password) {
      await callServiceRpc(deps, 'rpc_admin_record_login', { p_username: rawUsername, p_ok: false });
      throw appError('Sai tên đăng nhập hoặc mật khẩu.', 'LOGIN');
    }

    const signIn = await deps.signInWithPassword({ email: check.email, password });
    if (!signIn || signIn.error || !signIn.session) {
      await callServiceRpc(deps, 'rpc_admin_record_login', { p_username: rawUsername, p_ok: false });
      throw appError('Sai tên đăng nhập hoặc mật khẩu.', 'LOGIN');
    }

    await callServiceRpc(deps, 'rpc_admin_record_login', { p_username: rawUsername, p_ok: true });
    return {
      token: signIn.session.access_token,
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      session: signIn.session,
      user: check.user,
    };
  }

  if (action === 'auth.changePassword') {
    const authUser = await requireCallerAuth(deps, token);
    const actor = await callServiceRpc(deps, 'rpc_admin_save_profile_and_sessions', {
      p_params: { mode: 'actor_info', actor_auth_id: authUser.id },
    });

    const oldPw = String(params.old_password || '');
    const newPw = String(params.new_password || '');
    const verify = oldPw ? await deps.signInWithPassword({ email: actor.email, password: oldPw }) : null;
    if (!verify || verify.error || !verify.session) {
      throw appError('Mật khẩu cũ không đúng.');
    }

    checkPasswordStrength(newPw);
    await deps.updateAuthUser(actor.auth_id, { password: newPw });
    const fresh = await deps.signInWithPassword({ email: actor.email, password: newPw });
    const freshSessionId =
      fresh?.session?.access_token
        ? extractSessionIdFromJwt(fresh.session.access_token)
        : null;
    await callServiceRpc(deps, 'rpc_admin_save_profile_and_sessions', {
      p_params: {
        mode: 'change_password',
        actor_auth_id: actor.auth_id,
        keep_session_id: freshSessionId,
      },
    });

    return {
      changed: true,
      token: fresh?.session?.access_token || null,
      access_token: fresh?.session?.access_token || null,
      refresh_token: fresh?.session?.refresh_token || null,
      session: fresh?.session || null,
      user: actor.profile || null,
    };
  }

  if (action === 'users.save') {
    const authUser = await requireCallerAuth(deps, token);
    const u = params.user && typeof params.user === 'object' ? params.user : {};
    const hasId = u.id !== undefined && u.id !== null && String(u.id) !== '';

    const pre = await callServiceRpc(deps, 'rpc_admin_save_profile_and_sessions', {
      p_params: {
        mode: 'save_user',
        validate_only: true,
        actor_auth_id: authUser.id,
        id: hasId ? u.id : null,
        username: u.username,
        full_name: u.full_name,
        role: u.role,
        active: u.active !== false,
      },
    });

    const hasPassword = u.password !== undefined && u.password !== null && String(u.password) !== '';
    if (hasId) {
      if (hasPassword) checkPasswordStrength(String(u.password));
    } else {
      checkPasswordStrength(String(u.password || ''));
    }

    const syntheticEmail = `${pre.username.toLowerCase()}@${emailDomain}`;

    if (hasId) {
      if (pre.target_auth_id) {
        const authPatch = {
          email: syntheticEmail,
          email_confirm: true,
          ban_duration: pre.active ? 'none' : '876000h',
          user_metadata: { username: pre.username, full_name: pre.full_name, role: pre.role },
        };
        if (hasPassword) authPatch.password = String(u.password);
        await deps.updateAuthUser(pre.target_auth_id, authPatch);
      }

      return await callServiceRpc(deps, 'rpc_admin_save_profile_and_sessions', {
        p_params: {
          mode: 'save_user',
          validate_only: false,
          actor_auth_id: authUser.id,
          id: pre.target_id,
          username: pre.username,
          full_name: pre.full_name,
          role: pre.role,
          active: pre.active,
          password_changed: hasPassword,
        },
      });
    }

    const createdAuth = await deps.createAuthUser({
      email: syntheticEmail,
      password: String(u.password),
      user_metadata: { username: pre.username, full_name: pre.full_name, role: pre.role },
    });

    try {
      return await callServiceRpc(deps, 'rpc_admin_save_profile_and_sessions', {
        p_params: {
          mode: 'save_user',
          validate_only: false,
          actor_auth_id: authUser.id,
          auth_id: createdAuth.id,
          username: pre.username,
          full_name: pre.full_name,
          role: pre.role,
          active: pre.active,
          password_changed: false,
        },
      });
    } catch (err) {
      if (createdAuth && createdAuth.id && deps.deleteAuthUser) {
        await deps.deleteAuthUser(createdAuth.id).catch(() => {});
      }
      throw err;
    }
  }

  throw appError('Thao tác không hợp lệ: ' + action);
}

export async function handleAdminOps(body, authHeader, deps) {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const data = await dispatchAdminOps(parsed, authHeader, deps);
    return { ok: true, data };
  } catch (err) {
    const norm = err && err.code ? err : normalizeRpcError(err);
    return {
      ok: false,
      error: norm.message,
      code: norm.code || 'INTERNAL',
      details: norm.details ?? null,
    };
  }
}
