// TASK-11 Verify: the bulk uninstall queue state machine (FLOW-05, NFR-05).
//
// lib/queue.js takes its engine runner by injection, so every branch of the
// state machine can be driven deterministically here without uninstalling
// anything real. The end-to-end M4 scenario (five real apps) is reserved for
// the TASK-17 VM pass, per the implementation plan.
//
//   node test/queue-verify.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const queue = require('../lib/queue');

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

// --- fake engine ----------------------------------------------------------
// Scripted per app name so each FLOW-05 branch is reachable.
const scripted = {
  CleanApp: { exitCode: 0, timedOut: false, interactive: false },
  RebootApp: { exitCode: 3010, timedOut: false, interactive: false },
  RebootApp1641: { exitCode: 1641, timedOut: false, interactive: false },
  FailApp: { exitCode: 1603, timedOut: false, interactive: false },
  StubbornApp: { exitCode: null, timedOut: true, interactive: true },
  CorrectionsApp: { exitCode: 0, timedOut: false, interactive: false }
};

const calls = [];
let msiserverStartMode = 'Disabled';

async function fakeRunner(action, params = {}) {
  calls.push({ action, params });

  if (action === 'restore-point') {
    return { success: true, frequencyOverridden: true };
  }
  if (action === 'msiserver-state') {
    return {
      success: true,
      startMode: msiserverStartMode,
      state: 'Stopped',
      usable: msiserverStartMode !== 'Disabled'
    };
  }
  if (action === 'msiserver-set') {
    msiserverStartMode = params.startMode;
    return { success: true, startMode: msiserverStartMode, state: 'Stopped', usable: true };
  }
  if (action === 'resolve-uninstall-args') {
    const isCorrection = params.displayName === 'CorrectionsApp';
    return {
      success: true,
      method: isCorrection ? 'corrections' : 'heuristic',
      matchedName: isCorrection ? 'CorrectionsApp' : null,
      detectedType: 'nsis',
      executable: 'C:\\fake\\uninstall.exe',
      baseArgs: '',
      arguments: '/S',
      candidates: ['/S']
    };
  }
  if (action === 'run-uninstaller') {
    const name = calls
      .slice()
      .reverse()
      .find((c) => c.action === 'resolve-uninstall-args').params.displayName;
    return { success: true, ...scripted[name], durationMs: 1234, commandLine: 'fake' };
  }
  throw new Error(`Unexpected engine action in test: ${action}`);
}

// --- setup ----------------------------------------------------------------
const dataDir = path.join(os.tmpdir(), `vanish-queue-verify-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

store.init(dataDir);

const broadcasts = [];
queue.init(fakeRunner, (state) => broadcasts.push(state));

function app(name) {
  return {
    name,
    registryPath: `HKLM:\\Software\\Fake\\${name}`,
    publisher: 'Test Publisher',
    uninstallString: 'C:\\fake\\uninstall.exe',
    type: 'Desktop'
  };
}

function itemFor(name) {
  return store.readQueue().items.find((i) => i.displayName === name);
}

(async () => {
  console.log('');
  console.log('Vanish bulk uninstall queue verification');
  console.log('========================================');

  console.log('');
  console.log('Queue building (ENT-04)');
  queue.add(app('CleanApp'));
  queue.add(app('CorrectionsApp'));
  queue.add(app('FailApp'));
  queue.add(app('StubbornApp'));
  queue.add(app('RebootApp'));

  const dup = queue.add(app('CleanApp'));
  assert(dup.success === false, 'the same application cannot be queued twice while pending');

  let state = queue.getState();
  assert(state.items.length === 5, '5 items queued');
  assert(state.items.every((i) => i.state === 'pending'), 'every new item starts pending');
  assert(state.items.every((i) => typeof i.id === 'string' && i.id.includes('-')), 'items carry UUID identity (schema rule 4)');
  assert(fs.existsSync(path.join(dataDir, 'queue.json')), 'queue.json persisted to disk on build');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'queue.json'), 'utf8'));
  assert(persisted.schemaVersion === 1, 'queue.json carries schemaVersion');

  console.log('');
  console.log('REQ-12 installer service pre-flight');
  assert(msiserverStartMode === 'Disabled', 'msiserver starts the run disabled');

  console.log('');
  console.log('FLOW-05 run (REQ-10, REQ-13)');
  await queue.start();

  assert(
    calls.filter((c) => c.action === 'msiserver-set' && c.params.startMode === 'Manual').length === 1,
    'a disabled msiserver was enabled before the run (REQ-12)'
  );
  assert(msiserverStartMode === 'Disabled', 'msiserver was restored to its prior state after the run (REQ-12)');

  assert(
    calls.filter((c) => c.action === 'restore-point').length >= 4,
    'every app that ran got its own restore point call (REQ-13)'
  );
  assert(
    calls.some((c) => c.action === 'restore-point' && /CleanApp/.test(c.params.description)),
    'restore points are labelled per application'
  );

  console.log('');
  console.log('State machine transitions');
  assert(itemFor('CleanApp').state === 'done', 'exit 0 -> done');
  assert(itemFor('CleanApp').exitCode === 0, 'exit code recorded');
  assert(itemFor('FailApp').state === 'failed', 'nonzero exit -> failed');
  assert(itemFor('FailApp').exitCode === 1603, 'failing exit code recorded for diagnosis');
  assert(itemFor('StubbornApp').state === 'needsAttention', 'a non-silent uninstaller -> needs attention, queue continues');
  assert(itemFor('RebootApp').state === 'rebootRequired', 'exit 3010 -> reboot required');

  console.log('');
  console.log('Rule 15 method logging (REQ-10)');
  assert(itemFor('CorrectionsApp').method === 'corrections', 'corrections method logged per app');
  assert(itemFor('CleanApp').method === 'heuristic', 'heuristic method logged per app');

  console.log('');
  console.log('Reboot pause branch');
  assert(queue.getState().paused === true, 'the queue paused itself on reboot-required');
  assert(queue.getState().running === false, 'the runner stopped');

  console.log('');
  console.log('NFR-05 resumability');
  // Simulate a crash: throw away the in-memory view, re-read from disk only.
  const reread = store.readQueue();
  assert(reread.items.length === 5, 'queue survived as an on-disk document');
  assert(reread.items.find((i) => i.displayName === 'CleanApp').state === 'done', 'completed state persisted');
  assert(reread.items.find((i) => i.displayName === 'RebootApp').state === 'rebootRequired', 'paused state persisted');

  queue.retry(itemFor('RebootApp').id);
  assert(itemFor('RebootApp').state === 'pending', 'rebootRequired -> pending on user resume');
  queue.retry(itemFor('FailApp').id);
  assert(itemFor('FailApp').state === 'pending', 'failed -> pending on user retry');

  console.log('');
  console.log('Queue hygiene');
  queue.clear();
  assert(store.readQueue().items.length === 0, 'clear empties the queue');

  // 1641 is the other reboot code and must behave identically. Run it on a
  // fresh queue: a queue that still held RebootApp would (correctly) pause on
  // that item first and never reach this one.
  console.log('');
  console.log('Second reboot exit code');
  queue.add(app('RebootApp1641'));
  await queue.start();
  assert(itemFor('RebootApp1641').state === 'rebootRequired', 'exit 1641 -> reboot required');
  assert(queue.getState().paused === true, 'exit 1641 also pauses the queue');
  queue.clear();

  console.log('');
  console.log('NFR-04 audit trail');
  const oplog = fs
    .readFileSync(path.join(dataDir, 'oplog.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert(oplog.some((l) => l.action === 'queue-start'), 'queue start logged');
  assert(oplog.some((l) => l.action === 'queue-uninstall' && l.outcome === 'done'), 'per-app outcome logged');
  assert(
    oplog.some((l) => l.action === 'queue-uninstall' && l.meta && l.meta.method === 'corrections'),
    'per-app switch method logged (Rule 15)'
  );
  assert(oplog.some((l) => l.action === 'msiserver-restore'), 'msiserver restoration logged');

  console.log('');
  console.log('Live updates');
  assert(broadcasts.length > 10, `the panel received ${broadcasts.length} push updates, so it never has to poll`);

  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
