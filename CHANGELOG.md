# Changelog

All notable changes to the **Vanish** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
* **Stage 2 — Audit & Health Advisor** (`scanner.ps1`, `main.js`, `preload.js`, `index.html`, `index.css`, `renderer.js`):
  * `Get-SystemDiagnostics`: CIM-based OS, CPU, RAM, GPU, disk volume, and machine metadata queries.
  * `Get-StartupItems`: Enumerates Registry Run hives (HKLM 64/32-bit, HKCU, RunOnce variants), logon-triggered Scheduled Tasks, and third-party auto-start services with orphan detection.
  * `Get-SoftwareRedundancy`: 14-category keyword clustering to detect duplicate software installs (browsers, PDF readers, AV tools, etc.).
  * Health Advisor nav tab with animated disk usage bars, startup item table (source badges, orphan flags), and redundancy alert groups.
  * All three CIM queries run in parallel via `Promise.all` for minimal tab load latency.

### Fixed
* **Promptgate Rule 13 violation**: `check-admin` IPC handler in `main.js` replaced `net session` exec call with `WindowsPrincipal` API via dedicated `Check-AdminStatus` PowerShell function.

### Changed
* Moved `research.md`, `BENCHMARKS.md`, and `RELEASING.md` from repository root into `docs/` to consolidate all documentation.
* Updated `README.md` documentation index, `docs/handoff.md` file map, and all internal cross-references to reflect new paths.
* `docs/handoff.md` Stage 2 status marked complete with expanded function-level descriptions.

---

## [1.0.0] - 2026-06-26

### Added
* **Technical Stack Foundation**: Configured Electron and Node.js wrapper executing administrative PowerShell bindings.
* **PowerShell Execution Engine (`scanner.ps1`)**:
  * Unified JSON interface with Base64 payload encoding to avoid command-line argument escaping issues.
  * Desktop app mapping across HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER, and Wow6432Node Uninstall hives.
  * UWP Store app mapping with friendly name XML parsing and installation folder size estimators.
  * Automated System Restore Point checkpointing via WMI/VSS.
  * Three scanning modes (Safe, Moderate, Advanced) for locating leftovers.
  * Recursive filesystem and registry purging.
* **Electron Main Process (`main.js` & `preload.js`)**: Frameless window configuration (`frame: false`), admin elevation checking via WindowsPrincipal API, native PowerShell exec calls, and secure IPC bridges.
* **Modern UI Layout (`index.html`)**: Glassmorphic dashboards, side tabs, search filters, app detail sidebars, and step-by-step uninstallation wizard overlay.
* **Visual Styling System (`index.css`)**: Orbit radial animated glowing background, HSL variables, custom dark theme scrollbars, and color-coded threat/risk badges.
* **State Controller (`renderer.js`)**: Mapped concurrent app loading, sort controls (by Name, Date, Size), search filtering, and state controls for the uninstall modal.
* **Documentation**: Created architecture specifications, LLM handoff templates, development checklists, and roadmaps.
