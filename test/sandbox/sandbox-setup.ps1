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

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Yellow
Write-Host " Automated suite done. Opening the manual checklist." -ForegroundColor Yellow
Write-Host " This PowerShell window stays open -- use it for the" -ForegroundColor Yellow
Write-Host " manual steps (launch app, run npm start, etc)." -ForegroundColor Yellow
Write-Host "=======================================================" -ForegroundColor Yellow
Write-Host ""

notepad "C:\Users\WDAGUtilityAccount\Desktop\test folder\vanish-uninstaller\test\sandbox\VERIFICATION-CHECKLIST.md"
