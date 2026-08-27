# ==========================================
# THE FINDER REGISTRY AND LOADER (vw4, mechanism half)
# ==========================================
# HANDOFF-2026-08-21 section 2: "a new artifact type is a DATA CHANGE rather
# than another few hundred lines in a file that is already 41% of the
# codebase." scanner.ps1 is 7,870 lines and that number is the reason the
# zero-result case had no type to begin with (5p5).
#
# This is the smaller, structural half of that: a finder is a FILE. It lives in
# finders/*.finder.ps1, it registers itself, and scanner.ps1 never learns its
# name. Adding the twenty-first finder touches no existing file.
#
# The larger half of vw4 - whether the rule BODIES can also be data, expressed
# in a Vanish dialect alongside the CleanerML reader (7sl) - is deliberately
# still open. CleanerML's vocabulary covers file deletion by glob and walk; it
# has no way to say "the package.json that regenerates this is visible", "this
# variable is unset", or "this repo cannot be read". That decision wants real
# examples in hand, which is what the finders written against this loader will
# produce. Registering handlers as script blocks now does not foreclose it: a
# data-driven rule file becomes one more registration, from a generic reader.

# NOTE ON Set-StrictMode: deliberately NOT set here. These files are
# dot-sourced into scanner.ps1, and dot-sourcing runs in the CALLERS scope -
# so a Set-StrictMode line would silently impose strict semantics on 7,870
# lines that were never written for it, and the failures would surface as
# unrelated features breaking in a VM. Get-FieldValue exists to make
# missing-member access explicit instead.

$script:FinderRegistry = [System.Collections.Generic.List[object]]::new()

# Directory -> load report, so a second Import-Finders in the same process is
# a no-op rather than a pile of duplicate-name errors. See Import-Finders.
$script:FinderImportCache = @{}

# Which module of the specification a finder belongs to. The order matters and
# is the handoff's, not alphabetical: RESCUE BEFORE RECLAIM. "A tool that
# cannot yet delete anything but can tell you what a delete would destroy is
# already the most useful thing on the machine."
$script:FinderModules = @('rescue', 'hygiene', 'reclaim')


function Register-Finder {
    <#
    .SYNOPSIS
        Declare a finder. Called by a finders/*.finder.ps1 file at load time.

    .PARAMETER handler
        A script block taking one parameter (the params object from the caller)
        and returning the output of New-FinderResult. It must not delete
        anything: finders find. Deciding is a separate step precisely so that
        the zero-result case has somewhere to be a named state instead of an
        empty success.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$name,
        [Parameter(Mandatory = $true)][string]$title,
        [Parameter(Mandatory = $true)][ValidateSet('rescue', 'hygiene', 'reclaim')][string]$module,
        [Parameter(Mandatory = $true)][scriptblock]$handler,
        [string]$description = '',
        [bool]$auditOnly = $true,
        [bool]$needsElevation = $false
    )

    $existing = @($script:FinderRegistry | Where-Object { $_.name -eq $name })
    if ($existing.Count -gt 0) {
        # Two files claiming one name would mean the second silently wins and
        # the first never runs - a finder that reports nothing because it was
        # never loaded is indistinguishable from a clean machine, which is the
        # aeu defect arriving through the front door.
        throw "Register-Finder: '$name' is already registered. Finder names are the identity the report and the oplog use; a duplicate would silently replace a check rather than add one."
    }

    $script:FinderRegistry.Add(@{
        name           = $name
        title          = $title
        module         = $module
        description    = $description
        auditOnly      = $auditOnly
        needsElevation = $needsElevation
        handler        = $handler
    })
}


function Import-Finders {
    <#
    .SYNOPSIS
        Dot-source every finder file beside this one, once.

    .DESCRIPTION
        Returns the load report rather than writing anything, because a finder
        file that failed to parse is itself a "could not look" - the check did
        not run, and a run that quietly contains nineteen of twenty checks must
        say so. Callers surface loadErrors; they are never dropped.

        ONCE, per directory, unless -Force. Register-Finder throws on a
        duplicate name deliberately - two files claiming one check must not
        silently become one - but a SECOND import of the SAME file is not that
        situation, and without this cache the engine's own second call (probe
        then scan, in one process) would turn every correctly-registered finder
        into a load error. The engine normally runs one action per process, so
        this would have shown up first in a test and been read as a test bug.
    #>
    param(
        [string]$directory = '',
        [switch]$Force
    )

    if ([string]::IsNullOrWhiteSpace($directory)) {
        $directory = $PSScriptRoot
    }

    if (-not $Force -and $script:FinderImportCache.Contains($directory)) {
        return $script:FinderImportCache[$directory]
    }

    $loaded = [System.Collections.Generic.List[string]]::new()
    $errors = [System.Collections.Generic.List[object]]::new()

    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        $missing = @{ loaded = @(); loadErrors = @(@{ path = $directory; error = 'finder directory not found' }) }
        $script:FinderImportCache[$directory] = $missing
        return $missing
    }

    foreach ($file in @(Get-ChildItem -LiteralPath $directory -Filter '*.finder.ps1' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        try {
            . $file.FullName
            $loaded.Add($file.Name)
        } catch {
            $errors.Add(@{ path = $file.FullName; error = $_.Exception.Message })
        }
    }

    $report = @{ loaded = @($loaded); loadErrors = @($errors) }
    $script:FinderImportCache[$directory] = $report
    return $report
}


function Get-RegisteredFinders {
    param([string]$module = '')

    $all = @($script:FinderRegistry)
    if (-not [string]::IsNullOrWhiteSpace($module)) {
        $all = @($all | Where-Object { $_.module -eq $module })
    }

    # Registry order within a module, module order per $script:FinderModules.
    return @($all | Sort-Object -Property @{ Expression = { [array]::IndexOf($script:FinderModules, $_.module) } })
}


function Invoke-HygieneScan {
    <#
    .SYNOPSIS
        Run the registered finders and return one envelope of typed results.

    .DESCRIPTION
        A finder that THROWS is not a finder that found nothing. It is converted
        into a 'could-not-look' result carrying the exception, so a crashed
        check can never be read as a clean one - the same rule as aeu, applied
        to the failure mode aeu did not anticipate.
    #>
    param([object]$p = $null)

    # finderDir is a test seam, not a feature. A suite that could only run the
    # finders that happen to be shipped would be testing the machine rather
    # than the loader, and the loader's interesting cases - a file that will
    # not parse, a handler that throws - cannot be constructed in the real
    # directory without breaking the product.
    $load = Import-Finders -directory ([string](Get-FieldValue -record $p -name 'finderDir' -default ''))

    $wanted = [string](Get-FieldValue -record $p -name 'module' -default '')
    $only   = @(Get-FieldValue -record $p -name 'finders' -default @())

    $selected = @(Get-RegisteredFinders -module $wanted)
    if (@($only).Count -gt 0) {
        $selected = @($selected | Where-Object { @($only) -contains $_.name })
    }

    $results = [System.Collections.Generic.List[object]]::new()

    foreach ($finder in $selected) {
        try {
            $r = & $finder.handler $p
            if ($null -eq $r) {
                throw "the finder returned nothing at all, which is not one of the three states"
            }
            $r['module'] = $finder.module
            $results.Add($r)
        } catch {
            $results.Add((New-FinderResult `
                -finder $finder.name `
                -title $finder.title `
                -findings @() `
                -unreadable @((New-Unreadable -path '(finder)' -reason 'finder-failed' -detail $_.Exception.Message)) `
                -examined 0 `
                -note "This check did not complete, so it has established nothing about the machine."))
            $results[$results.Count - 1]['module'] = $finder.module
        }
    }

    return @{
        success       = $true
        results       = @($results)
        loaded        = @($load.loaded)
        loadErrors    = @($load.loadErrors)
        registered    = @($selected | ForEach-Object { $_.name })
        finderCount   = $selected.Count
    }
}
