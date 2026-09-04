// z71u: an unreadable vault manifest must not read as an empty one.
//
//   node test/manifest-integrity-verify.js
//
// THE DEFECT THIS EXISTS FOR, in the order it happened:
//
//   readJson(manifestPath(), defaultManifest()) returned { entries: [] } for
//   "the file is not there" AND for "the file is there and I could not read
//   it". The Quarantine screen then said "Nothing in quarantine yet" over a
//   full vault - and the next addManifestEntry read that empty list, pushed one
//   entry, and ATOMICALLY RENAMED a one-entry manifest over the real one.
//
// Every prior entry's originalPath was gone. The payloads stayed on disk under
// vault\<uuid> with nothing left to say what they were or where they belonged.
// A transient read error was upgraded to permanent data loss by the very next
// user action, on the single promise the product is built on.
//
// So the assertions below are mostly about REFUSING TO WRITE. The one that
// matters most is the last in section 2: after a failed read, the bytes on disk
// are unchanged.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}

const store = require('../lib/store');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-z71u-'));
  store.init(dir);
  return dir;
}

function entry(id, originalPath) {
  return {
    schemaVersion: 1, id, sourceApp: 'Probe', origin: 'purge',
    createdAt: new Date().toISOString(), status: 'quarantined',
    files: [{ originalPath, status: 'quarantined' }], registry: [], meta: {},
  };
}

const dirs = [];
console.log('');
console.log('Vault manifest integrity (z71u)');
console.log('===============================');

// ---------------------------------------------------------------------------
console.log('');
console.log('A manifest that is genuinely absent is still a first run');

let d = freshStore(); dirs.push(d);
assert(!fs.existsSync(store.manifestPath()), 'premise: no manifest on disk yet');
let m = store.readManifest();
assert(m && Array.isArray(m.entries) && m.entries.length === 0,
  'readManifest returns an empty manifest rather than throwing');
store.addManifestEntry(entry('11111111-1111-1111-1111-111111111111', 'C:\\a\\one.txt'));
assert(store.readManifest().entries.length === 1, 'and the first entry writes normally');

// ---------------------------------------------------------------------------
console.log('');
console.log('A manifest that EXISTS and cannot be parsed is not an empty manifest');

d = freshStore(); dirs.push(d);
store.addManifestEntry(entry('22222222-2222-2222-2222-222222222222', 'C:\\a\\keep-me.txt'));
store.addManifestEntry(entry('33333333-3333-3333-3333-333333333333', 'C:\\a\\keep-me-too.txt'));
const live = store.manifestPath();
const goodBytes = fs.readFileSync(live);
assert(store.readManifest().entries.length === 2, 'premise: two entries are recorded');

// Corrupt it the way a half-finished write or a bad sector would.
fs.writeFileSync(live, '{ "schemaVersion": 1, "entries": [ {"id":"22222', 'utf8');

let threw = null;
try { store.readManifest(); } catch (e) { threw = e; }
assert(threw !== null, 'readManifest THROWS rather than returning an empty manifest');
assert(threw && threw.code === 'MANIFEST_UNREADABLE',
  'and it carries a code a caller can branch on', threw && threw.code);
assert(threw && /still on disk/i.test(threw.message),
  'and the message tells the user their payloads are not lost', threw && threw.message);

// THE ASSERTION THIS FILE EXISTS FOR.
let addThrew = null;
try { store.addManifestEntry(entry('44444444-4444-4444-4444-444444444444', 'C:\\a\\new.txt')); }
catch (e) { addThrew = e; }
assert(addThrew !== null, 'addManifestEntry refuses to write on top of a manifest it could not read');
const afterBytes = fs.readFileSync(live);
assert(afterBytes.equals(fs.readFileSync(live)) && afterBytes.toString() === '{ "schemaVersion": 1, "entries": [ {"id":"22222',
  'and the file on disk is BYTE-UNCHANGED - nothing was overwritten',
  afterBytes.toString().slice(0, 80));

// Same for the other two mutators, which had the identical shape.
let upd = null;
try { store.updateManifestEntry('22222222-2222-2222-2222-222222222222', (e) => { e.status = 'restored'; }); }
catch (e) { upd = e; }
assert(upd !== null, 'updateManifestEntry refuses too');
let rem = null;
try { store.removeManifestEntry('22222222-2222-2222-2222-222222222222'); } catch (e) { rem = e; }
assert(rem !== null, 'and so does removeManifestEntry');

// And the data really was recoverable all along.
fs.writeFileSync(live, goodBytes);
assert(store.readManifest().entries.length === 2,
  'restoring the bytes brings both entries back - the refusal preserved them');

// ---------------------------------------------------------------------------
console.log('');
console.log('A manifest that cannot be READ, as opposed to cannot be PARSED');
// Everything above corrupts the CONTENT, so the failure happens at JSON.parse.
// Mutation testing caught that: turning every readFileSync error into
// "missing" survived, because no assertion here had ever reached that branch.
// The real-world case is not a bad byte, it is EACCES after the SEC-3 ACL pass
// or EBUSY from a scanner holding the file - the read itself failing on a
// manifest that is entirely intact.

d = freshStore(); dirs.push(d);
store.addManifestEntry(entry('88888888-8888-8888-8888-888888888888', 'C:\\a\\intact.txt'));
const intact = store.manifestPath();
const intactBytes = fs.readFileSync(intact);

// FileShare.None denies everything, including read, for as long as it is held.
const holder = require('node:child_process').spawn('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `$fs=[System.IO.File]::Open('${intact.replace(/'/g, "''")}',` +
  `[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);` +
  `Write-Output READY; Start-Sleep -Seconds 20; $fs.Close()`
], { stdio: ['ignore', 'pipe', 'ignore'] });

let ready = false;
const started = Date.now();
holder.stdout.on('data', (b) => { if (String(b).includes('READY')) ready = true; });
while (!ready && Date.now() - started < 15000) {
  try { require('node:child_process').execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 200"', { stdio: 'ignore' }); }
  catch { /* just burning time */ }
}

let readBlocked = false;
try { fs.readFileSync(intact, 'utf8'); } catch { readBlocked = true; }

if (!readBlocked) {
  console.log('  SKIP  the lock did not deny reads on this machine, so this case cannot run here');
} else {
  let lockThrew = null;
  try { store.readManifest(); } catch (e) { lockThrew = e; }
  assert(lockThrew !== null,
    'a manifest whose CONTENT is fine but whose read fails still throws - denied is not absent');
  assert(lockThrew && lockThrew.code === 'MANIFEST_UNREADABLE',
    'with the same code, so callers do not have to tell the two failures apart',
    lockThrew && lockThrew.code);

  let lockAdd = null;
  try { store.addManifestEntry(entry('99999999-9999-9999-9999-999999999999', 'C:\\a\\no.txt')); }
  catch (e) { lockAdd = e; }
  assert(lockAdd !== null, 'and addManifestEntry still refuses to write');
}

try { holder.kill(); } catch { /* it exits on its own */ }
// Give Windows a moment to release the handle before the cleanup at the end.
try { require('node:child_process').execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 600"', { stdio: 'ignore' }); } catch { /* ignore */ }
try {
  assert(fs.readFileSync(intact).equals(intactBytes),
    'and the manifest is byte-unchanged once the lock is gone');
} catch (e) {
  assert(false, 'and the manifest is byte-unchanged once the lock is gone', e.message);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('A manifest that parses but is not shaped like one is corruption, not an old schema');

d = freshStore(); dirs.push(d);
store.addManifestEntry(entry('55555555-5555-5555-5555-555555555555', 'C:\\a\\x.txt'));
fs.writeFileSync(store.manifestPath(), JSON.stringify({ schemaVersion: 1, entries: 'not-a-list' }), 'utf8');
let shapeThrew = null;
try { store.readManifest(); } catch (e) { shapeThrew = e; }
assert(shapeThrew !== null,
  'entries that is not a list throws, rather than being silently replaced with []');

fs.writeFileSync(store.manifestPath(), JSON.stringify(['an', 'array']), 'utf8');
let arrThrew = null;
try { store.readManifest(); } catch (e) { arrThrew = e; }
assert(arrThrew !== null, 'and so does a manifest that is a JSON array');

// ---------------------------------------------------------------------------
console.log('');
console.log('readJsonDetailed tells the two cases apart, which is what makes the above possible');

d = freshStore(); dirs.push(d);
const gone = path.join(d, 'not-here.json');
const bad = path.join(d, 'bad.json');
fs.writeFileSync(bad, '{ oops', 'utf8');

const missing = store.readJsonDetailed(gone);
assert(missing.missing === true && missing.ok === false,
  'an absent file reports missing:true');
const broken = store.readJsonDetailed(bad);
assert(broken.missing === false && broken.ok === false && broken.error,
  'a file that exists but will not parse reports missing:false WITH the error');
fs.writeFileSync(bad, JSON.stringify({ a: 1 }), 'utf8');
const good = store.readJsonDetailed(bad);
assert(good.ok === true && good.value && good.value.a === 1, 'and a good file reports ok with the value');

// ---------------------------------------------------------------------------
console.log('');
console.log('Every successful write leaves a recoverable copy behind');

d = freshStore(); dirs.push(d);
store.addManifestEntry(entry('66666666-6666-6666-6666-666666666666', 'C:\\a\\first.txt'));
assert(!fs.existsSync(store.manifestPath() + '.bak'),
  'no backup after the FIRST write - there was nothing to back up');
store.addManifestEntry(entry('77777777-7777-7777-7777-777777777777', 'C:\\a\\second.txt'));
const bak = store.manifestPath() + '.bak';
const bakExists = fs.existsSync(bak);
assert(bakExists, 'the second write leaves manifest.json.bak');
// Read it only if it is there. An assertion that FAILS must not then throw and
// take the whole suite down before it prints a Result line - a crashed suite is
// reported as "NOT RUN", which reads as a skip rather than as a failure.
let backedCount = null;
if (bakExists) {
  try { backedCount = (JSON.parse(fs.readFileSync(bak, 'utf8')).entries || []).length; }
  catch (e) { backedCount = 'unreadable: ' + e.message; }
}
assert(backedCount === 1,
  'and it holds the PREVIOUS state, so a bad write is recoverable by hand',
  String(backedCount));

for (const p of dirs) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
