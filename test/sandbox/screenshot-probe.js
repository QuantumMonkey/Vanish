// Screenshots of the real app, from the real engine, for review by a human.
//
//   npx electron test/sandbox/screenshot-probe.js [outDir]
//
// Not a test - it asserts nothing. It exists because "does this look right" is
// the one question no assertion answers, and because the alternative is asking
// the operator to launch the app and describe what they see.
//
// EVERY FRAME HERE IS REAL. The hygiene pass runs one actual module against the
// actual disk (~90s on the machine this was written for) rather than injecting
// a plausible-looking result. A screenshot of invented findings is a mockup, and
// a mockup presented as evidence of working software is the exact thing this
// repository refuses to do to its users.
//
// offscreen:true is load-bearing. capturePage() on a hidden window returns a
// STALE FRAME without it - compositing is paused, so the PNG shows the page as
// it was seconds earlier while executeJavaScript reports the correct live DOM.

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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    show: false,
    frame: false,
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });

  const run = (js) => win.webContents.executeJavaScript(js);

  async function shoot(name, note) {
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`  ${file}  -- ${note}`);
  }

  await win.loadFile(path.join(root, 'index.html'));

  console.log('');
  console.log('Vanish screenshots (real engine, real machine)');
  console.log('=============================================');

  // The frame the user actually gets first. Taken early on purpose: the point
  // of the progressive rewrite is that the page is legible before the slow
  // sections land, and a screenshot taken after everything settles would hide
  // exactly the thing that changed.
  await wait(700);
  await shoot('01-landing-early', 'Health Advisor at ~0.7s: the page, with each section saying what it is doing');

  await wait(6000);
  await shoot('02-landing-loaded', 'Health Advisor once every section has answered');

  await run(`(() => { document.querySelector('.nav-item[data-tab="hygiene"]').click(); return true; })()`);
  await wait(500);
  await shoot('03-hygiene-invitation', 'Machine Hygiene on arrival: no scan started, and it says so');

  // One real module against the real disk.
  await run(`(() => {
    document.getElementById('hygiene-module-select').value = 'hygiene';
    document.getElementById('btn-hygiene-scan').click();
    return true;
  })()`);

  await wait(4000);
  await shoot('04-hygiene-running', 'mid-scan: progress against a real denominator, and NO verdict');

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await run(`hygieneScanning === false && hygieneDecision !== null`)) break;
    await wait(1000);
  }
  await wait(500);
  await shoot('05-hygiene-verdict', 'the decided state, with real findings from this machine');

  // Scrolled, because the findings are below the fold and they are the point.
  await run(`(() => { document.querySelector('#hygiene-panel .panel-scroll').scrollTop = 520; return true; })()`);
  await wait(400);
  await shoot('06-hygiene-findings', 'findings ranked by rebuild cost, each with its evidence');

  await run(`(() => { document.querySelector('.nav-item[data-tab="all-apps"]').click(); return true; })()`);
  await wait(1500);
  await shoot('07-all-programs', 'All Programs, one click from the landing page');

  console.log('');
  win.destroy();
  app.exit(0);
});
