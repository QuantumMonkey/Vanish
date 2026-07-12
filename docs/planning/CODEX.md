# The Vanish Codex -- build-agent doctrine

> Read AFTER `docs/promptgate.md` and BEFORE making any decision the specs
> did not nail down. Promptgate is the law (hard rules, mechanical). This
> Codex is the intelligence behind the law: the why, the invariants, and
> the heuristics for the moments a spec falls silent. When promptgate and
> the Codex agree, obey. When a spec is silent, decide by this Codex. When
> promptgate and this Codex appear to conflict, promptgate wins and you
> STOP and flag it (that conflict is a bug in one of them).
>
> Audience: Opus (planning), Sonnet (implementation), and any research
> agent returning findings. This document exists so you make the decision
> the operator would have made, without asking, in the 80% of cases the
> spec did not foresee.

---

## I. The Creed -- what Vanish is, and refuses to be

Six tenets. Each states the belief, then the failure it exists to prevent.
If a change would weaken a tenet, it is wrong even if it compiles and the
spec did not forbid it.

1. **The tool proposes; the human disposes.** Every destructive act traces
   to a checkbox a human ticked this session. No auto-clean, no scheduler,
   no "we know better." *Prevents:* the whole category of cleaner that
   deleted something the user needed and could not name what it took.

2. **Quarantine is not deletion. Nothing dies on the first blow.** Files
   move to the vault; registry keys export before removal. Every act is
   reversible until the user, explicitly, makes it not. *Prevents:* the
   irreversible mistake -- the one bad heuristic that has no undo. (See
   promptgate Rule 2. This is the spine of the product; if you find
   yourself writing `Remove-Item` on a user path outside the vault-delete
   path, you have taken a wrong turn.)

3. **Audit before power. Read-only is a first-class mode, not a degraded
   one.** Unelevated Vanish is fully useful: it looks, reports, explains,
   and never pretends it can act. *Prevents:* the crash-on-declined-UAC and
   the silent half-privileged state where a button lies about what it can
   do. (Rule 3.)

4. **Say only what is true, in the words that are true.** No "100% rollback"
   (Rule 8), no unmeasured performance numbers as facts (Rule 9), no
   "Complete" that means merely "coded" (Rule 10), no threat verdicts
   (Vanish is not an antivirus). Labels carry risk honestly: Safe /
   Moderate / Advanced, and Advanced is opt-in. *Prevents:* the erosion of
   the one asset a registry tool cannot rebuild -- trust.

5. **The machine is a vault, not a wire.** Zero network at runtime. No
   telemetry, no cloud lookup, no submission. Everything a grep can prove.
   *Prevents:* the privacy breach that a tool with admin rights over your
   whole disk must never be capable of, not merely must not do. (Rule 6.)

6. **Discovery depth and deletion policy are different axes.** How far you
   look is never how much you delete. A user can search Advanced and remove
   nothing. *Prevents:* the conflation that turns a search knob into a
   deletion knob and surprises the user. (Rule 1.)

The creed compresses to one line, and if you remember only one line,
remember this: **Vanish is the uninstaller you would trust with your own
registry -- because it shows its work, undoes its damage, and waits for
your word.**

---

## II. The Invariants -- true after every task, no exceptions

A task is not done if any of these is false, regardless of what its
acceptance criterion said. Check them at the completion gate.

- **INV-1** No user-data destructive path exists outside the vault
  pipeline. Grep the diff: every `Remove-Item`, `reg delete`, `sc delete`,
  `pnputil /delete`, PATH write, or handler removal on a user/system target
  routes through quarantine (move-to-vault or export-then-remove) with a
  manifest row. The sole exceptions are the explicit vault "Delete Forever"
  and retention auto-purge.
- **INV-2** The privilege boundary is enforced in `main.js`/`scanner.ps1`,
  never only by a disabled button. A destructive IPC call invoked directly
  (devtools console) while unelevated must be rejected. UI state is
  convenience; the boundary is code.
- **INV-3** Every destructive action leaves an audit trail: an `oplog.jsonl`
  line (ENT-05) and, if it removed anything, a restorable manifest entry.
  No silent acts.
- **INV-4** Zero runtime network I/O. If a task introduces any HTTP client,
  socket, or `Invoke-WebRequest`, it is wrong. Definition packs and
  corrections data are on-disk, user-supplied or repo-committed (Rules 4/5).
- **INV-5** On-disk formats stay additive (04-schema evolution rules). New
  key or new file, yes; rename or remove, no. A migration mid-milestone is
  a smell -- check the `meta: {}` extension slot first.
- **INV-6** No local filesystem paths, no `Javascript`/`xml` lowercasing,
  no untagged mermaid, no banned phrases in any doc you touch (Rules 8, 18,
  21, 23). ASCII only in anything written to disk or shell (operator's
  global rule -- em-dashes break PowerShell 5.1 parsing).
- **INV-7** Reversibility is preserved end to end. If you cannot describe,
  in one sentence, how a user undoes what your task's feature does, the
  feature is not finished.

---

## III. Heuristics for the silent spec -- how to choose

When the spec does not say, optimize in this priority order. Higher beats
lower whenever they pull apart.

1. **Safety over capability.** A feature that can destroy more is worth less
   than one that can undo more. When unsure whether to act, surface and
   wait.
2. **Honesty over polish.** Ship the true label, the "Design Target" tag,
   the "Indicator -- investigate with your antivirus" caveat, even when a
   confident claim would look better.
3. **Reversibility over convenience.** Prefer the path that keeps an undo,
   even if it is a step slower (move over delete, export over drop,
   per-item over bulk).
4. **The existing pattern over the novel one.** Reuse the review-tree, the
   wizard state machine, the vault pipeline, the index.css tokens. A second
   way to do a thing the app already does is a maintenance debt and a
   trust-consistency break. (See 02-uiux D-07.)
5. **The smallest correct surface.** Fewer IPC channels, one writer per
   file, one engine dispatcher (TRD D-04). Complexity is where the
   irreversible bug hides.
6. **Local verification over assumed correctness.** "It should work" is not
   a state you may report. Run the task's Verify. If you cannot ground it
   (no VM, no admin), say so explicitly (operator's grounding rule).

Tie-breaker of last resort: **do what a cautious sysadmin protecting a
machine they personally own would do.** Vanish has exactly one imagined
user at the shoulder of every decision -- that person.

---

## IV. Cautionary tales -- the mythos, and the lesson under each

These are the ghosts the rules were written to lay. Carry them; they make
the rules memorable when you are three files deep and tempted to cut a
corner.

- **The Registry Graveyard.** The category Vanish is born into is a
  graveyard of cleaners that deleted on vague heuristics, broke Windows,
  and taught a generation of users that "registry cleaner" means "thing
  that bricks my boot." Vanish's entire reason to exist is to be the
  exception. Every shortcut that deletes-without-showing digs the same
  grave. *Lesson: the market's distrust is earned; you inherit it until you
  disprove it, one honest purge at a time.*

- **The Cleaner That Ate Boot.** Somewhere a tool auto-deleted a "duplicate"
  DLL that a driver still imported, and the machine did not come back. This
  is why redundancy detection only flags (never acts), why SharedDLLs are
  reference-checked before touch, why runtime-dependency removal is a
  warning and not a sweep. *Lesson: "orphaned" is a hypothesis, not a fact;
  quarantine is how you survive being wrong about it.*

- **The Publisher Folder.** Two apps from one publisher share a folder;
  uninstalling one, a naive tool deletes the whole publisher directory and
  takes the other app's data with it. Vanish's `Is-PublisherShared` guard
  exists because of this exact class of loss. *Lesson: shared state is
  everywhere in Windows; whole-folder deletion is almost always a trap.*

- **The Watchdog That Respawned.** You close a handle; a watchdog process
  notices and respawns the locker before your next line runs. This is why
  TASK-09 suspends the tree (NtSuspendProcess, frozen atomically) before
  releasing locks, and why resume is guaranteed by a finally path. *Lesson:
  on a live system, state changes under you; freeze before you act, and
  guarantee the thaw.*

- **The Undocumented Export.** Vanish uses `NtSuspendProcess` -- an
  undocumented ntdll call -- because it is what Process Explorer uses and it
  is atomically correct, where the documented thread-by-thread path has a
  race. Sometimes the reliable choice is the unofficial one; the wrong
  lesson is "documented = safe." *Lesson: judge by correctness and evidence,
  not by the label on the door -- but write down why, so the next agent
  does not undo it thinking they found a bug.* (Recorded in bd
  `vanish-uninstaller-2ax`; do not "fix" it back to SuspendThread.)

- **The winget That Phoned Home.** The plan assumed winget could supply
  uninstall switches offline. Research found its source is now a network
  API -- and Rule 6 forbids the call. The three-step chain became two, and
  the binding rule was amended before a line of TASK-10 was written.
  *Lesson: verify the assumption against reality before building on it; a
  hard invariant (no network) outranks a convenient plan, and the plan
  yields.* (bd `vanish-uninstaller-1gi`; DEVIATIONS.md 2026-07-11.)

---

## V. Reading the operator -- how to work with the human

- One operator, Claude Pro quota, solo. Tokens are budget; fan-out and
  re-reading are waste. Lead with the decision, not the survey. (Global
  output rules.)
- The operator has already made the hard calls: promptgate is supreme,
  stack is fixed (ADR 0001), payments are MS Store, scope is Core tier.
  Do not reopen settled decisions; build on them.
- The operator wants grounding, not optimism. A failed test reported plainly
  beats a green claim that does not hold. "Done" is a word with a gate
  behind it (INV list + the task Verify).
- bd is the single source of task truth. No TodoWrite, no markdown TODOs.
  Findings live in bd issues; design choices in ADRs; facts in memory;
  behavior in CLAUDE.md/promptgate. Never duplicate across these stores.
- Conservative git by default: commit and push only when asked or when a
  task's definition of done requires a merge-ready branch.

---

## VI. When to stop and ask a human -- escalation triggers

Most decisions you make yourself by Sections III-IV. STOP and surface only
when one of these is true (these are genuinely the operator's call):

- A change would weaken a Creed tenet or violate an Invariant, and the task
  seems to require it. That is a spec bug -- do not code around it.
- promptgate and a spec (or this Codex) give conflicting binding
  instructions. Flag the conflict; do not pick a side silently.
- A task's mechanism is unresolved and marked BLOCKED on research (e.g.
  TASK-09 before OPEN-01 landed). Do not improvise the mechanism; wait for
  the findings in the bd issue.
- An irreversible, outward-facing act is implied (publish, submit to the
  Store, force-push, delete something you did not create). Confirm first.
- More than three deviations have accumulated in a phase. Re-planning is now
  cheaper than continuing; say so.

Everything else: decide, act, verify, and record why in the bd close reason
so the next agent can reconstruct the decision from `bd show` + this pack
alone.

---

*The specs tell you what to build. Promptgate tells you what you may not do.
This Codex tells you how to think when neither one is looking. Build like
the machine is your own.*
