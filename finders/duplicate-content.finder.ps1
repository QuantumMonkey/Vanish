# ==========================================
# MODULE 3.3 RESCUE -- CONTENT-HASH DEDUP ACROSS TREES (vanish-uninstaller-30i)
# ==========================================
# From docs/history/HANDOFF-2026-08-21.md section 3, Module 3. Used TWICE in
# the real two-day cleanup this suite's specification came from: 41 duplicates
# found inside phone backups, and 79 files duplicated between two trees. Both
# were found by CONTENT, not by name or size -- a phone backup renames files
# on export, and two trees holding the "same" folder rarely agree on casing or
# a trailing "(1)".
#
# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other file
# under finders/. This file is dot-sourced into scanner.ps1's scope by
# Import-Finders (finders/_loader.ps1), and Set-StrictMode here would silently
# impose strict semantics retroactively on the 7,870 lines that were never
# written for it. See finders/_contract.ps1's identical note.
#
# ---- THE ONLY SANE ORDER: SIZE FIRST, HASH ONLY WITHIN A GROUP OF >1 ----
# Hashing every file on a drive to find that 99% of them are unique is the
# naive version of this feature, and it is unusably slow -- SHA-256 over a
# whole drive tree means reading every byte of every file at least once, most
# of it for nothing, because a file cannot duplicate another file's content
# without first matching its LENGTH. So this finder does two passes:
#
#   Pass 1: Get-ChildItem once, group files by Length. O(n), no file content
#           read -- just the directory metadata Get-ChildItem already fetched.
#   Pass 2: for each size group with MORE THAN ONE member, hash every member
#           of THAT group and re-group by SHA-256. A size group of exactly one
#           file is, by construction, not a duplicate of anything on this
#           machine and is never opened for hashing -- test 3 in
#           test/finder-dedup-verify.ps1 proves this by locking such a file
#           unreadable and asserting the run never notices.
#
# Same size, different hash is common (two videos that happen to share a byte
# count) and is exactly why size is a pre-filter, never a verdict -- that is
# assertion 2 in the test suite: same name AND same size, different content,
# must never be reported.
#
# ---- SURVIVOR SELECTION -- MUST BE AN ANSWER THE OPERATOR CAN CHECK ----
# "The tool picked one" is not an answer an operator can verify against their
# own memory of which copy is real. The rule, in order, each step only a
# tie-breaker for the one before it:
#
#   1. OLDEST LastWriteTimeUtc wins. A later copy is, in every real case this
#      finder exists for (a phone backup export, a second copy of a folder
#      dragged somewhere else), the one that got duplicated FROM the older
#      one, not the reverse -- you cannot copy a file before it exists.
#   2. Tie -> SHALLOWEST path (fewest path separators). Two files timestamped
#      identically (a straight folder copy preserves mtime) are broken by
#      preferring the one that is not buried inside a "backup" or "old" or
#      dated subfolder, which is where the deeper copy usually lives.
#   3. Tie -> ordinal, case-insensitive full-path comparison. Purely for
#      determinism: two files can legitimately share both timestamp and depth,
#      and a survivor choice that changes between runs on unchanged input is
#      itself a defect an operator cannot audit.
#
# This is deliberately NOT "the one outside a backup-looking folder" as a
# pattern match on the path string -- that is a guess dressed as a rule, and
# guessing at folder names is exactly the kind of heuristic HANDOFF-2026-08-21
# section 4 catalogues five failures of. Timestamp and depth are facts already
# on disk; a name pattern is not.
#
# ---- NEVER-TOUCH ----
# Every path this finder reports is run through Test-NeverTouchPath first
# (finders/_never-touch.ps1). A never-touch path can always safely be the
# SURVIVOR -- keeping it changes nothing -- but it must never be handed back
# as one of the copies a later removal step could act on, so each copy carries
# its own `removalEligible` flag rather than being silently dropped from the
# report. Silently omitting it would be indistinguishable from a finder that
# failed to look, which is the exact defect the never-touch file's own header
# warns against.
#
# ---- THE SURVIVOR MANIFEST ----
# This finder is audit-only (module 'rescue', auditOnly $true) -- it proposes
# groups, it removes nothing. But HANDOFF-2026-08-21 section 4 rule 2 is
# binding on whatever removal step comes later: "a destructive step must
# verify its own precondition by comparison, in code, immediately before
# acting", and every destructive action must write a manifest recording what
# was removed and the path of the identical copy that survived. Write-
# SurvivorManifest below is that writer, built and unit-tested now (see
# test/finder-dedup-verify.ps1 assertions 5 and 6) so the removal path has
# something proven to call rather than something to invent under pressure
# later. It is gated on finders/_contract.ps1's Assert-RemovalPrecondition,
# which this file does not re-implement -- it is already written there.

# NOTE ON `function script:Name` BELOW -- IT IS NOT DECORATION:
# finders/_loader.ps1's Import-Finders dot-sources every *.finder.ps1 from
# INSIDE A FUNCTION (Import-Finders itself). Dot-sourcing runs in the
# CALLER's scope, which here is that function's own local scope, torn down
# the instant Import-Finders returns. A plain `function Name { }` declared at
# this file's top level would therefore exist only during the import and be
# gone before the -handler below (or anything else) ever calls it -- and
# Register-Finder still succeeds and the finder still shows up healthy in
# `finder-probe list`, because that call only writes to $script:FinderRegistry,
# so the failure surfaces two layers away, as the HANDLER throwing "term not
# recognized" the first time the engine actually runs it (which is exactly
# what happened here during development: `finder-probe list` looked perfect
# and hygiene-scan still came back could-not-look with a finder-failed entry).
#
# `function script:Name { }` fixes it by writing the function into the
# SCRIPT scope of whichever .ps1 file is running at the top of the call stack
# -- scanner.ps1, in real use -- the same trick finders/_never-touch.ps1 uses
# for `$script:NeverTouchPaths`. That scope is an ancestor of every function's
# dynamic scope chain for the lifetime of the process, so it survives
# Import-Finders returning and is visible from inside the -handler scriptblock
# no matter how many function calls deep it is invoked from.
#
# One consequence for the test suite: dot-sourcing this file directly (to unit
# test Write-SurvivorManifest / Read-SurvivorManifest without a removal action
# to call them through yet) must happen at the TEST SCRIPT'S OWN top level,
# not inside a function, so `script:` binds to the test script and the
# functions are visible afterward exactly the same way.

function script:Get-DedupSurvivorChoice {
    <#
    .SYNOPSIS
        Given every file that shares one SHA-256, pick the one to keep.

    .DESCRIPTION
        See the header comment at the top of this file for why this order and
        not another. $members is a list of hashtables: @{ path; bytes;
        lastWriteUtc }. Returns @{ survivor = <one member>; copies = <every
        other member> }.
    #>
    param([Parameter(Mandatory = $true)][object[]]$members)

    $ordered = @($members | Sort-Object -Property `
        @{ Expression = { $_.lastWriteUtc } }, `
        @{ Expression = { ([regex]::Matches([string]$_.path, '\\')).Count } }, `
        @{ Expression = { ([string]$_.path).ToLowerInvariant() } })

    return @{
        survivor = $ordered[0]
        copies   = @($ordered | Select-Object -Skip 1)
    }
}


function script:Write-SurvivorManifest {
    <#
    .SYNOPSIS
        Write ONE manifest document for ONE destructive action on ONE group.

    .DESCRIPTION
        HANDOFF-2026-08-21 section 4: "every destructive action writes a
        manifest -- what was removed, and the path of the identical copy that
        survived." That is what separates this from every dedup tool: after
        the run you can still answer "where did that file go" without
        restoring anything, because the survivor's path is sitting right next
        to the record of what was removed.

        $group is a hashtable: @{ hash; survivor = @{ path; bytes };
        removed = @(@{ path; bytes }, ...) }. Nothing is read back from the
        filesystem here -- the caller is expected to have already confirmed
        (via Assert-RemovalPrecondition, immediately before removing each
        copy) that the survivor really does exist with the bytes and hash
        this manifest claims. The manifest records what the removal step
        believed and acted on; it is not itself the verification.

        One JSON document per call, named with the run timestamp and a hash
        prefix so concurrent groups in one run never collide on a filename.
        Readable back with nothing but ConvertFrom-Json -- no database, no
        companion index file -- because a survivor manifest that itself needs
        infrastructure to read defeats the point of writing one.
    #>
    param(
        [Parameter(Mandatory = $true)][object]$Group,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory
    )

    if ([string]::IsNullOrWhiteSpace((Get-FieldValue -record $Group -name 'hash' -default ''))) {
        throw "Write-SurvivorManifest: group has no 'hash'. A manifest that cannot name which content it is about is not a manifest."
    }
    $survivor = Get-FieldValue -record $Group -name 'survivor' -default $null
    if ($null -eq $survivor -or [string]::IsNullOrWhiteSpace([string](Get-FieldValue -record $survivor -name 'path' -default ''))) {
        throw "Write-SurvivorManifest: group has no survivor path. Every removal this manifest could ever justify depends on that path being real."
    }

    if (-not (Test-Path -LiteralPath $DestinationDirectory -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $DestinationDirectory -Force
    }

    $hash      = [string](Get-FieldValue -record $Group -name 'hash' -default '')
    $removed   = @(Get-FieldValue -record $Group -name 'removed' -default @())
    $timestamp = (Get-Date).ToUniversalTime()

    $manifest = [ordered]@{
        schemaVersion = 1
        timestamp     = $timestamp.ToString('o')
        hash          = $hash
        survivor      = @{
            path  = [string](Get-FieldValue -record $survivor -name 'path' -default '')
            bytes = [long](Get-FieldValue -record $survivor -name 'bytes' -default 0)
        }
        removed = @($removed | ForEach-Object {
            @{
                path  = [string](Get-FieldValue -record $_ -name 'path' -default '')
                bytes = [long](Get-FieldValue -record $_ -name 'bytes' -default 0)
            }
        })
    }

    $stamp    = $timestamp.ToString('yyyyMMddTHHmmssfffZ')
    $hashPart = $hash.Substring(0, [Math]::Min(12, $hash.Length))
    $fileName = "dedup-manifest-$stamp-$hashPart.json"
    $filePath = Join-Path $DestinationDirectory $fileName

    ($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $filePath -Encoding UTF8

    return $filePath
}


function script:Read-SurvivorManifest {
    <#
    .SYNOPSIS
        Read one manifest back. No other state is consulted -- see above.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Read-SurvivorManifest: '$Path' does not exist."
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}


Register-Finder -name 'duplicate-content' -title 'Files duplicated by content across trees' -module 'rescue' -auditOnly $true -handler {
    param($p)

    $roots = @(Get-FieldValue -record $p -name 'roots' -default @() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (@($roots).Count -eq 0) {
        $roots = @($env:USERPROFILE) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    $unreadable = [System.Collections.Generic.List[object]]::new()
    $findings   = [System.Collections.Generic.List[object]]::new()
    $examined   = 0

    # ---- pass 1: enumerate every file once, group by size only ----
    # $bySize[<length>] = list of FileInfo. No byte of file content is read in
    # this pass -- Length is directory metadata Get-ChildItem already has.
    $bySize = @{}

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container -ErrorAction SilentlyContinue)) {
            $unreadable.Add((New-Unreadable -path $root -reason 'root-missing' -detail 'The search root does not exist or is not a directory.'))
            continue
        }

        # -ErrorVariable +err, never bare $? after this pipeline -- aeu binding
        # rule 1. A subtree that returns access-denied here has not been
        # examined and must not be allowed to read as "no duplicates below."
        $err = $null
        $files = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +err)

        foreach ($e in @($err)) {
            if ($null -eq $e) { continue }
            $target = if ($e.TargetObject) { [string]$e.TargetObject } else { $root }
            $unreadable.Add((New-Unreadable -path $target -reason 'access-denied' -detail $e.Exception.Message))
        }

        foreach ($f in $files) {
            $examined++
            $key = [long]$f.Length
            if (-not $bySize.ContainsKey($key)) { $bySize[$key] = [System.Collections.Generic.List[object]]::new() }
            $bySize[$key].Add($f)
        }
    }

    # ---- pass 2: hash ONLY within a size group that has more than one file ----
    # A size group of exactly one is, by construction, unique on this machine
    # and is never opened. This is the entire performance argument for doing
    # size first -- see the header comment -- and test 3 in
    # test/finder-dedup-verify.ps1 proves it by locking such a file unreadable
    # and asserting the run completes as if it had never existed.
    $byHash = @{}

    foreach ($key in $bySize.Keys) {
        $group = $bySize[$key]
        if ($group.Count -lt 2) { continue }

        foreach ($f in $group) {
            try {
                $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
            } catch {
                # A hash that threw is New-Unreadable, never a silent skip --
                # aeu binding rule 1, third clause.
                $unreadable.Add((New-Unreadable -path $f.FullName -reason 'hash-failed' -detail $_.Exception.Message))
                continue
            }

            if (-not $byHash.ContainsKey($hash)) { $byHash[$hash] = [System.Collections.Generic.List[object]]::new() }
            $byHash[$hash].Add(@{ path = $f.FullName; bytes = [long]$f.Length; lastWriteUtc = $f.LastWriteTimeUtc })
        }
    }

    # ---- pass 3: a hash shared by 2+ files is a real content duplicate ----
    foreach ($hash in $byHash.Keys) {
        $members = @($byHash[$hash])
        if ($members.Count -lt 2) { continue }

        # Survivor selection -- see the header comment at the top of this file
        # for why this order (oldest mtime, then shallowest path, then ordinal
        # compare) and not a folder-name pattern match. Get-DedupSurvivorChoice
        # is declared `function script:` above so it survives being loaded
        # through Import-Finders and is still callable from here.
        $choice    = Get-DedupSurvivorChoice -members $members
        $survivor  = $choice.survivor
        $copiesRaw = @($choice.copies)

        # Consult Test-NeverTouchPath before reporting ANY path (survivor
        # included, for transparency) -- and never let a never-touch path
        # land in the set a later removal step could act on. A never-touch
        # path is always safe to keep; it is only unsafe to remove, so it is
        # annotated `removalEligible = $false` rather than dropped from the
        # report, matching finders/_never-touch.ps1's own rule: refuse by
        # name with a reason, never by silent omission.
        $survivorGuard = Test-NeverTouchPath $survivor.path

        $reclaimable = 0L
        $copies = @()
        foreach ($c in $copiesRaw) {
            $guard = Test-NeverTouchPath $c.path
            $eligible = ($null -eq $guard)
            if ($eligible) { $reclaimable += [long]$c.bytes }
            $copies += @{
                path             = $c.path
                bytes            = [long]$c.bytes
                lastWriteUtc     = $c.lastWriteUtc.ToString('o')
                neverTouch       = (-not $eligible)
                neverTouchReason = $(if ($guard) { $guard.reason } else { '' })
                removalEligible  = $eligible
            }
        }

        $sizeText  = Format-ByteSize -bytes ([long]$survivor.bytes)
        $countText = "$($members.Count) copies"

        $evidence = "SHA-256 $hash matches on $($members.Count) files ($sizeText each). " +
                    "Survivor chosen by oldest modification time, then shallowest path: $($survivor.path). " +
                    "$($copies.Count) other cop$(if ($copies.Count -eq 1) { 'y' } else { 'ies' }) share this content."
        # @() wraps the pipeline RESULT, not just $copies -- Where-Object
        # collapses a single match to a bare hashtable, whose own .Count would
        # then be its KEY count, not a match count. Both call sites here need
        # the wrap; only the second one had it originally.
        $neverTouchCopyCount = @($copies | Where-Object { $_.neverTouch }).Count
        if ($neverTouchCopyCount -gt 0) {
            $evidence += " $neverTouchCopyCount of those are inside a never-touch tree and are not proposed for removal."
        }

        $findings.Add((New-Finding `
            -id "duplicate-content|$hash" `
            -title "$countText of one file are byte-identical ($sizeText)" `
            -path $survivor.path `
            -bytes $reclaimable `
            -evidence $evidence `
            -rebuildCost 'None -- an identical copy already exists at the survivor path; nothing is lost by removing the others.' `
            -costClass 'cheap' `
            -action 'audit' `
            -detail @{
                hash         = $hash
                sizeBytes    = [long]$survivor.bytes
                reclaimable  = $reclaimable
                survivor     = @{
                    path             = $survivor.path
                    bytes            = [long]$survivor.bytes
                    lastWriteUtc     = $survivor.lastWriteUtc.ToString('o')
                    neverTouch       = ($null -ne $survivorGuard)
                    neverTouchReason = $(if ($survivorGuard) { $survivorGuard.reason } else { '' })
                }
                copies = $copies
            }))
    }

    return New-FinderResult `
        -finder 'duplicate-content' `
        -title 'Files duplicated by content across trees' `
        -findings @($findings) `
        -unreadable @($unreadable) `
        -examined $examined `
        -note 'Grouped by size first and hashed only within groups of more than one file (SHA-256); size and name alone never decide identity. A group with no findings but an unreadable member has not been established as unique.'
}
