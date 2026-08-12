# Archived session handoffs

**Nothing in this folder is a to-do list. Do not resume from these.**

Every file here was written as "read this first, resume here" for the session
that followed it. All of them have been overtaken. Read them only to recover
*why* a decision was made -- the reasoning, the falsified theories, the
operator reports and the live-test outcomes are genuinely useful history and
that is why they are kept rather than deleted.

For anything forward-looking there is exactly one source of truth:

| Question | Where it is answered |
| --- | --- |
| What is in 1.0, what is cut, what comes after | [`docs/PRE-RELEASE.md`](../PRE-RELEASE.md) |
| What work is open right now | `bd list --status=open` |
| What the code does today | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| What shipped, and when | [`CHANGELOG.md`](../../CHANGELOG.md) |

If a file in this folder contradicts `docs/PRE-RELEASE.md`, PRE-RELEASE.md
wins. It was written later and with the full picture.

## What each one covers

| File | Session | Still worth reading for |
| --- | --- | --- |
| `handoff.md` | through 2026-08-03 | The earliest structure: stage/tier model, the original promptgate rules. |
| `HANDOFF-2026-08-06.md` | 2026-08-04 to 08-06 | The 7oo operator audit -- classification, components, Windows optional features. |
| `HANDOFF-2026-08-08.md` | 2026-08-07 to 08-08 | Corrections table work and the network attribution slice. |
| `HANDOFF-2026-08-09.md` | 2026-08-09 | The fourth operator punch list (12 items) and its reasoning. |
| `HANDOFF-2026-08-12.md` | 2026-08-10 to 08-12 | `dtd`'s two implementation attempts and why the first failed live; the elevation-loop investigation as it stood before the root cause was found (see `9rv`); the 5rz resume point, now completed. |

## The lesson these five exist to teach

Five files, all of which said "start here", is itself the problem this folder
solves. A handoff is a snapshot of one session's uncertainty, not a plan. When
they accumulate at the top level of `docs/`, every one of them reads as a live
instruction and the next session has to work out which future it is living in.

Future sessions: checkpoint to the bd issue, not to a new handoff file. If a
narrative handoff is genuinely needed, write it here, dated, and add a row
above.
