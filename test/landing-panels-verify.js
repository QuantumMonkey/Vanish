// 470o: the two Health Advisor panels that were called strictly-worse mirrors
// of Windows Settings, and the reasons they are kept.
//
//   npx electron test/landing-panels-verify.js
//
// An adversarial pass asked, against this project's own standard, whether
// Storage and Windows updates earn their place when Settings shows the same
// numbers and more. Both were kept, with reasons written into index.html. A
// reason in a comment is worth nothing on its own - the next person reads the
// code, not the comment - so the load-bearing halves of both reasons are
// asserted here:
//
//   Storage is kept because it is the VERDICT'S INPUT, not a storage manager.
//   Windows updates is kept because it contributes NOTHING to the verdict.
//
// Those two claims pull in opposite directions on purpose, and each is exactly
// what makes its panel defensible. If either stops being true the justification
// is stale and this suite says so.
//
// It runs in either tier - nothing here reads a privileged thing.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

const root = path.join(__dirname, '..');

app.whenReady().then(async () => {
  console.log('');
  console.log('Landing panels that deliberately stop short (470o)');
  console.log('=================================================');

  // ------------------------------------------------------------------
  console.log('');
  console.log('What each section does to the verdict, read from the source');
  // Asserted against renderer/audit.js rather than by driving the page,
  // because "this section never contributes work" is a claim about a code
  // path that a passing render cannot demonstrate: a screen where nothing
  // happened to be wrong looks identical either way.

  const auditSrc = fs.readFileSync(path.join(root, 'renderer', 'audit.js'), 'utf8');

  // The disks branch is the ONLY place the landing page turns a drive into
  // work, and it reuses renderDiskBars' own 90% rather than deciding again.
  const disksReport = /const full = \(diag\.disks \|\| \[\]\)\.filter\(\(d\) => \(d\.pctUsed \?\? 0\) >= 90\);\s*\n\s*auditReportWork\(full\.length,/;
  assert(disksReport.test(auditSrc),
    'Storage counts almost-full drives into the verdict, so the bars are the visible form of a number the headline already uses');

  // Find the Windows Update section's object literal and prove there is no
  // auditReportWork inside it.
  const updatesStart = auditSrc.indexOf('run: () => window.api.getWindowsUpdates()');
  assert(updatesStart !== -1, 'premise: the Windows updates section is registered in the sections list');
  const updatesEnd = auditSrc.indexOf('run: () =>', updatesStart + 10);
  const updatesBlock = auditSrc.slice(updatesStart, updatesEnd === -1 ? auditSrc.length : updatesEnd);
  assert(!/auditReportWork/.test(updatesBlock),
    'Windows updates contributes NO work to the verdict - a panel that nagged about updates would be claiming they are the user problem',
    updatesBlock.slice(0, 200));
  assert(/auditReportBlind\('Windows Update'\)/.test(updatesBlock),
    'but it still reports itself blind when the query fails, so a failed read is never rendered as "nothing to see"');

  // ------------------------------------------------------------------
  console.log('');
  console.log('The Storage panel says what it is not, and where the rest lives');

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const storageStart = html.indexOf('id="audit-disk-list"');
  assert(storageStart !== -1, 'premise: the Storage section exists');
  const storageBlock = html.slice(Math.max(0, storageStart - 200), storageStart + 900);

  assert(/Settings/.test(storageBlock) && /Storage/.test(storageBlock),
    'it names the built-in that does more, rather than quietly competing with it');
  assert(/data-goto-tab="system-clean"/.test(storageBlock),
    'and links to the panel that answers the half no built-in can - whose bytes those are');

  // ------------------------------------------------------------------
  console.log('');
  console.log('And the link actually goes there');

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(root, 'index.html'));
  await wait(3000);
  const run = (js) => win.webContents.executeJavaScript(js);

  const before = await run(`(() => {
    const el = document.querySelector('[data-goto-tab="system-clean"]');
    return {
      present: Boolean(el),
      cleanHidden: (document.getElementById('clean-panel') || {}).style ? document.getElementById('clean-panel').style.display : 'missing',
    };
  })()`);
  assert(before.present === true, 'premise: the link is in the rendered page');
  assert(before.cleanHidden !== 'block', `premise: System Clean is not already showing (${before.cleanHidden})`);

  const after = await run(`(() => {
    document.querySelector('[data-goto-tab="system-clean"]').click();
    return {
      cleanShown: document.getElementById('clean-panel').style.display,
      navActive: (document.querySelector('.nav-item.active') || {}).getAttribute
        ? document.querySelector('.nav-item.active').getAttribute('data-tab')
        : null,
      attributionPresent: Boolean(document.getElementById('attribution-section')),
    };
  })()`);
  // Not === 'block': switchTab restores each panel's own display mode, and
  // this one is a flex column. Asserting the exact value would be asserting
  // the layout, which is not what this suite is about.
  assert(after.cleanShown !== 'none' && after.cleanShown !== '',
    `clicking it opens System Clean (display: ${after.cleanShown})`);
  assert(after.navActive === 'system-clean',
    `and the sidebar follows, so the app does not look like it jumped on its own (${after.navActive})`);
  assert(after.attributionPresent === true,
    'and the panel it lands on is the one holding "Where your disk space went"');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
