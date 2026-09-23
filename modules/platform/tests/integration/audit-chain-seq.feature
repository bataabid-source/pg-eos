# WBS 0.9 — SCR-AUDIT-01 approved fix (GM decision 2026-09-23 #4, phase G).
# Interface (fixed): docs/notes/SCR-AUDIT-01-hash-chain-order-race.md §7.1 — column
# platform.audit_log.chain_seq (previous + 1, assigned by the trigger under the advisory lock),
# unique index <partition>_chain_seq_key on every partition (default included), and
# platform.verify_audit_chain(p_anchor_seq bigint default 1, p_anchor_prev_hash text default null)
# returning (chain_seq, id, occurred_at, problem, detail, expected_hash, actual_hash).
# Every scenario that writes runs in ONE transaction that is rolled back — nothing persists.
# Executable form: modules/platform/tests/integration/audit-chain-seq.test.ts

Feature: platform.audit_log is chained by a gapless chain_seq and verified in chain_seq order (SCR-AUDIT-01, WBS 0.9)
  # doc 31 §4 (hash chain) · doc 40 §B2 · doc 40 Part F G8 · 13B-2.

  Background:
    Given the schema is applied
    And seed entity PCC exists in platform.entities
    And fixture rows use actor_type 'system', schema_name 'platform', table_name '_audit_chain_seq_fixture', operation 'insert', entity_id PCC and a fresh random record_id
    And every writing scenario runs inside one transaction
    And that transaction first takes the advisory lock hashtext('platform.audit_log')
    And that transaction is rolled back at the end, whatever the outcome

  Scenario: Every partition carries the chain_seq unique index (GM condition 1)
    Given the partitions of platform.audit_log listed in pg_inherits, audit_log_default included
    When each partition's indexes are read from pg_index and pg_attribute
    # By pg_index properties only — the index name is never checked (pg-reviewer finding 9).
    Then each partition has a unique index
    And that index is valid, ready and live
    And that index has exactly one column (indnatts = 1) and exactly one key column
    And that key column (indkey[0]) is chain_seq's attnum in that partition
    And that index has no expression and no predicate
    And no partition is listed as an offender

  Scenario: A partition created without the index is reported (negative control)
    Given platform.audit_log_2099_01 does not exist
    When platform.audit_log_2099_01 is created as a partition for 2099-01-01 to 2099-02-01
    And no chain_seq unique index is created on it
    Then platform.verify_audit_chain() returns exactly one row with problem 'partition_missing_chain_seq_unique_index'
    And that row's detail contains 'audit_log_2099_01'
    And that row's chain_seq is null
    And that row's id is null
    And that row's occurred_at is null

  Scenario: Consecutive inserts are numbered previous + 1
    Given h is the highest chain_seq in platform.audit_log, 0 when empty
    And H is the row_hash of the row with chain_seq h, null when empty
    When 3 fixture rows are inserted one after another
    Then their chain_seq values are h+1, h+2 and h+3
    And the first row's prev_hash is H
    And the second row's prev_hash is the first row's row_hash
    And the third row's prev_hash is the second row's row_hash

  Scenario: A rolled-back insert releases its number
    Given platform.verify_audit_chain() returns zero rows
    And h is the highest chain_seq in platform.audit_log, 0 when empty
    And a savepoint is set
    When a fixture row is inserted
    And its chain_seq is h+1
    And the transaction rolls back to the savepoint
    And another fixture row is inserted
    Then the new row's chain_seq is h+1
    And the new row's prev_hash is the row_hash of the row with chain_seq h
    And platform.verify_audit_chain() returns zero rows

  Scenario: A deleted middle row is reported as a gap
    Given 3 fixture rows have been inserted
    When the middle row is deleted
    Then platform.verify_audit_chain() contains a 'chain_seq_gap' row
    And that row's chain_seq is the third row's chain_seq
    # A 'prev_hash_mismatch' row may also be reported — membership is asserted, not the count.

  Scenario: The same chain_seq in two partitions is reported as a duplicate
    Given a fixture row A is inserted with occurred_at now()
    And a fixture row B is inserted with occurred_at 2030-01-01
    And row B sits in platform.audit_log_default
    And row A sits in a different partition
    When row B's chain_seq is set to row A's chain_seq
    Then platform.verify_audit_chain() contains a 'duplicate_chain_seq' row
    And that row's chain_seq is row A's chain_seq

  Scenario: A tampered row_hash is reported as a hash mismatch
    Given a fixture row R has been inserted
    When R's row_hash is set to 'deliberately-tampered-hash'
    Then platform.verify_audit_chain() contains a 'hash_mismatch' row
    And that row's id is R's id
    And that row's chain_seq is R's chain_seq
    And that row's actual_hash is 'deliberately-tampered-hash'
    And that row's expected_hash is R's original row_hash

  Scenario: Verification starts from an anchor when earlier history is gone (GM condition 3)
    Given 4 fixture rows have been inserted with chain_seq s, s+1, s+2 and s+3
    And anchorSeq is s+2
    And anchorPrev is the prev_hash of the row with chain_seq s+2
    When every row of platform.audit_log with chain_seq below anchorSeq is deleted
    Then platform.verify_audit_chain() reports a 'chain_seq_gap' or 'prev_hash_mismatch' row at anchorSeq
    And platform.verify_audit_chain(anchorSeq, anchorPrev) returns zero rows
    And platform.verify_audit_chain(anchorSeq, 'deliberately-wrong-anchor-prev-hash') contains a 'prev_hash_mismatch' row
    And that row's chain_seq is anchorSeq

  Scenario: A transaction under REPEATABLE READ that inserts into platform.audit_log is refused
    Given a transaction is begun with isolation level repeatable read
    When a fixture row is inserted
    Then the insert is rejected with an error
    And the error message contains 'read committed', compared case-insensitively
    # Trigger text: 'platform.audit_hash_chain: audited writes must run under READ COMMITTED (current: repeatable read)'
    And the transaction is rolled back

  Scenario: row_hash rendering is pinned (timezone/datestyle)
    Given the transaction sets local timezone 'Asia/Kolkata' and local datestyle 'SQL, DMY'
    And a fixture row R is inserted
    When the transaction sets local timezone 'America/New_York' and local datestyle 'ISO, MDY'
    Then platform.verify_audit_chain() returns zero rows for R's id or R's chain_seq

  Scenario: A non-internal writer that cannot see the chain head still chains after it
    # pg-reviewer round 2: platform.audit_hash_chain() is SECURITY DEFINER (SCR-AUDIT-01 §7.1).
    Given a fixture row with entity_id PCC is inserted as superuser
    And H is that row's chain_seq
    And HH is that row's row_hash
    And a temporary role 'pgeos_t_<random>' exists with NOSUPERUSER NOBYPASSRLS NOLOGIN
    And the role has USAGE on schema platform
    And the role has SELECT and INSERT on platform.audit_log
    And the role has USAGE on pg_get_serial_sequence('platform.audit_log', 'id')
    And the transaction sets local role to it
    And app.is_internal is 'false'
    And app.user_id is a random uuid
    And app.client_id is null
    When the role counts platform.audit_log rows with chain_seq H
    Then the count is 0
    When the role inserts a row with entity_id null, returning only id and occurred_at
    And the role is reset
    Then, read as superuser, that row's chain_seq is H+1
    And that row's prev_hash is HH
    And platform.verify_audit_chain() has no row for that row

  Scenario: A role without the owner's rights cannot run the verifier
    Given a temporary role 'pgeos_t_<random>' exists with NOSUPERUSER NOBYPASSRLS NOLOGIN
    And the role has USAGE on schema platform
    # SELECT is granted so that the refusal can only come from EXECUTE on the function.
    And the role has SELECT on platform.audit_log
    And the transaction sets local role to it
    When the role runs select * from platform.verify_audit_chain()
    Then the call fails
    And the SQLSTATE is 42501 (insufficient_privilege)
    And the error message names verify_audit_chain
    # Returning zero rows is a failure of this scenario.

  Scenario: A NULL anchor is reported, not silently clean
    When select problem from platform.verify_audit_chain(null, null) is run
    Then the result contains a row with problem 'anchor_invalid'

  Scenario: An anchor above the head is reported
    Given a fixture row has been inserted
    And h is the highest chain_seq in platform.audit_log
    When select problem from platform.verify_audit_chain(h + 10, null) is run
    Then the result contains a row with problem 'anchor_not_found'

  Scenario: The whole table verifies clean (G8 contract)
    Given no transaction is open
    When select * from platform.verify_audit_chain() is run
    Then it returns zero rows
