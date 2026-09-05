// h55: is this removal failure a LOCK, as opposed to a permission problem or a
// path that was already gone?
//
// ONE CLASSIFIER, IN ONE PLACE, ON PURPOSE. This test used to live only in
// renderer/wizard.js, where it decided whether a failed item gets a "Find what
// is holding it" button. h55 needs the same question answered in the MAIN
// process, when the failure is recorded - and this repository has now been
// bitten three times in one week by the same shape of defect: a rule
// reimplemented beside itself, the two copies drifting, and the mirror
// reporting confidently about behaviour the original does not have. So the
// main process classifies, writes the verdict down, and the renderer reads the
// verdict rather than re-deriving it.
//
// WHAT IT IS NOT. This is a match on the message Windows gave us, not a claim
// about the file. "Locked" here means "the failure reads like something is
// holding it open", which is the only thing a returned error string can
// support. Whether anything is holding it NOW is a separate question, asked by
// list-lockers at the moment the user opens the item - by which time it is
// often no longer true, which is exactly why the list prunes on read.

'use strict';

// Deliberately the same expression the renderer shipped with, character for
// character, rather than an improved one. Changing the behaviour and moving it
// in the same commit would make a regression here impossible to attribute.
const LOCK_PATTERN = /lock|in use|being used|another process/i;

function isLockFailure(error) {
  return LOCK_PATTERN.test(String(error || ''));
}

// The failed FILE rows of a quarantine result that look like locks, flattened
// to the four facts the Unlocker's quick-pick shows: which path, what tried to
// remove it, when, and why it failed. Registry rows are excluded - a registry
// key is not something list-lockers can be asked about.
//
// 2brn: THE WRITE IS CAPPED AT THE READER'S LIMIT, and the two numbers are
// named together here so they cannot drift apart silently.
//
// store.lockedPaths() stops at 50. This wrote every locked path there was, so
// on a bulk uninstall where hundreds of files were held open, everything past
// the fiftieth was written and could never be read - while still consuming the
// oplog's 5 MB rotation budget (OPLOG_ROTATE_BYTES). Rotation evicts the
// OLDEST records, so unreadable rows push out the elevation history the
// diagnostic collector needs. A bound that exists in the reader and not in the
// writer is not a bound; it is a filter over a queue that is still growing.
const LOCK_PATH_LIMIT = 50;

function lockFailuresFrom(entry) {
  const files = Array.isArray(entry && entry.files) ? entry.files : [];
  const out = [];
  let dropped = 0;
  for (const f of files) {
    if (!f || f.status !== 'failed') continue;
    if (!isLockFailure(f.error)) continue;
    const p = typeof f.originalPath === 'string' ? f.originalPath : '';
    if (!p) continue;
    // Enforced in the loop that grows the list, not asserted above it.
    if (out.length >= LOCK_PATH_LIMIT) { dropped += 1; continue; }
    out.push({ path: p, reason: String(f.error || '') });
  }
  // The count is a RETURN VALUE, not a property hung off the array. The first
  // version of this used a non-enumerable property, which JSON.stringify drops
  // - so the number would have vanished on its way into the oplog, which is
  // the one place it needed to arrive.
  //
  // Counted rather than silently truncated, for the same reason the Unlocker
  // names the paths it prunes on read: saying how many were left out is the
  // difference between capping and hiding.
  return { paths: out, dropped };
}

// The renderer used to keep its own copy of isLockFailure, because it cannot
// require this module across the context bridge. That copy decided whether a
// failed item gets a "Find what is holding it" button - so the same rule ran
// twice, in two languages of the same language, free to drift.
//
// A guard was written for it and the guard was a tautology: it matched both
// files against the same hardcoded literal and asserted the results were
// equal, which they necessarily are whenever both match.
//
// So the copy is gone instead. The main process classifies once, here, and
// writes the verdict into the payload the renderer already receives; the
// renderer reads a boolean. A value cannot drift from the rule that produced
// it, which is the only version of this that stays true without a test
// watching it.
// The other half of the same question, and it had a real bug in it.
//
// The renderer's copy was /denied|access|unauthoriz|protected|permission/i.
// Windows' standard lock message is:
//
//   "The process cannot access the file because it is being used by another
//    process."
//
// It contains "access". So EVERY LOCKED FILE was also offered "Take ownership
// and retry" - a destructive ACL change, on the user's own file, as the
// suggested remedy for a problem it cannot possibly solve. Found by covering
// this screen for the first time; nothing in the suite had ever looked at it.
const ACL_PATTERN = /denied|access|unauthoriz|protected|permission/i;

// A lock WINS over a permission reading when both match. The lock phrasing is
// specific and deliberate; the "access" hit inside it is a substring
// coincidence. The two remedies are mutually exclusive in the UI, so they have
// to be mutually exclusive here rather than by luck of evaluation order.
function isAclFailure(error) {
  if (isLockFailure(error)) return false;
  return ACL_PATTERN.test(String(error || ''));
}

function annotateLockFailures(entry) {
  const files = Array.isArray(entry && entry.files) ? entry.files : [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const failed = f.status === 'failed';
    f.lockSuspected = failed && isLockFailure(f.error);
    f.aclSuspected = failed && isAclFailure(f.error);
  }
  return entry;
}

module.exports = { isLockFailure, isAclFailure, lockFailuresFrom, annotateLockFailures, LOCK_PATH_LIMIT };
