// Vanish renderer -- Health Advisor: startup, storage, network activity, GPU
//
// Includes kp0's manual-tap ping - the one deliberate exception to zero
// outbound network I/O, and the only place the app sends anything.
//
// Part of the renderer split out of a single 5,500-line renderer.js. These are
// CLASSIC SCRIPTS, not modules: top-level let/const/function share one global
// lexical environment across all of them, which is why this was a safe pure
// file split and why no imports or exports appear below. index.html loads them
// in the order listed there.

// ==========================================
// STAGE 2 - AUDIT & HEALTH ADVISOR UI
// ==========================================

let auditLoaded = false;
// The rows currently on screen, so a click resolves to the item the user was
// actually looking at rather than to whatever the DOM can be re-parsed into.
let startupItems = [];

// 5b0: the payload the startup table was last drawn from, so a column filter
// can re-render it without re-running getStartupItems() - that is a PowerShell
// round trip, and making a checkbox click cost a second and a half of it would
// be its own bug.
let lastStartupPayload = null;
let startupFilterUiWired = false;

// Source and Status only. Both are small closed sets, which is what makes a
// distinct-value checklist the right control; Command is free text with no
// repeated values, and Action is a column of buttons.
const STARTUP_COLUMN_FILTERS = ['startup.source', 'startup.status'];

// PROGRESSIVE LOAD. This panel used to Promise.all its six engine calls and
// show one full-panel spinner until the LAST one landed. Measured on the
// operator's machine 2026-08-28, per call:
//
//   get-startup-items      7413 ms      get-listeners            3456 ms
//   get-windows-updates    5293 ms      get-software-redundancy  1215 ms
//   get-network-activity   5019 ms      get-system-diagnostics   1019 ms
//
// So the machine overview - which is ready in one second - was held off screen
// for seven, waiting on a signature-checking walk of the startup list that has
// nothing to do with it. Health Advisor is the landing page now, which makes
// that the first thing anyone sees of Vanish.
//
// Each query renders its own section the moment it answers, and each failure is
// reported in the section it belongs to. A section that is still working says
// so IN PLACE; nothing is hidden behind a global spinner, and one dead query no
// longer blanks five healthy panels.
//
// The counter is not decoration. auditLoaded must mean "everything on screen is
// real" - switchTab uses it to decide whether returning to this tab needs a
// re-read - so it is only set once every section has settled, not on first
// paint.
function auditSectionPending(elementId, what) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = `
    <div class="audit-pending">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <span>${what}</span>
    </div>
  `;
}

function auditRowPending(tbodyId, colspan, what) {
  const el = document.getElementById(tbodyId);
  if (!el) return;
  el.innerHTML = `
    <tr><td colspan="${colspan}" class="audit-pending-cell">
      <i class="fa-solid fa-spinner fa-spin"></i> <span>${what}</span>
    </td></tr>
  `;
}

function auditRowFailed(tbodyId, colspan, what, message) {
  const el = document.getElementById(tbodyId);
  if (!el) return;
  el.innerHTML = `
    <tr><td colspan="${colspan}" class="audit-pending-cell failed">
      <i class="fa-solid fa-circle-xmark"></i> <span>Could not ${what}: ${message}</span>
    </td></tr>
  `;
}

function auditSectionFailed(elementId, what, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = `
    <div class="audit-pending failed">
      <i class="fa-solid fa-circle-xmark"></i>
      <span>Could not ${what}: ${message}</span>
    </div>
  `;
}

async function loadAuditData(force = false) {
  if (auditLoaded && !force) return;

  const loadingEl = document.getElementById('audit-loading');
  const contentEl = document.getElementById('audit-content');
  auditLoaded = false;

  // The frame the user actually gets: the panel, with every section labelled
  // and each one saying what it is doing. Not a spinner where the page is.
  loadingEl.style.display = 'none';
  contentEl.style.display = 'flex';

  auditSectionPending('audit-sysinfo-grid', 'reading this machine');
  auditSectionPending('audit-disk-list', 'reading your drives');
  // 847: not a pending section - it asks nothing of the system and has an
  // answer immediately, either a verdict from this session or an invitation.
  renderHygieneCard();
  auditSectionPending('audit-network-body', 'sampling the adapter');
  auditSectionPending('audit-listeners-body', 'checking what is listening');
  auditSectionPending('audit-updates-body', 'asking Windows Update');
  auditSectionPending('audit-redundancy-list', 'grouping installed programs');
  auditRowPending('audit-startup-tbody', 5, 'reading startup items and checking their signatures');

  // Each section owns its own query, its own render and its own failure. Named
  // rather than inlined so the list reads as what it is: six independent
  // questions about the machine that happen to share a screen.
  const sections = [
    {
      run: () => window.api.getSystemDiagnostics(),
      draw: (diag) => {
        renderSysInfoCards(diag);
        renderDiskBars(diag.disks || [], diag.disksError);
        // 90% is renderDiskBars' OWN danger threshold, reused rather than
        // re-decided. A second opinion about what "full" means, living in a
        // different function, is how two halves of one screen come to disagree.
        const full = (diag.disks || []).filter((d) => (d.pctUsed ?? 0) >= 90);
        auditReportWork(full.length, full.length === 1 ? 'drive almost full' : 'drives almost full');
        if (diag.disksError) auditReportBlind('your drives');
      },
      fail: (msg) => {
        auditSectionFailed('audit-sysinfo-grid', 'read this machine', msg);
        auditSectionFailed('audit-disk-list', 'read your drives', msg);
        auditReportBlind('this machine and its drives');
      }
    },
    {
      run: () => window.api.getNetworkActivity(),
      draw: (network) => renderNetworkActivity(network),
      // Never contributes work: a transfer rate is not a problem, and putting
      // one in the headline would make it read as one.
      fail: (msg) => { auditSectionFailed('audit-network-body', 'measure network activity', msg); auditReportBlind('network activity'); }
    },
    {
      run: () => window.api.getListeners(),
      draw: (listeners) => renderListeners(listeners),
      // Never contributes work. This panel refuses to rank reachability on
      // purpose, and counting listeners into a headline would rank them by
      // placement instead - the same claim made more loudly.
      fail: (msg) => { auditSectionFailed('audit-listeners-body', 'check what is listening', msg); auditReportBlind('what is listening'); }
    },
    {
      run: () => window.api.getWindowsUpdates(),
      draw: (updates) => renderWindowsUpdates(updates),
      // Never contributes work: updates are Windows' business and Vanish is
      // not entitled to nag about them. Shown for context, not as a task.
      fail: (msg) => { auditSectionFailed('audit-updates-body', 'ask Windows Update', msg); auditReportBlind('Windows Update'); }
    },
    {
      run: () => window.api.getSoftwareRedundancy(),
      draw: (redundancy) => {
        renderRedundancyGroups(redundancy);
        // The section already subtracts the groups you waived before badging
        // the rest as "still needs a look". Reusing that number rather than
        // counting groups again is what stops the headline from contradicting
        // the badge three inches below it.
        const groups = redundancy.groups || [];
        const waived = new Set(appSettings.redundancyWaivers || []);
        const active = groups.filter((g) => !waived.has(g.category)).length;
        auditReportWork(active, active === 1 ? 'group of overlapping programs' : 'groups of overlapping programs');
      },
      fail: (msg) => { auditSectionFailed('audit-redundancy-list', 'group installed programs', msg); auditReportBlind('overlapping programs'); }
    },
    {
      // Slowest by a wide margin, and deliberately last so it is started last.
      // Its placeholder is a table ROW, not a replacement for the wrapper:
      // renderStartupTable fills audit-startup-tbody and returns silently if
      // that element has gone, so overwriting the wrapper would leave this
      // section blank forever with no error raised anywhere.
      run: () => window.api.getStartupItems(),
      draw: (startup) => {
        renderStartupTable(startup);
        // Exactly the number already on the "N broken" pill. An orphaned entry
        // points at a program that is gone, which is a fact rather than a
        // severity judgement -- which is why this one qualifies as work and
        // the reachable-from-outside count does not.
        const orphans = startup.orphans ?? 0;
        auditReportWork(orphans, orphans === 1 ? 'broken startup entry' : 'broken startup entries');
      },
      fail: (msg) => { auditRowFailed('audit-startup-tbody', 5, 'read your startup items', msg); auditReportBlind('your startup items'); }
    }
  ];

  resetAuditTally(sections.length);
  renderAuditVerdict();

  const settled = sections.map((section) =>
    section
      .run()
      .then((data) => {
        try {
          section.draw(data);
        } catch (err) {
          // A render that throws is OUR bug, not the machine's, and saying
          // "could not read" about it would be a lie. Say which half broke.
          section.fail(`Vanish could not display this - ${err.message}`);
        }
      })
      .catch((err) => section.fail(err.message))
      // Settled means REPORTED, not succeeded. A section that failed has still
      // finished, and the verdict must not sit at "checking 5 of 6" forever
      // because one of them could not be read.
      .then(() => auditSectionSettled())
  );

  await Promise.all(settled);
  auditLoaded = true;
}

// Attach refresh button
document.addEventListener('DOMContentLoaded', () => {
  const btnRefresh = document.getElementById('btn-refresh-audit');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => loadAuditData(true));
  }
});

function renderSysInfoCards(diag) {
  const grid = document.getElementById('audit-sysinfo-grid');
  if (!grid || !diag) return;

  const uptimeStr = diag.os && diag.os.uptimeHours != null
    ? `${diag.os.uptimeHours}h uptime`
    : '';

  const ramPct  = diag.ram && diag.ram.pctUsed != null ? `${diag.ram.pctUsed}%` : '';
  const ramSub  = diag.ram ? `${diag.ram.usedGB ?? '?'} / ${diag.ram.totalGB ?? '?'} GB used` : '';

  const cpuClockGHz = diag.cpu && diag.cpu.maxClockMHz
    ? `${(diag.cpu.maxClockMHz / 1000).toFixed(2)} GHz`
    : '';
  const cpuSub = diag.cpu ? `${diag.cpu.cores ?? '?'} cores / ${diag.cpu.logicalCores ?? '?'} threads` : '';

  // A machine with switchable graphics has two adapters and both matter. The
  // engine has reported both since the last fix; this card was where the second
  // one disappeared, clipped by a single nowrap line with an ellipsis. Each
  // adapter gets its own line now.
  const gpus = Array.isArray(diag.gpus) && diag.gpus.length
    ? diag.gpus
    : (diag.gpu ? String(diag.gpu).split(' + ') : ['Unknown']);

  const cards = [
    { label: 'Operating System',  value: diag.os?.caption  ?? 'Unknown',    sub: `Build ${diag.os?.build ?? '?'} - ${diag.os?.architecture ?? ''}` },
    { label: 'System Uptime',     value: uptimeStr || 'Unknown',              sub: '' },
    { label: 'CPU',               value: shortenCpuName(diag.cpu?.name),      sub: `${cpuClockGHz} - ${cpuSub}` },
    { label: 'RAM Usage',         value: ramPct || 'Unknown',                 sub: ramSub },
    { label: gpus.length > 1 ? `Graphics (${gpus.length})` : 'Graphics', values: gpus, sub: '' },
    { label: 'Machine',           value: `${diag.manufacturer ?? ''} ${diag.model ?? ''}`.trim() || 'Unknown', sub: '' }
  ];

  // 949: the one-line summary that stands in for the six cards until someone
  // opens them. OS and machine model, because those are the two facts that
  // identify WHICH machine this is - the only question this section actually
  // answers, and the reason it is worth keeping at all.
  const line = document.getElementById('audit-machine-summary');
  if (line) {
    const os = diag.os?.caption ?? 'Unknown OS';
    const box = `${diag.manufacturer ?? ''} ${diag.model ?? ''}`.trim();
    line.textContent = box ? `${os} on ${box}` : os;
  }

  // Every value wraps, not just the graphics one: "AMD Ryzen 9 5900HX with Ra..."
  // and "ASUSTeK COMPUTER INC. RO..." were the same defect on the same row,
  // just less obviously wrong than a missing GPU.
  grid.innerHTML = cards.map(c => {
    const lines = (c.values || [c.value])
      .map((v) => `<span class="card-value wrap" title="${esc(v)}">${esc(v)}</span>`)
      .join('');
    return `
    <div class="audit-info-card">
      <span class="card-label">${esc(c.label)}</span>
      ${lines}
      ${c.sub ? `<span class="card-sub">${esc(c.sub)}</span>` : ''}
    </div>`;
  }).join('');
}

function shortenCpuName(name) {
  if (!name) return 'Unknown';
  // Collapse repeated whitespace and strip trailing processor brand noise
  return name.replace(/\s+/g, ' ').replace(/ CPU @.*$/, '').trim();
}

// bfh.1. The output of this section is a VERDICT, not a list of connections.
// hks. A bare connection count reads as a threat number: the operator's own
// words were "one program holding 54 open connections looks worrisome". For
// most of what actually holds dozens of sockets - a browser, a sync client, a
// game launcher - that count is just how the program works, and the useful
// thing to show is what is normal FOR THAT KIND of program.
//
// Deliberately context, never a verdict. This does not score risk, does not
// call anything safe, and does not call anything suspicious - Rule 6 keeps
// this panel out of security/firewall framing, and a "trusted process" list
// would be exactly that framing wearing a friendlier label. Matching is on
// the process name only, entirely local: no lookup, no reverse-DNS, no
// outbound I/O of any kind (INV-4).
const NET_PROGRAM_KINDS = [
  {
    kind: 'a web browser',
    test: /^(chrome|firefox|msedge|brave|opera|opera_gx|vivaldi|chromium|iexplore|arc|librewolf|waterfox|tor)$/,
    normal: 'Browsers open a separate connection per tab, per ad, per tracker and per background sync, so dozens at once is ordinary even when you are only reading one page.'
  },
  {
    kind: 'a file-sync program',
    test: /^(onedrive|dropbox|googledrivefs|googledrivesync|box|boxdrive|megasync|nextcloud|owncloud|icloud|pcloud|sync|resilio|syncthing)$/,
    normal: 'Sync clients keep several connections open at once so uploads, downloads and change-notifications do not queue behind each other.'
  },
  {
    kind: 'a game launcher or store',
    test: /^(steam|steamwebhelper|epicgameslauncher|epicwebhelper|battle\.net|agent|galaxyclient|galaxy|origin|eadesktop|easteamproxy|ubisoftconnect|upc|riotclient|riotclientservices|playnite)$/,
    normal: 'Launchers keep a store page, a friends/chat service, a download manager and an update checker connected at the same time, and content downloads often use many parallel connections on purpose.'
  },
  {
    kind: 'a chat or meeting program',
    test: /^(teams|ms-teams|slack|discord|zoom|skype|telegram|whatsapp|signal|element|webexmta|webex)$/,
    normal: 'Chat and meeting apps hold a live connection for messages plus separate ones for presence, media and file transfers.'
  },
  {
    kind: 'security software',
    test: /^(avp|avpui|kavfs|msmpeng|mpdefendercoreservice|nissrv|avgui|avgsvc|avastui|afwserv|mbam|mbamservice|nortonsecurity|ns|mcshield|masvc|sentinelagent|csfalconservice|csfalconcontainer|bdagent|vsserv|ekrn|egui)$/,
    normal: 'Security software checks files and pages against its vendor\'s cloud service, which means many short-lived connections while it is scanning.'
  },
  {
    kind: 'an updater or download service',
    test: /^(svchost|googleupdate|goog(le)?updater|msedgeupdate|microsoftedgeupdate|adobearmsvc|adobeupdateservice|squirrel|update|updater|wuauclt|usocoreworker|deliveryoptimization|dosvc)$/,
    normal: 'Update and delivery services fetch from several servers at once, and Windows itself shares parts of an update between machines, so the count moves around a lot.'
  },
  {
    kind: 'a developer tool',
    test: /^(code|code - insiders|node|npm|claude|python|pythonw|docker|dockerd|com\.docker\.backend|git|ssh|java|javaw|devenv|rider64|idea64|pycharm64|wsl|wslservice)$/,
    normal: 'Developer tools talk to package registries, language servers, containers and remote APIs at the same time, often several per project you have open.'
  },
  {
    kind: 'a media or streaming app',
    test: /^(spotify|itunes|applemusic|vlc|plex|plexmediaserver|netflix|obs64|obs|steamstreaming)$/,
    normal: 'Streaming apps hold a media connection plus separate ones for artwork, recommendations and playback reporting.'
  },
  {
    kind: 'part of Windows',
    test: /^(system|lsass|services|spoolsv|searchindexer|searchapp|explorer|taskhostw|backgroundtaskhost|runtimebroker|smartscreen|settingssynchost|wsappx|startmenuexperiencehost)$/,
    normal: 'Windows components fetch content, licences, time and telemetry-free service data on their own schedule, independent of anything you opened.'
  }
];

// The count at which a bare number starts reading as alarming rather than
// incidental. Below this the tooltip still explains the program, but nothing
// visible is added to the row - the number speaks for itself.
const NET_NOTABLE_CONNECTION_COUNT = 10;

function classifyNetProgram(name) {
  const key = String(name || '').toLowerCase().replace(/\.exe$/, '').trim();
  return NET_PROGRAM_KINDS.find((k) => k.test.test(key)) || null;
}

// The tooltip text for one row's connection count. Always says what was
// counted; adds the per-kind reassurance when the program is recognised, and
// says plainly that it does not recognise the program when it does not -
// rather than implying the unrecognised case is the suspicious one.
function netConnectionTitle(name, count) {
  const kind = classifyNetProgram(name);
  const counted = `${count} connection${count === 1 ? '' : 's'} open right now. This is a count of connections, not of bandwidth used.`;
  if (kind) return `${counted}\n\n${name} is ${kind.kind}. ${kind.normal}`;
  return (
    `${counted}\n\nVanish does not have a description for this program, which says nothing either way about it - ` +
    'most programs that talk to the internet keep several connections open. Expand the row to see the addresses it is connected to.'
  );
}

// "Nothing on this PC is using the network" is a first-class answer here, not
// an empty state - it is the answer that tells someone to stop looking at their
// PC and go look at their router.
//
// The one thing this must never do is imply a per-program byte rate. Windows
// does not attribute bytes to a process without an ETW kernel trace, so any
// per-app "12 Mbps" on this screen would be invented. It reports connections
// held, and says so.
function renderNetworkActivity(net) {
  const body = document.getElementById('audit-network-body');
  const badge = document.getElementById('audit-network-badge');
  if (!body) return;

  if (!net || net.success !== true || net.verdict === 'unreadable') {
    if (badge) badge.style.display = 'none';
    body.innerHTML = `<div class="panel-state error" style="padding: 12px 0;">
      <i class="fa-solid fa-circle-xmark"></i>
      <div>Could not read the network adapters on this PC${net && net.error ? `: ${esc(net.error)}` : '.'}</div>
    </div>`;
    wireNetworkRefresh();
    return;
  }

  // formatBytes(0) returns 'Unknown' (its convention for an untracked size,
  // see xw2) - wrong here, where 0 is a confirmed reading, not a missing one.
  const rate = (bytesPerSecond) => {
    const b = bytesPerSecond || 0;
    return b === 0 ? '0 B/s' : `${formatBytes(b, 1)}/s`;
  };
  const gateway = (net.adapters || []).filter((a) => a.hasGateway);
  const primary = gateway.length ? gateway[0] : (net.adapters || [])[0];
  const processes = net.processes || [];
  const top = processes.slice(0, 6);

  // h8j: the byte-rate sample is short (sampleMs, default 1s) and can land in
  // a quiet gap of genuinely bursty traffic - "the rate was low right now" and
  // "nothing is using the network" are different claims, and conflating them
  // is exactly what an operator with real open connections during a quiet
  // sample caught. A low rate with open connections gets its own, more
  // honestly-hedged wording instead of reusing the true-idle verdict.
  const sampleSeconds = (net.sampleMs || 1000) / 1000;
  const quietWithConnections = processes.length > 0;

  const verdicts = {
    busy: {
      icon: 'fa-arrows-up-down',
      cls: 'is-busy',
      title: 'Something on this PC is using the network',
      detail:
        `The connection carried ${rate(net.totalBytesPerSecond)} while this was measured. ` +
        (top.length
          ? `${top.length === 1 ? 'One program has' : `${top.length} programs have`} connections open right now.`
          : 'No program held an open connection, so this is Windows itself.')
    },
    quiet: quietWithConnections
      ? {
          icon: 'fa-circle-check',
          cls: 'is-quiet',
          title: 'Low traffic in this sample - not necessarily idle',
          detail:
            `The connection carried ${rate(net.totalBytesPerSecond)} during a ${sampleSeconds}s sample, but ` +
            `${processes.length === 1 ? '1 program has' : `${processes.length} programs have`} a connection open right ` +
            'now. A short sample can land in a quiet gap of bursty traffic, so a low reading here does not mean ' +
            'nothing is using the network - only that little moved in that instant.'
        }
      : {
          icon: 'fa-circle-check',
          cls: 'is-quiet',
          title: 'Nothing on this PC is using the network',
          detail:
            `The connection carried ${rate(net.totalBytesPerSecond)} while this was measured, and no program held an ` +
            'open connection. If something still feels slow, the cause is not on this PC - it is the router or the ' +
            'connection beyond it, and nothing Vanish can change here will help.'
        },
    'link-weak': {
      icon: 'fa-triangle-exclamation',
      cls: 'is-weak',
      title: 'The Wi-Fi signal is the limit here',
      detail:
        `The signal is at ${net.signalPercent}%. At this strength the link itself is the constraint, so closing ` +
        'programs will not make much difference. Moving closer to the access point, or using a cable, will.'
    }
  };

  const v = verdicts[net.verdict] || verdicts.quiet;

  // Operator report: "network activity doesnt show upload, download speeds."
  // scanner.ps1 has always computed receiveBytesPerSecond/sendBytesPerSecond
  // per adapter (they already drive the busy/quiet verdict) - only the split
  // figures themselves were never displayed. No new engine capability, no
  // new network I/O, just surfacing a number already in the response.
  // anc: these two were a fragment of text inside the "Looked at:" line. They
  // are the two numbers most people come to this panel for, so they get their
  // own tiles.
  //
  // The tiles show the adapter carrying the default route. Deliberately NOT
  // expressed as a percentage of link speed: linkSpeedBps is the negotiated
  // rate to the router, not the speed of the internet connection behind it,
  // and "0.4% used" against the wrong denominator is a confident wrong answer.
  //
  // kp0: the fourth tile, ping - the app's one deliberate, scoped exception
  // to zero outbound network I/O. netPrimaryAdapter is cached at module
  // level so runPing() can rebuild just this tile after a tap without
  // needing the whole `net` response again.
  netPrimaryAdapter = primary;
  if (pingDestination === null && primary && primary.gatewayAddress) {
    pingDestination = primary.gatewayAddress;
    pingDestinationIsGateway = true; // kct
  }

  const rateTiles = primary
    ? `<div class="net-rate-tiles">
         <div class="net-rate-tile">
           <i class="fa-solid fa-arrow-down net-rate-icon is-down"></i>
           <div class="net-rate-text">
             <div class="net-rate-value">${esc(rate(primary.receiveBytesPerSecond))}</div>
             <div class="net-rate-label" title="What is arriving right now, measured over the last sample. This is NOT how fast your connection can go - Vanish does not measure that, because finding out means downloading from someone else's server.">Downloading now</div>
           </div>
         </div>
         <div class="net-rate-tile">
           <i class="fa-solid fa-arrow-up net-rate-icon is-up"></i>
           <div class="net-rate-text">
             <div class="net-rate-value">${esc(rate(primary.sendBytesPerSecond))}</div>
             <div class="net-rate-label" title="What is leaving right now, measured over the last sample. This is NOT how fast your connection can go - Vanish does not measure that, because finding out means uploading to someone else's server.">Uploading now</div>
           </div>
         </div>
         <div class="net-rate-tile is-meta">
           <i class="fa-solid fa-ethernet net-rate-icon"></i>
           <div class="net-rate-text">
             <div class="net-rate-value">${esc(primary.name)}</div>
             <div class="net-rate-label" title="${primary.linkSpeedBps ? esc('Negotiated link rate to your router: ' + formatBytes(primary.linkSpeedBps / 8, 0) + '/s. This is the speed between this PC and the router, not the speed of the internet connection behind it - those are usually very different numbers, which is why it is not shown on the tile.') : ''}">${primary.isWireless ? 'Wi-Fi' : 'Wired'}${
               net.signalPercent != null ? ` &middot; signal ${esc(net.signalPercent)}%` : ''
             }</div>
           </div>
         </div>
         <div id="net-ping-tile-container">${pingTileHtml()}</div>
         <div id="net-speed-tile-container">${speedTileHtml()}</div>
       </div>`
    : '';

  // Operator report 2026-08-27: "the metrics from measure again are a bit too
  // much". They were. Five tiles and a four-part footnote is a lot of numbers
  // to answer one question, and most of it repeated something already on
  // screen: the program count restated the length of the table directly below
  // it, and link speed restated a figure the tooltip itself calls misleading.
  //
  // Only the two things this line can say that nothing else on the panel can
  // are kept - both are traffic NOT attributable to any row in the table, so
  // without them a busy adapter above an idle-looking table has no
  // explanation. Anything already visible elsewhere is not a metric, it is
  // repetition, and repetition is what made this read as noise.
  const examined = [
    net.updateTransfers != null && net.updateTransfers > 0
      ? `Windows Update: ${net.updateTransfers} download(s) running`
      : null,
    net.bitsJobs == null
      ? 'background transfers: needs administrator to see every account'
      : net.bitsJobs > 0
        ? `background transfers: ${net.bitsJobs}`
        : null
  ].filter(Boolean);

  const signalLine =
    net.signalNote === 'needs-location-permission'
      ? 'Wi-Fi signal strength was not read: Windows keeps it behind the Location privacy setting.'
      : net.signalNote === 'needs-elevation'
        ? 'Wi-Fi signal strength was not read: Windows only reports it to an administrator.'
        : null;

  // Operator report: "are we able to enumerate the connections open and
  // places connected to... would that help decide if risky." The IPs were
  // always collected (scanner.ps1); this makes "places connected to" a real,
  // checkable list instead of just a count, without a port (kept stripped -
  // see the comment where scanner.ps1 collects it) or any DNS lookup (would
  // be outbound network I/O, which this panel is tested to never do).
  const rows = top
    .map((p, i) => {
      const peers = Array.isArray(p.peers) ? p.peers : [];
      const rowId = `net-peers-${i}`;
      // hks: a high count is where the reassurance has to be VISIBLE, not
      // only on hover - the whole complaint was that the bare number reads
      // as worrying on sight. Below the threshold the tooltip still carries
      // the same context for anyone who goes looking.
      const kind = classifyNetProgram(p.name);
      const countLabel =
        kind && p.connectionCount >= NET_NOTABLE_CONNECTION_COUNT
          ? `${esc(p.connectionCount)} <span class="net-kind-note">normal for ${esc(kind.kind)}</span>`
          : esc(p.connectionCount);

      // UDP shown BESIDE the connection count, never added to it. A UDP row
      // is a socket, not a conversation. Measured on the operator's machine:
      // qBittorrent had 4 established TCP connections and 21 UDP sockets, so
      // the old single number described a saturating torrent client as
      // idle-looking. Adding them would have produced a tidier number that
      // means less.
      const udp = Number(p.udpSocketCount) || 0;
      const udpLabel = udp > 0
        ? `<span class="net-udp-note" title="UDP sockets. UDP has no connections to count - each one is an open socket that can send or receive at any time. BitTorrent, video calls and game traffic mostly use it, which is why a program can look idle here while moving a lot of data.">+${esc(udp)} UDP</span>`
        : '';
      return `
      <tr class="app-row${peers.length ? ' net-row-expandable' : ''}" ${peers.length ? `data-peers-toggle="${rowId}"` : ''}>
        <td style="font-size: 12px; font-weight: 600; color: var(--text-white);">${esc(p.name)}</td>
        <td style="font-size: 12px; color: var(--text-gray);">${esc(p.processId)}</td>
        <td style="font-size: 12px; color: var(--text-gray);" title="${esc(netConnectionTitle(p.name, p.connectionCount))}">${countLabel} ${udpLabel}</td>
        <td style="font-size: 12px; color: var(--text-gray);">
          ${esc(p.peerCount)}${peers.length ? ' <i class="fa-solid fa-chevron-right net-peers-chevron"></i>' : ''}
        </td>
        <td style="text-align: right;">
          <button class="btn-sec btn-compact net-kill-btn" data-net-index="${i}" data-destructive="true"
                  title="Stop this program now. Anything it has not saved is lost.">Stop</button>
        </td>
      </tr>
      ${peers.length ? `
      <tr class="net-peers-row" id="${rowId}" style="display: none;">
        <td colspan="5">
          <div class="net-peers-list">${peers.map((ip) => `<span class="net-peer-pill">${esc(ip)}</span>`).join('')}</div>
        </td>
      </tr>` : ''}`;
    })
    .join('');

  body.innerHTML = `
    <div class="net-verdict ${v.cls}">
      <div class="net-verdict-icon"><i class="fa-solid ${v.icon}"></i></div>
      <div class="net-verdict-main">
        <div class="net-verdict-title">${esc(v.title)}</div>
        <div class="net-verdict-detail">${esc(v.detail)}</div>
      </div>
      <button class="btn-sec btn-compact" id="btn-network-refresh">
        <i class="fa-solid fa-rotate-right"></i> Measure again
      </button>
    </div>

    ${rateTiles}

    ${examined.length || signalLine
      ? `<div class="panel-inline-note">${examined.map(esc).join(' &middot; ')}${examined.length && signalLine ? ' &middot; ' : ''}${signalLine ? esc(signalLine) : ''}</div>`
      : ''}

    <div id="network-hold-row"></div>

    ${
      top.length
        ? `<div style="overflow-x: auto;">
             <table class="apps-table">
               <thead>
                 <tr>
                   <th style="width: 32%;">Program</th>
                   <th style="width: 10%;">ID</th>
                   <th style="width: 26%;">Connections open</th>
                   <th style="width: 18%;">Places connected to</th>
                   <th style="width: 14%; text-align: right;">Action</th>
                 </tr>
               </thead>
               <tbody>${rows}</tbody>
             </table>
           </div>
           <div class="panel-inline-note">Windows does not tell any program how many bytes each other program used
             without a kernel-level trace, so this is what each one has open - not a share of the speed.
             <strong>Ordered by how many sockets each program holds, which is not the same as how busy it is:</strong>
             a program can hold sockets and be connected to nothing, and one moving a lot of data over UDP
             (games, BitTorrent) shows no connections at all. Read the two right-hand columns, not the order.</div>`
        : ''
    }`;

  if (badge) {
    badge.style.display = 'inline-flex';
    badge.textContent = net.verdict === 'busy' ? 'in use' : net.verdict === 'link-weak' ? 'weak signal' : 'idle';
    badge.className = net.verdict === 'busy' ? 'audit-badge' : 'audit-badge';
  }

  wireNetworkRefresh();
  wireNetworkPeerToggles();
  wireNetworkKillButtons(top);
  wirePingTile();
  wireSpeedTile();
  renderNetworkHold();
  // Audit Mode leaves the Stop buttons visible and inert with the reason,
  // like every other destructive control in the app (REQ-04).
  applyTierLocks();
}

// Operator, 2026-08-14: "the network activity items need a stop process
// button per row. safety warnings issued for reasonable activities, like
// 'normal for so and so process' which is already shown. otherwise a generic
// warning so people knw what they are doing."
//
// So the confirmation is not one fixed sentence. Where Vanish already knows
// what the program is - the same classifyNetProgram() knowledge that puts
// "normal for a web browser" next to a high connection count - it says so
// BEFORE asking, because that is the fact most likely to change the answer.
// Where it does not know, it says THAT, rather than inventing a reassurance
// or a warning it cannot support.
function wireNetworkKillButtons(items) {
  document.querySelectorAll('.net-kill-btn').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      // The row itself expands the peer list; stopping a program is not that.
      event.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-net-index'), 10);
      const p = items[idx];
      if (!p) return;
      if (!guardFullMode()) return;

      const kind = classifyNetProgram(p.name);
      const udp = Number(p.udpSocketCount) || 0;
      const sockets = udp > 0
        ? `${p.connectionCount} connection(s) and ${udp} UDP socket(s)`
        : `${p.connectionCount} connection(s)`;

      const context = kind
        ? `${p.name} is ${kind.kind}. ${kind.normal}`
        : `Vanish does not have a description for ${p.name}. That says nothing either way about it - `
          + 'most programs that talk to the internet keep several connections open.';

      const ok = await confirmDialog({
        title: `Stop ${p.name}?`,
        body:
          `${context}\n\n`
          + `It currently has ${sockets} open.\n\n`
          + 'Stopping it closes those immediately and ends the program. Anything it '
          + 'has not saved is lost, and a download or upload in progress will not '
          + 'resume by itself. This is not undoable from Quarantine - it is not a '
          + 'removal, it just ends a running program. You can start it again yourself.',
        confirmLabel: `Stop ${p.name}`,
      });
      if (!ok) return;

      const res = await window.api.killProcess({ pid: p.processId, name: p.name });
      if (res && res.success) {
        toast(`${p.name} stopped.`, 'success');
        // Re-sample just this section, the same way the Refresh button does.
        renderNetworkActivity(await window.api.getNetworkActivity());
      } else {
        toast(`Could not stop ${p.name}: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
      }
    });
  });
}

// INV-4 exception two, and the tile exists to make the distinction the rate
// tiles cannot: "Downloading now" is what is crossing the wire, this is how
// fast the line can actually go. The operator asked for the Ookla number and
// chose Cloudflare as the endpoint after being shown what it costs.
let speedState = { status: 'idle', result: null };

function speedRate(bytesPerSecond) {
  if (!bytesPerSecond) return null;
  // Mbps, because that is the unit every ISP and every speed test quotes.
  // Showing MB/s here would be technically fine and would not match the
  // number on their broadband bill, which is what they are checking against.
  const mbps = (bytesPerSecond * 8) / 1000000;
  return `${mbps >= 100 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
}

function speedTileHtml() {
  if (speedState.status === 'running') {
    return `<div class="net-rate-tile is-action">
        <i class="fa-solid fa-spinner fa-spin net-rate-icon"></i>
        <div class="net-rate-text">
          <div class="net-rate-value">Measuring...</div>
          <div class="net-rate-label">about 20 seconds</div>
        </div>
      </div>`;
  }
  const r = speedState.result;
  if (r && r.success) {
    const down = speedRate(r.downBytesPerSecond);
    const up = speedRate(r.upBytesPerSecond);
    return `<div class="net-rate-tile is-action" id="net-speed-tile" role="button" tabindex="0"
        title="Measured against ${esc(r.endpoint)}. This is what the connection managed at that moment - anything else using the network at the time, including this PC, makes it read lower. Tap to measure again.">
        <i class="fa-solid fa-gauge-high net-rate-icon"></i>
        <div class="net-rate-text">
          <div class="net-rate-value">${esc(down || '-')}${up ? ` &middot; ${esc(up)} up` : ''}</div>
          <div class="net-rate-label">Line speed, measured</div>
        </div>
      </div>`;
  }
  if (r && r.error) {
    return `<div class="net-rate-tile is-action" id="net-speed-tile" role="button" tabindex="0" title="${esc(r.error)}">
        <i class="fa-solid fa-gauge-high net-rate-icon"></i>
        <div class="net-rate-text">
          <div class="net-rate-value">Could not measure</div>
          <div class="net-rate-label">tap to try again</div>
        </div>
      </div>`;
  }
  return `<div class="net-rate-tile is-action" id="net-speed-tile" role="button" tabindex="0"
      title="Measures how fast this connection can actually go, by transferring data to and from Cloudflare. Nothing is sent until you agree to it.">
      <i class="fa-solid fa-gauge-high net-rate-icon"></i>
      <div class="net-rate-text">
        <div class="net-rate-value">Measure</div>
        <div class="net-rate-label">line speed</div>
      </div>
    </div>`;
}

function reRenderSpeedTile() {
  const host = document.getElementById('net-speed-tile-container');
  if (!host) return;
  host.innerHTML = speedTileHtml();
  wireSpeedTile();
}

function wireSpeedTile() {
  const tile = document.getElementById('net-speed-tile');
  if (!tile) return;
  tile.addEventListener('click', runSpeedTest);
  tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runSpeedTest(); } });
}

// Nothing here runs on a timer, on load, or on refresh. The only caller is a
// click, and the first click has to get through the consent below.
async function runSpeedTest() {
  if (speedState.status === 'running') return;

  if (!appSettings.speedTestConsentGiven) {
    // Named endpoint, named payload size, named consequence. A consent
    // dialog that says "this may use data" is not consent to 30MB.
    const ok = await confirmDialog({
      title: 'Measure your connection speed?',
      body:
        'There is no way to find out how fast a connection is without using it. Vanish will download '
        + 'from speed.cloudflare.com for about 5 seconds and upload for about 3, and time both.\n\n'
        + 'It stops at whichever comes first: the time limit, or 40 MB down and 10 MB up. On a slow '
        + 'connection the clock stops it early and it uses far less than that - the limit is there so a '
        + 'fast connection cannot run away with your data, not because it always uses it.\n\n'
        + 'What Cloudflare sees: this machine\u2019s IP address and a few seconds of traffic. No account, no '
        + 'identifier, and nothing about this PC or what is installed on it - the data transferred is '
        + 'random bytes in one direction and discarded in the other, so it carries nothing of yours.\n\n'
        + 'About 30 MB will count against your data allowance. If you are on a metered or capped '
        + 'connection, that matters, and it is the reason this is off until you say otherwise.\n\n'
        + 'The result is shown here and nowhere else. It is not saved, not logged, and not sent anywhere.',
      confirmLabel: 'Measure it',
    });
    if (!ok) return;
    await saveSettings({ speedTestConsentGiven: true });
  }

  speedState = { status: 'running', result: null };
  reRenderSpeedTile();
  let res;
  try {
    res = await window.api.networkSpeedTest();
  } catch (err) {
    res = { success: false, error: err.message };
  }
  speedState = { status: 'idle', result: res };
  reRenderSpeedTile();
}

function wireNetworkPeerToggles() {
  document.querySelectorAll('[data-peers-toggle]').forEach((row) => {
    row.addEventListener('click', () => {
      const target = document.getElementById(row.getAttribute('data-peers-toggle'));
      if (!target) return;
      const showing = target.style.display !== 'none';
      target.style.display = showing ? 'none' : 'table-row';
      row.classList.toggle('is-expanded', !showing);
    });
  });
}

// --- kp0: manual-tap ping -----------------------------------------------
//
// The app's one deliberate, scoped exception to "no network I/O ever" -
// enforced HERE, not just described in the About page: nothing calls
// runPing() except the tile's own click handler wired in wirePingTile().
// No timer, no auto-run on tab open or refresh, no retry loop.
let netPrimaryAdapter = null;
let pingDestination = null; // null until the first render picks up a gateway
// kct: is pingDestination still the gateway Vanish detected, or something the
// user typed? Only the former may be described on screen as "your router".
let pingDestinationIsGateway = false;
let pingEditing = false;
let pingState = { status: 'idle' }; // idle | running | success | error

function pingTileHtml() {
  // kct: name the destination, do not just print it. The auto-detected value
  // is the machine's own default gateway - i.e. the user's router - and the
  // whole reason kp0 was allowed to exist is that the one packet it sends
  // stays on the local network. Printing a bare "10.128.67.147" hid exactly
  // that: the operator saw an unexplained private IP in the one feature that
  // admits to sending traffic, looked it up in an external tool, and was told
  // it has no location or owner. Correct data, no confidence.
  //
  // Only claimed while the destination IS the detected gateway. Once the user
  // edits it, Vanish no longer knows what the address is and must not say it
  // does - "your router" pointing at 8.8.8.8 would be a confident wrong answer
  // of exactly the kind this app refuses everywhere else.
  // An IPv6 link-local gateway defeats the reassurance above by being
  // unreadable. On the operator's machine the detected gateway is
  // fe80::a832:78ff:fe0d:8256%5 - thirty characters that look far more
  // alarming than 192.168.1.1, and he asked what it was. It is his own Wi-Fi
  // router, and fe80::/10 is the one address range that CANNOT be routed off
  // the local link, so the strongest thing that can be said about this packet
  // is true and was going unsaid. Machines with no IPv4 default route at all
  // - a phone hotspot, an IPv6-only carrier link - see this every time.
  const linkLocal = !!pingDestination && /^fe80:/i.test(pingDestination);
  const label = !pingDestination
    ? 'no gateway found'
    : pingDestinationIsGateway
      ? linkLocal
        ? 'your router, on this network only'
        : `your router (${esc(pingDestination)})`
      : esc(pingDestination);
  const labelTitle = linkLocal && pingDestinationIsGateway
    ? ` title="${esc(pingDestination)} -- your router's link-local IPv6 address. Addresses starting fe80: are defined to be non-routable: this packet physically cannot leave your local network, and no server on the internet ever sees it. Vanish shows this one rather than a 192.168.x.x address because this machine has no IPv4 default route."`
    : '';
  // wy7a: a CHOICE, not a text box. main.js will only ping this PC's own
  // router or a public resolver it knows, so a free-text field could offer
  // something the boundary refuses - and a control that accepts input the app
  // then rejects is a worse experience than one that never offered it.
  const editRow = pingEditing
    ? `<select class="net-ping-dest-input" id="net-ping-dest-input">
         ${pingDestinationOptions()
           .map(
             (o) =>
               `<option value="${esc(o.value)}"${o.value === pingDestination ? ' selected' : ''}>${esc(o.label)}</option>`
           )
           .join('')}
       </select>`
    : `<div class="net-rate-label"${labelTitle}>
         to ${label}
         <button class="net-ping-edit-btn" id="net-ping-edit-btn" title="Change what Ping tests against">
           <i class="fa-solid fa-pen"></i>
         </button>
       </div>`;

  let icon = 'fa-tower-broadcast';
  let value = 'Tap to test';
  if (pingState.status === 'running') {
    icon = 'fa-spinner fa-spin';
    value = 'Pinging&hellip;';
  } else if (pingState.status === 'success') {
    value = `${esc(pingState.roundTripMs)} ms`;
  } else if (pingState.status === 'error') {
    icon = 'fa-triangle-exclamation';
    value = 'No reply';
  }

  return `
    <div class="net-rate-tile net-ping-tile${pingState.status === 'error' ? ' is-weak' : ''}" id="net-ping-tile"
         title="Sends one ICMP echo to the address below and reports whether it replies and how fast. This is the only network traffic Vanish ever sends, and only when you tap this tile.">
      <i class="fa-solid ${icon} net-rate-icon"></i>
      <div class="net-rate-text">
        <div class="net-rate-value" id="net-ping-value">${value}</div>
        ${editRow}
      </div>
    </div>`;
}

function reRenderPingTile() {
  const container = document.getElementById('net-ping-tile-container');
  if (container) container.innerHTML = pingTileHtml();
  wirePingTile();
}

function wirePingTile() {
  const tile = document.getElementById('net-ping-tile');
  if (tile) {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.net-ping-edit-btn') || e.target.closest('.net-ping-dest-input')) return;
      runPing();
    });
  }

  const editBtn = document.getElementById('net-ping-edit-btn');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pingEditing = true;
      reRenderPingTile();
      const input = document.getElementById('net-ping-dest-input');
      if (input) { input.focus(); input.select(); }
    });
  }

  const input = document.getElementById('net-ping-dest-input');
  if (input) {
    input.addEventListener('click', (e) => e.stopPropagation());
    const commit = () => {
      const value = String(input.value || '').trim();
      if (value) {
        // kct: an edited destination is only still "your router" if it IS the
        // detected gateway. Compared rather than assumed, so re-picking the
        // same address does not silently downgrade the label.
        pingDestinationIsGateway =
          !!(netPrimaryAdapter && netPrimaryAdapter.gatewayAddress === value);
        pingDestination = value;
        pingState = { status: 'idle' };
      }
      pingEditing = false;
      reRenderPingTile();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { pingEditing = false; reRenderPingTile(); }
    });
    input.addEventListener('blur', commit);
  }
}

// wy7a: the same set main.js enforces, phrased for a person. Kept next to the
// control that uses it rather than beside the enforcing copy, because these are
// not two implementations of one rule - main.js decides, and this only decides
// what to OFFER. If they ever disagree the boundary wins and the user sees a
// refusal, which is the right way round.
function pingDestinationOptions() {
  const options = [];
  const gw = netPrimaryAdapter && netPrimaryAdapter.gatewayAddress;
  if (gw) options.push({ value: gw, label: `Your router (${gw})` });
  options.push({ value: '1.1.1.1', label: 'Cloudflare (1.1.1.1)' });
  options.push({ value: '8.8.8.8', label: 'Google (8.8.8.8)' });
  return options;
}

async function runPing() {
  if (pingState.status === 'running') return;
  if (!pingDestination) {
    toast('No destination to ping - this PC has no default gateway right now.', 'warn');
    return;
  }

  // Condition 4 (bd kp0): a one-time explanation before the FIRST tap ever,
  // naming what is sent, where, and that it is the app's only outbound
  // traffic - not a generic "are you sure". Declining does not set the
  // remembered flag, so the next tap asks again rather than silently
  // pinging without ever having been agreed to.
  if (!appSettings.pingConsentGiven) {
    const ok = await confirmDialog({
      title: 'Send a network request?',
      body:
        `Vanish will send one ICMP ping to ${pingDestination}` +
        // kct: the consent dialog is the one place a person decides whether to
        // allow the app's only outbound packet. "10.128.67.147" means nothing
        // to most people; "your own router, on this network" is the fact that
        // actually informs the decision - and it is only stated when true.
        (pingDestinationIsGateway
          ? ' - your own router, on this network, not anywhere on the internet - '
          : ' ') +
        'and read whether it replies and how fast. ' +
        // This used to read "the only network traffic Vanish ever sends".
        // The speed test made that false, and a privacy claim that quietly
        // stops being true is worse than one that was never made. There are
        // two now; both are opt-in, both need a separate agreement, and
        // neither ever runs on a timer.
        'Vanish sends network traffic in exactly two places, and this is one of them - the other is the ' +
        'connection speed test, which is agreed to separately. Everything else in the app only reads ' +
        'information already on this PC. You can change the destination with the pencil icon, and nothing ' +
        'is ever sent unless you tap this tile.',
      confirmLabel: 'Send it'
    });
    if (!ok) return;
    // saveSettings() updates the module-level appSettings itself; it has no
    // return value.
    await saveSettings({ pingConsentGiven: true });
  }

  pingState = { status: 'running' };
  reRenderPingTile();

  let res;
  try {
    res = await window.api.networkPing({ destination: pingDestination });
  } catch (err) {
    res = { success: false, error: err.message };
  }

  pingState = res && res.success === true
    ? { status: 'success', roundTripMs: res.roundTripMs }
    : { status: 'error', error: (res && res.error) || 'No reply.' };
  reRenderPingTile();
}

// bfh.2. A hold changes a machine-wide Windows policy and pauses other
// people's transfers, so while it is on it must be impossible to miss - the
// failure mode of a quiet background toggle is a user who never gets another
// Windows update and has no idea why.
async function renderNetworkHold() {
  const row = document.getElementById('network-hold-row');
  if (!row) return;

  let state = null;
  try {
    state = await window.api.networkHoldState();
  } catch {
    return;
  }

  if (state && state.active) {
    const heldJobsList = (state.record && state.record.bitsJobs) || [];
    const heldJobs = heldJobsList.length;
    const since = state.record && state.record.startedAt
      ? new Date(state.record.startedAt).toLocaleTimeString()
      : null;

    // Operator report: the hold worked, but nothing named what it actually
    // held - "N background transfer(s)" is a number with nothing to check it
    // against. Each captured job already carries a displayName (scanner.ps1
    // network-hold-capture); a PID-level list isn't possible (BITS jobs
    // aren't reliably tied to one live process), but naming the transfers
    // themselves is the concrete, checkable version of the same idea.
    const jobList = heldJobs > 0
      ? `<ul class="net-hold-jobs">${heldJobsList.map((j) => `<li>${esc(j.displayName || j.jobId)}</li>`).join('')}</ul>`
      : '';

    row.innerHTML = `
      <div class="net-hold is-on">
        <div class="net-hold-main">
          <div class="net-hold-title"><i class="fa-solid fa-pause"></i> Background transfers are being held</div>
          <div class="net-hold-detail">
            Windows Update's background downloads are capped and
            ${heldJobs === 0 ? 'no other transfer was running to pause' : `${heldJobs} background transfer(s) are paused`}${since ? `, since ${esc(since)}` : ''}.
            Releasing puts every setting back exactly as it was. Vanish also releases it by itself if it is closed or crashes.
          </div>
          ${jobList}
        </div>
        <button class="btn-primary btn-compact" id="btn-network-release" data-destructive="true">
          <i class="fa-solid fa-play"></i> Release
        </button>
      </div>`;
  } else {
    row.innerHTML = `
      <div class="net-hold">
        <div class="net-hold-main">
          <div class="net-hold-title">Hold background transfers</div>
          <div class="net-hold-detail">
            Caps Windows Update's background downloading and pauses background transfers that are running, until you
            release it. It cannot give a program more speed - it only stops other things taking it - and it does
            nothing about traffic from other devices on your network.
          </div>
        </div>
        <button class="btn-sec btn-compact" id="btn-network-hold" data-destructive="true">
          <i class="fa-solid fa-pause"></i> Hold
        </button>
      </div>`;
  }

  const hold = document.getElementById('btn-network-hold');
  if (hold) hold.addEventListener('click', () => applyNetworkHold());
  const release = document.getElementById('btn-network-release');
  if (release) release.addEventListener('click', () => releaseNetworkHold());

  applyTierLocks();
}

async function applyNetworkHold() {
  if (!guardFullMode()) return;

  const ok = await confirmDialog({
    title: 'Hold background transfers?',
    body:
      "Windows Update's background downloads are capped, and background transfers that are running now are paused. " +
      'Nothing is uninstalled and nothing is deleted. Every setting is written down before it is changed, so releasing ' +
      'puts it all back - and Vanish releases it automatically if it closes or crashes while the hold is on.',
    confirmLabel: 'Hold them'
  });
  if (!ok) return;

  const res = await window.api.networkHoldApply();
  if (!res || res.success !== true) {
    toast(`Nothing was held: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
    await renderNetworkHold();
    return;
  }

  toast(
    `Background transfers held. ${res.appliedCount} setting(s) changed, and every one of them is recorded so it can be put back.`,
    'success',
    6000
  );
  await renderNetworkHold();
}

async function releaseNetworkHold() {
  if (!guardFullMode()) return;

  const res = await window.api.networkHoldRevert();
  if (!res || res.success !== true) {
    // A partial release keeps its record on disk on purpose, so this is
    // recoverable rather than stranded - say so instead of just failing.
    toast(
      `Some settings could not be put back: ${(res && res.error) || 'no reason given'}. Vanish still has the record and will try again next time it starts.`,
      'error',
      10000
    );
    await renderNetworkHold();
    return;
  }

  toast('Background transfers released. Every setting is back where it was.', 'success', 5000);
  await renderNetworkHold();
}

function wireNetworkRefresh() {
  const btn = document.getElementById('btn-network-refresh');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const badge = document.getElementById('audit-network-badge');
    if (badge) {
      badge.style.display = 'inline-flex';
      badge.textContent = 'measuring';
    }
    btn.disabled = true;
    // Only this SECTION re-samples - re-running the whole Health Advisor to
    // answer one question is the pattern 7oo.5 was about. But within the
    // section, one tap now refreshes everything (operator, 2026-08-14: "i
    // need them all to be unified. one tap refreshes everything").
    //
    // Three separate taps for throughput, ping and line speed meant three
    // readings from three different moments sitting side by side, which is
    // its own kind of dishonesty: the tiles looked like one measurement and
    // were not.
    const net = await window.api.getNetworkActivity();
    renderNetworkActivity(net);

    // Ping and speed test run only where they are already allowed. Neither
    // is triggered by this button on a machine that has not agreed to it -
    // a refresh must never be the thing that first puts traffic on the wire.
    const followUps = [];
    if (appSettings.pingConsentGiven && pingDestination) followUps.push(runPing());
    if (appSettings.speedTestConsentGiven) followUps.push(runSpeedTest());
    if (followUps.length) await Promise.all(followUps);
  });
}

// Operator-proposed throttle: "put that on a manual refresh only... or an
// interval based refresh we could set in settings." Off (0) by default -
// today's manual-only "Measure again" behaviour is unchanged unless a
// person opts in from Settings. Only runs while the Health Advisor tab is
// actually visible (switchTab starts/stops it), same lifecycle as the Task
// Manager sampler.
let networkRefreshTimer = null;

function startNetworkAutoRefresh() {
  stopNetworkAutoRefresh();
  const seconds = appSettings.networkRefreshSeconds || 0;
  if (seconds <= 0) return;
  networkRefreshTimer = setInterval(async () => {
    const net = await window.api.getNetworkActivity();
    renderNetworkActivity(net);
  }, seconds * 1000);
}

function stopNetworkAutoRefresh() {
  if (networkRefreshTimer) {
    clearInterval(networkRefreshTimer);
    networkRefreshTimer = null;
  }
}

function renderDiskBars(disks, error) {
  const list = document.getElementById('audit-disk-list');
  if (!list) return;

  // "No local drives found" is a claim about the machine. If the query failed,
  // say that instead - a broken query rendered as an empty result is what let
  // this section ship dead (7oo.8).
  if (error) {
    list.innerHTML = `<div class="panel-state error" style="padding: 12px 0;">
      <i class="fa-solid fa-circle-xmark"></i>
      <div>Could not read the drives on this PC: ${esc(error)}</div>
    </div>`;
    return;
  }

  if (!disks || disks.length === 0) {
    list.innerHTML = '<div style="color: var(--text-gray); font-size: 13px;">No local drives found.</div>';
    return;
  }

  list.innerHTML = disks.map(d => {
    const pct = d.pctUsed ?? 0;
    const fillClass = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
    return `
      <div class="disk-bar-row">
        <div class="disk-bar-header">
          <span class="disk-bar-drive">${esc(d.drive)}:\ &nbsp;<span style="font-weight:400; font-size:12px; color:var(--text-gray);">${esc(d.label)}</span></span>
          <span class="disk-bar-stats">${d.usedGB} GB used of ${d.totalGB} GB &nbsp;-&nbsp; ${d.freeGB} GB free &nbsp;-&nbsp; ${pct}% full</span>
        </div>
        <div class="disk-bar-track">
          <div class="disk-bar-fill ${fillClass}" style="width: ${pct}%;"></div>
        </div>
      </div>
    `;
  }).join('');
}

// The label a row wears, and the words are load-bearing. NEVER "trusted",
// NEVER "safe" - both would be claims about the software rather than about
// the consequences of switching it off, and neither is a claim Vanish can
// support. "No opinion" is stated outright rather than left blank, because a
// blank reads as approval.
const STARTUP_CLASS_LABELS = {
  system: 'Part of Windows',
  security: 'Security software',
  managed: 'Set by policy',
  orphaned: 'Broken - points at nothing',
  'known-publisher': 'Publisher confirmed',
  'no-opinion': 'Vanish has no opinion',
};

function startupClassLabel(item) {
  return STARTUP_CLASS_LABELS[item.classification] || 'Vanish has no opinion';
}

// 9sy: what the action button's hover text says.
//
// This used to be item.suggestion, which is populated ONLY for orphaned entries
// (the exePath is gone). The elevated real-data pass reported 0 of 45 buttons
// carrying a title, because this machine has no orphans - so the one control on
// the row that changes the system explained itself on exactly none of them, and
// on the rows where it DID have text, that text was about the orphan rather
// than about the button.
//
// The suggestion still appears, in the place it belongs: the lightbulb row
// underneath an orphaned entry, which has room for a sentence.
//
// Each string names the consequence AND the way back, because that is the
// difference between this app and the category. The registry and service paths
// really do export a .reg restore manifest to the vault BEFORE they write, and
// refuse the change outright if that export fails (main.js startup-action).
// Disabling a task destroys nothing and the same button re-enables it, which is
// why it is the one path with no manifest - so it must not claim one.
function startupActionTitle(item) {
  if (item.action === 'task-disable') {
    return item.enabled
      ? 'Stops this scheduled task from running. Nothing is deleted - this same button turns it back on.'
      : 'Lets this scheduled task run again.';
  }
  if (item.action === 'service-manual') {
    return 'Stops this service starting on its own; Windows can still start it when something asks for it. '
      + 'Vanish saves a restore file to Quarantine first, and makes no change at all if it cannot.';
  }
  if (item.action === 'registry-remove') {
    return 'Removes this entry so it no longer runs at startup. Vanish saves a restore file to Quarantine '
      + 'first, and makes no change at all if it cannot, so you can put it back.';
  }
  return item.actionLabel || 'Changes how this entry starts.';
}

// 5b0: the words the Source and Status cells display, each in one place, so the
// column filters offer exactly what the table shows. Same trap as All Programs'
// Type column: filtering on item.source would offer "TaskScheduler" for a cell
// that reads "Task".
function startupSourceLabel(item) {
  return item.source === 'TaskScheduler' ? 'Task' : item.source;
}

function startupStatusLabel(item) {
  if (item.exeExists === false) return 'Broken';
  return item.enabled ? 'Active' : 'Inactive';
}

function wireStartupColumnFilters() {
  // Registered from the render, not from a setup pass: audit.js has no setup
  // function of its own - loadAuditData is its entry point. registerColumnFilter
  // is idempotent about the funnel it attaches; the Clear button is wired once.
  const rerender = () => {
    if (lastStartupPayload) renderStartupTable(lastStartupPayload);
  };
  registerColumnFilter({
    key: 'startup.source',
    label: 'Source',
    th: '#audit-startup-table thead th:nth-child(2)',
    getPool: () => startupItems,
    getValues: (item) => [startupSourceLabel(item)],
    onChange: rerender
  });
  registerColumnFilter({
    key: 'startup.status',
    label: 'Status',
    th: '#audit-startup-table thead th:nth-child(3)',
    getPool: () => startupItems,
    getValues: (item) => [startupStatusLabel(item)],
    onChange: rerender
  });

  if (startupFilterUiWired) return;
  startupFilterUiWired = true;
  const clearBtn = document.getElementById('btn-clear-startup-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearColumnFilters(STARTUP_COLUMN_FILTERS);
      rerender();
    });
  }
}

// The count badge beside this section's title states the machine's TOTAL, which
// is correct and is exactly why a filtered table needs its own caption.
function updateStartupFilterStatus(shown, total) {
  const bar = document.getElementById('startup-filter-bar');
  const caption = document.getElementById('startup-filter-caption');
  if (!bar || !caption) return;
  const columns = columnFilterSummary(STARTUP_COLUMN_FILTERS);
  bar.style.display = columns ? '' : 'none';
  renderColumnFilterChips('startup-filter-chips', STARTUP_COLUMN_FILTERS);
  if (!columns) return;
  caption.textContent = `Showing ${shown} of ${total} startup entries - filtered by ${columns}`;
}

function renderStartupTable(startup) {
  const tbody      = document.getElementById('audit-startup-tbody');
  const countBadge = document.getElementById('audit-startup-count');
  const orphanBadge= document.getElementById('audit-orphan-count');
  if (!tbody) return;

  const items   = startup.items   ?? [];
  const total   = startup.total   ?? items.length;
  const orphans = startup.orphans ?? 0;

  if (countBadge)  countBadge.textContent  = total;
  if (orphanBadge) {
    orphanBadge.textContent = `${orphans} broken`;
    orphanBadge.style.display = orphans > 0 ? 'inline-flex' : 'none';
  }

  // 7oo.11: this surface acts now, and what it does is reversible. The note
  // says which, because the difference between "removed" and "removed, and
  // here is how to undo it" is the whole basis for clicking the button.
  const noteEl = document.getElementById('audit-startup-note');
  if (noteEl) {
    noteEl.textContent = startup.detectionNote ||
      'Every change here is saved to quarantine first, so it can be put back.';
  }

  // Keep the rows so the click handlers can find their item by index rather
  // than re-deriving it from the DOM.
  startupItems = items;
  lastStartupPayload = startup;
  wireStartupColumnFilters();

  if (items.length === 0) {
    updateStartupFilterStatus(0, 0);
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center; padding:24px; color:var(--text-gray); font-size:13px;">
          <i class="fa-solid fa-circle-check" style="color:var(--color-success); margin-right:6px;"></i>Nothing extra starts with Windows on this PC.
        </td>
      </tr>
    `;
    return;
  }

  // tda: one row builder, called twice - once for the group a person can act
  // on, once for the group the machine depends on. The INDEX stays the index
  // into the full items array, because that is what the action handlers and
  // startupItems[] are keyed on; splitting the display must not renumber it.
  const rowHtml = (item, index) => {
    const sourceClass = item.source === 'Registry' ? 'registry'
                      : item.source === 'TaskScheduler' ? 'task'
                      : 'service';
    const sourceLabel = startupSourceLabel(item);

    const dotClass = item.exeExists === false ? 'orphan'
                   : item.enabled ? 'active'
                   : 'passive';
    const statusLabel = startupStatusLabel(item);

    const cmdShort = (item.command || '').length > 80
      ? (item.command || '').slice(0, 80) + '...'
      : (item.command || '-');

    // An orphan the user is told about but given nothing to do with is the
    // defect this fixes. Every orphaned row now carries the concrete place its
    // own kind of entry is managed.
    const suggestionRow = item.exeExists === false && item.suggestion
      ? `<tr class="startup-suggestion-row">
           <td colspan="5">
             <div class="startup-suggestion">
               <i class="fa-solid fa-lightbulb"></i>
               <div>
                 <div><strong>The program at ${esc(item.exePath || 'this location')} is gone, so this entry does nothing every time Windows starts.</strong></div>
                 <div>${esc(item.suggestion)}</div>
               </div>
             </div>
           </td>
         </tr>`
      : '';

    // The label changes with the row's own state: a disabled task offers to be
    // enabled again, which is what makes disabling it safe to try.
    const actionLabel = item.action === 'task-disable'
      ? (item.enabled ? 'Disable' : 'Enable')
      : item.actionLabel || 'Turn off';

    const actionCell = item.action
      ? `<button class="btn-sec btn-compact startup-action-btn" data-startup-index="${index}"
                 data-destructive="true"
                 title="${esc(startupActionTitle(item))}">${esc(actionLabel)}</button>`
      : `<span style="font-size:11.5px; color: var(--text-muted);">Managed by Windows</span>`;

    return `
      <tr class="app-row${item.exeExists === false ? ' is-orphan' : ''}${item.group === 'necessary' ? ' is-necessary' : ''}">
        <td style="font-size: 12px; font-weight: 600; color: var(--text-white);">
          ${esc(item.name)}
          ${item.groupReason ? `<div class="startup-why" title="${esc(item.groupReason)}">${esc(startupClassLabel(item))}</div>` : ''}
        </td>
        <td><span class="source-badge ${esc(sourceClass)}">${esc(sourceLabel)}</span></td>
        <td>
          <span class="status-dot ${esc(dotClass)}"></span>
          <span style="font-size:12px; color: var(--text-gray);">${statusLabel}</span>
        </td>
        <td class="mono" style="color: var(--text-muted); word-break: break-all;" title="${esc(item.command || '')}">${esc(cmdShort)}</td>
        <td style="text-align: right; white-space: nowrap;">${actionCell}</td>
      </tr>
      ${suggestionRow}
    `;
  };

  // The split itself. Anything not classified as necessary is VISIBLE -
  // including everything Vanish has no opinion about. Hiding what it cannot
  // explain is how a cleaner ends up disabling something that mattered.
  // 5b0: the index stays the index into the FULL items array even when a column
  // filter hides rows - startupItems[] and every action handler are keyed on it,
  // so filtering has to drop rows without renumbering the survivors.
  const actionable = [];
  const necessary = [];
  let shown = 0;
  items.forEach((item, index) => {
    if (!columnFilterAllowsAll(STARTUP_COLUMN_FILTERS, item)) return;
    shown += 1;
    (item.group === 'necessary' ? necessary : actionable).push([item, index]);
  });

  updateStartupFilterStatus(shown, items.length);

  // "Your system depends on these" - never "trusted", never "safe". The claim
  // is about the cost of switching it off, not about the software being good.
  // A monitoring agent on a work laptop belongs in this group precisely
  // because disabling it is a disciplinary event, not because it is benign.
  const groupRow = necessary.length
    ? `<tr class="startup-group-row">
         <td colspan="5">
           <button type="button" class="startup-group-toggle" id="startup-necessary-toggle"
                   aria-expanded="false" aria-controls="startup-necessary-rows">
             <i class="fa-solid fa-chevron-right"></i>
             <span>${necessary.length} more your system depends on</span>
             <span class="startup-group-hint">shown separately so the list above is only things you can act on</span>
           </button>
         </td>
       </tr>`
    : '';

  // 5b0: a filter that hides everything must not look like a PC with nothing
  // starting up. Those two states mean completely different things, and the
  // reassuring one ("Nothing extra starts with Windows on this PC") belongs only
  // to a genuinely empty list.
  tbody.innerHTML = shown === 0
    ? `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--text-gray); font-size:13px;">
         No startup entries match the ${esc(columnFilterSummary(STARTUP_COLUMN_FILTERS))} filter.
       </td></tr>`
    : actionable.map(([item, index]) => rowHtml(item, index)).join('')
      + groupRow
      + necessary.map(([item, index]) => rowHtml(item, index)).join('');

  // Collapsed by default, which is the whole request - a long undifferentiated
  // list reads as "all of this is suspicious".
  const necessaryRows = [...tbody.querySelectorAll('tr.is-necessary')];
  necessaryRows.forEach((tr) => { tr.style.display = 'none'; });
  const toggle = document.getElementById('startup-necessary-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const nowOpen = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(nowOpen));
      toggle.querySelector('i').className = nowOpen ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right';
      necessaryRows.forEach((tr) => { tr.style.display = nowOpen ? '' : 'none'; });
    });
  }

  tbody.querySelectorAll('.startup-action-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      runStartupAction(parseInt(btn.getAttribute('data-startup-index'), 10))
    );
  });

  // Audit Mode leaves these visible and inert with the reason, like every other
  // destructive control in the app (REQ-04).
  applyTierLocks();
}

// 7oo.11. Three actions, one confirmation shape: say what will change, say
// where the undo lives, then do it and report the result on the row.
async function runStartupAction(index) {
  const item = startupItems[index];
  if (!item || !item.action) return;
  if (!guardFullMode()) return;

  const isTask = item.action === 'task-disable';
  const enabling = isTask && !item.enabled;

  let title;
  let body;
  if (isTask) {
    title = enabling ? `Enable "${item.name}"?` : `Disable "${item.name}"?`;
    body = enabling
      ? 'The task runs at logon again. Nothing else about it changes.'
      : 'The task stays on this PC but stops running at logon. This same button turns it back on.';
  } else if (item.action === 'service-manual') {
    title = `Stop "${item.name}" starting with Windows?`;
    body =
      'The service is set to start only when something asks for it, instead of at every boot. It is not ' +
      'removed, and it can still run. Its settings are saved to the Quarantine tab first, so the change ' +
      'can be undone from there.';
  } else {
    title = `Remove "${item.name}" from startup?`;
    body =
      'This entry stops running when Windows starts. The program itself is not touched or uninstalled. ' +
      'The startup settings are saved to the Quarantine tab first, so you can put this back.';
  }

  const ok = await confirmDialog({ title, body, confirmLabel: isTask ? (enabling ? 'Enable' : 'Disable') : 'Do it' });
  if (!ok) return;

  const res = await window.api.startupAction({
    action: item.action,
    item,
    enable: enabling
  });

  if (!res || res.success !== true) {
    toast(`Nothing changed: ${(res && res.error) || 'no reason given'}`, 'error', 8000);
    return;
  }

  toast(
    isTask
      ? `"${item.name}" is now ${enabling ? 'enabled' : 'disabled'}.`
      : `"${item.name}" no longer starts with Windows. You can put it back from the Quarantine tab.`,
    'success',
    6000
  );

  // The change is ours, so the result is not in doubt - but a startup list is
  // cheap to re-read and this keeps the row's state honest rather than guessed.
  await loadAuditData(true);
}

// Operator: "redundant software should offer a button that leads to a
// decision making workflow... a waive-off button... it still shows up in
// that section, but with the notice that the user overrode it, still
// offering the decision making buttonflow." Example given: different
// browsers for different needs is a deliberate choice, not an oversight -
// waiving records that choice without hiding the suggestion or losing the
// ability to act on it later.
function renderRedundancyGroups(redundancy) {
  const list = document.getElementById('audit-redundancy-list');
  const countBadge = document.getElementById('audit-redundancy-count');
  const waivedBadge = document.getElementById('audit-redundancy-waived-count');
  if (!list) return;

  const groups = redundancy.groups ?? [];
  const waived = new Set(appSettings.redundancyWaivers || []);
  const waivedCount = groups.filter((g) => waived.has(g.category)).length;

  // Same count/sub-count pill pattern as Startup Items' "N broken" badge -
  // operator: "discounts it while showing the discount on the header pill,
  // like how broken from startup shows up." The primary badge is what still
  // needs a look (waived groups excluded, i.e. discounted out of it); the
  // second badge accounts for the difference instead of hiding it.
  if (countBadge) {
    const active = groups.length - waivedCount;
    countBadge.textContent = active;
    countBadge.style.display = active > 0 ? 'inline-flex' : 'none';
  }
  if (waivedBadge) {
    waivedBadge.textContent = `${waivedCount} waived`;
    waivedBadge.style.display = waivedCount > 0 ? 'inline-flex' : 'none';
  }

  if (groups.length === 0) {
    list.innerHTML = `
      <div class="audit-ok-box">
        <i class="fa-solid fa-circle-check"></i>
        No programs here appear to overlap with each other.
      </div>
    `;
    return;
  }

  list.innerHTML = groups.map(g => {
    const isWaived = waived.has(g.category);
    const rows = (g.apps ?? []).map(a => `
      <div class="redundancy-app-row">
        <span class="redundancy-pill">${esc(a.name)}</span>
        <button class="btn-sec btn-compact redundancy-uninstall-btn" data-app-id="${esc(a.id)}">
          <i class="fa-solid fa-magnifying-glass"></i> Review to uninstall
        </button>
      </div>`
    ).join('');
    return `
      <div class="redundancy-group${isWaived ? ' is-waived' : ''}">
        <div class="redundancy-group-header">
          <span class="redundancy-category"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>${esc(g.category)}</span>
          <span class="audit-badge${isWaived ? '' : ' danger'}">${esc(g.count)} installed</span>
        </div>
        <div class="redundancy-tip">${esc(g.tip)}</div>
        ${isWaived
          ? `<div class="redundancy-override-notice"><i class="fa-solid fa-circle-check"></i> You chose to keep all of these - Vanish will keep showing this group, but will not flag it as unusual.</div>`
          : ''
        }
        <div class="redundancy-app-pills">${rows}</div>
        <div class="redundancy-actions">
          <button class="btn-sec btn-compact" data-waive-toggle="${esc(g.category)}">
            <i class="fa-solid ${isWaived ? 'fa-rotate-left' : 'fa-circle-check'}"></i> ${isWaived ? 'Undo, flag this again' : 'Keep all of these'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  wireRedundancyActions();
}

function wireRedundancyActions() {
  document.querySelectorAll('.redundancy-uninstall-btn').forEach((btn) => {
    btn.addEventListener('click', () => jumpToUninstall(btn.getAttribute('data-app-id')));
  });
  document.querySelectorAll('[data-waive-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleRedundancyWaiver(btn.getAttribute('data-waive-toggle')));
  });
}

// Jumps to the exact same entry point a person clicking the app in All
// Programs would reach (selectApp -> the details sidebar's own Clean
// Uninstall button) rather than opening a second, parallel uninstall path.
// Stops short of opening the wizard directly - the redundancy group's app
// object is a collapsed "family" summary (Get-SoftwareRedundancy), not
// necessarily the exact live registry row, so the details panel is where
// that gets confirmed before anything destructive is offered.
function jumpToUninstall(appId) {
  const app = allApps.find((a) => a.id === appId);
  if (!app) {
    toast('That program is no longer on the list - try re-scanning.', 'warn');
    return;
  }
  switchTab('all-apps');
  clearAppFilters();
  selectApp(app, null);
  filterAndRenderApps();
  const row = elements.appsTbody.querySelector('tr.selected');
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function toggleRedundancyWaiver(category) {
  const current = new Set(appSettings.redundancyWaivers || []);
  if (current.has(category)) current.delete(category);
  else current.add(category);
  await saveSettings({ redundancyWaivers: [...current] });
  // Only the override state changed - re-running the whole Health Advisor
  // load (system diagnostics, startup items, AND the network read with its
  // built-in ~1s sample sleep) to redraw one section's badges would be pure
  // waiting. Re-fetch just the redundancy groups and redraw only that list.
  // qkgu: get-software-redundancy now rejects when the engine fails, instead
  // of resolving with { groups: [], hasRedundancy: false } - so this call site
  // has to say so rather than let an unhandled rejection leave the list
  // showing whatever it showed before the waiver was toggled.
  try {
    const redundancy = await window.api.getSoftwareRedundancy();
    renderRedundancyGroups(redundancy);
  } catch (err) {
    auditSectionFailed('audit-redundancy-list', 'group installed programs', err.message);
  }
}

// ddx: what can be reached from outside.
//
// This exists because I gave the operator a confidently wrong answer about a
// service on their machine. They asked about rpdsvc, which had 54 open
// connections. I said: Remote Desktop, all loopback, nothing leaving the
// machine. The connections really were all loopback. It was also listening on
// 0.0.0.0:20121 as LocalSystem, and it was not Remote Desktop at all - it is
// RealPlayer's, software they do not use.
//
// "Who is this talking to" and "who can start a conversation with this" are
// different questions, and Vanish was answering only the reassuring one.
//
// THE RULES THIS PANEL FOLLOWS, and they are why it reads the way it does:
//
//   1. No score, no rank, no "dangerous" (Rule 6). Being reachable is not the
//      same as being unsafe, and we cannot tell the difference from here. The
//      defensible claim is "this is reachable"; anything stronger is invented.
//   2. The signature and the exposure are shown TOGETHER, always. Showing only
//      "signed by RealNetworks" is reassurance theatre; showing only "SYSTEM,
//      listening on every interface" is scaremongering. Both are true at once.
//      Signed means AUTHENTIC, not SAFE, and the wording says so.
//   3. LocalSystem is stated but never treated as a verdict. Most of Windows
//      runs as LocalSystem. On its own it is a weak signal.
//   4. Plain language leads, netstat's syntax follows as evidence. "Accepting
//      connections from other devices on your network" is the fact;
//      "0.0.0.0:20121" is the proof, and belongs beside it rather than instead
//      of it.
const LISTENER_EXPOSURE = {
  all: {
    label: 'Reachable from your network',
    detail: 'Anything that can reach this PC - other devices on your Wi-Fi or LAN, and '
      + 'whatever your router lets through - can try to open a connection to this program.',
    cls: 'is-exposed'
  },
  specific: {
    label: 'Reachable on one network',
    detail: 'This program accepts connections on a specific network connection rather than '
      + 'all of them. Who can reach it depends on what that network is.',
    cls: 'is-partial'
  },
  loopback: {
    label: 'This PC only',
    detail: 'Only programs already running on this PC can connect to it. Nothing on your '
      + 'network can reach it.',
    cls: 'is-local'
  }
};

function listenerSignatureLine(sig) {
  if (!sig || sig.status === 'not-checked') {
    return '<span class="listener-sig unknown">Signature not checked</span>';
  }
  if (sig.status === 'Valid') {
    const who = sig.signer ? esc(sig.signer) : 'a verified publisher';
    const ev = sig.isEv ? ' <span class="listener-ev" title="Extended Validation: the publisher is a vetted legal entity">EV</span>' : '';
    // "Authentic, not safe" is the entire point of showing this next to an
    // exposure line rather than on its own.
    return `<span class="listener-sig ok" title="Signed means this really is the publisher's software. It does not mean it is safe.">Signed by ${who}${ev}</span>`;
  }
  if (sig.status === 'unreadable') {
    return '<span class="listener-sig unknown">Signature could not be read</span>';
  }
  return `<span class="listener-sig bad" title="Windows could not confirm this binary is what its publisher shipped.">Signature: ${esc(sig.status)}</span>`;
}

function renderListeners(res) {
  const body = document.getElementById('audit-listeners-body');
  const badge = document.getElementById('audit-listeners-badge');
  if (!body) return;

  if (!res || res.success !== true) {
    body.innerHTML = `<div class="panel-state">Could not read listening programs${
      res && res.error ? `: ${esc(res.error)}` : '.'}</div>`;
    if (badge) badge.style.display = 'none';
    return;
  }

  const programs = res.programs || [];
  const totals = res.totals || { all: 0, specific: 0, loopback: 0 };

  if (badge) {
    // The count that matters is the reachable-from-elsewhere one. Reporting a
    // total of every listener would bury it - most machines have plenty of
    // loopback listeners and none of them are the point.
    badge.style.display = '';
    badge.textContent = `${totals.all} reachable from your network`;
    badge.classList.toggle('danger', false);
  }

  if (programs.length === 0) {
    body.innerHTML = '<div class="panel-state">Nothing on this PC is waiting for incoming connections.</div>';
    return;
  }

  body.innerHTML = programs
    .map((p) => {
      const ex = LISTENER_EXPOSURE[p.exposure] || LISTENER_EXPOSURE.loopback;
      // A browser opens a WebRTC/QUIC socket per connection, so msedge alone
      // listed 40-odd ephemeral high ports and buried every row under it.
      // Show the first few - they sort low-port first, which is where the
      // recognisable services live - and put the rest in the tooltip. The
      // count is stated, so nothing is silently dropped.
      const ENDPOINT_CAP = 8;
      const all = p.listeners || [];
      const fmt = (l) => `${l.protocol} ${l.address}:${l.port}${l.socketCount > 1 ? ` x${l.socketCount}` : ''}`;
      const shown = all.slice(0, ENDPOINT_CAP);
      const hidden = all.length - shown.length;
      const endpoints = shown
        .map((l) => `${esc(l.protocol)} ${esc(l.address)}:${esc(l.port)}${l.socketCount > 1 ? ` <span class="listener-xn">x${esc(l.socketCount)}</span>` : ''}`)
        .join('<span class="listener-sep">,</span> ')
        + (hidden > 0
          ? `<span class="listener-more" title="${esc(all.map(fmt).join(', '))}"> and ${hidden} more</span>`
          : '');

      // Facts, each of which the user can check, none of which is a verdict.
      const facts = [];
      if (p.isService && p.serviceNames && p.serviceNames.length) {
        facts.push(`Windows service: ${esc(p.serviceNames.join(', '))}`);
      }
      if (p.serviceAccount) {
        facts.push(`Runs as ${esc(p.serviceAccount)}`);
      }
      if (p.startMode) {
        facts.push(`Starts ${esc(String(p.startMode).toLowerCase())}`);
      }

      return `
        <div class="listener-row ${ex.cls}">
          <div class="listener-head">
            <span class="listener-name">${esc(p.name)}</span>
            <span class="listener-pid">PID ${esc(p.pid)}</span>
            <span class="listener-exposure">${esc(ex.label)}</span>
          </div>
          <div class="listener-detail">${esc(ex.detail)}</div>
          <div class="listener-endpoints" title="The sockets this program has open, as Windows reports them.">${endpoints}</div>
          ${facts.length ? `<div class="listener-facts">${facts.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
          <div class="listener-foot">
            ${listenerSignatureLine(p.signature)}
            ${p.path ? `<span class="listener-path" title="${esc(p.path)}">${esc(p.path)}</span>` : ''}
          </div>
        </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 847: the Machine Hygiene card on the landing page.
// ---------------------------------------------------------------------------
//
// Health Advisor is the landing page and Machine Hygiene is the thing nothing
// else in this category does, and until now the landing page did not mention
// it existed. Someone who never clicked the second sidebar entry never learned
// the app can tell them what a delete would destroy.
//
// TWO RULES, both from the issue and both about not claiming more than is due:
//
// 1. A STALE VERDICT PRESENTED AS CURRENT IS WORSE THAN NO VERDICT. The last
//    result is held in memory for this session only, never persisted, and
//    always carries its own age. Persisting it across launches would mean
//    claiming something about a machine that has been installed to, uninstalled
//    from and rebooted since, and the whole point of the hygiene panel is that
//    it makes no claim it has not just earned. Past HYGIENE_CARD_STALE_MS the
//    card stops leading with the verdict and leads with the age instead.
//
// 2. A CARD OFFERING A TEN-MINUTE RUN IS A TRAP. The invitation names the cost
//    in the same breath as the offer rather than after the click.
//
// Reads window.VanishHygieneLastRun, which renderer/hygiene.js sets when and
// only when a scan reaches a terminal decision. If no scan has run this session
// the property is undefined and the card is an invitation, which is correct.

const HYGIENE_CARD_STALE_MS = 30 * 60 * 1000;

function hygieneCardAgeLabel(ms) {
  if (ms < 60 * 1000) return 'just now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function hygieneCardTone(state) {
  const F = window.VanishFindings;
  if (!F) return 'neutral';
  if (state === F.UI_HAS_WORK) return 'work';
  if (state === F.UI_NOTHING_FOUND) return 'clean';
  if (state === F.UI_FAILED) return 'failed';
  return 'neutral';
}

function hygieneCardIcon(state) {
  const F = window.VanishFindings;
  if (!F) return 'fa-layer-group';
  if (state === F.UI_HAS_WORK) return 'fa-circle-exclamation';
  if (state === F.UI_NOTHING_FOUND) return 'fa-circle-check';
  if (state === F.UI_FAILED) return 'fa-circle-xmark';
  return 'fa-circle-question';
}

function renderHygieneCard() {
  const el = document.getElementById('audit-hygiene-body');
  if (!el) return;

  const last = window.VanishHygieneLastRun || null;
  const open = '<button class="btn-sec hygiene-card-open" id="btn-audit-open-hygiene"><i class="fa-solid fa-arrow-right"></i> Open Machine Hygiene</button>';

  if (!last || !last.decision) {
    el.innerHTML = `
      <div class="hygiene-card neutral">
        <div class="hygiene-card-head">
          <i class="fa-solid fa-layer-group"></i>
          <span>These checks have not been run.</span>
        </div>
        <div class="hygiene-card-body">
          Machine Hygiene finds credentials that exist in one place only, work that is not
          committed anywhere, and caches worth reclaiming, and it says what each one would cost
          to get back. Nothing on that screen deletes anything. It reads only, works in Audit
          Mode, and can take several minutes on a disk with many repositories.
        </div>
        <div class="hygiene-card-foot">${open}</div>
      </div>
    `;
  } else {
    const age = Date.now() - last.at;
    const stale = age > HYGIENE_CARD_STALE_MS;
    const d = last.decision;
    const tone = stale ? 'stale' : hygieneCardTone(d.state);
    const icon = stale ? 'fa-clock-rotate-left' : hygieneCardIcon(d.state);

    // When it is stale the AGE leads and the verdict follows as history. A
    // headline reading "Nothing found" at the top of a card is a claim about
    // NOW, and after half an hour of installing and deleting it is not one
    // this app has earned the right to make.
    const head = stale
      ? `Last checked ${hygieneCardAgeLabel(age)}`
      : (d.headline || '');
    const body = stale
      ? `That run said: ${esc(d.headline || '')} This machine may have changed since, so it is
         history rather than a current verdict. Run the checks again for one about now.`
      : `${d.findingCount} finding${d.findingCount === 1 ? '' : 's'} across ${d.examinedCount}
         location${d.examinedCount === 1 ? '' : 's'}${d.unreadableCount > 0
           ? `, and ${d.unreadableCount} that could not be read`
           : ''}. Taken ${hygieneCardAgeLabel(age)}.`;

    el.innerHTML = `
      <div class="hygiene-card ${tone}">
        <div class="hygiene-card-head">
          <i class="fa-solid ${icon}"></i>
          <span>${esc(head)}</span>
        </div>
        <div class="hygiene-card-body">${body}</div>
        <div class="hygiene-card-foot">${open}</div>
      </div>
    `;
  }

  const btn = document.getElementById('btn-audit-open-hygiene');
  if (btn) {
    btn.addEventListener('click', () => {
      if (typeof window.switchTab === 'function') window.switchTab('hygiene');
    });
  }
}

// ---------------------------------------------------------------------------
// 949: the Health Advisor verdict.
// ---------------------------------------------------------------------------
//
// The landing page opened with six cards of hardware specification -- OS, CPU,
// RAM, GPU, motherboard -- and then eight sections, each of which rendered
// itself and none of which said anything about the whole. A page called Health
// Advisor that opens by telling you your own CPU model is not advising; it is
// msinfo32 with rounded corners.
//
// THE RULE THIS FOLLOWS, and it is the one thing that keeps it honest: this
// aggregates only judgements the sections HAVE ALREADY MADE and already show as
// badges. Disks at 90% are already painted 'danger' by renderDiskBars. Broken
// startup entries are already counted into the 'N broken' pill. Redundancy
// groups already subtract the ones you waived. Nothing here scores, ranks, or
// rates anything, because several of these sections refuse to do that on
// purpose -- the listeners panel says so in as many words: 'being reachable is
// not the same as being unsafe, and Vanish does not score or rank these'.
//
// So the verdict is NOT 'your machine is healthy'. It is the same four states
// the finders use: is there work, is there none, or could this page not finish
// looking. A completeness verdict, not a health score.
//
// WHAT DELIBERATELY DOES NOT COUNT AS WORK:
//   listeners        the panel refuses to rank reachability, and a count of
//                    them at the top of the page would rank it by placement.
//   network activity  a rate is not a problem.
//   Windows updates   Windows' business. Shown for context, and 'you have
//                    updates' is not something Vanish is entitled to nag about.
//   system overview   identity, not health.

let auditTally = null;

// The total is DERIVED from the sections array, never written down twice. A
// hardcoded 6 beside a list of six is a mirror, and mirrors drift: the count
// would still read "6 of 6" after a seventh section was added, so the verdict
// would conclude while a section was still running and report a partial page
// as a whole one. Same defect as a test model that stops matching the file it
// models, which this codebase has now been bitten by more than once.
function resetAuditTally(total) {
  auditTally = { settled: 0, total, work: [], blind: [] };
}

// Called by each section as it lands. `items` is a count of things the section
// has ALREADY decided need a look; `label` is how the strip names them.
function auditReportWork(count, label) {
  if (!auditTally) return;
  if (count > 0) auditTally.work.push({ count, label });
}

function auditReportBlind(what) {
  if (!auditTally) return;
  auditTally.blind.push(what);
}

function auditSectionSettled() {
  if (!auditTally) return;
  auditTally.settled += 1;
  renderAuditVerdict();
}

function renderAuditVerdict() {
  const el = document.getElementById('audit-verdict');
  if (!el || !auditTally) return;

  const t = auditTally;
  const done = t.settled >= t.total;

  // While sections are still landing this is PROGRESS and says nothing about
  // the machine. Naming a state here -- especially the reassuring one -- would
  // be concluding from a fraction of the evidence, which is the defect the
  // hygiene panel was rebuilt to make unrepresentable.
  if (!done) {
    el.innerHTML = `
      <div class="audit-verdict checking">
        <div class="audit-verdict-head">
          <i class="fa-solid fa-spinner fa-spin"></i>
          <span>Checking this machine -- ${t.settled} of ${t.total} done</span>
        </div>
      </div>
    `;
    return;
  }

  const totalWork = t.work.reduce((n, w) => n + w.count, 0);
  const parts = t.work.map((w) => `${w.count} ${w.label}`);
  const blindNote = t.blind.length > 0
    ? `${t.blind.length} of ${t.total} check${t.blind.length === 1 ? '' : 's'} could not be read (${t.blind.join('; ')}), so this is not a complete picture.`
    : '';

  let tone;
  let icon;
  let head;
  let body;

  if (totalWork > 0) {
    tone = 'work';
    icon = 'fa-circle-exclamation';
    head = `${totalWork} thing${totalWork === 1 ? '' : 's'} on this page can be acted on`;
    body = `${parts.join(', ')}. ${blindNote}`;
  } else if (t.blind.length > 0) {
    // Nothing found AND something unreadable is NOT a clean machine. This is
    // the distinction the whole project is built on.
    tone = 'incomplete';
    icon = 'fa-circle-question';
    head = 'Nothing needs you in what could be read';
    body = `${blindNote} That is not the same as nothing being wrong.`;
  } else {
    tone = 'clear';
    icon = 'fa-circle-check';
    head = 'Nothing on this page needs a decision';
    body = `All ${t.total} checks read successfully and none of them found anything to act on. `
         + `This page does not check everything -- Machine Hygiene is where the deeper reads live.`;
  }

  el.innerHTML = `
    <div class="audit-verdict ${tone}">
      <div class="audit-verdict-head">
        <i class="fa-solid ${icon}"></i>
        <span>${esc(head)}</span>
      </div>
      <div class="audit-verdict-body">${esc(body)}</div>
    </div>
  `;
}
