# Hosting

How to get this live, in two stages. Stage 1 is free and takes about ten
minutes. Stage 2 is a real project and only matters once friends need to see
each other's chips.

## What the site is today

A static site: `index.html`, `blackjack-core.js`, `economy.js`. No server, no
build step, no database. Every player's chips, rank, quests and vault live in
**their own browser** (`localStorage`). That means:

- Anyone with the link can play. Nobody needs an account.
- Each browser is its own bankroll. Your phone and your laptop are two
  different players. Clearing site data resets you.
- Friends can't see each other's balances, and there's no leaderboard.
- Anyone can give themselves chips with devtools. That's harmless while
  nothing is shared, which is why it's fine for Stage 1.

## Stage 1: put it on the internet (free)

Pick one.

### Option A: Netlify Drop (no git, no account setup beyond a login)

1. Make a folder containing only `index.html`, `blackjack-core.js`,
   `economy.js`.
2. Go to https://app.netlify.com/drop and drag the folder in.
3. You get a URL like `https://something-random.netlify.app`. You can rename
   it in Site settings. To update, drag the folder in again.

Best for trying it out with friends this week.

### Option B: GitHub Pages (recommended once you're iterating)

You already use git, so this makes every `git push` a deploy.

1. Create a GitHub account and a new **public** repository (Pages on private
   repos needs a paid plan). Public is fine, and it suits the project: the
   code that computes the odds is right there for anyone to check.
2. Connect this repo and push:
   ```bash
   git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
   git push -u origin master
   ```
3. On GitHub: Settings → Pages → Build and deployment → Source: "Deploy from
   a branch", Branch: `master`, folder `/ (root)`. Save.
4. After a minute the site is at `https://YOUR-NAME.github.io/YOUR-REPO/`.

The test scripts and docs get published too. That's harmless; they're just
files nobody links to.

### Option C: Cloudflare Pages

Same idea as B with a faster CDN and free custom domains. Connect the GitHub
repo, set the build command to empty and the output directory to `/`.

### Before you share the link

- **Turn off the admin console:** set `RULES.adminEnabled = false` in
  `index.html`. The passphrase is readable in the page source, so on a public
  site it only advertises a free-chips button.
- **Run every test script** (see CLAUDE.md). The deployed page is exactly
  what they test.
- **Custom domain (optional):** about $10-15/year from any registrar. Both
  Netlify and GitHub Pages walk you through pointing it at the site, with free
  HTTPS.

## Stage 2: shared accounts, balances, leaderboard

This is the "Supabase" item on the roadmap. It's what lets friends see each
other, play from any device, and keep a fair leaderboard.

**The one thing that has to change:** today the browser shuffles, deals, and
pays. Once chips are shared or compared, a browser can't be trusted to do
that, because anyone can edit their own chips. The dealing and settlement
must move to a server. The browser asks "deal me a hand"; the server shuffles,
keeps the shoe secret, settles, and writes the result.

That's less work than it sounds, because the logic is already separated:

| Piece | Today | Stage 2 |
|---|---|---|
| Accounts | none | Supabase Auth (email link or Google sign-in) |
| Chips, rank, quests, vault | `localStorage` | Postgres tables, one row per player |
| Ledger | `S.econ.ledger` | a `ledger` table: every grant is a row, so the reconcile check becomes a SQL query |
| Shuffle, deal, settle | `blackjack-core.js` in the browser | the **same file** in a Supabase Edge Function (Deno runs plain JS) |
| Wheels, quests, events | `economy.js` in the browser | the **same file** server-side; events and quests switch to server time, so everyone is in sync regardless of timezone |
| Shoe / next cards | readable in `localStorage` | never leaves the server |
| The page | does everything | shows cards and sends button presses |

The tests keep working: they already drive `blackjack-core.js` and
`economy.js` directly, which is exactly what the server would run.

**Cost:** Supabase's free tier (database, auth, edge functions) comfortably
covers a group of friends and well beyond. A static host stays free. If it
ever grows enough to cost real money, see below.

**Suggested order when you get there:** auth plus server-side storage of
balances, then server-side dealing for one game (blackjack) end to end, then
the rest, then the leaderboard last. A leaderboard before server-side dealing
just ranks whoever edited their chips most creatively.

## Money

Chips are free and can never be bought or cashed out (CLAUDE.md hard rule 3).
If running servers ever needs funding, the only allowed source is
**cosmetics**, never chips, odds, boosts, or anything that affects play. That
option isn't built and shouldn't be until it's explicitly decided. If it
happens, check app-store and local rules for selling items in casino-themed
games at that point. Keeping chips un-purchasable and un-redeemable is what
keeps this a game rather than gambling.
