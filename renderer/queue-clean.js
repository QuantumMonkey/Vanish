// Vanish renderer -- Bulk uninstall queue and System Clean
//
// The queue (including 8ns platform detection) and every cleaner section.
// zrw's install snapshot and bu2's size attribution are appended below,
// because both render into the System Clean panel.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

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

// 2pc: the panel used to force itself open on EVERY add and fire a toast each
// time, so collapsing it out of the way was undone by the very next add -
// "causes friction for its own interactions", almost verbatim. It now
// announces itself once, when the queue goes from empty to non-empty, and
// then respects whatever the user did with it. The count badge in its own
// header is the better feedback channel for adds 2..N, and it is always
// visible even when collapsed.
let queueHasAnnounced = false;

// 5rz: reflects bulkSelectedAppIds into the header select-all checkbox
// (checked/indeterminate/unchecked against the CURRENTLY RENDERED rows only -
// a filtered-out row's selection state does not count toward "all shown are
// checked") and the selection-count caption row.
function updateBulkSelectUI() {
  const rows = Array.from(document.querySelectorAll('#apps-tbody .app-row-checkbox'));
  const selectAllBox = document.getElementById('chk-select-all-apps');
  if (selectAllBox) {
    const checkedCount = rows.filter((r) => r.checked).length;
    selectAllBox.checked = rows.length > 0 && checkedCount === rows.length;
    selectAllBox.indeterminate = checkedCount > 0 && checkedCount < rows.length;
  }

  const bar = document.getElementById('bulk-select-row');
  const filterBar = document.getElementById('filter-status-row');
  const text = document.getElementById('bulk-select-text');
  const addBtn = document.getElementById('btn-bulk-add-queue');
  const count = bulkSelectedAppIds.size;
  if (bar) bar.style.display = count > 0 ? '' : 'none';
  if (filterBar) filterBar.style.display = count > 0 ? 'none' : '';
  // While a filter is active the hidden caption's sentence rides along here -
  // a selection must not be the reason a user stops being told that 158 of
  // their programs are currently out of view.
  // 5b0: the column filters belong in this test too, and leaving them out was
  // the 2026-08-05 bug walking back in through a new door - caught by asserting
  // the RULE (any active filter keeps saying so while a selection is live)
  // rather than the two filters that existed when the rule was written.
  const isFiltered =
    filterText.trim() !== '' ||
    filterType !== 'all' ||
    activeColumnFilterKeys(APP_COLUMN_FILTERS).length > 0;
  const filterNote = isFiltered ? (document.getElementById('filter-status-text')?.textContent || '') : '';
  if (text) text.textContent = filterNote ? `${count} selected - ${filterNote}` : `${count} selected`;
  // The button says how many it will act on, so a bulk action can never be
  // taken without its size on the button being pressed.
  if (addBtn) addBtn.textContent = `Add ${count} to queue`;
}

// Shared by the single-item "Add to bulk queue" button (guardProtected,
// toast-on-refusal) and bulk add below (which reports one aggregate summary
// instead of a toast per item - toasting once per item would drown a
// multi-item action in noise). Same two conditions, same wording either way.
function appProtectionBlock(app) {
  if (!app) return null;
  if (app.classification === 'feature') {
    return {
      message: `${app.name} is part of Windows. Turn it on or off in Windows' own "Turn Windows features on or off" window (optionalfeatures.exe).`,
      toastType: 'info',
      toastDuration: 9000,
      shortReason: 'part of Windows'
    };
  }
  if (app.protected === true) {
    return {
      message: `Vanish will not remove ${app.name}: ${app.protectionReason || 'Windows needs it to keep this PC updated.'}`,
      toastType: 'warn',
      toastDuration: 8000,
      shortReason: app.protectionReason || 'protected by Windows'
    };
  }
  return null;
}

// 5rz: the bulk counterpart to the single-item "Add to bulk queue" button.
// Applies the SAME guards (guardFullMode, the protected/feature check) but
// per item rather than assuming one selectedApp, and reports what happened
// as one summary instead of N toasts.
async function queueAddSelected() {
  if (!guardFullMode()) return;

  const ids = new Set(bulkSelectedAppIds);
  if (ids.size === 0) {
    toast('Nothing is selected to add.', 'info');
    return;
  }
  // Resolve against everything the table can render, not just allApps: with
  // the Windows-features toggle on, feature rows are selectable too, and
  // resolving only against allApps would drop them from BOTH the added count
  // and the skipped list - a silent disappearance, which is the one outcome a
  // bulk action must never have.
  const apps = allApps.concat(windowsFeatures).filter((a) => ids.has(a.id));

  let added = 0;
  const skippedProtected = [];
  const skippedOther = [];

  for (const app of apps) {
    const block = appProtectionBlock(app);
    if (block) {
      skippedProtected.push(`${app.name} (${block.shortReason})`);
      continue;
    }
    const res = await window.api.queueAdd(app);
    if (res && res.success === true) {
      added += 1;
    } else {
      skippedOther.push(`${app.name} (${(res && res.error) || 'unknown error'})`);
    }
  }

  if (added > 0) {
    queueHasAnnounced = true; // matches queueAddApp's own one-time-open behaviour
    document.getElementById('queue-panel').classList.remove('collapsed');
  }
  await refreshQueue();

  bulkSelectedAppIds.clear();
  filterAndRenderApps();

  const parts = [`${added} added to the queue`];
  if (skippedProtected.length) parts.push(`${skippedProtected.length} skipped (protected)`);
  if (skippedOther.length) parts.push(`${skippedOther.length} skipped (already queued or an error)`);
  const detail = [...skippedProtected, ...skippedOther].slice(0, 4).join('; ');
  toast(
    parts.join(', ') + (detail ? ` - ${detail}${skippedProtected.length + skippedOther.length > 4 ? '...' : ''}` : ''),
    added > 0 ? 'success' : 'warn',
    9000
  );
}

async function queueAddApp(app) {
  const res = await window.api.queueAdd(app);
  if (!res || res.success !== true) {
    toast((res && res.error) || 'Could not add that program to the queue.', 'warn');
    return;
  }

  const firstOfABatch = !queueHasAnnounced;
  if (firstOfABatch) {
    queueHasAnnounced = true;
    document.getElementById('queue-panel').classList.remove('collapsed');
    toast(`${app.name} was added to the queue. Add more, then press Start.`, 'success');
  }

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
    // 2pc: an emptied queue resets the one-time announcement, so the next
    // batch the user starts building gets the panel opened for them again.
    queueHasAnnounced = false;
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
      // 8ns: Retry re-runs the identical command. Against a platform launcher
      // that is not a retry, it is the same doomed request with a second
      // button press, so the button is withheld rather than left to
      // disappoint - the message tells the user what to do instead.
      const retryable = ['failed', 'rebootRequired', 'needsAttention'].includes(item.state)
        && !queueItemPlatform(item);
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

// 8ns: which storefront manages this program's uninstall, if any. Reads the
// live uninstall string the queue recorded when the item was added; null means
// the program uninstalls itself, which is the overwhelmingly common case.
function queueItemPlatform(item) {
  if (!item || !window.VanishPlatforms) return null;
  const meta = item.meta || {};
  return window.VanishPlatforms.detectPlatform(item.uninstallString || meta.command || '');
}

function queueItemDetail(item) {
  const meta = item.meta || {};
  if (item.state === 'failed' && meta.error) return meta.error;
  if (item.state === 'failed' && item.exitCode !== null) return `The uninstaller stopped with code ${item.exitCode}`;
  if (item.state === 'rebootRequired') return 'Restart Windows to finish this one';
  if (item.state === 'needsAttention') {
    // 8ns: a Steam or Epic game has no silent uninstaller to have "not
    // finished" - its UninstallString is the launcher. Saying the generic
    // sentence here told the operator their uninstall stalled when nothing
    // had, and pointed them at a Retry that could never succeed.
    const platform = queueItemPlatform(item);
    if (platform) return window.VanishPlatforms.platformMessage(platform);
    return 'The uninstaller did not finish on its own';
  }
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
  },
  {
    // 7v3. The only one of the three below that frees real space: 137 MB of 977 MB
    // measured on the development machine, and the rest is load-bearing.
    id: 'installer-cache',
    icon: 'fa-box-open',
    title: 'Left-over Windows installers',
    desc: 'Windows keeps a copy of every installer it has run so Repair and Uninstall keep working. These copies belong to programs that are gone, so nothing points at them any more. Vanish only lists a file when no installed product still references it.'
  },
  {
    // be8
    id: 'firewall-rules',
    icon: 'fa-shield-halved',
    title: 'Firewall rules for missing programs',
    desc: 'Firewall rules that allow or block a program that is no longer on this PC. Each one says why it is dead. Listed only in this release - Vanish will not remove a rule until it can put it back.'
  },
  {
    // ztl
    id: 'dead-references',
    icon: 'fa-ghost',
    title: 'Dead references and ghost devices',
    desc: 'Records Windows still holds for files and hardware that are not there. Most are harmless and normal - an unplugged device is supposed to leave a record - so each is labelled with what it actually is. Listed only; removing them frees nothing.'
  },
  {
    // 7sl. The only section whose rules Vanish did not write. Everything else
    // in this panel is a question Vanish answers itself; this one reads
    // BleachBit's CleanerML definitions - which are maintained by people who
    // do that work full time - and puts them through the vault, because every
    // commodity cleaner deletes and none of them can put anything back.
    //
    // Vanish ships no definitions and will not download any: BleachBit's are
    // GPL-3.0+ and this repo is MIT, and INV-4 forbids the network anyway.
    id: 'definitions',
    icon: 'fa-list-check',
    title: 'Cleaning definitions',
    desc: 'Cleaning rules written and maintained by the BleachBit project, read from a copy you already have. Vanish only performs the deletions in them - never the instructions that edit a file in place, because those cannot be undone - and everything it does remove goes to quarantine first.',
    needsFolder: true
  }
];

const cleanerState = {};

function setupCleanTab() {
  CLEANERS.forEach((c) => {
    cleanerState[c.id] = {
      findings: [], scanned: false, loading: false, error: null, note: null,
      selected: new Set(), resolvedCount: 0, scannedAt: null,
      // 7sl: only the definitions cleaner uses this, but the shape is
      // declared here with the rest rather than appearing from nowhere.
      definitionsPath: ''
    };
  });


  // zrw: install snapshot. Wired alongside the cleaner buttons because it
  // lives in the same panel; kept in its own function so the cleaner setup
  // above stays about cleaners.
  wireInstallSnapshot();
  wireAttribution();

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

  // qkgu: the same rule the body follows, because the badge is what the user
  // reads when the section is COLLAPSED - which is most of the time, and is
  // the only thing they see before deciding not to open it. A flat "0" on a
  // sweep that was refused is the green tick in miniature, and it gets there
  // first.
  const blind = state.decision && state.decision.unreadableCount > 0;
  if (blind && state.findings.length === 0) {
    badge.textContent = '?';
    badge.title = state.decision.headline;
    badge.className = 'audit-badge scanning';
    badge.style.display = state.scanned ? 'inline-flex' : 'none';
    return;
  }

  badge.textContent = blind ? `${state.findings.length}+` : state.findings.length;
  badge.title = blind ? state.decision.headline : '';
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
  // 7sl: remembered on the state rather than read back off the DOM later,
  // because renderCleanerBody replaces that subtree on every re-render and
  // the folder the user chose would not survive the first result.
  if (cleaner.needsFolder) {
    const input = document.getElementById(`cleaner-folder-${cleanerId}`);
    const chosen = input ? input.value.trim() : '';
    state.definitionsPath = chosen;
    if (chosen) params.definitionsPath = chosen;
  }

  const res = await window.api.cleanerScan(params);
  state.loading = false;
  stopScanTicker(`cleaner:${cleanerId}`);

  // qkgu: the same seam the wizard's leftover screen uses, on the surface that
  // has seven of these instead of one. The decision is not read off the
  // payload - it is recomputed from the evidence by lib/findings.js, which is
  // this exact file in both processes rather than a copy of its rules.
  state.decision = window.VanishFindings.fromCleanerScan(res, cleaner.id, cleaner.title || cleaner.id);

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

// qkgu: what could not be read, named. "4 locations could not be read" with no
// list is a shrug; the paths are what let the operator decide whether it
// matters -- an ACL on somebody else's profile hive is not the same news as
// one on the services key this cleaner exists to sweep.
//
// Capped at ten in the LOOP, not in a comment above it, and the remainder is
// counted out loud. The engine caps its own list at 200 and reports what it
// dropped; this is the second, tighter cap for a panel.
const BLIND_SPOT_ROWS = 10;

function renderBlindSpots(unreadable) {
  const list = Array.isArray(unreadable) ? unreadable.filter(Boolean) : [];
  if (list.length === 0) return '';

  const rows = [];
  for (const u of list) {
    if (rows.length >= BLIND_SPOT_ROWS) break;
    const why = u.reason ? ` <span style="color: var(--text-muted);">(${esc(u.reason)})</span>` : '';
    rows.push(`<div class="finding-evidence" style="margin-left: 0;">${esc(u.path || '')}${why}</div>`);
  }
  const rest = list.length - rows.length;

  return `<div style="font-size: 11.5px; margin-bottom: 8px;">
      <div style="color: var(--text-muted); margin-bottom: 4px;">Could not be read:</div>
      ${rows.join('')}
      ${rest > 0 ? `<div class="finding-evidence" style="margin-left: 0; color: var(--text-muted);">and ${esc(String(rest))} more</div>` : ''}
    </div>`;
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

  // 7sl: this section runs rules Vanish did not write, so it has to be told
  // where they are. Left blank it looks for a BleachBit installed on this PC
  // and says plainly when it finds none - it will never fetch any.
  const folderRow = cleaner.needsFolder
    ? `<div class="unlock-input-row">
         <input type="text" class="search-input" id="cleaner-folder-${esc(cleaner.id)}" placeholder="Folder of CleanerML definitions (leave blank to use an installed BleachBit)" value="${esc(state.definitionsPath || '')}">
         <button class="btn-sec btn-compact" data-browse="${esc(cleaner.id)}"><i class="fa-solid fa-folder-open"></i> Browse</button>
       </div>`
    : '';

  const inputRows = `${keywordRow}${folderRow}`;

  if (state.loading) {
    body.innerHTML = `${inputRows}<div class="panel-state">
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
    body.innerHTML = `${inputRows}<div class="panel-state error"><i class="fa-solid fa-circle-xmark"></i><div>${esc(state.error)}</div></div>`;
    wireCleanerBody(cleaner);
    return;
  }

  if (!state.scanned) {
    body.innerHTML = `${inputRows}
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
    // qkgu: THE LINE THIS WHOLE CHANGE EXISTS FOR. An empty findings list used
    // to be one thing - a green tick and "Nothing left behind here." It is two
    // things, and only one of them is good news. A sweep that an ACL refused,
    // or whose pnputil never ran, returned an empty list too, and told the
    // user their machine was clean.
    const blind = state.decision && state.decision.state === window.VanishFindings.UI_INCOMPLETE;
    if (blind) {
      body.innerHTML = `${inputRows}
        <div class="panel-state">
          <i class="fa-solid fa-circle-question" style="color: var(--color-warning);"></i>
          <div>
            <div>Nothing found in what could be read -- but this sweep did not finish.</div>
            <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 6px;">
              ${esc(state.decision.headline)}
            </div>
          </div>
        </div>
        ${renderBlindSpots(state.decision.unreadable)}
        <div class="cleaner-actions">
          <button class="btn-sec btn-compact" data-scan="${esc(cleaner.id)}"><i class="fa-solid fa-rotate-right"></i> Re-scan</button>
          ${scanAgeLabel(state)}
        </div>`;
      wireCleanerBody(cleaner);
      return;
    }
    const cleared = state.resolvedCount > 0
      ? `All ${state.resolvedCount} item(s) found here have been moved to quarantine.`
      : esc(state.note || 'Nothing left behind here.');
    body.innerHTML = `${inputRows}
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

  // A partial 'found' is still partial. "We found 3" quietly meaning "3 of an
  // unknown number" is the same defect as the green tick above, and it matters
  // more here, because this is the list with a Move-to-quarantine button under
  // it and the user is about to decide they have dealt with the problem.
  const partial = state.decision && state.decision.unreadableCount > 0;

  body.innerHTML = `
    ${inputRows}
    ${
      partial
        ? `<div class="panel-state" style="padding: 10px 12px; margin-bottom: 8px; text-align: left;">
             <i class="fa-solid fa-triangle-exclamation" style="color: var(--color-warning);"></i>
             <div style="font-size: 11.5px;">
               This list is incomplete -- ${esc(String(state.decision.unreadableCount))} location(s) could not be read,
               so there may be more here than is shown.
             </div>
           </div>
           ${renderBlindSpots(state.decision.unreadable)}`
        : ''
    }
    ${
      state.note
        ? `<div style="font-size: 11.5px; color: var(--text-muted); margin-bottom: 8px;">${esc(state.note)}</div>`
        : ''
    }
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

  // 7sl: typing a full path by hand was the only option for the Unlocker
  // until a picker was added for it (operator feedback 2026-08-05); the same
  // applies here, and it is the same dialog.
  body.querySelectorAll('[data-browse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const picked = await window.api.browseForPath({
        title: 'Select a folder of CleanerML definition files',
        directoryOnly: true
      });
      if (!picked || picked.canceled || !picked.path) return;
      const input = document.getElementById(`cleaner-folder-${cleaner.id}`);
      if (input) input.value = picked.path;
      if (state) state.definitionsPath = picked.path;
    });
  });

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

// zrw: install snapshot diff.
//
// The whole feature is: read, let the user do something, read again, subtract.
// The interesting decisions are all about honesty rather than mechanism -
// never implying Vanish performed the install, never implying the watch is
// complete when a category could not be read, and never leaving the user in a
// state where they have taken a "before" and cannot remember it.
// ---------------------------------------------------------------------------
let snapshotWatching = false;

function snapshotButtons() {
  return {
    begin: document.getElementById('btn-snapshot-begin'),
    finish: document.getElementById('btn-snapshot-finish'),
    cancel: document.getElementById('btn-snapshot-cancel'),
    result: document.getElementById('snapshot-result')
  };
}

function renderSnapshotState() {
  const el = snapshotButtons();
  if (!el.begin) return;
  el.begin.style.display = snapshotWatching ? 'none' : '';
  el.finish.style.display = snapshotWatching ? '' : 'none';
  el.cancel.style.display = snapshotWatching ? '' : 'none';
}

function renderSnapshotResult(diff, summary) {
  const el = snapshotButtons();
  if (!el.result) return;

  const rows = [];
  const LABELS = {
    uninstall: 'Uninstall entries',
    dirs: 'Folders',
    run: 'Startup entries',
    services: 'Services'
  };
  for (const key of ['uninstall', 'dirs', 'run', 'services']) {
    const c = diff.categories[key];
    if (!c) continue;
    if (!c.readable) {
      rows.push(`<div class="finding-row"><span class="risk-pill moderate">unreadable</span>
        <span>${esc(LABELS[key])} could not be read on this machine, so they are not counted.</span></div>`);
      continue;
    }
    for (const item of c.added) {
      rows.push(`<div class="finding-row"><span class="risk-pill safe">added</span>
        <span title="${esc(item)}">${esc(item)}</span></div>`);
    }
    for (const item of c.removed) {
      rows.push(`<div class="finding-row"><span class="risk-pill moderate">removed</span>
        <span title="${esc(item)}">${esc(item)}</span></div>`);
    }
  }

  el.result.innerHTML = `
    <div class="summary-line" style="margin-bottom: 10px;">
      <strong>${esc(summary)}</strong>
    </div>
    ${rows.length ? rows.join('') : ''}
    <p class="panel-lede" style="margin-top: 10px;">
      This is a comparison of two readings, not a recording. Anything an installer created and
      removed again in between is invisible to it, and it only watches the top level of the
      Program Files and app-data folders.
    </p>`;
}

function wireInstallSnapshot() {
  const el = snapshotButtons();
  if (!el.begin) return;

  el.begin.addEventListener('click', async () => {
    el.begin.disabled = true;
    try {
      const res = await window.api.snapshotBegin();
      if (!res || res.success !== true) {
        toast((res && res.error) || 'The first reading could not be taken.', 'error', 7000);
        return;
      }
      snapshotWatching = true;
      renderSnapshotState();
      if (el.result) el.result.innerHTML = '';
      toast('First reading taken. Run the installer yourself, then press "I\'m done installing".', 'info', 8000);
    } finally {
      el.begin.disabled = false;
    }
  });

  el.finish.addEventListener('click', async () => {
    el.finish.disabled = true;
    try {
      const res = await window.api.snapshotFinish();
      if (!res || res.success !== true) {
        // The "before" reading deliberately survives a failed second reading,
        // so this is a retry rather than a lost session - say so.
        toast(`${(res && res.error) || 'The second reading could not be taken.'} Your first reading is still held, so you can try again.`, 'error', 8000);
        return;
      }
      snapshotWatching = false;
      renderSnapshotState();
      renderSnapshotResult(res.diff, res.summary);
      toast(res.summary, res.diff.changed ? 'success' : 'info', 8000);
    } finally {
      el.finish.disabled = false;
    }
  });

  el.cancel.addEventListener('click', async () => {
    await window.api.snapshotCancel();
    snapshotWatching = false;
    renderSnapshotState();
    if (el.result) el.result.innerHTML = '';
    toast('Stopped watching. The first reading was discarded.', 'info');
  });

  // The "before" reading lives in the main process, so a renderer reload does
  // not lose it - but the button state would go stale without this.
  window.api.snapshotState().then((s) => {
    snapshotWatching = !!(s && s.watching);
    renderSnapshotState();
  }).catch(() => {});
}


// ---------------------------------------------------------------------------
// bu2: size attribution.
//
// The rendering rule that matters: "orphaned" and "unexplained" are different
// claims and are never styled or worded the same. Orphaned is a fact Vanish
// can defend - it watched the install and the program is gone. Unexplained is
// an admission. Presenting the second as the first is how every cleaner that
// ever lost someone's data got there.
// ---------------------------------------------------------------------------
function attributionRow(r) {
  const size = r.measured ? formatBytes(r.sizeBytes, 1) : 'not measured';
  const partial = r.partial ? ' (at least - some folders could not be read)' : '';

  let pill;
  let detail;
  if (r.state === 'orphaned') {
    pill = '<span class="risk-pill moderate">left behind</span>';
    detail = `belonged to ${esc(r.owner)}, which is no longer installed`;
  } else {
    pill = '<span class="risk-pill safe">unexplained</span>';
    detail = r.evidence === 'recorded-unknown-owner'
      ? 'Vanish watched this appear but never learned which program made it'
      : 'no installed program claims this folder - that does not mean it is rubbish';
  }

  return `<div class="finding-row">
    ${pill}
    <span style="flex:1;">
      <span title="${esc(r.path)}">${esc(r.path)}</span>
      <div class="app-publisher-name">${detail}</div>
    </span>
    <span style="white-space:nowrap; font-weight:600;">${esc(size)}${esc(partial)}</span>
  </div>`;
}

function renderAttribution(res) {
  const el = document.getElementById('attribution-result');
  if (!el) return;

  const listed = res.results.filter((r) => r.state === 'orphaned' || r.state === 'unattributed');
  const orphaned = res.results.filter((r) => r.state === 'orphaned');

  // The headline is only ever about what Vanish can defend. Unexplained
  // folders get their own count, never folded into a reclaimable total.
  const headline = orphaned.length > 0
    ? `${formatBytes(res.reclaimableBytes, 1)} in ${orphaned.length} folder${orphaned.length === 1 ? '' : 's'} left behind by programs you no longer have`
    : 'No folders were found that Vanish can prove outlived their program';

  const caveat = res.recordedInstallCount === 0
    ? 'Vanish can only say a folder was "left behind" if it watched the install that created it. It has not watched any yet, so everything below is listed as unexplained - use "Watch an install" above and this gets sharper over time.'
    : `Based on ${res.recordedInstallCount} recorded install${res.recordedInstallCount === 1 ? '' : 's'}. Folders from before that are listed as unexplained rather than guessed at.`;

  el.innerHTML = `
    <div class="summary-line" style="margin-bottom: 10px;"><strong>${esc(headline)}</strong></div>
    <p class="snapshot-card-lede" style="margin: 0 0 10px;">${esc(caveat)}</p>
    ${listed.length ? listed.map(attributionRow).join('') : '<p class="snapshot-card-lede">Every folder was matched to a program on this PC.</p>'}
    <p class="snapshot-card-lede" style="margin-top: 10px;">
      ${esc(`${res.counts.owned} matched to installed programs, ${res.counts.system} belong to Windows itself. ${res.measuredCount} folder${res.measuredCount === 1 ? ' was' : 's were'} measured - the rest did not need to be.`)}
    </p>`;
}

function wireAttribution() {
  const btn = document.getElementById('btn-attribution-scan');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const el = document.getElementById('attribution-result');
    btn.disabled = true;
    if (el) el.innerHTML = '<p class="snapshot-card-lede">Matching folders against installed programs...</p>';
    try {
      const res = await window.api.attributionScan();
      if (!res || res.success !== true) {
        const msg = (res && res.error) || 'The scan could not run.';
        if (el) el.innerHTML = '';
        toast(msg, 'error', 7000);
        return;
      }
      renderAttribution(res);
    } finally {
      btn.disabled = false;
    }
  });
}
