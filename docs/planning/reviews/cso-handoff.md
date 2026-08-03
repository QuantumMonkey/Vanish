# /cso session handoff - Vanish security audit (TASK-18)

> Written 2026-08-03 for a fresh session. Read this, then `docs/promptgate.md`.
> Everything below is context so the audit spends its budget finding things
> rather than rediscovering the shape of the project.

## What you are auditing

Vanish is an Electron + PowerShell Windows uninstaller that runs **elevated** and
deletes files, removes registry keys, kills processes, and executes third-party
uninstallers. The blast radius is the user's entire machine. It is pre-release
and private; the repo is intended to go public, so **git history secrets
archaeology is in scope** (bd `vanish-uninstaller-vhm`, DoD-4).

State: Core tier code complete at v0.3.0, 280 local assertions passing, no VM
pass yet (Rule 10 - nothing is "Complete").

## Start here

The single highest-value target, already identified and deliberately left for you:

**`main.js`, the `uninstall-native` IPC handler: `exec(uninstallString)`.**
It passes a registry-derived string to a shell, from an elevated process. It
predates the current branch so a diff-scoped review excluded it, but the
reasoning from Vuln 3 below applies to it *with a shell attached*: `HKCU`
uninstall entries are writable by any standard user. Assess whether a crafted
`UninstallString` yields command injection, and whether the fix is to route it
through the same `Start-Process` path `Invoke-Uninstaller` uses.

## Already reviewed - do NOT re-report these

A focused review of the destructive surfaces ran on 2026-08-03 (TASK-19, notes
on bd `vanish-uninstaller-1td`). Three findings, all fixed, each with an attack
regression test in `test/security-verify.ps1`:

1. **Vault path traversal (HIGH, fixed).** Forged `manifest.json` entries could
   drive arbitrary file write/delete and arbitrary `.reg` import as admin. Fixed
   with UUID validation on entry ids, containment checks on every
   manifest-supplied relative path, and refusal to restore into the Windows
   directory. See `Test-VaultEntryId`, `Resolve-SafeVaultPath`,
   `Test-ProtectedDestination` in `scanner.ps1`.
2. **User-writable data directory (HIGH, fixed).** Now ACL'd on elevated start:
   Administrators + SYSTEM full control, Users read-only, inheritance severed.
   See `Set-VanishDataDirAcl` / `Test-VanishDataDirAcl`.
3. **Elevated execution of plantable uninstallers (MEDIUM, fixed).** Live
   registry re-read at execution time; `HKCU`-registered or user-writable
   binaries require a typed acknowledgement. See `Get-UninstallerTrust`,
   `Read-UninstallEntry`, and the gate in `lib/queue.js` `runOne`.

Two were assessed and dismissed with reasons - re-examine only if you disagree:
renderer-supplied finding objects in `cleaner-purge` (needs renderer compromise;
all interpolation is escaped via `esc()`), and `Grant-VanishOwnership` argument
handling (PowerShell's call operator passes arguments without shell re-parsing).

## The threat model to audit against

The one that produced all three findings, and the one to keep applying:

> **The app data directory is user-writable, but the engine reads it as
> elevated instructions.** Anything under `%APPDATA%\vanish-uninstaller\`
> (`manifest.json`, `settings.json`, `queue.json`, `oplog.jsonl`, vault payloads,
> `.reg` restore manifests) is untrusted input, not internal state.

Secondary boundaries worth probing:

* **Renderer -> main.** `contextIsolation` is on and there is no `nodeIntegration`.
  `preload.js` is the whole API surface. Ask whether any channel accepts a path
  or identifier it does not re-validate in `main.js` or `scanner.ps1`.
* **Tier boundary.** `fullModeOnly()` in `main.js` wraps every destructive
  channel; `scanner.ps1` re-checks `WindowsPrincipal` independently. Look for a
  destructive action reachable through a channel that is not wrapped.
* **Registry -> execution.** `HKCU` is attacker-writable. Any code path that
  reads a path or command from `HKCU` and runs it elevated is a candidate.
* **`Add-Type` interop.** `rstrtmgr.dll` P/Invoke and `NtSuspendProcess` in
  `scanner.ps1`. Handles are held open deliberately (PID-reuse defence) and
  released in a `finally`.

## Where the destructive surfaces live

| Surface | Location |
|---|---|
| Quarantine / restore / delete | `scanner.ps1`: `Invoke-QuarantineItems`, `Invoke-VaultRestore`, `Invoke-VaultDelete`; `lib/vault.js` |
| Privilege boundary | `main.js`: `fullModeOnly()`, `isFullMode()`; `scanner.ps1`: `Test-IsElevated` |
| Process kill / unlock / suspend | `scanner.ps1`: `Stop-VanishProcess`, `Unlock-Path`, `VanishNative.ProcessFreezer` |
| Uninstaller execution | `scanner.ps1`: `Invoke-Uninstaller`, `Resolve-UninstallArgs`; `lib/queue.js`; **`main.js` `uninstall-native`** |
| Registry cleaners | `scanner.ps1`: `Find-*` functions, `Set-PathEntries`, `Resolve-ClassesPhysicalPath` |
| Offline hive loading | `scanner.ps1`: `Find-OtherProfileRemnants` (`reg load` / `reg unload`, unload in `finally`) |
| ACL manipulation | `scanner.ps1`: `Grant-VanishOwnership` (`takeown` + `icacls`), `Set-VanishDataDirAcl` |
| IPC surface | `preload.js` (complete list), handlers in `main.js` |

## Binding constraints the audit must respect

From `docs/promptgate.md` - these are decisions, not oversights:

* **Rule 6:** zero runtime network I/O. No telemetry, no cloud lookups, no
  update pings. CSP names no external origin; `connect-src 'none'`. If you find
  *any* outbound call, that is a finding.
* **Rule 13:** elevation checks use `WindowsPrincipal`, never `net session`.
* **Rules 4/5:** no bundled definition files or YARA rules.
* **Rule 8:** "100% complete rollback" is banned language.

## Known gaps - already ticketed, not findings

* Driver Store packages are listed but not removable (`vanish-uninstaller-0ng`);
  Stage 11 / Standard tier per Rule 16.
* REQ-19's ownership elevator has no acceptance test yet
  (`vanish-uninstaller-1qp`); needs a TrustedInstaller-owned fixture on a VM.
* UAC accept/decline branches of the startup elevation offer are unverified.
* `bd dolt push` is blocked by GitHub email privacy (dolt commits carry a real
  address). Issue state is preserved in `.beads/issues.jsonl` on master.

## Running things

```powershell
npm start                                                            # the app
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1  # 280 assertions, elevated
```

The suite is the regression net - if you change a destructive path, it must stay
green. `test/security-verify.ps1` specifically attempts each known attack and
asserts refusal.

## Expected output (DoD-4)

Per `05-implementation-plan.md` TASK-18: fix criticals, ticket everything else as
bd issues, and confirm the git-history secrets scan is clean. The vault
directory ACL question that TASK-18 was originally meant to resolve has already
been answered - see finding 2 above.
