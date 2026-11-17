#!/usr/bin/env node
/*
 * Copy the shared game code into supabase/functions/_shared/.
 *
 * Edge Functions are deployed from supabase/functions/ and can't import files
 * from the repo root, so the server needs its own copies of the same files the
 * page loads. Copies that drift would bring back the eval3() problem
 * (CLAUDE.md): the server would deal a different game than the one the
 * harnesses verify. So the copies are byte-identical, never edited by hand,
 * and checked:
 *
 *   node sync-shared.js           # copy root files -> _shared/
 *   node sync-shared.js --check   # exit 1 if any copy differs or is missing
 *
 * Edit the ROOT files, then run this. Never edit files in _shared/.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = ['blackjack-core.js', 'tcp-core.js', 'slots-core.js', 'jackpot.js', 'roulette-core.js', 'tables.js', 'economy.js'];
const ROOT = __dirname;
const DEST = path.join(ROOT, 'supabase', 'functions', '_shared');

const check = process.argv.includes('--check');
let bad = 0;

if (!check) fs.mkdirSync(DEST, { recursive: true });

for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f));
  const dst = path.join(DEST, f);
  if (check) {
    let cur = null;
    try { cur = fs.readFileSync(dst); } catch (_) { /* missing */ }
    if (cur === null) { console.log('MISSING  ' + f); bad++; }
    else if (!cur.equals(src)) { console.log('DRIFT    ' + f + '  (run: node sync-shared.js)'); bad++; }
    else console.log('ok       ' + f);
  } else {
    fs.writeFileSync(dst, src);
    console.log('copied   ' + f);
  }
}

if (bad) {
  console.log('\nFAIL: _shared/ does not match the root files. The server would deal a different game.');
  process.exit(1);
}
if (check) console.log('\nPASS: _shared/ is byte-identical to the root files.');
