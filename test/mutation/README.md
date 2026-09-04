# Mutation testing

```
node test/mutation/run-mutants.js
```

Plant a real defect in product code, run the suite that should catch it, record
whether it did. Restores the file afterwards, including on crash.

## Why

On 2026-09-03 this repository had 2,235 assertions and no way to say which of
them were load-bearing. Almost all had only ever been observed *passing*, and a
test that has never failed proves nothing. The first run found three assertions
that could not fail at all -- one of them the accumulator behind the product's
headline sentence (`totalBytes` -> "You can reclaim X GB").

## What 60/60 does NOT mean

It does not mean the suite is complete. It means these 60 specific defects are
caught. Read the number as a floor on assertion quality in the areas probed,
never as coverage.

Not probed at all yet: most of `scanner.ps1`'s 8,500 lines -- registry
enumeration, the reclaim finders' size arithmetic, process and network
attribution, the uninstall and force-uninstall flows, most of the renderer.

A THIRD ANCHOR TRAP, found 2026-09-04. `main.js` gained a second path-shape
check (`parseLocalDirectory`, mp31) that copied a line verbatim from
`parseDisplayIcon`. The s4cx mutant's anchor then matched TWICE and the harness
reported ANCHOR MISS - correctly, and loudly, which is why it is a trap and not
a defect. Anchor on enough context to stay unique, and re-run the whole set
after adding code near an existing anchor rather than only the new mutants.

## A killed run used to leave the mutant behind

On 2026-09-04 a run was killed by its wrapper timeout with a mutant planted.
The `finally` never ran - a hard kill does not unwind - and what it left in the
working tree was the SEC-2 mutant: `Test-ProtectedDestination` no longer
resolving junctions, which is the privilege-escalation guard the session before
had just added a test for. `git status` caught it a minute later, but "caught
because someone remembered to look" is not a control.

The restore is journalled now. Before a file is mutated its original bytes go
to `.in-flight.bak` with an `.in-flight.json` naming the target; both are
removed only after the file is put back, and any run repairs a leftover before
doing anything else and says REPAIRED loudly when it does. SIGINT, SIGTERM and
an uncaught throw restore immediately as well - the journal is for the kill
that gives no chance to.

The repair was verified by reproducing the failure rather than by reasoning
about it: plant that same mutant, write the journal, do not restore, then run
the harness with an empty mutant list and check the file comes back
byte-identical.

Still worth a `git status` after any interrupted run. The journal covers the
case it knows about; it cannot cover a disk that filled up mid-write.

## A survivor is not automatically a gap

Check every survivor by hand before writing an assertion for it. Of the seven
survivors in the first scanner/vault pass, **one** was a real gap. The rest:

| Survivor | Actually |
|---|---|
| `..\..\System32` path escape | **Equivalent.** `Resolve-SafeVaultPath` has two independent guards; the containment check alone still refuses. Proven against the real function. |
| containment check removed | **Equivalent.** The `..` regex alone still refuses. |
| Program Files off the blocked list | **Equivalent.** `$env:ProgramW6432` is *also* `C:\Program Files` on a 64-bit machine, so the path stays blocked. A real test of that list must remove both. |
| Rule 3 tier gate on quarantine | **Unreachable in an elevated run.** The assertion exists in `vault-verify.ps1` but sits behind `if (-not $isAdmin)`. This is `pnor`, demonstrated rather than argued: disabling the guard that prevents destructive operations in Audit Mode was noticed by nothing, because the test that notices cannot run elevated. |
| non-UUID entry id | **Harness error.** The assertion is in `security-verify.ps1`, and the mutant named `vault-verify.ps1`. |
| never-touch never refuses | **Harness error.** The assertion is `finder-contract-verify.ps1:192`. |
| UNC install location dated anyway (mp31) | **Equivalent.** `Get-InstallFolderCreated` refuses a UNC path explicitly AND refuses anything not rooted at a drive letter, and the second rule runs first - before any filesystem call. Removing the UNC line changes neither the answer nor the cost. The line is kept as intent and the doc comment now says it is redundant instead of presenting it as the protection. |
| UNC in lib/path-shape.js (lr9d) | **Equivalent, again, and this time in the shared predicate.** Deleting the explicit UNC line changes nothing: "\\" is not "X:", so the drive-letter rule already refuses it. Same redundancy as the mp31 row above, reproduced when the rule was consolidated. The line is KEPT as stated intent and its comment now says it is redundant - the defect was never the line, it was a comment implying it was the protection. |
| main process stops annotating (lock/acl) | **Mis-aimed by me.** The suite it named calls annotateLockFailures DIRECTLY, so mutating lib/vault.js cannot reach it. Dropped rather than re-aimed: the renderer half is covered by that suite's negative control, and the vault half would need a suite that runs a real quarantine. Recorded as a known coverage edge rather than a fake mutant. |
| junction skipped in the size walk (mp31) | **Mis-specified mutant, corrected rather than dropped.** Deleting the skip could not fail: Node reports a junction as isSymbolicLink() and NOT isDirectory(), so the entry fell to the statSync branch and added nothing measurable. The defect worth guarding is the walk DESCENDING into it, so the mutant now pushes it onto the stack instead of merely un-skipping it. |

The equivalent ones are deliberately **not** in `mutants.json`. Equivalent mutants can
never be killed, and keeping them would make the kill rate permanently
misleading in the other direction.

**Aim each mutant at the suite that actually covers the code, verified, not
guessed.** Three of seven "gaps" in the first pass were mis-aimed mutants. A
misaimed mutant reports `SURVIVED` and is indistinguishable from missing
coverage, so an unaudited mutation report is itself a source of false findings.

**Test the real function, not a replica of it.** While investigating the path
escape a JS reimplementation of `Resolve-SafeVaultPath` reported an escape that
the real PowerShell function refuses. Replicating logic in order to test it is
the mirror-drift defect this codebase keeps rediscovering.

## The one real gap this found

`Test-ProtectedDestination` resolves junctions in two separate loops. The
existing SEC-2 test proved the **Start Menu** loop resolves. Nothing proved the
**drive-root** loop did:

```
probe      <temp>\rootlink\planted.dll     (junction -> C:\)
resolved   C:\planted.dll
unmutated  protected = True
MUTATED    protected = False               <- caught by nothing
```

`C:\planted.dll` is the bare-path and DLL-search-order planting shape that rule
exists to refuse. Closed in `security-verify.ps1`.

## Adding a mutant

Entries in `mutants.json` are `{ label, file, find, replace, suite }`. `find`
must match exactly once, written with `\n` line endings -- the harness
normalises CRLF before matching and restores the original bytes afterwards, so
mutants never have to care which the file uses.
