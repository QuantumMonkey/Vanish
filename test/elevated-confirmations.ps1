# The elevated confirmations, in one run (dmu / e7q / bfh.2 / 9sy).
#
# RUN ELEVATED. It refuses otherwise, because every check in here is about the
# write path that only exists in Full Mode.
#
# WHY ONE SCRIPT: six features are built and passing their automated tests but
# have never had their elevated path exercised, because a consent dialog cannot
# be automated. Four of them do not actually need the dialog - they need a
# process that already holds the privilege. That is one UAC prompt for the lot,
# rather than six sessions of clicking.
#
# The two that are NOT here, and why:
#   69a  tests the UAC branch itself, so it needs an UNELEVATED start. It cannot
#        run inside an already-elevated session - attemptElevatedRelaunch
#        returns alreadyElevated and never reaches the code under test.
#   1qp  Force Uninstall acceptance needs a clean VM, not this machine.
#
# SAFETY: everything this script mutates, it creates first. A throwaway Run
# value, a throwaway service and a throwaway scheduled task, all removed in a
# finally. It does not touch a startup entry, service or task that was already
# on the machine. The one exception is the Delivery Optimization policy value
# for bfh.2, which cannot be faked because the whole point is that Vanish
# writes the real one - that leg captures the prior state first, asserts the
# revert, and has an independent safety net at the end.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $env:TEMP 'vanish-elevated-confirmations'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null
$transcript = Join-Path $outDir 'transcript.txt'
$summaryPath = Join-Path $outDir 'summary.json'

$script:pass = 0
$script:fail = 0
$script:lines = @()
$script:results = [ordered]@{}

function Say($text, $colour = 'Gray') {
    Write-Host $text -ForegroundColor $colour
    $script:lines += $text
}
function Head($text) {
    Say ''
    Say $text 'Cyan'
    Say ('=' * $text.Length) 'Cyan'
}
function Check($condition, $label) {
    if ($condition) { Say "  PASS  $label" 'Green'; $script:pass++ }
    else { Say "  FAIL  $label" 'Red'; $script:fail++ }
    return [bool]$condition
}
function Note($text) { Say "  NOTE  $text" 'Yellow' }

# Call the engine the way main.js does.
function Engine($action, $params) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scanner.ps1'), '-Action', $action)
    if ($null -ne $params) {
        $args += @('-ParamsJson', ($params | ConvertTo-Json -Depth 6 -Compress))
    }
    $raw = & powershell.exe @args 2>&1 | Out-String
    try { return $raw.Trim() | ConvertFrom-Json } catch { return [PSCustomObject]@{ success = $false; error = "unparseable: $($raw.Trim())" } }
}

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

Head 'Vanish elevated confirmations'
Say ("Elevated: {0}" -f $elevated)
Say ("Repo:     {0}" -f $root)
Say ("Started:  {0}" -f (Get-Date -Format o))

if (-not $elevated) {
    Say ''
    Say 'STOP. Every check here is about the write path that only exists in Full Mode.' 'Yellow'
    Say 'Re-run from an elevated PowerShell.' 'Yellow'
    exit 2
}

# Names chosen so that if this script is ever killed mid-run, what it left
# behind is obvious and self-describing.
$probeRunValue = 'VanishConfirmProbe'
$probeRunKey   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$probeRunData  = 'C:\Windows\System32\help.exe --vanish-confirmation-probe'
$probeSvcName  = 'VanishConfirmSvc'
$probeTaskName = 'VanishConfirmTask'
$probeTaskPath = '\'

try {
    # ======================================================================
    Head 'dmu - the three startup write actions'
    # ======================================================================
    Say 'Every object below is created by this script and destroyed afterwards.'
    Say 'Nothing already on your startup list is touched.'

    # --- 1. Registry Run value --------------------------------------------
    Say ''
    Say '1. Remove a Run value, then put it back'
    New-ItemProperty -Path $probeRunKey -Name $probeRunValue -Value $probeRunData -PropertyType String -Force | Out-Null
    $before = (Get-ItemProperty -LiteralPath $probeRunKey -Name $probeRunValue).$probeRunValue
    Check ($before -eq $probeRunData) "planted a Run value to operate on"

    $r = Engine 'startup-remove-registry' @{ keyPath = $probeRunKey; valueName = $probeRunValue }
    Check ($r.success -eq $true) "engine removed it (error: $($r.error))"
    $after = (Get-ItemProperty -LiteralPath $probeRunKey -Name $probeRunValue -ErrorAction SilentlyContinue).$probeRunValue
    Check ($null -eq $after) 'the value is actually gone from the registry'

    # The manifest-only .reg export into the vault is what makes the action
    # safe to offer - the acceptance criteria calls the restore the proof.
    $vaultHit = $null
    if ($r.entryId) {
        $vaultRoot = Join-Path $env:APPDATA 'vanish-uninstaller\vanish-vault'
        $vaultHit = Get-ChildItem -Path $vaultRoot -Recurse -Filter '*.reg' -ErrorAction SilentlyContinue |
            Where-Object { (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($probeRunValue) } |
            Select-Object -First 1
    }
    if (Check ($null -ne $vaultHit) "a .reg manifest naming the value was written to the vault (entryId $($r.entryId))") {
        $regText = Get-Content $vaultHit.FullName -Raw
        Check ($regText -match [regex]::Escape($probeRunData.Replace('\','\\'))) 'the manifest carries the ORIGINAL data, so a restore can be byte-identical'
        # Restore through Windows' own importer, which is what the vault's .reg
        # is for, then compare byte for byte.
        & reg.exe import $vaultHit.FullName 2>&1 | Out-Null
        $restored = (Get-ItemProperty -LiteralPath $probeRunKey -Name $probeRunValue -ErrorAction SilentlyContinue).$probeRunValue
        Check ($restored -eq $before) "restored value is byte-identical ('$restored')"
    } else {
        Note 'No vault manifest found - restore could not be proven. This is the leg dmu cares most about.'
    }

    # --- 2. Service to Manual ---------------------------------------------
    Say ''
    Say '2. Set an Auto service to Manual, then put it back'
    $svcCreated = $false
    try {
        # A service that does nothing, so reconfiguring it cannot affect the
        # machine. Created Automatic because Get-StartupItems only lists Auto.
        & sc.exe create $probeSvcName binPath= 'C:\Windows\System32\help.exe' start= auto DisplayName= 'Vanish Confirmation Probe' | Out-Null
        Start-Sleep -Milliseconds 400
        $svcCreated = $true
        $startBefore = (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$probeSvcName" -Name Start).Start
        Check ([int]$startBefore -eq 2) "planted an Automatic service (Start=$startBefore)"

        $r2 = Engine 'startup-service-manual' @{ serviceName = $probeSvcName }
        Check ($r2.success -eq $true) "engine set it to Manual (error: $($r2.error))"
        $startAfter = (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$probeSvcName" -Name Start).Start
        Check ([int]$startAfter -eq 3) "Start=3 confirmed in the registry (got $startAfter)"

        & sc.exe config $probeSvcName start= auto | Out-Null
        $startBack = (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$probeSvcName" -Name Start).Start
        Check ([int]$startBack -eq 2) 'restored to Automatic'
    } catch {
        Check $false "service leg threw: $($_.Exception.Message)"
    }

    # --- 3. Scheduled task disable / re-enable ----------------------------
    Say ''
    Say '3. Disable a scheduled task, then re-enable it'
    $taskCreated = $false
    try {
        $act = New-ScheduledTaskAction -Execute 'C:\Windows\System32\help.exe'
        Register-ScheduledTask -TaskName $probeTaskName -TaskPath $probeTaskPath -Action $act -Force | Out-Null
        $taskCreated = $true
        Check ((Get-ScheduledTask -TaskName $probeTaskName -TaskPath $probeTaskPath).State -ne 'Disabled') 'planted an enabled task'

        $r3 = Engine 'startup-task-enabled' @{ taskName = $probeTaskName; taskPath = $probeTaskPath; enable = $false }
        Check ($r3.success -eq $true) "engine disabled it (error: $($r3.error))"
        Check ((Get-ScheduledTask -TaskName $probeTaskName -TaskPath $probeTaskPath).State -eq 'Disabled') 'State=Disabled confirmed'

        $r4 = Engine 'startup-task-enabled' @{ taskName = $probeTaskName; taskPath = $probeTaskPath; enable = $true }
        Check ($r4.success -eq $true) "engine re-enabled it from the same verb (error: $($r4.error))"
        Check ((Get-ScheduledTask -TaskName $probeTaskName -TaskPath $probeTaskPath).State -ne 'Disabled') 're-enabled confirmed'
    } catch {
        Check $false "task leg threw: $($_.Exception.Message)"
    }

    $script:results['dmu'] = "$script:pass passed / $script:fail failed at end of dmu"

    # ======================================================================
    Head 'bfh.2 - the network hold applies and fully reverts'
    # ======================================================================
    $doKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization'
    $doVal = 'DOPercentageMaxBackgroundBandwidth'
    $keyExistedBefore = Test-Path -LiteralPath $doKey
    $valBefore = if ($keyExistedBefore) { (Get-ItemProperty -LiteralPath $doKey -Name $doVal -ErrorAction SilentlyContinue).$doVal } else { $null }
    Say ("Before: policy key exists = {0}, {1} = {2}" -f $keyExistedBefore, $doVal, $(if ($null -eq $valBefore) { '<absent>' } else { $valBefore }))

    $cap = Engine 'network-hold-capture' $null
    Check ($null -ne $cap) 'capture returned a record'

    $applied = $false
    if ($cap) {
        $ap = Engine 'network-hold-apply' @{ record = $cap }
        $applied = ($ap.success -eq $true)
        Check $applied "hold applied (error: $($ap.error))"
        $valHeld = (Get-ItemProperty -LiteralPath $doKey -Name $doVal -ErrorAction SilentlyContinue).$doVal
        Check ([int]$valHeld -eq 1) "$doVal = 1 while held (got $valHeld)"

        $rv = Engine 'network-hold-revert' @{ record = $cap }
        Check ($rv.success -eq $true) "hold released (error: $($rv.error))"
        $valAfter = (Get-ItemProperty -LiteralPath $doKey -Name $doVal -ErrorAction SilentlyContinue).$doVal
        if ($null -eq $valBefore) {
            Check ($null -eq $valAfter) 'the value is GONE after release - revert deletes rather than zeroing'
        } else {
            Check ($valAfter -eq $valBefore) "the value is back to what it was ($valBefore)"
        }
        if (-not $keyExistedBefore) {
            Check (-not (Test-Path -LiteralPath $doKey)) 'the policy key Vanish created is removed too'
        }
    }

    $script:results['bfh.2'] = 'see transcript'

    # ======================================================================
    Head 'e7q + the two suites that have never run - elevated'
    # ======================================================================
    $electron = Join-Path $root 'node_modules\.bin\electron.cmd'
    foreach ($suite in @(
        @{ Name = 'phase4-ipc-verify (e7q: Store-leftover purge + restore)'; Path = 'test/phase4-ipc-verify.js'; Key = 'e7q' },
        @{ Name = 'vault-ipc-verify (TASK-02/03)';                          Path = 'test/vault-ipc-verify.js';  Key = 'vault-ipc' }
    )) {
        Say ''
        Say ("--- {0} ---" -f $suite.Name)
        $out = & $electron (Join-Path $root $suite.Path) 2>&1 | Out-String
        $line = ($out -split "`r?`n" | Where-Object { $_ -match '^Result: \d+ passed, \d+ failed' } | Select-Object -Last 1)
        if ($line) {
            Say ("  {0}" -f $line.Trim())
            Check ($line -match 'Result: \d+ passed, 0 failed') "$($suite.Name) passed elevated"
            $script:results[$suite.Key] = $line.Trim()
        } else {
            Check $false "$($suite.Name) produced no Result line"
            $script:results[$suite.Key] = 'no result line'
            ($out -split "`r?`n" | Select-Object -Last 12) | ForEach-Object { if ($_.Trim()) { Say "    $_" } }
        }
        $out | Set-Content -Encoding ascii (Join-Path $outDir ("{0}.log" -f $suite.Key))
    }

    # ======================================================================
    Head '9sy - real-data pass, elevated'
    # ======================================================================
    $out = & $electron (Join-Path $root 'test/real-data-verify.js') 2>&1 | Out-String
    $line = ($out -split "`r?`n" | Where-Object { $_ -match '^Result: \d+ passed, \d+ failed' } | Select-Object -Last 1)
    if ($line) {
        Say ("  {0}" -f $line.Trim())
        Check ($line -match 'Result: \d+ passed, 0 failed') 'real-data-verify passed elevated'
        $script:results['9sy'] = $line.Trim()
    } else {
        Check $false 'real-data-verify produced no Result line'
        $script:results['9sy'] = 'no result line'
        ($out -split "`r?`n" | Select-Object -Last 20) | ForEach-Object { if ($_.Trim()) { Say "    $_" } }
    }
    $out | Set-Content -Encoding ascii (Join-Path $outDir '9sy.log')

    # ======================================================================
    Head 'Operator request - stop rpdsvc and set it to start on demand'
    # ======================================================================
    # Operator, 2026-08-13: "turn off rpdsvc, i will start it when i need to
    # use realplayer."
    #
    # Manual, NOT Disabled, and that distinction is the whole request: Manual
    # means it no longer starts by itself but RealPlayer can still bring it up
    # when it is actually used. Disabled would break RealPlayer the next time
    # they open it, which is not what was asked for.
    #
    # Recorded here rather than done quietly: this is the one thing in this
    # script that changes a setting the operator did not create, and it is
    # reversible with a single documented command, printed below.
    try {
        $svc = Get-CimInstance -Query "SELECT Name, StartMode, State, StartName FROM Win32_Service WHERE Name='rpdsvc'" -ErrorAction Stop
        if (-not $svc) {
            Note 'rpdsvc is not installed on this machine - nothing to do.'
            $script:results['rpdsvc'] = 'not installed'
        } else {
            Say ("  before: StartMode={0}  State={1}  Account={2}" -f $svc.StartMode, $svc.State, $svc.StartName)
            $script:results['rpdsvc-before'] = ("StartMode={0}; State={1}" -f $svc.StartMode, $svc.State)

            if ($svc.State -eq 'Running') {
                Stop-Service -Name rpdsvc -Force -ErrorAction Stop
                Start-Sleep -Milliseconds 800
            }
            & sc.exe config rpdsvc start= demand | Out-Null

            $after = Get-CimInstance -Query "SELECT Name, StartMode, State FROM Win32_Service WHERE Name='rpdsvc'" -ErrorAction Stop
            Say ("  after:  StartMode={0}  State={1}" -f $after.StartMode, $after.State)
            Check ($after.StartMode -eq 'Manual') "rpdsvc no longer starts on its own (StartMode=$($after.StartMode))"
            Check ($after.State -ne 'Running') "rpdsvc is stopped (State=$($after.State))"
            $script:results['rpdsvc-after'] = ("StartMode={0}; State={1}" -f $after.StartMode, $after.State)

            # The listener was the reason this came up at all - confirm it is
            # actually gone rather than assuming stopping the service closed it.
            $still = @(& netstat.exe -ano 2>$null | Select-String -SimpleMatch ':20121')
            Check ($still.Count -eq 0) "nothing is listening on port 20121 any more ($($still.Count) socket(s) left)"

            Say ''
            Say '  To undo this at any time:' 'Yellow'
            Say '    sc.exe config rpdsvc start= auto' 'Yellow'
            Say '    Start-Service rpdsvc' 'Yellow'
        }
    } catch {
        Check $false "rpdsvc change failed: $($_.Exception.Message)"
        $script:results['rpdsvc'] = "failed: $($_.Exception.Message)"
    }

} finally {
    # ======================================================================
    Head 'Cleanup'
    # ======================================================================
    try { Remove-ItemProperty -LiteralPath $probeRunKey -Name $probeRunValue -ErrorAction Stop; Say '  removed the probe Run value' }
    catch { Say '  probe Run value already absent' }

    try { & sc.exe delete $probeSvcName | Out-Null; Say '  removed the probe service' } catch { }
    try { Unregister-ScheduledTask -TaskName $probeTaskName -TaskPath $probeTaskPath -Confirm:$false -ErrorAction Stop; Say '  removed the probe task' }
    catch { Say '  probe task already absent' }

    # Independent safety net for the one thing this script did not create.
    $doKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization'
    $doVal = 'DOPercentageMaxBackgroundBandwidth'
    $stray = (Get-ItemProperty -LiteralPath $doKey -Name $doVal -ErrorAction SilentlyContinue).$doVal
    if ($null -ne $stray) {
        Say ("  WARNING: {0} is still set to {1} - removing it explicitly" -f $doVal, $stray) 'Red'
        try { Remove-ItemProperty -LiteralPath $doKey -Name $doVal -ErrorAction Stop; Say '  removed' } catch { Say "  COULD NOT REMOVE: $($_.Exception.Message)" 'Red' }
    } else {
        Say '  Delivery Optimization policy value is absent, as it was before'
    }

    Head 'RESULT'
    Say ("  {0} passed, {1} failed" -f $script:pass, $script:fail) $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
    Say ''
    Say ("Transcript: {0}" -f $transcript)

    $script:lines | Set-Content -Encoding ascii $transcript
    ([ordered]@{
        ranAt   = (Get-Date -Format o)
        passed  = $script:pass
        failed  = $script:fail
        results = $script:results
    } | ConvertTo-Json -Depth 4) | Set-Content -Encoding ascii $summaryPath
}
