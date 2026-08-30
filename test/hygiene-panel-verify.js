// The machine-hygiene panel must render the DECIDED state, and must never
// render a verdict it has not earned.
//
//   npx electron test/hygiene-panel-verify.js
//
// WHY THIS EXISTS. finders/, the contract and lib/findings.js all have their own
// suites, and every one of them passed while the whole subsystem was INVISIBLE:
// nothing in index.html, preload.js or main.js referenced it. A seam with no
// surface is a seam nobody can be wrong about, which is not the same as a seam
// that is right.
//
// THE ASSERTION THIS FILE IS BUILT AROUND. Each check is a separate engine call
// -- measured 2026-08-28, the hygiene module alone takes 89 seconds and all
// three take over ten minutes -- so results arrive one at a time. That makes it
// trivially easy to decide the run before it is finished, and decide() over
// three of thirteen results will happily return NOTHING FOUND. Which is aeu's
// defect wearing a progress bar. So: while a scan is in flight, the verdict must
// name no terminal state at all.
//
// The four terminal states are driven directly, because on a healthy fixture
// machine only one of them would ever occur naturally and the other three are
// exactly the ones that carry the risk.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

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

let win;
function run(js) {
  return win.webContents.executeJavaScript(js);
}

// Every payload is wrapped in an IIFE. A bare statement list with a top-level
// const is evaluated in the page's GLOBAL lexical environment, which the eight
// renderer classic scripts already populate, and one name collision makes the
// ENTIRE script fail at instantiation with nothing logged.
function evalInPage(body) {
  return run(`(() => { ${body} })()`);
}

async function waitFor(js, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await run(js)) return true;
    await wait(50);
  }
  return false;
}

const RESULT = (over) =>
  Object.assign(
    {
      finder: 'stub',
      title: 'Stub check',
      module: 'rescue',
      findings: [],
      unreadable: [],
      examinedCount: 5,
      totalBytes: 0
    },
    over
  );

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);

  console.log('');
  console.log('Machine Hygiene panel (5p5 / aeu)');
  console.log('=================================');

  // --- the surface exists at all -----------------------------------------
  console.log('');
  console.log('The subsystem is reachable');

  assert(
    (await run(`!!document.querySelector('.nav-item[data-tab="hygiene"]')`)) === true,
    'there is a sidebar entry for it - the seam has a surface, which it did not before 0.9.0'
  );
  assert(
    (await run(`typeof window.api.runHygieneScan === 'function' && typeof window.api.listHygieneFinders === 'function'`)) ===
      true,
    'and both engine channels are exposed on the bridge'
  );

  await evalInPage(`document.querySelector('.nav-item[data-tab="hygiene"]').click(); return true;`);
  await wait(300);
  assert(
    (await run(`document.getElementById('hygiene-panel').style.display !== 'none'`)) === true,
    'clicking it shows the panel'
  );

  // --- arriving is not consent to walk the disk ---------------------------
  console.log('');
  console.log('Arriving at the tab does not start a scan');

  const scanCallsOnArrival = await run(`window.__test.callCount('runHygieneScan')`);
  assert(
    scanCallsOnArrival === 0,
    `opening the tab ran no checks (${scanCallsOnArrival} call(s)) - these hash file contents, and arriving somewhere is not consent to that`
  );
  const invitation = await run(`document.getElementById('hygiene-verdict').textContent`);
  assert(
    /Nothing has been checked yet/.test(invitation),
    'and it says so, rather than showing an empty result that looks exactly like a clean one'
  );

  // --- THE ASSERTION THIS FILE IS BUILT AROUND ---------------------------
  console.log('');
  console.log('A partial run is never decided');

  // Constructed rather than raced. The tempting version of this test stalls one
  // engine call so the scan sits half-finished -- but a promise cannot be sent
  // across contextBridge (it structured-clones), and a timing-based version
  // would be a flake in a suite whose whole subject is not jumping to
  // conclusions. So the mid-flight state is built directly and the real
  // progress renderer is called on it: TWO checks registered, ONE returned, and
  // that one found nothing. Decide the set now and it says "nothing found".
  await evalInPage(`
    hygieneScanning = true;
    hygieneLoadErrors = [];
    hygieneFinders = [
      { name: 'done-one', title: 'Finished check', module: 'rescue' },
      { name: 'still-going', title: 'Still running', module: 'reclaim' }
    ];
    hygieneStatus = { 'done-one': 'done', 'still-going': 'running' };
    hygieneResults = [${JSON.stringify(RESULT({ finder: 'done-one', module: 'rescue' }))}];
    hygieneDecision = null;
    setHygieneButtonBusy(true);
    renderHygieneProgress();
    renderHygieneChecklist();
    return true;
  `);
  await wait(120);

  // The premise, asserted rather than assumed: deciding this set right now
  // WOULD produce the reassuring terminal state. Without this the test below
  // could pass because there was nothing to get wrong.
  const wouldSayClean = await run(
    `window.VanishFindings.decide(hygieneResults).state === window.VanishFindings.UI_NOTHING_FOUND`
  );
  assert(
    wouldSayClean === true,
    'PREMISE: deciding the half-finished set right now WOULD return nothing-found, so there is something here to get wrong'
  );

  const midFlight = await run(`document.getElementById('hygiene-verdict').textContent`);
  assert(/1 of 2 checks finished/.test(midFlight), 'a scan in flight reports progress against an honest denominator');
  assert(
    !/Nothing found/.test(midFlight),
    'THE ASSERTION THIS EXISTS FOR: a half-finished run does NOT say "nothing found"',
    midFlight.trim().slice(0, 200)
  );
  assert(
    !/worth your attention/.test(midFlight) && !/did not run/.test(midFlight),
    'and names no other terminal state either - progress is not a verdict',
    midFlight.trim().slice(0, 200)
  );
  assert(
    (await run(`document.getElementById('btn-hygiene-scan').disabled`)) === true &&
      (await run(`document.getElementById('hygiene-module-select').disabled`)) === true,
    'both controls are inert while checks are running, so a second click cannot interleave two runs'
  );

  await evalInPage(`hygieneScanning = false; setHygieneButtonBusy(false); return true;`);
  await wait(100);

  // --- the four terminal states, driven directly -------------------------
  console.log('');
  console.log('Each terminal state gets its own sentence');

  async function decideAndRender(results, loadErrors = []) {
    await evalInPage(`
      hygieneScanning = false;
      hygieneLoadErrors = ${JSON.stringify(loadErrors)};
      hygieneResults = ${JSON.stringify(results)};
      hygieneFinders = hygieneResults.map((r) => ({ name: r.finder, title: r.title, module: r.module }));
      hygieneStatus = {};
      for (const f of hygieneFinders) hygieneStatus[f.name] = 'done';
      hygieneDecision = window.VanishFindings.decide(hygieneResults);
      renderHygieneAll();
      return true;
    `);
    await wait(120);
    return {
      text: await run(`document.getElementById('hygiene-verdict').textContent`),
      tone: await run(`document.querySelector('#hygiene-verdict .hygiene-verdict').className`)
    };
  }

  const nothing = await decideAndRender([RESULT({ finder: 'a' })]);
  assert(/Nothing found, and the check was complete/.test(nothing.text), 'nothing-found says the check was COMPLETE, not just empty');
  assert(/clean/.test(nothing.tone), 'and is the only state styled as clean');

  const incomplete = await decideAndRender([
    RESULT({ finder: 'b', unreadable: [{ path: 'C:\\locked', reason: 'access-denied' }] })
  ]);
  assert(
    /did not finish/.test(incomplete.text) && /NOT the same as clean/.test(incomplete.text),
    'no findings PLUS a blind spot is reported as incomplete and explicitly refuses to round up to clean',
    incomplete.text.trim().slice(0, 200)
  );
  assert(!/clean"?\s*$/.test(incomplete.tone) && /incomplete/.test(incomplete.tone), 'and is styled as its own state, not as the clean one');

  const hasWork = await decideAndRender([
    RESULT({
      finder: 'c',
      findings: [
        {
          id: 'f1',
          title: 'A keystore that is on no remote',
          path: 'C:\\repo\\release.jks',
          bytes: 2048,
          evidence: 'gitignored, and git reports no remote copy',
          rebuildCost: 'It cannot be rebuilt. A signed app whose keystore is gone cannot be updated.',
          costClass: 'irreplaceable',
          action: 'audit'
        }
      ]
    })
  ]);
  assert(/1 thing worth your attention/.test(hasWork.text), 'a finding is counted in the singular correctly');
  assert(
    (await run(`!!document.querySelector('#hygiene-modules .hygiene-finding.cost-irreplaceable')`)) === true,
    'and an irreplaceable finding carries its cost class into the markup, so styling can lead with cost rather than size'
  );
  assert(
    (await run(`/IRREPLACEABLE/.test(document.getElementById('hygiene-modules').textContent)`)) === true,
    'the cost is stated in words, not only in a colour'
  );
  assert(
    (await run(`/To get it back/.test(document.getElementById('hygiene-modules').textContent)`)) === true,
    'and so is what it would take to rebuild it - the number that decides, per Module 1 rule 2'
  );
  assert(
    (await run(`/Vanish will not remove this/.test(document.getElementById('hygiene-modules').textContent)`)) === true,
    'every finding says outright that Vanish will not remove it - these finders are all audit-only'
  );
  assert(
    (await run(`document.querySelectorAll('#hygiene-panel button[data-destructive]').length`)) === 0,
    'and the panel carries no destructive control at all, in either tier'
  );

  // costClass does not mean the same thing in every module, and this is the
  // assertion that keeps them apart. A HYGIENE finding carrying costClass
  // 'cheap' means "the fix is free" - setting an environment variable, making
  // a commit - not "this is cheap to lose". Rendering the reclaim reading of it
  // put "Repo is dirty: 1 uncommitted change [CHEAP TO REBUILD]" on screen in a
  // real run, which tells the user their uncommitted work is disposable.
  const hygieneModule = await decideAndRender([
    RESULT({
      finder: 'repo-health',
      module: 'hygiene',
      findings: [
        {
          id: 'dirty1',
          title: 'Repo is dirty: 1 uncommitted change(s)',
          path: 'C:\\repo',
          bytes: 4096,
          evidence: 'git status --porcelain reports 1 changed path not committed.',
          costClass: 'cheap',
          action: 'audit'
        }
      ]
    })
  ]);
  const hygieneMarkup = await run(`document.getElementById('hygiene-modules').innerHTML`);
  assert(
    !/cheap to rebuild/i.test(hygieneMarkup),
    'a HYGIENE finding is never labelled "cheap to rebuild", whatever costClass it carries - that reading would call uncommitted work disposable',
    hygieneMarkup.slice(0, 300)
  );
  assert(
    /nothing to remove/i.test(hygieneMarkup),
    'it says "nothing to remove" instead, which is what wrong-but-free actually means'
  );
  assert(
    /already there/.test(hygieneMarkup),
    'and its bytes are labelled as what is ALREADY sitting there, not as size the finding would free'
  );
  void hygieneModule;

  // The same costClass in a RECLAIM finding keeps the rebuild reading, because
  // there it is the true one. Without this leg the assertion above could be
  // satisfied by never showing a cost anywhere.
  await decideAndRender([
    RESULT({
      finder: 'reclaim-node',
      module: 'reclaim',
      findings: [
        {
          id: 'nm1',
          title: 'node_modules beside a package.json',
          path: 'C:\\repo\\node_modules',
          bytes: 1024 * 1024,
          evidence: 'package.json is present in the parent directory.',
          rebuildCost: 'npm install, about two minutes',
          costClass: 'cheap',
          action: 'audit'
        }
      ]
    })
  ]);
  const reclaimMarkup = await run(`document.getElementById('hygiene-modules').innerHTML`);
  assert(
    /cheap to rebuild/i.test(reclaimMarkup),
    'a RECLAIM finding with the same costClass DOES say "cheap to rebuild" - there the rebuild reading is the true one'
  );
  assert(
    !/already there/.test(reclaimMarkup),
    'and its bytes are plain reclaimable size, with no hygiene-module qualifier'
  );

  // A real run of duplicate-content on the operator's machine returned 4,035
  // findings once it was made to finish at all. Rendering every one of them
  // freezes the page; rendering 100 and REPORTING 100 would be this suite's own
  // defect class with a scrollbar on it. Both halves are asserted.
  const many = [];
  for (let i = 0; i < 250; i += 1) {
    many.push({
      id: `f${i}`,
      title: `Finding number ${i}`,
      path: `C:\\big\\file${i}`,
      bytes: 1000 + i,
      evidence: 'constructed for the cap test',
      rebuildCost: 'trivial',
      costClass: 'cheap',
      action: 'audit'
    });
  }
  await decideAndRender([RESULT({ finder: 'many', module: 'reclaim', findings: many })]);

  const capped = await run(`(() => ({
    rendered: document.querySelectorAll('#hygiene-modules .hygiene-finding').length,
    summary: document.querySelector('#hygiene-modules .hygiene-module-summary').textContent,
    notice: (document.querySelector('#hygiene-modules .hygiene-render-cap') || {}).textContent || '',
    verdict: document.getElementById('hygiene-verdict').textContent
  }))()`);

  assert(
    capped.rendered === 100,
    `250 findings render as 100 cards, not 250 (${capped.rendered})`
  );
  assert(
    /250 findings/.test(capped.summary) && /250 thing/.test(capped.verdict),
    `but the COUNT stays the real total in both the module header and the verdict (header: "${capped.summary.trim()}")`
  );
  assert(
    /first 100 of 250/.test(capped.notice.replace(/\s+/g, ' ')),
    'and the list says outright how many it is showing out of how many there are',
    capped.notice.replace(/\s+/g, ' ').slice(0, 160)
  );
  assert(
    /ranked by what it would cost/.test(capped.notice.replace(/\s+/g, ' ')),
    'including why these hundred are the right hundred - the ranking is cost-first, so the tail is the regenerable part'
  );

  const failed = await decideAndRender([]);
  assert(/The checks did not run/.test(failed.text), 'no results at all is FAILED - not "nothing found"');
  assert(/blank, not as a result/.test(failed.text), 'and it says the screen is blank rather than a verdict');

  // --- the four sentences must actually differ ---------------------------
  const sentences = [nothing.text, incomplete.text, hasWork.text, failed.text].map((t) => t.replace(/\s+/g, ' ').trim());
  assert(
    new Set(sentences).size === 4,
    `all four terminal states produce different copy (${new Set(sentences).size} distinct of 4)`
  );

  // --- what was checked, vs what was found -------------------------------
  console.log('');
  console.log('A check that found nothing and a check that never ran look different');

  await decideAndRender([
    RESULT({ finder: 'ran-clean', title: 'Ran and found nothing' }),
    RESULT({
      finder: 'never-ran',
      title: 'Never ran',
      unreadable: [{ path: '(check)', reason: 'check-did-not-run', detail: 'the engine returned nothing' }]
    })
  ]);

  const checklist = await run(`document.getElementById('hygiene-checklist').textContent`);
  assert(/Ran and found nothing/.test(checklist) && /Never ran/.test(checklist), 'both checks are listed by name');
  assert(
    (await run(`!!document.querySelector('#hygiene-checklist .hygiene-check-row.clean')`)) === true &&
      (await run(`!!document.querySelector('#hygiene-checklist .hygiene-check-row.blind')`)) === true,
    'and they carry different row states, so the difference survives on a screen that only lists findings'
  );

  const blind = await run(`document.getElementById('hygiene-unreadable').textContent`);
  assert(/Could not look here/.test(blind), 'unreadable locations get their own block');
  assert(
    /These are not findings/.test(blind),
    'which says outright that they are not findings - merging the two is how a partial scan starts reading as a complete one'
  );

  // --- the engine failing is not a clean machine -------------------------
  console.log('');
  console.log('An engine that fails does not report a clean machine');

  await evalInPage(`
    hygieneScanning = false;
    hygieneResults = [];
    window.__test.queueResponse('listHygieneFinders', { success: false, error: 'engine exploded', finders: [] });
    document.getElementById('btn-hygiene-scan').click();
    return true;
  `);
  await wait(600);
  const engineFail = await run(`document.getElementById('hygiene-verdict').textContent`);
  assert(/did not run/.test(engineFail), 'a failed registry read reports that the checks did not run');
  assert(!/Nothing found/.test(engineFail), 'and never as "nothing found"', engineFail.trim().slice(0, 160));
  assert(/engine exploded/.test(engineFail), 'and it repeats the engine\'s own reason rather than inventing one');

  // A scan whose per-check call rejects must reach decide() as could-not-look,
  // not as an absent result that gets counted as a clean look.
  await evalInPage(`
    hygieneScanning = false;
    hygieneResults = [];
    window.__test.queueResponse('runHygieneScan', { __reject: 'the engine died mid-check' });
    window.__test.queueResponse('runHygieneScan', { __reject: 'the engine died mid-check' });
    document.getElementById('btn-hygiene-scan').click();
    return true;
  `);
  const settled = await waitFor(`hygieneScanning === false && hygieneDecision !== null`, 6000);
  assert(settled, 'a run whose every check rejects still settles rather than hanging');
  const rejectedText = await run(`document.getElementById('hygiene-verdict').textContent`);
  assert(
    !/Nothing found, and the check was complete/.test(rejectedText),
    'and it is NOT reported as a complete clean check',
    rejectedText.trim().slice(0, 200)
  );
  assert(
    (await run(`hygieneDecision.unreadableCount > 0`)) === true,
    'the rejected checks reach the decider as could-not-look, carrying a reason, rather than as nothing at all'
  );

  // ------------------------------------------------------------------
  console.log('');
  console.log('The decision bar recommends by COST, never by size (949)');

  // The rule the whole bar exists for. A 14 GB package cache is the biggest
  // number on the screen and the least consequential thing on it; a megabyte
  // of uncommitted work is the opposite. A bar that led with the big number
  // would be teaching the habit that loses people their data.
  const costWins = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_HAS_WORK,
    findings: [
      { module: 'reclaim', costClass: 'cheap', bytes: 14300000000 },
      { module: 'rescue',  costClass: 'irreplaceable', bytes: 1 }
    ],
    unreadable: [], findingCount: 2, unreadableCount: 0, examinedCount: 9, totalBytes: 14300000001
  }, { scanning: false, returned: 9, total: 9 }))()`);
  assert(costWins.primary.id === 'go-rescue',
    `one irreplaceable byte outranks 14 GB of cache (got '${costWins.primary.id}': ${costWins.primary.label})`);
  assert(costWins.primary.enabled === true, 'and it is offered, not merely described');
  assert(!/GB|MB|bytes/i.test(costWins.primary.label),
    `the recommended click does not lead with a size (got '${costWins.primary.label}')`);

  // 'unknown' is not 'cheap'. lib/findings.js sorts it last for the same
  // reason: an unmeasured cost is not a zero one, and a bar that let it fall
  // through to a bytes-led offer would put the most dangerous thing last.
  const unknownWins = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_HAS_WORK,
    findings: [
      { module: 'reclaim', costClass: 'cheap', bytes: 99000000000 },
      { module: 'hygiene', costClass: 'unknown', bytes: 0 }
    ],
    unreadable: [], findingCount: 2, unreadableCount: 0, examinedCount: 4, totalBytes: 99000000000
  }, { scanning: false, returned: 4, total: 4 }))()`);
  assert(unknownWins.primary.id === 'go-unknown',
    `an unmeasured cost outranks 99 GB of cache (got '${unknownWins.primary.id}')`);

  // Only when nothing is hard to get back does the bar mention size at all.
  const cheapOnly = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_HAS_WORK,
    findings: [{ module: 'reclaim', costClass: 'cheap', bytes: 2000000000 }],
    unreadable: [], findingCount: 1, unreadableCount: 0, examinedCount: 3, totalBytes: 2000000000
  }, { scanning: false, returned: 3, total: 3 }))()`);
  assert(cheapOnly.primary.id === 'go-all', `with nothing costly, the offer is just to review (got '${cheapOnly.primary.id}')`);
  const cleanBtn = cheapOnly.secondary.find((a) => a.id === 'open-clean');
  // The bar headline says what ORDER to work in; the verdict block below says
  // how many. The first version repeated the verdict's sentence verbatim,
  // which was only obvious in a screenshot of the two together.
  const bar_heads = await run(`(() => {
    const F = window.VanishFindings;
    const mk = (cls) => ({
      state: F.UI_HAS_WORK,
      findings: [{ module: 'reclaim', costClass: cls, bytes: 10 }],
      unreadable: [], findingCount: 1, unreadableCount: 0, examinedCount: 2, totalBytes: 10
    });
    return ['irreplaceable', 'unknown', 'expensive', 'cheap']
      .map(c => hygieneDecisionActions(mk(c), { scanning: false }).headline);
  })()`);
  assert(new Set(bar_heads).size === 4, `each cost class gets its own headline (got ${JSON.stringify(bar_heads)})`);
  for (const h of bar_heads) {
    assert(!/\d/.test(h), `the bar headline carries no count - that is the verdict's job (got '${h}')`);
  }

  assert(cleanBtn && cleanBtn.enabled === true, 'System Clean is offered when the evidence is complete and there is something regenerable');

  // A partial run is never decided, and that outranks a perfectly good
  // has-work state built from three of thirteen checks.
  const midScan = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_HAS_WORK,
    findings: [{ module: 'rescue', costClass: 'irreplaceable', bytes: 1 }],
    unreadable: [], findingCount: 1, unreadableCount: 0, examinedCount: 2, totalBytes: 1
  }, { scanning: true, returned: 3, total: 13 }))()`);
  assert(midScan.phase === 'scanning', `a running scan is its own phase (got '${midScan.phase}')`);
  assert(midScan.primary.enabled === false, 'nothing is recommended mid-scan, even with findings already in hand');
  assert(midScan.secondary.every((a) => a.enabled === false), 'and no secondary action is offered either');
  assert(/partial/i.test(midScan.primary.why), `the refusal names the reason (got '${midScan.primary.why}')`);

  // Nothing found but something unreadable. This is the state the whole
  // subsystem exists for, and the bar must not offer an action computed from
  // a total it knows is short.
  const bar_incomplete = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_INCOMPLETE,
    findings: [], unreadable: [{ path: 'x' }, { path: 'y' }],
    findingCount: 0, unreadableCount: 2, examinedCount: 40, totalBytes: 0
  }, { scanning: false, returned: 9, total: 9 }))()`);
  assert(bar_incomplete.phase === 'incomplete', 'incomplete is its own phase');
  assert(bar_incomplete.primary.id === 'run', 'the only thing offered is to run again');
  const incClean = bar_incomplete.secondary.find((a) => a.id === 'open-clean');
  assert(incClean.enabled === false, 'System Clean is refused');
  assert(/floor/i.test(incClean.why), `and refused for the right reason (got '${incClean.why}')`);
  assert(bar_incomplete.caveat.length > 0, 'and a caveat explains what would change the answer');

  // has-work, but two locations could not be read. The findings are real and
  // worth showing; the byte TOTAL is a floor, so acting on it is refused while
  // reviewing what was found is not.
  const bar_blind = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_HAS_WORK,
    findings: [{ module: 'reclaim', costClass: 'cheap', bytes: 5000000000 }],
    unreadable: [{ path: 'a' }, { path: 'b' }],
    findingCount: 1, unreadableCount: 2, examinedCount: 12, totalBytes: 5000000000
  }, { scanning: false, returned: 9, total: 9 }))()`);
  assert(bar_blind.primary.enabled === true, 'findings that WERE read are still reviewable');
  const bar_blindClean = bar_blind.secondary.find((a) => a.id === 'open-clean');
  assert(bar_blindClean.enabled === false, 'but the action computed from the byte total is refused');
  assert(bar_blind.caveat.length > 0, 'and the bar carries the caveat');

  // Two different refusals must not share one sentence. A control that is off
  // for two reasons and prints one of them is a control that lies.
  const noReclaim = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_HAS_WORK,
    findings: [{ module: 'rescue', costClass: 'irreplaceable', bytes: 0 }],
    unreadable: [], findingCount: 1, unreadableCount: 0, examinedCount: 5, totalBytes: 0
  }, { scanning: false, returned: 9, total: 9 }))()`);
  const nrClean = noReclaim.secondary.find((a) => a.id === 'open-clean');
  assert(nrClean.enabled === false, 'System Clean is refused when nothing regenerable was found');
  assert(nrClean.why !== incClean.why,
    'and its reason differs from the unreadable-total one - two refusals, two sentences');
  assert(/nothing regenerable/i.test(nrClean.why), `it names its own reason (got '${nrClean.why}')`);

  // Clean, and complete. The one state on this screen that means clean, so the
  // bar says there is nothing to decide rather than inventing something to do.
  const clean = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_NOTHING_FOUND,
    findings: [], unreadable: [], findingCount: 0, unreadableCount: 0, examinedCount: 61, totalBytes: 0
  }, { scanning: false, returned: 9, total: 9 }))()`);
  assert(clean.primary.enabled === false, 'nothing-found offers no primary action');
  assert(clean.secondary.some((a) => a.id === 'copy' && a.enabled), 'but the report is still copyable');

  // A bar_failed scan is not an unstarted one. These were the two states most
  // likely to share a rendering, which is the defect the verdict block above
  // was built to prevent, so the bar gets the same treatment.
  const notRun = await run(`(() => hygieneDecisionActions(null, { scanning: false, returned: 0, total: 0 }))()`);
  const bar_failed = await run(`(() => hygieneDecisionActions({
    state: window.VanishFindings.UI_FAILED,
    findings: [], unreadable: [], findingCount: 0, unreadableCount: 0, examinedCount: 0, totalBytes: 0
  }, { scanning: false, returned: 0, total: 9 }))()`);
  assert(notRun.phase === 'not-run' && bar_failed.phase === 'failed', 'never-run and failed are different phases');
  assert(notRun.headline !== bar_failed.headline,
    `and they do not share a sentence (both said '${notRun.headline}')`);
  assert(notRun.primary.id === 'run' && bar_failed.primary.id === 'run', 'both offer a run, which is the only honest action for either');

  // THE INVARIANT, checked across every phase rather than per case: this panel
  // is read-only, so no state may ever produce an enabled action that removes
  // anything, and every state carries the standing promise saying so.
  const phases = await run(`(() => {
    const F = window.VanishFindings;
    const mk = (state, findings, unreadable) => ({
      state, findings: findings || [], unreadable: unreadable || [],
      findingCount: (findings || []).length, unreadableCount: (unreadable || []).length,
      examinedCount: 3, totalBytes: 0
    });
    const cases = [
      hygieneDecisionActions(null, { scanning: false }),
      hygieneDecisionActions(mk(F.UI_HAS_WORK, [{ module: 'reclaim', costClass: 'cheap', bytes: 5 }]), { scanning: true, returned: 1, total: 9 }),
      hygieneDecisionActions(mk(F.UI_HAS_WORK, [{ module: 'reclaim', costClass: 'cheap', bytes: 5 }]), { scanning: false }),
      hygieneDecisionActions(mk(F.UI_NOTHING_FOUND), { scanning: false }),
      hygieneDecisionActions(mk(F.UI_INCOMPLETE, [], [{ path: 'a' }]), { scanning: false }),
      hygieneDecisionActions(mk(F.UI_FAILED), { scanning: false })
    ];
    return cases.map(c => ({
      phase: c.phase,
      never: c.never || '',
      enabled: [c.primary].concat(c.secondary || []).filter(a => a && a.enabled).map(a => a.id)
    }));
  })()`);
  assert(phases.length === 6, 'six phases exercised');
  const seen = phases.map((p) => p.phase);
  assert(new Set(seen).size === 6, `each case produced a distinct phase (got ${JSON.stringify(seen)})`);
  const destructive = /delete|remove|purge|clean-now|free-now|fix-all/i;
  for (const p of phases) {
    assert(p.never.length > 0, `${p.phase} carries the standing "nothing here deletes anything" line`);
    for (const id of p.enabled) {
      assert(!destructive.test(id), `${p.phase} offers no destructive action (found '${id}')`);
    }
  }
  assert(
    phases.find((p) => p.phase === 'scanning').enabled.length === 0,
    'and the scanning phase offers nothing enabled at all'
  );
  // The model above is a pure function; this is the only proof it reaches the
  // screen. renderHygieneAll draws the bar last, with the decision it actually
  // used, so a bar describing a state the panel has moved past would show here.
  await decideAndRender([
    RESULT({
      finder: 'r1', module: 'reclaim',
      findings: [{ id: 'f1', title: 'npm cache', path: 'C:/npm', bytes: 5000000000, costClass: 'cheap', action: 'audit' }],
      unreadable: [{ path: 'C:/locked', reason: 'access-denied', detail: 'no' }],
      examinedCount: 4, totalBytes: 5000000000
    })
  ]);
  const barHtml = await run(`document.getElementById('hygiene-decisionbar').innerHTML`);
  assert(barHtml.length > 0, 'the decision bar renders into the page at all');
  const barText = await run(`document.getElementById('hygiene-decisionbar').textContent`);
  assert(/deletes anything/.test(barText),
    'and carries the standing promise on screen, not only in the model');

  // Disabled, present, and explained ON THE PAGE. A reason that lives only in
  // a title attribute is not an explanation for anyone who never hovers.
  const offBtns = await run(`(() => Array.from(
    document.querySelectorAll('#hygiene-decisionbar button[data-act]')
  ).map(b => ({ act: b.getAttribute('data-act'), off: b.disabled })))()`);
  const cleanOff = offBtns.find((b) => b.act === 'open-clean');
  assert(cleanOff && cleanOff.off === true,
    'with an unreadable location present, System Clean is rendered DISABLED rather than hidden');
  assert(/floor and not a total/.test(barText),
    'and the reason is printed in the bar, not left in a tooltip');

  // The scroll target the primary action needs. Without an id per module block
  // the focus action would silently do nothing.
  const modIds = await run(`(() => Array.from(document.querySelectorAll('#hygiene-modules .hygiene-module')).map(n => n.id))()`);
  assert(modIds.length > 0 && modIds.every((i) => i.indexOf('hygiene-mod-') === 0),
    `every module block carries a scroll id (got ${JSON.stringify(modIds)})`);


  // ------------------------------------------------------------------
  console.log('');
  console.log('Checks that share a walk of the disk are ONE call, and still four results (3l8)');

  // The grouping itself, before any IPC. Invoke-SharedTreeWalk memoises per
  // PROCESS, so four checks only share a walk if they are in one engine call;
  // scheduled apart the cache never hits and the saving is zero.
  const units = await run(`(() => hygieneWalkUnits([
    { name: 'a', walkGroup: '' },
    { name: 'b', walkGroup: 'tree' },
    { name: 'c', walkGroup: '' },
    { name: 'd', walkGroup: 'tree' },
    { name: 'e', walkGroup: 'other' }
  ]).map(u => u.map(f => f.name).join('+')))()`);
  assert(units.length === 4, `five checks with two shared walks make four units (got ${units.length}: ${units})`);
  assert(units.indexOf('b+d') >= 0, 'the two checks sharing a walk are one unit');
  assert(units.indexOf('a') >= 0 && units.indexOf('c') >= 0, 'and checks that share nothing are still scheduled on their own');
  assert(units[0] === 'a', 'registry order is kept, so the checklist does not reshuffle itself');
  assert(units[1] === 'b+d', 'and a group takes the position of its FIRST member rather than sinking to the end');

  // Grouping made the four reclaim checks the second-largest piece of work in
  // the scan, sitting last in registry order - so with a pool of three they
  // were started last and the whole run ended when they did. Largest first,
  // measured same-run: 92.3 s to 81.5 s.
  const order = await run(`(() => hygieneScheduleOrder([
    [{ name: 'a' }], [{ name: 'b' }, { name: 'c' }, { name: 'd' }], [{ name: 'e' }], [{ name: 'f' }, { name: 'g' }]
  ]).map(u => u.map(f => f.name).join('+')))()`);
  assert(order[0] === 'b+c+d', `the largest unit is started first (got ${JSON.stringify(order)})`);
  assert(order[1] === 'f+g', 'then the next largest');
  assert(
    order[2] === 'a' && order[3] === 'e',
    'and units of equal size keep registry order between them - the sort is stable, so a rerun schedules the same way'
  );
  assert(
    (await run(`hygieneScheduleOrder(hygieneWalkUnits([{name:'x'},{name:'y'}])).length === 2`)) === true,
    'scheduling never drops or duplicates a unit'
  );

  const undeclared = await run(`(() => hygieneWalkUnits([
    { name: 'a' }, { name: 'b', walkGroup: null }, { name: 'c', walkGroup: '   ' }
  ]).length)()`);
  assert(undeclared === 3, `a missing, null or blank walkGroup means "on its own", never one accidental mega-group (got ${undeclared})`);
  // Now through the bridge, which is where it has to be true.
  const GROUPED = {
    success: true, loaded: [], loadErrors: [],
    finders: [
      { name: 'g-node', title: 'G node', module: 'reclaim', walkGroup: 'user-tree' },
      { name: 'g-zip', title: 'G zip', module: 'reclaim', walkGroup: 'user-tree' },
      { name: 'g-dart', title: 'G dart', module: 'reclaim', walkGroup: 'user-tree' },
      { name: 'g-gradle', title: 'G gradle', module: 'reclaim', walkGroup: 'user-tree' },
      { name: 'solo', title: 'Solo check', module: 'hygiene', walkGroup: '' }
    ]
  };

  await evalInPage(`
    hygieneScanning = false;
    hygieneResults = [];
    window.__test.resetCallCounts();
    window.__test.queueResponse('listHygieneFinders', ${JSON.stringify(GROUPED)});
    document.getElementById('btn-hygiene-scan').click();
    return true;
  `);
  await waitFor(`hygieneScanning === false && hygieneDecision !== null`, 8000);

  const sent = await run(`window.__test.callArgs('runHygieneScan').map(a => (a[0].finders || []).join('+'))`);
  assert(
    sent.length === 2,
    `five checks became TWO engine calls, not five - which is the entire saving (got ${sent.length}: ${JSON.stringify(sent)})`
  );
  assert(
    sent.indexOf('g-node+g-zip+g-dart+g-gradle') >= 0,
    'and the four that share a walk went in ONE call, so the engine can memoise the walk between them',
    JSON.stringify(sent)
  );
  assert(sent.indexOf('solo') >= 0, 'while the check that shares nothing still went on its own');
  assert(
    (await run(`hygieneResults.length === 5`)) === true,
    'and five checks still produce five results - grouping is a scheduling change, not a merge'
  );
  assert(
    (await run(`hygieneDecision.state === 'nothing-found'`)) === true,
    'a grouped run where every check really did look and find nothing is still allowed to say so',
    await run(`hygieneDecision.state`)
  );
  // THE FAILURE MODE GROUPING CREATED, and the reason this section exists at
  // all: three results coming back for a call that asked about four. Before
  // 3l8 a call carried one check, so 'no result' and 'this check failed' were
  // the same event. Now a check can go MISSING out of a group while its
  // neighbours answer - and a missing result is not a clean one.
  console.log('');
  console.log('A check missing from a group answer is could-not-look, not absent');

  const SHORT = {
    success: true,
    results: ['g-node', 'g-zip', 'g-dart'].map((n) => ({
      finder: n, title: n, module: 'reclaim', state: 'nothing',
      findings: [], unreadable: [], examinedCount: 2, totalBytes: 0
    }))
  };
  await evalInPage(`
    hygieneScanning = false;
    hygieneResults = [];
    window.__test.resetCallCounts();
    window.__test.queueResponse('listHygieneFinders', ${JSON.stringify(GROUPED)});
    window.__test.queueResponse('runHygieneScan', ${JSON.stringify(SHORT)});
    document.getElementById('btn-hygiene-scan').click();
    return true;
  `);
  await waitFor(`hygieneScanning === false && hygieneDecision !== null`, 8000);

  assert(
    (await run(`hygieneResults.length === 5`)) === true,
    `the check the engine skipped is still accounted for - five checks, five results (got ${await run('hygieneResults.length')})`
  );
  const missing = await run(`(() => {
    const r = hygieneResults.find(x => x.finder === 'g-gradle');
    return r ? { blind: r.unreadable.length, reason: r.unreadable[0] && r.unreadable[0].reason, detail: r.unreadable[0] && r.unreadable[0].detail } : null;
  })()`);
  assert(missing !== null, 'the skipped check appears by name rather than vanishing from the set');
  assert(missing && missing.blind > 0, 'and it carries an unreadable record, which is what makes it could-not-look');
  assert(missing && missing.reason === 'check-did-not-run', `with the reason that says so (${missing && missing.reason})`);
  assert(
    missing && /3 of the 4/.test(missing.detail || ''),
    'and the detail says the engine answered for its neighbours but not for it - a different problem from the whole call failing, and reported as one',
    (missing && missing.detail) || ''
  );
  // Asserted POSITIVELY. 'not nothing-found' would also pass on a typo, on a
  // renamed state, on undefined - the vacuous pass this suite exists to
  // refuse. The run is incomplete, and incomplete is a name it has.
  assert(
    (await run(`hygieneDecision.state === 'incomplete'`)) === true,
    'so the run is decided INCOMPLETE, not as a clean machine on the strength of a check that never reported',
    await run(`hygieneDecision.state`)
  );

  console.log('');
  console.log('A group call that fails takes ALL of its checks down with it, by name');
  await evalInPage(`
    hygieneScanning = false;
    hygieneResults = [];
    window.__test.resetCallCounts();
    window.__test.queueResponse('listHygieneFinders', ${JSON.stringify(GROUPED)});
    window.__test.queueResponse('runHygieneScan', { __reject: 'the shared walk crashed' });
    document.getElementById('btn-hygiene-scan').click();
    return true;
  `);
  await waitFor(`hygieneScanning === false && hygieneDecision !== null`, 8000);
  const downed = await run(`hygieneResults.filter(r => r.unreadable.length > 0).map(r => r.finder).sort()`);
  assert(
    downed.length === 4,
    `all four checks in the failed group are reported, not just the call (got ${downed.length}: ${JSON.stringify(downed)})`
  );
  assert(
    (await run(`hygieneResults.filter(r => r.unreadable.some(u => /shared walk crashed/.test(u.detail || ''))).length === 4`)) === true,
    "and every one of them repeats the engine's own reason rather than a generic one"
  );
  assert(
    (await run(`['g-node','g-zip','g-dart','g-gradle'].every(n => hygieneStatus[n] === 'error')`)) === true,
    'and the checklist marks all four as failed, so the screen agrees with the decision'
  );
  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail > 0 ? 1 : 0);
});
