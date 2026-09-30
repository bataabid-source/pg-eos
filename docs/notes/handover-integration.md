# Handover — integration lane 3 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_014KgrtfNdrtkkD5ZYQWSge7, 2026-09-30.

## State
- 2.18 (branch `lane/3-2.18-s1`, on main 5ab04e6 = 2.9 part 3): S1's expiry and FEFO steps are green. Still
  RED: QRT routing and quarantine_decision (backlog rows "S1 QRT routing" / "S1 quarantine_decision", owner
  2.9 part 3, second step, to be briefed), OF-01/02/06/07 billable events (4.3), PDL delivery task (3.4).
- S2 (VAS / Lost Revenue) and S18 (row 4.15) wait on stream B; nothing in tests/ turns them green.
- The PDA screens (2.16 part 2) use mock clients; driving them from Playwright needs a real client + webServer.
- Full pre-commit (G16 unscoped) takes about 1 h. Apply new migrations to pgeos_lane3 before running it
  (lane-db.sh never re-applies).

## Next
2.18: re-run S1 as each owner row lands; the Master adds S1 to tests/scenarios/green.json when it is fully green.
Lane DB: `bash scripts/lane-db.sh 3`, PGDATABASE=pgeos_lane3 PG_LANE=3.
