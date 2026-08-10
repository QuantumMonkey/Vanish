# Network attribution (bfh.1). Read-only in both tiers.
#
# The claims under test are mostly NEGATIVE ones, because this panel's value is
# a negative verdict: that nothing on this machine is using the connection, that
# no packet was sent to find that out, and that no per-process byte rate is
# being invented.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\network-verify.ps1

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
    return ($out -join "`n") | ConvertFrom-Json
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish network attribution verification" -ForegroundColor Cyan
Write-Host "======================================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

# ======================================================================
# INV-4: the panel that reads the network must not use it -
# except the ONE scoped, deliberate exception (bd kp0, decided 2026-08-09)
# ======================================================================
Write-Host ""
Write-Host "INV-4 zero runtime network I/O (except the scoped ping exception)" -ForegroundColor Cyan

$engineText = Get-Content $scanner -Raw

# Test-Connection is deliberately NOT in this list any more - it is no
# longer an outright ban, it is scoped below. Everything else stays a flat
# ban with no exception.
$netCalls = @(
    'Invoke-WebRequest', 'Invoke-RestMethod', 'System.Net.WebClient',
    'Net.Sockets.TcpClient', 'Test-NetConnection',
    'System.Net.NetworkInformation.Ping'
)
$found = @($netCalls | Where-Object { $engineText -match [regex]::Escape($_) })
Assert-True ($found.Count -eq 0) "the engine contains no outbound network call outside the scoped ping exception ($($found -join ', '))"

# Test-NetConnection specifically stays fully banned - it is a different,
# heavier reachability probe than the single ICMP echo kp0 approved, and
# nothing in this engine should ever need it.
Assert-True ($engineText -notmatch 'Test-NetConnection') "no Test-NetConnection reachability probe"

# kp0: Test-Connection itself is no longer an outright ban - a single,
# manual-tap ping is a deliberate, approved exception, gated in the renderer
# behind an explicit user click (see renderer.js runPing/wirePingTile) with
# no timer and no automatic caller anywhere. What THIS test still enforces:
# it exists in exactly one place, and that place is the function that IS the
# named ping action - so the next person adding a second, different outbound
# call still has to change an assertion here to do it. A narrower invariant
# that is still enforced beats one that was silently deleted.
#
# CODE only, not comments - scanner.ps1 uses '#' line comments exclusively
# (no <# #> blocks, confirmed), and this file's own explanatory prose about
# kp0 mentions the string "Test-Connection" several times. Counting raw text
# would fail this assertion on its own comments, which is not what it means
# to check.
$codeLines = @(($engineText -split "`r?`n") | Where-Object { $_.Trim() -notmatch '^#' })
$codeText = $codeLines -join "`n"
$pingCallCount = ([regex]::Matches($codeText, [regex]::Escape('Test-Connection'))).Count
Assert-True ($pingCallCount -eq 1) "Test-Connection appears exactly once in the engine's actual code ($pingCallCount found)"

$functionChunks = [regex]::Split($codeText, '(?m)^function ')
$pingChunks = @($functionChunks | Where-Object { $_ -match '^Invoke-NetworkPing\b' })
Assert-True ($pingChunks.Count -eq 1) "Invoke-NetworkPing is defined exactly once"
if ($pingChunks.Count -eq 1) {
    $inPingFunction = ([regex]::Matches($pingChunks[0], [regex]::Escape('Test-Connection'))).Count
    Assert-True ($inPingFunction -eq 1) "the one Test-Connection call lives inside Invoke-NetworkPing, not scattered elsewhere"
}

# ======================================================================
# The read itself
# ======================================================================
Write-Host ""
Write-Host "bfh.1 network activity read" -ForegroundColor Cyan

$sw  = [System.Diagnostics.Stopwatch]::StartNew()
$net = Invoke-Engine "get-network-activity" @{ sampleMs = 400 }
$sw.Stop()

Assert-True ($net.success -eq $true) "the network read completed"
Assert-True (@('busy','quiet','link-weak','unreadable') -contains $net.verdict) "it returns one of the four known verdicts (got '$($net.verdict)')"
Write-Host ("  (verdict '{0}', {1} adapter(s), {2} program(s), {3}s)" -f $net.verdict, @($net.adapters).Count, @($net.processes).Count, [math]::Round($sw.Elapsed.TotalSeconds, 1))

# A short sample must be honoured, or a caller asking for a quick read gets a
# long one - and the harness above would be measuring the default, not this.
Assert-True ($net.sampleMs -eq 400) "the requested sample window is used"
Assert-True ($sw.Elapsed.TotalSeconds -lt 8) "the whole read stays well under the time a person will wait"

# Anything out of range falls back to the shipped default rather than sleeping
# for however long the caller asked.
$silly = Invoke-Engine "get-network-activity" @{ sampleMs = 999999 }
Assert-True ($silly.sampleMs -eq 1000) "an out-of-range sample window falls back to the default"

# ======================================================================
# The numbers have to be facts
# ======================================================================
Write-Host ""
Write-Host "Reported figures" -ForegroundColor Cyan

$adapters = @($net.adapters)
Assert-True ($adapters.Count -gt 0) "at least one live adapter is reported"

$negative = @($adapters | Where-Object { $_.totalBytesPerSecond -lt 0 -or $_.receiveBytesPerSecond -lt 0 -or $_.sendBytesPerSecond -lt 0 })
Assert-True ($negative.Count -eq 0) "no adapter reports a negative rate (counter wrap is clamped, not shown)"

# The gateway filter is what stops a Hyper-V switch talking to a local VM from
# being reported as the user's internet connection being eaten.
$nonGateway = @($adapters | Where-Object { -not $_.hasGateway })
Assert-True ($null -ne ($adapters | Where-Object { $_.hasGateway })) "the adapter carrying the default gateway is identified"
if ($nonGateway.Count -gt 0) {
    $sumGateway = (@($adapters | Where-Object { $_.hasGateway }) | Measure-Object -Property totalBytesPerSecond -Sum).Sum
    Assert-True ([long]$net.totalBytesPerSecond -eq [long]$sumGateway) "the headline rate counts gateway adapters only, not virtual switches"
} else {
    Write-Host "  SKIP  gateway-only accounting (this machine has no non-gateway adapter up)" -ForegroundColor Yellow
}

# Per-process BYTES are not knowable without an ETW trace. If a field ever
# appears claiming otherwise, this fails - which is the point.
$procs = @($net.processes)
if ($procs.Count -gt 0) {
    $fields = @($procs[0].PSObject.Properties.Name)
    $byteish = @($fields | Where-Object { $_ -match 'byte|bps|rate|bandwidth|speed' })
    Assert-True ($byteish.Count -eq 0) "no per-process field claims a byte rate ($($byteish -join ', '))"
    Assert-True (@($procs | Where-Object { $_.connectionCount -lt 1 }).Count -eq 0) "every listed program really holds at least one connection"
    Assert-True (@($procs | Where-Object { $_.peerCount -gt $_.connectionCount }).Count -eq 0) "a program never reports more peers than connections"

    # Guards the $host bug: assigning to that automatic variable made every
    # process share one hashtable key, and all of them reported exactly one
    # peer. Plausible-looking, and wrong on every machine.
    $distinct = @($procs | Select-Object -ExpandProperty peerCount -Unique)
    $multi = @($procs | Where-Object { $_.connectionCount -ge 3 })
    if ($multi.Count -ge 3) {
        Assert-True ($distinct.Count -gt 1) "peer counts vary between programs rather than all reading 1"
    } else {
        Write-Host "  SKIP  peer-count variation (too few busy programs to judge)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  SKIP  per-process shape (nothing holds an established connection right now)" -ForegroundColor Yellow
}

# ======================================================================
# Absence is reported as absence, with its reason
# ======================================================================
Write-Host ""
Write-Host "Rule 24: unknown is not zero" -ForegroundColor Cyan

$wirelessGateway = @($adapters | Where-Object { $_.isWireless -and $_.hasGateway })
if ($wirelessGateway.Count -gt 0) {
    Assert-True (($null -ne $net.signalPercent) -or ($null -ne $net.signalNote)) `
        "a Wi-Fi machine reports either a signal reading or why there is none"
    if ($null -eq $net.signalPercent) {
        Assert-True (@('needs-location-permission','needs-elevation','unavailable') -contains $net.signalNote) `
            "the missing-signal reason is one Vanish can explain (got '$($net.signalNote)')"
        Assert-True ($net.verdict -ne 'link-weak') "without a reading, the link is never declared weak"
    }
} else {
    Write-Host "  SKIP  Wi-Fi signal handling (no wireless adapter carries the gateway)" -ForegroundColor Yellow
}

# BITS needs elevation to see every account. Unelevated that is a limit to
# state, not a zero to report.
if (-not $isAdmin) {
    Assert-True ($null -eq $net.bitsJobs -or $net.bitsJobs -ge 0) "background transfer count is either a number or unknown, never negative"
}

# ======================================================================
# bfh.2: holding background transfers
# ======================================================================
Write-Host ""
Write-Host "bfh.2 network hold: capture, refuse, revert" -ForegroundColor Cyan

# Capture must work in EITHER tier. It is how the UI describes what a hold
# would do before anyone commits to one, and it changes nothing.
$capture = Invoke-Engine "network-hold-capture"
Assert-True ($capture.success -eq $true) "capturing the current settings works without elevation"
Assert-True ($null -ne $capture.doKeyPath) "the capture names the policy key it would write to"
Assert-True ($capture.doValues -is [array] -or $null -ne $capture.doValues) "the capture records the Delivery Optimization values it would change"

$doValue = @($capture.doValues)[0]
Assert-True ($null -ne $doValue.name -and $null -ne $doValue.existed) `
    "each captured value records whether it existed, so revert can delete rather than guess"

# A job somebody else already suspended is not ours to resume later, so it is
# never captured in the first place.
$capturedStates = @(@($capture.bitsJobs) | ForEach-Object { $_.state } | Select-Object -Unique)
$wrongStates = @($capturedStates | Where-Object { @('Suspended','Transferred','Error','Cancelled','Acknowledged') -contains $_ })
Assert-True ($wrongStates.Count -eq 0) "only transfers that are actually running are captured ($($wrongStates -join ', '))"

# The load-bearing refusal: applying without a captured record would change the
# machine with no way back, so it is refused before elevation is even relevant.
$noRecord = Invoke-Engine "network-hold-apply" @{}
Assert-True ($noRecord.success -eq $false) "holding without a captured record is refused"

$noRevert = Invoke-Engine "network-hold-revert" @{}
Assert-True ($noRevert.success -eq $false) "releasing without a record is refused rather than silently doing nothing"

if (-not $isAdmin) {
    $applyDenied  = Invoke-Engine "network-hold-apply"  @{ record = @{ doValues = @(); bitsJobs = @() } }
    $revertDenied = Invoke-Engine "network-hold-revert" @{ record = @{ doValues = @(); bitsJobs = @() } }
    Assert-True ($applyDenied.error  -match "Full Mode") "Audit Mode refuses to hold, by tier"
    Assert-True ($revertDenied.error -match "Full Mode") "Audit Mode refuses to release, by tier"

    # And nothing was written on the way to being refused.
    $after = Invoke-Engine "network-hold-capture"
    Assert-True ($after.doKeyExisted -eq $capture.doKeyExisted) "a refused hold leaves the policy key exactly as it found it"
} else {
    Write-Host "  SKIP  tier refusals (this shell is elevated; the round trip is vanish-uninstaller-bfh.2)" -ForegroundColor Yellow
}

# ======================================================================
# kp0: the scoped ping exception itself
# ======================================================================
Write-Host ""
Write-Host "kp0 manual-tap ping" -ForegroundColor Cyan

# Loopback, never the real network - reliable on any machine or sandbox
# regardless of real connectivity, and proves the success path end to end.
$pingOk = Invoke-Engine "network-ping" @{ destination = "127.0.0.1" }
Assert-True ($pingOk.success -eq $true) "pinging loopback succeeds"
Assert-True ($pingOk.destination -eq "127.0.0.1") "the response echoes back the destination it actually used"
Assert-True ($pingOk.roundTripMs -is [int] -or $pingOk.roundTripMs -is [long]) "round-trip time is reported as a number"
Assert-True ($pingOk.roundTripMs -ge 0) "round-trip time is never negative"

# A missing destination is refused before any probe is attempted, not sent
# as an empty/garbage target.
$pingNoDest = Invoke-Engine "network-ping" @{}
Assert-True ($pingNoDest.success -eq $false) "no destination is refused, not silently pinged as empty"

# An address nothing answers at is reported as a failure with a reason, never
# as an invented 0ms or a success that did not happen. TEST-NET-1 (RFC 5737) -
# reserved for documentation/testing, guaranteed unassigned, so this cannot
# accidentally probe a real host.
$pingFail = Invoke-Engine "network-ping" @{ destination = "192.0.2.1" }
Assert-True ($pingFail.success -eq $false) "an unreachable destination reports failure, not a fabricated result"
Assert-True (-not [string]::IsNullOrWhiteSpace($pingFail.error)) "the failure carries a reason, not a bare false"

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
