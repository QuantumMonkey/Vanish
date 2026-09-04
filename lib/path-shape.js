// One answer to "is this a path we are willing to touch", instead of four.
//
// WHY THIS EXISTS. The same rule was written three times and forgotten once:
//
//   scanner.ps1  Get-InstallFolderCreated   drive-letter + explicit UNC reject
//   main.js      parseDisplayIcon           drive-letter, no UNC line
//   main.js      parseLocalDirectory        drive-letter + explicit UNC reject
//   main.js      get-locked-paths           nothing - called existsSync directly
//
// The omission was not cosmetic. fs.existsSync on a dead UNC path costs
// 1,270 ms, measured, and get-locked-paths called it once per remembered path
// up to fifty - a minute of frozen UI in the Unlocker, on a list whose whole
// purpose is remembering a failure from last week, by which time the share is
// exactly the thing most likely to be gone.
//
// WHAT THIS CHECK ACTUALLY GUARANTEES, stated plainly because the three
// comments it replaces all overclaimed:
//
//   IT DOES     refuse a relative path, which would otherwise resolve against
//               whatever the process's working directory happens to be, and
//               date or measure some unrelated folder.
//   IT DOES     refuse a UNC path, so no caller pays an SMB timeout for a
//               share that is not there.
//   IT DOES NOT prove the path is on a local disk. A mapped network drive is a
//               drive letter and is indistinguishable from a local one by
//               shape alone. Telling them apart needs the drive TYPE, which
//               Node cannot read without a subprocess.
//
// That last line used to read "which INV-4 forbids", in three places, about a
// check that cannot deliver it. Reading a share the user mapped themselves is
// not data leaving the device, so the residual is small - but the comment
// claiming otherwise was the actual defect, because the next person to touch
// one of these sites would have trusted it.

'use strict';

// No backslash literal anywhere in this file. The first version of the icon
// parser was written as /^[A-Za-z]:[\\/]/ and reached the working tree as
// /^[A-Za-z]:[\/]/ - a class matching only a forward slash - so every Windows
// path was rejected, all 87 icons came back null, and nothing failed, because
// a function that answers null for everything still satisfies every assertion
// about answering null safely.
const SEP = String.fromCharCode(92);

// Returns the cleaned path, or null. Callers treat null as "not ours to
// touch" and must not fall back to using the raw value.
function localRootedPath(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (!s) return null;

  // Registry values carry both of these routinely.
  s = s.replace(/^"(.*)"$/, '$1').trim();
  if (!s) return null;

  // Trim trailing separators, but never past the root: "C:\" is a real
  // directory and "C:" is a drive-relative path, which is the thing being
  // refused two lines down.
  while (s.length > 3 && (s.endsWith(SEP) || s.endsWith('/'))) s = s.slice(0, -1);

  if (s.length < 3) return null;

  // REDUNDANT, and said so rather than left to imply otherwise. The
  // drive-letter rule below already refuses UNC - "\\\\" is not "X:" - and
  // mutation testing proved it by deleting this line and changing nothing.
  // Kept as stated intent, so someone relaxing the regex below has to notice
  // this too. The same redundancy exists in scanner.ps1's copy for the same
  // reason; what matters is that neither comment claims to be the protection.
  if (s.startsWith(SEP + SEP) || s.startsWith('//')) return null;

  if (!/^[A-Za-z]:$/.test(s.slice(0, 2))) return null;            // must be a drive
  if (s[2] !== SEP && s[2] !== '/') return null;                  // and rooted, not drive-relative

  return s;
}

// The DisplayIcon form: a path that may carry a trailing resource index.
// Split out rather than folded in, because the index is only ever valid in
// that one registry value and accepting it everywhere would let ",0" through
// on a path used for a directory walk.
function displayIconPath(raw) {
  if (typeof raw !== 'string') return null;
  // A trailing ",<digits>" or ",-<digits>" selects an icon inside a binary and
  // is never part of the filename. Anchored, so a comma inside a directory
  // name survives.
  return localRootedPath(raw.replace(/,\s*-?\d+\s*$/, ''));
}

module.exports = { localRootedPath, displayIconPath, SEP };
