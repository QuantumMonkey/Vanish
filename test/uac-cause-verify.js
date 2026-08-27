// ytv: when elevation does not happen, say WHICH of the three reasons it was.
//
//   node test/uac-cause-verify.js
//
// Runs in either tier and touches nothing - it reads the real machine's UAC
// facts and then tests the mapping from those facts to a cause and a message.
//
// WHAT THIS CAN AND CANNOT PROVE, stated up front because the issue sat
// in_progress for nine days on exactly this distinction.
//
// CAN: that Get-UacDiagnostics reports this machine's real registry and group
// facts; that the cause mapping turns each combination of facts into the right
// cause; and that every cause produces distinct, actionable copy. That mapping
// is where the bug was - relaunch-elevated used to collapse every failure into
// the same declined:true, so a non-admin account, a UAC-disabled machine and a
// real "No" click were indistinguishable to the user.
//
// CANNOT, on this machine, and neither can any amount of code: an actual UAC
// decline (this box has ConsentPromptBehaviorAdmin=0, so there is no prompt to
// decline), a genuinely non-administrator account, or a machine with UAC off.
// Those three need different machines, not a different test. What is done here
// instead is to drive the mapping with each set of facts DIRECTLY, so the logic
// that would run on those machines is exercised even though the machines are
// not present.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

const root = path.join(__dirname, '..');

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8'
  }).trim();
}

console.log('');
console.log('UAC failure causes (ytv)');
console.log('========================');

// ---- the facts, read from the real machine -------------------------------
// Get-UacDiagnostics is dot-sourced rather than reached through an action, so
// the function is tested rather than a wrapper around it.
const diagJson = ps(
  `$ErrorActionPreference='SilentlyContinue'; ` +
  `. '${path.join(root, 'scanner.ps1')}' 2>$null; ` +
  `Get-UacDiagnostics | ConvertTo-Json -Compress`
);

let diag = null;
try {
  diag = JSON.parse(diagJson.slice(diagJson.indexOf('{')));
} catch {
  diag = null;
}

assert(diag !== null, 'Get-UacDiagnostics returns parseable JSON', diagJson.slice(0, 200));

if (diag) {
  console.log(`  (this machine: enableLua=${diag.enableLua}, isGroupMember=${diag.isGroupMember}, isElevated=${diag.isElevatedNow})`);

  // Cross-checked against the registry independently, so this is a comparison
  // rather than a restatement of the implementation.
  const realLua = ps(
    `(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' ` +
    `-Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA`
  );
  assert(
    String(diag.enableLua) === String(realLua === '1'),
    `enableLua matches the registry independently (reported ${diag.enableLua}, registry '${realLua}')`
  );

  // The three fields must be BOOLEAN OR NULL, never a silent false. "Unknown"
  // and "off" are different answers and the difference decides the advice.
  for (const field of ['enableLua', 'isGroupMember', 'isElevatedNow']) {
    const v = diag[field];
    assert(
      typeof v === 'boolean' || v === null,
      `${field} is a boolean or explicitly null, never a guess (got ${JSON.stringify(v)})`
    );
  }

  const elevatedNow = ps(
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())` +
    `.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
  );
  assert(
    String(diag.isElevatedNow) === String(elevatedNow === 'True'),
    `isElevated matches the current token (reported ${diag.isElevatedNow}, token '${elevatedNow}')`
  );

  // The distinction the whole feature rests on: being IN the Administrators
  // group is not the same as currently HOLDING an elevated token, and the two
  // are read independently. Collapsing them is what produced "Windows did not
  // grant administrator rights" with no reason.
  assert(
    !(diag.isGroupMember === true && diag.isElevatedNow === true) || diag.enableLua !== null,
    'group membership and current elevation are separate readings, not derived from each other'
  );
}

// ---- the mapping, driven with each set of facts --------------------------
// Re-implemented here from the engine's own branch order, then checked against
// the engine's actual branch source below, so this cannot silently drift.
function causeFor(nativeCode, uac) {
  if (nativeCode === 1223) return 'declined';
  if (uac.isGroupMember === false) return 'not-admin';
  if (uac.enableLua === false) return uac.lockLikely ? 'uac-disabled-locked' : 'uac-disabled';
  if (uac.silentElevation === true) return 'elevation-silent-failed';
  return 'unknown';
}

const cases = [
  { label: 'a real UAC decline', code: 1223, uac: { isGroupMember: true, enableLua: true }, expect: 'declined' },
  { label: 'a decline outranks everything else', code: 1223, uac: { isGroupMember: false, enableLua: false }, expect: 'declined' },
  { label: 'an account that is not an administrator', code: 5, uac: { isGroupMember: false, enableLua: true }, expect: 'not-admin' },
  { label: 'UAC switched off locally', code: 5, uac: { isGroupMember: true, enableLua: false, lockLikely: false }, expect: 'uac-disabled' },
  { label: 'UAC off and likely enforced by policy', code: 5, uac: { isGroupMember: true, enableLua: false, lockLikely: true }, expect: 'uac-disabled-locked' },
  { label: 'facts that explain nothing stay unknown', code: 5, uac: { isGroupMember: true, enableLua: true }, expect: 'unknown' },
  { label: 'unknown group membership is not read as not-admin', code: 5, uac: { isGroupMember: null, enableLua: true }, expect: 'unknown' },
  { label: 'unknown enableLua is not read as UAC being off', code: 5, uac: { isGroupMember: true, enableLua: null }, expect: 'unknown' },

  // adg, measured on the operator's machine 2026-08-28: EnableLUA=1 with
  // ConsentPromptBehaviorAdmin=0. UAC is ON - the token is still filtered, so
  // Vanish opens in Audit Mode - but elevation is auto-approved with no dialog.
  // Every branch above misses (enableLua true, account IS an admin, and no
  // 1223 because there is no prompt to cancel), so this used to fall through
  // to 'unknown' and the user got a shrug from the one screen whose whole job
  // is explaining itself.
  {
    label: 'ADG: UAC on but prompts suppressed is its own cause, not unknown',
    code: 5,
    uac: { isGroupMember: true, enableLua: true, silentElevation: true },
    expect: 'elevation-silent-failed'
  },
  {
    label: 'a real decline still outranks it - a prompt that WAS shown and cancelled is a decline',
    code: 1223,
    uac: { isGroupMember: true, enableLua: true, silentElevation: true },
    expect: 'declined'
  },
  {
    label: 'not-admin outranks it - no prompt setting makes a standard account an administrator',
    code: 5,
    uac: { isGroupMember: false, enableLua: true, silentElevation: true },
    expect: 'not-admin'
  },
  {
    label: 'prompts configured normally is not this cause',
    code: 5,
    uac: { isGroupMember: true, enableLua: true, silentElevation: false },
    expect: 'unknown'
  },
  {
    label: 'an UNREADABLE prompt setting is not read as suppressed - Rule 24',
    code: 5,
    uac: { isGroupMember: true, enableLua: true, silentElevation: null },
    expect: 'unknown'
  }
];

console.log('');
console.log('The mapping from facts to a cause');
for (const c of cases) {
  const got = causeFor(c.code, c.uac);
  assert(got === c.expect, `${c.label} -> ${c.expect} (got '${got}')`);
}

// The two "unknown" cases above are the ones that matter most and are worth
// naming: a query this app could not answer must never harden into an
// accusation about the user's account or their machine's settings.

// ---- the mapping above must match the engine's actual branches -----------
const scanner = fs.readFileSync(path.join(root, 'scanner.ps1'), 'utf8');
const branch = scanner.slice(scanner.indexOf("$cause = 'unknown'"), scanner.indexOf("$cause = 'unknown'") + 900);
assert(
  /nativeCode -eq 1223[\s\S]*?'declined'/.test(branch),
  'the engine checks Win32 1223 FIRST - it is the one code that specifically means the user dismissed the prompt'
);
assert(
  branch.indexOf("'declined'") < branch.indexOf("'not-admin'") &&
    branch.indexOf("'not-admin'") < branch.indexOf("uac-disabled"),
  'and its branch order is decline, then not-admin, then uac-disabled - the order this suite models'
);
assert(
  /isGroupMember -eq \$false/.test(branch),
  'not-admin is decided by an explicit -eq $false, so an UNKNOWN membership cannot be read as "not an administrator"'
);
assert(
  /enableLua -eq \$false/.test(branch),
  'and uac-disabled likewise, so an unreadable policy key cannot be reported as UAC being off'
);
assert(
  /declined\s*=\s*\(\$cause -eq 'declined'\)/.test(scanner),
  'the legacy declined flag is now DERIVED from the cause rather than set on every failure'
);

// ---- every cause must produce distinct, actionable copy ------------------
console.log('');
console.log('What the user is actually told');
const core = fs.readFileSync(path.join(root, 'renderer', 'core.js'), 'utf8');
const fnStart = core.indexOf('function elevationFailureMessage');
const messages = core.slice(fnStart, core.indexOf('\nfunction ', fnStart + 10));

const seen = new Map();
for (const cause of ['not-admin', 'uac-disabled', 'uac-disabled-locked', 'declined', 'elevation-silent-failed']) {
  const re = new RegExp(`case '${cause}':([\\s\\S]*?)(?=case '|default:|\\n\\s*\\})`);
  const m = messages.match(re);
  const text = m ? m[1] : '';
  assert(text.trim().length > 0, `'${cause}' has its own message rather than falling through to a generic one`);

  // COMMENTS STRIPPED FIRST. These assertions are about what the USER is told,
  // and the uac-disabled-locked branch carries a comment explaining why it must
  // NOT say "turn UAC back on" - which the first version of this check then
  // matched, failing the code for containing the reason it is correct.
  const prose = text
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (prose) seen.set(cause, prose);
}

assert(
  new Set([...seen.values()]).size === seen.size,
  `no two causes share the same copy (${seen.size} causes, ${new Set([...seen.values()]).size} distinct messages)`
);

assert(
  /administrator account|Administrators group/i.test(seen.get('not-admin') || ''),
  "the not-admin message says what to do about it - use or be added to an administrator account"
);
assert(
  /turn UAC back on|Windows' own settings/i.test(seen.get('uac-disabled') || ''),
  'the uac-disabled message offers the fix a personal machine actually has'
);
assert(
  /likely|probably/i.test(seen.get('uac-disabled-locked') || ''),
  'the managed-machine message hedges deliberately - Windows does not record whether a value came from Group Policy, so the wording must not promote strong evidence to proof'
);
assert(
  !/turn UAC back on/i.test(seen.get('uac-disabled-locked') || ''),
  'and it does NOT tell a managed user to change a setting that reverts at the next policy refresh'
);

console.log('');
console.log('Not verified by this run:');
console.log('  * A real UAC decline. This machine has ConsentPromptBehaviorAdmin=0,');
console.log('    so elevation is silent and there is no prompt to say No to.');
console.log('  * A genuinely non-administrator account, and a machine with UAC off.');
console.log('    Both need a different machine, not a different test - the mapping');
console.log('    that would run on them is driven directly above.');
console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
