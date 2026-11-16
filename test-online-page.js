#!/usr/bin/env node
/*
 * Online play through the REAL page code against the REAL server logic.
 *
 *   node test-online-page.js [rounds]     # default 2000 per table, ~10s
 *
 * index.html runs behind a stub DOM (as in the payout harnesses), signed in
 * with a fake session. Its fetch() goes to supabase/functions/play/logic.js
 * over an in-memory store with commit_turn()'s rules (from test-server.js),
 * so the only fake piece is the network.
 *
 * Checks:
 *   - signing in loads the server wallet (1,000) and switches the blackjack
 *     tables to online; the bank shows the server's chips
 *   - online rounds never touch the browser's chips or the browser ledger,
 *     and the page's display matches the server's wallet after every round
 *   - the page never holds the shoe, or the hole card before the round ends
 *   - Offline mode plays on browser chips and leaves the server alone;
 *     switching back finds the server state intact
 *   - a reload in the middle of an online round resumes it from the server
 *   - a dropped connection resyncs from the server; nothing is lost or doubled
 *   - signing out returns to offline play
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const BJ = require('./blackjack-core.js');
const PLAY = require('./supabase/functions/play/logic.js');
const { memStore, mulberry32 } = require('./test-server.js');

const ROUNDS = parseInt(process.argv[2], 10) || 2000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; if (fail < 30) console.log('  FAIL ' + m); } };
const report = (name, before) => console.log(`  ${fail === before ? 'ok  ' : 'FAIL'} ${name}`);
const tick = async (n = 50) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const USER = '11111111-2222-3333-4444-555555555555';
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/** One page load. `net` is shared server state; `storage` is this browser's localStorage. */
function loadPage(net, storage) {
  function makeEl(id) {
    return {
      id, textContent: '', innerHTML: '', className: '', value: '', checked: false,
      disabled: false, hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {}, addEventListener() {}, remove() {}, querySelector() { return null; },
    };
  }
  const els = new Map();
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const reply = (status, body) => ({ ok: status < 400, status,
      json: async () => body, text: async () => JSON.stringify(body) });
    if (net.down) { net.down--; throw new TypeError('Failed to fetch'); }
    const authz = init.headers && init.headers.Authorization;
    if (u.includes('/auth/v1/user')) return reply(200, { id: USER, email: 'p@example.com' });
    if (u.includes('/rest/v1/profiles')) return reply(200, [{ id: USER, display_name: 'Tester', avatar: 'fox' }]);
    if (u.includes('/functions/v1/play')) {
      if (authz !== 'Bearer tok') return reply(401, { ok: false, error: 'signed_out', message: 'Sign in.' });
      net.calls++;
      const res = await PLAY.handle(net.store, USER, JSON.parse(init.body));
      net.responses.push(res);
      if (net.dropReply) { net.dropReply--; throw new TypeError('Failed to fetch'); }   // server applied it; reply lost
      return reply(200, res);
    }
    if (u.includes('/auth/v1/logout')) return reply(204, {});
    throw new Error('unexpected fetch ' + u);
  };
  const sandbox = {
    console, crypto: globalThis.crypto, performance: globalThis.performance, fetch,
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    confirm: () => false, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    // Reduced motion: the page skips animations (a real browser mode), so the
    // stub clock never leaves input blocked behind an animation.
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    location: { protocol: 'https:', hash: '', pathname: '/casino/', search: '', origin: 'https://example.github.io' },
    history: { replaceState() {} },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k),
    },
    document: {
      getElementById: id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], querySelector: () => null, createElement: () => makeEl('tmp'),
      addEventListener: () => {}, body: makeEl('body'),
    },
    BJ, ECON: require('./economy.js'), TABLE_RULES: require('./tables.js'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script + `
;globalThis.__h = { getS: () => S, getON: () => ON, online, TS, bankroll, showGame, bjDeal, bjAct, onToggle, onRescue,
  acctSignOut, get bjTable() { return bjTable; } };`, sandbox, { filename: 'index.html:script' });
  return { H: sandbox.__h, el: id => sandbox.document.getElementById(id) };
}

function newNet() { return { store: memStore(), calls: 0, responses: [], down: 0, dropReply: 0 }; }
function signedInStorage() {
  return new Map([['casino.auth.v1', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
    expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: USER, email: 'p@example.com' } })]]);
}

/** Play one whole round on the current table with basic strategy. Returns the finished round. */
async function playRound(P, rnd) {
  await P.H.bjDeal();
  let guard = 0;
  while (P.H.TS().round) {
    const r = P.H.TS().round;
    ok(r.dealer.length === 2 && r.dealer[1] === null, 'hole card present in the page mid-round');
    const a = rnd() < 0.8 ? BJ.basicStrategy(r, P.H.bankroll()) : (rnd() < 0.5 ? 'hit' : 'stand');
    const legal = BJ.legalActions(r, P.H.bankroll());
    await P.H.bjAct(legal[a] ? a : (legal.stand ? 'stand' : 'decline'));
    if (++guard > 50) throw new Error('round did not finish');
  }
  return P.H.TS().last;
}

// A stuck round is a failure, not a hang.
setTimeout(() => { console.log('\nFAIL: timed out (a round never finished?)'); process.exit(1); }, 120000).unref();

(async function main() {
  const t0 = Date.now();
  const net = newNet(), storage = signedInStorage();

  console.log('\nsign in');
  let P = loadPage(net, storage);
  await tick();
  const S0chips = P.H.getS().chips, ledger0 = JSON.stringify(P.H.getS().econ.ledger);
  {
    const f = fail;
    ok(P.H.online(), 'online after sign-in');
    ok(P.H.bankroll() === 1000, 'bankroll is the server wallet (1000), got ' + P.H.bankroll());
    ok(P.el('bank').textContent === '1,000' || P.el('bank').textContent === '1000', 'bank shows server chips: ' + P.el('bank').textContent);
    ok(!P.el('modeBtn').hidden && /Online/.test(P.el('modeBtn').textContent), 'mode button shows Online');
    report('signing in loads the server wallet and goes online', f);
  }

  console.log(`\nplay ${ROUNDS} online rounds per table`);
  {
    const f = fail, rnd = mulberry32(42);
    for (const t of ['bj', 'fb']) {
      P.H.showGame(t);
      const ts = P.H.TS();
      ts.bet = 20; ts.side = { perfectPairs: 2, twentyOnePlus3: 0 };
      for (let i = 0; i < ROUNDS; i++) {
        const w = net.store.wallets.get(USER);
        if (w.chips < 300) {   // top up through a grant so the run continues
          await net.store.commit(USER, w.version, { chips: w.chips + 2000, vault: 0, econ: w.econ,
            ledger: [{ account: 'chips', amount: 2000, kind: 'quests' }] });
          await P.H.bjDeal();   // stale seq? no: grants don't touch tables. Deal refreshes the wallet.
          while (P.H.TS().round) await P.H.bjAct(BJ.basicStrategy(P.H.TS().round, P.H.bankroll()));
        }
        const before = net.store.wallets.get(USER).chips;
        const r = await playRound(P, rnd);
        const after = net.store.wallets.get(USER).chips;
        ok(r && r.phase === 'done' && r.dealer.every(c => c !== null), 'finished round shown in full');
        ok(after - before === r.net, `server moved ${after - before}, page shows net ${r.net}`);
        ok(P.H.bankroll() === after, `page bankroll ${P.H.bankroll()} == server ${after}`);
        ok(after === net.store.ledgerSum(USER), 'server chips == ledger');
        ok(P.H.getS().chips === S0chips, 'browser chips untouched');
      }
      ok(P.H.TS().stats.rounds >= ROUNDS, `${t}: page stats counted the rounds`);
    }
    ok(JSON.stringify(P.H.getS().econ.ledger) === ledger0, 'browser ledger untouched by online play');
    const leak = net.responses.some(res => /"pos"|"cut":\s*\d+,"cards"/.test(JSON.stringify(res)) ||
      (res.view && res.view.round && res.view.round.dealer[1] != null));
    ok(!leak, 'no server response carried the shoe or a live hole card');
    report(`${2 * ROUNDS} rounds: page and server agree every round; browser chips/ledger untouched`, f);
  }

  console.log('\noffline switch');
  {
    const f = fail;
    const serverBefore = JSON.stringify(net.store.wallets.get(USER)), calls = net.calls;
    P.H.onToggle();
    ok(!P.H.online() && P.H.TS() === P.H.getS()[P.H.bjTable], 'offline: tables use the browser save');
    ok(P.H.bankroll() === P.H.getS().chips, 'offline: bank shows browser chips');
    P.H.getS().bj.bet = 10;
    P.H.showGame('bj');
    P.H.bjDeal();
    while (P.H.TS().round) P.H.bjAct(BJ.basicStrategy(P.H.TS().round, P.H.getS().chips));
    ok(P.H.getS().chips !== S0chips || P.H.getS().bj.last.net === 0, 'offline round moved browser chips');
    ok(net.calls === calls && JSON.stringify(net.store.wallets.get(USER)) === serverBefore, 'offline round did not touch the server');
    P.H.onToggle();
    ok(P.H.online() && P.H.bankroll() === net.store.wallets.get(USER).chips, 'back online: server chips intact');
    report('Offline plays on browser chips, server untouched; switching back is seamless', f);
  }

  console.log('\nreload mid-round');
  {
    const f = fail;
    P.H.showGame('fb');
    let r = null;
    for (let i = 0; i < 200 && !r; i++) {   // deal until a round is left waiting for a decision
      await P.H.bjDeal();
      if (P.H.TS().round) r = P.H.TS().round;
    }
    const wagered = r.wagered, cards = JSON.stringify(r.hands.map(h => h.cards));
    const P2 = loadPage(net, storage);   // same browser, fresh page load
    await tick();
    P2.H.showGame('fb');
    const r2 = P2.H.TS().round;
    ok(P2.H.online() && r2 && JSON.stringify(r2.hands.map(h => h.cards)) === cards && r2.wagered === wagered,
      'reloaded page resumes the same round from the server');
    ok(r2 && r2.dealer[1] === null, 'resumed round still hides the hole card');
    while (P2.H.TS().round) await P2.H.bjAct('stand');
    ok(net.store.wallets.get(USER).chips === net.store.ledgerSum(USER), 'ledger identity after resumed round');
    P = P2;
    report('a reload mid-round resumes it from the server, hole card still hidden', f);
  }

  console.log('\nconnection problems');
  {
    const f = fail;
    P.H.showGame('bj');
    const bets = () => net.store.ledger.filter(x => x.kind === 'bet').length;
    // 1. Request never reaches the server (down), resync also fails once.
    let b0 = bets();
    net.down = 2;
    await P.H.bjDeal();
    ok(bets() === b0 && !P.H.TS().round, 'failed request: nothing bet, no phantom round');
    // 2. Server applies the deal but the reply is lost: page resyncs and shows the real round.
    b0 = bets();
    net.dropReply = 1;
    await P.H.bjDeal();
    const w = net.store.wallets.get(USER);
    ok(bets() === b0 + 1, 'lost reply: exactly one bet placed');
    ok(P.H.bankroll() === w.chips, 'lost reply: page resynced to the server balance');
    const srv = net.store.tables.get(USER + '/bj');
    ok(P.H.TS().seq === srv.seq, 'lost reply: page has the current seq');
    while (P.H.TS().round) await P.H.bjAct('stand');
    // 3. A click with a stale seq (as from a second tab) is refused and resynced.
    P.H.TS().seq -= 1;
    b0 = bets();
    await P.H.bjDeal();
    ok(bets() === b0 && P.H.TS().seq === net.store.tables.get(USER + '/bj').seq, 'stale click refused, page resynced');
    await P.H.bjDeal();
    ok(bets() === b0 + 1, 'next click works');
    while (P.H.TS().round) await P.H.bjAct('stand');
    report('dropped requests and lost replies resync; nothing lost or doubled', f);
  }

  console.log('\nrescue wheel');
  {
    const f = fail;
    P.H.showGame('bj');
    // Lose everything at the table (no shortcuts: real rounds through the page).
    const w0 = net.store.wallets.get(USER);
    await net.store.commit(USER, w0.version, { chips: 30, vault: 0, econ: w0.econ,
      ledger: [{ account: 'chips', amount: 30 - w0.chips, kind: 'shop' }] });
    const S0 = P.H.getS().chips;
    P.H.TS().bet = 10;
    let guard = 0;
    while (net.store.wallets.get(USER).chips >= 10 && guard++ < 500) {
      await P.H.bjDeal();
      while (P.H.TS().round) await P.H.bjAct(P.H.TS().round.phase === 'insurance' ? 'decline' : 'hit');
    }
    const low = net.store.wallets.get(USER).chips;
    ok(low < 10 && P.H.bankroll() === low, 'played down below 10 online');
    ok(/Rescue Wheel/.test(P.el('bjMsg').innerHTML), 'broke message offers the Rescue Wheel');
    ok(/25 \(50%\)/.test(P.el('bjMsg').innerHTML), 'broke message shows the published odds');
    await P.H.onRescue();
    const w = net.store.wallets.get(USER);
    const row = net.store.ledger[net.store.ledger.length - 1];
    ok(row.kind === 'rescueWheel' && w.chips === low + row.amount, 'server paid the rescue through the ledger');
    ok(P.H.bankroll() === w.chips, 'page shows the rescued balance');
    ok(P.H.getS().chips === S0, 'rescue did not touch browser chips');
    const n = net.store.ledger.length;
    await P.H.onRescue();
    ok(net.store.ledger.length === n, 'second rescue refused once above 10');
    report('play down to broke, rescue pays via the server ledger, odds shown, no double rescue', f);
  }

  console.log('\nsign out');
  {
    const f = fail;
    await P.H.acctSignOut();
    ok(!P.H.online() && P.H.bankroll() === P.H.getS().chips, 'signed out: offline on browser chips');
    ok(P.el('modeBtn').hidden, 'mode button hidden when signed out');
    report('signing out returns to offline play', f);
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} checks, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
