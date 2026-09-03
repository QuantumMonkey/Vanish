// Vanish renderer -- Quarantine manager, Task Manager and the unlocker
//
// The restore path (INV-1) and the process tools that let a locked file be
// released before an uninstall retries it.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

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
    const result = await applySettingsPatch({
      autoPurgeEnabled: autoPurgeToggle.checked,
      autoPurgeRetentionDays: parseInt(retentionInput.value, 10)
    });
    // mp4: redraw from what is ON DISK first. This toggle decides whether
    // Vanish deletes quarantined items by itself, so a checkbox left showing ON
    // after a write that failed is the worst version of this bug in the app.
    autoPurgeToggle.checked = appSettings.autoPurgeEnabled === true;
    retentionInput.value = appSettings.autoPurgeRetentionDays;
    reportSettingSaved(
      result,
      appSettings.autoPurgeEnabled
        ? `Automatic purge is on. Items are deleted after ${appSettings.autoPurgeRetentionDays} days.`
        : 'Automatic purge is off. Nothing leaves quarantine unless you delete it.'
    );
  });

  retentionInput.addEventListener('change', async () => {
    const result = await applySettingsPatch({
      autoPurgeRetentionDays: parseInt(retentionInput.value, 10)
    });
    retentionInput.value = appSettings.autoPurgeRetentionDays;
    if (!result.saved) reportSettingSaved(result);
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
    'system-clean/uwp-leftovers': 'System Clean - left-over Store app data',
    'system-clean/installer-cache': 'System Clean - left-over Windows installers',
    'system-clean/firewall-rules': 'System Clean - firewall rules',
    'system-clean/dead-references': 'System Clean - dead references and ghost devices',
    'system-clean/definitions': 'System Clean - a CleanerML cleaning rule'
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
    // cihg: "everything is back" and "everything is back AND matched the copy
    // the vault took" are different claims, and the second is the one this
    // panel exists to be able to make. Entries quarantined before content
    // hashing shipped carry no hash, so they restore correctly and cannot be
    // vouched for - saying nothing about that would let the weaker case wear
    // the stronger sentence, which is the same defect as a could-not-look
    // rendered as a nothing.
    const files = res.files || [];
    const checked = files.filter((f) => f.verified === true).length;
    const unchecked = files.filter((f) => f.verified !== true).length;
    if (files.length > 0 && unchecked === 0) {
      toast(
        `Everything is back where it came from, and all ${checked} file(s) matched the copy the vault took.`,
        'success'
      );
    } else if (checked > 0) {
      toast(
        `Everything is back where it came from. ${checked} file(s) matched the copy the vault took; ` +
          `${unchecked} could not be checked against one.`,
        'success',
        7000
      );
    } else {
      toast(
        'Everything is back where it came from. None of it could be checked against a recorded copy - ' +
          'this entry was quarantined before Vanish started recording one.',
        'success',
        7000
      );
    }
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

// aaw: byPid entries are { total, adapters }; older engines sent a bare
// number. One accessor so every reader agrees on which it is.
function gpuTotal(pid) {
  const e = gpuUsageByPid[pid];
  if (e == null) return null;
  return typeof e === 'object' ? e.total : e;
}

// The GPU cell's three honest states. Kept as a function rather than inlined
// so the "-" case can never silently drift back into meaning "zero".
// aaw: which adapter, per row. gpuVendorInfo maps LUID -> vendor and was
// already used for the summary pill above the table; this applies the same
// resolution per process. It resolves nothing new and guesses nothing - an
// adapter whose LUID does not match a known card keeps the neutral chip icon
// and its ordinal, exactly as the pill does.
// The join key is the ADAPTER KEY (its LUID), not phys_N. Measured on a
// hybrid laptop: three adapters - AMD, NVIDIA and the Basic Render Driver -
// ALL reported phys_0, because phys_N is an index within an adapter group
// rather than a global GPU ordinal. Joining on it merged every card into one
// and labelled the merged result with whichever LUID sorted first, which is
// how a process running on the NVIDIA card came to wear a red AMD logo.
function gpuAdapterMark(adapterKey) {
  const a = (gpuAdapterUsage || []).find((x) => x.adapterKey === adapterKey);
  const vendorMatch = a && (gpuVendorInfo || []).find(
    (v) => v.luidHigh === a.luidHigh && v.luidLow === a.luidLow
  );
  const vendor = vendorMatch ? vendorMatch.vendor : null;
  const icon = vendor === 'amd' ? 'fa-amd' : vendor === 'nvidia' ? 'fa-nvidia' : 'fa-microchip';
  // No match means the adapter is real (the counters reported it) but Vanish
  // could not name it. Say that, rather than inventing an ordinal that is not
  // unique and reads like an identity.
  const label = vendorMatch ? vendorMatch.name : `Unrecognised adapter (LUID ${adapterKey})`;
  return { icon, label, vendor };
}

function gpuCellHtml(pid) {
  const entry = gpuUsageByPid[pid];
  // The engine now sends { total, adapters }. A plain number is the older
  // shape and is still read, so a stale response mid-upgrade renders rather
  // than throwing.
  const value = entry && typeof entry === 'object' ? entry.total : entry;

  if (value != null) {
    const adapters = (entry && typeof entry === 'object' && entry.adapters) || null;
    let mark = '';
    let more = '';
    if (adapters) {
      const entries = Object.entries(adapters).sort((a, b) => b[1] - a[1]);
      if (entries.length > 0) {
        const [topKey] = entries[0];
        const m = gpuAdapterMark(topKey);
        // A process using more than one adapter is NOT reduced to one - the
        // busier is shown and the count says there is more, rather than
        // quietly picking a winner.
        more = entries.length > 1 ? `<sup title="Also using ${entries.length - 1} other adapter(s)">+${entries.length - 1}</sup>` : '';
        mark = `<i class="fa-solid ${m.icon} gpu-row-mark${m.vendor ? ' is-' + m.vendor : ''}" title="${esc(m.label)}"></i>`;
      }
    }
    // The adapter mark leads, the number follows. It used to trail the
    // percentage, which read as a footnote on the figure; which card is doing
    // the work is the thing that qualifies the number, so it belongs in front
    // of it the way a currency symbol does. It is an icon rather than a name
    // in a column this narrow - "NVIDIA" spelled out wraps onto a second line
    // and pushes the whole table taller for a word the colour already says.
    return `${mark}${esc(value.toFixed(1))}%${more}`;
  }
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
  gpu: (a, b) => (gpuTotal(a.pid) || 0) - (gpuTotal(b.pid) || 0),
  memory: (a, b) => a.memoryBytes - b.memoryBytes,
  io: (a, b) => a.ioBytesPerSec - b.ioBytesPerSec
};

// 5b0: Task Manager's two filterable columns. Indicators is the operator's
// explicit ask and the multi-valued one; Process is the long tail (twenty
// chrome.exe rows collapse to one option with a count of 20). CPU, GPU, Memory
// and Disk I/O are deliberately NOT here - a checklist of distinct continuous
// values is meaningless, what those columns want is a threshold, and hiding a
// different control behind the same funnel icon would misrepresent both.
const PROCESS_COLUMN_FILTERS = ['process.name', 'process.indicators'];

function setupProcessTab() {
  document.getElementById('process-search').addEventListener('input', (e) => {
    processFilter = e.target.value.toLowerCase();
    renderProcessTable();
  });

  // The funnel sits inside a header that already sorts on click, so its own
  // handler stops the event - see registerColumnFilter. Indicators filters on
  // the SHORT LABELS the chips in the cells carry, not the raw indicator kinds,
  // for the same reason Type does in All Programs: a filter has to offer the
  // words that are actually on screen.
  registerColumnFilter({
    key: 'process.name',
    label: 'Process',
    th: '.process-table thead th[data-sort="name"]',
    getPool: () => processes,
    getValues: (p) => [p.name],
    onChange: () => renderProcessTable()
  });
  registerColumnFilter({
    key: 'process.indicators',
    label: 'Indicators',
    th: '.process-table thead th:last-child',
    note: 'A program carrying two indicators stays visible while either one is shown.',
    getPool: () => processes,
    getValues: (p) => (p.indicators || []).map((i) => indicatorShortLabel(i.kind)),
    onChange: () => renderProcessTable()
  });

  const clearProcessFilters = document.getElementById('btn-clear-process-filters');
  if (clearProcessFilters) {
    clearProcessFilters.addEventListener('click', () => {
      processFilter = '';
      const search = document.getElementById('process-search');
      if (search) search.value = '';
      clearColumnFilters(PROCESS_COLUMN_FILTERS);
      renderProcessTable();
    });
  }

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
    const result = await applySettingsPatch({
      processRefreshSeconds: parseInt(refreshInput.value, 10)
    });
    refreshInput.value = appSettings.processRefreshSeconds;
    if (!result.saved) reportSettingSaved(result);
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
      // "GPU 0" was never a name. phys_N is not unique, so on this machine
      // three different cards all rendered as "GPU 0" - the label carried no
      // information and actively misled. Use what the adapter is actually
      // called, with the full descriptor in the tooltip.
      const label = vendorMatch ? gpuShortName(vendorMatch.name) : 'Unrecognised adapter';
      const title = vendorMatch ? vendorMatch.name : `No vendor record for LUID ${a.adapterKey}`;
      return `
        <span class="gpu-adapter-pill${a.percent > 0 ? ' is-active' : ''}" title="${esc(title)}">
           <i class="fa-solid ${icon}"></i> ${esc(label)}: ${esc(a.percent.toFixed(0))}%
         </span>`;
    })
    .join('');
}

// "NVIDIA GeForce RTX 3080 Laptop GPU" is the honest name and too long for a
// pill sitting above a table. Keep the part that identifies the card and drop
// the marketing furniture; the full string stays in the tooltip.
function gpuShortName(name) {
  return String(name)
    .replace(/\(TM\)|\(R\)|\(C\)/gi, '')
    .replace(/\s+(Laptop\s+)?GPU$/i, '')
    .replace(/\s+Graphics$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
  rows = rows.filter((p) => columnFilterAllowsAll(PROCESS_COLUMN_FILTERS, p));

  const sorter = PROCESS_SORTERS[processSort.key] || PROCESS_SORTERS.cpu;
  rows = rows.slice().sort((a, b) => (processSort.asc ? sorter(a, b) : sorter(b, a)));

  document.querySelectorAll('.process-table th[data-sort]').forEach((th) => {
    const isSorted = th.getAttribute('data-sort') === processSort.key;
    th.classList.toggle('sorted', isSorted);
    th.classList.toggle('asc', isSorted && processSort.asc);
  });

  updateProcessFilterStatus(rows.length, processes.length);

  if (rows.length === 0) {
    // Which filter, and named. This table re-samples every two seconds, so an
    // empty list here reads as "nothing is running" unless it says otherwise.
    const columns = columnFilterSummary(PROCESS_COLUMN_FILTERS);
    const reason = columns
      ? `Nothing running matches the ${columns} filter${processFilter ? ' and that search' : ''}.`
      : 'Nothing running matches that filter.';
    tbody.innerHTML = `<tr><td colspan="7" class="table-state">${esc(reason)}</td></tr>`;
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
          <!-- 5z5: the name cell ellipsises now that .process-table is
               table-layout:fixed, so the full name has to survive somewhere -
               a truncated process name is exactly the thing a user is trying
               to read. -->
          <td style="font-weight: 600; color: var(--text-white);" title="${esc(p.name)}">${esc(p.name)}</td>
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

// 5b0: this table shipped with no row-count caption at all, which matters more
// here than anywhere else in the app - it re-samples every two seconds, so a
// filtered list is indistinguishable from a machine that went quiet. States the
// search box AND the column filters, because either alone can be the reason a
// process is missing.
function updateProcessFilterStatus(shown, pool) {
  const bar = document.getElementById('process-filter-bar');
  const caption = document.getElementById('process-filter-caption');
  if (!bar || !caption) return;

  const columns = columnFilterSummary(PROCESS_COLUMN_FILTERS);
  const isFiltered = processFilter !== '' || columns !== '';
  bar.style.display = isFiltered ? '' : 'none';
  renderColumnFilterChips('process-filter-chips', PROCESS_COLUMN_FILTERS);
  if (!isFiltered) return;

  const parts = [];
  if (processFilter !== '') parts.push('your search');
  if (columns) parts.push(columns);
  caption.textContent =
    `Showing ${shown} of ${pool} running programs - filtered by ${parts.join(' and ')}`;
}

function indicatorShortLabel(kind) {
  if (kind === 'suspicious-parent') return 'Script-started';
  if (kind === 'destructive-command') return 'Destructive';
  if (kind === 'persistence') return 'Autostart';
  return 'Indicator';
}


// 0bi: which installed program a process belongs to, plus the two facts
// nothing else on this machine can pair with it.
//
// CACHED, and deliberately NOT on the sampling loop. The table re-samples
// every two seconds; the join is four engine reads, and running it on that
// cadence would turn an attribution layer into the third resource monitor the
// operator explicitly said not to build. It runs once when a process is first
// selected, and again only when the user asks.
let processAttribution = null;
let processAttributionLoading = false;
let processAttributionNote = null;

async function loadProcessAttribution(force) {
  if (processAttributionLoading) return;
  if (processAttribution && !force) return;
  processAttributionLoading = true;
  try {
    const res = await window.api.processAttributionScan({ sampleMs: 300 });
    if (res && res.success === true) {
      processAttribution = new Map((res.results || []).map((r) => [r.pid, r]));
      processAttributionNote = res.note || null;
    } else {
      processAttribution = new Map();
      processAttributionNote = (res && res.error) || 'The attribution scan did not return a result.';
    }
  } finally {
    processAttributionLoading = false;
    if (selectedPid !== null) renderProcessDetails(processes.find((p) => p.pid === selectedPid));
  }
}

// The sentence, assembled from facts that each carry the command that
// produced them. The hedging is the engine's, not this function's - a
// renderer that decided its own wording could present an inferred
// attribution as a measured one, which is c0y.
function processAttributionHtml(pid) {
  if (processAttributionLoading && !processAttribution) {
    return '<div class="indicator-detail-note">Working out which program this belongs to...</div>';
  }
  if (!processAttribution) return '';

  const row = processAttribution.get(pid);
  if (!row) {
    return '<div class="indicator-detail-note">This process started after the last attribution scan.</div>';
  }

  const parts = [];
  parts.push(`<div class="indicator-detail-title">${esc(row.attributionText)}</div>`);

  if (row.owner && row.matchedPath) {
    parts.push(
      `<div class="indicator-detail-evidence">matched on ${esc(row.matchedPath)}` +
        (row.viaAncestor ? ' (a folder above the program file, not the program file\'s own)' : '') +
        `</div>`
    );
  }

  if (row.startsAutomatically) {
    parts.push(
      `<div class="indicator-detail-evidence">Starts automatically` +
        (row.startsAutomatically.via ? ` - ${esc(row.startsAutomatically.via)}` : '') +
        `</div>`
    );
  }

  if (row.listening && row.listening.ports.length > 0) {
    // A busy game reported SIXTY ports on the development machine. The
    // sentence is the feature; sixty numbers in the middle of it is not a
    // sentence, and the count is the part that means something anyway.
    const shown = row.listening.ports.slice(0, 6);
    const ports = shown.join(", ") +
      (row.listening.ports.length > shown.length ? ` and ${row.listening.ports.length - shown.length} more` : '');
    const where = row.listening.exposure === 'all'
      ? 'from anywhere on your network'
      : row.listening.exposure === 'loopback'
        ? 'from this PC only'
        : 'on a specific address';
    parts.push(
      `<div class="indicator-detail-evidence">Accepting connections ${esc(where)} on port ${esc(ports)}</div>`
    );
  }

  if (processAttributionNote) {
    parts.push(`<div class="indicator-detail-note">${esc(processAttributionNote)}</div>`);
  }

  return `<div class="indicator-detail">${parts.join("")}</div>`;
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

  // 0bi: fetched on first selection, then served from the cache.
  loadProcessAttribution(false);

  // Rule 7: indicators are displayed. Nothing here is wired to an action.
  const box = document.getElementById('proc-det-indicators');
  const indicators = proc.indicators || [];
  box.innerHTML = processAttributionHtml(proc.pid) + (indicators.length
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
    : '');
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
