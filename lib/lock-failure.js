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
function lockFailuresFrom(entry) {
  const files = Array.isArray(entry && entry.files) ? entry.files : [];
  const out = [];
  for (const f of files) {
    if (!f || f.status !== 'failed') continue;
    if (!isLockFailure(f.error)) continue;
    const p = typeof f.originalPath === 'string' ? f.originalPath : '';
    if (!p) continue;
    out.push({ path: p, reason: String(f.error || '') });
  }
  return out;
}

module.exports = { isLockFailure, lockFailuresFrom };
