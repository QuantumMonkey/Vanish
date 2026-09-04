# Vanish -- the road to 1.0, and past it

Decided 2026-08-12. This file is the release scope. If something is not in
the ship list below, it is not in 1.0, and that is a decision rather than an
oversight.

## What Vanish is -- amended 2026-08-28

Operator, 2026-08-28: *"vanish is no longer a simple uninstaller, it is a
premium [system cleaner] for developers and digital hygienists."*

The bracket is a redaction, made 2026-09-04 on the operator's instruction, and
the line it replaces was also the README's first line and the package
description. Both now describe the category in Vanish's own words. The
distinction being drawn: another product's name used as the category you claim
to BE is an identity claim on somebody else's mark, while the same name used as
the bar you have to clear -- as the next paragraph does -- is a comparison, and
stays. It has to stay, because the standard this file enforces requires naming
what already solves the problem before anything earns a bd issue.

That is a positioning decision and it changes what earns a bd issue. The
standard below does not move an inch -- if anything it bites harder, because
"a cleaner for developers" is precisely the claim a redundant feature would
love to hide behind. What changes is the comparison class. The question is no
longer "does Windows already uninstall programs" but **"does CCleaner, or
BleachBit, or WizTree, already do this for the person who has forty
repositories and six toolchains on one disk"** -- and for the three assets
below the answer is no, because none of those tools has an installed-program
map, a restorable vault, or any idea which of your files exist nowhere else.

It also settles the landing screen. A hygiene tool opens on its dashboard;
Health Advisor is the landing page as of 0.9.0.

## Versions no longer count down to 1.0 -- amended 2026-08-28

Operator, same day: *"we are no longer limited to 1.0 being the final variant,
so we can continue versioning as per all milestone changes. there have been
way too many 0.8.0 changes -- its not a fair comparison."*

Correct, and measurable: 0.8.0 was tagged on 2026-08-18 and by 2026-08-28 it
had absorbed the finder/decider seam, the whole machine-hygiene suite, the UAC
cause mapping, the live elevated relaunch proof, and the SEC-3 ownership fix.
Two builds both calling themselves 0.8.0 were not comparable in any useful
sense.

So: **one milestone, one MINOR bump**, and the numbers keep moving after 1.0
like any other project. 1.0 is the release that meets the gates in this file --
not a finish line, and not a licence to sit on a version number while work
piles up behind it. The rules are in [RELEASING.md](RELEASING.md), which was
rewritten the same day.

The table under "Status and version plan" below is the ORIGINAL 2026-08-13
plan and is kept for its reasoning. Where it disagrees with this section, this
section wins. In particular its "0.9 = pre-release chores" row no longer holds:
0.9.0 shipped as the machine-hygiene milestone, and those chores gate 1.0.

The standard applied throughout, in the operator's words: *solve problems
that are not solved, use existing tools where possible, integrate existing
FOSS where necessary, do not build redundant nonsense.* Vanish exists
because this category is gatekept and commodified. A feature that duplicates
something the user already has is not neutral -- it is us becoming the thing
we objected to.

---

## Status and version plan -- 2026-08-13

**Released 0.4.0.** Operator direction, same day: *everything gets done before
1.0; 0.9 is for the pre-release stuff; the other features are filed under the
versions in between.* So 1.0 now means **finished**, not "shipped with waivers",
and the waivers previously recorded against 1.0 move to 0.9's gate instead.

| Version | Theme | Contains |
| --- | --- | --- |
| **0.5** | Elevation you can trust | SHIPPED 2026-08-13. `1dq` (de-elevation reports success without verifying it), `qyt` (UAC disabled vs locked by policy), plus `5z5` and `c0y` as they were open bugs |
| **0.6** | Say which, and say what matters | SHIPPED 2026-08-14: `aaw` (GPU column names the adapter) and `ddx` (what can be reached from outside). Still open under this theme: `tda` (startup items split killable/necessary), `h55` (unlocker picks from a list), `5b0` (column filters) |
| **0.7** | Space you can actually recover | `7v3` (orphaned MSI/MSP cache, 1.2 GB measured), `be8` (firewall rule orphans), `ztl` (SharedDLLs + ghost PnP) |
| **0.8** | Other people's tools, used properly | `7sl` BUILT 2026-08-19 (consume BleachBit CleanerML definitions), `ag0` (Windows Update list + handoff), `bcu` (more game platforms), `ht8` (runtime redistributables) |
| **0.9** | Pre-release | ~~The six elevated confirmations~~ (done 2026-08-29), the demo recording, code signing, a second machine, final docs pass |
| **1.0** | Everything above, done | No waivers carried forward |

### What 0.9 actually is, in plain terms

Two things have been referred to by shorthand that was never explained:

**"The six elevated confirmations"** are six features that are already BUILT and
already pass their automated tests, but whose final check needs a human sitting
at a Windows UAC prompt, because consent dialogs cannot be automated by design.
Each is one manual run to confirm the thing does in real life what the tests say
it does:

| Issue | What you would actually do |
| --- | --- |
| `69a` | Launch Vanish from a folder path containing a space, click Restart as administrator, confirm it comes back elevated and not broken |
| `9sy` | Run `npx electron test/real-data-verify.js` from an admin PowerShell and check it passes against your real machine |
| `dmu` | On a startup entry, use each of Remove / Set to manual / Disable and confirm each does what it says |
| `e7q` | Let the Store-leftover sweep quarantine a real leftover folder, then restore it from Quarantine and confirm the folder is back |
| `bfh.2` | Turn the network hold on, confirm background transfers pause, turn it off, confirm everything returns |
| `1qp` | Force Uninstall one genuinely broken entry and confirm the outcome |

**"The demo GIF"** is a 30-60 second screen recording of one normal run - scan,
pick a program, walk the wizard, review the leftovers, purge - saved as
`docs/media/vanish-demo.gif` and dropped into the README where a placeholder
comment currently sits. It exists so someone landing on the repo can see what
the app does without installing it. It needs a human because it is a recording
of a person using software.

Neither is code. Both are 0.9.

## Cut permanently

Not deferred. Decided against, with the reason, so no future session
re-litigates them from scratch.

| Item | Why it is cut |
| --- | --- |
| `0ng` Driver Store sweeper | `pnputil` ships with Windows and Disk Cleanup already offers "Device driver packages". Worse, INV-1 **cannot** be honoured: `pnputil /delete-driver` destroys the FileRepository copy, so a restore manifest would be a promise the vault cannot keep. Building a removal that breaks our own foundational invariant, to duplicate a built-in tool, is the exact anti-pattern. The audit-only half already ships and is the honest version. |
| `dfe` WMI/DCOM orphans, event-log channels | P4, no committed timeline, no user-visible value, and Rule 17 would gate it behind mandatory per-item review anyway. Nobody has reported having this problem. |
| A removal engine for Windows Updates | See `ag0` below. The *list* is worth building; re-implementing `wusa`/DISM is not. |
| A read-only bandwidth panel | Task Manager and Resource Monitor both show per-process network, and our own Network Activity panel (`bfh.1`) already does attribution. Only the **hold** survives. |
| A treemap / "what is big" view | WinDirStat, WizTree, TreeSize and Windows' own Storage page all answer this. See `bu2` -- we build the half they all stop short of. |
| Hand-written cleaner definitions | BleachBit maintains hundreds in CleanerML and has for years. See `7sl` -- we bring the vault, not a second catalogue. |
| `cj9` Component store (WinSxS) via DISM | Killed 2026-09-04 on measurements, not argument. Windows ships this three ways -- `DISM /Cleanup-Image /StartComponentCleanup`, Disk Cleanup's "Windows Update Cleanup" (`scavengeui.dll`, `Autorun=3`), and Storage Sense, which fires the `\Microsoft\Windows\Servicing\StartComponentCleanup` task unattended. It did exactly that on this machine on 2026-09-02 at 18:58:38, result 0, which is why the 14 reclaimable packages this issue was filed on **measured 2 two days later with nobody touching it**: the feature cleaned up after itself while the issue sat open. And INV-1 cannot be honoured, for a stronger version of `0ng`'s reason -- `pnputil` destroys one FileRepository copy, but component cleanup deletes *hardlinked* payload (`fsutil hardlink list` on `System32\kernel32.dll` returns both the System32 and the WinSxS name; that fan-out is DISM's own "Shared with Windows: 8.21 GB") and commits a servicing transaction in the TrustedInstaller-owned COMPONENTS hive, so the authoritative state is not files at all. Our own code already says this: `Test-ProtectedDestination` blocks `%SystemRoot%\WinSxS`, quarantine asks the same predicate, and `security-verify.ps1` pins the refusal -- building it means deleting a shipping security assertion. The read-only half is already ours: `ag0` shells `dism /Online /Get-Packages` today. |

## Previously waived -- now moved into 0.9

These were waived when 1.0 meant "ship it". Under the current direction 1.0
means finished, so they are gates again rather than accepted costs. `1w0` and
`442` were deferred rather than closed precisely so this reversal was cheap.

| Item | Status | Cost of skipping, accepted knowingly |
| --- | --- | --- |
| `0xt` clean Win10/Win11 VM matrix | Closed | Win10-specific and clean-machine breakage (missing runtimes, different UAC defaults, no dev tooling present) ships undetected. Sandbox plus daily operator use is the acceptance bar. |
| `1w0` code signing + Store | Deferred | An unsigned exe trips SmartScreen's "Windows protected your PC" on any machine but this one. Matters the moment there is a second user. |
| `442` one external user | Deferred | The operator is the user for 1.0. |

---

## The three release gates, resolved -- amended 2026-09-04

The "Ship list, in order" block below gated the release on three things and
said none of the eighteen open bd issues moved any of them. The operator
settled all three in one message on 2026-09-04. Recorded here verbatim, because
this file is the scope authority and a decision that lives only in a chat log
is a decision the next session re-litigates:

> *"i dont need a code signing, its a take it or leave it publication. force
> uninstall was already tested by me. demo recording happens absolutely at the
> end, post dev."*

| Gate | Was | Now |
|---|---|---|
| **1. Unsigned binary** (`1w0`) | "should be a gate, not a deferral" | **Dropped.** Not a gate and not a deferral -- a decision. An unsigned exe that asks for administrator still trips SmartScreen's "Windows protected your PC" on every machine but this one, and that cost is now accepted knowingly rather than carried as unfinished work. |
| **2. `1qp` Force Uninstall on a real machine** | open | **Met.** The operator ran the destructive path and accepted it. |
| **3. Single-user acceptance + demo recording** | a gate | **Not a dev gate.** The operator is the user, and the recording is explicitly post-development. It cannot gate the code, because it is a recording OF the finished code. |

**So the release is no longer gated on anything outside the code.** What
remains is the bd board, and the sentence that used to sit under the ship list
-- "the coding backlog and the release gate are different lists" -- stops being
true here: as of this amendment they are the same list.

### What that changes about the standard, which is nothing

Dropping the signing gate is not permission to ship something rougher. It
removes an obstacle the operator judged not worth its cost for a non-commercial
publication; it does not touch Rule 10, INV-1, the finder contract, or any
other line in this file. A take-it-or-leave-it publication is still a
publication, and the thing being taken or left is the same product.

---

## Ship list, in order

> **What actually remains, as of 2026-08-29.** Phases 0 to 3 are closed. The
> release is gated on three things and only one of them is code:
>
> 1. **Unsigned binary** (`1w0`, currently deferred). An unsigned exe that asks
>    for administrator trips SmartScreen's "Windows protected your PC" on every
>    machine but this one. For a product whose entire pitch is that it tells
>    you the truth about what it is doing, shipping behind a scary override
>    dialog undercuts it more than any open bug does. This should be a gate,
>    not a deferral.
> 2. ~~**No clean-VM pass** (Rule 10).~~ **MET 2026-09-02.** Windows 10 was
>    dropped from scope by operator decision (they do not run it and will not
>    return to it), and the Windows 11 half is green in both tiers from one
>    command: `testun-all.ps1 -BothTiers`. `1qp` still needs its own real
>    run, because a suite passing is not evidence that a destructive path works.
> 3. **Single-user acceptance.** One external user, one demo recording.
>
> None of the eighteen open bd issues moves any of the three. That is the
> point of writing them down here: the coding backlog and the release gate are
> different lists, and progress on the first is not progress on the second.


### Phase 0 -- unblock (operator, ~30 seconds)

- [x] **`9rv`** **Closed.** Elevation round trip on real hardware: toggle startup-elevation
      off, **Restart now**, then **Restart as administrator**. `6lg`'s
      instrumentation is live and this machine's storage persists, so this
      yields either a clean instrumented pass or the first real
      `relaunch-elevated-mismatch` record ever captured. This was the only
      genuinely stuck item, and unblocking it is what let Phase 3 close.

### Phase 1 -- build (the two that carry the product story)

- [x] **`zrw`** Install snapshot diff. **Done 2026-08-12.** Snapshot Run-key hives and top-level
      Program Files / AppData before and after a monitored install, report the
      delta as real numbers. Reuses Stage 1's existing restore-point trigger.
      **First on purpose**: small, genuinely unserved (InstallWatch and ZSoft
      are dead and nothing replaced them), and it produces *ground truth*
      about which paths belong to which program -- the input the next item
      otherwise has to guess at.

- [x] **`bu2`** Size attribution. **Done 2026-08-13.** Joins the program
      folders against the installed-programs map, `corrections.json` and
      `zrw`'s recorded deltas. Output is not a treemap: it is "12.4 GB,
      belongs to a program that is no longer installed", quarantine-able
      through the existing vault. No auto-proposed deletions, no one-click
      clean.

      **Built differently from this plan, on purpose.** The plan called for MFT
      enumeration via `FSCTL_ENUM_USN_DATA` for WizTree-class speed. USN records
      carry names and parents but **not sizes**, so sizing that way means
      parsing raw `$MFT` records off the volume. The design was inverted
      instead: attribution is milliseconds and measurement is the expensive
      part, so classify first and measure only what classification could not
      explain, under a 20-second budget. The fast path stopped being necessary
      rather than being reimplemented. Full reasoning is in the header of
      `lib/attribution.js`.

### Phase 2 -- safety and honesty gates (must not ship without)

- [x] **`1td`** Security review on the destructive surfaces. **Done 2026-08-13** -- no defects; all 17 mutating IPC channels gated, 14 new regressions on the read-only surfaces.
- [x] **`vhm`** Security audit. **Done 2026-08-13**, scoped to the destructive surfaces and everything added this cycle rather than a full-codebase sweep -- the scope is stated in the issue.
- [x] **`8ns`** **Done 2026-08-13.** Six storefronts recognised; Retry withheld where it cannot work. Platform-wrapped games (Steam, Epic) needed their own "needs
      attention" message in the bulk queue. The current generic "retry the
      silent switch" text can never work against `steam.exe`, so today the app
      tells the user to do something that cannot succeed. Design is already
      written up in the issue.
- [x] **`k2o`** Docs pass **done 2026-08-13** (README, CHANGELOG, ARCHITECTURE, including the renderer decomposition). The demo GIF still needs a human to record it.

### Phase 3 -- live verification (operator, Windows Sandbox)

**Five of six closed. Reconciled 2026-08-29**, when this file was found still
showing them open while bd had them closed -- the scope authority disagreeing
with the tracker, which is the one disagreement this document exists to
prevent.

All six were "does this actually work when elevated", and all six were blocked
behind the same sandbox flakiness that `9rv` resolved. The suites behind them
then ran green from an elevated shell on 2026-08-29: Vault IPC 35, Startup
actions 27, System Clean purges 60, Data-dir ownership 12, Live elevated
relaunch 12, Force uninstall 19, De-elevation 20. The 0.5.0 note further down
this file -- that `vault-ipc-verify` and `phase4-ipc-verify` "refuse outside
Full Mode and need an elevated shell" -- is answered. They were run. They pass.

- [x] `69a` elevated relaunch UAC branch on a spaced path
- [x] `9sy` elevated `test/real-data-verify.js`
- [x] `dmu` three startup actions elevated (remove / manual / disable)
- [x] `e7q` Store-leftover sweep purges and restores a real folder
- [x] `bfh.2` network hold applies and fully reverts
- [x] `1qp` Force Uninstall acceptance -- **done 2026-09-04**, by the operator,
      stated directly: *"force uninstall was already tested by me."* It never
      was a code gate; the suite has been green since it shipped. It was the
      Rule 10 point that a passing suite is not evidence a destructive path
      works on a real machine, and a human ran the destructive path.

**What an elevated run does NOT establish** -- found the same day, bd `pnor`.
An Administrator token reads straight through a Deny ACE, so nine suites
cannot construct the access-denied condition they exist to test and skip it.
The elevated run covers 225 assertions the unelevated one skips, and loses 9
that only the unelevated one can reach -- and those 9 are the ones proving a
finder reports **could-not-look** rather than nothing, which is the contract
this whole product rests on.

Neither run is the whole suite. **Rule 10's clean-VM pass is therefore two
passes per VM, elevated and not**, and a green number from one of them is not
evidence about the other.

**Both halves from one session, 2026-09-02.** `testun-all.ps1 -BothTiers`,
started from an elevated shell, runs Full Mode itself and then re-runs itself
through a scheduled task at `RunLevel Limited` for the Audit Mode half. That is
the same de-elevation mechanism `scanner.ps1` ships, chosen because it is the
only one of three that measurably works here -- `runas /trustlevel` exits 1 and
`CreateProcessWithTokenW` on the explorer token dies `0xc0000142`. The two
totals are printed side by side and deliberately **not added**: most suites run
in both tiers, so a sum would count the same assertion twice and read as growth.

It checks the child's own elevation rather than trusting the drop. Where UAC is
disabled (`EnableLUA=0`, which is what the Windows Sandbox image ships) there is
no standard-user token to drop to, the child comes back elevated, and the run
says the other half **could not run** instead of counting a second Full Mode
pass as coverage. So this makes Rule 10 one command per machine on a normal
Windows install, and changes nothing about the sandbox, which still needs UAC
enabled in-guest and a restart to produce its Audit Mode half.


### Phase 4 -- cut the release

- [x] **Done for 0.4.0.** `npm test` 544/544. Both artifacts built. `app.asar`
      extracted and diffed against source (main, preload, index.html/css, the
      renderer modules and every `lib/` module all identical); `scanner.ps1`
      and `corrections.json` sha256-identical. The packaged app was then
      **booted from `app.asar`** and asserted to resolve its cross-module
      functions with a clean console -- the check that would have caught the
      `package.json` omission the renderer split introduced.
- [x] Version bumped to 0.4.0, CHANGELOG dated, tagged, pushed.
- [x] Known-limitations note in the README covering the three waived gates:
      unsigned binary, no clean-VM pass, single-user acceptance.

#### 0.5.0 -- 2026-08-13

- [x] `npm test` 660 passed, 0 failed. Two suites report NOT RUN and always
      have: `vault-ipc-verify` and `phase4-ipc-verify` both refuse outside
      Full Mode and need an elevated shell. That gap is `9sy`, not a
      regression.
- [x] `qyt` shipped, which was 0.5's remaining scope. `1dq` closed 2026-08-13.
- [x] `5z5` and `c0y` fixed and pinned by new suites
      (`details-panel-layout-verify`, `install-date-provenance-verify`,
      `uac-lock-verify`).
- [x] **The de-elevation round trip was done, and it found the bug.** The
      operator ran a 0.5.0 artifact 2026-08-13; `1dq`'s instrumentation
      produced the first `relaunch-deelevated-mismatch` ever recorded, and a
      follow-up probe from an elevated shell measured all three candidate
      mechanisms. `runas /trustlevel:0x20000` -- the Windows-documented one --
      does not work on that machine and exits 0 while failing. A scheduled
      task at `RunLevel Limited` drops privilege correctly. Shipped in 0.5.2,
      confirmed working by the operator.

#### 0.6.0 -- 2026-08-14

- [x] `npm test` 719 passed, 0 failed.
- [x] `ddx` shipped -- the listener panel. `aaw` closed across 0.5.0-0.5.3.
- [x] Both artifacts built, `app.asar` hash-matched, packaged app booted clean.
- [ ] **The six elevated confirmations are still outstanding.** Four of them
      (`dmu`, `e7q`, `bfh.2`, `9sy`) now have a single runner:
      `test/elevated-confirmations.ps1`. It has NOT been run yet -- the
      first attempt used a `Start-Process -ArgumentList` form that splits on
      the space in the repo path, so the elevated window opened and did
      nothing. The corrected invocation quotes inside the argument.
- [ ] `69a` cannot go in that runner: it tests the UAC branch itself and needs
      an UNELEVATED start. `1qp` needs a clean VM.

#### 0.6.6 -- 2026-08-16

- [x] `npm test` 845 passed, 0 failed (838 before).
- [x] `qof` and `6d7` fixed and closed; `bkn` re-proved and closed; `17z`
      decided (leave both Type controls).
- [x] **The repository moved** from `D:\quickhelp projects\vanish-uninstaller`
      to `D:\quickhelp\vanish-uninstaller`. The space that had been breaking
      `Start-Process` argument handling for two sessions is gone from the path,
      which HIDES that trap rather than removing it -- any clone into a spaced
      path still hits it, and the sandbox mapping deliberately keeps a space
      (`Desktop\test folder\...`) as `69a` coverage. The quoting stays and the
      comments explaining it have been corrected to say so.
- [x] `0kp` filed and fixed: the sandbox `.wsb` still mapped the OLD path, so
      Windows Sandbox -- the acceptance route for `1qp` and all of Phase 3 --
      refused to start and nothing said why. `test\sandbox\start-sandbox.ps1`
      now resolves the checkout at run time.
- [x] `h55` design pass done and recorded in the issue. It found that the
      "known locked items" list **has no source on disk**: the oplog records
      only counts of failed items, and a purge where everything was locked
      writes nothing at all. Implementation is held on one operator decision,
      named in the issue -- it needs a new persisted record of failed-delete
      paths, which is a privacy-shaped call rather than a UI one.
- [x] **The elevated run HAPPENED, 2026-08-18.** It cleared `bfh.2` (6/6),
      `e7q` (43/0), `9sy` (166/0 after two real fixes) and `dvc`, and the
      operator's standing rpdsvc request is done. It also found three real
      defects no fixture suite could reach - see 0.8.0 in the CHANGELOG.

#### 0.8.0 and 0.9 progress -- 2026-08-18

**All six elevated confirmations are now resolved or reduced to a machine
problem.** This was the largest single item left in 0.9:

| Issue | Outcome |
| --- | --- |
| `dmu` | CLOSED. Engine half 12/0, and a new IPC suite proves the vault half 27/0 - the manifest is written before the mutation, restore is byte-identical, and a refusal changes nothing. |
| `e7q` | CLOSED. 43/0 elevated, headless, byte-identical folder restore by SHA256. |
| `bfh.2` | CLOSED. 6/6 - the hold applies, reverts, and DELETES the policy value rather than zeroing it. |
| `9sy` | CLOSED. 166/0 elevated, after fixing the two real defects the first run found. |
| `69a` | STILL OPEN. Needs an unelevated start and a human watching the app relaunch itself. |
| `1qp` | STILL OPEN. Needs the clean VM, which `start-sandbox.ps1` has made reachable again. |

Also closed this day, all of which had been built and never verified:
`frr` and `zl4` (both sat in_progress for nine days behind "needs a human" -
neither did; the notes on each issue say why), `ytv` (verified as far as one
machine can, with the three environment cases it cannot cover printed by the
suite itself), `dvc`, `87u`, `z3s`, `qof`, `6d7`, `bkn`, `0kp`, `17z`.

Features shipped: `7v3`, `be8`, `ztl` (0.7.0), `ht8`, `ag0` (0.8.0).
`bcu` deferred with evidence - none of the four launchers is installed on any
machine we can read, and its own note says implementing from documentation
risks attaching a wrong size to a real game.

**The one finding that outranks the features**, recorded here because it
changes what the vault is allowed to do: the quarantine path could accept a
file the restore path would refuse to put back, stranding it permanently. It
surfaced only because `7v3` looks inside `%SystemRoot%`. Quarantine now asks
the same question restoring does, through the same function. The consequence
is that `7v3` ships audit-only: its 137 MB is identified and stays unclaimed,
because offering the removal would be a deletion with no way back dressed as a
reversible one. Unlocking it means deciding whether a restore to a file's own
recorded original path may write into a protected location - a security call
for the operator, and the open half of `z3s`.

**`z3s`'s open half is DECIDED, 2026-08-19.** The operator allowed a restore
into a protected location when the destination is the file's own recorded
original path. It could not be implemented as worded -- "where we took it
from" is a claim the user-writable manifest makes, and the restore runs
elevated, so the literal form is an elevation-of-privilege primitive. It
ships as a narrow exception instead: the Windows installer cache only, `.msi`
and `.msp` only, nothing already at the destination, and only while the vault
data directory still passes the SEC-3 ownership check. `7v3` is removable as
a result -- 136.8 MB measured here, reversibly.

**Proved end to end 2026-08-20**, elevated on the dev host: a real cached
installer into the vault, out of the cache, restored to its own path inside
`%SystemRoot%\Installer`, byte-identical by SHA256 -- and a file the exception
does not cover, planted in the same directory, refused before anything moved.
Windows Sandbox cannot run that leg at all: a fresh VM has never installed
anything by MSI, so the sweep correctly finds nothing to act on. The host is the
venue.

**What 1.0 still needs**, and none of it is code that can be written here:

- `69a`, `adg` - a human at the app, unelevated, watching one relaunch.
- `1qp`, `0xt` - a clean VM pass. Now reachable via `start-sandbox.ps1`.
- `ytv`'s three environment cases - a second machine, ideally not an
  administrator account.
- ~~`7sl` - the CleanerML adapter, the last unbuilt 0.8 feature.~~ BUILT
  2026-08-19: MIT reader, the definitions cleaner, and the vault route. It
  deliberately ships NO definition of our own - see the note under 0.8
  below - and still wants one acceptance pass against a real BleachBit
  install, which needs a machine that has one.
- The demo GIF, code signing, one external user.

- [ ] **Superseded note kept for the record:** 0.5 did not claim
      it.** The theme is "elevation you can trust" and what shipped is
      elevation that cannot lie to you about what happened -- detection, not
      a proven mechanism. The oplog's last entry is still
      `2026-08-13T04:37:29` from a pre-fix build. Until an operator does one
      round trip on a 0.5.0 artifact, whether `runas /trustlevel:0x20000`
      actually drops privilege on this machine remains unknown, and `9rv`
      stays open by its own design note: do not build more diagnostics
      before taking the one measurement.

---

## Post-1.0, in the order they earn their place

1. **`7v3`** Orphaned MSI/MSP installer cache (1.2 GB measured 2026-08-02).
   The first finding type to run through `bu2`'s attribution pipe rather than
   getting its own panel. What we add over PatchCleaner is the vault.

2. ~~**`7sl`** CleanerML adapter.~~ **BUILT 2026-08-19.** An MIT reader in
   the engine, a "Cleaning definitions" section that reads whatever the
   user already has (an installed BleachBit, or a folder they point at),
   and every removal through the vault. No definition file is vendored:
   BleachBit is GPL-3.0 and CleanerML definitions are GPL-3.0+, this repo
   is MIT and public, and `INV-4` forbids fetching them anyway.

   **It ships no cleaning rules of its own, on purpose.** The order of work
   on the issue called for one Vanish-native definition to prove the
   pipeline end to end. Every category we could have written one for -
   temporary files, browser caches, log sweeps - is already covered either
   by a Windows built-in or by the definitions we now read, so shipping one
   would have been the redundant nonsense this repo refuses to build. The
   end-to-end proof comes from fixture definitions the test suite writes
   itself (`test/cleanerml-verify.ps1`, 61 assertions) rather than from a
   category we would then have to defend.

   Only `delete` is executed. The other seventeen CleanerML commands edit a
   file in place, drive a package manager or act on the running system, and
   none of those is a change the vault can undo - so an option containing
   one is withheld ENTIRELY and named in the panel, rather than half-run.

3. **`ag0`** Windows Update: a legible list (`Get-HotFix` + DISM
   `/Get-Packages`, read-only) showing type, install date, and whether the
   update is removable at all -- then hand off to `wusa.exe /uninstall` or the
   Settings page for the actual removal. We never own that removal, and the UI
   must not imply we can reverse it.

4. **`be8`**, **`ztl`** Firewall-rule orphans, SharedDLLs dead references,
   ghost PnP devices. Cheap finding types on a scan surface that is already
   open. They free zero bytes; ship them when the surface is open anyway,
   never as their own project.

5. **`bfh`** narrowed to the hold only (`bfh.2` is already built).

6. `qyt`, `5b0`, `h55`, `bcu`, `ht8` -- quality-of-life, no ordering
   constraint between them.

---

## The through-line, for whoever picks this up

Vanish has exactly three assets nothing else in this category has:

1. the installed-program map (`scanner.ps1` + `corrections.json`),
2. the quarantine vault with a real restore path (INV-1),
3. the tier and consent model -- it refuses by name, with a reason.

Every feature worth building is leverage on one of those three. A feature
that touches none of them is commodity, and somebody else already maintains
a better version of it for free.
