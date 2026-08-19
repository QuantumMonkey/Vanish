# 7v3 / be8 / ztl: the three dead-reference sweeps, against this real machine.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\dead-reference-verify.ps1
#
# All three are READ-ONLY, so this runs in either tier. The assertions are about
# the property that makes each one safe to show, not about counts - counts are
# machine-specific and asserting them would make this a machine test.
#
# The one that matters most is the installer cache. A cached .msi that IS still
# referenced is what makes Repair and Uninstall work for an installed product;
# proposing one for deletion would break the product, and there is no size, age
# or name signal that separates referenced from orphaned. Only the registry
# cross-reference does. So the assertions below are mostly about that rule
# holding, including the case where the reference scan reads nothing.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root 'scanner.ps1'

$script:pass = 0
$script:fail = 0

function Assert-True($condition, $label) {
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Invoke-Engine($action, $params) {
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $engine, '-Action', $action)
    if ($null -ne $params) {
        $json = $params | ConvertTo-Json -Depth 6 -Compress
        $psArgs += @('-ParamsBase64', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
    }
    $raw = & powershell.exe @psArgs 2>&1 | Out-String
    return $raw.Trim() | ConvertFrom-Json
}

Write-Host ""
Write-Host "Dead-reference sweeps (7v3 / be8 / ztl)"
Write-Host "======================================="

# ======================================================================
# 7v3 - orphaned Windows Installer cache
# ======================================================================
Write-Host ""
Write-Host "7v3 orphaned installer cache" -ForegroundColor Cyan

$res = Invoke-Engine 'cleaner-scan' @{ cleaner = 'installer-cache' }
Assert-True ($res.success -eq $true) "the sweep completes"

$findings = @($res.findings)
Write-Host ("  ({0} orphaned installer(s))" -f $findings.Count)

# Build the reference set independently of the engine, the same way Windows
# does, so this is a cross-check and not a restatement of the implementation.
$referenced = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
$udRoot = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData')
if ($udRoot) {
    foreach ($sid in $udRoot.GetSubKeyNames()) {
        foreach ($branch in @('Products', 'Patches')) {
            $bk = $udRoot.OpenSubKey("$sid\$branch")
            if (-not $bk) { continue }
            foreach ($code in $bk.GetSubKeyNames()) {
                foreach ($sub in @("$code\InstallProperties", $code)) {
                    $k = $bk.OpenSubKey($sub)
                    if (-not $k) { continue }
                    $lp = [string]$k.GetValue('LocalPackage', '')
                    if ($lp) { [void]$referenced.Add([System.IO.Path]::GetFileName($lp)) }
                    $k.Close()
                }
            }
            $bk.Close()
        }
    }
    $udRoot.Close()
}

# A CLEAN MACHINE HAS ZERO REFERENCES, and that is not a failure - it is the
# case the sweep's own guard exists for. Found on Windows Sandbox 2026-08-19,
# where Installer\UserData holds no LocalPackage values at all because nothing
# has been installed by MSI. The previous version asserted
# '$referenced.Count -gt 0' as though every machine must have some, which made
# a correct empty result look like a defect.
#
# So the two branches are asserted separately, because they defend different
# things and only one of them can apply on any given machine.
if ($referenced.Count -eq 0) {
    Write-Host '  SKIP  no referenced installer packages on this machine - nothing to protect' -ForegroundColor Yellow
    # THE SAFETY PROPERTY, and on this kind of machine it is the ONLY one that
    # matters: with no reference data readable, the sweep must return NOTHING
    # rather than treating every cached installer as an orphan. Getting this
    # wrong would propose deleting every .msi on a fresh Windows install.
    Assert-True ($findings.Count -eq 0) "with no reference data readable the sweep proposes NOTHING, rather than treating every cached installer as an orphan (got $($findings.Count))"
} else {
    Assert-True ($referenced.Count -gt 0) "this machine has referenced installer packages to protect ($($referenced.Count))"

    # THE assertion the whole feature rests on.
    $violations = @($findings | Where-Object { $referenced.Contains([string]$_.label) })
    Assert-True ($violations.Count -eq 0) "no file still referenced by an installed product is proposed ($($violations.Count) violation(s))"
}

Assert-True (
    ($findings.Count -eq 0) -or (@($findings | Where-Object { $_.kind -eq 'file' }).Count -eq $findings.Count)
) "every finding is a FILE - the kind the vault stores whole, if it were allowed to take these"

Assert-True (
    ($findings.Count -eq 0) -or (@($findings | Where-Object { $_.path -and (Test-Path -LiteralPath $_.path) }).Count -eq $findings.Count)
) "every proposed file actually exists right now"

Assert-True (
    ($findings.Count -eq 0) -or (@($findings | Where-Object { $_.sizeBytes -gt 0 }).Count -eq $findings.Count)
) "every finding carries a real measured size, so the space claim is a measurement"

Assert-True (
    ($findings.Count -eq 0) -or (@($findings | Where-Object { [string]$_.path -like "$env:SystemRoot\Installer\*" }).Count -eq $findings.Count)
) "nothing outside the Windows installer cache is ever proposed"

# AUDIT ONLY, deliberately, and this assertion pins the reason so nobody
# 'restores' the removal later without also fixing the restore path.
#
# The cache is under %SystemRoot%, which Test-ProtectedDestination blocks as a
# restore DESTINATION. Measured 2026-08-18: a planted orphan quarantined
# cleanly and the restore then returned 'Rejected: refusing to restore into a
# protected system location', leaving the payload stranded in the vault. The
# space is real and it stays unclaimed until the vault can honour the promise.
Assert-True (
    ($findings.Count -eq 0) -or (@($findings | Where-Object { $_.removable -eq $false }).Count -eq $findings.Count)
) "nothing is offered for removal - the vault cannot restore into %SystemRoot%, so Vanish will not take it"

Assert-True (
    ($findings.Count -eq 0) -or (@($findings | Where-Object { [string]$_.note -match 'put it back|protected' }).Count -eq $findings.Count)
) "and every finding says WHY it is listed rather than actionable"

$reclaimable = (@($findings | Measure-Object -Property sizeBytes -Sum).Sum)
Write-Host ("  (identified but NOT reclaimable yet: {0} MB)" -f [math]::Round($reclaimable / 1MB, 1))

# ======================================================================
# be8 - orphaned firewall rules
# ======================================================================
Write-Host ""
Write-Host "be8 firewall rules for missing programs" -ForegroundColor Cyan

$fw = Invoke-Engine 'cleaner-scan' @{ cleaner = 'firewall-rules' }
Assert-True ($fw.success -eq $true) "the sweep completes"
$fwFindings = @($fw.findings)
Write-Host ("  ({0} dead rule(s))" -f $fwFindings.Count)

# The trap the first measurement pass fell into: %SystemRoot%-style paths are
# not expanded by Test-Path, which flagged 295 live Windows binaries.
$falsePositives = @($fwFindings | Where-Object { $_.meta -and $_.meta.program -and (Test-Path -LiteralPath $_.meta.program -ErrorAction SilentlyContinue) })
Assert-True ($falsePositives.Count -eq 0) "no rule whose program DOES exist is listed - environment variables are expanded first ($($falsePositives.Count) false positive(s))"

$unexpanded = @($fwFindings | Where-Object { [string]$_.meta.program -match '%' })
Assert-True ($unexpanded.Count -eq 0) "no finding reports an unexpanded %VARIABLE% path to the user"

Assert-True (
    ($fwFindings.Count -eq 0) -or (@($fwFindings | Where-Object { $_.removable -eq $false -and $_.note }).Count -eq $fwFindings.Count)
) "every rule is listed as NOT removable and says why - Vanish will not delete what it cannot restore"

# Rule 24: say which kind of dead, not just that it is dead.
$unclassified = @($fwFindings | Where-Object { [string]$_.meta.reason -notmatch '\S' })
Assert-True ($unclassified.Count -eq 0) "every rule says WHY it is dead rather than only that it is"

if ($fwFindings.Count -gt 0) {
    $reasons = @($fwFindings | ForEach-Object { [string]$_.meta.reason } | Sort-Object -Unique)
    Write-Host ("  reasons in use: {0}" -f ($reasons -join ' | '))
}

# ======================================================================
# ztl - dead references and ghost devices
# ======================================================================
Write-Host ""
Write-Host "ztl dead references and ghost devices" -ForegroundColor Cyan

$dr = Invoke-Engine 'cleaner-scan' @{ cleaner = 'dead-references' }
Assert-True ($dr.success -eq $true) "the sweep completes"
$drFindings = @($dr.findings)
$dlls  = @($drFindings | Where-Object { $_.kind -eq 'shared-dll' })
$ghosts = @($drFindings | Where-Object { $_.kind -eq 'ghost-device' })
Write-Host ("  ({0} dead SharedDLL reference(s), {1} ghost device(s))" -f $dlls.Count, $ghosts.Count)

Assert-True (
    ($dlls.Count -eq 0) -or (@($dlls | Where-Object { -not (Test-Path -LiteralPath ([string]$_.meta.path) -ErrorAction SilentlyContinue) }).Count -eq $dlls.Count)
) "every SharedDLL entry listed really is missing from disk"

Assert-True (
    ($drFindings.Count -eq 0) -or (@($drFindings | Where-Object { $_.removable -eq $false }).Count -eq $drFindings.Count)
) "nothing here is offered for removal - it frees no space and a ghost record is not a fault"

# THE Rule 24 assertion, and the reason this sweep is allowed to exist at all:
# 23 of the operator's 80 ghost devices were benign VolumeSnapshot records. A
# list that reads them the same as a genuinely failed device is worse than no
# list.
$vagueGhosts = @($ghosts | Where-Object { [string]$_.meta.reason -notmatch '\S' })
Assert-True ($vagueGhosts.Count -eq 0) "every ghost device is classified, never shown as a bare 'unknown device'"

$snapshots = @($ghosts | Where-Object { [string]$_.meta.class -eq 'VolumeSnapshot' })
Assert-True (
    ($snapshots.Count -eq 0) -or (@($snapshots | Where-Object { [string]$_.meta.reason -match 'System Restore' }).Count -eq $snapshots.Count)
) "a System Restore bookkeeping record says so, instead of reading like broken hardware ($($snapshots.Count) found)"

Assert-True (
    ($drFindings.Count -eq 0) -or (@($drFindings | Where-Object { $_.risk -eq 'Safe' }).Count -eq $drFindings.Count)
) "nothing here is dressed up as risky - these are records, not damage"

# ======================================================================
# All three: the shape the renderer relies on
# ======================================================================
Write-Host ""
Write-Host "The shape every cleaner section relies on" -ForegroundColor Cyan

foreach ($pair in @(
    @{ Name = 'installer-cache'; Findings = $findings },
    @{ Name = 'firewall-rules';  Findings = $fwFindings },
    @{ Name = 'dead-references'; Findings = $drFindings }
)) {
    $bad = @($pair.Findings | Where-Object {
        [string]::IsNullOrWhiteSpace([string]$_.id) -or
        [string]::IsNullOrWhiteSpace([string]$_.label) -or
        [string]::IsNullOrWhiteSpace([string]$_.evidence) -or
        [string]::IsNullOrWhiteSpace([string]$_.risk)
    })
    Assert-True ($bad.Count -eq 0) "$($pair.Name): every finding carries id, label, evidence and risk"

    $dupes = @($pair.Findings | Group-Object { [string]$_.id } | Where-Object { $_.Count -gt 1 })
    Assert-True ($dupes.Count -eq 0) "$($pair.Name): finding ids are unique, so selection cannot address two rows at once"
}

Write-Host ""
Write-Host "Result: $($script:pass) passed, $($script:fail) failed"
exit ([int]($script:fail -gt 0))
