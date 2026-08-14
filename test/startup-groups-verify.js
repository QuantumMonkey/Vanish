// Startup grouping regression suite (tda).
//
// Operator, 2026-08-13: "could you categorize startup items as killable and
// necessary? that way necessary things could be hidden behind a collapsible
// section and not seen as a massive list."
//
// This suite exists because the grouping is the FIRST place in Vanish that is
// allowed a trusted-publisher allowlist, which Rule 6 otherwise forbids. The
// amendment is scoped to grouping only (see docs/promptgate.md), so most of
// what is asserted here is the boundary of that permission rather than the
// classification itself.
//
// THE WORDING IS PART OF THE CONTRACT. "Necessary" means "do not touch this
// without knowing what you are doing" - NOT "this is good software", and never
// the words "trusted" or "safe". The operator named the case that makes the
// difference matter: on a corporate machine the monitoring agent belongs in the
// hidden group precisely BECAUSE disabling it is a disciplinary event, not
// because it is benign.
//
// AND THE COUNTEREXAMPLE THAT KEEPS IT HONEST: RealPlayer runs as LocalSystem
// with auto-start and would score "necessary" on that signal alone - while
// being software the operator asked to get rid of. A first implementation did
// exactly that, via a different route (see the managed-machine assertions
// below), and hid all three RealPlayer entries behind "your organisation put
// this here".
//
//   npx electron test/startup-groups-verify.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); fail += 1; }
}

// One of each classification, plus the two cases that must never be hidden.
const FIXTURE = {
  items: [
    {
      name: 'SecurityHealth', command: 'C:\\Windows\\System32\\SecurityHealthSystray.exe',
      exePath: 'C:\\Windows\\System32\\SecurityHealthSystray.exe', exeExists: true,
      source: 'Registry', sourceDetail: 'HKLM (64-bit)', enabled: true,
      managePath: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\SecurityHealth',
      group: 'necessary', classification: 'system', signer: 'Microsoft Windows',
      groupReason: 'Windows itself put this here (signed by Microsoft Windows). Your system depends on it.',
    },
    {
      name: 'CorpAgent', command: 'C:\\Program Files\\Corp\\agent.exe',
      exePath: 'C:\\Program Files\\Corp\\agent.exe', exeExists: true,
      source: 'Registry', sourceDetail: 'HKLM (64-bit)', enabled: true,
      managePath: 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Run\\CorpAgent',
      group: 'necessary', classification: 'managed', signer: 'Corp Monitoring Ltd',
      groupReason: 'This was put here by policy rather than by you.',
    },
    {
      name: 'TkBellExe', command: '"C:\\Program Files (x86)\\Real\\RealPlayer\\Update\\realsched.exe" -osboot',
      exePath: 'C:\\Program Files (x86)\\Real\\RealPlayer\\Update\\realsched.exe', exeExists: true,
      source: 'Registry', sourceDetail: 'HKLM (64-bit)', enabled: true,
      managePath: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\TkBellExe',
      action: 'registry-remove', actionLabel: 'Remove from startup',
      group: 'actionable', classification: 'known-publisher', signer: 'RealNetworks LLC',
      groupReason: 'Signed by RealNetworks LLC. That confirms who wrote it, not that you need it at startup.',
    },
    {
      name: 'MysteryThing', command: 'C:\\Tools\\mystery.exe',
      exePath: 'C:\\Tools\\mystery.exe', exeExists: true,
      source: 'Registry', sourceDetail: 'HKCU', enabled: true,
      managePath: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\MysteryThing',
      action: 'registry-remove', actionLabel: 'Remove from startup',
      group: 'actionable', classification: 'no-opinion', signer: null,
      groupReason: 'Vanish has no opinion about this one.',
    },
    {
      name: 'DeadEntry', command: 'C:\\Gone\\nothing.exe',
      exePath: 'C:\\Gone\\nothing.exe', exeExists: false,
      source: 'Registry', sourceDetail: 'HKCU', enabled: true,
      managePath: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\DeadEntry',
      action: 'registry-remove', actionLabel: 'Remove from startup',
      suggestion: 'Remove it here.',
      group: 'actionable', classification: 'orphaned', signer: null,
      groupReason: 'Points at a file that is not there any more.',
    },
  ],
  total: 5, orphans: 1, necessaryCount: 2, actionableCount: 3,
  detectionOnly: false, detectionNote: 'Every change here is reversible.',
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 3000));

  console.log('');
  console.log('Vanish startup grouping verification (tda)');
  console.log('=========================================');

  const view = await win.webContents.executeJavaScript(`(() => {
    renderStartupTable(${JSON.stringify(FIXTURE)});
    const tb = document.getElementById('audit-startup-tbody');
    const rows = [...tb.querySelectorAll('tr.app-row')];
    const nec = rows.filter((r) => r.classList.contains('is-necessary'));
    const toggle = document.getElementById('startup-necessary-toggle');
    const hiddenBefore = nec.every((r) => r.style.display === 'none');
    if (toggle) toggle.click();
    const shownAfter = nec.every((r) => r.style.display !== 'none');
    const expandedAttr = toggle ? toggle.getAttribute('aria-expanded') : null;
    if (toggle) toggle.click();
    const hiddenAgain = nec.every((r) => r.style.display === 'none');
    const rowFor = (name) => rows.find((r) => r.textContent.includes(name));
    const info = (name) => {
      const r = rowFor(name);
      if (!r) return null;
      return {
        necessary: r.classList.contains('is-necessary'),
        label: r.querySelector('.startup-why') ? r.querySelector('.startup-why').textContent.trim() : null,
        why: r.querySelector('.startup-why') ? (r.querySelector('.startup-why').getAttribute('title') || '') : '',
        hasAction: !!r.querySelector('.startup-action-btn'),
      };
    };
    return {
      rowCount: rows.length,
      necessaryCount: nec.length,
      hiddenBefore, shownAfter, hiddenAgain, expandedAttr,
      toggleText: toggle ? toggle.textContent.replace(/[ \\t\\n\\r]+/g, ' ').trim() : null,
      security: info('SecurityHealth'),
      corp: info('CorpAgent'),
      real: info('TkBellExe'),
      mystery: info('MysteryThing'),
      dead: info('DeadEntry'),
      allText: tb.textContent,
    };
  })()`);

  assert(view.rowCount === 5, `every entry rendered (${view.rowCount})`);

  // --- The split, and what it hides ---------------------------------------
  console.log('');
  console.log('Two groups, and the collapsed one starts collapsed');

  assert(view.necessaryCount === 2, `two entries classed necessary (${view.necessaryCount})`);
  assert(view.hiddenBefore, 'the necessary group is collapsed by default');
  assert(view.shownAfter, 'clicking the toggle reveals it');
  assert(view.hiddenAgain, 'clicking again collapses it');
  assert(view.expandedAttr === 'true', 'the toggle reports its state to assistive tech');
  assert(/2 more/.test(view.toggleText || ''), `the toggle states the count (${view.toggleText})`);

  // --- Nothing unexplained is ever hidden ---------------------------------
  console.log('');
  console.log('Anything unclassified stays VISIBLE and says so');

  assert(view.mystery && view.mystery.necessary === false,
    'an entry Vanish cannot classify is in the visible group');
  assert(view.mystery && /no opinion/i.test(view.mystery.label || ''),
    'and it says outright that Vanish has no opinion, rather than leaving it blank');
  assert(view.dead && view.dead.necessary === false,
    'a broken entry is visible and actionable');

  // --- The counterexample -------------------------------------------------
  console.log('');
  console.log('Signed-by-a-real-company does NOT mean necessary');

  assert(view.real && view.real.necessary === false,
    'RealPlayer is in the group the user can act on, not hidden');
  assert(view.real && view.real.hasAction,
    'and it keeps its action button');
  assert(view.real && /confirms who wrote it, not that you need it/i.test(view.real.why),
    'the reason says a signature confirms authorship, not necessity');

  // --- The wording is the contract ----------------------------------------
  console.log('');
  console.log('It never says trusted, and never says safe');

  assert(!/\btrusted\b/i.test(view.allText), 'the word "trusted" appears nowhere');
  assert(!/\bsafe\b/i.test(view.allText), 'the word "safe" appears nowhere');
  assert(view.corp && /policy/i.test(view.corp.why),
    'the managed case explains itself as policy rather than as approval');
  assert(view.corp && !/benign|harmless|trusted|safe/i.test(view.corp.why),
    'and never implies the monitoring software is benign');
  assert(view.security && /depends on/i.test(view.security.why),
    'the system case talks about dependency, not goodness');

  // --- The engine boundary ------------------------------------------------
  console.log('');
  console.log('The allowlist is scoped to grouping only');

  const scanner = fs.readFileSync(path.join(__dirname, '..', 'scanner.ps1'), 'latin1');
  assert(/StartupSystemPublishers/.test(scanner) && /StartupSecurityPublishers/.test(scanner),
    'the publisher lists exist');
  // They must be read by the classifier and by nothing else. If a removal path
  // ever consults them, Rule 6's amendment has quietly widened.
  const uses = (scanner.match(/StartupSystemPublishers|StartupSecurityPublishers/g) || []).length;
  assert(uses === 4, `the lists are referenced only where they are defined and used (${uses} references)`);
  assert(/# RULE 6 AMENDMENT/.test(scanner),
    'the amendment and its scope are recorded where the list lives');
  // The managed classification must rest on evidence about THIS entry.
  assert(/elseif \(\$underPolicies\) \{/.test(scanner),
    'managed is decided by the Policies key, not by "the machine looks managed"');
  assert(!/\$managedMachine -and .*sourceDetail/.test(scanner),
    'the machine-wide-on-a-managed-machine proxy is gone - it hid RealPlayer once');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
