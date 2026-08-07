# ADR 0001: Stack override -- desktop app, not the default SaaS stack

- Status: Accepted; **the Payments row is superseded by
  [ADR 0002](0002-commercialization-b2b-paid-personal-free.md) (2026-08-08)**.
  Every other row below stands.
- Date: 2026-07-11
- Deciders: Anand (operator), per PLAYBOOK S4 rule "a project deviates via an ADR, never silently"

## Context

The Depthworks PLAYBOOK S4 defines a default SaaS stack marked [ASSUMED]
(TypeScript, Next.js, Vercel, Neon Postgres + Drizzle, Better Auth,
merchant-of-record payments). Vanish is an on-device Windows desktop
application, already implemented through Stage 2. The default stack does
not apply and is overridden here.

## Decision

| Layer | Vanish choice | Reason |
|---|---|---|
| Shell | Electron ^42 | Already built and verified; native window + IPC surface exists |
| UI | Vanilla JavaScript renderer (renderer.js), no framework | Existing working code; app complexity does not justify a framework migration |
| Backend | PowerShell 5.1 (scanner.ps1) spawned from main.js | Required by OS support policy (Windows 10 1607+ bundles PS 5.1); all registry/CIM work lives here |
| Database | None. On-disk state only: quarantine vault manifests, corrections JSON, settings file | Local-first, zero network (promptgate Rule 6); no server component exists |
| Auth | None | Single-user desktop app; elevation tiers (promptgate Rule 3) are the only privilege model |
| Hosting | None. Distribution = signed binaries (promptgate Rule 14 hard gate) plus source on GitHub | Desktop app; unsigned builds never distributed |
| ~~Payments~~ | ~~Microsoft Store paid "Convenience Edition" (USD 4.99-9.99 one-time); source stays MIT on GitHub~~ | **SUPERSEDED 2026-08-08 by [ADR 0002](0002-commercialization-b2b-paid-personal-free.md): personal use free, commercial use paid.** Original reasoning: decided by operator 2026-07-11; Microsoft handles payment and tax; model proven by NanaZip/ShareX |

## Consequences

- The sdlc-planning "backend schema" document describes on-disk file
  formats (vault manifest, corrections JSON, settings), not SQL.
- No Vercel/Neon/Better Auth tooling enters this repo.
- Code signing cost is a known open risk; reversal condition recorded in
  bd issue vanish-uninstaller-22n (kill public-release track if no cert
  within 1 month of Core-tier completion).
- docs/promptgate.md remains the superior rulebook; this ADR defers to it
  on any conflict.

## Rejected alternatives

- Default SaaS stack: no server-side product exists; would violate the
  local-only privacy stance (Rule 6).
- Tauri/WinUI rewrite: discards two completed, verified stages for no
  user-visible gain at this phase.
- Paddle/Lemon Squeezy direct sales: viable later, but MS Store removes
  payment, tax, and update-distribution burden for a solo operator.
