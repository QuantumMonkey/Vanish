// Vanish on-disk store (04-schema.md).
// The main process is the ONLY writer for manifest.json, settings.json,
// queue.json and oplog.jsonl (schema rule 7). The renderer reads through IPC;
// scanner.ps1 only writes payloads inside a vault entry folder.
// All writes are atomic: temp file + rename (schema rule 7).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const OPLOG_ROTATE_BYTES = 5 * 1024 * 1024; // ENT-05

let dataRoot = null;

function init(userDataPath) {
  dataRoot = userDataPath;
  fs.mkdirSync(vaultRoot(), { recursive: true });
}

function ensureInit() {
  if (!dataRoot) throw new Error('Store used before init().');
}

function dataDir() {
  ensureInit();
  return dataRoot;
}
function vaultRoot() {
  ensureInit();
  return path.join(dataRoot, 'vault');
}
function manifestPath() {
  return path.join(vaultRoot(), 'manifest.json');
}
function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}
function queuePath() {
  return path.join(dataDir(), 'queue.json');
}
function oplogPath() {
  return path.join(dataDir(), 'oplog.jsonl');
}

function newId() {
  return crypto.randomUUID();
}

// --- atomic document IO ---------------------------------------------------

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// --- ENT-01 vault manifest ------------------------------------------------

function defaultManifest() {
  return { schemaVersion: SCHEMA_VERSION, entries: [] };
}

function readManifest() {
  const m = readJson(manifestPath(), defaultManifest());
  if (!Array.isArray(m.entries)) m.entries = [];
  if (typeof m.schemaVersion !== 'number') m.schemaVersion = SCHEMA_VERSION;
  return m;
}

function writeManifest(manifest) {
  // Unknown keys are preserved by construction: callers mutate the object they read.
  manifest.schemaVersion = SCHEMA_VERSION;
  writeJsonAtomic(manifestPath(), manifest);
}

function addManifestEntry(entry) {
  const manifest = readManifest();
  manifest.entries.push(entry);
  writeManifest(manifest);
  return entry;
}

function updateManifestEntry(entryId, mutate) {
  const manifest = readManifest();
  const entry = manifest.entries.find((e) => e.id === entryId);
  if (!entry) return null;
  mutate(entry);
  writeManifest(manifest);
  return entry;
}

function removeManifestEntry(entryId) {
  const manifest = readManifest();
  const before = manifest.entries.length;
  manifest.entries = manifest.entries.filter((e) => e.id !== entryId);
  if (manifest.entries.length !== before) writeManifest(manifest);
}

function getManifestEntry(entryId) {
  return readManifest().entries.find((e) => e.id === entryId) || null;
}

// --- ENT-02 settings ------------------------------------------------------

const SCAN_MODES = ['Safe', 'Moderate', 'Advanced'];

const SETTINGS_DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  autoPurgeEnabled: false,        // Rule 1 / Rule 2: off by default
  autoPurgeRetentionDays: 30,
  processRefreshSeconds: 2,       // NFR-03
  defaultScanMode: 'Moderate',    // Rule 1: discovery depth, NOT deletion policy
  confirmBeforeQuarantine: true,
  meta: {}
};

function readSettings() {
  const stored = readJson(settingsPath(), {});
  // Missing keys fall back to defaults (schema rule 3); unknown keys survive (rule 2).
  return { ...SETTINGS_DEFAULTS, ...stored, schemaVersion: SCHEMA_VERSION };
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch, schemaVersion: SCHEMA_VERSION };
  if (typeof merged.autoPurgeEnabled !== 'boolean') merged.autoPurgeEnabled = false;
  if (typeof merged.confirmBeforeQuarantine !== 'boolean') merged.confirmBeforeQuarantine = true;
  merged.autoPurgeRetentionDays = clampInt(merged.autoPurgeRetentionDays, 0, 3650, 30);
  merged.processRefreshSeconds = clampInt(merged.processRefreshSeconds, 1, 60, 2);
  // Schema rule 5: an unknown enum value falls back, it never crashes a reader.
  if (!SCAN_MODES.includes(merged.defaultScanMode)) merged.defaultScanMode = 'Moderate';
  writeJsonAtomic(settingsPath(), merged);
  return merged;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// --- ENT-04 queue ---------------------------------------------------------

function readQueue() {
  const q = readJson(queuePath(), { schemaVersion: SCHEMA_VERSION, items: [] });
  if (!Array.isArray(q.items)) q.items = [];
  return q;
}

function writeQueue(queue) {
  queue.schemaVersion = SCHEMA_VERSION;
  writeJsonAtomic(queuePath(), queue);
}

// --- ENT-05 operation log -------------------------------------------------

function appendOplog(record) {
  try {
    const file = oplogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const stat = fs.statSync(file);
      if (stat.size >= OPLOG_ROTATE_BYTES) {
        const stamp = new Date().toISOString().slice(0, 10);
        fs.renameSync(file, `${file}.${stamp}`);
      }
    } catch {
      /* no log yet */
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action: record.action,
      tier: record.tier || 'unknown',
      items: record.items || {},
      outcome: record.outcome || 'unknown',
      meta: record.meta || {}
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    // The audit trail must never take the app down; surface on stderr only.
    console.error('oplog append failed:', err.message);
  }
}

function directorySize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return total;
}

module.exports = {
  SCHEMA_VERSION,
  init,
  dataDir,
  vaultRoot,
  oplogPath,
  newId,
  readJson,
  writeJsonAtomic,
  readManifest,
  writeManifest,
  addManifestEntry,
  updateManifestEntry,
  removeManifestEntry,
  getManifestEntry,
  readSettings,
  writeSettings,
  readQueue,
  writeQueue,
  appendOplog,
  directorySize
};
