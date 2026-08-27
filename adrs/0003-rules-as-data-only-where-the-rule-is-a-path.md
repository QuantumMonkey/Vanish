# ADR 0003: Rules as data only where the rule is a path

- Status: Accepted
- Date: 2026-08-27
- Deciders: Anand (operator), via the specification in
  `docs/history/HANDOFF-2026-08-21.md`
- Closes the open question in `vanish-uninstaller-vw4`
- Affects: `finders/`, `scanner.ps1`, the CleanerML reader shipped for `7sl`

## Context

HANDOFF-2026-08-21 gave the machine-hygiene suite one structural instruction:

> Every finding below should be a rule file, so a new artifact type is a data
> change, not a change to a 7,870-line file.

`scanner.ps1` is 41% of all production code in this repository, and that number
is the reason a zero-result case had no distinct type -- when scan, classify,
decide and report share one scope, there is nowhere for "found nothing" to live
as a thing a caller can branch on. Adding twenty cleaners to the same file
would have made the file that caused the problem the file that absorbed the
fix.

Vanish already reads CleanerML, BleachBit's XML cleaner-definition format
(`7sl`, shipped 2026-08-19: an MIT reader, and no definitions vendored -- the
licence boundary in `CLAUDE.md` still applies and nothing here reopens it). So
the obvious move was to express the new finders in that vocabulary too.

`vw4` was filed to decide whether that is actually possible, deliberately
leaving the answer open until there were real examples to test it against.
There are now nine finders written, which is enough.

## Decision

**A finder is a FILE. A finder's BODY is code, except where the rule is
genuinely nothing but a path, in which case it may be data.**

The first half is the one that mattered, and it is already shipped:
`finders/_loader.ps1` discovers `finders/*.finder.ps1`, each file registers
itself, and `scanner.ps1` never learns a finder's name. Adding the twenty-first
finder touches no existing file. That is the whole of the handoff's stated
requirement -- "a new artifact type is a data change, not a change to a
7,870-line file" -- and it is satisfied by file-per-finder without the rule
bodies being data at all.

The second half is a **no**, on evidence.

### What the real finders actually need

CleanerML's vocabulary covers file deletion by glob and by directory walk. Held
against the nine finders now written, that vocabulary is not close:

| Finder | What the rule has to express | Expressible as a path? |
|---|---|---|
| `local-only-credentials` | run `git check-ignore` and trust only its exit code | No |
| `gitignored-unique` | `git log @{u}..HEAD`, stash list, "this branch has no upstream" | No |
| `duplicate-content` | group by size, then SHA256 within groups, then choose a survivor | No |
| `repo-health` | "this repo returned `dubious ownership` and is therefore unreadable" | No |
| `redirect-variables` | "this environment variable is unset, and here is where the tool defaults to instead" | No |
| `profile-list` | a registry value whose `ProfileImagePath` no longer exists | No |
| `path-hygiene` | "this user PATH entry is verbatim already in the machine PATH" | No |
| `reclaim-node` | "`node_modules`, but only where the `package.json` that regenerates it is visible" | **Almost** |
| `reclaim-archives` | "a `*.zip` beside an extracted directory of the same name" | **Almost** |

The two "almost" rows are the interesting ones, and they are still a no. Both
are a path plus a **conditional on a sibling marker**, and that conditional is
the entire safety property -- Module 1 rule 1 is "detect by project marker,
never by folder name", and a rule format that can say `node_modules` but not
"only when `package.json` is beside it" would express exactly the dangerous
half. A format that can express the unsafe rule and not the safe one is worse
than no format.

### What would have gone wrong

Extending CleanerML locally into a Vanish dialect was the alternative, and it
fails on its own terms:

1. **It becomes a programming language.** `git check-ignore` exit codes,
   size-then-hash grouping, and three-state unreadability are control flow. A
   data format that grows conditionals, subprocess invocation and error
   handling is a language with no debugger, no type checking and no test
   framework -- and this suite's whole discipline is that a check which cannot
   distinguish "clean" from "could not read" authorises deleting work.
2. **The three-state contract would move out of the type system.** `aeu` is
   enforced today by `New-FinderResult` having no `-state` parameter, so a
   finder cannot assert one. A rule file interpreted by a generic engine would
   put that guarantee back into the interpreter, where a new rule kind can
   forget it.
3. **It buys nothing the loader has not already bought.** The stated goal was
   that `scanner.ps1` stops growing. It has stopped growing. Nine finders were
   added and the file gained a dot-source block and two dispatch cases.

### What stays data

- **CleanerML proper**, unchanged, for the path-shaped cleaning it already
  does. Vanish reads other people's definitions and runs them through the
  vault, which remains the thing nobody else in this category offers.
- **`finders/_never-touch.ps1`'s `$script:NeverTouchPaths`** -- a published CVE
  mitigation is a fact about Windows, not about this machine, so it is data.
  The other two safety cases in `4rn` are positive tests precisely because they
  are *not* facts about paths.
- **Per-finder pattern tables** (credential filenames, project markers, package
  cache locations) live at the top of their own finder file as arrays. That is
  the level at which "a new artifact type" is genuinely a data change, and it
  is where the next contributor will look.

## Consequences

- A new finding type is a new file in `finders/`, written in PowerShell,
  registering itself. Reviewable, testable, and unable to reach `scanner.ps1`.
- Helper functions in those files **must** be declared `function script:Name`
  -- `Import-Finders` dot-sources from inside a function body, so a plain
  declaration is torn down before any handler runs. This is asserted in
  `test/finder-contract-verify.ps1`, including a grep over every shipped finder
  file, because the symptom appears two layers from the cause.
- The GPL boundary is untouched. No definitions are vendored, no dialect is
  published that invites definition files to be copied in.
- If a future finder genuinely is nothing but a path and a glob, it should be a
  CleanerML definition pointed at by the existing reader, not a tenth finder
  file.

## Change Log (append-only)

| Date | Change | Why |
|---|---|---|
| 2026-08-27 | Created; closes the open question in `vw4` | The issue deliberately deferred the decision until real examples existed. Nine finders later, seven of the nine rules cannot be written as paths at all, and the two that nearly can would lose the sibling-marker condition that is their entire safety property |
