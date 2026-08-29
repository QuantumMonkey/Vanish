# ==========================================
# NEVER-TOUCH, AND THE SAFETY CASES ALREADY LEARNED (4rn)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md section 4. Three real cases where
# something LOOKED like waste and was not. Each cost investigation during the
# two-day manual cleanup; hard-coding them means it happens once.
#
# The generalisation is the valuable part, and it is why this file is not just
# an array of paths: a hygiene tool that flags by SHAPE will flag security
# mitigations, deliberate duplicates and toolchains that have consumers. An
# exception list rots - it grows one entry per incident, each entry loses its
# reason, and nobody can ever safely remove one. A POSITIVE TEST for the thing
# that makes the item legitimate does not rot, because when the legitimising
# fact stops being true the test stops passing on its own.
#
# So: one hard-coded path (a published CVE mitigation is a fact about Windows,
# not about this machine), and two positive tests.

# NOTE ON Set-StrictMode: deliberately NOT set here. These files are
# dot-sourced into scanner.ps1, and dot-sourcing runs in the CALLERS scope -
# so a Set-StrictMode line would silently impose strict semantics on 7,870
# lines that were never written for it, and the failures would surface as
# unrelated features breaking in a VM. Get-FieldValue exists to make
# missing-member access explicit instead.

# Case 1: C:\inetpub looks like an unused IIS leftover on a machine that has
# never served a web page. It is the CVE-2025-21204 mitigation - Microsoft's
# April 2025 update creates it deliberately, and deleting it re-opens a
# symlink-based local privilege escalation. This is a fact about Windows and
# will be true on every machine, so it is data, not a discovered exception.
$script:NeverTouchPaths = @(
    @{
        path   = 'C:\inetpub'
        reason = 'CVE-2025-21204 mitigation. Windows creates this deliberately; removing it re-opens a local privilege-escalation path. It is not an unused IIS leftover even on a machine that has never served a page.'
    }
)


function Test-NeverTouchPath {
    <#
    .SYNOPSIS
        Is this path one Vanish will refuse to offer, by name and with a reason?

    .DESCRIPTION
        Refusing BY NAME WITH A REASON is the tier/consent model this project
        already commits to, applied to paths. A silent omission would be
        indistinguishable from a finder that failed to look - which is exactly
        the aeu defect - so callers are expected to surface the reason rather
        than filter the item away.

        Matches the path itself and anything beneath it. A finder proposing
        C:\inetpub\wwwroot is proposing to gut the mitigation just as surely.
    #>
    param([Parameter(Mandatory = $true)][string]$path)

    if ([string]::IsNullOrWhiteSpace($path)) { return $null }

    $full = try { [System.IO.Path]::GetFullPath($path) } catch { $path }
    $full = $full.TrimEnd('\')

    foreach ($entry in $script:NeverTouchPaths) {
        $guard = $entry.path.TrimEnd('\')
        if ($full -eq $guard -or $full.StartsWith($guard + '\', [StringComparison]::OrdinalIgnoreCase)) {
            return @{
                path   = $entry.path
                reason = $entry.reason
            }
        }
    }

    return $null
}


function Test-SameNameInstallsRedundant {
    <#
    .SYNOPSIS
        Two installs share a name. Are they redundant? The answer is never yes.

    .DESCRIPTION
        Case 2. Two Antigravity installs looked like duplication and were
        INTENTIONAL - an agentic IDE and a VS Code fork, one of which is needed
        to install BMAD. Same publisher, same display name, both on PATH, both
        wanted.

        The handoff's rule is "never auto-flag same-name installs as redundant
        without asking", so this function deliberately has no path that returns
        "redundant". Its whole output is 'needs-confirmation', carrying the
        evidence a human needs to answer - which is the honest verdict, because
        the fact that decides it (does the operator use both?) does not exist
        anywhere on the disk.

        Written as a function rather than a comment in the caller so that any
        future finder reaching for "same name, therefore duplicate" collides
        with the reasoning instead of reinventing the bug.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$a,
        [Parameter(Mandatory = $true)][object]$b
    )

    $reasons = [System.Collections.Generic.List[string]]::new()

    $aVer = [string](Get-FieldValue -record $a -name 'version' -default '')
    $bVer = [string](Get-FieldValue -record $b -name 'version' -default '')
    $aLoc = [string](Get-FieldValue -record $a -name 'installLocation' -default '')
    $bLoc = [string](Get-FieldValue -record $b -name 'installLocation' -default '')

    if ($aVer -and $bVer -and $aVer -ne $bVer) {
        $reasons.Add("different versions ($aVer and $bVer) - this is often a deliberate pin, not a leftover")
    }
    if ($aLoc -and $bLoc -and $aLoc -ne $bLoc) {
        $reasons.Add("installed to different locations, so neither is shadowing the other")
    }
    $reasons.Add('two installs sharing a display name were deliberate on this machine before: an agentic IDE and a VS Code fork, one required to install BMAD')

    return @{
        verdict  = 'needs-confirmation'
        evidence = @($reasons)
        prompt   = "Vanish will not decide this one. Two installs share a name; whether the second is redundant depends on whether you use both, and that fact is not on the disk."
    }
}


function Find-ToolchainConsumers {
    <#
    .SYNOPSIS
        Before calling a toolchain unused, look for the projects that consume it.

    .DESCRIPTION
        Case 3. The Flutter SDK looked orphaned - large, not recently opened,
        no shortcut - and was not: SplitSmart is a Flutter app. "Detect
        consumers before calling a toolchain unused."

        The positive test is the project marker, which is the same rule Module
        1 uses in the other direction (never delete node_modules unless the
        package.json that regenerates it is visible). Here the marker proves
        the toolchain is LOAD-BEARING rather than proving the artifact is
        REGENERABLE, and it is the same fact read twice.

        Returns a three-state result, not a boolean, because "I searched the
        roots you gave me and found no consumers" and "I could not read the
        roots" are different answers and only one of them permits a removal
        offer. That is aeu, and it is why this returns through the contract.
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$markers,
        [string[]]$roots = @(),
        [int]$maxDepth = 4
    )

    $consumers  = [System.Collections.Generic.List[object]]::new()
    $unreadable = [System.Collections.Generic.List[object]]::new()
    $examined   = 0

    $searchRoots = @($roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($searchRoots.Count -eq 0) {
        $searchRoots = @($env:USERPROFILE) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    foreach ($root in $searchRoots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container -ErrorAction SilentlyContinue)) {
            $unreadable.Add((New-Unreadable -path $root -reason 'root-missing' -detail 'The search root does not exist or is not a directory.'))
            continue
        }

        # e6gn: this used to run one recursive Get-ChildItem PER MARKER, so
        # reclaim-package-caches listed the same tree seven times (npm 1
        # marker, Gradle 3, pip 3) to collect seven file names. Measured warm
        # on the operator machine: 4,646 ms across seven listings against
        # 1,571 ms for one walk collecting all seven, with identical hit
        # counts. Same defect as 3l8 and lxl, third instance.
        #
        # THE MARKERS ARE REGISTERED HERE, not only at file scope, because
        # this function takes them as a RUNTIME parameter -- scanner.ps1's
        # toolchain-consumers action passes whatever the caller asked for.
        # A marker nobody harvested would come back empty from the shared
        # walk, and "no consumers found" is exactly the wrong answer to give
        # about a toolchain somebody is about to delete. Registering first
        # changes the cache key, so an unharvested marker costs one extra
        # walk instead of producing a confident lie (3l8's reasoning for
        # keeping the harvest IN the key).
        Register-SharedWalkHarvest -markerNames @($markers)

        # No skip list and no directory cap, because the Get-ChildItem -Recurse
        # this replaces had neither. Passing maxDirs explicitly also keeps this
        # out of the reclaim group's cache entry: depth 4 unpruned is a
        # different question from depth 8 with fifteen names pruned.
        $walk = Invoke-SharedTreeWalk -root $root -maxDepth $maxDepth -maxDirs ([int]::MaxValue) -skipDirs @()

        foreach ($marker in $markers) {
            $examined++
            foreach ($dir in @($walk.markers[$marker])) {
                $consumers.Add(@{
                    marker  = $marker
                    path    = (Join-Path $dir $marker)
                    project = $dir
                })
            }
        }

        # A walk that hit an access denial has NOT established that the
        # subtree is consumer-free - the "unquoted search path silently
        # skipping an entire store" failure from the real cleanup. The shared
        # walk captures those via -ErrorVariable and hands them back already
        # shaped as New-Unreadable, so they are added ONCE per denied
        # directory here rather than once per marker as before.
        foreach ($u in @($walk.unreadable)) { $unreadable.Add($u) }
    }

    return New-FinderResult `
        -finder 'toolchain-consumers' `
        -title 'Projects that would break if this toolchain were removed' `
        -findings @($consumers) `
        -unreadable @($unreadable) `
        -examined $examined `
        -note 'A toolchain with no consumers found in readable roots is still not proven unused if any root was unreadable.'
}
