# Deviations Log

> Format: date | TASK-nn | doc amended | why

## Re-plan checkpoints

2026-08-03 | Phase 1 | Four deviations logged against TASK-01 tripped the
">3 deviations in a phase" trigger in 05-implementation-plan.md. Re-plan
performed: all four are storage-layout and file-placement decisions local to
TASK-01, made before its code shipped, and none changes an interface that
TASK-02..05 depend on (the vault is still `quarantine -> manifest row ->
restore/delete`, still one entry per purge, still main.js-as-single-writer).
TASK-02..16 stand as written. No re-scoping needed; continuing.

2026-08-03 | TASK-01 | 04-schema.md ENT-01 + new D-12 | Mirrored vault directory layout replaced with indexed slots. Mirroring the original absolute path under the vault root blows past PowerShell 5.1's 260-char MAX_PATH on exactly the deep-nested leftovers Vanish targets. Original path is kept in the manifest row, so restore is unaffected.

2026-08-03 | TASK-01 | 04-schema.md new ENT-01b + D-13 | Added an engine-written `entry.json` per vault entry. The payload move (PowerShell) and the manifest write (Node) cannot be one transaction; without a self-describing entry folder, a crash between them orphans the payload. Rule 7 (one writer per file) is preserved.

2026-08-03 | TASK-01 | 05-implementation-plan.md TASK-01 steps | `vault-list` implemented as a main.js IPC handler reading manifest.json directly, not as a scanner.ps1 action. main.js already owns that file; routing a read of its own document through a PowerShell spawn adds ~300ms and a second reader for zero benefit (Codex III.5, smallest correct surface).

2026-08-03 | TASK-01 | 05-implementation-plan.md context manifests (file layout) | Main-process logic split into `lib/store.js` (on-disk documents) and `lib/vault.js` (quarantine pipeline) rather than growing main.js to ~1500 lines across phases 1-4. main.js stays the IPC surface and the single writer; the modules are the same process. No behavioural change.

2026-08-03 | TASK-15 | 00-prd.md REQ-14 (driver store half) | Driver store packages are SCANNED AND DISPLAYED in Core but not removable (findings carry removable=false). REQ-14 asks for manifest-backed removal, but `docs/roadmap.md` assigns the Driver Store sweeper to Stage 11, which Rule 16 places in Standard tier - and Standard work may not begin before Core is VM-tested. Removing a driver package is also not cleanly reversible through the file/registry vault: `pnputil /delete-driver` destroys the FileRepository copy, so a restore manifest would be a promise the vault cannot keep. The services half of REQ-14 is fully implemented and manifest-backed. Follow-up ticket filed.

2026-08-03 | TASK-14/15 | 04-schema.md ENT-01 registry row | Registry rows gained a `mode` field (`remove` default, `manifest-only`). REQ-15 removes a registry VALUE (Path) rather than a key; the vault's export-then-delete would have deleted the entire Environment key and taken every other user variable with it. `manifest-only` exports the .reg restore manifest and leaves the key in place, after which the caller rewrites just the value. Restore is unchanged - the .reg import puts the exact prior string back. Additive field, so schema rule 1 holds.

2026-08-03 | TASK-08 | 05-implementation-plan.md TASK-08 steps | Persistence cross-reference in the process list uses Registry Run keys only, not the full `Get-StartupItems` data. `Get-ScheduledTask` enumeration takes seconds and cannot sit inside a refresh loop whose whole budget is 2s (NFR-03). Run-key lookup is ~5 registry reads. The Health Advisor tab still shows the complete startup picture including Task Scheduler and services, so no information is lost from the product - only from the per-process chip.

2026-07-11 | TASK-10 | promptgate.md Rule 15, 00-prd.md REQ-10/OPEN-02, 04-schema.md ENT-03, 05-implementation-plan.md TASK-10 | OPEN-02 research proved winget cannot be a runtime lookup source (default source is a network REST API, blocked by Rule 6; also no offline manifest cache and no UninstallerSwitches output). Lookup chain reduced from 3 steps to 2: corrections.json (primary) -> heuristic fallback. Pre-implementation amendment (research gate, not a mid-code drift).
