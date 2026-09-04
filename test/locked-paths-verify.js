// h55: the Unlocker's quick-pick, and the rules that keep it from becoming a
// list the operator has to maintain.
//
//   node test/locked-paths-verify.js
//
// The design pass on h55 found the real blocker: THERE WAS NO SOURCE ON DISK.
// The oplog recorded counts only ("3 failed"), and the vault manifest carries
// per-item failures but is only written when at least one item succeeded - so a
// purge where EVERY item was locked wrote nothing anywhere. The fix is not a new
// store, it is the existing record being honest: which three, and why.
//
// That also dissolved the open operator decision this issue was parked on ("a
// new piece of persisted state, accumulating quietly"). Nothing new
// accumulates: the oplog already existed, already recorded this event, already
// rotates at 5 MB, and already never leaves the device.
//
// WHAT IS ASSERTED HERE is the read side and the pruning, because those are the
// rules that decide whether this ages into noise:
//
//   newest first, one row per path, capped
//   a record written before this feature existed reads as no locks, not as an error
//   a failure that is NOT a lock never appears
//   registry failures never appear (list-lockers cannot be asked about a key)
//
// The "path no longer exists" prune lives in main.js's IPC handler and is
// asserted in test/locked-paths-ipc-verify.js, which can drive the handler.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}

const { isLockFailure, lockFailuresFrom } = require('../lib/lock-failure');
const store = require('../lib/store');

console.log('');
console.log('Locked paths, remembered and pruned (h55)');
console.log('=========================================');

// ---------------------------------------------------------------------------
console.log('');
console.log('The classifier, and the copy of it the renderer still needs');

assert(isLockFailure('The process cannot access the file because it is being used by another process.'),
  'the message Windows actually returns for a locked file is classified as a lock');
assert(isLockFailure('The file is in use'), 'so is "in use"');
assert(!isLockFailure('Access to the path is denied.'),
  'a permissions failure is NOT a lock - it has its own button, and offering the wrong one wastes the click');
assert(!isLockFailure('Could not find file'), 'and neither is a path that was already gone');
assert(!isLockFailure(''), 'an empty reason is not a lock');
assert(!isLockFailure(null), 'and neither is a missing one');

// THE MIRROR. renderer/wizard.js cannot require a lib module across the context
// bridge, so it keeps its own copy of this expression. Two copies that differ
// is the defect this repository keeps rediscovering - a rule reimplemented
// beside itself, drifting, with the mirror reporting confidently about
// behaviour the original does not have. This asserts they are the same
// expression, so improving one without the other fails here rather than in
// front of a user.
const wizardSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'wizard.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lock-failure.js'), 'utf8');
const wizardPattern = (wizardSrc.match(/\/lock\|in use\|being used\|another process\/i/) || [])[0];
const libPattern = (libSrc.match(/\/lock\|in use\|being used\|another process\/i/) || [])[0];
assert(Boolean(wizardPattern) && wizardPattern === libPattern,
  'the renderer copy and the lib copy are the same expression, character for character',
  `wizard: ${wizardPattern} | lib: ${libPattern}`);

// ---------------------------------------------------------------------------
console.log('');
console.log('What gets recorded from a purge result');

const entry = {
  files: [
    { originalPath: 'C:\\a\\locked.dll', status: 'failed', error: 'being used by another process' },
    { originalPath: 'C:\\a\\denied.dll', status: 'failed', error: 'Access to the path is denied.' },
    { originalPath: 'C:\\a\\fine.dll', status: 'quarantined', error: null },
    { originalPath: '', status: 'failed', error: 'it is locked' },
  ],
  registry: [
    { keyPath: 'HKCU\\Software\\Thing', status: 'failed', error: 'the key is in use' },
  ],
};

const found = lockFailuresFrom(entry);
assert(found.length === 1, `only the locked FILE is recorded (${found.length})`, JSON.stringify(found));
assert(found[0] && found[0].path === 'C:\\a\\locked.dll', 'and it is the right one');
assert(found[0] && /another process/.test(found[0].reason),
  'with the reason Windows gave, not a reason of our own', JSON.stringify(found[0]));
assert(!found.some((f) => /denied/i.test(f.reason)),
  'a permissions failure is not recorded here - it is a different problem with a different button');
assert(!found.some((f) => /HKCU/i.test(f.path)),
  'and a registry key is never recorded, because list-lockers cannot be asked about one');
assert(!found.some((f) => f.path === ''),
  'a failed row with no path is dropped rather than recorded as an empty entry');

assert(lockFailuresFrom({}).length === 0, 'an entry with no files yields nothing');
assert(lockFailuresFrom(null).length === 0, 'and neither does a missing entry');

// ---------------------------------------------------------------------------
console.log('');
console.log('Reading them back out of the operation log');

// A real store on a temp data dir, so this exercises readOplog rather than a
// stand-in for it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-h55-'));
store.init(tmp);

function log(when, lockedPaths, sourceApp) {
  const rec = {
    ts: when,
    action: 'quarantine',
    tier: 'full',
    items: { requested: 1, quarantined: 0, failed: 1 },
    outcome: 'partial',
    meta: { sourceApp },
  };
  if (lockedPaths) rec.items.lockedPaths = lockedPaths;
  fs.appendFileSync(store.oplogPath(), JSON.stringify(rec) + '\n', 'utf8');
}

// Oldest first on disk, as the real log is written.
log('2026-01-01T10:00:00Z', [{ path: 'C:\\old.dll', reason: 'in use' }], 'OldApp');
log('2026-01-02T10:00:00Z', null, 'NoLocksApp');            // a run with no locks
log('2026-01-03T10:00:00Z', [{ path: 'C:\\new.dll', reason: 'locked by X' }], 'NewApp');
log('2026-01-04T10:00:00Z', [{ path: 'C:\\OLD.DLL', reason: 'still in use' }], 'OldApp');

const rows = store.lockedPaths(50);
assert(rows.length === 2, `one row per path, not one per failure (${rows.length})`, JSON.stringify(rows));
assert(rows[0] && rows[0].path === 'C:\\OLD.DLL',
  'newest first, so the most recent problem is the first thing offered', JSON.stringify(rows.map((r) => r.path)));
assert(rows[0] && rows[0].reason === 'still in use',
  'and the newest sighting supplies the reason, not the first one ever seen');
assert(rows[0] && rows[0].sourceApp === 'OldApp' && rows[0].at === '2026-01-04T10:00:00Z',
  'each row carries what tried to remove it and when - the facts that make it legible a week later',
  JSON.stringify(rows[0]));
assert(rows.some((r) => r.path === 'C:\\new.dll'), 'the other path survives too');

// A path that failed under two different names differing only in case is ONE
// problem. Windows paths are case-insensitive and showing it twice would be
// this list starting to lie about how much is wrong.
assert(new Set(rows.map((r) => r.path.toLowerCase())).size === rows.length,
  'no path appears twice under a different case');

const capped = store.lockedPaths(1);
assert(capped.length === 1, 'the cap is honoured');
assert(capped[0].path === 'C:\\OLD.DLL', 'and it keeps the newest, not the first it happened to read');

// ---------------------------------------------------------------------------
console.log('');
console.log('Records written before this feature existed');

const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-h55-old-'));
store.init(tmp2);
fs.appendFileSync(store.oplogPath(),
  JSON.stringify({ ts: '2025-12-01T10:00:00Z', action: 'quarantine', items: { requested: 3, quarantined: 0, failed: 3 } }) + '\n',
  'utf8');
const oldOnly = store.lockedPaths();
assert(oldOnly.length === 0,
  'an old count-only record yields nothing rather than throwing - every oplog in the wild predates this field',
  JSON.stringify(oldOnly));

// A half-written line, which readOplog is already tolerant of, must not take
// the list down with it.
fs.appendFileSync(store.oplogPath(), '{"ts":"2025-12-02T10:00:00Z","action":"quar\n', 'utf8');
fs.appendFileSync(store.oplogPath(),
  JSON.stringify({ ts: '2025-12-03T10:00:00Z', action: 'quarantine', items: { lockedPaths: [{ path: 'C:\\after-crash.dll', reason: 'locked' }] } }) + '\n',
  'utf8');
const afterCrash = store.lockedPaths();
assert(afterCrash.length === 1 && afterCrash[0].path === 'C:\\after-crash.dll',
  'a malformed line costs that line, not the whole history', JSON.stringify(afterCrash));

for (const d of [tmp, tmp2]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
