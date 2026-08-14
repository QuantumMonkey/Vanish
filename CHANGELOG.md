# Changelog

All notable changes to **Vanish** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
The versioning scheme is `RELEASE.MAJOR.MINOR` — see `docs/RELEASING.md` for the
full decision rules.

---

## [0.6.5] - 2026-08-14

### Added -- click a column header, choose which values to show

Excel-style column filters, on every table in the app that has a header row:

* **All Programs** -- Publisher and Type
* **Task Manager** -- Process and Indicators
* **Health Advisor's startup table** -- Source and Status

A funnel appears on those headers only. Clicking one lists the distinct values
actually present in the current data with a count each, and unchecking a value
hides its rows. Nothing here is a hardcoded list of values, so a filter cannot
drift out of sync with what the engine returns -- and the checklist offers the
words the CELLS show, so Type reads "Windows App" rather than the "UWP" behind
it and Source reads "Task" rather than "TaskScheduler".

CPU, GPU, Memory, Disk I/O and PID deliberately have **no** funnel. A checklist
of distinct values is meaningless for a continuous number -- what those columns
want is a threshold, which is a different control, and putting it behind the same
icon would misrepresent both.

Four decisions in `renderer/column-filter.js` are load-bearing, and each is the
version that fails towards showing too much rather than too little:

* **The state is the set of HIDDEN values, never the set of shown ones.** These
  tables are fed live data. Under "shown value" semantics a process that started
  after the filter was set would be withheld by a filter that has never heard of
  it. Hiding something new is the failure this app cannot afford; showing
  something new is merely untidy.
* **The checklist is built from the view's whole pool, not from the rows that
  survive the filters.** An option list that shrinks as you uncheck things is a
  trap with no way out: the value just hidden would disappear from the only
  control that could bring it back.
* **A row carrying several values survives while ANY of them is shown.** A
  process with two indicators stays visible when one of them is hidden and
  leaves only when both are. Equality would silently under-report exactly the
  processes carrying the most warnings. Rows with no value at all get one
  synthetic "None" bucket, so they can be filtered deliberately instead of being
  unconditionally present.
* **Nothing is persisted.** A filter the user forgot they set, restored quietly
  on the next launch, is the 2026-08-05 silent-search bug with a delay on it.

Every hidden row stays accounted for. The row-count caption now names the columns
doing the hiding ("Showing 12 of 158 programs - filtered by Publisher, Type"),
each active filter also appears as a removable chip above the table, and an
emptied table says which filter emptied it rather than the generic "nothing
matches". Task Manager and the startup table had no caption row at all before
this, which mattered most in Task Manager: it re-samples every two seconds, so a
filtered list was indistinguishable from a machine that had gone quiet. On the
startup table the section's count badge still states the machine's real total,
which is exactly why the filtered table needed a caption of its own.

### Fixed -- a live selection no longer silences the filter caption

`updateBulkSelectUI` tested for a search term and the type toggle, so with only a
column filter active the bulk-selection caption dropped the filter sentence --
the 2026-08-05 bug walking back in through a door that did not exist when the
rule was written. Found by asserting the RULE (any active filter keeps saying so
while a selection is live) instead of the two filters that happened to exist at
the time.

### Added -- 81 assertions, and one icon that would have painted nothing

`test/column-filter-verify.js` drives all three tables through the real DOM: the
two-indicator row, a value that appears in the data after the filter was set, the
checklist that must not shrink, the caption and chip and empty-state wording, the
startup table's action indices surviving a filter (they index the FULL item list,
so filtering has to drop rows without renumbering the survivors), the interaction
with 5rz's multi-select, popover dismissal, and a check that no filter
interaction wrote to settings.

The icon suite caught the other one immediately: `fa-filter` did not exist in the
vendored set, and an undefined glyph in this app does not throw -- it paints a
blank 1em square. Added on the same 24x24 grid as the rest.

Tests: **838 passing, 0 failing** (was 757).

---

## [0.6.4] - 2026-08-14

### Fixed -- the speed test shipped yesterday was wrong by about 20x

0.6.3 measured a fixed 25 MB with `Invoke-WebRequest` and timed the whole
transfer. On the operator's line that reported **10.2 Mbps**. Measured
properly, the same connection does **175-240 Mbps**.

Two mistakes, and the first one caused the second:

* It timed connection setup and TCP slow-start along with the transfer. The
  first few hundred milliseconds are the connection ramping up, not its speed.
* A fixed byte count means the DURATION is whatever the connection decides --
  so it took 21 seconds, and a slow line paid the most data for the least
  useful answer.

It now reads the stream directly and stops at whichever comes first: a time
limit (5s down, 3s up) or a byte cap (40 MB / 10 MB). It counts only what
arrived after a 600 ms warm-up window. **6 seconds instead of 21**, and on a
slow connection it uses far less data than before rather than more.

One wrong turn worth recording: the first attempt returned 403 and the guess
was a missing User-Agent. That was wrong -- a request with no User-Agent is
served fine. Cloudflare caps the `bytes` parameter somewhere between 50 MB and
100 MB, and the request had asked for 200 MB. The User-Agent stayed anyway,
because a program making automated requests should say what it is, but its
comment now says that rather than claiming a fix it never made.

### Changed -- one tap refreshes everything

Operator: *"i need them all to be unified. one tap refreshes everything."*

Throughput, ping and line speed had three separate triggers, so the tiles
showed three readings from three different moments sitting side by side. That
looked like one measurement and was not.

**Measure again** now refreshes all of them. Ping and the speed test run only
where they have already been agreed to -- a refresh button must never be the
thing that first puts traffic on the wire.

### Changed -- the elevation prompt no longer meets you at the door

Operator: *"opening vanish shouldnt immediately throw this dialog in my face,
thats what the banner and button are for."*

A modal that opens before you have asked for anything is not consent, it is a
toll gate. It now appears at the three moments it is relevant: the banner
button (choice), and a blocked Full Mode action (gating, necessity). Being
refused now *offers* elevation rather than only complaining and leaving you to
find the banner yourself.

The UI suite asserted the opposite, so the contract was inverted rather than
deleted, and the replacement is stricter: the app must be usable the instant it
opens, and the offer must still be reachable both ways.

---

## [0.6.3] - 2026-08-14

### Added -- measure how fast the connection actually is

The rate tiles say what is crossing the wire right now. They cannot answer
"how fast is my connection", and neither can the link rate -- that is the
negotiated speed to the router, 866.7 Mbps on the machine this was built
against, while the line delivered 10.2 Mbps. Those numbers have nothing to do
with each other, and until now Vanish had no way to say so with evidence.

A **Measure line speed** tile now downloads about 25 MB from
speed.cloudflare.com and uploads about 5 MB back, and times both.

**This is the second thing Vanish can put on the network, and it is a bigger
one than the first.** It is off until agreed to, by a consent separate from the
ping's -- a single ICMP echo to your own router and a 30 MB transfer to a
company in another country are not the same act, and one checkbox covering both
would be consent by sleight of hand.

The dialog names the endpoint, the payload size, and the consequence, because
"this may use data" is not consent to 30 MB. What Cloudflare sees: this PC's IP
address and a few seconds of traffic -- no account, no identifier, nothing about
the machine. The bytes are random one way and discarded the other, so they
carry nothing of yours. The result is shown and never saved, logged or sent.

The measurement is honest about its own limits: anything else using the network
at the time, **including this PC**, makes it read lower, and the tile says so.

### Changed -- the privacy claim was about to become false, and was fixed first

The ping consent dialog said *"This is the only network traffic Vanish ever
sends."* Adding a speed test would have made that a lie the app tells while
asking for permission. Both it and the About page now name **two** exceptions,
state that accepting one does not accept the other, and note that neither ever
runs automatically or on a timer.

A privacy claim that quietly stops being true is worse than one that was never
made.

### The guard was widened deliberately, not removed

`test/network-verify.ps1` greps the engine for outbound-call APIs and fails if
it finds one. `Invoke-WebRequest` left that ban list -- and picked up stricter
assertions than the flat ban it replaced, since a flat ban is trivially
satisfied by reaching for a different API:

* it appears **exactly twice**, and both live inside `Invoke-NetworkSpeedTest`
* the only host it may contact is `speed.cloudflare.com`
* `main.js` refuses the request unless consent is recorded, **independently of
  the renderer** -- the UI gate explains, this one locks
* nothing schedules it

Adding a third outbound call still means changing an assertion by hand. The
suite went from 41 checks to 47.

---

## [0.6.2] - 2026-08-14

### Fixed -- a BitTorrent client looked idle while saturating the link

Operator: *"the network says idle when i am using the bittorent protocol."*

Measured on their running qBittorrent:

| What | Count |
| --- | --- |
| TCP ESTABLISHED (all Vanish counted) | 4 |
| TCP, every state | 15 |
| UDP sockets | 21 |

BitTorrent moves most of its data over uTP, which is UDP, and finds peers over
UDP DHT. Counting only established TCP described a client moving real traffic
as a near-idle process with four connections, and sorting on that number put it
below a browser tab.

UDP sockets and non-established TCP are now counted and shown. They are
**reported separately and never added into the connection count** -- a UDP row
is a socket, not a conversation, and "37 connections" would be a tidier number
that means less. The list now sorts on total sockets.

### Added -- a Stop button on each network row

Elevation-gated like every other destructive control, and visible-but-inert in
Audit Mode with the reason rather than hidden.

The confirmation is not one fixed sentence. Where Vanish already knows what the
program is -- the same knowledge that prints "normal for a web browser" beside a
high connection count -- it says so **before** asking, because that is the fact
most likely to change the answer. Where it does not know, it says that outright
rather than inventing either a reassurance or a warning. Every dialog states
what is actually lost: unsaved work, transfers that will not resume, and that
this is not a removal and Quarantine cannot undo it.

### Changed -- the rate tiles say what they actually measure

They read **Downloading now** and **Uploading now**. They were labelled
"Download" and "Upload", which a reasonable person reads as *how fast my
connection is* -- and they are not that. They are what crossed the wire during
the last sample.

The negotiated link rate to the router is now shown as its own separate figure,
because stating it explicitly is what stops the throughput number being read as
capacity. On the machine this was built against those are 866.7 Mbps (link) and
a few KB/s (actual) -- numbers with nothing to do with each other.

**Vanish still does not measure connection capacity, and this release does not
pretend to.** Finding out how fast a connection can go means saturating it
against someone else's server, which is outbound network I/O to a third party --
the one thing this app promises not to do without asking. That is a decision
for the operator, not a default.

---

## [0.6.1] - 2026-08-14

### Added -- startup items split into what you can act on and what the machine needs (`tda`)

Operator, 2026-08-13: *"could you categorize startup items as killable and
necessary? that way necessary things could be hidden behind a collapsible
section and not seen as a massive list."*

Forty-one entries in one undifferentiated list reads as "all of this is
suspicious", which is the opposite of what this app is for. The list now leads
with the entries a person can actually act on; the rest collapse behind a row
that states its own count.

On the machine this was built against that is 23 visible and 18 collapsed.

**This is the first place in Vanish allowed a publisher allowlist, and the
permission is deliberately narrow.** Rule 6 forbids one; the operator
authorised an amendment scoped to *which visual group an entry is drawn in*
and nothing else. It may never be consulted to permit or block a removal.
`test/startup-groups-verify.js` asserts the list is referenced only where it is
defined and used -- if that count changes, the amendment has quietly widened.

**The wording carries the whole design.** "Necessary" means *do not touch this
without knowing what you are doing*. The words "trusted" and "safe" appear
nowhere and are asserted against, because both would be claims about the
software rather than about what happens if you switch it off. The case that
makes the distinction matter is the operator's own: on a corporate machine the
monitoring agent belongs in the collapsed group **precisely because disabling
it is a disciplinary event**, not because it is benign.

Anything Vanish cannot classify stays **visible**, labelled "Vanish has no
opinion" rather than left blank -- a blank reads as approval, and hiding what it
cannot explain is how a cleaner ends up disabling something that mattered.

**The first implementation got this wrong in the most instructive way.** It
treated any non-zero `EnrollmentType` under `HKLM\SOFTWARE\Microsoft\Enrollments`
as MDM enrolment. Measured on an ordinary personal machine: **34 such keys**,
mostly `EnrollmentType=1` with no provider, plus Windows' own "Local Authority"
and "Cloud Authority" bookkeeping. Every one of them read as "this is a
corporate machine" -- which then swept all three RealPlayer startup entries into
the hidden group and told the operator they were placed by whoever administers
the PC. About software they had just asked to get rid of. Precisely inverted.

Two fixes: MDM detection now requires a real provider plus a subject or a
discovery URL, and -- more importantly -- `managed` now requires the entry to
sit under a **Policies key**. "The machine looks managed" is a fact about the
machine and says nothing about who put *this particular program* in Run.
Evidence about the entry, not a proxy.

The counterexample is kept in the code and the tests: RealPlayer runs as
LocalSystem with auto-start and would score "necessary" on that signal alone,
so LocalSystem is treated as a **weak** signal that never decides anything by
itself.

### Fixed -- the elevated confirmation runner lost every parameter

Its first real run reported four separate engine failures. It was one harness
bug: the Windows command-line parser strips double quotes, so `scanner.ps1`
received `{valueName:...}` instead of JSON and every parameter arrived empty.

Two assertions in that run are worth recording because they *passed*:

* The network-hold revert checks reported success while nothing had ever been
  applied -- "the value is GONE after release" is trivially true when nothing
  set it. They are now skipped, loudly, unless the apply succeeded. An
  assertion that reads green in exactly the situation you need it to read red
  is worse than no assertion.
* `phase4-ipc-verify`'s byte-for-byte check compared a restored file against a
  hardcoded 4096 bytes. The file is 4098 -- `Set-Content` appends a line
  terminator -- so it had never been true, and it would have **passed** if the
  vault had truncated the file to exactly 4096, which is the one outcome it
  existed to catch. It now hashes the file before the purge and compares
  against that. The vault itself was never at fault.

---

## [0.6.0] - 2026-08-14

### Added -- what can be reached from outside (`ddx`)

Vanish could tell you who a program was **talking to**. It could not tell you
who could **start a conversation with it**, and the second is the
security-relevant question.

This feature exists because of a wrong answer. Asked about `rpdsvc` with 54
open connections, the answer given was "Remote Desktop, all loopback, nothing
leaving the machine". The connections really were all loopback. It was also
listening on `0.0.0.0:20121` as LocalSystem, it was not Remote Desktop at all
-- it is RealPlayer's -- and Remote Desktop was disabled on that machine
anyway. Every individual fact offered was true and the conclusion was wrong.

The new Health Advisor section lists every program waiting for an incoming
connection, and says in plain language who can reach it:

* **Reachable from your network** -- bound to `0.0.0.0` or `::`
* **Reachable on one network** -- bound to one specific interface
* **This PC only** -- loopback, visually recessed because it is the
  uninteresting case and should look it

Each row names the owning program, the service behind it, the account it runs
as, whether it starts automatically, and the actual sockets as evidence beside
the claim rather than instead of it.

**What it refuses to do is the design.** No score, no rank, no "dangerous"
label. Being reachable is not the same as being unsafe and Vanish cannot tell
the difference from here -- the defensible claim is "this is reachable", and
anything stronger would be invented. The panel says so in as many words.

**Signature and exposure are always shown together.** Showing only "signed by
RealNetworks" is reassurance theatre; showing only "SYSTEM, listening on every
interface" is scaremongering. Both are true at once. Signed means the software
is authentic, **not** that it is safe, and the UI says that where a user will
find it. LocalSystem is reported as a fact and never editorialised into a
warning -- most of Windows runs as LocalSystem.

On the machine this was built against it produces, unprompted:

> **rpdsvc** -- Reachable from your network -- `TCP :::20121, TCP 0.0.0.0:20121`
> -- Windows service: RealTimes Desktop Service -- Runs as LocalSystem -- Starts
> auto -- Signed by RealNetworks LLC (EV)

That is a sentence nothing else on the machine assembles.

Read-only by design: anything actionable routes through the startup and service
controls that already exist. Available in **both** tiers on purpose -- Audit
Mode is where a cautious user sits, and this is exactly the question they are
sitting there to ask.

One detail worth recording: a SYSTEM service will not tell an unelevated caller
its own binary path, so in Audit Mode every such service came back unsigned --
including `rpdsvc`, the case the whole feature was built for. `Win32_Service`
reports the same path and needs no elevation, so it is used as the fallback and
15 of 19 externally-bound programs now resolve a signature in Audit Mode. The
remaining four are kernel processes with genuinely no readable path, and they
say "not checked" rather than reporting a reassuring default.

### Fixed -- a busy machine no longer blanks the GPU column

The GPU Engine performance counter throws under load, which is precisely when
someone opens a task manager. The engine reported the failure honestly and the
whole column went blank for that sample. It now retries once before reporting,
and still reports honestly if the retry fails too -- a second attempt, not a
pretence that the first worked. Reproduced by running two Electron suites
alongside it, and the retry holds under the same load.

---

## [0.5.3] - 2026-08-13

### Fixed -- the GPU column named the wrong card (`02f`)

Reported by screenshot, Vanish beside Windows Task Manager: Windows showed the
NVIDIA RTX 3080 doing the work, Vanish showed one pill reading "GPU 0: 20%" and
gave dota2 a **red AMD logo**.

The raw counters on that machine:

| LUID | phys | load | adapter |
| --- | --- | --- | --- |
| `0x0000ed1f` | `phys_0` | 29.3% | AMD Radeon(TM) Graphics |
| `0x0000fa2a` | `phys_0` | 0.0% | Microsoft Basic Render Driver |
| `0x0000fa8e` | `phys_0` | 19.3% | NVIDIA GeForce RTX 3080 Laptop GPU |

Three adapters, **all reporting `phys_0`**. `phys_N` is the physical index
within an adapter's own group, not a global GPU ordinal, so on an ordinary
machine it is 0 for everything. Keying on it merged all three cards into one
bucket called "GPU 0", summed their percentages, and gave the merged result
whichever LUID happened to arrive first. AMD sorted first, so every process got
an AMD logo no matter which card did the work.

The code had already worked this out and then did the opposite. Its own comment
reads: *"phys_N is an ordinal into whichever adapters happen to have an active
engine RIGHT NOW, not a stable identity ... the LUID IS the stable per-boot
adapter identity"* -- and then every collection was keyed by `physIdx`.

Everything joins on the LUID now. `physIndex` is still reported because it is
real, but as an attribute rather than a name.

**This mattered more than a cosmetic mislabel.** It was a confident wrong
answer about something the user can check against Task Manager in five seconds
-- the same fault `c0y` exists to prevent, and a worse version of it, because a
guessed install date at least admits to being a date.

### Fixed -- the vendor lookup raced the page it read

`chrome://gpu` populates asynchronously, and the vendor fetch read it the
instant `loadURL` resolved. The placeholder it got back, verbatim:
`VENDOR= 0x0000, DEVICE=0x0000, LUID={0,0}`. That parses to nothing, so the
vendor list came back empty, every adapter lost its name, and every GPU icon
fell back to the generic chip with no error anywhere.

It polls for real content now, with an 8-second ceiling, rather than sleeping a
fixed amount -- the wait is as short as the machine allows, and slow hardware
gets the time it needs instead of a guess that is too short on exactly the
machines that need it most.

### Changed -- adapters are named, and the unnameable say so

The summary pills read `AMD Radeon: 10%`, `NVIDIA GeForce RTX 3080: 64%` rather
than three identical "GPU 0" labels, with the full descriptor in the tooltip.

The Microsoft Basic Render Driver used to be dropped from the vendor map as
"not a real GPU". It is not a real GPU, and it **is** a real adapter -- the
counters report work against its LUID -- so dropping it never hid it, it just
left it anonymous. It is named now, with the neutral chip rather than a card
maker's logo. An adapter Vanish genuinely cannot identify says
"Unrecognised adapter" instead of inventing an ordinal that reads like a name.

---

## [0.5.2] - 2026-08-13

### Fixed -- de-elevation actually de-elevates (`9vp`)

Five sessions of investigation ended in one measurement. Run from an elevated
shell on the operator's machine, `test/deelevation-probe.ps1` tried three ways
of starting a process without the privilege the caller holds:

| Mechanism | Result |
| --- | --- |
| `runas.exe /trustlevel:0x20000` | no result, exit 1 |
| explorer token via `CreateProcessWithTokenW` | no result, child died `0xc0000142` |
| scheduled task at `RunLevel Limited` | **dropped privilege** -- Medium Mandatory Level, `S-1-16-8192` |

`runas /trustlevel` is the Windows-documented mechanism for exactly this
operation, dating to the original UAC design, and it does not work here. In the
app it did something worse than fail: it **exited 0**, so 0.5.0 reported a
successful de-elevation and came back in Full Mode. That is the
`relaunch-deelevated-mismatch` in the operator's oplog at 14:17:31.

So the scheduled task leads now and `runas` is the fallback rather than the
reverse. `runas` is kept because it is documented, needs no task registration,
and may well work where SAFER policy is intact -- but it has to prove itself.

**A launch is no longer a success until a process exists.** Both mechanisms now
wait for a new process for that executable and report its PID. An exit code
proved nothing, which is precisely how this survived five sessions, and it is
not accepted as evidence by either path any more.

Two details that would have bitten later, both asserted in the suite:

* The task is registered with an **unlimited** execution time limit. The default
  is 72 hours, after which Task Scheduler would have terminated the app out
  from under anyone who simply left it open.
* The task is unregistered in a `finally`. The launched process is independent
  of it, so cleanup costs nothing -- and a task left behind would appear in the
  user's Task Scheduler as something Vanish installed, which is the exact kind
  of residue this app exists to object to.

**The record now says which mechanism ran.** The 2026-08-13 oplog entry said
only `success` and left five sessions with nothing to work from. Both the
relaunch-intent marker and the oplog carry the method, the PID, and -- when
everything fails -- the reason from *both* attempts rather than only the last.

### Still open

The operator also reported that "Restart as administrator" from the Audit Mode
banner comes back in Audit Mode. That is filed separately (`adg`) with its
evidence gap stated rather than a cause invented: the oplog carries no
`relaunch-elevated` entry at all, and no `app-start` at `tier=audit` since
2026-08-07, so the banner should not have been on screen to click. The likeliest
reading is that it was this same fault seen from the other side -- the app never
reached Audit Mode -- in which case it closes with this fix. That is a
hypothesis and is labelled as one.

---

## [0.5.1] - 2026-08-13

### Fixed -- every per-process GPU figure was missing, and 0.5.0 shipped it

A regression, caught by the operator within an hour of release: the adapter
summary pill read "GPU 0: 57%" above a table in which every single row showed
`0%` or a dash.

The `aaw` work changed the accumulator inside `Get-GpuUsageByProcess` from a
plain number to `@{ total; adapters }`, so the table could name *which* card a
process was using. The projection that builds the returned map was not changed
with it, and went on doing `[Math]::Min(100, $byPid[$k])` against what was now
a hashtable. That throws once per running process, so the map came back empty
and the renderer had nothing to draw.

**Why it survived a release is the part worth keeping.** It looked half-alive
rather than broken: the per-adapter totals are a separate accumulator that is
still a plain number, so the summary pill kept reporting a perfectly correct
percentage above a table claiming nothing was using the GPU. A feature that is
visibly working in one place is the easiest kind of broken to miss. The
PowerShell error was non-fatal too -- it printed to the stream and the function
returned anyway, so nothing crashed and nothing was logged.

Nothing asserted the payload contract between engine and renderer.
`test/gpu-shape-verify.js` does now, and checks the specific way this hid: that
the engine emits no PowerShell error text at all, on top of the shape itself.

Verified live: the engine returns `{"33844":{"total":14,"adapters":{"0":14}}}`,
and fed through the real renderer that produces the NVIDIA icon and `14.0%`,
joined to the physical adapter on its LUID.

### Note -- de-elevation is now understood, and is not fixed here

0.5.0 asked for one round trip. It happened, and `1dq`'s instrumentation did
exactly what it was built to do -- the first mismatch record ever captured:

```
14:16:56  relaunch-deelevated           success   trigger=user-click
14:17:31  relaunch-deelevated-mismatch  error     direction=deelevate
          wantedTier=audit  landedTier=full  msSinceAttempt=34537
```

`runas.exe` accepted the request and exited 0, and Windows started the process
**elevated anyway**. The mechanism is wrong rather than broken. The app's own
auto-elevate path is ruled out on evidence -- `startupMode` was already
`audit`, and that is the only `startupMode` read in the entire main process.

This also corrects the working assumption that the Settings toggle "now works":
this machine has not reached Audit Mode since 2026-08-07. Every `app-start`
since is `tier=full`. What changed in 0.5.0 is that the app stopped claiming
otherwise.

`test/deelevation-probe.ps1` settles which mechanism actually drops privilege
here -- `runas /trustlevel`, the shell token via `CreateProcessWithTokenW`, or a
scheduled task at limited run level. It refuses to run unelevated, because from
an unelevated shell all three would "succeed" with no privilege to drop.

---

## [0.5.0] - 2026-08-13

### Added -- UAC that is off, and UAC you are not allowed to turn on (`qyt`)

Vanish could already see that User Account Control was disabled. It treated
every disabled machine the same, and told all of them to turn it back on.

* On a domain-joined machine managed by Group Policy, `EnableLUA` is very
  often force-set, and a local admin who changes it by hand watches it revert
  at the next policy refresh. "Turn UAC back on" is useful advice on a
  personal machine and sends a corporate user in a circle.
* Vanish now reports these as two separate causes and words them differently.
  The managed one says the setting is **likely** enforced by your
  organisation's policy, and points at whoever administers the PC.

**"Likely" is the whole design, not hedging.** Windows does not record
policy-origin on these registry values, so there is no flag that says "Group
Policy did this". What Vanish actually knows is narrower than the conclusion:
the machine is domain-joined, and an administrator token could not write the
policy key. That is strong evidence and it is not proof, and the wording is
not permitted to promote one to the other.

Two changes from how this was specified, both about not overclaiming:

* **The writability probe only runs when Vanish is already elevated.** An
  unelevated process cannot write `HKLM` under any circumstances, so probing
  from Audit Mode would have reported "locked by policy" on every ordinary
  home machine in the world. Unelevated, the answer is `null` -- unknown, not
  false. Checked live on this machine: not domain-joined, unelevated, and it
  correctly claims nothing.
* **It writes a scratch value and removes it, rather than toggling `EnableLUA`
  and reverting.** Same key, same ACL, same answer -- but a failure halfway
  through leaves a stray registry value instead of a machine with UAC off.

### Fixed -- the Task Manager pane no longer sits on the Indicators column (`5z5`)

The reported symptom was the details pane painting over the process table. It
was not. Measured at the reported 1110x741 with a row selected: the container
correctly shrank to 544px and **the table stayed at its 602px min-content**,
overflowing into a horizontal scroller nobody notices, with Indicators clipped
mid-word exactly where the pane begins. `min-width: 0` had already been tried,
and the container was never what was at fault.

* Both tables are `table-layout: fixed` now, so a table is exactly as wide as
  its container at any window size and cannot overflow. The Process column
  ellipsises and carries the full name in its tooltip -- it is the one column
  whose content has no natural bound.
* Column widths were rebalanced against the narrow state, and headers may wrap
  rather than truncate, so no column name renders cut in half.
* A selected pane got its padding back. Its base rule set `padding: 0` and the
  `.active` rule never restored it, so the labels sat flush against the glass
  edge -- plain in a screenshot, invisible to every width measurement.

**This bug was reported twice because it was fixed once.** An earlier fix
carried a comment saying it was scoped to the All Programs sidebar "since that
is what was reported", explicitly leaving Task Manager alone. A fix whose
comment names the sibling it skipped is a bug filed in prose instead of in the
tracker. The collapse behaviour now belongs to the shared `.details-panel`
class, the process pane declares nothing about its own width, and
`test/details-panel-layout-verify.js` holds **both** panels to the rule at four
window widths.

That test earned its keep immediately. It found the same overflow in All
Programs, which had never shown up by hand because its Name and Publisher
columns are usually prose and wrap; seed it with an app whose name has no
spaces and it overflowed at three of the four widths. It also found that
`.apps-list-container` was missing the `min-width: 0` its sibling had carried
for months -- the same omission, a third time, in the same file.

### Fixed -- a guessed install date no longer looks like a recorded one (`c0y`)

Found by auditing our own code for a mistake made in conversation: an install
date read off an adjacent registry row and stated as fact, for a program whose
`InstallDate` value is empty.

Vanish had a guarded version of the same move in **two** places and labelled
neither. A program that records no install date falls back to its uninstall key
name when that name is eight digits; a Store app, which never records one,
falls back to its install folder's creation time. Both are good estimates.
Neither is a date the program recorded, and both used to render in the same
text and the same styling as one that was -- so anyone sorting by age was
mixing measurements with guesses and was not told which was which.

* Dates now travel with their provenance. An inferred one is marked in the list
  and spelled out as `(approx.)` in the details pane, with a tooltip naming
  where it actually came from.
* **The fallback stays.** A probable date beats "Unknown". It just has to admit
  what it is -- the same rule the owned/orphaned/unattributed sizes already
  follow.
* A date arriving with no provenance at all is treated as inferred, never
  silently promoted to recorded.
* Sorting is unchanged, and sorts on the value rather than the marker.

### Changed -- the GPU column leads with the card, not the number

The adapter icon moved in front of the percentage. Which card is doing the work
is what qualifies the figure, so it belongs in front of it the way a currency
symbol does, rather than trailing it like a footnote. It stays an icon rather
than a spelled-out vendor name: "NVIDIA" in a column that narrow wraps to a
second line and makes every row taller for a word the icon colour already
carries. The column was widened so the icon and the figure always share one
line.

### Still unproven, and stated plainly

`1dq` shipped **detection**, not a proven mechanism fix. Vanish can no longer
claim a tier switch happened when it did not -- it waits for `runas`, reads its
exit code, records the direction it intended, and compares where it landed on
the next boot. Whether `runas /trustlevel:0x20000` actually drops privilege on a
given machine is **still not confirmed**, and one operator round trip is what
settles it. Until then this release is honest about elevation reporting, not
proven correct about elevation.

---

## [0.4.0] - 2026-08-13

### Added — watch an install, and see what it left behind (`zrw`, `bu2`)

Two features that only make sense together, both in **System Clean**.

* **Watch an install** takes a reading of the Run hives, the top level of the
  program and app-data folders, services and uninstall entries; you run the
  installer yourself; a second reading reports the difference in real numbers.
  Windows does not answer "what did that installer actually change", and the
  tools that used to (InstallWatch, ZSoft Uninstaller) are dead with nothing in
  their place. It is a **comparison, not a recording** — anything created and
  deleted in between is invisible to it, and the panel says so rather than
  implying completeness.
* **Where your disk space went** matches every top-level program folder against
  the programs actually installed. Every disk-usage tool can tell you a folder
  is 12 GB; none can tell you *whose* it was, because none has an uninstall
  database. Vanish has one.
* The distinction the second feature is built around: **"left behind" and
  "unexplained" are different claims and are never merged.** Left behind is
  positive — Vanish watched the install and the program is gone — and is only
  ever said on recorded evidence. A folder that was watched but whose owner was
  never resolved stays *unexplained*, because calling it orphaned would invent
  the fact that makes the word mean anything. A tool that guessed here would
  eventually put a delete button next to something you needed.
* Nothing is auto-proposed for deletion, there is no one-click clean, and
  removal still goes through the same ticked-checkbox quarantine path as
  everything else.

**Two defects found by running it against a real machine rather than by testing
it.** 134 of 233 folders came back unexplained, because a program registered
*beneath* a publisher folder (Brave lives in
`BraveSoftware\Brave-Browser\Application`) made the scanned folder an ancestor
of the registered location, and concatenated folder names never split into
tokens — both now matched, unexplained fell to 107 and matched rose to 93. And
measurement took 62 seconds against a 12 GB WSL tree and an npm cache of
hundreds of thousands of files, so it now runs under a 20-second budget:
anything past it is reported **unmeasured, with the reason**, never truncated or
shown as small. A false zero is a number you would act on.

### Fixed — the bulk queue no longer blames an uninstaller that never ran (`8ns`)

* A Steam game came back "needs attention — the uninstaller did not finish on
  its own", with a Retry button. Both were wrong in the worst way this app can
  be wrong: they told you to do something that cannot work. A Steam game's
  uninstall string is `steam.exe`, not a per-app uninstaller, so there is no
  silent switch to find and retrying produces the identical non-result.
* Six storefronts are now recognised (Steam, Epic, GOG Galaxy, Battle.net,
  Ubisoft Connect, EA app). On a match Vanish names the platform, says why it
  stopped rather than implying it failed, gives the route that actually works,
  and **withholds Retry** instead of leaving it there to disappoint.
* Detection is deliberately conservative: a program merely *named* "Steamy
  Software" is not a Steam game. Suppressing Retry on something that could have
  retried is its own kind of wrong answer.

### Changed — the renderer is seven modules instead of one 5,500-line file

* `renderer.js` had grown to 5,518 lines and 148 functions covering every
  screen. Split by feature into `renderer/`: core, settings-about, wizard,
  audit, quarantine-tasks, queue-clean, force-tour.
* A **pure file split**, not a rewrite: the old file had exactly two top-level
  executable statements, both `DOMContentLoaded` listeners that run after every
  script has loaded. Classic scripts share one global lexical environment, so
  cross-file references resolve exactly as before. No bundler, no imports, no
  behaviour change — and the suite total is identical either side of it.
* Three references to the vanished filename would each have failed differently:
  `package.json` would have shipped a build whose `index.html` loads seven
  scripts that were never packaged (a blank window, visible only in a packaged
  run); a PowerShell suite crashed loudly, which is the correct failure and how
  it was caught; and the icon checker would have gone on reporting PASS over a
  fraction of the UI. All three fixed, and the two checkers now *discover*
  renderer files rather than naming them.

### Security — the new read-only surfaces are regressed, not just asserted

* `measure-paths` is the first engine command to take a caller-supplied path
  **list** rather than one validated target, so the base64-JSON parameter
  boundary was re-proven for it with a canary rather than assumed to carry over.
* 14 new assertions covering: nothing is written or executed, a missing path
  reports a null size rather than 0 bytes, an empty list does not throw, and
  `Measure-Paths` statically contains no `Invoke-Expression`/`Start-Process`/
  `cmd.exe` and no write cmdlet at all.
* Placed **above** the elevation gate on purpose: they had been written inside
  the elevated-only section, which would have meant the Audit Mode read-only
  promise was regressed exactly never — Audit Mode being the tier the promise is
  about.
* Review finding, recorded because a negative result is still a result: all 17
  mutating IPC channels are gated through `fullModeOnly`, and every ungated
  channel is a read. `set-settings` is ungated and correctly so — it can ask for
  elevation at the next launch but grants none, and the channel that creates the
  scheduled task is gated.


### Added — multi-select and bulk "Add N to queue" in All Programs (`5rz`)

* Building a bulk queue used to be N × (click a row → wait for the details
  sidebar → click Add), for a feature whose name is "Bulk uninstall queue".
  All Programs now has a checkbox column, shift-click range selection, a
  select-all header box, and a persistent **Add N to queue** action stating
  on the button itself how many programs it will act on.
* **Checking a box and opening a row stay separate gestures.** Ticking a
  checkbox does not swap the details sidebar out from under a selection
  being built, and opening a row does not tick its box.
* **Select-all means the rows you can see.** It covers the currently
  rendered — filtered and sorted — list, never the full one, and any row a
  filter later hides is dropped from the selection rather than queued
  unseen. Filter to a publisher or a type, select all, queue.
* **Refusals are named, not silent.** The protected/Windows-feature check is
  now one shared classifier used by both the single-item and the bulk path,
  so the two cannot drift onto different wording. A bulk add reports one
  summary naming what was refused and why; guarded entries never reach the
  queue at all.
* A re-sort keeps the same programs selected. The shift-click anchor is
  deliberately dropped by a re-sort, because it is a *position* and the rows
  have moved.

### Fixed — three defects surfaced by the column above

* **Date and Size could wrap again** (`ri6` regression). That fix pinned
  them by column position; a new leading checkbox column shifted every later
  column by one, so it had silently started pinning Type and Date instead.
  Positional CSS selectors do not error when a column is inserted — they
  just start describing different columns.
* **An active filter went quiet while rows were selected.** The selection
  caption and the filter caption share one slot, so a live selection hid
  "Showing 5 of 163 programs" entirely — the exact 2026-08-05 bug where a
  filter said nothing about itself. The selection caption now carries that
  sentence for as long as it holds the slot.
* **A selected Windows optional feature could vanish from the report.** The
  bulk add resolved selections against the applications list only, so a
  feature row would have been dropped from *both* the added count and the
  skipped list. It is now resolved against everything the table can render.

### Added — restart back to Audit Mode, without closing the app (`dtd`)

* Turning the startup-elevation setting off used to mean quitting and
  relaunching the exe by hand to actually leave Full Mode. There is now a
  **Restart now** button beside the toggle.
* Shipped on the second implementation. The first used the
  `Shell.Application` "ask explorer to launch it" trick, which looked
  correct and passed every check available without real elevation, then
  **failed a live elevated test** — it relaunched and came back still
  elevated. The shipped version uses `runas.exe /trustlevel:0x20000`, the
  documented Windows mechanism for dropping privilege, and was confirmed
  live: a real, UAC-free de-elevation round trip.

### Added — silent or interactive uninstall, and which switch was used (`d6y`)

* The wizard's native-uninstaller screen has a **Run the uninstaller
  silently** toggle, remembered between runs. The completion toast now names
  whether the silent switch was a *verified* one (from `corrections.json`)
  or a *guessed* one (the Rule 15 heuristic), and says so when the
  uninstaller opened its own window regardless.
* The bulk queue is deliberately untouched: running unattended is its entire
  point, so it keeps its always-silent-with-fallback behaviour rather than
  gaining a per-item prompt that would defeat walking away from it.

### Added — evidence for the elevation-relaunch loop (`6lg`)

* Not a fix. "Restart as administrator" has intermittently closed and
  reopened the app in Audit Mode with no prompt, no crash and nothing to
  explain it, and one inconclusive PowerShell test was not proof of where
  the fault lies. A relaunch that reports success but comes back
  unelevated now raises an explicit toast on the very next launch and logs a
  `relaunch-elevated-mismatch` oplog entry with a full UAC diagnostics
  snapshot — so the next occurrence produces evidence instead of another
  guess.

### Added — manual-tap ping (`kp0`)

* Asked three times; accepted this session as one deliberate, tightly
  scoped exception to "zero network I/O", not a reopening of it. A fourth
  tile next to Download/Upload/Adapter sends a single ICMP echo — **only**
  when tapped, never on a timer or automatically. Defaults to the current
  adapter's own gateway address, shown and editable — never a hardcoded
  third-party IP. First tap explains what is sent and where, and is
  remembered after being *given*, not merely seen; declining asks again
  next time. The About page's absolute privacy promise is now stated
  separately from this one named exception, in both places that claim it.
* `test/network-verify.ps1`'s zero-network-I/O invariant was **rewritten,
  not weakened**: every other outbound call stays an absolute, grep-checked
  ban, and the one permitted call is asserted to exist exactly once, inside
  the function that *is* the ping action, comment text excluded from the
  count. 39/0 in that suite, including a real round trip against loopback
  and a guaranteed-unreachable test address.

### Fixed — the operator's punch list from the installed build

Twelve issues reported after installing and using the sent executable, plus
three found while fixing them. The recurring theme the operator named twice
was honesty: several screens stated more certainty than the data supported.

* **Uninstall completion screen no longer overclaims** (`xw2`). A run where
  0 items moved to quarantine used the partial-success wording and showed
  "Unknown" freed. Nothing moving is a failure, not a lesser success: it now
  has its own state — "Nothing was moved to quarantine", failed styling, and
  an explicit "0 B".
* **"Left in place" failures are reachable** (`vej`). The per-item reason was
  always rendered; the completion screen had no `overflow-y`, so an
  ancestor's `overflow: hidden` clipped it off the fixed-height wizard with
  no way to scroll to it.
* **Network Activity stops calling a quiet sample an idle machine** (`h8j`).
  The verdict is computed from a ~1s byte-rate sample, which can land in a
  gap of genuinely bursty traffic. With programs holding open connections it
  now reads "Low traffic in this sample — not necessarily idle" and states
  the sample length; the confident "Nothing on this PC is using the network"
  is reserved for a quiet sample with *no* open connections.
* **A high connection count is explained, not just counted** (`hks`). 54
  open connections on one program read as alarming with no context. A local
  process-kind classifier (browsers, sync clients, launchers, security
  software, updaters, dev tools…) explains what is normal for that kind of
  program — visible in-row above 10 connections, in a tooltip always. No
  risk score, no safe/unsafe verdict, no trusted-process list (Rule 6), and
  no lookups of any kind (INV-4). An unrecognised program is explicitly
  described as meaning nothing either way.
* **GPU column says which kind of nothing it means** (`3nd`). The engine
  drops zero readings, so one "-" meant both "measured, idle" and "never
  measured". Now three distinct states — "measuring…", an honest "0%", and
  "-" only for a process newer than the last sample — plus a visible note
  and header tooltip stating the 15s cadence and that the percentage sums
  across the GPU's engines.
* **Guided tour's welcome step is readable** (`0ct`). The step with no
  spotlight target hid the spotlight with `opacity: 0`, which also killed
  the box-shadow that does the dimming — so the one step that most needed a
  dim never had one, and its tooltip sat on a bright app list.
* **Sticky table headers** (`h0i`) across all four column-header tables.
* **All Programs layout** (`ri6`). Date and Size had no width floor and
  wrapped to two lines once the details sidebar compressed the table; the
  sidebar also claimed its full width while invisible, before any selection.
* **Column header said "Publisher", showed a type badge** (`qq5`) — renamed
  to "Type"; the publisher was always under the app name in column 1.
* **System Clean header buttons** (`l0t`) — "Scan all" and "Clean all" were
  spread apart by the shared header's `space-between`.
* **The bulk queue stops fighting its own user** (`2pc`). It re-expanded on
  every add and toasted each time, so collapsing it was undone by the next
  thing you did. It now announces itself once per batch, and collapsed
  shrinks from 400×419 to 391×57 — about 87% less screen area.

### Added — Network Activity download/upload tiles

* Download, Upload and a de-emphasised adapter tile (`anc`) replace the text
  fragment that used to sit inside the "Looked at:" line. Deliberately *not*
  shown as a percentage of link speed: that is the negotiated rate to the
  router, not the internet connection behind it.

### Fixed — test coverage that looked like coverage

* **Seven `window.api` methods were missing from the shared test fixture**,
  so the Health Advisor tab was a hard TypeError under test — and the suite
  stayed green, because nothing ever navigated there. All 48 methods are now
  covered, found by diffing the renderer's calls against the fixture's keys
  rather than one crash at a time.
* **Every tab is now smoke-checked** (`k0k`): the suite clicks all 8 tabs and
  asserts a panel is visible, carries no visible error state, and contains
  no "is not a function" text. Verified by deliberately re-breaking the
  fixture and confirming the suite goes red.
* **Three icons were rendering as invisible blank squares** — caught by this
  project's own `test/icon-verify.js`, which exists for exactly that silent
  no-op. Added to the vendored set; 55 referenced, 55 defined.

`npm test`: **395 passed, 0 failed** (was 371 before the new assertions; the
`kp0` ping work above added further assertions on top of these, see that
section — **404 passed, 0 failed** is the current total).

### Added — guided tour, ambient background, codebase cleanup

* **Guided tour.** A hand-rolled spotlight walkthrough (no third-party tour
  library) - 7 steps covering Audit/Full Mode, All Programs, Health
  Advisor, System Clean, and the quarantine vault's "nothing is ever just
  deleted" promise. Auto-shows once on first launch, replayable any time
  from a new "Take the tour" row in Settings. Caught a real regression
  before it shipped: the tour's full-screen overlay auto-started during the
  Full Mode UI-interaction test suite (a fresh test fixture defaults
  `hasSeenTour` to falsy) and blocked all 30 of that suite's clicks - fixed
  in the test fixture (an already-onboarded user is the correct default for
  a UI test), not by weakening the tour's real blocking behavior.
* **Ambient background wash.** A very low-opacity, slow-drifting radial
  gradient behind the glass panels, respecting `prefers-reduced-motion`.
  Deliberately subtle - this is a trust-focused audit tool, not a
  marketing page.
* **Codebase clutter scan.** Full pass for dead code, duplicate logic,
  orphaned files, unused dependencies, unused CSS, and unused icons came
  back clean - no dead functions, no duplicate logic meeting the bar, no
  orphaned tracked files, no unused dependencies. Removed one genuinely
  unused CSS class (`.flex-row`) and marked three fully-superseded
  documentation artifacts as historical rather than deleting them, matching
  this project's existing keep-and-mark convention.

### Added — real install sizes for Steam (and documented support for Epic) games

* **Steam/Epic games no longer show "unknown size."** Confirmed the actual
  gap: Steam (and Epic) still write a normal Programs-and-Features entry per
  game - name, uninstall string, and install location are all already
  correct - only `EstimatedSize` is blank, because the platform owns that
  number, not Windows. Now reads it from the platform's own already-computed
  catalog instead: `steamapps/libraryfolders.vdf` for every Steam library
  (a Steam install can span multiple drives - true on the machine this was
  built against), then each library's `appmanifest_<id>.acf` for the real
  size, matched to the registry entry by install path. Only `sizeBytes` is
  ever backfilled, and only when the registry itself reported none - nothing
  else about an entry changes. Live-verified: Grand Theft Auto V Enhanced
  now reports its real ~96GB size. This is a handful of small text-file
  reads (one per installed game), not the recursive folder-size walk that
  cost `Get-UwpApps` 10-15s per launch and was removed earlier this session
  - measured 1209ms for a full list scan (up from ~350ms baseline), lazy
  (only triggers when a blank-size entry with a real install path is
  actually found). Epic support implemented against its documented `.item`
  manifest shape but not live-tested - Epic isn't installed on the machine
  this was built against.

### Added / Confirmed — startup latency root cause, redundancy discount badge

* **Startup latency: root cause confirmed with a live A/B measurement.**
  Built and installed the NSIS package, then timed launch-to-real-window on
  both packaging formats with the same script, same machine, same session:
  **NSIS-installed 4.2s vs portable 20.4s** - a ~5x difference. Confirms the
  portable format's self-extraction (likely compounded by antivirus scanning
  the freshly-extracted files) as the dominant cause, not app code. No
  further code fix exists on the Vanish side for this - recommendation is to
  default to the installed build for regular use.
* **Redundant Software: a "discount" badge, matching Startup Items' own
  pattern.** The section header now shows a primary count (waived groups
  excluded - "discounted" out of it) and a secondary "N waived" pill when
  any exist, the same count/sub-count pair Startup Items already uses for
  its total/broken badges. A waived group's own "N installed" badge also
  drops its red/danger styling, since it is an acknowledged choice, not a
  live warning.
* **GPU vendor logos, matched by a stable id instead of guessed order.** A
  first attempt at DXGI COM interop hit an incomplete vtable declaration and
  produced nothing usable - documented, not shipped. A second attempt
  (`app.getGPUInfo`) worked but could only correlate a vendor to the perf
  counter's `phys_N` index by array order, with no way to prove it - and,
  as pointed out, `phys_N` is exactly the wrong thing to key on anyway,
  since a discrete GPU can drop out of it entirely (or shift position)
  whenever an OEM app powers it down under hybrid graphics. Fixed properly:
  `chrome://gpu` (Electron's own diagnostics page, loaded once in a hidden
  window) reports each adapter's LUID alongside its vendor - live-verified
  to be bit-for-bit the same LUID the perf counter already reports for the
  same physical card. `Get-GpuUsageByProcess` now returns `luidHigh`/
  `luidLow` per adapter; `get-gpu-vendors` (cached once per process
  lifetime, not re-queried per sample) does the same from `chrome://gpu`;
  the renderer matches the two by LUID equality. Real AMD/NVIDIA marks
  (Simple Icons, CC0-licensed files; the marks themselves remain their
  respective trademark owners, informational hardware-identification use)
  render on the Task Manager GPU pills, correctly labelled regardless of
  which adapter happens to be awake at query time.

### Added / Fixed — GPU visibility, network telemetry, redundancy waivers, startup latency

* **System Overview grid, real fix this time.** The prior width-guessed
  auto-fit still wrapped on the operator's actual screen. Replaced with
  `repeat(6, minmax(0,1fr))` - unconditionally one row, full width, no
  guessing, since the card count is permanently 6.
* **Task Manager: GPU column + which-GPU indicator.** New `get-gpu-usage`
  engine action (`Get-Counter '\GPU Engine(*)\Utilization Percentage'`, the
  same source Windows' own Task Manager reads) is deliberately its own IPC
  channel - measured 1.5-3.2s per call on the operator's real dual-GPU
  laptop, so it samples on its own 15s interval, not the fast process-list
  tick, and merges into the table client-side by pid. System-wide "GPU 0 /
  GPU 1" activity pills above the table use generic phys-index labels rather
  than a guessed vendor name - matches real Task Manager's own precedent for
  the identical limitation (an idle discrete GPU reports no instances at all
  until something wakes it).
* **Network Activity: upload/download speed.** `receiveBytesPerSecond` /
  `sendBytesPerSecond` per adapter were always computed (they already drove
  the busy/quiet verdict) and are now displayed - no new engine capability,
  no new network I/O.
* **Network Activity: peer IP list per process.** `Get-NetConnectionsByProcess`
  always collected each process's distinct remote IPs; only the count ever
  left the engine. Now expandable per row. Two existing, deliberate limits
  were kept, not reversed: no port (avoids drifting this panel toward
  security/firewall framing) and no reverse-DNS (would be outbound network
  I/O, which `test/network-verify.ps1` asserts this engine never does).
* **Network Activity: optional auto-refresh interval.** New Settings row,
  default 0 (manual "Measure again" only, unchanged from before) - opt-in
  per the operator's own proposed design.
* **Network Hold: name what's actually held.** The hold detail used to say
  only "N background transfer(s) are paused." Each held BITS job already
  carried a `displayName`; now listed by name. True per-process attribution
  isn't possible - `Get-BitsTransfer` exposes no owning-process field.
* **Redundant software: waive workflow.** Redundancy groups
  (`Get-SoftwareRedundancy`) were entirely static pills with no interactive
  element. Each app now has a "Review to uninstall" shortcut that jumps to
  the exact same entry point a manual click from All Programs would reach
  (`selectApp`, details sidebar), and each group has a "Keep all of these"
  waiver, persisted in settings. Waiving does not hide the group - it keeps
  showing, with an override notice, and the same decision buttons.
* **Startup latency, investigated with real measurements.** Confirmed the
  historical 10-15s `Get-UwpApps` folder-size walk (already fixed in a prior
  session) is gone - two stale comments still describing the old behaviour
  were corrected. Measured the JS/PowerShell-controllable boot cost directly
  (~1.2-2.5s) - real, but does not explain a reported 5-8s wait. Live-timed
  the actual packaged portable exe once (with the operator's explicit
  consent): roughly 10+ seconds just between the launcher starting and the
  real app process appearing, far more than ~90MB of self-extraction should
  cost - the leading suspect is antivirus real-time scanning of the freshly
  extracted files on every launch, which is structural to the portable
  format, not an app bug. The elevation-splash window gained a
  `did-fail-load` safety net and a 20s watchdog (it had neither before,
  unlike the main window) after a black, contentless splash was seen live
  during this investigation - root cause unconfirmed (the investigation's
  own concurrent process manipulation makes the trace unreliable), but both
  gaps were real regardless of what caused that one incident.

### Fixed / Added — seven operator-reported issues from a live session

* **UAC diagnostics (`ytv`).** The "Windows did not grant administrator
  rights" message never said why. `scanner.ps1` now reads `EnableLUA` and
  checks Administrators-group membership independently of the current
  process's own (UAC-filtered) token, and `relaunch-elevated` tells a real
  UAC decline (Win32 1223) apart from the account not being an administrator
  at all, or UAC being off on the machine. The renderer shows a
  cause-specific message instead of one generic banner. Needs console/VM
  verification, same as every other elevation-dependent item.
* **System Overview cards wrapped to a second row even maximized (`7d8`).**
  `.audit-cards-grid`'s minmax bounds needed up to 1610px for all 6 cards to
  share one row; lowered to 150-220px so ~950-1310px is enough.
* **Clean All (`zl4`).** Scan All never had a purge-side complement. Clean
  All now purges every removable finding in every already-scanned System
  Clean section behind one aggregate confirmation, and requires typing CLEAN
  if any selected item is `Advanced`-risk (mirrors the existing untrusted-
  uninstaller warning). Tier-locked in Audit Mode like every other
  destructive control.
* **Elevation-toggle info text could show stale state (`bim`).** "Always
  start with administrator rights" flips its checkbox natively and
  instantly; the "Next start: ..." line under it used to wait for the
  settings save's IPC round-trip before updating, a real (if narrow) window
  where the two described different states. Now applied optimistically on
  the same `change` event.
* **Raw PowerShell errors reaching the UI (`frr`).** A portable-build temp-
  extraction race could leave `scanner.ps1` missing, and Task Manager showed
  the raw "PowerShell exited with code 4294770688..." text. `runPowerShell()`
  now checks the file exists before spawning, offers a one-time native
  "Restart Vanish" dialog that re-extracts cleanly (reusing the
  `PORTABLE_EXECUTABLE_FILE`-safe relaunch path), and no longer surfaces raw
  stderr or exit codes to any renderer-facing error message.
* **Audit Mode write-attempt UX (`k87`) and About page disclosure (`3ri`)**
  reviewed, no code change: `guardFullMode()`'s toast plus `data-destructive`
  tier-locking already explain the block outside of About; About's full
  tech-stack/data-folder disclosure was kept deliberately (zero network I/O,
  matches the project's transparency stance).

### Changed — commercialization: personal use free, commercial use paid (ADR 0002)

[`adrs/0002-commercialization-b2b-paid-personal-free.md`](adrs/0002-commercialization-b2b-paid-personal-free.md)
supersedes **only** the payments row of ADR 0001; every other row of 0001
stands. It also records what it deliberately does *not* decide — price,
per-seat versus site, licence-key enforcement, and the repository licence text
— because leaving those implicit is how one decision becomes five nobody made.

Open-core was rejected on the way: a paid tier would end up holding the
fleet-audit and advanced-heuristic surfaces, which would make the free build
weaker at exactly the things that make the tool trustworthy. Signing hardens
from optional-with-a-reversal-condition to disqualifying-if-absent — no IT
department deploys an unsigned binary — so TASK-21 now needs splitting into
signing (required) and channel (open).

### Added — hold background transfers, with a guaranteed way back (`bfh.2`)

* Step 2 of the network work. A hold caps Windows Update's **background**
  downloading by policy and suspends BITS transfers that are currently running.
  Foreground transfers are deliberately untouched: a download someone is
  waiting for is not what "hold the background" means.
* **The ordering is the safety property.** Capture is a separate, read-only
  step; the main process writes that record to disk *before* anything is
  changed. A crash between the two leaves a machine nobody touched. A crash
  after leaves a file describing exactly what to put back — and the next
  elevated start puts it back without being asked, because leaving Windows
  Update capped at 1% because Vanish died is precisely "left the system in a
  worse state than before".
* A partial release keeps its record on disk on purpose. Dropping it would
  strand the leftovers permanently; keeping it means the next start retries.
* It says what it cannot do, and that is asserted: it cannot give a program
  more speed, only stop other things taking it, and it does nothing about
  traffic from other devices on the network.
* A job somebody else already suspended is never captured, so releasing never
  resumes a transfer that was not Vanish's to touch.

### Added — network attribution, and an honest negative answer (`bfh.1`)

* **A Health Advisor section that reaches a verdict about the network**, not a
  list of sockets. The verdict that matters is the negative one: *nothing on
  this PC is using the network* — which tells someone to stop looking at their
  PC and go look at their router. That answer needs no network call to reach,
  because it is a claim about local state, so `INV-4` (zero runtime network
  I/O) stands untouched.
* **It never claims a per-program byte rate.** Windows does not attribute bytes
  to a process without an ETW kernel trace, so any per-app "12 Mbps" here would
  be invented. The panel reports connections held and peers connected to, and
  says on screen why that is the honest limit. Both the engine field names and
  the rendered rows are asserted against it.
* Sources were measured before they were chosen: the .NET
  `NetworkInterface.GetIPStatistics` API (44ms) and `netstat -ano` (40ms) beat
  `Get-NetAdapter` (2.5s) and `Get-NetTCPConnection` (1.3s), because the engine
  spawns a fresh `powershell.exe` per action and pays module autoload every
  time. A Hyper-V switch busy talking to a local VM is excluded from the
  verdict by requiring a default gateway.
* Absence is reported as absence, with a reason. Windows 11 gates Wi-Fi signal
  strength behind the Location privacy setting *and* elevation, so on a healthy
  machine that read legitimately fails — it is reported as unread with the
  cause, never as a good signal, and the "weak link" verdict is withheld rather
  than guessed at.
* Two bugs found while building it, both of which looked fine on screen:
  * The peer count read `1` for every program on the machine. The variable
    holding the address was called `$host`, which is a PowerShell automatic
    variable: the assignment silently did nothing and every connection used the
    same object as its hashtable key. A plausible-looking number that was wrong
    everywhere.
  * `Get-BitsTransfer -AllUsers` needs elevation, and `netsh wlan` needs
    Location permission. Both now degrade to "unknown", never to "none".

### Fixed — five icons were rendering as blank squares

The icon set is first-party SVG data URIs used as CSS masks (it replaced the
FontAwesome CDN for `INV-4`). A class the file does not define is not an error:
the element renders as a 1em blank square, nothing throws, and nothing logs.
`fa-lightbulb` was sitting on every orphaned startup row; `fa-clock` and
`fa-location-dot` elsewhere. All five are drawn now, and `test/icon-verify.js`
diffs referenced against defined so the next one fails the build instead of
shipping invisibly.

### Changed — the operator's second pass over Health Advisor and Settings

* **Startup items can be acted on** (`7oo.11`). The verdict on the old surface
  was "this item is broken but i cant do anything to it", and that was fair: it
  named the orphan, named the tool that manages it, and stopped. Each row now
  carries the one action Vanish can perform on that kind of entry, and each is
  reversible — a Run value is removed after its key is exported to the vault as
  a `.reg` restore manifest; a service is set to start on demand after the same
  export; a scheduled task is disabled in place and re-enabled by the same
  button. The three engine verbs are deliberately narrow: the registry one
  accepts only the five Run/RunOnce keys this surface reads, the service one
  refuses boot-start drivers, and the task one refuses anything under
  `\Microsoft\`. None of them is a general-purpose primitive reachable over IPC.
* **The second GPU was never missing — it was clipped** (`1bp`). The engine has
  reported every adapter since the last fix. `.card-value` is one `nowrap` line
  with an ellipsis, so "AMD Radeon + NVIDIA RTX 3080" rendered as "AMD
  Radeon...". Adapters now render one per line, and every overview value wraps —
  the CPU and machine model were quietly losing their tails the same way.
* **System Overview cards centre at any count** (`1zv`). `auto-fill` keeps empty
  phantom tracks, so a short last row sat jammed against the left with dead
  space beside it. `auto-fit` plus a maximum track size and `justify-content:
  center` reads the same with four cards or ten.
* **The elevated restart says what it is doing** (`2cv`). Between requesting
  elevation and the elevated window appearing there are several seconds of
  Windows' own work — consent, then a second Electron process booting. The
  automatic path created no window at all in that window of time, and the manual
  path just vanished. Both now show a notice; the small always-on-top one
  outlives the main window on purpose, so the desktop is never blank.
* **Settings states which mode this session is in** (`388`). The "start as
  administrator" toggle is about the *next* launch, but it was the only
  elevation-shaped control on the panel, so it read as the current mode. Settings
  now opens with a status block naming the mode, what it allows, and — in Audit
  Mode — a button to elevate now. The toggle says in words what the next start
  will do.
  * Caught by the UI suite on the way: the new status block was first written as
    `.mode-card`, a class the uninstall wizard's scan-depth cards already own.
    It silently re-laid out the wizard until its restore-point toggle slid under
    the step rail. A class name is an interface.

### Added — left-over Store app data sweep (`udu`)

* **A seventh System Clean cleaner: left-over Store (UWP/MSIX) app data.**
  Uninstalling a Store app removes the package and leaves
  `%LOCALAPPDATA%\Packages\<PackageFamilyName>` exactly where it was. Windows
  never collects these, Settings never shows them, and no other surface in
  Vanish could see them — the app list reports packages Windows still
  registers, which is precisely the set these folders are *not* in. On the
  development machine the sweep found 24 MB of data belonging to a vendor
  utility removed long ago.
* Every ambiguity resolves toward keeping the folder: the "installed" set is
  the union of this user's registrations and, elevated, every user's; Windows'
  own shell and framework families are listed but never removable, because
  servicing unregisters them briefly and a folder that looks left over may not
  be; folders touched in the last 7 days are held back entirely and the sweep
  says how many; and folders that were never package folders at all (Chrome's
  `cr.sb.*` sandboxes, Windows' `ActiveSync`) are excluded by shape, since "no
  package claims it" says nothing about a directory that never had one.
* Registered packages whose install folder has vanished are listed in the same
  section as audit-only rows — that is why the Start tile does nothing — with
  no removal offered: a package registration has no restore manifest, so
  INV-1 forbids removing one from here.
* `cleaner-purge` grew a file branch, so this is also the first cleaner whose
  findings are folders rather than registry keys. They move into the vault
  whole and restore from it; `test/phase4-ipc-verify.js` now drives that round
  trip end to end (elevated), which no automated run had ever done for a file.
* **`Get-FolderSize` had never returned anything but zero.**
  `return if ($size) { $size } else { 0 }` is not the expression PowerShell 5.1
  reads it as. It had no live callers when this was found — the app-list caller
  was deleted for being slow in the previous session — so nothing on screen was
  ever wrong, but the next caller would have inherited a helper that silently
  agrees every folder is empty. Fixed, and now measures hidden subtrees too
  (`-Force`), which is where app data actually lives.

### Fixed — epic 7oo: the operator audit of 2026-08-06

The verdict that started this was "we have an aesthetic product with poor ux and
minimal functionality". Ten defects, all of them invisible to a 312/312 green
suite because every UI test ran against a one-app fixture. Each number below was
measured on a real machine, and `test/real-data-verify.js` re-measures it.

* **Real-data harness** (`7oo.10`). A second harness class that runs the real
  preload against the real backend and asserts what a user would actually see.
  Ground truth comes from `test/fixtures/real-machine-truth.ps1`, which reads
  the machine with its own queries — a harness that asks the code under test
  what reality looks like can only ever agree with itself. It reproduced six of
  the defects below before any of them were fixed. `main.js` gained
  `VANISH_HEADLESS_HARNESS=1` so no diagnostic can spawn a window mistakable for
  the app.
* **Context-menu scan: 300s+ → 0.7s** (`7oo.5`). `Open-RegistryView` called
  `OpenBaseKey` on every value lookup; for `ClassesRoot`, which Windows
  synthesises by merging two hives, that is the expensive half of a read. Base
  keys are now cached per hive+view.
* **Storage panel showed nothing, ever** (`7oo.8`). The CIM query asked
  `Win32_LogicalDisk` for `DriveLetter`, a `Win32_Volume` property. The whole
  query was invalid, the `catch` swallowed it, and the panel reported no drives
  on every machine since it shipped. Now renders 2 of 2 fixed drives here.
* **60 of 151 installed entries were invisible** (`7oo.3`). `SystemComponent=1`
  and `ParentKeyName` entries were dropped outright, hiding Windows Subsystem
  for Linux, the vendor utilities, both Python installations and every runtime.
  Nothing is dropped now: every entry is classified (application / component /
  update) and every component states why. Protection is a narrow claim about
  Windows servicing — one entry on this machine — not a publisher check.
* **Uninstall actions rendered 250px below the window** (`7oo.1`). The details
  panel scrolled as a whole while its buttons relied on `margin-top: auto`. The
  info list scrolls now and the actions are structure; panel chrome is sized in
  `vh`, verified at 800x600, 1080x720 and 1440x900.
* **Force Uninstall disagreed with the app list** (`7oo.2`). It was a second
  registry sweep that reapplied the old drops by hand, under a comment claiming
  the two lists agreed. It reads the same classified inventory now.
* **Redundancy counted one product as several** (`7oo.6`). Edge + Edge Update +
  WebView2 read as three browsers. Grouped by vendor within a category now: 6
  groups became 4, and the 4 that remain are real.
* **Two of three "orphaned" startup items did not exist** (`7oo.4`). A scheduled
  task's `Execute` value arrives already quoted and was used verbatim, so
  `Test-Path` on a quoted path was always false. The orphan count also
  serialised as `null` whenever exactly one item matched, hiding the badge.
* **Live scan progress** (`6g2`). `queue-update` was the only push channel in
  the app. `scanner.ps1` now emits progress on stderr behind a marker, `main.js`
  forwards it, and the renderer shows measured facts only — "step 6250 of 6465,
  294 found so far, 6s", never a predicted percentage (Rule 9).
* **Purging no longer triggers a full rescan** (`7oo.5`), counts read "scanning"
  until final, and a ticked selection survives collapsing and tab changes.

### Added
* **Windows optional features toggle** (`7oo.7`). The "Turn Windows features on
  or off" list, previously invisible to Vanish. Uses `Win32_OptionalFeature`
  rather than `Get-WindowsOptionalFeature` because the DISM cmdlet requires
  elevation and would make the list useless in Audit Mode. Read-only: the
  refusal names `optionalfeatures.exe`.
* **Quarantine entries answer what happens if you do nothing** (`7oo.9`), read
  from the live retention setting, plus what/where/when/can-I-undo without
  expanding anything.
* `test/fixtures/stub-preload.js` gained `callCount()` — "did interacting with
  this screen re-run the scan?" is only answerable by counting what crossed the
  bridge, and the worst behaviours here were invisible because nothing counted.


> Rule 10 note: everything below is **In Progress**, not Complete. It is coded
> and passes 290/290 assertions **unelevated** on Windows 11 build 26200
> (`test\run-all.ps1`); 2 of 14 suites (Vault IPC, System Clean purges) require
> Full Mode and have not run this session — run elevated before trusting a
> total beyond 290. No clean Windows 10 / Windows 11 VM pass has happened yet
> (TASK-17). No stage flips to "Complete" until it does.

### Added — safety retrofits (promptgate Rules 2 and 3)
* **Quarantine vault.** Every removal now moves files into a versioned vault
  and exports registry keys to a `.reg` restore manifest before deleting them.
  New engine actions `quarantine-items`, `vault-restore`, `vault-delete`;
  new `lib/store.js` (atomic manifest / settings / queue / oplog writes) and
  `lib/vault.js` (the pipeline). Per-item all-or-nothing: an item that cannot be
  moved is left exactly where it was, never half-removed.
* **Quarantine Manager tab.** Lists vault entries with per-item detail, restores
  them to their original locations, and permanently deletes them behind a
  double confirmation (typed `DELETE`). Auto-purge is a setting, off by default,
  with a retention period.
* **Enforced Audit Mode.** Elevation is resolved once at startup and every
  destructive IPC channel is rejected in `main.js` when unelevated — verified by
  invoking all nine of them directly, bypassing the UI. `scanner.ps1` re-checks
  `WindowsPrincipal` independently. The Rule 3 banner is shown verbatim and
  every destructive control is inert with an explaining tooltip.
* **Startup elevation offer.** A one-time "restart as administrator" dialog;
  declining (or cancelling UAC) lands in a working Audit Mode instead of exiting.
* **Startup elevation toggle (operator request 2026-08-03).** Settings >
  "Start Vanish as administrator" lets a trusted machine skip the manual click:
  when enabled, `main.js` requests elevation automatically before any window
  exists, instead of waiting for FLOW-01. Off by default — everyone else's
  first launch is unchanged. This does **not** bypass UAC; Windows' own consent
  prompt still appears on every launch while the setting is on, by design. A
  declined or cancelled elevation falls through to a working Audit Mode exactly
  as an unelevated launch always has (Rule 3). bd `vanish-uninstaller-kt0`.
* **Operation log** (`oplog.jsonl`): every destructive action, rejection and
  settings change is appended with a timestamp, tier and outcome.

### Added — Stage 3 (Task Manager & Unlocker)
* Live process monitor with CPU, working set and disk I/O per second, sortable,
  with a detail pane and a Full-Mode-only kill.
* Unlocker built on the Windows Restart Manager: lists the processes holding a
  file or folder, offers a graceful close, then per-process force-end as an
  explicit second step.
* Watchdog suspension: the holder tree is frozen with `NtSuspendProcess` before
  locks are released, so a watchdog cannot respawn the locker mid-cleanup. The
  thaw is guaranteed by a `finally` path.
* Passive suspicious-activity indicators (Rule 7): suspicious process trees,
  destructive command lines and persistence entries, labelled
  "Indicator -- investigate with your antivirus". Display only — no UI path acts
  on them, and a test asserts that.

### Added — Stage 6 (Orchestration)
* Bulk uninstall queue with a resumable state machine; queue state is written to
  disk on every transition, so a crash loses at most the in-flight application.
  Reboot exit codes (3010/1641) pause the queue; a non-silent uninstaller is
  marked "needs attention" and the queue carries on.
* `corrections.json` — the Rule 15 primary switch source, seeded with the
  OPEN-02 verified entries plus a few community ones, each with provenance.
* Installer service manager: `msiserver` is enabled if disabled before an MSI
  queue and restored to its prior start mode afterwards.
* Restore point frequency override: the 24-hour rate limit is lifted around each
  checkpoint and the prior registry value is restored in a `finally`, so every
  application in a queue gets its own restore point.

### Added — Stage 9 (System Integration & Environment Clean)
* System Clean tab with one reusable review-list component per cleaner: orphaned
  context-menu handlers, orphaned services, dead PATH directories, dead file
  associations and protocol handlers, and an other-user-profile sweep. Scanning
  is read-only and works in Audit Mode; purging routes through the vault.
* Explicit 64-bit and 32-bit registry views for all Stage 6/9 scans, so nothing
  hides behind WOW64 redirection.
* Offline registry hive loading for other local profiles, with a guaranteed
  unload in a `finally` even when the scan fails.

### Added — verification
* `test/` suite: 220 assertions across eight harnesses covering the vault round
  trip, the privilege boundary, the process/unlock/suspend paths, the switch
  chain, the queue state machine, and every cleaner's scan-purge-restore loop.
  `test/run-all.ps1` runs them all and prints one summary.
* `docs/BENCHMARKS.md` now carries measured figures with Rule 9 test conditions:
  process refresh 1.47–1.57 s at 305 processes, and OPEN-03 resolved (Restart
  Manager interop init is 345 ms, not the feared 1–2 s).

### Added
* `LICENSE` (MIT) at repository root.
* `ARCHITECTURE.md` at repository root: **as-built** architecture — component
  map, approval-loop sequence diagram (both Mermaid), complete IPC surface
  table, `scanner.ps1` function inventory, and an implemented-vs-designed
  status table. `docs/architecture.md` remains the target-state specification.

### Changed
* `README.md` rewritten as the public-facing document: honest capability table
  (every claim mapped to a file/function), the scan→propose→approve loop,
  scan-mode comparison, explicit "what Vanish does NOT do" section (including
  the not-yet-implemented quarantine vault), quickstart, and doc index.
* `package.json` metadata aligned with repo reality: version corrected from
  `1.0.0` to `0.2.1` per the RELEASE.MAJOR.MINOR scheme (RELEASE=1 criteria in
  `docs/RELEASING.md` are not met), license field corrected to MIT to match the
  new LICENSE file, description/author/repository filled in.

### Fixed
* **Every dialog in the app was unclickable.** The uninstall wizard's overlay is
  invisible when idle, but its first screen keeps `pointer-events: all` - and a
  child stays hit-testable even when its parent is `pointer-events: none`. The
  wizard sits later in the DOM at the same `z-index`, so it silently covered the
  elevation offer, the unlocker, and every confirmation dialog, including the
  Delete Forever double-confirm. Controls rendered perfectly and did nothing.
  Inactive overlays are now `visibility: hidden`, which removes the whole
  subtree from hit testing, and the overlays have explicit stacking so a dialog
  raised from inside another dialog lands on top.
* A `DisplayName` stored as `REG_MULTI_SZ` arrived in the renderer as an array
  and threw `app.name.toLowerCase is not a function`, which emptied the entire
  application list. Display fields are now coerced in the engine, with a
  defensive coercion in the renderer as well.
* The System Clean association scan initially proposed removing `exefile`,
  `batfile`, `cmdfile`, `comfile`, `scrfile` and `piffile` — the handlers that
  let Windows launch anything at all — because `"%1"` placeholders and
  extension-less commands were misread as missing targets. The command-target
  resolver now recognises shell placeholders, walks the longest existing path
  prefix (so unquoted paths with spaces survive), and probes for omitted
  extensions. A permanent regression test asserts no core Windows handler is
  ever flagged.
* Shell extensions registered only in the 64-bit view (Defender's `EPP`,
  `WorkFolders`, Offline Files) were reported as orphaned during the 32-bit
  pass. The COM server lookup now checks both views before concluding anything
  is missing.
* `HKEY_CLASSES_ROOT` findings resolve to the physical `HKCU`/`HKLM` key that
  backs them before quarantine. `HKCR:` is not a mounted PowerShell drive, so
  the vault previously treated those keys as already gone.
* All renderer HTML interpolation is escaped. Application names, registry paths
  and process command lines all come from disk and were being injected as
  markup.

### Testing
* **Widened DOM hit-test coverage to the main user flows.** Raised by the
  operator: prior coverage bypassed the UI for most flows, testing the engine
  or IPC layer directly. Extended `test/ui-interaction-verify.js` (Audit Mode)
  with application-list rendering of real engine output shapes — an empty
  list, a rejected call, and a `REG_MULTI_SZ`-shaped `DisplayName` that once
  broke the whole renderer list (engine-side coercion existed; nothing
  asserted the list survived it on screen). Added
  `test/ui-interaction-full-verify.js` (Full Mode, fixture-simulated) driving
  the uninstall wizard end to end, the leftovers tree (select-all and
  per-item toggles), the Quarantine Manager restore — including the
  overwrite-conflict branch — and Delete Forever's double-typed-confirm, the
  bulk queue panel and its risky-uninstaller acknowledgement, and System
  Clean scan-to-purge. Every assertion hit-tests the real clickable target
  with `elementFromPoint`, the technique this suite exists for since an
  invisible overlay once covered every dialog in the app. Found one
  test-authoring bug in the process, not an app bug: the restore-point
  checkbox is a deliberately zero-size input behind a visible toggle slider
  (standard CSS pattern) — fixed the assertion to hit-test the slider a real
  user clicks, and separately proved the click reaches the underlying input.
  212 → 277 assertions. bd `vanish-uninstaller-7y0`.
### Security
* **Fixed: no build resolved a verified dependency set.** `package-lock.json` was
  gitignored and `electron` was range-pinned (`^42.5.0`), so nothing in the repo
  recorded which dependency builds a release came from. A compromised publish
  anywhere in the install graph would have been pulled by the next `npm install`
  and shipped inside an application that runs elevated — with no committed hash
  to notice it against. The lockfile is now tracked (all 13 packages carry
  integrity hashes), `electron` is pinned exactly, `docs/RELEASING.md` requires
  `npm ci` for releases, and `npm test` runs the verification suite instead of
  erroring out. Found by a `/cso` audit (bd `vanish-uninstaller-703`).
* **Fixed: the destination-guard junction resolver only followed one hop (HIGH, found on re-review of the SEC-2 fix itself).**
  `Resolve-DestinationTarget` resolved a single reparse point and returned —
  correct for a lone junction, but a chain (`A → B → the real blocked
  location`) resolved only to `B`. If `B` didn't itself match anything on the
  blocklist, the destination was allowed even though Windows follows the whole
  chain transparently at write time, landing the file at the real target
  anyway. Now iterates to a fixed point (or refuses past 32 hops, which is not
  a real filesystem configuration) instead of stopping after one. Verified
  with a real two-hop junction chain into the all-users Startup folder.
* **Fixed: the restore destination guard was a blocklist, and a textual one (HIGH).**
  A vault restore is a file write performed as administrator to a location the
  manifest chooses, and the manifest is untrusted input. The guard covered the
  Windows directory and nothing else, so a forged entry could restore an
  attacker's binary into the all-users Startup folder — admin-level persistence
  at the next logon. Worse, it compared paths *textually*, and `GetFullPath` does
  not follow junctions: a directory junction pre-created at an innocent-looking
  path defeated any check of this kind entirely. The guard now resolves a
  destination to the path the write really lands on before judging it, and
  refuses the narrow set of locations whose only value to an attacker is
  privileged execution — any `Start Menu` subtree in any profile, direct children
  of a drive root, the Windows directory, and unreadable reparse points.
  `%ProgramFiles%`, `%ProgramData%` and other user profiles stay allowed on
  purpose: Vanish quarantines application leftovers from all three (REQ-17 sweeps
  other profiles by design) and a restore has to be able to put them back —
  blocking them would break the undo path, which is the point of the vault. New
  read-only `protected-destination-probe` engine action makes the guard testable
  in Audit Mode as well as Full Mode. Found by a `/cso` audit
  (bd `vanish-uninstaller-2xt`).
* **Fixed: the data directory lock could not hold, and said it had (HIGH).**
  Vanish state lived directly in the Electron `userData` root, which is also
  Chromium's profile directory — so the ACL that stops a standard user rewriting
  `manifest.json` (which the engine reads as *elevated instructions*) was the
  same ACL that would stop Chromium writing `Preferences` and `Cache` on the next
  Audit Mode run. The lock was therefore unfixable in place. State now lives in a
  `vanish-state` subdirectory that nothing but Vanish writes; existing installs
  are migrated once, per item, never clobbering and never deleting what it could
  not move. Two further gaps closed with it: ownership is now reassigned across
  the whole subtree rather than the root alone (an object's owner keeps
  `WRITE_DAC` and can hand itself write access back whatever the DACL says), and
  the health check now inspects owners as well as the DACL. That last one was the
  load-bearing bug — `main.js` only re-applies the ACL when the check reports
  `protected: false`, so a directory with a perfect DACL and user-owned children
  was declared safe and never revisited. Found by a `/cso` audit
  (bd `vanish-uninstaller-z2a`).
* **Fixed: shell command injection in the single-app uninstaller (CRITICAL).**
  The `uninstall-native` channel took a command *string* from the renderer and
  handed it to `exec()`, which on Windows means `cmd.exe`, as administrator. That
  string came from the registry — including `HKCU\...\Uninstall`, which any
  standard user can write — so an entry planted with shell metacharacters
  (`"...uninstall.exe" /S & <payload>`) was a one-click privilege escalation: the
  planted app just had to look like something worth uninstalling. The channel now
  takes a *pointer* (a registry path, or a package full name for Store apps) and
  runs the same pipeline as the bulk queue: live registry re-read, trust gate,
  executable split from its arguments, `Start-Process`. No shell is involved at
  any point, `exec` is gone from `main.js` entirely, and the renderer can no
  longer supply an executable or a command line. Store package removal calls
  `Remove-AppxPackage` as a cmdlet against a package Windows confirms is
  installed, instead of building a `powershell.exe` command line. The engine's
  own defence-in-depth gate now refuses on the full `risky` verdict rather than
  `userWritable` alone, so an `HKCU` entry naming a system binary with
  attacker-chosen arguments no longer slips past it. Found by a `/cso` audit
  (bd `vanish-uninstaller-lwz`); regression tests in `test/security-verify.ps1`
  and a contract probe in `test/tier-verify.js`.
* A strict Content-Security-Policy is now set: `connect-src 'none'` makes fetch,
  XHR and WebSockets impossible from the renderer, so no scan result or path can
  leave the machine.
* **Fixed: local privilege escalation via the quarantine vault.** `manifest.json`
  and the vault payloads live under the app data directory, which a standard
  user can write to, but the engine acts on them with administrator rights. A
  forged manifest entry could therefore have made the elevated engine move an
  attacker-supplied file to any location (including `System32`), import an
  arbitrary `.reg`, or recursively delete an arbitrary directory via a traversing
  entry id. Entry ids are now validated as UUIDs before any path is built, every
  manifest-supplied relative path must resolve back inside its own entry folder,
  and restores into the Windows directory are refused outright.
* **Fixed: the app data directory is no longer world-writable.** On every
  elevated start Vanish now checks the directory ACL and, if a non-administrator
  can write to it, applies an explicit DACL - Administrators and SYSTEM get full
  control, Users keep read so Audit Mode can still list the vault - with
  inheritance severed. This closes the `ASSUMED` item in `01-trd.md`'s security
  section, which had shipped unresolved.
* **Fixed: elevated execution of attacker-plantable uninstallers.** `queue.json`
  was user-writable and its stored `uninstallString` was executed as-is. The
  runner now re-reads each entry from the live registry at execution time, and
  an uninstaller registered under `HKCU` or whose binary sits in a user-writable
  location is refused unless the operator acknowledges it by name in a typed
  confirmation. The engine enforces this independently of the queue runner.
* New `test/security-verify.ps1` attempts each of these attacks and asserts it
  is refused; the suite also proves legitimate operations still work and that
  Audit Mode retains read access after the ACL change.
* New `test/ui-interaction-verify.js` loads the real UI offscreen and hit-tests
  every dialog control with `elementFromPoint`, asserting the topmost element at
  a button's centre is that button. Every other harness talks to the engine or
  the IPC layer and bypasses the DOM, which is how a whole broken dialog layer
  shipped past 280 passing assertions.

### Added - zero network, first-party assets
* **The last runtime network calls are gone.** The FontAwesome CDN stylesheet
  and the Google Fonts `@import` were fetched on every launch, contradicting
  Rule 6 / NFR-06. Replaced with:
  * `assets/icons.css` - a first-party 45-glyph icon set drawn on a 24x24 grid
    with a 2px stroke, delivered as CSS mask images so each glyph paints in
    `currentColor` and scales like the font glyph it replaced. Every existing
    `<i class="fa-solid fa-x">` keeps working unchanged. No third-party licence
    is carried.
  * The operating system's own type stack (Segoe UI Variable on Windows 11,
    Segoe UI on Windows 10), which reads as more native for a Windows utility
    and ships no font bytes.
* The Content-Security-Policy now names **no external origin at all**:
  `default-src 'self'` with `connect-src 'none'`.

### Added - Force Uninstall (REQ-20)
* A real Force Uninstall tab, replacing the placeholder alert. Vanish reads the
  uninstall hives itself and reports which applications can no longer uninstall
  themselves and why - a missing uninstaller executable, no `UninstallString`
  at all, or a vanished install folder - so the user does not have to remember
  what the application was called. Manual search by name or install folder is
  still available, with the three-mode discovery depth.
* When an entry can still uninstall itself, Vanish says so and offers to run
  the real uninstaller instead. Forcing is the fallback, never the default.
* The orphaned uninstall registry key is included in the proposal, because
  leaving it is what keeps a dead application listed in Programs and Features -
  and it goes through the vault like everything else, so a forced uninstall is
  reversible, listing included.

### Added - real Settings and About panels
* Settings is now a real panel owning deletion policy (auto-purge + retention),
  default scan depth, process refresh interval, and the on-disk locations of
  the vault and the operation log with their current sizes.
* About states plainly what Vanish is, what it refuses to do, and what it
  cannot promise, alongside build facts including "runtime network calls: none".
* New setting `defaultScanMode` (ENT-02, additive). Unknown values fall back to
  `Moderate` rather than breaking the reader (schema rule 5).

### Added - REQ-19 ownership elevator UI
* The purge summary now offers "Take ownership and retry" on the specific items
  that failed with an access error, and "Find what is holding it" on the ones
  that failed because they were locked. Per item, Full Mode only, and the
  manifest records that permissions were changed.

### Known issues
* Driver Store packages are listed but not removable (Stage 11, Standard tier).
* REQ-19's acceptance test - quarantining a TrustedInstaller-owned file - still
  needs a fixture that is awkward to create safely on a working machine; it is
  scheduled for the VM pass.
* The UAC accept/decline branches of the startup elevation offer still need a
  human at the prompt.

---

## [0.2.1] - 2026-06-26

### Changed
* Moved `research.md`, `BENCHMARKS.md`, and `RELEASING.md` from repository root
  into `docs/` to consolidate all documentation in one place.
* Updated `README.md` doc index to link all eight documentation files.
* Updated `docs/handoff.md`: Stage 2 marked complete, file map expanded with
  per-function descriptions for all Stage 2 additions.
* Added versioning policy to `docs/RELEASING.md`.
* CHANGELOG retroactively versioned from `0.0.0` with the new scheme.

---

## [0.2.0] - 2026-06-26

### Added
* **Stage 2 — Audit & Health Advisor** (`scanner.ps1`, `main.js`, `preload.js`,
  `index.html`, `index.css`, `renderer.js`):
  * `Get-SystemDiagnostics`: CIM-based OS, CPU, RAM, GPU, disk volume, and machine
    metadata queries — all via narrow `SELECT` filters to minimise query latency.
  * `Get-StartupItems`: Enumerates Registry Run hives (HKLM 64/32-bit, HKCU,
    RunOnce variants), logon-triggered Scheduled Tasks (non-Microsoft path only),
    and third-party auto-start services. Each item includes `exeExists` flag for
    orphan detection.
  * `Get-SoftwareRedundancy`: 14-category keyword clustering detects duplicate
    software installs (browsers, PDF readers, AV tools, video players, etc.).
  * Health Advisor nav tab with animated disk usage bars, startup item table
    (Registry / Task / Service source badges, Active / Inactive / Orphaned status
    dots), and redundancy alert groups with per-app pill lists.
  * All three CIM queries fired in parallel via `Promise.all`.

### Fixed
* **Promptgate Rule 13 violation**: `check-admin` IPC handler in `main.js`
  previously called `net session` via `exec`. Replaced with a dedicated
  `Check-AdminStatus` PowerShell function using the `WindowsPrincipal` API.

---

## [0.1.1] - 2026-06-26

### Added
* `README.md` at repository root (satisfies Promptgate Rule 22).
* `BENCHMARKS.md`: performance benchmark log template with required test-condition
  fields (CPU, RAM, storage type, app count, Windows version, cold vs warm run).
* `RELEASING.md`: code-signing release checklist with pre-distribution verification
  items.

### Fixed
* `research.md`: BCU description corrected; YARA framed as simplicity choice;
  elevation check updated to `WindowsPrincipal` API; handle closure rewritten;
  licenses appended to all 10 FOSS references; cloud threat intelligence exclusion
  disclaimer added.
* `CHANGELOG.md`: sorting fixed; frameless-window copy clarified; XML capitalised.
* `docs/architecture.md`: JavaScript and XML capitalisation fixed; Mermaid tag
  corrected; Threat Auditing section replaced with passive indicators list;
  Discovery Depth and Deletion Policy documented as separate axes; Quarantine-First
  model and Audit Mode fallback explicitly documented; performance figures labelled
  as design targets; Definitions Loader architecture added.
* `docs/handoff.md`: local repository paths replaced with canonical GitHub URL;
  `WindowsPrincipal` API reference updated; file status indicators added;
  Core-tier roadmap pointer added.
* `docs/roadmap.md`: Mermaid diagram tag corrected; Stage 5 Threat Hunting merged
  into Stage 3 and permanently removed from standalone scope; System Informer
  language corrected to C/C++; YARA maintenance note updated; winget lookup
  fallback chain documented; Stage 10 manual review requirement added; stage
  priority tiers table added; GPL licensing note added.
* `docs/promptgate.md`: local path example corrected.

---

## [0.1.0] - 2026-06-25

### Added
* **Technical stack foundation**: Electron + Node.js host window executing an
  asynchronous PowerShell backend via `spawn`.
* **`scanner.ps1` — execution engine**:
  * Unified JSON interface with Base64 payload encoding to prevent command-line
    argument escaping issues.
  * Desktop app mapping across `HKLM`, `HKCU`, and `Wow6432Node` Uninstall hives.
  * UWP Store app mapping with `AppxManifest.xml` friendly-name parsing and
    install-folder size estimators.
  * System Restore Point checkpointing via `Checkpoint-Computer`.
  * Three leftover scanning modes: Safe (exact path only), Moderate (partial
    name + publisher folder), Advanced (deep keyword + temp paths).
  * Recursive filesystem and registry remnant purging.
* **Electron main process (`main.js` + `preload.js`)**: Frameless window
  (`frame: false`), elevation checking via `WindowsPrincipal` API, native
  PowerShell `spawn` calls, and secure contextBridge IPC.
* **UI layout (`index.html`)**: Glassmorphic dashboard, sidebar navigation,
  search/filter/sort controls, app detail panel, and five-step uninstallation
  wizard overlay.
* **Styling system (`index.css`)**: Radial orbit animation, HSL design token
  palette, custom dark scrollbars, risk-level badge classes, toggle switches.
* **State controller (`renderer.js`)**: Concurrent app loading via `Promise.all`,
  name/date/size sort controls, search filtering, and wizard state machine.
* **Documentation suite**: `docs/architecture.md`, `docs/roadmap.md`,
  `docs/promptgate.md`, `docs/handoff.md`, `docs/vanish-corrections-report.md`.
