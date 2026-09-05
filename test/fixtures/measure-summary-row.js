// 2xnj: measure the summary row and the workspace it is paid for out of, at
// ONE window size, and print one JSON line.
//
//   npx electron test/fixtures/measure-summary-row.js 800 600
//
// A FIXTURE RATHER THAN A SUITE, and a separate PROCESS per size, because the
// issue that produced it recorded the reason: creating a second offscreen
// BrowserWindow in the same run does not settle, so the second measurement is
// taken against a layout that never finished. test/summary-row-verify.js runs
// this twice and compares.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const W = Number(process.argv[2] || 800);
const H = Number(process.argv[3] || 600);
const ROOT = path.join(__dirname, '..', '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      offscreen: true,
      preload: path.join(ROOT, 'test', 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await win.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 3000));

  // The summary row lives on All Programs, which is not the landing tab. The
  // first version of this measured zeroes for everything because the panel was
  // display:none, and zeroes compare equal - which would have passed.
  await win.webContents.executeJavaScript(
    `document.querySelector('.nav-item[data-tab="all-apps"]').click(); true;`
  );
  await new Promise((r) => setTimeout(r, 2500));

  const m = await win.webContents.executeJavaScript(`(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      return e ? Math.round(e.getBoundingClientRect().height) : null;
    };
    const cards = Array.from(document.querySelectorAll('.stat-card'));
    const labels = Array.from(document.querySelectorAll('.stat-label'));
    return {
      viewport: window.innerWidth + 'x' + window.innerHeight,
      statsHeight: box('.dashboard-stats'),
      workspaceHeight: box('.apps-workspace'),
      cardCount: cards.length,
      cardWidth: cards[0] ? Math.round(cards[0].getBoundingClientRect().width) : null,
      // One line is 16px at this font size. Anything taller is a wrapped label,
      // which is the mechanism the whole issue is about.
      labelHeights: labels.map((l) => Math.round(l.getBoundingClientRect().height))
    };
  })()`);

  console.log('MEASUREMENT ' + JSON.stringify(m));
  app.exit(0);
});
