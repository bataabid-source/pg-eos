# Local restore rehearsal — 2026-09-23 (D-115 · does NOT close WBS 0.8)

**GM directive D-115 §A:** "0.8 ① + local restore rehearsal now (does not close 0.8)." This note is that
rehearsal. It proves the restore *mechanism* works against the local Docker database, using `pg_dump`/
`pg_restore` directly (`infra/scripts/backup.sh` and `restore.sh` do not exist yet — they are WBS 0.5/0.8,
Tier-0 infra work, doc 42 §6). **WBS 0.8's own acceptance ("`backup.sh` to OCI Object Storage + lifecycle
rules + first actual `restore.sh` test") is unaffected and still WAITING_GM** — it needs the Tier-0 host
(0.5), the real `backup.sh`/`restore.sh` scripts, and OCI Object Storage, none of which exist on this
machine.

## What was run

Against the local Docker `pgeos` database (`docker-compose.yml`, `postgres:16` Debian/glibc — D-105):

1. `pg_dump -Fc -d pgeos -f <dump>` — custom-format dump, 4,043,092 bytes.
2. `createdb -T template0 -E UTF8 --locale=C --lc-ctype=C.UTF-8 pgeos_restore_rehearsal` — same locale
   `apply.sh --recreate` and doc 42 §4.2/§6.3 require for every PG-EOS database.
3. `pg_restore -d pgeos_restore_rehearsal --no-owner --no-privileges <dump>` — clean run, no errors.
4. Verification queries against the restored copy, compared to the source `pgeos`:

| check | source `pgeos` | restored `pgeos_restore_rehearsal` |
|---|---|---|
| tables outside `pg_catalog`/`information_schema` | 191 | 191 |
| distinct schemas | 14 | 14 |
| `wms.locations` row count | 3,330 | 3,330 |
| `platform.audit_log` row count | 28,125 | 28,125 |
| `wms.verify_wh1()` | 21 rows, all pass | 21 rows, all pass (identical Arabic block labels, e.g. `مواقع التخزين`) |
| `platform.verify_audit_chain()` | 0 rows | 0 rows |
| `wms.verify_balance_integrity()` | 0 rows | 0 rows |
| `similarity('اختبار','اختبار')` (doc 42 §4.2 behaviour check) | 1.000000 | 1.000000 |

(The 191-table count is the live physical table count including monthly `platform.audit_log` partitions;
it is not the same figure as the "175 tables" documented elsewhere, which counts base tables only — both
figures matched exactly between source and restore, which is the only thing this rehearsal claims.)

5. Cleanup: `dropdb pgeos_restore_rehearsal`; the dump file and a scratch SQL file were deleted from the
   session's temp directory. Nothing was left behind — the live `pgeos` database was never modified.

## Result

**Pass.** Every count and every guard function matched exactly between the source and the restored copy,
including the Arabic-trigram behaviour check doc 42 §4.2 requires at WBS 0.5/0.8. This is a rehearsal of
the *mechanism* only — a manual `pg_dump`/`pg_restore` round trip on the local machine — and does not
satisfy WBS 0.8's acceptance criterion, which requires the real `backup.sh`/`restore.sh` scripts running
against Tier-0 and OCI Object Storage. Recorded per D-115; `tasks/MASTER_BACKLOG.md` row 0.8 stays
`WAITING_GM` (unblocked at 0.5).
