// 949 density: how much of a 156-row list you can actually see at once.
//
//   npx electron test/list-density-verify.js
//
// The operator's report was "the app doesn't feel modern", and the part of it
// that had a number attached was this: seven rows visible in a 900px window for
// a 152-item list. A program list is a place you scan; at seven rows it is a
// viewport onto a list rather than a list.
//
// Nothing was removed to fix it. The 70px row came from 14px of padding around
// a 40px icon TILE - the icon was sizing the row, while the two lines of text
// it sat beside only needed about 30. The tile came down to 30px and the
// padding to 8, and the four summary cards above the table stopped growing on
// large windows (their vh clamps had a floor for small ones and no useful
// ceiling). 70px -> 48px, seven rows -> eleven.
//
// WHY THE BOUNDS ARE LOOSE. Font rasterisation differs between machines, so an
// exact height would be a flaky test wearing a design badge. These assert the
// regression - a row back near 70px, or a segmented control wrapping inside
// itself - and deliberately not the specific pixel values.

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

// Enough rows that the list is genuinely a list. Names are varied in length so
// a wrapping title would show up as a taller row rather than being hidden by a
// fixture where every name is short.
const FIXTURE = Array.from({ length: 40 }, (_, i) => ({
  id: `app${i}`,
  name: i % 4 === 0
    ? `Program With A Rather Long Name That Could Wrap ${i}`
    : `Program ${i}`,
  publisher: i % 3 === 0 ? 'A Publisher With A Long Legal Name Ltd' : 'Acme',
  version: '1.0',
  installDate: '2024-03-04',
  installDateSource: 'recorded',
  sizeBytes: 1048576 * (i + 1),
  installLocation: '',
  registryPath: `HKLM:\\app${i}`,
  type: 'Desktop',
  classification: 'application',
}));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(root, 'index.html'));
  await wait(3000);
  const run = (js) => win.webContents.executeJavaScript(js);

  console.log('');
  console.log('All Programs list density (949)');
  console.log('==============================');

  await run(`(() => {
    window.__test.queueResponse('getDesktopApps', ${JSON.stringify(FIXTURE)});
    loadApplications();
    document.querySelector('.nav-item[data-tab="all-apps"]').click();
    return true;
  })()`);
  await wait(1500);

  const m = await run(`(() => {
    const rows = Array.from(document.querySelectorAll('#apps-tbody tr'));
    const container = document.querySelector('.apps-list-container');
    const head = document.querySelector('.apps-table thead');
    const cr = container ? container.getBoundingClientRect() : null;
    const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
    const headH = head ? head.getBoundingClientRect().height : 0;
    const rowH = heights.length ? Math.max.apply(null, heights) : 0;
    return {
      rowCount: rows.length,
      rowH,
      uniformRows: new Set(heights).size,
      containerH: cr ? Math.round(cr.height) : 0,
      visible: (cr && rowH) ? Math.floor((cr.height - headH) / rowH) : 0,
      viewport: window.innerHeight,
    };
  })()`);

  assert(m.rowCount === FIXTURE.length,
    `premise: all ${FIXTURE.length} fixture rows rendered (${m.rowCount})`);
  assert(m.viewport >= 850 && m.viewport <= 900,
    `premise: measuring in the window size the report was made against (${m.viewport}px)`);

  assert(m.rowH > 0 && m.rowH <= 56,
    `a row is at most 56px tall, not the 70 that produced this report (${m.rowH}px)`);
  assert(m.visible >= 10,
    `at least ten rows are visible at once, against the seven that were (${m.visible})`);
  assert(m.uniformRows === 1,
    `every row is the same height, so a long name or publisher does not make its own row taller (${m.uniformRows} distinct heights)`);

  // ------------------------------------------------------------------
  console.log('');
  console.log('The segmented control does not wrap inside itself');

  // VISIBLE segments only. There is a second .toggle-group in the document -
  // the Safe / Moderate / Advanced tier selector, hidden on this screen - and a
  // hidden button measures 0px, which would satisfy every assertion below
  // without proving anything. A vacuous pass is the failure mode this whole
  // session has been finding, so it is excluded explicitly rather than by
  // choosing a selector that happens not to match it today.
  const toggles = await run(`(() => {
    return Array.from(document.querySelectorAll('.toggle-group .toggle-btn'))
      .filter((b) => b.getBoundingClientRect().height > 0)
      .map((b) => {
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      // A label that wraps makes the button taller than one line plus padding.
      const oneLine = parseFloat(cs.fontSize) * 1.5
        + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return {
        text: b.textContent.trim(),
        h: Math.round(r.height),
        oneLineMax: Math.round(oneLine),
        nowrap: cs.whiteSpace === 'nowrap',
      };
    });
  })()`);

  assert(toggles.length === 3, `premise: three visible segments - All / Desktop / Windows Apps (${toggles.map((t) => t.text).join(', ')})`);
  assert(toggles.every((t) => t.h > 0), 'premise: all three are actually laid out, so none of the checks below passes on a hidden element');
  assert(toggles.some((t) => /Windows Apps/.test(t.text)),
    'premise: the longest label - the one that wrapped - is among them');
  for (const t of toggles) {
    assert(t.h <= t.oneLineMax,
      `"${t.text}" fits on one line (${t.h}px against a one-line ceiling of ${t.oneLineMax}px)`);
  }
  assert(toggles.every((t) => t.nowrap),
    'and every segment is explicitly nowrap, so a longer label in a future build fails visibly rather than silently stretching the control');

  const sameHeight = new Set(toggles.map((t) => t.h)).size === 1;
  assert(sameHeight, `all segments are the same height (${toggles.map((t) => t.h).join(', ')})`);

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
