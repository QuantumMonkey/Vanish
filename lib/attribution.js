// bu2: size attribution.
//
// "What is big on this disk" is solved -- WinDirStat, WizTree, TreeSize and
// Windows' own Storage page all answer it. The sentence they all stop halfway
// through is whose bytes those are, because none of them has an uninstall
// database. This module finishes that sentence.
//
// DESIGN DEVIATION from the issue's original plan, recorded here because it
// changes the whole shape: that plan called for NTFS MFT enumeration via
// FSCTL_ENUM_USN_DATA to get WizTree-class speed. USN records carry
// FileReferenceNumber, ParentFileReferenceNumber, FileName, Reason and
// FileAttributes -- they do NOT carry file size. Getting sizes that way means
// parsing raw $MFT records off the volume, which is a large amount of binary
// parsing for a payoff we do not actually need, because:
//
//   attribution is cheap and sizing is expensive, so attribute FIRST and size
//   ONLY what turns out to be worth sizing.
//
// The product question is "what are the orphans costing me", not "rank every
// byte on this disk". Classifying 200-odd top-level directories against the
// installed-programs map is milliseconds; walking all of them is minutes.
// Walking only the handful that survive classification is seconds. The fast
// path stops being necessary rather than being reimplemented.
//
// THE HONESTY RULE this module exists to enforce: "unattributed" and
// "orphaned" are different states and must never be collapsed. Orphaned is a
// positive claim -- we know who owned this and we know they are gone -- and it
// is only ever made on recorded evidence from a monitored install (zrw).
// Everything we merely cannot explain is unattributed, which is an admission,
// not an accusation. Getting this wrong would put a delete button next to a
// folder we do not understand, which is the exact behaviour this app exists
// to be the alternative to.

'use strict';


// Windows paths are case-preserving, not case-sensitive, and a trailing
// separator is not a different directory.
function normalisePath(p) {
  if (p === null || p === undefined) return '';
  let s = String(p).trim();
  if (s === '') return '';
  s = s.replace(/\//g, '\\').replace(/\\+$/, '');
  return s.toLowerCase();
}

function baseName(p) {
  const n = normalisePath(p);
  if (!n) return '';
  const parts = n.split('\\');
  return parts[parts.length - 1] || '';
}

// "Microsoft Corporation" and "microsoft" should match; so should "Blender
// Foundation" and "Blender", and "JetBrains s.r.o." and "JetBrains". Corporate
// and legal-entity suffixes carry no identifying information, and on a real
// machine they are the difference between attributing C:\Program Files\Blender
// Foundation and leaving it unexplained.
const SUFFIX_TOKENS = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'gmbh', 'co', 'company',
  'sro', 'bv', 'ab', 'sa', 'as', 'oy', 'plc', 'pty', 'ag', 'kg', 'nv', 'spa',
  'foundation', 'software', 'technologies', 'technology', 'labs', 'lab', 'group',
  'systems', 'solutions', 'studios', 'studio', 'project', 'team', 'the'
]);

function normaliseName(value) {
  if (value === null || value === undefined) return '';
  const tokens = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '';

  // Dotted abbreviations ("s.r.o.", "b.v.") arrive here as runs of single
  // letters. Rejoin them so they can be recognised as the suffixes they are
  // rather than surviving as three meaningless tokens.
  const merged = [];
  let run = [];
  for (const t of tokens) {
    if (t.length === 1) { run.push(t); continue; }
    if (run.length) { merged.push(run.join('')); run = []; }
    merged.push(t);
  }
  if (run.length) merged.push(run.join(''));

  const kept = merged.filter((t) => !SUFFIX_TOKENS.has(t));
  // Never normalise a name entirely out of existence: a program genuinely
  // called "The Project" must still match itself rather than becoming ''.
  return (kept.length ? kept : merged).join('');
}

// Directories that belong to Windows itself or are shared infrastructure no
// single program owns. Listing one of these as unattributed would be
// technically true and completely useless - the user cannot act on it, and a
// list full of noise is a list nobody reads.
const SYSTEM_DIRS = new Set([
  'windows', 'windowsapps', 'winsxs', 'microsoft', 'common files', 'temp', 'tmp',
  'packages', 'package cache', 'programdata', 'application data', 'local settings',
  'systemapps', 'defender', 'windows defender', 'windows nt', 'windows kits',
  'windows photo viewer', 'windows portable devices', 'windows security',
  'windows sidebar', 'internet explorer', 'microsoftedge', 'edgeupdate',
  'crashdumps', 'connecteddevicesplatform', 'comms', 'diagnostics', 'elevateddiagnostics',
  'history', 'inetcache', 'iconcache', 'fontcache', 'd3dscache', 'placeholdertileloghdr',
  'publisher cache', 'virtualstore', 'ncsi', 'spool', 'ssh', 'usoshared', 'usoprivate'
]);

function isSystemDir(dirPath) {
  const base = baseName(dirPath);
  if (SYSTEM_DIRS.has(base)) return true;
  // A GUID-named folder under ProgramData is almost always an installer's own
  // scratch space, not a program a user would recognise.
  if (/^\{[0-9a-f-]{30,40}\}$/.test(base)) return true;
  return false;
}

function buildOwnerIndex(installedApps) {
  const byInstallLocation = new Map();
  const byName = new Map();
  // Kept as a list, not just a map: a program very often installs into a
  // PUBLISHER folder ("C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application"),
  // so the top-level directory that shows up in a scan is an ANCESTOR of the
  // registered location rather than equal to it. Without this test, every such
  // publisher folder is reported as unexplained - which on a real machine was
  // most of them.
  const locations = [];

  for (const app of Array.isArray(installedApps) ? installedApps : []) {
    if (!app || typeof app !== 'object') continue;
    const loc = normalisePath(app.installLocation);
    if (loc) {
      // Several entries can share an install location (a suite and its parts).
      // First wins - the list arrives ordered by the engine's own enumeration
      // and any of them is a truthful answer to "who owns this".
      if (!byInstallLocation.has(loc)) byInstallLocation.set(loc, app);
      locations.push({ loc, app });
    }
    const n = normaliseName(app.name);
    if (n && !byName.has(n)) byName.set(n, app);
    const p = normaliseName(app.publisher);
    if (p && !byName.has(p)) byName.set(p, app);
  }
  return { byInstallLocation, byName, locations, names: Array.from(byName.entries()) };
}

// Recorded install deltas from zrw: { path, program, at }. This is the only
// input that can justify the word "orphaned", because it is the only one that
// records who created a directory rather than inferring it afterwards.
function buildRecordedIndex(records) {
  const byPath = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const p = normalisePath(rec.path);
    if (!p) continue;
    // Latest record wins: a path reused by a later install belongs to that one.
    const existing = byPath.get(p);
    if (!existing || String(rec.at || '') >= String(existing.at || '')) byPath.set(p, rec);
  }
  return byPath;
}

const OWNED = 'owned';
const ORPHANED = 'orphaned';
const UNATTRIBUTED = 'unattributed';
const SYSTEM = 'system';

function classifyDirectory(dirPath, ctx) {
  const norm = normalisePath(dirPath);
  const result = { path: dirPath, state: UNATTRIBUTED, owner: null, evidence: null, confidence: null };
  if (!norm) return result;

  // 1. Recorded evidence (zrw). The strongest input and the only one that can
  //    say "orphaned", because it knows who created the directory.
  const rec = ctx.recorded.get(norm);
  if (rec) {
    result.recordedAt = rec.at || null;
    if (!rec.program) {
      // We watched this directory appear but never resolved WHO created it -
      // an installer that writes no uninstall entry produces exactly this.
      // Knowing when it appeared is not knowing that its owner is gone, and
      // calling it orphaned here would be inventing the very fact that makes
      // the word meaningful.
      result.evidence = 'recorded-unknown-owner';
      result.confidence = null;
      result.state = UNATTRIBUTED;
      return result;
    }
    const stillInstalled = ctx.owners.byName.has(normaliseName(rec.program));
    result.owner = rec.program;
    result.evidence = 'recorded';
    result.confidence = 'certain';
    result.state = stillInstalled ? OWNED : ORPHANED;
    return result;
  }

  // 2. A program's registered InstallLocation, exactly or as an ancestor.
  const byLoc = ctx.owners.byInstallLocation.get(norm);
  if (byLoc) {
    result.state = OWNED;
    result.owner = byLoc.name || null;
    result.evidence = 'install-location';
    result.confidence = 'certain';
    return result;
  }

  // 3. System and shared-infrastructure directories. Checked AFTER the two
  //    positive-ownership tests so a real program installed into a folder that
  //    happens to share a system name is still attributed to it.
  if (isSystemDir(norm)) {
    result.state = SYSTEM;
    result.evidence = 'system-path';
    result.confidence = 'certain';
    return result;
  }

  // 3b. A program registered somewhere BENEATH this directory. Publisher
  //     folders are the common case and this is still certain evidence - the
  //     program's own registry entry points inside here.
  const prefix = norm + '\\';
  for (const entry of ctx.owners.locations) {
    if (entry.loc.startsWith(prefix)) {
      result.state = OWNED;
      result.owner = entry.app.name || null;
      result.evidence = 'contains-install-location';
      result.confidence = 'certain';
      return result;
    }
  }

  // 4. Folder name matching a program or publisher name. Real evidence, but
  //    weaker - it is a coincidence away from being wrong, and it is labelled
  //    as a guess so the UI can say so rather than presenting it as fact.
  const folder = normaliseName(baseName(norm));
  const byName = ctx.owners.byName.get(folder);
  if (byName) {
    result.state = OWNED;
    result.owner = byName.name || null;
    result.evidence = 'name-match';
    result.confidence = 'likely';
    return result;
  }

  // 4b. Concatenated names ("BraveSoftware", "JetBrainsToolbox") do not split
  //     into tokens, so exact matching misses them. A program or publisher
  //     name that the folder name STARTS with is the same evidence in a
  //     different shape. Guarded by a length floor: two- and three-character
  //     names match far too much to mean anything.
  if (folder.length >= 4) {
    for (const [name, app] of ctx.owners.names) {
      if (name.length < 4) continue;
      if (folder.startsWith(name) || name.startsWith(folder)) {
        result.state = OWNED;
        result.owner = app.name || null;
        result.evidence = 'name-prefix';
        result.confidence = 'likely';
        return result;
      }
    }
  }

  // 5. Everything else. NOT orphaned - unexplained. The distinction is the
  //    whole point of this module.
  result.evidence = 'none';
  result.confidence = null;
  return result;
}

function attribute(input) {
  const dirs = Array.isArray(input && input.dirs) ? input.dirs : [];
  const ctx = {
    owners: buildOwnerIndex(input && input.installedApps),
    recorded: buildRecordedIndex(input && input.recordedInstalls)
  };

  const results = dirs.map((d) => classifyDirectory(d, ctx));
  const counts = { owned: 0, orphaned: 0, unattributed: 0, system: 0 };
  for (const r of results) counts[r.state] += 1;

  return { results, counts };
}

// What is worth spending a directory walk on. Sizing every top-level folder is
// minutes; sizing the handful that are orphaned or unexplained is seconds, and
// the owned ones do not need a number because the user already knows what they
// are and can see the program in the list.
// Orphans are ordered FIRST, and that ordering is load-bearing rather than
// cosmetic: measurement runs under a time budget, so whatever is at the back
// of this list is what comes back unmeasured. Orphans are the only claims the
// scan can defend and the only ones that produce a reclaimable total, so
// spending the budget on an unexplained 12GB dev cache before them would leave
// the headline number wrong on exactly the machines that need it most.
function sizeCandidates(attributed) {
  const results = (attributed && attributed.results) || [];
  const orphaned = results.filter((r) => r.state === ORPHANED).map((r) => r.path);
  const unattributed = results.filter((r) => r.state === UNATTRIBUTED).map((r) => r.path);
  return orphaned.concat(unattributed);
}

// Merges measured sizes back in and orders by what costs the most. Anything
// that failed to measure keeps a null size and is reported as unmeasured
// rather than as zero - a folder shown as "0 B" that is actually unreadable is
// a lie the user would act on.
function withSizes(attributed, sizes) {
  const bySize = new Map();
  for (const s of Array.isArray(sizes) ? sizes : []) {
    if (!s || typeof s !== 'object') continue;
    bySize.set(normalisePath(s.path), s);
  }

  const results = ((attributed && attributed.results) || []).map((r) => {
    const m = bySize.get(normalisePath(r.path));
    const measured = m && typeof m.sizeBytes === 'number' && m.sizeBytes >= 0;
    return Object.assign({}, r, {
      sizeBytes: measured ? m.sizeBytes : null,
      measured: !!measured,
      measureError: m && m.error ? String(m.error) : null
    });
  });

  results.sort((a, b) => {
    // Orphaned first - it is the only category carrying a positive claim, and
    // burying it under bigger unexplained folders would waste the one thing
    // this feature knows for certain.
    const rank = (x) => (x.state === ORPHANED ? 0 : x.state === UNATTRIBUTED ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.sizeBytes || 0) - (a.sizeBytes || 0);
  });

  const reclaimable = results
    .filter((r) => r.state === ORPHANED && r.measured)
    .reduce((sum, r) => sum + r.sizeBytes, 0);

  return { results, counts: attributed.counts, reclaimableBytes: reclaimable };
}

module.exports = {
  attribute,
  sizeCandidates,
  withSizes,
  classifyDirectory,
  buildOwnerIndex,
  buildRecordedIndex,
  normalisePath,
  normaliseName,
  isSystemDir,
  STATES: { OWNED, ORPHANED, UNATTRIBUTED, SYSTEM }
};
