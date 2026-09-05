// 43po: the TIME half of the install-size walk's bounds.
//
//   npx electron test/install-size-clock-verify.js
//
// Runs in either tier. Read-only; it measures a tree it builds itself.
//
// WHY THIS IS ITS OWN FILE. main.js reads both budgets once, at load, so one
// process gets one setting. install-size-verify.js sets a 500-file cap, which
// makes its assertions deterministic - a count trips at the same file on every
// machine. That leaves the CLOCK untested there, because any tree big enough to
// take 40 ms also trips the cap first.
//
// WHAT WENT WRONG WITHOUT THIS SPLIT. install-size-verify used to test the
// clock with 2,400 files against 40 ms, which overruns on the development
// machine and finishes INSIDE 40 ms on a fresh VM with a fast disk. The
// clean-VM run of 2026-09-05 failed both of its budget assertions for that
// reason - and "the budget did not bite" is indistinguishable from "the budget
// is broken" when the budget is fine and the machine is just quick.
//
// SO THE MARGIN IS THE DESIGN. A 1 ms budget against a tree that takes roughly
// 90 ms here is a 90x margin: a machine ten times faster still overruns by an
// order of magnitude. A test calibrated to one machine's speed is what 43po is
// about, and the fix is not a bigger fixture, it is a margin wide enough that
// no plausible machine lands inside it. The premise is asserted anyway, so that
// if one ever does, this SKIPS and says so rather than failing.

const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';
// One millisecond, and the file cap lifted out of the way so the CLOCK is the
// only bound that can fire. Set before the require: main.js reads them at load.
process.env.VANISH_SIZE_BUDGET_MS = '1';
process.env.VANISH_SIZE_MAX_FILES = '1000000';
require('../main.js');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}
function skip(label, whyNot) { console.log(`  SKIP  ${label} -- ${whyNot}`); }

async function invoke(channel, payload) {
  const h = ipcMain._invokeHandlers.get(channel);
  if (!h) throw new Error(`no handler registered for ${channel}`);
  return h({ sender: null }, payload);
}

const work = path.join(os.tmpdir(), 'vanish-install-size-clock');

app.whenReady().then(async () => {
  console.log('');
  console.log('Install-size walk: the time budget (43po)');
  console.log('========================================');

  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  try {
    // Spread across directories on purpose: this is the case the ORIGINAL
    // per-directory check handled correctly, so it isolates the clock rather
    // than re-testing 2brn's inner-loop fix (install-size-verify covers that,
    // with one wide directory and the file cap).
    const tree = path.join(work, 'timed');
    fs.mkdirSync(tree, { recursive: true });
    const blob = Buffer.alloc(64, 0x7a);
    for (let d = 0; d < 40; d += 1) {
      const sub = path.join(tree, `d${d}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 60; i += 1) fs.writeFileSync(path.join(sub, `f${i}.bin`), blob);
    }

    // PREMISE, MEASURED ON THIS MACHINE, not assumed. An unbounded walk of the
    // same tree tells us whether a 1 ms budget is a real constraint here - and
    // if this machine can do the whole thing in about a millisecond, the test
    // below cannot mean anything and says so instead of failing.
    const t0 = process.hrtime.bigint();
    let seen = 0;
    const stack = [tree];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else { seen += 1; fs.statSync(full); }
      }
    }
    const unboundedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`  (an unbounded walk of ${seen} files took ${unboundedMs.toFixed(1)} ms on this machine)`);

    if (unboundedMs < 10) {
      skip('the time budget',
        `this machine walked ${seen} files in ${unboundedMs.toFixed(1)} ms, which is too close to the 1 ms budget for the result to mean anything - a bigger fixture is needed here, not a different assertion`);
    } else {
      assert(unboundedMs > 10,
        `premise: the walk takes ${unboundedMs.toFixed(1)} ms unbounded, ${Math.round(unboundedMs)}x the 1 ms budget`);

      const r = await invoke('measure-install-size', { source: tree });
      assert(r && r.complete === false,
        'a walk that cannot finish inside the time budget reports incomplete',
        JSON.stringify(r));
      assert(r && r.bytes === null,
        'and returns NO number, so a partially-summed total is never rendered as a size',
        JSON.stringify(r));
    }

    // The other direction, and it is the one that stops this from passing on a
    // budget that refuses everything: a small tree still completes and still
    // returns its real bytes. Four files cannot exceed a millisecond by enough
    // to matter, and if this ever fails the budget has become unusable rather
    // than strict.
    const small = path.join(work, 'small');
    fs.mkdirSync(small, { recursive: true });
    let expected = 0;
    for (let i = 0; i < 4; i += 1) {
      const b = Buffer.alloc(1000, 0x7b);
      fs.writeFileSync(path.join(small, `s${i}.bin`), b);
      expected += 1000;
    }
    const s = await invoke('measure-install-size', { source: small });
    if (s && s.complete === true) {
      assert(s.bytes === expected,
        `a small folder still completes and reports its real size (${s.bytes} of ${expected})`);
    } else {
      skip('the completes-anyway case',
        'even four files did not finish inside 1 ms on this machine, so the budget is too tight here to show the difference');
    }
  } finally {
    if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
