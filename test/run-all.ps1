# Runs every Vanish verification suite and prints one summary.
# Read-only suites run in either tier; the rest need Full Mode and will say so.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1

# pnor: -BothTiers runs the WHOLE suite from one elevated session. Elevation
# does not just add tests, it REMOVES them: an Administrator token reads
# through a Deny ACE, so nine suites cannot build the access-denied condition
# they exist to test and skip it. Either tier alone is a green number about
# less than it claims. With -BothTiers this run does Full Mode itself, then
# re-runs itself de-elevated through a scheduled task at RunLevel Limited and
# reports both halves together.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\run-all.ps1 -BothTiers

param(
    # Run Full Mode here, then the Audit Mode half through a limited token.
    # Requires an elevated shell: the drop only goes downwards.
    [switch]$BothTiers,

    # Internal, set only on the de-elevated child: where to leave its counts
    # for the parent to read. Its presence is also what tells the child to use
    # its own log directory, so it cannot overwrite the parent run mid-flight.
    [string]$TierResultFile = ""
)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 6d7: every suite writes its full output to disk, unconditionally and before
# anything is parsed out of it. The batch run that reported 837 passed / 1
# failed could not be diagnosed at all: the FAIL line scrolled past inside a
# 28-suite run, the Summary block kept only the counts, and re-running the
# suite alone passed 51/0. A failure you cannot name is a failure everyone
# learns to re-run instead of read.
# PER MACHINE, and this is not tidiness - it is a bug that destroyed real
# evidence on 2026-08-19.
#
# test\logs lives INSIDE the repo folder, and Windows Sandbox maps that folder
# read-write from the host. So the sandbox's logs and the host's logs were the
# same files. The sandbox produced ten failures worth diagnosing; a routine
# `npm test` on the host minutes later hit the wipe below and overwrote every
# one of them with its own output - which then read as a set of clean passes and
# nearly sent us chasing a contradiction between the summary and the logs.
#
# Keyed by computer name because that is what actually differs between the host
# and the VM, and the wipe now only clears THIS machine's directory. Two
# machines sharing one checkout can no longer erase each other.
# pnor: the de-elevated child shares this machine name, so without a suffix it
# would hit the wipe below and destroy the parent's logs while the parent was
# still writing them. That is 6d7 again, one process later.
$logDir = Join-Path (Join-Path $PSScriptRoot "logs") $env:COMPUTERNAME
if ($TierResultFile) { $logDir = $logDir + "-audit" }
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Get-ChildItem -LiteralPath $logDir -Filter *.log -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# Stray logs from before the per-machine split, so an old flat set cannot be
# mistaken for this run's.
if (-not $TierResultFile) {
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "logs") -Filter *.log -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " Vanish verification suite" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ("Tier: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode - destructive suites will skip" }))

$suites = @(
    @{ Name = "Vault engine (TASK-01)";        Kind = "ps";       Path = "test\vault-verify.ps1" },
    # The restore destination guard, attacked rather than confirmed. Performs a
    # real elevated write attempt against a throwaway vault, and asserts the
    # undo path still works when the data directory is locked.
    @{ Name = "Restore destination guard";   Kind = "ps";       Path = "test\vault-destination-verify.ps1" },
    @{ Name = "Registry restore guard (dvem)"; Kind = "ps";       Path = "test\vault-registry-integrity-verify.ps1" },
    @{ Name = "Elevation tiers (TASK-04)";     Kind = "electron"; Path = "test/tier-verify.js" },
    @{ Name = "Vault IPC (TASK-02/03)";        Kind = "electron"; Path = "test/vault-ipc-verify.js" },
    @{ Name = "Startup actions IPC (dmu)";     Kind = "electron"; Path = "test/startup-action-ipc-verify.js" },
    @{ Name = "Task Manager + Unlocker (2)";   Kind = "ps";       Path = "test\phase2-verify.ps1" },
    @{ Name = "Switches + restore (3)";        Kind = "ps";       Path = "test\phase3-verify.ps1" },
    @{ Name = "Uninstall queue (TASK-11)";     Kind = "node";     Path = "test/queue-verify.js" },
    @{ Name = "Settings validation";           Kind = "node";     Path = "test/settings-verify.js" },
    @{ Name = "Settings gate + ping (wy7a)"; Kind = "electron"; Path = "test/settings-gate-verify.js" },
    @{ Name = "Store migration (SEC-3)";       Kind = "node";     Path = "test/store-migration-verify.js" },
    @{ Name = "System Clean scans (4)";        Kind = "ps";       Path = "test\phase4-verify.ps1" },
    @{ Name = "System Clean purges (4)";       Kind = "electron"; Path = "test/phase4-ipc-verify.js" },
    @{ Name = "CleanerML reader (7sl)";        Kind = "ps";       Path = "test\cleanerml-verify.ps1" },
    @{ Name = "Clean blind spots (qkgu)";      Kind = "ps";       Path = "test\cleaner-blindspot-verify.ps1" },
    @{ Name = "Clean blind spots UI (qkgu)";   Kind = "electron"; Path = "test/cleaner-blindspot-ui-verify.js" },
    @{ Name = "Install snapshot (zrw)";        Kind = "node";     Path = "test/snapshot-verify.js" },
    @{ Name = "Size attribution (bu2)";        Kind = "node";     Path = "test/attribution-verify.js" },
    @{ Name = "Process attribution (0bi)";    Kind = "node";     Path = "test/process-attribution-verify.js" },
    @{ Name = "Platform uninstalls (8ns)";     Kind = "node";     Path = "test/platforms-verify.js" },
    @{ Name = "Relaunch intent (1dq)";          Kind = "node";     Path = "test/elevation-intent-verify.js" },
    @{ Name = "Icon set";                      Kind = "node";     Path = "test/icon-verify.js" },
    # s4cx: the program icons the engine collects and the renderer draws. The
    # parser is the subject - the first version rejected every Windows path and
    # nothing failed, because answering null for everything is still an answer.
    @{ Name = "Program icons (s4cx)";          Kind = "electron"; Path = "test/icon-extract-verify.js" },
    # A runtime dependency resolved by PATH rather than by require() is invisible
    # to every suite that runs from the source tree. The 0.9.0 build shipped
    # without finders/ and nothing failed, because everything degraded politely.
    @{ Name = "Packaging contract";            Kind = "node";     Path = "test/packaging-verify.js" },
    @{ Name = "Shared runtimes (ht8)";         Kind = "electron"; Path = "test/runtimes-verify.js" },
    @{ Name = "Windows updates (ag0)";         Kind = "electron"; Path = "test/updates-verify.js" },
    @{ Name = "Missing engine (frr)";          Kind = "electron"; Path = "test/engine-missing-verify.js" },
    @{ Name = "Network attribution (bfh.1)";   Kind = "ps";       Path = "test\network-verify.ps1" },
    @{ Name = "Dead refs (7v3/be8/ztl)";       Kind = "ps";       Path = "test\dead-reference-verify.ps1" },
    @{ Name = "Force uninstall (REQ-20)";      Kind = "ps";       Path = "test\force-verify.ps1" },
    @{ Name = "Security regressions";          Kind = "ps";       Path = "test\security-verify.ps1" },
    @{ Name = "Details panel layout (5z5)";    Kind = "electron"; Path = "test/details-panel-layout-verify.js" },
    @{ Name = "Install date provenance (c0y)"; Kind = "electron"; Path = "test/install-date-provenance-verify.js" },
    @{ Name = "Install date sources (mp31)";   Kind = "ps";       Path = "test\install-date-source-verify.ps1" },
    @{ Name = "Install folder sizing (mp31)";  Kind = "electron"; Path = "test/install-size-verify.js" },
    @{ Name = "Install size in the table (mp31)"; Kind = "electron"; Path = "test/install-size-render-verify.js" },
    @{ Name = "Landing panels kept (470o)";    Kind = "electron"; Path = "test/landing-panels-verify.js" },
    @{ Name = "All Programs density (949)"; Kind = "electron"; Path = "test/list-density-verify.js" },
    @{ Name = "System Informer handoff (y1j)"; Kind = "electron"; Path = "test/system-informer-verify.js" },
    @{ Name = "Vault manifest integrity (z71u)"; Kind = "node"; Path = "test/manifest-integrity-verify.js" },
    @{ Name = "Path shape, one rule (lr9d)"; Kind = "electron"; Path = "test/path-shape-verify.js" },
    @{ Name = "Purge summary remedies"; Kind = "electron"; Path = "test/purge-summary-actions-verify.js" },
    @{ Name = "Locked paths remembered (h55)"; Kind = "node";     Path = "test/locked-paths-verify.js" },
    @{ Name = "Locked paths quick-pick (h55)"; Kind = "electron"; Path = "test/locked-paths-ipc-verify.js" },
    @{ Name = "UAC policy lock (qyt)";          Kind = "node";     Path = "test/uac-lock-verify.js" },
    @{ Name = "UAC failure causes (ytv)";      Kind = "node";     Path = "test/uac-cause-verify.js" },
    @{ Name = "GPU payload shape (aaw)";       Kind = "node";     Path = "test/gpu-shape-verify.js" },
    @{ Name = "De-elevation mechanism (9vp)";   Kind = "ps";       Path = "test\deelevation-mechanism-verify.ps1" },
    @{ Name = "Listener panel (ddx)";          Kind = "electron"; Path = "test/listeners-verify.js" },
    @{ Name = "Startup grouping (tda)";        Kind = "electron"; Path = "test/startup-groups-verify.js" },
    # Correctness, not speed: the runspace pool must return the SAME verdicts
    # as the serial path, because a signer name decides what gets folded away
    # as "necessary" rather than shown as actionable.
    @{ Name = "Parallel signatures";           Kind = "ps";       Path = "test\signature-batch-verify.ps1" },
    @{ Name = "Column filters (5b0)";          Kind = "electron"; Path = "test/column-filter-verify.js" },
    @{ Name = "UI interaction";                Kind = "electron"; Path = "test/ui-interaction-verify.js" },
    @{ Name = "Clean All (zl4)";               Kind = "electron-full"; Path = "test/clean-all-verify.js" },
    @{ Name = "UI interaction (Full Mode)";    Kind = "electron-full"; Path = "test/ui-interaction-full-verify.js" },
    # ---- MACHINE-HYGIENE SUITE (HANDOFF-2026-08-21) ----
    # Registered here in one edit, deliberately, BEFORE the finders they cover
    # exist. Six of these were written in parallel; had each author added their
    # own row, this list would have been the one file every one of them touched
    # and the only place they could collide. A suite whose file is missing is
    # reported as NOT RUN, which is the correct and visible answer - the runner
    # names skips and non-runs at the bottom for exactly this reason.
    @{ Name = "Finder contract (aeu/4rn)";     Kind = "ps";       Path = "test\finder-contract-verify.ps1" },
    @{ Name = "Seam decider (5p5)";            Kind = "node";     Path = "test/findings-verify.js" },
    # Repository facts nothing else owns: the version stamped in two files, and
    # every suite registered in this list being on disk. Both drifted silently
    # before this existed, and both were found by a human reading a file.
    @{ Name = "Repo invariants (rkt3/z6k)";    Kind = "node";     Path = "test/repo-invariants-verify.js" },
    @{ Name = "Wizard leftover state (dga)";   Kind = "electron"; Path = "test/wizard-state-verify.js" },
    @{ Name = "Local-only credentials (ho2)";  Kind = "ps";       Path = "test\finder-credentials-verify.ps1" },
    @{ Name = "Gitignored-and-unique (sgn)";   Kind = "ps";       Path = "test\finder-gitignored-verify.ps1" },
    @{ Name = "Content-hash dedup (30i)";      Kind = "ps";       Path = "test\finder-dedup-verify.ps1" },
    @{ Name = "Machine hygiene (pko)";         Kind = "ps";       Path = "test\finder-hygiene-verify.ps1" },
    @{ Name = "Reclaim by marker (piu)";       Kind = "ps";       Path = "test\finder-reclaim-verify.ps1" },
    @{ Name = "Hygiene report (z22)";          Kind = "node";     Path = "test/hygiene-report-verify.js" },
    @{ Name = "Shared sizer (lhf)";           Kind = "ps";       Path = "test\finder-sizer-verify.ps1" },
    @{ Name = "Shared tree walk (3l8, lxl, e6gn)";        Kind = "ps";       Path = "test\shared-walk-verify.ps1" },
    @{ Name = "Walker invariants (no alias paths)"; Kind = "ps"; Path = "test\walker-invariants-verify.ps1" },
    @{ Name = "Hygiene panel (5p5 UI)";        Kind = "electron"; Path = "test/hygiene-panel-verify.js" },
    @{ Name = "Settings lock (mp4)";           Kind = "electron"; Path = "test/settings-lock-verify.js" },
    # Needs an ELEVATED shell: only an elevated token can take ownership or
    # re-secure a directory, so unelevated it skips with the reason named
    # rather than passing vacuously. Carries its own negative control - it
    # reproduces isp with the fix off before asserting the fix defeats it.
    @{ Name = "Data-dir ownership (isp)";      Kind = "node";     Path = "test/data-dir-ownership-verify.js" },
    # Needs an ELEVATED shell to have anything to drop from, and asserts that
    # premise first - on an unelevated run it skips with the reason rather than
    # passing vacuously. Last in the list because it registers and removes a
    # scheduled task and starts real processes.
    @{ Name = "Live elevated relaunch (69a)";  Kind = "ps";       Path = "test\sandbox\relaunch-live-probe.ps1" }
)

$results = @()

foreach ($suite in $suites) {
    Write-Host ""
    Write-Host ("--- {0} ---" -f $suite.Name) -ForegroundColor Yellow

    # z6k: a suite file that is NOT THERE and a suite that started and died are
    # two different problems wanting two different responses -- "your working
    # tree is missing a tracked file" against "go read the log" -- and until now
    # both printed the same line, which led with "needs Full Mode" and so
    # actively proposed the wrong one first. When phase2-verify.ps1 was
    # quarantined out from under the runner on 2026-08-27 that cost two hours.
    # Test-Path is one call and it separates the two states permanently.
    if (-not (Test-Path -LiteralPath $suite.Path)) {
        $results += @{ Name = $suite.Name; Passed = 0; Failed = 0; Ran = $false; Missing = $true; Path = $suite.Path; FailLines = @(); WarnLines = @(); SkipLines = @(); Log = $null }
        Write-Host ("  SUITE FILE MISSING: {0}" -f $suite.Path) -ForegroundColor Red
        Write-Host ("  Nothing ran, and this is a working-tree problem rather than a test") -ForegroundColor DarkYellow
        Write-Host ("  result: the file is registered in run-all.ps1 but is not on disk.") -ForegroundColor DarkYellow
        continue
    }

    $output = switch ($suite.Kind) {
        "ps"       { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $suite.Path 2>&1 }
        "node"     { & node $suite.Path 2>&1 }
        "electron" { & ".\node_modules\.bin\electron.cmd" $suite.Path 2>&1 }
        # Fixture-simulated Full Mode (VANISH_STUB_TIER), independent of whether
        # THIS process is actually elevated - runs in either tier.
        "electron-full" {
            $env:VANISH_STUB_TIER = "full"
            try { & ".\node_modules\.bin\electron.cmd" $suite.Path 2>&1 }
            finally { Remove-Item Env:\VANISH_STUB_TIER -ErrorAction SilentlyContinue }
        }
    }

    # On disk BEFORE anything is parsed out of it, so a suite that printed its
    # findings and then died still leaves them behind to read.
    $slug    = ((($suite.Name -replace '[^A-Za-z0-9]+', '-').Trim('-'))).ToLower()
    $logPath = Join-Path $logDir ("{0}.log" -f $slug)
    $output | Out-File -FilePath $logPath -Encoding utf8

    $failLines = @($output | Select-String -Pattern '^\s*FAIL\b' | ForEach-Object { $_.Line.Trim() })
    $warnLines = @($output | Select-String -Pattern '^\s*WARN\b' | ForEach-Object { $_.Line.Trim() })
    # A SKIP is not a pass, and until now nothing here said so. The sandbox run
    # of 2026-08-20 finished 1320 passed / 0 failed with the one leg it had been
    # started for - the installer-cache round trip - skipped, because a fresh VM
    # has never installed anything by MSI and the sweep correctly finds nothing.
    # A green total that hides a load-bearing skip is a number about something
    # other than what it claims, which is this codebase's recurring defect.
    $skipLines = @($output | Select-String -Pattern '^\s*SKIP\b' | ForEach-Object { $_.Line.Trim() })

    $summary = ($output | Select-String -Pattern '^Result: (\d+) passed, (\d+) failed' | Select-Object -Last 1)
    if ($summary) {
        $passed = [int]$summary.Matches[0].Groups[1].Value
        $failed = [int]$summary.Matches[0].Groups[2].Value
        $results += @{ Name = $suite.Name; Passed = $passed; Failed = $failed; Ran = $true; FailLines = $failLines; WarnLines = $warnLines; SkipLines = $skipLines; Log = $logPath }
        $colour = if ($failed -gt 0) { "Red" } else { "Green" }
        Write-Host ("  {0} passed, {1} failed" -f $passed, $failed) -ForegroundColor $colour
        foreach ($w in $warnLines) { Write-Host ("  " + $w) -ForegroundColor Yellow }
        foreach ($f in $failLines) { Write-Host ("  " + $f) -ForegroundColor Red }
    } else {
        $results += @{ Name = $suite.Name; Passed = 0; Failed = 0; Ran = $false; FailLines = $failLines; WarnLines = $warnLines; SkipLines = $skipLines; Log = $logPath }
        Write-Host ("  did not report a result (needs Full Mode, or it crashed) - full output: {0}" -f $logPath) -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " Summary" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

$totalPassed = 0
$totalFailed = 0
$missingSuites = @()
foreach ($r in $results) {
    if (-not $r.Ran) {
        if ($r.Missing) {
            Write-Host ("  {0,-32} FILE MISSING  ({1})" -f $r.Name, $r.Path) -ForegroundColor Red
            $missingSuites += $r
        } else {
            Write-Host ("  {0,-32} NOT RUN  (needs Full Mode, or it crashed -- read its log)" -f $r.Name) -ForegroundColor DarkYellow
        }
        continue
    }
    $totalPassed += $r.Passed
    $totalFailed += $r.Failed
    $colour = if ($r.Failed -gt 0) { "Red" } else { "Green" }
    $skipped = if ($r.SkipLines) { @($r.SkipLines).Count } else { 0 }
    $suffix = if ($skipped -gt 0) { "  ({0} skipped)" -f $skipped } else { "" }
    Write-Host ("  {0,-32} {1,3} passed  {2,3} failed{3}" -f $r.Name, $r.Passed, $r.Failed, $suffix) -ForegroundColor $colour
}

Write-Host ""
# pnor: the TOTAL is not a constant, and reading it as one wastes a session.
# Elevation flips WHICH tests can run, in both directions: an elevated shell
# runs the Full Mode suites and CANNOT build an access-denied condition (an
# Administrator token reads through a Deny ACE), so nine suites skip their
# could-not-look assertions. Unelevated is the mirror image.
#
# Measured on one machine, same commit, hours apart:
#   Full Mode   2047 passed
#   Audit Mode  1830 passed
#
# Neither is the whole suite. The tier and the skip count go on the TOTAL
# line so a number can never be compared against one from the other tier
# without the difference being visible in the same breath.
$totalSkipped = 0
foreach ($r in $results) { if ($r.SkipLines) { $totalSkipped += @($r.SkipLines).Count } }
$tierLabel = if ($isAdmin) { "Full Mode" } else { "Audit Mode" }
Write-Host ("  TOTAL: {0} passed, {1} failed, {2} skipped   [{3}]" -f $totalPassed, $totalFailed, $totalSkipped, $tierLabel) -ForegroundColor $(if ($totalFailed -gt 0) { "Red" } else { "Green" })
Write-Host ("  This is one half of the suite. Run it again {0} to cover the other half," -f $(if ($isAdmin) { "WITHOUT elevation" } else { "ELEVATED" })) -ForegroundColor DarkGray
Write-Host ("  and do not compare this total against one taken in the other tier.") -ForegroundColor DarkGray

# 686 / pnor: A SUITE THAT QUIETLY ASSERTS LESS.
#
# The tier line above makes the ELEVATION axis visible. It does nothing for
# the other way a total moves without meaning anything: a suite that cannot
# run an assertion and simply does not run it, recording no skip. Measured
# twice on one machine in one afternoon, same commit, same tier:
#
#   GPU payload shape (aaw)   14 passed, 0 failed   then   10 passed, 0 failed
#
# No skip line either time. Four assertions vanished and the run was green.
# The only evidence was the number, and nothing was checking the number.
#
# So it is checked here: each suite reports passed + failed + skipped, and
# that total is compared against the last run ON THIS MACHINE IN THIS TIER.
# A DROP is reported. It is advisory and never fails the run - a suite may
# legitimately shrink when tests are deleted - but it can no longer happen
# without being said out loud, which is the whole complaint.
$baselineDir  = Join-Path $root ("test" + [char]92 + "logs" + [char]92 + $env:COMPUTERNAME)
$baselineFile = Join-Path $baselineDir ("assertion-baseline-" + $tierLabel.Replace(" ", "-") + ".json")
$previous = @{}
if (Test-Path -LiteralPath $baselineFile) {
    try {
        $raw = Get-Content -LiteralPath $baselineFile -Raw | ConvertFrom-Json
        foreach ($p in $raw.PSObject.Properties) { $previous[$p.Name] = [int]$p.Value }
    } catch { $previous = @{} }
}

$current = @{}
foreach ($r in $results) {
    if ($null -eq $r.Passed) { continue }
    $sk = if ($r.SkipLines) { @($r.SkipLines).Count } else { 0 }
    $current[$r.Name] = [int]$r.Passed + [int]$r.Failed + [int]$sk
}

$shrunk = @()
foreach ($name in $current.Keys) {
    if (-not $previous.ContainsKey($name)) { continue }
    if ($current[$name] -lt $previous[$name]) {
        $shrunk += ("{0}: {1} -> {2}" -f $name, $previous[$name], $current[$name])
    }
}
if ($shrunk.Count -gt 0) {
    Write-Host ""
    Write-Host " Suites that ran FEWER assertions than last time in this tier" -ForegroundColor Yellow
    Write-Host " ------------------------------------------------------------" -ForegroundColor Yellow
    foreach ($line in $shrunk) { Write-Host ("      " + $line) -ForegroundColor Yellow }
    Write-Host "      Not a failure. Either tests were deleted, or a suite skipped" -ForegroundColor DarkGray
    Write-Host "      an assertion without recording a skip - and only the second" -ForegroundColor DarkGray
    Write-Host "      one is a bug (bd vanish-uninstaller-686)." -ForegroundColor DarkGray
}

try {
    if (-not (Test-Path -LiteralPath $baselineDir)) { $null = New-Item -ItemType Directory -Path $baselineDir -Force }
    # NO BOM. PowerShell 5.1 Set-Content -Encoding UTF8 writes one, and this
    # file is meant to be readable by anything - a BOM makes JSON.parse throw
    # in node and is the same trap the .wsb generator documents.
    [System.IO.File]::WriteAllText($baselineFile, ($current | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding $false))
} catch { }

# 6d7: the counts alone are not a finding. A batch run that reports one
# failure out of 838 has to name WHICH assertion, here, at the bottom, where
# the reader already is - not 3000 scrolled lines up.
$withFailures = @($results | Where-Object { $_.FailLines -and $_.FailLines.Count -gt 0 })
if ($withFailures.Count -gt 0) {
    Write-Host ""
    Write-Host " Failures, named" -ForegroundColor Red
    Write-Host " ---------------" -ForegroundColor Red
    foreach ($r in $withFailures) {
        Write-Host ("  {0}" -f $r.Name) -ForegroundColor Red
        foreach ($f in $r.FailLines) { Write-Host ("      " + $f) -ForegroundColor Red }
        Write-Host ("      full output: {0}" -f $r.Log) -ForegroundColor DarkGray
    }
}

# Named, in full, at the bottom where the reader already is - for the same
# reason failures are. "43 passed, 0 failed" on a suite whose central leg did
# not run is the most expensive kind of green there is.
$withSkips = @($results | Where-Object { $_.SkipLines -and $_.SkipLines.Count -gt 0 })
if ($withSkips.Count -gt 0) {
    Write-Host ""
    Write-Host " Skipped, named (these did NOT run - they are not passes)" -ForegroundColor DarkYellow
    Write-Host " --------------------------------------------------------" -ForegroundColor DarkYellow
    foreach ($r in $withSkips) {
        Write-Host ("  {0}" -f $r.Name) -ForegroundColor DarkYellow
        foreach ($k in $r.SkipLines) { Write-Host ("      " + $k) -ForegroundColor DarkYellow }
    }
}

$withWarnings = @($results | Where-Object { $_.WarnLines -and $_.WarnLines.Count -gt 0 })
if ($withWarnings.Count -gt 0) {
    Write-Host ""
    Write-Host " Warnings (not failures)" -ForegroundColor Yellow
    foreach ($r in $withWarnings) {
        foreach ($w in $r.WarnLines) { Write-Host ("  {0}: {1}" -f $r.Name, $w) -ForegroundColor Yellow }
    }
}

# z6k: a missing suite file exits NON-ZERO even though nothing failed. The
# alternative is a green exit code on a run that silently tested less than the
# registered suite list says it does, which is the same defect as an unnamed
# skip and is worse for being invisible to CI.
if ($missingSuites.Count -gt 0) {
    Write-Host ""
    Write-Host " Suite files MISSING from the working tree" -ForegroundColor Red
    Write-Host " -----------------------------------------" -ForegroundColor Red
    foreach ($r in $missingSuites) { Write-Host ("  {0,-32} {1}" -f $r.Name, $r.Path) -ForegroundColor Red }
    Write-Host ("  These are registered in run-all.ps1 and are not on disk. Nothing ran for") -ForegroundColor Red
    Write-Host ("  them, so the TOTAL above is missing their assertions entirely.") -ForegroundColor Red
}

Write-Host ""
Write-Host ("Every suite's full output: {0}" -f $logDir) -ForegroundColor DarkGray
Write-Host "Rule 10 reminder: passing here is 'In Progress', not 'Complete'." -ForegroundColor DarkGray
Write-Host "Complete requires a real run of anything that elevates, deletes or restores." -ForegroundColor DarkGray

$exitCode = [int](($totalFailed -gt 0) -or ($missingSuites.Count -gt 0))

# ---------------------------------------------------------------------------
# pnor: the de-elevated child hands its counts back and stops here.
# ---------------------------------------------------------------------------
if ($TierResultFile) {
    $payload = [ordered]@{
        tier      = $tierLabel
        isAdmin   = $isAdmin
        passed    = $totalPassed
        failed    = $totalFailed
        skipped   = $totalSkipped
        missing   = $missingSuites.Count
        exitCode  = $exitCode
        logDir    = $logDir
        failNames = @($withFailures | ForEach-Object { $_.Name })
        # The de-elevated child runs inside a scheduled task, which has no
        # console: every Write-Host above goes nowhere. The assertion-count
        # guard measured this exact defect on itself -- it correctly caught
        # repo-invariants dropping 8 -> 6 in the Audit tier, printed the
        # warning to a console that does not exist, and then overwrote the
        # baseline, so the next run had nothing left to compare against. A
        # guard whose output is discarded is not a guard.
        shrunk    = @($shrunk)
        skipNames = @($withSkips | ForEach-Object { $_.Name })
    }
    # ASCII and BOM-free: the parent reads this with ConvertFrom-Json, and a
    # BOM has broken exactly this kind of handoff in this repo before.
    [System.IO.File]::WriteAllText($TierResultFile, ($payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
    exit $exitCode
}

# ---------------------------------------------------------------------------
# pnor: run the OTHER half from this same session.
# ---------------------------------------------------------------------------
#
# The drop uses a scheduled task at RunLevel Limited, not runas.exe. That is
# measured, not chosen: test/deelevation-probe.ps1 found runas /trustlevel
# exits 1 here, CreateProcessWithTokenW on the explorer token dies 0xc0000142,
# and only the scheduled task actually lands at Medium Mandatory Level. The
# same mechanism is what scanner.ps1 ships for Audit Mode relaunch, so this
# exercises the product's own de-elevation path as a side effect.
#
# The child's own isAdmin is checked rather than assumed. With UAC disabled
# (EnableLUA=0, which is what Windows Sandbox ships) there is no standard-user
# token to drop to and RunLevel Limited comes back elevated. Reporting that as
# "both halves covered" would be the exact defect this whole project is about,
# so it is reported as a half that COULD NOT RUN, with the reason.
if ($BothTiers) {
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Cyan
    Write-Host " Other half: Audit Mode" -ForegroundColor Cyan
    Write-Host "=======================================" -ForegroundColor Cyan

    if (-not $isAdmin) {
        Write-Host "  COULD NOT RUN. This shell is already unelevated, and the drop only goes" -ForegroundColor DarkYellow
        Write-Host "  downwards. Obtaining Full Mode from here needs a UAC prompt, which is a" -ForegroundColor DarkYellow
        Write-Host "  person rather than a switch. Start an elevated shell and use -BothTiers there." -ForegroundColor DarkYellow
        Write-Host ""
        Write-Host ("  COMBINED: not available. This is the Audit Mode half only ({0} passed)." -f $totalPassed) -ForegroundColor DarkYellow
    } else {
        $taskName   = "VanishSuiteAuditHalf"
        $resultFile = Join-Path $env:TEMP ("vanish-audit-half-{0}.json" -f $PID)
        if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }

        $selfPath = Join-Path $PSScriptRoot "run-all.ps1"
        $childOk  = $false
        $child    = $null
        $whyNot   = $null

        try {
            $argLine = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -TierResultFile "{1}"' -f $selfPath, $resultFile)
            $action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine -WorkingDirectory $root

            $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited

            # Zero means UNLIMITED. The default is 72 hours, but the suite has
            # run over an hour on a cold machine and a task killed mid-run would
            # report a partial total as a real one.
            $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

            Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null

            Write-Host "  Registered a scheduled task at RunLevel Limited and started it." -ForegroundColor DarkGray
            Write-Host "  The de-elevated half runs in the background; this waits for its counts." -ForegroundColor DarkGray

            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

            # Evidence that it FINISHED is the file appearing, not the task
            # state going Ready. A task that failed to start reads Ready too,
            # and 1dq is the whole lesson about trusting that.
            $deadline = (Get-Date).AddMinutes(90)
            while ((Get-Date) -lt $deadline) {
                if (Test-Path -LiteralPath $resultFile) { Start-Sleep -Milliseconds 400; break }
                Start-Sleep -Seconds 5
            }

            if (Test-Path -LiteralPath $resultFile) {
                $child   = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
                $childOk = $true
            } else {
                $info   = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
                $whyNot = ("the de-elevated half left no result file within 90 minutes (last task result: {0})" -f $(if ($info) { $info.LastTaskResult } else { "unknown" }))
            }
        } catch {
            $whyNot = ("the scheduled task could not be registered or started: {0}" -f $_.Exception.Message)
        } finally {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue }
        }

        if (-not $childOk) {
            Write-Host ("  COULD NOT RUN: {0}" -f $whyNot) -ForegroundColor Red
            Write-Host "  The Full Mode total above stands on its own. The Audit Mode half is" -ForegroundColor Red
            Write-Host "  NOT covered by this run." -ForegroundColor Red
            $exitCode = 1
        } elseif ($child.isAdmin) {
            # The drop reported success and came back elevated. That is the
            # relaunch-deelevated-mismatch shape from the operator's oplog, and
            # the honest answer is that the other half did not run.
            Write-Host "  COULD NOT RUN: the de-elevated half came back STILL ELEVATED, so it ran" -ForegroundColor DarkYellow
            Write-Host "  the same tier again rather than the other one. With UAC disabled" -ForegroundColor DarkYellow
            Write-Host "  (EnableLUA=0) there is no standard-user token for RunLevel Limited to" -ForegroundColor DarkYellow
            Write-Host "  drop to. Its counts are discarded rather than added." -ForegroundColor DarkYellow
            Write-Host ("  COMBINED: not available. Full Mode only ({0} passed)." -f $totalPassed) -ForegroundColor DarkYellow
        } else {
            $colour = if ($child.failed -gt 0) { "Red" } else { "Green" }
            Write-Host ("  {0}: {1} passed, {2} failed, {3} skipped" -f $child.tier, $child.passed, $child.failed, $child.skipped) -ForegroundColor $colour
            foreach ($n in @($child.failNames)) { Write-Host ("      failed suite: {0}" -f $n) -ForegroundColor Red }
            foreach ($n in @($child.skipNames)) { Write-Host ("      skipped something: {0}" -f $n) -ForegroundColor DarkYellow }
            # Reprinted HERE because the child had no console to print them on.
            if (@($child.shrunk).Count -gt 0) {
                Write-Host ("      suites that ran FEWER assertions than last time in Audit Mode:") -ForegroundColor Yellow
                foreach ($n in @($child.shrunk)) { Write-Host ("        " + $n) -ForegroundColor Yellow }
                Write-Host ("        Not a failure. Either tests were deleted, or a suite skipped an") -ForegroundColor DarkGray
                Write-Host ("        assertion without recording a skip - only the second is a bug.") -ForegroundColor DarkGray
            }
            Write-Host ("      its logs: {0}" -f $child.logDir) -ForegroundColor DarkGray

            Write-Host ""
            # Deliberately NOT a sum of the two totals. The halves overlap
            # heavily, since most suites run in both tiers, so adding them would
            # invent a number that counts the same assertion twice and reads as
            # growth. Both are printed; neither is merged.
            $bothGreen = ($totalFailed -eq 0) -and ($child.failed -eq 0) -and ($missingSuites.Count -eq 0) -and ($child.missing -eq 0)
            Write-Host ("  BOTH TIERS RAN.  Full Mode {0} passed / {1} failed   Audit Mode {2} passed / {3} failed" -f $totalPassed, $totalFailed, $child.passed, $child.failed) -ForegroundColor $(if ($bothGreen) { "Green" } else { "Red" })
            Write-Host "  These are not added together: most suites run in both tiers, so a sum" -ForegroundColor DarkGray
            Write-Host "  would count the same assertion twice. What both halves green means is" -ForegroundColor DarkGray
            Write-Host "  that no suite was skipped by BOTH of them." -ForegroundColor DarkGray
            if ($child.exitCode -ne 0) { $exitCode = 1 }
        }
    }
}

exit $exitCode
