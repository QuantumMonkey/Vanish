# Starts Windows Sandbox against THIS checkout, wherever it happens to live.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\start-sandbox.ps1
#
# WHY THIS EXISTS RATHER THAN JUST DOUBLE-CLICKING THE .wsb (0kp):
# a .wsb carries absolute host paths by construction - there is no variable, no
# relative form that is safe across Windows builds, and no error worth reading
# when it is wrong: Sandbox refuses to start on a MappedFolder whose HostFolder
# does not exist, and says so in a dialog that names the file rather than the
# path. The repo moved from "D:\quickhelp projects\vanish-uninstaller" to
# "D:\quickhelp\vanish-uninstaller" and the checked-in .wsb kept pointing at
# the old location, so the sandbox - the acceptance route for 1qp and the whole
# Phase 3 elevated set - was quietly dead. Fixing the literal string fixes today
# and rebuilds the same trap for the next move.
#
# The checked-in vanish-sandbox.wsb stays, because it is worth being able to
# READ the configuration without running anything. This script generates an
# equivalent one with the real paths filled in and launches that.
#
# NOTE ON THE SPACE: the SANDBOX-side path deliberately contains one
# ("Desktop\test folder\vanish-uninstaller"). That is 69a/TASK-05 coverage -
# elevated relaunch on a spaced path - and it does not depend on the host path,
# so it survives the host moving to a folder without a space.

param(
    # Write and report the config without starting the VM. Lets the paths be
    # checked - and regression-tested - without a Sandbox boot.
    [switch]$GenerateOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')

# Fail with the actual reason rather than letting Sandbox show its own dialog.
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) {
    throw "Resolved '$repoRoot' as the repo root, but there is no package.json there. Run this script from inside the checkout."
}

$nodeDir = Split-Path (Get-Command node -ErrorAction SilentlyContinue).Source -Parent
if (-not $nodeDir) {
    throw "node is not on PATH on the HOST. Sandbox ships without Node and this config maps the host's copy in read-only; there is nothing to map."
}

$sandboxRepo = 'C:\Users\WDAGUtilityAccount\Desktop\test folder\vanish-uninstaller'
$sandboxNode = 'C:\Users\WDAGUtilityAccount\Desktop\nodejs'

$config = @"
<Configuration>
  <VGpu>Enable</VGpu>
  <Networking>Enable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$repoRoot</HostFolder>
      <SandboxFolder>$sandboxRepo</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$nodeDir</HostFolder>
      <SandboxFolder>$sandboxNode</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoExit -ExecutionPolicy Bypass -File "$sandboxRepo\test\sandbox\sandbox-setup.ps1"</Command>
  </LogonCommand>
  <MemoryInMB>4096</MemoryInMB>
</Configuration>
"@

$generated = Join-Path $env:TEMP 'vanish-sandbox.generated.wsb'
$config | Out-File -FilePath $generated -Encoding utf8

Write-Host ""
Write-Host "Vanish sandbox" -ForegroundColor Cyan
Write-Host "  repo (host)   : $repoRoot"
Write-Host "  node (host)   : $nodeDir"
Write-Host "  repo (sandbox): $sandboxRepo"
Write-Host "  config        : $generated"
Write-Host ""

if ($GenerateOnly) {
    Write-Host "-GenerateOnly: config written, Sandbox not started." -ForegroundColor DarkGray
    exit 0
}

if (-not (Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue)) {
    Write-Host "Windows Sandbox is not installed or not enabled on this machine." -ForegroundColor Yellow
    Write-Host "Enable it with: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All" -ForegroundColor Yellow
    Write-Host "The generated config is still at the path above." -ForegroundColor Yellow
    exit 2
}

Write-Host "Starting Windows Sandbox. The setup script runs the unelevated suite," -ForegroundColor Cyan
Write-Host "then hands off to test\sandbox\VERIFICATION-CHECKLIST.md." -ForegroundColor Cyan
& WindowsSandbox.exe $generated
