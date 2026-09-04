// y1j: hand deep process work to System Informer, if the user already has it.
//
//   npx electron test/system-informer-verify.js
//
// The feature is three sentences of text, and almost all of the risk is in
// what it must NOT do. Operator decision 2026-08-14: System Informer is MIT and
// bundling it would be legal; it is refused on cost, because its deep
// capabilities need a signed kernel driver. The scope that survived is "state
// that the tool is present and what it is better at. Nothing else."
//
// So the assertions are mostly refusals:
//
//   absent  -> the app says NOTHING about it. Not a placeholder, not a greyed
//              row, not a download link. A tool the user does not have is not
//              a gap in their setup.
//   present -> it says so, says how it knows, and says what the tool is better
//              at - without ever calling it safe, recommended or trusted.
//              Vanish does not make claims about software, including about its
//              own startup entries, and buying an exception here would be the
//              affiliate-recommendation surface the issue forbids.
//
// It runs in either tier: reading a list already in the renderer is not a
// privileged operation.

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

// The fields renderProcessTable actually reads. Named rather than spread from
// a blob, because a missing one throws inside a template literal and Electron
// answers a throw in executeJavaScript by HANGING.
function proc(pid, name) {
  return {
    pid,
    name,
    cpuPercent: 0,
    memoryBytes: 1024 * 1024,
    ioBytesPerSec: 0,
    description: name,
    company: 'Test',
    signature: 'unsigned',
  };
}

const PLAIN = [proc(1000, 'explorer.exe'), proc(1001, 'chrome.exe')];
const WITH_SI = PLAIN.concat([proc(1002, 'SystemInformer.exe')]);

// A name that CONTAINS the exe name but is not it, and a program whose name
// merely mentions the words. Detection has to be exact enough to refuse both.
const LOOKALIKES = PLAIN.concat([
  proc(1003, 'NotSystemInformer.exe'),
  proc(1004, 'systeminformer.exe.bak'),
]);

const APP_ROW = {
  id: 'si', name: 'System Informer', publisher: 'Winsider Seminars & Solutions Inc.',
  version: '3.0', installDate: '2025-01-01', installDateSource: 'recorded',
  sizeBytes: 1048576, installLocation: '', registryPath: 'HKLM:\\si',
  type: 'Desktop', classification: 'application',
};

app.whenReady().then(async () => {
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

  console.log('');
  console.log('System Informer handoff (y1j)');
  console.log('=============================');

  async function noteAfter(procList, apps) {
    // The whole payload is wrapped so a throw inside the renderer comes back as
    // a value instead of rejecting executeJavaScript - which in Electron HANGS
    // the harness rather than failing it, and cost two timed-out runs before
    // this wrapper existed.
    const res = await run(`(() => {
      try {
        processes = ${JSON.stringify(procList)};
        allApps = ${JSON.stringify(apps)};
        renderProcessTable();
        const el = document.getElementById('system-informer-note');
        return {
          ok: true,
          present: Boolean(el),
          shown: el ? el.style.display !== 'none' : false,
          text: el ? el.textContent.trim() : '',
          html: el ? el.innerHTML : '',
        };
      } catch (e) {
        return { ok: false, err: String((e && e.stack) || e) };
      }
    })()`);
    if (!res || res.ok !== true) {
      assert(false, 'the renderer threw while re-rendering the process table', res && res.err);
      return { present: false, shown: false, text: '', html: '' };
    }
    return res;
  }

  // ------------------------------------------------------------------
  console.log('');
  console.log('Absent: the app says nothing at all');

  const none = await noteAfter(PLAIN, []);
  assert(none.present === true, 'premise: the note element exists in the page');
  assert(none.shown === false, 'it is hidden when System Informer is neither running nor installed');
  assert(none.text === '', 'and it holds no text at all - not a placeholder, not a greyed-out row', JSON.stringify(none.text));

  const lookalikes = await noteAfter(LOOKALIKES, []);
  assert(lookalikes.shown === false,
    'a process merely NAMED like it does not trigger the note (NotSystemInformer.exe, systeminformer.exe.bak)',
    lookalikes.text);

  // ------------------------------------------------------------------
  console.log('');
  console.log('Present: it says so, and says how it knows');

  const running = await noteAfter(WITH_SI, []);
  assert(running.shown === true, 'a running SystemInformer.exe is detected');
  assert(/running right now/i.test(running.text),
    'and the note says the evidence was the running process', running.text);

  const installed = await noteAfter(PLAIN, [APP_ROW]);
  assert(installed.shown === true, 'an uninstall entry is detected when nothing is running');
  assert(/uninstall entry/i.test(installed.text),
    'and the note says THAT was the evidence instead', installed.text);

  const both = await noteAfter(WITH_SI, [APP_ROW]);
  assert(/running right now/i.test(both.text),
    'with both signals the stronger one wins, so the note is never ambiguous about what it saw',
    both.text);

  // ------------------------------------------------------------------
  console.log('');
  console.log('What the note must never say');
  // The boundary from the issue, asserted rather than trusted to review.

  const banned = [
    ['safe', /\bsafe\b/i],
    ['trusted', /\btrusted\b/i],
    ['recommend', /\brecommend/i],
    ['download', /\bdownload\b/i],
    ['install it', /\binstall it\b/i],
    ['a link out of the app', /https?:/i],
  ];
  for (const [what, re] of banned) {
    assert(!re.test(both.html), `it never says "${what}"`, both.html);
  }
  assert(!/<a\b/i.test(both.html),
    'and carries no anchor at all, so it cannot become a recommendation surface by accident');

  assert(/handles|tokens|kernel/i.test(both.text),
    'it does say what the tool is better at, which is the whole point of pointing at it',
    both.text);
  assert(/deliberately does not|loads no kernel driver/i.test(both.text),
    'and says what Vanish itself will not do, rather than implying it fell short',
    both.text);

  // ------------------------------------------------------------------
  console.log('');
  console.log('It is re-evaluated, not decided once');

  const gone = await noteAfter(PLAIN, []);
  assert(gone.shown === false,
    'closing System Informer hides the note again on the next refresh - it is a live reading, not a one-time verdict');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
