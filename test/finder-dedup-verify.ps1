# Content-hash dedup finder verification (vanish-uninstaller-30i).
#
# duplicate-content is the RESCUE module's dedup finder: group by size first,
# hash only within a size group with more than one member, and never decide
# identity by name or size alone. This suite proves that ordering actually
# happens (not just that the final list looks right) and that the survivor
# manifest -- the load-bearing half, per HANDOFF-2026-08-21 section 4 -- can
# be written, read back, and refuses to lie about what is really on disk.
#
# Assertions 1-4 drive the finder through the real engine subprocess
# (hygiene-scan), the same way every other finder suite does, because a
# dedup bug that only shows up when PowerShell serialises the result across
# a process boundary is exactly the kind of bug an in-process call would
# hide. Assertions 5-6 call Write-SurvivorManifest, Read-SurvivorManifest and
# Assert-RemovalPrecondition directly, in this process, because the finder
# ships audit-only and there is no engine action that exercises them yet --
# they are unit-tested now so the removal path due later has something
# proven to call.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-dedup-verify.ps1

$ErrorActionPreference = "Stop"
$root       = Split-Path -Parent $PSScriptRoot
$scanner    = Join-Path $root "scanner.ps1"
$findersDir = Join-Path $root "finders"

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params = @{})
    $json = $params | ConvertTo-Json -Depth 10 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    # 8ok: stdout is supposed to carry one JSON document and nothing else, but
    # powershell.exe writes the WARNING, VERBOSE and DEBUG streams to STDOUT.
    # Report what actually arrived rather than dying on a raw parser exception
    # with no Result line.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

# Same technique test/security-verify.ps1 uses for its SEC-3 fixture (which
# also has to remove a tree it deliberately locked down): un-protecting an
# ACL alone is not enough once explicit ACEs are on it, so grant this account
# full control back across the whole tree before deleting anything.
#
# The recursive Get-ChildItem pass below is belt-and-suspenders for a run
# that got interrupted before its own Unprotect-Path calls ran (Ctrl-C, a
# crash) and left an explicit Deny ACE from Protect-PathDenyRead on a nested
# item: `icacls $path /T` has to ENUMERATE a directory to recurse past it, and
# enumerating is exactly what that Deny ACE blocks, so icacls fails on
# "...\locked_dir\*: Access is denied" before it ever reaches the grant that
# would fix it -- observed for real during this suite's own development,
# which is why this is not a hypothetical. Stripping Deny ACEs directly with
# Get-Acl/Set-Acl needs no enumeration permission on the item itself (WRITE_DAC
# is not one of the rights this suite ever denies), only the ability to reach
# it from its parent, which Get-ChildItem still can even when it cannot look
# inside it.
function Remove-TestTree {
    param([string]$path)
    if (-not (Test-Path -LiteralPath $path)) { return }

    Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $acl    = Get-Acl -LiteralPath $_.FullName -ErrorAction Stop
            $denies = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny })
            if ($denies.Count -gt 0) {
                foreach ($d in $denies) { $null = $acl.RemoveAccessRule($d) }
                Set-Acl -LiteralPath $_.FullName -AclObject $acl -ErrorAction Stop
            }
        } catch { }
    }

    # try/catch, not bare 2>&1 trust: under $ErrorActionPreference = "Stop", a
    # native executable's stderr line arrives as a terminating NativeCommandError
    # (PowerShell 5.1), and this call is a best-effort safety net, not something
    # that should be able to abort the rest of cleanup if icacls still finds one
    # item to complain about.
    try { $null = & icacls.exe "$path" /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q 2>&1 } catch { }
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
}

# Adds an explicit DENY ace for the CURRENT USER'S OWN SID -- list/read data
# plus read-attributes -- to a file or a directory. An explicit Deny beats
# every Allow that would otherwise apply, including one inherited through
# membership in local Administrators, so this blocks access whether or not
# this suite happens to be running elevated. That is the difference from
# SEC-3's fixture (which restricts an ACL to Admins/System and relies on the
# *tester* not being one of them) -- here the block must hold regardless.
#
# InheritanceFlags/PropagationFlags are always None: FileSecurity.AddAccessRule
# THROWS "No flags can be set" if you pass non-None inheritance flags for a
# plain FILE (only a directory can propagate an ACE to children), and that
# exception, uncaught, meant the rule was silently never added for the file
# fixture -- Set-Acl then just re-persisted the unchanged ACL and the "deny"
# denied nothing. None/None does not need to propagate anywhere for either
# fixture here: blocking LIST/READ on the object itself, with no inheritance,
# is already enough to make Get-ChildItem fail to enumerate a locked directory
# or Get-FileHash fail to open a locked file.
function Protect-PathDenyRead {
    param([Parameter(Mandatory = $true)][string]$Path)
    $sid    = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User
    $acl    = Get-Acl -LiteralPath $Path
    $rights = [System.Security.AccessControl.FileSystemRights]'ListDirectory, ReadData, ReadAttributes'
    $rule   = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid, $rights, [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Reverses Protect-PathDenyRead on exactly the one path it was applied to.
# This has to happen HERE, individually, right after each locked fixture is
# done being used -- not only via Remove-TestTree's final recursive icacls
# sweep over the whole work tree. icacls -T has to ENUMERATE a directory to
# recurse past it, and enumerating a directory is exactly what our own Deny
# ACE blocks: `icacls $work /grant ... /T` walks into case4 and fails with
# "locked_dir\*: Access is denied" trying to list what it cannot yet touch,
# before it ever gets a chance to grant that access back. Removing the Deny
# ACE directly with Get-Acl/Set-Acl needs no enumeration -- it is a single
# object's own DACL, which the owner can always rewrite (WRITE_DAC is not one
# of the rights this suite denies).
function Unprotect-Path {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny })) {
        $null = $acl.RemoveAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# The premise check the brief requires before trusting a "could not read"
# fixture: try the exact operation the finder would try, in THIS process,
# under the SAME account the engine subprocess will run as. If the deny did
# not actually block it -- some accounts and some filesystem configurations
# do not enforce this the same way -- the caller must SKIP, not fail or pass
# on a fixture that never proved its own premise.
function Test-ReadIsBlocked {
    param([Parameter(Mandatory = $true)][string]$Path, [switch]$IsDirectory)
    try {
        if ($IsDirectory) { $null = Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop }
        else              { $null = Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop }
        return $false
    } catch {
        return $true
    }
}

function Get-DedupFinderResult {
    param([string]$fixtureRoot)
    # module: 9caq moved duplicate-content from 'rescue' to 'reclaim' -- the
    # rescue lede is "Nothing here is waste", which a duplicate contradicts.
    # minReclaimBytes 0: these fixtures are a few hundred bytes each, so with
    # the shipped 16 KB fold they would all collapse into the summary row and
    # every assertion below would be about the wrong thing.
    $resp = Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('duplicate-content'); roots = @($fixtureRoot); minReclaimBytes = 0 }
    return @($resp.results | Where-Object { $_.finder -eq 'duplicate-content' })[0]
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish content-hash dedup finder verification (30i)" -ForegroundColor Cyan
Write-Host "===================================================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

$work = Join-Path $env:TEMP "vanish-dedup-verify"
Remove-TestTree $work
$null = New-Item -ItemType Directory -Path $work -Force

try {
    # ==================================================================
    # 1 & 2. Identity is content, never name or size.
    # ==================================================================
    Write-Host ""
    Write-Host "30i.1-2 content decides identity, not name or size" -ForegroundColor Cyan

    $case12 = Join-Path $work "case12"
    $treeA  = Join-Path $case12 "treeA"
    $treeB  = Join-Path $case12 "treeB"
    $null = New-Item -ItemType Directory -Path $treeA -Force
    $null = New-Item -ItemType Directory -Path $treeB -Force

    # A real duplicate: identical bytes, different name, different tree --
    # exactly the phone-backup-export shape from the handoff (a re-exported
    # file rarely keeps its original name).
    $imgA = Join-Path $treeA "IMG_001.jpg"
    $imgB = Join-Path $treeB "backup_IMG_001_copy.jpg"
    Set-Content -LiteralPath $imgA -Value ("A" * 777) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath $imgB -Value ("A" * 777) -Encoding ASCII -NoNewline
    (Get-Item -LiteralPath $imgA).LastWriteTime = (Get-Date).AddDays(-10)
    (Get-Item -LiteralPath $imgB).LastWriteTime = (Get-Date)

    # The trap: same name AND same size, different content. Must never be
    # reported -- this is the entire point of hashing rather than comparing
    # metadata, and it is a different byte count (400) from the pair above
    # (777) so the two fixtures cannot be confused with each other by size.
    $sameNameA = Join-Path $treeA "duplicate_name.dat"
    $sameNameB = Join-Path $treeB "duplicate_name.dat"
    Set-Content -LiteralPath $sameNameA -Value ("B" * 400) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath $sameNameB -Value ("C" * 400) -Encoding ASCII -NoNewline

    $dedup12 = Get-DedupFinderResult -fixtureRoot $case12
    Assert-True ($null -ne $dedup12) "the finder ran and returned a result for case 1/2"
    Assert-True ($dedup12.state -eq 'found') "a genuine content duplicate is reported as 'found'"

    $findings12 = @($dedup12.findings)
    Assert-True ($findings12.Count -eq 1) "exactly one duplicate group is reported (1 expected, $($findings12.Count) found) -- the same-name/same-size pair must not add a second"

    if ($findings12.Count -ge 1) {
        $group = $findings12[0]
        $allPaths = @($group.detail.survivor.path) + @($group.detail.copies | ForEach-Object { $_.path })

        Assert-True ($allPaths -contains $imgA) "the older IMG_001 copy is part of the reported group"
        Assert-True ($allPaths -contains $imgB) "the renamed, newer copy in the other tree is part of the same group"
        Assert-True ($group.detail.survivor.path -eq $imgA) "the survivor is the OLDER file by LastWriteTime, per the documented rule"
        # @() wraps the RESULT of the pipeline, not just its source -- Where-
        # Object collapses a single match to a bare object with no .Count,
        # which reads as $null and silently fails an -eq 1 check without this.
        Assert-True (@($group.detail.copies | Where-Object { $_.path -eq $imgB }).Count -eq 1) "the newer copy is listed as a copy, not silently dropped"

        Assert-True (-not ($allPaths -contains $sameNameA)) "the same-name/same-size file in treeA is NOT in any duplicate group"
        Assert-True (-not ($allPaths -contains $sameNameB)) "neither is its same-size, different-content, same-named twin in treeB"
    } else {
        Assert-True $false "the older IMG_001 copy is part of the reported group"
        Assert-True $false "the renamed, newer copy in the other tree is part of the same group"
        Assert-True $false "the survivor is the OLDER file by LastWriteTime, per the documented rule"
        Assert-True $false "the newer copy is listed as a copy, not silently dropped"
        Assert-True $false "the same-name/same-size file in treeA is NOT in any duplicate group"
        Assert-True $false "neither is its same-size, different-content, same-named twin in treeB"
    }

    # ==================================================================
    # 3. Size-grouping actually short-circuits -- a size-unique file is
    #    NEVER opened for hashing, proved by making it genuinely unreadable
    #    and showing the run never notices.
    # ==================================================================
    Write-Host ""
    Write-Host "30i.3 a file with a unique size is never hashed" -ForegroundColor Cyan

    $case3 = Join-Path $work "case3"
    $null = New-Item -ItemType Directory -Path $case3 -Force
    $soloFile   = Join-Path $case3 "solo.txt"
    $lockedFile = Join-Path $case3 "locked-unique-size.bin"
    Set-Content -LiteralPath $soloFile   -Value ("S" * 123) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath $lockedFile -Value ("L" * 999) -Encoding ASCII -NoNewline

    $premise3Failed = $false
    try { Protect-PathDenyRead -Path $lockedFile }
    catch { $premise3Failed = $true }

    if (-not $premise3Failed -and -not (Test-ReadIsBlocked -Path $lockedFile)) {
        $premise3Failed = $true
    }

    if ($premise3Failed) {
        Write-Host "  SKIP  could not construct a genuinely unreadable file on this account/filesystem (a Deny ACE for our own SID did not block Get-FileHash) -- the short-circuit cannot be proven this way here" -ForegroundColor Yellow
    } else {
        $dedup3 = Get-DedupFinderResult -fixtureRoot $case3
        Assert-True ($null -ne $dedup3) "the finder ran and returned a result for case 3"
        Assert-True ($dedup3.unreadableCount -eq 0) "the size-unique locked file is never opened, so it is never marked unreadable (if the naive hash-everything approach ran, this would be 1)"
        Assert-True ($dedup3.complete -eq $true) "the run is complete -- nothing was skipped that should have been looked at"
        Assert-True ($dedup3.state -eq 'nothing') "no duplicates exist in this tree, and the locked file did not get miscounted as one"
    }
    Unprotect-Path -Path $lockedFile

    # ==================================================================
    # 4. A tree that could not be fully examined is 'could-not-look', never
    #    'nothing', even when it holds no duplicates at all.
    # ==================================================================
    Write-Host ""
    Write-Host "30i.4 an unreadable subtree yields could-not-look, never nothing" -ForegroundColor Cyan

    $case4      = Join-Path $work "case4"
    $lockedDir  = Join-Path $case4 "locked_dir"
    $null = New-Item -ItemType Directory -Path $case4 -Force
    $null = New-Item -ItemType Directory -Path $lockedDir -Force
    Set-Content -LiteralPath (Join-Path $lockedDir "inside.txt") -Value "cannot see this" -Encoding ASCII -NoNewline

    $premise4Failed = $false
    try { Protect-PathDenyRead -Path $lockedDir }
    catch { $premise4Failed = $true }

    if (-not $premise4Failed -and -not (Test-ReadIsBlocked -Path $lockedDir -IsDirectory)) {
        $premise4Failed = $true
    }

    if ($premise4Failed) {
        Write-Host "  SKIP  could not construct a genuinely unreadable directory on this account/filesystem (a Deny ACE for our own SID did not block Get-ChildItem) -- could-not-look cannot be proven this way here" -ForegroundColor Yellow
    } else {
        $dedup4 = Get-DedupFinderResult -fixtureRoot $case4
        Assert-True ($null -ne $dedup4) "the finder ran and returned a result for case 4"
        Assert-True ($dedup4.findingCount -eq 0) "no duplicate group was found -- there is nothing in this tree that could form one"
        Assert-True ($dedup4.unreadableCount -ge 1) "the inaccessible subtree is recorded, not silently skipped"
        Assert-True ($dedup4.state -eq 'could-not-look') "the state is 'could-not-look', never 'nothing' -- an unreadable subtree has not established the tree is duplicate-free"
    }
    Unprotect-Path -Path $lockedDir

    # ==================================================================
    # 5. The survivor manifest round-trips.
    # ==================================================================
    Write-Host ""
    Write-Host "30i.5 the survivor manifest writes and reads back intact" -ForegroundColor Cyan

    # Loaded directly, in THIS process, in the same order scanner.ps1 loads
    # them (_contract, _never-touch, _loader, then the finder file itself --
    # the finder registers itself with Register-Finder at dot-source time,
    # which only exists once _loader.ps1 has run). This is not a shortcut
    # around the engine boundary: Write-SurvivorManifest and Assert-
    # RemovalPrecondition have no engine action yet, because the finder ships
    # audit-only and nothing calls them for real. They are unit-tested here
    # so the removal path due later has a proven function to call rather than
    # something to write under pressure.
    . (Join-Path $findersDir "_contract.ps1")
    . (Join-Path $findersDir "_never-touch.ps1")
    . (Join-Path $findersDir "_loader.ps1")
    . (Join-Path $findersDir "duplicate-content.finder.ps1")

    $manifestDir   = Join-Path $work "manifests"
    $survivorFile  = Join-Path $work "manifest-survivor.bin"
    Set-Content -LiteralPath $survivorFile -Value ("Z" * 250) -Encoding ASCII -NoNewline
    $survivorBytes = (Get-Item -LiteralPath $survivorFile).Length
    $survivorHash  = (Get-FileHash -LiteralPath $survivorFile -Algorithm SHA256).Hash

    $group = @{
        hash     = $survivorHash
        survivor = @{ path = $survivorFile; bytes = $survivorBytes }
        removed  = @(
            @{ path = 'D:\fixture\removed-copy-1.bin'; bytes = $survivorBytes }
            @{ path = 'D:\fixture\removed-copy-2.bin'; bytes = $survivorBytes }
        )
    }

    $manifestPath = Write-SurvivorManifest -Group $group -DestinationDirectory $manifestDir
    Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) "Write-SurvivorManifest produces a file"

    $readBack = Read-SurvivorManifest -Path $manifestPath
    Assert-True ($readBack.hash -eq $survivorHash) "the content hash round-trips"
    Assert-True ($readBack.survivor.path -eq $survivorFile) "the survivor's full path round-trips"
    Assert-True ([long]$readBack.survivor.bytes -eq $survivorBytes) "the survivor's size round-trips"
    Assert-True (@($readBack.removed).Count -eq 2) "every removed copy round-trips (2 expected, $(@($readBack.removed).Count) found)"
    # Same @()-around-the-pipeline-RESULT note as above.
    Assert-True (@($readBack.removed | Where-Object { $_.path -eq 'D:\fixture\removed-copy-1.bin' }).Count -eq 1) "a removed copy's path is intact after the round trip"
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$readBack.timestamp)) "a timestamp is recorded, so the manifest answers 'when', not just 'what'"

    # A manifest that cannot name the survivor is not a manifest -- both
    # required-field guards are exercised, not just assumed from the happy path.
    $threwNoHash = $false
    try { Write-SurvivorManifest -Group @{ survivor = @{ path = $survivorFile; bytes = $survivorBytes } } -DestinationDirectory $manifestDir } catch { $threwNoHash = $true }
    Assert-True $threwNoHash "Write-SurvivorManifest refuses a group with no hash"

    $threwNoSurvivor = $false
    try { Write-SurvivorManifest -Group @{ hash = $survivorHash } -DestinationDirectory $manifestDir } catch { $threwNoSurvivor = $true }
    Assert-True $threwNoSurvivor "Write-SurvivorManifest refuses a group with no survivor path"

    # ==================================================================
    # 6. Assert-RemovalPrecondition is a security assertion: it throws
    #    rather than returning a boolean a caller could forget to check.
    # ==================================================================
    Write-Host ""
    Write-Host "30i.6 Assert-RemovalPrecondition refuses a mismatch by throwing" -ForegroundColor Cyan

    $missingSurvivor = Join-Path $work "does-not-exist-$([guid]::NewGuid().ToString('N')).bin"
    $threwMissing = $false
    try { Assert-RemovalPrecondition -survivorPath $missingSurvivor -expectedBytes 100 }
    catch { $threwMissing = $true }
    Assert-True $threwMissing "throws when the survivor does not exist on disk at all"

    $mismatchFile = Join-Path $work "precondition-mismatch.bin"
    Set-Content -LiteralPath $mismatchFile -Value ("Q" * 50) -Encoding ASCII -NoNewline
    $actualBytes = (Get-Item -LiteralPath $mismatchFile).Length

    $threwBytes = $false
    try { Assert-RemovalPrecondition -survivorPath $mismatchFile -expectedBytes ($actualBytes + 1) }
    catch { $threwBytes = $true }
    Assert-True $threwBytes "throws when the survivor's bytes on disk do not match what was expected -- cp && rm is not enough, counts and bytes are compared"

    $threwHash = $false
    try { Assert-RemovalPrecondition -survivorPath $mismatchFile -expectedBytes $actualBytes -expectedSha256 ('0' * 64) }
    catch { $threwHash = $true }
    Assert-True $threwHash "throws when the survivor's hash does not match what was expected -- same size is not same content"

    $correctHash = (Get-FileHash -LiteralPath $mismatchFile -Algorithm SHA256).Hash
    $noThrowOnMatch = $true
    try { Assert-RemovalPrecondition -survivorPath $mismatchFile -expectedBytes $actualBytes -expectedSha256 $correctHash }
    catch { $noThrowOnMatch = $false }
    Assert-True $noThrowOnMatch "and does NOT throw when size and hash both genuinely match -- this is a precondition check, not a check that always fails"
    # ==================================================================
    # 7. The prune list narrows the search - and SAYS SO. (lhf)
    # ==================================================================
    # This finder used to enumerate every file under the root with
    # Get-ChildItem -Recurse. Profiled on a real machine 2026-08-28 it was
    # the only check that could not be measured at all: still running when a
    # 240-second cap stopped it, while the next-slowest finished in 60.
    #
    # It now prunes. Pruning is not free honesty HERE the way it is in the
    # credentials finder: that one asks "is there a credential in this tree",
    # and a credential does not live in node_modules, so nothing true becomes
    # unknown. This finder reports PAIRS, so removing candidates removes real
    # findings - a duplicate spanning a pruned tree will not be reported.
    #
    # That is only acceptable because the prune is DECLARED. Both halves are
    # asserted below, and the second is the one that matters: a scan that
    # quietly stopped looking would pass the first half on its own.
    Write-Host ""
    Write-Host "30i.7 pruning narrows the search, and the narrowing is declared" -ForegroundColor Cyan

    $case7 = Join-Path $work "case7"
    $visible = Join-Path $case7 "src"
    $pruned  = Join-Path (Join-Path $case7 "node_modules") "somepkg"
    $null = New-Item -ItemType Directory -Path $visible -Force
    $null = New-Item -ItemType Directory -Path $pruned -Force

    # One duplicate pair entirely inside the pruned tree, and one entirely
    # outside it. The outside pair proves the finder still works at all -
    # without it, "no findings" would satisfy the first assertion for the
    # wrong reason.
    Set-Content -LiteralPath (Join-Path $pruned "dup1.txt")  -Value ("P" * 512) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $pruned "dup2.txt")  -Value ("P" * 512) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $visible "keep1.txt") -Value ("V" * 640) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $visible "keep2.txt") -Value ("V" * 640) -Encoding ASCII -NoNewline

    $r7 = Get-DedupFinderResult -fixtureRoot $case7
    $allPaths7 = @()
    foreach ($f in @($r7.findings)) {
        # Survivor AND copies. Reading only `copies` would miss the survivor,
        # and in a two-file group exactly one of the pair IS the survivor - so
        # the control leg would have failed while the finder was working.
        $allPaths7 += [string]$f.detail.survivor.path
        foreach ($c in @($f.detail.copies)) { $allPaths7 += [string]$c.path }
    }

    Assert-True (@($allPaths7 | Where-Object { $_ -like "*keep*" }).Count -ge 2) `
        "the pair OUTSIDE the pruned tree is still found - otherwise the next assertion passes for the wrong reason"
    Assert-True (@($allPaths7 | Where-Object { $_ -like "*node_modules*" }).Count -eq 0) `
        "and the pair inside node_modules is NOT reported"

    $notSearched = @($r7.unreadable | Where-Object { $_.reason -eq "not-searched" })
    Assert-True (@($notSearched | Where-Object { $_.path -like "*node_modules*" }).Count -eq 1) `
        "THE ASSERTION THIS BLOCK EXISTS FOR: the pruned directory is named ONCE as not-searched, so a narrowed scan is a stated scope rather than a quiet lie"
    Assert-True (@($notSearched | Where-Object { $_.path -like "*node_modules*" -and $_.detail -match "will not be found" }).Count -eq 1) `
        "and its detail says outright that a duplicate spanning it will be missed"

    # The state has to follow. With no findings at all and something pruned,
    # the answer is could-not-look, never nothing - that is aeu, and it is the
    # reason the prune has to be recorded rather than just documented.
    $case7b = Join-Path $work "case7b"
    $pruned7b = Join-Path (Join-Path $case7b "node_modules") "pkg"
    $null = New-Item -ItemType Directory -Path $pruned7b -Force
    Set-Content -LiteralPath (Join-Path $pruned7b "a.txt") -Value ("Q" * 90) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $pruned7b "b.txt") -Value ("Q" * 90) -Encoding ASCII -NoNewline
    $r7b = Get-DedupFinderResult -fixtureRoot $case7b
    Assert-True (@($r7b.findings).Count -eq 0) "a root whose only duplicates are inside a pruned tree yields no findings"
    Assert-True ($r7b.state -eq "could-not-look") `
        "and its state is could-not-look, NOT nothing - the scan did not look everywhere and refuses to say the tree is clean (got: $($r7b.state))"
}
finally {
    Remove-TestTree $work
}


    # ---- 9caq: small groups are folded into one row, never dropped ---------
    #
    # MEASURED on the operator's machine 2026-09-03: this check returned 4,040
    # findings, 97.5% of everything the whole hygiene panel reported. The
    # distribution decided the fix rather than taste:
    #
    #   total reclaimable       1,268.7 MB across 4,040 groups
    #   top 10 groups             825.1 MB   65.0% of all reclaimable
    #   groups under 16 KB          8.16 MB   0.64%, and 77% of the rows
    #
    # The thing these assertions protect is not the threshold. It is that the
    # ARITHMETIC STILL RECONCILES: listed + folded must equal every group that
    # was actually found, in both count and bytes. A fold that quietly dropped
    # rows would make the panel's own totals a lie, which is worse than the
    # wall of rows it replaced.
    Write-Host ""
    Write-Host "9caq small-group folding" -ForegroundColor Cyan

    $fold = Join-Path $work "fold"
    $null = New-Item -ItemType Directory -Path $fold -Force

    # One BIG pair, well over any sane threshold.
    $bigA = Join-Path $fold "big-a.bin"
    $bigB = Join-Path $fold "big-b.bin"
    Set-Content -LiteralPath $bigA -Value ("Z" * 40000) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath $bigB -Value ("Z" * 40000) -Encoding ASCII -NoNewline

    # Three SMALL pairs, each far under it.
    foreach ($n in 1..3) {
        $sa = Join-Path $fold "small$n-a.dat"
        $sb = Join-Path $fold "small$n-b.dat"
        $content = ("$n" * 300)
        Set-Content -LiteralPath $sa -Value $content -Encoding ASCII -NoNewline
        Set-Content -LiteralPath $sb -Value $content -Encoding ASCII -NoNewline
    }

    # With folding OFF, every group is listed: the premise for what follows.
    $offResp = Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('duplicate-content'); roots = @($fold); minReclaimBytes = 0 }
    $off = @($offResp.results)[0]
    $offGroups = @($off.findings)
    Assert-True ($offGroups.Count -eq 4) "PREMISE: with folding off the fixture yields 4 groups (1 big, 3 small)"
    Assert-True (@($offGroups | Where-Object { $_.detail.summary }).Count -eq 0) "and no summary row exists when nothing was folded"

    # With a threshold between the two sizes, the three small ones collapse.
    $onResp = Invoke-Engine "hygiene-scan" @{ module = 'reclaim'; finders = @('duplicate-content'); roots = @($fold); minReclaimBytes = 10000 }
    $on = @($onResp.results)[0]
    $onGroups = @($on.findings)
    $summary  = @($onGroups | Where-Object { $_.detail.summary })
    $listed   = @($onGroups | Where-Object { -not $_.detail.summary })

    Assert-True ($summary.Count -eq 1)  "above the threshold the small groups collapse into exactly one summary row"
    Assert-True ($listed.Count -eq 1)   "and the big group is still listed individually"
    Assert-True ($summary[0].detail.groupCount -eq 3) "the summary says how many it stands for (3)"

    # THE ASSERTION THIS BLOCK EXISTS FOR: nothing went missing.
    $accountedGroups = $listed.Count + [int]$summary[0].detail.groupCount
    Assert-True ($accountedGroups -eq $offGroups.Count) `
        "THE ARITHMETIC RECONCILES: listed + folded equals every group found with folding off ($accountedGroups vs $($offGroups.Count))"

    $offBytes = 0L; foreach ($g in $offGroups) { $offBytes += [long]$g.detail.reclaimable }
    $onBytes  = 0L; foreach ($g in $onGroups)  { $onBytes  += [long]$g.detail.reclaimable }
    Assert-True ($onBytes -eq $offBytes) `
        "and so do the BYTES - folding moves them into the summary, it does not lose them ($onBytes vs $offBytes)"

    Assert-True ($summary[0].detail.thresholdBytes -eq 10000) "the summary records the threshold that put those groups there"
    Assert-True ($summary[0].evidence -match 'found and counted, not skipped') "and says outright that they were counted rather than skipped"
    Assert-True ($summary[0].costClass -eq 'cheap') "the summary is costClass cheap, like every duplicate - an identical copy exists"

    # The module move.
    Assert-True ($on.module -eq 'reclaim') `
        "duplicate-content reports itself under 'reclaim', not 'rescue' - a duplicate is not what a delete would cost you, which is what rescue's lede promises"

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
