// 5p5 Verify: the seam. Finder results in, decided UI state out.
//
// The bug this exists to make unrepresentable is D-1, reported by the operator
// on 2026-08-21: in the uninstaller flow, when a post-uninstall scan finds NO
// leftovers, "Move to quarantine" still behaves like a Next button - it
// advances a wizard that has no next step and no Next button on screen.
//
// HANDOFF-2026-08-21 is explicit that the fix is NOT a guard in the click
// handler: "patching it leaves the class intact". The class is that scan,
// classify, decide and report share one scope in a 7,870-line file, so a
// zero-result case has no distinct TYPE, so callers cannot branch on it, so
// the UI guesses.
//
// Therefore every assertion below tests the STATE, not the button. If a future
// renderer draws the wrong control, that is a rendering bug against a correct
// state. If the state is wrong, every renderer downstream of it is wrong, and
// no amount of styling fixes it - which is also why 949 (the "make it feel
// modern" pass) is blocked on this rather than the other way round.
//
//   node test/findings-verify.js

const f = require('../lib/findings');

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

function finding(over) {
  return Object.assign({ id: 'x', title: 'x', path: '', bytes: 0, costClass: 'unknown' }, over || {});
}

function unreadable(path, reason) {
  return { path, reason: reason || 'access-denied', detail: '' };
}

function result(over) {
  return Object.assign(
    { finder: 'demo', title: 'Demo', findings: [], unreadable: [], examinedCount: 0, totalBytes: 0 },
    over || {}
  );
}

// ======================================================================
console.log('5p5.1 the three finder states are computed from evidence, not read off the wire');

{
  const nothing = f.normaliseResult(result({ examinedCount: 12 }));
  assert(nothing.state === f.NOTHING, 'no findings and nothing unreadable is "nothing"');
  assert(nothing.complete === true, 'and it is complete, so a decider may trust it');

  const found = f.normaliseResult(result({ findings: [finding({ id: 'a' })], examinedCount: 12 }));
  assert(found.state === f.FOUND, 'one finding is "found"');

  const blind = f.normaliseResult(result({ unreadable: [unreadable('C:\\x')], examinedCount: 90 }));
  assert(blind.state === f.COULD_NOT_LOOK, 'no findings but something unreadable is "could-not-look"');
  assert(blind.state !== f.NOTHING, 'and specifically NOT "nothing" - aeu, the rule the whole suite hangs on');
  assert(blind.examinedCount === 90, 'the 90 locations that WERE read are not discarded by that verdict');
}

// ======================================================================
console.log('');
console.log('5p5.2 a claimed state that disagrees with its own evidence loses, and is reported');

{
  // The engine computes state correctly today. This asserts what happens when
  // it does not - a hand-built payload, a partial write, a future finder that
  // returns a literal. The evidence wins, and the disagreement is surfaced
  // rather than silently resolved, because a pipeline that quietly corrects
  // its inputs is a pipeline nobody can debug.
  const lying = f.normaliseResult(result({ state: 'nothing', unreadable: [unreadable('C:\\y')] }));
  assert(lying.state === f.COULD_NOT_LOOK, 'the computed state wins over the claimed one');
  assert(lying.stateDisagreement !== null, 'and the disagreement is recorded');
  assert(lying.stateDisagreement.claimed === 'nothing', 'naming what was claimed');
  assert(lying.stateDisagreement.computed === f.COULD_NOT_LOOK, 'and what the evidence says');

  const honest = f.normaliseResult(result({ state: 'nothing' }));
  assert(honest.stateDisagreement === null, 'agreement produces no noise');
}

// ======================================================================
console.log('');
console.log('5p5.3 D-1: a zero-finding scan is a NAMED TERMINAL STATE, not a step with nothing in it');

{
  const clean = f.decide([result({ examinedCount: 7 })]);
  assert(clean.state === f.UI_NOTHING_FOUND, 'a clean scan lands in nothing-found');
  assert(clean.terminal === true, 'which is TERMINAL - there is nothing to advance to');
  assert(clean.canAdvance === false, 'so the flow cannot advance, and the control that would is not offered');
  assert(clean.trustworthy === true, 'and this is the one empty result a decider may treat as clean');
  assert(/Nothing found/.test(clean.headline), 'the state carries its own sentence rather than leaving the UI to invent one');

  const work = f.decide([result({ findings: [finding({ id: 'a' })], examinedCount: 7 })]);
  assert(work.state === f.UI_HAS_WORK, 'a scan with findings has work');
  assert(work.canAdvance === true, 'and is the ONLY state in which advancing is meaningful');
  assert(work.terminal === false, 'so it is not terminal');

  // This is the regression. D-1 was the wizard advancing because an action
  // COMPLETED, rather than because there was work to do. Completion is not in
  // this model at all: canAdvance is a function of the state, and the state is
  // a function of the evidence. There is no code path from "the button was
  // clicked and nothing went wrong" to "advance".
  assert(
    f.canAdvance(f.UI_NOTHING_FOUND) === false &&
    f.canAdvance(f.UI_INCOMPLETE) === false &&
    f.canAdvance(f.UI_FAILED) === false,
    'D-1 regression: no terminal state permits advancing, whatever the user just clicked'
  );
}

// ======================================================================
console.log('');
console.log('5p5.4 aeu at the decider: "could not look" never arrives as empty');

{
  const partial = f.decide([result({ unreadable: [unreadable('C:\\a'), unreadable('C:\\b')], examinedCount: 90 })]);
  assert(partial.state === f.UI_INCOMPLETE, 'no findings plus unreadable entries is incomplete');
  assert(partial.state !== f.UI_NOTHING_FOUND, 'and never nothing-found, which is what would authorise a delete');
  assert(partial.terminal === true, 'it is still terminal - there is no work to advance to');
  assert(partial.trustworthy === false, 'but it is NOT trustworthy, and that is the difference that matters');
  assert(/not the same as clean/.test(partial.headline), 'the headline says so in words, not in a flag the UI may ignore');
  assert(partial.unreadableCount === 2, 'and the count travels with it');

  // A partial FOUND is still partial. "We found 3" quietly meaning "3 of an
  // unknown number" is the same defect wearing a success badge.
  const partialFound = f.decide([result({ findings: [finding({ id: 'a' })], unreadable: [unreadable('C:\\c')] })]);
  assert(partialFound.state === f.UI_HAS_WORK, 'findings plus unreadable entries still has work');
  assert(partialFound.trustworthy === false, 'but the count is not trustworthy');
  assert(/there may be more/.test(partialFound.headline), 'and the headline says the number is a floor');
}

// ======================================================================
console.log('');
console.log('5p5.5 a scan that did not run establishes nothing');

{
  const none = f.decide([]);
  assert(none.state === f.UI_FAILED, 'no results at all is failed, not clean');
  assert(none.terminal === true, 'terminal');
  assert(none.canAdvance === false, 'and not advanceable');
  assert(none.trustworthy === false, 'and explicitly not trustworthy');
  assert(/established nothing/.test(none.headline), 'said plainly, because a blank screen reads as a pass');
}

// ======================================================================
console.log('');
console.log('5p5.6 ranking is by rebuild cost, never by size');

{
  // HANDOFF-2026-08-21 Module 1 rule 2, with the real numbers: a 23 GB
  // node_modules that rebuilds in two minutes and a 12 GB VM image that took a
  // day to configure are not the same offer. Sorting by bytes puts the cheap
  // one first and calls it the biggest win.
  const ranked = f.rankFindings([
    finding({ id: 'node_modules', bytes: 23 * 1024 * 1024 * 1024, costClass: 'cheap' }),
    finding({ id: 'keystore', bytes: 2048, costClass: 'irreplaceable' }),
    finding({ id: 'vm-image', bytes: 12 * 1024 * 1024 * 1024, costClass: 'expensive' }),
    finding({ id: 'unmeasured', bytes: 50 * 1024 * 1024 * 1024, costClass: 'unknown' })
  ]);

  assert(ranked[0].id === 'node_modules', 'the cheapest-to-rebuild is offered first');
  assert(ranked[1].id === 'vm-image', 'then the expensive one');
  assert(ranked[2].id === 'keystore', 'then the irreplaceable one, last of the measured');
  assert(ranked[3].id === 'unmeasured', 'and an UNKNOWN cost sorts last despite being the largest by far');
  assert(
    f.costRank('unknown') > f.costRank('irreplaceable'),
    'an unmeasured cost is not a cheap one - a ranker treating it as zero floats the most dangerous offer to the top'
  );

  const tie = f.rankFindings([
    finding({ id: 'small', bytes: 10, costClass: 'cheap' }),
    finding({ id: 'big', bytes: 1000, costClass: 'cheap' })
  ]);
  assert(tie[0].id === 'big', 'size breaks a tie within one cost class, and only there');
}

// ======================================================================
console.log('');
console.log('5p5.7 the decider aggregates across finders without losing which one spoke');

{
  const decided = f.decide([
    result({ finder: 'creds', module: 'rescue', findings: [finding({ id: 'k', costClass: 'irreplaceable' })], examinedCount: 3 }),
    result({ finder: 'path', module: 'hygiene', findings: [finding({ id: 'p', costClass: 'cheap' })], examinedCount: 27 }),
    result({ finder: 'repos', module: 'hygiene', unreadable: [unreadable('D:\\repo', 'dubious-ownership')], examinedCount: 10 })
  ]);

  assert(decided.findingCount === 2, 'findings from every finder are collected');
  assert(decided.examinedCount === 40, 'and the examined counts add up');
  assert(decided.findings.every((x) => typeof x.finder === 'string' && x.finder.length > 0), 'every finding still names the finder that produced it');
  assert(decided.unreadable[0].finder === 'repos', 'and every unreadable entry does too');
  assert(decided.unreadable[0].reason === 'dubious-ownership', 'carrying its reason - "10 errors" is not actionable, "dubious ownership" is');
  assert(decided.state === f.UI_HAS_WORK, 'one finder being blind does not erase another finder\'s findings');
  assert(decided.trustworthy === false, 'but the aggregate is still not trustworthy while any part of it was blind');
}

// ======================================================================
console.log('');
console.log('5p5.8 malformed input degrades to a state, never to an exception');

{
  // main.js does a strict JSON.parse and this module is downstream of it, but
  // "the engine returned something structurally odd" must still produce a
  // state the UI can render. A thrown exception here would surface as a blank
  // panel, which reads exactly like a clean machine.
  const junk = f.normaliseResult(null);
  assert(junk.state === f.NOTHING && junk.findingCount === 0, 'null normalises rather than throwing');

  const weird = f.normaliseResult({ findings: null, unreadable: 'not-an-array' });
  assert(weird.findingCount === 0, 'a null findings list is an empty one');
  assert(weird.unreadableCount === 1, 'and a bare scalar is wrapped rather than dropped - dropping it would be the aeu defect again');
  assert(weird.state === f.COULD_NOT_LOOK, 'so it lands in could-not-look');

  assert(f.headlineFor('made-up-state', 0, 0, 0) === '', 'an unknown state produces no sentence rather than a wrong one');
}

// ======================================================================
console.log('');
console.log('D-1 regression: the uninstall wizard leftover screen, at the place it was reported');

{
  // The operator's report, 2026-08-21: "when a post-uninstall scan finds no
  // leftovers, Move to quarantine still behaves like a Next button - it
  // advances the wizard, on a screen that has no Next button and nowhere to
  // advance to."
  //
  // These assert the STATE, which is the acceptance criterion on the bd issue.
  // renderer/wizard.js derives the button's existence from canAdvance, so a
  // state with nothing to quarantine cannot render the control at all - as
  // opposed to rendering it and guarding the click, which is what the handoff
  // explicitly rejected as "leaves the class intact".

  const withWork = f.fromLeftovers({
    success: true,
    files: [{ path: 'C:\\ProgramData\\Thing', sizeBytes: 1024, risk: 'Safe', type: 'Data folder' }],
    registry: [{ path: 'HKCU\\Software\\Thing', risk: 'Safe' }]
  });
  assert(withWork.state === f.UI_HAS_WORK, 'leftovers found puts the screen in has-work');
  assert(withWork.canAdvance === true, 'which is the only state where "Move to quarantine" means anything');
  assert(withWork.findingCount === 2, 'files and registry keys both become findings');
  assert(withWork.findings.some((x) => x.kind === 'registry'), 'and each keeps its kind, so the purge call can still split them');

  const clean = f.fromLeftovers({ success: true, files: [], registry: [] });
  assert(clean.state === f.UI_NOTHING_FOUND, 'a genuinely clean uninstall is nothing-found');
  assert(clean.canAdvance === false, 'D-1: there is NO state in which a clean scan permits advancing');
  assert(clean.terminal === true, 'it is the end of the flow, named as such');
  assert(clean.trustworthy === true, 'and it is trustworthy, so "removed itself cleanly" is an honest thing to print');

  // This one did not exist before. main.js used to catch a failed scan and
  // return { files: [], registry: [] }, which is byte-identical to the clean
  // result above - so an engine crash printed a green tick and the words "this
  // program removed itself cleanly". It now returns success:false with the
  // error, and the two cases separate here.
  const failed = f.fromLeftovers({ success: false, error: 'ENGINE_BAD_OUTPUT', files: [], registry: [] });
  assert(failed.state === f.UI_INCOMPLETE, 'a scan that FAILED is incomplete, not clean');
  assert(failed.state !== clean.state, 'and specifically NOT the same state as a clean uninstall - the aeu regression, on the most-used path in the app');
  assert(failed.trustworthy === false, 'it is not trustworthy');
  assert(failed.canAdvance === false, 'and still offers nothing to quarantine, because there is nothing');
  assert(failed.unreadable[0].detail === 'ENGINE_BAD_OUTPUT', 'the engine error travels to the screen rather than into a console nobody reads');
  assert(!/cleanly|Nothing found/.test(failed.headline), 'and the headline never congratulates the user on a scan that did not run');

  // Ordering guard: a failed scan that also returned some findings is still a
  // partial result, not a success. Belt and braces - the engine should not do
  // this, but "should not" is not a state machine.
  const messy = f.fromLeftovers({ success: false, error: 'timeout', files: [{ path: 'C:\\x', sizeBytes: 1 }], registry: [] });
  assert(messy.state === f.UI_HAS_WORK, 'findings plus a failure still has work to offer');
  assert(messy.trustworthy === false, 'but the list is explicitly not complete');

  const empty = f.fromLeftovers(null);
  assert(empty.canAdvance === false, 'and a null payload advances nothing rather than throwing');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
