# ==========================================
# RECLAIM: REDUNDANT ARCHIVES (piu)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md Module 1 (RECLAIM), bd issue
# vanish-uninstaller-piu. Real-machine evidence: 1.8 GB in *.zip files sitting
# beside a directory that is already the extracted contents of that same zip.
#
# THE MARKER, READ FOR THIS FINDER: the other three reclaim finders detect a
# BUILD OUTPUT by the project-config file that regenerates it (piu rule 1).
# An archive has no build config - its own positive marker is the extracted
# DIRECTORY sitting right beside it, because that directory is itself the
# tangible proof the zip was already unpacked. This finder never proposes a
# zip on name or size alone; it only proposes one that has a same-named
# directory as its sibling, which is the same "regenerating evidence must be
# visible in the same place" shape as rule 1, applied to an archive instead
# of a project.
#
# WHAT "SAME NAME" MEANS: the zip's base name (no extension) matches the
# sibling directory's name, case-insensitively, in the SAME parent folder
# only - never a match found by searching elsewhere in the tree, which would
# be exactly the "folder name, not marker" mistake rule 1 exists to prevent.
#
# CONTENT CHECK, AND ITS HONEST LIMIT: this finder additionally compares the
# archive's own top-level entry count (read via ZipFile.OpenRead, without
# extracting anything) against the sibling directory's top-level item count,
# and says the result in the evidence string. This is corroborating evidence,
# not proof of byte-for-byte identity - that would require extracting the
# archive and diffing it, which this audit-only finder does not do. Rule 2's
# own text - "evidence answers why do you believe this, in a sentence a
# human can check" - is why the mismatch case is still reported (as a
# caveat in the same finding) rather than silently promoted to more
# confidence than the check actually earned.
#
# AUDIT-ONLY (Module 1 / aeu). This finder proposes; it does not remove.
#
# All script-scoped names in this file are prefixed PiuArchive on purpose -
# finders/_loader.ps1's Import-Finders dot-sources every *.finder.ps1 into
# ONE shared scope on every run, so an unprefixed helper here could collide
# with an identically-tempting name in a sibling finder from another agent
# working this same tree concurrently. Same convention as ho2 (Ho2*), sgn
# (Sgn*) and the other reclaim-*.finder.ps1 files.
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other
# file in this directory.

# Directories never descended into while searching for *.zip files - a zip
# inside a dependency tree or build output is noise for this finder's
# purpose and walking into these is pure wasted time on any real machine.
$script:PiuArchiveSkipDirs = @(
    'node_modules', '.git', 'build', '.gradle', '.dart_tool', 'dist',
    '.expo', '.next', 'out', 'vendor', '.venv', 'venv', '__pycache__',
    '$RECYCLE.BIN', 'System Volume Information'
)

function script:Format-PiuArchiveBytes {
    param([long]$bytes)
    if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
    if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
    return "$bytes bytes"
}

function script:Find-PiuArchiveZipFiles {
    <#
    .SYNOPSIS
        Bounded, error-tracked walk under $root for *.zip files.

    .DESCRIPTION
        Manual stack walk, not Get-ChildItem -Recurse, for the reason every
        other reclaim finder and ho2 give: -Recurse cannot prune a subtree
        from descent, only filter it out afterward, and walking a
        node_modules or build tree for zip files anyway defeats the skip
        list's purpose. Every unreadable directory is captured via
        -ErrorVariable +err, never inferred from a bare $? (the
        HANDOFF-2026-08-21 SS4 defect named twice, the second time
        immediately before an rm -rf).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [Parameter(Mandatory = $true)][int]$maxDepth,
        [int]$maxDirs = 15000
    )

    $zips        = [System.Collections.Generic.List[object]]::new()
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

        foreach ($child in $children) {
            if (-not $child.PSIsContainer) {
                if ($child.Extension -ieq '.zip') { $zips.Add($child) }
                continue
            }
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($script:PiuArchiveSkipDirs -contains $child.Name) { continue }
            if ($cur.Depth -ge $maxDepth) { continue }
            $stack.Push(@{ Path = $child.FullName; Depth = $cur.Depth + 1 })
        }
    }

    return @{ zips = @($zips); unreadable = @($unreadable); dirsVisited = $dirsVisited }
}

function script:Get-PiuArchiveTopLevelCount {
    <#
    .SYNOPSIS
        Count the archive's own top-level entries without extracting it -
        the corroborating half of this finder's evidence, not proof.
    #>
    param([Parameter(Mandatory = $true)][string]$zipPath)

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $tops = New-Object System.Collections.Generic.HashSet[string]
            foreach ($e in $zip.Entries) {
                $name = $e.FullName -replace '\\', '/'
                $first = $name.Split('/')[0]
                if (-not [string]::IsNullOrWhiteSpace($first)) { [void]$tops.Add($first) }
            }
            return @{ ok = $true; count = $tops.Count }
        } finally {
            $zip.Dispose()
        }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message }
    }
}

Register-Finder -name 'reclaim-archives' `
    -title 'Redundant archives (a *.zip beside its own extracted directory)' `
    -module 'reclaim' `
    -auditOnly $true `
    -description 'A *.zip file with a same-named directory beside it in the same folder - the directory is the marker proving the archive was already unpacked. See bd vanish-uninstaller-piu.' `
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
        $zipsSeen   = 0

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

            $walk = Find-PiuArchiveZipFiles -root $root -maxDepth $maxDepth
            $dirsTotal += $walk.dirsVisited
            foreach ($u in $walk.unreadable) { $unreadable.Add($u) }

            foreach ($zip in $walk.zips) {
                $zipsSeen++

                $baseName = [System.IO.Path]::GetFileNameWithoutExtension($zip.Name)
                $parent = $zip.DirectoryName
                $siblingDir = Join-Path $parent $baseName

                if (-not (Test-Path -LiteralPath $siblingDir -PathType Container -ErrorAction SilentlyContinue)) {
                    # No same-named directory beside it - this is the
                    # regression rule 1's analogue exists to enforce: name
                    # or size alone is never enough, only the marker is.
                    continue
                }

                $guard = Test-NeverTouchPath $zip.FullName
                if ($null -ne $guard) {
                    $withheld.Add("$($zip.FullName) ($($guard.reason))")
                    $findings.Add((New-Finding `
                        -id          "reclaim-archives|$($zip.FullName)|never-touch" `
                        -title       "$($zip.Name) is protected and will not be offered" `
                        -path        $zip.FullName `
                        -bytes       0 `
                        -evidence    "Matches the redundant-archive marker (extracted directory '$siblingDir' present), but also matches the never-touch guard '$($guard.path)': $($guard.reason)" `
                        -rebuildCost "N/A - refused by never-touch, not offered for removal." `
                        -costClass   'irreplaceable' `
                        -action      'never'))
                    continue
                }

                $dirErr = $null
                $dirItems = @(Get-ChildItem -LiteralPath $siblingDir -Force -ErrorAction SilentlyContinue -ErrorVariable +dirErr)
                if (@($dirErr).Count -gt 0) {
                    $unreadable.Add((New-Unreadable -path $siblingDir -reason 'access-denied' `
                        -detail "Could not enumerate the candidate extracted directory beside '$($zip.FullName)': $((@($dirErr) | Select-Object -First 1).Exception.Message)"))
                    continue
                }
                $dirTopCount = $dirItems.Count

                $zipBytes = 0L
                try { $zipBytes = [long](Get-Item -LiteralPath $zip.FullName -ErrorAction Stop).Length } catch { $zipBytes = 0L }

                $peek = Get-PiuArchiveTopLevelCount -zipPath $zip.FullName
                $corroboration = if (-not $peek.ok) {
                    "the archive itself could not be opened to compare entry counts ($($peek.error)) - name match only, verify manually before deleting"
                } elseif ($peek.count -eq $dirTopCount) {
                    "the archive's own top-level entry count ($($peek.count)) matches the extracted directory's top-level item count ($dirTopCount), consistent with being the same content"
                } else {
                    "the archive's own top-level entry count ($($peek.count)) does NOT match the extracted directory's top-level item count ($dirTopCount) - verify manually before deleting, this is a name match plus a caveat, not a confirmed identical copy"
                }

                $findings.Add((New-Finding `
                    -id          "reclaim-archives|$($zip.FullName)" `
                    -title       "$($zip.Name) ($(Format-PiuArchiveBytes $zipBytes)) - already extracted at '$siblingDir'" `
                    -path        $zip.FullName `
                    -bytes       $zipBytes `
                    -evidence    "Extracted directory '$siblingDir' sits beside this archive with a matching name - the marker this finder requires; $corroboration." `
                    -rebuildCost "The extracted directory already holds everything the archive does. If the ZIP itself is ever needed again (for example to redistribute), recreate it from '$siblingDir' with Compress-Archive (or any zip tool) in seconds - nothing is downloaded or rebuilt, because nothing was removed from the source." `
                    -costClass   'cheap' `
                    -action      'audit'))
            }
        }

        $zipWord = if ($zipsSeen -eq 1) { 'zip file' } else { 'zip files' }
        $dirWord = if ($dirsTotal -eq 1) { 'directory' } else { 'directories' }
        $note = "Examined $dirsTotal $dirWord under $($roots.Count) root(s); found $zipsSeen $zipWord total, of which only ones with a same-named extracted directory beside them are proposed. A zip with no matching directory is left alone - it is the only copy, not a redundant one."
        if ($withheld.Count -gt 0) {
            $note += " $($withheld.Count) path(s) withheld by the never-touch list: " + ($withheld -join '; ') + "."
        }

        return New-FinderResult `
            -finder 'reclaim-archives' `
            -title 'Redundant archives (a *.zip beside its own extracted directory)' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $dirsTotal `
            -note $note
    }
