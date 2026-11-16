/*
 * Linked progressive jackpots: the ONE copy of their rules.
 *
 * Four tiers shared by every slot machine and every online player, the way a
 * casino links a bank of machines (a "wide-area progressive"):
 *
 *   Mini, Minor   MUST-HIT-BY. Each starts at its seed and is guaranteed to
 *                 drop before it reaches its cap. When the meter resets, the
 *                 drop point is drawn uniformly between the meter and the cap
 *                 and kept secret, as on a real floor controller; the spin
 *                 whose contribution carries the meter to it wins. Unlike a
 *                 real casino we publish a SHA-256 commitment to the drop
 *                 point up front and reveal it (with its salt) when it hits,
 *                 so anyone can check it was fixed in advance.
 *   Major, Grand  MYSTERY. Every paid spin has a fixed chance per chip bet
 *                 (cost / oddsPerChip), the same for everyone. Bigger bets buy
 *                 proportionally more chances, exactly like betting more.
 *
 * Funding: every paid spin puts `rate` (in units of 1/10,000 of the bet) onto
 * each tier's meter: 1.00% of the bet in total. Seeds are house money. Meters
 * are kept in UNITS (1 chip = 10,000 units) so fractional contributions are
 * exact; a hit pays whole chips and the fraction stays on the meter.
 *
 * Audit identity, per tier, always:  meter = seeded + contributed - paid
 *
 * Nothing here knows who is playing. Free spins contribute nothing (nothing
 * was bet). Online only: a shared pool needs the server.
 *
 * Classic script: the page loads it (display), the server and tests require it.
 */
(function (root) {
  'use strict';

  const U = 10000;   // meter units per chip

  const TIERS = [
    { id: 'mini',  name: 'Mini',  seed: 50,    rate: 20, mustHitBy: 250 },
    { id: 'minor', name: 'Minor', seed: 500,   rate: 20, mustHitBy: 2500 },
    { id: 'major', name: 'Major', seed: 5000,  rate: 30, oddsPerChip: 2000000 },
    { id: 'grand', name: 'Grand', seed: 50000, rate: 30, oddsPerChip: 20000000 },
  ];
  const TIER_BY_ID = Object.fromEntries(TIERS.map(t => [t.id, t]));
  const totalRate = (cfg) => (cfg || TIERS).reduce((a, t) => a + t.rate, 0) / U;   // 0.01 = 1%

  /* ------------------------------------------------------------ hashing -- */

  const HEX = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  async function sha256Hex(s) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return HEX(new Uint8Array(buf));
  }
  /** What the commitment hashes: anyone can recompute it from a reveal. */
  const commitText = (tierId, hp, salt) => `${tierId}:${hp}:${salt}`;

  /* --------------------------------------------------------------- pool -- */

  /** Draw a must-hit-by tier's secret drop point above `meter`, and commit to it. */
  async function arm(t, ts, randInt) {
    const lo = ts.meter + 1, hi = t.mustHitBy * U;
    ts.hp = lo >= hi ? hi : lo + randInt(hi - lo + 1);
    let salt = '';
    for (let i = 0; i < 16; i++) salt += randInt(256).toString(16).padStart(2, '0');
    ts.salt = salt;
    ts.commit = await sha256Hex(commitText(t.id, ts.hp, salt));
  }

  /** A fresh pool: every tier at its seed (house money), must-hit-by tiers armed. */
  async function blankPool(randInt, cfg) {
    const pool = { tiers: {}, hits: 0 };
    for (const t of cfg || TIERS) {
      const ts = { meter: t.seed * U, seeded: t.seed * U, contributed: 0, paid: 0, hits: 0 };
      if (t.mustHitBy) await arm(t, ts, randInt);
      pool.tiers[t.id] = ts;
    }
    return pool;
  }

  /**
   * One paid spin's effect on the pool: contribute, then see what it hit.
   * Mutates `pool`. Returns [{ tier, name, amount, reveal? }] (usually []).
   * `cost` is the chips the spin cost (0 for a free spin: no contribution,
   * no chance). randInt(n) in [0, n).
   */
  async function play(pool, cost, randInt, cfg) {
    const hits = [];
    if (!(cost > 0)) return hits;
    const tiers = cfg || TIERS;
    for (const t of tiers) {
      const ts = pool.tiers[t.id], add = cost * t.rate;
      ts.meter += add; ts.contributed += add;
    }
    for (const t of tiers) {
      const ts = pool.tiers[t.id];
      let won = false;
      if (t.mustHitBy) won = ts.meter >= ts.hp;
      else won = randInt(t.oddsPerChip) < cost;   // chance exactly cost / oddsPerChip
      if (!won) continue;
      // A must-hit-by jackpot never pays more than its cap; any excess stays on the meter.
      const payable = t.mustHitBy ? Math.min(ts.meter, t.mustHitBy * U) : ts.meter;
      const amount = Math.floor(payable / U);
      const hit = { tier: t.id, name: t.name, amount };
      if (t.mustHitBy) hit.reveal = { hp: ts.hp, salt: ts.salt, commit: ts.commit, text: commitText(t.id, ts.hp, ts.salt) };
      ts.meter -= amount * U; ts.paid += amount * U; ts.hits++;
      ts.meter += t.seed * U; ts.seeded += t.seed * U;   // the house reseeds it
      if (t.mustHitBy) await arm(t, ts, randInt);
      pool.hits++;
      hits.push(hit);
    }
    return hits;
  }

  /** What players may see: meters (in chips, two decimals) and commitments. Never a drop point. */
  function view(pool, cfg) {
    if (!pool) return null;
    return {
      tiers: (cfg || TIERS).map(t => {
        const ts = pool.tiers[t.id];
        const v = { id: t.id, name: t.name, meter: Math.floor(ts.meter / 100) / 100, seed: t.seed, hits: ts.hits };
        if (t.mustHitBy) { v.mustHitBy = t.mustHitBy; v.commit = ts.commit; }
        else v.oddsPerChip = t.oddsPerChip;
        return v;
      }),
      rate: totalRate(cfg),
    };
  }

  /** null if every tier satisfies meter = seeded + contributed - paid, else a message. */
  function auditError(pool, cfg) {
    for (const t of cfg || TIERS) {
      const ts = pool.tiers[t.id];
      if (!ts) return `${t.id}: missing`;
      for (const k of ['meter', 'seeded', 'contributed', 'paid']) if (!Number.isInteger(ts[k]) || ts[k] < 0) return `${t.id}.${k} not a whole unit count`;
      if (ts.meter !== ts.seeded + ts.contributed - ts.paid) return `${t.id}: meter ${ts.meter} != seeded + contributed - paid`;
      if (t.mustHitBy && !(ts.hp > ts.meter - 1 && ts.hp <= t.mustHitBy * U)) return `${t.id}: drop point out of range`;
    }
    return null;
  }

  /** Check a revealed must-hit-by hit against its commitment. */
  async function verifyReveal(tierId, reveal) {
    return !!reveal && reveal.commit === await sha256Hex(commitText(tierId, reveal.hp, reveal.salt));
  }

  /**
   * Expected jackpot return per chip bet RIGHT NOW from the mystery tiers
   * (chance per chip x current meter). Must-hit-by tiers pay back their
   * contributions over time; this is the part that moves with the meters.
   */
  function mysteryValuePerChip(v) {
    return v.tiers.filter(t => t.oddsPerChip).reduce((a, t) => a + t.meter / t.oddsPerChip, 0);
  }

  const JACKPOT = { U, TIERS, TIER_BY_ID, totalRate, sha256Hex, commitText, blankPool, play, view, auditError, verifyReveal, mysteryValuePerChip };
  if (typeof module === 'object' && module.exports) module.exports = JACKPOT;
  else root.JACKPOT = JACKPOT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
