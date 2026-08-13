// 1dq Verify: relaunch intent is recorded and checked in BOTH directions.
//
// The bug this regresses, from the operator's round trip on 2026-08-13:
//
//   04:35:50  relaunch-deelevated  outcome=success   (clicked "Restart now")
//   04:37:20  app-start            tier=FULL         <- came back elevated
//   04:37:29  relaunch-deelevated  outcome=success   (tried again)
//
// Two de-elevations reported success, neither happened, and nothing anywhere
// said so - because the only mismatch check that existed asked "did we ask to
// ELEVATE and land in Audit?". The mirror question was never asked.
//
// The check itself lives in main.js's bootstrap, which cannot be imported
// without booting Electron. What is testable, and what actually broke, is the
// decision it makes: given a recorded intent and a landed tier, is this a
// mismatch and which one. That decision is reproduced here exactly as main.js
// evaluates it, and pinned so an edit to one cannot silently diverge from the
// other without this failing.
//
//   node test/elevation-intent-verify.js

const fs = require('node:fs');
const path = require('node:path');

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

const TIER_FULL = 'full';
const TIER_AUDIT = 'audit';
const FIVE_MIN = 5 * 60 * 1000;

// Mirrors main.js: wanted tier is derived from the recorded direction, landed
// tier from the live elevation check, and a recent marker landing anywhere
// other than where it intended is a mismatch.
function evaluate(marker, isFull, now) {
  if (!marker || typeof marker.attemptedAt !== 'string') return null;
  const msSinceAttempt = now - Date.parse(marker.attemptedAt);
  const recent = msSinceAttempt >= 0 && msSinceAttempt < FIVE_MIN;
  const wanted = marker.direction === 'deelevate' ? TIER_AUDIT : TIER_FULL;
  const landed = isFull ? TIER_FULL : TIER_AUDIT;
  if (!recent || landed === wanted) return null;
  return {
    action: marker.direction === 'deelevate' ? 'relaunch-deelevated-mismatch' : 'relaunch-elevated-mismatch',
    wantedTier: wanted,
    landedTier: landed
  };
}

const now = Date.parse('2026-08-13T05:00:00.000Z');
const justNow = new Date(now - 4000).toISOString();
const longAgo = new Date(now - 60 * 60 * 1000).toISOString();

console.log('');
console.log('Relaunch intent verification (1dq)');
console.log('==================================');

// --- the operator's actual failure ----------------------------------------
{
  const r = evaluate({ attemptedAt: justNow, direction: 'deelevate' }, true, now);
  assert(r !== null, 'a de-elevation that lands back in Full Mode IS a mismatch (the 2026-08-13 failure)');
  assert(r && r.action === 'relaunch-deelevated-mismatch', 'and is logged under its own action, not the elevate one');
  assert(r && r.wantedTier === 'audit' && r.landedTier === 'full', 'recording both what was wanted and what happened');
}

// --- the direction that was already covered -------------------------------
{
  const r = evaluate({ attemptedAt: justNow, direction: 'elevate' }, false, now);
  assert(r !== null && r.action === 'relaunch-elevated-mismatch', 'an elevation that lands in Audit is still a mismatch');
}

// --- success in each direction is silent ----------------------------------
{
  assert(evaluate({ attemptedAt: justNow, direction: 'deelevate' }, false, now) === null,
    'a de-elevation that reaches Audit Mode reports nothing');
  assert(evaluate({ attemptedAt: justNow, direction: 'elevate' }, true, now) === null,
    'an elevation that reaches Full Mode reports nothing');
}

// --- a missing direction means elevate, for markers written before 1dq -----
{
  const r = evaluate({ attemptedAt: justNow }, false, now);
  assert(r !== null && r.action === 'relaunch-elevated-mismatch',
    'a marker with no direction is treated as an elevation - the shape 6lg wrote before this existed');
  assert(evaluate({ attemptedAt: justNow }, true, now) === null,
    'and such a marker landing in Full Mode is still a success');
}

// --- staleness guards ------------------------------------------------------
{
  assert(evaluate({ attemptedAt: longAgo, direction: 'deelevate' }, true, now) === null,
    'an hour-old marker is not evidence about THIS boot - a crash before cleanup must not misfire later');
  const future = new Date(now + 60 * 1000).toISOString();
  assert(evaluate({ attemptedAt: future, direction: 'deelevate' }, true, now) === null,
    'a marker from the future is discarded rather than trusted (clock skew)');
  assert(evaluate(null, true, now) === null, 'no marker means nothing to report');
  assert(evaluate({ direction: 'deelevate' }, true, now) === null, 'a malformed marker is ignored, not guessed at');
}

// --- the wiring is really there --------------------------------------------
// Cheap structural checks. They cannot prove the runtime behaviour above, but
// they do catch the specific regression of someone editing main.js back to a
// single-direction check, which is what left this invisible for four sessions.
{
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert(main.includes("direction: 'deelevate'"), 'main.js records a de-elevation intent marker');
  assert(main.includes("direction: 'elevate'"), 'main.js records an elevation intent marker');
  assert(main.includes('relaunch-deelevated-mismatch'), 'main.js can log a de-elevation mismatch');
  assert(/wanted\s*=\s*marker\.direction === 'deelevate'/.test(main),
    'main.js derives the wanted tier from the recorded direction rather than assuming elevate');

  const scanner = fs.readFileSync(path.join(root, 'scanner.ps1'), 'utf8');
  const deelev = scanner.slice(scanner.indexOf('"relaunch-deelevated"'), scanner.indexOf('"list-lockers"'));
  assert(/-Wait/.test(deelev) && /-PassThru/.test(deelev),
    'the engine waits for runas.exe and keeps the process object - success can no longer mean "it launched"');
  assert(/ExitCode/.test(deelev), 'and reads its exit code');
  assert(/RedirectStandardError/.test(deelev), 'and captures the reason it prints');

  const core = fs.readFileSync(path.join(root, 'renderer', 'core.js'), 'utf8');
  assert(core.includes("m.direction === 'deelevate'"), 'the UI has a message for the de-elevation direction');
  assert(core.includes('runas exit code'), 'and surfaces the engine exit code when there is one');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
