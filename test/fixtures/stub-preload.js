// Test fixture: a fake window.api so index.html + renderer.js can be loaded
// offscreen and interacted with, without a live PowerShell engine.
// Used by test/ui-interaction-verify.js. Not shipped with the app.
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

contextBridge.exposeInMainWorld('api', {
  getDesktopApps: async () => apps,
  getUwpApps: async () => [],
  createRestorePoint: async () => ({ success: true }),
  scanLeftovers: async () => ({ files: [], registry: [] }),
  purgeRemnants: async () => ({ success: true, quarantinedCount: 0, files: [], registry: [] }),
  uninstallNative: async () => ({ success: true }),
  checkAdmin: async () => fullMode,
  getTier: async () => ({
    tier: fullMode ? 'full' : 'audit',
    isFullMode: fullMode,
    offerElevation: !fullMode,
    bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
  }),
  relaunchElevated: async () => ({ success: false, declined: true }),
  dismissElevationOffer: async () => ({ success: true }),
  vaultList: async () => ({ success: true, entries: vaultEntries, vaultRoot: 'C:\\vault' }),
  vaultRestore: async () => ({ success: true, failed: 0, skipped: 0, files: [], registry: [] }),
  vaultDelete: async () => ({ success: true }),
  openVaultFolder: async () => ({ success: true }),
  openDataFolder: async () => ({ success: true }),
  getSettings: async () => ({
    autoPurgeEnabled: false, autoPurgeRetentionDays: 30,
    processRefreshSeconds: 2, defaultScanMode: 'Moderate'
  }),
  setSettings: async (p) => ({
    autoPurgeEnabled: false, autoPurgeRetentionDays: 30,
    processRefreshSeconds: 2, defaultScanMode: 'Moderate', ...p
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
  listProcesses: async () => ({
    success: true, sampledMs: 400, logicalCores: 16,
    indicatorNote: 'Indicator -- investigate with your antivirus',
    items: [{
      pid: 1234, name: 'testproc', cpuPercent: 1, memoryBytes: 1048576, ioBytesPerSec: 0,
      parentPid: 1, parentName: 'x', commandLine: 'x', imagePath: 'x',
      startedAt: '2026-01-01 00:00:00', indicators: []
    }]
  }),
  killProcess: async () => ({ success: true }),
  listLockers: async () => ({ success: true, holders: [] }),
  unlockPath: async () => ({ success: true, closedTargets: 0, totalTargets: 0, notes: [] }),
  queueGet: async () => ({ items: [], running: false, paused: false, counts: {} }),
  queueAdd: async () => ({ success: true }),
  queueRemove: async () => ({ success: true }),
  queueClear: async () => ({ success: true }),
  queueRetry: async () => ({ success: true }),
  queueStart: async () => ({ success: true }),
  queuePause: async () => ({ success: true }),
  onQueueUpdate: () => () => {},
  findBrokenEntries: async () => ({ success: true, total: 0, findings: [] }),
  cleanerScan: async () => ({ success: true, findings: [] }),
  cleanerPurge: async () => ({ success: true, quarantinedCount: 1 }),
  minimizeWindow: () => {},
  maximizeWindow: () => {},
  closeWindow: () => {},
  openExternalLink: () => {}
});
