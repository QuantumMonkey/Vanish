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
