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
     CASINO CLOCK
     Every calendar rule (events, the quest day, the shop week, the vault day)
     runs on ONE fixed timezone, not the device's. So everyone, everywhere,
     sees the same Double XP day, and changing your computer's clock or
     timezone can't move you into an event. The server (UTC) and every
     browser compute the same answers.

       wall(date)              that instant's date/time on the casino clock
       atWall(y, mo, d, h, mi) the instant when the casino clock reads that
                               (mo 0-based; out-of-range days roll over, like Date)

     Elapsed-time rules (wheel cooldowns) use real instants and don't care.
     ========================================================================= */

  const CLOCK_ZONE = 'America/New_York';
  const CLOCK_NAME = 'US Eastern time';
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let wallFmt = null;

  function wall(date) {
    if (!wallFmt) {
      wallFmt = new Intl.DateTimeFormat('en-US', { timeZone: CLOCK_ZONE, hourCycle: 'h23', weekday: 'short',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    }
    const p = {};
    for (const x of wallFmt.formatToParts(date)) p[x.type] = x.value;
    return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, dow: DOW[p.weekday] };
  }

  function atWall(y, mo, d, h = 0, mi = 0) {
    const target = Date.UTC(y, mo, d, h, mi);
    let t = target;
    for (let i = 0; i < 3; i++) {   // converges in one step except across a DST change
      const w = wall(new Date(t));
      const seen = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
      if (seen === target) break;
      t += target - seen;
    }
    return new Date(t);
  }

  /** Midnight starting the next casino-clock day. */
  function nextDayStart(date) {
    const w = wall(date);
    return atWall(w.y, w.mo, w.d + 1);
  }

  /* =========================================================================
     EVENTS
     A fixed weekly calendar on the casino clock, so every friend sees the
     same event at the same time. Events never touch game settlement.
     "Promo" events pay a separate bonus, recorded as such.
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

  /** Events running at this moment (casino clock). */
  function activeEvents(date) {
    const w = wall(date);
    return EVENTS.filter(e => e.day === w.dow && w.h >= e.fromHour && w.h < e.toHour);
  }
  const isActive = (date, id) => activeEvents(date).some(e => e.id === id);

  /** The next `n` event start times (real instants) after `date`, soonest first. */
  function upcomingEvents(date, n) {
    const out = [];
    const w = wall(date);
    for (let add = 0; add <= 7 && out.length < n * 2; add++) {
      const cal = new Date(Date.UTC(w.y, w.mo, w.d + add));   // a calendar date, read with UTC getters
      for (const e of EVENTS) {
        if (cal.getUTCDay() !== e.day) continue;
        const start = atWall(cal.getUTCFullYear(), cal.getUTCMonth(), cal.getUTCDate(), e.fromHour);
        if (start > date) out.push({ event: e, start });
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
  /**
   * The daily CHALLENGE: one extra quest a day, much harder, paying
   * CHALLENGE_MULT x a normal quest. Same deal as the others: chosen by the
   * date and your tier, a grant after the result, never anything that
   * decides a game.
   */
  const CHALLENGES = [
    { id: 'xBjWins',   n: [20, 25, 30, 35, 40],      text: n => `Win ${n} blackjack hands`,
      count: f => (f.game === 'bj' || f.game === 'fb') ? f.handsWon : 0 },
    { id: 'xNaturals', n: [3, 4, 4, 5, 6],           text: n => `Get ${n} natural blackjacks`,
      count: f => f.natural ? 1 : 0 },
    { id: 'xStreak',   n: [5, 5, 6, 6, 7],           text: n => `Win ${n} blackjack rounds in a row`,
      streak: true, count: f => (f.game === 'bj' || f.game === 'fb') ? Math.sign(f.mainNet) : null },
    { id: 'xDoubles',  n: [4, 5, 6, 7, 8],           text: n => `Win ${n} doubled hands`,
      count: f => f.doublesWon || 0 },
    { id: 'xRounds',   n: [100, 125, 150, 175, 200], text: n => `Play ${n} rounds of anything`,
      count: () => 1 },
    { id: 'xTcpBig',   n: [3, 4, 5, 5, 6],           text: n => `Get a straight or better in Three Card Poker ${n} times`,
      count: f => f.tcpStraightPlus ? 1 : 0 },
    { id: 'xFeature',  n: [1, 1, 2, 2, 3],           text: n => `Trigger free spins on a slot machine${n > 1 ? ` ${n} times` : ''}`,
      count: f => f.slotFeature ? 1 : 0 },
    { id: 'xRoulette', n: [15, 20, 25, 30, 35],      text: n => `Win ${n} roulette spins`,
      count: f => f.rouletteWin ? 1 : 0 },
  ].map(q => Object.assign(q, { hard: true }));
  const CHALLENGE_MULT = 5;      // chips: 5 x a normal quest
  const CHALLENGE_XP_MULT = 3;   // XP: 3 x a normal quest
  const QUEST_BY_ID = Object.fromEntries(QUESTS.concat(CHALLENGES).map(q => [q.id, q]));
  const QUEST_CHIPS = 100;   // x tier mult (x2 during Quest Rush)

  /** Casino-clock calendar day, 'YYYY-MM-DD'. */
  function dayKey(date) {
    const p = (n) => String(n).padStart(2, '0');
    const w = wall(date);
    return `${w.y}-${p(w.mo + 1)}-${p(w.d)}`;
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

  /** The day's three quests plus the challenge, for a tier. Same inputs, same quests, on every device. */
  function dailyQuests(day, tier) {
    const rand = mulberry32(seedFrom(day + '|' + tier));
    const pool = QUESTS.slice();
    const picked = [];
    while (picked.length < 3) {
      const q = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      picked.push({ id: q.id, target: q.n[tier], progress: 0, done: false });
    }
    return picked.concat(dailyChallenge(day, tier));
  }

  /** The day's challenge quest. Its own seed, so adding it didn't change the other three. */
  function dailyChallenge(day, tier) {
    const rand = mulberry32(seedFrom('challenge|' + day + '|' + tier));
    const q = CHALLENGES[Math.floor(rand() * CHALLENGES.length)];
    return { id: q.id, target: q.n[tier], progress: 0, done: false, hard: true };
  }
  const isHard = (q) => !!(q && QUEST_BY_ID[q.id] && QUEST_BY_ID[q.id].hard);

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

  /** A quest's reward at a tier on a date. Pass the quest to price a challenge. */
  function questReward(tier, date, q) {
    const rush = isActive(date, 'questRush');
    const hard = isHard(q);
    return { chips: Math.round(QUEST_CHIPS * TIERS[tier].mult * (rush ? 2 : 1) * (hard ? CHALLENGE_MULT : 1)),
             xp: QUEST_XP * (hard ? CHALLENGE_XP_MULT : 1) };
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
    // Avatar frames: the ring around your avatar that other players see on
    // the leaderboard and your player card. style: solid | glow | spin.
    { id: 'frame-none',    kind: 'frame', name: 'No frame',     price: 0,       colors: ['#3a464c', '#2a373c'], style: 'solid' },
    { id: 'frame-silver',  kind: 'frame', name: 'Silver',       price: 8000,    colors: ['#e9edf2', '#8d95a0'], style: 'solid' },
    { id: 'frame-gold',    kind: 'frame', name: 'Gold',         price: 50000,   colors: ['#ffe08a', '#b8861a'], style: 'solid' },
    { id: 'frame-ruby',    kind: 'frame', name: 'Ruby',         price: 150000,  colors: ['#ff5a6e', '#8a0a1e'], style: 'glow' },
    { id: 'frame-aurora',  kind: 'frame', name: 'Aurora',       price: 600000,  colors: ['#3bffb0', '#7a3bff'], style: 'spin' },
    { id: 'frame-diamond', kind: 'frame', name: 'Diamond',      price: 3000000, colors: ['#ffffff', '#7fd8ff'], style: 'spin' },
  ];
  /* -------------------------------------------------------------------------
     ROTATING SHOP. Deterministic from the casino-clock date (like events and quests),
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
      { id: 'frame-neon', kind: 'frame', name: 'Neon Ring',   price: 40000, colors: ['#ff3bd1', '#3bd2ff'], style: 'glow' },
    ] },
    { id: 'lodge', name: 'Autumn Lodge', items: [
      { id: 'felt-oak',   kind: 'felt',  name: 'Oak Lodge',   price: 30000, colors: ['#6a4320', '#2f1d0c'] },
      { id: 'back-maple', kind: 'back',  name: 'Maple',       price: 20000, colors: ['#c2551f', '#7d2e0e'] },
      { id: 'title-fire', kind: 'title', name: 'Fireside',    price: 25000, text: 'Fireside' },
      { id: 'frame-ember', kind: 'frame', name: 'Ember',      price: 40000, colors: ['#ffb347', '#a8320c'], style: 'glow' },
    ] },
    { id: 'ocean', name: 'Ocean Deep', items: [
      { id: 'felt-reef',  kind: 'felt',  name: 'Reef',        price: 30000, colors: ['#0e5a6b', '#06272f'] },
      { id: 'back-wave',  kind: 'back',  name: 'Wave',        price: 20000, colors: ['#2a8fbf', '#14506e'] },
      { id: 'title-diver', kind: 'title', name: 'Deep Diver', price: 25000, text: 'Deep Diver' },
      { id: 'frame-coral', kind: 'frame', name: 'Coral',      price: 40000, colors: ['#ff8a7a', '#1aa3b8'], style: 'solid' },
    ] },
    { id: 'court', name: 'Royal Court', items: [
      { id: 'felt-ermine', kind: 'felt', name: 'Ermine',      price: 30000, colors: ['#3b2d5c', '#16102a'] },
      { id: 'back-crown', kind: 'back',  name: 'Crown',       price: 20000, colors: ['#b8912a', '#4a1f5c'] },
      { id: 'title-royal', kind: 'title', name: 'Royalty',    price: 25000, text: 'Royalty' },
      { id: 'frame-crown', kind: 'frame', name: 'Crown',      price: 40000, colors: ['#ffd23b', '#6a1fb0'], style: 'spin' },
    ] },
  ];
  for (const c of COLLECTIONS) for (const it of c.items) { it.collection = c.id; SHOP.push(it); }
  const SHOP_BY_ID = Object.fromEntries(SHOP.map(s => [s.id, s]));
  const DEAL_OFF = 0.40, SPOTLIGHT_OFF = 0.25;

  /** Casino-clock calendar date of the Monday starting `date`'s week, as [y, mo, d]. */
  function weekMonday(date) {
    const w = wall(date);
    return [w.y, w.mo, w.d - ((w.dow + 6) % 7)];
  }
  /** Midnight starting this casino-clock week (Monday 00:00 ET). The leaderboard's week. */
  function weekStart(date) {
    const [y, mo, d] = weekMonday(date);
    return atWall(y, mo, d);
  }
  /** Whole weeks since a fixed Monday, counted by calendar date (DST-proof). */
  function weekIndex(date) {
    const [y, mo, d] = weekMonday(date);
    return Math.round((Date.UTC(y, mo, d) - Date.UTC(2024, 0, 1)) / (7 * 86400000));
  }
  /* =========================================================================
     TOURNAMENTS (online only; the server runs them, the page shows them)
     One a week on the casino clock. Everyone gets the same tournament stack
     (NOT real chips: it never touches the wallet or the ledger), the same
     bet limit, and the same number of rounds, at any game. Play all of
     them to place; the biggest stack wins. Prizes are real chips, paid as
     a 'tournament' ledger grant once the week is over. Same games, same
     odds, same rules as everywhere else: nothing about a tournament changes
     how a game deals or pays.
     ========================================================================= */

  const TOURNEY = {
    stack: 10000,              // tournament chips each entry starts with
    rounds: 100,               // rounds per entry (free spins don't count); play them all to place
    maxBet: 1000,              // per bet (per spin at the slots), the same for everyone
    graceMs: 15 * 60000,       // after the week ends, a round still open may finish; prizes wait for it
    prizes: [3000, 1500, 1000],   // 1st, 2nd, 3rd (each also earns a trophy)
    placePrize: 400,           // 4th to placesPaid
    placesPaid: 10,
    finisherPrize: 200,        // everyone else who played all their rounds
  };

  /** A date's tournament week: its Monday on the casino clock, 'YYYYMMDD'. */
  function tourneyWeek(date) { return dayKey(weekStart(date)).replace(/-/g, ''); }
  /** The table the server keeps a player's entry in. */
  const tourneyTable = (week) => 'tn_' + week;
  /** When a week's tournament starts, ends, and closes (end + grace). */
  function tourneyBounds(week) {
    const start = atWall(+week.slice(0, 4), +week.slice(4, 6) - 1, +week.slice(6, 8));
    const end = weekStart(new Date(start.getTime() + 8 * 86400000));
    return { start, end, closes: new Date(end.getTime() + TOURNEY.graceMs) };
  }
  /**
   * Final order: entries that played every round, biggest stack first
   * (ties share a place: 1, 1, 3), then everyone still short of the rounds,
   * unplaced. Entries are { chips, rounds, ... }; returns copies with place.
   */
  function tourneyStandings(entries) {
    const fin = entries.filter(e => e.rounds >= TOURNEY.rounds).sort((a, b) => b.chips - a.chips);
    const rest = entries.filter(e => e.rounds < TOURNEY.rounds).sort((a, b) => b.chips - a.chips || b.rounds - a.rounds);
    const out = [];
    fin.forEach((e, i) => out.push(Object.assign({}, e, { place: i > 0 && e.chips === fin[i - 1].chips ? out[i - 1].place : i + 1 })));
    for (const e of rest) out.push(Object.assign({}, e, { place: null }));
    return out;
  }
  /** Real chips a place wins (null = didn't play every round: nothing). */
  function tourneyPrize(place) {
    if (!place) return 0;
    if (place <= TOURNEY.prizes.length) return TOURNEY.prizes[place - 1];
    return place <= TOURNEY.placesPaid ? TOURNEY.placePrize : TOURNEY.finisherPrize;
  }

  const salePrice = (price, off) => Math.max(50, Math.round(price * (1 - off) / 50) * 50);

  /** Everything on sale at `date`: same answer on every device at the same moment. */
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
    const [y, mo, d] = weekMonday(date);
    const ends = atWall(y, mo, d + 7);
    const tomorrow = nextDayStart(date);
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

  /* =========================================================================
     ACCOUNT ACTIONS
     Every change the economy makes to a player, as plain functions on an
     account object. The page (offline, S.chips / S.econ) and the server
     (online, the wallet) run these SAME functions, so online and offline
     can't drift apart:

       a = { chips, econ, rows }
         chips  chips on hand
         econ   saved economy state (blankEcon() shape)
         rows   optional: if an array, every balance change is also pushed as
                a ledger row { account, amount, kind } (the server's ledger
                table). The page leaves it out; it keeps econ.ledger totals.

     Each action returns or pushes events (plain objects) describing what
     happened, for the caller to announce in its own way. Nothing here can see
     or change how a game deals or settles: afterRound() receives finished
     results only. `t` is the current instant; `randInt` the RNG (crypto in
     play; seeded only in tests).
     ========================================================================= */

  /** Economy state for a new player. */
  function blankEcon(opening) {
    return {
      xp: 0,
      lastBonusSpin: 0,
      quests: { day: '', tier: -1, list: [] },
      owned: ['felt-green', 'back-blue', 'title-none', 'frame-none'],
      equipped: { felt: 'felt-green', back: 'back-blue', title: 'title-none', frame: 'frame-none' },
      ledger: { opening, bonusWheel: 0, rescueWheel: 0, quests: 0, promo: 0, interest: 0, shop: 0, admin: 0, tournament: 0 },
      vault: { balance: 0, day: '', minToday: 0 },   // saved chips: can't be bet, earn capped daily interest
      spins: [],    // recent wheel results, newest last (capped)
      trophies: [], // tournament finishes that won a trophy: { week, place, of }
    };
  }

  /** Fill in anything an older saved econ is missing (never overwrites). */
  function normalizeEcon(econ, opening) {
    const b = blankEcon(opening);
    const e = econ || {};
    for (const k of Object.keys(b)) if (e[k] === undefined) e[k] = b[k];
    for (const k of Object.keys(b.ledger)) if (e.ledger[k] === undefined) e.ledger[k] = b.ledger[k];
    // New cosmetic kinds (e.g. frames) for accounts made before they existed.
    for (const k of Object.keys(b.equipped)) if (!e.equipped[k]) e.equipped[k] = b.equipped[k];
    for (const id of Object.values(b.equipped)) if (!e.owned.includes(id)) e.owned.push(id);
    return e;
  }

  const levelOf = (a) => levelFromXp(a.econ.xp);
  const tierOf = (a) => tierIndex(levelOf(a).level);

  /** The ONLY way chips enter or leave outside a game. Recorded in the ledger. */
  function grant(a, kind, amount) {
    if (!Number.isInteger(amount)) throw new Error('Ledger amounts must be whole chips: ' + amount);
    if (kind === 'opening' || !(kind in a.econ.ledger)) throw new Error('Unknown ledger entry: ' + kind);
    if (amount === 0) return;
    a.chips += amount;
    a.econ.ledger[kind] += amount;
    if (a.rows) a.rows.push({ account: 'chips', amount, kind });
  }

  /** Add XP (doubled during Double XP). Pushes a level event; returns the new level if it went up, else 0. */
  function addXp(a, base, t, ev) {
    const before = levelOf(a).level, tierBefore = tierOf(a);
    a.econ.xp += base * (isActive(t, 'doubleXp') ? 2 : 1);
    const after = levelOf(a).level;
    if (after <= before) return 0;
    if (ev) ev.push({ type: 'level', level: after, tierBefore, tierAfter: tierOf(a) });
    return after;
  }

  /** Today's quests. Ranking up mid-day keeps today's set; the new tier applies tomorrow. */
  function ensureQuests(a, t, ev) {
    const day = dayKey(t);
    if (a.econ.quests.day === day) {
      // Today's list was dealt before the daily challenge existed: add today's.
      const qs = a.econ.quests;
      if (qs.tier >= 0 && !qs.list.some(isHard)) qs.list.push(dailyChallenge(day, qs.tier));
      return;
    }
    // Yesterday's finished-but-unclaimed quests are paid, not lost.
    const old = a.econ.quests;
    let owed = 0, xp = 0;
    for (const q of old.list || []) {
      if (!q.done || q.claimed) continue;
      const rw = q.reward || questReward(old.tier, t, q);
      q.claimed = true; owed += rw.chips; xp += rw.xp;
    }
    if (owed) {
      grant(a, 'quests', owed);
      addXp(a, xp, t, null);
      if (ev) ev.push({ type: 'questsPaid', chips: owed, xp });
    }
    const tier = tierOf(a);
    a.econ.quests = { day, tier, list: dailyQuests(day, tier) };
  }

  /** Pay any vault interest due (credited into the vault). Returns chips paid. */
  function accrueVault(a, t, ev) {
    const paid = vaultAccrue(a.econ.vault, dayKey(t), tierOf(a));
    if (paid) {
      a.econ.ledger.interest += paid;
      if (a.rows) a.rows.push({ account: 'vault', amount: paid, kind: 'interest' });
      if (ev) ev.push({ type: 'interest', chips: paid });
    }
    return paid;
  }

  /**
   * After every finished round of any game, with facts about the result:
   * event promos, XP, quest progress. Returns events:
   *   promo {event, amount} | questDone {i, day, q} | level | questsPaid | interest
   */
  function afterRound(a, facts, t) {
    const ev = [];
    ensureQuests(a, t, ev);
    accrueVault(a, t, ev);
    for (const p of promoFor(facts, t).lines) {
      grant(a, 'promo', p.amount);
      ev.push({ type: 'promo', event: p.event, amount: p.amount });
    }
    const lvl = [];
    addXp(a, xpForRound(facts.wagered, facts.minBet), t, lvl);
    const qs = a.econ.quests;
    qs.list.forEach((q, i) => {
      if (advanceQuest(q, facts)) {
        // The reward is fixed the moment the quest completes (so a Quest Rush
        // completion stays doubled), but paid only when claimed.
        q.reward = questReward(qs.tier, t, q);
        q.claimed = false;
        ev.push({ type: 'questDone', i, day: qs.day, q });
      }
    });
    return ev.concat(lvl);
  }

  /**
   * Pay one finished quest's reward, exactly once. `day` guards against a
   * stale button from yesterday's list. Returns { reward, ev } or null.
   */
  function claimQuest(a, i, day, t) {
    const ev = [];
    ensureQuests(a, t, ev);
    const qs = a.econ.quests;
    if (day && day !== qs.day) return null;
    const q = qs.list[i];
    if (!q || !q.done || q.claimed) return null;
    const rw = q.reward || questReward(qs.tier, t, q);
    q.claimed = true;
    grant(a, 'quests', rw.chips);
    addXp(a, rw.xp, t, ev);
    return { reward: rw, ev };
  }

  /** When the Bonus Wheel is next free (ms). Lucky Wheel Saturday halves the wait. */
  const bonusReadyAt = (a, t) => a.econ.lastBonusSpin + bonusWheelNow(t, tierOf(a)).cooldownMs;

  /** Broke means broke: vault chips count, and so do chips in play at any table. */
  const rescueReady = (a, inPlay) => a.chips + a.econ.vault.balance < WHEELS.rescue.availableBelow && inPlay === 0;

  /** Spin a wheel if it's available. Returns { idx, chips, mult } or null. */
  function spin(a, which, t, randInt, inPlay) {
    let mult = 1;
    if (which === 'rescue') {
      if (!rescueReady(a, inPlay)) return null;
    } else if (which === 'bonus') {
      if (t.getTime() < bonusReadyAt(a, t)) return null;
      mult = bonusWheelNow(t, tierOf(a)).mult;
      a.econ.lastBonusSpin = t.getTime();
    } else return null;
    const wheel = WHEELS[which];
    const idx = spinWheel(wheel, randInt);
    const chips = slicePrize(wheel.slices[idx], mult);
    grant(a, which === 'rescue' ? 'rescueWheel' : 'bonusWheel', chips);
    a.econ.spins.push({ t: t.getTime(), wheel: which, slice: idx, mult, chips });
    if (a.econ.spins.length > 200) a.econ.spins.splice(0, a.econ.spins.length - 200);
    return { idx, chips, mult };
  }

  /** Deposit (+) or withdraw (-). A transfer, not a grant: chips + vault is unchanged. */
  function moveVault(a, amount, t, ev) {
    accrueVault(a, t, ev);
    if (!Number.isInteger(amount) || amount === 0) return false;
    if (amount > 0 && amount > a.chips) return false;
    if (amount < 0 && -amount > a.econ.vault.balance) return false;
    vaultMove(a.econ.vault, amount);
    a.chips -= amount;
    if (a.rows) {
      a.rows.push({ account: 'chips', amount: -amount, kind: 'vault' });
      a.rows.push({ account: 'vault', amount, kind: 'vault' });
    }
    return true;
  }

  /** Buy a cosmetic at today's price, and equip it. False if it can't be bought now. */
  function buy(a, id, t) {
    const it = SHOP_BY_ID[id];
    const p = shopPrice(id, t);   // today's price, or null if not in rotation
    if (!it || !p || a.econ.owned.includes(id) || a.chips < p.price) return false;
    grant(a, 'shop', -p.price);
    a.econ.owned.push(id);
    equip(a, id);
    return true;
  }

  function equip(a, id) {
    const it = SHOP_BY_ID[id];
    if (!it || !a.econ.owned.includes(id)) return false;
    a.econ.equipped[it.kind] = id;
    return true;
  }

  /** Economy facts about a finished blackjack round (the page and the server both build them here). */
  function bjFacts(r, game, minBet) {
    const sideNet = Object.values(r.side || {}).reduce((s, sb) => s + sb.returned - sb.bet, 0);
    return {
      game, wagered: r.wagered, minBet,
      mainBet: r.baseBet, mainNet: r.net - sideNet,
      natural: r.hands.length === 1 && r.hands[0].outcome === 'blackjack',
      handsWon: r.hands.filter(h => h.outcome === 'win' || h.outcome === 'blackjack').length,
      doublesWon: r.hands.filter(h => h.doubled && h.outcome === 'win').length,
      splits: r.hands.length - 1,
      freeWins: r.hands.filter(h => h.free > 0 && h.outcome === 'win').length,
      dealer22: !!r.dealer22Push,
      sideWins: Object.values(r.side || {}).filter(sb => sb.returned > 0).length,
    };
  }

  const ECON = {
    xpToNext, levelFromXp, xpForRound, QUEST_XP, TIERS, tierIndex,
    BET_LADDER, stepBet,
    WHEELS, wheelTotal, spinWheel, slicePrize, wheelEV, bonusWheelNow,
    CLOCK_ZONE, CLOCK_NAME, wall, atWall, nextDayStart,
    EVENTS, activeEvents, isActive, upcomingEvents, promoFor,
    QUESTS, QUEST_CHIPS, dayKey, dailyQuests, questText, advanceQuest, questReward,
    CHALLENGES, CHALLENGE_MULT, CHALLENGE_XP_MULT, dailyChallenge, isHard,
    TOURNEY, tourneyWeek, tourneyTable, tourneyBounds, tourneyStandings, tourneyPrize,
    VAULT, vaultInterest, vaultAccrue, vaultMove,
    SHOP, SHOP_BY_ID, COLLECTIONS, shopCycle, shopPrice, weekIndex, weekStart,
    blankEcon, normalizeEcon, levelOf, tierOf, grant, addXp, ensureQuests, accrueVault, afterRound,
    claimQuest, bonusReadyAt, rescueReady, spin, moveVault, buy, equip, bjFacts,
  };

  if (typeof module === 'object' && module.exports) module.exports = ECON;
  else root.ECON = ECON;
})(typeof globalThis !== 'undefined' ? globalThis : this);
