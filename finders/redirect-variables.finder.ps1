# ==========================================
# REDIRECT VARIABLES UNSET (bd vanish-uninstaller-pko)
# ==========================================
# Module 2 HYGIENE check 2 of 5, HANDOFF-2026-08-21 section 3: "GRADLE_USER_HOME,
# ANDROID_HOME, ANDROID_SDK_ROOT, npm_config_cache, PIP_CACHE_DIR all unset --
# every dev tool had silently defaulted to C: since the machine was built.
# THIS SINGLE FINDING EXPLAINED MOST OF THE C: BULK." The handoff calls this
# "the highest signal-to-effort item in the whole document" -- five variables,
# each free to set, together explaining more disk bloat than any single
# per-tool cache cleaner in Module 1 (RECLAIM).
#
# What each variable redirects, and where the tool goes instead when it is
# unset (facts about the TOOL, documented by its own maintainers, not guesses
# about this machine):
#   GRADLE_USER_HOME  -> Gradle's cache, wrapper distributions and dependency
#                        cache all live under it; unset, Gradle uses
#                        %USERPROFILE%\.gradle.
#   ANDROID_HOME      -> the legacy variable Android command-line tools read
#                        for the SDK location; unset, tooling falls back to
#                        wherever the SDK was installed, which for Android
#                        Studio's own installer is %LOCALAPPDATA%\Android\Sdk.
#   ANDROID_SDK_ROOT  -> the current variable name for the same thing; unset,
#                        it resolves to the SAME default location as
#                        ANDROID_HOME -- both being unset is one install, not
#                        two, so this finder still reports both as
#                        independent findings (each is independently a wrong,
#                        free-to-fix state) while the evidence for each names
#                        that they share a default location.
#   npm_config_cache  -> npm's package/tarball cache; unset, npm's own
#                        documented Windows default is %LOCALAPPDATA%\npm-cache.
#   PIP_CACHE_DIR     -> pip's wheel/package cache; unset, pip's own
#                        documented Windows default is %LOCALAPPDATA%\pip\Cache.
#
# All five defaults resolve under the user profile, which by default sits on
# C: regardless of which drive the operator's actual projects live on (this
# machine's dev tree is under D:\quickhelp) -- that mismatch is exactly the
# "explained most of the C: bulk" finding.
#
# WHAT THIS CHECK REPORTS: for each of the five, whether it is set (checked in
# BOTH the User and Machine persistent environment via
# [Environment]::GetEnvironmentVariable's target-scoped overload, which reads
# the registry-backed value directly rather than this process's possibly
# stale copy), and if unset, the default location the tool falls back to and
# how many bytes are CURRENTLY sitting there. costClass is 'cheap' -- setting
# an environment variable is free -- and bytes is the measured size at the
# default location, which is one of the two hygiene checks in this module
# where bytes is not always 0 (see finders/duplicate-installs.finder.ps1's
# header for the other). Nothing here MOVES those bytes; action is 'audit'
# and stays 'audit' regardless of how large the default location has grown.
#
# aeu: a default-location directory this check cannot fully enumerate (a
# permission error partway through) does not silently report 0 bytes -- the
# measured partial total is still shown (an under-count is safer than an
# invented one), but the run is marked incomplete via New-Unreadable so a
# decider never treats a partial sum as the whole truth.

# NOTE ON Set-StrictMode: deliberately NOT set here -- see finders/_contract.ps1.
# Pko prefix on every script-scoped name -- see path-hygiene.finder.ps1's
# header. Same file's header also explains why every helper function is
# `function script:Name`, not plain `function Name`: a plain function
# defined here would not survive past Import-Finders dot-sourcing this file
# from inside its own function body, and would be gone before this file's
# own handler ever runs.

$script:PkoRedirectVariableSpecs = @(
    @{ name = 'GRADLE_USER_HOME'; tool = 'Gradle'; template = '{USERPROFILE}\.gradle'; note = "Gradle's own default when GRADLE_USER_HOME is unset: caches, the wrapper distribution cache and the dependency cache all accumulate here" }
    @{ name = 'ANDROID_HOME'; tool = 'Android SDK command-line tools (legacy variable name)'; template = '{LOCALAPPDATA}\Android\Sdk'; note = "the Android SDK install location Android Studio's own installer uses by default when neither ANDROID_HOME nor ANDROID_SDK_ROOT is set" }
    @{ name = 'ANDROID_SDK_ROOT'; tool = 'Android SDK command-line tools (current variable name)'; template = '{LOCALAPPDATA}\Android\Sdk'; note = "the same default SDK location as ANDROID_HOME -- both variables name one install by default, so both being unset does not mean two copies exist" }
    @{ name = 'npm_config_cache'; tool = 'npm'; template = '{LOCALAPPDATA}\npm-cache'; note = "npm's documented Windows cache default" }
    @{ name = 'PIP_CACHE_DIR'; tool = 'pip'; template = '{LOCALAPPDATA}\pip\Cache'; note = "pip's documented Windows cache default" }
)

function script:Resolve-PkoRedirectTemplate {
    param([string]$template)
    $u = if ($env:USERPROFILE) { $env:USERPROFILE } else { '' }
    $l = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { '' }
    return $template.Replace('{USERPROFILE}', $u).Replace('{LOCALAPPDATA}', $l)
}

function script:Measure-PkoDirectoryBytes {
    <#
    .SYNOPSIS
        Bytes under $path, and whether the enumeration was complete.

    .DESCRIPTION
        A directory that does not exist yet is not an error -- it means the
        tool has never run since the machine was built, which is itself part
        of the evidence. A directory that exists but cannot be FULLY
        enumerated (one locked subfolder) still returns the partial sum
        rather than zero, because an under-count is a safer lie than an
        invented one -- but errorDetail is set so the caller can mark the
        result incomplete via New-Unreadable rather than trusting the number
        silently.
    #>
    param([string]$path)
    $out = @{ bytes = 0L; existed = $false; errorDetail = $null }
    if ([string]::IsNullOrWhiteSpace($path)) { return $out }
    if (-not (Test-Path -LiteralPath $path -ErrorAction SilentlyContinue)) { return $out }
    $out.existed = $true
    try {
        $err = $null
        $items = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue -ErrorVariable +err)
        $sum = 0L
        foreach ($i in $items) { $sum += [long]$i.Length }
        $out.bytes = $sum
        $firstErr = @($err | Where-Object { $_ }) | Select-Object -First 1
        if ($firstErr) { $out.errorDetail = $firstErr.Exception.Message }
    } catch {
        $out.errorDetail = $_.Exception.Message
    }
    return $out
}

Register-Finder -name 'redirect-variables' `
    -title 'Redirect variables unset -- dev tools silently defaulting to C:' `
    -module 'hygiene' `
    -auditOnly $true `
    -description 'GRADLE_USER_HOME, ANDROID_HOME, ANDROID_SDK_ROOT, npm_config_cache, PIP_CACHE_DIR: whether each is set, and if not, the documented default location the tool falls back to plus how much is already sitting there. Audit only; see bd vanish-uninstaller-pko.' `
    -handler {
        param($p)

        $findings   = [System.Collections.Generic.List[object]]::new()
        $unreadable = [System.Collections.Generic.List[object]]::new()

        $overrideVars     = Get-FieldValue -record $p -name 'variables' -default $null
        $overrideDefaults = Get-FieldValue -record $p -name 'defaultPaths' -default $null

        $examined = 0
        foreach ($spec in $script:PkoRedirectVariableSpecs) {
            $examined++
            $name = $spec.name

            if ($null -ne $overrideVars) {
                $value = Get-FieldValue -record $overrideVars -name $name -default $null
            } else {
                $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::User)
                if ([string]::IsNullOrWhiteSpace([string]$value)) {
                    $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Machine)
                }
            }

            if (-not [string]::IsNullOrWhiteSpace([string]$value)) { continue }

            $defaultPath = $null
            if ($null -ne $overrideDefaults) {
                $ov = Get-FieldValue -record $overrideDefaults -name $name -default $null
                if ($null -ne $ov -and -not [string]::IsNullOrWhiteSpace([string]$ov)) { $defaultPath = [string]$ov }
            }
            if ([string]::IsNullOrWhiteSpace($defaultPath)) { $defaultPath = Resolve-PkoRedirectTemplate $spec.template }

            $guard = Test-NeverTouchPath -path $defaultPath
            if ($guard) {
                $unreadable.Add((New-Unreadable -path $defaultPath -reason 'never-touch' -detail $guard.reason))
                continue
            }

            $measured = Measure-PkoDirectoryBytes -path $defaultPath
            if ($measured.errorDetail) {
                $unreadable.Add((New-Unreadable -path $defaultPath -reason 'size-measure-failed' -detail $measured.errorDetail))
            }

            $sizeText = if ($measured.existed) {
                "$(Format-ByteSize $measured.bytes) is already sitting there"
            } else {
                "nothing is there yet"
            }

            $evParams = @{
                id        = "redirect-variables|$name"
                title     = "$name is unset"
                path      = $defaultPath
                bytes     = $measured.bytes
                evidence  = "$name is not set (checked in both the User and Machine persistent environment). $($spec.tool) has been defaulting to '$defaultPath' -- $($spec.note). $sizeText."
                costClass = 'cheap'
                action    = 'audit'
                detail    = @{ variable = $name; tool = $spec.tool; defaultPath = $defaultPath; measuredBytes = $measured.bytes }
            }
            $findings.Add((New-Finding @evParams))
        }

        $note = "$examined redirect variable(s) checked (GRADLE_USER_HOME, ANDROID_HOME, ANDROID_SDK_ROOT, npm_config_cache, PIP_CACHE_DIR). A variable already set is not reported."

        return New-FinderResult -finder 'redirect-variables' `
            -title 'Redirect variables unset -- dev tools silently defaulting to C:' `
            -findings @($findings) `
            -unreadable @($unreadable) `
            -examined $examined `
            -note $note
    }
