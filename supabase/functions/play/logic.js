/*
 * Online table server: the game logic, with no database and no Deno in it.
 *
 * It runs the SAME blackjack-core.js / tables.js / economy.js the page runs
 * (the byte-identical copies in ../_shared/, see sync-shared.js), so the
 * server deals and settles exactly the game the harnesses verify. Nothing
 * here computes a payout; BJ.settle() does, as it does in the page.
 *
 * It talks to storage only through a small `store` object, so Node tests can
 * drive it against an in-memory store (test-server.js) and the Deno wrapper
 * (index.ts) plugs in Postgres. The store's commit() must behave like
 * commit_turn() in the wallets migration: refuse unless the balance moved by
 * exactly the sum of the ledger rows, and throw {code: '40001'} if the wallet
 * version is stale.
 *
 * What the player is sent (view functions below): their balance, rank, and
 * each table's round with the dealer's hole card hidden until the round is
 * over. NEVER the shoe. That is the reason dealing moved server-side.
 *
 * Not online yet (next step): quests, event promos, Double XP, wheels, vault,
 * shop. They need the event clock decided first (events run on the player's
 * local time, the server runs on UTC). XP is awarded at the base rate so
 * table limits work.
 *
 * Classic UMD script: Node require()s it; Deno imports the _shared files and
 * then this, and it registers globalThis.PLAY.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../_shared/blackjack-core.js'),
      require('../_shared/economy.js'),
      require('../_shared/tables.js'));
  } else {
    root.PLAY = factory(root.BJ, root.ECON, root.TABLE_RULES);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (BJ, ECON, TABLE_RULES) {
  'use strict';

  /** Online tables. Same rules objects the page builds (BJ_TABLES). */
  const TABLES = {
    bj: BJ.makeRules(TABLE_RULES.blackjack),
    fb: BJ.makeRules(TABLE_RULES.freeBet),
  };
  const SIDE_KEYS = Object.keys(BJ.SIDE_BETS);
  const ACTIONS = ['insure', 'decline', 'hit', 'stand', 'double', 'split'];
  const MAX_RETRIES = 4;

  /** An error the player caused (bad bet, stale click). Sent back as-is. */
  class PlayError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const refuse = (code, message) => { throw new PlayError(code, message); };

  const isWhole = (v) => Number.isInteger(v) && v >= 0;

  function rankOf(econ) {
    const lv = ECON.levelFromXp(econ.xp || 0);
    const tier = ECON.tierIndex(lv.level);
    return { xp: econ.xp || 0, level: lv.level, into: lv.into, need: lv.need,
             tier, tierName: ECON.TIERS[tier].name, maxBet: ECON.TIERS[tier].maxBet };
  }

  const emptyTable = () => ({ shoe: null, round: null, last: null, n: 0, seq: 0 });

  /* ------------------------------------------------------------- views -- */

  /** A round as the player may see it: no rules blob, hole card hidden until done. */
  function roundView(round) {
    if (!round) return null;
    const { rules, ...rest } = round;
    const v = JSON.parse(JSON.stringify(rest));
    if (round.phase !== 'done' && v.dealer.length > 1) v.dealer = [v.dealer[0], null];
    return v;
  }

  function tableView(ts, chips) {
    const r = ts.round;
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

  function walletView(w) {
    return { chips: w.chips, vault: w.vault, rank: rankOf(w.econ) };
  }

  /* -------------------------------------------------------------- rules -- */

  /** Settle bookkeeping once BJ has finished a round. Mutates the turn. */
  function settled(turn, t) {
    const r = turn.ts.round;
    if (r.phase !== 'done') return;
    if (r.returned > 0) {
      turn.ledger.push({ account: 'chips', amount: r.returned, kind: 'payout', table_id: t, ref: turn.ref });
      turn.chips += r.returned;
    }
    turn.econ.xp = (turn.econ.xp || 0) + ECON.xpForRound(r.wagered, TABLE_RULES.bjMinBet);
    turn.ts.last = r;
    turn.ts.round = null;
    turn.ts.n++;
  }

  function deal(turn, t, req, randInt) {
    const rules = TABLES[t];
    const ts = turn.ts;
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
    const limit = rankOf(turn.econ).maxBet;
    if (Math.max(bet, ...Object.values(side)) > limit) {
      refuse('over_limit', `Your table limit is ${limit.toLocaleString('en-US')} per bet. Rank up to raise it.`);
    }
    const total = bet + Object.values(side).reduce((a, b) => a + b, 0);
    if (turn.chips < total) refuse('not_enough_chips', 'Not enough chips for the main bet plus side bets.');

    if (!ts.shoe || ts.shoe.decks !== rules.decks || BJ.needsShuffle(ts.shoe)) {
      ts.shoe = BJ.newShoe(rules, randInt);
      turn.shuffled = true;
    }
    turn.ref = `${t}:${ts.n + 1}`;
    ts.round = BJ.startRound(ts.shoe, bet, rules, { randInt, side });
    ts.last = null;
    turn.ledger.push({ account: 'chips', amount: -ts.round.wagered, kind: 'bet', table_id: t, ref: turn.ref });
    turn.chips -= ts.round.wagered;
    settled(turn, t);
  }

  function act(turn, t, req, randInt) {
    const ts = turn.ts;
    const r = ts.round;
    if (!r) refuse('no_round', 'There is no round in progress.');
    if (!ACTIONS.includes(req.action)) refuse('bad_request', 'Unknown action.');
    if (!BJ.legalActions(r, turn.chips)[req.action]) refuse('illegal', `You can't ${req.action} right now.`);
    turn.ref = `${t}:${ts.n + 1}`;
    const before = r.wagered;
    BJ.act(r, ts.shoe, req.action, turn.chips, { randInt });
    const more = r.wagered - before;
    if (more > 0) {
      turn.ledger.push({ account: 'chips', amount: -more, kind: 'bet', table_id: t, ref: turn.ref });
      turn.chips -= more;
    }
    settled(turn, t);
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
   *
   * `seq` is the table's seq from the view the player clicked on. A double
   * click or a second tab sends a stale seq and is refused, so one click can
   * never place two bets.
   */
  async function handle(store, userId, req, opts) {
    const randInt = (opts && opts.randInt) || undefined;
    if (!req || typeof req !== 'object') return fail('bad_request', 'Bad request.');
    if (!['state', 'deal', 'act'].includes(req.op)) return fail('bad_request', 'Unknown op.');
    if (req.op !== 'state' && !TABLES[req.table]) return fail('bad_request', 'Unknown table.');

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let w = await store.wallet(userId);
      if (!w) w = await store.openWallet(userId, TABLE_RULES.startingChips);

      if (req.op === 'state') {
        const tables = {};
        for (const t of Object.keys(TABLES)) tables[t] = tableView((await store.table(userId, t)) || emptyTable(), w.chips);
        return { ok: true, wallet: walletView(w), tables };
      }

      const t = req.table;
      const ts = (await store.table(userId, t)) || emptyTable();
      const turn = { chips: w.chips, econ: { ...(w.econ || {}) }, ts, ledger: [], ref: null, shuffled: false };
      try {
        if (req.seq !== ts.seq) refuse('stale', 'The table changed (another tab or a double click). Showing the current state.');
        if (req.op === 'deal') deal(turn, t, req, randInt);
        else act(turn, t, req, randInt);
      } catch (e) {
        if (!(e instanceof PlayError)) throw e;
        const cur = (await store.table(userId, t)) || emptyTable();
        return { ok: false, error: e.code, message: e.message, wallet: walletView(w), table: t, view: tableView(cur, w.chips) };
      }

      ts.seq++;
      try {
        await store.commit(userId, w.version, {
          chips: turn.chips, vault: w.vault, econ: turn.econ, ledger: turn.ledger,
          tableId: t, tableState: ts,
        });
      } catch (e) {
        if (e && e.code === '40001') continue;   // someone else committed first; start over
        throw e;
      }
      const nw = { ...w, chips: turn.chips, econ: turn.econ, version: w.version + 1 };
      return { ok: true, wallet: walletView(nw), table: t, view: tableView(ts, nw.chips), shuffled: turn.shuffled };
    }
    return fail('busy', 'The server was busy with another request. Try again.');
  }

  function fail(error, message) { return { ok: false, error, message }; }

  return { handle, TABLES, roundView, tableView, rankOf, PlayError };
});
