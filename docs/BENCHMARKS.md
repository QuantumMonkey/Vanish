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

## Run 002 - 2026-08-29 - developer machine, Machine Hygiene panel (lhf, 3l8)

| Condition | Value |
|---|---|
| CPU | AMD Ryzen 9 5900HX (8 cores / 16 threads) |
| RAM | 15 GB |
| Storage | NVMe SSD |
| Home directory | `C:\Users\Anand`, walk capped at 15,000 directories |
| Markers found in one walk | 232 `package.json`, 508 `pubspec.yaml`, 1 `gradlew`, 44 `.zip` |
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

### What the scheduling did NOT do

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
node test\sandbox\hygiene-scheduling-probe.js
npx electron test\sandbox\hygiene-wallclock-probe.js
```

The first is a correctness suite and runs in seconds. The other two walk the
real disk and take minutes each -- the scheduling probe produces the three-way
table above, and the wall-clock probe drives the real panel for the number a
person actually waits through. Neither is in `run-all.ps1`: a timing assertion
on a machine whose disk speed nobody controls is a flaky test wearing a
performance badge.
