#!/usr/bin/env node
/*
 * Exact dealer-outcome enumerator for blackjack.
 *
 * For each deck count and soft-17 rule, walks every possible dealer draw
 * sequence from a full shoe (upcard removed) and sums exact probabilities.
 * No sampling. The dealer's draw decisions come from blackjack-core.js, the
 * same code the game runs, so this checks the game's dealer, not a copy.
 *
 * Then:
 *   1. Cross-checks against published Wizard of Odds tables (6 decks S17/H17
 *      per upcard; 1-8 decks overall). Their tables are conditioned on the
 *      dealer having peeked and not having blackjack.
 *   2. Writes expected-blackjack.json, used by test-blackjack-payouts.js to
 *      chi-square the live dealer (real shuffle + real draw loop).
 *
 * Usage:  node enumerate-blackjack.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const BJ = require('./blackjack-core.js');

const OUTCOMES = ['17', '18', '19', '20', '21', 'bj', 'bust'];
const UPCARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];          // card values; 1 = Ace
const UP_LABEL = v => (v === 1 ? 'A' : String(v));

// Representative card int for a value (suits don't matter in blackjack).
const rep = v => (v === 1 ? 12 : v === 10 ? 8 : v - 2);

/**
 * Exact P(outcome | upcard) for a dealer playing from a fresh shoe with only
 * the upcard removed. Includes 'bj' (dealer natural), i.e. NOT conditioned on
 * the peek.
 */
function dealerDistribution(decks, upV, rules) {
  const counts = new Array(11).fill(0);
  for (let v = 1; v <= 9; v++) counts[v] = 4 * decks;
  counts[10] = 16 * decks;
  counts[upV]--;
  let left = 52 * decks - 1;

  const out = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
  const hand = [rep(upV)];
  let nodes = 0;

  (function rec(p) {
    nodes++;
    if (hand.length === 2 && BJ.isNatural(hand, false)) { out.bj += p; return; }
    if (hand.length >= 2 && !BJ.dealerShouldHit(hand, rules)) {
      const h = BJ.handValue(hand);
      out[h.bust ? 'bust' : String(h.total)] += p;
      return;
    }
    for (let v = 1; v <= 10; v++) {
      const c = counts[v];
      if (!c) continue;
      const q = p * c / left;
      counts[v]--; left--; hand.push(rep(v));
      rec(q);
      hand.pop(); counts[v]++; left++;
    }
  })(1);

  const sum = OUTCOMES.reduce((s, o) => s + out[o], 0);
  if (Math.abs(sum - 1) > 1e-12) throw new Error(`Probabilities sum to ${sum}`);
  return { dist: out, nodes };
}

/** Condition on no dealer blackjack (the peek), as published tables do. */
function noBJ(dist) {
  const k = 1 - dist.bj;
  const o = {};
  for (const x of OUTCOMES) if (x !== 'bj') o[x] = dist[x] / k;
  return o;
}

// ---------------------------------------------------------------------------
// Published reference: Wizard of Odds, Blackjack Appendix 2a
// https://wizardofodds.com/games/blackjack/appendix/2a/
// Columns 17, 18, 19, 20, 21, bust; conditioned on dealer not having blackjack.
// ---------------------------------------------------------------------------

const WOO_6D = {
  S17: {
    A:  [0.188071, 0.189235, 0.188906, 0.189362, 0.077394, 0.167033],
    2:  [0.139656, 0.134389, 0.13002,  0.124019, 0.118413, 0.353504],
    3:  [0.134296, 0.130539, 0.125226, 0.120817, 0.114928, 0.374194],
    4:  [0.130556, 0.124062, 0.121272, 0.116441, 0.111866, 0.395805],
    5:  [0.121843, 0.122437, 0.117575, 0.111793, 0.107945, 0.418406],
    6:  [0.165707, 0.106194, 0.106431, 0.101551, 0.097276, 0.422842],
    7:  [0.369208, 0.137931, 0.078428, 0.078682, 0.073816, 0.261936],
    8:  [0.12894,  0.359955, 0.128723, 0.069219, 0.06947,  0.243693],
    9:  [0.12031,  0.117348, 0.351854, 0.120368, 0.060877, 0.229242],
    10: [0.121273, 0.121007, 0.121306, 0.368447, 0.037729, 0.230239],
  },
  H17: {
    A:  [0.082842, 0.206593, 0.206757, 0.207262, 0.095264, 0.201281],
    2:  [0.130071, 0.135978, 0.131607, 0.125662, 0.120022, 0.356661],
    3:  [0.1259,   0.13193,  0.126656, 0.122185, 0.116371, 0.376958],
    4:  [0.122458, 0.125405, 0.12262,  0.11783,  0.113217, 0.39847],
    5:  [0.118089, 0.123042, 0.118216, 0.112435, 0.108586, 0.419632],
    6:  [0.115064, 0.114574, 0.115043, 0.110177, 0.105882, 0.439259],
    7:  [0.369208, 0.137931, 0.078428, 0.078682, 0.073816, 0.261936],
    8:  [0.12894,  0.359955, 0.128723, 0.069219, 0.06947,  0.243693],
    9:  [0.12031,  0.117348, 0.351854, 0.120368, 0.060877, 0.229242],
    10: [0.121273, 0.121007, 0.121306, 0.368447, 0.037729, 0.230239],
  },
};

// "All" rows (overall, peeked) for 1..8 decks.
const WOO_ALL = {
  S17: {
    1: [0.153225, 0.145065, 0.141657, 0.184722, 0.077364, 0.297967],
    2: [0.152784, 0.145746, 0.140865, 0.186996, 0.076841, 0.296767],
    4: [0.152561, 0.146087, 0.140478, 0.18811,  0.07659,  0.296174],
    6: [0.152487, 0.146201, 0.14035,  0.188478, 0.076507, 0.295977],
    8: [0.152449, 0.146258, 0.140286, 0.188661, 0.076466, 0.295879],
  },
  H17: {
    1: [0.141259, 0.146779, 0.143692, 0.186799, 0.079407, 0.302064],
    2: [0.140573, 0.147658, 0.142936, 0.189087, 0.07892,  0.300825],
    4: [0.140228, 0.148098, 0.142568, 0.19021,  0.078685, 0.300211],
    6: [0.140113, 0.148245, 0.142446, 0.190581, 0.078607, 0.300007],
    8: [0.140055, 0.148318, 0.142386, 0.190766, 0.078569, 0.299906],
  },
};
const PEEKED = ['17', '18', '19', '20', '21', 'bust'];
const TOL = 6e-7;   // published to 6 decimals

// ---------------------------------------------------------------------------

const t0 = Date.now();
const result = {};
let mismatches = 0;
let checked = 0;

function compare(label, ours, theirs) {
  for (let i = 0; i < PEEKED.length; i++) {
    checked++;
    const d = Math.abs(ours[PEEKED[i]] - theirs[i]);
    if (d > TOL) {
      mismatches++;
      console.log(`  MISMATCH ${label} ${PEEKED[i]}: ours ${ours[PEEKED[i]].toFixed(7)} published ${theirs[i]}`);
    }
  }
}

for (const decks of [1, 2, 4, 6, 8]) {
  for (const h17 of [false, true]) {
    const key = h17 ? 'H17' : 'S17';
    const rules = BJ.makeRules({ decks, hitSoft17: h17 });
    const pUp = {}, byUp = {};
    let nodes = 0;
    for (const u of UPCARDS) {
      const r = dealerDistribution(decks, u, rules);
      nodes += r.nodes;
      byUp[UP_LABEL(u)] = r.dist;
      pUp[UP_LABEL(u)] = (u === 10 ? 16 : 4) / 52;
    }

    // Overall, peeked: weight each upcard by P(up AND no dealer BJ), renormalize.
    const all = Object.fromEntries(PEEKED.map(o => [o, 0]));
    let wsum = 0;
    for (const u of UPCARDS) {
      const L = UP_LABEL(u);
      const w = pUp[L] * (1 - byUp[L].bj);
      wsum += w;
      const c = noBJ(byUp[L]);
      for (const o of PEEKED) all[o] += w * c[o];
    }
    for (const o of PEEKED) all[o] /= wsum;

    if (decks === 6) {
      for (const u of UPCARDS) compare(`6D ${key} up ${UP_LABEL(u)}`, noBJ(byUp[UP_LABEL(u)]), WOO_6D[key][UP_LABEL(u)]);
    }
    compare(`${decks}D ${key} all`, all, WOO_ALL[key][decks]);

    const pBJ = UPCARDS.reduce((s, u) => s + pUp[UP_LABEL(u)] * byUp[UP_LABEL(u)].bj, 0);
    result[`${decks}D_${key}`] = { decks, hitSoft17: h17, pUp, byUp, overallPeeked: all, pDealerBJ: pBJ, nodes };
  }
}

// ---------------------------------------------------------------------------

const r6 = result['6D_S17'], r6h = result['6D_H17'];
const pct = x => (100 * x).toFixed(4) + '%';
console.log('Dealer final outcome, 6 decks, peeked (no dealer BJ):\n');
console.log('  up    ' + PEEKED.map(o => o.padStart(9)).join('') + '     S17 vs H17');
for (const u of UPCARDS) {
  const L = UP_LABEL(u);
  const a = noBJ(r6.byUp[L]), b = noBJ(r6h.byUp[L]);
  console.log('  ' + L.padEnd(4) + '  ' + PEEKED.map(o => (100 * a[o]).toFixed(3).padStart(9)).join('') +
    `     bust ${pct(a.bust)} / ${pct(b.bust)}`);
}
console.log('  all   ' + PEEKED.map(o => (100 * r6.overallPeeked[o]).toFixed(3).padStart(9)).join(''));
console.log('');
for (const k of Object.keys(result)) {
  const r = result[k];
  console.log(`  ${k.padEnd(7)} bust ${pct(r.overallPeeked.bust)}   dealer BJ ${pct(r.pDealerBJ)}   (${r.nodes.toLocaleString()} tree nodes)`);
}

// ---------------------------------------------------------------------------
// Side bets: exact category counts and house edges, vs Wizard of Odds
//   https://wizardofodds.com/games/blackjack/side-bets/perfect-pairs/
//   https://wizardofodds.com/games/blackjack/side-bets/21plus3/
// ---------------------------------------------------------------------------

function exact(label, ours, theirs) {
  checked++;
  if (ours !== theirs) { mismatches++; console.log(`  MISMATCH ${label}: ours ${ours} published ${theirs}`); }
}
function close(label, ours, theirs, tol) {
  checked++;
  if (Math.abs(ours - theirs) > tol) {
    mismatches++; console.log(`  MISMATCH ${label}: ours ${ours.toFixed(7)} published ${theirs}`);
  }
}

const sideCounts = {};
for (const d of [1, 2, 3, 4, 5, 6, 7, 8]) {
  sideCounts[d] = {
    perfectPairs: BJ.sideBetCounts('perfectPairs', d),
    twentyOnePlus3: BJ.sideBetCounts('twentyOnePlus3', d),
  };
}

// Combination counts, exact.
const WOO_COUNTS = [
  ['perfectPairs', 8, { perfect: 1456, colored: 1664, mixed: 3328, lose: 79872, total: 86320 }],
  ['twentyOnePlus3', 6, { suitedTrips: 1040, straightFlush: 10368, trips: 25272, straight: 155520,
                          flush: 292896, lose: 4528224, total: 5013320 }],
  ['twentyOnePlus3', 8, { suitedTrips: 2912, straightFlush: 24576, trips: 61568, straight: 368640,
                          flush: 700928, lose: 10753536, total: 11912160 }],
];
for (const [kind, d, want] of WOO_COUNTS) {
  for (const k of Object.keys(want)) exact(`${d}D ${kind} ${k} count`, sideCounts[d][kind][k], want[k]);
}

// House edges for published paytables. [kind, paytable, {decks: published edge}, tolerance]
const PP = (perfect, colored, mixed) => ({ perfect, colored, mixed });
const T3 = (suitedTrips, straightFlush, trips, straight, flush) =>
  Object.fromEntries(Object.entries({ suitedTrips, straightFlush, trips, straight, flush }).filter(([, v]) => v));
const WOO_EDGES = [
  ['perfectPairs', 'Table A 25/12/6', PP(25, 12, 6), { 2: 0.223301, 4: 0.101449, 5: 0.077220, 6: 0.061093, 8: 0.040964 }, 6e-7],
  ['perfectPairs', 'Table B 30/10/5', PP(30, 10, 5), { 6: 0.057878, 8: 0.033735 }, 6e-7],
  ['perfectPairs', 'Table C 25/12/5', PP(25, 12, 5), { 6: 0.099678, 8: 0.079518 }, 6e-7],
  ['perfectPairs', 'Table D 25/15/5', PP(25, 15, 5), { 6: 0.041801, 8: 0.021687 }, 6e-7],
  ['twentyOnePlus3', 'V3 100/35/33/10/5', T3(100, 35, 33, 10, 5),
    { 3: 0.0776, 4: 0.0599, 5: 0.0489, 6: 0.0414, 7: 0.0360, 8: 0.0318 }, 6e-5],
  ['twentyOnePlus3', 'V4 -/30/20/10/5 (suited trips pay as trips)', T3(0, 30, 20, 10, 5),
    { 1: 0.227330, 2: 0.172736, 4: 0.143780, 5: 0.137863, 6: 0.133896, 8: 0.128912 }, 6e-7],
  // V5/V7: the page labels the last figures "7 decks: 6.29%" and "Six decks:
  // 3.70%", but applying those paytables to Wizard's OWN 8-deck combination
  // table (checked exactly above) gives 6.29% and 3.70%, and to its own 6-deck
  // table gives 7.14% and 4.62%. The labels are inconsistent with the counts;
  // the values are 8-deck figures, recorded as such here.
  ['twentyOnePlus3', 'V5 100/40/25/10/5', T3(100, 40, 25, 10, 5), { 4: 0.0878, 5: 0.0781, 6: 0.0714, 8: 0.0629 }, 6e-5],
  ['twentyOnePlus3', 'V7 100/40/30/10/5', T3(100, 40, 30, 10, 5), { 4: 0.0639, 8: 0.0370 }, 6e-5],
  // V10 pays "for one" (stake included), i.e. 99/34/19/14/4 to one. RTP 95.14%.
  ['twentyOnePlus3', 'V10 100/35/20/15/5 for one', T3(99, 34, 19, 14, 4), { 6: 1 - 0.9514 }, 6e-5],
];
console.log('\nSide bets, exact house edge (all decks 1-8 enumerated):');
for (const [kind, name, pt, byDecks, tol] of WOO_EDGES) {
  const cells = [];
  for (const d of Object.keys(byDecks)) {
    const edge = -BJ.sideBetReturn(pt, sideCounts[d][kind]);
    close(`${kind} ${name} ${d}D edge`, edge, byDecks[d], tol);
    cells.push(`${d}D ${(100 * edge).toFixed(4)}%`);
  }
  console.log(`  ${(kind === 'perfectPairs' ? 'Perfect Pairs ' : '21+3 ') + name}`.padEnd(54) + cells.join('  '));
}
result.sideBets = sideCounts;

console.log('');
console.log(`Published cross-check: ${checked - mismatches}/${checked} values match Wizard of Odds ` +
  '(dealer tables to 6 decimals, side-bet counts exactly, side-bet edges to published precision).');
fs.writeFileSync(path.join(__dirname, 'expected-blackjack.json'), JSON.stringify(result, null, 1));
console.log(`Wrote expected-blackjack.json in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
if (mismatches) process.exit(1);
