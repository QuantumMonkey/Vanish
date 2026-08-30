# o1mj: where do local-only-credentials' 40 seconds go?
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\ho2-profile-probe.ps1
#
# Not in run-all.ps1: it walks the operator's real disks and times it.
#
# PROFILE BEFORE PREDICTING. lhf, 3l8, lxl, e6gn and gkib were each filed with
# a guess about the cause, and the profile disagreed with all five. So this
# asserts nothing about why; it splits the check into its phases and reports
# what each one costs.
#
# THE THREE CANDIDATE CAUSES this is built to separate:
#   1. ROOT COUNT. Get-Ho2DefaultRoots returns USERPROFILE plus up to 25
#      drive-root folders that hold a repo one level down, and each is walked
#      to depth 8 with its OWN 15,000-directory cap. The cost is per root, and
#      nobody has ever printed how many roots this machine yields.
#   2. GIT SUBPROCESSES. Test-Ho2GitIgnored shells out to git check-ignore
#      once per candidate file. Process creation on Windows is tens of
#      milliseconds; a few hundred candidates is a minute on its own.
#   3. JUNCTIONS DEFEATING THE PRUNE LIST. The walk has no reparse-point test.
#      'AppData' is pruned, but 'Local Settings' and 'Application Data' are
#      junctions TO AppData\Local and are not, so the walk can route straight
#      around its own prune. lxl found the same shape costing 3.7x.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fd = Join-Path $repoRoot 'finders'
. (Join-Path $fd '_contract.ps1')
. (Join-Path $fd '_never-touch.ps1')
. (Join-Path $fd '_loader.ps1')
[void](Import-Finders -directory $fd)

Add-Type -Namespace Vanish -Name P32 -MemberDefinition @'
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
    $h = [Vanish.P32]::CreateFileW($p, 0, 7, [System.IntPtr]::Zero, 3, 0x02000000, [System.IntPtr]::Zero)
    if ($h -eq [System.IntPtr](-1)) { return $p }
    try {
        $sb = New-Object System.Text.StringBuilder 32768
        if ([Vanish.P32]::GetFinalPathNameByHandleW($h, $sb, 32768, 0) -eq 0) { return $p }
        $s = $sb.ToString()
        if ($s.StartsWith($script:LongPrefix)) { $s = $s.Substring(4) }
        return $s
    } finally { [void][Vanish.P32]::CloseHandle($h) }
}

Write-Output '=== phase 1: which roots, and how many ==='
$swRoots = [System.Diagnostics.Stopwatch]::StartNew()
$roots = @(Get-Ho2DefaultRoots)
$swRoots.Stop()
Write-Output ("Get-Ho2DefaultRoots  {0,7:N0} ms  ->  {1} root(s)" -f $swRoots.Elapsed.TotalMilliseconds, $roots.Count)
foreach ($r in $roots) { Write-Output "    $r" }

# A root inside another root is the same tree walked twice. redirect-variables
# measured one folder twice for exactly this reason (lhf).
$overlap = @()
foreach ($a in $roots) {
    foreach ($b in $roots) {
        if ($a -eq $b) { continue }
        if ($a.TrimEnd('\').ToLowerInvariant().StartsWith($b.TrimEnd('\').ToLowerInvariant() + '\')) {
            $overlap += "$a is inside $b"
        }
    }
}
Write-Output ("overlapping roots: {0}" -f $(if ($overlap.Count) { $overlap -join '; ' } else { 'none' }))
Write-Output ''
Write-Output '=== phase 2: the walk, per root, warm ==='
Write-Output 'warming ...'
foreach ($r in $roots) { [void](Invoke-Ho2CredentialWalk -root $r -maxDepth 8) }
Write-Output 'warm.'
Write-Output ''

$totalWalkMs = 0.0
$totalDirs = 0
$allCandidates = [System.Collections.Generic.List[object]]::new()
$cappedRoots = @()
foreach ($r in $roots) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $w = Invoke-Ho2CredentialWalk -root $r -maxDepth 8
    $sw.Stop()
    $totalWalkMs += $sw.Elapsed.TotalMilliseconds
    $totalDirs += $w.dirsVisited
    foreach ($c in $w.candidates) { $allCandidates.Add($c) }
    $capped = @($w.unreadable | Where-Object { $_.reason -eq 'scan-capped' }).Count -gt 0
    if ($capped) { $cappedRoots += $r }
    Write-Output ("  {0,8:N0} ms  {1,6} dirs  {2,4} candidates  {3,3} repos  {4}{5}" -f `
        $sw.Elapsed.TotalMilliseconds, $w.dirsVisited, @($w.candidates).Count, @($w.repoRoots).Count, `
        $r, $(if ($capped) { '   <- HIT THE 15000 CAP' } else { '' }))
}
Write-Output ("  {0,8:N0} ms  {1,6} dirs  {2,4} candidates   TOTAL across {3} root(s)" -f $totalWalkMs, $totalDirs, $allCandidates.Count, $roots.Count)
Write-Output ''

Write-Output '=== phase 3: git check-ignore, one process per candidate ==='
$gitMs = 0.0
$n = 0
$sample = [Math]::Min($allCandidates.Count, 40)
for ($i = 0; $i -lt $sample; $i++) {
    $c = $allCandidates[$i]
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void](Test-Ho2GitIgnored -repoRoot $c.repoRoot -fullPath $c.file.FullName)
    $sw.Stop()
    $gitMs += $sw.Elapsed.TotalMilliseconds
    $n++
}
if ($n -gt 0) {
    $per = $gitMs / $n
    Write-Output ("  {0,8:N1} ms per call, measured over {1} of {2} candidates" -f $per, $n, $allCandidates.Count)
    Write-Output ("  {0,8:N0} ms projected for all {1} candidates" -f ($per * $allCandidates.Count), $allCandidates.Count)
} else {
    Write-Output '  no candidates found, so this phase costs nothing on this machine'
}
Write-Output ''

Write-Output '=== phase 4: is the prune list being routed around by junctions? ==='
# AppData is pruned. Local Settings and Application Data are junctions TO
# AppData\Local and are NOT pruned, so a walk with no reparse test can reach
# everything the prune was meant to exclude.
$aliasHits = 0
$examples = @()
foreach ($c in $allCandidates) {
    $p = $c.file.FullName
    $real = Resolve-FinalPath $p
    if ($real -ne $p) {
        $aliasHits++
        if ($examples.Count -lt 5) { $examples += ($p + '  ->  ' + $real) }
    }
}
Write-Output ("  candidates reached through a junction alias: {0} of {1}" -f $aliasHits, $allCandidates.Count)
foreach ($e in $examples) { Write-Output "    $e" }

$prof = Join-Path $env:USERPROFILE 'x'
foreach ($n2 in @('AppData', 'Local Settings', 'Application Data', 'My Documents')) {
    $p = Join-Path $env:USERPROFILE $n2
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $it = Get-Item -LiteralPath $p -Force
    $isRp = ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    $pruned = $script:Ho2PruneSegments -contains $n2
    Write-Output ("  {0,-18} reparse={1,-5} pruned={2,-5} {3}" -f $n2, $isRp, $pruned, `
        $(if ($isRp -and -not $pruned) { '<- WALKED, and it aliases something that is pruned' } else { '' }))
}
Write-Output ''
Write-Output ("SPLIT: walk {0:N0} ms + git {1:N0} ms (projected) = {2:N0} ms" -f `
    $totalWalkMs, $(if ($n -gt 0) { ($gitMs / $n) * $allCandidates.Count } else { 0 }), `
    ($totalWalkMs + $(if ($n -gt 0) { ($gitMs / $n) * $allCandidates.Count } else { 0 })))
if ($cappedRoots.Count -gt 0) {
    Write-Output ("CAPPED: {0} root(s) hit the 15,000-directory cap, so this check is NOT covering them fully: {1}" -f $cappedRoots.Count, ($cappedRoots -join ', '))
}
