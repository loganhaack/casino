/*
 * Table rules for blackjack, Free Bet and Three Card Poker: the ONE copy.
 *
 * Loaded by index.html (<script src>), by the Node test harnesses (require),
 * and (Stage 2) by the server that deals online games. Before this file the
 * rules lived inside index.html, which a server can't load; copying them
 * would recreate the eval3() drift problem (CLAUDE.md). So they live here.
 *
 * Keys are the engine's rule keys (blackjack-core.js, DEFAULT_RULES). Change
 * any of these and you must re-run
 *   node enumerate-blackjack.js && node test-blackjack-payouts.js
 * and update the matching house edge below with the new measured figure; the
 * payout harness fails if the displayed edge disagrees with what it measures.
 *
 * A classic script (not an ES module) so index.html still opens from file://.
 */
(function (root) {
  'use strict';

  const TABLE_RULES = {
    blackjack: {
      decks: 6, penetration: 0.75, hitSoft17: false, blackjackPays: [3, 2],
      insurance: true, doubleOn: 'any', doubleAfterSplit: true, maxHands: 4,
      resplitAces: false, hitSplitAces: false, betUnit: 2,
      // Side bets (pays N to 1). The exact house edge for these paytables is
      // enumerated in-page and by enumerate-blackjack.js; see the rules panel.
      perfectPairs:   { perfect: 25, colored: 12, mixed: 6 },                                   // Wizard Table A
      twentyOnePlus3: { suitedTrips: 100, straightFlush: 40, trips: 30, straight: 10, flush: 5 }, // Wizard Version 7
    },
    // Basic-strategy house edge per initial bet. Pooled over 150M simulated
    // rounds in five runs: ~0.43% (a published simulation gives 0.44%). The
    // payout harness fails if this drifts more than 4 SE from what it measures.
    bjHouseEdge: 0.0043,

    // Free Bet Blackjack: Wizard of Odds' standard rules (6 decks, H17, resplit
    // Aces, free doubles on hard 9-11 incl. after splits, free splits and
    // resplits except tens, dealer 22 pushes). Same re-measure rule as above.
    // Side bet: Pot of Gold only, as the owner's casino spreads it (one gold
    // coin per free double / free split; pays by coins).
    freeBet: {
      decks: 6, penetration: 0.75, hitSoft17: true, blackjackPays: [3, 2],
      insurance: true, doubleOn: 'any', doubleAfterSplit: true, maxHands: 4,
      resplitAces: true, hitSplitAces: false, betUnit: 2,
      push22: true, freeDoubles: true, freeSplits: true,
      potOfGold: { coins1: 3, coins2: 12, coins3: 30, coins4: 50, coins5: 100, coins6: 100, coins7: 100 },
    },
    // Pooled over 120M simulated rounds in two runs: ~1.04%. Wizard of Odds: 1.04%.
    fbHouseEdge: 0.0104,
    // Pot of Gold house edge with the Free Bet basic-strategy chart. It depends
    // on play (coins come from free doubles/splits), so it is measured, not
    // enumerated: 40M rounds in four runs, 6.81% +/- 0.05% (2026-11-17). The
    // payout harness fails if it drifts more than 4 SE from what it measures.
    fbPotOfGoldEdge: 0.0681,

    bjMinBet: 10,
    bjBetStep: 10,

    // Three Card Poker paytables (pays N to 1), played by tcp-core.js.
    // Change any of these and re-run
    //   node enumerate.js && node test-payouts.js 200000
    // and update the edges below (and the expected edges in test-payouts.js).
    tcp: {
      // Pair Plus, the common 1-3-6-30-40 table.
      pairPlus: { pair: 1, flush: 3, straight: 6, trips: 30, straightFlush: 40 },
      // Ante Bonus: paid on the ante whether or not the dealer qualifies or wins.
      anteBonus: { straight: 1, trips: 4, straightFlush: 5 },
      // Six Card Bonus (Wizard of Odds pay table 1): best 5 of your 3 + the dealer's 3.
      // Three of a kind MUST pay: leaving it out swings the edge by ~25 points.
      sixCard: {
        trips: 7, straight: 10, flush: 15, fullHouse: 20,
        quads: 100, straightFlush: 200, royalFlush: 1000,
      },
      minBet: 5,
      betStep: 5,
    },
    // Exact, from enumerate.js (not simulated).
    tcpHouseEdge: { ante: 0.033730, pairPlus: 0.072760, sixCard: 0.085614 },

    // Opening balance: offline (a new save) and online (a new server wallet).
    startingChips: 1000,
  };

  if (typeof module === 'object' && module.exports) module.exports = TABLE_RULES;
  else root.TABLE_RULES = TABLE_RULES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
