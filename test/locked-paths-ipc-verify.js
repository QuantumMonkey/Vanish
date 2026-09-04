// h55: the pruning that happens on READ, and the quick-pick that shows it.
//
//   npx electron test/locked-paths-ipc-verify.js
//
// test/locked-paths-verify.js covers what is recorded and how it is read back
// out of the operation log. This covers the two things that only exist once the
// main process and the page are involved:
//
//   1. A path that no longer exists is dropped, and the drop is COUNTED and
//      said out loud. That is the rule that stops this ageing into a list of
//      problems the operator already solved - and saying how many were left out
//      is the difference between pruning and quietly hiding.
//   2. With nothing to show, the box is hidden entirely. An empty "recent
//      problems" panel is an invitation to wonder what went wrong.
//
// It runs in either tier: reading the app's own log is not privileged.

const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';
require('../main.js');

const store = require('../lib/store');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function invoke(channel, payload) {
  const h = ipcMain._invokeHandlers.get(channel);
  if (!h) throw new Error(`no handler registered for ${channel}`);
  return h({ sender: null }, payload);
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Locked paths through the IPC and into the modal (h55)');
  console.log('====================================================');

  // ------------------------------------------------------------------
  console.log('');
  console.log('A path that is gone is dropped, and the drop is counted');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-h55-ipc-'));
  const live = path.join(work, 'still-here.dll');
  fs.writeFileSync(live, 'x');
  const gone = path.join(work, 'removed-some-other-way.dll');

  // main.js already called store.init on the real userData dir. Point it at a
  // throwaway one so this suite never reads or writes the operator's own log.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-h55-data-'));
  store.init(dataDir);

  const write = (ts, rows, sourceApp) => {
    fs.appendFileSync(store.oplogPath(), JSON.stringify({
      ts, action: 'quarantine', tier: 'full',
      items: { requested: rows.length, quarantined: 0, failed: rows.length, lockedPaths: rows },
      outcome: 'partial', meta: { sourceApp },
    }) + '\n', 'utf8');
  };
  write('2026-02-01T10:00:00Z', [{ path: gone, reason: 'in use' }], 'GoneApp');
  write('2026-02-02T10:00:00Z', [{ path: live, reason: 'being used by another process' }], 'LiveApp');

  // lr9d: a UNC path is exactly what this list fills up with - a network
  // install whose file was locked - and it is the reason the handler checks
  // SHAPE before it touches the filesystem. fs.existsSync on a dead share costs
  // 1,270 ms, measured, and this ran once per row up to fifty inside a
  // synchronous main-process handler.
  //
  // Asserted as a DROP rather than as a duration: a timing assertion on
  // somebody else's network is a flaky test wearing a performance badge, but
  // "this row never reaches the list" is the same rule and is deterministic.
  const B = String.fromCharCode(92);
  const uncPath = B + B + 'a-share-that-is-not-here' + B + 'apps' + B + 'thing.dll';
  write('2026-02-03T10:00:00Z', [{ path: uncPath, reason: 'in use' }], 'NetworkApp');
  // And a relative one, which would otherwise be probed against whatever the
  // main process's working directory happens to be.
  write('2026-02-04T10:00:00Z', [{ path: 'Program Files' + B + 'App' + B + 'x.dll', reason: 'in use' }], 'RelativeApp');

  const res = await invoke('get-locked-paths');
  assert(res && res.success === true, 'the handler answers', JSON.stringify(res));
  assert(res.items.length === 1, `only the path that still exists comes back (${res.items.length})`,
    JSON.stringify(res.items.map((i) => i.path)));
  assert(res.items[0] && res.items[0].path === live, 'and it is the right one');
  assert(res.dropped === 3,
    `the gone one, the UNC one and the relative one are all COUNTED as dropped, not silently swallowed (${res.dropped})`);

  const paths = res.items.map((i) => i.path);
  assert(!paths.some((p) => p.startsWith(B + B)),
    'no UNC path survives - it is refused by shape, before anything touches the network',
    JSON.stringify(paths));
  assert(!paths.some((p) => /^Program Files/.test(p)),
    'and neither does a relative one, which would have been probed against the process working directory',
    JSON.stringify(paths));

  // THE ASSERTION THAT DISTINGUISHES SHAPE-FIRST FROM PROBE-FIRST, and it
  // needed thinking about: the two paths above are dropped either way, because
  // existsSync returns false for a dead share and for a relative path too. The
  // only difference is the 1,270 ms - and a duration assertion on somebody
  // else's network is a flaky test wearing a performance badge.
  //
  // A UNC path that RESOLVES separates them deterministically. Shape-first
  // drops it; probe-first finds it and keeps it. The admin share is on every
  // Windows machine and needs elevation to read, so this states its premise
  // rather than passing vacuously when it cannot run.
  const liveUnc = B + B + 'localhost' + B + 'C$' + B + 'Windows';
  if (!fs.existsSync(liveUnc)) {
    console.log(`  SKIP  the live-UNC case: ${liveUnc} is not reachable from this session (needs elevation)`);
  } else {
    const uncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-h55-unc-'));
    store.init(uncDir);
    fs.appendFileSync(store.oplogPath(), JSON.stringify({
      ts: '2026-02-05T10:00:00Z', action: 'quarantine', tier: 'full',
      items: { requested: 1, quarantined: 0, failed: 1, lockedPaths: [{ path: liveUnc, reason: 'in use' }] },
      outcome: 'partial', meta: { sourceApp: 'NetApp' },
    }) + '\n', 'utf8');

    const uncRes = await invoke('get-locked-paths');
    assert(uncRes.items.length === 0,
      'a UNC path that DOES resolve is still dropped - refused by shape, never probed',
      JSON.stringify(uncRes.items.map((i) => i.path)));
    assert(uncRes.dropped === 1, 'and counted as dropped');
    try { fs.rmSync(uncDir, { recursive: true, force: true }); } catch { /* best effort */ }
    store.init(dataDir);
  }
  assert(res.items[0] && res.items[0].sourceApp === 'LiveApp' && res.items[0].at,
    'the row keeps what tried to remove it and when', JSON.stringify(res.items[0]));

  // ------------------------------------------------------------------
  console.log('');
  console.log('With nothing recorded, the answer is an empty list rather than an error');

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-h55-empty-'));
  store.init(emptyDir);
  const none = await invoke('get-locked-paths');
  assert(none && none.success === true && none.items.length === 0 && none.dropped === 0,
    'a machine that has never had a locked failure gets a clean empty answer',
    JSON.stringify(none));

  // ------------------------------------------------------------------
  console.log('');
  console.log('What the modal does with each of those');

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);
  const run = (js) => win.webContents.executeJavaScript(js);

  async function openWith(payload) {
    return run(`(() => {
      try {
        window.__test.queueResponse('getLockedPaths', ${JSON.stringify(payload)});
        document.getElementById('btn-open-unlocker').click();
        return true;
      } catch (e) { return String(e); }
    })()`);
  }

  const ok1 = await openWith({ success: true, items: [], dropped: 0 });
  assert(ok1 === true, 'premise: the Unlocker opens', String(ok1));
  await wait(600);

  const empty = await run(`(() => {
    const b = document.getElementById('unlock-known');
    return { present: Boolean(b), shown: b ? b.style.display !== 'none' : false, text: b ? b.textContent.trim() : '' };
  })()`);
  assert(empty.present === true, 'the quick-pick box exists');
  assert(empty.shown === false, 'and is hidden entirely when there is nothing to pick');
  assert(empty.text === '', 'holding no text at all, so it cannot read as "we found nothing wrong"');

  await run(`(() => { document.getElementById('unlock-close-x').click(); return true; })()`);
  await wait(200);

  await openWith({
    success: true,
    dropped: 2,
    items: [
      { path: 'C:\\Program Files\\App\\held.dll', reason: 'being used by another process', at: '2026-02-02T10:00:00Z', sourceApp: 'SomeApp' },
      { path: 'C:\\Program Files\\App\\other.dll', reason: 'in use', at: '2026-02-01T10:00:00Z', sourceApp: null },
    ],
  });
  await wait(600);

  const shown = await run(`(() => {
    const b = document.getElementById('unlock-known');
    const rows = Array.from(b.querySelectorAll('.unlock-known-row'));
    return {
      shown: b.style.display !== 'none',
      rowCount: rows.length,
      firstText: rows[0] ? rows[0].textContent.replace(/\\s+/g, ' ').trim() : '',
      note: (b.querySelector('.unlock-known-note') || {}).textContent || '',
      anchors: b.querySelectorAll('a').length,
    };
  })()`);

  assert(shown.shown === true, 'it appears when there is something to pick');
  assert(shown.rowCount === 2, `one row per path (${shown.rowCount})`);
  assert(/held\.dll/.test(shown.firstText), 'the path is shown', shown.firstText);
  assert(/SomeApp/.test(shown.firstText), 'so is what tried to remove it', shown.firstText);
  assert(/another process/.test(shown.firstText), 'and the reason Windows gave', shown.firstText);
  assert(/2026/.test(shown.firstText), 'and when it happened', shown.firstText);
  assert(/2 more/.test(shown.note) && /no longer on this PC/.test(shown.note),
    'the paths that were pruned are named as pruned, not hidden', shown.note);
  assert(shown.anchors === 0, 'nothing in here navigates out of the app');

  // ------------------------------------------------------------------
  console.log('');
  console.log('Picking one asks the question the list cannot answer');

  const picked = await run(`(() => {
    window.__test.resetCallCounts();
    window.__test.queueResponse('listLockers', { success: true, holders: [] });
    document.querySelector('.unlock-known-row').click();
    return {
      input: document.getElementById('unlock-path-input').value,
      askedWith: window.__test.callArgs('listLockers'),
    };
  })()`);
  assert(picked.input === 'C:\\Program Files\\App\\held.dll',
    'clicking a row fills the path in', picked.input);
  assert(picked.askedWith.length === 1,
    `and immediately asks what is holding it (${picked.askedWith.length} calls)`);
  assert(picked.askedWith[0] && picked.askedWith[0][0] && picked.askedWith[0][0].path === 'C:\\Program Files\\App\\held.dll',
    'about that path', JSON.stringify(picked.askedWith));

  for (const d of [work, dataDir, emptyDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
