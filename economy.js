/*
 * Economy: ranks, wheels, quests, events, shop, bet ladder.
 *
 * ONE copy, shared by the page (<script src="economy.js">, exposes ECON) and
 * the Node tests (require('./economy.js')). Classic script so it loads from
 * file://, same as blackjack-core.js.
 *
 * THE RULE THIS FILE LIVES UNDER
 *   Nothing here can change how a game deals or settles. The economy only
 *   GRANTS chips (wheel, quests, event promos) or TAKES them for cosmetics,
 *   and every grant goes through the page's ledger. Game odds are identical
 *   for every player at every rank, balance and streak.
 *
 *   Economy grants may depend on rank or on being broke (that is what a
 *   rescue is). Their own odds (the wheels) are fixed, published, and the
 *   same for everyone.
 */
(function (root) {
  'use strict';

  /* =========================================================================
     RANKS
     XP comes from playing, nearly flat per round, so rank tracks how much you
     play, not how rich you are. A friend at 50 chips levels as fast as a
     friend at 50,000.
     ========================================================================= */

  /** XP needed to go from `level` to `level + 1`. */
  const xpToNext = (level) => 300 + 100 * (level - 1);   // Diamond (Lv 35) takes ~4,000+ rounds

  function levelFromXp(xp) {
    let level = 1, left = Math.max(0, Math.floor(xp)), need;
    while (left >= (need = xpToNext(level))) { left -= need; level++; }
    return { level, into: left, need };
  }

  /**
   * XP for one finished round: 10, plus up to 10 more for betting above the
   * table minimum (logarithmic, so a 1000x bet earns 2x the XP, not 1000x).
   */
  function xpForRound(wagered, minBet) {
    const units = Math.max(1, wagered / minBet);
    return 10 + Math.min(10, 2 * Math.floor(Math.log2(units)));
  }

  const QUEST_XP = 100;

  /**
   * Tiers. `mult` scales Bonus Wheel prizes, quest rewards and the vault's
   * interest cap; `maxBet` is the table limit per bet. Kept deliberately flat
   * (top tier is 2.5x, not 100x) so rank is a reward, not a money gap.
   */
  const TIERS = [
    { name: 'Bronze',   minLevel: 1,  mult: 1,    maxBet: 500 },
    { name: 'Silver',   minLevel: 5,  mult: 1.25, maxBet: 2500 },
    { name: 'Gold',     minLevel: 10, mult: 1.5,  maxBet: 10000 },
    { name: 'Platinum', minLevel: 20, mult: 2,    maxBet: 50000 },
    { name: 'Diamond',  minLevel: 35, mult: 2.5,  maxBet: 250000 },
  ];

  function tierIndex(level) {
    let t = 0;
    for (let i = 0; i < TIERS.length; i++) if (level >= TIERS[i].minLevel) t = i;
    return t;
  }

  /* =========================================================================
     BET LADDER
     Bets move along fixed "nice" amounts so a Diamond player isn't clicking
     +10 twenty-five thousand times.
     ========================================================================= */

  const BET_LADDER = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750,
    1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000,
    50000, 75000, 100000, 150000, 200000, 250000];

  /**
   * Next bet up (dir = 1) or down (dir = -1) the ladder.
   * opts: { min, max, multipleOf, allowZero }. Never returns above max.
   */
  function stepBet(current, dir, opts) {
    const { min, max, multipleOf = 1, allowZero = false } = opts;
    const steps = BET_LADDER.filter(v => v >= min && v <= max && v % multipleOf === 0);
    if (allowZero) steps.unshift(0);
    if (!steps.length) return allowZero ? 0 : min;
    if (dir > 0) {
      const up = steps.find(v => v > current);
      return up === undefined ? steps[steps.length - 1] : up;
    }
    const down = steps.filter(v => v < current);
    return down.length ? down[down.length - 1] : steps[0];
  }

  /* =========================================================================
     WHEELS
     Slice weights ARE the odds, and the page draws every slice at an angle
     proportional to its weight: the wheel you see is the true distribution.
     ========================================================================= */

  const WHEELS = {
    bonus: {
      name: 'Bonus Wheel',
      scaledByTier: true,          // prizes x tier mult
      cooldownMs: 6 * 3600 * 1000,
      slices: [                    // expected 80 chips per spin at x1
        { chips: 25,   weight: 60 },
        { chips: 50,   weight: 50 },
        { chips: 75,   weight: 40 },
        { chips: 100,  weight: 24 },
        { chips: 150,  weight: 14 },
        { chips: 250,  weight: 8 },
        { chips: 500,  weight: 3 },
        { chips: 1000, weight: 1 },
      ],
    },
    rescue: {
      name: 'Rescue Wheel',
      scaledByTier: false,         // same for everyone: a rescue, not a reward
      availableBelow: 10,          // spin whenever your chips are below this
      slices: [                    // expected 47.5; always enough for a few minimum bets
        { chips: 25,  weight: 50 },
        { chips: 50,  weight: 30 },
        { chips: 75,  weight: 12 },
        { chips: 100, weight: 6 },
        { chips: 250, weight: 2 },
      ],
    },
  };

  const wheelTotal = (w) => w.slices.reduce((s, x) => s + x.weight, 0);

  /** Pick a slice index. randInt(n) must be uniform on [0, n) (the page passes crypto). */
  function spinWheel(wheel, randInt) {
    let x = randInt(wheelTotal(wheel));
    for (let i = 0; i < wheel.slices.length; i++) {
      if (x < wheel.slices[i].weight) return i;
      x -= wheel.slices[i].weight;
    }
    throw new Error('unreachable: weights exhausted');
  }

  /** Chips a slice pays at a given prize multiplier (tier x event). */
  const slicePrize = (slice, mult) => Math.round(slice.chips * mult);

  /** Exact expected chips per spin. */
  function wheelEV(wheel, mult) {
    const t = wheelTotal(wheel);
    return wheel.slices.reduce((s, x) => s + slicePrize(x, mult) * x.weight / t, 0);
  }

  /* =========================================================================
     EVENTS
     A fixed weekly calendar computed from the local date, so every friend
     sees the same event at the same time with no server. Events never touch
     game settlement. "Promo" events pay a separate bonus, recorded as such.
     ========================================================================= */

  const EVENTS = [
    { id: 'questRush', name: 'Quest Rush', day: 1, fromHour: 0, toHour: 24,
      desc: 'Quest chip rewards are doubled all day.' },
    { id: 'doubleXp', name: 'Double XP Wednesday', day: 3, fromHour: 0, toHour: 24,
      desc: 'Every round and quest earns double XP.' },
    { id: 'bonanza', name: 'Blackjack Bonanza', day: 5, fromHour: 18, toHour: 24,
      desc: 'Natural blackjacks earn a promo bonus of 20% of the main bet (max 1,000), on top of the normal 3:2.',
      promo: { game: ['bj', 'fb'], on: 'natural', rate: 0.2, cap: 1000 } },
    { id: 'luckyWheel', name: 'Lucky Wheel Saturday', day: 6, fromHour: 0, toHour: 24,
      desc: 'The Bonus Wheel recharges twice as fast and pays double.' },
    { id: 'bigHand', name: 'Big Hand Sunday', day: 0, fromHour: 0, toHour: 24,
      desc: 'Pair Plus trips or straight flush earn a promo bonus of 3x the Pair Plus bet (max 2,500).',
      promo: { game: ['tcp'], on: 'pairPlusBig', rate: 3, cap: 2500 } },
  ];

  /** Events running at this moment (local time). */
  function activeEvents(date) {
    const d = date.getDay(), h = date.getHours();
    return EVENTS.filter(e => e.day === d && h >= e.fromHour && h < e.toHour);
  }
  const isActive = (date, id) => activeEvents(date).some(e => e.id === id);

  /** The next `n` event start times after `date`, soonest first. */
  function upcomingEvents(date, n) {
    const out = [];
    for (let add = 0; add <= 7 && out.length < n * 2; add++) {
      for (const e of EVENTS) {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() + add, e.fromHour);
        if (start.getDay() === e.day && start > date) out.push({ event: e, start });
      }
    }
    return out.sort((a, b) => a.start - b.start).slice(0, n);
  }

  /** Effective Bonus Wheel settings right now. */
  function bonusWheelNow(date, tier) {
    const lucky = isActive(date, 'luckyWheel');
    return {
      cooldownMs: lucky ? WHEELS.bonus.cooldownMs / 2 : WHEELS.bonus.cooldownMs,
      mult: TIERS[tier].mult * (lucky ? 2 : 1),
    };
  }

  /**
   * Promo bonus earned by a finished round under the events active at `date`.
   * Reads the round's facts only; it cannot affect the round.
   */
  function promoFor(facts, date) {
    let total = 0;
    const lines = [];
    for (const e of activeEvents(date)) {
      const p = e.promo;
      if (!p || !p.game.includes(facts.game)) continue;
      let amt = 0;
      if (p.on === 'natural' && facts.natural) amt = Math.floor(facts.mainBet * p.rate);
      if (p.on === 'pairPlusBig' && facts.pairPlusBig) amt = Math.floor(facts.pairPlusBet * p.rate);
      amt = Math.min(amt, p.cap);
      if (amt > 0) { total += amt; lines.push({ event: e, amount: amt }); }
    }
    return { total, lines };
  }

  /* =========================================================================
     QUESTS
     Three a day, chosen by the date and your tier, so friends at the same
     tier share quests. Targets and rewards scale with tier.
     ========================================================================= */

  // n[t] = target at tier t. count(facts) = progress this round adds.
  const QUESTS = [
    { id: 'bjWins',    n: [5, 8, 10, 12, 15], text: n => `Win ${n} blackjack hands`,
      count: f => (f.game === 'bj' || f.game === 'fb') ? f.handsWon : 0 },
    { id: 'naturals',  n: [1, 1, 2, 2, 3],    text: n => `Get ${n} natural blackjack${n > 1 ? 's' : ''}`,
      count: f => f.natural ? 1 : 0 },
    { id: 'doubleWins', n: [1, 2, 3, 4, 5],   text: n => `Win ${n} doubled hand${n > 1 ? 's' : ''}`,
      count: f => f.doublesWon || 0 },
    { id: 'splits',    n: [1, 2, 3, 3, 4],    text: n => `Split a pair ${n} time${n > 1 ? 's' : ''}`,
      count: f => f.splits || 0 },
    { id: 'freeWins',  n: [1, 2, 3, 4, 5],    text: n => `In Free Bet, win ${n} hand${n > 1 ? 's' : ''} riding on free chips`,
      count: f => f.game === 'fb' ? f.freeWins : 0 },
    { id: 'dealer22',  n: [1, 1, 1, 2, 2],    text: n => `In Free Bet, get pushed by a dealer 22 ${n > 1 ? n + ' times' : 'once'}`,
      count: f => f.dealer22 ? 1 : 0 },
    { id: 'sideWins',  n: [1, 1, 2, 2, 3],    text: n => `Win ${n} side bet${n > 1 ? 's' : ''} (Perfect Pairs or 21+3)`,
      count: f => f.sideWins || 0 },
    { id: 'tcpHands',  n: [10, 15, 20, 25, 30], text: n => `Play ${n} hands of Three Card Poker`,
      count: f => f.game === 'tcp' ? 1 : 0 },
    { id: 'ppWins',    n: [2, 3, 4, 5, 6],    text: n => `Win ${n} Pair Plus bets`,
      count: f => f.pairPlusWin ? 1 : 0 },
    { id: 'tcpBig',    n: [1, 1, 2, 2, 3],    text: n => `Get a straight or better in Three Card Poker${n > 1 ? ` ${n} times` : ''}`,
      count: f => f.tcpStraightPlus ? 1 : 0 },
    { id: 'anyRounds', n: [20, 30, 40, 50, 60], text: n => `Play ${n} rounds of anything`,
      count: () => 1 },
    { id: 'bjStreak',  n: [2, 3, 3, 4, 4],    text: n => `Win ${n} blackjack rounds in a row`,
      streak: true,   // progress = current run; a losing round resets it, a push leaves it
      count: f => (f.game === 'bj' || f.game === 'fb') ? Math.sign(f.mainNet) : null },
  ];
  const QUEST_BY_ID = Object.fromEntries(QUESTS.map(q => [q.id, q]));
  const QUEST_CHIPS = 100;   // x tier mult (x2 during Quest Rush)

  /** Local calendar day, 'YYYY-MM-DD'. */
  function dayKey(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  // Deterministic PRNG for quest selection (NOT for anything with stakes).
  function seedFrom(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The day's three quests for a tier. Same inputs, same quests, on every device. */
  function dailyQuests(day, tier) {
    const rand = mulberry32(seedFrom(day + '|' + tier));
    const pool = QUESTS.slice();
    const picked = [];
    while (picked.length < 3) {
      const q = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      picked.push({ id: q.id, target: q.n[tier], progress: 0, done: false });
    }
    return picked;
  }

  function questText(q) { return QUEST_BY_ID[q.id].text(q.target); }

  /** Advance one quest with one round's facts. Returns true if it just completed. */
  function advanceQuest(q, facts) {
    if (q.done) return false;
    const def = QUEST_BY_ID[q.id];
    const c = def.count(facts);
    if (def.streak) {
      if (c === null) return false;          // not a blackjack round: streak untouched
      if (c > 0) q.progress++;
      else if (c < 0) q.progress = 0;        // a loss breaks the streak; a push doesn't
    } else {
      q.progress += c;
    }
    if (q.progress >= q.target) { q.progress = q.target; q.done = true; return true; }
    return false;
  }

  function questReward(tier, date) {
    const rush = isActive(date, 'questRush');
    return { chips: Math.round(QUEST_CHIPS * TIERS[tier].mult * (rush ? 2 : 1)), xp: QUEST_XP };
  }

  /* =========================================================================
     VAULT: the reward for saving.
     Chips in the vault can't be bet. Each day they earn interest, but only on
     the LOWEST balance the vault held during that whole day, so depositing at
     11:59pm and withdrawing at 12:01am earns nothing. Interest is capped per
     day (x tier mult) so a big bankroll can't snowball into a runaway gap.
     ========================================================================= */

  const VAULT = { rate: 0.01, capBase: 50 };   // 1% a day, at most 50 x tier mult

  function vaultInterest(balance, tier) {
    return Math.max(0, Math.min(Math.floor(balance * VAULT.rate), Math.round(VAULT.capBase * TIERS[tier].mult)));
  }

  const dayNumber = (key) => { const [y, m, d] = key.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };

  /**
   * Pay interest for every full day that has ended since the vault was last
   * looked at. Mutates v ({ balance, day, minToday }). Returns interest paid.
   * The first finished day earns on its lowest balance; any days after that
   * (no activity) earn on the full, compounding balance.
   */
  function vaultAccrue(v, today, tier) {
    if (!v.day) { v.day = today; v.minToday = v.balance; return 0; }
    const days = Math.min(dayNumber(today) - dayNumber(v.day), 366);
    if (days <= 0) return 0;
    let paid = 0, base = v.minToday;
    for (let i = 0; i < days; i++) {
      const add = vaultInterest(base, tier);
      v.balance += add; paid += add;
      base = v.balance;
    }
    v.day = today; v.minToday = v.balance;
    return paid;
  }

  /** Move chips in (+) or out (-). Withdrawals lower today's interest base; deposits count from tomorrow. */
  function vaultMove(v, amount) {
    if (!Number.isInteger(amount) || amount === 0) throw new RangeError('Vault moves are whole, non-zero chip amounts');
    if (amount < 0 && -amount > v.balance) throw new RangeError('Not that many chips in the vault');
    v.balance += amount;
    if (amount < 0) v.minToday = Math.min(v.minToday, v.balance);
  }

  /* =========================================================================
     SHOP: cosmetics only. The chip sink. Flat prices; nothing affects play.
     ========================================================================= */

  const SHOP = [
    { id: 'felt-green',    kind: 'felt', name: 'Classic green', price: 0,      colors: ['#0f4034', '#0a2c24'] },
    { id: 'felt-blue',     kind: 'felt', name: 'Royal blue',    price: 5000,   colors: ['#173a6b', '#0c2142'] },
    { id: 'felt-crimson',  kind: 'felt', name: 'Crimson',       price: 15000,   colors: ['#6b1a24', '#3d0d14'] },
    { id: 'felt-midnight', kind: 'felt', name: 'Midnight',      price: 40000,  colors: ['#1d2233', '#0b0d16'] },
    { id: 'felt-velvet',   kind: 'felt', name: 'Velvet',        price: 100000,  colors: ['#4a1f5c', '#250d30'] },
    { id: 'felt-gilded',   kind: 'felt', name: 'Gilded',        price: 400000, colors: ['#5c4a12', '#2e2406'] },
    { id: 'back-blue',     kind: 'back', name: 'Blue',          price: 0,      colors: ['#2a4d8f', '#1e3a6e'] },
    { id: 'back-red',      kind: 'back', name: 'Red',           price: 3000,   colors: ['#a3303a', '#7a1f28'] },
    { id: 'back-black',    kind: 'back', name: 'Black',         price: 12000,   colors: ['#2b2b2b', '#121212'] },
    { id: 'back-emerald',  kind: 'back', name: 'Emerald',       price: 30000,  colors: ['#1f7a52', '#125238'] },
    { id: 'back-gold',     kind: 'back', name: 'Gold',          price: 200000,  colors: ['#c9a227', '#8a6d12'] },
    { id: 'title-none',    kind: 'title', name: '(no title)',   price: 0,      text: '' },
    { id: 'title-regular', kind: 'title', name: 'Regular',      price: 2500,   text: 'Regular' },
    { id: 'title-shark',   kind: 'title', name: 'Card Shark',   price: 60000,  text: 'Card Shark' },
    { id: 'title-roller',  kind: 'title', name: 'High Roller',  price: 250000, text: 'High Roller' },
    { id: 'title-whale',   kind: 'title', name: 'Whale',        price: 2500000, text: 'Whale' },
    { id: 'title-legend',  kind: 'title', name: 'Legend',       price: 10000000, text: 'Legend' },
  ];
  /* -------------------------------------------------------------------------
     ROTATING SHOP. Deterministic from the local date (like events and quests),
     so friends see the same shop. Three layers:
       - Deal of the Day: one regular item at 40% off, new at midnight.
       - Weekly Spotlight: three regular items at 25% off, new each Monday.
       - Rotating Collection: a themed set only on sale during its week. The
         collections cycle in a fixed order, so every one comes back every
         COLLECTIONS.length weeks: nothing is gone for good.
     Owned items stay owned. Sale prices are whole chips, multiples of 50.
     Cosmetics only, same prices for everyone: nothing here touches play.
     ------------------------------------------------------------------------- */
  const COLLECTIONS = [
    { id: 'neon', name: 'Neon Nights', items: [
      { id: 'felt-neon',  kind: 'felt',  name: 'Neon Strip',  price: 30000, colors: ['#0d4a5a', '#06161f'] },
      { id: 'back-neon',  kind: 'back',  name: 'Neon Grid',   price: 20000, colors: ['#d1349b', '#2f2fb8'] },
      { id: 'title-owl',  kind: 'title', name: 'Night Owl',   price: 25000, text: 'Night Owl' },
    ] },
    { id: 'lodge', name: 'Autumn Lodge', items: [
      { id: 'felt-oak',   kind: 'felt',  name: 'Oak Lodge',   price: 30000, colors: ['#6a4320', '#2f1d0c'] },
      { id: 'back-maple', kind: 'back',  name: 'Maple',       price: 20000, colors: ['#c2551f', '#7d2e0e'] },
      { id: 'title-fire', kind: 'title', name: 'Fireside',    price: 25000, text: 'Fireside' },
    ] },
    { id: 'ocean', name: 'Ocean Deep', items: [
      { id: 'felt-reef',  kind: 'felt',  name: 'Reef',        price: 30000, colors: ['#0e5a6b', '#06272f'] },
      { id: 'back-wave',  kind: 'back',  name: 'Wave',        price: 20000, colors: ['#2a8fbf', '#14506e'] },
      { id: 'title-diver', kind: 'title', name: 'Deep Diver', price: 25000, text: 'Deep Diver' },
    ] },
    { id: 'court', name: 'Royal Court', items: [
      { id: 'felt-ermine', kind: 'felt', name: 'Ermine',      price: 30000, colors: ['#3b2d5c', '#16102a'] },
      { id: 'back-crown', kind: 'back',  name: 'Crown',       price: 20000, colors: ['#b8912a', '#4a1f5c'] },
      { id: 'title-royal', kind: 'title', name: 'Royalty',    price: 25000, text: 'Royalty' },
    ] },
  ];
  for (const c of COLLECTIONS) for (const it of c.items) { it.collection = c.id; SHOP.push(it); }
  const SHOP_BY_ID = Object.fromEntries(SHOP.map(s => [s.id, s]));
  const DEAL_OFF = 0.40, SPOTLIGHT_OFF = 0.25;

  /** Monday 00:00 (local) of the week containing `date`. */
  function weekStart(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }
  /** Whole weeks since a fixed Monday, counted by calendar date (DST-proof). */
  function weekIndex(date) {
    const m = weekStart(date);
    return Math.round((Date.UTC(m.getFullYear(), m.getMonth(), m.getDate()) - Date.UTC(2024, 0, 1)) / (7 * 86400000));
  }
  const salePrice = (price, off) => Math.max(50, Math.round(price * (1 - off) / 50) * 50);

  /** Everything on sale at `date`: same answer on every device for the same local date. */
  function shopCycle(date) {
    const wk = weekIndex(date);
    const cIdx = ((wk % COLLECTIONS.length) + COLLECTIONS.length) % COLLECTIONS.length;
    const regular = SHOP.filter(s => !s.collection && s.price > 0);
    const wr = mulberry32(seedFrom('spotlight|' + wk));
    const pool = regular.slice(), spotlight = [];
    while (spotlight.length < 3 && pool.length) spotlight.push(pool.splice(Math.floor(wr() * pool.length), 1)[0].id);
    const dr = mulberry32(seedFrom('deal|' + dayKey(date)));
    const dealPool = regular.filter(s => !spotlight.includes(s.id));
    const deal = dealPool[Math.floor(dr() * dealPool.length)].id;
    const start = weekStart(date);
    const ends = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const tomorrow = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    return {
      deal, dealOff: DEAL_OFF, dealEnds: tomorrow,
      spotlight, spotlightOff: SPOTLIGHT_OFF, weekEnds: ends,
      collection: COLLECTIONS[cIdx], collectionEnds: ends,
      next: COLLECTIONS[(cIdx + 1) % COLLECTIONS.length],
    };
  }

  /**
   * What `id` costs at `date`: { price, base, off, why } or null if it can't
   * be bought right now (a collection item outside its week).
   */
  function shopPrice(id, date) {
    const it = SHOP_BY_ID[id];
    if (!it) return null;
    const c = shopCycle(date);
    if (it.collection && it.collection !== c.collection.id) return null;
    if (id === c.deal) return { price: salePrice(it.price, c.dealOff), base: it.price, off: c.dealOff, why: 'deal' };
    if (c.spotlight.includes(id)) return { price: salePrice(it.price, c.spotlightOff), base: it.price, off: c.spotlightOff, why: 'spotlight' };
    return { price: it.price, base: it.price, off: 0, why: it.collection ? 'collection' : '' };
  }

  const ECON = {
    xpToNext, levelFromXp, xpForRound, QUEST_XP, TIERS, tierIndex,
    BET_LADDER, stepBet,
    WHEELS, wheelTotal, spinWheel, slicePrize, wheelEV, bonusWheelNow,
    EVENTS, activeEvents, isActive, upcomingEvents, promoFor,
    QUESTS, QUEST_CHIPS, dayKey, dailyQuests, questText, advanceQuest, questReward,
    VAULT, vaultInterest, vaultAccrue, vaultMove,
    SHOP, SHOP_BY_ID, COLLECTIONS, shopCycle, shopPrice, weekIndex,
  };

  if (typeof module === 'object' && module.exports) module.exports = ECON;
  else root.ECON = ECON;
})(typeof globalThis !== 'undefined' ? globalThis : this);
