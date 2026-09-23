# WBS 0.9 — SCR-AUDIT-01 regression (GM directive 2026-09-23, item G4).
# The defect: docs/notes/SCR-AUDIT-01-hash-chain-order-race.md. platform.audit_hash_chain() chains
# rows in advisory-lock acquisition order; platform.verify_audit_chain() recomputes the chain in
# (occurred_at, id) order. Concurrent writers make the two orders disagree.
# Design-agnostic: this scenario asserts only on columns and functions that exist in 13B today
# (no chain_seq, no new ordering key), so it stays valid whichever fix the GM picks.
# RED on the unfixed schema; must turn green, unchanged, once the fix lands.
# Executable form: modules/platform/tests/integration/audit-chain-concurrency.test.ts

Feature: platform.audit_log's hash chain stays valid under concurrent writers (SCR-AUDIT-01 regression, WBS 0.9)
  # doc 31 §4 (hash chain) · doc 40 Part F G8 ("Audit hash chain breaks = 0") · 13B-2.

  Background:
    Given the schema is applied
    And seed entity PCC exists in platform.entities
    And platform.verify_audit_chain() returns zero rows before the run
      # If not: the operator runs `bash database/schema/apply.sh --recreate`. The test never repairs data.

  Scenario: 8 concurrent writers x 500 single-row transactions keep the chain verifiable
    Given 8 writers, each holding its own database connection
    And half of the writers leave occurred_at to its default now()
    And the other half supply one identical fixed occurred_at inside the current month's partition
    When all 8 writers run at the same time, each performing 500 inserts into platform.audit_log
    And each insert is its own transaction (begin; insert; commit)
    And each row has actor_type 'system', schema_name 'platform', table_name '_audit_concurrency_fixture', operation 'insert', entity_id PCC and a fresh random record_id
    Then exactly 8 x 500 new platform.audit_log rows carry this run's record_ids
    And platform.verify_audit_chain() returns zero rows
    And on failure the number of broken rows is reported
    # Audit rows are never deleted (hash chain; WBS 0.18 tail-only precedent) — no cleanup.
