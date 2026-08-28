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
