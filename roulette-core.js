/*
 * Roulette: the ONE copy of the game's rules.
 *
 * Two wheels: American (0 and 00, 38 pockets) and European (single 0, 37).
 * Every bet that a real layout takes is generated here from the layout's
 * geometry (so the page can draw a chip spot for it and the server can check
 * a bet is real): straight, split, street, corner, six line, the zero-area
 * splits and trios, the American basket (0-00-1-2-3) and the European first
 * four, plus every outside bet.
 *
 * A spin is one pocket, uniform over the wheel's pockets: ROULETTE.spin().
 * settle() is the only place roulette payouts are computed (page and server).
 * Each bet's exact return is (pays + 1) * covered / pockets: there is nothing
 * to simulate, and test-roulette.js checks every bet against that count.
 *
 * Numbers: 0..36 are themselves; 00 is 37.
 * Classic script (not an ES module) so index.html still opens from file://.
 */
(function (root) {
  'use strict';

  const DZ = 37;   // the 00 pocket
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const label = (n) => (n === DZ ? '00' : String(n));
  const colorOf = (n) => (n === 0 || n === DZ ? 'green' : RED.has(n) ? 'red' : 'black');

  // Pockets in wheel order, clockwise (the real sequences).
  const ORDER = {
    american: [0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, DZ, 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2],
    european: [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26],
  };

  // Pays N to 1 by bet kind.
  const PAYS = { straight: 35, split: 17, street: 11, trio: 11, corner: 8, firstFour: 8, basket: 6, sixLine: 5,
                 dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1 };
  const KIND_NAME = { straight: 'Straight', split: 'Split', street: 'Street', trio: 'Trio', corner: 'Corner',
                      firstFour: 'First four', basket: 'Basket (top line)', sixLine: 'Six line', dozen: 'Dozen',
                      column: 'Column', red: 'Red', black: 'Black', odd: 'Odd', even: 'Even', low: '1 to 18', high: '19 to 36' };

  /*
   * Layout geometry, in cell units. Numbers sit in 12 columns (x 1..13) and
   * 3 rows (y 0..3, top row = 3, 6, ... 36); the zero area is x 0..1. Each
   * inside bet's chip spot is where it sits on a real table: on a number, on
   * the line between two, at a corner, on the outer edge for streets and six
   * lines. Outside bets are boxes below and to the right.
   */
  const num = (c, row) => 3 * c + (3 - row);   // column 0..11, row 0 (top) .. 2 (bottom)

  function buildBets(wheelId) {
    const bets = [];
    const add = (kind, numbers, x, y, extra) => {
      const ns = numbers.slice().sort((a, b) => a - b);
      const id = kind + ':' + ns.map(label).join('-');
      bets.push(Object.assign({ id, kind, numbers: ns, pays: PAYS[kind], x, y }, extra || {}));
    };
    // numbers: straights, splits, corners, streets, six lines
    for (let c = 0; c < 12; c++) for (let row = 0; row < 3; row++) {
      add('straight', [num(c, row)], 1.5 + c, row + 0.5);
      if (c < 11) add('split', [num(c, row), num(c + 1, row)], 2 + c, row + 0.5);
      if (row < 2) add('split', [num(c, row), num(c, row + 1)], 1.5 + c, row + 1);
      if (c < 11 && row < 2) add('corner', [num(c, row), num(c + 1, row), num(c, row + 1), num(c + 1, row + 1)], 2 + c, row + 1);
    }
    for (let c = 0; c < 12; c++) {
      add('street', [3 * c + 1, 3 * c + 2, 3 * c + 3], 1.5 + c, 3);
      if (c < 11) add('sixLine', [3 * c + 1, 3 * c + 2, 3 * c + 3, 3 * c + 4, 3 * c + 5, 3 * c + 6], 2 + c, 3);
    }
    // the zero area
    if (wheelId === 'american') {
      add('straight', [DZ], 0.5, 0.75, { zero: true }); add('straight', [0], 0.5, 2.25, { zero: true });
      add('split', [0, DZ], 0.5, 1.5);
      add('split', [DZ, 3], 1, 0.5); add('split', [DZ, 2], 1, 1.25); add('split', [0, 2], 1, 1.75); add('split', [0, 1], 1, 2.5);
      add('trio', [DZ, 2, 3], 1, 1); add('trio', [0, DZ, 2], 1, 1.5); add('trio', [0, 1, 2], 1, 2);
      add('basket', [0, DZ, 1, 2, 3], 1, 3);
    } else {
      add('straight', [0], 0.5, 1.5, { zero: true });
      add('split', [0, 3], 1, 0.5); add('split', [0, 2], 1, 1.5); add('split', [0, 1], 1, 2.5);
      add('trio', [0, 2, 3], 1, 1); add('trio', [0, 1, 2], 1, 2);
      add('firstFour', [0, 1, 2, 3], 1, 3);
    }
    // outside
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    for (let d = 0; d < 3; d++) add('dozen', range(12 * d + 1, 12 * d + 12), 1 + 4 * d + 2, 3.45, { box: [1 + 4 * d, 3, 4, 0.9], text: ['1st 12', '2nd 12', '3rd 12'][d] });
    for (let row = 0; row < 3; row++) add('column', range(0, 11).map(c => num(c, row)), 13.5, row + 0.5, { box: [13, row, 1, 1], text: '2 to 1' });
    const all = range(1, 36);
    const outs = [['low', all.filter(n => n <= 18), '1 to 18'], ['even', all.filter(n => n % 2 === 0), 'EVEN'],
                  ['red', all.filter(n => RED.has(n)), 'RED'], ['black', all.filter(n => !RED.has(n)), 'BLACK'],
                  ['odd', all.filter(n => n % 2 === 1), 'ODD'], ['high', all.filter(n => n >= 19), '19 to 36']];
    outs.forEach(([k, ns, text], i) => add(k, ns, 1 + 2 * i + 1, 4.35, { box: [1 + 2 * i, 3.9, 2, 0.9], text }));
    return bets;
  }

  const WHEELS = {};
  for (const id of ['american', 'european']) {
    const order = ORDER[id];
    const bets = buildBets(id);
    WHEELS[id] = {
      id, name: id === 'american' ? 'American (0, 00)' : 'European (single 0)',
      order, pockets: order.length, bets, betById: Object.fromEntries(bets.map(b => [b.id, b])),
    };
  }
  const WHEEL_IDS = Object.keys(WHEELS);
  const RULES = { minSpin: 5 };   // the table minimum: total chips on a spin

  /** Exact return per chip on a bet: (pays + 1) * covered / pockets - 1. */
  const betReturn = (w, b) => (b.pays + 1) * b.numbers.length / w.pockets - 1;

  /** null if `bets` ({ betId: chips }) is a legal spin at wheel w, else a message. */
  function betError(w, bets) {
    if (!bets || typeof bets !== 'object' || Array.isArray(bets)) return 'Bad bets.';
    let total = 0, n = 0;
    for (const [id, amt] of Object.entries(bets)) {
      if (!w.betById[id]) return 'That isn\'t a bet on this table.';
      if (!Number.isInteger(amt) || amt < 0) return 'Bets must be whole chips.';
      total += amt; if (amt > 0) n++;
    }
    if (!n) return 'Place a bet first.';
    if (total < RULES.minSpin) return `The table minimum is ${RULES.minSpin} chips a spin.`;
    return null;
  }

  /** One pocket, uniform: randInt(n) in [0, n). Returns the number (00 = 37). */
  function spin(w, randInt) { return w.order[randInt(w.pockets)]; }

  /**
   * Settle a spin. The only place roulette pays. Returns { pocket, label,
   * color, wagered, returned, net, lines: [{ id, kind, amount, win, returned }] }.
   */
  function settle(w, bets, pocket) {
    let wagered = 0, returned = 0;
    const lines = [];
    for (const [id, amount] of Object.entries(bets)) {
      if (!(amount > 0)) continue;
      const b = w.betById[id];
      const win = b.numbers.includes(pocket);
      const ret = win ? amount * (b.pays + 1) : 0;
      wagered += amount; returned += ret;
      lines.push({ id, kind: b.kind, amount, win, returned: ret });
    }
    return { pocket, label: label(pocket), color: colorOf(pocket), wagered, returned, net: returned - wagered, lines };
  }

  /** Economy facts about a settled spin (page and server build them here). */
  function facts(res) {
    return { game: 'roulette', wagered: res.wagered, minBet: RULES.minSpin, rouletteWin: res.net > 0 };
  }

  const ROULETTE = { DZ, RED, label, colorOf, ORDER, PAYS, KIND_NAME, WHEELS, WHEEL_IDS, RULES, betReturn, betError, spin, settle, facts };
  if (typeof module === 'object' && module.exports) module.exports = ROULETTE;
  else root.ROULETTE = ROULETTE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
