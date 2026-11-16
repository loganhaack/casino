/*
 * Three Card Poker: the ONE copy of the game's logic.
 *
 * Hand evaluation, the six-card bonus evaluator, the deal, and settlement.
 * Loaded by index.html (<script src>), by enumerate.js and the harnesses
 * (require), and by the online server (supabase/functions/_shared/, copied by
 * sync-shared.js). Before this file, eval3() was duplicated in index.html and
 * enumerate.js and kept in sync by hand; now the enumerator validates the very
 * function the page and the server play with.
 *
 * Paytables live in tables.js (TABLE_RULES.tcp). Change either file and re-run
 *   node enumerate.js && node test-payouts.js 200000
 *
 * Card = integer 0..51. rank = c % 13 (0 = Two .. 12 = Ace), suit = (c/13)|0.
 * Straight beats flush in Three Card Poker (easy to get wrong).
 *
 * A classic script (not an ES module) so index.html still opens from file://.
 */
(function (root) {
  'use strict';

  const rankOf = c => c % 13;
  const suitOf = c => (c / 13) | 0;

  /* ------------------------------------------------- three-card hands -- */

  const CAT = { HIGH: 0, PAIR: 1, FLUSH: 2, STRAIGHT: 3, TRIPS: 4, SF: 5 };
  const CAT_NAME = ['High card', 'Pair', 'Flush', 'Straight', 'Three of a kind', 'Straight flush'];
  const CAT_KEY  = ['high', 'pair', 'flush', 'straight', 'trips', 'straightFlush'];

  /**
   * value = category << 20 | tiebreak, so a larger value is always the
   * stronger hand. The tiebreak packs the ordered ranks in 5-bit fields.
   */
  function eval3(a, b, c) {
    let r0 = rankOf(a), r1 = rankOf(b), r2 = rankOf(c), t;
    if (r0 < r1) { t = r0; r0 = r1; r1 = t; }
    if (r1 < r2) { t = r1; r1 = r2; r2 = t; }
    if (r0 < r1) { t = r0; r0 = r1; r1 = t; }

    const flush = suitOf(a) === suitOf(b) && suitOf(b) === suitOf(c);

    let straight = false, sHigh = r0;
    if (r0 === r1 + 1 && r1 === r2 + 1) straight = true;
    else if (r0 === 12 && r1 === 1 && r2 === 0) { straight = true; sHigh = 1; }  // A-2-3 wheel

    let cat, tie;
    if (straight && flush)            { cat = CAT.SF;       tie = sHigh; }
    else if (r0 === r1 && r1 === r2)  { cat = CAT.TRIPS;    tie = r0; }
    else if (straight)                { cat = CAT.STRAIGHT; tie = sHigh; }
    else if (flush)                   { cat = CAT.FLUSH;    tie = (r0 << 10) | (r1 << 5) | r2; }
    else if (r0 === r1 || r1 === r2)  {
      cat = CAT.PAIR;
      const pr = (r0 === r1) ? r0 : r1;
      const kk = (r0 === r1) ? r2 : r0;
      tie = (pr << 5) | kk;
    }
    else                              { cat = CAT.HIGH;     tie = (r0 << 10) | (r1 << 5) | r2; }

    return { value: (cat << 20) | tie, cat, name: CAT_NAME[cat] };
  }

  // Q-6-4 offsuit, the standard play/fold threshold.
  const Q64 = eval3(10, 13 + 4, 26 + 2).value;
  // The dealer qualifies on Q-high, any kicker: the lowest qualifier is Q-3-2.
  const QUALIFY = eval3(10, 13 + 1, 26 + 0).value;

  /* ------------------------------- best five of six (Six Card Bonus) -- */

  const CAT5_NAME = ['Nothing', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
                     'Flush', 'Full house', 'Four of a kind', 'Straight flush', 'Royal flush'];
  const CAT5_KEY  = [null, null, null, 'trips', 'straight', 'flush', 'fullHouse',
                     'quads', 'straightFlush', 'royalFlush'];

  /** High rank of the best straight in a 13-bit rank mask, or -1. */
  function bestStraight(mask) {
    const WHEEL = (1 << 12) | (1 << 3) | (1 << 2) | (1 << 1) | 1;   // A-2-3-4-5
    for (let hi = 12; hi >= 4; hi--) {
      const need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
      if ((mask & need) === need) return hi;
    }
    return (mask & WHEEL) === WHEEL ? 3 : -1;
  }

  // Scratch buffers: the enumerator calls categorize6 20.3M times, and
  // allocating per call would spend most of that in the GC. Safe because
  // the function never yields.
  const _rc = new Int32Array(13), _sm = new Int32Array(4), _sc = new Int32Array(4);

  /** Category index (CAT5_NAME) of the best five-card hand in six cards. */
  function categorize6(cards) {
    const rc = _rc.fill(0), sm = _sm.fill(0), sc = _sc.fill(0);
    let mask = 0;
    for (let i = 0; i < 6; i++) {
      const c = cards[i], r = c % 13, s = (c / 13) | 0;
      rc[r]++; sm[s] |= (1 << r); sc[s]++; mask |= (1 << r);
    }
    for (let s = 0; s < 4; s++) {
      if (sc[s] >= 5) {
        const sf = bestStraight(sm[s]);
        if (sf === 12) return 9;   // royal
        if (sf >= 0) return 8;     // straight flush
        return 5;                  // flush
      }
    }
    let trips = 0, pairs = 0, quads = 0;
    for (let r = 0; r < 13; r++) {
      if (rc[r] === 4) quads++; else if (rc[r] === 3) trips++; else if (rc[r] === 2) pairs++;
    }
    if (quads) return 7;
    if (trips >= 2 || (trips === 1 && pairs >= 1)) return 6;   // full house
    if (bestStraight(mask) >= 0) return 4;
    if (trips === 1) return 3;
    if (pairs >= 2) return 2;
    if (pairs === 1) return 1;
    return 0;
  }

  /* ------------------------------------------------------------- deal -- */

  /** A fresh 52-card deck, Fisher-Yates shuffled with randInt(n) in [0, n). */
  function shuffledDeck(randInt) {
    const d = new Array(52);
    for (let i = 0; i < 52; i++) d[i] = i;
    for (let i = 51; i > 0; i--) {         // back to front
      const j = randInt(i + 1);
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  /** One hand from a fresh deck: { player: [3 cards], dealer: [3 cards] }. */
  function dealHand(randInt) {
    const deck = shuffledDeck(randInt);
    return {
      player: [deck.pop(), deck.pop(), deck.pop()],
      dealer: [deck.pop(), deck.pop(), deck.pop()],
    };
  }

  const BET_KEYS = ['ante', 'pp', 'scb'];

  /**
   * Is this a bet the table takes? Each spot is 0, or a whole multiple of
   * rules.betStep at least rules.minBet; at least one spot is bet. Returns an
   * error message, or null if the bets are fine. (Table limit and bankroll are
   * the caller's: they depend on the player, the rules don't.)
   */
  function betError(bets, rules) {
    if (!bets || typeof bets !== 'object') return 'Bad bets.';
    let total = 0;
    for (const k of BET_KEYS) {
      const v = bets[k];
      if (!Number.isInteger(v) || v < 0) return 'Bets must be whole chips.';
      if (v > 0 && (v < rules.minBet || v % rules.betStep !== 0)) {
        return `Each bet is 0 or a multiple of ${rules.betStep}, at least ${rules.minBet}.`;
      }
      total += v;
    }
    return total > 0 ? null : 'Place at least one bet.';
  }

  /* ----------------------------------------------------------- settle -- */

  /**
   * Settle one hand. The only place Three Card Poker payouts are computed,
   * offline (index.html) and online (the play server) alike.
   *
   *   bets    { ante, pp, scb }
   *   raised  true if the player made the Play bet (equal to the ante)
   *   rules   TABLE_RULES.tcp
   *
   * `stake` is everything wagered (incl. the Play bet); `returned` is
   * everything handed back (stakes + winnings). net = returned - stake.
   * ppRet / scbRet / anteRet split `returned` by spot (for the chip picture).
   */
  function settle(bets, player, dealer, raised, rules) {
    const p = eval3(player[0], player[1], player[2]);
    const d = eval3(dealer[0], dealer[1], dealer[2]);
    if (raised && !(bets.ante > 0)) throw new Error('Cannot play without an ante.');
    const qualified = d.value >= QUALIFY;
    const stake = bets.ante + bets.pp + bets.scb + (raised ? bets.ante : 0);

    // Pair Plus: pays on the player's hand alone.
    const ppPay = bets.pp > 0 ? (rules.pairPlus[CAT_KEY[p.cat]] || 0) : 0;
    const ppWin = bets.pp * ppPay;
    const ppRet = ppPay ? bets.pp + ppWin : 0;

    // Six Card Bonus: best five of the player's three plus the dealer's three.
    let scbCat = null, scbPay = 0;
    if (bets.scb > 0) {
      scbCat = categorize6([player[0], player[1], player[2], dealer[0], dealer[1], dealer[2]]);
      const key = CAT5_KEY[scbCat];
      scbPay = key ? (rules.sixCard[key] || 0) : 0;
    }
    const scbWin = bets.scb * scbPay;
    const scbRet = scbPay ? bets.scb + scbWin : 0;

    // Ante / Play. The ante bonus pays even on a fold or a dealer win.
    let outcome = 'n/a', anteRet = 0, bonusPay = 0, bonus = 0;
    if (bets.ante > 0) {
      const a = bets.ante;
      bonusPay = rules.anteBonus[CAT_KEY[p.cat]] || 0;
      bonus = bonusPay * a;
      anteRet = bonus;
      if (!raised)              outcome = 'fold';
      else if (!qualified)    { outcome = 'no-qualify'; anteRet += a + a + a; }   // ante wins, play pushes
      else if (p.value > d.value)   { outcome = 'win';  anteRet += (a + a) + (a + a); }
      else if (p.value === d.value) { outcome = 'push'; anteRet += a + a; }
      else                      outcome = 'lose';
    }

    const returned = ppRet + scbRet + anteRet;
    return {
      pCat: p.cat, pName: p.name, dCat: d.cat, dName: d.name,
      qualified, raised: !!raised, outcome,
      stake, returned, net: returned - stake,
      ppPay, ppWin, ppRet, scbCat, scbPay, scbWin, scbRet, bonusPay, bonus, anteRet,
    };
  }

  /** Economy facts about a settled hand (the page and the server both build them here). */
  function facts(res, bets, minBet) {
    return {
      game: 'tcp', wagered: res.stake, minBet,
      pairPlusBet: bets.pp, pairPlusWin: res.ppPay > 0,
      pairPlusBig: bets.pp > 0 && (res.pCat === CAT.TRIPS || res.pCat === CAT.SF),
      tcpStraightPlus: res.pCat >= CAT.STRAIGHT,
    };
  }

  const TCP = {
    rankOf, suitOf, CAT, CAT_NAME, CAT_KEY, CAT5_NAME, CAT5_KEY,
    eval3, Q64, QUALIFY, bestStraight, categorize6,
    shuffledDeck, dealHand, BET_KEYS, betError, settle, facts,
  };

  if (typeof module === 'object' && module.exports) module.exports = TCP;
  else root.TCP = TCP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
