# Vanish: Roadmap & Future Development Plan

This document details the multi-stage roadmap for Vanish, outlining upcoming milestones, technical implementations, and research paths.

---

## 🗺️ Development Phases

```mermaid
graph TD
    P1[Stage 1: Core MVP] --> P2[Stage 2: Audit & Health]
    P2 --> P3[Stage 3: Task Manager & Unlocker]
    P3 --> P4[Stage 4: Search & Destroy]
    P4 --> P5[Stage 5: Threat Intelligence]
    P5 --> P6[Stage 6: Orchestration & Shell Cleanup]
    P6 --> P7[Stage 7: Network & Disk Optimization]
    P7 --> P8[Stage 8: Installation Sandbox]
    P8 --> P9[Stage 9: System Integration & Environment Clean]
    P9 --> P10[Stage 10: Enterprise Audits & Offset Rules]
```

### Stage 1: Core MVP (Current Status)
* **Status**: Completed.
* **Deliverables**: Registry & UWP package mapping, System Restore Point triggers, Safe/Moderate/Advanced scanning heuristics, and remnant deletion.

### Stage 2: Audit & Health Advisor UI
* **Goal**: Provide a detailed overview of the system's software health and resource utilization.
* **Technical Tasks**:
  * **Asynchronous Sizing Worker**: Run a background thread to calculate physical folder sizes and cache them to disk.
  * **Boot Speed Analyzer**: Inspect registry `Run` hives (`HKCU/HKLM\Software\Microsoft\Windows\CurrentVersion\Run`), Task Scheduler (`Get-ScheduledTask`), and active Services to identify applications running on startup and calculate their startup latency impact.
  * **Consolidation Engine**: Detect redundant software (e.g. multiple web browsers, matching PDF readers) and alert the user.

### Stage 3: Task Manager & "Unlocker" Integration
* **Goal**: Enable process management, resource tracking, and file/folder handle releasing (the "Unlocker" feature).
* **Technical Tasks**:
  * **Process Monitor**: A real-time process manager detailing CPU, Memory, Disk, and Network utilization.
  * **Native Handle Locking Resolver (Unlocker)**:
    * *Implementation*: We will invoke the native **Windows Restart Manager API** (`rstrtmgr.dll`) via inline C# compile inside PowerShell (`Add-Type`).
    * *API Sequence*:
      1. `RmStartSession`: Start a Restart Manager session.
      2. `RmRegisterResources`: Register the target locked file or folder path.
      3. `RmGetList`: Query all processes (Process IDs and Names) currently holding locks on the registered resource.
      4. `RmShutdown`: Trigger a clean shutdown request to those processes, falling back to forceful process termination (`Stop-Process -Id <PID> -Force`) if they fail to close.
    * *Benefit*: 100% native, requires no external executables, and handles locks safely.

### Stage 4: Search & Destroy Keyword Purge
* **Goal**: Allow users to enter arbitrary app names or folders to run a deep-scan cleanup, even if the application does not have a registry uninstaller entry.
* **Technical Tasks**:
  * Input a custom application keyword (e.g., "Slack") and a publisher keyword (e.g., "Slack Technologies").
  * Run the `Scan-Leftovers` engine with the keywords, displaying files/registry keys found in common system paths.
  * Safely purge the elements upon approval.

### Stage 5: Threat Intelligence Hunting Model
* **Goal**: Identify and mitigate destructive, malicious, or highly suspicious application behaviors.
* **Technical Tasks**:
  * **Signature-Based Hunting**: Run MD5/SHA256 hashing on startup executables and check them against local rule definitions or external Threat Intelligence APIs.
  * **Behavioral Heuristics (Process Spawning)**:
    * Detect suspicious process trees (e.g., Microsoft Word spawning `powershell.exe` or `cmd.exe`).
    * Flag active programs executing destructive commands, such as attempts to delete volume shadow copies (`vssadmin delete shadows`) or edit host DNS files.
  * **Persistence Scan**: Check common malware persistence paths (e.g., Winlogon Shell modifications, AppInit_DLLs, browser helper objects).
  * **Integration with YARA**: Run lightweight YARA file pattern scans on suspicious directories.

### Stage 6: Orchestration & Shell Cleanup
* **Goal**: Enable bulk uninstallation and clean left-behind Windows shell context menus.
* **Technical Tasks**:
  * **Bulk Silent Uninstaller**: Group multiple uninstallation requests and run them sequentially (using native switches like `/qn` or `/S`) while trapping exit codes to block on reboot requirements.
  * **Context Menu Cleaner**: Scan registry keys (under `HKCR\*\shellex\ContextMenuHandlers` and related classes) for orphaned CLSID associations linked to removed executables and clean them up.

### Stage 7: Network & Disk Optimization
* **Goal**: Provide active network monitoring, firewall control, and temporary junk file cleaning.
* **Technical Tasks**:
  * **Network Inspector**: List active sockets per application and resolve destination IP addresses.
  * **Firewall Controller**: Enable one-click firewall blocking rules via PowerShell (`New-NetFirewallRule`) to cut off internet access for suspicious programs.
  * **Junk Sweeper**: Scan and delete cache repositories, temp files, crash dumps, and leftover Windows Update downloads.

### Stage 8: Installation Sandbox Rollback (The Complete End-to-End)
* **Goal**: Allow users to monitor installer executions in real-time to enable 100% complete rollbacks.
* **Technical Tasks**:
  * **Snapshot Scanner**: Capture system folder and registry states immediately before and after running a custom installer, tracking diff logs.
  * **Installation Logger**: Generate an isolated log file detailing every registry write, file addition, and driver registration performed by the program installer.
  * **Total Rollback Purge**: Offer a one-click rollback that reverts every change logged, ensuring zero leftover traces.

### Stage 9: System Integration & Environment Clean
* **Goal**: Purge orphaned system services, driver repositories, path variables, and file associations.
* **Technical Tasks**:
  * **Services & Drivers Purge**: Query registry service trees and remove leftover entries using `Remove-Service` or `sc.exe delete`, clean third-party driver store files via `pnputil /delete-driver`.
  * **PATH Environment Cleaner**: Scan user and system scope `PATH` environment variables using the `[System.Environment]` API, executing `Test-Path` check passes to filter out dead directories and remove redundant values.
  * **File Association & Protocol Repair**: Scan `Explorer\FileExts` registry hives, identifying broken CLSID handlers pointing to deleted executables, and purge dead file/protocol links.

### Stage 10: Enterprise Audits & Offset Rules
* **Goal**: Scrub advanced enterprise database relics and incorporate community mapping offsets.
* **Technical Tasks**:
  * **DCOM & WMI Namespace Cleanup**: Scan for orphaned WMI classes and DCOM app registrations referencing missing executables, cleaning the keys to prevent event log error noise.
  * **Event Log Channel Cleaner**: Clean orphaned application log channels registered under `EventLog` keys.
  * **Crowdsourced Offsets Database**: Load a community-driven JSON heuristics rules database to automatically map atypical directories that do not match application names (such as hidden `.config`, `.toolcache`, or `.unity3d` folders).

---

## ⚖️ Open Source & License Assessment

### 1. Is Open Source & Free a Good Idea?
**Yes, absolutely.**
* **Security & Administrative Trust**: Uninstallation utilities require highest administrative permissions (`requireAdministrator` privileges) to operate. Users are naturally cautious of closed-source applications requiring root access. Making Vanish open-source ensures **full code transparency**, proving to developers and security professionals that the app contains no hidden telemetry, ads, or backdoors.
* **Community-Driven Heuristics**: Software developers change installation structures constantly. An open-source model allows the community to contribute new scanning rules and file lock workarounds.
* **Premium UX Competitiveness**: The existing FOSS options are visually outdated. A sleek, modern glassmorphic application will quickly capture developer attention.

### 2. Can We Use Existing FOSS Solutions to Accelerate Development?
Yes. We should review and leverage these notable open-source projects:
* **BCUninstaller (Bulk Clog Uninstaller)**:
  * *What it is*: A feature-rich .NET application for bulk software uninstallation.
  * *How to use it*: BCUninstaller has a highly mature registry heuristic engine. We can reference its matching rules for publisher/app clustering to refine our Moderate and Advanced scan modes.
* **System Informer (formerly Process Hacker)**:
  * *What it is*: A powerful open-source process manager and handle inspector.
  * *How to use it*: We can study its C-based native handle querying logic to optimize our "Unlocker" C# implementation.
* **YARA (VirusTotal)**:
  * *What it is*: A pattern-matching Swiss Army knife for security researchers.
  * *How to use it*: We can include the YARA DLL or node bindings to scan executable files against standard security rule files locally.
