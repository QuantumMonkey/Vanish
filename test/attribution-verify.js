// bu2 Verify: size attribution (lib/attribution.js).
//
// Every assertion here defends the one distinction the feature lives or dies
// on: "unattributed" (we cannot explain this) is not "orphaned" (we know who
// owned it and they are gone). Collapsing the two would put a delete button
// next to a folder nobody understands, which is the behaviour this app exists
// to be the alternative to.
//
//   node test/attribution-verify.js

const attribution = require('../lib/attribution');
const { OWNED, ORPHANED, UNATTRIBUTED, SYSTEM } = attribution.STATES;

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

const apps = [
  { name: 'Blender', publisher: 'Blender Foundation', installLocation: 'C:\\Program Files\\Blender Foundation\\Blender' },
  { name: 'Git', publisher: 'The Git Development Community', installLocation: 'C:\\Program Files\\Git' },
  { name: '7-Zip', publisher: 'Igor Pavlov', installLocation: '' }
];

function run(dirs, recorded) {
  return attribution.attribute({ dirs, installedApps: apps, recordedInstalls: recorded || [] });
}

console.log('');
console.log('Size attribution (bu2)');
console.log('======================');

// --- the core distinction -------------------------------------------------
{
  const a = run([
    'C:\\Program Files\\Git',                 // registered install location
    'C:\\Program Files\\7-Zip',               // name match only
    'C:\\Program Files\\Wat',                 // nothing known
    'C:\\Windows'                             // system
  ]);
  const by = Object.fromEntries(a.results.map((r) => [r.path, r]));

  assert(by['C:\\Program Files\\Git'].state === OWNED, 'a registered InstallLocation is owned');
  assert(by['C:\\Program Files\\Git'].evidence === 'install-location', 'and says that is why');
  assert(by['C:\\Program Files\\Git'].confidence === 'certain', 'with certain confidence');

  assert(by['C:\\Program Files\\7-Zip'].state === OWNED, 'a folder named after an installed program is owned');
  assert(
    by['C:\\Program Files\\7-Zip'].confidence === 'likely',
    'but only LIKELY - a name match is a coincidence away from being wrong and must not read as fact'
  );

  assert(by['C:\\Program Files\\Wat'].state === UNATTRIBUTED, 'an unexplained folder is unattributed');
  assert(
    by['C:\\Program Files\\Wat'].state !== ORPHANED,
    'and is NEVER orphaned - unexplained is an admission, orphaned is an accusation'
  );

  assert(by['C:\\Windows'].state === SYSTEM, 'a Windows-owned folder is classified as system, not as noise in the list');
}

// --- orphaned requires recorded evidence ----------------------------------
{
  const recorded = [
    { path: 'C:\\Program Files\\GoneApp', program: 'GoneApp', at: '2026-03-01T00:00:00Z' },
    { path: 'C:\\Program Files\\Blender Foundation\\Blender', program: 'Blender', at: '2026-04-01T00:00:00Z' }
  ];
  const a = run(['C:\\Program Files\\GoneApp', 'C:\\Program Files\\Blender Foundation\\Blender'], recorded);
  const by = Object.fromEntries(a.results.map((r) => [r.path, r]));

  assert(
    by['C:\\Program Files\\GoneApp'].state === ORPHANED,
    'a path recorded as created by a program that is no longer installed IS orphaned'
  );
  assert(
    by['C:\\Program Files\\GoneApp'].evidence === 'recorded' &&
      by['C:\\Program Files\\GoneApp'].confidence === 'certain',
    'and the claim is backed by the recorded install, not by a guess'
  );
  assert(
    by['C:\\Program Files\\Blender Foundation\\Blender'].state === OWNED,
    'a recorded path whose program is still installed is owned, not orphaned'
  );
}

// --- a watched directory with no resolvable owner is NOT orphaned ---------
{
  // An installer that writes no uninstall entry: zrw saw the folder appear but
  // never learned who made it. Knowing WHEN something appeared is not knowing
  // that its owner is gone.
  const a = run(['C:\\Program Files\\Mystery'], [
    { path: 'C:\\Program Files\\Mystery', program: null, at: '2026-02-01T00:00:00Z' }
  ]);
  assert(
    a.results[0].state === UNATTRIBUTED,
    'a recorded path whose owner was never resolved is unattributed, NOT orphaned - the word requires knowing who is gone'
  );
  assert(
    a.results[0].evidence === 'recorded-unknown-owner',
    'and it says exactly that, rather than reporting no evidence at all'
  );
  assert(a.results[0].recordedAt === '2026-02-01T00:00:00Z', 'the observation is still kept - it is real, it just is not proof of orphanhood');
}

// --- recorded evidence outranks everything else ---------------------------
{
  // A folder that LOOKS like it belongs to Git by name, but was recorded as
  // created by a program that is now gone. The recording wins.
  const a = run(['C:\\Program Files\\Git'], [
    { path: 'C:\\Program Files\\Git', program: 'SomethingElse', at: '2026-05-01T00:00:00Z' }
  ]);
  assert(
    a.results[0].state === ORPHANED && a.results[0].owner === 'SomethingElse',
    'recorded evidence outranks a registered install location - it observed the creation, the registry only describes the present'
  );
}

// --- the latest recording wins --------------------------------------------
{
  const a = run(['C:\\Program Files\\Shared'], [
    { path: 'C:\\Program Files\\Shared', program: 'Old', at: '2026-01-01T00:00:00Z' },
    { path: 'C:\\Program Files\\Shared', program: 'Blender', at: '2026-06-01T00:00:00Z' }
  ]);
  assert(
    a.results[0].owner === 'Blender' && a.results[0].state === OWNED,
    'a path reused by a later install belongs to the later one'
  );
}

// --- normalisation --------------------------------------------------------
{
  const a = run(['c:\\PROGRAM FILES\\git\\']);
  assert(
    a.results[0].state === OWNED,
    'case and a trailing separator do not defeat matching - Windows paths are case-preserving, not case-sensitive'
  );

  assert(
    attribution.normaliseName('Blender Foundation') === attribution.normaliseName('blender'),
    'corporate suffixes and punctuation carry no identifying information'
  );
  assert(
    attribution.normaliseName('JetBrains s.r.o.') === attribution.normaliseName('JetBrains'),
    'and neither does a legal-entity suffix'
  );
}

// --- system detection -----------------------------------------------------
{
  assert(attribution.isSystemDir('C:\\ProgramData\\{A1B2C3D4-1111-2222-3333-444455556666}'),
    'a GUID-named folder is installer scratch space, not a program a user could act on');
  assert(attribution.isSystemDir('C:\\Program Files\\Common Files'), 'shared infrastructure is system');
  assert(!attribution.isSystemDir('C:\\Program Files\\Notepad++'), 'a real program folder is not');
}

// --- sizing only what is worth sizing -------------------------------------
{
  const a = run([
    'C:\\Program Files\\Git',        // owned - no need to measure
    'C:\\Program Files\\Wat',        // unattributed - measure
    'C:\\Windows'                    // system - no need
  ], [{ path: 'C:\\Program Files\\Gone', program: 'Gone', at: '2026-01-01T00:00:00Z' }]);

  const cands = attribution.sizeCandidates(a);
  assert(
    cands.length === 1 && cands[0] === 'C:\\Program Files\\Wat',
    'only unexplained and orphaned folders are worth a directory walk - this is what makes the scan seconds instead of minutes'
  );
}

// --- publisher folders and concatenated names -----------------------------
{
  // The two matching gaps a live run against a real machine exposed: 134 of
  // 233 directories came back unexplained, and most of them were neither.
  const withNested = [
    { name: 'Brave', publisher: 'Brave Software', installLocation: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application' }
  ];
  const a = attribution.attribute({
    dirs: ['C:\\Program Files\\BraveSoftware'],
    installedApps: withNested,
    recordedInstalls: []
  });
  assert(
    a.results[0].state === OWNED && a.results[0].evidence === 'contains-install-location',
    'a publisher folder containing a program\'s registered install location is owned by that program'
  );
  assert(
    a.results[0].confidence === 'certain',
    'and that is certain evidence, not a guess - the program\'s own registry entry points inside it'
  );

  // Concatenated names do not split into tokens, so exact matching misses a
  // folder that carries MORE than the program name. ("JetBrainsToolbox" vs
  // "JetBrains Toolbox" is not this case - those normalise identically and are
  // already an exact match.)
  const b = attribution.attribute({
    dirs: ['C:\\Program Files\\BraveSoftwareUpdater'],
    installedApps: [{ name: 'Brave', publisher: 'Brave', installLocation: '' }],
    recordedInstalls: []
  });
  assert(
    b.results[0].state === OWNED && b.results[0].evidence === 'name-prefix',
    'a concatenated folder name starting with a program or publisher name is matched'
  );
  assert(b.results[0].confidence === 'likely', 'as a likely match, not a certain one');

  // The length floor: short names would match nearly everything.
  const c = attribution.attribute({
    dirs: ['C:\\Program Files\\Nvidia Corporation'],
    installedApps: [{ name: 'AB', publisher: 'XY', installLocation: '' }],
    recordedInstalls: []
  });
  assert(
    c.results[0].state === UNATTRIBUTED,
    'a two-character program name does not prefix-match everything on the disk'
  );
}

// --- budget ordering ------------------------------------------------------
{
  // Measurement runs under a time budget, so ordering decides what comes back
  // unmeasured. Orphans are the only defensible claims and the only input to
  // the reclaimable total; they must not be at the back of the queue.
  const a = attribution.attribute({
    dirs: ['C:\\Program Files\\Unknown1', 'C:\\Program Files\\Unknown2', 'C:\\Program Files\\Gone'],
    installedApps: [],
    recordedInstalls: [{ path: 'C:\\Program Files\\Gone', program: 'Gone', at: '2026-01-01T00:00:00Z' }]
  });
  const cands = attribution.sizeCandidates(a);
  assert(
    cands[0] === 'C:\\Program Files\\Gone',
    'orphans are measured first - the time budget must never spend itself on unexplained folders and leave the headline number wrong'
  );
  assert(cands.length === 3, 'and everything else still queues behind them');
}

// --- merging sizes back ---------------------------------------------------
{
  const a = run(['C:\\Program Files\\Wat', 'C:\\Program Files\\Big'], [
    { path: 'C:\\Program Files\\Big', program: 'Gone', at: '2026-01-01T00:00:00Z' }
  ]);
  const merged = attribution.withSizes(a, [
    { path: 'C:\\Program Files\\Wat', sizeBytes: 9000000000 },
    { path: 'C:\\Program Files\\Big', sizeBytes: 1000 }
  ]);

  assert(
    merged.results[0].state === ORPHANED,
    'orphaned sorts first even when an unattributed folder is far bigger - it is the only certain claim and must not be buried'
  );
  assert(merged.reclaimableBytes === 1000, 'reclaimable counts ONLY measured orphans, never guesses');

  const unmeasured = attribution.withSizes(a, [{ path: 'C:\\Program Files\\Wat', error: 'Access denied' }]);
  const wat = unmeasured.results.find((r) => r.path === 'C:\\Program Files\\Wat');
  assert(
    wat.sizeBytes === null && wat.measured === false && /denied/i.test(wat.measureError),
    'a folder that could not be measured reports null and the reason, never 0 B - a false zero is a number the user would act on'
  );
  assert(
    unmeasured.reclaimableBytes === 0,
    'and an unmeasured orphan contributes nothing to the reclaimable total'
  );
}

// --- degenerate input -----------------------------------------------------
{
  const a = attribution.attribute({});
  assert(a.results.length === 0 && a.counts.owned === 0, 'empty input produces an empty result, not a crash');

  const b = run(['C:\\Program Files\\Wat'], [{ path: null }, null, { path: 'C:\\x', program: 'y' }]);
  assert(b.results.length === 1, 'malformed recorded entries are skipped rather than taking the scan down');
}

// --- qof: the engine side of "never a false zero" -------------------------
//
// Everything above tests lib/attribution.js, which is where the never-report-0
// rule is enforced for the JS half. The rule has an engine half too, and that
// is where it was being broken: Measure-Paths walked every target as a
// directory, so a FILE came back sizeBytes 0 / error null - a number, and a
// wrong one, from the function whose own header says a wrong number is worse
// than no number.
//
// Latent when found (main.js's only caller passes install-snapshot directories),
// so this asserts the contract rather than a live path: a real engine run
// against a real file, a real directory and a path that is not there.
{
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const engine = path.join(__dirname, '..', 'scanner.ps1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-qof-'));
  const filePath = path.join(root, 'one-file.txt');
  const dirPath = path.join(root, 'sub');
  fs.writeFileSync(filePath, 'x'.repeat(2114));
  fs.mkdirSync(dirPath);
  fs.writeFileSync(path.join(dirPath, 'a.bin'), 'y'.repeat(100));
  fs.writeFileSync(path.join(dirPath, 'b.bin'), 'z'.repeat(23));
  const missing = path.join(root, 'not-here.txt');

  const params = JSON.stringify({ paths: [filePath, dirPath, missing] });
  const b64 = Buffer.from(params, 'utf8').toString('base64');
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', engine, '-Action', 'measure-paths', '-ParamsBase64', b64],
    { encoding: 'utf8', windowsHide: true }
  );

  let payload = null;
  try {
    payload = JSON.parse((run.stdout || '').trim());
  } catch (err) {
    payload = null;
  }

  assert(payload && payload.success === true, 'measure-paths answers at all when called the way main.js calls it');

  const got = payload ? Object.fromEntries(payload.results.map((r) => [r.path, r])) : {};

  assert(
    got[filePath] && got[filePath].sizeBytes === 2114,
    'a FILE target reports its real byte length, not the 0 a directory walk produces over it (qof)'
  );
  assert(
    got[filePath] && got[filePath].fileCount === 1 && got[filePath].skippedDirs === 0,
    'and counts itself as one file with nothing skipped, rather than one unreadable directory'
  );
  assert(
    got[filePath] && got[filePath].partial === false && got[filePath].error === null,
    'a measured file is not partial - partial=true was the only signal the old 0 was wrong, and nothing rendered it'
  );
  assert(
    got[dirPath] && got[dirPath].sizeBytes === 123 && got[dirPath].fileCount === 2,
    'a directory still walks its children - the file branch must not swallow the folder case'
  );
  assert(
    got[missing] && got[missing].sizeBytes === null && /disk/i.test(got[missing].error || ''),
    'a path that is gone still comes back null with a reason, never 0'
  );

  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
