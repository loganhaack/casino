-- Leaderboard v2: adds all-time gains, all-time losses and all-time net.
--
-- Apply once: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run. Self-contained: it works whether or not
-- 20261117000001_leaderboard.sql was applied first (it replaces that function).
--
-- A "round" is every bet + payout ledger row sharing one ref (a hand, a spin,
-- a roulette spin; a jackpot is its own ref).
--   gross_won   sum of the nets of winning rounds     (all-time gains)
--   gross_lost  sum of the nets of losing rounds, as a positive number (all-time losses)
--   all_net     gross_won - gross_lost
-- Grants (wheels, quests, promos, interest) and the shop are not game results
-- and never count. Server-only (service_role); players get display names only.

create index if not exists ledger_user_ref on public.ledger (user_id, ref);
create index if not exists ledger_at on public.ledger (at);

drop function if exists public.leaderboard(timestamptz);

create function public.leaderboard(p_since timestamptz)
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
         jsonb_build_object('xp', w.econ->'xp', 'equipped', w.econ->'equipped'),
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
