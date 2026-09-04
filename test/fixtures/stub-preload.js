// Test fixture: a fake window.api so index.html + renderer.js can be loaded
// offscreen and interacted with, without a live PowerShell engine.
// Used by test/ui-interaction-verify.js and test/ui-interaction-full-verify.js.
// Not shipped with the app.
//
// VANISH_STUB_TIER=full flips the tier; the default is Audit Mode with the
// elevation offer pending, because that is the real first-launch state.
const { contextBridge } = require('electron');

const fullMode = process.env.VANISH_STUB_TIER === 'full';

const apps = [
  {
    id: 'a1', name: 'Test Application', publisher: 'Test Publisher', version: '1.0.0',
    installDate: '2026-01-01', sizeBytes: 1048576, installLocation: 'C:\\Program Files\\Test',
    registryPath: 'HKLM:\\Software\\Test', type: 'Desktop',
    uninstallString: '"C:\\Program Files\\Test\\uninstall.exe"'
  }
];

const vaultEntries = [
  {
    id: '11111111-2222-3333-4444-555555555555', sourceApp: 'Test App', origin: 'uninstall-wizard',
    createdAt: new Date().toISOString(), status: 'quarantined',
    fileCount: 1, registryCount: 1, sizeBytes: 2048, vaultPath: 'C:\\vault\\entry',
    files: [{ originalPath: 'C:\\Program Files\\Test\\leftover.txt', status: 'quarantined' }],
    registry: [{ keyPath: 'HKCU\\Software\\Test', status: 'quarantined' }]
  }
];

// ---------------------------------------------------------------------------
// Generic per-method response override queue (TASK for bd vanish-uninstaller-7y0).
//
// Real API calls return whatever the engine found: an empty list, an error, a
// value shaped nothing like what the code was written against. A DOM-driving
// suite needs to reach those branches too, not just the happy path every
// method's default below represents. window.__test.queueResponse(method,
// value) pushes a one-shot response consumed by the NEXT call to that method;
// with nothing queued, the method falls back to its default. Queue
// { __reject: 'message' } to make the call reject instead of resolve, which is
// how getDesktopApps failing is distinguished from getDesktopApps returning [].
// ---------------------------------------------------------------------------
const responseQueues = {};

function nextResponse(method, fallback) {
  const queue = responseQueues[method];
  if (queue && queue.length > 0) return queue.shift();
  return fallback;
}

// How many times each method was actually called. "Did interacting with this
// screen re-run the scan?" is only answerable by counting what crossed the
// bridge, and several of this app's worst behaviours - a full re-enumeration on
// every tab visit, a minutes-long re-scan after every purge - were invisible
// precisely because nothing counted.
const callCounts = {};
// zl4: WHAT a channel was called with, not just how many times. Clean All is the
// first control that fans one click out across several sections, so "it called
// cleanerPurge twice" is not enough - the question is WHICH sections it sent,
// and specifically that a section whose only finding is list-only was skipped
// rather than sent as an empty purge.
const callArgs = {};
const scanProgressListeners = [];

function stub(method, defaultValue) {
  return async (...args) => {
    callCounts[method] = (callCounts[method] || 0) + 1;
    if (!callArgs[method]) callArgs[method] = [];
    // Structured-cloned across the bridge, so a later mutation by the renderer
    // cannot rewrite what the test believes was sent.
    try { callArgs[method].push(JSON.parse(JSON.stringify(args))); } catch { callArgs[method].push(null); }
    const r = nextResponse(method, defaultValue);
    if (r && typeof r === 'object' && '__reject' in r) throw new Error(r.__reject);
    return typeof r === 'function' ? r(...args) : r;
  };
}

contextBridge.exposeInMainWorld('api', {
  getDesktopApps: stub('getDesktopApps', apps),
  getUwpApps: stub('getUwpApps', []),
  getWindowsFeatures: stub('getWindowsFeatures', { success: true, features: [], total: 0, enabled: 0 }),
  // s4cx: the harness answers with no icon, which is the FALLBACK path -
  // every DOM suite therefore renders letter tiles and asserts against the
  // shape the renderer must keep working when extraction produces nothing.
  // A suite that wants the swap can override this per test.
  getAppIcon: stub('getAppIcon', { success: true, dataUrl: null }),
  // mp31: the default is the refusal, so a suite that does not opt in never
  // sees a size appear out of nowhere. Queue a completed answer to drive it.
  measureInstallSize: stub('measureInstallSize', { success: true, bytes: null, complete: false }),
  // h55: the default is the empty answer, so a suite that does not opt in never
  // sees a quick-pick list appear out of nowhere.
  getLockedPaths: stub('getLockedPaths', { success: true, items: [], dropped: 0 }),
  createRestorePoint: stub('createRestorePoint', { success: true }),
  scanLeftovers: stub('scanLeftovers', { files: [], registry: [] }),
  purgeRemnants: stub('purgeRemnants', { success: true, quarantinedCount: 0, files: [], registry: [] }),
  uninstallNative: stub('uninstallNative', { success: true }),
  checkAdmin: async () => fullMode,
  // mp4: settingsWritable defaults TRUE, because that is the common machine -
  // one where secure-data-dir has never run and an unelevated session saves
  // normally. The locked case is queued per test, since a fixture that
  // defaulted to locked would disable every control on the settings panel and
  // quietly break every other suite that touches it.
  getTier: stub('getTier', {
    tier: fullMode ? 'full' : 'audit',
    isFullMode: fullMode,
    offerElevation: !fullMode,
    settingsWritable: true,
    settingsLockReason: null,
    bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
  }),
  relaunchElevated: async () => ({ success: false, declined: true }),
  relaunchDeelevated: stub('relaunchDeelevated', { success: true }),
  dismissElevationOffer: async () => ({ success: true }),
  vaultList: stub('vaultList', { success: true, entries: vaultEntries, vaultRoot: 'C:\\vault' }),
  vaultRestore: stub('vaultRestore', { success: true, failed: 0, skipped: 0, files: [], registry: [] }),
  vaultDelete: stub('vaultDelete', { success: true }),
  openVaultFolder: async () => ({ success: true }),
  openDataFolder: async () => ({ success: true }),
  // hasSeenTour: true - these fixtures simulate an already-onboarded user.
  // Without it, appSettings.hasSeenTour comes back undefined (falsy) and the
  // guided tour auto-starts as a full-screen, pointer-events:all overlay,
  // blocking every click the UI-interaction suites make (caught live: 30
  // failures in the Full Mode suite alone, every one "blocked by
  // DIV#tour-overlay"). A suite that specifically wants first-run behaviour
  // can still override this per-test.
  getSettings: async () => ({
    autoPurgeEnabled: false, autoPurgeRetentionDays: 30,
    processRefreshSeconds: 2, defaultScanMode: 'Moderate', startupMode: 'audit',
    hasSeenTour: true
  }),
  // mp4: the reply is { settings, saved, reason }, never a bare settings
  // object and never a rejection. A rejection is exactly what used to reach
  // the renderer, where no catch existed and the toast after the await simply
  // never ran. Queue { saved: false, reason: ... } to drive the locked case.
  setSettings: stub('setSettings', (p) => ({
    settings: {
      autoPurgeEnabled: false, autoPurgeRetentionDays: 30,
      processRefreshSeconds: 2, defaultScanMode: 'Moderate', startupMode: 'audit',
      hasSeenTour: true, ...p
    },
    saved: true,
    reason: null
  })),
  getAppInfo: async () => ({
    name: 'vanish-uninstaller', version: '0.3.0', tier: fullMode ? 'full' : 'audit',
    isFullMode: fullMode, dataDir: 'C:\\data', vaultRoot: 'C:\\vault',
    oplogPath: 'C:\\data\\oplog.jsonl', oplogBytes: 0, vaultBytes: 2048, vaultEntryCount: 1,
    versions: { electron: '42.5.0', chrome: '138', node: '22' }
  }),
  getSystemDiagnostics: async () => ({
    os: { caption: 'Windows 11', version: '10.0', build: '26200', architecture: '64-bit', uptimeHours: 1 },
    cpu: { name: 'Test CPU', cores: 8, logicalCores: 16, maxClockMHz: 3000 },
    ram: { totalGB: 16, freeGB: 8, usedGB: 8, pctUsed: 50 },
    gpu: 'Test GPU', manufacturer: 'Test', model: 'Test', disks: []
  }),
  getStartupItems: async () => ({ items: [], total: 0, orphans: 0 }),
  getSoftwareRedundancy: async () => ({ groups: [], hasRedundancy: false }),
  // These four were plain hardcoded functions until a DOM-driving test
  // needed to script a specific process list and found queueResponse had no
  // effect on them - stub() wires them into the same override queue as
  // everything else below.
  listProcesses: stub('listProcesses', {
    success: true, sampledMs: 400, logicalCores: 16,
    indicatorNote: 'Indicator -- investigate with your antivirus',
    items: [{
      pid: 1234, name: 'testproc', cpuPercent: 1, memoryBytes: 1048576, ioBytesPerSec: 0,
      parentPid: 1, parentName: 'x', commandLine: 'x', imagePath: 'x',
      startedAt: '2026-01-01 00:00:00', indicators: []
    }]
  }),
  // --- Previously-missing methods (found 2026-08-09) -----------------------
  //
  // These seven were called by renderer.js but absent from this fixture
  // entirely, so the tabs that use them died on "window.api.X is not a
  // function" under test - the Health Advisor tab rendered nothing but that
  // error, which is how they were noticed at all. Same class of gap as the
  // four hardcoded methods noted above.
  //
  // Found by diffing every `window.api.*` in renderer.js against the keys
  // defined here, rather than one at a time as each broke. Worth re-running
  // that diff when adding a new IPC method:
  //   grep -oh "window\.api\.[a-zA-Z0-9_]*" renderer.js | sed 's/window\.api\.//' | sort -u
  getGpuUsage: stub('getGpuUsage', { success: true, byPid: {}, byAdapter: [] }),
  getGpuVendors: stub('getGpuVendors', []),
  getNetworkActivity: stub('getNetworkActivity', {
    success: true, verdict: 'quiet', sampleMs: 1000,
    adapters: [{
      name: 'Test Adapter', description: 'Test', type: 'Ethernet', isWireless: false,
      hasGateway: true, gatewayAddress: '192.168.1.1', linkSpeedBps: 1000000000,
      receiveBytesPerSecond: 0, sendBytesPerSecond: 0, totalBytesPerSecond: 0
    }],
    processes: [], totalBytesPerSecond: 0, busyThresholdBytesPerSecond: 50000,
    signalPercent: null, signalNote: null, updateTransfers: 0, bitsJobs: 0, elevated: false
  }),
  networkPing: stub('networkPing', { success: true, destination: '192.168.1.1', roundTripMs: 12 }),
  networkSpeedTest: stub('networkSpeedTest', {
    success: true, downBytesPerSecond: 1279548, upBytesPerSecond: 5449907,
    downBytes: 25000000, upBytes: 5000000, endpoint: 'speed.cloudflare.com', error: null,
  }),
  // ddx. The default payload is deliberately the shape that motivated the
  // feature rather than a tidy one: a SYSTEM service listening on every
  // interface, validly signed, belonging to software the user does not use -
  // alongside a loopback-only listener that must NOT be presented the same
  // way. A fixture that only carries the easy case tests nothing.
  getListeners: stub('getListeners', {
    success: true,
    totals: { all: 1, specific: 0, loopback: 1 },
    programs: [
      {
        pid: 4242, name: 'rpdsvc', path: 'C:\\Program Files (x86)\\Real\\RealPlayer\\RPDS\\Bin\\rpdsvc.exe',
        exposure: 'all', listenerCount: 2,
        listeners: [
          { protocol: 'TCP', address: '0.0.0.0', port: '20121', bindClass: 'all', socketCount: 1 },
          { protocol: 'TCP', address: '::', port: '20121', bindClass: 'all', socketCount: 1 }
        ],
        isService: true, serviceNames: ['RealPlayer Desktop Service'], serviceKeys: ['rpdsvc'],
        runsAsSystem: true, serviceAccount: 'LocalSystem', startMode: 'Auto',
        signature: { status: 'Valid', signer: 'RealNetworks LLC', isEv: true }
      },
      {
        pid: 5150, name: 'localthing', path: 'C:\\Tools\\localthing.exe',
        exposure: 'loopback', listenerCount: 1,
        listeners: [
          { protocol: 'TCP', address: '127.0.0.1', port: '9229', bindClass: 'loopback', socketCount: 1 }
        ],
        isService: false, serviceNames: [], serviceKeys: [],
        runsAsSystem: false, serviceAccount: null, startMode: null,
        signature: { status: 'not-checked', signer: null, isEv: false }
      }
    ]
  }),
  // ag0. Deliberately not the easy case: one dated security update, one row
  // Windows recorded NO install time for, and one component-store package with
  // no KB number at all. Those three are the shapes the panel has to render
  // without lying - a blank date must read as absent rather than as a value,
  // and a row with no KB cannot offer the wusa handoff because there is no
  // number to hand off.
  getWindowsUpdates: stub('getWindowsUpdates', {
    success: true,
    elevated: true,
    dismAvailable: true,
    dismNote: null,
    total: 3,
    recentCount: 1,
    recentDays: 14,
    undatedCount: 1,
    handoffCommand: 'wusa.exe /uninstall /kb:<number>',
    handoffUi: 'ms-settings:windowsupdate-history',
    updates: [
      {
        id: 'KB5121003', kb: 'KB5121003', title: 'Security Update', kind: 'Security update',
        installedOn: '2026-08-14T00:00:00.0000000', installedOnNote: null,
        source: 'servicing', state: 'Installed', removable: null,
        removalNote: 'Removing this puts back a hole Microsoft published a fix for, and the same update will usually reinstall itself.'
      },
      {
        id: 'KB5054156', kb: 'KB5054156', title: 'Update', kind: 'Cumulative update',
        installedOn: null,
        installedOnNote: 'Windows did not record an install time for this package.',
        source: 'servicing', state: 'Installed', removable: null,
        removalNote: 'A cumulative update contains every fix before it, so removing one rolls back months of work, not a day.'
      },
      {
        id: 'Microsoft-Windows-LanguageFeatures-Basic-en-gb-Package', kb: null,
        title: 'Microsoft-Windows-LanguageFeatures-Basic-en-gb-Package',
        kind: 'Optional component',
        installedOn: '2026-07-22T03:22:00.0000000', installedOnNote: null,
        source: 'component-store', state: 'Installed', removable: null,
        removalNote: 'An on-demand component such as a language pack or optional feature. Removing it is comparatively safe and it can be added again.'
      }
    ]
  }),
  networkHoldState: stub('networkHoldState', { active: false, record: null }),
  networkHoldApply: stub('networkHoldApply', { success: true }),
  networkHoldRevert: stub('networkHoldRevert', { success: true }),
  startupAction: stub('startupAction', { success: true }),
  killProcess: stub('killProcess', { success: true }),
  listLockers: stub('listLockers', { success: true, holders: [] }),
  unlockPath: stub('unlockPath', { success: true, closedTargets: 0, totalTargets: 0, notes: [] }),
  browseForPath: stub('browseForPath', { canceled: true }),
  processAttributionScan: stub('processAttributionScan', { success: true, results: [], counts: { owned: 0, orphaned: 0, unattributed: 0, system: 0 }, note: null }),
  snapshotBegin: stub('snapshotBegin', { success: true, takenAt: '2026-08-12T00:00:00.000Z' }),
  snapshotFinish: stub('snapshotFinish', {
    success: true,
    summary: '1 folder added',
    diff: {
      categories: {
        uninstall: { added: [], removed: [], readable: true },
        dirs: { added: ['C:\Program Files\Test'], removed: [], readable: true },
        run: { added: [], removed: [], readable: true },
        services: { added: [], removed: [], readable: true }
      },
      unreadable: [], totalAdded: 1, totalRemoved: 0, changed: true
    }
  }),
  snapshotState: stub('snapshotState', { watching: false, takenAt: null }),
  snapshotCancel: stub('snapshotCancel', { success: true }),
  attributionScan: stub('attributionScan', {
    success: true,
    counts: { owned: 3, orphaned: 1, unattributed: 1, system: 2 },
    reclaimableBytes: 1048576,
    measuredCount: 2,
    recordedInstallCount: 1,
    results: [
      { path: 'C:\\Program Files\\GoneApp', state: 'orphaned', owner: 'GoneApp',
        evidence: 'recorded', confidence: 'certain', sizeBytes: 1048576, measured: true, partial: false },
      { path: 'C:\\Program Files\\Mystery', state: 'unattributed', owner: null,
        evidence: 'none', confidence: null, sizeBytes: 2048, measured: true, partial: true }
    ]
  }),
  queueGet: stub('queueGet', { items: [], running: false, paused: false, counts: {} }),
  queueAdd: stub('queueAdd', { success: true }),
  queueRemove: stub('queueRemove', { success: true }),
  queueClear: stub('queueClear', { success: true }),
  queueRetry: stub('queueRetry', { success: true }),
  queueStart: stub('queueStart', { success: true }),
  queuePause: stub('queuePause', { success: true }),
  onQueueUpdate: () => () => {},
  findBrokenEntries: stub('findBrokenEntries', { success: true, total: 0, findings: [] }),
  cleanerScan: stub('cleanerScan', { success: true, findings: [] }),
  cleanerPurge: stub('cleanerPurge', { success: true, quarantinedCount: 1 }),

  // 5p5 machine hygiene. The DEFAULTS here are deliberately the two states a
  // happy-path fixture would never produce on its own: one check that ran and
  // found nothing, and a registry with two checks in it. Every interesting
  // case - a finding, a blind location, a check that does not come back - is
  // queued per test, because those are the states this screen exists to keep
  // apart and a default that produced them would hide a renderer that ignores
  // the difference.
  listHygieneFinders: stub('listHygieneFinders', {
    success: true,
    loaded: [],
    loadErrors: [],
    finders: [
      // walkGroup is '' here because the real engine always sends the field
      // (3l8) and these two checks share no walk. The absent-field case is
      // covered by hygieneWalkUnits' own assertions rather than by leaving a
      // fixture that no longer looks like what the engine returns.
      { name: 'stub-rescue', title: 'Stub rescue check', module: 'rescue', auditOnly: true, needsElevation: false, walkGroup: '' },
      { name: 'stub-reclaim', title: 'Stub reclaim check', module: 'reclaim', auditOnly: true, needsElevation: false, walkGroup: '' }
    ]
  }),
  // 3l8: ONE RESULT PER REQUESTED FINDER, not one per call. The panel now
  // asks for several checks at a time where they share a walk of the disk,
  // and a fixture that answered a four-finder call with one result would be
  // modelling an engine Vanish does not have -- every test would then take
  // the missing-result path and prove nothing about the normal one. Tests
  // that want a SHORT answer queue it explicitly with queueResponse.
  runHygieneScan: stub('runHygieneScan', (params) => {
    const wanted = (params && Array.isArray(params.finders) && params.finders.length)
      ? params.finders
      : ['stub-rescue'];
    return {
      success: true,
      results: wanted.map((name) => ({
        finder: name,
        title: `Stub ${name}`,
        module: String(name).indexOf('reclaim') >= 0 ? 'reclaim' : 'rescue',
        state: 'nothing',
        findings: [],
        unreadable: [],
        examinedCount: 3,
        totalBytes: 0
      }))
    };
  }),
  // 6g2 progress channel. The fixture keeps the same shape as the real preload
  // so the renderer takes the same code path here as it does in the app, and
  // __test.emitScanProgress lets a test drive it.
  onScanProgress: (callback) => {
    scanProgressListeners.push(callback);
    return () => {
      const at = scanProgressListeners.indexOf(callback);
      if (at !== -1) scanProgressListeners.splice(at, 1);
    };
  },
  minimizeWindow: () => {},
  maximizeWindow: () => {},
  closeWindow: () => {},
  openExternalLink: () => {}
});

// Test-only control surface. Never shipped: this preload is the fixture.
contextBridge.exposeInMainWorld('__test', {
  queueResponse: (method, value) => {
    if (!responseQueues[method]) responseQueues[method] = [];
    responseQueues[method].push(value);
  },
  // Kept for the existing SEC-1 dialog test: a thin wrapper over the same queue.
  setNextUninstallResponse: (response) => {
    responseQueues.uninstallNative = [response];
  },
  emitScanProgress: (payload) => {
    scanProgressListeners.forEach((cb) => cb(payload));
  },
  callCount: (method) => callCounts[method] || 0,
  callArgs: (method) => callArgs[method] || [],
  resetCallCounts: () => {
    Object.keys(callCounts).forEach((k) => delete callCounts[k]);
    Object.keys(callArgs).forEach((k) => delete callArgs[k]);
  }
});
