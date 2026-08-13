// GPU per-process payload shape (aaw follow-up).
//
// WHY THIS EXISTS: `aaw` changed the accumulator inside Get-GpuUsageByProcess
// from a plain number to @{ total; adapters } so the table could say WHICH
// adapter a process was using. The projection that builds the returned byPid
// map was not changed with it, and kept doing:
//
//     [Math]::Round([Math]::Min(100, $byPid[$k]), 1)
//
// [Math]::Min cannot take a hashtable, so that threw once per running process,
// byPid came back empty, and every row in the Task Manager table showed "0%" or
// a dash. It shipped in 0.5.0.
//
// It survived a release because it looked HALF-ALIVE rather than broken:
// $byAdapter is a separate accumulator that is still a plain number, so the
// adapter summary pill went on reporting a perfectly correct "GPU 0: 57%" above
// a table in which no process was using the GPU at all. A feature that is
// visibly working in one place is the easiest kind of broken to miss.
//
// So this asserts the CONTRACT between engine and renderer - the shape
// gpuCellHtml actually reads - rather than any particular percentage, which is
// machine- and moment-dependent.
//
//   node test/gpu-shape-verify.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); fail += 1; }
}

const ROOT = path.join(__dirname, '..');
const scanner = fs.readFileSync(path.join(ROOT, 'scanner.ps1'), 'latin1');

console.log('');
console.log('Vanish GPU per-process payload shape');
console.log('====================================');

// --- The specific regression, as a static check ---------------------------
console.log('');
console.log('The projection matches the accumulator it reads from');

assert(!/\$pidResult\["\$k"\]\s*=\s*\[Math\]::Round\(\[Math\]::Min\(100,\s*\$byPid\[\$k\]\),/.test(scanner),
  'byPid is not passed whole to [Math]::Min - that is the exact line that threw');
assert(/\$byPid\[\$k\]\.total/.test(scanner),
  'the projection reads .total off the accumulator');
assert(/\$byPid\[\$k\]\.adapters\.Keys/.test(scanner),
  'the projection carries the per-adapter breakdown through');

// --- And what the engine actually returns ---------------------------------
console.log('');
console.log('The engine returns that shape on this machine');

let out = '';
let payload = null;
try {
  out = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scanner.ps1'),
      '-Action', 'get-gpu-usage'],
    { encoding: 'utf8', timeout: 90000 });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
}

// A PowerShell error inside the function does not fail the process - it prints
// to the stream and the function returns anyway. That is precisely how this
// regression stayed invisible, so the output is checked for error text as well
// as parsed.
assert(!/Cannot convert argument|MethodException|FullyQualifiedErrorId/i.test(out),
  'the engine emits no PowerShell error text');

try {
  payload = JSON.parse(out.trim());
} catch {
  assert(false, `output parses as JSON (got: ${out.trim().slice(0, 120)})`);
}

if (payload) {
  assert(payload.success === true, 'success is true');
  assert(payload.byPid && typeof payload.byPid === 'object', 'byPid is an object');
  assert(Array.isArray(payload.byAdapter), 'byAdapter is an array');

  const entries = Object.entries(payload.byPid || {});
  // An idle machine can legitimately report nothing, so an empty map is not a
  // failure on its own - but it IS what the bug looked like, so say so.
  if (entries.length === 0) {
    console.log('  NOTE  byPid is empty - no process was using the GPU at sample time.');
    console.log('        Not a failure, but this is also what the regression looked like:');
    console.log('        re-run while something is rendering to exercise the shape checks.');
  } else {
    const shapesOk = entries.every(([, v]) =>
      v && typeof v === 'object' && typeof v.total === 'number'
      && v.adapters && typeof v.adapters === 'object');
    assert(shapesOk, `every byPid entry is { total: number, adapters: {} } (${entries.length} entries)`);

    const inRange = entries.every(([, v]) => v.total >= 0 && v.total <= 100);
    assert(inRange, 'every total is a percentage between 0 and 100');

    const adaptersNumeric = entries.every(([, v]) =>
      Object.values(v.adapters).every((n) => typeof n === 'number' && n >= 0 && n <= 100));
    assert(adaptersNumeric, 'every per-adapter figure is a percentage');

    // The renderer resolves the busier adapter by joining this index against
    // byAdapter's physIndex. If the two ever stop agreeing, the row falls back
    // to a generic chip and silently stops naming the card.
    const known = new Set((payload.byAdapter || []).map((a) => String(a.physIndex)));
    const joinable = entries.every(([, v]) => Object.keys(v.adapters).every((k) => known.has(k)));
    assert(joinable, 'every adapter index in byPid also appears in byAdapter (the renderer joins on it)');
  }
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
