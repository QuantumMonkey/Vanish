// mp31 against the real machine: does the Size column actually fill in?
//
//   npx electron test/sandbox/install-size-live-probe.js [outDir]
//
// Not a test - it asserts nothing about a number nobody controls. It answers
// the one question the two suites cannot: whether the lazy path fires at all
// when the rows are real, the folders are real and the observer is the real
// IntersectionObserver rather than the fallback the offscreen harness forces.
//
// It prints the before and after of the Unknown count and names the rows that
// changed, then leaves a screenshot for a human.

process.env.VANISH_ALLOW_TEST_HATCHES = '1';
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..', '..');
require(path.join(root, 'main.js'));

const outDir = process.argv[2] || path.join(root, 'dist', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1440, height: 940, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const run = (js) => win.webContents.executeJavaScript(js);

  await win.loadFile(path.join(root, 'index.html'));
  await wait(6000);

  console.log('');
  console.log('Install size, live (mp31)');
  console.log('=========================');

  await run(`(() => { document.querySelector('.nav-item[data-tab="all-apps"]').click(); return true; })()`);
  await wait(2500);

  const snapshot = () => run(`(() => {
    const cells = Array.from(document.querySelectorAll('#apps-tbody .app-size-cell'));
    return {
      rows: cells.length,
      unknown: cells.filter((c) => c.textContent.trim().startsWith('Unknown')).length,
      pending: document.querySelectorAll('.app-size-cell[data-size-source]:not([data-size-loaded])').length,
      measured: cells.filter((c) => c.querySelector('.inferred-mark')).length,
      names: Array.from(document.querySelectorAll('#apps-tbody tr'))
        .filter((tr) => {
          const c = tr.querySelector('.app-size-cell');
          return c && c.querySelector('.inferred-mark');
        })
        .map((tr) => {
          const n = tr.querySelector('.app-title-name');
          const c = tr.querySelector('.app-size-cell');
          return (n ? n.textContent : '?') + '  ' + (c ? c.textContent.trim() : '');
        }),
    };
  })()`);

  const before = await snapshot();
  console.log(`  on arrival:  ${before.rows} rows, ${before.unknown} Unknown, ${before.pending} still to ask, ${before.measured} measured`);

  // Scroll the table so more rows come into view, which is exactly what makes
  // the observer ask. Two passes down the list.
  let lastTop = null;
  for (let i = 0; i < 12; i += 1) {
    lastTop = await run(`(() => {
      const s = document.querySelector('.apps-list-container') || document.scrollingElement;
      if (!s) return 'no container';
      s.scrollTop = s.scrollTop + 600;
      return s.scrollTop;
    })()`);
    await wait(600);
  }
  await wait(1500);
  console.log(`  scroll container reported scrollTop = ${lastTop}`);

  const after = await snapshot();
  console.log(`  after scrolling: ${after.rows} rows, ${after.unknown} Unknown, ${after.pending} still to ask, ${after.measured} measured`);
  if (after.names.length) {
    console.log('');
    console.log('  rows now showing a measured size:');
    for (const n of after.names) console.log('    ' + n);
  } else {
    console.log('');
    console.log('  NOTHING was measured. Either every Unknown row lacks an install folder,');
    console.log('  or the lazy path did not fire - the two look identical on screen, which');
    console.log('  is why this probe prints the pending count as well.');
  }

  const image = await win.webContents.capturePage();
  const file = path.join(outDir, 'mp31-all-programs-sizes.png');
  fs.writeFileSync(file, image.toPNG());
  console.log('');
  console.log(`  ${file}`);
  app.exit(0);
});
