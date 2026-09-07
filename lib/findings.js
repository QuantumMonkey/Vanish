// The seam, Node side: finder results in, decided UI state out (5p5 + aeu).
//
// docs/history/HANDOFF-2026-08-21.md measured this codebase and answered "is
// Vanish too bloated" with no - ~19,310 production lines behind a 15,078-line
// suite is healthy. The one structural problem it did find is that scanner.ps1
// is 7,870 lines, and when scan, classify, decide and report share one scope,
// A ZERO-RESULT CASE HAS NO DISTINCT TYPE. Callers cannot branch on it, so the
// UI guesses. D-1 - "Move to quarantine" acting as a Next button on a screen
// with nothing to advance to - is that guess.
//
// So the fix is not a guard in the click handler. It is this module: the
// zero-finding case arrives here as a NAMED TERMINAL STATE, and the wizard
// asks the state whether advancing is meaningful instead of assuming that a
// completed action implies a next step. A named state cannot be forgotten the
// way an if-statement can.

// The three answers a finder may give. finders/_contract.ps1 computes these
// from the evidence rather than letting a finder assert one; this side does
// not trust that, and recomputes - see normaliseResult.
const FOUND = 'found';
const NOTHING = 'nothing';
const COULD_NOT_LOOK = 'could-not-look';
const FINDER_STATES = [FOUND, NOTHING, COULD_NOT_LOOK];

// What the UI renders. Two of the four are TERMINAL: they are the end of the
// flow, not a step that happens to be empty, and the difference is the whole
// of D-1.
const UI_HAS_WORK = 'has-work';         // findings to act on; the only advancing state
const UI_NOTHING_FOUND = 'nothing-found';   // terminal, and trustworthy
const UI_INCOMPLETE = 'incomplete';     // terminal, and NOT trustworthy
const UI_FAILED = 'failed';             // terminal; the scan itself did not run

// Rebuild cost vocabulary. HANDOFF-2026-08-21 Module 1 rule 2: "npm install,
// ~2 min" versus "re-download 12.9 GB" - THAT NUMBER DECIDES, NOT THE SIZE. A
// 23 GB node_modules that rebuilds in two minutes and a 12 GB VM image that
// took a day to configure are not the same offer. Ranking by bytes gets it
// exactly backwards, so bytes are a tiebreak here and never the sort key.
//
// xr7j: THE SAME NUMBER ANSWERS TWO OPPOSITE QUESTIONS, and until 2026-09-02
// one order served both.
//
//   reclaim  asks "what is safe to remove"   -> cheapest to rebuild first
//   rescue   asks "what would I lose"        -> impossible to rebuild first
//
// One order cannot be right for both, and the one that shipped was the reclaim
// order applied to every module. In the rescue module - whose stated job is
// "what a delete would destroy" - that put the safest findings at the top. On
// the development machine that meant 4,040 cheap duplicate-content findings
// ranked above everything, against a 100-row render cap, in the same module as
// local-only-credentials.
//
// The on-screen caption said the opposite in as many words: "the ones you
// cannot rebuild are at the top and the ones a command regenerates are at the
// bottom". Whoever wrote it was describing the rescue reading while the code
// did the reclaim one. That is why costOrderCaption() below is DERIVED from
// the array rather than written next to it - a sentence a human keeps in sync
// with a sort is a sentence that eventually stops being true.
const COST_ORDER = ['cheap', 'moderate', 'expensive', 'irreplaceable', 'unknown'];

// 'unknown' sorts last deliberately. An unmeasured cost is not a cheap one,
// and a ranker that treated it as zero would put the most dangerous offers at
// the top of the list.
const COST_ORDER_SAFEST_FIRST = COST_ORDER;

// Not the reverse of the above, and the difference is the whole point.
// 'unknown' is SECOND, not last: a rebuild cost nobody measured might well be
// irreplaceable, and burying it under things known to be cheap would be the
// same mistake in the other direction. Both orders put the unmeasured case
// where it does the least harm to be wrong about.
const COST_ORDER_LOSS_FIRST = ['irreplaceable', 'unknown', 'expensive', 'moderate', 'cheap'];

// The canonical module list, and now the ranker sorts by it. hygiene-report.js
// derives its own list from this one. renderer/hygiene.js cannot -- HYGIENE_MODULES
// carries the on-screen title, icon and lede for each block, so its ORDER is the
// thing that has to agree, and test/hygiene-report-verify.js asserts that rather
// than hoping. Three copies of one order is three chances for the report, the
// panel and the ranker to disagree about what "first" means.
const MODULE_KEYS = ['rescue', 'hygiene', 'reclaim', 'other'];

const MODULE_COST_ORDER = {
  rescue: COST_ORDER_LOSS_FIRST,
  hygiene: COST_ORDER_SAFEST_FIRST,
  reclaim: COST_ORDER_SAFEST_FIRST,
  other: COST_ORDER_SAFEST_FIRST
};

function moduleKey(value) {
  const k = String(value || 'other');
  return MODULE_KEYS.indexOf(k) === -1 ? 'other' : k;
}

function moduleRank(value) {
  return MODULE_KEYS.indexOf(moduleKey(value));
}

function costOrderFor(module) {
  return MODULE_COST_ORDER[moduleKey(module)] || COST_ORDER_SAFEST_FIRST;
}

function costRankIn(order, costClass) {
  const i = order.indexOf(String(costClass || 'unknown'));
  return i === -1 ? order.length : i;
}

// Kept for callers that ask the general question. This is the RECLAIM
// direction, which is what it always was.
function costRank(costClass) {
  return costRankIn(COST_ORDER_SAFEST_FIRST, costClass);
}

// The sentence that describes the sort, generated FROM the sort. This is the
// fix for the half of xr7j that was a lie rather than a defect: the caption
// and the comparator can no longer disagree, because there is only one of them.
function costOrderCaption(module) {
  return costOrderFor(module)[0] === 'irreplaceable'
    ? 'the ones you cannot rebuild are at the top and the ones a command regenerates are at the bottom'
    : 'the ones a command regenerates are at the top and the ones you cannot rebuild are at the bottom';
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

// Normalise one finder result off the wire and RECOMPUTE its state.
//
// The engine already computes state correctly. This recomputes it anyway,
// because the two claims "there are no findings" and "state is nothing" travel
// in the same JSON document and nothing but this function ever compares them.
// If they ever disagree - a hand-built payload, a partial write, a future
// finder that returns a literal - the evidence wins over the label, and the
// disagreement is reported rather than silently resolved.
function normaliseResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const findings = asArray(r.findings).filter(Boolean);
  const unreadable = asArray(r.unreadable).filter(Boolean);

  let state;
  if (findings.length > 0) state = FOUND;
  else if (unreadable.length === 0) state = NOTHING;
  else state = COULD_NOT_LOOK;

  const claimed = typeof r.state === 'string' ? r.state : null;

  return {
    finder: String(r.finder || 'unknown'),
    title: String(r.title || r.finder || 'Scan'),
    module: r.module ? String(r.module) : null,
    state,
    claimedState: claimed,
    stateDisagreement: claimed !== null && claimed !== state ? { claimed, computed: state } : null,
    complete: unreadable.length === 0,
    findings,
    findingCount: findings.length,
    unreadable,
    unreadableCount: unreadable.length,
    examinedCount: Number.isFinite(r.examinedCount) ? r.examinedCount : 0,
    totalBytes: Number.isFinite(r.totalBytes) ? r.totalBytes : 0,
    note: r.note ? String(r.note) : ''
  };
}

// The decider. Consumes typed results, applies policy, and returns a UI state.
//
// Policy, in one place, in this order:
//   - nothing looked at all              -> failed
//   - findings exist                     -> has-work (partial if anything blind)
//   - no findings and nothing blind      -> nothing-found      TERMINAL, trusted
//   - no findings but something blind    -> incomplete         TERMINAL, untrusted
//
// The last line is aeu's binding rule expressed as a branch: "could not look
// must NEVER reach a decider as empty". Here it cannot, because it does not
// share a state with empty.
function decide(results) {
  const list = asArray(results).map(normaliseResult);

  const findings = [];
  const unreadable = [];
  let examined = 0;
  let bytes = 0;

  for (const r of list) {
    for (const f of r.findings) findings.push(Object.assign({ finder: r.finder, module: r.module }, f));
    for (const u of r.unreadable) unreadable.push(Object.assign({ finder: r.finder }, u));
    examined += r.examinedCount;
    bytes += r.totalBytes;
  }

  let state;
  if (list.length === 0) {
    state = UI_FAILED;
  } else if (findings.length > 0) {
    state = UI_HAS_WORK;
  } else if (unreadable.length === 0) {
    state = UI_NOTHING_FOUND;
  } else {
    state = UI_INCOMPLETE;
  }

  const blindSpots = summariseBlindSpots(unreadable);

  return {
    state,
    terminal: isTerminal(state),
    canAdvance: canAdvance(state),
    trustworthy: state === UI_NOTHING_FOUND || (state === UI_HAS_WORK && unreadable.length === 0),
    results: list,
    findings: rankFindings(findings),
    unreadable,
    // Grouped by WHY, so the screen can name a cause instead of a number.
    blindSpots,
    findingCount: findings.length,
    unreadableCount: unreadable.length,
    examinedCount: examined,
    totalBytes: bytes,
    headline: headlineFor(state, findings.length, unreadable.length, examined, blindSpots),
    disagreements: list.filter((r) => r.stateDisagreement).map((r) => ({ finder: r.finder, ...r.stateDisagreement }))
  };
}

// Rank by what it costs to get back, then by size. Never by size alone.
function rankFindings(findings) {
  return findings.slice().sort((a, b) => {
    // Module first, so the comparator stays a valid total order. Two findings
    // in different modules are ranked by different cost directions, and
    // comparing them against each other directly would not be a consistent
    // ordering at all - Array#sort is entitled to misbehave when given one.
    // Cross-module order is never displayed anyway: every consumer groups by
    // module (renderer/hygiene.js and lib/hygiene-report.js both slice this
    // list rather than re-sorting it) and relies only on the order WITHIN a
    // group, which is exactly what the second key gives them.
    const m = moduleRank(a.module) - moduleRank(b.module);
    if (m !== 0) return m;

    const order = costOrderFor(a.module);
    const c = costRankIn(order, a.costClass) - costRankIn(order, b.costClass);
    if (c !== 0) return c;
    return (b.bytes || 0) - (a.bytes || 0);
  });
}

// A terminal state is the END of the flow. The wizard must not offer a step
// after one, and this is the predicate D-1's regression test asserts against -
// the STATE, not the button. A button is a rendering of this answer; asking
// the button whether the flow is over is how the bug happened.
function isTerminal(state) {
  return state === UI_NOTHING_FOUND || state === UI_INCOMPLETE || state === UI_FAILED;
}

function canAdvance(state) {
  return state === UI_HAS_WORK;
}

// The sentence the terminal state is named by. "Nothing found" and "could not
// finish looking" are different sentences because they license different next
// actions, and during the real cleanup a permission-denied restore-point query
// reported as "disabled" is exactly what happens when they share one.
// "could not be read" is a claim about ABILITY, and on an elevated machine it
// reads as "Windows refused me". Most of the time it is not true: the usual
// cause is Vanish's own directory budget. When the blind spots are entirely
// Vanish's own doing this says so in the active voice; otherwise it drops to
// "were not read", which is what actually happened and asserts nothing about
// why. The breakdown by cause is on the screen underneath.
function blindPhrase(blind, count) {
  if (blind && blind.allOurOwnDoing) {
    return `Vanish stopped looking in ${count} place${count === 1 ? '' : 's'}`;
  }
  return `${count} location${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} not read`;
}

function headlineFor(state, findingCount, unreadableCount, examinedCount, blind) {
  switch (state) {
    case UI_HAS_WORK:
      return unreadableCount > 0
        ? `${findingCount} found, but ${blindPhrase(blind, unreadableCount)} - there may be more.`
        : `${findingCount} found.`;
    case UI_NOTHING_FOUND:
      return `Nothing found. ${examinedCount} location${examinedCount === 1 ? '' : 's'} checked, all of them readable.`;
    case UI_INCOMPLETE:
      // Two sentences rather than one clause, because the blind phrase can
      // start with the product name and lowercasing it to fit a comma is not
      // an option.
      return `No findings in the ${examinedCount} location${examinedCount === 1 ? '' : 's'} that were read. ${blindPhrase(blind, unreadableCount)}. This is not the same as clean.`;
    case UI_FAILED:
      return 'The scan did not run, so it has established nothing about this machine.';
    default:
      return '';
  }
}

// D-1, at the place it was actually reported: the uninstall wizard's leftover
// screen. Takes what `scan-leftovers` returns and decides what screen the user
// is looking at.
//
// The distinction the old code could not make is the whole bug. "You found 12
// leftovers and ticked none" and "there were no leftovers to tick" both
// arrived at the same zero-checked branch, so the same control served both -
// and in the second case that control was a destructive-looking button doing
// navigation it does not name. Here they are different states, and only one of
// them has anything to quarantine.
//
// The third case did not exist at all before this: main.js caught a failed
// scan and returned `{ files: [], registry: [] }`, which the wizard rendered as
// "No leftovers found. This program removed itself cleanly." A scan that threw
// was reported to the user as a clean uninstall. That is aeu's defect class,
// in production, on the most-used path in the application.
function fromLeftovers(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const files = asArray(r.files).filter(Boolean);
  const registry = asArray(r.registry).filter(Boolean);

  const findings = files
    .map((f, i) => ({
      id: `file|${f.path || i}`,
      title: f.path || '',
      path: f.path || '',
      kind: 'file',
      bytes: Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0,
      risk: f.risk || 'Safe',
      evidence: f.type || '',
      costClass: 'unknown'
    }))
    .concat(
      registry.map((k, i) => ({
        id: `registry|${k.path || i}`,
        title: k.path || '',
        path: k.path || '',
        kind: 'registry',
        bytes: 0,
        risk: k.risk || 'Safe',
        evidence: k.type || '',
        costClass: 'unknown'
      }))
    );

  const unreadable = asArray(r.unreadable).filter(Boolean);
  if (r.success === false || r.error) {
    unreadable.push({
      path: '(leftover scan)',
      reason: 'scan-failed',
      detail: String(r.error || 'The leftover scan did not complete.')
    });
  }

  return decide([
    {
      finder: 'leftovers',
      title: 'Leftovers from the uninstall',
      module: 'rescue',
      findings,
      unreadable,
      examinedCount: Number.isFinite(r.examinedCount) ? r.examinedCount : findings.length,
      totalBytes: findings.reduce((sum, x) => sum + (x.bytes || 0), 0)
    }
  ]);
}

// qkgu: the same adapter, for System Clean's seven cleaners.
//
// They predate the contract entirely. Every branch of Invoke-CleanerScan wrote
// `success = $true` as a literal, and the panel's only test was
// `findings.length === 0` -> a green tick and "Nothing left behind here." So a
// sweep that was refused by an ACL on a single registry key, or one whose
// pnputil call never ran, rendered as a clean machine. Exactly fromLeftovers'
// defect, on the surface that has SEVEN of these instead of one.
//
// The engine now sends state/unreadable/complete. This does not trust that
// state: it hands the evidence back to decide() and lets it be recomputed, for
// the same reason New-FinderResult refuses a state parameter. If the two ever
// disagree, the disagreement is a bug in the engine and this is where it
// surfaces rather than where it is laundered.
function fromCleanerScan(raw, cleanerId, cleanerTitle) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = cleanerId || 'cleaner';

  const findings = asArray(r.findings)
    .filter((f) => f && typeof f === 'object')
    .map((f, i) => ({
      id: f.id || `${id}|${i}`,
      title: f.label || f.title || '',
      path: f.path || f.registryPath || '',
      kind: f.kind || 'registry',
      bytes: Number.isFinite(f.sizeBytes) ? f.sizeBytes : (Number.isFinite(f.bytes) ? f.bytes : 0),
      risk: f.risk || 'Advanced',
      evidence: f.evidence || '',
      costClass: 'unknown'
    }));

  const unreadable = asArray(r.unreadable)
    .filter((u) => u && typeof u === 'object')
    .map((u) => ({
      path: String(u.path || ''),
      reason: String(u.reason || 'unreadable'),
      detail: String(u.detail || '')
    }));

  // The cap that Add-BlindSpot enforces, said out loud rather than left to
  // make the list look shorter than the problem.
  // The count goes in `path`, not in `detail`, because `path` is the field the
  // list actually renders - caught by the UI suite, which showed this row
  // arriving on screen as "(more locations) (too-many-to-list)" with the
  // number nowhere. A fact that reaches the payload and not the screen is the
  // same defect this whole change is about, one layer along.
  const dropped = Number.isFinite(r.unreadableDropped) ? r.unreadableDropped : 0;
  if (dropped > 0) {
    unreadable.push({
      path: `${dropped} more location(s), not listed individually`,
      reason: 'engine-cap',
      detail: 'The engine caps the list it sends; these were counted rather than dropped silently.'
    });
  }

  if (r.success === false || r.error) {
    unreadable.push({
      path: `(${id} scan)`,
      reason: 'scan-failed',
      detail: String(r.error || 'The scan did not return a result.')
    });
  }

  return decide([
    {
      finder: id,
      title: cleanerTitle || id,
      module: 'hygiene',
      findings,
      unreadable,
      examinedCount: Number.isFinite(r.examinedCount) ? r.examinedCount : findings.length,
      totalBytes: findings.reduce((sum, x) => sum + (x.bytes || 0), 0)
    }
  ]);
}

// ---------------------------------------------------------------------------
// Why a location was not read (bd sf71)
// ---------------------------------------------------------------------------
//
// EVERY unreadable record already carries a reason and a written-out detail --
// New-Unreadable has demanded both since finders/_contract.ps1 was written, on
// the argument that "10 repos returned dubious ownership from a previous
// profile SID" is actionable and "10 errors" is not. The UI then collapsed all
// of it back into "N locations could not be read", which is the "10 errors"
// version, and on an elevated machine it reads as "Windows refused me" -- a
// claim about permissions that the data does not support.
//
// MEASURED, elevated, all 13 finders: 768 unreadable records, of which 700
// were `scan-capped` (Vanish's own 15000-directory budget), 50 `not-searched`
// (a junction pointing outside the search root, deliberately not followed), 12
// `no-upstream`, 4 `hash-failed` and 2 `git-error`. NONE was a permission
// failure. The screen was reporting Vanish's own decisions as the disk
// refusing, and offering elevation as the remedy.
//
// THE DEFAULT IS THE IMPORTANT PART. An unrecognised reason falls into
// 'unknown', which is worded as not-yet-explained rather than folded into
// whichever bucket happens to be nearby. Bucketing an unknown as a limit would
// invent reassurance; bucketing it as denied would invent a permission problem
// and re-create the bug in the other direction. Adding a reason code to a
// finder without adding it here is visible instead of silent.
const BLIND_CAUSES = {
  // Vanish stopped looking. Not a failure of access at all, and no token,
  // elevation or ownership change makes any difference to it.
  limit: {
    label: 'Vanish stopped looking here',
    permission: false,
    reasons: ['scan-capped', 'not-searched', 'never-touch']
  },
  // Windows said no. This is the ONLY cause for which elevation is relevant.
  denied: {
    label: 'Windows refused access',
    permission: true,
    reasons: [
      'access-denied', 'key-denied', 'value-denied', 'subkeys-denied',
      'hive-unreadable', 'hive-would-not-mount',
      'profile-hive-unreadable', 'profile-list-unreadable'
    ]
  },
  // Nothing was refused; there was nothing there, or no tool to ask with.
  absent: {
    label: 'Not present on this machine',
    permission: false,
    reasons: ['root-missing', 'git-not-found', 'cmdlet-unavailable', 'missing-profileimagepath']
  },
  // The thing exists and is readable in principle, but a question could not be
  // answered about it. A repo with no upstream is not an unreadable location --
  // it is a repo that cannot be compared to a remote, which is a different
  // sentence and, for the rescue module, close to being the point.
  unanswerable: {
    label: 'A question could not be answered',
    permission: false,
    reasons: [
      'no-upstream', 'git-error', 'git-status-failed', 'git-log-failed',
      'git-rev-list-failed', 'git-stash-failed', 'git-check-ignore-failed',
      // Deliberately NOT 'denied'. Git refuses a repository whose files are
      // owned by another SID, and elevation does not fix that -- the check
      // compares the owner to the CURRENT user, so running as administrator
      // changes the answer without granting anything, and the remedy is
      // `git config --global --add safe.directory`. Filing it under denied
      // would put a UAC prompt in front of a problem a UAC prompt cannot
      // solve, which is the bug this whole classification exists to end.
      'dubious-ownership',
      'size-unmeasurable', 'size-measure-failed', 'definition-unparsable'
    ]
  },
  // A read was attempted and failed for a reason that is not, on its face, a
  // permission problem -- most often a file held open by another process.
  failed: {
    label: 'A read failed',
    permission: false,
    reasons: [
      'hash-failed', 'registry-read-failed', 'query-failed', 'tool-failed',
      'path-check-failed', 'install-inventory-failed', 'finder-failed'
    ]
  }
};

const BLIND_CAUSE_BY_REASON = (() => {
  const map = {};
  for (const [cause, spec] of Object.entries(BLIND_CAUSES)) {
    for (const reason of spec.reasons) map[reason] = cause;
  }
  return map;
})();

function blindCauseOf(reason) {
  const key = typeof reason === 'string' ? reason.trim() : '';
  return BLIND_CAUSE_BY_REASON[key] || 'unknown';
}

// Group blind spots by cause, then by reason within a cause, keeping one real
// example of each so the screen can show the detail the finder already wrote
// rather than a number.
//
// `elevationWouldHelp` is deliberately narrow: it is true only when something
// was actually DENIED. It is not "we failed at something and elevation is
// generally powerful". Offering a UAC prompt as the cure for Vanish's own
// directory cap is worse than saying nothing, because the user pays for it and
// the number does not move.
function summariseBlindSpots(unreadable) {
  const list = asArray(unreadable).filter(Boolean);
  const causes = {};

  for (const u of list) {
    const cause = blindCauseOf(u && u.reason);
    const reason = (u && typeof u.reason === 'string' && u.reason.trim()) || '(none)';

    if (!causes[cause]) {
      causes[cause] = {
        cause,
        label: cause === 'unknown' ? 'Not yet explained' : BLIND_CAUSES[cause].label,
        permission: cause === 'unknown' ? false : BLIND_CAUSES[cause].permission,
        count: 0,
        reasons: {},
        finders: []
      };
    }

    const group = causes[cause];
    group.count++;
    if (!group.reasons[reason]) {
      group.reasons[reason] = {
        reason,
        count: 0,
        detail: (u && u.detail) ? String(u.detail) : '',
        examplePath: (u && u.path) ? String(u.path) : ''
      };
    }
    group.reasons[reason].count++;
    const finder = u && u.finder ? String(u.finder) : '';
    if (finder && !group.finders.includes(finder)) group.finders.push(finder);
  }

  const groups = Object.values(causes)
    .map((g) => Object.assign({}, g, {
      reasons: Object.values(g.reasons).sort((a, b) => b.count - a.count)
    }))
    .sort((a, b) => b.count - a.count);

  const deniedCount = groups
    .filter((g) => g.permission)
    .reduce((sum, g) => sum + g.count, 0);
  const unknownCount = groups
    .filter((g) => g.cause === 'unknown')
    .reduce((sum, g) => sum + g.count, 0);

  return {
    total: list.length,
    groups,
    deniedCount,
    unknownCount,
    // True when Vanish's own budget or policy is the whole story. This is what
    // lets the screen say "Vanish stopped early" instead of implying refusal.
    allOurOwnDoing: list.length > 0 && groups.every((g) => g.cause === 'limit'),
    elevationWouldHelp: deniedCount > 0
  };
}

// Named VanishFindingsApi and not `api`, which is not a style preference.
// preload.js calls contextBridge.exposeInMainWorld('api', ...), which defines
// a NON-CONFIGURABLE property on the page's global object. A top-level `const
// api` in a classic script is then a SyntaxError - "Identifier 'api' has
// already been declared" - and it takes the WHOLE FILE down at instantiation,
// so window.VanishFindings never gets defined and the wizard's screen has no
// state machine. It fails at load with nothing on screen to suggest why.
const VanishFindingsApi = {
  FOUND,
  NOTHING,
  COULD_NOT_LOOK,
  FINDER_STATES,
  UI_HAS_WORK,
  UI_NOTHING_FOUND,
  UI_INCOMPLETE,
  UI_FAILED,
  COST_ORDER,
  COST_ORDER_SAFEST_FIRST,
  COST_ORDER_LOSS_FIRST,
  MODULE_KEYS,
  moduleKey,
  moduleRank,
  costOrderFor,
  costRankIn,
  costOrderCaption,
  costRank,
  normaliseResult,
  decide,
  BLIND_CAUSES,
  blindCauseOf,
  summariseBlindSpots,
  fromLeftovers,
  fromCleanerScan,
  rankFindings,
  isTerminal,
  canAdvance,
  headlineFor
};

// Dual-mode, for the same reason lib/platforms.js is: the renderer needs to
// ask "what state is this screen in" and routing that through IPC would add a
// round trip to answer a question about data the renderer already holds. The
// alternative - a second copy of the state rules inside wizard.js - is exactly
// how the UI came to be guessing in the first place. One file, one set of
// rules, one test suite, loaded as a CommonJS module by the main process and
// as a classic script in the page.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VanishFindingsApi;
} else if (typeof window !== 'undefined') {
  window.VanishFindings = VanishFindingsApi;
}
