# ==========================================
# RECLAIM: FLUTTER/DART BUILD ARTIFACTS (piu)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md Module 1 (RECLAIM), bd issue
# vanish-uninstaller-piu. Same two rules as reclaim-node.finder.ps1, applied
# to a different toolchain's marker:
#
#   RULE 1 - DETECT BY PROJECT MARKER, NEVER BY FOLDER NAME. Only propose
#   deleting build/ or .dart_tool/ when the pubspec.yaml that regenerates
#   them is visible in the same directory.
#   RULE 2 - EVERY PROPOSAL STATES ITS REBUILD COST. Real-machine evidence:
#   5.6 GB across build/ and .dart_tool/ on the operator's machine, all of it
#   regenerable by the Flutter toolchain itself.
#
# THE FLUTTER-SDK CASE (4rn), and why it does not apply here: HANDOFF section
# 4 records the Flutter SDK itself looking orphaned and NOT being orphaned -
# SplitSmart is a Flutter app, and Find-ToolchainConsumers exists to check
# for consumers before calling a TOOLCHAIN unused. This finder never makes
# that claim. It never touches the SDK, never proposes removing Flutter
# itself, and the pubspec.yaml it requires beside every candidate IS the
# positive consumer test already, read the other way round: pubspec.yaml
# present means THIS project is live, which is the only fact this finder
# needs before proposing its OWN build/.dart_tool output.
#
# AUDIT-ONLY (Module 1 / aeu). This finder proposes; it does not remove.
#
# All script-scoped names in this file are prefixed PiuFlutter on purpose -
# finders/_loader.ps1's Import-Finders dot-sources every *.finder.ps1 into
# ONE shared scope on every run, so an unprefixed helper here could collide
# with an identically-tempting name in a sibling finder from another agent
# working this same tree concurrently. Same convention as ho2 (Ho2*), sgn
# (Sgn*) and reclaim-node.finder.ps1 (PiuNode*).
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other
# file in this directory.

# Directories never descended into while looking for pubspec.yaml - a
# dependency pulled into .dart_tool or a build output has no pubspec.yaml
# of the user's to find, and walking into it is pure wasted time (and, per
# rule 1, would be the wrong kind of "found" even if it had one).
$script:PiuFlutterSkipDirs = @(
    'node_modules', '.git', 'build', '.dart_tool', '.gradle', 'dist',
    '.expo', '.next', 'out', 'vendor', '.venv', 'venv', '__pycache__',
    '$RECYCLE.BIN', 'System Volume Information'
)

function script:Get-PiuFlutterDirBytes {
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


function script:Format-PiuFlutterBytes {
    param([long]$bytes)
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
    return "$bytes bytes"
}

function script:Find-PiuFlutterProjectDirs {
    <#
    .SYNOPSIS
        Bounded, error-tracked walk under $root for directories directly
        containing a pubspec.yaml - rule 1's positive test for Flutter/Dart.

    .DESCRIPTION
        Manual stack walk, not Get-ChildItem -Recurse, for the reason
        reclaim-node.finder.ps1 and ho2 both give: -Recurse cannot prune a
        subtree from descent, only filter it out afterward, and walking a
        build/ or .dart_tool tree anyway defeats the skip list's purpose.
        Every unreadable directory is captured via -ErrorVariable +err and
        recorded, never inferred from a bare $? (HANDOFF-2026-08-21 SS4's
        two-time pipe-scoring defect, the second time immediately before an
        rm -rf).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [Parameter(Mandatory = $true)][int]$maxDepth,
        [int]$maxDirs = 15000
    )

    $projects    = [System.Collections.Generic.List[string]]::new()
    $unreadable  = [System.Collections.Generic.List[object]]::new()
    $dirsVisited = 0

    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ Path = $root; Depth = 0 })

    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()

        if ($dirsVisited -ge $maxDirs) {
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

        $hasMarker = @($children | Where-Object { -not $_.PSIsContainer -and $_.Name -eq 'pubspec.yaml' }).Count -gt 0
        if ($hasMarker) { $projects.Add($cur.Path) }

        if ($cur.Depth -ge $maxDepth) { continue }
        foreach ($child in $children) {
            if (-not $child.PSIsContainer) { continue }
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($script:PiuFlutterSkipDirs -contains $child.Name) { continue }
            $stack.Push(@{ Path = $child.FullName; Depth = $cur.Depth + 1 })
        }
    }

    return @{ projects = @($projects); unreadable = @($unreadable); dirsVisited = $dirsVisited }
}

Register-Finder -name 'reclaim-flutter' `
    -title 'Flutter/Dart build artifacts regenerable from pubspec.yaml' `
    -module 'reclaim' `
    -auditOnly $true `
    -description 'build/ and .dart_tool/ directories found beside a pubspec.yaml that regenerates them. Never matches on folder name alone (piu rule 1) - see bd vanish-uninstaller-piu.' `
    -handler {
        param($p)

        $roots = @(Get-FieldValue -record $p -name 'roots' -default @())
        $roots = @($roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($roots.Count -eq 0) {
            # Narrow default deliberately - see reclaim-node.finder.ps1's
            # matching comment. This issue proves the marker-detection
            # shape; machine-wide default roots are a follow-up.
            $roots = @($env:USERPROFILE) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        }

        $maxDepth = 0
        try { $maxDepth = [int](Get-FieldValue -record $p -name 'maxDepth' -default 8) } catch { $maxDepth = 8 }
        if ($maxDepth -le 0) { $maxDepth = 8 }

        # .dart_tool is 'cheap': it holds generated package config and
        # regenerates via 'flutter pub get', which is dependency-resolution
        # work comparable to npm install - seconds, not minutes, once the
        # pub cache itself is warm (and the pub cache is untouched by this
        # finder either way). build/ is 'moderate': a full platform build
        # (especially first Android/iOS build, which cascades into
        # Gradle/CocoaPods resolution) can run minutes even with everything
        # else warm - real wall-clock cost, not lost data, which is exactly
        # what rule 2 ranks on.
        $candidateSpecs = @(
            @{ name = '.dart_tool'; costClass = 'cheap' }
            @{ name = 'build';      costClass = 'moderate' }
        )

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()
        $withheld   = [System.Collections.Generic.List[string]]::new()
        $dirsTotal  = 0
        $projectsSeen = 0

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

            $walk = Find-PiuFlutterProjectDirs -root $root -maxDepth $maxDepth
            $dirsTotal += $walk.dirsVisited
            foreach ($u in $walk.unreadable) { $unreadable.Add($u) }

            foreach ($proj in $walk.projects) {
                $projectsSeen++

                $hasLock = Test-Path -LiteralPath (Join-Path $proj 'pubspec.lock') -ErrorAction SilentlyContinue
                $lockDesc = if ($hasLock) { 'pubspec.lock present, so pub get resolves to the exact versions last used' } else { 'no pubspec.lock found - pub get will resolve to the newest versions allowed by pubspec.yaml, which may differ from what was previously installed' }

                foreach ($spec in $candidateSpecs) {
                    $fullPath = Join-Path $proj $spec.name
                    if (-not (Test-Path -LiteralPath $fullPath -PathType Container -ErrorAction SilentlyContinue)) { continue }

                    $guard = Test-NeverTouchPath $fullPath
                    if ($null -ne $guard) {
                        $findings.Add((New-Finding `
                            -id          "reclaim-flutter|$fullPath|never-touch" `
                            -title       "$($spec.name) under '$proj' is protected and will not be offered" `
                            -path        $fullPath `
                            -bytes       0 `
                            -evidence    "Matches pubspec.yaml project marker at '$proj', but '$fullPath' also matches the never-touch guard '$($guard.path)': $($guard.reason)" `
                            -rebuildCost "N/A - refused by never-touch, not offered for removal." `
                            -costClass   'irreplaceable' `
                            -action      'never'))
                        continue
                    }

                    $size = Get-PiuFlutterDirBytes -path $fullPath
                    if ($size.hadError) {
                        $unreadable.Add((New-Unreadable -path $fullPath -reason 'access-denied' `
                            -detail "Could not fully measure '$fullPath': $($size.detail)"))
                        continue
                    }

                    $rebuildCost = switch ($spec.name) {
                        '.dart_tool' {
                            "Regenerates from '$proj\pubspec.yaml' via 'flutter pub get'. $lockDesc. Comparable in cost to npm install - typically seconds once the shared pub cache is warm."
                        }
                        'build' {
                            "Rebuilt by 'flutter build <platform>' (or 'flutter run') from '$proj'. Classified moderate: the first build after a clean can take several minutes, especially Android/iOS where Gradle or CocoaPods also has to resolve - real wait, not lost work. HANDOFF-2026-08-21 measured build/ and .dart_tool/ together at 5.6 GB on the operator's machine, all regenerable this way."
                        }
                        default { 'Regenerable from the pubspec.yaml beside it.' }
                    }

                    $findings.Add((New-Finding `
                        -id          "reclaim-flutter|$fullPath" `
                        -title       "$($spec.name) ($(Format-PiuFlutterBytes $size.bytes)) - regenerable from pubspec.yaml" `
                        -path        $fullPath `
                        -bytes       $size.bytes `
                        -evidence    "pubspec.yaml found at '$proj\pubspec.yaml' (rule 1's positive marker); '$fullPath' contains $($size.fileCount) file(s) totalling $(Format-PiuFlutterBytes $size.bytes)." `
                        -rebuildCost $rebuildCost `
                        -costClass   $spec.costClass `
                        -action      'audit'))
                }
            }
        }

        $projWord = if ($projectsSeen -eq 1) { 'project' } else { 'projects' }
        $dirWord  = if ($dirsTotal -eq 1) { 'directory' } else { 'directories' }
        $note = "Examined $dirsTotal $dirWord under $($roots.Count) root(s); found $projectsSeen Flutter/Dart $projWord by pubspec.yaml. Never proposes build/ or .dart_tool/ without the pubspec.yaml that regenerates them visible in the same directory (piu rule 1). Does not touch or evaluate the Flutter SDK itself - see 4rn on toolchain consumers."
        if ($withheld.Count -gt 0) {
            $note += " $($withheld.Count) path(s) withheld by the never-touch list: " + ($withheld -join '; ') + "."
        }

        return New-FinderResult `
            -finder 'reclaim-flutter' `
            -title 'Flutter/Dart build artifacts regenerable from pubspec.yaml' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $dirsTotal `
            -note $note
    }
