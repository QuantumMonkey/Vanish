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

// ---------------------------------------------------------------------------
console.log('');
console.log('Every JavaScript file in the repository actually parses');
// ---------------------------------------------------------------------------
//
// A duplicate top-level `const` is a SyntaxError at MODULE INSTANTIATION, and
// in this repository that is not a loud failure -- it is a hang.
//
// Three times now. `mainSrc` in updates-verify, `small` in
// install-size-verify, and `deadline` in screenshot-probe.js on 2026-09-07.
// The last one is the clearest illustration: nothing in the file ran, not even
// the mkdirSync on its first line, so app.whenReady() was never registered,
// Electron raised a modal error dialog with nobody there to click OK, and the
// run sat at zero CPU with no output for twenty minutes looking like a slow
// scan. The renderer's classic scripts fail the same way and worse -- they
// share ONE global lexical environment, so a collision takes the whole file
// down and the page simply renders without that feature.
//
// `node --check` finds all of it in milliseconds. There is no reason for a
// human to be the one who notices.
{
  const { execFileSync } = require('child_process');

  const dirs = ['lib', 'renderer', 'tools', 'test', path.join('test', 'sandbox'), path.join('test', 'fixtures')];
  const files = [path.join(root, 'main.js'), path.join(root, 'preload.js')];
  for (const d of dirs) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) files.push(path.join(full, name));
    }
  }

  assert(files.length > 40, `the scan found the JavaScript to check (${files.length} files)`);

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (e) {
      const why = String((e.stderr && e.stderr.toString()) || e.message)
        .split('\n').find((l) => /Error/.test(l)) || 'did not parse';
      broken.push(`${path.relative(root, file)}: ${why.trim()}`);
    }
  }
  for (const b of broken) console.log(`        ${b}`);
  assert(broken.length === 0,
    `every JavaScript file parses (${files.length} checked, ${broken.length} broken)`);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('The redundancy resolution database is well formed');
// ---------------------------------------------------------------------------
//
// redundancy-rules.json is the only thing standing between "Consider keeping
// only one" and a screen that knows two browsers are fine. Its whole value is
// that every category names a SYMPTOM -- something the user could go and
// check. A category with no symptom is back to the sentence this file replaced.
//
// The severity is also load-bearing in a way that is easy to get wrong: it
// decides whether a group is COUNTED in the Health Advisor's headline. A typo
// in a severity string does not fail anywhere -- it silently becomes
// 'unknown', which is counted, so the mistake shows up as a nag rather than an
// error. Hence pinning the vocabulary here.
{
  const rulesPath = path.join(root, 'redundancy-rules.json');
  assert(fs.existsSync(rulesPath), 'redundancy-rules.json is present');

  let rules = null;
  try {
    rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  } catch (e) {
    assert(false, `redundancy-rules.json parses -- ${e.message}`);
  }

  if (rules) {
    const SEVERITIES = ['conflict', 'cost', 'clutter', 'coexist'];
    const cats = Array.isArray(rules.categories) ? rules.categories : [];

    assert(cats.length >= 20,
      `it covers a useful spread of categories (${cats.length})`);

    const problems = [];
    const names = new Set();
    const keywordOwner = new Map();

    for (const c of cats) {
      const where = c && c.name ? c.name : '(unnamed)';
      if (!c || typeof c.name !== 'string' || !c.name.trim()) { problems.push('a category has no name'); continue; }
      if (names.has(c.name)) problems.push(`${where}: duplicate category name`);
      names.add(c.name);

      if (!Array.isArray(c.keywords) || c.keywords.length === 0) problems.push(`${where}: no keywords`);
      else {
        for (const k of c.keywords) {
          if (typeof k !== 'string' || !k.trim()) { problems.push(`${where}: empty keyword`); continue; }
          // scanner.ps1 lowercases the app name and matches with -like, so an
          // upper-case keyword silently never matches anything.
          if (k !== k.toLowerCase()) problems.push(`${where}: keyword "${k}" is not lower case, so it can never match`);
          const owner = keywordOwner.get(k);
          // A keyword in two categories puts the same program in both groups.
          if (owner && owner !== c.name) problems.push(`${where}: keyword "${k}" is also in ${owner}`);
          keywordOwner.set(k, c.name);
        }
      }

      if (!SEVERITIES.includes(c.severity)) {
        problems.push(`${where}: severity "${c.severity}" is not one of ${SEVERITIES.join(', ')}`);
      }
      // The rule that makes this database worth trusting.
      if (typeof c.symptom !== 'string' || c.symptom.trim().length < 20) {
        problems.push(`${where}: no symptom -- say what the user would actually observe, or make it 'coexist'`);
      }
      if (typeof c.advice !== 'string' || c.advice.trim().length < 20) problems.push(`${where}: no advice`);
      if (typeof c.conflictWhen !== 'string' || !c.conflictWhen.trim()) problems.push(`${where}: no conflictWhen`);

      // A 'coexist' category that claims a conflict is contradicting itself.
      if (c.severity === 'coexist' && c.conflictWhen !== 'never') {
        problems.push(`${where}: severity coexist but conflictWhen is "${c.conflictWhen}"`);
      }
      if (c.severity !== 'coexist' && c.conflictWhen === 'never') {
        problems.push(`${where}: conflictWhen "never" but severity is "${c.severity}"`);
      }
    }

    for (const p of problems) console.log(`        ${p}`);
    assert(problems.length === 0, `every category is complete and consistent (${cats.length} checked, ${problems.length} problems)`);

    // The categories the operator reported by name, pinned. These are the ones
    // that were being flagged as problems and are not.
    for (const name of ['Web Browser', 'Note Taking', 'Code Editor / IDE', 'Game Launcher']) {
      const c = cats.find((x) => x.name === name);
      assert(c && c.severity === 'coexist',
        `${name} coexists, so it is never counted as work`);
    }
    // And the ones that genuinely do bite, so a future tidy-up cannot quietly
    // demote them to keep the screen calm.
    for (const name of ['Antivirus / Security', 'Virtual Machine']) {
      const c = cats.find((x) => x.name === name);
      assert(c && c.severity === 'conflict', `${name} is a real conflict and stays one`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log('Every unreadable reason the engine emits is classified (sf71)');
// ---------------------------------------------------------------------------
//
// lib/findings.js groups blind spots by CAUSE so the screen can say why it did
// not read something, and in particular so it never offers elevation against a
// limit Vanish imposed on itself. An unclassified reason is not a crash -- it
// falls into 'unknown' and is worded as not-yet-explained, which is the safe
// default -- but it is a reason the user gets no explanation for, so a new one
// should be noticed here rather than in a screenshot.
//
// This greps for the literals the finders pass to New-Unreadable. It is a
// LOWER BOUND and says so: 'git-error' and 'dubious-ownership' are built in a
// variable and would not be caught by this scan at all, which is exactly why
// 'unknown' has to stay a real, visible bucket rather than a assertion that
// this list is complete.
{
  const findings = require(path.join(root, 'lib', 'findings.js'));

  // Test hatches, not engine vocabulary: scanner.ps1 uses these to inject
  // synthetic unreadable records for the suites. Nothing a user can reach.
  const HATCH_ONLY = new Set(['probe', 'state']);

  const sources = [path.join(root, 'scanner.ps1')].concat(
    fs.readdirSync(path.join(root, 'finders'))
      .filter((f) => f.endsWith('.ps1'))
      .map((f) => path.join(root, 'finders', f))
  );

  const seen = new Set();
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /-reason\s+'([a-z][a-z0-9-]*)'/g;
    let m;
    while ((m = re.exec(text)) !== null) seen.add(m[1]);
  }

  assert(seen.size > 20, `the scan actually found reason codes (${seen.size})`);

  const unclassified = [...seen]
    .filter((r) => !HATCH_ONLY.has(r))
    .filter((r) => findings.blindCauseOf(r) === 'unknown')
    .sort();

  for (const r of unclassified) {
    console.log(`        unclassified reason: ${r} -- add it to BLIND_CAUSES in lib/findings.js`);
  }
  assert(unclassified.length === 0,
    `every reason literal in the engine has a cause (${seen.size} found, ${unclassified.length} unclassified)`);

  // The hatch reasons must stay unclassified, or the exclusion above is
  // silently covering for a real gap.
  const hatchesStillUnknown = [...HATCH_ONLY].every((r) => findings.blindCauseOf(r) === 'unknown');
  assert(hatchesStillUnknown,
    'the two test-hatch reasons are still unclassified, so excluding them is not hiding a real one');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
