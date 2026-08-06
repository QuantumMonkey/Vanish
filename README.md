# Vanish

**An on-device Windows application auditor and manager that proposes — and never acts without your approval.**

Vanish maps every installed application (desktop + Microsoft Store), walks you through clean uninstalls with a native-uninstaller-first wizard, hunts down the leftovers that uninstallers leave behind, quarantines everything it removes so it can be put back, and audits system health — startup bloat, orphaned autostart entries, redundant software, locked files, a bulk uninstall queue. Everything runs locally. Nothing leaves your machine.

> Working version 0.3.0, Core tier feature-complete. Passes 290/290 assertions **unelevated** (`npm test`); 2 of 14 suites need Full Mode and have not run this session. Not yet **Complete** by this project's own bar — see [Status](#status) below before you rely on it.

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
scan  →  detect  →  propose  →  await approval  →  act (quarantine)  →  report
```

1. **Scan** — enumerate apps from the registry Uninstall hives (64-bit, 32-bit, per-user) and UWP packages ([scanner.ps1](scanner.ps1) `Get-InstalledApps`, `Get-UwpApps`).
2. **Detect** — after the app's *own* uninstaller runs, sweep the filesystem and registry for remnants in one of three user-selected depths (`Scan-Leftovers`).
3. **Propose** — present every finding in a review tree with a per-item risk label (Safe / Moderate / Advanced). Advanced-risk items are **unchecked by default** ([renderer.js](renderer.js) `renderLeftoversTree`).
4. **Await approval** — nothing moves until you review the list and click Purge. Unchecking everything and finishing without purging is a first-class path.
5. **Act & report** — the checked items are quarantined, not deleted: files move into a versioned vault and registry keys are exported to a `.reg` restore manifest *before* anything is removed. Anything locked by Windows is reported as skipped, never forced. Every quarantined item can be restored from the Quarantine Manager tab, or permanently deleted behind a typed double-confirmation.

This same scan → propose → quarantine pattern is how every other destructive surface in the app works too — the bulk uninstall queue, System Clean's six cleaners, Force Uninstall for broken entries. There is exactly one route to the disk or the registry for a removal ([lib/vault.js](lib/vault.js)), and it is this one.

## What it does

| Capability | Where it lives |
|---|---|
| Desktop app inventory across HKLM / HKCU / Wow6432Node hives, with size + install date | [scanner.ps1](scanner.ps1) `Get-InstalledApps` |
| UWP / Store app inventory with `AppxManifest.xml` friendly-name parsing | [scanner.ps1](scanner.ps1) `Get-UwpApps` |
| System Restore Point before any uninstall (default-on, handles the Windows 24-hour rate limit) | [scanner.ps1](scanner.ps1) `Create-RestorePoint` |
| Native-uninstaller-first flow — Vanish resolves and launches the app's own uninstaller before touching anything, with a live registry re-read and a trust check on every run | [main.js](main.js) `uninstall-native` |
| Three-depth leftover scanning with publisher-folder protection (shared publisher folders are never proposed for whole-folder deletion) | [scanner.ps1](scanner.ps1) `Scan-Leftovers` |
| Quarantine vault — every removal is reversible until you say otherwise | [lib/vault.js](lib/vault.js), [lib/store.js](lib/store.js), Quarantine Manager tab |
| Audit Mode / Full Mode elevation tiers — the app is read-only until elevated, with a persistent banner and every destructive control inert and explained | [main.js](main.js) `fullModeOnly()` |
| Task Manager & file-lock unlocker — see what has a file open and close it (or suspend the tree) before retrying | [scanner.ps1](scanner.ps1) `Get-ProcessList`, `Unlock-Path` |
| Bulk uninstall queue — restore point, silent-switch resolution, and an untrusted-uninstaller acknowledgement gate, per app | [lib/queue.js](lib/queue.js) |
| System Clean — orphaned context menus, services, dead PATH entries, broken file associations, other-profile remnants; driver packages are audited but not yet removable | [scanner.ps1](scanner.ps1) `Invoke-CleanerScan` |
| Force Uninstall — detects and removes entries that can no longer uninstall themselves, still routed through the vault | [scanner.ps1](scanner.ps1) `Find-BrokenUninstallEntries` |
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

- **No telemetry, no network calls.** There is no analytics code and no cloud lookup anywhere in the codebase. The CSP names no external origin (`connect-src 'none'`) — verify with a grep, don't take the README's word for it.
- **No autonomous deletion.** No scheduler, no background service, no "auto-clean" — with one narrow, explicit exception: an *optional* setting to permanently purge quarantined items past a retention period at app start, off by default. Every other removal traces to a checkbox you ticked that session.
- **Not an antivirus.** Vanish surfaces information; it makes no threat judgments.
- **No silent auto-elevation.** Vanish can be set to *ask* Windows for elevation automatically at startup instead of waiting for a click (Settings → "Start Vanish as administrator", off by default) — but Windows' own UAC consent prompt still appears on every single launch either way. There is no path in this codebase that skips it.
- **Driver package removal is audit-only** in this release. Third-party driver packages with a missing INF are listed, not removed — that sweeper is scoped for the Standard tier, not Core.

## Status

Status vocabulary follows this project's own **promptgate Rule 10**: *Implemented* means coded with a passing local verification suite; it does **not** mean *Complete*. Nothing in this repository is Complete until a clean Windows 10 (1607+) and Windows 11 VM pass happens — that gate has not run yet. Treat everything below as "works on the machine it was built on," not "shipped."

**Implemented and locally verified (working version 0.3.0):**
- Quarantine-first removal for every destructive path — files move into a versioned vault, registry keys export to a `.reg` restore manifest, *before* anything is removed ([lib/vault.js](lib/vault.js))
- Audit Mode / Full Mode elevation tiers enforced independently in both the main process and the PowerShell engine — a destructive action reachable only through a channel neither layer gates has not been found ([main.js](main.js) `fullModeOnly()`, [scanner.ps1](scanner.ps1) `Test-IsElevated`)
- Restore point before uninstall, on by default, admin-gated ([scanner.ps1](scanner.ps1) `Create-RestorePoint`)
- The app's own uninstaller always runs first, resolved through a live registry re-read with a trust check — no command string ever crosses the renderer→main boundary ([main.js](main.js) `uninstall-native`)
- Per-item review with risk labels; Advanced findings opt-in only ([renderer.js](renderer.js))
- Shared publisher folders protected from whole-folder deletion ([scanner.ps1](scanner.ps1) `Is-PublisherShared`)
- Locked files reported and skipped, never forced; a Task Manager + unlocker tab can close or suspend the holder first
- A bulk uninstall queue, a System Clean pass across six leftover categories, and Force Uninstall for entries that can no longer uninstall themselves — all routed through the same vault
- Elevation state detected via the `WindowsPrincipal` API, never `net session`
- A `/cso` security audit found and fixed four issues in the destructive paths (command injection, a restore-destination guard bypassable by a directory junction, an ACL fix that didn't survive the app's own normal startup order, and an untracked lockfile) — see the **Security** section of [CHANGELOG.md](CHANGELOG.md)

**Not yet done, honestly:**
- The Windows 10 / Windows 11 clean-VM acceptance pass (`TASK-17`) — the gate everything above is waiting on
- The UAC accept/decline/cancel branches of both the startup elevation offer and the new auto-elevate setting — these need a human at the actual consent prompt, which cannot be automated
- Code signing and Microsoft Store submission
- Driver Store package *removal* (listing works today)

See [ARCHITECTURE.md](ARCHITECTURE.md) §5 for the full implemented-vs-designed table.

## Quickstart

Requirements: Windows 10 (1607+) or Windows 11 · PowerShell 5.1+ (bundled with Windows) · Node.js 20+

```powershell
# In an elevated PowerShell (admin rights are needed for restore points,
# HKLM cleanup, and most of the app; unelevated runs are read-only Audit Mode):
git clone https://github.com/QuantumMonkey/Vanish
cd Vanish
npm ci
npm start

# Run the local verification suite (314/314 unelevated; 2 of 14 suites need
# Full Mode - run from an elevated shell for the full picture):
npm test

# Run it against YOUR machine, with the real engine and real data. Slower,
# read-only, and the one that matters - see below:
npx electron test/real-data-verify.js
```

### Two kinds of test, and why the second one exists

`npm test` drives a fixture: one fake application, clean fields, instant
responses. It is fast, it runs anywhere, and on 2026-08-06 it reported
**312 of 312 passing while the app was visibly broken** — 60 of 151 installed
programs invisible, the Storage panel rendering nothing at all, and the
uninstall buttons sitting 250px below the bottom of the window. Fixture-shaped
tests validate fixture-shaped reality.

`test/real-data-verify.js` runs the real preload against the real backend on
the machine you are sitting at, and asserts what a user would actually see.
Its ground truth comes from `test/fixtures/real-machine-truth.ps1`, which
queries the machine with its own independent queries — a harness that asks the
code under test what reality looks like can only ever agree with itself. It
prints what it could **not** verify at the end of every run.

```powershell
npx electron test/real-data-verify.js                      # everything
npx electron test/real-data-verify.js --only=storage,force  # named sections
npx electron test/real-data-verify.js --sweep               # 800x600, 1080x720, 1440x900
npx electron test/real-data-verify.js --plant               # proves broken-entry detection
```

It is deliberately outside `npm test`: it is slow, its results depend on what
is installed, and its failures are meant to be read rather than counted.
`--plant` creates one clearly-named broken uninstall entry under HKCU and
removes it again; everything else is read-only.

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
