/*
 * Sound effects: presentation only.
 *
 * Every sound is synthesized with the Web Audio API (oscillators and
 * filtered noise), so there are no audio files and index.html still opens
 * from file://. Quiet by design (master volume 0.2). The on/off choice is a
 * per-browser preference in localStorage. Nothing here knows a result: the
 * page asks for a sound by name after a result is already decided.
 *
 * Browsers only allow audio after a user gesture; the context is created on
 * the first sound, which always follows a click. With no Web Audio (Node
 * harnesses, old browsers) every call is a no-op.
 */
(function (root) {
  'use strict';
  const KEY = 'casino.sound.v1';
  let ctx = null, master = null, noiseBuf = null;
  let on = (() => { try { return root.localStorage ? root.localStorage.getItem(KEY) !== 'off' : true; } catch (e) { return true; } })();

  function audio() {
    if (!on) return null;
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      master = ctx.createGain();
      master.gain.value = 0.2;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;   // white noise for clicks and shuffles (not game randomness)
    }
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    return ctx;
  }

  function env(g, t, vol, attack, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function tone(t, freq, dur, o) {
    o = o || {};
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t + dur);
    env(g, t, o.vol || 0.4, o.attack || 0.005, dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  function noise(t, dur, o) {
    o = o || {};
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = o.filter || 'bandpass';
    f.frequency.value = o.freq || 2000;
    f.Q.value = o.q || 1;
    env(g, t, o.vol || 0.3, o.attack || 0.002, dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }
  const notes = (t, freqs, step, dur, o) => freqs.forEach((f, i) => tone(t + i * step, f, dur, o));

  const SOUNDS = {
    chip:  (t) => { noise(t, 0.045, { freq: 3200, q: 3, vol: 0.35 }); tone(t, 2600, 0.04, { type: 'triangle', vol: 0.12 }); },
    card:  (t) => noise(t, 0.08, { freq: 1600, q: 0.7, vol: 0.22 }),
    flip:  (t) => noise(t, 0.05, { freq: 2600, q: 1.2, vol: 0.16 }),
    // Reels: a soft mechanical whir for `ms`, then each reel's thunk.
    spin:  (t, ms) => {
      const end = t + (ms || 1000) / 1000;
      for (let x = t; x < end - 0.05; x += 0.065) noise(x, 0.03, { freq: 900 + 300 * Math.sin(x * 9), q: 2, vol: 0.06 });
    },
    reelStop: (t) => { tone(t, 150, 0.12, { vol: 0.45, glide: 70 }); noise(t, 0.04, { freq: 700, q: 1, vol: 0.25 }); },
    tease: (t) => tone(t, 220, 0.6, { type: 'sawtooth', vol: 0.05, glide: 440, attack: 0.1 }),
    coin:  (t) => tone(t, 1500 + Math.random() * 500, 0.05, { type: 'triangle', vol: 0.08 }),
    // Wins, by size: 1 small, 2 medium, 3 large.
    win:   (t, level) => {
      const seq = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568];
      notes(t, seq.slice(0, 2 + 2 * Math.min(level || 1, 2)), 0.07, 0.18, { type: 'triangle', vol: 0.22 });
    },
    bigWin: (t) => {
      notes(t, [523.25, 659.25, 783.99, 1046.5], 0.09, 0.3, { type: 'square', vol: 0.07 });
      notes(t + 0.38, [783.99, 1046.5, 1318.5, 1568, 2093], 0.06, 0.4, { type: 'triangle', vol: 0.2 });
      for (let i = 0; i < 14; i++) tone(t + 0.7 + i * 0.07, 1800 + Math.random() * 1400, 0.08, { type: 'triangle', vol: 0.07 });
    },
    feature: (t) => {
      tone(t, 300, 0.7, { type: 'sawtooth', vol: 0.05, glide: 1200, attack: 0.05 });
      notes(t + 0.6, [1046.5, 1318.5, 1568, 2093], 0.08, 0.35, { type: 'triangle', vol: 0.2 });
    },
    jackpot: (t) => {
      // bells: a bright ring repeated, over a rising chord
      for (let k = 0; k < 6; k++) {
        const b = t + k * 0.32;
        tone(b, 1318.5, 0.6, { vol: 0.16 }); tone(b, 1975.5, 0.5, { vol: 0.09 }); tone(b + 0.16, 1568, 0.5, { vol: 0.14 });
      }
      notes(t, [261.63, 329.63, 392, 523.25], 0.22, 1.6, { type: 'triangle', vol: 0.1, attack: 0.08 });
    },
    // Another player's jackpot on the floor: a short, distant chime.
    floor: (t) => notes(t, [1318.5, 1568, 2093], 0.12, 0.35, { vol: 0.07 }),
  };

  /** Play sound `name` in `delayMs` (arg: extra detail, e.g. win level). */
  function play(name, delayMs, arg) {
    const f = SOUNDS[name];
    if (!f || !audio()) return;
    try { f(ctx.currentTime + Math.max(0, delayMs || 0) / 1000, arg); } catch (e) { /* audio is decoration */ }
  }
  function setOn(v) {
    on = !!v;
    try { if (root.localStorage) root.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* preference not saved */ }
    if (!on && ctx && ctx.suspend) ctx.suspend();
  }

  const SFX = { play, setOn, isOn: () => on, names: Object.keys(SOUNDS) };
  if (typeof module === 'object' && module.exports) module.exports = SFX;
  else root.SFX = SFX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
