// Repo invariants (rkt3, z6k): facts about the working tree that no feature
// suite owns, and that therefore nothing has been checking.
//
//   node test/repo-invariants-verify.js
//
// Both assertions here exist because the thing they check DRIFTED silently and
// was found by a human reading a file rather than by a run:
//
//   rkt3  package-lock.json still said 0.3.0 while package.json said 0.9.4.
//         Six releases of drift. `npm ci` installs from the lock, so the
//         version stamped into a packaged build came from a file nobody was
//         watching, and no test could ever have failed because of it.
//   z6k   test/phase2-verify.ps1 was quarantined out from under run-all.ps1
//         and the runner reported it identically to a suite that crashed.
//         run-all.ps1 now separates those two states at RUN time; this
//         separates them at TEST time, which is earlier and cheaper -- a
//         registered suite that is not on disk fails here in under a second
//         instead of surfacing 40 minutes into a VM run.
//
// The shape to keep if this file grows: an invariant belongs here when it is
// about the REPOSITORY rather than about behaviour, and when its failure mode
// is silence.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
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

function skip(label, whyNot) {
  console.log(`  SKIP  ${label} -- ${whyNot}`);
}

console.log('');
console.log('The version is stamped in two files and only one of them is edited');
console.log('---------------------------------------------------------------');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

  assert(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version),
    `package.json carries a semver version (${pkg.version})`);

  // Both places npm writes it. The root key is what tooling reads; the
  // packages[""] entry is what `npm ci` reconstructs the tree from, and they
  // are written by different code paths, so they can disagree with each other
  // as well as with package.json.
  assert(lock.version === pkg.version,
    `package-lock.json root version matches package.json (${lock.version} === ${pkg.version})`);

  const selfEntry = lock.packages && lock.packages[''];
  if (selfEntry) {
    assert(selfEntry.version === pkg.version,
      `package-lock.json packages[""] version matches too (${selfEntry.version})`);
  } else {
    skip('package-lock.json packages[""] version', 'this lockfile has no packages[""] entry (lockfileVersion 1)');
  }

  assert(lock.name === pkg.name,
    `and the two files are about the same package (${lock.name})`);
}

console.log('');
console.log('Every suite run-all.ps1 registers is actually on disk');
console.log('----------------------------------------------------');
{
  const runAll = fs.readFileSync(path.join(root, 'test', 'run-all.ps1'), 'utf8');

  // Only the rows, not the prose: a Path = "..." inside an @{ ... } suite row.
  // Deliberately literal rather than clever -- if the registration syntax
  // changes, this finds zero rows and says so below rather than passing on an
  // empty set, which is the same could-not-look-vs-nothing distinction the
  // finders make.
  const rows = [];
  const re = /Name\s*=\s*"([^"]+)"[^}]*?Path\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(runAll)) !== null) {
    rows.push({ name: m[1], suitePath: m[2] });
  }

  assert(rows.length > 20,
    `found ${rows.length} registered suites (a low number means this parser stopped matching, not that suites were deleted)`);

  // No backslash literal in this file on purpose. A doubled backslash does not
  // survive every editing path that has touched this repo, and a silently
  // mangled separator here would make the check pass by finding nothing.
  const sep = String.fromCharCode(92);
  const toNative = (p) => p.split(sep).join(path.sep);
  const missing = rows.filter((r) => !fs.existsSync(path.join(root, toNative(r.suitePath))));

  if (missing.length > 0) {
    for (const r of missing) {
      console.log(`        registered but not on disk: ${r.name} -> ${r.suitePath}`);
    }
  }
  assert(missing.length === 0,
    `every registered suite file exists (${rows.length} checked, ${missing.length} missing)`);
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
