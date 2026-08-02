# Vanish: LLM Handoff Specification
> [!NOTE]
> This handoff document is formatted for LLM ingestion to resume project development seamlessly when token limits are reached or context is rotated.

---

## 📌 Project Overview
Vanish is a modern Windows application manager and deep cleaner uninstaller. It is built as an Electron desktop app executing an asynchronous PowerShell backend. It replaces outdated uninstaller utilities with a high-performance, glassmorphic UI, UWP support, automatic restore point checkpoints, and three remnant scanning modes (Safe, Moderate, Advanced).

* **Repository Location**: `https://github.com/QuantumMonkey/Vanish`
* **Status**: **v1.0.0 (Core MVP Completed & Verified)**

---

## 📁 File Structure Map

* **[package.json](../package.json)**: Scripts, configuration, and Electron (`^42.5.0`) dependency. *(Status: Complete)*
* **[main.js](../main.js)**: Host window container. Regulates window actions (minimize, maximize, close), elevation queries (WindowsPrincipal API — see `docs/promptgate.md` Rule 13), and manages asynchronous PowerShell spawns. Stage 2 IPC handlers (`get-system-diagnostics`, `get-startup-items`, `get-software-redundancy`) added. *(Status: Complete — Stage 2 functional)*
* **[preload.js](../preload.js)**: Exposes secure IPC APIs to the renderer world. Stage 2 APIs (`getSystemDiagnostics`, `getStartupItems`, `getSoftwareRedundancy`) included. *(Status: Complete — Stage 2 functional)*
* **[index.html](../index.html)**: Titlebar, dashboard statistics, application table workspace, details sidebar, multi-stage uninstallation wizard overlay, and Health Advisor audit panel (Stage 2). *(Status: Complete — Stage 2 functional)*
* **[index.css](../index.css)**: Glassmorphic dark styling. Core variables, scrollbars, glowing orbit background, toggle switches, threat-level color classes, and Stage 2 audit panel styles (info cards, disk bars, startup badges, redundancy boxes). *(Status: Complete — Stage 2 functional)*
* **[renderer.js](../renderer.js)**: UI controller. App loading, sorting, detail sidebar, uninstallation wizard state machine, Health Advisor audit tab (Stage 2: `loadAuditData`, `renderSysInfoCards`, `renderDiskBars`, `renderStartupTable`, `renderRedundancyGroups`). *(Status: Complete — Stage 2 functional)*
* **[scanner.ps1](../scanner.ps1)**: System execution engine. Base64 JSON argument decoding, registry/UWP querying, restore points, remnant scanning, file/registry removals. Stage 2: `Check-AdminStatus` (WindowsPrincipal), `Get-SystemDiagnostics` (CIM), `Get-StartupItems` (Run keys + Task Scheduler + Services), `Get-SoftwareRedundancy` (14-category clustering). *(Status: Complete — Stage 2 functional)*

---

## 🚀 How to Run the App (Elevated)

Vanish must be run with administrative privileges to interact with HKLM registry paths and delete protected system files.
1. Open PowerShell or Command Prompt as **Administrator**.
2. Run:
   ```powershell
   cd path\to\vanish
   npm start
   ```

---

## 🎯 Priority before continuing the Stage checklist (added 2026-08-03)

**The project is currently out of compliance with its own binding rules** (`docs/promptgate.md` Rules 2 and 3), confirmed against `ARCHITECTURE.md` section 5 ("Implemented vs. designed"):

- **Rule 2 (quarantine-first, never direct deletion) is violated today.** `Purge-Remnants` in `scanner.ps1` deletes directly after the review gate — there is no versioned quarantine vault yet. `docs/architecture.md`'s "Quarantine-First Deletion Policy" section states the POLICY (move to vault, log a restore manifest, user-controlled auto-purge) but does not spec the concrete implementation (directory layout, manifest file format, restore/purge mechanics) — that design work is still open, not just the coding.
- **Rule 3 (Audit Mode read-only fallback) is not enforced.** The titlebar shows an elevation badge but there is no enforced read-only tier if UAC is declined.

**Fix both BEFORE resuming the Stage 3/6/9 checklist below**, even though neither is its own numbered roadmap stage — every stage from here forward (3, 6, 9, and anything in Standard/Extended tier) adds more destructive operations, and each one inherits whatever the quarantine/audit-mode foundation looks like. Building more on top of a direct-delete core just means more code to retrofit later. Concretely:

1. Design the quarantine vault: versioned directory layout, a restore manifest format (what's needed to reverse a purge), auto-purge policy (user-controlled, off by default per Rule 2). Nothing in the existing docs specs this concretely — this is real design work, not just implementation.
2. Wire `Purge-Remnants` (and every future destructive operation in Stage 3/6/9+) through it — quarantine-then-delete, never direct delete, per Rule 2, no exceptions.
3. Enforce Audit Mode as a real read-only tier when unelevated, with the persistent banner Rule 3 specifies, not just a badge.
4. Only then resume the Stage 3/6/9 checklist below.

Since the last handoff, `docs/roadmap.md` also picked up (2026-08-03): a Driver Store sweeper spec and a 4-tier cleanup risk model added to Stages 11/14, a Forced Uninstall spec added to Stage 6, and a Startup Item Manager that was proposed then reverted same-day (Windows' own Task Manager already covers it — don't re-add it).

## 🔍 Next Steps & Roadmap Checklist

> **Before planning, speccing, or implementing any feature**, run it through `docs/promptgate.md`. All decisions must pass the gate before work begins.

> **For Stages 6–14** (Orchestration, Network, Sandbox, Environment Clean, Enterprise Audits, Cache Purge, Telemetry, Runtime/Driver Audit, CleanerML Engine), refer to `docs/roadmap.md`. The checklist below covers Core tier stages only.

**Core Tier** (complete before any public release):

- `[x]` **Stage 2 — Audit & Health Advisor Tab**: Health Advisor nav tab with system diagnostics (CIM), startup item enumeration (Registry Run hives, Task Scheduler, Services), and redundant software detection (14-category clustering). *(Core — Complete)*
- `[ ]` **Quarantine vault + Audit Mode enforcement** — see priority section above. Not its own numbered stage, but blocks trustworthy completion of everything below it. *(Do this first)*
- `[ ]` **Stage 3 — Task Manager & Unlocker**: Process list with CPU/Memory/Disk, file handle inspector, Suspicious Activity Indicators display, Watchdog Suspension. *(Core)*
- `[ ]` **Stage 6 — Orchestration & Shell Cleanup**: Bulk silent uninstaller, context menu cleaner, MSI service lockout manager, restore point frequency override, Forced Uninstall for broken entries (added 2026-08-03). *(Core)*
- `[ ]` **Stage 9 — System Integration & Environment Clean**: Services/drivers purge, PATH cleaner, file association repair, multi-user profile registry sweep, auto-UAC relauncher, registry redirection bypass. *(Core — note: multi-user profile sweep only matters if this machine has other user accounts; deprioritize that specific sub-task for a single-user personal install.)*

Remember Rule 10: a stage is only "Complete" once manually verified on a clean Windows 10 and Windows 11 VM. Coded and passing locally is "In Progress" — update this checklist and `CHANGELOG.md` accordingly, don't mark anything done from code review alone.

**Standard and Extended tiers**: See `docs/roadmap.md`.
