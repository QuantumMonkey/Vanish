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
