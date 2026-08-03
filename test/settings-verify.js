// Settings validation verify (ENT-02), focused on startupMode - the operator's
// "Start Vanish as administrator" toggle (2026-08-03).
//
//   node test/settings-verify.js
//
// Why this matters beyond the usual schema-rule-5 coverage: startupMode is
// read directly by main.js's app.whenReady() to decide whether to attempt a
// live elevation request before any window exists. An unvalidated or
// misread value there is not a cosmetic settings bug - it changes what
// happens at the very first moment the app runs.

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
  const dir = path.join(os.tmpdir(), `vanish-settings-verify-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadStore() {
  delete require.cache[require.resolve('../lib/store')];
  return require('../lib/store');
}

console.log('');
console.log('Vanish settings verification');
console.log('=============================');

console.log('');
console.log('Default value');
{
  const store = loadStore();
  store.init(freshRoot('default'));
  const settings = store.readSettings();
  assert(settings.startupMode === 'audit', 'a fresh install defaults to startupMode "audit" (safe by default)');
}

console.log('');
console.log('Round trip');
{
  const store = loadStore();
  store.init(freshRoot('roundtrip'));

  const written = store.writeSettings({ startupMode: 'full' });
  assert(written.startupMode === 'full', 'writeSettings accepts and returns "full"');

  const reread = store.readSettings();
  assert(reread.startupMode === 'full', 'the value persists across a fresh read');

  const backToAudit = store.writeSettings({ startupMode: 'audit' });
  assert(backToAudit.startupMode === 'audit', 'the operator can turn it back off');
}

console.log('');
console.log('Invalid values fall back rather than propagate (schema rule 5)');
{
  const store = loadStore();
  store.init(freshRoot('invalid'));

  const garbage = store.writeSettings({ startupMode: 'delete-everything' });
  assert(
    garbage.startupMode === 'audit',
    'an unrecognised startupMode falls back to "audit", the safe default - never crashes, never passes through'
  );

  const numeric = store.writeSettings({ startupMode: 1 });
  assert(numeric.startupMode === 'audit', 'a non-string startupMode also falls back to "audit"');

  const nulled = store.writeSettings({ startupMode: null });
  assert(nulled.startupMode === 'audit', 'a null startupMode falls back to "audit"');
}

console.log('');
console.log('Other settings are untouched by the new field (no cross-talk)');
{
  const store = loadStore();
  store.init(freshRoot('crosstalk'));

  store.writeSettings({ startupMode: 'full', autoPurgeRetentionDays: 45 });
  const settings = store.readSettings();
  assert(settings.startupMode === 'full', 'startupMode is set as requested');
  assert(settings.autoPurgeRetentionDays === 45, 'an unrelated setting written in the same call is unaffected');
  assert(settings.autoPurgeEnabled === false, 'an untouched setting keeps its default');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
