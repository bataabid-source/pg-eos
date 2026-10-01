# modules/wms/tests/receive-inbound/quarantine.feature — WBS 2.9 part 3 step 2 (S1 scenario 1 steps 3-4).
# Source: docs/notes/slice-briefs/_slice-2.9-p3-s2-qrt-quarantine.brief.md, GM decision D-211.
Feature: Short-shelf-life receipt is quarantined (WBS 2.9 part 3 step 2, doc 40 S1 scenario 1)
  Scenario: A receipt whose remaining life in Asia/Kuwait calendar days is below the SKU's min receipt shelf life lands on a QRT-zone operational location and writes one open quarantine_decision (source wms.inbound_orders, assigned to the approval-chain role, due after the threshold hours) in the same transaction
  Scenario: Migration 0047 seeds the quarantine_decision approval-chain row and the due-hours threshold once, and re-applying changes nothing
  Scenario: A receipt at or above the minimum, or of a SKU without track_expiry or without a minimum, lands in RCV as today and writes no decision
  Scenario: A replay of the receipt under the same Idempotency-Key writes no second decision and no second movement
  Scenario: ConfirmPutaway of a quarantined line is refused with 422 while its decision is open
  Scenario: A lot held on a quarantine-zone location is never an outbound allocation candidate
  Scenario: The receipt's GRN, wms.inbound.received event and audit rows are unchanged by the routing
