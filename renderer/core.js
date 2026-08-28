// Vanish renderer -- Shared state, tier guards, the program list and tab routing
//
// Everything every other module leans on: module state, esc/toast, the
// tier guards (guardFullMode / guardProtected), the All Programs table with
// its filters and multi-select, and tab switching. Loaded first for reading
// order only - classic scripts share one global lexical environment, so the
// order in index.html does not affect resolution.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

﻿// Vanish Frontend UI Controller (renderer.js)
// Interacts with Electron preload bridge APIs

let allApps = [];
let selectedApp = null;
// 5rz: bulk multi-select for "Add N to queue", separate from selectedApp
// (which is the single-row details-sidebar selection and stays that way -
// checking a row's box does not open its sidebar, and opening a row's
// sidebar does not check its box, same distinction file managers make
// between "focused" and "selected"). Keyed by app.id so it survives a
// re-sort or a re-render of the same underlying data.
let bulkSelectedAppIds = new Set();
let lastCheckedRowIndex = null; // for shift-click range selection
// The exact array renderTable() last rendered - i.e. the list AS FILTERED AND
// SORTED, which is what select-all and clear-selection have to act on. The
// header checkbox lives outside the table and has no other honest way to know
// which rows are on screen; reading the DOM back would give it the checkboxes
// but not the app ids behind them.
let lastRenderedApps = [];
// Health Advisor is the landing page. Kept in sync with the 'active' class in
// index.html and with the panel that ships visible on the first frame; all
// three have to agree or the first switchTab leaves two panels showing.
let activeTab = 'audit';
let filterText = '';
let filterType = 'all';
// 7oo.3: the default list is the things a person recognises as applications.
// Components are classified and counted, never dropped - this flag is how they
// come into view.
let showComponents = false;
// ht8: isolate the shared runtimes. Not a hiding filter - it is the only way to
// see 22 near-identical redistributable rows as one group rather than as noise.
let runtimesOnly = false;
// 7oo.7: Windows optional features are neither desktop apps nor Store apps, so
// they were invisible to this app entirely. Loaded lazily - there is no reason
// to pay for the query on every start when the default view excludes them.
let showFeatures = false;
let windowsFeatures = [];
let featuresLoaded = false;
let sortOption = 'name-asc';
let isAdmin = false;

// SCR-01: one flag drives the banner and every destructive control's state.
// The real boundary is main.js/scanner.ps1 (NFR-02) - this is presentation.
let tierState = { tier: 'audit', isFullMode: false, offerElevation: false, bannerText: '' };
let appSettings = { autoPurgeEnabled: false, autoPurgeRetentionDays: 30, processRefreshSeconds: 2, startupMode: 'audit' };

const TIER_TOOLTIP = 'Needs administrator rights - restart Vanish as administrator';

// Killing these has no legitimate outcome from Task Manager - Windows treats
// their exit as fatal and either BSODs or force-restarts the session. Refuse
// outright rather than warn: there is nothing on the other side of "yes" for
// these that a user could actually want. Matched against Get-Process's bare
// ProcessName (no .exe), case-insensitive.
const PROCESS_KILL_DENYLIST_FATAL = new Set([
  'system', 'system idle process', 'registry', 'csrss', 'wininit', 'winlogon',
  'services', 'lsass', 'smss'
]);

// Killing these is usually a bad idea and occasionally what someone actually
// means to do (svchost hosts many services and the wrong PID can take out
// networking/audio/etc; explorer.exe restart is a known troubleshooting
// step; dwm.exe crashes the desktop session). Typed double-confirm instead
// of a hard block.
const PROCESS_KILL_DENYLIST_RISKY = new Set(['svchost', 'explorer', 'dwm']);

// Everything the app renders can contain a path, a registry key or a command
// line that came from disk. None of it is trusted markup.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, kind = 'info', timeout = 4200) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const icons = { info: 'fa-circle-info', success: 'fa-circle-check', warn: 'fa-triangle-exclamation', error: 'fa-circle-xmark' };
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<i class="fa-solid ${icons[kind] || icons.info}"></i><span>${esc(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

// ==========================================
// SCAN PROGRESS (6g2, 7oo.5)
// ==========================================
// A scan that shows a spinner and one line of static text for three minutes is
// indistinguishable from a hang. Two layers, because they fail differently:
//
//   1. An elapsed-time ticker. Always available, needs nothing from the engine,
//      and answers "is this thing alive" for every scan in the app.
//   2. Live stage reporting from scanner.ps1 where it emits it, which answers
//      "how far along, and has it found anything yet".
//
// Rule 9: both report measured facts - seconds actually elapsed, stages
// actually completed. Neither predicts a percentage or a finish time.

const scanTickers = new Map();

function describeElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// `element` is the line that gets rewritten; `baseText` is what it says before
// anything more specific is known.
function startScanTicker(key, element, baseText) {
  stopScanTicker(key);
  if (!element) return;

  const state = { started: Date.now(), element, baseText, progress: null, timer: null };

  const paint = () => {
    const seconds = Math.round((Date.now() - state.started) / 1000);
    const parts = [];
    if (state.progress && state.progress.stage) {
      parts.push(`${state.progress.stage}`);
      if (state.progress.total > 0) {
        parts.push(`step ${state.progress.done} of ${state.progress.total}`);
      }
      if (state.progress.found > 0) {
        parts.push(`${state.progress.found} found so far`);
      }
    } else {
      parts.push(state.baseText);
    }
    parts.push(describeElapsed(seconds));
    element.textContent = parts.join(' - ');
  };

  state.paint = paint;
  paint();
  state.timer = setInterval(paint, 1000);
  scanTickers.set(key, state);
}

function updateScanTicker(key, progress) {
  const state = scanTickers.get(key);
  if (!state) return;
  state.progress = progress;
  // Repaint immediately rather than waiting up to a second for the next tick -
  // and so that new stage information still lands even where the interval is
  // throttled (a minimised or background window).
  if (state.paint) state.paint();
}

function stopScanTicker(key) {
  const state = scanTickers.get(key);
  if (!state) return;
  clearInterval(state.timer);
  scanTickers.delete(key);
}

// Route engine progress to whichever ticker is waiting on that scan.
function setupScanProgress() {
  if (!window.api.onScanProgress) return;
  window.api.onScanProgress((payload) => {
    if (!payload) return;
    if (payload.scan === 'cleaner' && payload.cleaner) {
      updateScanTicker(`cleaner:${payload.cleaner}`, payload);
    } else if (payload.scan) {
      updateScanTicker(payload.scan, payload);
    }
  });
}

// Promise-based confirm. `typed` makes it a double-confirm for irreversible acts.
function confirmDialog({ title, body, confirmLabel = 'Confirm', typed = null }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    const typedRow = document.getElementById('confirm-typed-row');
    const typedInput = document.getElementById('confirm-typed-input');
    const typedLabel = document.getElementById('confirm-typed-label');

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = body;
    okBtn.textContent = confirmLabel;

    const invoker = document.activeElement;

    if (typed) {
      typedRow.style.display = 'block';
      typedLabel.textContent = `Type ${typed} to confirm`;
      typedInput.value = '';
      okBtn.disabled = true;
      okBtn.classList.add('tier-locked');
    } else {
      typedRow.style.display = 'none';
      okBtn.disabled = false;
      okBtn.classList.remove('tier-locked');
    }

    function onTyped() {
      const ok = typedInput.value.trim().toUpperCase() === typed.toUpperCase();
      okBtn.disabled = !ok;
      okBtn.classList.toggle('tier-locked', !ok);
    }
    function cleanup(result) {
      overlay.classList.remove('active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      typedInput.removeEventListener('input', onTyped);
      document.removeEventListener('keydown', onKey);
      if (invoker && typeof invoker.focus === 'function') invoker.focus();
      resolve(result);
    }
    function onOk() { if (!okBtn.disabled) cleanup(true); }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter' && !okBtn.disabled) cleanup(true);
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    if (typed) typedInput.addEventListener('input', onTyped);
    document.addEventListener('keydown', onKey);

    overlay.classList.add('active');
    (typed ? typedInput : okBtn).focus();
  });
}

// Wizard State Machine
let wizState = {
  currentScreenIndex: 0,
  screens: [
    'scr-config',
    'scr-restore-loading',
    'scr-native-run',
    'scr-scan-loading',
    'scr-leftovers-tree',
    'scr-purge-loading',
    'scr-complete'
  ],
  steps: [
    'step1-progress', // Config
    'step2-progress', // Safety (Restore Point)
    'step3-progress', // Native Uninstaller
    'step4-progress', // Scan Remnants
    'step5-progress'  // Purge Remnants
  ],
  createRestorePoint: true,
  runSilently: true,
  scanMode: 'Moderate',
  leftovers: { files: [], registry: [] },
  selectedFiles: [],
  selectedRegistry: [],
  spaceReclaimedBytes: 0
};

// DOM Elements
const elements = {
  // Navigation & Badges
  navItems: document.querySelectorAll('.nav-item'),
  adminIndicator: document.getElementById('admin-indicator'),
  
  // Header Filters
  searchBar: document.getElementById('search-bar'),
  typeToggle: document.getElementById('type-toggle'),
  sortSelector: document.getElementById('sort-selector'),
  
  // Dashboard Stats
  statTotalApps: document.getElementById('stat-total-apps'),
  statUwpApps: document.getElementById('stat-uwp-apps'),
  statTotalSize: document.getElementById('stat-total-size'),
  statRestoreStatus: document.getElementById('stat-restore-status'),
  
  // Workspace & Table
  appsTbody: document.getElementById('apps-tbody'),
  detailsSidebar: document.getElementById('details-sidebar'),
  
  // Details sidebar fields
  detIcon: document.getElementById('det-icon'),
  detTitle: document.getElementById('det-title'),
  detPublisher: document.getElementById('det-publisher'),
  detVersion: document.getElementById('det-version'),
  detDate: document.getElementById('det-date'),
  detSize: document.getElementById('det-size'),
  detPath: document.getElementById('det-path'),
  detReg: document.getElementById('det-reg'),
  detType: document.getElementById('det-type'),
  btnStartUninstall: document.getElementById('btn-start-uninstall'),
  
  // Wizard Modal Overlay
  wizModalOverlay: document.getElementById('wizard-modal-overlay'),
  wizAppName: document.getElementById('wiz-app-name'),
  wizAppVersion: document.getElementById('wiz-app-version'),
  wizCloseX: document.getElementById('wiz-close-x'),
  
  // Wizard Buttons
  btnWizCancel: document.getElementById('btn-wiz-cancel'),
  btnWizBack: document.getElementById('btn-wiz-back'),
  btnWizNext: document.getElementById('btn-wiz-next'),
  btnWizPurge: document.getElementById('btn-wiz-purge'),
  btnWizFinish: document.getElementById('btn-wiz-finish'),
  
  // Screen 1 (Config)
  chkCreateRestore: document.getElementById('chk-create-restore'),
  chkRunSilently: document.getElementById('chk-run-silently'),
  modeCards: document.querySelectorAll('.mode-card'),
  
  // Screen 3 (Native Run)
  btnLaunchNative: document.getElementById('btn-launch-native'),
  nativeUninstPromptText: document.getElementById('native-uninst-prompt-text'),
  
  // Screen 5 (Leftovers Tree)
  lblLeftoversSummary: document.getElementById('lbl-leftovers-summary'),
  btnSelectAll: document.getElementById('btn-select-all'),
  leftoversTreeView: document.getElementById('leftovers-tree-view'),
  
  // Screen 7 (Complete)
  lblPurgeResultText: document.getElementById('lbl-purge-result-text'),
  lblSpaceSaved: document.getElementById('lbl-space-saved'),
  
  // Titlebar controls
  btnMinimize: document.getElementById('btn-minimize'),
  btnMaximize: document.getElementById('btn-maximize'),
  btnClose: document.getElementById('btn-close')
};

// Initial Setup
document.addEventListener('DOMContentLoaded', async () => {
  setupTitlebar();
  setupSidebarNavigation();
  setupFilters();
  setupDetailsPanel();
  setupWizardControls();
  setupQuarantineTab();
  setupProcessTab();
  setupUnlocker();
  setupCleanTab();
  setupQueuePanel();
  setupSettingsTab();
  setupForceUninstall();
  setupScanProgress();
  setupTour();

  await loadSettings();
  await checkElevation();
  // Seed the Settings panel's controls now, not just on first visit: without
  // this, set-startup-elevated (and every other settings control) shows the
  // HTML default until the user navigates to Settings once, which visibly
  // contradicts a currently-elevated session on a machine where startupMode
  // was already 'full' from a prior run.
  syncSettingsPanel();

  // LANDING ON HEALTH ADVISOR, and not waiting for the program list to do
  // it. Boot used to await loadApplications() before anything was on screen,
  // which put two PowerShell round trips in front of the first frame for a
  // table the user may not even be looking at. The audit panel's sections
  // each render as their own query lands (see loadAuditData), so the first
  // useful frame arrives on the fastest query rather than the slowest.
  switchTab(activeTab);

  // Warm the program list in the background so All Programs is instant when
  // it is clicked. Deliberately NOT awaited: nothing on the landing screen
  // needs it, and a failure here is already reported inside that tab.
  loadApplications().catch((err) => console.error('Background app load failed:', err));
  // Wire the buttons; do NOT open anything. The offer opens from the banner
  // or from a blocked action, never from having started the app.
  wireElevationOffer();

  // The tour no longer has to dodge the elevation modal, because the modal no
  // longer opens on launch. The check is kept anyway: it costs nothing and it
  // is still true that two full-screen overlays on the first frame is worse
  // than finding "Take the tour" in Settings once.
  if (!appSettings.hasSeenTour) {
    const elevationShowing = document.getElementById('elevation-modal-overlay').classList.contains('active');
    if (!elevationShowing) startTour();
  }
});

// Titlebar Button Events
function setupTitlebar() {
  elements.btnMinimize.addEventListener('click', () => window.api.minimizeWindow());
  elements.btnMaximize.addEventListener('click', () => window.api.maximizeWindow());
  elements.btnClose.addEventListener('click', () => window.api.closeWindow());
}

async function loadSettings() {
  try {
    appSettings = await window.api.getSettings();
  } catch {
    /* defaults stand */
  }
}

// REQ-04: resolve the tier, then render the banner and lock every destructive
// control. main.js rejects the calls regardless; this is the honest surface.
async function checkElevation() {
  tierState = await window.api.getTier();
  isAdmin = tierState.isFullMode;

  const banner = document.getElementById('tier-banner');
  const bannerText = document.getElementById('tier-banner-text');

  if (isAdmin) {
    elements.adminIndicator.className = 'admin-badge elevated';
    elements.adminIndicator.innerHTML = '<i class="fa-solid fa-shield-halved"></i><span>Full Mode</span>';
    elements.statRestoreStatus.textContent = 'Enabled';
    banner.style.display = 'none';
  } else {
    elements.adminIndicator.className = 'admin-badge unelevated';
    elements.adminIndicator.innerHTML = '<i class="fa-solid fa-eye"></i><span>Audit Mode</span>';
    // Keep this short: it renders in a fixed-height stat card.
    elements.statRestoreStatus.textContent = 'Read-only';
    bannerText.textContent = tierState.bannerText;
    banner.style.display = 'flex';
  }

  applyTierLocks();

  // Operator report, live testing 2026-08-10: "Restart as administrator"
  // could report success and the app would close and reopen, but land back
  // in Audit Mode with nothing telling the user something was wrong - a
  // silent loop. main.js now writes a one-shot marker before quitting on
  // that success path and checks it on the very next boot; if this boot IS
  // that next one and it did NOT come back elevated, say so explicitly
  // instead of leaving it to look like the click did nothing.
  if (tierState.elevationMismatch) {
    const m = tierState.elevationMismatch;

    // 1dq: both directions. This message only ever described the elevate
    // case, so when the operator's round trip failed the OTHER way on
    // 2026-08-13 - two de-elevations reporting success, both landing back in
    // Full Mode - the app said nothing at all. A relaunch that lands in the
    // tier it was leaving has failed whichever way it was going, and this is
    // the one moment the app can say so with certainty.
    if (m.direction === 'deelevate') {
      toast(
        'Vanish tried to restart WITHOUT administrator rights a moment ago and reported success, but ' +
        'this session started with them anyway. Nothing was lost - you are still in Full Mode - but the ' +
        'switch did not take. This has been logged with the reason.',
        'warn',
        12000
      );
    } else {
      const uacNote = m.uac && m.uac.enableLua === false
        ? ' User Account Control appears to be turned off on this machine, which may be why.'
        : '';
      toast(
        'Vanish tried to restart with administrator rights a moment ago and reported success, but this session ' +
        `started in Audit Mode anyway.${uacNote} This has been logged - if you see it again, that is worth reporting.`,
        'warn',
        12000
      );
    }
  }
}

// Every control marked data-destructive is inert in Audit Mode and says why.
function applyTierLocks() {
  document.querySelectorAll('[data-destructive="true"]').forEach((el) => {
    // 9sy: remember the element's OWN title on first sight, in EITHER tier.
    //
    // This used to be stashed only in the Audit branch below, so the sequence
    // that mattered was never covered: on a session that starts ALREADY
    // elevated, applyTierLocks runs with isAdmin true, finds no stashed title
    // because the Audit branch has never executed, and removeAttribute('title')
    // deletes the authored one. Every destructive control lost its explanation
    // at exactly the moment its action became live.
    //
    // The elevated real-data pass measured 0 of 46 startup action buttons
    // carrying a title. It read as a rendering bug and is not - the markup sets
    // them correctly and this function then strips them.
    //
    // Worth noting how it hid: unelevated the SAME assertion passes, because
    // the Audit branch gives every control TIER_TOOLTIP. A test that only ever
    // ran unelevated could not fail, and passed for a reason unrelated to the
    // thing it names.
    if (!('tierTitle' in el.dataset)) {
      const authored = (el.getAttribute('title') || '').trim();
      if (authored && authored !== TIER_TOOLTIP) el.dataset.tierTitle = authored;
    }

    if (isAdmin) {
      el.classList.remove('tier-locked');
      if (el.dataset.tierTitle) {
        el.title = el.dataset.tierTitle;
      } else {
        el.removeAttribute('title');
      }
      el.removeAttribute('aria-disabled');
    } else {
      el.classList.add('tier-locked');
      if (el.title && el.title !== TIER_TOOLTIP) el.dataset.tierTitle = el.title;
      el.title = TIER_TOOLTIP;
      el.setAttribute('aria-disabled', 'true');
    }
  });
}

// FLOW-01, amended 2026-08-14 on operator instruction:
//
//   "opening vanish shouldnt immediately throw this dialog in my face, thats
//    what the banner and button are for. let the user choose to go into admin
//    mode, when needed by choice, gating or necessity."
//
// So the offer no longer appears on launch. It is not gone - it appears at
// the three moments it is actually relevant:
//
//   CHOICE     the Audit Mode banner and its button, always visible
//   GATING     guardFullMode(), when a Full Mode action is actually blocked
//   NECESSITY  the same, since that IS the moment of necessity
//
// A modal that opens before the user has asked for anything is not consent,
// it is a toll gate. The banner says the same thing without stopping them.
function wireElevationOffer() {
  const overlay = document.getElementById('elevation-modal-overlay');
  if (!overlay) return;
  document.getElementById('btn-stay-audit').onclick = async () => {
    overlay.classList.remove('active');
    await window.api.dismissElevationOffer();
  };
  document.getElementById('btn-elevate-now').onclick = () => requestElevation(overlay);
  document.getElementById('btn-banner-elevate').onclick = () => requestElevation(null);
}

// Opened by gating, never by starting the app.
function showElevationOffer() {
  if (isAdmin) return;
  const overlay = document.getElementById('elevation-modal-overlay');
  if (overlay) overlay.classList.add('active');
}

async function requestElevation(overlay) {
  // 2cv: the UAC prompt can take a moment to appear, and once it is accepted
  // this window closes while a second Electron process boots. Both stretches
  // used to look identical to a frozen app, so say what is happening before the
  // wait rather than after it.
  if (overlay) overlay.classList.remove('active');
  const wait = document.getElementById('elevation-wait-overlay');
  const waitTitle = document.getElementById('elevation-wait-title');
  const waitText = document.getElementById('elevation-wait-text');
  // The overlay is shared with requestDeelevation() below - reset it to this
  // direction's copy every time, in case the other direction left its text
  // behind from an earlier attempt.
  if (waitTitle) waitTitle.textContent = 'Restarting with administrator rights';
  if (waitText) waitText.textContent = 'Windows is asking whether Vanish may run as administrator. Answer that prompt to continue.';
  if (wait) wait.classList.add('active');

  const res = await window.api.relaunchElevated();

  if (res && res.success) {
    // This instance is being replaced (D-09). Main keeps its own small window
    // up after this one goes, so the desktop is never blank in between.
    if (waitText) {
      waitText.textContent =
        'Permission granted. Vanish is reopening with administrator rights - this takes a few seconds.';
    }
    return;
  }

  if (wait) wait.classList.remove('active');
  toast(elevationFailureMessage(res && res.cause), 'warn', 9000);
}

// Symmetric with requestElevation() above, for the direction that did not
// exist until now: dropping back to Audit Mode from a session already
// running elevated. No UAC prompt is possible or expected here - UAC governs
// REQUESTING more privilege, not giving it up - so there is no "declined"
// case, only "the relaunch itself failed" (bad path, COM unavailable).
async function requestDeelevation() {
  const wait = document.getElementById('elevation-wait-overlay');
  const waitTitle = document.getElementById('elevation-wait-title');
  const waitText = document.getElementById('elevation-wait-text');
  if (waitTitle) waitTitle.textContent = 'Restarting in Audit Mode';
  if (waitText) waitText.textContent = 'Vanish is reopening without administrator rights - this takes a few seconds.';
  if (wait) wait.classList.add('active');

  const res = await window.api.relaunchDeelevated();

  if (res && res.success) {
    return; // this instance is being replaced, same as the elevate direction
  }

  if (wait) wait.classList.remove('active');
  // 1dq: the engine now reports runas.exe's own exit code and stderr instead
  // of calling the launch a success. A real reason is far more useful than
  // the single sentence that used to cover every possible cause.
  const reason = (res && res.error) || 'Could not restart without administrator rights.';
  const code = res && typeof res.exitCode === 'number' && res.exitCode !== 0
    ? ' (runas exit code ' + res.exitCode + ')'
    : '';
  toast(reason + code, 'warn', 10000);
}

// scanner.ps1 now tells apart WHY a relaunch-elevated attempt failed instead
// of reporting every case as a generic decline (operator report: "admin is
// not getting granted on a UAC-disabled machine" -- the old one-size message
// told them Windows refused them, when the real cause was that there was no
// UAC prompt to refuse in the first place).
function elevationFailureMessage(cause) {
  switch (cause) {
    case 'not-admin':
      return "This Windows account isn't an administrator, so there is no elevated permission to grant. " +
        'Sign in with an administrator account, or ask one to add this account to the Administrators group.';
    case 'uac-disabled':
      return 'User Account Control is turned off on this machine, so Windows never showed a permission ' +
        "prompt to accept. Vanish stays in Audit Mode - turn UAC back on in Windows' own settings, or " +
        'sign in from an account that is already an administrator.';
    case 'uac-disabled-locked':
      // qyt: the same machine fact as above with different advice attached,
      // because on a managed machine "turn UAC back on" is advice the user
      // cannot act on - the setting reverts at the next policy refresh.
      //
      // "Likely" is load-bearing and is not hedging for its own sake. Windows
      // does not record whether these values came from Group Policy, so what
      // Vanish actually knows is narrower than the conclusion: this machine is
      // domain-joined AND an administrator token could not write the policy
      // key. That is strong evidence and it is not proof, and the wording is
      // not allowed to promote one to the other.
      return 'User Account Control is turned off on this machine, so Windows never showed a permission ' +
        'prompt to accept - and this looks like a managed machine where that setting is likely enforced ' +
        "by your organisation's policy rather than chosen locally, so changing it by hand would probably " +
        'be undone. Vanish stays in Audit Mode. Ask whoever administers this PC.';
    case 'elevation-silent-failed':
      // adg: UAC is ON, so the token is filtered and Vanish opens in Audit
      // Mode - but ConsentPromptBehaviorAdmin is 0, so Windows grants
      // elevation with no dialog at all. The user therefore sees nothing
      // happen and lands back where they started, which reads as the button
      // being broken. Naming the setting matters: told "UAC is off" they
      // would go looking for a switch that is already on.
      //
      // The second sentence is not a lecture, it is the security fact that
      // follows from the setting: on this machine ANY program that asks to
      // elevate is granted it silently, and someone who set this once a year
      // ago has no reason to remember.
      return 'Windows is set to grant administrator rights without asking, so no permission prompt ' +
        'appeared and nothing was shown to accept - the relaunch itself failed. User Account Control ' +
        'is still switched on; it is the prompt that is turned off (Consent Prompt Behavior for ' +
        'Administrators is set to "Elevate without prompting"). Worth knowing either way: with that ' +
        'setting, any program on this PC can gain administrator rights without showing you anything.';
    case 'engine-error':
      return "Vanish couldn't reach its own scanning engine to request elevation. Try restarting Vanish.";
    case 'declined':
      return 'You declined the Windows permission prompt. Vanish stays in Audit Mode.';
    default:
      return 'Windows did not grant administrator rights. Vanish stays in Audit Mode.';
  }
}

// 7oo.3: the protected set is now tiny and evidence-backed - Windows servicing
// components, not "anything Microsoft published". When it does refuse, it
// refuses by name and with the reason, never as a silently inert button.
function guardProtected() {
  if (!selectedApp) return true;
  // 7oo.7: optional features are listed so the user can SEE them. Turning one
  // on or off is a reboot-adjacent OS change and is Windows' own dialog's job,
  // so the refusal names where to go rather than pretending to be able.
  // Shared with 5rz's bulk add (appProtectionBlock, defined near queueAddSelected)
  // so the two paths can never drift onto different wording for the same check.
  const block = appProtectionBlock(selectedApp);
  if (!block) return true;
  toast(block.message, block.toastType, block.toastDuration);
  return false;
}

// Reused by every destructive UI path so a locked control can never act.
// The gate is also the offer. Refusing an action and then making the user go
// find the banner themselves is the worst of both: it interrupts, and it does
// not help. This is the moment elevation is genuinely necessary, so this is
// where it is offered.
function guardFullMode() {
  if (isAdmin) return true;
  showElevationOffer();
  return false;
}

// Load both Desktop and UWP Apps
async function loadApplications() {
  showLoadingState();
  // Get-UwpApps used to walk every package's full folder size (10+ seconds
  // on a real machine) - that walk is gone (scanner.ps1, sizeBytes hardcoded
  // to 0, operator 2026-08-07) and both desktop/UWP reads now measure
  // ~350ms combined. The loading state stays regardless: a bare "0" on the
  // dashboard while ANY read is in flight is indistinguishable from "not
  // implemented," and a future slow field on either side should not have to
  // rediscover that.
  elements.statTotalApps.textContent = '...';
  elements.statUwpApps.textContent = '...';
  elements.statTotalSize.textContent = '...';
  updateFilterStatus(0);

  try {
    const [desktopApps, uwpApps] = await Promise.all([
      window.api.getDesktopApps(),
      window.api.getUwpApps()
    ]);
    
    // Defence in depth against odd registry payloads (see scanner coercion):
    // one malformed DisplayName must never take the whole list down.
    allApps = [...desktopApps, ...uwpApps].map((app) => ({
      ...app,
      name: String(app.name ?? 'Unknown'),
      publisher: String(app.publisher ?? 'Unknown Publisher'),
      version: String(app.version ?? 'Unknown'),
      type: String(app.type ?? 'Desktop'),
      // UWP packages have no uninstall-hive classification of their own; they
      // are all standalone applications by construction.
      classification: String(app.classification ?? 'application'),
      classificationReason: String(app.classificationReason ?? ''),
      removalNote: String(app.removalNote ?? ''),
      protected: app.protected === true,
      protectionReason: String(app.protectionReason ?? '')
    }));

    updateDashboardStats();
    filterAndRenderApps();
  } catch (error) {
    console.error('Failed to load apps:', error);
    elements.appsTbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 48px; color: var(--color-danger);">
          <i class="fa-solid fa-circle-xmark" style="font-size: 28px; margin-bottom: 12px;"></i>
          <div>Could not read your installed programs: ${error.message}</div>
        </td>
      </tr>
    `;
  }
}

function showLoadingState() {
  elements.appsTbody.innerHTML = `
    <tr id="initial-loading-row">
      <td colspan="5" style="text-align: center; padding: 48px; color: var(--text-gray);">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 12px; color: var(--color-primary);"></i>
        <div>Finding installed programs...</div>
      </td>
    </tr>
  `;
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return 'Unknown';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// c0y: where an install date actually came from, in one place, so the table
// and the details pane cannot drift apart about it.
//
// This exists because of a mistake made in conversation, not one found in
// code: an install date was read off an adjacent registry row and stated as
// fact. Auditing our own code for the same move found it twice. A date the
// program recorded and a date Vanish worked out from a key name or a folder's
// creation time were rendered identically, in the same styling, with nothing
// separating them - so a user sorting by age was mixing measurements and
// guesses without being told.
//
// The fallbacks stay. A probable date beats "Unknown". It just has to admit
// what it is, which is the same rule bu2 enforces for owned/orphaned/
// unattributed sizes.
const INSTALL_DATE_SOURCES = {
  recorded: {
    inferred: false,
    note: 'Recorded by the program itself when it was installed.',
  },
  'key-name': {
    inferred: true,
    note: 'Approximate. This program recorded no install date, so Vanish read this from its uninstall entry being named as a date. Many installers do name it that way, but it is Vanish working it out, not the program saying so.',
  },
  'folder-created': {
    inferred: true,
    note: 'Approximate. A Store app records no install date, so this is when its folder was created. That is usually the install, but a repair or an update can move it.',
  },
};

function installDateProvenance(app) {
  // An older engine build, or any path that never set the field, sends a date
  // with no source. Treat that as unknown provenance rather than as recorded:
  // claiming a date is measured when nothing said so is the exact fault here.
  if (!app || !app.installDate) return { inferred: false, note: '' };
  const known = INSTALL_DATE_SOURCES[app.installDateSource];
  if (known) return known;
  return {
    inferred: true,
    note: 'Approximate. Vanish could not establish where this date came from.',
  };
}

// Everything the user would call an application. Components and update rows are
// real and reachable, but they are not what "you have N applications" means.
function visibleApps() {
  // ht8: runtimes-only overrides the components split, because every runtime IS
  // a component - filtering to runtimes inside "applications only" would always
  // produce an empty table and read as "you have none".
  const base = runtimesOnly
    ? allApps.filter((a) => a.isRuntime === true)
    : (showComponents ? allApps : allApps.filter((a) => a.classification === 'application'));
  return showFeatures ? base.concat(windowsFeatures) : base;
}

async function loadWindowsFeatures() {
  if (featuresLoaded) return;
  try {
    const res = await window.api.getWindowsFeatures();
    if (res && res.success) {
      windowsFeatures = (res.features || []).filter((f) => f && typeof f === 'object');
      featuresLoaded = true;
    } else {
      toast(`Could not read Windows features: ${(res && res.error) || 'no response'}`, 'error', 7000);
    }
  } catch (err) {
    toast(`Could not read Windows features: ${err.message}`, 'error', 7000);
  }
}

// Update stats count & size
function updateDashboardStats() {
  const shown = visibleApps();
  const uwpCount = shown.filter(app => app.type === 'UWP').length;
  const componentCount = allApps.length - allApps.filter((a) => a.classification === 'application').length;

  let totalBytes = 0;
  shown.forEach(app => {
    if (app.sizeBytes) totalBytes += app.sizeBytes;
  });

  elements.statTotalApps.textContent = shown.length;
  elements.statUwpApps.textContent = uwpCount;
  elements.statTotalSize.textContent = formatBytes(totalBytes, 1);

  const badge = document.getElementById('components-count');
  if (badge) badge.textContent = componentCount;

  // ht8: the redistributable count, always on screen for the same reason the
  // component count is - a number nobody can see is a number nobody can act on.
  const runtimesBadge = document.getElementById('runtimes-count');
  if (runtimesBadge) runtimesBadge.textContent = allApps.filter((a) => a.isRuntime === true).length;

  const featuresBadge = document.getElementById('features-count');
  if (featuresBadge) featuresBadge.textContent = featuresLoaded ? windowsFeatures.length : '?';
}

// 5b0: the Type column's filter offers the values the CELLS carry, not the raw
// app.type strings behind them - a checklist offering "UWP" while the table
// reads "Windows App" is a filter for something the user cannot see anywhere.
// One helper, called by the cell and by the filter, so the two cannot drift.
function appTypeLabel(app) {
  if (!app) return 'Desktop';
  if (app.type === 'UWP') return 'Windows App';
  if (app.type === 'Feature') return 'Feature';
  return 'Desktop';
}

// The column filters this view owns; also the display order of their chips.
const APP_COLUMN_FILTERS = ['apps.publisher', 'apps.type'];

// Filter and Sort Handler
function filterAndRenderApps() {
  let filtered = visibleApps().filter(app => {
    // 1. Search term match
    const term = filterText.toLowerCase();
    const matchesSearch = app.name.toLowerCase().includes(term) || 
                          app.publisher.toLowerCase().includes(term);
                          
    // 2. Type filter match
    let matchesType = true;
    if (filterType === 'desktop') {
      matchesType = app.type === 'Desktop';
    } else if (filterType === 'uwp') {
      matchesType = app.type === 'UWP';
    }
    
    // 5b0: AND with the column filters. The Type toggle in the header and the
    // Type column filter can both be set at once, and the caption then names
    // both - two filters quietly overriding one another would be worse than
    // two that each admit themselves.
    return matchesSearch && matchesType && columnFilterAllowsAll(APP_COLUMN_FILTERS, app);
  });
  
  // Apply sorting
  filtered.sort((a, b) => {
    switch (sortOption) {
      case 'name-asc':
        return a.name.localeCompare(b.name);
      case 'name-desc':
        return b.name.localeCompare(a.name);
      case 'size-desc':
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      case 'size-asc':
        return (a.sizeBytes || 0) - (b.sizeBytes || 0);
      case 'date-desc':
        if (!a.installDate) return 1;
        if (!b.installDate) return -1;
        return b.installDate.localeCompare(a.installDate);
      case 'date-asc':
        if (!a.installDate) return 1;
        if (!b.installDate) return -1;
        return a.installDate.localeCompare(b.installDate);
      default:
        return 0;
    }
  });
  
  renderTable(filtered);
  updateFilterStatus(filtered.length);
}

// Makes an active search/type filter impossible to miss - including one
// typed before the initial (10+ second) app-list load finished, which used
// to apply silently with zero on-screen explanation for why the list was
// short (operator report 2026-08-05).
function updateFilterStatus(shownCount) {
  const row = document.getElementById('filter-status-row');
  const text = document.getElementById('filter-status-text');
  const clearBtn = document.getElementById('btn-clear-filters');
  if (!row || !text || !clearBtn) return;

  const columnFiltered = activeColumnFilterKeys(APP_COLUMN_FILTERS).length > 0;
  const isFiltered = filterText.trim() !== '' || filterType !== 'all' || columnFiltered || runtimesOnly;
  row.classList.toggle('filtered', isFiltered);
  clearBtn.style.display = isFiltered ? '' : 'none';
  renderColumnFilterChips('apps-filter-chips', APP_COLUMN_FILTERS);

  const pool = visibleApps().length;
  // Every split is a filter, and a filter has to admit itself. The whole reason
  // 60 entries could vanish for good is that a narrowed list read as a complete
  // one - so the caption names what is being held back AND what has been added.
  const applications = allApps.filter((a) => a.classification === 'application').length;
  const hidden = showComponents ? 0 : allApps.length - applications;

  const notes = [];
  const runtimeTotal = allApps.filter((a) => a.isRuntime === true).length;
  // ht8: the count is stated whether or not the filter is on, because "how many
  // redistributables are on this machine" is the question, and a number that
  // only appears once you have already found the control answers it too late.
  if (runtimesOnly) {
    notes.push(`shared runtimes only - ${runtimeTotal} of ${allApps.length}`);
  } else {
    if (hidden > 0) notes.push(`${hidden} component${hidden === 1 ? '' : 's'} hidden`);
    if (runtimeTotal > 0) notes.push(`${runtimeTotal} shared runtime${runtimeTotal === 1 ? '' : 's'}`);
  }
  if (showFeatures) notes.push(`including ${windowsFeatures.length} Windows feature${windowsFeatures.length === 1 ? '' : 's'}`);
  const suffix = notes.length ? ` (${notes.join(', ')})` : '';

  // 5b0: name the columns, do not merely admit that something is filtered.
  // "12 of 158" with no stated cause is how a user concludes the scan lost
  // their programs.
  const byColumns = columnFiltered ? ` - filtered by ${columnFilterSummary(APP_COLUMN_FILTERS)}` : '';

  if (!isFiltered) {
    text.textContent = allApps.length === 0
      ? 'Finding installed programs...'
      : `Showing all ${pool} programs${suffix}`;
  } else {
    text.textContent = `Showing ${shownCount} of ${pool} programs${suffix}${byColumns}`;
  }

  // 5rz: this row and the bulk-selection row share one slot, so while a
  // selection is live this caption is hidden - and hiding it is precisely the
  // 2026-08-05 bug (a filter that says nothing about itself). The bulk caption
  // carries this sentence for the duration instead, so re-run it here, after
  // the text above is current rather than one render stale.
  updateBulkSelectUI();
}

// Render dynamic rows in table
function renderTable(apps) {
  // 5rz: rows that were checked before this re-render (a sort, a filter
  // keystroke, a background refresh) stay checked if they are still in the
  // new list - only an id that has genuinely disappeared (the app was
  // removed, or a filter now excludes it) gets dropped. Re-rendering the
  // table must never silently clear a selection the user is mid-building.
  const stillPresent = new Set(apps.map((a) => a.id));
  for (const id of bulkSelectedAppIds) {
    if (!stillPresent.has(id)) bulkSelectedAppIds.delete(id);
  }

  // 5rz: a shift-click anchor is an INDEX into the list as it was rendered.
  // The ids survive a re-sort but their positions do not, so an anchor carried
  // across one would range-select a stretch of rows the user never pointed at.
  // Same list in the same order (the shift handler's own re-render) keeps it.
  const sameOrder =
    lastRenderedApps.length === apps.length && lastRenderedApps.every((a, i) => a.id === apps[i].id);
  if (!sameOrder) lastCheckedRowIndex = null;
  lastRenderedApps = apps;

  if (apps.length === 0) {
    // 5b0: an empty table has to say WHICH filter emptied it. "No programs match
    // your search" while the search box is empty and a column filter is doing
    // the hiding is the same lie the caption row above was added to stop.
    const columns = columnFilterSummary(APP_COLUMN_FILTERS);
    const searching = filterText.trim() !== '' || filterType !== 'all';
    const reason = columns && searching
      ? `No programs match your search and the ${columns} filter.`
      : columns
        ? `No programs match the ${columns} filter.`
        : 'No programs match your search.';
    elements.appsTbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 48px; color: var(--text-gray);">
          <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 12px;"></i>
          <div>${esc(reason)}</div>
          ${columns || searching
            ? '<button class="btn-clear-filters-inline" id="btn-empty-clear-filters" style="margin-top: 10px;">Clear filters</button>'
            : ''}
        </td>
      </tr>
    `;
    const emptyClear = document.getElementById('btn-empty-clear-filters');
    if (emptyClear) emptyClear.addEventListener('click', () => clearAppFilters());
    updateBulkSelectUI();
    return;
  }

  elements.appsTbody.innerHTML = '';

  apps.forEach((app, index) => {
    const row = document.createElement('tr');
    row.className = 'app-row';
    if (selectedApp && selectedApp.id === app.id) {
      row.className += ' selected';
    }

    // Fallback icon generation: first letter of name
    const initial = app.name.trim().charAt(0).toUpperCase();

    const sizeStr = app.sizeBytes ? formatBytes(app.sizeBytes, 1) : 'Unknown';
    const dateStr = app.installDate ? app.installDate : 'Unknown';
    const dateProv = installDateProvenance(app);
    const checked = bulkSelectedAppIds.has(app.id);

    row.innerHTML = `
      <td><input type="checkbox" class="app-row-checkbox" data-app-index="${index}"${checked ? ' checked' : ''}></td>
      <td>
        <div class="app-info-cell">
          <div class="app-icon-placeholder">${esc(initial)}</div>
          <div>
            <div class="app-title-name">${esc(app.name)}</div>
            <div class="app-publisher-name">${esc(app.publisher)}</div>
          </div>
        </div>
      </td>
      <td>
        <span class="badge-type ${esc(app.type.toLowerCase())}">${esc(appTypeLabel(app))}</span>
      </td>
      <td style="color: var(--text-gray); font-size: 13px;"${dateProv.inferred ? ` title="${esc(dateProv.note)}"` : ''}>${esc(dateStr)}${dateProv.inferred ? '<span class="inferred-mark" aria-label="approximate">~</span>' : ''}</td>
      <td style="color: var(--text-gray); font-size: 13px; font-weight: 500;">${esc(sizeStr)}</td>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.app-row-checkbox')) return; // handled below, not a row-select
      selectApp(app, row);
    });

    const checkbox = row.querySelector('.app-row-checkbox');
    checkbox.addEventListener('click', (e) => {
      // 5rz: shift-click range selection, same convention as file managers
      // and every other checkbox-list UI - extends from the last box the
      // user actually clicked, not from wherever the mouse happens to be.
      if (e.shiftKey && lastCheckedRowIndex !== null) {
        const [start, end] = [lastCheckedRowIndex, index].sort((a, b) => a - b);
        const targetState = checkbox.checked;
        for (let i = start; i <= end; i++) {
          const targetApp = apps[i];
          if (!targetApp) continue;
          if (targetState) bulkSelectedAppIds.add(targetApp.id);
          else bulkSelectedAppIds.delete(targetApp.id);
        }
        renderTable(apps); // re-render to reflect the whole range's new checked state
        return;
      }
      if (checkbox.checked) bulkSelectedAppIds.add(app.id);
      else bulkSelectedAppIds.delete(app.id);
      lastCheckedRowIndex = index;
      updateBulkSelectUI();
    });

    elements.appsTbody.appendChild(row);
  });

  updateBulkSelectUI();
}

// Select App handler
function selectApp(app, rowElement) {
  selectedApp = app;
  
  // Visual selected state
  document.querySelectorAll('.app-row').forEach(r => r.classList.remove('selected'));
  if (rowElement) {
    rowElement.classList.add('selected');
  }
  
  // Populate sidebar details
  elements.detIcon.textContent = app.name.trim().charAt(0).toUpperCase();
  elements.detTitle.textContent = app.name;
  elements.detPublisher.textContent = app.publisher;
  elements.detVersion.textContent = app.version;
  // c0y: the details pane has room for words, so it uses them rather than a
  // mark the user has to decode.
  const detProv = installDateProvenance(app);
  elements.detDate.textContent = app.installDate
    ? (detProv.inferred ? `${app.installDate} (approx.)` : app.installDate)
    : 'Unknown';
  elements.detDate.title = app.installDate ? detProv.note : '';
  elements.detDate.classList.toggle('inferred-value', detProv.inferred);
  elements.detSize.textContent = app.sizeBytes ? formatBytes(app.sizeBytes, 1) : 'Unknown';
  elements.detPath.textContent = app.installLocation || 'Unknown';
  elements.detReg.textContent = app.registryPath || 'Unknown';
  elements.detType.textContent =
    app.type === 'UWP' ? 'Windows Store app'
    : app.type === 'Feature' ? 'Part of Windows'
    : 'Desktop program';

  // Why this entry is classified as it is, why Windows hides its uninstall
  // button, or why Vanish holds it back. Whichever applies, the user reads the
  // actual reason instead of guessing at a greyed-out button (Rule 24).
  const note = document.getElementById('det-note');
  const noteText = document.getElementById('det-note-text');
  if (note && noteText) {
    const reasons = [app.protectionReason, app.classificationReason, app.removalNote]
      .map((r) => String(r || '').trim())
      .filter(Boolean);
    noteText.textContent = reasons.join(' ');
    note.style.display = reasons.length ? '' : 'none';
    note.classList.toggle('protected', app.protected === true);
  }

  // A protected entry is the one case where the action is genuinely refused, so
  // the button has to say so rather than looking available.
  const uninstallBtn = elements.btnStartUninstall;
  if (uninstallBtn) {
    const held = app.protected === true || app.classification === 'feature';
    uninstallBtn.classList.toggle('entry-protected', held);
    uninstallBtn.querySelector('span').textContent =
      app.classification === 'feature' ? 'Managed by Windows'
      : app.protected ? 'Protected by Vanish'
      : 'Clean Uninstall';
  }

  // Show details panel
  elements.detailsSidebar.classList.add('active');
}

// Setup Event Listeners for Filters
function setupFilters() {
  elements.searchBar.addEventListener('input', (e) => {
    filterText = e.target.value;
    filterAndRenderApps();
  });
  
  // Type toggles (All, Desktop, UWP)
  elements.typeToggle.addEventListener('click', (e) => {
    if (e.target.classList.contains('toggle-btn')) {
      document.querySelectorAll('#type-toggle .toggle-btn').forEach(btn => btn.classList.remove('active'));
      e.target.classList.add('active');
      filterType = e.target.getAttribute('data-type');
      filterAndRenderApps();
    }
  });
  
  // Components toggle (7oo.3)
  const componentsBox = document.getElementById('chk-show-components');
  if (componentsBox) {
    componentsBox.addEventListener('change', (e) => {
      showComponents = e.target.checked;
      // Turning components off while isolating runtimes would empty the table.
      if (!showComponents) runtimesOnly = false;
      const rb = document.getElementById('chk-only-runtimes');
      if (rb) rb.checked = runtimesOnly;
      updateDashboardStats();
      filterAndRenderApps();
    });
  }

  // ht8: runtimes-only toggle.
  const runtimesBox = document.getElementById('chk-only-runtimes');
  if (runtimesBox) {
    runtimesBox.addEventListener('change', (e) => {
      runtimesOnly = e.target.checked;
      // Runtimes are components, so isolating them has to reveal them too.
      if (runtimesOnly) {
        showComponents = true;
        const cb = document.getElementById('chk-show-components');
        if (cb) cb.checked = true;
      }
      updateDashboardStats();
      filterAndRenderApps();
    });
  }

  // Windows optional features toggle (7oo.7)
  const featuresBox = document.getElementById('chk-show-features');
  if (featuresBox) {
    featuresBox.addEventListener('change', async (e) => {
      showFeatures = e.target.checked;
      if (showFeatures && !featuresLoaded) {
        const label = document.getElementById('features-count');
        if (label) label.textContent = '...';
        await loadWindowsFeatures();
      }
      updateDashboardStats();
      filterAndRenderApps();
    });
  }

  // Sort selector
  elements.sortSelector.addEventListener('change', (e) => {
    sortOption = e.target.value;
    filterAndRenderApps();
  });

  document.getElementById('btn-clear-filters').addEventListener('click', () => clearAppFilters());

  // 5b0: two column filters on this table. Publisher hangs off the NAME header
  // because that is the column publishers are rendered in (under each name) -
  // it has no header of its own, and giving it one would spend a column of
  // width repeating text already on screen. getPool is visibleApps(), so the
  // checklist covers every program this view could show including the ones the
  // current filters hide; see decision 2 in renderer/column-filter.js.
  registerColumnFilter({
    key: 'apps.publisher',
    label: 'Publisher',
    th: '#all-apps-table thead th:nth-child(2)',
    note: 'Publishers are listed under each program name, in this column.',
    getPool: () => visibleApps(),
    getValues: (app) => [app.publisher],
    onChange: () => filterAndRenderApps()
  });
  registerColumnFilter({
    key: 'apps.type',
    label: 'Type',
    th: '#all-apps-table thead th:nth-child(3)',
    getPool: () => visibleApps(),
    getValues: (app) => [appTypeLabel(app)],
    onChange: () => filterAndRenderApps()
  });

  // 5rz: the three bulk-select controls live with the other list controls on
  // purpose - select-all and clear-selection both act on the list AS CURRENTLY
  // FILTERED AND SORTED, which is exactly what the rest of this function is
  // about, and the per-row checkboxes are wired in renderTable() because they
  // are recreated on every render.
  const selectAllBox = document.getElementById('chk-select-all-apps');
  if (selectAllBox) {
    selectAllBox.addEventListener('change', (e) => {
      // Only the rows on screen right now. Ticking this with a filter active
      // must never quietly select the programs the filter is hiding - the
      // whole point of pairing this with the filters is "narrow, then take
      // what you can see".
      if (e.target.checked) lastRenderedApps.forEach((a) => bulkSelectedAppIds.add(a.id));
      else lastRenderedApps.forEach((a) => bulkSelectedAppIds.delete(a.id));
      lastCheckedRowIndex = null;
      renderTable(lastRenderedApps);
    });
  }

  const bulkAddBtn = document.getElementById('btn-bulk-add-queue');
  if (bulkAddBtn) bulkAddBtn.addEventListener('click', () => queueAddSelected());

  const bulkClearBtn = document.getElementById('btn-bulk-clear-selection');
  if (bulkClearBtn) {
    bulkClearBtn.addEventListener('click', () => {
      bulkSelectedAppIds.clear();
      lastCheckedRowIndex = null;
      renderTable(lastRenderedApps);
    });
  }
}

function clearAppFilters() {
  filterText = '';
  filterType = 'all';
  // Every filter this view has, the column ones included. A Clear that left a
  // funnel set would be the third variant of "a filter that says nothing about
  // itself" this table has had to fix.
  clearColumnFilters(APP_COLUMN_FILTERS);
  elements.searchBar.value = '';
  document.querySelectorAll('#type-toggle .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-type') === 'all');
  });
  filterAndRenderApps();
}

// Setup Sidebar tabs (tab map per 03-appflow.md)
const TAB_PANELS = {
  'all-apps': null, // the original content-area
  audit: 'audit-panel',
  'task-manager': 'process-panel',
  hygiene: 'hygiene-panel',
  'system-clean': 'clean-panel',
  quarantine: 'quarantine-panel',
  'force-uninstall': 'force-panel',
  settings: 'settings-panel',
  about: 'about-panel'
};

function switchTab(tabName) {
  const appsContentArea = document.querySelector(
    '.content-area:not(#audit-panel):not(#quarantine-panel):not(#process-panel):not(#clean-panel)' +
      ':not(#settings-panel):not(#about-panel):not(#force-panel)'
  );
  const panelIds = Object.values(TAB_PANELS).filter(Boolean);

  elements.navItems.forEach((nav) => nav.classList.toggle('active', nav.getAttribute('data-tab') === tabName));
  activeTab = tabName;

  panelIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // The process sampler only runs while its tab is visible.
  if (tabName !== 'task-manager') stopProcessRefresh();
  if (tabName !== 'audit') stopNetworkAutoRefresh();

  if (tabName === 'all-apps') {
    if (appsContentArea) appsContentArea.style.display = '';
    elements.searchBar.disabled = false;
    elements.typeToggle.style.pointerEvents = 'all';
    elements.typeToggle.style.opacity = '1';
    elements.sortSelector.disabled = false;
    elements.detailsSidebar.classList.remove('active');
    // Returning to this tab is not new evidence about the machine, so it does
    // not re-scan it. Re-running the full enumeration on every visit (even
    // now that it measures well under a second, see loadApplications) would
    // still blank the list, throw away the user's sort and search, and make
    // the app feel like it was thinking rather than working (7oo.5, same
    // class as the System Clean re-scan). Re-render what is already loaded;
    // scan only if we have never successfully loaded, and after an action
    // that actually changed the machine - closeUninstallWizard and the queue
    // already call loadApplications() directly for exactly that reason.
    if (allApps.length === 0) {
      loadApplications();
    } else {
      updateDashboardStats();
      filterAndRenderApps();
    }
    return;
  }

  if (appsContentArea) appsContentArea.style.display = 'none';

  const panelId = TAB_PANELS[tabName];
  if (panelId) {
    const panel = document.getElementById(panelId);
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.flex = '1';
    panel.style.overflow = 'hidden';
  }

  if (tabName === 'audit') { loadAuditData(); startNetworkAutoRefresh(); }
  if (tabName === 'quarantine') loadVaultEntries();
  if (tabName === 'task-manager') startProcessRefresh();
  // Deliberately does NOT start a scan. This one walks real directories and
  // hashes real files; arriving at a tab is not consent to that. The panel
  // renders what it last found, or an invitation.
  if (tabName === 'hygiene') renderHygienePanel();
  if (tabName === 'system-clean') renderCleanerSections();
  if (tabName === 'settings') loadSettingsPanel();
  if (tabName === 'about') loadAboutPanel();
  if (tabName === 'force-uninstall') resetForcePanel();
}

function setupSidebarNavigation() {
  elements.navItems.forEach((item) => {
    item.addEventListener('click', () => switchTab(item.getAttribute('data-tab')));
  });
}
