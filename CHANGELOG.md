# Changelog

All notable changes to **Vanish** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
The versioning scheme is `RELEASE.MAJOR.MINOR` — see `docs/RELEASING.md` for the
full decision rules.

---

## [Unreleased]

> Rule 10 note: everything below is **In Progress**, not Complete. It is coded
> and passes a 240-assertion local suite on Windows 11 build 26200, but no clean
> Windows 10 / Windows 11 VM pass has happened yet (TASK-17). No stage flips to
> "Complete" until it does.

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

### Security
* A strict Content-Security-Policy is now set: `connect-src 'none'` makes fetch,
  XHR and WebSockets impossible from the renderer, so no scan result or path can
  leave the machine.

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
