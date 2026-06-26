# Vanish: LLM Handoff Specification
> [!NOTE]
> This handoff document is formatted for LLM ingestion to resume project development seamlessly when token limits are reached or context is rotated.

---

## 📌 Project Overview
Vanish is a modern Windows application manager and deep cleaner uninstaller. It is built as an Electron desktop app executing an asynchronous PowerShell backend. It replaces outdated uninstaller utilities with a high-performance, glassmorphic UI, UWP support, automatic restore point checkpoints, and three remnant scanning modes (Safe, Moderate, Advanced).

* **Repository Location**: `d:\quickhelp projects\vanish-uninstaller`
* **Status**: **v1.0.0 (Core MVP Completed & Verified)**

---

## 📁 File Structure Map

* **[package.json](file:///d:/quickhelp%20projects/vanish-uninstaller/package.json)**: Scripts, configuration, and Electron (`^42.5.0`) dependency.
* **[main.js](file:///d:/quickhelp%20projects/vanish-uninstaller/main.js)**: Host window container. Regulates window actions (minimize, maximize, close), elevation queries (`net session`), and manages asynchronous PowerShell spawns.
* **[preload.js](file:///d:/quickhelp%20projects/vanish-uninstaller/preload.js)**: Exposes secure IPC APIs to the renderer world.
* **[index.html](file:///d:/quickhelp%20projects/vanish-uninstaller/index.html)**: Titlebar, dashboard statistics, application table workspace, details sidebar, and multi-stage uninstallation wizard overlay.
* **[index.css](file:///d:/quickhelp%20projects/vanish-uninstaller/index.css)**: Glassmorphic dark styling. Core variables, scrollbars, glowing orbit background animation, toggle switches, and threat-level color classes.
* **[renderer.js](file:///d:/quickhelp%20projects/vanish-uninstaller/renderer.js)**: Handles UI controller logic. Orchestrates app loading, sorting, detail sidebar rendering, and the step-by-step uninstallation wizard state machine.
* **[scanner.ps1](file:///d:/quickhelp%20projects/vanish-uninstaller/scanner.ps1)**: System execution engine. Decodes Base64 JSON arguments. Runs registry querying, UWP package mapping, system restore point checkpoints, remnant scans, and file/registry removals.

---

## 🚀 How to Run the App (Elevated)

Vanish must be run with administrative privileges to interact with HKLM registry paths and delete protected system files.
1. Open PowerShell or Command Prompt as **Administrator**.
2. Run:
   ```powershell
   cd "d:\quickhelp projects\vanish-uninstaller"
   npm start
   ```

---

## 🔍 Next Steps & Roadmap Checklist
For the next agent resuming work, the primary milestones outlined in the roadmap are:
- `[ ]` **Implement Audit & Health Advisor Tab**: Create an interactive scorecard highlighting unused software, total space reclaimable, and boot-up impact statistics.
- `[ ]` **Build Advanced Task Manager**: Create a process list viewer inside Vanish showing resource usages (CPU, Memory, Disk).
- `[ ]` **Add "Unlocker" Capability**: Write a PowerShell helper in `scanner.ps1` utilizing handle queries to identify processes locking a specific file/folder, and kill handles/processes to release locks.
- `[ ]` **Integrate Search & Destroy**: Enable direct keyword input to purge remnants of unlisted or corrupt software installations.
- `[ ]` **Embed Threat Intelligence Hunting**: Add signature lookups, process behavior tracking, and alert indicators to identify destructive applications.
