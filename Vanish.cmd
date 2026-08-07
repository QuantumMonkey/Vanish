@echo off
rem ============================================================================
rem  Vanish - double-click launcher
rem
rem  There was no way to start this app without a terminal and the right npm
rem  incantation, which meant the person it was built for could not open it.
rem  Double-click this file.
rem
rem  It asks Windows for administrator rights up front, because unelevated
rem  Vanish is read-only: it can list and scan and explain, but it cannot
rem  uninstall, clean or restore anything. Decline the prompt and it still
rem  starts - in Audit Mode - rather than failing.
rem ============================================================================

setlocal
cd /d "%~dp0"

rem Already elevated? Then just run. Otherwise re-launch ourselves via PowerShell
rem Start-Process -Verb RunAs, which is what raises the Windows consent prompt.
net session >nul 2>&1
if %errorlevel% equ 0 goto :run

if "%~1"=="--elevated-retry" goto :run

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Start-Process -FilePath '%~f0' -ArgumentList '--elevated-retry' -Verb RunAs } catch { exit 1 }"
if %errorlevel% equ 0 exit /b 0

echo.
echo Administrator rights were declined. Starting in Audit Mode (read-only).
echo.

:run
if not exist "node_modules\electron" (
  echo First run - installing dependencies. This happens once.
  echo.
  call npm ci
  if errorlevel 1 (
    echo.
    echo Could not install dependencies. Is Node.js installed?
    echo Download it from https://nodejs.org and run this file again.
    echo.
    pause
    exit /b 1
  )
)

start "" /b cmd /c npx electron .
exit /b 0
