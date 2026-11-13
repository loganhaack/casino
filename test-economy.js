#!/usr/bin/env node
/*
 * Economy tests.
 *
 *   1. economy.js unit tests: ranks, bet ladder, wheels, events, quests, shop.
 *   2. Wheel fairness: 1M crypto spins per wheel vs the published weights.
 *   3. THE DEAL IS INDIFFERENT TO WHO YOU ARE: two copies of the real page,
 *      same RNG seed, one a broke level-1 player on a quiet day and one a rich
 *      Diamond during an event, make identical decisions. Every game result
 *      must be identical. Only economy extras (XP, quests, promos) may differ.
 *   4. Ledger: a long simulated session through the real page (fake clock,
 *      every game, wheels, rescue, shop, admin, reloads mid-hand) where the
 *      bankroll must reconcile to the chip exactly after every step.
 *
 * Usage:  node test-economy.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ECON = require('./economy.js');
const BJ = require('./blackjack-core.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return true; }
  failed++;
  if (failures.length < 30) failures.push(`${name}\n    expected ${e}\n    got      ${a}`);
  return false;
}
const ok = (name, cond) => check(name, !!cond, true);

// ---------------------------------------------------------------------------
// 1. Unit tests
// ---------------------------------------------------------------------------

// Ranks
check('level 1 at 0 XP', ECON.levelFromXp(0), { level: 1, into: 0, need: 300 });
check('level 2 at 300 XP', ECON.levelFromXp(300).level, 2);
check('level 2 needs 400 more', ECON.levelFromXp(300).need, 400);
check('Diamond (Lv 35) takes 66,300 XP', Array.from({ length: 34 }, (_, i) => ECON.xpToNext(i + 1)).reduce((a, b) => a + b), 66300);
{
  let xp = 0, mono = true;
  for (let L = 1; L < 60; L++) {
    const at = ECON.levelFromXp(xp), before = ECON.levelFromXp(xp - 1);
    if (at.level !== L || (xp > 0 && before.level !== L - 1)) mono = false;
    xp += ECON.xpToNext(L);
  }
  ok('levelFromXp inverts xpToNext for levels 1-59', mono);
}
check('round XP at the minimum bet', ECON.xpForRound(10, 10), 10);
check('round XP at 4x the minimum', ECON.xpForRound(40, 10), 14);
check('round XP caps at 20 however big the bet', ECON.xpForRound(10 * 1e6, 10), 20);
ok('round XP never below 10 (tiny or zero wager)', ECON.xpForRound(0, 10) === 10);
check('tiers by level', [1, 4, 5, 9, 10, 19, 20, 34, 35, 99].map(ECON.tierIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
ok('top tier multiplier is modest (no runaway gap)', ECON.TIERS[ECON.TIERS.length - 1].mult <= 2.5);

// Bet ladder
{
  const o = { min: 10, max: 2500, multipleOf: 10 };
  let b = 10, seen = [b];
  for (let i = 0; i < 60; i++) { b = ECON.stepBet(b, 1, o); seen.push(b); }
  ok('ladder up never exceeds max', seen.every(v => v <= 2500));
  ok('ladder up reaches max', seen.includes(2500));
  ok('ladder respects multipleOf', seen.every(v => v % 10 === 0));
  ok('ladder is non-decreasing going up', seen.every((v, i) => i === 0 || v >= seen[i - 1]));
  let d = 2500;
  for (let i = 0; i < 60; i++) d = ECON.stepBet(d, -1, o);
  check('ladder down stops at min', d, 10);
  check('ladder with allowZero goes to 0', ECON.stepBet(5, -1, { min: 5, max: 500, multipleOf: 5, allowZero: true }), 0);
  check('ladder from 0 goes to min', ECON.stepBet(0, 1, { min: 5, max: 500, multipleOf: 5, allowZero: true }), 5);
  check('ladder clamps an over-limit bet down', ECON.stepBet(9000, -1, o), 2500);
}

// Wheels: exact EV by hand
check('bonus wheel total weight', ECON.wheelTotal(ECON.WHEELS.bonus), 200);
check('bonus wheel EV at tier 1', ECON.wheelEV(ECON.WHEELS.bonus, 1), 80);
check('rescue wheel EV', ECON.wheelEV(ECON.WHEELS.rescue, 1), 47.5);
ok('rescue wheel minimum prize covers two minimum blackjack bets', Math.min(...ECON.WHEELS.rescue.slices.map(s => s.chips)) >= 20);
ok('every slice prize is a whole number at every tier (x lucky)',
  ECON.TIERS.every(t => [1, 2].every(l => ECON.WHEELS.bonus.slices.every(s => Number.isInteger(ECON.slicePrize(s, t.mult * l))))));
{
  // spinWheel maps every raw draw to the right slice
  const w = ECON.WHEELS.bonus, total = ECON.wheelTotal(w);
  const counts = new Array(w.slices.length).fill(0);
  for (let x = 0; x < total; x++) counts[ECON.spinWheel(w, () => x)]++;
  check('spinWheel: each slice gets exactly its weight of raw draws', counts, w.slices.map(s => s.weight));
}

// Events: find one date per weekday and check the schedule
function dateOnWeekday(dow, hour) {
  const d = new Date(2026, 10, 1, hour);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return d;
}
check('Monday: Quest Rush', ECON.activeEvents(dateOnWeekday(1, 10)).map(e => e.id), ['questRush']);
check('Tuesday: nothing', ECON.activeEvents(dateOnWeekday(2, 10)).map(e => e.id), []);
check('Wednesday: Double XP', ECON.activeEvents(dateOnWeekday(3, 10)).map(e => e.id), ['doubleXp']);
check('Friday 5pm: not yet Bonanza', ECON.activeEvents(dateOnWeekday(5, 17)).map(e => e.id), []);
check('Friday 6pm: Bonanza', ECON.activeEvents(dateOnWeekday(5, 18)).map(e => e.id), ['bonanza']);
check('Saturday: Lucky Wheel', ECON.activeEvents(dateOnWeekday(6, 3)).map(e => e.id), ['luckyWheel']);
check('Sunday: Big Hand', ECON.activeEvents(dateOnWeekday(0, 23)).map(e => e.id), ['bigHand']);
{
  const t = dateOnWeekday(2, 12), up = ECON.upcomingEvents(t, 5);
  ok('upcoming events are in the future and sorted', up.every((u, i) => u.start > t && (i === 0 || u.start >= up[i - 1].start)));
  check('upcoming from Tuesday noon starts with Wednesday Double XP', up[0].event.id, 'doubleXp');
}
// Promos
const fri = dateOnWeekday(5, 20), tue = dateOnWeekday(2, 20), sun = dateOnWeekday(0, 12);
check('Bonanza: natural on 100 pays 20 promo', ECON.promoFor({ game: 'bj', natural: true, mainBet: 100 }, fri).total, 20);
check('Bonanza: capped at 1,000', ECON.promoFor({ game: 'fb', natural: true, mainBet: 100000 }, fri).total, 1000);
check('Bonanza: nothing on Tuesday', ECON.promoFor({ game: 'bj', natural: true, mainBet: 100 }, tue).total, 0);
check('Bonanza: nothing without a natural', ECON.promoFor({ game: 'bj', natural: false, mainBet: 100 }, fri).total, 0);
check('Bonanza: not for TCP', ECON.promoFor({ game: 'tcp', natural: true, mainBet: 100 }, fri).total, 0);
check('Big Hand: trips on 20 Pair Plus pays 60', ECON.promoFor({ game: 'tcp', pairPlusBig: true, pairPlusBet: 20 }, sun).total, 60);
check('Big Hand: capped at 2,500', ECON.promoFor({ game: 'tcp', pairPlusBig: true, pairPlusBet: 5000 }, sun).total, 2500);
check('Lucky Wheel halves cooldown, doubles prizes', ECON.bonusWheelNow(dateOnWeekday(6, 9), 2),
  { cooldownMs: 3 * 3600000, mult: 3 });
check('Quest Rush doubles quest chips', [ECON.questReward(1, dateOnWeekday(1, 9)).chips, ECON.questReward(1, tue).chips], [250, 125]);

// Vault
{
  const v = { balance: 0, day: '', minToday: 0 };
  check('vault: first look just opens the day', ECON.vaultAccrue(v, '2026-03-02', 0), 0);
  ECON.vaultMove(v, 4000);
  check('vault: deposit today earns nothing at midnight', ECON.vaultAccrue(v, '2026-03-03', 0), 0);
  check('vault: held a full day earns 1%', ECON.vaultAccrue(v, '2026-03-04', 0), 40);
  check('vault: interest stays in the vault', v.balance, 4040);
  ECON.vaultMove(v, -4000);
  ECON.vaultMove(v, 4000);
  check('vault: withdraw + redeposit same day earns on the low point', ECON.vaultAccrue(v, '2026-03-05', 0), 0);
  check('vault: capped per day (50 at Bronze)', ECON.vaultInterest(1e9, 0), 50);
  check('vault: cap scales with tier (125 at Diamond)', ECON.vaultInterest(1e9, 4), 125);
  const w = { balance: 1000, day: '2026-03-01', minToday: 1000 };
  check('vault: away three days compounds, day by day', ECON.vaultAccrue(w, '2026-03-04', 0), 10 + 10 + 10);
  const y = { balance: 1000, day: '2026-12-31', minToday: 1000 };
  check('vault: works across a year boundary', ECON.vaultAccrue(y, '2027-01-01', 0), 10);
  let threw = 0;
  try { ECON.vaultMove({ balance: 5, day: 'x', minToday: 5 }, -6); } catch (e) { threw++; }
  try { ECON.vaultMove({ balance: 5, day: 'x', minToday: 5 }, 1.5); } catch (e) { threw++; }
  check('vault: rejects overdraws and fractions', threw, 2);
}

// Quests
{
  const a = ECON.dailyQuests('2026-11-12', 2), b = ECON.dailyQuests('2026-11-12', 2);
  check('quests are deterministic for a day and tier', a, b);
  check('three distinct quests', new Set(a.map(q => q.id)).size, 3);
  ok('targets match the tier', a.every(q => q.target === ECON.QUESTS.find(d => d.id === q.id).n[2]));
  let differ = 0;
  for (let i = 1; i <= 28; i++) {
    const day = `2026-02-${String(i).padStart(2, '0')}`;
    if (JSON.stringify(ECON.dailyQuests(day, 0).map(q => q.id)) !== JSON.stringify(ECON.dailyQuests('2026-02-01', 0).map(q => q.id))) differ++;
  }
  ok('quests vary from day to day', differ > 20);
  const usage = {};
  for (let i = 0; i < 2000; i++) for (const q of ECON.dailyQuests('d' + i, i % 5)) usage[q.id] = (usage[q.id] || 0) + 1;
  check('every quest type shows up', Object.keys(usage).length, ECON.QUESTS.length);
}
{
  const q = { id: 'bjStreak', target: 3, progress: 0, done: false };
  const bjRound = (net) => ({ game: 'bj', mainNet: net });
  ECON.advanceQuest(q, bjRound(10)); ECON.advanceQuest(q, bjRound(10));
  ECON.advanceQuest(q, bjRound(0));                  // push: streak holds
  ECON.advanceQuest(q, { game: 'tcp' });             // other game: streak untouched
  check('streak: push and other games leave it alone', q.progress, 2);
  ECON.advanceQuest(q, bjRound(-10));
  check('streak: a loss resets it', q.progress, 0);
  ECON.advanceQuest(q, bjRound(5)); ECON.advanceQuest(q, bjRound(5));
  check('streak: completes on the third win', [ECON.advanceQuest(q, bjRound(5)), q.done, q.progress], [true, true, 3]);
  check('a done quest never completes twice', ECON.advanceQuest(q, bjRound(5)), false);
  const c = { id: 'bjWins', target: 5, progress: 4, done: false };
  ECON.advanceQuest(c, { game: 'fb', handsWon: 3 });
  check('progress is capped at the target', [c.progress, c.done], [5, true]);
}
// Shop
ok('shop ids are unique', new Set(ECON.SHOP.map(s => s.id)).size === ECON.SHOP.length);
ok('every cosmetic kind has a free default', ['felt', 'back', 'title'].every(k => ECON.SHOP.some(s => s.kind === k && s.price === 0)));
ok('shop prices are whole chips', ECON.SHOP.every(s => Number.isInteger(s.price) && s.price >= 0));
// Rotating shop
{
  const days = [];
  for (let i = 0; i < 7 * 12; i++) days.push(new Date(2026, 10, 2 + i, 12));   // 12 weeks from a Monday
  const cyc = days.map(d => ECON.shopCycle(d));
  check('same date, same shop (deterministic)', JSON.stringify(ECON.shopCycle(new Date(2026, 10, 18, 9))), JSON.stringify(ECON.shopCycle(new Date(2026, 10, 18, 21))));
  ok('deal of the day changes from day to day', new Set(cyc.slice(0, 14).map(c => c.deal)).size > 5);
  ok('spotlight is fixed within a week', cyc.slice(0, 7).every(c => c.spotlight.join() === cyc[0].spotlight.join()));
  ok('spotlight changes between weeks', new Set(cyc.filter((_, i) => i % 7 === 0).map(c => c.spotlight.join())).size > 4);
  ok('deal is never also a spotlight item', cyc.every(c => !c.spotlight.includes(c.deal)));
  ok('deals and spotlights are never free or collection items', cyc.every(c => [c.deal, ...c.spotlight].every(id => ECON.SHOP_BY_ID[id].price > 0 && !ECON.SHOP_BY_ID[id].collection)));
  const order = cyc.filter((_, i) => i % 7 === 0).map(c => c.collection.id);
  check('collections cycle in a fixed order, each back every N weeks', order.slice(ECON.COLLECTIONS.length, 2 * ECON.COLLECTIONS.length), order.slice(0, ECON.COLLECTIONS.length));
  check('every collection shows up', new Set(order).size, ECON.COLLECTIONS.length);
  ok('collection items are buyable only in their week',
     cyc.every((c, i) => ECON.SHOP.filter(s => s.collection).every(s => (ECON.shopPrice(s.id, days[i]) !== null) === (s.collection === c.collection.id))));
  ok('sale prices are whole chips, multiples of 50, and cheaper',
     days.every(d => ECON.SHOP.every(s => { const p = ECON.shopPrice(s.id, d); return !p || (Number.isInteger(p.price) && (p.off === 0 ? p.price === s.price : p.price % 50 === 0 && p.price < s.price)); })));
  const sun = ECON.shopCycle(new Date(2026, 10, 8, 23, 59)), mon = ECON.shopCycle(new Date(2026, 10, 9, 0, 1));
  ok('the week turns over Monday at midnight', sun.collection.id !== mon.collection.id && sun.spotlight.join() !== mon.spotlight.join());
}

// ---------------------------------------------------------------------------
// 2. Wheel fairness with the real crypto RNG
// ---------------------------------------------------------------------------

function lgamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, t = z + 5.5; t -= (z + 0.5) * Math.log(t);
  let s = 1.000000000190015; for (const k of c) s += k / ++y;
  return -t + Math.log(2.5066282746310005 * s / z);
}
function gammaQ(a, x) {
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 1000; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
const wheelLines = [];
for (const which of ['bonus', 'rescue']) {
  const w = ECON.WHEELS[which], total = ECON.wheelTotal(w), N = 1000000;
  const obs = new Array(w.slices.length).fill(0);
  let chips = 0;
  for (let i = 0; i < N; i++) { const k = ECON.spinWheel(w, BJ.cryptoRandInt); obs[k]++; chips += w.slices[k].chips; }
  let chi = 0;
  w.slices.forEach((s, i) => { const ex = N * s.weight / total; chi += (obs[i] - ex) ** 2 / ex; });
  const p = gammaQ((w.slices.length - 1) / 2, chi / 2);
  ok(`${which} wheel chi-square p > 0.001 (p = ${p.toFixed(4)})`, p > 0.001);
  wheelLines.push(`${w.name.padEnd(13)} 1,000,000 spins  chi2 ${chi.toFixed(1).padStart(5)}  p = ${p.toFixed(4)}  ` +
    `avg ${(chips / N).toFixed(1)} vs exact ${ECON.wheelEV(w, 1).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// The real page in a sandbox
// ---------------------------------------------------------------------------

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const f of ['blackjack-core.js', 'economy.js']) {
  ok(`index.html loads ${f}`, HTML.includes(`<script src="${f}"></script>`));
}

function seededCrypto(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return { getRandomValues(buf) { for (let i = 0; i < buf.length; i++) buf[i] = next(); return buf; } };
}

/** Boot index.html's script. clock.t is the fake "now" in ms. */
function loadPage({ store, clock, crypto }) {
  const makeEl = (id) => ({
    id, textContent: '', innerHTML: '', className: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {},
  });
  const els = new Map();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }
  const sb = {
    console, crypto: crypto || globalThis.crypto, performance: globalThis.performance, Date: FakeDate,
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    confirm: () => false, setTimeout: () => {},
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    document: {
      getElementById: id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], createElement: () => makeEl('tmp'), addEventListener: () => {},
    },
    BJ, ECON, TABLE_RULES: require('./tables.js'),
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(SCRIPT + `
;globalThis.__h = {
  S: () => S, phase: () => phase, deal, resolve, pEval: () => pEval, Q64,
  showGame, bjDeal, bjAct, econSpin, econBuy, econEquip, econGrant, econReconcile, econRescueReady,
  econBonusReadyAt, econMaxBet, econTier, chipsInPlay, BJ_TABLES, econVault,
  econClaimQuest, econClaimAll, econUnclaimed, econEnsureQuests,
  play: () => { S.chips -= S.bets.ante; resolve(true); },
};`, sb, { filename: 'index.html:script' });
  return sb.__h;
}

// ---------------------------------------------------------------------------
// 3. The deal is indifferent to who you are
// ---------------------------------------------------------------------------
{
  const quietTuesday = dateOnWeekday(2, 14).getTime();
  const bonanzaFriday = dateOnWeekday(5, 19).getTime();
  const profiles = [
    { name: 'broke Lv1, Tuesday', clock: quietTuesday, xp: 0, chips: 60 },
    { name: 'rich Diamond, Bonanza Friday', clock: bonanzaFriday, xp: 200000, chips: 5e7 },
  ];
  const results = profiles.map(p => {
    const clock = { t: p.clock };
    const H = loadPage({ store: new Map(), clock, crypto: seededCrypto(424242) });
    const S = H.S();
    S.econ.xp = p.xp;
    S.econ.quests.day = '';                    // re-roll today's quests at the new rank
    H.econGrant('admin', p.chips - S.chips);   // set the bankroll through the ledger
    const log = [];
    let x = 7;   // decision stream: identical for both players
    const rnd = (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % n; };
    for (let i = 0; i < 400; i++) {
      if (S.chips < 60) H.econGrant('admin', 60 - S.chips);   // keep the poor player able to bet, via the ledger
      const game = ['tcp', 'bj', 'fb'][i % 3];
      if (game === 'tcp') {
        S.bets = { ante: 10, pp: 5, scb: 5 };
        H.deal();
        if (H.phase() === 'decision') { if (rnd(2)) H.play(); else H.resolve(false); }
        const h = S.history[S.history.length - 1];
        log.push(['tcp', h.player, h.dealer, h.outcome, h.net]);
      } else {
        H.showGame(game);
        const T = S[game];
        T.bet = 10; T.side = { perfectPairs: 10, twentyOnePlus3: 0 };
        H.bjDeal();
        let g = 0;
        while (T.round && g++ < 50) {
          const legal = BJ.legalActions(T.round, 1e9);
          const opts = Object.keys(legal).filter(k => legal[k]).sort();
          H.bjAct(opts[rnd(opts.length)]);
        }
        const r = T.last;
        log.push([game, r.dealer, r.hands.map(h => [h.cards, h.outcome]), r.net]);
      }
      H.econClaimAll();   // claiming is economy, never cards: must not change the log
    }
    return { log, ledger: S.econ.ledger, tier: H.econTier() };
  });
  const same = JSON.stringify(results[0].log) === JSON.stringify(results[1].log);
  check('same seed + same decisions => identical cards and results for a broke Lv1 and a rich Diamond during an event', same, true);
  ok('...while the economy treated them differently (tier, promos)',
     results[0].tier !== results[1].tier || results[0].ledger.promo !== results[1].ledger.promo);
  var indifference = `${results[0].log.length} rounds ${same ? "IDENTICAL" : "DIFFERENT (rigged!)"} across: ${profiles.map(p => p.name).join(' vs ')}; ` +
    `ledger promos ${results[0].ledger.promo} vs ${results[1].ledger.promo}, quests ${results[0].ledger.quests} vs ${results[1].ledger.quests}`;
}

// ---------------------------------------------------------------------------
// 4. Ledger: long session, fake clock, reloads, everything; reconcile every step
// ---------------------------------------------------------------------------
let sessionSummary;
{
  const store = new Map();
  const clock = { t: dateOnWeekday(1, 9).getTime() };   // start on a Monday morning
  let H = loadPage({ store, clock });
  let x = 99;
  const rnd = (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % n; };
  let steps = 0, reloads = 0, rescues = 0, bonusSpins = 0, buys = 0, badRescue = 0, badBonus = 0, midReloads = 0;
  let reconcileFails = 0, firstFail = null, vaultMoves = 0, claims = 0;
  const assertLedger = (where) => {
    const r = H.econReconcile();
    if (!r.ok) { reconcileFails++; if (!firstFail) firstFail = `${where}: expected ${r.expected}, chips ${r.actual}`; }
  };

  for (let i = 0; i < 6000; i++) {
    const S = H.S();
    clock.t += (1 + rnd(20)) * 60000;              // 1-20 minutes pass
    const action = rnd(100);
    if (action < 35) {                              // Three Card Poker
      const lim = Math.min(H.econMaxBet(), 200);
      S.bets = { ante: 5 * (1 + rnd(lim / 5)), pp: rnd(2) ? 5 : 0, scb: rnd(3) ? 0 : 5 };
      H.showGame('tcp');
      H.deal();
      assertLedger('tcp after deal');
      if (H.phase() === 'decision') {
        if (rnd(10) === 0) { H = loadPage({ store, clock }); midReloads++; assertLedger('tcp after mid-hand reload'); }
        if (H.phase() !== 'decision') { reconcileFails++; firstFail = firstFail || 'TCP hand not restored after reload'; }
        if (rnd(2) && H.S().chips >= H.S().bets.ante) H.play(); else H.resolve(false);
      }
    } else if (action < 75) {                       // Blackjack or Free Bet, with side bets
      const t = rnd(2) ? 'bj' : 'fb';
      H.showGame(t);
      const T = S[t];
      T.bet = 10 * (1 + rnd(Math.min(H.econMaxBet(), 300) / 10));
      T.side = { perfectPairs: rnd(3) ? 0 : 10, twentyOnePlus3: rnd(3) ? 0 : 10 };
      H.bjDeal();
      let g = 0;
      while (H.S()[t].round && g++ < 60) {
        assertLedger('bj mid-round');
        if (rnd(25) === 0) { H = loadPage({ store, clock }); H.showGame(t); midReloads++; assertLedger('bj after mid-round reload'); }
        const R = H.S()[t].round;
        const legal = BJ.legalActions(R, H.S().chips);
        const opts = Object.keys(legal).filter(k => legal[k]);
        H.bjAct(rnd(2) ? BJ.basicStrategy(R, H.S().chips) : opts[rnd(opts.length)]);
      }
    } else if (action < 83) {                       // Bonus Wheel
      const ready = clock.t >= H.econBonusReadyAt();
      const res = H.econSpin('bonus');
      if (!!res !== ready) badBonus++;
      if (res) bonusSpins++;
    } else if (action < 91) {                       // Rescue Wheel
      const ready = H.econRescueReady();
      const shouldBe = H.S().chips + H.S().econ.vault.balance < ECON.WHEELS.rescue.availableBelow && H.chipsInPlay(H.S()) === 0;
      const res = H.econSpin('rescue');
      if (ready !== shouldBe || !!res !== shouldBe) badRescue++;
      if (res) rescues++;
    } else if (action < 93) {                       // Vault
      const S2 = H.S();
      if (rnd(2) && S2.chips > 0) { if (H.econVault(1 + rnd(S2.chips))) vaultMoves++; }
      else if (S2.econ.vault.balance > 0) { if (H.econVault(-(1 + rnd(S2.econ.vault.balance)))) vaultMoves++; }
    } else if (action < 95) {                       // Shop
      if (rnd(3) === 0 && H.chipsInPlay(H.S()) === 0) H.econGrant('admin', 5000);   // (via the ledger) so purchases happen at all
      const affordable = ECON.SHOP.filter(x => !H.S().econ.owned.includes(x.id) && x.price <= H.S().chips);
      const it = affordable.length ? affordable[rnd(affordable.length)] : ECON.SHOP[rnd(ECON.SHOP.length)];
      if (H.econBuy(it.id)) buys++;
    } else if (action < 97) {                       // Admin
      H.econGrant('admin', 500);
    } else {                                        // Plain reload
      H = loadPage({ store, clock }); reloads++;
    }
    // Claim finished quests now and then (and sometimes leave them for the day rollover).
    if (rnd(5) === 0 && H.econClaimAll() > 0) claims++;
    // Go broke sometimes so the rescue path gets exercised. "Broke" means under
    // the rescue threshold counting the vault, so sometimes empty the vault too
    // (not always, or it never holds a balance for a full day and earns no
    // interest). The old 98% drain usually left more than the threshold, so
    // rescues rarely happened and this coverage check was flaky.
    if (rnd(40) === 0 && H.chipsInPlay(H.S()) === 0) {
      if (H.S().econ.vault.balance > 0 && rnd(10) === 0) H.econVault(-H.S().econ.vault.balance);
      H.econGrant('admin', rnd(ECON.WHEELS.rescue.availableBelow) - H.S().chips);
    }
    assertLedger(`step ${i}`);
    steps++;
  }
  const S = H.S();
  check('ledger reconciles after every one of the session steps', reconcileFails, 0);
  if (firstFail) failures.push('first ledger failure: ' + firstFail);
  check('Bonus Wheel spins exactly when (and only when) its cooldown has passed', badBonus, 0);
  check('Rescue Wheel available exactly when under 10 chips with nothing on the table', badRescue, 0);
  ok('session exercised rescues, bonus spins, purchases, vault and reloads',
     rescues > 5 && bonusSpins > 5 && buys > 0 && midReloads > 5 && vaultMoves > 20 && S.econ.ledger.interest > 0 && claims > 5);
  ok('chips never negative', S.chips >= 0);
  const L = S.econ.ledger;
  sessionSummary = `${steps.toLocaleString()} steps over ${((clock.t - dateOnWeekday(1, 9).getTime()) / 86400000).toFixed(1)} days, ` +
    `${midReloads} mid-hand reloads + ${reloads} plain reloads; ${bonusSpins} bonus spins (+${L.bonusWheel.toLocaleString()}), ` +
    `${rescues} rescues (+${L.rescueWheel.toLocaleString()}), quests +${L.quests.toLocaleString()} (${claims} claims), promos +${L.promo.toLocaleString()}, ` +
    `vault interest +${L.interest.toLocaleString()} (${vaultMoves} moves), shop ${L.shop.toLocaleString()}; ` +
    `reached level ${ECON.levelFromXp(S.econ.xp).level}, ended with ${(S.chips + S.econ.vault.balance).toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// 5. Migration: a save from before the economy existed reconciles on load
// ---------------------------------------------------------------------------
{
  const store = new Map();
  const old = { chips: 3210, bets: { ante: 10, pp: 5, scb: 5 }, lastBonus: 0,
    stats: { hands: 40, wagered: 800, net: -120, folds: 3, dealerQualified: 30, dealerNotQualified: 10, catCounts: [0, 0, 0, 0, 0, 0] },
    history: [], game: 'tcp' };
  store.set('tcp.save.v1', JSON.stringify(old));
  const H = loadPage({ store, clock: { t: Date.now() } });
  check('pre-economy save: chips kept', H.S().chips, 3210);
  check('pre-economy save: ledger reconciles', H.econReconcile().ok, true);
  check('pre-economy save: unexplained chips become the opening balance', H.S().econ.ledger.opening, 3210 + 120);
}

// ---------------------------------------------------------------------------
// 6. Quests are claimed by hand: completing pays nothing, claiming pays once
// ---------------------------------------------------------------------------
{
  const store = new Map();
  const clock = { t: dateOnWeekday(1, 10).getTime() };      // Monday: Quest Rush doubles rewards
  const H = loadPage({ store, clock });
  const S = H.S();
  H.econGrant('admin', 1e6);                                  // enough to play a while, via the ledger
  let completedAt = null, g = 0;
  while (!completedAt && g++ < 3000) {
    const before = { chips: S.chips, quests: S.econ.ledger.quests };
    if (g % 2) { S.bets = { ante: 10, pp: 5, scb: 5 }; H.deal(); if (H.phase() === 'decision') H.play(); }
    else { H.showGame('bj'); S.bj.bet = 10; S.bj.side = { perfectPairs: 10, twentyOnePlus3: 10 }; H.bjDeal();
           let k = 0; while (S.bj.round && k++ < 30) H.bjAct(BJ.basicStrategy(S.bj.round, S.chips)); }
    if (H.econUnclaimed().length) completedAt = before;
  }
  ok('a quest completed during play', completedAt);
  const { q, i } = H.econUnclaimed()[0];
  check('completing a quest pays nothing yet (ledger.quests unchanged)', S.econ.ledger.quests, completedAt.quests);
  ok('completion leaves a claimable notification', S.econ.notes.some(n => n.action && n.action.type === 'claim' && n.action.i === i));
  check('reward fixed at completion, Quest Rush doubled', q.reward.chips, 2 * ECON.questReward(0, dateOnWeekday(2, 10)).chips);
  const chips0 = S.chips, led0 = S.econ.ledger.quests;
  const rw = H.econClaimQuest(i, S.econ.quests.day);
  check('claim pays exactly the reward', [S.chips - chips0, S.econ.ledger.quests - led0], [rw.chips, rw.chips]);
  check('a claimed quest cannot be claimed again', H.econClaimQuest(i, S.econ.quests.day), null);
  check('a stale (wrong-day) claim is refused', H.econClaimQuest(i, '1999-01-01'), null);
  check('ledger reconciles after claiming', H.econReconcile().ok, true);

  // Leave one finished quest unclaimed overnight: it's paid at rollover, not lost.
  const other = S.econ.quests.list.find(x => !x.done);
  other.done = true; other.claimed = false; other.progress = other.target; other.reward = { chips: 123, xp: 0 };
  const led1 = S.econ.ledger.quests, day1 = S.econ.quests.day;
  clock.t += 24 * 3600 * 1000;
  H.econEnsureQuests();
  ok('rollover starts a new day of quests', S.econ.quests.day !== day1);
  check('rollover pays unclaimed rewards exactly', S.econ.ledger.quests - led1, 123);
  check('ledger reconciles after rollover', H.econReconcile().ok, true);

  // Old saves: a quest marked done before claiming existed was already paid.
  const raw = JSON.parse(store.get('tcp.save.v1') || JSON.stringify(S));
  raw.econ.quests.list.forEach(x => { x.done = true; x.progress = x.target; delete x.claimed; delete x.reward; });
  store.set('tcp.save.v1', JSON.stringify(raw));
  const H2 = loadPage({ store, clock });
  const led2 = H2.S().econ.ledger.quests;
  check('old-save done quests count as claimed (no double pay)', [H2.econUnclaimed().length, H2.econClaimAll(), H2.S().econ.ledger.quests - led2], [0, 0, 0]);
}

// ---------------------------------------------------------------------------
// 7. Shop rotation through the real page: sale prices charged, rotation enforced
// ---------------------------------------------------------------------------
{
  const clock = { t: new Date(2026, 10, 18, 12).getTime() };
  const H = loadPage({ store: new Map(), clock });
  const S = H.S();
  H.econGrant('admin', 1e7);   // enough for any deal, including the priciest titles
  const c = ECON.shopCycle(new Date(clock.t));
  const deal = ECON.shopPrice(c.deal, new Date(clock.t));
  const chips0 = S.chips, shop0 = S.econ.ledger.shop;
  check('buying the deal succeeds', H.econBuy(c.deal), true);
  check('...and charges the sale price, through the ledger', [chips0 - S.chips, shop0 - S.econ.ledger.shop], [deal.price, deal.price]);
  ok('...which is less than full price', deal.price < ECON.SHOP_BY_ID[c.deal].price);
  const away = ECON.SHOP.find(s => s.collection && s.collection !== c.collection.id);
  check('an item from another week\'s collection cannot be bought', H.econBuy(away.id), false);
  const here = c.collection.items[0];
  check('this week\'s collection item can be bought at full price', [H.econBuy(here.id), chips0 - deal.price - S.chips], [true, here.price]);
  clock.t += 7 * 86400000;   // next week: it's out of rotation, but still owned and equippable
  check('a bought collection item stays owned after it rotates out', [S.econ.owned.includes(here.id), H.econEquip(here.id)], [true, true]);
  check('ledger reconciles after shop purchases', H.econReconcile().ok, true);
}

// ---------------------------------------------------------------------------

console.log('Wheels (real crypto RNG):');
for (const l of wheelLines) console.log('  ' + l);
console.log('Indifference: ' + indifference);
console.log('Session:      ' + sessionSummary);
console.log('');
if (failed) {
  console.log(`FAIL  ${failed} failed, ${passed} passed`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`PASS  ${passed} checks`);
