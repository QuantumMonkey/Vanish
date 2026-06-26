// Vanish Frontend UI Controller (renderer.js)
// Interacts with Electron preload bridge APIs

let allApps = [];
let selectedApp = null;
let activeTab = 'all-apps';
let filterText = '';
let filterType = 'all';
let sortOption = 'name-asc';
let isAdmin = false;

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
  
  await checkElevation();
  await loadApplications();
});

// Titlebar Button Events
function setupTitlebar() {
  elements.btnMinimize.addEventListener('click', () => window.api.minimizeWindow());
  elements.btnMaximize.addEventListener('click', () => window.api.maximizeWindow());
  elements.btnClose.addEventListener('click', () => window.api.closeWindow());
}

// Check if running elevated
async function checkElevation() {
  isAdmin = await window.api.checkAdmin();
  if (isAdmin) {
    elements.adminIndicator.className = 'admin-badge elevated';
    elements.adminIndicator.innerHTML = '<i class="fa-solid fa-shield-halved"></i><span>Administrator</span>';
    elements.statRestoreStatus.textContent = 'Enabled';
  } else {
    elements.adminIndicator.className = 'admin-badge unelevated';
    elements.adminIndicator.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><span>Standard User</span>';
    elements.statRestoreStatus.textContent = 'Limited (No Admin)';
  }
}

// Load both Desktop and UWP Apps
async function loadApplications() {
  showLoadingState();
  
  try {
    const [desktopApps, uwpApps] = await Promise.all([
      window.api.getDesktopApps(),
      window.api.getUwpApps()
    ]);
    
    allApps = [...desktopApps, ...uwpApps];
    
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
          <div class="app-icon-placeholder">${initial}</div>
          <div>
            <div class="app-title-name">${app.name}</div>
            <div class="app-publisher-name">${app.publisher}</div>
          </div>
        </div>
      </td>
      <td>
        <span class="badge-type ${app.type.toLowerCase()}">${app.type === 'UWP' ? 'Windows App' : 'Desktop'}</span>
      </td>
      <td style="color: var(--text-gray); font-size: 13px;">${dateStr}</td>
      <td style="color: var(--text-gray); font-size: 13px; font-weight: 500;">${sizeStr}</td>
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

// Setup Sidebar tabs
function setupSidebarNavigation() {
  const appsContentArea = document.querySelector('.content-area:not(#audit-panel)');
  const auditPanel      = document.getElementById('audit-panel');

  elements.navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      elements.navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      activeTab = item.getAttribute('data-tab');

      if (activeTab === 'all-apps') {
        // Show apps panel, hide audit panel
        if (appsContentArea) appsContentArea.style.display = '';
        auditPanel.style.display = 'none';
        elements.searchBar.disabled = false;
        elements.typeToggle.style.pointerEvents = 'all';
        elements.typeToggle.style.opacity = '1';
        elements.sortSelector.disabled = false;
        elements.detailsSidebar.classList.remove('active');
        loadApplications();

      } else if (activeTab === 'audit') {
        // Show audit panel, hide apps panel
        if (appsContentArea) appsContentArea.style.display = 'none';
        auditPanel.style.display = 'flex';
        auditPanel.style.flexDirection = 'column';
        auditPanel.style.flex = '1';
        auditPanel.style.overflow = 'hidden';
        loadAuditData();

      } else if (activeTab === 'force-uninstall') {
        alert('Force Uninstall: This lets you enter a folder path or application name keyword directly to scan registry/filesystem remnants even if the application is not officially registered. Setup a test dummy application first!');
        document.querySelector('[data-tab="all-apps"]').click();

      } else if (activeTab === 'settings') {
        alert('Vanish Settings: Configuration options like custom paths to exclude, automatic backup path settings, and restore point configuration.');
        document.querySelector('[data-tab="all-apps"]').click();

      } else if (activeTab === 'about') {
        alert('Vanish Uninstaller v1.0.0\nCreated as a modern, high-performance, and safe deep uninstaller for Windows OS.');
        document.querySelector('[data-tab="all-apps"]').click();
      }
    });
  });
}

function setupDetailsPanel() {
  elements.btnStartUninstall.addEventListener('click', () => {
    if (selectedApp) {
      openUninstallWizard(selectedApp);
    }
  });
}

// ==========================================
// UNINSTALL WIZARD LOGIC
// ==========================================

function openUninstallWizard(app) {
  wizState.currentScreenIndex = 0;
  wizState.createRestorePoint = true;
  wizState.scanMode = 'Moderate';
  wizState.leftovers = { files: [], registry: [] };
  wizState.selectedFiles = [];
  wizState.selectedRegistry = [];
  wizState.spaceReclaimedBytes = 0;

  // Set checkbox state in Config screen
  elements.chkCreateRestore.checked = true;
  document.querySelectorAll('.mode-card').forEach(card => {
    card.classList.remove('selected');
    if (card.getAttribute('data-mode') === 'Moderate') {
      card.classList.add('selected');
    }
  });

  // UI labels
  elements.wizAppName.textContent = `Uninstalling ${app.name}`;
  elements.wizAppVersion.textContent = `Version ${app.version || 'Unknown'} • ${app.type === 'UWP' ? 'Windows App' : 'Desktop Program'}`;
  
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
          alert(`Restore Point failed: ${res.error}\nProceeding with safety fallback...`);
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
        alert(`Scanning leftovers failed: ${err.message}`);
        showScreen(2);
      }
    }
  });

  // Launch Native Uninstaller click
  elements.btnLaunchNative.addEventListener('click', async () => {
    elements.btnLaunchNative.disabled = true;
    
    if (selectedApp.type === 'UWP') {
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Uninstalling Package...</span>';
    } else {
      elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Native Uninstaller Running...</span>';
    }
    
    const res = await window.api.uninstallNative(selectedApp.uninstallString);
    
    // Restore button state
    elements.btnLaunchNative.disabled = false;
    elements.btnLaunchNative.innerHTML = '<i class="fa-solid fa-circle-play"></i> <span>Launch Native Uninstaller</span>';
    
    if (selectedApp.type === 'UWP') {
      if (res.success) {
        alert('Store Application package removed successfully. Proceeding to scan leftovers.');
        // Automatically proceed to Scan
        elements.btnWizNext.click();
      } else {
        alert(`UWP Package removal failed: ${res.error}\nWe will attempt to force uninstall remnants.`);
        elements.btnWizNext.click();
      }
    } else {
      alert("Native uninstaller launched. Please verify if it asked for approval or finished on screen, then click 'Scan Leftovers' to deep scan remnants.");
    }
  });

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

  // Purge Remnants Click
  elements.btnWizPurge.addEventListener('click', async () => {
    // Collect selected files & registry keys
    const checkedBoxes = elements.leftoversTreeView.querySelectorAll('input[type="checkbox"]:checked');
    if (checkedBoxes.length === 0) {
      if (confirm('No leftovers selected. Finish uninstallation without purging?')) {
        closeUninstallWizard();
      }
      return;
    }

    const filesToPurge = [];
    const registryToPurge = [];
    let estimatedSpaceSaved = 0;

    checkedBoxes.forEach(chk => {
      const type = chk.getAttribute('data-item-type');
      const path = chk.getAttribute('data-path');
      const sizeBytes = parseInt(chk.getAttribute('data-size') || '0');

      if (type === 'file' || type === 'dir') {
        filesToPurge.push({ path: path });
        estimatedSpaceSaved += sizeBytes;
      } else if (type === 'registry') {
        registryToPurge.push({ path: path });
      }
    });

    wizState.spaceReclaimedBytes = estimatedSpaceSaved;

    showScreen(5); // Show purging loader screen

    try {
      const res = await window.api.purgeRemnants({
        files: filesToPurge,
        registry: registryToPurge
      });

      // Render Complete Screen details
      const deletedFilesCount = res.deletedFiles ? res.deletedFiles.length : 0;
      const deletedRegCount = res.deletedRegistry ? res.deletedRegistry.length : 0;
      const failedCount = (res.failedFiles ? res.failedFiles.length : 0) + (res.failedRegistry ? res.failedRegistry.length : 0);

      elements.lblPurgeResultText.textContent = `Scrubbed ${deletedFilesCount} folder/file leftovers and purged ${deletedRegCount} registry keys successfully.`;
      
      if (failedCount > 0) {
        elements.lblPurgeResultText.textContent += ` Note: ${failedCount} files or keys were locked by Windows and skipped.`;
      }

      elements.lblSpaceSaved.textContent = `Total Space Reclaimed: ${formatBytes(wizState.spaceReclaimedBytes, 1)}`;
      showScreen(6); // Show complete screen
    } catch (err) {
      alert(`Purging remnants failed: ${err.message}`);
      showScreen(4); // Return to tree list
    }
  });

  // Finish Click
  elements.btnWizFinish.addEventListener('click', () => {
    closeUninstallWizard();
  });
}

function confirmCancel() {
  if (wizState.currentScreenIndex > 0 && wizState.currentScreenIndex < 6) {
    if (confirm('Are you sure you want to cancel the uninstallation process?')) {
      closeUninstallWizard();
    }
  } else {
    closeUninstallWizard();
  }
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
        <input type="checkbox" data-item-type="dir" data-path="${f.path}" data-size="${f.sizeBytes || 0}" ${checkedAttr}>
        <div class="tree-item-label">
          <span style="font-family: Consolas, monospace; font-size: 11px;">${f.path}</span>
          <div class="tree-item-meta">
            <span class="${riskClass}">${f.risk} Risk</span>
            <span style="color: var(--text-muted);">${f.type}</span>
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
        <input type="checkbox" data-item-type="registry" data-path="${r.path}" ${checkedAttr}>
        <div class="tree-item-label">
          <span style="font-family: Consolas, monospace; font-size: 11px;">${r.path}</span>
          <div class="tree-item-meta">
            <span class="${riskClass}">${r.risk} Risk</span>
            <span style="color: var(--text-muted);">${r.type}</span>
          </div>
        </div>
      `;
      regGroup.appendChild(item);
    });
    
    tree.appendChild(regGroup);
  }
}

// ==========================================
// STAGE 2 — AUDIT & HEALTH ADVISOR UI
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
    { label: 'Operating System',  value: diag.os?.caption  ?? 'Unknown',    sub: `Build ${diag.os?.build ?? '?'} · ${diag.os?.architecture ?? ''}` },
    { label: 'System Uptime',     value: uptimeStr || 'Unknown',              sub: '' },
    { label: 'CPU',               value: shortenCpuName(diag.cpu?.name),      sub: `${cpuClockGHz} · ${cpuSub}` },
    { label: 'RAM Usage',         value: ramPct || 'Unknown',                 sub: ramSub },
    { label: 'GPU',               value: diag.gpu ?? 'Unknown',               sub: '' },
    { label: 'Machine',           value: `${diag.manufacturer ?? ''} ${diag.model ?? ''}`.trim() || 'Unknown', sub: '' }
  ];

  grid.innerHTML = cards.map(c => `
    <div class="audit-info-card">
      <span class="card-label">${c.label}</span>
      <span class="card-value" title="${c.value}">${c.value}</span>
      ${c.sub ? `<span class="card-sub">${c.sub}</span>` : ''}
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
          <span class="disk-bar-drive">${d.drive}:\ &nbsp;<span style="font-weight:400; font-size:12px; color:var(--text-gray);">${d.label}</span></span>
          <span class="disk-bar-stats">${d.usedGB} GB used of ${d.totalGB} GB &nbsp;·&nbsp; ${d.freeGB} GB free &nbsp;·&nbsp; ${pct}% full</span>
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
      ? (item.command || '').slice(0, 80) + '…'
      : (item.command || '—');

    return `
      <tr class="app-row">
        <td style="font-size: 12px; font-weight: 600; color: var(--text-white);">${item.name}</td>
        <td><span class="source-badge ${sourceClass}">${sourceLabel}</span></td>
        <td>
          <span class="status-dot ${dotClass}"></span>
          <span style="font-size:12px; color: var(--text-gray);">${statusLabel}</span>
        </td>
        <td style="font-size: 11px; font-family: Consolas, monospace; color: var(--text-muted); word-break: break-all;" title="${item.command || ''}">${cmdShort}</td>
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
      `<span class="redundancy-pill">${a.name}</span>`
    ).join('');
    return `
      <div class="redundancy-group">
        <div class="redundancy-group-header">
          <span class="redundancy-category"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>${g.category}</span>
          <span class="audit-badge danger">${g.count} installed</span>
        </div>
        <div class="redundancy-tip">${g.tip}</div>
        <div class="redundancy-app-pills">${pills}</div>
      </div>
    `;
  }).join('');
}
