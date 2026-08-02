# Vanish

**An on-device Windows application auditor and manager that proposes — and never acts without your approval.**

Vanish maps every installed application (desktop + Microsoft Store), walks you through clean uninstalls with a native-uninstaller-first wizard, hunts down the leftovers that uninstallers leave behind, and audits system health — startup bloat, orphaned autostart entries, redundant software. Everything runs locally. Nothing leaves your machine.

<!-- DEMO GIF PLACEHOLDER
Record with ScreenToGif: 30–60s showing scan → app select → wizard →
leftover review tree → purge summary. Replace this block with:
![Vanish demo](docs/media/vanish-demo.gif)
-->
> 📸 *Demo GIF coming — see [docs/RELEASING.md](docs/RELEASING.md) for the release checklist.*

---

## Why this exists

Windows in 2025–26 accumulates weight quietly: telemetry-heavy background services, autostart entries that outlive the apps that created them, and uninstallers that routinely leave megabytes of files and dozens of registry keys behind. The existing tool landscape splits into two bad camps — "cleaners" that delete aggressively on vague heuristics, and manual registry surgery.

Vanish takes a third path: **audit first, propose second, act only on explicit approval.** It is built on the conviction that a tool touching your registry should show you exactly what it found, why it thinks it's a leftover, how risky removal is — and then wait.

## The loop

Every destructive workflow in Vanish follows the same pattern, implemented as a 7-screen wizard state machine in [renderer.js](renderer.js):

```
scan  →  detect  →  propose  →  await approval  →  act  →  report
```

1. **Scan** — enumerate apps from the registry Uninstall hives (64-bit, 32-bit, per-user) and UWP packages ([scanner.ps1](scanner.ps1) `Get-InstalledApps`, `Get-UwpApps`).
2. **Detect** — after the app's *own* uninstaller runs, sweep the filesystem and registry for remnants in one of three user-selected depths (`Scan-Leftovers`).
3. **Propose** — present every finding in a review tree with a per-item risk label (Safe / Moderate / Advanced). Advanced-risk items are **unchecked by default** ([renderer.js](renderer.js) `renderLeftoversTree`).
4. **Await approval** — nothing is deleted until you review the list and click Purge. Unchecking everything and finishing without purging is a first-class path.
5. **Act & report** — purge only the checked items; anything locked by Windows is reported as skipped, never forced (`Purge-Remnants`).

## What it does

| Capability | Where it lives |
|---|---|
| Desktop app inventory across HKLM / HKCU / Wow6432Node hives, with size + install date | [scanner.ps1](scanner.ps1) `Get-InstalledApps` |
| UWP / Store app inventory with `AppxManifest.xml` friendly-name parsing | [scanner.ps1](scanner.ps1) `Get-UwpApps` |
| System Restore Point before any uninstall (default-on, handles the Windows 24-hour rate limit) | [scanner.ps1](scanner.ps1) `Create-RestorePoint` |
| Native-uninstaller-first flow — Vanish launches the app's own uninstaller before touching anything | [main.js](main.js) `uninstall-native` |
| Three-depth leftover scanning with publisher-folder protection (shared publisher folders are never proposed for whole-folder deletion) | [scanner.ps1](scanner.ps1) `Scan-Leftovers` |
| Review-gated purge of selected files and registry keys | [scanner.ps1](scanner.ps1) `Purge-Remnants` |
| Health Advisor: CIM-based system diagnostics (OS, CPU, RAM, GPU, disks, uptime) | [scanner.ps1](scanner.ps1) `Get-SystemDiagnostics` |
| Startup audit: Run/RunOnce keys, logon-triggered Scheduled Tasks, auto-start services — with **orphan detection** (entries whose executable no longer exists) | [scanner.ps1](scanner.ps1) `Get-StartupItems` |
| Software redundancy detection: 14 category clusters (browsers, PDF readers, AV tools…) flagging duplicate installs | [scanner.ps1](scanner.ps1) `Get-SoftwareRedundancy` |
| Search, type filter, and sort (name/size/date) over the full app inventory | [renderer.js](renderer.js) `filterAndRenderApps` |

## Scan modes

| Mode | Filesystem | Registry | Default in review tree |
|---|---|---|---|
| **Safe** | `InstallLocation` + exact-name folders only | Exact `Publisher\App` and `App` key paths | Checked |
| **Moderate** | Partial-name matches in ProgramFiles / ProgramData / AppData; publisher folders only when no other installed app shares the publisher | Top-two-level key matches with the same publisher-sharing guard | Checked (publisher folders labeled Moderate) |
| **Advanced** | Wildcard + whitespace-stripped matching, adds `%TEMP%` | Same as Moderate | **Unchecked** — you opt in per item |

Discovery depth and deletion are independent: you can scan Advanced and still delete nothing.

## What Vanish does NOT do

- **No telemetry, no network calls.** There is no analytics code and no cloud lookup anywhere in the codebase — verify with a grep.
- **No autonomous deletion.** No scheduler, no background service, no "auto-clean." Every removal traces to a checkbox you ticked in that session.
- **Not an antivirus.** Vanish surfaces information; it makes no threat judgments.
- **No quarantine vault yet.** Purged items are deleted directly (`Remove-Item`) after your explicit review — the System Restore Point is the current rollback path. A quarantine-first deletion model is a documented design target ([docs/architecture.md](docs/architecture.md)), not yet implemented. Know this before purging.

## Safety model, honestly labeled

**Implemented today (v0.2.x):**
- Restore point before uninstall, on by default, admin-gated ([scanner.ps1](scanner.ps1) `Create-RestorePoint`)
- The app's own uninstaller always runs first ([main.js](main.js) `uninstall-native`)
- Per-item review with risk labels; Advanced findings opt-in only ([renderer.js](renderer.js))
- Shared publisher folders protected from whole-folder deletion ([scanner.ps1](scanner.ps1) `Is-PublisherShared`)
- Locked files reported and skipped, never forced ([scanner.ps1](scanner.ps1) `Purge-Remnants`)
- Elevation state detected via the `WindowsPrincipal` API and displayed in the titlebar ([renderer.js](renderer.js) `checkElevation`)

**Designed, not yet built** (see [docs/roadmap.md](docs/roadmap.md)): quarantine-first deletion vault, read-only Audit Mode banner, process unlocker, bulk orchestration. The [docs/](docs/) folder describes the target architecture; this README describes only what the code does now.

## Quickstart

Requirements: Windows 10 (1607+) or Windows 11 · PowerShell 5.1+ (bundled with Windows) · Node.js 20+

```powershell
# In an elevated PowerShell (admin rights are needed for restore points
# and HKLM cleanup; unelevated runs work read-only-ish but purges will fail):
git clone https://github.com/QuantumMonkey/Vanish
cd Vanish
npm install
npm start
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — **as-built** components, IPC surface, and the approval-loop sequence (start here)
- [docs/architecture.md](docs/architecture.md) — target architecture specification (design goals, includes unimplemented stages)
- [docs/roadmap.md](docs/roadmap.md) — staged feature roadmap · [docs/handoff.md](docs/handoff.md) — development state
- [docs/promptgate.md](docs/promptgate.md) — the development rulebook every change must pass
- [CHANGELOG.md](CHANGELOG.md) · [docs/RELEASING.md](docs/RELEASING.md) · [docs/BENCHMARKS.md](docs/BENCHMARKS.md)

## License

[MIT](LICENSE)

---

*This is the same pattern I use for GTM systems — an agent that watches, diagnoses, and proposes fixes before you notice the problem. I'm building the GTM version next.*
