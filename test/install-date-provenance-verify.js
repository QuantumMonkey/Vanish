// Install-date provenance regression suite (c0y).
//
// WHY THIS EXISTS: this bug was not found by a user report or a crash. It was
// found by auditing our own code for a mistake made in conversation - an
// install date read off an adjacent registry row and stated as fact, when the
// program in question had recorded no install date at all.
//
// Vanish had a guarded, defensible version of the same move in two places and
// labelled neither:
//
//   scanner.ps1  a program with no InstallDate falls back to its uninstall KEY
//                NAME when that name is eight digits
//   scanner.ps1  a Store app, which never records an install date, falls back
//                to its install FOLDER's CreationTime
//
// Both are good estimates. Neither is a date the program recorded, and both
// used to render in the same text, in the same styling, as one that was. A
// user sorting by age or deciding whether something is old enough to remove
// was mixing measurements with guesses and was not told which was which.
//
// So this suite asserts the rule rather than the pixels: a date carries its
// provenance, an inferred one is visibly and textually distinguishable from a
// recorded one, the fallback still happens (a probable date beats "Unknown"),
// and sorting is unchanged.
//
//   npx electron test/install-date-provenance-verify.js

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

// One app per provenance the engine can produce, plus the two shapes an older
// or incomplete engine build can send.
const FIXTURE = [
  {
    id: 'rec', name: 'Recorded Program', publisher: 'Acme', version: '1.0',
    installDate: '2024-03-04', installDateSource: 'recorded',
    sizeBytes: 1048576, installLocation: 'C:\\rec', registryPath: 'HKLM:\\rec',
    type: 'Desktop', classification: 'application',
  },
  {
    id: 'key', name: 'Key Named Program', publisher: 'Acme', version: '1.0',
    installDate: '2023-11-02', installDateSource: 'key-name',
    sizeBytes: 1048576, installLocation: 'C:\\key', registryPath: 'HKLM:\\key',
    type: 'Desktop', classification: 'application',
  },
  {
    id: 'uwp', name: 'Store Program', publisher: 'Acme', version: '1.0',
    installDate: '2025-06-07', installDateSource: 'folder-created',
    sizeBytes: 1048576, installLocation: 'C:\\uwp', registryPath: 'HKCU:\\uwp',
    type: 'UWP', classification: 'application',
  },
  {
    id: 'unk', name: 'Unsourced Program', publisher: 'Acme', version: '1.0',
    installDate: '2022-01-01', // a date with no source - an older engine build
    sizeBytes: 1048576, installLocation: 'C:\\unk', registryPath: 'HKLM:\\unk',
    type: 'Desktop', classification: 'application',
  },
  {
    id: 'none', name: 'Dateless Program', publisher: 'Acme', version: '1.0',
    installDate: null, installDateSource: null,
    sizeBytes: 1048576, installLocation: 'C:\\none', registryPath: 'HKLM:\\none',
    type: 'Desktop', classification: 'application',
  },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);

  console.log('');
  console.log('Vanish install-date provenance verification (c0y)');
  console.log('================================================');

  await win.webContents.executeJavaScript(`
    window.__test.queueResponse('getDesktopApps', ${JSON.stringify(FIXTURE)});
    loadApplications();
  `);
  await wait(1200);

  // --- The engine contract -------------------------------------------------
  console.log('');
  console.log('scanner.ps1 sets a source everywhere it sets a date');

  const fs = require('node:fs');
  const scanner = fs.readFileSync(path.join(__dirname, '..', 'scanner.ps1'), 'latin1');
  const dateAssignments = (scanner.match(/^\s*installDate\s*=/gm) || []).length;
  const sourceAssignments = (scanner.match(/^\s*installDateSource\s*=/gm) || []).length;
  assert(sourceAssignments >= dateAssignments,
    `every installDate field has an installDateSource beside it (${dateAssignments} dates, ${sourceAssignments} sources)`);
  assert(/installDateSource\s*=\s*if\s*\(\$date\)\s*\{\s*'folder-created'/.test(scanner),
    "the Store-app path labels its folder-CreationTime date as inferred, not recorded");
  assert(/\$installDateSource\s*=\s*'key-name'/.test(scanner),
    'the uninstall-key-name fallback labels itself as inferred');

  // --- The table -----------------------------------------------------------
  console.log('');
  console.log('The application list marks inferred dates and only inferred ones');

  const cells = await win.webContents.executeJavaScript(`(() => {
    const out = {};
    document.querySelectorAll('#apps-tbody tr.app-row').forEach((tr) => {
      const name = tr.querySelector('.app-title-name');
      const td = tr.children[3]; // checkbox, name, type, date
      if (!name || !td) return;
      out[name.textContent.trim()] = {
        text: td.textContent.trim(),
        marked: !!td.querySelector('.inferred-mark'),
        title: td.getAttribute('title') || '',
      };
    });
    return out;
  })()`);

  assert(Object.keys(cells).length === FIXTURE.length,
    `all ${FIXTURE.length} fixture rows rendered (got ${Object.keys(cells).length})`);

  const recorded = cells['Recorded Program'] || {};
  const keyNamed = cells['Key Named Program'] || {};
  const store = cells['Store Program'] || {};
  const unsourced = cells['Unsourced Program'] || {};
  const dateless = cells['Dateless Program'] || {};

  assert(recorded.marked === false, 'a recorded date carries no approximation mark');
  assert(recorded.title === '', 'a recorded date needs no caveat in its tooltip');
  assert(keyNamed.marked === true, 'a date inferred from the uninstall key name IS marked');
  assert(store.marked === true, "a Store app's folder-creation date IS marked");
  assert(unsourced.marked === true,
    'a date arriving with NO source is treated as inferred, not silently promoted to recorded');
  assert(dateless.marked === false && /Unknown/.test(dateless.text || ''),
    'no date at all still reads "Unknown" and is not marked');

  assert(/uninstall entry/i.test(keyNamed.title),
    'the key-name tooltip says where the date actually came from');
  assert(/folder/i.test(store.title),
    'the Store-app tooltip says where the date actually came from');
  assert(!/unsafe|suspicious|wrong/i.test(keyNamed.title + store.title),
    'the caveat claims "approximate", never "suspect" - the dates are probably right');

  // --- The fallback must still happen --------------------------------------
  assert(/2023-11-02/.test(keyNamed.text || ''),
    'the inferred date is still SHOWN - a probable date beats "Unknown"');
  assert(/2025-06-07/.test(store.text || ''),
    "the Store app's inferred date is still shown");

  // --- The details pane ----------------------------------------------------
  console.log('');
  console.log('The details pane spells the caveat out');

  const detail = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#apps-tbody tr.app-row')];
    const target = rows.find((r) => r.querySelector('.app-title-name').textContent.trim() === 'Key Named Program');
    target.click();
    return new Promise((res) => setTimeout(() => {
      const el = document.getElementById('det-date');
      res({ text: el.textContent.trim(), title: el.title, cls: el.className });
    }, 400));
  })()`);

  assert(/approx\./i.test(detail.text),
    `the pane says "(approx.)" in words rather than only a mark (got "${detail.text}")`);
  assert(/2023-11-02/.test(detail.text), 'the pane still shows the date itself');
  assert(/inferred-value/.test(detail.cls), 'the pane styles the value as inferred');
  assert(/uninstall entry/i.test(detail.title), 'the pane names the source in its tooltip');

  const recordedDetail = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#apps-tbody tr.app-row')];
    const target = rows.find((r) => r.querySelector('.app-title-name').textContent.trim() === 'Recorded Program');
    target.click();
    return new Promise((res) => setTimeout(() => {
      const el = document.getElementById('det-date');
      res({ text: el.textContent.trim(), cls: el.className });
    }, 400));
  })()`);

  assert(!/approx/i.test(recordedDetail.text) && recordedDetail.text === '2024-03-04',
    'switching to a recorded date clears the caveat rather than leaving the previous one');
  assert(!/inferred-value/.test(recordedDetail.cls),
    'switching to a recorded date clears the inferred styling');

  // --- Sorting is untouched ------------------------------------------------
  console.log('');
  console.log('Sorting still works on the value, not the marker');

  // This list sorts from the #sort-selector dropdown, NOT by clicking a header
  // - only the Task Manager table has sortable headers. An earlier draft of
  // this test clicked the "Date" header, watched nothing happen, and read the
  // untouched name-ascending order as a sorting bug.
  async function sortedDatesFor(option) {
    const rows = await win.webContents.executeJavaScript(`(() => {
      const sel = document.getElementById('sort-selector');
      sel.value = ${JSON.stringify(option)};
      sel.dispatchEvent(new Event('change'));
      return new Promise((res) => setTimeout(() => {
        res([...document.querySelectorAll('#apps-tbody tr.app-row')]
          .map((r) => r.children[3].textContent.trim().replace('~', '').trim()));
      }, 400));
    })()`);
    return rows.filter((s) => /^\d{4}-/.test(s));
  }

  const asc = await sortedDatesFor('date-asc');
  assert(asc.length === 4 && JSON.stringify(asc) === JSON.stringify(asc.slice().sort()),
    `oldest-first sorts on the value regardless of provenance (${asc.join(', ')})`);

  const desc = await sortedDatesFor('date-desc');
  assert(desc.length === 4 && JSON.stringify(desc) === JSON.stringify(desc.slice().sort().reverse()),
    `newest-first sorts on the value regardless of provenance (${desc.join(', ')})`);

  assert(!asc.some((d) => d.includes('~')) && !desc.some((d) => d.includes('~')),
    'the approximation mark never leaks into the sorted value itself');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
