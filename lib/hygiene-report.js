// z22: Module 4 REPORT -- one artifact per run.
//
// HANDOFF-2026-08-21 section 3: "You can reclaim X GB. Here is the
// breakdown, the rebuild cost of each, and the N things that are WRONG BUT
// FREE." That last clause is the whole point. Every cleaner on the market
// ends its summary screen with a total. "Wrong but free" is Module 2's
// output -- unset GRADLE_USER_HOME/ANDROID_HOME/npm_config_cache/
// PIP_CACHE_DIR (all four, found unset on the real machine, which alone
// explained most of the C: bulk), 12 verbatim duplicate PATH entries, 10
// repos returning 'dubious ownership' -- and reclaims zero bytes while being
// worth more than any of the bytes below it. A report that ranks by size
// buries every one of these under a 23 GB node_modules folder, so this
// module gives it a first-class section with its own count instead.
//
// This is a PURE module: no fs writes, no Electron, no IPC. It consumes
// lib/findings.js's decide() (the seam this issue was built on top of) and
// turns the result into a report object, plus a text renderer for it. It
// does not recompute anything decide() already computed correctly -- see
// the three rules below, each one lifted from an existing module rather
// than re-derived:
//
//   1. Completeness: findings.UI_INCOMPLETE / unreadableCount. A report that
//      says "40 GB reclaimable" while 11 trees were unreadable is a claim it
//      cannot support, so incompleteness is stated in the HEADLINE.
//   2. Ranking: findings.rankFindings. Module 1 rule 2 -- "npm install, ~2
//      min" beats "re-download 12.9 GB" -- THAT decides, never bytes. This
//      module does not add a size sort anywhere, including inside sections.
//   3. Trust: findings.decide's disagreements array. normaliseResult
//      recomputes each finder's state from its own evidence and records any
//      conflict with what the finder claimed. A non-empty array means the
//      PIPELINE is suspect, not just one finding, so it is rendered as a
//      banner, not a line item.

'use strict';

const findings = require('./findings');

// Module keys a finding is expected to declare (see HANDOFF-2026-08-21
// section 3: rescue / hygiene / reclaim, in build order). Anything else
// (a finder that predates this module, or a bare unit-test fixture with no
// module set) lands in 'other' rather than being dropped -- a silently
// dropped finding is worse than one filed somewhere unexpected.
// xr7j: derived from findings.js rather than written out again. This list
// used to be a third copy of an order that also lives in the ranker and in
// renderer/hygiene.js, and the ranker now sorts by it -- so a copy that drifted
// would put the report and the panel into different orders while both looked
// correct on their own. 'other' is appended rather than listed because it is
// the fallback bucket, not a module anyone registers a finder into.
const MODULE_KEYS = findings.MODULE_KEYS.filter((k) => k !== 'other');
const ALL_SECTION_KEYS = MODULE_KEYS.concat(['other']);

// --------------------------------------------------------------------
// formatBytes
// --------------------------------------------------------------------
// UNITS ARE BINARY (1024), NOT DECIMAL (1000), labelled KB/MB/GB rather than
// KiB/MiB/GiB. Two reasons, not one taste call:
//
//   1. Every number in HANDOFF-2026-08-21 ("23 GB in one repo, 614 MB after
//      reinstall", "570 MB" pip cache) was produced by scanner.ps1 dividing
//      by PowerShell's 1GB/1MB constants, which are binary (1GB = 1073741824).
//      Decimal division would print numbers that do not match the source
//      evidence this report exists to reproduce.
//   2. Windows Explorer's own Properties dialog reports sizes the same way --
//      binary math under a decimal-looking label. Matching it is the whole
//      point of the warning in this issue: "a report that is ambiguous about
//      whether GB means 10^9 or 2^30 is a report the operator cannot check
//      against Explorer." This one is checkable against Explorer by design.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function formatBytes(n) {
  const bytes = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (bytes === 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Whole bytes/KB stay whole numbers; MB and up get up to 2 decimals, with
  // trailing zeros trimmed so an exact "23 GB" prints as "23 GB", not
  // "23.00 GB" -- the evidence in the handoff is round numbers and the report
  // should read the same way when the underlying bytes are exact.
  const decimals = unit === 0 ? 0 : 2;
  let out = value.toFixed(decimals);
  if (decimals > 0 && out.indexOf('.') !== -1) {
    out = out.replace(/0+$/, '').replace(/\.$/, '');
  }
  return `${out} ${BYTE_UNITS[unit]}`;
}

function plural(n) {
  return n === 1 ? '' : 's';
}

// A decide()d result carries fields no raw finder result or array of them
// ever would -- 'disagreements' and 'canAdvance' both only exist after
// findings.decide() has run. Checked on both because either alone could
// collide with a hand-built fixture.
function isDecided(x) {
  return (
    x !== null &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    Array.isArray(x.disagreements) &&
    Array.isArray(x.results) &&
    typeof x.state === 'string' &&
    typeof x.canAdvance === 'boolean'
  );
}

// Group the already-ranked finding list by module, WITHOUT re-sorting.
// decided.findings came out of findings.rankFindings already; Array#sort is
// stable, so slicing that array by module preserves the exact relative order
// rankFindings gave it. Sorting again here would be redundant at best and a
// second place for a size-sort regression to creep in at worst.
function groupByModule(rankedFindings) {
  const sections = { rescue: [], hygiene: [], reclaim: [], other: [] };
  for (const f of rankedFindings) {
    const key = MODULE_KEYS.indexOf(f.module) !== -1 ? f.module : 'other';
    sections[key].push(f);
  }
  return sections;
}

// The headline. This is the one sentence HANDOFF-2026-08-21 quotes verbatim
// as the product: "You can reclaim X GB ... and the N things that are wrong
// but free" -- plus the two clauses that quote is missing and this issue's
// task adds explicitly: the reclaim number must say when it is a floor
// (aeu, at the report layer) rather than a total, and it must say so in the
// headline, not a footer.
function headlineFor(decided, wrongButFreeCount) {
  const bytesStr = formatBytes(decided.totalBytes);
  const uCount = decided.unreadableCount;

  switch (decided.state) {
    case findings.UI_FAILED:
      // decide() already worded this correctly for the "nothing ran at all"
      // case and there is no module-4-specific improvement to make on it --
      // reused rather than re-derived, same reasoning as rankFindings above.
      return decided.headline;

    case findings.UI_NOTHING_FOUND:
      // Trustworthy AND empty. Deliberately free of words that read as an
      // error ("failed", "error", "could not", "wrong") -- a clean machine
      // is good news and the headline must read like it, per this issue's
      // assertion 1.
      return (
        `Nothing to reclaim. ${decided.examinedCount} location${plural(decided.examinedCount)} ` +
        `checked, all of them readable, and none of them flagged.`
      );

    case findings.UI_INCOMPLETE:
      // Zero findings, but something was unreadable -- aeu's regression,
      // at the report layer. "0" here must never read as "clean"; it reads
      // as a floor.
      return (
        `${bytesStr} found reclaimable in the ${decided.examinedCount} ` +
        `location${plural(decided.examinedCount)} that could be read, and ${uCount} ` +
        `location${plural(uCount)} could not be read - so this number is a floor, ` +
        `not a total. There may be more.`
      );

    case findings.UI_HAS_WORK:
    default: {
      let headline;
      if (uCount > 0) {
        // Exact shape this issue's assertion 1 asks for: the incompleteness
        // claim in the HEADLINE, not a footer -- "40 GB found, and 11
        // locations could not be read - there may be more."
        headline = (
          `${bytesStr} found, and ${uCount} location${plural(uCount)} could not ` +
          `be read - there may be more.`
        );
      } else {
        headline = `You can reclaim ${bytesStr}.`;
      }
      if (wrongButFreeCount > 0) {
        headline += ` ${wrongButFreeCount} thing${plural(wrongButFreeCount)} found wrong but free.`;
      }
      return headline;
    }
  }
}

// Build the report object from either raw finder results (an array, or
// anything findings.decide() itself accepts) or an already-decided result.
// Accepting both means a caller that already called decide() for its own
// purposes (the UI, most likely) does not have to run the pipeline twice.
function buildReport(results) {
  const decided = isDecided(results) ? results : findings.decide(results);

  // module === 'hygiene' IS the definition of "wrong but free" here, not a
  // side effect of checking bytes === 0. HANDOFF-2026-08-21 section 3 names
  // Module 2 (hygiene) as the source of these findings directly: "Wrong but
  // free is Module 2's output." A hygiene finding that somehow carried bytes
  // would still belong in this section: it is what FOUND it, not what it
  // reclaims, that makes it wrong-but-free.
  const wrongButFreeItems = decided.findings.filter((f) => f.module === 'hygiene');

  const sections = groupByModule(decided.findings);

  return {
    headline: headlineFor(decided, wrongButFreeItems.length),
    state: decided.state,
    trustworthy: decided.trustworthy,
    reclaimableBytes: decided.totalBytes,
    sections,
    wrongButFree: { count: wrongButFreeItems.length, items: wrongButFreeItems },
    unreadable: { count: decided.unreadableCount, items: decided.unreadable },
    disagreements: decided.disagreements,
    examinedCount: decided.examinedCount,
    findingCount: decided.findingCount,
    generatedAt: new Date().toISOString()
  };
}

function renderItem(f) {
  const cost = f.rebuildCost ? f.rebuildCost : '(rebuild cost not stated)';
  const bytesPart = f.bytes ? formatBytes(f.bytes) : '0 B';
  const lines = [`  - ${f.title || f.id || '(untitled finding)'}  [${bytesPart}, ${f.costClass || 'unknown'}]`];
  lines.push(`      rebuild cost: ${cost}`);
  if (f.evidence) lines.push(`      evidence: ${f.evidence}`);
  if (f.path) lines.push(`      path: ${f.path}`);
  return lines.join('\n');
}

const SECTION_TITLES = {
  rescue: 'RESCUE (Module 3 -- audit only, nothing here is ever deleted by this report)',
  hygiene: 'HYGIENE (Module 2 -- wrong, not wasteful; reclaims 0 bytes and matters anyway)',
  reclaim: 'RECLAIM (Module 1 -- ranked by rebuild cost, never by size)',
  other: 'OTHER (no module declared)'
};

// Plain text render. ASCII ONLY -- this repo's console is Windows
// PowerShell 5.1, where anything outside ASCII (em dashes, smart quotes,
// unicode bullets) prints as mojibake rather than the intended character.
// '-' stands in for every dash and '*'/'=' for every rule and bullet.
function renderText(report) {
  const lines = [];

  lines.push('=================================================');
  lines.push('VANISH -- MACHINE HYGIENE REPORT');
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('=================================================');
  lines.push('');

  // Disagreements first and loud. A non-empty array means the PIPELINE is
  // suspect -- a finder's own evidence contradicts the state it claimed --
  // and that is a different, worse class of problem than any single
  // finding, so it renders above the headline, not folded into a section.
  if (report.disagreements.length > 0) {
    lines.push('!! PIPELINE DISAGREEMENT -- DO NOT TRUST THIS REPORT AS-IS !!');
    lines.push(
      `${report.disagreements.length} finder${plural(report.disagreements.length)} reported a state ` +
      `that its own evidence does not support:`
    );
    for (const d of report.disagreements) {
      lines.push(`  - ${d.finder}: claimed '${d.claimed}', evidence says '${d.computed}'`);
    }
    lines.push('');
  }

  lines.push(report.headline);
  if (!report.trustworthy) {
    lines.push('(This run is INCOMPLETE. Treat every number above as a floor, not a total.)');
  }
  lines.push('');

  // Wrong-but-free is first-class: its own section with its own count,
  // ahead of the reclaim breakdown, exactly per this issue's instruction not
  // to bury it under a byte total.
  lines.push(`WRONG BUT FREE -- ${report.wrongButFree.count} thing${plural(report.wrongButFree.count)} (reclaims 0 bytes, worth fixing anyway)`);
  lines.push('-------------------------------------------------');
  if (report.wrongButFree.count === 0) {
    lines.push('  (none)');
  } else {
    for (const f of report.wrongButFree.items) lines.push(renderItem(f));
  }
  lines.push('');

  // The breakdown, by module, in rebuild-cost order within each module.
  for (const key of ALL_SECTION_KEYS) {
    if (key === 'hygiene') continue; // already shown above as wrong-but-free
    const items = report.sections[key] || [];
    if (items.length === 0) continue;
    lines.push(SECTION_TITLES[key] || key.toUpperCase());
    lines.push('-------------------------------------------------');
    for (const f of items) lines.push(renderItem(f));
    lines.push('');
  }

  lines.push(`UNREADABLE -- ${report.unreadable.count} location${plural(report.unreadable.count)} could not be looked at`);
  lines.push('-------------------------------------------------');
  if (report.unreadable.count === 0) {
    lines.push('  (none)');
  } else {
    for (const u of report.unreadable.items) {
      lines.push(`  - ${u.path || '(no path)'}: ${u.reason || 'no reason given'}${u.detail ? ' -- ' + u.detail : ''}`);
    }
  }
  lines.push('');

  lines.push(`Examined ${report.examinedCount} location${plural(report.examinedCount)}; ${report.findingCount} finding${plural(report.findingCount)}; reclaimable total ${formatBytes(report.reclaimableBytes)}.`);

  return lines.join('\n');
}

module.exports = {
  buildReport,
  renderText,
  formatBytes
};
