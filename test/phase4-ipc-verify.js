// Phase 4 purge round trips (REQ-11, REQ-14, REQ-15, REQ-16, FLOW-06).
// Plants a real orphan per cleaner, purges it through the IPC layer, asserts it
// landed in the quarantine vault, then restores it and asserts it came back.
//
//   npx electron test/phase4-ipc-verify.js     (must be run from an elevated shell)

const { app, ipcMain } = require('electron');
const { execFileSync } = require('node:child_process');

// This loads the REAL main.js below, including its startup elevation logic.
// Never let a startupMode:'full' setting left on this machine from real use
// spawn a live UAC prompt and hang an unattended run.
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';

// No window, and none of the three Full Mode startup side effects - including
// the auto-purge sweep against the operator's real vault. This suite passed
// elevated on 2026-08-14 without the flag; it is set here because a diagnostic
// that opens a window on someone's screen and touches their vault to test a
// purge path is doing two things it was not asked to do. Every handler it
// invokes is registered at main.js's top level and is unaffected.
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

// Same watchdog as vault-ipc-verify: a hang is an outcome to report, not a
// silence to wait out.
const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.log('');
  console.log(`  FAIL  timed out after ${WATCHDOG_MS / 1000}s. Last completed assertion: ${lastLabel}`);
  console.log('        Whatever comes after that never returned.');
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

const CLSID = '{DEADBEEF-1234-4321-ABCD-0123456789AC}';
const HANDLER_KEY = 'HKCU:\\Software\\Classes\\*\\shellex\\ContextMenuHandlers\\VanishIpcOrphan';
const CLSID_KEY = `HKCU:\\Software\\Classes\\CLSID\\${CLSID}`;
const SVC_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\VanishIpcOrphanSvc';
const DEAD_DIR = 'C:\\Vanish\\Definitely\\Missing\\ipcbin';
const UWP_FAMILY = 'VanishIpcGhost.Test_vanishtest999';
const UWP_DIR = `${process.env.LOCALAPPDATA}\\Packages\\${UWP_FAMILY}`;
const UWP_FILE = `${UWP_DIR}\\LocalState\\payload.bin`;

function cleanup() {
  ps(`
    foreach ($k in @('${HANDLER_KEY}','${CLSID_KEY}','${SVC_KEY}')) {
      if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath '${UWP_DIR}') { Remove-Item -LiteralPath '${UWP_DIR}' -Recurse -Force -ErrorAction SilentlyContinue }
  `);
}

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const tier = await invoke('get-tier');
  console.log('');
  console.log('Vanish System Clean purge round trips');
  console.log('=====================================');
  console.log(`Resolved tier: ${tier.tier}`);

  if (!tier.isFullMode) {
    console.log('');
    console.log('This verification needs Full Mode. Re-run from an elevated shell.');
    app.exit(2);
    return;
  }

  cleanup();

  try {
    // ================================================================
    // REQ-11: context menu handler
    // ================================================================
    console.log('');
    console.log('REQ-11 context menu handler: purge -> quarantine -> restore');

    ps(`
      $null = New-Item -Path '${HANDLER_KEY}' -Force
      Set-ItemProperty -LiteralPath '${HANDLER_KEY}' -Name '(default)' -Value '${CLSID}'
      $null = New-Item -Path '${CLSID_KEY}\\InprocServer32' -Force
      Set-ItemProperty -LiteralPath '${CLSID_KEY}\\InprocServer32' -Name '(default)' -Value 'C:\\Vanish\\Missing\\shell.dll'
    `);

    const ctxScan = await invoke('cleaner-scan', { cleaner: 'context-menus' });
    const ctxFinding = ctxScan.findings.find((f) => f.label.includes('VanishIpcOrphan'));
    assert(ctxFinding != null, 'planted handler found by the scan');

    const ctxPurge = await invoke('cleaner-purge', { cleaner: 'context-menus', items: [ctxFinding] });
    assert(ctxPurge.success === true, 'purge reported success');
    assert(ctxPurge.quarantinedCount === 1, 'exactly one item quarantined');
    assert(ps(`Test-Path -LiteralPath '${HANDLER_KEY}'`) === 'False', 'handler key removed from the registry');

    const vault1 = await invoke('vault-list');
    const ctxEntry = vault1.entries.find((e) => e.id === ctxPurge.entryId);
    assert(ctxEntry != null, 'a vault entry was created for the cleaner purge');
    assert(ctxEntry.sourceApp === 'Context menu cleaner', 'the vault entry names the cleaner that made it');
    assert(ctxEntry.origin === 'system-clean/context-menus', 'the vault entry records its origin flow');
    assert(ctxEntry.registryCount === 1, 'entry holds the exported .reg restore manifest');

    const ctxRestore = await invoke('vault-restore', { entryId: ctxPurge.entryId });
    assert(ctxRestore.success === true && ctxRestore.failed === 0, 'restore succeeded');
    assert(ps(`Test-Path -LiteralPath '${HANDLER_KEY}'`) === 'True', 'handler key is back in the registry');
    assert(
      ps(`(Get-ItemProperty -LiteralPath '${HANDLER_KEY}').'(default)'`) === CLSID,
      'the handler value survived the round trip intact'
    );

    // ================================================================
    // REQ-14: orphaned service
    // ================================================================
    console.log('');
    console.log('REQ-14 orphaned service: purge -> quarantine -> restore');

    ps(`
      $null = New-Item -Path '${SVC_KEY}' -Force
      Set-ItemProperty -LiteralPath '${SVC_KEY}' -Name 'ImagePath' -Value 'C:\\Vanish\\Missing\\ghost.exe'
      Set-ItemProperty -LiteralPath '${SVC_KEY}' -Name 'Type'  -Value 16 -Type DWord
      Set-ItemProperty -LiteralPath '${SVC_KEY}' -Name 'Start' -Value 3  -Type DWord
    `);

    const svcScan = await invoke('cleaner-scan', { cleaner: 'services' });
    const svcFinding = svcScan.findings.find((f) => f.label === 'VanishIpcOrphanSvc');
    assert(svcFinding != null, 'planted orphan service found by the scan');

    const svcPurge = await invoke('cleaner-purge', { cleaner: 'services', items: [svcFinding] });
    assert(svcPurge.success === true && svcPurge.quarantinedCount === 1, 'service key quarantined');
    assert(ps(`Test-Path -LiteralPath '${SVC_KEY}'`) === 'False', 'service registry key removed');

    const svcRestore = await invoke('vault-restore', { entryId: svcPurge.entryId });
    assert(svcRestore.success === true && svcRestore.failed === 0, 'service restore succeeded');
    assert(ps(`Test-Path -LiteralPath '${SVC_KEY}'`) === 'True', 'service key is back');
    assert(
      ps(`(Get-ItemProperty -LiteralPath '${SVC_KEY}').ImagePath`) === 'C:\\Vanish\\Missing\\ghost.exe',
      'service ImagePath value restored exactly'
    );

    // ================================================================
    // REQ-15: PATH - a registry VALUE, not a key
    // ================================================================
    console.log('');
    console.log('REQ-15 PATH cleaner: manifest-only export, value rewrite, restore');

    const originalPath = ps(
      `(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')`
    );
    ps(`Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value '${originalPath};${DEAD_DIR}'`);

    const pathScan = await invoke('cleaner-scan', { cleaner: 'path' });
    const pathFinding = pathScan.findings.find((f) => f.label === DEAD_DIR);
    assert(pathFinding != null, 'planted dead PATH entry found');

    const pathPurge = await invoke('cleaner-purge', { cleaner: 'path', items: [pathFinding] });
    assert(pathPurge.success === true, 'PATH purge reported success');

    const afterPath = ps(
      `(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')`
    );
    assert(!afterPath.includes(DEAD_DIR), 'dead entry removed from the live PATH');
    assert(afterPath === originalPath, 'the surviving PATH is byte-identical to the original');

    const vault2 = await invoke('vault-list');
    const pathEntry = vault2.entries.find((e) => e.id === pathPurge.perScope[0].entryId);
    assert(pathEntry != null, 'a restore manifest entry exists for the PATH edit');
    assert(pathEntry.registry[0].mode === 'manifest-only', 'the Environment key was exported WITHOUT being deleted');
    assert(
      ps(`Test-Path -LiteralPath 'HKCU:\\Environment'`) === 'True',
      'the Environment key itself still exists (a key delete here would wipe every user variable)'
    );

    // Put the dead entry back via restore, proving the manifest really works.
    ps(`Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value 'C:\\wrecked'`);
    const pathRestore = await invoke('vault-restore', { entryId: pathEntry.id });
    assert(pathRestore.success === true, 'PATH restore succeeded');
    const restoredPath = ps(
      `(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')`
    );
    assert(restoredPath.includes(DEAD_DIR), 'the pre-purge PATH (including the dead entry) was restored from the .reg manifest');

    // Leave the machine as we found it.
    ps(`Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value '${originalPath}'`);

    // ================================================================
    // udu: left-over Store app data - a FOLDER, not a registry key
    // ================================================================
    // The only cleaner whose findings are files. Until this existed, no
    // automated run had ever moved a real folder into the vault and pulled it
    // back out again; every other round trip above is a .reg export.
    console.log('');
    console.log('udu left-over Store app data: purge -> quarantine -> restore');

    ps(`
      $null = New-Item -ItemType Directory -Path '${UWP_DIR}\\LocalState' -Force
      Set-Content -LiteralPath '${UWP_FILE}' -Value ('x' * 4096) -Encoding ascii
      (Get-Item -LiteralPath '${UWP_DIR}').LastWriteTime = (Get-Date).AddDays(-60)
    `);

    // Capture what is ACTUALLY on disk before anything touches it, rather
    // than asserting against a constant later.
    //
    // The first elevated run of this suite (2026-08-14) failed here against a
    // hardcoded 4096. The file is 4098 bytes: Set-Content appends a line
    // terminator. So the assertion had never been true, not even before the
    // purge - and it would have PASSED if the vault had truncated the file to
    // exactly 4096, which is the one outcome it existed to catch. A round-trip
    // test that compares against an assumed value instead of the real one is
    // worse than no test.
    const uwpBefore = {
      length: ps(`(Get-Item -LiteralPath '${UWP_FILE}').Length`),
      hash: ps(`(Get-FileHash -LiteralPath '${UWP_FILE}' -Algorithm SHA256).Hash`),
    };

    const uwpScan = await invoke('cleaner-scan', { cleaner: 'uwp-leftovers' });
    const uwpFinding = (uwpScan.findings || []).find((f) => f.meta && f.meta.family === UWP_FAMILY);
    assert(uwpFinding != null, 'planted left-over package folder found by the scan');
    assert(uwpFinding != null && uwpFinding.sizeBytes > 0, 'the finding carries a real measured size');

    const uwpPurge = await invoke('cleaner-purge', { cleaner: 'uwp-leftovers', items: [uwpFinding] });
    assert(uwpPurge.success === true, 'folder purge reported success');
    assert(uwpPurge.quarantinedCount === 1, 'exactly one folder quarantined');
    assert(ps(`Test-Path -LiteralPath '${UWP_DIR}'`) === 'False', 'the folder is gone from AppData');

    const vault3 = await invoke('vault-list');
    const uwpEntry = vault3.entries.find((e) => e.id === uwpPurge.entryId);
    assert(uwpEntry != null, 'a vault entry was created for the folder');
    assert(uwpEntry != null && uwpEntry.origin === 'system-clean/uwp-leftovers', 'the entry records which sweep made it');
    assert(uwpEntry != null && uwpEntry.fileCount === 1, 'the entry holds the folder itself, not a registry manifest');

    const uwpRestore = await invoke('vault-restore', { entryId: uwpPurge.entryId });
    assert(uwpRestore.success === true && uwpRestore.failed === 0, 'folder restore succeeded');
    assert(ps(`Test-Path -LiteralPath '${UWP_DIR}'`) === 'True', 'the folder is back where it was');
    const uwpAfter = {
      length: ps(`(Get-Item -LiteralPath '${UWP_FILE}').Length`),
      hash: ps(`(Get-FileHash -LiteralPath '${UWP_FILE}' -Algorithm SHA256).Hash`),
    };
    assert(
      uwpAfter.length === uwpBefore.length && uwpBefore.length !== '',
      `the restored file is the same size as the original (${uwpBefore.length} -> ${uwpAfter.length})`
    );
    assert(
      uwpAfter.hash === uwpBefore.hash && uwpBefore.hash !== '',
      `the restored file is byte-for-byte identical (SHA256 ${String(uwpBefore.hash).slice(0, 16)}...)`
    );

    // A finding the engine refuses to remove must not become removable just
    // because the renderer sent it back.
    const protectedItem = { ...uwpFinding, removable: false };
    const refused = await invoke('cleaner-purge', { cleaner: 'uwp-leftovers', items: [protectedItem] });
    assert(refused.success === false, 'a finding marked unremovable is refused at the IPC boundary');
    assert(ps(`Test-Path -LiteralPath '${UWP_DIR}'`) === 'True', 'and the folder it named is still there');

    // ================================================================
    // INV-1: nothing bypassed the vault
    // ================================================================
    console.log('');
    console.log('INV-1 every cleaner removal produced a restorable vault entry');
    const finalVault = await invoke('vault-list');
    const cleanerEntries = finalVault.entries.filter((e) => String(e.origin).startsWith('system-clean/'));
    assert(cleanerEntries.length >= 3, `all ${cleanerEntries.length} cleaner purges are represented in the vault`);
    // Count manifest ROWS, not currently-quarantined items: everything above
    // has just been restored, so the live counts are legitimately zero.
    assert(
      cleanerEntries.every((e) => (e.registry || []).length + (e.files || []).length > 0),
      'no cleaner produced an empty (unrestorable) entry'
    );
    assert(
      cleanerEntries.every((e) => (e.registry || []).every((r) => r.regFile)),
      'every quarantined registry row references a .reg restore manifest file'
    );
  } finally {
    cleanup();
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  // A throw here used to leave the process alive with no output and no exit
  // code, which is indistinguishable from a hang to anything waiting on it.
  console.log('');
  console.log(`  FAIL  threw after "${lastLabel}": ${(err && err.message) || err}`);
  console.log(String((err && err.stack) || ''));
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  clearTimeout(watchdog);
  app.exit(1);
});
