# MIGRATION-REQUEST-2 — lane 2 (hr)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | hr | `hr-shifts-groups-assignments` | `hr.shifts` + `hr.shift_groups` + `hr.shift_assignments` (SCR-HR-SHIFT-01 §2.1-§2.3), referencing `platform.sites` (migration 0015). Exclusion constraint on `hr.shift_assignments` enforces "one active assignment per employee per date" (doc 38 row 5.5a acceptance). WBS 5.5a part 2 (final part). pg-reviewer pre-migration review: **APPROVED WITH CHANGES (6 findings, all applied)**. | 2026-09-25 | **0016** (pre-reserved by the Master's D-176 directive; applied locally, verified) |
