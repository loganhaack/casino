#!/usr/bin/env node
/*
 * Three Card Poker — exact probability enumerator
 *
 * Computes, by brute force, the true probability tables for:
 *   1. Three-card hand categories      C(52,3)  =      22,100 hands
 *   2. Ante/Play under Q-6-4 strategy  22,100 x 18,424 = 407,170,400 matchups
 *   3. Six Card Bonus                  C(52,6)  =  20,358,520 hands
 *
 * Nothing here is sampled or estimated. Every number is an exact count.
 * Check the output against https://wizardofodds.com/games/three-card-poker/
 *
 * Usage:  node enumerate.js
 */

'use strict';

// ---------------------------------------------------------------------------
// The game under test
// ---------------------------------------------------------------------------
// eval3(), categorize6() and the paytables are NOT defined here: they come from
// the same files the page and the online server play with (tcp-core.js and
// tables.js). So this enumerates the game as dealt, not a copy of it.

const TCP = require("./tcp-core.js");
const RULES = require("./tables.js").tcp;
const { eval3, categorize6, CAT_KEY } = TCP;
const CAT3_NAMES = TCP.CAT_NAME;
const CAT5_NAMES = TCP.CAT5_NAME;

const categoryOf = (value) => value >>> 20;

// ---------------------------------------------------------------------------
// Lookup table: every 3-card combination, pre-evaluated.
// ---------------------------------------------------------------------------
// Indexed by a*2704 + b*52 + c. Costs ~560KB and turns the 407M-iteration
// inner loop into a flat array read instead of a function call.

const LOOKUP = new Int32Array(52 * 52 * 52);

function buildLookup() {
  for (let a = 0; a < 50; a++) {
    for (let b = a + 1; b < 51; b++) {
      for (let c = b + 1; c < 52; c++) {
        LOOKUP[a * 2704 + b * 52 + c] = eval3(a, b, c).value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 1 — hand category distribution (and the Pair Plus paytable)
// ---------------------------------------------------------------------------

function enumerateHandCategories() {
  const counts = new Array(6).fill(0);
  let total = 0;

  for (let a = 0; a < 50; a++) {
    for (let b = a + 1; b < 51; b++) {
      for (let c = b + 1; c < 52; c++) {
        counts[categoryOf(LOOKUP[a * 2704 + b * 52 + c])]++;
        total++;
      }
    }
  }
  return { counts, total };
}

// Paytables from tables.js, re-keyed by category index for the inner loops.
const byCat = (table, keys) => Object.fromEntries(
  keys.map((k, i) => [i, k ? (table[k] || 0) : 0]).filter(([, v]) => v > 0));
const PAIR_PLUS_PAYS      = byCat(RULES.pairPlus, CAT_KEY);
const ANTE_BONUS_PAYS     = byCat(RULES.anteBonus, CAT_KEY);
const SIX_CARD_BONUS_PAYS = byCat(RULES.sixCard, TCP.CAT5_KEY);

// ---------------------------------------------------------------------------
// Pass 2 — Ante/Play, full head-to-head enumeration
// ---------------------------------------------------------------------------
// Strategy: raise on Q-6-4 or better, otherwise fold.
// Dealer qualifies on Queen-high or better.

// Strategy and qualifying bars, the same constants the page uses.
const Q64_THRESHOLD = TCP.Q64;          // Q-6-4 offsuit
const DEALER_QUALIFY_MIN = TCP.QUALIFY; // dealer qualifies on Q-high any kicker (Q-3-2 is the lowest)

function enumerateAntePlay() {
  const deck = [];
  for (let i = 0; i < 52; i++) deck.push(i);

  // Outcome tallies, in units of the ante bet
  let folds = 0;
  let playedTotal = 0;
  let dealerNotQualify = 0;
  let playerWins = 0;
  let ties = 0;
  let playerLoses = 0;

  // Expected value accumulator, in ante units, summed over all matchups
  let evSum = 0;
  let anteBonusSum = 0;
  let matchups = 0;

  const rest = new Int32Array(49);

  for (let a = 0; a < 50; a++) {
    for (let b = a + 1; b < 51; b++) {
      for (let c = b + 1; c < 52; c++) {

        const pVal = LOOKUP[a * 2704 + b * 52 + c];
        const pCat = pVal >>> 20;

        // Ante bonus is paid whether or not the hand goes to a showdown.
        const bonus = ANTE_BONUS_PAYS[pCat] || 0;

        // build the 49-card remainder
        let n = 0;
        for (let d = 0; d < 52; d++) {
          if (d !== a && d !== b && d !== c) rest[n++] = d;
        }

        const raise = pVal >= Q64_THRESHOLD;

        for (let i = 0; i < 47; i++) {
          const x = rest[i];
          for (let j = i + 1; j < 48; j++) {
            const y = rest[j];
            const xy = x * 2704 + y * 52;
            for (let k = j + 1; k < 49; k++) {
              const dVal = LOOKUP[xy + rest[k]];

              matchups++;
              anteBonusSum += bonus;

              if (!raise) {
                folds++;
                evSum += bonus - 1;       // lose the ante, keep any bonus
                continue;
              }

              playedTotal++;

              if (dVal < DEALER_QUALIFY_MIN) {
                dealerNotQualify++;
                evSum += bonus + 1;       // ante pays 1:1, play pushes
              } else if (pVal > dVal) {
                playerWins++;
                evSum += bonus + 2;       // both bets pay 1:1
              } else if (pVal === dVal) {
                ties++;
                evSum += bonus + 0;       // both push
              } else {
                playerLoses++;
                evSum += bonus - 2;       // both bets lost
              }
            }
          }
        }
      }
    }
  }

  return {
    matchups, folds, playedTotal, dealerNotQualify,
    playerWins, ties, playerLoses, evSum, anteBonusSum,
  };
}

// ---------------------------------------------------------------------------
// Pass 3 — Six Card Bonus
// ---------------------------------------------------------------------------
// Best five-card poker hand out of the player's three plus the dealer's three.
// Determined in a single pass per 6-card hand rather than by testing all
// C(6,5) = 6 subsets.

// Six Card Bonus paytable: see tables.js. NOTE three of a kind pays there.
// Leaving it out (an easy mistake) swings the house edge by roughly 25
// percentage points, which is exactly the kind of error this exists to catch.

function enumerateSixCardBonus() {
  const counts = new Array(10).fill(0);
  let total = 0;
  const hand = new Int32Array(6);

  for (let a = 0; a < 47; a++) {
    hand[0] = a;
    for (let b = a + 1; b < 48; b++) {
      hand[1] = b;
      for (let c = b + 1; c < 49; c++) {
        hand[2] = c;
        for (let d = c + 1; d < 50; d++) {
          hand[3] = d;
          for (let e = d + 1; e < 51; e++) {
            hand[4] = e;
            for (let f = e + 1; f < 52; f++) {
              hand[5] = f;
              counts[categorize6(hand)]++;
              total++;
            }
          }
        }
      }
    }
  }
  return { counts, total };
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

const pad  = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct  = (x) => (x * 100).toFixed(6) + '%';
const commas = (n) => n.toLocaleString('en-US');

function rule(n = 78) { console.log('-'.repeat(n)); }

function header(title) {
  console.log('');
  console.log('='.repeat(78));
  console.log('  ' + title);
  console.log('='.repeat(78));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const t0 = Date.now();

  console.log('Three Card Poker — exact enumeration');
  console.log('Every figure below is a complete count, not a simulation.');

  process.stdout.write('\nBuilding lookup table... ');
  buildLookup();
  console.log('done.');

  // ---- Pass 1 -------------------------------------------------------------
  process.stdout.write('Pass 1/3  hand categories... ');
  const t1 = Date.now();
  const { counts, total } = enumerateHandCategories();
  console.log(`done in ${((Date.now() - t1) / 1000).toFixed(2)}s`);

  header('1. THREE-CARD HAND DISTRIBUTION');
  console.log(pad('Hand', 18) + padL('Combinations', 14) + padL('Probability', 16));
  rule();
  for (let i = 5; i >= 0; i--) {
    console.log(
      pad(CAT3_NAMES[i], 18) +
      padL(commas(counts[i]), 14) +
      padL(pct(counts[i] / total), 16)
    );
  }
  rule();
  console.log(pad('TOTAL', 18) + padL(commas(total), 14) + padL(pct(1), 16));
  console.log(`\nSanity check: C(52,3) = 22,100 ... ${total === 22100 ? 'PASS' : 'FAIL'}`);

  // ---- Pair Plus ----------------------------------------------------------
  header(`2. PAIR PLUS  (paytable ${[1, 2, 3, 4, 5].map(i => PAIR_PLUS_PAYS[i] || 0).join('-')})`);
  console.log(
    pad('Hand', 18) + padL('Pays', 7) + padL('Combinations', 14) +
    padL('Probability', 15) + padL('Return', 13)
  );
  rule();
  let ppReturn = 0;
  for (let i = 5; i >= 1; i--) {
    const pays = PAIR_PLUS_PAYS[i] || 0;
    const p = counts[i] / total;
    const ret = pays * p;
    ppReturn += ret;
    console.log(
      pad(CAT3_NAMES[i], 18) + padL(pays, 7) + padL(commas(counts[i]), 14) +
      padL(p.toFixed(8), 15) + padL(ret.toFixed(8), 13)
    );
  }
  const ppLose = counts[0] / total;
  ppReturn += -1 * ppLose;
  console.log(
    pad('All other', 18) + padL(-1, 7) + padL(commas(counts[0]), 14) +
    padL(ppLose.toFixed(8), 15) + padL((-ppLose).toFixed(8), 13)
  );
  rule();
  console.log(pad('TOTAL', 18) + padL('', 7) + padL(commas(total), 14) +
              padL((1).toFixed(8), 15) + padL(ppReturn.toFixed(8), 13));
  console.log(`\nHouse edge: ${(-ppReturn * 100).toFixed(4)}%`);
  console.log(`RTP:        ${((1 + ppReturn) * 100).toFixed(4)}%`);

  // ---- Pass 2 -------------------------------------------------------------
  process.stdout.write('\nPass 2/3  ante/play head-to-head (407M matchups, this takes a bit)... ');
  const t2 = Date.now();
  const ap = enumerateAntePlay();
  console.log(`done in ${((Date.now() - t2) / 1000).toFixed(2)}s`);

  header('3. ANTE / PLAY  (strategy: raise on Q-6-4 or better)');
  const M = ap.matchups;
  const row = (label, n) =>
    console.log(pad(label, 34) + padL(commas(n), 18) + padL(pct(n / M), 15));

  row('Folded (worse than Q-6-4)', ap.folds);
  row('Raised', ap.playedTotal);
  rule();
  row('  Dealer did not qualify', ap.dealerNotQualify);
  row('  Player won showdown', ap.playerWins);
  row('  Tie', ap.ties);
  row('  Player lost showdown', ap.playerLoses);
  rule();
  row('TOTAL matchups', M);
  console.log(`\nSanity check: 22,100 x 18,424 = 407,170,400 ... ${M === 407170400 ? 'PASS' : 'FAIL'}`);

  console.log(`\nFold frequency:            ${pct(ap.folds / M)}`);
  console.log(`Dealer qualifies:          ${pct(1 - (ap.dealerNotQualify / ap.playedTotal))} (of raised hands)`);

  const evPerAnte = ap.evSum / M;
  const bonusPerAnte = ap.anteBonusSum / M;
  const avgWagered = 1 + (ap.playedTotal / M); // ante always, play when raised

  header('4. ANTE/PLAY EXPECTED VALUE');
  console.log(`Ante Bonus contribution:   ${bonusPerAnte.toFixed(8)} per ante`);
  console.log(`Net EV:                    ${evPerAnte.toFixed(8)} per ante`);
  console.log(`Average amount wagered:    ${avgWagered.toFixed(8)} ante units`);
  rule();
  console.log(`House edge (per ante):     ${(-evPerAnte * 100).toFixed(4)}%`);
  console.log(`Element of risk (per $ wagered): ${(-evPerAnte / avgWagered * 100).toFixed(4)}%`);
  console.log(`\nWizard of Odds publishes a ~3.37% house edge on the ante`);
  console.log(`and ~2.01% element of risk. Compare the two numbers above.`);

  // ---- Pass 3 -------------------------------------------------------------
  process.stdout.write('\nPass 3/3  six card bonus (20.3M hands)... ');
  const t3 = Date.now();
  const scb = enumerateSixCardBonus();
  console.log(`done in ${((Date.now() - t3) / 1000).toFixed(2)}s`);

  header(`5. SIX CARD BONUS  (pay table ${[9, 8, 7, 6, 5, 4, 3].map(i => SIX_CARD_BONUS_PAYS[i] || 0).join('-')})`);
  console.log(
    pad('Best 5 of 6', 20) + padL('Pays', 7) + padL('Combinations', 14) +
    padL('Probability', 15) + padL('Return', 13)
  );
  rule();
  let scbReturn = 0;
  let scbLoseCount = 0;
  for (let i = 9; i >= 0; i--) {
    const pays = SIX_CARD_BONUS_PAYS[i] || 0;
    if (!pays) { scbLoseCount += scb.counts[i]; continue; }
    const p = scb.counts[i] / scb.total;
    const ret = pays * p;
    scbReturn += ret;
    console.log(
      pad(CAT5_NAMES[i], 20) + padL(pays, 7) + padL(commas(scb.counts[i]), 14) +
      padL(p.toFixed(8), 15) + padL(ret.toFixed(8), 13)
    );
  }
  const scbLoseP = scbLoseCount / scb.total;
  scbReturn += -1 * scbLoseP;
  console.log(
    pad('All other', 20) + padL(-1, 7) + padL(commas(scbLoseCount), 14) +
    padL(scbLoseP.toFixed(8), 15) + padL((-scbLoseP).toFixed(8), 13)
  );
  rule();
  console.log(pad('TOTAL', 20) + padL('', 7) + padL(commas(scb.total), 14) +
              padL((1).toFixed(8), 15) + padL(scbReturn.toFixed(8), 13));
  console.log(`\nSanity check: C(52,6) = 20,358,520 ... ${scb.total === 20358520 ? 'PASS' : 'FAIL'}`);
  console.log(`House edge: ${(-scbReturn * 100).toFixed(4)}%`);
  console.log(`RTP:        ${((1 + scbReturn) * 100).toFixed(4)}%`);

  // ---- Export -------------------------------------------------------------
  const out = {
    generated: new Date().toISOString(),
    handCategories: CAT3_NAMES.map((name, i) => ({
      name, combinations: counts[i], probability: counts[i] / total,
    })),
    pairPlus: { paytable: PAIR_PLUS_PAYS, houseEdge: -ppReturn, rtp: 1 + ppReturn },
    antePlay: {
      matchups: M,
      foldRate: ap.folds / M,
      houseEdgePerAnte: -evPerAnte,
      elementOfRisk: -evPerAnte / avgWagered,
    },
    sixCardBonus: {
      paytable: SIX_CARD_BONUS_PAYS,
      categories: CAT5_NAMES.map((name, i) => ({
        name, combinations: scb.counts[i], probability: scb.counts[i] / scb.total,
      })),
      houseEdge: -scbReturn,
      rtp: 1 + scbReturn,
    },
  };

  require('fs').writeFileSync('expected.json', JSON.stringify(out, null, 2));

  // The page shows TABLE_RULES.tcpHouseEdge. It must be what was just computed.
  const shown = require('./tables.js').tcpHouseEdge;
  const computed = { ante: -evPerAnte, pairPlus: -ppReturn, sixCard: -scbReturn };
  let edgesOk = true;
  console.log('');
  for (const k of Object.keys(computed)) {
    const same = Math.abs(shown[k] - computed[k]) < 5e-7;
    edgesOk = edgesOk && same;
    console.log(`Displayed edge ${k.padEnd(9)} ${(shown[k] * 100).toFixed(4)}% vs exact ${(computed[k] * 100).toFixed(4)}% ... ${same ? 'PASS' : 'FAIL (update tcpHouseEdge in tables.js)'}`);
  }
  if (!edgesOk) process.exitCode = 1;

  console.log('');
  rule();
  console.log('Wrote expected.json — this is your chi-square reference.');
  console.log(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  rule();
}

main();
