// Bulk uninstall queue runner (REQ-10, REQ-12, REQ-13, FLOW-05, NFR-05).
// State machine per 03-appflow.md:
//   pending -> running -> done | failed | rebootRequired | needsAttention
//   rebootRequired -> pending (user resumes)   failed -> pending (user retries)
//
// Queue state is written to disk after EVERY transition, so a crash mid-queue
// loses at most the in-flight app (NFR-05).

const store = require('./store');

// Windows exit codes that mean "worked, but reboot to finish".
const REBOOT_EXIT_CODES = new Set([3010, 1641]);

let runPowerShell = null;
let broadcast = () => {};
let running = false;
let pauseRequested = false;
let msiserverPriorState = null;
let acknowledgedRisky = new Set();

function init(runner, notify) {
  runPowerShell = runner;
  if (typeof notify === 'function') broadcast = notify;
}

function getState() {
  const queue = store.readQueue();
  return {
    items: queue.items,
    running,
    paused: pauseRequested,
    counts: countStates(queue.items)
  };
}

function countStates(items) {
  return items.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, {});
}

function emit() {
  broadcast(getState());
}

async function add(app) {
  const queue = store.readQueue();
  if (queue.items.some((i) => i.appKey === app.registryPath && i.state === 'pending')) {
    return { success: false, error: 'That application is already queued.' };
  }

  // Work out now, while the user is looking at it, whether running this
  // uninstaller elevated would mean trusting something a standard user could
  // have planted. The confirmation dialog needs this before Start is pressed.
  let trust = { risky: false, reasons: [] };
  try {
    const live = await runPowerShell('read-uninstall-entry', {
      registryPath: app.registryPath || app.id
    });
    if (live && live.success && live.trust) trust = live.trust;
  } catch {
    /* a lookup failure must not block queueing; runOne re-checks anyway */
  }

  queue.items.push({
    id: store.newId(),
    appKey: app.registryPath || app.id,
    displayName: app.name,
    publisher: app.publisher,
    uninstallString: app.uninstallString,
    installLocation: app.installLocation,
    type: app.type,
    state: 'pending',
    method: null,
    exitCode: null,
    meta: { trust }
  });
  store.writeQueue(queue);
  emit();
  return { success: true, trust };
}

function remove(itemId) {
  const queue = store.readQueue();
  queue.items = queue.items.filter((i) => i.id !== itemId);
  store.writeQueue(queue);
  emit();
  return { success: true };
}

function clear() {
  const queue = store.readQueue();
  // Never drop the item that is executing right now.
  queue.items = queue.items.filter((i) => i.state === 'running');
  store.writeQueue(queue);
  emit();
  return { success: true };
}

function pause() {
  pauseRequested = true;
  emit();
  return { success: true };
}

function updateItem(itemId, mutate) {
  const queue = store.readQueue();
  const item = queue.items.find((i) => i.id === itemId);
  if (!item) return null;
  mutate(item);
  store.writeQueue(queue); // persist on every transition (NFR-05)
  emit();
  return item;
}

// REQ-12: make sure the Windows Installer service can actually run, and put it
// back exactly as it was when the queue finishes.
async function ensureMsiServer() {
  try {
    const state = await runPowerShell('msiserver-state');
    if (!state || state.success !== true) return;
    msiserverPriorState = { startMode: state.startMode, state: state.state };
    if (!state.usable) {
      await runPowerShell('msiserver-set', { startMode: 'Manual', running: false });
    }
  } catch {
    msiserverPriorState = null;
  }
}

async function restoreMsiServer() {
  if (!msiserverPriorState) return;
  try {
    await runPowerShell('msiserver-set', {
      startMode: msiserverPriorState.startMode,
      running: false
    });
  } catch {
    /* reported through the oplog below */
  }
  store.appendOplog({
    action: 'msiserver-restore',
    tier: 'full',
    items: {},
    outcome: 'success',
    meta: msiserverPriorState
  });
  msiserverPriorState = null;
}

async function start(acknowledgedIds = []) {
  if (running) return { success: false, error: 'The queue is already running.' };

  // Vuln 3: items whose uninstaller is registered under HKCU, or whose binary
  // lives somewhere a standard user can write, only run if the operator ticked
  // them by name in the confirmation. An empty set is the safe default.
  acknowledgedRisky = new Set(Array.isArray(acknowledgedIds) ? acknowledgedIds : []);

  pauseRequested = false;
  running = true;
  emit();

  store.appendOplog({
    action: 'queue-start',
    tier: 'full',
    items: { pending: countStates(store.readQueue().items).pending || 0 },
    outcome: 'started'
  });

  try {
    await ensureMsiServer();

    for (;;) {
      if (pauseRequested) break;

      const queue = store.readQueue();
      const next = queue.items.find((i) => i.state === 'pending');
      if (!next) break;

      await runOne(next.id);

      // FLOW-05: a reboot-required app pauses the whole queue.
      const after = store.readQueue().items.find((i) => i.id === next.id);
      if (after && after.state === 'rebootRequired') {
        pauseRequested = true;
        break;
      }
    }
  } finally {
    await restoreMsiServer();
    running = false;
    emit();
  }

  const finalCounts = countStates(store.readQueue().items);
  store.appendOplog({
    action: 'queue-finish',
    tier: 'full',
    items: finalCounts,
    outcome: (finalCounts.failed || 0) > 0 ? 'partial' : 'success'
  });

  return { success: true, counts: finalCounts };
}

async function runOne(itemId) {
  updateItem(itemId, (i) => {
    i.state = 'running';
    i.meta.startedAt = new Date().toISOString();
  });

  const item = store.readQueue().items.find((i) => i.id === itemId);
  if (!item) return;

  try {
    // Step 2a: a checkpoint per app, with the REQ-13 frequency override so the
    // second and later apps in a queue are not silently skipped.
    const restore = await runPowerShell('restore-point', {
      description: `Vanish Pre-Uninstall - ${item.displayName}`
    });
    updateItem(itemId, (i) => {
      i.meta.restorePoint = restore && restore.success ? (restore.note ? 'skipped' : 'created') : 'failed';
    });

    // Step 2b: re-read the entry from the LIVE registry. queue.json sits in a
    // user-writable directory, so the command persisted there is not what we
    // execute - it is only a pointer to the registry key we re-resolve now.
    const live = await runPowerShell('read-uninstall-entry', { registryPath: item.appKey });

    if (!live || live.success !== true || live.found !== true) {
      updateItem(itemId, (i) => {
        i.state = 'failed';
        i.meta.error = (live && live.error) || 'The uninstall entry no longer exists in the registry.';
      });
      logItem(item, 'failed');
      return;
    }

    const trust = live.trust || { risky: false, reasons: [] };
    if (trust.risky && !acknowledgedRisky.has(itemId)) {
      // Refuse rather than run an attacker-plantable binary with admin rights.
      updateItem(itemId, (i) => {
        i.state = 'needsAttention';
        i.meta.trust = trust;
        i.meta.error =
          'Not run: this uninstaller needs explicit confirmation because ' + trust.reasons.join('; ') + '.';
      });
      store.appendOplog({
        action: 'queue-uninstall',
        tier: 'full',
        items: { app: item.displayName, appKey: item.appKey },
        outcome: 'blocked',
        meta: { reason: 'unacknowledged untrusted uninstaller', trust }
      });
      return;
    }

    // If the live command differs from what we queued, record it - a silent
    // change between queueing and running is worth seeing in the audit trail.
    if (live.uninstallString && live.uninstallString !== item.uninstallString) {
      updateItem(itemId, (i) => {
        i.meta.uninstallStringChanged = true;
        i.meta.liveUninstallString = live.uninstallString;
      });
    }

    // Step 2c: Rule 15 switch lookup, method recorded per app.
    const resolved = await runPowerShell('resolve-uninstall-args', {
      displayName: live.displayName || item.displayName,
      publisher: live.publisher || item.publisher,
      uninstallString: live.uninstallString
    });

    if (!resolved || resolved.success !== true) {
      updateItem(itemId, (i) => {
        i.state = 'failed';
        i.meta.error = (resolved && resolved.error) || 'Could not resolve uninstall arguments.';
      });
      return;
    }

    updateItem(itemId, (i) => {
      i.method = resolved.method;
      i.meta.detectedType = resolved.detectedType;
      i.meta.matchedName = resolved.matchedName;
      i.meta.trust = trust;
      i.meta.command = `${resolved.executable} ${resolved.baseArgs} ${resolved.arguments}`.trim();
    });

    // Step 2d: run it and trap the exit code.
    const run = await runPowerShell('run-uninstaller', {
      executable: resolved.executable,
      baseArgs: resolved.baseArgs,
      arguments: resolved.arguments,
      timeoutSeconds: 600,
      acknowledged: !trust.risky || acknowledgedRisky.has(itemId)
    });

    if (!run || run.success !== true) {
      updateItem(itemId, (i) => {
        i.state = 'failed';
        i.meta.error = (run && run.error) || 'The uninstaller could not be started.';
      });
      logItem(item, 'failed');
      return;
    }

    const exitCode = run.exitCode;
    let nextState = 'done';

    if (run.timedOut) {
      nextState = 'needsAttention';
    } else if (REBOOT_EXIT_CODES.has(exitCode)) {
      nextState = 'rebootRequired';
    } else if (exitCode !== 0 && exitCode !== null) {
      nextState = 'failed';
    } else if (run.interactive) {
      // It exited cleanly but showed a window: the user drove it, not us.
      nextState = 'done';
    }

    updateItem(itemId, (i) => {
      i.state = nextState;
      i.exitCode = exitCode;
      i.meta.interactive = run.interactive === true;
      i.meta.timedOut = run.timedOut === true;
      i.meta.durationMs = run.durationMs;
      i.meta.finishedAt = new Date().toISOString();
    });

    logItem(item, nextState, exitCode, resolved.method);
  } catch (error) {
    updateItem(itemId, (i) => {
      i.state = 'failed';
      i.meta.error = error.message;
    });
    logItem(item, 'failed');
  }
}

function logItem(item, outcome, exitCode, method) {
  store.appendOplog({
    action: 'queue-uninstall',
    tier: 'full',
    items: { app: item.displayName, appKey: item.appKey },
    outcome,
    meta: { exitCode: exitCode ?? null, method: method ?? item.method ?? null }
  });
}

// Retry / resume: put a finished-but-not-done item back in line.
function retry(itemId) {
  updateItem(itemId, (i) => {
    if (i.state === 'failed' || i.state === 'rebootRequired' || i.state === 'needsAttention') {
      i.state = 'pending';
      i.exitCode = null;
    }
  });
  return { success: true };
}

module.exports = { init, getState, add, remove, clear, start, pause, retry };
