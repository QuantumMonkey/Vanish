# Machine hygiene suite (bd vanish-uninstaller-pko): path-hygiene,
# redirect-variables, repo-health, profile-list, duplicate-installs.
#
# Module 2 HYGIENE, HANDOFF-2026-08-21 section 3: "finds wrongness, not
# waste." Every finding in this module is action = 'audit' -- nothing here
# proposes a removal, and this suite never writes to the real PATH, the real
# environment, or HKLM. Fixture repos are real, throwaway git repositories
# built under %TEMP%; this suite never runs a single git command against
# THIS repository.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-hygiene-verify.ps1

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"

$script:pass = 0
$script:fail = 0
$script:skip = 0

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Write-Skip {
    param([string]$reason)
    Write-Host "  SKIP  $reason" -ForegroundColor Yellow
    $script:skip++
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params = @{})
    $json = $params | ConvertTo-Json -Depth 10 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    # 8ok: powershell.exe writes WARNING/VERBOSE/DEBUG to STDOUT alongside the
    # one JSON document the engine is supposed to emit. Report what actually
    # arrived rather than dying on a raw parser exception with no Result line.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 400) { $text.Substring(0, 400) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

function Invoke-HygieneFinder {
    param([string]$finder, [hashtable]$extraParams = @{})
    $params = @{ module = "hygiene"; finders = @($finder) }
    foreach ($k in $extraParams.Keys) { $params[$k] = $extraParams[$k] }
    $scan = Invoke-Engine "hygiene-scan" $params
    return @($scan.results | Where-Object { $_.finder -eq $finder })[0]
}

function Invoke-FixtureGit {
    param([string]$repoPath, [string[]]$gitArgs)
    $fullArgs = @('-C', $repoPath) + $gitArgs
    $out = & git.exe @fullArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $text = ($out | ForEach-Object { [string]$_ }) -join "`n"
        throw "Fixture setup: 'git $($gitArgs -join ' ')' in '$repoPath' failed ($code): $text"
    }
    return $out
}

function New-FixtureRepo {
    param([string]$path)
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Invoke-FixtureGit $path @('init', '--quiet')
    Invoke-FixtureGit $path @('config', 'user.email', 'pko-verify@example.invalid')
    Invoke-FixtureGit $path @('config', 'user.name', 'pko verify')
    Set-Content -LiteralPath (Join-Path $path 'README.txt') -Value 'fixture' -Encoding ASCII
    Invoke-FixtureGit $path @('add', 'README.txt')
    Invoke-FixtureGit $path @('commit', '--quiet', '-m', 'initial commit')
    return $path
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish machine hygiene suite (pko)" -ForegroundColor Cyan
Write-Host "===================================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

$work = Join-Path $env:TEMP ("vanish-pko-verify-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $work -Force | Out-Null

$hkcuFixtureRoot = 'HKCU:\Software\VanishPkoHygieneVerifyFixture'

try {
    # ==================================================================
    # pko.0 - registration: all five finders load cleanly under module
    # 'hygiene', every one audit-only (Module 2's rule: nothing here
    # proposes a removal).
    # ==================================================================
    Write-Host ""
    Write-Host "pko.0 finder registration" -ForegroundColor Cyan

    $listProbe = Invoke-Engine "finder-probe" @{ mode = 'list' }
    Assert-True ($listProbe.success -eq $true) "finder-probe list succeeds"
    Assert-True (@($listProbe.loadErrors).Count -eq 0) "every finders/*.finder.ps1 file loads with no errors"

    $expectedNames = @('path-hygiene', 'redirect-variables', 'repo-health', 'profile-list', 'duplicate-installs')
    foreach ($name in $expectedNames) {
        $reg = @($listProbe.finders | Where-Object { $_.name -eq $name })
        Assert-True ($reg.Count -eq 1) "$name is registered exactly once"
        if ($reg.Count -eq 1) {
            Assert-True ($reg[0].module -eq 'hygiene') "$name is registered under module 'hygiene'"
            Assert-True ($reg[0].auditOnly -eq $true) "$name is registered audit-only"
        }
    }

    # ==================================================================
    # pko.1 - PATH hygiene
    # ==================================================================
    Write-Host ""
    Write-Host "pko.1 path-hygiene: cross-scope duplicates, broken entries, Downloads" -ForegroundColor Cyan

    $downloadsDir = Join-Path $work "Downloads\SomeTool"
    New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null
    $cleanDir = Join-Path $work "clean-tool"
    New-Item -ItemType Directory -Path $cleanDir -Force | Out-Null
    $brokenEntry = Join-Path $work "does-not-exist-123"

    $res1 = Invoke-HygieneFinder "path-hygiene" @{
        pathEntriesUser    = @("C:\Windows\System32", $downloadsDir, $brokenEntry, $cleanDir)
        pathEntriesMachine = @("C:\Windows\System32")
    }
    Assert-True ($null -ne $res1) "hygiene-scan returns a path-hygiene result"
    Assert-True ($res1.state -eq 'found') "state is 'found' with real findings present"

    # Assertion 1: a user entry verbatim-present in the machine PATH is a
    # cross-scope duplicate.
    $dupFindings = @($res1.findings | Where-Object { $_.id -like 'path-hygiene|cross-scope-dup|*System32' })
    Assert-True ($dupFindings.Count -eq 1) "a user PATH entry verbatim-duplicated in the machine PATH is reported as a cross-scope duplicate"

    # Assertion 2: a PATH entry under Downloads is reported even though the
    # directory exists.
    Assert-True ((Test-Path -LiteralPath $downloadsDir) -eq $true) "sanity: the Downloads fixture directory really exists"
    $dlFindings = @($res1.findings | Where-Object { $_.id -like "path-hygiene|downloads|*" -and $_.path -eq $downloadsDir })
    Assert-True ($dlFindings.Count -eq 1) "a PATH entry under Downloads is reported EVEN THOUGH the directory exists"

    # Broken entry (directory does not exist) -- part of this finder's own
    # three-check table, not REQ-15's job to report on its own.
    $brokenFindings = @($res1.findings | Where-Object { $_.id -like "path-hygiene|broken|*" -and $_.path -eq $brokenEntry })
    Assert-True ($brokenFindings.Count -eq 1) "a broken (nonexistent) PATH entry is reported"

    # A clean entry (exists, not a duplicate, not under Downloads) produces
    # nothing at all -- this finder must not manufacture noise.
    $cleanNoise = @($res1.findings | Where-Object { $_.path -eq $cleanDir -or $_.title -match [regex]::Escape($cleanDir) })
    Assert-True ($cleanNoise.Count -eq 0) "a clean PATH entry (exists, not a duplicate, not under Downloads) produces no finding"

    # Regression: the empty-array override bug found during this suite's own
    # development -- `if ($null -ne $override)` is false for an empty array
    # in PowerShell (comparison operators filter element-wise), which
    # silently fell through to reading the REAL machine PATH instead of the
    # intended zero entries. Locked down here so it cannot reappear.
    $res1empty = Invoke-HygieneFinder "path-hygiene" @{ pathEntriesUser = @(); pathEntriesMachine = @() }
    Assert-True ($res1empty.examinedCount -eq 0) "an explicit EMPTY pathEntriesUser/Machine override is honoured as zero entries, not silently ignored in favour of the real registry"
    Assert-True ($res1empty.state -eq 'nothing') "and the state for that empty, honoured override is 'nothing'"

    # Test-NeverTouchPath is consulted before reporting a path -- cannot
    # practically plant a fixture PATH entry AT C:\inetpub in this suite
    # (would need elevation and would collide with a real Windows security
    # mitigation on the host running this test), so this proves the finder
    # calls the guard at all, matching finder-gitignored-verify.ps1's sgn.10.
    $finderSource = Get-Content -LiteralPath (Join-Path $root "finders\path-hygiene.finder.ps1") -Raw
    Assert-True ($finderSource -match 'Test-NeverTouchPath') "the finder source calls Test-NeverTouchPath before reporting a path"

    # ==================================================================
    # pko.2 - redirect variables
    # ==================================================================
    Write-Host ""
    Write-Host "pko.2 redirect-variables: unset dev-tool redirects, with default location" -ForegroundColor Cyan

    $gradleDefault = Join-Path $work "fixture-gradle-default"
    New-Item -ItemType Directory -Path $gradleDefault -Force | Out-Null
    # -NoNewline: Set-Content otherwise appends a line terminator, which would
    # make the fixture 779 bytes on disk instead of the 777 this assertion
    # checks for -- caught by this suite's own first run.
    Set-Content -LiteralPath (Join-Path $gradleDefault 'caches.bin') -Value ('x' * 777) -Encoding ASCII -NoNewline

    $res2 = Invoke-HygieneFinder "redirect-variables" @{
        variables = @{
            GRADLE_USER_HOME = ""            # explicitly unset
            npm_config_cache = "D:\custom\npm-cache"   # explicitly set -- must not be reported
        }
        defaultPaths = @{ GRADLE_USER_HOME = $gradleDefault }
    }
    Assert-True ($null -ne $res2) "hygiene-scan returns a redirect-variables result"

    # Assertion 3: the unset variable is reported WITH the default location
    # the tool would use instead, and the measured size at that location.
    $gradleFinding = @($res2.findings | Where-Object { $_.id -eq 'redirect-variables|GRADLE_USER_HOME' })
    Assert-True ($gradleFinding.Count -eq 1) "GRADLE_USER_HOME (unset) is reported"
    if ($gradleFinding.Count -eq 1) {
        Assert-True ($gradleFinding[0].path -eq $gradleDefault) "with the exact default location it would fall back to"
        Assert-True ($gradleFinding[0].detail.defaultPath -eq $gradleDefault) "the default path is also carried in structured detail, not just prose"
        Assert-True ($gradleFinding[0].evidence -match [regex]::Escape($gradleDefault)) "and the evidence names that path"
        Assert-True ($gradleFinding[0].bytes -eq 777) "and the measured size at that default location is the real 777 bytes sitting there (777, $($gradleFinding[0].bytes) found)"
        Assert-True ($gradleFinding[0].costClass -eq 'cheap') "classed cheap -- setting an environment variable is free"
        Assert-True ($gradleFinding[0].action -eq 'audit') "and the action is audit, per Module 2's rule"
    }

    # Assertion 4: a variable that IS set is not reported at all.
    $npmFinding = @($res2.findings | Where-Object { $_.id -eq 'redirect-variables|npm_config_cache' })
    Assert-True ($npmFinding.Count -eq 0) "npm_config_cache (explicitly set) is NOT reported"

    # The other three variables in the spec, left out of the override map
    # entirely, are still checked and still reported as unset (using their
    # real documented default templates -- not asserted on their exact byte
    # count here since that depends on the real machine, only that they
    # appear and carry a non-empty default path).
    foreach ($name in @('ANDROID_HOME', 'ANDROID_SDK_ROOT', 'PIP_CACHE_DIR')) {
        $f = @($res2.findings | Where-Object { $_.id -eq "redirect-variables|$name" })
        Assert-True ($f.Count -eq 1) "$name (not in the override map, therefore unset) is still reported"
        if ($f.Count -eq 1) {
            Assert-True (-not [string]::IsNullOrWhiteSpace($f[0].path)) "$name carries a non-empty default path"
        }
    }

    # A variable unset with NOTHING at its default location is still
    # reported, with bytes = 0 and evidence saying so -- absence of the
    # directory is itself part of the evidence, not an error.
    $res2b = Invoke-HygieneFinder "redirect-variables" @{
        variables = @{ GRADLE_USER_HOME = ""; ANDROID_HOME = ""; ANDROID_SDK_ROOT = ""; npm_config_cache = ""; PIP_CACHE_DIR = "" }
        defaultPaths = @{ GRADLE_USER_HOME = (Join-Path $work "never-created-gradle-home") }
    }
    $gradleEmpty = @($res2b.findings | Where-Object { $_.id -eq 'redirect-variables|GRADLE_USER_HOME' })
    Assert-True ($gradleEmpty.Count -eq 1 -and $gradleEmpty[0].bytes -eq 0) "a default location that does not exist yet is reported with bytes = 0, not an error"
    Assert-True ($res2b.findingCount -eq 5) "all five variables unset -> all five reported (5 expected, $($res2b.findingCount) found) -- this is the real finding from HANDOFF-2026-08-21"

    # ==================================================================
    # pko.3 - repo health: dirty, unpushed, unreadable
    # ==================================================================
    Write-Host ""
    Write-Host "pko.3 repo-health: dirty, unpushed, and unreadable (the important state)" -ForegroundColor Cyan

    $gitAvailable = $false
    try {
        $null = & git.exe --version 2>&1
        $gitAvailable = ($LASTEXITCODE -eq 0)
    } catch { $gitAvailable = $false }

    if (-not $gitAvailable) {
        Write-Skip "git is not on PATH in this shell -- every fixture-repo test below is skipped, not passed vacuously"

        $noGitWork = Join-Path $work "no-git-probe"
        New-Item -ItemType Directory -Path $noGitWork -Force | Out-Null
        $resNoGit = Invoke-HygieneFinder "repo-health" @{ repoPaths = @($noGitWork) }
        Assert-True ($resNoGit.state -eq 'could-not-look') "even with no git installed, the finder still reports could-not-look, never a clean 'nothing' (bd aeu)"
        $reasons = @($resNoGit.unreadable | Where-Object { $_.reason -eq 'git-not-found' })
        Assert-True ($reasons.Count -eq 1) "named specifically as git-not-found"
    } else {
        # -- dirty repo: an uncommitted change to a tracked file --
        $rDirty = Join-Path $work "repo-dirty"
        New-FixtureRepo $rDirty | Out-Null
        Set-Content -LiteralPath (Join-Path $rDirty 'README.txt') -Value 'edited locally' -Encoding ASCII

        # -- unpushed repo: one commit ahead of its own bare remote --
        $bareAhead = Join-Path $work "remote-ahead.git"
        Invoke-FixtureGit $work @('init', '--quiet', '--bare', $bareAhead) | Out-Null
        $rAhead = Join-Path $work "repo-ahead"
        New-FixtureRepo $rAhead | Out-Null
        Invoke-FixtureGit $rAhead @('remote', 'add', 'origin', $bareAhead)
        $branchAhead = (Invoke-FixtureGit $rAhead @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1)
        Invoke-FixtureGit $rAhead @('push', '--quiet', '-u', 'origin', $branchAhead)
        Set-Content -LiteralPath (Join-Path $rAhead 'new.txt') -Value 'not pushed yet' -Encoding ASCII
        Invoke-FixtureGit $rAhead @('add', 'new.txt')
        Invoke-FixtureGit $rAhead @('commit', '--quiet', '-m', 'local-only commit, deliberately not pushed')

        # -- forced git failure: a directory shaped like a repo (has a
        # '.git' entry) whose gitfile is garbage, not a real "gitdir:"
        # pointer. This is "any git failure you can force" (the spec's own
        # phrasing) -- deterministic and elevation-free, unlike reproducing
        # the actual dubious-ownership condition, which needs changing a
        # directory's owner (SeRestorePrivilege). Verified directly against
        # this machine's git before being trusted as a fixture:
        #   `fatal: invalid gitfile format: <path>/.git`, exit 128.
        $rBroken = Join-Path $work "repo-broken"
        New-Item -ItemType Directory -Path $rBroken -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $rBroken '.git') -Value 'not a real gitdir pointer' -Encoding ASCII

        # -- clean repo: fully committed and pushed to its own bare remote --
        $bareClean = Join-Path $work "remote-clean.git"
        Invoke-FixtureGit $work @('init', '--quiet', '--bare', $bareClean) | Out-Null
        $rClean = Join-Path $work "repo-clean"
        New-FixtureRepo $rClean | Out-Null
        Invoke-FixtureGit $rClean @('remote', 'add', 'origin', $bareClean)
        $branchClean = (Invoke-FixtureGit $rClean @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1)
        Invoke-FixtureGit $rClean @('push', '--quiet', '-u', 'origin', $branchClean)

        $res3 = Invoke-HygieneFinder "repo-health" @{ repoPaths = @($rDirty, $rAhead, $rBroken, $rClean) }
        Assert-True ($null -ne $res3) "hygiene-scan returns a repo-health result"

        $dirtyFindings = @($res3.findings | Where-Object { $_.id -eq "repo-health|dirty|$rDirty" })
        Assert-True ($dirtyFindings.Count -eq 1) "the dirty repo is reported as dirty"

        $unpushedFindings = @($res3.findings | Where-Object { $_.id -eq "repo-health|unpushed|$rAhead" })
        Assert-True ($unpushedFindings.Count -eq 1) "the ahead repo is reported as having unpushed commits"
        if ($unpushedFindings.Count -eq 1) {
            Assert-True ($unpushedFindings[0].title -match '1 ahead') "naming the exact ahead count (1)"
        }

        # Assertion 5: a fixture repo whose git invocation fails (a forced
        # git failure) yields state 'could-not-look' in isolation, never
        # 'nothing' -- this is aeu's binding rule applied to the specific
        # incident named in the spec ("10 repos returned dubious ownership").
        $resBrokenAlone = Invoke-HygieneFinder "repo-health" @{ repoPaths = @($rBroken) }
        Assert-True ($resBrokenAlone.state -eq 'could-not-look') "a repo git itself refuses to read is 'could-not-look' in isolation, never 'nothing'"
        Assert-True ($resBrokenAlone.complete -eq $false) "and 'complete' is false -- this result must never be trusted as an all-clear"
        $gitFailReasons = @($resBrokenAlone.unreadable | Where-Object { $_.reason -eq 'git-error' -or $_.reason -eq 'dubious-ownership' })
        Assert-True ($gitFailReasons.Count -eq 1) "named as a specific git-failure reason, not a generic one"

        # A fully clean, fully pushed repo, in isolation, is the one
        # legitimate 'nothing' this finder can produce.
        $resCleanAlone = Invoke-HygieneFinder "repo-health" @{ repoPaths = @($rClean) }
        Assert-True ($resCleanAlone.state -eq 'nothing') "a fully committed, fully pushed repo is 'nothing' in isolation"
        Assert-True ($resCleanAlone.complete -eq $true) "and 'complete' is true"

        # Best-effort: the ACTUAL dubious-ownership condition (an owner SID
        # this session does not match), reproduced exactly as
        # test/finder-gitignored-verify.ps1's sgn.9 does. Needs
        # SeRestorePrivilege (an elevated shell) to set the owner to
        # Administrators without already running as one -- assert the
        # premise first, and SKIP the specific reason string if it cannot be
        # forced here, rather than failing or passing vacuously.
        $rDubious = Join-Path $work "repo-dubious"
        New-FixtureRepo $rDubious | Out-Null
        $reproduced = $false
        try {
            $admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
            $acl = Get-Acl -LiteralPath $rDubious
            $acl.SetOwner($admins)
            Set-Acl -LiteralPath $rDubious -AclObject $acl -ErrorAction Stop
            $probeOut = & git.exe -C $rDubious status 2>&1
            $reproduced = ($LASTEXITCODE -ne 0) -and (($probeOut | Out-String) -match 'dubious ownership')
        } catch {
            $reproduced = $false
        }
        if (-not $reproduced) {
            Write-Skip "could not force a real dubious-ownership condition without SeRestorePrivilege (needs an elevated shell that is not already Administrator) -- the reason-naming branch is exercised above via a different forced git failure, just not with this exact message"
        } else {
            $resDubious = Invoke-HygieneFinder "repo-health" @{ repoPaths = @($rDubious) }
            Assert-True ($resDubious.state -eq 'could-not-look') "a dubiously-owned repo is could-not-look, never read as clean"
            $dubiousReasons = @($resDubious.unreadable | Where-Object { $_.reason -eq 'dubious-ownership' })
            Assert-True ($dubiousReasons.Count -eq 1) "named specifically as dubious-ownership -- the exact incident named in HANDOFF-2026-08-21 (10 repos on the operator's machine)"
        }
    }

    $repoFinderSource = Get-Content -LiteralPath (Join-Path $root "finders\repo-health.finder.ps1") -Raw
    Assert-True ($repoFinderSource -match 'Test-NeverTouchPath') "the finder source calls Test-NeverTouchPath before reporting a path"
    Assert-True ($repoFinderSource -match '\$LASTEXITCODE') "and reads `$LASTEXITCODE explicitly rather than relying on bare `$? after a pipeline (the SS4 incident)"

    # ==================================================================
    # pko.4 - orphaned ProfileList registry entries
    # ==================================================================
    Write-Host ""
    Write-Host "pko.4 profile-list: orphaned ProfileList entries" -ForegroundColor Cyan

    $liveProfileDir = Join-Path $work "fixture-live-profile"
    New-Item -ItemType Directory -Path $liveProfileDir -Force | Out-Null
    $orphanPath = Join-Path $work "fixture-deleted-profile-does-not-exist"

    $res4 = Invoke-HygieneFinder "profile-list" @{
        profiles = @(
            @{ sid = 'S-1-5-21-FIXTURE-LIVE';   profileImagePath = $liveProfileDir },
            @{ sid = 'S-1-5-21-FIXTURE-ORPHAN'; profileImagePath = $orphanPath }
        )
    }
    Assert-True ($null -ne $res4) "hygiene-scan returns a profile-list result"
    Assert-True ($res4.examinedCount -eq 2) "both fixture profiles are examined"

    # Assertion 7: a ProfileList entry whose ProfileImagePath exists is not
    # flagged; one whose path is missing is.
    $liveFindings = @($res4.findings | Where-Object { $_.id -match 'FIXTURE-LIVE' })
    Assert-True ($liveFindings.Count -eq 0) "a ProfileList entry whose ProfileImagePath still exists is NOT flagged"

    $orphanFindings = @($res4.findings | Where-Object { $_.id -eq 'profile-list|S-1-5-21-FIXTURE-ORPHAN' })
    Assert-True ($orphanFindings.Count -eq 1) "a ProfileList entry whose ProfileImagePath is missing IS flagged as orphaned"
    if ($orphanFindings.Count -eq 1) {
        Assert-True ($orphanFindings[0].costClass -eq 'cheap') "classed cheap -- free to remove once confirmed"
        Assert-True ($orphanFindings[0].action -eq 'audit') "and the action is audit -- this module proposes no removal"
    }

    # Regression: the same empty-array override bug as pko.1, checked here
    # too since profile-list has its own independent override-presence check.
    $res4empty = Invoke-HygieneFinder "profile-list" @{ profiles = @() }
    Assert-True ($res4empty.examinedCount -eq 0) "an explicit EMPTY profiles override is honoured as zero profiles, not silently ignored in favour of the real ProfileList key"
    Assert-True ($res4empty.state -eq 'nothing') "and reports 'nothing', not 'could-not-look' or the real machine's profiles"

    # -profileListKey: the OTHER override, exercising the real
    # registry-reading code path (Get-ChildItem / Get-ItemProperty) against
    # a fixture key built under HKCU -- writable without elevation, and
    # never the real HKLM ProfileList key.
    if (Test-Path -LiteralPath $hkcuFixtureRoot) { Remove-Item -LiteralPath $hkcuFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
    $fixtureProfileListKey = Join-Path $hkcuFixtureRoot 'ProfileList'
    New-Item -Path $fixtureProfileListKey -Force | Out-Null
    $hkcuLiveDir = Join-Path $work "fixture-hkcu-live"
    New-Item -ItemType Directory -Path $hkcuLiveDir -Force | Out-Null
    New-Item -Path (Join-Path $fixtureProfileListKey 'S-1-5-21-HKCU-LIVE') -Force | Out-Null
    New-ItemProperty -Path (Join-Path $fixtureProfileListKey 'S-1-5-21-HKCU-LIVE') -Name ProfileImagePath -Value $hkcuLiveDir -Force | Out-Null
    New-Item -Path (Join-Path $fixtureProfileListKey 'S-1-5-21-HKCU-ORPHAN') -Force | Out-Null
    New-ItemProperty -Path (Join-Path $fixtureProfileListKey 'S-1-5-21-HKCU-ORPHAN') -Name ProfileImagePath -Value (Join-Path $work "hkcu-orphan-does-not-exist") -Force | Out-Null

    $res4key = Invoke-HygieneFinder "profile-list" @{ profileListKey = $fixtureProfileListKey }
    Assert-True ($res4key.examinedCount -eq 2) "the -profileListKey override reads the real registry-reading code path against an HKCU fixture (2 subkeys examined)"
    $hkcuOrphanFindings = @($res4key.findings | Where-Object { $_.id -eq 'profile-list|S-1-5-21-HKCU-ORPHAN' })
    Assert-True ($hkcuOrphanFindings.Count -eq 1) "the orphaned entry under the HKCU fixture key is found via the real Get-ChildItem/Get-ItemProperty path"
    $hkcuLiveFindings = @($res4key.findings | Where-Object { $_.id -match 'HKCU-LIVE' })
    Assert-True ($hkcuLiveFindings.Count -eq 0) "and the live one under the same fixture key is not"

    # ==================================================================
    # pko.5 - duplicate app installs, both on PATH -- routed through 4rn,
    # never labelled redundant
    # ==================================================================
    Write-Host ""
    Write-Host "pko.5 duplicate-installs: needs-confirmation only, never redundant (bd 4rn, the Antigravity case)" -ForegroundColor Cyan

    # Named after the real case in bd 4rn: two Antigravity installs (an
    # agentic IDE and a VS Code fork, one needed to install BMAD) that
    # LOOKED like duplication and were both wanted. This is the regression
    # test that a hygiene tool flagging by shape does not repeat that call.
    $res5 = Invoke-HygieneFinder "duplicate-installs" @{
        installedApps = @(
            @{ name = "Antigravity"; version = "1.0.0"; installLocation = "C:\Users\Fixture\AppData\Local\Programs\Antigravity"; sizeBytes = 1200000000 },
            @{ name = "Antigravity"; version = "2.0.0"; installLocation = "C:\Users\Fixture\AppData\Local\Programs\Antigravity-VSCodeFork"; sizeBytes = 1200000000 }
        )
        pathDirs = @(
            "C:\Users\Fixture\AppData\Local\Programs\Antigravity\bin",
            "C:\Users\Fixture\AppData\Local\Programs\Antigravity-VSCodeFork\bin"
        )
    }
    Assert-True ($null -ne $res5) "hygiene-scan returns a duplicate-installs result"

    # Assertion 6: two same-named installs, both on PATH, come back as
    # needs-confirmation via Test-SameNameInstallsRedundant, and NEVER as
    # "redundant".
    $antigravityFindings = @($res5.findings | Where-Object { $_.title -match 'Antigravity' })
    Assert-True ($antigravityFindings.Count -eq 1) "the two same-named, both-on-PATH Antigravity installs produce exactly one finding"
    if ($antigravityFindings.Count -eq 1) {
        Assert-True ($antigravityFindings[0].detail.verdict -eq 'needs-confirmation') "the verdict is needs-confirmation"
        Assert-True ($antigravityFindings[0].detail.verdict -ne 'redundant') "and is explicitly NEVER 'redundant' -- Test-SameNameInstallsRedundant has no code path that returns that"
        Assert-True ($antigravityFindings[0].costClass -eq 'unknown') "classed 'unknown' so it never floats to the top of a byte-ranked list as if it were as safe as the other four hygiene checks"
        Assert-True ($antigravityFindings[0].action -eq 'audit') "and the action is audit"
        Assert-True ($antigravityFindings[0].bytes -eq 2400000000) "bytes IS the real combined size here (one of the two Module 2 exceptions to bytes = 0), 2.4 GB (2400000000, $($antigravityFindings[0].bytes) found)"
    }

    # A regression on the function itself, not just this finder's use of it:
    # Test-SameNameInstallsRedundant has no code path returning "redundant"
    # at all, for ANY pair, regardless of shape.
    $ntSource = Get-Content -LiteralPath (Join-Path $root "finders\_never-touch.ps1") -Raw
    Assert-True ($ntSource -notmatch "verdict\s*=\s*'redundant'") "finders/_never-touch.ps1 itself has no code path assigning verdict = 'redundant' (bd 4rn's binding design)"

    # Only one of the pair reachable from PATH -- a different, weaker signal
    # this finder does NOT raise.
    $res5b = Invoke-HygieneFinder "duplicate-installs" @{
        installedApps = @(
            @{ name = "Foo"; version = "1.0"; installLocation = "C:\Apps\Foo1"; sizeBytes = 100 },
            @{ name = "Foo"; version = "2.0"; installLocation = "C:\Apps\Foo2"; sizeBytes = 100 }
        )
        pathDirs = @("C:\Apps\Foo1\bin")
    }
    Assert-True ($res5b.findingCount -eq 0) "same-named installs where only ONE is on PATH produce no finding"
    Assert-True ($res5b.state -eq 'nothing') "and the state is a genuine 'nothing'"

    # Regression: the same empty-array override bug, checked a third time --
    # duplicate-installs has TWO independent array overrides (installedApps,
    # pathDirs), both fixed the same way.
    $res5empty = Invoke-HygieneFinder "duplicate-installs" @{ installedApps = @(); pathDirs = @() }
    Assert-True ($res5empty.examinedCount -eq 0) "an explicit EMPTY installedApps override is honoured as zero apps, not silently ignored in favour of the real Uninstall registry"
    Assert-True ($res5empty.state -eq 'nothing') "and reports 'nothing'"
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $hkcuFixtureRoot) { Remove-Item -LiteralPath $hkcuFixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
if ($script:skip -gt 0) { Write-Host "$script:skip test(s) SKIPPED -- see reasons above" -ForegroundColor Yellow }
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
