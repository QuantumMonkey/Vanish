# Vanish Docs: Corrections Report

Covers all five markdown files reviewed: `research.md`, `CHANGELOG.md`, `docs/architecture.md`, `docs/handoff.md`, `docs/roadmap.md`. Each fix is formatted as a direct find-and-replace with rationale.

---

## `research.md`

### Fix 1 — BCUninstaller mechanism description
**Location**: Q: How does BCUninstaller (BCU) identify file and registry leftovers safely?

**Find**:
```
utilizing shared-publisher validation checks to prevent deleting parent folders of active co-installed programs.
```
**Replace with**:
```
comparing publisher GUIDs and InstallLocation paths across all co-installed programs to preserve shared parent directories.
```
**Reason**: "Shared-publisher validation checks" is not a real BCU concept. The actual mechanism is cross-referencing publisher metadata between co-installed entries before marking a folder for deletion.

---

### Fix 2 — YARA on Windows claim
**Location**: Q: How can we run YARA pattern matching on Windows in a Node/Electron host?

**Find**:
```
Native Node YARA npm packages fail to compile on Windows; we must bundle the official prebuilt Windows YARA binaries (`yara.exe`) and invoke them directly via Node's `child_process` execution.
```
**Replace with**:
```
Native Node YARA bindings (e.g. `node-yara-rs`) can compile on Windows with the appropriate build toolchain, but building native addons in an Electron distribution is fragile. For reliability, Vanish bundles the official prebuilt Windows YARA binary (`yara64.exe`) and invokes it via Node's `child_process`. This is a deliberate simplicity tradeoff, not an inherent platform limitation. Note: Vanish ships the YARA engine only. Rule files are user-supplied. See `docs/promptgate.md` Rule 5.
```
**Reason**: The blanket claim that native packages fail on Windows is inaccurate. The shell-out decision is valid but must be framed as a choice, not a constraint. The rules licensing note is new and mandatory.

---

### Fix 3 — UAC elevation check method
**Location**: Q: How does Vanish automatically request UAC elevation if launched by an unelevated user?

**Find**:
```
We check elevation status on startup via `net session`
```
**Replace with**:
```
We check elevation status on startup using `[Security.Principal.WindowsPrincipal]::IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
```
**Reason**: `net session` parses error output and produces false positives in enterprise environments with restricted net commands. The `WindowsPrincipal` API is the canonical PowerShell method.

---

### Fix 4 — BCU handle logic description in FOSS tools summary
**Location**: Q: What FOSS tool assists in building a superior handle/socket Task Manager? (Report line)

**Find**:
```
System Informer (handle hijacked closing logic)
```
**Replace with**:
```
System Informer (handle-release logic via handle duplication and remote closure)
```
**Reason**: "Handle hijacked closing logic" is grammatically broken and misleading. The technique is duplicating the handle with `DUPLICATE_CLOSE_SOURCE` to close it remotely in the source process.

---

### Fix 5 — Conflated FOSS/UX adoption argument
**Location**: Q: Is keeping Vanish open-source and free a good strategic decision?

**Find**:
```
FOSS enables community-driven updates to installer heuristic patterns while a premium UX attracts developer adoption.
```
**Replace with**:
```
FOSS enables community-driven updates to installer heuristic patterns. A premium UX differentiates Vanish from visually outdated existing tools and drives adoption among developers who encounter it.
```
**Reason**: Two separate propositions crammed into one sentence with a weak "while" connector. They make better sense separated.

---

### Fix 6 — TaskExplorer attribution
**Location**: Q: What FOSS tool assists in building a superior handle/socket Task Manager?

**Find**:
```
TaskExplorer (by DavidXanatos), a Qt/C++ tool built on the System Informer (Process Hacker) core
```
**Replace with**:
```
TaskExplorer (by DavidXanatos), a Qt/C++ tool that shares architectural concepts with System Informer (Process Hacker) and uses parts of its SDK
```
**Reason**: TaskExplorer is not a downstream fork of System Informer. "Built on the core" implies a tighter dependency than exists.

---

### Fix 7 — Add license field to all FOSS tool entries
**Location**: All Q entries referencing FOSS tools (BCUninstaller, System Informer, TaskExplorer, OpenArk, PE-sieve/HollowsHunter, BleachBit, winget-cli, DDU, PowerToys, YARA)

**Action**: Append a `- **License**:` line to each tool's Report block. Values:

| Tool | License |
|------|---------|
| BCUninstaller | GPLv3 |
| System Informer | MIT |
| TaskExplorer | GPLv3 |
| OpenArk | GPLv3 |
| PE-sieve / HollowsHunter | BSD 2-Clause |
| BleachBit (CleanerML) | GPLv3 |
| winget-cli | MIT |
| Display Driver Uninstaller | Freeware (closed source) |
| Microsoft PowerToys | MIT |
| YARA engine | BSD 3-Clause |

**Reason**: See `docs/promptgate.md` Rule 11. GPL tools cannot have code or rule sets bundled into a proprietary tier. License must be visible at the point of reference.

---

### Fix 8 — Remove Threat Intelligence Q entries
**Location**: Any Q entries referencing MalwareBazaar lookups, Community Threat Submission, or cloud-based file hash queries.

**Action**: Delete those entries entirely. Replace with a single note at the top of the file:

```
> **Note**: Cloud-based threat intelligence lookups and community threat submission features have been removed from the Vanish scope. See `docs/promptgate.md` Rule 6 for rationale. Passive local behavioral heuristics (suspicious process tree indicators) remain in scope as part of Stage 3.
```

---

---

## `CHANGELOG.md`

### Fix 1 — Typo: "sort sorting"
**Location**: `## [1.0.0]` → State Controller bullet

**Find**:
```
Mapped concurrent app loading, sort sorting (by Name, Date, Size)
```
**Replace with**:
```
Mapped concurrent app loading, sort controls (by Name, Date, Size)
```

---

### Fix 2 — Vague term: "Frameless browser settings"
**Location**: `## [1.0.0]` → Electron Main Process bullet

**Find**:
```
Frameless browser settings, net session admin checking, native exec calls, and secure IPC bridges.
```
**Replace with**:
```
Frameless window configuration (`frame: false`), admin elevation checking via WindowsPrincipal API, native PowerShell exec calls, and secure IPC bridges.
```

---

### Fix 3 — Capitalisation: "xml"
**Location**: `## [1.0.0]` → PowerShell Execution Engine bullet

**Find**:
```
UWP Store app mapping with friendly name xml parsing
```
**Replace with**:
```
UWP Store app mapping with friendly name XML parsing
```

---

---

## `docs/architecture.md`

### Fix 1 — Capitalisation: "Javascript"
**Location**: Technical Stack section

**Find**:
```
HTML5, Vanilla CSS3 (Custom Orbit Glassmorphic Dark Theme), ES6 Javascript.
```
**Replace with**:
```
HTML5, Vanilla CSS3 (Custom Orbit Glassmorphic Dark Theme), ES6 JavaScript.
```

---

### Fix 2 — Spelling error: "tempering" → "tampering"
**Location**: Counter-Malware & Threat Auditing Architecture → Point 3

**Find**:
```
verifies Authenticode digital signatures on target DLLs/EXEs to detect injection, tempering, or corrupt binaries.
```
**Replace with**:
```
verifies Authenticode digital signatures on target DLLs/EXEs to detect injection, tampering, or corrupt binaries.
```
**Reason**: "Tempering" means adjusting temperature. In a security context this is a meaningful error.

---

### Fix 3 — MD5 as integrity mechanism
**Location**: Counter-Malware & Threat Auditing Architecture → Point 3

**Find**:
```
Executes cryptographic hashing (MD5/SHA256)
```
**Replace with**:
```
Executes file integrity hashing (SHA256). MD5 is used only for legacy cross-reference lookups against older threat databases, not for integrity verification.
```
**Reason**: MD5 is cryptographically broken and should not be listed as a primary integrity mechanism without a caveat.

---

### Fix 4 — Mermaid diagram missing language tag
**Location**: System Architecture section

**Find**:
````
```
graph LR
````
**Replace with**:
````
```mermaid
graph LR
````
**Reason**: Without the `mermaid` tag GitHub renders the block as raw plaintext. The diagram does not display.

---

### Fix 5 — Replace Threat Auditing section scope
**Location**: `## 🛡️ Counter-Malware & Threat Auditing Architecture` section

**Action**: Retitle section and replace Points 1-4 with the following:

```markdown
## 🛡️ Suspicious Activity Indicators (Passive Local Only)

Vanish does not function as an antivirus and does not perform cloud-based threat lookups. Users are expected to maintain their own AV solution. Vanish provides a passive local display of suspicious behavioral patterns to surface to the user for investigation. No automated action is taken on any finding.

Indicators displayed in the Task Manager view (Stage 3):

1. **Suspicious Process Trees**: Flags office applications or document viewers spawning command interpreters (`cmd.exe`, `powershell.exe`, `wscript.exe`).
2. **Destructive Command Patterns**: Flags active processes issuing known destructive commands (e.g. `vssadmin delete shadows`, host file edits).
3. **Persistence Path Display**: Lists entries found in known persistence locations (Registry Run keys, Task Scheduler, AppInit_DLLs, Winlogon Shell) for user review — not auto-removal.

All findings are labelled as "indicators to investigate with your antivirus." Vanish surfaces; AV decides.

See `docs/promptgate.md` Rules 6 and 7.
```

---

### Fix 6 — Add Scan Mode architecture note
**Location**: After `## 2. Deep-Clean Scanner` section

**Add**:
```markdown
### Scan Mode Design Principle

Discovery Depth and Deletion Policy are independent controls and must remain architecturally separate.

- **Discovery Depth** (Safe / Moderate / Advanced): Controls how aggressively Vanish searches for remnants.
- **Deletion Policy** (Review / Auto-purge confirmed orphans): Controls what happens with findings.

A user may run Advanced discovery and still review every finding before any deletion occurs. These axes must never be coupled. See `docs/promptgate.md` Rule 1.
```

---

### Fix 7 — Add Quarantine-First principle note
**Location**: After the Scan Mode Design Principle addition above

**Add**:
```markdown
### Quarantine-First Deletion Policy

No destructive operation in Vanish deletes directly. All removals follow a quarantine-first model:

- Files are moved to a versioned quarantine vault before deletion.
- Registry entries are logged to a restore manifest before removal.
- Quarantine auto-purge is user-controlled and off by default.

This applies to all cleanup operations: MSI caches, WMI entries, orphaned services, SharedDLLs, fonts, and file associations. See `docs/promptgate.md` Rule 2.
```

---

### Fix 8 — Add Audit Mode (unelevated) description
**Location**: `## 🖥️ Windows OS Support Policy` section — add before it

**Add**:
```markdown
## Elevation & Capability Tiers

Vanish operates in one of two capability tiers depending on elevation state:

- **Audit Mode** (unelevated): Read-only. App listing, scan result display, and report generation are available. No destructive operations. UI displays a persistent banner: *"Running in Audit Mode — elevate to enable cleaning and uninstallation."*
- **Full Mode** (elevated): All features available.

If the user declines the UAC prompt, Vanish falls back to Audit Mode gracefully. It never silently exits or crashes on a declined elevation request. See `docs/promptgate.md` Rule 3.
```

---

### Fix 9 — Label performance targets correctly
**Location**: `## Performance & Resource Targets` section header

**Find**:
```
Vanish maintains a lightweight, non-intrusive system footprint.
```
**Replace with**:
```
Vanish targets a lightweight, non-intrusive system footprint. The figures below are design targets, not validated benchmarks. Validated benchmarks with documented test conditions will be published in `BENCHMARKS.md` prior to public release. See `docs/promptgate.md` Rule 9.
```

---

### Fix 10 — Add Definition Packs architecture note
**Location**: `## Technical Stack` section — add after the Communication Channel bullet

**Add**:
```markdown
- **Definition Packs**: BCU heuristic rules, CleanerML definitions, and YARA rule files are not bundled with the application binary. They are downloaded separately as community definition packs at user request. This maintains a clean GPL boundary and protects any future proprietary tier. See `docs/promptgate.md` Rules 4 and 11.
```

---

---

## `docs/handoff.md`

### Fix 1 — Remove local filesystem path
**Location**: Project Overview section

**Find**:
```
- **Repository Location**: `d:\quickhelp projects\vanish-uninstaller`
```
**Replace with**:
```
- **Repository Location**: `https://github.com/QuantumMonkey/Vanish`
```
**Reason**: Local paths expose developer environment structure in a public repository and become stale immediately for any contributor.

---

### Fix 2 — Update elevation check reference
**Location**: File Structure Map → main.js description

**Find**:
```
elevation queries (`net session`)
```
**Replace with**:
```
elevation queries (WindowsPrincipal API — see `docs/promptgate.md` Rule 13)
```

---

### Fix 3 — Add per-file status indicators
**Location**: `## 📁 File Structure Map` section

**Action**: Append `*(Status: ...)*` to each file entry. Current known states:

```
- **package.json**: ... *(Status: Complete)*
- **main.js**: ... *(Status: Complete — MVP functional)*
- **preload.js**: ... *(Status: Complete — MVP functional)*
- **index.html**: ... *(Status: Complete — MVP functional)*
- **index.css**: ... *(Status: Complete — MVP functional)*
- **renderer.js**: ... *(Status: Complete — MVP functional)*
- **scanner.ps1**: ... *(Status: Complete — MVP functional)*
```

---

### Fix 4 — Add promptgate reference and Stages 6+ pointer
**Location**: `## 🔍 Next Steps & Roadmap Checklist` — add at the top of this section

**Add**:
```markdown
> **Before planning, speccing, or implementing any feature**, run it through `docs/promptgate.md`. All decisions must pass the gate before work begins.

> **For Stages 6–14** (Orchestration, Network, Sandbox, Environment Clean, Enterprise Audits, Cache Purge, Telemetry, Runtime/Driver Audit, CleanerML Engine), refer to `docs/roadmap.md`. The checklist below covers Core tier stages only.
```

---

### Fix 5 — Expand checklist with tier labels
**Location**: `## 🔍 Next Steps & Roadmap Checklist` items

**Action**: Add tier labels and expand to cover all Core stages:

```markdown
**Core Tier** (complete before any public release):

- `[ ]` **Stage 2 — Audit & Health Advisor Tab**: Interactive scorecard: unused software, reclaimable space, boot-up impact. *(Core)*
- `[ ]` **Stage 3 — Task Manager & Unlocker**: Process list with CPU/Memory/Disk, file handle inspector, Suspicious Activity Indicators display, Watchdog Suspension. *(Core)*
- `[ ]` **Stage 6 — Orchestration & Shell Cleanup**: Bulk silent uninstaller, context menu cleaner, MSI service lockout manager, restore point frequency override. *(Core)*
- `[ ]` **Stage 9 — System Integration & Environment Clean**: Services/drivers purge, PATH cleaner, file association repair, multi-user profile registry sweep, auto-UAC relauncher, registry redirection bypass. *(Core)*

**Standard and Extended tiers**: See `docs/roadmap.md`.
```

---

---

## `docs/roadmap.md`

### Fix 1 — Mermaid diagram missing language tag
**Location**: Development Phases diagram

**Find**:
````
```
graph TD
````
**Replace with**:
````
```mermaid
graph TD
````

---

### Fix 2 — Duplicate word: "registry registry"
**Location**: Stage 6 → Restore Point Frequency Override bullet

**Find**:
```
the `SystemRestorePointCreationFrequency` registry registry value
```
**Replace with**:
```
the `SystemRestorePointCreationFrequency` registry value
```

---

### Fix 3 — Remove Stage 5: Threat Intelligence Hunting Model
**Location**: `### Stage 5: Threat Intelligence Hunting Model` — entire section

**Action**: Delete the entire Stage 5 section. Replace with:

```markdown
### Stage 5: Suspicious Activity Indicators *(Merged into Stage 3)*

> **Removed**: Cloud-based threat intelligence lookups, MalwareBazaar API queries, and the Community Threat Submission wizard have been permanently cut from scope. See `docs/promptgate.md` Rule 6 for rationale.
>
> The behavioral heuristics components (suspicious process tree detection, destructive command flagging, persistence path display) are retained as a passive local display within the Stage 3 Task Manager view. No dedicated Stage 5 exists. Roadmap stage numbers are preserved as-is to avoid reference confusion.
```

---

### Fix 4 — System Informer language: "C-based" → "C/C++-based"
**Location**: Open Source section → System Informer entry

**Find**:
```
We can study its C-based native handle querying logic
```
**Replace with**:
```
We can study its C/C++-based native handle querying logic
```

---

### Fix 5 — YARA attribution
**Location**: Open Source section → YARA entry heading

**Find**:
```
**YARA (VirusTotal)**
```
**Replace with**:
```
**YARA** (originally by Victor Alvarez; maintained as an open-source project with VirusTotal as a major contributor)
```

---

### Fix 6 — Add winget caveat
**Location**: Open Source section → winget-cli entry, "How to use it" line

**Find**:
```
We can query the winget open-source manifest database to retrieve silent installation/uninstallation arguments and switches.
```
**Replace with**:
```
We can query the winget open-source manifest repository as a primary source for silent installer arguments. Note: uninstaller switch coverage in winget manifests is inconsistent — many entries are missing or incorrect. The lookup chain is: (1) winget manifest, (2) project-maintained corrections JSON, (3) heuristic fallback sequence (`/qn` → `/S` → `--silent` → `-quiet`). See `docs/promptgate.md` Rule 15.
```

---

### Fix 7 — Add Stage 10 mandatory review gate note
**Location**: `### Stage 10: Enterprise Audits & Offset Rules` → DCOM & WMI Namespace Cleanup bullet

**Find**:
```
Scan for orphaned WMI classes and DCOM app registrations referencing missing executables, cleaning the keys to prevent event log error noise.
```
**Replace with**:
```
Scan for orphaned WMI classes and DCOM app registrations referencing missing executables. **Mandatory UI review gate required before any deletion.** Auto-deletion of WMI entries is permanently disabled by default. The UI must show an expandable list of every entry found, with individual checkboxes, before any action is taken. A quarantine manifest is generated before removal. See `docs/promptgate.md` Rule 17.
```

---

### Fix 8 — Add priority tier table
**Location**: After `## 🗺️ Development Phases` diagram, before Stage 1

**Add**:
```markdown
## Stage Priority Tiers

| Tier | Stages | Condition |
|------|--------|-----------|
| **Core** | 1, 2, 3, 6, 9 | Must complete before any public release |
| **Standard** | 4, 7, 8, 11, 12, 14 | Ships in v1.x post-launch |
| **Extended** | 10, 13 | Future milestones, no committed timeline |

Do not begin Standard work until all Core stages are complete and tested on clean Windows 10 and Windows 11 VMs. Do not commit Extended stages to any public timeline. See `docs/promptgate.md` Rule 16.
```

---

### Fix 9 — Add licensing deferred note
**Location**: `## ⚖️ Open Source & License Assessment` → end of Monetization section

**Add**:
```markdown
**Licensing Implementation Note**: Commercial license enforcement is deferred post-MVP per design decision in `research.md`. When implemented, it will be added as a wrapper module in `main.js` using cryptographic key validation with hardware-bound token caching. Track as a separate milestone after all Core tier stages are complete and early traction is established.
```

---

### Fix 10 — Add definitions loader model note
**Location**: `### 2. Can We Use Existing FOSS Solutions` section — add at the top

**Add**:
```markdown
> **Important**: No FOSS tool's code, rule files, or definition databases are bundled directly with the Vanish application binary. All definitions (BCU heuristic rules, CleanerML files, YARA rules) are downloaded as separate community packs at user request. This maintains a clean GPL boundary. See `docs/promptgate.md` Rules 4 and 11.
```

---

---

## Cross-File: Missing Files

### Create `README.md` at repo root
Required before any public announcement or link-sharing. Minimum content:

```markdown
# Vanish

Modern Windows application manager and deep-cleaning uninstaller.

[Screenshot placeholder]

## Tech Stack
- Electron + Node.js (host)
- PowerShell 5.1+ (execution engine)
- Vanilla HTML/CSS/JS (UI)

## Requirements
- Windows 10 (1607+) or Windows 11
- PowerShell 5.1+
- Node.js 18+

## Build & Run
Must be run with administrative privileges.

```powershell
# In an elevated PowerShell or Command Prompt:
cd path\to\vanish
npm install
npm start
```

## Documentation
- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Development Rules](docs/promptgate.md)
- [LLM Handoff](docs/handoff.md)
- [Research Log](research.md)
- [Changelog](CHANGELOG.md)
```

### Create `BENCHMARKS.md` at repo root
Placeholder until validated figures exist:

```markdown
# Vanish: Performance Benchmarks

Benchmarks are pending validation. Design targets are documented in `docs/architecture.md`.

Results will be added here with the following test conditions documented per run:
- CPU model
- RAM (GB)
- Storage type (HDD / SATA SSD / NVMe)
- Number of installed applications
- Windows version and build
- Cold vs warm run
```

### Create `RELEASING.md` at repo root

```markdown
# Vanish: Release Checklist

## Code Signing (Hard Gate)
Unsigned builds are for local development only.
No unsigned binary is distributed externally under any circumstances,
including pre-release and beta builds.

- [ ] EV or OV code signing certificate obtained
- [ ] All distributed binaries signed before packaging
- [ ] SmartScreen reputation impact acknowledged (OV cert requires reputation build-up period)

## Pre-Release Verification
- [ ] All Core tier stages tested on clean Windows 10 VM (build 1607+)
- [ ] All Core tier stages tested on clean Windows 11 VM
- [ ] Performance targets validated and logged in BENCHMARKS.md
- [ ] README.md up to date with current screenshots
- [ ] CHANGELOG.md updated
- [ ] No local filesystem paths present in any doc file
- [ ] All Mermaid diagrams rendering correctly on GitHub
```
