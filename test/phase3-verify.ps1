# Phase 3 Verify: TASK-10 (Rule 15 switch chain), TASK-12 (restore point
# frequency override), and the REQ-12 msiserver checks.
# The queue state machine itself is verified by test/queue-verify.js.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\phase3-verify.ps1

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

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish phase 3 verification" -ForegroundColor Cyan
Write-Host "==========================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

# ======================================================================
# TASK-10: Rule 15 lookup chain
# ======================================================================
Write-Host ""
Write-Host "TASK-10 switch lookup chain (REQ-10, Rule 15, ENT-03)" -ForegroundColor Cyan

$corrections = Get-Content (Join-Path $root "corrections.json") -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-True ($corrections.schemaVersion -eq 1)      "corrections.json carries schemaVersion (schema rule 2)"
Assert-True (@($corrections.apps).Count -ge 7)      "corrections.json is seeded, not empty ($(@($corrections.apps).Count) entries)"
Assert-True (@($corrections.apps | Where-Object { -not $_.silentArgs }).Count -eq 0) "every correction has silentArgs"
Assert-True (@($corrections.apps | Where-Object { -not $_.source }).Count -eq 0)     "every correction records its provenance"

# Branch 1: a corrections hit.
$hit = Invoke-Engine "resolve-uninstall-args" @{
    displayName     = "VLC media player 3.0.20"
    publisher       = "VideoLAN"
    uninstallString = '"C:\Program Files\VideoLAN\VLC\uninstall.exe"'
}
Assert-True ($hit.success -eq $true)                "corrections branch resolved"
Assert-True ($hit.method -eq "corrections")         "method is reported as corrections"
Assert-True ($hit.arguments -eq "/S")               "verified switch string returned"
Assert-True ($hit.matchedName -eq "VLC media player") "the matched rule is named for logging"
Assert-True ($hit.executable -eq "C:\Program Files\VideoLAN\VLC\uninstall.exe") "quoted executable parsed out of the uninstall string"

# Publisher narrowing must reject a same-name different-publisher app.
$wrongPublisher = Invoke-Engine "resolve-uninstall-args" @{
    displayName     = "Zoom Player"
    publisher       = "Inmatrix"
    uninstallString = '"C:\Program Files\Zoom Player\uninstall.exe"'
}
Assert-True ($wrongPublisher.method -eq "heuristic") "publisher mismatch does NOT take the Zoom correction"

# Branch 2: a heuristic-fallback miss.
$miss = Invoke-Engine "resolve-uninstall-args" @{
    displayName     = "Some Unlisted Utility 2.1"
    publisher       = "Nobody In Particular"
    uninstallString = '"C:\Program Files\Unlisted\uninst.exe"'
}
Assert-True ($miss.success -eq $true)               "heuristic branch resolved"
Assert-True ($miss.method -eq "heuristic")          "method is reported as heuristic"
Assert-True (@($miss.candidates).Count -ge 1)       "an ordered candidate sequence came back"
Assert-True (-not (@($miss.candidates) -contains "/qn")) "msiexec-only /qn is not offered to a non-MSI uninstaller"
Assert-True ($miss.detectedType -eq "nsis")         "installer type detected from the uninstaller name"

# MSI normalisation.
$msi = Invoke-Engine "resolve-uninstall-args" @{
    displayName     = "Some MSI Package"
    publisher       = "Contoso"
    uninstallString = 'MsiExec.exe /I{90140000-0011-0000-0000-0000000FF1CE}'
}
Assert-True ($msi.detectedType -eq "msi")           "MSI uninstall string detected"
Assert-True ($msi.baseArgs -match '^/x \{')         "MSI /I normalised to /x for uninstall"
Assert-True ($msi.arguments -match '/qn')           "MSI gets the /qn quiet switch"
Assert-True ($msi.arguments -match '/norestart')    "MSI gets /norestart so a reboot is our decision"

# Unquoted paths with spaces must not split at the first space.
$unquoted = Invoke-Engine "resolve-uninstall-args" @{
    displayName     = "Spacey App"
    publisher       = "Test"
    uninstallString = 'C:\Program Files\Spacey App\uninstall.exe /flag'
}
Assert-True ($unquoted.executable -eq "C:\Program Files\Spacey App\uninstall.exe") "unquoted path with spaces parsed at the .exe boundary"
Assert-True ($unquoted.baseArgs -eq "/flag")        "existing arguments preserved as baseArgs"

# A malformed corrections file must not break uninstalling (fail-open to heuristic).
$backup = Join-Path $env:TEMP "corrections.backup.json"
Copy-Item (Join-Path $root "corrections.json") $backup -Force
try {
    Set-Content -Path (Join-Path $root "corrections.json") -Value "{ this is not json" -Encoding ASCII
    $broken = Invoke-Engine "resolve-uninstall-args" @{
        displayName = "VLC media player"; publisher = "VideoLAN"
        uninstallString = '"C:\Program Files\VideoLAN\VLC\uninstall.exe"'
    }
    Assert-True ($broken.success -eq $true -and $broken.method -eq "heuristic") "a corrupt corrections.json falls through to the heuristic instead of failing"
} finally {
    Copy-Item $backup (Join-Path $root "corrections.json") -Force
    Remove-Item $backup -Force -ErrorAction SilentlyContinue
}

# ======================================================================
# REQ-12: msiserver
# ======================================================================
Write-Host ""
Write-Host "REQ-12 installer service manager" -ForegroundColor Cyan
$msiState = Invoke-Engine "msiserver-state"
Assert-True ($msiState.success -eq $true)           "msiserver state readable"
Assert-True ($null -ne $msiState.startMode)         "start mode reported ($($msiState.startMode))"
Assert-True ($null -ne $msiState.usable)            "usability computed for the queue pre-flight"

if (-not $isAdmin) {
    $denied = Invoke-Engine "msiserver-set" @{ startMode = "Manual" }
    Assert-True ($denied.success -eq $false)        "msiserver-set refuses to run in Audit Mode"
}

# ======================================================================
# TASK-12: restore point frequency override
# ======================================================================
Write-Host ""
Write-Host "TASK-12 restore point frequency override (REQ-13)" -ForegroundColor Cyan

$srKey  = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore"
$srName = "SystemRestorePointCreationFrequency"

function Get-SrFrequency {
    $v = Get-ItemProperty -Path $srKey -Name $srName -ErrorAction SilentlyContinue
    if ($v -and $null -ne $v.$srName) { return [int]$v.$srName }
    return $null
}

if (-not $isAdmin) {
    $denied = Invoke-Engine "restore-point" @{ description = "Vanish verify" }
    Assert-True ($denied.success -eq $false)        "restore-point refuses to run in Audit Mode"
    Write-Host "  SKIP  consecutive-checkpoint assertion needs Full Mode" -ForegroundColor Yellow
} else {
    # "Zero restore points exist" does NOT mean protection is off - it is also
    # the state right after enabling it. The only reliable probe is to try.
    $before = Get-SrFrequency
    $srEnabled = $false
    try {
        Checkpoint-Computer -Description "Vanish protection probe" -RestorePointType APPLICATION_UNINSTALL -ErrorAction Stop
        $srEnabled = $true
    } catch {
        if ($_.Exception.Message -match "already been created") { $srEnabled = $true }
    }

    if (-not $srEnabled) {
        Write-Host "  SKIP  System Protection is off on this machine - cannot create restore points" -ForegroundColor Yellow
        Write-Host "        (the override + restore logic below is still checked)" -ForegroundColor DarkGray
    }

    $countBefore = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue).Count
    $rp1 = Invoke-Engine "restore-point" @{ description = "Vanish verify 1" }
    $rp2 = Invoke-Engine "restore-point" @{ description = "Vanish verify 2" }
    $countAfter = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue).Count
    $after = Get-SrFrequency

    Assert-True ($after -eq $before) "creation-frequency value restored to its prior state (before=$before after=$after)"

    # A machine that already sits at 0 makes the check above vacuous. Plant a
    # distinctive value and prove the finally path puts exactly it back.
    $sentinel = 1440
    try {
        Set-ItemProperty -Path $srKey -Name $srName -Value $sentinel -Type DWord -ErrorAction Stop
        $null = Invoke-Engine "restore-point" @{ description = "Vanish verify sentinel" }
        Assert-True ((Get-SrFrequency) -eq $sentinel) "a non-zero prior value ($sentinel) is restored exactly, not zeroed"
    } finally {
        if ($null -eq $before) { Remove-ItemProperty -Path $srKey -Name $srName -ErrorAction SilentlyContinue }
        else { Set-ItemProperty -Path $srKey -Name $srName -Value $before -Type DWord -ErrorAction SilentlyContinue }
    }

    # And when the value did not exist at all, it must not be left behind.
    $hadValue = $null -ne (Get-SrFrequency)
    if ($hadValue) {
        $saved = Get-SrFrequency
        Remove-ItemProperty -Path $srKey -Name $srName -ErrorAction SilentlyContinue
        $null = Invoke-Engine "restore-point" @{ description = "Vanish verify absent" }
        Assert-True ($null -eq (Get-SrFrequency)) "an absent value is removed again, not left at 0"
        Set-ItemProperty -Path $srKey -Name $srName -Value $saved -Type DWord -ErrorAction SilentlyContinue
    }

    if ($srEnabled) {
        Assert-True ($rp1.success -eq $true -and $rp2.success -eq $true) "both consecutive checkpoint calls succeeded"
        Assert-True ($countAfter -ge $countBefore + 2) "two back-to-back restore points were actually created ($countBefore -> $countAfter)"
    } else {
        Assert-True ($rp1.frequencyOverridden -eq $true -or $rp1.success -eq $false) "override was attempted even with protection disabled"
    }
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
