# dvem: the registry half of the vault, which cihg and SEC-2 both shipped
# without.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\vault-registry-integrity-verify.ps1
#
# NEEDS FULL MODE for nothing at all - every key here is under HKCU, which the
# operator owns. That is deliberate: this suite performs the attack for real,
# and an attack suite that needs administrator to run is one nobody runs.
#
# WHAT WAS WRONG. cihg exists because "quarantine a file, overwrite the payload
# inside the vault entry folder, restore" returned success and handed back
# somebody else's content. It hashes and verifies every FILE row. The registry
# row of the same vault entry had no hash of any kind, and the restore path
# went from "the file exists" straight to running it as administrator:
#
#     if (-not (Test-Path -LiteralPath $regFile)) { ...missing...; continue }
#     $null = & reg.exe import "$regFile" 2>&1
#
# So the exact attack cihg was written for still worked against the registry
# half of the same entry.
#
# EACH ATTACK GETS ITS OWN ENTRY AND ITS OWN PAYLOAD (bd bcff): the
# destination-guard suite reuses one entry across five targets, and because
# restore MOVES the payload out of the vault, a guard failure on target 3
# leaves targets 4 and 5 asserting nothing while passing green. And every
# refusal here is asserted on its WORDING, not only on the absence of an
# effect - "it did not happen" is also what a crash looks like.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root 'scanner.ps1'

# The attacks below go through the engine as a SUBPROCESS, which is how the app
# calls it. The predicate assertions at the end also dot-source it, so they test
# the shipped function rather than a restatement of its rules in this file.
. $engine

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

function Invoke-Engine($action, $params) {
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $engine, '-Action', $action)
    if ($null -ne $params) {
        $json = $params | ConvertTo-Json -Depth 8 -Compress
        $psArgs += @('-ParamsBase64', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
    }
    $raw = & powershell.exe @psArgs 2>&1 | Out-String
    return $raw.Trim() | ConvertFrom-Json
}

$vaultRoot = Join-Path $env:TEMP ("vanish-dvem-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $vaultRoot | Out-Null

$keyRoot = 'HKCU:\Software\VanishDvemVerify'

# One quarantined registry entry, made fresh, every time. Returns the entry the
# engine produced plus where its .reg landed.
function New-QuarantinedKey {
    param([string]$suffix, [string]$value = 'original')
    $psKey = "$keyRoot\$suffix"
    if (Test-Path $psKey) { Remove-Item -LiteralPath $psKey -Recurse -Force }
    New-Item -Path $psKey -Force | Out-Null
    New-ItemProperty -Path $psKey -Name 'Marker' -Value $value -PropertyType String -Force | Out-Null

    $entryId = [guid]::NewGuid().ToString()
    $q = Invoke-Engine 'quarantine-items' @{
        vaultRoot = $vaultRoot; entryId = $entryId; sourceApp = 'DvemVerify'
        registry  = @(@{ path = $psKey })
    }
    $regFile = Join-Path (Join-Path (Join-Path $vaultRoot $entryId) 'registry') '1.reg'
    return @{ id = $entryId; result = $q; entry = $q.entry; psKey = $psKey; regFile = $regFile }
}

try {
    Write-Host ""
    Write-Host "Vault registry integrity and destination guard (dvem)"
    Write-Host "====================================================="

    # ==================================================================
    Write-Host ""
    Write-Host "Premise: a clean round trip still works" -ForegroundColor Cyan

    # FIRST, and it is not a formality. Every refusal below is only meaningful
    # if the unrefused path works - a guard that blocks everything would pass
    # every attack assertion in this file.
    $ok = New-QuarantinedKey -suffix 'RoundTrip' -value 'restore-me'
    Assert-True ($ok.result.success -eq $true) "the key quarantines" ($ok.result.error)
    Assert-True (-not (Test-Path $ok.psKey)) "and is gone from the registry"

    $okRow = @($ok.entry.registry)[0]
    Assert-True ($okRow.status -eq 'quarantined') "the row says quarantined ($($okRow.status))"
    Assert-True (-not [string]::IsNullOrWhiteSpace($okRow.contentHash)) `
        "AND IT NOW CARRIES A HASH, which is the field the registry row never had" `
        "contentHash=$($okRow.contentHash) algo=$($okRow.hashAlgo) note=$($okRow.hashNote)"
    Assert-True ($okRow.hashAlgo -eq 'SHA256') "recording which algorithm produced it ($($okRow.hashAlgo))"

    $okR = Invoke-Engine 'vault-restore' @{ vaultRoot = $vaultRoot; entry = $ok.entry; onConflict = 'overwrite' }
    $okRes = @($okR.registry)[0]
    Assert-True ($okRes.status -eq 'restored') "it restores" ($okRes.error)
    Assert-True (Test-Path $ok.psKey) "the key is back"
    Assert-True ((Get-ItemProperty -Path $ok.psKey -Name Marker).Marker -eq 'restore-me') "with its value intact"
    Assert-True ($okRes.verified -eq $true) `
        "and the result says the manifest was VERIFIED, not merely imported" (($okRes | ConvertTo-Json -Compress))

    # ==================================================================
    Write-Host ""
    Write-Host "Attack 1: overwrite the .reg inside the vault - cihg's attack, on the registry" -ForegroundColor Cyan

    $a1 = New-QuarantinedKey -suffix 'Tampered'
    Assert-True ($a1.result.success -eq $true) "premise: it quarantined"
    Assert-True (Test-Path -LiteralPath $a1.regFile) "premise: the .reg is where this suite expects it" $a1.regFile

    # A standard user rewrites the payload in place. Same key, different value -
    # so containment passes and only the hash can catch this.
    $tampered = @(
        'Windows Registry Editor Version 5.00'
        ''
        "[HKEY_CURRENT_USER\Software\VanishDvemVerify\Tampered]"
        '"Marker"="TAMPERED-BY-SOMETHING-ELSE"'
        ''
    ) -join "`r`n"
    Set-Content -LiteralPath $a1.regFile -Value $tampered -Encoding Unicode

    $a1R = Invoke-Engine 'vault-restore' @{ vaultRoot = $vaultRoot; entry = $a1.entry; onConflict = 'overwrite' }
    $a1Res = @($a1R.registry)[0]
    Assert-True ($a1Res.status -ne 'restored') "the restore is REFUSED ($($a1Res.status))"
    Assert-True ($a1Res.error -match 'changed since') `
        "and the refusal names the reason - a tampered manifest, not a generic failure" ($a1Res.error)
    Assert-True ($a1Res.error -match 'Nothing was imported') `
        "and states plainly that nothing was written"
    Assert-True (-not (Test-Path $a1.psKey)) `
        "THE ATTACKER'S VALUE NEVER REACHED THE REGISTRY - this is the assertion cihg exists for"
    Assert-True (Test-Path -LiteralPath $a1.regFile) `
        "and the .reg is left in the vault to be inspected rather than deleted"

    # ==================================================================
    Write-Host ""
    Write-Host "Attack 2: repoint the .reg at somewhere else entirely" -ForegroundColor Cyan

    # Fresh entry. The .reg is swapped for one that writes an autorun value into
    # HKCU\...\Run - a real persistence location, reachable without elevation,
    # which is exactly why it makes an honest test target.
    $a2 = New-QuarantinedKey -suffix 'Repointed'
    $runProbe = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $probeName = 'VanishDvemProbe'
    if (Get-ItemProperty -Path $runProbe -Name $probeName -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runProbe -Name $probeName -Force
    }

    $repointed = @(
        'Windows Registry Editor Version 5.00'
        ''
        '[HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run]'
        "`"$probeName`"=`"C:\\Windows\\System32\\calc.exe`""
        ''
    ) -join "`r`n"
    Set-Content -LiteralPath $a2.regFile -Value $repointed -Encoding Unicode

    $a2R = Invoke-Engine 'vault-restore' @{ vaultRoot = $vaultRoot; entry = $a2.entry; onConflict = 'overwrite' }
    $a2Res = @($a2R.registry)[0]
    Assert-True ($a2Res.status -ne 'restored') "refused ($($a2Res.status))"
    Assert-True (-not (Get-ItemProperty -Path $runProbe -Name $probeName -ErrorAction SilentlyContinue)) `
        "NO AUTORUN VALUE WAS WRITTEN - the .reg named a key this row never recorded"

    # ==================================================================
    Write-Host ""
    Write-Host "Attack 3: the manifest is tampered with TOO, so the hash agrees" -ForegroundColor Cyan

    # The one that matters most, because it is the one the hash cannot catch.
    # The vault data directory is user-writable until SEC-3's ACL is applied at
    # the first ELEVATED start (bd al45), so an attacker who can rewrite the
    # .reg can also rewrite the row that describes it. Both of the checks that
    # compare the file to the manifest are then satisfied, and the only thing
    # left is a rule in CODE.
    $a3 = New-QuarantinedKey -suffix 'ForgedManifest'
    $winlogon = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $forged = @(
        'Windows Registry Editor Version 5.00'
        ''
        "[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon]"
        '"Userinit"="C:\\evil.exe"'
        ''
    ) -join "`r`n"
    Set-Content -LiteralPath $a3.regFile -Value $forged -Encoding Unicode

    # Rewrite the row to match: point keyPath at Winlogon and recompute the hash
    # so checks 1 and 2 both pass. This is the attacker having everything.
    $forgedEntry = $a3.entry | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $forgedRow = @($forgedEntry.registry)[0]
    $forgedRow.keyPath = $winlogon
    $forgedRow.contentHash = (Get-FileHash -LiteralPath $a3.regFile -Algorithm SHA256).Hash
    $forgedRow.hashAlgo = 'SHA256'

    $a3R = Invoke-Engine 'vault-restore' @{ vaultRoot = $vaultRoot; entry = $forgedEntry; onConflict = 'overwrite' }
    $a3Res = @($a3R.registry)[0]
    Assert-True ($a3Res.status -ne 'restored') `
        "refused even with a matching hash and a matching keyPath ($($a3Res.status))" ($a3Res.error)
    Assert-True ($a3Res.error -match 'not a key Vanish will write') `
        "and the refusal is the DESTINATION rule, not the hash - the check that does not trust the manifest" ($a3Res.error)
    $userinit = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name Userinit -ErrorAction SilentlyContinue).Userinit
    Assert-True ($userinit -notmatch 'evil') `
        "and the machine's Userinit is untouched" ("Userinit=$userinit")

    # ==================================================================
    Write-Host ""
    Write-Host "Attack 4: a .reg that DELETES rather than restores" -ForegroundColor Cyan

    # reg.exe export never writes a "[-HKEY_...]" header, so one in a vault
    # manifest means the file is not the file we wrote. An import of it removes
    # a key rather than putting one back - a restore that destroys.
    $a4 = New-QuarantinedKey -suffix 'Deleter'
    $victim = "$keyRoot\DeleteVictim"
    New-Item -Path $victim -Force | Out-Null
    New-ItemProperty -Path $victim -Name 'Keep' -Value 'me' -PropertyType String -Force | Out-Null

    $deleter = @(
        'Windows Registry Editor Version 5.00'
        ''
        "[-HKEY_CURRENT_USER\Software\VanishDvemVerify\DeleteVictim]"
        ''
    ) -join "`r`n"
    Set-Content -LiteralPath $a4.regFile -Value $deleter -Encoding Unicode

    $a4R = Invoke-Engine 'vault-restore' @{ vaultRoot = $vaultRoot; entry = $a4.entry; onConflict = 'overwrite' }
    $a4Res = @($a4R.registry)[0]
    Assert-True ($a4Res.status -ne 'restored') "refused ($($a4Res.status))"
    Assert-True (Test-Path $victim) "and the key it would have deleted is still there"

    # ==================================================================
    Write-Host ""
    Write-Host "Attack 5: a .reg that is not a registry export at all" -ForegroundColor Cyan

    $a5 = New-QuarantinedKey -suffix 'Garbage'
    Set-Content -LiteralPath $a5.regFile -Value "not a reg file`r`n[unterminated" -Encoding Unicode
    $a5R = Invoke-Engine 'vault-restore' @{ vaultRoot = $vaultRoot; entry = $a5.entry; onConflict = 'overwrite' }
    $a5Res = @($a5R.registry)[0]
    Assert-True ($a5Res.status -ne 'restored') "refused ($($a5Res.status))"
    Assert-True ($a5Res.error -match 'could not be read as a registry export' -or $a5Res.error -match 'changed since') `
        "with a reason - an unreadable manifest refuses rather than importing nothing and calling it success" ($a5Res.error)

    # ==================================================================
    Write-Host ""
    Write-Host "The predicate is asked at BOTH ends (INV-1)" -ForegroundColor Cyan

    # If it were asked only at restore, this key would quarantine happily and
    # then be impossible to put back - an entry that goes into the vault and
    # can never come out, which is a worse failure than refusing up front. That
    # is not a hypothetical: a first draft of this guard blanket-refused the
    # Control subtree, which would have silently stranded the PATH cleaner's
    # own restore manifest.
    $protQ = Invoke-Engine 'quarantine-items' @{
        vaultRoot = $vaultRoot; entryId = [guid]::NewGuid().ToString(); sourceApp = 'DvemVerify'
        registry  = @(@{ path = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' })
    }
    $protRow = @($protQ.entry.registry)[0]
    Assert-True ($protRow.status -eq 'refused') `
        "quarantine refuses a key restore would refuse ($($protRow.status))" (($protRow | ConvertTo-Json -Compress))
    Assert-True ($protRow.error -match 'will not quarantine this key') `
        "saying so in words" ($protRow.error)
    Assert-True ((Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name Userinit -ErrorAction SilentlyContinue).Userinit) `
        "and the key is still there - a refusal to quarantine does not delete first and ask later"

    # And the other direction, which is what stops this guard from being
    # relaxed by the next person: the keys the real cleaners produce must all
    # still be quarantinable.
    $legit = @(
        'HKLM\SYSTEM\CurrentControlSet\Services\SomeService',
        'HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
        # TWO SEGMENTS, and it is the reason the depth rule is not one number.
        # This is the user half of the PATH cleaner's restore manifest. A first
        # draft used a flat minimum of three and refused it, which
        # phase4-ipc-verify caught immediately - the cleaner purged, the
        # manifest was never written, and the restore had nothing to put back.
        'HKCU\Environment',
        'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
        'HKCR\*\shellex\ContextMenuHandlers\Thing',
        'HKCU\Software\Classes\SomeProgId',
        'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\SomeApp',
        'HKCU\Software\SomeVendor'
    )
    $wrongly = @($legit | Where-Object { Test-ProtectedRegistryDestination $_ })
    Assert-True ($wrongly.Count -eq 0) `
        "every key shape the real cleaners produce is still allowed" ($wrongly -join '; ')

    $shouldRefuse = @(
        'HKLM\SOFTWARE',
        'HKLM\SAM\Domains',
        'HKLM\SECURITY\Policy',
        'HKLM\SYSTEM\CurrentControlSet\Control\Lsa',
        'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows',
        'HKLM\SOFTWARE\Wow6432Node\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\sethc.exe',
        'NotAHive\Something\Else',
        ''
    )
    $missed = @($shouldRefuse | Where-Object { -not (Test-ProtectedRegistryDestination $_) })
    Assert-True ($missed.Count -eq 0) `
        "and every elevated-persistence location is refused" ($missed -join '; ')

    # Segment-aware containment, because a plain StartsWith would accept this.
    Assert-True (-not (Test-RegPathWithin -child 'HKLM\Software\AppEvil' -parent 'HKLM\Software\App')) `
        "containment is segment-aware - 'App' does not contain 'AppEvil'"
    Assert-True (Test-RegPathWithin -child 'HKLM\Software\App\Sub' -parent 'HKLM\Software\App') `
        "but a real subkey is contained"
    Assert-True (Test-RegPathWithin -child 'HKLM\Software\App' -parent 'HKLM\Software\App') `
        "and a key contains itself, which is the ordinary restore case"
}
finally {
    Remove-Item -LiteralPath $keyRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $vaultRoot -Recurse -Force -ErrorAction SilentlyContinue
    $rp = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (Get-ItemProperty -Path $rp -Name 'VanishDvemProbe' -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $rp -Name 'VanishDvemProbe' -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Result: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
