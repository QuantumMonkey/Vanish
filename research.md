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

