/*
 * Slot machines: the ONE copy of every machine's math.
 *
 * Reel strips, paytables, paylines, the spin (which stop each reel lands on)
 * and the pay evaluation. Loaded by index.html (<script src>), by
 * enumerate-slots.js (which walks EVERY combination of reel stops through
 * the same evaluator and computes the exact PAR sheet), by test-slots.js,
 * and by the online server (supabase/functions/_shared/, via sync-shared.js).
 * Never copy any of this into the page: a copy that drifts means the
 * enumerator is verifying a different machine than the one being played.
 *
 * How a spin works, as on a real machine: the RNG picks one stop per reel,
 * independently and uniformly over that reel's (virtual) stops. Nothing
 * else: no near-miss logic, no "due" wins, no dependence on the player, the
 * bet history or the session. The window shows the stop and its neighbours.
 *
 * Machine kinds:
 *   classic  3 reels, 1 centre payline, physical stops with WEIGHTS (the
 *            "virtual reel": each physical stop owns `weight` virtual stops,
 *            how real stepper slots set their odds), blanks between symbols,
 *            a wild that multiplies.
 *   lines    5x3 video slot, fixed paylines, left-to-right line pays, wild,
 *            scatter pays (x total bet) and a free-spins feature.
 *   ways     5x3 video slot, 243 ways: a symbol on adjacent reels from the
 *            left pays (pay x number of ways), wild, scatter, free spins.
 *
 * Every pay is a whole number of chips: line pays are multiples of the line
 * bet, ways and scatter pays multiples of the bet unit / total bet, and
 * feature multipliers are integers. A machine whose rules could owe a
 * fractional chip is rejected at load (checkMachine).
 *
 * Changing any strip, paytable or feature: run `node enumerate-slots.js`,
 * update the machine's `par` figures from its output, run `node test-slots.js`.
 *
 * Classic script (not an ES module) so index.html still opens from file://.
 */
(function (root) {
  'use strict';

  /* =================================================== machines ===== */

  // Shorthand for building strips from symbol ids.
  const strip = (ids, syms) => ids.split(' ').map(id => {
    const i = syms.findIndex(s => s.id === id);
    if (i < 0) throw new Error('unknown symbol ' + id);
    return i;
  });

  /* ---------------------------------------------- Gilded Sevens ----- */
  // Classic three-reel stepper. 22 physical stops per reel (11 symbols, 11
  // blanks), each with a weight; the weights total 64 per reel, the size of
  // a typical virtual reel. Crown is wild: it substitutes for any symbol and
  // doubles the pay (two crowns: x4). Three crowns is the top award.
  const GS_SYMS = [
    { id: 'blank',  name: 'Blank' },
    { id: 'cherry', name: 'Cherry' },
    { id: 'bar1',   name: 'Single BAR' },
    { id: 'bar2',   name: 'Double BAR' },
    { id: 'bar3',   name: 'Triple BAR' },
    { id: 'seven',  name: 'Red 7' },
    { id: 'crown',  name: 'Gold Crown (wild)' },
  ];
  const GS_STOPS = 'crown blank bar1 blank cherry blank bar2 blank seven blank bar1 blank bar3 blank cherry blank bar1 blank bar2 blank bar3 blank';
  const gilded = {
    id: 'gilded', name: 'Gilded Sevens', kind: 'classic',
    tagline: 'Classic three-reel. Crowns are wild and double the pay.',
    symbols: GS_SYMS,
    reels: [
      // weights line up with GS_STOPS, stop by stop. Each reel totals 64 virtual stops.
      { stops: strip(GS_STOPS, GS_SYMS), weights: [1,4,4,4,3,3,2,3,2,3,4,3,2,3,3,3,4,3,2,3,2,3] },
      { stops: strip(GS_STOPS, GS_SYMS), weights: [1,4,4,4,3,3,2,3,2,3,4,3,2,3,3,3,4,3,2,3,2,3] },
      { stops: strip(GS_STOPS, GS_SYMS), weights: [1,4,4,4,3,3,2,3,2,3,4,3,2,3,3,3,4,3,2,3,2,3] },
    ],
    rows: 3,                          // the window shows the stop above and below the payline
    // Pays x bet. `three`: three of the symbol (crowns substitute, doubling per crown).
    pays: {
      crowns: 1000,                   // three crowns
      three: { seven: 100, bar3: 50, bar2: 25, bar1: 10, cherry: 10 },
      anyBar: 5,                      // any mix of BARs (crowns substitute, doubling)
      cherries: [0, 2, 5],            // one / two cherries anywhere on the line (no wild help)
    },
    bet: { min: 5, step: 5 },
    par: null,                        // filled in below from enumerate-slots.js
  };

  /* ---------------------------------------------- Sunken Galleon ---- */
  // Five-reel, twenty-line video slot. Ship is wild (not on reel 1),
  // treasure chest is the scatter: 3+ anywhere pays x total bet and starts
  // 12 free spins with every win tripled (3+ chests in free spins add 12 more).
  const SG_SYMS = [
    { id: 'nine',    name: '9' },
    { id: 'ten',     name: '10' },
    { id: 'jack',    name: 'J' },
    { id: 'queen',   name: 'Q' },
    { id: 'king',    name: 'K' },
    { id: 'ace',     name: 'A' },
    { id: 'anchor',  name: 'Anchor' },
    { id: 'compass', name: 'Compass' },
    { id: 'parrot',  name: 'Parrot' },
    { id: 'captain', name: 'Captain' },
    { id: 'wild',    name: 'Galleon (wild)' },
    { id: 'chest',   name: 'Treasure Chest (scatter)' },
  ];
  const galleon = {
    id: 'galleon', name: 'Sunken Galleon', kind: 'lines',
    tagline: '5 reels, 20 lines. 3 treasure chests start 12 free spins at x3.',
    symbols: SG_SYMS,
    reels: [
      { stops: strip('nine jack ace parrot ten nine queen king ten jack chest nine compass queen ten ace jack nine king ten anchor queen nine jack ten ace parrot nine queen jack ten king nine chest queen compass captain ten jack nine ace queen ten king nine jack anchor ten queen', SG_SYMS) },
      { stops: strip('captain queen nine anchor jack ten ace nine queen parrot king ten jack nine chest queen wild ten nine jack ace compass ten queen king nine jack ten anchor nine queen ace jack ten parrot nine king queen ten jack nine wild ace compass ten queen nine jack king ten', SG_SYMS) },
      { stops: strip('compass ten king nine queen jack ten nine ace anchor queen ten jack king captain chest nine parrot queen ten nine jack ace wild ten queen compass nine king jack ten nine queen ace anchor ten jack nine king chest queen ten parrot jack nine ten queen ace nine wild jack', SG_SYMS) },
      { stops: strip('ace jack ten nine king wild queen compass jack ten nine queen ace ten jack nine anchor king ten queen nine jack parrot ten ace queen nine captain jack king wild ten compass nine queen ten jack ace nine anchor queen chest ten king nine jack ten parrot queen nine', SG_SYMS) },
      { stops: strip('queen nine chest jack ace ten parrot nine queen king ten jack wild nine compass queen ten ace jack nine king ten queen nine anchor jack ten chest nine ace queen parrot jack ten king nine queen wild ten jack compass nine ace captain queen ten nine jack king anchor ten', SG_SYMS) },
    ],
    rows: 3,
    lines: [
      [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2], [0,1,2,1,0], [2,1,0,1,2],
      [1,0,0,0,1], [1,2,2,2,1], [0,0,1,2,2], [2,2,1,0,0], [1,2,1,0,1],
      [1,0,1,2,1], [0,1,1,1,0], [2,1,1,1,2], [0,1,0,1,0], [2,1,2,1,2],
      [1,1,0,1,1], [1,1,2,1,1], [0,0,2,0,0], [2,2,0,2,2], [0,2,2,2,0],
    ],
    // Line pays x line bet for 3, 4, 5 of a kind from reel 1.
    pays: {
      nine: [13, 40, 125], ten: [13, 40, 125], jack: [15, 50, 150], queen: [15, 50, 150],
      king: [20, 60, 200], ace: [20, 60, 200],
      anchor: [30, 90, 300], compass: [30, 90, 300], parrot: [50, 200, 600], captain: [75, 300, 1500],
      // no pay for wilds alone: the ship never lands on reel 1, so a line of only wilds cannot happen
    },
    wild: 'wild', scatter: 'chest',
    scatterPays: [0, 0, 0, 2, 10, 50],   // x TOTAL bet, by number of chests anywhere
    free: { trigger: 3, spins: 12, mult: 3 },
    bet: { lines: 20, minLineBet: 1 },
    par: null,
  };

  /* ---------------------------------------------- Lantern Festival -- */
  // Five-reel, 243-ways video slot. A symbol pays when it lands anywhere on
  // adjacent reels from the left (pay x ways). Golden coin is wild on reels
  // 2-4; fireworks scatter on reels 1, 3 and 5 starts 10 free spins at x5.
  const LF_SYMS = [
    { id: 'nine',    name: '9' },
    { id: 'ten',     name: '10' },
    { id: 'jack',    name: 'J' },
    { id: 'queen',   name: 'Q' },
    { id: 'king',    name: 'K' },
    { id: 'ace',     name: 'A' },
    { id: 'fan',     name: 'Paper Fan' },
    { id: 'lantern', name: 'Lantern' },
    { id: 'koi',     name: 'Koi' },
    { id: 'dragon',  name: 'Dragon' },
    { id: 'wild',    name: 'Golden Coin (wild)' },
    { id: 'firework',name: 'Fireworks (scatter)' },
  ];
  const lantern = {
    id: 'lantern', name: 'Lantern Festival', kind: 'ways',
    tagline: '243 ways to win. Fireworks on reels 1, 3, 5 start 10 free spins at x5.',
    symbols: LF_SYMS,
    reels: [
      { stops: strip('nine ace jack koi ten king firework nine queen lantern jack ten ace nine queen fan king jack ten dragon nine queen ace ten firework jack lantern nine king koi queen ten fan jack nine ace queen ten king nine jack firework lantern ten ace queen dragon nine jack king fan ten queen', LF_SYMS) },
      { stops: strip('dragon queen fan nine jack ace ten nine king queen koi jack ten lantern nine ace queen wild fan ten jack king nine queen ten ace dragon jack nine king lantern queen ten jack nine koi ace fan ten queen king nine jack wild ten queen ace nine lantern jack king ten', LF_SYMS) },
      { stops: strip('lantern king ten queen nine jack fan dragon firework ace ten nine queen king jack ten nine koi lantern ace queen firework ten jack king nine wild fan queen ten jack ace nine king queen dragon firework ten lantern jack nine ace ten queen fan nine king koi jack firework ten queen nine ace wild jack', LF_SYMS) },
      { stops: strip('ace jack ten king lantern wild nine queen jack ten ace fan nine queen dragon king jack ten nine queen ace lantern ten jack koi king nine queen fan ten jack wild ace nine king queen ten nine jack lantern dragon ace ten queen nine jack king fan ten koi queen nine', LF_SYMS) },
      { stops: strip('queen nine jack ace ten koi king nine queen firework lantern jack ten ace nine queen fan king jack ten nine dragon queen ace ten jack firework nine lantern king queen ten koi jack nine fan ace queen ten king nine jack firework ten lantern ace queen nine jack dragon king ten fan', LF_SYMS) },
    ],
    rows: 3,
    // Pays x bet unit, per way, for 3, 4, 5 reels. Total bet = 25 units.
    pays: {
      nine: [8, 20, 60], ten: [8, 20, 60], jack: [8, 25, 75], queen: [8, 25, 75],
      king: [15, 30, 100], ace: [15, 30, 100],
      fan: [20, 60, 150], lantern: [25, 75, 200], koi: [35, 100, 300], dragon: [50, 150, 750],
    },
    wild: 'wild', scatter: 'firework',
    scatterPays: [0, 0, 0, 5, 0, 0],     // x TOTAL bet (3 is the most that can land)
    free: { trigger: 3, spins: 10, mult: 5 },
    bet: { units: 25, minUnit: 1 },
    par: null,
  };

  const MACHINES = { gilded, galleon, lantern };
  const MACHINE_IDS = Object.keys(MACHINES);

  /* ===================================== exact PAR figures (verified) ===== */
  // Computed by enumerate-slots.js over every combination of reel stops; it
  // fails if these disagree with what it computes. The page shows them.
  //   rtp      expected return per chip bet, features included
  //   hit      chance a paid spin wins anything (base game)
  //   feature  chance a paid spin starts free spins (lines / ways)
  //   sd       standard deviation of one paid spin's return, in total bets
  //            (base game only; the feature makes the true figure higher)
  const PAR = {
    gilded:  { rtp: 0.93035889, hit: 0.29113388, feature: 0,          sd: 4.282082 },
    galleon: { rtp: 0.94959177, hit: 0.44408372, feature: 0.00706679, sd: 1.497263 },
    lantern: { rtp: 0.9465319,  hit: 0.43808657, feature: 0.00617912, sd: 1.508113 },
  };
  for (const id of MACHINE_IDS) MACHINES[id].par = PAR[id];

  /* =========================================== prepare / validate ===== */

  function prepare(m) {
    m.symIndex = {};
    m.symbols.forEach((s, i) => { m.symIndex[s.id] = i; });
    m.wildIdx = m.wild != null ? m.symIndex[m.wild] : m.symIndex.crown;
    m.scatterIdx = m.scatter != null ? m.symIndex[m.scatter] : -1;
    for (const r of m.reels) {
      r.len = r.stops.length;
      if (!r.weights) r.weights = r.stops.map(() => 1);
      if (r.weights.length !== r.len) throw new Error(m.id + ': weights and stops differ in length');
      r.total = r.weights.reduce((a, b) => a + b, 0);
      // cumulative weights, for turning a virtual stop into a physical one
      r.cum = []; let c = 0;
      for (const w of r.weights) { c += w; r.cum.push(c); }
    }
    if (m.kind === 'lines' || m.kind === 'ways') {
      // pay table as a flat array by symbol index: payArr[sym*3 + (n-3)]
      m.payArr = new Int32Array(m.symbols.length * 3);
      for (const [id, p] of Object.entries(m.pays)) {
        const i = m.symIndex[id];
        if (i == null) throw new Error(m.id + ': pay for unknown symbol ' + id);
        for (let k = 0; k < 3; k++) m.payArr[i * 3 + k] = p[k];
      }
    }
    if (m.kind === 'lines') m.lineRows = Int8Array.from(m.lines.flat());
    checkMachine(m);
    return m;
  }

  /** Reject a machine that could owe a fractional chip or is malformed. */
  function checkMachine(m) {
    const whole = (v) => Number.isInteger(v) && v >= 0;
    const allPays = [];
    if (m.kind === 'classic') {
      allPays.push(m.pays.crowns, m.pays.anyBar, ...Object.values(m.pays.three), ...m.pays.cherries);
      if (m.reels.length !== 3) throw new Error(m.id + ': classic machines have 3 reels');
      if (!whole(m.bet.min) || !whole(m.bet.step) || m.bet.min < 1) throw new Error(m.id + ': bad bet');
    } else {
      for (const p of Object.values(m.pays)) allPays.push(...p);
      allPays.push(...m.scatterPays);
      if (!whole(m.free.mult) || !whole(m.free.spins)) throw new Error(m.id + ': feature must be whole');
      if (m.reels.length !== 5 || m.rows !== 3) throw new Error(m.id + ': video machines are 5x3');
    }
    for (const r of m.reels) {
      for (const s of r.stops) if (s < 0 || s >= m.symbols.length) throw new Error(m.id + ': bad stop');
      for (const w of r.weights) if (!whole(w) || w < 1) throw new Error(m.id + ': weights must be whole and positive');
    }
    for (const p of allPays) if (!whole(p)) throw new Error(m.id + ': every pay must be a whole multiple');
  }

  for (const id of MACHINE_IDS) prepare(MACHINES[id]);

  /* ============================================================ bets ===== */

  /** Total chips one paid spin costs at this bet level. */
  function totalBet(m, level) {
    if (m.kind === 'classic') return level;
    if (m.kind === 'lines') return level * m.bet.lines;
    return level * m.bet.units;
  }

  /** null if `level` is a valid bet level for the machine, else a message. */
  function betError(m, level) {
    if (!Number.isInteger(level) || level < 1) return 'Bet must be a whole number of chips.';
    if (m.kind === 'classic') {
      if (level < m.bet.min || level % m.bet.step !== 0) return `Bet is a multiple of ${m.bet.step}, at least ${m.bet.min}.`;
    } else if (m.kind === 'lines') {
      if (level < m.bet.minLineBet) return `Line bet is at least ${m.bet.minLineBet}.`;
    } else if (level < m.bet.minUnit) return `Bet unit is at least ${m.bet.minUnit}.`;
    return null;
  }

  /** Bet levels, ascending, whose total cost is at most maxTotal. */
  function betLevels(m, maxTotal) {
    const out = [];
    const base = m.kind === 'classic' ? [5, 10, 15, 20, 25, 50, 75, 100, 150, 200, 250, 500, 1000, 2500, 5000, 10000, 25000]
      : [1, 2, 3, 4, 5, 10, 15, 20, 25, 50, 100, 200, 250, 500, 1000];
    for (const l of base) if (!betError(m, l) && totalBet(m, l) <= maxTotal) out.push(l);
    return out;
  }

  /* ============================================================ spin ===== */

  /** Physical stop for virtual stop v on reel r (weights = virtual reel). */
  function physicalStop(r, v) {
    let lo = 0, hi = r.len - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (v < r.cum[mid]) hi = mid; else lo = mid + 1; }
    return lo;
  }

  /** One stop per reel: uniform over each reel's virtual stops. randInt(n) in [0, n). */
  function spinStops(m, randInt) {
    return m.reels.map(r => physicalStop(r, randInt(r.total)));
  }

  /**
   * The symbols in the window, grid[reel*rows + row], row 0 at the top. The
   * stop sits in the middle row (rows=3), as on a real machine.
   */
  function windowOf(m, stops, out) {
    const rows = m.rows, g = out || new Int8Array(m.reels.length * rows);
    for (let i = 0; i < m.reels.length; i++) {
      const r = m.reels[i], s = stops[i];
      for (let j = 0; j < rows; j++) g[i * rows + j] = r.stops[(s + j - 1 + r.len) % r.len];
    }
    return g;
  }

  /* ======================================================== evaluate ===== */
  // payOf(): the amount, allocation-free, in bet units (classic: x bet;
  // lines: x line bet; ways: x bet unit; scatter pays are converted to the
  // same unit). The enumerator calls this for every combination. wins()
  // gives the same amounts broken down per line/way for display, and the
  // test harness checks the two always agree.

  /** Classic: pay (x bet) for the three symbols on the centre line. */
  function classicPay(m, a, b, c) {
    const W = m.wildIdx, P = m.pays, sym = m.symbols;
    const w = (a === W) + (b === W) + (c === W);
    if (w === 3) return P.crowns;
    const mult = w === 2 ? 4 : w === 1 ? 2 : 1;
    let best = 0;
    // three of a kind, crowns substituting
    let s = -1, same = true;
    for (const x of [a, b, c]) {
      if (x === W) continue;
      if (s < 0) s = x; else if (x !== s) same = false;
    }
    if (same && s >= 0) {
      const p = P.three[sym[s].id];
      if (p) best = Math.max(best, p * mult);
    }
    // any mix of BARs
    let bars = true;
    for (const x of [a, b, c]) if (x !== W && !/^bar/.test(sym[x].id)) bars = false;
    if (bars) best = Math.max(best, P.anyBar * mult);
    // cherries anywhere on the line (crowns don't help, no multiplier)
    const ch = m.symIndex.cherry;
    const nc = (a === ch) + (b === ch) + (c === ch);
    if (nc > 0 && nc < 3) best = Math.max(best, P.cherries[nc]);
    return best;
  }

  /** Lines: one payline's pay (x line bet). Returns pay; *info gets symbol and count. */
  function linePay(m, g, li, info) {
    const W = m.wildIdx, S = m.scatterIdx, rows = 3, L = m.lineRows, o = li * 5;
    // leading wilds (they pay on their own) ...
    let nw = 0;
    while (nw < 5 && g[nw * rows + L[o + nw]] === W) nw++;
    const wildPay = nw >= 3 ? m.payArr[W * 3 + nw - 3] : 0;
    // ... and the first real symbol, extended by matches and wilds
    let sym = -1, n = 0;
    if (nw < 5) {
      sym = g[nw * rows + L[o + nw]];
      if (sym !== S) {
        n = nw + 1;
        while (n < 5) { const x = g[n * rows + L[o + n]]; if (x === sym || x === W) n++; else break; }
      }
    }
    const symPay = sym >= 0 && sym !== S && n >= 3 ? m.payArr[sym * 3 + n - 3] : 0;
    if (info) {
      if (wildPay >= symPay) { info.sym = W; info.n = nw; } else { info.sym = sym; info.n = n; }
    }
    return wildPay >= symPay ? wildPay : symPay;
  }

  /** Ways: total over paying symbols of pay x ways (x bet unit). */
  function waysPay(m, g, detail) {
    const W = m.wildIdx, S = m.scatterIdx, rows = 3, nSym = m.symbols.length;
    let total = 0;
    for (let sym = 0; sym < nSym; sym++) {
      if (sym === W || sym === S) continue;
      let ways = 1, n = 0;
      for (let i = 0; i < 5; i++) {
        let c = 0;
        for (let j = 0; j < rows; j++) { const x = g[i * rows + j]; if (x === sym || x === W) c++; }
        if (!c) break;
        ways *= c; n++;
      }
      if (n >= 3) {
        const p = m.payArr[sym * 3 + n - 3] * ways;
        if (p) { total += p; if (detail) detail.push({ sym, n, ways, pay: p }); }
      }
    }
    return total;
  }

  function scatterCount(m, g) {
    if (m.scatterIdx < 0) return 0;
    let n = 0;
    for (let k = 0; k < g.length; k++) if (g[k] === m.scatterIdx) n++;
    return n;
  }

  /** Bet units per total bet: what a scatter pay (x total bet) is worth in pay units. */
  const unitsPerBet = (m) => (m.kind === 'lines' ? m.bet.lines : m.kind === 'ways' ? m.bet.units : 1);

  /**
   * The whole window's pay in bet units (before any free-spin multiplier),
   * allocation-free. Scatter pays are included. This is what the enumerator
   * sums over every combination of stops.
   */
  function payOf(m, g) {
    if (m.kind === 'classic') return classicPay(m, g[1], g[4], g[7]);
    let t = 0;
    if (m.kind === 'lines') { for (let li = 0; li < m.lines.length; li++) t += linePay(m, g, li, null); }
    else t = waysPay(m, g, null);
    return t + m.scatterPays[scatterCount(m, g)] * unitsPerBet(m);
  }

  /** Free spins this window awards (0 if none). */
  function freeSpinsWon(m, g) {
    return m.free && scatterCount(m, g) >= m.free.trigger ? m.free.spins : 0;
  }

  /**
   * The same pay as payOf(), itemised for display: [{ kind, line?, sym, n,
   * ways?, cells: [[reel,row],...], pay }], pay in bet units. Sum === payOf.
   */
  function wins(m, g) {
    const out = [];
    if (m.kind === 'classic') {
      const p = classicPay(m, g[1], g[4], g[7]);
      if (p) out.push({ kind: 'line', line: 0, cells: [[0, 1], [1, 1], [2, 1]], pay: p });
      return out;
    }
    if (m.kind === 'lines') {
      const info = {};
      for (let li = 0; li < m.lines.length; li++) {
        const p = linePay(m, g, li, info);
        if (p) out.push({ kind: 'line', line: li, sym: info.sym, n: info.n, pay: p,
          cells: m.lines[li].slice(0, info.n).map((row, reel) => [reel, row]) });
      }
    } else {
      const d = [];
      waysPay(m, g, d);
      for (const w of d) {
        const cells = [];
        for (let i = 0; i < w.n; i++) for (let j = 0; j < 3; j++) {
          const x = g[i * 3 + j];
          if (x === w.sym || x === m.wildIdx) cells.push([i, j]);
        }
        out.push({ kind: 'ways', sym: w.sym, n: w.n, ways: w.ways, pay: w.pay, cells });
      }
    }
    const sc = scatterCount(m, g), sp = m.scatterPays[sc] * unitsPerBet(m);
    if (sc >= 3) {
      const cells = [];
      for (let k = 0; k < g.length; k++) if (g[k] === m.scatterIdx) cells.push([(k / 3) | 0, k % 3]);
      out.push({ kind: 'scatter', sym: m.scatterIdx, n: sc, pay: sp, cells, free: freeSpinsWon(m, g) });
    }
    return out;
  }

  /* ========================================================== a spin ===== */

  /**
   * Play one spin. The only place slot payouts are computed, offline and online.
   *
   *   level  bet level (classic: chips; lines: line bet; ways: bet unit)
   *   free   null for a paid spin, or the feature state { left, mult, won, level }
   *          (a free spin is played at the level that triggered it)
   *
   * Returns { stops, grid (plain array), wins, cost, win, free } where cost
   * is chips taken (0 on a free spin), win is chips paid, and `free` is the
   * feature state AFTER this spin (null when there is none or it just ended).
   * Pure apart from randInt: the caller moves the chips.
   */
  function play(m, level, free, randInt) {
    if (free) level = free.level;
    const err = betError(m, level);
    if (err) throw new Error(err);
    const stops = spinStops(m, randInt);
    const g = windowOf(m, stops);
    const unitChips = level;                       // chips per bet unit
    const mult = free ? free.mult : 1;
    const ws = wins(m, g).map(w => Object.assign(w, { chips: w.pay * unitChips * mult }));
    const win = payOf(m, g) * unitChips * mult;
    let next = free ? { left: free.left - 1, mult: free.mult, won: free.won + win, level: free.level, total: free.total } : null;
    const award = freeSpinsWon(m, g);
    if (award) {
      if (next) { next.left += award; next.total += award; }
      else next = { left: award, mult: m.free.mult, won: 0, level, total: award };
    }
    if (next && next.left <= 0) next = null;
    return { stops, grid: Array.from(g), wins: ws, cost: free ? 0 : totalBet(m, level), win, award, mult, free: next,
             featureWon: free && !next ? free.won + win : null };
  }

  /** Economy facts about a settled spin (page and server both build them here). */
  function facts(res, m) {
    return { game: 'slots', machine: m.id, wagered: res.cost, minBet: totalBet(m, m.kind === 'classic' ? m.bet.min : 1),
             slotWin: res.win > 0, slotFeature: res.award > 0 };
  }

  const SLOTS = {
    MACHINES, MACHINE_IDS, PAR, prepare,
    totalBet, betError, betLevels, unitsPerBet,
    physicalStop, spinStops, windowOf, classicPay, linePay, waysPay, scatterCount,
    payOf, freeSpinsWon, wins, play, facts,
  };

  if (typeof module === 'object' && module.exports) module.exports = SLOTS;
  else root.SLOTS = SLOTS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
