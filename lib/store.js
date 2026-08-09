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

// SEC-3: Vanish state used to live directly in the Electron userData root -
// which is also Chromium's profile directory. That made the directory
// impossible to lock down, because the ACL that stops a standard user
// rewriting manifest.json (which the engine reads as ELEVATED instructions) is
// the same ACL that stops Chromium writing Preferences, Cache and Local Storage
// when the app next runs in Audit Mode. State now lives in a subdirectory
// nothing but Vanish writes, so it can be locked without breaking the app.
const STATE_DIR = 'vanish-state';

let dataRoot = null;

function init(userDataPath) {
  dataRoot = path.join(userDataPath, STATE_DIR);
  migrateLegacyState(userDataPath); // before anything is created below it
  fs.mkdirSync(vaultRoot(), { recursive: true });
}

// One-time move of an existing install's state into the new subdirectory.
// Deliberately per-item and non-fatal: a half-finished migration must leave
// what it could not move exactly where it was, never lose a vault payload.
function migrateLegacyState(userDataPath) {
  const legacy = [
    ['vault', path.join(userDataPath, 'vault')],
    ['settings.json', path.join(userDataPath, 'settings.json')],
    ['queue.json', path.join(userDataPath, 'queue.json')],
    ['oplog.jsonl', path.join(userDataPath, 'oplog.jsonl')]
  ];

  const pending = legacy.filter(([, from]) => fs.existsSync(from));
  if (pending.length === 0) return;

  fs.mkdirSync(dataRoot, { recursive: true });
  for (const [name, from] of pending) {
    const to = path.join(dataRoot, name);
    if (fs.existsSync(to)) continue; // already migrated - never clobber
    try {
      fs.renameSync(from, to);
    } catch (err) {
      console.error(`Could not migrate ${name} into the state directory:`, err.message);
    }
  }
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
// bfh.2: what a network hold changed, written BEFORE anything is changed. If
// Vanish dies mid-session this file is how the machine gets put back.
function networkHoldPath() {
  return path.join(dataDir(), 'network-hold.json');
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
// 'audit' (default): unchanged FLOW-01 behaviour, a manual click elevates.
// 'full': main.js asks Windows for elevation automatically at startup, before
// any window exists, instead of waiting for that click (operator request
// 2026-08-03). Windows' own UAC consent prompt is not bypassed either way -
// this only changes who initiates the request, not whether the OS asks.
const STARTUP_MODES = ['audit', 'full'];

const SETTINGS_DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  autoPurgeEnabled: false,        // Rule 1 / Rule 2: off by default
  autoPurgeRetentionDays: 30,
  processRefreshSeconds: 2,       // NFR-03
  defaultScanMode: 'Moderate',    // Rule 1: discovery depth, NOT deletion policy
  confirmBeforeQuarantine: true,
  startupMode: 'audit',           // safe-by-default; the operator opts in per machine
  // Operator-proposed throttle for Network Activity's own refresh, separate
  // from processRefreshSeconds (Task Manager) - 0 means manual ("Measure
  // again") only, matching today's behaviour exactly until someone opts in.
  networkRefreshSeconds: 0,
  // Redundancy groups (Get-SoftwareRedundancy) a user has explicitly chosen
  // to keep as-is - e.g. "I use different browsers for different needs."
  // Waiving does not hide the group; it keeps showing with an override
  // notice and the same decision buttons (renderRedundancyGroups). Keyed by
  // category name (scanner.ps1's $categories keys are a fixed, stable set).
  redundancyWaivers: [],
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
  merged.networkRefreshSeconds = clampInt(merged.networkRefreshSeconds, 0, 300, 0);
  if (!Array.isArray(merged.redundancyWaivers)) merged.redundancyWaivers = [];
  merged.redundancyWaivers = [...new Set(merged.redundancyWaivers.map(String))];
  // Schema rule 5: an unknown enum value falls back, it never crashes a reader.
  if (!SCAN_MODES.includes(merged.defaultScanMode)) merged.defaultScanMode = 'Moderate';
  if (!STARTUP_MODES.includes(merged.startupMode)) merged.startupMode = 'audit';
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
  queuePath,
  networkHoldPath,
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
