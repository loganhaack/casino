/*
 * Blackjack core: card values, hand totals, naturals, dealer draw rule.
 *
 * ONE copy of this logic, shared by everything:
 *   - the game:   <script src="blackjack-core.js"></script>   (exposes BJ)
 *   - Node:       const BJ = require('./blackjack-core.js');
 *
 * This is a classic script, not an ES module, on purpose: classic scripts
 * load from file:// with no server, so index.html stays openable as a bare
 * file (CLAUDE.md hard rule 4) without duplicating code the way eval3() is.
 *
 * Cards are integers 0..51, same encoding as Three Card Poker:
 *   rank = c % 13  (0=Two .. 7=Nine, 8=Ten, 9=Jack, 10=Queen, 11=King, 12=Ace)
 *   suit = (c / 13) | 0
 * A multi-deck shoe is just an array with repeated card ints.
 */
(function (root) {
  'use strict';

  const ACE = 12;

  function assertCard(c) {
    if (!Number.isInteger(c) || c < 0 || c > 51) {
      throw new RangeError('Not a card (expected integer 0..51): ' + c);
    }
  }

  /** Blackjack value of a card, counting an Ace as 1. */
  function cardValue(c) {
    assertCard(c);
    const r = c % 13;
    if (r === ACE) return 1;
    if (r >= 8) return 10;   // Ten, Jack, Queen, King
    return r + 2;            // Two..Nine
  }

  /**
   * Total a hand.
   *
   * Returns { total, soft, bust }:
   *   total  best total: highest value <= 21 if one exists, else the lowest
   *          (bust) value, i.e. every Ace counted as 1.
   *   soft   true iff an Ace is currently being counted as 11.
   *   bust   total > 21.
   *
   * At most one Ace can ever count as 11 (two would be 22), so: count every
   * Ace as 1, then promote one Ace to 11 if that doesn't bust.
   */
  function handValue(cards) {
    if (!Array.isArray(cards)) throw new TypeError('handValue expects an array of cards');
    let hard = 0;
    let hasAce = false;
    for (let i = 0; i < cards.length; i++) {
      const v = cardValue(cards[i]);
      hard += v;
      if (v === 1) hasAce = true;
    }
    const soft = hasAce && hard + 10 <= 21;
    const total = soft ? hard + 10 : hard;
    return { total, soft, bust: total > 21 };
  }

  /**
   * Natural blackjack: exactly two cards totalling 21, on a hand that did not
   * come from a split. 21 on a split hand (e.g. split Aces, then a King) is an
   * ordinary 21 and pays even money.
   *
   * fromSplit is required and has no default, so a caller can't forget it.
   */
  function isNatural(cards, fromSplit) {
    if (typeof fromSplit !== 'boolean') {
      throw new TypeError('isNatural requires fromSplit to be true or false');
    }
    return !fromSplit && cards.length === 2 && handValue(cards).total === 21;
  }

  /**
   * Dealer draw rule. Hits 16 or less, stands on hard 17+.
   * Soft 17 hits iff rules.hitSoft17 is true (H17); stands otherwise (S17).
   */
  function dealerShouldHit(cards, rules) {
    if (!rules || typeof rules.hitSoft17 !== 'boolean') {
      throw new TypeError('dealerShouldHit requires rules.hitSoft17 to be true or false');
    }
    const h = handValue(cards);
    if (h.total < 17) return true;
    if (h.total === 17 && h.soft) return rules.hitSoft17;
    return false;
  }

  /* =========================================================================
     RULES
     Every rule the engine knows about. Free Bet will be more keys here, not
     a fork of the engine.

     Not supported (deliberately absent rather than half-implemented):
       - No-peek / European no-hole-card. The dealer always peeks with an
         Ace or ten up, so a dealer blackjack only ever takes the original bet.
       - Surrender.
     ========================================================================= */

  const DEFAULT_RULES = Object.freeze({
    decks: 6,
    penetration: 0.75,        // reshuffle once this fraction of the shoe is dealt
    hitSoft17: false,         // false = S17, true = H17
    blackjackPays: Object.freeze([3, 2]),
    insurance: true,          // offered when the dealer shows an Ace; pays 2:1
    doubleOn: 'any',          // 'any' | '9-11' | '10-11' (first two cards only)
    doubleAfterSplit: true,
    maxHands: 4,              // a hand may be split until there are this many
    resplitAces: false,
    hitSplitAces: false,      // false = split Aces get exactly one card each
    betUnit: 2,               // bets must be a multiple of this (keeps 3:2 and insurance whole)

    // Free Bet Blackjack. All three on (with H17) is the Free Bet game.
    push22: false,            // dealer final 22 pushes every live player hand (naturals already paid)
    freeDoubles: false,       // doubling a hard two-card 9, 10 or 11 costs nothing
    freeSplits: false,        // splitting any pair except ten-value cards costs nothing

    // Side bets: a paytable (category -> pays N to 1) or null = not offered.
    //   perfectPairs:   player's first two cards. Categories perfect / colored / mixed.
    //   twentyOnePlus3: player's first two cards + dealer upcard as a 3-card poker hand.
    //                   Categories suitedTrips / straightFlush / trips / straight / flush.
    perfectPairs: null,
    twentyOnePlus3: null,
  });

  const SIDE_BETS = {
    perfectPairs:   ['perfect', 'colored', 'mixed'],
    twentyOnePlus3: ['suitedTrips', 'straightFlush', 'trips', 'straight', 'flush'],
  };

  const DOUBLE_ON = { 'any': () => true, '9-11': t => t >= 9 && t <= 11, '10-11': t => t >= 10 && t <= 11 };

  function makeRules(overrides) {
    const r = Object.assign({}, DEFAULT_RULES, overrides || {});
    const bad = (msg) => { throw new RangeError('Invalid blackjack rules: ' + msg); };
    if (!Number.isInteger(r.decks) || r.decks < 1 || r.decks > 8) bad('decks must be 1..8');
    if (!(r.penetration > 0 && r.penetration < 1)) bad('penetration must be in (0, 1)');
    for (const k of ['hitSoft17', 'insurance', 'doubleAfterSplit', 'resplitAces', 'hitSplitAces',
                     'push22', 'freeDoubles', 'freeSplits']) {
      if (typeof r[k] !== 'boolean') bad(k + ' must be boolean');
    }
    const bp = r.blackjackPays;
    if (!Array.isArray(bp) || bp.length !== 2 || !bp.every(n => Number.isInteger(n) && n > 0)) {
      bad('blackjackPays must be [numerator, denominator]');
    }
    if (!DOUBLE_ON[r.doubleOn]) bad('doubleOn must be one of ' + Object.keys(DOUBLE_ON).join(', '));
    if (!Number.isInteger(r.maxHands) || r.maxHands < 1) bad('maxHands must be an integer >= 1');
    if (!Number.isInteger(r.betUnit) || r.betUnit < 1) bad('betUnit must be an integer >= 1');
    // Chips are whole numbers. Refuse any rule set that could ever owe a fraction.
    if ((r.betUnit * bp[0]) % bp[1] !== 0) bad('betUnit must make the blackjack payout whole');
    if (r.insurance && r.betUnit % 2 !== 0) bad('insurance needs an even betUnit (insurance is half the bet)');
    for (const kind of Object.keys(SIDE_BETS)) {
      const pt = r[kind];
      if (pt === null) continue;
      if (typeof pt !== 'object') bad(kind + ' must be a paytable object or null');
      for (const k of Object.keys(pt)) {
        if (!SIDE_BETS[kind].includes(k)) bad(`${kind} has unknown category '${k}'`);
        if (!Number.isInteger(pt[k]) || pt[k] < 0) bad(`${kind}.${k} must be a whole number of units`);
      }
      r[kind] = Object.freeze(Object.assign({}, pt));
    }
    return Object.freeze(r);
  }

  /* =========================================================================
     SIDE BETS: categories and exact distributions
     ========================================================================= */

  const rankOf = c => c % 13;
  const suitOf = c => (c / 13) | 0;
  const isRed = c => { const s = suitOf(c); return s === 1 || s === 2; };   // diamonds, hearts

  /** Perfect Pairs on two cards: 'perfect' (same card), 'colored', 'mixed', or null. */
  function perfectPairsHand(a, b) {
    assertCard(a); assertCard(b);
    if (rankOf(a) !== rankOf(b)) return null;
    if (a === b) return 'perfect';
    return isRed(a) === isRed(b) ? 'colored' : 'mixed';
  }

  /**
   * 21+3 on three cards. Categories are exclusive, highest first:
   * suited trips > straight flush > trips > straight > flush. A-2-3 and Q-K-A
   * are straights; K-A-2 is not.
   */
  function twentyOnePlus3Hand(a, b, c) {
    assertCard(a); assertCard(b); assertCard(c);
    const r = [rankOf(a), rankOf(b), rankOf(c)].sort((x, y) => x - y);
    const flush = suitOf(a) === suitOf(b) && suitOf(b) === suitOf(c);
    const trips = r[0] === r[2];
    if (trips) return flush ? 'suitedTrips' : 'trips';
    const straight = (r[0] + 1 === r[1] && r[1] + 1 === r[2]) ||
                     (r[0] === 0 && r[1] === 1 && r[2] === 12);     // A-2-3 (Ace = rank 12)
    if (straight) return flush ? 'straightFlush' : 'straight';
    return flush ? 'flush' : null;
  }

  /**
   * Exact category counts for a side bet dealt from a full shoe of `decks`
   * decks. Counts unordered card combinations: C(52d, 2) for Perfect Pairs,
   * C(52d, 3) for 21+3. Walks the 52 distinct cards with multiplicities.
   */
  function sideBetCounts(kind, decks) {
    const d = decks;
    const C2 = d * (d - 1) / 2, C3 = d * (d - 1) * (d - 2) / 6;
    const counts = { lose: 0 };
    for (const k of SIDE_BETS[kind]) counts[k] = 0;
    const add = (cat, n) => { counts[cat || 'lose'] += n; };
    if (kind === 'perfectPairs') {
      for (let i = 0; i < 52; i++) for (let j = i; j < 52; j++) {
        add(perfectPairsHand(i, j), i === j ? C2 : d * d);
      }
    } else if (kind === 'twentyOnePlus3') {
      for (let i = 0; i < 52; i++) for (let j = i; j < 52; j++) for (let k = j; k < 52; k++) {
        const n = i === k ? C3 : (i === j || j === k) ? C2 * d : d * d * d;
        add(twentyOnePlus3Hand(i, j, k), n);
      }
    } else throw new RangeError('Unknown side bet: ' + kind);
    counts.total = Object.keys(counts).reduce((s, k) => s + counts[k], 0);
    return counts;
  }

  // A hand also qualifies for the lower categories it contains (suited trips
  // are trips and a flush). If a paytable omits a category, the best of the
  // ones it does list applies.
  const ALSO_COUNTS_AS = {
    suitedTrips: ['suitedTrips', 'trips', 'flush'],
    straightFlush: ['straightFlush', 'straight', 'flush'],
    trips: ['trips'], straight: ['straight'], flush: ['flush'],
    perfect: ['perfect', 'colored'], colored: ['colored'], mixed: ['mixed'],
  };

  /** Pays N to 1 for this category under this paytable; 0 = the bet loses. */
  function sideBetPays(paytable, cat) {
    if (!cat) return 0;
    let best = 0;
    for (const k of ALSO_COUNTS_AS[cat]) if (paytable[k] > best) best = paytable[k];
    return best;
  }

  /** Exact expected return per unit bet for a paytable (negative = house edge). */
  function sideBetReturn(paytable, counts) {
    let ev = 0;
    for (const k of Object.keys(counts)) {
      if (k === 'total') continue;
      const pays = k === 'lose' ? 0 : sideBetPays(paytable, k);
      ev += (pays > 0 ? pays : -1) * counts[k] / counts.total;
    }
    return ev;
  }

  /* =========================================================================
     SHOE
     Plain data (JSON-serializable) so an in-progress shoe can be saved.
     ========================================================================= */

  // Random words are fetched from crypto 1024 at a time; one call per draw
  // made the shuffle ~75% of total simulation time. Same source, same
  // rejection sampling, just batched.
  const RAND_BUF = new Uint32Array(1024);
  let randPos = RAND_BUF.length;

  /** Uniform integer in [0, n). crypto + rejection sampling, no modulo bias. */
  function cryptoRandInt(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    let v;
    do {
      if (randPos === RAND_BUF.length) { globalThis.crypto.getRandomValues(RAND_BUF); randPos = 0; }
      v = RAND_BUF[randPos++];
    } while (v >= limit);
    return v % n;
  }

  function shuffleInPlace(a, randInt) {
    for (let i = a.length - 1; i > 0; i--) {      // Fisher-Yates, back to front
      const j = randInt(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function newShoe(rules, randInt) {
    const n = 52 * rules.decks;
    const cards = new Array(n);
    for (let i = 0; i < n; i++) cards[i] = i % 52;
    shuffleInPlace(cards, randInt || cryptoRandInt);
    return { decks: rules.decks, cards, pos: 0, cut: Math.floor(n * rules.penetration), stacked: false };
  }

  /** A shoe that deals exactly these cards in order. For tests and replays. */
  function stackedShoe(cards) {
    cards.forEach(assertCard);
    return { decks: 0, cards: cards.slice(), pos: 0, cut: Infinity, stacked: true };
  }

  /** True when the cut card has come out: shuffle before the next round. */
  function needsShuffle(shoe) { return shoe.pos >= shoe.cut; }

  function cardsOnTable(round) {
    const out = round.dealer.slice();
    for (const h of round.hands) out.push(...h.cards);
    return out;
  }

  /**
   * Draw for a round. If the shoe runs dry mid-round (possible with one deck
   * and a lot of splitting), reshuffle every card not currently on the table,
   * which is what a dealer does with the discard tray.
   */
  function drawCard(round, shoe, randInt) {
    if (shoe.pos >= shoe.cards.length) {
      if (shoe.stacked) throw new Error('Stacked shoe exhausted');
      const left = new Array(52).fill(shoe.decks);
      for (const c of cardsOnTable(round)) left[c]--;
      const cards = [];
      for (let c = 0; c < 52; c++) for (let k = 0; k < left[c]; k++) cards.push(c);
      shuffleInPlace(cards, randInt || cryptoRandInt);
      shoe.cards = cards; shoe.pos = 0; shoe.cut = 0;   // cut = 0: full reshuffle after this round
      round.midRoundReshuffle = true;
    }
    return shoe.cards[shoe.pos++];
  }

  /* =========================================================================
     ROUND
     A round is plain data. Chips flow through exactly two fields:
       round.wagered   every chip the player has put at risk (bet, double,
                       split, insurance). Grows as the player acts.
       round.returned  every chip handed back at settlement (stake + winnings).
     round.net = returned - wagered. The caller deducts wagered increases from
     the bankroll as they happen and credits returned once at the end.

     Each hand has two amounts in play:
       hand.bet    the player's own chips on the hand (counted in wagered)
       hand.free   house-funded "free bet" chips (Free Bet doubles/splits).
                   Never counted in wagered. A win pays on bet + free; a push
                   or loss just takes the free chips back.
     ========================================================================= */

  function newHand(cards, bet, free, fromSplit, splitAces) {
    return { cards, bet, free, fromSplit, splitAces, doubled: false, freeDoubled: false,
             done: false, outcome: null, returned: 0 };
  }

  /** Chips in action on a hand: own plus free. */
  const actionOf = (h) => h.bet + h.free;

  /** Free Bet: a two-card hard 9, 10 or 11 doubles for free. */
  function isFreeDouble(round, h) {
    if (!round.rules.freeDoubles || h.cards.length !== 2) return false;
    const v = handValue(h.cards);
    return !v.soft && v.total >= 9 && v.total <= 11;
  }

  /** Free Bet: any pair except ten-value cards splits for free. */
  function isFreeSplit(round, h) {
    return round.rules.freeSplits && h.cards.length === 2 && cardValue(h.cards[0]) !== 10;
  }

  /** What the next double / split on the active hand would cost in own chips. */
  function actionCost(round, action) {
    const h = round.hands[round.active];
    if (action === 'double') return isFreeDouble(round, h) ? 0 : actionOf(h);
    if (action === 'split')  return isFreeSplit(round, h) ? 0 : actionOf(h);
    if (action === 'insure') return round.baseBet / 2;
    return 0;
  }

  /**
   * Deal a new round. P, D(up), P, D(hole).
   * opts.randInt: RNG for mid-round reshuffles (defaults to crypto).
   * opts.side:    side bets, e.g. { perfectPairs: 10, twentyOnePlus3: 5 }.
   *               Only bets the rules offer (paytable not null) are allowed.
   */
  function startRound(shoe, bet, rules, opts) {
    if (!Number.isInteger(bet) || bet <= 0 || bet % rules.betUnit !== 0) {
      throw new RangeError(`Bet must be a positive multiple of ${rules.betUnit}: ${bet}`);
    }
    const sideIn = (opts && opts.side) || {};
    for (const k of Object.keys(sideIn)) {
      const v = sideIn[k];
      if (!SIDE_BETS[k]) throw new RangeError('Unknown side bet: ' + k);
      if (!Number.isInteger(v) || v < 0) throw new RangeError(`Side bet ${k} must be a whole number >= 0: ${v}`);
      if (v > 0 && !rules[k]) throw new RangeError(`Side bet ${k} is not offered at this table`);
    }
    const round = {
      rules, phase: 'dealing', dealer: [], hands: [newHand([], bet, 0, false, false)], active: 0,
      baseBet: bet, insurance: 0, insuranceReturned: 0,
      wagered: bet, returned: 0, net: 0, dealerBlackjack: false, dealer22Push: false,
      midRoundReshuffle: false,
    };
    const ri = opts && opts.randInt;
    const hand = round.hands[0];
    hand.cards.push(drawCard(round, shoe, ri));
    round.dealer.push(drawCard(round, shoe, ri));
    hand.cards.push(drawCard(round, shoe, ri));
    round.dealer.push(drawCard(round, shoe, ri));

    // Side bets are decided by the cards just dealt. Payout happens in settle().
    round.side = {};
    for (const kind of Object.keys(SIDE_BETS)) {
      const amt = sideIn[kind] || 0;
      if (!amt) continue;
      const cat = kind === 'perfectPairs'
        ? perfectPairsHand(hand.cards[0], hand.cards[1])
        : twentyOnePlus3Hand(hand.cards[0], hand.cards[1], round.dealer[0]);
      const pays = sideBetPays(rules[kind], cat);
      round.side[kind] = { bet: amt, outcome: pays > 0 ? cat : null, pays, returned: pays > 0 ? amt * (pays + 1) : 0 };
      round.wagered += amt;
    }

    if (rules.insurance && cardValue(round.dealer[0]) === 1) {
      round.phase = 'insurance';
      return round;
    }
    return peek(round);
  }

  /** Dealer checks the hole card. Naturals on either side end the round now. */
  function peek(round) {
    round.dealerBlackjack = isNatural(round.dealer, false);
    if (round.dealerBlackjack || isNatural(round.hands[0].cards, false)) {
      round.hands[0].done = true;
      return settle(round);
    }
    round.phase = 'player';
    round.active = 0;
    return round;
  }

  function isPairOfAces(h) {
    return h.cards.length === 2 && cardValue(h.cards[0]) === 1 && cardValue(h.cards[1]) === 1;
  }

  /** Split Aces that may not be hit: the only possible moves are stand or resplit. */
  function lockedSplitAce(h, rules) { return h.splitAces && !rules.hitSplitAces; }

  /** Split is legal by the rules (bankroll aside). */
  function canSplitByRules(round, h) {
    const r = round.rules;
    if (h.cards.length !== 2) return false;
    if (cardValue(h.cards[0]) !== cardValue(h.cards[1])) return false;   // any two tens may split
    if (round.hands.length >= r.maxHands) return false;
    if (isPairOfAces(h) && h.splitAces && !r.resplitAces) return false;
    return true;
  }

  /**
   * Legal actions right now. `available` is the bankroll the player can still
   * put up (chips not already wagered); defaults to unlimited.
   */
  function legalActions(round, available) {
    if (available === undefined) available = Infinity;
    if (round.phase === 'insurance') {
      return { insure: available >= round.baseBet / 2, decline: true };
    }
    if (round.phase !== 'player') return {};
    const r = round.rules;
    const h = round.hands[round.active];
    const locked = lockedSplitAce(h, r);
    const two = h.cards.length === 2;
    return {
      hit: !locked,
      stand: true,
      double: two && !locked && (!h.fromSplit || r.doubleAfterSplit) &&
              (isFreeDouble(round, h) || DOUBLE_ON[r.doubleOn](handValue(h.cards).total)) &&
              available >= actionCost(round, 'double'),
      split: canSplitByRules(round, h) && available >= actionCost(round, 'split'),
    };
  }

  /** For display: is a double / split allowed right now AND free? */
  function freeOffers(round) {
    if (round.phase !== 'player') return { double: false, split: false };
    const h = round.hands[round.active];
    const legal = legalActions(round);   // by the rules, ignoring bankroll
    return { double: !!legal.double && isFreeDouble(round, h), split: !!legal.split && isFreeSplit(round, h) };
  }

  /**
   * Apply one player action: 'insure' | 'decline' | 'hit' | 'stand' | 'double' | 'split'.
   * Throws on an illegal action. Returns the round (mutated in place).
   */
  function act(round, shoe, action, available, opts) {
    const legal = legalActions(round, available);
    if (!legal[action]) throw new Error(`Illegal action '${action}' in phase '${round.phase}'`);
    const ri = opts && opts.randInt;

    if (round.phase === 'insurance') {
      if (action === 'insure') {
        round.insurance = round.baseBet / 2;
        round.wagered += round.insurance;
      }
      return peek(round);
    }

    const h = round.hands[round.active];
    switch (action) {
      case 'hit':
        h.cards.push(drawCard(round, shoe, ri));
        if (handValue(h.cards).total >= 21) h.done = true;
        break;
      case 'stand':
        h.done = true;
        break;
      case 'double': {
        const base = actionOf(h);          // doubling doubles everything in action
        if (isFreeDouble(round, h)) { h.free += base; h.freeDoubled = true; }
        else { round.wagered += base; h.bet += base; }
        h.doubled = true;
        h.cards.push(drawCard(round, shoe, ri));
        h.done = true;
        break;
      }
      case 'split': {
        const base = actionOf(h);          // the new hand carries the same action
        const free = isFreeSplit(round, h);
        if (!free) round.wagered += base;
        const second = h.cards.pop();
        const aces = cardValue(second) === 1;
        h.fromSplit = true;
        h.splitAces = aces;
        round.hands.splice(round.active + 1, 0,
          newHand([second], free ? 0 : base, free ? base : 0, true, aces));
        break;   // advance() deals each split hand its second card when it becomes active
      }
    }
    return advance(round, shoe, ri);
  }

  /** Move to the next hand that needs a decision, or finish the round. */
  function advance(round, shoe, ri) {
    const r = round.rules;
    while (round.active < round.hands.length) {
      const h = round.hands[round.active];
      if (h.cards.length === 1) {
        h.cards.push(drawCard(round, shoe, ri));
        if (handValue(h.cards).total >= 21) h.done = true;
        else if (lockedSplitAce(h, r) && !canSplitByRules(round, h)) h.done = true;
      }
      if (!h.done) return round;
      round.active++;
    }
    return finish(round, shoe, ri);
  }

  /** Dealer draws to completion. Exposed so tests can check it in isolation. */
  function playDealer(cards, rules, draw) {
    while (dealerShouldHit(cards, rules)) cards.push(draw());
    return cards;
  }

  function finish(round, shoe, ri) {
    round.phase = 'dealer';
    // If every player hand busted there is nothing to play for; dealer doesn't draw.
    if (round.hands.some(h => !handValue(h.cards).bust)) {
      playDealer(round.dealer, round.rules, () => drawCard(round, shoe, ri));
    }
    return settle(round);
  }

  /** The ONLY place chips are paid. */
  function settle(round) {
    const [num, den] = round.rules.blackjackPays;
    const d = handValue(round.dealer);
    // Free Bet: a dealer who finishes on exactly 22 pushes every live hand.
    round.dealer22Push = round.rules.push22 && d.total === 22 && round.dealer.length > 2;
    let returned = 0;
    for (const h of round.hands) {
      const p = handValue(h.cards);
      const natural = isNatural(h.cards, h.fromSplit);
      // Win: own stake back + winnings on everything in action (own + free).
      // Push: own stake back; free chips go back to the house. Lose: nothing.
      const win = h.bet + actionOf(h);
      let outcome, ret;
      if (round.dealerBlackjack) {
        // Only reachable before any player action, so h is the original two-card hand.
        if (natural) { outcome = 'push'; ret = h.bet; }
        else         { outcome = 'lose'; ret = 0; }
      }
      else if (natural)          { outcome = 'blackjack'; ret = h.bet + (h.bet * num) / den; }
      else if (p.bust)           { outcome = 'bust';      ret = 0; }
      else if (round.dealer22Push) { outcome = 'push';    ret = h.bet; }
      else if (d.bust)           { outcome = 'win';       ret = win; }
      else if (p.total > d.total){ outcome = 'win';       ret = win; }
      else if (p.total === d.total){ outcome = 'push';    ret = h.bet; }
      else                       { outcome = 'lose';      ret = 0; }
      if (!Number.isInteger(ret)) throw new Error('Fractional payout: ' + ret);
      h.outcome = outcome;
      h.returned = ret;
      h.done = true;
      returned += ret;
    }
    round.insuranceReturned = round.dealerBlackjack ? round.insurance * 3 : 0;   // stake + 2:1
    returned += round.insuranceReturned;
    for (const k of Object.keys(round.side)) returned += round.side[k].returned;
    round.returned = returned;
    round.net = returned - round.wagered;
    round.phase = 'done';
    return round;
  }

  /* =========================================================================
     BASIC STRATEGY
     Multi-deck, no surrender, for this engine's rule options (S17/H17,
     DAS/no-DAS). Used by the test harness to measure house edge and by the
     game for the optional hint. Dealer up is 2..11 (11 = Ace).
     Codes: H hit, S stand, D double else hit, Ds double else stand.
     ========================================================================= */

  function hardPlay(t, up, r) {
    if (t <= 8) return 'H';
    if (t === 9)  return up >= 3 && up <= 6 ? 'D' : 'H';
    if (t === 10) return up <= 9 ? 'D' : 'H';
    if (t === 11) return up <= 10 || r.hitSoft17 ? 'D' : 'H';
    if (t === 12) return up >= 4 && up <= 6 ? 'S' : 'H';
    if (t <= 16)  return up <= 6 ? 'S' : 'H';
    return 'S';
  }

  function softPlay(t, up, r) {
    if (t <= 12) return 'H';                               // A,A that can't be split
    if (t <= 14) return up === 5 || up === 6 ? 'D' : 'H';  // A2, A3
    if (t <= 16) return up >= 4 && up <= 6 ? 'D' : 'H';    // A4, A5
    if (t === 17) return up >= 3 && up <= 6 ? 'D' : 'H';   // A6
    if (t === 18) {                                        // A7
      if (up >= (r.hitSoft17 ? 2 : 3) && up <= 6) return 'Ds';
      return up <= 8 ? 'S' : 'H';
    }
    if (t === 19) return r.hitSoft17 && up === 6 ? 'Ds' : 'S';  // A8
    return 'S';
  }

  function shouldSplit(v, up, r) {   // v = pair card value, 1 = Ace
    const das = r.doubleAfterSplit;
    switch (v) {
      case 1:  return true;
      case 10: return false;
      case 9:  return up !== 7 && up <= 9;
      case 8:  return true;
      case 7:  return up <= 7;
      case 6:  return up <= 6 && (das || up >= 3);
      case 5:  return false;
      case 4:  return das && (up === 5 || up === 6);
      default: return up <= 7 && (das || up >= 4);         // 2,2 and 3,3
    }
  }

  /* ---- Free Bet Blackjack (6 decks, H17, push 22) ---------------------------
     Wizard of Odds charts: https://wizardofodds.com/games/free-bet-blackjack/
     Two charts: a "real" hand has the player's own chips on it; a "free" hand
     is all free-bet chips, where a push is as bad as a loss. Surrender cells
     (R / RS) become hit / stand since this game has no surrender.
     -------------------------------------------------------------------------- */

  function freeBetHard(t, up, freeHand) {
    if (t <= 8)  return 'H';
    if (t <= 11) return 'D';                                     // free double
    if (t === 12) return up === 5 || up === 6 ? 'S' : 'H';
    if (t === 13) return up >= 3 && up <= 6 ? 'S' : 'H';
    if (t === 14) return up >= (freeHand ? 3 : 2) && up <= 6 ? 'S' : 'H';
    if (t <= 16) return up <= 6 ? 'S' : 'H';
    if (t === 17) return !freeHand || up <= 6 || up === 10 ? 'S' : 'H';
    return 'S';
  }

  function freeBetSoft(t, up, freeHand) {
    if (t <= 15) return 'H';
    if (t === 16) return up === 6 ? 'D' : 'H';
    if (t === 17) return up === 5 || up === 6 ? 'D' : 'H';
    if (t === 18) {
      if (freeHand) return up >= 4 && up <= 6 ? 'Ds' : up === 7 ? 'S' : 'H';
      return up === 5 || up === 6 ? 'Ds' : up <= 8 ? 'S' : 'H';
    }
    if (freeHand && t === 19) return up === 5 || up === 6 ? 'Ds' : 'S';
    if (freeHand && t === 20) return up === 6 ? 'Ds' : 'S';
    return 'S';
  }

  /** True when the rules are the Free Bet game the charts were computed for. */
  const isFreeBetGame = (r) => r.push22 && r.freeDoubles && r.freeSplits;

  /**
   * Recommended action for the round's current decision, always a legal one.
   * Exact charts for the standard game (S17 or H17) and for Free Bet. Other
   * mixes of the Free Bet keys fall back to the standard chart, which is legal
   * but not optimal. chart = 'standard' forces the standard chart (the test
   * harness uses it to show the Free Bet chart is worth having).
   */
  function basicStrategy(round, available, chart) {
    const legal = legalActions(round, available);
    if (round.phase === 'insurance') return 'decline';     // insurance is a losing bet without a count
    if (round.phase !== 'player') return null;
    const r = round.rules;
    const h = round.hands[round.active];
    const upV = cardValue(round.dealer[0]);
    const up = upV === 1 ? 11 : upV;
    const v = handValue(h.cards);
    let code;

    if (isFreeBetGame(r) && chart !== 'standard') {
      // Splits chart: free-split everything except 5s (free double instead) and tens (stand).
      const pv = cardValue(h.cards[0]);
      if (legal.split && pv !== 5 && pv !== 10) return 'split';
      const freeHand = h.bet === 0;
      code = v.soft ? freeBetSoft(v.total, up, freeHand) : freeBetHard(v.total, up, freeHand);
    } else {
      if (legal.split && shouldSplit(cardValue(h.cards[0]), up, r)) return 'split';
      code = v.soft ? softPlay(v.total, up, r) : hardPlay(v.total, up, r);
    }
    let a = code === 'H' ? 'hit' : code === 'S' ? 'stand'
          : legal.double ? 'double' : code === 'D' ? 'hit' : 'stand';
    if (!legal[a]) a = 'stand';    // e.g. locked split Aces
    return a;
  }

  const BJ = {
    ACE, cardValue, handValue, isNatural, dealerShouldHit,
    DEFAULT_RULES, makeRules,
    cryptoRandInt, newShoe, stackedShoe, needsShuffle,
    startRound, legalActions, freeOffers, act, playDealer, basicStrategy,
    SIDE_BETS, perfectPairsHand, twentyOnePlus3Hand, sideBetPays, sideBetCounts, sideBetReturn,
  };

  if (typeof module === 'object' && module.exports) module.exports = BJ;
  else root.BJ = BJ;
})(typeof globalThis !== 'undefined' ? globalThis : this);
