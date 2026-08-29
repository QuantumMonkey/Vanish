// How long the Machine Hygiene panel ACTUALLY takes, all thirteen checks, on
// this machine (3l8).
//
//   npx electron test/sandbox/hygiene-wallclock-probe.js
//
// hygiene-live-probe.js deliberately narrows to one module so it stays under a
// minute. That makes it a correctness probe, not a stopwatch, and the number
// the operator experiences -- press the button, wait -- was never measured by
// anything in the suite. lhf profiled per finder and 3l8 per engine call; both
// are inputs to this number and neither one IS it.
//
// TIMING BY POLLING hygieneStatus, not by wrapping window.api. The first
// version of this probe reassigned window.api to wrap runHygieneScan, which
// contextBridge does not permit -- and the failure was not an error, it was a
// probe that sat there for ten minutes with no engine process running and
// nothing printed. Reading the panel's own per-check status map costs nothing
// and cannot break what it is measuring.
//
// NOT part of run-all.ps1. It walks the real disk and takes minutes, and a
// timing assertion on a machine whose disk speed nobody controls is a flaky
// test wearing a performance badge.

// main.js IS REQUIRED, not optional. The preload's every call is
// ipcRenderer.invoke, and the handlers live in main.js -- an Electron main
// process that only opens a window answers none of them, so the registry read
// rejects, the panel reports that the checks did not run, and the probe waits
// forever for a decision that is never coming. Two silent ten-minute runs
// before the guard below was added. hygiene-live-probe.js does the same thing
// for the same reason.
process.env.VANISH_ALLOW_TEST_HATCHES = '1';
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

require(path.join(__dirname, '..', '..', 'main.js'));

app.disableHardwareAcceleration();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const run = (js) => win.webContents.executeJavaScript(js);

function die(why) {
  console.log('');
  console.log(`  the probe could not run: ${why}`);
  if (win) win.destroy();
  app.exit(1);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', '..', 'index.html'));
  await wait(2500);

  console.log('');
  console.log('Machine Hygiene wall clock, every check (3l8)');
  console.log('============================================');

  // The tab first, and then WAIT. setupHygieneTab wires the button's click
  // listener during the panel's first render, so clicking the nav item and the
  // scan button in one synchronous block clicks a button nothing is listening
  // to -- which is not an error, it is a probe that sits there forever with no
  // engine process running. Cost two runs before it was noticed.
  const opened = await run(`(() => {
    const nav = document.querySelector('.nav-item[data-tab="hygiene"]');
    if (!nav) return 'no hygiene nav item';
    nav.click();
    return 'ok';
  })()`);
  if (opened !== 'ok') return die(opened);
  await wait(600);

  const started = await run(`(() => {
    const sel = document.getElementById('hygiene-module-select');
    if (!sel) return 'no module select';
    sel.value = '';
    const btn = document.getElementById('btn-hygiene-scan');
    if (!btn) return 'no scan button';
    hygieneFinders = [];
    btn.click();
    return 'ok';
  })()`);
  if (started !== 'ok') return die(started);

  // And CHECK it started. A probe whose only failure mode is silence is worse
  // than no probe: it reports nothing and looks like slow hardware.
  await wait(1200);
  if ((await run(`hygieneScanning === true`)) !== true) {
    return die('the button was clicked but no scan is running - nothing is listening to it');
  }

  // Transition times, read off the panel's own status map.
  const t0 = Date.now();
  const firstSeen = {};
  const doneAt = {};
  const deadline = Date.now() + 900000;
  let settled = false;

  while (Date.now() < deadline) {
    const snap = await run(`(() => ({
      done: hygieneScanning === false && hygieneDecision !== null,
      status: Object.assign({}, hygieneStatus)
    }))()`);
    const now = Date.now() - t0;
    for (const [name, state] of Object.entries(snap.status || {})) {
      if (state === 'running' && firstSeen[name] === undefined) firstSeen[name] = now;
      if ((state === 'done' || state === 'error') && doneAt[name] === undefined) doneAt[name] = now;
    }
    if (snap.done) { settled = true; break; }
    await wait(250);
  }
  const wall = Date.now() - t0;
  if (!settled) return die(`the scan did not settle within 15 minutes (${Math.round(wall / 1000)}s elapsed)`);

  const rows = Object.keys(doneAt)
    .map((name) => ({ name, ms: doneAt[name] - (firstSeen[name] || 0), endedAt: doneAt[name] }))
    .sort((a, b) => b.ms - a.ms);

  const shown = await run(`(() => ({
    state: hygieneDecision.state,
    results: hygieneResults.length,
    findings: hygieneDecision.findings.length,
    unreadable: hygieneDecision.unreadableCount
  }))()`);

  console.log('');
  console.log('Per check, slowest first (elapsed while it was running):');
  for (const r of rows) {
    console.log(`  ${String(r.ms).padStart(8)} ms   ${r.name.padEnd(24)} finished at ${(r.endedAt / 1000).toFixed(1)} s`);
  }
  console.log('');
  console.log(`  checks reported           ${shown.results}`);
  console.log(`  WALL CLOCK                ${(wall / 1000).toFixed(1)} s`);
  console.log(`  decided state             ${shown.state}`);
  console.log(`  findings / unreadable     ${shown.findings} / ${shown.unreadable}`);

  win.destroy();
  app.exit(0);
});
