# Handover — integration lane 3 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_014KgrtfNdrtkkD5ZYQWSge7, 2026-10-01.

## State
- 2.18 (branch `lane/3-2.18-s1b`, on main ff39ce4 = 2.9 part 3 step 2, #247): S1 scenario 1 is green — expiry, FEFO,
  QRT routing and quarantine_decision pass on real values. Still RED: OF-01/02/06/07 billable events (4.3, after
  #246 = 0048) and the PDL delivery task (3.4 part 2; cross-entity decision pending).
- S2 (VAS / Lost Revenue) and S18 (row 4.15) wait on stream B; nothing in tests/ turns them green.
- The PDA screens (2.16 part 2) use mock clients; driving them from Playwright needs a real client + webServer.
- lane-db.sh never re-applies: apply each new migration to pgeos_lane3 with
  `PGDATABASE=pgeos_lane3 psql -q -v ON_ERROR_STOP=1 < database/migrations/NNNN_*.sql` (0041, 0045, 0046, 0047 applied).
- Run S1 from tests/scenarios: `PGDATABASE=pgeos_lane3 PG_LANE=3 pnpm exec playwright test S1.spec.ts`.

## Next
2.18: re-run S1 as 4.3 part 1 and 3.4 part 2 land; the Master adds S1 to tests/scenarios/green.json when it is fully green.
Lane DB: `bash scripts/lane-db.sh 3`, PGDATABASE=pgeos_lane3 PG_LANE=3.
