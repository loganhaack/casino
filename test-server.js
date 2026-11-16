#!/usr/bin/env node
/*
 * Tests for the online table server (supabase/functions/play/logic.js),
 * run in Node against an in-memory store that enforces the same rules as
 * commit_turn() in supabase/migrations/20261115000001_wallets.sql.
 *
 *   node test-server.js [rounds]     # default 20000 fuzzed rounds, ~10s
 *
 * Checks:
 *   - _shared/ copies match the root files (sync-shared.js --check)
 *   - wallet opens once at the starting balance
 *   - every bet is validated (min, unit, rank limit, bankroll, side bets)
 *   - stale seq (double click / second tab) is refused: one click, one bet
 *   - a version conflict retries and still applies exactly once
 *   - fuzz: random legal play on both tables; after every request
 *     chips == sum of ledger, and chips + chips in play == opening + game net
 *   - nothing sent to the player ever contains the shoe or, before the round
 *     is over, the dealer's hole card
 *   - same game as the page: with the same RNG and decisions, the server's
 *     rounds are identical to driving blackjack-core.js directly
 *   - hard rule 2: a Lv1 player and a Diamond player, same seed, same
 *     decisions, get identical cards and results
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const BJ = require('./blackjack-core.js');
const TABLE_RULES = require('./tables.js');
const PLAY = require('./supabase/functions/play/logic.js');

const ROUNDS = parseInt(process.argv[2], 10) || 20000;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + msg);
}
function section(name) { console.log('\n' + name); }
function report(name, before) { console.log(`  ${fail === before ? 'ok  ' : 'FAIL'} ${name}`); }

/* ---- seeded RNG so failures reproduce ---- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seededInt = (seed) => { const r = mulberry32(seed); return (n) => Math.floor(r() * n); };

/* ---- in-memory store with commit_turn()'s rules ---- */
const SIGN = {
  opening: ['chips', 1], bet: ['chips', -1], payout: ['chips', 1],
  bonusWheel: ['chips', 1], rescueWheel: ['chips', 1], quests: ['chips', 1], promo: ['chips', 1],
  shop: ['chips', -1], interest: ['vault', 1], vault: [null, 0],
};
const clone = (x) => JSON.parse(JSON.stringify(x));   // what jsonb does to it
function memStore() {
  const wallets = new Map(), tables = new Map(), ledger = [];
  const s = {
    wallets, tables, ledger,
    beforeCommit: null,                       // test hook: simulate a racing writer
    async wallet(u) { return wallets.has(u) ? clone(wallets.get(u)) : null; },
    async openWallet(u, opening) {
      if (!wallets.has(u)) {
        wallets.set(u, { chips: opening, vault: 0, econ: {}, version: 0 });
        ledger.push({ user: u, account: 'chips', amount: opening, kind: 'opening' });
      }
      return clone(wallets.get(u));
    },
    async table(u, t) { const k = u + '/' + t; return tables.has(k) ? clone(tables.get(k)) : null; },
    async commit(u, version, c) {
      if (s.beforeCommit) { const f = s.beforeCommit; s.beforeCommit = null; await f(); }
      const w = wallets.get(u);
      if (w.version !== version) { const e = new Error('stale'); e.code = '40001'; throw e; }
      let dc = 0, dv = 0, xfer = 0;
      for (const r of c.ledger) {
        const rule = SIGN[r.kind];
        if (!rule || r.kind === 'opening') throw new Error('bad kind ' + r.kind);
        if (!Number.isInteger(r.amount) || r.amount === 0) throw new Error('bad amount ' + r.amount);
        if (rule[0] && (r.account !== rule[0] || Math.sign(r.amount) !== rule[1])) throw new Error('sign rule: ' + JSON.stringify(r));
        if (r.account === 'chips') dc += r.amount; else dv += r.amount;
        if (r.kind === 'vault') xfer += r.amount;
      }
      if (xfer !== 0) throw new Error('vault transfer does not net to zero');
      if (c.chips - w.chips !== dc || c.vault - w.vault !== dv) {
        throw new Error(`23514 balances moved ${c.chips - w.chips}/${c.vault - w.vault}, ledger ${dc}/${dv}`);
      }
      if (c.chips < 0 || c.vault < 0) throw new Error('23514 negative balance');
      for (const r of c.ledger) ledger.push({ user: u, ...clone(r) });
      wallets.set(u, { chips: c.chips, vault: c.vault, econ: clone(c.econ), version: version + 1 });
      if (c.tableId) {
        const k = u + '/' + c.tableId;
        if (c.tableState == null) tables.delete(k); else tables.set(k, clone(c.tableState));
      }
    },
    ledgerSum(u, account = 'chips') {
      return ledger.filter(r => r.user === u && r.account === account).reduce((a, r) => a + r.amount, 0);
    },
  };
  return s;
}

/* ---- view checks: no shoe, no hole card ---- */
function checkView(res, label) {
  const json = JSON.stringify(res);
  ok(!/"cards":\[[0-9,]{40,}/.test(json), label + ': a long card list (the shoe?) was sent');
  ok(!/"pos"/.test(json), label + ': shoe position object was sent');
  const views = res.tables ? Object.values(res.tables) : res.view ? [res.view] : [];
  for (const v of views) {
    if (v.round && v.round.phase !== 'done') {
      ok(v.round.dealer.length === 2 && v.round.dealer[1] === null, label + ': hole card visible mid-round');
    }
    if (v.round) ok(!('rules' in v.round), label + ': rules blob sent');
  }
}

/* ---- a page-like policy: basic strategy, sometimes something random ---- */
function choose(view, rnd) {
  const r = view.round, legal = view.legal;
  const acts = Object.keys(legal).filter(a => legal[a]);
  if (rnd() < 0.25) return acts[Math.floor(rnd() * acts.length)];
  if (r.phase === 'insurance') return 'decline';
  return acts.includes('stand') ? (rnd() < 0.5 ? 'hit' : 'stand') : acts[0];
}

async function main() {
  const t0 = Date.now();

  section('shared code');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'sync-shared.js'), '--check'], { stdio: 'pipe' });
    console.log('  ok   _shared/ is byte-identical to the root files');
    pass++;
  } catch (e) {
    fail++;
    console.log('  FAIL _shared/ drifted from the root files. Run: node sync-shared.js\n' + e.stdout);
  }

  section('wallet');
  {
    const f = fail, st = memStore();
    const a = await PLAY.handle(st, 'u1', { op: 'state' });
    const b = await PLAY.handle(st, 'u1', { op: 'state' });
    ok(a.ok && a.wallet.chips === TABLE_RULES.startingChips, 'opens at startingChips');
    ok(b.wallet.chips === TABLE_RULES.startingChips && st.ledger.length === 1, 'opens once');
    ok(a.wallet.rank.level === 1 && a.wallet.rank.maxBet === 500, 'new player is Lv1 Bronze, limit 500');
    ok(a.tables.bj.seq === 0 && a.tables.fb.seq === 0 && a.tables.bj.round === null, 'empty tables');
    checkView(a, 'state');
    report('opens once at ' + TABLE_RULES.startingChips + ', Lv1, empty tables', f);
  }

  section('bet validation');
  {
    const f = fail, st = memStore();
    await PLAY.handle(st, 'u', { op: 'state' });
    const tryDeal = (o) => PLAY.handle(st, 'u', { op: 'deal', table: 'bj', seq: 0, bet: 10, ...o });
    const cases = [
      [{ bet: 8 }, 'bad_bet'], [{ bet: 11 }, 'bad_bet'], [{ bet: 10.5 }, 'bad_bet'], [{ bet: '10' }, 'bad_bet'],
      [{ bet: 502 }, 'over_limit'], [{ side: { perfectPairs: 600 } }, 'over_limit'],
      [{ side: { perfectPairs: -5 } }, 'bad_request'], [{ side: { perfectPairs: 2.5 } }, 'bad_request'],
      [{ side: { jackpot: 5 } }, 'bad_request'], [{ side: [5] }, 'bad_request'],
      [{ seq: 3 }, 'stale'], [{ table: 'tcp' }, 'bad_request'],
    ];
    for (const [o, code] of cases) {
      const r = await tryDeal(o);
      ok(!r.ok && r.error === code, `deal ${JSON.stringify(o)} should be ${code}, got ${r.error}`);
    }
    ok(!(await PLAY.handle(st, 'u', { op: 'nope' })).ok, 'unknown op refused');
    ok(!(await PLAY.handle(st, 'u', { op: 'act', table: 'bj', seq: 0, action: 'hit' })).ok, 'act with no round refused');
    ok(st.ledger.length === 1 && st.wallets.get('u').chips === 1000, 'refused requests wrote nothing');
    // Bankroll: 1000 chips, can't bet 500 + 500 + 2 side.
    const r = await tryDeal({ bet: 500, side: { perfectPairs: 500, twentyOnePlus3: 2 } });
    ok(!r.ok && r.error === 'not_enough_chips', 'over bankroll refused');
    report('min, unit, limit, side bets, bankroll, stale seq, unknown table/op', f);
  }

  section('one click, one bet');
  {
    const f = fail, st = memStore();
    await PLAY.handle(st, 'u', { op: 'state' });
    const a = await PLAY.handle(st, 'u', { op: 'deal', table: 'bj', seq: 0, bet: 10 });
    const b = await PLAY.handle(st, 'u', { op: 'deal', table: 'bj', seq: 0, bet: 10 });   // double click
    ok(a.ok && !b.ok && b.error === 'stale', 'second deal with same seq refused');
    ok(st.ledger.filter(r => r.kind === 'bet').length === 1, 'exactly one bet row');
    ok(b.view && b.view.seq === a.view.seq, 'refusal carries the current view');

    // A racing writer bumps the wallet version between load and commit: retry, apply once.
    const st2 = memStore();
    await PLAY.handle(st2, 'u', { op: 'state' });
    st2.beforeCommit = async () => { st2.wallets.get('u').version++; };
    const c = await PLAY.handle(st2, 'u', { op: 'deal', table: 'fb', seq: 0, bet: 20 });
    ok(c.ok && st2.ledger.filter(r => r.kind === 'bet').length === 1, 'version conflict retried, applied once');
    ok(st2.ledgerSum('u') === st2.wallets.get('u').chips, 'ledger identity after retry');
    report('double click refused; version conflict retries once', f);
  }

  section(`fuzz: ${ROUNDS} rounds across both tables`);
  {
    const f = fail, st = memStore(), rnd = mulberry32(12345), randInt = seededInt(777);
    const opening = TABLE_RULES.startingChips;
    let net = 0, requests = 0, rounds = 0, seenInsurance = 0, seenSplit = 0, seenFree = 0, seenSide = 0;
    let s = await PLAY.handle(st, 'p', { op: 'state' });
    const seq = { bj: 0, fb: 0 };
    while (rounds < ROUNDS) {
      const t = rnd() < 0.5 ? 'bj' : 'fb';
      // Keep the bankroll alive without a wheel: the test tops up through a quests grant.
      const w = st.wallets.get('p');
      if (w.chips < 600) {
        await st.commit('p', w.version, { chips: w.chips + 5000, vault: 0, econ: w.econ,
          ledger: [{ account: 'chips', amount: 5000, kind: 'quests' }], tableId: null });
        net -= 0;   // grants aren't game net; tracked via ledger below
      }
      const limit = s.wallet.rank.maxBet;
      const bet = Math.min(limit, 2 * (5 + Math.floor(rnd() * 40)));
      const side = rnd() < 0.3 ? { perfectPairs: 2 * Math.floor(rnd() * 10) } : rnd() < 0.3 ? { twentyOnePlus3: 5 } : {};
      let r = await PLAY.handle(st, 'p', { op: 'deal', table: t, seq: seq[t], bet, side }, { randInt });
      requests++;
      if (!r.ok) { ok(false, 'deal refused: ' + r.message); break; }
      checkView(r, 'deal');
      seq[t] = r.view.seq;
      if (Object.keys(side).length && Object.values(side).some(v => v > 0)) seenSide++;
      while (r.view.round) {
        if (r.view.round.phase === 'insurance') seenInsurance++;
        if (r.view.free && (r.view.free.double || r.view.free.split)) seenFree++;
        const a = choose(r.view, rnd);
        if (a === 'split') seenSplit++;
        r = await PLAY.handle(st, 'p', { op: 'act', table: t, seq: seq[t], action: a }, { randInt });
        requests++;
        if (!r.ok) { ok(false, 'act refused: ' + r.message); break; }
        checkView(r, 'act');
        seq[t] = r.view.seq;
        // Mid-round: chips + in play == ledger (in play is a debit already in the ledger)
        ok(st.wallets.get('p').chips === st.ledgerSum('p'), 'ledger identity mid-round');
      }
      const last = r.view.last;
      ok(last && last.phase === 'done' && last.dealer.every(c => c !== null), 'finished round fully revealed');
      net += last.net;
      rounds++;
      s = r;
      const wc = st.wallets.get('p').chips;
      ok(wc === st.ledgerSum('p'), 'chips == sum(ledger)');
      const grants = st.ledger.filter(x => x.user === 'p' && x.account === 'chips' && !['opening', 'bet', 'payout'].includes(x.kind)).reduce((a, x) => a + x.amount, 0);   // quests, promos, top-ups
      ok(wc === opening + grants + net, `chips ${wc} == opening + grants + game net ${opening + grants + net}`);
      if (fail - f > 20) break;
    }
    const games = st.ledger.filter(x => x.user === 'p' && (x.kind === 'bet' || x.kind === 'payout')).reduce((a, x) => a + x.amount, 0);
    ok(games === net, 'bet + payout rows == sum of round nets');
    ok(seenInsurance > 0 && seenSplit > 0 && seenFree > 0 && seenSide > 0, 'fuzz reached insurance, splits, free offers, side bets');
    const xp = st.wallets.get('p').econ.xp;
    ok(xp >= 10 * rounds, 'XP awarded every round');
    report(`${rounds} rounds, ${requests} requests: ledger identity every request, no shoe/hole card ever sent (XP ${xp}, Lv${s.wallet.rank.level})`, f);
  }

  section('economy online (same ACCOUNT ACTIONS as the page, on a test clock)');
  {
    const f = fail;
    const ECON = require('./economy.js');
    const TUE = ECON.atWall(2026, 10, 17, 12), WED = ECON.atWall(2026, 10, 18, 12);
    const FRI_EVE = ECON.atWall(2026, 10, 20, 19), SAT = ECON.atWall(2026, 10, 21, 12);
    const clockAt = (d) => { const c = { t: d.getTime() }; c.now = () => new Date(c.t); return c; };
    const identity = (st, u = 'u') => {
      const w = st.wallets.get(u);
      return w.chips === st.ledgerSum(u, 'chips') && w.vault === st.ledgerSum(u, 'vault');
    };
    const call = (st, c, req, ri) => PLAY.handle(st, 'u', req, { now: c.now, randInt: ri });

    // XP: same seed, same decisions; Wednesday (Double XP) earns exactly twice Tuesday's.
    const xpOn = async (day) => {
      const st = memStore(), c = clockAt(day), ri = seededInt(8);
      await call(st, c, { op: 'state' });
      let seq = 0;
      for (let i = 0; i < 20; i++) {
        let r = await call(st, c, { op: 'deal', table: 'bj', seq, bet: 10 }, ri);
        seq = r.view.seq;
        while (r.view.round) { r = await call(st, c, { op: 'act', table: 'bj', seq, action: r.view.legal.stand ? 'stand' : 'decline' }, ri); seq = r.view.seq; }
      }
      return st.wallets.get('u').econ.xp;
    };
    const xpTue = await xpOn(TUE), xpWed = await xpOn(WED);
    ok(xpTue > 0 && xpWed === 2 * xpTue, `Double XP Wednesday: ${xpWed} should be 2 x ${xpTue}`);

    // Quests: dealt on first request, completed by play, claimed once, through the ledger.
    let st = memStore(), c = clockAt(TUE);
    let s = await call(st, c, { op: 'state' });
    const qs = s.wallet.econ.quests;
    ok(qs.day === ECON.dayKey(TUE) && qs.list.length > 0, 'state deals today\'s quests (casino-clock day)');
    ok(JSON.stringify(qs.list) === JSON.stringify(ECON.dailyQuests(ECON.dayKey(TUE), 0)), 'same quests the page would deal at this rank');
    const ri = seededInt(77);
    let seq = 0, done = null;
    for (let i = 0; i < 400 && !done; i++) {
      let r = await call(st, c, { op: 'deal', table: i % 2 ? 'fb' : 'bj', seq: st.tables.get('u/' + (i % 2 ? 'fb' : 'bj'))?.seq || 0, bet: 20, side: { perfectPairs: 2 } }, ri);
      const tb = r.table;
      while (r.view.round) {
        const full = st.tables.get('u/' + tb).round;
        r = await call(st, c, { op: 'act', table: tb, seq: r.view.seq, action: BJ.basicStrategy(full, r.wallet.chips) }, ri);
      }
      done = r.events.find(e => e.type === 'questDone');
      const w = st.wallets.get('u');
      if (w.chips < 300) await st.commit('u', w.version, { chips: w.chips + 1000, vault: w.vault, econ: w.econ, ledger: [{ account: 'chips', amount: 1000, kind: 'promo' }] });
    }
    ok(!!done, 'a quest completed through online play (event sent)');
    if (done) {
      const q0 = st.ledgerSum('u');
      let r = await call(st, c, { op: 'claim', i: done.i, day: done.day });
      ok(r.ok && r.reward.chips > 0 && st.ledgerSum('u') - q0 === r.reward.chips, 'claim pays the reward through a quests row');
      ok(st.ledger[st.ledger.length - 1].kind === 'quests', '...recorded as kind quests');
      r = await call(st, c, { op: 'claim', i: done.i, day: done.day });
      ok(!r.ok && r.error === 'nothing_to_claim', 'claiming twice is refused');
      r = await call(st, c, { op: 'claim', i: 'x', day: 5 });
      ok(!r.ok && r.error === 'bad_request', 'malformed claim refused');
    }
    ok(identity(st), 'ledger identity after quests');

    // Day rollover pays finished-but-unclaimed quests, exactly once.
    {
      const w = st.wallets.get('u');
      const e = JSON.parse(JSON.stringify(w.econ));
      const open = e.quests.list.find(q => !q.done);
      if (open) { open.done = true; open.progress = open.target; open.claimed = false; open.reward = { chips: 123, xp: 5 }; }
      await st.commit('u', w.version, { chips: w.chips, vault: w.vault, econ: e, ledger: [] });
      c.t = WED.getTime();
      const before = st.ledgerSum('u');
      const r = await call(st, c, { op: 'state' });
      ok(r.events.some(x => x.type === 'questsPaid' && x.chips === 123) && st.ledgerSum('u') - before === 123, 'rollover pays unclaimed quests');
      ok(r.wallet.econ.quests.day === ECON.dayKey(WED), 'rollover deals the new day\'s quests');
      const again = await call(st, c, { op: 'state' });
      ok(st.ledgerSum('u') - before === 123 && again.events.length === 0, 'and only once');
    }

    // Bonus Wheel: free spin, then a cooldown; Lucky Wheel Saturday doubles the prize and halves the wait.
    {
      st = memStore(); c = clockAt(TUE);
      let r = await call(st, c, { op: 'spin', wheel: 'bonus' });
      ok(r.ok && r.spin.mult === 1 && st.ledger[st.ledger.length - 1].kind === 'bonusWheel', 'bonus spin pays through a bonusWheel row');
      r = await call(st, c, { op: 'spin', wheel: 'bonus' });
      ok(!r.ok && r.error === 'not_ready' && /recharges in/.test(r.message), 'second spin refused until it recharges');
      c.t += ECON.WHEELS.bonus.cooldownMs;
      ok((await call(st, c, { op: 'spin', wheel: 'bonus' })).ok, 'free again after the cooldown');
      ok(!(await call(st, c, { op: 'spin', wheel: 'jackpot' })).ok, 'unknown wheel refused');
      const sat = memStore(), cs = clockAt(SAT);
      r = await call(sat, cs, { op: 'spin', wheel: 'bonus' });
      ok(r.ok && r.spin.mult === 2 && r.spin.chips === 2 * ECON.WHEELS.bonus.slices[r.spin.idx].chips, 'Lucky Wheel Saturday pays double');
      cs.t += ECON.WHEELS.bonus.cooldownMs / 2;
      ok((await call(sat, cs, { op: 'spin', wheel: 'bonus' })).ok, '...and recharges in half the time');
      ok(identity(st) && identity(sat), 'ledger identity after spins');
    }

    // Vault: transfers net to zero; interest is credited into the vault; overdraws refused.
    {
      st = memStore(); c = clockAt(TUE);
      await call(st, c, { op: 'state' });
      let r = await call(st, c, { op: 'vault', amount: 600 });
      ok(r.ok && r.wallet.chips === 400 && r.wallet.vault === 600 && st.wallets.get('u').vault === 600, 'deposit 600');
      ok(!(await call(st, c, { op: 'vault', amount: 401 })).ok, 'deposit more than on hand refused');
      ok(!(await call(st, c, { op: 'vault', amount: -601 })).ok, 'withdraw more than saved refused');
      ok(!(await call(st, c, { op: 'vault', amount: 2.5 })).ok, 'fractional amount refused');
      c.t += 2 * 86400000;   // two days later
      r = await call(st, c, { op: 'state' });
      const interest = r.events.find(e => e.type === 'interest');
      ok(interest && interest.chips > 0 && st.wallets.get('u').vault === 600 + interest.chips, 'interest credited into the vault');
      ok(st.ledger[st.ledger.length - 1].kind === 'interest' && st.ledger[st.ledger.length - 1].account === 'vault', '...as a vault interest row');
      r = await call(st, c, { op: 'vault', amount: -100 });
      ok(r.ok && r.wallet.chips === 500, 'withdraw 100');
      ok(identity(st), 'ledger identity for chips AND vault');
      // The vault counts against "broke": 0 on hand but chips saved = no rescue.
      const w = st.wallets.get('u');
      await st.commit('u', w.version, { chips: 0, vault: w.vault, econ: w.econ, ledger: [{ account: 'chips', amount: -w.chips, kind: 'shop' }] });
      r = await call(st, c, { op: 'rescue' });
      ok(!r.ok && r.error === 'not_broke', 'no rescue while chips sit in the vault');
    }

    // Shop: today's price through a shop row, owned, equipped; no double buy; can't equip what you don't own.
    {
      st = memStore(); c = clockAt(TUE);
      // Something on sale today that a 51,000-chip test bankroll can afford.
      const cyc0 = ECON.shopCycle(TUE);
      const pick = [cyc0.deal, ...cyc0.spotlight, ...ECON.SHOP.map(x => x.id)]
        .find(id => { const p = ECON.shopPrice(id, TUE); return p && p.price > 0 && p.price <= 50000 && !['felt-green', 'back-blue', 'title-none'].includes(id); });
      const cyc = { deal: pick }, price = ECON.shopPrice(pick, TUE).price;
      await st.openWallet('u', 1000);
      const w = st.wallets.get('u');
      await st.commit('u', 0, { chips: w.chips + 50000, vault: 0, econ: w.econ, ledger: [{ account: 'chips', amount: 50000, kind: 'promo' }] });
      let r = await call(st, c, { op: 'buy', id: cyc.deal });
      ok(r.ok && r.wallet.econ.owned.includes(cyc.deal) && r.wallet.econ.equipped[ECON.SHOP_BY_ID[cyc.deal].kind] === cyc.deal, 'buy the deal of the day: owned and equipped');
      ok(st.ledger[st.ledger.length - 1].kind === 'shop' && st.ledger[st.ledger.length - 1].amount === -price, `charged the sale price ${price}`);
      ok(!(await call(st, c, { op: 'buy', id: cyc.deal })).ok, 'buying it again refused');
      ok(!(await call(st, c, { op: 'buy', id: 'no-such-item' })).ok, 'unknown item refused');
      ok((await call(st, c, { op: 'equip', id: 'felt-green' })).ok, 'equip something owned');
      ok(!(await call(st, c, { op: 'equip', id: ECON.SHOP.find(x => x.price > 0 && x.id !== cyc.deal).id })).ok, 'equip something not owned refused');
      ok(identity(st), 'ledger identity after shopping');
    }

    // Promo: Blackjack Bonanza (Friday 6pm ET) pays 20% of the main bet on a natural, as a promo row.
    {
      st = memStore(); c = clockAt(FRI_EVE);
      await call(st, c, { op: 'state' });
      // Stack the shoe: player Ace, dealer 2, player King, dealer 3 (cards as ints: rank 12 = Ace).
      st.tables.set('u/bj', { shoe: { decks: 6, cards: [12, 0, 11, 1, 5, 6, 7, 8], pos: 0, cut: 1e9, stacked: false }, round: null, last: null, n: 0, seq: 0 });
      const r = await call(st, c, { op: 'deal', table: 'bj', seq: 0, bet: 100 });
      const promo = r.events.find(e => e.type === 'promo');
      ok(r.view.last && r.view.last.hands[0].outcome === 'blackjack', 'stacked natural');
      ok(promo && promo.amount === 20 && st.ledger.some(x => x.kind === 'promo' && x.amount === 20), 'Bonanza promo +20 on a 100 natural, via a promo row');
      ok(r.view.last.net === 150, 'the round itself still pays exactly 3:2 (promo is separate)');
      ok(identity(st), 'ledger identity after promo');
    }
    report('Double XP, quests + claim + rollover, Bonus Wheel + Lucky Saturday, vault + interest, shop, Bonanza promo', f);
  }

  section('rescue wheel');
  {
    const f = fail;
    const ECON = require('./economy.js');
    const wheel = ECON.WHEELS.rescue;
    /** A store whose player has `chips` on hand (spent through a shop row). */
    async function brokeStore(chips, xp = 0) {
      const st = memStore();
      await PLAY.handle(st, 'u', { op: 'state' });
      await st.commit('u', st.wallets.get('u').version, { chips, vault: 0, econ: Object.assign(st.wallets.get('u').econ, { xp }), ledger: [{ account: 'chips', amount: chips - 1000, kind: 'shop' }] });
      return st;
    }
    let st = await brokeStore(10);
    let r = await PLAY.handle(st, 'u', { op: 'rescue' });
    ok(!r.ok && r.error === 'not_broke', 'refused at exactly availableBelow (10)');

    st = await brokeStore(9);
    // A round in progress (chips in play) blocks it, even when the wallet is low.
    const st2 = memStore();
    await PLAY.handle(st2, 'u', { op: 'state' });
    await st2.commit('u', st2.wallets.get('u').version, { chips: 18, vault: 0, econ: st2.wallets.get('u').econ, ledger: [{ account: 'chips', amount: -982, kind: 'shop' }] });
    let seq = 0, inPlay = false;
    for (let i = 0; i < 100 && !inPlay; i++) {
      const d = await PLAY.handle(st2, 'u', { op: 'deal', table: 'bj', seq, bet: 10 });
      if (!d.ok) break;
      seq = d.view.seq;
      if (d.view.round) inPlay = true;
    }
    if (inPlay && st2.wallets.get('u').chips < 10) {
      r = await PLAY.handle(st2, 'u', { op: 'rescue' });
      ok(!r.ok && r.error === 'round_in_progress', 'refused with a round in progress');
    } else ok(false, 'could not set up a low wallet with a round in progress');

    r = await PLAY.handle(st, 'u', { op: 'rescue' });
    ok(r.ok && wheel.slices.some(s => s.chips === r.spin.chips) && r.wallet.chips === 9 + r.spin.chips, 'granted when under 10');
    const row = st.ledger[st.ledger.length - 1];
    ok(row.kind === 'rescueWheel' && row.amount === r.spin.chips, 'paid through a rescueWheel ledger row');
    ok(st.wallets.get('u').chips === st.ledgerSum('u'), 'ledger identity after rescue');
    const again = await PLAY.handle(st, 'u', { op: 'rescue' });
    ok(!again.ok && again.error === 'not_broke', 'no second spin once rescued');

    // Odds: the server's spins follow the published weights (crypto RNG, 20k spins).
    const counts = wheel.slices.map(() => 0), N = 20000, total = ECON.wheelTotal(wheel);
    const rich = await brokeStore(0, 500000), poor = await brokeStore(0, 0);
    for (let i = 0; i < N; i++) {
      const s = await PLAY.handle(rich, 'u', { op: 'rescue' });
      counts[s.spin.idx]++;
      const w = rich.wallets.get('u');   // spend it back to 0 to spin again
      await rich.commit('u', w.version, { chips: 0, vault: 0, econ: w.econ, ledger: [{ account: 'chips', amount: -w.chips, kind: 'shop' }] });
    }
    let chi = 0;
    wheel.slices.forEach((s, i) => { const e = N * s.weight / total; chi += (counts[i] - e) ** 2 / e; });
    // 4 degrees of freedom: P(chi2 > 23.5) is about 1 in 10,000.
    ok(chi < 23.5, `rescue spin frequencies off the published weights: chi2 ${chi.toFixed(1)}`);

    // Hard rule 2: same seed, Diamond vs Lv1, identical prize sequence.
    const seqOf = async (store) => {
      const ri = seededInt(31), out = [];
      for (let i = 0; i < 200; i++) {
        const s = await PLAY.handle(store, 'u', { op: 'rescue' }, { randInt: ri });
        out.push(s.spin.chips);
        const w = store.wallets.get('u');
        await store.commit('u', w.version, { chips: 0, vault: 0, econ: w.econ, ledger: [{ account: 'chips', amount: -w.chips, kind: 'shop' }] });
      }
      return out.join(',');
    };
    ok(await seqOf(await brokeStore(0, 500000)) === await seqOf(poor), 'rescue prizes differ by rank');
    report(`refused unless broke with nothing in play; pays via ledger; ${N} spins match the weights (chi2 ${chi.toFixed(1)}, 4 df); rank-blind`, f);
  }

  section('same game as the page');
  {
    const f = fail;
    for (const t of ['bj', 'fb']) {
      // Server path
      const st = memStore();
      await PLAY.handle(st, 'u', { op: 'state' });
      const rndA = mulberry32(99), riA = seededInt(4242);
      const serverRounds = [];
      let seq = 0;
      for (let i = 0; i < 300; i++) {
        let r = await PLAY.handle(st, 'u', { op: 'deal', table: t, seq, bet: 10 }, { randInt: riA });
        seq = r.view.seq;
        while (r.view.round) {
          const full = st.tables.get('u/' + t).round;   // server-side truth, to pick the same strategy move
          const a = r.view.round.phase === 'insurance' ? 'decline' : BJ.basicStrategy(full, st.wallets.get('u').chips);
          r = await PLAY.handle(st, 'u', { op: 'act', table: t, seq, action: a }, { randInt: riA });
          seq = r.view.seq;
        }
        serverRounds.push(r.view.last);
        const w = st.wallets.get('u');
        if (w.chips < 600) await st.commit('u', w.version, { chips: w.chips + 1000, vault: 0, econ: w.econ, ledger: [{ account: 'chips', amount: 1000, kind: 'quests' }] });
      }
      // Direct engine path, the way the page drives it
      const rules = PLAY.TABLES[t], riB = seededInt(4242);
      let shoe = null, same = true;
      for (let i = 0; i < 300 && same; i++) {
        if (!shoe || BJ.needsShuffle(shoe)) shoe = BJ.newShoe(rules, riB);
        const round = BJ.startRound(shoe, 10, rules, { randInt: riB, side: {} });
        while (round.phase !== 'done') {
          const a = round.phase === 'insurance' ? 'decline' : BJ.basicStrategy(round, Infinity);
          BJ.act(round, shoe, a, Infinity, { randInt: riB });
        }
        const s = serverRounds[i];
        same = JSON.stringify(s.dealer) === JSON.stringify(round.dealer) &&
               JSON.stringify(s.hands.map(h => h.cards)) === JSON.stringify(round.hands.map(h => h.cards)) &&
               s.net === round.net;
        if (!same) console.log(`  round ${i}: server ${JSON.stringify(s.dealer)} net ${s.net}, engine ${JSON.stringify(round.dealer)} net ${round.net}`);
      }
      ok(same, t + ': server rounds identical to the engine driven directly');
    }
    report('300 rounds per table: identical cards and nets to driving blackjack-core.js directly', f);
  }

  section('the deal is indifferent to who you are (hard rule 2)');
  {
    const f = fail;
    async function play(xp, chips) {
      const st = memStore();
      await PLAY.handle(st, 'u', { op: 'state' });
      const w = st.wallets.get('u');
      w.econ = { xp };
      if (chips > w.chips) await st.commit('u', st.wallets.get('u').version, { chips, vault: 0, econ: Object.assign(st.wallets.get('u').econ, { xp }), ledger: [{ account: 'chips', amount: chips - w.chips, kind: 'quests' }] });
      const rnd = mulberry32(5), ri = seededInt(6);
      const out = [];
      let seq = { bj: 0, fb: 0 };
      for (let i = 0; i < 400; i++) {
        const t = i % 2 ? 'fb' : 'bj';
        let r = await PLAY.handle(st, 'u', { op: 'deal', table: t, seq: seq[t], bet: 20, side: { perfectPairs: 2 } }, { randInt: ri });
        seq[t] = r.view.seq;
        while (r.view.round) {
          const a = r.view.legal.stand ? (rnd() < 0.5 ? 'hit' : 'stand') : 'decline';
          r = await PLAY.handle(st, 'u', { op: 'act', table: t, seq: seq[t], action: a }, { randInt: ri });
          seq[t] = r.view.seq;
        }
        out.push(JSON.stringify([r.view.last.dealer, r.view.last.hands.map(h => [h.cards, h.outcome]), r.view.last.net]));
        const w2 = st.wallets.get('u');
        if (w2.chips < 200) await st.commit('u', w2.version, { chips: w2.chips + 1000, vault: 0, econ: w2.econ, ledger: [{ account: 'chips', amount: 1000, kind: 'quests' }] });
      }
      return out;
    }
    const broke = await play(0, 1000), diamond = await play(500000, 200000);
    ok(broke.length === 400 && broke.every((x, i) => x === diamond[i]), 'Lv1 with 1,000 and Diamond with 200,000 got different rounds');
    report('Lv1 / 1,000 chips vs Diamond / 200,000 chips: identical 400 rounds', f);
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} checks, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(fail ? 1 : 0);
}

module.exports = { memStore, mulberry32, seededInt };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
