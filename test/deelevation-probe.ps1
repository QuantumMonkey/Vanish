# De-elevation mechanism probe (9rv / 1dq).
#
# RUN THIS FROM AN ELEVATED POWERSHELL. It touches nothing, installs nothing,
# and changes no setting - it launches a few throwaway probe processes that each
# report their own privilege level, then tells you which mechanisms actually
# dropped privilege on THIS machine.
#
# WHY IT EXISTS
#
# 0.5.0 produced the first hard evidence in five sessions, from the operator's
# real oplog:
#
#   14:16:56  relaunch-deelevated           success   trigger=user-click
#   14:17:31  relaunch-deelevated-mismatch  error     direction=deelevate
#             wantedTier=audit  landedTier=full  msSinceAttempt=34537
#
# runas.exe accepted the request and exited 0, and Windows started the process
# ELEVATED anyway. startupMode was already "audit", so the app's own
# auto-elevate-on-startup path was not involved. That means the mechanism is
# WRONG rather than broken, and no amount of instrumentation around it will say
# which mechanism to use instead. This measures that directly.
#
# The rule this file exists to serve: read the evidence first. Four theories
# have already been falsified by measuring instead of arguing.

$ErrorActionPreference = 'Stop'

function Write-Head($text) {
    Write-Host ''
    Write-Host $text -ForegroundColor Cyan
    Write-Host ('=' * $text.Length) -ForegroundColor Cyan
}

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$amElevated = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Head 'Vanish de-elevation mechanism probe'
Write-Host ("This shell is elevated: {0}" -f $amElevated)

if (-not $amElevated) {
    Write-Host ''
    Write-Host 'STOP. This probe is meaningless from an unelevated shell - every' -ForegroundColor Yellow
    Write-Host 'mechanism would "succeed" because there was no privilege to drop.' -ForegroundColor Yellow
    Write-Host 'Re-run it from an elevated PowerShell.' -ForegroundColor Yellow
    exit 2
}

$outDir = Join-Path $env:TEMP 'vanish-deelev-probe'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null

# Each probe process writes: elevated?, integrity level SID, and its own PID.
function Get-ProbeCommand($tag) {
    $file = Join-Path $outDir "$tag.txt"
    $inner = '$p=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent();' +
             '$lvl=(whoami /groups | Select-String "Mandatory Level" | Select-Object -First 1).ToString().Trim();' +
             ('"elevated={0};level={1}" -f $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator), $lvl ' +
              '| Set-Content -Encoding ascii "' + $file + '"')
    return @{ File = $file; Args = @('-NoProfile', '-WindowStyle', 'Hidden', '-Command', $inner) }
}

function Read-Probe($file, $waitSeconds = 20) {
    $deadline = (Get-Date).AddSeconds($waitSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $file) {
            Start-Sleep -Milliseconds 250
            return (Get-Content $file -Raw).Trim()
        }
        Start-Sleep -Milliseconds 250
    }
    return $null
}

$results = [ordered]@{}

# --- A. What Vanish ships today -------------------------------------------
Write-Head 'A. runas.exe /trustlevel:0x20000   (the mechanism 0.5.0 ships)'
$a = Get-ProbeCommand 'runas'
try {
    $psExe = (Get-Command powershell.exe).Source
    $quoted = ($a.Args | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $cmdLine = '"' + $psExe + '" ' + $quoted
    $proc = Start-Process -FilePath 'runas.exe' `
        -ArgumentList @('/trustlevel:0x20000', $cmdLine) `
        -Wait -PassThru -WindowStyle Hidden
    Write-Host ("  runas exit code: {0}" -f $proc.ExitCode)
    $results['runas /trustlevel:0x20000'] = Read-Probe $a.File
} catch {
    Write-Host ("  runas threw: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    $results['runas /trustlevel:0x20000'] = "THREW: $($_.Exception.Message)"
}

# --- B. The shell's own token ---------------------------------------------
# The documented way to run as the logged-on user from an elevated process:
# take the token the interactive shell is already running with (explorer.exe
# runs at medium integrity even when you are an admin) and start the process
# with a duplicate of it. Needs SeImpersonatePrivilege, which an elevated admin
# has. This does not depend on COM routing the way the old Shell.Application
# trick did - it is a direct CreateProcessWithTokenW call.
Write-Head 'B. explorer.exe token via CreateProcessWithTokenW'
$b = Get-ProbeCommand 'shelltoken'
$typeDef = @'
using System;
using System.Runtime.InteropServices;
public static class VanishTok {
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool OpenProcessToken(IntPtr proc, int access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool DuplicateTokenEx(IntPtr existing, int access, IntPtr attrs,
        int impersonationLevel, int tokenType, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool CreateProcessWithTokenW(IntPtr token, int logonFlags, string appName,
        string cmdLine, int creationFlags, IntPtr env, string curDir,
        ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    public static int Launch(int shellPid, string appName, string cmdLine) {
        IntPtr proc = OpenProcess(0x0400, false, shellPid);           // PROCESS_QUERY_INFORMATION
        if (proc == IntPtr.Zero) return -1;
        IntPtr tok;
        if (!OpenProcessToken(proc, 0x0002 | 0x0008, out tok)) { CloseHandle(proc); return -2; } // DUPLICATE|QUERY
        IntPtr dup;
        if (!DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out dup)) { // ALL_ACCESS, Impersonation, Primary
            CloseHandle(tok); CloseHandle(proc); return -3; }
        STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = "winsta0\\default";
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessWithTokenW(dup, 0, appName, cmdLine, 0x00000400, IntPtr.Zero, null, ref si, out pi);
        int err = ok ? 0 : Marshal.GetLastWin32Error();
        CloseHandle(dup); CloseHandle(tok); CloseHandle(proc);
        return ok ? pi.dwProcessId : -err;
    }
}
'@
try {
    Add-Type -TypeDefinition $typeDef -Language CSharp | Out-Null
    $shell = Get-Process explorer -ErrorAction Stop | Select-Object -First 1
    $psExe = (Get-Command powershell.exe).Source
    $quotedB = ($b.Args | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $rc = [VanishTok]::Launch($shell.Id, $psExe, ('"' + $psExe + '" ' + $quotedB))
    if ($rc -gt 0) {
        Write-Host ("  launched as PID {0} using explorer.exe (PID {1})'s token" -f $rc, $shell.Id)
        $results['explorer token (CreateProcessWithTokenW)'] = Read-Probe $b.File
    } else {
        Write-Host ("  failed, code {0}" -f $rc) -ForegroundColor Yellow
        $results['explorer token (CreateProcessWithTokenW)'] = "FAILED code $rc"
    }
} catch {
    Write-Host ("  threw: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    $results['explorer token (CreateProcessWithTokenW)'] = "THREW: $($_.Exception.Message)"
}

# --- C. Scheduled task, run as the interactive user ------------------------
# Heavier, but it is the mechanism that does not depend on a token being
# available or a SAFER policy being in force.
Write-Head 'C. Scheduled task without highest privileges'
$c = Get-ProbeCommand 'schtask'
$taskName = 'VanishDeelevationProbe'
try {
    $psExe = (Get-Command powershell.exe).Source
    $quotedC = ($c.Args | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $quotedC
    $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $results['scheduled task (RunLevel Limited)'] = Read-Probe $c.File
} catch {
    Write-Host ("  threw: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    $results['scheduled task (RunLevel Limited)'] = "THREW: $($_.Exception.Message)"
} finally {
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch {}
}

# --- Verdict ---------------------------------------------------------------
Write-Head 'VERDICT'
Write-Host ''
foreach ($k in $results.Keys) {
    $v = $results[$k]
    if ($null -eq $v) {
        Write-Host ("  {0,-46} NO RESULT (probe never wrote its file)" -f $k) -ForegroundColor Yellow
    } elseif ($v -match 'elevated=False') {
        Write-Host ("  {0,-46} DROPPED PRIVILEGE   {1}" -f $k, $v) -ForegroundColor Green
    } elseif ($v -match 'elevated=True') {
        Write-Host ("  {0,-46} STILL ELEVATED      {1}" -f $k, $v) -ForegroundColor Red
    } else {
        Write-Host ("  {0,-46} {1}" -f $k, $v) -ForegroundColor Yellow
    }
}

$report = Join-Path $outDir 'verdict.txt'
$lines = @("probe run $(Get-Date -Format o)", "shell elevated: $amElevated")
foreach ($k in $results.Keys) { $lines += ("{0} => {1}" -f $k, $results[$k]) }
$lines | Set-Content -Encoding ascii $report

Write-Host ''
Write-Host ("Written to: {0}" -f $report)
Write-Host 'Paste that file back, or just the VERDICT block above.'
Write-Host ''
Write-Host 'Any line reading DROPPED PRIVILEGE is a mechanism that works here.'
Write-Host 'If A is red and B or C is green, that is the replacement for'
Write-Host "scanner.ps1's relaunch-deelevated and the five-session question is closed."
