// Online table server: the thin Deno/Postgres wrapper around logic.js.
//
// All game logic is in logic.js (tested in Node by test-server.js) and the
// shared files it loads. This file only:
//   1. answers CORS (the page is served from GitHub Pages),
//   2. verifies the player's sign-in with Supabase Auth,
//   3. gives logic.js a store backed by the wallets migration's tables and
//      its two functions, open_wallet() and commit_turn().
//
// The secret key is injected by Supabase into the function's environment.
// It is never in the repo or the page.
//
// Deploy (from the repo root, after `node sync-shared.js --check`):
//   npx supabase functions deploy play --project-ref kavaswxswtkvguzdljyi --use-api --no-verify-jwt
// --no-verify-jwt because this function verifies the token itself (step 2),
// which works with the new asymmetric sign-in keys.

import '../_shared/blackjack-core.js';
import '../_shared/tcp-core.js';
import '../_shared/tables.js';
import '../_shared/economy.js';
import './logic.js';

// deno-lint-ignore no-explicit-any
const PLAY = (globalThis as any).PLAY;

const URL_ = Deno.env.get('SUPABASE_URL')!;

function keyFrom(dictVar: string, legacyVar: string): string {
  const dict = Deno.env.get(dictVar);
  if (dict) {
    try { const k = JSON.parse(dict).default; if (k) return k; } catch { /* fall through */ }
  }
  const legacy = Deno.env.get(legacyVar);
  if (legacy) return legacy;
  throw new Error(`Missing ${dictVar} / ${legacyVar}`);
}
const SECRET = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const PUBLISHABLE = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');

// New-style keys (sb_...) go in `apikey` only; legacy JWT keys also as Bearer.
const dbHeaders: Record<string, string> = SECRET.startsWith('sb_')
  ? { apikey: SECRET }
  : { apikey: SECRET, Authorization: `Bearer ${SECRET}` };

const CORS = {
  'Access-Control-Allow-Origin': '*',   // auth is the bearer token, not cookies
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class DbError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { ...dbHeaders, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new DbError(body?.code || String(res.status), body?.message || text);
  return body;
}
const rpc = (fn: string, args: unknown) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const store = {
  async wallet(u: string) {
    const rows = await db(`wallets?user_id=eq.${u}&select=chips,vault,econ,version`);
    return rows[0] || null;
  },
  async openWallet(u: string, opening: number) {
    const w = await rpc('open_wallet', { p_user: u, p_opening: opening });
    return { chips: w.chips, vault: w.vault, econ: w.econ, version: w.version };
  },
  async table(u: string, t: string) {
    const rows = await db(`table_states?user_id=eq.${u}&table_id=eq.${t}&select=state`);
    return rows[0] ? rows[0].state : null;
  },
  async commit(u: string, version: number, c: {
    chips: number; vault: number; econ: unknown; ledger: unknown[]; tableId?: string; tableState?: unknown;
  }) {
    await rpc('commit_turn', {
      p_user: u, p_version: version, p_chips: c.chips, p_vault: c.vault, p_econ: c.econ,
      p_ledger: c.ledger, p_table_id: c.tableId ?? null, p_table_state: c.tableState ?? null,
    });
  },
};

/** The signed-in player's id, verified by Supabase Auth, or null. */
async function userFrom(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const res = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: PUBLISHABLE, Authorization: auth } });
  if (!res.ok) return null;
  const u = await res.json();
  return typeof u?.id === 'string' ? u.id : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method', message: 'POST only.' }, 405);

  const user = await userFrom(req);
  if (!user) return json({ ok: false, error: 'signed_out', message: 'Sign in to play online.' }, 401);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_request', message: 'Bad JSON.' }, 400); }

  try {
    return json(await PLAY.handle(store, user, body));
  } catch (e) {
    // Never echo internals (a failed commit message could describe state).
    console.error('play error', user, e);
    return json({ ok: false, error: 'server', message: 'Something went wrong on the server. Your chips are safe; try again.' }, 500);
  }
});
