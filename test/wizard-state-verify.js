// D-1 in the DOM: the uninstall wizard's leftover screen renders a STATE.
//
// test/findings-verify.js proves the state machine. This proves the wiring -
// that the screen actually asks it, and that the control the operator reported
// is not merely disabled but ABSENT in the states where it means nothing.
//
// The bug, reported 2026-08-21: when the post-uninstall scan finds no
// leftovers, "Move to quarantine" still behaves like a Next button. It
// advances the wizard, on a screen that has no Next button and nowhere to
// advance to. The operator's classification is the right one - the control
// performs navigation it does not name.
//
// The old code read `elements.btnWizPurge.style.display = (index === 4) ?
// 'block' : 'none'` - the button existed because of WHICH SCREEN this was,
// never because of what was on it. The zero-result case then fell into a
// "Nothing selected - finish without moving anything?" dialog, so a destructive
// red button became the Finish button, and the two zero cases (found nothing /
// could not look) were indistinguishable because they were the same value.
//
// HANDOFF-2026-08-21 was explicit that a guard inside the click handler is not
// the fix: "patching it leaves the class intact." So these assertions are about
// what EXISTS on the screen in each of the three states, which is the thing a
// guard would not have changed.
//
//   npx electron test/wizard-state-verify.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    fail += 1;
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Drive the leftover screen with one scan payload and report what the DOM says.
//
// Every payload goes through window.VanishFindings.fromLeftovers - the same
// call renderer/wizard.js makes after a real scan - rather than through a
// hand-set state, so a change that broke the derivation would fail here rather
// than being papered over by the fixture.
//
// The IIFE wrapper is not decoration: these renderer files are CLASSIC SCRIPTS
// sharing one global lexical environment, and a bare top-level const that
// collides with any name in them makes the ENTIRE script fail at instantiation,
// silently, with the page looking untouched.
async function drive(win, payload) {
  return win.webContents.executeJavaScript(`(() => {
    wizState.leftovers = ${JSON.stringify({ files: (payload.files || []), registry: (payload.registry || []) })};
    wizState.leftoverDecision = window.VanishFindings.fromLeftovers(${JSON.stringify(payload)});
    renderLeftoversTree();
    showScreen(4);

    const visible = (el) => !!el && el.style.display !== 'none';
    return {
      state: wizState.leftoverDecision.state,
      canAdvance: wizState.leftoverDecision.canAdvance,
      purgeVisible: visible(elements.btnWizPurge),
      finishVisible: visible(elements.btnWizFinish),
      nextVisible: visible(elements.btnWizNext),
      selectAllVisible: visible(elements.btnSelectAll),
      summary: elements.lblLeftoversSummary.textContent,
      treeText: elements.leftoversTreeView.textContent,
      checkboxCount: elements.leftoversTreeView.querySelectorAll('input[type="checkbox"]').length
    };
  })()`);
}

(async () => {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1200, height: 820, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);

  console.log('');
  console.log('Vanish uninstall-wizard state verification (dga / D-1)');
  console.log('=====================================================');

  try {
    // ==================================================================
    console.log('');
    console.log('D-1.0 the seam is actually loaded in the page');

    const wired = await win.webContents.executeJavaScript(`(() => ({
      hasModule: typeof window.VanishFindings === 'object' && window.VanishFindings !== null,
      hasFromLeftovers: typeof (window.VanishFindings || {}).fromLeftovers === 'function',
      initialDecision: wizState.leftoverDecision === undefined ? 'undefined' : String(wizState.leftoverDecision)
    }))()`);

    // Asserted first, deliberately. If lib/findings.js were not loaded by
    // index.html, every assertion below would throw rather than fail, and the
    // suite would be reported as NOT RUN - which reads the same as skipped.
    assert(wired.hasModule === true, 'lib/findings.js is loaded as a classic script in the page');
    assert(wired.hasFromLeftovers === true, 'and exposes fromLeftovers, which is what the wizard calls');

    // ==================================================================
    console.log('');
    console.log('D-1.1 leftovers found: the quarantine control exists, because there is something to quarantine');

    const work = await drive(win, {
      success: true,
      files: [
        { path: 'C:\\ProgramData\\Thing', sizeBytes: 4096, risk: 'Safe', type: 'Data folder' },
        { path: 'C:\\Users\\x\\AppData\\Roaming\\Thing', sizeBytes: 2048, risk: 'Moderate', type: 'Settings' }
      ],
      registry: [{ path: 'HKCU\\Software\\Thing', risk: 'Safe', type: 'Settings key' }]
    });

    assert(work.state === 'has-work', 'the screen is in has-work');
    assert(work.purgeVisible === true, '"Move to quarantine" is shown');
    assert(work.finishVisible === false, 'and Finish is not, because the flow has somewhere to go');
    assert(work.selectAllVisible === true, '"Select all" is shown, because there is something to select');
    assert(work.checkboxCount === 3, 'all three leftovers render as tickable rows');
    assert(/3 leftovers found/.test(work.summary), 'and the summary counts them');

    // ==================================================================
    console.log('');
    console.log('D-1.2 nothing found: the control is ABSENT, not disabled, not repurposed');

    const clean = await drive(win, { success: true, files: [], registry: [] });

    assert(clean.state === 'nothing-found', 'a clean uninstall is the nothing-found terminal state');
    assert(clean.canAdvance === false, 'which cannot advance');
    assert(clean.purgeVisible === false, 'THE REGRESSION: "Move to quarantine" is not on screen at all');
    assert(clean.finishVisible === true, 'Finish is, and it is the only control offered');
    assert(clean.selectAllVisible === false, '"Select all" is gone too - there is nothing to select');
    assert(clean.checkboxCount === 0, 'and no tickable rows exist');
    assert(/removed itself cleanly/.test(clean.treeText), 'the screen says what happened');
    assert(/0 leftovers found/.test(clean.summary), 'and the summary agrees');

    // ==================================================================
    console.log('');
    console.log('D-1.3 the scan FAILED: a third state, which did not exist before');

    // main.js used to catch a failed scan and return { files: [], registry: [] }
    // - byte-identical to the clean result above. So an engine crash printed a
    // green tick and the words "this program removed itself cleanly", on the
    // most-used path in the application. That is aeu's defect class in
    // production, and it is why this is a separate case rather than a variant
    // of the one above.
    const failed = await drive(win, { success: false, error: 'ENGINE_BAD_OUTPUT', files: [], registry: [] });

    assert(failed.state === 'incomplete', 'a failed scan is the incomplete terminal state');
    assert(failed.state !== clean.state, 'and NOT the same state as a clean uninstall');
    assert(failed.purgeVisible === false, 'it offers no quarantine control either');
    assert(failed.finishVisible === true, 'Finish is the only way out');
    assert(/did not finish/.test(failed.treeText), 'the screen says the scan did not finish');
    assert(!/removed itself cleanly/.test(failed.treeText), 'and never claims the program removed itself cleanly');
    assert(!/^0 leftovers found$/.test(failed.summary.trim()), 'the summary does not read as a clean zero');
    assert(/unreadable/.test(failed.summary), 'it says how many locations could not be read');

    // ==================================================================
    console.log('');
    console.log('D-1.4 the button is a function of the state, in both directions');

    // Re-entering has-work after a terminal state has to bring the control
    // back. A one-way guard - hide it on empty, never show it again - would
    // pass every assertion above and break the feature.
    const again = await drive(win, {
      success: true,
      files: [{ path: 'C:\\ProgramData\\Other', sizeBytes: 1, risk: 'Safe', type: 'Data folder' }],
      registry: []
    });
    assert(again.purgeVisible === true, 'going back to has-work restores the quarantine control');
    assert(again.finishVisible === false, 'and withdraws Finish again');

    const nulled = await win.webContents.executeJavaScript(`(() => {
      wizState.leftoverDecision = null;
      showScreen(4);
      return { purgeVisible: elements.btnWizPurge.style.display !== 'none' };
    })()`);
    assert(nulled.purgeVisible === false, 'and an unresolved decision offers nothing - "not decided yet" is never permission');
  } catch (err) {
    console.log(`  FAIL  the suite threw: ${err && err.message}`);
    fail += 1;
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail > 0 ? 1 : 0);
})();
