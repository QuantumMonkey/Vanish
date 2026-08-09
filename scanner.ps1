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


# ==========================================
# SCAN PROGRESS (6g2)
# ==========================================
# Every scan in this app was a plain request/response: the engine ran for as
# long as it ran - a context-menu sweep measured at 180 seconds on the
# operator's machine - and the UI showed a spinner and one line of static text
# the whole time, indistinguishable from a hang.
#
# Progress goes to STDERR, deliberately. stdout carries the JSON result and
# nothing may be allowed to corrupt it; main.js already collects stderr
# separately and only reads it when the exit code is non-zero, so adding lines
# there cannot change any existing contract. Each line is a self-describing JSON
# object behind a marker, so a partial write is discarded rather than misread.
#
# Rule 9: these are counts of work actually completed, never an estimated
# percentage or a predicted time. "6 of 12 registry roots" is a fact; "45%
# complete, 20 seconds remaining" would be an invention.
$script:ProgressMarker = '@@VANISH-PROGRESS@@'

function Write-ScanProgress {
    param(
        [string]$stage,
        [int]$done = 0,
        [int]$total = 0,
        [int]$found = 0
    )
    try {
        $payload = @{ stage = $stage; done = $done; total = $total; found = $found } |
            ConvertTo-Json -Depth 3 -Compress
        [Console]::Error.WriteLine("$script:ProgressMarker$payload")
        [Console]::Error.Flush()
    } catch {
        # Progress reporting must never be able to fail a scan.
    }
}

# Helper to convert folder size to bytes.
#
# `return if ($size) { $size } else { 0 }` is not the expression PowerShell 5.1
# reads it as: this function returned 0 for every folder on earth, including a
# 24 MB one measured by hand. It had no live callers when that was found (the
# app-list caller was removed for being slow), so nothing on screen was wrong -
# but the next caller would have inherited a helper that silently always agrees
# the folder is empty.
function Get-FolderSize {
    param([string]$path)
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    try {
        # -Force matters here: app data folders keep real payload in hidden
        # subtrees (AC\, Settings\), and leaving those out under-reports.
        $size = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum).Sum
        if ($size) { return [long]$size }
        return 0
    } catch {
        return 0
    }
}

# Bytes as a person reads them. The engine formats this rather than the
# renderer because it travels inside an evidence sentence.
function Format-ByteSize {
    param([long]$bytes)
    if ($bytes -le 0)        { return "empty" }
    if ($bytes -lt 1KB)      { return "$bytes bytes" }
    if ($bytes -lt 1MB)      { return "$([math]::Round($bytes / 1KB, 0)) KB" }
    if ($bytes -lt 1GB)      { return "$([math]::Round($bytes / 1MB, 1)) MB" }
    return "$([math]::Round($bytes / 1GB, 2)) GB"
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

# ==========================================
# 1. INSTALLED DESKTOP APPLICATIONS (REQ-01, 7oo.3)
# ==========================================
#
# WHAT CHANGED AND WHY (operator audit 2026-08-06):
#
#   "system installs are discouraged to touch, meaning software windows needs
#    to survive, not every ms product. but this is just ridiculous."
#
# The old reader dropped, silently and permanently, every entry with
# SystemComponent=1 or a ParentKeyName. On the operator's own machine that hid
# 60 of 151 entries - Windows Subsystem for Linux, the ASUS utilities, the
# NVIDIA component rows, both Python installations' feature entries, every
# Visual C++ runtime. The app then reported a confident "86 applications" for a
# machine with 151 registry entries, and its Force Uninstall surface inherited
# the same blind spot, so anything hidden from the inventory was also unfixable.
#
# Two separate mistakes were tangled together in that one filter:
#
#   1. "Windows needs this" was conflated with "Microsoft published this" and
#      with "the vendor set a flag." A vendor setting SystemComponent=1 is
#      saying "this is not a standalone product in my installer's model" - it is
#      not saying "removing this breaks Windows," and it certainly does not say
#      that about Kaspersky or ASUS Aura.
#   2. Not-a-standalone-product was implemented as DELETE FROM THE LIST rather
#      than as a classification. Anything invisible cannot be explained,
#      counted, searched for, or acted on.
#
# So: nothing is dropped any more. Every display-named entry comes back, carries
# a classification the UI can filter on, and - where it is held back - says
# exactly why (promptgate Rule 24). Protection is now a narrow, evidence-backed
# claim about Windows servicing, not a publisher check. Office, Teams, Edge,
# OneDrive, Visual Studio and WSL are ordinary uninstallable applications, and
# there is a test asserting they stay that way.

# An entry Windows itself relies on to service the machine. Deliberately tiny,
# and deliberately about function rather than publisher: everything else that
# Microsoft happens to ship is an ordinary application.
$script:OsComponentRules = @(
    @{ Pattern = 'Update Health Tools';
       Reason  = 'Part of the Windows Update client. Removing it stops this machine from receiving quality updates.' },
    @{ Pattern = '^Windows Update ';
       Reason  = 'Part of the Windows Update client. Removing it stops this machine from receiving quality updates.' },
    @{ Pattern = '^Microsoft Windows Desktop Runtime.*required by Windows';
       Reason  = 'Runtime that a Windows-supplied component is bound to.' }
)

# Shared runtimes: real software, removable, but installed BY other applications
# rather than by the user. Classified as components so the default list is the
# things a person recognises - never hidden, never protected.
$script:SharedRuntimePattern =
    'Visual C\+\+ .*(Runtime|Redistributable)|Visual Basic/C\+\+ Runtime|' +
    '\.NET (Host|Runtime|Host FX Resolver)|Desktop Runtime|WebView2|' +
    '_redist|redist |Redistributable|Prerequisites|Runtime Library|DirectX'

$script:UpdateNamePattern = 'Security Update|Hotfix|^Update for |\(KB\d{6,}\)'

# Strip the bitness/scope suffixes installers append, so "Python 3.13.0
# (64-bit)" and "Python 3.13.0 Core Interpreter (64-bit)" can be seen as parent
# and child.
function Get-EntryNameStem {
    param([string]$name)
    if ([string]::IsNullOrWhiteSpace($name)) { return "" }
    $s = [string]$name
    $s = $s -replace '\s*\((64-bit|32-bit|x64|x86|user|machine|per-user)\)\s*$', ''
    return $s.Trim()
}

# Which PRODUCT FAMILY an entry belongs to (7oo.6).
#
# "Microsoft Edge", "Microsoft Edge Update" and "Microsoft Edge WebView2
# Runtime" are one product, its updater and its embedded runtime. Counting them
# as three browser installations and advising the user to "keep only one" is
# wrong advice about their own machine, which is what the keyword matcher did.
#
# The key is vendor + first product word, both taken from the registry rather
# than guessed: the publisher gives the vendor, and the product word is the
# first meaningful token of the display name once the vendor prefix, version
# numbers and role words (Update, Runtime, Service, SDK...) are removed.
#
# The trade-off is deliberate and stated: this also folds sibling products from
# one vendor together (Kaspersky and Kaspersky VPN; Chrome and Chrome Remote
# Desktop). For "do you have redundant software" that is the answer a person
# actually wants - they are not two competing antivirus products - and being too
# eager to merge only ever costs a suggestion, while being too eager to split
# hands out bad advice about what to uninstall.
$script:VendorNoiseWords = @(
    'corporation','corp','inc','llc','ltd','limited','gmbh','co','sa','ao','oy','ab',
    'lab','labs','software','foundation','technologies','technology','systems','group','the'
)
$script:ProductRoleWords = @(
    'update','updater','runtime','redistributable','redist','helper','service','services',
    'sdk','webview','webview2','installer','launcher','bootstrapper','prerequisite',
    'prerequisites','client','agent','manager','framework','host','driver','drivers',
    'components','component','tools','tool','plugin','plugins','extension','extensions'
)

function Get-ProductFamilyKey {
    param([string]$name, [string]$publisher)

    $normalise = {
        param([string]$text)
        $t = ([string]$text).ToLowerInvariant()
        $t = $t -replace '\(.*?\)', ' '
        $t = $t -replace '\bv?\d+([.\-_]\d+)*\b', ' '
        $t = $t -replace '[^a-z]+', ' '
        return @($t -split '\s+' | Where-Object { $_ })
    }

    $vendorTokens = @((& $normalise $publisher) | Where-Object { $script:VendorNoiseWords -notcontains $_ })
    $vendor = if ($vendorTokens.Count -gt 0) { $vendorTokens[0] } else { 'unknown' }

    $nameTokens = @(& $normalise $name)
    # Drop a leading vendor prefix ("Microsoft Edge" -> "edge") and role words,
    # so the updater and the product land on the same key.
    $productTokens = @($nameTokens | Where-Object {
        $_ -ne $vendor -and $script:ProductRoleWords -notcontains $_ -and $script:VendorNoiseWords -notcontains $_
    })

    $product = if ($productTokens.Count -gt 0) { $productTokens[0] }
               elseif ($nameTokens.Count -gt 0) { $nameTokens[0] }
               else { 'unknown' }

    return "$vendor|$product"
}

# One open per key, every value read at once. The per-value helpers elsewhere in
# this file reopen the key for each read, which is fine for one lookup and
# wasteful across 150 entries x 12 values.
function Get-UninstallRegistryEntries {
    $views = @(
        @{ Hive = 'LocalMachine'; View = 'Registry64'; Label = 'HKLM (64-bit)'; IdPrefix = 'HKLM' },
        @{ Hive = 'LocalMachine'; View = 'Registry32'; Label = 'HKLM (32-bit)'; IdPrefix = 'HKLM6432' },
        @{ Hive = 'CurrentUser';  View = 'Registry64'; Label = 'HKCU';          IdPrefix = 'HKCU' }
    )
    $sub = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $entries = [System.Collections.Generic.List[PSCustomObject]]::new()

    foreach ($v in $views) {
        $root = Open-RegistryView -hive $v.Hive -subKey $sub -view $v.View
        if (-not $root) { continue }
        try {
            foreach ($childName in $root.GetSubKeyNames()) {
                $key = $null
                try { $key = $root.OpenSubKey($childName) } catch { $key = $null }
                if (-not $key) { continue }
                try {
                    # Registry values are not guaranteed to be REG_SZ: a
                    # REG_MULTI_SZ DisplayName arrives as String[] and used to
                    # break the whole renderer list. Coerce every display field.
                    $displayName = [string]$key.GetValue('DisplayName')
                    if ([string]::IsNullOrWhiteSpace($displayName)) { continue }

                    $installDate = Format-InstallDate ([string]$key.GetValue('InstallDate'))
                    if (-not $installDate -and $childName -match '^\d{8}$') {
                        $installDate = Format-InstallDate $childName
                    }

                    $sizeBytes = 0
                    $estimated = $key.GetValue('EstimatedSize')
                    if ($estimated) { $sizeBytes = [double]$estimated * 1024 }

                    $entries.Add([PSCustomObject]@{
                        id              = "$($v.IdPrefix)_$childName"
                        keyName         = $childName
                        hiveLabel       = $v.Label
                        registryPath    = (Get-ViewRegPath -hive $v.Hive -subKey "$sub\$childName" -view $v.View)
                        name            = $displayName
                        stem            = (Get-EntryNameStem $displayName)
                        publisher       = if ($key.GetValue('Publisher')) { [string]$key.GetValue('Publisher') } else { "Unknown Publisher" }
                        version         = if ($key.GetValue('DisplayVersion')) { [string]$key.GetValue('DisplayVersion') } else { "Unknown" }
                        installDate     = $installDate
                        uninstallString = [string]$key.GetValue('UninstallString')
                        installLocation = [string]$key.GetValue('InstallLocation')
                        icon            = [string]$key.GetValue('DisplayIcon')
                        systemComponent = ($null -ne $key.GetValue('SystemComponent') -and [int]$key.GetValue('SystemComponent') -eq 1)
                        noRemove        = ($null -ne $key.GetValue('NoRemove') -and [int]$key.GetValue('NoRemove') -eq 1)
                        parentKeyName   = [string]$key.GetValue('ParentKeyName')
                        parentDisplay   = [string]$key.GetValue('ParentDisplayName')
                        sizeBytes       = $sizeBytes
                        type            = "Desktop"
                    })
                } catch {
                } finally {
                    $key.Close()
                }
            }
        } catch {
        } finally {
            $root.Close()
        }
    }

    return $entries
}

# Operator: "vanish doesnt correctly detect games entirely... detected GTA 5
# installed, but with unknown size. Steam, Epic and other game platforms
# manage installs, sizes, caches independently... some data is still
# available." Confirmed: Steam and Epic each still write a normal
# Programs-and-Features row per game (so the entry itself, uninstall string,
# and install location are all already correct), but never populate
# EstimatedSize, because the platform - not Windows - owns that number.
# Both platforms publish an already-computed real size in their own catalog
# files, which this reads directly. This is NOT the recursive folder-size
# walk that cost Get-UwpApps 10-15 seconds per launch and was removed for
# it (2026-08-07) - it is a handful of small, already-written text/JSON
# files (one per installed game, no filesystem tree walk), read only when an
# entry with a blank size and a real install location is actually found.
function Get-SteamLibrarySizes {
    $sizesByPath = @{}
    try {
        $steamPath = $null
        $prop = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue
        if ($prop -and $prop.InstallPath) { $steamPath = [string]$prop.InstallPath }
        if (-not $steamPath) {
            $prop = Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue
            if ($prop -and $prop.SteamPath) { $steamPath = ([string]$prop.SteamPath) -replace '/', '\' }
        }
        if (-not $steamPath) { return $sizesByPath }

        $libraryVdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
        if (-not (Test-Path $libraryVdf)) { return $sizesByPath }

        # Minimal VDF (Valve Data Format) reader - this only ever needs flat
        # "key" "value" pairs, never a real parse tree. Every library root is
        # a "path" value; libraryfolders.vdf lists all of them (a Steam
        # install can and often does span multiple drives, as it does on the
        # machine this was written against).
        $libraries = [System.Collections.Generic.List[string]]::new()
        foreach ($line in Get-Content -LiteralPath $libraryVdf -ErrorAction Stop) {
            if ($line -match '"path"\s+"([^"]+)"') {
                $libraries.Add(($Matches[1] -replace '\\\\', '\'))
            }
        }

        foreach ($libRoot in $libraries) {
            $steamappsDir = Join-Path $libRoot 'steamapps'
            if (-not (Test-Path $steamappsDir)) { continue }
            foreach ($manifest in (Get-ChildItem -LiteralPath $steamappsDir -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue)) {
                $installDir = $null
                $size = $null
                foreach ($line in Get-Content -LiteralPath $manifest.FullName -ErrorAction SilentlyContinue) {
                    if ($line -match '"installdir"\s+"([^"]+)"') { $installDir = $Matches[1] }
                    if ($line -match '"SizeOnDisk"\s+"(\d+)"') { $size = [long]$Matches[1] }
                }
                if ($installDir -and $size) {
                    $fullPath = Join-Path $steamappsDir "common\$installDir"
                    $sizesByPath[$fullPath.ToLowerInvariant().TrimEnd('\')] = $size
                }
            }
        }
    } catch {}
    return $sizesByPath
}

# Not live-tested against a real Epic install (not present on the machine
# this was written against) - implemented against the documented .item
# manifest shape (JSON: InstallLocation, InstallSize, DisplayName, AppName).
# Any parse failure on a single file is swallowed per-file, same as Steam
# above; a miss here leaves the entry exactly as it already rendered.
function Get-EpicManifestSizes {
    $sizesByPath = @{}
    try {
        $manifestDir = Join-Path $env:ProgramData 'Epic\EpicGamesLauncher\Data\Manifests'
        if (-not (Test-Path $manifestDir)) { return $sizesByPath }
        foreach ($file in (Get-ChildItem -LiteralPath $manifestDir -Filter '*.item' -ErrorAction SilentlyContinue)) {
            try {
                $data = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                if ($data.InstallLocation -and $data.InstallSize) {
                    $sizesByPath[([string]$data.InstallLocation).ToLowerInvariant().TrimEnd('\')] = [long]$data.InstallSize
                }
            } catch {}
        }
    } catch {}
    return $sizesByPath
}

# Backfills ONLY sizeBytes, and only when the registry itself reported none -
# nothing else about an entry (name, uninstall string, publisher) is ever
# touched by this. Steam checked before Epic simply because Steam is the
# platform confirmed present on the machine this was written against; a miss
# on both is silent and leaves the entry exactly as it already rendered
# (unknown size, still fully listable and uninstallable).
function Add-GamePlatformSizes {
    param([object[]]$entries)

    $steamSizes = $null
    $epicSizes = $null

    foreach ($e in $entries) {
        if ($e.sizeBytes -gt 0) { continue }
        if ([string]::IsNullOrWhiteSpace($e.installLocation)) { continue }

        $key = $e.installLocation.ToLowerInvariant().TrimEnd('\')

        if ($null -eq $steamSizes) { $steamSizes = Get-SteamLibrarySizes }
        if ($steamSizes.ContainsKey($key)) {
            $e.sizeBytes = $steamSizes[$key]
            continue
        }

        if ($null -eq $epicSizes) { $epicSizes = Get-EpicManifestSizes }
        if ($epicSizes.ContainsKey($key)) {
            $e.sizeBytes = $epicSizes[$key]
        }
    }
}

# Decide what each entry IS. Every branch records a reason, because a
# classification the user cannot see the basis for is just another silent filter.
function Add-EntryClassification {
    param([object[]]$entries)

    if (-not $entries -or $entries.Count -eq 0) { return @() }

    # Candidate parents: entries that look like standalone products. A feature
    # row ("Python 3.13.0 Core Interpreter") is recognised by its parent bundle
    # ("Python 3.13.0") also being installed, which is evidence rather than a
    # guess about naming.
    $parentStems = @{}
    foreach ($e in $entries) {
        if ($e.systemComponent -or $e.parentKeyName) { continue }
        if ([string]::IsNullOrWhiteSpace($e.stem)) { continue }
        if (-not $parentStems.ContainsKey($e.stem)) { $parentStems[$e.stem] = $e.name }
    }

    # The same product often owns more than one uninstall key: a 64-bit and a
    # 32-bit view of one installer, or a bundle record beside the product record.
    # Exactly one of them is the row a user should act on. Pick it - preferring
    # the one the vendor did NOT flag as a system component, then the one that
    # knows its own size - and mark the rest as second records rather than
    # showing the same application several times.
    $primaryByStem = @{}
    foreach ($e in $entries) {
        if ([string]::IsNullOrWhiteSpace($e.stem)) { continue }
        $current = $primaryByStem[$e.stem]
        if (-not $current) { $primaryByStem[$e.stem] = $e; continue }
        $betterFlag = ((-not $e.systemComponent) -and $current.systemComponent)
        $sameFlag   = ($e.systemComponent -eq $current.systemComponent)
        if ($betterFlag -or ($sameFlag -and $e.sizeBytes -gt $current.sizeBytes)) {
            $primaryByStem[$e.stem] = $e
        }
    }

    foreach ($e in $entries) {
        $classification = 'application'
        $reason         = ''
        $isProtected    = $false
        $protectReason  = ''

        # Does the recorded uninstaller actually exist? msiexec entries resolve
        # through the MSI database rather than a path on disk.
        $uninstallerPath = $null
        $uninstallerOk   = $false
        if (-not [string]::IsNullOrWhiteSpace($e.uninstallString)) {
            $split = Split-UninstallString ([string]$e.uninstallString)
            $uninstallerPath = $split.executable
            if ("$($e.uninstallString)" -match 'msiexec') {
                $uninstallerOk = $true
            } elseif ($uninstallerPath -and (Test-ExecutableExists ([System.Environment]::ExpandEnvironmentVariables($uninstallerPath)))) {
                $uninstallerOk = $true
            }
        }

        if ($e.name -match $script:UpdateNamePattern) {
            $classification = 'update'
            $reason = 'A Windows update or hotfix entry, not an installed application.'
        }
        elseif ($e.parentKeyName) {
            $classification = 'component'
            $parentLabel = if ($e.parentDisplay) { $e.parentDisplay } else { $e.parentKeyName }
            $reason = "Installed as part of $parentLabel - remove that instead."
        }
        elseif ($e.systemComponent -and -not $uninstallerOk) {
            # BOTH halves matter, and getting this wrong in either direction is
            # a defect the operator actually reported:
            #
            #   SystemComponent=1 alone is not grounds for anything. The vendor
            #   is saying "not a standalone product in my installer's model",
            #   and Windows Subsystem for Linux, Kaspersky and the Python
            #   bundles all set it while being perfectly ordinary applications.
            #
            #   No working removal path alone is not grounds either - an entry
            #   the user CAN see in Programs and Features and CANNOT remove is
            #   precisely what Force Uninstall exists to rescue.
            #
            # Together they mean something specific: a bookkeeping row that
            # Windows already hides and that was never independently removable.
            # The fifteen NVIDIA container rows on the operator's machine are
            # this exactly, and listing them as things to force-uninstall was
            # the "shows wrong entries which cant be uninstalled" half of 7oo.2.
            $classification = 'component'
            $reason = 'Marked a system component by its publisher and it has no removal path of its own; it belongs to another product.'
        }
        elseif ($e.name -match $script:SharedRuntimePattern) {
            $classification = 'component'
            $reason = 'A shared runtime installed by other applications, which may stop working without it.'
        }
        elseif ($e.name -match '\s(Component|Components)$') {
            $classification = 'component'
            $reason = 'The publisher named this entry a component of a larger product.'
        }
        elseif ($primaryByStem[$e.stem] -and $primaryByStem[$e.stem].id -ne $e.id) {
            $classification = 'component'
            $primary = $primaryByStem[$e.stem]
            $where = if ($primary.hiveLabel -ne $e.hiveLabel) { " under $($primary.hiveLabel)" } else { "" }
            $reason = "A duplicate registry record for $($e.name); the entry to act on is the one$where."
        }
        else {
            # A feature row of a bundle that is itself installed.
            #
            # The parent stem must carry a VERSION for this to fire. That is what
            # separates "Python 3.13.0 Core Interpreter (64-bit)" - a feature row
            # that repeats its bundle's version - from "Kaspersky VPN", which
            # merely starts with the name of a sibling product. Without the
            # version guard, Kaspersky VPN was reclassified as a feature of
            # Kaspersky and disappeared from the list entirely, which is the same
            # defect this whole rewrite exists to end. The asymmetry is
            # deliberate: an extra row costs a glance, a missing product costs
            # the user the ability to uninstall it.
            foreach ($stem in $parentStems.Keys) {
                if ($stem -eq $e.stem) { continue }
                if ($stem -notmatch '\d') { continue }
                if ($e.stem.StartsWith("$stem ", [System.StringComparison]::OrdinalIgnoreCase)) {
                    $classification = 'component'
                    $reason = "A feature of $($parentStems[$stem]) - uninstall that to remove this."
                    break
                }
            }
        }

        # NoRemove is deliberately NOT a reason to hide or protect anything.
        # It only tells Windows to omit the uninstall button in Settings, and
        # doing what Windows will not - with consent, and with an undo - is the
        # entire point of this application. Microsoft Edge and Kaspersky both
        # set it. Surface it as a note so the user knows why Settings would not
        # offer this, and let them decide (promptgate Rule 24).
        $removalNote = ''
        if ($e.noRemove) {
            $removalNote = 'Windows hides the uninstall button for this entry (NoRemove). Vanish can still run its uninstaller.'
        }

        # Protection is a separate axis from classification, and a narrow one.
        foreach ($rule in $script:OsComponentRules) {
            if ($e.name -match $rule.Pattern) {
                $isProtected   = $true
                $protectReason = $rule.Reason
                break
            }
        }

        $e | Add-Member -NotePropertyName classification       -NotePropertyValue $classification -Force
        $e | Add-Member -NotePropertyName classificationReason -NotePropertyValue $reason         -Force
        $e | Add-Member -NotePropertyName removalNote          -NotePropertyValue $removalNote    -Force
        $e | Add-Member -NotePropertyName protected            -NotePropertyValue $isProtected    -Force
        $e | Add-Member -NotePropertyName protectionReason     -NotePropertyValue $protectReason  -Force
        $e | Add-Member -NotePropertyName uninstallerPath      -NotePropertyValue $uninstallerPath -Force
        $e | Add-Member -NotePropertyName actionable           -NotePropertyValue $uninstallerOk  -Force
        $e | Add-Member -NotePropertyName family               -NotePropertyValue (Get-ProductFamilyKey $e.name $e.publisher) -Force
    }

    return $entries
}

function Get-InstalledApps {
    $entries = Add-EntryClassification (Get-UninstallRegistryEntries)
    Add-GamePlatformSizes $entries

    $apps = foreach ($e in $entries) {
        [PSCustomObject]@{
            id                   = $e.id
            name                 = $e.name
            publisher            = $e.publisher
            version              = $e.version
            installDate          = $e.installDate
            uninstallString      = $e.uninstallString
            installLocation      = $e.installLocation
            icon                 = $e.icon
            registryPath         = $e.registryPath
            hiveLabel            = $e.hiveLabel
            type                 = "Desktop"
            sizeBytes            = $e.sizeBytes
            classification       = $e.classification
            classificationReason = $e.classificationReason
            removalNote          = $e.removalNote
            protected            = $e.protected
            protectionReason     = $e.protectionReason
            actionable           = $e.actionable
            family               = $e.family
        }
    }

    return @($apps | Sort-Object name)
}

# 1b. Windows optional features (7oo.7)
#
# Operator: "all programs should have a toggle to see whether windows features
# should be shown or not, the ones we enable and disable from the hidden menu."
# That is optionalfeatures.exe - neither a desktop app nor a Store app, so
# Vanish could not see them at all.
#
# Win32_OptionalFeature, NOT Get-WindowsOptionalFeature. The DISM cmdlet is the
# obvious choice and fails with "The requested operation requires elevation",
# which would make this list unavailable in exactly the mode this app is
# designed to be useful in. The CIM class returns the same 135 features on this
# machine, unelevated, in about a second.
#
# Read-only by design. Turning an OS feature on or off is a genuinely
# destructive, reboot-adjacent action and is not offered here; each entry says
# where it is managed instead (Rule 24).
function Get-WindowsFeatures {
    $features = [System.Collections.Generic.List[PSCustomObject]]::new()

    # InstallState: 1 Enabled, 2 Disabled, 3 Absent (payload removed), 4 Unknown
    $stateLabels = @{ 1 = 'Enabled'; 2 = 'Disabled'; 3 = 'Not installed'; 4 = 'Unknown' }

    try {
        foreach ($f in (Get-CimInstance -ClassName Win32_OptionalFeature -ErrorAction Stop)) {
            $state = [int]$f.InstallState
            $label = if ($stateLabels.ContainsKey($state)) { $stateLabels[$state] } else { 'Unknown' }
            $display = if ($f.Caption) { [string]$f.Caption } else { [string]$f.Name }

            $features.Add([PSCustomObject]@{
                id                   = "FEATURE_$([string]$f.Name)"
                name                 = $display
                featureName          = [string]$f.Name
                publisher            = 'Microsoft Windows'
                version              = $label
                installDate          = $null
                installLocation      = ''
                registryPath         = ''
                icon                 = ''
                type                 = 'Feature'
                sizeBytes            = 0
                state                = $label
                enabled              = ($state -eq 1)
                classification       = 'feature'
                classificationReason = "A Windows optional feature, currently $($label.ToLower()). Vanish lists these; turning them on or off is done in Windows' own 'Turn Windows features on or off' dialog (optionalfeatures.exe)."
                removalNote          = ''
                protected            = $false
                protectionReason     = ''
                actionable           = $false
                family               = "microsoft|$([string]$f.Name)"
            })
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; features = @() }
    }

    $list = @($features | Sort-Object name)
    return @{
        success  = $true
        features = $list
        total    = $list.Count
        enabled  = @($list | Where-Object { $_.enabled }).Count
    }
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

            # Estimate install date from folder creation. One stat call, not a
            # Test-Path followed by a Get-Item - that was two filesystem round
            # trips per package, 123 packages deep.
            $date = $null
            try {
                $date = ([System.IO.DirectoryInfo]$pkg.InstallLocation).CreationTime.ToString("yyyy-MM-dd")
            } catch {}

            # PERFORMANCE (operator 2026-08-07: "all programs takes a lot of
            # time to list installed apps"). This used to call Get-FolderSize,
            # which does Get-ChildItem -Recurse -File over the ENTIRE package
            # directory, for every package. On this machine that is 123 full
            # recursive directory walks before a single row can be drawn, and it
            # was the whole of the 10-15 second wait - the registry half of the
            # list costs well under a second.
            #
            # A Store app's size is not worth ten seconds of a person's time on
            # every single launch. Reported as unknown; the row still renders,
            # still sorts, and still uninstalls.
            $sizeBytes = 0

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
    return @{ isAdmin = $isAdmin; uac = (Get-UacDiagnostics) } | ConvertTo-Json -Depth 4
}

# 5.6 UAC / elevation-path diagnostics (operator report: "admin not granted on
# a UAC-disabled machine" -- Check-AdminStatus alone only says whether THIS
# process is elevated, never why an elevation attempt failed. Two machine
# facts resolve that:
#   - enableLua: is UAC itself turned on at all (HKLM Policies\System).
#   - isGroupMember: is this account in Administrators, independent of
#     whether the current token is elevated. WindowsPrincipal.IsInRole is
#     deliberately unreliable here -- UAC hands an unelevated admin a
#     FILTERED token that reports IsInRole = $false, identically to a
#     standard user who was never an admin at all. That collapse is exactly
#     the ambiguity a caller needs resolved, so it cannot be the source of
#     the answer. Get-LocalGroupMember reads local group membership
#     directly and is unaffected by the calling process's own elevation
#     state.
function Get-UacDiagnostics {
    $enableLua = $null
    try {
        $val = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction Stop
        $enableLua = [bool]$val.EnableLUA
    } catch {
        $enableLua = $null   # missing key (some Server SKUs) or unreadable -- unknown, not "off"
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isElevatedNow = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    $isGroupMember = $null
    try {
        $me = "$env:USERDOMAIN\$env:USERNAME"
        $members = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop
        $isGroupMember = [bool]($members | Where-Object {
            $_.Name -eq $me -or ($_.SID -and $identity.User -and $_.SID.Value -eq $identity.User.Value)
        })
    } catch {
        $isGroupMember = $null   # domain policy blocks the query, module missing, etc -- unknown
    }

    return @{
        enableLua     = $enableLua
        isElevatedNow = $isElevatedNow
        isGroupMember = $isGroupMember
    }
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
    #
    # This query used to ask Win32_LogicalDisk for DriveLetter. That property
    # belongs to Win32_Volume, not Win32_LogicalDisk - the drive letter here is
    # DeviceID ("C:"). Naming a property the class does not have makes the WHOLE
    # query invalid ("Invalid query"), the catch below swallowed it, and the
    # Storage panel rendered "No local drives found." on every machine, forever.
    # It never worked once. Nothing in the stub-driven suite could see that,
    # because no stub ever asks Windows anything (7oo.8).
    #
    # Use -ClassName/-Filter rather than a hand-written SELECT: a typo in a
    # property name then costs nothing, because there is no property list.
    $disks = @()
    $diskError = $null
    try {
        $volumes = Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop
        foreach ($v in $volumes) {
            if (-not $v.DeviceID) { continue }
            $totalGB = if ($v.Size)      { [math]::Round($v.Size      / 1GB, 1) } else { 0 }
            $freeGB  = if ($v.FreeSpace) { [math]::Round($v.FreeSpace / 1GB, 1) } else { 0 }
            $usedGB  = [math]::Round($totalGB - $freeGB, 1)
            $pctUsed = if ($totalGB -gt 0) { [math]::Round(($usedGB / $totalGB) * 100, 1) } else { 0 }
            $disks += @{
                drive    = ([string]$v.DeviceID).TrimEnd(':')
                label    = if ($v.VolumeName) { [string]$v.VolumeName } else { "Local Disk" }
                totalGB  = $totalGB
                freeGB   = $freeGB
                usedGB   = $usedGB
                pctUsed  = $pctUsed
            }
        }
    } catch {
        # Report the failure instead of rendering an empty section that looks
        # like an honest "you have no drives".
        $diskError = $_.Exception.Message
    }

    # --- BIOS / Manufacturer ---
    $manufacturer = $null; $model = $null
    try {
        $cs = Get-CimInstance -Query "SELECT Manufacturer, Model FROM Win32_ComputerSystem" -ErrorAction Stop
        $manufacturer = $cs.Manufacturer
        $model        = $cs.Model
    } catch {}

    # --- GPU ---
    #
    $gpuList = @()
    #
    # PERFORMANCE: Win32_VideoController is the slowest class touched here by a
    # wide margin - instantiating it makes Windows enumerate and wake display
    # adapters, which on a laptop with switchable graphics can stall for
    # seconds. The registry holds the same adapter name and answers instantly.
    # Fall back to the CIM class only if the registry does not have it.
    $gpuName = $null
    try {
        # Report EVERY adapter, not the first. A laptop with switchable graphics
        # has the integrated chip at 0000 and the discrete card after it, so
        # taking the first would tell someone with an RTX 3080 that they have
        # Radeon graphics - accurate about one adapter and wrong about their
        # machine.
        $videoKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
        $adapters = @()
        foreach ($sub in @('0000','0001','0002','0003')) {
            $desc = (Get-ItemProperty -Path "$videoKey\$sub" -Name 'DriverDesc' -ErrorAction SilentlyContinue).DriverDesc
            if ($desc -and $desc -notmatch 'Basic Display|Basic Render') { $adapters += [string]$desc }
        }
        $gpuList = @($adapters | Select-Object -Unique)
        if ($gpuList.Count -gt 0) { $gpuName = $gpuList -join ' + ' }
    } catch {}
    if (-not $gpuName) {
        try {
            # Every adapter here too. Taking -First 1 was the original defect and
            # the fallback kept it.
            $gpuList = @(Get-CimInstance -Query "SELECT Name FROM Win32_VideoController" -ErrorAction Stop |
                         ForEach-Object { [string]$_.Name } |
                         Where-Object { $_ -and $_ -notmatch 'Basic Display|Basic Render' } |
                         Select-Object -Unique)
            if ($gpuList.Count -gt 0) { $gpuName = $gpuList -join ' + ' }
        } catch {}
    }

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
        # The joined string kept a second adapter out of sight: the card it
        # lands in is one nowrap line with an ellipsis, so "AMD + NVIDIA" showed
        # as "AMD...". The list is what the UI renders; the string stays for
        # anything that reads a single name.
        gpus         = @($gpuList)
        manufacturer = $manufacturer
        model        = $model
        disks        = $disks
        disksError   = $diskError
    }
}

# Pull the executable out of a startup command line (7oo.4).
#
# Each of the three sources below used to do its own extraction, and two of them
# were wrong in ways that manufactured orphans out of healthy entries. On the
# operator's machine 2 of 3 reported orphans did not exist:
#
#   - A scheduled task's Execute value arrives ALREADY QUOTED, and was used
#     verbatim. Test-Path on '"C:\...\RtkAudUService64.exe"' - quotes included -
#     is always false, so a perfectly healthy Realtek audio task was reported as
#     orphaned. Same for the Perplexity updater.
#   - The registry/service regex '^([^\s]+\.exe)' cannot match an unquoted path
#     containing spaces, which is most of Program Files, so those went the other
#     way and were never checked at all.
#
# Reporting a healthy entry as broken is worse than missing one: it is the app
# telling the user something false about their machine, in the same panel that
# asks them to trust it. One resolver, shared, using the same quoting rules the
# uninstall pipeline already relies on.
function Resolve-StartupExecutable {
    param([string]$command)
    if ([string]::IsNullOrWhiteSpace($command)) { return $null }

    $c = $command.Trim()
    # rundll32/cmd wrappers name a host binary, not the startup target itself,
    # but the host is what has to exist for the entry to run at all.
    $split = Split-UninstallString $c
    $exe = $split.executable
    if ([string]::IsNullOrWhiteSpace($exe)) { return $null }

    $exe = $exe.Trim().Trim('"').Trim()
    if ([string]::IsNullOrWhiteSpace($exe)) { return $null }
    return [System.Environment]::ExpandEnvironmentVariables($exe)
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
                        $exePath = Resolve-StartupExecutable $cmd
                        $items.Add([PSCustomObject]@{
                            name        = $_.Name
                            command     = $cmd
                            exePath     = $exePath
                            exeExists   = if ($exePath) { Test-ExecutableExists $exePath } else { $null }
                            source      = "Registry"
                            sourceDetail = $hive.Hive
                            enabled     = $true
                            managePath  = "$($hive.Path)\$($_.Name)"
                            # 7oo.11: the key and the value name, kept apart, so
                            # the action can quarantine the key and delete only
                            # the one value. registryPath is in reg.exe form
                            # because that is what the vault's exporter takes.
                            keyPath      = $hive.Path
                            valueName    = $_.Name
                            registryPath = ($hive.Path -replace '^HKLM:\\', 'HKLM\' -replace '^HKCU:\\', 'HKCU\')
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
            # $action.Execute arrives already quoted for paths with spaces.
            $exePath  = if ($action) { Resolve-StartupExecutable ([string]$action.Execute) } else { $null }
            $items.Add([PSCustomObject]@{
                name         = $task.TaskName
                command      = if ($action) { "$($action.Execute) $($action.Arguments)".Trim() } else { "" }
                exePath      = $exePath
                exeExists    = if ($exePath) { Test-ExecutableExists $exePath } else { $null }
                source       = "TaskScheduler"
                sourceDetail = $task.TaskPath
                enabled      = ($task.State -eq 'Ready' -or $task.State -eq 'Running')
                managePath   = "$($task.TaskPath)$($task.TaskName)"
                taskName     = [string]$task.TaskName
                taskPath     = [string]$task.TaskPath
            })
        }
    } catch {}

    # --- Auto-start Services (non-Microsoft, StartMode=Auto) ---
    try {
        $services = Get-CimInstance -Query "SELECT Name, DisplayName, PathName, StartMode, State FROM Win32_Service WHERE StartMode='Auto'" -ErrorAction SilentlyContinue
        foreach ($svc in $services) {
            $exePath = Resolve-StartupExecutable ([string]$svc.PathName)

            # Heuristic: skip services whose executables live under System32/SysWOW64
            $isMsPath = $exePath -and ($exePath -like "*\System32\*" -or $exePath -like "*\SysWOW64\*" -or $exePath -like "*\Windows\*")
            if ($isMsPath) { continue }

            $items.Add([PSCustomObject]@{
                name         = $svc.DisplayName
                command      = $svc.PathName
                exePath      = $exePath
                exeExists    = if ($exePath) { Test-ExecutableExists $exePath } else { $null }
                source       = "Service"
                sourceDetail = "StartMode=Auto | State=$($svc.State)"
                enabled      = ($svc.State -eq 'Running')
                managePath   = [string]$svc.Name
                serviceName  = [string]$svc.Name
                registryPath = "HKLM\SYSTEM\CurrentControlSet\Services\$($svc.Name)"
            })
        }
    } catch {}

    # 7oo.11. This surface used to be DETECTION ONLY: it named the orphan, named
    # the tool that manages it, and left. The operator's verdict on that was
    # "this item is broken but i cant do anything to it" - which is the right
    # verdict. Each item now carries the one action Vanish can actually perform
    # on its kind of entry, and every one of those actions is reversible:
    #
    #   Registry Run value -> the key is exported to the vault as a .reg restore
    #                         manifest, then the single value is deleted.
    #   Auto-start service -> the service key is exported the same way, then the
    #                         start type is set to Manual. Nothing is deleted;
    #                         the service can still be started on demand.
    #   Scheduled task     -> disabled in place, and re-enabled by the same
    #                         control. Nothing is exported because nothing is
    #                         destroyed.
    #
    # The manual route stays in the text: an action button is an offer, not a
    # replacement for knowing where the thing lives.
    foreach ($item in $items) {
        $action = $null
        $actionLabel = $null
        $suggestion = ""

        switch ($item.source) {
            'Registry' {
                $action = 'registry-remove'
                $actionLabel = 'Remove from startup'
                $suggestion = "Lives in the registry Run key. Removing it here saves the key to quarantine first, " +
                              "so you can put it back. Uninstalling the owning program is the tidier fix if it is still installed."
            }
            'TaskScheduler' {
                $action = 'task-disable'
                $actionLabel = if ($item.enabled) { 'Disable task' } else { 'Enable task' }
                $suggestion = "A scheduled task. Disabling stops it running at logon and can be undone from this same row, " +
                              "or in Task Scheduler (taskschd.msc) at $($item.managePath)."
            }
            'Service' {
                $action = 'service-manual'
                $actionLabel = 'Set to start manually'
                $suggestion = "A service set to start with Windows. Vanish can set it to start only when something asks for it; " +
                              "the service itself is left in place. Also changeable in services.msc."
            }
            default { }
        }

        $item | Add-Member -NotePropertyName suggestion  -NotePropertyValue $suggestion  -Force
        $item | Add-Member -NotePropertyName action      -NotePropertyValue $action      -Force
        $item | Add-Member -NotePropertyName actionLabel -NotePropertyValue $actionLabel -Force
    }

    # @() around the pipeline is load-bearing, not style. Where-Object returns a
    # bare object when exactly one item matches, and .Count on that serialises
    # as null - so a machine with precisely one orphaned startup item reported
    # "null orphaned", the renderer read it as 0, and the badge stayed hidden.
    # This machine has exactly one. Wrapping forces an array in every case.
    return @{
        items          = $items
        total          = @($items).Count
        orphans        = @($items | Where-Object { $_.exeExists -eq $false }).Count
        detectionOnly  = $false
        detectionNote  = 'Every change here is reversible: registry entries and services are saved to quarantine before they are touched, and a disabled task is re-enabled from the same button.'
    }
}

# 8. Software Redundancy Detector (groups installed apps by category keyword clusters)
# --- bfh.1: network attribution ------------------------------------------
#
# Answers "what is using my network", and - the part that matters - can answer
# "nothing on this machine is". That negative verdict is a claim about local
# state, so local evidence settles it and no packet is ever sent: INV-4 stands.
#
# What this deliberately does NOT do is per-process bandwidth. Windows does not
# attribute bytes to a process without an ETW kernel trace (the mechanism Task
# Manager uses internally). This reports who holds connections and what the
# adapter as a whole moved, and the UI says exactly that. A made-up per-app
# number would be the single easiest lie to tell on this screen.
#
# Every source here was measured before it was chosen. Get-NetAdapter (2.5s)
# and Get-NetTCPConnection (1.3s) lost to the .NET API (44ms) and netstat
# (40ms): the engine spawns a fresh powershell.exe per action, so module
# autoload is paid on every single call, not once per session.

# Below this, the adapter is doing nothing worth calling activity - roughly
# 0.8 Mbit/s. Named rather than inlined because it is a judgement, not a fact.
$script:NetBusyBytesPerSecond = 102400
# A wireless link this weak is itself the constraint, whatever the processes do.
$script:NetWeakSignalPercent = 40

function Get-NetAdapterSnapshot {
    $rows = @{}
    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($nic.OperationalStatus -ne 'Up') { continue }
        $type = [string]$nic.NetworkInterfaceType
        if ($type -eq 'Loopback' -or $type -eq 'Tunnel') { continue }

        $stats = $null
        try { $stats = $nic.GetIPStatistics() } catch { continue }

        # An adapter with no default gateway carries no internet traffic, so it
        # must not vote on the verdict - a Hyper-V virtual switch busily talking
        # to a local VM is not the user's connection being consumed.
        $hasGateway = $false
        try {
            $props = $nic.GetIPProperties()
            $hasGateway = @($props.GatewayAddresses | Where-Object {
                $_ -and $_.Address -and $_.Address.ToString() -ne '0.0.0.0' -and $_.Address.ToString() -ne '::'
            }).Count -gt 0
        } catch {}

        $rows[$nic.Id] = @{
            id          = [string]$nic.Id
            name        = [string]$nic.Name
            description = [string]$nic.Description
            type        = $type
            isWireless  = ($type -eq 'Wireless80211')
            hasGateway  = $hasGateway
            speedBps    = [long]$nic.Speed
            rx          = [long]$stats.BytesReceived
            tx          = [long]$stats.BytesSent
        }
    }
    return $rows
}

# Established TCP connections by owning process. netstat is used over
# Get-NetTCPConnection purely for start-up cost; the PID column is the same
# data. UDP is skipped: an endpoint being open says nothing about traffic.
function Get-NetConnectionsByProcess {
    $byPid = @{}
    $output = @()
    try { $output = & netstat.exe -ano 2>$null } catch { return $byPid }

    foreach ($line in $output) {
        $text = ([string]$line).Trim()
        if (-not $text.StartsWith('TCP')) { continue }
        $parts = @($text -split '\s+' | Where-Object { $_ })
        if ($parts.Count -lt 5) { continue }
        if ($parts[3] -ne 'ESTABLISHED') { continue }

        $procId = 0
        if (-not [int]::TryParse($parts[4], [ref]$procId)) { continue }
        if ($procId -le 0) { continue }

        $remote = [string]$parts[2]
        # Strip the port: the count of distinct peers is the useful shape, and
        # a per-port list edges this panel toward the security framing Rule 6
        # keeps it out of.
        #
        # This variable is NOT called $host. It was, and $host is a PowerShell
        # automatic variable holding the console host object: the assignment
        # failed silently, every line used the same object as its hashtable key,
        # and every process on the machine reported exactly one peer. The number
        # looked plausible, which is what made it worth a comment.
        $peer = $remote.Substring(0, [Math]::Max($remote.LastIndexOf(':'), 0))

        if (-not $byPid.ContainsKey($procId)) {
            $byPid[$procId] = @{ connections = 0; peers = @{} }
        }
        $byPid[$procId].connections++
        if ($peer) { $byPid[$procId].peers[$peer] = $true }
    }

    return $byPid
}

function Get-NetworkActivity {
    param([object]$p)

    $sampleMs = 1000
    if ($p -and $null -ne $p.sampleMs) {
        $parsed = 0
        if ([int]::TryParse([string]$p.sampleMs, [ref]$parsed) -and $parsed -ge 200 -and $parsed -le 5000) {
            $sampleMs = $parsed
        }
    }

    $first = Get-NetAdapterSnapshot
    if ($first.Count -eq 0) {
        return @{
            success  = $true
            verdict  = 'unreadable'
            adapters = @()
            processes = @()
            sampleMs = $sampleMs
        }
    }

    # The connection read happens inside the sampling window rather than before
    # it, so the two describe the same moment.
    Start-Sleep -Milliseconds ([int]($sampleMs / 2))
    $byPid = Get-NetConnectionsByProcess
    Start-Sleep -Milliseconds ([int]($sampleMs / 2))
    $second = Get-NetAdapterSnapshot

    $seconds = [double]$sampleMs / 1000
    $adapters = [System.Collections.Generic.List[object]]::new()
    $gatewayBytesPerSecond = 0.0

    foreach ($key in $second.Keys) {
        if (-not $first.ContainsKey($key)) { continue }
        $a = $second[$key]
        $b = $first[$key]

        # Counters can wrap or reset; a negative delta is not evidence of
        # anything, so it is reported as zero rather than as a wild number.
        $rxDelta = [Math]::Max(0, $a.rx - $b.rx)
        $txDelta = [Math]::Max(0, $a.tx - $b.tx)
        $bps = ($rxDelta + $txDelta) / $seconds

        if ($a.hasGateway) { $gatewayBytesPerSecond += $bps }

        $adapters.Add(@{
            name              = $a.name
            description       = $a.description
            type              = $a.type
            isWireless        = $a.isWireless
            hasGateway        = $a.hasGateway
            linkSpeedBps      = $a.speedBps
            receiveBytesPerSecond  = [long][Math]::Round($rxDelta / $seconds)
            sendBytesPerSecond     = [long][Math]::Round($txDelta / $seconds)
            totalBytesPerSecond    = [long][Math]::Round($bps)
        })
    }

    # Wi-Fi signal, only when a wireless adapter actually carries the gateway.
    #
    # Windows 11 gates WlanQueryInterface behind BOTH the Location privacy
    # setting and elevation, so this legitimately fails on a healthy machine.
    # An unavailable reading is reported as unavailable WITH its reason - never
    # as a good signal, and never as a silent blank, because 'link-weak' is a
    # verdict this panel would otherwise never be able to reach and would never
    # explain why.
    $signalPercent = $null
    $signalNote = $null
    $wireless = @($adapters | Where-Object { $_.isWireless -and $_.hasGateway })
    if ($wireless.Count -gt 0) {
        try {
            $wlan = @(& netsh.exe wlan show interfaces 2>&1)
            foreach ($line in $wlan) {
                if (([string]$line) -match '^\s*Signal\s*:\s*(\d+)%') {
                    $signalPercent = [int]$Matches[1]
                    break
                }
            }
            if ($null -eq $signalPercent) {
                $joined = ($wlan -join ' ')
                $signalNote = if ($joined -match 'location') {
                    'needs-location-permission'
                } elseif ($joined -match 'elevation|administrator') {
                    'needs-elevation'
                } else {
                    'unavailable'
                }
            }
        } catch {
            $signalNote = 'unavailable'
        }
    }

    # Windows Update's own transfers. Only Status=Downloading counts: a machine
    # holding twelve 'Caching' rows is seeding completed files it already has,
    # and reporting that as an active download is the false alarm Rule 24 is
    # about.
    $updateTransfers = $null
    try {
        $updateTransfers = @(Get-DeliveryOptimizationStatus -ErrorAction Stop |
            Where-Object { [string]$_.Status -eq 'Downloading' }).Count
    } catch {}

    # BITS needs elevation to see other users' jobs; unelevated it sees this
    # user's own, which is still worth reporting. A failure means "unknown",
    # never "none".
    $bitsJobs = $null
    try {
        if (Test-IsElevated) { $bitsJobs = @(Get-BitsTransfer -AllUsers -ErrorAction Stop).Count }
        else                 { $bitsJobs = @(Get-BitsTransfer -ErrorAction Stop).Count }
    } catch {}

    # Name the processes holding connections. This is attribution of
    # CONNECTIONS, not of bytes, and the field names say so.
    $processes = [System.Collections.Generic.List[object]]::new()
    if ($byPid.Count -gt 0) {
        $names = @{}
        foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
            $names[$proc.Id] = $proc.ProcessName
        }
        foreach ($procId in $byPid.Keys) {
            $entry = $byPid[$procId]
            $processes.Add(@{
                processId       = [int]$procId
                name            = if ($names.ContainsKey([int]$procId)) { [string]$names[[int]$procId] } else { "PID $procId" }
                connectionCount = [int]$entry.connections
                peerCount       = [int]$entry.peers.Count
                # Operator report: "is that cumbersome, would it help decide
                # if the behaviour is risky." The IP list was always collected
                # (see the peers hashtable above) - only its Count was ever
                # surfaced. Two deliberate limits carried over unchanged: no
                # port (still stripped above, Rule 6 - do not drift this
                # panel toward security/firewall framing), no reverse-DNS
                # (would be outbound network I/O, banned outright by INV-4 -
                # see test/network-verify.ps1, which greps this whole file for
                # exactly that class of call).
                peers           = @($entry.peers.Keys)
            })
        }
    }
    $processes = @($processes | Sort-Object -Property @{ Expression = { $_.connectionCount } } -Descending)

    # The verdict. A weak wireless link outranks everything else: whatever the
    # processes are doing, the link itself is the constraint and suppressing an
    # app will not change that.
    $verdict = if ($null -ne $signalPercent -and $signalPercent -lt $script:NetWeakSignalPercent) {
        'link-weak'
    } elseif ($gatewayBytesPerSecond -ge $script:NetBusyBytesPerSecond) {
        'busy'
    } else {
        'quiet'
    }

    return @{
        success                = $true
        verdict                = $verdict
        sampleMs               = $sampleMs
        adapters               = @($adapters)
        processes              = @($processes)
        totalBytesPerSecond    = [long][Math]::Round($gatewayBytesPerSecond)
        busyThresholdBytesPerSecond = $script:NetBusyBytesPerSecond
        signalPercent          = $signalPercent
        signalNote             = $signalNote
        updateTransfers        = $updateTransfers
        bitsJobs               = $bitsJobs
        elevated               = (Test-IsElevated)
    }
}

# --- bfh.2: holding background transfers ---------------------------------
#
# The only levers Windows gives a user-mode program over its own machine's
# share of the connection, and they are levers over BACKGROUND traffic only:
#
#   Delivery Optimization - Windows Update's downloader, capped by policy to
#     1% of measured bandwidth for background transfers. Foreground transfers
#     (someone clicked install in the Store) are deliberately left alone: a
#     download the user is waiting for is not what "hold the background" means.
#   BITS - the transfer service updaters and installers queue work on. Jobs
#     that are actively moving are suspended by id, and only those ids are
#     resumed on release.
#
# What it is NOT: per-app shaping. That needs a kernel WFP callout driver and
# is permanently out of scope for this stage. Nothing here promises a speed.
#
# The capture step is separate from the apply step ON PURPOSE. The caller
# writes the captured prior state to disk BEFORE calling apply, so a crash
# between the two leaves a machine that is unchanged, and a crash after leaves
# a record that can put it back. Same rule as the vault: the restore manifest
# exists before the mutation does (INV-1).

$script:DoPolicyKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization'
$script:DoHeldBackgroundPercent = 1

function Get-NetworkHoldCapture {
    # Read-only: safe in Audit Mode, and the UI uses it to describe what a hold
    # would actually do before anyone commits to it.
    $keyExisted = Test-Path -LiteralPath $script:DoPolicyKey
    $values = [System.Collections.Generic.List[object]]::new()

    foreach ($name in @('DOPercentageMaxBackgroundBandwidth')) {
        $existed = $false
        $data = $null
        if ($keyExisted) {
            $prop = Get-ItemProperty -LiteralPath $script:DoPolicyKey -Name $name -ErrorAction SilentlyContinue
            if ($prop -and $null -ne $prop.$name) {
                $existed = $true
                $data = [int]$prop.$name
            }
        }
        $values.Add(@{ name = $name; existed = $existed; data = $data })
    }

    # Only jobs actually moving data are worth suspending. A job already
    # suspended by its own owner must not be resumed by our release - it was
    # not ours to touch, so it is never captured.
    $jobs = [System.Collections.Generic.List[object]]::new()
    $bitsError = $null
    try {
        $all = if (Test-IsElevated) { @(Get-BitsTransfer -AllUsers -ErrorAction Stop) }
               else                 { @(Get-BitsTransfer -ErrorAction Stop) }
        foreach ($job in $all) {
            $state = [string]$job.JobState
            if (@('Transferring','Connecting','Queued','TransientError') -notcontains $state) { continue }
            $jobs.Add(@{
                jobId       = [string]$job.JobId
                displayName = [string]$job.DisplayName
                state       = $state
            })
        }
    } catch {
        $bitsError = $_.Exception.Message
    }

    return @{
        success        = $true
        capturedAt     = (Get-Date).ToString('o')
        doKeyExisted   = $keyExisted
        doKeyPath      = $script:DoPolicyKey
        doValues       = @($values)
        bitsJobs       = @($jobs)
        bitsError      = $bitsError
        heldPercent    = $script:DoHeldBackgroundPercent
        elevated       = (Test-IsElevated)
    }
}

function Invoke-NetworkHoldApply {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or -not $p.record) {
        return @{ success = $false; error = "Nothing was captured first, so there would be no way back. Refused." }
    }

    $applied = [System.Collections.Generic.List[object]]::new()
    $failed  = [System.Collections.Generic.List[object]]::new()

    try {
        if (-not (Test-Path -LiteralPath $script:DoPolicyKey)) {
            $null = New-Item -Path $script:DoPolicyKey -Force -ErrorAction Stop
        }
        Set-ItemProperty -LiteralPath $script:DoPolicyKey `
            -Name 'DOPercentageMaxBackgroundBandwidth' `
            -Value $script:DoHeldBackgroundPercent -Type DWord -ErrorAction Stop
        $applied.Add(@{ kind = 'delivery-optimization'; detail = "background transfers capped at $($script:DoHeldBackgroundPercent)%" })
    } catch {
        $failed.Add(@{ kind = 'delivery-optimization'; error = $_.Exception.Message })
    }

    foreach ($job in @($p.record.bitsJobs)) {
        if (-not $job -or [string]::IsNullOrWhiteSpace($job.jobId)) { continue }
        try {
            $live = Get-BitsTransfer -AllUsers -ErrorAction Stop | Where-Object { [string]$_.JobId -eq [string]$job.jobId }
            if (-not $live) {
                # Finished between capture and apply. Not an error, and not
                # something release should try to resume.
                $failed.Add(@{ kind = 'bits'; jobId = [string]$job.jobId; error = 'finished before it could be held' })
                continue
            }
            Suspend-BitsTransfer -BitsJob $live -ErrorAction Stop
            $applied.Add(@{ kind = 'bits'; jobId = [string]$job.jobId; detail = [string]$job.displayName })
        } catch {
            $failed.Add(@{ kind = 'bits'; jobId = [string]$job.jobId; error = $_.Exception.Message })
        }
    }

    return @{
        success      = ($applied.Count -gt 0)
        applied      = @($applied)
        failed       = @($failed)
        appliedCount = $applied.Count
    }
}

function Invoke-NetworkHoldRevert {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required to put these settings back." }
    }
    if (-not $p -or -not $p.record) {
        return @{ success = $false; error = "No record of what was changed, so nothing can be put back." }
    }

    $restored = [System.Collections.Generic.List[object]]::new()
    $failed   = [System.Collections.Generic.List[object]]::new()
    $record   = $p.record

    foreach ($value in @($record.doValues)) {
        if (-not $value -or [string]::IsNullOrWhiteSpace($value.name)) { continue }
        try {
            if ($value.existed -eq $true) {
                Set-ItemProperty -LiteralPath $script:DoPolicyKey -Name $value.name -Value ([int]$value.data) -Type DWord -ErrorAction Stop
                $restored.Add(@{ kind = 'delivery-optimization'; detail = "$($value.name) put back to $($value.data)" })
            } else {
                Remove-ItemProperty -LiteralPath $script:DoPolicyKey -Name $value.name -ErrorAction SilentlyContinue
                $restored.Add(@{ kind = 'delivery-optimization'; detail = "$($value.name) removed - it was not set before" })
            }
        } catch {
            $failed.Add(@{ kind = 'delivery-optimization'; error = $_.Exception.Message })
        }
    }

    # If Vanish created the policy key, Vanish removes it - but only when it is
    # empty, because something else may have written to it in the meantime.
    if ($record.doKeyExisted -ne $true) {
        try {
            $key = Get-Item -LiteralPath $script:DoPolicyKey -ErrorAction SilentlyContinue
            if ($key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) {
                Remove-Item -LiteralPath $script:DoPolicyKey -Force -ErrorAction Stop
                $restored.Add(@{ kind = 'delivery-optimization'; detail = 'policy key removed - it did not exist before' })
            }
        } catch {
            $failed.Add(@{ kind = 'delivery-optimization'; error = $_.Exception.Message })
        }
    }

    foreach ($job in @($record.bitsJobs)) {
        if (-not $job -or [string]::IsNullOrWhiteSpace($job.jobId)) { continue }
        try {
            $live = Get-BitsTransfer -AllUsers -ErrorAction Stop | Where-Object { [string]$_.JobId -eq [string]$job.jobId }
            if (-not $live) {
                $restored.Add(@{ kind = 'bits'; jobId = [string]$job.jobId; detail = 'no longer on this PC' })
                continue
            }
            Resume-BitsTransfer -BitsJob $live -ErrorAction Stop
            $restored.Add(@{ kind = 'bits'; jobId = [string]$job.jobId; detail = 'resumed' })
        } catch {
            $failed.Add(@{ kind = 'bits'; jobId = [string]$job.jobId; error = $_.Exception.Message })
        }
    }

    return @{
        success       = ($failed.Count -eq 0)
        restored      = @($restored)
        failed        = @($failed)
        restoredCount = $restored.Count
    }
}

# --- 7oo.11: acting on a startup item ------------------------------------
#
# Three deliberately narrow verbs, not one general-purpose one. Each validates
# its own target against a shape that only its own surface produces, so none of
# them is a generic "delete any registry value" or "reconfigure any service"
# primitive reachable over IPC. The vault export that makes each reversible is
# performed by the caller BEFORE these run (FLOW-02); these do the write only.

function Remove-StartupRegistryValue {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }

    $keyPath   = [string]$p.keyPath
    $valueName = [string]$p.valueName

    if ([string]::IsNullOrWhiteSpace($valueName)) {
        return @{ success = $false; error = "Which startup entry? No value name was given." }
    }

    # Only the five Run/RunOnce keys this surface reads are writable from here.
    # Any other path - including a Run key under a different hive - is refused
    # rather than trusted because it arrived over IPC looking plausible.
    $allowed = @(
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
    )
    $match = $allowed | Where-Object { $_ -eq $keyPath }
    if (-not $match) {
        return @{ success = $false; error = "Rejected: '$keyPath' is not one of the Windows startup keys Vanish manages." }
    }

    try {
        $props = Get-ItemProperty -LiteralPath $keyPath -ErrorAction Stop
        if (-not ($props.PSObject.Properties.Name -contains $valueName)) {
            return @{ success = $false; error = "That startup entry is no longer in the registry." }
        }
        Remove-ItemProperty -LiteralPath $keyPath -Name $valueName -ErrorAction Stop
        return @{ success = $true; keyPath = $keyPath; valueName = $valueName }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

function Set-StartupServiceManual {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }

    $name = [string]$p.serviceName
    if ($name -notmatch '^[A-Za-z0-9_\.\- ]{1,256}$') {
        return @{ success = $false; error = "Rejected: that is not a valid service name." }
    }

    try {
        $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$($name -replace "'","''")'" -ErrorAction Stop
        if (-not $svc) { return @{ success = $false; error = "No service called '$name' is installed." } }

        # A boot or system-start service is kernel-adjacent and is not something
        # this surface offers to reconfigure. Get-StartupItems only lists Auto
        # services, so reaching this means the request did not come from the
        # list the user was looking at.
        $startKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$name"
        $start = (Get-ItemProperty -LiteralPath $startKey -Name Start -ErrorAction SilentlyContinue).Start
        if ($null -ne $start -and [int]$start -le 1) {
            return @{ success = $false; error = "'$name' is a boot-start driver. Vanish will not change how Windows loads it." }
        }

        Set-Service -Name $name -StartupType Manual -ErrorAction Stop
        return @{ success = $true; serviceName = $name; startupType = 'Manual'; previousStart = $start }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

function Set-StartupTaskEnabled {
    param([object]$p)

    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }

    $taskName = [string]$p.taskName
    $taskPath = [string]$p.taskPath
    $enable   = [bool]$p.enable

    if ([string]::IsNullOrWhiteSpace($taskName) -or [string]::IsNullOrWhiteSpace($taskPath)) {
        return @{ success = $false; error = "Which task? A task name and folder are both required." }
    }
    # Windows' own tasks are not listed by Get-StartupItems and are not
    # reconfigured from here, whatever arrives over IPC.
    if ($taskPath -like '\Microsoft\*') {
        return @{ success = $false; error = "Rejected: '$taskPath' is one of Windows' own scheduled tasks." }
    }

    try {
        $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
        if (-not $task) { return @{ success = $false; error = "That scheduled task no longer exists." } }

        if ($enable) { $null = Enable-ScheduledTask  -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop }
        else         { $null = Disable-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop }

        $after = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
        return @{
            success = $true
            taskName = $taskName
            taskPath = $taskPath
            state    = if ($after) { [string]$after.State } else { $null }
            enabled  = $enable
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

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
        $keywords = $categories[$catName]

        # Collapse to PRODUCT FAMILIES, not registry rows (7oo.6). Edge, Edge
        # Update and the WebView2 runtime are one browser; reporting "3 web
        # browsers installed - consider keeping only one" is wrong advice about
        # the user's own machine, and it is what the old row-counting produced.
        $families = [ordered]@{}

        foreach ($app in $installedApps) {
            # Components and update rows are never evidence of a second
            # installation - they belong to something already counted.
            if ($app.classification -ne 'application') { continue }

            $nameLower = $app.name.ToLower()
            $matches = $false
            foreach ($kw in $keywords) {
                if ($nameLower -like "*$kw*") { $matches = $true; break }
            }
            if (-not $matches) { continue }

            # Key on the VENDOR half of the family key, not the whole thing.
            # Redundancy means two products competing for the same job, and one
            # vendor's own products are not competing with each other: Kaspersky
            # and Kaspersky VPN matched the antivirus keywords and were reported
            # as "2 antivirus applications - keep only one", and Office plus the
            # Teams Meeting Add-in as "2 office suites". Both are advice that
            # would break the user's machine if followed.
            $key = ([string]$app.family).Split('|')[0]
            if (-not $families.Contains($key)) {
                $families[$key] = [PSCustomObject]@{
                    id         = $app.id
                    name       = $app.name
                    publisher  = $app.publisher
                    version    = $app.version
                    sizeBytes  = $app.sizeBytes
                    family     = $key
                    entryCount = 1
                }
            } else {
                # Keep the largest install as the representative - that is the
                # one worth acting on - and remember how many rows it covers.
                $existing = $families[$key]
                $existing.entryCount = $existing.entryCount + 1
                if ($app.sizeBytes -gt $existing.sizeBytes) {
                    $existing.name      = $app.name
                    $existing.id        = $app.id
                    $existing.version   = $app.version
                    $existing.sizeBytes = $app.sizeBytes
                }
            }
        }

        $matched = @($families.Values)

        # Redundancy means two DIFFERENT products doing the same job.
        if ($matched.Count -gt 1) {
            $groups.Add([PSCustomObject]@{
                category = $catName
                count    = $matched.Count
                apps     = $matched
                tip      = "You have $($matched.Count) different $catName applications installed. Consider keeping only one."
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

# Quote one argument for a Windows command line (TASK-05 / bd ...-ceb).
#
# Start-Process joins an -ArgumentList array with spaces and quotes NOTHING, so
# an unpackaged app path like "D:\quickhelp projects\vanish-uninstaller" reached
# Electron as two arguments and it tried to open the first as the app.
#
# The obvious repair - wrapping each argument in quotes - is not enough, and the
# process being launched here is elevated, which makes getting it wrong an
# argument-injection surface rather than a cosmetic bug:
#   * a path ending in a backslash produces "C:\foo\", where the backslash
#     escapes the closing quote and swallows the next argument;
#   * an embedded quote lets a crafted path inject further arguments.
# So follow the actual CommandLineToArgvW rules: double any run of backslashes
# that precedes a quote (or the closing quote), and escape embedded quotes.
function ConvertTo-ProcessArgument {
    param([string]$value)

    if ([string]::IsNullOrEmpty($value)) { return '""' }
    # Nothing that needs protecting: pass it through untouched.
    if ($value -notmatch '[\s"]') { return $value }

    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append('"')
    $slashes = 0

    foreach ($ch in $value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') {
            # Each backslash before a quote doubles, then the quote is escaped.
            $null = $sb.Append('\' * (($slashes * 2) + 1))
            $null = $sb.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { $null = $sb.Append('\' * $slashes); $slashes = 0 }
        $null = $sb.Append($ch)
    }

    # Trailing backslashes precede the closing quote, so they double too.
    if ($slashes -gt 0) { $null = $sb.Append('\' * ($slashes * 2)) }
    $null = $sb.Append('"')
    return $sb.ToString()
}

# Build the whole argument vector for Start-Process.
function ConvertTo-ProcessArgumentList {
    param([object[]]$values)
    return @(@($values) | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) })
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
# Resolve ONE hop: walk up from $full to the deepest existing ancestor, follow
# that ancestor's reparse point if it has one, and re-attach whatever tail
# didn't exist yet. Returns $null on an unreadable reparse point, $full
# unchanged if nothing on the path exists or nothing is a reparse point.
function Resolve-DestinationHop {
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

# A junction can point at another junction (A -> B -> C). Resolving only one
# hop would compare the guard against B while the write physically lands in
# C - Windows follows the whole chain transparently at write time. Keep
# re-resolving until the result stops changing (a fixed point) or the hop cap
# is hit, so the check runs against where the write actually lands.
function Resolve-DestinationTarget {
    param([string]$full)

    $current = $full
    for ($hop = 0; $hop -lt 32; $hop++) {
        $next = Resolve-DestinationHop $current
        if (-not $next) { return $null }              # unreadable reparse point along the chain
        if ($next -eq $current) { return $next }        # fixed point: nothing left to follow
        $current = $next
    }
    # 32 hops without stabilising is not a real filesystem configuration -
    # refuse rather than trust a result we could not pin down.
    return $null
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

# GPU per-process utilization (operator request, "show which GPU is doing
# what"). Windows exposes no CIM/WMI per-process GPU counter - the
# '\GPU Engine(*)\Utilization Percentage' perf counter is the same source
# Windows' own Task Manager reads, keyed by instance names shaped like
# pid_<pid>_luid_<hi>_<lo>_phys_<n>_eng_<m>_engtype_<type>.
#
# PERFORMANCE: measured ~1.5s for this single call on a real dual-GPU laptop
# (374 instances even near-idle) - far more than the rest of a Task Manager
# refresh costs combined. Deliberately a SEPARATE action from Get-ProcessList,
# meant to be sampled by the caller on a slower cadence, never folded into the
# fast per-tick process list (that would undo the startup/latency work done
# the same session this was requested in).
#
# Per-process figure is a SUM across that process's engines (3D, copy, video
# decode, etc), capped at 100 as a sanity bound - not a claim of exact parity
# with Task Manager's own internal weighting, which is not published. Higher
# still means busier; treat it as an indicator, not a certified percentage.
#
# Adapter naming: phys_N cannot be reliably mapped to a friendly adapter name
# (RTX 3080 vs AMD Radeon) through cheap CIM queries, and an idle discrete GPU
# under hybrid graphics reports NO instances at all - not a zero - until
# something wakes it, so there is nothing to correlate a name against most of
# the time anyway. Windows' own Task Manager has this exact limitation and
# labels a dual-GPU system "GPU 0" / "GPU 1" for the same reason; this does
# the same rather than guessing a vendor name.
function Get-GpuUsageByProcess {
    $byPid = @{}
    $byAdapter = @{}
    $luidByAdapter = @{}

    try {
        $counters = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop
    } catch {
        return @{ success = $false; error = $_.Exception.Message; byPid = @{}; byAdapter = @() }
    }

    # Operator: "you got ids returned from both of them, so why not remember
    # those ids... phys_N is friction since a card can be turned off by an
    # OEM app." Right - phys_N is an ordinal into whichever adapters happen
    # to have an active engine RIGHT NOW, not a stable identity; it can shift
    # or vanish as a discrete GPU sleeps/wakes under hybrid graphics. The
    # LUID embedded in the same instance name IS the stable per-boot adapter
    # identity (confirmed live: matches exactly what chrome://gpu reports for
    # the same physical adapter, see main.js get-gpu-vendors) - captured here
    # per phys_N group so the caller can join on LUID instead of ordinal
    # position.
    foreach ($sample in $counters.CounterSamples) {
        if ($sample.InstanceName -notmatch 'pid_(\d+)_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_(\d+)_eng_') { continue }
        $procId    = [int]$Matches[1]
        $luidHigh  = [Convert]::ToInt32($Matches[2], 16)
        $luidLow   = [Convert]::ToUInt32($Matches[3], 16)
        $physIdx   = [int]$Matches[4]

        if (-not $luidByAdapter.ContainsKey($physIdx)) {
            $luidByAdapter[$physIdx] = @{ high = $luidHigh; low = $luidLow }
        }

        if ($sample.CookedValue -le 0) { continue }

        if (-not $byPid.ContainsKey($procId)) { $byPid[$procId] = 0.0 }
        $byPid[$procId] += $sample.CookedValue

        if (-not $byAdapter.ContainsKey($physIdx)) { $byAdapter[$physIdx] = 0.0 }
        $byAdapter[$physIdx] += $sample.CookedValue
    }

    $pidResult = @{}
    foreach ($k in $byPid.Keys) {
        $pidResult["$k"] = [Math]::Round([Math]::Min(100, $byPid[$k]), 1)
    }

    # Every phys_N seen this sample gets an entry, even at 0% - a LUID with no
    # current engine activity is still a real, present adapter the caller may
    # want to show as idle rather than silently dropped.
    $allPhys = @($luidByAdapter.Keys) + @($byAdapter.Keys) | Sort-Object -Unique
    $adapterResult = @($allPhys | ForEach-Object {
        $luid = $luidByAdapter[$_]
        @{
            physIndex = $_
            percent   = if ($byAdapter.ContainsKey($_)) { [Math]::Round([Math]::Min(100, $byAdapter[$_]), 1) } else { 0.0 }
            luidHigh  = if ($luid) { $luid.high } else { $null }
            luidLow   = if ($luid) { $luid.low } else { $null }
        }
    })

    return @{ success = $true; byPid = $pidResult; byAdapter = $adapterResult }
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

$Script:ProcessKillDenylistFatal = @(
    'system', 'system idle process', 'registry', 'csrss', 'wininit', 'winlogon',
    'services', 'lsass', 'smss'
)

function Stop-VanishProcess {
    param([object]$p)
    if (-not (Test-IsElevated)) {
        return @{ success = $false; error = "Full Mode required. Vanish is running in Audit Mode (read-only)." }
    }
    if (-not $p -or -not $p.pid) { return @{ success = $false; error = "A process id is required." } }

    # Defense in depth: the renderer already refuses to offer this, but the
    # IPC boundary is the real security boundary here (same reasoning as
    # every elevation check in this file), not the UI that calls it.
    try {
        $target = Get-Process -Id ([int]$p.pid) -ErrorAction Stop
        if ($Script:ProcessKillDenylistFatal -contains $target.ProcessName.ToLowerInvariant()) {
            return @{ success = $false; error = "Refusing to end $($target.ProcessName): a core Windows process, ending it crashes or force-restarts the session." }
        }
    } catch {
        # Process already gone by the time we checked - fall through to Stop-Process,
        # which will fail with its own clear error.
    }

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

# Base keys are cached per hive+view for the life of the process.
#
# OpenBaseKey is the expensive half of a registry read - for ClassesRoot
# especially, which Windows synthesises by merging HKLM\Software\Classes with
# HKCU\Software\Classes - and every single value lookup was paying it. The
# context-menu cleaner does six roots x two views x N handlers x up to six
# server lookups, so this ran thousands of times in one scan and the sweep did
# not finish inside five minutes on the operator's machine.
#
# Safe because these handles are read-only and process-lifetime: scanner.ps1 is
# spawned per action and exits, so there is no long-lived stale handle to worry
# about. Callers still .Close() whatever they are handed, which is why the
# empty-subKey case below opens a private handle rather than lending the cached
# one out to be closed.
$script:RegistryBaseKeys = @{}

function Get-CachedRegistryBaseKey {
    param([string]$hive, [string]$view)
    $cacheKey = "$hive|$view"
    if ($script:RegistryBaseKeys.ContainsKey($cacheKey)) {
        return $script:RegistryBaseKeys[$cacheKey]
    }
    $base = $null
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::$hive,
            [Microsoft.Win32.RegistryView]::$view)
    } catch {
        $base = $null
    }
    $script:RegistryBaseKeys[$cacheKey] = $base
    return $base
}

function Open-RegistryView {
    param(
        [ValidateSet('ClassesRoot','CurrentUser','LocalMachine','Users','CurrentConfig')]
        [string]$hive,
        [string]$subKey,
        [ValidateSet('Registry64','Registry32','Default')]
        [string]$view = 'Registry64'
    )
    try {
        if ([string]::IsNullOrEmpty($subKey)) {
            # The caller owns and closes this one, so it must not be the cache's.
            return [Microsoft.Win32.RegistryKey]::OpenBaseKey(
                [Microsoft.Win32.RegistryHive]::$hive,
                [Microsoft.Win32.RegistryView]::$view)
        }
        $base = Get-CachedRegistryBaseKey -hive $hive -view $view
        if (-not $base) { return $null }
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

    $stageTotal = 2 * $roots.Count
    $stageDone = 0

    foreach ($view in @('Registry64','Registry32')) {
        foreach ($root in $roots) {
            $stageDone++
            Write-ScanProgress -stage "$($root.Label) ($view)" -done $stageDone -total $stageTotal -found $findings.Count
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

        # HKCR carries tens of thousands of ProgIds, so this is the scan most
        # likely to leave a user staring at a spinner. Report every few hundred
        # rather than every entry - a progress line per item costs more than the
        # work it describes.
        $checked = 0
        $reportEvery = 250

        foreach ($progId in $progIds) {
            $checked++
            if ($checked % $reportEvery -eq 0) {
                Write-ScanProgress -stage "File associations ($view)" -done $checked -total $progIds.Count -found $findings.Count
            }

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

# --- Left-over Store (UWP/MSIX) app data ---------------------------------
# Uninstalling a Store app removes the package but NOT the per-user data folder
# it wrote to %LOCALAPPDATA%\Packages\<PackageFamilyName>. Windows never
# collects these, nothing in Settings surfaces them, and they routinely hold
# hundreds of megabytes years after the app is gone. No other surface in Vanish
# looks at them, because the app list only reports packages Windows still
# registers -- which is precisely the set these folders are NOT in.
#
# The dangerous mistake here is deleting the data folder of an app that IS
# installed, so every ambiguity resolves toward keeping the folder:
#   - the "installed" set is the UNION of this user's registrations and, when
#     elevated, every user's, so a package registered for somebody else still
#     counts as installed;
#   - Windows' own shell and framework families are never offered for removal
#     even when they look orphaned, because servicing unregisters them briefly;
#   - a folder touched in the last few days is held back entirely, since an
#     install, update or repair in flight looks exactly like an orphan.
$script:UwpProtectedFamilyPatterns = @(
    '^Microsoft\.Windows\.',
    '^MicrosoftWindows\.',
    '^Microsoft\.UI\.Xaml',
    '^Microsoft\.VCLibs',
    '^Microsoft\.NET\.',
    '^Microsoft\.WindowsAppRuntime',
    '^Microsoft\.Services\.Store',
    '^Microsoft\.AAD\.',
    '^Microsoft\.AccountsControl',
    '^Microsoft\.AsyncTextService',
    '^Microsoft\.BioEnrollment',
    '^Microsoft\.CredDialogHost',
    '^Microsoft\.ECApp',
    '^Microsoft\.LockApp',
    '^Microsoft\.Win32WebViewHost',
    '^Microsoft\.XboxGameCallableUI',
    '^Microsoft\.MicrosoftEdge',
    '^windows\.',
    '^Windows\.'
)

function Test-UwpProtectedFamily {
    param([string]$familyName)
    if ([string]::IsNullOrWhiteSpace($familyName)) { return $true }
    foreach ($pattern in $script:UwpProtectedFamilyPatterns) {
        if ($familyName -match $pattern) { return $true }
    }
    return $false
}

# Every package family Windows currently knows about, lower-cased for lookup.
# -AllUsers needs elevation and is the slower of the two calls, so it is only
# attempted in Full Mode - but its absence can only ever make the scan more
# conservative, never less.
function Get-UwpFamilyIndex {
    $index = @{}

    foreach ($pkg in (Get-AppxPackage -ErrorAction SilentlyContinue)) {
        $family = [string]$pkg.PackageFamilyName
        if (-not [string]::IsNullOrWhiteSpace($family)) { $index[$family.ToLowerInvariant()] = $true }
    }

    if (Test-IsElevated) {
        foreach ($pkg in (Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue)) {
            $family = [string]$pkg.PackageFamilyName
            if (-not [string]::IsNullOrWhiteSpace($family)) { $index[$family.ToLowerInvariant()] = $true }
        }
    }

    return $index
}

function Find-UwpLeftovers {
    param([object]$p)

    $findings = [System.Collections.Generic.List[object]]::new()

    # Overridable so the harness can plant a folder and see it in the same run;
    # the shipped default is 7 days.
    $recentDays = 7
    if ($p -and $null -ne $p.recentDays) {
        $parsed = 0
        if ([int]::TryParse([string]$p.recentDays, [ref]$parsed) -and $parsed -ge 0) { $recentDays = $parsed }
    }

    $packagesRoot = Join-Path $env:LOCALAPPDATA 'Packages'
    if (-not (Test-Path -LiteralPath $packagesRoot)) {
        return @{
            success  = $true
            findings = $findings
            note     = "This account has no Store app data folder, so there is nothing to sweep."
        }
    }

    Write-ScanProgress -stage "Reading installed Store packages" -done 0 -total 0 -found 0
    $installed = Get-UwpFamilyIndex

    # A machine that reports zero registered packages is far more likely to be
    # a failed AppX query than a machine with no Store apps at all, and acting
    # on that answer would propose deleting every folder under Packages.
    if ($installed.Count -eq 0) {
        return @{
            success = $false
            error   = "Windows did not return any installed Store packages, so Vanish cannot tell which folders are left over. Nothing was examined."
        }
    }

    $folders = @(Get-ChildItem -LiteralPath $packagesRoot -Directory -Force -ErrorAction SilentlyContinue)
    $cutoff = (Get-Date).AddDays(-$recentDays)
    $orphans = [System.Collections.Generic.List[object]]::new()
    $recentlyTouched = 0
    $notPackageShaped = 0
    $examined = 0

    foreach ($folder in $folders) {
        $examined++
        $family = $folder.Name

        # This directory is not only for Store packages - it is where Windows
        # keeps every AppContainer profile, including the sandboxes desktop
        # programs create for themselves (Chrome's "cr.sb.*", Windows' own
        # "ActiveSync"). Those have no package to be missing, so "no package
        # claims it" says nothing about them. Only folders shaped like a real
        # package family name (Name_PublisherId, 13-character publisher id) are
        # ever considered.
        if ($family -notmatch '^[A-Za-z0-9][A-Za-z0-9\.\-]*_[a-z0-9]{13}$') {
            $notPackageShaped++
            continue
        }

        if ($installed.ContainsKey($family.ToLowerInvariant())) { continue }

        if ($folder.LastWriteTime -gt $cutoff) {
            $recentlyTouched++
            continue
        }

        $orphans.Add($folder)
    }

    # Sizing is the expensive half (a full recursive walk per folder), so it
    # runs over the orphans only - never over all ~120 packages, which is the
    # mistake that made the app list take ten seconds.
    $done = 0
    foreach ($folder in $orphans) {
        $done++
        Write-ScanProgress -stage "Measuring left-over app data" -done $done -total $orphans.Count -found $findings.Count

        $family    = $folder.Name
        $shortName = $family.Split('_')[0]
        $sizeBytes = Get-FolderSize $folder.FullName
        $sizeLabel = Format-ByteSize $sizeBytes
        $ageDays   = [int]((Get-Date) - $folder.LastWriteTime).TotalDays
        $protected = Test-UwpProtectedFamily $family
        $isMicrosoft = $family -match '^Microsoft\.' -or $family -match '^MicrosoftCorporationII\.'

        $risk = if ($protected) { "Advanced" }
                elseif ($isMicrosoft -or $ageDays -lt 30) { "Moderate" }
                else { "Safe" }

        $findings.Add(@{
            id        = "uwp|$family"
            label     = "$shortName - $sizeLabel"
            evidence  = "no installed app package claims $family; last changed $($folder.LastWriteTime.ToString('yyyy-MM-dd')) ($ageDays days ago)"
            risk      = $risk
            kind      = "file"
            path      = $folder.FullName
            removable = (-not $protected)
            note      = if ($protected) {
                            "Part of Windows itself. Vanish will not offer to remove it, because Windows unregisters these briefly during updates and a folder that looks left over may not be."
                        } else { $null }
            sizeBytes = $sizeBytes
            meta      = @{ family = $family; sizeBytes = $sizeBytes; ageDays = $ageDays }
        })
    }

    $notes = [System.Collections.Generic.List[string]]::new()
    if ($recentlyTouched -gt 0) {
        $notes.Add("$recentlyTouched folder(s) changed in the last $recentDays days were left out - an install or update in progress looks the same as a leftover.")
    }
    if ($notPackageShaped -gt 0) {
        $notes.Add("$notPackageShaped folder(s) here are sandboxes belonging to ordinary programs rather than Store apps, so they were not examined.")
    }
    if ($findings.Count -eq 0) {
        $notes.Add("Checked $examined app data folder(s); nothing was left behind by an app that is gone.")
    }

    return @{
        success  = $true
        findings = $findings
        note     = if ($notes.Count -gt 0) { ($notes -join ' ') } else { $null }
    }
}

# Registered packages whose payload is gone: Windows still lists the app, the
# Start tile still exists, and launching it fails. Audit only -- there is no
# restore manifest for a package registration, so INV-1 forbids offering to
# remove one from here.
function Find-BrokenAppxRegistrations {
    $findings = [System.Collections.Generic.List[object]]::new()

    foreach ($pkg in (Get-AppxPackage -ErrorAction SilentlyContinue)) {
        if ($pkg.IsFramework) { continue }
        if ($pkg.SignatureKind -eq 'System') { continue }

        $location = [string]$pkg.InstallLocation
        if (-not [string]::IsNullOrWhiteSpace($location) -and (Test-Path -LiteralPath $location -ErrorAction SilentlyContinue)) { continue }

        $findings.Add(@{
            id        = "appx|$($pkg.PackageFullName)"
            label     = [string]$pkg.Name
            evidence  = if ([string]::IsNullOrWhiteSpace($location)) {
                            "Windows lists this Store app but records no folder for it"
                        } else {
                            "Windows lists this Store app but its folder is gone: $location"
                        }
            risk      = "Moderate"
            kind      = "appx-registration"
            removable = $false
            note      = "Listed so you know why the app fails to open. Removing the registration is a Windows operation with no undo, so Vanish does not do it from here - use the app list."
            meta      = @{ packageFullName = [string]$pkg.PackageFullName; installLocation = $location }
        })
    }

    return $findings
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

# A scan that found nothing must return an EMPTY list, not a list holding one
# null.
#
# PowerShell collapses an empty pipeline to $null, and @($null) is an array of
# length one whose single element is null. That null crossed IPC as a JSON null
# and took the whole System Clean panel down the moment it rendered - "Cannot
# read properties of null (reading 'removable')" - on a machine whose context
# menus are perfectly clean. The stub suite never saw it because its fixtures
# always return at least one finding.
function ConvertTo-FindingList {
    param([object]$findings)
    $list = @(@($findings) | Where-Object { $null -ne $_ })
    # The leading comma is load-bearing. `return @()` unrolls an empty array to
    # nothing on the way out, the hashtable field becomes $null, and the JSON
    # carries "findings": null - which is the same one-element-null the caller
    # was trying to avoid, just arrived by a different route. Wrapping in a
    # single-element outer array stops the unrolling.
    return ,$list
}

function Invoke-CleanerScan {
    param([object]$p)

    $cleaner = if ($p) { [string]$p.cleaner } else { "" }

    try {
        switch ($cleaner) {
            "context-menus" { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Set-FindingRemovability (Find-OrphanContextMenus))) } }
            "services"      { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Find-OrphanServices)) } }
            "drivers"       { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Find-OrphanDriverPackages)) } }
            "path"          { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Find-DeadPathEntries)) } }
            "associations"  { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Set-FindingRemovability (Find-DeadAssociations))) } }
            "uwp-leftovers" {
                $res = Find-UwpLeftovers -p $p
                if (-not $res.success) { return @{ success = $false; cleaner = $cleaner; error = $res.error } }
                # Broken registrations are audit-only rows in the same list: the
                # user's question is "what Store junk is on this machine", not
                # "which registry hive backs it".
                $all = [System.Collections.Generic.List[object]]::new()
                foreach ($f in @($res.findings)) { $all.Add($f) }
                foreach ($f in @(Find-BrokenAppxRegistrations)) { $all.Add($f) }
                return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList $all); note = $res.note }
            }
            "profiles"      {
                $res = Find-OtherProfileRemnants -p $p
                if ($res.success) { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList $res.findings); note = $res.note } }
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

    # Read the machine ONCE, through the same classified inventory the app list
    # uses. This used to be a second, independent registry sweep that reapplied
    # the old SystemComponent/ParentKeyName drops by hand, and the comment above
    # it claimed "so the two lists agree" while guaranteeing the opposite: an
    # entry hidden from the inventory was also hidden from the surface whose
    # whole job is rescuing entries nobody else can remove.
    $entries = Add-EntryClassification (Get-UninstallRegistryEntries)

    foreach ($e in $entries) {
        # Updates are serviced by Windows, not force-uninstalled by us.
        if ($e.classification -eq 'update') { continue }

        # A component was never independently removable in the first place, so
        # "its uninstaller is missing" is not a fault to be fixed - it is the
        # normal shape of a bookkeeping row. Listing the fifteen NVIDIA
        # container entries as things to force-uninstall is exactly the "shows
        # wrong entries which cant be uninstalled" the operator reported.
        if ($e.classification -eq 'component') { continue }

        # Protected entries are Windows' own servicing plumbing. Offering to
        # force them out is not a feature.
        if ($e.protected) { continue }

        $reasons = [System.Collections.Generic.List[string]]::new()

        if ([string]::IsNullOrWhiteSpace($e.uninstallString)) {
            $reasons.Add("no UninstallString - Windows has no way to uninstall this")
        } elseif (-not $e.actionable) {
            $reasons.Add("uninstaller is missing: $($e.uninstallerPath)")
        }

        if (-not [string]::IsNullOrWhiteSpace($e.installLocation)) {
            $expanded = [System.Environment]::ExpandEnvironmentVariables([string]$e.installLocation)
            if (-not (Test-Path -LiteralPath $expanded -ErrorAction SilentlyContinue)) {
                $reasons.Add("install folder is gone: $expanded")
            }
        }

        if ($reasons.Count -eq 0) { continue }

        $findings.Add(@{
            id              = "broken|$($e.hiveLabel)|$($e.keyName)"
            displayName     = [string]$e.name
            publisher       = [string]$e.publisher
            hiveLabel       = $e.hiveLabel
            registryPath    = $e.registryPath
            uninstallString = [string]$e.uninstallString
            uninstallerPath = $e.uninstallerPath
            uninstallerOk   = $e.actionable
            installLocation = [string]$e.installLocation
            classification  = $e.classification
            reasons         = @($reasons)
            evidence        = ($reasons -join "; ")
        })
    }

    # What was considered and deliberately left out, so an empty or short list is
    # an answer rather than a shrug.
    $skipped = @($entries | Where-Object { $_.classification -ne 'application' -or $_.protected })

    return @{
        success       = $true
        findings      = $findings
        total         = $findings.Count
        examinedCount = $entries.Count
        skippedCount  = $skipped.Count
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
        "list-windows-features" {
            Get-WindowsFeatures | ConvertTo-Json -Depth 5
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
        "relaunch-argv-probe" {
            # TASK-05 verification hook: return the argument vector the elevated
            # relaunch WOULD be launched with, without triggering UAC. The
            # relaunch itself needs a human at the consent prompt, which is why
            # this bug shipped uncovered.
            $probeArgs = @()
            if ($Params.argList) { $probeArgs = @($Params.argList) }
            $quoted = ConvertTo-ProcessArgumentList $probeArgs
            @{
                success     = $true
                argv        = @($quoted)
                commandLine = ($quoted -join ' ')
            } | ConvertTo-Json -Depth 4 -Compress
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
        "get-gpu-usage" {
            Get-GpuUsageByProcess | ConvertTo-Json -Depth 4 -Compress
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
                    # Start-Process joins -ArgumentList with spaces and quotes
                    # nothing, so a spaced app path arrived as two arguments.
                    $quoted = ConvertTo-ProcessArgumentList $argList
                    $null = Start-Process -FilePath $Params.exePath -ArgumentList $quoted -Verb RunAs -ErrorAction Stop
                } else {
                    $null = Start-Process -FilePath $Params.exePath -Verb RunAs -ErrorAction Stop
                }
                @{ success = $true } | ConvertTo-Json -Compress
            } catch {
                # Every Start-Process -Verb RunAs failure used to collapse into
                # the same declined:true, whether it was a real UAC "No" click,
                # a machine where the account isn't an administrator at all,
                # or a UAC-disabled machine where no consent dialog exists to
                # click through. Win32 1223 (ERROR_CANCELLED) is the ONE code
                # that specifically means "the user dismissed the prompt" --
                # everything else is a different, more useful cause to report.
                $nativeCode = $null
                if ($_.Exception -is [System.ComponentModel.Win32Exception]) {
                    $nativeCode = $_.Exception.NativeErrorCode
                } elseif ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception]) {
                    $nativeCode = $_.Exception.InnerException.NativeErrorCode
                }
                $uac = Get-UacDiagnostics
                $cause = 'unknown'
                if ($nativeCode -eq 1223) {
                    $cause = 'declined'
                } elseif ($uac.isGroupMember -eq $false) {
                    $cause = 'not-admin'
                } elseif ($uac.enableLua -eq $false) {
                    $cause = 'uac-disabled'
                }
                @{
                    success         = $false
                    declined        = ($cause -eq 'declined')
                    cause           = $cause
                    nativeErrorCode = $nativeCode
                    uac             = $uac
                    error           = $_.Exception.Message
                } | ConvertTo-Json -Compress -Depth 4
            }
        }
        # ---- STAGE 2: AUDIT & HEALTH ADVISOR ----
        "get-system-diagnostics" {
            Get-SystemDiagnostics | ConvertTo-Json -Depth 6
        }
        "get-startup-items" {
            Get-StartupItems | ConvertTo-Json -Depth 5
        }
        "get-network-activity" {
            Get-NetworkActivity -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "network-hold-capture" {
            Get-NetworkHoldCapture | ConvertTo-Json -Depth 6 -Compress
        }
        "network-hold-apply" {
            Invoke-NetworkHoldApply -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "network-hold-revert" {
            Invoke-NetworkHoldRevert -p $Params | ConvertTo-Json -Depth 6 -Compress
        }
        "startup-remove-registry" {
            Remove-StartupRegistryValue -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "startup-service-manual" {
            Set-StartupServiceManual -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "startup-task-enabled" {
            Set-StartupTaskEnabled -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "get-software-redundancy" {
            Get-SoftwareRedundancy | ConvertTo-Json -Depth 5
        }
        default {
            @{ success = $false; error = "Unknown action '$Action'" } | ConvertTo-Json
        }
    }
}
