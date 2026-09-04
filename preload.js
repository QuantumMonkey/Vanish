const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App Queries
  getDesktopApps: () => ipcRenderer.invoke('get-desktop-apps'),
  getUwpApps: () => ipcRenderer.invoke('get-uwp-apps'),
  getWindowsFeatures: () => ipcRenderer.invoke('get-windows-features'),
  // s4cx: one icon at a time, asked for lazily by the row that needs it.
  // Read-only and failure-silent - the renderer keeps its letter tile when this
  // returns null, because an icon is decoration and its absence means nothing.
  getAppIcon: (source) => ipcRenderer.invoke('get-app-icon', { source }),
  // mp31: one install folder at a time, asked for lazily by the row whose Size
  // column reads Unknown. Read-only and budgeted; an answer that could not be
  // completed comes back complete:false and the row keeps saying Unknown,
  // because a partial total presented as a size is worse than no size.
  measureInstallSize: (source) => ipcRenderer.invoke('measure-install-size', { source }),

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
  // h55: what Vanish itself could not remove because something held it. Read
  // out of the operation log the app already keeps - not a new list, and not a
  // scan of the machine.
  getLockedPaths: () => ipcRenderer.invoke('get-locked-paths'),
  unlockPath: (params) => ipcRenderer.invoke('unlock-path', params),
  browseForPath: (options) => ipcRenderer.invoke('browse-for-path', options || {}),
  // 0bi: which installed program each running process belongs to.
  processAttributionScan: (params) => ipcRenderer.invoke('process-attribution-scan', params || {}),

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
  getListeners: () => ipcRenderer.invoke('get-listeners'),
  getWindowsUpdates: () => ipcRenderer.invoke('get-windows-updates'),

  // 5p5/aeu - the machine-hygiene finders. AUDIT ONLY: every finder in
  // finders/ reports and removes nothing, so this channel is not gated by
  // fullModeOnly and works in Audit Mode like the rest of the read surface.
  runHygieneScan: (params) => ipcRenderer.invoke('run-hygiene-scan', params),
  // The registry of checks, so the panel can run them ONE AT A TIME and show
  // which is still working. Measured 2026-08-28: the hygiene module alone
  // takes 89 seconds on the operator's machine, and all three take longer
  // than ten minutes. A single call behind a single spinner would be the
  // Health Advisor bug again, an order of magnitude worse.
  listHygieneFinders: () => ipcRenderer.invoke('list-hygiene-finders'),
  networkSpeedTest: () => ipcRenderer.invoke('network-speedtest'),

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

  // bu2: size attribution. Read-only; no tier gate.
  attributionScan: () => ipcRenderer.invoke('attribution-scan'),
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
  // t4m9: a KEY, not a URL. The destinations live in main.js; nothing the
  // renderer can say reaches shell.openExternal as a string.
  openKnownLink: (key) => ipcRenderer.send('open-known-link', key)
});
