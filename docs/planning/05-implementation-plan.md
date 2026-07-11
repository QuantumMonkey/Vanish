# Implementation Plan

> Owner doc for TASK-nn ids. Each TASK becomes one bd issue at acceptance.
> Implementation sessions read ONLY the task's context manifest.
> Deviation protocol at the bottom is binding. Promptgate rules cited per
> task are re-checked by the implementing session before coding.

## Phases

| Phase | Demo statement | Tasks |
|---|---|---|
| 1 Safety retrofits | "A purge lands in the quarantine vault and can be restored; an unelevated launch runs Audit Mode with the banner." | TASK-01..05 |
| 2 Task Manager | "The Task Manager tab shows live processes with passive indicators, and a locked file can be identified and freed." | TASK-06..09 |
| 3 Orchestration | "Five queued apps uninstall silently back-to-back, each with its own restore point." | TASK-10..12 |
| 4 System Clean | "Each cleaner finds planted orphans, purges them through the vault, and restore brings them back." | TASK-13..16 |

Each phase ends with /verify + completion-gate checklist + /code-review
medium, THEN the cross-model gate: write
`docs/planning/reviews/phase-N-gemini-review.md` from the gemini-review
template; the user runs it in Antigravity; the verdict block lands in the
phase's bd issue. FAIL blocks the next phase. Phase 1 additionally gets
/code-review high before merge (it touches deletion code paths).
Rule 10 note: phase "done" in bd = code + local verify; the CHANGELOG
"Complete" label waits for the Win10+Win11 VM pass, tracked as a separate
release-prep task outside this pack.

## Tasks

### TASK-01 Build the quarantine vault engine primitives [phase 1]
- **Implements:** REQ-01, REQ-02, ENT-01, ENT-05, NFR-01, NFR-04
- **Context manifest:**
  - Files: `scanner.ps1` (param block, `Purge-Remnants`), `main.js`
    (`runPowerShell`)
  - Doc sections: `04-schema.md` ENT-01/ENT-05 + evolution rules,
    `01-trd.md` D-05/D-06, promptgate Rule 2
  - Do NOT read: renderer.js, index.html/css (UI lands in TASK-03)
- **Steps:** add engine actions `quarantine-items` (move files to
  `vault/<id>/files`, reg.exe export keys to `vault/<id>/registry`, then
  remove keys), `vault-list`, `vault-restore`, `vault-delete`; write
  manifest + oplog atomically; per-item all-or-nothing semantics.
- **Verify:** PowerShell test script: plant temp files + HKCU test keys,
  quarantine, assert originals gone + vault contents + manifest rows;
  restore, assert files/keys back; delete-forever, assert folder gone.
- **Done when:** REQ-01 and REQ-02 acceptance criteria pass via script.
- **Est. size:** M

### TASK-02 Route existing purge through the vault [phase 1]
- **Implements:** REQ-01, FLOW-02, SCR-06
- **Context manifest:**
  - Files: `scanner.ps1` (`Purge-Remnants`), `main.js` (purge handler),
    `preload.js`, `renderer.js` (wizard purge + summary screens only)
  - Doc sections: `03-appflow.md` FLOW-02, `02-uiux.md` SCR-06
  - Do NOT read: Health Advisor and app-list code in renderer.js
- **Steps:** replace direct Remove-Item/registry deletes with TASK-01
  primitives; update summary screen language ("quarantined", vault link);
  keep locked-item skip behavior.
- **Verify:** run app, uninstall a disposable test app, purge; confirm
  vault entry exists and summary shows quarantine language; grep scanner
  purge path for `Remove-Item` on user files = none outside vault-delete.
- **Done when:** FLOW-02 branches behave as specified.
- **Est. size:** M

### TASK-03 Quarantine Manager tab [phase 1]
- **Implements:** REQ-03, SCR-02, FLOW-03, ENT-02
- **Context manifest:**
  - Files: `renderer.js` (tab scaffolding, `setupSidebarNavigation`),
    `index.html`, `index.css`, `preload.js`, `main.js` (new IPC)
  - Doc sections: `02-uiux.md` SCR-02, `03-appflow.md` FLOW-03,
    `04-schema.md` ENT-01/ENT-02
  - Do NOT read: scanner.ps1 internals beyond the TASK-01 action names
- **Steps:** new tab UI per SCR-02 states; IPC for vault-list/restore/
  delete; settings read/write (auto-purge toggle default off); double-
  confirm on Delete Forever; auto-purge sweep at startup when enabled.
- **Verify:** manual: quarantine via wizard, restore from tab, confirm
  files return; toggle auto-purge with retention 0 and restart, entry
  purged and oplog line written.
- **Done when:** REQ-03 acceptance criterion passes.
- **Est. size:** M

### TASK-04 Elevation tiers enforced end-to-end [phase 1]
- **Implements:** REQ-04, NFR-02, SCR-01 (banner)
- **Context manifest:**
  - Files: `main.js` (IPC handlers), `preload.js`, `renderer.js`
    (titlebar/elevation code, `checkElevation`), `index.html`, `index.css`
  - Doc sections: `02-uiux.md` SCR-01, promptgate Rule 3 (banner text
    verbatim), `01-trd.md` NFR-02
  - Do NOT read: scanner.ps1 scan functions
- **Steps:** main.js caches elevation at start; destructive IPC channels
  (purge, vault-restore/delete, kill, unlock, queue-start, cleaner-purge)
  reject when unelevated; renderer renders banner + disabled states from
  one tier flag.
- **Verify:** run unelevated: banner shown, purge IPC invoked from
  devtools console rejects; run elevated: no banner, purge works.
- **Done when:** REQ-04 acceptance criterion passes both ways.
- **Est. size:** S

### TASK-05 Startup elevation offer and relaunch [phase 1]
- **Implements:** REQ-05, FLOW-01, D-09
- **Context manifest:**
  - Files: `main.js` (app startup path), `renderer.js` (dialog only)
  - Doc sections: `03-appflow.md` FLOW-01, roadmap Stage 9 auto-UAC item
  - Do NOT read: wizard or vault code
- **Steps:** on unelevated start, one-time dialog; accept -> spawn
  elevated instance (PowerShell Start-Process -Verb RunAs on the app),
  exit current on child success; decline/UAC-cancel -> Audit Mode, no
  crash; single-instance lock so old instance yields to elevated one.
- **Verify:** manual on a standard (non-admin-token) launch: accept path
  relaunches elevated; decline path lands in Audit Mode; cancel UAC
  prompt = decline path.
- **Done when:** REQ-05 acceptance criterion passes.
- **Est. size:** S

### TASK-06 Process monitor engine + tab [phase 2]
- **Implements:** REQ-06, SCR-03 (table), NFR-03, ENT-02
- **Context manifest:**
  - Files: `scanner.ps1` (add `list-processes` action), `main.js`,
    `preload.js`, `renderer.js` (new tab), `index.html`, `index.css`
  - Doc sections: `02-uiux.md` SCR-03, `01-trd.md` NFR-03
  - Do NOT read: vault/queue code
- **Steps:** engine action returning process list (name, PID, CPU%, WS,
  IO) via Get-Process + CIM deltas; renderer table with sort + detail
  pane; kill button (Full Mode, confirm); refresh interval from settings.
- **Verify:** compare against Task Manager for 3 known processes; kill a
  notepad instance; unelevated run hides kill.
- **Done when:** REQ-06 acceptance criterion passes.
- **Est. size:** M

### TASK-07 Unlocker via Restart Manager [phase 2]
- **Implements:** REQ-07, FLOW-04, TEC-04
- **Context manifest:**
  - Files: `scanner.ps1` (new `list-lockers` / `unlock` actions with
    Add-Type C# for rstrtmgr.dll), `main.js`, `preload.js`, `renderer.js`
    (unlock dialog)
  - Doc sections: `03-appflow.md` FLOW-04, roadmap Stage 3 API sequence,
    `01-trd.md` OPEN-03 note
  - Do NOT read: process-monitor table internals beyond the dialog hook
- **Steps:** RmStartSession/RmRegisterResources/RmGetList/RmShutdown
  sequence; graceful first, explicit per-process force second;
  wire "Unlock" shortcut from FLOW-02 locked items.
- **Verify:** scripted: open a file handle from a spawned PowerShell,
  run unlock, assert holder listed and file free after; measure first-call
  Add-Type latency (OPEN-03), record in bd issue.
- **Done when:** REQ-07 acceptance criterion passes.
- **Est. size:** M

### TASK-08 Suspicious activity indicators (passive) [phase 2]
- **Implements:** REQ-09, SCR-03 (chips), promptgate Rule 7
- **Context manifest:**
  - Files: `scanner.ps1` (extend `list-processes` with parent chain +
    command line + persistence cross-ref), `renderer.js` (chips + detail)
  - Doc sections: promptgate Rule 7 (exact label text), `02-uiux.md`
    SCR-03
  - Do NOT read: unlocker code
- **Steps:** flag rules: office/browser parent spawning shell; command
  lines matching destructive patterns (vssadmin delete shadows, wevtutil
  cl, hosts-file writes); persistence display from existing
  Get-StartupItems data. Display-only, exact Rule 7 label.
- **Verify:** spawn cmd.exe from a Word-named dummy parent -> chip shown;
  grep renderer for any action wired to indicators = none.
- **Done when:** REQ-09 acceptance criterion passes.
- **Est. size:** S

### TASK-09 Watchdog suspension [phase 2] (SHOULD -- build last in phase)
- **Implements:** REQ-08, FLOW-04 respawn branch
- **Context manifest:**
  - Files: `scanner.ps1` (suspend/resume primitives), unlock action
  - Doc sections: `00-prd.md` OPEN-01 resolution (from bd research
    findings; if unresolved, this task is BLOCKED, not improvised)
  - Do NOT read: UI files (reuses FLOW-04 dialog)
- **Steps:** per OPEN-01 research outcome; suspend holder tree, unlock,
  resume or terminate per user choice.
- **Verify:** self-restarting watchdog pair script cleaned without respawn.
- **Done when:** REQ-08 acceptance criterion passes.
- **Est. size:** M

### TASK-10 Switch lookup chain + corrections file [phase 3]
- **Implements:** REQ-10 (lookup), ENT-03, Rule 15
- **Context manifest:**
  - Files: `scanner.ps1` (new `resolve-uninstall-args` action), new
    `corrections.json`
  - Doc sections: `04-schema.md` ENT-03, promptgate Rule 15,
    `00-prd.md` OPEN-02 resolution from bd
  - Do NOT read: queue UI
- **Steps:** implement chain: local winget data (per OPEN-02 outcome) ->
  corrections.json -> heuristic sequence; return method used; seed
  corrections.json with entries for the test-VM app set.
- **Verify:** unit-style engine calls for one app per chain branch,
  asserting method field.
- **Done when:** chain returns correct args + method for all three
  branches.
- **Est. size:** M

### TASK-11 Bulk uninstall queue engine + panel [phase 3]
- **Implements:** REQ-10, REQ-12, ENT-04, FLOW-05, SCR-04, NFR-05
- **Context manifest:**
  - Files: `main.js` (queue runner), `scanner.ps1` (msiserver check
    action), `renderer.js` (queue panel), `preload.js`
  - Doc sections: `03-appflow.md` FLOW-05 + state machine,
    `04-schema.md` ENT-04, `02-uiux.md` SCR-04
  - Do NOT read: vault internals (queue calls existing purge flow later,
    not in this task)
- **Steps:** queue.json persistence per state change; sequential runner
  trapping exit codes (3010/1641 = reboot); msiserver validate/enable/
  restore; panel per SCR-04 states.
- **Verify:** queue 3 disposable apps on the dev machine; kill the app
  mid-queue and relaunch -> queue resumes from persisted state; M4
  scenario reserved for VM pass.
- **Done when:** FLOW-05 state machine transitions all reachable.
- **Est. size:** L -> split at claim time into engine (11a) and panel
  (11b) bd issues.

### TASK-12 Restore point frequency override [phase 3]
- **Implements:** REQ-13, FLOW-05 step 2
- **Context manifest:**
  - Files: `scanner.ps1` (`Create-RestorePoint`)
  - Doc sections: roadmap Stage 6 override item, research.md restore-point
    rate-limit notes
  - Do NOT read: UI files
- **Steps:** wrap checkpoint: read current SystemRestorePointCreationFrequency,
  set 0, checkpoint, restore prior value in finally.
- **Verify:** two consecutive checkpoint calls both create restore points
  (Get-ComputerRestorePoint count +2); registry value equals prior after.
- **Done when:** REQ-13 acceptance criterion passes.
- **Est. size:** S

### TASK-13 Explicit registry views utility [phase 4] (build first --
others depend on it)
- **Implements:** REQ-18, TEC-04
- **Context manifest:**
  - Files: `scanner.ps1` (shared helper: OpenBaseKey Registry64/Registry32)
  - Doc sections: roadmap Stage 9 redirection item
  - Do NOT read: UI files
- **Steps:** helper function taking view + hive + path; refactor Stage 6/9
  scan call sites to use it (existing Stage 1 scans untouched this pack).
- **Verify:** plant key only under the 32-bit view; helper finds it with
  view=Registry32 and not with Registry64.
- **Done when:** REQ-18 acceptance criterion passes.
- **Est. size:** S

### TASK-14 System Clean tab + cleaner framework [phase 4]
- **Implements:** SCR-05, FLOW-06, REQ-11 (first cleaner)
- **Context manifest:**
  - Files: `renderer.js` (tab + reusable review-list component per D-07),
    `index.html`, `index.css`, `scanner.ps1` (`scan-context-menus` action),
    `main.js`, `preload.js`
  - Doc sections: `02-uiux.md` SCR-05 + D-07, `03-appflow.md` FLOW-06
  - Do NOT read: queue code
- **Steps:** generic cleaner section component (scan -> review list ->
  purge via vault pipeline); first cleaner: orphaned context-menu handlers
  (missing target executables), quarantine on purge.
- **Verify:** plant an orphan ContextMenuHandlers key -> found, purge ->
  vault entry, restore -> key back.
- **Done when:** REQ-11 acceptance criterion passes.
- **Est. size:** M

### TASK-15 Services, drivers, PATH, associations cleaners [phase 4]
- **Implements:** REQ-14, REQ-15, REQ-16, FLOW-06
- **Context manifest:**
  - Files: `scanner.ps1` (three scan actions + purge integration),
    `renderer.js` (three sections on the TASK-14 component)
  - Doc sections: `00-prd.md` REQ-14..16, roadmap Stage 9 items,
    `04-schema.md` ENT-01 (registry + file mixing in one entry)
  - Do NOT read: context-menu cleaner internals (pattern already set)
- **Steps:** orphaned services (ImagePath missing) + driver store
  (pnputil enumerate, missing backing INF targets); PATH dead-dir scan
  (user + machine scope, prior value manifested); FileExts/protocol
  handlers pointing at missing exes.
- **Verify:** planted orphan per cleaner found + quarantined + restored;
  PATH restore returns exact prior string.
- **Done when:** REQ-14/15/16 acceptance criteria pass.
- **Est. size:** L -> split at claim time per cleaner (15a services/
  drivers, 15b PATH, 15c associations).

### TASK-16 Multi-user hive sweep + ownership elevator [phase 4]
(SHOULD pair -- last)
- **Implements:** REQ-17, REQ-19, NFR-07, FLOW-06 branches
- **Context manifest:**
  - Files: `scanner.ps1` (hive load/unload with finally, takeown/icacls
    step), `renderer.js` (other-profiles section + elevator prompt)
  - Doc sections: `01-trd.md` NFR-07, `00-prd.md` REQ-17/REQ-19
  - Do NOT read: Stage 6 code
- **Steps:** enumerate local profiles, reg load NTUSER.DAT copies of
  inactive users, scan, guaranteed unload; ACL elevator offered only on
  access-denied quarantine failures, per item, logged in manifest.
- **Verify:** second local test account with planted remnant: found and
  hive unloaded (reg query the mount point = gone) even when scan is
  interrupted; TrustedInstaller-owned file quarantined after elevator.
- **Done when:** REQ-17 and REQ-19 acceptance criteria pass.
- **Est. size:** M

## Dependency order

Critical path: TASK-01 -> 02 -> 03/04 -> 05 (phase 1) -> 06 -> 07 -> 08
(09 optional) -> 10 -> 11 -> 12 -> 13 -> 14 -> 15 (16 optional).
Parallelizable across sessions: 03 and 04; 06 and 10; 14 sections after
13. bd dep edges created with the issues.

## Deviation protocol (binding)

If reality contradicts the plan: STOP -> amend the owning doc (new D-nn)
-> append `date | TASK-nn | doc | why` to `docs/planning/DEVIATIONS.md`
-> continue. Never fix in code and reconcile later. More than 3 deviations
in a phase -> re-plan the remainder before continuing.

## Model & token routing

- This pack: plan-mode session (done). Implementation: Sonnet, one task
  per session, claim via `bd update --claim`, close with reason naming
  TASK-nn + verification result. Haiku for subagent grunt work only.
- Session start: `bd prime` + the task's context manifest. Nothing else.
- OPEN-01/OPEN-02 research: Antigravity, findings into the blocking
  task's bd issue.

## Plan Review (adversarial lenses)

- **CEO lens:** smallest thing proving value = phase 1 alone (quarantine +
  Audit Mode fixes the two live rule violations). Cut candidates: TASK-09
  and TASK-16 are already SHOULD and last-in-phase; if quota tightens they
  slip to post-Core without blocking release scope renegotiation. Nothing
  else cuttable: Rule 16 pins Stages 3/6/9 to Core.
- **Engineering lens:** riskiest assumption = Restart Manager via
  Add-Type in PS 5.1 under an Electron-spawned session (TASK-07); OPEN-03
  records the latency risk and TASK-07's verify measures it. Second risk:
  CPU% deltas over CIM are notoriously fiddly (TASK-06); NFR-03 is a
  design target, not a promise. Vaguest spot found and fixed: TASK-11 and
  TASK-15 were single L tasks -- both now split at claim time.
- **Design lens:** screens most at risk of looking generic: SCR-05 (five
  similar lists) -- mitigated by the evidence column and reused review-tree
  affordances; missing states audit done -- every SCR lists
  empty/loading/error/no-permission.
- **Data lens:** schema rule most likely violated first: rule 7 (single
  writer) when the queue runner and a wizard purge both append oplog --
  resolution: all writes serialize through main.js, engine returns data
  and main.js writes files. ENT rows re-checked: no speculative entity;
  ENT-03 ships seeded, not empty.

## Gate checklist

- [x] Every MUST REQ is covered by >=1 task; no task cites nothing
- [x] Every task has a runnable Verify and a context manifest
- [x] No task violates 04-schema.md evolution rules
- [x] All L tasks split (11, 15 split at claim); critical path identified
- [x] All four review lenses recorded findings
