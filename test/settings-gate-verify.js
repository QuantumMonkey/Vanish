// wy7a: the two boundaries that were being enforced on the wrong side of the
// process line.
//
//   npx electron test/settings-gate-verify.js
//
// Runs in either tier and asserts the right thing in each - the Audit Mode half
// is the half that matters, and the runner reports which one it got.
//
// WHAT WAS WRONG, BOTH OF THEM THE SAME SHAPE.
//
// 1. DESTRUCTIVE BY DEFERRAL. vault-delete is fullModeOnly. autoPurgeSweep is
//    not gated by anything, because it does not need to be: it runs at every
//    elevated start, reads two settings off disk, and permanently deletes every
//    quarantine entry older than the cutoff. With retention 0 the cutoff is
//    now. So an AUDIT MODE renderer - the tier where every destructive channel
//    is supposed to be refused - could call
//    setSettings({ autoPurgeEnabled: true, autoPurgeRetentionDays: 0 }) and the
//    operator's whole vault would be gone at their next Full Mode start, with
//    no prompt anywhere on the path. The gate was not defeated; it was
//    sidestepped by scheduling the act from the tier that cannot perform it.
//
//    There is an honest-user half too, needing no attacker at all: both
//    retention inputs were min="0", so a person could do this to themselves
//    with nothing on screen saying that 0 means "delete everything at next
//    launch".
//
// 2. THE PING. Its destination went straight to Test-Connection with no
//    allowlist, and pingConsentGiven was checked ONLY in renderer/audit.js. A
//    compromised renderer could make the app send packets to a host of its
//    choosing, without consent, from a product whose README's first promise
//    under "What Vanish does NOT do" is "No telemetry, no network calls."
//
// INV-2 names the rule both of these broke: "the renderer's disabled states are
// a convenience; THIS is the boundary."
//
// THIS SUITE SENDS ONE ICMP PACKET, to this PC's own default gateway, and only
// if one exists. That is deliberate and it is stated here rather than buried:
// every other assertion below is a REFUSAL, and a suite made entirely of
// refusals passes just as well when the gate refuses everything and the feature
// is dead. The allow path needs one real call to be worth anything. It is the
// same packet the app sends when the operator taps the tile.

const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

require('../main.js');
const store = require('../lib/store');

let pass = 0;
let fail = 0;
let lastLabel = '(nothing yet)';

function assert(condition, label, detail = '') {
  lastLabel = label;
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.log(`  FAIL  timed out. Last completed assertion: ${lastLabel}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

async function invoke(channel, payload) {
  const h = ipcMain._invokeHandlers.get(channel);
  if (!h) throw new Error(`no handler registered for ${channel}`);
  return h({ sender: null }, payload);
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Settings gate and ping allowlist (wy7a)');
  console.log('======================================');

  const tier = await invoke('get-tier');
  const elevated = tier && tier.isAdmin === true;
  console.log(`  (tier: ${elevated ? 'Full Mode' : 'Audit Mode'})`);

  // Never the operator's own settings file.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-wy7a-'));
  store.init(dataDir);

  // ------------------------------------------------------------------
  console.log('');
  console.log('The retention floor, at the boundary rather than in the markup');

  // index.html carries min="1" on both inputs now, but that is a convenience.
  // This is the line that decides, and it CLAMPS rather than rejecting, so a 0
  // arriving from a hand-edited settings.json or an older file becomes 1 too.
  const zero = store.writeSettings({ autoPurgeRetentionDays: 0 });
  assert(zero.autoPurgeRetentionDays === 1,
    `retention 0 becomes 1 at the store, not at the input (${zero.autoPurgeRetentionDays})`);
  const negative = store.writeSettings({ autoPurgeRetentionDays: -400 });
  assert(negative.autoPurgeRetentionDays === 1,
    `and so does a negative, which would have made the cutoff the FUTURE (${negative.autoPurgeRetentionDays})`);
  const normal = store.writeSettings({ autoPurgeRetentionDays: 30 });
  assert(normal.autoPurgeRetentionDays === 30, 'an ordinary value is untouched');
  const huge = store.writeSettings({ autoPurgeRetentionDays: 99999 });
  assert(huge.autoPurgeRetentionDays === 3650, 'and the upper clamp still holds');

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const retentionInputs = html.match(/<input[^>]*id="(?:inp|set)-retention-days"[^>]*>/g) || [];
  assert(retentionInputs.length === 2, `both retention inputs found (${retentionInputs.length})`);
  assert(retentionInputs.every((i) => /min="1"/.test(i)),
    'and neither offers 0 in the first place - the control should not accept what the boundary refuses',
    retentionInputs.join(' | '));

  // ------------------------------------------------------------------
  console.log('');
  console.log('set-settings, and the deferral it used to allow');

  const attack = { autoPurgeEnabled: true, autoPurgeRetentionDays: 0, scanDepth: 'moderate' };
  const res = await invoke('set-settings', attack);
  assert(res && res.settings, 'the handler answers');

  if (elevated) {
    assert(Array.isArray(res.refusedKeys) && res.refusedKeys.length === 0,
      'in Full Mode nothing is refused - this tier is allowed to schedule a purge',
      JSON.stringify(res.refusedKeys));
    assert(res.settings.autoPurgeEnabled === true, 'so the setting takes');
    // Even here the floor holds, and that is the point of putting it in the
    // store rather than in the gate: elevation is permission to schedule a
    // purge, not permission to schedule one with no retention at all.
    assert(res.settings.autoPurgeRetentionDays === 1,
      `and retention still cannot be 0 (${res.settings.autoPurgeRetentionDays})`);
  } else {
    assert(Array.isArray(res.refusedKeys) && res.refusedKeys.length === 2,
      `in Audit Mode both purge fields are refused (${JSON.stringify(res.refusedKeys)})`);
    assert(res.settings.autoPurgeEnabled !== true,
      'THE SWEEP IS NOT ARMED - this is the assertion the whole issue is about');
    assert(/Full Mode/i.test(String(res.reason || '')),
      'and the refusal says why, rather than the control silently snapping back', String(res.reason));
  }

  // The half that must keep working whichever tier this is. Refusing the whole
  // save because one field was out of reach would lose changes the user is
  // entitled to make, and would teach them Audit Mode cannot save settings.
  assert(res.settings.scanDepth === 'moderate',
    `the rest of the patch still saves (${res.settings.scanDepth})`);
  assert(res.saved === true, 'and the save is reported as having happened');

  // ------------------------------------------------------------------
  console.log('');
  console.log('The ping: consent is checked HERE now, not only in the page');

  store.writeSettings({ pingConsentGiven: false });
  const noConsent = await invoke('network-ping', { destination: '1.1.1.1' });
  assert(noConsent && noConsent.success === false, 'with consent withheld, the ping is refused');
  assert(/permission/i.test(String(noConsent.error)) && /Nothing was sent/i.test(String(noConsent.error)),
    'and says both that permission is missing and that nothing left the machine', String(noConsent.error));

  store.writeSettings({ pingConsentGiven: true });

  const hostile = [
    'evil.example.com',
    '203.0.113.9',
    'localhost',
    '127.0.0.1',
    '::1',
    '8.8.8.8 -Count 100',
    ''
  ];
  let refusedAll = true;
  let firstAllowed = null;
  for (const d of hostile) {
    const r = await invoke('network-ping', { destination: d });
    if (!(r && r.success === false && /will only ping/i.test(String(r.error)))) {
      refusedAll = false;
      firstAllowed = `${JSON.stringify(d)} -> ${JSON.stringify(r)}`;
      break;
    }
  }
  assert(refusedAll,
    `every destination outside the allowed set is refused, consent or not (${hostile.length} tried)`,
    firstAllowed || '');

  // A gateway this process has not SEEN is refused too - the allowlist is built
  // from what main.js read out of its own engine call, never from what the
  // caller claims the gateway is.
  const unseen = await invoke('network-ping', { destination: '192.0.2.1' });
  assert(unseen && unseen.success === false,
    'an address the caller merely asserts is a gateway is refused', JSON.stringify(unseen));

  // ------------------------------------------------------------------
  console.log('');
  console.log('And the allow path, so none of the above passes on a dead feature');

  const activity = await invoke('get-network-activity', {});
  const gw = ((activity && activity.adapters) || [])
    .map((a) => a && a.gatewayAddress)
    .find((g) => typeof g === 'string' && g.trim());

  if (!gw) {
    console.log('  SKIP  the allow path: this PC reports no default gateway right now, so there is nothing on the allowlist to reach');
  } else {
    // ONE packet, to the operator's own router. See the header.
    const ok = await invoke('network-ping', { destination: gw });
    assert(!/will only ping/i.test(String((ok && ok.error) || '')),
      `the real gateway (${gw}) gets PAST the gate - the allowlist is not simply refusing everything`,
      JSON.stringify(ok));
    assert(ok && (ok.success === true || typeof ok.error === 'string'),
      'and reaches the engine, which answers with a time or a named failure',
      JSON.stringify(ok));
  }

  // The renderer must not offer what the boundary refuses.
  const auditSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'audit.js'), 'utf8');
  assert(!/net-ping-dest-input"[^>]*type="text"/.test(auditSrc) && /<select class="net-ping-dest-input"/.test(auditSrc),
    'the destination control is a choice, not a free-text box');

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  console.log('');
  console.log(`  FAIL  threw after "${lastLabel}": ${(err && err.message) || err}`);
  console.log(String((err && err.stack) || ''));
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(1);
});
