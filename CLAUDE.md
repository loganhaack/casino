# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

A play-chip casino game (no real money, ever) built so that its odds are
verifiable rather than trusted. Three Card Poker is done. Blackjack, Free Bet
Blackjack, and slots are planned.

The origin of the project: social casino apps are unregulated and have every
incentive to tune their RNG toward chip sales. The response is a game that
computes its own probability tables by brute force and tests its payout logic
against them. That property is the point of the project, not a nice-to-have.

## Commands

```bash
node enumerate.js              # exact probability tables, ~4s, writes expected.json
node test-payouts.js 200000    # drives the real game code, verifies chip math, ~1min
open index.html                # the game; no build step, no server, no deps
```

Run both scripts after any change to game logic or paytables. They are fast
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

1. **No change to a paytable or game rule ships without re-running both
   scripts.** Paste the new house edge in the commit message.
2. **Never tune odds based on player behavior, spend, or session history.** The
   entire premise of this project is that the deal is indifferent to who you
   are. Any "dynamic difficulty," comeback mechanic, or loss-streak
   compensation is a bug, not a feature, even if requested in the moment.
3. **No real currency, no purchasable chips, no payment integration.** Chips
   are free and always will be. This is not a gambling product and must not
   grow into one.
4. **Keep `index.html` dependency-free and openable from the filesystem.** No
   bundler, no npm install, no CDN scripts. If that ever has to change, it's a
   deliberate decision, not a side effect of adding a library.

## Architecture notes

- Cards are integers 0-51. `rank = c % 13` (0=Two, 12=Ace), `suit = (c/13)|0`.
- Hand strength is a single packed int: `(category << 20) | tiebreak`. Larger
  always wins. Lets comparison be a single `>`.
- **Straight beats flush** in Three Card Poker. Easy to get wrong.
- Shuffle is Fisher-Yates over `crypto.getRandomValues` with rejection sampling
  to avoid modulo bias.
- All tunables live in the `RULES` object at the top of the script block.
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

## Next up

Blackjack. Write and test the hand-total function (soft aces, multiple aces)
before writing any game loop. Splits, resplits, split aces, and dealer soft 17
are where blackjack bugs live. Free Bet Blackjack goes on top as a rules
config, never a fork, because the dealer-22-pushes rule touches payout logic in
several places.

See README.md for the full roadmap and the economy design notes.
