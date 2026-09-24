# MIGRATION-REQUEST-2 — lane 2 (hr + platform)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | platform | `platform-sites` | `platform.sites` (SCR-HR-SHIFT-01 §2.4, D-144 item 4: single sites table replacing sales.account_sites / hr.work_sites) + `hr.employees.default_site_id` FK; threshold `att.geofence_radius_m` seeded 500 (D-141 Q30b). WBS 5.5a part 1 (split from the full 5.5a scope — precedent 5.13 part 1/part 2 — to stay inside the 12-file Read-ONLY budget). pg-reviewer pre-migration review: **APPROVED WITH CHANGES (7 findings, all applied)**. | 2026-09-24 | **0015** (`ae2c4a8`) |
