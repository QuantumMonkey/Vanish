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
