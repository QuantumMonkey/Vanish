# qkgu: a System Clean sweep that was REFUSED must not read as a clean machine.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\cleaner-blindspot-verify.ps1
#
# Runs in either tier. Everything here is read-only, and the one thing it
# creates is a temp folder with a deliberately malformed file in it.
#
# WHAT WAS WRONG. The seven system cleaners predate finders/_contract.ps1
# entirely, so they never got its third state. Every branch of
# Invoke-CleanerScan wrote `success = $true` as a literal, and underneath, the
# registry helpers ended in `catch { return @() }`. That catch is where the
# evidence died: OpenSubKey RETURNS $null when a key is not there and THROWS
# when the key is there and you are not allowed to read it - opposite facts,
# and both were being turned into an empty list. The panel's only test was
# `findings.length === 0`, which drew a green tick and the words "Nothing left
# behind here."
#
# So: an ACL on one registry key, or a pnputil that did not run, told the user
# their machine was clean. That is aeu's defect class - a two-state answer
# covering a three-state world - on a screen with a quarantine button.
#
# THE PREMISE THIS SUITE NEEDS, and it states it rather than assuming it: the
# helpers must be able to read SOMETHING, or "no blind spots" would pass
# vacuously on a machine where every read failed.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scanner.ps1')

$script:pass = 0
$script:fail = 0

function Assert-True($condition, $label, $detail = '') {
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
        $script:fail++
    }
}

Write-Host ""
Write-Host "System Clean blind spots (qkgu)"
Write-Host "==============================="

# ======================================================================
Write-Host ""
Write-Host "A denied read and an absent key are not the same fact" -ForegroundColor Cyan

# PREMISE FIRST. A key that certainly exists and is certainly readable by
# everyone. Without this, every "0 subkeys" result below could mean the helper
# is simply broken, and the whole section would pass while proving nothing.
Start-BlindSpotCapture
$readable = @(Get-RegistrySubKeyNamesInView -hive 'LocalMachine' -subKey 'SOFTWARE\Microsoft\Windows\CurrentVersion' -view 'Registry64')
$premiseBlind = Stop-BlindSpotCapture
Assert-True ($readable.Count -gt 0) `
    "premise: the helper reads a key it is allowed to read ($($readable.Count) subkeys)"
Assert-True ($premiseBlind.items.Count -eq 0) `
    "and a successful read records no blind spot, so the channel is not simply always-on"

# HKLM\SECURITY is on every Windows installation and is denied even to
# Administrators by default - the ACL grants SYSTEM only. It is the one place
# a test can find a real refusal without creating one.
Start-BlindSpotCapture
$denied = @(Get-RegistrySubKeyNamesInView -hive 'LocalMachine' -subKey 'SECURITY' -view 'Registry64')
$deniedBlind = Stop-BlindSpotCapture

Start-BlindSpotCapture
$absent = @(Get-RegistrySubKeyNamesInView -hive 'LocalMachine' -subKey 'SOFTWARE\NoSuchVanishKey0dc41f' -view 'Registry64')
$absentBlind = Stop-BlindSpotCapture

# THE LINE THAT NAMES THE DEFECT. Both return nothing. Before this change that
# was the ENTIRE observable difference between them, which is to say there was
# none, and "nothing" is what authorises a delete.
Assert-True ($denied.Count -eq 0 -and $absent.Count -eq 0) `
    "both a denied key and an absent one return an empty list - the observable result is identical"
Assert-True ($deniedBlind.items.Count -eq 1) `
    "the DENIED one records a blind spot ($($deniedBlind.items.Count))" `
    (($deniedBlind.items | ForEach-Object { $_.path }) -join ', ')
Assert-True ($absentBlind.items.Count -eq 0) `
    "the ABSENT one records none - a key that is not there is an answer, not a failure"
Assert-True ($deniedBlind.items.Count -gt 0 -and $deniedBlind.items[0].reason -eq 'key-denied') `
    "and the reason is named, because '4 errors' is not actionable and 'access denied on HKLM\SECURITY' is"
Assert-True ($deniedBlind.items.Count -gt 0 -and $deniedBlind.items[0].path -like 'HKLM*SECURITY') `
    "with the path Windows would show, not an internal one" `
    ($deniedBlind.items[0].path)

# ======================================================================
Write-Host ""
Write-Host "The channel is off unless something opts in" -ForegroundColor Cyan

# Every other engine action - list-desktop, the scans, the purges - calls these
# same helpers. If the channel collected all the time it would be a growing
# list nobody reads, and a per-process leak between actions.
Add-BlindSpot -path 'should-not-be-recorded' -reason 'test'
Start-BlindSpotCapture
$leaked = Stop-BlindSpotCapture
Assert-True ($leaked.items.Count -eq 0) `
    "a record made while nobody was collecting does not appear in the next capture"

# ======================================================================
Write-Host ""
Write-Host "The cap and the de-duplication are enforced, not described" -ForegroundColor Cyan

Start-BlindSpotCapture
for ($i = 0; $i -lt 60; $i++) { Add-BlindSpot -path 'HKLM\Same\Key' -reason 'key-denied' }
$deduped = Stop-BlindSpotCapture
Assert-True ($deduped.items.Count -eq 1) `
    "one denied key hit sixty times is one row, not sixty ($($deduped.items.Count))"
Assert-True ($deduped.dropped -eq 0) `
    "and de-duplication is not counted as dropping - nothing was lost"

Start-BlindSpotCapture
for ($i = 0; $i -lt 500; $i++) { Add-BlindSpot -path "HKLM\Key$i" -reason 'key-denied' }
$capped = Stop-BlindSpotCapture
Assert-True ($capped.items.Count -eq 200) `
    "500 distinct denials are capped at 200 IN THE LOOP, not in a comment above it ($($capped.items.Count))"
Assert-True ($capped.dropped -eq 300) `
    "and the remainder is COUNTED ($($capped.dropped)) - 'and 300 more' is a different sentence from showing 200 and implying that was all"

# ======================================================================
Write-Host ""
Write-Host "Through the real dispatcher, on real production code" -ForegroundColor Cyan

# The definitions cleaner is the one whose blind spots can be created without
# touching the machine: a malformed definition file is a rule that did not run,
# and Find-CleanerMlFindings already knew that - it counted them in a sentence
# of prose inside the note, where nothing downstream could act on it, and
# returned success either way.
$work = Join-Path $env:TEMP ("vanish-qkgu-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    Set-Content -LiteralPath (Join-Path $work 'broken.xml') -Value '<cleaner id="x"><this is not xml' -Encoding UTF8

    $res = Invoke-CleanerScan -p ([pscustomobject]@{ cleaner = 'definitions'; definitionsPath = $work })

    Assert-True ($res.success -eq $true) `
        "the scan itself completed - this is NOT the failure case, which is the whole point"
    Assert-True ($res.findingCount -eq 0) `
        "it found nothing, exactly as it did before this change ($($res.findingCount))"
    Assert-True ($res.state -eq 'could-not-look') `
        "and the state is could-not-look, not nothing - the two used to be the same answer" `
        "state=$($res.state)"
    Assert-True ($res.complete -eq $false) `
        "complete is false, so a caller that only wants a boolean still cannot mistake this for clean"
    Assert-True ($res.unreadableCount -eq 1) `
        "the file that could not be parsed travels as a record, not only as prose in the note ($($res.unreadableCount))"
    Assert-True (@($res.unreadable)[0].path -like '*broken.xml*') `
        "naming the file" ((@($res.unreadable)[0]).path)

    # AND THE OTHER HALF, which is the one that makes this change safe rather
    # than merely loud: an empty folder is a real, trustworthy empty result.
    # A change that turned every quiet scan into a warning would be worse than
    # the defect - it would train the operator to ignore the warning.
    $emptyDir = Join-Path $work 'empty'
    New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
    $clean = Invoke-CleanerScan -p ([pscustomobject]@{ cleaner = 'definitions'; definitionsPath = $emptyDir })
    Assert-True ($clean.success -eq $true -and $clean.state -eq 'nothing') `
        "a folder with nothing wrong in it is still 'nothing' - no false alarm" `
        "state=$($clean.state) unreadable=$($clean.unreadableCount)"
    Assert-True ($clean.complete -eq $true) `
        "and complete, so the green tick is still reachable when it is earned"
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

$unknown = Invoke-CleanerScan -p ([pscustomobject]@{ cleaner = 'no-such-cleaner' })
Assert-True ($unknown.success -eq $false -and $unknown.state -eq 'failed') `
    "a cleaner that does not exist is 'failed' - a sweep that never ran is not a sweep that found nothing" `
    "state=$($unknown.state)"

# ======================================================================
Write-Host ""
Write-Host "A folder nobody could measure is not an empty folder" -ForegroundColor Cyan

# The same defect one layer down, and the one with the worst wording. Three
# different facts - the path is gone, the walk was refused, the folder really
# is empty - all returned 0, and Format-ByteSize turns 0 into the literal word
# "empty". So an unreadable folder was labelled EMPTY inside the evidence
# sentence next to a removal offer.
$sizeWork = Join-Path $env:TEMP ("vanish-qkgu-size-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $sizeWork | Out-Null
try {
    Assert-True ((Get-FolderSize $sizeWork) -eq 0) `
        "a genuinely empty folder measures 0 - still a number, because it is still a measurement"
    Assert-True ((Format-ByteSize (Get-FolderSize $sizeWork)) -eq 'empty') `
        "and reads as 'empty', which is true"

    Set-Content -LiteralPath (Join-Path $sizeWork 'a.bin') -Value ('x' * 4096) -Encoding Ascii
    $measured = Get-FolderSize $sizeWork
    Assert-True ($measured -gt 0) "a folder with a file in it measures more than nothing ($measured)"

    Assert-True ($null -eq (Get-FolderSize (Join-Path $sizeWork 'no-such-child'))) `
        "a path that is not there measures `$null, not 0"
    Assert-True ((Format-ByteSize (Get-FolderSize (Join-Path $sizeWork 'no-such-child'))) -eq 'size unknown') `
        "and reads as 'size unknown' rather than 'empty'"
}
finally {
    Remove-Item -LiteralPath $sizeWork -Recurse -Force -ErrorAction SilentlyContinue
}

# NOT COVERED HERE, and said out loud rather than faked.
#
# The remaining branch is "the walk hit errors AND summed nothing", which is the
# case -ErrorAction SilentlyContinue was hiding: per-file denials that never
# throw. The obvious candidate is C:\System Volume Information - present on
# every Windows installation, ACL granting SYSTEM only.
#
# It cannot be asserted deterministically, and this is the corrected version of
# an assertion that DID pass standing alone and then failed in the full run. Two
# reasons, either one fatal: an elevated token reads through that ACL (half a
# dozen suites in this repository already skip their own could-not-look cases
# for exactly that reason), and even when part of it is refused, a recursive
# walk still SUMS whatever happens to be readable at that moment - which for the
# shadow store changes between runs. A partial sum is a number, so the function
# correctly returns a number, and the test correctly fails. Probing the premise
# does not help: the only honest premise is the function's own condition, which
# makes the check circular.
#
# So the branch is exercised in the unelevated tier by the cleaners themselves,
# and what is asserted here is the RULE, which does not depend on whose token is
# running.
Assert-True ($null -eq (Get-FolderSize ([Guid]::NewGuid().ToString('N')))) `
    "a path that cannot be walked measures `$null in either tier"
Assert-True ((Format-ByteSize (Get-FolderSize ([Guid]::NewGuid().ToString('N')))) -ne 'empty') `
    "and is never labelled 'empty' - it was, before this, inside an evidence sentence beside a removal offer"

# The typed-parameter trap that would have made the whole fix invisible.
Assert-True ((Format-ByteSize $null) -eq 'size unknown') `
    "Format-ByteSize takes `$null as `$null - a [long] parameter would coerce it to 0 and print 'empty' again, silently"

# ======================================================================
Write-Host ""
Write-Host "The invariant, across every cleaner this machine can run" -ForegroundColor Cyan

# Counts are machine-specific and asserting them would make this a machine
# test. The RULE is not machine-specific: 'nothing' is the only state a caller
# may treat as clean, so 'nothing' must never be returned while holding a blind
# spot. There is no code path that produces that pair, and this is the
# assertion that says so out loud.
foreach ($id in @('context-menus', 'services', 'drivers', 'path', 'installer-cache', 'firewall-rules', 'dead-references', 'associations')) {
    $r = Invoke-CleanerScan -p ([pscustomobject]@{ cleaner = $id }) 6> $null
    $stateOk = @('found', 'nothing', 'could-not-look', 'failed') -contains $r.state
    $pairOk = -not ($r.state -eq 'nothing' -and $r.unreadableCount -gt 0)
    $completeOk = ($r.complete -eq $true) -eq ($r.unreadableCount -eq 0 -and $r.success -eq $true)
    Assert-True ($stateOk -and $pairOk -and $completeOk) `
        "$id : state '$($r.state)' with $($r.findingCount) finding(s) and $($r.unreadableCount) blind spot(s) is a consistent pair"
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
