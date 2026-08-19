# Collect exactly what the three remaining verifications need, and nothing else.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\collect-report.ps1
#
# Prints to the console AND writes the same text to a file, so the operator can
# paste from either. Runs in either tier.
#
# WHAT IT DELIBERATELY DOES NOT COLLECT: file contents, the vault payload, the
# program list, or anything about what is installed on the machine. The oplog
# lines it prints are elevation-related actions only - the ones 69a and adg turn
# on. Somebody pasting this into a chat should not be handing over an inventory
# of their PC, and a diagnostic that quietly does is the kind of thing this app
# exists to be the alternative to.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    $root = Split-Path -Parent $PSScriptRoot
}

$lines = New-Object System.Collections.Generic.List[string]
function Emit($text) { $lines.Add([string]$text); Write-Host $text }

Emit ''
Emit '=== Vanish verification report ==================================='
Emit ("collected  : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Emit ("machine    : {0}   <- host and sandbox write separate log dirs" -f $env:COMPUTERNAME)

# --- what was running ------------------------------------------------------
$pkgPath = Join-Path $root 'package.json'
$version = if (Test-Path $pkgPath) { (Get-Content $pkgPath -Raw | ConvertFrom-Json).version } else { 'unknown' }
Emit ("version    : {0}" -f $version)
Emit ("os         : {0}" -f (Get-CimInstance Win32_OperatingSystem).Version)
Emit ("repo path  : {0}" -f $root)
Emit ("path has a space: {0}   <- 69a tests exactly this" -f ($root -match ' '))

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Emit ("this shell elevated: {0}" -f $elevated)

# --- the UAC facts, because 69a's decline branch depends on them -----------
$polKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
foreach ($name in @('EnableLUA', 'ConsentPromptBehaviorAdmin', 'PromptOnSecureDesktop')) {
    $v = (Get-ItemProperty -Path $polKey -Name $name -ErrorAction SilentlyContinue).$name
    Emit ("{0,-27}: {1}" -f $name, $(if ($null -eq $v) { '(not set)' } else { $v }))
}
Emit '  (ConsentPromptBehaviorAdmin = 0 means elevation is SILENT - there is'
Emit '   no prompt to accept or decline, so 69a cannot be tested in that state.)'

# --- the packaged build ----------------------------------------------------
Emit ''
Emit '--- packaged build ------------------------------------------------'
$exe = Get-ChildItem (Join-Path $root 'dist\Vanish-*-portable.exe') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($exe) {
    Emit ("exe   : {0}" -f $exe.Name)
    Emit ("built : {0}" -f $exe.LastWriteTime)
    Emit ("size  : {0} MB" -f [math]::Round($exe.Length / 1MB, 1))
} else {
    Emit 'NONE in dist\ - 69a needs the packaged exe, not npm start.'
}

# --- the oplog, elevation entries only -------------------------------------
Emit ''
Emit '--- elevation history (oplog) -------------------------------------'
$candidates = @(
    (Join-Path $env:APPDATA 'vanish-uninstaller\vanish-state\oplog.jsonl'),
    (Join-Path $env:APPDATA 'Electron\vanish-state\oplog.jsonl')
) | Where-Object { Test-Path $_ }

if ($candidates.Count -eq 0) {
    Emit 'No oplog found. If Vanish has been launched, say so - that is itself a finding.'
} else {
    foreach ($log in $candidates) {
        Emit ("from: {0}" -f $log)
        $rows = @(Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 400)
        $shown = 0
        foreach ($row in $rows) {
            $entry = $null
            try { $entry = $row | ConvertFrom-Json } catch { continue }
            $action = [string]$entry.action
            # app-start included: "which tier did it actually land in" is the
            # question both 69a and adg turn on, and it is the field the
            # 2026-08-13 report could not be checked against.
            if ($action -notmatch 'elevat|app-start|tier') { continue }
            $shown++
            $tier = if ($entry.tier) { $entry.tier } else { '?' }
            $meta = ''
            if ($entry.meta) {
                $bits = @()
                foreach ($k in @('cause', 'trigger', 'exitCode', 'wanted', 'landed', 'error')) {
                    if ($null -ne $entry.meta.$k -and "$($entry.meta.$k)" -ne '') { $bits += ("{0}={1}" -f $k, $entry.meta.$k) }
                }
                if ($bits.Count -gt 0) { $meta = '  ' + ($bits -join ' ') }
            }
            Emit ("  {0}  {1,-28} tier={2,-6} outcome={3}{4}" -f $entry.ts, $action, $tier, $entry.outcome, $meta)
        }
        if ($shown -eq 0) { Emit '  (no elevation-related entries)' }
    }
}

# --- the last automated run ------------------------------------------------
Emit ''
Emit '--- last npm test summary -----------------------------------------'
# Per machine, matching run-all.ps1. The flat directory was shared with the host
# through the sandbox's mapped folder, so a host run could overwrite the VM's
# logs - which happened, and briefly made a sandbox run look like clean passes.
$logDir = Join-Path (Join-Path $root 'test\logs') $env:COMPUTERNAME
if (-not (Test-Path $logDir)) {
    # Fall back to the flat layout so this still reports something useful when
    # reading logs written by an older build.
    $flat = Join-Path $root 'test\logs'
    if (Test-Path $flat) { $logDir = $flat }
}
Emit ("log dir : {0}" -f $logDir)
if (Test-Path $logDir) {
    $logs = @(Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue)
    $totalPass = 0; $totalFail = 0; $notRun = @()
    foreach ($l in $logs) {
        $m = Select-String -Path $l.FullName -Pattern '^Result: (\d+) passed, (\d+) failed' | Select-Object -Last 1
        if ($m) {
            $totalPass += [int]$m.Matches[0].Groups[1].Value
            $totalFail += [int]$m.Matches[0].Groups[2].Value
        } else {
            $notRun += $l.BaseName
        }
    }
    Emit ("suites: {0}   passed: {1}   failed: {2}" -f $logs.Count, $totalPass, $totalFail)
    if ($notRun.Count -gt 0) { Emit ("NOT RUN (expected for the elevated-only suites): {0}" -f ($notRun -join ', ')) }

    # Any failing assertion, named. This is the half a summary line loses.
    $fails = @()
    foreach ($l in $logs) {
        $fails += @(Select-String -Path $l.FullName -Pattern '^\s*FAIL\b' | ForEach-Object { "  [$($l.BaseName)] " + $_.Line.Trim() })
    }
    if ($fails.Count -gt 0) {
        Emit ''
        Emit 'FAILURES, named:'
        $fails | Select-Object -First 40 | ForEach-Object { Emit $_ }
    }
} else {
    Emit 'No test\logs - npm test has not run here yet.'
}

Emit ''
Emit '=== end ==========================================================='
Emit ''

$out = Join-Path $env:TEMP 'vanish-verification-report.txt'
$lines | Set-Content -Path $out -Encoding ascii
Write-Host ("Also written to: {0}" -f $out) -ForegroundColor Cyan
Write-Host 'Paste the block above (or that file) back to Claude.' -ForegroundColor Cyan
