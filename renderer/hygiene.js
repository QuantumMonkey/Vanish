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
// WHY THE CHECKS ARE NOT ONE CALL. These walk the user profile and hash file
// contents. Measured on the operator's machine: over ten minutes for the set
// on 2026-08-28, 81.5 s on 2026-08-29 after lhf and 3l8. Even at a minute,
// running the lot as one call behind one spinner would be the Health Advisor
// defect again with far more time to be wrong in. So the panel schedules small
// units, renders each as it LANDS, and says which check is working meanwhile.
//
// The unit is a walk group rather than a single check (3l8): checks that read
// the same tree go in one call so the engine can walk it once, and nothing
// else is grouped, because grouping costs exactly the progressiveness this
// design is buying.
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

// Three engine calls at a time, and the number is measured rather than
// assumed. The comment that used to sit here said more processes "just queue
// on the same spindle ... without finishing the set any sooner". Measured on
// the operator machine, same 13 checks, same scheduling, one sitting:
//
//     pool 1   wall 136.8 s   summed 136.8 s
//     pool 2   wall  78.4 s   summed 143.4 s
//     pool 3   wall  58.1 s   summed 145.1 s
//
// Running three at once inflates each individual check by 6.1% and cuts the
// wall clock by 2.35x. The contention is real and it is small; the old
// comment had the sign right and the magnitude badly wrong.
//
// Whether 4 or more still pays is UNTESTED. The sweep above stops at 3
// because that is what ships, and a number nobody measured does not belong
// in a comment -- which is the whole point of this block.
//   VANISH_PROBE_CONCURRENCY=4 node test/sandbox/hygiene-scheduling-probe.js
const HYGIENE_CONCURRENCY = 3;

// 3l8: the unit of scheduling is a WALK GROUP, not a finder.
//
// Four reclaim checks read the same tree, and Invoke-SharedTreeWalk memoises
// that walk per PROCESS -- so they only share it if they run in ONE engine
// call. Split across four calls the cache never hits and the saving is
// exactly zero. Measured on the operator's machine: 66.2 s as four calls,
// 28.2 s as one, with byte-identical findings on both sides.
//
// There are two such groups (lxl). The reclaim checks read the home
// directory to depth 8 with fifteen names pruned; the two git checks read
// it to depth 6 with nothing pruned and no directory cap. Those are
// different questions about the same disk, so they are two walks and two
// groups -- merging them would change what is covered rather than how
// fast it is covered.
//
// The grouping is NOT hardcoded here. The engine reports each finder's
// walkGroup (Register-Finder in finders/_loader.ps1), so a fifth finder
// joining the shared walk changes no renderer code and cannot be forgotten
// about here.
//
// WHAT GROUPING COSTS, because it does cost something: the four report
// together instead of one at a time. That is exactly why only finders that
// genuinely share a walk are grouped. The progressive checklist is the
// reason this panel makes nine calls instead of one in the first place,
// and trading it away where there is no walk to share would be paying the
// price for none of the benefit.
function hygieneWalkUnits(finders) {
  const units = [];
  const byGroup = new Map();
  for (const f of finders) {
    const group = String((f && f.walkGroup) || '').trim();
    if (!group) {
      units.push([f]);
      continue;
    }
    if (!byGroup.has(group)) {
      const unit = [];
      byGroup.set(group, unit);
      units.push(unit);
    }
    byGroup.get(group).push(f);
  }
  return units;
}

// Which order to RUN them in, which is not the order to LIST them in.
//
// Grouping created a tail. The four reclaim checks are the second-largest
// piece of work in the scan and they sit last in registry order, so with a
// pool of three they were the last thing started and the last thing to
// finish -- the whole scan ended when they did. Measured, same run, same
// machine: 92.3 s in registry order, 81.5 s with the group started first.
//
// The proxy is unit SIZE, not measured duration, and that is a deliberate
// limit rather than an oversight. Vanish does not know how long a check will
// take on a disk it has not walked yet, and a table of expected durations
// would be a set of numbers from one machine pretending to be a fact about
// every machine. Size is a fact about the work being asked for.
//
// IT MOVES THE TAIL, IT DOES NOT REMOVE IT, and the measurement says so: with
// the group started first, the last check to finish is reclaim-package-caches
// - one check, 45 s, sorted behind a four-check group because size is the only
// measure available before the disk has been walked. Still the better trade on
// the numbers, but the honest claim is a smaller tail, not none. Scheduling by
// measured duration is bd vanish-uninstaller-4v8.
//
// This changes nothing on screen. The checklist renders from hygieneFinders
// and the modules render in HYGIENE_MODULES order, both independent of the
// order results arrive in - rescue still reads before reclaim.
function hygieneScheduleOrder(units) {
  return units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => (b.unit.length - a.unit.length) || (a.index - b.index))
    .map((x) => x.unit);
}

// How many findings a module renders before it stops and says so.
//
// Not a guess. Once duplicate-content was made to actually finish (it used to
// run past a 240-second cap without completing), one real run on the operator's
// machine returned 4,035 findings -- and every one of them is a card with a
// path, an evidence sentence and a cost badge. Rendering all of them freezes
// the page to produce a list nobody scrolls.
//
// The cap is safe to apply BECAUSE the list is already ranked by rebuild cost
// rather than by size (lib/findings.js rankFindings): the ones you cannot get
// back are at the top, and the tail is the part a single command regenerates.
// The count in the module header stays the REAL total, and the notice says
// plainly that the rest exist. A cap that quietly showed 100 and reported 100
// would be this suite's own defect class wearing a scrollbar.
const HYGIENE_RENDER_CAP = 100;

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
  wireHygieneDecisionBar();
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
  refreshHygieneDecisionBar(null);
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
  // starts every unit at once.
  //
  // The queue holds WALK UNITS, not finders. Ten units cover the thirteen
  // checks: nine that scan on their own, and one that is the four reclaim
  // checks sharing a single walk of the home directory (3l8). Largest unit
  // first, so the biggest piece of work is not what everything waits on.
  const queue = hygieneScheduleOrder(hygieneWalkUnits(hygieneFinders));
  const workers = [];
  for (let i = 0; i < Math.min(HYGIENE_CONCURRENCY, queue.length); i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const unit = queue.shift();
          if (!unit) return;
          for (const f of unit) hygieneStatus[f.name] = 'running';
          renderHygieneChecklist();

          let raw;
          try {
            raw = await window.api.runHygieneScan({ finders: unit.map((f) => f.name) });
          } catch (err) {
            raw = { success: false, error: err.message, results: [] };
          }

          const got = raw && Array.isArray(raw.results) ? raw.results : [];
          const returned = new Set();
          for (const r of got) {
            if (!r || !r.finder) continue;
            hygieneResults.push(r);
            returned.add(r.finder);
            hygieneStatus[r.finder] = 'done';
          }

          // EVERY finder in the unit is accounted for, not just the call.
          //
          // A check that did not run has established nothing, and feeding
          // decide() an absence here would let it be counted as "looked,
          // found nothing". So the could-not-look the engine would have
          // returned, had it got that far, is synthesised instead.
          //
          // Grouping (3l8) added a failure mode a one-finder call did not
          // have: THREE results coming back for a unit of four. The fourth is
          // then missing rather than failed, which is the same defect wearing
          // a success badge -- so the loop is over the unit, not over what
          // came back, and the two cases are told apart in the detail line.
          for (const f of unit) {
            if (returned.has(f.name)) continue;
            const detail = (raw && raw.error)
              ? raw.error
              : (unit.length > 1 && got.length > 0
                ? `The engine answered for ${got.length} of the ${unit.length} checks that share this scan of the disk, and returned nothing at all for this one.`
                : 'The engine returned no result for this check.');
            hygieneResults.push({
              finder: f.name,
              title: f.title,
              module: f.module,
              findings: [],
              unreadable: [{ path: '(check)', reason: 'check-did-not-run', detail }],
              examinedCount: 0,
              totalBytes: 0,
              note: 'This check did not complete, so it has established nothing about the machine.'
            });
            hygieneStatus[f.name] = 'error';
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
  // Last, and with the decision that was actually drawn: the bar must never
  // describe a state the panel below has already moved past.
  refreshHygieneDecisionBar(decision);
}

// While the scan is running this is a PROGRESS report and says nothing about
// the machine. Naming a terminal state here - even the reassuring one - would
// be claiming a result from a third of the evidence.
function renderHygieneProgress() {
  refreshHygieneDecisionBar(hygieneDecision);
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
  refreshHygieneDecisionBar({
    state: window.VanishFindings.UI_FAILED,
    findings: [], unreadable: [],
    findingCount: 0, unreadableCount: 0, examinedCount: 0, totalBytes: 0
  });
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
// ---------------------------------------------------------------------------
// THE DECISION BAR (949 / one-click decisions)
//
// The panel below answers "what did we find". This answers the only question
// the operator actually has, which is "so what do I do now", and it answers it
// with ONE recommended click.
//
// WHY IT CANNOT BE A CLEAN BUTTON, which is the obvious thing to build here
// and the wrong thing. Nothing on this screen is removable by Vanish in either
// mode; the lede says so and every finder is audit-only. A one-click action
// that deleted things would not be a faster version of this screen, it would
// be a different product -- the one this project exists as an alternative to.
// So every action here opens, filters, scrolls or copies. The bar says that
// out loud, permanently, rather than relying on the operator to infer it.
//
// THE RULE THAT DOES THE REAL WORK: the recommended click is chosen by COST,
// never by size. The biggest number on this screen is a package cache, and it
// is the least consequential thing here; the most consequential is a folder of
// uncommitted work that fits in a megabyte. A bar that led with "free 14.3 GB"
// would be teaching exactly the habit that loses people their data. Bytes
// appear on the SECONDARY action or not at all. lib/findings.js already ranks
// findings this way and explains why; this is the same rule at the level of
// the offer rather than the list.
//
// AND: no action is offered from evidence that is not complete. decide()
// exposes `trustworthy`, and a scan with unreadable locations does not get an
// act-on-the-total button, because the total is a floor and not a total. The
// control is DISABLED and says why -- never hidden, never enabled-then-sorry.
// A control the operator can click that the system will refuse is a promise
// the screen cannot keep.
// ---------------------------------------------------------------------------

// The standing promise, rendered in every phase including the empty one.
const HYGIENE_NEVER = 'Nothing on this screen deletes anything. These actions open, filter or copy.';

function hygieneCostCounts(findings) {
  const counts = { cheap: 0, moderate: 0, expensive: 0, irreplaceable: 0, unknown: 0 };
  for (const f of Array.isArray(findings) ? findings : []) {
    const k = String((f && f.costClass) || 'unknown');
    if (Object.prototype.hasOwnProperty.call(counts, k)) counts[k] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function hygieneModuleBytes(findings, moduleKey) {
  let n = 0;
  for (const f of Array.isArray(findings) ? findings : []) {
    if (f && f.module === moduleKey) n += Number(f.bytes) || 0;
  }
  return n;
}

function hygieneAct(id, label, enabled, why, tone) {
  return { id: id, label: label, enabled: !!enabled, why: why || '', tone: tone || '' };
}

// PURE. Takes the decision and where the scan is up to; returns what the bar
// should offer. No DOM, no globals, so the rules above can be asserted
// directly instead of inferred from rendered HTML.
//
//   ctx: { scanning, returned, total, loadErrorCount }
function hygieneDecisionActions(decision, ctx) {
  const c = ctx || {};
  const F = window.VanishFindings;
  const d = decision || null;
  const never = HYGIENE_NEVER;

  // A decision from a partial run is not a decision. This outranks every other
  // rule here, including a perfectly good has-work state built from three of
  // thirteen checks.
  if (c.scanning) {
    const seen = Number(c.returned) || 0;
    const all = Number(c.total) || 0;
    const why = 'The checks are still running. A recommendation from a partial run is not a recommendation.';
    return {
      phase: 'scanning',
      headline: all > 0 ? `Checking: ${seen} of ${all} back` : 'Checking',
      sub: 'No action is offered until every check has returned.',
      primary: hygieneAct('wait', 'Checks are running', false, why),
      secondary: [
        hygieneAct('copy', 'Copy report', false, why),
        hygieneAct('open-clean', 'Open System Clean', false, why)
      ],
      caveat: '',
      never: never
    };
  }

  if (!d || d.state === F.UI_FAILED) {
    const nothingYet = 'Nothing has been scanned, so there is nothing to act on yet.';
    return {
      phase: d ? 'failed' : 'not-run',
      headline: d ? 'The checks did not run' : 'Nothing scanned yet',
      sub: d
        ? 'Treat this screen as blank. It is not a result.'
        : 'These checks read your profile and take a while, so they run when you ask.',
      primary: hygieneAct('run', 'Run the checks', true, '', 'go'),
      secondary: [
        hygieneAct('copy', 'Copy report', false, nothingYet),
        hygieneAct('open-clean', 'Open System Clean', false, nothingYet)
      ],
      caveat: '',
      never: never
    };
  }

  const counts = hygieneCostCounts(d.findings);
  const reclaimBytes = hygieneModuleBytes(d.findings, 'reclaim');
  const blind = Number(d.unreadableCount) || 0;
  // The reason a byte total cannot be acted on, reused verbatim wherever a
  // control is disabled for it, so the operator meets one explanation.
  const floorWhy =
    `${blind} location${blind === 1 ? '' : 's'} could not be read, so the total is a floor and not a total. ` +
    'Vanish will not offer an action computed from it.';

  if (d.state === F.UI_NOTHING_FOUND) {
    return {
      phase: 'nothing-found',
      headline: 'Nothing to decide',
      sub: `${d.examinedCount} location${d.examinedCount === 1 ? '' : 's'} checked, every one readable. This is the only state here that means clean.`,
      primary: hygieneAct('none', 'No action needed', false, 'There is nothing to act on. That is the finding.'),
      secondary: [
        hygieneAct('copy', 'Copy report', true, ''),
        hygieneAct('run', 'Run again', true, '')
      ],
      caveat: '',
      never: never
    };
  }

  if (d.state === F.UI_INCOMPLETE) {
    return {
      phase: 'incomplete',
      headline: 'No decision available',
      sub:
        `Nothing was found in the ${d.examinedCount} location${d.examinedCount === 1 ? '' : 's'} that could be read, ` +
        `and ${blind} could not be read at all. That is not "clean", and no action will be offered from it.`,
      primary: hygieneAct('run', 'Run again', true, '', 'go'),
      secondary: [
        hygieneAct('copy', 'Copy report', true, ''),
        hygieneAct('open-clean', 'Open System Clean', false, floorWhy)
      ],
      caveat: 'Running elevated lets the checks read locations that were refused this time.',
      never: never
    };
  }

  // has-work. The one branch where a recommendation exists, and the one place
  // the cost-before-size rule actually bites.
  //
  // The order below is the whole point. Irreplaceable first, ALWAYS, even when
  // it is one file and the reclaim column says fourteen gigabytes. Then
  // expensive. Only when nothing on the machine is hard to get back does the
  // bar mention bytes at all.
  let primary;
  if (counts.irreplaceable > 0) {
    primary = hygieneAct(
      'go-rescue',
      `Look at ${counts.irreplaceable} irreplaceable item${counts.irreplaceable === 1 ? '' : 's'} first`,
      true,
      '',
      'rescue'
    );
  } else if (counts.unknown > 0) {
    // Unmeasured is not cheap. lib/findings.js sorts 'unknown' last for the
    // same reason, and it must not fall through to a bytes-led offer here.
    primary = hygieneAct(
      'go-unknown',
      `Look at ${counts.unknown} item${counts.unknown === 1 ? '' : 's'} of unmeasured cost first`,
      true,
      '',
      'rescue'
    );
  } else if (counts.expensive > 0) {
    primary = hygieneAct(
      'go-expensive',
      `Look at ${counts.expensive} expensive item${counts.expensive === 1 ? '' : 's'} first`,
      true,
      '',
      'warn'
    );
  } else {
    primary = hygieneAct(
      'go-all',
      `Review ${d.findingCount} finding${d.findingCount === 1 ? '' : 's'}`,
      true,
      '',
      'go'
    );
  }

  // System Clean is the only screen that can act on any of this, and it is
  // offered ONLY when the evidence is complete and there is something
  // regenerable to act on. Both conditions get their own refusal text: a
  // control that is off for two different reasons and says one of them is a
  // control that lies.
  let cleanAct;
  if (reclaimBytes <= 0) {
    cleanAct = hygieneAct('open-clean', 'Open System Clean', false,
      'Nothing regenerable was found, so there is nothing for System Clean to do.');
  } else if (blind > 0) {
    cleanAct = hygieneAct('open-clean', 'Open System Clean', false, floorWhy);
  } else {
    cleanAct = hygieneAct('open-clean', `Open System Clean (${hygieneBytes(reclaimBytes) || 'regenerable'})`, true, '');
  }

  return {
    phase: 'has-work',
    // NOT the finding count. The verdict block directly below already says
    // '8 things worth your attention', and a bar that repeated it word for
    // word would be spending its only headline restating what is already on
    // screen. This line says what ORDER to work in; the verdict says how
    // many. Seen side by side in a real screenshot, the duplication was the
    // most obvious thing wrong with the first version.
    headline:
      counts.irreplaceable > 0
        ? 'Start with what you cannot get back'
        : counts.unknown > 0
          ? 'Start with what has not been measured'
          : counts.expensive > 0
            ? 'Start with what is expensive to rebuild'
            : 'Nothing here is hard to replace',
    sub:
      counts.irreplaceable > 0
        ? 'Ranked by what it would cost to get back, not by size. The top of the list is the part you cannot rebuild.'
        : 'Ranked by what it would cost to get back, not by size.',
    primary: primary,
    secondary: [hygieneAct('copy', 'Copy report', true, ''), cleanAct],
    caveat: blind > 0 ? floorWhy : '',
    never: never
  };
}

function renderHygieneDecisionBar(model) {
  const el = document.getElementById('hygiene-decisionbar');
  if (!el || !model) return;

  // A disabled control keeps its reason ON THE PAGE, not only in a title
  // attribute. A tooltip is not an explanation for someone who never hovers,
  // and "refuse by name, with a reason" is the whole tier model.
  const btn = (a, kind) => {
    if (!a) return '';
    const cls = `hygiene-act ${kind}${a.tone ? ` tone-${hygieneEsc(a.tone)}` : ''}${a.enabled ? '' : ' is-off'}`;
    return `
      <button type="button" class="${cls}" data-act="${hygieneEsc(a.id)}"
              ${a.enabled ? '' : 'disabled aria-disabled="true"'}
              ${a.why ? `title="${hygieneEsc(a.why)}"` : ''}>
        ${hygieneEsc(a.label)}
      </button>`;
  };

  const offReasons = []
    .concat(model.primary && !model.primary.enabled && model.primary.why ? [model.primary.why] : [])
    .concat((model.secondary || []).filter((a) => !a.enabled && a.why).map((a) => a.why));
  const uniqueReasons = offReasons.filter((r, i) => offReasons.indexOf(r) === i);

  el.innerHTML = `
    <div class="hygiene-decisionbar phase-${hygieneEsc(model.phase)}">
      <div class="hygiene-decision-text">
        <div class="hygiene-decision-headline">${hygieneEsc(model.headline)}</div>
        <div class="hygiene-decision-sub">${hygieneEsc(model.sub)}</div>
      </div>
      <div class="hygiene-decision-acts">
        ${btn(model.primary, 'primary')}
        ${(model.secondary || []).map((a) => btn(a, 'secondary')).join('')}
      </div>
    </div>
    ${model.caveat ? `<div class="hygiene-decision-caveat">${hygieneEsc(model.caveat)}</div>` : ''}
    ${
      uniqueReasons.length > 0
        ? `<div class="hygiene-decision-off">${uniqueReasons.map((r) => `<div>${hygieneEsc(r)}</div>`).join('')}</div>`
        : ''
    }
    <div class="hygiene-decision-never">${hygieneEsc(model.never)}</div>
  `;
}

// Scroll to the first finding of a given cost class and mark it, rather than
// filtering the list. Filtering would hide the ranking, and the ranking is the
// argument this screen is making.
function hygieneFocusCost(costClass) {
  const host = document.getElementById('hygiene-modules');
  if (!host) return false;
  host.querySelectorAll('.hygiene-finding.is-focused').forEach((n) => n.classList.remove('is-focused'));
  const target = costClass
    ? host.querySelector(`.hygiene-finding.cost-${costClass}`)
    : host.querySelector('.hygiene-finding');
  if (!target) return false;
  target.classList.add('is-focused');
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return true;
}

function hygieneReportText() {
  const d = hygieneDecision;
  const lines = [];
  lines.push('Vanish -- Machine Hygiene');
  if (!d) {
    lines.push('No scan has been run.');
    return lines.join('\n');
  }
  lines.push(`State: ${d.state}`);
  lines.push(`${d.findingCount} finding(s), ${d.examinedCount} location(s) examined, ${d.unreadableCount} unreadable`);
  if (d.unreadableCount > 0) {
    lines.push('Byte totals below are a floor, not a total: some locations could not be read.');
  }
  lines.push('');
  for (const f of d.findings) {
    lines.push(`[${String(f.costClass || 'unknown')}] ${f.title || ''}`);
    if (f.path) lines.push(`    ${f.path}`);
  }
  if (d.unreadable.length > 0) {
    lines.push('');
    lines.push('Could not read:');
    for (const u of d.unreadable) lines.push(`    ${u.path || ''} (${u.reason || 'unknown'})`);
  }
  return lines.join('\n');
}

// One delegated listener on the container, wired once. The bar re-renders on
// every state change, so per-button listeners would be re-attached each time
// and a stale one would fire twice.
function wireHygieneDecisionBar() {
  const el = document.getElementById('hygiene-decisionbar');
  if (!el || el.dataset.wired === '1') return;
  el.dataset.wired = '1';
  el.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (!b || b.disabled) return;
    const act = b.getAttribute('data-act');
    if (act === 'run') {
      const scan = document.getElementById('btn-hygiene-scan');
      if (scan && !scan.disabled) scan.click();
      return;
    }
    if (act === 'open-clean') {
      if (typeof window.switchTab === 'function') window.switchTab('system-clean');
      return;
    }
    if (act === 'copy') {
      const text = hygieneReportText();
      const done = (ok) => {
        b.textContent = ok ? 'Copied' : 'Could not copy';
        setTimeout(() => { b.textContent = 'Copy report'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      } else {
        done(false);
      }
      return;
    }
    if (act === 'go-rescue') { hygieneFocusCost('irreplaceable'); return; }
    if (act === 'go-unknown') { hygieneFocusCost('unknown'); return; }
    if (act === 'go-expensive') { hygieneFocusCost('expensive'); return; }
    if (act === 'go-all') { hygieneFocusCost(''); return; }
  });
}

// Called from every place the verdict or the progress view is drawn, so the
// bar can never describe a state the panel below has moved on from.
function refreshHygieneDecisionBar(decision) {
  const total = hygieneFinders.length;
  const returned = Object.keys(hygieneStatus).filter(
    (k) => hygieneStatus[k] === 'done' || hygieneStatus[k] === 'error'
  ).length;
  renderHygieneDecisionBar(
    hygieneDecisionActions(decision === undefined ? hygieneDecision : decision, {
      scanning: hygieneScanning,
      returned: returned,
      total: total,
      loadErrorCount: hygieneLoadErrors.length
    })
  );
}

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
      <div class="hygiene-module ${found.length > 0 ? 'has-findings' : ''}" id="hygiene-mod-${hygieneEsc(mod.key)}">
        <div class="hygiene-module-head">
          <i class="fa-solid ${mod.icon}"></i>
          <span class="hygiene-module-title">${hygieneEsc(mod.title)}</span>
          <span class="hygiene-module-summary">${hygieneEsc(summary)}</span>
        </div>
        <div class="hygiene-module-lede">${hygieneEsc(mod.lede)}</div>
        ${found.length > 0 ? found.slice(0, HYGIENE_RENDER_CAP).map(renderHygieneFinding).join('') : ''}
        ${
          found.length > HYGIENE_RENDER_CAP
            ? `<div class="hygiene-render-cap">
                 Showing the first ${HYGIENE_RENDER_CAP} of ${found.length}. They are the first
                 ${HYGIENE_RENDER_CAP} for a reason -- everything here is ranked by what it would cost
                 to get back, so the ones you cannot rebuild are at the top and the ones a command
                 regenerates are at the bottom. The count above is the real total; nothing was
                 discarded, only left off this list.
               </div>`
            : ''
        }
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
