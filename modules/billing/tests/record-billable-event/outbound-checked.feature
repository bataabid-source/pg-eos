# modules/billing/tests/record-billable-event/outbound-checked.feature — WBS 4.3 part 1 (lane 2).
# Verbatim from docs/notes/slice-briefs/_slice-4.3-p1-wms-billable-subscriber.brief.md (RED tests).
# Acceptance: doc 40 line 444 — "billable events OF-01×1, OF-02×1, OF-06×1, OF-07×1 exist with status pending".
# Every Scenario title matches its `describe` title in record-outbound-checked.test.ts EXACTLY (scenario 6 lives in record-outbound-checked.unit.test.ts).

Feature: WMS subscriber records the fulfilment billable events at checked (WBS 4.3 part 1)
  Scenario: A wms.outbound.checked outbox row relayed once yields exactly one pending billing.billable_events row for each of OF-01, OF-02, OF-06, OF-07 on wms.outbound_orders/<order>, qty 1, uom of the catalog row, client and contract of the order, in one transaction
  Scenario: Redelivery of the same outbox row (at-least-once relay) leaves exactly one row per service and the row published
  Scenario: An outbox row of any other event type produces no billable event
  Scenario: A wms.outbound.checked row whose payload has no orderId is left unpublished with last_error naming the subscriber
  Scenario: A checked order of another entity is written under that entity (RLS: entity_id follows the source row)
  Scenario: A wms.outbound.checked event without entity_id is refused before any write (the outbox CHECK outbox_business_needs_entity already refuses the row)
