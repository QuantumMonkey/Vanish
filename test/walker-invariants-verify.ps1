# ONE rule, checked against EVERY finder, so the next walker cannot get it
# wrong quietly.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\walker-invariants-verify.ps1
#
# WHY THIS EXISTS. The same defect has now been found four times, each time by
# accident while working on something else:
#
#   3l8   four reclaim checks walked one tree four times
#   lxl   two git checks followed junctions and reported 27 paths for 14 repos
#   e6gn  the consumer search listed one tree once per marker name
#   o1mj  the credential check spent its whole budget inside junction aliases
#         and reported ZERO credentials on a machine holding four
#
# Every one was fixed in its own walker. Nothing stopped the next walker from
# repeating it, and a defect class caught four times by luck is a defect class
# that is still open. This suite closes it at the level of the rule instead of
# the implementation:
#
#   NO FINDER MAY REPORT A FINDING AT A PATH THAT IS NOT THE REAL PATH.
#
# A junction is a second name for a directory. Reporting a finding under one
# is how a repository gets counted four times, how a byte total gets inflated,
# and how a directory budget gets spent on directories that were already
# visited under another name. The rule is checked generically, by resolving
# every reported path against the file system, so a finder written next year
# is covered without anyone remembering to add it here.
#
# It is deliberately NOT a check that walkers skip reparse points. That is one
# implementation of the rule; duplicate-content instead records the junction
# and refuses to descend, which satisfies the rule differently. Asserting the
# OUTCOME leaves both open and does not have to be updated when a walker
# changes technique.

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root 'scanner.ps1'

$script:pass = 0
$script:fail = 0
function Assert-True {
    param([bool]$condition, [string]$label, [string]$detail = '')
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        if ($detail) { Write-Host "        $detail" -ForegroundColor DarkYellow }
        $script:fail++
    }
}
function Write-Skip { param([string]$label) Write-Host "  SKIP  $label" -ForegroundColor Yellow }

Add-Type -Namespace Vanish -Name InvP32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern System.IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess,
    uint dwShareMode, System.IntPtr lpSecurityAttributes, uint dwCreationDisposition,
    uint dwFlagsAndAttributes, System.IntPtr hTemplateFile);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern uint GetFinalPathNameByHandleW(System.IntPtr hFile,
    System.Text.StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(System.IntPtr hObject);
'@
$script:LongPrefix = ([string][char]92) + ([string][char]92) + '?' + ([string][char]92)
function Resolve-FinalPath {
    param([string]$p)
    $h = [Vanish.InvP32]::CreateFileW($p, 0, 7, [System.IntPtr]::Zero, 3, 0x02000000, [System.IntPtr]::Zero)
    if ($h -eq [System.IntPtr](-1)) { return $p }
    try {
        $sb = New-Object System.Text.StringBuilder 32768
        if ([Vanish.InvP32]::GetFinalPathNameByHandleW($h, $sb, 32768, 0) -eq 0) { return $p }
        $s = $sb.ToString()
        if ($s.StartsWith($script:LongPrefix)) { $s = $s.Substring(4) }
        return $s
    } finally { [void][Vanish.InvP32]::CloseHandle($h) }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params)
    $json = $params | ConvertTo-Json -Depth 6 -Compress
    $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    return (($out -join "`n") | ConvertFrom-Json)
}

$work = Join-Path $env:TEMP 'vanish-walker-invariants'
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $work -Force

Write-Host ''
Write-Host 'Vanish walker invariants: no finder reports a finding at an alias path' -ForegroundColor Cyan
Write-Host '======================================================================'

try {
    # ONE fixture, built to make several finders fire at once. Markers for the
    # reclaim group, a real repo for the git and credential checks, and two
    # junctions: one aliasing the repo, one pointing into a pruned directory.
    $proj = Join-Path $work 'proj'
    $null = New-Item -ItemType Directory -Path $proj -Force
    Set-Content -LiteralPath (Join-Path $proj 'package.json') -Value '{}' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $proj 'pubspec.yaml') -Value 'name: x' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $proj 'gradlew') -Value 'x' -Encoding ASCII
    $null = New-Item -ItemType Directory -Path (Join-Path $proj 'node_modules\dep') -Force
    Set-Content -LiteralPath (Join-Path $proj 'node_modules\dep\index.js') -Value 'x' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $work 'bundle.zip') -Value 'PK' -Encoding ASCII

    $hasGit = $null -ne (Get-Command git.exe -ErrorAction SilentlyContinue)
    if ($hasGit) {
        # git writes ordinary warnings to stderr (CRLF conversion, for one),
        # and a native command writing stderr under ErrorActionPreference =
        # 'Stop' aborts the script. Same guard the credentials suite uses.
        Push-Location $proj
        $gitEap = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        try {
            $null = & git.exe init 2>&1
            $null = & git.exe config user.email 't@example.com' 2>&1
            $null = & git.exe config user.name 't' 2>&1
            Set-Content -LiteralPath (Join-Path $proj '.gitignore') -Value ".env`nnode_modules/" -Encoding ASCII
            Set-Content -LiteralPath (Join-Path $proj '.env') -Value 'SECRET=1' -Encoding ASCII
            $null = & git.exe add .gitignore 2>&1
            $null = & git.exe commit -m init 2>&1
        } finally { $ErrorActionPreference = $gitEap; Pop-Location }
    }

    $aliasDir = Join-Path $work 'aliases'
    $null = New-Item -ItemType Directory -Path $aliasDir -Force
    $madeAlias = $false
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $null = & cmd.exe /c mklink /J "$(Join-Path $aliasDir 'projlink')" "$proj" 2>&1
        $madeAlias = Test-Path -LiteralPath (Join-Path $aliasDir 'projlink')
    } catch { $madeAlias = $false } finally { $ErrorActionPreference = $prevEap }

    if (-not $madeAlias) {
        Write-Skip 'no junction could be created on this machine, so the invariant cannot be exercised'
    } else {
        Assert-True (Test-Path -LiteralPath (Join-Path $aliasDir 'projlink\package.json')) `
            'premise: the fixture project is reachable by BOTH its real path and a junction'

        $scan = Invoke-Engine 'hygiene-scan' @{ roots = @($work); maxDepth = 8 }
        $results = @($scan.results)
        Assert-True (@($results).Count -gt 0) "the engine returned results at all ($(@($results).Count) checks)"

        # Only findings that live UNDER the fixture are this suite's business.
        # Checks that read machine state rather than a root will report real
        # things about this machine, and those are not alias candidates.
        $mine = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $results) {
            foreach ($f in @($r.findings)) {
                $p = [string]$f.path
                if ([string]::IsNullOrWhiteSpace($p)) { continue }
                if ($p.ToLowerInvariant().StartsWith($work.ToLowerInvariant())) {
                    $mine.Add(@{ finder = [string]$r.finder; path = $p })
                }
            }
        }

        # Without this the loop below is "zero findings, zero violations" and
        # would pass on a build where every finder was broken.
        $finderNames = @($mine | ForEach-Object { $_.finder } | Select-Object -Unique)
        Assert-True (@($mine).Count -gt 0) `
            "the fixture produced findings to check ($(@($mine).Count) from $(@($finderNames).Count) check(s): $(@($finderNames) -join ', '))" `
            'without this, the invariant below passes vacuously'
        # CANNOT-TEST IS NOT FAILURE. The first clean-machine run of this
        # suite failed here, and the product was fine: Windows Sandbox ships
        # without git, so three of the four checks that walk this fixture
        # could not run at all and only one was left to compare. A suite that
        # reports FAIL when it means "this machine cannot build the condition"
        # makes the release gate unreadable, which is the whole of bd pnor and
        # 686 -- and I wrote this one the same morning I filed them.
        #
        # The distinction that matters: fewer than two walkers WITH git present
        # is a real failure, because then something stopped reporting. Without
        # git it is a machine that cannot host the test.
        if (@($finderNames).Count -ge 2) {
            Assert-True $true 'and they come from more than one check, so the invariant is tested across walkers rather than one'
        } elseif (-not $hasGit) {
            Write-Skip "only $(@($finderNames).Count) check(s) could run because git.exe is not on PATH - the git and credential checks need a real repository, so the invariant above was tested against one walker rather than several"
        } else {
            Assert-True $false `
                'and they come from more than one check, so the invariant is tested across walkers rather than one' `
                "git IS available, so this is a real gap: checks: $(@($finderNames) -join ', ')"
        }

        # THE INVARIANT. Every reported path is resolved against the file
        # system; if what came back differs from what was reported, the finder
        # named a directory by an alias rather than by what it is.
        $violations = [System.Collections.Generic.List[string]]::new()
        foreach ($m in $mine) {
            $real = Resolve-FinalPath $m.path
            if ($real -ne $m.path) {
                $violations.Add("$($m.finder): reported '$($m.path)' which is really '$real'")
            }
        }
        Assert-True (@($violations).Count -eq 0) `
            'NO check reports a finding at an alias path' `
            ($violations -join "`n        ")

        # And the same real directory must not be reported twice by one check
        # under two names, which is the shape lxl found: 27 paths, 14 repos.
        $dupes = [System.Collections.Generic.List[string]]::new()
        foreach ($name in $finderNames) {
            $paths = @($mine | Where-Object { $_.finder -eq $name } | ForEach-Object { $_.path })
            $reals = @($paths | ForEach-Object { (Resolve-FinalPath $_).ToLowerInvariant() })
            $uniq  = @($reals | Select-Object -Unique)
            if (@($reals).Count -ne @($uniq).Count) {
                $dupes.Add("$name reported $(@($reals).Count) paths for $(@($uniq).Count) real directories")
            }
        }
        Assert-True (@($dupes).Count -eq 0) `
            'and no check reports one real directory twice under two names' `
            ($dupes -join "`n        ")

        # ==================================================================
        # A junction pointing INTO a pruned directory must not carry any walk
        # past the prune list. Prune lists match by NAME, so this is the exact
        # hole that let o1mj spend a whole scan budget inside AppData.
        $prunedTarget = Join-Path $work 'prunedstore'
        $null = New-Item -ItemType Directory -Path (Join-Path $prunedTarget 'deep') -Force
        Set-Content -LiteralPath (Join-Path $prunedTarget 'deep\package.json') -Value '{}' -Encoding ASCII
        $madePruneLink = $false
        $ErrorActionPreference = 'SilentlyContinue'
        try {
            $null = & cmd.exe /c mklink /J "$(Join-Path $proj 'node_modules\alias')" "$prunedTarget" 2>&1
            $madePruneLink = Test-Path -LiteralPath (Join-Path $proj 'node_modules\alias')
        } catch { $madePruneLink = $false } finally { $ErrorActionPreference = $prevEap }

        if (-not $madePruneLink) {
            Write-Skip 'second junction not created, so the prune-bypass case cannot be exercised'
        } else {
            $scan2 = Invoke-Engine 'hygiene-scan' @{ roots = @($work); maxDepth = 8 }
            $leaked = [System.Collections.Generic.List[string]]::new()
            foreach ($r in @($scan2.results)) {
                foreach ($f in @($r.findings)) {
                    $p = [string]$f.path
                    if ($p -like '*node_modules\alias*') { $leaked.Add("$($r.finder): $p") }
                }
            }
            Assert-True (@($leaked).Count -eq 0) `
                'a junction inside a pruned directory carries no walk past the prune list' `
                ($leaked -join "`n        ")
        }
    }
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { 'Red' } else { 'Green' })
if ($script:fail -gt 0) { exit 1 }
