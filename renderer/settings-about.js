// Vanish renderer -- Settings and About panels
//
// Settings validation lives in lib/store.js; this is the screen over it.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

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

  const startupRestartBtn = document.getElementById('set-startup-restart-btn');
  if (startupRestartBtn) {
    // Symmetric with the toggle: whichever direction it now disagrees with
    // the running session, this button applies it to THIS session instead
    // of only the next independent launch.
    startupRestartBtn.addEventListener('click', () => {
      if (startupElevated.checked && !isAdmin) requestElevation(null);
      else if (!startupElevated.checked && isAdmin) requestDeelevation();
    });
  }

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
  updateStartupRestartButton(startsElevated);
}

// Operator report (live sandbox testing, 2026-08-10): "it starts in admin
// mode as expected, but there is no way to return to audit mode." The toggle
// only ever governed the NEXT independent launch - there was no in-app path
// to apply a change to the session already running. Shown only when the
// toggle's new target actually disagrees with what is running right now
// (isAdmin, the CURRENT tier - not appSettings.startupMode, which is what
// the toggle just set and may not match reality yet); once they agree there
// is nothing to restart for.
function updateStartupRestartButton(startsElevated) {
  const btn = document.getElementById('set-startup-restart-btn');
  if (!btn) return;
  btn.style.display = startsElevated !== isAdmin ? '' : 'none';
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
    // kp0: this table states hard facts, not marketing - it must stay
    // accurate the moment the ping tile exists, not read as if it does not.
    ['Network use while running', 'None automatic - one manual ping, only when you tap it'],
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
