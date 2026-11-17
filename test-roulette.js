#!/usr/bin/env node
/*
 * Roulette: verification of roulette-core.js and the real page code.
 *
 *   node test-roulette.js [spins]      # default 200000 per wheel, ~1 min
 *
 * 1. The layout: every bet is real (numbers on the wheel, splits adjacent,
 *    corners square, streets/six lines in order), ids unique, the expected
 *    count of each kind, and each bet's exact return equals (N+1)k/pockets - 1.
 * 2. settle() against a brute-force payout on every pocket, for random bets.
 * 3. spin() is uniform over the pockets (chi-square), with crypto randomness.
 * 4. Through index.html behind a stub DOM: chip accounting (bankroll change
 *    minus economy grants == roulette net, exactly), the ledger reconciles,
 *    and the realized net is within 4 standard errors of the exact expected
 *    net for the bets actually made.
 * 5. Hard rule 2: same RNG, a broke Lv1 and a rich Diamond get the same pockets.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = require('./roulette-core.js');

const N = parseInt(process.argv[2], 10) || 200000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; if (fail < 25) console.log('  FAIL ' + m); } };
const report = (name, before) => console.log(`  ${fail === before ? 'ok  ' : 'FAIL'} ${name}`);
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const seededInt = (seed) => { const r = mulberry32(seed); return (n) => Math.floor(r() * n); };
// Wilson-Hilferty: P(chi2 with k df > x), good enough for a pass/fail at p = 0.001
const chiP = (x, k) => { const z = (Math.cbrt(x / k) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k)); return 0.5 * (1 - erf(z / Math.SQRT2)); };
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

console.log('\nlayout and exact odds');
{
  const f = fail;
  const expectCounts = {
    american: { straight: 38, split: 62, corner: 22, street: 12, sixLine: 11, trio: 3, basket: 1, dozen: 3, column: 3, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1 },
    european: { straight: 37, split: 60, corner: 22, street: 12, sixLine: 11, trio: 2, firstFour: 1, dozen: 3, column: 3, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1 },
  };
  for (const id of R.WHEEL_IDS) {
    const w = R.WHEELS[id];
    const valid = new Set(w.order);
    ok(valid.size === w.pockets && w.pockets === (id === 'american' ? 38 : 37), id + ': pockets');
    ok(new Set(w.bets.map(b => b.id)).size === w.bets.length, id + ': bet ids unique');
    const counts = {};
    for (const b of w.bets) {
      counts[b.kind] = (counts[b.kind] || 0) + 1;
      ok(b.numbers.every(n => valid.has(n)) && new Set(b.numbers).size === b.numbers.length, `${id} ${b.id}: numbers on the wheel`);
      const inner = b.numbers.filter(n => n >= 1 && n <= 36);
      const col = (n) => Math.ceil(n / 3), pos = (n) => (n - 1) % 3;   // street index, position in the street
      if (b.kind === 'split' && inner.length === 2) {
        const [a, c] = inner;
        ok((col(a) === col(c) && Math.abs(a - c) === 1) || (c - a === 3), `${b.id}: split not adjacent`);
      }
      if (b.kind === 'corner') {
        const [a, x, y, z] = b.numbers;
        ok(col(x) === col(a) && x === a + 1 && y === a + 3 && z === a + 4, `${b.id}: corner not a square`);
      }
      if (b.kind === 'street') ok(b.numbers[0] % 3 === 1 && b.numbers[2] === b.numbers[0] + 2, `${b.id}: street`);
      if (b.kind === 'sixLine') ok(b.numbers[0] % 3 === 1 && b.numbers[5] === b.numbers[0] + 5, `${b.id}: six line`);
      const exact = (R.PAYS[b.kind] + 1) * b.numbers.length / w.pockets - 1;
      ok(Math.abs(R.betReturn(w, b) - exact) < 1e-15 && b.pays === R.PAYS[b.kind], `${b.id}: return`);
      // every pay is fair odds minus the house's pocket(s): pays+1 = (36 / k) for every bet but the basket
      if (b.kind !== 'basket') ok((b.pays + 1) * b.numbers.length === 36, `${b.id}: pays ${b.pays} on ${b.numbers.length} numbers`);
    }
    ok(JSON.stringify(counts) === JSON.stringify(Object.fromEntries(Object.keys(counts).map(k => [k, expectCounts[id][k]]))) &&
       Object.keys(expectCounts[id]).every(k => counts[k] === expectCounts[id][k]), `${id}: bet counts ${JSON.stringify(counts)}`);
    for (const n of w.order) ok(w.bets.filter(b => b.kind === 'straight' && b.numbers[0] === n).length === 1, `${id}: one straight on ${R.label(n)}`);
    const reds = w.order.filter(n => R.colorOf(n) === 'red').length, blacks = w.order.filter(n => R.colorOf(n) === 'black').length;
    ok(reds === 18 && blacks === 18, id + ': 18 red, 18 black');
  }
  const am = R.WHEELS.american, eu = R.WHEELS.european;
  const edge = (w, id) => -R.betReturn(w, w.betById[id]);
  ok(Math.abs(edge(am, 'straight:17') - 2 / 38) < 1e-12 && Math.abs(edge(am, 'basket:0-1-2-3-00') - 3 / 38) < 1e-12, 'American: 5.26%, basket 7.89%');
  ok(Math.abs(edge(eu, 'straight:17') - 1 / 37) < 1e-12 && Math.abs(edge(eu, 'firstFour:0-1-2-3') - 1 / 37) < 1e-12, 'European: 2.70% on every bet');
  report('every bet is a real layout bet; exact returns; American 5.26% (basket 7.89%), European 2.70%', f);
}

console.log('\nsettle');
{
  const f = fail, ri = seededInt(3);
  for (const id of R.WHEEL_IDS) {
    const w = R.WHEELS[id];
    for (let k = 0; k < 400; k++) {
      const bets = {};
      const n = 1 + ri(6);
      for (let j = 0; j < n; j++) { const b = w.bets[ri(w.bets.length)]; bets[b.id] = (bets[b.id] || 0) + 1 + ri(50); }
      for (const pocket of w.order) {
        const res = R.settle(w, bets, pocket);
        let wag = 0, ret = 0;
        for (const [bid, amt] of Object.entries(bets)) { wag += amt; if (w.betById[bid].numbers.includes(pocket)) ret += amt * (w.betById[bid].pays + 1); }
        ok(res.wagered === wag && res.returned === ret && res.net === ret - wag && Number.isInteger(res.returned), `${id} settle mismatch on ${R.label(pocket)}`);
      }
    }
    ok(R.betError(w, {}) && R.betError(w, { 'straight:99': 5 }) && R.betError(w, { 'straight:1': 2 }) && R.betError(w, { 'straight:1': 2.5 }) && !R.betError(w, { 'straight:1': 5 }),
      id + ': betError refuses empty, unknown, under-minimum, fractional');
  }
  report('settle() == brute-force payout on every pocket for 800 random bet sets; whole chips', f);
}

console.log('\nspin');
{
  const f = fail;
  const crypto = require('./blackjack-core.js').cryptoRandInt;
  for (const id of R.WHEEL_IDS) {
    const w = R.WHEELS[id], cnt = new Map(), M = 20 * N > 2e6 ? 2e6 : 20 * N;
    for (let i = 0; i < M; i++) { const p = R.spin(w, crypto); cnt.set(p, (cnt.get(p) || 0) + 1); }
    const e = M / w.pockets;
    let chi = 0;
    for (const p of w.order) chi += ((cnt.get(p) || 0) - e) ** 2 / e;
    const p = chiP(chi, w.pockets - 1);
    ok(p > 0.001, `${id}: chi2 ${chi.toFixed(1)} on ${w.pockets - 1} df, p = ${p.toFixed(4)}`);
    console.log(`  ${id}: ${M.toLocaleString()} spins, chi2 ${chi.toFixed(1)} (${w.pockets - 1} df), p = ${p.toFixed(3)}`);
  }
  report('every pocket equally likely (crypto.getRandomValues)', f);
}

/* ---------------------------------------------------------- the page -- */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
ok(html.includes('<script src="roulette-core.js"></script>'), 'index.html loads roulette-core.js');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function loadPage(storage) {
  function makeEl(id) {
    return { id, textContent: '', innerHTML: '', className: '', value: '', checked: false, disabled: false, hidden: false,
      style: {}, dataset: {}, offsetHeight: 0, offsetWidth: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {}, addEventListener() {}, remove() {}, querySelector() { return null; }, setAttribute() {} };
  }
  const els = new Map();
  const sandbox = {
    console, crypto: globalThis.crypto, performance: globalThis.performance,
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} }, confirm: () => false,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    location: { protocol: 'file:', hash: '', pathname: '/', search: '', origin: 'null' }, history: { replaceState() {} },
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    document: { getElementById: id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], querySelector: () => null, createElement: () => makeEl('tmp'), addEventListener: () => {}, body: makeEl('body') },
    BJ: require('./blackjack-core.js'), ECON: require('./economy.js'), TABLE_RULES: require('./tables.js'), TCP: require('./tcp-core.js'),
    SLOTS: require('./slots-core.js'), SLOT_ART: require('./slots-art.js'), JACKPOT: require('./jackpot.js'), ROULETTE: R,
  };
  sandbox.globalThis = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script + `
;globalThis.__h = { getS: () => S, rlSpin, rlAdd, showGame, econReconcile, save, setRand: (f) => { randInt = f; },
  RLS, setAnim: (v) => { animUntil = v; } };`, sandbox, { filename: 'index.html:script' });
  return sandbox.__h;
}

console.log(`\npage: ${N.toLocaleString()} spins per wheel through the real page code`);
{
  const H = loadPage(new Map());
  H.showGame('roulette');
  const S = H.getS();
  const top = 1e12 - S.chips;
  S.chips += top; S.econ.ledger.admin += top;
  const ledgerSum = () => Object.entries(S.econ.ledger).reduce((a, [k, v]) => a + (k === 'opening' ? 0 : v), 0);
  const ri = seededInt(99);
  for (const id of R.WHEEL_IDS) {
    const f = fail, w = R.WHEELS[id];
    S.rl.wheel = id; S.rl.bets = {};
    const B0 = S.chips + S.econ.vault.balance, L0 = ledgerSum(), n0 = S.rl.stats.net;
    let sN = 0, sE = 0, sV = 0;   // realized net, exact expected net, exact variance
    for (let i = 0; i < N; i++) {
      const bets = {}, k = 1 + ri(4);
      for (let j = 0; j < k; j++) { const b = w.bets[ri(w.bets.length)]; bets[b.id] = (bets[b.id] || 0) + 5 * (1 + ri(10)); }
      S.rl.bets = Object.assign({}, bets);
      const before = S.chips;
      H.rlSpin();
      const net = S.chips - before;
      // exact mean and variance of this spin's net, over every pocket
      let m = 0, m2 = 0;
      for (const p of w.order) { const r = R.settle(w, bets, p); m += r.net; m2 += r.net * r.net; }
      m /= w.pockets; m2 /= w.pockets;
      sN += net; sE += m; sV += m2 - m * m;
      if (S.rl.history.length > 100) S.rl.history.length = 0;
    }
    const grants = ledgerSum() - L0, delta = S.chips + S.econ.vault.balance - B0 - grants, rnet = S.rl.stats.net - n0;
    ok(delta === rnet && rnet === sN, `${id}: bankroll change minus grants ${delta} != roulette net ${rnet} (MISMATCH)`);
    const z = (sN - sE) / Math.sqrt(sV);
    ok(Math.abs(z) < 4, `${id}: realized net ${sN} vs exact expected ${Math.round(sE)} is ${z.toFixed(2)} SE out`);
    report(`${w.name}: accounting ${delta === rnet ? 'CONSISTENT' : 'MISMATCH'}, net ${sN.toLocaleString()} vs exact expected ${Math.round(sE).toLocaleString()} (${z.toFixed(2)} SE)`, f);
  }
  const f = fail, rec = H.econReconcile();
  ok(rec.ok, `ledger: expected ${rec.expected}, actual ${rec.actual}`);
  report('economy ledger reconciles', f);
}

console.log('\nthe deal is indifferent to who you are (hard rule 2)');
{
  const f = fail;
  function run(xp, chips) {
    const H = loadPage(new Map());
    H.showGame('roulette');
    const S = H.getS();
    S.econ.xp = xp; S.chips = chips;
    H.setRand(seededInt(2026));
    const out = [];
    for (const id of R.WHEEL_IDS) {
      S.rl.wheel = id;
      for (let i = 0; i < 300; i++) { S.rl.bets = { 'straight:17': 5, 'red:1-3-5-7-9-12-14-16-18-19-21-23-25-27-30-32-34-36': 5 }; H.rlSpin(); out.push(S.rl.recent[0] + ':' + S.rl.stats.net); }
    }
    return out;
  }
  const a = run(0, 20000), b = run(500000, 5e7);   // Lv1 with enough for 600 spins of 10 vs a rich Diamond
  ok(a.length === 600 && a.every((x, i) => x === b[i]), 'Lv1 with 20,000 and Diamond with 50M got different pockets');
  report('same RNG: identical pockets and results for a Lv1 with 20,000 and a Diamond with 50M', f);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} checks, ${fail} failed`);
process.exit(fail ? 1 : 0);
