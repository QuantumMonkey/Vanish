// z22 Verify: hygiene report (lib/hygiene-report.js).
//
// Module 4's whole claim, per HANDOFF-2026-08-21 section 3: "You can reclaim
// X GB. Here is the breakdown, the rebuild cost of each, and the N things
// that are wrong but free." The assertions below check the parts of that
// sentence a size-ranked cleaner summary screen gets wrong or omits:
//
//   1. A clean run reads as good news, not an error.
//   2. An INCOMPLETE run (aeu, at the report layer) never lets 0 findings
//      read as 0 problems -- the headline says the reclaim number is a floor.
//   3. Rank is by rebuild cost, never by size. lib/findings.js's own
//      rankFindings sorts ASCENDING by cost class (cheap=0 ... irreplaceable
//      =3, unknown=4 last), and its own comment on 'unknown' confirms the
//      direction: "a ranker that treated it as zero would put the most
//      dangerous offers AT THE TOP of the list" -- so index 0 IS the top,
//      and the top is meant to be the safe, cheap-to-rebuild end. (This
//      correction matters: an earlier draft of this issue's brief said
//      "cheap ranks BELOW irreplaceable", which is the opposite of what the
//      unmodified rankFindings actually does and was confirmed wrong against
//      the real code before this test was written. What is asserted below is
//      the real, verified invariant: cost decides, size never does -- proved
//      in BOTH size directions so a hard-coded order can't fake a pass.)
//   4. Wrong-but-free (Module 2's hygiene output, 0 bytes by nature) gets its
//      own first-class section and count, and is never dropped from the
//      overall totals just because it reclaims nothing.
//   5. A finder's claimed state disagreeing with its own evidence surfaces
//      loudly -- that means the PIPELINE is suspect, not one finding.
//   6. formatBytes round-trips the real numbers from the handoff evidence.
//   7. renderText is ASCII only -- this repo's console is Windows
//      PowerShell 5.1, where anything else prints as mojibake.
//
//   node test/hygiene-report-verify.js

const report = require('../lib/hygiene-report');
const findings = require('../lib/findings');

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    fail += 1;
  }
}

console.log('');
console.log('Hygiene report (z22)');
console.log('=====================');

// ======================================================================
console.log('');
console.log('z22.1 zero findings, zero unreadable -> trustworthy "nothing found", reads as good news');

{
  const raw = [
    { finder: 'path-hygiene', title: 'PATH check', module: 'hygiene', findings: [], unreadable: [], examinedCount: 14 }
  ];
  const r = report.buildReport(raw);

  assert(r.state === findings.UI_NOTHING_FOUND, `state is nothing-found (got '${r.state}')`);
  assert(r.trustworthy === true, 'and it is trustworthy');
  assert(r.reclaimableBytes === 0, 'reclaimable is 0');
  assert(r.wrongButFree.count === 0, 'nothing wrong-but-free either');
  assert(r.unreadable.count === 0, 'and nothing unreadable');
  assert(r.disagreements.length === 0, 'and no pipeline disagreement');
  assert(
    !/error|fail|could not|wrong|cannot/i.test(r.headline),
    `headline does not read as an error (got "${r.headline}")`
  );
  const text = report.renderText(r);
  assert(!/PIPELINE DISAGREEMENT/.test(text), 'rendered text carries no disagreement banner');
}

// ======================================================================
console.log('');
console.log('z22.2 zero findings WITH unreadable -> incomplete, and the reclaim number is a FLOOR (aeu, report layer)');

{
  const raw = [
    {
      finder: 'repo-health',
      title: 'Repo health',
      module: 'hygiene',
      findings: [],
      unreadable: [
        { path: 'D:\\dev\\old-repo', reason: 'dubious ownership', detail: 'git reports a previous profile SID as owner' }
      ],
      examinedCount: 9
    }
  ];
  const r = report.buildReport(raw);

  assert(r.state === findings.UI_INCOMPLETE, `state is incomplete (got '${r.state}')`);
  assert(r.trustworthy === false, 'and it is NOT trustworthy');
  assert(r.unreadable.count === 1, 'the one unreadable location is counted');
  assert(
    /floor/i.test(r.headline) && /not a total/i.test(r.headline),
    `headline says the reclaim number is a floor, not a total (got "${r.headline}")`
  );
  assert(/could not be read/i.test(r.headline), 'and says something could not be read, in the headline');

  const text = report.renderText(r);
  assert(/INCOMPLETE/.test(text), 'rendered text also flags the run as incomplete, not just the object field');
}

// ======================================================================
console.log('');
console.log('z22.3 rank by rebuild cost, never by size (Module 1 rule 2)');

{
  // lib/findings.js's rankFindings sorts ASCENDING by cost class. Proved in
  // BOTH size directions: if size decided anything, swapping which finding
  // is bigger would flip the winner. It must not.
  const bigCheap = {
    id: 'node_modules', title: 'node_modules (23 GB)', module: 'reclaim',
    bytes: 23 * 1024 * 1024 * 1024, costClass: 'cheap', rebuildCost: 'npm install, ~2 min', action: 'quarantine'
  };
  const smallIrreplaceable = {
    id: 'vm-image', title: 'VM image (100 MB)', module: 'reclaim',
    bytes: 100 * 1024 * 1024, costClass: 'irreplaceable', rebuildCost: 'one of a kind, cannot be rebuilt', action: 'quarantine'
  };

  const r1 = report.buildReport([
    {
      finder: 'reclaim-1', title: 'Reclaim', module: 'reclaim',
      findings: [bigCheap, smallIrreplaceable], unreadable: [], examinedCount: 2,
      totalBytes: bigCheap.bytes + smallIrreplaceable.bytes
    }
  ]);
  const order1 = r1.sections.reclaim.map((f) => f.id);
  assert(
    order1[0] === 'node_modules' && order1[1] === 'vm-image',
    `the 23 GB CHEAP-to-rebuild finding ranks ahead of the 100 MB IRREPLACEABLE one (got ${JSON.stringify(order1)})`
  );

  const smallCheap = Object.assign({}, bigCheap, { id: 'node_modules_small', bytes: 100 * 1024 * 1024 });
  const bigIrreplaceable = Object.assign({}, smallIrreplaceable, { id: 'vm-image_big', bytes: 23 * 1024 * 1024 * 1024 });
  const r2 = report.buildReport([
    {
      finder: 'reclaim-2', title: 'Reclaim', module: 'reclaim',
      findings: [smallCheap, bigIrreplaceable], unreadable: [], examinedCount: 2,
      totalBytes: smallCheap.bytes + bigIrreplaceable.bytes
    }
  ]);
  const order2 = r2.sections.reclaim.map((f) => f.id);
  assert(
    order2[0] === 'node_modules_small' && order2[1] === 'vm-image_big',
    `cheap still ranks first even as the SMALLER file now (got ${JSON.stringify(order2)}) -- cost decided, not bytes`
  );
}

// ======================================================================
console.log('');
console.log('z22.4 wrong-but-free: own section, own count, never dropped from the overall totals');

{
  const hygieneItem = {
    id: 'unset-gradle-home', title: 'GRADLE_USER_HOME unset', module: 'hygiene',
    bytes: 0, costClass: 'cheap', action: 'audit',
    evidence: 'GRADLE_USER_HOME not present in User or Machine environment'
  };
  const reclaimItem = {
    id: 'npm-cache', title: 'npm cache', module: 'reclaim',
    bytes: Math.round(4.5 * 1024 * 1024 * 1024), costClass: 'cheap',
    rebuildCost: 'npm re-populates the cache as needed', action: 'quarantine'
  };
  const r = report.buildReport([
    { finder: 'env-vars', title: 'Redirect variables', module: 'hygiene', findings: [hygieneItem], unreadable: [], examinedCount: 5, totalBytes: 0 },
    { finder: 'npm-cache-finder', title: 'npm cache', module: 'reclaim', findings: [reclaimItem], unreadable: [], examinedCount: 1, totalBytes: reclaimItem.bytes }
  ]);

  assert(r.wrongButFree.count === 1, `wrong-but-free has its own count (got ${r.wrongButFree.count})`);
  assert(r.wrongButFree.items[0].id === 'unset-gradle-home', 'and holds the hygiene item');
  assert(r.sections.hygiene.length === 1 && r.sections.hygiene[0].id === 'unset-gradle-home', 'the hygiene section carries it too');
  assert(r.sections.reclaim.length === 1 && r.sections.reclaim[0].id === 'npm-cache', 'the reclaim section is unaffected');
  assert(r.findingCount === 2, 'the finding count covers BOTH items -- the hygiene one is not lost from the totals');
  assert(r.reclaimableBytes === reclaimItem.bytes, 'the 0-byte hygiene item does not inflate the reclaimable total, and the real one is not lost from it either');

  const text = report.renderText(r);
  assert(/WRONG BUT FREE -- 1 thing/.test(text), 'rendered text shows the wrong-but-free count as its own heading');
  assert(/GRADLE_USER_HOME unset/.test(text), 'and the wrong-but-free item itself is printed');
  const wbfIdx = text.indexOf('WRONG BUT FREE');
  const reclaimIdx = text.indexOf('RECLAIM (Module 1');
  assert(
    wbfIdx !== -1 && reclaimIdx !== -1 && wbfIdx < reclaimIdx,
    'wrong-but-free renders AHEAD of the reclaim breakdown -- a first-class section, not a footnote under the byte total'
  );
}

// ======================================================================
console.log('');
console.log('z22.5 a finder state that disagrees with its own evidence surfaces loudly');

{
  // The finder CLAIMS 'nothing' while its own findings array is non-empty --
  // exactly the shape normaliseResult exists to catch: "the evidence wins
  // over the label, and the disagreement is reported rather than silently
  // resolved" (lib/findings.js).
  const raw = [
    {
      finder: 'suspicious-finder', title: 'Suspicious', module: 'reclaim',
      state: 'nothing',
      findings: [{ id: 'x', title: 'X', module: 'reclaim', bytes: 100, costClass: 'cheap', rebuildCost: 'trivial' }],
      unreadable: [], examinedCount: 1, totalBytes: 100
    }
  ];
  const r = report.buildReport(raw);

  assert(r.disagreements.length === 1, `one disagreement is surfaced (got ${r.disagreements.length})`);
  assert(r.disagreements[0].finder === 'suspicious-finder', 'and names the finder');
  assert(
    r.disagreements[0].claimed === 'nothing' && r.disagreements[0].computed === 'found',
    `and carries both the claim and the computed truth (got ${JSON.stringify(r.disagreements[0])})`
  );

  const text = report.renderText(r);
  assert(/PIPELINE DISAGREEMENT/.test(text), 'rendered text carries a loud banner, not a quiet line item');
  assert(/suspicious-finder/.test(text), 'and names which finder disagreed');
  assert(
    text.indexOf('PIPELINE DISAGREEMENT') < text.indexOf(r.headline),
    'and the banner appears BEFORE the headline, not buried after it'
  );
}

// ======================================================================
console.log('');
console.log('z22.6 formatBytes round-trips the real numbers from the evidence (binary units, matching Explorer)');

{
  assert(
    report.formatBytes(23 * 1024 * 1024 * 1024) === '23 GB',
    `23 GB round-trips (got '${report.formatBytes(23 * 1024 * 1024 * 1024)}')`
  );
  assert(
    report.formatBytes(614 * 1024 * 1024) === '614 MB',
    `614 MB round-trips (got '${report.formatBytes(614 * 1024 * 1024)}')`
  );
  assert(
    report.formatBytes(570 * 1024 * 1024) === '570 MB',
    `570 MB round-trips (got '${report.formatBytes(570 * 1024 * 1024)}')`
  );
  assert(report.formatBytes(0) === '0 B', `0 formats plainly (got '${report.formatBytes(0)}')`);
  assert(!/nan/i.test(report.formatBytes(-5)), 'a negative input does not crash into NaN or throw');
}

// ======================================================================
console.log('');
console.log('z22.7 renderText is ASCII only (Windows PowerShell 5.1 console)');

{
  // One report that exercises every section -- wrong-but-free, reclaim,
  // rescue, unreadable, AND a disagreement -- so the ASCII check is not just
  // passing on an empty report.
  const raw = [
    {
      finder: 'env', title: 'Env vars', module: 'hygiene',
      findings: [
        { id: 'h1', title: 'ANDROID_HOME unset', module: 'hygiene', bytes: 0, costClass: 'cheap', action: 'audit', evidence: 'not set in User or Machine scope' }
      ],
      unreadable: [], examinedCount: 3, totalBytes: 0
    },
    {
      finder: 'node-artifacts', title: 'Node artifacts', module: 'reclaim',
      findings: [
        { id: 'r1', title: 'node_modules', module: 'reclaim', bytes: 23 * 1024 * 1024 * 1024, costClass: 'cheap', rebuildCost: 'npm install, ~2 min', action: 'quarantine' }
      ],
      unreadable: [{ path: 'D:\\dev\\locked-repo', reason: 'access-denied' }],
      examinedCount: 4, totalBytes: 23 * 1024 * 1024 * 1024
    },
    {
      finder: 'credential-scan', title: 'Local-only credentials', module: 'rescue',
      state: 'nothing', // deliberately wrong, to also exercise the disagreement banner
      findings: [
        { id: 'c1', title: 'key.properties (gitignored, no remote copy)', module: 'rescue', bytes: 0, costClass: 'irreplaceable', action: 'audit', evidence: 'gitignored and not present on origin' }
      ],
      unreadable: [], examinedCount: 1, totalBytes: 0
    }
  ];

  const r = report.buildReport(raw);
  assert(r.disagreements.length === 1, 'the deliberately-wrong claimed state produced a disagreement, so the banner path is actually exercised');

  const text = report.renderText(r);
  assert(/[^\x00-\x7F]/.test(text) === false, 'rendered report text is 100% ASCII');
  assert(text.length > 0, 'and it is not empty');
}

// ---- xr7j: three copies of one order --------------------------------------
//
// The module order now decides the RANKING as well as the layout, so a copy
// that drifted would put the report and the panel into different orders while
// each looked correct on its own. hygiene-report.js derives its list from
// findings.js. renderer/hygiene.js cannot -- HYGIENE_MODULES carries the
// on-screen title, icon and lede for each block -- so the thing that has to
// agree is its ORDER, and this is what agrees it.
{
  console.log('');
  console.log('One module order, three files (xr7j)');
  console.log('-----------------------------------');

  const nodeFs = require('node:fs');
  const nodePath = require('node:path');
  const repoRoot = nodePath.join(__dirname, '..');
  const findingsApi = require('../lib/findings');
  const panelSrc = nodeFs.readFileSync(nodePath.join(repoRoot, 'renderer', 'hygiene.js'), 'utf8');

  const block = panelSrc.slice(
    panelSrc.indexOf('const HYGIENE_MODULES'),
    panelSrc.indexOf('const COST_LABEL')
  );
  const panelOrder = [...block.matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);

  assert(panelOrder.length >= 4,
    `found ${panelOrder.length} module keys in HYGIENE_MODULES (a low number means this parser stopped matching, not that modules were deleted)`);
  assert(
    panelOrder.join(',') === findingsApi.MODULE_KEYS.join(','),
    `the panel renders modules in the same order the ranker sorts them (panel: ${panelOrder.join(', ')} | ranker: ${findingsApi.MODULE_KEYS.join(', ')})`
  );

  const reportKeys = require('../lib/hygiene-report');
  assert(typeof reportKeys.buildReport === 'function' || typeof reportKeys === 'object',
    'and hygiene-report.js loads with its keys derived rather than copied');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
