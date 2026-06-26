# Changelog

All notable changes to **Vanish** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
The versioning scheme is `RELEASE.MAJOR.MINOR` — see `docs/RELEASING.md` for the
full decision rules.

---

## [Unreleased]

Nothing pending since `0.2.1`.

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
