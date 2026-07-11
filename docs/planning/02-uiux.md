# UI/UX Design

> Owner doc for SCR-nn ids. Cites REQ-nn. The app has an existing
> glassmorphic dark design system (index.css); this pack EXTENDS it, it does
> not restyle. Component sourcing: existing index.css patterns first,
> ui-ux-pro-max patterns second, custom last. Magic MCP is deferred (no API
> key, playbook 4a) and the stack is not React, so no Magic scaffolds.

## Design language

Tone: precise, calm, trustworthy. Reference products: System Informer
(density), Windows 11 Settings (clarity), the existing Vanish v0.2 UI
(continuity wins over novelty). "Looks AI-generated" to avoid here: generic
admin-dashboard cards, traffic-light overuse, emoji icons, marketing copy in
UI ("optimize", "boost"). Copy follows promptgate Rule 8 language rules.

## Tokens

Existing index.css custom properties are the token source of truth
(dark glassmorphic palette, blur surfaces, threat-level colors). New-in-this-
pack tokens, added to index.css :root:

- --risk-safe / --risk-moderate / --risk-advanced: reuse existing threat
  color classes; do not add new hues.
- --tier-banner-bg: high-contrast amber on dark, reserved solely for the
  Audit Mode banner (REQ-04) so it is never confused with content.
- --mono: existing monospace stack for paths, registry keys, command lines.

ASSUMED: no light theme this release; the app is dark-only today and a theme
system is out of scope.

## Motion policy

Durations 150-250ms, ease-out, on: panel transitions, tree expand/collapse,
banner slide-in. No animation on data-dense tables (process list, vault
list). prefers-reduced-motion disables all non-essential motion. Library:
CSS transitions only -- no motion/react (stack is not React, TEC-02).

## Screen inventory

- **SCR-01** Audit Mode banner + tier states -- implements REQ-04, REQ-05
  - Persistent banner (Rule 3 exact text) across all tabs when unelevated;
    every destructive control gets disabled style + tooltip "Requires Full
    Mode -- restart as administrator".
  - States: full-mode (no banner) / audit-mode / elevation-declined (same as
    audit-mode plus one-time toast).
- **SCR-02** Quarantine Manager tab -- implements REQ-03 (REQ-01, REQ-02
  surfaces)
  - Vault entry table: source app, date, item count, size, type (files /
    registry); expandable detail listing every path/key; per-entry Restore
    and Delete Forever buttons (the latter double-confirmed); settings row:
    auto-purge toggle (default off) + retention days.
  - States: default / empty ("Nothing quarantined yet -- purges land here
    first") / loading / restore-error (per-item failures listed, never
    silent) / no-permission (Audit Mode: read-only list, buttons disabled).
- **SCR-03** Task Manager tab -- implements REQ-06, REQ-07, REQ-08, REQ-09
  - Process table (name, PID, CPU, memory, disk), sortable; detail pane
    with command line, path, persistence entries; indicator chips per Rule 7
    labelled "Indicator -- investigate with your antivirus"; Unlock dialog:
    pick file/folder, list holders, "Close gracefully" primary, "Force end
    process" secondary per-process.
  - States: default / loading / error (engine spawn failed) / no-permission
    (kill/unlock disabled in Audit Mode; list still visible) / empty
    (unlock dialog: "No processes hold this path").
- **SCR-04** Bulk Uninstall queue -- implements REQ-10, REQ-12, REQ-13
  - Multi-select from existing app table feeds a queue panel: per-app row
    with status (pending / running / done / failed / reboot-required),
    switch-method badge (winget / corrections / heuristic), pause + skip.
  - States: default / running / paused-on-reboot-required / partial-failure
    summary / empty / no-permission.
- **SCR-05** System Clean tab -- implements REQ-11, REQ-14, REQ-15, REQ-16,
  REQ-17, REQ-19
  - One audit list per cleaner (context menus, services/drivers, PATH,
    associations, other-profiles) reusing the existing leftover review-tree
    pattern: checkbox per item, risk label, evidence column ("target
    missing: <path>"). Purge routes through the quarantine pipeline.
  - States per list: default / empty ("No orphans found") / loading /
    error / no-permission.
- **SCR-06** Purge summary (modification of existing wizard screen 7) --
  implements REQ-01, REQ-02 visibility
  - Replaces "deleted" language with "quarantined"; shows vault location
    and a "Review in Quarantine Manager" link; locked/failed items listed
    with the REQ-19 elevator offer where applicable.
  - States: success / partial (locked items) / vault-write-failure (purge
    aborted, nothing deleted -- NFR-01 messaging).

## Accessibility

Keyboard: full tab order through tables and trees; Space toggles checkboxes;
Enter activates default action; Esc closes dialogs. Focus returns to the
invoking control after dialog close. Contrast floor WCAG AA on the dark
palette (verify banner amber and disabled states). Destructive buttons get
aria-describedby pointing at their consequence text. Banner is
role="status" so screen readers announce tier once, not per navigation.

## Component sourcing rule

Existing index.css patterns (tables, trees, wizard, badges) first; if a new
composite is needed, consult ui-ux-pro-max patterns and restyle with the
tokens above; hand-build otherwise. Nothing ships stock.

## Decisions

- D-07: Reuse the leftover review-tree pattern for every Stage 9 cleaner.
  | Because: users already learned it in the wizard; one component, five
  surfaces. | Rejected: bespoke list per cleaner -- five times the CSS and
  inconsistent risk affordances.
- D-08: Bulk uninstall is a panel driven from the existing app table, not a
  separate wizard. | Because: selection already lives in the table; a
  second wizard duplicates state. | Rejected: 7-screen wizard clone --
  heavier for a queue that is mostly waiting.

## Open questions

None.

## Gate checklist

- [x] Every MUST REQ with a user-facing surface has at least one SCR
- [x] Every SCR lists empty/loading/error states (not just default)
- [x] Tokens are concrete values or named references into index.css
- [x] Motion policy has budgets and respects reduced-motion
