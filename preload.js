const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App Queries
  getDesktopApps: () => ipcRenderer.invoke('get-desktop-apps'),
  getUwpApps: () => ipcRenderer.invoke('get-uwp-apps'),
  
  // Safe Actions
  createRestorePoint: () => ipcRenderer.invoke('create-restore-point'),
  
  // Scanning & Purging
  scanLeftovers: (params) => ipcRenderer.invoke('scan-leftovers', params),
  purgeRemnants: (remnants) => ipcRenderer.invoke('purge-remnants', remnants),
  
  // Execution
  uninstallNative: (uninstallString) => ipcRenderer.invoke('uninstall-native', uninstallString),
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  
  // Stage 2 — Audit & Health Advisor
  getSystemDiagnostics: () => ipcRenderer.invoke('get-system-diagnostics'),
  getStartupItems: () => ipcRenderer.invoke('get-startup-items'),
  getSoftwareRedundancy: () => ipcRenderer.invoke('get-software-redundancy'),
  
  // Titlebar / Frame Controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  
  // Utilities
  openExternalLink: (url) => ipcRenderer.send('open-external-link', url)
});

