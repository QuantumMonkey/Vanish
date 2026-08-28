// Vanish on-disk store (04-schema.md).
// The main process is the ONLY writer for manifest.json, settings.json,
// queue.json and oplog.jsonl (schema rule 7). The renderer reads through IPC;
// scanner.ps1 only writes payloads inside a vault entry folder.
// All writes are atomic: temp file + rename (schema rule 7).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

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
  assertAdminOwner(vaultRoot());
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

// Operator report, live testing 2026-08-10: an elevation attempt could
// report success (Start-Process did not throw) and the app would close and
// reopen, but the new process came back in Audit Mode - "loops" from the
// outside, with no error surfaced anywhere. A one-shot marker written just
// before quitting (attemptElevatedRelaunch), read and always deleted on the
// very next boot, is what lets main.js tell apart "elevation genuinely
// failed silently" from "Vanish's own tier detection is wrong" instead of
// guessing from black-box symptoms.
function elevationAttemptPath() {
  return path.join(dataDir(), 'elevation-attempt.json');
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

// --- isp: keep SEC-3 true instead of true-when-last-checked ------------------
//
// SEC-3 locks this directory so the elevated engine is not reading its
// instructions out of a folder a standard user can rewrite. Set-VanishDataDirAcl
// does that correctly - and then the protection DECAYED, measured live on
// 2026-08-28: check-data-dir said protected, a run wrote 58 purges to the vault,
// and check-data-dir then said NOT protected, naming vault/manifest.json as
// owned by the interactive user.
//
// The cause is not the DACL, which inherits fine. It is the OWNER, which does
// not. Windows assigns a newly created object to its creator unless
// HKLM\SYSTEM\CurrentControlSet\Control\Lsa\nodefaultadminowner says
// otherwise, and that value is unset by default. So even running ELEVATED, our
// own atomic write - temp file, then rename over the target - produced a file
// owned by 'Anand'. An owner permanently retains WRITE_DAC and can hand itself
// write access back whatever the DACL says, so the guard was right to call that
// a problem; it was our writes that were creating it.
//
// Three fixes were on the table (bd isp). Re-securing the whole tree after each
// mutation, and teaching the check to forgive an owner who is also the current
// elevated user, were both rejected: the second one weakens the control to make
// a test pass, since the SAME SID unelevated still holds WRITE_DAC. This is the
// first option - set the owner at the write, so that at every moment anyone
// looks, a foreign owner genuinely means somebody else wrote here.
//
// COST, measured: icacls /setowner on one file is ~48ms. That is paid per
// manifest/settings/queue write, which are user-paced actions, not a loop.
//
// OFF BY DEFAULT. Only an elevated process can take ownership, and an
// unelevated one attempting it would burn 48ms per write to fail. main.js turns
// this on once the tier is resolved, so Audit Mode pays nothing.
let ownershipEnforced = false;

function setOwnershipEnforcement(enabled) {
  ownershipEnforced = enabled === true && process.platform === 'win32';
  return ownershipEnforced;
}

function ownershipEnforcementEnabled() {
  return ownershipEnforced;
}

// Never throws. A failure here must not take down the write it is protecting -
// the file is already on disk and correct; only the ownership claim was missed.
// The check that reads ownership is the one that gets to have an opinion about
// that, and it will say so in its own words.
function assertAdminOwner(target) {
  if (!ownershipEnforced) return { applied: false, reason: 'not-enforced' };
  if (!target) return { applied: false, reason: 'no-target' };
  try {
    // *S-1-5-32-544 is BUILTIN\Administrators by SID, not by name: the group is
    // renamed on localised and hardened installs, and a name lookup would fail
    // there silently. /C keeps going on a per-file error, /Q suppresses the
    // success chatter we would only throw away.
    execFileSync('icacls.exe', [target, '/setowner', '*S-1-5-32-544', '/C', '/Q'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: err.message };
  }
}

function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  // isp: the rename above REPLACES the destination with a brand-new object,
  // and Windows gives a new object to its CREATOR, not to Administrators.
  // Every atomic write therefore re-created the exact evidence SEC-3 watches
  // for, so the guard decayed on our OWN writes. Claim it back here, while we
  // still know a write happened, rather than leaving the directory looking
  // tampered-with until some later elevated boot happens to re-secure it.
  assertAdminOwner(file);
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
  // Guided tour (spotlight walkthrough of the sidebar tabs) auto-shows once,
  // the first time this flips to true, and never again automatically -
  // replaying it after that is a deliberate click on "Take the tour" in
  // Settings, not something that should re-interrupt a returning user.
  hasSeenTour: false,
  // kp0: the one-time explanation shown before the FIRST manual ping tap
  // (what is sent, to where, that it is the app's only outbound traffic).
  // Remembered so it does not re-interrupt every tap after the first.
  pingConsentGiven: false,
  // A SEPARATE consent from the ping, deliberately. A single ICMP echo to
  // your own router and a 30MB transfer to a company in another country are
  // not the same act, and one checkbox covering both would be consent by
  // sleight of hand. Accepting the ping must never silently authorise this.
  speedTestConsentGiven: false,
  // d6y: single-item Clean Uninstall's default for the "run silently" toggle
  // on the wizard's config screen. Some vendor uninstallers offer a
  // keep-my-settings choice, or a reason-for-leaving step that unlocks a
  // refund/licence release, that a silent switch skips entirely - the choice
  // is per-uninstall (the wizard checkbox), this is only what it starts
  // checked to, remembered from whatever was picked last time. Bulk queue
  // uninstalls are unaffected by this setting on purpose - unattended is the
  // whole point of a queue, so it always prefers silent with interactive
  // uninstallers flagged "needs attention" rather than exposing a per-item
  // choice that would defeat walking away from it.
  preferSilentUninstall: true,
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
  if (typeof merged.hasSeenTour !== 'boolean') merged.hasSeenTour = false;
  if (typeof merged.pingConsentGiven !== 'boolean') merged.pingConsentGiven = false;
  if (typeof merged.speedTestConsentGiven !== 'boolean') merged.speedTestConsentGiven = false;
  if (typeof merged.preferSilentUninstall !== 'boolean') merged.preferSilentUninstall = true;
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

// bu2 reads the oplog back: zrw's recorded install deltas are the only input
// that can justify calling a directory "orphaned", because they are the only
// record of who CREATED it rather than an inference drawn afterwards.
//
// Tolerant by design. The oplog is append-only JSONL written across many app
// versions; one malformed or half-written line (a crash mid-append) must cost
// that line, not the whole history. Rotated files are not read - a delta old
// enough to have rotated out is old enough that the directory has almost
// certainly changed hands.
function readOplog(filter) {
  try {
    const file = oplogPath();
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      if (filter && rec.action !== filter) continue;
      out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

// Flattens install-snapshot-diff records into the { path, program, at } shape
// lib/attribution.js consumes. One record can carry several paths; each is an
// independent claim about one directory.
function recordedInstalls() {
  const rows = [];
  for (const rec of readOplog('install-snapshot-diff')) {
    const paths = (rec.items && Array.isArray(rec.items.paths)) ? rec.items.paths : [];
    const program = (rec.meta && rec.meta.program) || null;
    for (const p of paths) {
      if (typeof p === 'string' && p) rows.push({ path: p, program, at: rec.ts || null });
    }
  }
  return rows;
}

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
    const existed = fs.existsSync(file);
    fs.appendFileSync(file, line + '\n', 'utf8');
    // isp: an APPEND leaves the owner alone, so only the write that CREATES
    // the file can introduce a foreign one. Rotation renames the old log away
    // and the next append creates a fresh file, which is why this is keyed on
    // existence rather than done once per boot.
    if (!existed) assertAdminOwner(file);
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
  elevationAttemptPath,
  newId,
  readJson,
  writeJsonAtomic,
  setOwnershipEnforcement,
  ownershipEnforcementEnabled,
  assertAdminOwner,
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
  readOplog,
  recordedInstalls,
  directorySize
};
