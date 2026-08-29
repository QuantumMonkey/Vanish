# ==========================================
# THE FINDER CONTRACT (aeu)
# ==========================================
# Binding design constraint from docs/history/HANDOFF-2026-08-21.md section 4,
# derived from FIVE real instances of one defect class during the two-day
# manual cleanup that produced this suite's specification:
#
#     A check that cannot distinguish "clean" from "could not read" will
#     happily authorise deleting work.
#
# The five, all observed, none hypothetical: git ownership errors read as
# clean; [ -d ] on a case-insensitive filesystem reporting renames already
# done; an unquoted search path silently skipping an entire store; $? after a
# pipe scoring `tail` instead of the command - TWICE, the second immediately
# before an `rm -rf`; and a permission-denied restore-point query reported as
# "disabled".
#
# Every one of those is the same shape: a two-state answer (found something /
# found nothing) covering a three-state world. The third state - COULD NOT
# LOOK - collapsed into "nothing", and "nothing" is what authorises a delete.
#
# So the state is NOT something a finder asserts. It is COMPUTED here, from
# the evidence the finder collected, by New-FinderResult. A finder that wanted
# to report "nothing" while holding unreadable entries cannot: there is no code
# path that produces that pair. This is the 5p5 principle applied one layer
# down - make the defect unrepresentable rather than guard against it.

# NOTE ON Set-StrictMode: deliberately NOT set here. These files are
# dot-sourced into scanner.ps1, and dot-sourcing runs in the CALLERS scope -
# so a Set-StrictMode line would silently impose strict semantics on 7,870
# lines that were never written for it, and the failures would surface as
# unrelated features breaking in a VM. Get-FieldValue exists to make
# missing-member access explicit instead.

# The three answers. There are exactly three and there will not be a fourth;
# a fourth would mean the decider has a case it can forget to handle.
$script:FinderStates = @('found', 'nothing', 'could-not-look')

# What a finder is allowed to propose. Note there is no 'delete' - the vault
# is the only removal path in this application (INV-1), and 'audit' is the
# default because Module 3 ships audit-only by design.
$script:FinderActions = @('audit', 'quarantine', 'never')


function Get-FieldValue {
    <#
    .SYNOPSIS
        Read one field from a hashtable OR a PSCustomObject, without guessing.

    .DESCRIPTION
        Findings cross the PowerShell/JSON boundary in both directions, so the
        same logical record arrives as a Hashtable when a finder built it and
        as a PSCustomObject when it came back through ConvertFrom-Json. Under
        Set-StrictMode, reaching for a missing member on either one throws, and
        .ContainsKey() does not exist on the second - so a helper that works on
        exactly one of the two shapes is a landmine with a delay fuse.
    #>
    param(
        [object]$record,
        [Parameter(Mandatory = $true)][string]$name,
        [object]$default = $null
    )

    if ($null -eq $record) { return $default }

    if ($record -is [System.Collections.IDictionary]) {
        if ($record.Contains($name)) { return $record[$name] }
        return $default
    }

    $prop = $record.PSObject.Properties[$name]
    if ($null -ne $prop) { return $prop.Value }
    return $default
}


function New-Unreadable {
    <#
    .SYNOPSIS
        One thing the finder tried to look at and could not.

    .DESCRIPTION
        The reason is not decoration. "10 repos returned dubious ownership from
        a previous profile SID" is actionable; "10 errors" is not, and during
        the real cleanup that exact distinction was the difference between
        fixing ten repos in one command and re-investigating each.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$path,
        [Parameter(Mandatory = $true)][string]$reason,
        [string]$detail = ''
    )

    return @{
        path   = $path
        reason = $reason
        detail = $detail
    }
}


function New-Finding {
    <#
    .SYNOPSIS
        One thing the finder found, with everything a decider needs to rank it.

    .DESCRIPTION
        rebuildCost is mandatory for anything proposing removal, and that is
        HANDOFF-2026-08-21 Module 1 rule 2 stated as code rather than as a
        docstring: "npm install, ~2 min" versus "re-download 12.9 GB". THAT
        NUMBER DECIDES, NOT THE SIZE. A 23 GB node_modules that rebuilds in two
        minutes and a 12 GB VM image that took a day to configure are not the
        same offer, and a cleaner that ranks by bytes gets it exactly backwards.

        evidence answers "why do you believe this", in a sentence a human can
        check. Every finding in this suite is falsifiable by the operator
        reading one line, because the alternative is trusting a tool that
        deletes things for a living.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$id,
        [Parameter(Mandatory = $true)][string]$title,
        [string]$path = '',
        [long]$bytes = 0,
        [string]$evidence = '',
        [string]$rebuildCost = '',
        [ValidateSet('cheap', 'moderate', 'expensive', 'irreplaceable', 'unknown')][string]$costClass = 'unknown',
        [ValidateSet('audit', 'quarantine', 'never')][string]$action = 'audit',
        [object]$detail = $null
    )

    if ($action -ne 'audit' -and [string]::IsNullOrWhiteSpace($rebuildCost)) {
        # Deliberately a hard failure, not a default. A missing rebuild cost on
        # something the UI will offer to remove is the one omission that makes
        # the whole ranking wrong, and a silent "unknown" would rank as cheap.
        throw "New-Finding '$id': action '$action' proposes removal, so rebuildCost is required. If it is genuinely unknown, say so in the string - an unknown cost the operator can see beats an absent one the ranker treats as free."
    }

    return @{
        id          = $id
        title       = $title
        path        = $path
        bytes       = $bytes
        evidence    = $evidence
        rebuildCost = $rebuildCost
        # 'unknown' sorts LAST in lib/findings.js, not first. An unmeasured
        # cost is not a cheap one, and a ranker that treated it as zero would
        # float the most dangerous offers to the top of the list.
        costClass   = $costClass
        action      = $action
        detail      = $detail
    }
}


function New-FinderResult {
    <#
    .SYNOPSIS
        Build a finder's typed result, computing the state from the evidence.

    .DESCRIPTION
        THE STATE IS NOT A PARAMETER. That is the entire point of this function
        and the reason finders call it instead of building a hashtable.

        The rules, in the order they are applied:

        1. Any findings at all             -> 'found'
        2. No findings, nothing unreadable -> 'nothing'   (a real, trustworthy
                                              empty result; the ONLY thing a
                                              decider may treat as clean)
        3. No findings, something unreadable -> 'could-not-look'

        Rule 3 is the whole issue. A sweep that read 90 trees cleanly and could
        not open 10 has NOT established that the machine is clean, and the 90
        are not lost - examinedCount and unreadableCount both travel with the
        result, so the UI can say "no findings in 90 locations; 10 could not be
        read" instead of "nothing found". That sentence is a named terminal
        state (5p5), not a shrug.

        'complete' is the cheap boolean for callers that only need to know
        whether to trust the count. It is false whenever anything was
        unreadable, INCLUDING when findings exist - a partial 'found' is still
        partial, and "we found 3" quietly meaning "3 of an unknown number" is
        the same defect wearing a success badge.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$finder,
        [Parameter(Mandatory = $true)][string]$title,
        [object[]]$findings = @(),
        [object[]]$unreadable = @(),
        [int]$examined = 0,
        [string]$note = '',
        [object]$detail = $null
    )

    $found = @($findings | Where-Object { $null -ne $_ })
    $blind = @($unreadable | Where-Object { $null -ne $_ })

    $state = if ($found.Count -gt 0) {
        'found'
    } elseif ($blind.Count -eq 0) {
        'nothing'
    } else {
        'could-not-look'
    }

    $totalBytes = 0L
    foreach ($f in $found) {
        $b = Get-FieldValue -record $f -name 'bytes' -default 0
        if ($null -ne $b) { $totalBytes += [long]$b }
    }

    return @{
        finder          = $finder
        title           = $title
        state           = $state
        complete        = ($blind.Count -eq 0)
        findings        = $found
        findingCount    = $found.Count
        unreadable      = $blind
        unreadableCount = $blind.Count
        examinedCount   = $examined
        totalBytes      = $totalBytes
        note            = $note
        detail          = $detail
    }
}


function Assert-RemovalPrecondition {
    <#
    .SYNOPSIS
        Verify a destructive step's own precondition BY COMPARISON, in code,
        immediately before acting. HANDOFF-2026-08-21 section 4, constraint 2.

    .DESCRIPTION
        "cp && rm is not enough - compare counts and bytes." The exit status of
        a copy says the copy command did not fail. It does not say the bytes
        arrived, and on the real machine `$?` after a pipe scored the wrong
        command twice, the second time immediately before an rm -rf.

        So the caller passes what it believes it produced and this compares it
        against what is actually on disk, right now, at the moment of asking.
        A mismatch throws. There is no boolean return, because a boolean return
        is a thing a caller can forget to check.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$survivorPath,
        [Parameter(Mandatory = $true)][long]$expectedBytes,
        [string]$expectedSha256 = ''
    )

    if (-not (Test-Path -LiteralPath $survivorPath -PathType Leaf)) {
        throw "Refusing to proceed: the surviving copy at '$survivorPath' does not exist. This is checked here rather than trusted from an earlier step because an earlier step reporting success is not evidence the bytes arrived."
    }

    $actual = (Get-Item -LiteralPath $survivorPath -ErrorAction Stop).Length
    if ($actual -ne $expectedBytes) {
        throw "Refusing to proceed: the surviving copy at '$survivorPath' is $actual bytes, expected $expectedBytes. Counts and bytes are compared, not inferred from an exit code."
    }

    if (-not [string]::IsNullOrWhiteSpace($expectedSha256)) {
        $hash = (Get-FileHash -LiteralPath $survivorPath -Algorithm SHA256 -ErrorAction Stop).Hash
        if ($hash -ne $expectedSha256.ToUpperInvariant()) {
            throw "Refusing to proceed: the surviving copy at '$survivorPath' hashes to $hash, expected $expectedSha256. Same size is not same content, which is the entire premise of a content-hash deduplicator."
        }
    }
}

# ==========================================
# ONE DIRECTORY SIZER, MEASURED (lhf)
# ==========================================
# Six near-identical copies of "sum the bytes under a path" existed across the
# finders -- four of them byte-for-byte identical -- and every one of them was
# `Get-ChildItem -Recurse -File -Force` plus a loop over .Length. That builds a
# full FileInfo PSObject for every file on the way to reading one field.
#
# MEASURED on the operator's machine 2026-08-28, profiling each finder in one
# process:
#
#   redirect-variables      59592 ms   to examine FIVE things
#   reclaim-package-caches  52252 ms   to examine THREE
#
# Neither walks a tree looking for anything. Both just size a handful of very
# large directories, and between them they were 112 seconds of a scan that
# takes over ten minutes.
#
# Two separate wastes, both fixed here:
#
# 1. THE SAME DIRECTORY, SIZED REPEATEDLY. redirect-variables reports
#    ANDROID_HOME and ANDROID_SDK_ROOT separately -- correctly, they are two
#    different variables -- and on a machine where neither is set they name the
#    SAME default path. It sized 129,198 files twice to print 13 GB twice.
#    Results are memoised by normalised path for the life of one scan.
#
# 2. THE PSOBJECT TAX. A hand-rolled walk over DirectoryInfo.EnumerateFiles is
#    2.2x faster on the same tree with a byte-identical, file-count-identical
#    answer (Android SDK: 25916 ms -> 11589 ms, 129,198 files, sums equal).
#
# NOT EnumerateFiles(..., AllDirectories): on .NET Framework that throws on the
# first unauthorised subdirectory and abandons everything after it, which is
# precisely why Get-ChildItem -ErrorAction SilentlyContinue was used. The
# per-directory try/catch below keeps going AND records the real path that
# failed -- strictly better evidence than -ErrorVariable, which the old copies
# reduced to a single message with no path attached.
#
# ONE DELIBERATE DIVERGENCE, and it is an improvement rather than a shortcut:
# this skips reparse points (junctions and symlinks). A junction is not part of
# this subtree - it is a second name for somewhere else - so following one
# double-counts at best and loops forever at worst. scanner.ps1's Measure-Paths
# already refuses to follow them for the same reason.
#
# AEU DISCIPLINE IS UNCHANGED. A partial sum is still returned rather than a
# zero, because an under-count is a safer lie than an invented one - but
# `unreadable` now carries every directory that could not be enumerated, by
# path, so the caller can turn a partial walk into New-Unreadable instead of
# trusting the number silently.
$script:FinderSizeCache = @{}

function Clear-FinderSizeCache {
    <#
    .SYNOPSIS
        Drop every memoised size. Called at the start of each scan.

    .DESCRIPTION
        Scoped to a scan, not to the process, and that is the whole point: a
        cached size is a claim about the disk as it was, and a second run
        exists precisely because the operator changed something. A sizer that
        remembered across runs would report the state before the change and be
        impossible to tell apart from one that had looked.
    #>
    $script:FinderSizeCache = @{}
}

function Measure-FinderPathBytes {
    <#
    .SYNOPSIS
        Bytes under a path, memoised, with every unreadable directory named.

    .OUTPUTS
        @{
            bytes       = [long]   sum of file lengths, partial if anything was unreadable
            fileCount   = [int]    files actually counted
            existed     = [bool]   the path was there at all
            isFile      = [bool]   it was a file, not a directory
            unreadable  = [string[]] directories that could not be enumerated
            detail      = [string] the first real exception message, or ''
            hadError    = [bool]   shorthand for unreadable.Count -gt 0
        }
    #>
    param([string]$path)

    $empty = @{ bytes = 0L; fileCount = 0; existed = $false; isFile = $false; unreadable = @(); detail = ''; hadError = $false }
    if ([string]::IsNullOrWhiteSpace($path)) { return $empty }

    # Normalised so 'C:\X' and 'C:\X\' are one cache entry rather than two.
    $key = $path.TrimEnd('\', '/').ToLowerInvariant()
    if ($script:FinderSizeCache.ContainsKey($key)) { return $script:FinderSizeCache[$key] }

    $result = $empty.Clone()

    try {
        if (-not (Test-Path -LiteralPath $path -ErrorAction SilentlyContinue)) {
            $script:FinderSizeCache[$key] = $result
            return $result
        }
        $result.existed = $true

        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (-not $item.PSIsContainer) {
            $result.isFile = $true
            $result.bytes = [long]$item.Length
            $result.fileCount = 1
            $script:FinderSizeCache[$key] = $result
            return $result
        }
    } catch {
        $result.detail = $_.Exception.Message
        $result.unreadable = @($path)
        $result.hadError = $true
        $script:FinderSizeCache[$key] = $result
        return $result
    }

    $sum = 0L
    $count = 0
    $blind = [System.Collections.Generic.List[string]]::new()
    $firstDetail = ''

    $stack = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
    $stack.Push([System.IO.DirectoryInfo]::new($path))

    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        try {
            foreach ($f in $dir.EnumerateFiles()) {
                $sum += $f.Length
                $count++
            }
        } catch {
            $blind.Add($dir.FullName)
            if (-not $firstDetail) { $firstDetail = $_.Exception.Message }
            continue
        }
        try {
            foreach ($d in $dir.EnumerateDirectories()) {
                if (($d.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                $stack.Push($d)
            }
        } catch {
            $blind.Add($dir.FullName)
            if (-not $firstDetail) { $firstDetail = $_.Exception.Message }
        }
    }

    $result.bytes = $sum
    $result.fileCount = $count
    $result.unreadable = @($blind)
    $result.detail = $firstDetail
    $result.hadError = ($blind.Count -gt 0)

    $script:FinderSizeCache[$key] = $result
    return $result
}


# ==========================================
# THE SHARED TREE WALK (3l8)
# ==========================================
# MEASURED 2026-08-29, warm, on the operator's machine:
#
#   one walk of $env:USERPROFILE, depth 8, cap 15000     12.4 s
#   harvesting FOUR markers instead of one               12.4 s   (no cost)
#   reclaim-node + archives + flutter + gradle, apart    66.2 s
#   ...the same four in one call, sharing the walk       28.2 s
#
# Four finders were asking four questions about the same directories and
# paying for the directory listing four times. The listing is the entire
# cost: harvesting three extra file names out of children we have already
# enumerated does not move the number at all.
#
# So the walk became a service and the questions became a harvest. Each
# finder still calls its own Find-* helper and still gets its own shape
# back; underneath, the first one to ask pays 12.4 s and the other three
# are served from the cache.
#
# WHY THE HARVEST IS A REGISTRY RATHER THAN A PARAMETER. If each finder
# asked for its own marker, the second finder's request would miss the
# cache and walk again - the exact cost this exists to remove. So every
# finder declares its markers at LOAD time (Import-Finders dot-sources all
# of them before any handler runs), and the walk harvests the union. A
# finder added later joins the shared walk by declaring, with no other
# file touched.
#
# AND WHY THE HARVEST IS STILL IN THE CACHE KEY. A registration arriving
# after a walk has already run would otherwise be answered from a cache
# that never looked for it - a finder reporting 'nothing' because nobody
# collected its marker, which is aeu's defect with a performance
# optimisation holding the door open. Keying on the harvest makes that
# case a second walk instead of a wrong answer.
#
# THE CACHE IS SCOPED TO ONE SCAN, for the reason Clear-FinderSizeCache
# gives: a second run exists because something changed.
$script:SharedWalkCache = @{}
$script:SharedWalkMarkers = [System.Collections.Generic.List[string]]::new()
$script:SharedWalkExtensions = [System.Collections.Generic.List[string]]::new()

# ENTRY NAMES are the third harvest kind, and they exist because '.git' is
# usually a directory. A marker name only ever matches a child that is a
# FILE, which is right for package.json and wrong for a repo root: a
# submodule or a linked worktree has a '.git' FILE, an ordinary clone has a
# '.git' DIRECTORY, and both are repos. An entry name matches either.
#
# It is collected BEFORE the reparse, skip-list and depth cuts, so naming a
# directory in both -entryNames and -skipDirs reads as "count it, do not
# walk into it" - which is exactly what the two git finders expressed as a
# Test-Path plus a Where-Object that dropped .git from the children.
$script:SharedWalkEntryNames = [System.Collections.Generic.List[string]]::new()

function Register-SharedWalkHarvest {
    <#
    .SYNOPSIS
        Declare the file names and extensions a finder needs collected.

    .DESCRIPTION
        Called at FILE scope by a finder, not inside its handler: the union
        has to be complete before the first walk runs, and Import-Finders
        loads every file before Invoke-HygieneScan calls any handler.

        Idempotent, and deliberately so - Import-Finders can run twice in one
        process (probe then scan), and a harvest that doubled would change the
        cache key and throw away a perfectly good walk.
    #>
    param(
        [string[]]$markerNames = @(),
        [string[]]$extensions = @(),
        [string[]]$entryNames = @()
    )

    foreach ($m in @($markerNames)) {
        if ([string]::IsNullOrWhiteSpace($m)) { continue }
        if (-not ($script:SharedWalkMarkers -contains $m)) { $script:SharedWalkMarkers.Add($m) }
    }
    foreach ($e in @($extensions)) {
        if ([string]::IsNullOrWhiteSpace($e)) { continue }
        if (-not ($script:SharedWalkExtensions -contains $e)) { $script:SharedWalkExtensions.Add($e) }
    }
    foreach ($n in @($entryNames)) {
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        if (-not ($script:SharedWalkEntryNames -contains $n)) { $script:SharedWalkEntryNames.Add($n) }
    }
}

function Get-SharedWalkHarvest {
    <#
    .SYNOPSIS
        What the shared walk currently collects. Exposed for the test suite,
        which asserts that every reclaim finder's marker is actually in it -
        a finder that forgot to register would find nothing and look clean.
    #>
    return @{
        markers    = @($script:SharedWalkMarkers)
        extensions = @($script:SharedWalkExtensions)
        entryNames = @($script:SharedWalkEntryNames)
    }
}

function Clear-SharedWalkCache {
    <#
    .SYNOPSIS
        Drop every memoised walk. Called at the start of each scan.

    .NOTES
        The HARVEST is not cleared. It is a declaration by the loaded finders
        about what they need, not an observation about the disk, and clearing
        it would leave the second scan of a process harvesting nothing.
    #>
    $script:SharedWalkCache = @{}
}

function Invoke-SharedTreeWalk {
    <#
    .SYNOPSIS
        Walk one root once, collecting every registered marker and extension,
        and memoise the result for the rest of this scan.

    .OUTPUTS
        @{
            markers     = @{ 'package.json' = @(directory paths); ... }
            entries     = @{ '.git' = @(directory paths); ... }
            files       = @{ '.zip' = @(FileInfo); ... }
            unreadable  = @(New-Unreadable records)
            dirsVisited = [int]
            capped      = [bool]
        }

        markers and entries are keyed by every registered name, files by
        every registered extension, all present even when empty - so a caller
        reading a key it registered never gets $null, and never has to tell
        "collected nothing" apart from "was not collected".

    .NOTES
        This is the four reclaim walkers merged, and it keeps every property
        they had, because each was there for a reason:

        * A directory that could not be enumerated becomes New-Unreadable with
          the real path and the real .NET message, captured via -ErrorVariable
          +err rather than inferred from a bare $? - the pipe-scoring defect
          named twice in HANDOFF-2026-08-21 section 4.
        * A reparse point is not descended into. A junction is a second name
          for somewhere else, so following one double-counts at best and loops
          forever at worst.
        * Hitting maxDirs is scan-capped, an unreadable record, NOT a quiet
          truncation. A subtree never visited has established nothing, and a
          capped run reporting itself complete is the exact defect this suite
          exists to make unrepresentable.
        * The marker check happens BEFORE the depth cut, so a project sitting
          exactly at maxDepth is still seen; only descent past it stops.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [Parameter(Mandatory = $true)][int]$maxDepth,
        [int]$maxDirs = 15000,
        [string[]]$skipDirs = @()
    )

    $markerNames = @($script:SharedWalkMarkers)
    $extensions  = @($script:SharedWalkExtensions)
    $entryNames  = @($script:SharedWalkEntryNames)

    # Sorted and lower-cased so two finders passing the same skip list in a
    # different order share one walk rather than each paying for their own -
    # which is the whole point, and was true of all four reclaim finders.
    $skipKey    = (@($skipDirs | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object) -join '|')
    $markerKey  = (@($markerNames | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object) -join '|')
    $extKey     = (@($extensions | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object) -join '|')
    $entryKey   = (@($entryNames | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object) -join '|')
    $key = ($root.TrimEnd('\', '/').ToLowerInvariant() + "|d$maxDepth|c$maxDirs|" + $skipKey + '|' + $markerKey + '|' + $extKey + '|' + $entryKey)

    if ($script:SharedWalkCache.ContainsKey($key)) { return $script:SharedWalkCache[$key] }

    $markers = @{}
    foreach ($m in $markerNames) { $markers[$m] = [System.Collections.Generic.List[string]]::new() }
    $files = @{}
    foreach ($e in $extensions) { $files[$e] = [System.Collections.Generic.List[object]]::new() }
    $entries = @{}
    foreach ($n in $entryNames) { $entries[$n] = [System.Collections.Generic.List[string]]::new() }

    $unreadable  = [System.Collections.Generic.List[object]]::new()
    $dirsVisited = 0
    $capped      = $false

    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ Path = $root; Depth = 0 })

    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()

        if ($dirsVisited -ge $maxDirs) {
            $capped = $true
            $detail = "The scan visited $maxDirs directories under '$root' and stopped early so a run never hangs. Pass a narrower 'roots' list to cover what was skipped."
            $unreadable.Add((New-Unreadable -path $cur.Path -reason 'scan-capped' -detail $detail))
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
            # Ahead of every cut below, and deliberately: an entry name is
            # collected whether the child is a file or a directory, and
            # whether or not the walk is about to refuse to descend into it.
            if ($entryNames.Count -gt 0) {
                $cname = $child.Name
                foreach ($n in $entryNames) {
                    if ($cname -eq $n) { $entries[$n].Add($cur.Path); break }
                }
            }

            if (-not $child.PSIsContainer) {
                $name = $child.Name
                foreach ($m in $markerNames) {
                    if ($name -eq $m) { $markers[$m].Add($cur.Path); break }
                }
                $ext = $child.Extension
                if ($ext) {
                    foreach ($x in $extensions) {
                        if ($ext -ieq $x) { $files[$x].Add($child); break }
                    }
                }
                continue
            }
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($skipDirs -contains $child.Name) { continue }
            if ($cur.Depth -ge $maxDepth) { continue }
            $stack.Push(@{ Path = $child.FullName; Depth = $cur.Depth + 1 })
        }
    }

    $flatMarkers = @{}
    foreach ($m in $markerNames) { $flatMarkers[$m] = @($markers[$m]) }
    $flatFiles = @{}
    foreach ($x in $extensions) { $flatFiles[$x] = @($files[$x]) }
    $flatEntries = @{}
    foreach ($n in $entryNames) { $flatEntries[$n] = @($entries[$n]) }

    $result = @{
        markers     = $flatMarkers
        entries     = $flatEntries
        files       = $flatFiles
        unreadable  = @($unreadable)
        dirsVisited = $dirsVisited
        capped      = $capped
    }

    $script:SharedWalkCache[$key] = $result
    return $result
}
