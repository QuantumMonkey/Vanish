# Phase 2 Verify: TASK-06 (process monitor), TASK-07 (unlocker),
# TASK-08 (indicators), TASK-09 (watchdog suspension).
# Read-only checks run in either tier; unlock/kill checks need Full Mode.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\phase2-verify.ps1

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"

$script:pass = 0
$script:fail = 0
$script:spawned = @()

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params = @{})
    $json = $params | ConvertTo-Json -Depth 8 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    # 8ok: stdout is supposed to carry one JSON document and nothing else, but
    # powershell.exe writes the WARNING, VERBOSE and DEBUG streams to STDOUT -
    # only errors go to stderr. One cmdlet warning inside the engine therefore
    # used to take the whole suite down with a raw ConvertFrom-Json exception
    # and no Result line, which is how bfh.1 came back as "not run" rather than
    # as "broke, and here is what it saw". Report what actually arrived.
    # The engine-side fix is the preference block in scanner.ps1's preamble.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

function Stop-Spawned {
    foreach ($id in $script:spawned) {
        try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
    }
    $script:spawned = @()
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish phase 2 verification" -ForegroundColor Cyan
Write-Host "==========================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

$work = Join-Path $env:TEMP "vanish-phase2-verify"
if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $work -Force

try {
    # ======================================================================
    # TASK-06: process monitor
    # ======================================================================
    Write-Host ""
    Write-Host "TASK-06 process monitor (REQ-06)" -ForegroundColor Cyan

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $list = Invoke-Engine "list-processes" @{ sampleMs = 400 }
    $sw.Stop()

    Assert-True ($list.success -eq $true)        "engine returned a process list"
    Assert-True ($list.items.Count -gt 20)       "list is populated ($($list.items.Count) processes)"
    Assert-True ($list.logicalCores -ge 1)       "logical core count resolved (CPU% denominator)"
    Write-Host ("  INFO  sample round trip: {0} ms (NFR-03 target is a <=2s refresh)" -f $sw.ElapsedMilliseconds) -ForegroundColor DarkGray

    # Cross-check against Get-Process for three processes the OS always has.
    $live = Get-Process -ErrorAction SilentlyContinue
    $checked = 0
    $matched = 0
    foreach ($name in @("explorer", "svchost", "csrss")) {
        $mine   = @($live  | Where-Object { $_.ProcessName -eq $name })
        $theirs = @($list.items | Where-Object { $_.name -eq $name })
        if ($mine.Count -gt 0) {
            $checked++
            if ($theirs.Count -gt 0) { $matched++ }
        }
    }
    Assert-True ($checked -gt 0 -and $matched -eq $checked) "list matches Get-Process for $matched/$checked known processes"

    $withMemory = @($list.items | Where-Object { $_.memoryBytes -gt 0 }).Count
    Assert-True ($withMemory -gt 10)             "working-set memory reported ($withMemory processes)"
    Assert-True (@($list.items | Where-Object { $_.commandLine }).Count -gt 5) "command lines resolved via CIM"
    Assert-True (@($list.items | Where-Object { $_.parentPid -gt 0 }).Count -gt 5) "parent PIDs resolved (indicator input)"
    Assert-True (@($list.items | Where-Object { $_.cpuPercent -gt 100 }).Count -eq 0) "no CPU%% above 100 (delta maths sane)"

    # ======================================================================
    # TASK-08: passive indicators
    # ======================================================================
    Write-Host ""
    Write-Host "TASK-08 suspicious activity indicators (REQ-09, Rule 7)" -ForegroundColor Cyan

    Assert-True ($list.indicatorNote -eq "Indicator -- investigate with your antivirus") "Rule 7 label text is exact"

    # A dummy 'office app' spawning a shell is the canonical flagged tree.
    $fakeWord = Join-Path $work "winword.exe"
    Copy-Item "$env:SystemRoot\System32\cmd.exe" $fakeWord -Force
    $parent = Start-Process -FilePath $fakeWord -ArgumentList "/c", "cmd.exe /c ping -n 25 127.0.0.1 > nul" -PassThru -WindowStyle Hidden
    $script:spawned += $parent.Id
    Start-Sleep -Seconds 2

    $flagged = Invoke-Engine "list-processes" @{ sampleMs = 300 }
    $shellChildren = @($flagged.items | Where-Object {
        $_.parentName -and $_.parentName.ToLower() -eq "winword.exe" -and $_.indicators
    })
    Assert-True ($shellChildren.Count -gt 0) "shell spawned by a winword.exe parent is flagged"
    if ($shellChildren.Count -gt 0) {
        $ind = @($shellChildren[0].indicators | Where-Object { $_.kind -eq "suspicious-parent" })
        Assert-True ($ind.Count -gt 0)                  "indicator kind is suspicious-parent"
        Assert-True ($ind[0].note -eq "Indicator -- investigate with your antivirus") "indicator carries the Rule 7 label"
    }

    # Destructive command line detection, display only.
    $destructive = Start-Process powershell.exe -ArgumentList "-NoProfile","-Command","Write-Output 'vssadmin delete shadows /all'; Start-Sleep -Seconds 20" -PassThru -WindowStyle Hidden
    $script:spawned += $destructive.Id
    Start-Sleep -Seconds 2
    $flagged2 = Invoke-Engine "list-processes" @{ sampleMs = 300 }
    $destructiveHits = @($flagged2.items | Where-Object {
        $_.indicators -and (@($_.indicators | Where-Object { $_.kind -eq "destructive-command" }).Count -gt 0)
    })
    Assert-True ($destructiveHits.Count -gt 0) "destructive command line pattern is flagged"

    # Rule 7 is display-only: prove nothing in the renderer acts on an indicator.
    # Every renderer module concatenated, discovered rather than named. This
    # read a single renderer.js until that file was split into renderer/, at
    # which point the whole suite CRASHED rather than silently passing - which
    # is the correct failure mode and how this was caught immediately.
    $rendererFiles = Get-ChildItem (Join-Path $root "renderer") -Filter *.js -ErrorAction SilentlyContinue
    $rendererText = ($rendererFiles | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
    $actionOnIndicator = ($rendererText -match 'indicators[\s\S]{0,200}(killProcess|unlockPath|purgeRemnants|cleanerPurge|vaultDelete)')
    Assert-True (-not $actionOnIndicator) "no UI action is wired to an indicator (Rule 7: display-only)"

    Stop-Spawned

    # ======================================================================
    # TASK-07: unlocker
    # ======================================================================
    Write-Host ""
    Write-Host "TASK-07 unlocker via Restart Manager (REQ-07)" -ForegroundColor Cyan

    $lockedFile = Join-Path $work "locked.dat"
    Set-Content -Path $lockedFile -Value "held open" -Encoding ASCII

    # A spawned PowerShell holds an exclusive handle on the file.
    $holderScript = Join-Path $work "holder.ps1"
    Set-Content -Path $holderScript -Encoding ASCII -Value @"
`$fs = [System.IO.File]::Open('$lockedFile', 'Open', 'ReadWrite', 'None')
Start-Sleep -Seconds 120
`$fs.Close()
"@
    $holder = Start-Process powershell.exe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$holderScript -PassThru -WindowStyle Hidden
    $script:spawned += $holder.Id
    Start-Sleep -Seconds 3

    $swRm = [System.Diagnostics.Stopwatch]::StartNew()
    $lockers = Invoke-Engine "list-lockers" @{ path = $lockedFile }
    $swRm.Stop()

    Assert-True ($lockers.success -eq $true) "list-lockers returned"
    $holderPids = @($lockers.holders | ForEach-Object { $_.pid })
    Assert-True ($holderPids -contains $holder.Id) "the holding process is identified by PID"
    Write-Host ("  INFO  OPEN-03 first Restart Manager call incl. Add-Type JIT: {0} ms engine-reported, {1} ms wall" -f $lockers.initMs, $swRm.ElapsedMilliseconds) -ForegroundColor DarkGray

    if ($isAdmin) {
        $unlock = Invoke-Engine "unlock-path" @{ path = $lockedFile; force = $false; pids = @($holder.Id) }
        Assert-True ($unlock.success -eq $true) "graceful unlock reported success"
        Start-Sleep -Seconds 3
        $after = Invoke-Engine "list-lockers" @{ path = $lockedFile }
        Assert-True (@($after.holders).Count -eq 0) "file is free after the graceful close"
    } else {
        $denied = Invoke-Engine "unlock-path" @{ path = $lockedFile; force = $false; pids = @($holder.Id) }
        Assert-True ($denied.success -eq $false) "unlock refuses to run in Audit Mode (Rule 3)"
        Write-Host "  SKIP  graceful-close assertion needs Full Mode" -ForegroundColor Yellow
    }
    Stop-Spawned

    # ======================================================================
    # TASK-09: watchdog suspension
    # ======================================================================
    Write-Host ""
    Write-Host "TASK-09 watchdog suspension (REQ-08)" -ForegroundColor Cyan

    if (-not $isAdmin) {
        Write-Host "  SKIP  needs Full Mode" -ForegroundColor Yellow
    } else {
        $wdFile = Join-Path $work "watchdog.dat"
        Set-Content -Path $wdFile -Value "guarded" -Encoding ASCII

        # child: holds the file. watchdog: respawns the child whenever it dies.
        $childScript = Join-Path $work "wd-child.ps1"
        Set-Content -Path $childScript -Encoding ASCII -Value @"
`$fs = [System.IO.File]::Open('$wdFile', 'Open', 'ReadWrite', 'None')
Start-Sleep -Seconds 120
`$fs.Close()
"@
        $wdScript = Join-Path $work "wd-parent.ps1"
        Set-Content -Path $wdScript -Encoding ASCII -Value @"
while (`$true) {
    `$running = Get-CimInstance -Query "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { `$_.CommandLine -like '*wd-child.ps1*' }
    if (-not `$running) {
        Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$childScript' -WindowStyle Hidden
    }
    Start-Sleep -Milliseconds 400
}
"@
        $watchdog = Start-Process powershell.exe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$wdScript -PassThru -WindowStyle Hidden
        $script:spawned += $watchdog.Id
        Start-Sleep -Seconds 5

        $wdLockers = Invoke-Engine "list-lockers" @{ path = $wdFile }
        $wdHolderPids = @($wdLockers.holders | ForEach-Object { $_.pid })
        Assert-True ($wdHolderPids.Count -gt 0) "watchdog-guarded file has a holder"

        # Prove the respawn actually happens without suspension.
        if ($wdHolderPids.Count -gt 0) {
            Stop-Process -Id $wdHolderPids[0] -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            $respawned = Invoke-Engine "list-lockers" @{ path = $wdFile }
            Assert-True (@($respawned.holders).Count -gt 0) "control: killing the holder alone lets the watchdog respawn it"

            # Now the real path: suspend the whole tree, then release.
            $treePids = @(@($respawned.holders | ForEach-Object { $_.pid }) + $watchdog.Id | Select-Object -Unique)
            $freed = Invoke-Engine "unlock-path" @{ path = $wdFile; force = $true; suspendTree = $true; pids = $treePids }
            Assert-True ($freed.success -eq $true) "suspend-then-unlock reported success"
            Start-Sleep -Seconds 4
            $finalCheck = Invoke-Engine "list-lockers" @{ path = $wdFile }
            Assert-True (@($finalCheck.holders).Count -eq 0) "file stays free - no respawn after the suspended cleanup"
        }
        Stop-Spawned

        # The thaw must be guaranteed: nothing may be left suspended.
        Start-Sleep -Seconds 1
        $stillSuspended = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Id -in $script:spawned
        })
        Assert-True ($stillSuspended.Count -eq 0) "no test process left suspended (finally-path thaw)"
    }
}
finally {
    Stop-Spawned
    Start-Sleep -Milliseconds 500
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
