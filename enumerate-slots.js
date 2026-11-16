#!/usr/bin/env node
/*
 * Slot machines: exact PAR sheets by complete enumeration.
 *
 * For every machine in slots-core.js, walks EVERY combination of reel stops
 * (weighted by each stop's virtual-reel weight) through the same payOf() and
 * freeSpinsWon() the page and the server play with. Nothing is sampled.
 *
 *   base     expected return of one paid spin, in total bets
 *   p        chance a paid spin triggers free spins
 *   feature  free spins are played on the same reels with every win x mult,
 *            and 3+ scatters during them add more. Expected spins per trigger:
 *              T = N / (1 - p N)   (each free spin retriggers with chance p)
 *            so the feature is worth  p * T * mult * base  per paid spin.
 *   rtp      base + feature
 *
 * Fails (exit 1) if a machine's displayed PAR figures (SLOTS.PAR) disagree
 * with what it computes. Writes expected-slots.json.
 *
 * Usage:  node enumerate-slots.js [machineId]
 */
'use strict';
const fs = require('fs');
const SLOTS = require('./slots-core.js');

const only = process.argv[2];
const pct = (x, d = 4) => (100 * x).toFixed(d) + '%';
const commas = (n) => Math.round(n).toLocaleString('en-US');

function enumerate(m) {
  const R = m.reels, nR = R.length, rows = m.rows;
  const g = new Int8Array(nR * rows);
  const upb = SLOTS.unitsPerBet(m);
  // pay distribution (in bet units) -> total weight
  const dist = new Map();
  let W = 0, trig = 0, combos = 0;

  // Nested walk with the window updated one reel column at a time.
  const stops = new Array(nR).fill(0);
  const setCol = (i, s) => {
    const r = R[i];
    for (let j = 0; j < rows; j++) g[i * rows + j] = r.stops[(s + j - 1 + r.len) % r.len];
  };
  function walk(i, w) {
    const r = R[i];
    for (let s = 0; s < r.len; s++) {
      stops[i] = s;
      setCol(i, s);
      const ww = w * r.weights[s];
      if (i + 1 < nR) { walk(i + 1, ww); continue; }
      combos++;
      W += ww;
      const p = SLOTS.payOf(m, g);
      dist.set(p, (dist.get(p) || 0) + ww);
      if (SLOTS.freeSpinsWon(m, g)) trig += ww;
    }
  }
  walk(0, 1);

  const expectW = R.reduce((a, r) => a * r.total, 1);
  if (W !== expectW) throw new Error(`${m.id}: weights sum ${W}, expected ${expectW}`);

  let e = 0, e2 = 0, hitW = 0;
  for (const [p, w] of dist) {
    const x = p / upb;               // in total bets
    e += x * w; e2 += x * x * w;
    if (p > 0) hitW += w;
  }
  e /= W; e2 /= W;
  const base = e, sd = Math.sqrt(e2 - e * e), hit = hitW / W, p = trig / W;
  let featureSpins = 0, feature = 0;
  if (m.free) {
    const N = m.free.spins;
    if (p * N >= 1) throw new Error(`${m.id}: retriggers never end (p*N = ${p * N})`);
    featureSpins = N / (1 - p * N);
    feature = p * featureSpins * m.free.mult * base;
  }
  return { combos, W, base, feature, rtp: base + feature, hit, p, featureSpins, sd, dist };
}

if (require.main !== module) { module.exports = { enumerate }; return; }

let allOk = true;
const out = { generated: new Date().toISOString(), machines: {} };
const t0 = Date.now();
console.log('Slot machines: exact enumeration of every reel-stop combination');

for (const id of SLOTS.MACHINE_IDS) {
  if (only && id !== only) continue;
  const m = SLOTS.MACHINES[id];
  const t1 = Date.now();
  const r = enumerate(m);
  console.log('\n' + '='.repeat(72));
  console.log(`  ${m.name}  (${m.kind}, ${m.reels.map(x => x.total).join(' x ')} virtual stops)`);
  console.log('='.repeat(72));
  console.log(`  combinations        ${commas(r.combos)} (weighted total ${commas(r.W)})  in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  base game return    ${pct(r.base)}`);
  if (m.free) {
    console.log(`  feature chance      ${pct(r.p)}  (1 in ${(1 / r.p).toFixed(1)} paid spins)`);
    console.log(`  spins per feature   ${r.featureSpins.toFixed(4)} expected (${m.free.spins} + retriggers), wins x${m.free.mult}`);
    console.log(`  feature return      ${pct(r.feature)}`);
  }
  console.log(`  TOTAL RTP           ${pct(r.rtp)}   house edge ${pct(1 - r.rtp)}`);
  console.log(`  hit frequency       ${pct(r.hit)}  (1 in ${(1 / r.hit).toFixed(2)})`);
  console.log(`  std dev (base)      ${r.sd.toFixed(3)} total bets per spin`);
  // biggest few pays
  const top = [...r.dist.entries()].filter(([p]) => p > 0).sort((a, b) => b[0] - a[0]).slice(0, 5);
  const upb = SLOTS.unitsPerBet(m);
  console.log('  top pays            ' + top.map(([p, w]) => `${(p / upb).toLocaleString()}x (1 in ${commas(r.W / w)})`).join(', '));

  const shown = SLOTS.PAR[id];
  const computed = { rtp: r.rtp, hit: r.hit, feature: r.p, sd: r.sd };
  for (const k of Object.keys(computed)) {
    const same = Math.abs(shown[k] - computed[k]) < 5e-7 * Math.max(1, Math.abs(computed[k]));
    if (!same) {
      allOk = false;
      console.log(`  DISPLAYED ${k} ${shown[k]} vs exact ${computed[k].toFixed(8)} ... FAIL (update SLOTS.PAR.${id}.${k} in slots-core.js)`);
    }
  }
  if (allOk) console.log('  displayed PAR figures match ... PASS');
  out.machines[id] = {
    name: m.name, kind: m.kind, combinations: r.combos, weightedTotal: r.W,
    rtp: r.rtp, baseReturn: r.base, featureReturn: r.feature, featureChance: r.p,
    spinsPerFeature: r.featureSpins, hitFrequency: r.hit, sdBase: r.sd,
    suggestedPar: { rtp: +r.rtp.toFixed(8), hit: +r.hit.toFixed(8), feature: +r.p.toFixed(8), sd: +r.sd.toFixed(6) },
  };
}

if (!only) fs.writeFileSync('expected-slots.json', JSON.stringify(out, null, 2));
console.log(`\n${allOk ? 'PASS' : 'FAIL'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(allOk ? 0 : 1);
