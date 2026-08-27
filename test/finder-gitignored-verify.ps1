# Gitignored-and-unique finder (sgn). AUDIT-ONLY: for any git repo, the true
# blast radius of "just re-clone it" - what the remote does NOT have.
#
# This suite builds real, throwaway git repositories under %TEMP% and drives
# them through the engine's hygiene-scan action, exactly like a real caller
# would. It never runs a single git command against THIS repository - every
# git invocation here targets a fixture directory created and destroyed by
# this file.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-gitignored-verify.ps1

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

function Invoke-GitignoredScan {
    param([string]$fixtureRoot, [int]$maxDepth = 6)
    return Invoke-Engine "hygiene-scan" @{
        module   = 'rescue'
        finders  = @('gitignored-unique')
        roots    = @($fixtureRoot)
        maxDepth = $maxDepth
    }
}

function Get-SgnResult {
    param($scan)
    return @($scan.results | Where-Object { $_.finder -eq 'gitignored-unique' })[0]
}

# Small git wrapper for building fixtures. Every call checks $LASTEXITCODE
# immediately - never a bare $? after a pipe, per the same discipline the
# finder itself is held to (HANDOFF-2026-08-21 SS4, the $? incident that
# happened twice, the second time right before an rm -rf).
#
# $ErrorActionPreference = 'Continue' is set LOCALLY (this function's own
# scope only - it does not leak to the caller, confirmed by direct repro)
# because this whole file runs under 'Stop' at the top. Under 'Stop', a
# native command's stderr line captured via 2>&1 becomes a terminating
# exception the instant it is captured - before $LASTEXITCODE can even be
# read - so every git command that writes to stderr (which git does on many
# purely informational paths, not just failures) would abort the fixture
# setup mid-build rather than letting this function's own exit-code check
# decide what is actually an error. scanner.ps1 never sets 'Stop' at all,
# which is why the finder's own Invoke-SgnGit does not need this - it is a
# fixture-script-only problem, proven by reproducing it in isolation before
# writing this fix.
function Invoke-FixtureGit {
    param([string]$repoPath, [string[]]$gitArgs)
    $ErrorActionPreference = 'Continue'
    $fullArgs = @('-C', $repoPath) + $gitArgs
    $out = & git.exe @fullArgs 2>&1
    $code = $LASTEXITCODE
    $lines = @($out | ForEach-Object { [string]$_ })
    if ($code -ne 0) {
        throw "Fixture setup: 'git $($gitArgs -join ' ')' in '$repoPath' failed ($code): $($lines -join "`n")"
    }
    return $lines
}

# Non-throwing variant for the one place this suite deliberately EXPECTS a
# git call might fail (sgn.9's dubious-ownership probe) - same local
# 'Continue' fix, without the throw.
function Invoke-FixtureGitRaw {
    param([string]$repoPath, [string[]]$gitArgs)
    $ErrorActionPreference = 'Continue'
    $fullArgs = @('-C', $repoPath) + $gitArgs
    $out = & git.exe @fullArgs 2>&1
    $code = $LASTEXITCODE
    $lines = @($out | ForEach-Object { [string]$_ })
    return @{ ExitCode = $code; Lines = $lines; Text = ($lines -join "`n") }
}

function New-FixtureRepo {
    param([string]$path, [switch]$NoInitialCommit)
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Invoke-FixtureGit $path @('init', '--quiet')
    Invoke-FixtureGit $path @('config', 'user.email', 'sgn-verify@example.invalid')
    Invoke-FixtureGit $path @('config', 'user.name', 'sgn verify')
    # Fixture repos must never be mistaken for real work if a run is
    # interrupted - the branch name and remote name below are chosen to be
    # unambiguous in a directory listing, not because git cares.
    if (-not $NoInitialCommit) {
        Set-Content -LiteralPath (Join-Path $path 'README.txt') -Value 'fixture' -Encoding ASCII
        Invoke-FixtureGit $path @('add', 'README.txt')
        Invoke-FixtureGit $path @('commit', '--quiet', '-m', 'initial commit')
    }
    return $path
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish gitignored-and-unique finder verification (sgn)" -ForegroundColor Cyan
Write-Host "======================================================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

# ======================================================================
# Premise, asserted FIRST: if git is not on this machine, nothing below can
# mean anything. The suite must SKIP, named, rather than pass vacuously (a
# suite with zero fixtures that reports "0 passed, 0 failed" reads as a
# suite with nothing to say, which is a different and worse thing than a
# suite that could not run) or fail with a wall of setup exceptions that bury
# the one fact that actually matters: git is not here.
# ======================================================================
$work = Join-Path $env:TEMP "vanish-sgn-verify"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }

$gitAvailable = $false
try {
    $null = & git.exe --version 2>&1
    $gitAvailable = ($LASTEXITCODE -eq 0)
} catch {
    $gitAvailable = $false
}

if (-not $gitAvailable) {
    Write-Host ""
    Write-Host "  SKIP  git is not on PATH in this shell - every fixture-based test below is skipped, not passed vacuously" -ForegroundColor Yellow
    Write-Host ""

    # The one thing that CAN still be asserted without git: the finder itself
    # must report this exact condition as could-not-look, never as clean.
    # This is the binding rule from the bd issue, and it is cheap to prove
    # even in an environment with no git at all.
    $null = New-Item -ItemType Directory -Path $work -Force
    try {
        $noGitScan = Invoke-GitignoredScan -fixtureRoot $work
        $noGitResult = Get-SgnResult $noGitScan
        Assert-True ($null -ne $noGitResult) "the finder still returns a result with no git installed"
        if ($null -ne $noGitResult) {
            Assert-True ($noGitResult.state -eq 'could-not-look') "and the state is 'could-not-look', never 'nothing' (aeu's binding rule)"
            Assert-True (@($noGitResult.unreadable | Where-Object { $_.reason -eq 'git-not-found' }).Count -eq 1) "with the reason named as git-not-found"
        }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
    if ($script:fail -gt 0) { exit 1 }
    exit 0
}

$null = New-Item -ItemType Directory -Path $work -Force

try {
    # ==================================================================
    # sgn.1 - finder-probe: the finder is registered and loads cleanly
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.1 finder registration" -ForegroundColor Cyan

    $listProbe = Invoke-Engine "finder-probe" @{ mode = 'list' }
    Assert-True ($listProbe.success -eq $true) "finder-probe list succeeds"
    Assert-True (@($listProbe.loadErrors).Count -eq 0) "gitignored-unique.finder.ps1 loads with no errors"
    $registered = @($listProbe.finders | Where-Object { $_.name -eq 'gitignored-unique' })
    Assert-True ($registered.Count -eq 1) "gitignored-unique is registered exactly once"
    if ($registered.Count -eq 1) {
        Assert-True ($registered[0].module -eq 'rescue') "registered under the 'rescue' module (Module 3, before RECLAIM)"
        Assert-True ($registered[0].auditOnly -eq $true) "registered as audit-only"
    }

    # ==================================================================
    # sgn.2 - a repo with an untracked, gitignored file reports it
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.2 untracked and gitignored -> reported as irreplaceable" -ForegroundColor Cyan

    $r2 = Join-Path $work "repo-ignored"
    New-FixtureRepo $r2 | Out-Null
    Set-Content -LiteralPath (Join-Path $r2 '.gitignore') -Value 'local-secret.txt' -Encoding ASCII
    Invoke-FixtureGit $r2 @('add', '.gitignore')
    Invoke-FixtureGit $r2 @('commit', '--quiet', '-m', 'add gitignore')
    Set-Content -LiteralPath (Join-Path $r2 'local-secret.txt') -Value 'never pushed anywhere' -Encoding ASCII

    $scan2 = Invoke-GitignoredScan -fixtureRoot $work
    $res2  = Get-SgnResult $scan2
    Assert-True ($null -ne $res2) "hygiene-scan returns a gitignored-unique result"
    $ignoredFindings = @($res2.findings | Where-Object { $_.title -match 'local-secret\.txt' })
    Assert-True ($ignoredFindings.Count -eq 1) "the gitignored, untracked file is reported exactly once"
    if ($ignoredFindings.Count -eq 1) {
        Assert-True ($ignoredFindings[0].costClass -eq 'irreplaceable') "and classed irreplaceable - no remote has ever seen it"
        Assert-True ($ignoredFindings[0].action -eq 'audit') "and the action is audit, never anything else, in this release"
        Assert-True (-not [string]::IsNullOrWhiteSpace($ignoredFindings[0].evidence)) "with evidence a human can check"
    }

    # A build-output directory matching the marker heuristic must NOT drown
    # out the real finding above, and must not appear as a finding itself -
    # see Test-SgnBuildOutputMarker's comment for why node_modules-shaped
    # noise here would be actively wrong, not just noisy.
    $nm = Join-Path $r2 'node_modules'
    New-Item -ItemType Directory -Path $nm -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $nm 'package-shaped-filler.js') -Value ('x' * 500) -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $r2 '.gitignore') -Value @('local-secret.txt', 'node_modules/') -Encoding ASCII

    $scan2b = Invoke-GitignoredScan -fixtureRoot $work
    $res2b  = Get-SgnResult $scan2b
    Assert-True (@($res2b.findings | Where-Object { $_.path -match 'node_modules' }).Count -eq 0) "a gitignored node_modules directory is excluded as a regenerable build output"
    Assert-True (@($res2b.findings | Where-Object { $_.title -match 'local-secret\.txt' }).Count -eq 1) "the genuine gitignored file is still reported alongside the exclusion"

    Remove-Item -LiteralPath $r2 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.3 - a repo with an untracked file that was simply never added
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.3 untracked, not gitignored -> also reported (never added, never pushed)" -ForegroundColor Cyan

    $r3 = Join-Path $work "repo-untracked"
    New-FixtureRepo $r3 | Out-Null
    Set-Content -LiteralPath (Join-Path $r3 'forgot-to-add.txt') -Value 'oops' -Encoding ASCII

    $scan3 = Invoke-GitignoredScan -fixtureRoot $work
    $res3  = Get-SgnResult $scan3
    $untrackedFindings = @($res3.findings | Where-Object { $_.title -match 'forgot-to-add\.txt' })
    Assert-True ($untrackedFindings.Count -eq 1) "an untracked (not gitignored) file is reported too"

    Remove-Item -LiteralPath $r3 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.4 - fully committed AND pushed to a local bare "remote": nothing
    # unique. This is the ONLY fixture in this suite allowed to produce a
    # clean 'nothing' state, and it is asserted precisely, not assumed.
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.4 fully committed and pushed -> state 'nothing', not a guess" -ForegroundColor Cyan

    $bareRemote = Join-Path $work "remote-clean.git"
    Invoke-FixtureGit $work @('init', '--quiet', '--bare', $bareRemote) | Out-Null

    $r4 = Join-Path $work "repo-clean"
    New-FixtureRepo $r4 | Out-Null
    Invoke-FixtureGit $r4 @('remote', 'add', 'origin', $bareRemote)
    $branch4 = (Invoke-FixtureGit $r4 @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1)
    Invoke-FixtureGit $r4 @('push', '--quiet', '-u', 'origin', $branch4)

    $scan4 = Invoke-GitignoredScan -fixtureRoot $work
    $res4  = Get-SgnResult $scan4
    # Note: $work also contains the OTHER fixtures created earlier in this run
    # (already removed above) plus the bare remote itself, which the walker
    # correctly does not treat as a working-tree repo (a bare repo has no
    # top-level '.git' entry - its own contents ARE the git directory).
    $cleanRepoFindings = @($res4.findings | Where-Object { $_.path -like "$r4*" -or $_.evidence -match [regex]::Escape($r4) })
    Assert-True ($cleanRepoFindings.Count -eq 0) "the fully-pushed repo contributes zero findings"
    Assert-True ($res4.state -eq 'nothing' -or $res4.state -eq 'found') "the overall scan state is well-formed (found only if another fixture in this pass still has content)"

    # Isolate this repo alone to get an unambiguous state assertion.
    $isolatedWork4 = Join-Path $work "isolated-clean"
    New-Item -ItemType Directory -Path $isolatedWork4 -Force | Out-Null
    Copy-Item -LiteralPath $r4 -Destination (Join-Path $isolatedWork4 "repo-clean") -Recurse -Force
    $scan4iso = Invoke-GitignoredScan -fixtureRoot $isolatedWork4
    $res4iso  = Get-SgnResult $scan4iso
    Assert-True ($res4iso.state -eq 'nothing') "in isolation, a fully committed and pushed repo reports state 'nothing'"
    Assert-True ($res4iso.findingCount -eq 0) "with zero findings"
    Assert-True ($res4iso.complete -eq $true) "and 'complete' is true - nothing was unreadable either"
    Remove-Item -LiteralPath $isolatedWork4 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.5 - a commit ahead of upstream is reported as irreplaceable
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.5 a local commit ahead of upstream is reported as irreplaceable" -ForegroundColor Cyan

    Set-Content -LiteralPath (Join-Path $r4 'unpushed-work.txt') -Value 'not on origin yet' -Encoding ASCII
    Invoke-FixtureGit $r4 @('add', 'unpushed-work.txt')
    Invoke-FixtureGit $r4 @('commit', '--quiet', '-m', 'local-only commit, deliberately not pushed')

    $isolatedWork5 = Join-Path $work "isolated-ahead"
    New-Item -ItemType Directory -Path $isolatedWork5 -Force | Out-Null
    Copy-Item -LiteralPath $r4 -Destination (Join-Path $isolatedWork5 "repo-ahead") -Recurse -Force
    $scan5 = Invoke-GitignoredScan -fixtureRoot $isolatedWork5
    $res5  = Get-SgnResult $scan5

    $commitFindings = @($res5.findings | Where-Object { $_.title -match '^Local commit not on' })
    Assert-True ($commitFindings.Count -eq 1) "exactly one local-only commit is reported (1 expected, $($commitFindings.Count) found)"
    if ($commitFindings.Count -eq 1) {
        Assert-True ($commitFindings[0].costClass -eq 'irreplaceable') "and it is classed irreplaceable"
        Assert-True ($commitFindings[0].evidence -match 'last fetch') "with evidence stating this is as of the last fetch, not a live check"
    }
    Assert-True ($res5.state -eq 'found') "overall state is 'found'"
    Remove-Item -LiteralPath $isolatedWork5 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.6 - a stash is reported, and it is invisible to every other check
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.6 a stash is reported (invisible to status, log and diff alike)" -ForegroundColor Cyan

    $r6 = Join-Path $work "repo-stash"
    New-FixtureRepo $r6 | Out-Null
    Invoke-FixtureGit $r6 @('remote', 'add', 'origin', $bareRemote)
    $branch6 = (Invoke-FixtureGit $r6 @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1)
    # A fetch is required before 'branch --set-upstream-to' can point at
    # origin/$branch4 - 'remote add' only registers the URL, it does not
    # create the local remote-tracking ref, and git refuses to track a ref
    # it does not yet know exists. This repo shares the bare remote used by
    # sgn.4/5 but tracks the SAME branch name deliberately, since it never
    # pushes anything - it stays isolated from their commits by content, not
    # by branch name.
    Invoke-FixtureGit $r6 @('fetch', 'origin') | Out-Null
    Invoke-FixtureGit $r6 @('branch', ('--set-upstream-to=origin/' + $branch4)) | Out-Null
    Set-Content -LiteralPath (Join-Path $r6 'README.txt') -Value 'stashed edit' -Encoding ASCII
    Invoke-FixtureGit $r6 @('stash', 'push', '--quiet', '-m', 'sgn-verify-stash')

    $isolatedWork6 = Join-Path $work "isolated-stash"
    New-Item -ItemType Directory -Path $isolatedWork6 -Force | Out-Null
    Copy-Item -LiteralPath $r6 -Destination (Join-Path $isolatedWork6 "repo-stash") -Recurse -Force
    $scan6 = Invoke-GitignoredScan -fixtureRoot $isolatedWork6
    $res6  = Get-SgnResult $scan6

    $stashFindings = @($res6.findings | Where-Object { $_.title -match '^Stash:' })
    Assert-True ($stashFindings.Count -eq 1) "the stash is reported exactly once (1 expected, $($stashFindings.Count) found)"
    if ($stashFindings.Count -eq 1) {
        Assert-True ($stashFindings[0].costClass -eq 'irreplaceable') "classed irreplaceable - a stash is never pushed or committed anywhere"
        Assert-True ($stashFindings[0].title -match 'sgn-verify-stash') "with the stash's own message visible as evidence"
    }
    # status --porcelain does not show a clean working tree that HAS a stash
    # as containing a modified file (the stash pop already restored it), so
    # this also proves the stash is found through a code path status alone
    # would miss entirely.
    $modifiedFindings6 = @($res6.findings | Where-Object { $_.title -match '^Uncommitted change' })
    Assert-True ($modifiedFindings6.Count -eq 0) "and nothing else in the working tree looks modified - the stash is genuinely invisible elsewhere"
    Remove-Item -LiteralPath $isolatedWork6 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.7 - a tracked file with an uncommitted modification
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.7 a tracked file with a local, uncommitted edit" -ForegroundColor Cyan

    $r7 = Join-Path $work "repo-modified"
    New-FixtureRepo $r7 | Out-Null
    Invoke-FixtureGit $r7 @('remote', 'add', 'origin', $bareRemote)
    $branch7 = (Invoke-FixtureGit $r7 @('rev-parse', '--abbrev-ref', 'HEAD') | Select-Object -First 1)
    Invoke-FixtureGit $r7 @('fetch', 'origin') | Out-Null
    Invoke-FixtureGit $r7 @('branch', ('--set-upstream-to=origin/' + $branch4)) | Out-Null
    Set-Content -LiteralPath (Join-Path $r7 'README.txt') -Value 'edited locally, never committed' -Encoding ASCII

    $isolatedWork7 = Join-Path $work "isolated-modified"
    New-Item -ItemType Directory -Path $isolatedWork7 -Force | Out-Null
    Copy-Item -LiteralPath $r7 -Destination (Join-Path $isolatedWork7 "repo-modified") -Recurse -Force
    $scan7 = Invoke-GitignoredScan -fixtureRoot $isolatedWork7
    $res7  = Get-SgnResult $scan7

    $modFindings = @($res7.findings | Where-Object { $_.title -match '^Uncommitted change: README\.txt' })
    Assert-True ($modFindings.Count -eq 1) "the uncommitted edit to a tracked file is reported"
    Remove-Item -LiteralPath $isolatedWork7 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.8 - NO upstream configured: could-not-look, never 'nothing'.
    # This is aeu's binding rule and the single most important assertion in
    # this suite - a branch with no upstream is not "in sync", it is
    # entirely unmeasured, which is the opposite of clean.
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.8 no upstream configured -> could-not-look, NOT nothing" -ForegroundColor Cyan

    $r8 = Join-Path $work "repo-no-upstream"
    New-FixtureRepo $r8 | Out-Null
    # Deliberately: no 'git remote add', no 'git push -u'. A plain local repo,
    # fully committed, with no concept of a remote at all.

    $isolatedWork8 = Join-Path $work "isolated-no-upstream"
    New-Item -ItemType Directory -Path $isolatedWork8 -Force | Out-Null
    Copy-Item -LiteralPath $r8 -Destination (Join-Path $isolatedWork8 "repo-no-upstream") -Recurse -Force
    $scan8 = Invoke-GitignoredScan -fixtureRoot $isolatedWork8
    $res8  = Get-SgnResult $scan8

    Assert-True ($res8.findingCount -eq 0) "a fully committed repo with no remote has no ordinary findings"
    Assert-True ($res8.state -eq 'could-not-look') "and the state is 'could-not-look' (NOT 'nothing') - the whole branch is unmeasured, not clean"
    Assert-True ($res8.complete -eq $false) "'complete' is false - this result must never be trusted as an all-clear"
    $noUpstreamUnreadable = @($res8.unreadable | Where-Object { $_.reason -eq 'no-upstream' })
    Assert-True ($noUpstreamUnreadable.Count -eq 1) "the specific reason 'no-upstream' is named, not a generic failure"
    Remove-Item -LiteralPath $isolatedWork8 -Recurse -Force -ErrorAction SilentlyContinue

    # ==================================================================
    # sgn.9 - dubious ownership. Best-effort: reproducing this needs changing
    # a directory's owner, which needs SeRestorePrivilege - the exact same
    # elevation gap test/security-verify.ps1's z3s block hits and SKIPs on.
    # Attempted here rather than assumed, because "implemented but never
    # exercised" is not the same claim as "implemented and proven".
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.9 dubious ownership is refused as could-not-look, when it can be reproduced" -ForegroundColor Cyan

    $r9 = Join-Path $work "repo-dubious"
    New-FixtureRepo $r9 | Out-Null
    $reproduced = $false
    try {
        $admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
        $acl = Get-Acl -LiteralPath $r9
        $acl.SetOwner($admins)
        Set-Acl -LiteralPath $r9 -AclObject $acl -ErrorAction Stop
        $probe = Invoke-FixtureGitRaw -repoPath $r9 -gitArgs @('status')
        $reproduced = ($probe.ExitCode -ne 0) -and ($probe.Text -match 'dubious ownership')
    } catch {
        $reproduced = $false
    }

    if (-not $reproduced) {
        Write-Host "  SKIP  could not force a dubious-ownership condition without SeRestorePrivilege (needs an elevated shell) - the code path is implemented (see Get-SgnRepoUniqueContent's dubious-ownership branch) but not exercised by this run" -ForegroundColor Yellow
    } else {
        $isolatedWork9 = Join-Path $work "isolated-dubious"
        New-Item -ItemType Directory -Path $isolatedWork9 -Force | Out-Null
        Copy-Item -LiteralPath $r9 -Destination (Join-Path $isolatedWork9 "repo-dubious") -Recurse -Force
        $scan9 = Invoke-GitignoredScan -fixtureRoot $isolatedWork9
        $res9  = Get-SgnResult $scan9
        Assert-True ($res9.state -eq 'could-not-look') "a dubiously-owned repo is could-not-look, never read as clean"
        $dubiousUnreadable = @($res9.unreadable | Where-Object { $_.reason -eq 'dubious-ownership' })
        Assert-True ($dubiousUnreadable.Count -eq 1) "named specifically as dubious-ownership - this is incident #1 of the five in the finder contract's header"
        Remove-Item -LiteralPath $isolatedWork9 -Recurse -Force -ErrorAction SilentlyContinue
    }

    # ==================================================================
    # sgn.10 - Test-NeverTouchPath is consulted before reporting a path
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.10 a never-touch path is not reported as a finding" -ForegroundColor Cyan

    $neverTouchProbe = Invoke-Engine "finder-probe" @{ mode = 'never-touch'; path = 'C:\inetpub' }
    Assert-True ($neverTouchProbe.neverTouch -eq $true) "sanity: C:\inetpub is still the guarded path this finder must consult"

    # A repo cannot practically be planted AT C:\inetpub in this suite (needs
    # elevation, and would collide with a real Windows security mitigation on
    # the host running this test) - so this proves the finder calls the guard
    # at all, which is the part that can silently regress without a repo ever
    # being involved.
    $finderSource = Get-Content -LiteralPath (Join-Path $root "finders\gitignored-unique.finder.ps1") -Raw
    Assert-True ($finderSource -match 'Test-NeverTouchPath') "the finder source calls Test-NeverTouchPath before building a finding"

    # ==================================================================
    # sgn.11 - repo discovery finds nested repos and respects maxDepth
    # ==================================================================
    Write-Host ""
    Write-Host "sgn.11 repo discovery under a root, bounded by maxDepth" -ForegroundColor Cyan

    $discoveryRoot = Join-Path $work "discovery"
    $nested = Join-Path $discoveryRoot "a\b\repo-nested"
    New-FixtureRepo $nested | Out-Null
    Set-Content -LiteralPath (Join-Path $nested 'untracked-nested.txt') -Value 'x' -Encoding ASCII

    $scanShallow = Invoke-GitignoredScan -fixtureRoot $discoveryRoot -maxDepth 1
    $resShallow  = Get-SgnResult $scanShallow
    Assert-True ($resShallow.state -ne 'found') "a repo past maxDepth is not discovered at all (shallow scan finds nothing there)"

    $scanDeep = Invoke-GitignoredScan -fixtureRoot $discoveryRoot -maxDepth 6
    $resDeep  = Get-SgnResult $scanDeep
    Assert-True (@($resDeep.findings | Where-Object { $_.title -match 'untracked-nested\.txt' }).Count -eq 1) "the same repo is found once maxDepth reaches it"
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
