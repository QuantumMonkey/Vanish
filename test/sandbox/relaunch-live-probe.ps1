# TASK-05 / 69a / adg: prove the elevated relaunch END TO END, on a real
# machine, with a spaced path -- from a genuinely DE-ELEVATED caller.
#
# Everything about this path was covered except the one thing that matters.
# relaunch-argv-probe proves the quoting without triggering UAC, and
# test/uac-cause-verify.js proves the mapping from a failure to a cause. What
# neither can do is answer "does Start-Process -Verb RunAs actually hand back
# an elevated process on this machine", because the elevated test harness is
# ALREADY elevated: asking an administrator to become an administrator
# succeeds trivially and proves nothing. That is why 69a sat open needing a
# human at a consent prompt.
#
# So this runs in two stages. Stage 1 (elevated) drops privilege; stage 2
# (de-elevated) asks the engine to relaunch elevated, targeting a marker
# script under a path WITH SPACES, and the marker records the integrity level
# it actually ran at.
#
# THE DROP USES A SCHEDULED TASK AT RunLevel Limited, not runas.exe. The first
# version of this probe used runas.exe /trustlevel:0x20000 because it is the
# Windows-documented mechanism -- and it silently did nothing, exactly as 9vp
# had ALREADY MEASURED on this machine in test/deelevation-probe.ps1:
#
#   runas.exe /trustlevel:0x20000              NO RESULT (exit 1)
#   explorer token, CreateProcessWithTokenW    NO RESULT (child died 0xc0000142)
#   scheduled task, RunLevel Limited           DROPPED PRIVILEGE (Medium, S-1-16-8192)
#
# That measurement was in this repository, with the answer in a comment, and
# writing this probe against the documented mechanism instead of the measured
# one cost a full failing run. It is also the second time runas has been
# believed here: in 0.5.0 it exited 0 while doing nothing, so the app reported
# a successful de-elevation and came back in Full Mode.
#
# The proof is the marker file: written by a process that was started by the
# engine, from an unprivileged caller, and that reports IsInRole(Administrator)
# true. Nothing here is inferred from an exit code.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\relaunch-live-probe.ps1
#
# NOTE ON THIS MACHINE, and why no prompt appears: measured 2026-08-28,
# EnableLUA=1 with ConsentPromptBehaviorAdmin=0. UAC is on, so the caller
# still gets a filtered token and stage 2 is genuinely unprivileged, but the
# elevation request is auto-approved with no dialog. That makes the SUCCESS
# path fully testable unattended and leaves exactly one branch unprovable
# here: 'declined', which needs a prompt there is no way to show.

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scanner = Join-Path $root 'scanner.ps1'

$script:pass = 0
$script:fail = 0
function Write-Skip {
    param([string]$label)
    Write-Host "  SKIP  $label" -ForegroundColor Yellow
}

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Test-IsElevated {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# A path with spaces at BOTH levels - the directory and the file name - since
# Start-Process joins -ArgumentList with spaces and quotes nothing, which is
# the defect TASK-05 was filed for.
$work   = Join-Path ([System.IO.Path]::GetTempPath()) 'vanish relaunch probe'
$marker = Join-Path $work 'elevation result.json'
$target = Join-Path $work 'report elevation.ps1'
$stage2 = Join-Path $work 'stage two.ps1'

Write-Host ''
Write-Host 'Vanish live elevated-relaunch probe (69a / adg)' -ForegroundColor Cyan
Write-Host '=============================================='

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $work -Force

try {
    # CHECK THE PREMISE FIRST. If stage 1 is not elevated there is nothing to
    # drop from, and every result below would be about an ordinary process start
    # rather than about elevation.
    #
    # SKIPPED, NOT FAILED, and that changed on 2026-08-28. This used to
    # Assert-True on the premise, so an unelevated `npm test` reported
    # "1651 passed, 1 failed" with the one failure being the shell not being
    # elevated. That is not a defect in Vanish, and a suite that can never be
    # green in a tier it explicitly supports teaches everyone to read past the
    # failure count - which is exactly how a real regression gets missed.
    #
    # It is not a silent pass either: the run is named in the runner's "Skipped,
    # named (these did NOT run - they are not passes)" section, which is what
    # that section exists for.
    $stage1Elevated = Test-IsElevated
    if (-not $stage1Elevated) {
        Write-Host '  SKIP  the whole probe needs an elevated starting point - asking an unprivileged process to drop privilege proves nothing. Run this from an elevated shell.' -ForegroundColor Yellow
        Write-Host ''
        Write-Host "Result: $script:pass passed, $script:fail failed"
        exit 0
    }
    Assert-True $stage1Elevated 'stage 1 is elevated, so dropping privilege is a real drop'

    # The thing the engine will be asked to launch. It records what it IS,
    # not what it was asked to be.
    Set-Content -LiteralPath $target -Encoding ASCII -Value @'
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$out = @{
    elevated  = $elevated
    identity  = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    args      = @($args)
    scriptDir = $PSScriptRoot
}
$dest = Join-Path $PSScriptRoot 'elevation result.json'
$out | ConvertTo-Json -Compress | Set-Content -LiteralPath $dest -Encoding ASCII
'@

    # Stage 2 runs UNPRIVILEGED and is the actual caller under test. It asks
    # the engine for an elevated relaunch and writes down what the engine said,
    # separately from what the launched process later reports, so a lying
    # success and a real one are distinguishable.
    $stage2Body = @"
`$ErrorActionPreference = 'Stop'
`$mine = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
`$params = @{
    exePath = 'powershell.exe'
    argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$target')
} | ConvertTo-Json -Compress
`$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(`$params))
`$engine = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$scanner' -Action relaunch-elevated -ParamsBase64 `$b64
@{ callerElevated = `$mine; engineSaid = (`$engine -join '') } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath '$work\stage2 result.json' -Encoding ASCII
"@
    Set-Content -LiteralPath $stage2 -Encoding ASCII -Value $stage2Body

    # Dot-sourcing scanner.ps1 with no -Action defines its functions and runs
    # nothing - the dispatch is inside `if ($Action)`. That gives us the app's
    # OWN de-elevation helper rather than a second copy of it here, so this
    # probe exercises the mechanism the product actually ships.
    . $scanner

    Write-Host ''
    Write-Host 'Dropping to a standard-user token via scheduled task (9vp), then asking the engine to elevate' -ForegroundColor Cyan
    $drop = Invoke-DeelevatedViaScheduledTask -ExePath (Get-Command powershell.exe).Source `
        -ArgList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $stage2)
    Assert-True ($drop.success -eq $true) "the de-elevation drop succeeded via $($drop.method) ($($drop.error))"

    $stage2Result = Join-Path $work 'stage2 result.json'
    $waited = 0
    while (-not (Test-Path -LiteralPath $stage2Result) -and $waited -lt 30) { Start-Sleep -Seconds 1; $waited++ }
    Assert-True (Test-Path -LiteralPath $stage2Result) "the de-elevated stage ran and reported back (waited ${waited}s)"

    if (Test-Path -LiteralPath $stage2Result) {
        $s2 = Get-Content -LiteralPath $stage2Result -Raw | ConvertFrom-Json
        # The same rule the premise at the top of this file already follows,
        # one level deeper. With EnableLUA=0 there is no filtered token to
        # drop to, so the scheduled-task trick hands back an elevated
        # process and this can never be false. Windows Sandbox ships that
        # way, which is how the first clean-machine run produced a red line
        # that meant "this image cannot host this test".
        $lua = 1
        try {
            $lua = [int](Get-ItemProperty -Path 'HKLM:SOFTWAREMicrosoftWindowsCurrentVersionPoliciesSystem' -Name EnableLUA -ErrorAction Stop).EnableLUA
        } catch { $lua = 1 }
        if ($s2.callerElevated -eq $false) {
            Assert-True $true 'and it was genuinely UNPRIVILEGED - otherwise this proves nothing'
        } elseif ($lua -eq 0) {
            Write-Skip 'the de-elevated stage came back STILL elevated because UAC is off on this machine (EnableLUA=0), so there is no standard-user token to drop to. Turn UAC on and restart before treating this as a result.'
        } else {
            Assert-True $false 'and it was genuinely UNPRIVILEGED - otherwise this proves nothing' 'UAC is ON here, so the drop should have worked - this is a real failure'
        }
        Assert-True ($s2.engineSaid -match '"success":true') "the engine reported the relaunch succeeded (said: $($s2.engineSaid))"
    }

    $waited = 0
    while (-not (Test-Path -LiteralPath $marker) -and $waited -lt 30) { Start-Sleep -Seconds 1; $waited++ }
    Assert-True (Test-Path -LiteralPath $marker) "the relaunched process actually started (waited ${waited}s)"

    if (Test-Path -LiteralPath $marker) {
        $m = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        # THE ASSERTION THIS EXISTS FOR. Not "the call returned success" - a
        # process that started unelevated would also return success - but the
        # launched process's own report of the token it is running with.
        Assert-True ($m.elevated -eq $true) 'THE ASSERTION THIS EXISTS FOR: the relaunched process is running ELEVATED, launched from an unprivileged caller'
        Assert-True ($m.scriptDir -eq $work) "and it resolved its own spaced directory correctly ($($m.scriptDir))"
        Write-Host ("  INFO  relaunched as: {0}" -f $m.identity) -ForegroundColor DarkGray
    }

    # 69a's other half: the argument vector, for the same spaced path, through
    # the same quoting the live call just used.
    Write-Host ''
    Write-Host 'TASK-05 quoting, on the same spaced path' -ForegroundColor Cyan
    $probeParams = @{ argList = @($target, '--plain', 'C:\Program Files\x y\z.msi') } | ConvertTo-Json -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probeParams))
    $argv = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action relaunch-argv-probe -ParamsBase64 $b64) -join '' | ConvertFrom-Json
    Assert-True ($argv.success -eq $true) 'the argv probe answers'
    Assert-True (@($argv.argv)[0] -eq ('"' + $target + '"')) 'a spaced path is quoted as ONE argument'
    Assert-True (@($argv.argv)[1] -eq '--plain') 'a bare token is left alone rather than quoted defensively'
    Assert-True (@($argv.argv)[2] -eq '"C:\Program Files\x y\z.msi"') 'and a spaced argument is quoted too, not just the executable'

    Write-Host ''
    Write-Host 'What this run could NOT prove' -ForegroundColor DarkYellow
    Write-Host '  * The declined branch. This machine has ConsentPromptBehaviorAdmin=0,' -ForegroundColor DarkYellow
    Write-Host '    so elevation is auto-approved and there is no prompt to cancel.' -ForegroundColor DarkYellow
    Write-Host '    Win32 1223 cannot be produced here at all; the mapping that would' -ForegroundColor DarkYellow
    Write-Host '    run on it is covered by test/uac-cause-verify.js instead.' -ForegroundColor DarkYellow
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { 'Red' } else { 'Green' })
if ($script:fail -gt 0) { exit 1 }
