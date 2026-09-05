# hy56: run one test suite as a child process, with a deadline.
#
# ITS OWN FILE so it can be tested. run-all.ps1 dot-sources this; so does
# test/runner-guard-verify.ps1, which is the only way to assert the kill path
# without either registering a deliberately-hanging suite in the real run or
# adding an override hatch that exists solely for the test.
#
# WHY THE DEADLINE EXISTS. Several suites document that Electron HANGS rather
# than fails on a rejected executeJavaScript, and only nine of roughly
# twenty-two carry a watchdog of their own. A hang in one of the others stalls
# the WHOLE run indefinitely - which happened on 2026-09-05, during a run
# started to verify an unrelated fix. The suite passed 114/114 on its own
# minutes later, so nothing was even wrong with it; the runner simply had no
# way to give up.
#
# A watchdog per suite is a rule twenty-two files have to remember, and the one
# written next week will not. A deadline in the runner covers all of them.

function Invoke-SuiteProcess {
    param(
        [Parameter(Mandatory = $true)][string]$exe,
        [string[]]$argv = @(),
        [int]$timeoutSeconds = 600
    )

    # Start-Process cannot send both streams to one file, so they are captured
    # separately and joined. Each keeps its own order; stderr is appended under
    # a header rather than interleaved, because a guessed interleaving reads
    # like a causal sequence that never happened.
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $started = Get-Date
        $p = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -PassThru `
             -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        # TOUCH .Handle BEFORE WAITING, and this line is load-bearing despite
        # discarding its value. Start-Process -PassThru hands back a Process
        # object that has not cached the OS handle; once the child exits, the
        # handle is gone and .ExitCode reads as $null forever after. Reading
        # .Handle here makes .NET keep it.
        #
        # Found by this file's own test, which had gone GREEN on the bug: the
        # assertion was `-ne 0`, and $null is not 0.
        try { $null = $p.Handle } catch { }
        $finished = $p.WaitForExit($timeoutSeconds * 1000)
        if ($finished) {
            # PS 5.1 trap, and it produced a VACUOUS PASS in this file's own
            # test before it was found: after the TIMED WaitForExit overload,
            # $p.ExitCode is not populated, and an assertion of `-ne 0` is then
            # true because $null is not 0. The parameterless overload flushes
            # the process's async state and fills it in. It cannot block here -
            # the process has already exited.
            try { $p.WaitForExit() } catch { }
        }
        if (-not $finished) {
            # /T because a hung Electron suite has child processes, and killing
            # only the parent leaves them holding the fixtures the next suite
            # needs - which is how one hang becomes a cascade of failures in
            # suites that were fine.
            & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null
            try { $null = $p.WaitForExit(5000) } catch { }
        }

        # Read AFTER the wait, so a killed child's partial output is still
        # collected rather than lost with it.
        $lines = @()
        if (Test-Path -LiteralPath $outFile) { $lines += @(Get-Content -LiteralPath $outFile -ErrorAction SilentlyContinue) }
        $errLines = @()
        if (Test-Path -LiteralPath $errFile) { $errLines += @(Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue) }
        if ($errLines.Count -gt 0) { $lines += @('--- stderr ---') + $errLines }
        if (-not $finished) {
            $lines += @('', "  RUNNER: killed after $timeoutSeconds seconds without exiting. Everything above is what it managed to print.")
        }

        return @{
            Lines      = $lines
            TimedOut   = (-not $finished)
            ExitCode   = $(if ($finished) { $p.ExitCode } else { $null })
            ElapsedSec = [int]((Get-Date) - $started).TotalSeconds
        }
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}
