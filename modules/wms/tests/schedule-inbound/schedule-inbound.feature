# modules/wms/tests/schedule-inbound/schedule-inbound.feature — WBS 2.9b (lane 2).
# Every scenario below is executed by modules/wms/tests/schedule-inbound/schedule-inbound.test.ts.
# Source: docs/notes/slice-briefs/_slice-2.9b.brief.md (Facts/D1-D8), SCR-WMS-INB-01 §7/§8.
# ScheduleInbound does NOT reopen 2.9's golden-slice acceptance — this is a NEW use-case folder.

Feature: Schedule inbound (appointment) + logistics terms (WBS 2.9b)
  As a warehouse manager or supervisor
  I want to give an inbound order a delivery appointment and record its logistics terms
  So that the client knows when and how goods change hands, and billing/labour can plan for it

  Background:
    Given a WH1 warehouse and a client with an active account
    And an inbound order "INB" with one or more order lines
    And every command input carries an expectedVersion, a correlationId, and no performedBy field
      — the actor is always ctx.userId

  Scenario: ScheduleInbound with a future expectedAt on a draft order
    Given the caller holds role "WH_MGR" or "WH_SUP"
    And the order is in status "draft"
    When ScheduleInbound is called with a future expectedAt
    Then expected_at, scheduled_by and scheduled_at are set on the order
    And the order's version is bumped
    And exactly one "wms.inbound.scheduled" outbox row and one audit row are written in the same
      transaction, sharing the correlationId
    And the order's status is unchanged (no machine, self-transition, D1)

  Scenario: ScheduleInbound with a past expectedAt is rejected
    When ScheduleInbound is called with an expectedAt in the past (relative to the injected clock)
    Then it is rejected with a typed "schedule in the past" error
    And nothing is written — expected_at, scheduled_by, scheduled_at, version all stay as they were

  Scenario: Rescheduling — calling ScheduleInbound again on an already-scheduled order
    Given the order was already scheduled once
    When ScheduleInbound is called again with a new future expectedAt
    Then the version bumps again
    And a SECOND "wms.inbound.scheduled" outbox row is written (a distinct correlationId from the
      first call)
    And expected_at/scheduled_at reflect the SECOND call's values

  Scenario: ScheduleInbound is also legal on an approved order (self-transition)
    Given the order is in status "approved"
    When ScheduleInbound is called with a future expectedAt
    Then it succeeds exactly as it does from "draft" — the order's status stays "approved"

  Scenario: ScheduleInbound is illegal once the order has left draft/approved
    Given the order has been cancelled
    When ScheduleInbound is called
    Then it is rejected with a typed illegal-transition error and nothing is written

  Scenario: The four logistics terms are written, and delivery_task_id is NEVER auto-populated
    When ScheduleInbound is called with handoverPoint "client_site", transportBy "premium",
      vehicleType "truck", labourBy "premium", labourCount 3
    Then handover_point, transport_by, vehicle_type, labour_by, labour_count are persisted exactly
      as supplied
    But delivery_task_id stays null — no tms.delivery_tasks row is created and none is linked
      (D5 — nullable column only, never populated this slice, even for transportBy=premium +
      handoverPoint=client_site)

  Scenario: vehicle_type outside the closed list is rejected
    When ScheduleInbound is called with a vehicleType not in
      (container_20, container_40, truck, trailer, van, pickup, other)
    Then it is rejected with a typed invalid-vehicle-type error and nothing is written

  Scenario Outline: the other logistics-term CHECKs are enforced at the domain layer too
    When ScheduleInbound is called with <term> set to <value>
    Then it is rejected with <error> (422)
    And nothing is written — no column, no version bump, no outbox row, no audit row

    Examples:
      | term          | value        | error                     |
      | handoverPoint | "airport"    | InvalidHandoverPointError |
      | transportBy   | "shared"     | InvalidTransportByError   |
      | labourBy      | "contractor" | InvalidLabourByError      |
      | labourCount   | -1           | InvalidLabourCountError   |

  Scenario: labourCount 0 is the legal boundary
    When ScheduleInbound is called with labourCount 0
    Then it succeeds and labour_count is persisted as 0

  Scenario: scheduleNote has no column — it only reaches the audit row and the event payload
    When ScheduleInbound is called with a scheduleNote
    Then no column on wms.inbound_orders stores it
    But the audit row's newValue and the "wms.inbound.scheduled" event payload both carry it

  Scenario: commercial-classified logistics-term columns are masked in the audit row
    When ScheduleInbound is called with handoverPoint/transportBy/labourBy/labourCount set
    Then platform.sanitize_audit masks handover_point/transport_by/labour_by/labour_count to "•••"
      when the audit row's newValue is read through it
    And delivery_task_id is never a key of the audit newValue at all (D5 — never populated)
    But the "wms.inbound.scheduled" event payload carries the UNMASKED raw values

  Scenario: Idempotency-Key replay returns the stored result without a second write
    Given an Idempotency-Key and a request body already used once for ScheduleInbound
    When ScheduleInbound is called again with the SAME key and the SAME body
    Then the second call returns the stored result, the version bumps exactly once, and only one
      "wms.inbound.scheduled" outbox row exists for the first correlationId

  Scenario: ScheduleInbound without the required role is rejected
    Given the caller holds no WH_MGR/WH_SUP role
    When ScheduleInbound is called
    Then it is rejected with RoleRequiredError and nothing is written

  Scenario: RLS — an outsider cannot schedule an order outside their entity
    Given a caller with no identity.user_entities row for the order's entity
    When that caller calls ScheduleInbound on the order
    Then it is rejected with the same not-found convention as a missing order
    And the order's status, version and appointment columns are unchanged

  # -- ApproveInbound / CancelInbound extensions are exercised in
  # modules/wms/tests/receive-inbound/receive-inbound.feature (scoped grant, D2/D3) --

  Scenario: listScheduledAppointmentsToday returns today's appointments ordered by expected_at
    Given two orders scheduled for today's date and one scheduled for a different day
    When listScheduledAppointmentsToday is called for the warehouse
    Then only the two orders scheduled for today are returned, ordered by expected_at ascending
    And each row carries vehicle_type and labour_count
    And an approved order with no appointment (expected_at null) is excluded from the list
