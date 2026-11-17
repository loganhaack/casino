# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

A play-chip casino game (no real money, ever) built so that its odds are
verifiable rather than trusted. Three Card Poker, Blackjack and Free Bet
Blackjack (with 21+3 and Perfect Pairs side bets), three slot machines, the
economy (`economy.js`) and Supabase accounts with server-side play are done.

The origin of the project: social casino apps are unregulated and have every
incentive to tune their RNG toward chip sales. The response is a game that
computes its own probability tables by brute force and tests its payout logic
against them. That property is the point of the project, not a nice-to-have.

## Commands

```bash
node enumerate.js              # exact TCP tables from tcp-core.js + tables.js, ~5s; fails if the displayed edges disagree
node test-payouts.js 200000    # drives the real game code, verifies chip math, ~6min
node test-blackjack.js         # blackjack totals + engine scenarios + fuzz, ~6s
node enumerate-blackjack.js    # exact dealer tables vs Wizard of Odds, <1s, writes expected-blackjack.json
node test-blackjack-payouts.js # real page code: chip accounting, house edge, dealer chi-square, ~3min
node test-economy.js           # wheels, quests, events, ledger, "deal is indifferent to who you are", ~30s
node enumerate-slots.js        # exact slot PAR sheets, every reel-stop combination, ~2min; fails if SLOTS.PAR drifts
node test-slots.js             # real page code: slot chip accounting, RTP within 4 SE, free spins + reload, ~3min
node test-roulette.js          # layout + exact odds, settle vs brute force, uniform pockets, page accounting, ~2min
node sync-shared.js            # copy blackjack-core/tcp-core/slots-core/jackpot/roulette-core/tables/economy into supabase/functions/_shared/
node sync-shared.js --check    # fails if the server's copies drift from the root files
node test-server.js            # online table server vs in-memory commit_turn: ledger, no leaks, same game, ~30s
node test-online-page.js       # real page code playing online against the real server logic, ~10s
open index.html                # the game; no build step, no server, no deps
```

Run a game's scripts after any change to its logic or paytables (all three
blackjack scripts for blackjack). They are fast
enough that there is no excuse to skip them.

## Critical invariant

The enumerators must validate the exact code that deals the game. Each game's
logic lives in ONE classic-script file that the page (`<script src>`), the
enumerator, the harnesses and the server all load: `tcp-core.js` (`eval3()`,
`categorize6()`, deal, `settle()`), `blackjack-core.js` and `slots-core.js`
(reel strips, paytables, spin, pay) and `roulette-core.js` (every legal bet,
spin, settle). Table-game paytables live in `tables.js`. **Never copy any of it into `index.html` or `enumerate.js`.** A
copy that drifts means the enumerator is validating a different game than the
one being played, and the whole verification story is theater. (`eval3()`
used to be duplicated in both files and kept in sync by hand; it no longer is.)

## Hard rules

1. **No change to a paytable or game rule ships without re-running that
   game's scripts (see Commands).** Paste the new house edge in the commit message.
2. **Never tune odds based on player behavior, spend, or session history.** The
   entire premise of this project is that the deal is indifferent to who you
   are. Any "dynamic difficulty," comeback mechanic, or loss-streak
   compensation is a bug, not a feature, even if requested in the moment.

   How this applies to the economy (`economy.js`): economy GRANTS may depend
   on rank or on being broke (the Rescue Wheel is a rescue by definition),
   and events may add promo chips on top of a result. What may never vary by
   player is anything that decides a game: the shuffle, the cards, the rules,
   the paytables. The wheels' own odds are fixed and the same for everyone.
   `test-economy.js` enforces this: a broke Lv1 player and a rich Diamond
   during an event, same seed, same decisions, must get identical results.
3. **No real currency, no purchasable chips, no payment integration.** Chips
   are free and always will be. This is not a gambling product and must not
   grow into one. If paying for servers ever needs revenue, the ONLY allowed
   source is cosmetics: never chips, odds, boosts, extra spins, or anything
   that affects play. Even that is not to be built until the owner explicitly
   decides to. Don't add payment code, stubs, or "coming soon" hooks.
4. **Keep `index.html` dependency-free and openable from the filesystem.** No
   bundler, no npm install, no CDN scripts. If that ever has to change, it's a
   deliberate decision, not a side effect of adding a library.

## Architecture notes

- **Straight beats flush** in Three Card Poker. Easy to get wrong.
- State persists to `localStorage` under `tcp.save.v1`. Bump the version string
  on any breaking shape change.

## Known gotchas

- The 6 Card Bonus paytable must include three of a kind at 7:1. Omitting it
  swings the house edge by ~25 percentage points. This bug has already been
  caught once by the enumerator.
- `test-payouts.js` checks that bankroll delta equals tracked net exactly. If
  that line ever says MISMATCH, chips are being created or destroyed somewhere
  in `resolve()`. Fix it before anything else.
- The admin console is obscurity, not security. Don't describe it as secure in
  comments or UI copy.

## Blackjack core

`blackjack-core.js` is the single source of truth for all blackjack logic:
hand totals, rules validation, shoe, round state machine, settlement, and basic
strategy. It is a classic script (not an ES module), so `index.html` loads it
with `<script src>` from `file://`, and Node `require`s it. **Do not copy its
logic into `index.html`.** That would recreate the `eval3()` drift problem,
which this file exists to avoid. The blackjack section of `index.html` only
moves chips and renders.

- **Chip flow.** `round.wagered` grows as the player bets, doubles, splits,
  and insures; the page deducts each increase from `S.chips` immediately.
  `round.returned` is paid once, from `settle()`, the only place payouts are
  computed. `test-blackjack-payouts.js` checks bankroll delta equals tracked
  net through the real page code. MISMATCH there means stop and fix it.
- **Rules** live in `tables.js` (`TABLE_RULES.blackjack`, `.freeBet`, and
  their house edges), the one copy shared by the page (`RULES.blackjack` etc.
  just point at it), the Node harnesses, and the Stage 2 server. Edit them
  there, never in `index.html`. Keys = `DEFAULT_RULES` in the core. `makeRules()` rejects any rule set that could
  ever owe a fractional chip. Both tables run on the same engine and the same
  page controller (`BJ_TABLES`, state in `S.bj` / `S.fb`). Variants are rule
  keys, never forks.
- **Free Bet** is three keys: `push22`, `freeDoubles`, `freeSplits`. Each hand
  carries `bet` (own chips, counted in `round.wagered`) and `free` (house
  chips, never counted). Win pays `bet + (bet + free)`; push returns `bet`;
  loss returns 0. Basic strategy has a separate Free Bet chart with
  real-hand and free-hand variants (a push is as bad as a loss on a free hand).
- **Displayed house edges** (`bjHouseEdge`, `fbHouseEdge` in `tables.js`) are checked by the payout
  harness, which fails if the page shows a number the simulation disagrees
  with. Change a rule, re-measure, update the number.
- `isNatural(cards, fromSplit)` and `dealerShouldHit(cards, rules)` throw if the
  split flag / `rules.hitSoft17` is missing. That is deliberate. Don't add defaults.
- **Pot of Gold** (`potOfGold`, Free Bet only, the owner's casino's rules;
  Free Bet has no other side bets): a coin per FREE double or FREE split, paid
  on coins at settle(). It depends on play, so it is NOT enumerable
  (`BJ.DEALT_SIDE_BETS` lists the ones that are); its edge is measured with
  basic strategy (`fbPotOfGoldEdge`, 6.81% over 40M rounds) and checked by
  test-blackjack-payouts.js section E.
- **Side bets** (`perfectPairs`, `twentyOnePlus3` paytables in the table's
  rules) are decided in `startRound()` from the first cards and paid in
  `settle()` with everything else. Their odds are enumerated exactly
  (`sideBetCounts()`), in-page and by `enumerate-blackjack.js`, which checks
  the counts against Wizard of Odds combination tables exactly. Stats keep
  `mainNet` separate so side bets don't distort the main game's return.
- In-progress rounds and shoes persist in `S.bj` / `S.fb` so a reload can't destroy
  a wager. That also means upcoming cards are readable in `localStorage`: the
  same obscurity-not-security caveat as the admin console.
- Not supported (absent on purpose, not half-built): surrender, no-peek/ENHC.

## Economy

`economy.js` (classic script, `ECON`) holds every economy rule: ranks/XP,
tiers (table limit + reward multiplier), the bet ladder, both wheels, the
weekly event calendar, daily quests, and the cosmetics shop.

- **Account actions** (ACCOUNT ACTIONS in `economy.js`): every change the
  economy makes (`grant`, `afterRound`, `claimQuest`, `ensureQuests`,
  `accrueVault`, `spin`, `moveVault`, `buy`, `equip`) is a plain function on
  an account `{ chips, econ, rows }`. The page runs them offline on
  `PLAYER` (an adapter over `S.chips` / `S.econ`); the server runs the SAME
  functions online on the wallet (with `rows` collecting ledger rows). They
  return events; the page's `econAnnounce()` turns events into messages and
  notifications. Don't add economy logic to the page or to `logic.js`: add it
  here, so online and offline can't drift.
- **Ledger.** Every chip that moves outside a game goes through `econGrant()`
  (`ECON.grant`) into `S.econ.ledger`. `econReconcile()` checks
  `chips = opening + game nets + ledger - chips in play` exactly; the Rewards
  tab shows it, and `test-economy.js` asserts it after every step of a long
  simulated session with reloads mid-hand. Never write `S.chips +=` anywhere
  else. The only other writers are game settlement and placing bets.
- **Hooks are read-only.** `econAfterRound(facts)` runs after a game has
  settled and receives facts about the result. It must never be called
  before settlement or be given anything that can change it.
- **Casino clock.** Every calendar rule (events, quest day, shop week, vault
  day) runs on ONE fixed timezone, US Eastern (`ECON.CLOCK_ZONE`), via
  `ECON.wall()` / `ECON.atWall()`. Never read local Date getters
  (getDay/getHours/getDate...) for an economy rule: the page, the server (UTC)
  and every device must agree, and a player must not be able to move into an
  event by changing their clock. `test-economy.js` runs the calendar under
  several TZ settings and requires identical answers.
- **Events** follow the casino clock, so every friend shares them. Promo events pay separate `promo` ledger chips; the Rewards tab
  shows each promo's exact effect on the affected bet's return.
- **Quests** are seeded by date + tier (`dailyQuests`), deterministic, so
  friends at a rank share them. The seeded PRNG there is for quest selection
  only. Anything with stakes uses crypto.
- **Quest claiming.** Completing a quest fixes its `reward` (so a Quest Rush
  completion stays doubled) but pays nothing; `econClaimQuest(i, day)` pays it
  once through `econGrant('quests')`. Unclaimed rewards are paid at day
  rollover in `econEnsureQuests`, never lost. Old saves' done quests load as
  `claimed: true` (they were paid under the old rule).
- **Notifications** (`S.econ.notes`, bell + toasts) and the **Home** tab are
  UI only. They announce what the economy did or offers; nothing reads them to
  decide a game or a grant. Claim buttons call `econClaimQuest`, which
  re-checks everything itself. De-dupe keys live in `S.econ.seen`.
- **Wheels** draw slices at angles proportional to their weights. Keep it
  that way: the picture is the odds.
- **Game harnesses** (`test-payouts.js`, `test-blackjack-payouts.js`) check
  `bankroll change - ledger change = game net`, because quests and promos can
  legitimately pay out during a run.
- **Vault** (`ECON.VAULT`): saved chips can't be bet and earn 1%/day, capped
  at 50 x tier mult per day, paid only on the lowest balance held all day (no
  deposit-at-midnight trick). Interest is a `ledger.interest` grant credited
  INTO the vault, so the identity is `chips + vault = ...`. Vault chips count
  toward the Rescue Wheel's "broke" test.
- **Tuning direction** (owner's call): the economy should feel fairly hard.
  If it needs more generosity, add it through saving (vault), not handouts.
- A Three Card Poker hand awaiting play/fold is persisted in `S.tcpRound`
  (previously a reload there destroyed the stake).

## Accounts (Supabase, Stage 2)

- Project `kavaswxswtkvguzdljyi`. The page holds the **publishable** key
  (public by design). Never put a secret / service_role key in the page, the
  repo, or a chat; it bypasses RLS.
- The page talks to Supabase with plain `fetch()` (ACCOUNTS section), no
  library, to keep hard rule 4. Magic-link sign-in; the session lives in
  `localStorage` under `casino.auth.v1`.
- Schema is in `supabase/migrations/`, applied by pasting into the dashboard
  SQL Editor. Every table gets RLS on, `revoke all` from `anon`/`authenticated`,
  then explicit column grants and policies. Verify from outside with the
  publishable key that anonymous reads/writes get `42501`.
- Edge Functions load `supabase/functions/_shared/` copies of
  `blackjack-core.js`, `tcp-core.js`, `slots-core.js`, `jackpot.js`, `roulette-core.js`, `tables.js` and `economy.js`. Those are byte-identical
  copies made by `sync-shared.js`; never edit them. Edit the root file, re-sync,
  and run `--check` before any deploy (the eval3() drift rule, server edition).
- **Online server** is the `play` Edge Function. `logic.js` is all of its
  logic (plain JS, runs the shared files, tested by `test-server.js`);
  `index.ts` only verifies the sign-in and talks to Postgres. The player is
  sent their round with the hole card hidden until it's over, and never the
  shoe. Each table has a `seq`; requests carry the seq they clicked on, so a
  double click can't bet twice. Deploy:
  `npx supabase functions deploy play --project-ref kavaswxswtkvguzdljyi --use-api --no-verify-jwt`
  (the function checks the token itself). Run `test-server.js` first.
- **Page online mode** (ONLINE PLAY section of `index.html`): signed in,
  `TS()`, `bankroll()` and `ACCT()` / `E()` point at `ON` (the server's
  views and wallet) instead of `S`, so the same renderers draw both modes.
  Online, the page never moves a chip or runs an economy action itself:
  game clicks go through `onSend`, economy clicks (claim, spin, vault, buy,
  equip) through `onEcon`; the server runs the action and returns the new
  wallet plus events, which the page announces. `bjSettle()` and
  `tcpSettled()` only record display stats online. Don't write `S.chips` /
  `S.econ` in an online path. Three Card Poker clicks go through
  `onTcpSend`; `TCPS()` is its bets/stats/history for the current mode, and
  the dealer's three cards are null in the page until the hand is over. An
  Online/Offline button under the chips switches. Display stats/bets persist
  under `casino.online.v1`.
- Online: every game (Blackjack, Free Bet, Three Card Poker, slots), XP (incl.
  Double XP), quests + claiming, event promos, both wheels, vault + interest,
  shop + equip. Every server request first catches the day up
  (`ensureQuests`, `accrueVault`).
- Balances, the ledger and dealing moved server-side together: a balance
  column the browser can write is a balance anyone can edit.

## Slots

`slots-core.js` (classic script, `SLOTS`) holds every machine as data (reel
strips, paytables, lines, feature) plus the spin (`play()`) and the pay
(`payOf()` / `wins()`). `slots-art.js` is presentation only: inline-SVG
symbols drawn via one hidden sprite.

- **A spin is one stop per reel, uniform over that reel's virtual stops**
  (classic reels carry per-stop weights: the real "virtual reel"). Nothing
  else decides it: no near-miss logic, no "due" wins, nothing about the
  player. The anticipation slow-down in the page is drawn from the
  already-decided result; it never changes one.
- **`SLOTS.PAR`** (RTP, hit frequency, feature chance, base-game SD) is what
  the page shows. `enumerate-slots.js` walks every stop combination through
  `payOf()` and fails if PAR disagrees. Change a strip, pay or feature: run it,
  copy its `suggestedPar` into PAR, run `test-slots.js`. Target RTP band is
  roughly 92-96%, like real casinos; current: Gilded Sevens 93.04%, Sunken
  Galleon 94.96%, Lantern Festival 94.65%.
- `payOf()` must stay allocation-free (the enumerator calls it ~750M times);
  `wins()` must always sum to it (`test-slots.js` checks).
- Free-spin state lives with the machine (`S.slots.m[id].free` offline, the
  `slot_<id>` table state online) so a reload can't lose a feature, and you
  can't switch machines mid-feature. Free spins don't award XP (nothing wagered).
- Table limit applies to the total cost of a spin. Every pay is a whole number
  of chips by construction (`checkMachine()` rejects anything else).
- Machines are original designs in real genres (stepper, 20-line, 243-ways).
  Don't rename them after, or restyle them as, real branded games.

## Linked jackpots (online only)

`jackpot.js` (classic script, `JACKPOT`) holds the rules; the server runs
them, the page only shows meters. One pool, shared by every machine and
every online player (`jackpot_pool`, one row; `jackpot_hits`; migration
`20261116000001_jackpots.sql`). Until that migration is applied, the
function runs slots without jackpots (`store.pool()` returns null).

- Every paid spin contributes 1.00% of its bet in total (`rate` per tier, in
  1/10,000ths). Free spins contribute nothing and can't win one.
- Mini/Minor are must-hit-by: the drop point is drawn uniformly between the
  meter and the cap at each reset, kept server-side only, and committed by
  SHA-256 (published) then revealed on the hit. Never send `hp`/`salt` of
  a live tier to a player. Major/Grand hit with chance cost / oddsPerChip.
- Meters are integer units (1 chip = 10,000). Audit identity per tier:
  `meter = seeded + contributed - paid` (`JACKPOT.auditError`).
- Jackpot RNG is a separate stream from the reels, so a spin's stops never
  depend on the pool. Jackpot wins are `payout` ledger rows, ref `jp:<tier>:<n>`.
- Pool writes go through `commit_spin()` (pool under its own version, then
  `commit_turn()` unchanged, one transaction); a racing spin gets 40001 and
  the turn retries. Recent hits go to players by display name only, with
  `mine` set for their own; never a user id.
- Owner's decision (2026-11-16): jackpots are a pay that grows over time for
  everyone, which hard rule 2 allows; odds never vary by player.

## Sound and celebrations

`sound.js` (`SFX`) synthesizes every sound with Web Audio; quiet, toggle in
the header, preference in `casino.sound.v1`. The page calls `sfx(name, ms)`,
which is a no-op without audio (Node harnesses). `bigHit()` is the
full-screen popup (jackpots, slot wins of 25x+, table wins of 15x+). Both are
presentation only and run after a result is settled; nothing reads them.

## Roulette

`roulette-core.js` (`ROULETTE`): American (0/00) and European (0) wheels.
Every legal bet is generated from the layout geometry (straight, split,
street, corner, six line, zero-area splits/trios, American basket, European
first four, all outside bets), so the page draws its chip spot and the server
can refuse anything that isn't a real bet. A spin is one uniform pocket;
`settle()` is the only payout. Exact edges by construction: (N+1)k/pockets.
Online tables `rl_american` / `rl_european`. Bets on the layout leave the
bankroll only when the spin is sent (nothing is "in play" between spins).
Table limit is per bet; table minimum is 5 chips a spin.

## Players: leaderboard and profiles (online)

- The `leaderboard` op returns every online player as a public card: display
  name, avatar, level/tier, title, equipped cosmetics, worth (chips + vault),
  this week's game net (bet + payout rows since Monday 00:00 ET,
  all-time gains / losses / net (rounds grouped by ref; v2 migration
  `20261117000002_leaderboard_alltime.sql`, which replaces v1),
  `ECON.weekStart`), best single round (bet + payout grouped by ref; a
  jackpot is its own ref) and jackpots. Computed by the SQL function
  `leaderboard()` (migration `20261117000001_leaderboard.sql`) from tables
  only the server writes. Never a user id; `mine` marks the caller.
  Without the migration the board is null and the page says so.
- Grants (wheels, quests, promos, interest) and the shop are not "winnings":
  the weekly board counts game results only.
- Avatar frames are a shop cosmetic kind (`frame`, style solid/glow/spin),
  drawn by `avatarHTML()`. Same rules as every cosmetic: flat prices for
  everyone, nothing that affects play. New cosmetic kinds go in
  `blankEcon().equipped`; `normalizeEcon` (and the page's load) backfill
  them and their free default into old accounts.

## Next up

The roadmap is done (see README). Ideas the owner hasn't decided on yet:
weekly tournaments with prizes, friend lists, more slot machines, craps.

Edge checks in both payout harnesses fail only beyond 4 standard errors
(about 1 run in 16,000 for a correct game). If one fails, re-run once; if it
fails again, it's real. Never widen a tolerance to make a failure go away.

See README.md for the full roadmap and the economy design notes.
