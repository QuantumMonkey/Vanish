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

// z71u: THE SAME READ, BUT ABLE TO SAY WHY IT FAILED.
//
// readJson above answers "absent" and "I could not read it" with the identical
// value, which is the aeu defect applied to our own state. For settings and the
// queue that is survivable - both regenerate, and their defaults fail safe. For
// the VAULT MANIFEST it was data loss: an empty read fed straight into
// addManifestEntry, which pushed one entry and atomically renamed the result
// over a manifest that still held every other entry's restore record.
//
// So the manifest gets a reader that distinguishes the two, and readJson keeps
// its shape for the callers where a default genuinely is the right answer.
//
//   { missing: true }            the file is not there. First run. Use the default.
//   { ok: true, value }          read and parsed.
//   { ok: false, error }         it EXISTS and we could not have it. Not a default.
function readJsonDetailed(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT is the only error that means "there is nothing here". Everything
    // else - EACCES after the SEC-3 ACL pass, EBUSY from a scanner holding the
    // file, EIO - means something IS here and we were denied it.
    if (err && err.code === 'ENOENT') return { ok: false, missing: true, error: null };
    return { ok: false, missing: false, error: err };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, missing: false, error: err };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, missing: false, error: new Error('not a JSON object') };
  }
  return { ok: true, missing: false, value: parsed, error: null };
}

// Thrown rather than returned, because every caller that reads the manifest
// does so in order to WRITE it back, and there is no useful value to hand them.
// Carries a code so a caller can tell this apart from an ordinary failure.
class ManifestUnreadableError extends Error {
  constructor(detail) {
    super(
      'The quarantine manifest exists but could not be read (' + detail + '). ' +
      'Vanish will not write over it, because doing so would discard the record ' +
      'of everything already in the vault. The payloads are still on disk.'
    );
    this.name = 'ManifestUnreadableError';
    this.code = 'MANIFEST_UNREADABLE';
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

// z71u: A MANIFEST THAT EXISTS AND CANNOT BE READ IS NOT AN EMPTY MANIFEST.
//
// This used to be readJson(manifestPath(), defaultManifest()), so any read or
// parse failure produced { entries: [] }. Two things followed, and the second
// was not reversible: the Quarantine screen said "Nothing in quarantine yet"
// over a full vault, and the next addManifestEntry wrote a ONE-ENTRY manifest
// on top of the real one, discarding every other entry's originalPath. The
// payloads survived under vault\<uuid> with nothing left to say what they were.
//
// Throwing is the whole fix. Every caller reads this in order to write it back,
// so there is no partial answer worth returning - and the one caller that only
// reads, vault-list, already turns a throw into success:false and the renderer
// already paints that as an error rather than as an empty vault.
//
// The coercions below are kept ONLY for a manifest that read cleanly. A file
// that parsed but whose entries key is not an array is corruption, not an old
// schema, and silently replacing it with [] is the same data loss by a
// different route.
function readManifest() {
  const read = readJsonDetailed(manifestPath());

  if (read.missing) return defaultManifest(); // genuinely first run
  if (!read.ok) throw new ManifestUnreadableError(read.error ? read.error.message : 'unknown error');

  const m = read.value;
  if (!Array.isArray(m.entries)) {
    throw new ManifestUnreadableError('its entries list is missing or is not a list');
  }
  if (typeof m.schemaVersion !== 'number') m.schemaVersion = SCHEMA_VERSION;
  return m;
}

function writeManifest(manifest) {
  // Unknown keys are preserved by construction: callers mutate the object they read.
  manifest.schemaVersion = SCHEMA_VERSION;

  // z71u: keep the previous manifest. readManifest above stops US from
  // destroying it, but nothing stops a half-completed write, a disk error or
  // something outside this app. One copy turns any future instance of this
  // class from data loss into an inconvenience, and it costs one file
  // operation on an action the user already waited for.
  //
  // Best-effort on purpose: failing to take a backup must never stop the write
  // that the caller is actually here for.
  try {
    const live = manifestPath();
    if (fs.existsSync(live)) {
      const backup = live + '.bak';
      fs.copyFileSync(live, backup);
      // The backup is a new object too, so it needs the same owner claim the
      // atomic write makes - otherwise it becomes the thing SEC-3 reports.
      assertAdminOwner(backup);
    }
  } catch {
    /* the write below matters more than the backup */
  }

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

// mp4: can this process write to its own state directory?
//
// SEC-3 grants Users ReadAndExecute only, and settings.json is elevated-engine
// input (scan mode, auto-purge), so an unelevated Vanish being unable to
// change it is CORRECT. What was not correct is what happened next: the write
// threw EPERM, the IPC handler rejected, the renderer had no catch, and the
// line after the await -- toast("Setting saved.") -- simply never ran. The
// checkbox stayed where the click put it and the user was told nothing.
//
// So the app has to KNOW, before offering the control, rather than finding out
// by failing. One probe: create a temp file in the directory and delete it.
// Cheap, definitive, and it tests the actual operation rather than reasoning
// about an ACL - which is the same reason Test-VanishDataDirAcl reads the
// owner instead of trusting the DACL.
//
// Deliberately NOT cached. An elevated relaunch shares no state with the
// process that answered before it, and secure-data-dir can run mid-session.
function canWriteState() {
  try {
    ensureInit();
  } catch {
    return { writable: false, reason: 'Vanish has not finished starting up.' };
  }
  const probe = path.join(dataDir(), `.write-probe.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(probe, '', 'utf8');
    fs.unlinkSync(probe);
    return { writable: true, reason: null };
  } catch (err) {
    try { fs.unlinkSync(probe); } catch { /* it was never created */ }
    return { writable: false, reason: err.code === 'EPERM' || err.code === 'EACCES'
      ? 'Vanish\u0027s settings folder is locked to administrators on this machine.'
      : err.message };
  }
}

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

// h55: paths VANISH ITSELF failed to remove because something was holding them.
// Same shape as recordedInstalls above - one oplog record can carry several
// paths, and each is an independent claim about one file.
//
// NOTHING ELSE ON THE MACHINE KNOWS THIS SET, which is the whole reason it is
// worth surfacing. Resource Monitor's Associated Handles and Process Explorer's
// Find Handle both answer "what is holding this path RIGHT NOW" and the
// operator already has both; neither has any idea which paths a removal
// attempt tripped over last Tuesday.
//
// IT PRUNES ITSELF AND KEEPS NO STATE OF ITS OWN. Newest first, one row per
// path (a path that failed four times is one problem, not four), capped, and
// every dead entry is dropped at READ time rather than maintained: the caller
// drops any path that no longer exists, and the Unlocker drops any that turns
// out to have no holders when it is actually asked. The oplog's own 5 MB
// rotation is the long-run bound, so there is no list to clear and no list to
// grow stale.
function lockedPaths(limit = 50) {
  const seen = new Set();
  const rows = [];
  // Oldest-to-newest on disk, so walk backwards to get newest-first and let the
  // first sighting of a path win.
  const recs = readOplog('quarantine');
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const rec = recs[i];
    const list = rec && rec.items && Array.isArray(rec.items.lockedPaths) ? rec.items.lockedPaths : [];
    for (const row of list) {
      if (!row || typeof row.path !== 'string' || !row.path) continue;
      const key = row.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        path: row.path,
        reason: typeof row.reason === 'string' ? row.reason : '',
        at: rec.ts || null,
        sourceApp: (rec.meta && rec.meta.sourceApp) || null
      });
      if (rows.length >= limit) return rows;
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
  manifestPath,
  oplogPath,
  lockedPaths,
  queuePath,
  networkHoldPath,
  elevationAttemptPath,
  newId,
  readJson,
  readJsonDetailed,
  ManifestUnreadableError,
  writeJsonAtomic,
  canWriteState,
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
