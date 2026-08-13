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
