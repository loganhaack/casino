#!/usr/bin/env node
/*
 * Tests for blackjack-core.js: card values, hand totals, naturals, dealer rule.
 *
 * Three layers:
 *   1. Named cases: the specific hands where blackjack bugs live (soft/hard
 *      transitions, multiple Aces, soft 17, split 21s).
 *   2. Exhaustive oracle: every multiset of card values up to MAX_CARDS cards,
 *      checked against a deliberately different algorithm that tries every
 *      possible number of Aces counted as 11 and picks the best.
 *   3. Exhaustive card-level: every ordered 1-, 2-, and 3-card hand from the
 *      52 cards, so the rank->value mapping and order independence are checked
 *      on real card ints, not just values.
 *
 * Usage:  node test-blackjack.js
 */

'use strict';

const BJ = require('./blackjack-core.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  if (failures.length < 25) failures.push(`${name}\n    expected ${e}\n    got      ${a}`);
}

function throws(name, fn, ErrType) {
  try { fn(); } catch (e) {
    if (e instanceof ErrType) { passed++; return; }
    failed++; failures.push(`${name}: threw ${e.constructor.name}, expected ${ErrType.name}`); return;
  }
  failed++; failures.push(`${name}: did not throw`);
}

// ---------------------------------------------------------------------------
// Card construction. Written independently of cardValue() on purpose.
// ---------------------------------------------------------------------------

const RANK = { '2':0,'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'T':8,'J':9,'Q':10,'K':11,'A':12 };
const SUIT = { c:0, d:1, h:2, s:3 };

/** 'As' -> card int. Suit optional; defaults rotate so hands aren't all one suit. */
let suitRot = 0;
function card(s) {
  const r = RANK[s[0]];
  if (r === undefined) throw new Error('bad rank in ' + s);
  const su = s.length > 1 ? SUIT[s[1]] : (suitRot++ % 4);
  return su * 13 + r;
}
const hand = (str) => (str.trim() ? str.trim().split(/\s+/).map(card) : []);
const hv = (str) => BJ.handValue(hand(str));

const H17 = { hitSoft17: true };
const S17 = { hitSoft17: false };

// ---------------------------------------------------------------------------
// 1. Named cases
// ---------------------------------------------------------------------------

// Card values, every rank, every suit.
const EXPECT_VALUE = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':10,'Q':10,'K':10,'A':1 };
for (const r of Object.keys(RANK)) {
  for (const s of Object.keys(SUIT)) {
    check(`cardValue ${r}${s}`, BJ.cardValue(card(r + s)), EXPECT_VALUE[r]);
  }
}

const T = (total, soft) => ({ total, soft, bust: total > 21 });

const CASES = [
  // empty / single cards
  ['',                 T(0,  false)],
  ['A',                T(11, true )],
  ['K',                T(10, false)],

  // basic hard totals
  ['T 6',              T(16, false)],
  ['T 7',              T(17, false)],
  ['T 6 5',            T(21, false)],
  ['T 6 6',            T(22, false)],   // bust
  ['K Q J',            T(30, false)],   // bust, three faces

  // soft hands
  ['A 6',              T(17, true )],   // soft 17
  ['A 7',              T(18, true )],
  ['A 9',              T(20, true )],
  ['A 2 4',            T(17, true )],   // soft 17 built from three cards
  ['A 5 5',            T(21, true )],   // three-card soft 21

  // soft -> hard transitions (the classic bug)
  ['A 6 T',            T(17, false)],   // soft 17 + 10 = hard 17, NOT bust 27
  ['A 6 5',            T(12, false)],   // soft 17 + 5 = hard 12
  ['A 5 6',            T(12, false)],   // same cards, different order
  ['6 5 A',            T(12, false)],   // ace last
  ['A 9 A',            T(21, true )],   // soft 20 + A = soft 21
  ['A 9 2',            T(12, false)],
  ['A T',              T(21, true )],   // natural is a soft 21
  ['A T T',            T(21, false)],   // 1 + 10 + 10, ace forced to 1
  ['T T A',            T(21, false)],
  ['A T T A',          T(22, false)],   // bust even with every ace as 1

  // multiple aces
  ['A A',              T(12, true )],   // 11 + 1, never 22 and never 2
  ['A A A',            T(13, true )],
  ['A A A A',          T(14, true )],
  ['A A 9',            T(21, true )],
  ['A A T',            T(12, false)],
  ['A A A A 7',        T(21, true )],   // 4 + 7 = 11, one ace promoted
  ['A A A A 8',        T(12, false)],
  ['A A A A A A A A A A', T(20, true)], // 10 aces (multi-deck shoe): 10 + 10
  ['A A A A A A A A A A A', T(21, true)], // 11 aces: 11 + 10
  ['A A A A A A A A A A A A', T(12, false)], // 12 aces: 12, can't promote

  // longest legal 21s
  ['A A A A 2 2 2 2 3 3 3', T(21, false)], // 11 cards, single deck max
  ['2 2 2 2 3 3 3 A A A',   T(20, false)], // 17 + 3 aces as 1; promoting one = 30
  ['2 2 2 2 A A A',         T(21, true )], // 8 + 3 = 11, one ace promoted
];

for (const [h, exp] of CASES) {
  check(`handValue [${h}]`, hv(h), exp);
}

// Naturals
check('natural A K',                BJ.isNatural(hand('A K'), false), true);
check('natural K A (order)',        BJ.isNatural(hand('K A'), false), true);
check('natural A T',                BJ.isNatural(hand('A T'), false), true);
check('A K from split is not natural', BJ.isNatural(hand('A K'), true), false);
check('three-card 21 not natural',  BJ.isNatural(hand('7 7 7'), false), false);
check('A 5 5 not natural',          BJ.isNatural(hand('A 5 5'), false), false);
check('A A not natural',            BJ.isNatural(hand('A A'), false), false);
check('T T not natural',            BJ.isNatural(hand('T T'), false), false);
throws('isNatural without fromSplit throws', () => BJ.isNatural(hand('A K')), TypeError);

// Dealer draw rule
const DEALER = [
  // hand,        H17 hits, S17 hits
  ['T 6',         true,  true ],
  ['T 7',         false, false],   // hard 17 always stands
  ['A 6',         true,  false],   // soft 17: the H17/S17 difference
  ['A A 5',       true,  false],   // soft 17 with two aces
  ['A 2 4',       true,  false],   // soft 17 from three cards
  ['A A A A 3',   true,  false],   // soft 17 from four aces
  ['A 6 T',       false, false],   // hard 17 that used to be soft
  ['A 7',         false, false],   // soft 18 stands either way
  ['A 5',         true,  true ],   // soft 16 hits either way
  ['A A',         true,  true ],   // soft 12
  ['T 2',         true,  true ],
  ['T 6 6',       false, false],   // bust: nothing to draw for
  ['A T',         false, false],
];
for (const [h, hitH17, hitS17] of DEALER) {
  check(`dealer H17 [${h}]`, BJ.dealerShouldHit(hand(h), H17), hitH17);
  check(`dealer S17 [${h}]`, BJ.dealerShouldHit(hand(h), S17), hitS17);
}
throws('dealerShouldHit without rules throws', () => BJ.dealerShouldHit(hand('A 6')), TypeError);
throws('dealerShouldHit with non-boolean hitSoft17 throws',
  () => BJ.dealerShouldHit(hand('A 6'), { hitSoft17: 'yes' }), TypeError);

// Input validation
throws('card 52 rejected',   () => BJ.cardValue(52),  RangeError);
throws('card -1 rejected',   () => BJ.cardValue(-1),  RangeError);
throws('card 1.5 rejected',  () => BJ.cardValue(1.5), RangeError);
throws('card "5" rejected',  () => BJ.cardValue('5'), RangeError);
throws('non-array hand',     () => BJ.handValue(5),   TypeError);
throws('bad card in hand',   () => BJ.handValue([0, 99]), RangeError);

// ---------------------------------------------------------------------------
// 2. Exhaustive oracle over value multisets
// ---------------------------------------------------------------------------

/**
 * Independent oracle. Doesn't use the "at most one Ace can be 11" insight:
 * tries every count j of Aces counted as 11 (0..aces) and picks the best.
 */
function oracle(values) {
  let base = 0, aces = 0;
  for (const v of values) { if (v === 1) aces++; base += v; }
  let best = null, bestJ = 0;
  for (let j = 0; j <= aces; j++) {
    const t = base + 10 * j;            // j aces as 11, rest as 1
    if (t <= 21 && (best === null || t > best)) { best = t; bestJ = j; }
  }
  if (best === null) return { total: base, soft: false, bust: base > 21 };
  return { total: best, soft: bestJ > 0, bust: false };
}

// One representative card per value; tens rotate through T/J/Q/K and suits
// rotate so the multiset walk also exercises every rank and suit.
const TEN_RANKS = [8, 9, 10, 11];
let rot = 0;
function cardForValue(v) {
  const suit = rot % 4;
  let r;
  if (v === 1) r = 12;
  else if (v === 10) r = TEN_RANKS[(rot >> 2) % 4];
  else r = v - 2;
  rot++;
  return suit * 13 + r;
}

const MAX_CARDS = 12;
let multisets = 0;
const values = [];
(function walk(minV, depth) {
  if (depth > 0) {
    multisets++;
    const cards = values.map(cardForValue);
    check(`oracle [${values.join(',')}]`, BJ.handValue(cards), oracle(values));
    // Order independence: reversed and rotated.
    check(`reversed [${values.join(',')}]`, BJ.handValue(cards.slice().reverse()), oracle(values));
    check(`rotated [${values.join(',')}]`, BJ.handValue(cards.slice(1).concat(cards[0])), oracle(values));
  }
  if (depth === MAX_CARDS) return;
  for (let v = minV; v <= 10; v++) {
    values.push(v);
    walk(v, depth + 1);
    values.pop();
  }
})(1, 0);

// ---------------------------------------------------------------------------
// 3. Exhaustive card-level: every ordered 1-, 2-, 3-card hand
// ---------------------------------------------------------------------------

const valueOf = (c) => EXPECT_VALUE['23456789TJQKA'[c % 13]];
let ordered = 0;
for (let a = 0; a < 52; a++) {
  check(`card-level [${a}]`, BJ.handValue([a]), oracle([valueOf(a)]));
  ordered++;
  for (let b = 0; b < 52; b++) {
    check(`card-level [${a},${b}]`, BJ.handValue([a, b]), oracle([valueOf(a), valueOf(b)]));
    ordered++;
    for (let c = 0; c < 52; c++) {
      check(`card-level [${a},${b},${c}]`, BJ.handValue([a, b, c]),
        oracle([valueOf(a), valueOf(b), valueOf(c)]));
      ordered++;
    }
  }
}

// Natural frequency, single deck: 4 Aces x 16 ten-value cards out of C(52,2)
// two-card hands = 64/1326 = 4.8265%. Published figure: 4.83%.
let naturals = 0, pairs = 0;
for (let a = 0; a < 52; a++) {
  for (let b = a + 1; b < 52; b++) {
    pairs++;
    if (BJ.isNatural([a, b], false)) naturals++;
  }
}
check('single-deck naturals count', [naturals, pairs], [64, 1326]);

// ---------------------------------------------------------------------------
// 4. Engine scenarios on stacked shoes
//    Deal order is P, D(up), P, D(hole), then draws in order.
// ---------------------------------------------------------------------------

/** Play a scripted round. Returns the round. `available` = bankroll left. */
function play(ruleOverrides, shoeStr, bet, actions, available) {
  const rules = BJ.makeRules(ruleOverrides);
  const shoe = BJ.stackedShoe(hand(shoeStr));
  const round = BJ.startRound(shoe, bet, rules);
  for (const a of actions) BJ.act(round, shoe, a, available);
  round._shoe = shoe;
  return round;
}
const summary = (r) => ({
  phase: r.phase, wagered: r.wagered, returned: r.returned, net: r.net,
  outcomes: r.hands.map(h => h.outcome),
});
const scenario = (name, r, exp) => check(`scenario: ${name}`, summary(r), exp);
const done = (wagered, returned, outcomes) => ({ phase: 'done', wagered, returned, net: returned - wagered, outcomes });

// Naturals and the peek
scenario('player natural pays 3:2',
  play({}, 'A 9 K 7', 10, []), done(10, 25, ['blackjack']));
scenario('dealer natural (ten up) takes the bet, no decisions',
  play({}, '9 K 7 A', 10, []), done(10, 0, ['lose']));
scenario('both naturals push',
  play({}, 'A K Q A', 10, []), done(10, 10, ['push']));
scenario('6:5 table pays 6:5',
  play({ blackjackPays: [6, 5], betUnit: 10 }, 'A 9 K 7', 10, []), done(10, 22, ['blackjack']));

// Insurance
{
  const r = play({}, '9 A 7 K', 10, []);
  check('Ace up offers insurance', [r.phase, BJ.legalActions(r)], ['insurance', { insure: true, decline: true }]);
  check('insurance unaffordable', BJ.legalActions(r, 4).insure, false);
}
scenario('insurance wins vs dealer BJ: break even',
  play({}, '9 A 7 K', 10, ['insure']), done(15, 15, ['lose']));
scenario('insurance declined vs dealer BJ',
  play({}, '9 A 7 K', 10, ['decline']), done(10, 0, ['lose']));
scenario('insurance lost, then hand wins',
  play({}, 'T A T 6 9', 10, ['insure', 'stand']), done(15, 20, ['win']));   // dealer A6 = soft 17, stands S17
scenario('even money (insure a natural), dealer has BJ',
  play({}, 'A A K K', 10, ['insure']), done(15, 25, ['push']));             // +10 = even money
scenario('even money (insure a natural), dealer no BJ',
  play({}, 'A A K 9', 10, ['insure']), done(15, 25, ['blackjack']));        // +10 = even money
scenario('no insurance offered when rules disable it',
  play({ insurance: false }, '9 A 7 K', 10, []), done(10, 0, ['lose']));

// Hit / stand / double
scenario('hit to 21 auto-stands, dealer busts',
  play({}, '5 6 6 T K T', 10, ['hit']), done(10, 20, ['win']));   // P 5,6,K=21 ; D 6,T,T bust
scenario('player busts, dealer does not draw',
  play({}, 'T 6 6 T K 5', 10, ['hit']), done(10, 0, ['bust']));
{
  const r = play({}, 'T 6 6 T K 5', 10, ['hit']);
  check('dealer drew nothing after player bust', [r._shoe.pos, r.dealer.length], [5, 2]);
}
scenario('push on equal totals',
  play({}, 'T 7 7 T', 10, ['stand']), done(10, 10, ['push']));     // 17 v 17
scenario('double on 11, dealer busts',
  play({}, '6 6 5 T T T', 10, ['double']), done(20, 40, ['win']));       // P 6,5,T=21 ; D 6,T,T bust
scenario('double gets exactly one card',
  play({}, '2 T 3 7 2', 10, ['double']), done(20, 0, ['lose']));         // P 2,3,2=7 ; D T7=17
{
  const r = play({}, '6 6 5 T', 10, []);
  check('double unaffordable', BJ.legalActions(r, 9).double, false);
  check('double affordable',   BJ.legalActions(r, 10).double, true);
}
{
  const r = play({}, '2 T 3 7 4', 10, ['hit']);
  check('no double after hitting', BJ.legalActions(r).double, false);
}
{
  const r = play({ doubleOn: '10-11' }, '5 T 4 7', 10, []);
  check('doubleOn 10-11 refuses 9', BJ.legalActions(r).double, false);
}

// Dealer soft 17
scenario('S17: dealer stands on A6',
  play({ hitSoft17: false }, 'T 6 8 A 2', 10, ['stand']), done(10, 20, ['win']));   // P 18 vs 17
scenario('H17: dealer hits A6, makes 19',
  play({ hitSoft17: true }, 'T 6 8 A 2', 10, ['stand']), done(10, 0, ['lose']));    // A6+2 = 19

// Splits
scenario('split 8s: one wins, one loses',
  play({}, '8 T 8 7 T 3', 10, ['split', 'stand', 'stand']),
  done(20, 20, ['win', 'lose']));                        // 8,T=18 wins ; 8,3=11 loses to 17
{
  const r = play({}, '8 T 8 7 T 3', 10, ['split', 'stand', 'stand']);
  check('split hands get cards in order', r.hands.map(h => BJ.handValue(h.cards).total), [18, 11]);
}
scenario('double after split',
  play({}, '8 6 8 T 3 T 9 T', 10, ['split', 'double', 'stand']),
  done(30, 60, ['win', 'win']));                         // 8,3+T=21 (dbl) ; 8,9=17 ; dealer 6,T,T bust
{
  const r = play({ doubleAfterSplit: false }, '8 6 8 T 3', 10, ['split']);
  check('no DAS: double refused on split hand', BJ.legalActions(r).double, false);
}
scenario('split Aces get one card each; A+K after split is 21, pays 1:1',
  play({}, 'A 9 A 7 K 5 2', 10, ['split']),
  done(20, 20, ['win', 'lose']));                        // A,K=21 wins 1:1 ; A,5=16 loses to dealer 9,7,2=18
{
  const r = play({}, 'A 9 A 8 K 5', 10, ['split']);
  check('split aces: both hands done without decisions', [r.phase, r.hands.map(h => h.cards.length)], ['done', [2, 2]]);
  check('split aces: A+K is not a blackjack', r.hands[0].outcome, 'win');
  check('split aces: A+K returns 1:1', r.hands[0].returned, 20);
}
{
  const r = play({ resplitAces: false }, 'A 9 A 8 A 5', 10, ['split']);
  check('no RSA: A,A after split is just soft 12 and done', [r.phase, r.hands.length], ['done', 2]);
}
{
  const r = play({ resplitAces: true }, 'A 9 A 8 A 5 6 7', 10, ['split']);
  check('RSA: A,A after split may resplit or stand only', BJ.legalActions(r), { hit: false, stand: true, double: false, split: true });
  BJ.act(r, r._shoe, 'split');
  check('RSA: three hands after resplit', r.hands.length, 3);
}
{
  const r = play({ hitSplitAces: true }, 'A 9 A 8 5 5', 10, ['split']);
  check('hitSplitAces: split ace may hit', BJ.legalActions(r).hit, true);
}
{
  // 8,8 split three times = 4 hands; the next 8 can't be split.
  const r = play({ maxHands: 4 }, '8 T 8 7 8 8 8 8', 10, ['split', 'split', 'split']);
  check('resplit to 4 hands', r.hands.length, 4);
  check('no split beyond maxHands', BJ.legalActions(r).split, false);
  check('wagered = 4 hands', r.wagered, 40);
}
{
  const r = play({}, '8 T 8 7', 10, []);
  check('split unaffordable', BJ.legalActions(r, 9).split, false);
}
{
  const r = play({}, 'K T Q 7', 10, []);
  check('mixed tens (K,Q) may split', BJ.legalActions(r).split, true);
}
{
  const r = play({}, 'K T 9 7', 10, []);
  check('non-pair may not split', BJ.legalActions(r).split, false);
}
scenario('all split hands bust: dealer does not draw',
  play({}, '8 T 8 6 6 T 6 T', 10, ['split', 'hit', 'hit']),   // 8,6+T ; 8,6+T
  done(20, 0, ['bust', 'bust']));

// Illegal actions and validation
{
  const r = play({}, 'A 9 A 8 K 5', 10, ['split']);
  throws('act after round done', () => BJ.act(r, r._shoe, 'hit'), Error);
}
{
  const r = play({}, 'T 9 7 8', 10, []);
  throws('split a non-pair', () => BJ.act(r, BJ.stackedShoe([]), 'split'), Error);
  throws('unknown action',   () => BJ.act(r, BJ.stackedShoe([]), 'surrender'), Error);
}
throws('odd bet rejected',   () => play({}, 'T 9 7 8', 11, []), RangeError);
throws('zero bet rejected',  () => play({}, 'T 9 7 8', 0, []), RangeError);
throws('6:5 with betUnit 2 rejected', () => BJ.makeRules({ blackjackPays: [6, 5] }), RangeError);
throws('insurance with odd betUnit rejected', () => BJ.makeRules({ betUnit: 5, blackjackPays: [1, 1] }), RangeError);
throws('bad doubleOn rejected', () => BJ.makeRules({ doubleOn: 'soft' }), RangeError);
throws('decks 0 rejected', () => BJ.makeRules({ decks: 0 }), RangeError);
throws('stacked shoe exhausted', () => play({}, 'T 9 7', 10, []), Error);

// Basic strategy spot checks (6D S17 DAS unless noted)
const bs = (ov, s) => BJ.basicStrategy(play(ov, s, 10, []));
check('BS 16 v T hits',       bs({}, 'T T 6 7'), 'hit');
check('BS 12 v 4 stands',     bs({}, 'T 4 2 7'), 'stand');
check('BS 11 v A: S17 hits',  bs({ insurance: false }, '6 A 5 7'), 'hit');
check('BS 11 v A: H17 dbl',   bs({ insurance: false, hitSoft17: true }, '6 A 5 7'), 'double');
check('BS A7 v 2: S17 stand', bs({}, 'A 2 7 7'), 'stand');
check('BS A7 v 2: H17 dbl',   bs({ hitSoft17: true }, 'A 2 7 7'), 'double');
check('BS 8,8 v T splits',    bs({}, '8 T 8 7'), 'split');
check('BS T,T v 6 stands',    bs({}, 'T 6 T 7'), 'stand');
check('BS 9,9 v 7 stands',    bs({}, '9 7 9 7'), 'stand');
check('BS 4,4 v 5 DAS split', bs({}, '4 5 4 7'), 'split');
check('BS 4,4 v 5 noDAS hit', bs({ doubleAfterSplit: false }, '4 5 4 7'), 'hit');
check('BS declines insurance', bs({}, 'T A 9 7'), 'decline');

// ---------------------------------------------------------------------------
// 4b. Free Bet scenarios (Wizard of Odds standard Free Bet rules)
// ---------------------------------------------------------------------------

const FB = { hitSoft17: true, resplitAces: true, push22: true, freeDoubles: true, freeSplits: true };
const stakes = (r) => r.hands.map(h => [h.bet, h.free]);

{
  const r = play(FB, '6 6 5 T T T', 10, ['double']);   // P 6,5 free-dbl T=21 ; D 6,T,T=26 bust
  scenario('FB: free double on 11 wins on 20 for a 10 stake', r, done(10, 30, ['win']));
  check('FB: free double stakes [own, free]', stakes(r), [[10, 10]]);
}
scenario('FB: free double that loses costs only the original bet',
  play(FB, '2 T 7 7 2', 10, ['double']), done(10, 0, ['lose']));           // 2,7+2=11 vs 17
{
  const r = play(FB, 'A 6 8 T', 10, []);                                    // soft 19: not free
  check('FB: soft hand double is not free', [BJ.freeOffers(r).double, BJ.legalActions(r, 9).double], [false, false]);
}
{
  const r = play(FB, '6 6 5 T', 10, []);
  check('FB: free double needs no bankroll', BJ.legalActions(r, 0).double, true);
  const r2 = play(FB, '8 T 8 7', 10, []);
  check('FB: free split needs no bankroll', BJ.legalActions(r2, 0).split, true);
}
{
  const r = play(FB, '8 T 8 7 T 3', 10, ['split', 'stand', 'stand']);     // 8,T=18 win ; 8,3=11 lose
  scenario('FB: free split, real hand wins, free hand loses', r, done(10, 20, ['win', 'lose']));
  check('FB: free split stakes', stakes(r), [[10, 0], [0, 10]]);
}
scenario('FB: free split, free hand wins real chips',
  play(FB, '8 T 8 7 3 T', 10, ['split', 'stand', 'stand']), done(10, 10, ['lose', 'win']));
{
  const r = play(FB, 'K 7 Q 7', 10, []);
  check('FB: tens split is not free', [BJ.freeOffers(r).split, BJ.legalActions(r, 9).split], [false, false]);
  BJ.act(r, BJ.stackedShoe(hand('9 9')), 'split');
  check('FB: tens split costs a full bet', [r.wagered, stakes(r)], [20, [[10, 0], [10, 0]]]);
}
{
  const r = play(FB, 'T 6 8 6 T', 10, ['stand']);                          // 18 vs dealer 6,6,T=22
  scenario('FB: dealer 22 pushes a live hand', r, done(10, 10, ['push']));
  check('FB: dealer22Push flag', r.dealer22Push, true);
}
scenario('FB: dealer 22 pushes the free hand too (free chip goes back)',
  play(FB, '8 6 8 6 T T T', 10, ['split', 'stand', 'stand']), done(10, 10, ['push', 'push']));
scenario('FB: busted hand still loses when dealer makes 22',
  play(FB, '8 6 8 6 6 T T T', 10, ['split', 'hit', 'stand']), done(10, 0, ['bust', 'push']));
scenario('FB: dealer 23 is an ordinary bust',
  play(FB, 'T 6 8 7 T', 10, ['stand']), done(10, 20, ['win']));            // 6,7,T = 23
scenario('FB: player blackjack pays 3:2 before the dealer can make 22',
  play(FB, 'A 6 K 6', 10, []), done(10, 25, ['blackjack']));
{
  // Free split 6s, then free-double both 11s: own 10 at risk, 40 profit.
  const r = play(FB, '6 T 6 7 5 T 5 T', 10, ['split', 'double', 'double']);
  scenario('FB: free double on a free split hand', r, done(10, 50, ['win', 'win']));
  check('FB: stakes after split + two free doubles', stakes(r), [[10, 10], [0, 20]]);
}
{
  // Paid double on a free hand: player adds own chips to a free hand.
  const r = play(FB, '8 5 8 T 7 A 3 T', 10, ['split', 'stand', 'double']); // h1 8,7 ; h2 8,A soft 19 -> paid double
  check('FB: paid double on a free hand', [r.wagered, stakes(r)], [20, [[10, 0], [10, 10]]]);
}
check('FB: no free split offered on a non-pair', BJ.freeOffers(play(FB, '6 T 2 7', 10, [])), { double: false, split: false });
check('FB: no free double offered after a hit', BJ.freeOffers(play(FB, '2 T 3 7 4', 10, ['hit'])).double, false);
check('FB: free split and double both offered on 5,5? split yes, double yes',
  BJ.freeOffers(play(FB, '5 7 5 7', 10, [])), { double: true, split: true });
check('FB: no free offers in classic rules', BJ.freeOffers(play({}, '5 7 5 7', 10, [])), { double: false, split: false });
scenario('push22 off: dealer 22 is a bust like any other',
  play({}, 'T 6 8 6 T', 10, ['stand']), done(10, 20, ['win']));

// Free Bet basic strategy spot checks
check('FB BS 5,5 v 6 doubles, not split', bs(FB, '5 6 5 7'), 'double');
check('FB BS T,T v 6 stands',            bs(FB, 'T 6 T 7'), 'stand');
check('FB BS 4,4 v 2 free-splits',       bs(FB, '4 2 4 7'), 'split');
check('FB BS 16 v T hits (no surrender)', bs(FB, 'T T 6 7'), 'hit');
check('FB BS 14 v 2 real hand stands',   bs(FB, 'T 2 4 7'), 'stand');
{
  // 8,8 v A: split; real 17 stands, free 17 hits (push is as bad as a loss on a free hand).
  const r = play(FB, '8 A 8 7 9 9 T', 10, ['decline', 'split']);
  check('FB BS real 17 v A stands', BJ.basicStrategy(r), 'stand');
  BJ.act(r, r._shoe, 'stand');
  check('FB BS free 17 v A hits', BJ.basicStrategy(r), 'hit');
}

// ---------------------------------------------------------------------------
// 4c. Side bets: categories vs an independent oracle, then payouts in rounds
// ---------------------------------------------------------------------------

// Independent categorizers, written differently from the core on purpose:
// rank histograms and an explicit list of the 12 legal straights.
const STRAIGHTS = new Set();
for (let lo = 0; lo <= 10; lo++) STRAIGHTS.add([lo, lo + 1, lo + 2].join());   // 2-3-4 .. Q-K-A
STRAIGHTS.add([0, 1, 12].join());                                               // A-2-3
function oraclePP(a, b) {
  const ra = a % 13, rb = b % 13, sa = Math.floor(a / 13), sb = Math.floor(b / 13);
  if (ra !== rb) return null;
  if (sa === sb) return 'perfect';
  const colour = s => (s === 0 || s === 3 ? 'black' : 'red');
  return colour(sa) === colour(sb) ? 'colored' : 'mixed';
}
function oracle21p3(a, b, c) {
  const ranks = [a % 13, b % 13, c % 13].sort((x, y) => x - y);
  const suits = new Set([a, b, c].map(x => Math.floor(x / 13)));
  const distinct = new Set(ranks).size;
  const suited = suits.size === 1;
  if (distinct === 1) return suited ? 'suitedTrips' : 'trips';
  if (distinct === 3 && STRAIGHTS.has(ranks.join())) return suited ? 'straightFlush' : 'straight';
  return suited ? 'flush' : null;
}
let sideCombos = 0;
for (let a = 0; a < 52; a++) for (let b = 0; b < 52; b++) {
  const got = BJ.perfectPairsHand(a, b), want = oraclePP(a, b);
  if (got !== want) check(`PP [${a},${b}]`, got, want); else passed++;
  sideCombos++;
  for (let c = 0; c < 52; c++) {
    const g3 = BJ.twentyOnePlus3Hand(a, b, c), w3 = oracle21p3(a, b, c);
    if (g3 !== w3) check(`21+3 [${a},${b},${c}]`, g3, w3); else passed++;
    sideCombos++;
  }
}
check('21+3: K-A-2 is not a straight', BJ.twentyOnePlus3Hand(card('Kh'), card('As'), card('2d')), null);
check('21+3: A-2-3 is a straight',     BJ.twentyOnePlus3Hand(card('Ah'), card('2s'), card('3d')), 'straight');
check('21+3: Q-K-A is a straight',     BJ.twentyOnePlus3Hand(card('Qh'), card('Ks'), card('Ad')), 'straight');
check('PP: red/red is colored',        BJ.perfectPairsHand(card('8h'), card('8d')), 'colored');

// Paytable fallback: a missing category pays as the best one it contains.
check('pays: suited trips without a line pay as trips', BJ.sideBetPays({ trips: 20, flush: 5 }, 'suitedTrips'), 20);
check('pays: straight flush without a line pays as straight', BJ.sideBetPays({ straight: 10, flush: 5 }, 'straightFlush'), 10);
check('pays: no category = 0', BJ.sideBetPays({ flush: 5 }, null), 0);

const SB = { perfectPairs: { perfect: 25, colored: 12, mixed: 6 },
             twentyOnePlus3: { suitedTrips: 100, straightFlush: 40, trips: 30, straight: 10, flush: 5 } };
function playSide(ruleOverrides, shoeCards, bet, side, actions) {
  const rules = BJ.makeRules(Object.assign({}, SB, ruleOverrides));
  const shoe = BJ.stackedShoe(shoeCards.map(card));
  const r = BJ.startRound(shoe, bet, rules, { side });
  for (const a of actions) BJ.act(r, shoe, a);
  return r;
}
const sideSummary = r => Object.fromEntries(Object.entries(r.side).map(([k, v]) => [k, [v.outcome, v.returned]]));
{
  // P: 8h 8h (two of the same card from a 6-deck shoe); D: 9c up. Player stands on 16, dealer 9,8 = 17.
  const r = playSide({}, ['8h', '9c', '8h', '8s'], 10, { perfectPairs: 10, twentyOnePlus3: 10 }, ['stand']);
  check('side: perfect pair 25:1, 21+3 nothing', sideSummary(r), { perfectPairs: ['perfect', 260], twentyOnePlus3: [null, 0] });
  check('side: chips (10 main lost, 260 PP back, 10 21+3 lost)', [r.wagered, r.returned, r.net], [30, 260, 230]);
}
{
  // 21+3 suited trips: 7h 7h + dealer 7h up.
  const r = playSide({}, ['7h', '7h', '7h', 'Ts'], 10, { twentyOnePlus3: 5 }, ['stand']);
  check('side: suited trips 100:1', sideSummary(r), { twentyOnePlus3: ['suitedTrips', 505] });
}
{
  // Side bets still pay when the dealer has blackjack and the round ends at once.
  const r = playSide({}, ['5d', 'Ks', '5s', 'Ac'], 10, { perfectPairs: 10 }, []);
  check('side: pays even when dealer has blackjack', [r.phase, sideSummary(r), r.returned], ['done', { perfectPairs: ['mixed', 70] }, 70]);
}
{
  // Ace up: side bets are already decided during the insurance decision.
  const r = playSide({}, ['Qs', 'As', 'Kh', '9d'], 10, { twentyOnePlus3: 10 }, []);
  check('side: decided at deal, before insurance', [r.phase, r.side.twentyOnePlus3.outcome], ['insurance', 'straight']);
  const empty = BJ.stackedShoe([]);
  BJ.act(r, empty, 'decline');
  BJ.act(r, empty, 'stand');                    // Q,K = 20 vs dealer A,9 = soft 20: push
  check('side: straight paid at settlement', [r.phase, r.returned, r.net], ['done', 10 + 110, 100]);
}
throws('side bet not offered at this table', () => BJ.startRound(BJ.stackedShoe(hand('T 9 7 8')), 10, BJ.makeRules({}), { side: { perfectPairs: 10 } }), RangeError);
throws('negative side bet rejected', () => playSide({}, ['T', '9', '7', '8'], 10, { perfectPairs: -5 }, []), RangeError);
throws('unknown side bet rejected', () => playSide({}, ['T', '9', '7', '8'], 10, { luckyLadies: 5 }, []), RangeError);
throws('paytable with unknown category rejected', () => BJ.makeRules({ perfectPairs: { royal: 50 } }), RangeError);

// ---------------------------------------------------------------------------
// 5. Fuzz: random legal play under random rules, checked against an
//    independent settlement oracle and chip/card conservation.
// ---------------------------------------------------------------------------

function oracleReturn(round, h) {
  // Independent restatement of the payout rules.
  const best = (cs) => {
    let t = 0, a = 0;
    for (const c of cs) { const r = c % 13; t += r === 12 ? 1 : r >= 8 ? 10 : r + 2; if (r === 12) a++; }
    return a && t + 10 <= 21 ? t + 10 : t;
  };
  const p = best(h.cards), d = best(round.dealer);
  const pNat = h.cards.length === 2 && p === 21 && round.hands.length === 1 && !h.fromSplit;
  const dNat = round.dealer.length === 2 && d === 21;
  const [n, den] = round.rules.blackjackPays;
  const inAction = h.bet + h.free;          // own + free chips
  if (dNat) return pNat ? h.bet : 0;
  if (pNat) return h.bet + h.bet * n / den;
  if (p > 21) return 0;
  if (round.rules.push22 && d === 22) return h.bet;   // free chips go back to the house
  if (d > 21 || p > d) return h.bet + inAction;
  return p === d ? h.bet : 0;
}

const FUZZ_ROUNDS = 200000;
let fuzzReshuffles = 0, fuzzSplitHands = 0;
{
  let x = 12345;   // deterministic choice stream (the shoe itself uses crypto)
  const rnd = (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % n; };
  let rules = null, shoe = null;
  for (let i = 0; i < FUZZ_ROUNDS; i++) {
    if (i % 2000 === 0) {
      rules = BJ.makeRules({
        decks: [1, 2, 6, 8][rnd(4)], penetration: [0.5, 0.75, 0.95][rnd(3)],
        hitSoft17: !!rnd(2), insurance: !!rnd(2), doubleAfterSplit: !!rnd(2),
        doubleOn: ['any', '9-11', '10-11'][rnd(3)], maxHands: 1 + rnd(4),
        resplitAces: !!rnd(2), hitSplitAces: !!rnd(2),
        push22: !!rnd(2), freeDoubles: !!rnd(2), freeSplits: !!rnd(2),
        perfectPairs: rnd(2) ? SB.perfectPairs : null, twentyOnePlus3: rnd(2) ? SB.twentyOnePlus3 : null,
      });
      shoe = BJ.newShoe(rules);
    }
    if (BJ.needsShuffle(shoe)) shoe = BJ.newShoe(rules);
    const bet = 2 * (1 + rnd(50));
    let bank = bet * (rnd(4) === 0 ? 1 + rnd(3) : 100);   // sometimes too poor to double/split
    const side = {};
    if (rules.perfectPairs && rnd(2)) side.perfectPairs = 1 + rnd(20);
    if (rules.twentyOnePlus3 && rnd(2)) side.twentyOnePlus3 = 1 + rnd(20);
    const sideTotal = (side.perfectPairs || 0) + (side.twentyOnePlus3 || 0);
    bank += sideTotal;          // the player can always afford what they bet at deal...
    bank -= bet + sideTotal;    // ...and pays it up front, like bjDeal does
    const posBefore = shoe.pos;
    const r = BJ.startRound(shoe, bet, rules, { side });
    const first = r.hands[0].cards.slice();   // before any split changes hand 0
    let guard = 0;
    while (r.phase !== 'done') {
      const legal = BJ.legalActions(r, bank);
      const opts = Object.keys(legal).filter(k => legal[k]);
      const a = rnd(3) === 0 ? BJ.basicStrategy(r, bank) : opts[rnd(opts.length)];
      const w = r.wagered;
      BJ.act(r, shoe, a, bank);
      bank -= r.wagered - w;
      if (bank < 0) { check('fuzz: bankroll went negative', bank, '>= 0'); break; }
      if (++guard > 100) { check('fuzz: round terminates', guard, '<= 100'); break; }
    }
    // Chips
    const handBets = r.hands.reduce((s, h) => s + h.bet, 0);
    if (r.wagered !== handBets + r.insurance + sideTotal) {
      check(`fuzz ${i}: wagered = bets + insurance + side bets`, r.wagered, handBets + r.insurance + sideTotal);
    }
    let oracleTotal = r.dealerBlackjack ? r.insurance * 3 : 0;
    if (side.perfectPairs) {
      const cat = oraclePP(first[0], first[1]);
      oracleTotal += cat ? side.perfectPairs * (SB.perfectPairs[cat] + 1) : 0;
    }
    if (side.twentyOnePlus3) {
      const cat = oracle21p3(first[0], first[1], r.dealer[0]);
      oracleTotal += cat ? side.twentyOnePlus3 * (SB.twentyOnePlus3[cat] + 1) : 0;
    }
    for (const h of r.hands) {
      const o = oracleReturn(r, h);
      oracleTotal += o;
      if (h.returned !== o) check(`fuzz ${i}: hand return vs oracle`, h.returned, o);
    }
    if (r.returned !== oracleTotal) check(`fuzz ${i}: round return vs oracle`, r.returned, oracleTotal);
    if (r.net !== r.returned - r.wagered) check(`fuzz ${i}: net`, r.net, r.returned - r.wagered);
    // Cards: every card on the table came off the shoe, none invented.
    const table = r.dealer.length + r.hands.reduce((s, h) => s + h.cards.length, 0);
    if (r.midRoundReshuffle) fuzzReshuffles++;
    else if (shoe.pos - posBefore !== table) check(`fuzz ${i}: cards drawn = cards on table`, shoe.pos - posBefore, table);
    const seen = new Array(52).fill(0);
    for (const c of r.dealer.concat(...r.hands.map(h => h.cards))) seen[c]++;
    if (seen.some(n => n > rules.decks)) check(`fuzz ${i}: no card exceeds deck count`, seen, 'each <= decks');
    // Structural: split hands never exceed maxHands; split aces never have >2 cards unless hittable.
    if (r.hands.length > rules.maxHands) check(`fuzz ${i}: hands <= maxHands`, r.hands.length, rules.maxHands);
    for (const h of r.hands) {
      if (h.splitAces && !rules.hitSplitAces && h.cards.length !== 2) check(`fuzz ${i}: split ace got one card`, h.cards.length, 2);
      if (h.free < 0 || h.bet < 0) check(`fuzz ${i}: no negative stakes`, [h.bet, h.free], '>= 0');
      if (h.free > 0 && !rules.freeDoubles && !rules.freeSplits) check(`fuzz ${i}: free chips only under Free Bet rules`, h.free, 0);
      if (h.bet + h.free === 0) check(`fuzz ${i}: every hand has something in action`, h.bet + h.free, '> 0');
    }
    if (r.hands.length > 1) fuzzSplitHands += r.hands.length;
    passed++;
  }
}

// ---------------------------------------------------------------------------

console.log(`side-bet categories:      ${sideCombos.toLocaleString()} ordered pairs + triples vs independent oracle`);
console.log(`fuzz rounds:              ${FUZZ_ROUNDS.toLocaleString()} (${fuzzSplitHands.toLocaleString()} split hands, ${fuzzReshuffles} mid-round reshuffles)`);
console.log(`value multisets checked:  ${multisets.toLocaleString()} (1..${MAX_CARDS} cards, x3 orderings)`);
console.log(`ordered card hands:       ${ordered.toLocaleString()} (all 1-, 2-, 3-card)`);
console.log(`single-deck naturals:     ${naturals}/${pairs} = ${(100 * naturals / pairs).toFixed(4)}%`);
console.log('');
if (failed) {
  console.log(`FAIL  ${failed.toLocaleString()} failed, ${passed.toLocaleString()} passed`);
  for (const f of failures) console.log('  - ' + f);
  if (failed > failures.length) console.log(`  ... and ${failed - failures.length} more`);
  process.exit(1);
}
console.log(`PASS  ${passed.toLocaleString()} checks`);
