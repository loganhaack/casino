-- Leaderboard: every online player, computed from the server's own records.
--
-- Apply once: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run. Until it is applied, the page says the
-- leaderboard isn't switched on yet; nothing else is affected.
--
-- Every number comes from tables only the server writes (wallets, ledger,
-- jackpot_hits), so it can't be edited from a browser. That's why this waited
-- until every game was dealt and settled server-side.
--
--   worth     chips + vault
--   week_net  sum of bet + payout ledger rows since p_since (the casino-clock
--             Monday the function passes in): game results only, no grants
--   best_win  the best single round: bet + payout rows grouped by round ref
--             (a jackpot is its own ref, so it counts as a win by itself)
--   jp_*      jackpots won
--
-- Players see display names, avatars, rank and equipped cosmetics, never a
-- user id or anything else in the wallet. Server-only (service_role).

create index if not exists ledger_user_ref on public.ledger (user_id, ref);
create index if not exists ledger_at on public.ledger (at);

create or replace function public.leaderboard(p_since timestamptz)
returns table (
  user_id uuid, display_name text, avatar text, econ jsonb,
  worth bigint, week_net bigint, best_win bigint, jp_total bigint, jp_count bigint, joined timestamptz
)
language sql stable
set search_path = ''
as $$
  with rounds as (
    select l.user_id, l.ref, sum(l.amount) as net
      from public.ledger l
     where l.kind in ('bet', 'payout') and l.ref is not null
     group by l.user_id, l.ref
  ), best as (
    select r.user_id, max(r.net) as best_win from rounds r group by r.user_id
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
         coalesce(wk.week_net, 0)::bigint, greatest(coalesce(b.best_win, 0), 0)::bigint,
         coalesce(j.jp_total, 0)::bigint, coalesce(j.jp_count, 0)::bigint, w.created_at
    from public.wallets w
    join public.profiles p on p.id = w.user_id
    left join best b on b.user_id = w.user_id
    left join week wk on wk.user_id = w.user_id
    left join jp j on j.user_id = w.user_id;
$$;

revoke all on function public.leaderboard(timestamptz) from public, anon, authenticated;
grant execute on function public.leaderboard(timestamptz) to service_role;
