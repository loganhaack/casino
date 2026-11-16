# Three Card Poker — verifiable build

A play-chip casino game that reports its own odds, computed from its own code.
The point is that nothing here asks you to trust it: the probability tables are
enumerated by brute force at runtime, and the payout logic is tested against
those tables.

This is the foundation for a multi-game casino. Three Card Poker, Blackjack and
Free Bet Blackjack are playable; slots come last.
Start here because Three Card Poker's entire game space is only 22,100 hands,
which means you can verify it exactly rather than estimate it.

## Files

| File | What it does |
|---|---|
| `index.html` | The game. Self-contained, no build step, no dependencies. Open it. |
| `enumerate.js` | Exact probability enumerator. Node, no dependencies. |
| `test-payouts.js` | Drives the real game code headlessly and verifies the chip math. |
| `blackjack-core.js` | All blackjack logic: totals, shoe, rounds, settlement, basic strategy. Loaded by the game and by Node. |
| `test-blackjack.js` | Hand totals vs exhaustive oracle, stacked-shoe engine scenarios, 200k-round fuzz vs an independent payout oracle. |
| `enumerate-blackjack.js` | Exact dealer outcome tables, cross-checked against Wizard of Odds. Writes `expected-blackjack.json`. |
| `economy.js` | Ranks, wheels, quests, events, shop. Grants chips only; never touches odds. |
| `HOSTING.md` | How to put the site online now, and what has to move server-side for shared accounts later. |
| `test-economy.js` | Wheel fairness, quests/events, ledger reconciliation, and the deal-is-indifferent-to-who-you-are test. |
| `test-blackjack-payouts.js` | Drives the real page code: chip accounting, house edge, live-dealer chi-square. |
| `expected.json` | Written by `enumerate.js`. Your chi-square reference. |

## Running it

```bash
# The game — just open the file, no server needed
open index.html          # macOS
start index.html         # Windows

# Exact math (~4 seconds)
node enumerate.js

# Verify the game implements that math (~6 minutes)
node test-payouts.js 200000

# Economy (~30 seconds)
node test-economy.js

# Blackjack
node test-blackjack.js           # ~6 seconds
node enumerate-blackjack.js      # <1 second
node test-blackjack-payouts.js   # ~3 minutes
```

## Verified numbers

`enumerate.js` brute-forces all 22,100 three-card hands, all 407,170,400
ante/play matchups, and all 20,358,520 six-card combinations. No sampling.

| Bet | House edge | Cross-check |
|---|---|---|
| Ante (per ante) | 3.3730% | Wizard of Odds: 3.37% |
| Ante (element of risk) | 2.0147% | Wizard of Odds: 2.01% |
| Pair Plus (1-3-6-30-40) | 7.2760% | |
| 6 Card Bonus (pay table 1) | 8.5614% | |

Three-of-a-kind count in the six-card enumeration comes out to 732,160, which
matches the published figure exactly.

`test-payouts.js` then plays 200k hands per scenario through the actual
`deal()` and `resolve()` functions and confirms the realized edge converges on
those numbers, that the bankroll moves by exactly the tracked net (no chip
leaks), and that correct Q-6-4 strategy genuinely beats never folding
(2.02% vs 4.06%).

## Blackjack: verified numbers

**Blackjack:** 6 decks, dealer stands on soft 17, blackjack pays 3:2, dealer
peeks, double any two cards and after splits, split to 4 hands, split Aces get
one card and can't be resplit, insurance offered, no surrender, 75% penetration.

**Free Bet Blackjack** (Wizard of Odds standard rules): the same, except the
dealer hits soft 17, Aces may be resplit, doubles on hard 9-11 and splits of
every pair except tens are free, and a dealer 22 pushes every live hand.

Bets are multiples of 10 so 3:2 and insurance always pay whole chips.

**Side bets** on both tables: Perfect Pairs (perfect 25, colored 12, mixed 6,
Wizard Table A) and 21+3 (suited trips 100, straight flush 40, trips 30,
straight 10, flush 5, Wizard Version 7). A-2-3 and Q-K-A are straights; K-A-2
isn't.

| Check | Result |
|---|---|
| Dealer final-outcome tables (exact enumeration) | 180/180 values match [Wizard of Odds](https://wizardofodds.com/games/blackjack/appendix/2a/) to 6 decimals |
| Live dealer vs exact (crypto shuffle + engine draw loop) | chi-square passes, 1 and 6 decks, S17 and H17 |
| Blackjack house edge, basic strategy | ~0.43% of initial bet (150M simulated rounds over five runs); published 0.44% |
| H17 instead of S17 | costs ~0.2pp (published ~0.22pp) |
| Free Bet house edge, Free Bet strategy | ~1.04% (120M rounds over two runs); [Wizard of Odds](https://wizardofodds.com/games/free-bet-blackjack/): 1.04% |
| Free Bet, no resplitting Aces | +0.074pp (80M rounds); Wizard of Odds: +0.08pp |
| Free Bet played with the classic chart | ~2.2pp worse, so the Free Bet chart earns its keep |
| Side-bet combination counts (exact enumeration) | identical to Wizard of Odds' published counts: Perfect Pairs (8 decks), 21+3 (6 and 8 decks) |
| Side-bet house edges | match Wizard of Odds for 4 Perfect Pairs and 5 21+3 paytables across 1-8 decks; this game: Perfect Pairs 6.1093%, 21+3 4.6210% (6 decks) |
| Side bets dealt in play | category chi-square and realized return match the exact enumeration over 1M rounds per table |
| Chip accounting through the real page code | exact on both tables, under basic strategy and random play with insurance and both side bets |

Wizard's 21+3 page labels two figures "7 decks: 6.29%" (Version 5) and "Six
decks: 3.70%" (Version 7). Wizard's own combination tables, which match ours
exactly, give those values at 8 decks, so the enumerator checks them as 8-deck
figures; see the comment in `enumerate-blackjack.js`.

The house edge is simulated, not enumerated: exact blackjack EV with splits is
a much larger computation than Three Card Poker's 22,100 hands. The dealer
tables everything rests on are exact.

## Admin console

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>, passphrase in `RULES.adminPass`
(currently `felt` — change it).

- Set or add chips
- Enumerate all 22,100 hands in-page
- Chi-square your session against the exact distribution
- Monte Carlo 200k deals through the live shuffler
- Export the full hand log as CSV
- Reveal dealer hole cards

**This is obscurity, not security.** Anyone with devtools can call these
functions or edit `localStorage` directly. That's fine among friends. If chips
ever need to be tamper-proof, dealing has to move server-side.

## RNG

Fisher-Yates over `crypto.getRandomValues`, rejection-sampled to avoid modulo
bias. `Math.random` would almost certainly be fine, but when you're down nine
hands in a row you want to be able to rule it out instead of arguing about it.

## Economy

The rules are in `economy.js`. **None of it can change a game's odds.** The
economy only grants chips (or takes them for cosmetics), and the deal is
provably identical for every player: `test-economy.js` gives a broke level-1
player and a rich Diamond during an event the same seed and decisions, and
requires identical cards and results.

- **Ranks.** XP comes from playing: 10-20 per round, barely more for big bets,
  plus 100 per quest. Rank tracks time at the table, not bankroll, so a friend
  on 50 chips ranks up as fast as one on 50,000. Tiers (Bronze, Silver, Gold,
  Platinum, Diamond) raise your table limit (500 up to 250,000 per bet) and
  multiply wheel prizes, quest rewards and the vault cap (x1 up to x2.5,
  deliberately flat). Diamond takes about 66,000 XP, or 4,000+ rounds.
- **Bonus Wheel** every 6 hours (expected 80 chips at x1). **Rescue Wheel**
  whenever you have under 10 chips including your vault, as often as you need
  it, the same for everyone (expected 47.5, minimum 25: enough to keep
  playing, not enough to feel rich). Slices are drawn to scale, so the wheel
  you see is the real distribution, and both wheels are chi-square tested.
- **Vault: the reward for saving.** Chips in the vault can't be bet and earn
  1% a day, capped at 50 a day (x rank). Interest is paid on the lowest
  balance held all day, so parking chips overnight earns nothing.
- **Daily quests**, three a day, chosen by date and rank, so friends at a rank
  share them. 100 chips each (x rank) plus 100 XP.
- **Weekly events**, the same calendar for everyone: Quest Rush (Mon, quest
  chips x2), Double XP (Wed), Blackjack Bonanza (Fri 6pm-midnight, naturals pay
  a +20% promo, max 1,000: blackjack goes from -0.43% to about +0.52% while it
  runs, Free Bet to about -0.09%), Lucky Wheel (Sat, wheel twice as often at
  x2), Big Hand Sunday (Pair Plus trips/straight flush pay a +3x promo, max
  2,500: Pair Plus from -7.28% to about -5.92%). Promos are separate chips on
  top of the game result.
  The Rewards tab shows each one's exact effect on the affected bet.
- **Shop: cosmetics only** (felts, card backs, titles), 2,500 to 10,000,000.
  The chip sink: chips buy status, never odds.
- **Ledger.** Every chip has a source. The Rewards tab reconciles your balance
  to the chip: opening + game results + wheels + quests + promos + vault
  interest - shop.

**Sizing: deliberately tight.** An active Bronze player can pull in roughly
450-650 chips a day from the economy (2-4 wheel spins at an expected 80, three
quests at 100, up to 50 vault interest). Against 1,000 starting chips and shop
prices from 2,500 up, that makes a cosmetic something you save for, and a big
win at the tables actually matters. If it ever needs more generosity, add it
through saving (the vault), not handouts. Never through odds.

## Roadmap

- [x] Deck, shuffle, hand evaluation
- [x] Three Card Poker: Ante/Play, Pair Plus, 6 Card Bonus
- [x] Exact enumerator + payout test harness
- [x] Chip persistence, timed bonus, broke floor
- [x] Blackjack: engine, exact dealer tables, payout harness
- [x] Free Bet Blackjack: three rule keys on the same engine, own strategy chart
- [x] 21+3 and Perfect Pairs: exact enumeration, cross-checked combination counts
- [x] Economy: ranks, table limits, wheels, quests, events, cosmetics shop, ledger
- [x] Table feel: cards are dealt and turned over in sequence, and the result
      shows once they land; real chip stacks in a tray and on every bet, moving
      out at the deal and back (or to the dealer) at settlement. All display
      only: drawn from numbers the game already settled.
- [x] Home tab, notifications (bell + toasts), quests claimed by hand
- [x] Supabase: auth, server wallets + ledger, every game dealt on the server
- [ ] Leaderboard
- [ ] Profiles (with Supabase): display name, avatar, equipped cosmetics
      visible to friends. Gives the shop more to sell for chips (avatars,
      frames). Cosmetic only, never anything that affects play.
- [x] Slots: three machines (classic 3-reel, 20-line, 243-ways) with exact
      PAR sheets by complete enumeration (`enumerate-slots.js`), published
      reel strips, free spins, online and offline.
- [x] Linked progressive jackpots (Mini/Minor must-hit-by with published
      SHA-256 commitments, Major/Grand mystery), big-hit popups, sound.

## Extending it

Every paytable and table rule is in `tables.js`. Change one, re-run the
game's scripts, and you'll see the new house edge before you ever deal a hand.

Three Card Poker's logic (`eval3()`, the six-card bonus evaluator, the deal
and settlement) lives only in `tcp-core.js`, and the page, `enumerate.js`,
the harness and the online server all load that one file. So the enumerator
verifies the code that actually deals, not a copy of it. Never copy it back
into `index.html`.
