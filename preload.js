const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App Queries
  getDesktopApps: () => ipcRenderer.invoke('get-desktop-apps'),
  getUwpApps: () => ipcRenderer.invoke('get-uwp-apps'),
  getWindowsFeatures: () => ipcRenderer.invoke('get-windows-features'),

  // Safe Actions
  createRestorePoint: () => ipcRenderer.invoke('create-restore-point'),

  // Scanning & Quarantining
  scanLeftovers: (params) => ipcRenderer.invoke('scan-leftovers', params),
  purgeRemnants: (remnants) => ipcRenderer.invoke('purge-remnants', remnants),

  // Execution
  // SEC-1: takes a pointer, never a command. { type, registryPath } for a desktop
  // app or { type: 'UWP', packageFullName }, plus acknowledged:true once the
  // operator has confirmed an uninstaller the engine reported as untrusted.
  uninstallNative: (request) => ipcRenderer.invoke('uninstall-native', request),
  checkAdmin: () => ipcRenderer.invoke('check-admin'),

  // Elevation tiers (REQ-04, REQ-05)
  getTier: () => ipcRenderer.invoke('get-tier'),
  relaunchElevated: () => ipcRenderer.invoke('relaunch-elevated'),
  relaunchDeelevated: () => ipcRenderer.invoke('relaunch-deelevated'),
  dismissElevationOffer: () => ipcRenderer.invoke('dismiss-elevation-offer'),

  // Quarantine Manager (REQ-03)
  vaultList: () => ipcRenderer.invoke('vault-list'),
  vaultRestore: (params) => ipcRenderer.invoke('vault-restore', params),
  vaultDelete: (params) => ipcRenderer.invoke('vault-delete', params),
  openVaultFolder: () => ipcRenderer.invoke('open-vault-folder'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // Settings (ENT-02)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),

  // Stage 2 - Audit & Health Advisor
  getSystemDiagnostics: () => ipcRenderer.invoke('get-system-diagnostics'),
  getStartupItems: () => ipcRenderer.invoke('get-startup-items'),
  getSoftwareRedundancy: () => ipcRenderer.invoke('get-software-redundancy'),

  // Stage 3 - Task Manager & Unlocker (REQ-06..REQ-09)
  listProcesses: (params) => ipcRenderer.invoke('list-processes', params),
  getGpuUsage: () => ipcRenderer.invoke('get-gpu-usage'),
  getGpuVendors: () => ipcRenderer.invoke('get-gpu-vendors'),
  killProcess: (params) => ipcRenderer.invoke('kill-process', params),
  listLockers: (params) => ipcRenderer.invoke('list-lockers', params),
  unlockPath: (params) => ipcRenderer.invoke('unlock-path', params),
  browseForPath: () => ipcRenderer.invoke('browse-for-path'),

  // Stage 6 - Bulk uninstall queue (REQ-10, REQ-12, REQ-13)
  queueGet: () => ipcRenderer.invoke('queue-get'),
  queueAdd: (params) => ipcRenderer.invoke('queue-add', params),
  queueRemove: (params) => ipcRenderer.invoke('queue-remove', params),
  queueClear: () => ipcRenderer.invoke('queue-clear'),
  queueRetry: (params) => ipcRenderer.invoke('queue-retry', params),
  queueStart: (params) => ipcRenderer.invoke('queue-start', params),
  queuePause: () => ipcRenderer.invoke('queue-pause'),
  onQueueUpdate: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on('queue-update', listener);
    return () => ipcRenderer.removeListener('queue-update', listener);
  },

  // Stage 6 - Forced uninstall for broken entries (REQ-20)
  findBrokenEntries: () => ipcRenderer.invoke('find-broken-entries'),

  // bfh.1 - network attribution: what is using the connection, and whether
  // anything on this machine is at all. Read-only, no network I/O.
  getNetworkActivity: (params) => ipcRenderer.invoke('get-network-activity', params),

  // kp0 - the one deliberate exception: a single ICMP echo, only on an
  // explicit user tap. See main.js's handler for why this does not weaken
  // the "no network I/O" claim into a lie.
  networkPing: (params) => ipcRenderer.invoke('network-ping', params),

  // bfh.2 - hold background transfers, and put every setting back on release.
  networkHoldState: () => ipcRenderer.invoke('network-hold-state'),
  networkHoldApply: () => ipcRenderer.invoke('network-hold-apply'),
  networkHoldRevert: () => ipcRenderer.invoke('network-hold-revert'),

  // 7oo.11 - acting on a startup item (remove Run value / service to manual /
  // disable or enable a scheduled task)
  startupAction: (params) => ipcRenderer.invoke('startup-action', params),

  // Stage 9 - System Clean cleaners (REQ-11, REQ-14..REQ-17)
  cleanerScan: (params) => ipcRenderer.invoke('cleaner-scan', params),

  // zrw: install snapshot. Read-only both ends, so no tier gate.
  snapshotBegin: () => ipcRenderer.invoke('snapshot-begin'),
  snapshotFinish: () => ipcRenderer.invoke('snapshot-finish'),
  snapshotState: () => ipcRenderer.invoke('snapshot-state'),
  snapshotCancel: () => ipcRenderer.invoke('snapshot-cancel'),
  cleanerPurge: (params) => ipcRenderer.invoke('cleaner-purge', params),

  // 6g2 - interim state while a long scan runs. Before this, queue-update was
  // the only push channel in the app and every scan was silent until it
  // finished, which on a real machine is minutes.
  onScanProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },

  // Titlebar / Frame Controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),

  // Utilities
  openExternalLink: (url) => ipcRenderer.send('open-external-link', url)
});
