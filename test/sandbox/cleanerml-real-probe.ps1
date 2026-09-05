# dzr: run the definitions cleaner against BleachBit's REAL cleaners directory.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\start-sandbox.ps1 -RunScript cleanerml-real-probe.ps1
#
# 7sl shipped the CleanerML reader with 61 engine assertions and 10 DOM
# assertions, every one of them against fixture definitions this repository
# writes itself. What has never happened is a run against several hundred files
# written by people who did not have our reader in mind.
#
# IN THE SANDBOX, and that is not squeamishness. BleachBit's definitions are
# GPL-3.0+ and CLAUDE.md's licence boundary forbids vendoring them into this
# MIT repository - so they must be READ from an install, never copied here. A
# disposable VM is where a third-party install belongs, and it keeps the
# operator's own machine out of it.
#
# THIS PROBE MEASURES. It does not assert, and it deliberately has no pass/fail:
# the answer it is looking for might be "this feature reaches less of the
# catalogue than the UI implies", which is a finding for docs/PRE-RELEASE.md
# rather than a test failure. A probe that can only go green cannot deliver that
# answer.
#
# NOTHING IS QUARANTINED. The scan is read-only; the removal half is not
# exercised here on purpose. bd dzr: "Do NOT quarantine anything on a machine
# you care about without checking the restore first", and a first contact with
# several hundred unknown rules is not the moment.

param(
    # Try an installed BleachBit (and winget) before the source tree.
    #
    # OFF BY DEFAULT, deliberately. The source tree IS the corpus this probe
    # wants - several hundred CleanerML files written by people who did not
    # have our reader in mind - and taking it that way installs nothing, needs
    # no admin, and lets the acceptance be re-run anywhere including the
    # operator's own machine. Installing an application is the heavier path and
    # should be the one you ask for.
    [switch]$TryInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$engine = Join-Path $root 'scanner.ps1'
$outDir = Join-Path $root 'test\logs\sandbox-run'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$report = Join-Path $outDir 'cleanerml-real-report.md'

$lines = [System.Collections.Generic.List[string]]::new()
function Say($text) {
    Write-Host $text
    $lines.Add($text)
    # Flushed on every line, not at the end. If this dies halfway - and a first
    # run against unknown input is exactly where that happens - the host still
    # gets everything up to the failure.
    Set-Content -LiteralPath $report -Value $lines -Encoding UTF8
}

Say "# dzr: the definitions cleaner against real BleachBit rules"
Say ""
Say ("Run $(Get-Date -Format 's') on $env:COMPUTERNAME.")
Say ""

# ---------------------------------------------------------------------------
Say "## Getting the definitions"
Say ""

# WINDOWS SANDBOX SHIPS WITHOUT WINGET, which the first run of this probe found
# the hard way - bd dzr assumed "the sandbox can install it via winget the same
# way it installs Chrome", and sandbox-setup.ps1's Chrome step has carried a
# fallback for exactly this since it was written. This has one too.
#
# The fallback takes the definitions from BleachBit's SOURCE rather than from an
# install. That is better here, not merely easier: the corpus this probe needs
# is several hundred CleanerML files written by people who did not have our
# reader in mind, and the source tree is that corpus without installing an
# application at all.
#
# NOTHING GPL LANDS IN THE REPOSITORY. CLAUDE.md's licence boundary forbids
# vendoring BleachBit's definitions into this MIT repo; downloading them into a
# disposable VM to READ them is not vendoring, and the extraction goes to the
# VM's temp directory, never to the mapped folder. The report written back to
# the host carries counts and option names - analysis, not the definitions.
$cleaners = $null
$corpus = ''

$bb = $null
if ($TryInstall) {
    $bbRoots = @(
        (Join-Path $env:ProgramFiles 'BleachBit'),
        (Join-Path ${env:ProgramFiles(x86)} 'BleachBit'),
        (Join-Path $env:LOCALAPPDATA 'Programs\BleachBit')
    )
    $bb = $bbRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

    if (-not $bb -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        Say "Trying winget."
        try {
            $wingetLog = (& winget install --id BleachBit.BleachBit -e --silent `
                --accept-source-agreements --accept-package-agreements 2>&1 | Out-String)
            Say '```'
            Say ($wingetLog.Trim())
            Say '```'
        } catch {
            Say "winget threw: $($_.Exception.Message)"
        }
        $bb = $bbRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    } elseif (-not $bb) {
        Say "winget is not present in this image - falling through to the source tree."
    }
} else {
    Say "Taking the definitions from BleachBit's source tree. Nothing is installed."
    Say "(Pass -TryInstall to use an installed BleachBit instead.)"
}

if ($bb) {
    Say ""
    Say "Installed at ``$bb``."
    $found = Get-ChildItem -LiteralPath $bb -Recurse -Directory -Filter 'cleaners' -ErrorAction SilentlyContinue |
             Select-Object -First 1
    if ($found) { $cleaners = $found.FullName; $corpus = "the installed BleachBit at $bb" }
}

if (-not $cleaners) {
    Say ""
    Say "Downloading the BleachBit source tree for its ``cleaners/`` directory."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # A RELEASE tag rather than the default branch, so the corpus is one that
    # was actually shipped rather than whatever was mid-development today. Falls
    # back to master, and SAYS WHICH - the two are different corpora and the
    # numbers below mean slightly different things for each.
    $tag = ''
    try {
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/bleachbit/bleachbit/releases/latest' `
               -UseBasicParsing -Headers @{ 'User-Agent' = 'vanish-dzr-probe' } -TimeoutSec 60
        $tag = [string]$rel.tag_name
    } catch {
        Say "Could not resolve the latest release tag ($($_.Exception.Message)); falling back to master."
    }

    $zipUrl = if ($tag) {
        "https://codeload.github.com/bleachbit/bleachbit/zip/refs/tags/$tag"
    } else {
        'https://codeload.github.com/bleachbit/bleachbit/zip/refs/heads/master'
    }

    $zip = Join-Path $env:TEMP 'bleachbit-src.zip'
    $dst = Join-Path $env:TEMP 'bleachbit-src'
    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300
        if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $dst -Force
        $found = Get-ChildItem -LiteralPath $dst -Recurse -Directory -Filter 'cleaners' -ErrorAction SilentlyContinue |
                 Where-Object { @(Get-ChildItem -LiteralPath $_.FullName -Filter '*.xml' -File -ErrorAction SilentlyContinue).Count -gt 0 } |
                 Select-Object -First 1
        if ($found) {
            $cleaners = $found.FullName
            $corpus = if ($tag) { "the BleachBit source tree at release $tag" } else { "the BleachBit source tree at master (no release tag resolved)" }
        }
    } catch {
        Say "The download failed: $($_.Exception.Message)"
    }
}

if (-not $cleaners) {
    Say ""
    Say "**STOPPED: no CleanerML definitions could be obtained.** Nothing below"
    Say "ran. This is the probe's premise and it is reported as a premise failure"
    Say "rather than as an empty result - an empty result here would read as"
    Say "'the reader handled everything', which is the opposite of what happened."
    exit 1
}
Say ""
Say "**Corpus: $corpus.**"

$xmlCount = @(Get-ChildItem -LiteralPath $cleaners -Filter '*.xml' -File -ErrorAction SilentlyContinue).Count
Say "Definitions at ``$cleaners`` - $xmlCount file(s)."
Say ""

# ---------------------------------------------------------------------------
Say "## The scan"
Say ""

# Through the engine as a SUBPROCESS, the way the app calls it, so this measures
# the shipped path rather than a dot-sourced approximation of it.
$json = @{ cleaner = 'definitions'; definitionsPath = $cleaners } | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))

# NO 2>&1 ON THE ENGINE, and $ErrorActionPreference relaxed across the call.
#
# PS 5.1 wraps every stderr line from a native executable in an ErrorRecord;
# under 'Stop' that throws, and the engine writes a progress record to stderr
# for every definition file it reads. The first run of this probe died on its
# own progress output, having successfully downloaded 104 files - which is the
# most annoying possible place to fail, and is documented as a trap in this
# repository's own tooling notes.
#
# Only stdout is wanted anyway: the JSON answer is there, the progress is not.
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $raw = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $engine `
            -Action 'cleaner-scan' -ParamsBase64 $b64) | Out-String
} finally {
    $ErrorActionPreference = $prevEap
}
$clock.Stop()

# The engine writes progress records to stderr; the JSON is the last line that
# parses. Reported rather than assumed, because "could not parse the engine's
# answer" and "the engine found nothing" must not look the same.
$res = $null
$parseError = ''
try {
    $body = ($raw -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if ($body) { $res = $body | ConvertFrom-Json }
} catch { $parseError = $_.Exception.Message }

if (-not $res) {
    Say "**The engine's answer could not be parsed.** ($parseError)"
    Say ""
    Say '```'
    Say ($raw.Trim() | Select-Object -First 4000)
    Say '```'
    exit 1
}

Say ("**Wall time: {0:N1} s** for {1} definition file(s)." -f $clock.Elapsed.TotalSeconds, $xmlCount)
Say ""
Say "| | |"
Say "|---|---|"
Say "| state | ``$($res.state)`` |"
Say "| complete | ``$($res.complete)`` |"
Say "| files read | $($res.filesRead) |"
Say "| options read | $($res.optionsRead) |"
Say "| findings offered | $(@($res.findings).Count) |"
Say "| options that matched NOTHING | $($res.optionsNoMatch) |"
Say "| options WITHHELD (unsupported instruction) | $($res.withheldCount) |"
Say "| options blocked (application running) | $($res.blockedCount) |"
Say "| options over the match cap | $($res.tooLargeCount) |"
Say "| files that could not be parsed | $($res.unreadableCount) |"
Say "| definitions for another OS | $($res.otherOsCount) |"
Say ""

# ---------------------------------------------------------------------------
Say "## 1. Variable coverage"
Say ""
Say "Our expansion handles ``~``, ``\$foo``, ``\${foo}``, ``%foo%``, ``\$\$foo\$\$`` and the"
Say "BleachBit pseudo-variables we know about. A definition using one we do not"
Say "know resolves to nothing and its option silently does not appear."
Say ""
$read = [int]$res.optionsRead
$none = [int]$res.optionsNoMatch
if ($read -gt 0) {
    Say ("$none of $read options ({0:N0}%) matched nothing on this machine." -f (100.0 * $none / $read))
} else {
    Say "No options were read at all, which is itself the finding."
}
Say ""
Say "READ THIS CAREFULLY rather than as a score. A zero-match option is not"
Say "evidence of a missing variable on its own - most of these rules are for"
Say "software that is not installed here, and a fresh VM has almost nothing on"
Say "it. What it bounds is the SIZE of the question: anything unexplained is in"
Say "this number, and nothing unexplained is outside it."
Say ""

# ---------------------------------------------------------------------------
Say "## 2. The withheld list"
Say ""
Say "Most real definitions use ``sqlite.vacuum``, ``json`` or ``winreg`` somewhere."
Say "Vanish only performs deletions, because the vault can undo those."
Say ""
if ([int]$res.withheldCount -gt 0 -and $read -gt 0) {
    Say ("$($res.withheldCount) of $read options were not offered ({0:N0}%)." -f (100.0 * [int]$res.withheldCount / $read))
    Say ""
    # Grouped by the reason rather than listed one per line: three hundred lines
    # of "uses command 'json'" is not a finding, "212 options use json" is.
    $reasons = @{}
    foreach ($w in @($res.withheld)) {
        $m = [regex]::Match([string]$w, '\(uses (.+)\)$')
        $key = if ($m.Success) { $m.Groups[1].Value } else { 'unstated' }
        if (-not $reasons.ContainsKey($key)) { $reasons[$key] = 0 }
        $reasons[$key]++
    }
    Say "| instruction | options withheld |"
    Say "|---|---|"
    foreach ($k in ($reasons.Keys | Sort-Object { -$reasons[$_] })) {
        Say "| ``$k`` | $($reasons[$k]) |"
    }
    Say ""
    $pct = 100.0 * [int]$res.withheldCount / $read
    if ($pct -ge 50) {
        Say "**MORE THAN HALF the catalogue is not offered.** That is the honest"
        Say "conclusion bd dzr asked for: this feature reaches less of BleachBit's"
        Say "rules than the UI implies, and docs/PRE-RELEASE.md should say so"
        Say "rather than leaving the impression that pointing Vanish at a"
        Say "definitions folder gets you BleachBit."
    }
} else {
    Say "Nothing was withheld, which would be surprising against the real"
    Say "catalogue - check that the definitions actually parsed."
}
Say ""

# ---------------------------------------------------------------------------
Say "## 3. Scale"
Say ""
Say "The per-option match cap exists because a vault entry too large to review"
Say "is not a vault entry anybody would restore. A browser cache should exceed it."
Say ""
if ([int]$res.tooLargeCount -gt 0) {
    Say "$($res.tooLargeCount) option(s) were refused for size, and each is named:"
    Say ""
    foreach ($t in @($res.tooLarge)) { Say "- $t" }
    Say ""
    Say "Each carries its own number, so the refusal reads as a refusal rather"
    Say "than as an empty section - which is the thing being checked here."
} else {
    Say "Nothing hit the cap. On a fresh VM with no browser history that is the"
    Say "expected result and NOT evidence the cap works - re-run on a machine"
    Say "with a real browser profile to exercise it."
}
Say ""

# ---------------------------------------------------------------------------
Say "## 4. Time"
Say ""
Say ("{0:N1} s for {1} files." -f $clock.Elapsed.TotalSeconds, $xmlCount)
if ($xmlCount -gt 0) {
    Say ("{0:N0} ms per definition file." -f (1000.0 * $clock.Elapsed.TotalSeconds / $xmlCount))
}
Say ""
Say "Every ``walk.*`` action is a recursive enumeration, so this scales with what"
Say "is on the disk rather than with the number of rules. A fresh VM is the"
Say "FAST case and the number on a real machine will be larger."
Say ""

# ---------------------------------------------------------------------------
Say "## The note the user would actually see"
Say ""
Say '```'
Say ([string]$res.note)
Say '```'
Say ""
Say "---"
Say ""
Say "Read-only. Nothing was quarantined, and the removal half was not exercised."

Write-Host ''
Write-Host "Report written to $report" -ForegroundColor Green
