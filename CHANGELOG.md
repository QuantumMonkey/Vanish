# Changelog

All notable changes to the **Vanish** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-06-26

### Added
* **Technical Stack Foundation**: Configured Electron and Node.js wrapper executing administrative PowerShell bindings.
* **PowerShell Execution Engine (`scanner.ps1`)**:
  * Unified JSON interface with Base64 payload encoding to avoid command-line argument escaping issues.
  * Desktop app mapping across HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER, and Wow6432Node Uninstall hives.
  * UWP Store app mapping with friendly name xml parsing and installation folder size estimators.
  * Automated System Restore Point checkpointing via WMI/VSS.
  * Three scanning modes (Safe, Moderate, Advanced) for locating leftovers.
  * Recursive filesystem and registry purging.
* **Electron Main Process (`main.js` & `preload.js`)**: Frameless browser settings, net session admin checking, native exec calls, and secure IPC bridges.
* **Modern UI Layout (`index.html`)**: Glassmorphic dashboards, side tabs, search filters, app detail sidebars, and step-by-step uninstallation wizard overlay.
* **Visual Styling System (`index.css`)**: Orbit radial animated glowing background, HSL variables, custom dark theme scrollbars, and color-coded threat/risk badges.
* **State Controller (`renderer.js`)**: Mapped concurrent app loading, sort sorting (by Name, Date, Size), search filtering, and state controls for the uninstall modal.
* **Documentation**: Created architecture specifications, LLM handoff templates, development checklists, and roadmaps.
