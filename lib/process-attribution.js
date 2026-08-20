// 0bi: say which INSTALLED PROGRAM a running process belongs to.
//
// "What is using my CPU and RAM, and let me kill it" is solved. Task Manager
// does it, System Informer does it better, and Vanish must not build a third
// one -- that was the operator's decision on ktt (2026-08-14): the attribution
// layer, not the monitor.
//
// The sentence nothing else on this machine can assemble:
//
//   "This process is using 3.2 GB. It belongs to <program>, it starts
//    automatically, and it is reachable from your network on port N."
//
// Task Manager has no uninstall database, no startup inventory and no listener
// map. Vanish has all three. The join is the asset; the CPU and RAM numbers are
// the cheap part and were already on screen.
//
// WHAT THIS DELIBERATELY DOES NOT SAY, and it is the fourth clause of the
// sentence in the issue: "...which you have not opened since <date>". Nothing
// in this codebase knows that, and Windows disables NTFS last-access updates by
// default, so the only routes to it are inference dressed as measurement --
// which is c0y, the defect where an install date read in the wrong order put
// impossible future dates at the top of a list. The clause is omitted rather
// than invented. See the issue for the follow-up.
//
// RULE 6: no score, no "suspicious" label, no ranking by badness. Every field
// below is a fact with the command that produced it attached, in ddx's shape.
// Ordering is by memory used, because that is the question the user opened the
// screen with, and it is a measurement rather than an opinion.

'use strict';

const attribution = require('./attribution');

const { OWNED, ORPHANED, UNATTRIBUTED, SYSTEM } = attribution.STATES;

// The directory an image path lives in. Returns '' for anything that is not a
// path with a parent - a bare "svchost.exe" has no directory to classify, and
// guessing one would be the whole failure mode this module is written against.
function parentDir(imagePath) {
  const norm = attribution.normalisePath(imagePath);
  if (!norm) return '';
  const cut = norm.lastIndexOf('\\');
  if (cut <= 2) return ''; // no separator, or only the drive root's
  return norm.slice(0, cut);
}

// Every ancestor of a directory, nearest first, stopping before the drive root.
// "C:\" is not a meaningful owner of anything and matching against it would
// attribute half the machine to whatever program happened to be listed first.
function ancestorsOf(dir) {
  const out = [];
  let cur = dir;
  for (let guard = 0; guard < 24; guard++) {
    const cut = cur.lastIndexOf('\\');
    if (cut <= 2) break;
    cur = cur.slice(0, cut);
    out.push(cur);
  }
  return out;
}

// THE DIRECTION bu2's classifier does not have, and the one this feature
// actually needs.
//
// attribution.js was written for top-level directories, so its install-location
// tests are "this directory IS a registered location" and "this directory
// CONTAINS one" (the publisher-folder case). A running binary is almost always
// the other way round: Chrome registers C:\Program Files\Google\Chrome and runs
// from ...\Chrome\Application\chrome.exe. Without this test every such process
// falls through to name matching on "application", matches nothing, and is
// reported unexplained - which on a real machine is most of them.
//
// A binary sitting INSIDE a program's own registered install location belongs
// to that program as fact, not as a guess, so this is certain evidence and
// ranks above the two name heuristics.
function ownerByEnclosingInstallLocation(dir, owners) {
  if (!dir) return null;
  let best = null;
  for (const entry of owners.locations) {
    if (!entry.loc) continue;
    if (dir === entry.loc || dir.startsWith(entry.loc + '\\')) {
      // Deepest match wins: a suite and one of its components can both be
      // registered, and the component's location is the more specific truth.
      if (!best || entry.loc.length > best.loc.length) best = entry;
    }
  }
  return best;
}

// bu2's classifier returns its FIRST match and stops, which is right for it
// and loses information here. Walking up from
// C:\Program Files (x86)\Steam\bin\cef\cef.win64, the Steam directory
// answers 'contains-install-location' -> Dota 2, because Dota 2 is installed
// underneath it. That answer is refused (a Steam helper does not belong to
// Dota 2) - but refusing it also threw away the answer that WAS available
// for that same directory: the folder is called Steam, and Steam is
// installed. Eleven helper processes on the development machine came back
// unexplained for that reason alone.
//
// So this asks the same directory the weaker question directly. Same two
// rules as bu2's name matching, deliberately kept to 'likely' - a folder
// name is real evidence and one coincidence away from being wrong.
function ownerByFolderName(dir, owners) {
  if (!dir) return null;
  const cut = dir.lastIndexOf(String.fromCharCode(92));
  const leaf = attribution.normaliseName(cut >= 0 ? dir.slice(cut + 1) : dir);
  if (!leaf) return null;

  const exact = owners.byName.get(leaf);
  if (exact) return { app: exact, evidence: 'name-match' };

  if (leaf.length >= 4) {
    for (const [name, app] of owners.names) {
      if (name.length < 4) continue;
      if (leaf.startsWith(name) || name.startsWith(leaf)) return { app, evidence: 'name-prefix' };
    }
  }
  return null;
}

function classifyImage(imagePath, ctx) {
  const base = {
    state: UNATTRIBUTED,
    owner: null,
    evidence: 'none',
    confidence: null,
    matchedPath: null,
    viaAncestor: null
  };

  const dir = parentDir(imagePath);
  if (!dir) {
    // Unelevated, a protected process refuses to name its binary at all. That
    // is a fact about permissions, not about the process, and it is reported
    // as one rather than folded in with "we could not explain this".
    return Object.assign(base, { evidence: 'no-image-path' });
  }

  const enclosing = ownerByEnclosingInstallLocation(dir, ctx.owners);
  if (enclosing) {
    return Object.assign(base, {
      state: OWNED,
      owner: enclosing.app.name || null,
      evidence: 'under-install-location',
      confidence: 'certain',
      matchedPath: enclosing.loc
    });
  }

  // Everything else is bu2's classifier, unchanged and shared rather than
  // copied - recorded install evidence, exact install locations, system paths,
  // the publisher-folder case, and the two name heuristics with their own
  // confidence levels already attached.
  const own = attribution.classifyDirectory(dir, ctx);
  if (own.state !== UNATTRIBUTED) {
    return Object.assign(base, {
      state: own.state,
      owner: own.owner,
      evidence: own.evidence,
      confidence: own.confidence,
      matchedPath: dir
    });
  }

  // 'recorded-unknown-owner' is a POSITIVE determination that happens to end
  // in unattributed: we watched this directory appear and never learned whose
  // it was. Walking past it would throw away the one thing actually known
  // about it and replace it with a guess from further away.
  if (own.evidence === 'recorded-unknown-owner') {
    return Object.assign(base, { evidence: own.evidence, matchedPath: dir });
  }

  // Still nothing: try the ancestors. This is what catches a publisher folder
  // two levels up ("...\\Blender Foundation\\Blender 4.2\\blender.exe"). It can
  // only ever produce a WEAKER answer than the exe's own directory, so anything
  // found here is capped at 'likely' however confident the underlying rule was
  // - the further from the binary the evidence is, the less it is about that
  // binary.
  for (const anc of ancestorsOf(dir)) {
    const up = attribution.classifyDirectory(anc, ctx);
    if (up.state === UNATTRIBUTED) continue;

    // NEVER 'contains-install-location' from an ancestor, and this one is not
    // a nicety - it was measured, and it was wrong in the most damaging way
    // available.
    //
    // That rule means "a program is registered somewhere BENEATH this
    // directory", which is exactly right for bu2, whose input is a top-level
    // folder that might be a publisher folder. Applied to an ANCESTOR during
    // this walk it reads 'C:\\Program Files' and answers with whichever
    // program happens to be registered under it first. A binary in
    // C:\\Program Files\\NoName came back attributed to Google Chrome,
    // certain-looking and completely unrelated - on a real machine that would
    // relabel every unexplained program as some neighbour of it.
    if (up.evidence === 'contains-install-location') {
      // Refused as an ANSWER, but the directory may still have a name worth
      // reading. See ownerByFolderName above.
      const named = ownerByFolderName(anc, ctx.owners);
      if (!named) continue;
      return Object.assign(base, {
        state: OWNED,
        owner: named.app.name || null,
        evidence: named.evidence,
        confidence: 'likely',
        matchedPath: anc,
        viaAncestor: anc
      });
    }
    if (up.state === SYSTEM) {
      // A system ancestor is a real answer and is not weakened by distance:
      // anything under the Windows directory is Windows' business wherever in
      // it the binary sits.
      return Object.assign(base, {
        state: SYSTEM,
        owner: up.owner,
        evidence: up.evidence,
        confidence: 'certain',
        matchedPath: anc,
        viaAncestor: anc
      });
    }
    return Object.assign(base, {
      state: up.state,
      owner: up.owner,
      evidence: up.evidence,
      confidence: 'likely',
      matchedPath: anc,
      viaAncestor: anc
    });
  }

  return base;
}

// c0y, in one function: an inferred attribution must never read the same as a
// measured one. The wording carries the difference, because the wording is what
// the user actually reads - a confidence field nobody renders is not a safeguard.
function attributionText(result) {
  if (result.evidence === 'no-image-path') {
    return 'Windows would not say which file this is running from, so Vanish cannot tell which program it belongs to. That usually means the process is protected and Vanish is not elevated.';
  }
  if (result.state === SYSTEM) return 'Part of Windows itself.';
  if (result.state === UNATTRIBUTED) {
    return 'No installed program on this PC claims the folder this is running from. That is not an accusation - it is Vanish saying it does not know.';
  }
  if (!result.owner) {
    return 'An installed program claims the folder this is running from, but its entry records no name.';
  }
  if (result.state === ORPHANED) {
    return `Belongs to ${result.owner}, which is no longer installed.`;
  }
  if (result.confidence === 'certain') {
    return `Belongs to ${result.owner}.`;
  }
  return `Looks like it belongs to ${result.owner}, going by the folder name rather than by ${result.owner}'s own records. Vanish is not certain.`;
}

function indexStartupItems(items) {
  const byExe = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const exe = attribution.normalisePath(item.exePath);
    if (!exe) continue;
    if (!byExe.has(exe)) byExe.set(exe, item);
  }
  return byExe;
}

function indexListeners(programs) {
  const byPid = new Map();
  for (const prog of Array.isArray(programs) ? programs : []) {
    if (!prog || typeof prog !== 'object') continue;
    const pid = Number(prog.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!byPid.has(pid)) byPid.set(pid, prog);
  }
  return byPid;
}

// Ports, deduplicated and ordered, from ddx's per-socket rows. Whatever shape
// the socket record has, the port is the only part this sentence needs.
function portsOf(program) {
  const seen = new Set();
  for (const sock of (program && Array.isArray(program.listeners) ? program.listeners : [])) {
    if (!sock) continue;
    const port = Number(sock.localPort !== undefined ? sock.localPort : sock.port);
    if (Number.isFinite(port) && port > 0) seen.add(port);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

function attributeProcesses(input) {
  const processes = Array.isArray(input && input.processes) ? input.processes : [];
  const ctx = {
    owners: attribution.buildOwnerIndex(input && input.installedApps),
    recorded: attribution.buildRecordedIndex(input && input.recordedInstalls)
  };
  const startupByExe = indexStartupItems(input && input.startupItems);
  const listenersByPid = indexListeners(input && input.listeners);

  // noImagePath is counted SEPARATELY from unattributed, and the reason is
  // that the first honest look at this on a real machine reported "63%
  // unattributed" - a number that was not about what it claimed. 170 of
  // those 182 processes were ones Windows would not name the binary for,
  // because the session was not elevated. That is a fact about permissions,
  // not about how well the join works, and rolling the two together turns a
  // 91% attribution rate on readable processes into an alarming 37%.
  const counts = { owned: 0, orphaned: 0, unattributed: 0, system: 0, noImagePath: 0 };
  const results = [];

  for (const proc of processes) {
    if (!proc || typeof proc !== 'object') continue;

    const imagePath = proc.imagePath ? String(proc.imagePath) : null;
    const verdict = classifyImage(imagePath, ctx);
    counts[verdict.state] += 1;
    if (verdict.evidence === 'no-image-path') counts.noImagePath += 1;

    // Every fact carries where it came from. Not decoration: the whole claim
    // this panel makes is that these four things are true of the SAME process,
    // and a reader has to be able to check any one of them independently.
    const facts = [];
    if (Number.isFinite(Number(proc.memoryBytes))) {
      facts.push({ text: 'memory in use', value: Number(proc.memoryBytes), source: 'Get-Process WorkingSet64' });
    }
    if (Number.isFinite(Number(proc.cpuPercent))) {
      facts.push({ text: 'CPU over the sample window', value: Number(proc.cpuPercent), source: 'TotalProcessorTime delta' });
    }
    facts.push({
      text: 'which program it belongs to',
      value: verdict.owner,
      source: verdict.evidence === 'no-image-path'
        ? 'Win32_Process.ExecutablePath (not readable for this process)'
        : `Win32_Process.ExecutablePath, matched against installed programs (${verdict.evidence})`
    });

    const startupEntry = imagePath ? startupByExe.get(attribution.normalisePath(imagePath)) : null;
    if (startupEntry) {
      facts.push({
        text: 'starts automatically',
        value: true,
        source: `startup entry at ${startupEntry.managePath || startupEntry.location || 'an autostart location'}`
      });
    }

    const listener = listenersByPid.get(Number(proc.pid));
    const ports = portsOf(listener);
    if (listener) {
      facts.push({
        text: 'accepting connections',
        value: ports,
        source: `Get-NetTCPConnection Listen state (exposure: ${listener.exposure || 'unknown'})`
      });
    }

    results.push({
      pid: Number(proc.pid),
      name: proc.name ? String(proc.name) : `PID ${proc.pid}`,
      imagePath,
      memoryBytes: Number(proc.memoryBytes) || 0,
      cpuPercent: Number(proc.cpuPercent) || 0,
      state: verdict.state,
      owner: verdict.owner,
      evidence: verdict.evidence,
      confidence: verdict.confidence,
      matchedPath: verdict.matchedPath,
      viaAncestor: verdict.viaAncestor,
      attributionText: attributionText(verdict),
      startsAutomatically: startupEntry
        ? { yes: true, via: startupEntry.managePath || startupEntry.location || null, label: startupEntry.name || null }
        : null,
      listening: listener ? { ports, exposure: listener.exposure || null, count: ports.length } : null,
      facts
    });
  }

  // By memory, descending. The user's question, and a measurement rather than
  // a judgement - Rule 6 forbids ranking these by how suspicious they look.
  results.sort((a, b) => b.memoryBytes - a.memoryBytes);

  return { results, counts };
}

module.exports = {
  attributeProcesses,
  classifyImage,
  attributionText,
  parentDir,
  ancestorsOf,
  ownerByEnclosingInstallLocation
};
