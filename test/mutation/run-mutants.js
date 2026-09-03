// Mutation testing: plant a real defect, run the suite that should catch it,
// record whether it did.
//
//   node test/mutation/run-mutants.js
//
// WHY THIS EXISTS. A test that has never failed proves nothing. On 2026-09-03
// this repository had 2,235 assertions and no way to say which of them were
// load-bearing - almost all had only ever been observed passing. The first run
// of this harness found three that could not fail at all, one of which was the
// accumulator behind the product's headline sentence.
//
// A SURVIVOR IS NOT AUTOMATICALLY A GAP. Some mutations do not change
// behaviour (an "equivalent mutant"): the first run reported that removing the
// drive-letter check in parseDisplayIcon admitted UNC paths, and it does not,
// because the following check still rejects them. Check a survivor by hand
// before writing an assertion for it, or you write a test for a bug that was
// never there.
//
// ALWAYS RESTORES, including on crash. Product code is mutated in place and a
// harness that leaves a mutation behind is worse than no harness at all.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MUTANTS = require('./mutants.json');

// Paths in mutants.json are repo-relative and every suite command assumes the
// repo root as cwd, so the harness moves there rather than making each entry
// carry a prefix that would rot the moment a file moves.
process.chdir(path.join(__dirname, '..', '..'));

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const LF = String.fromCharCode(10);

function runSuite(cmd) {
  const parse = (out) => {
    const m = out.match(/Result: (\d+) passed, (\d+) failed/);
    return m ? { ran: true, passed: +m[1], failed: +m[2] } : null;
  };
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600000
    });
    return parse(out) || { ran: false, failed: 0, note: 'no Result line in output' };
  } catch (e) {
    // A non-zero exit is the NORMAL case for a killed mutant - the suite
    // failed, which is the point. Only treat it as broken if no Result line
    // came back at all.
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    return parse(out) || { ran: false, failed: 0, note: 'suite crashed or timed out' };
  }
}

const results = [];
for (const mut of MUTANTS) {
  const original = fs.readFileSync(mut.file, 'utf8');
  const isCrlf = original.indexOf(CRLF) !== -1;
  const normalised = isCrlf ? original.split(CRLF).join(LF) : original;

  if (normalised.split(mut.find).length - 1 !== 1) {
    results.push({ label: mut.label, verdict: 'ANCHOR-MISS' });
    console.log('ANCHOR-MISS  ' + mut.label);
    continue;
  }

  let r;
  try {
    const mutated = normalised.split(mut.find).join(mut.replace);
    fs.writeFileSync(mut.file, isCrlf ? mutated.split(LF).join(CRLF) : mutated, 'utf8');
    r = runSuite(mut.suite);
  } finally {
    fs.writeFileSync(mut.file, original, 'utf8');
  }

  const verdict = !r.ran ? 'SUITE-BROKE' : r.failed > 0 ? 'KILLED' : 'SURVIVED';
  results.push({ label: mut.label, verdict, failed: r.failed || 0, note: r.note || '' });
  console.log(
    verdict.padEnd(12) + mut.label + (r.failed ? '  (' + r.failed + ' failed)' : '')
  );
}

const by = (v) => results.filter((r) => r.verdict === v);
const scored = results.length - by('ANCHOR-MISS').length;

console.log('');
console.log('KILL RATE: ' + by('KILLED').length + '/' + scored + ' mutants caught');

if (by('SURVIVED').length) {
  console.log('');
  console.log('SURVIVORS - verify each by hand before assuming it is a gap:');
  by('SURVIVED').forEach((s) => console.log('   ' + s.label));
}
if (by('SUITE-BROKE').length) {
  console.log('');
  console.log('SUITE BROKE - no Result line, so the suite could not judge:');
  by('SUITE-BROKE').forEach((s) => console.log('   ' + s.label + ' - ' + s.note));
}
if (by('ANCHOR-MISS').length) {
  console.log('');
  console.log('ANCHOR MISS - a harness bug, not a result:');
  by('ANCHOR-MISS').forEach((s) => console.log('   ' + s.label));
}
