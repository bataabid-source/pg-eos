# modules/billing/tests/record-billable-event/record-billable-event.feature — WBS 4.2 (lane 2).
#
# RESCOPED (round-1 review finding 1, FINAL round under D-186): `01-Data-Model.sql:1047` — the
# table is "generated automatically from domain events. No manual entry (P10)". This slice delivers
# ONLY a domain value-object/factory plus an infrastructure repository insert port
# (`insertBillableEvent`) that 4.3's system-actor subscribers will call — NO application command, NO
# Zod contract, NO handlers, NO api/ wiring, NO CFO role gate. Every Scenario title below matches
# its `record-billable-event.test.ts` `describe` title EXACTLY (round-1 finding 8).
#
# Acceptance (doc 38 line 152): "Same event cannot bill twice." Owner: CFO (read-only observer this
# slice; the write path is 4.3's).

Feature: Record a billable event — repository insert port (WBS 4.2)
  As 4.3's future system-actor subscriber
  I want insertBillableEvent to write exactly one billing.billable_events row per
    (sourceTable, sourceId, serviceId) triple, with one platform.outbox row and one
    platform.audit_log row in the same transaction
  So that the same event can never be billed twice (doc 38 line 152)

  Background:
    Given a client account, a catalog service, and an entity
    And entityId/clientId are NEVER caller-supplied directly — insertBillableEvent resolves them by
      reading the SOURCE ROW identified by (sourceTable, sourceId), inside the same withContext
      transaction, so RLS governs it naturally (D1)

  Scenario: a fresh (sourceTable, sourceId, serviceId) triple with a real seeded source row succeeds
    Given a REAL, RLS-visible source row exists (a wms.inbound_orders row) and no
      billing.billable_events row exists yet for this triple
    When insertBillableEvent is called
    Then exactly one billing.billable_events row is written at status "pending"
    And entity_id and client_id are resolved from the source row, never caller-supplied
    And unit_price and amount are null
    And exactly one platform.outbox row and exactly one platform.audit_log row are written in the
      same transaction

  Scenario: sourceId points to a nonexistent or RLS-invisible source row
    Given the (sourceTable, sourceId) pair identifies no row visible under the caller's own entity
      scope — either it does not exist, or it exists outside the caller's RLS-visible entities
    When insertBillableEvent is called
    Then it rejects with a typed not-found error
    And nothing is written

  Scenario: sourceTable is outside the closed list
    Given sourceTable is not one of the closed list of billing-source tables
    When insertBillableEvent is called
    Then it rejects with a typed InvalidSourceTableError
    And nothing is written

  Scenario: caller-supplied clientId disagrees with the source row's own client_id
    Given a real source row exists whose own client_id differs from the caller-supplied clientId
    When insertBillableEvent is called
    Then it rejects with a typed ClientMismatchError
    And nothing is written

  Scenario: the same (sourceTable, sourceId, serviceId) triple is inserted twice in sequence
    Given insertBillableEvent already succeeded once for a triple
    When insertBillableEvent is called again with the SAME triple
    Then the second call rejects with a typed DuplicateBillableEventError raised via the SQLSTATE
      23505 catch on the pre-existing unique index (13B ق-38) — the DB-constraint backstop, not
      just the domain-level pre-check
    And exactly one billing.billable_events row exists for that triple

  Scenario: qty is not a finite positive number
    When insertBillableEvent is called with a qty that is NaN, Infinity, -Infinity, zero, or negative
    Then it rejects with a typed error
    And nothing is written

  Scenario: cross-entity isolation — RLS entity_scope governs the table
    Given a billing.billable_events row was written under one entity
    When a caller with no identity.user_entities row for that entity queries the table with the same
      query the owner uses
    Then the row is invisible to the outsider and visible to the owner

  Scenario: commercial-column masking on the audit row
    Given insertBillableEvent wrote a row with unit_price/price_source/amount all null
    When the platform.audit_log row for that insert is read back through platform.sanitize_audit
    Then unit_price, price_source and amount are masked to "•••" even though the stored value is null
    And a non-commercial key (status) is read back unmasked
