# modules/billing/tests/dimensions/line-dimensions.feature — WBS 4.1b PART 2 (lane 2).
#
# Scope: `billing.dimension_values` (list kind) + `billing.line_dimensions` (both kinds) + the
# `billing.assert_dimension_value()` constraint trigger + the entity-deriving trigger on
# `line_dimensions.entity_id` (SCR-ACC-01 #9 part 2, D-190 hybrid design). Extends the part-1 tree
# (./dimensions.feature, ./dimensions.test.ts) in place. Every Scenario title below matches its
# ./line-dimensions.test.ts `describe` title EXACTLY (precedent: ./dimensions.feature's own header).
#
# Close review round 1 — FAIL (fix round, REVIEW CAP one round). `billing.dimension_types`
# (part 1's own table) is NO LONGER unchanged this part: F2 (below) column-limits its app-role
# UPDATE grant, an orphan-protection fix migration 0038 itself carries. Other findings this round:
# F1 (blocking, RLS) — the validating triggers must never interpolate the OTHER entity's real id
# into a raised message/detail/hint; F4 (blocking) — a `dimension_values` row may only reference a
# list-kind type; F5/F7 (nit, test-file only) — fixture-id tracking and an exact `proconfig` string,
# no schema change.
#
# Acceptance (doc 38 v4.6 row 4.1b, verbatim, second half this part): "...undefined value rejected."
# MASTER_BACKLOG row 4.1b part 2: "zero orphan line_dimensions.value_id rows" (G-01 style,
# report-only guard row — database/schema/guards.sql, a Master/schema-frozen file; not this slice's
# to add — flagged in the closing report, never invented here).
#
# ADR-0004 lines served: D1 6 / D2 (d) (dimension data, not schema columns — same as part 1).
# SCR-ACC-01 row 9 (part 2 half, D-190 hybrid design) AS AMENDED by the pre-build review round 1
# lane defaults (R1, R2 — the Master takes the row-9 wording update, D-190):
#   R1: there is NO declarative composite FK on `line_dimensions.value_id`. A SINGLE constraint
#   trigger, `billing.assert_dimension_value()`, validates BOTH kinds — list kind: a row exists in
#   `billing.dimension_values` with the SAME `dimension_type_id` AND `is_active = true` (an FK alone
#   cannot express "inactive value refused, existing tags stay"); reference kind: the row exists in
#   the type's own whitelisted `source_table` and, where that source has its own `entity_id` column,
#   belongs to the line's own entity (precedent style `billing.reject_holding_invoice`).
#   `value_ref text` is dropped, never built.
#   R2: TWO real, declarative composite FKs close the entity-crossing gap the trigger alone does not
#   cover — `dimension_values (entity_id, dimension_type_id) -> dimension_types (entity_id, id)` and
#   `line_dimensions (entity_id, dimension_type_id) -> dimension_types (entity_id, id)` (needs
#   `unique (entity_id, id)` on `dimension_types`, no new column): a value or a tag can never use a
#   dimension TYPE that belongs to a different entity.
#
# Carried from part 1's review (brief "Design", verbatim) + R3/R4 (pre-build review round 1): no
# `on delete cascade` on `journal_line_id` (C5 — a tagged journal_lines row cannot be deleted, new
# Scenario below); `select, insert`-only grant on `line_dimensions` (append-only, doc 40 P3, C4); an
# entity-deriving trigger validating `line_dimensions.entity_id` against
# `journal_lines -> journal_entries` (C3, SQLSTATE 23514); R3: no role gate on create/deactivate
# (entity_scope RLS only); R4: no uniqueness on (journal_line_id, dimension_type_id) — every
# scenario tags a fresh line each time.
#
# Defaults (brief, one CHANGELOG line each, recorded by the slice commit):
#   - `dimension_values.code` is unique per (entity_id, dimension_type_id); a deactivated value keeps
#     its code (never freed for reuse by a later active value of the same type).
#   - The G-01 orphan-value guard row is report-only (G18 style), never blocking.

Feature: Line dimensions and dimension values (WBS 4.1b part 2)
  As the CFO (owner, doc 38 v4.6 row 4.1b)
  I want a journal line's dimension tag to always resolve to a REAL value — a live
    billing.dimension_values row for a list-kind type, or a real row in the type's own whitelisted
    source table (belonging to the line's own entity when that source table has one) for a
    reference-kind type
  So that "undefined value rejected" holds at the database itself, no dimension value can ever be
    edited or removed once tagged (append-only ledger discipline), and a value's own lifecycle
    (create, deactivate) is fully audited — one outbox event and one audit row per write, replay-safe
    under the same idempotency key, and optimistic-locked against a stale version

  Background:
    Given a synthetic pilot entity (D-127) and a second, different entity used only to prove RLS
      isolation and the entity-deriving trigger — no real dimension value or journal entry is ever
      composed by this slice; every row used below is a test/synthetic fixture, never seeded by a
      migration (D3: nothing seeded)
    And a real billing.gl_accounts row, a real billing.journal_entries row and a real
      billing.journal_lines row exist for the pilot entity (and, separately, for the second entity),
      so every scenario below tags an ACTUAL journal line, never a fabricated id

  Scenario: A list-kind value is created per entity and tagged on a journal line
    Given a list-kind billing.dimension_types row exists for the pilot entity (e.g. "cost_center")
    When the CreateDimensionValue command is called with a fresh code and name for that type
    Then a new billing.dimension_values row is created, active, at version 1
    And when that value's id is used to insert a billing.line_dimensions row for a real journal
      line of the SAME entity
    Then the insert succeeds and the tag is visible against that journal line

  Scenario: A line tagged with a value that does not exist for its dimension type is rejected by the database
    Given a list-kind dimension type with exactly one real billing.dimension_values row
    When a billing.line_dimensions row is inserted naming that dimension type but a value id that is
      NOT that row's id (a value that does not exist for this type — including a real
      dimension_values row that belongs to a DIFFERENT dimension type)
    Then the insert is rejected by the database and no billing.line_dimensions row is written

  Scenario: A reference-kind value must exist in the type's source table and belong to the line's entity
    Given a reference-kind dimension type for EACH of the 8 whitelisted source tables (sales.accounts,
      partners.partners, hr.employees, tms.vehicles, wms.warehouses, platform.sites, imile.shipments,
      platform.entities)
    When a billing.line_dimensions row is inserted naming a random uuid (no real row) as the value,
      for EACH of the 8 types
    Then every one of the 8 inserts is rejected by the database
    And when a billing.line_dimensions row is instead inserted naming a REAL row of the type's own
      source table, for EACH of the 8 types
    Then every one of the 8 inserts succeeds
    Given, for the 4 source tables that carry their OWN entity_id column (hr.employees, tms.vehicles,
      wms.warehouses, platform.sites), a real row belonging to a DIFFERENT entity than the journal
      line
    When a billing.line_dimensions row is inserted naming that different-entity row as the value
    Then every one of those 4 inserts is rejected, even though the row genuinely exists
    And when the SAME different-entity-row experiment is repeated for the 4 source tables that carry
      NO entity_id column of their own (sales.accounts, partners.partners, imile.shipments,
      platform.entities)
    Then every one of those 4 inserts succeeds (there is no entity to scope against)
    And when a genuine pgeos_app session (not the admin pool) tags a real sales.accounts row and a
      real, same-entity wms.warehouses row
    Then both inserts succeed under RLS too

  Scenario: A deactivated value cannot be tagged on a new line; existing tags stay
    Given a list-kind value already tagged on one journal line (an existing tag)
    When the DeactivateDimensionValue command is called for that value with its current version
    Then the value's is_active becomes false and its version increments
    And when that SAME (now inactive) value id is used to insert a NEW billing.line_dimensions row
      for a different journal line
    Then the insert is rejected by the database
    And the existing tag from before the deactivation is completely unchanged (append-only — nothing
      is ever deleted or edited to "fix up" an old tag)

  Scenario: line_dimensions is append-only — UPDATE and DELETE are refused for the app role
    Given a real billing.line_dimensions row inserted by the pgeos_app role
    When the pgeos_app role attempts to UPDATE that row (any column)
    Then the attempt is refused by a permission error, not merely filtered by row-level security
    And when the pgeos_app role attempts to DELETE that row
    Then the attempt is likewise refused by a permission error
    And the row is confirmed completely unchanged afterwards

  Scenario: A dimension value cannot be deleted, and its code, type and entity cannot be changed, by the app role
    Given a real billing.dimension_values row of the pilot entity, tagged on a journal line
    When the pgeos_app role attempts to UPDATE its code, its dimension_type_id or its entity_id
    Then each attempt is refused by a permission error and the row is unchanged
    And when the pgeos_app role attempts to DELETE it
    Then the attempt is refused by a permission error, and the value and its tag both stay

  Scenario: line_dimensions.entity_id must equal the entity of its journal entry
    Given a real journal line belonging to the pilot entity
    And an active value of another entity's own dimension type
    When a billing.line_dimensions row is inserted for that journal line with entity_id, type and
      value all of that other entity (so only the journal entry's entity differs)
    Then the insert is rejected by the database and no billing.line_dimensions row is written
    And when the SAME row is instead inserted with entity_id correctly matching the journal line's
      own entity
    Then the insert succeeds

  Scenario: Stale version is rejected; idempotent replay returns the first result; one outbox + one audit row per write
    Given a list-kind dimension type for the pilot entity
    When CreateDimensionValue is called once with a fresh idempotency key
    Then exactly one billing.dimension_values row, one platform.outbox row and one
      platform.audit_log row exist for that call's correlation id
    And when the SAME idempotency key and the SAME request body are replayed
    Then the stored first result is returned, unchanged, and the outbox/audit row counts stay at
      exactly one each (the command body is never re-run)
    And when the SAME idempotency key is replayed with a DIFFERENT request body
    Then the call is rejected as an idempotency conflict
    Given that created value's real current version
    When DeactivateDimensionValue is called with an expectedVersion that no longer matches (stale)
    Then the call is rejected and the value is left completely unchanged
    And when DeactivateDimensionValue is instead called with the CORRECT current version, under a
      fresh idempotency key
    Then the value is deactivated exactly once, one more outbox row and one more audit row exist for
      that call's own correlation id, and replaying the SAME key/body afterwards returns the SAME
      result without deactivating (or auditing) a second time
    Given a value that belongs to the pilot entity
    When an OUTSIDER (scoped only to a different entity) calls DeactivateDimensionValue on it
    Then the call is rejected as not found (RLS hides the row from the outsider entirely), the value
      is left completely unchanged, and zero outbox/audit rows are written
    And when an OUTSIDER instead calls CreateDimensionValue for the PILOT entity
    Then the call is rejected by the row-level security policy, no row/outbox/audit is written

  Scenario: R2 — a value or a tag can never use a dimension type from a DIFFERENT entity (composite FK, 23503)
    Given a dimension type that belongs to a DIFFERENT entity than the pilot entity
    When a billing.dimension_values row is inserted for the pilot entity naming that other entity's
      dimension type
    Then the insert is rejected by the composite foreign key
    And when a billing.line_dimensions row tags the pilot entity's own journal line using that same
      other-entity dimension type and a real, active value of that type
    Then the insert is likewise rejected by the composite foreign key

  Scenario: deleting a tagged journal_lines row is refused (no cascade, C5)
    Given a journal line that carries a real billing.line_dimensions tag
    When the admin pool attempts to DELETE that journal_lines row
    Then the delete is rejected by the database and the tag is still present afterwards

  Scenario: dimension_values.code is unique per (entity_id, dimension_type_id) (C7); a deactivated value keeps its code
    Given a billing.dimension_values row already exists for a given (entity, type, code)
    When a SECOND row is inserted for the SAME entity and type with the SAME code
    Then the insert is rejected by the unique constraint
    And when the FIRST row is deactivated and the SAME code is inserted again for the SAME entity and
      type
    Then the insert is still rejected (a deactivated value keeps its code)
    And when the SAME code is instead inserted under a DIFFERENT dimension type
    Then the insert succeeds

  Scenario: The validating triggers are SECURITY DEFINER constraint triggers and no foreign key cascades (C1, C5)
    Given migration 0038 is applied
    Then every user trigger on billing.line_dimensions, including billing.assert_dimension_value(),
      is a non-deferrable AFTER INSERT OR UPDATE row constraint trigger whose function is SECURITY
      DEFINER with a pinned search_path
    And no foreign key on billing.line_dimensions or billing.dimension_values cascades on delete

  Scenario: billing.dimension_types is column-limited for the app role — kind/source_table/entity_id are immutable, name_ar stays writable
    Given a real billing.dimension_types row
    When the app role attempts to UPDATE its kind column
    Then the attempt is refused by a permission error and the row is unchanged
    And when the app role attempts to UPDATE its source_table column
    Then the attempt is likewise refused and the row is unchanged
    And when the app role instead updates its name_ar column
    Then the update succeeds

  Scenario: a dimension_values row can only reference a list-kind dimension type (F4)
    Given a reference-kind billing.dimension_types row
    When a billing.dimension_values row is inserted naming that reference-kind type as its own
      dimension_type_id
    Then the insert is rejected by the database and no row is written
    And when the CreateDimensionValue command is called with that same reference-kind
      dimensionTypeId
    Then the call is rejected for the same reason, and zero outbox/audit rows are written for its
      correlation id

  Scenario: F1 — cross-entity trigger error messages never name the other entity's id
    Given a caller scoped only to a second entity, tagging a journal line that belongs to the pilot
      entity, using the second entity's OWN dimension type and value (so every other check passes and
      only the entity-deriving trigger can refuse the row)
    Then the insert is rejected (23514) and the error message, detail and hint never contain the
      pilot entity's real id
    Given a reference-kind tag naming a real row that belongs to a DIFFERENT entity
    Then the insert is rejected (23514) and the error message, detail and hint never contain that
      row's own entity id

  Scenario: RLS — a caller scoped to another entity cannot see or tag this entity's values
    Given a caller with no identity.user_entities row for the pilot entity (only for a different
      entity)
    When that caller queries billing.dimension_values rows belonging to the pilot entity
    Then zero rows are returned
    And when that caller queries billing.line_dimensions rows belonging to the pilot entity
    Then zero rows are returned
    And when that caller attempts to INSERT a billing.dimension_values row for the pilot entity
    Then the insert is rejected by the row-level security policy
    And when that caller attempts to INSERT a billing.line_dimensions row tagging the pilot entity's
      own journal line
    Then the insert is rejected by the row-level security policy
