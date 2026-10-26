import { createClient } from 'npm:@supabase/supabase-js@2';
import { appError, handleAdminOps } from './core.js';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function makeSupabaseDeps() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const emailDomain = Deno.env.get('SYNTHETIC_EMAIL_DOMAIN') ?? 'dncvt.local';

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const makeAnonClient = () =>
    createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  return {
    emailDomain,
    async serviceRpc(fnName: string, args: Record<string, unknown>) {
      const { data, error } = await serviceClient.rpc(fnName, args);
      if (error) throw error;
      return data;
    },
    async getUserByToken(token: string) {
      const { data, error } = await serviceClient.auth.getUser(token);
      if (error || !data?.user) return null;
      return { id: data.user.id, email: data.user.email ?? '' };
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const anonClient = makeAnonClient();
      const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
      if (error || !data?.session) return { session: null, error };
      return { session: data.session, error: null };
    },
    async createAuthUser({
      email,
      password,
      user_metadata,
    }: {
      email: string;
      password: string;
      user_metadata?: Record<string, unknown>;
    }) {
      const { data, error } = await serviceClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: user_metadata ?? {},
      });
      if (error || !data?.user) {
        throw appError(error?.message || 'Không tạo được tài khoản xác thực.');
      }
      return { id: data.user.id, email: data.user.email ?? email };
    },
    async updateAuthUser(uid: string, patch: Record<string, unknown>) {
      const { error } = await serviceClient.auth.admin.updateUserById(uid, patch);
      if (error) throw appError(error.message || 'Không cập nhật được tài khoản xác thực.');
    },
    async deleteAuthUser(uid: string) {
      await serviceClient.auth.admin.deleteUser(uid);
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ ok: false, error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED', details: null }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const rawBody = await req.text();
  const authHeader = req.headers.get('Authorization') ?? '';
  const result = await handleAdminOps(rawBody, authHeader, makeSupabaseDeps());

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
});
