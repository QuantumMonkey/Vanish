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

                    $apps.Add([PSCustomObject]@{
                        id              = $id
                        name            = $app.DisplayName
                        publisher       = if ($app.Publisher) { $app.Publisher } else { "Unknown Publisher" }
                        version         = if ($app.DisplayVersion) { $app.DisplayVersion } else { "Unknown" }
                        installDate     = $date
                        uninstallString = $app.UninstallString
                        installLocation = $app.InstallLocation
                        icon            = $app.DisplayIcon
                        registryPath    = $app.PSPath
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
            $uninstallCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command Remove-AppxPackage -Package $($pkg.PackageFullName)"

            $apps.Add([PSCustomObject]@{
                id              = $id
                name            = $displayName
                publisher       = $pkg.PublisherId
                version         = $pkg.Version
                installDate     = $date
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
function Create-RestorePoint {
    try {
        # Check Admin
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            return @{ success = $false; error = "Administrator privileges required to create a System Restore Point." } | ConvertTo-Json
        }

        # Check if System Restore is enabled for C:
        $driveStatus = Get-ComputerRestorePoint -ErrorAction SilentlyContinue
        # We try to create restore point
        Checkpoint-Computer -Description "Vanish Pre-Uninstall" -RestorePointType APPLICATION_UNINSTALL -ErrorAction Stop
        return @{ success = $true } | ConvertTo-Json
    } catch {
        # Check if rate limit hit (Windows limits restore points to once every 24 hours by default)
        $msg = $_.Exception.Message
        if ($msg -match "restore point cannot be created because one has already been created") {
            return @{ success = $true; note = "Skipped restore point: One was already created in the last 24 hours." } | ConvertTo-Json
        }
        return @{ success = $false; error = $msg } | ConvertTo-Json
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

# 5. Purge Remnants
function Purge-Remnants {
    param(
        [string]$remnantsJson
    )

    try {
        $remnants = $remnantsJson | ConvertFrom-Json
    } catch {
        return @{ success = $false; error = "Failed to parse remnants JSON: $($_.Exception.Message)" } | ConvertTo-Json
    }

    $results = @{
        deletedFiles = @()
        failedFiles = @()
        deletedRegistry = @()
        failedRegistry = @()
    }

    # Deleting files and directories
    if ($remnants.files) {
        foreach ($f in $remnants.files) {
            $path = $f.path
            if (Test-Path $path) {
                try {
                    Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
                    $results.deletedFiles += $path
                } catch {
                    $results.failedFiles += @{ path = $path; error = $_.Exception.Message }
                }
            } else {
                $results.deletedFiles += $path # Already gone
            }
        }
    }

    # Deleting registry keys
    if ($remnants.registry) {
        foreach ($r in $remnants.registry) {
            $path = $r.path
            # Prefix registry provider if needed
            $fullPath = $path
            if (-not ($path.StartsWith("HKLM:") -or $path.StartsWith("HKCU:"))) {
                if ($path.StartsWith("HKEY_LOCAL_MACHINE")) {
                    $fullPath = $path -replace "HKEY_LOCAL_MACHINE", "HKLM:"
                }
                elseif ($path.StartsWith("HKEY_CURRENT_USER")) {
                    $fullPath = $path -replace "HKEY_CURRENT_USER", "HKCU:"
                }
            }

            if (Test-Path $fullPath) {
                try {
                    Remove-Item -Path $fullPath -Recurse -Force -ErrorAction Stop
                    $results.deletedRegistry += $path
                } catch {
                    $results.failedRegistry += @{ path = $path; error = $_.Exception.Message }
                }
            } else {
                $results.deletedRegistry += $path # Already gone
            }
        }
    }

    $results.success = $true
    return $results | ConvertTo-Json -Depth 5
}

# 5.5 Check Admin Elevation — WindowsPrincipal API (Promptgate Rule 13; replaces banned 'net session')
function Check-AdminStatus {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    return @{ isAdmin = $isAdmin } | ConvertTo-Json
}

# ==========================================
# STAGE 2 — AUDIT & HEALTH ADVISOR BACKEND
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

# Command dispatching logic
if ($Action) {
    switch ($Action) {
        "list-desktop" {
            Get-InstalledApps | ConvertTo-Json -Depth 5
        }
        "list-uwp" {
            Get-UwpApps | ConvertTo-Json -Depth 5
        }
        "restore-point" {
            Create-RestorePoint
        }
        "scan-leftovers" {
            $params = $ParamsJson | ConvertFrom-Json
            Scan-Leftovers -appName $params.appName -publisher $params.publisher -installLocation $params.installLocation -mode $params.mode
        }
        "purge" {
            Purge-Remnants -remnantsJson $ParamsJson
        }
        "check-admin" {
            Check-AdminStatus
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
