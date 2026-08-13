// UAC policy-lock diagnostics (qyt).
//
// Operator, 2026-08-11: "uac disabled status is visible to vanish, and it
// should be able to discern vanish being disabled against it being perm locked,
// as is common in perm locked corporate machines."
//
// Both cases read EnableLUA = 0. The difference is what the user can do about
// it: on a personal machine "turn UAC back on" is actionable, and on a
// GPO-managed one the setting reverts at the next policy refresh, so the same
// advice sends them in a circle.
//
// Windows does not tag policy-origin on these values, so there is no flag to
// read and the answer is necessarily a heuristic. That makes the WORDING part
// of the contract, not decoration - which is why this suite asserts on it. The
// claim Vanish is entitled to is "this looks likely"; "Group Policy has locked
// this" is a claim it cannot support and must never make.
//
// The probe itself is asserted too, because its most dangerous failure mode is
// silent: an unelevated process cannot write HKLM under any circumstances, so a
// writability test that forgets to check elevation first reports "locked by
// policy" on every ordinary home machine - confident, plausible and wrong,
// which is the exact failure this issue exists to prevent.
//
//   node test/uac-lock-verify.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

const ROOT = path.join(__dirname, '..');
const scanner = fs.readFileSync(path.join(ROOT, 'scanner.ps1'), 'latin1');
const core = fs.readFileSync(path.join(ROOT, 'renderer', 'core.js'), 'utf8');

console.log('');
console.log('Vanish UAC policy-lock diagnostics (qyt)');
console.log('=======================================');

// --- The probe's guards --------------------------------------------------
console.log('');
console.log('The writability probe cannot produce a false "locked"');

assert(/\$policyWritable\s*=\s*\$null\s*[\r\n]+\s*if\s*\(\$isElevatedNow\)\s*\{/.test(scanner),
  'the probe only runs when the process is already elevated, and defaults to null otherwise');
assert(/VanishWriteProbe/.test(scanner),
  'it writes a scratch value rather than toggling EnableLUA itself');
assert(!/Set-ItemProperty[^\r\n]*EnableLUA/.test(scanner),
  'nothing in the engine ever writes EnableLUA - a half-failed revert would leave UAC off');
assert(/finally\s*\{\s*try\s*\{\s*Remove-ItemProperty[^}]*VanishWriteProbe|finally\s*\{[\s\S]{0,120}Remove-ItemProperty/.test(scanner),
  'the scratch value is removed in a finally block, so a throw mid-probe still cleans up');
assert(/\$lockLikely\s*=\s*\(\$partOfDomain\s*-eq\s*\$true\s*-and\s*\$policyWritable\s*-eq\s*\$false\)/.test(scanner),
  'a lock is only claimed when domain-joined AND an admin token was actually refused');
assert(/\$partOfDomain\s*=\s*\$null/.test(scanner),
  'an unreadable domain membership stays null - unknown is not false (Rule 24)');

// --- The cause it feeds --------------------------------------------------
console.log('');
console.log('The failure cause distinguishes the two cases');

assert(/\$cause\s*=\s*if\s*\(\$uac\.lockLikely\)\s*\{\s*'uac-disabled-locked'\s*\}\s*else\s*\{\s*'uac-disabled'\s*\}/.test(scanner),
  "uac-disabled-locked is only reported when lockLikely is true, never as the default");
assert(/case 'uac-disabled-locked':/.test(core),
  'the renderer has a message for the new cause rather than falling through to the generic one');

// --- The wording is part of the contract ---------------------------------
console.log('');
console.log('The wording claims what the heuristic can support and no more');

// Read the RETURNED STRING only, not the surrounding comments. A first draft of
// this suite scanned the whole case block and failed on a comment that quoted
// the other branch's advice in order to explain why it does not apply here.
function messageFor(cause) {
  const block = core.slice(core.indexOf(`case '${cause}':`));
  const body = block.slice(0, block.indexOf('case ', 10));
  return body
    .split(/[\r\n]+/)
    .filter((line) => !line.trim().startsWith('//'))
    .join(' ');
}

const lockedMessage = messageFor('uac-disabled-locked');

assert(/likely/i.test(lockedMessage),
  'the message says "likely" rather than stating policy enforcement as fact');
assert(!/Group Policy has|is locked by|has been locked/i.test(lockedMessage),
  'it never asserts Group Policy did this - Windows does not record that');
assert(/administers this PC|your organisation|organization/i.test(lockedMessage),
  'it points at the person who can actually change it');
assert(!/turn UAC back on/i.test(lockedMessage),
  'it does NOT repeat the personal-machine advice, which is the whole point of the split');

const plainMessage = messageFor('uac-disabled');
assert(/turn UAC back on/i.test(plainMessage),
  'the unmanaged case still gives the advice a home user can act on');

// --- And it actually runs ------------------------------------------------
console.log('');
console.log('Get-UacDiagnostics returns the new fields on this machine');

let diag = null;
try {
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scanner.ps1'), '-Action', 'check-admin'],
    { encoding: 'utf8', timeout: 60000 });
  diag = JSON.parse(out).uac;
} catch (e) {
  assert(false, `check-admin ran (${e.message})`);
}

if (diag) {
  assert(Object.prototype.hasOwnProperty.call(diag, 'partOfDomain'), 'partOfDomain is present');
  assert(Object.prototype.hasOwnProperty.call(diag, 'policyWritable'), 'policyWritable is present');
  assert(Object.prototype.hasOwnProperty.call(diag, 'lockLikely'), 'lockLikely is present');
  assert(diag.lockLikely === false || diag.lockLikely === true, 'lockLikely is a boolean, never null');
  // The guard, checked against reality rather than against the regex above.
  if (diag.isElevatedNow === false) {
    assert(diag.policyWritable === null,
      'unelevated, the probe reports null rather than false - no false "locked" on a home machine');
    assert(diag.lockLikely === false,
      'unelevated, no lock is claimed');
  } else {
    assert(diag.policyWritable === true || diag.policyWritable === false,
      'elevated, the probe returns a real answer');
  }
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
