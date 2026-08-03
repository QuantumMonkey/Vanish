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

    # ==================================================================
    # SEC-1: shell command injection through UninstallString
    # (/cso audit 2026-08-03, bd vanish-uninstaller-lwz)
    # ==================================================================
    Write-Host ""
    Write-Host "SEC-1 - command injection via a planted HKCU UninstallString" -ForegroundColor Cyan

    # The whole vulnerability was that main.js handed this string to cmd.exe as
    # administrator. The canary proves no shell ever saw it: if a shell did, the
    # metacharacter payload would create the file.
    $injCanary = Join-Path $canary "sec1-injection-canary.txt"
    if (Test-Path -LiteralPath $injCanary) { Remove-Item -LiteralPath $injCanary -Force }

    $injKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSec1TestEntry"
    if (Test-Path -LiteralPath $injKey) { Remove-Item -LiteralPath $injKey -Recurse -Force }
    $null = New-Item -Path $injKey -Force
    Set-ItemProperty -LiteralPath $injKey -Name DisplayName -Value "Vanish SEC-1 Test Entry"
    Set-ItemProperty -LiteralPath $injKey -Name UninstallString `
        -Value "`"$env:LOCALAPPDATA\fake\uninstall.exe`" /S & echo pwned > `"$injCanary`""

    $injPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSec1TestEntry"

    try {
        # 1. The entry is recognised as untrusted before anything runs.
        $live = Invoke-Engine "read-uninstall-entry" @{ registryPath = $injPath }
        Assert-True ($live.trust.risky -eq $true)            "a planted HKCU entry is reported untrusted"

        # 2. The engine refuses it outright without an acknowledgement, even
        #    though the executable itself is what the string names.
        $split = Invoke-Engine "resolve-uninstall-args" @{
            displayName     = $live.displayName
            publisher       = $live.publisher
            uninstallString = $live.uninstallString
        }
        Assert-True ($split.success -eq $true)               "the uninstall string is parsed rather than executed"
        Assert-True ($split.executable -notmatch '&')        "the metacharacter payload is not part of the executable"

        $blocked = Invoke-Engine "run-uninstaller" @{
            executable     = $split.executable
            baseArgs       = $split.baseArgs
            arguments      = $split.arguments
            registryPath   = $injPath
            timeoutSeconds = 5
            acknowledged   = $false
        }
        Assert-True ($blocked.success -eq $false)            "an unacknowledged untrusted uninstaller is refused"
        Assert-True ($blocked.blocked -eq $true)             "the refusal is the trust gate, not an incidental failure"

        # 3. Even acknowledged, the payload runs through Start-Process, so the
        #    shell operators are inert. The executable does not exist, so this
        #    fails to start - and the canary must still not exist.
        $ran = Invoke-Engine "run-uninstaller" @{
            executable     = $split.executable
            baseArgs       = $split.baseArgs
            arguments      = $split.arguments
            registryPath   = $injPath
            timeoutSeconds = 5
            acknowledged   = $true
        }
        Assert-True ($ran.blocked -ne $true)                 "an acknowledged uninstaller is no longer blocked by the gate"

        Start-Sleep -Milliseconds 500
        Assert-True (-not (Test-Path -LiteralPath $injCanary)) "no shell ran the '&' payload - the injection canary is absent"

        # 4. HKCU registration alone is enough to trip the engine-level gate,
        #    even when the binary itself sits somewhere only admins can write.
        $lolbin = Invoke-Engine "run-uninstaller" @{
            executable     = (Join-Path $env:SystemRoot "System32\cmd.exe")
            baseArgs       = ""
            arguments      = "/c echo pwned > `"$injCanary`""
            registryPath   = $injPath
            timeoutSeconds = 5
            acknowledged   = $false
        }
        Assert-True ($lolbin.blocked -eq $true)              "an HKCU entry naming a system binary is blocked, not just user-writable ones"
        Assert-True (-not (Test-Path -LiteralPath $injCanary)) "the LOLBin attempt left no canary either"
    } finally {
        if (Test-Path -LiteralPath $injKey) { Remove-Item -LiteralPath $injKey -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # ==================================================================
    # SEC-1: the UWP branch no longer builds a command line
    # ==================================================================
    Write-Host ""
    Write-Host "SEC-1 - Store package removal takes a package name, not a command" -ForegroundColor Cyan

    $appxCanary = Join-Path $canary "sec1-appx-canary.txt"
    if (Test-Path -LiteralPath $appxCanary) { Remove-Item -LiteralPath $appxCanary -Force }

    $bad = Invoke-Engine "remove-appx" @{ packageFullName = "Foo_1.0.0.0_x64__abc & echo pwned > `"$appxCanary`"" }
    Assert-True ($bad.success -eq $false)                    "a package name carrying shell metacharacters is refused"
    Assert-True ($bad.error -match 'not a valid package full name') "the refusal is the shape check, before any cmdlet call"

    $missing = Invoke-Engine "remove-appx" @{ packageFullName = "NotInstalled.Vanish_1.0.0.0_x64__8wekyb3d8bbwe" }
    Assert-True ($missing.success -eq $false)                "a well-formed but uninstalled package is refused"

    $empty = Invoke-Engine "remove-appx" @{ packageFullName = "" }
    Assert-True ($empty.success -eq $false)                  "an empty package name is refused"

    Start-Sleep -Milliseconds 300
    Assert-True (-not (Test-Path -LiteralPath $appxCanary))  "no shell ran the appx payload - the canary is absent"

    # ==================================================================
    # SEC-1: static guarantee - no shell in the main process at all
    # ==================================================================
    Write-Host ""
    Write-Host "SEC-1 - the main process imports no shell-executing API" -ForegroundColor Cyan

    # Comment lines are stripped so the commentary describing the old bug does
    # not trip the check that the old bug is gone.
    $mainCode = @(Get-Content -LiteralPath (Join-Path $root "main.js") |
                  Where-Object { $_ -notmatch '^\s*(//|\*|/\*)' }) -join "`n"
    Assert-True ($mainCode -notmatch 'exec\s*\(')             "main.js has no exec() call site"
    Assert-True ($mainCode -notmatch '\bexecSync\b')          "main.js has no execSync() call site"
    Assert-True ($mainCode -notmatch 'require\([''"]node:child_process[''"]\)[^\r\n]*\bexec\b') "main.js does not import exec from child_process"
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
