// Vanish Frontend UI Controller (renderer.js)
// Interacts with Electron preload bridge APIs

let allApps = [];
let selectedApp = null;
let activeTab = 'all-apps';
let filterText = '';
let filterType = 'all';
// 7oo.3: the default list is the things a person recognises as applications.
// Components are classified and counted, never dropped - this flag is how they
// come into view.
let showComponents = false;
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
  await loadApplications();
  await maybeOfferElevation();

  // First-launch guided tour. Skipped (not just delayed) if the elevation
  // offer is showing on this same launch - two full-screen overlays
  // stacking on the very first frame is worse than needing to find "Take
  // the tour" in Settings once. hasSeenTour stays false in that case, so a
  // later launch that doesn't offer elevation still gets it automatically.
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
}

// Every control marked data-destructive is inert in Audit Mode and says why.
function applyTierLocks() {
  document.querySelectorAll('[data-destructive="true"]').forEach((el) => {
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

// FLOW-01: the one-time offer. Declining leaves a working Audit Mode session.
async function maybeOfferElevation() {
  if (!tierState.offerElevation || isAdmin) return;
  const overlay = document.getElementById('elevation-modal-overlay');
  overlay.classList.add('active');

  document.getElementById('btn-stay-audit').onclick = async () => {
    overlay.classList.remove('active');
    await window.api.dismissElevationOffer();
    toast('Staying in Audit Mode. You can still list and scan everything.', 'info');
  };
  document.getElementById('btn-elevate-now').onclick = () => requestElevation(overlay);
  document.getElementById('btn-banner-elevate').onclick = () => requestElevation(null);
}

async function requestElevation(overlay) {
  // 2cv: the UAC prompt can take a moment to appear, and once it is accepted
  // this window closes while a second Electron process boots. Both stretches
  // used to look identical to a frozen app, so say what is happening before the
  // wait rather than after it.
  if (overlay) overlay.classList.remove('active');
  const wait = document.getElementById('elevation-wait-overlay');
  const waitText = document.getElementById('elevation-wait-text');
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
        "prompt to accept. Vanish stays in Audit Mode - check this PC's UAC/Group Policy settings, or " +
        'sign in from an account that is already an administrator.';
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
  if (selectedApp.classification === 'feature') {
    toast(
      `${selectedApp.name} is part of Windows. Turn it on or off in Windows' own "Turn Windows features on or off" window (optionalfeatures.exe).`,
      'info',
      9000
    );
    return false;
  }

  if (selectedApp.protected !== true) return true;
  toast(
    `Vanish will not remove ${selectedApp.name}: ${selectedApp.protectionReason || 'Windows needs it to keep this PC updated.'}`,
    'warn',
    8000
  );
  return false;
}

// Reused by every destructive UI path so a locked control can never act.
function guardFullMode() {
  if (isAdmin) return true;
  toast(tierState.bannerText || 'Vanish is in Audit Mode. Restart it as administrator to uninstall and clean up.', 'warn');
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
        <td colspan="4" style="text-align: center; padding: 48px; color: var(--color-danger);">
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
      <td colspan="4" style="text-align: center; padding: 48px; color: var(--text-gray);">
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

// Everything the user would call an application. Components and update rows are
// real and reachable, but they are not what "you have N applications" means.
function visibleApps() {
  const base = showComponents ? allApps : allApps.filter((a) => a.classification === 'application');
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

  const featuresBadge = document.getElementById('features-count');
  if (featuresBadge) featuresBadge.textContent = featuresLoaded ? windowsFeatures.length : '?';
}

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
    
    return matchesSearch && matchesType;
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

  const isFiltered = filterText.trim() !== '' || filterType !== 'all';
  row.classList.toggle('filtered', isFiltered);
  clearBtn.style.display = isFiltered ? '' : 'none';

  const pool = visibleApps().length;
  // Every split is a filter, and a filter has to admit itself. The whole reason
  // 60 entries could vanish for good is that a narrowed list read as a complete
  // one - so the caption names what is being held back AND what has been added.
  const applications = allApps.filter((a) => a.classification === 'application').length;
  const hidden = showComponents ? 0 : allApps.length - applications;

  const notes = [];
  if (hidden > 0) notes.push(`${hidden} component${hidden === 1 ? '' : 's'} hidden`);
  if (showFeatures) notes.push(`including ${windowsFeatures.length} Windows feature${windowsFeatures.length === 1 ? '' : 's'}`);
  const suffix = notes.length ? ` (${notes.join(', ')})` : '';

  if (!isFiltered) {
    text.textContent = allApps.length === 0
      ? 'Finding installed programs...'
      : `Showing all ${pool} programs${suffix}`;
  } else {
    text.textContent = `Showing ${shownCount} of ${pool} programs${suffix}`;
  }
}

// Render dynamic rows in table
function renderTable(apps) {
  if (apps.length === 0) {
    elements.appsTbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 48px; color: var(--text-gray);">
          <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 12px;"></i>
          <div>No programs match your search.</div>
        </td>
      </tr>
    `;
    return;
  }
  
  elements.appsTbody.innerHTML = '';
  
  apps.forEach(app => {
    const row = document.createElement('tr');
    row.className = 'app-row';
    if (selectedApp && selectedApp.id === app.id) {
      row.className += ' selected';
    }
    
    // Fallback icon generation: first letter of name
    const initial = app.name.trim().charAt(0).toUpperCase();
    
    const sizeStr = app.sizeBytes ? formatBytes(app.sizeBytes, 1) : 'Unknown';
    const dateStr = app.installDate ? app.installDate : 'Unknown';
    
    row.innerHTML = `
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
        <span class="badge-type ${esc(app.type.toLowerCase())}">${
          app.type === 'UWP' ? 'Windows App' : app.type === 'Feature' ? 'Feature' : 'Desktop'
        }</span>
      </td>
      <td style="color: var(--text-gray); font-size: 13px;">${esc(dateStr)}</td>
      <td style="color: var(--text-gray); font-size: 13px; font-weight: 500;">${esc(sizeStr)}</td>
    `;
    
    row.addEventListener('click', () => selectApp(app, row));
    elements.appsTbody.appendChild(row);
  });
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
  elements.detDate.textContent = app.installDate || 'Unknown';
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
}

function clearAppFilters() {
  filterText = '';
  filterType = 'all';
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

// ==========================================
// SETTINGS PANEL (ENT-02)
// ==========================================

function setupSettingsTab() {
  const autoPurge = document.getElementById('set-auto-purge');
  const retention = document.getElementById('set-retention-days');
  const scanMode = document.getElementById('set-scan-mode');
  const refresh = document.getElementById('set-process-refresh');
  const startupElevated = document.getElementById('set-startup-elevated');

  // Deliberately NOT gated on isAdmin (unlike autoPurge below): the person who
  // needs this setting is, by definition, usually the one currently NOT
  // elevated. Does not itself do anything destructive - it only changes when
  // Vanish asks Windows for elevation, not whether Windows asks - so it gets
  // no confirmDialog, matching the other non-destructive settings here.
  //
  // BUG (operator report, screenshot showed the toggle ON next to "opens
  // read-only next start"): a native checkbox flips its own visual the
  // instant it's clicked, but the "Next start" line only used to update after
  // saveSettings()'s awaited IPC round-trip resolved. On any real latency
  // (disk I/O in writeSettings) that left a real, screenshot-catchable window
  // where the toggle and the text described two different states. Applying
  // the copy synchronously, before the await, closes that window - the text
  // now always matches what the user just clicked, and syncSettingsPanel()
  // reconciling it again once the save resolves is a no-op on the happy path.
  startupElevated.addEventListener('change', () => {
    applyStartupElevatedCopy(startupElevated.checked);
    saveSettings({ startupMode: startupElevated.checked ? 'full' : 'audit' });
  });

  autoPurge.addEventListener('change', async () => {
    if (autoPurge.checked) {
      const ok = await confirmDialog({
        title: 'Enable automatic purge?',
        body:
          `Anything in quarantine older than ${retention.value} day(s) will be deleted permanently each ` +
          'time Vanish starts, with no further prompt. This is the only setting that lets Vanish destroy ' +
          'something you did not click that day.',
        confirmLabel: 'Enable'
      });
      if (!ok) {
        autoPurge.checked = false;
        return;
      }
    }
    await saveSettings({
      autoPurgeEnabled: autoPurge.checked,
      autoPurgeRetentionDays: parseInt(retention.value, 10)
    });
  });

  retention.addEventListener('change', () =>
    saveSettings({ autoPurgeRetentionDays: parseInt(retention.value, 10) })
  );
  scanMode.addEventListener('change', () => saveSettings({ defaultScanMode: scanMode.value }));
  refresh.addEventListener('change', () =>
    saveSettings({ processRefreshSeconds: parseInt(refresh.value, 10) })
  );

  const networkRefresh = document.getElementById('set-network-refresh');
  if (networkRefresh) {
    networkRefresh.addEventListener('change', async () => {
      await saveSettings({ networkRefreshSeconds: parseInt(networkRefresh.value, 10) });
      // Take effect immediately if Health Advisor is the visible tab right
      // now, rather than waiting for the next tab switch to notice the
      // setting changed.
      if (activeTab === 'audit') startNetworkAutoRefresh();
    });
  }

  document.getElementById('set-open-vault').addEventListener('click', () => window.api.openVaultFolder());
  document.getElementById('set-open-data').addEventListener('click', () => window.api.openDataFolder());

  // Elevating from here is the same FLOW-01 path as the banner: one route, one
  // set of consequences, one wait notice.
  const modeAction = document.getElementById('settings-mode-action');
  if (modeAction) modeAction.addEventListener('click', () => requestElevation(null));
}

async function saveSettings(patch) {
  appSettings = await window.api.setSettings(patch);
  syncSettingsPanel();
  syncQuarantineSettingsUI();
  toast('Setting saved.', 'success', 2200);
}

// 388: the toggle's own name does not say what happens next, and the setting
// is about a launch that has not happened yet. Spell out the next start, and
// say it in terms of the toggle position itself so the two can never be read
// as describing different states.
function applyStartupElevatedCopy(startsElevated) {
  const startupState = document.getElementById('set-startup-elevated-state');
  if (!startupState) return;
  startupState.innerHTML = startsElevated
    ? '<i class="fa-solid fa-circle-check"></i> ON - Next start: Vanish asks Windows for administrator rights straight away, before any window shows.'
    : '<i class="fa-solid fa-circle-info"></i> OFF - Next start: Vanish opens read-only (Audit Mode). Turn this on, or click "Restart as administrator" any time, to switch.';
  startupState.style.color = startsElevated ? 'var(--color-success)' : 'var(--text-gray)';
}

function syncSettingsPanel() {
  const autoPurge = document.getElementById('set-auto-purge');
  if (!autoPurge) return;
  autoPurge.checked = appSettings.autoPurgeEnabled === true;
  document.getElementById('set-retention-days').value = appSettings.autoPurgeRetentionDays;
  document.getElementById('set-scan-mode').value = appSettings.defaultScanMode || 'Moderate';
  document.getElementById('set-process-refresh').value = appSettings.processRefreshSeconds;
  const networkRefreshInput = document.getElementById('set-network-refresh');
  if (networkRefreshInput) networkRefreshInput.value = appSettings.networkRefreshSeconds || 0;

  const startsElevated = appSettings.startupMode === 'full';
  document.getElementById('set-startup-elevated').checked = startsElevated;
  applyStartupElevatedCopy(startsElevated);

  syncModeCard();

  // Audit Mode can read the configuration but not change deletion policy.
  autoPurge.disabled = !isAdmin;
  document.getElementById('set-retention-days').disabled = !isAdmin;
}

// The mode this session is actually in, as opposed to the mode the next one
// will start in. Nothing on this panel used to say it.
function syncModeCard() {
  const card = document.getElementById('settings-mode-card');
  if (!card) return;
  const title = document.getElementById('settings-mode-title');
  const desc = document.getElementById('settings-mode-desc');
  const action = document.getElementById('settings-mode-action');

  card.classList.toggle('is-full', isAdmin);
  card.classList.toggle('is-audit', !isAdmin);

  if (isAdmin) {
    title.textContent = 'Full Mode - running as administrator';
    desc.textContent =
      'This session can uninstall, quarantine, restore and clean. Everything it removes still goes to ' +
      'the Quarantine tab first, and you still approve each item.';
    action.style.display = 'none';
  } else {
    title.textContent = 'Audit Mode - read-only';
    desc.textContent =
      'This session can list, scan and explain everything, but cannot change anything on this PC. ' +
      'Controls that would remove something are switched off rather than hidden.';
    action.style.display = '';
  }
}

async function loadSettingsPanel() {
  appSettings = await window.api.getSettings();
  syncSettingsPanel();

  const info = await window.api.getAppInfo();
  document.getElementById('set-vault-path').textContent = info.vaultRoot;
  document.getElementById('set-vault-stats').textContent =
    `${info.vaultEntryCount} item(s) held here - ${formatBytes(info.vaultBytes, 1)} on disk`;
  document.getElementById('set-oplog-path').textContent =
    `${info.oplogPath} (${info.oplogBytes > 0 ? formatBytes(info.oplogBytes, 1) : 'empty'})`;
}

// ==========================================
// ABOUT PANEL
// ==========================================

async function loadAboutPanel() {
  const info = await window.api.getAppInfo();
  document.getElementById('about-name').textContent = 'Vanish';
  document.getElementById('about-version').textContent =
    `Version ${info.version} - ${info.isFullMode ? 'Full Mode' : 'Audit Mode (read-only)'}`;

  const facts = [
    ['Version', info.version],
    ['Licence', 'MIT'],
    ['Repository', 'github.com/QuantumMonkey/Vanish'],
    ['Electron', info.versions.electron],
    ['Chromium', info.versions.chrome],
    ['Node', info.versions.node],
    ['Scanning engine', 'Windows PowerShell 5.1'],
    ['Data folder', info.dataDir],
    ['Network use while running', 'None'],
    ['Tracking', 'None']
  ];

  document.getElementById('about-facts').innerHTML = facts
    .map(
      ([k, v]) => `
      <div class="about-fact">
        <span class="about-fact-key">${esc(k)}</span>
        <span class="about-fact-value mono">${esc(v)}</span>
      </div>`
    )
    .join('');
}

function setupDetailsPanel() {
  elements.btnStartUninstall.addEventListener('click', () => {
    if (!guardFullMode()) return;
    if (!guardProtected()) return;
    if (selectedApp) {
      openUninstallWizard(selectedApp);
    }
  });

  const btnQueue = document.getElementById('btn-queue-app');
  if (btnQueue) {
    btnQueue.addEventListener('click', () => {
      if (!guardFullMode()) return;
      if (!guardProtected()) return;
      if (selectedApp) queueAddApp(selectedApp);
    });
  }
}

// ==========================================
// UNINSTALL WIZARD LOGIC
// ==========================================

function openUninstallWizard(app) {
  wizState.currentScreenIndex = 0;
  wizState.createRestorePoint = true;
  wizState.scanMode = appSettings.defaultScanMode || 'Moderate';
  wizState.leftovers = { files: [], registry: [] };
  wizState.selectedFiles = [];
  wizState.selectedRegistry = [];
  wizState.spaceReclaimedBytes = 0;

  // Set checkbox state in Config screen
  elements.chkCreateRestore.checked = true;
  document.querySelectorAll('.mode-card').forEach(card => {
    card.classList.remove('selected');
    if (card.getAttribute('data-mode') === wizState.scanMode) {
      card.classList.add('selected');
    }
  });

  // UI labels
  elements.wizAppName.textContent = `Uninstalling ${app.name}`;
  elements.wizAppVersion.textContent = `Version ${app.version || 'Unknown'} - ${app.type === 'UWP' ? 'Windows Store app' : 'Desktop program'}`;
  
  // Show first screen
  showScreen(0);
  elements.wizModalOverlay.classList.add('active');
}

function closeUninstallWizard() {
  elements.wizModalOverlay.classList.remove('active');
  selectedApp = null;
  elements.detailsSidebar.classList.remove('active');
  loadApplications(); // Refresh app lists
}

function showScreen(index) {
  wizState.currentScreenIndex = index;
  const screenId = wizState.screens[index];
  
  // Toggle screens
  document.querySelectorAll('.wizard-screen').forEach(scr => scr.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  
  // Manage step indicators
  manageStepIndicators(screenId);

  // Manage buttons visibility
  elements.btnWizCancel.style.display = 'block';
  elements.btnWizBack.style.display = (index > 0 && index !== 1 && index !== 3 && index !== 5 && index !== 6) ? 'block' : 'none'; // Hide back button in loading/complete screens
  elements.btnWizNext.style.display = (index < 4) ? 'block' : 'none';
  elements.btnWizPurge.style.display = (index === 4) ? 'block' : 'none';
  elements.btnWizFinish.style.display = (index === 6) ? 'block' : 'none';

  // Specific screen configuration
  if (screenId === 'scr-native-run') {
    elements.btnWizNext.innerHTML = 'Scan Leftovers <i class="fa-solid fa-magnifying-glass"></i>';
    // If UWP, explain that uninstallation is silent
    if (selectedApp.type === 'UWP') {
      elements.nativeUninstPromptText.textContent = "Windows Store apps are removed without any extra windows or prompts. Click below to remove this one.";
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-bolt"></i> <span>Remove this app</span>';
    } else {
      elements.nativeUninstPromptText.textContent = "Vanish will open the uninstaller that came with this program. Click below, follow the steps on screen, then click Scan Leftovers.";
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-circle-play"></i> <span>Run the program\'s uninstaller</span>';
    }
  } else {
    elements.btnWizNext.innerHTML = 'Next <i class="fa-solid fa-chevron-right" style="font-size: 11px;"></i>';
  }
}

function manageStepIndicators(screenId) {
  // Reset steps classes
  wizState.steps.forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active', 'completed');
  });

  if (screenId === 'scr-config') {
    document.getElementById('step1-progress').classList.add('active');
  } 
  else if (screenId === 'scr-restore-loading') {
    document.getElementById('step1-progress').classList.add('completed');
    document.getElementById('step2-progress').classList.add('active');
  } 
  else if (screenId === 'scr-native-run') {
    document.getElementById('step1-progress').classList.add('completed');
    document.getElementById('step2-progress').classList.add('completed');
    document.getElementById('step3-progress').classList.add('active');
  } 
  else if (screenId === 'scr-scan-loading') {
    document.getElementById('step1-progress').classList.add('completed');
    document.getElementById('step2-progress').classList.add('completed');
    document.getElementById('step3-progress').classList.add('completed');
    document.getElementById('step4-progress').classList.add('active');
  } 
  else if (screenId === 'scr-leftovers-tree') {
    document.getElementById('step1-progress').classList.add('completed');
    document.getElementById('step2-progress').classList.add('completed');
    document.getElementById('step3-progress').classList.add('completed');
    document.getElementById('step4-progress').classList.add('completed');
    document.getElementById('step5-progress').classList.add('active');
  } 
  else if (screenId === 'scr-purge-loading') {
    document.getElementById('step1-progress').classList.add('completed');
    document.getElementById('step2-progress').classList.add('completed');
    document.getElementById('step3-progress').classList.add('completed');
    document.getElementById('step4-progress').classList.add('completed');
    document.getElementById('step5-progress').classList.add('active'); // Still step 5
  }
  else if (screenId === 'scr-complete') {
    wizState.steps.forEach(id => {
      document.getElementById(id).classList.add('completed');
    });
  }
}

// SEC-1: the renderer names the app to uninstall; it never supplies the command.
// If the engine reports the entry as untrusted - registered under HKCU, or with
// its binary somewhere a standard user could have planted it - it refuses until
// the operator types RUN, the same gate the bulk queue uses.
async function runNativeUninstaller(app) {
  const request =
    app.type === 'UWP'
      ? { type: 'UWP', packageFullName: app.packageFullName }
      : { type: 'Desktop', registryPath: app.registryPath };

  let res = await window.api.uninstallNative(request);

  if (res && res.blocked) {
    const reasons = ((res.trust && res.trust.reasons) || []).join('; ');
    const ack = await confirmDialog({
      title: 'This uninstaller cannot be fully trusted',
      body:
        `${app.name} would run with administrator rights, but it is the kind of entry ` +
        `malware can create: ${reasons}.\n\n` +
        'Only continue if you recognise this program. Type RUN to run it anyway.',
      confirmLabel: 'Run it anyway',
      typed: 'RUN'
    });
    if (!ack) {
      return { success: false, declined: true, error: 'Not run: you did not confirm this uninstaller.' };
    }
    res = await window.api.uninstallNative({ ...request, acknowledged: true });
  }

  return res;
}

function setupWizardControls() {
  // Close / Cancel click
  elements.wizCloseX.addEventListener('click', confirmCancel);
  elements.btnWizCancel.addEventListener('click', confirmCancel);
  
  // Back Click
  elements.btnWizBack.addEventListener('click', () => {
    if (wizState.currentScreenIndex > 0) {
      showScreen(wizState.currentScreenIndex - 1);
    }
  });

  // Next Click
  elements.btnWizNext.addEventListener('click', async () => {
    const currentScreen = wizState.screens[wizState.currentScreenIndex];
    
    if (currentScreen === 'scr-config') {
      // Transition from Config to Safety (Restore Point)
      wizState.createRestorePoint = elements.chkCreateRestore.checked;
      
      if (wizState.createRestorePoint && isAdmin) {
        showScreen(1); // Show safety loader
        const res = await window.api.createRestorePoint();
        if (!res.success) {
          toast(`Could not create a restore point: ${res.error}. Continuing - anything removed still goes to quarantine first.`, 'warn', 7000);
        } else if (res.note) {
          toast(res.note, 'info');
        }
        showScreen(2); // Go to native uninstall launcher
      } else {
        // Skip restore point creation
        showScreen(2); // Directly to native uninstall launcher
      }
    } 
    else if (currentScreen === 'scr-native-run') {
      // Transition from Native Uninstall launcher to remnant scanner loader
      showScreen(3); // Show scanner loader
      
      try {
        const result = await window.api.scanLeftovers({
          appName: selectedApp.name,
          publisher: selectedApp.publisher,
          installLocation: selectedApp.installLocation,
          mode: wizState.scanMode
        });
        
        wizState.leftovers = result;
        renderLeftoversTree();
        showScreen(4); // Show tree checklist
      } catch (err) {
        toast(`Could not scan for leftovers: ${err.message}`, 'error');
        showScreen(2);
      }
    }
  });

  // Launch Native Uninstaller click
  elements.btnLaunchNative.addEventListener('click', async () => {
    if (!guardFullMode()) return;
    elements.btnLaunchNative.disabled = true;

    if (selectedApp.type === 'UWP') {
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Removing the app...</span>';
    } else {
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>The uninstaller is running...</span>';
    }

    const res = await runNativeUninstaller(selectedApp);

    elements.btnLaunchNative.disabled = false;
    elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-circle-play"></i> <span>Run the program\'s uninstaller</span>';

    if (selectedApp.type === 'UWP') {
      if (res.success) {
        toast('The app was removed. Now looking for leftovers.', 'success');
      } else {
        toast(`Could not remove the app: ${res.error}. Looking for leftovers anyway.`, 'warn');
      }
      elements.btnWizNext.click();
    } else if (res.success) {
      // The engine now waits for the uninstaller and traps its exit code, so
      // this is a result rather than a "we launched something" guess.
      toast(
        res.rebootRequired
          ? 'The uninstaller finished. Windows needs a restart to complete it. Click Scan Leftovers.'
          : 'The uninstaller finished. Click Scan Leftovers.',
        'success',
        7000
      );
    } else if (res.declined) {
      toast(res.error, 'warn');
    } else {
      toast(`The uninstaller did not finish: ${res.error} You can still scan for leftovers.`, 'warn', 7000);
    }
  });

  // SCR-06 link into the Quarantine Manager.
  const btnReview = document.getElementById('btn-review-quarantine');
  if (btnReview) {
    btnReview.addEventListener('click', () => {
      closeUninstallWizard();
      switchTab('quarantine');
    });
  }

  // Select all checkbox handler
  elements.btnSelectAll.addEventListener('click', () => {
    const checkboxes = elements.leftoversTreeView.querySelectorAll('input[type="checkbox"]');
    const allChecked = Array.from(checkboxes).every(chk => chk.checked);
    checkboxes.forEach(chk => chk.checked = !allChecked);
  });

  // Scan aggressiveness mode cards
  elements.modeCards.forEach(card => {
    card.addEventListener('click', () => {
      elements.modeCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      wizState.scanMode = card.getAttribute('data-mode');
    });
  });

  // FLOW-02: move selected leftovers into the quarantine vault.
  elements.btnWizPurge.addEventListener('click', async () => {
    if (!guardFullMode()) return;

    const checkedBoxes = elements.leftoversTreeView.querySelectorAll('input[type="checkbox"]:checked');
    if (checkedBoxes.length === 0) {
      const finish = await confirmDialog({
        title: 'Nothing selected',
        body: 'You have not ticked any leftovers. Finish without moving anything to quarantine?',
        confirmLabel: 'Finish'
      });
      if (finish) closeUninstallWizard();
      return;
    }

    const filesToPurge = [];
    const registryToPurge = [];
    let estimatedSpaceSaved = 0;

    checkedBoxes.forEach((chk) => {
      const type = chk.getAttribute('data-item-type');
      const path = chk.getAttribute('data-path');
      const sizeBytes = parseInt(chk.getAttribute('data-size') || '0', 10);

      if (type === 'file' || type === 'dir') {
        filesToPurge.push({ path });
        estimatedSpaceSaved += sizeBytes;
      } else if (type === 'registry') {
        registryToPurge.push({ path });
      }
    });

    // The other two purge entry points (single-item quarantine, Force
    // Uninstall) already confirm before acting; this, the most-used path,
    // did not. Quarantine is reversible, but not instantaneous-feeling: the
    // files/keys move out immediately, so whatever depended on them stops
    // working right now, not after some later "actually delete" step.
    const itemCount = filesToPurge.length + registryToPurge.length;
    const purgeOk = await confirmDialog({
      title: `Quarantine ${itemCount} item(s)?`,
      body:
        'These files and registry entries move to quarantine straight away. If anything else on this PC ' +
        'still needs them, it stops working the moment you confirm. You can put them back exactly as they ' +
        'were from the Quarantine tab at any time.',
      confirmLabel: 'Quarantine'
    });
    if (!purgeOk) return;

    wizState.spaceReclaimedBytes = estimatedSpaceSaved;
    showScreen(5);

    try {
      const res = await window.api.purgeRemnants({
        files: filesToPurge,
        registry: registryToPurge,
        sourceApp: selectedApp ? selectedApp.name : 'unknown',
        origin: 'uninstall-wizard'
      });

      renderPurgeSummary(res, filesToPurge.length + registryToPurge.length);
      showScreen(6);
      wizState.lastEntryId = res.entryId || null;
    } catch (err) {
      toast(`Could not move anything to quarantine: ${err.message}`, 'error');
      showScreen(4);
    }
  });

  // Finish Click
  elements.btnWizFinish.addEventListener('click', () => {
    closeUninstallWizard();
  });
}

// SCR-06: quarantine summary. States: success / partial / vault-write-failure.
function renderPurgeSummary(res, requestedCount) {
  const hero = document.getElementById('summary-hero');
  const icon = document.getElementById('summary-icon');
  const title = document.getElementById('summary-title');
  const failuresBox = document.getElementById('summary-failures');
  const failuresList = document.getElementById('summary-failures-list');
  const failuresTitle = document.getElementById('summary-failures-title-text');

  hero.classList.remove('partial', 'failed');

  // NFR-01 messaging: the vault write failed, so nothing was touched.
  if (!res || res.success !== true) {
    hero.classList.add('failed');
    icon.className = 'fa-solid fa-circle-xmark';
    title.textContent = 'Nothing was removed';
    elements.lblPurgeResultText.textContent =
      (res && res.error ? `${res.error} ` : '') +
      'Vanish could not write to the quarantine folder, so everything you selected was left exactly where it is.';
    document.getElementById('lbl-space-saved').textContent = '0 B';
    document.getElementById('lbl-quarantined-count').textContent = '0';
    failuresBox.style.display = 'none';
    document.getElementById('btn-review-quarantine').style.display = 'none';
    return;
  }

  const files = res.files || [];
  const registry = res.registry || [];
  const quarantined = res.quarantinedCount || 0;
  const problems = [...files, ...registry].filter((i) => i.status === 'failed');
  const missing = [...files, ...registry].filter((i) => i.status === 'missing').length;

  // xw2: nothing actually moved is a failure, not a lesser variant of success -
  // "Unknown" (formatBytes(0)'s label for an untracked size) read as if
  // something might have been freed when the true answer is "0, because
  // nothing succeeded". Set this explicitly before the generic formatter runs.
  const fullFailure = quarantined === 0 && problems.length > 0;
  document.getElementById('lbl-space-saved').textContent =
    fullFailure ? '0 B' : formatBytes(wizState.spaceReclaimedBytes, 1);
  document.getElementById('lbl-quarantined-count').textContent = String(quarantined);
  document.getElementById('btn-review-quarantine').style.display = quarantined > 0 ? '' : 'none';

  if (problems.length === 0) {
    icon.className = 'fa-solid fa-box-archive';
    title.textContent = 'Leftovers moved to quarantine';
    elements.lblPurgeResultText.textContent =
      `${quarantined} of the ${requestedCount} item(s) you selected were moved to quarantine. ` +
      'Files were moved, and registry entries were saved to a backup file before removal. ' +
      'Nothing has been deleted - you can put any of it back from the Quarantine tab.' +
      (missing > 0 ? ` ${missing} item(s) were already gone.` : '');
    failuresBox.style.display = 'none';
  } else {
    if (fullFailure) {
      hero.classList.add('failed');
      icon.className = 'fa-solid fa-circle-xmark';
      title.textContent = 'Nothing was moved to quarantine';
      elements.lblPurgeResultText.textContent =
        `All ${problems.length} item(s) you selected failed to move and were left exactly as they were - ` +
        'nothing is half-removed.';
    } else {
      hero.classList.add('partial');
      icon.className = 'fa-solid fa-triangle-exclamation';
      title.textContent = 'Moved to quarantine, with some items left in place';
      elements.lblPurgeResultText.textContent =
        `${quarantined} item(s) moved to quarantine. ${problems.length} could not be moved and were left ` +
        'exactly as they were - nothing is half-removed.';
    }
    failuresTitle.textContent = `Left in place (${problems.length})`;

    // REQ-19: offer the ownership elevator per item, and only for the items
    // that actually failed on permissions. A blanket "take ownership of
    // everything" button is exactly the sledgehammer this rule exists to avoid.
    wizState.failedItems = problems;
    failuresList.innerHTML = problems
      .map((p, index) => {
        const isFile = !!p.originalPath;
        const denied = isAclFailure(p.error);
        const locked = isLockFailure(p.error);
        return `
          <div class="summary-failure-item" data-failure-index="${esc(index)}">
            <div class="path">${esc(p.originalPath || p.keyPath)}</div>
            <div class="reason">${esc(p.error || 'No reason given')}</div>
            <div class="failure-actions">
              ${
                denied && isFile
                  ? `<button class="btn-sec btn-compact" data-elevate="${esc(index)}" data-destructive="true">
                       <i class="fa-solid fa-shield-halved"></i> Take ownership and retry
                     </button>`
                  : ''
              }
              ${
                locked && isFile
                  ? `<button class="btn-sec btn-compact" data-unlock="${esc(index)}">
                       <i class="fa-solid fa-unlock"></i> Find what is holding it
                     </button>`
                  : ''
              }
            </div>
          </div>`;
      })
      .join('');

    failuresList.querySelectorAll('[data-elevate]').forEach((btn) => {
      btn.addEventListener('click', () => elevateAndRetry(parseInt(btn.getAttribute('data-elevate'), 10)));
    });
    failuresList.querySelectorAll('[data-unlock]').forEach((btn) => {
      const item = problems[parseInt(btn.getAttribute('data-unlock'), 10)];
      btn.addEventListener('click', () => openUnlockerFor(item.originalPath));
    });

    failuresBox.style.display = 'block';
  }
}

function isAclFailure(error) {
  return /denied|access|unauthoriz|protected|permission/i.test(String(error || ''));
}

function isLockFailure(error) {
  return /lock|in use|being used|another process/i.test(String(error || ''));
}

// REQ-19: takeown + icacls for ONE item, then retry that one quarantine move.
// Full Mode only, and the manifest records that ownership was changed.
async function elevateAndRetry(index) {
  if (!guardFullMode()) return;
  const item = (wizState.failedItems || [])[index];
  if (!item || !item.originalPath) return;

  const ok = await confirmDialog({
    title: 'Take ownership of this item?',
    body:
      `Vanish will take ownership of "${item.originalPath}", give administrators full control of it, then try ` +
      'moving it to quarantine again. This changes the permissions on that item permanently, even if you ' +
      'restore it later. It applies to this one item only.',
    confirmLabel: 'Take ownership'
  });
  if (!ok) return;

  const res = await window.api.purgeRemnants({
    files: [{ path: item.originalPath }],
    registry: [],
    sourceApp: selectedApp ? selectedApp.name : 'unknown',
    origin: 'ownership-elevator',
    allowOwnershipElevation: true
  });

  const row = (res && res.files && res.files[0]) || null;
  if (res && res.success && row && row.status === 'quarantined') {
    toast(`Ownership taken and the item moved to quarantine${row.aclElevated ? ' (permissions changed)' : ''}.`, 'success', 6000);
    const el = document.querySelector(`[data-failure-index="${index}"]`);
    if (el) {
      el.querySelector('.reason').textContent = 'Moved to quarantine after taking ownership.';
      const actions = el.querySelector('.failure-actions');
      if (actions) actions.remove();
    }
  } else {
    toast(
      `Still could not move it: ${(row && row.error) || (res && res.error) || 'no reason given'}`,
      'error',
      8000
    );
  }
}

async function confirmCancel() {
  if (wizState.currentScreenIndex > 0 && wizState.currentScreenIndex < 6) {
    const ok = await confirmDialog({
      title: 'Cancel this uninstall?',
      body: 'This closes the uninstall wizard. Anything already moved to quarantine stays there, and you can restore it from the Quarantine tab.',
      confirmLabel: 'Cancel uninstall'
    });
    if (!ok) return;
  }
  closeUninstallWizard();
}

// Generate leftovers tree checklist
function renderLeftoversTree() {
  const tree = elements.leftoversTreeView;
  tree.innerHTML = '';
  
  const files = wizState.leftovers.files || [];
  const registry = wizState.leftovers.registry || [];
  
  if (files.length === 0 && registry.length === 0) {
    tree.innerHTML = `
      <div class="empty-leftovers">
        <i class="fa-solid fa-circle-check"></i>
        <h4 style="font-family: var(--font-title); font-weight: 700;">No leftovers found</h4>
        <p style="font-size: 12px; color: var(--text-gray);">This program removed itself cleanly.</p>
      </div>
    `;
    elements.lblLeftoversSummary.textContent = '0 leftovers found';
    return;
  }

  elements.lblLeftoversSummary.textContent = `${files.length + registry.length} leftovers found`;
  
  // 1. Render Filesystem Remnants
  if (files.length > 0) {
    const fileGroup = document.createElement('div');
    fileGroup.className = 'tree-group';
    fileGroup.innerHTML = `
      <div class="tree-group-header">
        <i class="fa-solid fa-folder-open"></i>
        <span>Files and folders (${files.length})</span>
      </div>
    `;
    
    files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'tree-item';
      
      // Auto-check logic: check safe and moderate by default, advanced unchecked
      const checkedAttr = f.risk !== 'Advanced' ? 'checked' : '';
      const riskClass = `risk-${f.risk.toLowerCase()}`;
      
      item.innerHTML = `
        <input type="checkbox" data-item-type="dir" data-path="${esc(f.path)}" data-size="${esc(f.sizeBytes || 0)}" ${checkedAttr}>
        <div class="tree-item-label">
          <span class="mono">${esc(f.path)}</span>
          <div class="tree-item-meta">
            <span class="${esc(riskClass)}">${esc(f.risk)} Risk</span>
            <span style="color: var(--text-muted);">${esc(f.type)}</span>
          </div>
        </div>
      `;
      fileGroup.appendChild(item);
    });
    
    tree.appendChild(fileGroup);
  }
  
  // 2. Render Registry Remnants
  if (registry.length > 0) {
    const regGroup = document.createElement('div');
    regGroup.className = 'tree-group';
    regGroup.innerHTML = `
      <div class="tree-group-header">
        <i class="fa-solid fa-cube"></i>
        <span>Registry entries (${registry.length})</span>
      </div>
    `;
    
    registry.forEach(r => {
      const item = document.createElement('div');
      item.className = 'tree-item';
      
      const checkedAttr = r.risk !== 'Advanced' ? 'checked' : '';
      const riskClass = `risk-${r.risk.toLowerCase()}`;
      
      item.innerHTML = `
        <input type="checkbox" data-item-type="registry" data-path="${esc(r.path)}" ${checkedAttr}>
        <div class="tree-item-label">
          <span class="mono">${esc(r.path)}</span>
          <div class="tree-item-meta">
            <span class="${esc(riskClass)}">${esc(r.risk)} Risk</span>
            <span style="color: var(--text-muted);">${esc(r.type)}</span>
          </div>
        </div>
      `;
      regGroup.appendChild(item);
    });
    
    tree.appendChild(regGroup);
  }
}

// ==========================================
// STAGE 2 - AUDIT & HEALTH ADVISOR UI
// ==========================================

let auditLoaded = false;
// The rows currently on screen, so a click resolves to the item the user was
// actually looking at rather than to whatever the DOM can be re-parsed into.
let startupItems = [];

async function loadAuditData(force = false) {
  if (auditLoaded && !force) return;

  const loadingEl = document.getElementById('audit-loading');
  const contentEl = document.getElementById('audit-content');
  loadingEl.style.display = 'flex';
  contentEl.style.display = 'none';
  auditLoaded = false;

  try {
    // Fire every PowerShell query in parallel. The network read spends most of
    // its time asleep between two counter samples, so running it alongside the
    // others costs the load almost nothing in wall-clock time.
    const [diag, startup, redundancy, network] = await Promise.all([
      window.api.getSystemDiagnostics(),
      window.api.getStartupItems(),
      window.api.getSoftwareRedundancy(),
      window.api.getNetworkActivity()
    ]);

    renderSysInfoCards(diag);
    renderDiskBars(diag.disks || [], diag.disksError);
    renderNetworkActivity(network);
    renderStartupTable(startup);
    renderRedundancyGroups(redundancy);

    auditLoaded = true;
    loadingEl.style.display = 'none';
    contentEl.style.display = 'flex';
  } catch (err) {
    loadingEl.innerHTML = `
      <i class="fa-solid fa-circle-xmark" style="font-size: 28px; color: var(--color-danger);"></i>
      <div style="color: var(--color-danger);">Could not read your system information: ${err.message}</div>
    `;
  }
}

// Attach refresh button
document.addEventListener('DOMContentLoaded', () => {
  const btnRefresh = document.getElementById('btn-refresh-audit');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => loadAuditData(true));
  }
});

function renderSysInfoCards(diag) {
  const grid = document.getElementById('audit-sysinfo-grid');
  if (!grid || !diag) return;

  const uptimeStr = diag.os && diag.os.uptimeHours != null
    ? `${diag.os.uptimeHours}h uptime`
    : '';

  const ramPct  = diag.ram && diag.ram.pctUsed != null ? `${diag.ram.pctUsed}%` : '';
  const ramSub  = diag.ram ? `${diag.ram.usedGB ?? '?'} / ${diag.ram.totalGB ?? '?'} GB used` : '';

  const cpuClockGHz = diag.cpu && diag.cpu.maxClockMHz
    ? `${(diag.cpu.maxClockMHz / 1000).toFixed(2)} GHz`
    : '';
  const cpuSub = diag.cpu ? `${diag.cpu.cores ?? '?'} cores / ${diag.cpu.logicalCores ?? '?'} threads` : '';

  // A machine with switchable graphics has two adapters and both matter. The
  // engine has reported both since the last fix; this card was where the second
  // one disappeared, clipped by a single nowrap line with an ellipsis. Each
  // adapter gets its own line now.
  const gpus = Array.isArray(diag.gpus) && diag.gpus.length
    ? diag.gpus
    : (diag.gpu ? String(diag.gpu).split(' + ') : ['Unknown']);

  const cards = [
    { label: 'Operating System',  value: diag.os?.caption  ?? 'Unknown',    sub: `Build ${diag.os?.build ?? '?'} - ${diag.os?.architecture ?? ''}` },
    { label: 'System Uptime',     value: uptimeStr || 'Unknown',              sub: '' },
    { label: 'CPU',               value: shortenCpuName(diag.cpu?.name),      sub: `${cpuClockGHz} - ${cpuSub}` },
    { label: 'RAM Usage',         value: ramPct || 'Unknown',                 sub: ramSub },
    { label: gpus.length > 1 ? `Graphics (${gpus.length})` : 'Graphics', values: gpus, sub: '' },
    { label: 'Machine',           value: `${diag.manufacturer ?? ''} ${diag.model ?? ''}`.trim() || 'Unknown', sub: '' }
  ];

  // Every value wraps, not just the graphics one: "AMD Ryzen 9 5900HX with Ra..."
  // and "ASUSTeK COMPUTER INC. RO..." were the same defect on the same row,
  // just less obviously wrong than a missing GPU.
  grid.innerHTML = cards.map(c => {
    const lines = (c.values || [c.value])
      .map((v) => `<span class="card-value wrap" title="${esc(v)}">${esc(v)}</span>`)
      .join('');
    return `
    <div class="audit-info-card">
      <span class="card-label">${esc(c.label)}</span>
      ${lines}
      ${c.sub ? `<span class="card-sub">${esc(c.sub)}</span>` : ''}
    </div>`;
  }).join('');
}

function shortenCpuName(name) {
  if (!name) return 'Unknown';
  // Collapse repeated whitespace and strip trailing processor brand noise
  return name.replace(/\s+/g, ' ').replace(/ CPU @.*$/, '').trim();
}

// bfh.1. The output of this section is a VERDICT, not a list of connections.
// hks. A bare connection count reads as a threat number: the operator's own
// words were "one program holding 54 open connections looks worrisome". For
// most of what actually holds dozens of sockets - a browser, a sync client, a
// game launcher - that count is just how the program works, and the useful
// thing to show is what is normal FOR THAT KIND of program.
//
// Deliberately context, never a verdict. This does not score risk, does not
// call anything safe, and does not call anything suspicious - Rule 6 keeps
// this panel out of security/firewall framing, and a "trusted process" list
// would be exactly that framing wearing a friendlier label. Matching is on
// the process name only, entirely local: no lookup, no reverse-DNS, no
// outbound I/O of any kind (INV-4).
const NET_PROGRAM_KINDS = [
  {
    kind: 'a web browser',
    test: /^(chrome|firefox|msedge|brave|opera|opera_gx|vivaldi|chromium|iexplore|arc|librewolf|waterfox|tor)$/,
    normal: 'Browsers open a separate connection per tab, per ad, per tracker and per background sync, so dozens at once is ordinary even when you are only reading one page.'
  },
  {
    kind: 'a file-sync program',
    test: /^(onedrive|dropbox|googledrivefs|googledrivesync|box|boxdrive|megasync|nextcloud|owncloud|icloud|pcloud|sync|resilio|syncthing)$/,
    normal: 'Sync clients keep several connections open at once so uploads, downloads and change-notifications do not queue behind each other.'
  },
  {
    kind: 'a game launcher or store',
    test: /^(steam|steamwebhelper|epicgameslauncher|epicwebhelper|battle\.net|agent|galaxyclient|galaxy|origin|eadesktop|easteamproxy|ubisoftconnect|upc|riotclient|riotclientservices|playnite)$/,
    normal: 'Launchers keep a store page, a friends/chat service, a download manager and an update checker connected at the same time, and content downloads often use many parallel connections on purpose.'
  },
  {
    kind: 'a chat or meeting program',
    test: /^(teams|ms-teams|slack|discord|zoom|skype|telegram|whatsapp|signal|element|webexmta|webex)$/,
    normal: 'Chat and meeting apps hold a live connection for messages plus separate ones for presence, media and file transfers.'
  },
  {
    kind: 'security software',
    test: /^(avp|avpui|kavfs|msmpeng|mpdefendercoreservice|nissrv|avgui|avgsvc|avastui|afwserv|mbam|mbamservice|nortonsecurity|ns|mcshield|masvc|sentinelagent|csfalconservice|csfalconcontainer|bdagent|vsserv|ekrn|egui)$/,
    normal: 'Security software checks files and pages against its vendor\'s cloud service, which means many short-lived connections while it is scanning.'
  },
  {
    kind: 'an updater or download service',
    test: /^(svchost|googleupdate|goog(le)?updater|msedgeupdate|microsoftedgeupdate|adobearmsvc|adobeupdateservice|squirrel|update|updater|wuauclt|usocoreworker|deliveryoptimization|dosvc)$/,
    normal: 'Update and delivery services fetch from several servers at once, and Windows itself shares parts of an update between machines, so the count moves around a lot.'
  },
  {
    kind: 'a developer tool',
    test: /^(code|code - insiders|node|npm|claude|python|pythonw|docker|dockerd|com\.docker\.backend|git|ssh|java|javaw|devenv|rider64|idea64|pycharm64|wsl|wslservice)$/,
    normal: 'Developer tools talk to package registries, language servers, containers and remote APIs at the same time, often several per project you have open.'
  },
  {
    kind: 'a media or streaming app',
    test: /^(spotify|itunes|applemusic|vlc|plex|plexmediaserver|netflix|obs64|obs|steamstreaming)$/,
    normal: 'Streaming apps hold a media connection plus separate ones for artwork, recommendations and playback reporting.'
  },
  {
    kind: 'part of Windows',
    test: /^(system|lsass|services|spoolsv|searchindexer|searchapp|explorer|taskhostw|backgroundtaskhost|runtimebroker|smartscreen|settingssynchost|wsappx|startmenuexperiencehost)$/,
    normal: 'Windows components fetch content, licences, time and telemetry-free service data on their own schedule, independent of anything you opened.'
  }
];

// The count at which a bare number starts reading as alarming rather than
// incidental. Below this the tooltip still explains the program, but nothing
// visible is added to the row - the number speaks for itself.
const NET_NOTABLE_CONNECTION_COUNT = 10;

function classifyNetProgram(name) {
  const key = String(name || '').toLowerCase().replace(/\.exe$/, '').trim();
  return NET_PROGRAM_KINDS.find((k) => k.test.test(key)) || null;
}

// The tooltip text for one row's connection count. Always says what was
// counted; adds the per-kind reassurance when the program is recognised, and
// says plainly that it does not recognise the program when it does not -
// rather than implying the unrecognised case is the suspicious one.
function netConnectionTitle(name, count) {
  const kind = classifyNetProgram(name);
  const counted = `${count} connection${count === 1 ? '' : 's'} open right now. This is a count of connections, not of bandwidth used.`;
  if (kind) return `${counted}\n\n${name} is ${kind.kind}. ${kind.normal}`;
  return (
    `${counted}\n\nVanish does not have a description for this program, which says nothing either way about it - ` +
    'most programs that talk to the internet keep several connections open. Expand the row to see the addresses it is connected to.'
  );
}

// "Nothing on this PC is using the network" is a first-class answer here, not
// an empty state - it is the answer that tells someone to stop looking at their
// PC and go look at their router.
//
// The one thing this must never do is imply a per-program byte rate. Windows
// does not attribute bytes to a process without an ETW kernel trace, so any
// per-app "12 Mbps" on this screen would be invented. It reports connections
// held, and says so.
function renderNetworkActivity(net) {
  const body = document.getElementById('audit-network-body');
  const badge = document.getElementById('audit-network-badge');
  if (!body) return;

  if (!net || net.success !== true || net.verdict === 'unreadable') {
    if (badge) badge.style.display = 'none';
    body.innerHTML = `<div class="panel-state error" style="padding: 12px 0;">
      <i class="fa-solid fa-circle-xmark"></i>
      <div>Could not read the network adapters on this PC${net && net.error ? `: ${esc(net.error)}` : '.'}</div>
    </div>`;
    wireNetworkRefresh();
    return;
  }

  // formatBytes(0) returns 'Unknown' (its convention for an untracked size,
  // see xw2) - wrong here, where 0 is a confirmed reading, not a missing one.
  const rate = (bytesPerSecond) => {
    const b = bytesPerSecond || 0;
    return b === 0 ? '0 B/s' : `${formatBytes(b, 1)}/s`;
  };
  const gateway = (net.adapters || []).filter((a) => a.hasGateway);
  const primary = gateway.length ? gateway[0] : (net.adapters || [])[0];
  const processes = net.processes || [];
  const top = processes.slice(0, 6);

  // h8j: the byte-rate sample is short (sampleMs, default 1s) and can land in
  // a quiet gap of genuinely bursty traffic - "the rate was low right now" and
  // "nothing is using the network" are different claims, and conflating them
  // is exactly what an operator with real open connections during a quiet
  // sample caught. A low rate with open connections gets its own, more
  // honestly-hedged wording instead of reusing the true-idle verdict.
  const sampleSeconds = (net.sampleMs || 1000) / 1000;
  const quietWithConnections = processes.length > 0;

  const verdicts = {
    busy: {
      icon: 'fa-arrows-up-down',
      cls: 'is-busy',
      title: 'Something on this PC is using the network',
      detail:
        `The connection carried ${rate(net.totalBytesPerSecond)} while this was measured. ` +
        (top.length
          ? `${top.length === 1 ? 'One program has' : `${top.length} programs have`} connections open right now.`
          : 'No program held an open connection, so this is Windows itself.')
    },
    quiet: quietWithConnections
      ? {
          icon: 'fa-circle-check',
          cls: 'is-quiet',
          title: 'Low traffic in this sample - not necessarily idle',
          detail:
            `The connection carried ${rate(net.totalBytesPerSecond)} during a ${sampleSeconds}s sample, but ` +
            `${processes.length === 1 ? '1 program has' : `${processes.length} programs have`} a connection open right ` +
            'now. A short sample can land in a quiet gap of bursty traffic, so a low reading here does not mean ' +
            'nothing is using the network - only that little moved in that instant.'
        }
      : {
          icon: 'fa-circle-check',
          cls: 'is-quiet',
          title: 'Nothing on this PC is using the network',
          detail:
            `The connection carried ${rate(net.totalBytesPerSecond)} while this was measured, and no program held an ` +
            'open connection. If something still feels slow, the cause is not on this PC - it is the router or the ' +
            'connection beyond it, and nothing Vanish can change here will help.'
        },
    'link-weak': {
      icon: 'fa-triangle-exclamation',
      cls: 'is-weak',
      title: 'The Wi-Fi signal is the limit here',
      detail:
        `The signal is at ${net.signalPercent}%. At this strength the link itself is the constraint, so closing ` +
        'programs will not make much difference. Moving closer to the access point, or using a cable, will.'
    }
  };

  const v = verdicts[net.verdict] || verdicts.quiet;

  // Operator report: "network activity doesnt show upload, download speeds."
  // scanner.ps1 has always computed receiveBytesPerSecond/sendBytesPerSecond
  // per adapter (they already drive the busy/quiet verdict) - only the split
  // figures themselves were never displayed. No new engine capability, no
  // new network I/O, just surfacing a number already in the response.
  // anc: these two were a fragment of text inside the "Looked at:" line. They
  // are the two numbers most people come to this panel for, so they get their
  // own tiles. Ping is deliberately absent - see bd kp0, still an open
  // decision, and this was built so it does not depend on that outcome.
  //
  // The tiles show the adapter carrying the default route. Deliberately NOT
  // expressed as a percentage of link speed: linkSpeedBps is the negotiated
  // rate to the router, not the speed of the internet connection behind it,
  // and "0.4% used" against the wrong denominator is a confident wrong answer.
  const rateTiles = primary
    ? `<div class="net-rate-tiles">
         <div class="net-rate-tile">
           <i class="fa-solid fa-arrow-down net-rate-icon is-down"></i>
           <div class="net-rate-text">
             <div class="net-rate-value">${esc(rate(primary.receiveBytesPerSecond))}</div>
             <div class="net-rate-label">Download</div>
           </div>
         </div>
         <div class="net-rate-tile">
           <i class="fa-solid fa-arrow-up net-rate-icon is-up"></i>
           <div class="net-rate-text">
             <div class="net-rate-value">${esc(rate(primary.sendBytesPerSecond))}</div>
             <div class="net-rate-label">Upload</div>
           </div>
         </div>
         <div class="net-rate-tile is-meta">
           <i class="fa-solid fa-ethernet net-rate-icon"></i>
           <div class="net-rate-text">
             <div class="net-rate-value">${esc(primary.name)}</div>
             <div class="net-rate-label">${primary.isWireless ? 'Wi-Fi' : 'Wired'}${
               net.signalPercent != null ? ` &middot; signal ${esc(net.signalPercent)}%` : ''
             }</div>
           </div>
         </div>
       </div>`
    : '';

  const examined = [
    // anc: adapter name and the up/down rates moved into the tiles above -
    // repeating them here would just be the old inline text back again.
    `${processes.length} program(s) with a connection open`,
    net.updateTransfers != null
      ? `Windows Update: ${net.updateTransfers === 0 ? 'not downloading' : `${net.updateTransfers} download(s) running`}`
      : null,
    net.bitsJobs != null
      ? `background transfers: ${net.bitsJobs === 0 ? 'none' : net.bitsJobs}`
      : 'background transfers: needs administrator to see every account'
  ].filter(Boolean);

  const signalLine =
    net.signalNote === 'needs-location-permission'
      ? 'Wi-Fi signal strength was not read: Windows keeps it behind the Location privacy setting.'
      : net.signalNote === 'needs-elevation'
        ? 'Wi-Fi signal strength was not read: Windows only reports it to an administrator.'
        : null;

  // Operator report: "are we able to enumerate the connections open and
  // places connected to... would that help decide if risky." The IPs were
  // always collected (scanner.ps1); this makes "places connected to" a real,
  // checkable list instead of just a count, without a port (kept stripped -
  // see the comment where scanner.ps1 collects it) or any DNS lookup (would
  // be outbound network I/O, which this panel is tested to never do).
  const rows = top
    .map((p, i) => {
      const peers = Array.isArray(p.peers) ? p.peers : [];
      const rowId = `net-peers-${i}`;
      // hks: a high count is where the reassurance has to be VISIBLE, not
      // only on hover - the whole complaint was that the bare number reads
      // as worrying on sight. Below the threshold the tooltip still carries
      // the same context for anyone who goes looking.
      const kind = classifyNetProgram(p.name);
      const countLabel =
        kind && p.connectionCount >= NET_NOTABLE_CONNECTION_COUNT
          ? `${esc(p.connectionCount)} <span class="net-kind-note">normal for ${esc(kind.kind)}</span>`
          : esc(p.connectionCount);
      return `
      <tr class="app-row${peers.length ? ' net-row-expandable' : ''}" ${peers.length ? `data-peers-toggle="${rowId}"` : ''}>
        <td style="font-size: 12px; font-weight: 600; color: var(--text-white);">${esc(p.name)}</td>
        <td style="font-size: 12px; color: var(--text-gray);">${esc(p.processId)}</td>
        <td style="font-size: 12px; color: var(--text-gray);" title="${esc(netConnectionTitle(p.name, p.connectionCount))}">${countLabel}</td>
        <td style="font-size: 12px; color: var(--text-gray);">
          ${esc(p.peerCount)}${peers.length ? ' <i class="fa-solid fa-chevron-right net-peers-chevron"></i>' : ''}
        </td>
      </tr>
      ${peers.length ? `
      <tr class="net-peers-row" id="${rowId}" style="display: none;">
        <td colspan="4">
          <div class="net-peers-list">${peers.map((ip) => `<span class="net-peer-pill">${esc(ip)}</span>`).join('')}</div>
        </td>
      </tr>` : ''}`;
    })
    .join('');

  body.innerHTML = `
    <div class="net-verdict ${v.cls}">
      <div class="net-verdict-icon"><i class="fa-solid ${v.icon}"></i></div>
      <div class="net-verdict-main">
        <div class="net-verdict-title">${esc(v.title)}</div>
        <div class="net-verdict-detail">${esc(v.detail)}</div>
      </div>
      <button class="btn-sec btn-compact" id="btn-network-refresh">
        <i class="fa-solid fa-rotate-right"></i> Measure again
      </button>
    </div>

    ${rateTiles}

    <div class="panel-inline-note">Looked at: ${examined.map(esc).join(' &middot; ')}${signalLine ? ` &middot; ${esc(signalLine)}` : ''}</div>

    <div id="network-hold-row"></div>

    ${
      top.length
        ? `<div style="overflow-x: auto;">
             <table class="apps-table">
               <thead>
                 <tr>
                   <th style="width: 40%;">Program</th>
                   <th style="width: 15%;">ID</th>
                   <th style="width: 22%;">Connections open</th>
                   <th style="width: 23%;">Places connected to</th>
                 </tr>
               </thead>
               <tbody>${rows}</tbody>
             </table>
           </div>
           <div class="panel-inline-note">Windows does not tell any program how many bytes each other program used
             without a kernel-level trace, so this is what each one has open - not a share of the speed.</div>`
        : ''
    }`;

  if (badge) {
    badge.style.display = 'inline-flex';
    badge.textContent = net.verdict === 'busy' ? 'in use' : net.verdict === 'link-weak' ? 'weak signal' : 'idle';
    badge.className = net.verdict === 'busy' ? 'audit-badge' : 'audit-badge';
  }

  wireNetworkRefresh();
  wireNetworkPeerToggles();
  renderNetworkHold();
}

function wireNetworkPeerToggles() {
  document.querySelectorAll('[data-peers-toggle]').forEach((row) => {
    row.addEventListener('click', () => {
      const target = document.getElementById(row.getAttribute('data-peers-toggle'));
      if (!target) return;
      const showing = target.style.display !== 'none';
      target.style.display = showing ? 'none' : 'table-row';
      row.classList.toggle('is-expanded', !showing);
    });
  });
}

// bfh.2. A hold changes a machine-wide Windows policy and pauses other
// people's transfers, so while it is on it must be impossible to miss - the
// failure mode of a quiet background toggle is a user who never gets another
// Windows update and has no idea why.
async function renderNetworkHold() {
  const row = document.getElementById('network-hold-row');
  if (!row) return;

  let state = null;
  try {
    state = await window.api.networkHoldState();
  } catch {
    return;
  }

  if (state && state.active) {
    const heldJobsList = (state.record && state.record.bitsJobs) || [];
    const heldJobs = heldJobsList.length;
    const since = state.record && state.record.startedAt
      ? new Date(state.record.startedAt).toLocaleTimeString()
      : null;

    // Operator report: the hold worked, but nothing named what it actually
    // held - "N background transfer(s)" is a number with nothing to check it
    // against. Each captured job already carries a displayName (scanner.ps1
    // network-hold-capture); a PID-level list isn't possible (BITS jobs
    // aren't reliably tied to one live process), but naming the transfers
    // themselves is the concrete, checkable version of the same idea.
    const jobList = heldJobs > 0
      ? `<ul class="net-hold-jobs">${heldJobsList.map((j) => `<li>${esc(j.displayName || j.jobId)}</li>`).join('')}</ul>`
      : '';

    row.innerHTML = `
      <div class="net-hold is-on">
        <div class="net-hold-main">
          <div class="net-hold-title"><i class="fa-solid fa-pause"></i> Background transfers are being held</div>
          <div class="net-hold-detail">
            Windows Update's background downloads are capped and
            ${heldJobs === 0 ? 'no other transfer was running to pause' : `${heldJobs} background transfer(s) are paused`}${since ? `, since ${esc(since)}` : ''}.
            Releasing puts every setting back exactly as it was. Vanish also releases it by itself if it is closed or crashes.
          </div>
          ${jobList}
        </div>
        <button class="btn-primary btn-compact" id="btn-network-release" data-destructive="true">
          <i class="fa-solid fa-play"></i> Release
        </button>
      </div>`;
  } else {
    row.innerHTML = `
      <div class="net-hold">
        <div class="net-hold-main">
          <div class="net-hold-title">Hold background transfers</div>
          <div class="net-hold-detail">
            Caps Windows Update's background downloading and pauses background transfers that are running, until you
            release it. It cannot give a program more speed - it only stops other things taking it - and it does
            nothing about traffic from other devices on your network.
          </div>
        </div>
        <button class="btn-sec btn-compact" id="btn-network-hold" data-destructive="true">
          <i class="fa-solid fa-pause"></i> Hold
        </button>
      </div>`;
  }

  const hold = document.getElementById('btn-network-hold');
  if (hold) hold.addEventListener('click', () => applyNetworkHold());
  const release = document.getElementById('btn-network-release');
  if (release) release.addEventListener('click', () => releaseNetworkHold());

  applyTierLocks();
}

async function applyNetworkHold() {
  if (!guardFullMode()) return;

  const ok = await confirmDialog({
    title: 'Hold background transfers?',
    body:
      "Windows Update's background downloads are capped, and background transfers that are running now are paused. " +
      'Nothing is uninstalled and nothing is deleted. Every setting is written down before it is changed, so releasing ' +
      'puts it all back - and Vanish releases it automatically if it closes or crashes while the hold is on.',
    confirmLabel: 'Hold them'
  });
  if (!ok) return;

  const res = await window.api.networkHoldApply();
  if (!res || res.success !== true) {
    toast(`Nothing was held: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
    await renderNetworkHold();
    return;
  }

  toast(
    `Background transfers held. ${res.appliedCount} setting(s) changed, and every one of them is recorded so it can be put back.`,
    'success',
    6000
  );
  await renderNetworkHold();
}

async function releaseNetworkHold() {
  if (!guardFullMode()) return;

  const res = await window.api.networkHoldRevert();
  if (!res || res.success !== true) {
    // A partial release keeps its record on disk on purpose, so this is
    // recoverable rather than stranded - say so instead of just failing.
    toast(
      `Some settings could not be put back: ${(res && res.error) || 'no reason given'}. Vanish still has the record and will try again next time it starts.`,
      'error',
      10000
    );
    await renderNetworkHold();
    return;
  }

  toast('Background transfers released. Every setting is back where it was.', 'success', 5000);
  await renderNetworkHold();
}

function wireNetworkRefresh() {
  const btn = document.getElementById('btn-network-refresh');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const badge = document.getElementById('audit-network-badge');
    if (badge) {
      badge.style.display = 'inline-flex';
      badge.textContent = 'measuring';
    }
    btn.disabled = true;
    // Only this section re-samples. Re-running the whole Health Advisor to
    // answer one question is the pattern 7oo.5 was about.
    const net = await window.api.getNetworkActivity();
    renderNetworkActivity(net);
  });
}

// Operator-proposed throttle: "put that on a manual refresh only... or an
// interval based refresh we could set in settings." Off (0) by default -
// today's manual-only "Measure again" behaviour is unchanged unless a
// person opts in from Settings. Only runs while the Health Advisor tab is
// actually visible (switchTab starts/stops it), same lifecycle as the Task
// Manager sampler.
let networkRefreshTimer = null;

function startNetworkAutoRefresh() {
  stopNetworkAutoRefresh();
  const seconds = appSettings.networkRefreshSeconds || 0;
  if (seconds <= 0) return;
  networkRefreshTimer = setInterval(async () => {
    const net = await window.api.getNetworkActivity();
    renderNetworkActivity(net);
  }, seconds * 1000);
}

function stopNetworkAutoRefresh() {
  if (networkRefreshTimer) {
    clearInterval(networkRefreshTimer);
    networkRefreshTimer = null;
  }
}

function renderDiskBars(disks, error) {
  const list = document.getElementById('audit-disk-list');
  if (!list) return;

  // "No local drives found" is a claim about the machine. If the query failed,
  // say that instead - a broken query rendered as an empty result is what let
  // this section ship dead (7oo.8).
  if (error) {
    list.innerHTML = `<div class="panel-state error" style="padding: 12px 0;">
      <i class="fa-solid fa-circle-xmark"></i>
      <div>Could not read the drives on this PC: ${esc(error)}</div>
    </div>`;
    return;
  }

  if (!disks || disks.length === 0) {
    list.innerHTML = '<div style="color: var(--text-gray); font-size: 13px;">No local drives found.</div>';
    return;
  }

  list.innerHTML = disks.map(d => {
    const pct = d.pctUsed ?? 0;
    const fillClass = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
    return `
      <div class="disk-bar-row">
        <div class="disk-bar-header">
          <span class="disk-bar-drive">${esc(d.drive)}:\ &nbsp;<span style="font-weight:400; font-size:12px; color:var(--text-gray);">${esc(d.label)}</span></span>
          <span class="disk-bar-stats">${d.usedGB} GB used of ${d.totalGB} GB &nbsp;-&nbsp; ${d.freeGB} GB free &nbsp;-&nbsp; ${pct}% full</span>
        </div>
        <div class="disk-bar-track">
          <div class="disk-bar-fill ${fillClass}" style="width: ${pct}%;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderStartupTable(startup) {
  const tbody      = document.getElementById('audit-startup-tbody');
  const countBadge = document.getElementById('audit-startup-count');
  const orphanBadge= document.getElementById('audit-orphan-count');
  if (!tbody) return;

  const items   = startup.items   ?? [];
  const total   = startup.total   ?? items.length;
  const orphans = startup.orphans ?? 0;

  if (countBadge)  countBadge.textContent  = total;
  if (orphanBadge) {
    orphanBadge.textContent = `${orphans} broken`;
    orphanBadge.style.display = orphans > 0 ? 'inline-flex' : 'none';
  }

  // 7oo.11: this surface acts now, and what it does is reversible. The note
  // says which, because the difference between "removed" and "removed, and
  // here is how to undo it" is the whole basis for clicking the button.
  const noteEl = document.getElementById('audit-startup-note');
  if (noteEl) {
    noteEl.textContent = startup.detectionNote ||
      'Every change here is saved to quarantine first, so it can be put back.';
  }

  // Keep the rows so the click handlers can find their item by index rather
  // than re-deriving it from the DOM.
  startupItems = items;

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center; padding:24px; color:var(--text-gray); font-size:13px;">
          <i class="fa-solid fa-circle-check" style="color:var(--color-success); margin-right:6px;"></i>Nothing extra starts with Windows on this PC.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map((item, index) => {
    const sourceClass = item.source === 'Registry' ? 'registry'
                      : item.source === 'TaskScheduler' ? 'task'
                      : 'service';
    const sourceLabel = item.source === 'TaskScheduler' ? 'Task' : item.source;

    const dotClass = item.exeExists === false ? 'orphan'
                   : item.enabled ? 'active'
                   : 'passive';
    const statusLabel = item.exeExists === false ? 'Broken'
                      : item.enabled ? 'Active'
                      : 'Inactive';

    const cmdShort = (item.command || '').length > 80
      ? (item.command || '').slice(0, 80) + '...'
      : (item.command || '-');

    // An orphan the user is told about but given nothing to do with is the
    // defect this fixes. Every orphaned row now carries the concrete place its
    // own kind of entry is managed.
    const suggestionRow = item.exeExists === false && item.suggestion
      ? `<tr class="startup-suggestion-row">
           <td colspan="5">
             <div class="startup-suggestion">
               <i class="fa-solid fa-lightbulb"></i>
               <div>
                 <div><strong>The program at ${esc(item.exePath || 'this location')} is gone, so this entry does nothing every time Windows starts.</strong></div>
                 <div>${esc(item.suggestion)}</div>
               </div>
             </div>
           </td>
         </tr>`
      : '';

    // The label changes with the row's own state: a disabled task offers to be
    // enabled again, which is what makes disabling it safe to try.
    const actionLabel = item.action === 'task-disable'
      ? (item.enabled ? 'Disable' : 'Enable')
      : item.actionLabel || 'Turn off';

    const actionCell = item.action
      ? `<button class="btn-sec btn-compact startup-action-btn" data-startup-index="${index}"
                 data-destructive="true"
                 title="${esc(item.suggestion || '')}">${esc(actionLabel)}</button>`
      : `<span style="font-size:11.5px; color: var(--text-muted);">Managed by Windows</span>`;

    return `
      <tr class="app-row${item.exeExists === false ? ' is-orphan' : ''}">
        <td style="font-size: 12px; font-weight: 600; color: var(--text-white);">${esc(item.name)}</td>
        <td><span class="source-badge ${esc(sourceClass)}">${esc(sourceLabel)}</span></td>
        <td>
          <span class="status-dot ${esc(dotClass)}"></span>
          <span style="font-size:12px; color: var(--text-gray);">${statusLabel}</span>
        </td>
        <td class="mono" style="color: var(--text-muted); word-break: break-all;" title="${esc(item.command || '')}">${esc(cmdShort)}</td>
        <td style="text-align: right; white-space: nowrap;">${actionCell}</td>
      </tr>
      ${suggestionRow}
    `;
  }).join('');

  tbody.querySelectorAll('.startup-action-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      runStartupAction(parseInt(btn.getAttribute('data-startup-index'), 10))
    );
  });

  // Audit Mode leaves these visible and inert with the reason, like every other
  // destructive control in the app (REQ-04).
  applyTierLocks();
}

// 7oo.11. Three actions, one confirmation shape: say what will change, say
// where the undo lives, then do it and report the result on the row.
async function runStartupAction(index) {
  const item = startupItems[index];
  if (!item || !item.action) return;
  if (!guardFullMode()) return;

  const isTask = item.action === 'task-disable';
  const enabling = isTask && !item.enabled;

  let title;
  let body;
  if (isTask) {
    title = enabling ? `Enable "${item.name}"?` : `Disable "${item.name}"?`;
    body = enabling
      ? 'The task runs at logon again. Nothing else about it changes.'
      : 'The task stays on this PC but stops running at logon. This same button turns it back on.';
  } else if (item.action === 'service-manual') {
    title = `Stop "${item.name}" starting with Windows?`;
    body =
      'The service is set to start only when something asks for it, instead of at every boot. It is not ' +
      'removed, and it can still run. Its settings are saved to the Quarantine tab first, so the change ' +
      'can be undone from there.';
  } else {
    title = `Remove "${item.name}" from startup?`;
    body =
      'This entry stops running when Windows starts. The program itself is not touched or uninstalled. ' +
      'The startup settings are saved to the Quarantine tab first, so you can put this back.';
  }

  const ok = await confirmDialog({ title, body, confirmLabel: isTask ? (enabling ? 'Enable' : 'Disable') : 'Do it' });
  if (!ok) return;

  const res = await window.api.startupAction({
    action: item.action,
    item,
    enable: enabling
  });

  if (!res || res.success !== true) {
    toast(`Nothing changed: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
    return;
  }

  toast(
    isTask
      ? `"${item.name}" is now ${enabling ? 'enabled' : 'disabled'}.`
      : `"${item.name}" no longer starts with Windows. You can put it back from the Quarantine tab.`,
    'success',
    6000
  );

  // The change is ours, so the result is not in doubt - but a startup list is
  // cheap to re-read and this keeps the row's state honest rather than guessed.
  await loadAuditData(true);
}

// Operator: "redundant software should offer a button that leads to a
// decision making workflow... a waive-off button... it still shows up in
// that section, but with the notice that the user overrode it, still
// offering the decision making buttonflow." Example given: different
// browsers for different needs is a deliberate choice, not an oversight -
// waiving records that choice without hiding the suggestion or losing the
// ability to act on it later.
function renderRedundancyGroups(redundancy) {
  const list = document.getElementById('audit-redundancy-list');
  const countBadge = document.getElementById('audit-redundancy-count');
  const waivedBadge = document.getElementById('audit-redundancy-waived-count');
  if (!list) return;

  const groups = redundancy.groups ?? [];
  const waived = new Set(appSettings.redundancyWaivers || []);
  const waivedCount = groups.filter((g) => waived.has(g.category)).length;

  // Same count/sub-count pill pattern as Startup Items' "N broken" badge -
  // operator: "discounts it while showing the discount on the header pill,
  // like how broken from startup shows up." The primary badge is what still
  // needs a look (waived groups excluded, i.e. discounted out of it); the
  // second badge accounts for the difference instead of hiding it.
  if (countBadge) {
    const active = groups.length - waivedCount;
    countBadge.textContent = active;
    countBadge.style.display = active > 0 ? 'inline-flex' : 'none';
  }
  if (waivedBadge) {
    waivedBadge.textContent = `${waivedCount} waived`;
    waivedBadge.style.display = waivedCount > 0 ? 'inline-flex' : 'none';
  }

  if (groups.length === 0) {
    list.innerHTML = `
      <div class="audit-ok-box">
        <i class="fa-solid fa-circle-check"></i>
        No programs here appear to overlap with each other.
      </div>
    `;
    return;
  }

  list.innerHTML = groups.map(g => {
    const isWaived = waived.has(g.category);
    const rows = (g.apps ?? []).map(a => `
      <div class="redundancy-app-row">
        <span class="redundancy-pill">${esc(a.name)}</span>
        <button class="btn-sec btn-compact redundancy-uninstall-btn" data-app-id="${esc(a.id)}">
          <i class="fa-solid fa-magnifying-glass"></i> Review to uninstall
        </button>
      </div>`
    ).join('');
    return `
      <div class="redundancy-group${isWaived ? ' is-waived' : ''}">
        <div class="redundancy-group-header">
          <span class="redundancy-category"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>${esc(g.category)}</span>
          <span class="audit-badge${isWaived ? '' : ' danger'}">${esc(g.count)} installed</span>
        </div>
        <div class="redundancy-tip">${esc(g.tip)}</div>
        ${isWaived
          ? `<div class="redundancy-override-notice"><i class="fa-solid fa-circle-check"></i> You chose to keep all of these - Vanish will keep showing this group, but will not flag it as unusual.</div>`
          : ''
        }
        <div class="redundancy-app-pills">${rows}</div>
        <div class="redundancy-actions">
          <button class="btn-sec btn-compact" data-waive-toggle="${esc(g.category)}">
            <i class="fa-solid ${isWaived ? 'fa-rotate-left' : 'fa-circle-check'}"></i> ${isWaived ? 'Undo, flag this again' : 'Keep all of these'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  wireRedundancyActions();
}

function wireRedundancyActions() {
  document.querySelectorAll('.redundancy-uninstall-btn').forEach((btn) => {
    btn.addEventListener('click', () => jumpToUninstall(btn.getAttribute('data-app-id')));
  });
  document.querySelectorAll('[data-waive-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleRedundancyWaiver(btn.getAttribute('data-waive-toggle')));
  });
}

// Jumps to the exact same entry point a person clicking the app in All
// Programs would reach (selectApp -> the details sidebar's own Clean
// Uninstall button) rather than opening a second, parallel uninstall path.
// Stops short of opening the wizard directly - the redundancy group's app
// object is a collapsed "family" summary (Get-SoftwareRedundancy), not
// necessarily the exact live registry row, so the details panel is where
// that gets confirmed before anything destructive is offered.
function jumpToUninstall(appId) {
  const app = allApps.find((a) => a.id === appId);
  if (!app) {
    toast('That program is no longer on the list - try re-scanning.', 'warn');
    return;
  }
  switchTab('all-apps');
  clearAppFilters();
  selectApp(app, null);
  filterAndRenderApps();
  const row = elements.appsTbody.querySelector('tr.selected');
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function toggleRedundancyWaiver(category) {
  const current = new Set(appSettings.redundancyWaivers || []);
  if (current.has(category)) current.delete(category);
  else current.add(category);
  await saveSettings({ redundancyWaivers: [...current] });
  // Only the override state changed - re-running the whole Health Advisor
  // load (system diagnostics, startup items, AND the network read with its
  // built-in ~1s sample sleep) to redraw one section's badges would be pure
  // waiting. Re-fetch just the redundancy groups and redraw only that list.
  const redundancy = await window.api.getSoftwareRedundancy();
  renderRedundancyGroups(redundancy);
}

// ==========================================
// SCR-02 / FLOW-03 - QUARANTINE MANAGER (REQ-03)
// ==========================================

let vaultEntries = [];
let vaultRootPath = '';

function setupQuarantineTab() {
  document.getElementById('btn-refresh-vault').addEventListener('click', () => loadVaultEntries());

  document.getElementById('btn-open-vault-folder').addEventListener('click', () => {
    window.api.openVaultFolder();
  });

  const autoPurgeToggle = document.getElementById('chk-auto-purge');
  const retentionInput = document.getElementById('inp-retention-days');

  autoPurgeToggle.addEventListener('change', async () => {
    if (autoPurgeToggle.checked) {
      const ok = await confirmDialog({
        title: 'Enable automatic purge?',
        body:
          `Anything in quarantine older than ${retentionInput.value} day(s) will be deleted permanently ` +
          'each time Vanish starts, with no further prompt. This is the only setting that lets Vanish ' +
          'destroy something you did not click that day.',
        confirmLabel: 'Enable'
      });
      if (!ok) {
        autoPurgeToggle.checked = false;
        return;
      }
    }
    appSettings = await window.api.setSettings({
      autoPurgeEnabled: autoPurgeToggle.checked,
      autoPurgeRetentionDays: parseInt(retentionInput.value, 10)
    });
    toast(
      appSettings.autoPurgeEnabled
        ? `Automatic purge is on. Items are deleted after ${appSettings.autoPurgeRetentionDays} days.`
        : 'Automatic purge is off. Nothing leaves quarantine unless you delete it.',
      'success'
    );
  });

  retentionInput.addEventListener('change', async () => {
    appSettings = await window.api.setSettings({
      autoPurgeRetentionDays: parseInt(retentionInput.value, 10)
    });
    retentionInput.value = appSettings.autoPurgeRetentionDays;
  });
}

function syncQuarantineSettingsUI() {
  const toggle = document.getElementById('chk-auto-purge');
  const retention = document.getElementById('inp-retention-days');
  if (!toggle || !retention) return;
  toggle.checked = appSettings.autoPurgeEnabled === true;
  retention.value = appSettings.autoPurgeRetentionDays;
  // Audit Mode: the vault is readable, but its policy is not editable.
  toggle.disabled = !isAdmin;
  retention.disabled = !isAdmin;
}

async function loadVaultEntries() {
  const loading = document.getElementById('vault-loading');
  const empty = document.getElementById('vault-empty');
  const errorBox = document.getElementById('vault-error');
  const listEl = document.getElementById('vault-entries');

  loading.style.display = 'flex';
  empty.style.display = 'none';
  errorBox.style.display = 'none';
  listEl.innerHTML = '';

  syncQuarantineSettingsUI();

  const res = await window.api.vaultList();
  loading.style.display = 'none';

  if (!res || res.success !== true) {
    document.getElementById('vault-error-text').textContent =
      (res && res.error) || 'Could not read what is in quarantine.';
    errorBox.style.display = 'flex';
    return;
  }

  vaultRootPath = res.vaultRoot || '';
  vaultEntries = (res.entries || []).slice().reverse(); // newest first

  const visible = vaultEntries.filter((e) => e.status !== 'deleted');
  if (visible.length === 0) {
    empty.style.display = 'flex';
    return;
  }

  listEl.innerHTML = visible.map(renderVaultEntry).join('');
  wireVaultEntryEvents();
  applyTierLocks();
}

// 7oo.9. The operator called this surface "adequate but not user friendly", and
// it is the screen someone opens when they are anxious about something they
// just removed. The information was all present; it made them work for it.
//
// Five questions, answered in the order they get asked, without expanding
// anything: what was this, where did it come from, when, can I get it back,
// and - the one nothing on the screen answered at all - what happens if I do
// nothing.

function describeRelativeTime(date) {
  if (!date || Number.isNaN(date.getTime())) return 'at an unknown time';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

// The origin field is an internal route ("system-clean/context-menus"). Say it
// the way the user experienced it.
function describeOrigin(origin) {
  const raw = String(origin || '');
  const known = {
    purge: 'the uninstall wizard',
    'system-clean/context-menus': 'System Clean - right-click menu entries',
    'system-clean/services': 'System Clean - left-over services',
    'system-clean/associations': 'System Clean - file types and links',
    'system-clean/profiles': 'System Clean - other user accounts',
    'system-clean/drivers': 'System Clean - driver packages',
    'system-clean/uwp-leftovers': 'System Clean - left-over Store app data'
  };
  if (known[raw]) return known[raw];
  if (raw.startsWith('system-clean/path')) return 'System Clean - PATH entries';
  if (raw.startsWith('system-clean')) return 'System Clean';
  if (raw.startsWith('force')) return 'Force Uninstall';
  return raw || 'an unrecorded action';
}

// What happens if the user closes the app and never comes back. Retention only
// applies when automatic purge is actually on, so this reads the live setting
// rather than assuming.
function describeFate(entry) {
  if (entry.status === 'restored') {
    return { text: 'Already put back where it came from. This is the record of that.', kind: 'calm' };
  }
  if (entry.status === 'deleted') {
    return { text: 'Permanently deleted. Only this record remains.', kind: 'gone' };
  }
  if (!appSettings.autoPurgeEnabled) {
    return {
      text: 'Kept here until you restore it or delete it. Nothing removes it on its own.',
      kind: 'calm'
    };
  }

  const retentionDays = parseInt(appSettings.autoPurgeRetentionDays, 10);
  const created = entry.createdAt ? new Date(entry.createdAt) : null;
  if (!created || Number.isNaN(created.getTime()) || !Number.isFinite(retentionDays)) {
    return { text: `Automatic purge is on. This is deleted permanently once it is ${retentionDays} days old.`, kind: 'warn' };
  }

  const dueMs = created.getTime() + retentionDays * 86400000;
  const daysLeft = Math.ceil((dueMs - Date.now()) / 86400000);
  if (daysLeft <= 0) {
    return { text: 'Automatic purge is on and this is already older than the limit. It will be deleted permanently the next time Vanish starts.', kind: 'warn' };
  }
  return {
    text: `Automatic purge is on: this is deleted permanently on ${new Date(dueMs).toLocaleDateString()}, in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
    kind: 'warn'
  };
}

function renderVaultEntry(entry) {
  const created = entry.createdAt ? new Date(entry.createdAt) : null;
  const dateStr = created && !Number.isNaN(created.getTime()) ? created.toLocaleString() : 'Unknown date';
  // Count the manifest rows, not just what is still quarantined: once an entry
  // is restored its live counts are zero, and "no items" would be a lie about
  // what the entry actually holds a record of.
  const totalFiles = (entry.files || []).length;
  const totalRegistry = (entry.registry || []).length;
  const parts = [];
  if (totalFiles) parts.push(`${totalFiles} file item${totalFiles === 1 ? '' : 's'}`);
  if (totalRegistry) parts.push(`${totalRegistry} registry key${totalRegistry === 1 ? '' : 's'}`);
  const typeSummary = parts.length ? parts.join(' + ') : 'no items';
  const isRestorable = entry.status === 'quarantined';
  // formatBytes reports 0 as "Unknown", which is wrong for an entry whose
  // payload has legitimately gone (restored or deleted).
  const sizeLabel = entry.sizeBytes > 0 ? formatBytes(entry.sizeBytes, 1) : null;

  const fileRows = (entry.files || [])
    .map(
      (f) => `
      <div class="vault-item">
        <span class="vault-item-path">${esc(f.originalPath)}</span>
        <span class="vault-item-status ${esc(f.status)}">${esc(f.status)}</span>
      </div>`
    )
    .join('');

  const regRows = (entry.registry || [])
    .map(
      (r) => `
      <div class="vault-item">
        <span class="vault-item-path">${esc(r.keyPath)}</span>
        <span class="vault-item-status ${esc(r.status)}">${esc(r.status)}</span>
      </div>`
    )
    .join('');

  // "Where did it come from" - the first original location, up front, instead
  // of only inside the expanded body.
  const firstPath = (entry.files || [])[0]?.originalPath
    || (entry.registry || [])[0]?.keyPath
    || null;
  const otherCount = totalFiles + totalRegistry - (firstPath ? 1 : 0);
  const fromLine = firstPath
    ? `${esc(firstPath)}${otherCount > 0 ? ` <span class="vault-more">and ${otherCount} more</span>` : ''}`
    : 'Location not recorded';

  const fate = describeFate(entry);

  return `
    <div class="vault-entry status-${esc(entry.status)}" data-entry-id="${esc(entry.id)}">
      <div class="vault-entry-header">
        <i class="fa-solid fa-chevron-right vault-entry-chevron"></i>
        <div class="vault-entry-main">
          <div class="vault-entry-app">
            ${esc(entry.sourceApp)}
            <span class="status-pill ${esc(entry.status)}">${esc(entry.status)}</span>
          </div>

          <!-- what and when, in a sentence rather than a field list -->
          <div class="vault-entry-summary">
            ${esc(typeSummary)}${sizeLabel ? `, ${esc(sizeLabel)}` : ''},
            removed ${esc(describeRelativeTime(created))} by ${esc(describeOrigin(entry.origin))}.
          </div>

          <div class="vault-entry-from" title="${esc(firstPath || '')}">
            <i class="fa-solid fa-location-dot"></i> ${fromLine}
          </div>

          <!-- the question nothing on this screen used to answer -->
          <div class="vault-entry-fate ${esc(fate.kind)}">
            <i class="fa-solid ${fate.kind === 'warn' ? 'fa-clock' : 'fa-shield-halved'}"></i>
            ${esc(fate.text)}
          </div>
        </div>
        <div class="vault-entry-actions">
          ${
            isRestorable
              ? `<button class="btn-sec btn-compact" data-action="restore" data-destructive="true">
                   <i class="fa-solid fa-rotate-left"></i> Restore
                 </button>
                 <button class="btn-danger btn-compact" data-action="delete" data-destructive="true">
                   <i class="fa-solid fa-trash-can"></i> Delete Forever
                 </button>`
              : ''
          }
        </div>
      </div>
      <div class="vault-entry-body">
        ${fileRows ? `<div class="vault-item-group-title">Files and folders</div>${fileRows}` : ''}
        ${regRows ? `<div class="vault-item-group-title">Registry entries (saved to a backup file)</div>${regRows}` : ''}
        <div class="vault-item-group-title">Moved to quarantine on</div>
        <div class="vault-item"><span class="vault-item-path">${esc(dateStr)}</span></div>
        <div class="vault-item-group-title">Kept in</div>
        <div class="vault-item"><span class="vault-item-path">${esc(entry.vaultPath)}</span></div>
      </div>
    </div>`;
}

function wireVaultEntryEvents() {
  document.querySelectorAll('.vault-entry').forEach((el) => {
    const entryId = el.getAttribute('data-entry-id');

    el.querySelector('.vault-entry-header').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      el.classList.toggle('expanded');
    });

    const restoreBtn = el.querySelector('[data-action="restore"]');
    if (restoreBtn) restoreBtn.addEventListener('click', () => restoreVaultEntry(entryId));

    const deleteBtn = el.querySelector('[data-action="delete"]');
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteVaultEntry(entryId));
  });
}

async function restoreVaultEntry(entryId) {
  if (!guardFullMode()) return;
  const entry = vaultEntries.find((e) => e.id === entryId);
  if (!entry) return;

  const res = await window.api.vaultRestore({ entryId, onConflict: 'skip' });
  if (!res || res.success !== true) {
    toast(`Could not restore it: ${(res && res.error) || 'no reason given'}`, 'error', 7000);
    return;
  }

  // FLOW-03 conflict branch: something already occupies the original path.
  if (res.skipped > 0) {
    const overwrite = await confirmDialog({
      title: `${res.skipped} item(s) already exist`,
      body:
        'Something is already sitting at the original path for those items, so they were left alone. ' +
        'Overwrite them with the quarantined copies?',
      confirmLabel: 'Overwrite'
    });
    if (overwrite) {
      const res2 = await window.api.vaultRestore({ entryId, onConflict: 'overwrite' });
      reportRestore(res2);
      await loadVaultEntries();
      return;
    }
  }

  reportRestore(res);
  await loadVaultEntries();
}

function reportRestore(res) {
  if (!res || res.success !== true) {
    toast(`Could not restore it: ${(res && res.error) || 'no reason given'}`, 'error', 7000);
    return;
  }
  if (res.failed > 0) {
    const first = [...(res.files || []), ...(res.registry || [])].find((i) => i.status === 'failed');
    toast(
      `Restored, but ${res.failed} item(s) could not be put back. First problem: ${(first && first.error) || 'no reason given'}`,
      'warn',
      8000
    );
  } else if (res.skipped > 0) {
    toast(`${res.skipped} item(s) skipped - something is already in their original place.`, 'warn');
  } else {
    toast('Everything in this entry is back where it came from.', 'success');
  }
}

async function deleteVaultEntry(entryId) {
  if (!guardFullMode()) return;
  const entry = vaultEntries.find((e) => e.id === entryId);
  if (!entry) return;

  const itemCount = (entry.fileCount || 0) + (entry.registryCount || 0);
  const first = await confirmDialog({
    title: 'Delete forever?',
    body:
      `This permanently deletes ${itemCount} quarantined item(s) from "${entry.sourceApp}". ` +
      'This is the only thing Vanish does that cannot be undone - after this there is no copy anywhere.',
    confirmLabel: 'Continue'
  });
  if (!first) return;

  const second = await confirmDialog({
    title: 'Confirm permanent deletion',
    body: `${entry.sourceApp} - ${itemCount} item(s), ${formatBytes(entry.sizeBytes, 1)}. There is no undo.`,
    confirmLabel: 'Delete forever',
    typed: 'DELETE'
  });
  if (!second) return;

  const res = await window.api.vaultDelete({ entryId });
  if (res && res.success) {
    toast('That quarantine entry was permanently deleted.', 'success');
  } else {
    toast(`Could not delete it: ${(res && res.error) || 'no reason given'}`, 'error', 7000);
  }
  await loadVaultEntries();
}


// ==========================================
// SCR-03 - TASK MANAGER (REQ-06) + INDICATORS (REQ-09)
// ==========================================

let processes = [];
let processSort = { key: 'cpu', asc: false };
let processFilter = '';
let selectedPid = null;
let processTimer = null;
let processSampling = false;
let processPaused = false;

// GPU usage (operator request). Sampled on its own, much slower timer -
// scanner.ps1's Get-GpuUsageByProcess measures 1.5-3s per call, so it cannot
// run on the same cadence as the rest of the process list without undoing
// the startup/latency work done the same session this was requested in.
// Keyed by pid (string, since JSON object keys always are).
let gpuUsageByPid = {};
let gpuAdapterUsage = []; // [{ physIndex, percent, luidHigh, luidLow }] - system-wide, not per-process
// Static per-boot hardware info (name/vendor/logo/luidHigh/luidLow), fetched
// once and cached - unlike gpuAdapterUsage this doesn't change between
// samples. null = not fetched yet, [] = fetched and no real adapters found.
let gpuVendorInfo = null;
let gpuSampleTimer = null;
let gpuSampling = false;
const GPU_SAMPLE_INTERVAL_MS = 15000;

// 3nd: which PIDs existed when the last GPU sample was TAKEN. Needed because
// scanner.ps1's Get-GpuUsageByProcess drops any engine reading of 0 (`if
// ($sample.CookedValue -le 0) { continue }`), so a PID missing from byPid is
// ambiguous on its own - it means either "measured, genuinely idle" or "never
// measured, because this process did not exist yet". Those deserve different
// cells: the first is 0%, the second is a dash that says why. null = no
// sample has completed yet this session, which is a third state again.
let gpuSampledPids = null;

// The GPU cell's three honest states. Kept as a function rather than inlined
// so the "-" case can never silently drift back into meaning "zero".
function gpuCellHtml(pid) {
  const value = gpuUsageByPid[pid];
  if (value != null) return `${esc(value.toFixed(1))}%`;
  if (gpuSampledPids === null) {
    return '<span title="The first GPU measurement of this session has not finished yet.">measuring...</span>';
  }
  if (!gpuSampledPids.has(pid)) {
    return '<span title="This program started after the last GPU measurement. GPU is measured every 15 seconds - it will have a figure at the next one.">-</span>';
  }
  return '<span title="Measured, and this program was not using the GPU at that moment.">0%</span>';
}

const PROCESS_SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  pid: (a, b) => a.pid - b.pid,
  cpu: (a, b) => a.cpuPercent - b.cpuPercent,
  gpu: (a, b) => (gpuUsageByPid[a.pid] || 0) - (gpuUsageByPid[b.pid] || 0),
  memory: (a, b) => a.memoryBytes - b.memoryBytes,
  io: (a, b) => a.ioBytesPerSec - b.ioBytesPerSec
};

function setupProcessTab() {
  document.getElementById('process-search').addEventListener('input', (e) => {
    processFilter = e.target.value.toLowerCase();
    renderProcessTable();
  });

  document.querySelectorAll('.process-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (processSort.key === key) {
        processSort.asc = !processSort.asc;
      } else {
        processSort = { key, asc: key === 'name' || key === 'pid' };
      }
      renderProcessTable();
    });
  });

  const refreshInput = document.getElementById('inp-process-refresh');
  refreshInput.addEventListener('change', async () => {
    appSettings = await window.api.setSettings({
      processRefreshSeconds: parseInt(refreshInput.value, 10)
    });
    refreshInput.value = appSettings.processRefreshSeconds;
    if (!processPaused && activeTab === 'task-manager') startProcessRefresh();
  });

  document.getElementById('btn-toggle-process-refresh').addEventListener('click', (e) => {
    processPaused = !processPaused;
    e.currentTarget.innerHTML = processPaused
      ? '<i class="fa-solid fa-play"></i> Resume'
      : '<i class="fa-solid fa-pause"></i> Pause';
    if (processPaused) stopProcessRefresh();
    else startProcessRefresh();
  });

  document.getElementById('btn-kill-process').addEventListener('click', killSelectedProcess);
}

function startProcessRefresh() {
  stopProcessRefresh();
  document.getElementById('inp-process-refresh').value = appSettings.processRefreshSeconds;
  if (processPaused) return;
  sampleProcesses();
  processTimer = setInterval(sampleProcesses, appSettings.processRefreshSeconds * 1000);
  startGpuSampling();
}

function stopProcessRefresh() {
  if (processTimer) {
    clearInterval(processTimer);
    processTimer = null;
  }
  stopGpuSampling();
}

// Separate, much slower cadence than sampleProcesses() - see the cost
// comment on gpuUsageByPid above. Re-renders only the already-visible table
// (cheap) rather than re-fetching the process list too.
async function sampleGpuUsage() {
  if (gpuSampling) return;
  gpuSampling = true;
  // Captured BEFORE the await, not after: the counter read happens at the
  // start of this call, so "which processes existed at sample time" is the
  // list as it stands now, not 1.5-3s later once the engine has returned.
  const pidsAtSampleTime = new Set(processes.map((p) => p.pid));
  try {
    const res = await window.api.getGpuUsage();
    if (res && res.success === true) {
      gpuUsageByPid = res.byPid || {};
      gpuSampledPids = pidsAtSampleTime;
      gpuAdapterUsage = res.byAdapter || [];
      renderGpuAdapterSummary();
      renderProcessTable();
    }
  } finally {
    gpuSampling = false;
  }
}

function startGpuSampling() {
  stopGpuSampling();
  if (gpuVendorInfo === null) {
    // Static hardware info - fetched once per session, not on the sampling
    // interval. renderGpuAdapterSummary() re-renders once this resolves.
    window.api.getGpuVendors().then((vendors) => {
      gpuVendorInfo = vendors || [];
      renderGpuAdapterSummary();
    });
  }
  sampleGpuUsage();
  gpuSampleTimer = setInterval(sampleGpuUsage, GPU_SAMPLE_INTERVAL_MS);
}

function stopGpuSampling() {
  if (gpuSampleTimer) {
    clearInterval(gpuSampleTimer);
    gpuSampleTimer = null;
  }
}

// "Active GPU icons, so we know which GPU is doing what... remember those
// ids permanently, phys_N is friction." Matched on LUID now, not phys_N or
// array position - phys_N is only an ordinal into whichever adapters have
// an active engine at sample time, and shifts or drops out entirely when a
// discrete GPU sleeps under hybrid graphics (exactly what happened during
// testing: the dGPU had zero perf-counter presence while idle). LUID is the
// actual stable per-boot adapter identity, verified to match bit-for-bit
// between the perf counter and chrome://gpu for the same physical card -
// see get-gpu-vendors (main.js). The numeric "GPU N" label still stays
// alongside the logo: a LUID this sample has never seen before (freshly
// woken GPU, or gpuVendorInfo not loaded yet) has nothing to match against,
// and falls back to it cleanly rather than guessing.
function renderGpuAdapterSummary() {
  const el = document.getElementById('gpu-adapter-summary');
  if (!el) return;
  if (!gpuAdapterUsage.length) {
    el.innerHTML = '<span class="gpu-adapter-pill idle"><i class="fa-solid fa-microchip"></i> No GPU activity detected</span>';
    return;
  }
  el.innerHTML = gpuAdapterUsage
    .map((a) => {
      const vendorMatch = (gpuVendorInfo || []).find(
        (v) => v.luidHigh === a.luidHigh && v.luidLow === a.luidLow
      );
      const icon = vendorMatch && vendorMatch.vendor === 'amd' ? 'fa-amd'
        : vendorMatch && vendorMatch.vendor === 'nvidia' ? 'fa-nvidia'
        : 'fa-microchip';
      const title = vendorMatch ? ` title="${esc(vendorMatch.name)}"` : '';
      return `
        <span class="gpu-adapter-pill${a.percent > 0 ? ' is-active' : ''}"${title}>
           <i class="fa-solid ${icon}"></i> GPU ${esc(a.physIndex)}: ${esc(a.percent.toFixed(0))}%
         </span>`;
    })
    .join('');
}

async function sampleProcesses() {
  // A sample takes ~1.5s on a busy machine; never stack them.
  if (processSampling) return;
  processSampling = true;
  try {
    const res = await window.api.listProcesses({ sampleMs: 400 });
    if (!res || res.success !== true) {
      document.getElementById('process-tbody').innerHTML = `
        <tr><td colspan="7" class="table-state" style="color: var(--color-danger);">
          <i class="fa-solid fa-circle-xmark"></i> ${esc((res && res.error) || 'Could not read the running programs.')}
        </td></tr>`;
      return;
    }
    processes = res.items || [];
    renderProcessTable();
    if (selectedPid !== null) renderProcessDetails(processes.find((p) => p.pid === selectedPid));
  } finally {
    processSampling = false;
  }
}

function renderProcessTable() {
  const tbody = document.getElementById('process-tbody');
  if (!tbody) return;

  let rows = processes;
  if (processFilter) {
    rows = rows.filter(
      (p) => p.name.toLowerCase().includes(processFilter) || String(p.pid).includes(processFilter)
    );
  }

  const sorter = PROCESS_SORTERS[processSort.key] || PROCESS_SORTERS.cpu;
  rows = rows.slice().sort((a, b) => (processSort.asc ? sorter(a, b) : sorter(b, a)));

  document.querySelectorAll('.process-table th[data-sort]').forEach((th) => {
    const isSorted = th.getAttribute('data-sort') === processSort.key;
    th.classList.toggle('sorted', isSorted);
    th.classList.toggle('asc', isSorted && processSort.asc);
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-state">Nothing running matches that filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((p) => {
      const chips = (p.indicators || [])
        .map(
          (i) =>
            `<span class="indicator-chip" title="${esc(i.title)} - ${esc(i.note)}">
               <i class="fa-solid fa-triangle-exclamation"></i>${esc(indicatorShortLabel(i.kind))}
             </span>`
        )
        .join('');
      return `
        <tr class="app-row ${p.pid === selectedPid ? 'selected' : ''}" data-pid="${esc(p.pid)}">
          <td style="font-weight: 600; color: var(--text-white);">${esc(p.name)}</td>
          <td style="color: var(--text-gray);">${esc(p.pid)}</td>
          <td style="color: var(--text-gray);">${esc(p.cpuPercent.toFixed(1))}%</td>
          <td style="color: var(--text-gray);">${gpuCellHtml(p.pid)}</td>
          <td style="color: var(--text-gray);">${esc(formatBytes(p.memoryBytes, 1))}</td>
          <td style="color: var(--text-gray);">${p.ioBytesPerSec > 0 ? esc(formatBytes(p.ioBytesPerSec, 1)) + '/s' : '-'}</td>
          <td>${chips}</td>
        </tr>`;
    })
    .join('');

  tbody.querySelectorAll('tr[data-pid]').forEach((tr) => {
    tr.addEventListener('click', () => {
      selectedPid = parseInt(tr.getAttribute('data-pid'), 10);
      renderProcessTable();
      renderProcessDetails(processes.find((p) => p.pid === selectedPid));
    });
  });
}

function indicatorShortLabel(kind) {
  if (kind === 'suspicious-parent') return 'Script-started';
  if (kind === 'destructive-command') return 'Destructive';
  if (kind === 'persistence') return 'Autostart';
  return 'Indicator';
}

function renderProcessDetails(proc) {
  const panel = document.getElementById('process-details');
  if (!proc) {
    panel.classList.remove('active');
    return;
  }
  panel.classList.add('active');

  document.getElementById('proc-det-name').textContent = proc.name;
  document.getElementById('proc-det-company').textContent = proc.imagePath ? 'Running now' : 'Program file not available';
  document.getElementById('proc-det-pid').textContent = proc.pid;
  document.getElementById('proc-det-parent').textContent = proc.parentName
    ? `${proc.parentName} (${proc.parentPid})`
    : String(proc.parentPid || '-');
  document.getElementById('proc-det-started').textContent = proc.startedAt || 'Unknown';
  document.getElementById('proc-det-path').textContent = proc.imagePath || 'Not available';
  document.getElementById('proc-det-cmdline').textContent = proc.commandLine || 'Not available';

  // Rule 7: indicators are displayed. Nothing here is wired to an action.
  const box = document.getElementById('proc-det-indicators');
  const indicators = proc.indicators || [];
  box.innerHTML = indicators.length
    ? indicators
        .map(
          (i) => `
        <div class="indicator-detail">
          <div class="indicator-detail-title">${esc(i.title)}</div>
          <div class="indicator-detail-evidence">${esc(i.evidence)}</div>
          <div class="indicator-detail-note">${esc(i.note)}</div>
        </div>`
        )
        .join('')
    : '';
}

async function killSelectedProcess() {
  if (!guardFullMode()) return;
  const proc = processes.find((p) => p.pid === selectedPid);
  if (!proc) return;

  const nameLower = (proc.name || '').toLowerCase();

  if (PROCESS_KILL_DENYLIST_FATAL.has(nameLower)) {
    toast(
      `${proc.name} is a core part of Windows. Ending it will crash this PC or sign you out, so Vanish ` +
      'will not end it.',
      'error', 8000
    );
    return;
  }

  const isRisky = PROCESS_KILL_DENYLIST_RISKY.has(nameLower);
  const ok = await confirmDialog({
    title: `End ${proc.name}?`,
    body: isRisky
      ? `Windows uses ${proc.name} to run other things on this PC right now. Ending the wrong one can ` +
        'take out your network, sound, or the desktop itself until you sign out or restart. Only continue ' +
        `if you mean to end this exact one, PID ${proc.pid}, and not just any ${proc.name}.`
      : `PID ${proc.pid} ends immediately. Any unsaved work in it is lost, and ending something Windows ` +
        'needs can leave this PC unstable until you restart.',
    confirmLabel: 'End process',
    typed: isRisky ? proc.name : null
  });
  if (!ok) return;

  const res = await window.api.killProcess({ pid: proc.pid, name: proc.name });
  if (res && res.success) {
    toast(`${proc.name} (${proc.pid}) ended.`, 'success');
    selectedPid = null;
    renderProcessDetails(null);
    sampleProcesses();
  } else {
    toast(`Could not end ${proc.name}: ${(res && res.error) || 'no reason given'}`, 'error', 7000);
  }
}

// ==========================================
// FLOW-04 - UNLOCKER (REQ-07, REQ-08)
// ==========================================

let currentLockers = [];

function setupUnlocker() {
  const overlay = document.getElementById('unlock-modal-overlay');

  document.getElementById('btn-open-unlocker').addEventListener('click', () => {
    document.getElementById('unlock-results').innerHTML = '';
    document.getElementById('btn-unlock-graceful').style.display = 'none';
    overlay.classList.add('active');
    document.getElementById('unlock-path-input').focus();
  });

  document.getElementById('unlock-close-x').addEventListener('click', () => overlay.classList.remove('active'));
  document.getElementById('btn-browse-unlock-target').addEventListener('click', async () => {
    const res = await window.api.browseForPath();
    if (!res || res.canceled) return;
    document.getElementById('unlock-path-input').value = res.path;
  });
  document.getElementById('btn-find-lockers').addEventListener('click', findLockers);
  document.getElementById('unlock-path-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') findLockers();
  });
  document.getElementById('btn-unlock-graceful').addEventListener('click', () => closeLockers(false));
}

// Entry point used by the FLOW-02 locked-item shortcut on the summary screen.
function openUnlockerFor(path) {
  const overlay = document.getElementById('unlock-modal-overlay');
  document.getElementById('unlock-path-input').value = path;
  overlay.classList.add('active');
  findLockers();
}

async function findLockers() {
  const path = document.getElementById('unlock-path-input').value.trim();
  const results = document.getElementById('unlock-results');
  const gracefulBtn = document.getElementById('btn-unlock-graceful');

  if (!path) {
    toast('Enter a file or folder path first.', 'warn');
    return;
  }

  results.innerHTML = '<div class="panel-state"><i class="fa-solid fa-spinner fa-spin"></i><div>Asking Windows what is using it...</div></div>';
  gracefulBtn.style.display = 'none';

  const res = await window.api.listLockers({ path });

  if (!res || res.success !== true) {
    results.innerHTML = `<div class="panel-state error"><i class="fa-solid fa-circle-xmark"></i><div>${esc((res && res.error) || 'Could not check that file or folder.')}</div></div>`;
    return;
  }

  currentLockers = res.holders || [];

  if (currentLockers.length === 0) {
    results.innerHTML = `<div class="panel-state"><i class="fa-solid fa-circle-check"></i><div>${esc(res.note || 'Nothing is using this right now.')}</div></div>`;
    return;
  }

  results.innerHTML = currentLockers
    .map(
      (h) => `
      <div class="locker-row">
        <div class="locker-row-main">
          <div class="locker-name">${esc(h.name || h.appName)} <span style="color: var(--text-muted); font-weight: 400;">PID ${esc(h.pid)}</span></div>
          <div class="locker-meta">${esc(h.imagePath || h.lockedFile || '')}</div>
        </div>
        <button class="btn-danger btn-compact" data-force-pid="${esc(h.pid)}" data-destructive="true">Force end</button>
      </div>`
    )
    .join('');

  results.querySelectorAll('[data-force-pid]').forEach((btn) => {
    btn.addEventListener('click', () => forceEndHolder(parseInt(btn.getAttribute('data-force-pid'), 10)));
  });

  gracefulBtn.style.display = '';
  applyTierLocks();
}

async function closeLockers(force) {
  if (!guardFullMode()) return;
  const path = document.getElementById('unlock-path-input').value.trim();

  const res = await window.api.unlockPath({ path, force, pids: currentLockers.map((h) => h.pid) });
  if (!res || res.success !== true) {
    toast(`Could not release it: ${(res && res.error) || 'no reason given'}`, 'error', 7000);
    return;
  }

  toast(`Asked ${res.totalTargets} program(s) to let go of it. Checking again.`, 'success');
  await findLockers();
}

// The explicit second step, per process (FLOW-04). REQ-08 suspends the holder
// tree first so a watchdog cannot respawn the locker mid-cleanup.
async function forceEndHolder(pid) {
  if (!guardFullMode()) return;
  const holder = currentLockers.find((h) => h.pid === pid);
  const path = document.getElementById('unlock-path-input').value.trim();

  const ok = await confirmDialog({
    title: `Force end ${holder ? holder.name : 'process'}?`,
    body:
      'You have already been offered the chance to close it normally. Forcing it to end loses any unsaved ' +
      'work in it. Vanish pauses the program and anything it started first, so it cannot restart itself ' +
      'and take hold of the file again.',
    confirmLabel: 'Force end'
  });
  if (!ok) return;

  const res = await window.api.unlockPath({ path, force: true, suspendTree: true, pids: [pid] });
  if (res && res.success) {
    toast('That program was ended and the file is free.', 'success');
    (res.notes || []).forEach((n) => toast(n, 'info', 6000));
  } else {
    toast(`Could not force it to end: ${(res && res.error) || 'no reason given'}`, 'error', 7000);
  }
  await findLockers();
}

// ==========================================
// SCR-04 - BULK UNINSTALL QUEUE (REQ-10, REQ-12, REQ-13)
// ==========================================

let queueState = { items: [], running: false, paused: false, counts: {} };

const QUEUE_STATE_LABELS = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  rebootRequired: 'Reboot needed',
  needsAttention: 'Needs attention'
};

function setupQueuePanel() {
  const panel = document.getElementById('queue-panel');

  document.getElementById('btn-queue-start').addEventListener('click', startQueue);
  document.getElementById('btn-queue-pause').addEventListener('click', async () => {
    await window.api.queuePause();
    toast('The queue will pause once the current program finishes.', 'info');
  });
  document.getElementById('btn-queue-clear').addEventListener('click', async () => {
    if (!guardFullMode()) return;
    await window.api.queueClear();
    await refreshQueue();
  });
  document.getElementById('btn-queue-close').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  // The runner pushes every state transition; the panel never polls.
  window.api.onQueueUpdate((state) => {
    queueState = state;
    renderQueue();
  });

  refreshQueue();
}

async function refreshQueue() {
  queueState = await window.api.queueGet();
  renderQueue();
}

async function queueAddApp(app) {
  const res = await window.api.queueAdd(app);
  if (!res || res.success !== true) {
    toast((res && res.error) || 'Could not add that program to the queue.', 'warn');
    return;
  }
  toast(`${app.name} was added to the queue.`, 'success');
  document.getElementById('queue-panel').classList.remove('collapsed');
  await refreshQueue();
}

async function startQueue() {
  if (!guardFullMode()) return;
  const pending = queueState.items.filter((i) => i.state === 'pending');
  if (pending.length === 0) {
    toast('Nothing in the queue is waiting to run.', 'info');
    return;
  }

  const ok = await confirmDialog({
    title: `Uninstall ${pending.length} program(s)?`,
    body:
      'Each program gets its own system restore point, then Vanish runs its uninstaller without ' +
      'prompting where it can. Any uninstaller that insists on showing a window is marked "needs ' +
      'attention" so you can finish it by hand. Scanning for leftovers is separate - this queue does ' +
      'not move anything to quarantine.',
    confirmLabel: 'Start'
  });
  if (!ok) return;

  // An uninstaller registered under HKCU, or one whose binary sits somewhere a
  // standard user can write, is something malware could have planted. Running
  // it here would run it as administrator, so it needs naming out loud.
  const risky = pending.filter((i) => i.meta && i.meta.trust && i.meta.trust.risky);
  let acknowledgedIds = [];

  if (risky.length > 0) {
    const detail = risky
      .map((i) => `${i.displayName}: ${(i.meta.trust.reasons || []).join('; ')}`)
      .join('\n');
    const ackRisky = await confirmDialog({
      title: `${risky.length} uninstaller(s) cannot be fully trusted`,
      body:
        'These would run with administrator rights, but they are the kind of entry malware can ' +
        'create:\n\n' +
        detail +
        '\n\nSkip them unless you recognise every one. Type RUN to run them anyway, or cancel to ' +
        'uninstall everything else and mark these as needing attention.',
      confirmLabel: 'Run them too',
      typed: 'RUN'
    });
    if (ackRisky) acknowledgedIds = risky.map((i) => i.id);
  }

  window.api.queueStart({ acknowledgedIds });
  toast(
    risky.length > 0 && acknowledgedIds.length === 0
      ? `Queue started. ${risky.length} uninstaller(s) that could not be trusted will be skipped.`
      : 'Queue started.',
    'success'
  );
}

function renderQueue() {
  const panel = document.getElementById('queue-panel');
  const list = document.getElementById('queue-list');
  const footer = document.getElementById('queue-footer');
  const countBadge = document.getElementById('queue-count');
  const startBtn = document.getElementById('btn-queue-start');
  const pauseBtn = document.getElementById('btn-queue-pause');

  const items = queueState.items || [];

  if (items.length === 0) {
    panel.classList.remove('active');
    return;
  }

  panel.classList.add('active');
  countBadge.textContent = items.length;
  startBtn.style.display = queueState.running ? 'none' : '';
  pauseBtn.style.display = queueState.running ? '' : 'none';

  list.innerHTML = items
    .map((item) => {
      const methodBadge = item.method
        ? `<span class="method-badge" title="${esc(item.meta && item.meta.matchedName ? 'Matched: ' + item.meta.matchedName : 'How Vanish will run this uninstaller')}">${esc(item.method)}</span>`
        : '';
      const detail = queueItemDetail(item);
      const retryable = ['failed', 'rebootRequired', 'needsAttention'].includes(item.state);
      return `
        <div class="queue-item" data-item-id="${esc(item.id)}">
          <div class="queue-item-main">
            <div class="queue-item-name">${esc(item.displayName)}${methodBadge}</div>
            <div class="queue-item-sub">${esc(detail)}</div>
          </div>
          <span class="queue-state ${esc(item.state)}">${esc(QUEUE_STATE_LABELS[item.state] || item.state)}</span>
          ${retryable ? `<button class="btn-sec btn-compact" data-retry="${esc(item.id)}" data-destructive="true">Retry</button>` : ''}
          ${item.state === 'pending' ? `<button class="wizard-close-btn" data-remove="${esc(item.id)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.api.queueRetry({ itemId: btn.getAttribute('data-retry') });
      await refreshQueue();
    });
  });
  list.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.api.queueRemove({ itemId: btn.getAttribute('data-remove') });
      await refreshQueue();
    });
  });

  const counts = queueState.counts || {};
  const parts = Object.keys(QUEUE_STATE_LABELS)
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${QUEUE_STATE_LABELS[k].toLowerCase()}`);

  if (counts.rebootRequired) {
    footer.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: var(--color-warning);"></i>
      Queue paused: an uninstaller needs a restart to finish. Restart Windows, then retry that item.`;
  } else if (counts.needsAttention) {
    footer.innerHTML = `<i class="fa-solid fa-circle-info"></i>
      Some uninstallers would not run on their own and are waiting for you. ${esc(parts.join(', '))}`;
  } else {
    footer.textContent = parts.join(', ') || 'Queue empty';
  }

  applyTierLocks();
}

function queueItemDetail(item) {
  const meta = item.meta || {};
  if (item.state === 'failed' && meta.error) return meta.error;
  if (item.state === 'failed' && item.exitCode !== null) return `The uninstaller stopped with code ${item.exitCode}`;
  if (item.state === 'rebootRequired') return 'Restart Windows to finish this one';
  if (item.state === 'needsAttention') return 'The uninstaller did not finish on its own';
  if (item.state === 'done') {
    const rp = meta.restorePoint ? `restore point ${meta.restorePoint}` : '';
    return [rp, meta.durationMs ? `${Math.round(meta.durationMs / 1000)}s` : ''].filter(Boolean).join(' - ') || 'Uninstalled';
  }
  if (item.state === 'running') return meta.command || 'Working...';
  return item.publisher || '';
}

// ==========================================
// SCR-05 / FLOW-06 - SYSTEM CLEAN (REQ-11, REQ-14..REQ-17)
// ==========================================
// One generic section component per cleaner (D-07): scan -> review list ->
// purge through the quarantine pipeline. No cleaner has its own removal path.

const CLEANERS = [
  {
    id: 'context-menus',
    icon: 'fa-bars',
    title: 'Right-click menu entries',
    desc: 'Right-click menu entries whose program is no longer on this PC. These are what make the right-click menu slow or full of dead options.'
  },
  {
    id: 'services',
    icon: 'fa-gears',
    title: 'Left-over services',
    desc: 'Background services that point at a program no longer on this PC. Drivers that Windows loads at startup are left alone.'
  },
  {
    id: 'drivers',
    icon: 'fa-microchip',
    title: 'Left-over driver packages',
    desc: 'Driver packages from hardware or programs that are no longer set up on this PC. Vanish can list these but cannot remove them yet.'
  },
  {
    id: 'path',
    icon: 'fa-road',
    title: 'PATH entries',
    desc: 'Folders listed in your PATH that no longer exist. The whole setting is backed up before anything is changed.'
  },
  {
    id: 'associations',
    icon: 'fa-file-circle-question',
    title: 'File associations and protocols',
    desc: 'File types and links set to open with a program that is no longer on this PC.'
  },
  {
    id: 'uwp-leftovers',
    icon: 'fa-box-archive',
    title: 'Left-over Store app data',
    desc: 'Data folders left behind by Store apps that are no longer installed. Windows does not remove these when you uninstall, and they can be large. Anything Windows itself uses is listed but left alone.'
  },
  {
    id: 'profiles',
    icon: 'fa-users',
    title: 'Other user profiles',
    desc: 'Leftovers in the settings of other user accounts on this PC. Needs administrator rights.',
    needsKeyword: true
  }
];

const cleanerState = {};

function setupCleanTab() {
  CLEANERS.forEach((c) => {
    cleanerState[c.id] = {
      findings: [], scanned: false, loading: false, error: null, note: null,
      selected: new Set(), resolvedCount: 0, scannedAt: null
    };
  });

  document.getElementById('btn-scan-all-cleaners').addEventListener('click', async () => {
    for (const c of CLEANERS) {
      if (c.needsKeyword) continue; // needs a search term from the user
      await scanCleaner(c.id, { expand: false });
    }
    toast('Every section has been scanned.', 'success');
  });

  const cleanAllBtn = document.getElementById('btn-clean-all-cleaners');
  if (cleanAllBtn) cleanAllBtn.addEventListener('click', () => cleanAllCleaners());
}

function renderCleanerSections() {
  const host = document.getElementById('cleaner-sections');
  if (!host) return;

  if (!host.dataset.built) {
    host.innerHTML = CLEANERS.map(
      (c) => `
      <div class="cleaner-section" id="cleaner-${esc(c.id)}" style="margin-bottom: 12px;">
        <div class="cleaner-section-header">
          <div class="cleaner-section-title">
            <i class="fa-solid ${esc(c.icon)}"></i>
            <div>
              ${esc(c.title)}
              <div class="cleaner-section-desc">${esc(c.desc)}</div>
            </div>
          </div>
          <span class="audit-badge" id="cleaner-count-${esc(c.id)}" style="display:none;">0</span>
          <i class="fa-solid fa-chevron-right vault-entry-chevron"></i>
        </div>
        <div class="cleaner-section-body" id="cleaner-body-${esc(c.id)}"></div>
      </div>`
    ).join('');

    host.dataset.built = '1';

    CLEANERS.forEach((c) => {
      const section = document.getElementById(`cleaner-${c.id}`);
      section.querySelector('.cleaner-section-header').addEventListener('click', () => {
        const wasExpanded = section.classList.contains('expanded');
        section.classList.toggle('expanded');
        if (!wasExpanded && !cleanerState[c.id].scanned && !c.needsKeyword) scanCleaner(c.id);
        if (!wasExpanded) renderCleanerBody(c);
      });
      renderCleanerBody(c);
    });
  }

  CLEANERS.forEach(renderCleanerBody);
  applyTierLocks();
}

// 7oo.5: a number on screen must never look final while its scan is still
// running. The badge says "scanning" until the engine has actually returned,
// because "even if 1 issue is showing but it is still scanning" was reported as
// a count the operator could not trust.
function updateCleanerBadge(cleanerId) {
  const state = cleanerState[cleanerId];
  const badge = document.getElementById(`cleaner-count-${cleanerId}`);
  if (!badge || !state) return;

  if (state.loading) {
    badge.textContent = 'scanning';
    badge.className = 'audit-badge scanning';
    badge.style.display = 'inline-flex';
    return;
  }

  badge.textContent = state.findings.length;
  badge.style.display = state.scanned ? 'inline-flex' : 'none';
  badge.className = state.findings.length > 0 ? 'audit-badge danger' : 'audit-badge';
}

async function scanCleaner(cleanerId, options = {}) {
  const cleaner = CLEANERS.find((c) => c.id === cleanerId);
  const state = cleanerState[cleanerId];
  // Re-entrancy guard: a second scan of the same cleaner while one is in flight
  // doubles the work and races two results into one view.
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  renderCleanerBody(cleaner);
  updateCleanerBadge(cleanerId);

  const params = { cleaner: cleanerId };
  if (cleaner.needsKeyword) {
    const input = document.getElementById(`cleaner-keyword-${cleanerId}`);
    params.keyword = input ? input.value.trim() : '';
  }

  const res = await window.api.cleanerScan(params);
  state.loading = false;
  stopScanTicker(`cleaner:${cleanerId}`);

  if (!res || res.success !== true) {
    state.error = (res && res.error) || 'The scan did not return a result.';
    state.findings = [];
  } else {
    // PowerShell's ConvertTo-Json emits a null element for any finding that
    // came back empty from a sub-scan, and one null took the whole cleaner
    // panel down with "Cannot read properties of null" the moment it rendered.
    // Same defence the app list already applies to odd registry payloads: one
    // malformed item must never cost the user the whole view.
    state.findings = (res.findings || []).filter((f) => f && typeof f === 'object');
    state.note = res.note || null;
    state.scanned = true;
    state.scannedAt = Date.now();
  }

  updateCleanerBadge(cleanerId);

  if (options.expand !== false) document.getElementById(`cleaner-${cleanerId}`).classList.add('expanded');
  renderCleanerBody(cleaner);
}

// Results now persist across interactions instead of being re-derived, so the
// view has to be honest about how old they are.
function scanAgeLabel(state) {
  if (!state.scannedAt) return '';
  const seconds = Math.round((Date.now() - state.scannedAt) / 1000);
  const when = seconds < 60
    ? 'just now'
    : `${Math.floor(seconds / 60)} minute(s) ago`;
  return `<span style="font-size: 11.5px; color: var(--text-muted);">Scanned ${when}</span>`;
}

function renderCleanerBody(cleaner) {
  const body = document.getElementById(`cleaner-body-${cleaner.id}`);
  if (!body) return;
  const state = cleanerState[cleaner.id];

  const keywordRow = cleaner.needsKeyword
    ? `<div class="unlock-input-row">
         <input type="text" class="search-input" id="cleaner-keyword-${esc(cleaner.id)}" placeholder="Program name to search for">
         <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}">Search other accounts</button>
       </div>`
    : '';

  if (state.loading) {
    body.innerHTML = `${keywordRow}<div class="panel-state">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <div id="cleaner-progress-${esc(cleaner.id)}">Scanning...</div>
    </div>`;
    // The ticker is re-attached on every re-render because renderCleanerBody
    // replaces the element it writes into.
    startScanTicker(
      `cleaner:${cleaner.id}`,
      document.getElementById(`cleaner-progress-${cleaner.id}`),
      'Scanning'
    );
    return;
  }

  if (state.error) {
    body.innerHTML = `${keywordRow}<div class="panel-state error"><i class="fa-solid fa-circle-xmark"></i><div>${esc(state.error)}</div></div>`;
    wireCleanerBody(cleaner);
    return;
  }

  if (!state.scanned) {
    body.innerHTML = `${keywordRow}
      <div class="cleaner-actions">
        <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}">
          <i class="fa-solid fa-magnifying-glass"></i> Scan
        </button>
        <span style="font-size: 11.5px; color: var(--text-muted);">Scanning only reads. It changes nothing.</span>
      </div>`;
    wireCleanerBody(cleaner);
    return;
  }

  if (state.findings.length === 0) {
    const cleared = state.resolvedCount > 0
      ? `All ${state.resolvedCount} item(s) found here have been moved to quarantine.`
      : esc(state.note || 'Nothing left behind here.');
    body.innerHTML = `${keywordRow}
      <div class="panel-state">
        <i class="fa-solid fa-circle-check" style="color: var(--color-success);"></i>
        <div>${cleared}</div>
      </div>
      <div class="cleaner-actions">
        <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}"><i class="fa-solid fa-rotate-right"></i> Re-scan</button>
        ${scanAgeLabel(state)}
      </div>`;
    wireCleanerBody(cleaner);
    return;
  }

  const removable = state.findings.filter((f) => f.removable !== false);

  body.innerHTML = `
    ${keywordRow}
    <div class="cleaner-findings">
      ${state.findings
        .map(
          (f, index) => `
        <div class="finding-row">
          <input type="checkbox" data-finding="${esc(index)}" ${f.removable === false ? 'disabled' : ''}${state.selected && state.selected.has(f.id) ? ' checked' : ''}>
          <div class="finding-main">
            <div class="finding-label">${esc(f.label)}</div>
            <div class="finding-evidence">${esc(f.evidence)}${f.registryPath ? ' &middot; ' + esc(f.registryPath) : ''}${!f.registryPath && f.path ? ' &middot; ' + esc(f.path) : ''}</div>
            ${f.note ? `<div class="finding-evidence" style="color: var(--color-warning);">${esc(f.note)}</div>` : ''}
          </div>
          <span class="finding-risk ${esc((f.risk || 'safe').toLowerCase())}">${esc(f.risk || 'Safe')}</span>
        </div>`
        )
        .join('')}
    </div>
    <div class="cleaner-actions">
      <button class="btn-sec btn-compact" data-select-all="${esc(cleaner.id)}">Select all</button>
      <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}"><i class="fa-solid fa-rotate-right"></i> Re-scan</button>
      ${scanAgeLabel(state)}
      ${
        removable.length > 0
          ? `<button class="btn-danger btn-compact" data-purge="${esc(cleaner.id)}" data-destructive="true">
               <i class="fa-solid fa-box-archive"></i> Move selected to quarantine
             </button>`
          : `<span style="font-size: 11.5px; color: var(--color-warning);">Vanish can list these but cannot remove them yet.</span>`
      }
    </div>`;

  wireCleanerBody(cleaner);
}

function wireCleanerBody(cleaner) {
  const body = document.getElementById(`cleaner-body-${cleaner.id}`);
  if (!body) return;
  const state = cleanerState[cleaner.id];

  // 7oo.5: what the user ticked is their work, and renderCleanerBody rebuilds
  // this subtree on every re-render - collapsing the section, or leaving the
  // tab and coming back, silently threw the selection away. Selection lives in
  // state now, keyed by finding id rather than row index, so it also survives
  // the list changing underneath it.
  if (state) {
    if (!state.selected) state.selected = new Set();
    body.querySelectorAll('input[data-finding]').forEach((box) => {
      box.addEventListener('change', () => {
        const finding = state.findings[parseInt(box.getAttribute('data-finding'), 10)];
        if (!finding) return;
        if (box.checked) state.selected.add(finding.id);
        else state.selected.delete(finding.id);
      });
    });
  }

  body.querySelectorAll('[data-scan]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      scanCleaner(cleaner.id);
    });
  });

  const selectAll = body.querySelector('[data-select-all]');
  if (selectAll) {
    selectAll.addEventListener('click', (e) => {
      e.stopPropagation();
      const boxes = body.querySelectorAll('input[data-finding]:not([disabled])');
      const allChecked = Array.from(boxes).every((b) => b.checked);
      boxes.forEach((b) => {
        b.checked = !allChecked;
        // dispatch so the same listener above keeps state in step - otherwise
        // Select all ticks the boxes and the persisted selection disagrees.
        b.dispatchEvent(new Event('change'));
      });
    });
  }

  const purge = body.querySelector('[data-purge]');
  if (purge) {
    purge.addEventListener('click', (e) => {
      e.stopPropagation();
      purgeCleaner(cleaner.id);
    });
  }

  applyTierLocks();
}

// What is about to happen, in the terms of the thing being moved. Telling
// someone their folders are "registry entries" is how a confirmation dialog
// stops being read.
function purgeExplanation(cleanerId, selected) {
  if (cleanerId === 'path') {
    return (
      'Your whole PATH setting is saved to a backup file before it is rewritten. Restoring this from the ' +
      'Quarantine tab puts the exact previous PATH back.'
    );
  }

  const files = selected.filter((f) => f.kind === 'file');
  if (files.length === selected.length && files.length > 0) {
    const bytes = files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
    const size = bytes > 0 ? ` That frees about ${formatBytes(bytes)}.` : '';
    return (
      `${files.length} folder(s) move into the Quarantine tab, where they stay until you delete them.${size} ` +
      'Nothing is deleted now, and you can put any of it back.'
    );
  }

  return (
    'The selected registry entries are saved to a backup file, then removed. Nothing is deleted - it all ' +
    'goes to the Quarantine tab, and you can put it back from there.'
  );
}

async function purgeCleaner(cleanerId) {
  if (!guardFullMode()) return;
  const state = cleanerState[cleanerId];
  const body = document.getElementById(`cleaner-body-${cleanerId}`);
  const checked = Array.from(body.querySelectorAll('input[type="checkbox"]:checked'));

  if (checked.length === 0) {
    toast('Tick what you want moved to quarantine first.', 'warn');
    return;
  }

  const selected = checked.map((box) => state.findings[parseInt(box.getAttribute('data-finding'), 10)]);

  const ok = await confirmDialog({
    title: `Quarantine ${selected.length} item(s)?`,
    body: purgeExplanation(cleanerId, selected),
    confirmLabel: 'Move to quarantine'
  });
  if (!ok) return;

  const res = await window.api.cleanerPurge({ cleaner: cleanerId, items: selected });

  if (!res || res.success !== true) {
    toast(`Nothing was removed: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
    return;
  }

  const count = res.quarantinedCount ?? selected.length;
  toast(`${count} item(s) moved to quarantine. You can put them back any time from the Quarantine tab.`, 'success', 6000);
  applyPurgeResult(cleanerId, selected, count);
}

// 7oo.5: update the view for what just happened instead of re-running the
// whole scan. This used to end in `await scanCleaner(cleanerId)` - a fresh
// full sweep, measured at 180 seconds for context menus on the operator's
// machine - to learn something the app already knew: the items it just
// quarantined are gone. Quarantining is a change WE made, so the result is
// not in doubt, and re-deriving it from scratch was pure waiting. Shared by
// purgeCleaner (one section) and cleanAllCleaners (every scanned section).
function applyPurgeResult(cleanerId, purgedItems, count) {
  const state = cleanerState[cleanerId];
  const purgedIds = new Set(purgedItems.map((f) => f.id));
  state.findings = state.findings.filter((f) => !purgedIds.has(f.id));
  if (state.selected) purgedIds.forEach((id) => state.selected.delete(id));
  state.resolvedCount = (state.resolvedCount || 0) + count;

  renderCleanerBody(CLEANERS.find((c) => c.id === cleanerId));
  updateCleanerBadge(cleanerId);
}

// Scan All's complement: purge every removable finding in every section that
// already has a scan on screen, not just what happens to be ticked in each
// one - the same "everywhere, not just here" relationship Scan All has to a
// single section's Scan button. One aggregate confirmation covers every
// section at once; if any selected item is Advanced-risk, that confirmation
// requires typing CLEAN rather than a single click (mirrors the untrusted-
// uninstaller warning in startQueue() above) so an unsafe-tier item can never
// be removed as an unnoticed side effect of a routine "clean everything" click.
async function cleanAllCleaners() {
  if (!guardFullMode()) return;

  const byCleaner = CLEANERS
    .filter((c) => !c.needsKeyword)
    .map((cleaner) => ({ cleaner, state: cleanerState[cleaner.id] }))
    .filter(({ state }) => state && state.scanned && state.findings.length > 0)
    .map(({ cleaner, state }) => ({
      cleaner,
      items: state.findings.filter((f) => f.removable !== false)
    }))
    .filter(({ items }) => items.length > 0);

  if (byCleaner.length === 0) {
    toast('Nothing to clean yet - scan first, or everything found so far is list-only.', 'info');
    return;
  }

  const totalCount = byCleaner.reduce((sum, b) => sum + b.items.length, 0);
  const advanced = byCleaner.flatMap(({ cleaner, items }) =>
    items.filter((f) => f.risk === 'Advanced').map((f) => ({ cleaner, finding: f }))
  );
  const sectionSummary = byCleaner.map(({ cleaner, items }) => `${cleaner.title}: ${items.length}`).join('\n');

  const ok = advanced.length > 0
    ? await confirmDialog({
        title: `Clean ${totalCount} item(s) across ${byCleaner.length} section(s)?`,
        body:
          `${sectionSummary}\n\n${advanced.length} of these are flagged Advanced risk - removing them can ` +
          `affect software that is still installed:\n\n${advanced.map(({ cleaner, finding }) => `${cleaner.title} - ${finding.label}`).join('\n')}\n\n` +
          'Everything still moves to Quarantine first and can be put back. Type CLEAN to include the ' +
          'Advanced-risk items too, or cancel and clear the other sections individually to review these first.',
        confirmLabel: 'Clean all',
        typed: 'CLEAN'
      })
    : await confirmDialog({
        title: `Clean ${totalCount} item(s) across ${byCleaner.length} section(s)?`,
        body: `${sectionSummary}\n\nEverything moves to the Quarantine tab first and can be put back from there.`,
        confirmLabel: 'Clean all'
      });
  if (!ok) return;

  let cleanedTotal = 0;
  const failedSections = [];
  for (const { cleaner, items } of byCleaner) {
    const res = await window.api.cleanerPurge({ cleaner: cleaner.id, items });
    if (!res || res.success !== true) {
      failedSections.push(cleaner.title);
      continue;
    }
    const count = res.quarantinedCount ?? items.length;
    cleanedTotal += count;
    applyPurgeResult(cleaner.id, items, count);
  }

  if (failedSections.length > 0) {
    toast(
      `${cleanedTotal} item(s) moved to quarantine. ${failedSections.join(', ')} could not be cleaned - try that section individually.`,
      'warn',
      9000
    );
  } else {
    toast(
      `${cleanedTotal} item(s) moved to quarantine across ${byCleaner.length} section(s). You can put any of it back from the Quarantine tab.`,
      'success',
      6000
    );
  }
}

// ==========================================
// REQ-20 - FORCE UNINSTALL (Stage 6)
// ==========================================
// Three ways in, one review-gated pipeline out. Forcing is the fallback: when
// a working uninstaller still exists, Vanish says so and offers to run it.

let brokenEntries = [];
let forceFindings = { files: [], registry: [] };
let forceContext = { name: null, extraRegistryPath: null };
let forceScanMode = 'Moderate';

function setupForceUninstall() {
  document.getElementById('btn-rescan-broken').addEventListener('click', () => loadBrokenEntries());
  document.getElementById('btn-force-scan').addEventListener('click', () => runForceScan());

  document.getElementById('force-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runForceScan();
  });

  document.getElementById('force-mode-toggle').addEventListener('click', (e) => {
    if (!e.target.classList.contains('toggle-btn')) return;
    document.querySelectorAll('#force-mode-toggle .toggle-btn').forEach((b) => b.classList.remove('active'));
    e.target.classList.add('active');
    forceScanMode = e.target.getAttribute('data-mode');
  });
}

function resetForcePanel() {
  const modeBtns = document.querySelectorAll('#force-mode-toggle .toggle-btn');
  modeBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-mode') === (appSettings.defaultScanMode || 'Moderate')));
  forceScanMode = appSettings.defaultScanMode || 'Moderate';
  if (brokenEntries.length === 0) loadBrokenEntries();
}

async function loadBrokenEntries() {
  const loading = document.getElementById('broken-loading');
  const empty = document.getElementById('broken-empty');
  const list = document.getElementById('broken-list');

  loading.style.display = 'flex';
  empty.style.display = 'none';
  list.innerHTML = '';

  const res = await window.api.findBrokenEntries();
  loading.style.display = 'none';

  if (!res || res.success !== true) {
    empty.style.display = 'flex';
    empty.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color: var(--color-danger);"></i>
      <div>${esc((res && res.error) || 'Could not read your installed programs.')}</div>`;
    return;
  }

  brokenEntries = res.findings || [];
  if (brokenEntries.length === 0) {
    empty.style.display = 'flex';
    return;
  }

  list.innerHTML = brokenEntries
    .map(
      (entry, index) => `
      <div class="vault-entry" data-broken-index="${esc(index)}">
        <div class="vault-entry-header">
          <i class="fa-solid fa-chevron-right vault-entry-chevron"></i>
          <div class="vault-entry-main">
            <div class="vault-entry-app">
              ${esc(entry.displayName)}
              <span class="status-pill ${entry.uninstallerOk ? 'restored' : 'quarantined'}">
                ${entry.uninstallerOk ? 'partly broken' : 'cannot uninstall'}
              </span>
            </div>
            <div class="vault-entry-meta">${esc(entry.publisher)} &nbsp;-&nbsp; ${esc(entry.hiveLabel)}</div>
          </div>
          <div class="vault-entry-actions">
            <button class="btn-sec btn-compact" data-force-entry="${esc(index)}">
              <i class="fa-solid fa-magnifying-glass"></i> Find what it left behind
            </button>
          </div>
        </div>
        <div class="vault-entry-body">
          <div class="vault-item-group-title">Why this is broken</div>
          ${(entry.reasons || [])
            .map((r) => `<div class="vault-item"><span class="vault-item-path">${esc(r)}</span></div>`)
            .join('')}
          <div class="vault-item-group-title">Registry entry</div>
          <div class="vault-item"><span class="vault-item-path">${esc(entry.registryPath)}</span></div>
          ${
            entry.uninstallString
              ? `<div class="vault-item-group-title">The uninstall command it recorded</div>
                 <div class="vault-item"><span class="vault-item-path">${esc(entry.uninstallString)}</span></div>`
              : ''
          }
        </div>
      </div>`
    )
    .join('');

  list.querySelectorAll('.vault-entry').forEach((el) => {
    const index = parseInt(el.getAttribute('data-broken-index'), 10);
    el.querySelector('.vault-entry-header').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      el.classList.toggle('expanded');
    });
    el.querySelector('[data-force-entry]').addEventListener('click', () => scanBrokenEntry(index));
  });
}

async function scanBrokenEntry(index) {
  const entry = brokenEntries[index];
  if (!entry) return;

  // Forcing is the fallback. If the app can still uninstall itself, say so.
  if (entry.uninstallerOk) {
    const runIt = await confirmDialog({
      title: 'This one can still uninstall itself',
      body:
        `${entry.displayName} still has a working uninstaller, even though ${entry.reasons.join('; ')}. ` +
        'Letting the program uninstall itself is always cleaner than forcing it. Run it now instead?',
      confirmLabel: 'Run its uninstaller'
    });
    if (runIt) {
      if (!guardFullMode()) return;
      const res = await runNativeUninstaller({
        type: 'Desktop',
        name: entry.displayName,
        registryPath: entry.registryPath
      });
      toast(
        res.success
          ? 'The uninstaller finished. Scan again to check for leftovers.'
          : `The uninstaller did not finish: ${res.error}`,
        res.success ? 'success' : 'warn',
        7000
      );
      return;
    }
  }

  document.getElementById('force-name-input').value = entry.displayName;
  document.getElementById('force-path-input').value = entry.installLocation || '';
  await runForceScan({ extraRegistryPath: entry.registryPath, publisher: entry.publisher });
}

async function runForceScan(options = {}) {
  const name = document.getElementById('force-name-input').value.trim();
  const installLocation = document.getElementById('force-path-input').value.trim();
  const results = document.getElementById('force-results');

  if (!name && !installLocation) {
    toast('Enter a program name or its folder first.', 'warn');
    return;
  }

  results.innerHTML = `<div class="panel-state"><i class="fa-solid fa-spinner fa-spin"></i>
    <div>Looking for anything left behind by "${esc(name || installLocation)}"...</div></div>`;

  const scan = await window.api.scanLeftovers({
    appName: name || installLocation.split('\\').pop(),
    publisher: options.publisher || '',
    installLocation,
    mode: forceScanMode
  });

  forceFindings = {
    files: (scan && scan.files) || [],
    registry: (scan && scan.registry) || []
  };
  forceContext = { name: name || installLocation, extraRegistryPath: options.extraRegistryPath || null };

  // The orphaned uninstall key is the thing that keeps a dead app listed, so it
  // belongs in the proposal - flagged as such, and quarantined like the rest.
  if (forceContext.extraRegistryPath) {
    forceFindings.registry.unshift({
      path: forceContext.extraRegistryPath,
      type: 'Key',
      risk: 'Safe',
      isUninstallEntry: true
    });
  }

  renderForceResults();
}

function renderForceResults() {
  const results = document.getElementById('force-results');
  const files = forceFindings.files || [];
  const registry = forceFindings.registry || [];
  const total = files.length + registry.length;

  if (total === 0) {
    results.innerHTML = `<div class="panel-state">
      <i class="fa-solid fa-circle-check" style="color: var(--color-success);"></i>
      <div>Nothing left behind by "${esc(forceContext.name)}" was found at this depth.</div></div>`;
    return;
  }

  const fileRows = files
    .map(
      (f, i) => `
      <div class="finding-row">
        <input type="checkbox" data-force-file="${esc(i)}" ${f.risk === 'Advanced' ? '' : 'checked'}>
        <div class="finding-main">
          <div class="finding-label mono">${esc(f.path)}</div>
          <div class="finding-evidence">${esc(f.type)}</div>
        </div>
        <span class="finding-risk ${esc((f.risk || 'safe').toLowerCase())}">${esc(f.risk)}</span>
      </div>`
    )
    .join('');

  const regRows = registry
    .map(
      (r, i) => `
      <div class="finding-row">
        <input type="checkbox" data-force-reg="${esc(i)}" ${r.risk === 'Advanced' ? '' : 'checked'}>
        <div class="finding-main">
          <div class="finding-label mono">${esc(r.path)}</div>
          <div class="finding-evidence">${
            r.isUninstallEntry
              ? 'The uninstall entry itself. Removing this is what takes the program out of Programs and Features.'
              : esc(r.type)
          }</div>
        </div>
        <span class="finding-risk ${esc((r.risk || 'safe').toLowerCase())}">${esc(r.risk)}</span>
      </div>`
    )
    .join('');

  results.innerHTML = `
    <div class="settings-group-title">Found ${total} item(s) left behind by "${esc(forceContext.name)}"</div>
    <div class="cleaner-section expanded">
      <div class="cleaner-section-body" style="display:block; border-top:none;">
        ${files.length ? `<div class="vault-item-group-title">Files and folders (${files.length})</div><div class="cleaner-findings">${fileRows}</div>` : ''}
        ${registry.length ? `<div class="vault-item-group-title">Registry entries (${registry.length})</div><div class="cleaner-findings">${regRows}</div>` : ''}
        <div class="cleaner-actions">
          <button class="btn-sec btn-compact" id="btn-force-select-all">Select all</button>
          <button class="btn-danger btn-compact" id="btn-force-purge" data-destructive="true">
            <i class="fa-solid fa-box-archive"></i> Move selected to quarantine
          </button>
        </div>
      </div>
    </div>`;

  document.getElementById('btn-force-select-all').addEventListener('click', () => {
    const boxes = results.querySelectorAll('input[type="checkbox"]');
    const allChecked = Array.from(boxes).every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !allChecked; });
  });
  document.getElementById('btn-force-purge').addEventListener('click', forcePurge);
  applyTierLocks();
}

async function forcePurge() {
  if (!guardFullMode()) return;
  const results = document.getElementById('force-results');

  const files = Array.from(results.querySelectorAll('[data-force-file]:checked'))
    .map((b) => forceFindings.files[parseInt(b.getAttribute('data-force-file'), 10)])
    .map((f) => ({ path: f.path }));
  const registry = Array.from(results.querySelectorAll('[data-force-reg]:checked'))
    .map((b) => forceFindings.registry[parseInt(b.getAttribute('data-force-reg'), 10)])
    .map((r) => ({ path: r.path }));

  if (files.length + registry.length === 0) {
    toast('Tick what you want moved to quarantine first.', 'warn');
    return;
  }

  const ok = await confirmDialog({
    title: `Force uninstall "${forceContext.name}"?`,
    body:
      `${files.length + registry.length} item(s) will be moved to quarantine. Files are moved, and registry ` +
      'entries are saved to a backup file first. Nothing is deleted, and restoring this from the Quarantine ' +
      'tab brings the program listing back too. This skips the program\'s own uninstaller, so the program ' +
      'gets no chance to clean up after itself.',
    confirmLabel: 'Move to quarantine'
  });
  if (!ok) return;

  const res = await window.api.purgeRemnants({
    files,
    registry,
    sourceApp: forceContext.name,
    origin: 'force-uninstall'
  });

  if (!res || res.success !== true) {
    toast(`Nothing was removed: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
    return;
  }

  const failed = [...(res.files || []), ...(res.registry || [])].filter((i) => i.status === 'failed');
  if (failed.length > 0) {
    toast(
      `${res.quarantinedCount} item(s) moved to quarantine. ${failed.length} were left in place (${failed[0].error}).`,
      'warn',
      9000
    );
  } else {
    toast(`${res.quarantinedCount} item(s) moved to quarantine. You can put them back any time from the Quarantine tab.`, 'success', 6000);
  }

  await loadBrokenEntries();
  await runForceScan({ extraRegistryPath: null });
}

// ==========================================
// GUIDED TOUR
// ==========================================
//
// A spotlight cutout over the real, live sidebar item for each step, not a
// slideshow describing the app in the abstract - see the CSS comment on
// .tour-spotlight for the mechanism. Auto-shown once per the operator's own
// wording ("runnable on demand from settings" implies it is not just a
// first-run thing) - see the hasSeenTour comment in lib/store.js for when
// the automatic showing does and does not fire.

const TOUR_STEPS = [
  {
    selector: null,
    title: 'Welcome to Vanish',
    body: 'A 60-second look at what each part of the app does. Skip any time - you can always replay this from Settings.'
  },
  {
    selector: '#admin-indicator',
    title: 'Audit Mode vs Full Mode',
    body: 'Vanish opens read-only by default. It can list, scan and explain everything, but cannot remove anything until you grant administrator rights - nothing here can surprise you.'
  },
  {
    selector: '.nav-item[data-tab="all-apps"]',
    title: 'All Programs',
    body: 'Every installed program, desktop and Store apps together - including real install sizes for Steam and Epic games, not just whatever Windows happens to track.'
  },
  {
    selector: '.nav-item[data-tab="audit"]',
    title: 'Health Advisor',
    body: 'A system-wide check: startup items, redundant software, network activity, disk health - in plain language, with a verdict, not just a wall of numbers.'
  },
  {
    selector: '.nav-item[data-tab="system-clean"]',
    title: 'System Clean',
    body: 'Finds leftovers a normal uninstall leaves behind - dead registry entries, orphaned services, broken shortcuts - and shows you before touching anything.'
  },
  {
    selector: '.nav-item[data-tab="quarantine"]',
    title: 'Nothing is ever just deleted',
    body: 'Every removal goes here first. Anything Vanish takes off your PC can be put back from this tab, until you choose to delete it for good.'
  },
  {
    selector: '.nav-item[data-tab="settings"]',
    title: 'Come back any time',
    body: "That's the tour. This is also where it lives if you want to see it again, or tune how Vanish behaves."
  }
];

let tourStepIndex = 0;

function setupTour() {
  document.getElementById('tour-skip').addEventListener('click', endTour);
  document.getElementById('tour-back').addEventListener('click', () => {
    if (tourStepIndex > 0) {
      tourStepIndex--;
      renderTourStep();
    }
  });
  document.getElementById('tour-next').addEventListener('click', onTourNext);

  const takeTourBtn = document.getElementById('set-take-tour');
  if (takeTourBtn) takeTourBtn.addEventListener('click', startTour);

  window.addEventListener('resize', () => {
    if (document.getElementById('tour-overlay').classList.contains('active')) {
      positionTourSpotlight(TOUR_STEPS[tourStepIndex].selector);
    }
  });
}

function startTour() {
  tourStepIndex = 0;
  document.getElementById('tour-overlay').classList.add('active');
  renderTourStep();
}

function endTour() {
  document.getElementById('tour-overlay').classList.remove('active');
  if (!appSettings.hasSeenTour) saveSettings({ hasSeenTour: true });
}

function onTourNext() {
  // A step pointing at a sidebar tab switches to it - so the spotlight
  // frames the real destination, not just the nav item with the previous
  // tab's content sitting dimmed behind it.
  const step = TOUR_STEPS[tourStepIndex];
  if (step && step.selector && step.selector.startsWith('.nav-item')) {
    const target = document.querySelector(step.selector);
    const tab = target && target.getAttribute('data-tab');
    if (tab) switchTab(tab);
  }

  if (tourStepIndex < TOUR_STEPS.length - 1) {
    tourStepIndex++;
    // Two frames: one for the tab-switch's own DOM changes to apply, one
    // for layout to settle, before re-measuring the next target's position.
    requestAnimationFrame(() => requestAnimationFrame(renderTourStep));
  } else {
    endTour();
  }
}

function renderTourStep() {
  const step = TOUR_STEPS[tourStepIndex];
  if (!step) {
    endTour();
    return;
  }

  document.getElementById('tour-step-counter').textContent = `${tourStepIndex + 1} of ${TOUR_STEPS.length}`;
  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-body').textContent = step.body;

  const backBtn = document.getElementById('tour-back');
  const nextBtn = document.getElementById('tour-next');
  backBtn.style.visibility = tourStepIndex === 0 ? 'hidden' : 'visible';
  nextBtn.textContent = tourStepIndex === TOUR_STEPS.length - 1 ? 'Done' : 'Next';

  positionTourSpotlight(step.selector);
}

function positionTourSpotlight(selector) {
  const spotlight = document.getElementById('tour-spotlight');
  const tooltip = document.getElementById('tour-tooltip');
  const target = selector ? document.querySelector(selector) : null;

  if (!target) {
    // No spotlight target (the welcome step): the dim comes from the SAME
    // box-shadow trick as every other step, just around a zero-size box, so
    // it still darkens the whole viewport instead of leaving the busy app
    // list at full brightness behind a 40%-opaque tooltip card (l0t-shaped
    // bug: 'is-hidden' set opacity:0, which silently killed its own
    // box-shadow along with the cutout it was meant to hide).
    spotlight.classList.remove('is-hidden');
    spotlight.style.top = '50%';
    spotlight.style.left = '50%';
    spotlight.style.width = '0px';
    spotlight.style.height = '0px';
    tooltip.style.transform = 'translate(-50%, -50%)';
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    return;
  }

  const rect = target.getBoundingClientRect();
  const pad = 6;
  spotlight.classList.remove('is-hidden');
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${rect.height + pad * 2}px`;

  // Prefer the right of the target (every current target is in the left
  // sidebar); fall back to the left if there is not enough room, and clamp
  // vertically so the tooltip never runs off the bottom of a short window.
  tooltip.style.transform = 'none';
  const tooltipWidth = 320;
  const tooltipHeightEstimate = 170;
  const margin = 16;

  let left = rect.right + margin;
  if (left + tooltipWidth > window.innerWidth - margin) {
    left = Math.max(margin, rect.left - tooltipWidth - margin);
  }
  let top = rect.top;
  if (top + tooltipHeightEstimate > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - tooltipHeightEstimate - margin);
  }
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}
