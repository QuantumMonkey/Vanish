# ==========================================
# RECLAIM: NODE.JS / JAVASCRIPT BUILD ARTIFACTS (piu)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md Module 1 (RECLAIM), bd issue
# vanish-uninstaller-piu. Two rules decide this whole file:
#
#   RULE 1 - DETECT BY PROJECT MARKER, NEVER BY FOLDER NAME. A folder named
#   node_modules with no package.json beside it is somebody's DATA, not a
#   build output, and offering to delete it is the difference between a
#   cleaner and an accident. This finder never matches on the name
#   "node_modules" alone - it matches on package.json, and only THEN looks
#   for the regenerable folders that sit beside it.
#
#   RULE 2 - EVERY PROPOSAL STATES ITS REBUILD COST, IN WORDS A HUMAN CAN
#   CHECK. "npm install, ~2 min" vs "re-download 12.9 GB" - that number
#   decides, not the byte count. Real-machine evidence: one repo carried
#   23 GB in node_modules/build output and 614 MB after a clean reinstall -
#   37x cruft, entirely regenerable, entirely safe to classify 'cheap'.
#
# AUDIT-ONLY (Module 1 / aeu). This finder proposes; it does not remove. The
# vault is the only removal path in this application (INV-1).
#
# All script-scoped names in this file are prefixed PiuNode on purpose.
# Finder files are dot-sourced into ONE shared scope by finders/_loader.ps1's
# Import-Finders (every *.finder.ps1 in the directory loads into the same
# call, every time - confirmed against finders/local-only-credentials.finder.ps1's
# own header, bd ho2), so a generically named helper here would collide with
# an identically-tempting name in a sibling finder written by a different
# agent in this same tree at the same time. The prefix is the whole
# mitigation, same convention ho2 (Ho2*) and sgn (Sgn*) already ship.
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other
# file in this directory - dot-sourcing runs in scanner.ps1's caller scope,
# and scanner.ps1's 7,870 lines were never written under strict mode.

# Directories the walk never descends into while LOOKING FOR package.json.
# This is the second half of rule 1, read backwards: once a directory is
# known to be a dependency/build tree, any package.json inside it belongs to
# a dependency, not to a project of the user's, and descending into it would
# turn "detect by project marker" into "detect by folder name, recursively" -
# exactly the defect rule 1 exists to prevent. It is also a speed bound: a
# real node_modules tree can hold thousands of nested package.json files.
$script:PiuNodeSkipDirs = @(
    'node_modules', '.git', 'dist', 'build', '.expo', '.next', 'out',
    'vendor', '.venv', 'venv', '__pycache__', '.gradle', '.dart_tool',
    '$RECYCLE.BIN', 'System Volume Information'
)

# 3l8: what this finder needs collected while the shared walk is running.
# Declared at FILE scope, not inside the handler - Import-Finders loads
# every finder before any handler runs, so the union is complete before
# the first walk starts and the other three are served from its cache.
Register-SharedWalkHarvest -markerNames @('package.json')

function script:Get-PiuNodeDirBytes {
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


function script:Format-PiuNodeBytes {
    param([long]$bytes)
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
    return "$bytes bytes"
}

function script:Find-PiuNodeProjectDirs {
    <#
    .SYNOPSIS
        Directories under $root that contain a package.json, via the one walk this finder now
        shares with the other three reclaim checks (3l8).

    .DESCRIPTION
        This was a private stack walk, identical in every respect to the
        ones in the other three reclaim finders: same default root, same
        depth, the same 15,000-directory cap, and the same fifteen-entry
        skip list written in a different order. Four checks listing the
        same directories cost 66.2 s between them. One listing serving all
        four brings that to 28.2 s and finds exactly the same things: the
        listing itself is 12.4 s of it, and collecting three extra file
        names out of children already enumerated costs nothing measurable.

        The returned SHAPE is deliberately unchanged, so the handler below
        and every test around it kept working without being rewritten to
        suit the optimisation. Invoke-SharedTreeWalk carries the properties
        that mattered - scan-capped as an unreadable record, access-denied
        by real path, no descent into reparse points - so none of them had
        to be re-argued here.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [Parameter(Mandatory = $true)][int]$maxDepth,
        [int]$maxDirs = 15000
    )

    $walk = Invoke-SharedTreeWalk -root $root -maxDepth $maxDepth -maxDirs $maxDirs -skipDirs $script:PiuNodeSkipDirs
    return @{
        projects    = @($walk.markers['package.json'])
        unreadable  = @($walk.unreadable)
        dirsVisited = $walk.dirsVisited
    }
}

Register-Finder -name 'reclaim-node' `
    -title 'Node.js/JavaScript build artifacts regenerable from package.json' `
    -module 'reclaim' `
    -walkGroup 'user-tree' `
    -auditOnly $true `
    -description 'node_modules, .expo, dist and build directories found beside a package.json that regenerates them. Never matches on folder name alone (piu rule 1) - see bd vanish-uninstaller-piu.' `
    -handler {
        param($p)

        $roots = @(Get-FieldValue -record $p -name 'roots' -default @())
        $roots = @($roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($roots.Count -eq 0) {
            # Deliberately narrow rather than a machine-wide drive scan like
            # ho2's Get-Ho2DefaultRoots: this issue (piu) is proving the
            # marker-detection SHAPE on the finders below, not machine-wide
            # coverage. "Split into per-finder issues once piu has proved the
            # shape" (the issue text) is where a broader default belongs.
            $roots = @($env:USERPROFILE) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        }

        $maxDepth = 0
        try { $maxDepth = [int](Get-FieldValue -record $p -name 'maxDepth' -default 8) } catch { $maxDepth = 8 }
        if ($maxDepth -le 0) { $maxDepth = 8 }

        # name -> (costClass, rebuild-cost template). node_modules is 'cheap'
        # by the contract's own worked example. dist/build are 'moderate',
        # not 'cheap' - not because anything is lost, but because a full
        # production build's WALL-CLOCK TIME is not bounded the way a
        # dependency install is (webpack/tsc/vite builds on a large project
        # can run minutes, not seconds), and rule 2 ranks by that cost, not
        # by whether data survives. .expo is 'cheap': it is Metro/Expo's own
        # local dev cache and nothing in it is hand-configured.
        $candidateSpecs = @(
            @{ name = 'node_modules'; costClass = 'cheap' }
            @{ name = '.expo';        costClass = 'cheap' }
            @{ name = 'dist';         costClass = 'moderate' }
            @{ name = 'build';        costClass = 'moderate' }
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

            $walk = Find-PiuNodeProjectDirs -root $root -maxDepth $maxDepth
            $dirsTotal += $walk.dirsVisited
            foreach ($u in $walk.unreadable) { $unreadable.Add($u) }

            foreach ($proj in $walk.projects) {
                $projectsSeen++

                # Which lockfile(s) regenerate this exactly, so the rebuild
                # cost names a real command rather than a generic one.
                $lockNotes = [System.Collections.Generic.List[string]]::new()
                if (Test-Path -LiteralPath (Join-Path $proj 'package-lock.json') -ErrorAction SilentlyContinue) { $lockNotes.Add('package-lock.json present (npm ci)') }
                if (Test-Path -LiteralPath (Join-Path $proj 'pnpm-lock.yaml') -ErrorAction SilentlyContinue)    { $lockNotes.Add('pnpm-lock.yaml present (pnpm install --frozen-lockfile)') }
                if (Test-Path -LiteralPath (Join-Path $proj 'yarn.lock') -ErrorAction SilentlyContinue)         { $lockNotes.Add('yarn.lock present (yarn install --frozen-lockfile)') }
                $lockDesc = if ($lockNotes.Count -gt 0) { $lockNotes -join '; ' } else { 'no lockfile found beside package.json - npm install still works but exact transitive versions may drift from what was previously installed' }

                foreach ($spec in $candidateSpecs) {
                    $fullPath = Join-Path $proj $spec.name
                    if (-not (Test-Path -LiteralPath $fullPath -PathType Container -ErrorAction SilentlyContinue)) { continue }

                    $guard = Test-NeverTouchPath $fullPath
                    if ($null -ne $guard) {
                        # 4rn: surface the refusal, do not silently drop the
                        # candidate. Bytes are deliberately NOT measured into
                        # the reclaimable total for a never-touch item - the
                        # size is real but this path will never be offered,
                        # so counting it would overstate what is reclaimable.
                        $findings.Add((New-Finding `
                            -id          "reclaim-node|$fullPath|never-touch" `
                            -title       "$($spec.name) under '$proj' is protected and will not be offered" `
                            -path        $fullPath `
                            -bytes       0 `
                            -evidence    "Matches package.json project marker at '$proj', but '$fullPath' also matches the never-touch guard '$($guard.path)': $($guard.reason)" `
                            -rebuildCost "N/A - refused by never-touch, not offered for removal." `
                            -costClass   'irreplaceable' `
                            -action      'never'))
                        continue
                    }

                    $size = Get-PiuNodeDirBytes -path $fullPath
                    if ($size.hadError) {
                        # A size that hit access-denial partway through must
                        # NOT be reported as if it were the total (aeu).
                        $unreadable.Add((New-Unreadable -path $fullPath -reason 'access-denied' `
                            -detail "Could not fully measure '$fullPath': $($size.detail)"))
                        continue
                    }

                    $rebuildCost = switch ($spec.name) {
                        'node_modules' {
                            "Regenerates entirely from '$proj\package.json'. $lockDesc. Real-machine evidence (HANDOFF-2026-08-21): one repo measured 23 GB before reinstall and 614 MB after - a 37x difference, and the reinstall itself was on the order of minutes."
                        }
                        '.expo' {
                            "Local Expo/Metro bundler cache; regenerates automatically the next time 'expo start' or 'npx expo prebuild' runs in '$proj'. No re-download beyond what a normal dev session already does."
                        }
                        'dist' {
                            "Runs from '$proj's own build script (commonly 'npm run build'); needs node_modules already restored first. Classified moderate, not cheap, because full builds on larger projects can take several minutes and that wait is real even though nothing is lost."
                        }
                        'build' {
                            "Same as dist: rebuilt by '$proj's own build script once dependencies are installed. Classified moderate because build time is not bounded the way a dependency install is."
                        }
                        default { 'Regenerable from the project marker beside it.' }
                    }

                    $findings.Add((New-Finding `
                        -id          "reclaim-node|$fullPath" `
                        -title       "$($spec.name) ($(Format-PiuNodeBytes $size.bytes)) - regenerable from package.json" `
                        -path        $fullPath `
                        -bytes       $size.bytes `
                        -evidence    "package.json found at '$proj\package.json' (rule 1's positive marker); '$fullPath' contains $($size.fileCount) file(s) totalling $(Format-PiuNodeBytes $size.bytes)." `
                        -rebuildCost $rebuildCost `
                        -costClass   $spec.costClass `
                        -action      'audit'))
                }
            }
        }

        $projWord = if ($projectsSeen -eq 1) { 'project' } else { 'projects' }
        $dirWord  = if ($dirsTotal -eq 1) { 'directory' } else { 'directories' }
        $note = "Examined $dirsTotal $dirWord under $($roots.Count) root(s); found $projectsSeen Node/JS $projWord by package.json. Never proposes node_modules, .expo, dist or build without the package.json that regenerates them visible in the same directory (piu rule 1)."
        if ($withheld.Count -gt 0) {
            $note += " $($withheld.Count) path(s) withheld by the never-touch list: " + ($withheld -join '; ') + "."
        }

        return New-FinderResult `
            -finder 'reclaim-node' `
            -title 'Node.js/JavaScript build artifacts regenerable from package.json' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $dirsTotal `
            -note $note
    }
