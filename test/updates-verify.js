// ag0: the Windows update list is legible, honest about dates, and never
// claims Vanish can remove an update.
//
//   npx electron test/updates-verify.js
//
// Runs in either tier. Elevated it also exercises the DISM half; unelevated it
// asserts the thing that matters more - that the missing half is REPORTED
// rather than silently producing a shorter list.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

require('../main.js');

let pass = 0;
let fail = 0;
let lastLabel = '(nothing yet)';

function assert(condition, label, detail = '') {
  lastLabel = label;
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.log(`  FAIL  timed out. Last completed assertion: ${lastLabel}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

async function invoke(channel, payload) {
  const handler = ipcMain._invokeHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ sender: null }, payload);
}

app.whenReady().then(async () => {
  console.log('');
  console.log('Windows update list (ag0)');
  console.log('=========================');

  const tier = await invoke('get-tier');
  await new Promise((r) => setTimeout(r, 2500));

  const res = await invoke('get-windows-updates');
  assert(res && res.success === true, `the list reads without error (${(res && res.error) || ''})`);

  const updates = (res && res.updates) || [];
  console.log(`  (${updates.length} update(s); elevated=${res.elevated}, DISM=${res.dismAvailable})`);

  assert(updates.length > 0, 'a real machine reports at least one installed update');

  // ---- read-only, and provably so ---------------------------------------
  // The single most important property: this feature must not be able to
  // remove anything. Asserted against the source rather than by trying, because
  // "we tried to remove an update and it did not work" is not a test anyone
  // should run on a real machine.
  const scanner = fs.readFileSync(path.join(__dirname, '..', 'scanner.ps1'), 'utf8');
  const fnStart = scanner.indexOf('function Get-WindowsUpdateList');
  const fnEnd = scanner.indexOf('\nfunction ', fnStart + 10);
  const body = scanner.slice(fnStart, fnEnd);
  assert(fnStart > -1, 'the engine function is where this suite thinks it is');
  // INVOKING a remover, not MENTIONING one. The function deliberately contains
  // the string "wusa.exe /uninstall /kb:<number>" as the handoff it reports to
  // the UI, so a bare /wusa/ match fails on the very design it is checking for.
  // What must not appear is a call: the call operator, Start-Process, or any of
  // the DISM/PowerShell removal cmdlets.
  assert(
    !/(&\s*['"]?wusa|Start-Process[^\n]*wusa|Remove-WindowsPackage|\/Remove-Package|Uninstall-WindowsFeature|Remove-WindowsCapability)/i.test(body),
    'the engine function never INVOKES a remover - the rollback half stays cut'
  );
  assert(
    /handoffCommand/.test(body) && /wusa\.exe \/uninstall/.test(body),
    'the only mention of wusa is the command it reports for the user to run themselves'
  );
  assert(
    /Get-HotFix/.test(body) && /Get-Packages/.test(body),
    'it joins both read-only sources (Get-HotFix and DISM /Get-Packages)'
  );

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert(
    /ipcMain\.handle\('get-windows-updates'/.test(mainSrc),
    'the channel is a plain read-only handle, not fullModeOnly - "what did Windows install" is an audit question'
  );

  // ---- every row is legible ---------------------------------------------
  assert(
    updates.every((u) => String(u.kind || '').trim().length > 0),
    'every update says what KIND of thing it is, which the Windows dialog never does'
  );
  assert(
    updates.every((u) => String(u.removalNote || '').trim().length > 0),
    'every update carries a cost line - what removing it would actually mean'
  );

  const security = updates.filter((u) => u.kind === 'Security update');
  assert(
    security.length === 0 || security.every((u) => /hole|security/i.test(String(u.removalNote))),
    `a security update's cost line names the risk (${security.length} found)`
  );

  // ---- the dates are the part that must never lie -----------------------
  const dated = updates.filter((u) => u.installedOn);
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  const future = dated.filter((u) => new Date(u.installedOn).getTime() > tomorrow);
  assert(
    future.length === 0,
    `no update claims an install date in the future (${future.length} did)`,
    future.slice(0, 3).map((u) => `${u.kb || u.id}: ${u.installedOn}`).join(' | ')
  );

  // c0y: an unknown date is null WITH a reason, never a plausible guess.
  const undated = updates.filter((u) => !u.installedOn);
  assert(
    undated.every((u) => String(u.installedOnNote || '').trim().length > 0),
    `every update without a date says why it has none (${undated.length} undated)`
  );
  assert(
    typeof res.undatedCount === 'number' && res.undatedCount === undated.length,
    `the payload counts them so the UI can explain a mostly-blank column (${res.undatedCount} vs ${undated.length})`
  );

  // Newest first is the whole point: "what changed just before this broke".
  const times = dated.map((u) => new Date(u.installedOn).getTime());
  assert(
    times.every((t, i) => i === 0 || times[i - 1] >= t),
    'dated updates are sorted newest first'
  );

  // ---- the missing half is reported, not hidden -------------------------
  if (res.elevated) {
    assert(res.dismAvailable === true, 'elevated, the component-store half actually ran');
    assert(
      updates.some((u) => u.source === 'component-store'),
      'and contributed rows Get-HotFix alone would never have shown'
    );
  } else {
    assert(res.dismAvailable === false, 'unelevated, the component-store half is correctly unavailable');
    assert(
      /Full Mode/i.test(String(res.dismNote || '')),
      `and the payload SAYS so rather than just returning a shorter list (got '${String(res.dismNote || '').slice(0, 60)}')`
    );
  }

  // ---- the panel ---------------------------------------------------------
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const js = (src) => win.webContents.executeJavaScript(src);

  const painted = await js(`(() => {
    renderWindowsUpdates(${JSON.stringify(res)});
    const body = document.getElementById('audit-updates-body');
    const rows = body.querySelectorAll('.update-row');
    return {
      rows: rows.length,
      badge: document.getElementById('audit-updates-badge').textContent,
      caption: (body.querySelector('.update-caption') || {}).textContent || '',
      handoffButtons: body.querySelectorAll('[data-update-kb]').length,
      noDateCells: body.querySelectorAll('.update-nodate').length,
      hasMore: !!document.getElementById('btn-updates-more'),
      widest: Math.max(0, ...Array.from(rows).map((r) => r.scrollWidth - r.clientWidth))
    };
  })()`);

  assert(painted.rows > 0, `the panel renders rows (${painted.rows})`);
  assert(
    String(painted.badge) === String(updates.length),
    `the badge states the real total (badge '${painted.badge}', engine ${updates.length})`
  );
  assert(
    painted.caption.includes(String(updates.length)),
    `the caption names the full total, so a paged list cannot read as a complete one (got '${painted.caption}')`
  );
  assert(
    updates.length <= 25 || painted.hasMore,
    'a truncated list offers a way to see the rest'
  );
  assert(
    res.undatedCount === 0 || painted.caption.toLowerCase().includes('install date'),
    'and the caption explains a blank date column rather than leaving it looking broken'
  );

  // The layout trap this repo keeps hitting: a long package identity that
  // refuses to wrap and pushes the date and button off the panel.
  assert(painted.widest === 0, `no row overflows its own box (worst overflow ${painted.widest}px)`);

  // Every row that can hand off, does; and the handoff explains itself.
  const withKb = updates.filter((u) => u.kb).length;
  const shownWithKb = updates.slice(0, 25).filter((u) => u.kb).length;
  assert(
    painted.handoffButtons === shownWithKb,
    `every shown update with a KB number offers the handoff (${painted.handoffButtons} of ${shownWithKb}; ${withKb} in total)`
  );

  const updatesSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'updates.js'), 'utf8');
  assert(
    /wusa\.exe \/uninstall/.test(updatesSrc),
    'the handoff states Windows own command rather than running something'
  );
  assert(
    /does not remove/i.test(updatesSrc),
    'and says plainly that Vanish does not remove updates'
  );
  assert(
    ![...Buffer.from(updatesSrc, 'utf8')].some((b) => b > 127),
    'the renderer file is ASCII on disk, per the house rule'
  );

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  clearTimeout(watchdog);
  app.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.log('');
  console.log(`  FAIL  threw after "${lastLabel}": ${(err && err.message) || err}`);
  console.log(String((err && err.stack) || ''));
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  clearTimeout(watchdog);
  app.exit(1);
});
