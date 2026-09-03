// s4cx: program icons, and the parser that decides which paths are even tried.
//
//   npx electron test/icon-extract-verify.js
//
// WHY THE PARSER IS THE SUBJECT. The first version of this feature shipped a
// path check written as /^[A-Za-z]:[\/]/ that reached the working tree as
// /^[A-Za-z]:[\/]/ - a character class matching only a forward slash. Every
// Windows path was rejected, get-app-icon returned null for all 87 icons on
// the machine, and NOTHING FAILED. A feature that answers null for everything
// still satisfies every assertion about answering null safely.
//
// So these assertions are the other half: what must be ACCEPTED, not only what
// must be refused. It runs in either tier - reading an icon out of a file is
// not a privileged operation.

const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';
require('../main.js');

let pass = 0;
let fail = 0;
function assert(condition, label, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); fail += 1; }
}
function skip(label, whyNot) { console.log(`  SKIP  ${label} -- ${whyNot}`); }

async function invoke(channel, payload) {
  const h = ipcMain._invokeHandlers.get(channel);
  if (!h) throw new Error(`no handler registered for ${channel}`);
  return h({ sender: null }, payload);
}

const B = String.fromCharCode(92);

app.whenReady().then(async () => {
  console.log('');
  console.log('Program icons (s4cx)');
  console.log('====================');

  console.log('');
  console.log('Paths that must be ACCEPTED - the half the first version got wrong');

  // A real Windows binary that every machine has, in the three DisplayIcon
  // shapes the registry actually contains.
  const shell32 = 'C:' + B + 'Windows' + B + 'System32' + B + 'shell32.dll';
  if (!fs.existsSync(shell32)) {
    skip('the accepted-path assertions', 'System32\shell32.dll is not present on this machine');
  } else {
    const bare = await invoke('get-app-icon', { source: shell32 });
    assert(bare && bare.dataUrl,
      'a bare absolute path with backslashes produces an icon (this is the assertion the [\/] bug failed)');

    const indexed = await invoke('get-app-icon', { source: shell32 + ',3' });
    assert(indexed && indexed.dataUrl,
      'and so does one with a resource index, which is the commonest DisplayIcon shape');

    const quoted = await invoke('get-app-icon', { source: '"' + shell32 + '",3' });
    assert(quoted && quoted.dataUrl,
      'and a quoted path with an index, which is what installers write when the path has spaces');

    const forward = await invoke('get-app-icon', { source: shell32.split(B).join('/') });
    assert(forward && forward.dataUrl,
      'a forward-slash path works too rather than being refused on style');

    assert(typeof bare.dataUrl === 'string' && bare.dataUrl.indexOf('data:image/') === 0,
      'the answer is a data URI the renderer can put straight in an <img>');
  }

  console.log('');
  console.log('Paths that must be REFUSED, and refused silently');

  const refused = [
    { source: null, why: 'no source at all' },
    { source: '', why: 'an empty string' },
    { source: '   ', why: 'whitespace' },
    { source: 'notapath', why: 'a bare word' },
    { source: 'app.exe', why: 'a relative path, which would resolve against the main process cwd' },
    { source: B + B + 'server' + B + 'share' + B + 'x.exe', why: 'a UNC path, which would put an icon fetch on the network (INV-4)' },
    { source: 'C:' + B + 'nope' + B + 'missing.exe,0', why: 'an absolute path to something that is not there' }
  ];
  for (const c of refused) {
    const r = await invoke('get-app-icon', { source: c.source });
    assert(r && r.success === true && r.dataUrl === null,
      `refused with no icon and NO error: ${c.why}`,
      `got ${JSON.stringify(r)}`);
  }

  console.log('');
  console.log('The engine already carries what this needs');
  {
    const list = await invoke('get-desktop-apps');
    const apps = Array.isArray(list) ? list : (list.applications || list.apps || []);
    if (!apps.length) {
      skip('the real-list assertions', 'the engine returned no desktop entries on this machine');
    } else {
      const withIcon = apps.filter((a) => a && a.icon);
      assert(apps.length > 0, `the engine returned ${apps.length} desktop entries`);
      assert(withIcon.length > 0,
        `${withIcon.length} of ${apps.length} carry a DisplayIcon path - this is the data that was collected and discarded for six releases`);

      // Not a count assertion: how many extract is a fact about this machine.
      // That SOME do is a fact about the feature.
      let got = 0;
      for (const a of withIcon.slice(0, 12)) {
        const r = await invoke('get-app-icon', { source: a.icon });
        if (r && r.dataUrl) got += 1;
      }
      assert(got > 0,
        `at least one real installed program produced an icon (${got} of the first 12 tried)`);
    }
  }

  console.log('');
  console.log('The renderer keeps its fallback');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'core.js'), 'utf8');
    assert(/data-icon-source/.test(src),
      'the row carries the icon source so a lazy loader can find it');
    assert(/IntersectionObserver/.test(src),
      'and icons are fetched by an observer rather than for every row - measured 51 ms each, so all 87 up front would be 4.4 s of first paint');
    assert(/if \(!res \|\| !res\.dataUrl\) return;/.test(src),
      'a null answer returns without touching the tile, so the letter stays');
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.log(`  FAIL  threw: ${(err && err.stack) || err}`);
  console.log('');
  console.log(`Result: ${pass} passed, ${fail + 1} failed`);
  app.exit(1);
});
