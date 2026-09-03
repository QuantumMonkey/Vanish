// mp31, renderer half: what the table does with a size it had to measure.
//
//   npx electron test/install-size-render-verify.js
//
// test/install-size-verify.js covers the measurement. This covers the part the
// user sees, and the three things that must stay true of it:
//
//   1. Only rows with no size AND an install folder ask at all. Asking about a
//      row that already has a size is pure disk work for no change on screen,
//      and asking about one with nowhere to look cannot answer.
//   2. An answer that could not be completed leaves the cell saying Unknown.
//      mp31's own wording: a 10-second list is a worse product than a list with
//      27 Unknowns in it, and a spinner that never resolves is worse than both.
//   3. A measured size SAYS it was measured. Not because it is worse than a
//      recorded one - it is better, EstimatedSize is frequently stale or
//      absent - but because a sortable column that silently mixes what the
//      installer claimed with what Vanish walked is the defect c0y fixed for
//      dates, and the same reasoning applies unchanged.

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

const FIXTURE = [
  {
    id: 'sized', name: 'Program With A Size', publisher: 'Acme', version: '1.0',
    installDate: '2024-03-04', installDateSource: 'recorded',
    sizeBytes: 1048576, installLocation: 'C:\\sized', registryPath: 'HKLM:\\sized',
    type: 'Desktop', classification: 'application',
  },
  {
    id: 'measurable', name: 'Program Without A Size', publisher: 'Acme', version: '1.0',
    installDate: '2024-03-04', installDateSource: 'recorded',
    sizeBytes: 0, installLocation: 'C:\\measurable', registryPath: 'HKLM:\\measurable',
    type: 'Desktop', classification: 'application',
  },
  {
    id: 'nowhere', name: 'Program With Nowhere To Look', publisher: 'Acme', version: '1.0',
    installDate: '2024-03-04', installDateSource: 'recorded',
    sizeBytes: 0, installLocation: '', registryPath: 'HKLM:\\nowhere',
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
  console.log('Install size in the table (mp31)');
  console.log('===============================');

  // ------------------------------------------------------------------
  console.log('');
  console.log('Which rows ask, and which do not');

  // THE OBSERVER CANNOT BE DRIVEN HERE, so the fallback is driven instead.
  // An offscreen BrowserWindow lays the table out but never reports a row as
  // intersecting the viewport, so IntersectionObserver's callback never fires
  // and every assertion below would read "nothing happened" and pass for the
  // wrong reason - the first run of this suite did exactly that. Removing the
  // constructor makes observeAppSizes take its documented no-IntersectionObserver
  // path, which asks directly and bounded. That is the path a headless context
  // takes in production too, so it is worth having under test rather than
  // being the branch nothing ever runs.
  //
  // appSizeObserver is reset with it because the module caches the observer
  // after its first render, and a cached one would still be used no matter
  // what the constructor now is.
  const asked = await win.webContents.executeJavaScript(`(() => {
    window.IntersectionObserver = undefined;
    appSizeObserver = null;
    window.__test.resetCallCounts();
    window.__test.queueResponse('getDesktopApps', ${JSON.stringify(FIXTURE)});
    loadApplications();
    return true;
  })()`);
  assert(asked === true, 'premise: the fixture loaded');
  await wait(1500);

  const firstAsk = await win.webContents.executeJavaScript(
    `(() => ({ calls: window.__test.callCount('measureInstallSize'), args: window.__test.callArgs('measureInstallSize') }))()`
  );
  assert(firstAsk.calls === 1,
    `exactly one of the three rows asked to be measured (${firstAsk.calls})`);
  assert(firstAsk.calls === 1 && firstAsk.args[0] && firstAsk.args[0][0] === 'C:\\measurable',
    'and it asked about the install folder of the row with no size',
    JSON.stringify(firstAsk.args));

  const cells = await win.webContents.executeJavaScript(`(() => {
    const out = [];
    document.querySelectorAll('#apps-tbody tr').forEach((tr) => {
      const name = tr.querySelector('.app-title-name');
      const size = tr.querySelector('.app-size-cell');
      out.push({
        name: name ? name.textContent : '',
        text: size ? size.textContent.trim() : '(no cell)',
        source: size ? (size.dataset.sizeSource || '') : '',
      });
    });
    return out;
  })()`);

  const byName = (n) => cells.find((c) => c.name === n) || {};
  assert(cells.length === 3, `premise: three rows rendered (${cells.length})`);
  assert(byName('Program With A Size').source === '',
    'a row that already has a size carries no measurement source, so it is never asked about');
  assert(byName('Program With Nowhere To Look').source === '',
    'and neither does one with no install folder to walk');
  assert(byName('Program Without A Size').source === 'C:\\measurable',
    'only the row with no size AND a folder carries one',
    JSON.stringify(byName('Program Without A Size')));

  // ------------------------------------------------------------------
  console.log('');
  console.log('An incomplete answer leaves Unknown alone');
  // The stub's DEFAULT answer is the refusal, so this is what just happened.

  assert(byName('Program Without A Size').text.startsWith('Unknown'),
    'a measurement that could not be completed leaves the cell reading Unknown',
    JSON.stringify(byName('Program Without A Size')));
  assert(!cells.some((c) => c.text === '0 Bytes'),
    'and no cell shows a zero, which is what a partial total would have rendered as');

  // THE CASE ABOVE CANNOT DISTINGUISH THE RULE, and mutation testing said so:
  // the stub's default refusal carries bytes:null, so a renderer that checked
  // only "is there a number" would pass it too. The dangerous answer is a
  // PARTIAL one - a real byte count with complete:false, which is what the
  // budget produces on a folder like Office. Rendering that would put a
  // confident, sortable, WRONG number in front of the user.
  await win.webContents.executeJavaScript(`(() => {
    window.IntersectionObserver = undefined;
    appSizeObserver = null;
    window.__test.resetCallCounts();
    window.__test.queueResponse('getDesktopApps', ${JSON.stringify(FIXTURE)});
    window.__test.queueResponse('measureInstallSize', { success: true, bytes: 4194304, complete: false });
    loadApplications();
    return true;
  })()`);
  await wait(1500);

  const partial = await win.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('#apps-tbody tr')).map((tr) => ({
      name: (tr.querySelector('.app-title-name') || {}).textContent,
      text: ((tr.querySelector('.app-size-cell') || {}).textContent || '').trim(),
    }));
    const app = (typeof allApps !== 'undefined' ? allApps : []).find((a) => a.id === 'measurable') || {};
    return { row: rows.find((r) => r.name === 'Program Without A Size') || {}, modelBytes: app.sizeBytes || 0 };
  })()`);

  assert(partial.row.text === 'Unknown',
    `a PARTIAL total - a real number with complete:false - is refused too (${partial.row.text})`);
  assert(partial.modelBytes === 0,
    `and it never reaches the model, so no sort or total can pick it up (${partial.modelBytes})`);

  // ------------------------------------------------------------------
  console.log('');
  console.log('A completed answer lands, and says it was measured');

  await win.webContents.executeJavaScript(`(() => {
    window.__test.resetCallCounts();
    window.__test.queueResponse('getDesktopApps', ${JSON.stringify(FIXTURE)});
    window.__test.queueResponse('measureInstallSize', { success: true, bytes: 5242880, complete: true });
    loadApplications();
    return true;
  })()`);
  await wait(1500);

  const after = await win.webContents.executeJavaScript(`(() => {
    const rows = [];
    document.querySelectorAll('#apps-tbody tr').forEach((tr) => {
      const name = tr.querySelector('.app-title-name');
      const size = tr.querySelector('.app-size-cell');
      rows.push({
        name: name ? name.textContent : '',
        text: size ? size.textContent.trim() : '',
        title: size ? (size.title || '') : '',
        marks: size ? size.querySelectorAll('.inferred-mark').length : 0,
      });
    });
    const app = (typeof allApps !== 'undefined' ? allApps : []).find((a) => a.id === 'measurable') || {};
    return { rows, modelBytes: app.sizeBytes || 0, modelSource: app.sizeSource || '' };
  })()`);

  const measured = after.rows.find((r) => r.name === 'Program Without A Size') || {};
  assert(/^5 MB/.test(measured.text),
    `the measured size replaces Unknown in the cell (${measured.text})`);
  assert(measured.marks === 1,
    'and carries a mark distinguishing it from a size the installer recorded');
  assert(/[Mm]easured/.test(measured.title),
    `with a tooltip that says in words where the number came from ("${measured.title}")`);

  const recorded = after.rows.find((r) => r.name === 'Program With A Size') || {};
  assert(recorded.marks === 0 && recorded.title === '',
    'a recorded size is left completely alone - no mark, no tooltip');

  // ------------------------------------------------------------------
  console.log('');
  console.log('The measurement survives a re-render, so a sort does not re-walk the disk');

  assert(after.modelBytes === 5242880 && after.modelSource === 'measured',
    `the answer is written back to the model, not only to the cell (${after.modelBytes}, ${after.modelSource})`);

  const afterSort = await win.webContents.executeJavaScript(`(() => {
    window.__test.resetCallCounts();
    filterAndRenderApps();
    const cell = Array.from(document.querySelectorAll('#apps-tbody tr'))
      .map((tr) => ({
        name: (tr.querySelector('.app-title-name') || {}).textContent,
        text: (tr.querySelector('.app-size-cell') || {}).textContent,
        source: (tr.querySelector('.app-size-cell') || { dataset: {} }).dataset.sizeSource || '',
      }))
      .find((r) => r.name === 'Program Without A Size') || {};
    return { cell, calls: window.__test.callCount('measureInstallSize') };
  })()`);

  assert(/^5 MB/.test((afterSort.cell.text || '').trim()),
    `a re-render still shows the measured size (${(afterSort.cell.text || '').trim()})`);
  assert(afterSort.cell.source === '',
    'and the cell no longer advertises itself as measurable, so it is not asked again');
  assert(afterSort.calls === 0,
    `re-rendering asks the engine nothing (${afterSort.calls} calls)`);

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
