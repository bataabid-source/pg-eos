# modules/imile/tests/report-agent-health/report-agent-health.feature — WBS 3.14.
# Every scenario below is executed by modules/imile/tests/report-agent-health/report-agent-health.test.ts.
# Source: docs/package/40-Build-Specification-EN.md §C8 M11 iMile Operations (station agent,
# `services/agent`: dedicated account, single session, health heartbeat, stop > 15 min -> DEL_MGR,
# > 60 min -> GM); database/schema/01-Data-Model.sql:1426-1436 (imile.agent_health — append-only,
# no version column); 13B-Schema-Reference-Consolidation.sql:2845-2850 (platform.alert_rules
# 'N-01', frozen).

Feature: Station agent reports health (WBS 3.14)
  As the iMile station agent process (dedicated account, single session, remote UI operator)
  I want to report a health heartbeat every pull cycle
  So that a stalled agent is detected and alerted (doc 40 §C8: stop > 15 min -> DEL_MGR, > 60 min -> GM)

  Background:
    Given each iMile account the agent uses (station, or one per auditor/warehouse user) is
      dedicated and single-session at the iMile-portal level; this module does not enforce
      cross-account exclusivity — accounts report health independently
    And every ReportAgentHealth call carries an Idempotency-Key and a correlationId

  Scenario: First health report opens the active session
    When ReportAgentHealth is called with sessionValid=true, a fresh lastPullAt and pendingPushes=0
    Then a new imile.agent_health row is written and NO platform.outbox row is written for that
      correlationId (the Master has deferred `imile.agent_health.reported` publication — a G-01 gap
      is filed, docs/notes/2026-09-24-imile-agent-scenario.md §4 row 'e'), and that agentId becomes
      the active session

  Scenario: A later report from the same agent extends the active session
    Given agent "IMILE-STATION-01" already holds the active session
    When ReportAgentHealth is called again from the same agentId with a newer lastPullAt
    Then a new row is written (append-only — no update, no version bump) and the session stays active

  Scenario: An unhealthy report requires an error message
    When ReportAgentHealth is called with sessionValid=false and no errorMessage
    Then it is rejected with a typed SessionInvalidWithoutReasonError and nothing is written

  Scenario: An unhealthy report with a reason is accepted
    When ReportAgentHealth is called with sessionValid=false and errorMessage set
    Then the row is written with session_valid=false and the active session stays assigned to that agentId

  Scenario: pendingPushes must not be negative
    When ReportAgentHealth is called with pendingPushes = -1
    Then it is rejected by the contract schema before the command runs

  Scenario: lastPullAt cannot be after reportedAt
    When ReportAgentHealth is called with a lastPullAt in the future
    Then it is rejected with a typed LastPullInFutureError and nothing is written

  Scenario: Reports from two different agent accounts are both recorded independently
    (D-148/D-149, docs/notes/2026-09-24-imile-agent-scenario.md §5/§7: several simultaneous agent
    sessions coexist — one station account, one per auditor, one per warehouse user. Doc 40 §C8's
    "single session — any other login drops it" describes ONE iMile account's OWN portal session
    (tracked on that same account's own reports), not cross-account exclusivity.)
    When ReportAgentHealth is called from agentId "IMILE-STATION-01"
    And ReportAgentHealth is called again from a different agentId "IMILE-AUDITOR-07"
    Then both rows are written, both are visible, and neither call is rejected because of the other

  Scenario: RLS — a caller outside the internal roles cannot read agent_health
    Given a caller with no internal operations role
    When that caller queries imile.agent_health
    Then no rows are visible to them

  Scenario: ReportAgentHealth is idempotent
    Given an Idempotency-Key and body already used once for ReportAgentHealth
    When ReportAgentHealth is called again with the SAME key and the SAME body
    Then the second call returns the stored result without a second insert, and NO platform.outbox
      row is written for that correlationId (outbox publication deferred, see above)

  Scenario: The same Idempotency-Key with a different body is rejected
    Given an Idempotency-Key already used once for ReportAgentHealth
    When ReportAgentHealth is called again with the SAME key but a DIFFERENT body
    Then it is rejected with IdempotencyConflictError (maps to HTTP 409)

  Scenario: A stale pull matches the existing N-01 alert condition (doc 38 acceptance: "stop > 15 min alerts")
    Given the active session's last written row has last_pull_at older than 15 minutes
    When platform.alert_rules code "N-01"'s source_query is evaluated
    Then it returns exactly one row for entity_ref "imile_agent"

  Scenario: A fresh pull within 15 minutes does not match N-01
    Given the active session's last written row has last_pull_at within the last 15 minutes
    When platform.alert_rules code "N-01"'s source_query is evaluated
    Then it returns zero rows
