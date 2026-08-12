# Vanish 1.0 -- pre-release task list

Decided 2026-08-12. This file is the release scope. If something is not in
the ship list below, it is not in 1.0, and that is a decision rather than an
oversight.

The standard applied throughout, in the operator's words: *solve problems
that are not solved, use existing tools where possible, integrate existing
FOSS where necessary, do not build redundant nonsense.* Vanish exists
because this category is gatekept and commodified. A feature that duplicates
something the user already has is not neutral -- it is us becoming the thing
we objected to.

---

## Cut permanently

Not deferred. Decided against, with the reason, so no future session
re-litigates them from scratch.

| Item | Why it is cut |
| --- | --- |
| `0ng` Driver Store sweeper | `pnputil` ships with Windows and Disk Cleanup already offers "Device driver packages". Worse, INV-1 **cannot** be honoured: `pnputil /delete-driver` destroys the FileRepository copy, so a restore manifest would be a promise the vault cannot keep. Building a removal that breaks our own foundational invariant, to duplicate a built-in tool, is the exact anti-pattern. The audit-only half already ships and is the honest version. |
| `dfe` WMI/DCOM orphans, event-log channels | P4, no committed timeline, no user-visible value, and Rule 17 would gate it behind mandatory per-item review anyway. Nobody has reported having this problem. |
| A removal engine for Windows Updates | See `ag0` below. The *list* is worth building; re-implementing `wusa`/DISM is not. |
| A read-only bandwidth panel | Task Manager and Resource Monitor both show per-process network, and our own Network Activity panel (`bfh.1`) already does attribution. Only the **hold** survives. |
| A treemap / "what is big" view | WinDirStat, WizTree, TreeSize and Windows' own Storage page all answer this. See `bu2` -- we build the half they all stop short of. |
| Hand-written cleaner definitions | BleachBit maintains hundreds in CleanerML and has for years. See `7sl` -- we bring the vault, not a second catalogue. |

## Waived for this release

Not wrong as gates. Waived by a deliberate call about who this release is
for, with the cost recorded.

| Item | Status | Cost of skipping, accepted knowingly |
| --- | --- | --- |
| `0xt` clean Win10/Win11 VM matrix | Closed | Win10-specific and clean-machine breakage (missing runtimes, different UAC defaults, no dev tooling present) ships undetected. Sandbox plus daily operator use is the acceptance bar. |
| `1w0` code signing + Store | Deferred | An unsigned exe trips SmartScreen's "Windows protected your PC" on any machine but this one. Matters the moment there is a second user. |
| `442` one external user | Deferred | The operator is the user for 1.0. |

---

## Ship list, in order

### Phase 0 -- unblock (operator, ~30 seconds)

- [ ] **`9rv`** Elevation round trip on real hardware: toggle startup-elevation
      off, **Restart now**, then **Restart as administrator**. `6lg`'s
      instrumentation is live and this machine's storage persists, so this
      yields either a clean instrumented pass or the first real
      `relaunch-elevated-mismatch` record ever captured. This is the only
      genuinely stuck item; everything else is unblocked.

### Phase 1 -- build (the two that carry the product story)

- [ ] **`zrw`** Install snapshot diff. Snapshot Run-key hives and top-level
      Program Files / AppData before and after a monitored install, report the
      delta as real numbers. Reuses Stage 1's existing restore-point trigger.
      **First on purpose**: small, genuinely unserved (InstallWatch and ZSoft
      are dead and nothing replaced them), and it produces *ground truth*
      about which paths belong to which program -- the input the next item
      otherwise has to guess at.

- [ ] **`bu2`** Size attribution. Enumerate via the NTFS MFT
      (`FSCTL_ENUM_USN_DATA`, documented API; standard directory walk as the
      fallback for non-NTFS, network, and Audit Mode), then join against the
      installed-programs map, `corrections.json`, and `zrw`'s recorded deltas.
      Output is not a treemap: it is "12.4 GB, last written March, belongs to
      a program that is no longer installed", quarantine-able through the
      existing vault. No auto-proposed deletions, no one-click clean.

### Phase 2 -- safety and honesty gates (must not ship without)

- [ ] **`1td`** Security review, high, on the destructive surfaces.
- [ ] **`vhm`** Full `/cso` audit pass.
- [ ] **`8ns`** Platform-wrapped games (Steam, Epic) need their own "needs
      attention" message in the bulk queue. The current generic "retry the
      silent switch" text can never work against `steam.exe`, so today the app
      tells the user to do something that cannot succeed. Design is already
      written up in the issue.
- [ ] **`k2o`** Docs pass: README, CHANGELOG, ARCHITECTURE. The demo GIF needs
      a human to record it.

### Phase 3 -- live verification (operator, Windows Sandbox)

All six are "does this actually work when elevated", and all six have been
blocked behind the same sandbox flakiness. Do them in one sitting once
Phase 0 settles what that flakiness actually was.

- [ ] `69a` elevated relaunch UAC branch on a spaced path
- [ ] `9sy` elevated `test/real-data-verify.js`
- [ ] `dmu` three startup actions elevated (remove / manual / disable)
- [ ] `e7q` Store-leftover sweep purges and restores a real folder
- [ ] `bfh.2` network hold applies and fully reverts
- [ ] `1qp` Force Uninstall acceptance

### Phase 4 -- cut the release

- [ ] `npm test` green; build both artifacts; verify the packaged output the
      way every build this cycle was verified -- extract `app.asar` and diff
      the renderer/main sources against source, sha256 `scanner.ps1` and
      `corrections.json`.
- [ ] Version bump, CHANGELOG release section, tag, push.
- [ ] Known-limitations note in the README covering the three waived gates:
      unsigned binary, no clean-VM pass, single-user acceptance.

---

## Post-1.0, in the order they earn their place

1. **`7v3`** Orphaned MSI/MSP installer cache (1.2 GB measured 2026-08-02).
   The first finding type to run through `bu2`'s attribution pipe rather than
   getting its own panel. What we add over PatchCleaner is the vault.

2. **`7sl`** CleanerML adapter. Ship an MIT parser; consume definitions the
   user already has (an installed BleachBit, or a folder they point at).
   **Never vendor the definitions** -- BleachBit is GPL-3.0 and CleanerML
   definitions are GPL-3.0+, this repo is MIT and public. `INV-4` forbids
   fetching them over the network anyway. Every commodity cleaner deletes;
   nobody offers reversible cleaning, and that is the whole contribution.

3. **`ag0`** Windows Update: a legible list (`Get-HotFix` + DISM
   `/Get-Packages`, read-only) showing type, install date, and whether the
   update is removable at all -- then hand off to `wusa.exe /uninstall` or the
   Settings page for the actual removal. We never own that removal, and the UI
   must not imply we can reverse it.

4. **`be8`**, **`ztl`** Firewall-rule orphans, SharedDLLs dead references,
   ghost PnP devices. Cheap finding types on a scan surface that is already
   open. They free zero bytes; ship them when the surface is open anyway,
   never as their own project.

5. **`bfh`** narrowed to the hold only (`bfh.2` is already built).

6. `qyt`, `5b0`, `h55`, `bcu`, `ht8` -- quality-of-life, no ordering
   constraint between them.

---

## The through-line, for whoever picks this up

Vanish has exactly three assets nothing else in this category has:

1. the installed-program map (`scanner.ps1` + `corrections.json`),
2. the quarantine vault with a real restore path (INV-1),
3. the tier and consent model -- it refuses by name, with a reason.

Every feature worth building is leverage on one of those three. A feature
that touches none of them is commodity, and somebody else already maintains
a better version of it for free.
