# database/migrations

- Applied range: `0001`–`0030`, `0034` (forward-only; `apply.sh` re-runs every file, so each is idempotent). `0031`–`0033` are claimed by other lanes (P6b-2, lane 1, lane 3) and not yet part of this range.
- `0022` is **WITHDRAWN and consumed** — never reuse the number (the column already existed in 13B).
- The next free number is the one `tasks/LANE_LOCKS.md` "Migrations issued" names; only the Master issues numbers.
- File name: `NNNN_<lane>_<slug>.sql`; the lane's `MIGRATION-REQUEST-<lane>.md` row names the RED tests first (D-179).
- RLS / schema / audit-chain changes need a pg-reviewer pre-migration review before the file is written.
