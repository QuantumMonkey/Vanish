# Vanish: Research Log & Audit Trail

This document logs key research findings, design questions, considerations, and tool analysis to serve as a permanent trail and prevent duplicate efforts.

---

* **Q: How does BCUninstaller (BCU) identify file and registry leftovers safely?**
  * **Report**: BCU uses a C#-based heuristic engine that scans common system locations for items containing the target application's name or GUID, utilizing shared-publisher validation checks to prevent deleting parent folders of active co-installed programs.

* **Q: How does System Informer (formerly Process Hacker) release file handles / locks?**
  * **Report**: System Informer hijacks handles by calling `DuplicateHandle`/`NtDuplicateObject` on the target locking process and passing the `DUPLICATE_CLOSE_SOURCE` (0x01) flag to close the handle in the source process remotely.

* **Q: How can we run YARA pattern matching on Windows in a Node/Electron host?**
  * **Report**: Native Node YARA npm packages fail to compile on Windows; we must bundle the official prebuilt Windows YARA binaries (`yara.exe`) and invoke them directly via Node's `child_process` execution.

* **Q: Is keeping Vanish open-source and free a good strategic decision?**
  * **Report**: Yes; administrative root access requires transparency to establish trust, and FOSS enables community-driven updates to installer heuristic patterns while a premium UX attracts developer adoption.

* **Q: What FOSS tools can accelerate the core MVP development?**
  * **Report**: BCUninstaller (leftover heuristic matching rules), System Informer (handle hijacked closing logic), and YARA (malware rule signature integration).

* **Q: What FOSS tool assists in building a superior handle/socket Task Manager?**
  * **Report**: TaskExplorer (by DavidXanatos), a Qt/C++ tool built on the System Informer (Process Hacker) core, which specializes in real-time socket and open-handle process monitoring.

* **Q: What FOSS tool assists in building a kernel-level ARK monitoring engine?**
  * **Report**: OpenArk (by BlackINT3), an anti-rootkit utility written in C++ that handles deep system hotkeys, driver callbacks, filter tables, and kernel handle manipulation.

* **Q: What FOSS tool assists in detecting fileless in-memory process injection threats?**
  * **Report**: PE-sieve and HollowsHunter (by hasherezade), which inspect running processes for code hollowing, reflective DLL loading, and memory hooks, and dump anomalous regions for forensics.

* **Q: How does a Force Uninstall handle corrupted or partially installed applications?**
  * **Report**: It purges the local cached MSI files, removes product registry entries under Windows Installer UserData registry trees, and wipes remnants from the GAC/Assembly folders.

* **Q: How can we implement safe bulk uninstallation orchestration on Windows?**
  * **Report**: We queue and execute them sequentially (due to MSI service locks) using silent CLI arguments (`/qn`, `/S`) while monitoring sub-process exit codes to flag pending reboots.

* **Q: How can we verify application integrity and spot corrupt files?**
  * **Report**: We check for broken shortcuts, missing dependencies, and execute digital signature verification on internal DLL/EXE binary files to verify if they are altered or corrupted.

* **Q: How can we clean left-behind Explorer shell extension context menu items?**
  * **Report**: We scan for orphaned COM CLSIDs registered under `HKCR\*\shellex\ContextMenuHandlers` and related classes, cleaning the keys to prevent Explorer crashes.

* **Q: How do we inspect and disable startup hooks and services?**
  * **Report**: We inspect registry Run keys, scheduled tasks, active system services, and startup folders to list persistence points and allow toggling them off.

* **Q: How can we monitor process network sockets and block destructive apps?**
  * **Report**: We query active sockets to list open ports/destinations, allowing users to block target executables instantly in Windows Defender Firewall via `New-NetFirewallRule`.

* **Q: How can we build a cache/junk cleaning tool to save disk space?**
  * **Report**: We run cleaning passes scrubbing system temp directories (`$env:TEMP`), log files, dump caches, browser storage, and Windows update store remnants.

* **Q: How can we monitor installations in real-time to enable 100% complete rollback?**
  * **Report**: We compare filesystem and registry snapshots before and after installation, or hook native API calls, to log modifications and support full reversion.

* **Q: How can we clean orphaned system services and kernel drivers safely?**
  * **Report**: We delete services using `Remove-Service` or `sc.exe delete` keys under `HKLM\SYSTEM\CurrentControlSet\Services` and scrub driver repository packages via `pnputil.exe`.

* **Q: How do we clean up invalid or redundant PATH environment variables?**
  * **Report**: We read system/user scopes via `[System.Environment]`, split by `;`, execute `Test-Path` to filter out dead folders, and write back cleaned, unique path values.

* **Q: How do we purge abandoned file associations and protocol handlers?**
  * **Report**: We delete leftover extension keys under `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.ext` and file associations under classes to repair broken icon displays.

* **Q: How do we clean orphaned DCOM objects and custom WMI namespace registrations?**
  * **Report**: We scan for DCOM CLSIDs and WMI providers referencing missing executable paths and delete them to prevent background execution error logging.

* **Q: How can we clean left-behind custom Windows Event Log providers?**
  * **Report**: We remove registry provider registrations under `HKLM\SYSTEM\CurrentControlSet\Services\EventLog` linked to uninstalled applications to keep log pipelines clean.

* **Q: How do we scan for atypical remnants that do not match application name directories?**
  * **Report**: We integrate a community-maintained JSON rules mapping file (identifying common offsets like `.config`, `.toolcache`, `.unity3d`) to map hidden app storage directories.

* **Q: How can we safely clean orphaned local MSI/MSP installer caches?**
  * **Report**: We cross-reference files in `C:\Windows\Installer` against registry local package registries (under `HKLM\Software\Microsoft\Windows\CurrentVersion\Installer\LocalPackages`), safely moving/deleting unreferenced `.msi`/`.msp` files.

* **Q: How can we prune orphaned SharedDLL registry reference counters?**
  * **Report**: We inspect `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\SharedDLLs` value paths, running `Test-Path` checks to delete registrations pointing to missing files.

* **Q: How can we clean left-behind Jump Lists and taskbar pinned shortcut links?**
  * **Report**: We scan pinned shortcut files (`.lnk`) in the shell folders and Jump List destination folders, identifying and deleting dead links referencing missing target paths.

* **Q: How do we clean residual application AppCompat/ShimCache telemetry entries?**
  * **Report**: We clean key values matching uninstalled executable names under AppCompat Assistant stores to prevent registry bloat and telemetry errors.

* **Q: How do we remove residual Windows execution Prefetch files?**
  * **Report**: We scan `C:\Windows\Prefetch` for `.pf` files matching uninstalled application executable names and delete them to clean system run records.

* **Q: How do we clean orphaned system fonts registered in the registry?**
  * **Report**: We check registry mappings in `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` against physical files in `C:\Windows\Fonts`, clearing registry entries for missing files.

* **Q: What FOSS tool shows how to clean graphics/audio drivers deeply?**
  * **Report**: Display Driver Uninstaller (DDU) by Wagnard, which has custom safe-mode routines to purge deep OEM driver registries, kernel device maps, and DCH setup files.

* **Q: What FOSS tool shows how to programmatically audit open file handles natively?**
  * **Report**: Microsoft PowerToys' File Locksmith tool, which shows a complete C++ framework for querying the Windows system for file handles and releasing locking holds.

* **Q: What FOSS tool helps us clean cache/junk files for hundreds of apps out-of-the-box?**
  * **Report**: BleachBit's CleanerML, an XML-based markup database containing clean-up paths and globs for hundreds of apps; we can write a parser in Node to consume CleanerML files.

* **Q: What FOSS tool helps us find silent uninstallation arguments for thousands of desktop apps?**
  * **Report**: Windows Package Manager (winget-cli) by Microsoft, which houses an open-source manifest database detailing silent installer/uninstaller arguments and parameters.

* **Q: How can we identify orphaned C++ runtimes (like Visual C++) that are no longer needed?**
  * **Report**: We parse PE (Portable Executable) import directories of main application executables on disk, mapping their dynamic dependencies (e.g. `msvcr100.dll` to VC++ 2010), and flag runtimes that have no active app associations.

* **Q: How can we identify idle/unused developer or hardware drivers (like Google USB driver)?**
  * **Report**: We cross-reference active hardware devices from `Get-PnpDevice` against third-party driver packages from `Get-WindowsDriver`, flagging drivers that are installed but have no connected physical hardware.

* **Q: How can we build a transparent, no-nonsense cleanup service comparable to commercial cleaners?**
  * **Report**: We parse open-source BleachBit CleanerML definitions to clean temp files and caches, showing users exact paths and file counts to avoid misleading marketing performance claims.
* **Q: Can commercial licensing checks be deferred to a later development phase?**
  * **Report**: Yes; implementing licensing checks early slows MVP progress and alienates early adopters. We should decouple licensing, adding it later as a wrapper module once product traction is established.

* **Q: How can a Windows application programmatically detect commercial/enterprise environments?**
  * **Report**: We check Active Directory state via `(Get-CimInstance Win32_ComputerSystem).PartOfDomain` or inspect network suffix settings, triggering commercial license requirements if true.

* **Q: How can we implement secure, offline-compatible licensing validations?**
  * **Report**: We verify cryptographic license keys via call-home HTTPS requests, caching digitally signed local hardware-bound tokens in encrypted storage for offline air-gapped support.

* **Q: How do we handle Windows Installer service lockouts during bulk operations?**
  * **Report**: We check service status (`msiserver`) before running uninstalls, temporarily enabling it via `Set-Service` if disabled, and queuing tasks to wait if another installer is active.

* **Q: How do we bypass NTFS/ACL ownership blockages when deleting system remnants?**
  * **Report**: We programmatically take folder ownership (using Windows `takeown` or modifying Access Control Rules) to elevate privileges above locked `TrustedInstaller` permissions.

* **Q: How do we scan registry leftovers for all user profiles, not just the active one?**
  * **Report**: We load individual offline user hives (`NTUSER.DAT`) under temporary registry nodes using `reg.exe load`, scan/clean them, and unload them to ensure complete multi-profile coverage.

* **Q: How do we handle auto-restarting watchdog processes that re-lock files?**
  * **Report**: We suspend process execution trees (using `NtSuspendProcess` native API binds) prior to handle closing, halting watchdog auto-starts while locks are released.

* **Q: How do we mitigate the risk of corrupting Windows Installer by purging C:\Windows\Installer?**
  * **Report**: We implement a "Backup and Move" quarantine vault instead of direct deletion, allowing users to restore quarantined `.msi`/`.msp` files if an application reports errors.

* **Q: How do we optimize slow system WMI/CIM diagnostic query performance?**
  * **Report**: We request specific properties via CIM SELECT filters rather than downloading full objects, using fast registry lookups as primary caches for static hardware info.

* **Q: How does Vanish automatically request UAC elevation if launched by an unelevated user?**
  * **Report**: We check elevation status on startup via `net session`; if false, we spawn a PowerShell script using `Start-Process -Verb RunAs` to re-launch Electron with administrative rights.

* **Q: How do we bypass the 24-hour rate limit when creating System Restore Points?**
  * **Report**: We temporarily set the registry DWORD `SystemRestorePointCreationFrequency` under `HKLM\Software\Microsoft\Windows NT\CurrentVersion\SystemRestore` to `0` before checkpoint creation, reverting it afterward.

* **Q: How do we bypass automatic registry redirection when querying 32-bit (Wow6432Node) keys from 64-bit host processes?**
  * **Report**: We open registry keys explicitly using `[Microsoft.Win32.RegistryKey]::OpenBaseKey` specifying `RegistryView.Registry64` or `RegistryView.Registry32` to avoid automatic WOW64 redirection.



