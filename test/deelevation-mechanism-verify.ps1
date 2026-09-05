# De-elevation mechanism regression suite (9vp).
#
# WHY THIS EXISTS: the de-elevation mechanism was wrong for five sessions and
# nothing caught it, because the only thing anyone asserted was that the engine
# returned success. It did. runas.exe exited 0 and Windows started the process
# elevated anyway, so "success" was true and useless.
#
# Measured on the operator's machine 2026-08-13 from an elevated shell
# (test/deelevation-probe.ps1):
#
#   runas.exe /trustlevel:0x20000              NO RESULT (exit 1)
#   explorer token, CreateProcessWithTokenW    NO RESULT (child died 0xc0000142)
#   scheduled task, RunLevel Limited           DROPPED PRIVILEGE, S-1-16-8192
#
# So this suite asserts the things that make the new path correct and the old
# reporting honest - ordering, the task settings that would otherwise bite
# later, cleanup, and the rule that a launch is only "success" once a new
# process actually exists.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test/deelevation-mechanism-verify.ps1

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Assert($condition, $label) {
    if ($condition) {
        Write-Host "  PASS  $label"
        $script:pass++
    } else {
        Write-Host "  FAIL  $label"
        $script:fail++
    }
}

$root = Split-Path -Parent $PSScriptRoot
$scannerPath = Join-Path $root 'scanner.ps1'
$scanner = Get-Content $scannerPath -Raw
$mainJs = Get-Content (Join-Path $root 'main.js') -Raw

Write-Host ''
Write-Host 'Vanish de-elevation mechanism verification (9vp)'
Write-Host '==============================================='

# --- Ordering: the measured-good mechanism has to go first -----------------
Write-Host ''
Write-Host 'The mechanism that was measured to work is the one that runs first'

$taskCallIdx  = $scanner.IndexOf('Invoke-DeelevatedViaScheduledTask -ExePath')
$runasCallIdx = $scanner.IndexOf('-FilePath "runas.exe"')
Assert ($taskCallIdx -gt 0) 'the scheduled-task mechanism is called by relaunch-deelevated'
Assert ($runasCallIdx -gt 0) 'runas is still present as a fallback'
Assert ($taskCallIdx -lt $runasCallIdx) 'the scheduled task is attempted BEFORE runas, not after'

# --- kfb4: the argument vector actually reaches the mechanism --------------
Write-Host ''
Write-Host 'The arguments are built on this path, not borrowed from another branch'

# $argList was assigned ONLY inside the relaunch-ELEVATED branch. On this path
# it was $null, so Invoke-DeelevatedViaScheduledTask - the one mechanism 9vp
# measured as working - had never once been called with an argument vector.
# Silent, because this file sets no Set-StrictMode and an undefined variable
# reads as $null.
#
# Asserted against the BRANCH rather than the whole file, which is the point:
# a grep for "$argList =" passes on the elevated branch's copy, which is
# exactly the assignment that was not in scope here.
$deelevStart = $scanner.IndexOf('"relaunch-deelevated" {')
$deelevEnd   = $scanner.IndexOf('"list-lockers" {', $deelevStart)
Assert ($deelevStart -gt 0 -and $deelevEnd -gt $deelevStart) `
    'premise: this suite can isolate the relaunch-deelevated branch'
$deelev = $scanner.Substring($deelevStart, $deelevEnd - $deelevStart)

$assignIdx = $deelev.IndexOf('$argList = @()')
$useIdx    = $deelev.IndexOf('Invoke-DeelevatedViaScheduledTask -ExePath')
Assert ($assignIdx -gt 0) `
    '$argList is assigned INSIDE this branch rather than inherited from another'
Assert ($useIdx -gt 0 -and $assignIdx -lt $useIdx) `
    'and assigned BEFORE it is handed to the scheduled-task mechanism'
Assert ($deelev -match '\$argList = @\(\$Params\.argList\)') `
    'from the parameters the caller actually sent'

# --- kfb4: one quoting rule, and it is the correct one ---------------------
Write-Host ''
Write-Host 'Arguments are quoted by the shared quoter, not by three hand-rolled copies'

# The hand-rolled '"' + $_ + '"' form does not double a backslash before a
# quote, which Windows requires. A directory ending in a separator - which is
# what app.getAppPath() can hand us - becomes "C:\path\to\app\", where the
# trailing backslash escapes the closing quote and the argument swallows the
# next one. ConvertTo-ProcessArgument has always handled that; two of the three
# call sites simply never used it.
# Comment lines are stripped first. The assertion is about CODE, and the first
# version of it failed on the comment two hundred lines up in scanner.ps1 that
# explains what the hand-rolled form was and why it was wrong - which is a
# check that cannot survive its own explanation.
$codeOnly = (($scanner -split "`r?`n") | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
$handRolled = ([regex]::Matches($codeOnly, "'\`"' \+ \`$_ \+ '\`"'")).Count
Assert ($handRolled -eq 0) `
    "no hand-rolled argument quoting is left in the engine (found $handRolled)"
Assert ($scanner -match 'ConvertTo-ProcessArgumentList \$ArgList') `
    'the scheduled-task action quotes through the shared helper'
Assert ($deelev -match 'ConvertTo-ProcessArgumentList \$argList') `
    'and so does the runas fallback, so the two cannot disagree about the command line'

# The quoter itself, exercised rather than trusted - these are the two cases
# the hand-rolled version got wrong.
. $scannerPath

# The case that breaks, stated as the pair it is. A path with a space MUST be
# quoted, and once quoted its trailing backslash must be doubled or it escapes
# the closing quote. The hand-rolled form produced "C:\Program Files\app\" and
# the argument after it was swallowed.
Assert ((ConvertTo-ProcessArgument 'C:\Program Files\app\') -eq '"C:\Program Files\app\\"') `
    'a quoted path with a trailing backslash doubles it, so it cannot escape the closing quote'
Assert (('"' + 'C:\Program Files\app\' + '"') -ne (ConvertTo-ProcessArgument 'C:\Program Files\app\')) `
    'and that is genuinely different from what the hand-rolled form produced - the two are not equivalent'

# No space and no quote needs no quoting at all, which is also why a trailing
# backslash is harmless here: there is no closing quote for it to escape. The
# hand-rolled form added quotes unconditionally and broke this case too.
Assert ((ConvertTo-ProcessArgument 'C:\path\to\app\') -eq 'C:\path\to\app\') `
    'an argument needing no protection is passed through untouched, trailing separator and all'

Assert ((ConvertTo-ProcessArgument 'a "b" c') -eq '"a \"b\" c"') `
    'an embedded quote is escaped rather than ending the argument'
Assert ((ConvertTo-ProcessArgument '') -eq '""') `
    'and an empty argument still occupies a slot rather than vanishing from the vector'

# --- The task settings that would otherwise bite later ---------------------
Write-Host ''
Write-Host 'The task is created with settings that do not surprise the user later'

Assert ($scanner -match '-RunLevel Limited') `
    'RunLevel Limited - the task runs WITHOUT the elevation the caller holds'
Assert ($scanner -match '-LogonType Interactive') `
    'LogonType Interactive - it lands in the logged-on session and can paint a window'
Assert ($scanner -match '-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)') `
    'ExecutionTimeLimit is unlimited - the 72h default would kill the app out from under someone'
Assert ($scanner -match 'finally\s*\{[\s\S]{0,400}Unregister-ScheduledTask') `
    'the task is unregistered in a finally - no residue left in Task Scheduler'

# --- A launch is not a success until something launched --------------------
Write-Host ''
Write-Host 'Success means a process exists, not that a command returned'

Assert ($scanner -match 'function Wait-ForNewProcess') `
    'there is a helper that waits for a NEW process for this executable'
# One definition plus one call site per mechanism. Counting only forward from
# the scheduled-task call site (an earlier draft of this suite) misses the
# definition and undercounts, which is a bug in the test rather than the code.
$waitCount = ([regex]::Matches($scanner, 'Wait-ForNewProcess')).Count
Assert ($waitCount -ge 3) `
    "BOTH mechanisms prove a new process appeared (1 definition + 2 call sites, found $waitCount)"
Assert ($scanner -match 'runas reported success but no new process appeared') `
    'runas exiting 0 is explicitly NOT accepted as evidence on its own'

# --- The record has to say which mechanism ran -----------------------------
Write-Host ''
Write-Host 'The oplog can say which mechanism produced a result'

Assert ($scanner -match 'method\s*=\s*"scheduled-task"') 'the engine labels the scheduled-task path'
Assert ($scanner -match 'method\s*=\s*"runas-trustlevel"') 'the engine labels the runas path'
Assert ($mainJs -match "method: \(res && res\.method\) \|\| null") 'the oplog record carries the method'
Assert ($mainJs -match 'method: res\.method \|\| null') 'the relaunch-intent marker carries the method'
Assert ($scanner -match 'Both ways of restarting without administrator rights failed') `
    'a total failure names BOTH attempts, not only the last one'

# --- It leaves nothing behind, whatever happens ----------------------------
Write-Host ''
Write-Host 'Running it leaves no scheduled task behind'

. $scannerPath   # no -Action, so the dispatcher at the bottom does not run

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# A real, short-lived, harmless target. Registering a task needs elevation, so
# unelevated this exercises the FAILURE path - which is the one that must also
# clean up, and is the one most likely to leave residue.
$probeExe = Join-Path $env:WINDIR 'System32\help.exe'
if (-not (Test-Path $probeExe)) { $probeExe = (Get-Command cmd.exe).Source }

$result = Invoke-DeelevatedViaScheduledTask -ExePath $probeExe -ArgList @()
Assert ($null -ne $result -and $result.ContainsKey('method')) 'it returns a labelled result either way'
Assert ($result.method -eq 'scheduled-task') 'the result is labelled scheduled-task'

$leftover = Get-ScheduledTask -TaskName 'VanishAuditModeRelaunch' -ErrorAction SilentlyContinue
Assert ($null -eq $leftover) 'no VanishAuditModeRelaunch task remains registered afterwards'

# Registering a task for your OWN user turns out not to need elevation, so the
# launch path is exercised in either tier - which was worth finding out, because
# an earlier draft of this suite assumed the unelevated run could only test the
# failure path and asserted failure. It succeeded, and the assertion was wrong
# rather than the code.
Assert ($result.success -eq $true) "it actually launched something (pid $($result.newPid))"
Assert ($null -ne $result.newPid) 'it reports the PID it launched, which is the evidence'
if ($result.newPid) {
    try { Stop-Process -Id $result.newPid -Force -ErrorAction Stop } catch { }
}

if (-not $elevated) {
    Write-Host '  NOTE  This run was unelevated, so it proves the task LAUNCHES, not that'
    Write-Host '        it drops privilege - there was none to drop. That half was measured'
    Write-Host '        separately by test/deelevation-probe.ps1 from an elevated shell:'
    Write-Host '        Medium Mandatory Level, S-1-16-8192.'
}

Write-Host ''
Write-Host "Result: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
