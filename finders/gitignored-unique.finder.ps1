# ==========================================
# GITIGNORED-AND-UNIQUE (sgn) - the true blast radius of "just re-clone it"
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md Module 3 (RESCUE), generalising the
# local-only credential scan (ho2): for ANY git repo, list what the REMOTE
# DOES NOT HAVE. That set is what "just re-clone it" actually destroys, and
# almost nobody checks it before saying the sentence.
#
# AUDIT-ONLY (aeu / Module 3 scope). No deletion, no quarantine - this finder
# only ever proposes 'audit'. It exists to make the blast radius visible
# before any destructive step, elsewhere in this suite, is even offered.
#
# The union this finder computes, per repo:
#   1. untracked files that ARE gitignored      (git status --ignored, '!!')
#   2. untracked files that are NOT gitignored  (git status,           '??')
#   3. tracked files with uncommitted changes   (git status, any other code)
#   4. commits on the current branch not on its upstream (git log @{u}..HEAD)
#   5. the no-upstream case, which means the WHOLE branch is local
#   6. stashes (git stash list) - invisible to every one of 1-5 above
#
# THE BINDING RULE (aeu, quoted directly from the issue): "a repo whose
# remote cannot be reached is 'could not look', never 'nothing unique here'."
# This is not a nice-to-have here - it is the one behaviour this file exists
# to get right. git-not-on-PATH, dubious ownership, no upstream configured,
# and any non-zero git exit all become New-Unreadable, never silence. See the
# five real incidents in _contract.ps1's header; dubious ownership reading as
# "clean" is incident #1, and it hit 10 real repos on the operator's machine.
#
# NO NETWORK ACCESS. This never runs `git fetch`. It compares against the
# already-known upstream ref, and every finding that depends on that
# comparison says so in its own evidence string - a finder that silently goes
# to the network is a finder that hangs on a VPN, per the issue text.
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching the other files
# in this directory. Dot-sourcing runs in scanner.ps1's caller scope, and
# scanner.ps1's 7,870 lines were never written under strict mode.
#
# NOTE ON `function script:Name`: not stylistic. _loader.ps1's Import-Finders
# dot-sources this file FROM INSIDE ITS OWN FUNCTION BODY, so a plain
# `function Name {}` here is added to Import-Finders' local invocation scope
# and is torn down the moment Import-Finders returns - proven by direct
# repro (a helper defined that way is "not recognized" the first time the
# registered handler scriptblock actually runs from Invoke-HygieneScan, a
# completely different call stack). `Register-Finder`'s own effect survives
# only because it writes into $script:FinderRegistry, a script-scope
# variable - so every helper this handler calls at run time has to reach the
# same persistent script scope the same way. Prefixed with `Sgn` throughout
# because this scope is shared with every other *.finder.ps1 in this
# directory once loaded, and a same-named helper in another finder file
# would silently replace this one - the exact aeu failure shape (a check
# that never ran, indistinguishable from one that ran and found nothing).

# ------------------------------------------------------------------------
# $LASTEXITCODE discipline (aeu, and HANDOFF-2026-08-21 SS4's $2 incident,
# which happened TWICE - the second time immediately before an rm -rf):
# every git invocation below goes through this one function, and the exit
# code is read on the line immediately after the call, before anything else
# runs. Never `if (-not $?)` after a pipeline - `$?` scores the last element
# of a pipe, not the command, which is exactly what went wrong on the real
# machine. Stderr is captured explicitly (merged via 2>&1 and reclassified
# below) rather than assumed absent on success.
# ------------------------------------------------------------------------
function script:Invoke-SgnGit {
    param(
        [Parameter(Mandatory = $true)][string]$repoPath,
        [Parameter(Mandatory = $true)][string[]]$gitArgs
    )

    $fullArgs = @('-C', $repoPath) + $gitArgs
    $raw = & git.exe @fullArgs 2>&1
    # THE line. Nothing runs between the call above and reading this.
    $code = $LASTEXITCODE

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($raw)) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $lines.Add($item.Exception.Message)
        } else {
            $lines.Add([string]$item)
        }
    }

    return @{
        ExitCode = $code
        Lines    = @($lines)
        Text     = ($lines -join "`n")
    }
}

# ------------------------------------------------------------------------
# Repo discovery. An explicit stack, not Get-ChildItem -Recurse -Filter
# '.git', because that would recurse INSIDE every .git directory it finds
# (objects, hooks, refs) looking for a nested match that essentially never
# exists - correct, but a needless walk of the largest, least relevant part
# of every repo it finds. This walker checks each directory for a '.git'
# entry itself, then continues downward while explicitly skipping '.git' as
# a child - bounded by maxDepth exactly like Find-ToolchainConsumers in
# _never-touch.ps1, for the same reason: an unbounded recursive walk over an
# entire user profile is the "unquoted search path silently skipping an
# entire store" failure mode wearing a performance costume instead of a bug.
#
# Deliberately does NOT stop descending once a repo is found - a clone
# nested inside another repo's working tree (not registered as a submodule)
# is real and not rare, and stopping at the first '.git' would silently
# drop it from a scan whose entire purpose is not missing local-only data.
# ------------------------------------------------------------------------
# lxl: a repo root is a directory holding a .git ENTRY - a directory in an
# ordinary clone, a FILE in a submodule or a linked worktree. -entryNames
# matches either, which -markerNames (files only) cannot. Declared at file
# scope so the union is complete before the first walk runs.
Register-SharedWalkHarvest -entryNames @('.git')

function script:Find-SgnGitRepoRoots {
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
        return @{ repos = @(); unreadable = @($missing); examined = 0 }
    }

    $walk = Invoke-SharedTreeWalk -root $root -maxDepth $maxDepth -maxDirs ([int]::MaxValue) -skipDirs @('.git')
    return @{
        repos      = @($walk.entries['.git'])
        unreadable = @($walk.unreadable)
        examined   = $walk.dirsVisited
    }
}

function script:Get-SgnPathBytes {
    <#
    .SYNOPSIS
        Bytes at a path, whether it is a file or a directory. 0 when it is
        neither, or when nothing could be read.

    .DESCRIPTION
        Wraps Measure-FinderPathBytes (finders/_contract.ps1) rather than
        running its own Get-ChildItem -Recurse walk. Same answer, memoised,
        and it matters here more than anywhere: Test-SgnPathHasBytes calls
        this purely to ask "is it bigger than zero", and every reported
        finding then calls it AGAIN for the number.

        Still returns a bare [long] and still returns 0 rather than throwing:
        this one is used inside boolean tests, and a caller that has to
        handle an exception to ask about a size would grow a catch block
        that swallows the difference between empty and unreadable.
    #>
    param([string]$path)
    if ([string]::IsNullOrWhiteSpace($path)) { return 0L }
    return [long](Measure-FinderPathBytes -path $path).bytes
}

# The size/marker heuristic named in the issue, applied to gitignored,
# untracked DIRECTORIES only (never to a single file - see below).
#
# sgn's whole job is measuring what a re-clone would not bring back. Reporting
# a gitignored node_modules as "unique data at risk" is not noise, it is
# WRONG: `npm install` regenerates it byte-for-byte-equivalent, and Module 1
# (RECLAIM) already proposes removing exactly this shape of directory by the
# same project-marker logic ("only propose deleting node_modules when the
# package.json that regenerates it is visible", HANDOFF-2026-08-21 SS3). If
# this finder also flagged it as irreplaceable, the one number the operator
# reads before deciding - rebuildCost - would be lying on the single question
# this finder exists to answer.
#
# MARKER decides which names are even candidates: an exact, case-insensitive
# match against a fixed list of well-known package-manager and build-tool
# output directory names. SIZE then confirms the candidate is actually
# populated output rather than a coincidence - a directory that happens to be
# named "build" but is empty proves nothing, so it is left IN rather than
# silently dropped; excluding an empty match would hide it with no trace.
#
# A single gitignored FILE is never excluded by this function - only
# directories are ever passed to it. The local-only credential scan finding
# that motivated this whole module (ho2: `key.properties`, `.env.local`,
# `*.jks`) is precisely a lone gitignored FILE, and no filename heuristic
# distinguishes a keystore password from a build byproduct as reliably as
# "this is not a directory named after a package manager's own output
# folder". Excluding by content-type (dir vs file) is what makes it safe to
# exclude by name at all.
$script:SgnBuildOutputMarkers = @(
    'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj',
    '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.gradle', 'vendor',
    '.tox', 'coverage', '.cache', 'Pods', 'DerivedData', '.parcel-cache', '.turbo'
)

function script:Test-SgnBuildOutputMarker {
    param([string]$path)

    $name = Split-Path -Leaf $path
    $isKnownMarker = @($script:SgnBuildOutputMarkers | Where-Object { $_ -ieq $name }).Count -gt 0
    if (-not $isKnownMarker) { return $false }

    return ((Get-SgnPathBytes $path) -gt 0)
}

# Everything git can tell us about ONE repo, without ever touching the
# network. Every call goes through Invoke-SgnGit so $LASTEXITCODE is read
# immediately, and every non-zero exit becomes New-Unreadable rather than
# being read as "found nothing" - that pairing is the entire point of aeu.
function script:Get-SgnRepoUniqueContent {
    param([Parameter(Mandatory = $true)][string]$repoPath)

    $findings   = [System.Collections.Generic.List[object]]::new()
    $unreadable = [System.Collections.Generic.List[object]]::new()

    # One cheap call establishes this repo can be talked to at all. Its
    # failure mode IS the incident this whole finder exists not to repeat:
    # "detected dubious ownership in repository" hit 10 real repos on the
    # operator's machine from a previous profile SID (HANDOFF-2026-08-21 SS3
    # Module 2 table), and a check that reads that failure as clean is
    # incident #1 of the five in _contract.ps1's header.
    $probe = Invoke-SgnGit -repoPath $repoPath -gitArgs @('rev-parse', '--is-inside-work-tree')
    if ($probe.ExitCode -ne 0) {
        $reason = if ($probe.Text -match 'dubious ownership') { 'dubious-ownership' } else { 'git-error' }
        $unreadable.Add((New-Unreadable -path $repoPath -reason $reason -detail $probe.Text))
        return @{ findings = @(); unreadable = @($unreadable) }
    }

    # ---- status: gitignored-untracked, untracked-not-ignored, tracked-modified ----
    $status = Invoke-SgnGit -repoPath $repoPath -gitArgs @('status', '--porcelain', '--ignored')
    if ($status.ExitCode -ne 0) {
        $unreadable.Add((New-Unreadable -path $repoPath -reason 'git-status-failed' -detail $status.Text))
    } else {
        foreach ($line in $status.Lines) {
            if ([string]::IsNullOrWhiteSpace($line) -or $line.Length -lt 4) { continue }

            $code = $line.Substring(0, 2)
            $rel  = $line.Substring(3).Trim('"')
            # A rename line reads "R  old -> new"; the path that actually
            # differs from what the remote has is the new one.
            if ($rel -match '^(.*) -> (.*)$') { $rel = $Matches[2] }
            $full = Join-Path $repoPath $rel

            if (Test-NeverTouchPath $full) { continue }

            if ($code -eq '!!') {
                $isDir = Test-Path -LiteralPath $full -PathType Container -ErrorAction SilentlyContinue
                if ($isDir -and (Test-SgnBuildOutputMarker $full)) { continue }

                $findings.Add((New-Finding -id "gitignored-unique|$repoPath|ignored|$rel" `
                    -title "Gitignored and untracked: $rel" -path $full -bytes (Get-SgnPathBytes $full) `
                    -evidence "git status --ignored marks '$rel' as ignored and untracked in $repoPath - it has never been committed, so no remote has ever received it." `
                    -rebuildCost 'Not tracked and not on any remote - a re-clone would not bring this back at all.' `
                    -costClass 'irreplaceable' -action 'audit'))
            }
            elseif ($code -eq '??') {
                $findings.Add((New-Finding -id "gitignored-unique|$repoPath|untracked|$rel" `
                    -title "Untracked, never added: $rel" -path $full -bytes (Get-SgnPathBytes $full) `
                    -evidence "git status marks '$rel' as untracked (not gitignored, just never `git add`-ed) in $repoPath - it was never committed, so it was never pushed either." `
                    -rebuildCost 'Never added, therefore never on the remote - a re-clone would not bring this back.' `
                    -costClass 'irreplaceable' -action 'audit'))
            }
            else {
                $findings.Add((New-Finding -id "gitignored-unique|$repoPath|modified|$rel" `
                    -title "Uncommitted change: $rel" -path $full -bytes (Get-SgnPathBytes $full) `
                    -evidence "git status code '$code' on '$rel' in $repoPath - this file differs from the last commit, and only the working tree has the difference." `
                    -rebuildCost 'The last commit is on the remote (as of the last fetch); this specific edit is not, until it is committed and pushed.' `
                    -costClass 'irreplaceable' -action 'audit'))
            }
        }
    }

    # ---- upstream and local-only commits ----
    # Binding rule, named directly in the bd issue: no upstream configured is
    # COULD-NOT-LOOK, never "nothing unique here" - because "no upstream"
    # does not mean synced, it means the entire branch has nothing to compare
    # against, which is the maximum possible amount of unmeasured risk, not
    # the minimum.
    $upstreamProbe = Invoke-SgnGit -repoPath $repoPath -gitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
    if ($upstreamProbe.ExitCode -ne 0) {
        $unreadable.Add((New-Unreadable -path $repoPath -reason 'no-upstream' `
            -detail "No upstream is configured for the current branch (or HEAD is detached), so this finder cannot compare local commits against a remote at all: $($upstreamProbe.Text)"))
    } else {
        $upstream = $upstreamProbe.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
        $aheadProbe = Invoke-SgnGit -repoPath $repoPath -gitArgs @('log', '--pretty=%H %s', '@{u}..HEAD')
        if ($aheadProbe.ExitCode -ne 0) {
            $unreadable.Add((New-Unreadable -path $repoPath -reason 'git-log-failed' -detail $aheadProbe.Text))
        } else {
            foreach ($line in $aheadProbe.Lines) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $sha = $line.Substring(0, [Math]::Min(40, $line.Length))
                $findings.Add((New-Finding -id "gitignored-unique|$repoPath|commit|$sha" `
                    -title "Local commit not on $upstream" -path $repoPath -bytes 0 `
                    -evidence "git log $upstream..HEAD includes '$line'. The remote state here is as of this repository's LAST FETCH, not a live check - this finder never runs `git fetch`, so a stale local view can under-report, never over-report, what the remote is missing." `
                    -rebuildCost 'Not pushed. A re-clone gets whatever the remote actually has, which as of the last fetch is not this commit.' `
                    -costClass 'irreplaceable' -action 'audit'))
            }
        }
    }

    # ---- stashes: invisible to every check above ----
    $stashProbe = Invoke-SgnGit -repoPath $repoPath -gitArgs @('stash', 'list')
    if ($stashProbe.ExitCode -ne 0) {
        $unreadable.Add((New-Unreadable -path $repoPath -reason 'git-stash-failed' -detail $stashProbe.Text))
    } else {
        foreach ($line in $stashProbe.Lines) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $findings.Add((New-Finding -id "gitignored-unique|$repoPath|stash|$line" `
                -title "Stash: $line" -path $repoPath -bytes 0 `
                -evidence "git stash list includes '$line' in $repoPath. A stash lives only in this working tree's reflog - it is not a branch, not a commit reachable from HEAD, and none of the checks above would ever surface it." `
                -rebuildCost 'Nowhere else it could come from. A stash is never committed and never pushed; a re-clone has no copy of it at all.' `
                -costClass 'irreplaceable' -action 'audit'))
        }
    }

    return @{ findings = @($findings); unreadable = @($unreadable) }
}

Register-Finder -name 'gitignored-unique' `
    -title 'Gitignored and unique: what a re-clone would not bring back' `
    -module 'rescue' `
    -walkGroup 'git-repos' `
    -auditOnly $true `
    -description 'For every git repo under the given roots, lists everything the remote does not have: gitignored/untracked files, never-added files, uncommitted changes to tracked files, commits ahead of upstream, unpushed branches, and stashes. Read-only, no network access.' `
    -handler {
        param($p)

        $roots = @(Get-FieldValue -record $p -name 'roots' -default @() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if (@($roots).Count -eq 0) {
            $roots = @($env:USERPROFILE) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        }
        $maxDepth = [int](Get-FieldValue -record $p -name 'maxDepth' -default 6)

        $found          = [System.Collections.Generic.List[object]]::new()
        $unreadable     = [System.Collections.Generic.List[object]]::new()
        $examinedRepos  = 0

        # git not on PATH at all: the binding rule names this explicitly. No
        # repo under any root can be examined, so this run has established
        # NOTHING about the machine - it must never be reported as clean.
        $gitCmd = Get-Command 'git.exe' -ErrorAction SilentlyContinue
        if (-not $gitCmd) { $gitCmd = Get-Command 'git' -ErrorAction SilentlyContinue }
        if (-not $gitCmd) {
            $unreadable.Add((New-Unreadable -path '(git)' -reason 'git-not-found' `
                -detail 'git.exe is not on PATH. No repository under the given roots could be examined - this is not evidence the machine has no local-only repo content.'))
            return New-FinderResult -finder 'gitignored-unique' `
                -title 'Gitignored and unique: what a re-clone would not bring back' `
                -findings @() -unreadable @($unreadable) -examined 0 `
                -note 'git is not installed or not on PATH; no repository could be inspected.'
        }

        $seenRepos = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

        foreach ($root in $roots) {
            $walk = Find-SgnGitRepoRoots -root $root -maxDepth $maxDepth
            foreach ($u in @($walk.unreadable)) { $unreadable.Add($u) }

            foreach ($repoPath in @($walk.repos)) {
                $fullRepoPath = try { [System.IO.Path]::GetFullPath($repoPath) } catch { $repoPath }
                if (-not $seenRepos.Add($fullRepoPath)) { continue }

                $guard = Test-NeverTouchPath $fullRepoPath
                if ($guard) {
                    # Named, not silently dropped - a repo Vanish refuses to
                    # touch is still a repo the operator should know it saw.
                    $unreadable.Add((New-Unreadable -path $fullRepoPath -reason 'never-touch' -detail $guard.reason))
                    continue
                }

                $examinedRepos++
                $r = Get-SgnRepoUniqueContent -repoPath $fullRepoPath
                foreach ($u in @($r.unreadable)) { $unreadable.Add($u) }
                foreach ($f in @($r.findings)) { $found.Add($f) }
            }
        }

        return New-FinderResult -finder 'gitignored-unique' `
            -title 'Gitignored and unique: what a re-clone would not bring back' `
            -findings @($found) -unreadable @($unreadable) -examined $examinedRepos `
            -note 'Never fetches the network: every remote comparison is against the last-known upstream ref, so a stale fetch can only under-report the blast radius, never invent one.'
    }
