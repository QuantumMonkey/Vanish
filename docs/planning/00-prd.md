# PRD -- Product Requirements

> Owner doc for REQ-nn ids. Downstream docs cite these; never restate them.
> Scope of this pack: promptgate Rule 2 + Rule 3 retrofits, then roadmap
> Stages 3, 6, 9 (the remaining Core tier). Stages 1-2 are implemented and
> out of this pack. `docs/promptgate.md` wins any conflict with this pack.

## Problem

Windows users who uninstall software are left with orphaned files, registry
keys, autostart entries, services, and shell integrations. Existing tools
split into aggressive "cleaners" that delete on vague heuristics and manual
registry surgery. Vanish v0.2.x already ships the audit-first inventory,
uninstall wizard, and leftover scanner, but it still deletes directly on
purge (violates promptgate Rule 2) and has no enforced read-only tier when
unelevated (violates Rule 3). Core-tier features that make it a complete
manager (process unlocker, bulk uninstall, system integration cleanup) are
design-only. Evidence: as-built gaps listed in ARCHITECTURE.md section 5;
category distrust documented in README "Why this exists".

## Users & jobs

| Persona | Job-to-be-done | Frequency | Willingness to pay |
|---|---|---|---|
| Power user / developer | Remove an app and every trace of it, safely | Weekly-monthly | USD 4.99-9.99 one-time (Store convenience) |
| Cautious home user | Clean startup bloat and leftovers without breaking Windows | Monthly | Same, or uses free GitHub build |
| Machine refurbisher / helper | Bulk-remove preinstalled junk quickly | Per machine | Same |

## Success metrics

- M1: Zero data-loss reports attributable to a purge once quarantine ships
  (every removal restorable), measured across GitHub issues through v1.0.
- M2: All Core-tier stages VM-tested (Rule 10) on clean Windows 10 and 11,
  recorded in CHANGELOG, before any public release (Rule 16).
- M3: Unelevated launch lands in functional Audit Mode with banner; zero
  crash-on-declined-UAC reports.
- M4: Bulk uninstall of 5 queued apps completes unattended except for
  non-silent uninstallers, verified on the test VMs.

## Requirements

Safety retrofits (promptgate Rules 2 and 3):

- **REQ-01** [MUST] Quarantine-first file deletion: every purged file is
  moved to a versioned quarantine vault, never deleted directly.
  *Accept when:* after a purge, all removed files exist in the vault with a
  manifest, and originals are gone from source paths.
- **REQ-02** [MUST] Registry restore manifest: every registry key/value
  removal is exported to a restore manifest before deletion.
  *Accept when:* a purged key can be restored from the manifest and
  reappears in the registry.
- **REQ-03** [MUST] Quarantine Manager UI: list vault entries with details,
  restore per entry, purge per entry; auto-purge is a setting, off by
  default (Rule 1: deletion policy separate from discovery depth).
  *Accept when:* restore returns files/keys to original locations; nothing
  leaves the vault without an explicit click.
- **REQ-04** [MUST] Elevation tiers: unelevated launch runs Audit Mode
  (read-only: listing, scans, reports) with the persistent banner text from
  Rule 3; destructive actions disabled with an explaining tooltip.
  *Accept when:* unelevated run shows the banner and every destructive
  control is inert; elevated run shows no banner.
- **REQ-05** [MUST] Startup elevation offer: on unelevated launch, offer
  relaunch-as-admin once (Stage 9 auto-UAC relauncher); declining falls back
  to Audit Mode gracefully, never exits or crashes.
  *Accept when:* declining the UAC prompt lands in working Audit Mode.

Stage 3 (Task Manager & Unlocker):

- **REQ-06** [MUST] Process monitor: live process list with CPU, memory,
  disk usage; refresh interval user-visible; kill requires Full Mode.
  *Accept when:* list matches Task Manager within one refresh interval.
- **REQ-07** [MUST] Unlocker: given a locked file/folder, list the holding
  processes via the Windows Restart Manager API and offer clean shutdown,
  with per-process forced termination as an explicit second step.
  *Accept when:* a file locked by a test process is identified and freed.
- **REQ-08** [SHOULD] Watchdog suspension: suspend a process before closing
  its handles so it cannot respawn lockers during cleanup.
  *Accept when:* a self-restarting test pair is cleaned without respawn.
- **REQ-09** [MUST] Suspicious activity indicators: passive, local,
  display-only flags per Rule 7 (suspicious process trees, destructive
  command lines, persistence paths), labelled "Indicator -- investigate
  with your antivirus". No automated action.
  *Accept when:* a simulated Office-spawns-powershell tree is flagged,
  and no UI path takes action on the flag.

Stage 6 (Orchestration & Shell Cleanup):

- **REQ-10** [MUST] Bulk silent uninstall queue: select multiple apps, run
  uninstallers sequentially with the Rule 15 switch lookup chain (corrections
  JSON primary, then heuristic fallback -- winget dropped, see OPEN-02),
  trap exit codes, pause on reboot-required.
  *Accept when:* M4 scenario passes; per-app method logged.
- **REQ-11** [MUST] Context menu cleaner: find orphaned shell extension
  handlers pointing to missing executables; removal is review-gated and
  quarantined (REQ-02 manifest).
  *Accept when:* a planted orphan handler is found, quarantined, restorable.
- **REQ-12** [MUST] Installer service manager: validate/start msiserver
  before MSI uninstall queues; restore prior service state after.
  *Accept when:* queue runs with msiserver initially disabled.
- **REQ-13** [MUST] Restore point frequency override: temporarily set the
  creation-frequency registry value to 0 around checkpoints, restoring it
  immediately after, so consecutive uninstalls each get a restore point.
  *Accept when:* two back-to-back uninstalls both produce restore points
  and the registry value is restored.

Stage 9 (System Integration & Environment Clean):

- **REQ-14** [MUST] Orphaned services and drivers audit: list service
  entries and third-party driver store packages whose backing files are
  gone; removal review-gated and manifest-backed.
  *Accept when:* planted orphan service is found, removed, restorable.
- **REQ-15** [MUST] PATH cleaner: flag dead directories in user and system
  PATH; removal review-gated; prior value saved to manifest.
  *Accept when:* dead entry removed, PATH still valid, restorable.
- **REQ-16** [MUST] File association repair: find extension/protocol
  handlers pointing to missing executables; removal review-gated and
  quarantined.
  *Accept when:* planted dead handler found and restorable.
- **REQ-17** [SHOULD] Multi-user profile sweep: offline-load other local
  users' registry hives to scan remnants, unloading safely afterwards;
  Full Mode only.
  *Accept when:* remnant planted in a second profile is found; hive is
  unloaded even on scan failure.
- **REQ-18** [MUST] Explicit registry views: scanner reads 64-bit and
  32-bit registry views explicitly (no implicit WOW64 redirection) for all
  Stage 6/9 scans.
  *Accept when:* a key planted only in the 32-bit view is found from the
  64-bit host process.
- **REQ-19** [SHOULD] Ownership elevator: when quarantine-move fails on
  ACL-restricted leftovers, offer explicit takeown/ACL step, per item,
  Full Mode only, logged in the manifest.
  *Accept when:* a TrustedInstaller-owned test file is quarantined after
  the elevator step.

Stage 6 addition (Forced Uninstall, operator-directed 2026-08-03):

- **REQ-20** [MUST] Forced uninstall for broken and orphaned entries. Three
  entry points, one review-gated pipeline:
  1. **Detected broken entries.** Vanish enumerates the uninstall registry keys
     itself and flags entries whose `UninstallString` is absent, whose
     uninstaller executable is gone, or whose `InstallLocation` no longer
     exists. The user does not have to know an application's name to fix it.
  2. **By application name.** A keyword feeds the existing three-mode discovery
     scan (Rule 1: depth stays independent of deletion policy).
  3. **By install folder.** A path the user still has, belonging to no
     registered application.

  Behaviour: when a working uninstaller is still present Vanish offers to run
  that first and only forces when it is missing, broken, or declined - forcing
  is the fallback, never the default. The orphaned uninstall registry key is
  itself included in the findings, because leaving it behind is exactly what
  keeps a dead application listed in Programs and Features. Every removal goes
  through the quarantine vault (Rule 2), the uninstall key included, so a
  mistaken force is recoverable. Scanning works in Audit Mode; removal does not.

  *Accept when:* an application whose uninstaller executable has been deleted is
  detected as broken without the user naming it; its traces and its uninstall
  key are quarantined; the entry disappears from the application list; and
  restoring the vault entry brings back both the files and the listing.

  *Why this is not Revo's forced uninstall:* Revo makes the user supply a name
  or folder, then deletes what it finds, with a registry backup the user has to
  go and locate. Vanish finds the broken entries itself, shows per-item evidence
  for every proposal, routes the whole removal through the same restorable vault
  as every other operation, and still prefers the application's own uninstaller
  when one actually works.

## Out of scope (this release)

- Stages 4, 7, 8, 11, 12, 14 (Standard tier) and 10, 13 (Extended): Rule 16
  forbids starting them before Core is VM-tested.
- Cloud threat lookups, submission pipelines: permanently cut (Rule 6).
- Bundled definition files (BCU rules, CleanerML, YARA rules): Rule 4/5;
  the definitions loader is Standard-tier work.
- Commercial license enforcement: deferred post-MVP per roadmap.
- UI framework migration, installer/packaging work, code signing purchase:
  release-phase concerns (Rule 14 gates distribution, not development).

## Constraints

- Solo operator, Claude Pro quota (playbook S2); tasks sized to one session.
- Platform: Windows 10 1607+ and Windows 11; PowerShell 5.1 only.
- Stack fixed by ADR 0001 (Electron + vanilla JavaScript + PowerShell 5.1).
- Zero network calls at runtime (Rule 6); zero telemetry.
- "Complete" means tested on clean Win10 + Win11 VMs (Rule 10).
- Payments: Microsoft Store Convenience Edition (ADR 0001); source stays MIT.

## Decisions

- D-01: Retrofit quarantine + Audit Mode before any Stage 3+ feature work.
  | Because: every later stage's destructive ops must build on Rule 2/3
  primitives, retrofitting later would touch every stage twice.
  | Rejected: ship Stage 3 first for visible progress -- multiplies rework
  and leaves live Rule 2 violations in the meantime.
- D-02: Watchdog suspension (REQ-08) and multi-user sweep (REQ-17) and
  ownership elevator (REQ-19) are SHOULD, not MUST.
  | Because: each targets a minority scenario and carries elevated risk;
  Core release is viable without them.
  | Rejected: all-MUST -- inflates the VM test matrix before first release.
- D-03: Single candidate intake; no competing ideas gated.
  | Because: user designated Vanish as the project; viability gate ran and
  passed (bd issue vanish-uninstaller-22n).
  | Rejected: generate additional candidates -- token cost with no demand.

## Open questions

- OPEN-01: Process suspension mechanism for REQ-08 (undocumented
  NtSuspendProcess vs documented alternatives). | Owner: research
  (Antigravity, findings to bd) | Blocks: TASK for REQ-08 only.
- OPEN-02 [RESOLVED 2026-07-11]: winget cannot be queried offline (default
  source is a network REST API; Rule 6 forbids the call) and does not expose
  UninstallerSwitches. Resolution: drop winget; corrections.json is the
  primary source, heuristic fallback second. Rule 15 amended accordingly;
  see DEVIATIONS.md. Findings in bd vanish-uninstaller-1gi.

## Gate checklist

- [x] Every REQ has a testable acceptance criterion
- [x] Every MUST maps to the problem statement (no orphan features)
- [x] Out-of-scope is non-empty and reasoned
- [x] Success metrics are measurable with the tools we actually have
      (GitHub issues, VM test runs, CHANGELOG)
- [x] Every decision names a rejected alternative
