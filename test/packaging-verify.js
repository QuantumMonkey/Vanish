// Everything the engine reads at runtime must actually be in the build.
//
//   node test/packaging-verify.js
//
// WHY THIS EXISTS, with a date. The 0.9.0 build was produced on 2026-08-28 and
// did not contain finders/. Nothing failed. scanner.ps1 guards its dot-source
// with Test-Path so a trimmed install still answers every other action, and
// Import-Finders reports a missing directory rather than throwing - both of
// which are correct, and both of which meant the SHIPPED application would have
// opened Machine Hygiene, found zero checks registered, and said so politely.
// The headline feature of the release, dead in the binary, with 1797 green
// assertions behind it because every one of them runs from the source tree.
//
// That is a whole defect class: a runtime dependency resolved by PATH rather
// than by require(), invisible to every test that runs before packaging. lib/
// and renderer/ are safe because main.js require()s them and electron-builder
// follows require graphs. scanner.ps1's world is not a require graph -- it is
// $PSScriptRoot plus string joins, which electron-builder cannot see.
//
// So this reads the engine for the directories and files it resolves against
// its own location, and asserts each one is declared in extraResources. It is a
// static check on purpose: it must run in seconds on every `npm test`, not only
// after a five-minute build. The build-output check below is a bonus that runs
// only when a build happens to be lying around.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

console.log('');
console.log('Packaging contract: what the engine reads is what the build ships');
console.log('================================================================');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extra = (pkg.build && pkg.build.extraResources) || [];
const extraFrom = new Set(extra.map((e) => String(e.from)));
const files = (pkg.build && pkg.build.files) || [];

// ---- what the engine resolves against its own location --------------------
// Deliberately parsed out of the engine rather than hard-coded here. A list
// maintained by hand is a list that goes stale exactly when a new sibling
// directory is added, which is the moment this test needs to be right.
const scanner = fs.readFileSync(path.join(root, 'scanner.ps1'), 'utf8');
const joined = [...scanner.matchAll(/Join-Path\s+\$PSScriptRoot\s+'([^']+)'/g)].map((m) => m[1]);
const siblings = [...new Set(joined)];

assert(siblings.length > 0, `the engine resolves at least one sibling path against $PSScriptRoot (${siblings.join(', ')})`);

for (const sib of siblings) {
  const onDisk = path.join(root, sib);
  if (!fs.existsSync(onDisk)) {
    // A path the engine builds for something that does not exist in the source
    // tree either is not a packaging problem - it is a runtime-optional path.
    console.log(`  NOTE  ${sib} is referenced by the engine but absent from the source tree; nothing to package`);
    continue;
  }
  assert(
    extraFrom.has(sib),
    `${sib} is declared in extraResources, so the packaged engine can find it beside itself`,
    `add { "from": "${sib}", "to": "${sib}" } to build.extraResources in package.json`
  );
}

// scanner.ps1 itself, and the data file it reads.
assert(extraFrom.has('scanner.ps1'), 'scanner.ps1 itself is an extraResource - the app spawns it as a file, not as a require');
assert(extraFrom.has('corrections.json'), 'corrections.json ships beside it');

// ---- the finders specifically, since that is the one that was missing -----
const finderDir = path.join(root, 'finders');
const finderFiles = fs.existsSync(finderDir)
  ? fs.readdirSync(finderDir).filter((f) => f.endsWith('.ps1'))
  : [];
assert(finderFiles.length > 0, `the source tree has finder files to ship (${finderFiles.length})`);
assert(
  extraFrom.has('finders'),
  'finders/ is an extraResource - without this the shipped app registers ZERO checks and Machine Hygiene is empty'
);
assert(
  files.some((f) => f === 'finders/**/*'),
  "finders/ is in build.files too, so the pattern list and the resource list do not disagree about whether it is part of the app"
);

// The three support files the engine dot-sources by name. A finders directory
// that shipped without _loader.ps1 would register nothing while looking present.
for (const support of ['_contract.ps1', '_never-touch.ps1', '_loader.ps1']) {
  assert(
    finderFiles.includes(support),
    `finders/${support} exists - scanner.ps1 dot-sources it by name and silently skips it if absent`
  );
}

// ---- if a build is lying around, check it for real ------------------------
// SKIPPED rather than passed when there is no build. A packaging assertion that
// quietly succeeds because there is nothing to inspect is the same shape of
// mistake as the bug this file was written for.
console.log('');
const unpacked = path.join(root, 'dist', 'win-unpacked', 'resources');
if (!fs.existsSync(unpacked)) {
  console.log('  SKIP  no dist/win-unpacked to inspect - run `npm run dist` to check a real build');
  console.log('        (the static assertions above still ran; this is the belt to their braces)');
} else {
  const built = fs.readdirSync(unpacked);
  console.log(`  (inspecting a real build: ${built.join(', ')})`);
  assert(built.includes('scanner.ps1'), 'the built app carries scanner.ps1 in resources');
  assert(
    built.includes('finders'),
    'and carries finders/ beside it - this is the assertion the 0.9.0 build would have failed'
  );
  if (built.includes('finders')) {
    const builtFinders = fs.readdirSync(path.join(unpacked, 'finders')).filter((f) => f.endsWith('.ps1'));
    assert(
      builtFinders.length === finderFiles.length,
      `every finder file made it into the build (${builtFinders.length} of ${finderFiles.length})`,
      finderFiles.filter((f) => !builtFinders.includes(f)).join(', ')
    );
  }
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
