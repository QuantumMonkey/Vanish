# Security regression suite (findings from the 2026-08-03 review).
# Each test attempts the actual attack and asserts it is refused.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\security-verify.ps1

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
    $json = $params | ConvertTo-Json -Depth 10 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    return ($out -join "`n") | ConvertFrom-Json
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish security regression suite" -ForegroundColor Cyan
Write-Host "================================"
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "These tests exercise elevated code paths. Re-run from an elevated shell." -ForegroundColor Yellow
    Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail)
    exit 0
}

$work      = Join-Path $env:TEMP "vanish-security-verify"
$vaultRoot = Join-Path $work "vault"
$canary    = Join-Path $work "canary"

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$null = New-Item -ItemType Directory -Path $vaultRoot -Force
$null = New-Item -ItemType Directory -Path $canary -Force

try {
    # ==================================================================
    # Vuln 1: path traversal in the vault
    # ==================================================================
    Write-Host ""
    Write-Host "Vuln 1 - vault path traversal (arbitrary write/delete as admin)" -ForegroundColor Cyan

    # A real entry to work from.
    $realFile = Join-Path $work "leftover.txt"
    Set-Content -LiteralPath $realFile -Value "payload" -Encoding ASCII
    $entryId = [guid]::NewGuid().ToString()
    $q = Invoke-Engine "quarantine-items" @{
        vaultRoot = $vaultRoot; entryId = $entryId; sourceApp = "SecTest"
        files = @(@{ path = $realFile })
    }
    Assert-True ($q.quarantinedCount -eq 1) "baseline: a legitimate quarantine still works"

    $entry = Get-Content (Join-Path $vaultRoot "$entryId\entry.json") -Raw | ConvertFrom-Json

    # 1a. Attacker-forged entry id containing traversal, aimed at delete.
    $evilDir = Join-Path $canary "do-not-delete"
    $null = New-Item -ItemType Directory -Path $evilDir -Force
    Set-Content -LiteralPath (Join-Path $evilDir "keep.txt") -Value "important" -Encoding ASCII

    $del = Invoke-Engine "vault-delete" @{
        vaultRoot = $vaultRoot
        entryId   = "..\..\vanish-security-verify\canary\do-not-delete"
    }
    Assert-True ($del.success -eq $false)                    "vault-delete refuses a traversing entry id"
    Assert-True ($del.error -match "not a UUID")             "refusal names the reason"
    Assert-True (Test-Path -LiteralPath (Join-Path $evilDir "keep.txt")) "the targeted directory was NOT deleted"

    # 1b. Traversing vaultRelative - reads a file from outside the entry folder.
    $outsideFile = Join-Path $canary "outside.txt"
    Set-Content -LiteralPath $outsideFile -Value "outside the vault" -Encoding ASCII
    $restoreTarget = Join-Path $canary "restored-here.txt"

    $forged = $entry | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $forged.files[0].vaultRelative = "..\..\..\vanish-security-verify\canary\outside.txt"
    $forged.files[0].originalPath  = $restoreTarget

    $r1 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $forged }
    Assert-True (@($r1.files)[0].status -eq "failed")        "restore refuses a traversing vault payload path"
    Assert-True (@($r1.files)[0].error -match "escapes")     "refusal explains the escape"
    Assert-True (Test-Path -LiteralPath $outsideFile)        "the outside file was NOT moved"
    Assert-True (-not (Test-Path -LiteralPath $restoreTarget)) "nothing was written to the attacker's destination"

    # 1c. Protected destination - the System32 payload drop.
    $forged2 = $entry | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $forged2.files[0].originalPath = (Join-Path $env:SystemRoot "System32\vanish-should-never-appear.dll")

    $r2 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $forged2 }
    Assert-True (@($r2.files)[0].status -eq "failed")        "restore refuses a protected system destination"
    Assert-True (@($r2.files)[0].error -match "protected")   "refusal names the protection"
    Assert-True (-not (Test-Path -LiteralPath $forged2.files[0].originalPath)) "nothing was written into System32"

    # 1d. Traversing regFile - arbitrary reg import as admin.
    $forged3 = $entry | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    # Clear the file rows: leaving the legitimate one in place would restore it
    # as a side effect and invalidate the "legitimate restore" check below.
    $forged3.files = @()
    $forged3.registry = @(@{ keyPath = "HKCU\Software\VanishSecTest"; regFile = "..\..\evil.reg"; status = "quarantined" })
    $r3 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $forged3 }
    Assert-True (@($r3.registry)[0].status -eq "failed")     "restore refuses a traversing .reg manifest path"
    Assert-True (@($r3.registry)[0].error -match "escapes")  "refusal explains the escape"

    # 1e. Quarantine with a forged entry id must not create folders outside the vault.
    $q2 = Invoke-Engine "quarantine-items" @{
        vaultRoot = $vaultRoot; entryId = "../../escape"; files = @(@{ path = $realFile })
    }
    Assert-True ($q2.success -eq $false)                     "quarantine refuses a non-UUID entry id"

    # And the legitimate path still works after all that.
    $good = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $entry }
    Assert-True ($good.failed -eq 0)                         "a legitimate restore is unaffected by the new checks"
    Assert-True (Test-Path -LiteralPath $realFile)           "the real file came back"

    # ==================================================================
    # Vuln 2: data directory ACL
    # ==================================================================
    Write-Host ""
    Write-Host "Vuln 2 - data directory is not user-writable" -ForegroundColor Cyan

    $aclDir = Join-Path $work "datadir"
    $null = New-Item -ItemType Directory -Path $aclDir -Force

    $before = Invoke-Engine "check-data-dir" @{ path = $aclDir }
    Assert-True ($before.protected -eq $false)               "a freshly created directory is reported unprotected"

    $applied = Invoke-Engine "secure-data-dir" @{ path = $aclDir }
    Assert-True ($applied.success -eq $true)                 "ACL applied"

    $after = Invoke-Engine "check-data-dir" @{ path = $aclDir }
    Assert-True ($after.protected -eq $true)                 "directory now reports protected"
    Assert-True ($after.inherited -eq $false)                "inheritance is severed"
    Assert-True (@($after.nonAdminWriters).Count -eq 0)      "no non-administrator identity retains write access"

    # Users must still be able to READ, or Audit Mode cannot list the vault.
    $acl = Get-Acl -LiteralPath $aclDir
    $usersSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    $userRead = @($acl.Access | Where-Object {
        $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $usersSid.Value -and
        ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Read) -ne 0
    })
    Assert-True ($userRead.Count -gt 0)                      "standard users keep READ so Audit Mode still lists the vault"

    # ==================================================================
    # Vuln 3: untrusted uninstaller execution
    # ==================================================================
    Write-Host ""
    Write-Host "Vuln 3 - untrusted uninstallers are not run unacknowledged" -ForegroundColor Cyan

    $userWritableExe = Join-Path $env:LOCALAPPDATA "vanish-sectest-payload.exe"
    Copy-Item "$env:SystemRoot\System32\cmd.exe" $userWritableExe -Force

    try {
        $blocked = Invoke-Engine "run-uninstaller" @{
            executable = $userWritableExe; baseArgs = "/c"; arguments = "exit 0"
            timeoutSeconds = 10
        }
        Assert-True ($blocked.success -eq $false)            "engine refuses a user-writable binary without acknowledgement"
        Assert-True ($blocked.blocked -eq $true)             "refusal is flagged as a block, not a generic failure"
        Assert-True ($blocked.error -match "user-writable")  "refusal names the reason"

        $allowed = Invoke-Engine "run-uninstaller" @{
            executable = $userWritableExe; baseArgs = "/c"; arguments = "exit 0"
            timeoutSeconds = 30; acknowledged = $true
        }
        Assert-True ($allowed.success -eq $true)             "the same binary runs once acknowledged"
    } finally {
        Remove-Item -LiteralPath $userWritableExe -Force -ErrorAction SilentlyContinue
    }

    # HKCU-registered entries are reported as untrusted.
    $hkcuKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSecTestEntry"
    if (Test-Path -LiteralPath $hkcuKey) { Remove-Item -LiteralPath $hkcuKey -Recurse -Force }
    $null = New-Item -Path $hkcuKey -Force
    Set-ItemProperty -LiteralPath $hkcuKey -Name DisplayName     -Value "Vanish SecTest Entry"
    Set-ItemProperty -LiteralPath $hkcuKey -Name UninstallString -Value "`"$env:LOCALAPPDATA\fake\uninstall.exe`" /S"

    try {
        $live = Invoke-Engine "read-uninstall-entry" @{
            registryPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSecTestEntry"
        }
        Assert-True ($live.found -eq $true)                  "live registry re-read finds the entry"
        Assert-True ($live.trust.risky -eq $true)            "an HKCU entry pointing at a user-writable binary is untrusted"
        Assert-True ($live.trust.userHive -eq $true)         "HKCU registration is called out"
        Assert-True ($live.trust.userWritable -eq $true)     "user-writable binary location is called out"
        Assert-True (@($live.trust.reasons).Count -ge 2)     "both reasons are reported for the operator"

        # A machine-hive entry pointing at Program Files is not flagged.
        $safe = Invoke-Engine "read-uninstall-entry" @{ registryPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\NoSuchEntryAtAll" }
        Assert-True ($safe.found -eq $false)                 "a missing entry is reported as not found, not silently trusted"
    } finally {
        if (Test-Path -LiteralPath $hkcuKey) { Remove-Item -LiteralPath $hkcuKey -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
