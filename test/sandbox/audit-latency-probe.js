// Health Advisor first-paint latency, measured against the REAL engine.
//
//   npx electron test/sandbox/audit-latency-probe.js
//
// This is a measurement, not a pass/fail suite. It exists because "the app
// feels slow" is not actionable and "get-startup-items takes 7.4 seconds" is.
//
// WHY IT IS NOT IN run-all.ps1: every number here is a property of the machine
// it runs on - how many startup entries it has, how many of those are signed,
// how busy the disk is. A threshold that is generous on this box would be a
// false failure on a slower one and a false pass on a faster one. Numbers get
// recorded in the commit message; the suite that guards behaviour is
// test/ui-interaction-verify.js, which uses stubs precisely so it CAN assert.
//
// WHAT IT MEASURES. Not "did the promise resolve" - that is main-process
// bookkeeping the user cannot see. It polls the DOM and records, per section,
// the moment that section stops showing its pending placeholder and starts
// showing content. That is the frame the user actually gets.
//
// The comparison it makes possible: before the progressive rewrite, every one
// of these numbers was identical and equal to the slowest, because
// loadAuditData awaited Promise.all over all six queries behind a single
// full-panel spinner.

process.env.VANISH_ALLOW_TEST_HATCHES = '1';
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..', '..');
require(path.join(root, 'main.js'));

// Each section, and the DOM condition that means "this one has real content".
// Keyed on the pending placeholder disappearing rather than on any particular
// markup, so a section that renders an empty-but-real answer ("nothing is
// listening") counts as painted - which it is.
const SECTIONS = [
  ['System overview', '#audit-sysinfo-grid'],
  ['Storage', '#audit-disk-list'],
  ['Network activity', '#audit-network-body'],
  ['Listening programs', '#audit-listeners-body'],
  ['Windows updates', '#audit-updates-body'],
  ['Redundant software', '#audit-redundancy-list'],
  ['Startup items', '#audit-startup-tbody']
];

const PROBE = `(sections) => {
  const out = {};
  for (const [name, sel] of sections) {
    const el = document.querySelector(sel);
    if (!el) { out[name] = 'absent'; continue; }
    const pending = el.querySelector('.audit-pending, .audit-pending-cell');
    const hasContent = el.children.length > 0 || el.textContent.trim().length > 0;
    out[name] = pending ? 'pending' : (hasContent ? 'painted' : 'empty');
  }
  out.__globalSpinner = (() => {
    const l = document.getElementById('audit-loading');
    return !!l && l.style.display !== 'none';
  })();
  out.__panelVisible = (() => {
    const p = document.getElementById('audit-panel');
    return !!p && p.style.display !== 'none';
  })();
  return out;
}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });

  const t0 = Date.now();
  await win.loadFile(path.join(root, 'index.html'));
  const loaded = Date.now() - t0;

  const paintedAt = {};
  let firstUsefulFrame = null;
  let panelVisibleAt = null;

  // 30ms is fine-grained enough that the reported time is dominated by the
  // query, not by the poll, and coarse enough not to compete with the renderer
  // for the main thread.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await win.webContents.executeJavaScript(`(${PROBE})(${JSON.stringify(SECTIONS)})`);
    } catch {
      await wait(30);
      continue;
    }

    if (panelVisibleAt === null && state.__panelVisible && !state.__globalSpinner) {
      panelVisibleAt = Date.now() - t0;
    }

    for (const [name] of SECTIONS) {
      if (paintedAt[name] === undefined && state[name] === 'painted') {
        paintedAt[name] = Date.now() - t0;
        if (firstUsefulFrame === null) firstUsefulFrame = paintedAt[name];
      }
    }

    if (SECTIONS.every(([n]) => paintedAt[n] !== undefined)) break;
    await wait(30);
  }

  console.log('');
  console.log('Health Advisor first-paint latency (real engine, this machine)');
  console.log('=============================================================');
  console.log(`  index.html loaded                     ${String(loaded).padStart(6)} ms`);
  console.log(
    `  panel on screen, no global spinner     ${String(panelVisibleAt === null ? 'never' : panelVisibleAt).padStart(5)} ms`
  );
  console.log(`  FIRST section with real content        ${String(firstUsefulFrame === null ? 'never' : firstUsefulFrame).padStart(5)} ms`);
  console.log('');
  for (const [name] of SECTIONS) {
    const at = paintedAt[name];
    console.log(`  ${name.padEnd(22)} ${at === undefined ? '  never (45s)' : String(at).padStart(6) + ' ms'}`);
  }

  const times = Object.values(paintedAt);
  if (times.length > 0) {
    console.log('');
    console.log(`  fastest section ${Math.min(...times)} ms, slowest ${Math.max(...times)} ms`);
    console.log('  Before the progressive rewrite every one of these was the slowest number,');
    console.log('  because the panel was hidden until Promise.all over all six queries settled.');
  }
  console.log('');

  win.destroy();
  app.exit(0);
});
