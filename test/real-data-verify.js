// REAL-DATA verification harness (vanish-uninstaller-7oo.10).
//
// WHY THIS EXISTS
// ---------------
// Every other UI suite in this repo runs against test/fixtures/stub-preload.js:
// one fake application, clean well-formed fields, instant responses. On the real
// machine there are 150+ registry entries of wildly varied shape, scans that
// take seconds, partial states, and a list long enough to scroll. That gap is
// not academic - it is how 312/312 stayed green while the operator was looking
// at a visibly broken app, and it is how the hit-test suite that exists
// SPECIFICALLY to catch un-clickable buttons passed while real buttons were
// occluded on screen (operator audit 2026-08-06).
//
// So this harness runs the REAL preload against the REAL backend on the REAL
// machine, and asserts what a user would actually see. Ground truth comes from
// test/fixtures/real-machine-truth.ps1, which reads the machine with its own
// queries - a harness that asks the code under test what reality looks like can
// only ever agree with itself.
//
//   npx electron test/real-data-verify.js
//   npx electron test/real-data-verify.js --only=storage,inventory
//   npx electron test/real-data-verify.js --size=800x600
//   npx electron test/real-data-verify.js --only=applist,wizard,tabs --sweep
//
// The window defaults to 1080x720 because that is what main.js createWindow()
// actually opens. Verifying at a roomier size than the app ships hides exactly
// the defects this file exists to find - the first run of this harness at
// 1280x860 still caught the details panel's buttons falling below the fold, but
// only because the panel is tall; a narrower miss would have slipped through.
//
// It is deliberately NOT in npm test's default path: it is slow, it is bound to
// whatever is installed on the machine running it, and its failures are meant to
// be read, not counted.
//
// NO WINDOW YOU COULD MISTAKE FOR THE APP: main.js is loaded with
// VANISH_HEADLESS_HARNESS=1, so it creates no window and fires no start-up side
// effect. This file makes its own offscreen window, titled as a harness. A
// diagnostic that quietly spawned the real app window once cost a whole
// debugging session (AGP-3 in the verification-pitfalls retrospective).
//
// NOTHING HERE IS DESTRUCTIVE. Every channel it touches is read-only; the run
// stays in Audit Mode on purpose, so even a mistake cannot reach a purge path.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const main = require('../main.js');

app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const TRUTH_SCRIPT = path.join(__dirname, 'fixtures', 'real-machine-truth.ps1');

// ---------------------------------------------------------------- reporting

let pass = 0;
let fail = 0;
const failures = [];
const rendererErrors = [];
let section = '';

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${String(detail).split('\n').join('\n        ')}`);
    fail += 1;
    failures.push({ section, label, detail: detail || '' });
  }
}

function heading(name) {
  section = name;
  console.log('');
  console.log(`--- ${name} ${'-'.repeat(Math.max(0, 66 - name.length))}`);
}

function skip(label, why) {
  console.log(`  SKIP  ${label} (${why})`);
}

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sections must not inherit whatever tab the previous one left behind - an
// early version measured the app list while the Health Advisor was on screen
// and reported every element as having no box.
async function goToTab(tab) {
  await js(`document.querySelector('.nav-item[data-tab="${tab}"]').click(); true;`);
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const shown = await js(`(() => {
      const el = document.querySelector('.nav-item[data-tab="${tab}"]');
      return el && el.classList.contains('active');
    })()`);
    if (shown) break;
    await sleep(200);
  }
  await sleep(500);
}

// The Health Advisor genuinely takes seconds against real CIM queries; a fixed
// sleep either flakes or wastes time.
// Returns milliseconds spent WAITING, or -1 on timeout, or null when the panel
// was already loaded before we looked.
//
// The distinction matters: an earlier section may have visited this tab, and
// renderer.js caches the result. Printing "audit data took 0.0s" in that case
// reads as a performance claim about CIM queries that were never re-run - a
// measurement of nothing, presented as a measurement of something. That is the
// same species of misleading number as a partial count shown as final.
async function waitForAuditContent(timeoutMs = 180000) {
  const alreadyLoaded = await js(
    `document.getElementById('audit-content').style.display !== 'none'`
  );
  if (alreadyLoaded) return null;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const done = await js(`document.getElementById('audit-content').style.display !== 'none'`);
    if (done) return Date.now() - started;
    await sleep(400);
  }
  return -1;
}

function runTruthProbe() {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TRUTH_SCRIPT
    ]);
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => {
      if (code !== 0) return reject(new Error(`truth probe exited ${code}: ${err}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`truth probe produced unparseable JSON: ${e.message}`));
      }
    });
  });
}

let win;

function js(expression) {
  return win.webContents.executeJavaScript(expression);
}

// Is `selector` the topmost element at its own centre? Same contract as
// test/ui-interaction-verify.js - the difference here is what is on screen
// behind it when the question is asked.
const HIT_TEST = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return { found: true, rendered: false };
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { found: true, rendered: false };
  const probes = [
    ['centre', Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
    ['left edge', Math.round(r.x + 4), Math.round(r.y + r.height / 2)],
    ['right edge', Math.round(r.right - 4), Math.round(r.y + r.height / 2)],
    ['top edge', Math.round(r.x + r.width / 2), Math.round(r.y + 4)],
    ['bottom edge', Math.round(r.x + r.width / 2), Math.round(r.bottom - 4)]
  ];
  const blocked = [];
  let allBlockersAreAncestors = true;
  for (const [where, x, y] of probes) {
    const top = document.elementFromPoint(x, y);
    const ok = top && (el === top || el.contains(top));
    if (!ok) {
      if (!top || !top.contains(el)) allBlockersAreAncestors = false;
      blocked.push(where + ' -> ' + (top
        ? top.tagName + (top.id ? '#' + top.id : '') +
          (typeof top.className === 'string' && top.className ? '.' + top.className.trim().split(/\\s+/).join('.') : '')
        : 'nothing (outside the viewport)'));
    }
  }
  return {
    found: true, rendered: true, hit: blocked.length === 0, blocked,
    // A control locked out of Audit Mode carries pointer-events:none by design,
    // so the hit test lands on its own parent. That is the tier working, not an
    // occlusion - but its GEOMETRY still has to be sound, which is what
    // onScreen answers.
    tierLocked: el.classList.contains('tier-locked'),
    inertByDesign: blocked.length > 0 && allBlockersAreAncestors,
    onScreen: r.top >= 0 && r.left >= 0 &&
              r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: window.innerWidth, h: window.innerHeight }
  };
}`;

async function hitTest(selector) {
  return js(`(${HIT_TEST})(${JSON.stringify(selector)})`);
}

// A control the user is expected to click must be the topmost element across
// its WHOLE box, not just its middle. Half a button is not a button.
//
// The one legitimate exception is a destructive control in Audit Mode: it is
// deliberately pointer-events:none, so the hit lands on its own ancestor. Those
// are held to the weaker but still meaningful contract - the box must be fully
// on screen, because an off-screen button is broken in either tier.
async function assertClickable(selector, label) {
  const r = await hitTest(selector);
  if (!r.found) return assert(false, label, `${selector} is not in the DOM`);
  if (!r.rendered) return assert(false, label, `${selector} has no rendered box`);

  if (r.tierLocked && r.inertByDesign) {
    return assert(
      r.onScreen,
      `${label} (inert in Audit Mode - geometry checked)`,
      r.onScreen ? '' :
        `${selector} at ${JSON.stringify(r.rect)} falls outside the ${r.viewport.w}x${r.viewport.h} window`
    );
  }

  assert(
    r.hit,
    label,
    r.hit ? '' : `${selector} at ${JSON.stringify(r.rect)} (window ${r.viewport.w}x${r.viewport.h}) is covered:\n  ` +
      r.blocked.join('\n  ')
  );
}

// ---------------------------------------------------------------- IPC counting
//
// "Does interacting with this screen re-run the scan?" is only answerable by
// counting what actually crossed the bridge. Wrap the real handlers rather than
// adding a counter inside main.js that would then ship to users.

const ipcCounts = new Map();

function instrumentIpc() {
  const { ipcMain } = require('electron');
  const map = ipcMain._invokeHandlers;
  if (!map || !map.forEach) return false;
  for (const channel of Array.from(map.keys())) {
    const original = map.get(channel);
    map.set(channel, (...args) => {
      ipcCounts.set(channel, (ipcCounts.get(channel) || 0) + 1);
      return original(...args);
    });
  }
  return true;
}

const callsTo = (channel) => ipcCounts.get(channel) || 0;

// ---------------------------------------------------------------- sections

async function waitForAppList(timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await js(`(() => ({
      rows: document.querySelectorAll('#apps-tbody .app-row').length,
      loading: !!document.getElementById('initial-loading-row'),
      status: (document.getElementById('filter-status-text') || {}).textContent || ''
    }))()`);
    if (!state.loading && state.rows > 0) return { ...state, elapsedMs: Date.now() - started };
    if (!state.loading && state.rows === 0 && Date.now() - started > 20000) {
      return { ...state, elapsedMs: Date.now() - started };
    }
    await sleep(500);
  }
  return { rows: 0, loading: true, elapsedMs: timeoutMs };
}

async function dismissElevationOffer() {
  const active = await js(
    `document.getElementById('elevation-modal-overlay').classList.contains('active')`
  );
  if (!active) return;
  await js(`document.getElementById('btn-stay-audit').click(); true;`);
  await sleep(600);
}

// --- inventory (7oo.3) -----------------------------------------------------
async function sectionInventory(truth) {
  heading('Inventory: does the list show what is actually installed?');

  const engine = await js(`(async () => {
    const desktop = await window.api.getDesktopApps();
    return desktop.map((a) => ({
      name: a.name, publisher: a.publisher, registryPath: a.registryPath,
      classification: a.classification || null,
      classificationReason: a.classificationReason || '',
      protected: a.protected === true,
      protectionReason: a.protectionReason || ''
    }));
  })()`);

  console.log(`  (registry holds ${truth.entryCount} display-named entries; the engine returned ${engine.length})`);

  const engineNames = new Set(engine.map((a) => String(a.name).toLowerCase()));
  const missing = truth.entries.filter((e) => !engineNames.has(String(e.name).toLowerCase()));

  assert(
    engine.length > 20,
    'the engine returns a real-length desktop list, not a token one',
    `got ${engine.length}`
  );

  // THE DEFECT (7oo.3): SystemComponent=1 and ParentKeyName entries are dropped
  // outright, so real products - antivirus, vendor utilities, language runtimes -
  // are invisible with nothing on screen admitting they exist.
  assert(
    missing.length === 0,
    'every installed entry the registry lists is accounted for by the engine',
    missing.length === 0 ? '' :
      `${missing.length} entries never reach the renderer:\n` +
      missing.slice(0, 25).map((m) =>
        `${m.name}  [${m.hiveLabel}]  ${m.systemComponent ? 'SystemComponent=1' : ''}${m.parentKeyName ? 'ParentKeyName=' + m.parentKeyName : ''}`
      ).join('\n') + (missing.length > 25 ? `\n... and ${missing.length - 25} more` : '')
  );

  // A user must be able to uninstall an application that happens to be
  // published by Microsoft. Only genuine OS components may be held back, and
  // "Microsoft published it" is not evidence of that.
  const ORDINARY_MICROSOFT = /^(Microsoft Edge|Microsoft Office|Microsoft OneDrive|Microsoft Teams|Microsoft Visual Studio Code|Windows Subsystem for Linux)/i;
  const microsoftApps = truth.entries.filter((e) =>
    ORDINARY_MICROSOFT.test(e.name) && e.uninstallerExists && !/WebView2|Runtime|Redistributable/i.test(e.name));
  if (microsoftApps.length === 0) {
    skip('ordinary Microsoft applications are uninstallable', 'none installed on this machine');
  } else {
    console.log(`  (checking ${microsoftApps.length}: ${microsoftApps.map((m) => m.name).join(', ')})`);
    const held = microsoftApps.filter((m) => {
      const row = engine.find((a) => String(a.name).toLowerCase() === String(m.name).toLowerCase());
      return !row || row.protected === true || row.classification !== 'application';
    });
    assert(
      held.length === 0,
      'ordinary Microsoft applications are listed as applications and not protected',
      held.map((h) => {
        const row = engine.find((a) => String(a.name).toLowerCase() === String(h.name).toLowerCase());
        return row ? `${h.name} -> ${row.classification}${row.protected ? ' PROTECTED' : ''}` : `${h.name} -> missing`;
      }).join('\n')
    );
  }

  // Every classification the engine hands back must be one the UI knows how to
  // present, and every component must justify itself.
  const KNOWN = new Set(['application', 'component', 'update']);
  const unknownClass = engine.filter((a) => !KNOWN.has(a.classification));
  assert(
    unknownClass.length === 0,
    'every classification is one the renderer understands',
    unknownClass.map((u) => `${u.name} -> ${u.classification}`).join('\n')
  );

  const unexplained = engine.filter((a) => a.classification === 'component' && !a.classificationReason.trim());
  assert(
    unexplained.length === 0,
    'every component states why it is not a standalone application',
    unexplained.map((u) => u.name).join('\n')
  );

  const applications = engine.filter((a) => a.classification === 'application');
  console.log(`  (${applications.length} applications, ${engine.length - applications.length} components/updates)`);
  assert(
    applications.length >= 20,
    'the default list is still a real list once components are separated out',
    `only ${applications.length} applications`
  );

  // Rule 24: whatever protection survives must say WHY, in the payload, not as
  // a greyed-out control with no explanation.
  const silentlyProtected = engine.filter((a) => a.protected && !a.protectionReason.trim());
  assert(
    silentlyProtected.length === 0,
    'every protected entry states the specific reason it is protected',
    silentlyProtected.map((s) => s.name).join(', ')
  );

  // Anything the engine holds back from the default view has to be reachable
  // and counted on screen - a narrowed list that reads as a complete one is the
  // whole defect.
  const ui = await js(`(() => {
    const status = document.getElementById('filter-status-text').textContent;
    const badge = document.getElementById('components-count');
    const box = document.getElementById('chk-show-components');
    return {
      status,
      badge: badge ? badge.textContent : null,
      toggleExists: !!box,
      rows: document.querySelectorAll('#apps-tbody .app-row').length
    };
  })()`);

  assert(ui.toggleExists, 'the list offers a way to bring components into view');
  assert(
    /component/i.test(ui.status) || ui.badge === '0',
    'the caption says how many entries the default view is holding back',
    `caption: "${ui.status}"`
  );

  // And the toggle has to actually work against real data.
  if (ui.toggleExists) {
    const withComponents = await js(`(async () => {
      const box = document.getElementById('chk-show-components');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 400));
      const rows = document.querySelectorAll('#apps-tbody .app-row').length;
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 400));
      return { rows, backTo: document.querySelectorAll('#apps-tbody .app-row').length };
    })()`);
    assert(
      withComponents.rows > ui.rows,
      'turning components on actually reveals more rows',
      `${ui.rows} -> ${withComponents.rows}`
    );
    assert(
      withComponents.backTo === ui.rows,
      'turning it back off restores the default view',
      `${withComponents.backTo} vs ${ui.rows}`
    );
  }

  return { engine, missing };
}

// --- app list DOM (real length) --------------------------------------------
async function sectionAppList(listState) {
  heading('Application list: real length, real geometry');

  // Leaving the tab and coming back must not re-enumerate the machine. This
  // caught a 10-15 second full rescan firing on every single visit, which
  // blanked the list and discarded the user's sort and search each time.
  const scansBefore = callsTo('get-desktop-apps');
  await goToTab('audit');
  await goToTab('all-apps');
  await sleep(1500);
  assert(
    callsTo('get-desktop-apps') === scansBefore,
    'returning to the application list does not re-scan the machine',
    `${callsTo('get-desktop-apps') - scansBefore} extra full enumeration(s) fired just from switching tabs`
  );

  const dom = await js(`(() => {
    const container = document.querySelector('.apps-list-container');
    const rows = document.querySelectorAll('#apps-tbody .app-row');
    const loaded = (typeof allApps !== 'undefined') ? allApps : [];
    const applications = loaded.filter((a) => a.classification === 'application');
    return {
      rows: rows.length,
      loaded: loaded.length,
      applications: applications.length,
      hidden: loaded.length - applications.length,
      scrollHeight: container ? container.scrollHeight : 0,
      clientHeight: container ? container.clientHeight : 0,
      status: document.getElementById('filter-status-text').textContent
    };
  })()`);

  console.log(`  (${dom.rows} rows rendered from ${dom.loaded} loaded entries, list is ${dom.scrollHeight}px tall in a ${dom.clientHeight}px viewport)`);

  // The default view is applications; components are classified and reachable
  // behind their own toggle (7oo.3). What must never happen is a row going
  // missing without the caption admitting it.
  assert(
    dom.rows === dom.applications,
    'every loaded application has a row',
    `${dom.rows} rows for ${dom.applications} applications (${dom.loaded} entries loaded)`
  );
  assert(
    dom.scrollHeight > dom.clientHeight,
    'the list is long enough to scroll - the condition the fixture suites never reach',
    `scrollHeight ${dom.scrollHeight} <= clientHeight ${dom.clientHeight}`
  );
  assert(
    dom.status.includes(String(dom.applications)),
    'the filter caption states the real total on show',
    dom.status
  );
  assert(
    dom.hidden === 0 || dom.status.includes(String(dom.hidden)),
    'the filter caption states how many entries are being held back',
    `${dom.hidden} hidden, caption says: "${dom.status}"`
  );
  console.log(`  (initial load took ${(listState.elapsedMs / 1000).toFixed(1)}s)`);

  // Select the LAST row: the worst case for geometry, and the one a 1-app
  // fixture can never produce.
  await js(`(() => {
    const rows = document.querySelectorAll('#apps-tbody .app-row');
    rows[rows.length - 1].scrollIntoView();
    rows[rows.length - 1].click();
    return true;
  })()`);
  await sleep(400);

  await assertClickable('#details-sidebar', 'the details panel is on screen once a row is selected');
  await assertClickable('#btn-start-uninstall', 'Clean Uninstall is clickable with the full list loaded');
  await assertClickable('#btn-queue-app', 'Add to bulk queue is clickable with the full list loaded');
  await assertClickable('#search-bar', 'the search box is still reachable over a full list');

  // The panel must not be the thing that overflows: its info list scrolls, the
  // panel itself stays inside the workspace.
  const panelBox = await js(`(() => {
    const p = document.getElementById('details-sidebar');
    const list = p.querySelector('.details-info-list');
    const pr = p.getBoundingClientRect();
    const inner = pr.height - parseFloat(getComputedStyle(p).paddingTop) - parseFloat(getComputedStyle(p).paddingBottom);
    return {
      bottom: Math.round(pr.bottom),
      viewportHeight: window.innerHeight,
      listScrolls: list.scrollHeight > list.clientHeight,
      panelOverflows: p.scrollHeight > p.clientHeight + 1,
      innerHeight: Math.round(inner),
      listHeight: Math.round(list.getBoundingClientRect().height),
      firstRowHeight: list.firstElementChild
        ? Math.round(list.firstElementChild.getBoundingClientRect().height)
        : 0,
      children: Array.from(p.children).map((c) => ({
        cls: c.className || c.tagName,
        h: Math.round(c.getBoundingClientRect().height),
        bottom: Math.round(c.getBoundingClientRect().bottom)
      }))
    };
  })()`);
  assert(
    panelBox.bottom <= panelBox.viewportHeight,
    'the details panel stays inside the window',
    JSON.stringify(panelBox)
  );
  // Nothing may be clipped off the panel: the info list is the only element
  // allowed to run out of room, and it scrolls.
  assert(
    !panelBox.panelOverflows,
    'nothing overflows the details panel - its info list absorbs the pressure and scrolls',
    JSON.stringify(panelBox, null, 1)
  );
  assert(
    panelBox.listScrolls,
    'the info list is the element that scrolls',
    JSON.stringify(panelBox)
  );
  // A list squeezed to zero height satisfies "nothing overflows" while showing
  // the user no information at all. That is a worse failure than the original,
  // and the first pass at this fix produced exactly it - so pin the contract to
  // what a person can actually read.
  assert(
    panelBox.listHeight >= panelBox.firstRowHeight && panelBox.firstRowHeight > 0,
    'the info list shows at least one full row rather than collapsing to nothing',
    JSON.stringify(panelBox, null, 1)
  );

  // The Task Manager details panel is the same component with the same failure
  // mode, so it gets the same contract.
  await js(`document.querySelector('.nav-item[data-tab="task-manager"]').click(); true;`);
  await sleep(4000);
  const picked = await js(`(() => {
    const row = document.querySelector('#process-tbody tr.app-row, #process-tbody tr[data-pid]');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!picked) {
    skip('the process details panel pins its action', 'no process row to select');
  } else {
    await sleep(500);
    await assertClickable('#btn-kill-process', 'End process is on screen with a real process list loaded');
  }
  await js(`document.querySelector('.nav-item[data-tab="all-apps"]').click(); true;`);
  await sleep(500);
}

// --- uninstall wizard (7oo.1) ----------------------------------------------
async function sectionWizard() {
  heading('Uninstall wizard: every action button on every screen, real data behind it');

  // The wizard is opened directly. The Clean Uninstall button is tier-locked in
  // Audit Mode by design (tier-verify.js owns that contract); what is under test
  // here is the wizard's LAYOUT with a real list and a real details panel
  // underneath it, which is the state the operator was looking at.
  const opened = await js(`(() => {
    if (typeof selectedApp === 'undefined' || !selectedApp) return { ok: false, why: 'no app selected' };
    openUninstallWizard(selectedApp);
    return { ok: true, app: selectedApp.name };
  })()`);
  if (!opened.ok) {
    skip('wizard geometry', opened.why);
    return;
  }
  await sleep(700);
  console.log(`  (wizard open on "${opened.app}")`);

  // A realistic screen-5 payload. Real scans return dozens of long paths; the
  // fixture returns two short ones, which is exactly why the tree's scroll
  // geometry has never been exercised.
  await js(`(() => {
    const files = [];
    const registry = [];
    for (let i = 0; i < 60; i++) {
      files.push({
        path: 'C:\\\\Users\\\\Operator\\\\AppData\\\\Roaming\\\\Vendor Name Long\\\\Product Suite ' + i + '\\\\cache\\\\segment-' + i + '.dat',
        type: 'Directory', risk: i % 7 === 0 ? 'Advanced' : (i % 3 === 0 ? 'Moderate' : 'Safe'), sizeBytes: 1024 * (i + 1)
      });
      registry.push({
        path: 'HKLM\\\\Software\\\\Vendor Name Long\\\\Product Suite\\\\Components\\\\Entry' + i,
        type: 'Key', risk: i % 5 === 0 ? 'Advanced' : 'Safe'
      });
    }
    wizState.leftovers = { files, registry };
    renderLeftoversTree();
    return true;
  })()`);

  const screens = [
    ['scr-config', 0, ['.scan-modes-box .mode-card[data-mode="Advanced"]', '.option-toggle-row .toggle-switch .slider']],
    ['scr-restore-loading', 1, []],
    ['scr-native-run', 2, ['#btn-launch-native']],
    ['scr-scan-loading', 3, []],
    ['scr-leftovers-tree', 4, ['#btn-select-all']],
    ['scr-purge-loading', 5, []],
    ['scr-complete', 6, ['#btn-review-quarantine']]
  ];

  const FOOTER = ['#btn-wiz-cancel', '#btn-wiz-back', '#btn-wiz-next', '#btn-wiz-purge', '#btn-wiz-finish'];

  for (const [screenId, index, extras] of screens) {
    await js(`showScreen(${index}); true;`);
    await sleep(350);

    const visibleFooter = await js(`(() => {
      const ids = ${JSON.stringify(FOOTER)};
      return ids.filter((s) => {
        const el = document.querySelector(s);
        return el && getComputedStyle(el).display !== 'none';
      });
    })()`);

    for (const selector of visibleFooter) {
      await assertClickable(selector, `${screenId}: ${selector} is fully clickable`);
    }
    for (const selector of extras) {
      await assertClickable(selector, `${screenId}: ${selector} is fully clickable`);
    }
    await assertClickable('#wiz-close-x', `${screenId}: the close X is fully clickable`);
  }

  // The screen the operator was describing - the tree, scrolled to the bottom,
  // where the footer and a long list share the same 520px modal.
  await js(`showScreen(4); true;`);
  await sleep(300);
  const treeGeometry = await js(`(() => {
    const tree = document.getElementById('leftovers-tree-view');
    tree.scrollTop = tree.scrollHeight;
    const modal = document.querySelector('.wizard-modal').getBoundingClientRect();
    const footer = document.querySelector('.wizard-footer').getBoundingClientRect();
    const screens = document.querySelector('.wizard-screens').getBoundingClientRect();
    return {
      treeScrolls: tree.scrollHeight > tree.clientHeight,
      modalBottom: Math.round(modal.bottom),
      footerBottom: Math.round(footer.bottom),
      footerTop: Math.round(footer.top),
      screensBottom: Math.round(screens.bottom),
      viewportHeight: window.innerHeight
    };
  })()`);
  await sleep(200);

  assert(treeGeometry.treeScrolls, 'the leftovers tree actually scrolls with a real-length finding list');

  // The last checkbox in a 120-item tree: reachable only after scrolling, which
  // is the point - it must be hit-testable once the user has scrolled to it.
  await js(`(() => {
    const items = document.querySelectorAll('#leftovers-tree-view .tree-item');
    items[items.length - 1].scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(300);
  await assertClickable(
    '#leftovers-tree-view .tree-group:last-child .tree-item:last-child input[type="checkbox"]',
    'the last checkbox in a long leftovers tree is clickable once scrolled to'
  );
  assert(
    treeGeometry.footerBottom <= treeGeometry.viewportHeight,
    'the wizard footer sits inside the window, not below its bottom edge',
    JSON.stringify(treeGeometry)
  );
  assert(
    treeGeometry.screensBottom <= treeGeometry.footerTop + 1,
    'the scrolling screen area stops where the footer starts, instead of running under it',
    JSON.stringify(treeGeometry)
  );

  for (const selector of ['#btn-wiz-cancel', '#btn-wiz-purge']) {
    await assertClickable(selector, `scrolled leftovers tree: ${selector} is still fully clickable`);
  }

  await js(`document.getElementById('wizard-modal-overlay').classList.remove('active'); true;`);
  await sleep(300);
}

// --- health advisor (7oo.8) ------------------------------------------------
async function sectionHealthAdvisor(truth) {
  heading('Health Advisor: system overview and storage');

  await goToTab('audit');
  const auditMs = await waitForAuditContent();
  assert(auditMs !== -1, 'the Health Advisor finished loading', 'audit content never became visible');
  if (auditMs === -1) return;
  console.log(auditMs === null
    ? '  (audit data was already loaded from an earlier section - not re-queried)'
    : `  (audit data took ${(auditMs / 1000).toFixed(1)}s)`);

  const audit = await js(`(() => {
    const grid = document.getElementById('audit-sysinfo-grid');
    const diskList = document.getElementById('audit-disk-list');
    const scroll = document.getElementById('audit-scroll-area');
    const panel = document.getElementById('audit-panel');
    const section = grid ? grid.closest('.audit-section') : null;
    return {
      cards: grid ? grid.querySelectorAll('.audit-info-card').length : 0,
      unknownCards: grid
        ? Array.from(grid.querySelectorAll('.card-value')).filter((v) => v.textContent.trim() === 'Unknown').length
        : 0,
      diskRows: diskList ? diskList.querySelectorAll('.disk-bar-row').length : 0,
      diskText: diskList ? diskList.textContent.trim().slice(0, 120) : '',
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      sectionWidth: section ? Math.round(section.getBoundingClientRect().width) : 0,
      scrollWidth: scroll ? Math.round(scroll.getBoundingClientRect().width) : 0,
      startupRows: document.querySelectorAll('#audit-startup-tbody tr').length
    };
  })()`);

  assert(audit.cards >= 6, 'the system overview renders its cards', `got ${audit.cards}`);
  assert(
    audit.unknownCards === 0,
    'no overview card falls back to "Unknown" on a real machine',
    `${audit.unknownCards} of ${audit.cards} cards say Unknown`
  );

  // THE DEFECT (7oo.8): the Storage panel has never rendered anything. The CIM
  // query asks Win32_LogicalDisk for DriveLetter, which belongs to Win32_Volume,
  // so the whole query is invalid and the catch leaves the list empty.
  assert(
    audit.diskRows === truth.diskCount,
    `Storage shows every fixed drive on this machine (${truth.diskCount})`,
    `rendered ${audit.diskRows}; panel says: "${audit.diskText}"`
  );

  // "does not span the screen": the overview section must use the panel's width,
  // not sit in a narrow column with dead space beside it.
  assert(
    audit.sectionWidth > 0 && audit.sectionWidth >= audit.scrollWidth - 48,
    'the System Overview section spans the panel instead of leaving dead width',
    `section ${audit.sectionWidth}px inside a ${audit.scrollWidth}px scroll area`
  );

  assert(audit.startupRows > 0, 'startup items render rows', `got ${audit.startupRows}`);
}

// --- redundancy (7oo.6) ----------------------------------------------------
//
// Same-family entries are not duplicate installations. Edge + Edge Update +
// WebView2 is one product with its updater and its embedded runtime; telling a
// user to "keep only one" is wrong advice, and it is what the current keyword
// matcher produces.
function familyKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(update|updater|runtime|redistributable|helper|service|sdk|webview2?|installer|launcher|bootstrapper|prerequisites?)\b/g, '')
    .replace(/\bv?\d+(\.\d+)*\b/g, '')
    .replace(/\((x64|x86|64-bit|32-bit|user|machine)\)/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
}

async function sectionRedundancy() {
  heading('Redundant software: families are one product, not several installs');

  const redundancy = await js(`window.api.getSoftwareRedundancy()`);
  const groups = (redundancy && redundancy.groups) || [];
  console.log(`  (${groups.length} group(s) reported)`);

  const bogus = [];
  for (const g of groups) {
    const seen = new Map();
    for (const a of g.apps || []) {
      const key = familyKey(a.name);
      if (!key) continue;
      if (seen.has(key)) {
        bogus.push(`${g.category}: "${seen.get(key)}" and "${a.name}" are the same product family`);
      } else {
        seen.set(key, a.name);
      }
    }
    // A group of one, after collapsing families, is not redundancy at all.
    if (seen.size < 2) {
      bogus.push(`${g.category}: reported ${g.count} installed, but they collapse to ${seen.size} product(s)`);
    }
  }

  assert(
    bogus.length === 0,
    'no redundancy group counts same-family entries as separate installations',
    bogus.join('\n')
  );

  const tipsMatch = groups.every((g) => String(g.tip || '').includes(String(g.count)));
  assert(tipsMatch || groups.length === 0, 'each group advises using its own real count');
}

// --- force uninstall (7oo.2) -----------------------------------------------
async function sectionForceUninstall(truth) {
  heading('Force Uninstall: the list matches what is genuinely broken');

  // Ground truth, derived independently of the engine.
  //
  // "Broken" means an entry that PRESENTS ITSELF as a removable application and
  // whose removal path is dead. A component was never independently removable,
  // so "it has no uninstaller" is its normal shape, not a fault: the fifteen
  // NVIDIA container rows on this machine are bookkeeping for the driver
  // package, and offering to force-uninstall them is precisely the "wrong
  // entries which cant be uninstalled" half of the operator's report.
  const looksLikeComponent = (e) =>
    !e.uninstallString ||
    !!e.parentKeyName ||
    /Runtime|Redistributable|_redist|redist |WebView2|Prerequisites?|\sComponents?$/i.test(e.name);

  const trulyBroken = truth.entries.filter((e) =>
    !looksLikeComponent(e) && !e.uninstallerExists && e.uninstallerPath);

  await goToTab('force-uninstall');
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const loading = await js(`document.getElementById('broken-loading').style.display !== 'none'`);
    if (!loading) break;
    await sleep(500);
  }

  const panel = await js(`(() => ({
    listed: Array.from(document.querySelectorAll('#broken-list .vault-entry')).map((el) => ({
      name: el.querySelector('.vault-entry-app').textContent.trim().split('\\n')[0].trim(),
      pill: (el.querySelector('.status-pill') || {}).textContent ? el.querySelector('.status-pill').textContent.trim() : ''
    })),
    emptyShown: document.getElementById('broken-empty').style.display !== 'none',
    emptyText: document.getElementById('broken-empty').textContent.trim()
  }))()`);

  console.log(`  (registry says ${trulyBroken.length} broken; the panel lists ${panel.listed.length})`);

  const listedNames = new Set(panel.listed.map((l) => l.name.toLowerCase()));
  const notListed = trulyBroken.filter((b) => !listedNames.has(String(b.name).toLowerCase()));
  const truthNames = new Set(trulyBroken.map((b) => String(b.name).toLowerCase()));
  const shouldNotBeListed = panel.listed.filter((l) => !truthNames.has(l.name.toLowerCase()));

  // (b) false negatives - "still not displaying all entries"
  assert(
    notListed.length === 0,
    'every genuinely broken entry on this machine is listed',
    notListed.map((n) => `${n.name} [${n.hiveLabel}] ${n.uninstallString ? 'uninstaller missing: ' + n.uninstallerPath : 'no UninstallString'}`).join('\n')
  );

  // (a) false positives - "shows wrong entries which cant be uninstalled"
  assert(
    shouldNotBeListed.length === 0,
    'nothing is listed that is not actually broken',
    shouldNotBeListed.map((s) => s.name).join('\n')
  );

  if (panel.listed.length > 0) {
    await assertClickable('#broken-list .vault-entry [data-force-entry]', 'the first broken entry\'s action button is clickable');
  } else {
    assert(panel.emptyShown, 'an empty list says so rather than showing a blank panel', panel.emptyText);
  }

  await assertClickable('#btn-rescan-broken', 'Re-scan is clickable');
  await assertClickable('#force-name-input', 'the manual search box is reachable');
  await assertClickable('#btn-force-scan', 'the manual Scan button is clickable');

  // A machine with nothing broken cannot prove the DETECTION works - it only
  // proves nothing was falsely reported. --plant creates one genuinely broken
  // entry under HKCU (no elevation, our own key, removed again in the finally
  // below) so the positive path is demonstrated rather than assumed.
  if (!process.argv.includes('--plant')) {
    skip('a genuinely broken entry is detected end to end', 'pass --plant to prove the positive path');
    return;
  }

  console.log('  planting one broken uninstall entry under HKCU...');
  const planted = await plantBrokenEntry();
  if (!planted.ok) {
    assert(false, 'the harness could plant a broken entry', planted.error);
    return;
  }

  try {
    await js(`document.getElementById('btn-rescan-broken').click(); true;`);
    const rescanStart = Date.now();
    while (Date.now() - rescanStart < 180000) {
      const loading = await js(`document.getElementById('broken-loading').style.display !== 'none'`);
      if (!loading) break;
      await sleep(500);
    }

    const after = await js(`(() => ({
      names: Array.from(document.querySelectorAll('#broken-list .vault-entry .vault-entry-app'))
        .map((el) => el.textContent.trim().split('\\n')[0].trim()),
      inAppList: (typeof allApps !== 'undefined')
        ? allApps.filter((a) => a.name === ${JSON.stringify(PLANTED_NAME)})
            .map((a) => ({ classification: a.classification, actionable: a.actionable }))
        : []
    }))()`);

    assert(
      after.names.some((n) => n.includes(PLANTED_NAME)),
      'a genuinely broken entry is detected and listed',
      `Force Uninstall listed: ${after.names.join(', ') || '(nothing)'}`
    );
    if (after.names.some((n) => n.includes(PLANTED_NAME))) {
      await assertClickable('#broken-list .vault-entry [data-force-entry]', 'the detected entry offers a working action');
    }

    // The same entry must also be an ordinary application in the main list -
    // the two surfaces read one classified inventory now, so they cannot
    // disagree the way they used to.
    await js(`loadApplications(); true;`);
    await waitForAppList();
    const listed = await js(`(typeof allApps !== 'undefined')
      ? allApps.filter((a) => a.name === ${JSON.stringify(PLANTED_NAME)})
          .map((a) => ({ classification: a.classification, actionable: a.actionable }))
      : []`);
    assert(
      listed.length === 1 && listed[0].classification === 'application' && listed[0].actionable === false,
      'the same entry appears in the app list as an application whose uninstaller is gone',
      JSON.stringify(listed)
    );
  } finally {
    const removed = await removePlantedEntry();
    assert(removed.ok, 'the harness removed its planted entry again', removed.error);
  }
}

// --- planted probe (only with --plant) -------------------------------------

const PLANTED_NAME = 'Vanish Harness Probe (safe to delete)';
const PLANTED_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VanishRealDataProbe';

function runPowerShellSnippet(script) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => resolve({ ok: code === 0, error: err.trim() }));
  });
}

// Same, but hands back what the snippet printed - for ground-truth counts.
function runPowerShellCapture(script) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => resolve({ ok: code === 0, stdout: out, error: err.trim() }));
  });
}

function plantBrokenEntry() {
  return runPowerShellSnippet(
    `New-Item -Path '${PLANTED_KEY}' -Force | Out-Null; ` +
    `New-ItemProperty -Path '${PLANTED_KEY}' -Name DisplayName -Value '${PLANTED_NAME}' -PropertyType String -Force | Out-Null; ` +
    `New-ItemProperty -Path '${PLANTED_KEY}' -Name Publisher -Value 'Vanish test harness' -PropertyType String -Force | Out-Null; ` +
    `New-ItemProperty -Path '${PLANTED_KEY}' -Name DisplayVersion -Value '0.0.0' -PropertyType String -Force | Out-Null; ` +
    `New-ItemProperty -Path '${PLANTED_KEY}' -Name UninstallString ` +
    `-Value '"C:\\Program Files\\VanishHarnessNoSuchApp\\uninstall.exe" /S' -PropertyType String -Force | Out-Null`
  );
}

function removePlantedEntry() {
  return runPowerShellSnippet(
    `if (Test-Path '${PLANTED_KEY}') { Remove-Item -Path '${PLANTED_KEY}' -Recurse -Force }`
  );
}

// --- system clean (7oo.5) --------------------------------------------------
async function sectionSystemClean() {
  heading('System Clean: scan once, and say when a count is still partial');

  await goToTab('system-clean');

  const ids = await js(`(typeof CLEANERS !== 'undefined') ? CLEANERS.filter((c) => !c.needsKeyword).map((c) => c.id) : []`);
  if (!ids || ids.length === 0) {
    skip('System Clean', 'no cleaner sections rendered');
    return;
  }
  // Exercise the cleaner most likely to be slow, so the progress contract is
  // actually tested rather than skipped. "associations" walks every ProgId in
  // HKCR; "context-menus" now finishes in about a second.
  const target = ids.includes('associations') ? 'associations' : ids[0];
  const sel = `#cleaner-${target}`;
  console.log(`  (${ids.length} cleaners; exercising "${target}")`);

  const before = callsTo('cleaner-scan');
  await js(`scanCleaner(${JSON.stringify(target)}); true;`);

  // 6g2: while the scan runs, the panel must keep saying something that
  // demonstrably changes. A spinner over static text is what made a 180-second
  // sweep indistinguishable from a hang.
  const progressSamples = [];
  let badgeWhileScanning = null;
  const started = Date.now();
  while (Date.now() - started < 300000) {
    const snap = await js(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { busy: false };
      const progress = document.getElementById('cleaner-progress-${target}');
      const badge = document.getElementById('cleaner-count-${target}');
      return {
        busy: /fa-spin/i.test(el.innerHTML),
        text: progress ? progress.textContent.trim() : '',
        badge: badge ? badge.textContent.trim() : ''
      };
    })()`);
    if (!snap.busy) break;
    if (snap.text) progressSamples.push(snap.text);
    if (badgeWhileScanning === null && snap.badge) badgeWhileScanning = snap.badge;
    await sleep(1200);
  }
  const afterScan = callsTo('cleaner-scan');
  const elapsed = (Date.now() - started) / 1000;
  console.log(`  (first scan took ${elapsed.toFixed(1)}s, ${afterScan - before} engine call(s))`);
  if (progressSamples.length) {
    console.log(`  (first progress line: "${progressSamples[0]}")`);
    console.log(`  (last  progress line: "${progressSamples[progressSamples.length - 1]}")`);
  }

  assert(afterScan - before === 1, 'one scan request produces exactly one engine call', `${afterScan - before} calls`);

  if (elapsed < 3) {
    skip('a long scan reports progress while it runs', `this cleaner finished in ${elapsed.toFixed(1)}s`);
  } else {
    const distinct = new Set(progressSamples);
    assert(
      progressSamples.length > 0,
      'the panel says something while the scan runs',
      'no progress element was rendered'
    );
    assert(
      distinct.size > 1,
      'what it says actually changes - a static line is indistinguishable from a hang',
      `${progressSamples.length} samples, all identical: "${progressSamples[0] || ''}"`
    );
    assert(
      badgeWhileScanning !== null && !/^\d+$/.test(badgeWhileScanning),
      'the count is not presented as a final number while the scan is still running',
      `badge read "${badgeWhileScanning}" mid-scan`
    );
  }

  const snapshot = () => js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { rows: 0, badge: '', checked: 0 };
    return {
      rows: el.querySelectorAll('.finding-row').length,
      badge: (document.getElementById('cleaner-count-${target}') || {}).textContent || '',
      checked: el.querySelectorAll('.finding-row input[type=checkbox]:checked').length
    };
  })()`);

  const countBefore = await snapshot();

  // Ticking a checkbox, collapsing, re-expanding, leaving the tab and coming
  // back - none of these are new evidence about the machine, so none may re-run
  // the scan, and none may lose what the user already ticked.
  await js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const box = el.querySelector('.finding-row input[type=checkbox]:not([disabled])');
    if (box) box.click();
    return true;
  })()`);
  await sleep(400);
  const afterTick = await snapshot();

  await js(`(() => {
    const header = document.querySelector(${JSON.stringify(sel)} + ' .cleaner-section-header');
    if (header) { header.click(); header.click(); }
    return true;
  })()`);
  await sleep(800);

  await js(`document.querySelector('.nav-item[data-tab="all-apps"]').click(); true;`);
  await sleep(500);
  await js(`document.querySelector('.nav-item[data-tab="system-clean"]').click(); true;`);
  await sleep(1200);

  const afterInteraction = callsTo('cleaner-scan');
  assert(
    afterInteraction === afterScan,
    'collapsing, re-expanding and revisiting the tab does not re-run the scan',
    `${afterInteraction - afterScan} extra engine call(s) fired just from interacting`
  );

  const countAfter = await snapshot();
  assert(
    countAfter.rows === countBefore.rows && countAfter.badge === countBefore.badge,
    'the finding count is stable across interaction',
    `${countBefore.rows} rows/badge "${countBefore.badge}" -> ${countAfter.rows} rows/badge "${countAfter.badge}"`
  );
  if (afterTick.checked > 0) {
    assert(
      countAfter.checked === afterTick.checked,
      'a selection survives collapsing the section and leaving the tab',
      `${afterTick.checked} ticked -> ${countAfter.checked} still ticked`
    );
  } else {
    skip('a selection survives navigation', 'nothing selectable in this cleaner');
  }
}

// --- startup items (7oo.4) -------------------------------------------------
async function sectionStartupItems(truth) {
  heading('Startup items: an orphan the app shows is an orphan the app can act on');

  const startup = await js(`window.api.getStartupItems()`);
  const items = (startup && startup.items) || [];
  const orphans = items.filter((i) => i.exeExists === false);
  console.log(`  (${items.length} startup items, ${orphans.length} orphaned, orphan count reported as ${JSON.stringify(startup.orphans)})`);

  // A count that serialises as null reads as 0 downstream and hides the badge.
  assert(
    typeof startup.orphans === 'number' && startup.orphans === orphans.length,
    'the reported orphan count is a real number that matches the items',
    `reported ${JSON.stringify(startup.orphans)}, items say ${orphans.length}`
  );

  // Reporting a healthy entry as orphaned is the app telling the user something
  // false about their own machine. Verify each claim against the filesystem.
  const wronglyFlagged = [];
  for (const o of orphans) {
    if (!o.exePath) continue;
    const exists = await runPowerShellSnippet(
      `if (Test-Path -LiteralPath ${JSON.stringify(o.exePath)}) { exit 0 } else { exit 3 }`
    );
    if (exists.ok) wronglyFlagged.push(`${o.name} -> ${o.exePath} exists`);
  }
  assert(
    wronglyFlagged.length === 0,
    'every entry reported as orphaned really is missing from disk',
    wronglyFlagged.join('\n')
  );

  await goToTab('audit');
  const auditMs = await waitForAuditContent();
  assert(auditMs !== -1, 'the Health Advisor finished loading', 'audit content never became visible');
  if (auditMs === -1) return;

  const rendered = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#audit-startup-tbody tr.app-row'));
    const suggestions = Array.from(document.querySelectorAll('#audit-startup-tbody .startup-suggestion'));
    const note = document.getElementById('audit-startup-note');
    return {
      rows: rows.length,
      orphanRows: rows.filter((r) => r.querySelector('.status-dot.orphan')).length,
      actionable: rows.filter((r) => r.querySelector('button, a, input')).length,
      suggestions: suggestions.length,
      suggestionText: suggestions.map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
      noteText: note ? note.textContent.trim() : '',
      badgeShown: document.getElementById('audit-orphan-count').style.display !== 'none'
    };
  })()`);

  assert(rendered.rows === items.length, 'every startup item the engine found has a row', `${rendered.rows} vs ${items.length}`);
  assert(
    rendered.orphanRows === orphans.length,
    'every orphaned startup item is marked as orphaned',
    `${rendered.orphanRows} marked vs ${orphans.length} found`
  );

  // The contract (7oo.4, now satisfied the other way by 7oo.11): a finding is
  // EITHER actionable - a control that really resolves it - OR informational,
  // saying so and naming a concrete next step. What is forbidden is the middle:
  // a control that renders and does nothing. These rows now carry controls, so
  // the controls are what get verified.
  const withAction = items.filter((i) => i.action);
  assert(
    rendered.actionable === withAction.length,
    'every startup item the engine says it can act on has a control on its row',
    `${rendered.actionable} controls for ${withAction.length} actionable items`
  );
  assert(
    rendered.noteText.length > 0,
    'the panel says what happens to what it changes',
    'note is empty'
  );

  if (withAction.length > 0) {
    // Hit-tested, not merely present: a button under another element is the
    // defect this harness exists for (7oo.1). The list is longer than the
    // window on any real machine, so scroll the row into view first - a control
    // below the fold is a scroll away, not a defect, and conflating the two
    // would make this assertion depend on how many programs are installed.
    await js(`(() => {
      const btn = document.querySelector('#audit-startup-tbody tr.app-row button.startup-action-btn');
      if (btn) btn.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(400);
    await assertClickable('#audit-startup-tbody tr.app-row button.startup-action-btn', 'the first startup action button is reachable');

    const locks = await js(`(() => {
      const btns = Array.from(document.querySelectorAll('#audit-startup-tbody button.startup-action-btn'));
      return {
        total: btns.length,
        locked: btns.filter((b) => b.classList.contains('tier-locked')).length,
        labelled: btns.filter((b) => (b.textContent || '').trim().length > 0).length,
        titled: btns.filter((b) => (b.getAttribute('title') || '').trim().length > 0).length
      };
    })()`);

    assert(locks.labelled === locks.total, 'every action button says what it does', `${locks.labelled}/${locks.total} labelled`);
    assert(locks.titled === locks.total, 'every action button explains itself on hover', `${locks.titled}/${locks.total} carry a title`);

    if (truth.isAdmin) {
      assert(locks.locked === 0, 'in Full Mode the actions are live', `${locks.locked} still locked`);
    } else {
      assert(
        locks.locked === locks.total,
        'in Audit Mode every action is visibly inert rather than a button that fails when pressed',
        `${locks.locked}/${locks.total} locked`
      );

      // And the refusal is real on the backend, not just a CSS class: ask the
      // IPC directly. Read-only - a rejected call changes nothing.
      const refused = await js(`window.api.startupAction({
        action: 'registry-remove',
        item: ${JSON.stringify({
          name: 'harness probe',
          keyPath: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          valueName: 'VanishNoSuchStartupEntry',
          registryPath: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          managePath: 'probe'
        })}
      })`);
      assert(
        refused && refused.success === false && /audit mode|full mode|administrator/i.test(String(refused.error)),
        'the engine refuses a startup change in Audit Mode, and says why',
        JSON.stringify(refused)
      );
    }
  }

  if (orphans.length === 0) {
    skip('orphaned startup items carry a next step', 'no orphans on this machine');
  } else {
    assert(
      rendered.suggestions === orphans.length,
      'every orphaned startup item carries a suggestion on screen',
      `${rendered.suggestions} suggestions for ${orphans.length} orphans`
    );
    // A suggestion that does not name where to go is not a suggestion.
    const vague = rendered.suggestionText.filter(
      (t) => !/taskschd\.msc|services\.msc|sc\.exe|HKLM|HKCU|Run/i.test(t)
    );
    assert(
      vague.length === 0,
      'each suggestion names the concrete place the entry is managed',
      vague.join('\n')
    );
    assert(rendered.badgeShown, 'the orphan count badge is visible when orphans exist');
  }
}

// --- windows optional features (7oo.7) -------------------------------------
async function sectionWindowsFeatures() {
  heading('Windows optional features: listed, counted, and never falsely actionable');
  await goToTab('all-apps');

  // Ground truth from the machine, independent of the engine.
  const truthOut = await runPowerShellCapture(
    '@(Get-CimInstance -ClassName Win32_OptionalFeature).Count'
  );
  const truthCount = parseInt(String(truthOut.stdout).trim(), 10);
  console.log(`  (Windows reports ${truthCount} optional features)`);

  const before = await js(`document.querySelectorAll('#apps-tbody .app-row').length`);

  const toggled = await js(`(async () => {
    const box = document.getElementById('chk-show-features');
    if (!box) return { missing: true };
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    // The query runs on demand, so give it real time.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (typeof featuresLoaded !== 'undefined' && featuresLoaded) break;
    }
    await new Promise((r) => setTimeout(r, 400));
    return {
      missing: false,
      loaded: typeof windowsFeatures !== 'undefined' ? windowsFeatures.length : -1,
      rows: document.querySelectorAll('#apps-tbody .app-row').length,
      featureRows: document.querySelectorAll('#apps-tbody .badge-type.feature').length,
      badge: (document.getElementById('features-count') || {}).textContent,
      status: document.getElementById('filter-status-text').textContent,
      states: (typeof windowsFeatures !== 'undefined')
        ? Array.from(new Set(windowsFeatures.map((f) => f.state))) : []
    };
  })()`);

  if (toggled.missing) {
    assert(false, 'the app list offers a Windows features toggle', 'no #chk-show-features control');
    return;
  }

  assert(
    Number.isFinite(truthCount) && toggled.loaded === truthCount,
    'every optional feature Windows reports is listed',
    `engine ${toggled.loaded} vs Windows ${truthCount}`
  );
  assert(
    toggled.featureRows === toggled.loaded,
    'each one renders as a row marked as a feature',
    `${toggled.featureRows} feature rows for ${toggled.loaded} features`
  );
  assert(
    toggled.rows === before + toggled.loaded,
    'features are added to the list rather than replacing the applications',
    `${before} -> ${toggled.rows}`
  );
  assert(
    /Windows feature/i.test(toggled.status),
    'the caption says the list now includes Windows features',
    toggled.status
  );
  assert(
    String(toggled.badge) === String(toggled.loaded),
    'the toggle shows the real count',
    `badge "${toggled.badge}" vs ${toggled.loaded}`
  );
  // Real enabled/disabled state, not a placeholder.
  assert(
    toggled.states.some((s) => /enabled/i.test(s)) && toggled.states.length > 1,
    'features carry their real on/off state',
    `states seen: ${toggled.states.join(', ')}`
  );

  // Selecting one must not offer an uninstall it cannot perform.
  const picked = await js(`(() => {
    const badge = document.querySelector('#apps-tbody .badge-type.feature');
    if (!badge) return { ok: false };
    badge.closest('tr').click();
    return { ok: true };
  })()`);
  if (picked.ok) {
    await sleep(400);
    const panel = await js(`(() => ({
      label: document.querySelector('#btn-start-uninstall span').textContent.trim(),
      note: document.getElementById('det-note-text').textContent,
      noteShown: document.getElementById('det-note').style.display !== 'none'
    }))()`);
    assert(
      panel.label !== 'Clean Uninstall',
      'a feature does not present an uninstall action Vanish cannot perform',
      `button reads "${panel.label}"`
    );
    assert(
      panel.noteShown && /optionalfeatures\.exe|Turn Windows features/i.test(panel.note),
      'and it names where the user can actually change it',
      panel.note
    );
  }

  // Turning it back off must restore the default view exactly.
  const off = await js(`(async () => {
    const box = document.getElementById('chk-show-features');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelectorAll('#apps-tbody .app-row').length;
  })()`);
  assert(off === before, 'turning the toggle off restores the default view', `${off} vs ${before}`);
}

// --- left-over Store app data (udu) ----------------------------------------
// The claim under test is a safety claim: on THIS machine, with these real
// packages, nothing the sweep offers to delete belongs to an app that is still
// installed. A stub cannot make that claim - it has no package list to be
// wrong about.
async function sectionUwpLeftovers() {
  heading('Left-over Store app data: only folders whose app is genuinely gone');
  await goToTab('system-clean');

  const known = await js(`(typeof CLEANERS !== 'undefined') ? CLEANERS.some((c) => c.id === 'uwp-leftovers') : false`);
  if (!known) {
    assert(false, 'System Clean offers a left-over Store app data sweep', 'no such cleaner is registered');
    return;
  }

  // Ground truth straight from Windows, not from the engine under test.
  const truthOut = await runPowerShellCapture(
    '@(Get-AppxPackage | ForEach-Object { $_.PackageFamilyName }) -join "|"'
  );
  const installedFamilies = new Set(
    String(truthOut.stdout).trim().split('|').filter(Boolean).map((f) => f.toLowerCase())
  );
  console.log(`  (Windows registers ${installedFamilies.size} package families for this user)`);

  await js(`scanCleaner('uwp-leftovers'); true;`);
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const busy = await js(`cleanerState['uwp-leftovers'].loading === true`);
    if (!busy) break;
    await sleep(1000);
  }

  const state = await js(`(() => {
    const s = cleanerState['uwp-leftovers'];
    return {
      scanned: s.scanned, error: s.error, note: s.note,
      findings: s.findings.map((f) => ({
        family: (f.meta && f.meta.family) || null,
        kind: f.kind, risk: f.risk, removable: f.removable !== false,
        path: f.path || null, sizeBytes: f.sizeBytes || 0, label: f.label
      })),
      rows: document.querySelectorAll('#cleaner-uwp-leftovers .finding-row').length,
      disabled: document.querySelectorAll('#cleaner-uwp-leftovers .finding-row input[disabled]').length
    };
  })()`);

  assert(state.scanned === true && !state.error, 'the sweep completes on real data', state.error || 'never finished');
  if (!state.scanned) return;

  const folders = state.findings.filter((f) => f.kind === 'file');
  console.log(`  (${state.findings.length} finding(s), ${folders.length} folder(s), ${state.rows} row(s) on screen)`);
  if (state.note) console.log(`  (note: ${state.note})`);

  const stillInstalled = folders.filter((f) => f.removable && f.family && installedFamilies.has(f.family.toLowerCase()));
  assert(
    stillInstalled.length === 0,
    'no folder belonging to a package Windows still registers is offered for removal',
    stillInstalled.map((f) => f.family).join(', ')
  );

  const windowsOwned = folders.filter((f) => f.removable && /^(microsoft\.windows\.|microsoftwindows\.|windows\.)/i.test(f.family || ''));
  assert(
    windowsOwned.length === 0,
    "Windows' own app data is never offered for removal",
    windowsOwned.map((f) => f.family).join(', ')
  );

  assert(
    state.findings.length === state.rows,
    'every finding the engine returned is actually on screen',
    `${state.findings.length} findings, ${state.rows} rows`
  );

  const unremovable = state.findings.filter((f) => !f.removable).length;
  assert(
    state.disabled === unremovable,
    'anything Vanish will not remove cannot be ticked',
    `${unremovable} unremovable, ${state.disabled} disabled checkbox(es)`
  );

  if (folders.length === 0) {
    skip('the measured size matches the folder on disk', 'this machine has no left-over package folders');
    assert(
      Boolean(state.note),
      'an empty result explains what was checked rather than showing a bare zero',
      'no note was returned'
    );
    return;
  }

  // Every path must be real, and inside the folder this sweep is allowed to
  // touch. A finding pointing anywhere else is a purge aimed off target.
  const packagesRoot = `${process.env.LOCALAPPDATA}\\Packages\\`.toLowerCase();
  const strays = folders.filter((f) => !f.path || !f.path.toLowerCase().startsWith(packagesRoot));
  assert(strays.length === 0, 'every folder named is inside this account\'s package data folder', strays.map((f) => f.path).join(', '));

  const missing = [];
  for (const f of folders) {
    const probe = await runPowerShellCapture(`Test-Path -LiteralPath '${f.path}'`);
    if (String(probe.stdout).trim() !== 'True') missing.push(f.path);
  }
  assert(missing.length === 0, 'every folder named still exists on disk', missing.join(', '));

  // Size is the number the user decides on, so it is measured against the
  // machine rather than trusted. The helper behind it returned a flat zero for
  // every folder on earth until this release.
  const biggest = folders.slice().sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  const sizeOut = await runPowerShellCapture(
    `(Get-ChildItem -LiteralPath '${biggest.path}' -Recurse -File -Force -ErrorAction SilentlyContinue | ` +
    `Measure-Object -Property Length -Sum).Sum`
  );
  const realBytes = parseInt(String(sizeOut.stdout).trim(), 10) || 0;
  const delta = realBytes > 0 ? Math.abs(biggest.sizeBytes - realBytes) / realBytes : 0;
  assert(
    delta < 0.05,
    `the measured size matches the folder on disk (${biggest.label})`,
    `engine ${biggest.sizeBytes} vs disk ${realBytes}`
  );
}

// --- quarantine details (7oo.9) --------------------------------------------
async function sectionQuarantine() {
  heading('Quarantine: does an entry answer what a worried person asks first?');
  await goToTab('quarantine');
  await sleep(1200);

  const live = await js(`(() => ({
    entries: document.querySelectorAll('#vault-entries .vault-entry').length,
    emptyShown: document.getElementById('vault-empty').style.display !== 'none',
    errorShown: document.getElementById('vault-error').style.display !== 'none',
    errorText: document.getElementById('vault-error-text').textContent
  }))()`);

  assert(!live.errorShown, 'the vault reads without error', live.errorText);
  console.log(`  (the real vault on this machine holds ${live.entries} entr${live.entries === 1 ? 'y' : 'ies'})`);

  if (live.entries === 0) {
    assert(live.emptyShown, 'an empty vault says so rather than showing a blank panel');
  }

  // 7oo.9 is a presentation defect, and the operator's vault is empty because
  // the app was too broken to have quarantined anything. So drive the REAL
  // renderer with entries in the real manifest shape, under both retention
  // settings - that is the code path a user hits, and the fate line is the
  // whole point of the fix, so it has to be exercised both ways.
  const rendered = await js(`(() => {
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
    const sample = {
      id: 'harness-entry',
      sourceApp: 'Some Removed Application',
      origin: 'system-clean/context-menus',
      status: 'quarantined',
      createdAt: iso(3),
      sizeBytes: 4 * 1024 * 1024,
      vaultPath: 'C:\\\\Users\\\\Operator\\\\AppData\\\\Roaming\\\\vanish\\\\vault\\\\harness-entry',
      files: [{ originalPath: 'C:\\\\Program Files\\\\Some App\\\\leftover.dll', status: 'quarantined' }],
      registry: [{ keyPath: 'HKLM\\\\Software\\\\Some App', status: 'quarantined' }]
    };

    const readBack = () => {
      const el = document.querySelector('#vault-entries .vault-entry');
      return {
        summary: el.querySelector('.vault-entry-summary').textContent.replace(/\\s+/g, ' ').trim(),
        from: el.querySelector('.vault-entry-from').textContent.replace(/\\s+/g, ' ').trim(),
        fate: el.querySelector('.vault-entry-fate').textContent.replace(/\\s+/g, ' ').trim(),
        fateKind: el.querySelector('.vault-entry-fate').className,
        restoreButton: !!el.querySelector('[data-action="restore"]'),
        collapsedText: el.querySelector('.vault-entry-header').textContent.replace(/\\s+/g, ' ').trim()
      };
    };

    const host = document.getElementById('vault-entries');
    const saved = { auto: appSettings.autoPurgeEnabled, days: appSettings.autoPurgeRetentionDays };

    appSettings.autoPurgeEnabled = false;
    host.innerHTML = renderVaultEntry(sample);
    const kept = readBack();

    appSettings.autoPurgeEnabled = true;
    appSettings.autoPurgeRetentionDays = 30;
    host.innerHTML = renderVaultEntry(sample);
    const expiring = readBack();

    appSettings.autoPurgeEnabled = saved.auto;
    appSettings.autoPurgeRetentionDays = saved.days;
    host.innerHTML = '';
    return { kept, expiring };
  })()`);

  const { kept, expiring } = rendered;

  // What it was, and when - in words, without expanding anything.
  assert(
    /removed 3 days ago/i.test(kept.summary),
    'the entry says when it happened in human terms, not just a timestamp',
    kept.summary
  );
  // Where it came from.
  assert(
    /Program Files/i.test(kept.from),
    'the original location is visible without expanding the entry',
    kept.from
  );
  // Which surface did it - in the user's words, not the internal route.
  assert(
    /System Clean/i.test(kept.summary) && !/system-clean\//i.test(kept.summary),
    'it names the surface that removed it in plain words, not an internal route',
    kept.summary
  );
  // Can I get it back.
  assert(kept.restoreButton, 'restoring is offered directly on the entry');

  // What happens if I do nothing - the question the screen never answered.
  assert(
    /until you/i.test(kept.fate),
    'with automatic purge off, the entry says it will simply stay',
    kept.fate
  );
  assert(
    /calm/.test(kept.fateKind),
    'and says it calmly rather than as a warning',
    kept.fateKind
  );
  assert(
    /deleted permanently on .+ in 27 days/i.test(expiring.fate),
    'with automatic purge on, it states the actual date and the days remaining',
    expiring.fate
  );
  assert(
    /warn/.test(expiring.fateKind),
    'and marks that as something to be aware of',
    expiring.fateKind
  );

  await goToTab('all-apps');
}

// --- every tab survives real data ------------------------------------------
async function sectionTabs() {
  heading('Every tab renders with real data behind it');

  const tabs = ['all-apps', 'audit', 'task-manager', 'system-clean', 'quarantine', 'force-uninstall', 'settings', 'about'];
  for (const tab of tabs) {
    await assertClickable(`.nav-item[data-tab="${tab}"]`, `the ${tab} tab is clickable`);
    await js(`document.querySelector('.nav-item[data-tab="${tab}"]').click(); true;`);
    await sleep(700);

    const state = await js(`(() => {
      const visible = Array.from(document.querySelectorAll('.content-area'))
        .filter((el) => getComputedStyle(el).display !== 'none');
      const el = visible[0];
      if (!el) return { none: true };
      const r = el.getBoundingClientRect();
      return {
        none: false, count: visible.length,
        width: Math.round(r.width), height: Math.round(r.height),
        overflowsRight: Math.round(r.right) > window.innerWidth + 1,
        bodyScrollsSideways: document.body.scrollWidth > window.innerWidth + 1
      };
    })()`);

    assert(!state.none && state.count === 1, `${tab}: exactly one panel is visible`, JSON.stringify(state));
    assert(state.width > 300 && state.height > 200, `${tab}: the panel has a real box`, JSON.stringify(state));
    assert(!state.overflowsRight, `${tab}: the panel does not run off the right edge`, JSON.stringify(state));
    assert(!state.bodyScrollsSideways, `${tab}: the window does not scroll sideways`, JSON.stringify(state));
  }
}

// ---------------------------------------------------------------- runner

const SECTIONS = {
  inventory: sectionInventory,
  applist: sectionAppList,
  wizard: sectionWizard,
  storage: sectionHealthAdvisor,
  redundancy: sectionRedundancy,
  force: sectionForceUninstall,
  clean: sectionSystemClean,
  uwp: sectionUwpLeftovers,
  startup: sectionStartupItems,
  features: sectionWindowsFeatures,
  quarantine: sectionQuarantine,
  tabs: sectionTabs
};

// The app's minimum, the app's default, and a roomy desktop. --sweep runs the
// geometry sections at each.
const SWEEP_SIZES = [
  { width: 800, height: 600 },
  { width: 1080, height: 720 },
  { width: 1440, height: 900 }
];

// main.js createWindow() opens 1080x720 with a 800x600 minimum. Those are the
// sizes a user actually has; anything larger here is the harness flattering the
// app.
function windowSize() {
  const arg = process.argv.find((a) => a.startsWith('--size='));
  if (!arg) return { width: 1080, height: 720 };
  const m = /^(\d+)x(\d+)$/.exec(arg.slice('--size='.length));
  if (!m) {
    console.error('--size expects WIDTHxHEIGHT, e.g. --size=800x600');
    process.exit(2);
  }
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function requestedSections() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return Object.keys(SECTIONS);
  const names = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !SECTIONS[n]);
  if (unknown.length) {
    console.error(`Unknown section(s): ${unknown.join(', ')}. Known: ${Object.keys(SECTIONS).join(', ')}`);
    process.exit(2);
  }
  return names;
}

app.whenReady().then(async () => {
  await main.bootstrapped;

  console.log('');
  console.log('Vanish REAL-DATA verification');
  console.log('=============================');
  console.log('This runs the real preload against the real backend on THIS machine.');
  console.log('Results depend on what is installed here. Read the failures; do not count them.');

  if (!instrumentIpc()) {
    console.log('WARNING: could not instrument ipcMain - scan-count assertions will be skipped.');
  }

  console.log('');
  console.log('Reading ground truth from the machine...');
  let truth;
  try {
    truth = await runTruthProbe();
  } catch (err) {
    console.error(`Could not establish ground truth: ${err.message}`);
    app.exit(2);
    return;
  }
  console.log(`  registry uninstall entries: ${truth.entryCount}`);
  console.log(`  fixed drives:               ${truth.diskCount}`);
  console.log(`  appx packages:              ${truth.appxCount}`);
  console.log(`  elevated:                   ${truth.isAdmin}`);

  const size = windowSize();
  console.log(`  window:                     ${size.width}x${size.height}`);

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    title: 'VANISH REAL-DATA HARNESS - not the application',
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      // Chromium freezes timers in a hidden page, so an elapsed-time counter
      // measured here would read 0s forever and the harness would report a
      // working ticker as broken. The real window is visible and never
      // throttled; this only removes an artefact of measuring offscreen.
      backgroundThrottling: false
    }
  });

  // A renderer exception used to surface here only as "0 rows", several
  // assertions downstream of the actual cause. Surface it where it happens.
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level < 2) return; // warnings and errors only
    const where = sourceId ? `${sourceId.split('/').pop()}:${line}` : '';
    console.log(`  [renderer ${level === 2 ? 'warn' : 'error'}] ${message} ${where}`);
    if (level >= 3) rendererErrors.push(`${message} (${where})`);
  });

  await win.loadFile(path.join(ROOT, 'index.html'));

  console.log('');
  console.log('Waiting for the real application list (this is genuinely slow)...');
  const listState = await waitForAppList();
  await dismissElevationOffer();

  if (listState.rows === 0) {
    console.error('The application list never rendered a row. Nothing below would mean anything.');
    app.exit(2);
    return;
  }

  const names = requestedSections();
  const runSections = async () => {
    for (const name of names) {
      try {
        if (name === 'applist') await SECTIONS[name](listState);
        else if (name === 'inventory' || name === 'storage' || name === 'force' || name === 'startup') await SECTIONS[name](truth);
        else await SECTIONS[name]();
      } catch (err) {
        section = name;
        assert(false, `${name}: the section itself threw`, err.stack || err.message);
      }
    }
  };

  await runSections();

  // --sweep re-runs the geometry-bearing sections at the other window sizes a
  // user can actually produce. Layout that holds at one size and breaks at
  // another is the same class of miss as layout that holds against a fixture
  // and breaks against real data: the first pass at the details-panel fix
  // passed at 1080x720 and still collapsed the info list to zero height at the
  // app's own 800x600 minimum.
  if (process.argv.includes('--sweep')) {
    const geometry = names.filter((n) => n === 'applist' || n === 'wizard' || n === 'tabs');
    for (const sweepSize of SWEEP_SIZES) {
      if (sweepSize.width === size.width && sweepSize.height === size.height) continue;
      if (geometry.length === 0) break;

      console.log('');
      console.log(`### re-running geometry sections at ${sweepSize.width}x${sweepSize.height}`);
      win.setSize(sweepSize.width, sweepSize.height);
      await sleep(400);
      await win.webContents.reload();
      const swept = await waitForAppList();
      await dismissElevationOffer();
      if (swept.rows === 0) {
        assert(false, `sweep ${sweepSize.width}x${sweepSize.height}: the app list never rendered`);
        continue;
      }
      for (const name of geometry) {
        try {
          section = `${name} @ ${sweepSize.width}x${sweepSize.height}`;
          if (name === 'applist') await SECTIONS[name](swept);
          else await SECTIONS[name]();
        } catch (err) {
          assert(false, `${name}: the section itself threw`, err.stack || err.message);
        }
      }
    }
  }

  // An uncaught renderer exception is a failure whether or not an assertion
  // happened to notice it.
  section = 'renderer console';
  assert(
    rendererErrors.length === 0,
    'the renderer logged no errors during the run',
    rendererErrors.join('\n')
  );

  // A pass total that does not state its own boundary is the exact problem this
  // file was built to end. Say what was NOT checked, every run, unprompted.
  console.log('');
  console.log('-'.repeat(72));
  console.log('Not verified by this run:');
  if (!truth.isAdmin) {
    console.log('  * Every destructive path. This run was unelevated, so nothing that');
    console.log('    actually uninstalls, purges, quarantines or restores was executed');
    console.log('    end to end - only that it is correctly refused. Re-run from an');
    console.log('    elevated shell to cover those, and read what it removes first.');
  } else {
    console.log('  * Destructive paths were REACHABLE in this run (elevated). The');
    console.log('    sections here are still read-only by design; being elevated does');
    console.log('    not mean an uninstall was actually performed.');
  }
  console.log('  * Anything not installed on this machine. These results describe one');
  console.log(`    Windows ${process.getSystemVersion ? process.getSystemVersion() : ''} box with ${truth.entryCount} uninstall entries and`);
  console.log(`    ${truth.diskCount} fixed drive(s). A clean-VM pass (TASK-17) is a different question.`);
  console.log('  * The quarantine section drives the real renderer with representative');
  console.log('    entries when the vault is empty; it does not prove a real restore.');

  console.log('');
  console.log('='.repeat(72));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('');
    console.log('Failures, grouped:');
    let last = '';
    for (const f of failures) {
      if (f.section !== last) {
        console.log(`\n  [${f.section}]`);
        last = f.section;
      }
      console.log(`    - ${f.label}`);
    }
  }
  console.log('');

  app.exit(fail > 0 ? 1 : 0);
});
