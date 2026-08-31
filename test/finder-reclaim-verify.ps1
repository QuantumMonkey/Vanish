# Reclaim by marker (piu). Read-only in both tiers - the finders under test
# are audit-only by design (Module 1 / aeu), so this suite never elevates and
# never needs Full Mode.
#
# Two rules are under test, and both are load-bearing for every one of the
# five reclaim-*.finder.ps1 files:
#
#   RULE 1 - DETECT BY PROJECT MARKER, NEVER BY FOLDER NAME. A node_modules,
#   build/, .dart_tool/ or .gradle/ is only ever proposed when the file that
#   regenerates it (package.json, pubspec.yaml, gradlew) is visible in the
#   same directory. The regression that matters most here is the NEGATIVE
#   case - a bare node_modules with nobody's package.json beside it is
#   somebody's DATA, not a build output, and this suite asserts it is left
#   alone, not just that the positive case works.
#
#   RULE 2 - EVERY PROPOSAL STATES ITS REBUILD COST, and finders/_contract.ps1
#   already enforces half of this in code: New-Finding THROWS if a
#   removal-proposing finding (action -ne 'audit') omits rebuildCost. This
#   suite asserts that enforcement directly, and separately asserts the
#   stronger policy this module holds itself to even for audit-only findings:
#   every finding this suite's five finders produce carries a real
#   rebuildCost string and a costClass that is not 'unknown'.
#
# aeu's three-state rule also applies to these finders like any other: a
# directory that could not be enumerated must yield 'could-not-look', never
# 'nothing'. piu.6 constructs that case with an ACL deny (no elevation
# needed - an owner can deny themselves list/read access to their own
# directory and still delete it afterward) and asserts the premise before
# the real check, per this suite's brief: if the deny does not actually
# block enumeration on this machine/account, the section SKIPs with a
# measured reason rather than passing vacuously.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-reclaim-verify.ps1

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
    # 8ok (cleanerml-verify.ps1's own note, still true here): stdout is
    # supposed to carry one JSON document and nothing else, but powershell.exe
    # writes WARNING/VERBOSE/DEBUG to STDOUT too - report what actually
    # arrived rather than dying on a raw parser exception with no Result line.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

function Get-ReclaimResult {
    # One finder's typed result out of a hygiene-scan envelope.
    param($envelope, [string]$finderName)
    return @($envelope.results | Where-Object { $_.finder -eq $finderName })[0]
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish reclaim-by-marker verification (piu)" -ForegroundColor Cyan
Write-Host "============================================"
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

# ======================================================================
# Fixtures - a small tree per rule/finder, built here and torn down in
# finally. Nothing here is vendored third-party content; every file is a
# few bytes this test wrote for itself.
# ======================================================================
$work = Join-Path $env:TEMP "vanish-reclaim-verify"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $work -Force

# --- Node: with marker (proposed) and without marker (regression) ---
$nodeWith    = Join-Path $work "node-with-marker"
$nodeWithout = Join-Path $work "node-without-marker"
$null = New-Item -ItemType Directory -Path (Join-Path $nodeWith "node_modules\pkg") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $nodeWith "dist") -Force
Set-Content -LiteralPath (Join-Path $nodeWith "package.json") -Value '{"name":"fixture"}'
Set-Content -LiteralPath (Join-Path $nodeWith "package-lock.json") -Value '{}'
Set-Content -LiteralPath (Join-Path $nodeWith "node_modules\pkg\index.js") -Value "module.exports = 1;"
Set-Content -LiteralPath (Join-Path $nodeWith "dist\bundle.js") -Value "console.log(1);"
$null = New-Item -ItemType Directory -Path (Join-Path $nodeWithout "node_modules\pkg") -Force
Set-Content -LiteralPath (Join-Path $nodeWithout "node_modules\pkg\index.js") -Value "module.exports = 1;"
# Deliberately NO package.json anywhere under $nodeWithout.

# --- Flutter: with marker (proposed) and without any marker (regression) ---
$flutterWith    = Join-Path $work "flutter-with-marker"
$flutterWithout = Join-Path $work "flutter-without-marker"
$null = New-Item -ItemType Directory -Path (Join-Path $flutterWith "build") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $flutterWith ".dart_tool") -Force
Set-Content -LiteralPath (Join-Path $flutterWith "pubspec.yaml") -Value "name: fixture`n"
Set-Content -LiteralPath (Join-Path $flutterWith "build\out.bin") -Value "built"
Set-Content -LiteralPath (Join-Path $flutterWith ".dart_tool\pkg_config.json") -Value "{}"
$null = New-Item -ItemType Directory -Path (Join-Path $flutterWithout "build") -Force
Set-Content -LiteralPath (Join-Path $flutterWithout "build\out.bin") -Value "built"
# Deliberately NO pubspec.yaml and NO package.json under $flutterWithout.

# --- Gradle: with marker, so piu.3 has a real Gradle finding to check ---
$gradleWith = Join-Path $work "gradle-with-marker"
$null = New-Item -ItemType Directory -Path (Join-Path $gradleWith ".gradle") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $gradleWith "app\build") -Force
Set-Content -LiteralPath (Join-Path $gradleWith "gradlew") -Value "#!/bin/sh`necho fixture"
Set-Content -LiteralPath (Join-Path $gradleWith ".gradle\cache.bin") -Value "cache"
Set-Content -LiteralPath (Join-Path $gradleWith "app\build\app-debug.apk") -Value "apk"

# --- Archives: zip beside its own extracted dir, and an orphan zip ---
$archivesDir = Join-Path $work "archives"
$extracted   = Join-Path $archivesDir "MyApp"
$null = New-Item -ItemType Directory -Path $extracted -Force
Set-Content -LiteralPath (Join-Path $extracted "readme.txt") -Value "extracted content"
Compress-Archive -Path $extracted -DestinationPath (Join-Path $archivesDir "MyApp.zip") -Force
Set-Content -LiteralPath (Join-Path $archivesDir "Orphan.zip") -Value "not actually a zip, just needs to exist as a file with no sibling dir"

# --- Package cache: point npm's cache at a fixture dir so piu.3 has a real,
# deterministic finding for reclaim-package-caches regardless of what is or
# is not installed on the machine running this suite.
$npmCacheFixture = Join-Path $work "npm-cache-fixture"
$null = New-Item -ItemType Directory -Path $npmCacheFixture -Force
Set-Content -LiteralPath (Join-Path $npmCacheFixture "cached-package.tgz") -Value ("x" * 500)
$origNpmCache = [Environment]::GetEnvironmentVariable('npm_config_cache')
$env:npm_config_cache = $npmCacheFixture

try {
    # ==================================================================
    Write-Host ""
    Write-Host "piu.1 node_modules beside its package.json is proposed" -ForegroundColor Cyan

    $r1 = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-node'); roots = @($nodeWith) }) 'reclaim-node'
    Assert-True ($r1.state -eq 'found') "reclaim-node reports 'found' for a tree with a real package.json ($($r1.state))"
    $nmFinding = @($r1.findings | Where-Object { $_.path -eq (Join-Path $nodeWith "node_modules") })
    Assert-True ($nmFinding.Count -eq 1) "node_modules beside package.json is proposed exactly once"
    if ($nmFinding.Count -eq 1) {
        Assert-True ($nmFinding[0].action -eq 'audit') "and it is audit-only, matching Module 1's auditOnly finder registration"
        Assert-True ($nmFinding[0].costClass -eq 'cheap') "and node_modules beside a lockfile is classified 'cheap', matching the contract's own worked example"
        Assert-True ($nmFinding[0].evidence -match 'package\.json') "and the evidence names the marker, so the claim is checkable"
    }
    $distFinding = @($r1.findings | Where-Object { $_.path -eq (Join-Path $nodeWith "dist") })
    Assert-True ($distFinding.Count -eq 1) "dist beside the same package.json is also proposed"

    # ==================================================================
    Write-Host ""
    Write-Host "piu.2 node_modules with NO package.json beside it is NOT proposed (rule 1 regression)" -ForegroundColor Cyan

    $r2 = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-node'); roots = @($nodeWithout) }) 'reclaim-node'
    Assert-True ($r2.state -eq 'nothing') "a node_modules with no package.json anywhere above it yields 'nothing', not 'found' - node_modules is somebody's DATA without the marker that proves it is regenerable, and treating it as removable would be exactly the folder-name-only mistake rule 1 exists to prevent"
    Assert-True ($r2.findingCount -eq 0) "and there are zero findings to back that up"

    # ==================================================================
    Write-Host ""
    Write-Host "piu.4 a build/ beside pubspec.yaml is proposed; a build/ beside neither marker is not" -ForegroundColor Cyan

    $r4a = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-flutter'); roots = @($flutterWith) }) 'reclaim-flutter'
    $buildFinding = @($r4a.findings | Where-Object { $_.path -eq (Join-Path $flutterWith "build") })
    Assert-True ($buildFinding.Count -eq 1) "build/ beside pubspec.yaml is proposed"
    $dartToolFinding = @($r4a.findings | Where-Object { $_.path -eq (Join-Path $flutterWith ".dart_tool") })
    Assert-True ($dartToolFinding.Count -eq 1) ".dart_tool beside the same pubspec.yaml is also proposed"

    # Neither pubspec.yaml NOR package.json exist under $flutterWithout - so
    # neither the Flutter finder nor the Node finder (which also treats
    # 'build' as a candidate) may propose it.
    $r4bFlutter = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-flutter'); roots = @($flutterWithout) }) 'reclaim-flutter'
    Assert-True ($r4bFlutter.state -eq 'nothing') "a build/ with no pubspec.yaml anywhere above it is not proposed by reclaim-flutter ($($r4bFlutter.state))"
    $r4bNode = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-node'); roots = @($flutterWithout) }) 'reclaim-node'
    Assert-True ($r4bNode.state -eq 'nothing') "and the same build/ is not proposed by reclaim-node either, since no package.json exists there ($($r4bNode.state))"

    # ==================================================================
    Write-Host ""
    Write-Host "piu.5 a *.zip beside its own extracted directory is proposed; an orphan zip is not" -ForegroundColor Cyan

    $r5 = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-archives'); roots = @($archivesDir) }) 'reclaim-archives'
    $zipFinding = @($r5.findings | Where-Object { $_.path -eq (Join-Path $archivesDir "MyApp.zip") })
    Assert-True ($zipFinding.Count -eq 1) "MyApp.zip beside the extracted MyApp\ directory is proposed"
    if ($zipFinding.Count -eq 1) {
        Assert-True ($zipFinding[0].costClass -eq 'cheap') "and it is classified cheap - the extracted copy already holds everything, so recreating the zip is trivial"
        Assert-True ($zipFinding[0].evidence -match 'MyApp') "and the evidence names the sibling directory that makes it redundant"
    }
    $orphanFinding = @($r5.findings | Where-Object { $_.path -eq (Join-Path $archivesDir "Orphan.zip") })
    Assert-True ($orphanFinding.Count -eq 0) "Orphan.zip has no matching extracted directory beside it, so it is left alone - it is the only copy, not a redundant one"

    # ==================================================================
    Write-Host ""
    Write-Host "piu.3 every finding from every reclaim finder states rebuildCost and a real costClass" -ForegroundColor Cyan

    $allFinders = @('reclaim-node', 'reclaim-flutter', 'reclaim-gradle', 'reclaim-package-caches', 'reclaim-archives')
    $combined = Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = $allFinders; roots = @($work) }
    Assert-True ($combined.success -eq $true) "the combined scan across all five reclaim finders completes"

    foreach ($finderName in $allFinders) {
        $fr = Get-ReclaimResult $combined $finderName
        Assert-True ($null -ne $fr) "finder '$finderName' reports a result in the combined scan"
        if ($null -eq $fr) { continue }

        $findingsHere = @($fr.findings)
        Assert-True ($findingsHere.Count -gt 0) "'$finderName' produced at least one finding against this suite's fixtures, so rule 2 is actually exercised, not vacuously true"

        $allCosted = $true
        $allClassed = $true
        foreach ($f in $findingsHere) {
            if ([string]::IsNullOrWhiteSpace($f.rebuildCost)) { $allCosted = $false }
            if ([string]::IsNullOrWhiteSpace($f.costClass) -or $f.costClass -eq 'unknown') { $allClassed = $false }
        }
        Assert-True $allCosted "every '$finderName' finding ($($findingsHere.Count)) carries a non-empty rebuildCost"
        Assert-True $allClassed "every '$finderName' finding ($($findingsHere.Count)) has a costClass that is not 'unknown'"
    }

    # ==================================================================
    Write-Host ""
    Write-Host "piu.6 a tree that cannot be enumerated yields could-not-look, not nothing (aeu)" -ForegroundColor Cyan

    $aclWork = Join-Path $work "acl-probe"
    $blockedDir = Join-Path $aclWork "blocked"
    $null = New-Item -ItemType Directory -Path $blockedDir -Force
    Set-Content -LiteralPath (Join-Path $blockedDir "package.json") -Value '{"name":"unreachable"}'

    # ASSERT THE PREMISE FIRST: an owner can deny themselves list/read access
    # to their own directory without elevation (and can always restore it
    # afterward via WRITE_DAC, which owners retain regardless of the deny) -
    # but this depends on the account/filesystem this suite happens to run
    # under, so the premise is verified with a real probe before the actual
    # assertion runs, per this suite's brief and test/security-verify.ps1's
    # own SKIP pattern for the same kind of environment-dependent setup.
    $premiseHolds = $false
    $premiseDetail = ''
    try {
        $icaclsOut = & icacls.exe $blockedDir /deny "$($env:USERNAME):(OI)(CI)(RX)" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE - $($icaclsOut -join ' ')" }
        $probeErr = $null
        $null = Get-ChildItem -LiteralPath $blockedDir -ErrorAction SilentlyContinue -ErrorVariable +probeErr
        $premiseHolds = (@($probeErr).Count -gt 0)
        if (-not $premiseHolds) { $premiseDetail = 'the deny ACE was applied but enumeration still succeeded on this account' }
    } catch {
        $premiseDetail = $_.Exception.Message
    }

    if (-not $premiseHolds) {
        Write-Host "  SKIP  could not construct a directory this account cannot enumerate without elevation ($premiseDetail) - piu.6 asserts its premise before the real check rather than passing vacuously" -ForegroundColor Yellow
    } else {
        $r6 = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-node'); roots = @($aclWork) }) 'reclaim-node'
        Assert-True ($r6.state -eq 'could-not-look') "a root containing a directory that cannot be enumerated yields 'could-not-look', never 'nothing' ($($r6.state))"
        Assert-True ($r6.unreadableCount -gt 0) "and the unreadable directory is recorded, not silently dropped"
        Assert-True ($r6.findingCount -eq 0) "with zero findings - the state, not an empty finding list, is what tells the caller this run is untrustworthy"
    }

    # Reset the ACL before this section's own cleanup and before the outer
    # Remove-Item runs, regardless of which branch above executed.
    try { & icacls.exe $blockedDir /reset /T 2>&1 | Out-Null } catch { }

    # ==================================================================
    Write-Host ""
    Write-Host "gkib A partly-unreadable cache is reported as a FLOOR, not discarded" -ForegroundColor Cyan
    # This used to record the unreadable location and then `continue`, so one
    # subdirectory Windows would not enumerate dropped the entire cache out of
    # the findings. On the operator machine that removed a 14.35 GB Gradle
    # cache - the largest reclaim target on the disk - and reported
    # could-not-look instead. aeu was satisfied and the operator was still
    # worse off: "at least 12 GB, one folder could not be read" is equally
    # honest and actually useful.
    $gkWork  = Join-Path $env:TEMP "vanish-gkib-verify"
    if (Test-Path -LiteralPath $gkWork) { & icacls.exe $gkWork /reset /T 2>&1 | Out-Null; Remove-Item -LiteralPath $gkWork -Recurse -Force -ErrorAction SilentlyContinue }
    $gkCache = Join-Path $gkWork "npm-cache"
    $null = New-Item -ItemType Directory -Path (Join-Path $gkCache "readable") -Force
    # Big enough that Format-PiuCacheBytes prints something other than 0.
    Set-Content -LiteralPath (Join-Path $gkCache "readable\payload.bin") -Value ("x" * 200000) -Encoding ASCII
    $gkBlocked = Join-Path $gkCache "blocked"
    $null = New-Item -ItemType Directory -Path $gkBlocked -Force
    Set-Content -LiteralPath (Join-Path $gkBlocked "hidden.bin") -Value ("y" * 50000) -Encoding ASCII

    $gkPremise = $false
    $gkWhy = ''
    try {
        $o = & icacls.exe $gkBlocked /deny "$($env:USERNAME):(OI)(CI)(RX)" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE - $($o -join ' ')" }
        $pe = $null
        $null = Get-ChildItem -LiteralPath $gkBlocked -ErrorAction SilentlyContinue -ErrorVariable +pe
        $gkPremise = (@($pe).Count -gt 0)
        if (-not $gkPremise) { $gkWhy = 'the deny ACE was applied but enumeration still succeeded on this account' }
    } catch { $gkWhy = $_.Exception.Message }

    if (-not $gkPremise) {
        Write-Host "  SKIP  could not construct a cache directory this account cannot fully read ($gkWhy) - an elevated session reads through a Deny ACE, so this case needs an unelevated run" -ForegroundColor Yellow
    } else {
        # The finder resolves its cache path from the redirect variable first,
        # and the engine is a child process, so setting it here reaches it.
        $gkSaved = [Environment]::GetEnvironmentVariable('npm_config_cache')
        $env:npm_config_cache = $gkCache
        try {
            $gk = Get-ReclaimResult (Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('reclaim-package-caches'); roots = @($gkWork) }) 'reclaim-package-caches'
            $npmFinding = @(@($gk.findings) | Where-Object { $_.path -eq $gkCache })[0]

            Assert-True ($null -ne $npmFinding) "the cache is still REPORTED even though part of it could not be read"
            if ($null -ne $npmFinding) {
                Assert-True ($npmFinding.bytes -gt 0) "and it carries the bytes that WERE readable ($($npmFinding.bytes))"
                Assert-True ($npmFinding.title -like '*at least*') "and its title says the number is a floor (title: $($npmFinding.title))"
                Assert-True ($npmFinding.evidence -like '*FLOOR*') "and the evidence says so too, so the number is never read as a total"
            }
            Assert-True ($gk.unreadableCount -gt 0) "the unreadable location is STILL recorded - reporting a floor does not hide what could not be read"
            Assert-True ($gk.state -eq 'found') "and the state is 'found', because something WAS found ($($gk.state))"
        } finally {
            if ($null -eq $gkSaved) { Remove-Item Env:\npm_config_cache -ErrorAction SilentlyContinue }
            else { $env:npm_config_cache = $gkSaved }
        }
    }
    try { & icacls.exe $gkWork /reset /T 2>&1 | Out-Null } catch { }
    Remove-Item -LiteralPath $gkWork -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    Write-Host ""
    Write-Host "piu.7 New-Finding enforces rebuildCost in code, not just in convention" -ForegroundColor Cyan

    . (Join-Path $root "finders\_contract.ps1")

    $threw = $false
    $threwMessage = ''
    try {
        New-Finding -id 'piu-verify-throw' -title 'x' -action 'quarantine' -rebuildCost '' | Out-Null
    } catch {
        $threw = $true
        $threwMessage = $_.Exception.Message
    }
    Assert-True $threw "New-Finding throws when action is not 'audit' and rebuildCost is empty"
    Assert-True ($threwMessage -match 'rebuildCost') "and the thrown message names rebuildCost, not just 'action' - so the failure points at the actual omission"

    $auditThrew = $false
    try {
        New-Finding -id 'piu-verify-no-throw' -title 'x' -action 'audit' -rebuildCost '' | Out-Null
    } catch {
        $auditThrew = $true
    }
    Assert-True (-not $auditThrew) "an audit-only finding (action 'audit') does not require rebuildCost by the contract - this suite's own finders populate it anyway (piu.3), which is a stricter policy than the contract enforces"
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($origNpmCache)) {
        $env:npm_config_cache = $origNpmCache
    } else {
        Remove-Item Env:\npm_config_cache -ErrorAction SilentlyContinue
    }

    $blockedDirCleanup = Join-Path (Join-Path $work "acl-probe") "blocked"
    if (Test-Path -LiteralPath $blockedDirCleanup) {
        try { & icacls.exe $blockedDirCleanup /reset /T 2>&1 | Out-Null } catch { }
    }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
