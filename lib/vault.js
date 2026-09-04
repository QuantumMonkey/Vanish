// Quarantine vault orchestration (promptgate Rule 2, REQ-01/02/03, FLOW-02/03).
// The engine (scanner.ps1) moves payloads; this module owns manifest.json and
// oplog.jsonl writes (04-schema.md rule 7) and is the only route by which a
// destructive file/registry operation may reach the disk (INV-1).

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { lockFailuresFrom } = require('./lock-failure');

let runPowerShell = null;

function init(runner) {
  runPowerShell = runner;
}

// Quarantine a set of files/registry keys as one vault entry.
// items: { files: [{path}], registry: [{path}] }
async function quarantine(items, options = {}) {
  const files = Array.isArray(items.files) ? items.files : [];
  const registry = Array.isArray(items.registry) ? items.registry : [];

  if (files.length === 0 && registry.length === 0) {
    return { success: true, entryId: null, quarantinedCount: 0, files: [], registry: [] };
  }

  const entryId = store.newId();
  const result = await runPowerShell('quarantine-items', {
    vaultRoot: store.vaultRoot(),
    entryId,
    sourceApp: options.sourceApp || 'unknown',
    origin: options.origin || 'purge',
    allowOwnershipElevation: options.allowOwnershipElevation === true,
    files,
    registry
  });

  if (!result || result.success !== true) {
    const error = (result && result.error) || 'Quarantine engine returned no result.';
    store.appendOplog({
      action: 'quarantine',
      tier: 'full',
      items: { requested: files.length + registry.length },
      outcome: 'error',
      meta: { error, sourceApp: options.sourceApp || 'unknown' }
    });
    return { success: false, error, entryId: null, files: [], registry: [] };
  }

  const entry = normaliseEntry(result.entry, entryId, options);

  if (result.quarantinedCount > 0) {
    store.addManifestEntry(entry);
  }

  // h55: the failed PATHS, not just how many. This record used to carry counts
  // alone, which is why "show me what would not delete" could not be built by
  // reading anything that existed - and the per-item vault manifest does not
  // fill the gap, because addManifestEntry above only runs when at least one
  // item made it, so a purge where EVERY item was locked wrote nothing anywhere.
  //
  // NO NEW STORE, and that is the point. The design pass on this issue flagged
  // "a new piece of persisted state about the user's machine, accumulating
  // quietly" as an operator decision it should not take alone. Writing into the
  // oplog instead removes the decision rather than answering it: the oplog
  // already exists, already records this exact event, already rotates itself at
  // 5 MB (ENT-05), and already never leaves the device (INV-4). What changes is
  // that a record which said "3 failed" now says which three and why, which is
  // the record being honest rather than a new thing to govern.
  const lockedPaths = lockFailuresFrom(entry);

  store.appendOplog({
    action: 'quarantine',
    tier: 'full',
    items: {
      requested: files.length + registry.length,
      quarantined: result.quarantinedCount,
      failed: countFailed(entry),
      // Absent rather than empty when there were none, so a reader can tell an
      // old record (written before this existed) from a new one that found no
      // locks. Those are different facts and the Unlocker says so.
      ...(lockedPaths.length ? { lockedPaths } : {})
    },
    outcome: countFailed(entry) === 0 ? 'success' : 'partial',
    meta: { entryId: result.quarantinedCount > 0 ? entryId : null, sourceApp: entry.sourceApp, origin: entry.origin }
  });

  return {
    success: true,
    entryId: result.quarantinedCount > 0 ? entryId : null,
    quarantinedCount: result.quarantinedCount,
    files: entry.files,
    registry: entry.registry
  };
}

function normaliseEntry(raw, entryId, options) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  return {
    schemaVersion: store.SCHEMA_VERSION,
    id: entryId,
    sourceApp: entry.sourceApp || options.sourceApp || 'unknown',
    origin: entry.origin || options.origin || 'purge',
    createdAt: entry.createdAt || new Date().toISOString(),
    status: 'quarantined',
    files: asArray(entry.files),
    registry: asArray(entry.registry),
    meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value]; // PowerShell collapses single-element arrays
}

function countFailed(entry) {
  return (
    asArray(entry.files).filter((f) => f.status === 'failed').length +
    asArray(entry.registry).filter((r) => r.status === 'failed').length
  );
}

// SCR-02 listing. Reads the manifest this process owns; adds on-disk size.
function list() {
  const manifest = store.readManifest();
  const root = store.vaultRoot();
  return manifest.entries.map((entry) => {
    const files = asArray(entry.files);
    const registry = asArray(entry.registry);
    const entryDir = path.join(root, entry.id);
    let sizeBytes = 0;
    if (entry.status === 'quarantined' && fs.existsSync(entryDir)) {
      sizeBytes = store.directorySize(entryDir);
    }
    return {
      id: entry.id,
      sourceApp: entry.sourceApp || 'unknown',
      origin: entry.origin || 'purge',
      createdAt: entry.createdAt,
      status: entry.status || 'quarantined',
      fileCount: files.filter((f) => f.status === 'quarantined').length,
      registryCount: registry.filter((r) => r.status === 'quarantined').length,
      sizeBytes,
      vaultPath: entryDir,
      files,
      registry
    };
  });
}

async function restore(entryId, onConflict = 'skip') {
  const entry = store.getManifestEntry(entryId);
  if (!entry) return { success: false, error: 'Vault entry not found.' };
  if (entry.status !== 'quarantined') {
    return { success: false, error: `Entry is already marked "${entry.status}".` };
  }

  const result = await runPowerShell('vault-restore', {
    vaultRoot: store.vaultRoot(),
    entry,
    onConflict
  });

  if (!result || result.success !== true) {
    const error = (result && result.error) || 'Restore engine returned no result.';
    store.appendOplog({
      action: 'vault-restore',
      tier: 'full',
      items: { entryId },
      outcome: 'error',
      meta: { error }
    });
    return { success: false, error };
  }

  const fileResults = asArray(result.files);
  const regResults = asArray(result.registry);
  const failed = fileResults.filter((f) => f.status === 'failed').length +
                 regResults.filter((r) => r.status === 'failed').length;
  const skipped = fileResults.filter((f) => f.status === 'skipped').length;
  const fullyRestored = failed === 0 && skipped === 0;

  store.updateManifestEntry(entryId, (e) => {
    if (fullyRestored) {
      e.status = 'restored';
      e.restoredAt = new Date().toISOString();
    } else {
      e.meta = e.meta || {};
      e.meta.lastRestoreAttempt = new Date().toISOString();
      e.meta.lastRestoreFailures = failed;
      e.meta.lastRestoreSkipped = skipped;
    }
    // Mark the individual items that made it home so a retry does not redo them.
    for (const f of asArray(e.files)) {
      const r = fileResults.find((x) => x.originalPath === f.originalPath);
      if (r && r.status === 'restored') f.status = 'restored';
    }
    for (const g of asArray(e.registry)) {
      const r = regResults.find((x) => x.keyPath === g.keyPath);
      if (r && r.status === 'restored') g.status = 'restored';
    }
  });

  if (fullyRestored) {
    // Payload folder is empty once everything moved back; drop the shell.
    removeEntryFolder(entryId);
  }

  store.appendOplog({
    action: 'vault-restore',
    tier: 'full',
    items: { entryId, files: fileResults.length, registry: regResults.length, failed, skipped },
    outcome: fullyRestored ? 'success' : 'partial'
  });

  return { success: true, files: fileResults, registry: regResults, failed, skipped, fullyRestored };
}

async function deleteForever(entryId, reason = 'user') {
  const entry = store.getManifestEntry(entryId);
  if (!entry) return { success: false, error: 'Vault entry not found.' };

  const result = await runPowerShell('vault-delete', {
    vaultRoot: store.vaultRoot(),
    entryId
  });

  if (!result || result.success !== true) {
    const error = (result && result.error) || 'Delete engine returned no result.';
    store.appendOplog({
      action: 'vault-delete',
      tier: 'full',
      items: { entryId },
      outcome: 'error',
      meta: { error, reason }
    });
    return { success: false, error };
  }

  store.updateManifestEntry(entryId, (e) => {
    e.status = 'deleted';
    e.deletedAt = new Date().toISOString();
    e.meta = e.meta || {};
    e.meta.deleteReason = reason;
  });

  store.appendOplog({
    action: 'vault-delete',
    tier: 'full',
    items: {
      entryId,
      files: asArray(entry.files).length,
      registry: asArray(entry.registry).length
    },
    outcome: 'success',
    meta: { reason, irreversible: true }
  });

  return { success: true };
}

function removeEntryFolder(entryId) {
  try {
    fs.rmSync(path.join(store.vaultRoot(), entryId), { recursive: true, force: true });
  } catch {
    /* best effort; the manifest status is the source of truth */
  }
}

// FLOW-03 auto-purge branch: runs at startup, only when the user enabled it.
async function autoPurgeSweep() {
  const settings = store.readSettings();
  if (!settings.autoPurgeEnabled) return { swept: 0, skipped: 'disabled' };

  const retentionDays = settings.autoPurgeRetentionDays;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const due = store
    .readManifest()
    .entries.filter((e) => e.status === 'quarantined' && Date.parse(e.createdAt) <= cutoff);

  let swept = 0;
  for (const entry of due) {
    const res = await deleteForever(entry.id, `auto-purge after ${retentionDays} day(s)`);
    if (res.success) swept += 1;
  }

  if (swept > 0) {
    store.appendOplog({
      action: 'vault-auto-purge',
      tier: 'full',
      items: { swept, retentionDays },
      outcome: 'success'
    });
  }
  return { swept };
}

module.exports = { init, quarantine, list, restore, deleteForever, autoPurgeSweep };
