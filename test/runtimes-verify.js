// ht8: shared runtimes are counted, isolable, and never actionable from here.
//
//   npx electron test/runtimes-verify.js
//
// Runs in either tier - everything here is read-only.
//
// The feature is INFORMATION, and these assertions are mostly about it staying
// that way. 22 near-identical "Microsoft Visual C++ ... Redistributable" rows
// were never hidden - they are classified as components and always reachable -
// but with no count and no way to see them as a group they read as noise inside
// a list of real programs. What is deliberately NOT offered is removal: knowing
// whether a runtime is still needed means reading the import tables of every
// binary on the machine, and without that "safe to remove" is a guess that
// breaks a program which will never say why.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

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

const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
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

app.whenReady().then(async () => {
  console.log('');
  console.log('Shared runtimes (ht8)');
  console.log('=====================');

  // ---- the engine half -------------------------------------------------
  // 'get-desktop-apps' is the channel the renderer actually uses - the same
  // list All Programs is built from, so this tests what the user sees.
  const apps = await invoke('get-desktop-apps');
  const list = Array.isArray(apps) ? apps : (apps && (apps.applications || apps.apps)) || [];
  assert(list.length > 0, `the engine returned a real application list (${list.length})`);

  const runtimes = list.filter((a) => a.isRuntime === true);
  console.log(`  (${runtimes.length} shared runtime(s) of ${list.length} entries)`);

  assert(
    list.every((a) => typeof a.isRuntime === 'boolean'),
    'every entry carries an explicit isRuntime flag, so the count can never be a guess about missing data'
  );

  // The flag has to agree with the classification it is derived from. A runtime
  // that showed up as a standalone "application" would offer an uninstall button
  // for something another program depends on.
  const misclassified = runtimes.filter((a) => a.classification === 'application');
  assert(
    misclassified.length === 0,
    'no runtime is classified as a standalone application',
    misclassified.slice(0, 3).map((a) => a.name).join(', ')
  );

  assert(
    runtimes.every((a) => String(a.classificationReason || '').trim().length > 0),
    'every runtime says why it is not a standalone program'
  );

  // ---- the UI half -----------------------------------------------------
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const js = (src) => win.webContents.executeJavaScript(src);

  // Seed the renderer directly - the pattern the repo's other DOM suites use.
  await js(`(() => {
    allApps = ${JSON.stringify(list)};
    showComponents = false;
    runtimesOnly = false;
    filterText = '';
    filterType = 'all';
    updateDashboardStats();
    filterAndRenderApps();
    return true;
  })()`);

  const badge = await js(`(() => document.getElementById('runtimes-count').textContent)()`);
  assert(
    String(badge) === String(runtimes.length),
    `the count is on screen before anything is clicked (badge '${badge}', engine ${runtimes.length})`
  );

  const captionDefault = await js(`(() => document.getElementById('filter-status-text').textContent)()`);
  assert(
    runtimes.length === 0 || /shared runtime/i.test(captionDefault),
    `the default caption states the runtime count (got '${captionDefault}')`
  );

  // Isolating them must actually show them. This is the assertion that would
  // have caught the obvious bug: runtimes are components, so filtering to
  // runtimes while components are hidden yields an empty table that reads as
  // "you have none".
  const isolated = await js(`(() => {
    const box = document.getElementById('chk-only-runtimes');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    return {
      rows: document.querySelectorAll('#apps-tbody tr.app-row').length,
      caption: document.getElementById('filter-status-text').textContent,
      componentsChecked: document.getElementById('chk-show-components').checked
    };
  })()`);

  assert(
    isolated.rows === runtimes.length,
    `isolating runtimes shows exactly them (${isolated.rows} rows, ${runtimes.length} runtimes)`
  );
  assert(
    runtimes.length === 0 || isolated.componentsChecked === true,
    'and it reveals components automatically - every runtime IS one, so leaving them hidden would show an empty table'
  );
  assert(
    /runtime/i.test(isolated.caption),
    `the caption admits the filter rather than reading as a complete list (got '${isolated.caption}')`
  );

  // REQ: no uninstall action is offered from this surface.
  const actions = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#apps-tbody tr.app-row'));
    return {
      rows: rows.length,
      withUninstall: rows.filter((r) => r.querySelector('[data-action="uninstall"], .btn-uninstall')).length
    };
  })()`);
  assert(
    actions.withUninstall === 0,
    `no runtime row offers an uninstall control (${actions.withUninstall} of ${actions.rows} did)`
  );

  // Turning it back off restores the ordinary view, and does not strand the
  // user inside a filter they cannot see the edge of.
  const restored = await js(`(() => {
    const box = document.getElementById('chk-only-runtimes');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    const cb = document.getElementById('chk-show-components');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    return {
      rows: document.querySelectorAll('#apps-tbody tr.app-row').length,
      caption: document.getElementById('filter-status-text').textContent
    };
  })()`);
  const applications = list.filter((a) => a.classification === 'application').length;
  assert(restored.rows === applications, `turning it off restores the default list (${restored.rows} of ${applications})`);

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
