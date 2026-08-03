const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');

const store = require('./lib/store');
const vault = require('./lib/vault');
const queue = require('./lib/queue');

let mainWindow;

// ==========================================
// ELEVATION TIERS (promptgate Rule 3, REQ-04, NFR-02)
// ==========================================
// Resolved once at startup and cached. The renderer's disabled states are a
// convenience; THIS is the boundary (INV-2).

const TIER_FULL = 'full';
const TIER_AUDIT = 'audit';

let currentTier = TIER_AUDIT;
let elevationOfferPending = false;

function isFullMode() {
  return currentTier === TIER_FULL;
}

// Wraps a destructive IPC handler so it can never run unelevated.
function fullModeOnly(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isFullMode()) {
      store.appendOplog({
        action: channel,
        tier: currentTier,
        items: {},
        outcome: 'rejected',
        meta: { reason: 'Audit Mode: destructive channel rejected' }
      });
      return {
        success: false,
        rejected: true,
        error: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
      };
    }
    return handler(event, ...args);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    frame: false, // Frameless for a premium, custom UI
    transparent: false,
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open developer tools in dev mode if needed
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  store.init(app.getPath('userData'));
  vault.init(runPowerShell);
  queue.init(runPowerShell, (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue-update', state);
    }
  });

  // Resolve the tier BEFORE any window exists, so no handler can run untiered.
  try {
    const admin = await runPowerShell('check-admin');
    currentTier = admin && admin.isAdmin === true ? TIER_FULL : TIER_AUDIT;
  } catch {
    currentTier = TIER_AUDIT;
  }
  elevationOfferPending = !isFullMode();

  store.appendOplog({
    action: 'app-start',
    tier: currentTier,
    items: {},
    outcome: 'success',
    meta: { version: app.getVersion() }
  });

  // The engine reads manifest.json, queue.json and the .reg restore manifests
  // as ELEVATED instructions. If a standard user can rewrite them, that is a
  // privilege escalation path (security review 2026-08-03, Vuln 2). Lock the
  // directory on every elevated start and record what we found.
  if (isFullMode()) {
    try {
      const before = await runPowerShell('check-data-dir', { path: store.dataDir() });
      if (before && before.exists && !before.protected) {
        const applied = await runPowerShell('secure-data-dir', { path: store.dataDir() });
        store.appendOplog({
          action: 'secure-data-dir',
          tier: currentTier,
          items: {},
          outcome: applied && applied.success ? 'success' : 'error',
          meta: {
            wasInherited: before.inherited === true,
            nonAdminWriters: before.nonAdminWriters || [],
            error: applied && applied.error
          }
        });
      }
    } catch (err) {
      console.error('Could not secure the data directory:', err.message);
    }
  }

  // FLOW-03 auto-purge branch (opt-in, off by default).
  if (isFullMode()) {
    vault.autoPurgeSweep().catch((err) => console.error('Auto-purge sweep failed:', err.message));
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Helper to run scanner.ps1 functions
function runPowerShell(action, params = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scanner.ps1');
    const paramsJson = JSON.stringify(params);
    const paramsBase64 = Buffer.from(paramsJson, 'utf8').toString('base64');

    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Action', action,
      '-ParamsBase64', paramsBase64
    ];

    const ps = spawn('powershell.exe', args);
    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell exited with code ${code}. Error: ${stderr}`));
        return;
      }
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (err) {
        reject(new Error(`Failed to parse PowerShell JSON: ${err.message}. Output was: ${stdout}`));
      }
    });
  });
}

// IPC Handlers
ipcMain.handle('get-desktop-apps', async () => {
  try {
    return await runPowerShell('list-desktop');
  } catch (error) {
    console.error('Error fetching desktop apps:', error);
    return [];
  }
});

ipcMain.handle('get-uwp-apps', async () => {
  try {
    return await runPowerShell('list-uwp');
  } catch (error) {
    console.error('Error fetching UWP apps:', error);
    return [];
  }
});

fullModeOnly('create-restore-point', async () => {
  try {
    return await runPowerShell('restore-point');
  } catch (error) {
    console.error('Error creating restore point:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('scan-leftovers', async (event, { appName, publisher, installLocation, mode }) => {
  try {
    return await runPowerShell('scan-leftovers', { appName, publisher, installLocation, mode });
  } catch (error) {
    console.error('Error scanning leftovers:', error);
    return { files: [], registry: [] };
  }
});

// FLOW-02: purge is quarantine. There is no direct-delete path here (Rule 2, INV-1).
fullModeOnly('purge-remnants', async (event, payload) => {
  try {
    const items = payload || {};
    return await vault.quarantine(
      { files: items.files || [], registry: items.registry || [] },
      {
        sourceApp: items.sourceApp || 'unknown',
        origin: items.origin || 'purge',
        allowOwnershipElevation: items.allowOwnershipElevation === true
      }
    );
  } catch (error) {
    console.error('Error quarantining remnants:', error);
    return { success: false, error: error.message };
  }
});

// Run native uninstaller
fullModeOnly('uninstall-native', async (event, uninstallString) => {
  return new Promise((resolve) => {
    if (!uninstallString) {
      resolve({ success: false, error: 'No uninstall command found for this app.' });
      return;
    }

    exec(uninstallString, (error) => {
      if (error) {
        // Some uninstallers exit with codes or complain, but they might still run
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
});

// Check Admin Status - uses WindowsPrincipal API via PowerShell (Promptgate Rule 13)
ipcMain.handle('check-admin', async () => isFullMode());

// SCR-01: the renderer renders banner + disabled states from this one flag.
ipcMain.handle('get-tier', async () => ({
  tier: currentTier,
  isFullMode: isFullMode(),
  offerElevation: elevationOfferPending,
  bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
}));

// FLOW-01: one-time relaunch offer. Declining (or cancelling UAC) stays in
// Audit Mode; the app never exits or crashes on a declined elevation.
ipcMain.handle('relaunch-elevated', async () => {
  elevationOfferPending = false;
  if (isFullMode()) return { success: true, alreadyElevated: true };

  const argList = app.isPackaged ? [] : [app.getAppPath()];
  try {
    const res = await runPowerShell('relaunch-elevated', {
      exePath: process.execPath,
      argList
    });
    store.appendOplog({
      action: 'relaunch-elevated',
      tier: currentTier,
      items: {},
      outcome: res && res.success ? 'success' : 'declined'
    });
    if (res && res.success) {
      // D-09: the elevated instance replaces this one - never run two writers.
      setTimeout(() => app.quit(), 400);
      return { success: true };
    }
    return { success: false, declined: true, error: (res && res.error) || 'Elevation was declined.' };
  } catch (error) {
    return { success: false, declined: true, error: error.message };
  }
});

ipcMain.handle('dismiss-elevation-offer', async () => {
  elevationOfferPending = false;
  return { success: true };
});

// ==========================================
// QUARANTINE MANAGER (SCR-02, FLOW-03, REQ-03)
// ==========================================

ipcMain.handle('vault-list', async () => {
  try {
    return { success: true, entries: vault.list(), vaultRoot: store.vaultRoot() };
  } catch (error) {
    return { success: false, error: error.message, entries: [] };
  }
});

fullModeOnly('vault-restore', async (event, { entryId, onConflict }) => {
  try {
    return await vault.restore(entryId, onConflict || 'skip');
  } catch (error) {
    return { success: false, error: error.message };
  }
});

fullModeOnly('vault-delete', async (event, { entryId }) => {
  try {
    return await vault.deleteForever(entryId, 'user confirmed Delete Forever');
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-settings', async () => store.readSettings());

ipcMain.handle('set-settings', async (event, patch) => {
  const saved = store.writeSettings(patch || {});
  store.appendOplog({
    action: 'settings-change',
    tier: currentTier,
    items: {},
    outcome: 'success',
    meta: { patch }
  });
  return saved;
});

ipcMain.handle('open-vault-folder', async () => {
  await shell.openPath(store.vaultRoot());
  return { success: true };
});

ipcMain.handle('open-data-folder', async () => {
  await shell.openPath(store.dataDir());
  return { success: true };
});

// Backs the About and Settings panels. Everything here is local state - there
// is no update check, no licence server, and nothing to phone home about.
ipcMain.handle('get-app-info', async () => {
  let oplogBytes = 0;
  let vaultBytes = 0;
  try {
    oplogBytes = require('node:fs').statSync(store.oplogPath()).size;
  } catch {
    /* no log yet */
  }
  try {
    vaultBytes = store.directorySize(store.vaultRoot());
  } catch {
    /* no vault yet */
  }

  const manifest = store.readManifest();
  return {
    name: app.getName(),
    version: app.getVersion(),
    tier: currentTier,
    isFullMode: isFullMode(),
    dataDir: store.dataDir(),
    vaultRoot: store.vaultRoot(),
    oplogPath: store.oplogPath(),
    oplogBytes,
    vaultBytes,
    vaultEntryCount: manifest.entries.filter((e) => e.status === 'quarantined').length,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  };
});

// ==========================================
// STAGE 3 - TASK MANAGER & UNLOCKER (SCR-03, FLOW-04)
// ==========================================

// Read-only: the list is available in Audit Mode (03-appflow tab map).
ipcMain.handle('list-processes', async (event, params) => {
  try {
    return await runPowerShell('list-processes', params || {});
  } catch (error) {
    return { success: false, error: error.message, items: [] };
  }
});

fullModeOnly('kill-process', async (event, params) => {
  try {
    const res = await runPowerShell('kill-process', params || {});
    store.appendOplog({
      action: 'kill-process',
      tier: currentTier,
      items: { pid: params && params.pid, name: params && params.name },
      outcome: res && res.success ? 'success' : 'error',
      meta: res && res.error ? { error: res.error } : {}
    });
    return res;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Read-only enumeration; closing holders is the Full Mode step below.
ipcMain.handle('list-lockers', async (event, params) => {
  try {
    return await runPowerShell('list-lockers', params || {});
  } catch (error) {
    return { success: false, error: error.message, holders: [] };
  }
});

fullModeOnly('unlock-path', async (event, params) => {
  try {
    const res = await runPowerShell('unlock-path', params || {});
    store.appendOplog({
      action: 'unlock-path',
      tier: currentTier,
      items: { path: params && params.path, holders: (params && params.pids ? params.pids.length : 0) },
      outcome: res && res.success ? 'success' : 'error',
      meta: {
        force: !!(params && params.force),
        suspendTree: !!(params && params.suspendTree),
        error: res && res.error ? res.error : undefined
      }
    });
    return res;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ==========================================
// STAGE 6 - BULK UNINSTALL QUEUE (SCR-04, FLOW-05)
// ==========================================

ipcMain.handle('queue-get', async () => queue.getState());

fullModeOnly('queue-add', async (event, app) => queue.add(app || {}));
fullModeOnly('queue-remove', async (event, { itemId }) => queue.remove(itemId));
fullModeOnly('queue-clear', async () => queue.clear());
fullModeOnly('queue-retry', async (event, { itemId }) => queue.retry(itemId));
fullModeOnly('queue-pause', async () => queue.pause());
fullModeOnly('queue-start', async (event, params) => {
  try {
    // Only the ids the user ticked by name in the confirmation may run an
    // uninstaller that is registered under HKCU or lives in a user-writable
    // location. Anything else is skipped as "needs attention".
    return await queue.start((params && params.acknowledgedIds) || []);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Stage 2 - Audit & Health Advisor IPC Handlers
ipcMain.handle('get-system-diagnostics', async () => {
  try {
    return await runPowerShell('get-system-diagnostics');
  } catch (error) {
    console.error('Error getting system diagnostics:', error);
    return { error: error.message };
  }
});

ipcMain.handle('get-startup-items', async () => {
  try {
    return await runPowerShell('get-startup-items');
  } catch (error) {
    console.error('Error getting startup items:', error);
    return { items: [], total: 0, orphans: 0, error: error.message };
  }
});

ipcMain.handle('get-software-redundancy', async () => {
  try {
    return await runPowerShell('get-software-redundancy');
  } catch (error) {
    console.error('Error getting software redundancy:', error);
    return { groups: [], hasRedundancy: false, error: error.message };
  }
});

// REQ-20: detecting broken entries is read-only and works in Audit Mode.
ipcMain.handle('find-broken-entries', async () => {
  try {
    return await runPowerShell('find-broken-entries');
  } catch (error) {
    return { success: false, error: error.message, findings: [] };
  }
});

// ==========================================
// STAGE 9 - SYSTEM CLEAN (SCR-05, FLOW-06)
// ==========================================

// Scanning is read-only and allowed in Audit Mode.
ipcMain.handle('cleaner-scan', async (event, params) => {
  try {
    return await runPowerShell('cleaner-scan', params || {});
  } catch (error) {
    return { success: false, error: error.message, findings: [] };
  }
});

// FLOW-06: every cleaner purges through the FLOW-02 vault pipeline. There is
// no removal path here that bypasses quarantine (INV-1).
fullModeOnly('cleaner-purge', async (event, params) => {
  const cleaner = (params && params.cleaner) || 'unknown';
  const items = (params && params.items) || [];
  if (items.length === 0) return { success: false, error: 'Nothing selected.' };

  try {
    if (cleaner === 'path') return purgePathEntries(items, params);

    // Registry-backed cleaners (context menus, services, associations,
    // other profiles) all reduce to "export the key, then remove it".
    const registry = items
      .filter((i) => i.kind === 'registry' && i.registryPath)
      .map((i) => ({ path: i.registryPath }));

    if (registry.length === 0) {
      return { success: false, error: 'None of the selected findings can be removed in this release.' };
    }

    const result = await vault.quarantine(
      { files: [], registry },
      {
        sourceApp: cleanerSourceLabel(cleaner),
        origin: `system-clean/${cleaner}`,
        allowOwnershipElevation: params.allowOwnershipElevation === true
      }
    );

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// REQ-15: PATH lives in a registry VALUE, so the whole Environment key is
// exported as the restore manifest first (mode manifest-only), and only then
// is the value rewritten. Restoring the entry re-imports the exact prior string.
async function purgePathEntries(items, params) {
  const byScope = new Map();
  for (const item of items) {
    const scope = (item.meta && item.meta.scope) || 'User';
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(item);
  }

  const results = [];
  for (const [scope, scopeItems] of byScope) {
    const registryPath = scopeItems[0].registryPath;

    const quarantined = await vault.quarantine(
      { files: [], registry: [{ path: registryPath, mode: 'manifest-only' }] },
      { sourceApp: 'PATH cleaner', origin: `system-clean/path/${scope}` }
    );

    if (!quarantined.success || quarantined.quarantinedCount === 0) {
      results.push({
        scope,
        success: false,
        error: quarantined.error || 'Could not write the PATH restore manifest; nothing was changed.'
      });
      continue;
    }

    const written = await runPowerShell('set-path-entries', {
      scope,
      remove: scopeItems.map((i) => i.meta.entry)
    });

    store.appendOplog({
      action: 'path-clean',
      tier: currentTier,
      items: { scope, removed: scopeItems.length },
      outcome: written && written.success ? 'success' : 'error',
      meta: { entryId: quarantined.entryId, error: written && written.error }
    });

    results.push({
      scope,
      success: written && written.success === true,
      removedCount: written && written.removedCount,
      error: written && written.error,
      entryId: quarantined.entryId
    });
  }

  const failed = results.filter((r) => !r.success);
  return {
    success: failed.length === 0,
    perScope: results,
    error: failed.length ? failed.map((f) => `${f.scope}: ${f.error}`).join('; ') : undefined,
    quarantinedCount: results.filter((r) => r.success).length
  };
}

function cleanerSourceLabel(cleaner) {
  const labels = {
    'context-menus': 'Context menu cleaner',
    services: 'Orphaned services cleaner',
    associations: 'File association repair',
    profiles: 'Other user profiles sweep'
  };
  return labels[cleaner] || `System Clean (${cleaner})`;
}

// Frameless Window Control Handlers
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// Open link in external browser
ipcMain.on('open-external-link', (event, url) => {
  shell.openExternal(url);
});
