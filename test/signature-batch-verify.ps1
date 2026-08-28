# Parallel signature checking must return the SAME verdicts as serial.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\signature-batch-verify.ps1
#
# WHY THIS EXISTS. Get-StartupItems spent 2659ms of its 7413ms checking
# Authenticode signatures one binary at a time, and Health Advisor - which is
# now the landing page - waited on all of it. Get-BinarySignatureBatch does the
# same work across a runspace pool.
#
# The optimisation is only legitimate if the ANSWERS are identical, and the
# answers are not cosmetic: the signer name decides whether a startup entry is
# grouped as 'necessary' and folded away out of sight, or shown as actionable.
# A parallel path that quietly returned 'unreadable' more often would hide
# fewer things than it should, and one that returned a wrong signer would hide
# more. So this compares verdict by verdict against the serial function, on
# this machine's real startup binaries, and reports any disagreement by path.
#
# It deliberately does NOT assert a speed. Runspace scheduling is not
# deterministic and a threshold that passes on a fast box is a flaky failure on
# a loaded one. The timing is printed as information; only correctness fails
# this suite.
#
# THE ISOLATION TRAP THIS GUARDS AGAINST. A new runspace does not inherit this
# file's dot-sourced functions. The first version of a batch like this one
# naturally calls Get-BinarySignature inside the worker, which fails there with
# "not recognized as a cmdlet" and gets swallowed by the worker's own catch -
# producing 'unreadable' for EVERY path, quickly, and looking like a huge win.
# That failure is invisible without exactly this comparison.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scanner.ps1')

$script:pass = 0
$script:fail = 0
function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

Write-Host ''
Write-Host 'Parallel signature checking agrees with serial'
Write-Host '============================================='

$items = (Get-StartupItems).items
$paths = @($items |
    Where-Object { $_.exeExists -eq $true -and $_.exePath } |
    ForEach-Object { [string]$_.exePath } |
    Select-Object -Unique)

Assert-True ($paths.Count -gt 0) "this machine has signed-or-not startup binaries to compare ($($paths.Count) unique paths)"

if ($paths.Count -eq 0) {
    # Not a pass. Nothing was compared, and saying so is the honest result.
    Write-Host '  SKIP  the comparison - no startup binary on this machine resolves to a file that exists' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "Result: $script:pass passed, $script:fail failed"
    exit 0
}

$swSerial = [Diagnostics.Stopwatch]::StartNew()
$serial = @{}
foreach ($p in $paths) { $serial[$p] = Get-BinarySignature -Path $p }
$swSerial.Stop()

$swBatch = [Diagnostics.Stopwatch]::StartNew()
$batch = Get-BinarySignatureBatch -Paths $paths
$swBatch.Stop()

Write-Host ("  INFO  serial {0} ms, parallel {1} ms, over {2} binaries" -f `
    $swSerial.ElapsedMilliseconds, $swBatch.ElapsedMilliseconds, $paths.Count) -ForegroundColor DarkGray

$missing = @()
$differing = @()
foreach ($p in $paths) {
    if (-not $batch.ContainsKey($p)) { $missing += $p; continue }
    $a = $serial[$p]
    $b = $batch[$p]
    if ([string]$a.status -ne [string]$b.status -or
        [string]$a.signer -ne [string]$b.signer -or
        [bool]$a.isEv     -ne [bool]$b.isEv) {
        $differing += "$p : serial=$($a.status)/$($a.signer)/$($a.isEv) batch=$($b.status)/$($b.signer)/$($b.isEv)"
    }
}

Assert-True ($missing.Count -eq 0) "every path asked about comes back with an answer ($($missing.Count) missing)"
foreach ($m in ($missing | Select-Object -First 5)) { Write-Host "        no answer for $m" -ForegroundColor DarkYellow }

Assert-True ($differing.Count -eq 0) "and every verdict matches the serial one ($($differing.Count) of $($paths.Count) differ)"
foreach ($d in ($differing | Select-Object -First 5)) { Write-Host "        $d" -ForegroundColor DarkYellow }

# The isolation trap, asserted directly rather than left to the comparison
# above to catch by luck. If the worker script block had lost access to
# Get-AuthenticodeSignature, EVERY path would come back 'unreadable' - and on a
# machine where nothing happened to be signed, the comparison would still pass.
$statuses = @($paths | ForEach-Object { [string]$batch[$_].status })
$allUnreadable = (@($statuses | Where-Object { $_ -eq 'unreadable' }).Count -eq $paths.Count)
Assert-True (-not $allUnreadable) `
    'not every binary came back unreadable - which is what a runspace that lost the cmdlet would produce, fast, and call a win'

$named = @($paths | Where-Object { $batch[$_].signer }).Count
Assert-True ($named -gt 0) "the parallel path recovers real signer names, not just statuses ($named of $($paths.Count) named)"

# Small inputs take the serial branch by design; it must still be a complete,
# correctly shaped answer rather than an empty map.
$few = @($paths | Select-Object -First 2)
$small = Get-BinarySignatureBatch -Paths $few
Assert-True (@($few | Where-Object { $small.ContainsKey($_) }).Count -eq $few.Count) `
    'a list too small to be worth a runspace pool is still answered in full, by the serial branch'

$empty = Get-BinarySignatureBatch -Paths @()
Assert-True ($empty.Count -eq 0) 'an empty list returns an empty map rather than throwing'

$blanks = Get-BinarySignatureBatch -Paths @('', $null, '   ')
Assert-True ($blanks.Count -eq 0) 'and blank or null paths are dropped rather than becoming keys with invented verdicts'

Write-Host ''
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { 'Red' } else { 'Green' })
if ($script:fail -gt 0) { exit 1 }
