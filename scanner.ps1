# Vanish PowerShell Uninstaller & Cleaner backend script
# Designed to be invoked by Node/Electron and return JSON payloads.

param(
    [string]$Action,
    [string]$ParamsBase64
)

$OutputEncoding = [System.Text.Encoding]::UTF8

$ParamsJson = ""
if ($ParamsBase64) {
    try {
        $ParamsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ParamsBase64))
    } catch {
        # Fallback to empty
    }
}


# Helper to convert folder size to bytes
function Get-FolderSize {
    param([string]$path)
    if (-not (Test-Path $path)) { return 0 }
    try {
        $size = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        return if ($size) { $size } else { 0 }
    } catch {
        return 0
    }
}

# Helper to format install dates
function Format-InstallDate {
    param([string]$rawDate)
    if ([string]::IsNullOrWhiteSpace($rawDate)) { return $null }
    $rawDate = $rawDate.Trim()
    # Handle YYYYMMDD format
    if ($rawDate -match '^\d{8}$') {
        return "$($rawDate.Substring(0,4))-$($rawDate.Substring(4,2))-$($rawDate.Substring(6,2))"
    }
    # Otherwise try parsing
    try {
        $parsed = [datetime]::Parse($rawDate)
        return $parsed.ToString("yyyy-MM-dd")
    } catch {
        return $rawDate
    }
}

# 1. Fetch Installed Desktop Applications
function Get-InstalledApps {
    $regPaths = @(
        @{ Path = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"; Hive = "HKLM" },
        @{ Path = "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"; Hive = "HKLM6432" },
        @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"; Hive = "HKCU" }
    )

    $apps = [System.Collections.Generic.List[PSCustomObject]]::new()

    foreach ($item in $regPaths) {
        if (Test-Path (Split-Path $item.Path)) {
            try {
                $rawApps = Get-ItemProperty -Path $item.Path -ErrorAction SilentlyContinue
                foreach ($app in $rawApps) {
                    # Filter out updates, system components, and apps without display names
                    if (-not $app.DisplayName) { continue }
                    if ($app.SystemComponent -eq 1) { continue }
                    if ($app.ParentKeyName) { continue }
                    if ($app.DisplayName -match "Security Update" -or $app.DisplayName -match "Hotfix") { continue }

                    # Try to extract install date
                    $date = Format-InstallDate $app.InstallDate
                    if (-not $date -and $app.PSChildName -match '^\d{8}$') {
                        $date = Format-InstallDate $app.PSChildName
                    }

                    # Determine estimated size in MB
                    $sizeBytes = 0
                    if ($app.EstimatedSize) {
                        # EstimatedSize is in KB
                        $sizeBytes = [double]$app.EstimatedSize * 1024
                    }

                    # Unique ID is registry child name + Hive
                    $id = "$($item.Hive)_$($app.PSChildName)"

                    # Registry values are not guaranteed to be REG_SZ: a
                    # REG_MULTI_SZ DisplayName arrives as String[] and used to
                    # break the whole renderer list. Coerce every display field.
                    $apps.Add([PSCustomObject]@{
                        id              = $id
                        name            = [string]$app.DisplayName
                        publisher       = if ($app.Publisher) { [string]$app.Publisher } else { "Unknown Publisher" }
                        version         = if ($app.DisplayVersion) { [string]$app.DisplayVersion } else { "Unknown" }
                        installDate     = $date
                        uninstallString = [string]$app.UninstallString
                        installLocation = [string]$app.InstallLocation
                        icon            = [string]$app.DisplayIcon
                        registryPath    = [string]$app.PSPath
                        type            = "Desktop"
                        sizeBytes       = $sizeBytes
                    })
                }
            } catch {}
        }
    }
    
    # Sort by name
    return $apps | Sort-Object name
}

# 2. Fetch Installed UWP Apps
function Get-UwpApps {
    $apps = [System.Collections.Generic.List[PSCustomObject]]::new()
    
    try {
        # Check if running as Admin to fetch all users packages
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        
        $packages = if ($isAdmin) {
            Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue
        } else {
            Get-AppxPackage -ErrorAction SilentlyContinue
        }

        foreach ($pkg in $packages) {
            # Filter out frameworks, resource packages, and systems
            if ($pkg.IsFramework) { continue }
            if ($pkg.SignatureKind -eq "System") { continue }
            if ([string]::IsNullOrEmpty($pkg.InstallLocation)) { continue }
            if ($pkg.Name -match "Microsoft.NET" -or $pkg.Name -match "Microsoft.VCLibs" -or $pkg.Name -match "Microsoft.UI.Xaml") { continue }

            # Estimate install date from folder creation
            $date = $null
            if (Test-Path $pkg.InstallLocation) {
                $date = (Get-Item $pkg.InstallLocation).CreationTime.ToString("yyyy-MM-dd")
            }

            # Size estimation
            $sizeBytes = Get-FolderSize $pkg.InstallLocation

            # Display Name fallback
            $name = $pkg.Name
            # Parse manifest to find friendly name or logo if possible
            $manifestPath = Join-Path $pkg.InstallLocation "AppxManifest.xml"
            $displayName = $pkg.Name
            
            if (Test-Path $manifestPath) {
                try {
                    [xml]$xml = Get-Content $manifestPath -Raw -ErrorAction SilentlyContinue
                    $identity = $xml.Package.Identity
                    $visual = $xml.Package.Applications.Application.VisualElements
                    if ($visual.DisplayName) {
                        $displayName = $visual.DisplayName
                    }
                } catch {}
            }

            # If it references a resource string, keep the name as is or strip ms-resource
            if ($displayName -match "ms-resource:") {
                # Fallback to package Name (human readable part before publisher)
                $displayName = $pkg.Name.Split(".")[-1]
            }

            $id = "UWP_$($pkg.PackageFullName)"
            # SEC-1: uninstallString is DISPLAY ONLY for a UWP package. Removal
            # goes through the remove-appx action with the package full name, so
            # nothing here is ever executed as a command line.
            $uninstallCmd = "Remove-AppxPackage -Package $($pkg.PackageFullName)"

            $apps.Add([PSCustomObject]@{
                id              = $id
                name            = $displayName
                publisher       = $pkg.PublisherId
                version         = $pkg.Version
                installDate     = $date
                packageFullName = [string]$pkg.PackageFullName
                uninstallString = $uninstallCmd
                installLocation = $pkg.InstallLocation
                icon            = "" # Will use generic fallback in UI
                registryPath    = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages\$($pkg.PackageFullName)"
                type            = "UWP"
                sizeBytes       = $sizeBytes
            })
        }
    } catch {}

    return $apps | Sort-Object name
}

# 3. Create Windows System Restore Point
#
# REQ-13: Windows rate-limits restore points to one per 24h by default, which
# would leave every app after the first in a bulk queue with no checkpoint. The
# frequency value is temporarily set to 0 around the checkpoint and restored in
# a finally block, so the machine never keeps the relaxed setting.
function Create-RestorePoint {
    param([object]$p)

    $srKey  = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore"
    $srName = "SystemRestorePointCreationFrequency"
    $priorValue = $null
    $valueExisted = $false
    $overrodeFrequency = $false

    try {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." } | ConvertTo-Json
        }

        $description = "Vanish Pre-Uninstall"
        if ($p -and $p.description) { $description = [string]$p.description }

        # Read and override the creation-frequency gate.
        try {
            if (-not (Test-Path $srKey)) { $null = New-Item -Path $srKey -Force }
            $existing = Get-ItemProperty -Path $srKey -Name $srName -ErrorAction SilentlyContinue
            if ($existing -and $null -ne $existing.$srName) {
                $priorValue = [int]$existing.$srName
                $valueExisted = $true
            }
            Set-ItemProperty -Path $srKey -Name $srName -Value 0 -Type DWord -ErrorAction Stop
            $overrodeFrequency = $true
        } catch {
            # Not fatal: without the override we simply inherit the 24h gate.
            $overrodeFrequency = $false
        }

        Checkpoint-Computer -Description $description -RestorePointType APPLICATION_UNINSTALL -ErrorAction Stop
        return @{ success = $true; frequencyOverridden = $overrodeFrequency } | ConvertTo-Json
    } catch {
        $msg = $_.Exception.Message
        if ($msg -match "restore point cannot be created because one has already been created") {
            return @{ success = $true; note = "Skipped restore point: one was already created in the last 24 hours." } | ConvertTo-Json
        }
        return @{ success = $false; error = $msg } | ConvertTo-Json
    } finally {
        # Always hand the machine back exactly as it was found.
        if ($overrodeFrequency) {
            try {
                if ($valueExisted) {
                    Set-ItemProperty -Path $srKey -Name $srName -Value $priorValue -Type DWord -ErrorAction Stop
                } else {
                    Remove-ItemProperty -Path $srKey -Name $srName -ErrorAction SilentlyContinue
                }
            } catch {}
        }
    }
}

# 4. Deep Scan Leftovers
function Scan-Leftovers {
    param(
        [string]$appName,
        [string]$publisher,
        [string]$installLocation,
        [string]$mode
    )

    $leftovers = @{
        files = @()
        registry = @()
    }

    if ([string]::IsNullOrWhiteSpace($appName)) {
        return $leftovers | ConvertTo-Json -Depth 5
    }

    # Clean App Name for wildcards
    $cleanAppName = $appName -replace '[^\w\s-]', ''
    $cleanAppName = $cleanAppName.Trim()
    
    $cleanPublisher = ""
    if (-not [string]::IsNullOrWhiteSpace($publisher) -and $publisher -ne "Unknown Publisher") {
        $cleanPublisher = $publisher -replace '[^\w\s-]', ''
        $cleanPublisher = $cleanPublisher.Trim()
    }

    # Gather scan directories
    $scanDirs = @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramData,
        $env:LOCALAPPDATA,
        $env:APPDATA,
        (Join-Path $env:USERPROFILE "Documents")
    )

    $registryRoots = @("HKCU:\Software", "HKLM:\Software")
    # If 64-bit OS, include Wow6432Node
    if (Test-Path "HKLM:\Software\Wow6432Node") {
        $registryRoots += "HKLM:\Software\Wow6432Node"
    }

    # Retrieve all currently installed applications (for publisher sharing checks)
    $allApps = @()
    if ($mode -eq "Moderate" -or $mode -eq "Advanced") {
        $allApps = Get-InstalledApps
    }

    # Helper to check if publisher is shared by other installed apps
    function Is-PublisherShared {
        param([string]$pubName)
        if ([string]::IsNullOrWhiteSpace($pubName) -or $pubName -eq "Unknown Publisher") { return $false }
        $matching = $allApps | Where-Object { $_.publisher -like "*$pubName*" -and $_.name -ne $appName }
        return ($matching.Count -gt 0)
    }

    $filesList = [System.Collections.Generic.List[PSCustomObject]]::new()
    $regList = [System.Collections.Generic.List[PSCustomObject]]::new()

    # --- FILESYSTEM SCAN ---
    # Safe Mode: Only check the InstallLocation and exact app folder matches
    if ($mode -eq "Safe") {
        if (-not [string]::IsNullOrWhiteSpace($installLocation) -and (Test-Path $installLocation)) {
            $filesList.Add(@{ path = $installLocation; type = "Directory"; risk = "Safe" })
        }
        foreach ($dir in $scanDirs) {
            $exactPath = Join-Path $dir $appName
            if (Test-Path $exactPath) {
                $filesList.Add(@{ path = $exactPath; type = "Directory"; risk = "Safe" })
            }
        }
    }
    # Moderate Mode: Check exact and partial matches, publisher sub-folders
    elseif ($mode -eq "Moderate") {
        if (-not [string]::IsNullOrWhiteSpace($installLocation) -and (Test-Path $installLocation)) {
            $filesList.Add(@{ path = $installLocation; type = "Directory"; risk = "Safe" })
        }
        
        foreach ($baseDir in $scanDirs) {
            if (-not (Test-Path $baseDir)) { continue }
            
            # Check for directories containing App Name
            $matchedDirs = Get-ChildItem -Path $baseDir -Directory -ErrorAction SilentlyContinue | 
                           Where-Object { $_.Name -like "*$cleanAppName*" }
                           
            foreach ($md in $matchedDirs) {
                $filesList.Add(@{ path = $md.FullName; type = "Directory"; risk = "Safe" })
            }

            # Check publisher directory
            if (-not [string]::IsNullOrEmpty($cleanPublisher)) {
                $pubDir = Join-Path $baseDir $cleanPublisher
                if (Test-Path $pubDir) {
                    # If other apps share the publisher, scan within it, but do NOT delete the root publisher folder
                    if (Is-PublisherShared $cleanPublisher) {
                        # Search for app subfolder inside publisher folder
                        $subDirs = Get-ChildItem -Path $pubDir -Directory -ErrorAction SilentlyContinue |
                                   Where-Object { $_.Name -like "*$cleanAppName*" }
                        foreach ($sd in $subDirs) {
                            $filesList.Add(@{ path = $sd.FullName; type = "Directory"; risk = "Safe" })
                        }
                    } else {
                        # Safe to suggest deleting whole publisher folder if only this app uses it
                        $filesList.Add(@{ path = $pubDir; type = "Directory"; risk = "Moderate" })
                    }
                }
            }
        }
    }
    # Advanced Mode: Deeper matching, scanning user profile and common temp locations
    elseif ($mode -eq "Advanced") {
        if (-not [string]::IsNullOrWhiteSpace($installLocation) -and (Test-Path $installLocation)) {
            $filesList.Add(@{ path = $installLocation; type = "Directory"; risk = "Safe" })
        }

        # Add temp paths
        $extendedScanDirs = $scanDirs + @($env:TEMP, "C:\ProgramData")

        foreach ($baseDir in $extendedScanDirs) {
            if (-not (Test-Path $baseDir)) { continue }

            # Locate anything matching the app name
            $matchedItems = Get-ChildItem -Path $baseDir -ErrorAction SilentlyContinue | 
                            Where-Object { $_.Name -like "*$cleanAppName*" -or $_.Name -replace '[\s-]','' -like "*$($cleanAppName -replace '\s','')*" }

            foreach ($item in $matchedItems) {
                $type = if ($item.PSIsContainer) { "Directory" } else { "File" }
                $risk = if ($item.FullName -like "*$cleanAppName*") { "Safe" } else { "Advanced" }
                $filesList.Add(@{ path = $item.FullName; type = $type; risk = $risk })
            }
        }
    }

    # --- REGISTRY SCAN ---
    # Safe Mode: Check standard paths
    if ($mode -eq "Safe") {
        foreach ($root in $registryRoots) {
            if (-not (Test-Path $root)) { continue }
            $pathsToCheck = @()
            if (-not [string]::IsNullOrEmpty($cleanPublisher)) {
                $pathsToCheck += Join-Path $root "$cleanPublisher\$cleanAppName"
                $pathsToCheck += Join-Path $root "$cleanPublisher\$appName"
            }
            $pathsToCheck += Join-Path $root $cleanAppName
            $pathsToCheck += Join-Path $root $appName

            foreach ($p in $pathsToCheck) {
                if (Test-Path $p) {
                    $regList.Add(@{ path = $p; type = "Key"; risk = "Safe" })
                }
            }
        }
    }
    # Moderate & Advanced Mode: Query Registry for Subkeys matching App/Publisher
    else {
        foreach ($root in $registryRoots) {
            if (-not (Test-Path $root)) { continue }

            # Retrieve top-level and second-level subkeys (faster than recursive search of whole registry)
            # Level 1: HKLM:\Software\<SubKey>
            $subKeysL1 = Get-ChildItem -Path $root -ErrorAction SilentlyContinue
            foreach ($k1 in $subKeysL1) {
                $isMatch = $k1.PSChildName -like "*$cleanAppName*"
                $isPubMatch = -not [string]::IsNullOrEmpty($cleanPublisher) -and ($k1.PSChildName -like "*$cleanPublisher*")

                if ($isMatch) {
                    $regList.Add(@{ path = $k1.PSPath; type = "Key"; risk = "Safe" })
                }
                elseif ($isPubMatch) {
                    # If shared, scan Level 2 keys under publisher folder
                    if (Is-PublisherShared $cleanPublisher) {
                        $subKeysL2 = Get-ChildItem -Path $k1.PSPath -ErrorAction SilentlyContinue |
                                     Where-Object { $_.PSChildName -like "*$cleanAppName*" }
                        foreach ($k2 in $subKeysL2) {
                            $regList.Add(@{ path = $k2.PSPath; type = "Key"; risk = "Safe" })
                        }
                    } else {
                        # Delete entire publisher key
                        $regList.Add(@{ path = $k1.PSPath; type = "Key"; risk = "Moderate" })
                    }
                }
                else {
                    # Scan Level 2 for App Name match under non-publisher folders
                    $subKeysL2 = Get-ChildItem -Path $k1.PSPath -ErrorAction SilentlyContinue |
                                 Where-Object { $_.PSChildName -like "*$cleanAppName*" }
                    foreach ($k2 in $subKeysL2) {
                        $regList.Add(@{ path = $k2.PSPath; type = "Key"; risk = "Safe" })
                    }
                }
            }
        }
    }

    # Ensure uniqueness of paths and filter non-existent paths
    $uniqueFiles = @()
    $uniqueReg = @()
    $seenPaths = @{}

    foreach ($f in $filesList) {
        if (-not $seenPaths.ContainsKey($f.path.ToLower()) -and (Test-Path $f.path)) {
            $seenPaths[$f.path.ToLower()] = $true
            $uniqueFiles += $f
        }
    }

    $seenReg = @{}
    foreach ($r in $regList) {
        $cleanPath = $r.path
        if ($cleanPath -match 'Microsoft.PowerShell.Core\\Registry::(.*)') {
            $cleanPath = $Matches[1]
        }
        if (-not $seenReg.ContainsKey($cleanPath.ToLower()) -and (Test-Path $r.path)) {
            $seenReg[$cleanPath.ToLower()] = $true
            # Format registry path for output
            $r.path = $cleanPath
            $uniqueReg += $r
        }
    }

    $leftovers.files = $uniqueFiles
    $leftovers.registry = $uniqueReg

    return $leftovers | ConvertTo-Json -Depth 5
}

# 5. Purge Remnants -- REMOVED in TASK-02 (promptgate Rule 2, INV-1).
# The direct-delete purge that used to live here is gone. Every removal now
# routes through Invoke-QuarantineItems below: files move to the vault,
# registry keys export to a .reg restore manifest before removal. The only
# code in this file that deletes a user path outright is Invoke-VaultDelete
# ("Delete Forever" / retention auto-purge), which acts on vault payloads the
# user has explicitly chosen to destroy.

# 5.5 Check Admin Elevation - WindowsPrincipal API (Promptgate Rule 13; replaces banned 'net session')
function Check-AdminStatus {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    return @{ isAdmin = $isAdmin } | ConvertTo-Json
}

# ==========================================
# STAGE 2 - AUDIT & HEALTH ADVISOR BACKEND
# ==========================================

# 6. System Diagnostics (CIM-based, narrow SELECT to minimise latency)
function Get-SystemDiagnostics {
    # Elevation check via WindowsPrincipal (Rule 13)
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    # --- OS Info ---
    $os = $null
    try {
        $os = Get-CimInstance -Query "SELECT Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime, FreePhysicalMemory, TotalVisibleMemorySize FROM Win32_OperatingSystem" -ErrorAction Stop
    } catch {}

    # --- CPU ---
    $cpu = $null
    try {
        $cpu = Get-CimInstance -Query "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed FROM Win32_Processor" -ErrorAction Stop
    } catch {}

    # --- RAM totals from OS query (already fetched above) ---
    $ramTotalGB = if ($os -and $os.TotalVisibleMemorySize) { [math]::Round($os.TotalVisibleMemorySize / 1MB, 1) } else { $null }
    $ramFreeGB  = if ($os -and $os.FreePhysicalMemory)     { [math]::Round($os.FreePhysicalMemory     / 1MB, 1) } else { $null }

    # --- Disk volumes (filter to local fixed drives only) ---
    $disks = @()
    try {
        $volumes = Get-CimInstance -Query "SELECT DriveLetter, Size, FreeSpace, VolumeName FROM Win32_LogicalDisk WHERE DriveType=3" -ErrorAction Stop
        foreach ($v in $volumes) {
            if (-not $v.DriveLetter) { continue }
            $totalGB = if ($v.Size)      { [math]::Round($v.Size      / 1GB, 1) } else { 0 }
            $freeGB  = if ($v.FreeSpace) { [math]::Round($v.FreeSpace / 1GB, 1) } else { 0 }
            $usedGB  = [math]::Round($totalGB - $freeGB, 1)
            $pctUsed = if ($totalGB -gt 0) { [math]::Round(($usedGB / $totalGB) * 100, 1) } else { 0 }
            $disks += @{
                drive    = $v.DriveLetter
                label    = if ($v.VolumeName) { $v.VolumeName } else { "Local Disk" }
                totalGB  = $totalGB
                freeGB   = $freeGB
                usedGB   = $usedGB
                pctUsed  = $pctUsed
            }
        }
    } catch {}

    # --- BIOS / Manufacturer ---
    $manufacturer = $null; $model = $null
    try {
        $cs = Get-CimInstance -Query "SELECT Manufacturer, Model FROM Win32_ComputerSystem" -ErrorAction Stop
        $manufacturer = $cs.Manufacturer
        $model        = $cs.Model
    } catch {}

    # --- GPU ---
    $gpuName = $null
    try {
        $gpu = Get-CimInstance -Query "SELECT Name FROM Win32_VideoController" -ErrorAction Stop | Select-Object -First 1
        $gpuName = if ($gpu) { $gpu.Name } else { $null }
    } catch {}

    # --- Uptime ---
    $uptimeHours = $null
    try {
        if ($os -and $os.LastBootUpTime) {
            $uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
        }
    } catch {}

    return @{
        isAdmin      = $isAdmin
        os           = @{
            caption       = if ($os) { $os.Caption }       else { "Unknown" }
            version       = if ($os) { $os.Version }       else { "Unknown" }
            build         = if ($os) { $os.BuildNumber }   else { "Unknown" }
            architecture  = if ($os) { $os.OSArchitecture } else { "Unknown" }
            uptimeHours   = $uptimeHours
        }
        cpu          = @{
            name           = if ($cpu) { $cpu.Name }                     else { "Unknown" }
            cores          = if ($cpu) { $cpu.NumberOfCores }            else { $null }
            logicalCores   = if ($cpu) { $cpu.NumberOfLogicalProcessors } else { $null }
            maxClockMHz    = if ($cpu) { $cpu.MaxClockSpeed }            else { $null }
        }
        ram          = @{
            totalGB = $ramTotalGB
            freeGB  = $ramFreeGB
            usedGB  = if ($ramTotalGB -and $ramFreeGB) { [math]::Round($ramTotalGB - $ramFreeGB, 1) } else { $null }
            pctUsed = if ($ramTotalGB -and $ramFreeGB -and $ramTotalGB -gt 0) { [math]::Round((($ramTotalGB - $ramFreeGB) / $ramTotalGB) * 100, 1) } else { $null }
        }
        gpu          = $gpuName
        manufacturer = $manufacturer
        model        = $model
        disks        = $disks
    }
}

# 7. Startup Item Enumerator (Registry Run keys + Task Scheduler + Auto-start Services)
function Get-StartupItems {
    $items = [System.Collections.Generic.List[PSCustomObject]]::new()

    # --- Registry Run Keys ---
    $runHives = @(
        @{ Path = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run";        Hive = "HKLM (64-bit)" },
        @{ Path = "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run"; Hive = "HKLM (32-bit)" },
        @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run";        Hive = "HKCU" },
        @{ Path = "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce";    Hive = "HKLM RunOnce" },
        @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce";    Hive = "HKCU RunOnce" }
    )
    foreach ($hive in $runHives) {
        if (Test-Path $hive.Path) {
            try {
                $props = Get-ItemProperty -Path $hive.Path -ErrorAction SilentlyContinue
                if ($props) {
                    $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
                        $cmd = $_.Value.ToString()
                        # Attempt to resolve executable path from the command string
                        $exePath = $null
                        if ($cmd -match '"([^"]+\.exe)"') { $exePath = $Matches[1] }
                        elseif ($cmd -match '^([^\s]+\.exe)') { $exePath = $Matches[1] }
                        $items.Add([PSCustomObject]@{
                            name        = $_.Name
                            command     = $cmd
                            exePath     = $exePath
                            exeExists   = if ($exePath) { Test-Path $exePath } else { $null }
                            source      = "Registry"
                            sourceDetail = $hive.Hive
                            enabled     = $true
                        })
                    }
                }
            } catch {}
        }
    }

    # --- Task Scheduler (logon-triggered tasks, not Windows built-ins) ---
    try {
        $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
            $_.State -ne 'Disabled' -and
            $_.TaskPath -notlike '\Microsoft\*' -and
            ($_.Triggers | Where-Object { $_ -and $_.CimClass.CimClassName -like '*Logon*' -or $_.CimClass.CimClassName -like '*Boot*' })
        } | Select-Object -First 80  # cap to avoid very long scans
        foreach ($task in $tasks) {
            $action   = $task.Actions | Select-Object -First 1
            $exePath  = if ($action) { $action.Execute } else { $null }
            $items.Add([PSCustomObject]@{
                name         = $task.TaskName
                command      = if ($action) { "$($action.Execute) $($action.Arguments)" } else { "" }
                exePath      = $exePath
                exeExists    = if ($exePath) { Test-Path $exePath } else { $null }
                source       = "TaskScheduler"
                sourceDetail = $task.TaskPath
                enabled      = ($task.State -eq 'Ready' -or $task.State -eq 'Running')
            })
        }
    } catch {}

    # --- Auto-start Services (non-Microsoft, StartMode=Auto) ---
    try {
        $services = Get-CimInstance -Query "SELECT Name, DisplayName, PathName, StartMode, State FROM Win32_Service WHERE StartMode='Auto'" -ErrorAction SilentlyContinue
        foreach ($svc in $services) {
            # Skip Windows-native services
            $exePath = $null
            if ($svc.PathName -match '"([^"]+\.exe)"') { $exePath = $Matches[1] }
            elseif ($svc.PathName -match '^([^\s]+\.exe)') { $exePath = $Matches[1] }
            
            # Heuristic: skip services whose executables live under System32/SysWOW64
            $isMsPath = $exePath -and ($exePath -like "*\System32\*" -or $exePath -like "*\SysWOW64\*" -or $exePath -like "*\Windows\*")
            if ($isMsPath) { continue }

            $items.Add([PSCustomObject]@{
                name         = $svc.DisplayName
                command      = $svc.PathName
                exePath      = $exePath
                exeExists    = if ($exePath) { Test-Path $exePath } else { $null }
                source       = "Service"
                sourceDetail = "StartMode=Auto | State=$($svc.State)"
                enabled      = ($svc.State -eq 'Running')
            })
        }
    } catch {}

    return @{
        items = $items
        total = $items.Count
        orphans = ($items | Where-Object { $_.exeExists -eq $false }).Count
    }
}

# 8. Software Redundancy Detector (groups installed apps by category keyword clusters)
function Get-SoftwareRedundancy {
    $installedApps = Get-InstalledApps

    # Category keyword map: category => list of name keywords (case-insensitive)
    $categories = @{
        "Web Browser"         = @("chrome","firefox","edge","opera","brave","vivaldi","safari","tor browser","maxthon","waterfox","librewolf","seamonkey","pale moon")
        "PDF Reader"          = @("adobe reader","adobe acrobat","foxit","sumatra pdf","nitro pdf","pdf-xchange","pdf viewer","evince","okular","pdf24")
        "Video Player"        = @("vlc","mpc-hc","mpc-be","potplayer","kmplayer","gom player","media player classic","kodi","plex","mpv","daum","zoom player")
        "Audio Player"        = @("itunes","winamp","foobar2000","aimp","musicbee","groove","spotify","clementine","vox","dopamine")
        "Compression Tool"    = @("winrar","7-zip","winzip","bandzip","peazip","izarc","hamster zip","nanazip")
        "Screenshot / Screen" = @("snagit","greenshot","lightshot","picpick","sharex","flameshot","screenpresso","hypersnap")
        "Antivirus / Security"= @("avast","avg","avira","bitdefender","kaspersky","norton","mcafee","malwarebytes","eset","defender","sophos","trend micro","f-secure","webroot","comodo")
        "Download Manager"    = @("idm","internet download manager","freedownload manager","jdownloader","xtreme download","download accelerator")
        "Note Taking"         = @("notion","obsidian","onenote","evernote","notepad++","roam research","logseq","joplin","simplenote","bear","zettlr")
        "Remote Desktop"      = @("teamviewer","anydesk","rustdesk","chrome remote","parsec","nomachine","remote desktop","vnc","ultraviewer","zoho assist","splashtop")
        "Code Editor / IDE"   = @("visual studio code","vscode","sublime text","atom","notepad++","brackets","eclipse","intellij","pycharm","webstorm","android studio","xcode","vim","emacs","neovim")
        "Office Suite"        = @("microsoft office","libreoffice","openoffice","wps office","softmaker","kingsoft","google docs","onlyoffice")
        "Image Editor"        = @("photoshop","gimp","affinity photo","paint.net","krita","lightroom","luminar","capture one","darktable","pixelmator")
        "Virtual Machine"     = @("vmware","virtualbox","hyper-v","parallels","qemu","utm","virt-manager","virtualpc")
    }

    $groups = [System.Collections.Generic.List[PSCustomObject]]::new()

    foreach ($catName in $categories.Keys) {
        $keywords  = $categories[$catName]
        $matched   = [System.Collections.Generic.List[PSCustomObject]]::new()

        foreach ($app in $installedApps) {
            $nameLower = $app.name.ToLower()
            foreach ($kw in $keywords) {
                if ($nameLower -like "*$kw*") {
                    $matched.Add([PSCustomObject]@{
                        id        = $app.id
                        name      = $app.name
                        publisher = $app.publisher
                        version   = $app.version
                        sizeBytes = $app.sizeBytes
                    })
                    break  # don't double-count an app matching multiple keywords in same category
                }
            }
        }

        if ($matched.Count -gt 1) {
            $groups.Add([PSCustomObject]@{
                category = $catName
                count    = $matched.Count
                apps     = $matched
                tip      = "You have $($matched.Count) $catName applications installed. Consider keeping only one."
            })
        }
    }

    return @{
        groups = $groups
        hasRedundancy = ($groups.Count -gt 0)
    }
}

# ==========================================
# PHASE 1 - QUARANTINE VAULT ENGINE (promptgate Rule 2)
# ==========================================
# Contract: this engine MOVES payloads and EXPORTS registry keys. It never
# writes the shared vault manifest -- main.js is the single writer for
# manifest.json / oplog.jsonl (04-schema.md rule 7). The engine does write a
# self-describing entry.json inside each entry folder (single writer: engine)
# so an interrupted purge is still recoverable.

# Normalise any registry path form to the reg.exe form (HKLM\Software\Foo).
function ConvertTo-RegExePath {
    param([string]$path)
    if ([string]::IsNullOrWhiteSpace($path)) { return $null }
    $p = $path
    # Strip PowerShell provider prefixes
    if ($p -match 'Microsoft\.PowerShell\.Core\\Registry::(.*)') { $p = $Matches[1] }
    $p = $p -replace '^Registry::', ''
    $map = @(
        @{ From = '^HKLM:\\';                 To = 'HKLM\' },
        @{ From = '^HKCU:\\';                 To = 'HKCU\' },
        @{ From = '^HKCR:\\';                 To = 'HKCR\' },
        @{ From = '^HKU:\\';                  To = 'HKU\'  },
        @{ From = '^HKCC:\\';                 To = 'HKCC\' },
        @{ From = '^HKEY_LOCAL_MACHINE\\';    To = 'HKLM\' },
        @{ From = '^HKEY_CURRENT_USER\\';     To = 'HKCU\' },
        @{ From = '^HKEY_CLASSES_ROOT\\';     To = 'HKCR\' },
        @{ From = '^HKEY_USERS\\';            To = 'HKU\'  },
        @{ From = '^HKEY_CURRENT_CONFIG\\';   To = 'HKCC\' }
    )
    foreach ($m in $map) {
        if ($p -match $m.From) { return ($p -replace $m.From, $m.To) }
    }
    return $p
}

# Normalise any registry path form to the PowerShell provider form (HKLM:\Software\Foo).
function ConvertTo-PSRegPath {
    param([string]$path)
    $p = ConvertTo-RegExePath $path
    if (-not $p) { return $null }
    # Only HKLM: and HKCU: are mounted as PowerShell drives by default. HKCR,
    # HKU and HKCC must go through the Registry:: provider or every Test-Path
    # against them silently reports "not found".
    $map = @(
        @{ From = '^HKLM\\'; To = 'HKLM:\' },
        @{ From = '^HKCU\\'; To = 'HKCU:\' },
        @{ From = '^HKCR\\'; To = 'Registry::HKEY_CLASSES_ROOT\' },
        @{ From = '^HKU\\';  To = 'Registry::HKEY_USERS\' },
        @{ From = '^HKCC\\'; To = 'Registry::HKEY_CURRENT_CONFIG\' }
    )
    foreach ($m in $map) {
        if ($p -match $m.From) { return ($p -replace $m.From, $m.To) }
    }
    return $p
}

function Test-IsElevated {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---- Vault input validation (security review 2026-08-03, Vuln 1) ----------
#
# manifest.json and the vault payloads live under the Electron userData path,
# which a standard user can write to, but the engine acts on them ELEVATED.
# Every path that arrives from the manifest is therefore untrusted input, not
# internal state. Validate at the privilege boundary, here, not in the renderer.

# Entry ids are app-generated UUIDv4 (schema rule 4). Anything else - notably
# anything containing a separator - is an attempt to escape the vault root.
function Test-VaultEntryId {
    param([string]$entryId)
    if ([string]::IsNullOrWhiteSpace($entryId)) { return $false }
    return ($entryId -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
}

# Resolve a manifest-supplied relative path and prove the result is still
# inside the entry folder. Defeats "..\..\..\Windows\System32\x" payloads.
function Resolve-SafeVaultPath {
    param([string]$entryDir, [string]$relative)
    if ([string]::IsNullOrWhiteSpace($relative)) { return $null }
    # Reject the obvious before touching the filesystem.
    if ($relative -match '(^|[\\/])\.\.([\\/]|$)') { return $null }
    if ($relative -match '^[A-Za-z]:' -or $relative -match '^[\\/]{2}') { return $null }

    try {
        $entryFull = [System.IO.Path]::GetFullPath($entryDir)
        if (-not $entryFull.EndsWith('\')) { $entryFull += '\' }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $entryDir ($relative -replace '/', '\')))
        if (-not $candidate.StartsWith($entryFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
        return $candidate
    } catch {
        return $null
    }
}

# SEC-2: GetFullPath is a TEXTUAL normalisation - it does not follow junctions.
# Any path-based refusal is therefore bypassable by pre-creating a directory
# junction at an allowed path that points at a blocked one: the check sees
# %APPDATA%\Foo, the move lands in the all-users Startup folder. Walk up to the
# deepest ancestor that actually exists, resolve it, and re-attach the rest, so
# the check is made against the path the write really lands on.
function Resolve-DestinationTarget {
    param([string]$full)

    $tail  = @()
    $probe = $full

    for ($i = 0; $i -lt 64; $i++) {
        if ([string]::IsNullOrWhiteSpace($probe)) { break }

        if (Test-Path -LiteralPath $probe) {
            try {
                $item   = Get-Item -LiteralPath $probe -Force -ErrorAction Stop
                $target = $item.FullName

                if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    $link = $null
                    try { $link = @($item.Target)[0] } catch { $link = $null }
                    if ($link) {
                        if (-not [System.IO.Path]::IsPathRooted($link)) {
                            $link = Join-Path (Split-Path -Parent $probe) $link
                        }
                        $target = [System.IO.Path]::GetFullPath($link)
                    } else {
                        # A reparse point we cannot read is not one we trust.
                        return $null
                    }
                }

                if ($tail.Count -eq 0) { return $target }
                return [System.IO.Path]::GetFullPath((Join-Path $target ($tail -join '\')))
            } catch {
                return $null
            }
        }

        $parent = Split-Path -Parent $probe
        if (-not $parent -or $parent -eq $probe) { break }
        $leaf = Split-Path -Leaf $probe
        if ($leaf) { $tail = ,$leaf + $tail }
        $probe = $parent
    }

    return $full
}

# Restoring is a file WRITE performed as administrator to a location the
# manifest chose, and the manifest is untrusted input. Refuse destinations that
# are privileged execution surfaces.
#
# SEC-2 note on what is deliberately NOT blocked: %ProgramFiles%, %ProgramData%
# and other user profiles all stay allowed, because Vanish legitimately
# quarantines application leftovers from all three (REQ-17 sweeps other
# profiles by design) and a restore has to be able to put them back. Blocking
# them would break the undo path, which is the whole point of the vault. What
# gets blocked instead is the narrow set of locations whose only use to an
# attacker is privileged execution.
function Test-ProtectedDestination {
    param([string]$path)
    if ([string]::IsNullOrWhiteSpace($path)) { return $true }

    try {
        $full = [System.IO.Path]::GetFullPath($path)
    } catch {
        return $true
    }

    $resolved = Resolve-DestinationTarget $full
    if (-not $resolved) { return $true }   # unreadable or untrusted reparse point

    # Any Start Menu subtree, in any profile or the all-users one. This is the
    # autostart surface: a file landing here runs at logon, and for the
    # all-users copy it runs for administrators too.
    foreach ($candidate in @($full, $resolved)) {
        if ($candidate -match '(^|\\)Start Menu(\\|$)') { return $true }
    }

    # A direct child of a drive root ("C:\Foo") is where bare-path and DLL
    # search-order hijacks get planted. Restores never legitimately land there.
    foreach ($candidate in @($full, $resolved)) {
        $root = [System.IO.Path]::GetPathRoot($candidate)
        if (-not $root) { continue }
        $parent = [System.IO.Path]::GetDirectoryName($candidate)
        if ([string]::IsNullOrEmpty($parent)) { return $true }   # the root itself
        if ($parent.TrimEnd('\').Equals($root.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }

    $blocked = @(
        $env:SystemRoot,
        (Join-Path $env:SystemRoot 'System32'),
        (Join-Path $env:SystemRoot 'SysWOW64'),
        (Join-Path $env:SystemRoot 'WinSxS'),
        (Join-Path $env:SystemRoot 'INF'),
        (Join-Path $env:SystemRoot 'Boot'),
        $PSScriptRoot
    ) | Where-Object { $_ }

    foreach ($root in $blocked) {
        try { $rootFull = [System.IO.Path]::GetFullPath($root) } catch { continue }
        if (-not $rootFull.EndsWith('\')) { $rootFull += '\' }
        # Block the directory itself and everything beneath it - measured
        # against BOTH the literal path and the junction-resolved one.
        foreach ($candidate in @($full, $resolved)) {
            if ($candidate.Equals($rootFull.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
            if ($candidate.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
    }
    return $false
}

function Get-ItemSizeBytes {
    param([string]$path)
    try {
        if (-not (Test-Path -LiteralPath $path)) { return 0 }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum
            if ($sum) { return [long]$sum } else { return 0 }
        }
        return [long]$item.Length
    } catch { return 0 }
}

# Move one filesystem item, all-or-nothing (NFR-01).
# Returns $null on success, an error string on failure (source left untouched).
function Move-ItemTransactional {
    param([string]$source, [string]$destination)
    $isDir = $false
    try { $isDir = (Get-Item -LiteralPath $source -Force -ErrorAction Stop).PSIsContainer } catch { return $_.Exception.Message }

    try {
        if ($isDir) { [System.IO.Directory]::Move($source, $destination) }
        else        { [System.IO.File]::Move($source, $destination) }
        return $null
    } catch {
        $moveError = $_.Exception.Message
    }

    # Cross-volume or locked-rename fallback: copy, verify, then delete source.
    try {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force -ErrorAction Stop
    } catch {
        if (Test-Path -LiteralPath $destination) {
            Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
        }
        return "Move failed ($moveError); copy fallback failed ($($_.Exception.Message))"
    }

    try {
        Remove-Item -LiteralPath $source -Recurse -Force -ErrorAction Stop
        return $null
    } catch {
        # Source survived: roll the copy back so the item is untouched, not duplicated.
        Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
        return "Source is locked or protected: $($_.Exception.Message)"
    }
}

# Quarantine files and registry keys into vault/<entryId>/.
function Invoke-QuarantineItems {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or [string]::IsNullOrWhiteSpace($p.vaultRoot) -or [string]::IsNullOrWhiteSpace($p.entryId)) {
        return @{ success = $false; error = "vaultRoot and entryId are required." }
    }
    if (-not (Test-VaultEntryId $p.entryId)) {
        return @{ success = $false; error = "Rejected: entry id is not a UUID." }
    }

    $entryDir = Join-Path $p.vaultRoot $p.entryId
    $filesDir = Join-Path $entryDir "files"
    $regDir   = Join-Path $entryDir "registry"

    try {
        $null = [System.IO.Directory]::CreateDirectory($entryDir)
        $null = [System.IO.Directory]::CreateDirectory($filesDir)
        $null = [System.IO.Directory]::CreateDirectory($regDir)
    } catch {
        return @{ success = $false; error = "Could not create vault entry folder: $($_.Exception.Message)" }
    }

    $fileRows = [System.Collections.Generic.List[object]]::new()
    $regRows  = [System.Collections.Generic.List[object]]::new()
    $idx = 0

    foreach ($f in @($p.files)) {
        if (-not $f -or [string]::IsNullOrWhiteSpace($f.path)) { continue }
        $idx++
        $src = $f.path
        $row = @{
            index        = $idx
            originalPath = $src
            vaultRelative = $null
            sizeBytes    = 0
            status       = "failed"
            error        = $null
            aclElevated  = $false
        }

        if (-not (Test-Path -LiteralPath $src)) {
            $row.status = "missing"
            $row.error  = "Path no longer exists."
            $fileRows.Add($row)
            continue
        }

        $row.sizeBytes = Get-ItemSizeBytes $src
        $leaf    = Split-Path -Path $src -Leaf
        if ([string]::IsNullOrWhiteSpace($leaf)) { $leaf = "item" }
        $slotDir = Join-Path $filesDir "$idx"
        $dest    = Join-Path $slotDir $leaf

        try { $null = [System.IO.Directory]::CreateDirectory($slotDir) } catch {}

        $err = Move-ItemTransactional -source $src -destination $dest

        # REQ-19 ownership elevator: retry once with explicit ownership when the
        # caller asked for it and the first attempt was denied.
        if ($err -and $p.allowOwnershipElevation -eq $true -and $err -match 'denied|Access|protected|locked') {
            $taken = Grant-VanishOwnership -path $src
            if ($taken) {
                $err = Move-ItemTransactional -source $src -destination $dest
                if (-not $err) { $row.aclElevated = $true }
            }
        }

        if ($err) {
            $row.status = "failed"
            $row.error  = $err
            Remove-Item -LiteralPath $slotDir -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            $row.status        = "quarantined"
            $row.vaultRelative = "files/$idx/$leaf"
        }
        $fileRows.Add($row)
    }

    $ridx = 0
    foreach ($r in @($p.registry)) {
        if (-not $r -or [string]::IsNullOrWhiteSpace($r.path)) { continue }
        $ridx++
        $regExePath = ConvertTo-RegExePath $r.path
        $psPath     = ConvertTo-PSRegPath  $r.path
        # mode=remove (default): export the key, then delete it.
        # mode=manifest-only: export the key as the restore manifest and LEAVE
        # it in place - used when the caller edits a value rather than deleting
        # a key (REQ-15 PATH cleaner). Restore is identical either way: the
        # .reg import puts the prior state back.
        $mode = if ($r.mode) { [string]$r.mode } else { "remove" }

        $row = @{
            index    = $ridx
            keyPath  = $regExePath
            regFile  = $null
            status   = "failed"
            error    = $null
            mode     = $mode
        }

        if (-not (Test-Path -LiteralPath $psPath)) {
            $row.status = "missing"
            $row.error  = "Key no longer exists."
            $regRows.Add($row)
            continue
        }

        $regFile = Join-Path $regDir "$ridx.reg"
        try {
            $null = & reg.exe export "$regExePath" "$regFile" /y 2>&1
            $exportOk = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $regFile) -and ((Get-Item -LiteralPath $regFile).Length -gt 0)
        } catch {
            $exportOk = $false
        }

        if (-not $exportOk) {
            $row.error = "Registry export failed; key left in place."
            Remove-Item -LiteralPath $regFile -Force -ErrorAction SilentlyContinue
            $regRows.Add($row)
            continue
        }

        if ($mode -eq "manifest-only") {
            $row.status  = "quarantined"
            $row.regFile = "registry/$ridx.reg"
            $regRows.Add($row)
            continue
        }

        try {
            Remove-Item -LiteralPath $psPath -Recurse -Force -ErrorAction Stop
            $row.status  = "quarantined"
            $row.regFile = "registry/$ridx.reg"
        } catch {
            $row.error = "Key export succeeded but removal failed: $($_.Exception.Message)"
            Remove-Item -LiteralPath $regFile -Force -ErrorAction SilentlyContinue
        }
        $regRows.Add($row)
    }

    $entry = @{
        schemaVersion = 1
        id            = $p.entryId
        sourceApp     = if ($p.sourceApp) { $p.sourceApp } else { "unknown" }
        origin        = if ($p.origin)    { $p.origin }    else { "purge" }
        createdAt     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        status        = "quarantined"
        files         = $fileRows
        registry      = $regRows
        meta          = @{}
    }

    # Engine-owned durability copy (see contract note above).
    try {
        $entryJson = $entry | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText((Join-Path $entryDir "entry.json"), $entryJson, [System.Text.UTF8Encoding]::new($false))
    } catch {}

    $quarantinedCount = @($fileRows | Where-Object { $_.status -eq "quarantined" }).Count +
                        @($regRows  | Where-Object { $_.status -eq "quarantined" }).Count

    # Nothing landed in the vault: remove the empty shell so the manifest stays clean.
    if ($quarantinedCount -eq 0) {
        Remove-Item -LiteralPath $entryDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    return @{
        success          = $true
        entry            = $entry
        quarantinedCount = $quarantinedCount
        entryPersisted   = ($quarantinedCount -gt 0)
    }
}

# Restore one vault entry to its original locations.
function Invoke-VaultRestore {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or -not $p.entry -or [string]::IsNullOrWhiteSpace($p.vaultRoot)) {
        return @{ success = $false; error = "vaultRoot and entry are required." }
    }
    if (-not (Test-VaultEntryId $p.entry.id)) {
        return @{ success = $false; error = "Rejected: entry id is not a UUID." }
    }

    $entryDir  = Join-Path $p.vaultRoot $p.entry.id
    $onConflict = if ($p.onConflict) { $p.onConflict } else { "skip" }   # skip | overwrite
    $fileResults = [System.Collections.Generic.List[object]]::new()
    $regResults  = [System.Collections.Generic.List[object]]::new()

    foreach ($f in @($p.entry.files)) {
        if (-not $f -or $f.status -ne "quarantined") { continue }
        $res = @{ originalPath = $f.originalPath; status = "failed"; error = $null }

        # The manifest is user-writable; the restore runs elevated. Both the
        # source it reads and the destination it writes are untrusted.
        $vaultPath = Resolve-SafeVaultPath -entryDir $entryDir -relative $f.vaultRelative
        if (-not $vaultPath) {
            $res.error = "Rejected: vault payload path escapes the entry folder."
            $fileResults.Add($res); continue
        }
        if (Test-ProtectedDestination $f.originalPath) {
            $res.error = "Rejected: refusing to restore into a protected system location."
            $fileResults.Add($res); continue
        }

        if (-not (Test-Path -LiteralPath $vaultPath)) {
            $res.error = "Vault payload missing."
            $fileResults.Add($res); continue
        }

        if (Test-Path -LiteralPath $f.originalPath) {
            if ($onConflict -eq "skip") {
                $res.status = "skipped"
                $res.error  = "Something already exists at the original path."
                $fileResults.Add($res); continue
            }
            try { Remove-Item -LiteralPath $f.originalPath -Recurse -Force -ErrorAction Stop }
            catch {
                $res.error = "Could not clear the existing path: $($_.Exception.Message)"
                $fileResults.Add($res); continue
            }
        }

        try {
            $parent = Split-Path -Path $f.originalPath -Parent
            if ($parent -and -not (Test-Path -LiteralPath $parent)) {
                $null = [System.IO.Directory]::CreateDirectory($parent)
            }
        } catch {}

        $err = Move-ItemTransactional -source $vaultPath -destination $f.originalPath
        if ($err) { $res.error = $err } else { $res.status = "restored" }
        $fileResults.Add($res)
    }

    foreach ($r in @($p.entry.registry)) {
        if (-not $r -or $r.status -ne "quarantined") { continue }
        $res = @{ keyPath = $r.keyPath; status = "failed"; error = $null }

        # reg.exe import applies whatever the file says, as administrator. The
        # file must provably be one we wrote inside this entry folder.
        $regFile = Resolve-SafeVaultPath -entryDir $entryDir -relative $r.regFile
        if (-not $regFile) {
            $res.error = "Rejected: restore manifest path escapes the entry folder."
            $regResults.Add($res); continue
        }

        if (-not (Test-Path -LiteralPath $regFile)) {
            $res.error = "Restore manifest (.reg) missing."
            $regResults.Add($res); continue
        }
        try {
            $null = & reg.exe import "$regFile" 2>&1
            if ($LASTEXITCODE -eq 0) { $res.status = "restored" }
            else { $res.error = "reg.exe import returned exit code $LASTEXITCODE." }
        } catch {
            $res.error = $_.Exception.Message
        }
        $regResults.Add($res)
    }

    $failed = @($fileResults | Where-Object { $_.status -eq "failed" }).Count +
              @($regResults  | Where-Object { $_.status -eq "failed" }).Count

    return @{
        success  = $true
        files    = $fileResults
        registry = $regResults
        failed   = $failed
    }
}

# Permanently remove one vault entry folder. One of the only two direct-delete
# paths allowed by INV-1 (the other is retention auto-purge, which calls this).
function Invoke-VaultDelete {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or [string]::IsNullOrWhiteSpace($p.vaultRoot) -or [string]::IsNullOrWhiteSpace($p.entryId)) {
        return @{ success = $false; error = "vaultRoot and entryId are required." }
    }
    # This is a recursive force-delete running as administrator. An entry id of
    # "..\..\..\Windows\System32" must never reach Join-Path.
    if (-not (Test-VaultEntryId $p.entryId)) {
        return @{ success = $false; error = "Rejected: entry id is not a UUID." }
    }

    $entryDir = Join-Path $p.vaultRoot $p.entryId
    if (-not (Test-Path -LiteralPath $entryDir)) {
        return @{ success = $true; note = "Entry folder was already gone." }
    }
    try {
        Remove-Item -LiteralPath $entryDir -Recurse -Force -ErrorAction Stop
        return @{ success = $true }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# Lock the Vanish data directory so the elevated engine is not reading its
# instructions out of a folder any standard user can rewrite (security review
# 2026-08-03, Vuln 2; also the ASSUMED item in 01-trd.md's security section).
#
# Administrators and SYSTEM get full control; Users keep READ so Audit Mode can
# still list the vault (SCR-02) but can no longer forge a manifest entry.
# Inheritance is severed so a permissive %APPDATA% ACL cannot leak back in.
function Set-VanishDataDirAcl {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required to set the data directory ACL." }
    }
    if (-not $p -or [string]::IsNullOrWhiteSpace($p.path)) {
        return @{ success = $false; error = "A path is required." }
    }
    if (-not (Test-Path -LiteralPath $p.path)) {
        return @{ success = $false; error = "Data directory does not exist yet." }
    }

    try {
        $admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
        $system = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
        $users  = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)

        $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
                   [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        $none    = [System.Security.AccessControl.PropagationFlags]::None
        $allow   = [System.Security.AccessControl.AccessControlType]::Allow

        # SEC-3: the DACL alone is not enough. A child object created before the
        # first elevated run keeps its original owner, and on Windows an owner
        # always retains WRITE_DAC - it can hand itself write access back
        # whatever the DACL says. Ownership has to be reassigned through the
        # whole subtree. This is the Vanish state directory, not the Chromium
        # profile root, so the recursion is small and runs once.
        $null = & icacls.exe "$($p.path)" /setowner "*S-1-5-32-544" /T /C /Q 2>&1
        # Drop any explicit ACE a child picked up while the directory was still
        # unprotected, so everything below inherits the DACL applied next.
        $null = & icacls.exe "$($p.path)" /reset /T /C /Q 2>&1

        $acl = Get-Acl -LiteralPath $p.path
        $acl.SetAccessRuleProtection($true, $false)   # disable inheritance, drop inherited rules

        foreach ($rule in @($acl.Access)) {
            $null = $acl.RemoveAccessRule($rule)
        }

        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $admins, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow)))
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $system, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow)))
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $users, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $none, $allow)))

        $acl.SetOwner($admins)
        Set-Acl -LiteralPath $p.path -AclObject $acl -ErrorAction Stop

        return @{ success = $true; protected = $true }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# Report whether a non-administrator can still write to the data directory.
# Called on every elevated start so a loosened ACL is visible, not assumed.
function Test-VanishDataDirAcl {
    param([object]$p)

    if (-not $p -or [string]::IsNullOrWhiteSpace($p.path) -or -not (Test-Path -LiteralPath $p.path)) {
        return @{ success = $true; exists = $false; protected = $false }
    }

    try {
        $acl = Get-Acl -LiteralPath $p.path
        # Mask ONLY genuine mutation bits. Do not build this from Modify or
        # FullControl: those composites include the read bits, so ANDing against
        # them reports a harmless ReadAndExecute ACE as a writer.
        $writeRights = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
                       [System.Security.AccessControl.FileSystemRights]::AppendData -bor
                       [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
                       [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
                       [System.Security.AccessControl.FileSystemRights]::Delete -bor
                       [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
                       [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
                       [System.Security.AccessControl.FileSystemRights]::TakeOwnership

        $trusted = @('S-1-5-32-544', 'S-1-5-18', 'S-1-3-0', 'S-1-5-32-573')
        $writers = [System.Collections.Generic.List[string]]::new()

        foreach ($rule in @($acl.Access)) {
            if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
            if (($rule.FileSystemRights -band $writeRights) -eq 0) { continue }
            $sid = try { $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $null }
            if ($sid -and ($trusted -contains $sid)) { continue }
            # The interactive account owning this profile is itself untrusted
            # for our purposes: that is exactly the attacker in the EoP path.
            $writers.Add([string]$rule.IdentityReference)
        }

        # SEC-3: a DACL-only verdict is a false positive waiting to happen. An
        # object's owner keeps WRITE_DAC regardless of the DACL, so a child left
        # owned by the interactive user can be re-opened for writing at will.
        # Check the owner of the directory AND of the files the engine reads as
        # elevated instructions - main.js only re-applies the ACL when this
        # returns protected:false, so a wrong "true" here is never revisited.
        $trustedOwners = @('S-1-5-32-544', 'S-1-5-18')
        $foreignOwners = [System.Collections.Generic.List[string]]::new()

        $stateObjects = @($p.path)
        foreach ($rel in @('vault', 'vault\manifest.json', 'settings.json', 'queue.json', 'oplog.jsonl')) {
            $stateObjects += (Join-Path $p.path $rel)
        }

        foreach ($obj in $stateObjects) {
            if (-not (Test-Path -LiteralPath $obj)) { continue }
            try {
                $ownerSid = (Get-Acl -LiteralPath $obj).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            } catch {
                continue
            }
            if ($trustedOwners -contains $ownerSid) { continue }
            $foreignOwners.Add("$obj is owned by $ownerSid")
        }

        return @{
            success         = $true
            exists          = $true
            protected       = ($writers.Count -eq 0 -and
                               $acl.AreAccessRulesProtected -and
                               $foreignOwners.Count -eq 0)
            inherited       = (-not $acl.AreAccessRulesProtected)
            nonAdminWriters = @($writers)
            foreignOwners   = @($foreignOwners)
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# Vuln 3: how much should we trust an uninstaller we are about to run as
# administrator? HKCU is writable by the standard user, so an entry there can
# name any binary. Report the reasons rather than silently refusing - the
# operator decides, but with the facts in front of them.
function Get-UninstallerTrust {
    param([string]$registryPath, [string]$executable)

    $reasons = [System.Collections.Generic.List[string]]::new()
    $regExe  = ConvertTo-RegExePath $registryPath

    $userHive = ($regExe -and $regExe -match '^HKCU\\')
    if ($userHive) {
        $reasons.Add("registered under HKCU, which any standard user can write")
    }

    $userWritable = $false
    if (-not [string]::IsNullOrWhiteSpace($executable)) {
        $expanded = [System.Environment]::ExpandEnvironmentVariables($executable)
        $userRoots = @($env:APPDATA, $env:LOCALAPPDATA, $env:TEMP, (Join-Path $env:SystemDrive 'Users\Public')) |
                     Where-Object { $_ }
        foreach ($root in $userRoots) {
            try { $rootFull = [System.IO.Path]::GetFullPath($root) } catch { continue }
            if (-not $rootFull.EndsWith('\')) { $rootFull += '\' }
            if ($expanded.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                $userWritable = $true
                break
            }
        }
        if ($userWritable) {
            $reasons.Add("its executable sits in a user-writable location: $expanded")
        }
    }

    return @{
        userHive     = $userHive
        userWritable = $userWritable
        risky        = ($userHive -or $userWritable)
        reasons      = @($reasons)
    }
}

# Re-read an uninstall entry from the LIVE registry. queue.json is user-
# writable, so the command persisted there is not trusted at execution time.
function Read-UninstallEntry {
    param([object]$p)

    if (-not $p -or [string]::IsNullOrWhiteSpace($p.registryPath)) {
        return @{ success = $false; error = "A registry path is required." }
    }

    $psPath = ConvertTo-PSRegPath $p.registryPath
    if (-not $psPath -or -not (Test-Path -LiteralPath $psPath)) {
        return @{ success = $false; found = $false; error = "The uninstall entry no longer exists in the registry." }
    }

    try {
        $props = Get-ItemProperty -LiteralPath $psPath -ErrorAction Stop
        $uninstallString = [string]$props.UninstallString
        $split = Split-UninstallString $uninstallString
        $trust = Get-UninstallerTrust -registryPath $p.registryPath -executable $split.executable

        return @{
            success         = $true
            found           = $true
            displayName     = [string]$props.DisplayName
            publisher       = [string]$props.Publisher
            uninstallString = $uninstallString
            installLocation = [string]$props.InstallLocation
            executable      = $split.executable
            trust           = $trust
        }
    } catch {
        return @{ success = $false; found = $false; error = $_.Exception.Message }
    }
}

# REQ-19 ownership elevator: take ownership and grant Administrators full
# control for one path. Only ever called on an explicit, per-item user choice.
function Grant-VanishOwnership {
    param([string]$path)
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $null = & takeown.exe /F "$path" /A 2>&1
        $isDir = (Get-Item -LiteralPath $path -Force).PSIsContainer
        if ($isDir) {
            $null = & takeown.exe /F "$path" /A /R /D Y 2>&1
            $null = & icacls.exe "$path" /grant "*S-1-5-32-544:(OI)(CI)F" /T /C /Q 2>&1
        } else {
            $null = & icacls.exe "$path" /grant "*S-1-5-32-544:F" /C /Q 2>&1
        }
        return $true
    } catch {
        return $false
    }
}

# ==========================================
# PHASE 2 - TASK MANAGER, INDICATORS, UNLOCKER (Stage 3)
# ==========================================

# Native interop, compiled once per engine invocation (TEC-04). OPEN-03 note:
# the first Add-Type in a session costs JIT time; only the unlock actions pay
# it, never the 2s process refresh.
$script:VanishNativeLoaded = $false
function Initialize-VanishNative {
    if ($script:VanishNativeLoaded) { return }
    $source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class VanishNative
{
    // ---- Restart Manager (REQ-07) ----
    public const int CCH_RM_MAX_APP_NAME = 255;
    public const int CCH_RM_MAX_SVC_NAME = 63;

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    [DllImport("rstrtmgr.dll")]
    static extern int RmShutdown(uint pSessionHandle, int lActionFlags, IntPtr fnStatus);

    public static List<RM_PROCESS_INFO> GetLockers(string path)
    {
        var results = new List<RM_PROCESS_INFO>();
        uint session;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out session, 0, key) != 0) throw new Exception("RmStartSession failed.");
        try
        {
            string[] resources = new string[] { path };
            int rc = RmRegisterResources(session, (uint)resources.Length, resources, 0, null, 0, null);
            if (rc != 0) throw new Exception("RmRegisterResources failed with code " + rc);

            uint pnProcInfoNeeded = 0;
            uint pnProcInfo = 0;
            uint rebootReasons = 0;

            rc = RmGetList(session, out pnProcInfoNeeded, ref pnProcInfo, null, ref rebootReasons);
            if (rc == 234 && pnProcInfoNeeded > 0) // ERROR_MORE_DATA
            {
                var infos = new RM_PROCESS_INFO[pnProcInfoNeeded];
                pnProcInfo = pnProcInfoNeeded;
                rc = RmGetList(session, out pnProcInfoNeeded, ref pnProcInfo, infos, ref rebootReasons);
                if (rc == 0)
                {
                    for (int i = 0; i < pnProcInfo; i++) results.Add(infos[i]);
                }
                else throw new Exception("RmGetList failed with code " + rc);
            }
            else if (rc != 0) throw new Exception("RmGetList failed with code " + rc);
        }
        finally { RmEndSession(session); }
        return results;
    }

    // Graceful close of every holder of a path. force=false asks politely.
    public static int CloseLockers(string path, bool force)
    {
        uint session;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out session, 0, key) != 0) throw new Exception("RmStartSession failed.");
        try
        {
            string[] resources = new string[] { path };
            int rc = RmRegisterResources(session, (uint)resources.Length, resources, 0, null, 0, null);
            if (rc != 0) throw new Exception("RmRegisterResources failed with code " + rc);
            return RmShutdown(session, force ? 1 : 0, IntPtr.Zero);
        }
        finally { RmEndSession(session); }
    }

    // ---- Process suspension (REQ-08, OPEN-01 resolved) ----
    // NtSuspendProcess is undocumented but is what Process Explorer uses and is
    // atomic at the kernel level; the documented SuspendThread + Toolhelp32 walk
    // races with threads created during enumeration. Do not "fix" this back.
    [DllImport("ntdll.dll")] static extern uint NtSuspendProcess(IntPtr processHandle);
    [DllImport("ntdll.dll")] static extern uint NtResumeProcess(IntPtr processHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    const uint PROCESS_SUSPEND_RESUME = 0x0800;
    const uint PROCESS_TERMINATE = 0x0001;

    // Holds the handles open for the whole freeze so a recycled PID can never
    // be resumed or killed by mistake. Dispose() is the guaranteed thaw.
    public class ProcessFreezer : IDisposable
    {
        private readonly Dictionary<int, IntPtr> handles = new Dictionary<int, IntPtr>();
        private bool disposed;

        public List<int> Frozen { get { return new List<int>(handles.Keys); } }
        public List<string> Errors = new List<string>();

        public void Freeze(int pid)
        {
            if (handles.ContainsKey(pid)) return;
            IntPtr h = OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_TERMINATE, false, pid);
            if (h == IntPtr.Zero)
            {
                Errors.Add("PID " + pid + ": could not open (" + Marshal.GetLastWin32Error() + ")");
                return;
            }
            uint status = NtSuspendProcess(h);
            if (status != 0)
            {
                Errors.Add("PID " + pid + ": suspend returned 0x" + status.ToString("X"));
                CloseHandle(h);
                return;
            }
            handles[pid] = h;
        }

        public void Terminate(int pid)
        {
            IntPtr h;
            if (!handles.TryGetValue(pid, out h)) return;
            // Resume first: a suspended process cannot always process its own
            // termination cleanly.
            NtResumeProcess(h);
            if (!TerminateProcess(h, 0)) Errors.Add("PID " + pid + ": terminate failed");
            CloseHandle(h);
            handles.Remove(pid);
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            foreach (var kv in handles)
            {
                NtResumeProcess(kv.Value);
                CloseHandle(kv.Value);
            }
            handles.Clear();
        }
    }
}
'@
    try {
        Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
        $script:VanishNativeLoaded = $true
    } catch {
        # Already loaded in this session is not an error.
        if ($_.Exception.Message -notmatch 'already exists') { throw }
        $script:VanishNativeLoaded = $true
    }
}

# REQ-09 / Rule 7: passive, local, display-only indicators. Vanish shows the
# flag and never acts on it.
$script:IndicatorLabel = "Indicator -- investigate with your antivirus"

$script:SuspiciousParents = @(
    'winword','excel','powerpnt','outlook','msaccess','onenote','visio',
    'acrobat','acrord32','wordpad'
)
$script:ShellChildren = @(
    'cmd','powershell','pwsh','wscript','cscript','mshta','rundll32','regsvr32','certutil','bitsadmin'
)
$script:DestructivePatterns = @(
    @{ Pattern = 'vssadmin(\.exe)?\s+delete\s+shadows';        Note = 'Deletes Volume Shadow Copies (removes restore points and file history)' },
    @{ Pattern = 'wbadmin(\.exe)?\s+delete\s+(catalog|systemstatebackup)'; Note = 'Deletes the Windows Backup catalog' },
    @{ Pattern = 'wevtutil(\.exe)?\s+cl\b';                     Note = 'Clears a Windows event log' },
    @{ Pattern = 'bcdedit(\.exe)?.*(recoveryenabled\s+no|bootstatuspolicy\s+ignoreallfailures)'; Note = 'Disables Windows recovery' },
    @{ Pattern = 'cipher(\.exe)?\s+/w';                         Note = 'Wipes free space (defeats file recovery)' },
    @{ Pattern = 'schtasks(\.exe)?\s+/create';                  Note = 'Creates a scheduled task (persistence)' },
    @{ Pattern = 'reg(\.exe)?\s+add.*\\CurrentVersion\\Run';    Note = 'Writes a Run key (persistence)' },
    @{ Pattern = '\\drivers\\etc\\hosts';                       Note = 'Touches the hosts file (traffic redirection)' },
    @{ Pattern = '-enc(odedcommand)?\s+[A-Za-z0-9+/=]{40,}';    Note = 'Base64-encoded PowerShell command' },
    @{ Pattern = 'Set-MpPreference.*Disable';                   Note = 'Disables a Microsoft Defender protection' }
)

# Fast persistence index: Run keys only. Task Scheduler enumeration takes
# seconds and cannot sit inside a 2s refresh (see DEVIATIONS 2026-08-03).
function Get-PersistenceIndex {
    $index = @{}
    $runHives = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )
    foreach ($hive in $runHives) {
        if (-not (Test-Path $hive)) { continue }
        try {
            $props = Get-ItemProperty -Path $hive -ErrorAction SilentlyContinue
            if (-not $props) { continue }
            $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
                $cmd = [string]$_.Value
                $exe = $null
                if ($cmd -match '"([^"]+\.exe)"') { $exe = $Matches[1] }
                elseif ($cmd -match '^([^\s]+\.exe)') { $exe = $Matches[1] }
                if ($exe) {
                    $leaf = (Split-Path $exe -Leaf).ToLower()
                    if (-not $index.ContainsKey($leaf)) {
                        $index[$leaf] = "$hive -> $($_.Name)"
                    }
                }
            }
        } catch {}
    }
    return $index
}

function Get-ProcessIndicators {
    param($proc, $parentName, $persistenceIndex)

    $indicators = @()

    $childName = ($proc.Name -replace '\.exe$', '').ToLower()
    $parentLeaf = if ($parentName) { ($parentName -replace '\.exe$', '').ToLower() } else { "" }

    if ($parentLeaf -and ($script:SuspiciousParents -contains $parentLeaf) -and ($script:ShellChildren -contains $childName)) {
        $indicators += @{
            kind     = "suspicious-parent"
            title    = "Document application spawned a shell"
            evidence = "$parentName -> $($proc.Name)"
            note     = $script:IndicatorLabel
        }
    }

    if ($proc.CommandLine) {
        foreach ($rule in $script:DestructivePatterns) {
            if ($proc.CommandLine -match $rule.Pattern) {
                $indicators += @{
                    kind     = "destructive-command"
                    title    = $rule.Note
                    evidence = $proc.CommandLine
                    note     = $script:IndicatorLabel
                }
            }
        }
    }

    if ($persistenceIndex -and $proc.Name) {
        $leaf = $proc.Name.ToLower()
        if ($persistenceIndex.ContainsKey($leaf)) {
            $indicators += @{
                kind     = "persistence"
                title    = "Runs automatically at logon"
                evidence = $persistenceIndex[$leaf]
                note     = $script:IndicatorLabel
            }
        }
    }

    return $indicators
}

# REQ-06: live process list with CPU / memory / disk, sampled over a short
# window. NFR-03 (<=2s refresh) is a Design Target per Rule 9 until measured.
function Get-ProcessList {
    param([object]$p)

    $sampleMs = 500
    if ($p -and $p.sampleMs) { $sampleMs = [int]$p.sampleMs }
    if ($sampleMs -lt 200) { $sampleMs = 200 }
    if ($sampleMs -gt 2000) { $sampleMs = 2000 }

    $logicalCores = 1
    try {
        $logicalCores = [int](Get-CimInstance -Query "SELECT NumberOfLogicalProcessors FROM Win32_ComputerSystem" -ErrorAction Stop).NumberOfLogicalProcessors
        if ($logicalCores -lt 1) { $logicalCores = 1 }
    } catch {}

    # Snapshot 1: full metadata + IO counters.
    $cim1 = @{}
    try {
        Get-CimInstance -Query "SELECT ProcessId, Name, ParentProcessId, CommandLine, ExecutablePath, ReadTransferCount, WriteTransferCount, CreationDate FROM Win32_Process" -ErrorAction Stop |
            ForEach-Object { $cim1[[int]$_.ProcessId] = $_ }
    } catch {}

    $cpu1 = @{}
    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
        try { $cpu1[$proc.Id] = $proc.TotalProcessorTime.TotalMilliseconds } catch {}
    }

    Start-Sleep -Milliseconds $sampleMs

    # Snapshot 2: narrow query, just the counters that move.
    $cim2 = @{}
    try {
        Get-CimInstance -Query "SELECT ProcessId, ReadTransferCount, WriteTransferCount FROM Win32_Process" -ErrorAction Stop |
            ForEach-Object { $cim2[[int]$_.ProcessId] = $_ }
    } catch {}

    $persistence = Get-PersistenceIndex
    $items = [System.Collections.Generic.List[object]]::new()

    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
        $pid2 = $proc.Id
        $meta = $cim1[$pid2]

        $cpuPercent = 0.0
        if ($cpu1.ContainsKey($pid2)) {
            try {
                $delta = $proc.TotalProcessorTime.TotalMilliseconds - $cpu1[$pid2]
                if ($delta -gt 0) {
                    $cpuPercent = [math]::Round(($delta / ($sampleMs * $logicalCores)) * 100, 1)
                    if ($cpuPercent -gt 100) { $cpuPercent = 100 }
                }
            } catch {}
        }

        $ioBytesPerSec = 0
        if ($meta -and $cim2.ContainsKey($pid2)) {
            try {
                $before = [double]$meta.ReadTransferCount + [double]$meta.WriteTransferCount
                $after  = [double]$cim2[$pid2].ReadTransferCount + [double]$cim2[$pid2].WriteTransferCount
                $deltaBytes = $after - $before
                if ($deltaBytes -gt 0) {
                    $ioBytesPerSec = [long]($deltaBytes / ($sampleMs / 1000))
                }
            } catch {}
        }

        $parentName = $null
        if ($meta -and $meta.ParentProcessId) {
            $parent = $cim1[[int]$meta.ParentProcessId]
            if ($parent) { $parentName = [string]$parent.Name }
        }

        $indicators = @()
        if ($meta) {
            $indicators = @(Get-ProcessIndicators -proc $meta -parentName $parentName -persistenceIndex $persistence)
        }

        $workingSet = 0
        try { $workingSet = [long]$proc.WorkingSet64 } catch {}

        $started = $null
        if ($meta -and $meta.CreationDate) {
            try { $started = ([datetime]$meta.CreationDate).ToString("yyyy-MM-dd HH:mm:ss") } catch {}
        }

        $items.Add(@{
            pid          = $pid2
            name         = [string]$proc.ProcessName
            cpuPercent   = $cpuPercent
            memoryBytes  = $workingSet
            ioBytesPerSec = $ioBytesPerSec
            parentPid    = if ($meta) { [int]$meta.ParentProcessId } else { 0 }
            parentName   = $parentName
            commandLine  = if ($meta) { [string]$meta.CommandLine } else { $null }
            imagePath    = if ($meta) { [string]$meta.ExecutablePath } else { $null }
            company      = $null
            startedAt    = $started
            indicators   = $indicators
        })
    }

    return @{
        success       = $true
        items         = $items
        sampledMs     = $sampleMs
        logicalCores  = $logicalCores
        indicatorNote = $script:IndicatorLabel
    }
}

function Stop-VanishProcess {
    param([object]$p)
    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or -not $p.pid) { return @{ success = $false; error = "A process id is required." } }
    try {
        Stop-Process -Id ([int]$p.pid) -Force -ErrorAction Stop
        return @{ success = $true }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# REQ-07 / FLOW-04: who is holding this path?
function Get-PathLockers {
    param([object]$p)
    if (-not $p -or [string]::IsNullOrWhiteSpace($p.path)) {
        return @{ success = $false; error = "A file or folder path is required." }
    }
    if (-not (Test-Path -LiteralPath $p.path)) {
        return @{ success = $false; error = "That path does not exist." }
    }

    $started = Get-Date
    try {
        Initialize-VanishNative
    } catch {
        return @{ success = $false; error = "Could not load the Restart Manager interop: $($_.Exception.Message)" }
    }
    $initMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds, 0)

    # A directory cannot be registered as an RM file resource; use its contents.
    $targets = @()
    try {
        $item = Get-Item -LiteralPath $p.path -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            $targets = @(Get-ChildItem -LiteralPath $p.path -Recurse -File -Force -ErrorAction SilentlyContinue |
                         Select-Object -First 64 | ForEach-Object { $_.FullName })
        } else {
            $targets = @($item.FullName)
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }

    if ($targets.Count -eq 0) {
        return @{ success = $true; holders = @(); note = "Nothing inside that folder is open."; initMs = $initMs }
    }

    $holders = @{}
    foreach ($target in $targets) {
        try {
            foreach ($info in [VanishNative]::GetLockers($target)) {
                $holderPid = $info.Process.dwProcessId
                if ($holders.ContainsKey($holderPid)) { continue }
                $procName = $null
                $procPath = $null
                try {
                    $proc = Get-Process -Id $holderPid -ErrorAction Stop
                    $procName = $proc.ProcessName
                    $procPath = $proc.Path
                } catch {}
                $holders[$holderPid] = @{
                    pid         = $holderPid
                    name        = if ($procName) { $procName } else { $info.strAppName }
                    appName     = $info.strAppName
                    serviceName = $info.strServiceShortName
                    imagePath   = $procPath
                    appType     = $info.ApplicationType
                    restartable = $info.bRestartable
                    lockedFile  = $target
                }
            }
        } catch {}
    }

    return @{
        success = $true
        holders = @($holders.Values)
        initMs  = $initMs
        note    = if ($holders.Count -eq 0) { "Lock cleared, or the path is held by SYSTEM." } else { $null }
    }
}

# REQ-07 (+ REQ-08 when suspendTree is set): close holders, gracefully first.
function Unlock-Path {
    param([object]$p)
    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or [string]::IsNullOrWhiteSpace($p.path)) {
        return @{ success = $false; error = "A file or folder path is required." }
    }

    try { Initialize-VanishNative } catch {
        return @{ success = $false; error = "Could not load the Restart Manager interop: $($_.Exception.Message)" }
    }

    $force       = ($p.force -eq $true)
    $suspendTree = ($p.suspendTree -eq $true)
    $pids        = @()
    if ($p.pids) { $pids = @($p.pids | ForEach-Object { [int]$_ }) }

    $freezer = $null
    $notes   = [System.Collections.Generic.List[string]]::new()

    try {
        # REQ-08: freeze the holder tree first so a watchdog cannot respawn a
        # locker between closing the handle and finishing the cleanup.
        if ($suspendTree -and $pids.Count -gt 0) {
            $freezer = New-Object VanishNative+ProcessFreezer
            foreach ($holderPid in $pids) {
                foreach ($treePid in (Get-ProcessTreePids -rootPid $holderPid)) {
                    $freezer.Freeze($treePid)
                }
            }
            $notes.Add("Suspended $($freezer.Frozen.Count) process(es) before releasing the lock.")
            foreach ($e in $freezer.Errors) { $notes.Add($e) }
        }

        $targets = @()
        $item = Get-Item -LiteralPath $p.path -Force -ErrorAction SilentlyContinue
        if ($item -and $item.PSIsContainer) {
            $targets = @(Get-ChildItem -LiteralPath $p.path -Recurse -File -Force -ErrorAction SilentlyContinue |
                         Select-Object -First 64 | ForEach-Object { $_.FullName })
        } elseif ($item) {
            $targets = @($item.FullName)
        }

        $closed = 0
        foreach ($target in $targets) {
            try {
                $rc = [VanishNative]::CloseLockers($target, $force)
                if ($rc -eq 0) { $closed++ }
            } catch {
                $notes.Add("Close failed for $target : $($_.Exception.Message)")
            }
        }

        # Explicit second step, per process, only when the caller asked for it.
        if ($force -and $freezer -and $pids.Count -gt 0) {
            foreach ($holderPid in $pids) {
                $freezer.Terminate($holderPid)
            }
            $notes.Add("Force-ended $($pids.Count) holder process(es).")
        }

        return @{
            success       = $true
            closedTargets = $closed
            totalTargets  = $targets.Count
            notes         = @($notes)
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; notes = @($notes) }
    } finally {
        # The thaw is guaranteed, including on error (Codex: freeze, then
        # guarantee the thaw).
        if ($freezer) { $freezer.Dispose() }
    }
}

function Get-ProcessTreePids {
    param([int]$rootPid)
    $collected = [System.Collections.Generic.List[int]]::new()
    $collected.Add($rootPid)
    try {
        $all = Get-CimInstance -Query "SELECT ProcessId, ParentProcessId FROM Win32_Process" -ErrorAction Stop
        $queue = [System.Collections.Generic.Queue[int]]::new()
        $queue.Enqueue($rootPid)
        while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            foreach ($child in ($all | Where-Object { [int]$_.ParentProcessId -eq $current })) {
                $childPid = [int]$child.ProcessId
                if (-not $collected.Contains($childPid)) {
                    $collected.Add($childPid)
                    $queue.Enqueue($childPid)
                }
            }
        }
    } catch {}
    return $collected
}

# ==========================================
# PHASE 3 - ORCHESTRATION (Stage 6)
# ==========================================

# Split a registry UninstallString into an executable and its arguments.
function Split-UninstallString {
    param([string]$uninstallString)

    $result = @{ executable = $null; arguments = "" }
    if ([string]::IsNullOrWhiteSpace($uninstallString)) { return $result }

    $s = $uninstallString.Trim()

    if ($s.StartsWith('"')) {
        $end = $s.IndexOf('"', 1)
        if ($end -gt 0) {
            $result.executable = $s.Substring(1, $end - 1)
            $result.arguments  = $s.Substring($end + 1).Trim()
            return $result
        }
    }

    # Unquoted: find the .exe boundary rather than the first space, so paths
    # like C:\Program Files\App\uninst.exe survive.
    if ($s -match '^(.*?\.exe)(\s+(.*))?$') {
        $result.executable = $Matches[1]
        $result.arguments  = if ($Matches[3]) { $Matches[3].Trim() } else { "" }
        return $result
    }

    $parts = $s.Split(' ', 2)
    $result.executable = $parts[0]
    if ($parts.Count -gt 1) { $result.arguments = $parts[1] }
    return $result
}

function Get-InstallerType {
    param([string]$executable, [string]$arguments)

    $combined = "$executable $arguments"
    if ($combined -match 'msiexec' -or $arguments -match '\{[0-9A-Fa-f\-]{36}\}') { return "msi" }
    if ($executable -match 'unins\d*\.exe$') { return "inno" }
    if ($executable -match '(uninstall|uninst|Update)\.exe$' -and $arguments -match '--uninstall') { return "squirrel" }
    if ($executable -match '(uninstall|uninst|Uninstall)[^\\]*\.exe$') { return "nsis" }
    return "unknown"
}

# Rule 15 chain: corrections.json (PRIMARY) -> heuristic sequence.
# winget is NOT a step (Rule 6 / OPEN-02).
function Resolve-UninstallArgs {
    param([object]$p)

    if (-not $p -or [string]::IsNullOrWhiteSpace($p.uninstallString)) {
        return @{ success = $false; error = "An uninstall string is required." }
    }

    $displayName = [string]$p.displayName
    $publisher   = [string]$p.publisher
    $split       = Split-UninstallString $p.uninstallString
    $type        = Get-InstallerType -executable $split.executable -arguments $split.arguments

    # --- Step 1: corrections.json -----------------------------------------
    $correctionsPath = Join-Path $PSScriptRoot "corrections.json"
    $matchedRule = $null
    if (Test-Path $correctionsPath) {
        try {
            $corrections = Get-Content $correctionsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $best = $null
            $bestLength = -1
            foreach ($app in @($corrections.apps)) {
                if (-not $app.match -or [string]::IsNullOrWhiteSpace($app.match.displayName)) { continue }
                $needle = [string]$app.match.displayName
                if ($displayName -and $displayName.ToLower().Contains($needle.ToLower())) {
                    # Optional publisher narrowing for ambiguous names.
                    if (-not [string]::IsNullOrWhiteSpace($app.match.publisher)) {
                        if (-not ($publisher -and $publisher.ToLower().Contains(([string]$app.match.publisher).ToLower()))) {
                            continue
                        }
                    }
                    if ($needle.Length -gt $bestLength) {
                        $best = $app
                        $bestLength = $needle.Length
                    }
                }
            }
            $matchedRule = $best
        } catch {
            # A malformed corrections file must not break uninstalling.
            $matchedRule = $null
        }
    }

    if ($matchedRule) {
        $args = [string]$matchedRule.silentArgs
        return @{
            success      = $true
            method       = "corrections"
            matchedName  = [string]$matchedRule.match.displayName
            source       = [string]$matchedRule.source
            detectedType = $type
            executable   = $split.executable
            baseArgs     = $split.arguments
            arguments    = $args
            candidates   = @($args)
        }
    }

    # --- Step 2: heuristic fallback sequence ------------------------------
    # Rule 15 order is /qn -> /S -> --silent -> -quiet. Candidates that cannot
    # apply to the detected installer are dropped rather than reordered, so a
    # non-MSI never gets an msiexec-only switch thrown at it.
    $sequence = @("/qn", "/S", "--silent", "-quiet")
    $candidates = [System.Collections.Generic.List[string]]::new()

    foreach ($candidate in $sequence) {
        if ($candidate -eq "/qn" -and $type -ne "msi" -and $type -ne "unknown") { continue }
        $candidates.Add($candidate)
    }

    $baseArgs = $split.arguments
    if ($type -eq "msi") {
        # Normalise the MSI form: registry strings often say /I (install) where
        # /X (uninstall) is what is actually wanted.
        if ($baseArgs -match '\{[0-9A-Fa-f\-]{36}\}') {
            $productCode = $Matches[0]
            $baseArgs = "/x $productCode"
        }
        $candidates.Clear()
        $candidates.Add("/qn /norestart")
    }

    if ($candidates.Count -eq 0) { $candidates.Add("/S") }

    return @{
        success      = $true
        method       = "heuristic"
        matchedName  = $null
        source       = "Rule 15 heuristic sequence"
        detectedType = $type
        executable   = $split.executable
        baseArgs     = $baseArgs
        arguments    = $candidates[0]
        candidates   = @($candidates)
    }
}

# Run one uninstaller and report how it went (FLOW-05 step 2).
function Invoke-Uninstaller {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or [string]::IsNullOrWhiteSpace($p.executable)) {
        return @{ success = $false; error = "An executable is required." }
    }

    $timeoutSeconds = 600
    if ($p.timeoutSeconds) { $timeoutSeconds = [int]$p.timeoutSeconds }

    # Defence in depth for Vuln 3: even if the queue runner is bypassed, the
    # engine refuses to launch an untrusted binary with administrator rights
    # unless the caller says the user acknowledged it.
    #
    # SEC-1: this gated on userWritable alone, which let an HKCU-registered entry
    # naming a system binary (a LOLBin with attacker-chosen arguments) through the
    # engine-level check. It gates on the full risky verdict now, matching the
    # callers in lib/queue.js and the uninstall-native handler.
    $trust = Get-UninstallerTrust -registryPath $p.registryPath -executable $p.executable
    if ($trust.risky -and $p.acknowledged -ne $true) {
        return @{
            success = $false
            blocked = $true
            error   = "Refused: $($trust.reasons -join '; '). This needs explicit confirmation."
            trust   = $trust
        }
    }

    $argString = (@($p.baseArgs, $p.arguments) | Where-Object { $_ } ) -join " "
    $started = Get-Date

    try {
        $proc = if ([string]::IsNullOrWhiteSpace($argString)) {
            Start-Process -FilePath $p.executable -PassThru -ErrorAction Stop
        } else {
            Start-Process -FilePath $p.executable -ArgumentList $argString -PassThru -ErrorAction Stop
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; exitCode = $null }
    }

    # FLOW-05 branch: an uninstaller that puts a window on screen is not silent.
    # Report it so the queue can mark the app "needs attention" and carry on.
    $interactive = $false
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    $windowCheckAt = (Get-Date).AddSeconds(8)

    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (-not $interactive -and (Get-Date) -ge $windowCheckAt) {
            try {
                $proc.Refresh()
                if (-not $proc.HasExited -and $proc.MainWindowHandle -ne 0) { $interactive = $true }
            } catch {}
        }
    }

    $timedOut = -not $proc.HasExited
    $exitCode = $null
    if (-not $timedOut) {
        try { $exitCode = $proc.ExitCode } catch {}
    }

    return @{
        success     = $true
        exitCode    = $exitCode
        timedOut    = $timedOut
        interactive = $interactive
        durationMs  = [int]((Get-Date) - $started).TotalMilliseconds
        commandLine = "$($p.executable) $argString".Trim()
    }
}

# Remove one Store (UWP) package (SEC-1).
#
# The old path built "powershell.exe -NoProfile ... -Command Remove-AppxPackage
# -Package <name>" as a string in Get-UwpApps and let main.js push it through
# cmd.exe. Nothing is assembled into a command line here: the name must match an
# installed package exactly, and the cmdlet is called with that package object's
# own PackageFullName.
function Remove-AppxPackageSafely {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }

    $name = [string]$p.packageFullName
    if ([string]::IsNullOrWhiteSpace($name)) {
        return @{ success = $false; error = "A package full name is required." }
    }

    # Shape check first: Name_Version_Architecture__PublisherId. Cheap, and it
    # rejects anything path-like or quoted before it reaches a cmdlet parameter.
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9\.\-]*_[0-9][0-9\.]*_[A-Za-z0-9]*__[A-Za-z0-9]+$') {
        return @{ success = $false; error = "Rejected: that is not a valid package full name." }
    }

    try {
        # The real control: it has to be a package Windows says is installed.
        $pkg = @(Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue |
                 Where-Object { $_.PackageFullName -eq $name })[0]
        if (-not $pkg) {
            $pkg = @(Get-AppxPackage -ErrorAction SilentlyContinue |
                     Where-Object { $_.PackageFullName -eq $name })[0]
        }
        if (-not $pkg) {
            return @{ success = $false; error = "That package is not installed." }
        }

        Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction Stop
        return @{ success = $true; packageFullName = [string]$pkg.PackageFullName }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# REQ-12: the Windows Installer service must be runnable before an MSI queue.
function Get-MsiServerState {
    try {
        $svc = Get-CimInstance -Query "SELECT Name, StartMode, State FROM Win32_Service WHERE Name='msiserver'" -ErrorAction Stop
        if (-not $svc) { return @{ success = $false; error = "The msiserver service was not found." } }
        return @{
            success   = $true
            startMode = [string]$svc.StartMode
            state     = [string]$svc.State
            usable    = ([string]$svc.StartMode -ne "Disabled")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

function Set-MsiServerState {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    try {
        # startMode is Manual/Disabled/Automatic; running is a bool.
        if ($p.startMode) {
            $scMode = switch ([string]$p.startMode) {
                "Auto"      { "auto" }
                "Automatic" { "auto" }
                "Manual"    { "demand" }
                "Disabled"  { "disabled" }
                default     { "demand" }
            }
            $null = & sc.exe config msiserver start= $scMode 2>&1
        }
        if ($p.running -eq $true) {
            $svc = Get-Service -Name msiserver -ErrorAction Stop
            if ($svc.Status -ne "Running") { Start-Service -Name msiserver -ErrorAction Stop }
        }
        return Get-MsiServerState
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# ==========================================
# PHASE 4 - SYSTEM INTEGRATION & ENVIRONMENT CLEAN (Stage 9)
# ==========================================

# --- TASK-13: explicit registry views (REQ-18) ---------------------------
# A 64-bit host process silently reads the 64-bit view; anything a 32-bit
# installer wrote lands in Wow6432Node and is invisible to the default
# provider paths. Every Stage 6/9 scan goes through these helpers with an
# explicit view so nothing hides behind WOW64 redirection.

function Open-RegistryView {
    param(
        [ValidateSet('ClassesRoot','CurrentUser','LocalMachine','Users','CurrentConfig')]
        [string]$hive,
        [string]$subKey,
        [ValidateSet('Registry64','Registry32','Default')]
        [string]$view = 'Registry64'
    )
    try {
        $hiveEnum = [Microsoft.Win32.RegistryHive]::$hive
        $viewEnum = [Microsoft.Win32.RegistryView]::$view
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hiveEnum, $viewEnum)
        if ([string]::IsNullOrEmpty($subKey)) { return $base }
        return $base.OpenSubKey($subKey)
    } catch {
        return $null
    }
}

function Get-RegistrySubKeyNamesInView {
    param([string]$hive, [string]$subKey, [string]$view = 'Registry64')
    $key = Open-RegistryView -hive $hive -subKey $subKey -view $view
    if (-not $key) { return @() }
    try { return @($key.GetSubKeyNames()) } catch { return @() } finally { $key.Close() }
}

function Get-RegistryValueInView {
    param([string]$hive, [string]$subKey, [string]$name = "", [string]$view = 'Registry64')
    $key = Open-RegistryView -hive $hive -subKey $subKey -view $view
    if (-not $key) { return $null }
    try { return $key.GetValue($name) } catch { return $null } finally { $key.Close() }
}

# Build the reg.exe-style path that the vault pipeline quarantines.
function Get-ViewRegPath {
    param([string]$hive, [string]$subKey, [string]$view)
    $prefix = switch ($hive) {
        'ClassesRoot'   { 'HKCR' }
        'CurrentUser'   { 'HKCU' }
        'LocalMachine'  { 'HKLM' }
        'Users'         { 'HKU'  }
        'CurrentConfig' { 'HKCC' }
        default         { 'HKLM' }
    }
    # The 32-bit view of HKLM\Software is physically HKLM\Software\Wow6432Node,
    # which is what reg.exe and the vault need to see.
    if ($view -eq 'Registry32' -and $prefix -eq 'HKLM' -and $subKey -match '^Software\\') {
        $subKey = $subKey -replace '^Software\\', 'Software\Wow6432Node\'
    }
    if ($view -eq 'Registry32' -and $prefix -eq 'HKCR' -and $subKey -notmatch '^Wow6432Node') {
        $subKey = "Wow6432Node\$subKey"
    }
    return "$prefix\$subKey"
}

# HKEY_CLASSES_ROOT is a MERGED view of HKLM\Software\Classes and
# HKCU\Software\Classes. Scans read the merged view (that is what the shell
# actually uses), but a removal must name the physical key that backs it -
# quarantining "HKCR\..." would be ambiguous about which hive it came from, and
# HKCR is not even a mounted PowerShell drive. Resolve to the concrete path,
# user hive first: narrower blast radius and no elevation needed to put it back.
function Resolve-ClassesPhysicalPath {
    param([string]$classesSubKey)

    $candidates = @(
        @{ Prefix = 'HKCU'; Hive = 'CurrentUser';  Sub = "Software\Classes\$classesSubKey" },
        @{ Prefix = 'HKLM'; Hive = 'LocalMachine'; Sub = "Software\Classes\$classesSubKey" },
        @{ Prefix = 'HKLM'; Hive = 'LocalMachine'; Sub = "Software\Classes\Wow6432Node\$classesSubKey" }
    )

    foreach ($candidate in $candidates) {
        $key = Open-RegistryView -hive $candidate.Hive -subKey $candidate.Sub -view 'Registry64'
        if ($key) {
            $key.Close()
            return "$($candidate.Prefix)\$($candidate.Sub)"
        }
    }
    return $null
}

# Resolve the executable a shell command actually runs.
#
# This is the single most dangerous function in the cleaners: everything they
# propose removing rests on "this target does not exist". Getting it wrong
# proposes deleting exefile, batfile or cmdfile - the handlers that let Windows
# launch anything at all. It is therefore deliberately conservative and returns
# $null whenever it cannot be sure, which callers treat as "not an orphan".
#
# Extension-less commands (C:\Windows\system32\perfmon) and unquoted paths with
# spaces (C:\Program Files\App\x.exe /flag) both used to be misread as missing.
$script:TargetExistsCache = @{}

function Test-ExecutableExists {
    param([string]$candidate)
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }
    if ($script:TargetExistsCache.ContainsKey($candidate)) { return $script:TargetExistsCache[$candidate] }

    $result = $false
    try {
        if (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction SilentlyContinue) {
            $result = $true
        } else {
            # A command may legitimately omit its extension.
            foreach ($ext in @('.exe', '.com', '.bat', '.cmd', '.dll', '.cpl', '.msc')) {
                if (Test-Path -LiteralPath ($candidate + $ext) -PathType Leaf -ErrorAction SilentlyContinue) {
                    $result = $true
                    break
                }
            }
        }
    } catch { $result = $false }

    $script:TargetExistsCache[$candidate] = $result
    return $result
}

function Resolve-CommandTarget {
    param([string]$command)
    if ([string]::IsNullOrWhiteSpace($command)) { return $null }

    $c = [System.Environment]::ExpandEnvironmentVariables($command.Trim())
    if ([string]::IsNullOrWhiteSpace($c)) { return $null }

    # A command whose target IS the document being opened ("%1" %*, %L, %V)
    # runs the file the user clicked, not a fixed executable. exefile, batfile,
    # cmdfile, comfile, piffile and scrfile are all of this shape. There is
    # nothing here that can be "missing", so never treat it as an orphan.
    if ($c -match '^\s*"?%[1LVlv\*]') { return $null }

    if ($c.StartsWith('"')) {
        $end = $c.IndexOf('"', 1)
        if ($end -gt 0) {
            $quoted = $c.Substring(1, $end - 1)
            if ($quoted -match '^%') { return $null }
            return $quoted
        }
    }

    # Unquoted: walk the tokens and take the longest prefix that actually
    # resolves, so "C:\Program Files\App\x.exe /flag" is not cut at "C:\Program".
    $tokens = $c.Split(' ')
    $accumulated = ""
    $bestExisting = $null
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $accumulated = if ($i -eq 0) { $tokens[$i] } else { "$accumulated $($tokens[$i])" }
        if ($accumulated -match '^[-/]') { break }
        if (Test-ExecutableExists $accumulated) { $bestExisting = $accumulated }
    }
    if ($bestExisting) { return $bestExisting }

    # Nothing resolved. Fall back to the first plausible executable token so the
    # caller has something to show as evidence.
    if ($c -match '^(.*?\.(exe|dll|com|bat|cmd|cpl|scr|msc))(\s|,|$)') { return $Matches[1] }

    $space = $c.IndexOf(' ')
    if ($space -gt 0) { return $c.Substring(0, $space) }
    return $c
}

function Test-TargetMissing {
    param([string]$target)
    if ([string]::IsNullOrWhiteSpace($target)) { return $false }

    # Anything still carrying a shell placeholder is not a fixed path.
    if ($target -match '%[0-9A-Za-z\*]') { return $false }

    if (Test-ExecutableExists $target) { return $false }

    # A bare name may still resolve on PATH (rundll32, explorer, ...).
    if ($target -notmatch '[\\/]') {
        if ($script:TargetExistsCache.ContainsKey("cmd:$target")) {
            return -not $script:TargetExistsCache["cmd:$target"]
        }
        $found = $null -ne (Get-Command $target -ErrorAction SilentlyContinue)
        $script:TargetExistsCache["cmd:$target"] = $found
        if ($found) { return $false }
    }

    return $true
}

# Confidence tier for a "target missing" finding. An absolute path to a real
# executable extension is unambiguous; anything vaguer is not.
function Get-TargetRisk {
    param([string]$target)
    if ([string]::IsNullOrWhiteSpace($target)) { return "Advanced" }
    if ($target -match '^[A-Za-z]:\\' -and $target -match '\.(exe|dll|com|bat|cmd|cpl|scr|msc)$') { return "Safe" }
    return "Moderate"
}

# --- REQ-11: orphaned context menu / shell extension handlers ------------
function Find-OrphanContextMenus {
    $findings = [System.Collections.Generic.List[object]]::new()

    $roots = @(
        @{ Path = '*\shellex\ContextMenuHandlers';         Label = 'All files' },
        @{ Path = 'Directory\shellex\ContextMenuHandlers'; Label = 'Folders' },
        @{ Path = 'Directory\Background\shellex\ContextMenuHandlers'; Label = 'Folder background' },
        @{ Path = 'Folder\shellex\ContextMenuHandlers';    Label = 'Folder namespace' },
        @{ Path = 'Drive\shellex\ContextMenuHandlers';     Label = 'Drives' },
        @{ Path = 'AllFilesystemObjects\shellex\ContextMenuHandlers'; Label = 'Filesystem objects' }
    )

    foreach ($view in @('Registry64','Registry32')) {
        foreach ($root in $roots) {
            foreach ($handlerName in (Get-RegistrySubKeyNamesInView -hive 'ClassesRoot' -subKey $root.Path -view $view)) {
                $handlerPath = "$($root.Path)\$handlerName"
                $clsid = Get-RegistryValueInView -hive 'ClassesRoot' -subKey $handlerPath -name "" -view $view
                if ([string]::IsNullOrWhiteSpace($clsid)) { continue }
                if ($clsid -notmatch '^\{[0-9A-Fa-f\-]{36}\}$') { continue }

                # Resolve the COM server behind the handler. A 64-bit-only shell
                # extension (Defender's EPP, WorkFolders, Offline Files) has no
                # entry in the 32-bit view, so a single-view lookup would report
                # a live Windows handler as orphaned. Check BOTH views before
                # concluding anything is missing.
                $server = $null
                foreach ($lookupView in @($view, 'Registry64', 'Registry32')) {
                    foreach ($serverKey in @("CLSID\$clsid\InprocServer32", "CLSID\$clsid\LocalServer32")) {
                        $value = Get-RegistryValueInView -hive 'ClassesRoot' -subKey $serverKey -name "" -view $lookupView
                        if ($value) { $server = $value; break }
                    }
                    if ($server) { break }
                }

                if ($null -eq $server) {
                    # No COM server in either view. Real, but a weaker signal
                    # than a named file that is provably gone - never Safe.
                    $findings.Add(@{
                        id       = "ctx|$view|$handlerPath"
                        label    = "$($root.Label): $handlerName"
                        evidence = "CLSID $clsid has no registered COM server in either registry view"
                        risk     = "Advanced"
                        kind     = "registry"
                        registryPath = Resolve-ClassesPhysicalPath $handlerPath
                        view     = $view
                    })
                    continue
                }

                $target = Resolve-CommandTarget $server
                if (Test-TargetMissing $target) {
                    $findings.Add(@{
                        id       = "ctx|$view|$handlerPath"
                        label    = "$($root.Label): $handlerName"
                        evidence = "target missing: $target"
                        risk     = Get-TargetRisk $target
                        kind     = "registry"
                        registryPath = Resolve-ClassesPhysicalPath $handlerPath
                        view     = $view
                    })
                }
            }
        }
    }

    return $findings
}

# --- REQ-14: orphaned services -------------------------------------------
function Find-OrphanServices {
    $findings = [System.Collections.Generic.List[object]]::new()
    $servicesRoot = 'SYSTEM\CurrentControlSet\Services'

    foreach ($name in (Get-RegistrySubKeyNamesInView -hive 'LocalMachine' -subKey $servicesRoot -view 'Registry64')) {
        $keyPath = "$servicesRoot\$name"
        $imagePath = Get-RegistryValueInView -hive 'LocalMachine' -subKey $keyPath -name 'ImagePath' -view 'Registry64'
        if ([string]::IsNullOrWhiteSpace($imagePath)) { continue }

        $type = Get-RegistryValueInView -hive 'LocalMachine' -subKey $keyPath -name 'Type' -view 'Registry64'
        $start = Get-RegistryValueInView -hive 'LocalMachine' -subKey $keyPath -name 'Start' -view 'Registry64'

        # Skip kernel/boot-start drivers: too load-bearing to propose in Core.
        if ($null -ne $start -and [int]$start -eq 0) { continue }

        $raw = [string]$imagePath
        $raw = $raw -replace '^\\\?\?\\', ''
        $raw = $raw -replace '^\\SystemRoot\\', "$env:SystemRoot\"
        $raw = $raw -replace '^system32\\', "$env:SystemRoot\system32\"
        $target = Resolve-CommandTarget $raw

        if (Test-TargetMissing $target) {
            $isDriver = ($null -ne $type -and (([int]$type -band 0x1) -or ([int]$type -band 0x2)))
            $targetRisk = Get-TargetRisk $target
            $findings.Add(@{
                id       = "svc|$name"
                label    = $name
                evidence = "ImagePath target missing: $target"
                risk     = if ($isDriver -and $targetRisk -eq "Safe") { "Moderate" } else { $targetRisk }
                kind     = "registry"
                registryPath = "HKLM\$keyPath"
                view     = 'Registry64'
                meta     = @{ serviceName = $name; isDriver = $isDriver }
            })
        }
    }

    return $findings
}

# --- REQ-14 (driver store half): audit only in Core ----------------------
# Removal of driver store packages is the Stage 11 sweeper, which is Standard
# tier - Rule 16 forbids starting it before Core is VM-tested. These findings
# are reported with removable=false so the UI shows them without a purge path.
function Find-OrphanDriverPackages {
    $findings = [System.Collections.Generic.List[object]]::new()
    try {
        $output = & pnputil.exe /enum-drivers 2>&1
    } catch {
        return $findings
    }

    $current = @{}
    foreach ($line in $output) {
        $text = [string]$line
        if ($text -match '^\s*Published Name\s*:\s*(.+)$')   { $current = @{ published = $Matches[1].Trim() } }
        elseif ($text -match '^\s*Original Name\s*:\s*(.+)$'){ $current.original = $Matches[1].Trim() }
        elseif ($text -match '^\s*Provider Name\s*:\s*(.+)$'){ $current.provider = $Matches[1].Trim() }
        elseif ($text -match '^\s*Class Name\s*:\s*(.+)$')   { $current.class = $Matches[1].Trim() }
        elseif ($text -match '^\s*$' -and $current.published) {
            $infPath = Join-Path "$env:SystemRoot\INF" $current.published
            if (-not (Test-Path -LiteralPath $infPath)) {
                $findings.Add(@{
                    id        = "drv|$($current.published)"
                    label     = "$($current.published) - $($current.original)"
                    evidence  = "published INF missing from $env:SystemRoot\INF"
                    risk      = "Advanced"
                    kind      = "driver"
                    removable = $false
                    note      = "Audit only in this release. Driver store removal is the Stage 11 sweeper (Standard tier, Rule 16)."
                    meta      = @{ published = $current.published; provider = $current.provider; class = $current.class }
                })
            }
            $current = @{}
        }
    }

    return $findings
}

# --- REQ-15: dead PATH directories ---------------------------------------
function Find-DeadPathEntries {
    $findings = [System.Collections.Generic.List[object]]::new()

    $scopes = @(
        @{ Scope = 'User';    Hive = 'CurrentUser';  Key = 'Environment' },
        @{ Scope = 'Machine'; Hive = 'LocalMachine'; Key = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' }
    )

    foreach ($scope in $scopes) {
        # Read the RAW value: expanding it first would lose %VAR% entries that
        # must be written back verbatim on restore.
        $key = Open-RegistryView -hive $scope.Hive -subKey $scope.Key -view 'Registry64'
        if (-not $key) { continue }
        $raw = $null
        try { $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        finally { $key.Close() }
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }

        $entries = @([string]$raw -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($entry in $entries) {
            $trimmed = $entry.Trim()
            $expanded = [System.Environment]::ExpandEnvironmentVariables($trimmed)
            if (Test-Path -LiteralPath $expanded -ErrorAction SilentlyContinue) { continue }

            $findings.Add(@{
                id       = "path|$($scope.Scope)|$trimmed"
                label    = $trimmed
                evidence = "directory does not exist ($($scope.Scope) PATH)"
                risk     = "Safe"
                kind     = "path-entry"
                meta     = @{ scope = $scope.Scope; entry = $trimmed }
                registryPath = Get-ViewRegPath -hive $scope.Hive -subKey $scope.Key -view 'Registry64'
            })
        }
    }

    return $findings
}

# --- REQ-16: file associations and protocol handlers ---------------------
function Find-DeadAssociations {
    $findings = [System.Collections.Generic.List[object]]::new()
    $seen = @{}

    foreach ($view in @('Registry64','Registry32')) {
        $progIds = @(Get-RegistrySubKeyNamesInView -hive 'ClassesRoot' -subKey '' -view $view)

        foreach ($progId in $progIds) {
            # Extensions themselves point at a ProgId; handlers live under it.
            if ($progId.StartsWith('.')) { continue }
            if ($progId -eq 'CLSID' -or $progId -eq 'Wow6432Node' -or $progId -eq 'Installer') { continue }

            $cmdKey = "$progId\shell\open\command"
            $command = Get-RegistryValueInView -hive 'ClassesRoot' -subKey $cmdKey -name "" -view $view
            if ([string]::IsNullOrWhiteSpace($command)) { continue }

            $target = Resolve-CommandTarget $command
            if (-not (Test-TargetMissing $target)) { continue }

            $key = "assoc|$view|$progId"
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true

            $isProtocol = $null -ne (Get-RegistryValueInView -hive 'ClassesRoot' -subKey $progId -name 'URL Protocol' -view $view)

            $findings.Add(@{
                id       = $key
                label    = if ($isProtocol) { "$progId (protocol handler)" } else { $progId }
                evidence = "open command target missing: $target"
                risk     = Get-TargetRisk $target
                kind     = "registry"
                registryPath = Resolve-ClassesPhysicalPath $progId
                view     = $view
                meta     = @{ isProtocol = $isProtocol; command = [string]$command }
            })
        }
    }

    return $findings
}

# --- REQ-17: other local profiles (SHOULD) -------------------------------
# Any hive this loads is unloaded in a finally, including on scan error
# (NFR-07). An interrupted scan must never leave a mounted hive behind.
function Find-OtherProfileRemnants {
    param([object]$p)

    $findings = [System.Collections.Generic.List[object]]::new()
    $keyword = if ($p -and $p.keyword) { [string]$p.keyword } else { "" }

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required to read other users' registry hives." }
    }

    $profileListKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    $currentSid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $mounted = [System.Collections.Generic.List[string]]::new()
    $loadedSids = @((Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue).PSChildName)

    try {
        foreach ($profileKey in (Get-ChildItem $profileListKey -ErrorAction SilentlyContinue)) {
            $sid = $profileKey.PSChildName
            if ($sid -eq $currentSid) { continue }
            if ($sid -notmatch '^S-1-5-21-') { continue }        # skip service accounts
            if ($loadedSids -contains $sid) { continue }          # already logged on

            $profilePath = (Get-ItemProperty -Path $profileKey.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
            if ([string]::IsNullOrWhiteSpace($profilePath)) { continue }
            $profilePath = [System.Environment]::ExpandEnvironmentVariables($profilePath)

            $hiveFile = Join-Path $profilePath "NTUSER.DAT"
            if (-not (Test-Path -LiteralPath $hiveFile)) { continue }

            $mountPoint = "VanishProfile_$($sid.Substring($sid.LastIndexOf('-') + 1))"
            $loadResult = & reg.exe load "HKU\$mountPoint" "$hiveFile" 2>&1
            if ($LASTEXITCODE -ne 0) { continue }
            $mounted.Add($mountPoint)

            $userName = Split-Path $profilePath -Leaf
            $softwareRoot = "Registry::HKEY_USERS\$mountPoint\Software"

            foreach ($vendorKey in (Get-ChildItem $softwareRoot -ErrorAction SilentlyContinue)) {
                $name = $vendorKey.PSChildName
                if ($keyword -and ($name -notlike "*$keyword*")) { continue }
                if (-not $keyword) { continue }   # without a keyword this would list every vendor
                $findings.Add(@{
                    id       = "profile|$sid|$name"
                    label    = "$userName : $name"
                    evidence = "matches '$keyword' in another user's hive"
                    risk     = "Moderate"
                    kind     = "registry"
                    registryPath = "HKU\$mountPoint\Software\$name"
                    meta     = @{ sid = $sid; profile = $userName; mountPoint = $mountPoint; transient = $true }
                })
            }
        }

        return @{
            success  = $true
            findings = $findings
            note     = if (-not $keyword) { "Enter an application name to search other user profiles." } else { $null }
            mounted  = @($mounted)
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    } finally {
        # NFR-07: guaranteed unload, error or not.
        [gc]::Collect()
        [gc]::WaitForPendingFinalizers()
        foreach ($mountPoint in $mounted) {
            $null = & reg.exe unload "HKU\$mountPoint" 2>&1
        }
    }
}

# A registry finding whose physical key could not be resolved cannot be
# quarantined, so it must never be offered as removable (INV-1: no removal
# without a restore manifest).
function Set-FindingRemovability {
    param($findings)
    foreach ($finding in @($findings)) {
        if ($finding.kind -eq "registry" -and [string]::IsNullOrWhiteSpace($finding.registryPath)) {
            $finding.removable = $false
            $finding.note = "Could not resolve which registry hive backs this entry, so it cannot be quarantined."
        }
    }
    return $findings
}

function Invoke-CleanerScan {
    param([object]$p)

    $cleaner = if ($p) { [string]$p.cleaner } else { "" }

    try {
        switch ($cleaner) {
            "context-menus" { return @{ success = $true; cleaner = $cleaner; findings = @(Set-FindingRemovability (Find-OrphanContextMenus)) } }
            "services"      { return @{ success = $true; cleaner = $cleaner; findings = @(Find-OrphanServices) } }
            "drivers"       { return @{ success = $true; cleaner = $cleaner; findings = @(Find-OrphanDriverPackages) } }
            "path"          { return @{ success = $true; cleaner = $cleaner; findings = @(Find-DeadPathEntries) } }
            "associations"  { return @{ success = $true; cleaner = $cleaner; findings = @(Set-FindingRemovability (Find-DeadAssociations)) } }
            "profiles"      {
                $res = Find-OtherProfileRemnants -p $p
                if ($res.success) { return @{ success = $true; cleaner = $cleaner; findings = @($res.findings); note = $res.note } }
                return @{ success = $false; cleaner = $cleaner; error = $res.error }
            }
            default { return @{ success = $false; error = "Unknown cleaner '$cleaner'." } }
        }
    } catch {
        return @{ success = $false; cleaner = $cleaner; error = $_.Exception.Message }
    }
}

# --- REQ-15 write-back: PATH is a VALUE, not a key -----------------------
# The vault exports the whole Environment key as the restore manifest first
# (mode=manifest-only), then this rewrites just the Path value. Restoring the
# .reg puts the exact prior string back.
function Set-PathEntries {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }

    $scope = [string]$p.scope
    $remove = @($p.remove)
    if ($remove.Count -eq 0) { return @{ success = $false; error = "Nothing to remove." } }

    $hive = if ($scope -eq 'Machine') { 'LocalMachine' } else { 'CurrentUser' }
    $keyPath = if ($scope -eq 'Machine') {
        'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    } else { 'Environment' }

    try {
        $baseHive = [Microsoft.Win32.RegistryHive]::$hive
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($baseHive, [Microsoft.Win32.RegistryView]::Registry64)
        $key = $base.OpenSubKey($keyPath, $true)
        if (-not $key) { return @{ success = $false; error = "Could not open the environment key for writing." } }

        try {
            $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($null -eq $raw) { return @{ success = $false; error = "No Path value found." } }

            $kind = $key.GetValueKind('Path')
            $entries = @([string]$raw -split ';')
            $kept = @($entries | Where-Object {
                $trimmed = $_.Trim()
                if ([string]::IsNullOrWhiteSpace($trimmed)) { return $false }
                return (-not ($remove -contains $trimmed))
            })

            $newValue = ($kept -join ';')
            $key.SetValue('Path', $newValue, $kind)

            return @{
                success      = $true
                removedCount = $entries.Count - $kept.Count
                newValue     = $newValue
                valueKind    = [string]$kind
            }
        } finally {
            $key.Close()
            $base.Close()
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# ==========================================
# REQ-20 - FORCED UNINSTALL FOR BROKEN ENTRIES (Stage 6)
# ==========================================
# The point of difference: the user should not have to know an application's
# name to get rid of it. Vanish reads the uninstall hives itself and reports
# which entries can no longer uninstall themselves, and why.
function Find-BrokenUninstallEntries {
    $findings = [System.Collections.Generic.List[object]]::new()

    $hives = @(
        @{ Hive = 'LocalMachine'; Sub = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';               View = 'Registry64'; Label = 'HKLM (64-bit)' },
        @{ Hive = 'LocalMachine'; Sub = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';               View = 'Registry32'; Label = 'HKLM (32-bit)' },
        @{ Hive = 'CurrentUser';  Sub = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';               View = 'Registry64'; Label = 'HKCU' }
    )

    foreach ($hive in $hives) {
        foreach ($childName in (Get-RegistrySubKeyNamesInView -hive $hive.Hive -subKey $hive.Sub -view $hive.View)) {
            $keyPath = "$($hive.Sub)\$childName"

            $displayName = Get-RegistryValueInView -hive $hive.Hive -subKey $keyPath -name 'DisplayName' -view $hive.View
            if ([string]::IsNullOrWhiteSpace($displayName)) { continue }

            # Same exclusions the main inventory uses, so the two lists agree.
            $systemComponent = Get-RegistryValueInView -hive $hive.Hive -subKey $keyPath -name 'SystemComponent' -view $hive.View
            if ($null -ne $systemComponent -and [int]$systemComponent -eq 1) { continue }
            $parentKey = Get-RegistryValueInView -hive $hive.Hive -subKey $keyPath -name 'ParentKeyName' -view $hive.View
            if ($parentKey) { continue }
            if ($displayName -match 'Security Update|Hotfix|^Update for') { continue }

            $uninstallString = Get-RegistryValueInView -hive $hive.Hive -subKey $keyPath -name 'UninstallString' -view $hive.View
            $installLocation = Get-RegistryValueInView -hive $hive.Hive -subKey $keyPath -name 'InstallLocation' -view $hive.View
            $publisher       = Get-RegistryValueInView -hive $hive.Hive -subKey $keyPath -name 'Publisher' -view $hive.View

            $reasons = [System.Collections.Generic.List[string]]::new()
            $uninstallerPath = $null
            $uninstallerOk = $false

            if ([string]::IsNullOrWhiteSpace($uninstallString)) {
                $reasons.Add("no UninstallString - Windows has no way to uninstall this")
            } else {
                $split = Split-UninstallString ([string]$uninstallString)
                $uninstallerPath = $split.executable
                # An msiexec entry is only as good as its registered product.
                if ("$uninstallString" -match 'msiexec') {
                    $uninstallerOk = $true
                } elseif ($uninstallerPath -and (Test-ExecutableExists ([System.Environment]::ExpandEnvironmentVariables($uninstallerPath)))) {
                    $uninstallerOk = $true
                } else {
                    $reasons.Add("uninstaller is missing: $uninstallerPath")
                }
            }

            if (-not [string]::IsNullOrWhiteSpace($installLocation)) {
                $expanded = [System.Environment]::ExpandEnvironmentVariables([string]$installLocation)
                if (-not (Test-Path -LiteralPath $expanded -ErrorAction SilentlyContinue)) {
                    $reasons.Add("install folder is gone: $expanded")
                }
            }

            if ($reasons.Count -eq 0) { continue }

            $findings.Add(@{
                id              = "broken|$($hive.Label)|$childName"
                displayName     = [string]$displayName
                publisher       = if ($publisher) { [string]$publisher } else { "Unknown Publisher" }
                hiveLabel       = $hive.Label
                registryPath    = Get-ViewRegPath -hive $hive.Hive -subKey $keyPath -view $hive.View
                uninstallString = [string]$uninstallString
                uninstallerPath = $uninstallerPath
                uninstallerOk   = $uninstallerOk
                installLocation = [string]$installLocation
                reasons         = @($reasons)
                evidence        = ($reasons -join "; ")
            })
        }
    }

    return @{
        success  = $true
        findings = $findings
        total    = $findings.Count
    }
}

# Command dispatching logic
if ($Action) {
    $Params = $null
    if ($ParamsJson) {
        try { $Params = $ParamsJson | ConvertFrom-Json } catch { $Params = $null }
    }

    switch ($Action) {
        "list-desktop" {
            Get-InstalledApps | ConvertTo-Json -Depth 5
        }
        "list-uwp" {
            Get-UwpApps | ConvertTo-Json -Depth 5
        }
        "restore-point" {
            Create-RestorePoint -p $Params
        }
        # ---- PHASE 3: ORCHESTRATION ----
        "resolve-uninstall-args" {
            Resolve-UninstallArgs -p $Params | ConvertTo-Json -Depth 5 -Compress
        }
        "run-uninstaller" {
            Invoke-Uninstaller -p $Params | ConvertTo-Json -Depth 5 -Compress
        }
        "remove-appx" {
            Remove-AppxPackageSafely -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "msiserver-state" {
            Get-MsiServerState | ConvertTo-Json -Depth 4 -Compress
        }
        "msiserver-set" {
            Set-MsiServerState -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "find-broken-entries" {
            Find-BrokenUninstallEntries | ConvertTo-Json -Depth 6 -Compress
        }
        "read-uninstall-entry" {
            Read-UninstallEntry -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "secure-data-dir" {
            Set-VanishDataDirAcl -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "check-data-dir" {
            Test-VanishDataDirAcl -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        # ---- PHASE 4: SYSTEM CLEAN ----
        "cleaner-scan" {
            Invoke-CleanerScan -p $Params | ConvertTo-Json -Depth 7 -Compress
        }
        "set-path-entries" {
            Set-PathEntries -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "protected-destination-probe" {
            # SEC-2 verification hook: ask the restore guard for its verdict on a
            # path without performing a restore. Read-only and side-effect free,
            # so the control is testable in Audit Mode as well as Full Mode.
            @{
                success   = $true
                path      = [string]$Params.path
                protected = [bool](Test-ProtectedDestination ([string]$Params.path))
                resolved  = (Resolve-DestinationTarget ([System.IO.Path]::GetFullPath([string]$Params.path)))
            } | ConvertTo-Json -Depth 4 -Compress
        }
        "registry-view-probe" {
            # TASK-13 verification hook: read one key through an explicit view.
            @{
                success = $true
                value   = (Get-RegistryValueInView -hive $Params.hive -subKey $Params.subKey -name $Params.name -view $Params.view)
                regPath = (Get-ViewRegPath -hive $Params.hive -subKey $Params.subKey -view $Params.view)
            } | ConvertTo-Json -Depth 4 -Compress
        }
        "scan-leftovers" {
            $params = $ParamsJson | ConvertFrom-Json
            Scan-Leftovers -appName $params.appName -publisher $params.publisher -installLocation $params.installLocation -mode $params.mode
        }
        "check-admin" {
            Check-AdminStatus
        }
        # ---- PHASE 1: QUARANTINE VAULT ----
        "quarantine-items" {
            Invoke-QuarantineItems -p $Params | ConvertTo-Json -Depth 8 -Compress
        }
        "vault-restore" {
            Invoke-VaultRestore -p $Params | ConvertTo-Json -Depth 8 -Compress
        }
        "vault-delete" {
            Invoke-VaultDelete -p $Params | ConvertTo-Json -Depth 5 -Compress
        }
        # ---- PHASE 2: TASK MANAGER & UNLOCKER ----
        "list-processes" {
            Get-ProcessList -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "kill-process" {
            Stop-VanishProcess -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "list-lockers" {
            Get-PathLockers -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "unlock-path" {
            Unlock-Path -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "relaunch-elevated" {
            # FLOW-01: request elevation. A cancelled UAC prompt throws, and the
            # caller stays in Audit Mode -- it never exits or crashes (Rule 3).
            try {
                $argList = @()
                if ($Params.argList) { $argList = @($Params.argList) }
                if ($argList.Count -gt 0) {
                    $null = Start-Process -FilePath $Params.exePath -ArgumentList $argList -Verb RunAs -ErrorAction Stop
                } else {
                    $null = Start-Process -FilePath $Params.exePath -Verb RunAs -ErrorAction Stop
                }
                @{ success = $true } | ConvertTo-Json -Compress
            } catch {
                @{ success = $false; declined = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress
            }
        }
        # ---- STAGE 2: AUDIT & HEALTH ADVISOR ----
        "get-system-diagnostics" {
            Get-SystemDiagnostics | ConvertTo-Json -Depth 6
        }
        "get-startup-items" {
            Get-StartupItems | ConvertTo-Json -Depth 5
        }
        "get-software-redundancy" {
            Get-SoftwareRedundancy | ConvertTo-Json -Depth 5
        }
        default {
            @{ success = $false; error = "Unknown action '$Action'" } | ConvertTo-Json
        }
    }
}
