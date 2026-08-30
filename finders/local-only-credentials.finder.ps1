# ==========================================
# LOCAL-ONLY CREDENTIAL SCAN (bd vanish-uninstaller-ho2)
# ==========================================
# Module 3.1 RESCUE, from docs/history/HANDOFF-2026-08-21.md section 3:
# "the highest-value, lowest-risk thing in this document." Finds files that
# exist on disk, are gitignored, and are therefore on no remote -
# key.properties, .env.local, *.jks, *.keystore, *.p12, *.pem, id_rsa, an
# .npmrc, .playwright_session, and similar. The evidence, from the real
# two-day cleanup that produced this suite's specification: TWO KEYSTORE
# PASSWORDS EXISTING NOWHERE ELSE IN THE WORLD, inside folders a
# delete-and-reclone would have destroyed. Signed Android apps become
# unshippable without them.
#
# AUDIT-ONLY. This finder never deletes, quarantines, or writes anything to
# the trees it scans - action is always 'audit'. That is the entire scope of
# ho2; a decider consuming this result is a separate, later concern.
#
# THE OTHER HALF OF THE RULE: it never reads or prints file CONTENTS either.
# A tool whose answer to "you might lose your keystore password" is to print
# the keystore password has become the problem it exists to prevent. Every
# check below works on names and metadata (file name, size, and whether git's
# own ignore-matcher excludes the path) - never Get-Content, never a hash of
# anything that might itself be secret material.
#
# Obeys aeu (finders/_contract.ps1): a repo whose ignore status could not be
# determined - git.exe missing, git check-ignore refusing with "dubious
# ownership" or any other fatal error, a directory Get-ChildItem could not
# enumerate - becomes a New-Unreadable entry, never a silent "not found". That
# is not decoration: reporting "could not look" as "nothing" is exactly the
# defect shape that would authorise deleting the two keystore passwords above.

# NOTE ON Set-StrictMode: deliberately NOT set here, for the same reason as
# the other finders/*.ps1 files - this is dot-sourced into scanner.ps1's own
# scope, and imposing strict mode here would silently change semantics for
# 7,870 lines that were never written for it.

# All script-scoped names in this file are prefixed Ho2 on purpose. Finder
# files are dot-sourced into ONE shared scope (finders/_loader.ps1), so a
# generically named helper here (Test-CredentialMatch, $script:PruneSegments)
# would collide with an identically-tempting name in a sibling finder written
# by a different agent in the same tree at the same time. The prefix is the
# whole mitigation.
#
# NOTE ON `function script:Name`: not stylistic, and every function below
# uses it. _loader.ps1's Import-Finders dot-sources this file FROM INSIDE ITS
# OWN FUNCTION BODY, so a plain `function Name {}` here is added to
# Import-Finders' local invocation scope and is torn down the moment
# Import-Finders returns - proven by direct repro during this issue's own
# verification: every helper below came back "is not recognized as the name
# of a cmdlet" the first time the registered handler scriptblock actually ran
# from Invoke-HygieneScan, a completely different call stack, even though
# `finder-probe list` had already shown the finder registered with no load
# errors. `Register-Finder`'s own effect survives only because it writes into
# $script:FinderRegistry, a script-scope variable - so every helper this
# handler calls at run time has to reach that same persistent script scope
# the same way.

# ------------------------------------------------------------------------
# The patterns. Each carries WHY it is flagged and WHY it cannot simply be
# regenerated - HANDOFF-2026-08-21 Module 1's rule applied to Module 3: the
# rebuild cost is what a human checks the claim against, not a guess.
# Order matters: -like matching returns the FIRST hit, so a specific literal
# name (".env.local") is listed before the general wildcard that would also
# match it (".env.*"), so the more specific reason is the one that surfaces.
# ------------------------------------------------------------------------
$script:Ho2CredentialPatterns = @(
    @{ pattern = 'key.properties'; why = 'Android release-signing reference (store password, key alias, key password) that Gradle reads to sign an upload build'; rebuild = 'cannot be regenerated - a lost upload keystore means the app can never be updated under the same listing' }
    @{ pattern = '*.jks';          why = 'Java KeyStore file - holds the private signing key(s) for a released Android app'; rebuild = 'cannot be regenerated - a lost upload keystore means the app can never be updated under the same listing' }
    @{ pattern = '*.keystore';     why = 'Java KeyStore under its older file extension - same signing material as .jks'; rebuild = 'cannot be regenerated - a lost upload keystore means the app can never be updated under the same listing' }
    @{ pattern = '*.p12';          why = 'PKCS#12 bundle - commonly a code-signing or TLS private key plus certificate'; rebuild = 'cannot be regenerated - reissuing needs the original certificate authority or signing ceremony, not a rebuild step' }
    @{ pattern = '*.pfx';          why = 'PKCS#12 bundle under its Windows-convention extension'; rebuild = 'cannot be regenerated - reissuing needs the original certificate authority or signing ceremony, not a rebuild step' }
    @{ pattern = '*.pem';          why = 'PEM-encoded private key or certificate'; rebuild = 'cannot be regenerated - a private key is not reconstructible from its public half, and losing it forces a reissue that invalidates every place the old key was trusted' }
    @{ pattern = 'id_rsa';         why = 'SSH private key (RSA)'; rebuild = 'cannot be regenerated - a replacement key is not the SAME key, and every server, git remote and CI system that trusted this one needs re-authorizing by hand' }
    @{ pattern = 'id_dsa';         why = 'SSH private key (DSA)'; rebuild = 'cannot be regenerated - a replacement key is not the SAME key, and every server, git remote and CI system that trusted this one needs re-authorizing by hand' }
    @{ pattern = 'id_ecdsa';       why = 'SSH private key (ECDSA)'; rebuild = 'cannot be regenerated - a replacement key is not the SAME key, and every server, git remote and CI system that trusted this one needs re-authorizing by hand' }
    @{ pattern = 'id_ed25519';     why = 'SSH private key (Ed25519)'; rebuild = 'cannot be regenerated - a replacement key is not the SAME key, and every server, git remote and CI system that trusted this one needs re-authorizing by hand' }
    @{ pattern = '.env.local';     why = 'machine-local environment overrides (the Next.js/Vite convention) - gitignored by the framework default specifically so it never reaches the remote'; rebuild = 'cannot be regenerated from the repository - a delete-and-reclone recovers the code but not values an external provider issued once' }
    @{ pattern = '.env';           why = 'runtime environment file - typically API keys, database URLs and passwords issued by an external provider'; rebuild = 'cannot be regenerated from the repository - a delete-and-reclone recovers the code but not values an external provider issued once' }
    @{ pattern = '.env.*';         why = 'a dotenv variant (for example .env.production, .env.staging)'; rebuild = 'cannot be regenerated from the repository - a delete-and-reclone recovers the code but not values an external provider issued once' }
    @{ pattern = '.npmrc';         why = 'npm configuration file - a project-scoped copy commonly carries a registry auth token'; rebuild = 'cannot be regenerated - a registry auth token was issued once by the registry; losing it means requesting a new one and updating every place that depended on the old one' }
    @{ pattern = '.pypirc';        why = 'PyPI upload credentials'; rebuild = 'cannot be regenerated - losing it means re-requesting an API token from PyPI before the package can be published again' }
    @{ pattern = '.netrc';         why = 'plaintext host credentials read by curl, git and many other CLIs'; rebuild = 'cannot be regenerated - the credentials it holds were issued elsewhere; this file is only where they were written down' }
    @{ pattern = '.playwright_session'; why = 'captured browser/session authentication state for Playwright, named directly in the 2026-08-21 handoff'; rebuild = 'cannot be regenerated automatically - it is a saved login session; losing it means re-authenticating interactively before automated tests can run again' }
)

function script:Test-Ho2CredentialMatch {
    param([Parameter(Mandatory = $true)][string]$name)
    foreach ($p in $script:Ho2CredentialPatterns) {
        if ($name -like $p.pattern) { return $p }
    }
    return $null
}

# Directories the walk never descends into. This is a SPEED bound, not a
# security one: HANDOFF-2026-08-21 is explicit that "a scan the operator
# cancels is a scan that found nothing", and the default root
# ($env:USERPROFILE) contains regenerable artifact trees (node_modules,
# build output, package-manager caches) whose file counts would otherwise
# blow the "well under a minute" budget for no gain - a credential file does
# not live inside node_modules. Pruning a segment only stops descent past it;
# a credential file sitting directly at the segment's own name is not
# possible since these are all container names, not filenames this finder
# matches.
$script:Ho2PruneSegments = @(
    'node_modules', '.git', 'vendor', '.venv', 'venv', '__pycache__',
    'dist', 'build', '.next', '.nuxt', 'target', 'bin', 'obj',
    '.gradle', '.cache', '.npm', '.nuget', 'packages',
    'AppData', '$Recycle.Bin', 'System Volume Information',
    'Windows', 'WindowsApps', 'ProgramData', 'Recovery', 'PerfLogs'
)

function script:Invoke-Ho2CredentialWalk {
    <#
    .SYNOPSIS
        One bounded, error-tracked walk under $root: finds git repo roots and
        any credential-pattern file or directory living inside one.

    .DESCRIPTION
        Hand-written instead of Get-ChildItem -Recurse for one reason: -Recurse
        has no way to PRUNE a directory from descent, only to filter it out of
        the final output after walking it anyway - and walking node_modules
        anyway is exactly the runtime this finder is required not to have.

        Every directory this cannot enumerate is recorded via New-Unreadable
        with the real path and the real .NET exception message (never a bare
        $?), the same discipline finders/_never-touch.ps1's
        Find-ToolchainConsumers already uses for the same reason: an unquoted
        or silently-caught access error is how "10 repos returned dubious
        ownership" became "the machine looked clean" during the real cleanup.

        A directory is a repo root the moment it has a child literally named
        '.git' (directory OR file - a git worktree or submodule records its
        real .git as a file). Repo membership is inherited by descendants
        until a NESTED '.git' replaces it, so a submodule's own files are
        checked against the submodule's ignore rules, not the parent's.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [Parameter(Mandatory = $true)][int]$maxDepth,
        [int]$maxDirs = 15000
    )

    $candidates  = [System.Collections.Generic.List[object]]::new()
    $unreadable  = [System.Collections.Generic.List[object]]::new()
    $repoRoots   = [System.Collections.Generic.List[string]]::new()
    $dirsVisited = 0

    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ Path = $root; Depth = 0; RepoRoot = $null })

    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()

        if ($dirsVisited -ge $maxDirs) {
            # The cap itself is the aeu case, not an edge around it: a subtree
            # that was never visited has established NOTHING, and reporting
            # this run as complete would be the exact defect this suite exists
            # to make unrepresentable.
            $unreadable.Add((New-Unreadable -path $cur.Path -reason 'scan-capped' `
                -detail "The scan visited $maxDirs directories under '$root' and stopped early so a run never hangs. Pass a narrower 'roots' list to cover what was skipped."))
            continue
        }
        $dirsVisited++

        $err = $null
        $children = @(Get-ChildItem -LiteralPath $cur.Path -Force -ErrorAction SilentlyContinue -ErrorVariable +err)
        foreach ($e in @($err)) {
            if ($null -eq $e) { continue }
            $target = if ($e.TargetObject) { [string]$e.TargetObject } else { $cur.Path }
            $unreadable.Add((New-Unreadable -path $target -reason 'access-denied' -detail $e.Exception.Message))
        }

        $hasGit = @($children | Where-Object { $_.Name -eq '.git' }).Count -gt 0
        $repoRootHere = $cur.RepoRoot
        if ($hasGit) {
            $repoRootHere = $cur.Path
            $repoRoots.Add($cur.Path)
        }

        foreach ($child in $children) {
            if ($child.Name -eq '.git') { continue }

            $match = Test-Ho2CredentialMatch -name $child.Name
            if ($null -ne $match -and $null -ne $repoRootHere) {
                # Outside any discovered repo, "gitignored, therefore on no
                # remote" has no meaning - a bare .env with no .git anywhere
                # above it is not this finder's claim to make.
                $candidates.Add(@{ file = $child; pattern = $match; repoRoot = $repoRootHere })
            }

            if ($child.PSIsContainer) {
                # o1mj: a junction is a SECOND NAME for a directory, and this
                # walk had no test for one. That is not merely double work -
                # it defeated the prune list. AppData is pruned by name, but
                # Local Settings and Application Data are junctions TO
                # AppDataLocal and are not, so the walk went round its own
                # prune and spent the entire 15,000-directory budget in there.
                #
                # Measured on the operator machine, warm, one line changed:
                #
                #   shipped        23,160 ms  15,000 dirs   9 repos  0 candidates  CAPPED
                #   skip reparse    2,958 ms   2,991 dirs  12 repos  4 candidates
                #
                # Read the last column first. This is not a speed fix. The
                # nine repos it used to find were all alias paths; it missed
                # all five real ones under DocumentsGitHub, and it reported
                # ZERO credential files on a machine that has four. It said
                # could-not-look rather than clean, so the contract held -
                # but the operator was handed "incomplete" instead of four
                # real credentials.
                #
                # A junction whose target is OUTSIDE the root is now skipped
                # with no record, which is bd vanish-uninstaller-127o and
                # affects every walker in this repo the same way.
                if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                if ($script:Ho2PruneSegments -contains $child.Name) { continue }
                if ($cur.Depth -ge $maxDepth) { continue }
                $stack.Push(@{ Path = $child.FullName; Depth = $cur.Depth + 1; RepoRoot = $repoRootHere })
            }
        }
    }

    return @{
        candidates  = @($candidates)
        unreadable  = @($unreadable)
        repoRoots   = @($repoRoots | Select-Object -Unique)
        dirsVisited = $dirsVisited
    }
}

function script:Test-Ho2GitIgnored {
    <#
    .SYNOPSIS
        Ask git itself whether $fullPath is ignored inside $repoRoot.

    .DESCRIPTION
        Shells out rather than hand-parsing .gitignore, on purpose: gitignore
        semantics span the file itself, .git/info/exclude, core.excludesFile,
        and per-directory precedence, and a hand-rolled parser that gets one
        of those wrong reports a real credential as "not ignored" - i.e. as
        safe to lose. git check-ignore is the one thing guaranteed to agree
        with what `git push` actually did.

        $LASTEXITCODE is read explicitly and is the only thing trusted for the
        verdict - never bare $? after the call, which is the "$? after a pipe
        scored the wrong command, twice, the second time immediately before an
        rm -rf" failure from HANDOFF-2026-08-21 section 4, applied to a
        different pipe. Exit code contract for check-ignore: 0 = ignored,
        1 = not ignored (not an error), anything else = git refused to answer
        (dubious ownership, a corrupt or detached .git, etc.) and THAT is
        recorded as could-not-look, never folded into "not ignored".
    #>
    param(
        [Parameter(Mandatory = $true)][string]$repoRoot,
        [Parameter(Mandatory = $true)][string]$fullPath
    )

    $out = $null
    try {
        $out = & git.exe -C $repoRoot check-ignore -q --no-index -- $fullPath 2>&1
    } catch {
        return @{ ok = $false; ignored = $false; detail = "git could not be run: $($_.Exception.Message)" }
    }

    $code = $LASTEXITCODE
    if ($code -eq 0) { return @{ ok = $true;  ignored = $true;  detail = '' } }
    if ($code -eq 1) { return @{ ok = $true;  ignored = $false; detail = '' } }

    $msg = (@($out) | ForEach-Object { $_.ToString() }) -join ' '
    return @{ ok = $false; ignored = $false; detail = "git check-ignore exited $code" + $(if ($msg) { ": $msg" } else { '' }) }
}

function script:Test-Ho2DirHasRepoWithin {
    # Cheap, non-recursive positive test used only to pick DEFAULT roots
    # (4rn's shape: prove the folder holds real projects rather than
    # guessing from its name). Depth-1 only - the top directory itself or one
    # of its immediate children - so this never costs more than two
    # Get-ChildItem calls per candidate.
    param([Parameter(Mandatory = $true)][string]$dir)

    if (Test-Path -LiteralPath (Join-Path $dir '.git') -ErrorAction SilentlyContinue) { return $true }
    $kids = @(Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)
    foreach ($k in $kids) {
        if ($script:Ho2PruneSegments -contains $k.Name) { continue }
        if (Test-Path -LiteralPath (Join-Path $k.FullName '.git') -ErrorAction SilentlyContinue) { return $true }
    }
    return $false
}

function script:Get-Ho2DefaultRoots {
    <#
    .SYNOPSIS
        $env:USERPROFILE plus any drive-root folder that can be shown, cheaply
        and without recursion, to actually hold a git working tree.

    .DESCRIPTION
        "Any drive-root project folders you can justify" (ho2's brief) is
        implemented as a POSITIVE TEST, the same principle
        finders/_never-touch.ps1 uses for toolchain consumers and same-name
        installs: a folder earns a spot by demonstrably containing a repo one
        level down (the shape of this very repo, D:\quickhelp\<name>), not by
        matching a guessed name like "dev" or "projects". A list that grows by
        name guess rots the same way an exception list does.
    #>
    $roots = [System.Collections.Generic.List[string]]::new()

    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE) -and (Test-Path -LiteralPath $env:USERPROFILE -ErrorAction SilentlyContinue)) {
        $roots.Add($env:USERPROFILE)
    }

    $skipTop = @(
        'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
        '$Recycle.Bin', 'System Volume Information', 'Recovery', 'PerfLogs',
        'Documents and Settings', 'Users'
    )

    $added = 0
    $drives = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq [System.IO.DriveType]::Fixed })
    foreach ($drive in $drives) {
        if ($added -ge 25) { break }
        $top = @(Get-ChildItem -LiteralPath $drive.RootDirectory.FullName -Directory -Force -ErrorAction SilentlyContinue)
        foreach ($t in $top) {
            if ($added -ge 25) { break }
            if ($skipTop -contains $t.Name) { continue }
            if ($env:USERPROFILE -and $t.FullName.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) { continue }
            if (Test-Ho2DirHasRepoWithin -dir $t.FullName) {
                $roots.Add($t.FullName)
                $added++
            }
        }
    }

    return @($roots | Select-Object -Unique)
}

Register-Finder -name 'local-only-credentials' `
    -title 'Local-only credentials (gitignored, on no remote)' `
    -module 'rescue' `
    -auditOnly $true `
    -description 'Files that exist on disk, are gitignored, and are therefore on no remote copy - key.properties, .env.local, *.jks, *.keystore, *.p12, *.pem, id_rsa, .npmrc, .playwright_session and similar. Audit only; see bd vanish-uninstaller-ho2.' `
    -handler {
        param($p)

        $roots = @(Get-FieldValue -record $p -name 'roots' -default @())
        $roots = @($roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

        $maxDepth = 0
        try { $maxDepth = [int](Get-FieldValue -record $p -name 'maxDepth' -default 8) } catch { $maxDepth = 8 }
        if ($maxDepth -le 0) { $maxDepth = 8 }

        if ($roots.Count -eq 0) {
            $roots = @(Get-Ho2DefaultRoots)
        }

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()
        $withheld   = [System.Collections.Generic.List[string]]::new()
        $reposSeen  = 0
        $dirsTotal  = 0

        # If git itself is unavailable, NO candidate anywhere can have its
        # ignore status determined - that is a could-not-look for every
        # candidate this run finds, not a reason to skip the check quietly.
        $gitAvailable = $null -ne (Get-Command git.exe -ErrorAction SilentlyContinue)
        if (-not $gitAvailable) {
            $unreadable.Add((New-Unreadable -path '(git)' -reason 'git-not-found' `
                -detail 'git.exe is not on PATH. Without it this finder cannot tell a gitignored file from a tracked one, so it has established nothing about local-only credentials on this run - not the same as finding none.'))
        }

        foreach ($root in $roots) {
            $rootVerdict = Test-NeverTouchPath $root
            if ($null -ne $rootVerdict) {
                $withheld.Add("$root ($($rootVerdict.reason))")
                continue
            }

            if (-not (Test-Path -LiteralPath $root -PathType Container -ErrorAction SilentlyContinue)) {
                $unreadable.Add((New-Unreadable -path $root -reason 'root-missing' -detail 'Scan root does not exist or is not a directory.'))
                continue
            }

            $walk = Invoke-Ho2CredentialWalk -root $root -maxDepth $maxDepth
            $dirsTotal += $walk.dirsVisited
            foreach ($u in $walk.unreadable) { $unreadable.Add($u) }
            $reposSeen += @($walk.repoRoots).Count

            foreach ($cand in $walk.candidates) {
                $fullPath = $cand.file.FullName

                $fileVerdict = Test-NeverTouchPath $fullPath
                if ($null -ne $fileVerdict) {
                    $withheld.Add("$fullPath ($($fileVerdict.reason))")
                    continue
                }

                if (-not $gitAvailable) {
                    $unreadable.Add((New-Unreadable -path $fullPath -reason 'git-not-found' `
                        -detail 'Matches a local-only-credential filename pattern, but git.exe is unavailable so whether it is tracked or ignored could not be determined.'))
                    continue
                }

                $verdict = Test-Ho2GitIgnored -repoRoot $cand.repoRoot -fullPath $fullPath
                if (-not $verdict.ok) {
                    $unreadable.Add((New-Unreadable -path $fullPath -reason 'git-check-ignore-failed' -detail $verdict.detail))
                    continue
                }
                if (-not $verdict.ignored) {
                    # Tracked (or at least not excluded): whatever this file
                    # holds already went to this repo's remote, if it has one.
                    # This finder exists for the copy that exists NOWHERE
                    # ELSE, and a tracked file is not that copy.
                    continue
                }

                $relPath = $fullPath
                if ($fullPath.StartsWith($cand.repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    $relPath = $fullPath.Substring($cand.repoRoot.Length).TrimStart('\', '/')
                }

                $bytes = 0L
                try { if ($null -ne $cand.file.Length) { $bytes = [long]$cand.file.Length } } catch { $bytes = 0L }

                $findings.Add((New-Finding `
                    -id          "local-only-credential|$($cand.repoRoot)|$relPath" `
                    -title       "Local-only credential: $relPath" `
                    -path        $fullPath `
                    -bytes       $bytes `
                    -evidence    "Matches pattern '$($cand.pattern.pattern)' ($($cand.pattern.why)); git check-ignore confirms it is excluded by the ignore rules in '$($cand.repoRoot)', so no remote this repository pushes to has ever received it." `
                    -rebuildCost $cand.pattern.rebuild `
                    -costClass   'irreplaceable' `
                    -action      'audit'))
            }
        }

        $repoWord = if ($reposSeen -eq 1) { 'repository' } else { 'repositories' }
        $dirWord  = if ($dirsTotal -eq 1) { 'directory' } else { 'directories' }
        $note = "Examined $reposSeen git $repoWord across $dirsTotal $dirWord under $($roots.Count) root(s). Audit only - nothing scanned is deleted, quarantined, or read for CONTENT; a finding names the path and the git rule that hides it from the remote, never what is inside it."
        if ($withheld.Count -gt 0) {
            $note += " $($withheld.Count) path(s) withheld by the never-touch list: " + ($withheld -join '; ') + "."
        }

        return New-FinderResult `
            -finder 'local-only-credentials' `
            -title 'Local-only credentials (gitignored, on no remote)' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $reposSeen `
            -note $note
    }
