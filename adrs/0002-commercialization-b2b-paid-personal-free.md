# ADR 0002: B2B paid, personal use free -- supersedes the payments row of ADR 0001

- Status: Accepted
- Date: 2026-08-08
- Deciders: Anand (operator), directive of 2026-08-06
- Supersedes: the **Payments** row of `adrs/0001-stack-override.md` only. Every
  other row of 0001 (Electron shell, vanilla renderer, PowerShell backend, no
  database, no auth, signed-binary distribution) stands unchanged.

## Context

ADR 0001 closed the payments question on 2026-07-11 with a Microsoft Store paid
"Convenience Edition" at USD 4.99-9.99 one-time, source staying MIT on GitHub.
The reasoning was sound for what the project was then: a solo operator with no
billing infrastructure, and a proven precedent in NanaZip and ShareX.

On 2026-08-06 the operator changed the model: **"we will still build the public
version and commercialize it at b2b level, keeping personal use free."**

That is not a pricing tweak. The Convenience Edition sells convenience to
individuals; this sells the tool to organisations. The buyer, the bar, and the
distribution path all change, and the docs have been carrying the contradiction
since -- `vanish-uninstaller-1w0` still reads "MS Store Convenience Edition"
today, which is why this ADR exists rather than a comment on the issue.

## Decision

**Individual, personal use of Vanish is free. Commercial use inside an
organisation requires a paid licence.**

| Question | Answer |
|---|---|
| Who pays | Organisations deploying Vanish on machines they administer |
| Who does not | Individuals on their own machines, at any scale of use |
| What the money buys | A licence to use it commercially -- not a feature gate |
| Source | Stays public. Licence terms change; openness does not |
| Distribution | Signed binaries, promptgate Rule 14 hard gate, unchanged |

### What this does NOT decide

Recorded explicitly, because leaving these implicit is how a decision becomes
five decisions nobody made:

- **Not an open-core split.** No feature is being moved behind a paywall. The
  roadmap's Open-Core / Dual-Licensing option (monetization model 2) is
  rejected for now: gating the destructive surfaces behind a tier would mean
  the free build is the one with less safety in it, which inverts the whole
  point of the project.
- **Not a licence-key mechanism.** Enforcement remains deferred, as
  `research.md` already had it. The first commercial arrangement can be an
  invoice and a licence file; a cryptographic key wrapper is a real feature
  with real failure modes and it earns its place only when there is revenue to
  protect.
- **Not the specific licence text.** MIT does not express "free for personal,
  paid for commercial" and must be revisited. That is a separate piece of work
  and a legal question, not an engineering one -- flagged here, not answered.
- **Not the price, tiering, or per-seat versus site.** No customer exists yet.
  Deciding this now would be inventing a number to feel decisive.

## Consequences

- **The quality bar rose, and this is the consequence that has already
  changed the work.** Everything in epic `vanish-uninstaller-7oo` was a B2B
  dealbreaker: an administrator evaluating a tool for a fleet does not file a
  bug about a button that renders but cannot be clicked, they stop evaluating.
  The epic was closed under this bar, and the real-data harness
  (`test/real-data-verify.js`) exists because a passing stub suite was not
  evidence anyone should have accepted.
- **Microsoft Store is no longer the primary channel** and may not be a
  channel at all. It is built for consumer one-time purchases, and this model
  sells to organisations that procure by invoice. `vanish-uninstaller-1w0`
  must be re-scoped: the code-signing half remains mandatory (Rule 14), the
  Store-submission half is now an open question rather than the plan.
- **Signing is no longer optional-with-a-reversal-condition.** ADR 0001 and
  `vanish-uninstaller-22n` recorded a kill switch: no certificate within a
  month of Core completion means the public-release track dies and Vanish
  stays a personal tool. Under a B2B model an unsigned binary is not a
  SmartScreen annoyance, it is disqualifying -- no IT department deploys one.
  The reversal condition stands, but its meaning hardens: no certificate means
  no commercial product, not a rougher launch.
- **Free personal use is a distribution asset, not charity.** The people who
  evaluate a tool like this at home are the same people who recommend it at
  work. That path only functions if the free build is the whole product, which
  is the same reason open-core is rejected above.
- **The public repository stays public.** The security argument in the
  roadmap's own assessment is unchanged and is stronger under B2B, not weaker:
  a tool demanding administrator rights on a corporate fleet is more
  answerable for what its source shows, not less.

## Rejected alternatives

- **Keep the MS Store Convenience Edition.** Rejected by operator directive.
  It also sells to the wrong buyer for the stated goal: the individual paying
  five dollars for automatic updates is not the organisation that needs a
  licence to deploy it on two hundred machines.
- **Open-core / dual-licensing (GPLv3 core + proprietary Pro).** Rejected as
  above: the paid tier would end up holding the fleet-audit and
  advanced-heuristic surfaces, leaving the free build weaker at exactly the
  things that make the tool trustworthy.
- **Free everywhere, monetise support.** Viable, and not ruled out forever,
  but it needs a support capacity a solo operator does not have and turns
  every sale into labour rather than licence.
- **Decide pricing and enforcement now.** Rejected as premature. There is no
  customer, and a number invented today would be defended tomorrow.

## Follow-ups

- `vanish-uninstaller-1w0` (TASK-21) needs re-scoping: signing stays, Store
  submission becomes a question.
- `vanish-uninstaller-22n` carries a note pointing here.
- `docs/roadmap.md` monetization section updated to mark model 3 as chosen and
  model 1 as superseded.
- Licence text for the repository is unresolved and tracked separately.
