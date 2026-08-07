# TRD -- Technical Requirements

> Owner doc for NFR-nn / TEC-nn ids. Cites REQ-nn (00-prd.md); owns all
> technology choices. Stack deviates from playbook S4 defaults via ADR 0001.

## Stack

| Layer | Choice | TEC id | Because | Rejected |
|---|---|---|---|---|
| Shell/runtime | Electron ^42 + Node 20 | TEC-01 | As-built, verified through Stage 2 | Tauri rewrite -- discards working code |
| UI | Vanilla JavaScript renderer, sandboxed (contextIsolation on) | TEC-02 | As-built; complexity does not justify a framework | React migration -- rework with no user value |
| System engine | PowerShell 5.1 via spawned scanner.ps1, Base64-JSON params | TEC-03 | OS support policy: PS 5.1 ships with Win10 1607+ | PS 7 dependency -- extra install burden; C# service -- overkill |
| Native interop | Add-Type inline C# inside PowerShell (Restart Manager, registry views) | TEC-04 | No external binaries; stays in the existing engine | Native Node addons -- ABI/rebuild churn per Electron version |
| Persistence | JSON files under the app data directory (no DB) | TEC-05 | Local-first, zero network (Rule 6); volumes are tiny | SQLite -- adds a native dep for kilobyte-scale data |
| Auth | None; elevation tiers only (Rule 3) | TEC-06 | Single-user desktop app | -- |
| Hosting/deploy | Signed binaries (Rule 14) + GitHub source; MS Store later | TEC-07 | ADR 0001 | Direct-sale MoR -- deferred, Store handles tax/payments |
| Payments | ~~MS Store Convenience Edition~~ **superseded 2026-08-08: personal free, commercial paid** | TEC-08 | **ADR 0002** (supersedes the payments row of ADR 0001) | Paddle/Lemon Squeezy -- still deferred; price and enforcement deliberately undecided, see ADR 0002 |

D-04: Keep all new system logic in scanner.ps1 behind the existing -Action
dispatcher. | Because: one privilege boundary, one param-decoding path, one
test surface. | Rejected: per-feature .ps1 files -- multiplies spawn code and
signing surface.

## Non-functional requirements

- **NFR-01** (REQ-01, REQ-02): Purge is transactional per item -- an item is
  either fully quarantined (file moved + manifest row written) or untouched
  and reported failed. No half-moved state.
- **NFR-02** (REQ-04): Privilege enforcement lives in main.js and
  scanner.ps1, not only in UI disabling. Destructive IPC channels reject
  calls when unelevated. Renderer state is a convenience, not the boundary.
- **NFR-03** (REQ-06): Process monitor refresh <= 2s interval at < 5% CPU
  on the reference machine. Design Target per Rule 9 until measured into
  BENCHMARKS.md.
- **NFR-04** (all destructive REQs): Every destructive action writes an
  operation log line (JSON lines file) with timestamp, action, items,
  outcome -- the audit trail behind M1.
- **NFR-05** (REQ-10): Bulk queue is resumable -- a crash mid-queue loses at
  most the in-flight app; completed/pending state persists to disk.
- **NFR-06** (Rule 6): Zero runtime network I/O. Grep-verifiable: no
  net-capable module imports in main/renderer beyond Electron defaults;
  no Invoke-WebRequest/WebClient in scanner.ps1.
- **NFR-07** (REQ-17): Any offline-loaded hive is unloaded in a finally
  path, including on scan error.

## Integrations & external services

None at runtime (Rule 6). Development-time only: winget manifest data for
the corrections JSON is gathered offline by the operator/research sessions,
committed to the repo (Rule 15 chain step 2). Failure mode: stale switches;
fallback: heuristic sequence /qn, /S, --silent, -quiet. Cost ceiling: zero.

## Security & data handling

- No secrets exist in this project: no API keys, no accounts, no .env.
  If that changes, playbook secrets rules apply (per-project .env,
  gitignored, .env.example committed).
- PII inventory: none collected, none transmitted. Vault contents and logs
  stay on the user's machine under the app data directory.
- Elevation: WindowsPrincipal API only (Rule 13). Two tiers per Rule 3;
  enforcement per NFR-02.
- Quarantine vault directory ACL'd to Administrators when created from Full
  Mode. ASSUMED: default inherited ACLs are acceptable for v0; revisit at
  the /cso audit before release.
- Code signing is a release gate (Rule 14); development builds are local
  only.

## Environments & release

- dev: operator machine, unsigned, npm start elevated or not (both tiers
  must work per REQ-04/05).
- test: clean Windows 10 (1607+) VM + clean Windows 11 VM; Rule 10 gate.
- release: signed binaries only; RELEASE.MAJOR.MINOR scheme per
  docs/RELEASING.md; CHANGELOG via /sync-docs before tagging.
- Git: trunk master; feature branches bd-<id>-<slug>, squash-merge,
  delete after merge; commits only when a bd task's definition of done
  requires them.

## Decisions

- D-05: Registry restore manifests use reg.exe export format (.reg) plus a
  JSON index row, not a custom serialization. | Because: .reg is the native,
  battle-tested restore path (double-click or reg import), zero parser code
  to write. | Rejected: JSON-serialized key trees -- reimplements what
  reg.exe already guarantees.
- D-06: Quarantined files are moved (same-volume rename or copy+delete
  fallback), never compressed. | Because: move is atomic on same volume and
  preserves ACLs/streams; compression adds failure modes for zero benefit at
  these sizes. | Rejected: zip archives per purge -- breaks streams/ACLs and
  slows restore.

## Open questions

- OPEN-03: Electron 42 sandbox vs Add-Type compilation time -- first
  Restart Manager call may take 1-2s to JIT the inline C#. Measure; if slow,
  pre-warm at app start in Full Mode. | Owner: phase-2 implementation
  | Blocks: nothing (mitigation known).

## Gate checklist

- [x] Every stack row has a Because and a Rejected (or explicit dash where
      no alternative exists)
- [x] Every NFR cites a REQ; every MUST REQ is technically covered
- [x] Every integration has a failure mode and cost ceiling (only one, dev-time)
- [x] Security section covers secrets, PII, and agent-context exclusions
