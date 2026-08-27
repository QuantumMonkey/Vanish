# ==========================================
# RECLAIM: GRADLE/ANDROID BUILD ARTIFACTS (piu)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md Module 1 (RECLAIM), bd issue
# vanish-uninstaller-piu. Same two rules as reclaim-node.finder.ps1 and
# reclaim-flutter.finder.ps1, applied to Gradle/Android:
#
#   RULE 1 - DETECT BY PROJECT MARKER, NEVER BY FOLDER NAME. Only propose
#   deleting .gradle/ or a module's build/ output when the gradlew wrapper
#   that regenerates them is visible in the project.
#   RULE 2 - EVERY PROPOSAL STATES ITS REBUILD COST. Real-machine evidence:
#   5.8 GB across .gradle/ and module build/ output on the operator's
#   machine.
#
# WHAT THIS FILE DOES NOT TOUCH: the GLOBAL Gradle cache under
# GRADLE_USER_HOME (typically ~/.gradle/caches, measured at 14.7 GB on the
# operator's machine) is a shared download cache across every Gradle
# project on the box, not a per-project artifact - it belongs to
# reclaim-package-caches.finder.ps1, and conflating the two would double-
# count the same bytes under two different rebuild-cost stories.
#
# THE PROJECT-LAYOUT ASSUMPTION, stated rather than hidden: gradlew marks
# the ROOT of a Gradle project, and Gradle/Android's own convention is that
# each module keeps its build output at <module>/build/ (the canonical
# example is app/build/, which is where HANDOFF's "android/app/build/"
# comes from - "android" is commonly the module folder's name in a
# React Native tree, not a second path segment Gradle itself requires).
# So this finder checks the project root's own build/, plus <module>/build/
# for every immediate module directory - which covers both a bare Android
# Studio project (gradlew at the root, app/build/ one level down) and a
# React Native project (gradlew inside android/, app/build/ one level down
# from THAT), without hard-coding the literal segment "android" anywhere.
#
# AUDIT-ONLY (Module 1 / aeu). This finder proposes; it does not remove.
#
# All script-scoped names in this file are prefixed PiuGradle on purpose -
# finders/_loader.ps1's Import-Finders dot-sources every *.finder.ps1 into
# ONE shared scope on every run, so an unprefixed helper here could collide
# with an identically-tempting name in a sibling finder from another agent
# working this same tree concurrently. Same convention as ho2 (Ho2*), sgn
# (Sgn*) and the other two reclaim-*.finder.ps1 files (PiuNode*, PiuFlutter*).
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other
# file in this directory.

# Directories never descended into while looking for gradlew - once inside
# one of these, any gradlew found belongs to a dependency, a build output,
# or a different toolchain's tree, not a project of the user's.
$script:PiuGradleSkipDirs = @(
    'node_modules', '.git', 'build', '.gradle', '.dart_tool', 'dist',
    '.expo', '.next', 'out', 'vendor', '.venv', 'venv', '__pycache__',
    '$RECYCLE.BIN', 'System Volume Information'
)

function script:Get-PiuGradleDirBytes {
    <#
    .SYNOPSIS
        Sum file bytes under a directory; a partial walk is reported as
        could-not-look, never as if it were the whole total (aeu).
    #>
    param([Parameter(Mandatory = $true)][string]$path)

    $err = $null
    $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue -ErrorVariable +err)
    $bytes = 0L
    foreach ($f in $files) { $bytes += [long]$f.Length }

    $hadError = @($err).Count -gt 0
    $detail = ''
    if ($hadError) { $detail = (@($err) | Select-Object -First 1).Exception.Message }

    return @{ bytes = $bytes; fileCount = $files.Count; hadError = $hadError; detail = $detail }
}

function script:Format-PiuGradleBytes {
    param([long]$bytes)
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
    return "$bytes bytes"
}

function script:Find-PiuGradleProjectDirs {
    <#
    .SYNOPSIS
        Bounded, error-tracked walk under $root for directories directly
        containing a gradlew file - rule 1's positive test for Gradle.

    .DESCRIPTION
        Manual stack walk, not Get-ChildItem -Recurse, for the reason the
        other two reclaim finders and ho2 all give: -Recurse cannot prune a
        subtree from descent, only filter it out afterward. Every
        unreadable directory is captured via -ErrorVariable +err, never
        inferred from a bare $? (HANDOFF-2026-08-21 SS4's two-time
        pipe-scoring defect, the second time immediately before an rm -rf).
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

        $hasMarker = @($children | Where-Object { -not $_.PSIsContainer -and $_.Name -eq 'gradlew' }).Count -gt 0
        if ($hasMarker) { $projects.Add($cur.Path) }

        if ($cur.Depth -ge $maxDepth) { continue }
        foreach ($child in $children) {
            if (-not $child.PSIsContainer) { continue }
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($script:PiuGradleSkipDirs -contains $child.Name) { continue }
            $stack.Push(@{ Path = $child.FullName; Depth = $cur.Depth + 1 })
        }
    }

    return @{ projects = @($projects); unreadable = @($unreadable); dirsVisited = $dirsVisited }
}

Register-Finder -name 'reclaim-gradle' `
    -title 'Gradle/Android build artifacts regenerable from gradlew' `
    -module 'reclaim' `
    -auditOnly $true `
    -description '.gradle/ (per-project cache) and module build/ directories (e.g. app/build/) found in a project whose gradlew wrapper regenerates them. Never matches on folder name alone (piu rule 1) - see bd vanish-uninstaller-piu.' `
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

            $walk = Find-PiuGradleProjectDirs -root $root -maxDepth $maxDepth
            $dirsTotal += $walk.dirsVisited
            foreach ($u in $walk.unreadable) { $unreadable.Add($u) }

            foreach ($proj in $walk.projects) {
                $projectsSeen++

                # Candidate list, built per project: the project-local
                # .gradle/ cache, the root's own build/, and build/ under
                # every immediate module directory (the app/build/ pattern).
                # 'cheap' for .gradle - it is Gradle's own incremental-build
                # bookkeeping and task-output cache for THIS project, fully
                # rebuilt by the next gradlew invocation. 'moderate' for
                # build/ output - an Android module assemble/compile step
                # can run minutes even with the global dependency cache
                # already warm (see reclaim-package-caches.finder.ps1 for
                # that cache), so the wait is real even though nothing here
                # is hand-configured or irreplaceable.
                $candidates = [System.Collections.Generic.List[object]]::new()
                $candidates.Add(@{ path = (Join-Path $proj '.gradle'); costClass = 'cheap'; label = '.gradle' })
                $candidates.Add(@{ path = (Join-Path $proj 'build');   costClass = 'moderate'; label = 'build' })

                $moduleDirs = @(Get-ChildItem -LiteralPath $proj -Directory -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne '.gradle' -and $_.Name -ne 'build' -and $_.Name -ne '.git' -and -not (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) })
                foreach ($mod in $moduleDirs) {
                    $modBuild = Join-Path $mod.FullName 'build'
                    if (Test-Path -LiteralPath $modBuild -PathType Container -ErrorAction SilentlyContinue) {
                        $candidates.Add(@{ path = $modBuild; costClass = 'moderate'; label = "$($mod.Name)\build" })
                    }
                }

                foreach ($cand in $candidates) {
                    $fullPath = $cand.path
                    if (-not (Test-Path -LiteralPath $fullPath -PathType Container -ErrorAction SilentlyContinue)) { continue }

                    $guard = Test-NeverTouchPath $fullPath
                    if ($null -ne $guard) {
                        $findings.Add((New-Finding `
                            -id          "reclaim-gradle|$fullPath|never-touch" `
                            -title       "$($cand.label) under '$proj' is protected and will not be offered" `
                            -path        $fullPath `
                            -bytes       0 `
                            -evidence    "Matches gradlew project marker at '$proj', but '$fullPath' also matches the never-touch guard '$($guard.path)': $($guard.reason)" `
                            -rebuildCost "N/A - refused by never-touch, not offered for removal." `
                            -costClass   'irreplaceable' `
                            -action      'never'))
                        continue
                    }

                    $size = Get-PiuGradleDirBytes -path $fullPath
                    if ($size.hadError) {
                        $unreadable.Add((New-Unreadable -path $fullPath -reason 'access-denied' `
                            -detail "Could not fully measure '$fullPath': $($size.detail)"))
                        continue
                    }

                    $rebuildCost = if ($cand.label -eq '.gradle') {
                        "Per-project Gradle cache and incremental-task output for '$proj'; regenerates the next time '.\gradlew build' (or any gradlew task) runs there. Distinct from the GLOBAL Gradle cache under GRADLE_USER_HOME, which reclaim-package-caches.finder.ps1 handles separately - clearing this does not touch that."
                    } else {
                        "Standard Gradle/Android build output for '$fullPath'; '.\gradlew assembleDebug' (or the project's usual build task) from '$proj' regenerates it. Classified moderate: Android module builds can take minutes even with a warm global dependency cache. HANDOFF-2026-08-21 measured .gradle/ and module build/ output together at 5.8 GB on the operator's machine."
                    }

                    $findings.Add((New-Finding `
                        -id          "reclaim-gradle|$fullPath" `
                        -title       "$($cand.label) ($(Format-PiuGradleBytes $size.bytes)) - regenerable from gradlew" `
                        -path        $fullPath `
                        -bytes       $size.bytes `
                        -evidence    "gradlew found at '$proj\gradlew' (rule 1's positive marker); '$fullPath' contains $($size.fileCount) file(s) totalling $(Format-PiuGradleBytes $size.bytes)." `
                        -rebuildCost $rebuildCost `
                        -costClass   $cand.costClass `
                        -action      'audit'))
                }
            }
        }

        $projWord = if ($projectsSeen -eq 1) { 'project' } else { 'projects' }
        $dirWord  = if ($dirsTotal -eq 1) { 'directory' } else { 'directories' }
        $note = "Examined $dirsTotal $dirWord under $($roots.Count) root(s); found $projectsSeen Gradle $projWord by gradlew. Never proposes .gradle/ or a module's build/ without the gradlew that regenerates them visible in the project (piu rule 1). Does not touch the global Gradle cache under GRADLE_USER_HOME - see reclaim-package-caches.finder.ps1."
        if ($withheld.Count -gt 0) {
            $note += " $($withheld.Count) path(s) withheld by the never-touch list: " + ($withheld -join '; ') + "."
        }

        return New-FinderResult `
            -finder 'reclaim-gradle' `
            -title 'Gradle/Android build artifacts regenerable from gradlew' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $dirsTotal `
            -note $note
    }
