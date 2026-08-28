// UI interaction regression suite - Full Mode (bd vanish-uninstaller-7y0).
//
// The Audit Mode suite (test/ui-interaction-verify.js) cannot reach these
// flows: every one of them is wrapped in guardFullMode() and its trigger
// button is tier-locked with pointer-events:none until the app is elevated.
// This file loads the same real index.html with the same hit-testing
// technique, but with the fixture's VANISH_STUB_TIER=full so the actual
// click path - not a direct function call bypassing the tier guard - is what
// gets exercised.
//
// Covers the flows raised by the operator as untested: the uninstall wizard
// end to end, the leftovers tree (select-all and per-item toggles), the
// Quarantine Manager restore (including the conflict/overwrite branch) and
// Delete Forever double-confirm, the bulk queue panel and its
// risky-uninstaller acknowledgement, and System Clean scan-to-purge.
//
//   set VANISH_STUB_TIER=full && npx electron test/ui-interaction-full-verify.js

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

async function click(win, selector) {
  await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`
  );
}

async function queueResponse(win, method, value) {
  await win.webContents.executeJavaScript(
    `window.__test.queueResponse(${JSON.stringify(method)}, ${JSON.stringify(value)}); true;`
  );
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// sampleProcesses() no-ops if a refresh is already in flight (its own
// re-entrancy guard), so a fixed wait() after queuing a response can
// legitimately race the task-manager tab's automatic first sample. Poll for
// the expected row instead of assuming a timing window.
async function waitForSelector(win, selector, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await win.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (found) return true;
    await wait(100);
  }
  return false;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true
    },
    // Matched by the fixture reading process.env.VANISH_STUB_TIER, set by the
    // launcher below - the preload runs in this process's env, not the page's.
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3500);

  console.log('');
  console.log('Vanish UI interaction verification - Full Mode');
  console.log('===============================================');

  const tier = await win.webContents.executeJavaScript(`document.getElementById('admin-indicator') ? true : true`);
  const isFullModeConfirmed = await win.webContents.executeJavaScript(`
    (async () => (await window.api.checkAdmin()) === true)()
  `);
  assert(isFullModeConfirmed === true, 'the fixture actually launched Full Mode (VANISH_STUB_TIER=full)');
  if (!isFullModeConfirmed) {
    console.log('');
    console.log('Aborting: without Full Mode every guardFullMode() check below refuses immediately.');
    console.log(`Result: ${pass} passed, ${fail} failed`);
    app.exit(1);
    return;
  }

  // No elevation offer to dismiss in Full Mode; confirm the app is usable from
  // the first frame, same as a real elevated launch.
  await assertClickable(win, '.nav-item[data-tab="all-apps"]', 'the sidebar is reachable on an elevated launch');

  // Health Advisor is the landing page as of 0.9.0, so the apps table starts
  // hidden. Every hit test below is about what an elevated session can DO with
  // that table, not about which tab opens first - so get there, then assert.
  // Without this they all fail with "element has no box", which is a true
  // answer to a question this suite is not asking.
  await win.webContents.executeJavaScript(
    `(() => { document.querySelector('.nav-item[data-tab="all-apps"]').click(); return true; })()`
  );
  await new Promise((r) => setTimeout(r, 600));

  await assertClickable(win, '#apps-tbody .app-row', 'the fixture app row is clickable');

  // ==========================================================================
  // Uninstall wizard, end to end
  // ==========================================================================
  console.log('');
  console.log('Uninstall wizard end to end');

  await click(win, '#apps-tbody .app-row');
  await wait(300);
  await assertClickable(win, '#btn-start-uninstall', 'Start Uninstall is unlocked and clickable in Full Mode');
  await click(win, '#btn-start-uninstall');
  await wait(500);

  const wizardOpen = await win.webContents.executeJavaScript(
    `document.getElementById('wizard-modal-overlay').classList.contains('active')`
  );
  assert(wizardOpen === true, 'the wizard opens on Start Uninstall');
  await assertClickable(win, '#scr-config .mode-card[data-mode="Advanced"]', 'a scan-mode card is clickable');
  // #chk-create-restore is a deliberately zero-size input behind a visible
  // .slider (the standard toggle-switch pattern - index.css .toggle-switch
  // input {width:0;height:0}). A real user clicks the slider, inside the same
  // <label>, which is what actually toggles the checkbox. Hit-test what a user
  // clicks, and separately prove the click really reaches the input.
  await assertClickable(win, '.option-toggle-row .toggle-switch .slider', 'the restore-point toggle slider is clickable');
  const restoreToggle = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('chk-create-restore');
    const before = box.checked;
    document.querySelector('.option-toggle-row .toggle-switch .slider').click();
    return { before, after: box.checked };
  })()`);
  assert(restoreToggle.before !== restoreToggle.after, 'clicking the visible slider actually toggles the underlying checkbox');
  // Restore it to checked - the rest of this walkthrough exercises the restore-point path.
  if (!restoreToggle.after) {
    await win.webContents.executeJavaScript(`document.querySelector('.option-toggle-row .toggle-switch .slider').click(); true;`);
  }
  await assertClickable(win, '#btn-wiz-next', 'Next is clickable on the config screen');

  // Config -> restore point -> native uninstaller screen.
  await queueResponse(win, 'createRestorePoint', { success: true });
  await click(win, '#btn-wiz-next');
  await wait(700);

  const onNativeScreen = await win.webContents.executeJavaScript(
    `document.getElementById('scr-native-run').classList.contains('active')`
  );
  assert(onNativeScreen === true, 'the wizard advances to the native-uninstall screen');
  await assertClickable(win, '#btn-launch-native', 'Launch Native Uninstaller is clickable');
  await assertClickable(win, '#btn-wiz-back', 'Back is clickable mid-wizard');
  await assertClickable(win, '#wiz-close-x', 'the wizard close button is always reachable');

  // Launch native uninstaller: SEC-1 pipeline, happy path.
  await queueResponse(win, 'uninstallNative', { success: true, exitCode: 0 });
  await click(win, '#btn-launch-native');
  await wait(700);

  // Next: scan leftovers, populated with files AND registry findings so the
  // tree-render and select-all paths both get exercised.
  await queueResponse(win, 'scanLeftovers', {
    files: [
      { path: 'C:\\Program Files\\Test\\leftover.dat', sizeBytes: 4096, risk: 'Safe', type: 'File' },
      { path: 'C:\\Program Files\\Test\\cache', sizeBytes: 8192, risk: 'Advanced', type: 'Folder' }
    ],
    registry: [
      { path: 'HKCU\\Software\\Test', risk: 'Moderate', type: 'Key' }
    ]
  });
  await click(win, '#btn-wiz-next');
  await wait(800);

  const onTreeScreen = await win.webContents.executeJavaScript(
    `document.getElementById('scr-leftovers-tree').classList.contains('active')`
  );
  assert(onTreeScreen === true, 'the wizard advances to the leftovers tree after scanning');

  const treeShape = await win.webContents.executeJavaScript(`(() => {
    const boxes = document.querySelectorAll('#leftovers-tree-view input[type="checkbox"]');
    return {
      count: boxes.length,
      // Safe/Moderate auto-check; Advanced starts unchecked (renderer.js renderLeftoversTree).
      checkedByDefault: Array.from(boxes).filter((b) => b.checked).length
    };
  })()`);
  assert(treeShape.count === 3, 'all three leftover findings rendered as checkboxes');
  assert(treeShape.checkedByDefault === 2, 'Safe and Moderate risk are pre-checked, Advanced is not');

  await assertClickable(win, '#leftovers-tree-view input[type="checkbox"]', 'a leftover checkbox is genuinely clickable');
  await assertClickable(win, '#btn-select-all', 'Select all is clickable');

  // Per-item toggle: uncheck one box by hand rather than via select-all.
  const toggled = await win.webContents.executeJavaScript(`(() => {
    const box = document.querySelectorAll('#leftovers-tree-view input[type="checkbox"]')[0];
    const before = box.checked;
    box.click();
    return { before, after: box.checked };
  })()`);
  assert(toggled.before !== toggled.after, 'clicking one checkbox toggles only that one');

  // Select-all: from a mixed state, the first click must check everything.
  await click(win, '#btn-select-all');
  await wait(200);
  const afterSelectAll = await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('#leftovers-tree-view input[type="checkbox"]')).every((b) => b.checked)
  `);
  assert(afterSelectAll === true, 'select-all checks every leftover, including the Advanced-risk one');

  await assertClickable(win, '#btn-wiz-purge', 'the purge/quarantine button is clickable with items selected');

  // Purge now confirms first - the immediate-effect warning added after the
  // operator found the main wizard purge path was the one entry point of
  // three that skipped confirmation entirely.
  await click(win, '#btn-wiz-purge');
  await wait(400);
  const purgeConfirmShown = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    return { active: overlay.classList.contains('active'), title: document.getElementById('confirm-title').textContent };
  })()`);
  assert(purgeConfirmShown.active === true, 'quarantining from the wizard is confirmed before anything moves');
  assert(purgeConfirmShown.title.includes('Quarantine'), 'the confirm dialog names the action being confirmed');

  // Purge: quarantine everything selected, land on the completion screen.
  await queueResponse(win, 'purgeRemnants', {
    success: true, entryId: 'wizard-entry-1', quarantinedCount: 3, files: [], registry: []
  });
  await click(win, '#btn-confirm-ok');
  await wait(800);

  const onCompleteScreen = await win.webContents.executeJavaScript(
    `document.getElementById('scr-complete').classList.contains('active')`
  );
  assert(onCompleteScreen === true, 'the wizard reaches the completion screen after purging');
  await assertClickable(win, '#btn-wiz-finish', 'Finish is clickable on the completion screen');

  await click(win, '#btn-wiz-finish');
  await wait(500);
  const wizardClosed = await win.webContents.executeJavaScript(
    `!document.getElementById('wizard-modal-overlay').classList.contains('active')`
  );
  assert(wizardClosed === true, 'Finish closes the wizard');

  // ==========================================================================
  // Quarantine Manager: restore (including the overwrite-conflict branch)
  // ==========================================================================
  console.log('');
  console.log('Quarantine Manager - restore');

  await click(win, '.nav-item[data-tab="quarantine"]');
  await wait(600);
  await assertClickable(win, '#vault-entries .vault-entry-header', 'a vault entry is clickable');
  await click(win, '#vault-entries .vault-entry-header');
  await wait(300);
  await assertClickable(win, '[data-action="restore"]', 'the Restore button is clickable, not tier-locked');

  // First call reports a conflict (something already at the original path).
  // The renderer must raise a confirm dialog and offer overwrite.
  await queueResponse(win, 'vaultRestore', { success: true, failed: 0, skipped: 1, files: [{ status: 'skipped' }], registry: [] });
  await click(win, '[data-action="restore"]');
  await wait(700);

  const conflictDialog = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const body = document.getElementById('confirm-body');
    return { active: overlay.classList.contains('active'), mentionsExist: (body.textContent || '').includes('already sitting') };
  })()`);
  assert(conflictDialog.active === true, 'a restore conflict raises a confirm dialog rather than silently skipping');
  assert(conflictDialog.mentionsExist === true, 'the dialog explains that something already sits at the original path');
  await assertClickable(win, '#btn-confirm-ok', 'the Overwrite confirm button is clickable');

  // Accept the overwrite; the second vaultRestore call reports full success.
  await queueResponse(win, 'vaultRestore', { success: true, failed: 0, skipped: 0, files: [], registry: [] });
  await queueResponse(win, 'vaultList', {
    success: true, vaultRoot: 'C:\\vault',
    entries: [{
      id: '11111111-2222-3333-4444-555555555555', sourceApp: 'Test App', origin: 'uninstall-wizard',
      createdAt: new Date().toISOString(), status: 'restored', fileCount: 0, registryCount: 0, sizeBytes: 0,
      vaultPath: 'C:\\vault\\entry', files: [], registry: []
    }]
  });
  await click(win, '#btn-confirm-ok');
  await wait(700);

  const afterOverwrite = await win.webContents.executeJavaScript(`(() => {
    const entry = document.querySelector('#vault-entries .vault-entry');
    return { statusClass: entry ? entry.className : null };
  })()`);
  assert(
    (afterOverwrite.statusClass || '').includes('status-restored'),
    'the entry re-renders with restored status after the overwrite completes'
  );

  // ==========================================================================
  // Quarantine Manager: Delete Forever (the double-typed-confirm path)
  // ==========================================================================
  console.log('');
  console.log('Quarantine Manager - Delete Forever');

  // A fresh still-quarantined entry so the Delete Forever button is present.
  await queueResponse(win, 'vaultList', {
    success: true, vaultRoot: 'C:\\vault',
    entries: [{
      id: '22222222-3333-4444-5555-666666666666', sourceApp: 'Delete Me App', origin: 'purge',
      createdAt: new Date().toISOString(), status: 'quarantined', fileCount: 1, registryCount: 0, sizeBytes: 4096,
      vaultPath: 'C:\\vault\\entry2', files: [{ originalPath: 'C:\\x\\y.dat', status: 'quarantined' }], registry: []
    }]
  });
  await click(win, '#btn-refresh-vault');
  await wait(600);
  await assertClickable(win, '[data-action="delete"]', 'the Delete Forever button is clickable, not tier-locked');

  await click(win, '[data-action="delete"]');
  await wait(600);
  const firstDeleteDialog = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const body = document.getElementById('confirm-body');
    return { active: overlay.classList.contains('active'), mentionsNoUndo: (body.textContent || '').includes('cannot be undone') };
  })()`);
  assert(firstDeleteDialog.active === true, 'Delete Forever raises the first confirm dialog');
  assert(firstDeleteDialog.mentionsNoUndo === true, 'the first dialog states this is the one irreversible action');
  await assertClickable(win, '#btn-confirm-ok', 'the first Continue button is clickable');

  await click(win, '#btn-confirm-ok');
  await wait(500);

  const secondDeleteDialog = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const ok = document.getElementById('btn-confirm-ok');
    const input = document.getElementById('confirm-typed-input');
    return { active: overlay.classList.contains('active'), startsDisabled: ok.disabled, hasInput: !!input };
  })()`);
  assert(secondDeleteDialog.active === true, 'a second, typed confirm dialog follows the first');
  assert(secondDeleteDialog.startsDisabled === true, 'the second confirm starts inert until DELETE is typed');
  await assertClickable(win, '#confirm-typed-input', 'the DELETE input is reachable');

  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('confirm-typed-input');
    input.value = 'DELETE';
    input.dispatchEvent(new Event('input'));
  })()`);
  await wait(150);
  await assertClickable(win, '#btn-confirm-ok', 'the confirm button unlocks once DELETE is typed');

  await queueResponse(win, 'vaultDelete', { success: true });
  await queueResponse(win, 'vaultList', { success: true, vaultRoot: 'C:\\vault', entries: [] });
  await click(win, '#btn-confirm-ok');
  await wait(700);

  const afterDelete = await win.webContents.executeJavaScript(`
    document.getElementById('vault-empty').style.display !== 'none'
  `);
  assert(afterDelete === true, 'the vault shows empty after the only entry is permanently deleted');

  // ==========================================================================
  // Bulk queue panel, including the risky-uninstaller acknowledgement
  // ==========================================================================
  console.log('');
  console.log('Bulk queue panel and risky-uninstaller acknowledgement');

  await click(win, '.nav-item[data-tab="all-apps"]');
  await wait(400);
  await click(win, '#apps-tbody .app-row');
  await wait(200);

  // The queue panel's list comes from queueGet(), not from queueAdd()'s own
  // response - queue one HKCU-registered, risky item for the panel to render.
  await queueResponse(win, 'queueGet', {
    items: [{
      id: 'q1', appKey: 'HKCU:\\Software\\Planted', displayName: 'Planted App', publisher: 'Unknown',
      state: 'pending', method: null, exitCode: null,
      meta: { trust: { risky: true, reasons: ['registered under HKCU, which any standard user can write'] } }
    }],
    running: false, paused: false, counts: { pending: 1 }
  });
  await click(win, '#btn-queue-app');
  await wait(700);

  const queuePanelOpen = await win.webContents.executeJavaScript(
    `document.getElementById('queue-panel').classList.contains('active')`
  );
  assert(queuePanelOpen === true, 'the queue panel opens once an item is queued');
  await assertClickable(win, '.queue-item', 'the queued item row is rendered and hit-testable');
  await assertClickable(win, '#btn-queue-start', 'Start Queue is clickable, not tier-locked');

  await click(win, '#btn-queue-start');
  await wait(600);

  const startDialog = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const body = document.getElementById('confirm-body');
    return { active: overlay.classList.contains('active'), text: body.textContent || '' };
  })()`);
  assert(startDialog.active === true, 'starting the queue raises a confirm dialog before anything runs');
  await assertClickable(win, '#btn-confirm-ok', 'the Start confirm button is clickable');

  await click(win, '#btn-confirm-ok');
  await wait(600);

  // The risky-item acknowledgement follows immediately, and is typed (RUN).
  const riskyDialog = await win.webContents.executeJavaScript(`(() => {
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
  assert(riskyDialog.active === true, 'a risky item in the queue raises its own acknowledgement dialog');
  assert(riskyDialog.namesTheApp === true, 'the risky-queue dialog names the specific application');
  assert(riskyDialog.givesTheReason === true, 'the risky-queue dialog states why it is untrusted');
  assert(riskyDialog.startsDisabled === true, 'the risky-queue dialog is also a typed gate, starting inert');
  await assertClickable(win, '#confirm-typed-input', 'the RUN input for the queue-level gate is reachable');

  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('confirm-typed-input');
    input.value = 'RUN';
    input.dispatchEvent(new Event('input'));
  })()`);
  await wait(150);
  await assertClickable(win, '#btn-confirm-ok', 'the queue-level acknowledgement unlocks on the exact word');

  await queueResponse(win, 'queueStart', { success: true });
  await click(win, '#btn-confirm-ok');
  await wait(500);

  // ==========================================================================
  // Task Manager: critical-process kill protection
  //
  // Found by the operator running the real app: nothing stopped Task Manager
  // from ending csrss.exe or the wrong svchost.exe instance, an outright BSOD
  // risk with zero legitimate use. Three tiers now: an always-fatal denylist
  // refuses outright (no dialog to click through), a risky-but-sometimes-
  // legitimate set requires a typed double-confirm, everything else keeps
  // the original single-click confirm.
  // ==========================================================================
  console.log('');
  console.log('Task Manager: critical-process kill protection');

  await click(win, '.nav-item[data-tab="task-manager"]');
  // Let the tab's own automatic first sample (triggered by startProcessRefresh)
  // fully settle before queuing a scripted response - sampleProcesses() no-ops
  // while one is already in flight, so queuing too early can be silently lost.
  await wait(900);
  // The 2s auto-refresh interval that same call started is still live and
  // will silently overwrite a scripted fixture with the stub default the
  // moment it next fires - stop it for the rest of this section.
  await win.webContents.executeJavaScript('stopProcessRefresh()');

  await queueResponse(win, 'listProcesses', {
    success: true, sampledMs: 400, logicalCores: 16, indicatorNote: '',
    items: [
      { pid: 111, name: 'csrss', cpuPercent: 0, memoryBytes: 0, ioBytesPerSec: 0, parentPid: 1, parentName: '', commandLine: '', imagePath: '', startedAt: '', indicators: [] },
      { pid: 222, name: 'svchost', cpuPercent: 0, memoryBytes: 0, ioBytesPerSec: 0, parentPid: 1, parentName: '', commandLine: '', imagePath: '', startedAt: '', indicators: [] },
      { pid: 333, name: 'notepad', cpuPercent: 0, memoryBytes: 0, ioBytesPerSec: 0, parentPid: 1, parentName: '', commandLine: '', imagePath: '', startedAt: '', indicators: [] }
    ]
  });
  await win.webContents.executeJavaScript('sampleProcesses()');
  const gotFixtureRows = await waitForSelector(win, 'tr[data-pid="111"]');
  assert(gotFixtureRows === true, 'the scripted 3-process fixture actually rendered');
  if (!gotFixtureRows) {
    console.log('  aborting this section - rows never appeared, nothing safe to click');
  } else {

  // Fatal tier (csrss): refused outright, no confirm dialog appears at all.
  await win.webContents.executeJavaScript(`document.querySelector('tr[data-pid="111"]').click()`);
  await wait(150);
  await click(win, '#btn-kill-process');
  await wait(300);
  const fatalState = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    return { dialogOpen: overlay.classList.contains('active') };
  })()`);
  assert(fatalState.dialogOpen === false, 'ending csrss (fatal tier) opens no confirm dialog - refused before one is shown');

  // Risky tier (svchost): typed double-confirm, OK stays disabled until the exact name is typed.
  await win.webContents.executeJavaScript(`document.querySelector('tr[data-pid="222"]').click()`);
  await wait(150);
  await click(win, '#btn-kill-process');
  await wait(300);
  const riskyBeforeType = await win.webContents.executeJavaScript(`(() => ({
    dialogOpen: document.getElementById('confirm-modal-overlay').classList.contains('active'),
    typedRowVisible: document.getElementById('confirm-typed-row').style.display !== 'none',
    okDisabled: document.getElementById('btn-confirm-ok').disabled
  }))()`);
  assert(riskyBeforeType.dialogOpen === true, 'ending svchost (risky tier) opens a confirm dialog');
  assert(riskyBeforeType.typedRowVisible === true, 'svchost requires typing the name, not just a click');
  assert(riskyBeforeType.okDisabled === true, 'OK stays disabled before the name is typed correctly');

  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('confirm-typed-input');
    input.value = 'svchost';
    input.dispatchEvent(new Event('input'));
  })()`);
  await wait(150);
  const riskyAfterType = await win.webContents.executeJavaScript(
    `document.getElementById('btn-confirm-ok').disabled`
  );
  assert(riskyAfterType === false, 'typing the exact process name unlocks OK');
  await click(win, '#btn-confirm-cancel');
  await wait(200);

  // Normal tier (notepad): single-click confirm, no typed field, same as before this fix.
  await win.webContents.executeJavaScript(`document.querySelector('tr[data-pid="333"]').click()`);
  await wait(150);
  await click(win, '#btn-kill-process');
  await wait(300);
  const normalState = await win.webContents.executeJavaScript(`(() => ({
    dialogOpen: document.getElementById('confirm-modal-overlay').classList.contains('active'),
    typedRowVisible: document.getElementById('confirm-typed-row').style.display !== 'none'
  }))()`);
  assert(normalState.dialogOpen === true, 'ending an ordinary process still confirms once');
  assert(normalState.typedRowVisible === false, 'an ordinary process does not require typing a name');
  await click(win, '#btn-confirm-cancel');
  await wait(200);
  } // end gotFixtureRows guard

  // ==========================================================================
  // System Clean: scan -> select -> purge
  // ==========================================================================
  console.log('');
  console.log('System Clean scan-to-purge');

  await click(win, '.nav-item[data-tab="system-clean"]');
  await wait(500);
  await assertClickable(win, '#cleaner-context-menus .cleaner-section-header', 'a cleaner section header is clickable');

  await queueResponse(win, 'cleanerScan', {
    success: true,
    findings: [
      { label: 'Orphan menu handler', evidence: 'COM server missing', registryPath: 'HKCR\\Foo', risk: 'Safe', removable: true },
      { label: 'Another orphan', evidence: 'COM server missing', registryPath: 'HKCR\\Bar', risk: 'Moderate', removable: true }
    ]
  });
  await click(win, '#cleaner-context-menus .cleaner-section-header');
  await wait(800);

  const scanFindings = await win.webContents.executeJavaScript(`
    document.querySelectorAll('#cleaner-body-context-menus .finding-row').length
  `);
  assert(scanFindings === 2, 'both scan findings render as rows');
  await assertClickable(win, '#cleaner-body-context-menus input[type="checkbox"]', 'a finding checkbox is clickable');
  await assertClickable(win, '[data-select-all="context-menus"]', 'the cleaner Select all button is clickable');
  await assertClickable(win, '[data-purge="context-menus"]', 'the Move to quarantine button is clickable');

  await click(win, '[data-select-all="context-menus"]');
  await wait(200);
  const allChecked = await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('#cleaner-body-context-menus input[type="checkbox"]')).every((b) => b.checked)
  `);
  assert(allChecked === true, 'select-all checks every cleaner finding');

  await click(win, '[data-purge="context-menus"]');
  await wait(600);
  const purgeDialog = await win.webContents.executeJavaScript(`(() => {
    const overlay = document.getElementById('confirm-modal-overlay');
    return { active: overlay.classList.contains('active') };
  })()`);
  assert(purgeDialog.active === true, 'purging cleaner findings is confirmed before anything is removed');
  await assertClickable(win, '#btn-confirm-ok', 'the cleaner purge confirm button is clickable');

  // 7oo.5 changed this contract deliberately. Purging used to end in a full
  // re-scan to discover something the app already knew - that the items it had
  // just quarantined were gone - and on the operator's machine that re-scan was
  // minutes long. The view now updates in place. The assertion's intent is
  // unchanged (no stale rows after a purge); what it must NOT do any more is
  // require a second engine round trip to get there.
  await queueResponse(win, 'cleanerPurge', { success: true, quarantinedCount: 2 });
  const scansBeforePurge = await win.webContents.executeJavaScript(
    `window.__test.callCount('cleanerScan')`
  );
  await click(win, '#btn-confirm-ok');
  await wait(700);

  const afterPurge = await win.webContents.executeJavaScript(`(() => {
    const body = document.getElementById('cleaner-body-context-menus');
    return {
      text: body.textContent || '',
      rows: body.querySelectorAll('.finding-row').length,
      scans: window.__test.callCount('cleanerScan')
    };
  })()`);
  assert(afterPurge.rows === 0, 'purged findings leave the list immediately, no stale rows');
  assert(
    afterPurge.text.includes('moved to quarantine'),
    'the panel says what happened to them rather than going blank'
  );
  assert(
    afterPurge.scans === scansBeforePurge,
    'and it does that without re-running the scan'
  );

  // ==========================================================================
  // 7sl: the definitions section - the one cleaner whose rules Vanish did not
  // write, and therefore the one that has to be TOLD where they are.
  //
  // The engine half is covered exhaustively by test/cleanerml-verify.ps1. What
  // only this suite can prove is that the folder the user chooses actually
  // reaches the engine, because that value crosses two boundaries (a DOM input
  // that renderCleanerBody rebuilds on every render, then the IPC bridge) and
  // a section that silently scanned the wrong folder would still look like a
  // clean, successful, entirely wrong result.
  // ==========================================================================
  console.log('');
  console.log('System Clean: cleaning definitions (7sl)');

  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('cleaner-definitions').scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await wait(200);
  await assertClickable(win, '#cleaner-definitions .cleaner-section-header', 'the definitions section header is clickable');
  await click(win, '#cleaner-definitions .cleaner-section-header');
  await wait(400);

  const folderRow = await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('cleaner-folder-definitions');
    const browse = document.querySelector('[data-browse="definitions"]');
    return {
      hasInput: !!input,
      hasBrowse: !!browse,
      placeholder: input ? input.placeholder : ''
    };
  })()`);
  assert(folderRow.hasInput === true, 'the section offers somewhere to say where the definitions are');
  assert(folderRow.hasBrowse === true, 'and a Browse button, rather than requiring a path typed by hand');
  assert(
    /BleachBit/i.test(folderRow.placeholder),
    'the empty state says what happens if it is left blank, instead of leaving the user to guess'
  );

  // The picker writes into the input. Queued as a real response so the click
  // path is what gets exercised, not a direct assignment.
  await queueResponse(win, 'browseForPath', { canceled: false, path: 'C:\\Fixture\\cleaners' });
  await click(win, '[data-browse="definitions"]');
  await wait(300);
  const afterBrowse = await win.webContents.executeJavaScript(
    `document.getElementById('cleaner-folder-definitions').value`
  );
  assert(afterBrowse === 'C:\\Fixture\\cleaners', 'choosing a folder in the picker fills the input');

  await queueResponse(win, 'cleanerScan', {
    success: true,
    note: "1 option(s) were NOT offered because they use instructions Vanish will not run: Some App - Databases (uses command 'sqlite.vacuum').",
    findings: [
      {
        id: 'cleanerml|someapp|cache',
        label: 'Some App - Cache - 12.0 MB',
        evidence: "someapp.xml option 'cache' matched 4 item(s)",
        risk: 'Moderate',
        kind: 'file',
        path: 'C:\\Fixture\\cache',
        paths: ['C:\\Fixture\\cache\\a', 'C:\\Fixture\\cache\\b'],
        removable: true
      }
    ]
  });
  await click(win, '[data-scan="definitions"]');
  await wait(700);

  const sent = await win.webContents.executeJavaScript(`(() => {
    const calls = window.__test.callArgs('cleanerScan');
    const last = calls[calls.length - 1];
    return last && last[0] ? last[0] : null;
  })()`);
  assert(sent !== null && sent.cleaner === 'definitions', 'scanning asks the engine for the definitions cleaner');
  assert(
    sent !== null && sent.definitionsPath === 'C:\\Fixture\\cleaners',
    'and the folder the user chose is what it sends - not a default, and not nothing'
  );

  const defsBody = await win.webContents.executeJavaScript(`(() => {
    const body = document.getElementById('cleaner-body-definitions');
    return {
      rows: body.querySelectorAll('.finding-row').length,
      text: body.textContent || '',
      folderKept: (document.getElementById('cleaner-folder-definitions') || {}).value
    };
  })()`);
  assert(defsBody.rows === 1, 'a matched option renders as one row, not one row per file');
  assert(
    defsBody.text.includes('sqlite.vacuum'),
    'and the options Vanish refused to run are named on screen, not left out silently'
  );
  assert(
    defsBody.folderKept === 'C:\\Fixture\\cleaners',
    'the chosen folder survives the re-render that the scan result triggers'
  );

  // ==========================================================================
  // All Programs: multi-select + "Add N to queue" (bd vanish-uninstaller-5rz)
  //
  // The single-item path was already covered above. What is new here is a
  // second selection concept living on the same rows, and every assertion
  // below exists because the two can quietly interfere: checking a box must
  // not open the details sidebar, a filter must not leave selected-but-hidden
  // rows queued behind the user's back, and a protected entry must be refused
  // by NAME in the summary rather than silently dropped from the count.
  // ==========================================================================
  console.log('');
  console.log('All Programs: multi-select and bulk Add to queue');

  await click(win, '.nav-item[data-tab="all-apps"]');
  await wait(400);

  // Five scripted rows in a known A-Z order (the default sort): three plain
  // applications, one protected, one Windows optional feature. The feature is
  // only visible with the Components toggle on, so turn it on first.
  await win.webContents.executeJavaScript(`
    if (!document.getElementById('chk-show-components').checked) {
      document.getElementById('chk-show-components').click();
    }
    window.__test.queueResponse('getDesktopApps', [
      { id: 'b1', name: 'Bulk Alpha', publisher: 'P', version: '1', installDate: '2026-01-01',
        sizeBytes: 1024, registryPath: 'HKLM:\\\\Software\\\\B1', type: 'Desktop', classification: 'application' },
      { id: 'b2', name: 'Bulk Bravo', publisher: 'P', version: '1', installDate: '2026-01-01',
        sizeBytes: 1024, registryPath: 'HKLM:\\\\Software\\\\B2', type: 'Desktop', classification: 'application' },
      { id: 'b3', name: 'Bulk Charlie', publisher: 'P', version: '1', installDate: '2026-01-01',
        sizeBytes: 1024, registryPath: 'HKLM:\\\\Software\\\\B3', type: 'Desktop', classification: 'application' },
      { id: 'b4', name: 'Bulk Delta Guarded', publisher: 'P', version: '1', installDate: '2026-01-01',
        sizeBytes: 1024, registryPath: 'HKLM:\\\\Software\\\\B4', type: 'Desktop', classification: 'application',
        protected: true, protectionReason: 'Windows needs it to keep this PC updated.' },
      { id: 'b5', name: 'Bulk Echo Feature', publisher: 'P', version: '1', installDate: '2026-01-01',
        sizeBytes: 1024, registryPath: 'HKLM:\\\\Software\\\\B5', type: 'Desktop', classification: 'feature' }
    ]);
    loadApplications();
    true;
  `);
  await wait(600);

  const gridReady = await win.webContents.executeJavaScript(`(() => ({
    rows: document.querySelectorAll('#apps-tbody .app-row').length,
    boxes: document.querySelectorAll('#apps-tbody .app-row-checkbox').length,
    names: Array.from(document.querySelectorAll('#apps-tbody .app-title-name')).map((n) => n.textContent)
  }))()`);
  assert(gridReady.rows === 5, 'the five scripted rows rendered');
  assert(gridReady.boxes === 5, 'every rendered row carries a checkbox');
  assert(gridReady.names[0] === 'Bulk Alpha', 'rows are in the expected A-Z order the range test depends on');
  await assertClickable(win, '#chk-select-all-apps', 'the select-all header checkbox is clickable, not buried under the sticky header');
  await assertClickable(win, '#apps-tbody .app-row .app-row-checkbox', 'a row checkbox is clickable, not covered by its own row');

  // Checking a box is NOT the same gesture as opening a row. If it were, every
  // box ticked while building a bulk queue would also swap the details sidebar
  // out from under the user.
  await win.webContents.executeJavaScript(`
    document.getElementById('details-sidebar').classList.remove('active');
    document.querySelectorAll('#apps-tbody .app-row-checkbox')[0].click();
    true;
  `);
  await wait(200);
  const afterFirstCheck = await win.webContents.executeJavaScript(`(() => ({
    selected: bulkSelectedAppIds.size,
    sidebarOpen: document.getElementById('details-sidebar').classList.contains('active'),
    barShown: document.getElementById('bulk-select-row').style.display !== 'none',
    filterRowHidden: document.getElementById('filter-status-row').style.display === 'none',
    caption: document.getElementById('bulk-select-text').textContent,
    addLabel: document.getElementById('btn-bulk-add-queue').textContent,
    headerIndeterminate: document.getElementById('chk-select-all-apps').indeterminate
  }))()`);
  assert(afterFirstCheck.selected === 1, 'ticking one box selects exactly one row');
  assert(afterFirstCheck.sidebarOpen === false, 'ticking a box does NOT also open that row\'s details sidebar');
  assert(afterFirstCheck.barShown === true, 'the selection bar appears as soon as something is selected');
  assert(afterFirstCheck.filterRowHidden === true, 'the filter caption yields its slot rather than stacking');
  assert(afterFirstCheck.caption === '1 selected', 'the selection bar counts what is selected');
  assert(afterFirstCheck.addLabel === 'Add 1 to queue', 'the add button states how many it will act on');
  assert(afterFirstCheck.headerIndeterminate === true, 'a partial selection shows the header checkbox as indeterminate');
  await assertClickable(win, '#btn-bulk-add-queue', 'the bulk Add button is reachable, not behind the caption row');
  await assertClickable(win, '#btn-bulk-clear-selection', 'the Clear selection button is reachable');

  // Shift-click extends from the last box actually clicked.
  await win.webContents.executeJavaScript(`
    (() => {
      const boxes = document.querySelectorAll('#apps-tbody .app-row-checkbox');
      boxes[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    })();
    true;
  `);
  await wait(200);
  const afterShift = await win.webContents.executeJavaScript(`(() => ({
    selected: bulkSelectedAppIds.size,
    ids: Array.from(bulkSelectedAppIds).sort(),
    checkedBoxes: Array.from(document.querySelectorAll('#apps-tbody .app-row-checkbox')).filter((b) => b.checked).length
  }))()`);
  assert(afterShift.selected === 4, 'shift-clicking the fourth row range-selects rows 1 through 4');
  assert(afterShift.ids.join(',') === 'b1,b2,b3,b4', 'the range covers exactly the rows between the anchor and the shift-click');
  assert(afterShift.checkedBoxes === 4, 'the re-rendered checkboxes reflect the whole range, not just the clicked one');

  // A re-sort moves rows; it must not lose the selection riding on them.
  await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.getElementById('sort-selector');
      sel.value = 'name-desc';
      sel.dispatchEvent(new Event('change'));
    })();
    true;
  `);
  await wait(300);
  const afterSort = await win.webContents.executeJavaScript(`(() => ({
    selected: bulkSelectedAppIds.size,
    ids: Array.from(bulkSelectedAppIds).sort(),
    firstName: document.querySelector('#apps-tbody .app-title-name').textContent
  }))()`);
  assert(afterSort.firstName === 'Bulk Echo Feature', 'the re-sort actually reordered the table');
  assert(afterSort.selected === 4 && afterSort.ids.join(',') === 'b1,b2,b3,b4', 'a re-sort keeps the same rows selected');

  // Select-all covers the rows on screen.
  await win.webContents.executeJavaScript(`document.getElementById('chk-select-all-apps').click(); true;`);
  await wait(250);
  const afterSelectAllRows = await win.webContents.executeJavaScript(`(() => ({
    selected: bulkSelectedAppIds.size,
    headerChecked: document.getElementById('chk-select-all-apps').checked,
    headerIndeterminate: document.getElementById('chk-select-all-apps').indeterminate
  }))()`);
  assert(afterSelectAllRows.selected === 5, 'select-all selects every rendered row');
  assert(afterSelectAllRows.headerChecked === true && afterSelectAllRows.headerIndeterminate === false,
    'a complete selection shows the header checkbox as checked, not indeterminate');

  // Filtering to one row must DROP the four it hides. A selection the user can
  // no longer see is a selection they cannot review before pressing Add.
  await win.webContents.executeJavaScript(`
    (() => {
      const bar = document.getElementById('search-bar');
      bar.value = 'Alpha';
      bar.dispatchEvent(new Event('input'));
    })();
    true;
  `);
  await wait(300);
  const afterFilter = await win.webContents.executeJavaScript(`(() => ({
    rows: document.querySelectorAll('#apps-tbody .app-row').length,
    selected: bulkSelectedAppIds.size,
    ids: Array.from(bulkSelectedAppIds),
    caption: document.getElementById('bulk-select-text').textContent
  }))()`);
  assert(afterFilter.rows === 1, 'the search filtered the table down to one row');
  assert(afterFilter.selected === 1 && afterFilter.ids[0] === 'b1',
    'rows a filter hides are dropped from the selection, never queued unseen');
  assert(
    /showing 1 of 5/i.test(afterFilter.caption),
    'the active filter still announces itself while a selection occupies that slot (2026-08-05 regression guard)'
  );

  // Clear the filter, then Clear selection.
  await win.webContents.executeJavaScript(`
    (() => {
      const bar = document.getElementById('search-bar');
      bar.value = '';
      bar.dispatchEvent(new Event('input'));
    })();
    true;
  `);
  await wait(300);
  await click(win, '#btn-bulk-clear-selection');
  await wait(250);
  const afterClear = await win.webContents.executeJavaScript(`(() => ({
    selected: bulkSelectedAppIds.size,
    barHidden: document.getElementById('bulk-select-row').style.display === 'none',
    filterRowShown: document.getElementById('filter-status-row').style.display !== 'none',
    checkedBoxes: Array.from(document.querySelectorAll('#apps-tbody .app-row-checkbox')).filter((b) => b.checked).length
  }))()`);
  assert(afterClear.selected === 0, 'Clear selection empties the selection');
  assert(afterClear.checkedBoxes === 0, 'and the boxes on screen actually uncheck');
  assert(afterClear.barHidden === true && afterClear.filterRowShown === true,
    'the filter caption gets its slot back once nothing is selected');

  // Bulk add: three addable, one protected, one Windows feature.
  await win.webContents.executeJavaScript(`
    document.getElementById('toast-stack').innerHTML = '';
    document.getElementById('chk-select-all-apps').click();
    true;
  `);
  await wait(250);
  const addsBefore = await win.webContents.executeJavaScript(`window.__test.callCount('queueAdd')`);
  await click(win, '#btn-bulk-add-queue');
  await wait(800);

  const afterBulkAdd = await win.webContents.executeJavaScript(`(() => ({
    adds: window.__test.callCount('queueAdd') - ${addsBefore},
    selected: bulkSelectedAppIds.size,
    barHidden: document.getElementById('bulk-select-row').style.display === 'none',
    toast: document.getElementById('toast-stack').textContent || ''
  }))()`);
  assert(afterBulkAdd.adds === 3, 'only the three addable programs crossed the bridge - the guarded ones never reached queueAdd');
  assert(/3 added to the queue/.test(afterBulkAdd.toast), 'the summary reports how many were added');
  assert(/2 skipped \(protected\)/.test(afterBulkAdd.toast), 'the summary reports how many were refused');
  assert(
    afterBulkAdd.toast.includes('Bulk Delta Guarded') && afterBulkAdd.toast.includes('Bulk Echo Feature'),
    'the summary names the refused programs rather than dropping them silently'
  );
  assert(
    afterBulkAdd.toast.split('Bulk Alpha').length === 1,
    'the summary is ONE toast about the batch, not one toast per item'
  );
  assert(afterBulkAdd.selected === 0 && afterBulkAdd.barHidden === true,
    'a completed bulk add clears the selection rather than leaving it armed for a second press');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail > 0 ? 1 : 0);
});
