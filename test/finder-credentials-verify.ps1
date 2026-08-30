# Local-only credential finder verification (bd vanish-uninstaller-ho2).
#
# Module 3.1 RESCUE: files that exist on disk, are gitignored, and are
# therefore on no remote. The evidence that justifies this finder existing at
# all is in docs/history/HANDOFF-2026-08-21.md section 3 - two keystore
# passwords that existed nowhere else in the world, inside folders a
# delete-and-reclone would have destroyed.
#
# This suite drives the finder through the SAME engine surface a real scan
# uses (hygiene-scan), never by dot-sourcing local-only-credentials.finder.ps1
# directly - a finder that works when called as a function but is wired up
# wrong in Register-Finder or the loader is a finder that never runs for
# real, and that gap is exactly what a probe-only test would miss.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-credentials-verify.ps1

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"

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
    # 8ok: stdout is supposed to carry one JSON document and nothing else, but
    # powershell.exe writes the WARNING, VERBOSE and DEBUG streams to STDOUT -
    # only errors go to stderr. Report what actually arrived rather than dying
    # on a raw parser exception with no Result line.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

function Invoke-CredentialScan {
    param([string[]]$scanRoots)
    $scan = Invoke-Engine "hygiene-scan" @{ module = 'rescue'; finders = @('local-only-credentials'); roots = @($scanRoots) }
    return @($scan.results | Where-Object { $_.finder -eq 'local-only-credentials' })[0]
}

# Mirrors test/security-verify.ps1's Remove-TestTree: the icacls-deny fixture
# below denies THIS account its own cleanup, so ownership/WRITE_DAC (which the
# creating account keeps even after denying itself read/list data) is used to
# grant full control back before anything is deleted.
function Remove-Ho2TestTree {
    param([string]$path)
    if (-not (Test-Path -LiteralPath $path)) { return }
    # icacls writing to stderr for a single file it cannot yet reach mid-walk
    # (the /C flag tells icacls itself to carry on past that) still comes back
    # to PowerShell as an ErrorRecord on this native call, and this script
    # runs under $ErrorActionPreference = "Stop" - so without lowering it here
    # first, that ErrorRecord would abort THIS cleanup, which is the one place
    # that must never throw, or a failed run leaves the next run's own
    # Remove-Ho2TestTree call hitting the identical wall on its very first line.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $null = & icacls.exe "$path" /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q 2>&1
    } catch {
        # Best-effort: if even this fails, Remove-Item below still gets a try.
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish local-only credential finder verification (ho2)" -ForegroundColor Cyan
Write-Host "========================================================"
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

$hasGit = $null -ne (Get-Command git.exe -ErrorAction SilentlyContinue)
if (-not $hasGit) {
    Write-Host "  SKIP  git.exe is not on PATH on this machine - every assertion below needs a real git repository to check ignore status against, so the whole suite cannot run" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor Green
    exit 0
}

# ======================================================================
# Fixtures. A real git repository, built by THIS test with `git init`, never
# vendored - the finder's whole claim rests on agreeing with git's own
# check-ignore, so the fixture has to be a repo git itself will recognise.
# ======================================================================
$work = Join-Path $env:TEMP "vanish-ho2-credentials-verify"
if (Test-Path -LiteralPath $work) { Remove-Ho2TestTree $work }
$null = New-Item -ItemType Directory -Path $work -Force

$secretCanary = "VANISH-HO2-SECRET-CANARY-DO-NOT-LEAK-$([Guid]::NewGuid().ToString('N'))"

try {
    # ------------------------------------------------------------------
    # ho2.1 / ho2.2 - one repo, one gitignored credential, one tracked file
    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "ho2.1/2 - a gitignored credential is found, a tracked file is not" -ForegroundColor Cyan

    $repo1 = Join-Path $work "repo1"
    $null = New-Item -ItemType Directory -Path $repo1 -Force
    & git.exe -C $repo1 init -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git init failed in fixture repo1 (exit $LASTEXITCODE)" }

    Set-Content -LiteralPath (Join-Path $repo1 ".gitignore") -Value "key.properties`n.env.local`n" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $repo1 "key.properties") -Value $secretCanary -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $repo1 ".env.local")    -Value $secretCanary -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $repo1 "README.md")     -Value "Nothing to see here." -Encoding ASCII

    # A THIRD credential-named file that is present but NOT gitignored - a
    # stronger negative than README.md, because it proves the finder is
    # keying off ignore status and not just off the filename. If a remote
    # exists for this repo, this file already reached it; it is exactly the
    # case this finder must stay silent about.
    Set-Content -LiteralPath (Join-Path $repo1 "id_rsa") -Value "not-actually-a-key" -Encoding ASCII

    $r1 = Invoke-CredentialScan -scanRoots @($work)

    Assert-True ($null -ne $r1) "the finder appears in the hygiene-scan results at all"
    Assert-True ($r1.state -eq 'found') "state is 'found' when a gitignored credential exists"
    Assert-True ($r1.complete -eq $true) "and complete is true - nothing was unreadable on this run"

    $foundPaths = @($r1.findings | ForEach-Object { $_.path })
    $keyPropsPath = Join-Path $repo1 "key.properties"
    $envLocalPath = Join-Path $repo1 ".env.local"
    $readmePath   = Join-Path $repo1 "README.md"
    $idRsaPath    = Join-Path $repo1 "id_rsa"

    Assert-True (@($foundPaths | Where-Object { $_ -eq $keyPropsPath }).Count -eq 1) "a gitignored key.properties in a fixture git repo IS found"
    Assert-True (@($foundPaths | Where-Object { $_ -eq $envLocalPath }).Count -eq 1) "a gitignored .env.local is found too - the finder is not single-pattern"
    Assert-True (@($foundPaths | Where-Object { $_ -eq $readmePath }).Count -eq 0)   "a non-gitignored README.md in the same repo is NOT found"
    Assert-True (@($foundPaths | Where-Object { $_ -eq $idRsaPath }).Count -eq 0)    "a credential-NAMED file that is present but NOT gitignored is not found either - name alone is not the test"

    $keyFinding = @($r1.findings | Where-Object { $_.path -eq $keyPropsPath })[0]
    Assert-True ($keyFinding.action -eq 'audit')             "the finding's action is 'audit' - this module ships audit-only"
    Assert-True ($keyFinding.costClass -eq 'irreplaceable')  "costClass is 'irreplaceable' for a local-only credential"
    Assert-True (-not [string]::IsNullOrWhiteSpace($keyFinding.rebuildCost)) "rebuildCost is filled in, not blank"
    Assert-True ($keyFinding.rebuildCost -match 'cannot be regenerated') "and it says plainly that this cannot be regenerated"
    Assert-True ($keyFinding.bytes -gt 0) "a real measured size travels with the finding"

    # ------------------------------------------------------------------
    # ho2.5 - no finding, anywhere in this run, carries file contents
    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "ho2.5 - no finding ever carries file contents" -ForegroundColor Cyan

    $raw = ($r1 | ConvertTo-Json -Depth 12 -Compress)
    Assert-True ($raw -notmatch [regex]::Escape($secretCanary)) "the secret placeholder written into the fixture files never appears anywhere in the finder's output"

    # ------------------------------------------------------------------
    # ho2.4 - a clean repo with no credentials at all yields 'nothing'
    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "ho2.4 - a clean fixture repo yields state 'nothing', complete true" -ForegroundColor Cyan

    $cleanRoot = Join-Path $work "clean-root"
    $cleanRepo = Join-Path $cleanRoot "repoclean"
    $null = New-Item -ItemType Directory -Path $cleanRepo -Force
    & git.exe -C $cleanRepo init -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git init failed in fixture repoclean (exit $LASTEXITCODE)" }
    Set-Content -LiteralPath (Join-Path $cleanRepo "README.md") -Value "Also nothing to see here." -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $cleanRepo "app.config") -Value "no secrets in this one" -Encoding ASCII

    $r4 = Invoke-CredentialScan -scanRoots @($cleanRoot)
    Assert-True ($null -ne $r4)                 "the finder appears in the results for the clean fixture"
    Assert-True ($r4.state -eq 'nothing')        "a clean fixture repo with no credentials yields state 'nothing'"
    Assert-True ($r4.complete -eq $true)         "and complete is true"
    Assert-True ($r4.findingCount -eq 0)         "and there are zero findings"
    Assert-True ($r4.examinedCount -ge 1)        "examinedCount still reports that a repository was actually looked at, not skipped"

    # ------------------------------------------------------------------
    # ho2.3 - a tree that cannot be read yields 'could-not-look', never
    # 'nothing'. This is the aeu assertion the whole finder exists to satisfy:
    # a check that cannot distinguish clean from could-not-read will happily
    # authorise deleting the exact credential it exists to protect.
    #
    # Constructed the same way test/security-verify.ps1's SEC-3 block does -
    # deny this account read/list access with icacls - but the premise is
    # asserted FIRST: if the deny does not actually block this account's own
    # enumeration (elevation, a differently-behaving ACL inheritance chain,
    # a filesystem that ignores the ACE), failing the real assertion below
    # would be failing for the wrong reason, and a pass would be vacuous.
    # ------------------------------------------------------------------
    Write-Host ""
    Write-Host "ho2.3 - a directory that cannot be read yields could-not-look, not nothing" -ForegroundColor Cyan

    $blindRoot = Join-Path $work "blind-root"
    $blindDir  = Join-Path $blindRoot "denied"
    $null = New-Item -ItemType Directory -Path $blindDir -Force
    Set-Content -LiteralPath (Join-Path $blindDir "placeholder.txt") -Value "irrelevant" -Encoding ASCII

    $denyOk = $true
    try {
        $null = & icacls.exe "$blindDir" /inheritance:r 2>&1
        if ($LASTEXITCODE -ne 0) { $denyOk = $false }
        $null = & icacls.exe "$blindDir" /deny "$($env:USERNAME):(RD)" 2>&1
        if ($LASTEXITCODE -ne 0) { $denyOk = $false }
    } catch {
        $denyOk = $false
    }

    # ASSERT THE PREMISE FIRST: does this account's own Get-ChildItem actually
    # fail against the fixture now? Only then is "could-not-look" a fixture
    # this machine can genuinely produce.
    $premiseErr = $null
    $premiseChildren = @(Get-ChildItem -LiteralPath $blindDir -Force -ErrorAction SilentlyContinue -ErrorVariable +premiseErr)
    $trulyBlind = $denyOk -and (@($premiseErr).Count -gt 0)

    if (-not $trulyBlind) {
        Write-Host "  SKIP  could not construct a directory this account genuinely cannot enumerate (icacls /deny did not block this account's own Get-ChildItem, which can happen for an elevated or otherwise privileged session) - the could-not-look path cannot be exercised on this machine" -ForegroundColor Yellow
    } else {
        $r3 = Invoke-CredentialScan -scanRoots @($blindRoot)
        Assert-True ($null -ne $r3)              "the finder appears in the results for the blind fixture"
        Assert-True ($r3.state -eq 'could-not-look') "a tree that cannot be read yields state 'could-not-look'"
        Assert-True ($r3.state -ne 'nothing')     "and specifically never 'nothing' - that pairing is the whole defect aeu exists to make unrepresentable"
        Assert-True ($r3.complete -eq $false)     "complete is false"
        Assert-True ($r3.unreadableCount -gt 0)   "and at least one unreadable entry is recorded"
        $reasons = @($r3.unreadable | ForEach-Object { $_.reason } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        Assert-True ($reasons.Count -gt 0) "and the unreadable entry names an actual reason, not just an empty record"
    }

    # Undo the deny BEFORE the generic recursive cleanup below runs. icacls
    # /grant /T has to enumerate a directory's children to also fix their
    # ACEs, and enumerating $blindDir is exactly the operation still denied
    # at this point - proven by direct repro: the recursive grant call
    # aborted mid-walk on "$blindDir\*" and left the deny in place for the
    # NEXT run to trip over on its very first line. Removing the deny ACE
    # directly on $blindDir needs only WRITE_DAC, which the owner keeps
    # regardless of the RD deny, so it does not have this problem.
    if (Test-Path -LiteralPath $blindDir) {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        try { $null = & icacls.exe "$blindDir" /remove:d "$($env:USERNAME)" 2>&1 } catch {} finally { $ErrorActionPreference = $prevEap }
    }



    # ==================================================================
    Write-Host ""
    Write-Host "A junction is not walked, and the prune list is not routed around (o1mj)" -ForegroundColor Cyan
    # THE DEFECT THIS REPLACES, measured on the operator machine before the fix:
    #   shipped        23,160 ms  15,000 dirs   9 repos  0 candidates  CAPPED
    #   skip reparse    2,958 ms   2,991 dirs  12 repos  4 candidates
    # Read the last column first. Every one of the nine repos it used to find
    # was an alias path reached through My Documents or Local Settings; it
    # missed all five real ones, and it reported ZERO credential files on a
    # machine that has four. Speed was the side effect, not the point.
    #
    # Driven through hygiene-scan like every other case here, not by calling
    # the walker directly: a finder that works as a function and is wired up
    # wrong is a finder that never runs for real.
    $jRoot = Join-Path $work "junctionprobe"
    $jRepo = Join-Path $jRoot "realrepo"
    $null = New-Item -ItemType Directory -Path $jRepo -Force
    Push-Location $jRepo
    try {
        $null = & git.exe init 2>&1
        $null = & git.exe config user.email "t@example.com" 2>&1
        $null = & git.exe config user.name "t" 2>&1
        Set-Content -LiteralPath (Join-Path $jRepo ".gitignore") -Value ".env" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $jRepo ".env") -Value "SECRET=1" -Encoding ASCII
        $null = & git.exe add .gitignore 2>&1
        $null = & git.exe commit -m init 2>&1
    } finally { Pop-Location }

    $aliasParent = Join-Path $jRoot "alias"
    $null = New-Item -ItemType Directory -Path $aliasParent -Force
    $linkPath = Join-Path $aliasParent "link"
    $madeJunction = $false
    $prevEap2 = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $null = & cmd.exe /c mklink /J "$linkPath" "$jRepo" 2>&1
        $madeJunction = Test-Path -LiteralPath $linkPath
    } catch { $madeJunction = $false } finally { $ErrorActionPreference = $prevEap2 }

    if (-not $madeJunction) {
        Write-Skip "junction not created on this machine, so the reparse rule cannot be exercised here"
    } else {
        # The premise. Without it, "found once" could pass because the fixture
        # was only ever reachable once, and would prove nothing at all.
        Assert-True ((Test-Path -LiteralPath (Join-Path $linkPath ".git")) -and (Test-Path -LiteralPath (Join-Path $jRepo ".git"))) `
            "premise: the same repo is reachable by BOTH its real path and a junction"

        $jr = Invoke-CredentialScan -scanRoots @($jRoot)
        $paths = @(@($jr.findings) | ForEach-Object { [string]$_.path })
        $viaLink = @($paths | Where-Object { $_ -like "*$([System.IO.Path]::GetFileName($aliasParent))*" })

        Assert-True (@($paths | Where-Object { $_ -like "*.env" }).Count -eq 1) `
            "the ignored .env is reported ONCE, not once per name that reaches it" `
            "paths: $($paths -join ' | ')"
        Assert-True (@($viaLink).Count -eq 0) `
            "and it is reported at its real path, never through the junction" `
            "via junction: $($viaLink -join ' | ')"

        # The prune list is matched by NAME, so a junction pointing at a pruned
        # directory used to walk straight into it. That is what spent the entire
        # 15,000-directory budget inside AppData on the real machine: AppData is
        # pruned, but Local Settings and Application Data are junctions to it
        # and are not.
        $prunedTarget = Join-Path $jRoot "node_modules"
        $null = New-Item -ItemType Directory -Path (Join-Path $prunedTarget "deep") -Force
        Set-Content -LiteralPath (Join-Path $prunedTarget "deep\.env") -Value "X=1" -Encoding ASCII
        $pruneLink = Join-Path $jRepo "nm-alias"
        $madePruneLink = $false
        $ErrorActionPreference = "SilentlyContinue"
        try {
            $null = & cmd.exe /c mklink /J "$pruneLink" "$prunedTarget" 2>&1
            $madePruneLink = Test-Path -LiteralPath $pruneLink
        } catch { $madePruneLink = $false } finally { $ErrorActionPreference = $prevEap2 }

        if (-not $madePruneLink) {
            Write-Skip "second junction not created, so the prune-bypass case cannot be exercised here"
        } else {
            $jr2 = Invoke-CredentialScan -scanRoots @($jRoot)
            $leaked = @(@($jr2.findings) | ForEach-Object { [string]$_.path } | Where-Object { $_ -like "*nm-alias*" })
            Assert-True (@($leaked).Count -eq 0) `
                "a junction pointing INTO a pruned directory does not carry the walk past the prune list" `
                "leaked: $($leaked -join ' | ')"
        }
    }
}
finally {
    Remove-Ho2TestTree $work
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
