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

  // ---- qkgu: the same adapter for System Clean's seven cleaners ----------
  //
  // They predate the contract, so every branch of Invoke-CleanerScan wrote
  // success = $true as a literal and the panel's only test was
  // findings.length === 0 -> a green tick. The four cases below are the four
  // the panel now has to tell apart, and the first two are the pair that used
  // to be indistinguishable.
  const cClean = f.fromCleanerScan({ success: true, findings: [], unreadable: [] }, 'services', 'Left-over services');
  const cBlind = f.fromCleanerScan(
    { success: true, findings: [], unreadable: [{ path: 'HKLM\\SECURITY', reason: 'key-denied' }] },
    'services', 'Left-over services'
  );
  assert(cClean.state === f.UI_NOTHING_FOUND, 'a sweep that read everything and found nothing is nothing-found');
  assert(cBlind.state === f.UI_INCOMPLETE, 'a sweep that was refused is incomplete');
  assert(cClean.findingCount === cBlind.findingCount,
    'and they have the SAME finding count - which is the entire reason the old code could not tell them apart');
  assert(cClean.state !== cBlind.state, 'the states are what separate them now, and they differ');
  assert(cBlind.trustworthy === false, 'the refused one is not trustworthy');
  assert(!/^Nothing found\.?$/.test(cBlind.headline) && /not the same as clean/i.test(cBlind.headline),
    'and its headline says so in words rather than leaving it to a colour', cBlind.headline);

  const cPartial = f.fromCleanerScan(
    {
      success: true,
      findings: [{ id: 'svc|a', label: 'DeadService', risk: 'Safe', kind: 'registry' }],
      unreadable: [{ path: 'HKLM\\SECURITY', reason: 'key-denied' }]
    },
    'services', 'Left-over services'
  );
  assert(cPartial.state === f.UI_HAS_WORK, 'findings plus a refusal still has work to offer');
  assert(cPartial.trustworthy === false,
    'but is not trustworthy - "we found 3" silently meaning "3 of an unknown number" is the same defect wearing a success badge');
  assert(cPartial.findings[0].title === 'DeadService',
    'and the finding survives with its label, because a blind spot must not cost the findings we DID get');

  const cFailed = f.fromCleanerScan({ success: false, error: 'engine returned nothing' }, 'services', 'x');
  assert(cFailed.state === f.UI_INCOMPLETE, 'a failed scan is incomplete, matching fromLeftovers rather than inventing a fifth rule');
  assert(cFailed.unreadable.some((u) => /engine returned nothing/.test(u.detail)),
    'and the engine error travels with it');

  // The engine caps its own blind-spot list at 200 and reports the remainder.
  // That number has to reach the SCREEN, which means the field the list
  // renders - caught by the UI suite when it arrived in `detail` instead.
  const cCapped = f.fromCleanerScan({ success: true, findings: [], unreadable: [], unreadableDropped: 47 }, 'services', 'x');
  assert(cCapped.state === f.UI_INCOMPLETE, 'a dropped remainder alone is still enough to make it incomplete');
  assert(cCapped.unreadable.some((u) => /47 more location/.test(u.path)),
    'and the count is in the field that gets rendered, not only in a detail nobody shows',
    JSON.stringify(cCapped.unreadable));

  const cNull = f.fromCleanerScan(null, 'services', 'x');
  assert(cNull.state === f.UI_NOTHING_FOUND || cNull.state === f.UI_INCOMPLETE,
    'and a null payload produces a state rather than throwing');
}

// ---- a cost class the vocabulary does not contain -------------------------
//
// FOUND BY MUTATION TESTING 2026-09-03, not by review. costRankIn returns
// order.length for an unrecognised class so it sorts LAST. Changing that to 0
// made the mutant SURVIVE - 2,235 assertions and not one noticed. The file
// comments on this exact danger one screen up ("a ranker that treated it as
// zero would put the most dangerous offers at the top of the list") and then
// nothing checked it. A documented hazard with no assertion behind it is a
// hazard, not a safeguard.
//
// TWO CASES THAT LOOK THE SAME AND ARE NOT, which the first version of this
// block got wrong and these assertions now separate:
//
//   ABSENT       null / undefined / '' normalise to 'unknown', a class that IS
//                in the vocabulary. It then follows the 'unknown' policy -
//                last in reclaim, SECOND in rescue, because an unmeasured cost
//                might be irreplaceable and burying it would be the same
//                mistake in the other direction.
//   UNRECOGNISED 'Cheap', 'expensive ' with a trailing space, a misspelt
//                'irreplacable'. Not in the vocabulary at all, so it can carry
//                no policy and must rank last in EVERY order.
//
// The second is not hypothetical: a finder with a typo in one string literal
// produces it, and under the mutated ranker it would head the reclaim list -
// at the top of the things the operator is being invited to delete.
{
  console.log('');
  console.log('A cost class the vocabulary does not contain');
  console.log('-------------------------------------------');

  const unrecognised = ['Cheap', 'expensive ', 'irreplacable', 'free', 42];
  for (const bogus of unrecognised) {
    const shown = JSON.stringify(bogus);
    assert(
      f.costRankIn(f.COST_ORDER_SAFEST_FIRST, bogus) === f.COST_ORDER_SAFEST_FIRST.length,
      `an unrecognised cost class ranks last in the reclaim order, never first (${shown})`
    );
    assert(
      f.costRankIn(f.COST_ORDER_LOSS_FIRST, bogus) === f.COST_ORDER_LOSS_FIRST.length,
      `  and last in the rescue order too - it carries no policy, so it earns no position (${shown})`
    );
  }

  // Absent is a different thing and must keep following the 'unknown' policy.
  for (const absent of [null, undefined, '']) {
    const shown = JSON.stringify(absent);
    assert(
      f.costRankIn(f.COST_ORDER_SAFEST_FIRST, absent) === f.COST_ORDER_SAFEST_FIRST.indexOf('unknown'),
      `an ABSENT cost class normalises to 'unknown' rather than being unrecognised (${shown})`
    );
    assert(
      f.costRankIn(f.COST_ORDER_LOSS_FIRST, absent) === f.COST_ORDER_LOSS_FIRST.indexOf('unknown'),
      `  and so keeps its deliberate second place in the rescue order (${shown})`
    );
  }

  // End to end through decide(), because the ranker is only dangerous via it.
  // The mistyped finding is also the BIGGEST, so a byte-first regression would
  // put it top as well - this fails for either reason, which is what it is for.
  const mixed = f.decide([
    {
      finder: 'x',
      state: 'found',
      module: 'reclaim',
      findings: [
        finding({ id: 'typo-class', costClass: 'Cheap', module: 'reclaim', bytes: 999999 }),
        finding({ id: 'real-cheap', costClass: 'cheap', module: 'reclaim', bytes: 1 })
      ],
      unreadable: [],
      examined: 1
    }
  ]);
  assert(
    mixed.findings[0].id === 'real-cheap',
    `a mistyped cost class does not head the reclaim list even when it is the biggest (got ${mixed.findings[0].id})`
  );
}

// ---- xr7j: the same number answers two opposite questions -----------------
//
// Until 2026-09-02 one cost order served every module, and it was the reclaim
// order. In the RESCUE module -- whose stated job is "what a delete would
// destroy" -- that put the safest findings at the top. Measured on the
// development machine: duplicate-content is registered -module 'rescue' and
// returns 4,040 findings, every one costClass 'cheap', against a 100-row
// per-module render cap, in the same module as local-only-credentials.
//
// The on-screen caption said the opposite in as many words.
{
  console.log('');
  console.log('Two opposite questions, two orders (xr7j)');
  console.log('----------------------------------------');

  const one = (id, costClass, module) => finding({ id, costClass, module, bytes: 100 });
  const rank = (module) => {
    const d = f.decide([{
      finder: 'x',
      state: 'found',
      module,
      findings: [
        one('a', 'cheap', module),
        one('b', 'irreplaceable', module),
        one('c', 'unknown', module),
        one('d', 'moderate', module),
        one('e', 'expensive', module)
      ],
      unreadable: [],
      examined: 1
    }]);
    return d.findings.map((x) => x.costClass);
  };

  const rescue = rank('rescue');
  assert(rescue[0] === 'irreplaceable',
    `rescue asks "what would I lose", so the irreplaceable finding is FIRST (got ${rescue[0]})`);
  assert(rescue[rescue.length - 1] === 'cheap',
    'and the one a command regenerates is last, where it costs least to miss');
  assert(rescue[1] === 'unknown',
    'an UNMEASURED rebuild cost ranks second, not last - it might be irreplaceable, and burying it under things known to be cheap is the same mistake in the other direction');

  const reclaim = rank('reclaim');
  assert(reclaim[0] === 'cheap',
    `reclaim asks "what is safe to remove", so the cheapest to rebuild is FIRST (got ${reclaim[0]})`);
  assert(reclaim[reclaim.length - 1] === 'unknown',
    'and unknown is last here, because an unmeasured cost is not a cheap one and must not head a list of things to delete');

  assert(rescue[0] !== reclaim[0],
    'the two modules genuinely order differently - one comparator for both is what this issue was');

  // The real shape: 4,040 cheap findings must not bury one irreplaceable in
  // the module built to show it.
  const many = [];
  for (let i = 0; i < 300; i += 1) many.push(one(`dup${i}`, 'cheap', 'rescue'));
  many.push(one('credential', 'irreplaceable', 'rescue'));
  const buried = f.decide([{ finder: 'x', state: 'found', module: 'rescue', findings: many, unreadable: [], examined: 1 }]);
  const pos = buried.findings.findIndex((x) => x.id === 'credential');
  assert(pos === 0,
    `one irreplaceable finding among 300 cheap ones ranks first in rescue (it ranked at position ${pos + 1}) - with a 100-row cap, anything past 100 is not on the screen at all`);
}

// ---- the caption cannot disagree with the sort ----------------------------
{
  console.log('');
  console.log('The caption is generated from the comparator (xr7j)');
  console.log('--------------------------------------------------');

  assert(/cannot rebuild are at the top/.test(f.costOrderCaption('rescue')),
    'the rescue caption says the irreplaceable ones are at the top, which is what the rescue comparator does');
  assert(/regenerates are at the top/.test(f.costOrderCaption('reclaim')),
    'and the reclaim caption says the opposite, because the reclaim comparator does the opposite');
  assert(f.costOrderCaption('rescue') !== f.costOrderCaption('reclaim'),
    'so the two are not the same sentence - one literal served both, and it was true of neither module as sorted');

  // The assertion that fails if someone reverses a comparator and forgets the
  // words, which is exactly how this defect was born.
  for (const mod of f.MODULE_KEYS) {
    const lossFirst = f.costOrderFor(mod)[0] === 'irreplaceable';
    const saysLossFirst = /cannot rebuild are at the top/.test(f.costOrderCaption(mod));
    assert(lossFirst === saysLossFirst,
      `${mod}: the caption and the comparator agree about which end is which`);
  }

  assert(f.costOrderFor('nonsense-module')[0] === 'cheap',
    'an unregistered module falls back to the reclaim order rather than throwing');
  assert(f.moduleKey('nonsense-module') === 'other',
    "and is filed under 'other' rather than dropped");
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
