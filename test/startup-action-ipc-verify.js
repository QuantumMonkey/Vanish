// dmu / 87u: the startup write actions, through the layer that implements them.
//
//   npx electron test/startup-action-ipc-verify.js   (must be run elevated)
//
// WHY THIS SUITE EXISTS, and it is worth reading before changing it.
//
// test/elevated-confirmations.ps1 tested these three actions by calling
// scanner.ps1 directly. On 2026-08-18 that produced a FAIL saying no .reg
// restore manifest reached the vault, with a NOTE calling it "the leg dmu cares
// most about" - which read as a serious INV-1 breach.
//
// It was the harness. THE VAULT WRITE IS NOT IN THE ENGINE. scanner.ps1's
// "startup-remove-registry" (Remove-StartupRegistryValue) deletes the registry
// value and nothing else, correctly - the vault is not its job. main.js's
// "startup-action" handler is what exports the restore manifest, and it does it
// BEFORE the mutation, refusing the whole operation if the export fails. Calling
// the engine directly therefore skips the entire safety mechanism and then
// reports it missing. Third instance of this pattern in this repo after bkn and
// ri6: a harness testing one layer while its assertion text claims another.
//
// So every assertion below goes through ipcMain, exactly as the renderer does.
// If a future version moves the manifest export into the engine, these still
// pass - they assert the OUTCOME (a restorable vault entry exists before the
// registry changed), never the layer that produced it.

const { app, ipcMain } = require('electron');
const { execFileSync } = require('node:child_process');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

require('../main.js');

let pass = 0;
let fail = 0;
let lastLabel = '(nothing yet - it stopped before the first assertion)';

function assert(condition, label) {
  lastLabel = label;
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    fail += 1;
  }
}

const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.log('');
  console.log(`  FAIL  timed out after ${WATCHDOG_MS / 1000}s. Last completed assertion: ${lastLabel}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

async function invoke(channel, payload) {
  const handler = ipcMain._invokeHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: null }, payload);
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8'
  }).trim();
}

function psQuiet(script) {
  try {
    return ps(script);
  } catch {
    return '';
  }
}

// Everything below is created by this suite and destroyed in the finally.
// Nothing already on the machine's startup list is touched.
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'VanishStartupIpcProbe';
const RUN_DATA = 'C:\\Vanish\\Probe\\startup probe.exe --flag "quoted arg"';
const SVC_NAME = 'VanishStartupIpcProbeSvc';
const SVC_KEY = `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${SVC_NAME}`;

function cleanup() {
  psQuiet(`Remove-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue`);
  psQuiet(`& sc.exe delete ${SVC_NAME} | Out-Null`);
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Startup write actions, through the IPC layer (dmu / 87u)');
  console.log('=======================================================');

  // main.js resolves the tier ASYNCHRONOUSLY - it spawns scanner.ps1's
  // check-admin and assigns currentTier in the callback (main.js:144), starting
  // from TIER_AUDIT. Reading get-tier the instant whenReady fires therefore
  // returns audit in an elevated process, and this suite refused itself out of
  // the first elevated run it was ever part of. Same 3s the other IPC suites
  // wait for the same reason.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const tier = await invoke('get-tier');
  console.log(`Resolved tier: ${(tier && tier.tier) || 'unknown'} (isFullMode=${tier && tier.isFullMode})`);
  // isFullMode, not a string compare on tier: get-tier returns BOTH, and
  // isFullMode is the flag every other suite and the renderer gate on.
  if (!tier || tier.isFullMode !== true) {
    console.log('');
    console.log('  This suite needs Full Mode - every action under test is a write.');
    console.log('  Re-run from an elevated shell.');
    console.log('');
    // Deliberately NO "Result:" line. run-all.ps1 parses that line to decide a
    // suite ran, so printing "Result: 0 passed, 0 failed" here reported a clean
    // zero-assertion pass instead of NOT RUN - which is exactly the "silence
    // that looks like success" this repo keeps fixing. vault-ipc-verify and
    // phase4-ipc-verify refuse the same way.
    clearTimeout(watchdog);
    app.exit(2);
    return;
  }

  cleanup();

  try {
    // ================================================================
    // 1. Removing a Run value exports its restore manifest FIRST
    // ================================================================
    console.log('');
    console.log('registry-remove: the manifest is written before the value is');

    ps(`New-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -Value '${RUN_DATA}' -PropertyType String -Force | Out-Null`);
    assert(
      ps(`(Get-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${RUN_VALUE}').'${RUN_VALUE}'`) === RUN_DATA,
      'planted a Run value to operate on'
    );

    const vaultBefore = await invoke('vault-list');
    const idsBefore = new Set((vaultBefore.entries || []).map((e) => e.id));

    const removed = await invoke('startup-action', {
      action: 'registry-remove',
      item: {
        name: RUN_VALUE,
        action: 'registry-remove',
        registryPath: RUN_KEY,
        keyPath: RUN_KEY,
        valueName: RUN_VALUE,
        managePath: RUN_KEY
      }
    });

    assert(removed && removed.success === true, `the IPC action reported success (error: ${(removed && removed.error) || ''})`);
    assert(
      ps(`[string](Get-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue).'${RUN_VALUE}'`) === '',
      'the value is gone from the registry'
    );

    // THE assertion the old harness could not make, because the engine has no
    // entryId to give it.
    assert(
      !!(removed && removed.entryId),
      `the action returned a vault entry id (got '${(removed && removed.entryId) || ''}')`
    );

    const vaultAfter = await invoke('vault-list');
    const entry = (vaultAfter.entries || []).find((e) => e.id === (removed && removed.entryId));
    assert(!!entry, 'and that id is a real entry in the vault listing');
    assert(entry && String(entry.origin) === 'startup/registry-remove', `the entry records the flow that made it (got '${entry && entry.origin}')`);
    assert(entry && String(entry.sourceApp) === 'Startup entries', `and attributes it to the startup surface (got '${entry && entry.sourceApp}')`);

    const regRows = (entry && entry.registry) || [];
    assert(regRows.length === 1, `the entry holds exactly one registry row (got ${regRows.length})`);
    assert(regRows.every((r) => r.regFile), 'the row references a .reg restore manifest file on disk');

    // The Run key itself must SURVIVE. Deleting it would take every other
    // program's startup entry with it, which is why main.js asks for
    // mode:'manifest-only'.
    assert(ps(`Test-Path -LiteralPath '${RUN_KEY}'`) === 'True', 'the Run key itself still exists - a key delete here would wipe every other startup entry');

    // ================================================================
    // 2. The manifest actually restores, byte for byte
    // ================================================================
    console.log('');
    console.log('registry-remove: the restore is the proof, not the manifest');

    const restored = await invoke('vault-restore', { entryId: removed.entryId });
    assert(restored && restored.success === true, `restore succeeded (error: ${(restored && restored.error) || ''})`);
    assert(
      ps(`[string](Get-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue).'${RUN_VALUE}'`) === RUN_DATA,
      'the value is back, byte-identical including its quotes and spaces'
    );

    // ================================================================
    // 3. Setting a service to Manual takes the same route
    // ================================================================
    console.log('');
    console.log('service-manual: same contract, different target');

    ps(`& sc.exe create ${SVC_NAME} binPath= 'C:\\Windows\\System32\\help.exe' start= auto DisplayName= 'Vanish Startup IPC Probe' | Out-Null`);
    assert(ps(`(Get-ItemProperty -LiteralPath '${SVC_KEY}' -Name Start).Start`) === '2', 'planted an Automatic service (Start=2)');

    const svcAction = await invoke('startup-action', {
      action: 'service-manual',
      item: {
        name: SVC_NAME,
        action: 'service-manual',
        registryPath: SVC_KEY,
        serviceName: SVC_NAME,
        managePath: SVC_KEY
      }
    });

    assert(svcAction && svcAction.success === true, `the IPC action reported success (error: ${(svcAction && svcAction.error) || ''})`);
    assert(ps(`(Get-ItemProperty -LiteralPath '${SVC_KEY}' -Name Start).Start`) === '3', 'the service is now Manual (Start=3)');
    assert(!!(svcAction && svcAction.entryId), `the action returned a vault entry id (got '${(svcAction && svcAction.entryId) || ''}')`);

    const svcVault = await invoke('vault-list');
    const svcEntry = (svcVault.entries || []).find((e) => e.id === (svcAction && svcAction.entryId));
    assert(!!svcEntry, 'and that id is a real entry in the vault listing');
    assert(svcEntry && String(svcEntry.origin) === 'startup/service-manual', `the entry records the flow that made it (got '${svcEntry && svcEntry.origin}')`);
    assert(((svcEntry && svcEntry.registry) || []).every((r) => r.regFile), 'its registry row references a .reg restore manifest');
    assert(ps(`Test-Path -LiteralPath '${SVC_KEY}'`) === 'True', 'the service key still exists - exporting it must not unregister the service');

    const svcRestore = await invoke('vault-restore', { entryId: svcAction.entryId });
    assert(svcRestore && svcRestore.success === true, `restore succeeded (error: ${(svcRestore && svcRestore.error) || ''})`);
    assert(ps(`(Get-ItemProperty -LiteralPath '${SVC_KEY}' -Name Start).Start`) === '2', 'the service is Automatic again');

    // ================================================================
    // 4. No manifest, no mutation
    // ================================================================
    console.log('');
    console.log('the refusal: an entry that cannot be saved is not changed');

    // An item with no registryPath is the one case main.js can detect before
    // touching anything. The value below must still be on the machine
    // afterwards - that is the whole assertion.
    ps(`New-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -Value '${RUN_DATA}' -PropertyType String -Force | Out-Null`);
    const refused = await invoke('startup-action', {
      action: 'registry-remove',
      item: { name: RUN_VALUE, action: 'registry-remove', keyPath: RUN_KEY, valueName: RUN_VALUE }
    });
    assert(refused && refused.success === false, 'an entry that does not say which key backs it is refused');
    assert(
      typeof (refused && refused.error) === 'string' && /cannot be saved|saved before changing|restore file/i.test(refused.error),
      `and the refusal says why, in terms of the restore (got '${(refused && refused.error) || ''}')`
    );
    assert(
      ps(`[string](Get-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue).'${RUN_VALUE}'`) === RUN_DATA,
      'and the value is untouched - a refusal that had already deleted something would be the worst outcome here'
    );

    // ================================================================
    // 5. Disabling a task is the ONE path with no manifest, on purpose
    // ================================================================
    console.log('');
    console.log('task-disable: no manifest, and that is the correct behaviour');

    // Asserted so nobody "fixes" the asymmetry later: disabling a scheduled
    // task destroys nothing and the same control re-enables it, so there is
    // nothing to restore and claiming a restore would be a lie.
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
    const handlerStart = src.indexOf("fullModeOnly('startup-action'");
    const taskBranch = src.slice(handlerStart, src.indexOf('startup-remove-registry', handlerStart));
    assert(handlerStart > -1, 'the startup-action handler is where this suite thinks it is');
    assert(
      /task-disable/.test(taskBranch) && !/vault\.quarantine/.test(taskBranch.slice(0, taskBranch.indexOf('registry-remove'))),
      'the task-disable branch returns before any vault export - nothing is destroyed, so nothing is saved'
    );
  } finally {
    cleanup();
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.log('');
  console.log(`  FAIL  threw after "${lastLabel}": ${(err && err.message) || err}`);
  console.log(String((err && err.stack) || ''));
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  clearTimeout(watchdog);
  app.exit(1);
});
