# Vanish: Release & Versioning Guide

---

## Versioning Scheme -- `MAJOR.MINOR.PATCH`

**Amended 2026-08-28 by the operator, and this amendment is the point of the
section.** The old scheme called the first digit RELEASE and said it bumps from
`0` to `1` *exactly once*, after which it moves again only for "a complete
architectural overhaul". That made `1.0.0` a finish line and everything before
it a countdown, which had two visible costs:

* Real milestones piled up under one number because the next number was
  reserved. **0.8.0 carried far more than one milestone's worth of work** -- the
  finder/decider seam, the machine-hygiene suite, the UAC cause mapping, the
  live elevated relaunch -- and comparing "0.8.0" to "0.8.0" told you nothing
  about which one you were running.
* It described Vanish as a project heading somewhere and then stopping.

**Vanish is not limited to 1.0 as its final variant.** Versions keep moving with
the milestones, before and after 1.0, and the digits mean what they mean
everywhere else in software. The naming below is now ordinary SemVer, because
inventing private names for the same three digits was itself a source of
confusion.

### MAJOR (first digit)

`0` while the ship gates in [PRE-RELEASE.md](PRE-RELEASE.md) are outstanding.
`1` when they are met -- that is what 1.0.0 means and all it means.

**After `1.0.0`, MAJOR keeps moving.** Bump it for a break in a contract
someone outside this repo could be relying on: the IPC action interface, the
`scanner.ps1` action names or payload shapes, the on-disk vault schema, or a
host change (Electron to something else). A user whose quarantine vault cannot
be read by the new version has experienced a major version change whatever the
changelog says.

Do **not** bump MAJOR to signal excitement or importance. A big feature landing
is a MINOR bump.

### MINOR (second digit)

**One milestone, one bump. Bump it when the milestone lands, not when the
calendar or the roadmap says so.** A milestone is a capability that is complete
end to end -- it works, it is verified, and a user could describe what changed
in a sentence.

Concretely, any of:

* A new capability tier reaches functional completion (the machine-hygiene
  finders; Force Uninstall; the quarantine vault).
* A structural change users feel: which screen the app opens on, how a whole
  panel loads, a new shared surface every feature routes through.
* An IPC or engine interface gains actions in a way older callers survive.

Double digits are expected and correct. `0.13.0` is unambiguous and accurate.
Never reset, compress, or cap the digit to keep it looking tidy.

### PATCH (third digit)

Everything else, and it absorbs most of the work: bug fixes inside a shipped
milestone, a new helper or IPC handler that extends an existing one, docs,
moves and renames, CSS, dependency bumps with no behaviour change, promptgate
fixes.

### The test, when a change does not obviously fit

Ask what a user would have to be told. *"Nothing, unless they hit the bug"* is a
PATCH. *"Vanish now does X"* is a MINOR. *"Your existing X will not work"* is a
MAJOR.

---

## Version History

| Version | Date | What it was |
|---------|------|-------------|
| `0.1.0` | 2026-06-25 | Core MVP |
| `0.2.0` | 2026-06-26 | Audit & Health Advisor |
| `0.3.0` | 2026-08-12 | Task Manager & Unlocker |
| `0.4.0` | 2026-08-13 | Search & Destroy |
| `0.5.0` | 2026-08-13 | Elevation you can trust |
| `0.6.0` | 2026-08-14 | Say which, and say what matters |
| `0.7.0` | 2026-08-18 | Space you can actually recover |
| `0.8.0` | 2026-08-18 | Other people's tools, used properly |
| `0.9.0` | 2026-08-28 | Rescue before reclaim -- the machine-hygiene suite, the finder/decider seam, and Health Advisor as the landing dashboard |
| `0.9.1` | 2026-08-28 | The hygiene scan finishes: over ten minutes to 103 seconds, measured per check before anything was changed |
| `0.9.2` | 2026-08-29 | One walk of the disk answers four checks instead of four, and the biggest unit stops being scheduled last: 107 seconds to 81 |

`0.9` previously named the pre-release chore list (the elevated confirmations,
the demo recording, signing, a second machine, a final docs pass). Those are
gates, not a milestone, and holding a version number hostage to them is exactly
the habit this section was rewritten to stop. They are tracked in
[PRE-RELEASE.md](PRE-RELEASE.md) and in `bd`, and they gate **1.0**, which is
where they always belonged.

---

## Code Signing (Hard Gate — Promptgate Rule 14)

Unsigned builds are for local development only. No unsigned binary is distributed
externally under any circumstances, including pre-release and beta builds.

**Certificate options:**
- **OV (Organization Validation)**: ~$100–300/yr. Verifies organisation identity.
  SmartScreen will warn on first runs until download reputation builds (weeks to
  months depending on volume). Sufficient for early community releases.
- **EV (Extended Validation)**: ~$300–600/yr. Requires hardware USB token and
  stricter identity verification. Clears SmartScreen immediately on day one.
  Required for kernel-mode drivers. Recommended for the `1.0.0` public launch.

**Pre-distribution checklist:**
- [ ] EV or OV code signing certificate obtained
- [ ] All distributed binaries signed before packaging
- [ ] SmartScreen reputation impact acknowledged (OV requires build-up period)

---

## Reproducible Builds

Build from a verified dependency set, always:

```bash
npm ci
```

Never `npm install` for a release. `npm ci` installs exactly what
`package-lock.json` records and verifies every package against the integrity
hash stored there; `npm install` is free to resolve something newer and will
rewrite the lockfile to match. `electron` is pinned to an exact version in
`package.json` for the same reason — bump it deliberately, in its own commit,
never as a side effect of installing.

This matters more here than in most projects: Vanish ships as an application
that runs elevated and deletes files, edits the registry and executes
third-party binaries. A substituted dependency inherits all of that. The
lockfile is the only artefact that makes such a substitution detectable, which
is why it is tracked in git rather than ignored (SEC-4,
bd `vanish-uninstaller-703`).

## Pre-Release Verification Checklist

Before tagging any `1.x.x` release:

- [ ] Built with `npm ci` from a committed, unmodified `package-lock.json`
- [ ] `npm audit` reviewed and clean, or every finding explicitly accepted
- [ ] All Core tier stages tested on clean Windows 10 VM (build 1607+)
- [ ] All Core tier stages tested on clean Windows 11 VM
- [ ] Performance targets validated and logged in `BENCHMARKS.md`
- [ ] `README.md` up to date with current screenshots
- [ ] `CHANGELOG.md` `[Unreleased]` block promoted to the new version and dated
- [ ] No local filesystem paths present in any doc file (Promptgate Rule 18)
- [ ] All Mermaid diagrams rendering correctly on GitHub (Promptgate Rule 21)
- [ ] Git tag created matching the version number (e.g. `git tag v1.0.0`)
