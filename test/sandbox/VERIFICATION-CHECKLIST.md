# Sandbox verification checklist

**Rewritten 2026-08-19.** Six of this file's nine sections were closed, and three
more are now covered by automated elevated runs. Working through the old version
would have cost about an hour of redundant clicking. **Three items are actually
left**, and they are below.

Runs inside Windows Sandbox (fresh Windows 11 image every launch, discarded on
close, no risk to the host). Launch it from the host with:

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\start-sandbox.ps1
```

Use the script rather than double-clicking `vanish-sandbox.wsb` (0kp). A `.wsb`
stores absolute host paths, so the checked-in copy goes stale the moment the
checkout moves -- and it did, which left the sandbox silently unable to start.
`start-sandbox.ps1` resolves the repo root and your host's Node install at run
time; add `-GenerateOnly` to print the paths without booting the VM.

The sandbox path deliberately contains a space
(`Desktop\test folder\vanish-uninstaller`). That is section 1's coverage and
does not depend on where the repo sits on the host.

---

## Time and attention, honestly

| Phase | Wall clock | Your attention |
| --- | --- | --- |
| Sandbox boots, maps folders, runs `npm test` | 15-25 min | **none** - walk away |
| Sections 1 and 2 are HOST work, not sandbox work - see the note below | | |
| Section 1 (`69a`) - three UAC branches | ~6 min | ~6 min, all of it |
| Section 2 (`adg`) - piggybacks on section 1 | ~2 min | ~2 min |
| Section 3 (`1qp`) - install Chrome, break it, force-uninstall | ~20 min | ~8 min (the rest is a download and an installer) |
| Collect the report and paste it back | ~1 min | ~1 min |

**Roughly 45 minutes wall clock, of which about 17 minutes needs you at the
screen.** Sections 1 and 2 are the ones with UAC prompts. Section 3 has one UAC
prompt and a lot of waiting.

If you only have fifteen minutes, do sections 1 and 2. They are both P1 and they
are the only two things standing between the elevation work and "done"; `1qp` is
P2 and is acceptance for a feature that already passes its automated tests.

---

## Before you start

1. **Turn UAC back on** (you offered - it is genuinely needed for sections 1 and
   2, which test the consent branches themselves). Any level that prompts is
   fine; the default is fine.
2. On the **host**, confirm a fresh build exists: `dist\Vanish-0.8.0-portable.exe`.
   The sandbox setup script prints whether it found one and how old it is.
3. Launch the sandbox with the command above and let `npm test` finish. Expect
   **973 passed, 0 failed** with three suites reporting NOT RUN (they need an
   elevated shell and the sandbox session starts unelevated - that is correct,
   not a failure).

---

## !! Sections 1 and 2 CANNOT be done in the sandbox !!

**Corrected 2026-08-19, from the operator's own report.** The Windows Sandbox
image runs `WDAGUtilityAccount` as an administrator **with UAC switched off** -
measured, `EnableLUA = 0`. So Vanish always starts in Full Mode there, the Audit
Mode banner never renders, and the button these two sections are about is never
on screen. An earlier version of this file sent the operator into the sandbox to
do exactly that, which was wrong.

**Do sections 1 and 2 on the HOST**, with UAC on, launching the portable exe
unelevated. The host path has no space, and `69a` is specifically about a spaced
one, so copy the exe somewhere spaced first - the portable build is
self-contained and `PORTABLE_EXECUTABLE_FILE` is its own location, which is
exactly what the relaunch path reads:

```
$dest = "$env:USERPROFILE\Desktop\test folder"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "D:\quickhelp\vanish-uninstaller\dist\Vanish-0.8.0-portable.exe" $dest
```

Then double-click it from that folder - do NOT run it from an elevated shell,
because the whole point is to start unelevated and watch it elevate itself.

Section 3 (`1qp`) is the opposite: it wants the throwaway machine, so do that one
in the sandbox.

---

## 1. `69a` -- the elevated relaunch, on a path with a space (P1)

This is the last of the six elevated confirmations. It cannot be automated and
it cannot be done from an already-elevated session: `attemptElevatedRelaunch`
returns `alreadyElevated` and never reaches the code under test. It needs an
**unelevated start**, which is why it was left out of the automated runner.

The sandbox maps the repo under `Desktop\test folder\...` on purpose - the space
is the thing being tested. `Start-Process -ArgumentList` builds a command line
rather than an argument vector, so an unquoted spaced path arrives at the child
as two arguments and the app silently never starts.

Run the **packaged portable exe**, not `npm start`. `PORTABLE_EXECUTABLE_FILE`
is only set for a real packaged exe, and that variable is what the relaunch path
prefers.

- [ ] **Accept branch.** Launch `dist\Vanish-0.8.0-portable.exe` unelevated.
      Confirm the chip bottom-left reads **STANDARD USER** and the Audit Mode
      banner is on screen. Click **Restart as administrator**. Accept the UAC
      prompt.
      - Expect: the app comes back with the **real UI rendered** - sidebar,
        program list, everything - not a blank navy rectangle, and the chip now
        reads **FULL MODE**. Exactly one instance running.
      - The blank-window failure was real (jhh, fixed in `e00f252`) and was
        specific to the portable build, which is why this must not be `npm start`.

- [ ] **Decline branch.** Launch unelevated again. Click Restart as
      administrator. When UAC appears, click **No**.
      - Expect: a message saying **you declined the prompt**, specifically -
        not a generic "Windows did not grant administrator rights". The app
        stays usable in Audit Mode. This is `ytv`'s work and the one cause its
        automated suite could not exercise on this machine.

- [ ] **Cancel branch.** Launch unelevated. Click Restart as administrator, then
      dismiss the UAC dialog with **Escape** rather than clicking No.
      - Expect: the same declined message, and no orphaned second instance in
        Task Manager.

---

## 2. `adg` -- does the banner's button really come back in Audit Mode? (P1)

Reported 2026-08-13: *"restart as administrator from the audit mode banner as
shown on all programs restarts as audit mode... however, using the toggle in
settings and restarting with the SETTINGS toggle now works."*

Filed with its evidence gap stated rather than a cause attached, because the
oplog corroborated neither half - there was no `relaunch-elevated` entry at all
that day, and no `app-start` with `tier=audit`. The leading hypothesis is that
this was the **same fault as the de-elevation bug** (fixed since): the app never
reached Audit Mode, so what looked like "came back in Audit Mode" was it never
having left Full Mode.

Section 1's accept branch is this test. All that is needed on top:

- [ ] Before clicking, confirm the chip reads **STANDARD USER**. If it reads
      FULL MODE, the banner should not be on screen at all - say so and stop,
      because that is a different bug.
- [ ] After the accept branch, note whether the app came back **FULL MODE** or
      **STANDARD USER**.
- [ ] Run the collector below and paste me the output. A `relaunch-elevated`
      entry with its outcome and cause is what makes this actionable either way.

If it comes back Full Mode, `adg` closes as fixed-by-the-de-elevation-work,
which is what the issue predicts.

---

## 3. `1qp` -- Force Uninstall against a genuinely broken app (P2)

The feature ships and passes 14 automated assertions. What it has never had is
one real broken entry, because a planted registry fixture is not the same thing.

Chrome is the chosen candidate: 7-Zip uninstalls too cleanly to exercise the
leftover scan meaningfully (operator note 2026-08-06), and Chrome is a known
messy uninstaller.

- [ ] In the sandbox, download and install Chrome. (This is most of the 20
      minutes and none of the attention.)
- [ ] Confirm it appears in Programs and Features, and in Vanish's list.
- [ ] Find its uninstaller path from its registry entry, and **delete the
      uninstaller executable**. That is what makes it genuinely broken rather
      than pretend-broken.
- [ ] In Vanish (elevated), confirm it is detected as broken, and that the
      panel says **why** rather than just listing it.
- [ ] Force-uninstall it. Confirm it disappears from Programs and Features.
- [ ] **Restore it from the Quarantine tab.** Confirm it reappears in Programs
      and Features. This is the half that distinguishes Vanish from every other
      tool in the category, and it is the half worth being sure about.

---

## When you are done

Run this in the sandbox and paste me what it prints:

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\collect-report.ps1
```

It gathers the tier at each launch, every elevation-related oplog entry with its
outcome and cause, the app version, and the last test summary - and nothing
else. No file contents, no personal paths beyond the ones Vanish already logs.
It prints to the console and writes the same text to a file, so either works.

---

## What is NOT on this list any more, and why

Do not work through these - they are done, and redoing them costs an hour.

| Was | Status |
| --- | --- |
| `jhh` portable elevated relaunch | CLOSED. Folded into section 1, which runs the portable exe for exactly this reason. |
| `kt0` startup elevation toggle | CLOSED. |
| `udu` Store app data purge/restore | CLOSED. Re-proved automatically 2026-08-18 with a byte-identical SHA256 restore. |
| `dmu` three startup actions | CLOSED 2026-08-18. Engine half 12/0, and a new IPC suite proves the vault half 27/0 - manifest written before the mutation, byte-identical restore, refusal changes nothing. |
| `bfh.2` network hold | CLOSED 2026-08-18, 6/6. The hold applies, reverts, and DELETES the policy value rather than zeroing it. |
| `9sy` elevated real-data pass | CLOSED 2026-08-18, 166/0 elevated - after fixing the two real defects the first run found. |
| `0xt` Win11 clean-machine matrix | CLOSED. |

## Win10 gap

Windows Sandbox always mirrors the host OS version, so this covers Windows 11
only. A Windows 10 (1607+) pass is a separate machine and remains outstanding;
it is recorded in `docs/PRE-RELEASE.md` rather than waived quietly.
