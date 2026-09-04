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
//
// A `finally` IS NOT ENOUGH, AND THIS HAPPENED. On 2026-09-04 a run was killed
// by its wrapper's timeout while a mutant was planted, and `finally` never got
// to run - a hard kill does not unwind. What it left in the working tree was
// the SEC-2 mutant: `Test-ProtectedDestination` no longer resolving junctions,
// which is the exact privilege-escalation guard the previous session had added
// a test for. It was caught by `git status` a minute later, but "caught by
// someone remembering to look" is not a control.
//
// So the restore is JOURNALLED. Before a file is mutated its original bytes go
// to .in-flight.bak with a .in-flight.json naming the target, and both are
// removed only after the file is put back. Any run - this one or the next -
// repairs a leftover before doing anything else, and says so loudly. The
// journal files are gitignored; the repair works from the backup rather than
// from git, so it is correct even on a tree with real uncommitted work in it.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MUTANTS = require('./mutants.json');

const JOURNAL = path.join(__dirname, '.in-flight.json');
const BACKUP = path.join(__dirname, '.in-flight.bak');

function clearJournal() {
  for (const f of [JOURNAL, BACKUP]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
  }
}

function repairLeftover() {
  if (!fs.existsSync(JOURNAL) || !fs.existsSync(BACKUP)) {
    // A half-written journal is itself suspicious, so say so rather than
    // quietly tidying up.
    if (fs.existsSync(JOURNAL) || fs.existsSync(BACKUP)) {
      console.log('WARNING  a partial mutation journal was found and could not be used to repair.');
      console.log('         Check `git status` before trusting this run.');
      clearJournal();
    }
    return;
  }
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch { entry = null; }
  if (!entry || !entry.file) {
    console.log('WARNING  the mutation journal is unreadable. Check `git status` before trusting this run.');
    clearJournal();
    return;
  }
  fs.writeFileSync(entry.file, fs.readFileSync(BACKUP));
  clearJournal();
  console.log('REPAIRED  a previous run was killed with a mutant still planted in ' + entry.file);
  console.log('          ("' + (entry.label || 'unlabelled') + '") - the original bytes have been put back.');
  console.log('');
}

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

repairLeftover();

// The same repair on the ways out that DO unwind. A hard kill still needs the
// journal, but a Ctrl-C or an uncaught throw can put the file back right now.
let currentOriginal = null;
let currentFile = null;
function restoreNow() {
  if (currentFile !== null && currentOriginal !== null) {
    try { fs.writeFileSync(currentFile, currentOriginal, 'utf8'); } catch { /* journal covers it */ }
    currentFile = null;
    currentOriginal = null;
  }
  clearJournal();
}
process.on('SIGINT', () => { restoreNow(); process.exit(130); });
process.on('SIGTERM', () => { restoreNow(); process.exit(143); });
process.on('uncaughtException', (e) => {
  restoreNow();
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

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
    // Journal BEFORE the write, so a kill between the two lines leaves a
    // backup that matches the file still on disk rather than one that does not.
    fs.writeFileSync(BACKUP, original, 'utf8');
    fs.writeFileSync(JOURNAL, JSON.stringify({ file: mut.file, label: mut.label }), 'utf8');
    currentFile = mut.file;
    currentOriginal = original;

    const mutated = normalised.split(mut.find).join(mut.replace);
    fs.writeFileSync(mut.file, isCrlf ? mutated.split(LF).join(CRLF) : mutated, 'utf8');
    r = runSuite(mut.suite);
  } finally {
    fs.writeFileSync(mut.file, original, 'utf8');
    currentFile = null;
    currentOriginal = null;
    clearJournal();
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
