/**
 * Harness kiểm thử & chạy cục bộ toàn bộ kiến trúc Supabase trên PostgreSQL thật (@electric-sql/pglite):
 * - Nạp `tests/helpers/supabase_local_shim.sql` + `supabase/migrations/001_schema_rls_rpc.sql`
 * - Thực thi thật `SET LOCAL ROLE anon | authenticated | service_role` + `request.jwt.claims`
 * - Tái sử dụng trực tiếp module `supabase/functions/admin-ops/core.js` cho `login`, `auth.changePassword`, `users.save`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');
const { appError, normalizeRpcError, handleAdminOps } = require('../supabase/functions/admin-ops/core.js');

const SHIM_SQL_PATH = path.join(__dirname, '..', 'tests', 'helpers', 'supabase_local_shim.sql');
const MIGRATION_SQL_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '001_schema_rls_rpc.sql');

const TOKEN_TTL_HOURS = 12;
const EMAIL_DOMAIN = 'dncvt.local';

const ACTION_TO_RPC = {
  'bootstrap': 'rpc_bootstrap',
  'lines.list': 'rpc_lines_list',
  'lines.sync': 'rpc_lines_sync',
  'lines.save': 'rpc_lines_save',
  'lines.create': 'rpc_lines_create',
  'lines.delete': 'rpc_lines_delete',
  'lines.duplicate': 'rpc_lines_duplicate',
  'requests.issue': 'rpc_requests_issue',
  'requests.append': 'rpc_requests_append',
  'requests.detach': 'rpc_requests_detach',
  'requests.get': 'rpc_requests_get',
  'requests.list': 'rpc_requests_list',
  'receipts.add': 'rpc_receipts_add',
  'receipts.list': 'rpc_receipts_list',
  'receipts.delete': 'rpc_receipts_delete',
  'catalog.save': 'rpc_catalog_save',
  'catalog.delete': 'rpc_catalog_delete',
  'signers.seed': 'rpc_signers_seed',
  'data.purge': 'rpc_data_purge',
  'backup.run': 'rpc_backup_run',
  'users.list': 'rpc_users_list',
  'audit.list': 'rpc_audit_list',
  'export.all': 'rpc_export_all',
};

const EDGE_ACTIONS = new Set(['login', 'auth.changePassword', 'users.save']);

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const actual = Buffer.from(parts[2], 'hex');
  const check = crypto.scryptSync(String(password), parts[1], 32);
  return actual.length === check.length && crypto.timingSafeEqual(actual, check);
}

async function createSupabaseBackend(dataDir = undefined) {
  const db = new PGlite(dataDir || undefined);
  await db.waitReady;
  await db.exec("SET TIME ZONE 'UTC';");

  const shimSql = fs.readFileSync(SHIM_SQL_PATH, 'utf8');
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await db.exec(shimSql);
  await db.exec(migrationSql);
  await db.exec("SET TIME ZONE 'UTC';");

  const jwtSecret = crypto.randomUUID() + crypto.randomUUID();
  let testNowIso = null;

  function currentNowDate() {
    return testNowIso ? new Date(testNowIso) : new Date();
  }

  function signJwt(claims) {
    const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64urlEncode(JSON.stringify(claims));
    const sig = b64urlEncode(crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${sig}`;
  }

  function verifyJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig = b64urlEncode(
      crypto.createHmac('sha256', jwtSecret).update(`${parts[0]}.${parts[1]}`).digest()
    );
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const claims = JSON.parse(b64urlDecode(parts[1]));
      const nowSec = Math.floor(currentNowDate().getTime() / 1000);
      if (!claims || !claims.sub || (claims.exp && claims.exp < nowSec)) return null;
      return claims;
    } catch (_) {
      return null;
    }
  }

  async function runAsRole(role, claims, sql, params = []) {
    return await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.test_now', $1, true)`, [testNowIso || '']);
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims || {})]);
      await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [claims?.sub || '']);
      await tx.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      await tx.exec(`SET LOCAL ROLE ${role}`);
      await tx.exec("SET LOCAL TIME ZONE 'UTC'");
      if (params && params.length > 0) {
        return await tx.query(sql, params);
      }
      const trimmed = String(sql).trim().replace(/;+\s*$/, '');
      if (trimmed.includes(';')) {
        const multi = await tx.exec(sql);
        return Array.isArray(multi) ? multi[multi.length - 1] : multi;
      }
      return await tx.query(sql);
    });
  }

  const edgeDeps = {
    emailDomain: EMAIL_DOMAIN,

    async serviceRpc(fnName, args = {}) {
      if (fnName === 'rpc_admin_check_login') {
        const r = await runAsRole(
          'service_role',
          { role: 'service_role' },
          `SELECT public.rpc_admin_check_login($1::text) AS res`,
          [args.p_username ?? '']
        );
        return r.rows[0].res;
      }
      if (fnName === 'rpc_admin_record_login') {
        const r = await runAsRole(
          'service_role',
          { role: 'service_role' },
          `SELECT public.rpc_admin_record_login($1::text, $2::boolean) AS res`,
          [args.p_username ?? '', Boolean(args.p_ok)]
        );
        return r.rows[0].res;
      }
      const r = await runAsRole(
        'service_role',
        { role: 'service_role' },
        `SELECT public.${fnName}($1::jsonb) AS res`,
        [JSON.stringify(args.p_params || {})]
      );
      return r.rows[0].res;
    },

    async getUserByToken(token) {
      const claims = verifyJwt(token);
      if (!claims) return null;
      if (claims.session_id) {
        const r = await runAsRole(
          'service_role',
          { role: 'service_role' },
          `SELECT u.id, u.email
           FROM auth.users u
           WHERE u.id = $1::uuid
             AND COALESCE(u.raw_app_meta_data->>'banned', 'false') <> 'true'
             AND EXISTS (
               SELECT 1
               FROM auth.sessions s
               WHERE s.id = $2::uuid
                 AND s.user_id = u.id
                 AND (
                   s.not_after IS NULL
                   OR s.not_after > COALESCE(NULLIF(current_setting('app.test_now', true), '')::timestamptz, now())
                 )
             )`,
          [claims.sub, claims.session_id]
        );
        if (!r.rows.length) return null;
        return { id: r.rows[0].id, email: r.rows[0].email };
      }
      const r = await runAsRole(
        'service_role',
        { role: 'service_role' },
        `SELECT id, email FROM auth.users
         WHERE id = $1::uuid
           AND COALESCE(raw_app_meta_data->>'banned', 'false') <> 'true'`,
        [claims.sub]
      );
      if (!r.rows.length) return null;
      return { id: r.rows[0].id, email: r.rows[0].email };
    },

    async signInWithPassword({ email, password }) {
      const r = await runAsRole(
        'service_role',
        { role: 'service_role' },
        `SELECT id, email, encrypted_password, raw_app_meta_data FROM auth.users WHERE lower(email) = lower($1::text)`,
        [email]
      );
      if (!r.rows.length) return { session: null, error: new Error('Invalid login credentials') };
      const u = r.rows[0];
      if (u.raw_app_meta_data && u.raw_app_meta_data.banned === true) {
        return { session: null, error: new Error('User is banned') };
      }
      if (!verifyPassword(password, u.encrypted_password)) {
        return { session: null, error: new Error('Invalid login credentials') };
      }
      const nowMs = currentNowDate().getTime();
      const expSec = Math.floor((nowMs + TOKEN_TTL_HOURS * 3600 * 1000) / 1000);
      const sessRes = await runAsRole(
        'service_role',
        { role: 'service_role' },
        `INSERT INTO auth.sessions (user_id, created_at, updated_at, not_after)
         VALUES ($1::uuid, COALESCE(NULLIF(current_setting('app.test_now', true), '')::timestamptz, now()),
                 COALESCE(NULLIF(current_setting('app.test_now', true), '')::timestamptz, now()),
                 to_timestamp($2))
         RETURNING id`,
        [u.id, expSec]
      );
      const sessionId = sessRes.rows[0].id;
      const accessToken = signJwt({
        sub: u.id,
        email: u.email,
        role: 'authenticated',
        session_id: sessionId,
        iat: Math.floor(nowMs / 1000),
        exp: expSec,
      });
      const refreshToken = crypto.randomUUID().replace(/-/g, '');
      return {
        error: null,
        session: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expSec,
          token_type: 'bearer',
          user: { id: u.id, email: u.email },
        },
      };
    },

    async createAuthUser({ email, password, user_metadata }) {
      const hashed = hashPassword(password);
      const r = await runAsRole(
        'service_role',
        { role: 'service_role' },
        `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data)
         VALUES ($1::text, $2::text, $3::jsonb)
         RETURNING id, email`,
        [email, hashed, JSON.stringify(user_metadata || {})]
      );
      return { id: r.rows[0].id, email: r.rows[0].email };
    },

    async updateAuthUser(uid, patch) {
      if (patch.email) {
        await runAsRole(
          'service_role',
          { role: 'service_role' },
          `UPDATE auth.users
           SET email = $2::text,
               email_confirmed_at = CASE WHEN $3::boolean THEN COALESCE(email_confirmed_at, now()) ELSE email_confirmed_at END,
               updated_at = now()
           WHERE id = $1::uuid`,
          [uid, patch.email, Boolean(patch.email_confirm)]
        );
      }
      if (patch.password) {
        await runAsRole(
          'service_role',
          { role: 'service_role' },
          `UPDATE auth.users SET encrypted_password = $2::text, updated_at = now() WHERE id = $1::uuid`,
          [uid, hashPassword(patch.password)]
        );
        // Giả lập đúng GoTrue Cloud: auth.admin.updateUserById(uid, { password }) xóa toàn bộ auth.sessions của user
        await runAsRole(
          'service_role',
          { role: 'service_role' },
          `DELETE FROM auth.sessions WHERE user_id = $1::uuid`,
          [uid]
        );
      }
      if (patch.ban_duration !== undefined) {
        const isBanned = Boolean(patch.ban_duration && patch.ban_duration !== 'none');
        await runAsRole(
          'service_role',
          { role: 'service_role' },
          `UPDATE auth.users
           SET raw_app_meta_data = jsonb_set(COALESCE(raw_app_meta_data, '{}'::jsonb), '{banned}', to_jsonb($2::boolean), true),
               updated_at = now()
           WHERE id = $1::uuid`,
          [uid, isBanned]
        );
      }
      if (patch.user_metadata) {
        await runAsRole(
          'service_role',
          { role: 'service_role' },
          `UPDATE auth.users SET raw_user_meta_data = $2::jsonb, updated_at = now() WHERE id = $1::uuid`,
          [uid, JSON.stringify(patch.user_metadata)]
        );
      }
    },

    async deleteAuthUser(uid) {
      await runAsRole('service_role', { role: 'service_role' }, `DELETE FROM auth.users WHERE id = $1::uuid`, [uid]);
    },
  };

  const backend = {
    db,

    async setNow(iso) {
      testNowIso = iso || null;
      await db.query(`SELECT set_config('app.test_now', $1, false)`, [testNowIso || '']);
    },

    async reset() {
      testNowIso = null;
      await db.exec(`
        SELECT set_config('app.test_now', '', false);
        TRUNCATE TABLE
          public.receipts,
          public.lines,
          public.requests,
          public.suppliers,
          public.project_items,
          public.material_groups,
          public.signers,
          public.units,
          public.uoms,
          public.profiles,
          public.audit_log,
          public.sequences,
          private.login_attempts,
          private.backup_snapshots,
          auth.sessions,
          auth.users
        RESTART IDENTITY CASCADE;
        UPDATE private.heartbeat SET pinged_at = '1970-01-01T00:00:00Z' WHERE id = 1;
      `);
    },

    async setup() {
      const existing = await runAsRole(
        'service_role',
        { role: 'service_role' },
        `SELECT count(*)::int AS c FROM public.profiles`
      );
      let adminPassword = null;
      let adminAuthId = null;

      if (existing.rows[0].c === 0) {
        adminPassword = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const created = await edgeDeps.createAuthUser({
          email: `admin@${EMAIL_DOMAIN}`,
          password: adminPassword,
          user_metadata: { username: 'admin', full_name: 'Quản trị' },
        });
        adminAuthId = created.id;
      }

      await edgeDeps.serviceRpc('rpc_admin_setup', {
        p_params: { admin_auth_id: adminAuthId },
      });

      return { adminPassword };
    },

    async handle(body) {
      const req = typeof body === 'string' ? JSON.parse(body) : body;
      if (!req || typeof req !== 'object') {
        return { ok: false, error: 'Yêu cầu không hợp lệ', code: 'ERR', details: null };
      }

      if (EDGE_ACTIONS.has(req.action)) {
        const authHeader = req.token ? `Bearer ${req.token}` : '';
        const res = await handleAdminOps(req, authHeader, edgeDeps);
        return JSON.parse(JSON.stringify(res));
      }

      const rpcName = ACTION_TO_RPC[req.action];
      if (!rpcName) {
        return { ok: false, error: 'Thao tác không hợp lệ: ' + req.action, code: 'ERR', details: null };
      }

      const claims = verifyJwt(req.token);
      if (!claims) {
        return {
          ok: false,
          error: 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.',
          code: 'AUTH',
          details: null,
        };
      }

      try {
        const res = await runAsRole(
          'authenticated',
          claims,
          `SELECT public.${rpcName}($1::jsonb) AS data`,
          [JSON.stringify(req.params && typeof req.params === 'object' ? req.params : {})]
        );
        return JSON.parse(JSON.stringify({ ok: true, data: res.rows[0].data }));
      } catch (err) {
        const norm = normalizeRpcError(err);
        return {
          ok: false,
          error: norm.message,
          code: norm.code || 'INTERNAL',
          details: norm.details ?? null,
        };
      }
    },

    async call(action, params, token) {
      const res = await backend.handle({ action, params: params || {}, token });
      if (!res.ok) {
        throw appError(res.error, res.code, res.details);
      }
      return res.data;
    },

    async sqlAsAnon(sql, params = []) {
      return await runAsRole('anon', { role: 'anon' }, sql, params);
    },

    async sqlAsUser(token, sql, params = []) {
      const claims = verifyJwt(token);
      if (!claims) throw appError('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.', 'AUTH');
      return await runAsRole('authenticated', claims, sql, params);
    },

    async sqlAsService(sql, params = []) {
      return await runAsRole('service_role', { role: 'service_role' }, sql, params);
    },

    async close() {
      await db.close();
    },
  };

  return backend;
}

module.exports = { createSupabaseBackend };
