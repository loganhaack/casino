# Three Card Poker — verifiable build

A play-chip casino game that reports its own odds, computed from its own code.
The point is that nothing here asks you to trust it: the probability tables are
enumerated by brute force at runtime, and the payout logic is tested against
those tables.

This is the foundation for a multi-game casino (blackjack, Free Bet, slots).
Start here because Three Card Poker's entire game space is only 22,100 hands,
which means you can verify it exactly rather than estimate it.

## Files

| File | What it does |
|---|---|
| `index.html` | The game. Self-contained, no build step, no dependencies. Open it. |
| `enumerate.js` | Exact probability enumerator. Node, no dependencies. |
| `test-payouts.js` | Drives the real game code headlessly and verifies the chip math. |
| `expected.json` | Written by `enumerate.js`. Your chi-square reference. |

## Running it

```bash
# The game — just open the file, no server needed
open index.html          # macOS
start index.html         # Windows

# Exact math (~4 seconds)
node enumerate.js

# Verify the game implements that math (~1 minute)
node test-payouts.js 200000
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

Tunable in `RULES` at the top of the script.

- Starting chips: 1000
- Timed bonus: +250 every 6h
- Broke floor: +100 when you drop below the minimum bet

**The sizing problem.** House edge is a constant chip drain. At the ~2% element
of risk, a player betting 10 a hand bleeds roughly 0.2 chips per hand forever.
Your injections have to roughly match that drain. Inject too much and chips
stop meaning anything; inject too little and everyone is broke by Tuesday.

Budget it explicitly: estimate hands per session, multiply by average bet times
edge, then size the bonus slightly *under* that. Slightly under is the sweet
spot, because it means chips trend down and a big hand actually registers.

**Sinks matter more than sources.** If chips only get bet, accumulating them is
pointless. Give them somewhere to go: table-minimum tiers unlocked at chip
thresholds, a high-roller room, tournament buy-ins, cosmetics. Then a bankroll
means access, not just ammunition.

## Roadmap

- [x] Deck, shuffle, hand evaluation
- [x] Three Card Poker: Ante/Play, Pair Plus, 6 Card Bonus
- [x] Exact enumerator + payout test harness
- [x] Chip persistence, timed bonus, broke floor
- [ ] Blackjack — split/resplit/soft-17 are where the bugs live; test the
      hand-total function first and hardest
- [ ] Free Bet Blackjack — build it as a rules config on top of blackjack, not
      a fork. The dealer-22-pushes rule touches payout logic everywhere.
- [ ] 21+3 and Perfect Pairs
- [ ] Economy sinks (table tiers, high-roller room)
- [ ] Supabase: auth, shared chip balance, leaderboard
- [ ] Slots — code is easy, the PAR sheet is the hard part. Save it for last.

## Extending it

Everything tunable is in `RULES` at the top of the `<script>` block. Change a
paytable, mirror the change in `enumerate.js`, re-run both scripts, and you'll
see the new house edge before you ever deal a hand.

`eval3()` is byte-for-byte the same logic in `index.html` and `enumerate.js`.
If you change one, change the other, or the verification means nothing.
