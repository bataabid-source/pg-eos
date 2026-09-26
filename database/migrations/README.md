# database/migrations

- Applied range: `0001`–`0035` (forward-only; `apply.sh` re-runs every file, so each is idempotent). `0031_M_active-entity-rls.sql` is P6b-2 (SCR-PLAT-CTX-01, D-190: `platform.allowed_entities()` follows `app.entity_id`); `0035_3_commission-daily-dispute-sod.sql` is lane 3, WBS 3.13 part 5a (dispute-side DB backstop on `hr.guard_commission_daily_status()`).
- `0022` is **WITHDRAWN and consumed** — never reuse the number (the column already existed in 13B).
- The next free number is the one `tasks/LANE_LOCKS.md` "Migrations issued" names; only the Master issues numbers.
- File name: `NNNN_<lane>_<slug>.sql`; the lane's `MIGRATION-REQUEST-<lane>.md` row names the RED tests first (D-179).
- RLS / schema / audit-chain changes need a pg-reviewer pre-migration review before the file is written.
