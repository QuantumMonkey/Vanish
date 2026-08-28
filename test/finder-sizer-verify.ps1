# The shared directory sizer must give the OLD answer, faster (lhf).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\finder-sizer-verify.ps1
#
# WHY THIS EXISTS. Six near-identical copies of "sum the bytes under a path"
# lived across the finders, four of them byte-for-byte identical, and every one
# was Get-ChildItem -Recurse -File -Force plus a loop over .Length. Profiled on
# a real machine on 2026-08-28 that cost 59.6 SECONDS in redirect-variables to
# examine five things and 52.2 in reclaim-package-caches to examine three.
#
# They were replaced by one memoised sizer over DirectoryInfo.EnumerateFiles.
# That is a performance change to code whose output feeds a size shown to a
# person and a cost class used to rank what they might delete, so the only thing
# that makes it legitimate is that the ANSWER did not move. Every assertion here
# compares the new sizer against the exact expression it replaced, on trees
# built for the purpose.
#
# THE MEMO IS TESTED AS A MEMO, not just as a cache that happens to return the
# right number. A memo you cannot prove is running is indistinguishable from a
# slow function, and a memo you cannot prove CLEARS is a bug that reports the
# disk as it was before the operator changed it.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'finders\_contract.ps1')

$script:pass = 0
$script:fail = 0
function Assert-True {
    param([bool]$condition, [string]$label, [string]$detail = '')
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        if ($detail) { Write-Host "        $detail" -ForegroundColor DarkYellow }
        $script:fail++
    }
}

# The exact expression the shared sizer replaced, kept here so the comparison is
# against the old behaviour rather than against a number typed by hand.
function Measure-TheOldWay {
    param([string]$path)
    $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue)
    $sum = 0L
    foreach ($f in $files) { $sum += [long]$f.Length }
    return @{ bytes = $sum; count = $files.Count }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("vanish-sizer-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))

Write-Host ''
Write-Host 'Shared finder sizer (lhf)'
Write-Host '========================='

try {
    # A tree with depth, a zero-byte file, a large-ish file, and a hidden one:
    # -Force is in the old expression, so a hidden file MUST be counted or the
    # new sizer silently under-reports on any profile containing dotfiles.
    $null = New-Item -ItemType Directory -Path (Join-Path $work 'a\b\c') -Force
    Set-Content -LiteralPath (Join-Path $work 'root.txt') -Value ('x' * 100) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $work 'a\one.txt') -Value ('y' * 250) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $work 'a\b\two.bin') -Value ('z' * 4096) -Encoding ASCII -NoNewline
    Set-Content -LiteralPath (Join-Path $work 'a\b\c\empty.txt') -Value '' -Encoding ASCII -NoNewline
    $hidden = Join-Path $work 'a\.hidden'
    Set-Content -LiteralPath $hidden -Value ('h' * 77) -Encoding ASCII -NoNewline
    (Get-Item -LiteralPath $hidden -Force).Attributes = 'Hidden'

    Write-Host ''
    Write-Host 'The answer did not move'

    $old = Measure-TheOldWay -path $work
    $new = Measure-FinderPathBytes -path $work

    Assert-True ($new.bytes -eq $old.bytes) `
        "byte total matches the expression it replaced ($($new.bytes) vs $($old.bytes))"
    Assert-True ($new.fileCount -eq $old.count) `
        "file count matches too ($($new.fileCount) vs $($old.count)) - a total that matches with a different count would be luck"
    Assert-True ($old.count -eq 5) "the fixture really has five files, hidden one included ($($old.count))"
    Assert-True ($new.existed -eq $true -and $new.isFile -eq $false) 'a directory reports existed, not isFile'
    Assert-True ($new.hadError -eq $false -and @($new.unreadable).Count -eq 0) 'a fully readable tree reports nothing unreadable'

    Write-Host ''
    Write-Host 'A file, and a path that is not there at all'

    Clear-FinderSizeCache
    $f = Measure-FinderPathBytes -path (Join-Path $work 'root.txt')
    Assert-True ($f.isFile -eq $true -and $f.bytes -eq 100 -and $f.fileCount -eq 1) `
        "a file reports its own length ($($f.bytes) bytes, isFile=$($f.isFile))"

    $missing = Measure-FinderPathBytes -path (Join-Path $work 'no-such-thing')
    Assert-True ($missing.existed -eq $false) 'a path that does not exist reports existed=$false'
    Assert-True ($missing.bytes -eq 0 -and $missing.hadError -eq $false) `
        'and is NOT an error - "the tool has never run here" is evidence, not a failure'

    $blank = Measure-FinderPathBytes -path ''
    Assert-True ($blank.existed -eq $false -and $blank.bytes -eq 0) 'an empty path is answered rather than thrown'

    Write-Host ''
    Write-Host 'The memo is real, and it clears'

    # Proven by CHANGING THE DISK between two calls. If the second call returns
    # the new size, there was no memo; if it returns the old one, there is. This
    # is the only way to test a cache that does not require timing it.
    Clear-FinderSizeCache
    $before = Measure-FinderPathBytes -path $work
    Set-Content -LiteralPath (Join-Path $work 'a\b\c\added.txt') -Value ('q' * 1000) -Encoding ASCII -NoNewline
    $cached = Measure-FinderPathBytes -path $work

    Assert-True ($cached.bytes -eq $before.bytes) `
        "a second call for the same path does NOT re-walk - it returned the memoised $($cached.bytes), not the new size on disk"

    Clear-FinderSizeCache
    $fresh = Measure-FinderPathBytes -path $work
    Assert-True ($fresh.bytes -eq ($before.bytes + 1000)) `
        "and Clear-FinderSizeCache really clears - after it the same path reports the new $($fresh.bytes)"
    Assert-True ($fresh.bytes -eq (Measure-TheOldWay -path $work).bytes) `
        'the refreshed answer still matches the old expression'

    # Trailing separators are a real caller pattern (paths built with Join-Path
    # from environment variables often carry one) and two cache entries for one
    # directory would silently halve the win this whole change exists for.
    Clear-FinderSizeCache
    $withSlash = Measure-FinderPathBytes -path ($work + '\')
    Set-Content -LiteralPath (Join-Path $work 'a\b\c\again.txt') -Value ('w' * 500) -Encoding ASCII -NoNewline
    $withoutSlash = Measure-FinderPathBytes -path $work
    Assert-True ($withoutSlash.bytes -eq $withSlash.bytes) `
        "'C:\X\' and 'C:\X' are ONE cache entry, not two ($($withSlash.bytes) vs $($withoutSlash.bytes))"

    Write-Host ''
    Write-Host 'A junction is not part of this subtree'

    Clear-FinderSizeCache
    $target = Join-Path $work 'link-target'
    $null = New-Item -ItemType Directory -Path $target -Force
    Set-Content -LiteralPath (Join-Path $target 'big.bin') -Value ('j' * 9999) -Encoding ASCII -NoNewline
    $linkParent = Join-Path $work 'a\b'
    $link = Join-Path $linkParent 'the-link'

    $madeLink = $false
    try {
        $null = & cmd.exe /c mklink /J "$link" "$target" 2>&1
        $madeLink = Test-Path -LiteralPath $link
    } catch { $madeLink = $false }

    if (-not $madeLink) {
        Write-Host '  SKIP  junction handling - mklink /J did not succeed on this machine, so there is no junction to not-follow' -ForegroundColor Yellow
    } else {
        Clear-FinderSizeCache
        $walked = Measure-FinderPathBytes -path (Join-Path $work 'a')
        Clear-FinderSizeCache
        $direct = Measure-FinderPathBytes -path $target
        # The target holds 9999 bytes in a single file, and everything else
        # under 'a' is small. So "did the walk follow the junction" is answered
        # by one comparison rather than by an arithmetic identity that would
        # also hold for the wrong reason.
        Assert-True ($direct.bytes -ge 9999) "the junction's target really does hold bytes ($($direct.bytes))"
        Assert-True ($walked.bytes -lt 9999) `
            "walking the parent does not count the junction target - a junction is a second name for somewhere else, and following one double-counts (parent measured $($walked.bytes), target alone is $($direct.bytes))"
    }

    Write-Host ''
    Write-Host 'A partial walk returns the partial sum AND names what it could not read'

    # Constructed rather than assumed: if the deny ACE does not actually block
    # this account (it does not for an elevated one), the assertion is SKIPPED
    # with that reason. A "0 unreadable" pass on a directory we could read
    # perfectly well would be a pass about nothing.
    Clear-FinderSizeCache
    $locked = Join-Path $work 'a\locked'
    $null = New-Item -ItemType Directory -Path $locked -Force
    Set-Content -LiteralPath (Join-Path $locked 'secret.txt') -Value ('s' * 321) -Encoding ASCII -NoNewline
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $null = & icacls.exe "$locked" /deny "${me}:(OI)(CI)(RX)" /C /Q 2>&1

    $reallyBlocked = $false
    try {
        $null = [System.IO.DirectoryInfo]::new($locked).EnumerateFiles() | Select-Object -First 1
    } catch { $reallyBlocked = $true }

    if (-not $reallyBlocked) {
        Write-Host '  SKIP  the partial-walk case - the deny ACE did not block this account (normal for an elevated session), so nothing here is genuinely unreadable' -ForegroundColor Yellow
    } else {
        Clear-FinderSizeCache
        $partial = Measure-FinderPathBytes -path (Join-Path $work 'a')
        Assert-True ($partial.hadError -eq $true) 'an unreadable subdirectory sets hadError'
        Assert-True (@($partial.unreadable) -contains $locked) `
            'and names the directory BY PATH - "10 errors" is not actionable, "this directory" is' `
            ("got: " + (@($partial.unreadable) -join ', '))
        Assert-True ($partial.bytes -gt 0) `
            'the partial sum is still returned rather than zero - an under-count is a safer lie than an invented one'
        Assert-True ($partial.detail -ne '') 'and the real exception message is carried, not a bare boolean'
    }
    $null = & icacls.exe "$locked" /remove:d "$me" /C /Q 2>&1
}
finally {
    if (Test-Path -LiteralPath $work) {
        $null = & icacls.exe "$work" /reset /T /C /Q 2>&1
        # Junctions first: Remove-Item -Recurse on a junction can follow it.
        Get-ChildItem -LiteralPath $work -Recurse -Force -Directory -ErrorAction SilentlyContinue |
            Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } |
            ForEach-Object { & cmd.exe /c rmdir "$($_.FullName)" 2>&1 | Out-Null }
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { 'Red' } else { 'Green' })
if ($script:fail -gt 0) { exit 1 }
