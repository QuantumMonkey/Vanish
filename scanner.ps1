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
        default {
            @{ success = $false; error = "Unknown action '$Action'" } | ConvertTo-Json
        }
    }
}
