# Implementation kickoff -- for fresh Sonnet sessions

> Read this once when picking up Vanish implementation. It is a pointer,
> not a spec. The specs are the 6 docs in this folder; the work items are
> bd issues. One task per session (playbook S3).

## The rule of the session

1. `bd prime` (runs on SessionStart) then `bd ready` -- claim the top
   unblocked task with `bd update <id> --claim`.
2. Open ONLY that task's context manifest in
   `docs/planning/05-implementation-plan.md` (the TASK-nn block). Read the
   files and doc sections it lists. Do NOT read the whole planning pack or
   unrelated source -- the manifest's "Do NOT read" line is binding for
   token discipline.
3. Before writing code, walk the change through `docs/promptgate.md`
   (it wins every conflict) and the pre-implementation checklist.
4. Implement. Run the task's Verify command/observable -- "works" is not
   verification (playbook grounding rule).
5. `/code-review` medium (phase 1 tasks: high -- they touch deletion).
6. Close: `bd close <id> --reason "TASK-nn done; <verify result>"`.

## Deviation protocol (binding)

If the plan is wrong, STOP. Amend the owning doc (new D-nn entry), append
a line to `docs/planning/DEVIATIONS.md`, then continue. Never fix in code
and reconcile later. >3 deviations in a phase = re-plan the remainder.

## Order of play

Critical path (bd ids): oq9 -> 9e5 -> 05p -> cwp -> zwq -> 0b1 -> 1gi ->
fp1 -> fsz -> tz3 -> r5f -> dxv. `bd ready` enforces this via dep edges;
just claim what it offers.

- **TASK-01 (oq9)** is the only ready task now -- start here.
- **TASK-09 (2ax)** is BLOCKED on research OPEN-01 -- do not improvise the
  suspension mechanism; wait for findings in the issue.
- **TASK-10 (1gi)** needs OPEN-02 findings for step 1 of the lookup chain;
  the corrections-JSON and heuristic steps can proceed without it.
- **TASK-11 (fp1)** and **TASK-15 (dxv)** are L -- split into the sub-issues
  named in their titles at claim time before coding.
- **TASK-09 and TASK-16** are SHOULD -- slip them past Core if quota tightens.

## Phase gates

At each phase end: `/verify` + completion-gate + `/code-review`, then fill
`docs/planning/reviews/phase-N-gemini-review.md` (from the sdlc-planning
gemini-review template), run it in Antigravity, paste the verdict into the
phase's bd issue. A FAIL blocks the next phase.

## Research handoffs waiting

- `reviews/OPEN-01-research.md` -> Antigravity -> findings to bd 2ax.
- `reviews/OPEN-02-research.md` -> Antigravity -> findings to bd 1gi.

Run these before phase 2 (OPEN-01) and phase 3 (OPEN-02) respectively.
