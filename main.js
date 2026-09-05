const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
// SEC-1: spawn only. Nothing in this process may hand a string to a shell.
const { spawn } = require('node:child_process');

const store = require('./lib/store');
const vault = require('./lib/vault');
const queue = require('./lib/queue');
const snapshot = require('./lib/snapshot'); // zrw: install snapshot diff
const attribution = require('./lib/attribution'); // bu2: size attribution
const processAttribution = require('./lib/process-attribution');
const pathShape = require('./lib/path-shape'); // lr9d: one path rule, every call site

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
// Set once, at most, per boot - see the elevation-attempt marker check in
// bootstrapped below. Consumed (read then cleared) by get-tier so it
// surfaces to the renderer exactly once, not on every poll.
let elevationMismatchDiagnostic = null;

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

  // Operator report, live testing 2026-08-10: a relaunch-elevated attempt
  // could report success and still come back in Audit Mode - read the
  // one-shot marker attemptElevatedRelaunch writes just before quitting on
  // its success path, and ALWAYS delete it here regardless of outcome, so a
  // stale marker (crash before cleanup, machine slept mid-relaunch) can
  // never misfire on a later, unrelated launch.
  try {
    const markerPath = store.elevationAttemptPath();
    const marker = store.readJson(markerPath, null);
    if (marker) {
      try { fs.unlinkSync(markerPath); } catch { /* best-effort */ }
      if (typeof marker.attemptedAt === 'string') {
        const msSinceAttempt = Date.now() - Date.parse(marker.attemptedAt);
        // A marker only counts as evidence of THIS boot if it is recent and
        // not from the future (clock skew, or a malformed timestamp).
        const recent = msSinceAttempt >= 0 && msSinceAttempt < 5 * 60 * 1000;

        // 1dq: BOTH directions. 6lg only ever checked "asked to elevate, came
        // back Audit", so the mirror case was invisible - and the mirror case
        // is the one that actually bit: the operator's 2026-08-13 round trip
        // logged two successful de-elevations and came back Full Mode both
        // times, with nothing anywhere saying so. A relaunch that reports
        // success and lands in the tier it was leaving is a failed relaunch in
        // either direction, and the app is the only thing positioned to notice.
        const wanted = marker.direction === 'deelevate' ? TIER_AUDIT : TIER_FULL;
        const landed = isFullMode() ? TIER_FULL : TIER_AUDIT;

        if (recent && landed !== wanted) {
          elevationMismatchDiagnostic = {
            attemptedAt: marker.attemptedAt,
            trigger: marker.trigger,
            direction: marker.direction || 'elevate',
            wantedTier: wanted,
            landedTier: landed,
            msSinceAttempt,
            uac: lastUacDiagnostics
          };
          store.appendOplog({
            action: marker.direction === 'deelevate'
              ? 'relaunch-deelevated-mismatch'
              : 'relaunch-elevated-mismatch',
            tier: currentTier,
            items: {},
            outcome: 'error',
            meta: elevationMismatchDiagnostic
          });
        } else if (!recent) {
          // gnu: a marker older than the window is weak evidence about THIS
          // boot, so it still produces no verdict and no diagnostic banner.
          // But "too old to judge" and "never happened" were previously the
          // same thing - both silently deleted - and the case the window
          // excludes is the worst one: a relaunch that reports success and
          // then never restarts at all. The app quits, nothing comes back, the
          // user reopens it an hour later, and the only record that anything
          // was ever attempted is thrown away unread.
          //
          // So the EVIDENCE is written even though the VERDICT is withheld.
          // outcome is 'unknown' rather than 'error' on purpose: whether this
          // is a failure genuinely cannot be determined from here, and calling
          // it one would be the same overreach as calling a could-not-look a
          // nothing. Whoever reads the oplog gets the timestamps and can tell.
          store.appendOplog({
            action: 'relaunch-attempt-unresolved',
            tier: currentTier,
            items: {},
            outcome: 'unknown',
            meta: {
              attemptedAt: marker.attemptedAt,
              trigger: marker.trigger,
              direction: marker.direction || 'elevate',
              wantedTier: wanted,
              landedTier: landed,
              msSinceAttempt,
              why: msSinceAttempt < 0
                ? 'the marker is timestamped in the future, so the clock moved or the timestamp is malformed'
                : 'the marker is older than the 5-minute window, so this boot cannot be attributed to that attempt'
            }
          });
        }
      }
    }
  } catch {
    // Diagnostic-only path; never let it affect real startup.
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

  // isp: turn on ownership enforcement for our own state writes now that the
  // tier is known, and BEFORE the first oplog append below - otherwise the
  // very next line creates oplog.jsonl owned by the interactive user and the
  // SEC-3 check that runs a few lines further down reports the directory as
  // unprotected because of something we just did. Only an elevated process
  // can take ownership, so this is a no-op in Audit Mode by construction.
  store.setOwnershipEnforcement(isFullMode());

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
// s4cx: the icon the engine already collected.
//
// scanner.ps1 reads DisplayIcon out of each uninstall key and ships it as
// `icon`. main.js passed it through. renderer/core.js used it NOWHERE - every
// one of the 152 rows drew a letter tile, which is why AI Noise Cancelation,
// AMD Radeon Software and Antigravity appeared as three consecutive grey As.
// Measured on the operator's machine: 87 of 150 desktop entries (58%) carry a
// non-empty icon path, and 0 of 150 rendered one.
//
// LAZY, ONE AT A TIME, AND CACHED. 150 extractions at load would be a worse
// first paint than letter tiles, which is the thing this is supposed to
// improve. The renderer asks per visible row and caches by source string.
//
// A FAILURE IS SILENT. An icon is decoration: it carries no meaning here, so
// its absence is not a could-not-look and must not be reported as one. Every
// failure path returns { success: true, dataUrl: null } and the row keeps its
// letter tile.
const iconCache = new Map();
const ICON_CACHE_MAX = 400;

// DisplayIcon is a path, optionally quoted, optionally with a resource index:
//   "C:\Program Files\App\app.exe",0
//   C:\Program Files\App\app.exe,0
//   C:\Program Files\App\icon.ico
// The index selects which icon inside the binary; getFileIcon does not take
// one, so it is parsed off and discarded rather than passed through as part of
// a path that would then not exist.
function parseDisplayIcon(raw) {
  // lr9d: the rule lives in lib/path-shape.js now. It was written here, in
  // parseLocalDirectory below, and in scanner.ps1, and forgotten in
  // get-locked-paths - where the omission cost 1,270 ms per dead UNC path.
  return pathShape.displayIconPath(raw);
}

ipcMain.handle('get-app-icon', async (event, { source } = {}) => {
  const parsed = parseDisplayIcon(source);
  if (!parsed) return { success: true, dataUrl: null };

  if (iconCache.has(parsed)) return { success: true, dataUrl: iconCache.get(parsed) };

  let dataUrl = null;
  try {
    if (fs.existsSync(parsed)) {
      const img = await app.getFileIcon(parsed, { size: 'normal' });
      if (img && !img.isEmpty()) dataUrl = img.toDataURL();
    }
  } catch {
    dataUrl = null;
  }

  // The null is cached too. A path that cannot produce an icon will not start
  // producing one, and re-asking on every sort and filter would turn a silent
  // miss into repeated disk work.
  if (iconCache.size >= ICON_CACHE_MAX) iconCache.clear();
  iconCache.set(parsed, dataUrl);
  return { success: true, dataUrl };
});

// mp31, the size half. 39 of this machine's 150 desktop entries report no size,
// because Size comes from the registry's EstimatedSize alone - a value the
// installer chose to write or not. 27 of those 39 carry an InstallLocation that
// exists, and measuring it is the only way to answer for them.
//
// IN THE MAIN PROCESS, NOT THE ENGINE. A PowerShell round trip costs about
// 470 ms of spawn and parse before it reads a single byte, and this is asked
// once per row. Measured on the 27 folders here, the walks themselves are 0-34
// ms for 25 of them, 2,843 ms for Office, 4,100 ms in total - so the spawn
// would have been the dominant cost by an order of magnitude.
//
// BUDGETED, because Office exists. A folder that cannot be measured inside the
// budget reports complete:false and the row keeps saying Unknown. mp31's own
// wording: "an unmeasured size must keep saying Unknown rather than showing a
// spinner forever", and a 10-second list is a worse product than a list with 27
// Unknowns in it.
const sizeCache = new Map();
const SIZE_CACHE_MAX = 400;
// Overridable so the suite can drive the budget rather than assert around it.
// A budget that has never been observed to bite is a budget nobody has tested,
// and this one is the whole reason the feature is safe to ship.
//
// 2brn: BEHIND testHatchesAllowed, like the other two hatches in this file.
// These two were read unconditionally, which made them real configuration in a
// packaged build rather than a test hatch - and forty lines up this file says
// the hatches "do not exist at all" in a packaged build. An environment
// variable that sets the walk budget in a shipped app is a way to make the
// main process hang from outside it; !app.isPackaged is what makes the comment
// true.
function sizeHatch(name, fallback) {
  if (!testHatchesAllowed) return fallback;
  const n = Number(process.env[name]);
  return n > 0 ? n : fallback;
}
const SIZE_BUDGET_MS = sizeHatch('VANISH_SIZE_BUDGET_MS', 1500);
const SIZE_MAX_FILES = sizeHatch('VANISH_SIZE_MAX_FILES', 200000);

// The same shape rule scanner.ps1's Get-InstallFolderCreated applies, and for
// the same two reasons: a relative path would resolve against whatever this
// process's cwd happens to be, and a UNC path would put a directory walk on the
// network, which INV-4 forbids. Written without a backslash literal for the
// reason parseDisplayIcon records above it.
function parseLocalDirectory(raw) {
  return pathShape.localRootedPath(raw);
}

// 2brn: THE BOUNDS ARE INSIDE THE LOOP THAT DOES THE WORK.
//
// Both budgets used to be tested once per DIRECTORY, at the top of the while
// loop. The inner `for (const e of entries)` - which does every statSync, i.e.
// all of the work - had no check in it at all. My own comment justified that:
//
//   "Checked per DIRECTORY rather than per file: Date.now() in the inner loop
//    is itself measurable at this file count, and a single directory's entries
//    are bounded by what one readdir returns."
//
// The second clause is simply false. One readdir returns however many entries
// the directory holds, which is not a bound. MEASURED, 60,000 files in one
// directory against a 1,500 ms budget: the walk ran 2,471 ms and returned
// complete = true. It is linear past that, and it is reachable without
// anything pathological - the walk is driven by the IntersectionObserver
// against InstallLocation values from the registry, and package caches,
// %WINDIR%\Installer and flat asset folders routinely hold tens of thousands
// of files in one directory.
//
// THE FIRST CLAUSE WAS ALSO WRONG, and this was worth measuring rather than
// working around. Same walk, same machine, budget set high enough that nothing
// trips it:
//
//   clock read per directory   2587 / 2355 ms        1 read
//   clock read per file        2519 / 2501 ms   60,000 reads
//   clock read every 1024      2689 / 2375 ms       58 reads
//
// The spread between two runs of the SAME shape is larger than the spread
// between shapes. 60,000 Date.now() calls are not measurable next to 60,000
// statSync calls, so the premise that bought the unbounded loop did not hold.
//
// So the check is per FILE rather than behind a counter mask, which the issue
// also offered. It costs nothing measurable and it bounds the overrun by ONE
// statSync instead of by 1,024 of them - and a directory where each stat is
// slow (a compressed volume, a filter driver) is exactly where a coarse
// granularity would hurt most. Measured after the change: 1,501 ms against the
// 1,500 ms budget.
//
// WHY THIS IS NOT A CORRECTNESS DEFECT, stated so nobody "fixes" the totals:
// the bytes returned were right and complete=true was honest - the walk did
// finish. What was wrong is that nothing bounded how long it took, inside a
// synchronous ipcMain.handle in the single-threaded main process, where every
// other IPC call queues behind it including Task Manager's 2-second refresh.
function measureDirectoryBounded(dir, budgetMs, maxFiles) {
  const started = Date.now();
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    // Still checked here too: a tree that is deep rather than wide spends its
    // time in readdirSync, which the inner loop's per-file check never reaches.
    if (Date.now() - started > budgetMs) return { bytes: total, complete: false };
    if (files > maxFiles) return { bytes: total, complete: false };
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // A subtree we cannot read makes the TOTAL wrong, and a wrong total
      // presented as a measurement is the defect mp31 warns about. Say
      // incomplete and let the row stay Unknown.
      return { bytes: total, complete: false };
    }
    for (const e of entries) {
      // 127o: a junction is a second name for a directory. Following one
      // double-counts at best and loops at worst.
      if (e.isSymbolicLink()) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        files += 1;
        // Both bounds, enforced per unit of work rather than per directory.
        if (files > maxFiles) return { bytes: total, complete: false };
        if (Date.now() - started > budgetMs) return { bytes: total, complete: false };
        try {
          total += fs.statSync(full).size;
        } catch {
          return { bytes: total, complete: false };
        }
      }
    }
  }
  return { bytes: total, complete: true };
}

ipcMain.handle('measure-install-size', async (event, { source } = {}) => {
  const parsed = parseLocalDirectory(source);
  if (!parsed) return { success: true, bytes: null, complete: false };

  if (sizeCache.has(parsed)) return Object.assign({ success: true }, sizeCache.get(parsed));

  let result = { bytes: null, complete: false };
  try {
    if (fs.existsSync(parsed) && fs.statSync(parsed).isDirectory()) {
      const measured = measureDirectoryBounded(parsed, SIZE_BUDGET_MS, SIZE_MAX_FILES);
      result = measured.complete
        ? { bytes: measured.bytes, complete: true }
        : { bytes: null, complete: false };
    }
  } catch {
    result = { bytes: null, complete: false };
  }

  // The incomplete answer is cached too. A folder that blew the budget will
  // blow it again, and re-asking on every sort and filter would turn one slow
  // row into a table that is slow forever.
  if (sizeCache.size >= SIZE_CACHE_MAX) sizeCache.clear();
  sizeCache.set(parsed, result);
  return Object.assign({ success: true }, result);
});

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
    const res = await runPowerShell('scan-leftovers', { appName, publisher, installLocation, mode });
    return Object.assign({ success: true }, res);
  } catch (error) {
    console.error('Error scanning leftovers:', error);
    // aeu, and this was live: the catch used to return `{ files: [], registry: [] }`,
    // which the wizard renders as "No leftovers found - this program removed
    // itself cleanly." An engine crash, a timeout or a bad-JSON payload was
    // therefore reported to the user as a clean uninstall, on the most-used
    // path in the application. "Could not look" and "there is nothing there"
    // must not share a representation; lib/findings.js turns the pair below
    // into the `incomplete` terminal state instead of the clean one.
    return { success: false, error: error.message, files: [], registry: [] };
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
    //
    // d6y: req.interactive means run the program's OWN uninstaller UI - some
    // vendor uninstallers offer a keep-my-settings choice, or a
    // reason-for-leaving step that unlocks a refund/licence release, that
    // the resolved silent switch would skip past entirely. baseArgs alone
    // (the registry UninstallString's own arguments, unmodified) is exactly
    // what running it "normally" means - resolved.arguments is what
    // corrections.json/the Rule 15 heuristic added ON TOP to make it silent,
    // so dropping just that one field is the whole change.
    const run = await runPowerShell('run-uninstaller', {
      executable: resolved.executable,
      baseArgs: resolved.baseArgs,
      arguments: req.interactive === true ? '' : resolved.arguments,
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
        // Two different facts sharing similar names, kept distinct here:
        // requestedInteractive is what the caller asked for (d6y - baseArgs
        // alone vs the resolved silent switch); interactive is what
        // MainWindowHandle polling actually DETECTED happened, independent
        // of what was asked for (an uninstaller can ignore a silent switch
        // it does not recognise and show its UI anyway).
        requestedInteractive: req.interactive === true,
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
ipcMain.handle('get-tier', async () => {
  // One-shot: read and clear together, so a mismatch found at boot is shown
  // to the user once, not on every later getTier() poll this session makes.
  const elevationMismatch = elevationMismatchDiagnostic;
  elevationMismatchDiagnostic = null;
  // mp4: whether settings can be SAVED is not implied by the tier. On a machine
  // where Vanish has never run elevated the state directory is unlocked and an
  // unelevated session saves perfectly well; on one where secure-data-dir has
  // run, it cannot. The panel has to be told which, so it can lock the controls
  // up front instead of letting them move and explaining afterwards.
  const stateWrite = store.canWriteState();
  return {
    tier: currentTier,
    isFullMode: isFullMode(),
    offerElevation: elevationOfferPending,
    bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.',
    settingsWritable: stateWrite.writable,
    settingsLockReason: stateWrite.reason,
    elevationMismatch
  };
});

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

// direction: 'elevate' (default) or 'deelevate' - each has its own tiny
// static HTML file with copy for that direction (splash.html never asks
// permission to run as administrator when what is actually happening is
// dropping it, and vice versa).
function showElevationSplash(direction = 'elevate') {
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
    const file = direction === 'deelevate' ? 'splash-deelevate.html' : 'splash.html';
    splashWindow.loadFile(path.join(__dirname, file));
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
    if (res && res.success) {
      // Diagnostic marker (see store.js's elevationAttemptPath comment) -
      // written here, on every path that reports a successful launch
      // attempt, not only right before the caller decides to quit. Read and
      // always deleted on the NEXT boot's bootstrap check below.
      try {
        store.writeJsonAtomic(store.elevationAttemptPath(), {
          attemptedAt: new Date().toISOString(),
          trigger,
          direction: 'elevate'
        });
      } catch {
        // Diagnostic-only; never let this block a real elevation attempt.
      }
      return { success: true };
    }
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
    showElevationSplash('elevate');
    setTimeout(() => app.quit(), 400);
  }
  return res;
});

// Operator report (live sandbox testing, 2026-08-10): once the "Always start
// with administrator rights" setting elevated a session, there was no way
// back to Audit Mode short of fully closing the app and finding the exe
// again - turning the toggle off only ever changed what the NEXT
// independent launch does. A bare child process launched from an elevated
// parent inherits that elevation, so this cannot reuse relaunch-elevated's
// Start-Process path; see scanner.ps1's relaunch-deelevated case for the
// actual mechanism (Shell.Application, not -Verb RunAs).
async function attemptDeelevatedRelaunch(trigger) {
  if (!isFullMode()) return { success: true, alreadyUnelevated: true };

  const argList = app.isPackaged ? [] : [app.getAppPath()];
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

  try {
    const res = await runPowerShell('relaunch-deelevated', { exePath, argList });

    // 1dq: record the INTENT before quitting, so the next launch can tell
    // whether it actually happened. Written only on a reported success -
    // a failure is already visible to the user right now and does not need
    // a next-boot diagnostic to explain it.
    if (res && res.success === true) {
      try {
        store.writeJsonAtomic(store.elevationAttemptPath(), {
          attemptedAt: new Date().toISOString(),
          trigger: 'user-click',
          direction: 'deelevate',
          // 9vp: WHICH mechanism claimed the success. There are two now, and
          // a mismatch record that cannot say which one produced it sends the
          // next session back to guessing.
          method: res.method || null
        });
      } catch {
        // Diagnostic-only; never block a real de-elevation.
      }
    }
    store.appendOplog({
      action: 'relaunch-deelevated',
      tier: currentTier,
      items: {},
      outcome: res && res.success ? 'success' : 'error',
      meta: {
        trigger,
        // The 2026-08-13 record said only "success" and left five sessions
        // with nothing to work from. Say which mechanism ran, and what the
        // evidence for it was.
        method: (res && res.method) || null,
        newPid: (res && res.newPid) || null,
        taskError: (res && res.taskError) || null,
        error: res && res.error
      }
    });
    if (res && res.success) return { success: true, method: res.method, newPid: res.newPid };
    return { success: false, error: (res && res.error) || 'Could not restart without administrator rights.' };
  } catch (error) {
    // runPowerShell() itself threw - the engine couldn't be reached, not a
    // failure of the de-elevated launch itself.
    return { success: false, error: error.message };
  }
}

ipcMain.handle('relaunch-deelevated', async () => {
  const res = await attemptDeelevatedRelaunch('user-click');
  if (res.success && !res.alreadyUnelevated) {
    showElevationSplash('deelevate');
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

// mp4: this used to return the settings object and nothing else, so a write that
// threw EPERM rejected the whole call - and the renderer, which had no catch,
// silently skipped its own "Setting saved" toast. The checkbox stayed where the
// click put it while the setting did not move. A control that appears to work
// and did nothing is the defect class this application exists to prevent, and it
// was sitting in the settings panel.
//
// The reply now always says WHICH settings are in effect and whether the change
// was actually written. It never rejects: a rejection is what produced the
// silence in the first place.
// wy7a: the settings that are destructive BY DEFERRAL.
//
// vault-delete is fullModeOnly. autoPurgeSweep is not gated by anything,
// because it does not need to be - it runs at every elevated start, reads
// autoPurgeEnabled and autoPurgeRetentionDays off disk, and deletes forever
// every entry older than the cutoff. With retention 0 the cutoff is now, and
// "every entry older than now" is the whole vault.
//
// So an Audit Mode renderer - the tier in which every destructive channel is
// supposed to be refused - could call setSettings({ autoPurgeEnabled: true,
// autoPurgeRetentionDays: 0 }) and the operator's entire quarantine would be
// permanently deleted at their next Full Mode start, with no prompt. The gate
// on vault-delete is not defeated, it is SIDESTEPPED: the destructive act is
// scheduled from the tier that cannot perform it.
//
// GATING THE TWO FIELDS RATHER THAN THE WHOLE CHANNEL. Operator decision
// 2026-09-05. Making all of set-settings fullModeOnly is a simpler rule with
// nothing to keep a list of, but it also stops an Audit Mode user changing
// their scan depth or their theme - and Audit Mode is the tier we want people
// to spend time in. Everything else in this patch still saves unelevated.
//
// Named explicitly rather than derived, because a rule like "anything matching
// /purge/" silently stops covering a field somebody renames.
const ELEVATED_ONLY_SETTINGS = ['autoPurgeEnabled', 'autoPurgeRetentionDays'];

ipcMain.handle('set-settings', async (event, patch) => {
  let saved;
  let error = null;

  const incoming = patch && typeof patch === 'object' ? patch : {};
  const refusedKeys = isFullMode()
    ? []
    : ELEVATED_ONLY_SETTINGS.filter((k) => Object.prototype.hasOwnProperty.call(incoming, k));

  if (refusedKeys.length > 0) {
    // The rest of the patch is applied. Refusing the whole save because one
    // field was out of reach would lose changes the user is entitled to make,
    // and would teach them that Audit Mode cannot save settings at all.
    for (const k of refusedKeys) delete incoming[k];
    store.appendOplog({
      action: 'settings-refused',
      tier: currentTier,
      items: {},
      outcome: 'refused',
      meta: { refusedKeys }
    });
  }

  try {
    saved = store.writeSettings(incoming);
  } catch (err) {
    error = err;
    // What is ON DISK, which is what the app is actually running with. The
    // renderer redraws from this, so the control snaps back to the truth
    // instead of sitting where the click left it.
    saved = store.readSettings();
  }

  store.appendOplog({
    action: 'settings-change',
    tier: currentTier,
    items: {},
    outcome: error ? 'error' : 'success',
    meta: { patch: incoming, refusedKeys, error: error ? error.message : undefined }
  });

  const writable = store.canWriteState();
  const refusalReason = refusedKeys.length > 0
    ? 'Automatic purge settings can only be changed in Full Mode, because they schedule a permanent deletion that runs at the next elevated start. Everything else was saved.'
    : null;
  return {
    settings: saved,
    saved: !error,
    // Named, so the renderer can say which control snapped back rather than
    // leaving the user to notice.
    refusedKeys,
    reason: error
      ? (writable.writable ? error.message : `${writable.reason} Restart as administrator to change it.`)
      : refusalReason
  };
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

  // z71u: readManifest now THROWS when the manifest exists and cannot be read,
  // which is correct everywhere that is about to write it back. This caller
  // only wants a count for the About panel, and taking the whole panel down
  // over it would hide the app's own data-directory paths at exactly the moment
  // someone needs them to go and look. Count unknown, panel intact.
  let manifest = { entries: [] };
  let manifestError = null;
  try {
    manifest = store.readManifest();
  } catch (err) {
    manifestError = err.message;
  }
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
    // Null unless the manifest could not be read. A caller that shows the count
    // has to be able to tell "none" from "could not count" - the count above is
    // 0 in both cases, which is the defect z71u was filed on, one panel over.
    manifestError,
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

// Operator: "i need amd and nvidia logos for the respective gpu... phys_N is
// friction since a card may be turned off by the OEM app... remember those
// ids permanently." Right on all counts. First cut used app.getGPUInfo()
// correlated to phys_N by array order - no LUID exposed, so no proof it
// lined up, and it would have silently broken the moment the discrete GPU's
// enumerated position shifted (exactly the hibernation case named). Fixed
// properly: Electron's own chrome://gpu diagnostics page lists every
// adapter's VENDOR, DEVICE, name and LUID together in one table - loaded
// once in a hidden window and parsed. Verified live: the LUID reported here
// for the AMD adapter (0, 62611) is bit-for-bit the same LUID
// Get-GpuUsageByProcess reads from the perf counter for that same physical
// card. LUID, not phys_N or array position, is the actual stable identity -
// matching on it means a sleeping/waking discrete GPU is still labelled
// correctly whenever it reappears, with nothing to re-guess.
//
// Cached for the life of the process (module-level, not re-queried per
// sample) - this is real, per-boot hardware inventory, not something that
// changes while Vanish is running. Lazy: nothing calls this until Task
// Manager's GPU sampling actually starts, so it never touches app startup
// time (~3s, live-measured, would undo the whole point of the same
// session's latency work if it ran eagerly).
let gpuVendorCache = null;

// The page's content lives inside a Shadow DOM custom element (<info-view>),
// and plain innerText/outerHTML do not see inside a shadow root - so this
// walks it explicitly. Text nodes come back as separate entries in DOM order;
// each GPU's full descriptor (including *ACTIVE* when present) stays together
// in one entry because it is one table cell's content.
const GPU_PAGE_TEXT = `
  (function walk(node, out) {
    if (node.shadowRoot) walk(node.shadowRoot, out);
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) out.push(node.textContent.trim());
    for (const child of node.childNodes || []) walk(child, out);
    return out;
  })(document.documentElement, []).join('\\n');
`;

async function fetchGpuVendorsFromChromeInternals() {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  try {
    await win.loadURL('chrome://gpu');

    // chrome://gpu populates ASYNCHRONOUSLY after load. Reading it the
    // instant loadURL resolves returns the page's placeholder - measured,
    // verbatim: "VENDOR= 0x0000, DEVICE=0x0000, LUID={0,0}". That parses to
    // nothing, so the vendor list came back empty, every adapter lost its
    // name, and every GPU icon silently fell back to the generic chip.
    //
    // Poll for real content rather than sleeping a fixed amount: the wait is
    // as short as the machine allows, and a slow GPU process gets the time it
    // needs instead of a guess that is too short on exactly the hardware that
    // matters.
    const readGpuText = () => win.webContents.executeJavaScript(GPU_PAGE_TEXT);
    let text = await readGpuText();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !/VENDOR=\s*0x(?!0000\b)[0-9a-fA-F]+/.test(text)) {
      await new Promise((r) => setTimeout(r, 250));
      text = await readGpuText();
    }
    const results = [];
    for (const line of text.split('\n')) {
      if (!line.includes('VENDOR=')) continue;
      const m = line.match(/VENDOR=\s*0x([0-9a-fA-F]+),\s*DEVICE=0x([0-9a-fA-F]+)\s*\[([^\]]*)\].*?LUID=\{(-?\d+),\s*(-?\d+)\}/);
      if (!m) continue;
      const vendorId = parseInt(m[1], 16);
      // The Microsoft Basic Render Driver used to be dropped here as "not a
      // real GPU". It is not a real GPU, and it IS a real adapter: the GPU
      // Engine counters report work against its LUID, so dropping it from the
      // name map did not hide it - it just left it anonymous wherever it
      // appeared. Kept, with vendor null so it gets the neutral chip rather
      // than a card maker's logo.
      results.push({
        luidHigh: parseInt(m[4], 10),
        luidLow: parseInt(m[5], 10),
        name: m[3],
        vendor: vendorId === 0x1002 ? 'amd' : vendorId === 0x10de ? 'nvidia' : null,
        active: line.includes('*ACTIVE*')
      });
    }
    return results;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// ddx: read-only, so it is available in BOTH tiers on purpose. Audit Mode is
// the tier a cautious user sits in, and "what on this machine is reachable
// from the network" is exactly the question they are in Audit Mode to ask.
// Gating it behind elevation would hide the finding from the people most
// likely to want it.
// INV-4 exception two. The consent is checked HERE as well as in the
// renderer, so a bug in the UI cannot put traffic on the wire that the user
// never agreed to. The renderer gate is for explaining; this one is the lock.
ipcMain.handle('network-speedtest', async () => {
  const settings = store.readSettings();
  if (settings.speedTestConsentGiven !== true) {
    return {
      success: false,
      error: 'The speed test has not been agreed to on this machine, so nothing was sent.',
    };
  }
  try {
    return await runPowerShell('network-speedtest', {});
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ag0: read-only, and reachable in Audit Mode on purpose. 'what did Windows
// install and when' is an audit question; gating it behind elevation would
// make the honest answer available only to users who had already granted the
// app more power than the answer needs. The DISM half genuinely does require
// Full Mode and the payload says so rather than quietly returning a shorter list.
ipcMain.handle('get-windows-updates', async () => {
  try {
    return await runPowerShell('get-windows-updates', {});
  } catch (error) {
    return { success: false, error: error.message, updates: [] };
  }
});

ipcMain.handle('get-listeners', async () => {
  try {
    return await runPowerShell('get-listeners', {});
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-gpu-vendors', async () => {
  if (gpuVendorCache !== null) return gpuVendorCache;
  try {
    gpuVendorCache = await fetchGpuVendorsFromChromeInternals();
  } catch {
    // Leave null uncached on failure - a transient GPU-process hiccup should
    // get another real attempt next time, not a permanently empty result.
    return [];
  }
  return gpuVendorCache;
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
//
// 7sl: now used by the definitions cleaner too, which wants a FOLDER and a
// title that says so. A dialog whose caption still reads 'to check for
// locks' while the user picks cleaning rules is the same class of defect as
// a count that is not about what it claims - so the caller names it, and the
// old call site keeps its wording by supplying nothing.
ipcMain.handle('browse-for-path', async (event, options) => {
  const opts = options || {};
  const result = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || 'Select a file or folder to check for locks',
    properties: opts.directoryOnly === true ? ['openDirectory'] : ['openFile', 'openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// h55: paths Vanish itself failed to remove because something was holding
// them, so the Unlocker can be opened by picking rather than by hunting.
//
// PRUNED HERE, ON READ, rather than maintained. A path that no longer exists
// was removed some other way and is not a problem any more; keeping it would
// turn a list of live problems into a list the operator has to tidy. That is
// the difference between this and every "recent items" list that rots.
//
// The existence check is deliberately the only pruning done here. "Nothing is
// holding it any more" is a much more expensive question and it is asked at
// the moment the user opens the item, by list-lockers, which is the answer
// they actually came for.
ipcMain.handle('get-locked-paths', async () => {
  try {
    const rows = store.lockedPaths(50);
    const live = rows.filter((r) => {
      // lr9d: SHAPE FIRST, and this ordering is the whole fix. existsSync on a
      // dead UNC path costs 1,270 ms - measured - and this ran once per
      // remembered path, up to fifty, inside a synchronous main-process
      // handler. A minute of frozen Unlocker, on the list most likely to
      // contain a share that has since gone away.
      //
      // A path we cannot shape-check is dropped rather than probed, and that
      // is the right outcome on its own terms: list-lockers could not answer
      // about it either, so offering it would be offering a dead end.
      const shaped = pathShape.localRootedPath(r.path);
      if (!shaped) return false;
      // Now it is a local rooted path and existsSync is cheap and honest.
      // The catch that used to sit here claimed to keep unreadable paths -
      // fs.existsSync never throws, it is accessSync in a try/catch returning
      // false, so that branch could not run and the policy it described was
      // never implemented.
      return fs.existsSync(shaped);
    });
    return { success: true, items: live, dropped: rows.length - live.length };
  } catch (error) {
    return { success: false, error: error.message, items: [], dropped: 0 };
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

// qkgu: these two used to CATCH and return a manufactured negative -
// { items: [], total: 0, orphans: 0, error } and { groups: [], hasRedundancy:
// false, error }. Both are well-shaped successes, and returning one means the
// promise RESOLVES, which is the problem: renderer/audit.js already has the
// right three-state handling for these sections, and it hangs off
// .catch(err => section.fail(...)). A resolution never reaches it. So draw()
// ran on the fabricated zeros, auditReportWork(0) counted the section as
// checked-and-clean, and the Health Advisor's verdict included a check that
// never happened.
//
// The fix is to delete the fabrication, not to add a guard downstream. The
// section runner, auditReportBlind and the "could not read" row were all
// already written and correct; they were simply never reached.
ipcMain.handle('get-startup-items', async () => {
  return runPowerShell('get-startup-items');
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
// wy7a: the gateway addresses this process has SEEN, from its own engine call.
//
// The ping allowlist below needs to know what this machine's router is, and it
// must not learn that from the renderer - a value the caller supplies is not a
// constraint on the caller. This is read out of the result of the same
// get-network-activity call the panel already makes before the ping tile can
// exist, so it costs nothing and comes from the engine rather than the page.
let observedGateways = [];

ipcMain.handle('get-network-activity', async (event, params) => {
  try {
    const result = await runPowerShell('get-network-activity', params || {});
    if (result && Array.isArray(result.adapters)) {
      observedGateways = result.adapters
        .map((a) => (a && typeof a.gatewayAddress === 'string' ? a.gatewayAddress.trim() : ''))
        .filter(Boolean);
    }
    return result;
  } catch (error) {
    console.error('Error reading network activity:', error);
    return { success: false, verdict: 'unreadable', adapters: [], processes: [], error: error.message };
  }
});

// kp0: the app's one deliberate exception to "zero network I/O" - a single
// ICMP echo, only on an explicit user tap. Available in Audit Mode like the
// rest of this panel: it probes, it does not remove or write anything here.
//
// wy7a: BOTH OF ITS CONSTRAINTS USED TO LIVE IN THE RENDERER, and the comment
// that stood here said so approvingly - "enforced in the renderer". The
// destination was passed through to Test-Connection with no allowlist, and
// pingConsentGiven was read only in renderer/audit.js. So a compromised
// renderer could make the app send packets to a host of its choosing, without
// consent, from a product whose README's first promise is "No telemetry, no
// network calls."
//
// INV-2 is explicit that this is the wrong side of the line: "the renderer's
// disabled states are a convenience; THIS is the boundary." The renderer's
// consent dialog is still the right place to ASK - it is careful, it names
// what is sent and where - but it cannot be the thing that enforces the
// answer.
//
// Operator decision 2026-09-05: consent moves here, and the destination is
// chosen from a fixed set rather than named. Two public resolvers and this
// machine's own router - the router being the only one that matters for "is it
// my connection or the app", and the two resolvers for "is it my router". A
// destination the caller can type is not a constraint on the caller.
const PUBLIC_PING_TARGETS = ['1.1.1.1', '8.8.8.8'];

ipcMain.handle('network-ping', async (event, params) => {
  const settings = store.readSettings();
  if (settings.pingConsentGiven !== true) {
    return {
      success: false,
      error: 'Vanish has not been given permission to send network traffic. Nothing was sent.'
    };
  }

  const wanted = String((params && params.destination) || '').trim();
  const allowed = PUBLIC_PING_TARGETS.concat(observedGateways);
  const match = allowed.find((a) => a.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    return {
      success: false,
      error: `Vanish will only ping this PC's own router or a public resolver it knows (${PUBLIC_PING_TARGETS.join(', ')}). Nothing was sent.`
    };
  }

  try {
    // The matched value, not the caller's string, and nothing else from the
    // payload travels with it.
    return await runPowerShell('network-ping', { destination: match });
  } catch (error) {
    console.error('Error pinging:', error);
    return { success: false, error: error.message };
  }
});

// 5p5: the finder half of the seam reaches the renderer here. Note what this
// handler does NOT do on failure - it does not return an empty result set.
// aeu's whole defect class is a failed look being reported as a clean one,
// and lib/findings.js decides UI_FAILED from success:false. Returning
// { results: [] } here would be decided as 'nothing found' and would tell the
// user their machine is clean because the scan crashed.
ipcMain.handle('list-hygiene-finders', async () => {
  try {
    return await runPowerShell('finder-probe', { mode: 'list' });
  } catch (error) {
    console.error('Could not list hygiene finders:', error);
    return { success: false, error: error.message, finders: [] };
  }
});

ipcMain.handle('run-hygiene-scan', async (event, params) => {
  try {
    return await runPowerShell('hygiene-scan', params || {});
  } catch (error) {
    console.error('Hygiene scan failed:', error);
    return { success: false, error: error.message, results: [] };
  }
});

// The worse of the two, because `hasRedundancy: false` is not an empty
// container - it is an assertion of a negative fact, made by a catch block
// that knows nothing about the machine.
ipcMain.handle('get-software-redundancy', async () => {
  return runPowerShell('get-software-redundancy');
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

// zrw: install snapshot. Two readings and a diff, all read-only, so this is
// reachable in Audit Mode on purpose - "what did that installer change" is an
// audit question, and gating it behind elevation would make the honest answer
// available only to users who had already granted the app more power.
//
// The "before" snapshot is held in the main process rather than the renderer
// so a renderer reload mid-install cannot silently lose it and leave the user
// diffing against nothing.
let pendingInstallSnapshot = null;

ipcMain.handle('snapshot-begin', async () => {
  try {
    const res = await runPowerShell('install-snapshot', {});
    if (!res || res.success !== true) {
      return { success: false, error: (res && res.error) || 'The snapshot could not be taken.' };
    }
    pendingInstallSnapshot = res;
    store.appendOplog({
      action: 'install-snapshot-begin',
      tier: currentTier,
      items: {},
      outcome: 'success',
      meta: {
        run: (res.run || []).length,
        dirs: (res.dirs || []).length,
        uninstall: (res.uninstall || []).length
      }
    });
    return { success: true, takenAt: res.takenAt };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('snapshot-finish', async () => {
  if (!pendingInstallSnapshot) {
    return { success: false, error: 'No "before" snapshot is waiting. Start watching first.' };
  }
  try {
    const after = await runPowerShell('install-snapshot', {});
    if (!after || after.success !== true) {
      return { success: false, error: (after && after.error) || 'The second snapshot could not be taken.' };
    }
    const diff = snapshot.diffSnapshots(pendingInstallSnapshot, after);
    const summary = snapshot.summarise(diff);
    // Cleared only on success: a failed second reading must leave the "before"
    // in place so the user can retry rather than lose the whole session.
    pendingInstallSnapshot = null;

    // Recorded because this is ground truth for bu2's size attribution - a
    // path in here belongs to what was installed, as fact, not heuristic.
    //
    // Resolving the PROGRAM here, at the only moment it is knowable, is what
    // makes that ground truth usable. bu2 may only call a directory "orphaned"
    // when it knows whose it was and that they are gone; a recorded path with
    // no owner stays unattributed forever. The added uninstall keys name the
    // program, so match them against the live list while it is still fresh.
    let installedProgram = null;
    try {
      const addedKeys = (diff.categories.uninstall && diff.categories.uninstall.added) || [];
      if (addedKeys.length > 0) {
        const apps = await runPowerShell('list-desktop', {});
        const wanted = new Set(addedKeys.map(lastKeySegment).filter(Boolean));
        const match = (Array.isArray(apps) ? apps : []).find(
          (a) => a && wanted.has(lastKeySegment(a.registryPath))
        );
        if (match && match.name) installedProgram = String(match.name);
      }
    } catch {
      // Best effort. A failure here costs the attribution label, not the diff
      // the user asked for, so it must not surface as an error.
    }

    store.appendOplog({
      action: 'install-snapshot-diff',
      tier: currentTier,
      items: { paths: snapshot.attributionPaths(diff) },
      outcome: diff.changed ? 'success' : 'no-change',
      meta: { summary, totalAdded: diff.totalAdded, totalRemoved: diff.totalRemoved, program: installedProgram }
    });
    return { success: true, diff, summary };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Registry key paths arrive in two shapes depending on who read them:
// "HKEY_LOCAL_MACHINE\\Software\\...\\Uninstall\\{guid}" from Get-ChildItem and
// "HKLM:\\Software\\...\\Uninstall\\{guid}" from the app enumeration. The final
// segment - the product code or program key name - is the same either way and
// is the only part worth comparing.
function lastKeySegment(value) {
  if (!value) return '';
  const parts = String(value).split('\\').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}


// 0bi: the attribution join. Read-only in both tiers, and deliberately so -
// "which program is this" is an audit question, and refusing to answer it
// unelevated would make the panel useless on exactly the machines where
// somebody is trying to work out what is running.
//
// Four engine reads, in parallel, joined in lib/process-attribution.js. The
// join is the whole feature: Task Manager and System Informer both answer
// "what is using CPU and RAM" better than we would, and neither has an
// uninstall database, a startup inventory or a listener map to answer it
// WITH. None of these four reads is new - all four already ship.
ipcMain.handle('process-attribution-scan', async (event, params) => {
  try {
    const sampleMs = params && params.sampleMs ? params.sampleMs : 500;

    // Promise.all rather than four awaits: they are independent reads and the
    // process sample alone sleeps for its own window. Serialised, this panel
    // took the sum of four PowerShell starts to say anything at all.
    const [procs, apps, uwp, startup, listeners] = await Promise.all([
      runPowerShell('list-processes', { sampleMs }),
      runPowerShell('list-desktop', {}).catch(() => []),
      runPowerShell('list-uwp', {}).catch(() => []),
      runPowerShell('get-startup-items', {}).catch(() => ({ items: [] })),
      runPowerShell('get-listeners', {}).catch(() => ({ programs: [] }))
    ]);

    // Store apps go into the SAME list, and this is not a convenience - it is
    // the fix for a real misattribution. A Store package installs into
    // C:\Program Files\WindowsApps, which bu2's classifier calls a system
    // path (correctly, for bu2: nobody should be offered a delete button for
    // WindowsApps). Applied to a running process that reads as "Part of
    // Windows itself", which is wrong and visibly so - twelve Claude
    // processes on the development machine were labelled as Windows. Their
    // package records carry the exact install location, so feeding them in
    // attributes them properly and beats the system-path rule on the way.
    const installedApps = (Array.isArray(apps) ? apps : []).concat(Array.isArray(uwp) ? uwp : []);

    if (!procs || procs.success !== true) {
      return { success: false, error: (procs && procs.error) || 'The process list could not be read.' };
    }

    // Each of the three JOINED sources is optional and its absence is
    // reported rather than hidden. A machine where the listener read failed
    // is not a machine with no listeners, and a panel that quietly showed no
    // ports would be making the stronger claim of the two.
    const missing = [];
    if (installedApps.length === 0) missing.push('the installed-programs list');
    if (!startup || !Array.isArray(startup.items)) missing.push('the startup inventory');
    if (!listeners || !Array.isArray(listeners.programs)) missing.push('the listener map');

    const joined = processAttribution.attributeProcesses({
      processes: Array.isArray(procs.items) ? procs.items : [],
      installedApps,
      recordedInstalls: store.recordedInstalls(),
      startupItems: (startup && startup.items) || [],
      listeners: (listeners && listeners.programs) || []
    });

    return {
      success: true,
      results: joined.results,
      counts: joined.counts,
      sampledMs: procs.sampledMs,
      recordedInstallCount: store.recordedInstalls().length,
      note: missing.length
        ? `Some of the join could not be read on this machine (${missing.join(', ')}), so those columns are blank rather than empty.`
        : null
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
// bu2: the attribution scan.
//
// Three cheap inputs and one expensive one, in that order on purpose. The
// directory list, the installed-programs map and the recorded install deltas
// are all milliseconds; measuring directories is the only slow part, so it
// runs LAST and only against what classification could not explain. On a
// machine with ~230 top-level program directories that is typically a handful,
// which is the difference between a scan that takes seconds and one that takes
// minutes.
ipcMain.handle('attribution-scan', async () => {
  try {
    const [snap, apps] = await Promise.all([
      runPowerShell('install-snapshot', {}),
      runPowerShell('list-desktop', {})
    ]);
    if (!snap || snap.success !== true) {
      return { success: false, error: (snap && snap.error) || 'Could not read the program folders.' };
    }

    const attributed = attribution.attribute({
      dirs: Array.isArray(snap.dirs) ? snap.dirs : [],
      installedApps: Array.isArray(apps) ? apps : [],
      recordedInstalls: store.recordedInstalls()
    });

    const candidates = attribution.sizeCandidates(attributed);
    let sizes = [];
    if (candidates.length > 0) {
      const measured = await runPowerShell('measure-paths', { paths: candidates });
      sizes = (measured && Array.isArray(measured.results)) ? measured.results : [];
    }

    const merged = attribution.withSizes(attributed, sizes);
    store.appendOplog({
      action: 'attribution-scan',
      tier: currentTier,
      items: {},
      outcome: 'success',
      meta: {
        dirs: attributed.results.length,
        measured: candidates.length,
        orphaned: merged.counts.orphaned,
        unattributed: merged.counts.unattributed,
        reclaimableBytes: merged.reclaimableBytes
      }
    });

    return {
      success: true,
      results: merged.results,
      counts: merged.counts,
      reclaimableBytes: merged.reclaimableBytes,
      measuredCount: candidates.length,
      // Stated so the UI never has to imply the scan knew more than it did.
      recordedInstallCount: store.recordedInstalls().length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('snapshot-state', async () => ({
  watching: pendingInstallSnapshot !== null,
  takenAt: pendingInstallSnapshot ? pendingInstallSnapshot.takenAt : null
}));

ipcMain.handle('snapshot-cancel', async () => {
  pendingInstallSnapshot = null;
  return { success: true };
});

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
    //
    // 7sl: a finding may carry MANY paths rather than one. A CleanerML option
    // is a single thing the user consents to ('Vivaldi - Cache') and can be a
    // hundred files, so the option is one row and one vault entry, and undoing
    // it puts back everything it took. 'path' is still the row's headline
    // path; 'paths' is the set that actually moves, and it is the set the
    // engine already pruned so no parent directory carries its own children
    // into the vault twice.
    const files = items
      .filter((i) => i.kind === 'file' && i.removable !== false)
      .flatMap((i) => (Array.isArray(i.paths) && i.paths.length ? i.paths : i.path ? [i.path] : []))
      .map((path) => ({ path }));

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

    // The audit trail records what the ENGINE did, not what the UI asked for.
    // 'removed: scopeItems.length' was the requested count written down as
    // though it were the outcome, so an engine that removed a different number
    // of entries - which it could, and did - left an oplog line that agreed
    // with the request and disagreed with the registry.
    store.appendOplog({
      action: 'path-clean',
      tier: currentTier,
      items: {
        scope,
        requested: scopeItems.length,
        removed: written && typeof written.removedCount === 'number' ? written.removedCount : 0,
        notFound: (written && written.notFound) || []
      },
      outcome: written && written.success ? 'success' : 'error',
      meta: { entryId: quarantined.entryId, error: written && written.error }
    });

    results.push({
      scope,
      success: written && written.success === true,
      requestedCount: scopeItems.length,
      removedCount: written && written.removedCount,
      notFound: (written && written.notFound) || [],
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
    'uwp-leftovers': 'Left-over Store app data',
    'installer-cache': 'Left-over Windows installers',
    'firewall-rules': 'Firewall rule sweep',
    'dead-references': 'Dead reference sweep',
    definitions: 'Cleaning definitions (CleanerML)'
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

// t4m9: the renderer cannot name a destination, only choose one.
//
// This channel used to take a URL and hand it straight to shell.openExternal
// with no check of scheme, host or path. On Windows that is ShellExecuteW in
// the MAIN process, which in Full Mode is elevated - so one call from a
// compromised renderer launched a process at High integrity, past every
// fullModeOnly gate, past the whole SEC-1 trust pipeline (user-writable check,
// HKCU check, LOLBin block, the acknowledged:true requirement) and past the
// oplog, which an ipcMain.on channel never reaches at all. Every URI scheme
// registered on the machine was in range; the ms-msdt:/Follina shape is
// exactly this.
//
// NOT FIXED BY VALIDATING THE URL. A scheme allowlist is a rule that has to
// stay correct forever against every handler Windows and third-party
// installers register, and it invites the next caller to pass something
// "obviously safe". The app has exactly ONE caller of this channel
// (renderer/updates.js) passing exactly ONE constant, so the argument is not
// needed: the renderer picks a KEY, and the destinations live here, in the
// process that is trusted with them. There is no string a renderer can send
// that reaches shell.openExternal, which makes the defect unrepresentable
// rather than guarded - the same principle the finder contract uses one layer
// down.
//
// Null-prototype on purpose: a plain object literal would answer to
// '__proto__' and 'constructor' as if they were entries.
const KNOWN_LINKS = Object.assign(Object.create(null), {
  'windows-update-history': 'ms-settings:windowsupdate-history'
});

ipcMain.on('open-known-link', (event, key) => {
  const target = typeof key === 'string' ? KNOWN_LINKS[key] : undefined;
  if (typeof target !== 'string') {
    // Nothing to tell the user: a renderer asking for a link that does not
    // exist is a bug in this repository, not something they did.
    console.error(`open-known-link: refused unknown key ${JSON.stringify(key)}`);
    return;
  }
  shell.openExternal(target);
});
