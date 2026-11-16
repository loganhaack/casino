-- Linked progressive jackpots: one pool shared by every online player.
--
-- Apply once: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run. Until it is applied, the play function
-- simply runs slots without jackpots (it checks for the table).
--
-- WHAT LIVES HERE
--   jackpot_pool   ONE row: every tier's meter, its audit totals and, for the
--                  must-hit-by tiers, the secret drop point and salt (the
--                  public sees only a SHA-256 commitment to them until they
--                  hit). The shape is owned by jackpot.js. SECRET: no grants.
--   jackpot_hits   every jackpot ever won: tier, amount, machine, the
--                  winner's display name, and the revealed drop point + salt.
--                  Players see these through the function.
--
-- THE WRITE PATH
--   commit_spin() = commit_turn() (unchanged: the wallet still can't move
--   without matching ledger rows) + the pool, under its own optimistic
--   version, in the SAME transaction. If another player's spin committed to
--   the pool first, it raises 40001 and the function retries the whole turn.
--   Jackpot wins are ordinary 'payout' ledger rows (ref 'jp:<tier>:<n>').

create table if not exists public.jackpot_pool (
  id         int primary key check (id = 1),
  state      jsonb  not null,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.jackpot_hits (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  tier         text   not null check (tier in ('mini', 'minor', 'major', 'grand')),
  user_id      uuid   references auth.users (id) on delete set null,
  display_name text   check (char_length(display_name) <= 40),
  table_id     text   check (table_id ~ '^[a-z0-9_]{1,16}$'),
  amount       bigint not null check (amount > 0),
  reveal       jsonb
);
create index if not exists jackpot_hits_recent on public.jackpot_hits (id desc);

alter table public.jackpot_pool enable row level security;
alter table public.jackpot_hits enable row level security;
revoke all on public.jackpot_pool from anon, authenticated;
revoke all on public.jackpot_hits from anon, authenticated;
-- Deliberately no grants and no policies: only service_role (the function) reads or writes.

-- ------------------------------------------------------------ commit_spin --

create or replace function public.commit_spin(
  p_user         uuid,
  p_version      bigint,
  p_chips        bigint,
  p_vault        bigint,
  p_econ         jsonb,
  p_ledger       jsonb,
  p_table_id     text,
  p_table_state  jsonb,
  p_pool_version bigint,   -- the pool version read; -1 = the pool doesn't exist yet
  p_pool         jsonb,
  p_hits         jsonb     -- array of {tier, amount, table_id, reveal}
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  n      int;
  h      jsonb;
  v_name text;
begin
  if p_pool is null then
    raise exception 'p_pool is required (use commit_turn otherwise)' using errcode = '22023';
  end if;

  if p_pool_version = -1 then
    insert into public.jackpot_pool (id, state, version) values (1, p_pool, 0)
      on conflict (id) do nothing;
  else
    update public.jackpot_pool
       set state = p_pool, version = version + 1, updated_at = now()
     where id = 1 and version = p_pool_version;
  end if;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'stale jackpot pool version %', p_pool_version using errcode = '40001';
  end if;

  if p_hits is not null and jsonb_typeof(p_hits) = 'array' and jsonb_array_length(p_hits) > 0 then
    select display_name into v_name from public.profiles where id = p_user;
    for h in select value from jsonb_array_elements(p_hits) loop
      insert into public.jackpot_hits (tier, user_id, display_name, table_id, amount, reveal)
        values (h->>'tier', p_user, coalesce(v_name, 'A player'), h->>'table_id', (h->>'amount')::bigint, h->'reveal');
    end loop;
  end if;

  -- The wallet, the ledger and the table, with every check commit_turn makes.
  -- Same transaction: if it refuses, the pool update above is rolled back too.
  return public.commit_turn(p_user, p_version, p_chips, p_vault, p_econ, p_ledger, p_table_id, p_table_state);
end;
$$;

revoke all on function public.commit_spin(uuid, bigint, bigint, bigint, jsonb, jsonb, text, jsonb, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_spin(uuid, bigint, bigint, bigint, jsonb, jsonb, text, jsonb, bigint, jsonb, jsonb) to service_role;
