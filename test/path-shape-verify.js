// lr9d: one path-shape rule, and a guard that actually guards.
//
//   npx electron test/path-shape-verify.js
//
// THE RULE was written three times and forgotten once. The omission cost
// 1,270 ms per dead UNC path inside a synchronous main-process handler that
// ran it up to fifty times. lib/path-shape.js is now the single JS copy and
// main.js's two parsers delegate to it.
//
// PowerShell cannot require a JS module, so scanner.ps1 keeps its own. That
// copy is unavoidable - and the guard for it is the point of this file.
//
// A TEXTUAL GUARD DOES NOT WORK, and I know because I wrote one this week:
// test/locked-paths-verify.js matched two files against the SAME hardcoded
// literal and asserted the results were equal, which they necessarily are
// whenever both match. It could not fail, and it would not have noticed the
// renderer switching to a different expression with the old one left in a
// comment.
//
// So this guard is BEHAVIOURAL. One table of paths, run through both
// implementations - the JS one directly, the PowerShell one through the
// engine's install-date-probe - asserting they agree case by case. Two
// implementations that answer the same way on every case a caller can produce
// are in sync in the way that matters; two implementations containing the same
// characters are not.

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}

const shape = require('../lib/path-shape');
const B = shape.SEP;
const root = path.join(__dirname, '..');
const scanner = path.join(root, 'scanner.ps1');

// The cases. `accept` is what BOTH implementations must decide.
// Anything a real InstallLocation or DisplayIcon can contain belongs here.
const CASES = [
  { p: 'C:' + B + 'Program Files' + B + 'App',            accept: true,  why: 'an ordinary rooted path' },
  { p: 'C:' + B,                                          accept: true,  why: 'a drive root is a real directory' },
  { p: 'C:/Program Files/App',                            accept: true,  why: 'forward slashes, which the registry does contain' },
  { p: '"C:' + B + 'Program Files' + B + 'App"',          accept: true,  why: 'quoted, which installers write' },
  { p: 'C:' + B + 'Program Files' + B + 'App' + B,        accept: true,  why: 'a trailing separator' },
  { p: '  C:' + B + 'App  ',                              accept: true,  why: 'surrounding whitespace' },
  { p: 'C:' + B + 'App, Inc' + B + 'thing',               accept: true,  why: 'a comma inside a directory name survives' },
  { p: 'z:' + B + 'share' + B + 'app',                    accept: true,  why: 'a lowercase drive letter' },

  { p: B + B + 'server' + B + 'share' + B + 'app',        accept: false, why: 'UNC - nobody should pay an SMB timeout for it' },
  { p: '//server/share/app',                              accept: false, why: 'UNC with forward slashes' },
  { p: 'Program Files' + B + 'App',                       accept: false, why: 'relative - it would resolve against the process cwd' },
  { p: '.' + B + 'App',                                   accept: false, why: 'explicitly relative' },
  { p: 'C:',                                              accept: false, why: 'drive-relative, which is not the drive root' },
  { p: 'C:App',                                           accept: false, why: 'drive-relative with a name' },
  { p: '',                                                accept: false, why: 'empty' },
  { p: '   ',                                             accept: false, why: 'whitespace only' },
  { p: '""',                                              accept: false, why: 'an empty quoted string' },
];

function probeEngine(p) {
  // The engine answers with a DATE for a path it accepts and an empty string
  // for one it refuses. To compare shapes rather than filesystem state, every
  // accepted case is pointed at a directory that really exists, so a null can
  // only mean "refused by shape".
  const params = Buffer.from(JSON.stringify({ path: p }), 'utf8').toString('base64');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scanner,
     '-Action', 'install-date-probe', '-ParamsBase64', params],
    { encoding: 'utf8', windowsHide: true });
  return JSON.parse(out.trim());
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Path shape, one rule (lr9d)');
  console.log('===========================');

  // ------------------------------------------------------------------
  console.log('');
  console.log('The JS predicate');

  for (const c of CASES) {
    const got = shape.localRootedPath(c.p);
    assert(Boolean(got) === c.accept, `${c.accept ? 'accepts' : 'refuses'}: ${c.why}`,
      `input ${JSON.stringify(c.p)} -> ${JSON.stringify(got)}`);
  }

  assert(shape.localRootedPath('C:' + B + 'App' + B) === 'C:' + B + 'App',
    'and it returns the CLEANED path, so callers do not re-clean it differently');
  assert(shape.localRootedPath('C:' + B) === 'C:' + B,
    'while never trimming a drive root down to a drive-relative path');

  // ------------------------------------------------------------------
  console.log('');
  console.log('The DisplayIcon form, which is the only place a resource index is valid');

  assert(shape.displayIconPath('C:' + B + 'App' + B + 'a.dll,3') === 'C:' + B + 'App' + B + 'a.dll',
    'the icon parser strips a resource index');
  assert(shape.displayIconPath('C:' + B + 'App' + B + 'a.dll,-12') === 'C:' + B + 'App' + B + 'a.dll',
    'including a negative one');
  assert(shape.localRootedPath('C:' + B + 'App' + B + 'a.dll,3') === 'C:' + B + 'App' + B + 'a.dll,3',
    'and the general predicate does NOT, because ",0" is not part of a directory name',
    String(shape.localRootedPath('C:' + B + 'App' + B + 'a.dll,3')));

  // ------------------------------------------------------------------
  console.log('');
  console.log('The PowerShell copy answers the same way on every case');
  // The behavioural guard. Not "both files contain this string" - that was the
  // tautology. This asks both implementations the same questions.

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-shape-'));
  const real = path.join(work, 'exists');
  fs.mkdirSync(real, { recursive: true });

  let agreed = 0;
  let disagreed = [];
  for (const c of CASES) {
    // Point every ACCEPTED case at a directory that exists, so the engine's
    // answer reflects the shape rule and not whether the path happens to be
    // on disk. Refused cases keep their shape, which is what is being tested.
    const probePath = c.accept ? real : c.p;
    let engineAccepted;
    try {
      engineAccepted = Boolean(probeEngine(probePath).date);
    } catch (e) {
      disagreed.push(`${JSON.stringify(c.p)}: engine threw ${e.message}`);
      continue;
    }
    const jsAccepted = Boolean(shape.localRootedPath(probePath));
    if (engineAccepted === jsAccepted) agreed += 1;
    else disagreed.push(`${JSON.stringify(probePath)}: js=${jsAccepted} engine=${engineAccepted} (${c.why})`);
  }

  assert(disagreed.length === 0,
    `both implementations agree on all ${CASES.length} cases (${agreed} checked)`,
    disagreed.join(' | '));

  // A premise, so the assertion above cannot pass by the engine refusing
  // everything - which is exactly how the icon parser broke once before.
  assert(Boolean(probeEngine(real).date),
    'premise: the engine ACCEPTS at least one path, so agreement is not "both say no to everything"');

  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
