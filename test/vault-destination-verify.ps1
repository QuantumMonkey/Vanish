# The restore destination guard, attacked rather than confirmed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\vault-destination-verify.ps1
#
# FOUND 2026-09-02 by an adversarial probe, using this codebase's OWN stated
# threat model. scanner.ps1 says, above Test-RestorableProtectedPath:
#
#   "The manifest is user-writable; the restore runs elevated. Both the source
#    it reads and the destination it writes are untrusted."
#   "An attacker who can write entry.json writes originalPath =
#    System32\evil.dll, supplies the payload, and asks an elevated process to
#    move it there."
#
# System32 was blocked on exactly that reasoning. Program Files was not:
#
#   WROTE   C:\Program Files\<x>\marker.txt        with attacker-chosen content
#   WROTE   C:\Program Files (x86)\<x>\marker.txt
#   WROTE   C:\ProgramData\<x>\marker.txt
#   BLOCKED C:\Windows\System32\...
#   BLOCKED C:\...
#
# All three are writable by Administrators and not by a standard user, so each
# is a user-to-admin write primitive. check-data-dir reported protected=false
# with nonAdminWriters=[the user] on the development machine when this was
# found, so the precondition was live rather than theoretical.
#
# THIS SUITE IS THE REGRESSION. It performs the attack for real, against a
# throwaway vault, and asserts every target is refused. It also asserts the
# other half, because a guard that blocks the undo path is not a fix: with the
# data directory locked, a genuine round trip through ProgramData must still
# work.
#
# Writes only into $env:TEMP and one probe folder under ProgramData, and
# removes both. Nothing existing is ever overwritten.

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$scanner = Join-Path $root 'scanner.ps1'

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([bool]$condition, [string]$label)
    if ($condition) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else            { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function Write-Skip {
    param([string]$label, [string]$whyNot)
    Write-Host "  SKIP  $label -- $whyNot" -ForegroundColor DarkYellow
}

function Invoke-Engine {
    param([string]$action, [hashtable]$params)
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($params | ConvertTo-Json -Depth 8 -Compress)))
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    $text = ($out -join "`n")
    try { return $text | ConvertFrom-Json } catch { throw "non-JSON from '$action': $text" }
}

Write-Host ''
Write-Host 'Restore destination guard (adversarial)' -ForegroundColor Cyan
Write-Host '======================================='

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# --- The predicate, which is readable in either tier -------------------------
Write-Host ''
Write-Host 'The guard, asked directly' -ForegroundColor Cyan
$targets = @(
    @{ Path = 'C:\Program Files\SomeApp\evil.dll';                 Why = 'Program Files' },
    @{ Path = 'C:\Program Files (x86)\SomeApp\evil.dll';           Why = 'Program Files (x86)' },
    @{ Path = (Join-Path $env:ProgramData 'SomeApp\evil.dat');     Why = 'ProgramData' },
    @{ Path = (Join-Path $env:SystemRoot 'System32\evil.dll');     Why = 'System32 (was already blocked)' },
    @{ Path = 'C:\evil.dll';                                       Why = 'drive root (was already blocked)' }
)
foreach ($t in $targets) {
    $v = Invoke-Engine 'protected-destination-probe' @{ path = $t.Path }
    Assert-True ($v.protected -eq $true) ("guarded destination: " + $t.Why)
    # No vaultRoot passed, so no directory can be trusted and the conditional
    # exception must not fire. This is the assertion that goes red if the
    # exception is ever widened into an unconditional allow.
    Assert-True ($v.installedAppRestorable -eq $false) ("  and not restorable without a locked data directory: " + $t.Why)
}

# --- The attack, performed for real -----------------------------------------
Write-Host ''
Write-Host 'The attack, performed against a real vault' -ForegroundColor Cyan
if (-not $isAdmin) {
    Write-Skip 'the live escalation attempt' 'quarantine-items and vault-restore are Full Mode only, so an unelevated run cannot build the precondition (the guard itself is covered above, in either tier)'
} else {
    $lab   = Join-Path $env:TEMP ('vanish-destguard-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    $fix   = Join-Path $lab 'fix'
    $vault = Join-Path $lab 'vault'
    $null = New-Item -ItemType Directory -Path $fix -Force
    $null = New-Item -ItemType Directory -Path $vault -Force
    try {
        $attacks = @(
            @{ Path = (Join-Path $env:ProgramFiles 'vanish-destguard-probe\marker.txt');       Why = 'Program Files' },
            @{ Path = (Join-Path ${env:ProgramFiles(x86)} 'vanish-destguard-probe\marker.txt'); Why = 'Program Files (x86)' },
            @{ Path = (Join-Path $env:ProgramData 'vanish-destguard-probe\marker.txt');        Why = 'ProgramData' },
            @{ Path = (Join-Path $env:SystemRoot 'System32\vanish-destguard-probe.txt');       Why = 'System32' },
            @{ Path = 'C:\vanish-destguard-probe.txt';                                          Why = 'drive root' }
        )

        # bcff: A FRESH ENTRY AND A FRESH PAYLOAD PER TARGET.
        #
        # This loop used to stage ONE vault entry outside it and clone the entry
        # object per target - but the entry is JSON, and the PAYLOAD is a file.
        # Restore uses Move-ItemTransactional, which MOVES that file out of the
        # vault. So if the guard failed for target N: iteration N wrote into a
        # protected location, the test deleted the landed file, and the payload
        # was then gone. Iterations N+1..5 refused for "Vault payload missing.",
        # $landed was false, and those assertions passed GREEN.
        #
        # A guard that failed for ProgramData only - third of five - left targets
        # 4 and 5 asserting nothing at all while the suite reported five passes.
        # This is the suite whose own header says it "performs the attack for
        # real"; it performed one attack and reported five.
        $staged = 0
        foreach ($a in $attacks) {
            $src = Join-Path $fix ('payload-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.txt')
            Set-Content -LiteralPath $src -Value 'ATTACKER-CHOSEN-CONTENT' -Encoding ASCII
            $q = Invoke-Engine 'quarantine-items' @{ vaultRoot=$vault; entryId=[guid]::NewGuid().ToString(); sourceApp='destguard'; files=@(@{path=$src}); registry=@() }
            if (-not $q.success) {
                Write-Skip ("the live attempt against " + $a.Why) "could not stage a vault entry to attack with ($($q.error))"
                continue
            }
            $staged++

            # What an attacker with write access to the vault does: rewrite
            # originalPath in the entry handed to the elevated restore.
            $entry = $q.entry | ConvertTo-Json -Depth 8 | ConvertFrom-Json
            $entry.files[0].originalPath = $a.Path
            $res = Invoke-Engine 'vault-restore' @{ vaultRoot=$vault; entry=$entry; onConflict='overwrite' }

            $landed = Test-Path -LiteralPath $a.Path
            Assert-True (-not $landed) ("elevated restore refused to write into " + $a.Why)

            # bcff, the second half: the engine result used to be discarded
            # outright ($null = Invoke-Engine). Nothing asserted the restore was
            # even ATTEMPTED, let alone that it reported a refusal - and "the
            # file is not there" is also what a crash, a typo in the path, and a
            # payload that was already gone all look like. Lines 79-83 of this
            # same file already check .protected and .installedAppRestorable, so
            # the discipline existed here and was not applied to the loop.
            $row = @($res.files)[0]
            Assert-True ($row -and $row.status -ne 'restored') `
                ("  and reported it as not restored: " + $a.Why + " (status=$($row.status))")
            Assert-True ($row -and $row.error -and $row.error -match 'protected|refus|not a location|destination') `
                ("  naming the guard rather than failing for some other reason: " + $a.Why + " (error=$($row.error))")

            # And the payload is STILL IN THE VAULT. A refusal must not consume
            # the thing it refused to move - which is both the correct behaviour
            # and the precondition that made this loop's old shape a lie.
            $vaultPath = Join-Path (Join-Path $vault $q.entry.id) $q.entry.files[0].vaultRelative
            Assert-True (Test-Path -LiteralPath $vaultPath) `
                ("  and the payload is still in the vault afterwards: " + $a.Why)

            if ($landed) {
                Remove-Item -LiteralPath $a.Path -Force -ErrorAction SilentlyContinue
                $d = Split-Path -Parent $a.Path
                if ($d -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
                    Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
                }
            }
        }

        # The premise, stated rather than assumed: if nothing staged, every
        # assertion above was skipped and the section proved nothing.
        Assert-True ($staged -eq $attacks.Count) `
            "all $($attacks.Count) attacks were staged with their own payload (staged $staged)"

        # WHERE THE POSITIVE CONTROL IS. Five refusals prove nothing on their
        # own - a restore that was simply broken would produce all five. The
        # INV-1 symmetry section below is that control: it restores into a real
        # installed-program folder and requires it to SUCCEED. Read the two
        # together; neither is worth much alone.
    } finally {
        Remove-Item -LiteralPath $lab -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- The other half: the undo path must survive the guard --------------------
Write-Host ''
Write-Host 'INV-1 symmetry: a guard that blocks the undo path is not a fix' -ForegroundColor Cyan
if (-not $isAdmin) {
    Write-Skip 'the round trip through an installed-program folder' 'quarantine-items and secure-data-dir are Full Mode only'
} else {
    $appDir = Join-Path $env:ProgramData 'vanish-destguard-legit'
    $lab1 = Join-Path $env:TEMP ('vanish-dg1-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    $lab2 = Join-Path $env:TEMP ('vanish-dg2-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    try {
        $null = New-Item -ItemType Directory -Path $appDir -Force

        # Unlocked data directory: the refusal must land at QUARANTINE, so a
        # file is never taken out of a place the vault could not put it back.
        $d1 = Join-Path $lab1 'data'; $v1 = Join-Path $d1 'vault'
        $null = New-Item -ItemType Directory -Path $v1 -Force
        $live1 = Join-Path $appDir 'cfg1.dat'
        Set-Content -LiteralPath $live1 -Value 'REAL-APP-CONFIG' -Encoding ASCII
        $c1 = Invoke-Engine 'check-data-dir' @{ path = $d1 }
        if ($c1.protected -eq $true) {
            Write-Skip 'the unlocked-directory refusal' 'a freshly created temp directory came back already protected'
        } else {
            $q1 = Invoke-Engine 'quarantine-items' @{ vaultRoot=$v1; entryId=[guid]::NewGuid().ToString(); sourceApp='dg'; files=@(@{path=$live1}); registry=@() }
            Assert-True (Test-Path -LiteralPath $live1) 'with an unlocked data directory the file is NOT moved (refused at quarantine, not stranded)'
            $row = if ($q1.entry -and $q1.entry.files) { $q1.entry.files[0] } else { $null }
            Assert-True ($row -and $row.error -match 'lock the directory') 'and the refusal names the fix rather than being a dead end'
        }

        # Locked data directory: the full round trip must still work.
        $d2 = Join-Path $lab2 'data'; $v2 = Join-Path $d2 'vault'
        $null = New-Item -ItemType Directory -Path $v2 -Force
        $sec = Invoke-Engine 'secure-data-dir' @{ path = $d2 }
        $c2  = Invoke-Engine 'check-data-dir'  @{ path = $d2 }
        if ($c2.protected -ne $true) {
            Write-Skip 'the locked-directory round trip' 'secure-data-dir did not produce a protected directory on this machine'
        } else {
            $live2 = Join-Path $appDir 'cfg2.dat'
            Set-Content -LiteralPath $live2 -Value 'REAL-APP-CONFIG-2' -Encoding ASCII
            $q2 = Invoke-Engine 'quarantine-items' @{ vaultRoot=$v2; entryId=[guid]::NewGuid().ToString(); sourceApp='dg'; files=@(@{path=$live2}); registry=@() }
            Assert-True ($q2.success -eq $true -and -not (Test-Path -LiteralPath $live2)) 'with the data directory locked, quarantine from ProgramData works'
            $null = Invoke-Engine 'vault-restore' @{ vaultRoot=$v2; entry=$q2.entry; onConflict='skip' }
            $back = Test-Path -LiteralPath $live2
            Assert-True $back 'and the restore puts it back where it came from'
            if ($back) {
                Assert-True ((Get-Content -LiteralPath $live2 -Raw).Trim() -eq 'REAL-APP-CONFIG-2') 'with its content intact'
            }
        }
    } finally {
        Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $lab1  -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $lab2  -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail)
exit ([int]($script:fail -gt 0))
