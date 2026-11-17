#!/usr/bin/env node
/*
 * Payout verification harness.
 *
 * Loads the ACTUAL game script out of index.html behind a stub DOM, plays a
 * few hundred thousand hands through deal()/resolve(), and checks that the
 * realized return converges on the house edge the enumerator computed.
 *
 * This is the test that matters. The enumerator proves the math is right in
 * theory; this proves the game's chip accounting implements that math.
 *
 * Usage:  node test-payouts.js [hands]
 */

'use strict';

const fs = require('fs');
const vm = require('vm');

const HANDS = parseInt(process.argv[2], 10) || 300000;

// ---------------------------------------------------------------------------
// Minimal DOM stub — just enough surface for the game script to boot.
// ---------------------------------------------------------------------------

function makeEl(id) {
  return {
    id,
    textContent: '', innerHTML: '', className: '', value: '', checked: false,
    disabled: false, style: {},
    dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    appendChild(){}, addEventListener(){},
    set onclick(fn) { this._onclick = fn; },
    get onclick() { return this._onclick; },
  };
}

const els = new Map();
const getEl = (id) => {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
};

const store = new Map();

const sandbox = {
  console,
  crypto: globalThis.crypto,
  performance: globalThis.performance,
  Blob: class { constructor(){} },
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  confirm: () => false,
  setTimeout: () => {},
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: k => store.delete(k),
  },
  document: {
    getElementById: getEl,
    querySelectorAll: () => [],
    createElement: () => makeEl('tmp'),
    addEventListener: () => {},
  },
};
// index.html loads blackjack-core.js via <script src>; provide the same file.
sandbox.BJ = require('./blackjack-core.js');
sandbox.ECON = require('./economy.js');
sandbox.TABLE_RULES = require('./tables.js');
sandbox.TCP = require('./tcp-core.js');
sandbox.SLOTS = require('./slots-core.js');
sandbox.SLOT_ART = require('./slots-art.js');
sandbox.ROULETTE = require('./roulette-core.js');
sandbox.globalThis = sandbox;

// ---------------------------------------------------------------------------
// Pull the script out of index.html and run it in the sandbox.
// ---------------------------------------------------------------------------

const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('No <script> block found in index.html'); process.exit(1); }

// Append an export hook so we can drive the internals.
const code = m[1] + `
;globalThis.__harness = {
  getS:        () => S,
  setBets:     (b) => { S.bets = b; },
  setChips:    (n) => { S.chips = n; },
  deal, resolve,
  getPEval:    () => pEval,
  getPhase:    () => phase,
  Q64, QUALIFY, EXACT, RULES, eval3, categorize6,
};
`;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'index.html:script' });

const H = sandbox.__harness;

// ---------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------

function run(label, bets, strategy) {
  // Fresh bankroll, big enough that the broke-floor never fires and
  // contaminates the accounting.
  const BANK = 100000000;
  // Quests and event promos can legitimately grant chips during a run. They
  // go through the economy ledger, so: bankroll change - ledger change = game net.
  const ledgerBefore = Object.entries(H.getS().econ.ledger).reduce((a, [k, v]) => a + (k === 'opening' ? 0 : v), 0);
  H.setChips(BANK);
  const S = H.getS();
  S.stats = { hands: 0, wagered: 0, net: 0, folds: 0,
              dealerQualified: 0, dealerNotQualified: 0, catCounts: [0,0,0,0,0,0] };
  S.history.length = 0;
  H.setBets(bets);

  // Per-hand sums for the standard error of the realized edge.
  let sN = 0, sW = 0, sNN = 0, sWW = 0, sNW = 0;
  for (let i = 0; i < HANDS; i++) {
    H.deal();
    if (H.getPhase() === 'decision') {
      const raise = strategy(H.getPEval());
      if (raise) { S.chips -= S.bets.ante; H.resolve(true); }
      else H.resolve(false);
    }
    const h = S.history[S.history.length - 1];
    sN += h.net; sW += h.staked; sNN += h.net * h.net; sWW += h.staked * h.staked; sNW += h.net * h.staked;
    if (S.history.length > 100) S.history.length = 0;   // keep memory flat
  }

  const st = S.stats;
  const econGrants = Object.entries(H.getS().econ.ledger).reduce((a, [k, v]) => a + (k === 'opening' ? 0 : v), 0) - ledgerBefore;
  const chipDelta = (S.chips + S.econ.vault.balance) - BANK - econGrants;
  const rtp = (st.wagered + st.net) / st.wagered;
  const edge = -st.net / st.wagered;

  // Edge is a ratio (net / wagered), so its standard error comes from the
  // residuals net_i + edge * wagered_i (delta method).
  const n = HANDS, mW = sW / n;
  const varR = sNN / n + 2 * edge * sNW / n + edge * edge * sWW / n - Math.pow(sN / n + edge * mW, 2);
  const se = Math.sqrt(Math.max(varR, 0) / n) / mW;

  return { label, st, chipDelta, econGrants, rtp, edge, se };
}

// Fails only if the realized edge is more than 4 standard errors from exact:
// a correct game fails that about 1 time in 16,000. (The old fixed
// tolerances were ~1 SE wide and failed on noise alone.)
function report(r, expectedEdge) {
  const tolerance = 4 * r.se;
  const st = r.st;
  console.log('');
  console.log('  ' + r.label);
  console.log('  ' + '-'.repeat(60));
  console.log(`  hands              ${st.hands.toLocaleString()}`);
  console.log(`  wagered            ${st.wagered.toLocaleString()}`);
  console.log(`  net                ${st.net.toLocaleString()}`);
  console.log(`  chip delta         ${r.chipDelta.toLocaleString()}  (bankroll change minus ${r.econGrants.toLocaleString()} economy grants)`);

  // Integrity check: the bankroll must move by exactly the tracked net.
  const consistent = r.chipDelta === st.net;
  console.log(`  accounting         ${consistent ? 'CONSISTENT' : 'MISMATCH (bug!)'}`);

  console.log(`  realized edge      ${(r.edge * 100).toFixed(4)}% ± ${(r.se * 100).toFixed(4)}% (1 SE)`);
  if (expectedEdge !== null) {
    const diff = Math.abs(r.edge - expectedEdge);
    console.log(`  exact edge         ${(expectedEdge * 100).toFixed(4)}%`);
    console.log(`  difference         ${(diff * 100).toFixed(4)} pp = ${(diff / r.se).toFixed(2)} SE  ` +
                `${diff < tolerance ? 'PASS' : 'FAIL (more than 4 SE out)'}`);
  }
  return consistent && (expectedEdge === null || Math.abs(r.edge - expectedEdge) < tolerance);
}

console.log('='.repeat(64));
console.log('  PAYOUT VERIFICATION');
console.log(`  Driving the real game code, ${HANDS.toLocaleString()} hands per scenario.`);
console.log('='.repeat(64));

let allPass = true;

// --- Scenario 1: ante/play only, correct Q-6-4 strategy --------------------
// Note: the realized edge here is measured per chip WAGERED (ante + play),
// which is the "element of risk", ~2.01% — not the 3.37% per-ante figure.
allPass &= report(
  run('Ante/Play only, Q-6-4 strategy', { ante: 10, pp: 0, scb: 0 },
      pe => pe.value >= H.Q64),
  0.020147
);

// --- Scenario 2: Pair Plus in isolation ------------------------------------
allPass &= report(
  run('Pair Plus only', { ante: 0, pp: 10, scb: 0 }, () => false),
  0.072760
);

// --- Scenario 3: Six Card Bonus in isolation -------------------------------
// High variance (a royal pays 1000:1); the SE-based tolerance widens accordingly.
allPass &= report(
  run('6 Card Bonus only', { ante: 0, pp: 0, scb: 10 }, () => false),
  0.085614
);

// --- Scenario 4: never fold (a deliberately bad strategy) ------------------
// Must come out WORSE than correct play. If it doesn't, the fold logic is broken.
const never = run('Ante/Play, never fold (bad strategy)', { ante: 10, pp: 0, scb: 0 }, () => true);
report(never, null);
const correct = run('Ante/Play, Q-6-4 (for comparison)', { ante: 10, pp: 0, scb: 0 },
                    pe => pe.value >= H.Q64);
console.log('');
console.log(`  Strategy check: never-fold edge ${(never.edge * 100).toFixed(4)}% ` +
            `vs correct ${(correct.edge * 100).toFixed(4)}%`);
if (never.edge > correct.edge) {
  console.log('  PASS — folding correctly saves money, as it must.');
} else {
  console.log('  FAIL — the fold logic is not doing anything.');
  allPass = false;
}

console.log('');
console.log('='.repeat(64));
console.log(allPass ? '  ALL CHECKS PASSED' : '  SOMETHING FAILED — see above');
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
