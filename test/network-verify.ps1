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
# INV-4: the panel that reads the network must not use it
# ======================================================================
Write-Host ""
Write-Host "INV-4 zero runtime network I/O" -ForegroundColor Cyan

$engineText = Get-Content $scanner -Raw
$netCalls = @(
    'Invoke-WebRequest', 'Invoke-RestMethod', 'System.Net.WebClient',
    'Net.Sockets.TcpClient', 'Test-NetConnection', 'Test-Connection',
    'System.Net.NetworkInformation.Ping'
)
$found = @($netCalls | Where-Object { $engineText -match [regex]::Escape($_) })
Assert-True ($found.Count -eq 0) "the engine contains no outbound network call ($($found -join ', '))"

# Test-NetConnection and Ping are the two an author reaches for FIRST when
# adding 'is the internet up' to a network panel. Naming them individually
# means the next person adding one has to delete an assertion to do it.
Assert-True ($engineText -notmatch 'Test-NetConnection') "no Test-NetConnection reachability probe"
Assert-True ($engineText -notmatch 'Test-Connection')    "no ICMP ping probe"

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

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
