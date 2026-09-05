// Vanish renderer -- The uninstall wizard
//
// Native uninstaller first, then leftover review, then the quarantine
// pipeline. The approval loop this whole app is built around.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

// ==========================================
// UNINSTALL WIZARD LOGIC
// ==========================================

function openUninstallWizard(app) {
  wizState.currentScreenIndex = 0;
  wizState.createRestorePoint = true;
  // p171: cleared per uninstall. The offer is revealed by a failure, and a
  // failure belongs to the program it happened to - carrying it into the next
  // program's wizard would suggest that one is broken too, on no evidence.
  hideForceUninstallOffer();
  // d6y: per-uninstall, but starts from whatever was picked last time -
  // appSettings.preferSilentUninstall is only ever written by this
  // checkbox's own change handler below, never assumed true on a settings
  // read that predates the field (store.js migrates it in either way).
  wizState.runSilently = appSettings.preferSilentUninstall !== false;
  wizState.scanMode = appSettings.defaultScanMode || 'Moderate';
  wizState.leftovers = { files: [], registry: [] };
  // Null until the scan runs. showScreen reads this as "nothing to
  // quarantine", never as permission - an unresolved state must not share a
  // representation with a real answer (aeu).
  wizState.leftoverDecision = null;
  wizState.selectedFiles = [];
  wizState.selectedRegistry = [];
  wizState.spaceReclaimedBytes = 0;

  // Set checkbox state in Config screen
  elements.chkCreateRestore.checked = true;
  // chk-run-silently lives on scr-native-run (screen 3), not this screen -
  // still safe to set its checked state now, before it is ever shown.
  elements.chkRunSilently.checked = wizState.runSilently;
  updateNativeUninstPromptText();
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

// The decided state of the leftover screen (5p5). One accessor, so no caller
// re-derives it and none of them can disagree about which screen this is.
// Null before the scan has run, which is itself a state showScreen treats as
// "nothing to quarantine" rather than as permission.
function leftoverDecision() {
  return wizState.leftoverDecision || null;
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

  // D-1. This used to read `(index === 4) ? 'block' : 'none'` - the leftover
  // screen always offered "Move to quarantine", whatever the scan found. When
  // it found nothing, clicking it asked "Finish without moving anything?" and
  // closed the wizard: a destructive-looking control performing navigation it
  // does not name, in a state where navigation is not meaningful.
  //
  // The fix is not a guard inside the click handler. The button's existence is
  // now a function of the SCREEN'S STATE, and that state is computed from the
  // scan's evidence by lib/findings.js - which has no path from "nothing
  // found" to canAdvance. There is nowhere left to put the bug.
  const decision = (index === 4) ? leftoverDecision() : null;
  const canQuarantine = decision ? decision.canAdvance : false;
  elements.btnWizPurge.style.display = canQuarantine ? 'block' : 'none';
  elements.btnWizFinish.style.display = (index === 6 || (index === 4 && !canQuarantine)) ? 'block' : 'none';
  if (elements.btnSelectAll) elements.btnSelectAll.style.display = canQuarantine ? '' : 'none';

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
// d6y: `interactive` is a parameter, not read from wizState internally - this
// is called from two places (the full wizard, which has the screen-1
// checkbox to source it from, and Force Uninstall's "run its uninstaller"
// quick path, which has no wizard UI at all). Reading wizState.runSilently
// here would have let the quick path silently inherit whatever the wizard
// was last left at, unrelated to anything the user chose for THIS uninstall.
async function runNativeUninstaller(app, { interactive = false } = {}) {
  const request =
    app.type === 'UWP'
      ? { type: 'UWP', packageFullName: app.packageFullName }
      // interactive means "use baseArgs alone, skip the resolved silent
      // switch" - see main.js's uninstall-native handler. UWP has no
      // equivalent concept (Remove-AppxPackage is always silent), so the
      // field is only meaningful on this branch.
      : { type: 'Desktop', registryPath: app.registryPath, interactive };

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

// d6y: what this text says has to track the toggle that lives on the SAME
// screen (see setupWizardControls' chk-run-silently listener) - "follow the
// steps on screen" is actively wrong advice when silent was chosen, and
// "no window will appear" is wrong when it was not.
function updateNativeUninstPromptText() {
  const el = document.getElementById('native-uninst-prompt-text');
  if (!el) return;
  el.textContent = wizState.runSilently
    ? "Vanish will run this program's own uninstaller silently. No window should appear - click below to start it."
    : "Vanish will open the uninstaller that came with this program. Click below, then follow the steps on screen.";
}

// p171: revealed when the native uninstaller has failed, and only then.
//
// Reset by showScreen so it does not survive into the next app's wizard - a
// suggestion that this program might be broken, shown on a program that has not
// failed, is worse than not offering it at all.
function showForceUninstallOffer() {
  const offer = document.getElementById('native-uninst-force-offer');
  if (offer) offer.style.display = 'block';
}

function hideForceUninstallOffer() {
  const offer = document.getElementById('native-uninst-force-offer');
  if (offer) offer.style.display = 'none';
}

function setupWizardControls() {
  const btnForce = document.getElementById('btn-native-uninst-force');
  if (btnForce) {
    btnForce.addEventListener('click', () => {
      closeUninstallWizard();
      switchTab('force-uninstall');
    });
  }

  // Close / Cancel click
  elements.wizCloseX.addEventListener('click', confirmCancel);

  // d6y: remembered across uninstalls (store.js preferSilentUninstall),
  // updated live so screen 3's prompt text is never one click stale even
  // before the wizard actually advances past this screen.
  elements.chkRunSilently.addEventListener('change', () => {
    wizState.runSilently = elements.chkRunSilently.checked;
    updateNativeUninstPromptText();
    saveSettings({ preferSilentUninstall: wizState.runSilently });
  });
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
      // d6y: chk-run-silently lives on scr-native-run now, not this screen -
      // wizState.runSilently is set at wizard-open and kept live by that
      // checkbox's own 'change' listener, nothing to re-read here.
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
        // Decide BEFORE rendering, and render from the decision. The order
        // matters: the previous code rendered a tree and then let the buttons
        // decide for themselves what the screen meant (D-1).
        wizState.leftoverDecision = window.VanishFindings.fromLeftovers(result);
        renderLeftoversTree();
        showScreen(4); // Show tree checklist
      } catch (err) {
        // A throw here is the same class of event as a failed scan inside the
        // engine, so it produces the same state rather than dumping the user
        // back two screens with a toast they can miss.
        wizState.leftovers = { files: [], registry: [] };
        wizState.leftoverDecision = window.VanishFindings.fromLeftovers({ success: false, error: err.message });
        renderLeftoversTree();
        showScreen(4);
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

    const res = await runNativeUninstaller(selectedApp, { interactive: wizState.runSilently !== true });

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
      //
      // d6y: res.method ('corrections' vs 'heuristic') and res.interactive
      // were already returned by main.js's uninstall-native handler and
      // already logged to the oplog - just never shown here, which is the
      // exact "presents both identically" problem the recommendation named.
      // A verified corrections.json switch and a guessed heuristic one are
      // different claims about how sure Vanish is, same honesty principle as
      // xw2/h8j; surfacing the distinction rather than only the risky half
      // keeps the confident case visibly confident too.
      const methodNote = res.method === 'corrections'
        ? ' (a switch verified for this program)'
        : res.method === 'heuristic'
          ? ' (a general switch, not verified for this specific program - worth confirming it fully uninstalled)'
          : '';
      const interactiveNote = wizState.runSilently === true && res.interactive === true
        ? ' It opened its own window anyway - some uninstallers do this regardless of the switch used.'
        : '';
      toast(
        `${res.rebootRequired ? 'The uninstaller finished. Windows needs a restart to complete it.' : 'The uninstaller finished.'}` +
        `${methodNote}${interactiveNote} Click Scan Leftovers.`,
        'success',
        7000
      );
    } else if (res.declined) {
      toast(res.error, 'warn');
    } else {
      toast(`The uninstaller did not finish: ${res.error} You can still scan for leftovers.`, 'warn', 7000);
      // p171: THE MOMENT Force Uninstall is actually wanted. It used to be a
      // peer entry in the sidebar, which asked the user to know in advance that
      // this was going to happen - and nobody knows that in advance. The offer
      // belongs on the failure.
      //
      // An offer rather than a redirect: the uninstaller failing is not proof
      // the entry is broken (it may have been cancelled, or need a reboot), and
      // scanning for leftovers is still the right next step for most of these.
      // So the wizard does not move, and a way out appears next to the button
      // that just failed.
      showForceUninstallOffer();
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
        // Same source as the lock flag above: classified once, in the main
        // process, and mutually exclusive with it. A locked file used to match
        // BOTH, because Windows says "cannot access the file because it is
        // being used" and the old test looked for "access" - so a lock was
        // offered a destructive ACL change as its remedy.
        const denied = p.aclSuspected === true;
        // The main process classified this and put the answer on the row
        // (lib/lock-failure.js). This file used to re-derive it from the error
        // string with its own copy of the rule - two implementations of one
        // rule, free to drift, "guarded" by a test that could not fail.
        const locked = p.lockSuspected === true;
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


// h55 moved the authoritative copy of this rule to lib/lock-failure.js, where
// the main process uses it to decide what goes into the operation log. This
// one stays because the renderer cannot require a lib module across the context
// bridge, and it is deliberately IDENTICAL rather than improved - two copies
// that differ is the mirror-drift defect this repository keeps rediscovering,
// and a test asserts the two expressions still match character for character
// so the next person to improve one is told about the other.
fu
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
  
  // D-1: the zero-finding case is a NAMED TERMINAL STATE, and there are two of
  // them, not one. "This program removed itself cleanly" and "the scan did not
  // finish" both used to render as the green tick above - which meant a
  // crashed scan congratulated the user on a clean uninstall. The state comes
  // from lib/findings.js so that this screen and the buttons underneath it
  // cannot reach different conclusions about the same scan.
  const decision = leftoverDecision();
  if (decision && !decision.canAdvance) {
    const clean = decision.state === window.VanishFindings.UI_NOTHING_FOUND;
    tree.innerHTML = `
      <div class="empty-leftovers">
        <i class="fa-solid ${clean ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
        <h4 style="font-family: var(--font-title); font-weight: 700;">${clean ? 'No leftovers found' : 'The scan did not finish'}</h4>
        <p style="font-size: 12px; color: var(--text-gray);">${esc(decision.headline)}</p>
        ${clean ? '<p style="font-size: 12px; color: var(--text-gray);">This program removed itself cleanly.</p>' : ''}
      </div>
    `;
    elements.lblLeftoversSummary.textContent = clean
      ? '0 leftovers found'
      : `0 found, ${decision.unreadableCount} location(s) unreadable`;
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
