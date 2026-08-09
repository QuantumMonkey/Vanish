const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
// SEC-1: spawn only. Nothing in this process may hand a string to a shell.
const { spawn } = require('node:child_process');

const store = require('./lib/store');
const vault = require('./lib/vault');
const queue = require('./lib/queue');

let mainWindow;

// VANISH_HEADLESS_HARNESS=1 - set by test/real-data-verify.js and its siblings,
// never by the packaged app. Diagnostics that want the REAL IPC handlers have to
// require() this file, and until this existed that also spawned main.js's real
// visible window as a side effect: a test harness put a window on the operator's
// screen that was indistinguishable from the app itself and cost a debugging
// session (AGP-3 in the verification-pitfalls retrospective). With this set,
// bootstrap runs exactly as it always did except that no window is created and
// no start-up side effect that writes to the machine fires. The harness supplies
// its own window, with its own title, so it can never be mistaken for the app.
//
// SECURITY: gated on app.isPackaged, and that gate is the point rather than
// belt-and-braces. One of the start-up side effects this suppresses is
// secure-data-dir, which locks the directory holding manifest.json, queue.json
// and the .reg restore manifests - files the ELEVATED engine reads as
// instructions. A standard user who can write them has a privilege escalation
// path (security review 2026-08-03, Vuln 2). An environment variable that
// silently disables that hardening in a shipped, elevated build is a weakness
// even if setting it already implies some access, so in a packaged build these
// test hatches do not exist at all.
const testHatchesAllowed = !app.isPackaged;
const headlessHarness = testHatchesAllowed && process.env.VANISH_HEADLESS_HARNESS === '1';

// ==========================================
// ELEVATION TIERS (promptgate Rule 3, REQ-04, NFR-02)
// ==========================================
// Resolved once at startup and cached. The renderer's disabled states are a
// convenience; THIS is the boundary (INV-2).

const TIER_FULL = 'full';
const TIER_AUDIT = 'audit';

let currentTier = TIER_AUDIT;
let elevationOfferPending = false;
// EnableLUA / Administrators-group facts from the most recent UAC check
// (boot-time check-admin, or a later relaunch-elevated attempt). Null until
// the first check-admin call resolves.
let lastUacDiagnostics = null;

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
    // Don't paint an empty window: show it once the page has actually
    // rendered. Without this, any load failure - including the elevated-
    // relaunch temp-extraction race above - looks identical to the app simply
    // being slow: a correctly-sized, correctly-coloured window with nothing on
    // it, and no visible sign anything went wrong.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // A failed load (missing file, corrupted extraction, the race above) must
  // never fail silently into a blank window. Tell the user what happened
  // instead of leaving them staring at background colour with no error.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    if (errorCode === -3) return; // ERR_ABORTED - a deliberate navigation, not a failure
    dialog.showErrorBox(
      'Vanish could not load',
      `The application window failed to load its interface (${errorDescription || errorCode}).\n\n` +
      'If this happened right after "Restart as administrator", try closing every Vanish window and ' +
      'launching Vanish.exe again directly rather than through the elevation button.'
    );
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open developer tools in dev mode if needed
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Exposed so a harness that require()s this file can wait for bootstrap - tier
// resolution in particular - instead of guessing with a sleep.
const bootstrapped = app.whenReady().then(async () => {
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
    lastUacDiagnostics = (admin && admin.uac) || null;
  } catch {
    currentTier = TIER_AUDIT;
  }

  // Settings > "Start Vanish as administrator" (operator request 2026-08-03).
  // Ask Windows for elevation automatically, before any window exists, instead
  // of waiting for a manual click on the FLOW-01 offer. This does NOT bypass
  // UAC - the real Windows consent prompt still appears every launch; that is
  // by design and this project does not attempt to route around it (promptgate
  // Rule 13). The setting only changes WHEN Vanish asks, not whether Windows
  // asks. No new privilege: relaunch-elevated has always been reachable from
  // the renderer unconditionally, so this changes ordering, not attack surface.
  //
  // VANISH_DISABLE_AUTO_ELEVATE is a test/CI escape hatch, never set in the
  // packaged app. It skips only this automatic attempt - isFullMode() still
  // reflects the real WindowsPrincipal check either way. Without it, an
  // automated suite that loads this file directly (test/tier-verify.js and
  // its siblings) would hang an unattended run on a live UAC prompt if this
  // setting were ever left 'full' on the machine from real use.
  // Same packaging gate as headlessHarness above: a test hatch that changes
  // elevation behaviour must not be settable against a shipped build.
  const autoElevateDisabled = testHatchesAllowed && process.env.VANISH_DISABLE_AUTO_ELEVATE === '1';
  if (!autoElevateDisabled && !isFullMode() && store.readSettings().startupMode === 'full') {
    // Operator, 2026-08-07: "it takes about 5 seconds to restart the app after
    // closing, with no information in between." The wait is real - Windows has
    // to show consent and a second Electron process has to boot - and cannot be
    // engineered away. The silence can: this path used to create no window at
    // all, so the only feedback between double-click and the elevated window
    // was an empty desktop. A person who sees nothing happen assumes nothing
    // happened, and clicks again.
    showElevationSplash();
    const relaunch = await attemptElevatedRelaunch('startup-auto');
    if (relaunch.success) {
      // D-09: the elevated instance replaces this one. The splash stays up
      // until this process exits, so the desktop is never blank while the
      // elevated instance boots.
      app.quit();
      return;
    }
    // Declined, UAC cancelled, or the engine could not be reached: Rule 3 -
    // never exit or crash on a declined elevation. Fall through exactly as an
    // unelevated launch always has; the FLOW-01 offer below still gives the
    // operator a second, visible way to retry rather than a silent failure.
    closeElevationSplash();
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
  if (isFullMode() && !headlessHarness) {
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
            foreignOwners: before.foreignOwners || [],
            error: applied && applied.error
          }
        });
      }
    } catch (err) {
      console.error('Could not secure the data directory:', err.message);
    }
  }

  // FLOW-03 auto-purge branch (opt-in, off by default). A harness must never
  // delete anything from the operator's real vault just by starting.
  if (isFullMode() && !headlessHarness) {
    vault.autoPurgeSweep().catch((err) => console.error('Auto-purge sweep failed:', err.message));
  }

  // bfh.2, Rule 3: a network hold that outlived the session that made it gets
  // released now, without being asked. Leaving Windows Update capped at 1%
  // because Vanish crashed is exactly "left the system in a worse state than
  // before", and the user would have no way to know why updates stopped.
  if (isFullMode() && !headlessHarness) {
    releaseStaleNetworkHold().catch((err) => console.error('Could not release a leftover network hold:', err.message));
  }

  if (headlessHarness) return;

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

module.exports = { bootstrapped };

app.on('window-all-closed', () => {
  // A harness owns its own window and decides when the run is over; letting the
  // default quit-on-last-window fire would kill it mid-assertion.
  if (process.platform !== 'darwin' && !headlessHarness) app.quit();
});

// 6g2: scanner.ps1 emits progress lines on stderr behind this marker. stdout
// stays pure JSON, so nothing here can corrupt an existing result contract.
const PROGRESS_MARKER = '@@VANISH-PROGRESS@@';

// Where scanner.ps1 actually lives at runtime.
//
// PACKAGING BLOCKER, found while producing the first installer: in a packaged
// build __dirname points INSIDE app.asar, and powershell.exe cannot read a file
// out of an asar archive - it is a virtual filesystem only Electron understands.
// Every engine call in the packaged app would have failed with "the argument
// -File does not exist", i.e. the entire application. electron-builder copies
// the engine to resources/ via extraResources; this resolves to that copy when
// packaged and to the repo copy in development.
function enginePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scanner.ps1')
    : path.join(__dirname, 'scanner.ps1');
}

// Shown at most ONCE per session, ever - not just while open. Task Manager
// alone re-calls list-processes on a multi-second interval; if a "Not now"
// dismissal re-armed this, the very next poll against a still-missing file
// would pop the same modal again, and again, for as long as the panel stays
// open. One explanation is enough - every later failure still gets the same
// friendly (non-raw) error text in its own panel without a repeat interrupt.
let engineMissingDialogShown = false;

// Portable builds unpack to a fresh %TEMP% folder on every launch
// (attemptElevatedRelaunch above documents the same class of race). If that
// folder is gone mid-session - a duplicate instance's cleanup, antivirus
// quarantine, the user emptying Temp - the fix is the same either way: throw
// the current, now-broken extraction away and get a fresh one. app.relaunch()
// with PORTABLE_EXECUTABLE_FILE (the ORIGINAL exe the user double-clicked,
// never the temp copy) makes electron-builder's portable launcher perform
// that fresh extraction independently, exactly like a normal re-launch.
function relaunchAppInPlace() {
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const argList = app.isPackaged ? [] : [app.getAppPath()];
  app.relaunch({ execPath: exePath, args: argList });
  app.exit(0);
}

// Operator report: the Task Manager panel once showed "PowerShell exited with
// code 4294770688. Error: The argument '...\resources\scanner.ps1' to the
// -File parameter does not exist" verbatim - a raw process-binding error, not
// anything scanner.ps1 itself said. That text should never reach a user; this
// is the one, recognizable, actionable response to it.
function notifyEngineMissingAndOfferRestart(scriptPath) {
  if (engineMissingDialogShown) return;
  engineMissingDialogShown = true;
  const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
    type: 'warning',
    title: 'Vanish needs to restart',
    message: "Vanish's own files went missing from its temporary folder.",
    detail:
      'This can happen if two copies of the portable app were open at once, or antivirus software removed ' +
      'a file. Restarting Vanish re-extracts everything fresh, which normally fixes it immediately - nothing ' +
      'on this PC is changed either way.',
    buttons: ['Restart Vanish', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (choice === 0) relaunchAppInPlace(); // process is exiting; nothing after this runs
}

// Helper to run scanner.ps1 functions
//
// `onProgress` receives each progress record the engine emits while it works.
// Passing it is optional; every existing caller keeps its old behaviour.
function runPowerShell(action, params = {}, onProgress = null) {
  return new Promise((resolve, reject) => {
    const scriptPath = enginePath();

    if (!fs.existsSync(scriptPath)) {
      notifyEngineMissingAndOfferRestart(scriptPath);
      const err = new Error("Vanish couldn't find its own scanning engine. Restarting Vanish usually fixes this.");
      err.code = 'ENGINE_MISSING';
      reject(err);
      return;
    }

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
    let stderrPending = '';

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
      if (!onProgress) return;

      // Line-buffered: a chunk boundary can land mid-line, and half a JSON
      // object must be held rather than parsed.
      stderrPending += data.toString();
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop();

      for (const line of lines) {
        const at = line.indexOf(PROGRESS_MARKER);
        if (at === -1) continue;
        try {
          onProgress(JSON.parse(line.slice(at + PROGRESS_MARKER.length)));
        } catch {
          // A malformed progress line is never worth failing a scan over.
        }
      }
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        // This is a process-level failure (execution policy, PowerShell itself
        // crashing, a malformed -File argument) - NOT a scanner.ps1 action
        // returning its own {success:false, error:'...'} JSON, which is the
        // normal, already-friendly failure path every UI panel expects. The
        // raw exit code and stderr are real information, just not for a user
        // mid-task - they stay in the main-process console for diagnosis.
        console.error(`PowerShell exited with code ${code}. Error: ${stderr}`);
        const err = new Error(
          "Vanish's scanning engine hit an unexpected error and couldn't finish. Try again, or restart " +
          'Vanish if it keeps happening.'
        );
        err.code = 'ENGINE_PROCESS_FAILED';
        reject(err);
        return;
      }
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (err) {
        console.error(`Failed to parse PowerShell JSON: ${err.message}. Output was: ${stdout}`);
        const parseErr = new Error("Vanish's scanning engine returned something unexpected. Try again.");
        parseErr.code = 'ENGINE_BAD_OUTPUT';
        reject(parseErr);
      }
    });
  });
}

// 6g2: push interim scan state back to whichever window asked. Sent to the
// requesting sender rather than a stored window reference so a harness window
// receives its own progress and the real window is never written to by a
// diagnostic.
function sendScanProgress(event, payload) {
  const sender = event && event.sender;
  if (!sender || sender.isDestroyed()) return;
  sender.send('scan-progress', payload);
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

// 7oo.7: Windows optional features. Read-only, and deliberately available in
// Audit Mode - the engine uses the CIM class rather than the DISM cmdlet
// precisely so this works unelevated.
ipcMain.handle('get-windows-features', async () => {
  try {
    return await runPowerShell('list-windows-features');
  } catch (error) {
    return { success: false, error: error.message, features: [] };
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

// Run the application's own uninstaller (SEC-1, vanish-uninstaller-lwz).
//
// This handler used to take a command STRING from the renderer and hand it to
// exec(), i.e. to cmd.exe, as administrator. That string came from the registry,
// including HKCU:\...\Uninstall, which any standard user can write - so a planted
// entry carrying shell metacharacters was a one-click privilege escalation.
//
// The channel now takes a POINTER (a registry path, or a package full name) and
// runs the same pipeline the bulk queue uses: live re-read -> trust gate ->
// executable/arguments split -> Start-Process. No shell is involved at any point,
// and the renderer can no longer supply an executable or a command line at all.
const REBOOT_EXIT_CODES = new Set([3010, 1641]);

fullModeOnly('uninstall-native', async (event, params) => {
  const req = params && typeof params === 'object' ? params : {};

  if (req.type === 'UWP') return removeAppxPackage(req);

  if (!req.registryPath) {
    return { success: false, error: 'No registry entry was supplied for this app.' };
  }

  try {
    // Step 1: the LIVE registry is the only source of truth for what to run.
    // Whatever the renderer is displaying may be stale or tampered with.
    const live = await runPowerShell('read-uninstall-entry', { registryPath: req.registryPath });
    if (!live || live.success !== true || live.found !== true) {
      return {
        success: false,
        error: (live && live.error) || 'The uninstall entry no longer exists in the registry.'
      };
    }

    // Step 2: the same gate lib/queue.js runOne applies. An entry registered
    // under HKCU, or one whose binary sits somewhere a standard user can write,
    // is something malware could have planted - so it runs only if the operator
    // acknowledged it by name.
    const trust = live.trust || { risky: false, reasons: [] };
    const acknowledged = req.acknowledged === true;
    if (trust.risky && !acknowledged) {
      store.appendOplog({
        action: 'uninstall-native',
        tier: currentTier,
        items: { app: live.displayName, registryPath: req.registryPath },
        outcome: 'blocked',
        meta: { reason: 'unacknowledged untrusted uninstaller', trust }
      });
      return {
        success: false,
        blocked: true,
        trust,
        error: 'Not run: this uninstaller needs explicit confirmation because ' + trust.reasons.join('; ') + '.'
      };
    }

    // Step 3: Rule 15 lookup, and the executable split away from its arguments.
    const resolved = await runPowerShell('resolve-uninstall-args', {
      displayName: live.displayName,
      publisher: live.publisher,
      uninstallString: live.uninstallString
    });
    if (!resolved || resolved.success !== true) {
      return {
        success: false,
        error: (resolved && resolved.error) || 'Could not resolve uninstall arguments.'
      };
    }

    // Step 4: Start-Process -FilePath/-ArgumentList. No shell, no re-parsing.
    const run = await runPowerShell('run-uninstaller', {
      executable: resolved.executable,
      baseArgs: resolved.baseArgs,
      arguments: resolved.arguments,
      registryPath: req.registryPath,
      timeoutSeconds: 600,
      acknowledged
    });

    if (!run || run.success !== true) {
      store.appendOplog({
        action: 'uninstall-native',
        tier: currentTier,
        items: { app: live.displayName, registryPath: req.registryPath },
        outcome: run && run.blocked ? 'blocked' : 'error',
        meta: { error: run && run.error, method: resolved.method }
      });
      return {
        success: false,
        blocked: run && run.blocked === true,
        trust: run && run.trust,
        error: (run && run.error) || 'The uninstaller could not be started.'
      };
    }

    const rebootRequired = REBOOT_EXIT_CODES.has(run.exitCode);
    const ok = run.timedOut !== true &&
               (run.exitCode === 0 || run.exitCode === null || rebootRequired);

    store.appendOplog({
      action: 'uninstall-native',
      tier: currentTier,
      items: { app: live.displayName, registryPath: req.registryPath },
      outcome: ok ? 'success' : 'error',
      meta: {
        method: resolved.method,
        exitCode: run.exitCode ?? null,
        timedOut: run.timedOut === true,
        interactive: run.interactive === true,
        trust
      }
    });

    return {
      success: ok,
      exitCode: run.exitCode ?? null,
      timedOut: run.timedOut === true,
      interactive: run.interactive === true,
      rebootRequired,
      method: resolved.method,
      error: ok
        ? undefined
        : run.timedOut
          ? 'The uninstaller was still running after 10 minutes.'
          : `The uninstaller exited with code ${run.exitCode}.`
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// The UWP branch of the same channel. It used to build a powershell.exe command
// line and push it through the same exec() call; the engine now resolves the
// package itself and calls Remove-AppxPackage as a cmdlet.
async function removeAppxPackage(req) {
  if (!req.packageFullName) {
    return { success: false, error: 'No package name was supplied for this app.' };
  }
  try {
    const res = await runPowerShell('remove-appx', { packageFullName: req.packageFullName });
    store.appendOplog({
      action: 'uninstall-native',
      tier: currentTier,
      items: { package: req.packageFullName },
      outcome: res && res.success ? 'success' : 'error',
      meta: { type: 'UWP', error: res && res.error }
    });
    return res;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Check Admin Status - uses WindowsPrincipal API via PowerShell (Promptgate Rule 13)
ipcMain.handle('check-admin', async () => isFullMode());

// SCR-01: the renderer renders banner + disabled states from this one flag.
ipcMain.handle('get-tier', async () => ({
  tier: currentTier,
  isFullMode: isFullMode(),
  offerElevation: elevationOfferPending,
  bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
}));

// Shared by the FLOW-01 manual offer/banner AND the automatic startup
// elevation setting. Never throws; always resolves to {success, declined?,
// alreadyElevated?, error?} so both callers can apply Rule 3 (never crash or
// exit on a declined elevation) without duplicating the relaunch plumbing.
// A small window that exists only to say "Windows is about to ask you
// something, and the wait after that is normal". Deliberately independent of
// the main window: the automatic-elevation path runs before any main window
// exists, and the manual path is about to destroy the one that does.
let splashWindow = null;

// Operator report: a black, contentless window titled "Vanish" was seen
// during elevation on a UAC-disabled machine, with no error and nothing to
// close it. mainWindow has had a did-fail-load safety net since the earlier
// portable-extraction race was found (dialog instead of a silent blank
// window) - this window never had the equivalent, and being alwaysOnTop, a
// stuck blank splash sits in front of everything indefinitely rather than
// just being an inert background window. Root cause of that specific report
// was not confirmed (concurrent manual process manipulation during the same
// investigation makes the trace unreliable), but both gaps below are real
// and worth closing regardless of what caused that one incident.
const SPLASH_WATCHDOG_MS = 20000;

function showElevationSplash() {
  if (headlessHarness || splashWindow) return;
  try {
    splashWindow = new BrowserWindow({
      width: 460,
      height: 168,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      backgroundColor: '#0b0f19',
      title: 'Vanish',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    // Never leave an alwaysOnTop window with no content sitting in front of
    // everything else: if whatever normally closes this (a resolved
    // relaunch, success or failure) never fires, this is the fallback.
    const watchdog = setTimeout(() => closeElevationSplash(), SPLASH_WATCHDOG_MS);
    splashWindow.on('closed', () => {
      clearTimeout(watchdog);
      splashWindow = null;
    });
    splashWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      if (errorCode === -3) return; // ERR_ABORTED - a deliberate navigation, not a failure
      console.error(`Elevation splash failed to load: ${errorDescription || errorCode}`);
      closeElevationSplash();
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  } catch {
    // Feedback failing must never block the elevation it describes.
    splashWindow = null;
  }
}

function closeElevationSplash() {
  if (!splashWindow) return;
  try { splashWindow.destroy(); } catch { /* already gone */ }
  splashWindow = null;
}

async function attemptElevatedRelaunch(trigger) {
  if (isFullMode()) return { success: true, alreadyElevated: true };

  const argList = app.isPackaged ? [] : [app.getAppPath()];

  // BUG (operator report, blank navy window after clicking "Restart as
  // administrator" from the portable build): process.execPath, for a portable
  // build, is the TEMP-EXTRACTED copy - electron-builder's portable format
  // unpacks the whole app to a fresh %TEMP% folder on every launch and runs
  // from there. Relaunching that path is relaunching a copy that is not the
  // one the user double-clicked and is not guaranteed to still exist: the
  // ORIGINAL instance quits ~400ms after Start-Process returns, and if that
  // triggers portable cleanup of ITS OWN temp folder while the NEW elevated
  // process - launched from files in that same folder - is still reading
  // index.html/app.asar from it, the window paints its background colour and
  // never gets content. No error surfaces because nothing in this process
  // failed; the files it needed were gone.
  //
  // electron-builder sets PORTABLE_EXECUTABLE_FILE to the stable path of the
  // exe the user actually launched, specifically so a self-relaunch can target
  // that instead. Preferring it here means the elevated instance performs its
  // OWN independent extraction to its OWN new temp folder, with nothing shared
  // with (or deletable by) the instance being replaced.
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

  try {
    const res = await runPowerShell('relaunch-elevated', {
      exePath,
      argList
    });
    store.appendOplog({
      action: 'relaunch-elevated',
      tier: currentTier,
      items: {},
      outcome: res && res.success ? 'success' : 'declined',
      meta: { trigger, cause: res && res.cause }
    });
    if (res && res.success) return { success: true };
    if (res && res.uac) lastUacDiagnostics = res.uac;
    // scanner.ps1 now tells apart a real UAC decline (cause: 'declined') from
    // the account not being an administrator at all ('not-admin') or UAC
    // being turned off on this machine ('uac-disabled') -- forward that
    // instead of collapsing every failure back into "declined".
    const cause = (res && res.cause) || 'unknown';
    return {
      success: false,
      declined: cause === 'declined',
      cause,
      error: (res && res.error) || 'Elevation was declined.'
    };
  } catch (error) {
    // runPowerShell() itself threw -- the engine couldn't be reached at all
    // (e.g. the missing-scanner.ps1 case), not a UAC decision. Reporting this
    // as "declined" told the user Windows refused them when nothing about
    // Windows or UAC was even involved.
    return { success: false, declined: false, cause: 'engine-error', error: error.message };
  }
}

// FLOW-01: one-time relaunch offer. Declining (or cancelling UAC) stays in
// Audit Mode; the app never exits or crashes on a declined elevation.
ipcMain.handle('relaunch-elevated', async () => {
  elevationOfferPending = false;
  const res = await attemptElevatedRelaunch('user-click');
  if (res.success && !res.alreadyElevated) {
    // D-09: the elevated instance replaces this one - never run two writers.
    // The splash outlives the main window on purpose: without it the app
    // disappears off the desktop for several seconds while the elevated
    // instance starts, which reads as a crash rather than a restart.
    showElevationSplash();
    setTimeout(() => app.quit(), 400);
  }
  return res;
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
    uac: lastUacDiagnostics,
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

// Measured ~1.5-3s per call (Get-Counter '\GPU Engine(*)\Utilization
// Percentage' plus the usual engine spawn cost) - deliberately its own
// channel, sampled by the renderer on a slower cadence than list-processes,
// never awaited inline with the fast per-tick refresh.
ipcMain.handle('get-gpu-usage', async () => {
  try {
    return await runPowerShell('get-gpu-usage');
  } catch (error) {
    return { success: false, error: error.message, byPid: {}, byAdapter: [] };
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

// Native picker for the Unlocker input - typing a full path by hand was the
// only option before this (operator feedback 2026-08-05). Windows lets
// openFile and openDirectory combine into one dialog; other platforms would
// need to split this, but this app only ships on Windows.
ipcMain.handle('browse-for-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a file or folder to check for locks',
    properties: ['openFile', 'openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
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

// bfh.2: holding background transfers.
//
// The ordering is the whole design. Capture first, WRITE THE RECORD TO DISK,
// then change anything. A crash between capture and apply leaves a machine
// nobody touched; a crash after apply leaves a file that says exactly what to
// put back, and the next start puts it back. Same rule as the vault: the
// restore manifest exists before the mutation does.
function readHoldRecord() {
  return store.readJson(store.networkHoldPath(), null);
}

// Called once at startup. A record on disk means a previous session applied a
// hold and never released it - a crash, a kill, a power cut.
async function releaseStaleNetworkHold() {
  const record = readHoldRecord();
  if (!record || !record.active) return;

  const result = await runPowerShell('network-hold-revert', { record });
  store.appendOplog({
    action: 'network-release-stale',
    tier: currentTier,
    items: { restored: (result && result.restoredCount) || 0 },
    outcome: result && result.success ? 'success' : 'error',
    meta: { startedAt: record.startedAt, failed: result && result.failed }
  });
  if (result && result.success === true) clearHoldRecord();
}

function writeHoldRecord(record) {
  store.writeJsonAtomic(store.networkHoldPath(), record);
}

function clearHoldRecord() {
  try {
    require('node:fs').unlinkSync(store.networkHoldPath());
  } catch {
    /* already gone */
  }
}

ipcMain.handle('network-hold-state', async () => {
  const record = readHoldRecord();
  return {
    success: true,
    active: Boolean(record && record.active),
    record: record || null
  };
});

fullModeOnly('network-hold-apply', async () => {
  try {
    const existing = readHoldRecord();
    if (existing && existing.active) {
      return { success: false, error: 'Background transfers are already being held.' };
    }

    const capture = await runPowerShell('network-hold-capture');
    if (!capture || capture.success !== true) {
      return { success: false, error: (capture && capture.error) || 'Could not read the current settings, so nothing was changed.' };
    }

    const record = {
      active: true,
      startedAt: new Date().toISOString(),
      tier: currentTier,
      ...capture
    };
    // On disk BEFORE the first write. If the next line never runs, the file
    // describes a machine that was never changed, and reverting it is a no-op.
    writeHoldRecord(record);

    const applied = await runPowerShell('network-hold-apply', { record });

    store.appendOplog({
      action: 'network-hold',
      tier: currentTier,
      items: { bitsJobs: (capture.bitsJobs || []).length },
      outcome: applied && applied.success ? 'success' : 'error',
      meta: { error: applied && applied.error, failed: applied && applied.failed }
    });

    if (!applied || applied.success !== true) {
      // Nothing stuck: drop the record rather than leave a hold nobody can see
      // in the UI but the machine is still carrying.
      await runPowerShell('network-hold-revert', { record });
      clearHoldRecord();
      return { success: false, error: (applied && applied.error) || 'Nothing could be held, so nothing was changed.' };
    }

    writeHoldRecord({ ...record, applied: applied.applied, failed: applied.failed });
    return { success: true, ...applied, record };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

fullModeOnly('network-hold-revert', async () => {
  try {
    const record = readHoldRecord();
    if (!record) return { success: true, restoredCount: 0, nothingToDo: true };

    const result = await runPowerShell('network-hold-revert', { record });

    store.appendOplog({
      action: 'network-release',
      tier: currentTier,
      items: { restored: (result && result.restoredCount) || 0 },
      outcome: result && result.success ? 'success' : 'error',
      meta: { failed: result && result.failed }
    });

    // The record is only dropped when everything really went back. A partial
    // revert must stay on disk so the next attempt still knows what is
    // outstanding - forgetting it would strand the leftovers permanently.
    if (result && result.success === true) clearHoldRecord();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// bfh.1: reading who is using the network is read-only and works in Audit Mode.
// It samples local byte counters twice and asks Windows which process owns each
// connection - it opens no socket of its own (INV-4).
ipcMain.handle('get-network-activity', async (event, params) => {
  try {
    return await runPowerShell('get-network-activity', params || {});
  } catch (error) {
    console.error('Error reading network activity:', error);
    return { success: false, verdict: 'unreadable', adapters: [], processes: [], error: error.message };
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

// 7oo.11: acting on a startup item. Every path here that changes something
// persistent exports its restore manifest to the vault FIRST and only writes if
// that export succeeded (INV-1). A task is the exception and says so: disabling
// one destroys nothing, and the same button turns it back on.
fullModeOnly('startup-action', async (event, params) => {
  const item = (params && params.item) || {};
  const action = (params && params.action) || item.action;

  try {
    if (action === 'task-disable') {
      const enable = params.enable === true;
      const res = await runPowerShell('startup-task-enabled', {
        taskName: item.taskName,
        taskPath: item.taskPath,
        enable
      });
      store.appendOplog({
        action: 'startup-task',
        tier: currentTier,
        items: { task: item.managePath },
        outcome: res && res.success ? 'success' : 'error',
        meta: { enable, error: res && res.error }
      });
      return res;
    }

    if (action !== 'registry-remove' && action !== 'service-manual') {
      return { success: false, error: `Vanish has no action called "${action}" for a startup item.` };
    }

    if (!item.registryPath) {
      return { success: false, error: 'That entry does not say which registry key backs it, so it cannot be saved before changing.' };
    }

    // mode manifest-only: export the key as the restore manifest and LEAVE it
    // in place. Both writes below edit a value inside a key that must survive -
    // deleting the Run key itself would take every other program's startup
    // entry with it, and deleting a service key would unregister the service.
    const quarantined = await vault.quarantine(
      { files: [], registry: [{ path: item.registryPath, mode: 'manifest-only' }] },
      {
        sourceApp: action === 'service-manual' ? 'Startup services' : 'Startup entries',
        origin: `startup/${action}`
      }
    );

    if (!quarantined.success || quarantined.quarantinedCount === 0) {
      return {
        success: false,
        error: quarantined.error || 'Could not write the restore file, so nothing was changed.'
      };
    }

    const res = action === 'service-manual'
      ? await runPowerShell('startup-service-manual', { serviceName: item.serviceName })
      : await runPowerShell('startup-remove-registry', { keyPath: item.keyPath, valueName: item.valueName });

    store.appendOplog({
      action: action === 'service-manual' ? 'startup-service-manual' : 'startup-registry-remove',
      tier: currentTier,
      items: { entry: item.name, target: item.managePath },
      outcome: res && res.success ? 'success' : 'error',
      meta: { entryId: quarantined.entryId, error: res && res.error }
    });

    return { ...res, entryId: quarantined.entryId };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ==========================================
// STAGE 9 - SYSTEM CLEAN (SCR-05, FLOW-06)
// ==========================================

// Scanning is read-only and allowed in Audit Mode.
ipcMain.handle('cleaner-scan', async (event, params) => {
  const cleaner = (params && params.cleaner) || 'unknown';
  try {
    return await runPowerShell('cleaner-scan', params || {}, (progress) =>
      sendScanProgress(event, { scan: 'cleaner', cleaner, ...progress })
    );
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

    // File-backed findings (left-over Store app data) move into the vault
    // whole, the same way an uninstall's remnant folders do. A finding the
    // engine marked unremovable never reaches the vault, whatever the renderer
    // sent - the guard belongs on this side of the IPC boundary too.
    const files = items
      .filter((i) => i.kind === 'file' && i.path && i.removable !== false)
      .map((i) => ({ path: i.path }));

    if (registry.length === 0 && files.length === 0) {
      return { success: false, error: 'None of the selected findings can be removed in this release.' };
    }

    const result = await vault.quarantine(
      { files, registry },
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
    profiles: 'Other user profiles sweep',
    'uwp-leftovers': 'Left-over Store app data'
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
