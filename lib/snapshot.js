// zrw: install snapshot diff.
//
// Pure functions on purpose. The engine (scanner.ps1 Get-InstallSnapshot)
// takes the two readings; everything interesting about them - what counts as
// a change, what a change is worth reporting, and how the result is phrased -
// is decided here, where it can be tested without a machine to install onto.
//
// The diff is deliberately one-directional in emphasis: an installer ADDING
// things is the normal case and the useful output. Removals are still
// reported (an installer replacing an older version of itself removes its old
// uninstall entry) but they are never presented as the headline, because a
// user watching an install does not expect to be told about deletions and
// would read that as an alarm.

'use strict';

const CATEGORIES = [
  { key: 'uninstall', singular: 'uninstall entry', plural: 'uninstall entries' },
  { key: 'dirs', singular: 'folder', plural: 'folders' },
  { key: 'run', singular: 'startup entry', plural: 'startup entries' },
  { key: 'services', singular: 'service', plural: 'services' }
];

// A snapshot's lists are compared case-insensitively: Windows paths and
// registry key paths are case-preserving but not case-sensitive, and an
// installer that rewrites "C:\Program Files\Foo" as "C:\PROGRAM FILES\Foo"
// has changed nothing a user would call a change.
function normalise(list) {
  if (!Array.isArray(list)) return new Map();
  const out = new Map();
  for (const raw of list) {
    if (raw === null || raw === undefined) continue;
    const value = String(raw);
    if (value === '') continue;
    out.set(value.toLowerCase(), value);
  }
  return out;
}

function diffList(beforeList, afterList) {
  const before = normalise(beforeList);
  const after = normalise(afterList);

  const added = [];
  const removed = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(value);
  }
  for (const [key, value] of before) {
    if (!after.has(key)) removed.push(value);
  }
  // Sorted so the same install produces the same report twice - an unstable
  // order would make two identical runs look different.
  added.sort((a, b) => a.localeCompare(b));
  removed.sort((a, b) => a.localeCompare(b));
  return { added, removed };
}

// A snapshot that failed to read a category (a locked hive, a denied
// directory) arrives as an absent or non-array field. That must not be
// silently reported as "everything in this category was removed", which is
// what a naive diff against an empty list would say. An unreadable category
// on EITHER side is reported as unknown and excluded from the counts.
function categoryReadable(before, after, key) {
  return Array.isArray(before[key]) && Array.isArray(after[key]);
}

function diffSnapshots(before, after) {
  if (!before || typeof before !== 'object') throw new Error('No "before" snapshot was taken.');
  if (!after || typeof after !== 'object') throw new Error('No "after" snapshot was taken.');

  const categories = {};
  const unreadable = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const cat of CATEGORIES) {
    if (!categoryReadable(before, after, cat.key)) {
      unreadable.push(cat.key);
      categories[cat.key] = { added: [], removed: [], readable: false };
      continue;
    }
    const d = diffList(before[cat.key], after[cat.key]);
    categories[cat.key] = { added: d.added, removed: d.removed, readable: true };
    totalAdded += d.added.length;
    totalRemoved += d.removed.length;
  }

  return {
    takenBefore: before.takenAt || null,
    takenAfter: after.takenAt || null,
    categories,
    unreadable,
    totalAdded,
    totalRemoved,
    changed: totalAdded > 0 || totalRemoved > 0
  };
}

function plural(n, cat) {
  return `${n} ${n === 1 ? cat.singular : cat.plural}`;
}

// One line of real numbers, which is the entire point of the feature. Says
// "nothing changed" plainly rather than rendering an empty list, and never
// implies completeness when a category could not be read.
function summarise(diff) {
  if (!diff) return '';

  const parts = [];
  for (const cat of CATEGORIES) {
    const c = diff.categories[cat.key];
    if (!c || !c.readable || c.added.length === 0) continue;
    parts.push(`${plural(c.added.length, cat)} added`);
  }
  for (const cat of CATEGORIES) {
    const c = diff.categories[cat.key];
    if (!c || !c.readable || c.removed.length === 0) continue;
    parts.push(`${plural(c.removed.length, cat)} removed`);
  }

  let text;
  if (parts.length === 0) {
    text = diff.unreadable.length === CATEGORIES.length
      ? 'Nothing could be compared - no part of the snapshot was readable.'
      : 'No changes were detected in the places Vanish watched.';
  } else {
    text = parts.join(', ');
  }

  if (diff.unreadable.length > 0 && diff.unreadable.length < CATEGORIES.length) {
    const names = diff.unreadable
      .map((k) => CATEGORIES.find((c) => c.key === k))
      .filter(Boolean)
      .map((c) => c.plural)
      .join(' and ');
    text += ` (${names} could not be read, so they are not counted)`;
  }
  return text;
}

// The attribution payload zrw exists to produce for bu2: the paths this
// install is now known to own, as fact rather than heuristic. Registry and
// service entries are excluded - they are not paths and cannot carry bytes.
function attributionPaths(diff) {
  if (!diff || !diff.categories || !diff.categories.dirs) return [];
  return diff.categories.dirs.readable ? diff.categories.dirs.added.slice() : [];
}

module.exports = { diffSnapshots, summarise, attributionPaths, diffList, CATEGORIES };
