// Vanish renderer -- Machine Hygiene: the finder/decider seam, on screen.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, so every name declared here is
// visible to every other renderer file and must not collide with one. index.html
// loads them in the order listed there, and lib/findings.js loads BEFORE this.
//
// WHAT THIS SCREEN IS. finders/ produce typed results - three states each,
// computed from evidence rather than asserted - and lib/findings.js turns the
// whole set into exactly one named UI state. This file renders that state and
// nothing else. It does not decide; if it ever needs to, the decision belongs
// in findings.js where the wizard already shares it.
//
// AND WHAT IT IS NOT. Every registered finder is auditOnly. There is no remove
// button on this screen, in either tier, and that is the product argument
// rather than an unfinished feature: a check that can tell you a keystore
// exists nowhere else is worth shipping years before anything is allowed to
// delete it.
//
// WHY EACH CHECK RUNS SEPARATELY. Measured on the operator's machine
// 2026-08-28: the `hygiene` module alone takes 89 seconds, and all three
// together take longer than ten minutes - these walk the user profile and hash
// file contents. Running them as one call behind one spinner would be the
// Health Advisor defect again with an order of magnitude more time to be wrong
// in. Each check is its own engine call, renders when IT lands, and says so
// while it is still working.
//
// THE ONE RULE THAT SURVIVES ALL OF THAT: a partial run is never decided. The
// verdict block shows progress until every check has returned, because
// decide() over three of thirteen results would happily report NOTHING FOUND -
// which is aeu's exact defect wearing a progress bar.

// Everything the panel knows, so switching away and back re-renders what was
// found rather than silently re-walking the disk.
let hygieneFinders = [];        // the registry, from the engine
let hygieneResults = [];        // raw finder results, as they arrive
let hygieneStatus = {};         // finder name -> 'queued' | 'running' | 'done' | 'error'
let hygieneDecision = null;     // decide() over hygieneResults, ONLY when complete
let hygieneScanning = false;
let hygieneWired = false;
let hygieneLoadErrors = [];

// Three engine calls at a time. These are disk-bound: more processes past this
// just queue on the same spindle and make every individual check look slower
// on screen without finishing the set any sooner.
const HYGIENE_CONCURRENCY = 3;

// Rescue, then hygiene, then reclaim. The ORDER IS THE ARGUMENT: what a delete
// would destroy, then what is merely wrong, then bytes. A cleaner that leads
// with bytes is how people lose keystores.
const HYGIENE_MODULES = [
  {
    key: 'rescue',
    icon: 'fa-hand',
    title: 'Rescue',
    lede: 'Work that exists nowhere but this machine. Nothing here is waste; it is what a delete would cost you.'
  },
  {
    key: 'hygiene',
    icon: 'fa-broom',
    title: 'Hygiene',
    lede: 'Wrong, not wasteful. These reclaim no space at all and still matter -- a tool pointed at a drive you replaced, an entry for a user who left.'
  },
  {
    key: 'reclaim',
    icon: 'fa-hard-drive',
    title: 'Reclaim',
    lede: 'Regenerable bytes, ranked by what it costs to get them back rather than by how many there are.'
  },
  {
    key: 'other',
    icon: 'fa-circle-info',
    title: 'Other checks',
    lede: 'Findings from a check that did not declare one of the three modules.'
  }
];

// 'unknown' is deliberately NOT worded as harmless. An unmeasured cost is not a
// cheap one, and the ranker in findings.js sorts it last for the same reason.
const COST_LABEL = {
  cheap: 'cheap to rebuild',
  moderate: 'some work to rebuild',
  expensive: 'expensive to rebuild',
  irreplaceable: 'IRREPLACEABLE',
  unknown: 'rebuild cost unknown'
};

// costClass DOES NOT MEAN THE SAME THING IN EVERY MODULE, and rendering it as
// though it did put a real lie on screen. Caught by looking at a screenshot of
// a real run, 2026-08-28:
//
//     Repo is dirty: 1 uncommitted change(s)     [CHEAP TO REBUILD]
//
// which reads as "your uncommitted work is cheap to recreate" - the exact
// opposite of true, and the exact opposite of what this application exists to
// say. The finder was not wrong. In the hygiene module costClass describes the
// cost of ACTING ON THE ADVICE ('cheap' because setting an environment
// variable is free, as redirect-variables' own header says), not the cost of
// losing the thing. Only rescue and reclaim are talking about what a delete
// would destroy.
//
// So a hygiene finding gets no rebuild badge at all. lib/hygiene-report.js
// draws the same line for the same reason: module === 'hygiene' IS the
// definition of wrong-but-free, and it is what FOUND the item that decides
// that, never what the item would reclaim.
function hygieneShowsRebuildCost(f) {
  return f.module !== 'hygiene';
}

// The same trap, on the size. A hygiene finding's bytes are what is ALREADY
// sitting somewhere - 13 GB at the Android SDK's default location because
// ANDROID_HOME was never set - not bytes anything here would free. A bare
// "13 GB" in the slot the other two modules use for reclaimable size is a
// number the reader will finish the sentence of, wrongly.
function hygieneBytesLabel(f) {
  const size = hygieneBytes(f.bytes);
  if (!size) return '';
  return f.module === 'hygiene' ? `${size} already there` : size;
}

function hygieneEsc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hygieneBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function setupHygieneTab() {
  if (hygieneWired) return;
  const btn = document.getElementById('btn-hygiene-scan');
  if (!btn) return;
  btn.addEventListener('click', () => runHygieneScan());
  hygieneWired = true;
}

// Arriving at the tab renders what is already known. It does NOT scan: these
// checks walk the user profile and hash files, and opening a tab is not consent
// to that.
function renderHygienePanel() {
  setupHygieneTab();
  if (hygieneScanning) return;
  if (hygieneResults.length === 0) {
    renderHygieneInvitation();
    return;
  }
  renderHygieneAll();
}

function renderHygieneInvitation() {
  const verdict = document.getElementById('hygiene-verdict');
  if (verdict) {
    verdict.innerHTML = `
      <div class="hygiene-verdict neutral">
        <div class="hygiene-verdict-head">
          <i class="fa-solid fa-layer-group"></i>
          <span>Nothing has been checked yet</span>
        </div>
        <div class="hygiene-verdict-body">
          This screen makes no claim about your machine until you run the checks. That is the point
          of it: an empty result you never asked for looks exactly like a clean one. Checks read
          only, work in Audit Mode, and can take several minutes on a disk with many repositories.
        </div>
      </div>
    `;
  }
  const modules = document.getElementById('hygiene-modules');
  if (modules) modules.innerHTML = '';
  const unreadable = document.getElementById('hygiene-unreadable');
  if (unreadable) unreadable.innerHTML = '';
}

async function runHygieneScan() {
  if (hygieneScanning) return;

  const select = document.getElementById('hygiene-module-select');
  const chosen = select ? select.value : '';

  hygieneScanning = true;
  hygieneResults = [];
  hygieneStatus = {};
  hygieneDecision = null;
  hygieneLoadErrors = [];
  setHygieneButtonBusy(true);

  // The registry first. Without it there is no honest denominator for "3 of 13
  // done", and a progress line that invents its own total is a progress line
  // that can finish while work is still running.
  let registry;
  try {
    registry = await window.api.listHygieneFinders();
  } catch (err) {
    registry = { success: false, error: err.message, finders: [] };
  }

  if (!registry || registry.success !== true) {
    hygieneScanning = false;
    setHygieneButtonBusy(false);
    renderHygieneVerdictFailed(
      (registry && registry.error) || 'The list of checks could not be read, so none of them ran.'
    );
    return;
  }

  hygieneLoadErrors = Array.isArray(registry.loadErrors) ? registry.loadErrors : [];
  const all = Array.isArray(registry.finders) ? registry.finders : [];
  hygieneFinders = chosen ? all.filter((f) => f.module === chosen) : all;

  if (hygieneFinders.length === 0) {
    hygieneScanning = false;
    setHygieneButtonBusy(false);
    renderHygieneVerdictFailed('No checks are registered for that selection, so nothing ran.');
    return;
  }

  for (const f of hygieneFinders) hygieneStatus[f.name] = 'queued';
  renderHygieneProgress();
  renderHygieneChecklist();

  // A hand-rolled worker pool rather than Promise.all over the whole list: the
  // point is to bound how many engine processes exist at once, and Promise.all
  // starts all thirteen.
  const queue = hygieneFinders.slice();
  const workers = [];
  for (let i = 0; i < Math.min(HYGIENE_CONCURRENCY, queue.length); i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const finder = queue.shift();
          if (!finder) return;
          hygieneStatus[finder.name] = 'running';
          renderHygieneChecklist();

          let raw;
          try {
            raw = await window.api.runHygieneScan({ finders: [finder.name] });
          } catch (err) {
            raw = { success: false, error: err.message, results: [] };
          }

          const got = raw && Array.isArray(raw.results) ? raw.results : [];
          if (got.length > 0) {
            for (const r of got) hygieneResults.push(r);
            hygieneStatus[finder.name] = 'done';
          } else {
            // NOT an empty result. A check that did not run has established
            // nothing, and feeding decide() an absence here would let it be
            // counted as "looked, found nothing". Synthesise the could-not-look
            // state the engine would have returned if it had got that far.
            hygieneResults.push({
              finder: finder.name,
              title: finder.title,
              module: finder.module,
              findings: [],
              unreadable: [
                {
                  path: '(check)',
                  reason: 'check-did-not-run',
                  detail: (raw && raw.error) || 'The engine returned no result for this check.'
                }
              ],
              examinedCount: 0,
              totalBytes: 0,
              note: 'This check did not complete, so it has established nothing about the machine.'
            });
            hygieneStatus[finder.name] = 'error';
          }

          renderHygieneProgress();
          renderHygieneChecklist();
          renderHygieneModules(window.VanishFindings.decide(hygieneResults), true);
        }
      })()
    );
  }

  await Promise.all(workers);

  hygieneScanning = false;
  setHygieneButtonBusy(false);

  // ONLY NOW is a verdict legitimate. Everything above is progress.
  hygieneDecision = window.VanishFindings.decide(hygieneResults);
  renderHygieneAll();
}

function setHygieneButtonBusy(busy) {
  const btn = document.getElementById('btn-hygiene-scan');
  const select = document.getElementById('hygiene-module-select');
  if (btn) {
    btn.disabled = busy;
    btn.innerHTML = busy
      ? '<i class="fa-solid fa-spinner fa-spin"></i> Checking...'
      : '<i class="fa-solid fa-magnifying-glass"></i> Run checks';
  }
  if (select) select.disabled = busy;
}

function renderHygieneAll() {
  const decision = hygieneDecision || window.VanishFindings.decide(hygieneResults);
  renderHygieneVerdict(decision);
  renderHygieneModules(decision, false);
  renderHygieneUnreadable(decision);
  renderHygieneChecklist();
}

// While the scan is running this is a PROGRESS report and says nothing about
// the machine. Naming a terminal state here - even the reassuring one - would
// be claiming a result from a third of the evidence.
function renderHygieneProgress() {
  const el = document.getElementById('hygiene-verdict');
  if (!el) return;

  const total = hygieneFinders.length;
  const done = hygieneFinders.filter((f) => hygieneStatus[f.name] === 'done' || hygieneStatus[f.name] === 'error').length;
  const partial = window.VanishFindings.decide(hygieneResults);

  el.innerHTML = `
    <div class="hygiene-verdict neutral">
      <div class="hygiene-verdict-head">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>${done} of ${total} check${total === 1 ? '' : 's'} finished</span>
        ${
          partial.findingCount > 0
            ? `<span class="hygiene-bytes-total">${partial.findingCount} finding${
                partial.findingCount === 1 ? '' : 's'
              } so far</span>`
            : ''
        }
      </div>
      <div class="hygiene-verdict-body">
        Still working. Vanish will not say whether this machine is clean until every check has
        come back -- a verdict from a third of the evidence is exactly the mistake this screen
        exists to avoid. Findings appear below as they are found.
      </div>
    </div>
  `;
}

function renderHygieneVerdictFailed(why) {
  const el = document.getElementById('hygiene-verdict');
  if (!el) return;
  el.innerHTML = `
    <div class="hygiene-verdict failed">
      <div class="hygiene-verdict-head">
        <i class="fa-solid fa-circle-xmark"></i>
        <span>The checks did not run</span>
      </div>
      <div class="hygiene-verdict-body">
        ${hygieneEsc(why)} Nothing has been established about this machine -- treat this screen as
        blank, not as a result.
      </div>
    </div>
  `;
  const modules = document.getElementById('hygiene-modules');
  if (modules) modules.innerHTML = '';
  const unreadable = document.getElementById('hygiene-unreadable');
  if (unreadable) unreadable.innerHTML = '';
}

// One element, four outcomes, four different sentences. They license different
// next actions, which is exactly why they must not share a rendering: "I looked
// and found nothing" invites you to stop; "I could not finish looking" does not.
function renderHygieneVerdict(decision) {
  const el = document.getElementById('hygiene-verdict');
  if (!el) return;

  const F = window.VanishFindings;
  let tone = 'neutral';
  let icon = 'fa-circle-info';
  let lead = '';
  let body = '';

  switch (decision.state) {
    case F.UI_HAS_WORK:
      tone = 'work';
      icon = 'fa-lightbulb';
      lead = `${decision.findingCount} thing${decision.findingCount === 1 ? '' : 's'} worth your attention`;
      body =
        decision.unreadableCount > 0
          ? `Across ${decision.examinedCount} location${decision.examinedCount === 1 ? '' : 's'}. ` +
            `${decision.unreadableCount} could not be read, so there may be more.`
          : `Across ${decision.examinedCount} location${decision.examinedCount === 1 ? '' : 's'}, all of them readable.`;
      break;
    case F.UI_NOTHING_FOUND:
      tone = 'clean';
      icon = 'fa-circle-check';
      lead = 'Nothing found, and the check was complete';
      body =
        `${decision.examinedCount} location${decision.examinedCount === 1 ? '' : 's'} checked and every one of them ` +
        'readable. This is the only state on this screen that is safe to read as "clean".';
      break;
    case F.UI_INCOMPLETE:
      tone = 'incomplete';
      icon = 'fa-triangle-exclamation';
      lead = 'Nothing found -- but the checks did not finish';
      body =
        `No findings in the ${decision.examinedCount} location${decision.examinedCount === 1 ? '' : 's'} that could be read, ` +
        `and ${decision.unreadableCount} that could not. This is NOT the same as clean, and Vanish will not ` +
        'round it up to clean for you.';
      break;
    default:
      tone = 'failed';
      icon = 'fa-circle-xmark';
      lead = 'The checks did not run';
      body = 'Nothing has been established about this machine -- treat this screen as blank, not as a result.';
      break;
  }

  const bytes = hygieneBytes(decision.totalBytes);
  el.innerHTML = `
    <div class="hygiene-verdict ${tone}">
      <div class="hygiene-verdict-head">
        <i class="fa-solid ${icon}"></i>
        <span>${hygieneEsc(lead)}</span>
        ${bytes ? `<span class="hygiene-bytes-total">${hygieneEsc(bytes)} named</span>` : ''}
      </div>
      <div class="hygiene-verdict-body">${hygieneEsc(body)}</div>
      ${
        decision.disagreements && decision.disagreements.length > 0
          ? `<div class="hygiene-verdict-body hygiene-disagreement">
               ${decision.disagreements.length} check${decision.disagreements.length === 1 ? '' : 's'} reported a state
               that disagreed with its own evidence. Vanish used the evidence. That is a bug in the check,
               not in your machine: ${hygieneEsc(decision.disagreements.map((d) => d.finder).join(', '))}.
             </div>`
          : ''
      }
      ${
        hygieneLoadErrors.length > 0
          ? `<div class="hygiene-verdict-body hygiene-disagreement">
               ${hygieneLoadErrors.length} check file${hygieneLoadErrors.length === 1 ? '' : 's'} could not be loaded
               at all, so ${hygieneLoadErrors.length === 1 ? 'it was' : 'they were'} never run.
             </div>`
          : ''
      }
    </div>
  `;
}

// Which checks ran, and how each one ended. This is the antidote to a screen
// that looks the same whether a check found nothing or never executed.
function renderHygieneChecklist() {
  const host = document.getElementById('hygiene-checklist');
  if (!host) return;
  if (hygieneFinders.length === 0) {
    host.innerHTML = '';
    return;
  }

  const byName = {};
  for (const r of hygieneResults) byName[r.finder] = r;

  const rows = hygieneFinders
    .map((f) => {
      const status = hygieneStatus[f.name] || 'queued';
      const r = byName[f.name];
      let icon = 'fa-clock';
      let cls = 'queued';
      let note = 'queued';
      if (status === 'running') {
        icon = 'fa-spinner fa-spin';
        cls = 'running';
        note = 'running';
      } else if (status === 'error') {
        icon = 'fa-circle-xmark';
        cls = 'error';
        note = 'did not run';
      } else if (status === 'done' && r) {
        const found = (r.findings || []).length;
        const blind = (r.unreadable || []).length;
        if (found > 0) {
          icon = 'fa-lightbulb';
          cls = 'found';
          note = `${found} finding${found === 1 ? '' : 's'}`;
        } else if (blind > 0) {
          icon = 'fa-triangle-exclamation';
          cls = 'blind';
          note = `could not read ${blind} location${blind === 1 ? '' : 's'}`;
        } else {
          icon = 'fa-circle-check';
          cls = 'clean';
          note = 'nothing found';
        }
      }
      return `
        <div class="hygiene-check-row ${cls}">
          <i class="fa-solid ${icon}"></i>
          <span class="hygiene-check-title">${hygieneEsc(f.title || f.name)}</span>
          <span class="hygiene-check-note">${hygieneEsc(note)}</span>
        </div>
      `;
    })
    .join('');

  host.innerHTML = `
    <div class="hygiene-module">
      <div class="hygiene-module-head">
        <i class="fa-solid fa-list-check"></i>
        <span class="hygiene-module-title">What was checked</span>
        <span class="hygiene-module-summary">${hygieneFinders.length} check${
    hygieneFinders.length === 1 ? '' : 's'
  }</span>
      </div>
      <div class="hygiene-module-lede">
        Every check, and how it ended. "Nothing found" and "did not run" look identical on a screen
        that only lists findings, so they are named here instead.
      </div>
      ${rows}
    </div>
  `;
}

function renderHygieneModules(decision, partial) {
  const host = document.getElementById('hygiene-modules');
  if (!host) return;

  if (!partial && decision.state === window.VanishFindings.UI_FAILED) {
    host.innerHTML = '';
    return;
  }

  // Group the ALREADY-RANKED list rather than re-sorting per module, so the
  // order inside each block is still cost-first with bytes only as a tiebreak.
  const byModule = {};
  for (const f of decision.findings) {
    const key = HYGIENE_MODULES.some((m) => m.key === f.module) ? f.module : 'other';
    (byModule[key] = byModule[key] || []).push(f);
  }

  const ranByModule = {};
  for (const r of decision.results) {
    const key = HYGIENE_MODULES.some((m) => m.key === r.module) ? r.module : 'other';
    (ranByModule[key] = ranByModule[key] || []).push(r);
  }

  const blocks = [];
  for (const mod of HYGIENE_MODULES) {
    const ran = ranByModule[mod.key] || [];
    const found = byModule[mod.key] || [];
    if (ran.length === 0 && found.length === 0) continue;

    const blind = ran.filter((r) => r.unreadableCount > 0).length;
    let summary;
    if (found.length > 0) {
      summary = `${found.length} finding${found.length === 1 ? '' : 's'} from ${ran.length} check${
        ran.length === 1 ? '' : 's'
      }`;
    } else if (partial) {
      summary = `${ran.length} check${ran.length === 1 ? '' : 's'} back so far`;
    } else if (blind > 0) {
      summary = `no findings, but ${blind} of ${ran.length} check${ran.length === 1 ? '' : 's'} could not read everything`;
    } else {
      summary = `${ran.length} check${ran.length === 1 ? '' : 's'} ran and found nothing`;
    }

    blocks.push(`
      <div class="hygiene-module ${found.length > 0 ? 'has-findings' : ''}">
        <div class="hygiene-module-head">
          <i class="fa-solid ${mod.icon}"></i>
          <span class="hygiene-module-title">${hygieneEsc(mod.title)}</span>
          <span class="hygiene-module-summary">${hygieneEsc(summary)}</span>
        </div>
        <div class="hygiene-module-lede">${hygieneEsc(mod.lede)}</div>
        ${found.length > 0 ? found.map(renderHygieneFinding).join('') : ''}
      </div>
    `);
  }

  host.innerHTML = blocks.join('');
}

function renderHygieneFinding(f) {
  const cost = String(f.costClass || 'unknown');
  const showsCost = hygieneShowsRebuildCost(f);
  const bytes = hygieneBytesLabel(f);
  return `
    <div class="hygiene-finding ${showsCost ? `cost-${hygieneEsc(cost)}` : 'wrong-but-free'}">
      <div class="hygiene-finding-head">
        <span class="hygiene-finding-title">${hygieneEsc(f.title)}</span>
        ${
          showsCost
            ? `<span class="hygiene-cost cost-${hygieneEsc(cost)}">${hygieneEsc(COST_LABEL[cost] || COST_LABEL.unknown)}</span>`
            : '<span class="hygiene-cost wrong-but-free">nothing to remove</span>'
        }
        ${bytes ? `<span class="hygiene-finding-bytes">${hygieneEsc(bytes)}</span>` : ''}
      </div>
      ${f.path ? `<div class="hygiene-finding-path mono">${hygieneEsc(f.path)}</div>` : ''}
      ${
        f.evidence
          ? `<div class="hygiene-finding-evidence"><strong>Why Vanish believes this:</strong> ${hygieneEsc(f.evidence)}</div>`
          : ''
      }
      ${
        f.rebuildCost
          ? `<div class="hygiene-finding-rebuild"><strong>To get it back:</strong> ${hygieneEsc(f.rebuildCost)}</div>`
          : ''
      }
      <div class="hygiene-finding-foot">Reported by <span class="mono">${hygieneEsc(
        f.finder
      )}</span> &middot; audit only, Vanish will not remove this</div>
    </div>
  `;
}

// Kept out of the finding list on purpose. A location that could not be read is
// not a finding about the machine; it is a gap in what the scan can claim, and
// merging the two is how a partial scan starts reading as a complete one.
function renderHygieneUnreadable(decision) {
  const host = document.getElementById('hygiene-unreadable');
  if (!host) return;

  if (!decision.unreadable || decision.unreadable.length === 0) {
    host.innerHTML = '';
    return;
  }

  const rows = decision.unreadable
    .slice(0, 50)
    .map(
      (u) => `
      <div class="hygiene-blind-row">
        <span class="mono">${hygieneEsc(u.path || '(unnamed location)')}</span>
        <span class="hygiene-blind-reason">${hygieneEsc(u.reason || 'unknown reason')}${
        u.detail ? ` -- ${hygieneEsc(u.detail)}` : ''
      }</span>
      </div>`
    )
    .join('');

  host.innerHTML = `
    <div class="hygiene-module hygiene-blind">
      <div class="hygiene-module-head">
        <i class="fa-solid fa-eye"></i>
        <span class="hygiene-module-title">Could not look here</span>
        <span class="hygiene-module-summary">${decision.unreadable.length} location${
    decision.unreadable.length === 1 ? '' : 's'
  }</span>
      </div>
      <div class="hygiene-module-lede">
        These are not findings. They are the edges of what this scan can honestly claim -- usually a
        permission Vanish does not have, or a path Windows would not open.
      </div>
      ${rows}
      ${
        decision.unreadable.length > 50
          ? `<div class="hygiene-blind-row"><span class="hygiene-blind-reason">and ${
              decision.unreadable.length - 50
            } more</span></div>`
          : ''
      }
    </div>
  `;
}
