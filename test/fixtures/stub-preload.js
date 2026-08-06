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
const scanProgressListeners = [];

function stub(method, defaultValue) {
  return async (...args) => {
    callCounts[method] = (callCounts[method] || 0) + 1;
    const r = nextResponse(method, defaultValue);
    if (r && typeof r === 'object' && '__reject' in r) throw new Error(r.__reject);
    return typeof r === 'function' ? r(...args) : r;
  };
}

contextBridge.exposeInMainWorld('api', {
  getDesktopApps: stub('getDesktopApps', apps),
  getUwpApps: stub('getUwpApps', []),
  createRestorePoint: stub('createRestorePoint', { success: true }),
  scanLeftovers: stub('scanLeftovers', { files: [], registry: [] }),
  purgeRemnants: stub('purgeRemnants', { success: true, quarantinedCount: 0, files: [], registry: [] }),
  uninstallNative: stub('uninstallNative', { success: true }),
  checkAdmin: async () => fullMode,
  getTier: async () => ({
    tier: fullMode ? 'full' : 'audit',
    isFullMode: fullMode,
    offerElevation: !fullMode,
    bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
  }),
  relaunchElevated: async () => ({ success: false, declined: true }),
  dismissElevationOffer: async () => ({ success: true }),
  vaultList: stub('vaultList', { success: true, entries: vaultEntries, vaultRoot: 'C:\\vault' }),
  vaultRestore: stub('vaultRestore', { success: true, failed: 0, skipped: 0, files: [], registry: [] }),
  vaultDelete: stub('vaultDelete', { success: true }),
  openVaultFolder: async () => ({ success: true }),
  openDataFolder: async () => ({ success: true }),
  getSettings: async () => ({
    autoPurgeEnabled: false, autoPurgeRetentionDays: 30,
    processRefreshSeconds: 2, defaultScanMode: 'Moderate', startupMode: 'audit'
  }),
  setSettings: async (p) => ({
    autoPurgeEnabled: false, autoPurgeRetentionDays: 30,
    processRefreshSeconds: 2, defaultScanMode: 'Moderate', startupMode: 'audit', ...p
  }),
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
  killProcess: stub('killProcess', { success: true }),
  listLockers: stub('listLockers', { success: true, holders: [] }),
  unlockPath: stub('unlockPath', { success: true, closedTargets: 0, totalTargets: 0, notes: [] }),
  browseForPath: stub('browseForPath', { canceled: true }),
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
  resetCallCounts: () => {
    Object.keys(callCounts).forEach((k) => delete callCounts[k]);
  }
});
