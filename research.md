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


