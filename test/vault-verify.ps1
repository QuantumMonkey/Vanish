# TASK-01 Verify: quarantine vault engine primitives (REQ-01, REQ-02).
# Plants temp files + HKCU test keys, quarantines them, asserts originals gone
# and vault payload present, restores, asserts they are back, then deletes the
# entry forever and asserts the folder is gone.
#
# Run elevated (the engine refuses destructive actions in Audit Mode by design):
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\vault-verify.ps1

$ErrorActionPreference = "Stop"
$scanner = Join-Path (Split-Path -Parent $PSScriptRoot) "scanner.ps1"

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) {
        Write-Host "  PASS  $label" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        $script:fail++
    }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params)
    $json = $params | ConvertTo-Json -Depth 8 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for action '$action'." }
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
Write-Host "Vanish vault engine verification" -ForegroundColor Cyan
Write-Host "================================"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

$root      = Join-Path $env:TEMP "vanish-vault-verify"
$fixtures  = Join-Path $root "fixtures"
$vaultRoot = Join-Path $root "vault"
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
$null = New-Item -ItemType Directory -Path $fixtures -Force
$null = New-Item -ItemType Directory -Path $vaultRoot -Force

# --- Plant fixtures -------------------------------------------------------
$fileA = Join-Path $fixtures "leftover.txt"
Set-Content -Path $fileA -Value "vanish test payload" -Encoding ASCII

$dirA = Join-Path $fixtures "LeftoverApp"
$null = New-Item -ItemType Directory -Path $dirA -Force
Set-Content -Path (Join-Path $dirA "config.ini") -Value "[settings]" -Encoding ASCII

$regKey = "HKCU:\Software\VanishVaultVerify"
if (Test-Path $regKey) { Remove-Item $regKey -Recurse -Force }
$null = New-Item -Path $regKey -Force
Set-ItemProperty -Path $regKey -Name "TestValue" -Value "restore-me"

Write-Host ""
Write-Host "Audit Mode guard" -ForegroundColor Cyan
if (-not $isAdmin) {
    $guard = Invoke-Engine "quarantine-items" @{ vaultRoot = $vaultRoot; entryId = "guard"; files = @(@{ path = $fileA }) }
    Assert-True ($guard.success -eq $false) "quarantine-items refuses to run unelevated (Rule 3)"
    Assert-True (Test-Path $fileA) "fixture untouched after refusal"
    Write-Host ""
    Write-Host "Re-run this script elevated to exercise the full round trip." -ForegroundColor Yellow
    Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail)
    exit ([int]($script:fail -gt 0))
}
Write-Host "  SKIP  running elevated; guard path is covered by the unelevated run"

# --- Quarantine -----------------------------------------------------------
Write-Host ""
Write-Host "Quarantine (REQ-01, REQ-02)" -ForegroundColor Cyan
$entryId = [guid]::NewGuid().ToString()
$q = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot
    entryId   = $entryId
    sourceApp = "VaultVerify"
    files     = @(@{ path = $fileA }, @{ path = $dirA })
    registry  = @(@{ path = $regKey })
}

Assert-True ($q.success -eq $true)                  "engine reported success"
Assert-True ($q.quarantinedCount -eq 3)             "3 items quarantined (2 files + 1 key)"
Assert-True (-not (Test-Path $fileA))               "original file is gone from its source path"
Assert-True (-not (Test-Path $dirA))                "original directory is gone from its source path"
Assert-True (-not (Test-Path $regKey))              "registry key removed"

$entryDir = Join-Path $vaultRoot $entryId
Assert-True (Test-Path (Join-Path $entryDir "entry.json"))         "entry.json manifest written"
Assert-True ((Get-ChildItem (Join-Path $entryDir "files") -Recurse -File).Count -ge 2) "file payloads present in vault"
Assert-True ((Get-ChildItem (Join-Path $entryDir "registry") -Filter *.reg).Count -eq 1) ".reg restore manifest present"

$entry = Get-Content (Join-Path $entryDir "entry.json") -Raw | ConvertFrom-Json
Assert-True ($entry.schemaVersion -eq 1)            "entry carries schemaVersion (schema rule 2)"
Assert-True (@($entry.files).Count -eq 2)           "manifest rows for both files"
Assert-True (@($entry.registry)[0].keyPath -eq "HKCU\Software\VanishVaultVerify") "registry path normalised to reg.exe form"

# --- Restore --------------------------------------------------------------
Write-Host ""
Write-Host "Restore (REQ-02, REQ-03)" -ForegroundColor Cyan
$r = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $entry; onConflict = "skip" }

Assert-True ($r.success -eq $true)                  "restore reported success"
Assert-True ($r.failed -eq 0)                       "no restore failures"
Assert-True (Test-Path $fileA)                      "file is back at its original path"
Assert-True ((Get-Content $fileA -Raw).Trim() -eq "vanish test payload") "file contents intact"
Assert-True (Test-Path (Join-Path $dirA "config.ini")) "directory tree is back with contents"
Assert-True (Test-Path $regKey)                     "registry key reappears after .reg import"
Assert-True ((Get-ItemProperty -Path $regKey -Name TestValue).TestValue -eq "restore-me") "registry value intact"

# --- Conflict branch ------------------------------------------------------
Write-Host ""
Write-Host "Restore conflict branch (FLOW-03)" -ForegroundColor Cyan
$entryId2 = [guid]::NewGuid().ToString()
$q2 = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = $entryId2; sourceApp = "VaultVerify"
    files = @(@{ path = $fileA })
}
Assert-True ($q2.quarantinedCount -eq 1)            "second quarantine succeeded"
Set-Content -Path $fileA -Value "squatter" -Encoding ASCII   # occupy the original path
$entry2 = Get-Content (Join-Path $vaultRoot "$entryId2\entry.json") -Raw | ConvertFrom-Json
$r2 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $entry2; onConflict = "skip" }
Assert-True (@($r2.files)[0].status -eq "skipped")  "conflicting restore is skipped, not silently overwritten"
Assert-True ((Get-Content $fileA -Raw).Trim() -eq "squatter") "existing file left untouched by the skip branch"

$r3 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $entry2; onConflict = "overwrite" }
Assert-True (@($r3.files)[0].status -eq "restored") "overwrite branch restores"
Assert-True ((Get-Content $fileA -Raw).Trim() -eq "vanish test payload") "vault copy won on overwrite"

# --- Delete forever -------------------------------------------------------
Write-Host ""
Write-Host "Delete Forever (FLOW-03, irreversible)" -ForegroundColor Cyan
$entryId3 = [guid]::NewGuid().ToString()
$null = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = $entryId3; sourceApp = "VaultVerify"
    files = @(@{ path = $fileA })
}
$d = Invoke-Engine "vault-delete" @{ vaultRoot = $vaultRoot; entryId = $entryId3 }
Assert-True ($d.success -eq $true)                              "delete reported success"
Assert-True (-not (Test-Path (Join-Path $vaultRoot $entryId3))) "entry folder removed from the vault"

# --- Missing-item branch --------------------------------------------------
Write-Host ""
Write-Host "Missing item branch (NFR-01)" -ForegroundColor Cyan
$ghost = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = [guid]::NewGuid().ToString()
    files = @(@{ path = (Join-Path $fixtures "does-not-exist.txt") })
}
Assert-True (@($ghost.entry.files)[0].status -eq "missing")  "vanished item reported as missing, not failed"
Assert-True ($ghost.quarantinedCount -eq 0)                  "empty entry contributes nothing to the vault"

# --- Content integrity (cihg) ---------------------------------------------
# FOUND 2026-09-02 by an adversarial probe. Quarantine a file, overwrite the
# payload inside the vault entry folder, restore: the tampered bytes went back
# on disk and the call reported success. The manifest recorded originalPath,
# vaultRelative, sizeBytes and status - no hash - so nothing could be checked
# and nothing was. The tampered payload was even a different SIZE and that
# passed silently too.
#
# The vault's promise is that the thing you deleted is exactly the thing you
# get back. These are the assertions that make it one.
Write-Host ""
Write-Host "Content integrity (cihg)" -ForegroundColor Cyan

$intFile = Join-Path $fixtures "integrity.dat"
Set-Content -Path $intFile -Value "AUTHENTIC-CONTENT" -Encoding ASCII
$intId = [guid]::NewGuid().ToString()
$intQ = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = $intId; sourceApp = "IntegrityVerify"
    files = @(@{ path = $intFile }); registry = @()
}
$intRow = @($intQ.entry.files)[0]
Assert-True ($intRow.hashAlgo -eq "SHA256")                     "a quarantined file records the algorithm it was hashed with"
Assert-True (-not [string]::IsNullOrWhiteSpace($intRow.contentHash)) "and records the hash itself, so a restore has something to check"

# The tamper that used to succeed.
$intPayload = Join-Path (Join-Path (Join-Path $vaultRoot $intId) "files\1") "integrity.dat"
Assert-True (Test-Path -LiteralPath $intPayload)                "PREMISE: the payload is where the manifest says it is, so there is something to tamper with"
Set-Content -LiteralPath $intPayload -Value "TAMPERED-BY-SOMETHING-ELSE" -Encoding ASCII

$intR = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $intQ.entry; onConflict = "overwrite" }
$intRes = @($intR.files)[0]
Assert-True (-not (Test-Path -LiteralPath $intFile))            "THE ASSERTION THIS EXISTS FOR: a tampered payload is NOT written back to disk"
Assert-True ($intRes.status -eq "failed")                       "the file is reported as failed rather than restored"
Assert-True ($intR.failed -ge 1)                                "and counted in the entry's failed total, so the layer above cannot read this as a clean restore"
Assert-True ($intRes.error -match "has changed since it was quarantined") "with a reason that names what happened rather than a generic failure"
Assert-True (Test-Path -LiteralPath $intPayload)                "and the payload is left in the vault to inspect, not deleted on the way out"

# The clean case must still work, or this is not a fix.
$cleanFile = Join-Path $fixtures "integrity-clean.dat"
Set-Content -Path $cleanFile -Value "UNTOUCHED-CONTENT" -Encoding ASCII
$cleanId = [guid]::NewGuid().ToString()
$cleanQ = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = $cleanId; sourceApp = "IntegrityVerify"
    files = @(@{ path = $cleanFile }); registry = @()
}
$cleanR = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $cleanQ.entry; onConflict = "skip" }
$cleanRes = @($cleanR.files)[0]
Assert-True ($cleanRes.status -eq "restored")                   "an untampered payload still restores"
Assert-True ($cleanRes.verified -eq $true)                      "and says so explicitly - verified is a claim the vault now earns"
Assert-True ((Get-Content -LiteralPath $cleanFile -Raw).Trim() -eq "UNTOUCHED-CONTENT") "with its content intact"

# Directories are hashed as a tree, so a change anywhere inside one is caught.
$intDir = Join-Path $fixtures "IntegrityApp"
$null = New-Item -ItemType Directory -Path $intDir -Force
Set-Content -Path (Join-Path $intDir "config.ini") -Value "[settings]" -Encoding ASCII
Set-Content -Path (Join-Path $intDir "data.bin")   -Value "payload"    -Encoding ASCII
$dirId = [guid]::NewGuid().ToString()
$dirQ = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = $dirId; sourceApp = "IntegrityVerify"
    files = @(@{ path = $intDir }); registry = @()
}
$dirRow = @($dirQ.entry.files)[0]
Assert-True ($dirRow.hashAlgo -eq "SHA256-TREE")                "a quarantined DIRECTORY is hashed as a tree, not skipped"
$dirInner = Join-Path (Join-Path (Join-Path $vaultRoot $dirId) "files\1\IntegrityApp") "config.ini"
Set-Content -LiteralPath $dirInner -Value "[tampered]" -Encoding ASCII
$dirR = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $dirQ.entry; onConflict = "overwrite" }
Assert-True (-not (Test-Path -LiteralPath $intDir))             "and one changed file inside it is enough to refuse the whole restore"

# An entry from before hashing existed must NOT be stranded.
$legacyFile = Join-Path $fixtures "legacy.dat"
Set-Content -Path $legacyFile -Value "LEGACY-CONTENT" -Encoding ASCII
$legacyId = [guid]::NewGuid().ToString()
$legacyQ = Invoke-Engine "quarantine-items" @{
    vaultRoot = $vaultRoot; entryId = $legacyId; sourceApp = "IntegrityVerify"
    files = @(@{ path = $legacyFile }); registry = @()
}
$legacyEntry = $legacyQ.entry | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$legacyEntry.files[0].contentHash = $null
$legacyEntry.files[0].hashAlgo    = $null
$legacyR = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $legacyEntry; onConflict = "skip" }
$legacyRes = @($legacyR.files)[0]
Assert-True ($legacyRes.status -eq "restored")                  "an entry with no recorded hash still restores - refusing those would strand every vault that predates this"
Assert-True ($legacyRes.verified -eq $false)                    "but is NOT reported as verified, because nothing was checked"
Assert-True ($legacyRes.verifyNote -match "predates content hashing") "and the note says which of the two it is, rather than leaving 'not verified' to mean either"

# --- Cleanup --------------------------------------------------------------
if (Test-Path $regKey) { Remove-Item $regKey -Recurse -Force }
Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
