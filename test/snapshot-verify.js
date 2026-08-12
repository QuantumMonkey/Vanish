// zrw Verify: the install snapshot diff (lib/snapshot.js).
//
// The engine takes the readings; this file owns everything that decides what a
// reading MEANS. Each assertion below exists because the naive version of this
// diff gets it wrong in a way a user would notice:
//
//   - a case-only path rewrite is not a change, but string equality says it is
//   - a category that could not be read is not "everything was deleted", but
//     diffing against an empty list says exactly that
//   - two identical installs must produce identical reports, which requires a
//     stable sort rather than whatever order the OS enumerated in
//
//   node test/snapshot-verify.js

const snapshot = require('../lib/snapshot');

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

function snap(over) {
  return Object.assign(
    { takenAt: '2026-08-12T00:00:00.000Z', run: [], dirs: [], uninstall: [], services: [] },
    over || {}
  );
}

console.log('');
console.log('Install snapshot diff (zrw)');
console.log('===========================');

// --- the ordinary case: an installer adds things --------------------------
{
  const before = snap({
    dirs: ['C:\\Program Files\\Existing'],
    uninstall: ['HKLM:\\...\\Uninstall\\{existing}'],
    run: [],
    services: ['Spooler']
  });
  const after = snap({
    dirs: ['C:\\Program Files\\Existing', 'C:\\Program Files\\NewApp', 'C:\\ProgramData\\NewApp'],
    uninstall: ['HKLM:\\...\\Uninstall\\{existing}', 'HKLM:\\...\\Uninstall\\{newapp}'],
    run: ['HKCU:\\...\\Run\\NewApp'],
    services: ['Spooler', 'NewAppUpdater']
  });

  const d = snapshot.diffSnapshots(before, after);
  assert(d.changed === true, 'an install that added things is reported as changed');
  assert(d.totalAdded === 5, 'every added item across all four categories is counted');
  assert(d.totalRemoved === 0, 'nothing is invented as removed');
  assert(d.categories.dirs.added.length === 2, 'both new folders are found');
  assert(d.categories.services.added[0] === 'NewAppUpdater', 'a new service is found');

  const text = snapshot.summarise(d);
  assert(
    /1 uninstall entry added/.test(text),
    `the summary uses the singular for one item (got: "${text}")`
  );
  assert(/2 folders added/.test(text), 'and the plural for several');
  assert(
    !/removed/.test(text),
    'a pure-addition install says nothing about removals, which would read as an alarm'
  );

  // The payload bu2 consumes: paths this program is now KNOWN to own.
  const paths = snapshot.attributionPaths(d);
  assert(paths.length === 2, 'attribution yields the added folders');
  assert(
    paths.every((p) => !p.startsWith('HK')),
    'attribution excludes registry entries - they are not paths and carry no bytes'
  );
}

// --- a case-only rewrite is not a change ----------------------------------
{
  const before = snap({ dirs: ['C:\\Program Files\\Foo'] });
  const after = snap({ dirs: ['C:\\PROGRAM FILES\\foo'] });
  const d = snapshot.diffSnapshots(before, after);
  assert(
    d.changed === false && d.totalAdded === 0 && d.totalRemoved === 0,
    'a case-only path difference is not reported as an add plus a remove'
  );
}

// --- an unreadable category is not a mass deletion ------------------------
{
  const before = snap({ dirs: ['C:\\Program Files\\Foo', 'C:\\Program Files\\Bar'] });
  const after = snap({ dirs: undefined });

  const d = snapshot.diffSnapshots(before, after);
  assert(
    d.categories.dirs.readable === false,
    'a category missing from one side is marked unreadable'
  );
  assert(
    d.totalRemoved === 0,
    'an unreadable category reports ZERO removals, never "everything was deleted"'
  );
  assert(d.unreadable.includes('dirs'), 'and it is named in the unreadable list');

  const text = snapshot.summarise(d);
  assert(
    /could not be read/.test(text) && /not counted/.test(text),
    `the summary admits the gap rather than implying completeness (got: "${text}")`
  );
}

// --- nothing happened -----------------------------------------------------
{
  const before = snap({ dirs: ['C:\\Program Files\\Foo'] });
  const after = snap({ dirs: ['C:\\Program Files\\Foo'] });
  const d = snapshot.diffSnapshots(before, after);
  assert(d.changed === false, 'an install that changed nothing watched is reported as unchanged');
  assert(
    /No changes were detected/.test(snapshot.summarise(d)),
    'and says so in words rather than rendering an empty list'
  );
}

// --- every category unreadable is distinct from "nothing changed" ---------
{
  const d = snapshot.diffSnapshots(snap({ run: null, dirs: null, uninstall: null, services: null }),
                                   snap({ run: null, dirs: null, uninstall: null, services: null }));
  assert(
    /Nothing could be compared/.test(snapshot.summarise(d)),
    '"nothing was readable" is worded differently from "nothing changed" - they mean opposite things'
  );
}

// --- an upgrade removes its own old entry ---------------------------------
{
  const before = snap({ uninstall: ['HKLM:\\...\\Uninstall\\{v1}'] });
  const after = snap({ uninstall: ['HKLM:\\...\\Uninstall\\{v2}'] });
  const d = snapshot.diffSnapshots(before, after);
  assert(d.totalAdded === 1 && d.totalRemoved === 1, 'an upgrade shows one added and one removed');
  const text = snapshot.summarise(d);
  assert(
    text.indexOf('added') < text.indexOf('removed'),
    'additions lead the summary; removals follow rather than heading it'
  );
}

// --- stable output --------------------------------------------------------
{
  const before = snap({ dirs: [] });
  const a = snapshot.diffSnapshots(before, snap({ dirs: ['C:\\b', 'C:\\a', 'C:\\c'] }));
  const b = snapshot.diffSnapshots(before, snap({ dirs: ['C:\\c', 'C:\\a', 'C:\\b'] }));
  assert(
    JSON.stringify(a.categories.dirs.added) === JSON.stringify(b.categories.dirs.added),
    'enumeration order does not change the report - two identical installs read identically'
  );
}

// --- refuses to guess when a snapshot is missing --------------------------
{
  let threw = false;
  try { snapshot.diffSnapshots(null, snap()); } catch { threw = true; }
  assert(threw, 'a missing "before" snapshot is an error, not an empty diff');

  threw = false;
  try { snapshot.diffSnapshots(snap(), undefined); } catch { threw = true; }
  assert(threw, 'a missing "after" snapshot is an error too');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
