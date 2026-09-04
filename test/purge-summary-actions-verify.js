// The two per-item buttons on the purge summary, and which failures get which.
//
//   npx electron test/purge-summary-actions-verify.js
//
// WHY THIS EXISTS. Nothing covered this screen's failure list - grepping the
// whole suite for data-unlock, summary-failure-item or failedItems returned
// nothing. That is the FLOW-02 shortcut h55 was designed around, and the REQ-19
// ownership elevator beside it, both offered per item and both able to silently
// stop appearing without a single assertion noticing.
//
// It was written when the lock classifier moved out of the renderer. That
// change swapped `isLockFailure(p.error)` for `p.lockSuspected === true` - a
// live UI condition, altered with no test underneath it. "A feature that
// answers null for everything still passes every assertion about answering
// null safely" is this repository's own lesson, and an unlock button that has
// quietly stopped rendering is the same shape.
//
// THE RULE BEING ASSERTED, which is a product rule and not a styling one:
// offering the wrong remedy wastes the click and teaches the user the buttons
// are noise. A locked file needs the Unlocker; a permission failure needs
// ownership; neither wants the other's button.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

const root = path.join(__dirname, '..');

// The RAW engine output - error strings only, no flags. The flags are then put
// on by the REAL annotator, the same call lib/vault.js makes, so this suite
// tests the actual seam rather than my transcription of what it produces.
// Hand-writing the expected flags here would be the mirror defect one level up.
//
// The lock message is Windows' exact wording, and it is exact for a reason: it
// contains the word "access", which is what used to make it match the
// permission classifier as well.
const { annotateLockFailures } = require('../lib/lock-failure');

const RESULT = annotateLockFailures({
  success: true,
  entryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  quarantinedCount: 1,
  files: [
    { originalPath: 'C:\\App\\moved.txt', status: 'quarantined', error: null },
    { originalPath: 'C:\\App\\held.dll', status: 'failed',
      error: 'The process cannot access the file because it is being used by another process.' },
    { originalPath: 'C:\\App\\denied.dll', status: 'failed',
      error: 'Access to the path is denied.' },
  ],
  registry: [
    { keyPath: 'HKCU\\Software\\App', status: 'failed', error: 'The key is in use' },
  ],
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(root, 'index.html'));
  await wait(3000);
  const run = (js) => win.webContents.executeJavaScript(js);

  console.log('');
  console.log('Purge summary, per-item remedies');
  console.log('================================');

  const rows = await run(`(() => {
    try {
      renderPurgeSummary(${JSON.stringify(RESULT)}, 4);
      return {
        ok: true,
        items: Array.from(document.querySelectorAll('.summary-failure-item')).map((el) => ({
          path: (el.querySelector('.path') || {}).textContent || '',
          reason: (el.querySelector('.reason') || {}).textContent || '',
          unlock: el.querySelectorAll('[data-unlock]').length,
          elevate: el.querySelectorAll('[data-elevate]').length,
        })),
      };
    } catch (e) { return { ok: false, err: String((e && e.stack) || e) }; }
  })()`);

  assert(rows.ok === true, 'premise: the summary rendered without throwing', rows.err);
  const items = rows.items || [];
  assert(items.length === 3, `premise: all three failures are listed (${items.length})`,
    JSON.stringify(items.map((i) => i.path)));

  const held = items.find((i) => /held\.dll/.test(i.path)) || {};
  const denied = items.find((i) => /denied\.dll/.test(i.path)) || {};
  const regRow = items.find((i) => /HKCU/.test(i.path)) || {};

  // The assertion the change was made for.
  assert(held.unlock === 1,
    'a locked FILE gets the Unlocker button, from the flag the main process set',
    JSON.stringify(held));
  assert(held.elevate === 0,
    'and not the ownership button - it is not a permission problem');

  assert(denied.elevate === 1,
    'a permission failure gets the ownership button', JSON.stringify(denied));
  assert(denied.unlock === 0,
    'and not the Unlocker - nothing is holding it, so that click could not help');

  assert(regRow.unlock === 0 && regRow.elevate === 0,
    'a failed REGISTRY key gets neither: list-lockers cannot be asked about a key, and there is no file to take ownership of',
    JSON.stringify(regRow));

  // ------------------------------------------------------------------
  console.log('');
  console.log('Without the flag, the button does not appear');
  // The negative control, and the reason it matters: the renderer no longer
  // derives this itself. If lib/vault.js ever stops annotating, the button
  // vanishes silently - so the absence has to be observable here, not inferred.

  const noFlag = JSON.parse(JSON.stringify(RESULT));
  for (const f of noFlag.files) { delete f.lockSuspected; delete f.aclSuspected; }

  const bare = await run(`(() => {
    renderPurgeSummary(${JSON.stringify(noFlag)}, 4);
    return Array.from(document.querySelectorAll('.summary-failure-item'))
      .map((el) => el.querySelectorAll('[data-unlock]').length)
      .reduce((a, b) => a + b, 0);
  })()`);
  assert(bare === 0,
    'an unannotated payload offers no Unlocker button at all - so this suite fails loudly if the annotation is ever dropped',
    String(bare));

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
