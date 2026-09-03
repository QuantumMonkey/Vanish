# Engine half of the install-date provenance rule (c0y, extended by mp31).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\install-date-source-verify.ps1
#
# test/install-date-provenance-verify.js covers the RENDERER half: that an
# inferred date is visibly and textually distinguishable from a recorded one.
# This covers the half that decides whether there is a date at all.
#
# mp31 measured 40 of 150 real desktop entries with no install date, 13 of them
# holding an InstallLocation that exists on a local disk. The 'folder-created'
# source already existed and was wired up for Store apps alone. Extending it to
# desktop entries is one line; the reason this file exists is the three refusals
# around that line, each of which would otherwise state a fabricated date as the
# program's own.
#
# Asked through the engine's install-date-probe rather than a reimplementation
# of the rule here, for the reason test/mutation/README.md gives: a mirror of a
# product function drifts from it and then reports confidently about code that
# no longer exists.

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([bool]$condition, [string]$label, [string]$detail = "")
    if ($condition) {
        Write-Host "  PASS  $label" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
        $script:fail++
    }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params = @{})
    $b64 = [System.Convert]::ToBase64String(
        [System.Text.Encoding]::UTF8.GetBytes(($params | ConvertTo-Json -Depth 8 -Compress)))
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    $text = ($out -join "`n")

    # DO NOT collapse this into `try { return $text | ConvertFrom-Json }`, which
    # is the shape every other suite's copy of this helper uses. `return` from
    # INSIDE a try block does not unroll an array into the output stream, so an
    # action whose payload is a JSON array comes back wrapped: @(...) at the
    # call site then reports Count = 1 and every per-item assertion silently
    # evaluates against the whole array as one object. Measured here on
    # list-desktop: 1 instead of 150. The other suites are unaffected only
    # because they read a property off an object payload; this is the first one
    # to ask for a top-level array.
    $parsed = $null
    try { $parsed = $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
    return $parsed
}

function Get-FolderDate {
    param([string]$path)
    return [string](Invoke-Engine "install-date-probe" @{ path = $path }).date
}

Write-Host ""
Write-Host "Install date: where the engine will and will not get one" -ForegroundColor Cyan
Write-Host "======================================================="

$work = Join-Path $env:TEMP "vanish-installdate-verify"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$null = New-Item -ItemType Directory -Path $work -Force

try {
    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "It answers for a real local folder" -ForegroundColor Cyan

    $real = Join-Path $work "installed-app"
    $null = New-Item -ItemType Directory -Path $real -Force
    $expected = ([System.IO.Directory]::GetCreationTime($real)).ToString('yyyy-MM-dd')

    $got = Get-FolderDate $real
    Assert-True ($got -eq $expected) `
        "a folder that exists yields its creation date in yyyy-MM-dd" `
        "expected '$expected', got '$got'"

    Assert-True ($got -match '^\d{4}-\d{2}-\d{2}$') `
        "and the shape matches what Format-InstallDate produces, so the two sources sort together" `
        "got '$got'"

    # Quoted and trailing-slash forms both occur in real InstallLocation values.
    Assert-True ((Get-FolderDate ('"' + $real + '"')) -eq $expected) `
        "a quoted InstallLocation is handled, because installers write them that way"
    Assert-True ((Get-FolderDate ($real + '\')) -eq $expected) `
        "and so is a trailing separator"

    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "It refuses rather than inventing (each refusal is a fabricated date avoided)" -ForegroundColor Cyan

    $missing = Join-Path $work "uninstalled-but-registry-entry-remains"
    Assert-True ([string]::IsNullOrEmpty((Get-FolderDate $missing))) `
        "a path that does not exist yields nothing - a leftover registry entry is not dated from a folder that is gone" `
        "got '$(Get-FolderDate $missing)'"

    Assert-True ([string]::IsNullOrEmpty((Get-FolderDate '\\some-share-that-is-not-here\apps\thing'))) `
        "a UNC path yields nothing, so a dead share cannot block the list that has to load in seconds"

    # THAT ASSERTION ALONE CANNOT FAIL, and mutation testing said so: deleting
    # the UNC guard leaves it green, because Directory.Exists on a share that
    # is not there returns $false and the date is null either way. What the
    # guard actually prevents is the WAIT - measured at 1,258 ms for that one
    # dead path, on a list that has to load in seconds.
    #
    # So the mutant-distinguishing case needs a UNC path that DOES resolve.
    # The admin share is the one every Windows machine has without setting
    # anything up; it needs elevation to read, so this states its premise and
    # skips rather than passing vacuously when it cannot.
    $liveUnc = "\\localhost\C`$\Windows"
    if ([System.IO.Directory]::Exists($liveUnc)) {
        Assert-True ([string]::IsNullOrEmpty((Get-FolderDate $liveUnc))) `
            "a UNC path that DOES resolve is still refused - the rule is the path shape, not whether the share answers" `
            "got '$(Get-FolderDate $liveUnc)'"
    } else {
        Write-Host "  SKIP  live-UNC case: $liveUnc is not reachable from this session (needs elevation)" -ForegroundColor DarkYellow
    }

    Assert-True ([string]::IsNullOrEmpty((Get-FolderDate 'Program Files\Thing'))) `
        "a relative path yields nothing, rather than resolving against the ENGINE's working directory and dating an unrelated folder"

    Assert-True ([string]::IsNullOrEmpty((Get-FolderDate ''))) `
        "an empty InstallLocation yields nothing"

    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "The real enumeration uses it, and only where it should" -ForegroundColor Cyan
    # Reads this machine's actual entries. It asserts the RULE, not a count:
    # a recorded date must never be relabelled, and an inferred one must never
    # arrive without its source.

    $apps = @(Invoke-Engine "list-desktop")
    Assert-True ($apps.Count -gt 0) "premise: this machine has desktop entries to check ($($apps.Count))"

    $dated = @($apps | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.installDate) })
    $sourceless = @($dated | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.installDateSource) })
    Assert-True ($sourceless.Count -eq 0) `
        "every entry that has a date also says where the date came from" `
        "sourceless: $(@($sourceless | ForEach-Object { $_.name }) -join ' | ')"

    $known = @('recorded', 'key-name', 'folder-created')
    $odd = @($dated | Where-Object { $known -notcontains [string]$_.installDateSource })
    Assert-True ($odd.Count -eq 0) `
        "and it is one of the three the renderer knows how to label" `
        "unknown sources: $(@($odd | ForEach-Object { $_.installDateSource }) -join ' | ')"

    $undated = @($apps | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.installDate) })
    $shouldHave = @($undated | Where-Object {
        $p = ([string]$_.installLocation).Trim().Trim('"').TrimEnd('\')
        $p.Length -ge 3 -and -not $p.StartsWith('\\') -and $p -match '^[A-Za-z]:[\\/]' -and [System.IO.Directory]::Exists($p)
    })
    Assert-True ($shouldHave.Count -eq 0) `
        "no entry is left Unknown while holding an install folder that exists - the mp31 recovery is actually applied" `
        "missed: $(@($shouldHave | ForEach-Object { $_.name }) -join ' | ')"

    $folderDated = @($dated | Where-Object { [string]$_.installDateSource -eq 'folder-created' })
    $unbacked = @($folderDated | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.installLocation) })
    Assert-True ($unbacked.Count -eq 0) `
        "every folder-created date has an installLocation behind it ($($folderDated.Count) of $($apps.Count) entries)" `
        "unbacked: $(@($unbacked | ForEach-Object { $_.name }) -join ' | ')"

    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "A recorded date is never replaced by an inferred one (c0y's whole point)" -ForegroundColor Cyan
    # PLANTED, because the assertions above cannot see this. Mutation testing
    # found it: changing `if (-not $installDate)` to `if ($true)` - so every
    # entry with an install folder gets folder-created regardless of what the
    # installer recorded - was caught by NOTHING. Every reading above stayed
    # true, because each one only checks that a date carries a source, not that
    # the right source won.
    #
    # HKCU, because that is a per-user hive this account owns, the engine
    # enumerates it, and the fixture is removed in the finally below.

    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $recKey  = "$uninstallKey\VanishTestRecorded"
    $infKey  = "$uninstallKey\VanishTestInferred"
    $fixtureDir = Join-Path $work "planted-install-folder"
    $null = New-Item -ItemType Directory -Path $fixtureDir -Force
    $folderDate = ([System.IO.Directory]::GetCreationTime($fixtureDir)).ToString('yyyy-MM-dd')

    # A date that is real, in the past, and cannot collide with today's folder.
    $recordedRaw = '20010203'
    $recordedFmt = '2001-02-03'

    try {
        $null = New-Item -Path $recKey -Force
        Set-ItemProperty -Path $recKey -Name 'DisplayName'     -Value 'Vanish Test Recorded'
        Set-ItemProperty -Path $recKey -Name 'InstallDate'     -Value $recordedRaw
        Set-ItemProperty -Path $recKey -Name 'InstallLocation' -Value $fixtureDir

        $null = New-Item -Path $infKey -Force
        Set-ItemProperty -Path $infKey -Name 'DisplayName'     -Value 'Vanish Test Inferred'
        Set-ItemProperty -Path $infKey -Name 'InstallLocation' -Value $fixtureDir

        Assert-True ($recordedFmt -ne $folderDate) `
            "premise: the planted recorded date and the folder's creation date differ, so the two are distinguishable" `
            "recorded '$recordedFmt', folder '$folderDate'"

        $planted = @(Invoke-Engine "list-desktop")
        $rec = @($planted | Where-Object { [string]$_.name -eq 'Vanish Test Recorded' })[0]
        $inf = @($planted | Where-Object { [string]$_.name -eq 'Vanish Test Inferred' })[0]

        Assert-True ($null -ne $rec -and $null -ne $inf) "premise: both planted entries come back from the real enumeration"

        Assert-True ($null -ne $rec -and [string]$rec.installDate -eq $recordedFmt) `
            "an entry that RECORDED a date keeps it, even though its install folder exists and is newer" `
            "got '$($rec.installDate)'"
        Assert-True ($null -ne $rec -and [string]$rec.installDateSource -eq 'recorded') `
            "and it is still labelled recorded, not downgraded to an inference" `
            "got '$($rec.installDateSource)'"

        Assert-True ($null -ne $inf -and [string]$inf.installDate -eq $folderDate) `
            "an entry that recorded NO date gets the folder's creation date instead of Unknown" `
            "expected '$folderDate', got '$($inf.installDate)'"
        Assert-True ($null -ne $inf -and [string]$inf.installDateSource -eq 'folder-created') `
            "and it says folder-created, so the renderer marks it approximate" `
            "got '$($inf.installDateSource)'"
    }
    finally {
        foreach ($k in @($recKey, $infKey)) {
            if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
