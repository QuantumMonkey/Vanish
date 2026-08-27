# ==========================================
# ORPHANED ProfileList REGISTRY ENTRIES (bd vanish-uninstaller-pko)
# ==========================================
# Module 2 HYGIENE check 4 of 5, HANDOFF-2026-08-21 section 3: "Found: 12" --
# profile SIDs under HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\
# ProfileList whose ProfileImagePath no longer exists on disk. Each such
# entry is a leftover from a deleted or renamed user profile; Windows never
# prunes them itself. Free to remove once confirmed -- but this finder does
# not remove anything: audit only, per Module 2's rule (bd pko: "nothing in
# this module proposes a removal").
#
# aeu, applied here specifically: this key is exactly the kind of registry
# read that failed silently during the real cleanup -- the repo-health
# finder's "10 repos returned dubious ownership from a PREVIOUS PROFILE SID"
# is the direct downstream symptom of the orphaned profiles this finder
# reports. A hive this finder cannot open, or a subkey it cannot read a value
# from, is New-Unreadable -- never silently skipped and never folded into "0
# orphaned profiles found".
#
# TESTABILITY, two independent overrides:
#   -profiles         a fully synthetic list of @{ sid; profileImagePath }
#                      pairs -- bypasses the registry entirely.
#   -profileListKey   a real registry key PATH to read instead of the real
#                      HKLM ProfileList key -- lets a test build a fixture key
#                      under HKCU (writable without elevation, and never the
#                      real HKLM) and exercise the ACTUAL registry-reading
#                      code path end to end, not a stand-in for it.
# Neither override is required; with neither given, the real
# HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList is read.

# NOTE ON Set-StrictMode: deliberately NOT set here -- see finders/_contract.ps1.
# Pko prefix on every script-scoped name -- see path-hygiene.finder.ps1's
# header. Same file's header also explains why every helper function is
# `function script:Name`, not plain `function Name`: a plain function
# defined here would not survive past Import-Finders dot-sourcing this file
# from inside its own function body, and would be gone before this file's
# own handler ever runs.

function script:Test-PkoFieldPresent {
    <#
    .SYNOPSIS
        Was $name actually present on $record, distinct from "present but
        empty" and from "absent entirely"?

    .DESCRIPTION
        `if ($null -ne $override)` looks like the obvious presence check and
        is WRONG the moment $override is array-typed: PowerShell's
        comparison operators filter element-wise when the left operand is an
        array, so `$null -ne @()` returns `@()` (zero elements), and `if
        (@())` is FALSE. An override supplied as an explicit empty array
        (exactly what a test asserting "zero profiles" would pass) was
        therefore silently treated as "no override given" and fell through
        to reading the real ProfileList key -- caught in
        path-hygiene.finder.ps1's own verification, which hits the identical
        shape. Testing presence on the RECORD (Contains / PSObject.Properties,
        never on the extracted value) sidesteps the operator entirely.
    #>
    param([object]$record, [Parameter(Mandatory = $true)][string]$name)
    if ($null -eq $record) { return $false }
    if ($record -is [System.Collections.IDictionary]) { return $record.Contains($name) }
    return ($null -ne $record.PSObject.Properties[$name])
}

function script:Test-PkoOrphanedProfile {
    <#
    .SYNOPSIS
        Evaluate one ProfileList entry (SID + ProfileImagePath) and add a
        finding or an unreadable entry to the lists the caller supplies.

    .DESCRIPTION
        Takes the finder's own $findings / $unreadable lists as parameters
        (both reference types) rather than returning a result to merge, so
        the two call sites in the handler below (the -profiles override and
        the real-registry walk) share exactly one evaluation path -- a
        second, slightly-different copy of "does this path exist" is how a
        fixture test and the real scan quietly drift apart.

        [AllowEmptyCollection()] is required, not decoration: PowerShell
        refuses to bind a Mandatory collection-typed parameter to an empty
        collection ("Cannot bind argument to parameter 'findings' because it
        is an empty collection"), and $findings/$unreadable ARE empty on the
        very first call of a clean run -- caught by this file's own smoke
        test, which hit exactly that exception on the first profile checked.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$sid,
        [string]$imgPath,
        [Parameter(Mandatory = $true)][string]$sourceLabel,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$findings,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$unreadable
    )

    if ([string]::IsNullOrWhiteSpace($imgPath)) {
        $unreadable.Add((New-Unreadable -path "$sourceLabel\$sid" -reason 'missing-profileimagepath' -detail 'This SID has no ProfileImagePath value at all, so orphan status cannot be determined.'))
        return
    }

    $expanded = [System.Environment]::ExpandEnvironmentVariables($imgPath)

    $guard = Test-NeverTouchPath -path $expanded
    if ($guard) {
        $unreadable.Add((New-Unreadable -path $expanded -reason 'never-touch' -detail $guard.reason))
        return
    }

    $exists = $true
    try {
        $exists = Test-Path -LiteralPath $expanded -ErrorAction Stop
    } catch {
        $unreadable.Add((New-Unreadable -path $expanded -reason 'path-check-failed' -detail $_.Exception.Message))
        return
    }

    if (-not $exists) {
        $orphanParams = @{
            id        = "profile-list|$sid"
            title     = "Orphaned ProfileList entry: $sid"
            path      = $expanded
            bytes     = 0
            evidence  = "ProfileList entry $sid has ProfileImagePath '$expanded', which does not exist on disk. Windows does not prune ProfileList entries when a profile folder is deleted or renamed, so this is a leftover, not a live account."
            costClass = 'cheap'
            action    = 'audit'
        }
        $findings.Add((New-Finding @orphanParams))
    }
}

Register-Finder -name 'profile-list' `
    -title 'Orphaned ProfileList registry entries' `
    -module 'hygiene' `
    -auditOnly $true `
    -description 'Profile SIDs under HKLM ProfileList whose ProfileImagePath no longer exists on disk -- a leftover from a deleted or renamed user profile that Windows never prunes on its own. Audit only; see bd vanish-uninstaller-pko.' `
    -handler {
        param($p)

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()
        $examined   = 0

        $profilesProvided = Test-PkoFieldPresent -record $p -name 'profiles'
        $profilesOverride = Get-FieldValue -record $p -name 'profiles' -default @()

        if ($profilesProvided) {
            foreach ($entry in @($profilesOverride)) {
                $examined++
                $sid     = [string](Get-FieldValue -record $entry -name 'sid' -default '(unknown sid)')
                $imgPath = [string](Get-FieldValue -record $entry -name 'profileImagePath' -default '')
                Test-PkoOrphanedProfile -sid $sid -imgPath $imgPath -sourceLabel 'profiles-override' -findings $findings -unreadable $unreadable
            }
        } else {
            $profileListKey = [string](Get-FieldValue -record $p -name 'profileListKey' -default 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList')

            $subKeys = $null
            try {
                $subKeys = @(Get-ChildItem -LiteralPath $profileListKey -ErrorAction Stop)
            } catch {
                $unreadable.Add((New-Unreadable -path $profileListKey -reason 'registry-read-failed' -detail $_.Exception.Message))
            }

            foreach ($sidKey in @($subKeys)) {
                $examined++
                $sid = $sidKey.PSChildName
                $imgPath = $null
                try {
                    $imgPath = (Get-ItemProperty -LiteralPath $sidKey.PSPath -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
                } catch {
                    $unreadable.Add((New-Unreadable -path "$profileListKey\$sid" -reason 'registry-read-failed' -detail $_.Exception.Message))
                    continue
                }
                Test-PkoOrphanedProfile -sid $sid -imgPath $imgPath -sourceLabel $profileListKey -findings $findings -unreadable $unreadable
            }
        }

        $entryWord = if ($examined -eq 1) { 'entry' } else { 'entries' }
        $note = "$examined ProfileList $entryWord checked against the filesystem."

        return New-FinderResult -finder 'profile-list' `
            -title 'Orphaned ProfileList registry entries' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $examined `
            -note $note
    }
