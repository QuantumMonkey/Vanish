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

# electron.exe, not node_modules\.bin\electron.cmd: the .cmd is a batch wrapper,
# so killing it on a timeout would leave the real Electron - and its window -
# running, which is exactly the state the operator was left in on 2026-08-14.
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

$script:pass = 0
$script:fail = 0
$script:lastCheck = $false
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
# Sets $script:lastCheck rather than returning it. Returning the boolean meant
# every call site that did not consume it printed a bare "True" or "False" under
# its own PASS/FAIL line - 32 stray lines in a transcript whose whole job is to
# be readable by the operator who ran it.
function Check($condition, $label) {
    $script:lastCheck = [bool]$condition
    if ($condition) { Say "  PASS  $label" 'Green'; $script:pass++ }
    else { Say "  FAIL  $label" 'Red'; $script:fail++ }
}
function Note($text) { Say "  NOTE  $text" 'Yellow' }

# Call the engine the way main.js does, which means -ParamsBase64.
#
# THE PARAMETER NAME WAS THE BUG, and the 2026-08-14 elevated run is what
# exposed it. This function used to pass -ParamsJson with the double quotes
# escaped, and a comment here confidently blamed the Windows command-line
# parser for stripping quotes. That was wrong, and it survived a whole session
# because it produced exactly the symptoms it predicted: "Which startup entry?
# No value name was given", "that is not a valid service name", "Nothing was
# captured first" - four refusals that read like four app bugs.
#
# scanner.ps1 takes -Action and -ParamsBase64. THERE IS NO -ParamsJson
# PARAMETER. It has a local $ParamsJson variable, decoded FROM the base64, and
# the two were conflated. Passing -ParamsJson to a script whose param block
# does not declare it does not error: with -File, the unmatched name and its
# value fall into $args and are ignored, so the engine ran perfectly with no
# parameters at all and refused by name, every time.
#
# Proved with an echo probe carrying scanner.ps1's exact param block rather
# than reasoned about (the previous fix was reasoned about):
#   -ParamsJson    -> ParamsBase64='', DecodedJson='', $args = 2 leftover items
#   -ParamsBase64  -> DecodedJson = the exact JSON, $args empty
# The quotes had survived the command line intact all along.
#
# Note what this means about the earlier failures: the tier check inside each
# action runs BEFORE the parameter check and did not fire, which is independent
# proof the run really was elevated and the engine really did execute.
function Engine($action, $params) {
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scanner.ps1'), '-Action', $action)
    if ($null -ne $params) {
        $json = $params | ConvertTo-Json -Depth 6 -Compress
        $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
        $psArgs += @('-ParamsBase64', $b64)
    }
    $raw = & powershell.exe @psArgs 2>&1 | Out-String
    try { return $raw.Trim() | ConvertFrom-Json } catch { return [PSCustomObject]@{ success = $false; error = "unparseable: $($raw.Trim())" } }
}

# Run one Electron suite with its output STREAMED, and a deadline.
#
# The 2026-08-14 run stopped dead here and the operator was left watching a
# Vanish window with nothing on the console, no way to tell whether it was
# working, waiting for them, or hung - and no way out but to abandon the run.
# Two causes, both fixed here rather than explained away:
#
#   1. `& $electron ... | Out-String` buffers EVERYTHING until the child exits.
#      A suite that never exits therefore prints nothing, ever, including the
#      lines it had already written. Now every line appears as it arrives.
#   2. There was no timeout. A hung child hung the whole script behind it, so
#      the legs after it never ran either.
#
# Two limits, because they mean different things: IDLE is how long the suite is
# allowed to say nothing (a real hang is silent), HARD is the total wall clock
# it may take even while talking. Either one being hit is reported AS A HANG,
# distinct from a suite that ran and failed - those are not the same finding and
# must never be collapsed into "failed".
function Invoke-Suite($name, $relPath, $key, $idleSeconds = 90, $hardSeconds = 300) {
    $logPath = Join-Path $outDir ("{0}.log" -f $key)
    $errPath = Join-Path $outDir ("{0}.err.log" -f $key)
    Set-Content -Path $logPath -Value '' -Encoding ascii
    Set-Content -Path $errPath -Value '' -Encoding ascii

    Say ''
    Say ("--- {0} ---" -f $name)
    Say ("    {0}  (idle limit {1}s, hard limit {2}s; live output follows)" -f $relPath, $idleSeconds, $hardSeconds)

    # THE QUOTES ARE NOT OPTIONAL, and do not delete them because the path
    # currently has no space in it. -ArgumentList builds a COMMAND LINE, not an
    # argument vector: one element containing a space arrives at the child as
    # two arguments. This repo used to live at "D:\quickhelp projects\", where
    # Electron reported 'Unable to find Electron app at D:\quickhelp' and popped
    # a modal error box that nothing on the console explained. It has since moved
    # to "D:\quickhelp\vanish-uninstaller", which hides the trap rather than
    # removing it - anyone who clones this repo into a path with a space, and
    # the sandbox's own "Desktop\test folder\..." mapping, hit it again
    # immediately. The old code used the call
    # operator (& $electron $path), which quotes for you - switching to
    # Start-Process for -PassThru and -RedirectStandardOutput moved that
    # responsibility here, and the first version of this line did not take it.
    # Same trap scanner.ps1 documents for relaunch-elevated. Verified against
    # this path, not assumed.
    $suitePath = Join-Path $root $relPath
    if (-not (Test-Path -LiteralPath $suitePath)) {
        Check $false "$name - suite file not found at $suitePath"
        $script:results[$key] = 'suite file missing'
        return
    }
    $proc = Start-Process -FilePath $electronExe -ArgumentList ('"{0}"' -f $suitePath) `
        -RedirectStandardOutput $logPath -RedirectStandardError $errPath -NoNewWindow -PassThru

    # FileShare::ReadWrite matters: the child holds the log open for writing, so
    # a plain Get-Content can lose the race and throw mid-run.
    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = [System.IO.StreamReader]::new($stream)

    $started  = Get-Date
    $lastSeen = Get-Date
    $lastLine = ''
    $verdict  = 'ran'
    $nextBeat = 15
    try {
        while ($true) {
            $got = $false
            while ($null -ne ($line = $reader.ReadLine())) {
                if ($line.Trim()) { Say ("    {0}" -f $line.TrimEnd()); $lastLine = $line.Trim() }
                $got = $true
            }
            if ($got) { $lastSeen = Get-Date; $nextBeat = 15 }
            if ($proc.HasExited) { break }

            # A heartbeat while it is silent, because "nothing on screen" was the
            # actual complaint and a suite can legitimately be quiet for a minute
            # (real-data-verify scans the whole machine). This says how long the
            # silence has lasted and how long is left before it counts as hung,
            # so waiting is a decision the operator can make with numbers.
            $idle = ((Get-Date) - $lastSeen).TotalSeconds
            if ($idle -ge $nextBeat) {
                Say ("    ... still running, quiet for {0}s of the {1}s idle limit (PID {2})" -f [int]$idle, $idleSeconds, $proc.Id) 'DarkGray'
                $nextBeat = [int]$idle + 15
            }

            if ($idle -gt $idleSeconds) { $verdict = 'idle'; break }
            if (((Get-Date) - $started).TotalSeconds -gt $hardSeconds) { $verdict = 'hard'; break }
            Start-Sleep -Milliseconds 400
        }
        if ($verdict -eq 'ran') {
            $proc.WaitForExit()
            while ($null -ne ($line = $reader.ReadLine())) {
                if ($line.Trim()) { Say ("    {0}" -f $line.TrimEnd()); $lastLine = $line.Trim() }
            }
        }
    } finally {
        $reader.Dispose(); $stream.Dispose()
    }

    if ($verdict -ne 'ran') {
        $why = if ($verdict -eq 'idle') { "said nothing for $idleSeconds seconds" } else { "exceeded its $hardSeconds second limit" }
        Say ''
        Say ("    HUNG: {0} {1}. Killing it so the rest of this script can run." -f $name, $why) 'Red'
        Say ("    Last line it printed: {0}" -f $(if ($lastLine) { $lastLine } else { '(nothing at all)' })) 'Red'
        Say '    If a Vanish window or a Windows dialog is on screen, that is what it is waiting for.' 'Yellow'
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
        # Electron leaves helper processes behind when the parent is killed.
        Get-Process -Name 'electron' -ErrorAction SilentlyContinue |
            Where-Object { $_.StartTime -gt $started } |
            ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { } }
        Check $false "$name did not finish - HUNG, not failed (last line: $lastLine)"
        $script:results[$key] = "hung after $([int]((Get-Date) - $started).TotalSeconds)s; last line: $lastLine"
        return
    }

    # Refresh first: a Start-Process -PassThru object does not populate ExitCode
    # until it is refreshed, so this reported an empty exit code - a diagnostic
    # printing a blank where a number belongs is worse than not printing it.
    try { $proc.Refresh() } catch { }
    $exitCode = try { $proc.ExitCode } catch { $null }
    if ($null -eq $exitCode) { $exitCode = '(not reported)' }

    $all = @(Get-Content -Path $logPath -ErrorAction SilentlyContinue)
    $resultLine = ($all | Where-Object { $_ -match '^Result: \d+ passed, \d+ failed' } | Select-Object -Last 1)
    if ($resultLine) {
        Check ($resultLine -match 'Result: \d+ passed, 0 failed') "$name passed elevated ($($resultLine.Trim()))"
        $script:results[$key] = $resultLine.Trim()
    } else {
        Check $false "$name produced no Result line (exit code $($proc.ExitCode))"
        $script:results[$key] = "no result line; exit $($proc.ExitCode)"
        $err = @(Get-Content -Path $errPath -ErrorAction SilentlyContinue | Where-Object { $_.Trim() } | Select-Object -Last 8)
        foreach ($e in $err) { Say ("    stderr: {0}" -f $e) 'Yellow' }
    }
    Say ("    took {0}s" -f [int]((Get-Date) - $started).TotalSeconds)
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
    Check ($null -ne $vaultHit) "a .reg manifest naming the value was written to the vault (entryId $($r.entryId))"
    if ($script:lastCheck) {
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

        # GUARDED ON $applied, and the first run is why. When apply failed,
        # these two still reported PASS - "the value is GONE after release"
        # was trivially true because nothing had ever set it. A revert
        # assertion that passes when no hold was applied is not evidence of a
        # working revert, it is evidence of an inert test, and it reads green
        # in exactly the situation you most need it to read red.
        if (-not $applied) {
            Note 'Apply failed, so the revert assertions are SKIPPED rather than passed.'
            Note 'They would pass vacuously - nothing was ever set to put back.'
        } else {
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
    }

    $script:results['bfh.2'] = 'see transcript'

    # ======================================================================
    Head 'e7q + the two suites that have never run - elevated'
    # ======================================================================
    if (-not (Test-Path $electronExe)) {
        Check $false "electron.exe not found at $electronExe - run npm install"
    } else {
        Invoke-Suite 'phase4-ipc-verify (e7q: Store-leftover purge + restore)' 'test/phase4-ipc-verify.js' 'e7q' 90 300
        Invoke-Suite 'vault-ipc-verify (TASK-02/03)' 'test/vault-ipc-verify.js' 'vault-ipc' 90 300
    }

    # ======================================================================
    Head '9sy - real-data pass, elevated'
    # ======================================================================
    # A real scan of the real machine, so it gets a far longer hard limit than
    # the IPC suites - but the same kind of idle limit, because silence still
    # means hung no matter how long the work legitimately takes.
    if (Test-Path $electronExe) {
        Invoke-Suite '9sy real-data-verify (elevated)' 'test/real-data-verify.js' '9sy' 120 900
    } else {
        Check $false 'real-data-verify skipped - electron.exe not found'
    }

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
    # Resolved from the LISTENING PORT, not from a service name. The process
    # is called rpdsvc.exe and the service is called "RealTimes Desktop
    # Service", so a hardcoded name of rpdsvc matched nothing and would have
    # reported "not installed" while the listener carried on running.
    # There is also a second RealPlayer service (RealPlayerUpdateSvc) which is
    # deliberately NOT touched: the operator named the one that listens, and
    # quietly reconfiguring a service they did not ask about is not mine to do.
    try {
        $ownerPid = $null
        foreach ($line in (& netstat.exe -ano 2>$null)) {
            $t = ([string]$line).Trim()
            if ($t -notmatch '^TCP\s+\S*:20121\s') { continue }
            $cols = @($t -split '\s+' | Where-Object { $_ })
            if ($cols.Count -ge 5 -and $cols[3] -eq 'LISTENING') { $ownerPid = [int]$cols[4]; break }
        }

        $svc = $null
        if ($ownerPid) {
            $svc = Get-CimInstance -Query "SELECT Name, DisplayName, ProcessId, StartMode, State, StartName FROM Win32_Service WHERE ProcessId = $ownerPid" -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if (-not $svc) {
            # Fall back to the name, in case it is installed but not running.
            $svc = Get-CimInstance -Query "SELECT Name, DisplayName, ProcessId, StartMode, State, StartName FROM Win32_Service WHERE Name='RealTimes Desktop Service'" -ErrorAction SilentlyContinue | Select-Object -First 1
        }

        if (-not $svc) {
            Note 'No service is listening on port 20121 and RealTimes Desktop Service is not installed - nothing to do.'
            $script:results['rpdsvc'] = 'not found'
        } else {
            $svcName = [string]$svc.Name
            Say ("  resolved: port 20121 is held by PID {0}, service '{1}'" -f $ownerPid, $svcName)
            Say ("  before: StartMode={0}  State={1}  Account={2}" -f $svc.StartMode, $svc.State, $svc.StartName)
            $script:results['rpdsvc-before'] = ("StartMode={0}; State={1}" -f $svc.StartMode, $svc.State)

            if ($svc.State -eq 'Running') {
                Stop-Service -Name $svcName -Force -ErrorAction Stop
                Start-Sleep -Milliseconds 800
            }
            # The service name contains spaces, so it has to be quoted for
            # sc.exe - unquoted, sc silently takes the first word.
            & sc.exe config "$svcName" start= demand | Out-Null

            $escaped = $svcName -replace "'", "''"
            $after = Get-CimInstance -Query "SELECT Name, StartMode, State FROM Win32_Service WHERE Name='$escaped'" -ErrorAction Stop
            Say ("  after:  StartMode={0}  State={1}" -f $after.StartMode, $after.State)
            Check ($after.StartMode -eq 'Manual') "$svcName no longer starts on its own (StartMode=$($after.StartMode))"
            Check ($after.State -ne 'Running') "$svcName is stopped (State=$($after.State))"
            $script:results['rpdsvc-after'] = ("StartMode={0}; State={1}" -f $after.StartMode, $after.State)

            # The listener was the reason this came up at all - confirm it is
            # actually gone rather than assuming stopping the service closed it.
            $still = @(& netstat.exe -ano 2>$null | Select-String -SimpleMatch ':20121')
            Check ($still.Count -eq 0) "nothing is listening on port 20121 any more ($($still.Count) socket(s) left)"

            Say ''
            Say '  To undo this at any time:' 'Yellow'
            Say ("    sc.exe config ""{0}"" start= auto" -f $svcName) 'Yellow'
            Say ("    Start-Service ""{0}""" -f $svcName) 'Yellow'

            # Named, not touched.
            $other = Get-CimInstance -Query "SELECT Name, DisplayName, StartMode, State FROM Win32_Service WHERE Name='RealPlayerUpdateSvc'" -ErrorAction SilentlyContinue
            if ($other) {
                Say ''
                Note ("Also present and NOT changed: {0} ({1}, {2}). It does not listen on" -f $other.Name, $other.StartMode, $other.State)
                Note 'anything, and you asked about the one that does. Say the word if you want it Manual too.'
            }
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
