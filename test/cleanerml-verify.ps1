# CleanerML reader (7sl). Read-only in both tiers.
#
# Vanish does not write cleaning rules. It reads other people's - BleachBit's
# CleanerML definitions - and runs them through the vault, which is the one
# thing nobody else in this category offers. That makes the READER the
# load-bearing part: every claim this feature makes about what would be removed
# comes out of the parsing, the variable expansion and the search modes below,
# and a misread rule is a deletion the user did not ask for.
#
# So the suite tests those three separately through the cleanerml-probe hook
# rather than only through a whole scan. A scan that returns nothing is
# indistinguishable from a scan that resolved every path wrongly, and this
# codebase has shipped that exact confusion more than once.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\cleanerml-verify.ps1

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root "scanner.ps1"

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params = @{})
    $json = $params | ConvertTo-Json -Depth 8 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    # 8ok: stdout is supposed to carry one JSON document and nothing else, but
    # powershell.exe writes the WARNING, VERBOSE and DEBUG streams to STDOUT -
    # only errors go to stderr. Report what actually arrived rather than dying
    # on a raw parser exception with no Result line.
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json }
    catch {
        $head = if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text }
        throw "Engine output for '$action' was not JSON: $($_.Exception.Message)`nOutput began: $head"
    }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish CleanerML reader verification (7sl)" -ForegroundColor Cyan
Write-Host "=========================================="
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

# ======================================================================
# Fixtures. The definitions below are written HERE, by this test, and are
# MIT like the rest of this repository. No CleanerML definition file is
# vendored into this tree - BleachBit's are GPL-3.0+ and this repo is MIT
# and public, which is the whole reason the product reads them from where
# the user already has them instead of shipping them.
# ======================================================================
$work    = Join-Path $env:TEMP "vanish-cleanerml-verify"
$defs    = Join-Path $work "definitions"
$empty   = Join-Path $work "definitions-empty"
$data    = Join-Path $work "data"

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $defs  -Force
$null = New-Item -ItemType Directory -Path $empty -Force
$null = New-Item -ItemType Directory -Path (Join-Path $data "cache\sub") -Force

Set-Content -LiteralPath (Join-Path $data "cache\a.txt")     -Value ("a" * 100) -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "cache\b.log")     -Value ("b" * 200) -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "cache\sub\c.txt") -Value ("c" * 300) -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "single.txt")      -Value "single"    -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "glob1.tmp")       -Value "one"       -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "glob2.tmp")       -Value "two"       -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "keep.txt")        -Value "keep"      -Encoding ASCII
Set-Content -LiteralPath (Join-Path $data "secret.txt")      -Value "VANISH-XXE-CANARY" -Encoding ASCII

# The definitions reference the fixture tree through a real environment
# variable, so the variable expansion under test is the same code path a real
# definition uses rather than a literal path the test hard-coded.
$env:VANISH_CML_TEST = $data

Set-Content -LiteralPath (Join-Path $defs "good.xml") -Encoding UTF8 -Value @'
<?xml version="1.0" encoding="UTF-8"?>
<cleaner id="vanishtest">
  <label>Vanish Test App</label>
  <description>Fixture written by test/cleanerml-verify.ps1</description>
  <option id="cache">
    <label>Cache</label>
    <description>Files under the cache directory</description>
    <action command="delete" search="walk.files" path="%VANISH_CML_TEST%\cache"/>
  </option>
  <option id="single">
    <label>One file</label>
    <action command="delete" search="file" path="%VANISH_CML_TEST%\single.txt"/>
  </option>
  <option id="globs">
    <label>Temporary files</label>
    <action command="delete" search="glob" path="%VANISH_CML_TEST%\*.tmp"/>
  </option>
</cleaner>
'@

Set-Content -LiteralPath (Join-Path $defs "warned.xml") -Encoding UTF8 -Value @'
<?xml version="1.0" encoding="UTF-8"?>
<cleaner id="vanishwarned">
  <label>Warned App</label>
  <option id="risky">
    <label>Saved data</label>
    <warning>This removes saved logins.</warning>
    <action command="delete" search="file" path="%VANISH_CML_TEST%\keep.txt"/>
  </option>
</cleaner>
'@

Set-Content -LiteralPath (Join-Path $defs "unsupported.xml") -Encoding UTF8 -Value @'
<?xml version="1.0" encoding="UTF-8"?>
<cleaner id="vanishunsupported">
  <label>Unsupported App</label>
  <option id="vacuum">
    <label>Compact databases</label>
    <action command="delete" search="file" path="%VANISH_CML_TEST%\keep.txt"/>
    <action command="sqlite.vacuum" search="file" path="%VANISH_CML_TEST%\keep.txt"/>
  </option>
  <option id="deepscan">
    <label>Scattered files</label>
    <action command="delete" search="deep" path="%VANISH_CML_TEST%"/>
  </option>
</cleaner>
'@

Set-Content -LiteralPath (Join-Path $defs "linux.xml") -Encoding UTF8 -Value @'
<?xml version="1.0" encoding="UTF-8"?>
<cleaner id="vanishlinux" os="linux">
  <label>Linux Only</label>
  <option id="cache">
    <label>Cache</label>
    <action command="delete" search="file" path="~/.cache/thing"/>
  </option>
</cleaner>
'@

Set-Content -LiteralPath (Join-Path $defs "broken.xml") -Encoding UTF8 -Value @'
<?xml version="1.0" encoding="UTF-8"?>
<cleaner id="vanishbroken">
  <label>Never closed
'@

# An external entity pointed at a file on this machine. A parser that resolves
# it turns someone else's definition file into a local file read inside our
# engine, and INV-4 is not satisfied by having no network code of our own if a
# parser will make the call on our behalf.
Set-Content -LiteralPath (Join-Path $defs "xxe.xml") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cleaner [ <!ENTITY canary SYSTEM "file:///$($data -replace '\\', '/')/secret.txt"> ]>
<cleaner id="vanishxxe">
  <label>&canary;</label>
  <option id="x">
    <label>Anything</label>
    <action command="delete" search="file" path="%VANISH_CML_TEST%\keep.txt"/>
  </option>
</cleaner>
"@

try {
    # ==================================================================
    # Variable expansion. Every form in the spec, plus the one deliberate
    # deviation from it.
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.1 path variable expansion" -ForegroundColor Cyan

    function Expand-Probe {
        param([string]$path)
        return @((Invoke-Engine "cleanerml-probe" @{ mode = "expand"; path = $path }).paths)
    }

    $windowsStyle = @(Expand-Probe '%LOCALAPPDATA%\Vanish')
    Assert-True ($windowsStyle.Count -eq 1 -and $windowsStyle[0] -eq (Join-Path $env:LOCALAPPDATA 'Vanish')) "%NAME% expands to the environment value"

    # The spec calls $foo case-SENSITIVE. Real definitions write $localappdata
    # in lower case and Windows environment variables are case-insensitive by
    # OS design, so a literal reading of the spec would resolve nothing on
    # exactly the files people have. This asserts the deviation on purpose.
    $lower = @(Expand-Probe '$localappdata\Vanish')
    Assert-True ($lower.Count -eq 1 -and $lower[0] -eq (Join-Path $env:LOCALAPPDATA 'Vanish')) "a lower-case `$name resolves too, which the spec says it should not - the deviation is deliberate"

    $braced = @(Expand-Probe '${APPDATA}\Vanish')
    Assert-True ($braced.Count -eq 1 -and $braced[0] -eq (Join-Path $env:APPDATA 'Vanish')) "`${NAME} expands"

    $tilde = @(Expand-Probe '~\Desktop')
    Assert-True ($tilde.Count -eq 1 -and $tilde[0] -eq (Join-Path $env:USERPROFILE 'Desktop')) "~ expands to the profile directory"

    # The one form that changes the NUMBER of paths. Collapsing it to a single
    # string would clean one Program Files tree and report the option as done.
    $multi = @(Expand-Probe '$$ProgramFiles$$\SomeApp')
    $expectedMulti = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | Select-Object -Unique
    Assert-True ($multi.Count -eq $expectedMulti.Count) "`$`$ProgramFiles`$`$ expands to every Program Files tree, not one ($($multi.Count) found)"
    Assert-True (@($multi | Where-Object { $_ -like '*(x86)*' }).Count -gt 0 -or $expectedMulti.Count -eq 1) "and the 32-bit tree is one of them"

    $missing = @(Expand-Probe '%NO_SUCH_VARIABLE_ANYWHERE%\x')
    Assert-True ($missing.Count -eq 0) "an unresolvable variable yields NO path, rather than a literal one that would match nothing and read as clean"

    $pseudo = @(Expand-Probe '%CommonAppData%\Vanish')
    Assert-True ($pseudo.Count -eq 1 -and $pseudo[0] -eq (Join-Path $env:ProgramData 'Vanish')) "a BleachBit-defined variable Windows does not have still resolves"

    # ==================================================================
    # Search modes. The differences between them are the entire risk: read
    # walk.files as walk.top and a directory the definition asked to empty
    # is removed instead.
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.2 search modes" -ForegroundColor Cyan

    function Resolve-Probe {
        param([hashtable]$spec)
        $spec['mode'] = 'resolve'
        if (-not $spec.ContainsKey('command')) { $spec['command'] = 'delete' }
        return (Invoke-Engine "cleanerml-probe" $spec)
    }

    $cacheDir = Join-Path $data "cache"

    $file = Resolve-Probe @{ search = 'file'; path = (Join-Path $data "single.txt") }
    Assert-True (@($file.paths).Count -eq 1) "search=file matches exactly one path"

    $absent = Resolve-Probe @{ search = 'file'; path = (Join-Path $data "not-there.txt") }
    Assert-True (@($absent.paths).Count -eq 0) "search=file on a missing path matches nothing"

    $glob = Resolve-Probe @{ search = 'glob'; path = (Join-Path $data "*.tmp") }
    Assert-True (@($glob.paths).Count -eq 2) "search=glob matches the pattern and only the pattern (2 expected, $(@($glob.paths).Count) found)"
    Assert-True (@($glob.paths | Where-Object { $_ -like '*keep.txt' }).Count -eq 0) "and does not reach a sibling that does not match"

    $walkFiles = Resolve-Probe @{ search = 'walk.files'; path = $cacheDir }
    Assert-True (@($walkFiles.paths).Count -eq 3) "search=walk.files matches every file below the directory (3 expected, $(@($walkFiles.paths).Count) found)"
    Assert-True (@($walkFiles.paths | Where-Object { $_ -eq (Join-Path $cacheDir 'sub') }).Count -eq 0) "and matches NO directory - walk.files leaves the directories standing"
    Assert-True (@($walkFiles.paths | Where-Object { $_ -eq $cacheDir }).Count -eq 0) "and never the top directory itself"

    $walkAll = Resolve-Probe @{ search = 'walk.all'; path = $cacheDir }
    Assert-True (@($walkAll.paths).Count -eq 4) "search=walk.all matches files AND directories below the top (4 expected, $(@($walkAll.paths).Count) found)"
    Assert-True (@($walkAll.paths | Where-Object { $_ -eq $cacheDir }).Count -eq 0) "and still not the top directory - that is what separates it from walk.top"

    $walkTop = Resolve-Probe @{ search = 'walk.top'; path = $cacheDir }
    Assert-True (@($walkTop.paths | Where-Object { $_ -eq $cacheDir }).Count -eq 1) "search=walk.top includes the top directory itself"

    $deep = Resolve-Probe @{ search = 'deep'; path = $data }
    Assert-True ($deep.unsupported -eq "search 'deep'") "search=deep is refused BY NAME, not silently ignored"
    Assert-True (@($deep.paths).Count -eq 0) "and matches nothing"

    $vacuum = Resolve-Probe @{ command = 'sqlite.vacuum'; search = 'file'; path = (Join-Path $data "single.txt") }
    Assert-True ($vacuum.unsupported -eq "command 'sqlite.vacuum'") "a command that mutates a file in place is refused by name - the vault cannot put back an edit"

    # ==================================================================
    # Filters
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.3 regex filters" -ForegroundColor Cyan

    $regex = Resolve-Probe @{ search = 'walk.files'; path = $cacheDir; regex = '\.txt$' }
    Assert-True (@($regex.paths).Count -eq 2) "regex filters on the FILE NAME (2 .txt expected, $(@($regex.paths).Count) found)"

    $nregex = Resolve-Probe @{ search = 'walk.files'; path = $cacheDir; nregex = '\.txt$' }
    Assert-True (@($nregex.paths).Count -eq 1) "nregex is its negation (1 expected, $(@($nregex.paths).Count) found)"

    $whole = Resolve-Probe @{ search = 'walk.files'; path = $cacheDir; wholeregex = 'sub' }
    Assert-True (@($whole.paths).Count -eq 1) "wholeregex filters on the FULL PATH, so a directory name in it counts"

    $nwhole = Resolve-Probe @{ search = 'walk.files'; path = $cacheDir; nwholeregex = 'sub' }
    Assert-True (@($nwhole.paths).Count -eq 2) "nwholeregex is its negation"

    # ==================================================================
    # Path pruning. Not tidiness: the vault MOVES what it is given, and a
    # parent takes its children with it, so a child listed alongside its
    # own parent is a move that cannot happen and a restore that would put
    # the same file back twice.
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.4 pruning paths covered by a parent" -ForegroundColor Cyan

    $compressed = Invoke-Engine "cleanerml-probe" @{
        mode  = 'compress'
        paths = @($cacheDir, (Join-Path $cacheDir "a.txt"), (Join-Path $cacheDir "sub"), (Join-Path $cacheDir "sub\c.txt"))
    }
    Assert-True (@($compressed.paths).Count -eq 1) "a set containing a directory and its descendants collapses to the directory"
    Assert-True (@($compressed.paths)[0] -eq $cacheDir) "and it is the top one that survives"

    $unrelated = Invoke-Engine "cleanerml-probe" @{
        mode  = 'compress'
        paths = @((Join-Path $cacheDir "a.txt"), (Join-Path $cacheDir "b.log"))
    }
    Assert-True (@($unrelated.paths).Count -eq 2) "siblings are all kept - pruning is not de-duplication"

    # ==================================================================
    # Reading a definition file
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.5 reading definition files" -ForegroundColor Cyan

    $good = Invoke-Engine "cleanerml-probe" @{ mode = 'parse'; file = (Join-Path $defs "good.xml") }
    Assert-True ($good.success -eq $true) "a well-formed definition parses"
    Assert-True ($good.id -eq 'vanishtest') "the cleaner id is read"
    Assert-True ($good.label -eq 'Vanish Test App') "the label is read"
    Assert-True (@($good.options).Count -eq 3) "every option is read (3 expected, $(@($good.options).Count) found)"

    $linux = Invoke-Engine "cleanerml-probe" @{ mode = 'parse'; file = (Join-Path $defs "linux.xml") }
    Assert-True ($linux.success -eq $true) "a definition for another operating system is not an error"
    Assert-True ($null -ne $linux.skipped) "it is skipped, with the reason recorded"

    $broken = Invoke-Engine "cleanerml-probe" @{ mode = 'parse'; file = (Join-Path $defs "broken.xml") }
    Assert-True ($broken.success -eq $false) "malformed XML fails"
    Assert-True (-not [string]::IsNullOrWhiteSpace($broken.error)) "and says why"

    $unsupportedDef = Invoke-Engine "cleanerml-probe" @{ mode = 'parse'; file = (Join-Path $defs "unsupported.xml") }
    $vacuumOption = @($unsupportedDef.options | Where-Object { $_.id -eq 'vacuum' })
    Assert-True (@($vacuumOption[0].actions).Count -eq 2) "the reader records actions it will NOT run, rather than dropping them - an option must not look smaller than it is"
    Assert-True (@($vacuumOption[0].actions | Where-Object { $_.unsupported }).Count -eq 1) "and marks exactly the one it cannot execute"

    # ==================================================================
    # The whole scan
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.6 the definitions cleaner end to end" -ForegroundColor Cyan

    $scan = Invoke-Engine "cleaner-scan" @{ cleaner = "definitions"; definitionsPath = $defs }
    Assert-True ($scan.success -eq $true) "the scan completes even though one definition is malformed and one is for another OS"

    $findings = @($scan.findings)
    $ids = @($findings | ForEach-Object { $_.id })

    Assert-True (@($ids | Where-Object { $_ -eq 'cleanerml|vanishtest|cache' }).Count -eq 1) "the cache option becomes one finding"
    Assert-True (@($ids | Where-Object { $_ -eq 'cleanerml|vanishtest|single' }).Count -eq 1) "the single-file option becomes one finding"
    Assert-True (@($ids | Where-Object { $_ -eq 'cleanerml|vanishtest|globs' }).Count -eq 1) "the glob option becomes one finding"

    $cacheFinding = @($findings | Where-Object { $_.id -eq 'cleanerml|vanishtest|cache' })[0]
    Assert-True (@($cacheFinding.paths).Count -eq 3) "one option is one row carrying every path it would move (3 expected, $(@($cacheFinding.paths).Count) found)"
    Assert-True ($cacheFinding.kind -eq 'file') "and it is a file finding, so it routes through the vault like any other"
    Assert-True ($cacheFinding.sizeBytes -gt 0) "with a real measured size"
    Assert-True ($cacheFinding.meta.matchCount -eq 3) "the match count in the evidence is the count actually being offered"

    # We did not write these rules. "Safe" is a claim about someone else's
    # judgement that Vanish is in no position to make; what it adds is that the
    # removal can be undone, not that the rule was a good idea.
    Assert-True (@($findings | Where-Object { $_.risk -eq 'Safe' }).Count -eq 0) "no finding from a third-party definition is ever labelled Safe"

    $warned = @($findings | Where-Object { $_.id -eq 'cleanerml|vanishwarned|risky' })
    Assert-True ($warned.Count -eq 1) "an option carrying a warning still appears"
    Assert-True ($warned[0].risk -eq 'Advanced') "at Advanced risk"
    Assert-True ($warned[0].note -match 'saved logins') "with the definition's own warning shown as the note"

    # The refusals. An option Vanish will not run must be NAMED, because an
    # option that quietly does not appear is indistinguishable from one that
    # found nothing - and the user believes the category was cleaned.
    Assert-True (@($ids | Where-Object { $_ -like '*vanishunsupported*' }).Count -eq 0) "an option containing an instruction Vanish will not run is withheld ENTIRELY, not half-run"
    Assert-True ($scan.note -match 'sqlite\.vacuum') "and the note names the command that caused it"
    Assert-True ($scan.note -match "search 'deep'") "the whole-filesystem search is named too"
    Assert-True ($scan.note -match 'broken\.xml') "the file that could not be read is named"
    Assert-True ($scan.note -match 'another operating system') "and the definitions written for another OS are accounted for"

    # ==================================================================
    # A definition file is data, not a program
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.7 a definition file cannot make the engine read a file for it" -ForegroundColor Cyan

    $raw = ($scan | ConvertTo-Json -Depth 12 -Compress)
    Assert-True ($raw -notmatch 'VANISH-XXE-CANARY') "an external entity in someone else's definition does not get resolved into our output"
    Assert-True ($scan.success -eq $true) "and the attempt does not take the scan down"

    # ==================================================================
    # No definitions at all
    # ==================================================================
    Write-Host ""
    Write-Host "7sl.8 a machine with no definitions" -ForegroundColor Cyan

    $none = Invoke-Engine "cleaner-scan" @{ cleaner = "definitions"; definitionsPath = $empty }
    Assert-True ($none.success -eq $true) "an empty definitions folder is not an error"
    Assert-True (@($none.findings).Count -eq 0) "and finds nothing"

    $nowhere = Invoke-Engine "cleaner-scan" @{ cleaner = "definitions"; definitionsPath = (Join-Path $work "does-not-exist") }
    Assert-True ($nowhere.success -eq $true) "a folder that does not exist is not an error either"
    Assert-True ($nowhere.note -match 'will not download') "and the note says Vanish ships none and will not fetch any, rather than leaving the user to guess"
}
finally {
    Remove-Item Env:\VANISH_CML_TEST -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed" -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
if ($script:fail -gt 0) { exit 1 }
