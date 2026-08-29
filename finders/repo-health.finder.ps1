# ==========================================
# REPO HEALTH: DIRTY, UNPUSHED, UNREADABLE (bd vanish-uninstaller-pko)
# ==========================================
# Module 2 HYGIENE check 3 of 5, HANDOFF-2026-08-21 section 3: "Found: 10
# repos returned dubious ownership from a previous profile SID." The handoff
# and finders/_contract.ps1 both call out UNREADABLE as the important state
# here, not an edge case: "a repo that cannot be read is not a clean repo"
# (bd aeu). Ten real repos on the operator's machine would have read as "0
# dirty repos, 0 unpushed repos" under a two-state check, which is precisely
# incident #1 in _contract.ps1's header ("git ownership errors read as clean").
#
# THREE per-repo outcomes, not two:
#   - dirty:      git status --porcelain reports at least one changed path
#   - unpushed:   the current branch has commits not on its upstream
#   - unreadable: git itself refused to answer -- dubious ownership, a
#                 corrupt .git, or (separately) no upstream configured, which
#                 means "unpushed?" has NO ANSWER, not a negative one
# A single repo can be BOTH dirty and unpushed (both are checked
# independently), or dirty with unpushed-status unreadable (the ownership
# probe can succeed while the upstream lookup fails) -- which is exactly why
# this finder does not treat the three as mutually exclusive branches of one
# if/else.
#
# NO NETWORK ACCESS. Like finders/gitignored-unique.finder.ps1 (bd sgn), this
# never runs `git fetch` -- "unpushed" is against the last-known upstream
# ref, so a stale fetch can only under-report, never invent, unpushed commits.
#
# $LASTEXITCODE discipline (aeu, HANDOFF-2026-08-21 section 4's $? incident,
# which happened twice -- the second time immediately before an rm -rf):
# every git call below goes through Invoke-PkoGit, which reads $LASTEXITCODE
# on the line immediately after the call and never inspects bare $?.
#
# TESTABILITY: -repoPaths overrides repo discovery entirely with an explicit
# list of repo root directories (this is what test/finder-hygiene-verify.ps1
# uses -- real, throwaway git repos built under %TEMP%, never this
# repository); -roots / -maxDepth control the discovery walk when no explicit
# list is given. Default roots ($env:USERPROFILE only) matches the existing
# convention in finders/_never-touch.ps1 (Find-ToolchainConsumers) and
# finders/gitignored-unique.finder.ps1 -- a machine-wide sweep needs an
# explicit roots list.

# NOTE ON Set-StrictMode: deliberately NOT set here -- see finders/_contract.ps1.
# Pko prefix on every script-scoped name -- see path-hygiene.finder.ps1's
# header. Same file's header also explains why every helper function is
# `function script:Name`, not plain `function Name`: a plain function
# defined here would not survive past Import-Finders dot-sourcing this file
# from inside its own function body, and would be gone before this file's
# own handler ever runs.

function script:Test-PkoFieldPresent {
    <#
    .SYNOPSIS
        Was $name actually present on $record, distinct from "present but
        empty" and from "absent entirely"?

    .DESCRIPTION
        `if ($null -ne $override)` looks like the obvious presence check and
        is WRONG the moment $override is array-typed: PowerShell's
        comparison operators filter element-wise when the left operand is an
        array, so `$null -ne @()` returns `@()` (zero elements), and `if
        (@())` is FALSE. An override supplied as an explicit empty array
        (exactly what a test asserting "zero repos" would pass) was
        therefore silently treated as "no override given" and fell through
        to a real filesystem walk under $env:USERPROFILE -- caught in
        path-hygiene.finder.ps1's own verification, which hits the identical
        shape. Testing presence on the RECORD (Contains / PSObject.Properties,
        never on the extracted value) sidesteps the operator entirely.
    #>
    param([object]$record, [Parameter(Mandatory = $true)][string]$name)
    if ($null -eq $record) { return $false }
    if ($record -is [System.Collections.IDictionary]) { return $record.Contains($name) }
    return ($null -ne $record.PSObject.Properties[$name])
}

function script:Resolve-PkoGitExe {
    $cmd = Get-Command 'git.exe' -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command 'git' -ErrorAction SilentlyContinue }
    if ($cmd) { return $cmd.Source }
    return $null
}

function script:Invoke-PkoGit {
    <#
    .SYNOPSIS
        Run one git command against one repo, reading $LASTEXITCODE on the
        very next line -- never a bare $? after the call. See file header.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$gitExe,
        [Parameter(Mandatory = $true)][string]$repoPath,
        [Parameter(Mandatory = $true)][string[]]$gitArgs
    )
    $fullArgs = @('-C', $repoPath) + $gitArgs
    $raw = & $gitExe @fullArgs 2>&1
    $code = $LASTEXITCODE

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @($raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $lines.Add($item.Exception.Message)
        } else {
            $lines.Add([string]$item)
        }
    }

    return @{ ExitCode = $code; Lines = @($lines); Text = ($lines -join "`n") }
}

# lxl: a repo root is a directory holding a .git ENTRY - a directory in an
# ordinary clone, a FILE in a submodule or a linked worktree. -entryNames
# matches either, which -markerNames (files only) cannot. Declared at file
# scope so the union is complete before the first walk runs.
Register-SharedWalkHarvest -entryNames @('.git')

function script:Find-PkoGitRepoRoots {
    <#
    .SYNOPSIS
        Directories holding a .git entry, taken from the shared walk.

    .DESCRIPTION
        lxl: this walk and the one in the other git finder were the same
        walk written twice - same root, same default depth, same .git
        test, same refusal to descend into .git. They are now one call to
        Invoke-SharedTreeWalk and the second finder to ask is served from
        its cache.

        maxDirs is [int]::MaxValue deliberately. The two walks this
        replaces had NO directory cap, unlike the reclaim group, and
        capping them here would quietly shrink what a repo scan covers.
        Passing it explicitly also keeps this out of the reclaim group's
        cache entry, which is the intent: depth 6 with nothing pruned is a
        different question from depth 8 with fifteen names pruned, and
        sharing those two would change coverage rather than speed.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [int]$maxDepth = 6
    )

    if (-not (Test-Path -LiteralPath $root -PathType Container -ErrorAction SilentlyContinue)) {
        $missing = New-Unreadable -path $root -reason 'root-missing' -detail 'The search root does not exist or is not a directory.'
        return @{ repos = @(); unreadable = @($missing) }
    }

    $walk = Invoke-SharedTreeWalk -root $root -maxDepth $maxDepth -maxDirs ([int]::MaxValue) -skipDirs @('.git')
    return @{
        repos      = @($walk.entries['.git'])
        unreadable = @($walk.unreadable)
    }
}

Register-Finder -name 'repo-health' `
    -title 'Repo health: dirty, unpushed, unreadable' `
    -module 'hygiene' `
    -walkGroup 'git-repos' `
    -auditOnly $true `
    -description 'For every discovered git repo: uncommitted changes, commits not on the upstream branch, and repos git itself refuses to read (dubious ownership, no upstream, or any other git failure) -- the last is the important state, not an edge case (bd aeu). No network access. Audit only; see bd vanish-uninstaller-pko.' `
    -handler {
        param($p)

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()

        $gitExe = Resolve-PkoGitExe
        if (-not $gitExe) {
            $unreadable.Add((New-Unreadable -path '(git)' -reason 'git-not-found' -detail 'git.exe is not on PATH. No repository could be examined -- this is not evidence the machine has no dirty or unpushed repos.'))
            return New-FinderResult -finder 'repo-health' `
                -title 'Repo health: dirty, unpushed, unreadable' `
                -findings @() -unreadable @($unreadable) -examined 0 `
                -note 'git is not installed or not on PATH; no repository could be inspected.'
        }

        $repoProvided = Test-PkoFieldPresent -record $p -name 'repoPaths'
        $repoOverride = Get-FieldValue -record $p -name 'repoPaths' -default @()
        $repos = [System.Collections.Generic.List[string]]::new()

        if ($repoProvided) {
            foreach ($r in @($repoOverride)) { if ($r) { $repos.Add([string]$r) } }
        } else {
            $rootsProvided = Test-PkoFieldPresent -record $p -name 'roots'
            $rootsOverride = Get-FieldValue -record $p -name 'roots' -default @()
            $roots = if ($rootsProvided) {
                @($rootsOverride | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            } else {
                @($env:USERPROFILE) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
            }
            $maxDepth = [int](Get-FieldValue -record $p -name 'maxDepth' -default 6)

            foreach ($root in $roots) {
                $walk = Find-PkoGitRepoRoots -root $root -maxDepth $maxDepth
                foreach ($u in @($walk.unreadable)) { $unreadable.Add($u) }
                foreach ($r in @($walk.repos)) { $repos.Add($r) }
            }
        }

        $uniqueRepos = @($repos | Select-Object -Unique)
        $examined = $uniqueRepos.Count

        foreach ($repoPath in $uniqueRepos) {
            $guard = Test-NeverTouchPath -path $repoPath
            if ($guard) {
                $unreadable.Add((New-Unreadable -path $repoPath -reason 'never-touch' -detail $guard.reason))
                continue
            }

            # One cheap probe establishes git can talk to this repo at all --
            # this IS the check for the incident this finder exists to catch.
            # "10 repos returned dubious ownership from a previous profile
            # SID" is exactly this call's failure mode.
            $probe = Invoke-PkoGit -gitExe $gitExe -repoPath $repoPath -gitArgs @('rev-parse', '--is-inside-work-tree')
            if ($probe.ExitCode -ne 0) {
                $reason = if ($probe.Text -match 'dubious ownership') { 'dubious-ownership' } else { 'git-error' }
                $unreadable.Add((New-Unreadable -path $repoPath -reason $reason -detail $probe.Text))
                continue
            }

            $status = Invoke-PkoGit -gitExe $gitExe -repoPath $repoPath -gitArgs @('status', '--porcelain')
            if ($status.ExitCode -ne 0) {
                $unreadable.Add((New-Unreadable -path $repoPath -reason 'git-status-failed' -detail $status.Text))
            } else {
                $changed = @($status.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
                if ($changed.Count -gt 0) {
                    $dirtyParams = @{
                        id        = "repo-health|dirty|$repoPath"
                        title     = "Repo is dirty: $($changed.Count) uncommitted change(s)"
                        path      = $repoPath
                        bytes     = 0
                        evidence  = "git status --porcelain in '$repoPath' reports $($changed.Count) changed path(s) not committed."
                        costClass = 'cheap'
                        action    = 'audit'
                    }
                    $findings.Add((New-Finding @dirtyParams))
                }
            }

            $upstreamProbe = Invoke-PkoGit -gitExe $gitExe -repoPath $repoPath -gitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
            if ($upstreamProbe.ExitCode -ne 0) {
                $unreadable.Add((New-Unreadable -path $repoPath -reason 'no-upstream' -detail "No upstream is configured for the current branch (or HEAD is detached): $($upstreamProbe.Text)"))
            } else {
                $upstreamLines = @($upstreamProbe.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
                $upstream = if ($upstreamLines.Count -gt 0) { $upstreamLines[0] } else { '(upstream)' }
                $aheadProbe = Invoke-PkoGit -gitExe $gitExe -repoPath $repoPath -gitArgs @('rev-list', '--count', '@{u}..HEAD')
                if ($aheadProbe.ExitCode -ne 0) {
                    $unreadable.Add((New-Unreadable -path $repoPath -reason 'git-rev-list-failed' -detail $aheadProbe.Text))
                } else {
                    $aheadLines = @($aheadProbe.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
                    $aheadText = if ($aheadLines.Count -gt 0) { $aheadLines[0] } else { '0' }
                    $ahead = 0
                    [void][int]::TryParse($aheadText, [ref]$ahead)
                    if ($ahead -gt 0) {
                        $unpushedParams = @{
                            id        = "repo-health|unpushed|$repoPath"
                            title     = "Repo has unpushed commits: $ahead ahead of $upstream"
                            path      = $repoPath
                            bytes     = 0
                            evidence  = "git rev-list --count @{u}..HEAD in '$repoPath' reports $ahead commit(s) ahead of $upstream, as of the last fetch (no network access is made by this check)."
                            costClass = 'cheap'
                            action    = 'audit'
                        }
                        $findings.Add((New-Finding @unpushedParams))
                    }
                }
            }
        }

        $rootKind = if ($repoProvided) { 'an explicit repo list' } else { 'the given roots' }
        $note = "$examined repo(s) examined under $rootKind. No network access -- unpushed status is against the last-known upstream ref."

        return New-FinderResult -finder 'repo-health' `
            -title 'Repo health: dirty, unpushed, unreadable' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $examined `
            -note $note
    }
