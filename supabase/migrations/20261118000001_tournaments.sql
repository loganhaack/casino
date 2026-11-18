-- Weekly tournaments.
--
-- Apply once: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run.
--
-- 1. A 'tournament' ledger kind: a prize, real chips, paid once a week's
--    tournament has closed (one-way, into chips, like quests).
-- 2. tournament_standings(table): every player's entry for one week.
--    Entries live in table_states as 'tn_<YYYYMMDD>' (written only by the
--    server, through commit_turn, like every table). Tournament chips are
--    NOT real chips and never appear in the ledger.
-- 3. leaderboard() also returns trophies (so profile cards can show them).
-- Server-only (service_role); players get display names only.

-- ------------------------------------------------------------ ledger kind --
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.ledger'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%opening%'
  loop
    execute format('alter table public.ledger drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.ledger add constraint ledger_kind_check check (kind in (
  'opening', 'bet', 'payout',
  'bonusWheel', 'rescueWheel', 'quests', 'promo',
  'interest', 'shop', 'vault', 'tournament'));

alter table public.ledger add constraint ledger_kind_sign check (
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
    when 'tournament'  then account = 'chips' and amount > 0
    when 'vault'       then true   -- a transfer; commit_turn checks it nets to 0
  end);

-- ------------------------------------------------------------- standings --
create or replace function public.tournament_standings(p_table text)
returns table (user_id uuid, display_name text, avatar text, chips bigint, rounds int, paid jsonb)
language sql stable
set search_path = ''
as $$
  select t.user_id, p.display_name, p.avatar,
         (t.state->>'chips')::bigint, (t.state->>'rounds')::int, t.state->'paid'
    from public.table_states t
    join public.profiles p on p.id = t.user_id
   where t.table_id = p_table
     and p_table ~ '^tn_[0-9]{8}$'
     and coalesce((t.state->>'entered')::bigint, 0) > 0;
$$;

revoke all on function public.tournament_standings(text) from public, anon, authenticated;
grant execute on function public.tournament_standings(text) to service_role;

-- ------------------------------------------- leaderboard: trophies too --
create or replace function public.leaderboard(p_since timestamptz)
returns table (
  user_id uuid, display_name text, avatar text, econ jsonb,
  worth bigint, week_net bigint, best_win bigint, jp_total bigint, jp_count bigint, joined timestamptz,
  gross_won bigint, gross_lost bigint, all_net bigint
)
language sql stable
set search_path = ''
as $$
  with rounds as (
    select l.user_id, l.ref, sum(l.amount) as net
      from public.ledger l
     where l.kind in ('bet', 'payout') and l.ref is not null
     group by l.user_id, l.ref
  ), agg as (
    select r.user_id,
           max(r.net) as best_win,
           sum(r.net) filter (where r.net > 0) as gross_won,
           -sum(r.net) filter (where r.net < 0) as gross_lost,
           sum(r.net) as all_net
      from rounds r group by r.user_id
  ), week as (
    select l.user_id, sum(l.amount) as week_net
      from public.ledger l
     where l.kind in ('bet', 'payout') and l.at >= p_since
     group by l.user_id
  ), jp as (
    select h.user_id, sum(h.amount) as jp_total, count(*) as jp_count
      from public.jackpot_hits h group by h.user_id
  )
  select w.user_id, p.display_name, p.avatar,
         jsonb_build_object('xp', w.econ->'xp', 'equipped', w.econ->'equipped', 'trophies', w.econ->'trophies'),
         w.chips + w.vault,
         coalesce(wk.week_net, 0)::bigint, greatest(coalesce(a.best_win, 0), 0)::bigint,
         coalesce(j.jp_total, 0)::bigint, coalesce(j.jp_count, 0)::bigint, w.created_at,
         coalesce(a.gross_won, 0)::bigint, coalesce(a.gross_lost, 0)::bigint, coalesce(a.all_net, 0)::bigint
    from public.wallets w
    join public.profiles p on p.id = w.user_id
    left join agg a on a.user_id = w.user_id
    left join week wk on wk.user_id = w.user_id
    left join jp j on j.user_id = w.user_id;
$$;

revoke all on function public.leaderboard(timestamptz) from public, anon, authenticated;
grant execute on function public.leaderboard(timestamptz) to service_role;
