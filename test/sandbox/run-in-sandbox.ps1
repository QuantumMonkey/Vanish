# The whole sandbox run, in one command, leaving every result on the HOST.
#
# Paste this into any PowerShell window inside Windows Sandbox:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\WDAGUtilityAccount\Desktop\test folder\vanish-uninstaller\test\sandbox\run-in-sandbox.ps1"
#
# WHY THIS EXISTS. The .wsb LogonCommand is supposed to do this automatically
# and on 2026-08-19 it did not - the sandbox booted and nothing ran, with no
# error anywhere, for the third time in this file's history (a stale host path,
# then a BOM, then an unescaped ampersand). A boot-time hook that can fail
# silently is not a thing to keep debugging in a VM you cannot attach to, so
# there is now a manual route that does not depend on it at all.
#
# It also fixes the two things that make a fresh Sandbox shell useless, both of
# which cost the operator real time:
#   - Sandbox ships without Node. The host's copy is mapped in read-only, but
#     nothing puts it on PATH.
#   - A bare `npm` resolves to npm.ps1 first and the default policy is
#     Restricted, so it refuses with "running scripts is disabled on this
#     system" - which reads like npm is broken rather than like a policy. This
#     script does not use npm at all: `npm test` is only a wrapper around
#     test\run-all.ps1, and calling that directly skips the trap.
#
# EVERYTHING IT WRITES GOES INTO THE MAPPED FOLDER, under
# test\logs\sandbox-run\. collect-report.ps1 writes its copy to the sandbox's
# own %TEMP%, which is destroyed with the VM - fine for pasting into a chat,
# useless for reading afterwards. A sandbox result that only exists inside the
# sandbox has to be transcribed by a human before it means anything.

$ErrorActionPreference = 'Continue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
$nodeDir  = 'C:\Users\WDAGUtilityAccount\Desktop\nodejs'

$outDir = Join-Path $repoRoot 'test\logs\sandbox-run'
if (-not (Test-Path -LiteralPath $outDir)) { $null = New-Item -ItemType Directory -Path $outDir -Force }

$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$fullLog  = Join-Path $outDir ("{0}-{1}-suite.txt"  -f $env:COMPUTERNAME, $stamp)
$repLog   = Join-Path $outDir ("{0}-{1}-report.txt" -f $env:COMPUTERNAME, $stamp)
$doneFile = Join-Path $outDir ("{0}-{1}-DONE.txt"   -f $env:COMPUTERNAME, $stamp)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ''
Write-Host '=== Vanish sandbox run ===' -ForegroundColor Cyan
Write-Host ("machine   : {0}" -f $env:COMPUTERNAME)
Write-Host ("repo      : {0}" -f $repoRoot)
Write-Host ("elevated  : {0}" -f $isAdmin)
Write-Host ("results   : {0}" -f $outDir)
Write-Host ''

# The elevated-only suites are the entire reason for running here rather than on
# the host, so say plainly when they are not going to run. Windows Sandbox ships
# with UAC OFF and its account in Administrators, so the normal answer is True -
# False means somebody turned UAC on in this guest, which is a different test.
if (-not $isAdmin) {
    Write-Host 'NOT ELEVATED. The Full Mode suites will skip and the run will not' -ForegroundColor Yellow
    Write-Host 'answer what it was started for. Close this window, open PowerShell' -ForegroundColor Yellow
    Write-Host 'as administrator, and paste the same line again.' -ForegroundColor Yellow
    Write-Host ''
}

if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
    Write-Host "Node is not mapped at $nodeDir." -ForegroundColor Red
    Write-Host 'This sandbox was not started by test\sandbox\start-sandbox.ps1, so the' -ForegroundColor Red
    Write-Host 'host node folder is not mounted and nothing here can run. Nothing was done.' -ForegroundColor Red
    exit 2
}
$env:Path = "$nodeDir;$env:Path"

Set-Location -LiteralPath $repoRoot

Write-Host ("node      : {0}" -f (& node --version))
Write-Host ''
Write-Host 'Running the full suite. This takes several minutes; leave it alone.' -ForegroundColor Cyan
Write-Host ''

# 2>&1 so a suite that dies on stderr still leaves its reason in the file. The
# host reads these afterwards, and "it failed" without the text is a second run.
#
# NOT Tee-Object. PowerShell 5.1's Tee-Object has no -Encoding parameter and
# writes UTF-16, so the first pass over the returned transcripts on the host
# found nothing at all with grep - a file that is unreadable by the tools that
# will read it is not a transcript, it is a second trip to the sandbox.
# Streamed AND collected: the operator watches this window while it runs, so
# buffering the whole suite into a variable first would leave it blank for
# several minutes, which is its own kind of silent failure.
$suiteOut = New-Object System.Collections.Generic.List[string]
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'test\run-all.ps1') 2>&1 |
    ForEach-Object { $line = [string]$_; Write-Host $line; $suiteOut.Add($line) }
$suiteExit = $LASTEXITCODE
$suiteOut | Out-File -FilePath $fullLog -Encoding ascii

Write-Host ''
Write-Host 'Collecting the environment report...' -ForegroundColor Cyan
$repOut = New-Object System.Collections.Generic.List[string]
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'test\sandbox\collect-report.ps1') 2>&1 |
    ForEach-Object { $line = [string]$_; Write-Host $line; $repOut.Add($line) }
$repOut | Out-File -FilePath $repLog -Encoding ascii

# The marker is what tells a watcher on the host that this finished rather than
# that the window is still running - the per-suite logs appear one at a time
# during the run, so their presence proves nothing about completion.
$summary = @(
    "machine     : $env:COMPUTERNAME",
    "finished    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "elevated    : $isAdmin",
    "suite exit  : $suiteExit",
    "suite log   : $(Split-Path -Leaf $fullLog)",
    "report log  : $(Split-Path -Leaf $repLog)",
    '',
    '--- summary lines from the run ---'
)
$summary += @(Get-Content -LiteralPath $fullLog -ErrorAction SilentlyContinue |
    Select-String -Pattern '^\s*TOTAL:|^\s*FAIL\b|NOT RUN' | ForEach-Object { $_.Line.TrimEnd() })
Set-Content -LiteralPath $doneFile -Value $summary -Encoding ASCII

Write-Host ''
Write-Host '=======================================================' -ForegroundColor Green
Write-Host ' Done. Everything is on the host, in the repo:' -ForegroundColor Green
Write-Host "   test\logs\sandbox-run\" -ForegroundColor Green
Write-Host ' Nothing else is needed from this window - it can be closed,' -ForegroundColor Green
Write-Host ' and the sandbox with it.' -ForegroundColor Green
Write-Host '=======================================================' -ForegroundColor Green
