# Ground truth for test/real-data-verify.js.
#
# WHY THIS IS A SEPARATE FILE AND NOT A scanner.ps1 ACTION: a harness that asks
# the code under test what reality looks like can only ever agree with itself.
# That is precisely how 312/312 stayed green while the app was broken on screen.
# This file reads the machine directly, with its own queries, and the harness
# compares the engine's answer against it. Keep it dependency-free and dumb.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File real-machine-truth.ps1

$ErrorActionPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- uninstall hives
# Read through the registry VIEWS rather than the HKLM:\...\Wow6432Node path, so
# 32-bit entries are seen the way Windows itself presents them.
$views = @(
    @{ Hive = 'LocalMachine'; View = 'Registry64'; Label = 'HKLM (64-bit)' },
    @{ Hive = 'LocalMachine'; View = 'Registry32'; Label = 'HKLM (32-bit)' },
    @{ Hive = 'CurrentUser';  View = 'Registry64'; Label = 'HKCU' }
)
$sub = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'

$entries = @()

foreach ($v in $views) {
    $base = $null
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::$($v.Hive),
            [Microsoft.Win32.RegistryView]::$($v.View))
    } catch { continue }
    if (-not $base) { continue }

    $root = $base.OpenSubKey($sub)
    if (-not $root) { $base.Close(); continue }

    foreach ($childName in $root.GetSubKeyNames()) {
        $key = $root.OpenSubKey($childName)
        if (-not $key) { continue }

        $displayName = [string]$key.GetValue('DisplayName')
        if ([string]::IsNullOrWhiteSpace($displayName)) { $key.Close(); continue }

        $uninstallString = [string]$key.GetValue('UninstallString')
        $installLocation = [string]$key.GetValue('InstallLocation')
        $publisher       = [string]$key.GetValue('Publisher')
        $systemComponent = $key.GetValue('SystemComponent')
        $parentKeyName   = [string]$key.GetValue('ParentKeyName')

        # Does the recorded uninstaller actually exist? msiexec entries are
        # resolved by the MSI database, not by a path on disk.
        $uninstallerExists = $false
        $uninstallerPath   = $null
        if (-not [string]::IsNullOrWhiteSpace($uninstallString)) {
            if ($uninstallString -match 'msiexec') {
                $uninstallerExists = $true
                $uninstallerPath   = 'msiexec'
            } else {
                $s = $uninstallString.Trim()
                if ($s.StartsWith('"')) {
                    $end = $s.IndexOf('"', 1)
                    if ($end -gt 0) { $uninstallerPath = $s.Substring(1, $end - 1) }
                } elseif ($s -match '^(.*?\.exe)') {
                    $uninstallerPath = $Matches[1]
                } else {
                    $uninstallerPath = $s.Split(' ')[0]
                }
                if ($uninstallerPath) {
                    $expanded = [System.Environment]::ExpandEnvironmentVariables($uninstallerPath)
                    $uninstallerExists = [bool](Test-Path -LiteralPath $expanded -PathType Leaf)
                }
            }
        }

        $installLocationExists = $null
        if (-not [string]::IsNullOrWhiteSpace($installLocation)) {
            $expandedLoc = [System.Environment]::ExpandEnvironmentVariables($installLocation)
            $installLocationExists = [bool](Test-Path -LiteralPath $expandedLoc)
        }

        $entries += [PSCustomObject]@{
            hiveLabel             = $v.Label
            keyName               = $childName
            name                  = $displayName
            publisher             = $publisher
            uninstallString       = $uninstallString
            uninstallerPath       = $uninstallerPath
            uninstallerExists     = $uninstallerExists
            installLocation       = $installLocation
            installLocationExists = $installLocationExists
            systemComponent       = ($null -ne $systemComponent -and [int]$systemComponent -eq 1)
            parentKeyName         = $parentKeyName
        }

        $key.Close()
    }
    $root.Close()
    $base.Close()
}

# ---------------------------------------------------------------- fixed drives
# Win32_LogicalDisk exposes DeviceID ("C:"), NOT DriveLetter - that property
# belongs to Win32_Volume. Asking for it makes the whole query invalid, which is
# how the Storage panel came to render nothing at all.
$disks = @()
foreach ($d in (Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3')) {
    if (-not $d.DeviceID) { continue }
    $disks += [PSCustomObject]@{
        drive   = $d.DeviceID.TrimEnd(':')
        label   = [string]$d.VolumeName
        totalGB = if ($d.Size)      { [math]::Round($d.Size      / 1GB, 1) } else { 0 }
        freeGB  = if ($d.FreeSpace) { [math]::Round($d.FreeSpace / 1GB, 1) } else { 0 }
    }
}

# ---------------------------------------------------------------- appx packages
$appx = @()
foreach ($p in (Get-AppxPackage)) {
    if ($p.IsFramework) { continue }
    $appx += [PSCustomObject]@{ name = [string]$p.Name; full = [string]$p.PackageFullName }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

@{
    isAdmin      = $isAdmin
    entries      = $entries
    entryCount   = $entries.Count
    disks        = $disks
    diskCount    = $disks.Count
    appxCount    = $appx.Count
    appx         = $appx
} | ConvertTo-Json -Depth 5 -Compress
