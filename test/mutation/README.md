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

## What 29/29 does NOT mean

It does not mean the suite is complete. It means these 29 specific defects are
caught. Read the number as a floor on assertion quality in the areas probed,
never as coverage.

Not probed at all yet: most of `scanner.ps1`'s 8,400 lines -- registry
enumeration, the reclaim finders' size arithmetic, process and network
attribution, the uninstall and force-uninstall flows, most of the renderer.

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

Those four are deliberately **not** in `mutants.json`. Equivalent mutants can
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
