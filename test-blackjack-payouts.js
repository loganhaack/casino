#!/usr/bin/env node
/*
 * Blackjack payout verification, for every blackjack table in index.html.
 *
 *   A. Drives the ACTUAL game code out of index.html (showGame / bjDeal /
 *      bjAct) behind a stub DOM and checks that the bankroll moves by exactly
 *      the tracked net, under basic strategy and under random legal play.
 *   B. Measures each table's basic-strategy house edge with a long engine
 *      simulation (spread over all CPU cores) and checks it against
 *      (1) the figure index.html displays and (2) a published reference.
 *   C. Chi-squares the live dealer (real crypto shuffle + real draw loop)
 *      against the exact tables from enumerate-blackjack.js.
 *   D. Side bets: category frequencies and realized return over 1M dealt
 *      rounds per table vs the exact enumeration.
 *   D. Side bets: category frequencies and realized return over 1M dealt
 *      rounds per table vs the exact enumeration.
 *
 * Usage:  node test-blackjack-payouts.js [engineRounds] [uiRounds]
 * Needs:  expected-blackjack.json (run `node enumerate-blackjack.js` first)
 */

'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const BJ = require('./blackjack-core.js');

// ---------------------------------------------------------------------------
// Worker: simulate basic strategy under one rule set, report sum and sum of squares.
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const { rules: ro, rounds, chart } = workerData;
  const rules = BJ.makeRules(ro);
  let shoe = BJ.newShoe(rules), s = 0, q = 0;
  for (let i = 0; i < rounds; i++) {
    if (BJ.needsShuffle(shoe)) shoe = BJ.newShoe(rules);
    const r = BJ.startRound(shoe, 10, rules);
    while (r.phase !== 'done') BJ.act(r, shoe, BJ.basicStrategy(r, undefined, chart));
    const u = r.net / 10;
    s += u; q += u * u;
  }
  parentPort.postMessage({ s, q });
  return;
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ENGINE_ROUNDS = parseInt(process.argv[2], 10) || 40000000;
const UI_ROUNDS = parseInt(process.argv[3], 10) || 100000;
const CORES = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length));

let allPass = true;
const verdict = (ok) => { allPass = allPass && ok; return ok ? 'PASS' : 'FAIL'; };
const pct = (x, d = 3) => (100 * x).toFixed(d) + '%';

// ---------------------------------------------------------------------------
// Load index.html's script behind a stub DOM (same approach as test-payouts.js)
// ---------------------------------------------------------------------------

function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', className: '', value: '', checked: false,
    disabled: false, hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {},
  };
}
const els = new Map();
const store = new Map();
const sandbox = {
  console, crypto: globalThis.crypto, performance: globalThis.performance,
  Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  confirm: () => false, setTimeout: () => {},
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k),
  },
  document: {
    getElementById: id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelectorAll: () => [], createElement: () => makeEl('tmp'), addEventListener: () => {},
  },
  BJ,   // index.html gets this from <script src="blackjack-core.js">
  ECON: require('./economy.js'),
  TABLE_RULES: require('./tables.js'),   // index.html gets this from <script src="tables.js">
  TCP: require('./tcp-core.js'),         // index.html gets this from <script src="tcp-core.js">
};
sandbox.globalThis = sandbox;

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('No inline <script> block found in index.html'); process.exit(1); }
if (!/<script src="blackjack-core\.js"><\/script>/.test(html)) {
  console.error('index.html does not load blackjack-core.js; the test would not reflect the game.');
  process.exit(1);
}
if (!/<script src="tables\.js"><\/script>/.test(html)) {
  console.error('index.html does not load tables.js; the test would not reflect the table rules in play.');
  process.exit(1);
}
vm.createContext(sandbox);
vm.runInContext(m[1] + `
;globalThis.__h = { getS: () => S, showGame, bjDeal, bjAct, BJ_TABLES, RULES, blankBj };`, sandbox, { filename: 'index.html:script' });
const H = sandbox.__h;
const TABLES = Object.keys(H.BJ_TABLES);

// ---------------------------------------------------------------------------
// A. Chip accounting through the real game code
// ---------------------------------------------------------------------------

function uiRun(table, label, rounds, choose, side) {
  H.showGame(table);
  const S = H.getS();
  const st = S[table];
  const BANK = 1e9;
  // Quests and event promos can legitimately grant chips during a run. They
  // go through the economy ledger, so: bankroll change - ledger change = game net.
  const ledgerBefore = Object.entries(S.econ.ledger).reduce((a, [k, v]) => a + (k === 'opening' ? 0 : v), 0);
  S.chips = BANK;
  st.stats = H.blankBj().stats;
  st.bet = 10;
  st.side = Object.assign({ perfectPairs: 0, twentyOnePlus3: 0 }, side || {});
  let sumNet = 0, sumBase = 0, sumSq = 0, sumMain = 0;
  for (let i = 0; i < rounds; i++) {
    H.bjDeal();
    let guard = 0;
    while (st.round) {
      H.bjAct(choose(st.round, S.chips));
      if (++guard > 100) throw new Error('round did not terminate');
    }
    const r = st.last;
    const sideNet = Object.values(r.side || {}).reduce((a, sb) => a + sb.returned - sb.bet, 0);
    const main = r.net - sideNet;
    sumNet += r.net; sumMain += main; sumBase += r.baseBet; sumSq += (main / r.baseBet) ** 2;
    if (st.history.length > 100) st.history.length = 0;
  }
  const econGrants = Object.entries(S.econ.ledger).reduce((a, [k, v]) => a + (k === 'opening' ? 0 : v), 0) - ledgerBefore;
  const delta = (S.chips + S.econ.vault.balance) - BANK - econGrants;
  const sideTracked = Object.values(st.stats.side).reduce((a, x) => a + x.net, 0);
  const ok = delta === st.stats.net && delta === sumNet &&
             st.stats.mainNet === sumMain && st.stats.mainNet + sideTracked === st.stats.net;
  const mean = sumMain / sumBase;   // main game only
  const se = Math.sqrt((sumSq / rounds - mean * mean) / rounds);
  const s = st.stats;
  console.log(`  ${(H.BJ_TABLES[table].name + ', ' + label).padEnd(48)} ${ok ? 'CONSISTENT' : 'MISMATCH (chips created or destroyed!)'}  ${verdict(ok)}`);
  console.log(`      ${rounds.toLocaleString()} rounds; chip delta ${delta.toLocaleString()} = tracked net (after ${econGrants.toLocaleString()} economy grants); ` +
    `doubles ${s.doubles}+${s.freeDoubles} free, splits ${s.splits}+${s.freeSplits} free, insured ${s.insured}, dealer-22 pushes ${s.dealer22}, ` +
    `side bets ${s.side.perfectPairs.bets + s.side.twentyOnePlus3.bets}`);
  return { edge: -mean, se };
}

let x = 987654321;   // decision randomness only; cards come from crypto
const rnd = (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % n; };
const randomInsure = (r, chips) => {
  const legal = BJ.legalActions(r, chips);
  if (legal.insure) return 'insure';
  const opts = Object.keys(legal).filter(k => legal[k]);
  return opts[rnd(opts.length)];
};

// ---------------------------------------------------------------------------
// B. Parallel engine simulation
// ---------------------------------------------------------------------------

function simulate(rules, rounds, chart) {
  const per = Math.ceil(rounds / CORES);
  return Promise.all(Array.from({ length: CORES }, () => new Promise((ok, err) => {
    const w = new Worker(__filename, { workerData: { rules: { ...rules }, rounds: per, chart } });
    w.on('message', ok); w.on('error', err);
  }))).then(parts => {
    const n = per * CORES;
    const s = parts.reduce((a, p) => a + p.s, 0), q = parts.reduce((a, p) => a + p.q, 0);
    const mean = s / n;
    return { edge: -mean, se: Math.sqrt((q / n - mean * mean) / n), n };
  });
}

// Published references. Only applied when the page's rules match exactly.
const REFS = [
  { name: 'ScoresAndStats 800M-hand sim', edge: 0.0044, allowance: 0.0005,
    url: 'https://www.scoresandstats.com/blog/blackjack-odds/',
    note: 'penetration and strategy table not stated, so 0.05pp allowance',
    rules: { decks: 6, hitSoft17: false, doubleOn: 'any', doubleAfterSplit: true, maxHands: 4,
             resplitAces: false, hitSplitAces: false, push22: false, freeDoubles: false, freeSplits: false } },
  { name: 'Wizard of Odds, Free Bet', edge: 0.0104, allowance: 0.0003,
    url: 'https://wizardofodds.com/games/free-bet-blackjack/',
    note: 'split-Aces-get-one-card not stated, so 0.03pp allowance',
    rules: { decks: 6, hitSoft17: true, doubleOn: 'any', doubleAfterSplit: true, maxHands: 4,
             resplitAces: true, hitSplitAces: false, push22: true, freeDoubles: true, freeSplits: true } },
];
const matches = (rules, ref) => Object.keys(ref).every(k => rules[k] === ref[k]) &&
  rules.blackjackPays[0] === 3 && rules.blackjackPays[1] === 2;

// ---------------------------------------------------------------------------

(async () => {
  console.log('='.repeat(72));
  console.log('  BLACKJACK PAYOUT VERIFICATION');
  console.log('='.repeat(72));

  console.log('\n[A] Real game code (index.html), stub DOM: bankroll delta must equal tracked net');
  const ui = {};
  for (const t of TABLES) {
    ui[t] = uiRun(t, 'basic strategy', UI_ROUNDS, (r, chips) => BJ.basicStrategy(r, chips));
    uiRun(t, 'random play, insure, both side bets', Math.max(1, UI_ROUNDS >> 1), randomInsure,
          { perfectPairs: 10, twentyOnePlus3: 10 });
  }

  console.log(`\n[B] House edge, basic strategy, ${ENGINE_ROUNDS.toLocaleString()} rounds per rule set on ${CORES} cores`);
  for (const t of TABLES) {
    const def = H.BJ_TABLES[t];
    const rules = def.rules;
    const t0 = Date.now();
    const res = await simulate(rules, ENGINE_ROUNDS);
    console.log(`\n  ${def.name}: ${pct(res.edge)} ± ${pct(res.se)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    // B1. The number index.html shows players must match what we measure.
    const shown = def.edge;
    if (shown === null || shown === undefined) {
      console.log(`    displayed edge   not set; set it to ${res.edge.toFixed(4)}  ${verdict(false)}`);
    } else {
      const ok = Math.abs(res.edge - shown) < 4 * res.se;
      console.log(`    displayed edge   ${pct(shown, 2)} in index.html, within 4 SE of measured  ${verdict(ok)}` +
        (ok ? '' : `\n                     update the page to ${res.edge.toFixed(4)}`));
    }

    // B2. Published reference for this exact rule set, if there is one.
    const ref = REFS.find(rf => matches(rules, rf.rules));
    if (ref) {
      const ok = Math.abs(res.edge - ref.edge) < 4 * res.se + ref.allowance;
      console.log(`    published        ${pct(ref.edge, 2)} (${ref.name}; ${ref.note})  ${verdict(ok)}`);
    } else {
      console.log('    published        no reference for this exact rule set; skipped');
    }

    // B3. Game code and engine agree (independent samples).
    const okUi = Math.abs(ui[t].edge - res.edge) < 4 * Math.hypot(ui[t].se, res.se);
    console.log(`    game vs engine   ${pct(ui[t].edge)} ± ${pct(ui[t].se)} through index.html  ${verdict(okUi)}`);

    // B4. Rule/strategy sanity checks with known direction and size.
    if (!rules.push22) {
      const flip = await simulate({ ...rules, hitSoft17: !rules.hitSoft17 }, ENGINE_ROUNDS);
      const d = rules.hitSoft17 ? res.edge - flip.edge : flip.edge - res.edge;     // H17 minus S17
      const ok = Math.abs(d - 0.0022) < 4 * Math.hypot(res.se, flip.se) + 0.0005;
      console.log(`    H17 - S17        ${(100 * d).toFixed(3)}pp (published ~0.22pp)  ${verdict(ok)}`);
    } else {
      const naive = await simulate(rules, ENGINE_ROUNDS >> 2, 'standard');
      const d = naive.edge - res.edge;
      const ok = d > 4 * Math.hypot(res.se, naive.se);
      console.log(`    strategy check   classic chart in this game: ${pct(naive.edge)} (+${(100 * d).toFixed(3)}pp); ` +
        `Free Bet chart must be better  ${verdict(ok)}`);
    }
  }

  // -------------------------------------------------------------------------
  // C. Live dealer vs exact distribution
  // -------------------------------------------------------------------------
  const expPath = path.join(__dirname, 'expected-blackjack.json');
  if (!fs.existsSync(expPath)) {
    console.log('\n[C] expected-blackjack.json missing. Run: node enumerate-blackjack.js');
    allPass = false;
  } else {
    const EXP = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    console.log('\n[C] Live dealer (crypto shuffle + engine draw loop) vs exact');
    for (const [key, trials] of [['1D_S17', 300000], ['1D_H17', 300000], ['6D_S17', 100000], ['6D_H17', 100000]]) {
      const e = EXP[key];
      const rules = BJ.makeRules({ decks: e.decks, hitSoft17: e.hitSoft17 });
      const obs = {};
      for (let i = 0; i < trials; i++) {
        const shoe = BJ.newShoe(rules);   // a fresh shuffle every trial: no cut-card effect
        const d = [shoe.cards[0], shoe.cards[1]];
        const up = BJ.cardValue(d[0]);
        let o;
        if (BJ.isNatural(d, false)) o = 'bj';
        else {
          BJ.playDealer(d, rules, () => shoe.cards[shoe.pos++ + 2]);
          const v = BJ.handValue(d);
          o = v.bust ? 'bust' : String(v.total);
        }
        const k = (up === 1 ? 'A' : String(up)) + '|' + o;
        obs[k] = (obs[k] || 0) + 1;
      }
      let chi = 0, cells = 0, pooledObs = 0, pooledExp = 0;
      for (const u of Object.keys(e.byUp)) {
        for (const o of Object.keys(e.byUp[u])) {
          const ex = trials * e.pUp[u] * e.byUp[u][o];
          const ob = obs[u + '|' + o] || 0;
          if (ex === 0) { if (ob) chi = Infinity; continue; }   // impossible outcome observed
          if (ex < 5) { pooledObs += ob; pooledExp += ex; continue; }
          chi += (ob - ex) ** 2 / ex; cells++;
        }
      }
      if (pooledExp > 0) { chi += (pooledObs - pooledExp) ** 2 / pooledExp; cells++; }
      const df = cells - 1;
      const p = chi === Infinity ? 0 : gammaQ(df / 2, chi / 2);
      console.log(`  ${key.padEnd(7)} ${trials.toLocaleString().padStart(8)} dealer hands   chi2 ${chi.toFixed(1).padStart(6)}  df ${df}  p = ${p.toFixed(4)}  ${verdict(p > 0.001)}`);
    }
    console.log('  (p is the chance of a fit this bad from a correct dealer; fails below 0.001)');
  }

  // -------------------------------------------------------------------------
  // D. Side bets through the engine's real deal, vs exact enumeration
  // -------------------------------------------------------------------------
  const SIDE_N = 1000000;
  console.log(`\n[D] Side bets: ${SIDE_N.toLocaleString()} rounds per table (basic strategy, real shoe + cut card) vs exact`);
  for (const t of TABLES) {
    const rules = H.BJ_TABLES[t].rules;
    const kinds = Object.keys(BJ.SIDE_BETS).filter(k => rules[k]);
    if (!kinds.length) continue;
    const obs = Object.fromEntries(kinds.map(k => [k, {}]));
    const sum = Object.fromEntries(kinds.map(k => [k, [0, 0]]));
    const side = Object.fromEntries(kinds.map(k => [k, 1]));
    let shoe = BJ.newShoe(rules);
    for (let i = 0; i < SIDE_N; i++) {
      if (BJ.needsShuffle(shoe)) shoe = BJ.newShoe(rules);
      const r = BJ.startRound(shoe, 10, rules, { side });
      for (const k of kinds) {
        const sb = r.side[k];
        const c = sb.outcome || 'lose';
        obs[k][c] = (obs[k][c] || 0) + 1;
        const u = sb.returned - sb.bet;
        sum[k][0] += u; sum[k][1] += u * u;
      }
      while (r.phase !== 'done') BJ.act(r, shoe, BJ.basicStrategy(r));
    }
    for (const k of kinds) {
      const counts = BJ.sideBetCounts(k, rules.decks);
      const exactRet = BJ.sideBetReturn(rules[k], counts);
      let chi = 0, cells = 0;
      for (const c of [...BJ.SIDE_BETS[k], 'lose']) {
        const ex = SIDE_N * counts[c] / counts.total, ob = obs[k][c] || 0;
        chi += (ob - ex) ** 2 / ex; cells++;
      }
      const p = gammaQ((cells - 1) / 2, chi / 2);
      const mean = sum[k][0] / SIDE_N, se = Math.sqrt((sum[k][1] / SIDE_N - mean * mean) / SIDE_N);
      const okRet = Math.abs(mean - exactRet) < 4 * se;
      const label = `${H.BJ_TABLES[t].name}, ${k === 'perfectPairs' ? 'Perfect Pairs' : '21+3'}`;
      console.log(`  ${label.padEnd(38)} categories chi2 ${chi.toFixed(1).padStart(5)}  df ${cells - 1}  p = ${p.toFixed(4)}  ${verdict(p > 0.001)}`);
      console.log(`  ${''.padEnd(38)} return ${pct(mean, 2)} ± ${pct(se, 2)} vs exact ${pct(exactRet, 4)}  ${verdict(okRet)}`);
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log(allPass ? '  ALL CHECKS PASSED' : '  SOMETHING FAILED — see above');
  console.log('='.repeat(72));
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------------------
// Chi-square p-value: upper regularized incomplete gamma Q(df/2, chi/2)
// ---------------------------------------------------------------------------

function lgamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, t = z + 5.5;
  t -= (z + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log(2.5066282746310005 * s / z);
}
function gammaQ(a, xx) {
  if (xx < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 1000; n++) { ap++; del *= xx / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return 1 - sum * Math.exp(-xx + a * Math.log(xx) - lgamma(a));
  }
  let b = xx + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-xx + a * Math.log(xx) - lgamma(a)) * h;
}
