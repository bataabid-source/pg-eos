# modules/platform/tests/evaluate-alerts/evaluate-alerts.feature — WBS 5.13 part 1 (alert
# evaluation mechanism), replicated from the golden slice's feature file
# (modules/wms/tests/receive-inbound/receive-inbound.feature) — shape only, this use case's logic
# is doc 40 §B6 / doc 25 §1-§2, not inbound receiving.
#
# Every scenario below is executed by modules/platform/tests/evaluate-alerts/evaluate-alerts.test.ts
# (integration, DB-backed) or by the property/unit test files named in that scenario's assertions.
# Sources: docs/notes/slice-briefs/_slice-5.13.brief.md, docs/package/25-Alerts-Reports-NFR.md §1-§2,
# database/schema/13B-Schema-Reference-Consolidation.sql:500-3043, migration 0011.
#
# fix round 1 (pg-reviewer FAIL(19), finding 10): this feature named N-13/N-03/N-02 while
# evaluate-alerts.test.ts actually runs N-19/N-06/N-19/N-01/N-03 (the rules whose fixtures are
# cheapest to seed under RLS, per the build brief). Rule codes below now match the tests exactly;
# also doc 25 §1 names NO timezone — the platform default is 'Asia/Kuwait' (doc 40 §A3 ~L54), not
# the previously-fabricated 'Asia/Riyadh' (finding 3).

Feature: Evaluate alert rules (doc 40 §B6, doc 25 §1-§2)

  Scenario: An alert without an action link is impossible
    Given every row in platform.alert_rules
    Then action_label and action_link are both non-null and non-empty

  Scenario: A rule fires when its source_query returns a row
    Given an active alert rule "N-19" whose source_query returns one stale pending integration row
    When EvaluateAlertRules runs
    Then one platform.alert_log row is written with rule_code "N-19" and the row's entity_ref
    And a "platform.alert.fired" event is written to platform.outbox in the same transaction,
      aggregate_type "platform.alert_rules", aggregate_id the rule's own uuid
    And exactly one platform.audit_log row is written, operation "insert", record_id NULL, the
      alert_log id inside new_value.id (record_id is uuid; alert_log's own PK is bigint)

  Scenario: A rule does not fire twice inside its non-zero dedupe window
    Given rule "N-19" (dedupe_window_hours = 6) already fired for a pending-integration entity_ref
    When EvaluateAlertRules runs again for the same source_query result
    Then no new platform.alert_log row is written for that entity_ref

  Scenario: dedupe_window_hours = 0 means no suppression
    Given rule "N-06" (dedupe_window_hours = 0) already fired for an expiring-contract entity_ref
    When EvaluateAlertRules runs again with the same result row
    Then a new platform.alert_log row IS written (zero means no suppression, doc 25 §1)

  Scenario: Quiet hours suppress a non-exempt rule
    Given the clock reads 23:00 Kuwait and rule "N-19" has quiet_hours = true
    When EvaluateAlertRules runs and N-19's source_query would fire
    Then no platform.alert_log row is written for N-19
    And the same evaluation fires normally once the clock reads 08:00 Kuwait

  Scenario: Quiet hours never suppress the two emergency-exempt rules
    Given the clock reads 23:00 Kuwait
    When EvaluateAlertRules runs and rule "N-01" or "N-03" would fire
    Then the platform.alert_log row IS written (doc 25 §1: N-01 and N-03 are the only exemptions)
    And, for N-03, the outbox payload/aggregate and the audit row are asserted in full

  Scenario: A data-changing or erroring source_query never aborts the pass
    Given one rule's source_query would write to the database, or is multi-statement, or is broken
    When EvaluateAlertRules runs (each rule in its own read-only savepoint)
    Then that rule's code appears in the result's `failed` list, no platform.alert_log row is
      written for it, the platform.alert_rules table is unchanged, and every OTHER rule in the
      same pass still fires normally

  Scenario: An alert never targets an unfilled position
    Given identity.roles contains OPS_DIR and HR_MGR with zero active identity.user_roles holders
    Then no seeded platform.alert_rules.target_roles or escalate_to_roles array contains
      "OPS_DIR" or "HR_MGR" (doc 25 §1-2: OPS_DIR reads WH_MGR+DEL_MGR by scope; HR_MGR reads GM)

  Scenario: Acknowledging an alert is idempotent
    Given a fired, unacknowledged platform.alert_log row and an Idempotency-Key
    When AcknowledgeAlert is called twice with the same Idempotency-Key
    Then the row is acknowledged exactly once and the second call returns the first result

  Property test: for every row seeded into platform.alert_rules, action_label <> '' and
    action_link starts with '/' (doc 40 §B6 invariant, domain-level, not just the DB NOT NULL).

  Property test: for every rule whose code is NOT "N-01" or "N-03", quiet_hours = true
    (doc 25 §1: those two are the ONLY exemptions in the record).

  Scenario: The superseded rule never fires
    Given rule "N-16" (is_active = false after migration 0011) and no biometric integration run
    When EvaluateAlertRules runs
    Then no platform.alert_log row is written for "N-16" (inactive rules are never evaluated)

  Scenario: RLS — an out-of-scope caller sees and does nothing
    Given a caller whose ctx.isInternal is false
    Then EvaluateAlertRules and AcknowledgeAlert both reject with RoleRequiredError beforehand
    And, in a raw pgeos_app session with app.is_internal = false, platform.alert_log is invisible

  Scenario: A missing actor is rejected before any write
    Given a caller whose ctx.userId is null
    Then EvaluateAlertRules and AcknowledgeAlert both reject with MissingActorError

  Scenario: An unknown alert_log id is rejected with a typed error, not a bare exception
    When AcknowledgeAlert is called with an alertLogId that does not exist
    Then it is rejected with AlertLogNotFoundError (handler maps it to HTTP 404)
