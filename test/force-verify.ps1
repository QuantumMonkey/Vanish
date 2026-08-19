# REQ-20 Verify: forced uninstall detection of broken and orphaned entries.
# Plants uninstall entries that cannot uninstall themselves and asserts Vanish
# finds them WITHOUT being told the application name.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\force-verify.ps1

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"

$script:pass = 0
$script:fail = 0

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

Write-Host ""
Write-Host "Vanish forced uninstall verification (REQ-20)" -ForegroundColor Cyan
Write-Host "============================================="

$base    = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$planted = @()
$ghostDir = Join-Path $env:TEMP "vanish-force-ghost"
$liveDir  = Join-Path $env:TEMP "vanish-force-live"

try {
    if (Test-Path -LiteralPath $liveDir) { Remove-Item -LiteralPath $liveDir -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $liveDir -Force
    Copy-Item "$env:SystemRoot\System32\cmd.exe" (Join-Path $liveDir "uninstall.exe") -Force

    # 1. Uninstaller executable is gone.
    $k1 = "$base\VanishBrokenMissingExe"
    $null = New-Item -Path $k1 -Force; $planted += $k1
    Set-ItemProperty -LiteralPath $k1 -Name DisplayName     -Value "Vanish Test - Missing Uninstaller"
    Set-ItemProperty -LiteralPath $k1 -Name Publisher       -Value "Vanish Test Suite"
    Set-ItemProperty -LiteralPath $k1 -Name UninstallString -Value "`"$ghostDir\uninstall.exe`" /S"
    Set-ItemProperty -LiteralPath $k1 -Name InstallLocation -Value $ghostDir

    # 2. No UninstallString at all.
    $k2 = "$base\VanishBrokenNoString"
    $null = New-Item -Path $k2 -Force; $planted += $k2
    Set-ItemProperty -LiteralPath $k2 -Name DisplayName -Value "Vanish Test - No Uninstall String"
    Set-ItemProperty -LiteralPath $k2 -Name Publisher   -Value "Vanish Test Suite"

    # 3. Uninstaller works, but the install folder is gone (partly broken).
    $k3 = "$base\VanishBrokenFolderGone"
    $null = New-Item -Path $k3 -Force; $planted += $k3
    Set-ItemProperty -LiteralPath $k3 -Name DisplayName     -Value "Vanish Test - Folder Gone"
    Set-ItemProperty -LiteralPath $k3 -Name Publisher       -Value "Vanish Test Suite"
    Set-ItemProperty -LiteralPath $k3 -Name UninstallString -Value "`"$liveDir\uninstall.exe`" /S"
    Set-ItemProperty -LiteralPath $k3 -Name InstallLocation -Value $ghostDir

    # 4. Perfectly healthy entry - must NOT be flagged.
    $k4 = "$base\VanishHealthyEntry"
    $null = New-Item -Path $k4 -Force; $planted += $k4
    Set-ItemProperty -LiteralPath $k4 -Name DisplayName     -Value "Vanish Test - Healthy"
    Set-ItemProperty -LiteralPath $k4 -Name Publisher       -Value "Vanish Test Suite"
    Set-ItemProperty -LiteralPath $k4 -Name UninstallString -Value "`"$liveDir\uninstall.exe`" /S"
    Set-ItemProperty -LiteralPath $k4 -Name InstallLocation -Value $liveDir

    # 5. A system component - must be excluded like the main inventory does.
    $k5 = "$base\VanishSystemComponent"
    $null = New-Item -Path $k5 -Force; $planted += $k5
    Set-ItemProperty -LiteralPath $k5 -Name DisplayName     -Value "Vanish Test - System Component"
    Set-ItemProperty -LiteralPath $k5 -Name SystemComponent -Value 1 -Type DWord
    Set-ItemProperty -LiteralPath $k5 -Name UninstallString -Value "`"$ghostDir\uninstall.exe`""

    Write-Host ""
    Write-Host "Detection without being told the application name" -ForegroundColor Cyan

    $res = Invoke-Engine "find-broken-entries"
    Assert-True ($res.success -eq $true) "scan completed"

    $byName = @{}
    foreach ($f in @($res.findings)) { $byName[$f.displayName] = $f }

    Assert-True ($byName.ContainsKey("Vanish Test - Missing Uninstaller")) "entry with a missing uninstaller executable is detected"
    Assert-True ($byName.ContainsKey("Vanish Test - No Uninstall String")) "entry with no UninstallString at all is detected"
    Assert-True ($byName.ContainsKey("Vanish Test - Folder Gone"))        "entry whose install folder vanished is detected"
    Assert-True (-not $byName.ContainsKey("Vanish Test - Healthy"))       "a healthy entry is NOT flagged"
    Assert-True (-not $byName.ContainsKey("Vanish Test - System Component")) "system components are excluded"

    Write-Host ""
    Write-Host "Evidence and routing" -ForegroundColor Cyan

    $missing = $byName["Vanish Test - Missing Uninstaller"]
    Assert-True ($missing.uninstallerOk -eq $false)          "missing uninstaller is marked unusable"
    Assert-True ($missing.evidence -match "uninstaller is missing") "evidence names the missing uninstaller"
    Assert-True ($missing.registryPath -match "VanishBrokenMissingExe") "finding carries the uninstall key path for quarantine"
    Assert-True ($missing.registryPath -match "^HKCU\\")     "registry path is in reg.exe form the vault understands"
    Assert-True ($missing.publisher -eq "Vanish Test Suite") "publisher is carried through for the scan"

    $noString = $byName["Vanish Test - No Uninstall String"]
    Assert-True ($noString.evidence -match "no UninstallString") "missing UninstallString is explained in plain words"

    # Forcing is the fallback: an entry that can still uninstall itself must say so.
    $folderGone = $byName["Vanish Test - Folder Gone"]
    Assert-True ($folderGone.uninstallerOk -eq $true)  "an entry that can still uninstall itself is marked as such"
    Assert-True ($folderGone.evidence -match "install folder is gone") "its actual problem is still reported"

    Write-Host ""
    Write-Host "The uninstall key is quarantinable (REQ-20 + Rule 2)" -ForegroundColor Cyan
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        $vaultRoot = Join-Path $env:TEMP "vanish-force-vault"
        if (Test-Path -LiteralPath $vaultRoot) { Remove-Item -LiteralPath $vaultRoot -Recurse -Force }
        $null = New-Item -ItemType Directory -Path $vaultRoot -Force
        $entryId = [guid]::NewGuid().ToString()

        $q = Invoke-Engine "quarantine-items" @{
            vaultRoot = $vaultRoot; entryId = $entryId; sourceApp = "Vanish Test - Missing Uninstaller"
            origin = "force-uninstall"
            registry = @(@{ path = $missing.registryPath })
        }
        Assert-True ($q.quarantinedCount -eq 1)                  "the uninstall entry itself was quarantined"
        Assert-True (-not (Test-Path -LiteralPath $k1))          "the application no longer appears in the uninstall hive"

        $entry = Get-Content (Join-Path $vaultRoot "$entryId\entry.json") -Raw | ConvertFrom-Json
        $r = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $entry }
        Assert-True ($r.failed -eq 0)                            "restore succeeded"
        Assert-True (Test-Path -LiteralPath $k1)                 "the listing comes back on restore (a forced uninstall is reversible)"
        Assert-True ((Get-ItemProperty -LiteralPath $k1).DisplayName -eq "Vanish Test - Missing Uninstaller") "restored entry keeps its DisplayName"

        Remove-Item -LiteralPath $vaultRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "  SKIP  quarantine round trip needs Full Mode" -ForegroundColor Yellow
    }
}
finally {
    foreach ($k in $planted) {
        if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath $liveDir) { Remove-Item -LiteralPath $liveDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
