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
 *   - Three Card Poker online: the page never holds the dealer's cards
 *     before the hand ends; page and server agree every hand; a reload
 *     mid-hand resumes it; offline poker still uses browser chips
 *   - signing out returns to offline play
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const BJ = require('./blackjack-core.js');
const TCP = require('./tcp-core.js');
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
    BJ, ECON: require('./economy.js'), TABLE_RULES: require('./tables.js'), TCP: require('./tcp-core.js'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script + `
;globalThis.__h = { getS: () => S, getON: () => ON, online, TS, bankroll, showGame, bjDeal, bjAct, onToggle, onRescue,
  acctSignOut, econClaimQuest, econClaimAll, econVault, econBuy, econEquip, econSpinClick, econUnclaimed, E,
  TCPS, onTcpDeal, onTcpAct, deal, resolve, getPhase: () => phase,
  get bjTable() { return bjTable; } };`, sandbox, { filename: 'index.html:script' });
  return { H: sandbox.__h, el: id => sandbox.document.getElementById(id) };
}

function newNet() { return { store: memStore(), calls: 0, responses: [], down: 0, dropReply: 0 }; }
function signedInStorage() {
  return new Map([['casino.auth.v1', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
    expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: USER, email: 'p@example.com' } })]]);
}

/**
 * Finish the current round: decline insurance, then `move` (default stand).
 * Guarded: an action the page ignores (illegal right now) would otherwise
 * spin forever on resolved promises and starve the watchdog timer.
 */
async function finish(P, move = 'stand') {
  for (let guard = 0; P.H.TS().round; guard++) {
    if (guard > 50) throw new Error('round did not finish');
    const r = P.H.TS().round;
    await P.H.bjAct(r.phase === 'insurance' ? 'decline' : typeof move === 'function' ? move(r) : move);
  }
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
          await finish(P, r => BJ.basicStrategy(r, P.H.bankroll()));
        }
        const before = net.store.wallets.get(USER).chips, rows0 = net.store.ledger.length;
        const r = await playRound(P, rnd);
        const after = net.store.wallets.get(USER).chips;
        ok(r && r.phase === 'done' && r.dealer.every(c => c !== null), 'finished round shown in full');
        // Economy grants during the round (promos, a quest rollover) are their own ledger rows.
        const extra = net.store.ledger.slice(rows0).filter(x => x.account === 'chips' && x.kind !== 'bet' && x.kind !== 'payout').reduce((a, x) => a + x.amount, 0);
        ok(after - before === r.net + extra, `server moved ${after - before}, page shows net ${r.net} + grants ${extra}`);
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
    for (let g = 0; P.H.TS().round; g++) { if (g > 50) throw new Error('offline round did not finish'); P.H.bjAct(BJ.basicStrategy(P.H.TS().round, P.H.getS().chips)); }
    ok(P.H.getS().chips !== S0chips || P.H.getS().bj.last.net === 0, 'offline round moved browser chips');
    ok(net.calls === calls && JSON.stringify(net.store.wallets.get(USER)) === serverBefore, 'offline round did not touch the server');
    P.H.onToggle();
    ok(P.H.online() && P.H.bankroll() === net.store.wallets.get(USER).chips, 'back online: server chips intact');
    report('Offline plays on browser chips, server untouched; switching back is seamless', f);
  }

  console.log('\nthree card poker online');
  {
    const f = fail, rnd = mulberry32(7), N = Math.max(300, ROUNDS >> 2);
    const S0 = P.H.getS().chips, L0 = JSON.stringify(P.H.getS().econ.ledger), tcpRound0 = P.H.getS().tcpRound;
    P.H.showGame('tcp');
    ok(!P.el('game-tcp').hidden, 'Poker table shows online (no offline-only panel)');
    const T = P.H.TCPS();
    ok(T === P.H.getON().tcp, 'Poker uses the online state');
    let decisions = 0, sideOnly = 0;
    for (let i = 0; i < N; i++) {
      const w = net.store.wallets.get(USER);
      if (w.chips < 300) {
        await net.store.commit(USER, w.version, { chips: w.chips + 2000, vault: 0, econ: w.econ,
          ledger: [{ account: 'chips', amount: 2000, kind: 'quests' }] });
      }
      const pick = () => (rnd() < 0.3 ? 0 : 5 * (1 + Math.floor(rnd() * 8)));
      T.bets = { ante: pick(), pp: pick(), scb: pick() };
      if (!T.bets.ante && !T.bets.pp && !T.bets.scb) T.bets.pp = 5;
      const before = net.store.wallets.get(USER).chips, rows0 = net.store.ledger.length;
      // A grant made behind the page's back shows up on the deal's reply.
      await P.H.onTcpDeal();
      const ON = P.H.getON();
      if (ON.tcp.round) {
        decisions++;
        ok(ON.tcp.round.dealer.length === 3 && ON.tcp.round.dealer.every(c => c === null), 'dealer cards in the page mid-hand');
        ok(P.H.getPhase() === 'decision', 'page waits for play/fold');
        const play = TCP.eval3(...ON.tcp.round.player).value >= TCP.Q64 && P.H.bankroll() >= ON.tcp.round.bets.ante;
        await P.H.onTcpAct(play ? 'play' : 'fold');
      } else sideOnly++;
      const last = ON.tcp.last, after = net.store.wallets.get(USER).chips;
      ok(last && last.dealer.every(c => c !== null) && !ON.tcp.round, 'finished hand shown in full');
      const extra = net.store.ledger.slice(rows0).filter(x => x.account === 'chips' && x.kind !== 'bet' && x.kind !== 'payout').reduce((a, x) => a + x.amount, 0);
      ok(after - before === last.result.net + extra, `server moved ${after - before}, page shows net ${last.result.net} + grants ${extra}`);
      ok(P.H.bankroll() === after, 'page bankroll == server');
      ok(after === net.store.ledgerSum(USER), 'server chips == ledger');
      ok(P.H.getS().chips === S0, 'browser chips untouched');
      ok(P.H.getPhase() === 'betting', 'ready for the next hand');
    }
    ok(T.stats.hands === N, `page stats counted ${T.stats.hands} of ${N} hands`);
    ok(decisions > 0 && sideOnly > 0, 'reached play/fold hands and side-bets-only hands');
    ok(JSON.stringify(P.H.getS().econ.ledger) === L0 && P.H.getS().tcpRound === tcpRound0, 'browser ledger and offline hand untouched');
    const leak = net.responses.some(res => {
      const vs = res.tables ? [res.tables.tcp] : res.table === 'tcp' && res.view ? [res.view] : [];
      return vs.some(v => v && v.round && v.round.dealer.some(c => c !== null));
    });
    ok(!leak, 'no server response carried a dealer card before the hand ended');

    // Reload in the middle of a hand: the server still has it.
    T.bets = { ante: 10, pp: 0, scb: 0 };
    await P.H.onTcpDeal();
    const mid = P.H.getON().tcp.round;
    ok(mid && P.H.getPhase() === 'decision', 'hand waiting on play/fold');
    const P2 = loadPage(net, storage);
    await tick();
    P2.H.showGame('tcp');
    const r2 = P2.H.getON().tcp.round;
    ok(r2 && JSON.stringify(r2.player) === JSON.stringify(mid.player) && r2.dealer.every(c => c === null), 'reloaded page resumes the same hand, dealer still hidden');
    ok(P2.H.getPhase() === 'decision', 'reloaded page offers play/fold');
    await P2.H.onTcpAct('fold');
    ok(!P2.H.getON().tcp.round && net.store.wallets.get(USER).chips === net.store.ledgerSum(USER), 'fold after reload settles; ledger identity');
    P = P2;

    // Offline poker still plays on browser chips and leaves the server alone.
    const serverBefore = JSON.stringify(net.store.wallets.get(USER)), calls = net.calls;
    P.H.onToggle();
    ok(!P.H.online() && P.H.TCPS() === P.H.getS(), 'offline: poker uses the browser save');
    const c0 = P.H.getS().chips;
    P.H.getS().bets = { ante: 10, pp: 5, scb: 0 };
    P.H.deal();
    if (P.H.getPhase() === 'decision') P.H.resolve(false);
    const h = P.H.getS().history[P.H.getS().history.length - 1];
    ok(P.H.getS().chips === c0 + h.net, 'offline hand moved browser chips by its net');
    ok(net.calls === calls && JSON.stringify(net.store.wallets.get(USER)) === serverBefore, 'offline hand did not touch the server');
    P.H.onToggle();
    ok(P.H.online() && P.H.bankroll() === net.store.wallets.get(USER).chips, 'back online: server chips intact');
    report(`${N} online hands: page and server agree every hand, dealer never in the page early; reload resumes; offline poker unaffected`, f);
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
    await finish(P2);
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
    await finish(P);
    // 3. A click with a stale seq (as from a second tab) is refused and resynced.
    P.H.TS().seq -= 1;
    b0 = bets();
    await P.H.bjDeal();
    ok(bets() === b0 && P.H.TS().seq === net.store.tables.get(USER + '/bj').seq, 'stale click refused, page resynced');
    await P.H.bjDeal();
    ok(bets() === b0 + 1, 'next click works');
    await finish(P);
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
    P.H.TS().side = { perfectPairs: 0, twentyOnePlus3: 0 };   // 10 a round, so it can get under 10
    let guard = 0;
    while (net.store.wallets.get(USER).chips >= 10 && guard++ < 500) {
      await P.H.bjDeal();
      await finish(P, 'hit');
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

  console.log('\nrewards online');
  {
    const f = fail, S0 = P.H.getS().chips, L0 = JSON.stringify(P.H.getS().econ.ledger);
    const lastRow = () => net.store.ledger[net.store.ledger.length - 1];
    const synced = () => P.H.bankroll() === net.store.wallets.get(USER).chips && P.H.E().vault.balance === net.store.wallets.get(USER).vault;
    P.H.showGame('rewards');
    ok(!P.el('game-rewards').hidden, 'Rewards tab is available online');
    ok(JSON.stringify(P.H.E()) === JSON.stringify(net.store.wallets.get(USER).econ) || P.H.E().quests.day === net.store.wallets.get(USER).econ.quests.day,
      'page shows the server\'s economy state');

    // Give the account some chips to work with (a server-side grant, then refresh).
    let w = net.store.wallets.get(USER);
    await net.store.commit(USER, w.version, { chips: w.chips + 60000, vault: w.vault, econ: w.econ, ledger: [{ account: 'chips', amount: 60000, kind: 'promo' }] });
    await P.H.econVault(0);   // refused (zero), but refreshes the wallet
    ok(synced(), 'page picked up the server balance');

    // Bonus Wheel through the page's own spin button handler.
    const rows0 = net.store.ledger.length;
    P.H.econSpinClick('bonus');
    await tick();
    ok(net.store.ledger.length === rows0 + 1 && lastRow().kind === 'bonusWheel', 'Bonus Wheel spun on the server, paid via a bonusWheel row');
    ok(synced(), 'page balance matches the server after the spin');
    P.H.econSpinClick('bonus');
    await tick();
    ok(net.store.ledger.length === rows0 + 1, 'second spin refused by the server (cooldown)');

    // Vault.
    ok(await P.H.econVault(5000), 'deposit 5,000 via the page');
    ok(net.store.wallets.get(USER).vault === 5000 && synced(), 'server vault holds 5,000; page agrees');
    ok(!(await P.H.econVault(-999999)), 'over-withdraw refused');
    ok(await P.H.econVault(-1000), 'withdraw 1,000');
    ok(net.store.wallets.get(USER).vault === 4000 && synced(), 'server vault 4,000');

    // Shop: buy something on sale today, then equip a default back.
    const ECON = require('./economy.js');
    const t = new Date(), cyc = ECON.shopCycle(t);
    const id = [cyc.deal, ...cyc.spotlight, ...ECON.SHOP.map(x => x.id)]
      .find(x => { const p = ECON.shopPrice(x, t); return p && p.price > 0 && p.price <= P.H.bankroll() && !P.H.E().owned.includes(x); });
    ok(await P.H.econBuy(id), 'buy ' + id);
    ok(net.store.wallets.get(USER).econ.owned.includes(id) && lastRow().kind === 'shop' && synced(), 'server recorded the purchase via a shop row');
    ok(!(await P.H.econBuy(id)), 'buying it twice refused');
    ok(await P.H.econEquip('back-blue'), 'equip an owned card back');
    ok(net.store.wallets.get(USER).econ.equipped.back === 'back-blue', 'server recorded the equip');

    // Quests: finish one on the server and claim it through the page.
    w = net.store.wallets.get(USER);
    const e = JSON.parse(JSON.stringify(w.econ));
    // Earlier sections may have finished every quest today; reuse one if so.
    let qi = e.quests.list.findIndex(q => !q.done);
    if (qi < 0) qi = 0;
    if (qi >= 0) {
      Object.assign(e.quests.list[qi], { done: true, progress: e.quests.list[qi].target, claimed: false, reward: { chips: 77, xp: 7 } });
      await net.store.commit(USER, w.version, { chips: w.chips, vault: w.vault, econ: e, ledger: [] });
      await P.H.econVault(0);   // refresh
      ok(P.H.econUnclaimed().length >= 1, 'page sees the finished quest');
      const rw = await P.H.econClaimQuest(qi, e.quests.day);
      ok(rw && rw.chips === 77 && lastRow().kind === 'quests' && lastRow().amount === 77 && synced(), 'claimed through the page: server paid 77 via a quests row');
      ok(!(await P.H.econClaimQuest(qi, e.quests.day)), 'claiming again refused');
    } else ok(false, 'no open quest to finish');

    ok(net.store.wallets.get(USER).chips === net.store.ledgerSum(USER, 'chips') &&
       net.store.wallets.get(USER).vault === net.store.ledgerSum(USER, 'vault'), 'server ledger identity, chips and vault');
    ok(P.H.getS().chips === S0 && JSON.stringify(P.H.getS().econ.ledger) === L0, 'browser chips and browser ledger untouched by online rewards');
    report('Rewards online: Bonus Wheel, vault, shop, equip and quest claims all run on the server; page mirrors it', f);
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
