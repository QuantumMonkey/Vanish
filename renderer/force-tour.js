// Vanish renderer -- Force Uninstall and the guided tour
//
// Forcing is the fallback: when a working uninstaller still exists, Vanish
// says so and offers to run it instead.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

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
      // No wizard screen here to offer a per-uninstall choice - respect the
      // remembered preference (store.js preferSilentUninstall) as the
      // sensible default for this quick path instead.
      const res = await runNativeUninstaller(
        { type: 'Desktop', name: entry.displayName, registryPath: entry.registryPath },
        { interactive: appSettings.preferSilentUninstall === false }
      );
      // d6y: same method honesty as the main wizard's completion toast.
      const methodNote = res.success && res.method === 'heuristic'
        ? ' (a general switch, not verified for this specific program)'
        : '';
      toast(
        res.success
          ? `The uninstaller finished.${methodNote} Scan again to check for leftovers.`
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

// ---------------------------------------------------------------------------