#!/usr/bin/env node
/*
 * Slot machines: exact PAR sheets by complete enumeration.
 *
 * For every machine in slots-core.js, walks EVERY combination of reel stops
 * (weighted by each stop's virtual-reel weight) through the same payOf() and
 * freeSpinsWon() the page and the server play with. Nothing is sampled.
 * Big machines (Obsidian Forge: 2.4 billion combinations) are split across
 * worker threads by reel 1's stop; every combination is still walked once.
 *
 *   base     expected return of one paid spin, in total bets
 *   p        chance a paid spin triggers free spins
 *   feature  free spins are played on the same reels with every win x mult,
 *            and scatters during them add more spins.
 *            Fixed multiplier: expected spins per trigger T = N / (1 - p N)
 *            (each free spin retriggers with chance p), so the feature is
 *            worth  p * T * mult * base  per paid spin.
 *            Climbing multiplier (mult +climb after every winning free spin,
 *            up to maxMult): an exact expectation over (spins left, mult),
 *            from the joint distribution of (win or not, spins awarded) that
 *            the walk records:
 *              V(l, k) = sum over outcomes o of P(o) * (k * E[pay | o] + V(l - 1 + award(o), k + climb * win(o)))
 *              V(l, maxMult) = maxMult * base * l / (1 - E[award])
 *            (finite: every spin that awards spins also pays a scatter win,
 *            so it raises the multiplier; checked below.)
 *   rtp      base + feature
 *
 * Fails (exit 1) if a machine's displayed PAR figures (SLOTS.PAR) disagree
 * with what it computes. Writes expected-slots.json.
 *
 * Usage:  node enumerate-slots.js [machineId]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SLOTS = require('./slots-core.js');

const PARALLEL_ABOVE = 3e8;   // combinations: split across threads above this

/**
 * Walk the combinations whose reel-1 stop is in [s0, s1). Returns the pay
 * distribution (bet units -> weight), trigger weight, outcome classes
 * (key = win*1000 + award -> [weight, weighted pay]), total weight, count.
 */
function walkRange(m, s0, s1) {
  const R = m.reels, nR = R.length, rows = m.rows;
  const g = new Int8Array(nR * rows);
  const dist = new Map(), cls = new Map();
  let W = 0, trig = 0, combos = 0;
  const setCol = (i, s) => {
    const r = R[i];
    for (let j = 0; j < rows; j++) g[i * rows + j] = r.stops[(s + j - 1 + r.len) % r.len];
  };
  function walk(i, w) {
    const r = R[i];
    const lo = i === 0 ? s0 : 0, hi = i === 0 ? s1 : r.len;
    for (let s = lo; s < hi; s++) {
      setCol(i, s);
      const ww = w * r.weights[s];
      if (i + 1 < nR) { walk(i + 1, ww); continue; }
      combos++;
      W += ww;
      const p = SLOTS.payOf(m, g);
      dist.set(p, (dist.get(p) || 0) + ww);
      const aw = SLOTS.freeSpinsWon(m, g);
      if (aw) trig += ww;
      if (m.free) {
        const key = (p > 0 ? 1000 : 0) + aw;
        const c = cls.get(key);
        if (c) { c[0] += ww; c[1] += p * ww; } else cls.set(key, [ww, p * ww]);
      }
    }
  }
  walk(0, 1);
  return { dist: [...dist], cls: [...cls], W, trig, combos };
}

if (!isMainThread) {
  const m = SLOTS.MACHINES[workerData.id];
  parentPort.postMessage(walkRange(m, workerData.s0, workerData.s1));
  return;
}

/** Walk every combination, in parallel when it's big. */
async function walkAll(m) {
  const total = m.reels.reduce((a, r) => a * r.len, 1), len0 = m.reels[0].len;
  let parts;
  if (total <= PARALLEL_ABOVE) parts = [walkRange(m, 0, len0)];
  else {
    const n = Math.min(len0, Math.max(1, os.cpus().length));
    const jobs = [];
    for (let k = 0; k < n; k++) {
      const s0 = Math.floor(k * len0 / n), s1 = Math.floor((k + 1) * len0 / n);
      if (s1 > s0) jobs.push(new Promise((res, rej) => {
        const w = new Worker(__filename, { workerData: { id: m.id, s0, s1 } });
        w.once('message', res); w.once('error', rej);
      }));
    }
    parts = await Promise.all(jobs);
  }
  const dist = new Map(), cls = new Map();
  let W = 0, trig = 0, combos = 0;
  for (const p of parts) {
    W += p.W; trig += p.trig; combos += p.combos;
    for (const [k, w] of p.dist) dist.set(k, (dist.get(k) || 0) + w);
    for (const [k, c] of p.cls) { const o = cls.get(k); if (o) { o[0] += c[0]; o[1] += c[1]; } else cls.set(k, c.slice()); }
  }
  return { dist, cls, W, trig, combos };
}

/** Exact value of a climbing-multiplier feature per paid spin, in total bets (see the header). */
function climbingFeature(m, cls, W, base, upb) {
  const F = m.free;
  const C = [...cls].map(([k, [w, pw]]) => ({ p: w / W, win: k >= 1000 ? 1 : 0, aw: k % 1000, e: pw / w / upb }));
  for (const c of C) if (c.aw && !c.win) throw new Error(`${m.id}: a spin can award free spins without a win, so the climb is unbounded`);
  const ea = C.reduce((a, c) => a + c.p * c.aw, 0);
  if (ea >= 1) throw new Error(`${m.id}: retriggers never end (E[award] = ${ea})`);
  const memo = new Map();
  function V(l, k) {
    if (l <= 0) return 0;
    if (k >= F.maxMult) return F.maxMult * base * l / (1 - ea);
    const key = l * 1000 + k;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let v = 0;
    for (const c of C) v += c.p * (k * c.e + V(l - 1 + c.aw, k + F.climb * c.win));
    memo.set(key, v);
    return v;
  }
  let feature = 0, pTrig = 0;
  for (const c of C) if (c.aw) { feature += c.p * V(c.aw, F.mult); pTrig += c.p; }
  return { feature, perTrigger: feature / pTrig };
}

async function enumerate(m) {
  const R = m.reels;
  const upb = SLOTS.unitsPerBet(m);
  const { dist, cls, W, trig, combos } = await walkAll(m);
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
  let featureSpins = 0, feature = 0, perTrigger = 0;
  if (m.free && m.free.climb) {
    ({ feature, perTrigger } = climbingFeature(m, cls, W, base, upb));
  } else if (m.free) {
    const N = m.free.spins;
    if (p * N >= 1) throw new Error(`${m.id}: retriggers never end (p*N = ${p * N})`);
    featureSpins = N / (1 - p * N);
    feature = p * featureSpins * m.free.mult * base;
    perTrigger = featureSpins * m.free.mult * base;
  }
  return { combos, W, base, feature, perTrigger, rtp: base + feature, hit, p, featureSpins, sd, dist };
}

if (require.main !== module) { module.exports = { enumerate }; return; }

(async () => {
  const only = process.argv[2];
  const pct = (x, d = 4) => (100 * x).toFixed(d) + '%';
  const commas = (n) => Math.round(n).toLocaleString('en-US');
  let allOk = true;
  const out = { generated: new Date().toISOString(), machines: {} };
  const t0 = Date.now();
  console.log('Slot machines: exact enumeration of every reel-stop combination');

  for (const id of SLOTS.MACHINE_IDS) {
    if (only && id !== only) continue;
    const m = SLOTS.MACHINES[id];
    const t1 = Date.now();
    const r = await enumerate(m);
    console.log('\n' + '='.repeat(72));
    console.log(`  ${m.name}  (${m.kind}, ${m.reels.length}x${m.rows}, ${m.reels.map(x => x.total).join(' x ')} virtual stops)`);
    console.log('='.repeat(72));
    console.log(`  combinations        ${commas(r.combos)} (weighted total ${commas(r.W)})  in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    console.log(`  base game return    ${pct(r.base)}`);
    if (m.free) {
      console.log(`  feature chance      ${pct(r.p)}  (1 in ${(1 / r.p).toFixed(1)} paid spins)`);
      if (m.free.climb) console.log(`  feature             ${m.free.awards ? m.free.awards.filter(Boolean).join(' / ') : m.free.spins} spins, x${m.free.mult} climbing +${m.free.climb} per winning spin to x${m.free.maxMult}; worth ${r.perTrigger.toFixed(2)} total bets per trigger`);
      else console.log(`  spins per feature   ${r.featureSpins.toFixed(4)} expected (${m.free.spins} + retriggers), wins x${m.free.mult}`);
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
    let ok = true;
    for (const k of Object.keys(computed)) {
      const same = Math.abs(shown[k] - computed[k]) < 5e-7 * Math.max(1, Math.abs(computed[k]));
      if (!same) {
        ok = allOk = false;
        console.log(`  DISPLAYED ${k} ${shown[k]} vs exact ${computed[k].toFixed(8)} ... FAIL (update SLOTS.PAR.${id}.${k} in slots-core.js)`);
      }
    }
    if (ok) console.log('  displayed PAR figures match ... PASS');
    out.machines[id] = {
      name: m.name, kind: m.kind, combinations: r.combos, weightedTotal: r.W,
      rtp: r.rtp, baseReturn: r.base, featureReturn: r.feature, featureChance: r.p, featurePerTrigger: r.perTrigger,
      spinsPerFeature: r.featureSpins, hitFrequency: r.hit, sdBase: r.sd,
      suggestedPar: { rtp: +r.rtp.toFixed(8), hit: +r.hit.toFixed(8), feature: +r.p.toFixed(8), sd: +r.sd.toFixed(6) },
    };
  }

  if (!only) fs.writeFileSync('expected-slots.json', JSON.stringify(out, null, 2));
  console.log(`\n${allOk ? 'PASS' : 'FAIL'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
