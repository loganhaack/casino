-- Stage 2, step 1: player profiles.
--
-- Apply once: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to re-run (everything is "if not exists" / replaced).
--
-- Security is enforced HERE, by Postgres row-level security, not by the page.
-- The page ships a publishable key that anyone can read; these rules are what
-- stop one player from editing another's profile.
--
-- Deliberately NOT here yet: chips, balances, the ledger. Those move to the
-- server together with dealing (step 2), because a balance the browser can
-- write is a balance anyone can edit.

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
               check (char_length(display_name) between 2 and 20
                      and display_name ~ '^[A-Za-z0-9 _.-]+$'),
  avatar       text not null default 'fox'
               check (avatar ~ '^[a-z0-9-]{1,32}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Names are unique ignoring case, so friends can't impersonate each other.
create unique index if not exists profiles_display_name_lower
  on public.profiles (lower(display_name));

-- Keep updated_at honest.
create or replace function public.profiles_touch()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.profiles_touch();

-- Row-level security: on, with explicit rules.
alter table public.profiles enable row level security;

-- Supabase grants broad table rights to its API roles by default. Take them
-- all away, then give back exactly what's needed.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, display_name, avatar) on public.profiles to authenticated;
grant update (display_name, avatar) on public.profiles to authenticated;

drop policy if exists "signed-in players can see profiles" on public.profiles;
create policy "signed-in players can see profiles"
  on public.profiles for select to authenticated
  using (true);

drop policy if exists "players create only their own profile" on public.profiles;
create policy "players create only their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "players edit only their own profile" on public.profiles;
create policy "players edit only their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No delete policy: deleting the auth user (dashboard) cascades the profile.
