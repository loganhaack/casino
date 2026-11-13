# Hosting

The game is live at **https://loganhaack.github.io/casino/**, served by
GitHub Pages from the `main` branch of https://github.com/loganhaack/casino.

There are two stages. Stage 1 (a static site, free) is done. Stage 2 (shared
accounts, balances, a leaderboard) is a real project and only matters once
friends need to see each other's chips.

## What the site is today

A static site: `index.html`, `blackjack-core.js`, `economy.js`. No server, no
build step, no database. Every player's chips, rank, quests and vault live in
**their own browser** (`localStorage`). That means:

- Anyone with the link can play. Nobody needs an account.
- Each browser is its own bankroll. Your phone and your laptop are two
  different players. Clearing site data resets you. Your local `file://`
  copy is a separate player from the hosted site too.
- Friends can't see each other's balances, and there's no leaderboard.
- Anyone can give themselves chips with devtools. That's harmless while
  nothing is shared, which is why it's fine for Stage 1.
- Every repo under `loganhaack.github.io` shares one browser storage origin.
  The save key (`tcp.save.v1`) is specific enough not to collide, and a custom
  domain (below) removes the question entirely.

## Updating the live site

Every push to `main` is a deploy. The routine:

1. Make the change and try it locally: just open `index.html` in a browser.
2. Run that game's scripts (see CLAUDE.md, "Commands"). For anything touching
   blackjack, run all three blackjack scripts. For a change to page code or
   layout, also run both payout harnesses: they drive the real `index.html`.
3. Check `RULES.adminEnabled` is still `false` in `index.html`. Turn it on
   locally if you need the console, but never push it on.
4. Commit and push:
   ```bash
   git add -A          # or name the files
   git commit -m "What changed (and the new house edge if odds changed)"
   git push
   ```
5. Wait a minute or two. Progress is on the repo's **Actions** tab ("pages
   build and deployment"). Then hard-refresh the site: **Ctrl+Shift+R** on
   desktop. On a phone, close the tab and reopen it, because mobile browsers
   cache hard.

### If something looks wrong after a deploy

| Symptom | Likely cause | Fix |
|---|---|---|
| Old version still showing | Browser cache | Hard refresh; on a phone, try a private tab |
| Page loads but tables are blank | `blackjack-core.js` or `economy.js` missing or 404 | DevTools (F12) → Console/Network; make sure both files are committed |
| Actions tab shows a red X | Pages build failed (rare for a static site) | Open the run, read the error, re-run it; usually a GitHub hiccup |
| 404 at the site URL | Pages turned off or wrong branch | Settings → Pages → Source: Deploy from a branch, `main`, `/ (root)` |
| Your chips reset | Site data cleared, or a different browser/device | Expected in Stage 1: each browser is its own player |

### Rolling back a bad deploy

```bash
git log --oneline          # find the bad commit
git revert <commit-hash>   # makes a new commit that undoes it
git push
```

`revert` is safe: it adds history instead of rewriting it. Avoid
`git push --force` on `main`.

## Optional: a custom domain

About $10-15/year. Cloudflare Registrar and Porkbun are cheap and plain.

1. Buy the domain.
2. On GitHub: repo **Settings → Pages → Custom domain**, enter it (e.g.
   `play.example.com`), save. This commits a `CNAME` file to the repo, so
   run `git pull` afterwards.
3. At the registrar's DNS settings:
   - **Subdomain** (`play.example.com`, recommended): one `CNAME` record,
     name `play`, value `loganhaack.github.io`.
   - **Root domain** (`example.com`): four `A` records pointing at
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
     `185.199.111.153`.
4. Wait for DNS (minutes to a few hours), then tick **Enforce HTTPS** in
   Settings → Pages.

Players on the old `github.io` address keep their chips there. A new domain
is a new storage origin, so everyone starts fresh on it. Pick the domain
before inviting lots of people.

## Before sharing the link widely

- [x] Admin console off (`RULES.adminEnabled = false`)
- [x] All verification scripts passing on the deployed code
- [ ] Optional: custom domain, decided before inviting lots of people
- [ ] Tell people up front: play chips only, nothing to buy, nothing to cash out

## Stage 2: shared accounts, balances, leaderboard

This is the "Supabase" item on the roadmap, plus profiles (name, avatar,
equipped cosmetics). It's what lets friends see each other, play from any
device, and keep a fair leaderboard.

**The one thing that has to change:** today the browser shuffles, deals, and
pays. Once chips are shared or compared, a browser can't be trusted to do
that, because anyone can edit their own chips. Dealing and settlement must
move to a server. The browser asks "deal me a hand"; the server shuffles,
keeps the shoe secret, settles, and writes the result.

That's less work than it sounds, because the logic is already separated:

| Piece | Today | Stage 2 |
|---|---|---|
| Accounts | none | Supabase Auth (email link or Google sign-in) |
| Profiles | none | a `profiles` table: display name, avatar, equipped cosmetics |
| Chips, rank, quests, vault | `localStorage` | Postgres tables, one row per player |
| Ledger | `S.econ.ledger` | a `ledger` table: every grant is a row, so the reconcile check becomes a SQL query |
| Shuffle, deal, settle | `blackjack-core.js` in the browser | the **same file** in a Supabase Edge Function |
| Wheels, quests, events | `economy.js` in the browser | the **same file** server-side; events and quests switch to server time, so everyone is in sync regardless of timezone |
| Shoe / next cards | readable in `localStorage` | never leaves the server |
| The page | does everything | shows cards and chips, sends button presses |

The tests keep working: they already drive `blackjack-core.js` and
`economy.js` directly, which is exactly what the server would run. The card
and chip animations are display-only and don't change: the page just gets
the settled result from the server instead of computing it.

### Getting started when you're ready

1. **Create the project.** Sign up at https://supabase.com (free tier), make
   a new project, choose a region near you and your friends, and save the
   database password somewhere safe. From Project Settings → API, note the
   **Project URL** and the **anon public key**. The anon key is meant to be
   public; the **service_role** key is not. Never put service_role in
   `index.html` or commit it.
2. **Turn on sign-in.** Authentication → Providers: enable Email (magic
   link). Google is optional. Under URL Configuration, add
   `https://loganhaack.github.io/casino/` (and any custom domain) as the
   Site URL / redirect URL.
3. **Decide how the page talks to Supabase.** CLAUDE.md hard rule 4 says
   `index.html` has no dependencies and no CDN scripts. Two options:
   - Call Supabase's REST and Auth endpoints with plain `fetch()`. No
     library, rule 4 intact, a bit more code.
   - Vendor `supabase-js` as a local file in the repo. Easier, but it is a
     dependency, so it has to be a deliberate decision to relax rule 4.
4. **Install the Supabase CLI** for database migrations and Edge Functions
   (`npx supabase --help` works without a global install), then
   `npx supabase login`, `npx supabase init`, and
   `npx supabase link --project-ref <your-ref>`.

From there, build in this order:

1. **Auth + profiles + server-side balances.** Tables with Row Level Security
   so a player can read their own row (and friends' public profile fields)
   but **cannot write chips directly**. Only server functions write chips.
2. **Server-side dealing for blackjack, end to end.** An Edge Function runs
   `blackjack-core.js` unchanged: start round, act, settle, write the ledger
   row, all in one transaction. The shoe is stored server-side only.
3. **Three Card Poker and the economy** (wheels, quests, vault) the same way.
4. **Leaderboard last.** A leaderboard before server-side dealing just ranks
   whoever edited their chips most creatively.

**Cost:** Supabase's free tier (database, auth, edge functions) comfortably
covers a group of friends and well beyond. Note that free projects pause
after about a week with no activity; un-pausing is one click in the
dashboard. GitHub Pages stays free.

## Money

Chips are free and can never be bought or cashed out (CLAUDE.md hard rule 3).
If running servers ever needs funding, the only allowed source is
**cosmetics** (felts, card backs, avatars), never chips, odds, boosts, or
anything that affects play. That option isn't built and shouldn't be until
it's explicitly decided. If it happens, check app-store and local rules for
selling items in casino-themed games at that point. Keeping chips
un-purchasable and un-redeemable is what keeps this a game rather than
gambling.
