// 0bi Verify: process attribution (lib/process-attribution.js).
//
// The feature's whole claim is that four facts are true of the SAME process,
// and that the one Vanish INFERS is not dressed up as one it measured. So the
// assertions here fall into three groups:
//
//   1. The join is right - the program, the startup entry and the listener all
//      belong to the process they are attached to.
//   2. The direction bu2's classifier does not have: a binary running from
//      INSIDE a program's registered install location. Missing this reports
//      most of a real machine as unexplained, because programs register
//      C:\Program Files\Google\Chrome and run from ...\Chrome\Application.
//   3. c0y: an inferred attribution never reads like a measured one.
//
//   node test/process-attribution-verify.js

const pa = require('../lib/process-attribution');
const attribution = require('../lib/attribution');
const { OWNED, ORPHANED, UNATTRIBUTED, SYSTEM } = attribution.STATES;

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

const apps = [
  { name: 'Google Chrome', publisher: 'Google LLC', installLocation: 'C:\\Program Files\\Google\\Chrome' },
  { name: 'Git', publisher: 'The Git Development Community', installLocation: 'C:\\Program Files\\Git' },
  { name: 'Chrome Updater', publisher: 'Google LLC', installLocation: 'C:\\Program Files\\Google\\Chrome\\Updater' },
  { name: 'Blender', publisher: 'Blender Foundation', installLocation: '' },
  { name: 'Old Thing', publisher: 'Gone Ltd', installLocation: 'C:\\Program Files\\OldThing' }
];

function run(processes, extra) {
  return pa.attributeProcesses(
    Object.assign(
      {
        processes,
        installedApps: apps,
        recordedInstalls: [],
        startupItems: [],
        listeners: []
      },
      extra || {}
    )
  );
}

console.log('');
console.log('Process attribution (0bi)');
console.log('=========================');

// ======================================================================
console.log('');
console.log('0bi.1 the direction bu2 does not have: running from INSIDE an install location');

{
  const r = run([
    { pid: 100, name: 'chrome', imagePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', memoryBytes: 3221225472 }
  ]).results[0];

  assert(r.state === OWNED, 'a binary below a registered install location is OWNED, not unexplained');
  assert(r.owner === 'Google Chrome', `and it names the program (got '${r.owner}')`);
  assert(r.evidence === 'under-install-location', 'the evidence says which rule matched');
  assert(r.confidence === 'certain', 'and it is certain - the program\'s own registry entry points at the folder above this binary');
}

{
  // A suite and a component can both be registered. The deeper registration is
  // the more specific truth and must win, or every component is attributed to
  // its parent suite.
  const r = run([
    { pid: 101, name: 'updater', imagePath: 'C:\\Program Files\\Google\\Chrome\\Updater\\bin\\updater.exe', memoryBytes: 1000 }
  ]).results[0];
  assert(r.owner === 'Chrome Updater', `the deepest registered install location wins (got '${r.owner}')`);
}

{
  // Exact match on the install location itself, not a descendant.
  const r = run([
    { pid: 102, name: 'git', imagePath: 'C:\\Program Files\\Git\\git.exe', memoryBytes: 2000 }
  ]).results[0];
  assert(r.state === OWNED && r.owner === 'Git', 'a binary in the install location itself is owned too');
}

// ======================================================================
console.log('');
console.log('0bi.2 what it refuses to guess');

{
  const r = run([
    { pid: 200, name: 'mystery', imagePath: 'C:\\Users\\someone\\AppData\\Local\\mystery\\mystery.exe', memoryBytes: 5000 }
  ]).results[0];

  assert(r.state === UNATTRIBUTED, 'a binary no installed program claims is UNATTRIBUTED');
  assert(r.owner === null, 'with no owner invented for it');
  assert(r.confidence === null, 'and no confidence, because there is no claim to be confident about');
  assert(
    /does not know/i.test(r.attributionText),
    'and it says so in words - an admission, not an accusation'
  );
  assert(
    !/orphan/i.test(r.attributionText),
    'and never the word orphaned, which is a positive claim this has not earned'
  );
}

{
  // Unelevated, a protected process will not name its binary. That is a fact
  // about permissions and must not be folded in with "we cannot explain it".
  const r = run([{ pid: 4, name: 'System', imagePath: null, memoryBytes: 100 }]).results[0];
  assert(r.evidence === 'no-image-path', 'a process that will not name its binary is reported as exactly that');
  assert(
    /protected|not elevated/i.test(r.attributionText),
    'and the text says why, rather than blaming the process'
  );
}

// ======================================================================
console.log('');
console.log('0bi.3 c0y: an inferred attribution must not read like a measured one');

{
  // Blender registers no install location, so the only route is the folder
  // name - real evidence, one coincidence away from being wrong.
  const guessed = run([
    { pid: 300, name: 'blender', imagePath: 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe', memoryBytes: 9000 }
  ]).results[0];
  const measured = run([
    { pid: 301, name: 'git', imagePath: 'C:\\Program Files\\Git\\cmd\\git.exe', memoryBytes: 9000 }
  ]).results[0];

  assert(guessed.state === OWNED, 'a publisher folder name still attributes the process');
  assert(guessed.confidence === 'likely', 'but at "likely", not "certain"');
  assert(guessed.evidence === 'name-prefix', `and the evidence names the weaker rule that matched (got '${guessed.evidence}')`);
  assert(measured.confidence === 'certain', 'while a registered install location is certain');
  assert(
    guessed.attributionText !== measured.attributionText,
    'THE ASSERTION THIS EXISTS FOR: the two do not read the same'
  );
  assert(
    /not certain|looks like/i.test(guessed.attributionText),
    'the inferred one hedges in the text a user actually reads'
  );
  assert(
    !/not certain|looks like/i.test(measured.attributionText),
    'and the measured one does not hedge'
  );
}

// ======================================================================
console.log('');
console.log('0bi.3b the ancestor walk, and the answer it must never give');

{
  // A real ancestor case: the binary sits in a folder whose own name matches
  // nothing, under a publisher folder that does.
  const r = run([
    { pid: 310, name: 'blender', imagePath: 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\bin\\blender.exe', memoryBytes: 1 }
  ]).results[0];
  assert(r.state === OWNED && r.owner === 'Blender', 'evidence one level up still attributes the process');
  assert(r.viaAncestor !== null, 'and it records that the answer came from a folder above the binary');
  assert(r.confidence === 'likely', 'capped at likely - the further the evidence is from the binary, the less it is about it');
}

{
  // THE ONE THIS SECTION EXISTS FOR, and it was a real bug rather than a
  // hypothetical: bu2's 'a program is registered BENEATH this directory' rule
  // is right for a top-level folder and catastrophic for an ancestor. Walking
  // up to C:\\Program Files, it answered with whichever program was registered
  // under it first - so an unexplained binary came back belonging to Google
  // Chrome, with a confident sentence attached.
  const r = run([
    { pid: 311, name: 'nothing', imagePath: 'C:\\Program Files\\NoSuchVendor\\thing.exe', memoryBytes: 1 }
  ]).results[0];
  assert(r.state === UNATTRIBUTED, `an unexplained binary under a shared container stays unexplained (got '${r.state}' owned by '${r.owner}')`);
  assert(r.owner === null, 'and is NOT attributed to a neighbour that happens to live under the same root');
}

// ======================================================================
console.log('');
console.log('0bi.3c both halves of the ancestor rule, from the real machine');

{
  // MEASURED on the development machine, not imagined. Steam registers no
  // install location of its own, and Dota 2 registers one UNDERNEATH Steam's
  // folder. Walking up from Steam's CEF helper, the Steam directory answered
  // "contains-install-location -> Dota 2". Refusing that answer was right;
  // stopping there was not, because the same directory is also called Steam
  // and Steam is installed. Eleven helper processes came back unexplained.
  const steamApps = [
    { name: 'Steam', publisher: 'Valve Corporation', installLocation: '' },
    { name: 'Dota 2', publisher: 'Valve', installLocation: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta' }
  ];
  const out = pa.attributeProcesses({
    processes: [{ pid: 320, name: 'steamwebhelper', imagePath: 'C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win64\\steamwebhelper.exe', memoryBytes: 1 }],
    installedApps: steamApps,
    recordedInstalls: [],
    startupItems: [],
    listeners: []
  });
  const r = out.results[0];

  assert(r.owner !== 'Dota 2', 'a helper is NOT attributed to a program that merely installs under the same folder');
  assert(r.owner === 'Steam', `it is attributed to the folder's own program instead (got '${r.owner}')`);
  assert(r.confidence === 'likely', 'at likely, because a folder name is what carried it');
}

{
  // MEASURED: twelve Store-app processes were labelled as Part of Windows
  // itself, because a Store package lives under C:\\Program Files\\WindowsApps
  // and bu2's classifier calls that a system path - correctly, for bu2. The
  // package record carries the exact install location, so feeding Store apps
  // into the same list attributes them and beats the system-path rule.
  const storeApps = [
    { name: 'Claude', publisher: 'pzs8sxrjxfjjc', installLocation: 'C:\\Program Files\\WindowsApps\\Claude_1.32885.1.0_x64__pzs8sxrjxfjjc', type: 'UWP' }
  ];
  const withStore = pa.attributeProcesses({
    processes: [{ pid: 330, name: 'Claude', imagePath: 'C:\\Program Files\\WindowsApps\\Claude_1.32885.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe', memoryBytes: 1 }],
    installedApps: storeApps,
    recordedInstalls: [], startupItems: [], listeners: []
  }).results[0];
  const withoutStore = pa.attributeProcesses({
    processes: [{ pid: 331, name: 'Claude', imagePath: 'C:\\Program Files\\WindowsApps\\Claude_1.32885.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe', memoryBytes: 1 }],
    installedApps: [],
    recordedInstalls: [], startupItems: [], listeners: []
  }).results[0];

  assert(withStore.state === OWNED, 'a Store app process is attributed to the Store app');
  assert(withStore.owner === 'Claude', `and named (got '${withStore.owner}')`);
  assert(withStore.confidence === 'certain', "certain - the package's own record points at the folder above the binary");
  assert(
    withoutStore.state === SYSTEM,
    'and the reason it needs the Store list: without it, WindowsApps reads as Windows itself'
  );
}

// ======================================================================
console.log('');
console.log('0bi.4 orphaned is only ever said on recorded evidence');

{
  const recorded = [{ path: 'C:\\Program Files\\GhostApp', program: 'Ghost App', at: '2026-01-01' }];
  const r = run(
    [{ pid: 400, name: 'ghost', imagePath: 'C:\\Program Files\\GhostApp\\ghost.exe', memoryBytes: 1234 }],
    { recordedInstalls: recorded }
  ).results[0];

  assert(r.state === ORPHANED, 'a recorded install whose program is gone is ORPHANED');
  assert(r.owner === 'Ghost App', 'and it names who owned it');
  assert(/no longer installed/i.test(r.attributionText), 'and says the program is gone');
}

{
  // Recorded, but the installer never wrote an uninstall entry, so nobody ever
  // knew who owned it. "We watched this appear" is not "we know it is gone".
  const recorded = [{ path: 'C:\\Program Files\\NoName', program: null, at: '2026-01-01' }];
  const r = run(
    [{ pid: 401, name: 'noname', imagePath: 'C:\\Program Files\\NoName\\x.exe', memoryBytes: 1 }],
    { recordedInstalls: recorded }
  ).results[0];
  assert(r.state === UNATTRIBUTED, `a recorded path with no known owner stays unattributed, not orphaned (got '${r.state}')`);
  assert(r.evidence === 'recorded-unknown-owner', 'and the reason survives - we watched it appear and never learned whose it was');
}

// ======================================================================
console.log('');
console.log('0bi.5 Windows is Windows');

{
  const r = run([
    { pid: 500, name: 'svchost', imagePath: 'C:\\Windows\\System32\\svchost.exe', memoryBytes: 40000 }
  ]).results[0];
  assert(r.state === SYSTEM, 'a binary under the Windows directory is SYSTEM');
  assert(/Part of Windows/i.test(r.attributionText), 'and says so plainly');
}

// ======================================================================
console.log('');
console.log('0bi.6 the join - the other three facts, attached to the right process');

{
  const out = run(
    [
      { pid: 600, name: 'chrome', imagePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', memoryBytes: 3221225472, cpuPercent: 4.5 },
      { pid: 601, name: 'git', imagePath: 'C:\\Program Files\\Git\\git.exe', memoryBytes: 1000 }
    ],
    {
      startupItems: [
        { exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', managePath: 'HKCU:\\...\\Run', name: 'Chrome' }
      ],
      listeners: [
        { pid: 600, exposure: 'all', listeners: [{ localPort: 9222 }, { localPort: 9222 }, { localPort: 5353 }] }
      ]
    }
  );

  const chrome = out.results.find((r) => r.pid === 600);
  const git = out.results.find((r) => r.pid === 601);

  assert(chrome.startsAutomatically && chrome.startsAutomatically.yes === true, 'the startup entry lands on the process it belongs to');
  assert(git.startsAutomatically === null, 'and NOT on the one it does not');
  assert(chrome.listening && chrome.listening.ports.length === 2, `ports are deduplicated (got ${chrome.listening && chrome.listening.ports.join()})`);
  assert(chrome.listening.ports[0] === 5353 && chrome.listening.ports[1] === 9222, 'and ordered');
  assert(git.listening === null, 'a process with no listener says nothing about ports');
  assert(chrome.listening.exposure === 'all', 'the exposure ddx measured is carried through, not recomputed');
}

// ======================================================================
console.log('');
console.log('0bi.7 every fact carries the command that produced it');

{
  const out = run(
    [{ pid: 700, name: 'chrome', imagePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', memoryBytes: 100, cpuPercent: 1 }],
    {
      startupItems: [{ exePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', managePath: 'HKCU:\\Run' }],
      listeners: [{ pid: 700, exposure: 'loopback', listeners: [{ localPort: 1 }] }]
    }
  );
  const facts = out.results[0].facts;

  assert(facts.length === 5, `all five facts are present (got ${facts.length})`);
  assert(facts.every((f) => f.source && f.source.length > 0), 'every one names where it came from');
  assert(
    facts.some((f) => /ExecutablePath/.test(f.source)),
    'the attribution names the property it was read from'
  );
  assert(
    facts.some((f) => /Get-NetTCPConnection/.test(f.source)),
    'the listener fact names the command ddx used'
  );
}

// ======================================================================
console.log('');
console.log('0bi.8 no score, no verdict, no ranking by badness (Rule 6)');

{
  const out = run([
    { pid: 800, name: 'small', imagePath: 'C:\\Program Files\\Git\\git.exe', memoryBytes: 10 },
    { pid: 801, name: 'big', imagePath: 'C:\\Users\\x\\AppData\\Local\\mystery\\m.exe', memoryBytes: 999999 }
  ]);

  assert(out.results[0].pid === 801, 'ordering is by memory used, descending - the question the user asked');
  const json = JSON.stringify(out);
  assert(!/"risk"/.test(json), 'no risk field is emitted');
  assert(!/suspicious/i.test(json), 'and nothing is called suspicious');
  assert(!/"score"/.test(json), 'and nothing is scored');
}

// ======================================================================
console.log('');
console.log('0bi.9 counts');

{
  const out = run([
    { pid: 900, name: 'a', imagePath: 'C:\\Program Files\\Git\\git.exe', memoryBytes: 1 },
    { pid: 901, name: 'b', imagePath: 'C:\\Windows\\System32\\svchost.exe', memoryBytes: 1 },
    { pid: 902, name: 'c', imagePath: 'C:\\Users\\x\\AppData\\Local\\zz\\zz.exe', memoryBytes: 1 }
  ]);
  assert(out.counts.owned === 1, `owned counted (got ${out.counts.owned})`);
  assert(out.counts.system === 1, `system counted (got ${out.counts.system})`);
  assert(out.counts.unattributed === 1, `unattributed counted (got ${out.counts.unattributed})`);
  assert(out.counts.orphaned === 0, 'and nothing was called orphaned without evidence');

  // The split that stops the headline lying. On the development machine 170 of
  // 182 unattributed processes were ones Windows would not name the binary for,
  // unelevated. Rolled together that reads as a 37% attribution rate; separated
  // it is 100% of everything readable.
  const withHidden = run([
    { pid: 910, name: 'readable', imagePath: 'C:\\Program Files\\Git\\git.exe', memoryBytes: 1 },
    { pid: 911, name: 'protected', imagePath: null, memoryBytes: 1 }
  ]);
  assert(withHidden.counts.noImagePath === 1, 'a process Windows would not name is counted separately');
  assert(withHidden.counts.unattributed === 1, 'it still appears in unattributed, so no row goes missing from the totals');
  assert(withHidden.counts.owned === 1, 'and the readable one is attributed');
}

// ======================================================================
console.log('');
console.log('0bi.10 the drive root is never an owner');

{
  assert(pa.parentDir('C:\\notepad.exe') === '', 'a binary at the drive root has no directory worth classifying');
  assert(pa.ancestorsOf('c:\\program files\\a\\b').every((d) => d !== 'c:'), 'the ancestor walk stops before the drive root');
  const r = run([{ pid: 1000, name: 'root', imagePath: 'C:\\thing.exe', memoryBytes: 1 }]).results[0];
  assert(r.state === UNATTRIBUTED, 'and a binary sitting there is unattributed rather than owned by whatever matched first');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
