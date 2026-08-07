// UI interaction regression suite.
//
// WHY THIS EXISTS: every other harness talks to the engine or the IPC layer and
// bypasses the DOM entirely. That let a real defect ship - the uninstall
// wizard's overlay is invisible but its active screen kept `pointer-events:
// all`, and sitting later in the DOM at the same z-index it covered every other
// dialog in the app. The buttons rendered perfectly and did nothing.
//
// So this suite does not check that a dialog is *visible*. It hit-tests the
// actual clickable target with document.elementFromPoint and asserts the top
// element at that coordinate IS the control the user is aiming at.
//
//   npx electron test/ui-interaction-verify.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    fail += 1;
  }
}

// Runs in the page: is `selector` the topmost element at its own centre?
const HIT_TEST = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { found: true, visible: false };
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const top = document.elementFromPoint(cx, cy);
  return {
    found: true,
    visible: true,
    hit: el === top || el.contains(top),
    blockedBy: (el === top || el.contains(top)) ? null :
      (top ? top.tagName + '#' + (top.id || '') + '.' + (typeof top.className === 'string' ? top.className : '') : 'nothing')
  };
}`;

async function hitTest(win, selector) {
  return win.webContents.executeJavaScript(`(${HIT_TEST})(${JSON.stringify(selector)})`);
}

async function assertClickable(win, selector, label) {
  const r = await hitTest(win, selector);
  if (!r.found) return assert(false, `${label} - element ${selector} not found`);
  if (!r.visible) return assert(false, `${label} - element has no box`);
  assert(r.hit, `${label}${r.hit ? '' : ` (blocked by ${r.blockedBy})`}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 3500));

  console.log('');
  console.log('Vanish UI interaction verification');
  console.log('==================================');

  // --- FLOW-01 elevation offer, the real first-launch state ---------------
  console.log('');
  console.log('FLOW-01 elevation offer (shown automatically on an unelevated start)');

  const overlayActive = await win.webContents.executeJavaScript(
    `document.getElementById('elevation-modal-overlay').classList.contains('active')`
  );
  assert(overlayActive === true, 'the offer appears by itself on an unelevated launch');
  await assertClickable(win, '#btn-elevate-now', 'the "Restart as administrator" button is actually clickable');
  await assertClickable(win, '#btn-stay-audit', 'the "Continue in Audit Mode" button is actually clickable');

  // Declining must dismiss it and hand the app back.
  await win.webContents.executeJavaScript(`document.getElementById('btn-stay-audit').click()`);
  await new Promise((r) => setTimeout(r, 600));
  const dismissed = await win.webContents.executeJavaScript(
    `!document.getElementById('elevation-modal-overlay').classList.contains('active')`
  );
  assert(dismissed, 'declining dismisses the dialog');
  await assertClickable(win, '.nav-item[data-tab="quarantine"]', 'the app is usable after declining (sidebar reachable)');
  await assertClickable(win, '#btn-banner-elevate', 'the banner elevate button is clickable in Audit Mode');

  // --- Application list renders every engine output shape -----------------
  // renderTable/loadApplications never see the DOM test, only the IPC/engine
  // ones. A scanner.ps1 comment explains why this matters: a REG_MULTI_SZ
  // DisplayName once arrived as a String[] and broke the whole renderer list.
  // That regression has engine-side coercion and engine-side coverage, but
  // nothing before this asserted the LIST SURVIVES it, on screen, in the DOM.
  console.log('');
  console.log('Application list renders real engine output shapes');

  // Odd shape: exactly what a REG_MULTI_SZ DisplayName looked like before
  // scanner.ps1 started coercing every display field to a string.
  await win.webContents.executeJavaScript(`
    window.__test.queueResponse('getDesktopApps', [{
      id: 'odd1', name: ['Weird App', 'Secondary Value'], publisher: null,
      version: undefined, installDate: null, sizeBytes: 0,
      installLocation: '', registryPath: 'HKLM:\\\\Software\\\\Weird', type: 'Desktop'
    }]);
    loadApplications();
    true;
  `);
  await new Promise((r) => setTimeout(r, 500));

  const oddShape = await win.webContents.executeJavaScript(`(() => {
    const rows = document.querySelectorAll('#apps-tbody .app-row');
    return { rowCount: rows.length };
  })()`);
  assert(oddShape.rowCount === 1, 'a String[]-shaped DisplayName still renders exactly one row');
  await assertClickable(win, '#apps-tbody .app-row', 'the odd-shaped row is clickable, not just present');

  // Error: getDesktopApps rejects, exactly as it does when the engine process
  // fails to launch or its JSON does not parse.
  await win.webContents.executeJavaScript(`
    window.__test.queueResponse('getDesktopApps', { __reject: 'engine did not respond' });
    loadApplications();
    true;
  `);
  await new Promise((r) => setTimeout(r, 500));

  const errorShape = await win.webContents.executeJavaScript(`(() => {
    const cell = document.querySelector('#apps-tbody td');
    return { text: cell ? cell.textContent : null };
  })()`);
  assert(
    (errorShape.text || '').includes('engine did not respond'),
    'a rejected getDesktopApps shows the real error, not a blank table'
  );

  // Empty: the engine ran and genuinely found nothing.
  await win.webContents.executeJavaScript(`
    window.__test.queueResponse('getDesktopApps', []);
    loadApplications();
    true;
  `);
  await new Promise((r) => setTimeout(r, 500));

  const emptyShape = await win.webContents.executeJavaScript(`(() => {
    const cell = document.querySelector('#apps-tbody td');
    return { text: cell ? cell.textContent : null, rows: document.querySelectorAll('#apps-tbody .app-row').length };
  })()`);
  assert(emptyShape.rows === 0, 'an empty list renders no app rows');
  // Assert the CONTRACT, not the wording. Pinning the exact sentence made this
  // fail the moment the copy was rewritten to read less like a debug string,
  // which is a test defending prose rather than behaviour. What matters is that
  // an empty table says something a person can read.
  assert(
    /\bno\b.*\b(program|application|match)/i.test(emptyShape.text || ''),
    'an empty list explains itself rather than showing a blank table'
  );

  // Restore the real fixture data so every later section in this file (which
  // was written against it) still finds "Test Application".
  await win.webContents.executeJavaScript(`loadApplications(); true;`);
  await new Promise((r) => setTimeout(r, 500));
  await assertClickable(win, '#apps-tbody .app-row', 'the normal app list is back for the rest of this suite');

  // --- Filter status: an active search must never be invisible ------------
  // Found running the real app 2026-08-05: typing into the search box while
  // the initial (10+ second, real machine) load was still in flight left a
  // silent filter active once it finished - "only 2 of 163 apps" with
  // nothing on screen explaining why. This is the fix, not the load-time
  // race itself: whatever narrows the list must always say so.
  console.log('');
  console.log('Filter status: an active filter is always visible, never silent');

  const defaultStatus = await win.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('filter-status-text').textContent,
    filtered: document.getElementById('filter-status-row').classList.contains('filtered'),
    clearVisible: document.getElementById('btn-clear-filters').style.display !== 'none'
  }))()`);
  assert(defaultStatus.text.includes('Showing all'), 'unfiltered state says "showing all", not a bare count');
  assert(defaultStatus.filtered === false, 'unfiltered state carries no "filtered" styling');
  assert(defaultStatus.clearVisible === false, 'no Clear button when nothing is filtered');

  await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('search-bar');
    el.value = 'nothing matches this';
    el.dispatchEvent(new Event('input'));
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  const filteredStatus = await win.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('filter-status-text').textContent,
    filtered: document.getElementById('filter-status-row').classList.contains('filtered'),
    clearVisible: document.getElementById('btn-clear-filters').style.display !== 'none'
  }))()`);
  assert(filteredStatus.text.includes('Showing 0 of'), 'a narrowing search says exactly how narrow, and out of how many');
  assert(filteredStatus.filtered === true, 'a filtered state is visually marked');
  assert(filteredStatus.clearVisible === true, 'Clear button appears once something is filtered');

  await assertClickable(win, '#btn-clear-filters', 'the Clear filter button is actually clickable');
  await win.webContents.executeJavaScript(`document.getElementById('btn-clear-filters').click()`);
  await new Promise((r) => setTimeout(r, 200));

  const clearedStatus = await win.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('filter-status-text').textContent,
    searchValue: document.getElementById('search-bar').value,
    rows: document.querySelectorAll('#apps-tbody .app-row').length
  }))()`);
  assert(clearedStatus.searchValue === '', 'Clear filter empties the search box, not just internal state');
  assert(clearedStatus.text.includes('Showing all'), 'status returns to "showing all" after clearing');
  assert(clearedStatus.rows === 1, 'the app list itself reappears after clearing');

  // --- An invisible overlay must never capture clicks ---------------------
  console.log('');
  console.log('Hidden overlays do not swallow clicks (the defect this suite exists for)');

  const hiddenState = await win.webContents.executeJavaScript(`(() => {
    const ids = ['wizard-modal-overlay','elevation-modal-overlay','unlock-modal-overlay','confirm-modal-overlay'];
    return ids.map((id) => {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      return { id, active: el.classList.contains('active'), visibility: cs.visibility, pointerEvents: cs.pointerEvents };
    });
  })()`);

  for (const o of hiddenState) {
    if (o.active) continue;
    assert(o.visibility === 'hidden', `${o.id} is visibility:hidden while inactive`);
  }

  const wizardScreenBlocks = await hitTest(win, '#scr-config .scan-modes-box');
  assert(
    wizardScreenBlocks.visible === false || wizardScreenBlocks.hit === false,
    'the inactive wizard screen is not hit-testable'
  );

  // --- confirmDialog, raised from the Quarantine tab ----------------------
  console.log('');
  console.log('Confirmation dialogs are reachable (Delete Forever double-confirm)');

  await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-tab="quarantine"]').click()`);
  await new Promise((r) => setTimeout(r, 1200));
  await assertClickable(win, '#vault-entries .vault-entry-header', 'a vault entry row is clickable');

  // Raise the confirm dialog directly - the same call every destructive path makes.
  win.webContents.executeJavaScript(
    `confirmDialog({ title: 'T', body: 'B', confirmLabel: 'Yes' }); true;`
  );
  await new Promise((r) => setTimeout(r, 600));
  await assertClickable(win, '#btn-confirm-ok', 'the confirm button is clickable, not covered by the wizard');
  await assertClickable(win, '#btn-confirm-cancel', 'the cancel button is clickable');

  await win.webContents.executeJavaScript(`document.getElementById('btn-confirm-cancel').click()`);
  await new Promise((r) => setTimeout(r, 500));

  // Typed double-confirm: OK must be inert until the word is typed.
  win.webContents.executeJavaScript(
    `confirmDialog({ title: 'T', body: 'B', confirmLabel: 'Delete', typed: 'DELETE' }); true;`
  );
  await new Promise((r) => setTimeout(r, 600));
  const typedGate = await win.webContents.executeJavaScript(`(() => {
    const ok = document.getElementById('btn-confirm-ok');
    const input = document.getElementById('confirm-typed-input');
    const before = ok.disabled;
    input.value = 'DELETE';
    input.dispatchEvent(new Event('input'));
    return { before, after: ok.disabled };
  })()`);
  assert(typedGate.before === true, 'a typed double-confirm starts disabled');
  assert(typedGate.after === false, 'it enables only once the word is typed');
  await assertClickable(win, '#confirm-typed-input', 'the typed-confirm input is reachable');
  await win.webContents.executeJavaScript(`document.getElementById('btn-confirm-cancel').click()`);
  await new Promise((r) => setTimeout(r, 400));

  // --- SEC-1 untrusted-uninstaller acknowledgement ------------------------
  // The engine refuses an uninstaller registered under HKCU (or living
  // somewhere a standard user can write) until the operator names it. That
  // refusal surfaces as a typed dialog on the ELEVATED uninstall path - the
  // exact class of control this suite exists to protect, and it shipped this
  // morning with no UI coverage at all.
  console.log('');
  console.log('SEC-1 untrusted-uninstaller acknowledgement dialog');

  await win.webContents.executeJavaScript(`
    window.__test.setNextUninstallResponse({
      success: false,
      blocked: true,
      trust: { risky: true, reasons: ['registered under HKCU, which any standard user can write'] }
    });
    runNativeUninstaller({ type: 'Desktop', name: 'Planted App', registryPath: 'HKCU:\\\\Software\\\\Planted' });
    true;
  `);
  await new Promise((r) => setTimeout(r, 800));

  const ackDialog = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const body = document.getElementById('confirm-body');
    const ok = document.getElementById('btn-confirm-ok');
    return {
      active: overlay.classList.contains('active'),
      namesTheApp: (body.textContent || '').includes('Planted App'),
      givesTheReason: (body.textContent || '').includes('HKCU'),
      startsDisabled: ok.disabled
    };
  })()`);

  assert(ackDialog.active === true, 'a blocked uninstall raises the acknowledgement dialog');
  assert(ackDialog.namesTheApp === true, 'the dialog names the application being run');
  assert(ackDialog.givesTheReason === true, 'the dialog states WHY the uninstaller is untrusted');
  assert(ackDialog.startsDisabled === true, 'the confirm button starts inert - this is a typed gate');

  await assertClickable(win, '#confirm-typed-input', 'the RUN input is actually reachable, not covered');
  await assertClickable(win, '#btn-confirm-cancel', 'the operator can always decline');

  // The gate's real contract (renderer.js confirmDialog): trimmed and
  // case-INSENSITIVE. That is deliberate - the point is a deliberate act, not a
  // password - so pin it rather than leaving it to be discovered.
  const ackTyped = await win.webContents.executeJavaScript(`(() => {
    const ok = document.getElementById('btn-confirm-ok');
    const input = document.getElementById('confirm-typed-input');
    const attempt = (value) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      return ok.disabled;
    };
    return {
      wrongWord: attempt('YES'),
      partial:   attempt('RU'),
      empty:     attempt(''),
      lower:     attempt('run'),
      padded:    attempt('  RUN  '),
      exact:     attempt('RUN')
    };
  })()`);
  assert(ackTyped.wrongWord === true, 'the gate stays shut on a different word');
  assert(ackTyped.partial === true, 'the gate stays shut on a partial word');
  assert(ackTyped.empty === true, 'the gate stays shut on an empty box');
  assert(ackTyped.lower === false, 'lowercase is accepted (deliberate: a deliberate act, not a password)');
  assert(ackTyped.padded === false, 'surrounding whitespace is trimmed');
  assert(ackTyped.exact === false, 'the exact word opens it');
  await assertClickable(win, '#btn-confirm-ok', 'the acknowledge button is clickable once unlocked');

  await win.webContents.executeJavaScript(`document.getElementById('btn-confirm-cancel').click()`);
  await new Promise((r) => setTimeout(r, 400));

  // --- Startup elevation toggle --------------------------------------------
  // Deliberately usable in Audit Mode, unlike autoPurge below - the person who
  // wants "start elevated next time" is, by definition, usually not elevated
  // right now (operator request 2026-08-03). Verify it is reachable exactly in
  // the tier where it matters, and that it round-trips through setSettings.
  console.log('');
  console.log('Settings - startup elevation toggle');
  await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-tab="settings"]').click()`);
  await new Promise((r) => setTimeout(r, 700));
  // #set-startup-elevated is the same zero-size-input-behind-a-slider pattern
  // as the wizard's restore-point toggle - hit-test the slider a user clicks.
  await assertClickable(
    win,
    '.settings-row-controls .toggle-switch:has(#set-startup-elevated) .slider',
    'the startup-elevation toggle slider is clickable in Audit Mode'
  );

  const startupToggle = await win.webContents.executeJavaScript(`(async () => {
    const box = document.getElementById('set-startup-elevated');
    const before = box.checked;
    document.querySelector('.settings-row-controls .toggle-switch:has(#set-startup-elevated) .slider').click();
    await new Promise((r) => setTimeout(r, 400));
    return { before, afterClick: box.checked };
  })()`);
  assert(startupToggle.before === false, 'it starts unchecked (startupMode defaults to "audit")');
  assert(startupToggle.afterClick === true, 'clicking the visible slider actually flips the underlying checkbox');

  // --- Unlocker dialog ----------------------------------------------------
  console.log('');
  console.log('Unlocker dialog');
  await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-tab="task-manager"]').click()`);
  await new Promise((r) => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`document.getElementById('btn-open-unlocker').click()`);
  await new Promise((r) => setTimeout(r, 600));
  await assertClickable(win, '#unlock-path-input', 'the unlocker path input is reachable');
  await assertClickable(win, '#btn-find-lockers', 'the "Find holders" button is clickable');
  await win.webContents.executeJavaScript(`document.getElementById('unlock-close-x').click()`);
  await new Promise((r) => setTimeout(r, 400));

  // --- Every tab reachable, and the destructive lock is honest ------------
  console.log('');
  console.log('Navigation and Audit Mode locking');
  for (const tab of ['all-apps', 'audit', 'task-manager', 'system-clean', 'quarantine', 'force-uninstall', 'settings', 'about']) {
    await assertClickable(win, `.nav-item[data-tab="${tab}"]`, `the ${tab} tab is clickable`);
  }

  const locked = await win.webContents.executeJavaScript(`(() => {
    const all = Array.from(document.querySelectorAll('[data-destructive="true"]'));
    return {
      total: all.length,
      locked: all.filter((e) => e.classList.contains('tier-locked')).length,
      // Same reasoning as the empty-list check above: what the tooltip must do
      // is name WHY the control is inert. "Full Mode" was internal vocabulary
      // that the copy pass correctly replaced with "administrator rights".
      titled: all.filter((e) => /administrator|full mode/i.test(e.title || '')).length
    };
  })()`);
  assert(locked.total > 0, `${locked.total} destructive controls are marked`);
  assert(locked.locked === locked.total, 'every destructive control is locked in Audit Mode');
  assert(locked.titled === locked.total, 'every locked control explains why in its tooltip');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail > 0 ? 1 : 0);
});
