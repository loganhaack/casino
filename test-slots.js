#!/usr/bin/env node
/*
 * Slot machines: verification through the REAL page code.
 *
 *   node test-slots.js [paidSpinsPerMachine]     # default 150000, ~3 min
 *
 * Checks:
 *   1. payOf() (what the enumerator sums) equals the itemised wins() (what
 *      the page shows and pays) on random windows of every machine.
 *   2. Spin math: free spins are free, never charge, play at the triggering
 *      bet, and end; integral chips only.
 *   3. Through index.html behind a stub DOM: chip accounting (bankroll change
 *      minus economy grants == slots net, exactly), the economy ledger
 *      reconciles, and the realized return is within 4 standard errors of the
 *      exact RTP from enumerate-slots.js (SLOTS.PAR). A "round" is one paid
 *      spin plus every free spin it leads to, so rounds are independent.
 *   4. A reload in the middle of free spins resumes them.
 *   5. The deal is indifferent to who you are (hard rule 2): same RNG, a
 *      broke Lv1 and a rich Diamond get identical spins.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SLOTS = require('./slots-core.js');

const N = parseInt(process.argv[2], 10) || 150000;
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

/* ------------------------------------------------------------ 1 + 2 -- */
console.log('\ncore');
{
  const f = fail, ri = seededInt(1);
  for (const id of SLOTS.MACHINE_IDS) {
    const m = SLOTS.MACHINES[id];
    for (let k = 0; k < 20000; k++) {
      const g = SLOTS.windowOf(m, SLOTS.spinStops(m, ri));
      const itemised = SLOTS.wins(m, g).reduce((a, w) => a + w.pay, 0);
      ok(itemised === SLOTS.payOf(m, g), `${id}: wins() ${itemised} != payOf() ${SLOTS.payOf(m, g)}`);
    }
  }
  report('payOf() == sum of itemised wins on 60,000 random windows', f);
}
{
  const f = fail, ri = seededInt(2);
  for (const id of SLOTS.MACHINE_IDS) {
    const m = SLOTS.MACHINES[id];
    const level = m.kind === 'classic' ? 10 : 3;
    let free = null, features = 0, freeSpins = 0;
    for (let k = 0; k < 40000; k++) {
      const r = SLOTS.play(m, level, free, ri);
      ok(Number.isInteger(r.win) && r.win >= 0 && Number.isInteger(r.cost), `${id}: non-integral chips`);
      if (free) { ok(r.cost === 0, `${id}: a free spin charged ${r.cost}`); freeSpins++; }
      else ok(r.cost === SLOTS.totalBet(m, level), `${id}: paid spin cost ${r.cost}`);
      if (!free && r.free) features++;
      if (r.free) ok(r.free.left > 0 && r.free.level === level && r.free.mult === m.free.mult, `${id}: bad feature state`);
      free = r.free;
    }
    if (m.free) ok(features > 0 && freeSpins >= features * m.free.spins - m.free.spins, `${id}: features ${features}, free spins ${freeSpins}`);
  }
  ok(SLOTS.betError(SLOTS.MACHINES.gilded, 7) && SLOTS.betError(SLOTS.MACHINES.galleon, 0) && SLOTS.betError(SLOTS.MACHINES.lantern, 1.5), 'bad bets refused');
  report('paid spins cost the bet; free spins are free, at the trigger bet, with the multiplier; whole chips', f);
}

/* ---------------------------------------------------------- the page -- */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
for (const file of ['slots-core.js', 'slots-art.js']) ok(html.includes(`<script src="${file}"></script>`), 'index.html loads ' + file);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function loadPage(storage) {
  function makeEl(id) {
    return {
      id, textContent: '', innerHTML: '', className: '', value: '', checked: false, disabled: false, hidden: false,
      style: {}, dataset: {}, offsetHeight: 0, offsetWidth: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {}, addEventListener() {}, remove() {}, querySelector() { return null; }, setAttribute() {},
    };
  }
  const els = new Map();
  const sandbox = {
    console, crypto: globalThis.crypto, performance: globalThis.performance,
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    confirm: () => false, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    matchMedia: () => ({ matches: true, addEventListener() {} }),   // reduced motion: no animation holds
    location: { protocol: 'file:', hash: '', pathname: '/', search: '', origin: 'null' },
    history: { replaceState() {} },
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    document: {
      getElementById: id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], querySelector: () => null, createElement: () => makeEl('tmp'),
      addEventListener: () => {}, body: makeEl('body'),
    },
    BJ: require('./blackjack-core.js'), ECON: require('./economy.js'), TABLE_RULES: require('./tables.js'),
    TCP: require('./tcp-core.js'), SLOTS, SLOT_ART: require('./slots-art.js'),
  };
  sandbox.globalThis = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script + `
;globalThis.__h = { getS: () => S, slotSpin, slotPick, slotST, showGame, econReconcile, slotsNet, save,
  setRand: (f) => { randInt = f; } };`, sandbox, { filename: 'index.html:script' });
  return sandbox.__h;
}

console.log(`\npage: ${N.toLocaleString()} paid spins per machine (plus their free spins)`);
const storage = new Map();
const H = loadPage(storage);
H.showGame('slots');
let allEdges = true;
for (const id of SLOTS.MACHINE_IDS) {
  const f = fail, m = SLOTS.MACHINES[id];
  H.slotPick(id);
  const S = H.getS(), st = H.slotST();
  st.level = m.kind === 'classic' ? 5 : 1;
  // Top the bankroll up through the ledger (an admin grant), as anything that
  // adds chips must, so the economy identity still holds afterwards.
  const top = 1e12 - S.chips;
  S.chips += top; S.econ.ledger.admin += top;
  const BANK = S.chips + S.econ.vault.balance;
  const ledgerSum = () => Object.entries(S.econ.ledger).reduce((a, [k, v]) => a + (k === 'opening' ? 0 : v), 0);
  const L0 = ledgerSum(), net0 = H.slotsNet(S);
  const bet = SLOTS.totalBet(m, st.level);
  // per-round sums: a round is a paid spin plus the free spins it leads to
  let rounds = 0, sR = 0, sRR = 0, roundRet = 0, paid = 0;
  const flush = () => { if (paid) { const x = roundRet / bet; sR += x; sRR += x * x; rounds++; } roundRet = 0; };
  let spins = 0;
  while (paid < N || st.free) {
    const wasFree = !!st.free;
    if (!wasFree) { flush(); paid++; }
    const before = S.chips, w0 = st.stats.returned;
    H.slotSpin();
    spins++;
    const won = st.stats.returned - w0;
    roundRet += won;
    if (spins % 997 === 0) ok(S.chips - before === won - (wasFree ? 0 : bet) || ledgerSum() !== L0, `${id}: one spin moved ${S.chips - before}, expected ${won - (wasFree ? 0 : bet)}`);
    if (st.history.length > 200) st.history.length = 0;
    if (S.chips < bet) { ok(false, id + ': bankroll ran out'); break; }
  }
  flush();
  const grants = ledgerSum() - L0, net = H.slotsNet(S) - net0;
  const delta = S.chips + S.econ.vault.balance - BANK - grants;   // grants made during the run (quests, promos)
  ok(delta === net, `${id}: bankroll change minus grants ${delta} != slots net ${net} (MISMATCH: chips created or destroyed)`);
  const mean = sR / rounds, se = Math.sqrt((sRR / rounds - mean * mean) / rounds);
  const diff = Math.abs(mean - m.par.rtp);
  const inside = diff < 4 * se;
  if (!inside) allEdges = false;
  ok(inside, `${id}: realized RTP ${(100 * mean).toFixed(3)}% vs exact ${(100 * m.par.rtp).toFixed(3)}% is ${(diff / se).toFixed(2)} SE out`);
  const t = st.stats;
  report(`${m.name}: ${spins.toLocaleString()} spins (${t.freeSpins.toLocaleString()} free), accounting ${delta === net ? 'CONSISTENT' : 'MISMATCH'}, ` +
    `RTP ${(100 * mean).toFixed(3)}% ± ${(100 * se).toFixed(3)}% vs exact ${(100 * m.par.rtp).toFixed(3)}% (${(diff / se).toFixed(2)} SE), ` +
    `hit ${(100 * t.hits / t.paid).toFixed(2)}% vs ${(100 * m.par.hit).toFixed(2)}%`, f);
}
{
  const f = fail, rec = H.econReconcile();
  ok(rec.ok, `ledger does not reconcile: expected ${rec.expected}, actual ${rec.actual}`);
  report('economy ledger reconciles after every machine (chips = opening + game nets + grants)', f);
}

console.log('\nreload in the middle of free spins');
{
  const f = fail, store = new Map(), P = loadPage(store);
  P.showGame('slots');
  P.slotPick('galleon');
  P.getS().chips = 1e9;
  let guard = 0;
  while (!P.slotST().free && guard++ < 100000) P.slotSpin();
  const free = JSON.stringify(P.slotST().free), chips = P.getS().chips;
  ok(!!P.slotST().free, 'never triggered free spins');
  P.save();
  const P2 = loadPage(store);
  P2.showGame('slots');
  ok(P2.getS().slots.machine === 'galleon' && JSON.stringify(P2.slotST().free) === free && P2.getS().chips === chips, 'reloaded page has the same free spins and chips');
  const c0 = P2.getS().chips;
  P2.slotSpin();
  ok(P2.getS().chips >= c0, 'the resumed free spin did not charge');
  P2.slotPick('gilded');
  ok(P2.getS().slots.machine === 'galleon', 'cannot leave a machine mid-feature');
  report('free spins survive a reload, keep playing free, and hold you at the machine', f);
}

console.log('\nthe deal is indifferent to who you are (hard rule 2)');
{
  const f = fail;
  function run(xp, chips) {
    const P = loadPage(new Map());
    P.showGame('slots');
    P.getS().econ.xp = xp;
    P.getS().chips = chips;
    P.setRand(seededInt(424242));
    const out = [];
    for (const id of SLOTS.MACHINE_IDS) {
      P.slotPick(id);
      for (let i = 0; i < 400; i++) { P.slotSpin(); const st = P.slotST(); out.push(st.last.stops.join(',') + ':' + st.last.win); }
      while (P.slotST().free) P.slotSpin();
    }
    return out;
  }
  const broke = run(0, 1000), diamond = run(500000, 5e7);
  ok(broke.length === diamond.length && broke.every((x, i) => x === diamond[i]), 'Lv1 with 1,000 and Diamond with 50,000,000 got different spins');
  report('Lv1 / 1,000 chips vs Diamond / 50M chips, same RNG: identical stops and wins on every machine', f);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} checks, ${fail} failed`);
if (!allEdges) console.log('An RTP check failing beyond 4 SE happens about 1 run in 16,000 for a correct game. Re-run once; twice is real.');
process.exit(fail ? 1 : 0);
