// zl4: Clean All - one aggregate confirmation, and a typed gate when anything
// selected is Advanced risk.
//
//   VANISH_STUB_TIER=full npx electron test/clean-all-verify.js
//
// Runs in EITHER tier: the stub preload reports Full Mode via VANISH_STUB_TIER,
// which is what makes this testable at all. The real Clean All is gated on
// guardFullMode() in the renderer AND on fullModeOnly('cleaner-purge') in
// main.js, and the backend gate is proved elsewhere (phase4-ipc-verify) - so
// nothing here needs to actually delete anything on the machine running it.
//
// WHAT THIS DEFENDS. Clean All is the one control in the app that can act on
// several sections at once, which makes two failures possible that no
// per-section button can have:
//
//   1. A confirmation PER SECTION. Six dialogs in a row is how a user learns to
//      click through them without reading, which turns the last one - the
//      Advanced-risk one - into a reflex.
//   2. Advanced-risk items riding along inside a bulk action. The per-section
//      flow makes you look at a risky item; a bulk action must not be the way
//      around that.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

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

const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
  console.log(`  FAIL  timed out. Last completed assertion: ${lastLabel}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

app.whenReady().then(async () => {
  console.log('');
  console.log('Clean All (zl4)');
  console.log('===============');

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const js = (src) => win.webContents.executeJavaScript(src);

  const tier = await js(`(() => ({ isAdmin: isAdmin, tier: tierState.tier }))()`);
  assert(tier.isAdmin === true, `the stub reports Full Mode, so the control is live (tier '${tier.tier}')`);

  // Seed three scanned sections plus one that is list-only, and count every
  // confirmDialog call so "one aggregate confirmation" is measured rather than
  // assumed.
  const seed = `(() => {
    window.__dialogs = [];
    window.__origConfirm = window.__origConfirm || confirmDialog;
    confirmDialog = (opts) => {
      window.__dialogs.push({ title: opts.title, body: opts.body, typed: opts.typed || null });
      return Promise.resolve(window.__dialogAnswer);
    };

    const set = (id, findings) => {
      cleanerState[id].scanned = true;
      cleanerState[id].findings = findings;
      cleanerState[id].loading = false;
      cleanerState[id].error = null;
    };

    Object.keys(cleanerState).forEach((k) => {
      cleanerState[k].scanned = false;
      cleanerState[k].findings = [];
    });

    set('context-menus', [
      { id: 'cm1', label: 'DeadHandler', evidence: 'exe missing', risk: 'Safe', kind: 'registry', registryPath: 'HKCU:\\\\a', removable: true },
      { id: 'cm2', label: 'DeadHandler2', evidence: 'exe missing', risk: 'Moderate', kind: 'registry', registryPath: 'HKCU:\\\\b', removable: true }
    ]);
    set('associations', [
      { id: 'as1', label: '.foo', evidence: 'points at nothing', risk: 'Safe', kind: 'registry', registryPath: 'HKCU:\\\\c', removable: true }
    ]);
    // Every finding here is list-only, so this section must be skipped entirely
    // rather than sent as an empty purge.
    set('drivers', [
      { id: 'dv1', label: 'oem12.inf', evidence: 'INF missing', risk: 'Advanced', kind: 'driver', removable: false }
    ]);
    return true;
  })()`;
  await js(seed);

  // ---- the happy path: one dialog, no typed gate ------------------------
  const noRisk = await js(`(async () => {
    window.__dialogAnswer = true;
    window.__dialogs = [];
    window.__test.resetCallCounts();
    await cleanAllCleaners();
    return {
      dialogs: window.__dialogs.length,
      typed: window.__dialogs.map((d) => d.typed),
      title: (window.__dialogs[0] || {}).title || '',
      body: (window.__dialogs[0] || {}).body || '',
      purges: window.__test.callCount('cleanerPurge')
    };
  })()`);

  assert(noRisk.dialogs === 1, `ONE confirmation for the whole action, not one per section (got ${noRisk.dialogs})`);
  assert(
    noRisk.typed.every((t) => t === null),
    'with nothing Advanced selected there is no typed gate - a gate on every bulk action is a gate nobody reads'
  );
  assert(
    /2 section/.test(noRisk.title) && /3 item/.test(noRisk.title),
    `the dialog counts items AND sections up front (got '${noRisk.title}')`
  );
  assert(
    /Right-click menu entries: 2/.test(noRisk.body) && /File associations and protocols: 1/.test(noRisk.body),
    'and breaks the total down per section, so "clean all" is never an unnamed quantity'
  );
  assert(
    /Quarantine/i.test(noRisk.body) && /put back/i.test(noRisk.body),
    'the dialog states that everything goes to Quarantine first and can be put back'
  );
  assert(noRisk.purges === 2, `only the two sections with removable findings were purged (got ${noRisk.purges})`);

  // ---- the list-only section must never be sent -------------------------
  const sentCleaners = await js(`(() => window.__test.callArgs('cleanerPurge').map((a) => a[0] && a[0].cleaner))()`);
  assert(
    !sentCleaners.includes('drivers'),
    'the section whose only finding is list-only was skipped, not sent as an empty purge'
  );

  // ---- Advanced risk forces the typed gate ------------------------------
  const risky = await js(`(async () => {
    cleanerState['context-menus'].scanned = true;
    cleanerState['context-menus'].findings = [
      { id: 'cm1', label: 'DeadHandler', evidence: 'exe missing', risk: 'Safe', kind: 'registry', registryPath: 'HKCU:\\\\a', removable: true },
      { id: 'cm9', label: 'RiskyShellExt', evidence: 'belongs to installed software', risk: 'Advanced', kind: 'registry', registryPath: 'HKCU:\\\\z', removable: true }
    ];
    window.__dialogAnswer = true;
    window.__dialogs = [];
    await cleanAllCleaners();
    const d = window.__dialogs[0] || {};
    return { dialogs: window.__dialogs.length, typed: d.typed || null, body: d.body || '' };
  })()`);

  assert(risky.dialogs === 1, 'still one dialog when an Advanced-risk item is present');
  assert(risky.typed === 'CLEAN', `and it requires typing CLEAN (got '${risky.typed}')`);
  assert(
    /Advanced risk/i.test(risky.body),
    'the dialog says the words "Advanced risk" rather than only raising a gate'
  );
  assert(
    /RiskyShellExt/.test(risky.body),
    'and NAMES the risky items, so the gate is informed rather than merely obstructive'
  );
  assert(
    /still installed/i.test(risky.body),
    'and says what Advanced risk actually means - it can affect software still on the PC'
  );

  // ---- cancelling changes nothing ---------------------------------------
  const cancelled = await js(`(async () => {
    window.__dialogAnswer = false;
    window.__dialogs = [];
    window.__test.resetCallCounts();
    const before = cleanerState['context-menus'].findings.length;
    await cleanAllCleaners();
    return {
      purges: window.__test.callCount('cleanerPurge'),
      findingsUnchanged: cleanerState['context-menus'].findings.length === before
    };
  })()`);

  assert(cancelled.purges === 0, `declining the confirmation purges nothing (${cancelled.purges} calls)`);
  assert(cancelled.findingsUnchanged, 'and leaves every section exactly as it was');

  // ---- nothing scanned yet ----------------------------------------------
  const nothing = await js(`(async () => {
    Object.keys(cleanerState).forEach((k) => { cleanerState[k].scanned = false; cleanerState[k].findings = []; });
    window.__dialogs = [];
    window.__test.resetCallCounts();
    await cleanAllCleaners();
    return { dialogs: window.__dialogs.length, purges: window.__test.callCount('cleanerPurge') };
  })()`);

  assert(
    nothing.dialogs === 0 && nothing.purges === 0,
    'with nothing scanned it asks nothing and does nothing, rather than confirming an empty action'
  );

  // ---- the control is tier-locked in the markup -------------------------
  const locked = await js(`(() => {
    const btn = document.getElementById('btn-clean-all-cleaners');
    return { exists: !!btn, destructive: btn && btn.getAttribute('data-destructive') === 'true' };
  })()`);
  assert(locked.exists, 'the Clean All control exists');
  assert(
    locked.destructive,
    'and carries data-destructive, so it tier-locks in Audit Mode exactly like every other destructive control'
  );

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.log('');
  console.log(`  FAIL  threw after "${lastLabel}": ${(err && err.message) || err}`);
  console.log(String((err && err.stack) || ''));
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  clearTimeout(watchdog);
  app.exit(1);
});
