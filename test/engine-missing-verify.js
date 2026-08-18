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

    // Other panels take the same path, not just the one that was reported.
    for (const channel of ['get-startup-items', 'get-listeners', 'find-broken-entries']) {
      const r = await invoke(channel, {});
      const l = rawTextIn(JSON.stringify(r));
      assert(l.length === 0, `${channel} leaks no raw shell text either`, l.join(', '));
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
