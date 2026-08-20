# Runs every Vanish verification suite and prints one summary.
# Read-only suites run in either tier; the rest need Full Mode and will say so.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 6d7: every suite writes its full output to disk, unconditionally and before
# anything is parsed out of it. The batch run that reported 837 passed / 1
# failed could not be diagnosed at all: the FAIL line scrolled past inside a
# 28-suite run, the Summary block kept only the counts, and re-running the
# suite alone passed 51/0. A failure you cannot name is a failure everyone
# learns to re-run instead of read.
# PER MACHINE, and this is not tidiness - it is a bug that destroyed real
# evidence on 2026-08-19.
#
# test\logs lives INSIDE the repo folder, and Windows Sandbox maps that folder
# read-write from the host. So the sandbox's logs and the host's logs were the
# same files. The sandbox produced ten failures worth diagnosing; a routine
# `npm test` on the host minutes later hit the wipe below and overwrote every
# one of them with its own output - which then read as a set of clean passes and
# nearly sent us chasing a contradiction between the summary and the logs.
#
# Keyed by computer name because that is what actually differs between the host
# and the VM, and the wipe now only clears THIS machine's directory. Two
# machines sharing one checkout can no longer erase each other.
$logDir = Join-Path (Join-Path $PSScriptRoot "logs") $env:COMPUTERNAME
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Get-ChildItem -LiteralPath $logDir -Filter *.log -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# Stray logs from before the per-machine split, so an old flat set cannot be
# mistaken for this run's.
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "logs") -Filter *.log -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " Vanish verification suite" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ("Tier: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode - destructive suites will skip" }))

$suites = @(
    @{ Name = "Vault engine (TASK-01)";        Kind = "ps";       Path = "test\vault-verify.ps1" },
    @{ Name = "Elevation tiers (TASK-04)";     Kind = "electron"; Path = "test/tier-verify.js" },
    @{ Name = "Vault IPC (TASK-02/03)";        Kind = "electron"; Path = "test/vault-ipc-verify.js" },
    @{ Name = "Startup actions IPC (dmu)";     Kind = "electron"; Path = "test/startup-action-ipc-verify.js" },
    @{ Name = "Task Manager + Unlocker (2)";   Kind = "ps";       Path = "test\phase2-verify.ps1" },
    @{ Name = "Switches + restore (3)";        Kind = "ps";       Path = "test\phase3-verify.ps1" },
    @{ Name = "Uninstall queue (TASK-11)";     Kind = "node";     Path = "test/queue-verify.js" },
    @{ Name = "Settings validation";           Kind = "node";     Path = "test/settings-verify.js" },
    @{ Name = "Store migration (SEC-3)";       Kind = "node";     Path = "test/store-migration-verify.js" },
    @{ Name = "System Clean scans (4)";        Kind = "ps";       Path = "test\phase4-verify.ps1" },
    @{ Name = "System Clean purges (4)";       Kind = "electron"; Path = "test/phase4-ipc-verify.js" },
    @{ Name = "CleanerML reader (7sl)";        Kind = "ps";       Path = "test\cleanerml-verify.ps1" },
    @{ Name = "Install snapshot (zrw)";        Kind = "node";     Path = "test/snapshot-verify.js" },
    @{ Name = "Size attribution (bu2)";        Kind = "node";     Path = "test/attribution-verify.js" },
    @{ Name = "Process attribution (0bi)";    Kind = "node";     Path = "test/process-attribution-verify.js" },
    @{ Name = "Platform uninstalls (8ns)";     Kind = "node";     Path = "test/platforms-verify.js" },
    @{ Name = "Relaunch intent (1dq)";          Kind = "node";     Path = "test/elevation-intent-verify.js" },
    @{ Name = "Icon set";                      Kind = "node";     Path = "test/icon-verify.js" },
    @{ Name = "Shared runtimes (ht8)";         Kind = "electron"; Path = "test/runtimes-verify.js" },
    @{ Name = "Windows updates (ag0)";         Kind = "electron"; Path = "test/updates-verify.js" },
    @{ Name = "Missing engine (frr)";          Kind = "electron"; Path = "test/engine-missing-verify.js" },
    @{ Name = "Network attribution (bfh.1)";   Kind = "ps";       Path = "test\network-verify.ps1" },
    @{ Name = "Dead refs (7v3/be8/ztl)";       Kind = "ps";       Path = "test\dead-reference-verify.ps1" },
    @{ Name = "Force uninstall (REQ-20)";      Kind = "ps";       Path = "test\force-verify.ps1" },
    @{ Name = "Security regressions";          Kind = "ps";       Path = "test\security-verify.ps1" },
    @{ Name = "Details panel layout (5z5)";    Kind = "electron"; Path = "test/details-panel-layout-verify.js" },
    @{ Name = "Install date provenance (c0y)"; Kind = "electron"; Path = "test/install-date-provenance-verify.js" },
    @{ Name = "UAC policy lock (qyt)";          Kind = "node";     Path = "test/uac-lock-verify.js" },
    @{ Name = "UAC failure causes (ytv)";      Kind = "node";     Path = "test/uac-cause-verify.js" },
    @{ Name = "GPU payload shape (aaw)";       Kind = "node";     Path = "test/gpu-shape-verify.js" },
    @{ Name = "De-elevation mechanism (9vp)";   Kind = "ps";       Path = "test\deelevation-mechanism-verify.ps1" },
    @{ Name = "Listener panel (ddx)";          Kind = "electron"; Path = "test/listeners-verify.js" },
    @{ Name = "Startup grouping (tda)";        Kind = "electron"; Path = "test/startup-groups-verify.js" },
    @{ Name = "Column filters (5b0)";          Kind = "electron"; Path = "test/column-filter-verify.js" },
    @{ Name = "UI interaction";                Kind = "electron"; Path = "test/ui-interaction-verify.js" },
    @{ Name = "Clean All (zl4)";               Kind = "electron-full"; Path = "test/clean-all-verify.js" },
    @{ Name = "UI interaction (Full Mode)";    Kind = "electron-full"; Path = "test/ui-interaction-full-verify.js" }
)

$results = @()

foreach ($suite in $suites) {
    Write-Host ""
    Write-Host ("--- {0} ---" -f $suite.Name) -ForegroundColor Yellow

    $output = switch ($suite.Kind) {
        "ps"       { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $suite.Path 2>&1 }
        "node"     { & node $suite.Path 2>&1 }
        "electron" { & ".\node_modules\.bin\electron.cmd" $suite.Path 2>&1 }
        # Fixture-simulated Full Mode (VANISH_STUB_TIER), independent of whether
        # THIS process is actually elevated - runs in either tier.
        "electron-full" {
            $env:VANISH_STUB_TIER = "full"
            try { & ".\node_modules\.bin\electron.cmd" $suite.Path 2>&1 }
            finally { Remove-Item Env:\VANISH_STUB_TIER -ErrorAction SilentlyContinue }
        }
    }

    # On disk BEFORE anything is parsed out of it, so a suite that printed its
    # findings and then died still leaves them behind to read.
    $slug    = ((($suite.Name -replace '[^A-Za-z0-9]+', '-').Trim('-'))).ToLower()
    $logPath = Join-Path $logDir ("{0}.log" -f $slug)
    $output | Out-File -FilePath $logPath -Encoding utf8

    $failLines = @($output | Select-String -Pattern '^\s*FAIL\b' | ForEach-Object { $_.Line.Trim() })
    $warnLines = @($output | Select-String -Pattern '^\s*WARN\b' | ForEach-Object { $_.Line.Trim() })
    # A SKIP is not a pass, and until now nothing here said so. The sandbox run
    # of 2026-08-20 finished 1320 passed / 0 failed with the one leg it had been
    # started for - the installer-cache round trip - skipped, because a fresh VM
    # has never installed anything by MSI and the sweep correctly finds nothing.
    # A green total that hides a load-bearing skip is a number about something
    # other than what it claims, which is this codebase's recurring defect.
    $skipLines = @($output | Select-String -Pattern '^\s*SKIP\b' | ForEach-Object { $_.Line.Trim() })

    $summary = ($output | Select-String -Pattern '^Result: (\d+) passed, (\d+) failed' | Select-Object -Last 1)
    if ($summary) {
        $passed = [int]$summary.Matches[0].Groups[1].Value
        $failed = [int]$summary.Matches[0].Groups[2].Value
        $results += @{ Name = $suite.Name; Passed = $passed; Failed = $failed; Ran = $true; FailLines = $failLines; WarnLines = $warnLines; SkipLines = $skipLines; Log = $logPath }
        $colour = if ($failed -gt 0) { "Red" } else { "Green" }
        Write-Host ("  {0} passed, {1} failed" -f $passed, $failed) -ForegroundColor $colour
        foreach ($w in $warnLines) { Write-Host ("  " + $w) -ForegroundColor Yellow }
        foreach ($f in $failLines) { Write-Host ("  " + $f) -ForegroundColor Red }
    } else {
        $results += @{ Name = $suite.Name; Passed = 0; Failed = 0; Ran = $false; FailLines = $failLines; WarnLines = $warnLines; SkipLines = $skipLines; Log = $logPath }
        Write-Host ("  did not report a result (needs Full Mode, or it crashed) - full output: {0}" -f $logPath) -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " Summary" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

$totalPassed = 0
$totalFailed = 0
foreach ($r in $results) {
    if (-not $r.Ran) {
        Write-Host ("  {0,-32} NOT RUN" -f $r.Name) -ForegroundColor DarkYellow
        continue
    }
    $totalPassed += $r.Passed
    $totalFailed += $r.Failed
    $colour = if ($r.Failed -gt 0) { "Red" } else { "Green" }
    $skipped = if ($r.SkipLines) { @($r.SkipLines).Count } else { 0 }
    $suffix = if ($skipped -gt 0) { "  ({0} skipped)" -f $skipped } else { "" }
    Write-Host ("  {0,-32} {1,3} passed  {2,3} failed{3}" -f $r.Name, $r.Passed, $r.Failed, $suffix) -ForegroundColor $colour
}

Write-Host ""
Write-Host ("  TOTAL: {0} passed, {1} failed" -f $totalPassed, $totalFailed) -ForegroundColor $(if ($totalFailed -gt 0) { "Red" } else { "Green" })

# 6d7: the counts alone are not a finding. A batch run that reports one
# failure out of 838 has to name WHICH assertion, here, at the bottom, where
# the reader already is - not 3000 scrolled lines up.
$withFailures = @($results | Where-Object { $_.FailLines -and $_.FailLines.Count -gt 0 })
if ($withFailures.Count -gt 0) {
    Write-Host ""
    Write-Host " Failures, named" -ForegroundColor Red
    Write-Host " ---------------" -ForegroundColor Red
    foreach ($r in $withFailures) {
        Write-Host ("  {0}" -f $r.Name) -ForegroundColor Red
        foreach ($f in $r.FailLines) { Write-Host ("      " + $f) -ForegroundColor Red }
        Write-Host ("      full output: {0}" -f $r.Log) -ForegroundColor DarkGray
    }
}

# Named, in full, at the bottom where the reader already is - for the same
# reason failures are. "43 passed, 0 failed" on a suite whose central leg did
# not run is the most expensive kind of green there is.
$withSkips = @($results | Where-Object { $_.SkipLines -and $_.SkipLines.Count -gt 0 })
if ($withSkips.Count -gt 0) {
    Write-Host ""
    Write-Host " Skipped, named (these did NOT run - they are not passes)" -ForegroundColor DarkYellow
    Write-Host " --------------------------------------------------------" -ForegroundColor DarkYellow
    foreach ($r in $withSkips) {
        Write-Host ("  {0}" -f $r.Name) -ForegroundColor DarkYellow
        foreach ($k in $r.SkipLines) { Write-Host ("      " + $k) -ForegroundColor DarkYellow }
    }
}

$withWarnings = @($results | Where-Object { $_.WarnLines -and $_.WarnLines.Count -gt 0 })
if ($withWarnings.Count -gt 0) {
    Write-Host ""
    Write-Host " Warnings (not failures)" -ForegroundColor Yellow
    foreach ($r in $withWarnings) {
        foreach ($w in $r.WarnLines) { Write-Host ("  {0}: {1}" -f $r.Name, $w) -ForegroundColor Yellow }
    }
}

Write-Host ""
Write-Host ("Every suite's full output: {0}" -f $logDir) -ForegroundColor DarkGray
Write-Host "Rule 10 reminder: passing here is 'In Progress', not 'Complete'." -ForegroundColor DarkGray
Write-Host "Complete requires a clean Windows 10 (1607+) and Windows 11 VM pass (TASK-17)." -ForegroundColor DarkGray

exit ([int]($totalFailed -gt 0))
