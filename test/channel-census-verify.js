// The channel census: every IPC registration is classified, on purpose.
//
//   node test/channel-census-verify.js
//
// Runs in either tier. Reads main.js; invokes nothing.
//
// WHY THIS EXISTS. Two security fixes on 2026-09-05 were the same defect:
//
//   t4m9  open-external-link took a URL and handed it to shell.openExternal in
//         an elevated main process. Its own issue put it best - registered with
//         ipcMain.on, so "it is not in the fullModeOnly table and never reaches
//         the oplog - it is invisible to the elevation audit".
//   wy7a  set-settings was ungated and could arm an unattended purge of the
//         whole vault, to be carried out at the next elevated start. The gate on
//         vault-delete was not defeated; it was sidestepped by scheduling the
//         act from the tier that cannot perform it.
//
// Neither was a channel anybody had decided was safe. Both were channels nobody
// had decided anything about.
//
// A CENSUS OF 2026-09-06 FOUND NO THIRD ONE. 64 registrations, and every
// ungated channel that is not purely read-only was already accounted for. So
// this file is not a bug hunt - it is the thing that stops channel 65 arriving
// unclassified, and it is worth saying that it found nothing rather than
// implying it rescued something.
//
// WHAT IT ASKS OF A NEW CHANNEL: name it in exactly one of the three lists
// below, with a reason if it is neither gated nor read-only. The reason is the
// point. It forces the question "what does this let a compromised renderer do"
// to be answered BEFORE the channel ships, which is the question neither t4m9
// nor wy7a had an answer to.

const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Channels that CHANGE something and are therefore behind the elevation gate.
// Derived from the source, not listed - fullModeOnly is the only way to be in
// this set, so it cannot drift from what main.js actually does.
const gated = [...new Set([...mainSrc.matchAll(/fullModeOnly\(\s*'([^']+)'/g)].map((m) => m[1]))];

// Everything registered, however it was registered.
const registered = [...new Set(
  [...mainSrc.matchAll(/(?:ipcMain\.(?:handle|on)|fullModeOnly)\(\s*'([^']+)'/g)].map((m) => m[1])
)];

// Ungated AND not read-only. Every entry needs a reason that answers "what does
// this let a compromised renderer do, and why is that acceptable ungated".
//
// Adding a line here is the whole ceremony. It is meant to be slightly annoying.
const UNGATED_WITH_REASON = {
  'set-settings':
    'writes settings, but the two fields that are destructive by deferral - autoPurgeEnabled and autoPurgeRetentionDays - are refused outside Full Mode (wy7a). Audit Mode can still change scan depth and theme, which is the tier we want people in.',
  'network-ping':
    'sends one ICMP echo. Consent is checked HERE, not in the renderer, and the destination is chosen from a fixed set - two public resolvers and the router main.js read from its own engine call, never a string the caller supplies (wy7a).',
  'network-speedtest':
    'sends network traffic. Consent is checked here, in main, and has been since it shipped.',
  'open-known-link':
    'reaches shell.openExternal, so it takes a KEY and resolves it against a table in main. There is no string a renderer can send that becomes a URL (t4m9).',
  'open-vault-folder':
    'opens Explorer, on a path main computes from store.vaultRoot(). No renderer input reaches it.',
  'open-data-folder':
    'opens Explorer, on a path main computes from store.dataDir(). No renderer input reaches it.',
  'browse-for-path':
    'opens the OS file picker. The user chooses; the renderer cannot preselect a path or answer for them.',
  'relaunch-elevated':
    'asks Windows for elevation. UAC is the gate, and it is the one gate a renderer cannot forge - the consent prompt is the OS, not us.',
  'relaunch-deelevated':
    'DROPS privilege. Windows has never required authorisation to hold less of it, and the direction is the safe one.',
  'dismiss-elevation-offer':
    'clears an in-memory flag so the startup offer is shown at most once per boot.',
  'snapshot-begin':
    'takes a read-only reading of Run keys, program folders, services and uninstall entries into memory. It installs nothing and writes nothing.',
  'snapshot-finish':
    'takes the second reading and returns the difference. Still a comparison, still writes nothing.',
  'snapshot-cancel':
    'discards the in-memory snapshot. Nothing on disk was ever created, so there is nothing to undo.',
  'window-minimize':
    'minimises the app window. A compromised renderer can already draw whatever it likes inside that window; moving it is not an escalation.',
  'window-maximize':
    'maximises the app window. Same reasoning as minimize - it changes nothing outside the frame.',
  'window-close':
    'closes the app window. The worst a renderer achieves is quitting an app the user can restart, and the vault is written before anything is removed.'
};

// Handlers that reference isFullMode() THEMSELVES rather than sitting behind the
// fullModeOnly wrapper. Both legitimate uses exist and they are different:
//
//   REPORTING the tier is the renderer's whole source of truth for its banner
//   and its disabled states.
//   GATING on the tier by hand is only correct when the thing being gated is
//   finer than the channel - a FIELD rather than a call - which the wrapper
//   structurally cannot express.
//
// Anything else is a second implementation of the tier rule, which is the drift
// this repository keeps being bitten by, and it skips the oplog entry the
// wrapper writes - which is exactly what made t4m9 invisible to the elevation
// audit.
const TIER_AWARE_BY_HAND = {
  'check-admin':
    'RETURNS isFullMode(). It reports the tier rather than gating on it - this is the channel the renderer asks.',
  'set-settings':
    'gates two FIELDS rather than the channel (wy7a). autoPurgeEnabled and autoPurgeRetentionDays are refused outside Full Mode while the rest of the patch still saves, which fullModeOnly cannot express because it wraps the whole call.',
  'get-tier':
    'REPORTS the tier in its payload. This is the channel the banner and every disabled state read from - the renderer has no other source of truth for which tier it is in.',
  'get-app-info':
    'REPORTS the tier alongside the app details, so the details panel can show its own controls as locked without a second round trip.',
  'relaunch-elevated':
    'short-circuits a no-op: not being elevated means there is nothing to drop, so it returns alreadyUnelevated rather than starting work. It refuses nothing and performs nothing on that branch.'
};

console.log('');
console.log('IPC channel census');
console.log('==================');

// ---------------------------------------------------------------------------
console.log('');
console.log('The census is actually reading main.js');

// PREMISE FIRST. Every assertion below is about set membership, and an empty
// set satisfies most of them. A regex that matched nothing would look like a
// perfectly classified application.
assert(registered.length > 50,
  `main.js registers ${registered.length} channels`);
assert(gated.length > 10,
  `${gated.length} of them are behind fullModeOnly`);
for (const must of ['vault-delete', 'uninstall-native', 'cleaner-purge', 'kill-process']) {
  assert(gated.includes(must),
    `${must} is gated - if this ever reads false the extraction is broken, not the app`);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('Every channel is classified');

const readOnly = registered.filter((c) => !gated.includes(c) && !UNGATED_WITH_REASON[c]);

// A channel that is neither gated nor listed above is treated as read-only BY
// DEFAULT, and that default is the thing this file exists to make deliberate.
// So the assertion is not "everything is classified" - that is a tautology when
// one bucket is the remainder. It is that the read-only bucket has not grown
// since it was last read through.
//
// 31 on 2026-09-06, after reading every one of them.
//
// I first wrote 37 here from memory and the check failed on its first run,
// which is the argument for pinning it rather than deriving it: a derived count
// agrees with whatever the code does, including whatever the code started doing
// last Tuesday. A number somebody had to look up is the only kind that can
// disagree.
//
// Raising it means a channel was added; the ceremony is to read it and decide
// whether it belongs in UNGATED_WITH_REASON instead, then change this line.
assert(readOnly.length === 31,
  `the read-only bucket holds the 31 channels reviewed on 2026-09-06 (${readOnly.length} now)`,
  readOnly.length !== 37
    ? `changed: ${readOnly.filter((c) => !c).join('') || readOnly.join(' ')}`
    : '');

// A SECOND TAUTOLOGY LIVED HERE and was deleted before it shipped: it compared
// `unclassified.length` to `readOnly.length`, where both names held the SAME
// filter expression. Third one this week, all mine - the mirror guard in bcff,
// the partition check in engine-missing-verify, and this. The pattern is always
// the same: assert something about a value you have just derived, and the
// assertion inherits the derivation instead of checking it. The pinned count
// above is the version that can fail, because 37 came from reading them.

// ---------------------------------------------------------------------------
console.log('');
console.log('The reasons are reasons');

const shortReasons = Object.entries(UNGATED_WITH_REASON).filter(([, r]) => String(r).trim().length < 40);
assert(shortReasons.length === 0,
  'every ungated-with-reason entry carries an actual explanation, not a word',
  shortReasons.map(([c]) => c).join(', '));

const staleReasons = Object.keys(UNGATED_WITH_REASON).filter((c) => !registered.includes(c));
assert(staleReasons.length === 0,
  'and none of them names a channel that no longer exists - a stale entry silently pre-approves the next channel to take that name',
  staleReasons.join(', '));

const gatedButAlsoExcused = Object.keys(UNGATED_WITH_REASON).filter((c) => gated.includes(c));
assert(gatedButAlsoExcused.length === 0,
  'and none of them is ALSO gated, which would mean the reason was written about the wrong thing',
  gatedButAlsoExcused.join(', '));

// ---------------------------------------------------------------------------
console.log('');
console.log('The gate is applied by the wrapper, not by hand');

// fullModeOnly writes the refusal AND the oplog entry in one place. A handler
// that checked isFullMode() itself would be a second implementation of the tier
// rule - the drift this repository has been bitten by repeatedly - and would
// skip the oplog, which is what made t4m9 invisible to the elevation audit.
// Scoped to each handler's OWN body - from its registration to the next one -
// rather than a fixed character window. The first version used 600 characters
// and reported check-admin, whose body is a single line, because the window ran
// on into get-tier's.
const bodies = [];
const reg = /(?:ipcMain\.(?:handle|on)|fullModeOnly)\(\s*'([^']+)'/g;
let m;
while ((m = reg.exec(mainSrc))) {
  const start = m.index;
  const nextAt = mainSrc.slice(reg.lastIndex).search(/(?:ipcMain\.(?:handle|on)|fullModeOnly)\(\s*'/);
  const end = nextAt === -1 ? mainSrc.length : reg.lastIndex + nextAt;
  bodies.push({ channel: m[1], body: mainSrc.slice(start, end) });
}
assert(bodies.length === registered.length + (bodies.length - new Set(bodies.map((b) => b.channel)).size),
  `premise: every registration got a body (${bodies.length} bodies for ${registered.length} channels)`);

const tierAware = bodies
  .filter((b) => /isFullMode\(\)/.test(b.body))
  .map((b) => b.channel)
  .filter((c) => !gated.includes(c));
const unexplainedTierChecks = tierAware.filter((c) => !TIER_AWARE_BY_HAND[c]);
assert(unexplainedTierChecks.length === 0,
  'every handler that reads the tier by hand says why it cannot use the fullModeOnly wrapper',
  unexplainedTierChecks.join(', '));

const staleTierReasons = Object.keys(TIER_AWARE_BY_HAND).filter((c) => !tierAware.includes(c));
assert(staleTierReasons.length === 0,
  'and no reason is left behind for a handler that stopped reading the tier',
  staleTierReasons.join(', '));

assert(/appendOplog\(/.test(mainSrc.slice(mainSrc.indexOf('function fullModeOnly'), mainSrc.indexOf('function fullModeOnly') + 900)),
  'and the wrapper records every refusal to the oplog, so a rejected destructive call is auditable');

console.log('');
console.log(`  (${gated.length} gated, ${Object.keys(UNGATED_WITH_REASON).length} ungated with a stated reason, ${readOnly.length} read-only)`);
console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
