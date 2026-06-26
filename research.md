# Vanish: Research Log & Audit Trail

This document logs key research findings, design questions, considerations, and tool analysis to serve as a permanent trail and prevent duplicate efforts.

---

* **Q: How does BCUninstaller (BCU) identify file and registry leftovers safely?**
  * **Report**: BCU uses a C#-based heuristic engine that scans common system locations for items containing the target application's name or GUID, utilizing shared-publisher validation checks to prevent deleting parent folders of active co-installed programs.

* **Q: How does System Informer (formerly Process Hacker) release file handles / locks?**
  * **Report**: System Informer hijacks handles by calling `DuplicateHandle`/`NtDuplicateObject` on the target locking process and passing the `DUPLICATE_CLOSE_SOURCE` (0x01) flag to close the handle in the source process remotely.

* **Q: How can we run YARA pattern matching on Windows in a Node/Electron host?**
  * **Report**: Native Node YARA npm packages fail to compile on Windows; we must bundle the official prebuilt Windows YARA binaries (`yara.exe`) and invoke them directly via Node's `child_process` execution.
