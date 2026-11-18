/*
 * Online table server: the game and economy logic, with no database and no
 * Deno in it.
 *
 * It runs the SAME blackjack-core.js / tcp-core.js / slots-core.js /
 * tables.js / economy.js the page runs
 * (the byte-identical copies in ../_shared/, see sync-shared.js), so the
 * server deals, settles and rewards exactly as the harnesses verify. Nothing
 * here computes a payout (BJ.settle() / TCP.settle() / SLOTS.play() do) or a reward (economy.js's
 * ACCOUNT ACTIONS do, the same functions the page calls offline).
 *
 * It talks to storage only through a small `store` object, so Node tests can
 * drive it against an in-memory store (test-server.js) and the Deno wrapper
 * (index.ts) plugs in Postgres. The store's commit() must behave like
 * commit_turn() in the wallets migration: refuse unless each balance moved by
 * exactly the sum of its ledger rows, and throw {code: '40001'} if the
 * wallet version is stale.
 *
 * Linked jackpots (jackpot.js) are one pool shared by every player. If the
 * store has it (store.pool), every paid slot spin contributes and may hit,
 * and the pool commits in the SAME write as the player's wallet, under its
 * own version (a racing writer -> 40001 -> retry). A store without it (the
 * jackpot migration not applied yet) just plays slots without jackpots.
 *
 * What the player is sent: their balance, rank and economy state (quests,
 * vault, wheels, cosmetics: none of it secret), and each table's round with
 * the dealer's hole card (Three Card Poker: all three dealer cards) hidden
 * until the round is over. NEVER the shoe.
 *
 * Classic UMD script: Node require()s it; Deno imports the _shared files and
 * then this, and it registers globalThis.PLAY.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../_shared/blackjack-core.js'),
      require('../_shared/economy.js'),
      require('../_shared/tables.js'),
      require('../_shared/tcp-core.js'),
      require('../_shared/slots-core.js'),
      require('../_shared/jackpot.js'),
      require('../_shared/roulette-core.js'));
  } else {
    root.PLAY = factory(root.BJ, root.ECON, root.TABLE_RULES, root.TCP, root.SLOTS, root.JACKPOT, root.ROULETTE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (BJ, ECON, TABLE_RULES, TCP, SLOTS, JACKPOT, ROULETTE) {
  'use strict';

  /** Online tables. Same rules objects the page builds (BJ_TABLES). */
  const TABLES = {
    bj: BJ.makeRules(TABLE_RULES.blackjack),
    fb: BJ.makeRules(TABLE_RULES.freeBet),
  };
  /** Slot machines: one table each, 'slot_<machine id>'. */
  const SLOT_TABLES = SLOTS.MACHINE_IDS.map(id => 'slot_' + id);
  const isSlot = (t) => SLOT_TABLES.includes(t);
  /** Roulette wheels: one table each. */
  const RL_TABLES = { rl_american: 'american', rl_european: 'european' };
  const isRoulette = (t) => t in RL_TABLES;
  /** Every online table: the blackjack tables above, Three Card Poker, the slots, roulette. */
  const TABLE_IDS = [...Object.keys(TABLES), 'tcp', ...SLOT_TABLES, ...Object.keys(RL_TABLES)];
  const SIDE_KEYS = Object.keys(BJ.SIDE_BETS);
  const ACTIONS = ['insure', 'decline', 'hit', 'stand', 'double', 'split'];
  const TCP_ACTIONS = ['play', 'fold'];
  const OPS = ['state', 'pool', 'leaderboard', 'tourney', 'deal', 'act', 'claim', 'claimAll', 'spin', 'rescue', 'vault', 'buy', 'equip', 'tnClaim'];
  const TN = ECON.TOURNEY;
  const MAX_RETRIES = 8;   // the jackpot pool is shared, so conflicts are likelier than with one wallet
  const RECENT_HITS = 12;

  /** An error the player caused (bad bet, stale click). Sent back as-is. */
  class PlayError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const refuse = (code, message) => { throw new PlayError(code, message); };
  const isWhole = (v) => Number.isInteger(v) && v >= 0;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function rankOf(econ) {
    const lv = ECON.levelFromXp(econ.xp || 0);
    const tier = ECON.tierIndex(lv.level);
    return { xp: econ.xp || 0, level: lv.level, into: lv.into, need: lv.need,
             tier, tierName: ECON.TIERS[tier].name, maxBet: ECON.TIERS[tier].maxBet };
  }

  const emptyTable = () => ({ shoe: null, round: null, last: null, n: 0, seq: 0 });

  /** The bet limit for this bankroll: the tournament's (same for everyone) or your rank's. */
  const limitOf = (a) => (a.tourney ? TN.maxBet : rankOf(a.econ).maxBet);
  function overLimit(a, limit, per) {
    refuse('over_limit', a.tourney
      ? `The tournament limit is ${limit.toLocaleString('en-US')} ${per}.`
      : `Your table limit is ${limit.toLocaleString('en-US')} ${per}. Rank up to raise it.`);
  }

  /**
   * After a game has settled, on facts only. A real round: XP, quests,
   * promos. A tournament round: it counts toward the entry's rounds, and
   * nothing else (tournament chips earn no XP or quest progress).
   */
  function after(turn, facts) {
    if (turn.tn) { if (facts.wagered > 0) turn.tn.rounds++; return; }
    turn.ev.push(...ECON.afterRound(turn.acct, facts, turn.now));
  }

  function fmtWait(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }

  /* ------------------------------------------------------------- views -- */

  /** A round as the player may see it: no rules blob, hole card hidden until done. */
  function roundView(round) {
    if (!round) return null;
    const { rules, ...rest } = round;
    const v = clone(rest);
    if (round.phase !== 'done' && v.dealer.length > 1) v.dealer = [v.dealer[0], null];
    return v;
  }

  /** A Three Card Poker hand as the player may see it: dealer's cards hidden until done. */
  function tcpRoundView(r) {
    if (!r) return null;
    const v = clone(r);
    if (r.phase !== 'done') v.dealer = r.dealer.map(() => null);
    return v;
  }

  function tableView(ts, chips, t) {
    const r = ts.round;
    // A slot table holds no secret: the next spin isn't decided until it's played.
    if (isSlot(t)) return { seq: ts.seq, rounds: ts.n, free: ts.free || null, last: ts.last || null };
    // Neither does a roulette wheel: the pocket is drawn when the bets are in.
    if (isRoulette(t)) return { seq: ts.seq, rounds: ts.n, last: ts.last || null, recent: ts.recent || [] };
    if (t === 'tcp') {
      return {
        seq: ts.seq,
        rounds: ts.n,
        round: tcpRoundView(r),
        legal: r ? { play: chips >= r.bets.ante, fold: true } : null,
        last: tcpRoundView(ts.last),
      };
    }
    return {
      seq: ts.seq,
      rounds: ts.n,
      // How far into the shoe, for display. The cards themselves never leave the server.
      shoe: ts.shoe ? { decks: ts.shoe.decks, dealt: ts.shoe.pos, size: ts.shoe.cards.length, cut: ts.shoe.cut } : null,
      round: roundView(r),
      legal: r ? BJ.legalActions(r, chips) : null,
      free: r ? BJ.freeOffers(r) : null,
      last: roundView(ts.last),
    };
  }

  function walletView(a) {
    return { chips: a.chips, vault: a.econ.vault.balance, rank: rankOf(a.econ), econ: clone(a.econ) };
  }

  /* -------------------------------------------------------------- games -- */

  /** Settle bookkeeping once BJ has finished a round, then the economy reads the result. */
  function settled(turn, t) {
    const r = turn.ts.round, a = turn.acct;
    if (r.phase !== 'done') return;
    if (r.returned > 0) {
      a.rows.push({ account: 'chips', amount: r.returned, kind: 'payout', table_id: t, ref: turn.ref });
      a.chips += r.returned;
    }
    turn.ts.last = r;
    turn.ts.round = null;
    turn.ts.n++;
    // After settlement, on facts only: XP, quests, promos. Can't touch the round.
    after(turn, ECON.bjFacts(r, t, TABLE_RULES.bjMinBet));
  }

  function deal(turn, t, req, randInt) {
    const rules = TABLES[t], ts = turn.ts, a = turn.acct;
    if (ts.round) refuse('round_in_progress', 'Finish the current round first.');

    const bet = req.bet;
    const side = {};
    const sideIn = req.side || {};
    if (typeof sideIn !== 'object' || Array.isArray(sideIn)) refuse('bad_request', 'Bad side bets.');
    for (const k of Object.keys(sideIn)) {
      if (!SIDE_KEYS.includes(k)) refuse('bad_request', 'Unknown side bet.');
      if (!isWhole(sideIn[k])) refuse('bad_request', 'Side bets must be whole chips.');
      if (sideIn[k] > 0) {
        if (!rules[k]) refuse('bad_request', 'That side bet is not offered at this table.');
        side[k] = sideIn[k];
      }
    }
    if (!Number.isInteger(bet) || bet < TABLE_RULES.bjMinBet) refuse('bad_bet', `Minimum bet is ${TABLE_RULES.bjMinBet}.`);
    if (bet % rules.betUnit !== 0) refuse('bad_bet', `Bets must be a multiple of ${rules.betUnit}.`);
    const limit = limitOf(a);
    if (Math.max(bet, ...Object.values(side)) > limit) overLimit(a, limit, 'per bet');
    const total = bet + Object.values(side).reduce((x, y) => x + y, 0);
    if (a.chips < total) refuse('not_enough_chips', 'Not enough chips for the main bet plus side bets.');

    if (!ts.shoe || ts.shoe.decks !== rules.decks || BJ.needsShuffle(ts.shoe)) {
      ts.shoe = BJ.newShoe(rules, randInt);
      turn.shuffled = true;
    }
    turn.ref = `${t}:${ts.n + 1}`;
    ts.round = BJ.startRound(ts.shoe, bet, rules, { randInt, side });
    ts.last = null;
    a.rows.push({ account: 'chips', amount: -ts.round.wagered, kind: 'bet', table_id: t, ref: turn.ref });
    a.chips -= ts.round.wagered;
    settled(turn, t);
  }

  function act(turn, t, req, randInt) {
    const ts = turn.ts, r = ts.round, a = turn.acct;
    if (!r) refuse('no_round', 'There is no round in progress.');
    if (!ACTIONS.includes(req.action)) refuse('bad_request', 'Unknown action.');
    if (!BJ.legalActions(r, a.chips)[req.action]) refuse('illegal', `You can't ${req.action} right now.`);
    turn.ref = `${t}:${ts.n + 1}`;
    const before = r.wagered;
    BJ.act(r, ts.shoe, req.action, a.chips, { randInt });
    const more = r.wagered - before;
    if (more > 0) {
      a.rows.push({ account: 'chips', amount: -more, kind: 'bet', table_id: t, ref: turn.ref });
      a.chips -= more;
    }
    settled(turn, t);
  }

  /* --------------------------------------------------- three card poker -- */

  // A fresh 52-card deck every hand (TCP.dealHand), so the table keeps no shoe:
  // only the hand in progress, whose dealer cards the player never sees early.

  function tcpDeal(turn, req, randInt) {
    const rules = TABLE_RULES.tcp, ts = turn.ts, a = turn.acct;
    if (ts.round) refuse('round_in_progress', 'Finish the current hand first.');
    const b = req.bets;
    if (!b || typeof b !== 'object' || Array.isArray(b)) refuse('bad_request', 'Bad bets.');
    if (Object.keys(b).some(k => !TCP.BET_KEYS.includes(k))) refuse('bad_request', 'Unknown bet.');
    const bets = { ante: b.ante || 0, pp: b.pp || 0, scb: b.scb || 0 };
    const err = TCP.betError(bets, rules);
    if (err) refuse('bad_bet', err);
    const limit = limitOf(a);
    if (Math.max(bets.ante, bets.pp, bets.scb) > limit) overLimit(a, limit, 'per bet');
    const stake = bets.ante + bets.pp + bets.scb;
    if (a.chips < stake) refuse('not_enough_chips', 'Not enough chips.');

    const { player, dealer } = TCP.dealHand(randInt || BJ.cryptoRandInt);
    turn.ref = `tcp:${ts.n + 1}`;
    ts.round = { bets, player, dealer, wagered: stake, phase: 'decision' };
    ts.last = null;
    a.rows.push({ account: 'chips', amount: -stake, kind: 'bet', table_id: 'tcp', ref: turn.ref });
    a.chips -= stake;
    if (bets.ante === 0) tcpSettle(turn, false);   // side bets only: nothing to decide
  }

  function tcpAct(turn, req) {
    const ts = turn.ts, r = ts.round, a = turn.acct;
    if (!r) refuse('no_round', 'There is no hand in progress.');
    if (!TCP_ACTIONS.includes(req.action)) refuse('bad_request', 'Unknown action.');
    turn.ref = `tcp:${ts.n + 1}`;
    const raised = req.action === 'play';
    if (raised) {
      const ante = r.bets.ante;
      if (a.chips < ante) refuse('not_enough_chips', 'Not enough chips to play; you can only fold.');
      a.rows.push({ account: 'chips', amount: -ante, kind: 'bet', table_id: 'tcp', ref: turn.ref });
      a.chips -= ante;
      r.wagered += ante;
    }
    tcpSettle(turn, raised);
  }

  /** TCP.settle() decides the payout; this pays it and lets the economy read the result. */
  function tcpSettle(turn, raised) {
    const ts = turn.ts, r = ts.round, a = turn.acct;
    const res = TCP.settle(r.bets, r.player, r.dealer, raised, TABLE_RULES.tcp);
    if (res.stake !== r.wagered) throw new Error('tcp: stake does not match chips taken');
    if (res.returned > 0) {
      a.rows.push({ account: 'chips', amount: res.returned, kind: 'payout', table_id: 'tcp', ref: turn.ref });
      a.chips += res.returned;
    }
    ts.last = Object.assign({}, r, { raised, phase: 'done', result: res });
    ts.round = null;
    ts.n++;
    // After settlement, on facts only: XP, quests, promos. Can't touch the hand.
    after(turn, TCP.facts(res, r.bets, TABLE_RULES.tcp.minBet));
  }

  /* ------------------------------------------------------------- slots -- */

  // One request = one spin, decided and paid by SLOTS.play(). The table keeps
  // only the free-spins feature (if one is running) and the last result.
  async function slotDeal(turn, t, req, randInt, jpRandInt) {
    const m = SLOTS.MACHINES[t.slice(5)], ts = turn.ts, a = turn.acct;
    const free = ts.free || null;
    const level = free ? free.level : req.level;
    if (!free) {
      const err = SLOTS.betError(m, level);
      if (err) refuse('bad_bet', err);
      const cost = SLOTS.totalBet(m, level), limit = limitOf(a);
      if (cost > limit) overLimit(a, limit, 'per spin');
      if (a.chips < cost) refuse('not_enough_chips', 'Not enough chips for this bet.');
    }
    turn.ref = `${t}:${ts.n + 1}`;
    const res = SLOTS.play(m, level, free, randInt || BJ.cryptoRandInt);
    if (res.cost) {
      a.rows.push({ account: 'chips', amount: -res.cost, kind: 'bet', table_id: t, ref: turn.ref });
      a.chips -= res.cost;
    }
    if (res.win) {
      a.rows.push({ account: 'chips', amount: res.win, kind: 'payout', table_id: t, ref: turn.ref });
      a.chips += res.win;
    }
    // Linked jackpots: paid spins only. Their own RNG stream, so the reels
    // are the same whether or not the pool exists.
    res.jackpots = [];
    res.jackpotWin = 0;
    if (turn.pool && res.cost) {
      const hits = await JACKPOT.play(turn.pool.state, res.cost, jpRandInt);
      turn.poolChanged = true;
      for (const h of hits) {
        if (h.amount > 0) {
          a.rows.push({ account: 'chips', amount: h.amount, kind: 'payout', table_id: t, ref: `jp:${h.tier}:${turn.pool.state.hits}` });
          a.chips += h.amount;
        }
        res.jackpots.push(h);
        res.jackpotWin += h.amount;
        turn.hits.push({ tier: h.tier, amount: h.amount, table_id: t, reveal: h.reveal || null });
      }
    }
    ts.free = res.free;
    ts.last = res;
    ts.n++;
    // Paid spins only, after the result: XP, quests. Can't touch the spin.
    if (res.cost) after(turn, SLOTS.facts(res, m));
  }

  /* ---------------------------------------------------------- roulette -- */

  // One request = one spin: the bets come in, ROULETTE.spin() draws the
  // pocket, ROULETTE.settle() pays. Nothing waits between requests.
  function rlDeal(turn, t, req, randInt) {
    const w = ROULETTE.WHEELS[RL_TABLES[t]], ts = turn.ts, a = turn.acct;
    const err = ROULETTE.betError(w, req.bets);
    if (err) refuse(/^That isn't|^Bad bets/.test(err) ? 'bad_request' : 'bad_bet', err);
    const bets = {};
    for (const [id, amt] of Object.entries(req.bets)) if (amt > 0) bets[id] = amt;
    const limit = limitOf(a);
    if (Math.max(...Object.values(bets)) > limit) overLimit(a, limit, 'per bet');
    const total = Object.values(bets).reduce((x, y) => x + y, 0);
    if (a.chips < total) refuse('not_enough_chips', 'Not enough chips for those bets.');
    turn.ref = `${t}:${ts.n + 1}`;
    const res = ROULETTE.settle(w, bets, ROULETTE.spin(w, randInt || BJ.cryptoRandInt));
    a.rows.push({ account: 'chips', amount: -res.wagered, kind: 'bet', table_id: t, ref: turn.ref });
    a.chips -= res.wagered;
    if (res.returned > 0) {
      a.rows.push({ account: 'chips', amount: res.returned, kind: 'payout', table_id: t, ref: turn.ref });
      a.chips += res.returned;
    }
    ts.last = res;
    ts.recent = [res.pocket, ...(ts.recent || [])].slice(0, 20);
    ts.n++;
    after(turn, ROULETTE.facts(res));
  }

  /* -------------------------------------------------------- tournaments -- */

  // A player's entry for one week lives in ONE table state, 'tn_<week>':
  // { week, chips, rounds, entered, paid, tables: { <table id>: table state } }.
  // Tournament chips are not real chips: they never touch the wallet or the
  // ledger. The games are the same functions, run on a bankroll that is the
  // entry's stack, with the tournament's limit and no XP / quests / jackpots.

  const isWeek = (w) => typeof w === 'string' && /^\d{8}$/.test(w);
  const blankEntry = (week) => ({ week, chips: TN.stack, rounds: 0, entered: 0, paid: null, tables: {} });
  async function loadEntry(store, userId, week) {
    return (await store.table(userId, ECON.tourneyTable(week))) || blankEntry(week);
  }
  /** A round or a free-spins feature still to finish at this table. */
  const openAt = (ts) => !!(ts && (ts.round || ts.free));
  const entryOpen = (tn) => Object.values(tn.tables).some(openAt);

  /** The entry a tournament request plays on, or a refusal if it can't be played now. */
  async function tourneyEntry(store, userId, req, now, t) {
    const week = req.tourney;
    if (!isWeek(week)) refuse('bad_request', 'Bad tournament week.');
    const cur = ECON.tourneyWeek(now);
    const tn = await loadEntry(store, userId, week);
    if (week !== cur) {
      // Last week's: only to finish a round that was open when it ended.
      if (!(week < cur && openAt(tn.tables[t]) && now < ECON.tourneyBounds(week).closes)) {
        refuse('tourney_closed', week > cur ? 'That tournament hasn\'t started yet.' : 'That week\'s tournament is over. The standings have your result.');
      }
    } else if (tn.rounds >= TN.rounds && !openAt(tn.tables[t])) {
      refuse('tourney_done', `You've played all ${TN.rounds} rounds. Final stack: ${tn.chips.toLocaleString('en-US')}.`);
    }
    if (!tn.entered) tn.entered = now.getTime();
    return tn;
  }

  /** An entry as its player sees it: the stack, the rounds, and each table (no shoe, no hole card). */
  function entryView(tn) {
    const tables = {};
    for (const k of TABLE_IDS) tables[k] = tableView(tn.tables[k] || emptyTable(), tn.chips, k);
    const b = ECON.tourneyBounds(tn.week);
    return { week: tn.week, chips: tn.chips, rounds: tn.rounds, of: TN.rounds, entered: !!tn.entered,
             finished: tn.rounds >= TN.rounds && !entryOpen(tn), open: entryOpen(tn), paid: tn.paid || null,
             ends: b.end.toISOString(), closes: b.closes.toISOString(), stack: TN.stack, maxBet: TN.maxBet, tables };
  }

  /** One week's standings from every entry (the SQL function), or null without the migration. */
  async function standings(store, userId, week, now) {
    const rows = store.tourney ? await store.tourney(ECON.tourneyTable(week)) : null;
    if (!rows) return null;
    const b = ECON.tourneyBounds(week), final = now >= b.closes;
    const st = ECON.tourneyStandings(rows.map(r => ({
      name: r.display_name, avatar: r.avatar, chips: +r.chips, rounds: +r.rounds, mine: r.user_id === userId, paid: !!r.paid })));
    const of = st.filter(e => e.place).length;
    return { week, ends: b.end.toISOString(), closes: b.closes.toISOString(), final, finishers: of,
             players: st.map(e => Object.assign(e, { prize: ECON.tourneyPrize(e.place) })) };
  }

  /** This week's and last week's standings, plus the caller's entry. */
  async function tourneyOut(store, userId, now) {
    const cur = ECON.tourneyWeek(now);
    const prev = ECON.tourneyWeek(new Date(ECON.tourneyBounds(cur).start.getTime() - 86400000));
    const current = await standings(store, userId, cur, now);
    if (!current) return { tourney: null };
    return { tourney: { config: TN, current, last: await standings(store, userId, prev, now),
                        entry: entryView(await loadEntry(store, userId, cur)) } };
  }

  /* ------------------------------------------------------------ economy -- */

  /** Chips currently in play at any table (they count against "broke"). */
  async function inPlay(store, userId) {
    let n = 0;
    for (const t of TABLE_IDS) {
      const ts = await store.table(userId, t);
      if (ts && ts.round) n += ts.round.wagered;
    }
    return n;
  }

  async function economyOp(turn, store, userId, req, randInt) {
    const a = turn.acct, t = turn.now;
    switch (req.op) {
      case 'claim': {
        if (!Number.isInteger(req.i) || typeof req.day !== 'string') refuse('bad_request', 'Bad claim.');
        const res = ECON.claimQuest(a, req.i, req.day, t);
        if (!res) refuse('nothing_to_claim', 'Nothing to claim there (already claimed, or a new day started).');
        turn.ev.push(...res.ev);
        turn.extra.reward = res.reward;
        return;
      }
      case 'claimAll': {
        let chips = 0, n = 0;
        a.econ.quests.list.forEach((q, i) => {
          if (!q.done || q.claimed) return;
          const res = ECON.claimQuest(a, i, a.econ.quests.day, t);
          if (res) { chips += res.reward.chips; n++; turn.ev.push(...res.ev); }
        });
        if (!n) refuse('nothing_to_claim', 'No finished quests to claim.');
        turn.extra.claimed = { n, chips };
        return;
      }
      case 'rescue':
      case 'spin': {
        const which = req.op === 'rescue' ? 'rescue' : req.wheel;
        if (which !== 'bonus' && which !== 'rescue') refuse('bad_request', 'Unknown wheel.');
        const played = which === 'rescue' ? await inPlay(store, userId) : 0;
        const res = ECON.spin(a, which, t, randInt || BJ.cryptoRandInt, played);
        if (!res) {
          if (which === 'bonus') refuse('not_ready', `The Bonus Wheel recharges in ${fmtWait(ECON.bonusReadyAt(a, t) - t.getTime())}.`);
          const below = ECON.WHEELS.rescue.availableBelow;
          if (a.chips + a.econ.vault.balance < below) refuse('round_in_progress', 'Finish your round first: chips in play still count.');
          refuse('not_broke', `The Rescue Wheel is for when you're under ${below} chips.`);
        }
        turn.extra.spin = res;
        return;
      }
      case 'vault': {
        if (!Number.isInteger(req.amount) || req.amount === 0) refuse('bad_request', 'Enter a whole number of chips.');
        if (!ECON.moveVault(a, req.amount, t, turn.ev)) {
          refuse('bad_amount', req.amount > 0 ? 'You don\'t have that many chips on hand.' : 'There aren\'t that many chips in the vault.');
        }
        return;
      }
      case 'buy':
        if (typeof req.id !== 'string' || !ECON.buy(a, req.id, t)) refuse('cant_buy', 'That can\'t be bought right now.');
        return;
      case 'equip':
        if (typeof req.id !== 'string' || !ECON.equip(a, req.id)) refuse('cant_equip', 'You don\'t own that.');
        return;
      case 'tnClaim': {
        // A finished week's prize, once. The standings are final once the
        // week has closed: no entry can change after that.
        const week = req.week;
        if (!isWeek(week)) refuse('bad_request', 'Bad tournament week.');
        if (t < ECON.tourneyBounds(week).closes) refuse('not_final', 'Prizes are paid once that week\'s tournament has closed.');
        const tn = await store.table(userId, ECON.tourneyTable(week));
        if (!tn) refuse('nothing_to_claim', 'You didn\'t play in that tournament.');
        if (tn.paid) refuse('nothing_to_claim', 'Already paid.');
        const st = await standings(store, userId, week, t);
        if (!st) refuse('unavailable', 'Tournaments aren\'t set up on the server yet.');
        const me = st.players.find(e => e.mine);
        const prize = me ? me.prize : 0;
        if (!prize) refuse('nothing_to_claim', `You played ${tn.rounds} of ${TN.rounds} rounds, so you didn't place.`);
        ECON.grant(a, 'tournament', prize);
        if (me.place <= TN.prizes.length) a.econ.trophies.push({ week, place: me.place, of: st.finishers });
        tn.paid = { place: me.place, prize, of: st.finishers };
        turn.save = { id: ECON.tourneyTable(week), state: tn };
        turn.extra.prize = { week, place: me.place, prize, of: st.finishers };
        return;
      }
    }
  }

  /* ------------------------------------------------------------ handler -- */

  /**
   * Handle one request from a signed-in player. `userId` must already be
   * verified by the caller (index.ts checks the JWT). Returns a JSON-able
   * object; player mistakes come back as { ok: false, error, message }.
   *
   *   { op: 'state' }
   *   { op: 'deal', table: 'bj'|'fb', seq, bet, side: { perfectPairs, twentyOnePlus3 } }
   *   { op: 'act',  table, seq, action: 'hit'|'stand'|'double'|'split'|'insure'|'decline' }
   *   { op: 'deal', table: 'tcp', seq, bets: { ante, pp, scb } }
   *   { op: 'act',  table: 'tcp', seq, action: 'play'|'fold' }
   *   { op: 'deal', table: 'slot_<machine>', seq, level }   (one spin; during free spins level is ignored)
   *   { op: 'deal', table: 'rl_american'|'rl_european', seq, bets: { betId: chips } }   (one roulette spin)
   *   { op: 'claim', i, day }        { op: 'claimAll' }
   *   { op: 'spin', wheel: 'bonus'|'rescue' }   ({ op: 'rescue' } = spin rescue)
   *   { op: 'vault', amount }        (+ deposit, - withdraw)
   *   { op: 'buy', id }              { op: 'equip', id }
   *   { op: 'tourney' }              (standings: this week, last week, your entry)
   *   any deal/act + tourney: '<YYYYMMDD week>'   (plays your tournament entry, not your wallet)
   *   { op: 'tnClaim', week }        (a closed week's prize)
   *
   * Every response carries `events`: what the economy did (quest done, level
   * up, promo, interest...), for the page to announce.
   *
   * `seq` is the table's seq from the view the player clicked on. A double
   * click or a second tab sends a stale seq and is refused, so one click can
   * never place two bets.
   *
   * opts.randInt / opts.now: injectable RNG and clock, for tests only.
   */
  async function handle(store, userId, req, opts) {
    const randInt = (opts && opts.randInt) || undefined;
    const clock = (opts && opts.now) || (() => new Date());
    if (!req || typeof req !== 'object') return fail('bad_request', 'Bad request.');
    if (!OPS.includes(req.op)) return fail('bad_request', 'Unknown op.');
    const game = req.op === 'deal' || req.op === 'act';
    if (game && !TABLE_IDS.includes(req.table)) return fail('bad_request', 'Unknown table.');
    const jpRandInt = (opts && opts.jpRandInt) || BJ.cryptoRandInt;
    // Jackpot meters only: no wallet, no write.
    if (req.op === 'pool') return Object.assign({ ok: true }, await poolOut(store, null, userId));
    if (req.op === 'leaderboard') return Object.assign({ ok: true }, await boardOut(store, userId, clock()));
    if (req.op === 'tourney') return Object.assign({ ok: true }, await tourneyOut(store, userId, clock()));
    const tourney = game && req.tourney !== undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let w = await store.wallet(userId);
      if (!w) w = await store.openWallet(userId, TABLE_RULES.startingChips);
      const now = clock();
      const econ = ECON.normalizeEcon(clone(w.econ || {}), TABLE_RULES.startingChips);
      econ.vault.balance = w.vault;   // the column is the truth; econ carries the vault's day tracking
      const acct = { chips: w.chips, econ, rows: [] };
      const turn = { acct, now, ev: [], extra: {}, ts: null, ref: null, shuffled: false, pool: null, poolChanged: false, hits: [], tn: null, save: null };
      const econBefore = JSON.stringify(econ);

      // Every request keeps the day current: yesterday's unclaimed quests are
      // paid, today's set is dealt, vault interest is credited.
      ECON.ensureQuests(acct, now, turn.ev);
      ECON.accrueVault(acct, now, turn.ev);

      const t = game ? req.table : null;
      try {
        if (tourney) {
          // Same games, on the entry's stack (see TOURNAMENTS).
          turn.tn = await tourneyEntry(store, userId, req, now, t);
          turn.acct = { chips: turn.tn.chips, econ, rows: [], tourney: true };
          turn.ts = turn.tn.tables[t] || emptyTable();
        } else if (game) turn.ts = (await store.table(userId, t)) || emptyTable();
        if (game) {
          if (req.seq !== turn.ts.seq) refuse('stale', 'The table changed (another tab or a double click). Showing the current state.');
          if (isRoulette(t)) {
            if (req.op !== 'deal') refuse('bad_request', 'Roulette only spins.');
            rlDeal(turn, t, req, randInt);
          } else if (isSlot(t)) {
            if (req.op !== 'deal') refuse('bad_request', 'Slot machines only spin.');
            if (store.pool && !tourney) {             // tournament spins don't play for jackpots
              turn.pool = await store.pool();             // null: no jackpot table yet
              if (turn.pool && !turn.pool.state) turn.pool.state = await JACKPOT.blankPool(jpRandInt);
            }
            await slotDeal(turn, t, req, randInt, jpRandInt);
          } else if (t === 'tcp') {
            if (req.op === 'deal') tcpDeal(turn, req, randInt);
            else tcpAct(turn, req);
          } else if (req.op === 'deal') deal(turn, t, req, randInt);
          else act(turn, t, req, randInt);
          turn.ts.seq++;
          if (tourney) {
            const tn = turn.tn, moved = turn.acct.rows.reduce((x, r) => x + r.amount, 0);
            if (turn.acct.chips - tn.chips !== moved) throw new Error('tournament: stack moved without matching rows');
            tn.chips = turn.acct.chips;
            tn.tables[t] = turn.ts;
            turn.save = { id: ECON.tourneyTable(tn.week), state: tn };
            turn.acct = acct;   // the real wallet: untouched by the tournament
          }
        } else if (req.op !== 'state') {
          await economyOp(turn, store, userId, req, randInt);
        }
      } catch (e) {
        if (!(e instanceof PlayError)) throw e;
        // Nothing is saved on a refusal (the day's catch-up waits for the next real action).
        const cur = { chips: w.chips, econ: ECON.normalizeEcon(clone(w.econ || {}), TABLE_RULES.startingChips) };
        cur.econ.vault.balance = w.vault;
        const out = { ok: false, error: e.code, message: e.message, wallet: walletView(cur) };
        if (tourney) {
          const tn = isWeek(req.tourney) ? await loadEntry(store, userId, req.tourney) : null;
          out.table = t;
          out.view = tableView((tn && tn.tables[t]) || emptyTable(), tn ? tn.chips : 0, t);
          if (tn) out.tourney = entryView(tn);
        } else if (game) { out.table = t; out.view = tableView((await store.table(userId, t)) || emptyTable(), w.chips, t); }
        return out;
      }

      const changed = game || turn.save || acct.rows.length > 0 || JSON.stringify(econ) !== econBefore;
      const save = turn.save || (game ? { id: t, state: turn.ts } : null);
      if (changed) {
        try {
          await store.commit(userId, w.version, {
            chips: acct.chips, vault: econ.vault.balance, econ, ledger: acct.rows,
            tableId: save ? save.id : null, tableState: save ? save.state : undefined,
            pool: turn.poolChanged ? { version: turn.pool.version, state: turn.pool.state } : undefined,
            hits: turn.hits,
          });
        } catch (e) {
          if (e && e.code === '40001') continue;   // someone else committed first; start over
          throw e;
        }
      }

      const out = Object.assign({ ok: true, wallet: walletView(acct), events: turn.ev }, turn.extra);
      if (req.op === 'state' || (game && isSlot(t) && !tourney)) Object.assign(out, await poolOut(store, turn.poolChanged ? turn.pool.state : null, userId));
      if (req.op === 'state') {
        out.tables = {};
        for (const k of TABLE_IDS) out.tables[k] = tableView((await store.table(userId, k)) || emptyTable(), acct.chips, k);
        out.tourney = entryView(await loadEntry(store, userId, ECON.tourneyWeek(now)));
      }
      if (game) { out.table = t; out.view = tableView(turn.ts, tourney ? turn.tn.chips : acct.chips, t); out.shuffled = turn.shuffled; }
      if (tourney) out.tourney = entryView(turn.tn);
      return out;
    }
    return fail('busy', 'The server was busy with another request. Try again.');
  }

  function fail(error, message) { return { ok: false, error, message }; }

  /**
   * The leaderboard: every online player as a public card (display name,
   * avatar, rank, equipped cosmetics, and numbers from the server's own
   * records). "mine" marks the caller. Never a user id, never the wallet.
   * { board: null } until the leaderboard migration is applied.
   */
  async function boardOut(store, userId, now) {
    const since = ECON.weekStart(now);
    const rows = store.leaderboard ? await store.leaderboard(since.toISOString()) : null;
    if (!rows) return { board: null };
    const blank = ECON.blankEcon(0).equipped;
    const players = rows.map(r => {
      const e = r.econ || {}, lv = ECON.levelFromXp(e.xp || 0), tier = ECON.tierIndex(lv.level);
      const eq = Object.assign({}, blank, e.equipped || {});
      for (const k of Object.keys(eq)) if (!ECON.SHOP_BY_ID[eq[k]] || ECON.SHOP_BY_ID[eq[k]].kind !== k) eq[k] = blank[k];
      return {
        name: r.display_name, avatar: r.avatar, level: lv.level, xp: e.xp || 0, tier: ECON.TIERS[tier].name,
        title: ECON.SHOP_BY_ID[eq.title].text, equipped: eq,
        trophies: [1, 2, 3].map(p => (Array.isArray(e.trophies) ? e.trophies : []).filter(x => x && x.place === p).length),
        worth: +r.worth, weekNet: +r.week_net, bestWin: +r.best_win, jpTotal: +r.jp_total, jpCount: +r.jp_count,
        // v2 migration; 0 until it's applied
        gains: +(r.gross_won || 0), losses: +(r.gross_lost || 0), allNet: +(r.all_net || 0),
        joined: r.joined, mine: r.user_id === userId,
      };
    });
    return { board: { since: since.toISOString(), weekEnds: ECON.weekStart(new Date(since.getTime() + 8 * 86400000)).toISOString(), players } };
  }

  /** The jackpot meters and recent hits, for the page. { jackpot: null } when there is no pool. */
  async function poolOut(store, fresh, userId) {
    if (!store.pool) return { jackpot: null, jpHits: [] };
    let state = fresh;
    if (!state) {
      const p = await store.pool();
      if (!p) return { jackpot: null, jpHits: [] };   // no jackpot table: feature off
      state = p.state;
    }
    let v;
    if (state) v = JACKPOT.view(state);
    else {
      // The pool is created by the first paid spin; until then show the seeds,
      // with no commitment (there is no drop point yet to commit to).
      v = JACKPOT.view(await JACKPOT.blankPool(() => 0));
      for (const t of v.tiers) if (t.commit) t.commit = null;
    }
    // Recent hits name the winner by display name; "mine" marks the caller's own. Never a user id.
    const hits = store.recentHits ? await store.recentHits(RECENT_HITS) : [];
    return { jackpot: v, jpHits: hits.map(({ user_id, ...h }) => Object.assign(h, { mine: user_id === userId })) };
  }


  return { handle, TABLES, TABLE_IDS, SLOT_TABLES, RL_TABLES, roundView, tcpRoundView, tableView, rankOf, PlayError };
});
