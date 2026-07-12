# Traceability Matrix

> Orphan = artifact citing no upstream id (scope creep). Gap = id with no
> downstream artifact (missing work). Both must be empty at acceptance.

## REQ coverage

| REQ | NFR/TEC | SCR | FLOW | ENT | TASK | Status |
|---|---|---|---|---|---|---|
| REQ-01 | NFR-01, NFR-04 | SCR-06 | FLOW-02 | ENT-01, ENT-05 | 01, 02 | covered |
| REQ-02 | NFR-01 | SCR-06 | FLOW-02 | ENT-01 | 01 | covered |
| REQ-03 | -- | SCR-02 | FLOW-03 | ENT-01, ENT-02 | 03 | covered |
| REQ-04 | NFR-02 | SCR-01 | FLOW-01 | -- | 04 | covered |
| REQ-05 | -- | SCR-01 | FLOW-01 | -- | 05 | covered |
| REQ-06 | NFR-03 | SCR-03 | -- (in-tab) | ENT-02 | 06 | covered |
| REQ-07 | TEC-04 | SCR-03 | FLOW-04 | -- | 07 | covered |
| REQ-08 | -- | SCR-03 | FLOW-04 | -- | 09 | covered (SHOULD; OPEN-01 resolved) |
| REQ-09 | -- | SCR-03 | -- (display-only) | -- | 08 | covered |
| REQ-10 | NFR-05 | SCR-04 | FLOW-05 | ENT-03, ENT-04 | 10, 11 | covered (OPEN-02 resolved) |
| REQ-11 | -- | SCR-05 | FLOW-06 | ENT-01 | 14 | covered |
| REQ-12 | -- | SCR-04 | FLOW-05 | -- | 11 | covered |
| REQ-13 | -- | SCR-04 | FLOW-05 | -- | 12 | covered |
| REQ-14 | -- | SCR-05 | FLOW-06 | ENT-01 | 15 | covered |
| REQ-15 | -- | SCR-05 | FLOW-06 | ENT-01 | 15 | covered |
| REQ-16 | -- | SCR-05 | FLOW-06 | ENT-01 | 15 | covered |
| REQ-17 | NFR-07 | SCR-05 | FLOW-06 | -- | 16 | covered (SHOULD) |
| REQ-18 | TEC-04 | -- (engine-only) | FLOW-06 | -- | 13 | covered |
| REQ-19 | -- | SCR-05, SCR-06 | FLOW-02, FLOW-06 | ENT-01 | 16 | covered (SHOULD) |

Engine-only note: REQ-18 has no SCR by design (scanner correctness, no UI
surface); justified, not an orphan.

## MVP definition-of-done coverage (Phase 5 gate)

| DoD | Statement | TASK | bd id |
|---|---|---|---|
| DoD-1 | Every MUST REQ traces to a closed task (no orphans) | 17 | 0xt |
| DoD-2 | /verify passed on VM, not just locally | 17 | 0xt |
| DoD-3 | /code-review high on destructive surfaces; fixed/waived | 19 | 1td |
| DoD-4 | /cso once; criticals fixed, rest ticketed | 18 | vhm |
| DoD-5 | Docs current; stranger builds from README; demo GIF | 20 | k2o |
| DoD-6 | One real external user completes the core flow | 22 | 442 |
| (ship) | Signed build, Store submission (Rule 14) | 21 | 1w0 |

## Orphan check (must be empty at acceptance)

| Artifact | Cites nothing upstream | Resolution |
|---|---|---|
| (none) | | |

## Open questions still blocking

| OPEN | Owner | Blocks | Deadline phase |
|---|---|---|---|
| OPEN-01 | RESOLVED 2026-07-11 | (was TASK-09) | closed -- NtSuspendProcess, bd 2ax |
| OPEN-02 | RESOLVED 2026-07-11 | (was TASK-10) | closed -- winget dropped, Rule 15 amended, bd 1gi |
| OPEN-03 | phase-2 implementation (measure) | nothing | phase 2 |
