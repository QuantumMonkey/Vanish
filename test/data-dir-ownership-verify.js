// isp: SEC-3 protection must SURVIVE our own writes.
//
//   node test/data-dir-ownership-verify.js
//
// WHAT WENT WRONG. secure-data-dir locks the Vanish state directory so the
// elevated engine is not reading manifest.json out of a folder a standard user
// can rewrite. It worked. Then, measured live on 2026-08-28: check-data-dir
// said protected, a suite wrote 58 purges into the vault, and check-data-dir
// then said NOT protected - naming vault/manifest.json as owned by the
// interactive user, while the process doing the writing was ELEVATED.
//
// The DACL inherits. The OWNER does not: Windows gives a new object to its
// creator, so every atomic write (temp file, rename over the target) minted a
// fresh file owned by 'Anand'. An owner keeps WRITE_DAC forever, so the check
// was right to object - it was our own writes manufacturing the evidence.
//
// The guard therefore worked or did not depending on whether anything had
// written since secure-data-dir last ran. That is not a security control, and
// it is what made the z3s protected-restore leg look intermittent for days.
//
// THE NEGATIVE CONTROL IS THE POINT OF THIS FILE. It would be trivial to write
// a suite here that passes on a machine where nothing is wrong and would also
// have passed before the fix. So this runs the SAME write twice: once with
// enforcement off, which must break protection, and once with it on, which must
// not. If the first leg does not fail, the second leg proves nothing and the
// suite says so rather than reporting green.
//
// ELEVATION IS A PREMISE, NOT A RESULT. Only an elevated process can take
// ownership or read another user's ACL reliably. Unelevated, this SKIPS with
// the reason named. It does not pass.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const scanner = path.join(root, 'scanner.ps1');
const store = require(path.join(root, 'lib', 'store.js'));

let pass = 0;
let fail = 0;
let skipped = 0;

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

function skip(label, why) {
  console.log(`  SKIP  ${label}`);
  console.log(`        ${why}`);
  skipped += 1;
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

function engine(action, params) {
  const b64 = Buffer.from(JSON.stringify(params || {}), 'utf8').toString('base64');
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scanner, '-Action', action, '-ParamsBase64', b64],
    { encoding: 'utf8', windowsHide: true }
  );
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`engine returned no JSON for ${action}: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start));
}

function ownerOf(target) {
  try {
    return ps(
      `(Get-Acl -LiteralPath '${target.replace(/'/g, "''")}')` +
        `.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`
    );
  } catch {
    return '(unreadable)';
  }
}

console.log('');
console.log('SEC-3 data-dir ownership survives our own writes (isp)');
console.log('=====================================================');

const elevated =
  ps(
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
  ) === 'True';

assert(true, `read this machine's elevation state (elevated=${elevated})`);

if (!elevated) {
  skip(
    'the whole suite',
    'Taking ownership requires an elevated token, and so does re-securing the directory afterwards. ' +
      'Unelevated, every assertion below would be about a directory nothing could protect in the first ' +
      'place - a vacuous pass. Re-run from an elevated shell.'
  );
  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-isp-'));
let stateDir = null;

try {
  store.init(work);
  stateDir = store.dataDir();

  // ---- premise: the directory can be secured at all ----------------------
  const applied = engine('secure-data-dir', { path: stateDir });
  assert(applied.success === true, `secure-data-dir applied to a fresh state directory (${applied.error || 'no error'})`);

  let check = engine('check-data-dir', { path: stateDir });
  const securable = check.protected === true;
  assert(securable, `and check-data-dir agrees it is protected (foreignOwners=${JSON.stringify(check.foreignOwners || [])})`);

  if (!securable) {
    skip(
      'both write legs',
      'The directory could not be brought into a protected state to begin with, so neither leg below ' +
        'would be measuring what a write does to protection. Fix secure-data-dir first.'
    );
  } else {
    // ---- NEGATIVE CONTROL: without the fix, a write must break it --------
    // This leg exists so a green second leg means something. If writing with
    // enforcement OFF leaves protection intact, this machine cannot reproduce
    // isp and the real assertion is unfalsifiable here.
    store.setOwnershipEnforcement(false);
    assert(store.ownershipEnforcementEnabled() === false, 'enforcement can be switched off for the control leg');

    store.addManifestEntry({ id: store.newId(), status: 'quarantined', control: true });
    const afterUnfixed = engine('check-data-dir', { path: stateDir });
    const reproduced = afterUnfixed.protected === false;
    assert(
      reproduced,
      'NEGATIVE CONTROL: with the fix off, one manifest write breaks protection - so this suite can see the bug',
      `owner of manifest.json is now ${ownerOf(store.vaultRoot() + '\\manifest.json')}; ` +
        `foreignOwners=${JSON.stringify(afterUnfixed.foreignOwners || [])}`
    );

    // ---- THE ASSERTION THIS FILE EXISTS FOR ------------------------------
    engine('secure-data-dir', { path: stateDir });
    const resecured = engine('check-data-dir', { path: stateDir });
    assert(resecured.protected === true, 'the directory can be re-secured after the control leg');

    if (!reproduced) {
      skip(
        'THE ASSERTION THIS EXISTS FOR',
        'The control leg did NOT break protection, so this machine does not exhibit isp and a passing ' +
          'result below would be indistinguishable from the unfixed code. Most likely cause: ' +
          'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\nodefaultadminowner is set to 1 here, which ' +
          'makes Windows assign new objects to Administrators by default.'
      );
    } else if (resecured.protected !== true) {
      skip('THE ASSERTION THIS EXISTS FOR', 'the directory could not be re-secured, so the second leg has no clean starting point');
    } else {
      store.setOwnershipEnforcement(true);
      assert(store.ownershipEnforcementEnabled() === true, 'enforcement is on for the real leg');

      store.addManifestEntry({ id: store.newId(), status: 'quarantined', control: false });
      const afterFixed = engine('check-data-dir', { path: stateDir });
      assert(
        afterFixed.protected === true,
        'THE ASSERTION THIS EXISTS FOR: the SAME write with enforcement on leaves the directory protected',
        `foreignOwners=${JSON.stringify(afterFixed.foreignOwners || [])}; ` +
          `manifest owner is ${ownerOf(store.vaultRoot() + '\\manifest.json')}`
      );
      assert(
        (afterFixed.foreignOwners || []).length === 0,
        'and it names no foreign owner at all, rather than being protected despite one'
      );

      // Every write path, not just the manifest - settings and the queue live
      // in the same directory and the same check reads all of them.
      store.writeSettings({ scanMode: 'Safe' });
      store.writeQueue({ schemaVersion: 1, items: [] });
      store.appendOplog({ action: 'isp-verify', tier: 'full', outcome: 'success' });
      const afterAll = engine('check-data-dir', { path: stateDir });
      assert(
        afterAll.protected === true,
        'settings.json, queue.json and oplog.jsonl are covered too, not just the manifest',
        `foreignOwners=${JSON.stringify(afterAll.foreignOwners || [])}`
      );

      // Ownership is claimed for BUILTIN\Administrators specifically. Checking
      // the SID rather than "not the interactive user" keeps this honest on a
      // machine where the elevated account is not called Anand.
      assert(
        ownerOf(path.join(store.vaultRoot(), 'manifest.json')) === 'S-1-5-32-544',
        'and the owner is BUILTIN\\Administrators by SID, not merely some other principal'
      );
    }
  }

  // ---- the switch itself must be safe in Audit Mode ----------------------
  assert(
    store.setOwnershipEnforcement(false) === false && store.assertAdminOwner('C:\\Windows').applied === false,
    'with enforcement off, assertAdminOwner does nothing at all - Audit Mode pays no cost and touches nothing'
  );
} finally {
  store.setOwnershipEnforcement(false);
  try {
    if (stateDir && fs.existsSync(stateDir)) {
      // The directory was deliberately made admin-owned with inheritance
      // severed, so a plain rmSync can fail. Hand it back before removing it.
      execFileSync('icacls.exe', [work, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore', windowsHide: true });
    }
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch (err) {
    console.log(`  NOTE  could not remove ${work}: ${err.message}`);
  }
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
