// What the scheduling is worth, all three orderings in ONE run (3l8).
//
//   node test/sandbox/hygiene-scheduling-probe.js
//
// The three numbers in docs/BENCHMARKS.md Run 002 come from here. They have to
// be measured in one run to be subtractable: the absolute wall clock on a
// developer machine moves 10-20% between runs depending on what last touched
// the disk, so a figure from yesterday minus a figure from today is not a
// result. Three passes, back to back, only the queue order differing.
//
//   0.9.1 behaviour   one engine call per check, registry order
//   3l8 half          checks that share a walk in one call, registry order
//   3l8 shipped       the same, largest unit first
//
// The grouping and ordering here are deliberately a SECOND implementation of
// what renderer/hygiene.js does, written from the same walkGroup field the
// engine reports. That is the point: it can schedule the 0.9.1 way, which the
// product no longer can, so the before number is measured rather than
// remembered from a previous release on a different day.
//
// Plain node, no Electron: this measures the ENGINE, not the panel. For what
// a person actually waits through, with the rest of the app loading beside it,
// use hygiene-wallclock-probe.js. Neither is in run-all.ps1 - both walk the
// real disk for minutes, and a timing assertion on hardware nobody controls is
// a flaky test wearing a performance badge.

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const scanner = path.join(root, 'scanner.ps1');
const CONCURRENCY = 3;

function engine(action, params) {
  const b64 = Buffer.from(JSON.stringify(params)).toString('base64');
  const t = Date.now();
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scanner, '-Action', action, '-ParamsBase64', b64]);
    let out = '';
    ps.stdout.on('data', (c) => { out += c; });
    ps.on('close', () => {
      let json = null;
      try { json = JSON.parse(out); } catch { json = null; }
      resolve({ json, ms: Date.now() - t });
    });
  });
}

async function runPool(units) {
  const queue = units.slice();
  const marks = [];
  const t0 = Date.now();
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i += 1) {
    workers.push((async () => {
      for (;;) {
        const unit = queue.shift();
        if (!unit) return;
        const r = await engine('hygiene-scan', { finders: unit });
        const results = (r.json && r.json.results) || [];
        marks.push({ unit: unit.join('+'), ms: r.ms, results: results.length });
      }
    })());
  }
  await Promise.all(workers);
  return {
    wall: Date.now() - t0,
    marks,
    reported: marks.reduce((n, m) => n + m.results, 0),
    summed: marks.reduce((n, m) => n + m.ms, 0)
  };
}

(async () => {
  const probe = await engine('finder-probe', { mode: 'list' });
  const finders = (probe.json && probe.json.finders) || [];
  if (finders.length === 0) {
    console.log('  the engine registered no checks, so there is nothing to schedule');
    process.exit(1);
  }

  const perCheck = finders.map((f) => [f.name]);

  const grouped = [];
  const byGroup = new Map();
  for (const f of finders) {
    const g = String(f.walkGroup || '').trim();
    if (!g) { grouped.push([f.name]); continue; }
    if (!byGroup.has(g)) { const u = []; byGroup.set(g, u); grouped.push(u); }
    byGroup.get(g).push(f.name);
  }

  const largestFirst = grouped
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => (b.unit.length - a.unit.length) || (a.index - b.index))
    .map((x) => x.unit);

  console.log('');
  console.log(`Hygiene scheduling, ${finders.length} checks, ${CONCURRENCY} at a time`);
  console.log('='.repeat(52));
  if (grouped.length === perCheck.length) {
    console.log('  NOTE: no check declares a walkGroup, so the first two passes are');
    console.log('        the same queue and only the ordering pass means anything.');
  }

  const passes = [
    ['0.9.1: one call per check, registry order', perCheck],
    ['0.9.2: shared walk, registry order       ', grouped],
    ['0.9.2: shared walk, largest unit first   ', largestFirst]
  ];

  const done = [];
  for (const [label, units] of passes) {
    const r = await runPool(units);
    done.push([label, r]);
    console.log(`${label}   WALL ${(r.wall / 1000).toFixed(1)} s   ${r.marks.length} calls   ${r.reported}/${finders.length} checks`);
  }

  console.log('');
  for (const [label, r] of done) {
    const slowest = r.marks.slice().sort((a, b) => b.ms - a.ms)[0];
    console.log(`${label}   summed ${(r.summed / 1000).toFixed(1)} s, slowest unit ${(slowest.ms / 1000).toFixed(1)} s (${slowest.unit})`);
  }

  // Every pass must report every check. A pass that lost one would make the
  // wall clock look better for the worst possible reason, and comparing a
  // 13-check run against a 12-check one is not a measurement.
  const short = done.filter(([, r]) => r.reported !== finders.length);
  if (short.length > 0) {
    console.log('');
    for (const [label, r] of short) {
      console.log(`  NOT COMPARABLE: ${label.trim()} reported ${r.reported} of ${finders.length} checks`);
    }
    process.exit(1);
  }
})();
