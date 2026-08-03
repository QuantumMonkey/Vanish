# Vanish: LLM Handoff Specification
> [!NOTE]
> This handoff document is formatted for LLM ingestion to resume project development seamlessly when token limits are reached or context is rotated.

---

## 📌 Project Overview
Vanish is a modern Windows application manager and deep cleaner uninstaller. It is built as an Electron desktop app executing an asynchronous PowerShell backend. It replaces outdated uninstaller utilities with a high-performance, glassmorphic UI, UWP support, automatic restore point checkpoints, three remnant scanning modes (Safe, Moderate, Advanced), and a quarantine vault that makes every removal reversible.

* **Repository Location**: `https://github.com/QuantumMonkey/Vanish`
* **Version**: `0.3.0` (RELEASE.MAJOR.MINOR; RELEASE stays 0 until `docs/RELEASING.md` criteria are met)
* **Status**: **Core tier code complete. VM verification outstanding.** Every Core roadmap stage (1, 2, 3, 6, 9) plus the Rule 2/3 safety retrofits is implemented and passes a 310-assertion local suite. Per Rule 10 that is **In Progress**, not Complete.

---

## 🧭 Start here

1. Read `docs/promptgate.md`. It is the law and it outranks this file.
2. Read `docs/planning/CODEX.md` for how to decide when a spec is silent.
3. `bd ready` for available work. The remaining work is Phase 5 (release), not features.
4. Run `test\run-all.ps1` from an elevated shell before changing anything, so you know the baseline is green on your machine.

---

## 📁 File Structure Map

* **[package.json](../package.json)**: Scripts, configuration, Electron (`^42.5.0`) dependency. *(Status: Complete)*
* **[main.js](../main.js)**: Window container, window controls, and the entire IPC surface. Owns the elevation tier (resolved once at startup, cached before any window exists) and the `fullModeOnly()` wrapper that rejects every destructive channel in Audit Mode. Wires the queue runner and routes System Clean purges through the vault. *(Status: Complete)*
* **[preload.js](../preload.js)**: The secure IPC bridge; one named function per channel, no raw `ipcRenderer` exposure. *(Status: Complete)*
* **[lib/store.js](../lib/store.js)**: Single writer for `manifest.json`, `settings.json`, `queue.json` and `oplog.jsonl` under the Electron userData path. Atomic writes (temp file + rename), schema defaults, oplog rotation at 5 MB. Implements ENT-01..ENT-05. *(Status: Complete)*
* **[lib/vault.js](../lib/vault.js)**: The quarantine pipeline - quarantine, list, restore, delete-forever, retention sweep. Every destructive file/registry operation in the app funnels through here (INV-1). *(Status: Complete)*
* **[lib/queue.js](../lib/queue.js)**: Bulk uninstall state machine (FLOW-05), persisted on every transition. Takes its engine runner by injection, which is how the state machine is tested without uninstalling anything real. *(Status: Complete)*
* **[index.html](../index.html)**: Titlebar, Audit Mode banner, dashboard, application table, details sidebar, uninstall wizard, and the Health Advisor / Task Manager / System Clean / Quarantine / Force Uninstall / Settings / About panels, plus the queue panel and shared dialogs. Carries the Content-Security-Policy. *(Status: Complete)*
* **[index.css](../index.css)**: Glassmorphic dark styling. Design tokens, Stage 2 audit styles, and the phase 1-4 additions (tier banner, panel chrome, vault entries, process table, cleaner sections, queue panel, modals, toasts). Honours `prefers-reduced-motion`. *(Status: Complete)*
* **[assets/icons.css](../assets/icons.css)**: First-party 45-glyph icon set on a 24x24 grid, 2px stroke, delivered as CSS mask images so glyphs paint in `currentColor`. Replaces the FontAwesome CDN. Add a glyph by adding a `.fa-<name>` rule that sets `--vi`. *(Status: Complete)*
* **[renderer.js](../renderer.js)**: UI controller. Tier state and destructive-control locking, tab routing, app list, uninstall wizard, quarantine manager, process monitor, unlocker, System Clean cleaners, queue panel, Force Uninstall, Settings, About. All interpolation is HTML-escaped via `esc()`. *(Status: Complete)*
* **[scanner.ps1](../scanner.ps1)**: System execution engine behind one `-Action` dispatcher (D-04). Stage 1-2 functions plus the quarantine vault primitives, Restart Manager and `NtSuspendProcess` interop, process/indicator sampler, Rule 15 switch resolver, uninstaller runner, `msiserver` management, explicit registry-view helpers, six cleaners, and broken-entry detection. *(Status: Complete)*
* **[corrections.json](../corrections.json)**: ENT-03 uninstall switch corrections, read-only at runtime, community-correctable. Seeded with the OPEN-02 verified entries. *(Status: Complete - seeded, expected to grow)*
* **[test/](../test)**: Eleven verification harnesses plus `run-all.ps1`. **Not scaffolding** - `05-implementation-plan.md` TASK-17 makes these acceptance checks the VM test script, so they are the input to the release gate. *(Status: Complete for phases 1-4)*

---

## 🚀 How to Run

Vanish runs in either tier. Cleaning and uninstallation require administrative privileges.

```powershell
cd path\to\vanish
npm start
```

Launching unelevated is a supported path: Vanish offers to restart as administrator once, and declining lands in Audit Mode (read-only) with a persistent banner.

Verification suite (elevated, for the destructive paths):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1
```

---

## ✅ What the 2026-08-03 session delivered

The compliance gap flagged in the previous handoff is **closed**, and the rest of Core was implemented behind it.

* **Rule 2 (quarantine-first)** - satisfied. `Purge-Remnants` is deleted from `scanner.ps1`; no direct-delete path on a user target remains. Files move to `vault/<entry-id>/files/<n>/`, registry keys export to `.reg` restore manifests before removal. The only outright deletes are the vault's own "Delete Forever" and the opt-in retention sweep.
* **Rule 3 (Audit Mode)** - satisfied and enforced in code. Verified by invoking all nine destructive IPC channels directly while unelevated; every one is rejected by `main.js`.
* **Rule 6 / NFR-06 (zero runtime network I/O)** - now actually true. The FontAwesome and Google Fonts CDNs are gone, replaced by a first-party icon set and the OS type stack. The CSP names **no external origin**: `default-src 'self'` with `connect-src 'none'`.
* **Stages 3, 6, 9** implemented, plus REQ-20 (Force Uninstall) and real Settings/About panels.

Design work recorded in the owning docs: vault layout and `entry.json` durability record (`04-schema.md` D-12/D-13), the `manifest-only` registry mode that lets the PATH cleaner rewrite a value without deleting the key it lives in, and REQ-20 in `00-prd.md`.

---

## 🔍 Roadmap Checklist

> **Before planning, speccing, or implementing any feature**, run it through `docs/promptgate.md`.

> **For Stages 6-14**, refer to `docs/roadmap.md`. The checklist below covers Core tier stages only.

**Core Tier** (complete before any public release):

- `[x]` **Stage 2 - Audit & Health Advisor Tab** *(code complete)*
- `[x]` **Quarantine vault + Audit Mode enforcement** *(code complete; UAC accept/decline branches need a human at the prompt)*
- `[x]` **Stage 3 - Task Manager & Unlocker**: process list with CPU/Memory/Disk, Restart Manager unlocker, passive indicators, watchdog suspension *(code complete)*
- `[x]` **Stage 6 - Orchestration & Shell Cleanup**: bulk queue, context menu cleaner, msiserver manager, restore point override, Forced Uninstall (REQ-20) *(code complete)*
- `[x]` **Stage 9 - System Integration & Environment Clean**: services purge, PATH cleaner, association repair, multi-user sweep, auto-UAC relauncher, registry redirection bypass *(code complete except driver-store removal and the REQ-19 acceptance test)*

Rule 10: a stage is only "Complete" once manually verified on a clean Windows 10 and Windows 11 VM. Coded and passing locally is "In Progress" - this checklist and `CHANGELOG.md` say exactly that.

**Standard and Extended tiers**: see `docs/roadmap.md`. Rule 16 forbids starting them until Core is VM-tested.

---

## 🚧 The release gate - what is actually left

| # | Gate | bd issue | State |
|---|---|---|---|
| 1 | VM test matrix, clean Win10 (1607+) + Win11 | `vanish-uninstaller-0xt` | **Blocked - no VM available.** This is the gate that turns In Progress into Complete. |
| 2 | Security audit (`/cso` full pass) | `vanish-uninstaller-vhm` | Approved by the operator, not yet run. Start it in a fresh session. |
| 3 | `/code-review high` on destructive surfaces | `vanish-uninstaller-1td` | **Done 2026-08-03.** Three findings, all fixed and regression-tested (see below). |
| 4 | Docs pass + demo GIF | `vanish-uninstaller-k2o` | Open |
| 5 | Code signing + Store submission | `vanish-uninstaller-1w0` | **Operator decision, has cost.** Deferred until just before Store submission. Do not start unprompted. |
| 6 | One real external user completes the core flow | `vanish-uninstaller-442` | Operator will self-test first, then hand to someone else |

### Security review, 2026-08-03 (TASK-19)

A focused review of the destructive surfaces found three real issues, all now
fixed with a regression test per attack in `test/security-verify.ps1`. The
shared root cause is worth carrying forward: **the app data directory is
user-writable, but the engine reads it as elevated instructions.** Anything new
that reads from `%APPDATA%\vanish-uninstaller\` and acts on it in Full Mode must
treat that content as untrusted input.

1. **Vault path traversal (HIGH).** A forged `manifest.json` entry could make
   the elevated engine write an arbitrary file anywhere (`vaultRelative` /
   `originalPath`), import an arbitrary `.reg`, or recursively delete an
   arbitrary directory (traversing `entryId`). Fixed with UUID validation on
   entry ids, containment checks that every manifest-relative path resolves back
   inside its own entry folder, and a refusal to restore into the Windows
   directory.
2. **Unprotected data directory (HIGH).** The vault inherited `%APPDATA%` ACLs.
   Now ACL'd on every elevated start: Administrators + SYSTEM full control,
   Users read-only, inheritance severed. This was the `ASSUMED` item in
   `01-trd.md`; it is now resolved.
3. **Elevated execution of plantable uninstallers (MEDIUM).** `queue.json` was
   trusted at execution time and `HKCU` entries can name any binary. The runner
   re-reads the registry live, and untrusted uninstallers require a typed
   acknowledgement naming them.

Three further candidates were assessed and deliberately not actioned: the
pre-existing `exec(uninstallString)` in `uninstall-native` (unchanged by this
work - fold into `/cso`), renderer-supplied finding objects in `cleaner-purge`
(needs renderer compromise; strings are escaped), and `Grant-VanishOwnership`
argument handling (PowerShell's call operator passes arguments without shell
re-parsing, so no injection exists).

### Known gaps that are NOT bugs to rediscover

1. **REQ-13's headline acceptance now passes** (two back-to-back uninstalls each producing a restore point, verified 6 -> 8 after System Protection was enabled). Do not re-open it.
2. **REQ-19's acceptance test has never run.** The ownership elevator works in engine and UI, but quarantining a TrustedInstaller-owned file needs a fixture that is unsafe to create on a working machine. VM pass. (`vanish-uninstaller-bdi` closed with this noted; `vanish-uninstaller-1qp` tracks VM acceptance.)
3. **Driver Store packages are listed but not removable.** Deliberate: the sweeper is Stage 11, which Rule 16 places in Standard tier, and `pnputil /delete-driver` destroys the FileRepository copy so a restore manifest would be a promise the vault cannot keep. (`vanish-uninstaller-0ng`.)
4. **The UAC accept/decline branches** of the startup elevation offer need a human at the prompt.
5. **`git push` and `bd dolt push` are blocked** by a credential mismatch: the Windows credential helper serves a `DepthWorks` token for a `QuantumMonkey` repository, giving HTTP 403. `git config user.name` is correct. Fix by clearing the stored credential (`cmdkey /delete:LegacyGeneric:target=git:https://github.com`) and re-authenticating, or by switching the remote to SSH.

---

## 🧪 Verification status

`test\run-all.ps1`, elevated, on Windows 11 build 26200: **310 passed, 0 failed** across eleven suites.

| Suite | Covers |
|---|---|
| `vault-verify.ps1` | TASK-01 vault primitives, REQ-01/REQ-02 |
| `tier-verify.js` | TASK-04, INV-2 - invokes all nine destructive channels directly |
| `vault-ipc-verify.js` | TASK-02/03, FLOW-02/FLOW-03 round trip, NFR-04 oplog |
| `phase2-verify.ps1` | TASK-06/07/08/09, incl. a real watchdog respawn control case |
| `phase3-verify.ps1` | TASK-10/12, REQ-12, Rule 15 both branches |
| `queue-verify.js` | TASK-11, every FLOW-05 transition, NFR-05 resumability |
| `phase4-verify.ps1` | TASK-13/14/15/16, plus the core-handler regression guard |
| `phase4-ipc-verify.js` | Cleaner purge/restore round trips, INV-1 |
| `force-verify.ps1` | REQ-20 detection, evidence, and reversible forced uninstall |
| `security-verify.ps1` | The three 2026-08-03 review findings, attempted as real attacks |
| `ui-interaction-verify.js` | Every dialog control hit-tested with elementFromPoint |

Unelevated, `tier-verify.js` additionally proves all nine destructive channels are rejected at the IPC boundary.

**Lesson worth carrying:** the first ten harnesses all talk to the engine or the
IPC layer and bypass the DOM. A defect that made *every dialog in the app
unclickable* - the invisible wizard overlay covering the elevation offer, the
unlocker and every confirmation - shipped past 280 green assertions and was
found by a human opening the app for the first time. `ui-interaction-verify.js`
exists to close that class: it hit-tests real controls rather than checking that
markup exists. When adding UI, add a hit test, not a render check.

This is one development machine, not a clean VM. Three real defects were found by these tests that code review did not catch:

* a `REG_MULTI_SZ` DisplayName arriving as an array, which emptied the entire application list;
* an association cleaner that proposed deleting `exefile`, `batfile` and `cmdfile` - the handlers that let Windows launch anything - because `"%1"` placeholders were misread as missing targets;
* shell extensions registered only in the 64-bit view reported as orphaned during the 32-bit pass.

That is the argument for running the suite on the VMs rather than trusting the green number here.

---

## 🗂️ Repository hygiene

* `scratch/` is gitignored and holds only `NtSuspendProcess-Sketch.ps1`, the Antigravity reference sketch cited by OPEN-01 in bd. Dev scaffolding built during implementation (offscreen screenshot harnesses, a stub IPC preload, icon proof sheets) has been removed; it was throwaway and is trivially rebuilt.
* `.agent/` and `test_export.json` are tooling and research residue, now gitignored rather than deleted - `test_export.json` is the raw winget export from the OPEN-02 session, whose findings already live in bd and `corrections.json`.
* Work is committed on branch `feat/core-tier-stages-3-6-9`, off `master`, per the `01-trd.md` git convention.
