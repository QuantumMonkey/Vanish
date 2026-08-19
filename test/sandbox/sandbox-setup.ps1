# Runs automatically at Windows Sandbox logon (see vanish-sandbox.wsb).
# Wires up a mapped, read-only Node.js into PATH (Sandbox ships with neither),
# then runs the unelevated regression suite before handing off to the human
# checklist for the parts that need a real UAC click or a real install.

$nodeDir = "C:\Users\WDAGUtilityAccount\Desktop\nodejs"
$env:Path = "$nodeDir;$env:Path"

# PERSIST IT FOR THE WHOLE SANDBOX SESSION, not just this process.
#
# $env:Path only affects the process that sets it. This script runs as a child
# (from LogonCommand, or from the operator typing a powershell -File line), and
# when it exits the PATH goes with it - so the surviving window has no node and
# no npm. The operator hit exactly that on 2026-08-19: "of course npm isn't
# installed", in the window this script had just finished printing instructions
# into. The instructions said "use this window for the manual steps", and that
# window could not run any of them.
#
# Written at User scope, which every NEW shell in the sandbox inherits. Safe by
# construction: a Sandbox session is discarded on close, so nothing here touches
# the host's environment.
try {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if ($userPath -notlike "*$nodeDir*") {
        # No trailing separator. The User PATH is empty in a fresh Sandbox,
        # so the old form left the value ending in ";" - an EMPTY final PATH
        # element that the host does not have. The cleaner suites were being
        # handed a different machine to test than the one they pass on.
        #
        # It found a real bug rather than a false alarm (5l0: the writer was
        # deleting empty elements the scanner had refused to propose), but a
        # setup script should still not be inventing its own fixtures.
        $combined = if ($userPath) { "$nodeDir;$userPath" } else { $nodeDir }
        [Environment]::SetEnvironmentVariable('Path', $combined, 'User')
    }
} catch {
    Write-Host "Could not persist node on PATH for new windows: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Run this in any new window before npm: `$env:Path = '$nodeDir;`$env:Path'" -ForegroundColor Yellow
}

Set-Location "C:\Users\WDAGUtilityAccount\Desktop\test folder\vanish-uninstaller"

Write-Host ""
Write-Host "=== Vanish sandbox environment ===" -ForegroundColor Cyan
Write-Host "Node:  $(node --version)"
Write-Host "Path:  $(Get-Location)"
Write-Host "(path deliberately contains a space -- covers TASK-05/69a)"
Write-Host ""
# Through run-in-sandbox.ps1 rather than `npm test` directly, so the automatic
# route and the manual one are the same code. That script also writes its
# transcripts into the MAPPED folder, which is the only place a sandbox result
# still exists after the VM is closed - `npm test` leaves them in test\logs
# keyed by machine name, which survives, but the run's own stdout did not.
Write-Host "Running the regression suite..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-in-sandbox.ps1')

# 2026-08-07: the packaged portable exe is what the operator actually runs, and
# a bug (blank window on elevated relaunch, commit e00f252) was specific to the
# portable build and invisible to `npm start` against source - PORTABLE_EXECUTABLE_FILE
# is only set when running the real packaged exe. Surface whether a build is
# present and how fresh, so the checklist's exe-specific items know what they
# are testing before the human starts clicking.
$portableExe = Get-ChildItem "$(Get-Location)\dist\Vanish-*-portable.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
if ($portableExe) {
    Write-Host "Packaged portable build found:" -ForegroundColor Cyan
    Write-Host "  $($portableExe.FullName)"
    Write-Host "  built $($portableExe.LastWriteTime)"
} else {
    Write-Host "No packaged portable build in dist\ - run 'npm run dist:portable' on the" -ForegroundColor Yellow
    Write-Host "host first if you want to test the exe checklist items, not just source." -ForegroundColor Yellow
}

# 1qp (Force Uninstall) needs a REAL broken app, not a planted registry
# fixture. 7-Zip was the obvious first candidate but uninstalls too cleanly
# to exercise leftover-scan/quarantine meaningfully (operator note
# 2026-08-06) - Chrome is a known messy uninstaller (leaves AppData\Local\
# Google\Chrome\User Data, GoogleUpdate scheduled tasks/services, registry
# Run keys behind) and installs unattended via winget, so it's staged here
# rather than making the operator hunt down and install something by hand.
Write-Host ""
Write-Host "Installing Chrome unattended (leaves real leftovers to test against)..." -ForegroundColor Cyan
$wingetAvailable = Get-Command winget -ErrorAction SilentlyContinue
if ($wingetAvailable) {
    winget install --id Google.Chrome --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Chrome installed via winget." -ForegroundColor Green
    } else {
        Write-Host "winget install returned exit code $LASTEXITCODE - check above for the real error." -ForegroundColor Yellow
    }
} else {
    Write-Host "winget not found in this Sandbox image - falling back to a direct download." -ForegroundColor Yellow
    $installerPath = "$env:TEMP\ChromeStandaloneSetup64.exe"
    try {
        Invoke-WebRequest -Uri "https://dl.google.com/edgedl/chrome/install/latest/chrome_installer.exe" -OutFile $installerPath -UseBasicParsing
        Start-Process -FilePath $installerPath -ArgumentList "/silent", "/install" -Wait
        Write-Host "Chrome installed via direct download." -ForegroundColor Green
    } catch {
        Write-Host "Chrome install failed both ways: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Install something with real leftovers manually before testing 1qp." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Yellow
Write-Host " Automated suite done." -ForegroundColor Yellow
Write-Host "=======================================================" -ForegroundColor Yellow
Write-Host ""
# The old version of these lines claimed "this PowerShell window stays open --
# use it for the manual steps", which was wrong twice over: this script is a
# CHILD process, so the window that survives is its parent, and that parent has
# never had node on PATH. Say what is actually true, and hand over the one line
# that makes any window work if the User-scope PATH above did not take.
Write-Host "For the manual steps, in THIS window or a new one:" -ForegroundColor Cyan
Write-Host "  cd `"$PWD`"" -ForegroundColor Gray
# npm.cmd, not npm. A bare `npm` resolves to npm.ps1 first, and a default
# Sandbox shell runs under the Restricted execution policy, so it refuses with
# "running scripts is disabled on this system" - which reads like npm is broken
# rather than like a policy. The .cmd shim does not go through PowerShell at all.
# Hit on 2026-08-19, one line after the PATH problem above.
Write-Host "  npm.cmd test      # re-run the suite" -ForegroundColor Gray
Write-Host "  npm.cmd start     # launch from source" -ForegroundColor Gray
Write-Host ""
Write-Host "Two things that bite in a fresh Sandbox shell, and their fixes:" -ForegroundColor Cyan
Write-Host "  'npm is not recognized'        ->  `$env:Path = '$nodeDir;' + `$env:Path" -ForegroundColor Gray
Write-Host "  'running scripts is disabled'  ->  use npm.cmd, or:" -ForegroundColor Gray
Write-Host "                                    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force" -ForegroundColor Gray
Write-Host ""

# NOT notepad. The Windows Sandbox image does not ship it - this line threw
# 'The term notepad is not recognized' on 2026-08-19 and the checklist never
# opened, which on a machine whose whole purpose is a manual checklist is the
# one failure that matters. Try the editors an image might have, and if none of
# them exist PRINT the file, because the point is that the operator can read it.
$checklist = "C:\Users\WDAGUtilityAccount\Desktop\test folder\vanish-uninstaller\test\sandbox\VERIFICATION-CHECKLIST.md"
$opened = $false
foreach ($editor in @('notepad.exe', 'write.exe', 'wordpad.exe')) {
    if (Get-Command $editor -ErrorAction SilentlyContinue) {
        Start-Process $editor -ArgumentList "`"$checklist`"" -ErrorAction SilentlyContinue
        $opened = $true
        break
    }
}
if (-not $opened) {
    Write-Host "No text editor in this Sandbox image - printing the checklist instead." -ForegroundColor Yellow
    Write-Host ""
    Get-Content -LiteralPath $checklist | ForEach-Object { Write-Host $_ }
    Write-Host ""
    Write-Host "(also at: $checklist)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "When you are done, run this and paste the output back:" -ForegroundColor Cyan
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\collect-report.ps1" -ForegroundColor Cyan
