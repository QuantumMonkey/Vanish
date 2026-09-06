// frr: a missing engine never shows raw PowerShell text, and offers a real
// recovery instead.
//
//   npx electron test/engine-missing-verify.js
//
// Runs in either tier: the guard runs before any spawn, so nothing here needs
// elevation and nothing here writes to the machine.
//
// WHY THIS SUITE HAD TO EXIST. frr was IMPLEMENTED on 2026-08-09 and sat
// in_progress for nine days on the note "needs a human to trigger the
// missing-engine path once, because it pops a real native dialog with no way to
// click it from a session". That is true of the dialog and NOT true of the
// behaviour: the dialog is one call, and replacing that one call makes the whole
// path testable. The observed bug was a user seeing a raw PowerShell
// parameter-binding error inside the Task Manager panel, and none of that
// depends on a human clicking anything.
//
// It renames scanner.ps1 to provoke the real condition rather than mocking
// fs.existsSync, and restores it in a finally AND on every exit path - a suite
// that could leave this repo without its engine would be worse than no suite.

const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const ENGINE = path.join(__dirname, '..', 'scanner.ps1');
const HIDDEN = path.join(__dirname, '..', 'scanner.ps1.frr-probe');

// The one call that needs replacing, patched BEFORE main.js is required so the
// module closes over the patched version. Records what the user would have been
// shown, and always answers "Not now" so nothing relaunches mid-test.
const shown = [];
dialog.showMessageBoxSync = (...args) => {
  shown.push(args[args.length - 1]);
  return 1; // "Not now"
};

function restoreEngine() {
  try {
    if (fs.existsSync(HIDDEN) && !fs.existsSync(ENGINE)) fs.renameSync(HIDDEN, ENGINE);
    else if (fs.existsSync(HIDDEN)) fs.unlinkSync(HIDDEN);
  } catch (err) {
    console.log(`  FAIL  COULD NOT RESTORE scanner.ps1: ${err.message}`);
    console.log(`        Rename ${HIDDEN} back to ${ENGINE} by hand.`);
  }
}
process.on('exit', restoreEngine);
process.on('uncaughtException', (e) => { restoreEngine(); throw e; });

require('../main.js');

let pass = 0;
let fail = 0;
let lastLabel = '(nothing yet)';

function assert(condition, label, detail = '') {
  lastLabel = label;
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  restoreEngine();
  console.log(`  FAIL  timed out. Last completed assertion: ${lastLabel}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

async function invoke(channel, payload) {
  const handler = ipcMain._invokeHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: null }, payload);
}

// Anything that looks like it came from a shell rather than from a person.
const RAW_SHELL_TEXT = [
  /powershell/i,
  /exited with code/i,
  /at line:\d+/i,
  /CategoryInfo/i,
  /FullyQualifiedErrorId/i,
  /ParameterBinding/i,
  /Cannot bind/i,
  /\+\s+~~~~/,
  /System\.Management\.Automation/i,
  /scanner\.ps1/i
];

function rawTextIn(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return RAW_SHELL_TEXT.filter((re) => re.test(s)).map((re) => re.source);
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Missing engine (frr)');
  console.log('====================');

  await new Promise((r) => setTimeout(r, 2000));

  assert(fs.existsSync(ENGINE), 'the engine is present before this suite touches anything');

  try {
    fs.renameSync(ENGINE, HIDDEN);
    assert(!fs.existsSync(ENGINE), 'the engine has been moved aside, provoking the real condition');

    // list-processes is the exact channel the operator saw raw text from: the
    // Task Manager panel renders its error string.
    const res = await invoke('list-processes', {});
    const asText = JSON.stringify(res);

    assert(res && res.success === false, 'the call fails rather than resolving with empty data that reads as an idle PC');

    const leaked = rawTextIn(res && res.error);
    assert(
      leaked.length === 0,
      'the error handed to the renderer contains no raw shell text',
      leaked.length ? `matched: ${leaked.join(', ')} in "${String(res && res.error).slice(0, 160)}"` : ''
    );

    const leakedAnywhere = rawTextIn(asText);
    assert(
      leakedAnywhere.length === 0,
      'and no other field in the payload smuggles it through either',
      leakedAnywhere.length ? `matched: ${leakedAnywhere.join(', ')}` : ''
    );

    assert(
      /restart/i.test(String((res && res.error) || '')),
      `the message tells the user what to DO, not just that something failed (got '${String((res && res.error) || '').slice(0, 90)}')`
    );

    // The recovery offer.
    assert(shown.length === 1, `the user is offered a restart exactly once (${shown.length} dialog(s))`);
    const box = shown[0] || {};
    assert(
      Array.isArray(box.buttons) && box.buttons.some((b) => /restart/i.test(b)),
      `and the dialog has a Restart button (${JSON.stringify(box.buttons)})`
    );
    const boxLeak = rawTextIn(`${box.message} ${box.detail} ${box.title}`);
    assert(
      boxLeak.length === 0,
      'the dialog itself carries no raw shell text or internal path',
      boxLeak.length ? `matched: ${boxLeak.join(', ')}` : ''
    );
    assert(
      /nothing on this PC is changed/i.test(String(box.detail || '')),
      'and it reassures the user nothing was changed, which is the actual question at that moment'
    );

    // Shown at most ONCE per session. Task Manager re-polls every couple of
    // seconds; a dismissal that re-armed this would pop the same modal forever.
    await invoke('list-processes', {});
    await invoke('list-processes', {});
    assert(
      shown.length === 1,
      `three failures still produce ONE dialog - a re-arming modal would be unusable in Task Manager (${shown.length})`
    );

    // Every later failure still gets the friendly text in its own panel.
    const again = await invoke('list-processes', {});
    assert(
      again && again.success === false && rawTextIn(again.error).length === 0,
      'and the later failures still return the friendly error rather than falling back to raw text'
    );

    // EVERY CHANNEL, not three of them.
    //
    // qkgu changed the CONTRACT of two of these without changing this
    // guarantee. get-startup-items used to catch and resolve with
    // { items: [], total: 0, orphans: 0, error } - a well-shaped success, which
    // is why the Health Advisor's "could not read" path was never reached and
    // its verdict counted a check that never ran. It rejects now. What must
    // still hold is the thing this loop is actually here for: whatever crosses
    // the boundary carries no raw shell text, whether it crosses as a value or
    // as a rejection.
    //
    // THIS USED TO COVER THREE OF SIXTY-FOUR. The property is security-relevant
    // - PowerShell error text carries internal paths, and a panel that renders
    // it hands the user something they cannot act on and should not see - and
    // it was spot-checked on the three channels somebody had happened to think
    // about. The channel census of 2026-09-06 counted 64 registrations.
    //
    // THE PARTITION IS ASSERTED, which is the part that keeps working. Every
    // registered channel must appear in exactly one of two places: invoked
    // below, or excluded with a REASON. A channel added next month lands in
    // neither and this suite fails - which is the only version of this that
    // does not quietly rot back to three.
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const registered = [...new Set(
      [...mainSrc.matchAll(/(?:ipcMain\.(?:handle|on)|fullModeOnly)\(\s*'([^']+)'/g)].map((m) => m[1])
    )];
    assert(registered.length > 50,
      `premise: the channel list was actually extracted from main.js (${registered.length} found)`);

    // Not invoked, and each says why. These do real work that does not route
    // through the engine, so removing the engine proves nothing about them and
    // calling them here would have side effects on the machine running the
    // suite rather than on a fixture.
    const EXCLUDED = {
      'browse-for-path': 'opens a modal file dialog and blocks until a human answers it',
      'relaunch-elevated': 'raises a real UAC prompt',
      'relaunch-deelevated': 'launches a second copy of the app',
      'window-minimize': 'window control, no engine and nothing to leak',
      'window-maximize': 'window control, no engine and nothing to leak',
      'window-close': 'would close the window this suite is running in',
      'open-vault-folder': 'opens Explorer on the operator machine',
      'open-data-folder': 'opens Explorer on the operator machine',
      'open-known-link': 'opens a Settings page; t4m9 covers what it will and will not accept',
      'network-ping': 'sends a packet when consent is set; wy7a covers its refusals',
      'network-speedtest': 'sends network traffic when consent is set'
    };

    const tested = registered.filter((c) => !EXCLUDED[c]);

    // A NEW CHANNEL IS TESTED BY DEFAULT, which is the safe direction and is
    // structural rather than asserted: `tested` is everything not named in
    // EXCLUDED, so adding a channel to main.js adds it to this loop with no
    // edit here.
    //
    // THE FIRST VERSION OF THIS ASSERTED "tested + excluded === registered",
    // WHICH IS A TAUTOLOGY - tested is DERIVED by filtering registered, so the
    // sum is always the total and the check could never fail. That is the same
    // shape as the mirror guard deleted in bcff, written in the same week, by
    // me. Recorded rather than quietly replaced, because the lesson is that a
    // guard whose subject is a value you just computed is not a guard.
    //
    // What can actually fail, and what each one catches:
    const staleExclusions = Object.keys(EXCLUDED).filter((c) => !registered.includes(c));
    assert(staleExclusions.length === 0,
      'every excluded channel still exists - an exclusion left behind for a deleted channel silently pre-approves the next channel to take that name',
      staleExclusions.join(', '));

    // THE EXCLUSION COUNT IS PINNED. Excluding a channel is how you make this
    // suite stop looking at it, so growing the list has to be a decision
    // somebody makes on purpose and writes a reason for - not a line added
    // while chasing a red test. Raise this number only after reading the new
    // reason and agreeing with it.
    assert(Object.keys(EXCLUDED).length === 11,
      `the exclusion list is the eleven reviewed on 2026-09-06 (${Object.keys(EXCLUDED).length} now)`,
      Object.keys(EXCLUDED).join(', '));

    // Non-vacuity: the filter must not have excluded the things this suite
    // exists for. Named channels rather than a count, so "53 tested" cannot be
    // 53 of the wrong ones.
    for (const must of ['list-processes', 'get-desktop-apps', 'cleaner-scan', 'vault-restore', 'set-settings']) {
      assert(tested.includes(must), `${must} is among the channels actually invoked`);
    }
    console.log(`  (${tested.length} channels invoked with the engine missing, ${Object.keys(EXCLUDED).length} excluded by name)`);

    const leaky = [];
    for (const channel of tested) {
      let crossed;
      try {
        crossed = JSON.stringify(await invoke(channel, {}));
      } catch (err) {
        crossed = String((err && err.message) || err);
      }
      const l = rawTextIn(crossed);
      if (l.length > 0) {
        leaky.push(`${channel}: matched ${l.join(', ')} in "${String(crossed).slice(0, 140)}"`);
      }
    }
    assert(leaky.length === 0,
      `no channel leaks raw shell text with the engine gone (${tested.length} checked)`,
      leaky.slice(0, 6).join('\n        '));

    // The three the operator actually saw, kept as named assertions rather than
    // folded into the count above: a loop that reports "0 of 33 leaked" is a
    // weaker thing to read than a line naming the channel that was reported.
    for (const channel of ['get-startup-items', 'get-listeners', 'find-broken-entries']) {
      let crossed;
      try {
        crossed = JSON.stringify(await invoke(channel, {}));
      } catch (err) {
        crossed = String((err && err.message) || err);
      }
      assert(/restart/i.test(crossed),
        `${channel} still tells the user what to DO, however it reports`,
        crossed.slice(0, 120));
    }
  } finally {
    restoreEngine();
  }

  assert(fs.existsSync(ENGINE), 'the engine is back where it belongs');
  assert(!fs.existsSync(HIDDEN), 'and the probe copy is gone');

  // The renderer half.
  //
  // NOT attempted by scanning for unescaped interpolations, after two regexes
  // that were wrong in opposite directions: one matched the whole innerHTML
  // statement and its greedy [^;]* ran past the esc() call, reporting two false
  // positives against code that escapes correctly; the tightened version then
  // flagged every error interpolation in the app, including plain toast()
  // strings that are not HTML sinks at all. Deciding whether a given
  // interpolation reaches innerHTML is a parsing job, not a regex one, and a
  // check that cries wolf is a check people delete.
  //
  // The guarantee that actually matters is already asserted above, at the IPC
  // boundary, and it is the stronger one: no raw shell text crosses into the
  // renderer AT ALL. A panel cannot render PowerShell text out of a string that
  // does not contain any, escaped or otherwise.
  //
  // What is worth pinning here is the one shared sink every panel routes
  // failures through, because if THAT stopped escaping, every panel would leak
  // at once.
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'core.js'), 'utf8');
  const toastFn = coreSrc.slice(coreSrc.indexOf('function toast('), coreSrc.indexOf('function toast(') + 700);
  assert(
    /esc\(message\)/.test(toastFn),
    'toast() escapes its message - it is the shared failure sink every panel uses'
  );
  assert(
    /function esc\(/.test(coreSrc) && /replace\(\/&\/g/.test(coreSrc),
    'and esc() is a real HTML escaper rather than a pass-through'
  );

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  restoreEngine();
  console.log('');
  console.log(`  FAIL  threw after "${lastLabel}": ${(err && err.message) || err}`);
  console.log(String((err && err.stack) || ''));
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  clearTimeout(watchdog);
  app.exit(1);
});
