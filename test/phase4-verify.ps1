# Phase 4 Verify: TASK-13 (explicit registry views), TASK-14 (context menu
# cleaner), TASK-15 (services / drivers / PATH / associations), TASK-16
# (other-profile hive sweep).
#
# Scans run in either tier. The purge round trips are driven through the IPC
# layer by test/phase4-ipc-verify.js, which needs Full Mode.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\phase4-verify.ps1

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
    return ($out -join "`n") | ConvertFrom-Json
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish phase 4 verification" -ForegroundColor Cyan
Write-Host "==========================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

$planted = [System.Collections.Generic.List[string]]::new()
$ghostExe = Join-Path $env:TEMP "vanish-ghost-target\missing.exe"   # deliberately never created

try {
    # ==================================================================
    # TASK-13: explicit registry views (REQ-18)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-13 explicit registry views (REQ-18)" -ForegroundColor Cyan

    # Plant a key that exists ONLY in the 32-bit view. HKLM\Software is the
    # hive WOW64 actually redirects (HKCU\Software is not), so this is where
    # the 64-bit host must be shown to be blind without an explicit view.
    if ($isAdmin) {
        $key32 = "HKLM:\Software\Wow6432Node\VanishViewProbe"
        if (Test-Path -LiteralPath $key32) { Remove-Item -LiteralPath $key32 -Recurse -Force }
        $null = New-Item -Path $key32 -Force
        Set-ItemProperty -LiteralPath $key32 -Name "Marker" -Value "only-32-bit"
        $planted.Add($key32)

        $found32 = Invoke-Engine "registry-view-probe" @{
            hive = "LocalMachine"; subKey = "Software\VanishViewProbe"; name = "Marker"; view = "Registry32"
        }
        $found64 = Invoke-Engine "registry-view-probe" @{
            hive = "LocalMachine"; subKey = "Software\VanishViewProbe"; name = "Marker"; view = "Registry64"
        }

        Assert-True ($found32.value -eq "only-32-bit") "a key planted only in the 32-bit view IS found with view=Registry32"
        Assert-True ($null -eq $found64.value)          "the same key is NOT found with view=Registry64 (no implicit redirection)"
        Assert-True ($found32.regPath -eq "HKLM\Software\Wow6432Node\VanishViewProbe") "the 32-bit view maps to the Wow6432Node path the vault needs"
    } else {
        Write-Host "  SKIP  planting an HKLM\Software key needs Full Mode" -ForegroundColor Yellow
    }

    # ==================================================================
    # REGRESSION GUARD - the cleaner that must never eat boot
    # ==================================================================
    Write-Host ""
    Write-Host "Regression guard: core Windows handlers (Codex: The Cleaner That Ate Boot)" -ForegroundColor Cyan

    $assocAll = Invoke-Engine "cleaner-scan" @{ cleaner = "associations" }
    $criticalProgIds = @(
        'exefile','batfile','cmdfile','comfile','scrfile','piffile','lnkfile',
        'txtfile','regfile','htmlfile','Directory','Drive','Folder','Msi.Package'
    )
    $flaggedCritical = @($assocAll.findings | Where-Object {
        $label = [string]$_.label
        $criticalProgIds -contains ($label -replace ' \(protocol handler\)$','')
    })
    Assert-True ($flaggedCritical.Count -eq 0) "no core Windows file-type handler is proposed for removal ($($flaggedCritical.Count) flagged)"

    # A "%1"-style command runs the clicked document, not a fixed exe, and can
    # never be an orphan. This is what used to flag exefile.
    $ctxAll = Invoke-Engine "cleaner-scan" @{ cleaner = "context-menus" }
    $placeholderHits = @(@($assocAll.findings) + @($ctxAll.findings) | Where-Object { $_.evidence -match '%[0-9Ll\*]' })
    Assert-True ($placeholderHits.Count -eq 0) "no finding is based on a shell placeholder (%1 / %L / %V) being 'missing'"

    # Every finding must name a target that really is absent.
    $wrongCalls = @(@($assocAll.findings) | Where-Object {
        $t = ($_.evidence -replace '^open command target missing: ','')
        $t -and (Test-Path -LiteralPath $t -ErrorAction SilentlyContinue)
    })
    Assert-True ($wrongCalls.Count -eq 0) "every association finding's target is genuinely absent from disk"

    # ==================================================================
    # TASK-14: context menu cleaner (REQ-11)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-14 context menu cleaner (REQ-11)" -ForegroundColor Cyan

    # Plant an orphan handler: a CLSID whose InprocServer32 points nowhere.
    # NOTE: the "all files" shell key is literally named *, so every call that
    # touches this path uses -LiteralPath. Without it PowerShell treats the *
    # as a wildcard and the path silently means something else.
    $clsid = "{DEADBEEF-1234-4321-ABCD-0123456789AB}"
    $handlerKey = "HKCU:\Software\Classes\*\shellex\ContextMenuHandlers\VanishOrphanTest"
    $clsidKey   = "HKCU:\Software\Classes\CLSID\$clsid\InprocServer32"
    foreach ($k in @($handlerKey, "HKCU:\Software\Classes\CLSID\$clsid")) {
        if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force }
    }
    $null = New-Item -Path $handlerKey -Force
    Set-ItemProperty -LiteralPath $handlerKey -Name "(default)" -Value $clsid
    $null = New-Item -Path $clsidKey -Force
    Set-ItemProperty -LiteralPath $clsidKey -Name "(default)" -Value "C:\Vanish\Definitely\Missing\shell.dll"
    $planted.Add($handlerKey)
    $planted.Add("HKCU:\Software\Classes\CLSID\$clsid")

    $ctx = Invoke-Engine "cleaner-scan" @{ cleaner = "context-menus" }
    Assert-True ($ctx.success -eq $true) "context menu scan completed"
    $orphan = @($ctx.findings | Where-Object { $_.label -like "*VanishOrphanTest*" })
    Assert-True ($orphan.Count -gt 0) "the planted orphan handler is found"
    if ($orphan.Count -gt 0) {
        Assert-True ($orphan[0].evidence -match "target missing") "finding explains itself (evidence column)"
        Assert-True ($orphan[0].kind -eq "registry")              "finding routes to the registry quarantine path"
        Assert-True ($orphan[0].registryPath -match "ContextMenuHandlers")  "finding carries the reg.exe path the vault needs"
    }

    # ==================================================================
    # TASK-15: services (REQ-14)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-15a orphaned services (REQ-14)" -ForegroundColor Cyan

    if ($isAdmin) {
        $svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\VanishOrphanSvc"
        if (Test-Path -LiteralPath $svcKey) { Remove-Item -LiteralPath $svcKey -Recurse -Force }
        $null = New-Item -Path $svcKey -Force
        Set-ItemProperty -Path $svcKey -Name "ImagePath" -Value $ghostExe
        Set-ItemProperty -Path $svcKey -Name "Type"  -Value 16   -Type DWord
        Set-ItemProperty -Path $svcKey -Name "Start" -Value 3    -Type DWord
        $planted.Add($svcKey)

        $svc = Invoke-Engine "cleaner-scan" @{ cleaner = "services" }
        Assert-True ($svc.success -eq $true) "service scan completed"
        $svcHit = @($svc.findings | Where-Object { $_.label -eq "VanishOrphanSvc" })
        Assert-True ($svcHit.Count -gt 0) "the planted orphan service is found"
        if ($svcHit.Count -gt 0) {
            Assert-True ($svcHit[0].registryPath -eq "HKLM\SYSTEM\CurrentControlSet\Services\VanishOrphanSvc") "service maps to its registry key for manifest-backed removal"
        }

        # Boot-start drivers must never be proposed.
        $bootKey = "HKLM:\SYSTEM\CurrentControlSet\Services\VanishBootDrv"
        if (Test-Path -LiteralPath $bootKey) { Remove-Item -LiteralPath $bootKey -Recurse -Force }
        $null = New-Item -Path $bootKey -Force
        Set-ItemProperty -Path $bootKey -Name "ImagePath" -Value $ghostExe
        Set-ItemProperty -Path $bootKey -Name "Type"  -Value 1 -Type DWord
        Set-ItemProperty -Path $bootKey -Name "Start" -Value 0 -Type DWord
        $planted.Add($bootKey)

        $svc2 = Invoke-Engine "cleaner-scan" @{ cleaner = "services" }
        Assert-True (@($svc2.findings | Where-Object { $_.label -eq "VanishBootDrv" }).Count -eq 0) "boot-start drivers are excluded from removal proposals"
    } else {
        Write-Host "  SKIP  planting an HKLM service key needs Full Mode" -ForegroundColor Yellow
    }

    # ==================================================================
    # TASK-15: driver store (audit only)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-15a driver store packages (audit only, Rule 16)" -ForegroundColor Cyan
    $drv = Invoke-Engine "cleaner-scan" @{ cleaner = "drivers" }
    Assert-True ($drv.success -eq $true) "driver store scan completed"
    $nonRemovable = @($drv.findings | Where-Object { $_.removable -ne $false })
    Assert-True ($nonRemovable.Count -eq 0) "no driver finding is offered as removable in Core"

    # ==================================================================
    # TASK-15: PATH (REQ-15)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-15b PATH cleaner (REQ-15)" -ForegroundColor Cyan

    $userPathKey = "HKCU:\Environment"
    $originalPath = (Get-ItemProperty -Path $userPathKey -Name Path -ErrorAction SilentlyContinue).Path
    $deadDir = "C:\Vanish\Definitely\Missing\bin"
    $newPath = if ($originalPath) { "$originalPath;$deadDir" } else { $deadDir }
    Set-ItemProperty -Path $userPathKey -Name Path -Value $newPath

    try {
        $pathScan = Invoke-Engine "cleaner-scan" @{ cleaner = "path" }
        Assert-True ($pathScan.success -eq $true) "PATH scan completed"
        $deadHit = @($pathScan.findings | Where-Object { $_.label -eq $deadDir })
        Assert-True ($deadHit.Count -gt 0) "the planted dead PATH directory is found"
        if ($deadHit.Count -gt 0) {
            Assert-True ($deadHit[0].meta.scope -eq "User") "the finding records which PATH scope it came from"
        }

        # Live directories must not be proposed.
        Assert-True (@($pathScan.findings | Where-Object { Test-Path $_.label }).Count -eq 0) "no existing directory is ever flagged as dead"

        if ($isAdmin) {
            $write = Invoke-Engine "set-path-entries" @{ scope = "User"; remove = @($deadDir) }
            Assert-True ($write.success -eq $true)     "PATH write-back succeeded"
            Assert-True ($write.removedCount -eq 1)    "exactly one entry removed"
            $afterPath = (Get-ItemProperty -Path $userPathKey -Name Path).Path
            Assert-True ($afterPath -notmatch [regex]::Escape($deadDir)) "dead entry gone from the live PATH"
            Assert-True ($afterPath -eq $originalPath) "every surviving entry is byte-identical to the original PATH"
        }
    } finally {
        if ($null -eq $originalPath) { Remove-ItemProperty -Path $userPathKey -Name Path -ErrorAction SilentlyContinue }
        else { Set-ItemProperty -Path $userPathKey -Name Path -Value $originalPath }
    }

    # ==================================================================
    # TASK-15: associations (REQ-16)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-15c file associations (REQ-16)" -ForegroundColor Cyan

    $progId = "VanishOrphanProgId"
    $progKey = "HKCU:\Software\Classes\$progId"
    if (Test-Path -LiteralPath $progKey) { Remove-Item -LiteralPath $progKey -Recurse -Force }
    $null = New-Item -Path "$progKey\shell\open\command" -Force
    Set-ItemProperty -Path "$progKey\shell\open\command" -Name "(default)" -Value "`"$ghostExe`" `"%1`""
    $planted.Add($progKey)

    $assoc = Invoke-Engine "cleaner-scan" @{ cleaner = "associations" }
    Assert-True ($assoc.success -eq $true) "association scan completed"
    $assocHit = @($assoc.findings | Where-Object { $_.label -like "*$progId*" })
    Assert-True ($assocHit.Count -gt 0) "the planted dead handler is found"
    if ($assocHit.Count -gt 0) {
        Assert-True ($assocHit[0].evidence -match "target missing") "evidence names the missing executable"
    }

    # ==================================================================
    # TASK-16: other profiles (REQ-17)
    # ==================================================================
    Write-Host ""
    Write-Host "TASK-16 other user profile sweep (REQ-17, NFR-07)" -ForegroundColor Cyan

    if ($isAdmin) {
        $before = @((Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue).PSChildName |
                    Where-Object { $_ -like 'VanishProfile_*' })
        Assert-True ($before.Count -eq 0) "no Vanish hive is mounted before the scan"

        $prof = Invoke-Engine "cleaner-scan" @{ cleaner = "profiles"; keyword = "VanishNoSuchApp" }
        Assert-True ($prof.success -eq $true) "profile sweep completed without error"

        $after = @((Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue).PSChildName |
                   Where-Object { $_ -like 'VanishProfile_*' })
        Assert-True ($after.Count -eq 0) "every loaded hive was unloaded afterwards (NFR-07)"

        # And with no keyword the sweep must refuse to list every vendor key.
        $noKeyword = Invoke-Engine "cleaner-scan" @{ cleaner = "profiles" }
        Assert-True (@($noKeyword.findings).Count -eq 0) "without a keyword the sweep proposes nothing"
        $after2 = @((Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue).PSChildName |
                    Where-Object { $_ -like 'VanishProfile_*' })
        Assert-True ($after2.Count -eq 0) "no hive left mounted on the empty-keyword path either"
    } else {
        $denied = Invoke-Engine "cleaner-scan" @{ cleaner = "profiles"; keyword = "test" }
        Assert-True ($denied.success -eq $false) "profile sweep refuses to run in Audit Mode"
    }
}
finally {
    foreach ($k in $planted) {
        if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
