# Vanish -- the road to 1.0

Decided 2026-08-12. This file is the release scope. If something is not in
the ship list below, it is not in 1.0, and that is a decision rather than an
oversight.

The standard applied throughout, in the operator's words: *solve problems
that are not solved, use existing tools where possible, integrate existing
FOSS where necessary, do not build redundant nonsense.* Vanish exists
because this category is gatekept and commodified. A feature that duplicates
something the user already has is not neutral -- it is us becoming the thing
we objected to.

---

## Status and version plan — 2026-08-13

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
| **0.9** | Pre-release | The six elevated confirmations, the demo recording, code signing, a second machine, final docs pass |
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

## Ship list, in order

### Phase 0 -- unblock (operator, ~30 seconds)

- [ ] **`9rv`** Elevation round trip on real hardware: toggle startup-elevation
      off, **Restart now**, then **Restart as administrator**. `6lg`'s
      instrumentation is live and this machine's storage persists, so this
      yields either a clean instrumented pass or the first real
      `relaunch-elevated-mismatch` record ever captured. This is the only
      genuinely stuck item; everything else is unblocked.

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

- [x] **`1td`** Security review on the destructive surfaces. **Done 2026-08-13** — no defects; all 17 mutating IPC channels gated, 14 new regressions on the read-only surfaces.
- [x] **`vhm`** Security audit. **Done 2026-08-13**, scoped to the destructive surfaces and everything added this cycle rather than a full-codebase sweep — the scope is stated in the issue.
- [x] **`8ns`** **Done 2026-08-13.** Six storefronts recognised; Retry withheld where it cannot work. Platform-wrapped games (Steam, Epic) needed their own "needs
      attention" message in the bulk queue. The current generic "retry the
      silent switch" text can never work against `steam.exe`, so today the app
      tells the user to do something that cannot succeed. Design is already
      written up in the issue.
- [x] **`k2o`** Docs pass **done 2026-08-13** (README, CHANGELOG, ARCHITECTURE, including the renderer decomposition). The demo GIF still needs a human to record it.

### Phase 3 -- live verification (operator, Windows Sandbox)

All six are "does this actually work when elevated", and all six have been
blocked behind the same sandbox flakiness. Do them in one sitting once
Phase 0 settles what that flakiness actually was.

- [ ] `69a` elevated relaunch UAC branch on a spaced path
- [ ] `9sy` elevated `test/real-data-verify.js`
- [ ] `dmu` three startup actions elevated (remove / manual / disable)
- [ ] `e7q` Store-leftover sweep purges and restores a real folder
- [ ] `bfh.2` network hold applies and fully reverts
- [ ] `1qp` Force Uninstall acceptance

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
