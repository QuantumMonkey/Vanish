// 2xnj: the summary row must not cost MORE on the window that can least afford
// it.
//
//   node test/summary-row-verify.js
//
// Runs in either tier - measuring a layout is not privileged.
//
// WHAT WAS WRONG. index.css carried a comment saying this row "gives ground as
// the window shrinks rather than starving what matters". It did the opposite,
// and nobody had measured it:
//
//     800x600    123px   <- 21% of the viewport
//     1080x720    94px
//     1440x900    94px
//
// The vh clamps govern padding and icon size, which are height-ish properties.
// What set the height on a narrow window was the labels WRAPPING, which is a
// function of WIDTH, and nothing clamped that: repeat(4, 1fr) gave each card
// 117px at 800 wide and "Total Disk Space" wrapped to three lines.
//
// WHAT THIS ASSERTS, and what it deliberately does not. It asserts the
// COMPARISON - the row is no taller on the small window than on the large one -
// and that no label wraps. It does NOT assert a pixel count. A test pinned to
// "86px" fails the first time somebody adjusts a padding clamp for a good
// reason, and the number was never the property; the inversion was.
//
// IT DISCRIMINATES, and that is measured rather than assumed. The same fixture
// was run against the OLD layout before the fix: 123px at 800x600 against 94px
// at 1440x900, with label heights [32, 32, 48, 32]. Both of the assertions
// below that matter - the comparison, and "no label wraps" - are false on those
// numbers. A guard nobody has watched fail is a guard nobody has tested.
//
// A PROCESS PER WINDOW SIZE. The issue records that a second offscreen
// BrowserWindow in the same run does not settle, so a single-process version of
// this would measure the second size against a layout that never finished - and
// two wrong numbers can still compare correctly, which is the worst outcome
// available here.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}

const ROOT = path.join(__dirname, '..');
// require('electron') from a plain Node process exports the path to the
// electron BINARY. Not node_modules/.bin/electron.cmd: Node refuses to spawn a
// .cmd without shell:true since the 2024 argument-injection fix, and reaching
// for shell:true to get round that would put this suite's arguments through
// cmd.exe parsing for no reason.
const ELECTRON = require('electron');
const FIXTURE = path.join(__dirname, 'fixtures', 'measure-summary-row.js');

function measure(w, h) {
  const out = execFileSync(ELECTRON, [FIXTURE, String(w), String(h)], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('MEASUREMENT '));
  if (!line) throw new Error(`no measurement in output:\n${out.slice(0, 800)}`);
  return JSON.parse(line.slice('MEASUREMENT '.length));
}

console.log('');
console.log('The summary row against a small window (2xnj)');
console.log('============================================');

let small;
let large;
try {
  small = measure(800, 600);
  large = measure(1440, 900);
} catch (err) {
  console.log(`  FAIL  could not measure: ${(err && err.message) || err}`);
  console.log('');
  console.log('Result: 0 passed, 1 failed');
  process.exit(1);
}

console.log(`  (small ${small.viewport}: row ${small.statsHeight}px, workspace ${small.workspaceHeight}px, cards ${small.cardCount} x ${small.cardWidth}px)`);
console.log(`  (large ${large.viewport}: row ${large.statsHeight}px, workspace ${large.workspaceHeight}px, cards ${large.cardCount} x ${large.cardWidth}px)`);

// PREMISE FIRST. Zeroes compare equal, and the first version of the fixture
// measured all zeroes because the panel it looks at is not on the landing tab.
// Every assertion below would have passed on nothing at all.
assert(small.statsHeight > 0 && large.statsHeight > 0,
  'premise: the row was actually rendered at both sizes',
  JSON.stringify({ small: small.statsHeight, large: large.statsHeight }));
assert(small.cardCount > 0 && small.cardCount === large.cardCount,
  `premise: the same cards are present at both sizes (${small.cardCount} vs ${large.cardCount})`);

// THE ASSERTION THE ISSUE EXISTS FOR.
assert(small.statsHeight <= large.statsHeight,
  `the row is no TALLER on the small window than the large one (${small.statsHeight}px vs ${large.statsHeight}px)`,
  'this was 123px against 94px - a fixed cost that grew as the space to pay it out of shrank');

// The mechanism, asserted directly rather than only through its symptom. 16px
// is one line at this font size; a wrapped label is taller.
assert(small.labelHeights.every((h) => h <= 20),
  `no label wraps at 800x600 (${small.labelHeights.join(', ')})`,
  'a wrapped label is the actual mechanism - the clamps never governed width');
assert(large.labelHeights.every((h) => h <= 20),
  `and none wraps at 1440x900 either (${large.labelHeights.join(', ')})`);

// The cards stay a sensible size instead of stretching to fill. repeat(2, 1fr)
// would have fixed the wrapping and given each card 680px at 1440 wide - a card
// mostly made of nothing.
assert(large.cardWidth <= 320,
  `a card does not stretch to fill a wide window (${large.cardWidth}px at 1440)`);
assert(small.cardWidth >= 180,
  `and is still wide enough to hold its label on a small one (${small.cardWidth}px at 800)`);

// The workspace is what this row is paid for out of, so the gain lands there.
assert(small.workspaceHeight > 0 && large.workspaceHeight > small.workspaceHeight,
  'the workspace still grows with the window, which is the thing the row must not eat into',
  JSON.stringify({ small: small.workspaceHeight, large: large.workspaceHeight }));

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
