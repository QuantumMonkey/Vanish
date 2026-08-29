# lxl: does one shared walk find the same repos the two hand-written walks
# found, and does it cost less than both of them?
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\git-walk-equivalence-probe.ps1
#
# Not in run-all.ps1: it walks the operator's real home directory and times
# it, and a timing assertion on a disk nobody controls is a flaky test wearing
# a performance badge. What it produces is a number for docs\BENCHMARKS.md and
# a yes/no on the one thing that actually matters -- whether the repo SET
# moved.
#
# THE ONE KNOWN BEHAVIOUR DIFFERENCE, and the reason this probe exists rather
# than a reasoned argument. The two originals used Get-ChildItem -Directory
# and did NOT test for reparse points, so they followed junctions. The shared
# walk skips them. On a machine with a junction pointing outside the root at a
# repo that has no other path under it, the new code finds fewer repos. That
# is either zero repos or a real coverage change, and only the disk can say
# which -- so it is measured here and reported, never assumed.
#
# EVERYTHING IS TIMED WARM. 3l8 lost an hour to a cold bare walk being
# compared against warm finders, which made the shared walk look slower than
# the thing it replaced. A throwaway pass runs first.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$findersDir = Join-Path $repoRoot 'finders'
. (Join-Path $findersDir '_contract.ps1')
. (Join-Path $findersDir '_never-touch.ps1')
. (Join-Path $findersDir '_loader.ps1')
[void](Import-Finders -directory $findersDir)

# The pre-lxl walker, verbatim, so the comparison is against what shipped in
# 0.9.2 rather than against a paraphrase of it.
function Find-OldGitRepoRoots {
    param(
        [Parameter(Mandatory = $true)][string]$root,
        [int]$maxDepth = 6
    )
    $repos = [System.Collections.Generic.List[string]]::new()
    $unreadable = [System.Collections.Generic.List[object]]::new()
    if (-not (Test-Path -LiteralPath $root -PathType Container -ErrorAction SilentlyContinue)) {
        return @{ repos = @(); unreadable = @(); examined = 0 }
    }
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@{ Path = $root; Depth = 0 })
    $examined = 0
    while ($stack.Count -gt 0) {
        $cur = $stack.Pop()
        $examined++
        if (Test-Path -LiteralPath (Join-Path $cur.Path '.git') -ErrorAction SilentlyContinue) {
            $repos.Add($cur.Path)
        }
        if ($cur.Depth -ge $maxDepth) { continue }
        $err = $null
        $children = @(Get-ChildItem -LiteralPath $cur.Path -Directory -Force -ErrorAction SilentlyContinue -ErrorVariable +err |
            Where-Object { $_.Name -ne '.git' })
        foreach ($e in @($err)) {
            if ($null -eq $e) { continue }
            $target = if ($e.TargetObject) { [string]$e.TargetObject } else { $cur.Path }
            $unreadable.Add((New-Unreadable -path $target -reason 'access-denied' -detail $e.Exception.Message))
        }
        foreach ($c in $children) { $stack.Push(@{ Path = $c.FullName; Depth = ($cur.Depth + 1) }) }
    }
    return @{ repos = @($repos); unreadable = @($unreadable); examined = $examined }
}

$target = $env:USERPROFILE
$depth = 6
Write-Output "root:  $target"
Write-Output "depth: $depth"
Write-Output ''

Write-Output 'warming the file system cache (throwaway pass) ...'
[void](Find-OldGitRepoRoots -root $target -maxDepth $depth)
Clear-SharedWalkCache
[void](Invoke-SharedTreeWalk -root $target -maxDepth $depth -maxDirs ([int]::MaxValue) -skipDirs @('.git'))
Write-Output 'warm.'
Write-Output ''
# A junction is a SECOND NAME for a directory, so two paths that differ can be
# the same repo. Comparing raw strings would call that a lost repo. This asks
# the file system what the path really is, via the only API that answers:
# open a handle and ask what it resolved to.
Add-Type -Namespace Vanish -Name Path32 -MemberDefinition @'
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
    # FILE_FLAG_BACKUP_SEMANTICS (0x02000000) is what makes a DIRECTORY
    # openable at all; access 0 is query-only, share 7 so nothing is blocked.
    $h = [Vanish.Path32]::CreateFileW($p, 0, 7, [System.IntPtr]::Zero, 3, 0x02000000, [System.IntPtr]::Zero)
    if ($h -eq [System.IntPtr](-1)) { return $p }
    try {
        $sb = New-Object System.Text.StringBuilder 32768
        $n = [Vanish.Path32]::GetFinalPathNameByHandleW($h, $sb, 32768, 0)
        if ($n -eq 0) { return $p }
        $s = $sb.ToString()
        if ($s.StartsWith($script:LongPrefix)) { $s = $s.Substring(4) }
        return $s
    } finally { [void][Vanish.Path32]::CloseHandle($h) }
}

function New-PathSet {
    param([string[]]$paths, [switch]$canonical)
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($p in @($paths)) {
        $v = if ($canonical) { Resolve-FinalPath $p } else { $p }
        [void]$set.Add($v)
    }
    return $set
}

# --- the two originals, as two separate walks, which is what 0.9.2 did ------
$swA = [System.Diagnostics.Stopwatch]::StartNew()
$oldA = Find-OldGitRepoRoots -root $target -maxDepth $depth
$swA.Stop()
$swB = [System.Diagnostics.Stopwatch]::StartNew()
$oldB = Find-OldGitRepoRoots -root $target -maxDepth $depth
$swB.Stop()

# --- the shared walk: first caller pays, second is served from the cache ----
Clear-SharedWalkCache
$swN = [System.Diagnostics.Stopwatch]::StartNew()
$new1 = Find-SgnGitRepoRoots -root $target -maxDepth $depth
$swN.Stop()
$swC = [System.Diagnostics.Stopwatch]::StartNew()
$new2 = Find-PkoGitRepoRoots -root $target -maxDepth $depth
$swC.Stop()

$oldRaw  = New-PathSet -paths @($oldA.repos)
$newRaw  = New-PathSet -paths @($new1.repos)
$oldReal = New-PathSet -paths @($oldA.repos) -canonical
$newReal = New-PathSet -paths @($new1.repos) -canonical

Write-Output '--- timing (warm, same run) ---'
Write-Output ("  old walk A (gitignored-unique)      {0,8:N0} ms" -f $swA.Elapsed.TotalMilliseconds)
Write-Output ("  old walk B (repo-health)            {0,8:N0} ms" -f $swB.Elapsed.TotalMilliseconds)
Write-Output ("  old, both                           {0,8:N0} ms" -f ($swA.Elapsed.TotalMilliseconds + $swB.Elapsed.TotalMilliseconds))
Write-Output ("  new, first caller (walks)           {0,8:N0} ms" -f $swN.Elapsed.TotalMilliseconds)
Write-Output ("  new, second caller (cache hit)      {0,8:N0} ms" -f $swC.Elapsed.TotalMilliseconds)
Write-Output ("  new, both                           {0,8:N0} ms" -f ($swN.Elapsed.TotalMilliseconds + $swC.Elapsed.TotalMilliseconds))
Write-Output ''
Write-Output '--- what each walk reported ---'
Write-Output ("  old: {0,4} paths -> {1,4} real directories   ({2} were a second name for one already listed)" -f $oldRaw.Count, $oldReal.Count, ($oldRaw.Count - $oldReal.Count))
Write-Output ("  new: {0,4} paths -> {1,4} real directories   ({2} were a second name for one already listed)" -f $newRaw.Count, $newReal.Count, ($newRaw.Count - $newReal.Count))
Write-Output ("  dirs visited: old {0}, new {1}" -f $oldA.examined, $new1.examined)
Write-Output ("  unreadable:   old {0}, new {1}" -f @($oldA.unreadable).Count, @($new1.unreadable).Count)
Write-Output ''
$lostReal  = @($oldReal | Where-Object { -not $newReal.Contains($_) })
$gainedReal = @($newReal | Where-Object { -not $oldReal.Contains($_) })

# The negative control. Two empty sets are identical and prove nothing, so a
# run that found no repo at all is a failed probe, not a passed comparison.
if ($newReal.Count -eq 0) {
    Write-Output 'PROBE INVALID: no repo found under the root, so any comparison is vacuous.'
    exit 2
}

Write-Output '--- the question that matters: was a real repo lost? ---'
if (@($lostReal).Count -eq 0) {
    Write-Output ("  NO. Every one of the {0} real repos the old walk found is still found." -f $oldReal.Count)
} else {
    Write-Output ("  YES - {0} real directories are no longer reported:" -f @($lostReal).Count)
    foreach ($p in $lostReal) { Write-Output "    $p" }
}
if (@($gainedReal).Count -gt 0) {
    Write-Output ("  and {0} the old walk did not report:" -f @($gainedReal).Count)
    foreach ($p in $gainedReal) { Write-Output "    $p" }
}
Write-Output ''

# Every raw path the old walk reported and the new one does not must be an
# ALIAS of something the new walk did report - a junction name for a directory
# already in the list. That is the whole claim, so it is checked rather than
# asserted from the fact that the counts look plausible.
$aliasOnly = @($oldRaw | Where-Object { -not $newRaw.Contains($_) })
$unexplained = @($aliasOnly | Where-Object { -not $newReal.Contains((Resolve-FinalPath $_)) })
Write-Output '--- the paths the old walk reported that the new one does not ---'
Write-Output ("  {0} paths, of which {1} resolve to a directory the new walk DID report" -f @($aliasOnly).Count, (@($aliasOnly).Count - @($unexplained).Count))
foreach ($p in @($aliasOnly | Select-Object -First 6)) {
    Write-Output ("    {0}" -f $p)
    Write-Output ("      is really {0}" -f (Resolve-FinalPath $p))
}
if (@($aliasOnly).Count -gt 6) { Write-Output ("    ... and {0} more" -f (@($aliasOnly).Count - 6)) }
Write-Output ''

# The two finders must also agree with EACH OTHER, which is the entire premise
# of putting them in one walk group.
$agree = ((@($new1.repos) | Sort-Object) -join '|') -eq ((@($new2.repos) | Sort-Object) -join '|')
Write-Output ("--- the two finders agree with each other: {0} ---" -f $(if ($agree) { 'yes' } else { 'NO' }))

$ok = $true
if (@($lostReal).Count -gt 0) { $ok = $false }
if (@($unexplained).Count -gt 0) {
    $ok = $false
    Write-Output ''
    Write-Output ("UNEXPLAINED: {0} old paths are neither reported nor an alias of one that is:" -f @($unexplained).Count)
    foreach ($p in $unexplained) { Write-Output "    $p" }
}
if (-not $agree) { $ok = $false }

Write-Output ''
if ($ok) {
    Write-Output 'PASS: no real repo was lost. The paths that disappeared were junction aliases of repos still reported.'
    exit 0
}
Write-Output 'FAIL: see above.'
exit 1
