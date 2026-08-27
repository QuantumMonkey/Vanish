# ==========================================
# PATH HYGIENE (bd vanish-uninstaller-pko) -- cross-scope duplicates, broken
# entries, entries under Downloads
# ==========================================
# Module 2 HYGIENE, HANDOFF-2026-08-21 section 3: "Found: 27 user entries, 12
# VERBATIM DUPLICATES of the machine PATH, 2 tools running from Downloads.
# After cleanup: 14 entries." Nothing here writes to PATH -- every finding is
# action = 'audit' (Module 2's rule, restated in bd pko: "nothing in this
# module proposes a removal").
#
# HOW THIS DIFFERS FROM Find-DeadPathEntries / Set-PathEntries (REQ-15,
# scanner.ps1): REQ-15 asks ONE question per entry -- does the directory this
# entry points at exist? -- across both PATH scopes, and Set-PathEntries is
# the paired writer that can actually remove what REQ-15 finds. This finder
# asks THREE different questions (cross-scope duplication, brokenness, and
# location under Downloads), never writes anything (auditOnly, action is
# always 'audit'), and treats "duplicates the machine PATH verbatim" as its
# own kind of wrongness rather than folding it into "dead": a duplicate
# entry's directory usually DOES exist (that is the whole problem -- the same
# real directory is now searched twice), so REQ-15's existence check would
# never catch it. The two checks are complementary, not overlapping: REQ-15
# already owns the removal path for the "does not exist" case, so this finder
# still reports brokenness (Module 2's table asks for it, and this is the one
# place all five hygiene checks are visible together) but leaves the actual
# PATH edit to Set-PathEntries rather than re-implementing a second writer.
#
# THE THREE CHECKS, per USER-scope entry (the scope the real cleanup edited --
# "After: 14 entries" describes the user PATH shrinking from 27, not the
# machine PATH, which an unelevated Vanish session cannot write to anyway):
#   1. Cross-scope duplicate: the entry, compared VERBATIM (trimmed, not
#      expanded, case-insensitive -- Windows path comparison) against every
#      machine-scope entry. A verbatim string match is deliberate: two
#      entries that only RESOLVE to the same directory (one uses a variable,
#      the other a literal path) are a different, weaker finding this check
#      does not make -- "verbatim duplicate" is specifically about a PATH
#      that got longer for no reason, which only literal duplication causes.
#   2. Broken: the expanded path does not exist. Reported here too (not only
#      by REQ-15) so Module 2's report is complete on its own; this finder
#      never competes with Set-PathEntries for the write, since it is
#      audit-only.
#   3. Under Downloads: the expanded path contains a \Downloads\ segment.
#      Reported regardless of whether the directory exists -- a tool running
#      from Downloads is wrong (a browser dumped it there, or an installer
#      pointed PATH at an extraction folder) even when the directory is very
#      much present, which is why this is a separate check from "broken", not
#      a special case of it.
#
# Machine-scope entries are read only as the comparison set for check 1 in
# this release; they are not themselves walked for checks 2/3 -- the observed
# finding and the "After: 14" number are both about the user scope, and an
# unelevated Vanish session cannot act on the machine scope regardless.
#
# TESTABILITY: -pathEntriesUser / -pathEntriesMachine accept the ALREADY-SPLIT
# entry lists, exactly like Find-DeadPathEntries's own two registry scopes,
# so test/finder-hygiene-verify.ps1 never has to touch HKCU or HKLM to prove
# this -- see the binding rule: never write to the real PATH. When neither
# override is given, the raw (unexpanded) PATH value is read directly from
# the registry, exactly as REQ-15 does, so %VAR%-form entries are compared
# and reported the way the user actually wrote them.
#
# aeu: a registry hive that could not be opened for reading is New-Unreadable,
# never an empty PATH read as "0 entries, nothing to report" -- an empty PATH
# value and an unreadable Environment key would otherwise look identical.

# NOTE ON Set-StrictMode: deliberately NOT set here, matching every other file
# under finders/ -- dot-sourced into scanner.ps1's own caller scope; see
# finders/_contract.ps1's identical note for why.

# Pko prefix on every script-scoped name: finder files share one dot-sourced
# scope (finders/_loader.ps1), and several agents are writing sibling finders
# in this same tree right now -- a generic helper name here would collide
# with an equally-tempting name in one of theirs.
#
# Every helper function below is declared `function script:Name`, not plain
# `function Name`. Import-Finders dot-sources each finder file from INSIDE
# its own function body (finders/_loader.ps1), and dot-sourcing runs in the
# caller's scope -- which is that function's scope, torn down the moment it
# returns. A plain function would therefore exist only during import and be
# gone before the handler below ever runs: Register-Finder still succeeds
# (it writes to $script:FinderRegistry), so the finder loads and looks
# healthy in finder-probe, then throws the first time the handler calls the
# vanished helper -- which Invoke-HygieneScan converts into a could-not-look
# result two layers away from the actual cause. `script:Name` pins the
# function to the finder directory's own script scope, which survives.

function script:Get-PkoPathRawScope {
    <#
    .SYNOPSIS
        Read ONE PATH scope's raw, unexpanded value directly from the
        registry, distinguishing "could not open the key" from "the key has
        no Path value" -- the second is a legitimate empty PATH, the first is
        aeu's third state and must never be read as the second.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$hive,
        [Parameter(Mandatory = $true)][string]$subKey
    )
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::Registry64)
        try {
            $key = $base.OpenSubKey($subKey)
            if (-not $key) { return @{ ok = $true; raw = $null } }
            try {
                $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                return @{ ok = $true; raw = $raw }
            } finally { $key.Close() }
        } finally { $base.Close() }
    } catch {
        return @{ ok = $false; raw = $null; error = $_.Exception.Message }
    }
}

function script:ConvertTo-PkoPathEntryList {
    param([string]$raw)
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    return @([string]$raw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

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
        (exactly what a test asserting "zero entries" would pass) was
        therefore silently treated as "no override given" and fell through
        to reading the real machine -- caught in this file's own
        verification when `pathEntriesUser: []` produced the real PATH's
        entries instead of the intended zero. Testing presence on the RECORD
        (Contains / PSObject.Properties, never on the extracted value)
        sidesteps the operator entirely.
    #>
    param([object]$record, [Parameter(Mandatory = $true)][string]$name)
    if ($null -eq $record) { return $false }
    if ($record -is [System.Collections.IDictionary]) { return $record.Contains($name) }
    return ($null -ne $record.PSObject.Properties[$name])
}

Register-Finder -name 'path-hygiene' `
    -title 'PATH hygiene: cross-scope duplicates, broken entries, Downloads' `
    -module 'hygiene' `
    -auditOnly $true `
    -description 'User PATH entries checked against the machine PATH (verbatim duplicates), against the filesystem (broken -- directory missing), and against the Downloads folder. Extends REQ-15 (Find-DeadPathEntries / Set-PathEntries), does not replace it -- see file header. Audit only; see bd vanish-uninstaller-pko.' `
    -handler {
        param($p)

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()

        $userProvided    = Test-PkoFieldPresent -record $p -name 'pathEntriesUser'
        $machineProvided = Test-PkoFieldPresent -record $p -name 'pathEntriesMachine'
        $userOverride    = Get-FieldValue -record $p -name 'pathEntriesUser' -default @()
        $machineOverride = Get-FieldValue -record $p -name 'pathEntriesMachine' -default @()

        if ($userProvided) {
            $userEntries = @($userOverride | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        } else {
            $rawResult = Get-PkoPathRawScope -hive 'CurrentUser' -subKey 'Environment'
            if (-not $rawResult.ok) {
                $unreadable.Add((New-Unreadable -path 'HKCU:\Environment' -reason 'registry-read-failed' -detail $rawResult.error))
                $userEntries = @()
            } else {
                $userEntries = ConvertTo-PkoPathEntryList $rawResult.raw
            }
        }

        if ($machineProvided) {
            $machineEntries = @($machineOverride | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        } else {
            $rawResult = Get-PkoPathRawScope -hive 'LocalMachine' -subKey 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
            if (-not $rawResult.ok) {
                $unreadable.Add((New-Unreadable -path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -reason 'registry-read-failed' -detail $rawResult.error))
                $machineEntries = @()
            } else {
                $machineEntries = ConvertTo-PkoPathEntryList $rawResult.raw
            }
        }

        $machineSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($m in $machineEntries) { [void]$machineSet.Add($m) }

        foreach ($entry in $userEntries) {
            $guard = Test-NeverTouchPath -path $entry
            if ($guard) {
                $unreadable.Add((New-Unreadable -path $entry -reason 'never-touch' -detail $guard.reason))
                continue
            }

            if ($machineSet.Contains($entry)) {
                $dupParams = @{
                    id        = "path-hygiene|cross-scope-dup|$entry"
                    title     = "User PATH duplicates the machine PATH verbatim: $entry"
                    path      = $entry
                    bytes     = 0
                    evidence  = "User PATH contains '$entry', which is also present verbatim in the machine PATH. Every process already inherits it from the machine scope, so the user-scope copy only makes PATH longer to search."
                    costClass = 'cheap'
                    action    = 'audit'
                }
                $findings.Add((New-Finding @dupParams))
            }

            $expanded = [System.Environment]::ExpandEnvironmentVariables($entry)
            $checkFailed = $false
            $exists = $true
            try {
                $exists = Test-Path -LiteralPath $expanded -ErrorAction Stop
            } catch {
                $unreadable.Add((New-Unreadable -path $expanded -reason 'path-check-failed' -detail $_.Exception.Message))
                $checkFailed = $true
            }

            if (-not $checkFailed -and -not $exists) {
                $brokenParams = @{
                    id        = "path-hygiene|broken|User|$entry"
                    title     = "User PATH entry does not exist: $entry"
                    path      = $expanded
                    bytes     = 0
                    evidence  = "'$expanded' is on the user PATH but the directory does not exist. (Find-DeadPathEntries / Set-PathEntries in scanner.ps1, REQ-15, already offers to remove this specific kind of entry -- this check reports it as part of the combined hygiene picture and does not duplicate that removal path.)"
                    costClass = 'cheap'
                    action    = 'audit'
                }
                $findings.Add((New-Finding @brokenParams))
            }

            if (-not $checkFailed -and $expanded -match '(?i)\\Downloads(\\|$)') {
                $dlParams = @{
                    id        = "path-hygiene|downloads|User|$entry"
                    title     = "User PATH entry runs from Downloads: $entry"
                    path      = $expanded
                    bytes     = 0
                    evidence  = "'$expanded' is on the user PATH and sits under a Downloads folder -- almost always a browser download or a manual extraction that was never moved to a real install location, not a deliberate PATH target."
                    costClass = 'cheap'
                    action    = 'audit'
                }
                $findings.Add((New-Finding @dlParams))
            }
        }

        $note = "$($userEntries.Count) user PATH entries checked against $($machineEntries.Count) machine PATH entries. Machine-scope entries are the comparison set for cross-scope duplicates only; they are not themselves walked for broken/Downloads entries in this release."

        return New-FinderResult -finder 'path-hygiene' `
            -title 'PATH hygiene: cross-scope duplicates, broken entries, Downloads' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined ($userEntries.Count + $machineEntries.Count) `
            -note $note
    }
