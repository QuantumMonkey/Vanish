// TASK-04 Verify: elevation tiers enforced end to end (REQ-04, NFR-02, INV-2).
//
// Loads the real main.js and invokes the destructive IPC channels directly -
// the same thing an attacker or a curious user gets from the devtools console,
// bypassing every disabled button. In Audit Mode each one must be REJECTED by
// main.js itself. In Full Mode the same channels must be reachable.
//
//   npx electron test/tier-verify.js            (unelevated -> expects rejects)
//   npx electron test/tier-verify.js            (from an elevated shell -> expects pass-through)
//
// Test-only: uses ipcMain's internal handler map so no test hook has to ship
// inside main.js.

const { app, ipcMain } = require('electron');

// This loads the REAL main.js below, including its startup elevation logic.
// Never let a startupMode:'full' setting left on this machine from real use
// spawn a live UAC prompt and hang an unattended run.
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';

require('../main.js');

const DESTRUCTIVE_CHANNELS = [
  ['purge-remnants', { files: [{ path: 'C:\\Windows\\System32\\notepad.exe' }], registry: [] }],
  ['vault-restore', { entryId: 'does-not-exist' }],
  ['vault-delete', { entryId: 'does-not-exist' }],
  ['create-restore-point', undefined],
  // SEC-1: the channel takes a registry pointer, not a command. A bare string
  // (what the old contract accepted, and what the injection rode in on) must not
  // be executable by any tier - see the raw-string probe below.
  [
    'uninstall-native',
    { type: 'Desktop', registryPath: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VanishTierVerifyNoSuchEntry' }
  ],
  ['kill-process', { pid: 999999 }],
  ['unlock-path', { path: 'C:\\Windows\\System32\\notepad.exe' }],
  ['queue-start', undefined],
  ['cleaner-purge', { cleaner: 'context-menus', items: [] }]
];

const READ_ONLY_CHANNELS = [
  ['get-tier', undefined],
  ['vault-list', undefined],
  ['get-settings', undefined]
];

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

function getHandler(channel) {
  const map = ipcMain._invokeHandlers;
  return map && map.get ? map.get(channel) : null;
}

async function invoke(channel, payload) {
  const handler = getHandler(channel);
  if (!handler) return { __missing: true };
  return handler({ sender: null }, payload);
}

app.whenReady().then(async () => {
  // Let main.js finish resolving the tier before probing.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const tier = await invoke('get-tier');
  const fullMode = tier && tier.isFullMode === true;

  console.log('');
  console.log('Vanish elevation tier verification');
  console.log('==================================');
  console.log(`Resolved tier: ${tier ? tier.tier : 'unknown'}`);
  console.log('');

  console.log('Read-only channels (must work in both tiers)');
  for (const [channel, payload] of READ_ONLY_CHANNELS) {
    const res = await invoke(channel, payload);
    assert(res && !res.__missing && res.rejected !== true, `${channel} is reachable`);
  }

  console.log('');
  console.log(`Destructive channels (tier = ${fullMode ? 'full' : 'audit'})`);
  for (const [channel, payload] of DESTRUCTIVE_CHANNELS) {
    const res = await invoke(channel, payload);

    if (res && res.__missing) {
      console.log(`  SKIP  ${channel} not registered yet (later task)`);
      continue;
    }

    if (fullMode) {
      // In Full Mode the guard must NOT be what stops the call. The call may
      // still fail on its own merits (missing entry id, etc) - that is fine.
      assert(res.rejected !== true, `${channel} is not blocked by the tier guard`);
    } else {
      assert(
        res && res.rejected === true && res.success === false,
        `${channel} is rejected by main.js, not by the UI`
      );
    }
  }

  // SEC-1 contract probe: the old handler took a command string and ran it
  // through cmd.exe. Passing one now must produce a refusal in either tier -
  // rejected by the guard in Audit Mode, refused for want of a pointer in Full
  // Mode - and must never be treated as something to execute.
  console.log('');
  console.log('SEC-1: uninstall-native refuses a raw command string');
  const rawString = await invoke('uninstall-native', 'cmd.exe /c echo pwned');
  assert(
    rawString && rawString.success === false,
    'a bare command string is refused, not executed'
  );
  const rawObject = await invoke('uninstall-native', { uninstallString: 'cmd.exe /c echo pwned' });
  assert(
    rawObject && rawObject.success === false,
    'an object carrying only an uninstallString is refused'
  );

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail > 0 ? 1 : 0);
});
