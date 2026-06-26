# Vanish: Release & Versioning Guide

---

## Versioning Scheme — `RELEASE.MAJOR.MINOR`

Vanish uses a three-part version number. The rules below are the single source of
truth. When in doubt, ask: *"which digit does this change belong to?"* and apply
the lowest one that fits.

### RELEASE (first digit)

Bumps from `0` to `1` exactly once — when Vanish is ready for public distribution.

**Bump when ALL of the following are true:**
- All Core tier stages (1, 2, 3, 6, 9) are marked Complete in `docs/handoff.md`
  per Promptgate Rule 10 (tested on clean Windows 10 and Windows 11 VMs).
- A signed binary exists (EV or OV certificate — see Code Signing below).
- `README.md` has a real screenshot, not a placeholder.
- `BENCHMARKS.md` has at least one validated run with full test conditions.

**After `1.0.0`:** bump RELEASE again only for a complete architectural overhaul
that breaks backward compatibility with the IPC protocol or scanner.ps1 interface
(e.g. switching the host from Electron to a different runtime). These are rare.

**Do not bump RELEASE** to signal excitement or importance. A major feature
completing is a MAJOR bump, not a RELEASE bump.

---

### MAJOR (second digit)

Bumps each time a meaningful new capability tier is complete.

**Bump when ANY of the following occurs:**
- A roadmap Stage (as defined in `docs/roadmap.md`) reaches functional
  completion — meaning its core deliverables work end-to-end, not just that
  code exists.
- The IPC action interface in `scanner.ps1` / `main.js` changes in a way that
  would break an older renderer (renamed actions, removed fields, schema changes).
- A significant architectural change: adding a persistent database, switching
  the IPC transport, replacing the PowerShell backend with a compiled binary.

**Do not bump MAJOR** for adding a new function to an existing stage,
fixing bugs in a completed stage, or documentation changes.

> **Double digits are expected and correct.** The roadmap has 14 stages (Stage 5
> was merged into Stage 3, leaving 13 active). By the time all Standard and
> Extended tier stages are complete, MAJOR will reach `0.13.x` or similar.
> Do not reset, compress, or artificially cap the digit to keep it single-digit.
> `0.13.0` is unambiguous and semantically accurate.

---

### MINOR (third digit)

Everything else. This digit absorbs all routine development activity.

**Bump when:**
- A bug is fixed within a completed stage.
- A new helper function, IPC handler, or UI component is added that extends
  an existing stage without completing a new one.
- Documentation is updated, reorganised, or corrected.
- Files are moved, renamed, or deleted.
- CSS or UI tweaks that do not constitute a new stage feature.
- Dependency updates (Electron, Node packages) with no behavioral change.
- Promptgate rule violations are fixed.

---

## Current Version History

| Version | Date | Description |
|---------|------|-------------|
| `0.1.0` | 2026-06-25 | Core MVP — Stage 1 complete |
| `0.1.1` | 2026-06-26 | Promptgate alignment, docs corrections, README/BENCHMARKS/RELEASING created |
| `0.2.0` | 2026-06-26 | Stage 2 complete — Audit & Health Advisor |
| `0.2.1` | 2026-06-26 | Docs consolidated into `docs/`, versioning scheme established |

---

## What Comes Next

| Milestone | Expected version | Tier |
|-----------|-----------------|------|
| Stage 3 complete (Task Manager & Unlocker) | `0.3.0` | Core |
| Stage 4 complete (Search & Destroy) | `0.4.0` | Standard |
| Stage 5 | *(merged into Stage 3 — no separate version bump)* | — |
| Stage 6 complete (Orchestration & Shell Cleanup) | `0.5.0` | Core |
| Stage 7 complete (Network & Disk Optimization) | `0.6.0` | Standard |
| Stage 8 complete (Installation Sandbox Rollback) | `0.7.0` | Standard |
| Stage 9 complete (System Integration & Environment Clean) | `0.8.0` | Core |
| Stage 10 complete (Enterprise Audits & Offset Rules) | `0.9.0` | Extended |
| Stage 11 complete (Windows Cache & Installer Purge) | `0.10.0` | Standard |
| Stage 12 complete (OS Telemetry & Shortcut Alignment) | `0.11.0` | Standard |
| Stage 13 complete (Runtime Dependency & Driver Audit) | `0.12.0` | Extended |
| Stage 14 complete (CleanerML Cache Engine) | `0.13.0` | Standard |
| All Core stages verified on clean VMs, signed binary ready | `1.0.0` | — |

> **Note**: RELEASE (`1.0.0`) does not wait for all 13 stages — only Core tier
> stages (1, 2, 3, 6, 9) must be complete and VM-verified. Standard and Extended
> stages ship as `1.x.0` post-launch updates.

---

## Code Signing (Hard Gate — Promptgate Rule 14)

Unsigned builds are for local development only. No unsigned binary is distributed
externally under any circumstances, including pre-release and beta builds.

**Certificate options:**
- **OV (Organization Validation)**: ~$100–300/yr. Verifies organisation identity.
  SmartScreen will warn on first runs until download reputation builds (weeks to
  months depending on volume). Sufficient for early community releases.
- **EV (Extended Validation)**: ~$300–600/yr. Requires hardware USB token and
  stricter identity verification. Clears SmartScreen immediately on day one.
  Required for kernel-mode drivers. Recommended for the `1.0.0` public launch.

**Pre-distribution checklist:**
- [ ] EV or OV code signing certificate obtained
- [ ] All distributed binaries signed before packaging
- [ ] SmartScreen reputation impact acknowledged (OV requires build-up period)

---

## Pre-Release Verification Checklist

Before tagging any `1.x.x` release:

- [ ] All Core tier stages tested on clean Windows 10 VM (build 1607+)
- [ ] All Core tier stages tested on clean Windows 11 VM
- [ ] Performance targets validated and logged in `BENCHMARKS.md`
- [ ] `README.md` up to date with current screenshots
- [ ] `CHANGELOG.md` `[Unreleased]` block promoted to the new version and dated
- [ ] No local filesystem paths present in any doc file (Promptgate Rule 18)
- [ ] All Mermaid diagrams rendering correctly on GitHub (Promptgate Rule 21)
- [ ] Git tag created matching the version number (e.g. `git tag v1.0.0`)
