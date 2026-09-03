# Vanish PowerShell Uninstaller & Cleaner backend script
# Designed to be invoked by Node/Electron and return JSON payloads.

param(
    [string]$Action,
    [string]$ParamsBase64
)

$OutputEncoding = [System.Text.Encoding]::UTF8

# STDOUT CARRIES ONE JSON DOCUMENT AND NOTHING ELSE.
#
# powershell.exe sends only the ERROR stream to stderr. Warning, verbose,
# debug and information records go to STDOUT when it is redirected - which is
# how every caller of this engine reads it. So a warning from any cmdlet
# anywhere below prepends "WARNING: ..." to the payload and breaks the
# contract, and try/catch does not stop it: a warning is not an error.
#
# main.js does a strict JSON.parse and rejects with ENGINE_BAD_OUTPUT, so the
# user is told "the scanning engine returned something unexpected" about a
# feature that worked perfectly. Observed in Windows Sandbox on 2026-08-19:
# get-network-activity warned, its JSON was unparseable, and the suite reading
# it died mid-run with no result at all (8ok).
#
# Diagnostics are not lost by this - they were never reaching a human. The one
# channel that IS wanted is scan progress, which has its own: stderr, behind a
# marker, defined just below.
$WarningPreference     = 'SilentlyContinue'
$VerbosePreference     = 'SilentlyContinue'
$DebugPreference       = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

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

                    # c0y: the date and WHERE IT CAME FROM travel together.
                    # The fallback below is defensible - a good many installers
                    # do name their uninstall key with the install date - and it
                    # is properly guarded, so a key named "RealPlayer 25.0"
                    # correctly yields nothing rather than a fabricated date.
                    # What was wrong was downstream: an inferred date and a
                    # recorded one rendered identically, so a user sorting by
                    # age or deciding whether something is old enough to remove
                    # was acting on a mix of the two with no way to tell which
                    # was which. Same discipline as bu2's owned/orphaned/
                    # unattributed - a guess never wears the clothes of a fact.
                    $installDate = Format-InstallDate ([string]$key.GetValue('InstallDate'))
                    $installDateSource = if ($installDate) { 'recorded' } else { $null }
                    if (-not $installDate -and $childName -match '^\d{8}$') {
                        $installDate = Format-InstallDate $childName
                        if ($installDate) { $installDateSource = 'key-name' }
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
                        installDateSource = $installDateSource
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

# Researched but NOT implemented: GOG Galaxy, Ubisoft Connect, EA App/
# Origin, Battle.net. GOG in particular got real research (its per-game
# goggame-<id>.info file does exist and does carry install-size-shaped data
# in a "depots" array), but every source found describes the DOWNLOAD-TIME
# content-manifest shape, not confirmed against what actually sits in that
# file post-install on a real machine - and a wrong field name here would
# not fail loudly, it would silently attach a plausible-looking wrong number
# to a real game (worse than "unknown", the status quo). Same bar Epic was
# held to (documented format, flagged not-live-tested) - GOG doesn't clear
# it yet. Add a provider below once verified against a real install, same
# shape as Get-SteamLibrarySizes/Get-EpicManifestSizes: return a hashtable
# of lowercased install-path -> sizeBytes, add it to $script:GamePlatformSizeProviders.

# Ordered by confidence: Steam is live-verified against a real install with
# two libraries; Epic matches its documented .item manifest shape but has
# not been run against a real Epic install (not present on the machine this
# was written against).
$script:GamePlatformSizeProviders = @(
    ${function:Get-SteamLibrarySizes},
    ${function:Get-EpicManifestSizes}
)

# Backfills ONLY sizeBytes, and only when the registry itself reported none -
# nothing else about an entry (name, uninstall string, publisher) is ever
# touched by this. Providers run in the order above and stop at the first
# match; each provider's own lookup table is built at most once per call,
# only if a candidate entry actually needs it. A miss across every provider
# is silent and leaves the entry exactly as it already rendered (unknown
# size, still fully listable and uninstallable).
function Add-GamePlatformSizes {
    param([object[]]$entries)

    # Indexed by provider position, not name - a scriptblock reference
    # (${function:Name}) does not reliably expose its own function name back
    # (its .Ast is the body's ScriptBlockAst, not a FunctionDefinitionAst),
    # and an index is simpler and just as correct for a cache keyed only
    # within this one call.
    $providerCache = @{}

    foreach ($e in $entries) {
        if ($e.sizeBytes -gt 0) { continue }
        if ([string]::IsNullOrWhiteSpace($e.installLocation)) { continue }

        $key = $e.installLocation.ToLowerInvariant().TrimEnd('\')

        for ($i = 0; $i -lt $script:GamePlatformSizeProviders.Count; $i++) {
            if (-not $providerCache.ContainsKey($i)) {
                $providerCache[$i] = & $script:GamePlatformSizeProviders[$i]
            }
            $sizes = $providerCache[$i]
            if ($sizes.ContainsKey($key)) {
                $e.sizeBytes = $sizes[$key]
                break
            }
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
        # ht8: a redistributable is a shared runtime some OTHER program installed
        # and depends on. 22 of them on the operator machine, and the reason this
        # is a FLAG rather than a new classification is that they are already
        # correctly classified as components - what was missing was any way to
        # count them or see them as a group, so 22 rows of near-identical
        # Microsoft Visual C++ entries just read as noise.
        #
        # INFORMATION ONLY, per the reduced Stage 13 scope. No removal is offered
        # from this surface and none should be: knowing whether a redistributable
        # is still needed requires reading the import tables of every binary on
        # the machine, and without that the honest answer is that removing one
        # may break a program that will not say why.
        $e | Add-Member -NotePropertyName isRuntime -NotePropertyValue ([bool]($e.name -match $script:SharedRuntimePattern)) -Force
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
            installDateSource    = $e.installDateSource
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
            isRuntime            = $e.isRuntime
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
                installDateSource    = $null
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
                # c0y: this is the RealPlayer mistake in code form. $date is
                # the install FOLDER's CreationTime, not an install record -
                # exactly the kind of plausible-but-differently-sourced value
                # that got stated as fact in conversation. It is a good
                # estimate and worth showing; it is not a date the package
                # recorded, and it no longer claims to be.
                installDate     = $date
                installDateSource = if ($date) { 'folder-created' } else { $null }
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

    # EnableLUA is not the only way for the consent prompt to never appear, and
    # reading it alone produced a wrong answer on the operator's own machine.
    #
    # Measured 2026-08-28: EnableLUA = 1, ConsentPromptBehaviorAdmin = 0. UAC is
    # ON - processes still start with a filtered token, which is why Vanish
    # opens in Audit Mode - but an administrator's elevation request is
    # AUTO-APPROVED with no dialog. The operator reported this as "the prompt
    # won't show because uac is disabled". It is not disabled; prompts are
    # suppressed, and those are different machines to give advice to.
    #
    # It matters for the cause codes below. With EnableLUA true, isGroupMember
    # true and no Win32 1223 (there is no prompt to cancel), every specific
    # branch misses and a failed relaunch reports cause = 'unknown' - which is
    # exactly the "comes back in Audit Mode and says nothing useful" of adg.
    #
    #   0 = elevate with no prompt at all
    #   1 = prompt for credentials on the secure desktop
    #   2 = prompt for consent on the secure desktop
    #   3 = prompt for credentials
    #   4 = prompt for consent
    #   5 = prompt for consent for non-Windows binaries (Windows default)
    $consentPromptAdmin = $null
    try {
        $cval = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name ConsentPromptBehaviorAdmin -ErrorAction Stop
        $consentPromptAdmin = [int]$cval.ConsentPromptBehaviorAdmin
    } catch {
        $consentPromptAdmin = $null   # unreadable or absent -- unknown, not "prompts normally"
    }

    # The one fact the UI actually needs: will the user SEE anything when
    # Vanish asks for elevation? Left $null when the value could not be read,
    # because "no prompt will appear" is a claim, not a default.
    $silentElevation = if ($null -eq $consentPromptAdmin) { $null } else { ($consentPromptAdmin -eq 0) }

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

    # qyt: WHY does UAC read as off. On a domain-joined, GPO-managed machine
    # EnableLUA is very often force-set by Group Policy and silently reverts on
    # the next policy refresh if a local admin changes it by hand. That is a
    # materially different situation from a home machine where somebody
    # switched the same value off once and it stays off - in the first case the
    # user cannot fix it and should not be told to try.
    #
    # Windows does not tag policy-origin on these values, so there is no clean
    # flag to read. Two facts get us most of the way honestly:
    $partOfDomain = $null
    try {
        $partOfDomain = [bool](Get-CimInstance -Query "SELECT PartOfDomain FROM Win32_ComputerSystem" -ErrorAction Stop).PartOfDomain
    } catch {
        $partOfDomain = $null   # unknown, not false (Rule 24)
    }

    # Can an ADMINISTRATOR token write the policy key? Two deliberate changes
    # from how qyt was originally specified, both about not overclaiming:
    #
    # 1. This is only asked when the current process is ALREADY elevated. An
    #    unelevated process cannot write HKLM under any circumstances, so
    #    running the probe from Audit Mode would report "locked by policy" on
    #    every ordinary home machine in the world - a confident, plausible,
    #    completely wrong answer, which is the specific failure this issue
    #    exists to prevent. Unelevated leaves it $null: unknown.
    # 2. It writes a SCRATCH value and removes it, rather than setting and
    #    reverting EnableLUA as the issue suggested. The scratch value proves
    #    write access to the same key with the same ACL, and a failure halfway
    #    through leaves a stray value instead of a machine with UAC off.
    $policyWritable = $null
    if ($isElevatedNow) {
        $policyKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
        $probeName = 'VanishWriteProbe'
        try {
            New-ItemProperty -Path $policyKey -Name $probeName -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
            $policyWritable = $true
        } catch {
            $policyWritable = $false
        } finally {
            try { Remove-ItemProperty -Path $policyKey -Name $probeName -ErrorAction Stop } catch {}
        }
    }

    # Deliberately named "likely". The heuristic can say "this looks locked
    # down, and this machine is domain-joined"; it cannot say "Group Policy
    # did this", and no wording built on it may claim otherwise.
    $lockLikely = ($partOfDomain -eq $true -and $policyWritable -eq $false)

    return @{
        enableLua          = $enableLua
        consentPromptAdmin = $consentPromptAdmin
        silentElevation    = $silentElevation
        isElevatedNow      = $isElevatedNow
        isGroupMember      = $isGroupMember
        partOfDomain       = $partOfDomain
        policyWritable     = $policyWritable
        lockLikely         = $lockLikely
    }
}

# 5.7 De-elevation mechanisms (9vp).
#
# MEASURED, not reasoned about. test/deelevation-probe.ps1 was run from an
# elevated shell on the operator's machine 2026-08-13 and probed three ways
# of starting a process without the privilege the caller holds:
#
#   runas.exe /trustlevel:0x20000              NO RESULT (exit 1)
#   explorer token, CreateProcessWithTokenW    NO RESULT (child died 0xc0000142)
#   scheduled task, RunLevel Limited           DROPPED PRIVILEGE
#                                              Medium Mandatory Level, S-1-16-8192
#
# That closes a question five sessions could not: runas /trustlevel is the
# Windows-documented mechanism for this and it does not work here. In the app
# it was worse than failing - it exited 0, so 0.5.0 reported a successful
# de-elevation and came back Full Mode, which is the relaunch-deelevated-
# mismatch record in the operator's oplog at 14:17:31.
#
# So the scheduled task leads now and runas is the fallback, not the reverse.
# runas is kept because it is documented, needs no task registration, and may
# well work on machines where SAFER policy is intact - but it has to prove
# itself rather than be assumed.

# Evidence that the relaunch HAPPENED, which is the whole 1dq lesson: a new
# process for this executable that did not exist before we asked. Neither an
# exit code nor a task state proves a window is coming up; a new PID does.
function Wait-ForNewProcess {
    param([string]$ExePath, [int[]]$BeforePids, [int]$TimeoutMs = 15000)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $now = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
        $new = @($now | Where-Object { $BeforePids -notcontains $_ })
        if ($new.Count -gt 0) { return $new[0] }
        Start-Sleep -Milliseconds 250
    }
    return $null
}

function Invoke-DeelevatedViaScheduledTask {
    param([string]$ExePath, [string[]]$ArgList)

    $taskName = "VanishAuditModeRelaunch"
    $registered = $false
    try {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
        $beforePids = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

        $actionArgs = @{ Execute = $ExePath }
        if ($ArgList -and @($ArgList).Count -gt 0) {
            $actionArgs.Argument = ((@($ArgList) | ForEach-Object { '"' + $_ + '"' }) -join ' ')
        }
        $workDir = Split-Path -Parent $ExePath
        if ($workDir) { $actionArgs.WorkingDirectory = $workDir }
        $action = New-ScheduledTaskAction @actionArgs

        # RunLevel Limited is the whole point: the task runs as this user
        # WITHOUT the elevation this process holds. Interactive logon so it
        # lands in the logged-on session and can actually paint a window.
        $principal = New-ScheduledTaskPrincipal `
            -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
            -LogonType Interactive -RunLevel Limited

        # ExecutionTimeLimit Zero means UNLIMITED, and it is not optional: the
        # default is 72 hours, after which Task Scheduler would terminate the
        # app out from under someone who simply left it open.
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero)

        Register-ScheduledTask -TaskName $taskName -Action $action `
            -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
        $registered = $true

        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

        $newPid = Wait-ForNewProcess -ExePath $ExePath -BeforePids $beforePids
        if (-not $newPid) {
            return @{ success = $false; method = "scheduled-task"; error = "The task was registered and started, but no new process appeared within 15 seconds." }
        }
        return @{ success = $true; method = "scheduled-task"; newPid = $newPid }
    } catch {
        return @{ success = $false; method = "scheduled-task"; error = $_.Exception.Message }
    } finally {
        # Always remove it. The started process is independent of the task, so
        # unregistering does not disturb it - but a task left behind would show
        # up in the user's Task Scheduler as something Vanish installed, which
        # is exactly the kind of residue this app exists to object to.
        if ($registered) {
            try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch { }
        }
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
# tda: split what a person can act on from what the machine depends on.
#
# Operator, 2026-08-13: "could you categorize startup items as killable and
# necessary? that way necessary things could be hidden behind a collapsible
# section and not seen as a massive list." A long undifferentiated list reads
# as "all of this is suspicious", which is the opposite of what this app is
# for.
#
# RULE 6 AMENDMENT, authorised by the operator 2026-08-13 and SCOPED TO
# GROUPING ONLY. Rule 6 forbids a trusted-publisher allowlist. One is used
# here, for deciding which visual group an entry lands in, and it may never be
# consulted to permit or block a removal anywhere else in the app. See
# docs/promptgate.md.
#
# THE WORDING IS PART OF THE CONTRACT. "Necessary" here means "do not touch
# this without knowing what you are doing" - NOT "this is good software", and
# never the words "trusted" or "safe". The operator named the case that makes
# the distinction matter: on a corporate machine the monitoring agent is
# exactly the thing an employee should not disable, not because it is benign,
# but because disabling it is a disciplinary event and may break compliance.
#
# AND THE COUNTEREXAMPLE THAT KEEPS IT HONEST: RealPlayer's service runs as
# LocalSystem with auto-start, and would score "necessary" on the LocalSystem
# signal alone - while being software the operator does not use, listening on
# every interface (see ddx). So LocalSystem is a WEAK signal here and is never
# sufficient by itself; it only corroborates a publisher we already matched.
#
# BINDING: anything unclassifiable goes in the VISIBLE group with an explicit
# no-opinion label. Hiding what we cannot explain is how a cleaner ends up
# disabling something that mattered.

# Deliberately not called "trusted". Matching only decides which group an
# entry is drawn in.
$script:StartupSystemPublishers = @(
    'Microsoft Corporation',
    'Microsoft Windows',
    'Microsoft Windows Hardware Compatibility Publisher'
)
$script:StartupSecurityPublishers = @(
    'ESET', 'Kaspersky', 'Bitdefender', 'Avast', 'AVG', 'NortonLifeLock', 'Gen Digital',
    'Symantec', 'McAfee', 'Malwarebytes', 'Sophos', 'Trend Micro', 'F-Secure',
    'Webroot', 'Avira', 'CrowdStrike', 'SentinelOne', 'Carbon Black', 'Cylance',
    'VMware Carbon Black', 'Check Point', 'Palo Alto Networks'
)

function Get-MachineIsManaged {
    # Cached: this is asked once per startup item otherwise.
    if ($null -ne $script:MachineIsManaged) { return $script:MachineIsManaged }
    $managed = $false
    try {
        $managed = [bool](Get-CimInstance -Query "SELECT PartOfDomain FROM Win32_ComputerSystem" -ErrorAction Stop).PartOfDomain
    } catch { $managed = $false }
    if (-not $managed) {
        # MDM enrolment without a domain join - the modern corporate shape.
        #
        # THE OBVIOUS CHECK IS WRONG. A first version treated any non-zero
        # EnrollmentType as enrolment. Measured on an ordinary personal
        # machine: THIRTY-FOUR keys under Enrollments, most of them
        # EnrollmentType=1 with no provider, plus Windows' own internal
        # "Local Authority" / "Cloud Authority" / "Deploy Authority" records.
        # Every one of them read as "this is a corporate machine".
        #
        # That was not a cosmetic error. It made the machine look managed,
        # which swept RealPlayer's three startup entries into the collapsed
        # "necessary" group and told the operator they were put there by
        # whoever administers the PC - about software they had just asked to
        # get rid of. Precisely inverted.
        #
        # A real MDM enrolment names its provider and who it enrolled.
        try {
            $enrolments = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction Stop
            foreach ($e in $enrolments) {
                $p = Get-ItemProperty -LiteralPath $e.PSPath -ErrorAction SilentlyContinue
                if (-not $p) { continue }
                $provider = [string]$p.ProviderID
                if ([string]::IsNullOrWhiteSpace($provider)) { continue }
                # Windows' own bookkeeping, not an MDM authority.
                if ($provider -in @('Local Authority', 'Cloud Authority', 'Deploy Authority')) { continue }
                $hasSubject = -not [string]::IsNullOrWhiteSpace([string]$p.UPN)
                $hasService = -not [string]::IsNullOrWhiteSpace([string]$p.DiscoveryServiceFullURL)
                if ($hasSubject -or $hasService) { $managed = $true; break }
            }
        } catch { }
    }
    $script:MachineIsManaged = $managed
    return $managed
}

function Add-StartupClassification {
    param([object]$Items)

    $windir = [string]$env:SystemRoot
    $managedMachine = Get-MachineIsManaged

    # Every signature this pass needs, checked concurrently up front rather
    # than one at a time inside the loop below. Same verdicts, same order of
    # decisions - the loop is unchanged except that it now READS an answer
    # instead of waiting 72ms for one.
    $sigCache = Get-BinarySignatureBatch -Paths @(
        $Items | Where-Object { $_.exeExists -eq $true -and $_.exePath } | ForEach-Object { [string]$_.exePath }
    )

    foreach ($item in $Items) {
        $group = 'actionable'
        $classification = 'no-opinion'
        $reason = 'Vanish has no opinion about this one. It is shown here rather than hidden, because hiding what it cannot explain is how a cleaner removes something that mattered.'

        $exePath = [string]$item.exePath
        $signer = $null
        $sigStatus = 'not-checked'
        if ($exePath -and $item.exeExists -eq $true) {
            # Falls back to a direct check rather than to 'not-checked' if the
            # batch somehow has no row: a missing answer must never read as a
            # verdict, and 'not-checked' is what an unsigned binary looks like
            # to the grouping below.
            $sig = if ($sigCache.ContainsKey($exePath)) { $sigCache[$exePath] } else { Get-BinarySignature -Path $exePath }
            $sigStatus = [string]$sig.status
            if ($sig.status -eq 'Valid') { $signer = [string]$sig.signer }
        }

        $underWindows = $false
        if ($exePath -and $windir) { $underWindows = $exePath.StartsWith($windir, [StringComparison]::OrdinalIgnoreCase) }
        $underPolicies = ([string]$item.managePath -match '\\Policies\\')

        if ($item.exeExists -eq $false) {
            # The clearest actionable case there is, and it is already detected.
            $group = 'actionable'
            $classification = 'orphaned'
            $reason = 'Points at a file that is not there any more, so it does nothing at startup except fail.'
        }
        elseif ($signer -and ($script:StartupSystemPublishers | Where-Object { $signer -like "$_*" })) {
            $group = 'necessary'
            $classification = 'system'
            $reason = "Windows itself put this here (signed by $signer). Your system depends on it."
        }
        elseif ($signer -and ($script:StartupSecurityPublishers | Where-Object { $signer -like "*$_*" })) {
            $group = 'necessary'
            $classification = 'security'
            $reason = "Part of your security software ($signer). Turning it off leaves the machine unprotected."
        }
        elseif ($underPolicies) {
            # The case the operator singled out. NOT a claim that the software
            # is benign - the opposite, in fact: it is a claim that switching
            # it off is not the user's call to make.
            #
            # EVIDENCE ONLY. An earlier version also matched "the machine looks
            # managed AND this is an HKLM entry", which is a proxy rather than
            # evidence: on a genuinely managed machine it would sweep every
            # machine-wide startup entry into the hidden group, ordinary
            # third-party software included. Being under a Policies key is a
            # fact about THIS entry. "The machine is managed" is a fact about
            # the machine and says nothing about who put this particular
            # program in Run.
            $group = 'necessary'
            $classification = 'managed'
            $reason = 'This was put here by policy rather than by you. Turning it off may breach your workplace policy, and it will probably come back at the next policy refresh.'
        }
        elseif ($underWindows -and $signer) {
            $group = 'necessary'
            $classification = 'system'
            $reason = "Lives in your Windows folder and is signed by $signer."
        }
        elseif ($signer) {
            $group = 'actionable'
            $classification = 'known-publisher'
            $reason = "Signed by $signer. That confirms who wrote it, not that you need it at startup."
        }

        $item | Add-Member -NotePropertyName group          -NotePropertyValue $group          -Force
        $item | Add-Member -NotePropertyName classification -NotePropertyValue $classification -Force
        $item | Add-Member -NotePropertyName groupReason    -NotePropertyValue $reason         -Force
        $item | Add-Member -NotePropertyName signer         -NotePropertyValue $signer         -Force
        $item | Add-Member -NotePropertyName signatureStatus -NotePropertyValue $sigStatus     -Force
    }
}

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

    Add-StartupClassification $items

    # @() around the pipeline is load-bearing, not style. Where-Object returns a
    # bare object when exactly one item matches, and .Count on that serialises
    # as null - so a machine with precisely one orphaned startup item reported
    # "null orphaned", the renderer read it as 0, and the badge stayed hidden.
    # This machine has exactly one. Wrapping forces an array in every case.
    return @{
        items          = $items
        total          = @($items).Count
        orphans        = @($items | Where-Object { $_.exeExists -eq $false }).Count
        necessaryCount = @($items | Where-Object { $_.group -eq 'necessary' }).Count
        actionableCount = @($items | Where-Object { $_.group -ne 'necessary' }).Count
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
        $gatewayAddress = $null
        try {
            $props = $nic.GetIPProperties()
            $gateways = @($props.GatewayAddresses | Where-Object {
                $_ -and $_.Address -and $_.Address.ToString() -ne '0.0.0.0' -and $_.Address.ToString() -ne '::'
            })
            $hasGateway = $gateways.Count -gt 0
            # kp0: the default destination for a manual ping. Prefer IPv4 - it is
            # what a user reads as "my router's address", and Test-Connection
            # handles it without needing scope-id handling the way a link-local
            # IPv6 gateway address would.
            if ($hasGateway) {
                $v4 = $gateways | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
                $gatewayAddress = if ($v4) { $v4.Address.ToString() } else { $gateways[0].Address.ToString() }
            }
        } catch {}

        $rows[$nic.Id] = @{
            id             = [string]$nic.Id
            name           = [string]$nic.Name
            description    = [string]$nic.Description
            type           = $type
            isWireless     = ($type -eq 'Wireless80211')
            hasGateway     = $hasGateway
            gatewayAddress = $gatewayAddress
            speedBps       = [long]$nic.Speed
            rx             = [long]$stats.BytesReceived
            tx             = [long]$stats.BytesSent
        }
    }
    return $rows
}

# Established TCP connections by owning process. netstat is used over
# Get-NetTCPConnection purely for start-up cost; the PID column is the same
# data. UDP is skipped: an endpoint being open says nothing about traffic.
# Counts what a process has OPEN, and it has to count more than established
# TCP - measured 2026-08-14 on the operator's running qBittorrent:
#
#   TCP ESTABLISHED (all this used to count):   4
#   TCP, every state:                          15
#   UDP sockets:                               21
#
# BitTorrent moves most of its data over uTP, which is UDP, and finds peers
# over UDP DHT. Counting only established TCP showed a client saturating the
# link as a near-idle process with four connections - "the network says idle
# when i am using the bittorrent protocol" (operator, same day).
#
# UDP is connectionless, so a UDP row is a SOCKET rather than a conversation.
# The two are counted separately and never added together into one number,
# because "36 connections" would be a tidier lie than "4 connections".
function Get-NetConnectionsByProcess {
    $byPid = @{}
    $output = @()
    try { $output = & netstat.exe -ano 2>$null } catch { return $byPid }

    foreach ($line in $output) {
        $text = ([string]$line).Trim()
        $isTcp = $text.StartsWith('TCP')
        $isUdp = $text.StartsWith('UDP')
        if (-not ($isTcp -or $isUdp)) { continue }
        $parts = @($text -split '\s+' | Where-Object { $_ })

        # UDP rows have no state column, so the PID sits one place earlier.
        if ($isUdp) {
            if ($parts.Count -lt 4) { continue }
            $udpPid = 0
            if (-not [int]::TryParse($parts[3], [ref]$udpPid)) { continue }
            if ($udpPid -le 0) { continue }
            if (-not $byPid.ContainsKey($udpPid)) {
                $byPid[$udpPid] = @{ connections = 0; peers = @{}; udpSockets = 0; tcpOther = 0 }
            }
            $byPid[$udpPid].udpSockets++
            continue
        }

        if ($parts.Count -lt 5) { continue }

        $procId = 0
        if (-not [int]::TryParse($parts[4], [ref]$procId)) { continue }
        if ($procId -le 0) { continue }

        if ($parts[3] -ne 'ESTABLISHED') {
            # Half-open, closing, or listening. Real sockets, not conversations.
            if (-not $byPid.ContainsKey($procId)) {
                $byPid[$procId] = @{ connections = 0; peers = @{}; udpSockets = 0; tcpOther = 0 }
            }
            $byPid[$procId].tcpOther++
            continue
        }

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
            $byPid[$procId] = @{ connections = 0; peers = @{}; udpSockets = 0; tcpOther = 0 }
        }
        $byPid[$procId].connections++
        if ($peer) { $byPid[$procId].peers[$peer] = $true }
    }

    return $byPid
}

# ddx: WHO CAN START A CONVERSATION WITH THIS PROGRAM.
#
# Get-NetConnectionsByProcess above answers "who is this program talking to".
# That is the reassuring half of the picture and it is not the
# security-relevant half. A service can have every one of its established
# connections on loopback - genuinely nothing leaving the machine - while
# also listening on 0.0.0.0, which means anything that can route to this
# machine may open a new one.
#
# This function exists because I told the operator rpdsvc was fine on exactly
# that reasoning: 54 established connections, all 127.0.0.1, nothing leaving.
# True, and beside the point - it was also listening on 0.0.0.0:20121 as
# LocalSystem, belonging to RealPlayer, which they do not use.
#
# WHAT THIS DELIBERATELY DOES NOT DO (Rule 6): no score, no rating, no
# "dangerous" verdict. An externally-bound listener is not automatically a
# vulnerability. The defensible claim is "this is reachable"; "this is
# unsafe" is not ours to make and the wording never makes it.
function Get-ListeningSockets {
    $byPid = @{}
    $output = @()
    try { $output = & netstat.exe -ano 2>$null } catch { return $byPid }

    foreach ($line in $output) {
        $text = ([string]$line).Trim()
        $isTcp = $text.StartsWith("TCP")
        $isUdp = $text.StartsWith("UDP")
        if (-not ($isTcp -or $isUdp)) { continue }
        $parts = @($text -split "\s+" | Where-Object { $_ })

        # TCP:  Proto Local Foreign State PID      (5 columns)
        # UDP:  Proto Local Foreign PID            (4 columns - no state,
        #       because a UDP socket has none. A bound UDP socket is still
        #       something that can receive unsolicited traffic, so it counts
        #       as a listener here even though netstat will not say LISTENING.)
        if ($isTcp) {
            if ($parts.Count -lt 5) { continue }
            if ($parts[3] -ne "LISTENING") { continue }
            $localRaw = [string]$parts[1]
            $pidRaw   = [string]$parts[4]
            $proto    = "TCP"
        } else {
            if ($parts.Count -lt 4) { continue }
            $localRaw = [string]$parts[1]
            $pidRaw   = [string]$parts[3]
            $proto    = "UDP"
        }

        $procId = 0
        if (-not [int]::TryParse($pidRaw, [ref]$procId)) { continue }
        if ($procId -le 0) { continue }

        # IPv6 arrives as [::]:445 - the LAST colon separates the port, and
        # the brackets are netstat syntax rather than part of the address.
        $cut = $localRaw.LastIndexOf(":")
        if ($cut -lt 0) { continue }
        $addr = $localRaw.Substring(0, $cut).Trim("[", "]")
        $port = $localRaw.Substring($cut + 1)

        # The whole point of the feature is this classification.
        $class = "specific"
        if ($addr -eq "0.0.0.0" -or $addr -eq "::" -or $addr -eq "*") { $class = "all" }
        elseif ($addr -eq "127.0.0.1" -or $addr -eq "::1" -or $addr -like "127.*") { $class = "loopback" }

        if (-not $byPid.ContainsKey($procId)) { $byPid[$procId] = [System.Collections.Generic.List[object]]::new() }
        $byPid[$procId].Add([PSCustomObject]@{
            protocol  = $proto
            address   = $addr
            port      = $port
            bindClass = $class
        })
    }

    return $byPid
}

# The signature is checked because the ABSENCE of this check is what made my
# original rpdsvc answer irresponsible in both directions. "Signed by
# RealNetworks" and "accepting connections from your whole network as SYSTEM"
# are both true at once. Showing only the first is reassurance theatre;
# showing only the second is scaremongering. Signed means AUTHENTIC, not
# SAFE, and the wording downstream has to keep saying so.
function Get-BinarySignature {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return @{ status = "unreadable"; signer = $null; isEv = $false }
    }
    try {
        $sig = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        $subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null }
        $signer = $null
        if ($subject -and $subject -match "CN=([^,]+)") { $signer = $Matches[1].Trim('"') }
        return @{
            status = [string]$sig.Status
            signer = $signer
            # An EV code-signing certificate carries the Private Organization
            # subject qualifier. Worth surfacing because it means a vetted
            # legal entity, which is a stronger claim than "signed" - and
            # still not a claim about safety.
            isEv   = [bool]($subject -match "Private Organization")
        }
    } catch {
        return @{ status = "unreadable"; signer = $null; isEv = $false }
    }
}


# Signature checking, in parallel, for a whole list at once.
#
# WHY. Measured on the operator's machine 2026-08-28: get-startup-items took
# 7413ms end to end, and 2659ms of that was Get-AuthenticodeSignature over 37
# unique startup binaries - roughly 72ms each, almost all of it certificate
# chain work, none of it dependent on any other item. Health Advisor is the
# landing page now and this was its slowest section by a wide margin.
#
# WHAT WAS REJECTED. Caching verdicts to disk keyed on path + mtime + size
# would be faster still and was NOT done: the cache would have to live somewhere
# an unelevated process can write, the signer name feeds startup GROUPING, and a
# writable file that decides what gets grouped as 'necessary' - and therefore
# folded away out of sight - is a new tampering surface bought for two seconds.
# Parallelism buys most of the same time and adds no trust surface at all.
#
# WHY A RUNSPACE POOL AND NOT ForEach-Object -Parallel: that switch is
# PowerShell 7+. This engine targets Windows PowerShell 5.1, which is what ships
# in the box and what the app can rely on being present.
#
# The runspaces get a SCRIPT BLOCK WITH NO DEPENDENCIES ON SESSION STATE. A new
# runspace does not inherit this file's dot-sourced functions, so the parsing is
# inlined rather than calling Get-BinarySignature - a call that would fail there
# with "not recognized" and be swallowed into 'unreadable' for every path.
#
# FALLS BACK TO SERIAL, LOUDLY IN CODE AND SILENTLY TO THE USER. If the pool
# cannot be created (constrained language mode, a locked-down host), every path
# is still checked - just one at a time. A signature verdict is never skipped
# and never guessed: the answer is the same, only slower.
function Get-BinarySignatureBatch {
    param([string[]]$Paths)

    $result = @{}
    $unique = @($Paths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    if ($unique.Count -eq 0) { return $result }

    # Below this it is not worth building a pool: creating and opening one costs
    # more than a handful of serial checks.
    if ($unique.Count -lt 4) {
        foreach ($path in $unique) { $result[$path] = Get-BinarySignature -Path $path }
        return $result
    }

    $worker = {
        param($Path)
        try {
            if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
                return @{ path = $Path; status = 'unreadable'; signer = $null; isEv = $false }
            }
            $sig = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
            $subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null }
            $signer = $null
            if ($subject -and $subject -match 'CN=([^,]+)') { $signer = $Matches[1].Trim('"') }
            return @{
                path   = $Path
                status = [string]$sig.Status
                signer = $signer
                isEv   = [bool]($subject -match 'Private Organization')
            }
        } catch {
            return @{ path = $Path; status = 'unreadable'; signer = $null; isEv = $false }
        }
    }

    $pool = $null
    try {
        # Capped at 8. These are I/O and crypto bound, not CPU bound, so the
        # gain flattens well before core count on a big machine, and an
        # unbounded pool on a startup list of 80 would be worse than serial.
        $threads = [Math]::Min(8, [Math]::Max(2, $unique.Count))
        $pool = [RunspaceFactory]::CreateRunspacePool(1, $threads)
        $pool.Open()

        $jobs = @()
        foreach ($path in $unique) {
            $ps = [PowerShell]::Create()
            $ps.RunspacePool = $pool
            $null = $ps.AddScript($worker).AddArgument($path)
            $jobs += [PSCustomObject]@{ ps = $ps; handle = $ps.BeginInvoke(); path = $path }
        }

        foreach ($job in $jobs) {
            try {
                $out = $job.ps.EndInvoke($job.handle)
                $row = @($out)[0]
                if ($row) {
                    $result[$job.path] = @{ status = [string]$row.status; signer = $row.signer; isEv = [bool]$row.isEv }
                }
            } catch {
                # One path failing must not cost the other thirty-six.
                $result[$job.path] = @{ status = 'unreadable'; signer = $null; isEv = $false }
            } finally {
                $job.ps.Dispose()
            }
        }
    } catch {
        # The pool itself was unavailable. Answer every path serially rather
        # than reporting 'unreadable' for a file we simply did not look at.
        foreach ($path in $unique) {
            if (-not $result.ContainsKey($path)) { $result[$path] = Get-BinarySignature -Path $path }
        }
    } finally {
        if ($pool) { try { $pool.Close(); $pool.Dispose() } catch {} }
    }

    # Any path the pool never answered for - a runspace that died outright -
    # gets a real serial check. Absence of an answer is not an answer.
    foreach ($path in $unique) {
        if (-not $result.ContainsKey($path)) { $result[$path] = Get-BinarySignature -Path $path }
    }

    return $result
}

function Get-ListenerReport {
    $byPid = Get-ListeningSockets
    if ($byPid.Count -eq 0) {
        return @{ success = $true; programs = @(); totals = @{ all = 0; specific = 0; loopback = 0 } }
    }

    # One CIM query for every service, joined on PID, rather than one query
    # per listener. On a machine with 40 listening processes the per-process
    # version was the whole cost of the panel.
    $svcByPid = @{}
    try {
        foreach ($s in (Get-CimInstance -Query "SELECT Name, DisplayName, ProcessId, StartName, StartMode, PathName FROM Win32_Service WHERE ProcessId <> 0" -ErrorAction Stop)) {
            if (-not $svcByPid.ContainsKey([int]$s.ProcessId)) { $svcByPid[[int]$s.ProcessId] = @() }
            $svcByPid[[int]$s.ProcessId] += $s
        }
    } catch { }

    $programs = [System.Collections.Generic.List[object]]::new()
    $totalAll = 0; $totalSpecific = 0; $totalLoopback = 0

    foreach ($procId in $byPid.Keys) {
        # netstat lists one row PER SOCKET, so a browser binding mDNS on
        # several interfaces produced four identical "UDP 0.0.0.0:5353" rows.
        # They are all real sockets and repeating the same endpoint four
        # times is noise, not evidence - collapse to distinct endpoints and
        # carry how many sockets sit behind each.
        $sockets = @($byPid[$procId] | Group-Object protocol, address, port | ForEach-Object {
            $one = $_.Group[0]
            [PSCustomObject]@{
                protocol    = $one.protocol
                address     = $one.address
                port        = $one.port
                bindClass   = $one.bindClass
                socketCount = $_.Count
            }
        } | Sort-Object @{ Expression = { [int]$_.port } })
        $proc = $null
        try { $proc = Get-Process -Id $procId -ErrorAction Stop } catch { }
        $path = $null
        if ($proc) { try { $path = [string]$proc.Path } catch { $path = $null } }

        # Worst-case exposure decides how the row reads. "Worst" is about
        # REACH, not danger: all-interfaces is reachable by more things than
        # a specific interface, which is reachable by more than loopback.
        $exposure = "loopback"
        if ($sockets | Where-Object { $_.bindClass -eq "all" }) { $exposure = "all" }
        elseif ($sockets | Where-Object { $_.bindClass -eq "specific" }) { $exposure = "specific" }

        switch ($exposure) {
            "all"      { $totalAll++ }
            "specific" { $totalSpecific++ }
            default    { $totalLoopback++ }
        }

        $svcs = @()
        if ($svcByPid.ContainsKey([int]$procId)) { $svcs = @($svcByPid[[int]$procId]) }

        # Get-Process().Path throws for a process running as another user, so
        # in Audit Mode every SYSTEM service came back with no path and
        # therefore no signature - including rpdsvc, the exact case this
        # feature was built for. Win32_Service.PathName is readable without
        # elevation and names the same binary, so use it when the process
        # itself will not say. It arrives as a full command line, so strip
        # the arguments and the quoting.
        if (-not $path -and $svcs.Count -gt 0 -and $svcs[0].PathName) {
            $raw = [string]$svcs[0].PathName
            if ($raw -match '^\s*"([^"]+)"') { $path = $Matches[1] }
            elseif ($raw -match '^\s*(\S+\.[Ee][Xx][Ee])') { $path = $Matches[1] }
            if ($path -and -not (Test-Path -LiteralPath $path)) { $path = $null }
        }

        # Only checked where it is load-bearing. Authenticode verification
        # costs real time per binary, and on a loopback-only listener the
        # answer changes nothing the user would act on. Anything not checked
        # says "not-checked" rather than reporting a reassuring default -
        # unknown is not "fine" (Rule 24).
        $sig = @{ status = "not-checked"; signer = $null; isEv = $false }
        if ($exposure -ne "loopback" -and $path) { $sig = Get-BinarySignature -Path $path }

        $programs.Add([PSCustomObject]@{
            pid           = [int]$procId
            name          = if ($proc) { [string]$proc.ProcessName } else { "PID $procId" }
            path          = $path
            exposure      = $exposure
            listeners     = $sockets
            listenerCount = $sockets.Count
            isService     = ($svcs.Count -gt 0)
            serviceNames  = @($svcs | ForEach-Object { [string]$_.DisplayName })
            serviceKeys   = @($svcs | ForEach-Object { [string]$_.Name })
            # LocalSystem is reported because it is true and material. It is
            # explicitly a WEAK signal on its own - most of Windows runs as
            # LocalSystem - and nothing downstream may treat it as a verdict.
            runsAsSystem  = [bool]($svcs | Where-Object { $_.StartName -match "LocalSystem|NT AUTHORITY\\SYSTEM" })
            serviceAccount = if ($svcs.Count -gt 0) { [string]$svcs[0].StartName } else { $null }
            startMode     = if ($svcs.Count -gt 0) { [string]$svcs[0].StartMode } else { $null }
            signature     = $sig
        })
    }

    return @{
        success  = $true
        programs = @($programs | Sort-Object @{ Expression = { switch ($_.exposure) { "all" { 0 } "specific" { 1 } default { 2 } } } }, @{ Expression = "listenerCount"; Descending = $true })
        totals   = @{ all = $totalAll; specific = $totalSpecific; loopback = $totalLoopback }
    }
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
    $gatewayBytesPerSecond = [long]0

    foreach ($key in $second.Keys) {
        if (-not $first.ContainsKey($key)) { continue }
        $a = $second[$key]
        $b = $first[$key]

        # Counters can wrap or reset; a negative delta is not evidence of
        # anything, so it is reported as zero rather than as a wild number.
        $rxDelta = [Math]::Max(0, $a.rx - $b.rx)
        $txDelta = [Math]::Max(0, $a.tx - $b.tx)
        $bps = ($rxDelta + $txDelta) / $seconds

        # 6d7: accumulate the ROUNDED per-adapter figure, not the raw one.
        # The headline used to be Round(sum of raw), while each row shows
        # Round(raw) - and Round(a) + Round(b) is not Round(a + b). On a
        # machine with two gateway adapters up (a docked laptop on Ethernet
        # and Wi-Fi both) the headline could therefore disagree with the sum
        # of the rows the user can see, by up to half a byte per adapter.
        # Small, but it is the panel contradicting itself, and bfh.1's whole
        # claim is that the headline is honest about which adapters it counts.
        # This machine has one gateway adapter, so the old form happened to be
        # exact here and the defect was invisible.
        $adapterBps = [long][Math]::Round($bps)
        if ($a.hasGateway) { $gatewayBytesPerSecond += $adapterBps }

        $adapters.Add(@{
            name              = $a.name
            description       = $a.description
            type              = $a.type
            isWireless        = $a.isWireless
            hasGateway        = $a.hasGateway
            gatewayAddress    = $a.gatewayAddress
            linkSpeedBps      = $a.speedBps
            receiveBytesPerSecond  = [long][Math]::Round($rxDelta / $seconds)
            sendBytesPerSecond     = [long][Math]::Round($txDelta / $seconds)
            totalBytesPerSecond    = $adapterBps
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
                # Reported SEPARATELY and never folded into connectionCount.
                # A UDP row is a socket, not a conversation, so adding them
                # together would produce a tidier number that means less. What
                # it buys is the case that prompted it: a BitTorrent client
                # with 4 established TCP connections and 21 UDP sockets is not
                # idle, and used to look it.
                udpSocketCount  = [int]$entry.udpSockets
                otherTcpCount   = [int]$entry.tcpOther
                socketCount     = [int]$entry.connections + [int]$entry.udpSockets + [int]$entry.tcpOther
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
    # Sorted by TOTAL sockets, not established TCP. Sorting on established
    # alone is what put a saturating torrent client below a browser tab.
    $processes = @($processes | Sort-Object -Property @{ Expression = { $_.socketCount } } -Descending)

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
        totalBytesPerSecond    = $gatewayBytesPerSecond
        busyThresholdBytesPerSecond = $script:NetBusyBytesPerSecond
        signalPercent          = $signalPercent
        signalNote             = $signalNote
        updateTransfers        = $updateTransfers
        bitsJobs               = $bitsJobs
        elevated               = (Test-IsElevated)
    }
}

# --- kp0: manual-tap ping ---------------------------------------------------
#
# The ONE deliberate, scoped exception to INV-4 (zero outbound network I/O),
# and the only place in this entire engine that originates a network probe.
# Everything else in scanner.ps1 reads state Windows already tracks; this
# function is the sole call that puts a packet on the wire, and it only runs
# when the renderer invokes it directly in response to an explicit user tap -
# there is no timer, no interval and no automatic caller anywhere in this
# file. test/network-verify.ps1 enforces that boundary by asserting
# Test-Connection appears exactly once in this file, right here.
#
# What it does NOT do, on purpose: no default third-party destination (a
# hardcoded 1.1.1.1/8.8.8.8 would silently tell Cloudflare/Google that this
# tool is running on every tap), no retries, no continuous mode. The caller
# supplies the destination; the renderer defaults it to the adapter's own
# gatewayAddress (see Get-NetworkActivity above) and lets the user edit it.
# INV-4 EXCEPTION NUMBER TWO, and it is a bigger one than the ping.
#
# Operator decision 2026-08-14, after being shown the trade explicitly: the
# rate tiles show what is crossing the wire right now, and they cannot answer
# "how fast is my connection", because the only way to learn that is to
# saturate the line against a remote server. Link speed is not the answer
# either - it is the negotiated rate to the router, 866.7 Mbps on this machine
# against a few KB/s of actual traffic.
#
# WHAT LEAVES THIS MACHINE, stated plainly because the user is asked to
# approve exactly this: an HTTPS request to speed.cloudflare.com, which sees
# this machine's IP address and a few seconds of traffic. No account, no
# identifier, nothing about the machine or its software. The payload is
# incompressible random bytes in one direction and discarded bytes in the
# other - it carries no user data because it carries no data at all.
#
# WHAT THIS FUNCTION MUST NEVER BECOME: automatic. There is no timer, no
# retry, no caller anywhere except an explicit click behind a consent gate
# the user has to accept once, by name. test/network-verify.ps1 enforces the
# same shape it already enforces for the ping: the outbound call exists in
# exactly one place, and that place is this function. A narrower invariant
# that is still enforced beats one that was silently deleted.
#
# The result is returned and never stored, never logged to the oplog, and
# never sent anywhere.
# Identifies the app, nothing about the machine. Not required by Cloudflare -
# a request without one is served normally - but a program making automated
# requests should say what it is.
$script:SpeedTestUserAgent = 'Vanish-Uninstaller/1.0 (+https://github.com/QuantumMonkey/Vanish)'

function Invoke-NetworkSpeedTest {
    param([object]$p)

    # TIME-BOXED, not fixed-size, and that is the whole design.
    #
    # v1 downloaded a fixed 25MB with Invoke-WebRequest and took 21 seconds on
    # the operator's line. Two things were wrong with it:
    #
    #   1. A fixed byte count means the DURATION is whatever the connection
    #      decides. Slow line, long wait. It also means a slow line pays the
    #      most data for the least useful answer.
    #   2. It timed the whole transfer including TCP slow-start, so it
    #      under-reported - the first few hundred milliseconds are the
    #      connection ramping up, not its steady speed.
    #
    # Reading the stream directly fixes both. It stops at a time limit OR a
    # byte cap, whichever comes first, and it only counts bytes that arrived
    # AFTER the warm-up window. On a 10 Mbps line that is ~6MB instead of
    # 25MB and ~5 seconds instead of 19; on a fast line the byte cap stops it
    # early. Faster everywhere, and cheaper on exactly the connections where
    # data costs most.
    $downSeconds = 5
    $upSeconds   = 3
    $downCap     = 40000000
    $upCap       = 10000000
    $warmupMs    = 600

    $result = @{
        success            = $false
        downBytesPerSecond = $null
        upBytesPerSecond   = $null
        downBytes          = 0
        upBytes            = 0
        endpoint           = 'speed.cloudflare.com'
        error              = $null
    }

    # TLS 1.2 is not the default in Windows PowerShell 5.1 and Cloudflare
    # will refuse the handshake without it.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    # Without this, .NET opens 2 connections per host and the request queues
    # behind anything else in this process.
    try { [Net.ServicePointManager]::DefaultConnectionLimit = 8 } catch { }

    # --- down -------------------------------------------------------------
    try {
        # Ask for a bit more than the byte cap and let the read loop stop it.
        # NOT far more: Cloudflare refuses an oversized request outright.
        # Measured 2026-08-14 - 25MB, 40MB and 50MB return 200; 100MB and
        # 200MB return 403. The first version asked for 200MB and got nothing.
        $req = [System.Net.HttpWebRequest]::Create("https://speed.cloudflare.com/__down?bytes=50000000")
        $req.Timeout = 15000
        $req.ReadWriteTimeout = 15000
        # Politeness, not necessity - and the distinction is worth recording
        # because the first guess at the 403 was a missing User-Agent, which
        # was wrong: a request with no UA returns 200 perfectly well (tested).
        # It is kept because a program making automated requests should say
        # what it is. It identifies the app and nothing about the machine.
        $req.UserAgent = $script:SpeedTestUserAgent
        $resp = $req.GetResponse()
        $stream = $resp.GetResponseStream()
        try {
            $buf = New-Object byte[] 65536
            $total = [long]0
            $warmBytes = [long]0
            $warmAt = 0.0
            $warmed = $false
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            while ($true) {
                $n = $stream.Read($buf, 0, $buf.Length)
                if ($n -le 0) { break }
                $total += $n
                $elapsed = $sw.Elapsed.TotalSeconds
                if (-not $warmed -and ($elapsed * 1000) -ge $warmupMs) {
                    # Everything before this point was the connection ramping
                    # up. Measure from here.
                    $warmed = $true
                    $warmBytes = $total
                    $warmAt = $elapsed
                }
                if ($elapsed -ge $downSeconds) { break }
                if ($total -ge $downCap) { break }
            }
            $sw.Stop()
            $measuredBytes = if ($warmed) { $total - $warmBytes } else { $total }
            $measuredSecs  = if ($warmed) { $sw.Elapsed.TotalSeconds - $warmAt } else { $sw.Elapsed.TotalSeconds }
            $measuredSecs  = [Math]::Max($measuredSecs, 0.001)
            $result.downBytes = $total
            $result.downBytesPerSecond = [long]([Math]::Round($measuredBytes / $measuredSecs))
        } finally {
            try { $stream.Close() } catch { }
            try { $resp.Close() } catch { }
        }
    } catch {
        $result.error = "Download test failed: $($_.Exception.Message)"
        return $result
    }

    # --- up ---------------------------------------------------------------
    try {
        # Random bytes, not zeroes: a compressible payload measures the
        # compression, not the link.
        $chunk = New-Object byte[] 262144
        (New-Object Random).NextBytes($chunk)

        $upReq = [System.Net.HttpWebRequest]::Create("https://speed.cloudflare.com/__up")
        $upReq.Method = 'POST'
        $upReq.Timeout = 15000
        $upReq.ReadWriteTimeout = 15000
        $upReq.UserAgent = $script:SpeedTestUserAgent
        $upReq.SendChunked = $true
        $upReq.AllowWriteStreamBuffering = $false
        $upReq.ContentType = 'application/octet-stream'
        $reqStream = $upReq.GetRequestStream()
        $sent = [long]0
        try {
            $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
            while ($true) {
                $reqStream.Write($chunk, 0, $chunk.Length)
                $sent += $chunk.Length
                if ($sw2.Elapsed.TotalSeconds -ge $upSeconds) { break }
                if ($sent -ge $upCap) { break }
            }
            $sw2.Stop()
            $secs2 = [Math]::Max($sw2.Elapsed.TotalSeconds, 0.001)
            $result.upBytes = $sent
            $result.upBytesPerSecond = [long]([Math]::Round($sent / $secs2))
        } finally {
            try { $reqStream.Close() } catch { }
        }
        try { $upResp = $upReq.GetResponse(); $upResp.Close() } catch { }
    } catch {
        # A failed upload does not invalidate a good download figure. Report
        # what was measured and say which half is missing.
        $result.error = "Upload test failed: $($_.Exception.Message)"
    }

    $result.success = ($null -ne $result.downBytesPerSecond)
    return $result
}

function Invoke-NetworkPing {
    param([object]$p)

    $destination = [string]$p.destination
    if ([string]::IsNullOrWhiteSpace($destination)) {
        return @{ success = $false; error = "No destination was given." }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # Windows PowerShell 5.1's Test-Connection (not the PS7 rewrite) -
        # this project always runs under powershell.exe. A single probe: this
        # is a manual, on-demand check, not a monitoring loop.
        $reply = Test-Connection -ComputerName $destination -Count 1 -ErrorAction Stop
        $sw.Stop()
        $first = if ($reply -is [array]) { $reply[0] } else { $reply }
        $rtt = if ($null -ne $first.ResponseTime) { [int]$first.ResponseTime } else { [int]$sw.ElapsedMilliseconds }

        return @{
            success     = $true
            destination = $destination
            roundTripMs = $rtt
        }
    } catch {
        $sw.Stop()
        # Unreachable, no route, DNS failure, or the host silently drops ICMP
        # (routine and common, not evidence anything is wrong) - reported as
        # what was tried and what happened, never invented as a number.
        return @{
            success     = $false
            destination = $destination
            error       = $_.Exception.Message
        }
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

    # ADVERSARIAL FINDING 2026-09-02, and it is this function's OWN threat
    # model applied one directory further than it reached.
    #
    # The comment below Test-RestorableProtectedPath already states the attack
    # exactly: "An attacker who can write entry.json writes originalPath =
    # System32\evil.dll, supplies the payload, and asks an elevated process to
    # move it there." System32 was blocked. Program Files was not, and a probe
    # walked straight through:
    #
    #   WROTE   C:\Program Files        -> C:\Program Files\<x>\marker.txt
    #   WROTE   C:\Program Files (x86)  -> C:\Program Files (x86)\<x>\marker.txt
    #   WROTE   C:\ProgramData          -> C:\ProgramData\<x>\marker.txt
    #   BLOCKED C:\Windows\System32
    #   BLOCKED C:\ (drive root)
    #
    # All three are writable by Administrators and NOT by a standard user, so
    # each one is a user-to-admin write primitive: a DLL beside an elevated
    # executable in Program Files, or a file on a service search path under
    # ProgramData. The preconditions are only that the attacker can rewrite the
    # vault manifest and that the operator later clicks Restore in Full Mode --
    # and check-data-dir reported protected=false with nonAdminWriters=[the
    # user] on the development machine when this was found, so the first
    # precondition was live, not theoretical.
    #
    # These are NOT hardcoded literals: %ProgramFiles% is redirected for a
    # 32-bit process, which is why %ProgramW6432% is listed separately, and a
    # machine can have them on another volume entirely.
    $blocked = @(
        $env:SystemRoot,
        (Join-Path $env:SystemRoot 'System32'),
        (Join-Path $env:SystemRoot 'SysWOW64'),
        (Join-Path $env:SystemRoot 'WinSxS'),
        (Join-Path $env:SystemRoot 'INF'),
        (Join-Path $env:SystemRoot 'Boot'),
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramW6432,
        $env:ProgramData,
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


# ==========================================================================
# z3s, OPEN HALF. Operator decision 2026-08-19: a restore MAY write into a
# protected location when the destination is the file's own recorded
# original path.
# ==========================================================================
# Taken literally that decision cannot be implemented, and saying so is part
# of implementing it. The restore loop's own comment is the reason:
#
#     "The manifest is user-writable; the restore runs elevated. Both the
#      source it reads and the destination it writes are untrusted."
#
# "Restore it to where we took it from" is a claim the MANIFEST makes. An
# attacker who can write entry.json writes originalPath = System32\evil.dll,
# supplies the payload, and asks an elevated process to move it there. That is
# not a relaxed guard, it is an elevation-of-privilege primitive with a
# comment explaining why it is fine.
#
# So the decision is implemented in the narrow form that actually buys what it
# was asked for. 7v3 needs exactly one directory - the Windows installer cache
# - and every condition below is checked against BOTH the literal path and the
# junction-resolved one, because a reparse point inside the cache pointing at
# System32 is the obvious way through a location check.
#
#   1. Under %SystemRoot%\Installer, and DIRECTLY in it. The cache is flat;
#      a subdirectory is not something we put there.
#   2. A .msi or .msp. The cache holds nothing else, and a file Windows will
#      not execute unless it is registered against a product code is about as
#      inert as a write into that folder can be.
#   3. THE VAULT'S OWN DATA DIRECTORY MUST CURRENTLY PASS THE SEC-3 CHECK -
#      no non-administrator writer, and owned by a principal we trust. This is
#      the load-bearing condition, and it is what makes the whole thing safe
#      rather than merely narrow: if the manifest is user-writable then the
#      recorded original path is attacker-controlled and the exception must
#      not apply. main.js already tests and re-applies that ACL at startup, so
#      the normal state is trusted; a machine where it is not gets the old
#      refusal, which is the correct answer for a machine in that state.
#   4. On restore only: nothing may already exist at the destination. Putting
#      back a file that is gone is a restore. Overwriting a file that is there
#      is a different act, and not one the user asked for.
#
# What is NOT unlocked, deliberately: System32, SysWOW64, WinSxS, INF, Boot,
# any Start Menu, any drive root, and the engine's own directory. Those are
# where privileged execution gets planted, and none of them is what the 137 MB
# was sitting in.
$script:RestorableProtectedExtensions = @('.msi', '.msp')

function Get-RestorableProtectedRoots {
    if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { return @() }
    return @((Join-Path $env:SystemRoot 'Installer'))
}

# Condition 3, asked of the SAME function SEC-3 uses rather than a copy of its
# reasoning - the two must not be able to drift, for the same reason the
# quarantine and restore guards share one predicate.
function Test-VaultDataDirTrusted {
    param([string]$vaultRoot)

    if ([string]::IsNullOrWhiteSpace($vaultRoot)) { return $false }
    $dataDir = Split-Path -Path $vaultRoot -Parent
    if ([string]::IsNullOrWhiteSpace($dataDir)) { return $false }

    try {
        $verdict = Test-VanishDataDirAcl -p @{ path = $dataDir }
    } catch {
        return $false
    }
    return ($verdict -and $verdict.success -eq $true -and $verdict.protected -eq $true)
}

# Program Files / ProgramData are now blocked destinations (see the finding in
# Test-ProtectedDestination), but leftovers from an uninstall legitimately live
# there, and refusing to restore them would break the undo path this vault
# exists to provide. So the block is conditional on the ONE fact that decides
# whether the manifest can be believed.
#
# THE MANIFEST IS THE ONLY RECORD OF WHERE A FILE CAME FROM. If a non-admin can
# rewrite it, "restore it to where we took it from" is a sentence the attacker
# is writing, not the app. If the data directory is ACL-locked to Administrators
# and SYSTEM, they cannot, and the same sentence is true.
#
# This costs nothing in practice and that is not a coincidence: vault-restore is
# fullModeOnly, and main.js runs secure-data-dir on EVERY elevated start. Any
# session that can reach a restore has already locked the directory on the way
# in. If that securing failed, refusing the restore is the correct outcome
# rather than an inconvenience.
# The SHAPE test only - is this an installed-program folder at all - with no
# opinion about whether the vault is trusted. Used solely to choose the refusal
# MESSAGE, so an operator whose data directory is unlocked is told the thing
# they can actually do about it instead of a flat "protected system location".
function Test-RestorableInstalledAppPathShape {
    param([string]$path)
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    try { $full = [System.IO.Path]::GetFullPath($path) } catch { return $false }
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432, $env:ProgramData) |
             Where-Object { $_ }
    foreach ($root in $roots) {
        try { $rootFull = [System.IO.Path]::GetFullPath($root) } catch { continue }
        if (-not $rootFull.EndsWith('\')) { $rootFull += '\' }
        if ($full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-RestorableInstalledAppPath {
    param(
        [string]$path,
        [string]$vaultRoot
    )

    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    try { $full = [System.IO.Path]::GetFullPath($path) } catch { return $false }

    $resolved = Resolve-DestinationTarget $full
    if (-not $resolved) { return $false }

    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432, $env:ProgramData) |
             Where-Object { $_ }
    if ($roots.Count -eq 0) { return $false }

    # Both the literal path and the junction-resolved one, and a real subtree
    # test rather than StartsWith on an unterminated root - "C:\Program Files"
    # must not match "C:\Program Files Evil\".
    foreach ($candidate in @($full, $resolved)) {
        $ok = $false
        foreach ($root in $roots) {
            try { $rootFull = [System.IO.Path]::GetFullPath($root) } catch { continue }
            if (-not $rootFull.EndsWith('\')) { $rootFull += '\' }
            if ($candidate.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { $ok = $true; break }
        }
        if (-not $ok) { return $false }
    }

    # A direct child of the root itself is still refused. A restore puts a file
    # back inside an application's own folder; dropping one straight into
    # "C:\Program Files\x.dll" is the planting shape, not the undo shape.
    foreach ($candidate in @($full, $resolved)) {
        $parent = [System.IO.Path]::GetDirectoryName($candidate)
        if ([string]::IsNullOrWhiteSpace($parent)) { return $false }
        foreach ($root in $roots) {
            try { $rootFull = [System.IO.Path]::GetFullPath($root) } catch { continue }
            if ($parent.TrimEnd('\').Equals($rootFull.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        }
    }

    return (Test-VaultDataDirTrusted -vaultRoot $vaultRoot)
}

function Test-RestorableProtectedPath {
    param(
        [string]$path,
        [string]$vaultRoot,
        [switch]$MustNotExist
    )

    if ([string]::IsNullOrWhiteSpace($path)) { return $false }

    try { $full = [System.IO.Path]::GetFullPath($path) } catch { return $false }

    $resolved = Resolve-DestinationTarget $full
    if (-not $resolved) { return $false }

    $roots = Get-RestorableProtectedRoots
    if ($roots.Count -eq 0) { return $false }

    # Both forms, against every allowed root, and the PARENT has to be the root
    # itself - StartsWith would accept %SystemRoot%\Installer\..\System32 as
    # readily as the cache, and GetFullPath is not the only way in.
    foreach ($candidate in @($full, $resolved)) {
        $parent = [System.IO.Path]::GetDirectoryName($candidate)
        if ([string]::IsNullOrWhiteSpace($parent)) { return $false }

        $ok = $false
        foreach ($root in $roots) {
            try { $rootFull = [System.IO.Path]::GetFullPath($root) } catch { continue }
            if ($parent.TrimEnd('\').Equals($rootFull.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) { $ok = $true; break }
        }
        if (-not $ok) { return $false }

        $ext = [System.IO.Path]::GetExtension($candidate)
        if (-not ($script:RestorableProtectedExtensions -contains $ext.ToLowerInvariant())) { return $false }
    }

    if ($MustNotExist -and (Test-Path -LiteralPath $full -ErrorAction SilentlyContinue)) { return $false }

    return (Test-VaultDataDirTrusted -vaultRoot $vaultRoot)
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
# ==========================================================================
# cihg: THE VAULT MUST BE ABLE TO SAY WHETHER IT IS HANDING BACK WHAT IT TOOK
# ==========================================================================
# Found 2026-09-02 by an adversarial probe. Quarantine a file, overwrite the
# payload inside the vault entry folder, restore:
#
#   restore returned success=True, and put back: 'TAMPERED-BY-SOMETHING-ELSE'
#
# No warning, no error, no difference in the reported outcome. The manifest
# recorded originalPath, vaultRelative, sizeBytes and status - no hash - so
# restore had nothing to compare against and did not try. The tampered payload
# was even a different SIZE (26 bytes against a recorded 17) and that passed
# silently too: a size check that exists and is ignored is worse than one that
# was never recorded.
#
# WHAT IS HASHED, AND WHEN. The DESTINATION, once, after the move. That records
# what the vault actually holds, which is exactly what a restore needs to check.
# It deliberately does NOT attest that the move was faithful - hashing the
# source as well would double the read cost of every quarantine, and on a
# same-volume move (a rename, no bytes copied at all) it would read the whole
# file twice to verify a copy that never happened. Move-ItemTransactional
# already reports its own failures; this answers a different question.
#
# DIRECTORIES ARE HASHED TOO, up to a cap, because leftover folders are the
# common case and "we did not check" on all of them would make the feature
# mostly decorative. Above the cap it records WHY it did not, and restore says
# so rather than claiming a verification it never performed - the same
# could-not-look distinction the finders are built on.
# THE CAPS ARE MEASURED, 2026-09-03, through the real engine path rather than
# a bench harness - the difference matters and is recorded below.
#
#   single file, 4 KB      650 ms   (baseline: the process spawn dominates)
#   single file, 50 MB     672 ms   free, within noise of the baseline
#   single file, 250 MB    899 ms   about +200 ms
#   tree, 200 files       1548 ms   about +711 ms
#   tree, 2000 files      7102 ms   about +6064 ms
#
# So FILES are effectively free and TREES cost roughly 3 ms per file. 2000 is
# the cap because ~6.5 s is the most this should add to a deliberate,
# user-initiated action with a spinner on it; 5000 would have been ~16 s.
#
# AN OPEN QUESTION, stated rather than buried: the identical function against
# the identical tree runs in ~270 ms standalone and ~6300 ms inside the engine.
# Phase instrumentation puts all of it in the streaming loop, and it is not the
# move (a tree hashed immediately after being moved into a vault-shaped path
# still takes ~267 ms standalone), not enumeration (76 ms) and not the size
# loop (3 ms). Twenty times is too much to leave unexplained, and the cap above
# is set from the SLOW number so the guess cannot hurt anyone. Filed separately.
$script:VaultHashMaxBytes = 256MB
$script:VaultHashMaxFiles = 2000

function Get-VaultContentHash {
    param([string]$path)

    $result = @{ algo = $null; hash = $null; why = $null }
    if ([string]::IsNullOrWhiteSpace($path)) {
        $result.why = 'no path'
        return $result
    }

    try {
        if (-not (Test-Path -LiteralPath $path)) {
            $result.why = 'nothing at that path to hash'
            return $result
        }

        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop

        if (-not $item.PSIsContainer) {
            $result.algo = 'SHA256'
            $result.hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash
            return $result
        }

        # A directory. Compose one hash over the tree so a change anywhere in
        # it moves the answer: relative path, then content hash, per file, in a
        # STABLE order. Sorting is not cosmetic here - Get-ChildItem's order is
        # not guaranteed, and an unsorted composite would produce a different
        # hash for an unchanged tree and refuse every restore.
        $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction Stop)
        if ($files.Count -gt $script:VaultHashMaxFiles) {
            $result.why = "directory holds $($files.Count) files, over the $($script:VaultHashMaxFiles)-file hashing cap"
            return $result
        }
        $total = 0
        foreach ($f in $files) { $total += $f.Length }
        if ($total -gt $script:VaultHashMaxBytes) {
            $result.why = "directory holds $([math]::Round($total / 1MB)) MB, over the $([math]::Round($script:VaultHashMaxBytes / 1MB)) MB hashing cap"
            return $result
        }

        $rootLen = $path.TrimEnd('\').Length + 1
        # ONE incremental hash over the whole tree, not one Get-FileHash per
        # file. Measured 2026-09-03 before choosing: a 200-file tree of 100 KB
        # total cost 1,642 ms against a 708 ms baseline, so roughly 5 ms per
        # file of pure cmdlet overhead - at the 5,000-file cap that would have
        # been about 25 seconds added to a quarantine, for 100 KB of actual
        # reading. Streaming removes the per-file cost entirely and makes the
        # work proportional to bytes, which is what it should have been.
        #
        # The relative path is fed into the hash alongside the content, so
        # renaming a file inside the tree changes the answer. Sorting is not
        # cosmetic: Get-ChildItem's order is not guaranteed, and an unsorted
        # composite would hash the same tree differently on two runs and refuse
        # every restore.
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $buffer = New-Object byte[] 65536
            foreach ($f in ($files | Sort-Object -Property FullName)) {
                $rel = $f.FullName.Substring($rootLen).ToLowerInvariant()
                $relBytes = [System.Text.Encoding]::UTF8.GetBytes($rel + "`n")
                $null = $sha.TransformBlock($relBytes, 0, $relBytes.Length, $null, 0)

                $stream = [System.IO.File]::OpenRead($f.FullName)
                try {
                    while ($true) {
                        $read = $stream.Read($buffer, 0, $buffer.Length)
                        if ($read -le 0) { break }
                        $null = $sha.TransformBlock($buffer, 0, $read, $null, 0)
                    }
                } finally {
                    $stream.Dispose()
                }
            }
            $null = $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
            $result.algo = 'SHA256-TREE'
            $result.hash = (($sha.Hash | ForEach-Object { $_.ToString('X2') }) -join '')
        } finally {
            $sha.Dispose()
        }
        return $result
    } catch {
        # Never throws. A hash that could not be taken is a could-not-look, and
        # it must not take the quarantine or the restore down with it.
        $result.algo = $null
        $result.hash = $null
        $result.why  = "could not hash: $($_.Exception.Message)"
        return $result
    }
}

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
            # cihg. Present on every row from the start, including failed ones,
            # so the manifest shape never varies by outcome - a reader that has
            # to test for the existence of a field is a reader that will forget.
            contentHash  = $null
            hashAlgo     = $null
            hashNote     = $null
        }

        if (-not (Test-Path -LiteralPath $src)) {
            $row.status = "missing"
            $row.error  = "Path no longer exists."
            $fileRows.Add($row)
            continue
        }

        # INV-1 SYMMETRY. The restore path refuses to write into a protected
        # system location (Test-ProtectedDestination, used at the top of the
        # restore loop). Until this guard existed, the QUARANTINE path did not
        # ask the same question - so the vault would happily take a file out of
        # one of those locations and then refuse, later and permanently, to put
        # it back. A vault that can accept what it cannot return is worse than
        # one that refuses up front: the refusal costs the user a feature, the
        # asymmetry costs them the file.
        #
        # Found 2026-08-18 building the orphaned-installer sweep (7v3), whose
        # findings live in %SystemRoot%\Installer. The purge reported success,
        # the vault entry looked correct, and the restore came back
        # "Rejected: refusing to restore into a protected system location" with
        # the payload stranded in the vault forever.
        #
        # Deliberately checked against the SAME predicate the restore uses
        # rather than a copy of its list, so the two can never drift apart.
        # z3s open half, 2026-08-19: the narrow exception is asked FIRST and
        # asked here too, so the symmetry survives the relaxation. If restore
        # would accept this path back, quarantine may take it; if not, it may
        # not. The two questions are still one function.
        # 2026-09-02: the installed-program exception is asked HERE TOO, for
        # exactly the reason the paragraph above gives. Adding Program Files and
        # ProgramData to the blocked list without this line broke the symmetry
        # in the other direction - quarantine would refuse what restore would
        # accept, which does not strand a file but does silently remove the
        # ability to clean leftovers out of an installed program at all. Caught
        # by a probe that checked the legitimate path, not the attack.
        if ((Test-ProtectedDestination $src) -and
            -not (Test-RestorableProtectedPath -path $src -vaultRoot $p.vaultRoot) -and
            -not (Test-RestorableInstalledAppPath -path $src -vaultRoot $p.vaultRoot)) {
            $row.status = "failed"
            $row.error  = if (Test-RestorableInstalledAppPathShape -path $src) {
                "Refused: this lives inside an installed program, and the Vanish data directory is writable by a standard user - so the record of where this came from could not be trusted to put it back. Start Vanish elevated once to lock the directory, then retry. Nothing was moved."
            } else {
                "Refused: this lives in a protected system location, and the vault could not put it back afterwards. Nothing was moved."
            }
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

            # cihg: hash what the vault NOW HOLDS, at its vault path, so restore
            # has something to check the payload against. A hash that cannot be
            # taken records why and leaves the entry restorable - refusing to
            # quarantine because a hash failed would trade a real feature for a
            # verification nobody asked for.
            $h = Get-VaultContentHash -path $dest
            $row.contentHash = $h.hash
            $row.hashAlgo    = $h.algo
            $row.hashNote    = $h.why
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
        # cihg: verified/verifyNote are on the row from the start, so a caller
        # never has to test whether the field exists to know what it means.
        # Absent and false are the same on the wire and different in meaning,
        # which is how a "not checked" comes to read as a "checked and fine".
        $res = @{ originalPath = $f.originalPath; status = "failed"; error = $null; verified = $false; verifyNote = $null }

        # The manifest is user-writable; the restore runs elevated. Both the
        # source it reads and the destination it writes are untrusted.
        $vaultPath = Resolve-SafeVaultPath -entryDir $entryDir -relative $f.vaultRelative
        if (-not $vaultPath) {
            $res.error = "Rejected: vault payload path escapes the entry folder."
            $fileResults.Add($res); continue
        }
        # z3s open half. The exception is deliberately evaluated against the
        # path this loop is ABOUT TO WRITE, not against anything the manifest
        # claims elsewhere, and -MustNotExist means a restore can only put
        # back a file that is gone - never overwrite one that is there.
        if ((Test-ProtectedDestination $f.originalPath) -and
            -not (Test-RestorableProtectedPath -path $f.originalPath -vaultRoot $p.vaultRoot -MustNotExist) -and
            -not (Test-RestorableInstalledAppPath -path $f.originalPath -vaultRoot $p.vaultRoot)) {
            $res.error = if (Test-RestorableInstalledAppPathShape -path $f.originalPath) {
                # Named separately because the fix is different: this one is not
                # "we will never do that", it is "lock the data directory and we
                # will". A refusal the operator cannot act on is a dead end.
                "Rejected: refusing to restore into an installed-program folder while the Vanish data directory is writable by a standard user. The manifest that says where this file came from is the only record of it, and an unprotected directory means that record cannot be trusted. Start Vanish elevated once to lock the directory, then retry."
            } elseif (Test-Path -LiteralPath $f.originalPath -ErrorAction SilentlyContinue) {
                "Rejected: something already exists at that protected system path, and overwriting it is not a restore."
            } else {
                "Rejected: refusing to restore into a protected system location."
            }
            $fileResults.Add($res); continue
        }

        if (-not (Test-Path -LiteralPath $vaultPath)) {
            $res.error = "Vault payload missing."
            $fileResults.Add($res); continue
        }

        # cihg: CHECK THE PAYLOAD BEFORE PUTTING IT BACK.
        #
        # Refuse on mismatch rather than warn. A restore is an action the
        # operator believes: they asked for the thing they deleted and they get
        # a file. Handing back content the vault cannot vouch for, with a note
        # somewhere, is worse than handing back nothing - the note is read once
        # and the file is trusted forever.
        #
        # PER FILE, not per entry. One tampered payload in a ten-file entry must
        # not block the other nine; the operator gets nine files back and one
        # named refusal, which is more of their data recovered and a smaller
        # thing to investigate.
        #
        # AN ENTRY WITH NO HASH IS NOT A FAILURE. Everything quarantined before
        # this shipped has contentHash = $null, and refusing those would strand
        # every existing vault. They restore, and the result says the payload
        # could not be verified rather than claiming it was - the same
        # distinction between "checked and clean" and "did not check" that the
        # rest of this codebase is built on.
        $res.verified = $false
        $res.verifyNote = $null
        if ([string]::IsNullOrWhiteSpace($f.contentHash)) {
            $res.verifyNote = if ($f.hashNote) {
                "Not verified: no hash was recorded when this was quarantined ($($f.hashNote))."
            } else {
                'Not verified: this entry predates content hashing, so there is nothing to check the payload against.'
            }
        } else {
            $actual = Get-VaultContentHash -path $vaultPath
            if ([string]::IsNullOrWhiteSpace($actual.hash)) {
                $res.verifyNote = "Not verified: the payload could not be re-hashed now ($($actual.why))."
            } elseif ($actual.hash -ne $f.contentHash) {
                $res.error = "Refused: the vault payload has changed since it was quarantined. Expected $($f.hashAlgo) $($f.contentHash.Substring(0, [Math]::Min(16, $f.contentHash.Length)))..., found $($actual.hash.Substring(0, [Math]::Min(16, $actual.hash.Length))).... Nothing was written. The file is still in the vault; inspect it before restoring."
                $fileResults.Add($res); continue
            } else {
                $res.verified = $true
            }
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

    # One retry, because this counter is genuinely flaky under load rather
    # than because retries are a habit. Reproduced by running two Electron
    # suites alongside it: Get-Counter throws, the engine honestly reported
    # success=false, and the whole GPU column blanked for that sample. A user
    # on a busy machine - which is exactly when they open a task manager - was
    # losing the column for the reason they came to look at it.
    #
    # Still returns the failure honestly if the retry also fails. This buys a
    # second attempt, not a pretence that the first one worked.
    $counters = $null
    $counterError = $null
    foreach ($attempt in 1..2) {
        try {
            $counters = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop
            $counterError = $null
            break
        } catch {
            $counterError = $_.Exception.Message
            if ($attempt -lt 2) { Start-Sleep -Milliseconds 350 }
        }
    }
    if ($counterError) {
        return @{ success = $false; error = $counterError; byPid = @{}; byAdapter = @() }
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

        # THE KEY IS THE LUID, not phys_N. The comment above has said since
        # aaw that the LUID is the stable adapter identity - and then every
        # collection below was keyed by $physIdx anyway, which quietly undid
        # the whole point.
        #
        # Measured on the operator's hybrid laptop 2026-08-13, three adapters,
        # ALL OF THEM REPORTING phys_0:
        #
        #   luid 0x0000ed1f  phys_0  29.3%   AMD Radeon(TM) Graphics
        #   luid 0x0000fa2a  phys_0   0.0%   Microsoft Basic Render Driver
        #   luid 0x0000fa8e  phys_0  19.3%   NVIDIA GeForce RTX 3080 Laptop
        #
        # phys_N is the physical index WITHIN an adapter's own group, not a
        # global GPU ordinal, so on a normal machine it is 0 for everything.
        # Keying on it merged all three cards into one bucket called "GPU 0",
        # summed their percentages together, and kept whichever LUID happened
        # to arrive first as the identity of the merged result. That is why
        # the operator saw dota2 running on the NVIDIA card labelled with a
        # red AMD logo: the AMD adapter simply sorted first.
        #
        # Worse than a wrong label - it is a confident wrong label, which is
        # the exact fault c0y exists to prevent.
        $adapterKey = "{0}_{1}" -f $luidHigh, $luidLow

        if (-not $luidByAdapter.ContainsKey($adapterKey)) {
            $luidByAdapter[$adapterKey] = @{ high = $luidHigh; low = $luidLow; phys = $physIdx }
        }

        if ($sample.CookedValue -le 0) { continue }

        # aaw: keep WHICH adapter the work was on. This previously summed
        # straight into a flat number, so the LUID parsed two lines above was
        # used for the adapter totals and thrown away per process - meaning
        # "which GPU is this program using" was unanswerable downstream no
        # matter what the UI did. Total is still carried, so existing callers
        # that only want a percentage are unaffected.
        if (-not $byPid.ContainsKey($procId)) {
            $byPid[$procId] = @{ total = 0.0; adapters = @{} }
        }
        $byPid[$procId].total += $sample.CookedValue
        if (-not $byPid[$procId].adapters.ContainsKey($adapterKey)) {
            $byPid[$procId].adapters[$adapterKey] = 0.0
        }
        $byPid[$procId].adapters[$adapterKey] += $sample.CookedValue

        if (-not $byAdapter.ContainsKey($adapterKey)) { $byAdapter[$adapterKey] = 0.0 }
        $byAdapter[$adapterKey] += $sample.CookedValue
    }

    # aaw follow-up: this projection was left behind when the accumulator
    # above changed shape. $byPid[$k] used to be a plain number; aaw made it
    # @{ total; adapters } so the caller could say WHICH adapter a process was
    # using, and this line kept doing [Math]::Min(100, <hashtable>). That
    # throws - "Cannot convert argument val2 ... System.Collections.Hashtable
    # ... to type System.Decimal" - once PER PROCESS, so byPid came back empty
    # and every row in the table showed 0% or a dash.
    #
    # It looked half-alive rather than broken, which is why it survived a
    # release: $byAdapter is a separate accumulator that is still a plain
    # number, so the adapter summary pill kept reporting a correct 57% while
    # every per-process figure underneath it was gone.
    $pidResult = @{}
    foreach ($k in $byPid.Keys) {
        $adapterPercents = @{}
        foreach ($a in $byPid[$k].adapters.Keys) {
            $adapterPercents["$a"] = [Math]::Round([Math]::Min(100, $byPid[$k].adapters[$a]), 1)
        }
        $pidResult["$k"] = @{
            total    = [Math]::Round([Math]::Min(100, $byPid[$k].total), 1)
            adapters = $adapterPercents
        }
    }

    # Every ADAPTER seen this sample gets an entry, even at 0% - a card with no
    # current engine activity is still a real, present adapter the caller may
    # want to show as idle rather than silently dropped.
    #
    # adapterKey is what the caller joins on now. physIndex is still reported
    # because it is real, but it is an attribute of the adapter rather than its
    # name, and it is NOT unique - see the parse loop above.
    $allAdapters = @($luidByAdapter.Keys) + @($byAdapter.Keys) | Sort-Object -Unique
    $adapterResult = @($allAdapters | ForEach-Object {
        $luid = $luidByAdapter[$_]
        @{
            adapterKey = $_
            physIndex  = if ($luid) { $luid.phys } else { $null }
            percent    = if ($byAdapter.ContainsKey($_)) { [Math]::Round([Math]::Min(100, $byAdapter[$_]), 1) } else { 0.0 }
            luidHigh   = if ($luid) { $luid.high } else { $null }
            luidLow    = if ($luid) { $luid.low } else { $null }
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
# 7v3: orphaned Windows Installer cache (.msi / .msp in C:\Windows\Installer).
#
# Measured at 1.2 GB on the operator's machine 2026-08-02, and it is the one
# finding type here that frees real space.
#
# THE ORPHAN RULE, and why it is a cross-reference rather than a heuristic:
# Windows keeps a cached copy of every installer it has run so that Repair,
# Modify and Uninstall keep working. Each cached file is referenced by a
# LocalPackage value under the per-user Installer UserData tree. A file with
# no reference belongs to a product that is gone; a file WITH one is load-
# bearing, and deleting it breaks repair and uninstall for a product that is
# still installed. There is no size, age or name signal that separates them -
# only the reference. So this refuses to guess: if the reference scan cannot
# be read at all, it returns NOTHING rather than a list built on a partial
# picture, because a partial reference set turns live packages into orphans.
#
# PatchCleaner is the reference implementation of the same rule and is closed
# freeware, so there is nothing to integrate - the rule is public knowledge and
# small. What Vanish adds is the vault: these go to quarantine and come back,
# where PatchCleaner moves them to a folder and calls it done.
function Find-OrphanInstallerCache {
    $findings = [System.Collections.Generic.List[object]]::new()

    $cacheDir = Join-Path $env:SystemRoot 'Installer'
    if (-not (Test-Path -LiteralPath $cacheDir)) { return $findings }

    # Every LocalPackage the machine still points at. Products AND Patches:
    # missing the Patches half would offer every .msp on the machine for
    # deletion, which is the exact failure this guard exists to prevent.
    $referenced = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $readAny = $false
    $roots = @(
        'SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData'
    )
    foreach ($rootPath in $roots) {
        $root = Open-RegistryView -hive 'LocalMachine' -subKey $rootPath -view 'Registry64'
        if (-not $root) { continue }
        try {
            foreach ($sid in $root.GetSubKeyNames()) {
                foreach ($branch in @('Products', 'Patches')) {
                    $branchKey = $null
                    try { $branchKey = $root.OpenSubKey("$sid\$branch") } catch { $branchKey = $null }
                    if (-not $branchKey) { continue }
                    try {
                        foreach ($code in $branchKey.GetSubKeyNames()) {
                            # Products keep it under InstallProperties; Patches
                            # keep it on the patch key itself.
                            foreach ($sub in @("$code\InstallProperties", $code)) {
                                $k = $null
                                try { $k = $branchKey.OpenSubKey($sub) } catch { $k = $null }
                                if (-not $k) { continue }
                                try {
                                    $local = [string]$k.GetValue('LocalPackage', '')
                                    if (-not [string]::IsNullOrWhiteSpace($local)) {
                                        $readAny = $true
                                        [void]$referenced.Add([System.IO.Path]::GetFileName($local))
                                    }
                                } finally { $k.Close() }
                            }
                        }
                    } finally { $branchKey.Close() }
                }
            }
        } finally { $root.Close() }
    }

    # Nothing readable means no evidence, and no evidence means no findings.
    # An empty reference set would make EVERY cached installer look orphaned.
    if (-not $readAny) { return $findings }

    $files = @()
    try {
        $files = @(Get-ChildItem -LiteralPath $cacheDir -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in @('.msi', '.msp') })
    } catch { return $findings }

    # REMOVABLE as of 2026-08-19, and only because the promise can now be kept.
    #
    # These were audit-only for a real reason: the cache lives under
    # %SystemRoot%, Test-ProtectedDestination blocked it as a restore
    # destination, and a vault that can take a file and never put it back is
    # the exact thing this app exists to be the alternative to. That was
    # measured rather than assumed - a planted orphan quarantined cleanly and
    # the restore came back "Rejected", with the payload stranded.
    #
    # z3s's open half was the operator decision that unblocks it, taken
    # 2026-08-19: a restore may write into a protected location when the
    # destination is the file's own recorded original path. Implemented as a
    # narrow exception rather than a relaxed list - this directory only, .msi
    # and .msp only, nothing already there, and only while the vault's own data
    # directory still passes the SEC-3 ownership check. See
    # Test-RestorableProtectedPath for why that last condition is the one
    # holding the rest up.
    #
    # The note still says where these live. "Reversible" is a claim, and the
    # user is entitled to know it is being made about a Windows folder.
    $protectedNote = 'These sit inside a protected Windows folder. Vanish can move them to quarantine and put them back exactly where they came from - the only place it will write inside that folder - so nothing here is a one-way deletion.'

    foreach ($f in $files) {
        if ($referenced.Contains($f.Name)) { continue }
        $kind = if ($f.Extension -eq '.msp') { 'patch' } else { 'installer' }
        $findings.Add(@{
            id        = "msicache|$($f.Name)"
            label     = $f.Name
            evidence  = "cached $kind no product still references - $([math]::Round($f.Length / 1MB, 1)) MB"
            risk      = "Moderate"
            kind      = "file"
            path      = $f.FullName
            sizeBytes = [long]$f.Length
            removable = $true
            note      = $protectedNote
        })
    }

    return $findings
}

# be8: firewall rules pointing at a program that is no longer on disk.
#
# AUDIT ONLY in this release, and the note on every finding says so. Removing
# one means deleting a registry VALUE under FirewallPolicy\FirewallRules, which
# needs the value-level export/restore path PATH uses (Set-PathEntries), not the
# key-level one the vault offers today. Listing without removing is the honest
# half: nothing else on the machine will tell you these are dead.
#
# THE MEASUREMENT TRAP, recorded because the first pass got it wrong: 659 rules
# on the operator's machine, and a naive Test-Path flagged 295 of them against
# LIVE Windows binaries. Rule program paths are stored with %SystemRoot%-style
# variables and Test-Path does not expand them. Expanded properly, the real
# count was 48.
#
# Rule 24: each finding says WHY it is dead. A rule left by a removed Windows
# feature and a rule left by an uninstalled third-party app are not the same
# news, and "orphaned" alone would flatten them.
function Find-OrphanFirewallRules {
    $findings = [System.Collections.Generic.List[object]]::new()

    if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { return $findings }

    $filters = @()
    try {
        $filters = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue)
    } catch { return $findings }
    if ($filters.Count -eq 0) { return $findings }

    foreach ($filter in $filters) {
        $program = [string]$filter.Program
        if ([string]::IsNullOrWhiteSpace($program)) { continue }
        if ($program -eq 'Any' -or $program -eq 'System') { continue }

        # THE line the first measurement pass was missing.
        $expanded = [System.Environment]::ExpandEnvironmentVariables($program)
        if (Test-Path -LiteralPath $expanded -ErrorAction SilentlyContinue) { continue }

        $rule = $null
        try { $rule = $filter | Get-NetFirewallRule -ErrorAction SilentlyContinue } catch { $rule = $null }
        if (-not $rule) { continue }

        $why = Get-DeadFirewallReason -program $expanded -group ([string]$rule.Group) -displayName ([string]$rule.DisplayName)

        $findings.Add(@{
            id        = "fwrule|$($rule.Name)"
            label     = [string]$rule.DisplayName
            evidence  = "$why - $expanded"
            risk      = "Safe"
            kind      = "firewall-rule"
            removable = $false
            note      = "Audit only in this release. Removing a rule means deleting a registry VALUE, which needs the same export-the-whole-key-first path PATH entries use; until that ships, Vanish will not offer a removal it cannot reverse."
            meta      = @{ ruleName = [string]$rule.Name; program = $expanded; reason = $why; enabled = [string]$rule.Enabled; direction = [string]$rule.Direction }
        })
    }

    return $findings
}

# Rule 24 in one function: name the KIND of dead, not just the fact of it.
function Get-DeadFirewallReason {
    param([string]$program, [string]$group, [string]$displayName)

    $haystack = "$group $displayName"
    if ($haystack -match 'Media Center|ehome|P2P|Peer.?to.?Peer|Collaboration|Windows Meeting') {
        return 'a Windows feature that no longer ships'
    }
    if ($program -match '\\Temp\\|\\AppData\\Local\\Temp\\|~') {
        return 'a rule an installer left behind in a temp folder'
    }
    if ($program -match '^' + [regex]::Escape($env:SystemRoot)) {
        return 'a Windows component that is no longer installed'
    }
    return 'a program that is no longer on this PC'
}

# ztl: two more dead-reference sweeps that free no space and are worth having
# anyway, because nothing else lists them.
#
# (1) SharedDLLs is a reference COUNT table. A path that no longer exists is a
#     count nothing will ever decrement.
# (2) Ghost PnP devices are records for hardware not currently present.
#
# BOTH AUDIT ONLY, and the second one is the reason Rule 24 exists. 80 ghost
# devices measured on the operator's machine, 23 of them benign VolumeSnapshot
# records and most of the rest simply unplugged peripherals. A list that showed
# those with the same weight as a genuinely failed device would be alarming and
# wrong, so this classifies first and says which kind each one is.
function Find-DeadSharedDlls {
    $findings = [System.Collections.Generic.List[object]]::new()

    $key = Open-RegistryView -hive 'LocalMachine' -subKey 'SOFTWARE\Microsoft\Windows\CurrentVersion\SharedDLLs' -view 'Registry64'
    if (-not $key) { return $findings }
    try {
        foreach ($name in $key.GetValueNames()) {
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            $expanded = [System.Environment]::ExpandEnvironmentVariables($name)
            if (Test-Path -LiteralPath $expanded -ErrorAction SilentlyContinue) { continue }
            $count = $key.GetValue($name, 0)
            $findings.Add(@{
                id        = "shareddll|$name"
                label     = $name
                evidence  = "reference count $count for a file that is not there"
                risk      = "Safe"
                kind      = "shared-dll"
                removable = $false
                note      = "Audit only in this release. These are registry VALUES, which need the value-level export the PATH cleaner uses; they also free no space, so they are listed rather than rushed."
                meta      = @{ path = $expanded; refCount = "$count" }
            })
        }
    } finally { $key.Close() }

    return $findings
}

function Find-GhostDevices {
    $findings = [System.Collections.Generic.List[object]]::new()

    if (-not (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue)) { return $findings }

    $devices = @()
    try {
        $devices = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Unknown' })
    } catch { return $findings }

    foreach ($d in $devices) {
        $class = [string]$d.Class
        $name  = [string]$d.FriendlyName
        if ([string]::IsNullOrWhiteSpace($name)) { $name = [string]$d.InstanceId }

        # Rule 24. A restore-point record is not a broken device.
        $reason = if ($class -eq 'VolumeSnapshot' -or $name -match 'Volume Shadow|VolumeSnapshot') {
            'a System Restore bookkeeping record, not hardware'
        } elseif ($class -in @('USB', 'HIDClass', 'Bluetooth', 'WPD', 'Image', 'Media', 'AudioEndpoint')) {
            'a peripheral that is simply not plugged in right now'
        } elseif ($class -eq 'Volume' -or $class -eq 'DiskDrive') {
            'a drive that is not currently attached'
        } else {
            'a device Windows still has a record for and cannot see'
        }

        $findings.Add(@{
            id        = "ghostdev|$([string]$d.InstanceId)"
            label     = $name
            evidence  = $reason
            risk      = "Safe"
            kind      = "ghost-device"
            removable = $false
            note      = "Audit only, and deliberately so. Most of these are normal - unplugging a device is supposed to leave a record, and Windows reuses it when the device comes back. Removing them frees nothing and can force a driver reinstall on the next plug-in."
            meta      = @{ instanceId = [string]$d.InstanceId; class = $class; reason = $reason }
        })
    }

    return $findings
}

# ag0: a legible list of what Windows has installed as an update.
#
# UN-CUT and rescoped. The first pass cut this as redundant because Windows
# CAN roll updates back - but the redundancy was never the rollback, it was the
# idea of reimplementing wusa/DISM. That half stays cut and this function does
# no removal of any kind. What Windows does badly is the LIST: Settings >
# Windows Update > Update history > Uninstall updates is several clicks deep,
# shows a bare KB list with no indication of what any of them is, surfaces no
# useful install date, and never says what removing one would cost.
#
# TWO SOURCES, and they answer different questions:
#   Get-HotFix  - the servicing-stack view. Few rows, each with a KB number, a
#                 type and a date. Works UNELEVATED.
#   DISM        - the component-store view. Hundreds of rows including the
#                 OnDemand packs and superseded revisions Get-HotFix never
#                 mentions. Requires Full Mode: unelevated it exits 740.
#
# The DISM half being unavailable is REPORTED, not silently skipped. A list
# that quietly shrinks in Audit Mode is the same silent-filter failure this app
# keeps fixing - the caller gets dismAvailable=false and a reason to display.
function Get-WindowsUpdateList {
    $updates = [System.Collections.Generic.List[object]]::new()
    $elevated = Test-IsElevated

    # --- servicing-stack view -------------------------------------------
    $hotfixes = @()
    try { $hotfixes = @(Get-HotFix -ErrorAction SilentlyContinue) } catch { $hotfixes = @() }

    foreach ($h in $hotfixes) {
        $kb = [string]$h.HotFixID
        if ([string]::IsNullOrWhiteSpace($kb)) { continue }

        # Get-HotFix already hands back a DateTime where it can, but it is
        # frequently empty and occasionally a string - both go through the
        # same guard as DISM so one screen cannot show two standards of date.
        $when = if ($h.InstalledOn -is [datetime]) {
            if ($h.InstalledOn -gt (Get-Date).AddDays(1)) {
                @{ iso = $null; note = 'Windows reported an install time in the future, so it is not shown rather than shown wrongly.' }
            } else {
                @{ iso = ([datetime]$h.InstalledOn).ToString('o'); note = $null }
            }
        } else {
            Convert-UpdateInstallTime -raw ([string]$h.InstalledOn)
        }
        $installed = $when.iso

        $updates.Add(@{
            id          = $kb
            kb          = $kb
            title       = [string]$h.Description
            kind        = (Get-UpdateKind -description ([string]$h.Description) -name $kb)
            installedOn = $installed
            installedOnNote = $when.note
            source      = 'servicing'
            state       = 'Installed'
            # Whether wusa can actually remove it is not knowable from here,
            # and guessing would be the "Windows tells you only by failing"
            # behaviour this exists to improve on. Reported as unknown.
            removable   = $null
            removalNote = (Get-UpdateRemovalNote -kind (Get-UpdateKind -description ([string]$h.Description) -name $kb))
        })
    }

    # --- component-store view -------------------------------------------
    $dismAvailable = $false
    $dismNote = $null
    if (-not $elevated) {
        $dismNote = 'The component-store list needs Full Mode. Windows refuses DISM to a standard user (error 740), so this list currently shows only what the servicing stack reports - typically a handful of recent updates rather than every package on the machine.'
    } else {
        $raw = @()
        try { $raw = @(& dism.exe /Online /Get-Packages 2>&1) } catch { $raw = @() }

        $seen = @{}
        foreach ($u in $updates) { $seen[$u.kb] = $true }

        $current = $null
        foreach ($line in $raw) {
            $text = [string]$line
            if ($text -match '^\s*Package Identity\s*:\s*(.+?)\s*$') {
                if ($current) { $null = Add-DismPackage -updates $updates -pkg $current -seen $seen }
                $current = @{ identity = $Matches[1]; state = ''; releaseType = ''; installTime = '' }
                $dismAvailable = $true
            }
            elseif ($current -and $text -match '^\s*State\s*:\s*(.+?)\s*$')        { $current.state = $Matches[1] }
            elseif ($current -and $text -match '^\s*Release Type\s*:\s*(.+?)\s*$') { $current.releaseType = $Matches[1] }
            elseif ($current -and $text -match '^\s*Install Time\s*:\s*(.*?)\s*$') { $current.installTime = $Matches[1] }
        }
        if ($current) { $null = Add-DismPackage -updates $updates -pkg $current -seen $seen }

        if (-not $dismAvailable) {
            $dismNote = 'DISM returned nothing this run. The servicing-stack list below is still accurate as far as it goes.'
        }
    }

    # Newest first: the reason anyone opens this screen is "what changed just
    # before this machine started misbehaving", and that question is answered
    # by the top of the list or not at all.
    $sorted = @($updates | Sort-Object -Property @{ Expression = { if ($_.installedOn) { [datetime]$_.installedOn } else { [datetime]::MinValue } }; Descending = $true })

    $recent = @($sorted | Where-Object {
        $_.installedOn -and ([datetime]$_.installedOn) -gt (Get-Date).AddDays(-14)
    })

    return @{
        success        = $true
        updates        = @($sorted)
        total          = $sorted.Count
        elevated       = $elevated
        dismAvailable  = $dismAvailable
        dismNote       = $dismNote
        recentCount    = $recent.Count
        recentDays     = 14
        # A date column that is blank for most rows needs explaining, or it
        # reads as Vanish failing to look rather than Windows never recording.
        # 176 of 194 on this machine - almost every staged OnDemand package.
        undatedCount   = @($sorted | Where-Object { -not $_.installedOn }).Count
        # THE handoff, and the only action this feature offers. Vanish never
        # owns the removal - the UI must not imply it can reverse an update.
        handoffCommand = 'wusa.exe /uninstall /kb:<number>'
        handoffUi      = 'ms-settings:windowsupdate-history'
    }
}

# ag0: turn an install time into either a real date or an honest blank.
#
# THIS IS c0y ALL OVER AGAIN, which is why it is a function with its own
# guard rather than an inline cast. The entire value of this screen is
# "installed 3 days ago" sitting next to "this machine started misbehaving 3
# days ago". A date that is wrong does not degrade that - it inverts it.
#
# MEASURED on this machine: culture en-IN, short date dd-MM-yyyy, and DISM
# emits install times in exactly that form ("22-07-2026 03:22"). Confirmed by
# the data rather than assumed - across 280 non-empty samples the first field
# reaches 28 and the second never exceeds 12, so the leading number is the day.
# A bare [datetime] cast reads whatever the running culture says, and a
# service account or a different locale silently swaps day and month.
#
# Two rules, both of which return NULL plus a reason rather than a guess:
#   1. Parse with the current culture, then explicitly with dd-MM-yyyy and
#      MM/dd/yyyy, and take the first that works.
#   2. Reject anything in the FUTURE. An update cannot have been installed
#      tomorrow, so a future date is proof the parse was wrong - and showing
#      it would put an impossible row at the top of a list sorted by date.
function Convert-UpdateInstallTime {
    param([string]$raw)

    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @{ iso = $null; note = 'Windows did not record an install time for this package.' }
    }

    $parsed = [datetime]::MinValue
    $ok = [datetime]::TryParse($raw, [System.Globalization.CultureInfo]::CurrentCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)
    if (-not $ok) {
        foreach ($fmt in @('dd-MM-yyyy HH:mm', 'dd-MM-yyyy', 'MM/dd/yyyy HH:mm', 'MM/dd/yyyy', 'yyyy-MM-dd HH:mm')) {
            if ([datetime]::TryParseExact($raw, $fmt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) {
                $ok = $true; break
            }
        }
    }

    if (-not $ok) {
        return @{ iso = $null; note = "Windows reported an install time this build could not read ('$raw')." }
    }

    # Tomorrow is not a date anything was installed on.
    if ($parsed -gt (Get-Date).AddDays(1)) {
        return @{ iso = $null; note = "Windows reported an install time in the future ('$raw'), so it is not shown rather than shown wrongly." }
    }

    return @{ iso = $parsed.ToString('o'); note = $null }
}

# Split out so both the hotfix and DISM paths label a row the same way.
function Get-UpdateKind {
    param([string]$description, [string]$name)
    $all = "$description $name"
    if ($all -match 'Security')                    { return 'Security update' }
    if ($all -match 'Cumulative')                  { return 'Cumulative update' }
    if ($all -match 'Driver')                      { return 'Driver update' }
    if ($all -match '\.NET|NetFx')                 { return '.NET update' }
    if ($all -match 'Defender')                    { return 'Defender update' }
    if ($all -match 'OnDemand|Language|FOD')       { return 'Optional component' }
    if ($all -match 'Servicing|SSU')               { return 'Servicing stack update' }
    if ($all -match 'Hotfix')                      { return 'Hotfix' }
    return 'Update'
}

# The cost line. Rule 24 applied to updates: "removable" is not the useful
# fact - what it costs you is.
function Get-UpdateRemovalNote {
    param([string]$kind)
    switch ($kind) {
        'Security update'        { return 'Removing this puts back a hole Microsoft published a fix for, and the same update will usually reinstall itself. Do this only to test whether it caused a specific problem, and put it back afterwards.' }
        'Servicing stack update' { return 'Servicing stack updates generally cannot be removed at all. Windows will refuse rather than explain.' }
        'Cumulative update'      { return 'A cumulative update contains every fix before it, so removing one rolls back months of work, not a day. Many are not removable at all.' }
        'Driver update'          { return 'Roll a driver back from Device Manager rather than here - it keeps the previous version and can put it back.' }
        'Optional component'     { return 'An on-demand component such as a language pack or optional feature. Removing it is comparatively safe and it can be added again.' }
        default                  { return 'Removing an update is a diagnostic step, not maintenance. If it does not fix the problem, put it back.' }
    }
}

# One DISM package -> one row, unless the servicing stack already named it.
function Add-DismPackage {
    param($updates, $pkg, $seen)

    $identity = [string]$pkg.identity
    if ([string]::IsNullOrWhiteSpace($identity)) { return }

    # Superseded revisions are history, not what is on the machine now. Listing
    # them would triple the list with rows the user cannot act on.
    if ([string]$pkg.state -match 'Superseded') { return }

    $kb = $null
    if ($identity -match '(KB\d{6,})') { $kb = $Matches[1] }
    if ($kb -and $seen.ContainsKey($kb)) { return }   # already listed by Get-HotFix

    $when = Convert-UpdateInstallTime -raw ([string]$pkg.installTime)
    $installed = $when.iso

    # The identity is a package name, not a title. Trim it to the readable
    # part rather than showing the publisher hash and architecture.
    $title = ($identity -split '~')[0]

    $kind = Get-UpdateKind -description ([string]$pkg.releaseType) -name $identity
    if ($kb) { $seen[$kb] = $true }

    $updates.Add(@{
        id          = $identity
        kb          = $kb
        title       = $title
        kind        = $kind
        installedOn = $installed
        installedOnNote = $when.note
        source      = 'component-store'
        state       = [string]$pkg.state
        removable   = $null
        removalNote = (Get-UpdateRemovalNote -kind $kind)
    })
}

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

# The directories any installed program could plausibly own, top level only.
# Shared by zrw's snapshot and bu2's attribution scan: if these two ever
# disagreed about scope, a directory recorded by a monitored install could be
# invisible to the scan that is supposed to attribute it.
function Get-TopLevelProgramDirs {
    $roots = @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramData,
        $env:LOCALAPPDATA,
        $env:APPDATA
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

    $dirs = [System.Collections.Generic.List[string]]::new()
    foreach ($root in $roots) {
        try {
            Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue |
                ForEach-Object { $dirs.Add($_.FullName) }
        } catch { }
    }
    return $dirs
}

# bu2: measure specific directories, and ONLY the ones asked for.
#
# The whole reason this takes a path list rather than scanning a tree is that
# attribution is cheap and measurement is expensive. Classifying every
# top-level directory against the installed-programs map is milliseconds;
# walking all of them is minutes; walking the handful that came back orphaned
# or unexplained is seconds. The caller decides what is worth the walk.
#
# Uses .NET enumeration rather than Get-ChildItem -Recurse: on a folder with
# tens of thousands of files the cmdlet's object construction dominates, and
# EnumerationOptions handles reparse points and unreadable subtrees without
# throwing on every one.
function Measure-Paths {
    param($p)

    $paths = @()
    if ($p -and $p.paths) { $paths = @($p.paths) }

    # A time budget, because a directory walk has no upper bound a user would
    # accept. Measured on the operator's machine: 134 unexplained folders took
    # 62 seconds, dominated by a 12GB WSL tree and an npm cache with hundreds
    # of thousands of tiny files. A scan that takes a minute is a scan nobody
    # runs twice.
    #
    # What is NOT done here is silently truncating: everything past the budget
    # comes back with sizeBytes = $null and a reason, and the UI reports it as
    # unmeasured rather than as small. A wrong number is worse than no number.
    $budgetSeconds = 20
    if ($p -and $p.budgetSeconds) { $budgetSeconds = [int]$p.budgetSeconds }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()

    $results = [System.Collections.Generic.List[PSCustomObject]]::new()
    foreach ($target in $paths) {
        if ([string]::IsNullOrWhiteSpace($target)) { continue }
        if ($clock.Elapsed.TotalSeconds -ge $budgetSeconds) {
            $results.Add([PSCustomObject]@{
                path = $target; sizeBytes = $null
                error = 'Not measured - the scan reached its time limit'
            })
            continue
        }
        if (-not (Test-Path -LiteralPath $target)) {
            $results.Add([PSCustomObject]@{ path = $target; sizeBytes = $null; error = 'No longer on disk' })
            continue
        }
        # qof: a FILE is not a folder, and the walk below cannot tell. A
        # DirectoryInfo constructs happily over a file path, EnumerateFiles()
        # then throws, the per-directory catch counts one skipped dir, and the
        # loop ends having measured nothing. The old answer for a 2KB file was
        # sizeBytes 0 with error null - a NUMBER, and a wrong one, from the
        # function whose own contract above says a wrong number is worse than
        # no number and that unmeasured things come back null with a reason.
        # Measure the file instead; it is one property read. Latent today
        # (every caller passes directories) which is why it was filed rather
        # than hot-fixed - but 0 bytes is the c0y failure, an inference
        # rendered with the confidence of a measurement.
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            try {
                $fi = New-Object System.IO.FileInfo -ArgumentList $target
                $results.Add([PSCustomObject]@{
                    path        = $target
                    sizeBytes   = [long]$fi.Length
                    fileCount   = 1
                    skippedDirs = 0
                    partial     = $false
                    timedOut    = $false
                    error       = $null
                })
            } catch {
                $results.Add([PSCustomObject]@{
                    path = $target; sizeBytes = $null
                    error = 'Not measured - the file could not be read'
                })
            }
            continue
        }
        # A manual stack walk rather than Directory::EnumerateFiles with
        # AllDirectories. Two reasons, both learned the hard way:
        # EnumerationOptions (which would handle this declaratively) is .NET
        # Core only and does not exist in the .NET Framework that Windows
        # PowerShell 5.1 runs on; and the recursive overload aborts the WHOLE
        # walk on the first UnauthorizedAccessException, which on a real
        # ProgramData tree is close to guaranteed. Per-directory try/catch means
        # one unreadable subtree costs that subtree, not the measurement.
        $total = [long]0
        $count = 0
        $skipped = 0
        $stack = New-Object System.Collections.Stack
        $stack.Push($target)
        $ranOut = $false
        while ($stack.Count -gt 0) {
            if ($clock.Elapsed.TotalSeconds -ge $budgetSeconds) { $ranOut = $true; break }
            $dir = $stack.Pop()
            try {
                $di = New-Object System.IO.DirectoryInfo $dir
                foreach ($f in $di.EnumerateFiles()) {
                    try { $total += $f.Length; $count++ } catch { }
                }
                foreach ($d in $di.EnumerateDirectories()) {
                    # A junction or symlink is not this folder's bytes - it is
                    # somewhere else's, and following one can loop forever.
                    if (($d.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
                    $stack.Push($d.FullName)
                }
            } catch {
                $skipped++
            }
        }

        # partial = true means this number is a FLOOR, not a total. Reported
        # rather than smoothed over: "3.2 GB" and "at least 3.2 GB, 4 folders
        # unreadable" are different claims and the user is entitled to know
        # which one they are looking at.
        $results.Add([PSCustomObject]@{
            path        = $target
            sizeBytes   = $total
            fileCount   = $count
            skippedDirs = $skipped
            partial     = ($skipped -gt 0 -or $ranOut)
            timedOut    = $ranOut
            error       = $null
        })

    }

    [PSCustomObject]@{ success = $true; results = @($results) }
}

# ---------------------------------------------------------------------------
# zrw: install snapshot.
#
# The question this answers is one Windows itself does not: "what did that
# installer actually change?" The tools that used to answer it (InstallWatch,
# ZSoft Uninstaller) are dead and nothing replaced them.
#
# Deliberately NOT a filesystem monitor. A live hooking engine was the biggest
# lift on the old roadmap and was cut; this takes two cheap snapshots and
# subtracts them. It therefore cannot see a file that was created and deleted
# between them, and does not claim to - it reports what is DIFFERENT, which is
# what the user actually needs to know afterwards.
#
# Scope is the four places an installer's footprint is visible without walking
# the whole disk: the Run hives, the top level of the Program Files trees, the
# top level of the per-user and machine app-data trees, and the uninstall
# entries themselves. Top level only, on purpose - depth here would cost
# seconds per snapshot and add nothing, because a program that installs into
# an existing folder is identified by its uninstall entry, not by its files.
#
# The output is also the ground truth bu2's size attribution needs: a recorded
# delta says "this path belongs to this program" as fact rather than heuristic.
function Get-InstallSnapshot {
    $runHives = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )

    $runEntries = [System.Collections.Generic.List[string]]::new()
    foreach ($path in $runHives) {
        if (-not (Test-Path $path)) { continue }
        try {
            $props = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
            if ($props) {
                $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
                    $runEntries.Add("$path\$($_.Name)")
                }
            }
        } catch { }
    }

    # Top-level directory names only. Enumerating a whole Program Files tree
    # would turn a snapshot into a scan, and the delta would be no more useful.
    # Shared with bu2's attribution scan (Get-TopLevelProgramDirs) so the two
    # features can never disagree about which directories are even in scope.
    $dirs = Get-TopLevelProgramDirs

    # Uninstall entries by their registry key path, not by display name: a name
    # can change between snapshots (an installer rewriting its own entry mid
    # upgrade) and would then read as one removal plus one addition.
    $uninstallRoots = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    $uninstall = [System.Collections.Generic.List[string]]::new()
    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path $root)) { continue }
        try {
            Get-ChildItem -Path $root -ErrorAction SilentlyContinue |
                ForEach-Object { $uninstall.Add($_.Name) }
        } catch { }
    }

    $services = [System.Collections.Generic.List[string]]::new()
    try {
        Get-Service -ErrorAction SilentlyContinue | ForEach-Object { $services.Add($_.Name) }
    } catch { }

    [PSCustomObject]@{
        success   = $true
        takenAt   = (Get-Date).ToString('o')
        run       = @($runEntries)
        dirs      = @($dirs)
        uninstall = @($uninstall)
        services  = @($services)
    }
}

# ==========================================
# 7sl - CLEANERML: OTHER PEOPLE'S DEFINITIONS, RUN THROUGH OUR VAULT
# ==========================================
# Writing a risk-tiered cleaner catalogue by hand was the largest item on the
# old roadmap and would have been a worse copy of work other people already do
# and maintain. BleachBit's cleanerml repository carries hundreds of
# per-application cleaning rules in CleanerML and has for years. What NOBODY in
# this category offers is a removal you can undo - every commodity cleaner
# deletes. So Vanish brings the vault, not a second catalogue.
#
# LICENCE BOUNDARY, and it decides the design. BleachBit is GPL-3.0 and its
# CleanerML definition files are GPL-3.0+. This repository is MIT and public.
# A file format is a specification rather than a copyrightable work, so a
# READER for it written here carries no obligation - but the definitions
# themselves are never vendored into this tree. They are read from wherever the
# user already has them (an installed BleachBit, or a folder they point at).
# INV-4 forbids fetching them over the network in any case, so "download the
# latest definitions" is not a feature that can exist here.
#
# WHAT THIS EXECUTES, AND WHAT IT REFUSES BY NAME. CleanerML defines eighteen
# action commands. Seventeen of them either mutate a file in place
# (sqlite.vacuum, json, ini, truncate, office_registrymodifications, the
# chrome.* and mozilla_* readers), act on a package manager (apt.*, yum.*), or
# act on the running system (process, win.shell.change.notify). None of those
# is a removal the vault can put back, and INV-1 is not negotiable, so none of
# them is executed. Only "delete" is. An option containing anything else is
# reported with the command named, and the WHOLE option is withheld: a cleaner
# that quietly performs three of an option's five actions is worse than one
# that refuses, because the user believes the option was applied.
#
# The "deep" search is refused for a different reason. It queues a scan of the
# entire filesystem, which is not a cleaning rule but a different product, and
# it would run for minutes bearing no relation to the option that was picked.
#
# Spec read 2026-08-19 from docs.bleachbit.org/cml/cleanerml.html and
# /cml/variables.html. Nothing was copied out of the definitions repository.

$script:CleanerMlSupportedCommands = @('delete')
$script:CleanerMlSupportedSearches = @('file', 'glob', 'walk.files', 'walk.all', 'walk.top')

# An option matching more entries than this is reported rather than offered.
# The number is not a performance guess: it is the point past which one vault
# entry stops being something a person could review before restoring it, and
# reviewability is the only reason the vault is worth having.
$script:CleanerMlMaxMatches = 5000

# BleachBit defines a handful of path variables Windows does not. Everything
# else falls through to the real environment block.
function Get-CleanerMlExtraVariables {
    $vars = @{}
    $lowLocal = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'AppData' } else { $null }
    if ($lowLocal) { $lowLocal = Join-Path $lowLocal 'LocalLow' }

    $known = @{
        'CommonAppData'   = $env:ProgramData
        'LocalAppDataLow' = $lowLocal
        'Documents'       = [System.Environment]::GetFolderPath('MyDocuments')
        'Music'           = [System.Environment]::GetFolderPath('MyMusic')
        'Pictures'        = [System.Environment]::GetFolderPath('MyPictures')
        'Video'           = [System.Environment]::GetFolderPath('MyVideos')
        'Desktop'         = [System.Environment]::GetFolderPath('Desktop')
    }
    foreach ($key in @($known.Keys)) {
        if (-not [string]::IsNullOrWhiteSpace($known[$key])) { $vars[$key.ToLowerInvariant()] = [string]$known[$key] }
    }
    return $vars
}

# Multi-value variables expand ONE action into SEVERAL paths - $$ProgramFiles$$
# covers both Program Files trees on a 64-bit machine. Returning an array here
# is what makes that possible; collapsing it to a single string would clean one
# of the two trees and report the option as done.
function Get-CleanerMlMultiVariables {
    $multi = @{}
    $pf  = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique
    $cpf = @($env:CommonProgramFiles, ${env:CommonProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique
    if ($pf.Count  -gt 0) { $multi['programfiles'] = @($pf) }
    if ($cpf.Count -gt 0) { $multi['commonprogramfiles'] = @($cpf) }
    return $multi
}

function Get-CleanerMlVariableValue {
    param([string]$name, [hashtable]$extra)

    if ([string]::IsNullOrWhiteSpace($name)) { return $null }

    # The real environment block first, so a machine that genuinely defines one
    # of these wins over our stand-in for it.
    $value = [System.Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }

    $key = $name.ToLowerInvariant()
    if ($extra.ContainsKey($key)) { return $extra[$key] }
    return $null
}

# Returns EVERY path a raw CleanerML path expands to, or an empty array when a
# variable in it cannot be resolved on this machine. Unresolved is not an error
# and not a zero-match: it means the question does not apply here, and the
# caller has to be able to say so rather than reporting a clean result.
#
# DELIBERATE DEVIATION from the published spec, and it is load-bearing. The
# spec calls $foo case-SENSITIVE and %foo% case-insensitive. Real definitions
# in the wild write $localappdata in lower case, and Windows environment
# variables are case-insensitive by OS design, so a case-sensitive reading
# would resolve nothing on exactly the definitions people actually have. Both
# forms are expanded case-insensitively here.
function Expand-CleanerMlPath {
    param([string]$raw)

    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }

    $extra = Get-CleanerMlExtraVariables
    $multi = Get-CleanerMlMultiVariables
    $paths = @([string]$raw)

    # $$foo$$ first, because it is the only form that changes the NUMBER of
    # paths, and every later substitution has to happen on each of them.
    for ($round = 0; $round -lt 8; $round++) {
        $pending = @($paths | Where-Object { $_ -match '\$\$([A-Za-z_][A-Za-z0-9_]*)\$\$' })
        if ($pending.Count -eq 0) { break }

        $next = [System.Collections.Generic.List[string]]::new()
        foreach ($path in $paths) {
            if ($path -notmatch '\$\$([A-Za-z_][A-Za-z0-9_]*)\$\$') { $next.Add($path); continue }
            $name  = $Matches[1]
            $token = '$$' + $name + '$$'
            $key   = $name.ToLowerInvariant()

            $values = if ($multi.ContainsKey($key)) { @($multi[$key]) }
                      else {
                          $single = Get-CleanerMlVariableValue -name $name -extra $extra
                          if ($single) { @($single) } else { @() }
                      }

            # No value means this path cannot be resolved on this machine, so
            # it is dropped rather than left carrying a literal $$name$$ that
            # would match nothing and read as a clean result.
            foreach ($value in $values) { $next.Add($path.Replace($token, [string]$value)) }
        }
        $paths = @($next)
        if ($paths.Count -eq 0) { return @() }
    }

    $resolved = [System.Collections.Generic.List[string]]::new()
    foreach ($path in $paths) {
        $current = [string]$path
        $failed  = $false

        if ($current.StartsWith('~')) {
            if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { continue }
            $current = $env:USERPROFILE + $current.Substring(1)
        }

        foreach ($pattern in @('%([A-Za-z_][A-Za-z0-9_ ]*)%', '\$\{([A-Za-z_][A-Za-z0-9_]*)\}', '\$([A-Za-z_][A-Za-z0-9_]*)')) {
            $guard = 0
            while (($current -match $pattern) -and ($guard -lt 16)) {
                $guard++
                $name  = $Matches[1]
                $token = $Matches[0]
                $value = Get-CleanerMlVariableValue -name $name -extra $extra
                if ([string]::IsNullOrWhiteSpace($value)) { $failed = $true; break }
                $current = $current.Replace($token, [string]$value)
            }
            if ($failed) { break }
        }

        if (-not $failed) { $resolved.Add($current) }
    }

    return @($resolved)
}

# One <action>, normalised. Reading and JUDGING are separate on purpose: the
# reader records what the file said, and the caller decides whether Vanish is
# willing to run it. A reader that silently dropped the actions it did not like
# would make an option look smaller than it is.
function ConvertFrom-CleanerMlAction {
    param([System.Xml.XmlElement]$node)

    $command = [string]$node.GetAttribute('command')
    $search  = [string]$node.GetAttribute('search')

    $unsupported = $null
    if ([string]::IsNullOrWhiteSpace($command)) {
        $unsupported = 'an action with no command'
    } elseif ($script:CleanerMlSupportedCommands -notcontains $command) {
        $unsupported = "command '$command'"
    } elseif ([string]::IsNullOrWhiteSpace($search)) {
        $unsupported = 'a delete action with no search mode'
    } elseif ($script:CleanerMlSupportedSearches -notcontains $search) {
        $unsupported = "search '$search'"
    }

    return @{
        command     = $command
        search      = $search
        path        = [string]$node.GetAttribute('path')
        regex       = [string]$node.GetAttribute('regex')
        nregex      = [string]$node.GetAttribute('nregex')
        wholeregex  = [string]$node.GetAttribute('wholeregex')
        nwholeregex = [string]$node.GetAttribute('nwholeregex')
        unsupported = $unsupported
    }
}

# Read one .xml definition. A definition written for another operating system
# is not a failure and neither is one this build will not run, so those come
# back as success with a reason rather than as an error.
function ConvertFrom-CleanerMlFile {
    param([string]$path)

    try {
        $xml = New-Object System.Xml.XmlDocument
        # A definition file is DATA, and data does not get to name a DTD for us
        # to go and fetch. XmlResolver = $null is what stops an external entity
        # reference in someone else's XML from turning into a file read or a
        # network call inside our engine - INV-4 is not satisfied by having no
        # network code of our own if a parser will make the call for us.
        $xml.XmlResolver = $null
        $xml.Load($path)
    } catch {
        return @{ success = $false; file = $path; error = $_.Exception.Message }
    }

    $root = $xml.DocumentElement
    if (-not $root -or $root.Name -ne 'cleaner') {
        $found = if ($root) { $root.Name } else { 'nothing' }
        return @{ success = $false; file = $path; error = "not a CleanerML file - the root element is '$found', not 'cleaner'" }
    }

    $os = [string]$root.GetAttribute('os')
    if (-not [string]::IsNullOrWhiteSpace($os) -and $os -ne 'windows') {
        return @{ success = $true; file = $path; skipped = "written for $os, not windows" }
    }

    $running = [System.Collections.Generic.List[object]]::new()
    foreach ($node in @($root.SelectNodes('running'))) {
        $running.Add(@{ type = [string]$node.GetAttribute('type'); value = ([string]$node.InnerText).Trim() })
    }

    $options = [System.Collections.Generic.List[object]]::new()
    foreach ($node in @($root.SelectNodes('option'))) {
        $optionOs = [string]$node.GetAttribute('os')
        if (-not [string]::IsNullOrWhiteSpace($optionOs) -and $optionOs -ne 'windows') { continue }

        $actions = [System.Collections.Generic.List[object]]::new()
        foreach ($actionNode in @($node.SelectNodes('action'))) {
            $actions.Add((ConvertFrom-CleanerMlAction -node $actionNode))
        }

        $labelNode   = $node.SelectSingleNode('label')
        $descNode    = $node.SelectSingleNode('description')
        $warningNode = $node.SelectSingleNode('warning')

        $options.Add(@{
            id          = [string]$node.GetAttribute('id')
            label       = if ($labelNode) { ([string]$labelNode.InnerText).Trim() } else { [string]$node.GetAttribute('id') }
            description = if ($descNode) { ([string]$descNode.InnerText).Trim() } else { $null }
            warning     = if ($warningNode) { ([string]$warningNode.InnerText).Trim() } else { $null }
            actions     = @($actions)
        })
    }

    $rootLabel = $root.SelectSingleNode('label')
    return @{
        success = $true
        file    = $path
        id      = [string]$root.GetAttribute('id')
        label   = if ($rootLabel) { ([string]$rootLabel.InnerText).Trim() } else { [string]$root.GetAttribute('id') }
        running = @($running)
        options = @($options)
    }
}

# A definition may declare that its application must not be running. Answer
# with the REASON rather than a boolean: "vivaldi is running" is the sentence
# the user needs, and a bare false would make an option vanish unexplained.
function Test-CleanerMlBlockedByRunning {
    param([object[]]$running)

    foreach ($entry in @($running)) {
        $value = [string]$entry.value
        if ([string]::IsNullOrWhiteSpace($value)) { continue }

        if ($entry.type -eq 'exe') {
            $name = [System.IO.Path]::GetFileNameWithoutExtension($value)
            if (Get-Process -Name $name -ErrorAction SilentlyContinue) { return "$name is running" }
        } elseif ($entry.type -eq 'pathname') {
            foreach ($candidate in (Expand-CleanerMlPath -raw $value)) {
                if (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue) {
                    return "$candidate exists, and this definition treats that as the application being in use"
                }
            }
        }
    }
    return $null
}

function Test-CleanerMlFilters {
    param([object]$action, [string]$fullPath)

    $leaf = [System.IO.Path]::GetFileName($fullPath)

    if (-not [string]::IsNullOrWhiteSpace($action.regex)       -and ($leaf     -notmatch $action.regex))       { return $false }
    if (-not [string]::IsNullOrWhiteSpace($action.nregex)      -and ($leaf     -match    $action.nregex))      { return $false }
    if (-not [string]::IsNullOrWhiteSpace($action.wholeregex)  -and ($fullPath -notmatch $action.wholeregex))  { return $false }
    if (-not [string]::IsNullOrWhiteSpace($action.nwholeregex) -and ($fullPath -match    $action.nwholeregex)) { return $false }
    return $true
}

# Everything one action matches on THIS machine. The search modes are the
# spec's and the differences between them are the whole point: walk.files
# leaves the directories standing, walk.all takes them but not the top one,
# walk.top takes the top one too. Reading them loosely would remove a directory
# tree that the definition only asked to empty.
function Resolve-CleanerMlAction {
    param([object]$action)

    $matched = [System.Collections.Generic.List[string]]::new()
    if ($action.unsupported) { return @($matched) }

    foreach ($root in (Expand-CleanerMlPath -raw $action.path)) {
        try {
            if ($action.search -eq 'file') {
                if (Test-Path -LiteralPath $root -ErrorAction SilentlyContinue) { $matched.Add($root) }
            } elseif ($action.search -eq 'glob') {
                foreach ($item in @(Get-Item -Path $root -Force -ErrorAction SilentlyContinue)) {
                    $matched.Add($item.FullName)
                }
            } elseif (Test-Path -LiteralPath $root -ErrorAction SilentlyContinue) {
                # NOT a switch with `continue` in it. `continue` inside a switch
                # continues the SWITCH, not the enclosing foreach, so a missing
                # directory would have skipped the remaining roots of a
                # multi-value path instead of just that one.
                $files = ($action.search -eq 'walk.files')
                foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue)) {
                    if ($files -and $item.PSIsContainer) { continue }
                    $matched.Add($item.FullName)
                }
                if ($action.search -eq 'walk.top') {
                    $matched.Add((Get-Item -LiteralPath $root -Force).FullName)
                }
            }
        } catch { }
    }

    return @($matched | Where-Object { Test-CleanerMlFilters -action $action -fullPath $_ } | Select-Object -Unique)
}

# Drop any path whose ancestor is already in the set.
#
# Not a tidy-up: the vault moves what it is given, and moving a parent
# directory takes its children with it, so a later attempt to move a child that
# is no longer there would fail - and a restore would then have to put the same
# file back twice. walk.all and walk.top collapse to their top directories
# here, which is exactly what those two modes mean anyway.
function Compress-CleanerMlPaths {
    param([string[]]$paths)

    $sorted = @($paths | Sort-Object { $_.Length })
    $kept   = [System.Collections.Generic.List[string]]::new()

    foreach ($path in $sorted) {
        $covered = $false
        foreach ($parent in $kept) {
            if ($path.StartsWith($parent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
                $covered = $true
                break
            }
        }
        if (-not $covered) { $kept.Add($path) }
    }

    return @($kept)
}

# Where the definitions come from. Never from us and never from the network:
# a folder the user pointed at, or a BleachBit they already installed.
function Get-CleanerMlDefinitionDirs {
    param([object]$p)

    $dirs = [System.Collections.Generic.List[string]]::new()

    if ($p -and -not [string]::IsNullOrWhiteSpace([string]$p.definitionsPath)) {
        $given = [string]$p.definitionsPath
        if (Test-Path -LiteralPath $given -PathType Container) { $dirs.Add($given) }
        return @($dirs)
    }

    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:APPDATA)) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        foreach ($relative in @('BleachBit\share\cleaners', 'BleachBit\cleaners')) {
            $candidate = Join-Path $root $relative
            if (Test-Path -LiteralPath $candidate -PathType Container) { $dirs.Add($candidate) }
        }
    }

    return @($dirs | Select-Object -Unique)
}

function Find-CleanerMlFindings {
    param([object]$p)

    $findings = [System.Collections.Generic.List[object]]::new()
    $dirs = Get-CleanerMlDefinitionDirs -p $p

    if ($dirs.Count -eq 0) {
        return @{
            success  = $true
            findings = $findings
            note     = "No CleanerML definitions were found. Vanish does not ship any and will not download them - point it at a folder of definition files, or install BleachBit and they will be read from there."
            sources  = @()
        }
    }

    $files = [System.Collections.Generic.List[string]]::new()
    foreach ($dir in $dirs) {
        foreach ($file in @(Get-ChildItem -LiteralPath $dir -Filter '*.xml' -File -ErrorAction SilentlyContinue)) {
            $files.Add($file.FullName)
        }
    }

    $unreadable    = [System.Collections.Generic.List[string]]::new()
    $otherOs       = 0
    $withheld      = [System.Collections.Generic.List[string]]::new()
    $blocked       = [System.Collections.Generic.List[string]]::new()
    $tooLarge      = [System.Collections.Generic.List[string]]::new()
    $optionsRead   = 0
    $done          = 0

    foreach ($file in $files) {
        $done++
        Write-ScanProgress -stage "Reading cleaning definitions" -done $done -total $files.Count -found $findings.Count

        $definition = ConvertFrom-CleanerMlFile -path $file
        if (-not $definition.success) {
            $unreadable.Add("$([System.IO.Path]::GetFileName($file)): $($definition.error)")
            continue
        }
        if ($definition.skipped) { $otherOs++; continue }

        $runningReason = Test-CleanerMlBlockedByRunning -running $definition.running

        foreach ($option in @($definition.options)) {
            $optionsRead++
            $name = "$($definition.label) - $($option.label)"

            # Named refusals, one line each, rather than an option that quietly
            # does not appear. The command that caused it is in the message,
            # because "some options were skipped" tells nobody anything.
            $reasons = @(@($option.actions) | Where-Object { $_.unsupported } | ForEach-Object { $_.unsupported } | Select-Object -Unique)
            if ($reasons.Count -gt 0) {
                $withheld.Add("$name (uses $($reasons -join ', '))")
                continue
            }
            if (@($option.actions).Count -eq 0) { continue }

            if ($runningReason) {
                $blocked.Add("$name ($runningReason)")
                continue
            }

            $matched = [System.Collections.Generic.List[string]]::new()
            foreach ($action in @($option.actions)) {
                foreach ($hit in (Resolve-CleanerMlAction -action $action)) { $matched.Add($hit) }
            }
            if ($matched.Count -eq 0) { continue }

            $paths = Compress-CleanerMlPaths -paths @($matched | Select-Object -Unique)
            if ($paths.Count -gt $script:CleanerMlMaxMatches) {
                $tooLarge.Add("$name ($($paths.Count) items)")
                continue
            }

            $sizeBytes = [long]0
            foreach ($path in $paths) {
                try {
                    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
                    if ($item.PSIsContainer) { $sizeBytes += (Get-FolderSize $item.FullName) }
                    else { $sizeBytes += [long]$item.Length }
                } catch { }
            }

            # Never "Safe". We did not write these rules and cannot vouch for
            # them; what Vanish adds is that the removal can be undone, not
            # that somebody else's rule was a good idea.
            $risk = if ($option.warning) { 'Advanced' } else { 'Moderate' }

            $findings.Add(@{
                id        = "cleanerml|$($definition.id)|$($option.id)"
                label     = "$name - $(Format-ByteSize $sizeBytes)"
                evidence  = "$([System.IO.Path]::GetFileName($file)) option '$($option.id)' matched $($paths.Count) item(s)"
                risk      = $risk
                kind      = "file"
                path      = $paths[0]
                paths     = @($paths)
                removable = $true
                note      = $option.warning
                sizeBytes = $sizeBytes
                meta      = @{
                    cleanerId  = [string]$definition.id
                    optionId   = [string]$option.id
                    file       = $file
                    matchCount = $paths.Count
                    warning    = $option.warning
                }
            })
        }
    }

    $notes = [System.Collections.Generic.List[string]]::new()
    $notes.Add("Read $($files.Count) definition file(s) from $($dirs -join '; ').")
    if ($otherOs -gt 0)          { $notes.Add("$otherOs are written for another operating system.") }
    if ($withheld.Count -gt 0)   { $notes.Add("$($withheld.Count) option(s) were NOT offered because they use instructions Vanish will not run - it only performs deletions, which the vault can undo: $($withheld -join '; ').") }
    if ($blocked.Count -gt 0)    { $notes.Add("$($blocked.Count) option(s) were skipped because their application is in use: $($blocked -join '; ').") }
    if ($tooLarge.Count -gt 0)   { $notes.Add("$($tooLarge.Count) option(s) matched more than $($script:CleanerMlMaxMatches) items and were not offered, because a vault entry that large is not something you could review before restoring it: $($tooLarge -join '; ').") }
    if ($unreadable.Count -gt 0) { $notes.Add("$($unreadable.Count) file(s) could not be read: $($unreadable -join '; ').") }
    if ($findings.Count -eq 0 -and $optionsRead -gt 0) { $notes.Add("Nothing matched on this machine.") }

    return @{
        success  = $true
        findings = $findings
        note     = ($notes -join ' ')
        sources  = @($dirs)
    }
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
            "installer-cache" { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Find-OrphanInstallerCache)) } }
            "firewall-rules"  { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Find-OrphanFirewallRules)) } }
            "dead-references" {
                # ztl: two sweeps, one section. They answer the same question -
                # "what does Windows still have a record of that is not there" -
                # and neither is big enough to be worth its own row of UI.
                $all = [System.Collections.Generic.List[object]]::new()
                foreach ($f in @(Find-DeadSharedDlls)) { $all.Add($f) }
                foreach ($f in @(Find-GhostDevices))   { $all.Add($f) }
                return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList $all) }
            }
            "associations"  { return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList (Set-FindingRemovability (Find-DeadAssociations))) } }
            "definitions"   {
                # 7sl: the only cleaner whose rules Vanish did not write. The
                # note is not decoration here - it carries every option that
                # was withheld and why, and a caller that drops it turns a
                # named refusal back into a silent one.
                $res = Find-CleanerMlFindings -p $p
                if (-not $res.success) { return @{ success = $false; cleaner = $cleaner; error = $res.error } }
                return @{ success = $true; cleaner = $cleaner; findings = (ConvertTo-FindingList $res.findings); note = $res.note; sources = @($res.sources) }
            }
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

            # Remove EXACTLY what was asked for, and nothing else.
            #
            # This used to also drop every whitespace-only element, on the
            # reasonable-sounding grounds that an empty PATH entry is junk. It
            # is not our junk to throw away. Find-DeadPathEntries deliberately
            # filters whitespace-only elements out BEFORE deciding what is
            # dead, so an empty entry is never proposed to the user, never
            # shown and never consented to - and was deleted anyway, as a side
            # effect of removing something else. An empty element is not inert
            # either: several Windows search paths read it as the current
            # directory, so dropping it silently changes behaviour.
            #
            # The count told the same lie from the other end. removedCount was
            # ($entries.Count - $kept.Count) - how much SHORTER the list got -
            # while every caller reads it as "how many of the entries I asked
            # you to remove were removed". On a PATH ending in ';' those are
            # different numbers, which is exactly how this surfaced: three
            # sandbox assertions failed while "dead entry gone from the live
            # PATH" passed in both suites.
            $removed = [System.Collections.Generic.List[string]]::new()
            $kept    = [System.Collections.Generic.List[string]]::new()
            foreach ($entry in $entries) {
                $trimmed = $entry.Trim()
                if ($trimmed -and ($remove -contains $trimmed)) {
                    $removed.Add($trimmed)
                } else {
                    # Kept verbatim rather than trimmed: "byte-identical to the
                    # original" has to mean byte-identical.
                    $kept.Add($entry)
                }
            }

            # Requested entries that were not in the value. Reported rather
            # than swallowed - a write that removed nothing must not be able to
            # report success indistinguishable from one that removed what it
            # was given.
            $notFound = @($remove | Where-Object { $removed -notcontains $_ })

            $newValue = ($kept -join ';')
            $key.SetValue('Path', $newValue, $kind)

            return @{
                success      = $true
                removedCount = $removed.Count
                removed      = @($removed)
                notFound     = @($notFound)
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

# ==========================================
# THE HYGIENE SUITE FINDERS (5p5 / aeu / vw4)
# ==========================================
# docs/history/HANDOFF-2026-08-21.md measured this file at 7,870 lines - 41%
# of all production code - and identified that as the structural reason a
# zero-result case has no distinct type here. So the machine-hygiene suite
# does NOT land in this file. Each finder is its own file under finders/,
# registering itself with the loader below, and adding the twenty-first
# finder touches nothing that already exists.
#
# Dot-sourced rather than imported as a module because the engine ships as a
# single script invoked with -Action, and a module manifest would be a second
# packaging contract for no gain. Guarded by Test-Path so a trimmed install
# that omits finders/ still answers every pre-existing action - a missing
# suite must degrade to "that check did not run", never to a silent pass.
$script:FinderDir = Join-Path $PSScriptRoot 'finders'
foreach ($support in @('_contract.ps1', '_never-touch.ps1', '_loader.ps1')) {
    $supportPath = Join-Path $script:FinderDir $support
    if (Test-Path -LiteralPath $supportPath -PathType Leaf) { . $supportPath }
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
        "measure-paths" {
            Measure-Paths -p $Params | ConvertTo-Json -Depth 5 -Compress
        }
        "install-snapshot" {
            # zrw: read-only, no elevation required - it is two Get-ChildItem
            # passes and a registry read. Deliberately callable in Audit Mode,
            # because "what did that installer change" is an audit question.
            Get-InstallSnapshot | ConvertTo-Json -Depth 5 -Compress
        }
        "get-windows-updates" {
            Get-WindowsUpdateList | ConvertTo-Json -Depth 6 -Compress
        }
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
            # z3s: "protected" and "restorable" are different questions now, and
            # the probe reports both. A path can be protected AND restorable -
            # that pair is the whole exception, and a test that could only see
            # the first would pass while the second was wide open.
            $probeArgs = @{ path = ([string]$Params.path) }
            if ($Params.vaultRoot) { $probeArgs.vaultRoot = [string]$Params.vaultRoot }
            $mustNotExist = ($Params.mustNotExist -eq $true)
            @{
                success    = $true
                path       = [string]$Params.path
                protected  = [bool](Test-ProtectedDestination ([string]$Params.path))
                restorable = [bool](Test-RestorableProtectedPath -path ([string]$Params.path) -vaultRoot ([string]$Params.vaultRoot) -MustNotExist:$mustNotExist)
                # 2026-09-02: a THIRD question, for the same reason the second
                # one exists. "Protected" alone stopped expressing the policy
                # once installed-program folders became conditionally allowed,
                # and a test that could only see the first two would now read a
                # deliberate exception as a regression.
                installedAppRestorable = [bool](Test-RestorableInstalledAppPath -path ([string]$Params.path) -vaultRoot ([string]$Params.vaultRoot))
                installedAppShape      = [bool](Test-RestorableInstalledAppPathShape -path ([string]$Params.path))
                dataDirTrusted = [bool](Test-VaultDataDirTrusted -vaultRoot ([string]$Params.vaultRoot))
                resolved   = (Resolve-DestinationTarget ([System.IO.Path]::GetFullPath([string]$Params.path)))
            } | ConvertTo-Json -Depth 4 -Compress
        }
        "indicator-probe" {
            # Rule 7 verification hook, same shape as cleanerml-probe and
            # finder-probe: read-only, side-effect free, callable in Audit Mode.
            #
            # It exists because the suite that covers this used to SPAWN a real
            # process whose command line was a live ransomware indicator, purely
            # so the classifier would have something to classify. On 2026-08-27
            # Kaspersky System Watcher did exactly what it is supposed to do:
            # flagged PDM:Trojan.Win32.Generic and quarantined the TEST SCRIPT
            # that spawned it. The suite then reported NOT RUN, because its own
            # file was gone - and a second run stalled indefinitely at the same
            # line, because the decoy was being suspended rather than killed.
            #
            # Get-ProcessIndicators is a pure function of a process record, so
            # spawning anything was never necessary to test it. Passing a
            # synthetic record proves the same thing, deterministically, in
            # milliseconds, without asking the operator to trust a tool that
            # trips their antivirus on the way past.
            $synthetic = @{
                Name        = [string]$Params.name
                CommandLine = [string]$Params.commandLine
                Id          = 0
            }
            @{
                success    = $true
                indicators = @(Get-ProcessIndicators -proc $synthetic -parentName ([string]$Params.parentName) -persistenceIndex $null)
                patternCount = @($script:DestructivePatterns).Count
            } | ConvertTo-Json -Depth 5 -Compress
        }
        "cleanerml-probe" {
            # 7sl verification hook, in the same shape as the SEC-2 and TASK-05
            # probes above: read-only, side-effect free, and callable in Audit
            # Mode, so the parts of the CleanerML reader that decide WHAT would
            # be removed are testable without removing anything.
            #
            # These are the three questions worth asking separately. A suite
            # that could only call cleaner-scan would be testing variable
            # expansion, search modes and filters through one aggregate answer,
            # and a wrong path would be indistinguishable from a machine where
            # the files happen not to exist.
            $mode = [string]$Params.mode
            $result = switch ($mode) {
                'expand' {
                    @{ success = $true; paths = @(Expand-CleanerMlPath -raw ([string]$Params.path)) }
                }
                'parse' {
                    ConvertFrom-CleanerMlFile -path ([string]$Params.file)
                }
                'compress' {
                    @{ success = $true; paths = @(Compress-CleanerMlPaths -paths @($Params.paths)) }
                }
                'resolve' {
                    $node = @{
                        command     = [string]$Params.command
                        search      = [string]$Params.search
                        path        = [string]$Params.path
                        regex       = [string]$Params.regex
                        nregex      = [string]$Params.nregex
                        wholeregex  = [string]$Params.wholeregex
                        nwholeregex = [string]$Params.nwholeregex
                        unsupported = $null
                    }
                    if ($script:CleanerMlSupportedCommands -notcontains $node.command) { $node.unsupported = "command '$($node.command)'" }
                    elseif ($script:CleanerMlSupportedSearches -notcontains $node.search) { $node.unsupported = "search '$($node.search)'" }
                    @{ success = $true; unsupported = $node.unsupported; paths = @(Resolve-CleanerMlAction -action $node) }
                }
                default {
                    @{ success = $false; error = "Unknown cleanerml-probe mode '$mode'." }
                }
            }
            $result | ConvertTo-Json -Depth 8 -Compress
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
        "relaunch-deelevated" {
            # Operator report (live sandbox testing, 2026-08-10): "it starts in
            # admin mode as expected, but there is no way to return to audit
            # mode." A plain child process launched from an elevated parent
            # INHERITS that elevation - Windows does not drop privilege on a
            # bare CreateProcess/Start-Process, only UAC's -Verb RunAs ADDS it.
            #
            # v2, same day: the first attempt used Shell.Application's
            # ShellExecute (the well-known "ask explorer.exe to launch it"
            # trick) - a LIVE elevated test showed it does not reliably work,
            # the relaunched instance came back still elevated. That trick
            # depends on COM activation actually routing to the
            # already-running explorer.exe process, which is not a documented
            # contract, only an observed behaviour that can differ by Windows
            # build or session state (and evidently did not hold in Windows
            # Sandbox's WDAG session).
            #
            # runas.exe /trustlevel:0x20000 is the actual Windows-documented
            # mechanism for this exact operation, dating to Vista's original
            # UAC design: it starts a process at Medium integrity (0x20000 =
            # standard user) from a High-integrity caller, no credentials and
            # no prompt, because DROPPING privilege has never needed
            # authorization - only REQUESTING more does. Does not depend on
            # explorer.exe or any COM registration at all.
            try {
                if (-not (Test-Path -LiteralPath $Params.exePath)) {
                    throw "The application file no longer exists at '$($Params.exePath)'."
                }
                $argString = ''
                if ($Params.argList -and @($Params.argList).Count -gt 0) {
                    $argString = ' ' + ((@($Params.argList) | ForEach-Object { '"' + $_ + '"' }) -join ' ')
                }
                # The whole target (exe path + its own args) is ONE argument to
                # runas - it is not runas's own args, so it gets its own quoting
                # regardless of what is inside it.
                $commandLine = '"' + $Params.exePath + '"' + $argString

                # 1dq: capture the OUTCOME, not the launch.
                #
                # This previously did Start-Process without -Wait and reported
                # success the moment runas.exe existed as a process. runas.exe
                # then ran, and whatever it decided went to a console window
                # that closed immediately. Its exit code was never read. So
                # every way runas itself can fail was invisible and reported to
                # the user as "restarting" - which is exactly what the operator
                # hit on 2026-08-13: two de-elevation attempts both logged
                # success, and both came back Full Mode.
                #
                # runas.exe exits promptly after handing the process off, so
                # -Wait costs nothing here and buys the exit code. stderr is
                # captured because runas reports its real reason there (the
                # Secondary Logon service being unavailable, a trust level the
                # policy refuses, a target it cannot open).
                # 9vp: try the mechanism that was MEASURED to work here first.
                # See Invoke-DeelevatedViaScheduledTask for the probe results.
                $taskResult = Invoke-DeelevatedViaScheduledTask -ExePath $Params.exePath -ArgList $argList
                if ($taskResult.success) {
                    $taskResult | ConvertTo-Json -Compress
                    return
                }

                # Fall through to runas, and carry WHY the first one failed so a
                # failure report names both attempts rather than only the last.
                $taskError = $taskResult.error

                $name = [System.IO.Path]::GetFileNameWithoutExtension($Params.exePath)
                $beforePids = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

                $errFile = [System.IO.Path]::GetTempFileName()
                $outFile = [System.IO.Path]::GetTempFileName()
                try {
                    $proc = Start-Process -FilePath "runas.exe" `
                        -ArgumentList @('/trustlevel:0x20000', $commandLine) `
                        -Wait -PassThru -WindowStyle Hidden `
                        -RedirectStandardError $errFile -RedirectStandardOutput $outFile `
                        -ErrorAction Stop

                    $stderr = ''
                    $stdout = ''
                    try { $stderr = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue) } catch { }
                    try { $stdout = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue) } catch { }
                    $detail = (@($stderr, $stdout) | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }) -join ' '

                    if ($proc.ExitCode -ne 0) {
                        $why = if ($detail) { $detail } else { "runas.exe exited with code $($proc.ExitCode)." }
                        @{
                            success   = $false
                            method    = "runas-trustlevel"
                            exitCode  = $proc.ExitCode
                            taskError = $taskError
                            error     = "Both ways of restarting without administrator rights failed. Scheduled task: $taskError Then runas: $why"
                        } | ConvertTo-Json -Compress
                    } else {
                        # 9vp: exit code 0 from runas is NOT evidence, and
                        # treating it as evidence is what produced the
                        # relaunch-deelevated-mismatch in the operator's oplog -
                        # runas exited 0 and Windows started the process elevated
                        # anyway. So the fallback now has to show a new process
                        # exists, the same standard the scheduled-task path meets.
                        # Whether that process is actually at medium integrity is
                        # still only provable by the next launch's own tier check,
                        # which is what the relaunch-intent marker is for.
                        $fallbackPid = Wait-ForNewProcess -ExePath $Params.exePath -BeforePids $beforePids
                        if (-not $fallbackPid) {
                            @{
                                success   = $false
                                method    = "runas-trustlevel"
                                exitCode  = 0
                                taskError = $taskError
                                error     = "Both ways of restarting without administrator rights failed. Scheduled task: $taskError Then runas reported success but no new process appeared within 15 seconds."
                            } | ConvertTo-Json -Compress
                        } else {
                            @{ success = $true; method = "runas-trustlevel"; exitCode = 0; newPid = $fallbackPid; detail = $detail } | ConvertTo-Json -Compress
                        }
                    }
                } finally {
                    Remove-Item -LiteralPath $errFile, $outFile -Force -ErrorAction SilentlyContinue
                }
            } catch {
                @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
            }
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
                    # qyt: same machine fact, two different things to tell the
                    # user. "Turn UAC back on" is useful advice on a personal
                    # machine and useless on a managed one, where the setting
                    # reverts on the next policy refresh.
                    $cause = if ($uac.lockLikely) { 'uac-disabled-locked' } else { 'uac-disabled' }
                } elseif ($uac.silentElevation -eq $true) {
                    # adg: the third machine, and until now it fell through to
                    # 'unknown'. UAC is ON (EnableLUA=1, so the token is still
                    # filtered and Vanish still opens in Audit Mode) but
                    # ConsentPromptBehaviorAdmin=0 auto-approves without a
                    # dialog. Measured on the operator's machine 2026-08-28,
                    # who described it as "the prompt won't show because uac is
                    # disabled" - a reasonable reading of the symptom and not
                    # what the registry says.
                    #
                    # None of the branches above can fire here: enableLua is
                    # true, the account IS an administrator, and there is no
                    # Win32 1223 because there is no prompt to cancel. So every
                    # failure on this configuration reported cause 'unknown',
                    # and the user got a shrug from the one screen that exists
                    # to explain itself.
                    $cause = 'elevation-silent-failed'
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
        "network-ping" {
            Invoke-NetworkPing -p $Params | ConvertTo-Json -Depth 4 -Compress
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
        "get-listeners" {
            Get-ListenerReport | ConvertTo-Json -Depth 6
        }
        "network-speedtest" {
            Invoke-NetworkSpeedTest -p $Params | ConvertTo-Json -Depth 4 -Compress
        }
        "hygiene-scan" {
            # 5p5: the finder half of the seam. Returns TYPED results - three
            # states per finder, computed from evidence - and decides nothing.
            # lib/findings.js consumes this and produces the UI state, which is
            # the only place a zero-finding case is named.
            Invoke-HygieneScan -p $Params | ConvertTo-Json -Depth 9 -Compress
        }
        "finder-probe" {
            # Verification hook in the same shape as cleanerml-probe and
            # protected-destination-probe above: read-only, side-effect free,
            # callable in Audit Mode. The contract is what needs testing here,
            # and a suite that could only call hygiene-scan would be testing it
            # through whatever happens to be on the machine that day.
            $mode = [string]$Params.mode
            $result = switch ($mode) {
                'list' {
                    $load = Import-Finders
                    @{
                        success    = $true
                        loaded     = @($load.loaded)
                        loadErrors = @($load.loadErrors)
                        finders    = @(Get-RegisteredFinders | ForEach-Object {
                            @{ name = $_.name; title = $_.title; module = $_.module; auditOnly = $_.auditOnly; needsElevation = $_.needsElevation; walkGroup = $_.walkGroup }
                        })
                    }
                }
                'state' {
                    # Hand the contract a findings list and an unreadable list
                    # and ask what state that IS. The pair (0 findings, >0
                    # unreadable) must never come back as 'nothing' - that is
                    # the assertion aeu exists for, and it is cheaper to prove
                    # here than through any real scan.
                    $fs = @()
                    foreach ($x in @($Params.findings)) { if ($null -ne $x) { $fs += ,(New-Finding -id ([string]$x) -title ([string]$x)) } }
                    $us = @()
                    foreach ($x in @($Params.unreadable)) { if ($null -ne $x) { $us += ,(New-Unreadable -path ([string]$x) -reason 'probe') } }
                    $r = New-FinderResult -finder 'probe' -title 'probe' -findings $fs -unreadable $us -examined ([int]$Params.examined)
                    $r['success'] = $true
                    $r
                }
                'never-touch' {
                    $verdict = Test-NeverTouchPath ([string]$Params.path)
                    @{ success = $true; path = [string]$Params.path; neverTouch = ($null -ne $verdict); reason = $(if ($verdict) { $verdict.reason } else { '' }) }
                }
                'consumers' {
                    $r = Find-ToolchainConsumers -markers @($Params.markers) -roots @($Params.roots)
                    $r['success'] = $true
                    $r
                }
                default {
                    @{ success = $false; error = "Unknown finder-probe mode '$mode'" }
                }
            }
            $result | ConvertTo-Json -Depth 8 -Compress
        }
        default {
            @{ success = $false; error = "Unknown action '$Action'" } | ConvertTo-Json
        }
    }
}
