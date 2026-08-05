// Vanish Frontend UI Controller (renderer.js)
// Interacts with Electron preload bridge APIs

let allApps = [];
let selectedApp = null;
let activeTab = 'all-apps';
let filterText = '';
let filterType = 'all';
let sortOption = 'name-asc';
let isAdmin = false;

// SCR-01: one flag drives the banner and every destructive control's state.
// The real boundary is main.js/scanner.ps1 (NFR-02) - this is presentation.
let tierState = { tier: 'audit', isFullMode: false, offerElevation: false, bannerText: '' };
let appSettings = { autoPurgeEnabled: false, autoPurgeRetentionDays: 30, processRefreshSeconds: 2, startupMode: 'audit' };

const TIER_TOOLTIP = 'Requires Full Mode - restart as administrator';

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
    toast('Continuing in Audit Mode. Scanning and reporting stay available.', 'info');
  };
  document.getElementById('btn-elevate-now').onclick = () => requestElevation(overlay);
  document.getElementById('btn-banner-elevate').onclick = () => requestElevation(null);
}

async function requestElevation(overlay) {
  const res = await window.api.relaunchElevated();
  if (res && res.success) return; // this instance is being replaced (D-09)
  if (overlay) overlay.classList.remove('active');
  toast('Elevation was declined. Vanish stays in Audit Mode.', 'warn');
}

// Reused by every destructive UI path so a locked control can never act.
function guardFullMode() {
  if (isAdmin) return true;
  toast(tierState.bannerText || 'Running in Audit Mode - elevate to enable cleaning and uninstallation.', 'warn');
  return false;
}

// Load both Desktop and UWP Apps
async function loadApplications() {
  showLoadingState();
  
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
      type: String(app.type ?? 'Desktop')
    }));

    updateDashboardStats();
    filterAndRenderApps();
  } catch (error) {
    console.error('Failed to load apps:', error);
    elements.appsTbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 48px; color: var(--color-danger);">
          <i class="fa-solid fa-circle-xmark" style="font-size: 28px; margin-bottom: 12px;"></i>
          <div>Failed to gather applications: ${error.message}</div>
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
        <div>Gathering and mapping installed applications on your system...</div>
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

// Update stats count & size
function updateDashboardStats() {
  const totalCount = allApps.length;
  const uwpCount = allApps.filter(app => app.type === 'UWP').length;
  
  let totalBytes = 0;
  allApps.forEach(app => {
    if (app.sizeBytes) totalBytes += app.sizeBytes;
  });
  
  elements.statTotalApps.textContent = totalCount;
  elements.statUwpApps.textContent = uwpCount;
  elements.statTotalSize.textContent = formatBytes(totalBytes, 1);
}

// Filter and Sort Handler
function filterAndRenderApps() {
  let filtered = allApps.filter(app => {
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
}

// Render dynamic rows in table
function renderTable(apps) {
  if (apps.length === 0) {
    elements.appsTbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 48px; color: var(--text-gray);">
          <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 12px;"></i>
          <div>No applications found matching your criteria.</div>
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
        <span class="badge-type ${esc(app.type.toLowerCase())}">${app.type === 'UWP' ? 'Windows App' : 'Desktop'}</span>
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
  elements.detType.textContent = app.type === 'UWP' ? 'Universal Windows Platform (UWP)' : 'Classic Desktop Executable';
  
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
  
  // Sort selector
  elements.sortSelector.addEventListener('change', (e) => {
    sortOption = e.target.value;
    filterAndRenderApps();
  });
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

  if (tabName === 'all-apps') {
    if (appsContentArea) appsContentArea.style.display = '';
    elements.searchBar.disabled = false;
    elements.typeToggle.style.pointerEvents = 'all';
    elements.typeToggle.style.opacity = '1';
    elements.sortSelector.disabled = false;
    elements.detailsSidebar.classList.remove('active');
    loadApplications();
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

  if (tabName === 'audit') loadAuditData();
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
  startupElevated.addEventListener('change', () =>
    saveSettings({ startupMode: startupElevated.checked ? 'full' : 'audit' })
  );

  autoPurge.addEventListener('change', async () => {
    if (autoPurge.checked) {
      const ok = await confirmDialog({
        title: 'Enable automatic purge?',
        body:
          `Quarantined entries older than ${retention.value} day(s) will be permanently deleted at app ` +
          'start, without another prompt. This is the only setting that lets Vanish destroy something ' +
          'you did not click that day.',
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

  document.getElementById('set-open-vault').addEventListener('click', () => window.api.openVaultFolder());
  document.getElementById('set-open-data').addEventListener('click', () => window.api.openDataFolder());
}

async function saveSettings(patch) {
  appSettings = await window.api.setSettings(patch);
  syncSettingsPanel();
  syncQuarantineSettingsUI();
  toast('Setting saved.', 'success', 2200);
}

function syncSettingsPanel() {
  const autoPurge = document.getElementById('set-auto-purge');
  if (!autoPurge) return;
  autoPurge.checked = appSettings.autoPurgeEnabled === true;
  document.getElementById('set-retention-days').value = appSettings.autoPurgeRetentionDays;
  document.getElementById('set-scan-mode').value = appSettings.defaultScanMode || 'Moderate';
  document.getElementById('set-process-refresh').value = appSettings.processRefreshSeconds;
  document.getElementById('set-startup-elevated').checked = appSettings.startupMode === 'full';

  // Audit Mode can read the configuration but not change deletion policy.
  autoPurge.disabled = !isAdmin;
  document.getElementById('set-retention-days').disabled = !isAdmin;
}

async function loadSettingsPanel() {
  appSettings = await window.api.getSettings();
  syncSettingsPanel();

  const info = await window.api.getAppInfo();
  document.getElementById('set-vault-path').textContent = info.vaultRoot;
  document.getElementById('set-vault-stats').textContent =
    `${info.vaultEntryCount} entry(s) held - ${formatBytes(info.vaultBytes, 1)} on disk`;
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
    ['Engine', 'PowerShell 5.1 (scanner.ps1)'],
    ['Data directory', info.dataDir],
    ['Runtime network calls', 'None'],
    ['Telemetry', 'None']
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
    if (selectedApp) {
      openUninstallWizard(selectedApp);
    }
  });

  const btnQueue = document.getElementById('btn-queue-app');
  if (btnQueue) {
    btnQueue.addEventListener('click', () => {
      if (!guardFullMode()) return;
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
  elements.wizAppVersion.textContent = `Version ${app.version || 'Unknown'} - ${app.type === 'UWP' ? 'Windows App' : 'Desktop Program'}`;
  
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
      elements.nativeUninstPromptText.textContent = "UWP applications can be uninstalled silently via Windows AppX Package services. Click 'Launch Silent Uninstall' below.";
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-bolt"></i> <span>Launch Silent Uninstall</span>';
    } else {
      elements.nativeUninstPromptText.textContent = "We are ready to launch the program's native uninstaller wizard. Click the button below, then follow the instructions on your screen. Once done, click Next to scan remnants.";
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-circle-play"></i> <span>Launch Native Uninstaller</span>';
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
        'Only continue if you recognise it. Type RUN to run it anyway.',
      confirmLabel: 'Run it anyway',
      typed: 'RUN'
    });
    if (!ack) {
      return { success: false, declined: true, error: 'Not run: the uninstaller was not acknowledged.' };
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
          toast(`Restore point failed: ${res.error}. Continuing - the quarantine vault is still your undo.`, 'warn', 7000);
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
        toast(`Scanning leftovers failed: ${err.message}`, 'error');
        showScreen(2);
      }
    }
  });

  // Launch Native Uninstaller click
  elements.btnLaunchNative.addEventListener('click', async () => {
    if (!guardFullMode()) return;
    elements.btnLaunchNative.disabled = true;

    if (selectedApp.type === 'UWP') {
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Uninstalling Package...</span>';
    } else {
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Native Uninstaller Running...</span>';
    }

    const res = await runNativeUninstaller(selectedApp);

    elements.btnLaunchNative.disabled = false;
    elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-circle-play"></i> <span>Launch Native Uninstaller</span>';

    if (selectedApp.type === 'UWP') {
      if (res.success) {
        toast('Store package removed. Scanning for leftovers.', 'success');
      } else {
        toast(`Package removal failed: ${res.error}. Scanning for leftovers anyway.`, 'warn');
      }
      elements.btnWizNext.click();
    } else if (res.success) {
      // The engine now waits for the uninstaller and traps its exit code, so
      // this is a result rather than a "we launched something" guess.
      toast(
        res.rebootRequired
          ? 'Uninstaller finished - Windows needs a reboot to complete it. Click Scan Leftovers.'
          : 'Uninstaller finished. Click Scan Leftovers.',
        'success',
        7000
      );
    } else if (res.declined) {
      toast(res.error, 'warn');
    } else {
      toast(`Uninstaller did not complete: ${res.error} You can still scan for leftovers.`, 'warn', 7000);
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
        body: 'No leftovers are ticked. Finish the uninstall without quarantining anything?',
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
        `These files and registry entries move to the vault immediately, not just when you clear it out. ` +
        'If any of them are still needed by something, that something stops working the moment you confirm ' +
        'this - restore it from Quarantine Manager any time to bring it back exactly as it was.',
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
      toast(`Quarantine failed: ${err.message}`, 'error');
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
      'The quarantine vault could not be written, so every selected leftover was left exactly where it was.';
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

  document.getElementById('lbl-space-saved').textContent = formatBytes(wizState.spaceReclaimedBytes, 1);
  document.getElementById('lbl-quarantined-count').textContent = String(quarantined);
  document.getElementById('btn-review-quarantine').style.display = quarantined > 0 ? '' : 'none';

  if (problems.length === 0) {
    icon.className = 'fa-solid fa-box-archive';
    title.textContent = 'Leftovers quarantined';
    elements.lblPurgeResultText.textContent =
      `${quarantined} of ${requestedCount} selected item(s) were moved into the quarantine vault. ` +
      'Files were moved, registry keys were exported to a .reg restore manifest before removal. ' +
      'Nothing has been deleted - restore any of it from the Quarantine tab.' +
      (missing > 0 ? ` ${missing} item(s) were already gone.` : '');
    failuresBox.style.display = 'none';
  } else {
    hero.classList.add('partial');
    icon.className = 'fa-solid fa-triangle-exclamation';
    title.textContent = 'Quarantined, with items left in place';
    elements.lblPurgeResultText.textContent =
      `${quarantined} item(s) moved into the vault. ${problems.length} could not be moved and were left untouched - ` +
      'nothing is half-removed.';
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
            <div class="reason">${esc(p.error || 'Unknown reason')}</div>
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
      `Vanish will take ownership of "${item.originalPath}" and grant Administrators full control, then retry ` +
      'moving it to quarantine. This changes the permissions on that item permanently, even if you later ' +
      'restore it. It applies to this item only.',
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
    toast(`Ownership taken and item quarantined${row.aclElevated ? ' (permissions changed)' : ''}.`, 'success', 6000);
    const el = document.querySelector(`[data-failure-index="${index}"]`);
    if (el) {
      el.querySelector('.reason').textContent = 'Quarantined after taking ownership.';
      const actions = el.querySelector('.failure-actions');
      if (actions) actions.remove();
    }
  } else {
    toast(
      `Still could not move it: ${(row && row.error) || (res && res.error) || 'unknown error'}`,
      'error',
      8000
    );
  }
}

async function confirmCancel() {
  if (wizState.currentScreenIndex > 0 && wizState.currentScreenIndex < 6) {
    const ok = await confirmDialog({
      title: 'Cancel this uninstall?',
      body: 'The uninstall wizard will close. Anything already quarantined stays in the vault and can be restored from the Quarantine tab.',
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
        <h4 style="font-family: var(--font-title); font-weight: 700;">No leftovers found!</h4>
        <p style="font-size: 12px; color: var(--text-gray);">This application uninstalled completely clean.</p>
      </div>
    `;
    elements.lblLeftoversSummary.textContent = 'Discovered 0 remnants';
    return;
  }
  
  elements.lblLeftoversSummary.textContent = `Discovered ${files.length + registry.length} remnants`;
  
  // 1. Render Filesystem Remnants
  if (files.length > 0) {
    const fileGroup = document.createElement('div');
    fileGroup.className = 'tree-group';
    fileGroup.innerHTML = `
      <div class="tree-group-header">
        <i class="fa-solid fa-folder-open"></i>
        <span>Filesystem Remnants (${files.length})</span>
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
        <span>Registry Remnants (${registry.length})</span>
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

async function loadAuditData(force = false) {
  if (auditLoaded && !force) return;

  const loadingEl = document.getElementById('audit-loading');
  const contentEl = document.getElementById('audit-content');
  loadingEl.style.display = 'flex';
  contentEl.style.display = 'none';
  auditLoaded = false;

  try {
    // Fire all three PowerShell queries in parallel
    const [diag, startup, redundancy] = await Promise.all([
      window.api.getSystemDiagnostics(),
      window.api.getStartupItems(),
      window.api.getSoftwareRedundancy()
    ]);

    renderSysInfoCards(diag);
    renderDiskBars(diag.disks || []);
    renderStartupTable(startup);
    renderRedundancyGroups(redundancy);

    auditLoaded = true;
    loadingEl.style.display = 'none';
    contentEl.style.display = 'flex';
  } catch (err) {
    loadingEl.innerHTML = `
      <i class="fa-solid fa-circle-xmark" style="font-size: 28px; color: var(--color-danger);"></i>
      <div style="color: var(--color-danger);">Failed to load audit data: ${err.message}</div>
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

  const cards = [
    { label: 'Operating System',  value: diag.os?.caption  ?? 'Unknown',    sub: `Build ${diag.os?.build ?? '?'} - ${diag.os?.architecture ?? ''}` },
    { label: 'System Uptime',     value: uptimeStr || 'Unknown',              sub: '' },
    { label: 'CPU',               value: shortenCpuName(diag.cpu?.name),      sub: `${cpuClockGHz} - ${cpuSub}` },
    { label: 'RAM Usage',         value: ramPct || 'Unknown',                 sub: ramSub },
    { label: 'GPU',               value: diag.gpu ?? 'Unknown',               sub: '' },
    { label: 'Machine',           value: `${diag.manufacturer ?? ''} ${diag.model ?? ''}`.trim() || 'Unknown', sub: '' }
  ];

  grid.innerHTML = cards.map(c => `
    <div class="audit-info-card">
      <span class="card-label">${esc(c.label)}</span>
      <span class="card-value" title="${esc(c.value)}">${esc(c.value)}</span>
      ${c.sub ? `<span class="card-sub">${esc(c.sub)}</span>` : ''}
    </div>
  `).join('');
}

function shortenCpuName(name) {
  if (!name) return 'Unknown';
  // Collapse repeated whitespace and strip trailing processor brand noise
  return name.replace(/\s+/g, ' ').replace(/ CPU @.*$/, '').trim();
}

function renderDiskBars(disks) {
  const list = document.getElementById('audit-disk-list');
  if (!list) return;

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
    orphanBadge.textContent = `${orphans} orphaned`;
    orphanBadge.style.display = orphans > 0 ? 'inline-flex' : 'none';
  }

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center; padding:24px; color:var(--text-gray); font-size:13px;">
          <i class="fa-solid fa-circle-check" style="color:var(--color-success); margin-right:6px;"></i>No third-party startup items detected.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const sourceClass = item.source === 'Registry' ? 'registry'
                      : item.source === 'TaskScheduler' ? 'task'
                      : 'service';
    const sourceLabel = item.source === 'TaskScheduler' ? 'Task' : item.source;

    const dotClass = item.exeExists === false ? 'orphan'
                   : item.enabled ? 'active'
                   : 'passive';
    const statusLabel = item.exeExists === false ? 'Orphaned'
                      : item.enabled ? 'Active'
                      : 'Inactive';

    const cmdShort = (item.command || '').length > 80
      ? (item.command || '').slice(0, 80) + '...'
      : (item.command || '-');

    return `
      <tr class="app-row">
        <td style="font-size: 12px; font-weight: 600; color: var(--text-white);">${esc(item.name)}</td>
        <td><span class="source-badge ${esc(sourceClass)}">${esc(sourceLabel)}</span></td>
        <td>
          <span class="status-dot ${esc(dotClass)}"></span>
          <span style="font-size:12px; color: var(--text-gray);">${statusLabel}</span>
        </td>
        <td class="mono" style="color: var(--text-muted); word-break: break-all;" title="${esc(item.command || '')}">${esc(cmdShort)}</td>
      </tr>
    `;
  }).join('');
}

function renderRedundancyGroups(redundancy) {
  const list = document.getElementById('audit-redundancy-list');
  if (!list) return;

  const groups = redundancy.groups ?? [];

  if (groups.length === 0) {
    list.innerHTML = `
      <div class="audit-ok-box">
        <i class="fa-solid fa-circle-check"></i>
        No redundant software categories detected. Your install list looks lean.
      </div>
    `;
    return;
  }

  list.innerHTML = groups.map(g => {
    const pills = (g.apps ?? []).map(a =>
      `<span class="redundancy-pill">${esc(a.name)}</span>`
    ).join('');
    return `
      <div class="redundancy-group">
        <div class="redundancy-group-header">
          <span class="redundancy-category"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>${esc(g.category)}</span>
          <span class="audit-badge danger">${esc(g.count)} installed</span>
        </div>
        <div class="redundancy-tip">${esc(g.tip)}</div>
        <div class="redundancy-app-pills">${pills}</div>
      </div>
    `;
  }).join('');
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
          `Quarantined entries older than ${retentionInput.value} day(s) will be permanently deleted ` +
          'at app start, without another prompt. This is the one setting that lets Vanish destroy ' +
          'something without you clicking it that day.',
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
        ? `Automatic purge on, ${appSettings.autoPurgeRetentionDays} day retention.`
        : 'Automatic purge off. Nothing leaves the vault without a click.',
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
      (res && res.error) || 'Could not read the quarantine manifest.';
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

  return `
    <div class="vault-entry status-${esc(entry.status)}" data-entry-id="${esc(entry.id)}">
      <div class="vault-entry-header">
        <i class="fa-solid fa-chevron-right vault-entry-chevron"></i>
        <div class="vault-entry-main">
          <div class="vault-entry-app">
            ${esc(entry.sourceApp)}
            <span class="status-pill ${esc(entry.status)}">${esc(entry.status)}</span>
          </div>
          <div class="vault-entry-meta">
            ${esc(dateStr)} &nbsp;-&nbsp; ${esc(typeSummary)}${sizeLabel ? ' &nbsp;-&nbsp; ' + esc(sizeLabel) : ''}
            &nbsp;-&nbsp; via ${esc(entry.origin)}
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
        ${regRows ? `<div class="vault-item-group-title">Registry keys (.reg restore manifest)</div>${regRows}` : ''}
        <div class="vault-item-group-title">Vault location</div>
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
    toast(`Restore failed: ${(res && res.error) || 'unknown error'}`, 'error', 7000);
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
    toast(`Restore failed: ${(res && res.error) || 'unknown error'}`, 'error', 7000);
    return;
  }
  if (res.failed > 0) {
    const first = [...(res.files || []), ...(res.registry || [])].find((i) => i.status === 'failed');
    toast(
      `Restored with ${res.failed} failure(s). First: ${(first && first.error) || 'unknown'}`,
      'warn',
      8000
    );
  } else if (res.skipped > 0) {
    toast(`${res.skipped} item(s) skipped - originals still occupied.`, 'warn');
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
      `This permanently destroys ${itemCount} quarantined item(s) from "${entry.sourceApp}". ` +
      'This is the only action in Vanish that cannot be undone - after this there is no copy anywhere.',
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
    toast('Vault entry permanently deleted.', 'success');
  } else {
    toast(`Delete failed: ${(res && res.error) || 'unknown error'}`, 'error', 7000);
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

const PROCESS_SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  pid: (a, b) => a.pid - b.pid,
  cpu: (a, b) => a.cpuPercent - b.cpuPercent,
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
}

function stopProcessRefresh() {
  if (processTimer) {
    clearInterval(processTimer);
    processTimer = null;
  }
}

async function sampleProcesses() {
  // A sample takes ~1.5s on a busy machine; never stack them.
  if (processSampling) return;
  processSampling = true;
  try {
    const res = await window.api.listProcesses({ sampleMs: 400 });
    if (!res || res.success !== true) {
      document.getElementById('process-tbody').innerHTML = `
        <tr><td colspan="6" class="table-state" style="color: var(--color-danger);">
          <i class="fa-solid fa-circle-xmark"></i> ${esc((res && res.error) || 'The process engine did not respond.')}
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
    tbody.innerHTML = `<tr><td colspan="6" class="table-state">No process matches that filter.</td></tr>`;
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
  if (kind === 'suspicious-parent') return 'Shell spawn';
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
  document.getElementById('proc-det-company').textContent = proc.imagePath ? 'Running image' : 'No image path available';
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
      `${proc.name} is a core Windows process. Ending it will crash or force-restart your session - ` +
      'Vanish will not do this from Task Manager.',
      'error', 8000
    );
    return;
  }

  const isRisky = PROCESS_KILL_DENYLIST_RISKY.has(nameLower);
  const ok = await confirmDialog({
    title: `End ${proc.name}?`,
    body: isRisky
      ? `PID ${proc.pid} (${proc.name}) is a process Windows itself depends on for other things running ` +
        'right now - ending the wrong one can take out networking, audio, or your desktop shell until you ' +
        'sign out or reboot. Only proceed if you specifically mean to end this PID, not just "a" ' +
        `${proc.name} instance.`
      : `PID ${proc.pid} will be terminated immediately. Unsaved work in that process is lost, and ` +
        'ending a system process can destabilise Windows until you reboot.',
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
    toast(`Could not end ${proc.name}: ${(res && res.error) || 'unknown error'}`, 'error', 7000);
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

  results.innerHTML = '<div class="panel-state"><i class="fa-solid fa-spinner fa-spin"></i><div>Asking the Restart Manager...</div></div>';
  gracefulBtn.style.display = 'none';

  const res = await window.api.listLockers({ path });

  if (!res || res.success !== true) {
    results.innerHTML = `<div class="panel-state error"><i class="fa-solid fa-circle-xmark"></i><div>${esc((res && res.error) || 'Lookup failed.')}</div></div>`;
    return;
  }

  currentLockers = res.holders || [];

  if (currentLockers.length === 0) {
    results.innerHTML = `<div class="panel-state"><i class="fa-solid fa-circle-check"></i><div>${esc(res.note || 'No processes hold this path.')}</div></div>`;
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
    toast(`Unlock failed: ${(res && res.error) || 'unknown error'}`, 'error', 7000);
    return;
  }

  toast(`Asked ${res.totalTargets} target(s) to release; re-checking holders.`, 'success');
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
      'Graceful close was already offered. Forcing the process to end loses any unsaved work it holds. ' +
      'Vanish will suspend the process tree first so a watchdog cannot respawn the lock, then release it.',
    confirmLabel: 'Force end'
  });
  if (!ok) return;

  const res = await window.api.unlockPath({ path, force: true, suspendTree: true, pids: [pid] });
  if (res && res.success) {
    toast('Holder ended and lock released.', 'success');
    (res.notes || []).forEach((n) => toast(n, 'info', 6000));
  } else {
    toast(`Force end failed: ${(res && res.error) || 'unknown error'}`, 'error', 7000);
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
    toast('Queue will pause after the current application finishes.', 'info');
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
    toast((res && res.error) || 'Could not queue that application.', 'warn');
    return;
  }
  toast(`${app.name} added to the bulk queue.`, 'success');
  document.getElementById('queue-panel').classList.remove('collapsed');
  await refreshQueue();
}

async function startQueue() {
  if (!guardFullMode()) return;
  const pending = queueState.items.filter((i) => i.state === 'pending');
  if (pending.length === 0) {
    toast('Nothing pending in the queue.', 'info');
    return;
  }

  const ok = await confirmDialog({
    title: `Uninstall ${pending.length} application(s)?`,
    body:
      'Each application gets its own system restore point, then its uninstaller runs with the ' +
      'silent switches Vanish resolved for it. Uninstallers that insist on showing a window are ' +
      'marked "needs attention" so you can finish them by hand. Leftover scanning is separate - ' +
      'nothing is quarantined by this queue.',
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
        'These entries would run with administrator rights, but they are the kind of entry ' +
        'malware can create:\n\n' +
        detail +
        '\n\nSkip them unless you recognise every one. Type RUN to run them anyway; cancel to ' +
        'uninstall everything else and mark these as needing attention.',
      confirmLabel: 'Run them too',
      typed: 'RUN'
    });
    if (ackRisky) acknowledgedIds = risky.map((i) => i.id);
  }

  window.api.queueStart({ acknowledgedIds });
  toast(
    risky.length > 0 && acknowledgedIds.length === 0
      ? `Queue started. ${risky.length} untrusted uninstaller(s) will be skipped.`
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
        ? `<span class="method-badge" title="${esc(item.meta && item.meta.matchedName ? 'Matched: ' + item.meta.matchedName : 'Rule 15 heuristic sequence')}">${esc(item.method)}</span>`
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
      Queue paused: an uninstaller needs a reboot to finish. Restart Windows, then retry that item.`;
  } else if (counts.needsAttention) {
    footer.innerHTML = `<i class="fa-solid fa-circle-info"></i>
      Some uninstallers would not run silently and are waiting on you. ${esc(parts.join(', '))}`;
  } else {
    footer.textContent = parts.join(', ') || 'Queue empty';
  }

  applyTierLocks();
}

function queueItemDetail(item) {
  const meta = item.meta || {};
  if (item.state === 'failed' && meta.error) return meta.error;
  if (item.state === 'failed' && item.exitCode !== null) return `Exit code ${item.exitCode}`;
  if (item.state === 'rebootRequired') return `Exit code ${item.exitCode} - restart to finish`;
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
    title: 'Context menu handlers',
    desc: 'Shell extensions whose COM server is missing. These are what make a right-click menu slow or show dead entries.'
  },
  {
    id: 'services',
    icon: 'fa-gears',
    title: 'Orphaned services',
    desc: 'Service entries whose ImagePath points at an executable that is no longer on disk. Boot-start drivers are deliberately excluded.'
  },
  {
    id: 'drivers',
    icon: 'fa-microchip',
    title: 'Driver store packages',
    desc: 'Third-party driver packages whose published INF is missing. Audit only in this release - removal is the Stage 11 sweeper.'
  },
  {
    id: 'path',
    icon: 'fa-road',
    title: 'PATH entries',
    desc: 'Directories in the user or system PATH that no longer exist. The whole Environment key is exported before any edit.'
  },
  {
    id: 'associations',
    icon: 'fa-file-circle-question',
    title: 'File associations and protocols',
    desc: 'Extension and protocol handlers whose open command points at a missing executable.'
  },
  {
    id: 'profiles',
    icon: 'fa-users',
    title: 'Other user profiles',
    desc: 'Remnants in other local users\' registry hives. Loaded offline and always unloaded afterwards. Full Mode only.',
    needsKeyword: true
  }
];

const cleanerState = {};

function setupCleanTab() {
  CLEANERS.forEach((c) => {
    cleanerState[c.id] = { findings: [], scanned: false, loading: false, error: null, note: null };
  });

  document.getElementById('btn-scan-all-cleaners').addEventListener('click', async () => {
    for (const c of CLEANERS) {
      if (c.needsKeyword) continue; // needs a search term from the user
      await scanCleaner(c.id, { expand: false });
    }
    toast('All cleaners scanned.', 'success');
  });
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

async function scanCleaner(cleanerId, options = {}) {
  const cleaner = CLEANERS.find((c) => c.id === cleanerId);
  const state = cleanerState[cleanerId];
  state.loading = true;
  state.error = null;
  renderCleanerBody(cleaner);

  const params = { cleaner: cleanerId };
  if (cleaner.needsKeyword) {
    const input = document.getElementById(`cleaner-keyword-${cleanerId}`);
    params.keyword = input ? input.value.trim() : '';
  }

  const res = await window.api.cleanerScan(params);
  state.loading = false;

  if (!res || res.success !== true) {
    state.error = (res && res.error) || 'The scan engine did not respond.';
    state.findings = [];
  } else {
    state.findings = res.findings || [];
    state.note = res.note || null;
    state.scanned = true;
  }

  const badge = document.getElementById(`cleaner-count-${cleanerId}`);
  if (badge) {
    badge.textContent = state.findings.length;
    badge.style.display = state.scanned ? 'inline-flex' : 'none';
    badge.className = state.findings.length > 0 ? 'audit-badge danger' : 'audit-badge';
  }

  if (options.expand !== false) document.getElementById(`cleaner-${cleanerId}`).classList.add('expanded');
  renderCleanerBody(cleaner);
}

function renderCleanerBody(cleaner) {
  const body = document.getElementById(`cleaner-body-${cleaner.id}`);
  if (!body) return;
  const state = cleanerState[cleaner.id];

  const keywordRow = cleaner.needsKeyword
    ? `<div class="unlock-input-row">
         <input type="text" class="search-input" id="cleaner-keyword-${esc(cleaner.id)}" placeholder="Application name to search for...">
         <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}">Search profiles</button>
       </div>`
    : '';

  if (state.loading) {
    body.innerHTML = `${keywordRow}<div class="panel-state"><i class="fa-solid fa-spinner fa-spin"></i><div>Scanning...</div></div>`;
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
        <span style="font-size: 11.5px; color: var(--text-muted);">Scanning is read-only.</span>
      </div>`;
    wireCleanerBody(cleaner);
    return;
  }

  if (state.findings.length === 0) {
    body.innerHTML = `${keywordRow}
      <div class="panel-state">
        <i class="fa-solid fa-circle-check" style="color: var(--color-success);"></i>
        <div>${esc(state.note || 'No orphans found.')}</div>
      </div>
      <div class="cleaner-actions">
        <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}"><i class="fa-solid fa-rotate-right"></i> Re-scan</button>
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
          <input type="checkbox" data-finding="${esc(index)}" ${f.removable === false ? 'disabled' : ''}>
          <div class="finding-main">
            <div class="finding-label">${esc(f.label)}</div>
            <div class="finding-evidence">${esc(f.evidence)}${f.registryPath ? ' &middot; ' + esc(f.registryPath) : ''}</div>
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
      ${
        removable.length > 0
          ? `<button class="btn-danger btn-compact" data-purge="${esc(cleaner.id)}" data-destructive="true">
               <i class="fa-solid fa-box-archive"></i> Move selected to quarantine
             </button>`
          : `<span style="font-size: 11.5px; color: var(--color-warning);">Audit only - no removal path in this release.</span>`
      }
    </div>`;

  wireCleanerBody(cleaner);
}

function wireCleanerBody(cleaner) {
  const body = document.getElementById(`cleaner-body-${cleaner.id}`);
  if (!body) return;

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
      const boxes = body.querySelectorAll('input[type="checkbox"]:not([disabled])');
      const allChecked = Array.from(boxes).every((b) => b.checked);
      boxes.forEach((b) => {
        b.checked = !allChecked;
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

async function purgeCleaner(cleanerId) {
  if (!guardFullMode()) return;
  const state = cleanerState[cleanerId];
  const body = document.getElementById(`cleaner-body-${cleanerId}`);
  const checked = Array.from(body.querySelectorAll('input[type="checkbox"]:checked'));

  if (checked.length === 0) {
    toast('Tick the findings you want quarantined first.', 'warn');
    return;
  }

  const selected = checked.map((box) => state.findings[parseInt(box.getAttribute('data-finding'), 10)]);

  const ok = await confirmDialog({
    title: `Quarantine ${selected.length} item(s)?`,
    body:
      cleanerId === 'path'
        ? 'The whole Environment key is exported to a .reg restore manifest before the PATH value is rewritten. ' +
          'Restoring the vault entry puts the exact prior PATH string back.'
        : 'The selected registry keys are exported to .reg restore manifests, then removed. Nothing is deleted - ' +
          'everything lands in the Quarantine tab and can be restored from there.',
    confirmLabel: 'Move to quarantine'
  });
  if (!ok) return;

  const res = await window.api.cleanerPurge({ cleaner: cleanerId, items: selected });

  if (!res || res.success !== true) {
    toast(`Nothing was removed: ${(res && res.error) || 'unknown error'}`, 'error', 8000);
  } else {
    const count = res.quarantinedCount ?? selected.length;
    toast(`${count} item(s) moved to quarantine. Restore them any time from the Quarantine tab.`, 'success', 6000);
  }

  await scanCleaner(cleanerId);
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
      <div>${esc((res && res.error) || 'Could not read the uninstall entries.')}</div>`;
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
              <i class="fa-solid fa-magnifying-glass"></i> Scan traces
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
              ? `<div class="vault-item-group-title">Recorded uninstall command</div>
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
        `${entry.displayName} has a working uninstaller, even though ${entry.reasons.join('; ')}. ` +
        'Running the real uninstaller is always cleaner than forcing. Run it now instead?',
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
          ? 'Uninstaller finished. Re-scan to check for leftovers.'
          : `Uninstaller did not complete: ${res.error}`,
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
    toast('Enter an application name or an install folder first.', 'warn');
    return;
  }

  results.innerHTML = `<div class="panel-state"><i class="fa-solid fa-spinner fa-spin"></i>
    <div>Scanning the registry and filesystem for traces of "${esc(name || installLocation)}"...</div></div>`;

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
      <div>No traces of "${esc(forceContext.name)}" found at this depth.</div></div>`;
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
              ? 'the uninstall entry itself - removing this is what takes it out of Programs and Features'
              : esc(r.type)
          }</div>
        </div>
        <span class="finding-risk ${esc((r.risk || 'safe').toLowerCase())}">${esc(r.risk)}</span>
      </div>`
    )
    .join('');

  results.innerHTML = `
    <div class="settings-group-title">Found ${total} trace(s) of "${esc(forceContext.name)}"</div>
    <div class="cleaner-section expanded">
      <div class="cleaner-section-body" style="display:block; border-top:none;">
        ${files.length ? `<div class="vault-item-group-title">Files and folders (${files.length})</div><div class="cleaner-findings">${fileRows}</div>` : ''}
        ${registry.length ? `<div class="vault-item-group-title">Registry (${registry.length})</div><div class="cleaner-findings">${regRows}</div>` : ''}
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
    toast('Tick what you want quarantined first.', 'warn');
    return;
  }

  const ok = await confirmDialog({
    title: `Force uninstall "${forceContext.name}"?`,
    body:
      `${files.length + registry.length} item(s) will be moved into the quarantine vault - files moved, ` +
      'registry keys exported to a .reg restore manifest first. Nothing is deleted, and restoring the ' +
      'vault entry brings the application listing back too. This bypasses the application\'s own ' +
      'uninstaller, so it cannot run any cleanup of its own.',
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
    toast(`Nothing was removed: ${(res && res.error) || 'unknown error'}`, 'error', 8000);
    return;
  }

  const failed = [...(res.files || []), ...(res.registry || [])].filter((i) => i.status === 'failed');
  if (failed.length > 0) {
    toast(
      `${res.quarantinedCount} item(s) quarantined; ${failed.length} left in place (${failed[0].error}).`,
      'warn',
      9000
    );
  } else {
    toast(`${res.quarantinedCount} item(s) quarantined. Restore any time from the Quarantine tab.`, 'success', 6000);
  }

  await loadBrokenEntries();
  await runForceScan({ extraRegistryPath: null });
}
