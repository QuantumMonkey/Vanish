// Vanish renderer -- ag0: Windows updates, as a legible list.
//
// Part of the renderer split. A CLASSIC SCRIPT, like its siblings: top-level
// let/const/function share one global lexical environment with the other
// renderer files, which is why nothing is imported or exported here.
//
// WHAT THIS IS FOR. Windows can already roll updates back - the redundancy was
// never the rollback, it was the idea of reimplementing wusa/DISM, and that
// stays cut. What Windows does badly is the LIST: Settings > Windows Update >
// Update history > Uninstall updates is several clicks deep, shows bare KB
// numbers with no indication of what any of them is, surfaces no useful install
// date, and never says what removing one would cost you.
//
// So: we build the list, and Windows keeps the removal. Nothing in this file
// removes anything, and the copy must never imply Vanish could put one back.

// 194 rows on the development machine, 179 of them on-demand optional
// components nobody opened this screen to read. Show the recent ones, count
// the rest, and say so - the same rule the program list follows.
const UPDATE_PAGE_SIZE = 25;
let updatesExpanded = false;
let lastUpdatePayload = null;

function renderWindowsUpdates(res) {
  const body = document.getElementById('audit-updates-body');
  const badge = document.getElementById('audit-updates-badge');
  if (!body) return;
  lastUpdatePayload = res;

  if (!res || res.success !== true) {
    if (badge) badge.style.display = 'none';
    const why = (res && res.error) || 'The update list could not be read.';
    body.innerHTML =
      '<div class="panel-state error"><i class="fa-solid fa-circle-xmark"></i><div>' +
      esc(why) +
      '</div></div>';
    return;
  }

  const all = res.updates || [];
  if (badge) {
    badge.style.display = '';
    badge.textContent = String(all.length);
  }

  if (all.length === 0) {
    body.innerHTML =
      '<div class="panel-state"><i class="fa-solid fa-circle-check"></i>' +
      '<div>Windows reports no installed updates on this PC.</div></div>';
    return;
  }

  const shown = updatesExpanded ? all : all.slice(0, UPDATE_PAGE_SIZE);
  const held = all.length - shown.length;

  const rows = shown.map(updateRowHtml).join('');

  // Everything held back is named, and so is everything Windows never recorded.
  // A date column that is blank on 84 of 194 rows reads as Vanish failing to
  // look, unless it says otherwise.
  const notes = [];
  if (held > 0) notes.push(held + ' older update' + (held === 1 ? '' : 's') + ' not shown');
  if (res.recentCount > 0) notes.push(res.recentCount + ' installed in the last ' + res.recentDays + ' days');
  if (res.undatedCount > 0) notes.push(res.undatedCount + ' carry no install date from Windows');

  const dismWarning = res.dismNote
    ? '<div class="panel-inline-note">' + esc(res.dismNote) + '</div>'
    : '';

  let more = '';
  if (held > 0) {
    more = '<button class="btn-sec btn-compact" id="btn-updates-more">Show all ' + all.length + '</button>';
  } else if (updatesExpanded && all.length > UPDATE_PAGE_SIZE) {
    more = '<button class="btn-sec btn-compact" id="btn-updates-less">Show fewer</button>';
  }

  body.innerHTML =
    dismWarning +
    '<div class="update-caption">Showing ' + shown.length + ' of ' + all.length +
    (notes.length ? ' - ' + esc(notes.join(', ')) : '') + '</div>' +
    rows +
    '<div style="margin-top: 10px;">' + more + '</div>';

  const moreBtn = document.getElementById('btn-updates-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      updatesExpanded = true;
      renderWindowsUpdates(lastUpdatePayload);
    });
  }
  const lessBtn = document.getElementById('btn-updates-less');
  if (lessBtn) {
    lessBtn.addEventListener('click', () => {
      updatesExpanded = false;
      renderWindowsUpdates(lastUpdatePayload);
    });
  }

  body.querySelectorAll('[data-update-kb]').forEach((btn) => {
    btn.addEventListener('click', () => explainUpdateRemoval(btn.getAttribute('data-update-kb')));
  });
}

function updateRowHtml(u) {
  // c0y discipline: a date that could not be trusted is a blank WITH a reason,
  // never a plausible-looking guess. The engine already refuses to hand over an
  // install time in the future, because an update cannot have been installed
  // tomorrow and showing one would put an impossible row at the top of a list
  // sorted by date.
  const when = u.installedOn
    ? '<span class="update-when-real">' + esc(new Date(u.installedOn).toLocaleDateString()) + '</span>'
    : '<span class="update-nodate" title="' +
      esc(u.installedOnNote || 'Windows did not record an install date for this package.') +
      '">not recorded</span>';

  const kbLabel = u.kb
    ? esc(u.kb)
    : '<span class="update-nokb">no KB number</span>';

  const handoff = u.kb
    ? '<button class="btn-sec btn-compact" data-update-kb="' + esc(u.kb) +
      '" title="Shows how Windows removes this update. Vanish does not remove it.">How to remove</button>'
    : '';

  return (
    '<div class="update-row">' +
    '<div class="update-row-main">' +
    '<div class="update-kb">' + kbLabel + ' <span class="update-kind">' + esc(u.kind || 'Update') + '</span></div>' +
    '<div class="update-title">' + esc(u.title || '') + '</div>' +
    '<div class="update-cost">' + esc(u.removalNote || '') + '</div>' +
    '</div>' +
    '<div class="update-row-side">' +
    '<div class="update-when">' + when + '</div>' +
    handoff +
    '</div>' +
    '</div>'
  );
}

// The handoff, and the only action this feature offers. It states Windows'
// command rather than running it: Vanish never owns this removal, cannot put an
// update back, and the dialog says both.
async function explainUpdateRemoval(kb) {
  const num = String(kb || '').replace(/^KB/i, '');
  const ok = await confirmDialog({
    title: 'Removing ' + kb + ' is a job for Windows, not Vanish',
    body:
      'Vanish does not remove Windows updates, and could not put one back if removing it went ' +
      'wrong - so it will not offer to.\n\n' +
      'Windows removes it with:\n\n    wusa.exe /uninstall /kb:' + num + '\n\n' +
      'or from Settings > Windows Update > Update history > Uninstall updates.\n\n' +
      'Many updates refuse to be removed at all - cumulative ones especially - and Windows ' +
      'usually tells you that only by failing.',
    confirmLabel: 'Open Windows Update history',
    cancelLabel: 'Close'
  });

  if (!ok) return;
  if (window.api && window.api.openExternalLink) {
    window.api.openExternalLink('ms-settings:windowsupdate-history');
  } else {
    toast('Open Settings > Windows Update > Update history to remove it.', 'info', 6000);
  }
}
