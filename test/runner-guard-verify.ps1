# hy56: the runner's own guards, tested rather than asserted in a comment.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\runner-guard-verify.ps1
#
# Runs in either tier and touches nothing but its own temp files.
#
# THREE DEFECTS IN run-all.ps1, all of the same family this repository keeps
# finding: a run that tested less than it claimed and said nothing.
#
#   1. A CRASHED SUITE DID NOT FAIL THE RUN. The exit code counted failures and
#      missing FILES, not suites that ran and died. z6k fixed this for the
#      missing-file case and left the harder one - a suite that is registered,
#      present, and printed something - reporting DarkYellow and exiting zero.
#   2. THE RUNNER LED WITH THE WRONG DIAGNOSIS. "did not report a result (needs
#      Full Mode, or it crashed)". Every registered suite prints a Result line
#      even when it skips its whole body, so it was NEVER "needs Full Mode",
#      and offering that first sent people to check their shell instead of
#      reading the log.
#   3. NO PER-SUITE TIMEOUT. Several suites document that Electron HANGS rather
#      than fails on a rejected executeJavaScript, and only nine of roughly
#      twenty-two carry a watchdog. On 2026-09-05 one of the others stalled a
#      whole run indefinitely - and passed 114/114 on its own minutes later, so
#      nothing was wrong with the suite at all. The runner had no way to give up.
#
# The timeout is the one worth testing directly, and doing so is exactly why
# Invoke-SuiteProcess was moved into test\lib\suite-runner.ps1: registering a
# deliberately-hanging suite in the real list would cost ten minutes of every
# run, and an env-var override would be a hatch that exists only for a test.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\suite-runner.ps1')

$script:pass = 0
$script:fail = 0

function Assert-True($condition, $label, $detail = '') {
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
        $script:fail++
    }
}

$work = Join-Path $env:TEMP ("vanish-hy56-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null

Write-Host ""
Write-Host "Runner guards (hy56)"
Write-Host "===================="

try {
    # ==================================================================
    Write-Host ""
    Write-Host "Premise: an ordinary suite runs and its output comes back" -ForegroundColor Cyan

    # FIRST. Every assertion below is about a suite that did NOT finish, and a
    # helper that killed everything would satisfy all of them.
    $good = Join-Path $work 'good.ps1'
    Set-Content -LiteralPath $good -Value @'
Write-Host "  PASS  something"
Write-Host "Result: 1 passed, 0 failed"
exit 0
'@ -Encoding UTF8

    $r = Invoke-SuiteProcess -exe 'powershell.exe' -argv @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $good) -timeoutSeconds 60
    Assert-True ($r.TimedOut -eq $false) "a suite that exits is not reported as timed out"
    Assert-True ($null -ne $r.ExitCode -and $r.ExitCode -eq 0) `
        "its exit code comes back ($($r.ExitCode))"
    Assert-True (@($r.Lines) -join "`n" -match 'Result: 1 passed, 0 failed') `
        "and so does its Result line, which is what the runner parses" (@($r.Lines) -join ' | ')

    # ==================================================================
    Write-Host ""
    Write-Host "A suite that writes to stderr keeps that output too" -ForegroundColor Cyan

    # Start-Process cannot merge the two streams into one file, so this is the
    # assertion that the second one is not simply dropped - which would have
    # silently lost every Node stack trace in the run.
    $noisy = Join-Path $work 'noisy.ps1'
    Set-Content -LiteralPath $noisy -Value @'
Write-Host "  PASS  on stdout"
[Console]::Error.WriteLine("a message on stderr")
Write-Host "Result: 1 passed, 0 failed"
exit 0
'@ -Encoding UTF8

    $n = Invoke-SuiteProcess -exe 'powershell.exe' -argv @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $noisy) -timeoutSeconds 60
    $nText = @($n.Lines) -join "`n"
    Assert-True ($nText -match 'on stdout') "stdout survives"
    Assert-True ($nText -match 'a message on stderr') "and so does stderr" $nText
    Assert-True ($nText -match '--- stderr ---') `
        "under a header, rather than interleaved into an order that never happened"

    # ==================================================================
    Write-Host ""
    Write-Host "A suite that hangs is KILLED, and said to have been" -ForegroundColor Cyan

    $hang = Join-Path $work 'hang.ps1'
    Set-Content -LiteralPath $hang -Value @'
Write-Host "  PASS  the part that ran before the hang"
Start-Sleep -Seconds 600
Write-Host "Result: 1 passed, 0 failed"
'@ -Encoding UTF8

    $started = Get-Date
    $h = Invoke-SuiteProcess -exe 'powershell.exe' -argv @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hang) -timeoutSeconds 5
    $elapsed = ((Get-Date) - $started).TotalSeconds

    Assert-True ($h.TimedOut -eq $true) "it is reported as timed out"
    Assert-True ($elapsed -lt 60) `
        "and the runner gave up in about the deadline rather than waiting on it ($([int]$elapsed)s against a 5s deadline)"

    # THE ASSERTION THAT MATTERS MOST after the kill itself: what it printed
    # BEFORE hanging is still collected. A hang with no output is a hang nobody
    # can diagnose, and re-running it is what people do instead.
    $hText = @($h.Lines) -join "`n"
    Assert-True ($hText -match 'the part that ran before the hang') `
        "what it managed to print is kept, so the hang can be located" $hText
    Assert-True ($hText -match 'killed after 5 seconds') `
        "and the log says plainly that the runner killed it, not that the suite ended" $hText
    Assert-True (-not ($hText -match 'Result: 1 passed')) `
        "it never reaches its Result line, so the runner scores it as not-finished"

    # ==================================================================
    Write-Host ""
    Write-Host "A suite that crashes without a Result line" -ForegroundColor Cyan

    $crash = Join-Path $work 'crash.ps1'
    Set-Content -LiteralPath $crash -Value @'
Write-Host "  PASS  one"
throw "died halfway"
'@ -Encoding UTF8

    $c = Invoke-SuiteProcess -exe 'powershell.exe' -argv @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $crash) -timeoutSeconds 60
    $cText = @($c.Lines) -join "`n"
    Assert-True ($c.TimedOut -eq $false) "a crash is not a timeout - they are different diagnoses"
    # `-ne 0` ALONE PASSES ON $null, and it did: before the parameterless
    # WaitForExit was added to the helper, ExitCode came back empty and this
    # assertion went green about a value that did not exist. The null check is
    # the assertion; the comparison is the detail.
    Assert-True ($null -ne $c.ExitCode -and $c.ExitCode -ne 0) `
        "its non-zero exit comes back ($($c.ExitCode))"
    Assert-True (-not ($cText -match 'Result: \d+ passed')) `
        "and it printed no Result line, which is what the runner keys on"
    Assert-True ($cText -match 'died halfway') "the reason it died is in the captured output" $cText

    # ==================================================================
    Write-Host ""
    Write-Host "And the runner counts both of those into its exit code" -ForegroundColor Cyan

    # Asserted against the source. Actually running run-all.ps1 with a planted
    # broken suite means running every other suite too, which is twenty minutes
    # to prove one boolean - and this is the boolean, written once.
    $runAll = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'run-all.ps1')
    Assert-True ($runAll -match '\$exitCode = \[int\]\(\(\$totalFailed -gt 0\) -or \(\$missingSuites\.Count -gt 0\) -or \(\$crashedSuites\.Count -gt 0\)\)') `
        "a crashed or timed-out suite makes the run exit non-zero"
    Assert-True ($runAll -match '\$crashedSuites \+= \$r') `
        "and such suites are actually collected, not just declared"
    Assert-True (-not ($runAll -match 'NOT RUN  \(needs Full Mode, or it crashed')) `
        "the old message that led with the wrong diagnosis is gone"
    Assert-True ($runAll -match 'CRASHED' -and $runAll -match 'TIMED OUT') `
        "and the two states are named separately, because they need different responses"

    # ==================================================================
    Write-Host ""
    Write-Host "The skips that were invisible to the skip machinery" -ForegroundColor Cyan

    # run-all.ps1 counts skips by matching ^SKIP. Three sites printed NOTE while
    # skipping assertions, so four to five checks vanished from the run counted
    # as neither. The matcher was NOT broadened: NOTE and SKIP mean different
    # things, and gpu-shape-verify uses both correctly now - NOTE where the
    # assertions still ran, SKIP where they did not.
    $gpu = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'gpu-shape-verify.js')
    Assert-True ($gpu -match "SKIP  byPid is empty") `
        "an empty byPid is a SKIP - the shape checks are in the else branch and did not run"
    Assert-True ($gpu -match "SKIP  No adapters reported") `
        "so is having no adapters, for the same reason"
    Assert-True ($gpu -match "NOTE  The engine reported a counter failure") `
        "but a reported counter failure stays a NOTE, because assertions DO run after it"

    $pkg = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'packaging-verify.js')
    Assert-True ($pkg -match "SKIP  \`$\{sib\} is referenced by the engine") `
        "and the packaging check skipped by a `continue` says SKIP too"
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
