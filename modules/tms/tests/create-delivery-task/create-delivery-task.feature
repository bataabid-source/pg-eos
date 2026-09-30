# modules/tms/tests/create-delivery-task/create-delivery-task.feature — WBS 3.4 part 1.
# Executed by create-delivery-task.test.ts (application layer), handlers.test.ts (api mapping and
# idempotent replay), invariants.unit.test.ts (INV-C4-2 and order readiness, domain) and
# vehicle-assignable-guard.test.ts (migration 0046, raw SQL). Per D-208 each rule is asserted once,
# at the lowest layer that can prove it.
# Source: docs/notes/slice-briefs/_slice-3.4-p1-delivery-task.brief.md (Gherkin block, Decisions 1-4);
# doc 40 lines 273-274 and 444-446; doc 03 lines 132-133.

Feature: Create delivery task and INV-C4-1 vehicle guard (WBS 3.4 part 1)

  Scenario: A checked outbound order in PDL gets exactly one tms.delivery_tasks row with status created, a TSK doc_no, version 1 and a tms.task.created outbox row in the same transaction
    Given an outbound order in PDL with status "checked"
    When CreateDeliveryTask is called with a complete address and the order's current version
    Then exactly one tms.delivery_tasks row exists with status "created", version 1, no vehicle and no driver
    And its doc_no comes from platform.next_doc_no(entity, "TSK")
    And the order's delivery_task_id is set and its version is bumped
    And exactly one platform.outbox row "tms.task.created" exists for the task
    And the S1 query "select id from tms.delivery_tasks where outbound_order_id = $1 and entity_id = $2" returns one row

  Scenario: A replay with the same Idempotency-Key returns the same task; a second create for the same order is refused with 409
    Given a delivery task was created for an order
    When the same Idempotency-Key and body are sent again
    Then the first response is returned and the command does not run twice
    When another create is sent for the same order with a new key
    Then it is refused with "tms.task.create.alreadyExists" (409) and still one row exists

  Scenario: A create without area, block, street or recipient phone is refused with 422 (INV-C4-2)
    When CreateDeliveryTask is called with a missing or whitespace-only area, block, street or recipientPhone
    Then it is refused with "tms.task.create.addressIncomplete" (422) and nothing is written

  Scenario: A create for an order not yet checked is refused with 422
    Given an outbound order whose status is not checked, packed or loaded
    When CreateDeliveryTask is called
    Then it is refused with "tms.task.create.orderNotReady" (422) and nothing is written

  Scenario: A raw INSERT or UPDATE setting vehicle_id to a vehicle with a document expired before today (Asia/Kuwait) is rejected with SQLSTATE 23514 on tms.delivery_tasks and on tms.routes
    Given a vehicle with a document whose expiry_date is before today in Asia/Kuwait
    When vehicle_id is set to it by INSERT or by UPDATE on either table
    Then the statement fails with SQLSTATE 23514 and constraint "inv_c4_1_vehicle_assignable"

  Scenario: A vehicle whose documents all expire today or later is accepted on both tables; a null vehicle_id is never checked
    Given a vehicle whose documents all expire today or later in Asia/Kuwait
    When vehicle_id is set to it on tms.delivery_tasks or tms.routes
    Then the statement succeeds
    And a null vehicle_id is accepted, and an UPDATE of another column is never checked
