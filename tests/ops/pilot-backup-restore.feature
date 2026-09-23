# tests/ops/pilot-backup-restore.feature — WBS 0.8 (pg-tester).
#
# D-130 pilot acceptance (supersedes the OCI-only wording of doc 38 row 0.8, docs/package/42 §6.2/§6.3):
# a real scripts/backup.sh / scripts/restore.sh round trip against the LOCAL Docker postgres:16
# (infra/docker/docker-compose.yml, database `pgeos`), local-file target only — no OCI Object
# Storage for the pilot (that target is added with WBS 0.5). Restore target is `pgeos_restore`.
# This scenario is the executable spec behind tests/ops/tests/backup-restore.test.ts.

Feature: Pilot backup and restore — local Docker target
  As the system owner (SYSADMIN, per tasks/MASTER_BACKLOG.md row 0.8)
  I want scripts/backup.sh and scripts/restore.sh to run a real dump/restore cycle
  against the local Docker pgeos database
  So that the Phase-0 gate (tasks/MASTER_BACKLOG.md line 48) can close on the pilot machine
  without waiting on OCI Object Storage (WBS 0.5, deferred)

  Background:
    Given the local Docker Postgres 16 container "pg-eos-postgres" is running and reachable
    And the database "pgeos" exists with its full applied schema (database/schema/apply.sh --recreate)
    And "data/backups/" is a local directory on this machine (gitignored)

  Scenario: S-0.8-1 — backup.sh writes a local custom-format dump, no OCI upload
    When "scripts/backup.sh" is run against the local "pgeos" database
    Then it exits 0
    And a new dump file appears under "data/backups/"
    And the dump file is non-empty
    And no OCI Object Storage call is made (pilot has no OCI target yet — WBS 0.5)

  Scenario: S-0.8-2 — restore.sh restores the dump into pgeos_restore and every guard passes
    Given a dump file produced by "scripts/backup.sh" in the previous scenario
    When "scripts/restore.sh <dump>" is run with that dump file's path
    Then it exits 0
    And the database "pgeos_restore" exists, created with template0, encoding UTF8,
      lc-collate C and lc-ctype C.UTF-8 (SCR-TRGM-01)
    And "wms.verify_balance_integrity()" returns 0 rows on "pgeos_restore"
    And "billing.verify_journal_balance()" returns 0 rows on "pgeos_restore"
    And "platform.verify_audit_chain()" returns 0 rows on "pgeos_restore"
    And "wms.verify_wh1()" returns 21 rows, all with passed = true, on "pgeos_restore"
    And the locale/trigram check (doc 42 §6.3, SCR-TRGM-01) on "pgeos_restore" reports
      datctype = "C.UTF-8", datcollate = "C", and similarity()/trigram matching on Arabic
      text ("مخزن") is non-empty

  Scenario: S-0.8-3 — restore.sh fails loudly on a broken locale or a failing guard
    Given a restored database whose locale or any guard function does not match the expected values
    Then "scripts/restore.sh" exits non-zero
    And it does not report success

  # Cleanup (test-harness concern, not part of the acceptance itself): the test suite drops
  # "pgeos_restore" and deletes the dump file it created, in an afterAll, defensively.
