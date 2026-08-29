// The Machine Hygiene panel, against the REAL engine, in a REAL window.
//
//   npx electron test/sandbox/hygiene-live-probe.js
//
// WHY SEPARATE FROM test/hygiene-panel-verify.js. That suite drives the panel
// through the fixture preload, which is the only way to construct the states
// that matter -- a check that never returns, an engine that fails, an
// irreplaceable finding on a machine that has none. What it CANNOT prove is
// that any of it is wired to anything: the whole 5p5 subsystem passed every one
// of its own suites while being unreachable from the application, because
// index.html, preload.js and main.js had never heard of it.
//
// So this proves the wiring and nothing else: a real click, through the real
// preload, into the real scanner.ps1, back into the real renderer.
//
// It runs ONE finder deliberately. profile-list is a registry read (~1.2s);
// the disk walkers take minutes -- the hygiene module alone measured 89 seconds
// on 2026-08-28 and all three together over ten. Proving the pipe does not
// require pushing the whole machine through it, and a suite that took ten
// minutes would simply stop being run.
//
// NOT IN run-all.ps1: it needs a real window and real engine timings, and lives
// beside the other sandbox probes for the same reason.

process.env.VANISH_ALLOW_TEST_HATCHES = '1';
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..', '..');
require(path.join(root, 'main.js'));

let pass = 0;
let fail = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });

  const run = (js) => win.webContents.executeJavaScript(js);

  await win.loadFile(path.join(root, 'index.html'));
  await wait(3000);

  console.log('');
  console.log('Machine Hygiene, live against scanner.ps1');
  console.log('=========================================');

  // ---- the registry, from the engine ------------------------------------
  const t0 = Date.now();
  const registry = await run(`window.api.listHygieneFinders()`);
  const registryMs = Date.now() - t0;

  assert(registry && registry.success === true, `the engine lists its checks (${registryMs} ms)`, JSON.stringify(registry).slice(0, 200));
  const finders = (registry && registry.finders) || [];
  assert(finders.length > 0, `and there are checks registered (${finders.length})`);
  assert(
    (registry.loadErrors || []).length === 0,
    `every finder file loaded (${(registry.loadErrors || []).length} load error(s))`,
    JSON.stringify(registry.loadErrors || [])
  );
  assert(
    finders.every((f) => f.auditOnly === true),
    'and every registered check is AUDIT ONLY - nothing on this screen can remove anything'
  );

  const modules = [...new Set(finders.map((f) => f.module))].sort();
  assert(
    ['hygiene', 'reclaim', 'rescue'].every((m) => modules.includes(m)),
    `all three modules are represented (${modules.join(', ')})`
  );

  // ---- one real check, end to end ---------------------------------------
  const t1 = Date.now();
  const scan = await run(`window.api.runHygieneScan({ finders: ['profile-list'] })`);
  const scanMs = Date.now() - t1;

  assert(scan && scan.success === true, `a real check runs through the real engine (${scanMs} ms)`);
  const results = (scan && scan.results) || [];
  assert(results.length === 1, `and returns exactly the one result asked for (${results.length})`);

  if (results.length === 1) {
    const r = results[0];
    assert(r.finder === 'profile-list', `the result names the finder it came from (${r.finder})`);
    // The contract's three states, present on the wire. lib/findings.js
    // recomputes rather than trusting this - but its absence would mean the
    // engine half of the seam had changed shape.
    assert(
      ['found', 'nothing', 'could-not-look'].includes(String(r.state)),
      `and carries one of the three contract states (${r.state})`
    );
  }

  // ---- through the decider, in the page ---------------------------------
  const decided = await run(
    `(() => { const d = window.VanishFindings.decide(${JSON.stringify(results)});
      return { state: d.state, terminal: d.terminal, findings: d.findingCount, blind: d.unreadableCount,
               examined: d.examinedCount, disagreements: d.disagreements.length }; })()`
  );
  assert(
    ['has-work', 'nothing-found', 'incomplete', 'failed'].includes(decided.state),
    `the decider turns it into exactly one named UI state (${decided.state})`
  );
  assert(
    decided.disagreements === 0,
    `and the engine's own state claim agreed with its evidence (${decided.disagreements} disagreement(s))`
  );

  // ---- the click path, which is the thing that was missing ---------------
  await run(`(() => { document.querySelector('.nav-item[data-tab="hygiene"]').click(); return true; })()`);
  await wait(400);
  assert(
    (await run(`document.getElementById('hygiene-panel').style.display !== 'none'`)) === true,
    'the sidebar entry opens the panel'
  );
  assert(
    (await run(`/Nothing has been checked yet/.test(document.getElementById('hygiene-verdict').textContent)`)) === true,
    'and arriving there scans nothing - it says so instead'
  );

  // Drive the real button with the module select narrowed to the cheapest
  // module, so this probe stays under a minute.
  await run(`(() => {
    document.getElementById('hygiene-module-select').value = 'hygiene';
    hygieneFinders = [];
    return true;
  })()`);

  const t2 = Date.now();
  await run(`(() => { document.getElementById('btn-hygiene-scan').click(); return true; })()`);

  const deadline = Date.now() + 300000;
  let settled = false;
  while (Date.now() < deadline) {
    if (await run(`hygieneScanning === false && hygieneDecision !== null`)) {
      settled = true;
      break;
    }
    await wait(500);
  }
  const clickMs = Date.now() - t2;

  assert(settled, `clicking Run checks completes a real scan of one module (${Math.round(clickMs / 1000)}s)`);

  if (settled) {
    const shown = await run(`(() => ({
      state: hygieneDecision.state,
      verdict: document.getElementById('hygiene-verdict').textContent.replace(/\\s+/g, ' ').trim(),
      checks: document.querySelectorAll('#hygiene-checklist .hygiene-check-row').length,
      findings: document.querySelectorAll('#hygiene-modules .hygiene-finding').length,
      ranCount: hygieneResults.length
    }))()`);

    assert(shown.checks > 0, `every check that ran is listed by name (${shown.checks} rows)`);
    assert(
      shown.ranCount === shown.checks,
      `and the checklist covers exactly the checks that ran (${shown.checks} rows vs ${shown.ranCount} results)`
    );
    assert(
      !/check(s)? finished/.test(shown.verdict),
      'the finished panel shows a verdict rather than a progress line',
      shown.verdict.slice(0, 160)
    );
    assert(
      shown.findings > 0 || /Nothing found|did not finish|did not run/.test(shown.verdict),
      'and the verdict is one of the named terminal states',
      shown.verdict.slice(0, 200)
    );

    console.log('');
    console.log(`  INFO  decided state: ${shown.state}`);
    console.log(`  INFO  verdict: ${shown.verdict.slice(0, 200)}`);
    console.log(`  INFO  findings rendered: ${shown.findings}`);
  }

  console.log('');
  console.log('Timings on this machine (the reason the panel does not make one big call):');
  console.log(`  list the checks           ${registryMs} ms`);
  console.log(`  one registry-read check   ${scanMs} ms`);
  console.log(`  one whole module, clicked ${Math.round(clickMs / 1000)} s`);

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail > 0 ? 1 : 0);
});
