# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

> **This repository opts in to Team-maintainer.** Set 2026-08-03 by the owner:
> keep `origin` synced, local and cloud. Commit and push completed work as a
> matter of course; do not ask first and do not fall back to Conservative.
> Two standing exceptions, which get flagged rather than silently applied:
> a diff carrying secrets or private data, and -- since this repo is **public** --
> a diff that would publish an unfixed vulnerability.

- **Conservative**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands. *Not active here.*
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_

## Scope: one source of truth

**[docs/PRE-RELEASE.md](docs/PRE-RELEASE.md) decides what gets built.** It lists
what is in 1.0, what is permanently cut and why, which release gates were
waived and at what cost, and what is queued after. If any other document
disagrees with it, PRE-RELEASE.md wins.

Specifically superseded, and kept only as historical reasoning:
`docs/roadmap.md` (stage/tier model), `docs/architecture.md` (pre-code target
design), and everything in `docs/history/` (five archived session handoffs —
**not** to-do lists, despite each one saying "start here").

The standard every proposed feature must pass before it earns a bd issue:

> Solve problems that are not solved. Use existing tools where possible,
> integrate existing FOSS where necessary. Do not build redundant nonsense.

Vanish exists because this category is gatekept and commodified. A feature
that duplicates something the user already has is not neutral — it is us
becoming the thing we objected to. Before proposing work, name what already
solves it (Windows built-ins, WinDirStat/WizTree, BleachBit, PatchCleaner,
Task Manager) and what Vanish adds that they cannot. If the honest answer is
"nothing", that is the finding — say so instead of building it.

The three assets nothing else in this category has, and which any worthwhile
feature is leverage on: the installed-program map (`scanner.ps1` +
`corrections.json`), the quarantine vault with a real restore path (INV-1),
and the tier/consent model that refuses by name with a reason.

Licence boundary, verified 2026-08-12: this repo is **MIT and public**.
WinDirStat is GPL-2.0; BleachBit and its CleanerML definitions are GPL-3.0+.
Do not vendor GPL code or definition files into this repository. Query tools
the user already has, reimplement documented *techniques* (e.g. MFT
enumeration via `FSCTL_ENUM_USN_DATA`, which carries no licence), and ship
parsers rather than other people's data.

Do not write a new handoff file. Checkpoint to the bd issue.
