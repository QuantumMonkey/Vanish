# Security regression suite (findings from the 2026-08-03 review).
# Each test attempts the actual attack and asserts it is refused.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\security-verify.ps1

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
    $json = $params | ConvertTo-Json -Depth 10 -Compress
    $b64  = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $out  = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -Action $action -ParamsBase64 $b64
    if (-not $out) { throw "Engine returned no output for '$action'." }
    return ($out -join "`n") | ConvertFrom-Json
}

# The SEC-3 block deliberately applies a restrictive DACL to a scratch
# directory, which then denies the test its own cleanup. Un-protecting alone is
# not enough - the explicit ACEs survive it - so grant this account full control
# back across the tree before removing anything.
function Remove-TestTree {
    param([string]$path)
    if (-not (Test-Path -LiteralPath $path)) { return }
    $null = & icacls.exe "$path" /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q 2>&1
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "Vanish security regression suite" -ForegroundColor Cyan
Write-Host "================================"
Write-Host ("Elevation: {0}" -f $(if ($isAdmin) { "Full Mode" } else { "Audit Mode" }))

# ======================================================================
# SEC-3 detection half (bd vanish-uninstaller-z2a).
# Runs in BOTH tiers: Test-VanishDataDirAcl is a read-only check with no
# elevation gate, and the bug being regressed is that it answered "protected"
# from the DACL alone. main.js only re-applies the ACL when this returns
# protected:false, so a wrong "true" is never revisited - which makes this
# check, not the remediation, the load-bearing part.
# ======================================================================
Write-Host ""
Write-Host "SEC-3 - data directory protection check reads owners, not just the DACL" -ForegroundColor Cyan

$aclWork = Join-Path $env:TEMP "vanish-sec3-verify"
Remove-TestTree $aclWork
$null = New-Item -ItemType Directory -Path $aclWork -Force
$null = New-Item -ItemType Directory -Path (Join-Path $aclWork "vault") -Force
Set-Content -LiteralPath (Join-Path $aclWork "vault\manifest.json") -Value '{"schemaVersion":1,"entries":[]}' -Encoding ASCII

try {
    # An inherited ACL is unprotected on the old rule as well as the new one.
    $inheritedVerdict = Invoke-Engine "check-data-dir" @{ path = $aclWork }
    Assert-True ($inheritedVerdict.protected -eq $false)  "an inherited data directory ACL is reported unprotected"
    Assert-True ($inheritedVerdict.inherited -eq $true)   "inheritance is reported"

    # The regression itself: a DACL that looks perfect - protected, with no
    # non-administrator writer - on objects still OWNED by the interactive user.
    # The owner keeps WRITE_DAC, so this is not protected, and the old
    # DACL-only check called it protected anyway.
    $admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
    $system = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $users  = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    $inh    = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
              [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $none   = [System.Security.AccessControl.PropagationFlags]::None
    $allow  = [System.Security.AccessControl.AccessControlType]::Allow

    $acl = Get-Acl -LiteralPath $aclWork
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRule($rule) }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, [System.Security.AccessControl.FileSystemRights]::FullControl, $inh, $none, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, [System.Security.AccessControl.FileSystemRights]::FullControl, $inh, $none, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($users,  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $inh, $none, $allow)))
    Set-Acl -LiteralPath $aclWork -AclObject $acl -ErrorAction Stop

    $ownerVerdict = Invoke-Engine "check-data-dir" @{ path = $aclWork }
    Assert-True (@($ownerVerdict.nonAdminWriters).Count -eq 0) "the DACL alone shows no non-administrator writer"
    Assert-True ($ownerVerdict.inherited -eq $false)           "the DACL alone looks protected"
    Assert-True (@($ownerVerdict.foreignOwners).Count -gt 0)   "a child still owned by the interactive user is reported"
    Assert-True ($ownerVerdict.protected -eq $false)           "a user-owned subtree is NOT called protected (the SEC-3 false positive)"
} finally {
    Remove-TestTree $aclWork
}

# ======================================================================
# SEC-2 destination guard (bd vanish-uninstaller-2xt).
# Also tier-independent: protected-destination-probe asks the restore guard for
# a verdict without performing a restore.
# ======================================================================
Write-Host ""
Write-Host "SEC-2 - restore destination guard" -ForegroundColor Cyan

function Test-Destination {
    param([string]$path)
    return (Invoke-Engine "protected-destination-probe" @{ path = $path })
}

# Refused: privileged execution surfaces.
$mustRefuse = @(
    @{ Path = (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\evil.exe'); Why = 'the all-users Startup folder' },
    @{ Path = (Join-Path $env:APPDATA    'Microsoft\Windows\Start Menu\Programs\Startup\evil.exe'); Why = 'a per-user Startup folder' },
    @{ Path = 'C:\evil.exe';                                       Why = 'a direct child of the drive root' },
    @{ Path = (Join-Path $env:SystemRoot 'System32\evil.dll');      Why = 'System32' },
    @{ Path = (Join-Path $env:SystemRoot 'evil.exe');               Why = 'the Windows directory' }
)
foreach ($c in $mustRefuse) {
    Assert-True ((Test-Destination $c.Path).protected -eq $true) ("refused: " + $c.Why)
}

# Allowed: Vanish quarantines application leftovers from all of these, so a
# restore has to be able to put them back. Blocking them would break the undo
# path, which is the entire point of the vault.
$mustAllow = @(
    @{ Path = 'C:\Program Files\SomeApp\leftover.dll';            Why = 'Program Files leftovers' },
    @{ Path = (Join-Path $env:ProgramData 'SomeApp\leftover.dat'); Why = 'ProgramData leftovers' },
    @{ Path = (Join-Path $env:LOCALAPPDATA 'SomeApp\leftover.dat');Why = 'LocalAppData leftovers' },
    @{ Path = 'C:\Users\OtherUser\AppData\Roaming\App\x.dat';      Why = 'another profile (REQ-17 sweeps these by design)' }
)
foreach ($c in $mustAllow) {
    Assert-True ((Test-Destination $c.Path).protected -eq $false) ("still allowed: " + $c.Why)
}

# The bypass that makes a textual path check worthless: a junction at an
# innocent-looking path pointing into a blocked one.
$jWork = Join-Path $env:TEMP "vanish-sec2-junction-verify"
$jLink = Join-Path $jWork "Foo"
if ([IO.Directory]::Exists($jLink)) { [IO.Directory]::Delete($jLink) }
if ([IO.Directory]::Exists($jWork)) { [IO.Directory]::Delete($jWork, $true) }
$null = [IO.Directory]::CreateDirectory($jWork)
try {
    $null = New-Item -ItemType Junction -Path $jLink `
        -Target (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp') -ErrorAction Stop

    $verdict = Test-Destination (Join-Path $jLink 'evil.exe')
    Assert-True ($verdict.protected -eq $true) "refused: a junction pointing into the all-users Startup folder"
    Assert-True ($verdict.resolved -match 'Start Menu') "the junction is resolved to its real target, not taken literally"
} catch {
    Write-Host ("  SKIP  junction test could not run: " + $_.Exception.Message) -ForegroundColor Yellow
} finally {
    if ([IO.Directory]::Exists($jLink)) { [IO.Directory]::Delete($jLink) }
    if ([IO.Directory]::Exists($jWork)) { [IO.Directory]::Delete($jWork, $true) }
}

# The follow-up gap, found on a fresh re-review of this same fix: resolving
# only ONE hop leaves a chain (A -> B -> blocked) comparing against B, which is
# not itself blocked, while Windows follows the whole chain transparently at
# write time. A -> B -> the real Startup folder must resolve all the way
# through, not stop at the first hop.
$jChainWork = Join-Path $env:TEMP "vanish-sec2-chain-verify"
$jChainA = Join-Path $jChainWork "A"
$jChainB = Join-Path $jChainWork "B"
if ([IO.Directory]::Exists($jChainA)) { [IO.Directory]::Delete($jChainA) }
if ([IO.Directory]::Exists($jChainB)) { [IO.Directory]::Delete($jChainB) }
if ([IO.Directory]::Exists($jChainWork)) { [IO.Directory]::Delete($jChainWork, $true) }
$null = [IO.Directory]::CreateDirectory($jChainWork)
try {
    $null = New-Item -ItemType Junction -Path $jChainB `
        -Target (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp') -ErrorAction Stop
    $null = New-Item -ItemType Junction -Path $jChainA -Target $jChainB -ErrorAction Stop

    $chainVerdict = Test-Destination (Join-Path $jChainA 'evil.exe')
    Assert-True ($chainVerdict.protected -eq $true) "refused: a two-hop junction chain (A -> B -> the all-users Startup folder)"
    Assert-True ($chainVerdict.resolved -match 'Start Menu') "the chain resolves all the way through, not just the first hop"
} catch {
    Write-Host ("  SKIP  chained junction test could not run: " + $_.Exception.Message) -ForegroundColor Yellow
} finally {
    if ([IO.Directory]::Exists($jChainA)) { [IO.Directory]::Delete($jChainA) }
    if ([IO.Directory]::Exists($jChainB)) { [IO.Directory]::Delete($jChainB) }
    if ([IO.Directory]::Exists($jChainWork)) { [IO.Directory]::Delete($jChainWork, $true) }
}

# ======================================================================
# TASK-05 elevated relaunch argument vector (bd vanish-uninstaller-ceb).
#
# The relaunch itself needs a human at the UAC prompt, which is exactly why the
# bug shipped uncovered. What CAN be tested without consent is the thing that
# was actually broken: the argument vector handed to Start-Process. Every case
# is round-tripped through CommandLineToArgvW - the real Windows parser, the
# one Electron's CRT uses - so this asserts what Windows does, not what the
# quoting looks like.
# ======================================================================
Write-Host ""
Write-Host "TASK-05 - elevated relaunch argument vector" -ForegroundColor Cyan

Add-Type -Namespace VanishArgv -Name Native -MemberDefinition @'
[DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr CommandLineToArgvW(string lpCmdLine, out int pNumArgs);
[DllImport("kernel32.dll")]
public static extern IntPtr LocalFree(IntPtr hMem);
'@ -ErrorAction SilentlyContinue

function ConvertFrom-WindowsCommandLine {
    param([string]$commandLine)
    $count = 0
    # argv[0] has its own parsing rules, so prefix a placeholder and drop it.
    $ptr = [VanishArgv.Native]::CommandLineToArgvW("vanish-test.exe $commandLine", [ref]$count)
    if ($ptr -eq [IntPtr]::Zero) { return @() }
    try {
        $parsed = @()
        for ($i = 1; $i -lt $count; $i++) {
            $slot = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size)
            $parsed += [Runtime.InteropServices.Marshal]::PtrToStringUni($slot)
        }
        return $parsed
    } finally {
        $null = [VanishArgv.Native]::LocalFree($ptr)
    }
}

function Test-ArgvRoundTrip {
    param([string[]]$original, [string]$label)
    $built  = Invoke-Engine "relaunch-argv-probe" @{ argList = $original }
    $parsed = @(ConvertFrom-WindowsCommandLine $built.commandLine)

    $same = ($parsed.Count -eq $original.Count)
    if ($same) {
        for ($i = 0; $i -lt $original.Count; $i++) {
            if ($parsed[$i] -cne $original[$i]) { $same = $false; break }
        }
    }
    Assert-True $same "$label (built: $($built.commandLine))"
}

# The exact failure from the bug report: Electron received "D:\quickhelp" and
# "projects\vanish-uninstaller" as two arguments and opened the first as the app.
Test-ArgvRoundTrip @('D:\quickhelp projects\vanish-uninstaller') 'a spaced app path survives as ONE argument'

# The naive repair (wrap in quotes) produces "...\" here, where the backslash
# escapes the closing quote and swallows whatever follows.
Test-ArgvRoundTrip @('D:\quickhelp projects\vanish-uninstaller\', 'second-arg') 'a trailing backslash does not swallow the next argument'

# An embedded quote is argument INJECTION, because this process is launched
# elevated: --inspect-brk on an elevated Electron is a debugger port as admin.
Test-ArgvRoundTrip @('C:\a b\app" --inspect-brk=0.0.0.0:9229 "') 'an embedded quote cannot inject a new argument'

Test-ArgvRoundTrip @('D:\quickhelp\vanish-uninstaller') 'an unspaced path round-trips unchanged'
Test-ArgvRoundTrip @('C:\one two\a', 'C:\three four\b') 'multiple spaced arguments stay separate'

# And the shape of the no-op case: nothing gets quoted that does not need it.
$plain = Invoke-Engine "relaunch-argv-probe" @{ argList = @('D:\quickhelp\vanish-uninstaller') }
Assert-True ($plain.commandLine -eq 'D:\quickhelp\vanish-uninstaller') 'a path needing no quoting is passed through untouched'


# Scratch space for the read-only checks below. Deliberately separate from the
# elevated section's $work, which is not created until after the tier gate.
$roWork = Join-Path $env:TEMP "vanish-readonly-verify"
if (Test-Path -LiteralPath $roWork) { Remove-Item -LiteralPath $roWork -Recurse -Force -ErrorAction SilentlyContinue }
$null = New-Item -ItemType Directory -Path $roWork -Force
try {

    # ==================================================================
    # 1td/vhm: the read-only surfaces added for zrw and bu2.
    #
    # measure-paths takes a caller-supplied path LIST, which is a new shape for
    # this engine - every prior command took a single validated target. It is
    # read-only by construction (enumeration and .Length, never a read of
    # contents), but "read-only" is a claim worth regressing rather than
    # asserting, because the cost of being wrong about it is the whole Audit
    # Mode promise.
    # ==================================================================
    Write-Host ""
    Write-Host "1td - the snapshot and measurement surfaces are read-only" -ForegroundColor Cyan

    $secCanary = Join-Path $roWork "measure-canary.txt"
    Set-Content -LiteralPath $secCanary -Value "intact" -Encoding UTF8
    $secDir = Join-Path $roWork "measure-dir"
    New-Item -ItemType Directory -Path $secDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $secDir "a.txt") -Value "0123456789" -Encoding UTF8

    $m = Invoke-Engine "measure-paths" @{ paths = @($secDir) }
    Assert-True ($m.success -eq $true)                        "measure-paths returns a result for a real directory"
    Assert-True ($m.results[0].sizeBytes -ge 10)              "and measures its bytes"
    Assert-True ((Get-Content -LiteralPath $secCanary -Raw).Trim() -eq "intact") "measure-paths changed nothing on disk"

    # A path that does not exist must be reported, never invented as zero. A
    # folder shown as "0 B" that is actually missing is a number a user acts on.
    $gone = Invoke-Engine "measure-paths" @{ paths = @((Join-Path $roWork "no-such-dir")) }
    Assert-True ($null -eq $gone.results[0].sizeBytes)        "a missing path reports a null size, not 0 bytes"
    Assert-True ([string]$gone.results[0].error -ne "")       "and states why"

    # Command injection through the path list. Parameters cross as base64 JSON
    # precisely so no caller value is interpolated into a command string; this
    # proves it for the new surface rather than assuming it carried over.
    $injCanary = Join-Path $roWork "inject-canary.txt"
    $payload = '"; Set-Content -LiteralPath "' + $injCanary + '" -Value pwned; "'
    $inj = Invoke-Engine "measure-paths" @{ paths = @($payload) }
    Assert-True ($inj.success -eq $true)                      "an injection-shaped path is handled as data"
    Start-Sleep -Milliseconds 200
    Assert-True (-not (Test-Path -LiteralPath $injCanary))    "no shell executed the injected payload - the canary is absent"

    $none = Invoke-Engine "measure-paths" @{ paths = @() }
    Assert-True ($none.success -eq $true)                     "an empty path list is handled, not thrown"

    $snap = Invoke-Engine "install-snapshot" @{}
    Assert-True ($snap.success -eq $true)                     "install-snapshot runs unelevated - it is an audit question"
    Assert-True (@($snap.dirs).Count -gt 0)                   "and returns real directories"
    Assert-True ((Get-Content -LiteralPath $secCanary -Raw).Trim() -eq "intact") "install-snapshot changed nothing on disk"

    # Static guarantee: the new engine commands must not have acquired a shell
    # or a write path either.
    $scannerLines = @(Get-Content -LiteralPath (Join-Path $root "scanner.ps1") | Where-Object { $_ -notmatch '^\s*#' })
    $scannerCode = $scannerLines -join ([char]10)
    $measureBody = ""
    if ($scannerCode -match '(?s)function Measure-Paths.*?\r?\n\}') { $measureBody = $Matches[0] }
    Assert-True ($measureBody -ne "")                         "Measure-Paths was found for inspection"
    Assert-True ($measureBody -notmatch 'Invoke-Expression|Start-Process|cmd\.exe') "Measure-Paths executes nothing - it only enumerates"
    Assert-True ($measureBody -notmatch 'Remove-Item|Set-Content|Out-File|New-Item')  "Measure-Paths writes nothing"

}
finally {
    if (Test-Path -LiteralPath $roWork) { Remove-Item -LiteralPath $roWork -Recurse -Force -ErrorAction SilentlyContinue }
}

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "The remaining tests exercise elevated code paths. Re-run from an elevated shell." -ForegroundColor Yellow
    Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail)
    exit ([int]($script:fail -gt 0))
}

$work      = Join-Path $env:TEMP "vanish-security-verify"
$vaultRoot = Join-Path $work "vault"
$canary    = Join-Path $work "canary"

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$null = New-Item -ItemType Directory -Path $vaultRoot -Force
$null = New-Item -ItemType Directory -Path $canary -Force

try {
    # ==================================================================
    # Vuln 1: path traversal in the vault
    # ==================================================================
    Write-Host ""
    Write-Host "Vuln 1 - vault path traversal (arbitrary write/delete as admin)" -ForegroundColor Cyan

    # A real entry to work from.
    $realFile = Join-Path $work "leftover.txt"
    Set-Content -LiteralPath $realFile -Value "payload" -Encoding ASCII
    $entryId = [guid]::NewGuid().ToString()
    $q = Invoke-Engine "quarantine-items" @{
        vaultRoot = $vaultRoot; entryId = $entryId; sourceApp = "SecTest"
        files = @(@{ path = $realFile })
    }
    Assert-True ($q.quarantinedCount -eq 1) "baseline: a legitimate quarantine still works"

    $entry = Get-Content (Join-Path $vaultRoot "$entryId\entry.json") -Raw | ConvertFrom-Json

    # 1a. Attacker-forged entry id containing traversal, aimed at delete.
    $evilDir = Join-Path $canary "do-not-delete"
    $null = New-Item -ItemType Directory -Path $evilDir -Force
    Set-Content -LiteralPath (Join-Path $evilDir "keep.txt") -Value "important" -Encoding ASCII

    $del = Invoke-Engine "vault-delete" @{
        vaultRoot = $vaultRoot
        entryId   = "..\..\vanish-security-verify\canary\do-not-delete"
    }
    Assert-True ($del.success -eq $false)                    "vault-delete refuses a traversing entry id"
    Assert-True ($del.error -match "not a UUID")             "refusal names the reason"
    Assert-True (Test-Path -LiteralPath (Join-Path $evilDir "keep.txt")) "the targeted directory was NOT deleted"

    # 1b. Traversing vaultRelative - reads a file from outside the entry folder.
    $outsideFile = Join-Path $canary "outside.txt"
    Set-Content -LiteralPath $outsideFile -Value "outside the vault" -Encoding ASCII
    $restoreTarget = Join-Path $canary "restored-here.txt"

    $forged = $entry | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $forged.files[0].vaultRelative = "..\..\..\vanish-security-verify\canary\outside.txt"
    $forged.files[0].originalPath  = $restoreTarget

    $r1 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $forged }
    Assert-True (@($r1.files)[0].status -eq "failed")        "restore refuses a traversing vault payload path"
    Assert-True (@($r1.files)[0].error -match "escapes")     "refusal explains the escape"
    Assert-True (Test-Path -LiteralPath $outsideFile)        "the outside file was NOT moved"
    Assert-True (-not (Test-Path -LiteralPath $restoreTarget)) "nothing was written to the attacker's destination"

    # 1c. Protected destination - the System32 payload drop.
    $forged2 = $entry | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $forged2.files[0].originalPath = (Join-Path $env:SystemRoot "System32\vanish-should-never-appear.dll")

    $r2 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $forged2 }
    Assert-True (@($r2.files)[0].status -eq "failed")        "restore refuses a protected system destination"
    Assert-True (@($r2.files)[0].error -match "protected")   "refusal names the protection"
    Assert-True (-not (Test-Path -LiteralPath $forged2.files[0].originalPath)) "nothing was written into System32"

    # 1d. Traversing regFile - arbitrary reg import as admin.
    $forged3 = $entry | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    # Clear the file rows: leaving the legitimate one in place would restore it
    # as a side effect and invalidate the "legitimate restore" check below.
    $forged3.files = @()
    $forged3.registry = @(@{ keyPath = "HKCU\Software\VanishSecTest"; regFile = "..\..\evil.reg"; status = "quarantined" })
    $r3 = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $forged3 }
    Assert-True (@($r3.registry)[0].status -eq "failed")     "restore refuses a traversing .reg manifest path"
    Assert-True (@($r3.registry)[0].error -match "escapes")  "refusal explains the escape"

    # 1e. Quarantine with a forged entry id must not create folders outside the vault.
    $q2 = Invoke-Engine "quarantine-items" @{
        vaultRoot = $vaultRoot; entryId = "../../escape"; files = @(@{ path = $realFile })
    }
    Assert-True ($q2.success -eq $false)                     "quarantine refuses a non-UUID entry id"

    # And the legitimate path still works after all that.
    $good = Invoke-Engine "vault-restore" @{ vaultRoot = $vaultRoot; entry = $entry }
    Assert-True ($good.failed -eq 0)                         "a legitimate restore is unaffected by the new checks"
    Assert-True (Test-Path -LiteralPath $realFile)           "the real file came back"

    # ==================================================================
    # Vuln 2: data directory ACL
    # ==================================================================
    Write-Host ""
    Write-Host "Vuln 2 - data directory is not user-writable" -ForegroundColor Cyan

    $aclDir = Join-Path $work "datadir"
    $null = New-Item -ItemType Directory -Path $aclDir -Force

    $before = Invoke-Engine "check-data-dir" @{ path = $aclDir }
    Assert-True ($before.protected -eq $false)               "a freshly created directory is reported unprotected"

    $applied = Invoke-Engine "secure-data-dir" @{ path = $aclDir }
    Assert-True ($applied.success -eq $true)                 "ACL applied"

    $after = Invoke-Engine "check-data-dir" @{ path = $aclDir }
    Assert-True ($after.protected -eq $true)                 "directory now reports protected"
    Assert-True ($after.inherited -eq $false)                "inheritance is severed"
    Assert-True (@($after.nonAdminWriters).Count -eq 0)      "no non-administrator identity retains write access"

    # Users must still be able to READ, or Audit Mode cannot list the vault.
    $acl = Get-Acl -LiteralPath $aclDir
    $usersSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    $userRead = @($acl.Access | Where-Object {
        $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $usersSid.Value -and
        ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Read) -ne 0
    })
    Assert-True ($userRead.Count -gt 0)                      "standard users keep READ so Audit Mode still lists the vault"

    # ==================================================================
    # Vuln 3: untrusted uninstaller execution
    # ==================================================================
    Write-Host ""
    Write-Host "Vuln 3 - untrusted uninstallers are not run unacknowledged" -ForegroundColor Cyan

    $userWritableExe = Join-Path $env:LOCALAPPDATA "vanish-sectest-payload.exe"
    Copy-Item "$env:SystemRoot\System32\cmd.exe" $userWritableExe -Force

    try {
        $blocked = Invoke-Engine "run-uninstaller" @{
            executable = $userWritableExe; baseArgs = "/c"; arguments = "exit 0"
            timeoutSeconds = 10
        }
        Assert-True ($blocked.success -eq $false)            "engine refuses a user-writable binary without acknowledgement"
        Assert-True ($blocked.blocked -eq $true)             "refusal is flagged as a block, not a generic failure"
        Assert-True ($blocked.error -match "user-writable")  "refusal names the reason"

        $allowed = Invoke-Engine "run-uninstaller" @{
            executable = $userWritableExe; baseArgs = "/c"; arguments = "exit 0"
            timeoutSeconds = 30; acknowledged = $true
        }
        Assert-True ($allowed.success -eq $true)             "the same binary runs once acknowledged"
    } finally {
        Remove-Item -LiteralPath $userWritableExe -Force -ErrorAction SilentlyContinue
    }

    # HKCU-registered entries are reported as untrusted.
    $hkcuKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSecTestEntry"
    if (Test-Path -LiteralPath $hkcuKey) { Remove-Item -LiteralPath $hkcuKey -Recurse -Force }
    $null = New-Item -Path $hkcuKey -Force
    Set-ItemProperty -LiteralPath $hkcuKey -Name DisplayName     -Value "Vanish SecTest Entry"
    Set-ItemProperty -LiteralPath $hkcuKey -Name UninstallString -Value "`"$env:LOCALAPPDATA\fake\uninstall.exe`" /S"

    try {
        $live = Invoke-Engine "read-uninstall-entry" @{
            registryPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSecTestEntry"
        }
        Assert-True ($live.found -eq $true)                  "live registry re-read finds the entry"
        Assert-True ($live.trust.risky -eq $true)            "an HKCU entry pointing at a user-writable binary is untrusted"
        Assert-True ($live.trust.userHive -eq $true)         "HKCU registration is called out"
        Assert-True ($live.trust.userWritable -eq $true)     "user-writable binary location is called out"
        Assert-True (@($live.trust.reasons).Count -ge 2)     "both reasons are reported for the operator"

        # A machine-hive entry pointing at Program Files is not flagged.
        $safe = Invoke-Engine "read-uninstall-entry" @{ registryPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\NoSuchEntryAtAll" }
        Assert-True ($safe.found -eq $false)                 "a missing entry is reported as not found, not silently trusted"
    } finally {
        if (Test-Path -LiteralPath $hkcuKey) { Remove-Item -LiteralPath $hkcuKey -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # ==================================================================
    # SEC-1: shell command injection through UninstallString
    # (/cso audit 2026-08-03, bd vanish-uninstaller-lwz)
    # ==================================================================
    Write-Host ""
    Write-Host "SEC-1 - command injection via a planted HKCU UninstallString" -ForegroundColor Cyan

    # The whole vulnerability was that main.js handed this string to cmd.exe as
    # administrator. The canary proves no shell ever saw it: if a shell did, the
    # metacharacter payload would create the file.
    $injCanary = Join-Path $canary "sec1-injection-canary.txt"
    if (Test-Path -LiteralPath $injCanary) { Remove-Item -LiteralPath $injCanary -Force }

    $injKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSec1TestEntry"
    if (Test-Path -LiteralPath $injKey) { Remove-Item -LiteralPath $injKey -Recurse -Force }
    $null = New-Item -Path $injKey -Force
    Set-ItemProperty -LiteralPath $injKey -Name DisplayName -Value "Vanish SEC-1 Test Entry"
    Set-ItemProperty -LiteralPath $injKey -Name UninstallString `
        -Value "`"$env:LOCALAPPDATA\fake\uninstall.exe`" /S & echo pwned > `"$injCanary`""

    $injPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VanishSec1TestEntry"

    try {
        # 1. The entry is recognised as untrusted before anything runs.
        $live = Invoke-Engine "read-uninstall-entry" @{ registryPath = $injPath }
        Assert-True ($live.trust.risky -eq $true)            "a planted HKCU entry is reported untrusted"

        # 2. The engine refuses it outright without an acknowledgement, even
        #    though the executable itself is what the string names.
        $split = Invoke-Engine "resolve-uninstall-args" @{
            displayName     = $live.displayName
            publisher       = $live.publisher
            uninstallString = $live.uninstallString
        }
        Assert-True ($split.success -eq $true)               "the uninstall string is parsed rather than executed"
        Assert-True ($split.executable -notmatch '&')        "the metacharacter payload is not part of the executable"

        $blocked = Invoke-Engine "run-uninstaller" @{
            executable     = $split.executable
            baseArgs       = $split.baseArgs
            arguments      = $split.arguments
            registryPath   = $injPath
            timeoutSeconds = 5
            acknowledged   = $false
        }
        Assert-True ($blocked.success -eq $false)            "an unacknowledged untrusted uninstaller is refused"
        Assert-True ($blocked.blocked -eq $true)             "the refusal is the trust gate, not an incidental failure"

        # 3. Even acknowledged, the payload runs through Start-Process, so the
        #    shell operators are inert. The executable does not exist, so this
        #    fails to start - and the canary must still not exist.
        $ran = Invoke-Engine "run-uninstaller" @{
            executable     = $split.executable
            baseArgs       = $split.baseArgs
            arguments      = $split.arguments
            registryPath   = $injPath
            timeoutSeconds = 5
            acknowledged   = $true
        }
        Assert-True ($ran.blocked -ne $true)                 "an acknowledged uninstaller is no longer blocked by the gate"

        Start-Sleep -Milliseconds 500
        Assert-True (-not (Test-Path -LiteralPath $injCanary)) "no shell ran the '&' payload - the injection canary is absent"

        # 4. HKCU registration alone is enough to trip the engine-level gate,
        #    even when the binary itself sits somewhere only admins can write.
        $lolbin = Invoke-Engine "run-uninstaller" @{
            executable     = (Join-Path $env:SystemRoot "System32\cmd.exe")
            baseArgs       = ""
            arguments      = "/c echo pwned > `"$injCanary`""
            registryPath   = $injPath
            timeoutSeconds = 5
            acknowledged   = $false
        }
        Assert-True ($lolbin.blocked -eq $true)              "an HKCU entry naming a system binary is blocked, not just user-writable ones"
        Assert-True (-not (Test-Path -LiteralPath $injCanary)) "the LOLBin attempt left no canary either"
    } finally {
        if (Test-Path -LiteralPath $injKey) { Remove-Item -LiteralPath $injKey -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # ==================================================================
    # SEC-1: the UWP branch no longer builds a command line
    # ==================================================================
    Write-Host ""
    Write-Host "SEC-1 - Store package removal takes a package name, not a command" -ForegroundColor Cyan

    $appxCanary = Join-Path $canary "sec1-appx-canary.txt"
    if (Test-Path -LiteralPath $appxCanary) { Remove-Item -LiteralPath $appxCanary -Force }

    $bad = Invoke-Engine "remove-appx" @{ packageFullName = "Foo_1.0.0.0_x64__abc & echo pwned > `"$appxCanary`"" }
    Assert-True ($bad.success -eq $false)                    "a package name carrying shell metacharacters is refused"
    Assert-True ($bad.error -match 'not a valid package full name') "the refusal is the shape check, before any cmdlet call"

    $missing = Invoke-Engine "remove-appx" @{ packageFullName = "NotInstalled.Vanish_1.0.0.0_x64__8wekyb3d8bbwe" }
    Assert-True ($missing.success -eq $false)                "a well-formed but uninstalled package is refused"

    $empty = Invoke-Engine "remove-appx" @{ packageFullName = "" }
    Assert-True ($empty.success -eq $false)                  "an empty package name is refused"

    Start-Sleep -Milliseconds 300
    Assert-True (-not (Test-Path -LiteralPath $appxCanary))  "no shell ran the appx payload - the canary is absent"

    # ==================================================================
    # SEC-1: static guarantee - no shell in the main process at all
    # ==================================================================
    Write-Host ""
    Write-Host "SEC-1 - the main process imports no shell-executing API" -ForegroundColor Cyan

    # Comment lines are stripped so the commentary describing the old bug does
    # not trip the check that the old bug is gone.
    $mainCode = @(Get-Content -LiteralPath (Join-Path $root "main.js") |
                  Where-Object { $_ -notmatch '^\s*(//|\*|/\*)' }) -join "`n"
    Assert-True ($mainCode -notmatch 'exec\s*\(')             "main.js has no exec() call site"
    Assert-True ($mainCode -notmatch '\bexecSync\b')          "main.js has no execSync() call site"
    Assert-True ($mainCode -notmatch 'require\([''"]node:child_process[''"]\)[^\r\n]*\bexec\b') "main.js does not import exec from child_process"

}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host ("Result: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -gt 0) { "Red" } else { "Green" })
exit ([int]($script:fail -gt 0))
