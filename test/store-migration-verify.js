// SEC-3 verify: Vanish state lives in its own subdirectory, and an existing
// install is migrated into it exactly once without losing a vault payload.
//
//   node test/store-migration-verify.js
//
// Why this matters: state used to sit directly in the Electron userData root,
// which is also Chromium's profile directory. Locking that directory against a
// standard user is what stops manifest.json being rewritten as elevated
// instructions - but it is also what would stop Chromium writing Preferences
// and Cache in Audit Mode. The state had to move somewhere only Vanish writes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function freshRoot(tag) {
  const dir = path.join(os.tmpdir(), `vanish-store-migration-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The module caches dataRoot in a closure, so each scenario needs a clean load.
function loadStore() {
  delete require.cache[require.resolve('../lib/store')];
  return require('../lib/store');
}

console.log('');
console.log('Vanish store migration verification (SEC-3)');
console.log('==========================================');

// --- 1. A fresh install puts nothing in the Chromium profile root -----------
console.log('');
console.log('Fresh install');
{
  const userData = freshRoot('fresh');
  const store = loadStore();
  store.init(userData);

  assert(
    store.dataDir() === path.join(userData, 'vanish-state'),
    'state directory is a subdirectory of userData, not userData itself'
  );
  assert(
    fs.existsSync(path.join(userData, 'vanish-state', 'vault')),
    'the vault is created inside the state directory'
  );

  store.writeSettings({ autoPurgeRetentionDays: 7 });
  store.appendOplog({ action: 'test', tier: 'audit', outcome: 'success' });

  assert(
    fs.existsSync(path.join(userData, 'vanish-state', 'settings.json')),
    'settings.json is written inside the state directory'
  );
  assert(
    !fs.existsSync(path.join(userData, 'settings.json')),
    'nothing is written to the Chromium profile root'
  );
}

// --- 2. An existing install is migrated, payload intact ---------------------
console.log('');
console.log('Migration of an existing install');
{
  const userData = freshRoot('legacy');

  // Lay down a v0.3.0 layout: state directly in the userData root.
  const legacyVault = path.join(userData, 'vault');
  const entryId = '11111111-2222-4333-8444-555555555555';
  fs.mkdirSync(path.join(legacyVault, entryId), { recursive: true });
  fs.writeFileSync(path.join(legacyVault, entryId, 'payload.bin'), 'quarantined bytes', 'utf8');
  fs.writeFileSync(
    path.join(legacyVault, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, entries: [{ id: entryId, status: 'quarantined', sourceApp: 'Legacy App', files: [], registry: [] }] }),
    'utf8'
  );
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ autoPurgeRetentionDays: 99 }), 'utf8');
  fs.writeFileSync(path.join(userData, 'queue.json'), JSON.stringify({ schemaVersion: 1, items: [] }), 'utf8');
  fs.writeFileSync(path.join(userData, 'oplog.jsonl'), '{"action":"legacy"}\n', 'utf8');

  const store = loadStore();
  store.init(userData);

  const stateDir = path.join(userData, 'vanish-state');
  assert(fs.existsSync(path.join(stateDir, 'vault', 'manifest.json')), 'the manifest moved into the state directory');
  assert(
    fs.readFileSync(path.join(stateDir, 'vault', entryId, 'payload.bin'), 'utf8') === 'quarantined bytes',
    'the quarantined payload survived the move byte for byte'
  );
  assert(fs.existsSync(path.join(stateDir, 'oplog.jsonl')), 'the operation log moved');
  assert(!fs.existsSync(path.join(userData, 'vault')), 'the legacy vault is gone from the profile root');

  const manifest = store.readManifest();
  assert(manifest.entries.length === 1 && manifest.entries[0].id === entryId, 'the migrated manifest still reads back');
  assert(store.readSettings().autoPurgeRetentionDays === 99, 'migrated settings are still honoured');
}

// --- 3. Migration is idempotent and never clobbers ------------------------
console.log('');
console.log('Re-running migration');
{
  const userData = freshRoot('idempotent');
  const stateDir = path.join(userData, 'vanish-state');

  // Current state already exists...
  fs.mkdirSync(path.join(stateDir, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ autoPurgeRetentionDays: 5 }), 'utf8');
  // ...and a stale legacy file is still lying around next to it.
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ autoPurgeRetentionDays: 999 }), 'utf8');

  const store = loadStore();
  store.init(userData);

  assert(
    store.readSettings().autoPurgeRetentionDays === 5,
    'an already-migrated file is never overwritten by the stale legacy copy'
  );
  assert(
    fs.existsSync(path.join(userData, 'settings.json')),
    'the un-migrated legacy file is left in place rather than deleted'
  );
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
