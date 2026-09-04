// qkgu: what the System Clean panel says when the sweep was refused.
//
//   npx electron test/cleaner-blindspot-ui-verify.js
//
// test/cleaner-blindspot-verify.ps1 proves the engine can now tell a denied
// read from an absent key, and that Invoke-CleanerScan computes a state from
// the evidence instead of asserting success. None of that is worth anything if
// the screen still draws a green tick, and the screen is where the defect was
// actually visible:
//
//     if (state.findings.length === 0) -> a green check and the words
//                                         "Nothing left behind here."
//
// One line, one condition, two completely different facts underneath it. A
// sweep that an ACL refused and a machine that is genuinely clean produced the
// same empty list, so they produced the same sentence.
//
// This runs against the REAL renderer/queue-clean.js through the real
// scanCleaner path, with only the IPC response stubbed. The decision is not
// injected: the page builds it by calling lib/findings.js, which is the same
// file the main process uses rather than a copy of its rules.
//
// Read-only, either tier: nothing here scans or removes anything.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

let pass = 0;
let fail = 0;
let lastLabel = '(nothing yet)';

function assert(condition, label, detail = '') {
  lastLabel = label;
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.log(`  FAIL  timed out. Last completed assertion: ${lastLabel}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

// The section used throughout. 'services' is a registry sweep, which is the
// one an ACL actually refuses in the field.
const SECTION = 'services';

app.whenReady().then(async () => {
  console.log('');
  console.log('System Clean: a refused sweep on screen (qkgu)');
  console.log('=============================================');

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const js = (src) => win.webContents.executeJavaScript(src);

  // Every payload goes through the real scanCleaner, so the decision, the
  // badge and the body are all produced by production code. Wrapped in a
  // try/catch that RETURNS the error: an uncaught throw inside
  // executeJavaScript hangs Electron rather than rejecting, and a hang reads
  // as a timeout with no cause attached.
  async function scanWith(payload) {
    return js(`(async () => {
      try {
        window.__test.queueResponse('cleanerScan', ${JSON.stringify(payload)});
        await scanCleaner(${JSON.stringify(SECTION)}, { expand: true });
        const body = document.getElementById('cleaner-body-${SECTION}');
        const badge = document.getElementById('cleaner-count-${SECTION}');
        const st = cleanerState[${JSON.stringify(SECTION)}];
        return {
          text: body ? body.textContent.replace(/\\s+/g, ' ').trim() : '(no body)',
          html: body ? body.innerHTML : '',
          badgeText: badge ? badge.textContent : null,
          badgeClass: badge ? badge.className : null,
          badgeTitle: badge ? badge.title : null,
          state: st && st.decision ? st.decision.state : null,
          trustworthy: st && st.decision ? st.decision.trustworthy : null,
          unreadableCount: st && st.decision ? st.decision.unreadableCount : null,
          findingCount: st ? st.findings.length : null,
          purgeButtons: body ? body.querySelectorAll('[data-purge]').length : -1
        };
      } catch (e) {
        // A full shape even on failure. A partial object makes the NEXT
        // assertion throw on undefined.slice, and an unhandled rejection here
        // stalls the run instead of failing it - which is how this suite spent
        // its first execution reporting a timeout with no cause attached.
        return { error: String((e && e.stack) || e), text: '', html: '', badgeText: null, badgeClass: null, badgeTitle: null, state: null, trustworthy: null, unreadableCount: null, findingCount: null, purgeButtons: -1 };
      }
    })()`);
  }

  // The sections are built when the System Clean tab is first opened, not at
  // load, so build them here. Without this every lookup below returns null and
  // the suite would "prove" the absence of a green tick by finding no page.
  const built = await js(`(() => {
    try {
      renderCleanerSections();
      return Boolean(document.getElementById('cleaner-body-${SECTION}'));
    } catch (e) { return String(e); }
  })()`);
  assert(built === true, 'premise: the System Clean sections are on the page', String(built));

  // And the page has the decision seam at all. If VanishFindings failed to
  // load, every state below would be null and every "not a green tick"
  // assertion would pass for the wrong reason.
  const wired = await js(`(() => ({
    hasApi: typeof (window.VanishFindings || {}).fromCleanerScan === 'function',
    incomplete: (window.VanishFindings || {}).UI_INCOMPLETE || null
  }))()`);
  assert(wired.hasApi === true, 'premise: the page exposes fromCleanerScan, which is what scanCleaner calls');
  assert(wired.incomplete === 'incomplete', 'and the state vocabulary is the shared one, not a local string');

  // ------------------------------------------------------------------
  console.log('');
  console.log('A genuinely clean sweep is still a green tick');

  // FIRST, because a change that turned every quiet result into a warning
  // would be worse than the defect it fixes: it would teach the operator that
  // the warning means nothing. The tick has to survive.
  const clean = await scanWith({ success: true, findings: [], unreadable: [] });
  assert(!clean.error, 'the clean payload renders without throwing', clean.error || '');
  assert(clean.state === 'nothing-found', `it is nothing-found (${clean.state})`);
  assert(clean.trustworthy === true, 'and trustworthy, which is what earns the tick');
  assert(/fa-circle-check/.test(clean.html), 'the green check is drawn');
  assert(/Nothing left behind here/.test(clean.text), 'with the plain sentence', clean.text.slice(0, 120));
  assert(clean.badgeText === '0', `and the badge is a flat zero (${clean.badgeText})`);

  // ------------------------------------------------------------------
  console.log('');
  console.log('A sweep that was REFUSED is not');

  const refused = await scanWith({
    success: true,
    findings: [],
    unreadable: [
      { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SomeService', reason: 'key-denied', detail: 'Requested registry access is not allowed.' },
      { path: 'HKLM\\SECURITY', reason: 'key-denied', detail: 'Requested registry access is not allowed.' }
    ],
    unreadableDropped: 0
  });
  assert(!refused.error, 'the refused payload renders without throwing', refused.error || '');
  assert(refused.findingCount === 0, 'it has exactly as many findings as the clean one: none');
  assert(refused.state === 'incomplete', `but the state is incomplete (${refused.state})`);
  assert(refused.trustworthy === false, 'and explicitly not trustworthy');

  // THE ASSERTIONS THIS FILE EXISTS FOR.
  assert(!/fa-circle-check/.test(refused.html),
    'NO green check - the two payloads differ only in the unreadable list, and that used to change nothing on screen');
  assert(!/Nothing left behind here/.test(refused.text),
    'and it never says nothing was left behind, because nobody looked', refused.text.slice(0, 160));
  assert(/did not finish/.test(refused.text),
    'it says the sweep did not finish', refused.text.slice(0, 160));
  assert(/not the same as clean/i.test(refused.text),
    'in the shared headline, which draws the distinction in words rather than leaving it to a colour',
    refused.text.slice(0, 240));

  assert(/SECURITY/.test(refused.text) && /SomeService/.test(refused.text),
    'the locations that could not be read are NAMED - "2 locations" is a shrug, a path is actionable',
    refused.text.slice(0, 240));
  assert(/key-denied/.test(refused.text),
    'each with the reason it failed');

  assert(refused.badgeText === '?',
    `the collapsed badge is '?' rather than '0' (${refused.badgeText}) - the badge is all the user sees before deciding not to open the section`);
  assert(typeof refused.badgeTitle === 'string' && refused.badgeTitle.length > 0,
    'and carries the headline on hover, so the question mark is explainable without expanding the section');
  assert(refused.purgeButtons === 0,
    'with nothing to quarantine there is no quarantine button, rather than a button that does nothing');

  // ------------------------------------------------------------------
  console.log('');
  console.log('Findings AND a refusal: still work to do, and still not the whole story');

  // The more dangerous half. "We found 3" silently meaning "3 of an unknown
  // number" is the same defect wearing a success badge - and here there is a
  // Move-to-quarantine button under it, so the user is about to decide they
  // have dealt with the problem.
  const partial = await scanWith({
    success: true,
    findings: [
      { id: 'svc|Dead', label: 'DeadService', evidence: 'ImagePath target missing: C:\\gone.exe', risk: 'Safe', kind: 'registry', registryPath: 'HKLM\\SYSTEM\\X', removable: true }
    ],
    unreadable: [{ path: 'HKLM\\SECURITY', reason: 'key-denied', detail: 'denied' }]
  });
  assert(!partial.error, 'the partial payload renders without throwing', partial.error || '');
  assert(partial.state === 'has-work', `there is work to offer (${partial.state})`);
  assert(partial.trustworthy === false, 'and the list is explicitly not complete');
  assert(/DeadService/.test(partial.text), 'the finding is shown - a blind spot must not cost the user the findings we DID get');
  assert(partial.purgeButtons === 1, 'and it can still be quarantined, because it is still real');
  assert(/incomplete/i.test(partial.text) && /more here than is shown/.test(partial.text),
    'but the list says it is incomplete, above the button', partial.text.slice(0, 220));
  assert(partial.badgeText === '1+',
    `and the badge reads '1+' rather than '1' (${partial.badgeText}) - the count is a floor, not a total`);

  // ------------------------------------------------------------------
  console.log('');
  console.log('The engine capping its own list is not the same as there being no more');

  const capped = await scanWith({
    success: true,
    findings: [],
    unreadable: [{ path: 'HKLM\\A', reason: 'key-denied', detail: '' }],
    unreadableDropped: 47
  });
  assert(capped.state === 'incomplete', 'still incomplete');
  assert(/47 more location/.test(capped.text),
    'and the locations the ENGINE dropped are counted on screen, not quietly absent from a list that looks complete',
    capped.text.slice(0, 240));

  // ------------------------------------------------------------------
  console.log('');
  console.log('A scan that failed outright keeps its own screen');

  // 'failed' and 'could-not-look' are different sentences: "the sweep did not
  // run" against "the sweep ran and could not read four keys". Folding the
  // first into the second would lose the engine's error message, which is the
  // only thing that says why.
  const failed = await scanWith({ success: false, error: 'The engine returned no output.', findings: [] });
  assert(/engine returned no output/i.test(failed.text),
    'the engine error reaches the screen rather than a console nobody reads', failed.text.slice(0, 160));
  assert(!/fa-circle-check/.test(failed.html), 'and there is no green check on it either');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail === 0 ? 0 : 1);
});
