# Vanish: Performance Benchmarks

Design targets live in `docs/architecture.md` and stay labelled "Design Target"
until a measured figure lands here (promptgate Rule 9). A number in this file is
a measurement, taken on the machine described in its run block. Nothing here is
a promise about other hardware.

Every run block records: CPU model, RAM, storage type, installed application
count, Windows version and build, and whether the run was cold or warm.

---

## Run 001 - 2026-08-03 - developer machine, phase 1-4 implementation

| Condition | Value |
|---|---|
| CPU | AMD Ryzen 9 5900HX (8 cores / 16 threads) |
| RAM | 15 GB |
| Storage | NVMe SSD |
| Installed desktop applications | 86 |
| Running processes at sample time | ~305 |
| Windows | Windows 11 Pro, build 26200 |
| Run type | Warm (PowerShell and CIM already exercised) |
| Elevation | Full Mode |

> Caveat: this is the development machine, not a clean VM. Rule 10 still governs
> the "Complete" label - the clean Windows 10 (1607+) and Windows 11 VM figures
> from TASK-17 are the ones that count for release. Treat these as an
> engineering baseline that says "the design targets are reachable", not as the
> validated release numbers.

### NFR-03 - process monitor refresh (REQ-06)

| Measurement | Value | Target |
|---|---|---|
| Full sample round trip (spawn + 2 CIM queries + 400ms sampling window) | **1.47 - 1.57 s** | <= 2 s refresh interval |
| Of which: deliberate CPU sampling window | 400 ms | - |
| Processes enumerated | 304 - 305 | - |

Reading: the default 2 s refresh holds, but with roughly 0.4 s of headroom on
this machine. Each refresh spawns a fresh `powershell.exe` and runs two CIM
queries; that fixed cost, not the sampling window, dominates. The renderer
guards against overlap (a new sample is skipped while one is in flight), so a
slower machine degrades to a longer effective interval rather than stacking
work. The `< 5% CPU` half of NFR-03 is **not yet measured** and remains a
Design Target.

If the VM pass shows this exceeding 2 s, the known lever is dropping the second
(narrow) CIM query and reporting cumulative I/O instead of a per-second rate.

### OPEN-03 - Restart Manager interop cost (TASK-07)

| Measurement | Value |
|---|---|
| First `list-lockers` call, engine-reported `Add-Type` + P/Invoke init | **345 ms** |
| Same call, wall clock including process spawn | **806 ms** |

Resolution: OPEN-03 is closed as a non-issue. The feared 1-2 s JIT cost for the
inline C# did not materialise, and the cost is paid only by the unlock actions -
never by the process refresh loop. The pre-warm mitigation described in
`01-trd.md` is not needed and was not implemented.

---

## Run 005 - 2026-09-04 - the same machine - what the vault hash actually spends

| Condition | Value |
|---|---|
| CPU | AMD Ryzen 9 5900HX (8 cores / 16 threads) |
| RAM | 15 GB |
| Storage | NVMe SSD |
| Windows | Windows 11 Pro, build 26200 |
| Elevation | Full Mode |
| On-access scanner | Kaspersky (`klif.K4W-21-26`, minifilter altitude 320400). Defender `AMRunningMode: Not running` |
| Run type | both, deliberately - this run is ABOUT cold against warm |

This run closes `vanish-uninstaller-nkc7`, which recorded that
`Get-VaultContentHash` took ~270 ms standalone and ~6,300 ms inside the engine
on the same 2,000-file tree, and named three suspects: deep call-stack variable
resolution, the engine's loaded state after 8,500 lines, and the move.

**All three are wrong, and there is no engine-side slowdown at all.** The
original pair of numbers compared a WARM standalone read against a COLD engine
read. Everything else followed from that.

### The three suspects, each measured rather than argued

Same 2,000-file tree, same function text, one process per row:

```
function at top level, called at top level          253 ms
function at top level, called four frames down      256 ms
scanner.ps1 dot-sourced, called at top level        248 ms
scanner.ps1 dot-sourced, called four frames down    248 ms
```

Call depth is worth 3 ms. Loading all 8,500 lines is worth -5 ms. Dot-sourcing
scanner.ps1 itself costs 115 ms, once, and is not in the hash at all.

The move is not it either. A real `quarantine-items` through the engine -
process spawn, parse, protected-destination checks, `Move-ItemTransactional`,
then the hash - against a tree whose bytes have already been read once:

```
engine spawn + parse baseline        477 ms
quarantine, COLD tree              3,500 ms   (3,024 ms above baseline)
restore (reads every byte)           702 ms
quarantine, WARM tree                828 ms   (  352 ms above baseline)
```

352 ms of real engine work against 250 ms standalone. The engine is fine.

### Where the cold time goes: the OPEN, not the read and not SHA256

Phase instrumentation, 2,000 files written by a previous process:

```
              COLD                          WARM
enumerate       90 ms                        87 ms
sort            57 ms                        55 ms
size loop        6 ms                         6 ms
stream       2,734 ms                       164 ms
  of which
  OpenRead   2,616 ms                        78 ms
```

96% of the cold cost is inside `[System.IO.File]::OpenRead`. The reads and the
SHA256 transforms are the same either way.

### It tracks file COUNT, not bytes

Which is what separates a per-file on-access scan from a page-cache miss. Each
fixture written by a child process, read by the parent, then read again:

| Fixture | Files | MB | Cold open | Per open | Warm open |
|---|---|---|---|---|---|
| 2000 x 400 B | 2000 | 0.77 | 2,569 ms | 1.29 ms | 70 ms |
| 200 x 4 KB | 200 | 0.76 | 561 ms | 2.81 ms | 7 ms |
| 2000 x 40 KB | 2000 | 76.30 | 4,364 ms | 2.18 ms | 67 ms |

Same bytes, a tenth of the files: 4.6x less time. A hundred times the bytes at
the same file count: 1.7x more. So the dominant term is per-file, with a
smaller content term on top - and the verdict is cached machine-wide, because
the second read is 35x cheaper *from a different process*.

That is the signature of a filesystem filter evaluating each file the first
time it is opened. This machine has one attached at altitude 320400 and
Defender is not running. Stated as the shape of the cost rather than as a
proven attribution: this run did not disable the filter to confirm it, because
changing a machine's security posture to make a benchmark look better is not a
measurement.

### What follows for the cap

`VaultHashMaxFiles` stays at 2,000, and the reasoning changes rather than the
number. A quarantine is BY DEFINITION a first touch - the files are being moved
somewhere precisely because nobody is using them - so the cold path is the only
one that matters and the cap must be set from it.

There is also nothing to optimise. Verifying content means opening every file
once, the opens are where the time goes, and the reads are already free. The
one lever left is reading in parallel so the filter's latency overlaps, which
in PowerShell 5.1 means runspaces inside an 8,500-line script to save a couple
of seconds on a deliberate action that already shows a spinner. Not worth it.

The honest caveat is that the cost is a property of the operator's machine, not
of Vanish: the same tree on a machine with no on-access scanner would hash in
roughly the warm number. That is the reason not to raise the cap on the
strength of these figures - 4,000 files is 6 s here and unknown elsewhere.

### Reproducing these

The four probes are in `test/sandbox/vault-hash-cost-probe.ps1`. They write
fixtures into `%TEMP%` and delete them afterwards. Not in `run-all.ps1`, for
the reason the previous run block gives: a timing assertion on someone else's
disk is a flaky test wearing a performance badge.

---

## Run 004 - 2026-09-02 - the same machine, warm, after 127o and 087y

| Condition | Value |
|---|---|
| CPU | AMD Ryzen 9 5900HX (8 cores / 16 threads) |
| RAM | 15 GB |
| Storage | NVMe SSD |
| Windows | Windows 11 Pro, build 26200 |
| Run type | Warm |
| Elevation | Full Mode |
| Pool | `HYGIENE_CONCURRENCY = 3` |

Run 003 is superseded for `local-only-credentials` and for the shape of the
tail. Two fixes landed between them: `127o` (skip reparse points in the shared
walk) and `087y` (breadth-first, so the directory budget is not spent down one
branch). Per `machine-timing-volatility`, cross-run figures on this machine are
worth 1.5x of noise, so the cross-run claims below are only made where the
change is far outside that band or where the CORRECTNESS changed too.

### `local-only-credentials`, profiled alone (`ho2-profile-probe.ps1`)

| | Run 003 | Run 004 | |
|---|---|---|---|
| total walk | 34,637 ms | **15,988 ms** | 2.2x faster |
| directories | 30,656 | 18,644 | |
| roots hitting the 15,000 cap | 2 of 7 | 1 of 7 | |
| **candidates found** | **0** | **4** | |

The last row is the one that matters. Run 003's zero was not a clean machine,
it was a walk going round its own prune list through `Local Settings` and
`Application Data` - junctions to `AppData\Local`, which is pruned - and
spending the whole budget on alias paths. It reported could-not-look, correctly,
and the operator got that instead of four real candidates.

Per root, warm:

| Root | Time | Dirs | Candidates | Repos |
|---|---|---|---|---|
| `C:\Users\Anand` | 2,850 ms | 2,986 | 4 | 12 |
| `D:\Dependencies` | **12,547 ms** | **15,000 capped** | 0 | 1 |
| `D:\Claude Setups` | 453 ms | 517 | 0 | 1 |
| `D:\quickhelp` | 86 ms | 59 | 0 | 1 |
| `D:\Ideations` | 42 ms | 71 | 0 | 1 |
| `C:\tmp` | 8 ms | 8 | 0 | 1 |
| `D:\Vault` | 2 ms | 3 | 0 | 1 |

`C:\Users\Anand` fell from 23,160 ms / 15,000 capped dirs to 2,850 ms / 2,986
dirs and went from 9 repos (every one an alias path) to 12 real ones. The
reparse skip did that.

`D:\Dependencies` is now 78% of the check and still caps, so it also emits a
`scan-capped` could-not-look that no amount of re-running will clear. It is a
search root only because `D:\Dependencies\Flutter` holds a `.git`; the selector
knows that and discards it, and the walker re-derives it by brute force through
`Gradle` (163,476 files). Filed as `vanish-uninstaller-nq21`.

`git check-ignore` costs 64.0 ms per call over 4 candidates - 256 ms projected,
1.6% of the check. It was never the cost.

### The whole panel, all thirteen checks (`hygiene-wallclock-probe.js`)

WALL CLOCK **162.6 s**, 13 checks, pool 3, decided `has-work`,
4,144 findings / 26,773 unreadable.

| Check | Elapsed while running |
|---|---|
| `duplicate-content` | **143,658 ms** |
| the four reclaim checks (3l8 group) | 32,259 ms |
| `local-only-credentials` | 21,273 ms |
| `gitignored-unique` + `repo-health` (lxl group) | 18,900 ms |
| `reclaim-package-caches` | 16,565 ms |
| `redirect-variables` | 13,015 ms |
| `duplicate-installs` | 1,777 ms |
| `path-hygiene` | 1,027 ms |
| `profile-list` | 1,022 ms |

**THE TAIL HAS MOVED, and it is not `local-only-credentials` any more.**
`duplicate-content` is 88% of the wall clock in this run.

**But 143.7 s is a CONTENDED number, not the check's cost.** Run alone, warm,
through the engine directly, the same check takes **36,828 ms** and returns
4,040 findings with 46 unreadable. So roughly 107 s of its in-panel elapsed
time is time spent sharing a disk with twelve other checks at pool 3, not work.

That distinction is the whole reason this section prints both. The per-check
column in a pooled run measures *elapsed while it was running*, which for the
longest-running check is close to the wall clock by construction. Reading it as
"this check costs 143 s" would send the next person to optimise a check that is
mostly waiting.

### What the panel actually hands the user

| | |
|---|---|
| findings | 4,144 |
| of which `duplicate-content` | 4,040 (97.5%) |
| rendered per module | 100 (`HYGIENE_RENDER_CAP`) |

`duplicate-content` is registered `-module 'rescue'`, alongside
`local-only-credentials` and `gitignored-unique`, and every one of its findings
is `costClass: 'cheap'`. `rankFindings` sorts cheap first. See
`vanish-uninstaller-xr7j`.

### Reproducing these

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\ho2-profile-probe.ps1
npx electron test\sandbox\hygiene-wallclock-probe.js
```

---

## Run 003 - 2026-08-29 - the same machine, warm, after a day of walking it

Same hardware as Run 002. Taken late in the same day, after every tree in
this file had been walked repeatedly, so the file-system cache is as hot as
it gets.

**This run exists because Run 002's numbers do not reproduce.** The identical
13 checks, the identical scheduling, summed **210.4 s** in Run 002 and
**136.8 s** here. 1.5x, same code, same machine, nothing changed but cache
warmth. Three separate bd issues were filed on Run 002 figures and all three
had to be re-based against this table.

### Pool size: is running three at once actually paying?

The comment in `renderer/hygiene.js` asserted for months that extra processes
"just queue on the same spindle ... without finishing the set any sooner".
One sitting, one scheduling, three pool sizes:

| Pool | Wall clock | Summed engine time |
|---|---|---|
| 1 | 136.8 s | 136.8 s |
| 2 | 78.4 s | 143.4 s |
| 3 | **58.1 s** | 145.1 s |

Three at once inflates each individual check by **6.1%** and cuts the wall
clock by **2.35x**. The old comment had the sign right and the magnitude
badly wrong. Whether 4 pays is untested and the comment now says so.

### Where the time actually goes, every unit, one run

Pool 3, shared walks, largest unit first. WALL 59.9 s, summed 148.7 s, 9 calls.

| Unit | Time |
|---|---|
| `local-only-credentials` | **40.0 s** |
| `duplicate-content` | 35.3 s |
| the four reclaim checks (3l8 group) | 24.0 s |
| `reclaim-package-caches` | 19.1 s |
| `redirect-variables` | 14.5 s |
| `gitignored-unique` + `repo-health` (lxl group) | 12.6 s |
| `duplicate-installs` | 1.6 s |
| `path-hygiene` | 0.8 s |
| `profile-list` | 0.8 s |

**The tail is `local-only-credentials`, and it shares a walk with nothing.**
Both shared-walk changes shipped this week -- 3l8 and lxl -- land in the
middle of this table. The work was real and the findings did not move, but
neither one was ever touching the slowest thing the panel does. That is bd
`vanish-uninstaller-o1mj`, and it is unprofiled.

Theoretical floor for this profile is `max(40.0, 148.7 / 3)` = 49.6 s against
59.9 s actual, so perfect scheduling is worth about 10 s (`4v8`).

### The scan's tail was not a speed problem (o1mj)

> **Superseded by Run 004 (2026-09-02).** Both fixes this section calls for --
> `127o` (skip reparse points) and `087y` (breadth-first) -- have shipped. The
> numbers below are the BEFORE state, kept because the reasoning is still the
> record of how the cause was found. The check is now 15,988 ms and finds 4
> candidates where this run found 0.


`local-only-credentials` was the slowest unit in Run 003 at 40.0 s, and the
only one neither shared-walk change had touched. Profiled alone, warm, nothing
else on the disk:

| Root | Time | Directories | Repos | Candidates |
|---|---|---|---|---|
| `C:\Users\Anand` | 24,458 ms | 15,000 **capped** | 9 | 0 |
| `D:\Dependencies` | 9,544 ms | 15,000 **capped** | 0 | 0 |
| `D:\Claude Setups` | 501 ms | 517 | 1 | 0 |
| `D:\quickhelp` | 79 ms | 57 | 1 | 0 |
| `D:\Ideations` | 45 ms | 71 | 1 | 0 |
| `C:\tmp` | 8 ms | 8 | 1 | 0 |
| `D:\Vault` | 2 ms | 3 | 1 | 0 |
| **total** | **34,637 ms** | 30,656 | 14 | **0** |

Two of seven roots exhausted their 15,000-directory budget and between them
account for 34.0 s of the 34.6. The other five cost 0.6 s together.

`Get-Ho2DefaultRoots` takes 80 ms and returns seven roots with no overlap, so
neither root selection nor duplicated roots is the cost. There is one walk per
root, not one per credential pattern, so this is not e6gn's defect either. The
`git check-ignore` subprocess per candidate costs nothing here because there
were no candidates -- which was itself the finding.

**The budget was being spent going round the check's own prune list.**
`AppData` is pruned by name. `Local Settings` and `Application Data` are
junctions to `AppData\Local` and are not pruned, and the walk had no
reparse-point test. Same tree, one line added:

| | shipped | skip reparse points |
|---|---|---|
| `C:\Users\Anand` | 23,160 ms, 15,000 dirs, 9 repos, **0 candidates**, capped | 2,958 ms, 2,991 dirs, 12 repos, **4 candidates** |

Every one of the nine repositories the shipped walk found was an alias path.
It missed all five real ones under `Documents\GitHub`, and it reported zero
credential files on a machine with four `.npmrc` files inside repositories.
The check was reporting could-not-look, correctly, and the operator was
getting that instead of four real findings.

`D:\Dependencies` still caps either way, and that is a different defect: the
walk is depth-first, so the budget goes into `D:\Dependencies\Gradle` (163,476
files, see the sizing note above) while `D:\Dependencies\Flutter`, which has
the `.git` that made the folder a search root in the first place, is never
popped off the stack. Filed as `vanish-uninstaller-087y`.

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\ho2-profile-probe.ps1
```

### Why this table is shaped like this

Until this run the scheduling probe printed only the SLOWEST unit. One number
per run is an invitation to compare it against a number from a different run,
and on this machine that comparison is worthless. It now prints every unit,
always. The probe also takes `VANISH_PROBE_CONCURRENCY` and
`VANISH_PROBE_PASS`, so the sweep above is reproducible rather than a one-off:

```
VANISH_PROBE_CONCURRENCY=1 VANISH_PROBE_PASS="largest unit first" node test\sandbox\hygiene-scheduling-probe.js
```

---

## Run 002 - 2026-08-29 - developer machine, Machine Hygiene panel (lhf, 3l8, lxl)

| Condition | Value |
|---|---|
| CPU | AMD Ryzen 9 5900HX (8 cores / 16 threads) |
| RAM | 15 GB |
| Storage | NVMe SSD |
| Home directory | `C:\Users\Anand`, walk capped at 15,000 directories |
| Markers found in one walk | 232 `package.json`, 508 `pubspec.yaml`, 1 `gradlew`, 44 `.zip` |
| Repositories found in one walk | 14 (the two git checks, depth 6) |
| Windows | Windows 11 Pro, build 26200 |
| Run type | Warm (the same tree walked immediately beforehand) |
| Elevation | Audit Mode |

> Caveat, same as Run 001: this is the development machine. These numbers say
> the shape of the cost, not what a clean VM will do. What they are good for is
> comparing Vanish against itself, which is what every figure below does.

### Where the time went, before anything was changed

Both of the changes below were profiled BEFORE being written, and in both cases
the profile disagreed with the predictions recorded in the issue. `lhf` had
guessed at scan depth, root selection and the hashing step; the real causes were
a duplicated sizer, one path measured twice, and PSObject overhead. `3l8` had
assumed a shared walk would need all thirteen checks in one process.

### The shared directory sizer (lhf)

| Check | Before | After |
|---|---|---|
| `duplicate-content` | never completed (capped at 240 s) | 86.0 s |
| `redirect-variables` | 59.6 s | 12.8 s |
| `reclaim-package-caches` | 52.3 s | 25.5 s |
| `repo-health` | 15.4 s | 8.3 s |
| `gitignored-unique` | 14.6 s | 8.0 s |

`redirect-variables` was the slowest check in the suite while examining five
things: with neither `ANDROID_HOME` nor `ANDROID_SDK_ROOT` set, both resolve to
the same folder, so it measured 129,198 files twice to print 13 GB twice.

### The shared tree walk (3l8)

| Measurement | Value |
|---|---|
| One walk of the home directory, harvesting one marker | 12.4 s |
| The same walk, harvesting all four markers plus `.zip` | 12.4 s |
| The four reclaim checks, four engine calls | 66.2 s |
| The four reclaim checks, one call, sharing the walk | **28.2 s** |
| Engine process start + finder import (a check that walks nothing) | 0.77 s |

Reading: the directory listing was the entire cost. Harvesting three extra file
names out of children already enumerated does not move the number at all, which
is why the walk collects the union of every marker any loaded finder registered
rather than one caller's. The remaining 28.2 s is one walk plus the sizing and
classification the four checks do on what it found.

Findings were compared on both sides, per check, and are identical -- state,
counts, byte totals and finding ids. That comparison is
`test/shared-walk-verify.ps1`, not a note in a commit message.

### The two git walks, and what sharing them exposed (lxl)

| Measurement | Value |
|---|---|
| `gitignored-unique` and `repo-health`, two walks, back to back | 60.0 s |
| The same two, one shared walk | **6.6 s** |
| Of which the second check | 1 ms (served from the memo) |
| Directories listed, before | 31,921 |
| Directories listed, after | 8,645 |

Reading, and it is not the reading that was expected. Sharing the walk was
supposed to remove one of the two walks, so about half. It removed nine tenths,
because the old walk was not doing the work twice -- it was doing it about
four times.

`My Documents`, `Local Settings` and `Application Data` are junctions in every
Windows home directory. The two git walkers used `Get-ChildItem -Directory`
with no reparse-point test, so they descended through all three and found the
same repositories again under each alias:

| | paths reported | real directories |
|---|---|---|
| before | 27 | 14 |
| after | **14** | 14 |

Thirteen of the 27 were a second name for one already in the list. Five
projects under `Documents\GitHub` appeared twice; several under
`AppData\Local\Temp` appeared four times. The depth-6 limit was the only thing
keeping that finite.

Nothing real was lost, and that is the claim the change rests on, so it is
measured rather than argued: every one of the 13 dropped paths is opened with
`GetFinalPathNameByHandle` and resolved to a directory still in the list. The
run also asserts it found repositories at all, because two empty sets match
each other and prove nothing.

Reproduce with `powershell -NoProfile -ExecutionPolicy Bypass -File
test\sandbox\git-walk-equivalence-probe.ps1`. It walks the real home directory
twice each way and takes about two minutes.

### The whole panel, all three schedulings, in one run

Thirteen checks, three at a time, only the queue differing. One run so the
three can honestly be subtracted -- the absolute numbers move by 10-20% between
runs on this machine depending on what else has touched the disk, which is why
a figure from yesterday minus a figure from today is not a result.

| Scheduling | Engine calls | Wall clock | Summed engine time |
|---|---|---|---|
| 0.9.1: one call per check, registry order | 13 | 107.2 s | 267.4 s |
| 0.9.2: shared walk, registry order | 10 | 92.3 s | 222.0 s |
| 0.9.2: shared walk, largest unit first | 10 | **81.5 s** | 220.5 s |

Two separate effects, and they are worth keeping apart. The shared walk removes
real work: summed engine time falls 267.4 s to 222.0 s, and that saving exists
no matter how the calls are ordered. The scheduling removes none -- 222.0 s and
220.5 s are the same number -- and buys 10.8 s anyway, purely by not starting
the second-largest unit last.

The floor is unchanged and is now the whole story: `duplicate-content` is the
slowest unit in all three runs at 54-60 s. No amount of concurrency goes below
one check, and that check hashes file contents.

### The whole panel again, with two walk groups instead of one

Re-run after `lxl` added the second group. Same probe, same three schedulings,
one run -- and a DIFFERENT run from the table above, so read down this table,
never across the two. This machine was about 14% slower on this pass (the same
0.9.1 configuration measures 122.1 s here against 107.2 s there), which is
exactly why each table is taken in a single run.

| Scheduling | Engine calls | Wall clock | Summed engine time |
|---|---|---|---|
| one call per check, registry order | 13 | 122.1 s | 320.6 s |
| shared walks, registry order | 9 | 82.2 s | 218.7 s |
| shared walks, largest unit first | 9 | **81.8 s** | 210.4 s |

**The scheduling change no longer buys anything measurable.** In the previous
table, with ten units, largest-unit-first was worth 10.8 s. With nine units it
is worth 0.4 s, which on this machine is noise. That is not a regression and
the ordering stays -- it costs nothing and it is still the right shape when a
group is genuinely the biggest job -- but the 10.8 s figure should not be
quoted as if it still holds. It was a property of one particular unit count,
which is what unit size being a proxy for duration means in practice
(`vanish-uninstaller-4v8`).

The floor also moved, and not because anything got slower: the slowest single
unit is now `local-only-credentials` at 60.4 s rather than `duplicate-content`
at 58-60 s. Those two are close enough that which one is "the floor" changes
between runs, so the honest statement is that the scan is bounded by a pair of
checks around a minute each, not by one named check.

### What the scheduling did NOT do

From the FIRST of the two runs above, when there was one walk group and ten
units. Kept because the shape of the problem outlasted the numbers, and it is
what vanish-uninstaller-4v8 was filed on.

It moved the tail; it did not remove it. Driving the real panel afterwards,
the group now finishes at 50.6 s -- and `reclaim-package-caches`, a single
check taking 45.5 s, is last in the queue and finishes at 100.7 s, which is
when the scan ends.

```
  58504 ms  duplicate-content        finished at  78.1 s
  50301 ms  the four reclaim checks  finished at  50.6 s
  45478 ms  reclaim-package-caches   finished at 100.7 s   <- the scan ends here
  31515 ms  local-only-credentials   finished at  31.8 s
```

Unit size is a proxy for duration and this is where it is a weak one: the
largest UNIT is not the longest JOB. Sorting by size puts a four-check group
ahead of a one-check group that happens to take 45 seconds, and that one-check
group then becomes what everything waits on.

It is still the right trade on the evidence -- the same-run comparison above is
92.3 s against 81.5 s -- but the honest statement is "the tail is smaller", not
"there is no tail". Getting further needs scheduling by MEASURED duration,
which means remembering how long each check took last time -- bd
vanish-uninstaller-4v8, filed with these numbers attached rather than guessed
at here.

Two app-level runs bracket the same work at 94.3 s and 100.7 s. They are
different runs minutes apart, with the rest of the application loading
alongside, and they are recorded here as a range rather than subtracted from
each other -- which is the error this file exists to avoid.

### Reproducing these

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\shared-walk-verify.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\git-walk-equivalence-probe.ps1
node test\sandbox\hygiene-scheduling-probe.js
npx electron test\sandbox\hygiene-wallclock-probe.js
```

The first is a correctness suite and runs in seconds. The other two walk the
real disk and take minutes each -- the scheduling probe produces the three-way
table above, and the wall-clock probe drives the real panel for the number a
person actually waits through. Neither is in `run-all.ps1`: a timing assertion
on a machine whose disk speed nobody controls is a flaky test wearing a
performance badge.
