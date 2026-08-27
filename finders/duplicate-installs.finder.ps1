# ==========================================
# DUPLICATE APP INSTALLS, BOTH ON PATH (bd vanish-uninstaller-pko)
# ==========================================
# Module 2 HYGIENE check 5 of 5, HANDOFF-2026-08-21 section 3: "Found: 2.4 GB
# -- and ONE PAIR WAS INTENTIONAL." Two installs share a display name and are
# both reachable from PATH; that LOOKS like duplication, and bd 4rn's whole
# point is that it is not safe to conclude that from shape alone -- two
# Antigravity installs (an agentic IDE and a VS Code fork, one needed to
# install BMAD) were exactly this shape and were both wanted.
#
# BINDING: every pair this finder finds is routed through
# Test-SameNameInstallsRedundant (finders/_never-touch.ps1, bd 4rn), which by
# design has NO code path that returns "redundant" -- its only verdict is
# 'needs-confirmation'. This finder therefore NEVER labels a pair wasteful;
# it reports that a pair exists, both are reachable from PATH, how large they
# are together, and the evidence a human needs to decide. action is 'audit',
# the same as every other check in this module, and costClass is 'unknown'
# (not 'cheap') on purpose: unlike the other four checks in this module,
# whether removing one of these is actually free depends on a fact -- does
# the operator use both -- that Test-SameNameInstallsRedundant's own doc
# comment says is "not on the disk". 'unknown' sorts LAST in lib/findings.js,
# which is exactly right: this is the one Module 2 finding that must never
# float to the top of a list as if it were as safe as the other four.
#
# bytes IS non-zero here (Module 2's other checks mostly report bytes = 0 --
# see redirect-variables.finder.ps1's header for the one other exception)
# because 2.4 GB is a real, measured number worth showing. It is the ACTION
# on that number (never "redundant", always "needs-confirmation") that this
# finder is careful about, not the number itself.
#
# "BOTH ON PATH": an app counts as on PATH if its InstallLocation is one of
# the PATH directories, or a PATH directory sits inside it (the common shape
# is an app reaching PATH via its own \bin subfolder, not its install root).
# A pair only becomes a finding when AT LEAST TWO installs sharing a name are
# each independently reachable from PATH -- an installed-but-not-on-PATH
# duplicate is a different, much weaker signal this finder does not raise.
#
# TESTABILITY: -installedApps overrides the app inventory (skips
# Get-InstalledApps and its registry walk entirely); -pathDirs overrides the
# PATH directory list (skips the registry read of both PATH scopes). Neither
# override touches the real Uninstall hives or the real PATH when supplied.

# NOTE ON Set-StrictMode: deliberately NOT set here -- see finders/_contract.ps1.
# Pko prefix on every script-scoped name -- see path-hygiene.finder.ps1's
# header. Same file's header also explains why every helper function is
# `function script:Name`, not plain `function Name`: a plain function
# defined here would not survive past Import-Finders dot-sourcing this file
# from inside its own function body, and would be gone before this file's
# own handler ever runs.

function script:Get-PkoInstallPathDirs {
    <#
    .SYNOPSIS
        Every directory named on either PATH scope, expanded, deduped.
        Read-only; used only to test "is this install location on PATH".
    #>
    $dirs = [System.Collections.Generic.List[string]]::new()
    $scopes = @(
        @{ Hive = 'CurrentUser';  Key = 'Environment' },
        @{ Hive = 'LocalMachine'; Key = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' }
    )
    foreach ($scope in $scopes) {
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::($scope.Hive), [Microsoft.Win32.RegistryView]::Registry64)
            try {
                $key = $base.OpenSubKey($scope.Key)
                if ($key) {
                    try {
                        $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        if (-not [string]::IsNullOrWhiteSpace($raw)) {
                            foreach ($e in ([string]$raw -split ';')) {
                                $t = $e.Trim()
                                if ($t) {
                                    $expanded = [System.Environment]::ExpandEnvironmentVariables($t).TrimEnd('\')
                                    if ($expanded) { $dirs.Add($expanded) }
                                }
                            }
                        }
                    } finally { $key.Close() }
                }
            } finally { $base.Close() }
        } catch { }
    }
    return @($dirs | Select-Object -Unique)
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
        (@())` is FALSE. An override supplied as an explicit empty array was
        therefore silently treated as "no override given" and fell through
        to reading the real Uninstall registry / real PATH -- caught in
        path-hygiene.finder.ps1's own verification, which hits the identical
        shape. Testing presence on the RECORD (Contains / PSObject.Properties,
        never on the extracted value) sidesteps the operator entirely.
    #>
    param([object]$record, [Parameter(Mandatory = $true)][string]$name)
    if ($null -eq $record) { return $false }
    if ($record -is [System.Collections.IDictionary]) { return $record.Contains($name) }
    return ($null -ne $record.PSObject.Properties[$name])
}

function script:Test-PkoInstallOnPath {
    param(
        [string]$installLocation,
        [string[]]$pathDirsLower
    )
    if ([string]::IsNullOrWhiteSpace($installLocation)) { return $false }
    $loc = $installLocation.TrimEnd('\').ToLowerInvariant()
    foreach ($d in $pathDirsLower) {
        if ($d -eq $loc -or $d.StartsWith("$loc\")) { return $true }
    }
    return $false
}

Register-Finder -name 'duplicate-installs' `
    -title 'Duplicate app installs, both on PATH' `
    -module 'hygiene' `
    -auditOnly $true `
    -description 'Two or more installed programs sharing a display name, each independently reachable from PATH. Routed through Test-SameNameInstallsRedundant (bd 4rn), which never returns redundant -- only needs-confirmation. Audit only; see bd vanish-uninstaller-pko.' `
    -handler {
        param($p)

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()

        $appsProvided = Test-PkoFieldPresent -record $p -name 'installedApps'
        $pathProvided = Test-PkoFieldPresent -record $p -name 'pathDirs'
        $appsOverride = Get-FieldValue -record $p -name 'installedApps' -default @()
        $pathOverride = Get-FieldValue -record $p -name 'pathDirs' -default @()

        $apps = @()
        if ($appsProvided) {
            $apps = @($appsOverride)
        } else {
            try {
                $apps = @(Get-InstalledApps)
            } catch {
                $unreadable.Add((New-Unreadable -path '(installed-apps registry)' -reason 'install-inventory-failed' -detail $_.Exception.Message))
                $apps = @()
            }
        }

        $pathDirs = if ($pathProvided) {
            @($pathOverride | ForEach-Object { ([string]$_).TrimEnd('\') } | Where-Object { $_ })
        } else {
            Get-PkoInstallPathDirs
        }
        $pathDirsLower = @($pathDirs | ForEach-Object { $_.ToLowerInvariant() })

        $examined = @($apps).Count

        $named = @($apps | Where-Object { -not [string]::IsNullOrWhiteSpace([string](Get-FieldValue -record $_ -name 'name' -default '')) })
        $groups = @($named | Group-Object { ([string](Get-FieldValue -record $_ -name 'name' -default '')).Trim().ToLowerInvariant() } | Where-Object { $_.Count -ge 2 })

        foreach ($g in $groups) {
            $onPath = @($g.Group | Where-Object {
                Test-PkoInstallOnPath -installLocation ([string](Get-FieldValue -record $_ -name 'installLocation' -default '')) -pathDirsLower $pathDirsLower
            })
            if ($onPath.Count -lt 2) { continue }

            $locations = @($onPath | ForEach-Object { [string](Get-FieldValue -record $_ -name 'installLocation' -default '(unknown location)') })

            $blocked = $false
            foreach ($loc in $locations) {
                $guard = Test-NeverTouchPath -path $loc
                if ($guard) {
                    $unreadable.Add((New-Unreadable -path $loc -reason 'never-touch' -detail $guard.reason))
                    $blocked = $true
                }
            }
            if ($blocked) { continue }

            $a = $onPath[0]
            $b = $onPath[1]
            $verdict = Test-SameNameInstallsRedundant -a $a -b $b

            $bytes = 0L
            foreach ($x in $onPath) {
                $bx = Get-FieldValue -record $x -name 'sizeBytes' -default 0
                if ($null -ne $bx) { $bytes += [long]$bx }
            }

            $displayName = [string](Get-FieldValue -record $a -name 'name' -default $g.Name)

            $dupParams = @{
                id        = "duplicate-installs|$($g.Name)"
                title     = "$($onPath.Count) installs named '$displayName' are all on PATH"
                path      = ([string](Get-FieldValue -record $a -name 'installLocation' -default ''))
                bytes     = $bytes
                evidence  = "$($verdict.prompt) Locations: $($locations -join ' | '). " + (($verdict.evidence) -join '; ')
                costClass = 'unknown'
                action    = 'audit'
                detail    = @{ verdict = $verdict.verdict; evidence = @($verdict.evidence); prompt = $verdict.prompt; locations = $locations; totalBytes = $bytes }
            }
            $findings.Add((New-Finding @dupParams))
        }

        $dirWord = if ($pathDirs.Count -eq 1) { 'directory' } else { 'directories' }
        $note = "$examined installed app(s) considered ($($pathDirs.Count) PATH $dirWord checked). A pair is only reported when BOTH installs sharing a name are independently reachable from PATH; verdict is always needs-confirmation, never redundant (bd 4rn)."

        return New-FinderResult -finder 'duplicate-installs' `
            -title 'Duplicate app installs, both on PATH' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $examined `
            -note $note
    }
