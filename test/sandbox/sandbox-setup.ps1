# Runs automatically at Windows Sandbox logon (see vanish-sandbox.wsb).
# Wires up a mapped, read-only Node.js into PATH (Sandbox ships with neither),
# then runs the unelevated regression suite before handing off to the human
# checklist for the parts that need a real UAC click or a real install.

$env:Path = "C:\Users\WDAGUtilityAccount\Desktop\nodejs;$env:Path"
Set-Location "C:\Users\WDAGUtilityAccount\Desktop\test folder\vanish-uninstaller"

Write-Host ""
Write-Host "=== Vanish sandbox environment ===" -ForegroundColor Cyan
Write-Host "Node:  $(node --version)"
Write-Host "Path:  $(Get-Location)"
Write-Host "(path deliberately contains a space -- covers TASK-05/69a)"
Write-Host ""
Write-Host "Running the unelevated regression suite..." -ForegroundColor Cyan
npm test

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
Write-Host " Automated suite done. Opening the manual checklist." -ForegroundColor Yellow
Write-Host " This PowerShell window stays open -- use it for the" -ForegroundColor Yellow
Write-Host " manual steps (launch app, run npm start, etc)." -ForegroundColor Yellow
Write-Host "=======================================================" -ForegroundColor Yellow
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
