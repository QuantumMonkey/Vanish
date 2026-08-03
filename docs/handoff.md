# Vanish: LLM Handoff Specification
> [!NOTE]
> This handoff document is formatted for LLM ingestion to resume project development seamlessly when token limits are reached or context is rotated.

---

## 📌 Project Overview
Vanish is a modern Windows application manager and deep cleaner uninstaller. It is built as an Electron desktop app executing an asynchronous PowerShell backend. It replaces outdated uninstaller utilities with a high-performance, glassmorphic UI, UWP support, automatic restore point checkpoints, three remnant scanning modes (Safe, Moderate, Advanced), and a quarantine vault that makes every removal reversible.

* **Repository Location**: `https://github.com/QuantumMonkey/Vanish`
* **Status**: **Core tier code complete, VM verification outstanding.** All of the Core roadmap (Stages 1, 2, 3, 6, 9) plus the Rule 2/3 safety retrofits are implemented and pass a 220-assertion local suite. Per Rule 10 that is **In Progress**, not Complete — see the release gate below.

---

## 📁 File Structure Map

* **[package.json](../package.json)**: Scripts, configuration, and Electron (`^42.5.0`) dependency. *(Status: Complete)*
* **[main.js](../main.js)**: Host window container, window controls, and the whole IPC surface. Owns the elevation tier (resolved once at startup, cached) and the `fullModeOnly()` wrapper that rejects every destructive channel in Audit Mode. Owns the queue runner wiring and the System Clean purge routing. *(Status: Complete — phases 1-4 functional)*
* **[preload.js](../preload.js)**: Exposes the secure IPC bridge to the renderer world; one entry per channel, no raw `ipcRenderer` exposure. *(Status: Complete)*
* **[lib/store.js](../lib/store.js)**: Single writer for `manifest.json`, `settings.json`, `queue.json` and `oplog.jsonl` under the Electron userData path. Atomic writes (temp file + rename), schema defaults, oplog rotation at 5 MB. Implements ENT-01..ENT-05. *(Status: Complete)*
* **[lib/vault.js](../lib/vault.js)**: The quarantine pipeline — quarantine, list, restore, delete-forever, and the retention auto-purge sweep. Every destructive file/registry operation in the app funnels through here (INV-1). *(Status: Complete)*
* **[lib/queue.js](../lib/queue.js)**: Bulk uninstall state machine (FLOW-05), persisted to disk on every transition. Takes its engine runner by injection, which is how the state machine is unit-tested without uninstalling anything real. *(Status: Complete)*
* **[index.html](../index.html)**: Titlebar, Audit Mode banner, dashboard, application table, details sidebar, uninstall wizard overlay, Health Advisor panel, and the Quarantine / Task Manager / System Clean panels plus the queue panel and shared dialogs. Carries the Content-Security-Policy. *(Status: Complete)*
* **[index.css](../index.css)**: Glassmorphic dark styling. Core variables, the Stage 2 audit styles, and the phase 1-4 additions (tier banner, panel chrome, vault entries, process table, cleaner sections, queue panel, modals, toasts). Honours `prefers-reduced-motion`. *(Status: Complete)*
* **[renderer.js](../renderer.js)**: UI controller. Tier state and destructive-control locking, tab routing, app list, uninstall wizard, quarantine manager, process monitor, unlocker, System Clean cleaners, and the queue panel. All interpolation is HTML-escaped. *(Status: Complete)*
* **[scanner.ps1](../scanner.ps1)**: System execution engine, one `-Action` dispatcher (D-04). Stage 1-2 functions plus: the quarantine vault primitives, Restart Manager and `NtSuspendProcess` interop, the process/indicator sampler, the Rule 15 switch resolver, the uninstaller runner, `msiserver` management, the explicit registry-view helpers, and all six cleaners. *(Status: Complete)*
* **[corrections.json](../corrections.json)**: ENT-03 uninstall switch corrections, read-only at runtime, community-correctable. Seeded with the OPEN-02 verified entries. *(Status: Complete — seeded, expected to grow)*
* **[test/](../test)**: Eight verification harnesses plus `run-all.ps1`. *(Status: Complete for phases 1-4)*

---

## 🚀 How to Run the App (Elevated)

Vanish runs in either tier, but cleaning and uninstallation require administrative privileges.

1. Open PowerShell or Command Prompt as **Administrator**.
2. Run:
   ```powershell
   cd path\to\vanish
   npm start
   ```

Launching unelevated is a supported path: Vanish offers to restart as administrator once, and declining lands in Audit Mode (read-only) with a persistent banner.

To run the verification suite (elevated, for the destructive paths):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1
```

---

## ✅ What changed in the 2026-08-03 session

The compliance gap flagged in the previous handoff is **closed**, and the rest of the Core checklist was implemented behind it.

* **Rule 2 (quarantine-first)** — satisfied. `Purge-Remnants` is deleted from `scanner.ps1`; there is no direct-delete path left on a user target. Files move into `vault/<entry-id>/files/<n>/`, registry keys export to `.reg` restore manifests before removal, and the only remaining outright deletes are the vault's own "Delete Forever" and the opt-in retention sweep.
* **Rule 3 (Audit Mode)** — satisfied and enforced in code, not just in the UI. Verified by invoking all nine destructive IPC channels directly while unelevated; every one is rejected by `main.js`.
* **Stages 3, 6 and 9** — implemented (see CHANGELOG for the feature-level list).

Design work produced along the way, recorded in the owning docs: the vault layout and `entry.json` durability record (`04-schema.md` D-12/D-13), and the `manifest-only` registry mode that lets the PATH cleaner rewrite a value without deleting the key it lives in.

---

## 🔍 Next Steps & Roadmap Checklist

> **Before planning, speccing, or implementing any feature**, run it through `docs/promptgate.md`. All decisions must pass the gate before work begins.

> **For Stages 6–14** (Orchestration, Network, Sandbox, Environment Clean, Enterprise Audits, Cache Purge, Telemetry, Runtime/Driver Audit, CleanerML Engine), refer to `docs/roadmap.md`. The checklist below covers Core tier stages only.

**Core Tier** (complete before any public release):

- `[x]` **Stage 2 — Audit & Health Advisor Tab**: system diagnostics (CIM), startup item enumeration, redundant software detection. *(Core — code complete)*
- `[x]` **Quarantine vault + Audit Mode enforcement**: vault engine, Quarantine Manager tab, enforced read-only tier, startup elevation offer. *(Core — code complete; the UAC accept/decline branches still need a human at the prompt)*
- `[x]` **Stage 3 — Task Manager & Unlocker**: process list with CPU/Memory/Disk, Restart Manager unlocker, passive Suspicious Activity Indicators, watchdog suspension. *(Core — code complete)*
- `[x]` **Stage 6 — Orchestration & Shell Cleanup**: bulk silent uninstall queue, context menu cleaner, msiserver manager, restore point frequency override. *(Core — code complete. Forced Uninstall for broken entries is still open.)*
- `[x]` **Stage 9 — System Integration & Environment Clean**: services purge, PATH cleaner, file association repair, multi-user profile sweep, auto-UAC relauncher, registry redirection bypass. *(Core — code complete except the driver-store removal half and the REQ-19 UI offer; both carry open bd issues.)*

Remember Rule 10: a stage is only "Complete" once manually verified on a clean Windows 10 and Windows 11 VM. Coded and passing locally is "In Progress" — this checklist and `CHANGELOG.md` say exactly that, and neither should be upgraded from code review alone.

**Standard and Extended tiers**: See `docs/roadmap.md`. Rule 16 forbids starting them until Core is VM-tested.

---

## 🚧 The release gate — what is actually left

Phase 5 of `docs/planning/05-implementation-plan.md` is the runway from "code complete" to "shipped". None of it is done.

| # | Gate | bd issue | Blocking on |
|---|---|---|---|
| 1 | VM test matrix on clean Win10 (1607+) and Win11 | `vanish-uninstaller-0xt` | Needs VMs. This is the gate that turns "In Progress" into "Complete". |
| 2 | Security audit (`/cso` full pass) | `vanish-uninstaller-vhm` | Can start now |
| 3 | `/code-review high` on destructive surfaces | `vanish-uninstaller-1td` | Can start now |
| 4 | Docs pass + demo GIF | `vanish-uninstaller-k2o` | Can start now |
| 5 | Code signing + Store submission | `vanish-uninstaller-1w0` | **Operator decision — has cost.** Do not start unprompted. |
| 6 | One real external user completes the core flow | `vanish-uninstaller-442` | Needs a signed build |

**Three things must be resolved before a public build regardless of the above:**

1. **The CDN dependency.** `index.html` still pulls FontAwesome from cdnjs and `index.css` still `@import`s Inter/Outfit from Google Fonts. That is runtime network I/O, which Rule 6 and NFR-06 forbid outright. A strict CSP with `connect-src 'none'` is in place so nothing else can leak, and the two origins are pinned — but this is a known, tracked violation, not a resolved one. Vendoring both locally (licences already checked: FontAwesome Free icons CC BY 4.0 with attribution, fonts SIL OFL, CSS MIT; Inter and Outfit both SIL OFL) is the recommended fix.
2. **REQ-19's ownership elevator** has an engine but no UI offer and no passing acceptance test.
3. **REQ-13's headline acceptance** — two back-to-back uninstalls each producing a restore point — has never actually run, because System Protection is disabled on the development machine. The assertion exists and skips loudly; it must go green on the VMs.

---

## 🧪 Verification status

`test/run-all.ps1`, elevated, on Windows 11 build 26200: **220 passed, 0 failed** across eight suites. Unelevated, the tier suite additionally proves all nine destructive channels are rejected at the IPC boundary.

This is a development machine, not a clean VM, and it is one hardware configuration. Two real defects that a code review would not have caught were found by these tests and fixed — a `REG_MULTI_SZ` application name that emptied the whole app list, and an association cleaner that proposed deleting `exefile` — which is the argument for running the suite on the VMs rather than trusting the green number here.
