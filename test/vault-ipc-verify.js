// TASK-02 / TASK-03 Verify: the wizard purge path and the Quarantine Manager,
// exercised through the real IPC handlers rather than the buttons.
// Covers REQ-01, REQ-02, REQ-03 and FLOW-02/FLOW-03 branches end to end:
// plant fixtures -> purge-remnants -> vault-list -> vault-restore -> re-purge
// -> vault-delete, asserting the manifest, the oplog and the disk agree.
//
//   npx electron test/vault-ipc-verify.js      (must be run from an elevated shell)

const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

require('../main.js');

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    fail += 1;
  }
}

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

const REG_KEY = 'HKCU:\\Software\\VanishIpcVerify';

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const tier = await invoke('get-tier');
  console.log('');
  console.log('Vanish vault IPC round trip');
  console.log('===========================');
  console.log(`Resolved tier: ${tier.tier}`);

  if (!tier.isFullMode) {
    console.log('');
    console.log('This verification needs Full Mode. Re-run from an elevated shell.');
    app.exit(2);
    return;
  }

  // --- plant fixtures ----------------------------------------------------
  const fixtures = path.join(os.tmpdir(), 'vanish-ipc-verify');
  fs.rmSync(fixtures, { recursive: true, force: true });
  fs.mkdirSync(fixtures, { recursive: true });

  const filePath = path.join(fixtures, 'leftover.txt');
  fs.writeFileSync(filePath, 'ipc round trip payload', 'utf8');

  const dirPath = path.join(fixtures, 'LeftoverApp');
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'settings.cfg'), 'k=v', 'utf8');

  ps(`if (Test-Path '${REG_KEY}') { Remove-Item '${REG_KEY}' -Recurse -Force }; ` +
     `New-Item -Path '${REG_KEY}' -Force | Out-Null; ` +
     `Set-ItemProperty -Path '${REG_KEY}' -Name Marker -Value 'ipc-verify'`);

  const settings = await invoke('get-settings');
  console.log('');
  console.log('Settings defaults (ENT-02)');
  assert(settings.autoPurgeEnabled === false, 'auto-purge is OFF by default (Rule 1 / Rule 2)');
  assert(settings.autoPurgeRetentionDays === 30, 'retention default is 30 days');

  // --- FLOW-02 purge -----------------------------------------------------
  console.log('');
  console.log('FLOW-02: wizard purge routes through the vault (REQ-01, REQ-02)');
  const purge = await invoke('purge-remnants', {
    files: [{ path: filePath }, { path: dirPath }],
    registry: [{ path: REG_KEY }],
    sourceApp: 'IpcVerify',
    origin: 'uninstall-wizard'
  });

  assert(purge.success === true, 'purge reported success');
  assert(purge.quarantinedCount === 3, '3 items quarantined');
  assert(purge.entryId != null, 'a vault entry id came back for the summary link');
  assert(!fs.existsSync(filePath), 'original file gone from source path');
  assert(!fs.existsSync(dirPath), 'original directory gone from source path');
  assert(ps(`Test-Path '${REG_KEY}'`) === 'False', 'registry key removed');

  // --- SCR-02 listing ----------------------------------------------------
  console.log('');
  console.log('SCR-02: Quarantine Manager listing (REQ-03)');
  const listed = await invoke('vault-list');
  assert(listed.success === true, 'vault-list succeeded');
  const entry = listed.entries.find((e) => e.id === purge.entryId);
  assert(entry != null, 'the new entry appears in the manifest listing');
  assert(entry.sourceApp === 'IpcVerify', 'entry is attributed to the source app');
  assert(entry.fileCount === 2 && entry.registryCount === 1, 'entry counts files and keys separately');
  assert(entry.sizeBytes > 0, 'entry reports its on-disk vault size');
  assert(fs.existsSync(entry.vaultPath), 'vault payload folder exists on disk');
  assert(fs.existsSync(path.join(entry.vaultPath, 'entry.json')), 'entry.json durability record written');

  // --- FLOW-03 restore ---------------------------------------------------
  console.log('');
  console.log('FLOW-03: restore returns everything to its original location');
  const restored = await invoke('vault-restore', { entryId: purge.entryId, onConflict: 'skip' });
  assert(restored.success === true, 'restore succeeded');
  assert(restored.failed === 0, 'no restore failures');
  assert(fs.existsSync(filePath), 'file is back at its original path');
  assert(fs.readFileSync(filePath, 'utf8') === 'ipc round trip payload', 'file contents intact');
  assert(fs.existsSync(path.join(dirPath, 'settings.cfg')), 'directory tree restored with contents');
  assert(ps(`Test-Path '${REG_KEY}'`) === 'True', 'registry key restored from the .reg manifest');
  assert(ps(`(Get-ItemProperty -Path '${REG_KEY}').Marker`) === 'ipc-verify', 'registry value intact');

  const afterRestore = await invoke('vault-list');
  const restoredEntry = afterRestore.entries.find((e) => e.id === purge.entryId);
  assert(restoredEntry.status === 'restored', 'entry status flipped to restored (terminal)');

  const reRestore = await invoke('vault-restore', { entryId: purge.entryId });
  assert(reRestore.success === false, 'a restored entry cannot be restored twice');

  // --- FLOW-03 delete forever -------------------------------------------
  console.log('');
  console.log('FLOW-03: Delete Forever is the only irreversible act');
  const purge2 = await invoke('purge-remnants', {
    files: [{ path: filePath }],
    registry: [],
    sourceApp: 'IpcVerify',
    origin: 'uninstall-wizard'
  });
  assert(purge2.quarantinedCount === 1, 'second purge quarantined the file again');

  const listed2 = await invoke('vault-list');
  const entry2 = listed2.entries.find((e) => e.id === purge2.entryId);
  const vaultPath2 = entry2.vaultPath;

  const deleted = await invoke('vault-delete', { entryId: purge2.entryId });
  assert(deleted.success === true, 'delete forever succeeded');
  assert(!fs.existsSync(vaultPath2), 'vault payload folder is gone from disk');

  const listed3 = await invoke('vault-list');
  const entry3 = listed3.entries.find((e) => e.id === purge2.entryId);
  assert(entry3.status === 'deleted', 'manifest records the entry as deleted');
  assert(
    listed3.entries.filter((e) => e.status !== 'deleted').every((e) => e.id !== purge2.entryId),
    'deleted entries drop out of the active listing'
  );

  // --- NFR-04 audit trail ------------------------------------------------
  console.log('');
  console.log('NFR-04: every destructive act left an audit trail');
  const oplogPath = path.join(app.getPath('userData'), 'oplog.jsonl');
  const lines = fs
    .readFileSync(oplogPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const recent = lines.slice(-12);
  assert(recent.some((l) => l.action === 'quarantine' && l.outcome === 'success'), 'quarantine logged');
  assert(recent.some((l) => l.action === 'vault-restore'), 'restore logged');
  assert(
    recent.some((l) => l.action === 'vault-delete' && l.meta && l.meta.irreversible === true),
    'delete logged and flagged irreversible'
  );
  assert(recent.every((l) => typeof l.ts === 'string' && l.tier), 'every log line carries a timestamp and tier');

  // --- cleanup -----------------------------------------------------------
  ps(`if (Test-Path '${REG_KEY}') { Remove-Item '${REG_KEY}' -Recurse -Force }`);
  fs.rmSync(fixtures, { recursive: true, force: true });

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail > 0 ? 1 : 0);
});
