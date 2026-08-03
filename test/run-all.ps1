# Runs every Vanish verification suite and prints one summary.
# Read-only suites run in either tier; the rest need Full Mode and will say so.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

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
    @{ Name = "Task Manager + Unlocker (2)";   Kind = "ps";       Path = "test\phase2-verify.ps1" },
    @{ Name = "Switches + restore (3)";        Kind = "ps";       Path = "test\phase3-verify.ps1" },
    @{ Name = "Uninstall queue (TASK-11)";     Kind = "node";     Path = "test/queue-verify.js" },
    @{ Name = "Store migration (SEC-3)";       Kind = "node";     Path = "test/store-migration-verify.js" },
    @{ Name = "System Clean scans (4)";        Kind = "ps";       Path = "test\phase4-verify.ps1" },
    @{ Name = "System Clean purges (4)";       Kind = "electron"; Path = "test/phase4-ipc-verify.js" },
    @{ Name = "Force uninstall (REQ-20)";      Kind = "ps";       Path = "test\force-verify.ps1" },
    @{ Name = "Security regressions";          Kind = "ps";       Path = "test\security-verify.ps1" },
    @{ Name = "UI interaction";                Kind = "electron"; Path = "test/ui-interaction-verify.js" },
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

    $summary = ($output | Select-String -Pattern '^Result: (\d+) passed, (\d+) failed' | Select-Object -Last 1)
    if ($summary) {
        $passed = [int]$summary.Matches[0].Groups[1].Value
        $failed = [int]$summary.Matches[0].Groups[2].Value
        $results += @{ Name = $suite.Name; Passed = $passed; Failed = $failed; Ran = $true }
        $colour = if ($failed -gt 0) { "Red" } else { "Green" }
        Write-Host ("  {0} passed, {1} failed" -f $passed, $failed) -ForegroundColor $colour
        if ($failed -gt 0) {
            $output | Select-String -Pattern '^\s+FAIL' | ForEach-Object { Write-Host ("  " + $_.Line) -ForegroundColor Red }
        }
    } else {
        $results += @{ Name = $suite.Name; Passed = 0; Failed = 0; Ran = $false }
        Write-Host "  did not report a result (needs Full Mode, or it crashed)" -ForegroundColor DarkYellow
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
    Write-Host ("  {0,-32} {1,3} passed  {2,3} failed" -f $r.Name, $r.Passed, $r.Failed) -ForegroundColor $colour
}

Write-Host ""
Write-Host ("  TOTAL: {0} passed, {1} failed" -f $totalPassed, $totalFailed) -ForegroundColor $(if ($totalFailed -gt 0) { "Red" } else { "Green" })
Write-Host ""
Write-Host "Rule 10 reminder: passing here is 'In Progress', not 'Complete'." -ForegroundColor DarkGray
Write-Host "Complete requires a clean Windows 10 (1607+) and Windows 11 VM pass (TASK-17)." -ForegroundColor DarkGray

exit ([int]($totalFailed -gt 0))
