# modules/billing/tests/dimensions/dimensions.feature — WBS 4.1b PART 1 (lane 2).
#
# Scope ruling (brief, after pre-migration round 1 finding 1): part 1 ships ONLY
# `billing.dimension_types` — proving acceptance half 1 ("new dimension added with zero
# migration"). `billing.line_dimensions` and every value-related concept (`value_ref`, tagging a
# journal line) move to part 2. This feature file therefore has NO journal_entries / journal_lines
# / line_dimensions fixture and NO line_dimensions scenario. Every Scenario below matches its
# `dimensions.test.ts` `describe` title EXACTLY (precedent:
# modules/billing/tests/chart-of-accounts/chart-of-accounts.feature).
#
# Acceptance (doc 38 v4.6 row 4.1b, verbatim, half 1 only this part): "New dimension added with
# zero migration."
# ADR-0004 lines served: D1 6 ("entity_id stays a hard column; every other axis is dimension
# data") · D2 (d) ("entity_id stays the hard column ... generic dimension tables ... for every
# other axis; client_id/contract_id kept as derived copies").
# SCR-ACC-01 row served: #9 (part 1 half) — new billing.dimension_types, "Dimensions as data;
# backs the fixed client_id/contract_id/cost_center (01:1208-1210)".
# D-190 hybrid design: dimension_types.kind ∈ {list, reference}; reference kind carries a
# source_table from a closed whitelist (Schema design — part 1, brief).

Feature: Dimension types (WBS 4.1b part 1)
  As the CFO (owner, doc 38 v4.6 row 4.1b)
  I want a new dimension type to be addable as a plain data row, with its kind and (for reference
    kind) its source table validated by the database
  So that the chart of dimensions grows without a schema migration, and no dimension type can ever
    be defined with an invalid kind/source_table pairing (D-190 hybrid design)

  Background:
    Given a synthetic pilot entity (D-127) and a second, different entity used only to prove RLS
      isolation — no real dimension type is ever composed by this slice; every row used below is a
      test/synthetic fixture, never seeded by a migration (D3: nothing seeded)

  Scenario: A new dimension type is added as a data row — no DDL runs (zero migration)
    Given no schema change accompanies this test
    When a NEW billing.dimension_types row is inserted with a code never seen before, and a
      SECOND, different dimension type is inserted right after it
    Then both rows exist as plain data, distinguished only by their code

  Scenario: A dimension type of kind "reference" requires a source_table from the closed whitelist
    Given a dimension type is being inserted with kind = 'reference'
    When source_table is set to one of the closed whitelist values (sales.accounts,
      partners.partners, hr.employees, tms.vehicles, wms.warehouses, platform.sites,
      imile.shipments, platform.entities)
    Then the insert succeeds
    And when a dimension type is instead inserted with kind = 'reference' and source_table = null
    Then the insert is rejected by the database CHECK constraint

  Scenario: A dimension type of kind "list" must not carry a source_table
    Given a dimension type is being inserted with kind = 'list'
    When source_table is set to any non-null value
    Then the insert is rejected by the database CHECK constraint

  Scenario: An unknown/unwhitelisted source_table is rejected by the database CHECK
    Given a dimension type is being inserted with kind = 'reference'
    When source_table is set to a value that is NOT a member of the closed whitelist
    Then the insert is rejected by the database CHECK constraint

  Scenario: The same code may exist once per entity and never twice in one entity (unique (entity_id, code))
    Given a billing.dimension_types row already exists for the pilot entity with a given code
    When a SECOND row is inserted for the SAME entity with the SAME code
    Then the insert is rejected by the database unique constraint on (entity_id, code)
    And when a row is inserted for a DIFFERENT entity with the SAME code
    Then the insert succeeds

  Scenario: RLS — a caller scoped to another entity cannot read or write this entity's dimension_types rows
    Given a caller with no identity.user_entities row for the pilot entity (only for a different
      entity)
    When that caller queries billing.dimension_types rows belonging to the pilot entity
    Then zero rows are returned
    And when that caller attempts to INSERT a billing.dimension_types row for the pilot entity
    Then the insert is rejected by the row-level security policy
    And when that caller attempts to UPDATE the pilot entity's own dimension_types row
    Then the update affects zero rows, and the row is confirmed unchanged
    And when that caller attempts to DELETE the pilot entity's own dimension_types row
    Then the delete affects zero rows, and the row is confirmed to still exist unchanged
