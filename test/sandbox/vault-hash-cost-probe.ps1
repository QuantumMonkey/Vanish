# WHERE Get-VaultContentHash ACTUALLY SPENDS ITS TIME (vanish-uninstaller-nkc7)
#
# nkc7 recorded the same function taking ~270 ms standalone and ~6,300 ms inside
# the engine on the same 2,000-file tree, and named three suspects: deep
# call-stack variable resolution, the engine's loaded state after 8,500 lines,
# and the move. This probe measures all three and then finds the real one.
#
# The answer, on the machine in docs/BENCHMARKS.md Run 005: there is no
# engine-side slowdown. The original pair compared a WARM standalone read with a
# COLD engine read, and effectively all of the cold cost is inside the file
# OPEN - not the read, not SHA256 - because a filesystem filter evaluates each
# file the first time it is opened and caches the verdict machine-wide.
#
# NOT in run-all.ps1 on purpose. A timing assertion on a disk nobody controls is
# a flaky test wearing a performance badge; this prints numbers for a human.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sandbox\vault-hash-cost-probe.ps1
#
# The internal -mode switches exist so fixtures are written by a CHILD process:
# the cold effect only appears across a process boundary, and a tree created and
# read inside one process is already warm.

param(
    [string]$mode = 'run',
    [string]$tree = '',
    [int]$dirs = 20,
    [int]$per = 100,
    [int]$bytes = 400
)

$ErrorActionPreference = 'Stop'
$self    = $PSCommandPath
$repo    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scanner = Join-Path $repo 'scanner.ps1'

# ---------------------------------------------------------------- fixtures --

function New-TreeHere {
    param([string]$path, [int]$dirs, [int]$per, [int]$bytes)
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    $blob = 'x' * $bytes
    for ($d = 0; $d -lt $dirs; $d++) {
        $sub = Join-Path $path ("d{0:d2}" -f $d)
        $null = New-Item -ItemType Directory -Path $sub -Force
        for ($i = 0; $i -lt $per; $i++) {
            Set-Content -LiteralPath (Join-Path $sub ("f{0:d3}.bin" -f $i)) -Value $blob -Encoding ascii
        }
    }
}

function New-Fixture {
    param([string]$path, [int]$dirs = 20, [int]$per = 100, [int]$bytes = 400)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $self `
        -mode make -tree $path -dirs $dirs -per $per -bytes $bytes | Out-Null
}

# The function under test, in a form that can be defined at top level. Kept
# deliberately close to scanner.ps1's body; mode=context also runs the REAL one
# so the two are never only compared against a replica.
function Local-TreeHash {
    param([string]$path)
    $files   = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction Stop)
    $rootLen = $path.TrimEnd('\').Length + 1
    $sha     = [System.Security.Cryptography.SHA256]::Create()
    try {
        $buffer = New-Object byte[] 65536
        foreach ($f in ($files | Sort-Object -Property FullName)) {
            $rel      = $f.FullName.Substring($rootLen).ToLowerInvariant()
            $relBytes = [System.Text.Encoding]::UTF8.GetBytes($rel + "`n")
            $null = $sha.TransformBlock($relBytes, 0, $relBytes.Length, $null, 0)
            $stream = [System.IO.File]::OpenRead($f.FullName)
            try {
                while ($true) {
                    $read = $stream.Read($buffer, 0, $buffer.Length)
                    if ($read -le 0) { break }
                    $null = $sha.TransformBlock($buffer, 0, $read, $null, 0)
                }
            } finally { $stream.Dispose() }
        }
        $null = $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        return @{ algo = 'SHA256-TREE'; hash = (($sha.Hash | ForEach-Object { $_.ToString('X2') }) -join '') }
    } finally { $sha.Dispose() }
}

function Frame-A { param($p, $fn) Frame-B $p $fn }
function Frame-B { param($p, $fn) Frame-C $p $fn }
function Frame-C { param($p, $fn) Frame-D $p $fn }
function Frame-D { param($p, $fn) & $fn -path $p }

# ------------------------------------------------------------ child modes --

if ($mode -eq 'make') {
    New-TreeHere -path $tree -dirs $dirs -per $per -bytes $bytes
    exit 0
}

# One measured hash in one of four contexts, one process per context so the
# contexts cannot warm each other's cache.
if ($mode -in @('alone', 'alonedeep', 'dottop', 'dotdeep')) {
    if ($mode -like 'dot*') {
        $swLoad = [System.Diagnostics.Stopwatch]::StartNew()
        . $scanner
        $swLoad.Stop()
        $loadMs = $swLoad.Elapsed.TotalMilliseconds
        $callee = 'Get-VaultContentHash'
    } else {
        $loadMs = 0
        $callee = 'Local-TreeHash'
    }
    $deep = $mode -like '*deep'
    $null = @(Get-ChildItem -LiteralPath $tree -Recurse -File -Force)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($deep) { $r = Frame-A $tree $callee } else { $r = & $callee -path $tree }
    $sw.Stop()
    Write-Output ("{0}|{1}|{2}|{3}" -f $mode, [math]::Round($sw.Elapsed.TotalMilliseconds), [math]::Round($loadMs), $r.hash.Substring(0, 12))
    exit 0
}

# ------------------------------------------------------------------- run 1 --

Write-Host ""
Write-Host "Vault hash cost probe (nkc7)" -ForegroundColor Cyan
Write-Host "============================"

$treeA = Join-Path $env:TEMP 'vanish-hashcost-a'
New-Fixture -path $treeA
Write-Host ""
Write-Host "1. The three suspects: call depth, loaded state, and the move" -ForegroundColor Yellow
Write-Host "   (the FIRST row also pays the cold cost, which is the finding - see step 3)"

foreach ($m in @('alone', 'alone', 'alonedeep', 'dottop', 'dotdeep')) {
    $line = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $self -mode $m -tree $treeA
    $parts = ($line -join '') -split '\|'
    $load  = if ([int]$parts[2] -gt 0) { "   (dot-sourcing scanner.ps1: $($parts[2]) ms, once)" } else { '' }
    Write-Host ("   {0,-10} {1,7:n0} ms   hash={2}{3}" -f $parts[0], [int]$parts[1], $parts[3], $load)
}

# ------------------------------------------------------------------- run 2 --

Write-Host ""
Write-Host "2. The same work through the REAL engine, cold tree then warm tree" -ForegroundColor Yellow

function Invoke-Engine {
    param([string]$action, [hashtable]$params)
    $b64 = [System.Convert]::ToBase64String(
        [System.Text.Encoding]::UTF8.GetBytes(($params | ConvertTo-Json -Depth 8 -Compress)))
    $sw  = [System.Diagnostics.Stopwatch]::StartNew()
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    $sw.Stop()
    return @{ ms = $sw.Elapsed.TotalMilliseconds; result = (($out -join "`n") | ConvertFrom-Json) }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "   SKIP  quarantine is refused in Audit Mode by design; run elevated for this step" -ForegroundColor DarkYellow
} else {
    $eroot = Join-Path $env:TEMP 'vanish-hashcost-engine'
    $vault = Join-Path $eroot 'vault'
    $src   = Join-Path $eroot 'payload'
    if (Test-Path -LiteralPath $eroot) { Remove-Item -LiteralPath $eroot -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $vault -Force
    New-Fixture -path $src

    $null  = Invoke-Engine 'finder-probe' @{ mode = 'bytes'; bytes = @(1) }
    $spawn = (Invoke-Engine 'finder-probe' @{ mode = 'bytes'; bytes = @(1) }).ms
    Write-Host ("   engine spawn + parse baseline  {0,7:n0} ms" -f $spawn)

    $q1 = Invoke-Engine 'quarantine-items' @{ vaultRoot = $vault; entryId = [guid]::NewGuid().ToString(); sourceApp = 'nkc7-probe'; files = @(@{ path = $src }) }
    Write-Host ("   quarantine, COLD tree          {0,7:n0} ms  ({1,6:n0} above baseline)  status={2}" -f $q1.ms, ($q1.ms - $spawn), $q1.result.entry.files[0].status)

    $rs = Invoke-Engine 'vault-restore' @{ vaultRoot = $vault; entry = $q1.result.entry; onConflict = 'overwrite' }
    Write-Host ("   restore (reads every byte)     {0,7:n0} ms  success={1}" -f $rs.ms, $rs.result.success)

    $q2 = Invoke-Engine 'quarantine-items' @{ vaultRoot = $vault; entryId = [guid]::NewGuid().ToString(); sourceApp = 'nkc7-probe'; files = @(@{ path = $src }) }
    Write-Host ("   quarantine, WARM tree          {0,7:n0} ms  ({1,6:n0} above baseline)  status={2}" -f $q2.ms, ($q2.ms - $spawn), $q2.result.entry.files[0].status)

    Remove-Item -LiteralPath $eroot -Recurse -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------- run 3 --

function Measure-Opens {
    param([string]$path)
    $files  = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force | Sort-Object -Property FullName)
    $buffer = New-Object byte[] 65536
    $swOpen = [System.Diagnostics.Stopwatch]::new()
    $swRead = [System.Diagnostics.Stopwatch]::new()
    $total  = 0L
    foreach ($f in $files) {
        $swOpen.Start(); $s = [System.IO.File]::OpenRead($f.FullName); $swOpen.Stop()
        $swRead.Start()
        try { while (($n = $s.Read($buffer, 0, $buffer.Length)) -gt 0) { $total += $n } } finally { $s.Dispose() }
        $swRead.Stop()
    }
    return [pscustomobject]@{
        Files   = $files.Count
        MB      = [math]::Round($total / 1MB, 2)
        OpenMs  = [math]::Round($swOpen.Elapsed.TotalMilliseconds)
        ReadMs  = [math]::Round($swRead.Elapsed.TotalMilliseconds)
        PerOpen = [math]::Round($swOpen.Elapsed.TotalMilliseconds / [math]::Max($files.Count, 1), 3)
    }
}

Write-Host ""
Write-Host "3. Cold against warm: does it track FILE COUNT or BYTES?" -ForegroundColor Yellow
Write-Host "   Per-file cost means a filter evaluating each open. Per-byte means a cache miss."

$cases = @(
    @{ name = '2000 x 400 B '; dirs = 20; per = 100; bytes = 400 },
    @{ name = ' 200 x 4 KB  '; dirs = 20; per = 10;  bytes = 4000 },
    @{ name = '2000 x 40 KB '; dirs = 20; per = 100; bytes = 40000 }
)
foreach ($c in $cases) {
    $p = Join-Path $env:TEMP ('vanish-hashcost-' + ($c.name -replace '[^0-9A-Za-z]', ''))
    New-Fixture -path $p -dirs $c.dirs -per $c.per -bytes $c.bytes
    $cold = Measure-Opens $p
    $warm = Measure-Opens $p
    Write-Host ("   {0} files={1,4}  {2,6:n2} MB   COLD open {3,6:n0} ms ({4,5:n2} ms each) read {5,4:n0} ms   WARM open {6,5:n0} ms" -f `
        $c.name, $cold.Files, $cold.MB, $cold.OpenMs, $cold.PerOpen, $cold.ReadMs, $warm.OpenMs)
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------- run 4 --

Write-Host ""
Write-Host "4. What is attached to this machine's file system" -ForegroundColor Yellow
try {
    fltmc filters 2>&1 | Select-Object -Skip 2 | Where-Object { $_ -match '\S' } | ForEach-Object { Write-Host "   $_" }
} catch {
    Write-Host "   fltmc unavailable: $($_.Exception.Message)" -ForegroundColor DarkYellow
}
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    Write-Host ("   Defender: AMRunningMode={0} RealTimeProtectionEnabled={1}" -f $mp.AMRunningMode, $mp.RealTimeProtectionEnabled)
} catch {
    Write-Host "   Defender status unavailable: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

Remove-Item -LiteralPath $treeA -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Reading: if step 1's rows agree with each other and step 3's cold" -ForegroundColor Cyan
Write-Host "column tracks file count, then the hash is bounded by this machine's" -ForegroundColor Cyan
Write-Host "on-access scanner and by nothing Vanish does. See docs/BENCHMARKS.md" -ForegroundColor Cyan
Write-Host "Run 005 for the numbers this was written against." -ForegroundColor Cyan
Write-Host ""
