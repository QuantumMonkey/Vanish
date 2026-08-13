// Details-panel layout regression suite (5z5).
//
// WHY THIS EXISTS, and it is worth reading before adding a third panel:
//
// The same layout defect has now been reported twice, on two different panels,
// and fixed twice. The first time (ri6) a session diagnosed it exactly, fixed
// the All Programs sidebar, and left Task Manager's pane alone with a CSS
// comment saying so - "scoped to the All Programs sidebar specifically, since
// that is what was reported". The operator then reported Task Manager. A fix
// whose comment names the sibling it skipped is a bug filed in prose instead of
// in bd, and it is what makes a project look like it repeats itself.
//
// So this suite does not test a panel. It tests the RULE, against every panel
// that claims to follow it, at several window widths:
//
//   1. An inactive details panel occupies no width at all.
//   2. An active one never makes its sibling table overflow. The table has to
//      fit inside the container's content box - not merely exist, and not
//      merely be "present and sized", which is what the measurements said last
//      time while the screenshot showed a column clipped mid-word.
//   3. No column header renders truncated.
//
// Point 2 is the one that was got wrong. min-width:0 on the flex child was
// applied and did not fix it, because the container was never the problem: at
// 1110x741 with a row selected the container correctly shrank to 544px and the
// table stayed at its 602px min-content, overflowing into a horizontal scroller
// nobody notices. The Indicators column was clipped at the container edge -
// which sits exactly where the details pane begins, so it reads as the pane
// painting over the table. Hence assertions on scrollWidth and on header
// truncation, not on "is the element there".
//
//   npx electron test/details-panel-layout-verify.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The two panels under test, and the table each one must not crowd out.
// Adding a third details panel to the app means adding a row here; that is the
// whole point of the file.
const PANELS = [
  {
    label: 'Task Manager process pane',
    panel: '#process-details',
    container: '.process-list-container',
    table: '.process-table',
    screen: '#process-panel',
    // This table really does end in an indicator-chip column; All Programs
    // ends in Size. Seeding both the same way put a chip in a 58px Size cell
    // and overflowed it, which is a fixture artifact rather than a defect. A
    // fixture that does not match each table's actual shape reports faults the
    // app cannot have, and those cost as much time as the real ones.
    chipsInLastColumn: true,
  },
  {
    label: 'All Programs sidebar',
    panel: '#details-sidebar',
    container: '.apps-list-container',
    table: '#all-apps-table',
    screen: null, // the default screen
    chipsInLastColumn: false,
  },
];

// Widths worth checking. 1110x741 is the operator's own reported window, which
// is where the bug was visible and where the convenient default (1280) was not.
const WIDTHS = [1110, 1000, 1280, 1440];

// Pathological but real content: a process name is a filename, so it has no
// spaces to wrap at and cannot give ground the way prose can. That property is
// exactly what set the table's 602px floor, so the fixture has to have it.
const SEED = `(sel) => {
  const LONG = 'SomeVeryLongProcessNameThatWillNotWrap';
  document.querySelectorAll('.content-area').forEach((el) => { el.style.display = 'none'; });
  const screen = sel.screen ? document.querySelector(sel.screen) : document.querySelector('.content-area');
  if (!screen) return { ok: false, why: 'screen not found' };
  screen.style.display = '';
  const table = document.querySelector(sel.table);
  if (!table) return { ok: false, why: 'table not found' };
  const body = table.querySelector('tbody');
  const cols = table.querySelectorAll('thead th').length;
  body.innerHTML = '';
  for (let i = 0; i < 25; i += 1) {
    const tr = document.createElement('tr');
    tr.className = 'app-row';
    let html = '';
    for (let c = 0; c < cols; c += 1) {
      const chip = sel.chipsInLastColumn && c === cols - 1;
      html += c === 0
        ? '<td title="' + LONG + i + '.exe">' + LONG + i + '.exe</td>'
        : '<td>' + (chip ? '<span class="indicator-chip">Autostart</span>' : '412 MB') + '</td>';
    }
    tr.innerHTML = html;
    body.appendChild(tr);
  }
  return { ok: true };
}`;

const MEASURE = `(sel) => {
  const panel = document.querySelector(sel.panel);
  const container = document.querySelector(sel.container);
  const table = document.querySelector(sel.table);
  if (!panel || !container || !table) return { ok: false };
  const pr = panel.getBoundingClientRect();
  const tr = table.getBoundingClientRect();
  const clipped = [...table.querySelectorAll('thead th')]
    .filter((th) => th.scrollWidth > th.clientWidth + 1)
    .map((th) => th.textContent.trim());
  return {
    ok: true,
    panelWidth: Math.round(pr.width),
    containerClient: container.clientWidth,
    containerScroll: container.scrollWidth,
    tableWidth: Math.round(tr.width),
    clipped,
  };
}`;

async function measure(win, sel) {
  return win.webContents.executeJavaScript(`(${MEASURE})(${JSON.stringify(sel)})`);
}

async function setActive(win, sel, on) {
  await win.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(sel.panel)}).classList.${on ? 'add' : 'remove'}('active')`
  );
  await wait(450); // the panel animates its width; measure after it settles
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1110, height: 741, show: false, frame: false, backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'fixtures', 'stub-preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await wait(3000);

  console.log('');
  console.log('Vanish details-panel layout verification (5z5)');
  console.log('==============================================');

  for (const sel of PANELS) {
    console.log('');
    console.log(sel.label);

    for (const width of WIDTHS) {
      win.setContentSize(width, 741);
      await wait(250);

      const seeded = await win.webContents.executeJavaScript(`(${SEED})(${JSON.stringify(sel)})`);
      if (!seeded.ok) {
        assert(false, `${width}px - could not seed the table (${seeded.why})`);
        continue;
      }
      await wait(150);

      // --- inactive: the panel must cost the layout nothing -----------------
      await setActive(win, sel, false);
      const off = await measure(win, sel);
      assert(off.ok && off.panelWidth === 0,
        `${width}px inactive - panel claims 0px of the workspace (was ${off.panelWidth}px)`);

      // --- active: the table must fit beside it, not under it ---------------
      await setActive(win, sel, true);
      const on = await measure(win, sel);
      if (!on.ok) {
        assert(false, `${width}px active - could not measure`);
        continue;
      }
      assert(on.panelWidth > 0, `${width}px active - panel actually takes space (${on.panelWidth}px)`);
      assert(on.tableWidth <= on.containerClient + 1,
        `${width}px active - table fits its container (table ${on.tableWidth}px, container ${on.containerClient}px)`);
      // The 2px allowance is a measured rounding artifact, not slack for a real
      // overflow. At 1000px the All Programs container's border box is 422.x
      // wide, so clientWidth rounds DOWN to 416 while scrollWidth rounds UP to
      // 418 - with the table itself measured at 408 and the widest row at 408,
      // i.e. nothing actually overflowing. The defect this assertion exists to
      // catch was 58px wide, so 2px cannot hide one.
      assert(on.containerScroll <= on.containerClient + 2,
        `${width}px active - container does not scroll horizontally (scroll ${on.containerScroll}px, client ${on.containerClient}px)`);
      assert(on.clipped.length === 0,
        `${width}px active - no column header is truncated${on.clipped.length ? ` (${on.clipped.join(', ')})` : ''}`);

      await setActive(win, sel, false);
    }
  }

  // --- The GPU cell is one reading, not two ---------------------------------
  //
  // gpuCellHtml puts the adapter icon in FRONT of the percentage - "12.1% on
  // the NVIDIA card" is a single fact, and an icon rather than the vendor's
  // name because a spelled-out "NVIDIA" wraps and makes every row taller for a
  // word the icon's colour already carries. That only holds if the column is
  // wide enough for both, which is a layout property and belongs here: at 10%
  // the icon and the number rendered on separate lines.
  console.log('');
  console.log('Task Manager GPU cell keeps its adapter icon beside the figure');

  for (const width of WIDTHS) {
    win.setContentSize(width, 741);
    await wait(250);
    await win.webContents.executeJavaScript(`(${SEED})(${JSON.stringify(PANELS[0])})`);
    await win.webContents.executeJavaScript(`(() => {
      const marks = [
        '<i class="fa-solid fa-nvidia gpu-row-mark is-nvidia" title="NVIDIA GeForce RTX 4060"></i>12.1%',
        '<i class="fa-solid fa-amd gpu-row-mark is-amd" title="AMD Radeon Graphics"></i>3.4%',
        '<i class="fa-solid fa-microchip gpu-row-mark" title="GPU 2"></i>0.8%',
        '<i class="fa-solid fa-nvidia gpu-row-mark is-nvidia" title="NVIDIA GeForce RTX 4060"></i>44.6%<sup>+1</sup>'
      ];
      [...document.querySelectorAll('#process-tbody tr')].forEach((tr, i) => {
        if (tr.children[3]) tr.children[3].innerHTML = marks[i % marks.length];
      });
      return true;
    })()`);
    await setActive(win, PANELS[0], true);
    await wait(200);

    const gpu = await win.webContents.executeJavaScript(`(() => {
      const cells = [...document.querySelectorAll('#process-tbody tr td:nth-child(4)')];
      const cpu = document.querySelector('#process-tbody tr td:nth-child(3)');
      return {
        count: cells.length,
        clipped: cells.filter((td) => td.scrollWidth > td.clientWidth + 1).length,
        taller: cells.filter((td) => td.getBoundingClientRect().height > cpu.getBoundingClientRect().height + 1).length,
        iconFirst: cells.every((td) => td.firstElementChild && td.firstElementChild.tagName === 'I'),
      };
    })()`);

    assert(gpu.count > 0 && gpu.iconFirst,
      `${width}px - the adapter icon renders BEFORE the figure, not after it`);
    assert(gpu.taller === 0,
      `${width}px - the icon and the figure share one line (${gpu.taller} cell(s) wrapped)`);
    assert(gpu.clipped === 0,
      `${width}px - nothing in the GPU cell is clipped (${gpu.clipped} cell(s) overflowing)`);

    await setActive(win, PANELS[0], false);
  }

  console.log('');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  app.exit(fail === 0 ? 0 : 1);
});
