// Column filter regression suite (bd vanish-uninstaller-5b0).
//
// The operator asked for one thing - "click a column header, get a checklist of
// the values that are there, choose which to show" - and the reason this suite
// is longer than that sentence is that a filter is a machine for hiding rows,
// in an app whose entire pitch is that it does not hide things from you.
//
// So it does not test a popover. It tests the FIVE WAYS A COLUMN FILTER LIES,
// against every table that has one:
//
//   1. IT UNDER-REPORTS A MULTI-VALUED ROW. A process carrying two indicators
//      must survive hiding either one alone. Treating Indicators as equality
//      would drop it, silently, and a Task Manager that omits the process
//      carrying two warnings is worse than one with no filter at all.
//   2. IT HIDES SOMETHING NEW. State is the set of EXCLUDED values, so a value
//      that appears in the data after the filter was set shows up. Under
//      "selected value" semantics a newly started process would be withheld by
//      a filter that has never heard of it.
//   3. ITS OWN CHECKLIST SHRINKS. Uncheck "Desktop" and Desktop must still be
//      listed, or the only control that could bring it back has vanished.
//   4. IT OFFERS WORDS THAT ARE NOT ON SCREEN. The Type column reads "Windows
//      App"; app.type says "UWP". The checklist must say what the cells say.
//   5. IT DOES NOT ADMIT ITSELF. Every hidden row must be accounted for in a
//      caption that NAMES the column, in a chip, and in an empty state that
//      says which filter emptied the table - the 2026-08-05 silent-search bug,
//      which this table has now had three chances to repeat.
//
// Plus the two structural traps this app has hit before: a control buried under
// the sticky headers h0i added (hit-tested, not assumed), and filter state
// leaking into settings so it comes back on next launch without being asked
// for.
//
//   npx electron test/column-filter-verify.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); fail += 1; }
}

// Same technique as the other DOM suites: is the element the topmost thing at
// its own centre? "Present and sized" is what the measurements said last time
// while a column sat clipped behind a panel.
const HIT_TEST = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { found: true, visible: false };
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const top = document.elementFromPoint(cx, cy);
  return {
    found: true, visible: true,
    hit: el === top || el.contains(top) || (top && top.contains(el)),
    blockedBy: (top ? top.tagName + '#' + (top.id || '') : 'nothing')
  };
}`;

// Four Desktop programs from two publishers, two Windows apps from a third, and
// one Windows feature - so Type has three distinct values and Publisher has
// three, with different counts.
const APPS = [
  { id: 'a1', name: 'Alpha Tool', publisher: 'Acme Ltd', version: '1', installDate: '2026-01-01',
    sizeBytes: 1024, registryPath: 'HKLM:\\Software\\A1', type: 'Desktop', classification: 'application' },
  { id: 'a2', name: 'Beta Tool', publisher: 'Acme Ltd', version: '1', installDate: '2026-01-02',
    sizeBytes: 2048, registryPath: 'HKLM:\\Software\\A2', type: 'Desktop', classification: 'application' },
  { id: 'a3', name: 'Gamma Tool', publisher: 'Globex', version: '1', installDate: '2026-01-03',
    sizeBytes: 3072, registryPath: 'HKLM:\\Software\\A3', type: 'Desktop', classification: 'application' },
  { id: 'a4', name: 'Delta Tool', publisher: 'Globex', version: '1', installDate: '2026-01-04',
    sizeBytes: 4096, registryPath: 'HKLM:\\Software\\A4', type: 'Desktop', classification: 'application' },
  { id: 'a5', name: 'Epsilon App', publisher: 'Contoso', version: '1', installDate: '2026-01-05',
    sizeBytes: 5120, registryPath: '', type: 'UWP', classification: 'application' },
  { id: 'a6', name: 'Zeta App', publisher: 'Contoso', version: '1', installDate: '2026-01-06',
    sizeBytes: 6144, registryPath: '', type: 'UWP', classification: 'application' },
];

const FEATURES = [
  { id: 'f1', name: 'Windows Feature X', publisher: 'Microsoft Corporation', version: '',
    installDate: '', sizeBytes: 0, type: 'Feature', classification: 'feature' },
];

// p4 is the whole reason trap 1 is testable: two indicators on one row.
const PROCESSES = [
  { pid: 101, name: 'chrome.exe', cpuPercent: 3.5, memoryBytes: 1048576, ioBytesPerSec: 0,
    parentPid: 1, parentName: 'explorer.exe', commandLine: '', imagePath: 'C:\\chrome.exe',
    startedAt: '2026-01-01 00:00:00', indicators: [] },
  { pid: 102, name: 'chrome.exe', cpuPercent: 1.5, memoryBytes: 2097152, ioBytesPerSec: 0,
    parentPid: 101, parentName: 'chrome.exe', commandLine: '', imagePath: 'C:\\chrome.exe',
    startedAt: '2026-01-01 00:00:00', indicators: [] },
  { pid: 103, name: 'script-only.exe', cpuPercent: 0.5, memoryBytes: 4096, ioBytesPerSec: 0,
    parentPid: 9, parentName: 'powershell.exe', commandLine: '', imagePath: 'C:\\s.exe',
    startedAt: '2026-01-01 00:00:00',
    indicators: [{ kind: 'suspicious-parent', title: 'Started by a script', evidence: 'powershell.exe', note: 'n' }] },
  { pid: 104, name: 'both.exe', cpuPercent: 0.2, memoryBytes: 8192, ioBytesPerSec: 0,
    parentPid: 9, parentName: 'powershell.exe', commandLine: '', imagePath: 'C:\\b.exe',
    startedAt: '2026-01-01 00:00:00',
    indicators: [
      { kind: 'suspicious-parent', title: 'Started by a script', evidence: 'powershell.exe', note: 'n' },
      { kind: 'persistence', title: 'Starts with Windows', evidence: 'Run key', note: 'n' },
    ] },
  { pid: 105, name: 'autostart.exe', cpuPercent: 0.1, memoryBytes: 16384, ioBytesPerSec: 0,
    parentPid: 1, parentName: 'services.exe', commandLine: '', imagePath: 'C:\\a.exe',
    startedAt: '2026-01-01 00:00:00',
    indicators: [{ kind: 'persistence', title: 'Starts with Windows', evidence: 'Run key', note: 'n' }] },
];

// Index 2 is the only Task row: filtering to it proves the action handlers stay
// keyed on the index into the FULL list rather than to a renumbered position.
const STARTUP = {
  items: [
    { name: 'RegActive', command: 'C:\\a.exe', exePath: 'C:\\a.exe', exeExists: true,
      source: 'Registry', sourceDetail: 'HKLM', enabled: true, managePath: 'HKLM:\\Run\\RegActive',
      action: 'registry-remove', actionLabel: 'Remove from startup', group: 'actionable',
      classification: 'no-opinion', groupReason: 'Vanish has no opinion about this one.' },
    { name: 'RegBroken', command: 'C:\\gone.exe', exePath: 'C:\\gone.exe', exeExists: false,
      source: 'Registry', sourceDetail: 'HKCU', enabled: true, managePath: 'HKCU:\\Run\\RegBroken',
      action: 'registry-remove', actionLabel: 'Remove from startup', suggestion: 'Remove it here.',
      group: 'actionable', classification: 'orphaned', groupReason: 'Points at nothing.' },
    { name: 'TaskInactive', command: 'C:\\t.exe', exePath: 'C:\\t.exe', exeExists: true,
      source: 'TaskScheduler', sourceDetail: '\\Vanish\\T', enabled: false, managePath: '\\Vanish\\T',
      action: 'task-disable', group: 'actionable', classification: 'no-opinion',
      groupReason: 'Vanish has no opinion about this one.' },
    { name: 'SvcActive', command: 'C:\\s.exe', exePath: 'C:\\s.exe', exeExists: true,
      source: 'Service', sourceDetail: 'svc', enabled: true, managePath: 'svc',
      action: 'service-manual', actionLabel: 'Start only when needed', group: 'actionable',
      classification: 'no-opinion', groupReason: 'Vanish has no opinion about this one.' },
    { name: 'SecurityHealth', command: 'C:\\Windows\\x.exe', exePath: 'C:\\Windows\\x.exe', exeExists: true,
      source: 'Registry', sourceDetail: 'HKLM', enabled: true, managePath: 'HKLM:\\Run\\SecurityHealth',
      group: 'necessary', classification: 'system', signer: 'Microsoft Windows',
      groupReason: 'Windows itself put this here.' },
  ],
  total: 5, orphans: 1, detectionOnly: false,
  detectionNote: 'Every change here is reversible.',
};

async function run(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function hitTest(win, selector) {
  return run(win, `(${HIT_TEST})(${JSON.stringify(selector)})`);
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);

  console.log('');
  console.log('Vanish column filter verification (5b0)');
  console.log('=======================================');

  // ==========================================================================
  // Where the funnels are, and where they deliberately are not
  // ==========================================================================
  console.log('');
  console.log('Which columns are filterable');

  const funnels = await run(win, `(() => {
    const map = {};
    document.querySelectorAll('.column-filter-btn').forEach((b) => {
      const th = b.closest('th');
      map[b.getAttribute('data-filter-key')] = (th ? th.textContent.trim() : '');
    });
    const procHeaders = [...document.querySelectorAll('.process-table thead th')].map((th) => ({
      text: th.textContent.trim(),
      funnel: !!th.querySelector('.column-filter-btn')
    }));
    return { keys: Object.keys(map).sort(), map, procHeaders };
  })()`);

  assert(
    funnels.keys.join(',') === 'apps.publisher,apps.type,process.indicators,process.name',
    'the two static tables register exactly four column filters at startup'
  );
  assert(
    /Type/.test(funnels.map['apps.type']) && /Name/.test(funnels.map['apps.publisher']),
    'Type hangs off the Type header and Publisher off the Name header it is rendered in'
  );
  const numericHeaders = funnels.procHeaders.filter(
    (h) => /^(CPU|GPU|Memory|Disk I\/O|PID)$/.test(h.text) && h.funnel
  );
  assert(
    numericHeaders.length === 0,
    'CPU, GPU, Memory, Disk I/O and PID carry NO funnel - a checklist of continuous values is meaningless and would misrepresent what the control does'
  );
  assert(
    funnels.procHeaders.some((h) => h.text === 'Indicators' && h.funnel),
    'Indicators - the explicit ask - carries one'
  );

  // ==========================================================================
  // All Programs: Type and Publisher
  // ==========================================================================
  console.log('');
  console.log('All Programs: Type and Publisher');

  await run(win, `
    document.querySelector('.nav-item[data-tab="all-apps"]').click();
    allApps = ${JSON.stringify(APPS)};
    windowsFeatures = ${JSON.stringify(FEATURES)};
    featuresLoaded = true;
    showFeatures = true;
    filterText = '';
    filterType = 'all';
    document.getElementById('search-bar').value = '';
    filterAndRenderApps();
    true;
  `);
  await wait(300);

  const seeded = await run(win, `(() => ({
    rows: document.querySelectorAll('#apps-tbody .app-row').length,
    caption: document.getElementById('filter-status-text').textContent,
    chipsHidden: document.getElementById('apps-filter-chips').style.display === 'none'
  }))()`);
  assert(seeded.rows === 7, 'the seven scripted rows rendered (six programs plus one Windows feature)');
  assert(/Showing all 7/.test(seeded.caption), 'an unfiltered table says so');
  assert(seeded.chipsHidden, 'and shows no chips at all while nothing is filtered');

  await hitTest(win, '.column-filter-btn[data-filter-key="apps.type"]').then((r) =>
    assert(r.found && r.visible && r.hit,
      `the Type funnel is clickable, not buried under the sticky header (blocked by ${r.blockedBy})`)
  );

  const opened = await run(win, `(() => {
    document.querySelector('.column-filter-btn[data-filter-key="apps.type"]').click();
    const pop = document.getElementById('column-filter-pop');
    const r = pop.getBoundingClientRect();
    return {
      shown: pop.style.display === 'flex',
      values: [...pop.querySelectorAll('.column-filter-option')].map((l) => l.getAttribute('data-value')),
      counts: [...pop.querySelectorAll('.column-filter-count')].map((c) => c.textContent),
      hasSearch: !!pop.querySelector('.column-filter-search'),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      zIndex: getComputedStyle(pop).zIndex
    };
  })()`);
  assert(opened.shown, 'clicking the funnel opens the popover');
  assert(
    opened.values.join(',') === 'Desktop,Feature,Windows App',
    'it lists the DISPLAYED values - "Windows App", never the raw "UWP" behind it (trap 4)'
  );
  assert(opened.counts.join(',') === '4,1,2', 'each value carries its own count from the current data');
  assert(!opened.hasSearch, 'three values need no search box');
  assert(opened.inViewport, 'the popover opens inside the window rather than off the edge of it');
  assert(Number(opened.zIndex) > 2, 'and above the sticky headers it hangs from');

  const afterHideDesktop = await run(win, `(() => {
    const pop = document.getElementById('column-filter-pop');
    const opt = [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Desktop');
    opt.querySelector('input').click();
    return {
      rows: document.querySelectorAll('#apps-tbody .app-row').length,
      names: [...document.querySelectorAll('#apps-tbody .app-title-name')].map((n) => n.textContent),
      caption: document.getElementById('filter-status-text').textContent,
      chips: [...document.querySelectorAll('#apps-filter-chips .column-filter-chip')].map((c) => c.textContent.trim()),
      clearShown: document.getElementById('btn-clear-filters').style.display !== 'none',
      funnelActive: document.querySelector('.column-filter-btn[data-filter-key="apps.type"]').classList.contains('is-active'),
      stillListsDesktop: [...pop.querySelectorAll('.column-filter-option')]
        .some((l) => l.getAttribute('data-value') === 'Desktop')
    };
  })()`);
  assert(afterHideDesktop.rows === 3, 'unchecking Desktop hides exactly the four Desktop rows');
  assert(
    afterHideDesktop.names.join(',') === 'Epsilon App,Windows Feature X,Zeta App',
    'and leaves the two Windows apps and the feature, in the sort the table was already using'
  );
  assert(
    /Showing 3 of 7 programs.*filtered by Type/.test(afterHideDesktop.caption),
    'the caption states the count AND names the column doing the hiding (trap 5)'
  );
  assert(afterHideDesktop.chips.length === 1 && /Type: 2 of 3/.test(afterHideDesktop.chips[0]),
    'one chip appears, saying how many of the column values are still shown');
  assert(afterHideDesktop.clearShown, 'the Clear action appears, as it does for a search filter');
  assert(afterHideDesktop.funnelActive, 'the funnel itself marks the column as filtered');
  assert(afterHideDesktop.stillListsDesktop,
    'Desktop is STILL in the checklist after being hidden - an option list that shrinks is a trap with no way out (trap 3)');

  // A value that turns up after the filter was set must not be swallowed by it.
  // Type can only ever hold three values, so the honest test of this is a column
  // with a real long tail: hide one publisher, then have a program arrive from a
  // publisher the filter has never heard of.
  const afterNewValue = await run(win, `(() => {
    document.querySelector('.column-filter-btn[data-filter-key="apps.publisher"]').click();
    const pop = document.getElementById('column-filter-pop');
    [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Acme Ltd')
      .querySelector('input').click();
    const rowsWithBoth = document.querySelectorAll('#apps-tbody .app-row').length;
    const captionWithBoth = document.getElementById('filter-status-text').textContent;
    allApps = allApps.concat([{ id: 'a7', name: 'Omega App', publisher: 'Newco',
      version: '1', installDate: '2026-02-01', sizeBytes: 512, registryPath: '',
      type: 'UWP', classification: 'application' }]);
    filterAndRenderApps();
    return {
      rowsWithBoth, captionWithBoth,
      names: [...document.querySelectorAll('#apps-tbody .app-title-name')].map((n) => n.textContent),
      caption: document.getElementById('filter-status-text').textContent,
      chips: [...document.querySelectorAll('#apps-filter-chips .column-filter-chip')].map((c) => c.textContent.trim())
    };
  })()`);
  assert(afterNewValue.rowsWithBoth === 3,
    'a second column filter ANDs with the first - both Acme programs were Desktop and already hidden, so the row count does not move');
  assert(/filtered by Publisher, Type/.test(afterNewValue.captionWithBoth),
    'and the caption names both columns, not just the most recent one');
  assert(
    afterNewValue.names.includes('Omega App'),
    'a program from a publisher that did not exist when the Publisher filter was set still shows up (trap 2 - excluded-set semantics, not selected-set)'
  );
  assert(/Showing 4 of 8/.test(afterNewValue.caption), 'and the caption counts it');
  assert(afterNewValue.chips.length === 2, 'two active column filters produce two chips');

  // Search AND column filter, both named.
  const bothFilters = await run(win, `(() => {
    const bar = document.getElementById('search-bar');
    bar.value = 'Epsilon';
    bar.dispatchEvent(new Event('input'));
    return {
      rows: document.querySelectorAll('#apps-tbody .app-row').length,
      caption: document.getElementById('filter-status-text').textContent
    };
  })()`);
  assert(bothFilters.rows === 1, 'a search and a column filter AND together rather than one overriding the other');
  assert(/Showing 1 of 8 programs.*filtered by Publisher, Type/.test(bothFilters.caption),
    'and the caption still names the column filters while a search is also active');

  // The empty state has to say which filter emptied the table.
  const emptied = await run(win, `(() => {
    const bar = document.getElementById('search-bar');
    bar.value = 'no-such-program';
    bar.dispatchEvent(new Event('input'));
    const body = document.getElementById('apps-tbody');
    return {
      text: body.textContent.trim(),
      hasClear: !!document.getElementById('btn-empty-clear-filters')
    };
  })()`);
  assert(/No programs match your search and the Publisher, Type filter/.test(emptied.text),
    'an empty table names BOTH reasons it is empty, not just the search');
  assert(emptied.hasClear, 'and offers a way out of them from the empty state itself');

  const afterEmptyClear = await run(win, `(() => {
    document.getElementById('btn-empty-clear-filters').click();
    return {
      rows: document.querySelectorAll('#apps-tbody .app-row').length,
      caption: document.getElementById('filter-status-text').textContent,
      chipsHidden: document.getElementById('apps-filter-chips').style.display === 'none',
      funnelActive: document.querySelector('.column-filter-btn[data-filter-key="apps.type"]').classList.contains('is-active'),
      search: document.getElementById('search-bar').value
    };
  })()`);
  assert(afterEmptyClear.rows === 8, 'Clear filters restores every row');
  assert(afterEmptyClear.search === '', 'it clears the search box');
  assert(!afterEmptyClear.funnelActive && afterEmptyClear.chipsHidden,
    'and the column filters with it - a Clear that left a funnel set would be the same bug in a new place');
  assert(/Showing all 8/.test(afterEmptyClear.caption), 'the caption goes back to saying nothing is hidden');

  // The chip is the other way out. Back to the seven-row fixture first, so the
  // proportion the chip states is a fixed number rather than one that drifts
  // with whatever the previous assertion added.
  await run(win, `allApps = ${JSON.stringify(APPS)}; filterAndRenderApps(); true;`);

  const chipCleared = await run(win, `(() => {
    document.querySelector('.column-filter-btn[data-filter-key="apps.publisher"]').click();
    const pop = document.getElementById('column-filter-pop');
    const acme = [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Acme Ltd');
    acme.querySelector('input').click();
    const filteredRows = document.querySelectorAll('#apps-tbody .app-row').length;
    const chip = document.querySelector('#apps-filter-chips .column-filter-chip');
    const chipText = chip ? chip.textContent.trim() : '';
    chip.click();
    return {
      filteredRows,
      chipText,
      restored: document.querySelectorAll('#apps-tbody .app-row').length,
      chipsHidden: document.getElementById('apps-filter-chips').style.display === 'none'
    };
  })()`);
  assert(chipCleared.filteredRows === 5, 'hiding one publisher hides its two programs');
  assert(/Publisher: 3 of 4/.test(chipCleared.chipText), 'the chip names the column and the proportion still shown');
  assert(chipCleared.restored === 7 && chipCleared.chipsHidden, 'clicking the chip clears that column and takes the chip with it');

  // Publisher is the long-tail column the search box exists for.
  const longTail = await run(win, `(() => {
    const many = [];
    for (let i = 0; i < 14; i += 1) {
      many.push({ id: 'p' + i, name: 'Program ' + i, publisher: 'Publisher ' + i, version: '1',
        installDate: '2026-01-01', sizeBytes: 1024, registryPath: '', type: 'Desktop',
        classification: 'application' });
    }
    allApps = many;
    windowsFeatures = [];
    showFeatures = false;
    filterAndRenderApps();
    document.querySelector('.column-filter-btn[data-filter-key="apps.publisher"]').click();
    const pop = document.getElementById('column-filter-pop');
    const search = pop.querySelector('.column-filter-search');
    const before = pop.querySelectorAll('.column-filter-option').length;
    search.value = 'Publisher 1';
    search.dispatchEvent(new Event('input'));
    const visible = [...pop.querySelectorAll('.column-filter-option')].filter((l) => l.style.display !== 'none');
    // "None" acts on what the search is showing, not on all 14 - the button has
    // to mean what it looks like it means with a search term in the box.
    pop.querySelector('.column-filter-actions button[data-bulk="none"]').click();
    return {
      hasSearch: !!search,
      before,
      visibleCount: visible.length,
      rowsAfterNone: document.querySelectorAll('#apps-tbody .app-row').length
    };
  })()`);
  assert(longTail.hasSearch, 'a column with more than 12 distinct values gets a search box inside its popover');
  assert(longTail.before === 14, 'which lists all 14 publishers before searching');
  assert(longTail.visibleCount === 5, 'typing narrows the checklist to the matching values (1, 10, 11, 12, 13)');
  assert(longTail.rowsAfterNone === 9,
    'None hides only the values the search is showing, not every value in the column');

  // Back to the full seven-row fixture: the long-tail step above swapped the
  // whole pool out, features included.
  await run(win, `
    clearColumnFilters(APP_COLUMN_FILTERS);
    allApps = ${JSON.stringify(APPS)};
    windowsFeatures = ${JSON.stringify(FEATURES)};
    showFeatures = true;
    filterAndRenderApps();
    true;
  `);

  // 5rz shipped a selection that survives a re-sort and is pruned by a search.
  // A column filter is a third way for a selected row to leave the screen, and
  // the rule has to hold for it too: nothing the user cannot currently see may
  // still be queued behind them.
  const withSelection = await run(win, `(() => {
    document.getElementById('chk-select-all-apps').click();
    const selectedAll = bulkSelectedAppIds.size;
    document.querySelector('.column-filter-btn[data-filter-key="apps.type"]').click();
    const pop = document.getElementById('column-filter-pop');
    [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Desktop')
      .querySelector('input').click();
    return {
      selectedAll,
      selectedAfter: bulkSelectedAppIds.size,
      ids: [...bulkSelectedAppIds].sort().join(','),
      caption: document.getElementById('bulk-select-text').textContent,
      filterRowHidden: document.getElementById('filter-status-row').style.display === 'none',
      chipsStillShown: document.getElementById('apps-filter-chips').style.display !== 'none'
    };
  })()`);
  assert(withSelection.selectedAll === 7, 'select-all takes every rendered row');
  assert(withSelection.selectedAfter === 3 && withSelection.ids === 'a5,a6,f1',
    'a column filter prunes the rows it hides out of the selection, exactly as a search does');
  assert(withSelection.filterRowHidden && /filtered by Type/.test(withSelection.caption),
    'and while the selection occupies that slot, ITS caption carries the filter sentence (the 2026-08-05 regression guard, now with a column filter as the cause)');
  assert(withSelection.chipsStillShown,
    'the chips stay visible regardless, since they are not in the contested slot');

  await run(win, `
    document.getElementById('btn-bulk-clear-selection').click();
    clearColumnFilters(APP_COLUMN_FILTERS);
    filterAndRenderApps();
    true;
  `);

  // ==========================================================================
  // Task Manager: the multi-valued column
  // ==========================================================================
  console.log('');
  console.log('Task Manager: Indicators (multi-valued) and Process');

  await run(win, `
    document.querySelector('.nav-item[data-tab="task-manager"]').click();
    true;
  `);
  await wait(500);
  // Pause the 2-second sampler first: a background refresh mid-assertion would
  // overwrite the fixture with the stub's single row.
  await run(win, `
    if (!processPaused) document.getElementById('btn-toggle-process-refresh').click();
    processes = ${JSON.stringify(PROCESSES)};
    processFilter = '';
    document.getElementById('process-search').value = '';
    renderProcessTable();
    true;
  `);
  await wait(200);

  const procSeeded = await run(win, `(() => ({
    rows: document.querySelectorAll('#process-tbody tr[data-pid]').length,
    barHidden: document.getElementById('process-filter-bar').style.display === 'none'
  }))()`);
  assert(procSeeded.rows === 5, 'the five scripted processes rendered');
  assert(procSeeded.barHidden, 'the caption row stays out of the way while nothing is filtered');

  await hitTest(win, '.column-filter-btn[data-filter-key="process.indicators"]').then((r) =>
    assert(r.found && r.visible && r.hit,
      `the Indicators funnel is clickable in a header that also sorts (blocked by ${r.blockedBy})`)
  );

  const indicatorOptions = await run(win, `(() => {
    const sortBefore = JSON.stringify(processSort);
    document.querySelector('.column-filter-btn[data-filter-key="process.indicators"]').click();
    const pop = document.getElementById('column-filter-pop');
    return {
      sortUnchanged: JSON.stringify(processSort) === sortBefore,
      values: [...pop.querySelectorAll('.column-filter-option')].map((l) => l.getAttribute('data-value')),
      labels: [...pop.querySelectorAll('.column-filter-value')].map((v) => v.textContent),
      counts: [...pop.querySelectorAll('.column-filter-count')].map((c) => c.textContent)
    };
  })()`);
  assert(indicatorOptions.sortUnchanged,
    'clicking the funnel does NOT also re-sort the table underneath the popover it just opened');
  assert(
    indicatorOptions.values.join(',') === 'Autostart,Script-started,(none)',
    'the checklist offers the short labels the chips in the cells carry, with the synthetic "none" bucket last'
  );
  assert(indicatorOptions.labels[2] === 'None', 'and shows that bucket to the user as "None", not as "(none)"');
  assert(indicatorOptions.counts.join(',') === '2,2,2',
    'counts are per VALUE, so the process carrying two indicators counts once under each');

  const afterHideScript = await run(win, `(() => {
    const pop = document.getElementById('column-filter-pop');
    const opt = [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Script-started');
    opt.querySelector('input').click();
    return {
      names: [...document.querySelectorAll('#process-tbody tr[data-pid] td:first-child')].map((td) => td.textContent),
      caption: document.getElementById('process-filter-caption').textContent,
      barShown: document.getElementById('process-filter-bar').style.display !== 'none'
    };
  })()`);
  assert(!afterHideScript.names.includes('script-only.exe'),
    'hiding Script-started drops the process whose only indicator was Script-started');
  assert(afterHideScript.names.includes('both.exe'),
    'but KEEPS the process carrying two indicators, because its other one is still shown (trap 1 - the under-report)');
  assert(afterHideScript.names.length === 4, 'four of the five rows survive');
  assert(afterHideScript.barShown && /Showing 4 of 5 running programs - filtered by Indicators/.test(afterHideScript.caption),
    'a table that re-samples every two seconds says why it is short instead of reading as a quiet machine');

  const afterHideBoth = await run(win, `(() => {
    const pop = document.getElementById('column-filter-pop');
    const opt = [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Autostart');
    opt.querySelector('input').click();
    return {
      names: [...document.querySelectorAll('#process-tbody tr[data-pid] td:first-child')].map((td) => td.textContent),
      chips: [...document.querySelectorAll('#process-filter-chips .column-filter-chip')].map((c) => c.textContent.trim())
    };
  })()`);
  assert(!afterHideBoth.names.includes('both.exe'),
    'hiding BOTH of its indicators finally drops it - "any value still shown" is not "always visible"');
  assert(afterHideBoth.names.length === 2 && afterHideBoth.names.every((n) => n === 'chrome.exe'),
    'leaving only the two processes with no indicators at all');
  assert(afterHideBoth.chips.length === 1 && /Indicators: 1 of 3/.test(afterHideBoth.chips[0]),
    'the chip tracks how much of the column is hidden');

  const procEmpty = await run(win, `(() => {
    const pop = document.getElementById('column-filter-pop');
    const opt = [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === '(none)');
    opt.querySelector('input').click();
    return {
      rows: document.querySelectorAll('#process-tbody tr[data-pid]').length,
      text: document.getElementById('process-tbody').textContent.trim()
    };
  })()`);
  assert(procEmpty.rows === 0 && /Nothing running matches the Indicators filter/.test(procEmpty.text),
    'an empty process table names the filter that emptied it');

  const procNameFilter = await run(win, `(() => {
    clearColumnFilters(PROCESS_COLUMN_FILTERS);
    renderProcessTable();
    document.querySelector('.column-filter-btn[data-filter-key="process.name"]').click();
    const pop = document.getElementById('column-filter-pop');
    const values = [...pop.querySelectorAll('.column-filter-option')].map((l) => l.getAttribute('data-value'));
    const counts = [...pop.querySelectorAll('.column-filter-count')].map((c) => c.textContent);
    const chrome = [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'chrome.exe');
    chrome.querySelector('input').click();
    const rows = document.querySelectorAll('#process-tbody tr[data-pid]').length;
    // Clear resets the search box and every column at once.
    document.getElementById('process-search').value = 'chrome';
    processFilter = 'chrome';
    renderProcessTable();
    const bothActive = document.getElementById('process-filter-caption').textContent;
    document.getElementById('btn-clear-process-filters').click();
    return {
      values, counts, rows, bothActive,
      afterClear: document.querySelectorAll('#process-tbody tr[data-pid]').length,
      searchAfterClear: document.getElementById('process-search').value,
      barHidden: document.getElementById('process-filter-bar').style.display === 'none'
    };
  })()`);
  assert(procNameFilter.values.join(',') === 'autostart.exe,both.exe,chrome.exe,script-only.exe',
    'the Process column collapses repeated names into one option each');
  assert(procNameFilter.counts.join(',') === '1,1,2,1', 'with a count that says how many copies are running');
  assert(procNameFilter.rows === 3, 'hiding chrome.exe hides both of its processes');
  assert(/filtered by your search and Process/.test(procNameFilter.bothActive),
    'the caption names the search box and the column together when both are set');
  assert(procNameFilter.afterClear === 5 && procNameFilter.searchAfterClear === '' && procNameFilter.barHidden,
    'Clear drops both and hides its own row');

  // ==========================================================================
  // Health Advisor startup table: Source and Status
  // ==========================================================================
  console.log('');
  console.log('Health Advisor startup table: Source and Status');

  await run(win, `
    document.querySelector('.nav-item[data-tab="audit"]').click();
    true;
  `);
  await wait(600);
  await run(win, `renderStartupTable(${JSON.stringify(STARTUP)}); true;`);
  await wait(200);

  const startupSeeded = await run(win, `(() => ({
    rows: document.querySelectorAll('#audit-startup-tbody tr.app-row').length,
    funnels: [...document.querySelectorAll('#audit-startup-table .column-filter-btn')]
      .map((b) => b.getAttribute('data-filter-key')),
    barHidden: document.getElementById('startup-filter-bar').style.display === 'none'
  }))()`);
  assert(startupSeeded.rows === 5, 'all five startup entries rendered, necessary group included');
  assert(startupSeeded.funnels.join(',') === 'startup.source,startup.status',
    'the startup table registers its two funnels on first render');
  assert(startupSeeded.barHidden, 'with no caption row until something is filtered');

  const sourceFiltered = await run(win, `(() => {
    document.querySelector('.column-filter-btn[data-filter-key="startup.source"]').click();
    const pop = document.getElementById('column-filter-pop');
    const values = [...pop.querySelectorAll('.column-filter-option')].map((l) => l.getAttribute('data-value'));
    // Hide Registry and Service, leaving only the single TaskScheduler row -
    // which is item index 2 in the full list.
    ['Registry', 'Service'].forEach((v) => {
      [...pop.querySelectorAll('.column-filter-option')]
        .find((l) => l.getAttribute('data-value') === v)
        .querySelector('input').click();
    });
    const rows = [...document.querySelectorAll('#audit-startup-tbody tr.app-row')];
    const btn = document.querySelector('#audit-startup-tbody .startup-action-btn');
    return {
      values,
      rowCount: rows.length,
      name: rows[0] ? rows[0].querySelector('td').textContent.trim().split('\\n')[0].trim() : '',
      actionIndex: btn ? btn.getAttribute('data-startup-index') : null,
      resolvesTo: btn ? startupItems[parseInt(btn.getAttribute('data-startup-index'), 10)].name : null,
      caption: document.getElementById('startup-filter-caption').textContent,
      chips: [...document.querySelectorAll('#startup-filter-chips .column-filter-chip')].map((c) => c.textContent.trim())
    };
  })()`);
  assert(sourceFiltered.values.join(',') === 'Registry,Service,Task',
    'Source offers the words the cells show - "Task", not the raw "TaskScheduler" (trap 4 again, other table)');
  assert(sourceFiltered.rowCount === 1 && /TaskInactive/.test(sourceFiltered.name),
    'hiding Registry and Service leaves the one Task row');
  assert(sourceFiltered.actionIndex === '2' && sourceFiltered.resolvesTo === 'TaskInactive',
    'its action button still carries index 2 into the FULL item list - filtering drops rows, it never renumbers them');
  assert(/Showing 1 of 5 startup entries - filtered by Source/.test(sourceFiltered.caption),
    'the caption states it, because the count badge beside the section title still says 5');
  assert(sourceFiltered.chips.length === 1 && /Source: 1 of 3/.test(sourceFiltered.chips[0]), 'and a chip appears');

  const startupEmpty = await run(win, `(() => {
    document.querySelector('.column-filter-btn[data-filter-key="startup.status"]').click();
    const pop = document.getElementById('column-filter-pop');
    const values = [...pop.querySelectorAll('.column-filter-option')].map((l) => l.getAttribute('data-value'));
    // Status Inactive is the Task row's own status; hiding it empties the table
    // while entries plainly exist.
    [...pop.querySelectorAll('.column-filter-option')]
      .find((l) => l.getAttribute('data-value') === 'Inactive')
      .querySelector('input').click();
    return {
      values,
      text: document.getElementById('audit-startup-tbody').textContent.trim(),
      rows: document.querySelectorAll('#audit-startup-tbody tr.app-row').length,
      caption: document.getElementById('startup-filter-caption').textContent
    };
  })()`);
  assert(startupEmpty.values.join(',') === 'Active,Broken,Inactive',
    'Status offers the three states the dots and labels show');
  assert(startupEmpty.rows === 0, 'hiding the last surviving row empties the table');
  assert(/No startup entries match the Source, Status filter/.test(startupEmpty.text),
    'and it says which filters emptied it - never the reassuring "Nothing extra starts with Windows", which means something entirely different');
  assert(/Showing 0 of 5/.test(startupEmpty.caption), 'while the caption keeps the real total in view');

  const startupCleared = await run(win, `(() => {
    document.getElementById('btn-clear-startup-filters').click();
    return {
      rows: document.querySelectorAll('#audit-startup-tbody tr.app-row').length,
      barHidden: document.getElementById('startup-filter-bar').style.display === 'none'
    };
  })()`);
  assert(startupCleared.rows === 5 && startupCleared.barHidden,
    'Clear restores every startup row without re-running the PowerShell query behind the table');

  // ==========================================================================
  // Dismissal, and the thing that must NOT happen
  // ==========================================================================
  console.log('');
  console.log('Dismissal and persistence');

  const dismissal = await run(win, `(() => {
    document.querySelector('.column-filter-btn[data-filter-key="startup.source"]').click();
    const pop = document.getElementById('column-filter-pop');
    const openedOk = pop.style.display === 'flex';
    document.body.click();
    const closedByOutsideClick = pop.style.display === 'none';
    document.querySelector('.column-filter-btn[data-filter-key="startup.source"]').click();
    const reopened = pop.style.display === 'flex';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { openedOk, closedByOutsideClick, reopened, closedByEscape: pop.style.display === 'none' };
  })()`);
  assert(dismissal.openedOk && dismissal.closedByOutsideClick, 'a click outside the popover closes it');
  assert(dismissal.reopened && dismissal.closedByEscape, 'so does Escape');

  const settingsWrites = await run(win, `window.__test.callCount('setSettings')`);
  assert(
    settingsWrites === 0,
    'no filter interaction wrote to settings - a filter silently restored on next launch is the 2026-08-05 bug with a delay on it'
  );

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
});
