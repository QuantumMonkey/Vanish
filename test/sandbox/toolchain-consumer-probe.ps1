# e6gn: how many times does reclaim-package-caches list the same directory,
# and does it count the same project once per junction alias?
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\toolchain-consumer-probe.ps1
#
# Not in run-all.ps1: it walks the operator's real home directory and times it.
#
# WHAT IS BEING MEASURED. Find-ToolchainConsumers (finders/_never-touch.ps1)
# runs one recursive Get-ChildItem PER MARKER:
#
#     foreach ($marker in $markers) {
#         Get-ChildItem -LiteralPath $root -Filter $marker -File -Recurse -Depth $maxDepth
#     }
#
# reclaim-package-caches calls it once per cache spec: npm (1 marker), Gradle
# (3), pip (3). Seven recursive listings of one tree to collect seven file
# names. That is 3l8 and lxl a third time.
#
# AND WHETHER IT HAS lxl's BUG. PowerShell 5.1's Get-ChildItem -Recurse
# FOLLOWS reparse points, so My Documents / Local Settings / Application Data
# should each yield the same projects again. lxl found 27 paths for 14 real
# repositories that way. If that is happening here the consumer COUNT in the
# evidence string is inflated, which is a claim about the machine, not just
# noise.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$findersDir = Join-Path $repoRoot 'finders'
. (Join-Path $findersDir '_contract.ps1')
. (Join-Path $findersDir '_never-touch.ps1')

$markerSets = @(
    @{ tool = 'npm';    markers = @('package.json') },
    @{ tool = 'Gradle'; markers = @('gradlew', 'build.gradle', 'build.gradle.kts') },
    @{ tool = 'pip';    markers = @('requirements.txt', 'pyproject.toml', 'setup.py') }
)

$root = $env:USERPROFILE
$depth = 4
Write-Output "root:  $root"
Write-Output "depth: $depth  (reclaim-package-caches default)"
Write-Output ''
Write-Output 'warming ...'
[void](Get-ChildItem -LiteralPath $root -Filter 'package.json' -File -Recurse -Depth $depth -Force -ErrorAction SilentlyContinue)
Write-Output 'warm.'
Write-Output ''

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
$totalWalks = 0
$totalMs = 0.0
$allProjects = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$allReal     = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

Write-Output '--- as it runs today: one recursive listing per marker ---'
foreach ($set in $markerSets) {
    $toolMs = 0.0
    foreach ($m in $set.markers) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $hits = @(Get-ChildItem -LiteralPath $root -Filter $m -File -Recurse -Depth $depth -Force -ErrorAction SilentlyContinue)
        $sw.Stop()
        $totalWalks++
        $toolMs += $sw.Elapsed.TotalMilliseconds
        foreach ($h in $hits) {
            [void]$allProjects.Add($h.DirectoryName)
            [void]$allReal.Add((Resolve-FinalPath $h.DirectoryName))
        }
        Write-Output ("  {0,-22} {1,-22} {2,7:N0} ms   {3,5} hits" -f $set.tool, $m, $sw.Elapsed.TotalMilliseconds, @($hits).Count)
    }
    $totalMs += $toolMs
}
Write-Output ("  {0,-45} {1,7:N0} ms   across {2} listings" -f 'TOTAL', $totalMs, $totalWalks)
Write-Output ''

# One walk collecting all seven names, which is what the fix would do. The
# shared walk skips reparse points, so this also shows what the junction
# duplication was worth.
Register-SharedWalkHarvest -markerNames @('package.json', 'gradlew', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml', 'setup.py')
Clear-SharedWalkCache
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$walk = Invoke-SharedTreeWalk -root $root -maxDepth $depth -maxDirs ([int]::MaxValue) -skipDirs @()
$sw.Stop()
$sharedMs = $sw.Elapsed.TotalMilliseconds

$sharedProjects = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($k in @($walk.markers.Keys)) {
    foreach ($d in @($walk.markers[$k])) { [void]$sharedProjects.Add($d) }
}

Write-Output '--- one shared walk collecting all seven names ---'
Write-Output ("  {0,-45} {1,7:N0} ms   across 1 listing" -f 'TOTAL', $sharedMs)
Write-Output ("  directories visited: {0}" -f $walk.dirsVisited)
foreach ($k in @($walk.markers.Keys | Sort-Object)) {
    Write-Output ("    {0,-22} {1,5} hits" -f $k, @($walk.markers[$k]).Count)
}
Write-Output ''

Write-Output '--- the junction question (lxl, asked again here) ---'
Write-Output ("  today:  {0,5} project paths -> {1,5} real directories   ({2} are a second name)" -f $allProjects.Count, $allReal.Count, ($allProjects.Count - $allReal.Count))
Write-Output ("  shared: {0,5} project paths" -f $sharedProjects.Count)
Write-Output ''

if ($allProjects.Count -eq 0) {
    Write-Output 'PROBE INVALID: no consumer project found at all, so every comparison here is vacuous.'
    exit 2
}

$dupes = $allProjects.Count - $allReal.Count
if ($dupes -gt 0) {
    Write-Output ("CONFIRMED: {0} of the {1} consumer paths are junction aliases of a directory already counted." -f $dupes, $allProjects.Count)
    $alias = @($allProjects | Where-Object { (Resolve-FinalPath $_) -ne $_ } | Select-Object -First 5)
    foreach ($p in $alias) {
        Write-Output ("    {0}" -f $p)
        Write-Output ("      is really {0}" -f (Resolve-FinalPath $p))
    }
} else {
    Write-Output 'No junction duplication found under this root at this depth.'
}
Write-Output ''
Write-Output ("SPEED: {0:N0} ms across {1} listings -> {2:N0} ms across 1  ({3:N1}x)" -f $totalMs, $totalWalks, $sharedMs, ($totalMs / [Math]::Max($sharedMs, 1)))
exit 0
