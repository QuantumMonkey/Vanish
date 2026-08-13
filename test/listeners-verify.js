// Listener panel regression suite (ddx).
//
// WHY THIS EXISTS: this feature came out of a wrong answer, and the thing that
// made it wrong was not a missing datum - it was a framing. Asked about rpdsvc,
// I said "all loopback, nothing leaving the machine". That was true. It was
// also listening on 0.0.0.0:20121 as LocalSystem, belonging to software the
// operator does not use. "Who is this talking to" and "who can start a
// conversation with this" are different questions and Vanish answered only the
// reassuring one.
//
// So the assertions here are mostly about WORDING AND FRAMING, which is unusual
// for a test suite and is the point. The data was never the hard part.
//
//   1. No score, no rank, no "dangerous" (Rule 6). Being reachable is not the
//      same as being unsafe and we cannot tell the difference from here.
//   2. Signature and exposure appear TOGETHER. Only the signature is
//      reassurance theatre; only the exposure is scaremongering.
//   3. Signed means AUTHENTIC, not SAFE, and the UI has to say so somewhere a
//      user can find it.
//   4. Loopback-only is visually distinct from all-interfaces.
//   5. Plain language leads; netstat syntax is evidence beside it, not instead.
//
//   npx electron test/listeners-verify.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}`); fail += 1; }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 3000));

  console.log('');
  console.log('Vanish listener panel verification (ddx)');
  console.log('=======================================');

  // The stub's default payload is the rpdsvc shape plus a loopback-only
  // program, so the two cases that must never look alike are both present.
  const view = await win.webContents.executeJavaScript(`(async () => {
    const res = await window.api.getListeners();
    renderListeners(res);
    const body = document.getElementById('audit-listeners-body');
    const rows = [...body.querySelectorAll('.listener-row')];
    const pick = (name) => rows.find((r) => r.querySelector('.listener-name').textContent === name);
    const shape = (r) => r ? {
      cls: r.className,
      exposure: r.querySelector('.listener-exposure').textContent.trim(),
      detail: r.querySelector('.listener-detail').textContent.trim(),
      endpoints: r.querySelector('.listener-endpoints').textContent.replace(/\\s+/g, ' ').trim(),
      facts: [...r.querySelectorAll('.listener-facts span')].map((s) => s.textContent.trim()),
      sig: r.querySelector('.listener-sig') ? r.querySelector('.listener-sig').textContent.trim() : null,
      sigTitle: r.querySelector('.listener-sig') ? (r.querySelector('.listener-sig').getAttribute('title') || '') : '',
    } : null;
    return {
      rowCount: rows.length,
      exposed: shape(pick('rpdsvc')),
      local: shape(pick('localthing')),
      badge: document.getElementById('audit-listeners-badge').textContent.trim(),
      bodyText: body.textContent,
      noteText: document.getElementById('audit-listeners-note').textContent,
      sectionText: document.getElementById('audit-listeners-section').textContent,
    };
  })()`);

  assert(view.rowCount === 2, `both fixture programs rendered (${view.rowCount})`);

  // --- 1. No scoring, no verdicts ------------------------------------------
  console.log('');
  console.log('It states what is reachable and refuses to rate it');

  // Scoped to the ROWS, not the whole section. The explanatory note contains
  // the word "unsafe" on purpose - "Being reachable is not the same as being
  // unsafe" - and an earlier version of this assertion failed on it, which is
  // the same mistake the feature exists to avoid: matching a word without its
  // context. A verdict in a row is the problem; a denial in the note is not.
  assert(!/\b(dangerous|unsafe|malicious|threat|vulnerable|insecure)\b/i.test(view.bodyText),
    'no verdict words in any program row');
  assert(!/\b(risk score|score:|rating|severity)\b/i.test(view.sectionText),
    'no score, rating or severity is introduced');
  assert(/not the same as being unsafe/i.test(view.noteText),
    'the panel says outright that reachable is not the same as unsafe');

  // --- 2 and 3. Signature and exposure, together and honestly --------------
  console.log('');
  console.log('Signature and exposure are shown together, and signed != safe');

  assert(view.exposed && /Reachable from your network/i.test(view.exposed.exposure),
    'the externally-bound program says it is reachable from the network');
  assert(view.exposed && /RealNetworks/i.test(view.exposed.sig || ''),
    'the SAME row carries the signature, rather than one replacing the other');
  assert(view.exposed && /EV/.test(view.exposed.sig || ''),
    'an EV certificate is surfaced');
  assert(/does not mean it is safe|not that it is safe/i.test(view.exposed.sigTitle + view.noteText),
    'somewhere findable, it says a signature means authentic and not safe');

  // --- LocalSystem is a fact, never a verdict ------------------------------
  assert(view.exposed && view.exposed.facts.some((f) => /LocalSystem/i.test(f)),
    'running as LocalSystem is stated');
  assert(!/LocalSystem[^.]{0,40}(danger|risk|unsafe|suspicious)/i.test(view.sectionText),
    'LocalSystem is never editorialised into a warning');

  // --- 4. The two exposure classes must not look alike ---------------------
  console.log('');
  console.log('Loopback-only is distinct from all-interfaces');

  assert(view.local && /This PC only/i.test(view.local.exposure),
    'the loopback program says it is reachable only from this PC');
  assert(view.exposed.cls !== view.local.cls,
    `the two rows carry different classes (${view.exposed.cls} vs ${view.local.cls})`);
  assert(/is-exposed/.test(view.exposed.cls) && /is-local/.test(view.local.cls),
    'the classes are the intended ones');
  // Again scoped to the CLAIM rather than a keyword: the loopback copy does say
  // "network", in the sentence "Nothing on your network can reach it", which is
  // the exact reassurance it is supposed to give.
  assert(/Only programs already running on this PC/i.test(view.local.detail),
    'the loopback row states the limit positively');
  assert(!/can try to open a connection/i.test(view.local.detail),
    'the loopback row does NOT carry the externally-reachable claim');

  // --- 5. Plain language leads, evidence follows ---------------------------
  console.log('');
  console.log('Plain language leads and the socket is the evidence beside it');

  assert(/Anything that can reach this PC/i.test(view.exposed.detail),
    'the claim is made in plain language');
  assert(/0\.0\.0\.0:20121/.test(view.exposed.endpoints),
    'the actual socket is shown as evidence');
  assert(view.exposed.detail.indexOf('0.0.0.0') === -1,
    'the plain-language line does not just restate netstat syntax');

  // --- The badge counts the thing that matters -----------------------------
  assert(/1 reachable from your network/i.test(view.badge),
    `the badge counts externally-reachable programs, not every listener (${view.badge})`);

  // --- Read-only -----------------------------------------------------------
  console.log('');
  console.log('The panel is read-only');

  const controls = await win.webContents.executeJavaScript(
    `document.querySelectorAll('#audit-listeners-body button, #audit-listeners-body input').length`
  );
  assert(controls === 0, `no actionable controls in the panel (${controls} found)`);
  assert(/Read-only/i.test(view.noteText), 'and it says so');

  // --- The engine contract it depends on -----------------------------------
  console.log('');
  console.log('The engine classifies bind addresses rather than passing them through');

  const scanner = fs.readFileSync(path.join(__dirname, '..', 'scanner.ps1'), 'latin1');
  assert(/\$class = "specific"/.test(scanner) && /\$class = "all"/.test(scanner) && /\$class = "loopback"/.test(scanner),
    'three bind classes exist in the engine');
  assert(/if \(\$addr -eq "0\.0\.0\.0" -or \$addr -eq "::"/.test(scanner),
    'both IPv4 and IPv6 wildcard binds count as all-interfaces');
  assert(/\$addr -like "127\.\*"/.test(scanner),
    'the whole 127/8 range counts as loopback, not just 127.0.0.1');
  assert(/Win32_Service\.PathName is readable without/.test(scanner),
    'the service-path fallback is documented, so a SYSTEM service can still be signature-checked in Audit Mode');

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
