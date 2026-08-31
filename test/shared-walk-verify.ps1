# One walk of the disk must answer several questions, and give the SAME answers
# it gave when it was four walks (3l8).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\shared-walk-verify.ps1
#
# WHY THIS EXISTS. reclaim-node, reclaim-archives, reclaim-flutter and
# reclaim-gradle each ran their own stack walk from $env:USERPROFILE. Same
# root, same depth 8, the same 15,000-directory cap, and the same fifteen-entry
# skip list written in four different orders. Four listings of one disk to
# answer four questions about the same directories.
#
# Measured on the operator's machine 2026-08-29, warm:
#
#   one walk, harvesting one marker                      12.4 s
#   the same walk, harvesting all four                   12.4 s   (free)
#   the four finders, four engine calls                  66.2 s
#   the four finders, ONE call, sharing the walk         28.2 s
#
# That is a performance change to the code that decides what a person is
# offered to delete, so the only thing that makes it legitimate is that the
# ANSWERS did not move. The last section here is that control: the four run as
# a group are compared, finding by finding, against the same four run one at a
# time.
#
# THE MEMO IS TESTED AS A MEMO. A cache you cannot prove is being hit is
# indistinguishable from a slow function; a cache you cannot prove CLEARS is a
# tool reporting the disk as it was before the operator changed it. Both are
# asserted by mutating the tree between walks and checking which answer comes
# back -- there is no instrumentation to trust.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$findersDir = Join-Path $root 'finders'
. (Join-Path $findersDir '_contract.ps1')
. (Join-Path $findersDir '_never-touch.ps1')
. (Join-Path $findersDir '_loader.ps1')

# The finder files themselves, because the skip lists and the harvest
# registrations this suite asserts on live in them. Import-Finders is what
# the engine uses, so the premise below is checked against the same load
# path the product takes rather than a second one written for the test.
$script:loadReport = Import-Finders -directory $findersDir

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
function Write-Skip {
    param([string]$label)
    Write-Host "  SKIP  $label" -ForegroundColor Yellow
}

function New-Fixture {
    param([string]$base)
    $spec = @(
        'proj-node\package.json',
        'proj-node\node_modules\dep\index.js',
        'proj-node\dist\bundle.js',
        'proj-flutter\pubspec.yaml',
        'proj-flutter\build\app.so',
        'proj-gradle\gradlew',
        'proj-gradle\.gradle\cache.bin',
        'arch\bundle.zip',
        'arch\bundle\inner.txt',
        'deep\a\b\package.json',
        'deep\a\b\c\package.json'
    )
    foreach ($rel in $spec) {
        $full = Join-Path $base $rel
        $dir = Split-Path -Parent $full
        if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
        Set-Content -LiteralPath $full -Value 'x' -Encoding ASCII
    }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) 'vanish shared walk probe'
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $work -Force

Write-Host ''
Write-Host 'Vanish shared tree walk (3l8, lxl, e6gn)' -ForegroundColor Cyan
Write-Host '========================================'

try {
    New-Fixture -base $work

    # ==================================================================
    Write-Host ''
    Write-Host 'THE PREMISE: the four walks really were one walk' -ForegroundColor Cyan
    # Without this, everything below tests a cache that is quietly answering
    # four DIFFERENT questions with one answer -- which would be the aeu defect
    # with a stopwatch attached rather than a fix. If a future finder narrows
    # its skip list, this fails here rather than silently under-reporting.
    $node    = @($script:PiuNodeSkipDirs    | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    $archive = @($script:PiuArchiveSkipDirs | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    $flutter = @($script:PiuFlutterSkipDirs | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    $gradle  = @($script:PiuGradleSkipDirs  | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    Assert-True ($node.Count -gt 0) "the reclaim skip lists are loaded at all ($($node.Count) entries)"
    Assert-True (($node -join '|') -eq ($archive -join '|')) 'reclaim-node and reclaim-archives skip the same directories' "node=$($node -join ',') archive=$($archive -join ',')"
    Assert-True (($node -join '|') -eq ($flutter -join '|')) 'and reclaim-flutter skips the same ones' "flutter=$($flutter -join ',')"
    Assert-True (($node -join '|') -eq ($gradle  -join '|')) 'and reclaim-gradle too - so one walk can legitimately serve all four' "gradle=$($gradle -join ',')"

    # ==================================================================
    Write-Host ''
    Write-Host 'Every reclaim marker is actually registered for harvest' -ForegroundColor Cyan
    # A finder that forgot to register would get an empty marker list back and
    # report a clean machine. That is the failure this project exists to make
    # impossible, so it gets an assertion rather than a convention.
    $harvest = Get-SharedWalkHarvest
    foreach ($m in @('package.json', 'pubspec.yaml', 'gradlew')) {
        Assert-True (@($harvest.markers) -contains $m) "'$m' is in the shared harvest, so the finder that needs it can find anything at all"
    }
    Assert-True (@($harvest.extensions) -contains '.zip') "'.zip' is in the shared harvest for reclaim-archives"

    # ==================================================================
    Write-Host ''
    Write-Host 'The walk finds what the four private walks found' -ForegroundColor Cyan
    Clear-SharedWalkCache
    $w = Invoke-SharedTreeWalk -root $work -maxDepth 8 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    $pkg = @($w.markers['package.json'])
    Assert-True ($pkg -contains (Join-Path $work 'proj-node')) 'the package.json project is found'
    Assert-True (@($w.markers['pubspec.yaml']) -contains (Join-Path $work 'proj-flutter')) 'the pubspec.yaml project is found in the SAME walk'
    Assert-True (@($w.markers['gradlew']) -contains (Join-Path $work 'proj-gradle')) 'and the gradlew project, in the same walk again'
    Assert-True (@($w.files['.zip']).Count -eq 1) "and the one .zip file, as a FileInfo ($(@($w.files['.zip']).Count) found)"
    Assert-True (-not ($pkg -contains (Join-Path $work 'proj-node\node_modules\dep'))) 'a package.json inside node_modules is NOT reported - the skip list still prunes'
    Assert-True ($w.capped -eq $false) 'a small tree is not reported as capped'
    Assert-True (@($w.unreadable).Count -eq 0) 'and nothing is unreadable in a tree we just created'

    # ==================================================================
    Write-Host ''
    Write-Host 'The memo is tested as a memo, by changing the disk underneath it' -ForegroundColor Cyan
    # No instrumentation, no call counter: the tree is mutated between walks
    # and the answer says which one ran. A stale answer here is the PROOF the
    # second walk did not happen, which is the whole point of the change.
    Remove-Item -LiteralPath (Join-Path $work 'proj-flutter\pubspec.yaml') -Force
    $w2 = Invoke-SharedTreeWalk -root $work -maxDepth 8 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    Assert-True (@($w2.markers['pubspec.yaml']) -contains (Join-Path $work 'proj-flutter')) 'a second walk with the same parameters is served from the cache - it still reports the file we just deleted, which is how we know it did not walk again'

    $w3 = Invoke-SharedTreeWalk -root $work -maxDepth 2 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    Assert-True (-not (@($w3.markers['pubspec.yaml']) -contains (Join-Path $work 'proj-flutter'))) 'a DIFFERENT depth is not served from that cache - it walks, and sees the deletion'

    $w4 = Invoke-SharedTreeWalk -root $work -maxDepth 8 -maxDirs 15000 -skipDirs @('node_modules')
    Assert-True (-not (@($w4.markers['pubspec.yaml']) -contains (Join-Path $work 'proj-flutter'))) 'and a different SKIP LIST is not either - two finders pruning differently are not looking at the same tree'

    Clear-SharedWalkCache
    $w5 = Invoke-SharedTreeWalk -root $work -maxDepth 8 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    Assert-True (-not (@($w5.markers['pubspec.yaml']) -contains (Join-Path $work 'proj-flutter'))) 'Clear-SharedWalkCache really clears - the next scan sees the disk as it is now, not as it was when the operator started'
    Assert-True (@($w5.markers['package.json']) -contains (Join-Path $work 'proj-node')) 'and the rest of the tree is still found after the clear'

    # A marker registered AFTER a walk must not be answered from a cache that
    # never looked for it. That would be a finder reporting 'nothing' because
    # nobody collected its marker - aeu's defect with the door held open by a
    # performance optimisation.
    Set-Content -LiteralPath (Join-Path $work 'proj-node\Cargo.toml') -Value 'x' -Encoding ASCII
    Register-SharedWalkHarvest -markerNames @('Cargo.toml')
    $w6 = Invoke-SharedTreeWalk -root $work -maxDepth 8 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    Assert-True ($null -ne $w6.markers['Cargo.toml']) 'a marker registered after a walk gets a key at all, rather than $null'
    Assert-True (@($w6.markers['Cargo.toml']) -contains (Join-Path $work 'proj-node')) 'and it is actually FOUND - the harvest is in the cache key, so a late registration walks again instead of being answered by a walk that never looked for it'

    # ==================================================================
    Write-Host ''
    Write-Host 'The properties the four private walks had, kept' -ForegroundColor Cyan
    Clear-SharedWalkCache
    $capped = Invoke-SharedTreeWalk -root $work -maxDepth 8 -maxDirs 2 -skipDirs $script:PiuNodeSkipDirs
    Assert-True ($capped.capped -eq $true) 'hitting the directory cap sets capped'
    Assert-True (@($capped.unreadable).Count -gt 0) 'and produces unreadable records rather than a quietly short list'
    Assert-True ((@($capped.unreadable) | Where-Object { $_.reason -eq 'scan-capped' }).Count -gt 0) "and they carry reason 'scan-capped', which is what turns a truncated walk into could-not-look instead of a clean result"
    Assert-True ($capped.dirsVisited -eq 2) "and it stopped at the cap it was given ($($capped.dirsVisited))"

    Clear-SharedWalkCache
    $shallow = Invoke-SharedTreeWalk -root $work -maxDepth 0 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    Assert-True ($shallow.dirsVisited -eq 1) 'depth 0 visits only the root itself'
    Clear-SharedWalkCache
    $d3 = Invoke-SharedTreeWalk -root $work -maxDepth 3 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
    Assert-True (@($d3.markers['package.json']) -contains (Join-Path $work 'deep\a\b')) 'a marker sitting exactly AT maxDepth is still reported - the depth cut stops descent, it does not blind the level it stops on'
    Assert-True (-not (@($d3.markers['package.json']) -contains (Join-Path $work 'deep\a\b\c'))) 'and the level BELOW it is not - without this the assertion above would pass on a walk with no depth limit at all'

    # ==================================================================
    Write-Host ''
    Write-Host 'A junction is not descended into' -ForegroundColor Cyan
    # A junction is a second name for somewhere else. Following one
    # double-counts at best and loops forever at worst, and the four private
    # walks each refused to. SKIPPED rather than failed when the machine will
    # not create one: an unprivileged shell on some policies cannot, and a
    # suite that can never be green in a tier Vanish supports teaches everyone
    # to read past the failure count.
    $loopHome = Join-Path $work 'loop'
    $null = New-Item -ItemType Directory -Path $loopHome -Force
    $junction = $null
    try { $junction = New-Item -ItemType Junction -Path (Join-Path $loopHome 'back') -Target $work -ErrorAction Stop } catch { $junction = $null }
    if ($null -eq $junction) {
        Write-Skip 'this machine would not create a junction, so the loop guard could not be exercised here'
    } else {
        Clear-SharedWalkCache
        $j = Invoke-SharedTreeWalk -root $loopHome -maxDepth 8 -maxDirs 15000 -skipDirs $script:PiuNodeSkipDirs
        Assert-True ($j.dirsVisited -eq 1) "the junction is not followed, so a self-referencing tree terminates ($($j.dirsVisited) directories visited)"
        Assert-True ($j.capped -eq $false) 'and it terminates by finishing rather than by hitting the cap'
    }


    # ==================================================================
    Write-Host ''
    Write-Host 'Entry names: a .git that is a FILE is still a repo (lxl)' -ForegroundColor Cyan
    # markerNames only ever matches a child that is a file, which is right for
    # package.json and wrong for a repo root. An ordinary clone has a .git
    # DIRECTORY; a submodule or a linked worktree has a .git FILE. Both are
    # repos, and a scan that finds only one kind reports the other as absent -
    # which is aeu's defect, not a coverage gap.
    $gitBase = Join-Path $work 'gitfix'
    $null = New-Item -ItemType Directory -Path (Join-Path $gitBase 'clone\.git\objects') -Force
    Set-Content -LiteralPath (Join-Path $gitBase 'clone\.git\HEAD') -Value 'ref: refs/heads/main' -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $gitBase 'clone\readme.txt') -Value 'x' -Encoding ASCII
    $null = New-Item -ItemType Directory -Path (Join-Path $gitBase 'worktree') -Force
    Set-Content -LiteralPath (Join-Path $gitBase 'worktree\.git') -Value 'gitdir: ../clone/.git/worktrees/wt' -Encoding ASCII
    $null = New-Item -ItemType Directory -Path (Join-Path $gitBase 'plain\sub') -Force
    Set-Content -LiteralPath (Join-Path $gitBase 'plain\sub\file.txt') -Value 'x' -Encoding ASCII

    $harvest = Get-SharedWalkHarvest
    Assert-True (@($harvest.entryNames) -contains '.git') "'.git' is registered as an ENTRY name, not a marker name" "entryNames=$(@($harvest.entryNames) -join ',')"
    Assert-True (-not (@($harvest.markers) -contains '.git')) "and NOT as a marker name - a marker would miss every ordinary clone"

    Clear-SharedWalkCache
    $gw = Invoke-SharedTreeWalk -root $gitBase -maxDepth 6 -maxDirs ([int]::MaxValue) -skipDirs @('.git')
    $gitFound = @($gw.entries['.git'])
    Assert-True (@($gitFound).Count -eq 2) "two repos found under the fixture, not one" "found: $(@($gitFound) -join ' | ')"
    Assert-True (@($gitFound | Where-Object { $_ -like '*clone' }).Count -eq 1) 'the ordinary clone (.git is a DIRECTORY) is found'
    Assert-True (@($gitFound | Where-Object { $_ -like '*worktree' }).Count -eq 1) 'the linked worktree (.git is a FILE) is found too'
    Assert-True (@($gitFound | Where-Object { $_ -like '*plain*' }).Count -eq 0) 'a directory with no .git at all is NOT reported as a repo'

    # -skipDirs and -entryNames naming the same directory is the whole shape
    # of the two walkers this replaced: count it, then refuse to walk into it.
    # If .git were descended into, its own subdirectories would be visited and
    # every one of them checked, which is where the original Where-Object went.
    $insideGit = @($gitFound | Where-Object { $_ -like '*\.git*' })
    Assert-True (@($insideGit).Count -eq 0) 'nothing INSIDE a .git directory is reported - it is counted, then not descended into' "leaked: $(@($insideGit) -join ' | ')"

    # ==================================================================
    Write-Host ''
    Write-Host 'The two git finders share the walk with each other, and nothing else (lxl)' -ForegroundColor Cyan
    # They cannot join the reclaim group: depth 6 against depth 8, no skip list
    # against fifteen pruned names, and no directory cap against 15,000.
    # Merging those would change WHAT IS COVERED, not how fast it is covered,
    # so the cache key must keep them apart. This asserts the separation
    # rather than trusting the parameters to stay put.
    $reg = @($script:FinderRegistry)
    $sgn = @($reg | Where-Object { $_.name -eq 'gitignored-unique' })[0]
    $pko = @($reg | Where-Object { $_.name -eq 'repo-health' })[0]
    $nod = @($reg | Where-Object { $_.name -eq 'reclaim-node' })[0]
    Assert-True ($null -ne $sgn -and $null -ne $pko) 'both git finders are registered'
    Assert-True ($sgn.walkGroup -eq 'git-repos') "gitignored-unique is in walk group 'git-repos'" "got '$($sgn.walkGroup)'"
    Assert-True ($pko.walkGroup -eq 'git-repos') "repo-health is in the same group - so the renderer sends them in ONE engine call" "got '$($pko.walkGroup)'"
    Assert-True ($nod.walkGroup -ne $sgn.walkGroup) 'and the reclaim group is a DIFFERENT group - a different depth and skip list is a different question' "reclaim='$($nod.walkGroup)' git='$($sgn.walkGroup)'"

    # The memo, tested as a memo, exactly as the reclaim group is above: delete
    # a repo between the two calls. A cache that is really being hit returns
    # the STALE answer, and a stale answer here is the proof. If the second
    # finder walked again it would see three repos, not four.
    $memoBase = Join-Path $work 'gitmemo'
    foreach ($n in @('r1', 'r2', 'r3', 'r4')) {
        $null = New-Item -ItemType Directory -Path (Join-Path $memoBase "$n\.git") -Force
        Set-Content -LiteralPath (Join-Path $memoBase "$n\.git\HEAD") -Value 'ref: refs/heads/main' -Encoding ASCII
    }
    Clear-SharedWalkCache
    $first = Find-SgnGitRepoRoots -root $memoBase -maxDepth 6
    Assert-True (@($first.repos).Count -eq 4) 'the first git finder sees four repos' "saw $(@($first.repos).Count)"
    Remove-Item -LiteralPath (Join-Path $memoBase 'r4') -Recurse -Force
    $second = Find-PkoGitRepoRoots -root $memoBase -maxDepth 6
    Assert-True (@($second.repos).Count -eq 4) 'the second git finder still sees four after one was deleted - it was served from the cache, it did not walk' "saw $(@($second.repos).Count); if this is 3 the two finders are still walking twice"
    Clear-SharedWalkCache
    $third = Find-PkoGitRepoRoots -root $memoBase -maxDepth 6
    Assert-True (@($third.repos).Count -eq 3) 'and after Clear-SharedWalkCache it sees three - the cache clears between scans, so a second scan is not the first scan replayed' "saw $(@($third.repos).Count)"

    # Both finders must return the SAME set, which is the premise of grouping
    # them. Compared as sets, not counts: two different sets of equal size
    # would pass a count check and be wrong.
    Clear-SharedWalkCache
    $sgnRepos = @((Find-SgnGitRepoRoots -root $memoBase -maxDepth 6).repos | Sort-Object)
    $pkoRepos = @((Find-PkoGitRepoRoots -root $memoBase -maxDepth 6).repos | Sort-Object)
    Assert-True (($sgnRepos -join '|') -eq ($pkoRepos -join '|')) 'the two finders get identical repo sets, which is what makes one walk legitimate' "sgn=$($sgnRepos -join ',') pko=$($pkoRepos -join ',')"
    Assert-True (@($sgnRepos).Count -gt 0) 'and the set is not empty - without this the comparison above is empty-equals-empty'


    # ==================================================================
    Write-Host ''
    Write-Host 'Toolchain consumers: seven listings became one walk (e6gn)' -ForegroundColor Cyan
    # Find-ToolchainConsumers ran one recursive Get-ChildItem PER MARKER, so
    # reclaim-package-caches listed the same tree seven times (npm 1 marker,
    # Gradle 3, pip 3). Measured warm on the operator machine: 4,552 ms across
    # seven listings against 1,312 ms for one walk, with identical hit counts
    # for every marker.
    $need = @('package.json', 'gradlew', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml', 'setup.py')
    $harvest = Get-SharedWalkHarvest
    $missingAtLoad = @($need | Where-Object { $harvest.markers -notcontains $_ })
    # THIS is the assertion that the fix works for the reason claimed. The
    # equivalence checks below would pass even if nothing were registered at
    # file scope, because Find-ToolchainConsumers registers whatever it is
    # handed before walking - so they would prove ONE WALK PER SPEC, not one
    # walk. Only the load-time harvest proves the three specs share it.
    Assert-True (@($missingAtLoad).Count -eq 0) 'all seven cache markers are harvested BEFORE any handler runs, so the three cache specs share one walk' "not registered at file scope: $(@($missingAtLoad) -join ', ')"

    $tcRoot = Join-Path $work 'toolchain'
    $null = New-Item -ItemType Directory -Path (Join-Path $tcRoot 'app-node') -Force
    Set-Content -LiteralPath (Join-Path $tcRoot 'app-node\package.json') -Value '{}' -Encoding ASCII
    $null = New-Item -ItemType Directory -Path (Join-Path $tcRoot 'app-gradle') -Force
    Set-Content -LiteralPath (Join-Path $tcRoot 'app-gradle\gradlew') -Value 'x' -Encoding ASCII
    $null = New-Item -ItemType Directory -Path (Join-Path $tcRoot 'app-py\src') -Force
    Set-Content -LiteralPath (Join-Path $tcRoot 'app-py\pyproject.toml') -Value 'x' -Encoding ASCII
    $null = New-Item -ItemType Directory -Path (Join-Path $tcRoot 'not-a-project') -Force
    Set-Content -LiteralPath (Join-Path $tcRoot 'not-a-project\readme.txt') -Value 'x' -Encoding ASCII

    Clear-SharedWalkCache
    $tc = Find-ToolchainConsumers -markers @('package.json', 'gradlew', 'pyproject.toml') -roots @($tcRoot) -maxDepth 4
    $byMarker = @{}
    foreach ($c in @($tc.findings)) {
        if (-not $byMarker.ContainsKey($c.marker)) { $byMarker[$c.marker] = [System.Collections.Generic.List[string]]::new() }
        $byMarker[$c.marker].Add($c.project)
    }
    Assert-True (@($tc.findings).Count -eq 3) 'three consumers found, one per marker' "found $(@($tc.findings).Count)"
    Assert-True ($tc.state -eq 'found') "state is 'found', not 'nothing' or 'could-not-look'" "got '$($tc.state)'"
    Assert-True (@($byMarker['package.json']) -contains (Join-Path $tcRoot 'app-node')) 'the node project is reported under its own marker'
    Assert-True (@($byMarker['gradlew']) -contains (Join-Path $tcRoot 'app-gradle')) 'the gradle project too'
    $projects = @(@($tc.findings) | ForEach-Object { $_.project })
    Assert-True (@($projects | Where-Object { $_ -like '*not-a-project*' }).Count -eq 0) 'a directory with no marker is not reported as a consumer'

    # The shape callers read. project is the directory; path is the marker file
    # inside it, which the shared walk does not return and has to reconstruct.
    $one = @(@($tc.findings) | Where-Object { $_.marker -eq 'gradlew' })[0]
    Assert-True ($one.path -eq (Join-Path (Join-Path $tcRoot 'app-gradle') 'gradlew')) 'path is the marker FILE, rebuilt from the directory the walk returned' "got '$($one.path)'"

    # THE SAFETY NET, and the reason Find-ToolchainConsumers registers at call
    # time as well as at file scope. scanner.ps1's toolchain-consumers action
    # passes whatever markers the caller asked for. A marker nobody declared
    # would come back empty from a walk that never collected it - and "no
    # consumers found" is the worst possible wrong answer about a toolchain
    # somebody is deciding whether to delete. Registering first changes the
    # cache key, so an undeclared marker costs one extra walk instead.
    $null = New-Item -ItemType Directory -Path (Join-Path $tcRoot 'app-ruby') -Force
    Set-Content -LiteralPath (Join-Path $tcRoot 'app-ruby\Gemfile') -Value 'x' -Encoding ASCII
    # 'Gemfile' rather than 'Cargo.toml': the 3l8 section above already
    # registers Cargo.toml for its own late-registration test, so reusing it
    # here made THIS premise false and the assertion below fail against a
    # product that was working correctly. A test marker has to be unused by
    # every other test in the file, not merely by every finder.
    Assert-True ((Get-SharedWalkHarvest).markers -notcontains 'Gemfile') 'premise: nothing has declared Gemfile, so the walk was never collecting it' "harvest: $((Get-SharedWalkHarvest).markers -join ', ')"
    $rust = Find-ToolchainConsumers -markers @('Gemfile') -roots @($tcRoot) -maxDepth 4
    Assert-True (@($rust.findings).Count -ge 1) 'an UNDECLARED marker is still found - it forces a fresh walk rather than answering "no consumers" from a cache that never looked' "found $(@($rust.findings).Count); if this is 0 the shared walk is reporting a confident lie"
    Assert-True ($rust.state -eq 'found') "and its state is 'found'" "got '$($rust.state)'"

    # ==================================================================
    Write-Host ''
    Write-Host 'A junction OUT of the root is named; one INSIDE it is not (127o)' -ForegroundColor Cyan
    # Every walker here refuses to descend into a junction. Only ONE of the two
    # cases is a hole in the scan.
    #
    #   target INSIDE the root  -> stay silent. The content is reached under its
    #                              real name, so naming it would be a FALSE
    #                              could-not-look. Every Windows home directory
    #                              has three of these (My Documents, Local
    #                              Settings, Application Data), so getting this
    #                              wrong would put unreadableCount above zero on
    #                              every machine and make UI_NOTHING_FOUND - the
    #                              one state that means clean - unreachable.
    #   target OUTSIDE the root -> record it. Nothing else reaches it.
    $jRootB = Join-Path $work 'reparse'
    $inside = Join-Path $jRootB 'real'
    $null = New-Item -ItemType Directory -Path $inside -Force
    Set-Content -LiteralPath (Join-Path $inside 'package.json') -Value '{}' -Encoding ASCII
    $outsideTarget = Join-Path $work 'beyond-the-root'
    $null = New-Item -ItemType Directory -Path $outsideTarget -Force
    Set-Content -LiteralPath (Join-Path $outsideTarget 'package.json') -Value '{}' -Encoding ASCII

    $jOut = Join-Path $jRootB 'outward'
    $jIn  = Join-Path $jRootB 'inward'
    $madeBoth = $false
    $prevEapB = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $null = & cmd.exe /c mklink /J "$jOut" "$outsideTarget" 2>&1
        $null = & cmd.exe /c mklink /J "$jIn" "$inside" 2>&1
        $madeBoth = (Test-Path -LiteralPath $jOut) -and (Test-Path -LiteralPath $jIn)
    } catch { } finally { $ErrorActionPreference = $prevEapB }

    if (-not $madeBoth) {
        Write-Skip 'could not create both junctions, so the inside/outside distinction cannot be exercised here'
    } else {
        Assert-True ((Resolve-FinalPath $jOut) -ne $jOut) `
            'premise: the resolver sees through a junction, so the checks below are not passing by accident'

        Clear-SharedWalkCache
        $w127 = Invoke-SharedTreeWalk -root $jRootB -maxDepth 6 -maxDirs 15000 -skipDirs @()
        $ns = @($w127.unreadable | Where-Object { $_.reason -eq 'not-searched' })
        Assert-True (@($ns | Where-Object { $_.path -like '*outward*' }).Count -eq 1) `
            'a junction whose target is OUTSIDE the root is named as not-searched' `
            "recorded: $(@($ns | ForEach-Object { $_.path }) -join ' | ')"
        Assert-True (@($ns | Where-Object { $_.path -like '*inward*' }).Count -eq 0) `
            'and one whose target is INSIDE the root is NOT - it is reached under its real name' `
            "recorded: $(@($ns | ForEach-Object { $_.path }) -join ' | ')"

        # The sizer takes the same rule, and since gkib an unreachable subtree
        # makes its total a FLOOR rather than discarding the measurement.
        Clear-FinderSizeCache
        $mz = Measure-FinderPathBytes -path $jRootB
        Assert-True ($mz.hadError -eq $true) 'the sizer reports a partial total when a junction leaves the root'
        Assert-True (@($mz.unreadable | Where-Object { $_ -like '*outward*' }).Count -eq 1) `
            'and names the junction it did not follow' `
            "blind: $(@($mz.unreadable) -join ' | ')"
        Assert-True (@($mz.unreadable | Where-Object { $_ -like '*inward*' }).Count -eq 0) `
            'and does not name the one that stays inside'
    }


    # ==================================================================
    Write-Host ''
    Write-Host 'THE CONTROL: four sharing a walk answer what four separate walks answered' -ForegroundColor Cyan
    # This is the assertion the whole change stands on. Everything above tests
    # the mechanism; this tests that the mechanism did not change the ANSWER,
    # which is what a person is shown and asked to act on. Both sides run the
    # real finders through the real Invoke-HygieneScan - the only difference is
    # how many finders are in the call, which is exactly the variable the
    # renderer now controls.
    $four = @('reclaim-node', 'reclaim-archives', 'reclaim-flutter', 'reclaim-gradle')
    $base = @{ roots = @($work); maxDepth = 8; finderDir = $findersDir }

    $together = @((Invoke-HygieneScan -p ($base + @{ finders = $four })).results)
    $apart = @()
    foreach ($n in $four) { $apart += @((Invoke-HygieneScan -p ($base + @{ finders = @($n) })).results) }

    Assert-True ($together.Count -eq 4) "one call returns all four results ($($together.Count))"
    Assert-True ($apart.Count -eq 4) "and four calls return four ($($apart.Count))"

    function Get-Fingerprint {
        param($r)
        $ids = @(@($r.findings) | ForEach-Object { [string]$_.id } | Sort-Object) -join ','
        return "state=$($r.state) findings=$($r.findingCount) unreadable=$($r.unreadableCount) examined=$($r.examinedCount) bytes=$($r.totalBytes) ids=$ids"
    }
    foreach ($n in $four) {
        $t = @($together | Where-Object { $_.finder -eq $n })[0]
        $a = @($apart    | Where-Object { $_.finder -eq $n })[0]
        Assert-True (($null -ne $t) -and ($null -ne $a)) "$n reported on both sides"
        if (($null -ne $t) -and ($null -ne $a)) {
            $ft = Get-Fingerprint $t
            $fa = Get-Fingerprint $a
            Assert-True ($ft -eq $fa) "$n gives the identical answer whether it shares the walk or owns it" "shared: $ft`n        alone:  $fa"
        }
    }

    # The negative control for the control. If the fixture produced nothing at
    # all, every comparison above would be 'empty equals empty' and would pass
    # while proving nothing - the vacuous pass this project keeps paying for.
    $totalFindings = 0
    foreach ($r in $together) { $totalFindings += [int]$r.findingCount }
    Assert-True ($totalFindings -gt 0) "the fixture actually produced findings to compare ($totalFindings) - without this the comparison above is empty-equals-empty"
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { 'Red' } else { 'Green' })
if ($script:fail -gt 0) { exit 1 }
