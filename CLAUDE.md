# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

A play-chip casino game (no real money, ever) built so that its odds are
verifiable rather than trusted. Three Card Poker, Blackjack and Free Bet
Blackjack (with 21+3 and Perfect Pairs side bets) are done, along with the
economy (`economy.js`). Supabase (accounts) and slots are planned.

The origin of the project: social casino apps are unregulated and have every
incentive to tune their RNG toward chip sales. The response is a game that
computes its own probability tables by brute force and tests its payout logic
against them. That property is the point of the project, not a nice-to-have.

## Commands

```bash
node enumerate.js              # exact probability tables, ~4s, writes expected.json
node test-payouts.js 200000    # drives the real game code, verifies chip math, ~6min
node test-blackjack.js         # blackjack totals + engine scenarios + fuzz, ~6s
node enumerate-blackjack.js    # exact dealer tables vs Wizard of Odds, <1s, writes expected-blackjack.json
node test-blackjack-payouts.js # real page code: chip accounting, house edge, dealer chi-square, ~3min
node test-economy.js           # wheels, quests, events, ledger, "deal is indifferent to who you are", ~30s
node sync-shared.js            # copy blackjack-core/tables/economy into supabase/functions/_shared/
node sync-shared.js --check    # fails if the server's copies drift from the root files
node test-server.js            # online table server vs in-memory commit_turn: ledger, no leaks, same game, ~30s
node test-online-page.js       # real page code playing online against the real server logic, ~10s
open index.html                # the game; no build step, no server, no deps
```

Run a game's scripts after any change to its logic or paytables (all three
blackjack scripts for blackjack). They are fast
enough that there is no excuse to skip them.

## Critical invariant

`eval3()` is duplicated verbatim in `index.html` and `enumerate.js`.

**If you change one, change the other.** If they drift, the enumerator is
validating a different game than the one being played and the whole
verification story is theater.

Pulling this into a shared module is on the roadmap and is the right fix. Until
there's a build step, the duplication is deliberate so `index.html` stays
openable as a bare file.

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
weekly event calendar, daily quests, and the cosmetics shop. The page's
economy section only applies those rules.

- **Ledger.** Every chip that moves outside a game goes through `econGrant()`
  into `S.econ.ledger`. `econReconcile()` checks
  `chips = opening + game nets + ledger - chips in play` exactly; the Rewards
  tab shows it, and `test-economy.js` asserts it after every step of a long
  simulated session with reloads mid-hand. Never write `S.chips +=` anywhere
  else. The only other writers are game settlement and placing bets.
- **Hooks are read-only.** `econAfterRound(facts)` runs after a game has
  settled and receives facts about the result. It must never be called
  before settlement or be given anything that can change it.
- **Events** come from the local date (no server), so friends in one timezone
  share them. Promo events pay separate `promo` ledger chips; the Rewards tab
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
  `blackjack-core.js`, `tables.js` and `economy.js`. Those are byte-identical
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
  `TS()` and `bankroll()` point at `ON` (server views) instead of `S`, so the
  same renderer draws both modes. Online, the page never moves a chip or
  calls `econAfterRound`; `bjSettle()` only records display stats. Don't
  write `S.chips` in an online path. An Online/Offline button under the
  chips switches; Poker and Rewards show an "offline only" panel while
  online. Display stats/bets persist under `casino.online.v1`.
- Online so far: blackjack + Free Bet, base XP / table limits, and the
  Rescue Wheel (`op: 'rescue'`, same `ECON.WHEELS.rescue` odds, shown as a
  button with its odds listed when an online player is broke). Quests,
  promos, Double XP, Bonus Wheel, vault, shop are not online yet: events run on
  the player's local clock and the server is UTC, which needs deciding first.
- Step 1 (done): profiles only (name, avatar). Chips still live in the browser.
  Step 2: balances + ledger + dealing move into Edge Functions together. A
  balance column the browser can write is a balance anyone can edit.

## Next up

Going live: see HOSTING.md. Stage 1 is static hosting as-is. Stage 2 is
Supabase (auth, shared balances, leaderboard), and it requires moving
shuffle/deal/settle server-side (Edge Function running blackjack-core.js and
economy.js unchanged) before any leaderboard means anything. Then slots.

Edge checks in both payout harnesses fail only beyond 4 standard errors
(about 1 run in 16,000 for a correct game). If one fails, re-run once; if it
fails again, it's real. Never widen a tolerance to make a failure go away.

See README.md for the full roadmap and the economy design notes.
