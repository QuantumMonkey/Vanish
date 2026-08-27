# The finder contract (aeu), the never-touch list (4rn) and the loader (vw4).
# Read-only in both tiers.
#
# This suite exists because of five real incidents, not a design preference.
# During the two-day manual cleanup that produced docs/history/HANDOFF-2026-08-21.md,
# the same defect appeared five times in two days:
#
#     A check that cannot distinguish "clean" from "could not read" will
#     happily authorise deleting work.
#
# git ownership errors read as clean; [ -d ] on a case-insensitive filesystem
# reporting renames already done; an unquoted search path silently skipping an
# entire store; $? after a pipe scoring `tail` instead of the command - twice,
# the second immediately before an `rm -rf`; and a permission-denied
# restore-point query reported as "disabled".
#
# So the assertions below are mostly NEGATIVE ones. They do not check that the
# contract can say "could not look"; they check that there is NO WAY to make it
# say "nothing" while holding an unreadable entry. Every finder in this suite
# is built on that guarantee, which means it is worth more than any one of them.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-contract-verify.ps1

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"
$finders = Join-Path $root "finders"

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params = @{})
    $json = $params | ConvertTo-Json -Depth 8 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    # 8ok: stdout carries one JSON document and nothing else, but powershell.exe
    # writes WARNING, VERBOSE and DEBUG to STDOUT - only errors go to stderr.
    # Report what actually arrived rather than dying on a parser exception with
    # no Result line, which is how this suite would otherwise vanish from a run.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

# The contract is also exercised in-process, because the interesting cases -
# a finder file that will not parse, a handler that throws, two files claiming
# one name - cannot be constructed in the shipped finders/ directory without
# breaking the product for everyone else.
. (Join-Path $finders "_contract.ps1")
. (Join-Path $finders "_never-touch.ps1")
. (Join-Path $finders "_loader.ps1")

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("vanish-contract-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    # ==================================================================
    Write-Host ""
    Write-Host "aeu.1 the state is computed from the evidence, through the engine" -ForegroundColor Cyan

    $blind = Invoke-Engine "finder-probe" @{ mode = 'state'; findings = @(); unreadable = @('a', 'b'); examined = 90 }
    Assert-True ($blind.state -eq 'could-not-look') "no findings plus unreadable entries is could-not-look"
    Assert-True ($blind.state -ne 'nothing') "and specifically NOT nothing - this is the single assertion the whole suite rests on"
    Assert-True ($blind.complete -eq $false) "it is marked incomplete"
    Assert-True ($blind.examinedCount -eq 90) "and the 90 locations that WERE readable are not thrown away by that verdict"

    $clean = Invoke-Engine "finder-probe" @{ mode = 'state'; findings = @(); unreadable = @(); examined = 5 }
    Assert-True ($clean.state -eq 'nothing') "no findings and nothing unreadable is nothing"
    Assert-True ($clean.complete -eq $true) "and it is complete, which is the ONLY empty result a decider may treat as clean"

    $found = Invoke-Engine "finder-probe" @{ mode = 'state'; findings = @('x'); unreadable = @(); examined = 5 }
    Assert-True ($found.state -eq 'found') "one finding is found"

    $partial = Invoke-Engine "finder-probe" @{ mode = 'state'; findings = @('x'); unreadable = @('y'); examined = 5 }
    Assert-True ($partial.state -eq 'found') "findings plus unreadable entries is still found"
    Assert-True ($partial.complete -eq $false) "but NOT complete - '3 found' quietly meaning '3 of an unknown number' is the same defect wearing a success badge"

    # ==================================================================
    Write-Host ""
    Write-Host "aeu.1b there is no way to construct the forbidden pair" -ForegroundColor Cyan

    # New-FinderResult takes no state parameter at all. This asserts the
    # absence, because a state parameter with a validation rule can be bypassed
    # by a caller that means well, and an absent parameter cannot.
    $sig = (Get-Command New-FinderResult).Parameters.Keys
    Assert-True (-not ($sig -contains 'state')) "New-FinderResult has no -state parameter, so no finder can assert one"
    Assert-True ($sig -contains 'unreadable') "it takes the evidence instead"

    $r = New-FinderResult -finder 'x' -title 'x' -findings @() -unreadable @((New-Unreadable -path 'p' -reason 'r')) -examined 3
    Assert-True ($r.state -eq 'could-not-look') "and computes could-not-look from that evidence directly"

    # ==================================================================
    Write-Host ""
    Write-Host "aeu.2 a removal proposal without a rebuild cost is refused, not defaulted" -ForegroundColor Cyan

    # HANDOFF-2026-08-21 Module 1 rule 2. A silent default would rank as free,
    # and the cheapest-looking offer would be the one nobody measured.
    $threw = $false
    try { New-Finding -id 'a' -title 'a' -action 'quarantine' | Out-Null } catch { $threw = $true }
    Assert-True $threw "action=quarantine with no rebuildCost throws"

    $threw = $false
    try { New-Finding -id 'a' -title 'a' -action 'audit' | Out-Null } catch { $threw = $true }
    Assert-True (-not $threw) "action=audit does not, because an audit proposes nothing"

    $ok = New-Finding -id 'a' -title 'a' -action 'quarantine' -rebuildCost 'npm install, ~2 min' -costClass 'cheap'
    Assert-True ($ok.rebuildCost -eq 'npm install, ~2 min') "a stated cost is carried through verbatim"
    Assert-True ((New-Finding -id 'b' -title 'b').costClass -eq 'unknown') "and an unstated cost class is 'unknown', which lib/findings.js sorts LAST rather than first"

    # ==================================================================
    Write-Host ""
    Write-Host "aeu.3 a destructive step verifies its precondition by comparison" -ForegroundColor Cyan

    # Constraint 2: "cp && rm is not enough - compare counts and bytes." On the
    # real machine `$?` scored the wrong command twice, the second time
    # immediately before an rm -rf, which is why this compares against the disk
    # rather than trusting an earlier step's exit status.
    $survivor = Join-Path $work "survivor.bin"
    [System.IO.File]::WriteAllBytes($survivor, [byte[]](1, 2, 3, 4, 5, 6, 7, 8))
    $realHash = (Get-FileHash -LiteralPath $survivor -Algorithm SHA256).Hash

    $threw = $false
    try { Assert-RemovalPrecondition -survivorPath (Join-Path $work "gone.bin") -expectedBytes 8 } catch { $threw = $true }
    Assert-True $threw "a survivor that does not exist throws"

    $threw = $false
    try { Assert-RemovalPrecondition -survivorPath $survivor -expectedBytes 9 } catch { $threw = $true }
    Assert-True $threw "a survivor of the wrong size throws"

    $threw = $false
    try { Assert-RemovalPrecondition -survivorPath $survivor -expectedBytes 8 -expectedSha256 ("0" * 64) } catch { $threw = $true }
    Assert-True $threw "a survivor whose content differs throws even when the size matches - same size is not same content"

    $threw = $false
    try { Assert-RemovalPrecondition -survivorPath $survivor -expectedBytes 8 -expectedSha256 $realHash } catch { $threw = $true }
    Assert-True (-not $threw) "and a survivor that genuinely matches passes"

    # ==================================================================
    Write-Host ""
    Write-Host "4rn.1 never-touch refuses by name, with a reason" -ForegroundColor Cyan

    $inet = Invoke-Engine "finder-probe" @{ mode = 'never-touch'; path = 'C:\inetpub' }
    Assert-True ($inet.neverTouch -eq $true) "C:\inetpub is never-touch"
    Assert-True ($inet.reason -match 'CVE-2025-21204') "and the reason names the CVE it mitigates rather than saying 'protected'"

    $under = Invoke-Engine "finder-probe" @{ mode = 'never-touch'; path = 'C:\inetpub\wwwroot\logs' }
    Assert-True ($under.neverTouch -eq $true) "so is anything beneath it - gutting the directory defeats the mitigation just as surely"

    $normal = Invoke-Engine "finder-probe" @{ mode = 'never-touch'; path = 'C:\Program Files\Something' }
    Assert-True ($normal.neverTouch -eq $false) "an ordinary path is not"
    Assert-True ((Test-NeverTouchPath 'C:\INETPUB') -ne $null) "and the match is case-insensitive, because Windows paths are"

    # ==================================================================
    Write-Host ""
    Write-Host "4rn.2 two installs sharing a name are never auto-flagged as redundant" -ForegroundColor Cyan

    # The Antigravity case: an agentic IDE and a VS Code fork, same display
    # name, both wanted, one required to install BMAD. The fact that decides it
    # is "does the operator use both", and that fact is not on the disk.
    $identical = Test-SameNameInstallsRedundant -a @{ version = '1.0'; installLocation = 'C:\A' } -b @{ version = '1.0'; installLocation = 'C:\A' }
    Assert-True ($identical.verdict -eq 'needs-confirmation') "even byte-identical metadata yields needs-confirmation"
    Assert-True ($identical.verdict -ne 'redundant') "there is no code path that returns 'redundant' - Antigravity regression"

    $differing = Test-SameNameInstallsRedundant -a @{ version = '1.0'; installLocation = 'C:\A' } -b @{ version = '2.0'; installLocation = 'C:\B' }
    Assert-True ($differing.verdict -eq 'needs-confirmation') "and so does differing metadata"
    Assert-True (@($differing.evidence).Count -ge 2) "with the evidence a human needs to answer, not just a verdict"
    Assert-True (($differing.evidence -join ' ') -match 'BMAD|deliberate') "including why this rule exists"

    # ==================================================================
    Write-Host ""
    Write-Host "4rn.3 a toolchain with consumers is not orphaned" -ForegroundColor Cyan

    # The Flutter SDK looked orphaned and was not - SplitSmart is a Flutter app.
    $withConsumer = Join-Path $work "consumers"
    New-Item -ItemType Directory -Path (Join-Path $withConsumer "splitsmart") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $withConsumer "splitsmart\pubspec.yaml") -Value "name: splitsmart" -Encoding ASCII

    $consumers = Invoke-Engine "finder-probe" @{ mode = 'consumers'; markers = @('pubspec.yaml'); roots = @($withConsumer) }
    Assert-True ($consumers.state -eq 'found') "a pubspec.yaml under the search root proves the toolchain is load-bearing"
    Assert-True (@($consumers.findings).Count -eq 1) "and names the project that would break"

    $noConsumer = Join-Path $work "empty-consumers"
    New-Item -ItemType Directory -Path $noConsumer -Force | Out-Null
    $none = Invoke-Engine "finder-probe" @{ mode = 'consumers'; markers = @('pubspec.yaml'); roots = @($noConsumer) }
    Assert-True ($none.state -eq 'nothing') "a genuinely empty readable root is 'nothing'"

    $missing = Invoke-Engine "finder-probe" @{ mode = 'consumers'; markers = @('pubspec.yaml'); roots = @((Join-Path $work "does-not-exist")) }
    Assert-True ($missing.state -eq 'could-not-look') "a root that does not exist is could-not-look, NOT an absence of consumers"
    Assert-True (@($missing.unreadable)[0].reason -eq 'root-missing') "and says which, so the operator can fix the root rather than trust the answer"

    # ==================================================================
    Write-Host ""
    Write-Host "vw4.1 a finder is a file, and a broken one is visible" -ForegroundColor Cyan

    $good = Join-Path $work "good-finders"
    New-Item -ItemType Directory -Path $good -Force | Out-Null
    Set-Content -Encoding ASCII -LiteralPath (Join-Path $good "alpha.finder.ps1") -Value @'
Register-Finder -name 'alpha' -title 'Alpha' -module 'hygiene' -handler {
    param($p)
    New-FinderResult -finder 'alpha' -title 'Alpha' -findings @((New-Finding -id 'a1' -title 'one')) -examined 1
}
'@
    Set-Content -Encoding ASCII -LiteralPath (Join-Path $good "boom.finder.ps1") -Value @'
Register-Finder -name 'boom' -title 'Boom' -module 'hygiene' -handler {
    param($p)
    throw 'the check itself fell over'
}
'@

    $load = Import-Finders -directory $good -Force
    Assert-True (@($load.loaded).Count -eq 2) "both finder files loaded from a directory scanner.ps1 never names"
    Assert-True (@($load.loadErrors).Count -eq 0) "with no load errors"

    $scan = Invoke-HygieneScan -p @{ finderDir = $good; finders = @('alpha') }
    Assert-True (@($scan.results).Count -eq 1) "the registry can be filtered to one finder"
    Assert-True (@($scan.results)[0].state -eq 'found') "which runs and reports through the contract"
    Assert-True (@($scan.results)[0].module -eq 'hygiene') "carrying the module it belongs to"

    $crash = Invoke-HygieneScan -p @{ finderDir = $good; finders = @('boom') }
    Assert-True (@($crash.results)[0].state -eq 'could-not-look') "a finder that THROWS is could-not-look, never a clean machine"
    Assert-True (@($crash.results)[0].state -ne 'nothing') "which is the failure mode aeu did not anticipate and this guards anyway"
    Assert-True ((@($crash.results)[0].unreadable)[0].detail -match 'fell over') "and the exception travels with it, so the next trip is not needed to find out why"

    $missingFinder = Invoke-HygieneScan -p @{ finderDir = $good; finders = @('never-registered') }
    Assert-True (@($missingFinder.results).Count -eq 0) "asking for a finder that does not exist runs nothing"
    Assert-True ($missingFinder.finderCount -eq 0) "and says so in the count rather than reporting a clean result"

    # ==================================================================
    Write-Host ""
    Write-Host "vw4.2 a file that will not parse is named, and does not take the run down" -ForegroundColor Cyan

    $mixed = Join-Path $work "mixed-finders"
    New-Item -ItemType Directory -Path $mixed -Force | Out-Null
    Set-Content -Encoding ASCII -LiteralPath (Join-Path $mixed "aaa-fine.finder.ps1") -Value @'
Register-Finder -name 'fine' -title 'Fine' -module 'hygiene' -handler {
    param($p)
    New-FinderResult -finder 'fine' -title 'Fine' -findings @() -examined 1
}
'@
    Set-Content -Encoding ASCII -LiteralPath (Join-Path $mixed "zzz-broken.finder.ps1") -Value "this is not { valid powershell ("

    $mixedLoad = Import-Finders -directory $mixed -Force
    Assert-True (@($mixedLoad.loaded) -contains 'aaa-fine.finder.ps1') "the good file still loads"
    Assert-True (@($mixedLoad.loadErrors).Count -eq 1) "and the broken one is reported as a load error rather than silently absent"
    Assert-True (@($mixedLoad.loadErrors)[0].path -match 'zzz-broken') "naming the file - a run quietly containing nineteen of twenty checks must say so"

    $gone = Import-Finders -directory (Join-Path $work "no-such-dir") -Force
    Assert-True (@($gone.loadErrors).Count -eq 1) "a missing finders directory is a load error, not an empty suite"

    # ==================================================================
    Write-Host ""
    Write-Host "vw4.3 two files cannot quietly claim one check" -ForegroundColor Cyan

    $dupes = Join-Path $work "dupe-finders"
    New-Item -ItemType Directory -Path $dupes -Force | Out-Null
    foreach ($n in @('one', 'two')) {
        Set-Content -Encoding ASCII -LiteralPath (Join-Path $dupes "$n.finder.ps1") -Value @'
Register-Finder -name 'collide' -title 'Collide' -module 'hygiene' -handler {
    param($p)
    New-FinderResult -finder 'collide' -title 'Collide' -findings @() -examined 1
}
'@
    }

    $dupeLoad = Import-Finders -directory $dupes -Force
    Assert-True (@($dupeLoad.loaded).Count -eq 1) "the first file registers"
    Assert-True (@($dupeLoad.loadErrors).Count -eq 1) "the second is refused rather than silently replacing it"
    Assert-True (@($dupeLoad.loadErrors)[0].error -match 'already registered') "because a duplicate name would remove a check while looking like it added one"

    # ==================================================================
    Write-Host ""
    Write-Host "vw4.4 a finder's helper functions must be script-scoped, and the rule is tested" -ForegroundColor Cyan

    # Import-Finders dot-sources each finder file from INSIDE its own function
    # body, and dot-sourcing runs in the caller's scope - which is that
    # function's scope, gone the moment it returns. So a plain top-level
    # `function Name { }` in a finder file exists only during the import.
    #
    # What makes this expensive is that everything in between looks right. The
    # registration survives (Register-Finder writes to $script:FinderRegistry),
    # so the file loads, appears in finder-probe list, and reports no load
    # error. It fails later, when the handler calls the helper - and
    # Invoke-HygieneScan converts that throw into 'could-not-look', so the
    # symptom is "my finder found nothing it could read" on a fixture that
    # obviously has findings. Two layers from the cause.
    #
    # Found while writing the gitignored-unique finder (sgn). Asserted here in
    # both directions so it is a rule with a failing test behind it rather than
    # a comment somebody will read after losing the afternoon.
    $scoped = Join-Path $work "scope-finders"
    New-Item -ItemType Directory -Path $scoped -Force | Out-Null
    Set-Content -Encoding ASCII -LiteralPath (Join-Path $scoped "plain.finder.ps1") -Value @'
function PlainHelper { return 'alive' }
Register-Finder -name 'plain-helper' -title 'Plain' -module 'hygiene' -handler {
    param($p)
    New-FinderResult -finder 'plain-helper' -title 'Plain' -findings @((New-Finding -id (PlainHelper) -title 'x')) -examined 1
}
'@
    Set-Content -Encoding ASCII -LiteralPath (Join-Path $scoped "scoped.finder.ps1") -Value @'
function script:ScopedHelper { return 'alive' }
Register-Finder -name 'scoped-helper' -title 'Scoped' -module 'hygiene' -handler {
    param($p)
    New-FinderResult -finder 'scoped-helper' -title 'Scoped' -findings @((New-Finding -id (ScopedHelper) -title 'x')) -examined 1
}
'@

    Import-Finders -directory $scoped -Force | Out-Null

    $plainRun = Invoke-HygieneScan -p @{ finderDir = $scoped; finders = @('plain-helper') }
    Assert-True (@($plainRun.results)[0].state -eq 'could-not-look') "a plain top-level function is gone by the time the handler runs"
    Assert-True ((@($plainRun.results)[0].unreadable)[0].detail -match 'PlainHelper') "and the failure names the helper, rather than reporting an empty machine"

    $scopedRun = Invoke-HygieneScan -p @{ finderDir = $scoped; finders = @('scoped-helper') }
    Assert-True (@($scopedRun.results)[0].state -eq 'found') "'function script:Name' survives the import and the handler works"

    # The rule, enforced on the shipped files rather than only demonstrated on
    # fixtures. A finder that declares a plain helper passes every other test
    # in this suite and fails in use.
    foreach ($ff in @(Get-ChildItem -LiteralPath $finders -Filter '*.finder.ps1' -File -ErrorAction SilentlyContinue)) {
        $bad = @(Select-String -LiteralPath $ff.FullName -Pattern '^\s*function\s+(?!script:)[A-Za-z]' -AllMatches)
        Assert-True ($bad.Count -eq 0) "$($ff.Name) declares no unscoped top-level helper functions"
        if ($bad.Count -gt 0) {
            foreach ($b in $bad) { Write-Host ("        line " + $b.LineNumber + ": " + $b.Line.Trim()) -ForegroundColor Red }
        }
    }

    # ==================================================================
    Write-Host ""
    Write-Host "vw4.5 the shipped finders directory loads clean" -ForegroundColor Cyan

    $live = Invoke-Engine "finder-probe" @{ mode = 'list' }
    Assert-True ($live.success -eq $true) "the engine can enumerate its own finders"
    Assert-True (@($live.loadErrors).Count -eq 0) "and every shipped finder file parses and registers"
    if (@($live.loadErrors).Count -gt 0) {
        foreach ($e in @($live.loadErrors)) { Write-Host ("        " + $e.path + ": " + $e.error) -ForegroundColor Red }
    }
    foreach ($fd in @($live.finders)) {
        Assert-True ((@('rescue', 'hygiene', 'reclaim') -contains $fd.module)) "finder '$($fd.name)' declares a known module"
    }
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
