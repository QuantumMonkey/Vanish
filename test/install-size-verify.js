// mp31: measuring an install folder, and the rules about when Vanish will not.
//
//   npx electron test/install-size-verify.js
//
// 39 of the operator machine's 150 desktop entries report no size, because Size
// comes from the registry's EstimatedSize and that is a value the installer
// chose to write or not. 27 of the 39 carry an install folder that exists.
//
// THE SUBJECT IS THE REFUSALS, in the same spirit as icon-extract-verify. A
// measurement that comes back wrong is worse than Unknown: the column is
// sortable, and a total that silently omits an unreadable subtree, or that
// stops halfway through a budget, is a number the user would act on. So every
// path that cannot produce a COMPLETE total has to produce nothing at all, and
// each of those paths is asserted here rather than assumed.
//
// It runs in either tier - adding up file sizes is not a privileged operation.

const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';
// Small enough that a fixture of a few thousand files blows it, so the budget
// is exercised rather than described. main.js reads these at load, so they are
// set BEFORE the require below.
process.env.VANISH_SIZE_BUDGET_MS = '40';
require('../main.js');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}
function skip(label, whyNot) { console.log(`  SKIP  ${label} -- ${whyNot}`); }

async function invoke(channel, payload) {
  const h = ipcMain._invokeHandlers.get(channel);
  if (!h) throw new Error(`no handler registered for ${channel}`);
  return h({ sender: null }, payload);
}

const B = String.fromCharCode(92);
const work = path.join(os.tmpdir(), 'vanish-install-size-verify');

function makeTree(root, dirs, per, bytes) {
  fs.mkdirSync(root, { recursive: true });
  const blob = Buffer.alloc(bytes, 0x78);
  let total = 0;
  for (let d = 0; d < dirs; d += 1) {
    const sub = path.join(root, `d${d}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < per; i += 1) {
      fs.writeFileSync(path.join(sub, `f${i}.bin`), blob);
      total += bytes;
    }
  }
  return total;
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Install folder sizing (mp31)');
  console.log('============================');

  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  try {
    // ----------------------------------------------------------------
    console.log('');
    console.log('It measures, and the number is the real one');

    const small = path.join(work, 'small-app');
    const expected = makeTree(small, 3, 4, 1000);

    const r = await invoke('measure-install-size', { source: small });
    assert(r && r.complete === true, 'a small folder completes inside the budget',
      JSON.stringify(r));
    assert(r && r.bytes === expected,
      `and the total is exactly the bytes on disk (${expected})`, JSON.stringify(r));

    // The commonest InstallLocation shapes in the real registry.
    const quoted = await invoke('measure-install-size', { source: `"${small}"` });
    assert(quoted && quoted.bytes === expected, 'a quoted path measures the same folder');
    const trailing = await invoke('measure-install-size', { source: small + B });
    assert(trailing && trailing.bytes === expected, 'and so does one with a trailing separator');

    // ----------------------------------------------------------------
    console.log('');
    console.log('A junction is not followed (127o), so nothing is counted twice');

    const jHost = path.join(work, 'with-junction');
    const jExpected = makeTree(jHost, 1, 2, 500);
    let madeJunction = false;
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(jHost, 'alias'), small], { stdio: 'ignore' });
      madeJunction = fs.existsSync(path.join(jHost, 'alias'));
    } catch { madeJunction = false; }

    if (!madeJunction) {
      skip('the junction case', 'mklink refused to create the junction');
    } else {
      const j = await invoke('measure-install-size', { source: jHost });
      assert(j && j.complete === true && j.bytes === jExpected,
        `a junction into another folder adds nothing to the total (${jExpected})`,
        JSON.stringify(j));
      assert(j && j.bytes !== jExpected + expected,
        'and specifically not the aliased folder twice');
    }

    // ----------------------------------------------------------------
    console.log('');
    console.log('The budget bites, and a partial total is never reported as a size');

    const big = path.join(work, 'big-app');
    makeTree(big, 40, 60, 20000); // 2,400 files, ~48 MB, against a 40 ms budget
    const b = await invoke('measure-install-size', { source: big });
    assert(b && b.complete === false,
      'a folder too large for the budget reports incomplete rather than a partial walk',
      JSON.stringify(b));
    assert(b && b.bytes === null,
      'and returns NO number at all, so the caller cannot render a half-measured total',
      JSON.stringify(b));

    // ----------------------------------------------------------------
    console.log('');
    console.log('2brn: ONE wide directory, which is the shape that got past the budget');

    // THE FIXTURE ABOVE IS WHY THIS BUG SURVIVED. 40 dirs x 60 files gives the
    // per-directory budget check forty chances to fire, so it fired, and the
    // suite went green over a loop whose inner `for (const e of entries)` had
    // no check in it at all.
    //
    // One directory gives it exactly one chance, at the top, before any work
    // has happened. Measured on the real shape: 60,000 files in one directory
    // ran 2,471 ms against a 1,500 ms budget and returned complete = true.
    //
    // Asserted as complete === false rather than as a duration: a timing
    // assertion is a flaky test wearing a performance badge, and "the budget
    // fired" is the same property stated deterministically. Under the old code
    // this comes back true.
    const flat = path.join(work, 'one-wide-dir');
    fs.mkdirSync(flat, { recursive: true });
    const blob = Buffer.alloc(64, 0x79);
    for (let i = 0; i < 4000; i += 1) fs.writeFileSync(path.join(flat, `f${i}.bin`), blob);

    const w = await invoke('measure-install-size', { source: flat });
    assert(w && w.complete === false,
      'a single directory wide enough to blow the budget reports incomplete - the check is inside the loop that does the work, not once per directory',
      JSON.stringify(w));
    assert(w && w.bytes === null,
      'and still returns no number, so nothing renders a partial total',
      JSON.stringify(w));

    // The file cap had the identical defect and the identical fix - it was
    // also tested once per directory, so a single directory holding more than
    // the cap sailed past it.
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const walkFn = mainSrc.slice(
      mainSrc.indexOf('function measureDirectoryBounded'),
      mainSrc.indexOf('ipcMain.handle(\'measure-install-size\'')
    );
    const inner = walkFn.slice(walkFn.indexOf('for (const e of entries)'));
    assert(/files > maxFiles/.test(inner),
      'the FILE cap is enforced inside the inner loop too, not only per directory');
    assert(/Date\.now\(\) - started > budgetMs/.test(inner),
      'and so is the time budget');

    // ----------------------------------------------------------------
    console.log('');
    console.log('2brn: the budget overrides are test hatches, not configuration');

    // main.js says forty lines above these that its test hatches "do not exist
    // at all" in a packaged build. These two were read unconditionally, which
    // made that comment false - and an environment variable that sets the walk
    // budget in a shipped app is a way to make the main process hang from
    // outside it.
    assert(/const testHatchesAllowed = !app\.isPackaged/.test(mainSrc),
      'premise: the gate this suite is asserting against exists');
    assert(/function sizeHatch\([\s\S]{0,200}?if \(!testHatchesAllowed\) return fallback;/.test(mainSrc),
      'the budget overrides go through a helper that refuses outside a dev run');
    const rawReads = (mainSrc.match(/process\.env\.VANISH_SIZE_(?:BUDGET_MS|MAX_FILES)/g) || []);
    assert(rawReads.length === 0,
      `neither variable is read directly any more (${rawReads.length} direct read(s) left)`,
      rawReads.join(', '));
    assert(/sizeHatch\('VANISH_SIZE_BUDGET_MS'/.test(mainSrc) && /sizeHatch\('VANISH_SIZE_MAX_FILES'/.test(mainSrc),
      'and both constants come from it - the gate is worth nothing if one of them bypasses it');

    // ----------------------------------------------------------------
    console.log('');
    console.log('A subtree it cannot read makes the whole total incomplete');
    // A total that silently omits a folder is the worst answer available here:
    // it is confident, sortable and wrong, and nothing on screen says so.
    //
    // An Administrator token reads straight through a Deny ACE (bd pnor), so
    // this states its premise and skips rather than passing vacuously in an
    // elevated run - the same shape as the nine suites pnor is about.
    const denied = path.join(work, 'denied-app');
    const deniedExpected = makeTree(denied, 2, 2, 700);
    const secret = path.join(denied, 'd0');
    let deniedBites = false;
    try {
      execFileSync('icacls.exe', [secret, '/inheritance:d'], { stdio: 'ignore' });
      execFileSync('icacls.exe', [secret, '/deny', `${process.env.USERNAME}:(OI)(CI)(RD,RA,REA,X)`], { stdio: 'ignore' });
      try { fs.readdirSync(secret); } catch { deniedBites = true; }
    } catch { deniedBites = false; }

    if (!deniedBites) {
      skip('the unreadable-subtree case',
        'this session can still read the denied directory (an Administrator token reads through a Deny ACE - bd pnor)');
    } else {
      const d = await invoke('measure-install-size', { source: denied });
      assert(d && d.complete === false,
        'a folder holding a subtree we cannot enumerate reports incomplete');
      assert(d && d.bytes === null,
        `and returns no number, rather than a total silently missing that subtree (${deniedExpected} would have been the full one)`,
        JSON.stringify(d));
    }
    try {
      execFileSync('icacls.exe', [secret, '/reset'], { stdio: 'ignore' });
      execFileSync('icacls.exe', [secret, '/grant', `${process.env.USERNAME}:(OI)(CI)F`], { stdio: 'ignore' });
    } catch { /* cleanup below is best-effort anyway */ }

    // ----------------------------------------------------------------
    console.log('');
    console.log('Paths it refuses outright (each one a wrong number avoided)');

    const gone = await invoke('measure-install-size', { source: path.join(work, 'not-here') });
    assert(gone && gone.bytes === null && gone.complete === false,
      'a folder that does not exist yields nothing - a leftover registry entry is not sized from a missing folder');

    const aFile = path.join(work, 'a-file.txt');
    fs.writeFileSync(aFile, 'x');
    const fileRes = await invoke('measure-install-size', { source: aFile });
    assert(fileRes && fileRes.bytes === null,
      'a FILE is not measured as a folder');

    const rel = await invoke('measure-install-size', { source: 'Program Files' + B + 'Thing' });
    assert(rel && rel.bytes === null,
      'a relative path yields nothing, rather than resolving against the MAIN process working directory');

    const dead = await invoke('measure-install-size', { source: B + B + 'nope-not-a-share' + B + 'apps' });
    assert(dead && dead.bytes === null, 'a UNC path that does not resolve yields nothing');

    // The mutant-distinguishing case: without the shape rule this one WOULD be
    // walked, over SMB, from the list view. The admin share exists on every
    // Windows machine but needs elevation to read, so this states its premise.
    const liveUnc = B + B + 'localhost' + B + 'C$' + B + 'Windows';
    if (fs.existsSync(liveUnc)) {
      const live = await invoke('measure-install-size', { source: liveUnc });
      assert(live && live.bytes === null,
        'a UNC path that DOES resolve is refused too - the rule is the path shape, not whether the share answers',
        JSON.stringify(live));
    } else {
      skip('the live-UNC case', `${liveUnc} is not reachable from this session (needs elevation)`);
    }

    for (const bad of [null, undefined, '', '   ', 42, {}, 'C:', 'C:x']) {
      const res = await invoke('measure-install-size', { source: bad });
      if (!res || res.bytes !== null || res.success !== true) {
        assert(false, `a malformed source (${JSON.stringify(bad)}) is refused without throwing`, JSON.stringify(res));
      }
    }
    assert(true, 'every malformed source is refused without throwing');

    // ----------------------------------------------------------------
    console.log('');
    console.log('The answer is cached, including the refusal');

    const t0 = Date.now();
    await invoke('measure-install-size', { source: big });
    const cachedMs = Date.now() - t0;
    assert(cachedMs < 20,
      `re-asking about the folder that blew the budget is instant (${cachedMs} ms), so one slow row does not make every sort slow`);
  } finally {
    // The junction must go before the tree, or removing the tree walks through
    // the alias and deletes the folder it points at.
    const alias = path.join(work, 'with-junction', 'alias');
    if (fs.existsSync(alias)) {
      try { execFileSync('cmd.exe', ['/c', 'rmdir', alias], { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
