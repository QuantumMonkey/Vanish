# ==========================================
# RECLAIM: PACKAGE-MANAGER CACHES (piu)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md Module 1 (RECLAIM), bd issue
# vanish-uninstaller-piu. Real-machine evidence: npm cache 4.5 GB, Gradle
# global cache 14.7 GB, pip cache 570 MB - all of it downloaded content that
# the owning tool will fetch again on demand.
#
# RULE 2 IN ITS OWN WORDS, FROM finders/_contract.ps1: "A package cache is
# cheap but slow to refill - justify your call in a comment." Justified
# here: nothing in any of these three directories is hand-configured or
# unique - every byte is a copy of something the tool's own registry still
# has, so it CAN always come back, which is what 'cheap' measures (rule 2
# ranks by whether the bytes return, not by how many separate moments that
# takes). It is genuinely slow in aggregate: there is no single "rebuild the
# cache" command, so a cold cache means every subsequent install or build
# re-downloads piecemeal until it warms back up. Both things are true and
# both are said plainly in each finding's rebuildCost string, per rule 2's
# instruction that an operator must be able to check the claim, not just
# trust the classification.
#
# WHY THIS IS NOT MARKER-GATED THE WAY THE OTHER THREE RECLAIM FINDERS ARE:
# reclaim-node/-flutter/-gradle propose removing a PER-PROJECT artifact, so
# rule 1 requires a marker in the SAME directory before proposing it. A
# package-manager cache is not per-project - it is one shared directory per
# tool per machine, named by the tool's own convention or an explicit
# redirect variable, and it does not become more or less regenerable
# depending on which projects currently exist. So instead of a marker gate,
# this finder uses Find-ToolchainConsumers (4rn) to attach EVIDENCE of who
# would refill it - the same positive-consumer principle the Flutter-SDK
# safety case established, applied as information rather than as a removal
# gate, because clearing a cache is safe regardless of whether a consumer is
# currently visible (see 4rn's own function doc: a toolchain looking unused
# is not proof it is; the same caution applies here, so an empty consumer
# search narrates the evidence honestly instead of promoting the cache to a
# stronger classification it would not otherwise earn).
#
# REDIRECT VARIABLES: HANDOFF-2026-08-21 Module 2 found GRADLE_USER_HOME,
# ANDROID_HOME, ANDROID_SDK_ROOT, npm_config_cache and PIP_CACHE_DIR ALL
# UNSET on the operator's machine, meaning every one of these caches had
# silently defaulted to C: since the machine was built. This finder checks
# the redirect variable FIRST and only falls back to the tool's own default
# location if it is unset, and says which one it used in the evidence -
# the same fact Module 2 surfaces from the other direction (that the
# variable is unset at all).
#
# AUDIT-ONLY (Module 1 / aeu). This finder proposes; it does not remove.
#
# All script-scoped names in this file are prefixed PiuCache on purpose -
# finders/_loader.ps1's Import-Finders dot-sources every *.finder.ps1 into
# ONE shared scope on every run, so an unprefixed helper here could collide
# with an identically-tempting name in a sibling finder from another agent
# working this same tree concurrently. Same convention as ho2 (Ho2*), sgn
# (Sgn*) and the other reclaim-*.finder.ps1 files.
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other
# file in this directory.

# e6gn: the consumer markers, at FILE scope so the shared walk harvests all
# of them before any handler runs. Import-Finders loads every finder file
# first, so declaring here is what makes ONE walk serve all three cache
# specs instead of one walk per marker.
#
# The specs below read from this table rather than repeating the strings,
# so a marker cannot be added to a spec and forgotten here. If one ever is,
# Find-ToolchainConsumers registers whatever it was passed before walking,
# so the cost of the drift is one extra walk and never a wrong answer.
$script:PiuCacheMarkerSets = @{
    npm    = @('package.json')
    Gradle = @('gradlew', 'build.gradle', 'build.gradle.kts')
    pip    = @('requirements.txt', 'pyproject.toml', 'setup.py')
}
Register-SharedWalkHarvest -markerNames @($script:PiuCacheMarkerSets.Values | ForEach-Object { $_ })

function script:Get-PiuCacheDirBytes {
    <#
    .SYNOPSIS
        Sum file bytes under a directory; a partial walk is reported as
        could-not-look, never as if it were the whole total (aeu).

    .DESCRIPTION
        Now a thin wrapper over Measure-FinderPathBytes in
        finders/_contract.ps1. This function used to be its own
        `Get-ChildItem -Recurse -File -Force` walk, byte-for-byte identical
        to the copy in three sibling finders, and all four were building a
        full FileInfo PSObject per file to read one field. The shared
        version is 2.2x faster on the same tree with an identical sum, and
        -- the larger win -- it MEMOISES, so the finders that size the same
        directory as each other stop paying for it twice. See bd lhf.

        The return shape is unchanged, so no call site moved.
    #>
    param([Parameter(Mandatory = $true)][string]$path)

    $m = Measure-FinderPathBytes -path $path
    return @{
        bytes     = [long]$m.bytes
        fileCount = [int]$m.fileCount
        hadError  = [bool]$m.hadError
        detail    = [string]$m.detail
    }
}


function script:Format-PiuCacheBytes {
    param([long]$bytes)
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
    return "$bytes bytes"
}

function script:Get-PiuCacheConsumerNote {
    <#
    .SYNOPSIS
        Ask Find-ToolchainConsumers (4rn) who would refill this cache, and
        phrase the answer as evidence rather than as a gate.
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$markers,
        [string[]]$roots,
        [int]$maxDepth
    )

    $result = Find-ToolchainConsumers -markers $markers -roots $roots -maxDepth $maxDepth
    $note = switch ($result.state) {
        'found' {
            "$($result.findingCount) project(s) found under the searched roots matching $($markers -join ', ') that would refill this cache on their next install/build."
        }
        'could-not-look' {
            "No matching project found under the searched roots, but $($result.unreadableCount) location(s) could not be read - per 4rn, that does not prove the cache is unused, only that this consumer search was incomplete."
        }
        default {
            "No project matching $($markers -join ', ') found under the searched roots. Per 4rn's Flutter-SDK case, an empty consumer search here is informational only and does not change the cost to refill the cache - it changes only how soon that cost is paid."
        }
    }
    return $note
}

Register-Finder -name 'reclaim-package-caches' `
    -title 'Package-manager download caches (npm, Gradle, pip)' `
    -module 'reclaim' `
    -auditOnly $true `
    -description 'Known global cache directories for npm, Gradle and pip. Classified cheap (nothing here is unique) but says plainly that refilling is piecemeal and slow, per piu rule 2 - see bd vanish-uninstaller-piu.' `
    -handler {
        param($p)

        $roots = @(Get-FieldValue -record $p -name 'roots' -default @())
        $roots = @($roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

        $maxDepth = 0
        try { $maxDepth = [int](Get-FieldValue -record $p -name 'maxDepth' -default 4) } catch { $maxDepth = 4 }
        if ($maxDepth -le 0) { $maxDepth = 4 }

        # Each entry: which redirect variable (if any) governs this cache,
        # the fallback default if that variable is unset, the markers that
        # prove a consumer exists, and the rebuild-cost story (cheap by
        # rule, justified in this file's header comment, not asserted bare).
        $cacheSpecs = @(
            @{
                tool       = 'npm'
                envVar     = 'npm_config_cache'
                default    = (Join-Path $env:LOCALAPPDATA 'npm-cache')
                markers    = $script:PiuCacheMarkerSets['npm']
                evidence   = 'HANDOFF-2026-08-21 measured 4.5 GB here on the operator machine.'
                rebuild    = 'Refills automatically as npm re-downloads whatever it next installs; every package in it is also on the npm registry, so nothing here is unique. No single command replays the whole cache at once - a cold cache means the next several installs are network-bound until it warms back up.'
            },
            @{
                tool       = 'Gradle'
                envVar     = 'GRADLE_USER_HOME'
                default    = (Join-Path $env:USERPROFILE '.gradle\caches')
                markers    = $script:PiuCacheMarkerSets['Gradle']
                evidence   = 'HANDOFF-2026-08-21 measured 14.7 GB here on the operator machine - the largest single reclaim target found.'
                rebuild    = 'Refills automatically as Gradle re-resolves and re-downloads dependencies for whichever project builds next; every artifact in it also lives in the Maven/Gradle repositories the project already points at. No single command replays it - the next build after a clear re-fetches only what that build actually needs, but a cold cache slows every build until it does.'
            },
            @{
                tool       = 'pip'
                envVar     = 'PIP_CACHE_DIR'
                default    = (Join-Path $env:LOCALAPPDATA 'pip\Cache')
                markers    = $script:PiuCacheMarkerSets['pip']
                evidence   = 'HANDOFF-2026-08-21 measured 570 MB here on the operator machine.'
                rebuild    = 'Refills automatically as pip re-downloads whatever it next installs; every wheel/sdist in it also lives on PyPI (or whichever index was configured). No single command replays it - the next install after a clear is slower, network-bound, until the cache warms back up.'
            }
        )

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()
        $withheld   = [System.Collections.Generic.List[string]]::new()
        $examined   = 0

        foreach ($spec in $cacheSpecs) {
            $examined++

            $envValue = [Environment]::GetEnvironmentVariable($spec.envVar)
            $usedEnv = -not [string]::IsNullOrWhiteSpace($envValue)
            $cachePath = if ($usedEnv) { $envValue } else { $spec.default }
            $sourceDesc = if ($usedEnv) { "$($spec.envVar) is set to '$cachePath'" } else { "$($spec.envVar) is not set; using $($spec.tool)'s own default location '$cachePath' (HANDOFF-2026-08-21 Module 2 found this variable unset on the operator machine, which is why the default path matters at all)" }

            if (-not (Test-Path -LiteralPath $cachePath -PathType Container -ErrorAction SilentlyContinue)) {
                # Not present is not a finding and not unreadable - the tool
                # may simply never have run on this machine. Only an
                # existing-but-unenumerable path is aeu's concern.
                continue
            }

            $guard = Test-NeverTouchPath $cachePath
            if ($null -ne $guard) {
                $withheld.Add("$cachePath ($($guard.reason))")
                $findings.Add((New-Finding `
                    -id          "reclaim-package-caches|$($spec.tool)|never-touch" `
                    -title       "$($spec.tool) cache at '$cachePath' is protected and will not be offered" `
                    -path        $cachePath `
                    -bytes       0 `
                    -evidence    "$sourceDesc. Matches the never-touch guard '$($guard.path)': $($guard.reason)" `
                    -rebuildCost "N/A - refused by never-touch, not offered for removal." `
                    -costClass   'irreplaceable' `
                    -action      'never'))
                continue
            }

            $size = Get-PiuCacheDirBytes -path $cachePath

            # gkib: a PARTIAL measurement is still a measurement, and it used
            # to be thrown away. This block used to record the unreadable and
            # then `continue`, so one subdirectory Windows would not enumerate
            # dropped the whole cache out of the findings. On the operator
            # machine that meant a 14.35 GB Gradle cache - the largest reclaim
            # target on the disk - vanished from the panel and the check said
            # could-not-look instead.
            #
            # aeu was satisfied by that (a partial total was never passed off
            # as a whole one) and the operator was still worse off: "at least
            # 12 GB, one folder could not be read" is equally honest and
            # actually useful. So the unreadable record STAYS, and the finding
            # is reported alongside it with the total labelled as a floor.
            #
            # bytes = 0 with an error is different and still drops out: there
            # is no floor to report, only an unreadable location.
            $partial = [bool]$size.hadError
            if ($partial) {
                $unreadable.Add((New-Unreadable -path $cachePath -reason 'access-denied' `
                    -detail "Could not fully measure '$cachePath': $($size.detail)"))
            }
            if ($size.bytes -le 0) { continue }

            # Every number this finding shows is prefixed once, here, so the
            # floor cannot appear unqualified in one place and qualified in
            # another.
            $atLeast = if ($partial) { 'at least ' } else { '' }
            $floorNote = if ($partial) {
                "Part of this folder could not be read ($($size.detail)), so both numbers are a FLOOR and the real cache is larger. "
            } else { '' }

            $consumerNote = Get-PiuCacheConsumerNote -markers $spec.markers -roots $roots -maxDepth $maxDepth

            $findings.Add((New-Finding `
                -id          "reclaim-package-caches|$($spec.tool)" `
                -title       "$($spec.tool) cache ($atLeast$(Format-PiuCacheBytes $size.bytes))" `
                -path        $cachePath `
                -bytes       $size.bytes `
                -evidence    "$sourceDesc; contains $atLeast$($size.fileCount) file(s) totalling $atLeast$(Format-PiuCacheBytes $size.bytes). $floorNote$($spec.evidence) $consumerNote" `
                -rebuildCost $spec.rebuild `
                -costClass   'cheap' `
                -action      'audit'))
        }

        $note = "Checked $examined known package-manager cache location(s) (npm, Gradle, pip), each keyed off its own redirect variable first and its tool default second. Classified cheap per rule 2's worked example, justified in this file's header: nothing in a download cache is unique, but refilling is piecemeal, not a single rebuild step."
        if ($withheld.Count -gt 0) {
            $note += " $($withheld.Count) path(s) withheld by the never-touch list: " + ($withheld -join '; ') + "."
        }

        return New-FinderResult `
            -finder 'reclaim-package-caches' `
            -title 'Package-manager download caches (npm, Gradle, pip)' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $examined `
            -note $note
    }
