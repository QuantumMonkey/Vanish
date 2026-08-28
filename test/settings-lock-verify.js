// A setting that did not save must never look like one that did (mp4).
//
//   npx electron test/settings-lock-verify.js
//
// WHAT WENT WRONG, reproduced on the operator's machine 2026-08-28 unelevated:
//
//   BLOCKED   settings.json  (EPERM)
//   BLOCKED   queue.json     (EPERM)
//   BLOCKED   oplog.jsonl    (EPERM)
//
// SEC-3 locks Vanish's state directory to administrators once the app has run
// elevated, and that is CORRECT: settings.json is elevated-engine input - scan
// depth and auto-purge are read by the half of Vanish that deletes files, so a
// standard user rewriting it is the escalation SEC-3 exists to close.
//
// What was not correct is what the app did about it. store.writeSettings threw
// EPERM, the IPC handler had no try/catch so the call REJECTED, and the
// renderer had no catch either - so the line after the await, the one that
// says "Setting saved", simply never ran. The checkbox stayed where the click
// put it. The user flipped a toggle, saw nothing, and got the old value back on
// the next launch.
//
// That is this application's own defect class - an action that appears to work
// and did nothing - sitting in the settings panel.
//
// TWO INDEPENDENT HALVES ARE ASSERTED HERE, and either alone is a worse fix
// than both:
//   * the controls are LOCKED UP FRONT when the directory cannot be written,
//     so the failing click is never offered; and
//   * a failed write is still reported honestly if one happens anyway, with
//     the control snapped back to what is really on disk.
//
// The unlocked case is asserted too. A fix that disabled the settings panel for
// everyone would pass every "did not lie" assertion here while breaking the
// feature, and on a machine where Vanish has never run elevated the directory
// is not locked and an unelevated session saves perfectly well.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
const run = (js) => win.webContents.executeJavaScript(js);
// Every payload wrapped in an IIFE: a bare statement list with a top-level
// const is evaluated in the page's GLOBAL lexical environment, which the
// renderer's classic scripts already populate, and one collision makes the
// whole script fail at instantiation with nothing logged.
const evalInPage = (body) => run(`(() => { ${body} })()`);

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);

  await evalInPage(`document.querySelector('.nav-item[data-tab="settings"]').click(); return true;`);
  await wait(400);

  // ---- the normal machine: nothing is locked -----------------------------
  console.log('');
  console.log('Settings save normally when the directory is writable');

  assert(
    (await run(`document.getElementById('settings-locked-notice').style.display === 'none'`)) === true,
    'no lock notice when the state directory is writable - the common case is not warned about'
  );
  assert(
    (await run(`document.getElementById('set-scan-mode').disabled === false`)) === true,
    'and the controls are live'
  );

  await evalInPage(`
    window.__test.resetCallCounts();
    return true;
  `);
  const okResult = await run(
    `applySettingsPatch({ defaultScanMode: 'Safe' }).then(r => ({ saved: r.saved, reason: r.reason, mode: appSettings.defaultScanMode }))`
  );
  assert(okResult.saved === true, 'a successful write reports saved:true');
  assert(okResult.mode === 'Safe', 'and appSettings holds the new value');
  assert(okResult.reason === null, 'with no reason attached - there is nothing to explain');

  // ---- the locked machine ------------------------------------------------
  console.log('');
  console.log('A locked state directory is declared BEFORE the controls are touched');

  const LOCK_REASON = "Vanish's settings folder is locked to administrators on this machine.";
  await evalInPage(`
    window.__test.queueResponse('getTier', {
      tier: 'audit', isFullMode: false, offerElevation: false,
      settingsWritable: false,
      settingsLockReason: ${JSON.stringify(LOCK_REASON)},
      bannerText: 'Running in Audit Mode - elevate to enable cleaning and uninstallation.'
    });
    return true;
  `);
  await run(`checkElevation()`);
  await wait(200);
  await run(`syncSettingsPanel()`);
  await wait(200);

  const notice = await run(`(() => ({
    shown: document.getElementById('settings-locked-notice').style.display !== 'none',
    text: document.getElementById('settings-locked-text').textContent.replace(/\\s+/g, ' ').trim()
  }))()`);

  assert(notice.shown === true, 'the lock notice appears');
  assert(
    notice.text.includes(LOCK_REASON),
    'and it repeats the reason the main process actually gave, rather than a guess',
    notice.text.slice(0, 140)
  );
  assert(
    /Restart as administrator/.test(notice.text),
    'and says what would let them change it'
  );
  assert(
    /elevated half of Vanish/.test(notice.text) || /scan depth and auto-purge/.test(notice.text),
    'and why it is locked at all - a lock with no reason reads as a bug rather than a boundary'
  );
  // The same lock stops the oplog being appended to. appendOplog catches its
  // own EPERM and logs to stderr, so on a locked machine the audit trail
  // silently records nothing - and an audit trail that has stopped without
  // saying so is worse than not having one, because its whole purpose is being
  // checkable afterwards.
  assert(
    /activity log is not being written/.test(notice.text),
    'and it says the activity log has stopped too - the same lock stops that, and it stops SILENTLY'
  );

  // Every control, not a hand-maintained list. A control added later must not
  // quietly become the one that still moves and still lies.
  const controls = await run(`(() => {
    const all = [...document.querySelectorAll('#settings-panel input, #settings-panel select')];
    return { total: all.length, enabled: all.filter(el => !el.disabled).length };
  })()`);
  assert(controls.total > 0, `the settings panel has controls to lock (${controls.total})`);
  assert(
    controls.enabled === 0,
    `and EVERY one of them is disabled, not a chosen few (${controls.enabled} still enabled of ${controls.total})`
  );

  // ---- and if a write fails anyway, it is reported -----------------------
  console.log('');
  console.log('A write that fails anyway is reported, and the control snaps back');

  await evalInPage(`
    window.__test.queueResponse('setSettings', {
      settings: { autoPurgeEnabled: false, autoPurgeRetentionDays: 30, processRefreshSeconds: 2,
                  defaultScanMode: 'Moderate', startupMode: 'audit', hasSeenTour: true },
      saved: false,
      reason: ${JSON.stringify(LOCK_REASON + ' Restart as administrator to change it.')}
    });
    return true;
  `);

  const failResult = await run(
    `applySettingsPatch({ defaultScanMode: 'Advanced' }).then(r => ({ saved: r.saved, reason: r.reason, mode: appSettings.defaultScanMode }))`
  );

  assert(failResult.saved === false, 'a refused write reports saved:false rather than rejecting');
  assert(
    failResult.mode === 'Moderate',
    `and appSettings holds WHAT IS ON DISK, not what was asked for (got '${failResult.mode}', asked for 'Advanced')`
  );
  assert(
    typeof failResult.reason === 'string' && failResult.reason.length > 0,
    'with the reason carried through for the user'
  );

  // The toast is the user-visible half. A failed save must not produce the
  // success one, and must not be dismissed as fast.
  await evalInPage(`
    document.getElementById('toast-stack').innerHTML = '';
    return true;
  `);
  await run(
    `(() => { reportSettingSaved({ saved: false, reason: 'nope, locked' }); return true; })()`
  );
  await wait(150);
  const toastFail = await run(`(() => {
    const t = document.querySelector('#toast-stack .toast');
    return { text: t ? t.textContent : '', cls: t ? t.className : '' };
  })()`);
  assert(/nope, locked/.test(toastFail.text), 'the failure reason reaches the screen');
  assert(!/Setting saved/.test(toastFail.text), 'and the success wording does not');
  assert(/error/.test(toastFail.cls), `and it is styled as an error (${toastFail.cls})`);

  await evalInPage(`document.getElementById('toast-stack').innerHTML = ''; return true;`);
  await run(`(() => { reportSettingSaved({ saved: true, reason: null }); return true; })()`);
  await wait(150);
  const toastOk = await run(`(() => {
    const t = document.querySelector('#toast-stack .toast');
    return { text: t ? t.textContent : '', cls: t ? t.className : '' };
  })()`);
  assert(/Setting saved/.test(toastOk.text), 'a real save still says so');
  assert(/success/.test(toastOk.cls), 'and is styled as a success - the two are not the same toast in two colours');

  // ---- the channel itself failing ---------------------------------------
  console.log('');
  console.log('The channel failing is not a save either');

  await evalInPage(`
    window.__test.queueResponse('setSettings', { __reject: 'the bridge is gone' });
    return true;
  `);
  const rejected = await run(
    `applySettingsPatch({ defaultScanMode: 'Safe' }).then(r => ({ saved: r.saved, reason: r.reason }))`
  );
  assert(rejected.saved === false, 'a rejected channel reports saved:false rather than throwing out of the caller');
  assert(
    /could not reach/.test(rejected.reason || ''),
    'and says the store could not be reached, which is a different problem from a locked one',
    rejected.reason || ''
  );

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail > 0 ? 1 : 0);
});
