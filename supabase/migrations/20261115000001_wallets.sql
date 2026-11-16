-- Stage 2, step 2: wallets, the ledger, and server-side table state.
--
-- Apply once: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run.
--
-- THE RULE THIS FILE ENFORCES
--   A chip balance can only change together with ledger rows that account for
--   the change, exactly. Postgres checks that on every write, so a bug in the
--   server code can't create or destroy chips silently: the write fails.
--   This is econReconcile() moved into the database:
--     wallets.chips = sum(ledger.amount where account = 'chips')   always
--     wallets.vault = sum(ledger.amount where account = 'vault')   always
--   (the opening balance is itself a ledger row).
--
-- WHO CAN DO WHAT
--   Players (authenticated): read their own wallet and their own ledger.
--                            Nothing else. They cannot write any of it.
--   anon:                    nothing.
--   The Edge Function (service_role): calls open_wallet() and commit_turn().
--                            Those are the ONLY ways anything here changes.
--   table_states holds the shoe and the dealer's hole card. Nobody but the
--   server can read it; the function sends players a redacted view.
--
-- Signed-out play is untouched: it stays in the browser, offline, as before.
-- Online play starts fresh (owner's decision); local chips are never imported.

-- ---------------------------------------------------------------- wallets --

create table if not exists public.wallets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  chips      bigint not null check (chips >= 0),
  vault      bigint not null default 0 check (vault >= 0),
  -- Economy state (rank/XP, quests, wheel cooldowns, vault day tracking...).
  -- Shape is owned by economy.js; the database treats it as opaque.
  econ       jsonb  not null default '{}'::jsonb,
  -- Optimistic concurrency: every commit names the version it read. Two
  -- requests racing (double-click, two tabs) can't both apply.
  version    bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- ledger --

create table if not exists public.ledger (
  id       bigint generated always as identity primary key,
  user_id  uuid   not null references auth.users (id) on delete cascade,
  at       timestamptz not null default now(),
  account  text   not null check (account in ('chips', 'vault')),
  amount   bigint not null check (amount <> 0),
  -- Same names as the page's ledger (S.econ.ledger), plus the game's own
  -- bet/payout rows, which the page tracks as "game nets" instead.
  kind     text   not null check (kind in (
             'opening', 'bet', 'payout',
             'bonusWheel', 'rescueWheel', 'quests', 'promo',
             'interest', 'shop', 'vault')),
  table_id text   check (table_id ~ '^[a-z0-9_]{1,16}$'),
  ref      text   check (char_length(ref) <= 64),   -- e.g. round id

  -- Each kind may only move chips one way, on one account.
  constraint ledger_kind_sign check (
    case kind
      when 'opening'     then account = 'chips' and amount > 0
      when 'bet'         then account = 'chips' and amount < 0
      when 'payout'      then account = 'chips' and amount > 0
      when 'bonusWheel'  then account = 'chips' and amount > 0
      when 'rescueWheel' then account = 'chips' and amount > 0
      when 'quests'      then account = 'chips' and amount > 0
      when 'promo'       then account = 'chips' and amount > 0
      when 'shop'        then account = 'chips' and amount < 0
      when 'interest'    then account = 'vault' and amount > 0
      when 'vault'       then true   -- a transfer; commit_turn checks it nets to 0
    end)
);

create index if not exists ledger_user_id on public.ledger (user_id, id);

-- ----------------------------------------------------------- table_states --

-- One row per player per table: the shoe, the round in progress (including
-- the dealer's hole card), and anything else the table needs between
-- requests. SECRET: no player-facing grants at all.
create table if not exists public.table_states (
  user_id    uuid not null references auth.users (id) on delete cascade,
  table_id   text not null check (table_id ~ '^[a-z0-9_]{1,16}$'),
  state      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, table_id)
);

-- --------------------------------------------------------------- security --

alter table public.wallets      enable row level security;
alter table public.ledger       enable row level security;
alter table public.table_states enable row level security;

revoke all on public.wallets      from anon, authenticated;
revoke all on public.ledger       from anon, authenticated;
revoke all on public.table_states from anon, authenticated;

grant select (user_id, chips, vault, econ, version, created_at, updated_at)
  on public.wallets to authenticated;
grant select on public.ledger to authenticated;
-- table_states: deliberately no grants.

drop policy if exists "players read only their own wallet" on public.wallets;
create policy "players read only their own wallet"
  on public.wallets for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "players read only their own ledger" on public.ledger;
create policy "players read only their own ledger"
  on public.ledger for select to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete policies anywhere: with RLS on, that means players
-- can't write. Only service_role (which bypasses RLS) can, and it only goes
-- through the two functions below.

-- ------------------------------------------------------------ open_wallet --

-- Create the player's wallet with its opening balance, once. Idempotent:
-- calling it again returns the existing wallet and grants nothing.
-- The opening amount comes from the game's rules (the caller passes it) so
-- the number isn't duplicated here.
create or replace function public.open_wallet(p_user uuid, p_opening bigint)
returns public.wallets
language plpgsql
set search_path = ''
as $$
declare
  w public.wallets;
begin
  if p_opening is null or p_opening <= 0 then
    raise exception 'opening balance must be positive' using errcode = '22023';
  end if;

  insert into public.wallets (user_id, chips) values (p_user, p_opening)
    on conflict (user_id) do nothing
    returning * into w;

  if found then
    insert into public.ledger (user_id, account, amount, kind)
      values (p_user, 'chips', p_opening, 'opening');
    return w;
  end if;

  select * into w from public.wallets where user_id = p_user;
  return w;
end;
$$;

-- ------------------------------------------------------------ commit_turn --

-- The ONE write path. The Edge Function reads the wallet (and table state),
-- runs the shared game/economy code, then commits the result here:
--
--   p_version      the wallet version it read; mismatch -> error 40001, retry
--   p_chips/vault  the new balances
--   p_econ         the new economy state (null = unchanged)
--   p_ledger       jsonb array of {account, amount, kind, table_id?, ref?}
--   p_table_id     table whose state changed (null = none)
--   p_table_state  that table's new state (jsonb null = delete the row)
--
-- It refuses (and changes nothing) unless each balance moved by exactly the
-- sum of its ledger rows. Returns the new wallet version.
create or replace function public.commit_turn(
  p_user        uuid,
  p_version     bigint,
  p_chips       bigint,
  p_vault       bigint,
  p_econ        jsonb,
  p_ledger      jsonb,
  p_table_id    text  default null,
  p_table_state jsonb default null
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  w        public.wallets;
  r        jsonb;
  d_chips  bigint := 0;
  d_vault  bigint := 0;
  d_xfer   bigint := 0;
  v_acct   text;
  v_amt    bigint;
  v_kind   text;
begin
  select * into w from public.wallets where user_id = p_user for update;
  if not found then
    raise exception 'no wallet for this player' using errcode = 'P0002';
  end if;
  if w.version <> p_version then
    raise exception 'stale wallet version (have %, got %)', w.version, p_version
      using errcode = '40001';
  end if;

  if p_ledger is null or jsonb_typeof(p_ledger) <> 'array' then
    raise exception 'p_ledger must be a json array' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(p_ledger) loop
    v_acct := r->>'account';
    v_amt  := (r->>'amount')::bigint;
    v_kind := r->>'kind';
    if v_kind = 'opening' then
      raise exception 'opening rows come only from open_wallet' using errcode = '22023';
    end if;
    -- Row checks (account, sign, kind) are the table's constraints.
    insert into public.ledger (user_id, account, amount, kind, table_id, ref)
      values (p_user, v_acct, v_amt, v_kind, r->>'table_id', r->>'ref');
    if v_acct = 'chips' then d_chips := d_chips + v_amt;
    else d_vault := d_vault + v_amt; end if;
    if v_kind = 'vault' then d_xfer := d_xfer + v_amt; end if;
  end loop;

  if d_xfer <> 0 then
    raise exception 'vault transfer rows must net to zero (got %)', d_xfer
      using errcode = '23514';
  end if;
  if p_chips - w.chips <> d_chips or p_vault - w.vault <> d_vault then
    raise exception 'balances moved by chips % / vault % but the ledger says % / %',
      p_chips - w.chips, p_vault - w.vault, d_chips, d_vault
      using errcode = '23514';
  end if;

  update public.wallets
     set chips = p_chips, vault = p_vault,
         econ = coalesce(p_econ, econ),
         version = version + 1, updated_at = now()
   where user_id = p_user;

  if p_table_id is not null then
    if p_table_state is null then
      delete from public.table_states where user_id = p_user and table_id = p_table_id;
    else
      insert into public.table_states (user_id, table_id, state)
        values (p_user, p_table_id, p_table_state)
        on conflict (user_id, table_id)
        do update set state = excluded.state, updated_at = now();
    end if;
  end if;

  return w.version + 1;
end;
$$;

-- ------------------------------------------------------- ledger_mismatches --

-- Audit: every wallet whose balances disagree with its ledger. Should always
-- return zero rows. Run it from the SQL Editor any time.
create or replace function public.ledger_mismatches()
returns table (user_id uuid, chips bigint, ledger_chips bigint, vault bigint, ledger_vault bigint)
language sql stable
set search_path = ''
as $$
  select w.user_id, w.chips, coalesce(l.c, 0), w.vault, coalesce(l.v, 0)
    from public.wallets w
    left join (
      select user_id,
             sum(amount) filter (where account = 'chips') as c,
             sum(amount) filter (where account = 'vault') as v
        from public.ledger group by user_id
    ) l using (user_id)
   where w.chips <> coalesce(l.c, 0) or w.vault <> coalesce(l.v, 0);
$$;

-- Functions are executable by everyone by default, including the API roles.
-- These are server-only.
revoke all on function public.open_wallet(uuid, bigint) from public, anon, authenticated;
revoke all on function public.commit_turn(uuid, bigint, bigint, bigint, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.ledger_mismatches() from public, anon, authenticated;
grant execute on function public.open_wallet(uuid, bigint) to service_role;
grant execute on function public.commit_turn(uuid, bigint, bigint, bigint, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.ledger_mismatches() to service_role;
