# Sandbox verification checklist

Runs inside Windows Sandbox (fresh Windows 11 image every launch, discarded
on close, no risk to the host). Launch it from the host with:

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\start-sandbox.ps1
```

The sandbox auto-runs `npm test` and opens this file.

Use the script rather than double-clicking `vanish-sandbox.wsb` (0kp). A `.wsb`
stores absolute host paths, so the checked-in copy goes stale the moment the
checkout moves -- and it did, from `D:\quickhelp projects\vanish-uninstaller`
to `D:\quickhelp\vanish-uninstaller`, which left the sandbox silently unable to
start. `start-sandbox.ps1` resolves the repo root and your host's Node install
at run time and generates the config; add `-GenerateOnly` to print the paths
and write the file without booting the VM.

Note the sandbox path deliberately contains a space
(`Desktop\test folder\vanish-uninstaller`). That is section 1's coverage and
does not depend on where the repo sits on the host.

This covers everything in the backlog that only needed "a human at a UAC
prompt" or "a clean machine" -- it does NOT cover Windows 10 (Sandbox always
mirrors the host OS version, which is Windows 11). TASK-17 needs a separate
Win10 pass; see the note at the bottom.

Sections in order: 0 (jhh, do first) -> 1 (69a) -> 2 (kt0) -> 3 (1qp) -> 3b
(udu) -> 3c (dmu) -> 3d (bfh.2) -> 3e (9sy) -> 4 (0xt, Win11 half).

In the sandbox PowerShell window, `npm start` launches the app
(`node_modules\.bin\electron.cmd .` if `npm start` doesn't resolve).

---

## 0. vanish-uninstaller-jhh -- packaged portable exe: elevated relaunch (P0, do this first)

The bug this checks for was real, reported by the operator on 2026-08-07, and
fixed in commit `e00f252` (`main.js` `attemptElevatedRelaunch`): clicking
"Restart as administrator" produced a correctly-sized, correctly-coloured
window with **no content** - background painted, `index.html` never rendered.

Root cause was specific to the PACKAGED PORTABLE build: it relaunched
`process.execPath`, which for a portable exe is a temp-extracted copy that can
be cleaned up mid-relaunch. `npm start` (source, unpackaged) cannot reproduce
this - `PORTABLE_EXECUTABLE_FILE`, the environment variable the fix now
prefers, is only set when running the real packaged exe. **This is why this
item exists separately from item 1 below**, which only ever exercised source.

The sandbox setup script prints whether a packaged build is present in `dist\`
and how fresh. If it says none is present, run `npm run dist:portable` on the
**host** first (outside the sandbox) and relaunch the sandbox.

- [ ] Launch `dist\Vanish-*-portable.exe` directly (not `npm start`) inside
      the sandbox, unelevated.
- [ ] Click "Restart as administrator" (the FLOW-01 banner/button). Accept
      the UAC prompt.
      -> Expect: the elevated window shows the real app - sidebar, program
      list, everything - not a blank navy rectangle. Exactly one instance
      running once the old one exits.
- [ ] If it is still blank: `did-fail-load` now shows an error dialog
      instead of failing silently (part of the same fix). Copy its exact
      text into this checklist's notes - that is the next diagnostic step,
      not a guess.

Record result in `bd show vanish-uninstaller-jhh` notes, then
`bd close vanish-uninstaller-jhh --reason="..."` if it passes.

## 1. beads-69a -- elevated relaunch UAC branch on a spaced path (source build)

Path already contains a space (`test folder`) -- that's done for you.

- [ ] **Accept branch**: launch unelevated (`npm start`). Click the FLOW-01
      "Restart as administrator" banner/button. Accept the UAC prompt.
      -> Expect: an elevated instance starts, the unelevated one exits,
      exactly one instance running.
- [ ] **Decline branch**: launch unelevated. Click restart-as-admin. When
      UAC appears, click **No**.
      -> Expect: stays in a working Audit Mode. No crash, no exit.
- [ ] **Cancel branch**: launch unelevated. Click restart-as-admin, then
      dismiss the UAC prompt with Esc / the X button.
      -> Expect: same as decline -- Audit Mode, no crash, no exit.

Record result in `bd show vanish-uninstaller-69a` notes, then
`bd close vanish-uninstaller-69a --reason="..."` if all three pass.

## 2. beads-kt0 -- startup elevation toggle actually elevates

- [ ] Launch unelevated. Open Settings, enable "Start Vanish as
      administrator". Close the app.
- [ ] Relaunch (`npm start` again, or the desktop/start-menu path if you
      set one up). UAC should appear **before any window is shown**.
      Accept it.
      -> Expect: elevated instance starts, no unelevated window ever
      flashes on screen.
- [ ] Repeat, this time decline/cancel UAC.
      -> Expect: falls through to a working Audit Mode, same as always.
- [ ] Turn the toggle back off, confirm a normal launch no longer prompts.

Record result and close `vanish-uninstaller-kt0` if all pass.

## 3. beads-1qp -- Force Uninstall against a real broken app

Chrome is installed automatically by `sandbox-setup.ps1` (winget, silent) --
7-Zip was the original suggestion but uninstalls too cleanly to exercise
leftover-scan/quarantine meaningfully. Confirm it landed before starting:

- [ ] Chrome shows up in Programs and Features (check the setup window's
      output too, in case winget wasn't available in this Sandbox image and
      it fell back to a direct download -- or failed both ways, in which
      case install anything real by hand before continuing).
- [ ] Manually delete its uninstaller executable (find the path from its
      registry uninstall string, delete the .exe, leave the registry
      entry).
- [ ] In Vanish (elevated), confirm the app is detected as broken
      *without you naming it* -- it should surface via the missing-
      uninstaller signal, not a hardcoded list.
- [ ] Force-uninstall it. Confirm it disappears from Programs and
      Features.
- [ ] Restore it from the vault. Confirm it reappears in Programs and
      Features.

Record result and close `vanish-uninstaller-1qp` if all pass.

## 3b. vanish-uninstaller-udu -- left-over Store app data, purge and restore

The sweep itself is covered by automated tests on both real and planted data.
What no harness can cover is the elevated round trip against a REAL Store app
you removed yourself, on a machine where nothing was planted.

The sandbox installs Chrome via winget; any Store app works as well. If the
sandbox has no Store app worth removing, install one from the Store first.

- [ ] Launch elevated (Full Mode). System Clean -> "Left-over Store app
      data" -> Scan.
      -> Expect: a finished count, not a spinner; the section explains what
      it held back (folders touched in the last 7 days, and sandboxes that
      were never packages).
- [ ] Read every row before ticking anything. **Cross-check one**: copy the
      package family name out of the evidence line and run
      `Get-AppxPackage -AllUsers <name>` in PowerShell.
      -> Expect: nothing returned. A row naming a package that IS installed
      is a P0 bug, not a note -- `bd create` it immediately.
- [ ] Confirm any row whose family starts `Microsoft.Windows`, `windows.` or
      a framework name is listed but **cannot be ticked**.
- [ ] Tick one real leftover, note its size, Move selected to quarantine.
      -> Expect: the folder is gone from `%LOCALAPPDATA%\Packages`, the
      Quarantine tab holds an entry naming "Left-over Store app data".
- [ ] Restore that entry from the Quarantine tab.
      -> Expect: the folder is back at its original path with its contents
      intact (`Get-ChildItem -Recurse` it and compare).

Record result in `bd show vanish-uninstaller-udu` notes.

## 3c. vanish-uninstaller-dmu -- the three startup actions, live

`test/network-verify.ps1` and the unelevated real-data pass cover everything
that does not write: refusal by tier, refusal of anything outside each verb's
own surface, the button rendering inert in Audit Mode. What has not run is any
of the three verbs actually writing something and actually putting it back.

- [ ] Launch elevated. Health Advisor -> Startup Items.
- [ ] **Registry remove**: pick any row whose Source is `Registry` (not one
      you rely on -- planting a throwaway one first is fine:
      `New-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name VanishSandboxTest -Value notepad.exe`).
      Click its action button, confirm the dialog, confirm it.
      -> Expect: the value is gone from the registry
      (`Get-ItemProperty HKCU:\Software\...\Run` no longer lists it) and a
      new entry named "Startup entries" appears in the Quarantine tab.
- [ ] Restore that entry from Quarantine.
      -> Expect: the value is back, byte-identical
      (`(Get-ItemProperty ... -Name VanishSandboxTest).VanishSandboxTest`
      reads `notepad.exe` again).
- [ ] **Service to manual**: pick a non-Microsoft auto-start service row.
      Click its action, confirm.
      -> Expect: `(Get-Service <name>).StartType` reads `Manual`, the
      service itself is untouched (still installed, can still be started),
      and a "Startup services" entry appears in Quarantine.
- [ ] Restore it.
      -> Expect: `StartType` is back to `Automatic`.
- [ ] **Task disable**: pick a scheduled-task row. Click Disable.
      -> Expect: `(Get-ScheduledTask -TaskName <name>).State` reads
      `Disabled`. No Quarantine entry -- disabling is reversible in place,
      nothing was exported.
- [ ] Click the same button again (now labelled Enable).
      -> Expect: `State` is back to `Ready`.

Record result in `bd show vanish-uninstaller-dmu` notes, then
`bd close vanish-uninstaller-dmu --reason="..."` if all three round trips
pass.

## 3d. vanish-uninstaller-bfh.2 -- network hold, applied and released

The one item on this list that needs you to kill the app on purpose. Capture
is written to disk *before* anything changes specifically so this is safe to
test destructively.

- [ ] Launch elevated. Health Advisor -> Network activity -> Hold.
      -> Expect: the confirm dialog names what changes (Delivery
      Optimization capped, running background transfers paused) and what it
      cannot do (no more speed, nothing about other devices).
- [ ] Confirm. 
      -> Expect: the row turns to "Background transfers are being held",
      naming how many transfers were paused (0 is a valid, expected answer
      if nothing was mid-download).
- [ ] Check the machine directly:
      `Get-ItemProperty HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization -Name DOPercentageMaxBackgroundBandwidth`
      -> Expect: `1`.
- [ ] **Kill Vanish while the hold is on** -- Task Manager, End Task (or
      close the sandbox's PowerShell window if that's what's running it).
      Do not use the in-app Release button first.
- [ ] Relaunch Vanish elevated.
      -> Expect: within a few seconds of startup, re-run the registry check
      above -- `DOPercentageMaxBackgroundBandwidth` should be gone entirely
      (it did not exist before the hold, so revert deletes it rather than
      zeroing it), or the policy key itself should be gone if Vanish created
      it. The Network activity row should show "Hold background transfers"
      (off), not the held state.
- [ ] Check the oplog for a `network-release-stale` entry:
      `Get-Content (Join-Path $env:APPDATA "vanish\oplog.jsonl") -Tail 5`
      (adjust the path if `set-oplog-path` in Settings shows a different one)
      -> Expect: one line with `"action":"network-release-stale"` and
      `"outcome":"success"`.
- [ ] Repeat the whole sequence once more, this time using the in-app
      **Release** button instead of killing the app.
      -> Expect: same end state, immediate rather than on next launch, toast
      confirms "Every setting is back where it was."

Record result in `bd show vanish-uninstaller-bfh.2` notes, then
`bd close vanish-uninstaller-bfh.2 --reason="..."` if both the crash-recovery
and the normal-release paths restore the machine exactly.

## 3e. vanish-uninstaller-9sy -- elevated `npm run verify`

One command, and it re-checks most of the sections above from a different
angle (the real renderer against the real backend, not manual clicking). Run
it after 3c and 3d rather than before -- it is more useful once the machine
has some real startup/network state to look at.

- [ ] From the elevated PowerShell window: `npm run verify`
      -> Expect: ends with `Result: N passed, 0 failed`. The prior recorded
      run was 148/0 on a smaller suite; today's suite is 177 assertions
      unelevated, so this elevated number will be higher -- record whatever
      it actually says, not the old number.
- [ ] Read anything under "Not verified by this run" at the end -- that
      section is supposed to shrink now that this is an elevated pass.

Record the pass/fail count in `bd show vanish-uninstaller-9sy` notes, then
close it.

## 4. TASK-17 (Win11 half only) -- vanish-uninstaller-0xt

Full spec: `docs/planning/05-implementation-plan.md` TASK-17. This
sandbox pass can close the Win11 half; Win10 still needs a separate VM
(see note below). Black-box only -- exercise the app, don't read source.

- [ ] **M3**: fresh unelevated launch lands in a functional Audit Mode
      with the elevation banner visible. No crash.
- [ ] Walk each phase's acceptance check from
      `docs/planning/05-implementation-plan.md` (TASK-01 through TASK-16)
      as a real user: plant/observe real state, exercise the flow, confirm
      vault + restore + oplog behave as documented. A failed check is a
      bug ticket (`bd create`), not a note.
- [ ] **M4**: queue 5 real apps for bulk uninstall, run unattended. Confirm
      it completes except where an uninstaller itself isn't silent.
- [ ] **NFR-03 benchmark**: with Task Manager/Process Monitor tab open,
      confirm refresh interval and CPU usage, then record a measured
      row into `docs/BENCHMARKS.md` with the Rule 9 fields (CPU model,
      RAM, storage type, installed-app count, Windows version/build,
      cold or warm run). Sandbox specs: shares the host's CPU/RAM: **fill
      in your actual host hardware**, storage = host's, Windows build =
      `winver` inside the sandbox.
- [ ] Fill a results row into `docs/planning/reviews/vm-test-log.md`
      (create it from the TASK-17 Verify block if it doesn't exist) marked
      `Windows 11 (Sandbox)`.

**Do NOT close vanish-uninstaller-0xt from this pass alone** -- it explicitly
requires both Win10 and Win11. Once this Win11 pass is green, tell me and
I'll split it (17a..17d per the task's own instructions) or file a
Win10-specific follow-up so the Win11 work isn't lost waiting on Win10.

---

## Win10 gap

Windows Sandbox always mirrors the host OS (Windows 11 here) -- there is no
Windows 10 Sandbox. Closing TASK-17 fully still needs an actual Windows 10
VM (Hyper-V + a Win10 ISO, or any other hypervisor). That's a bigger, separate
ask -- flagging it rather than assuming you want it set up too.
