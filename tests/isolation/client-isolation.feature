# tests/isolation/client-isolation.feature — WBS 0.18 (pg-tester).
#
# Source: .claude/briefs/0.18-isolation.brief.md — "Acceptance criterion (doc 38 row 0.18 / doc 40
# Part F G14)": G7 returns 0 (RLS enabled on every operational table — already true on the applied
# schema, this proves it) AND "User A returns zero rows from B's data on direct ID substitution,
# with no error." doc 40 Part F, row G14 (docs/package/40-Build-Specification-EN.md:627-652):
# `pnpm test:isolation` — client A requests client B's ids directly — pass condition `0 rows`,
# **no error**.
#
# This file is written BEFORE tests/client-isolation.test.ts (CLAUDE.md · BUILD METHOD: "scenario
# (Gherkin) → ... → tests first (RED)"). It is documentation of intent, not executed by Playwright —
# WBS 0.18 is a database-integration proof (doc 40 Part F is SQL/runner rows, not a Part E UI
# scenario), so the corresponding executable spec is the vitest file next to it, not
# tests/scenarios/**. The Given/When/Then below map 1:1 onto the `it(...)` blocks in that file; each
# step below names the exact assertion it corresponds to.

Feature: Client data isolation via row-level security (WBS 0.18, doc 40 Part F G7 + G14)
  As the platform operator
  I want every client-scoped table to enforce isolation in the database itself, not the application
  So that a portal user for client A can never read client B's rows, even by guessing or
  substituting client B's row ids directly into a query — and the denial never surfaces as an
  application error, only as the natural absence of rows.

  Background:
    Given an ephemeral, non-superuser, NOBYPASSRLS role "pgeos_rls_isolation_test" provisioned for
      this test run only (RLS has no teeth against the superuser role Postgres defaults to locally —
      packages/db/src/client.ts documents this as a KNOWN GAP)
    And two clients, A and B, each with exactly one row seeded in sales.accounts,
      wms.outbound_orders, tms.delivery_tasks, billing.invoices and wms.skus
    And every scoped query in this feature runs through withContext(ctx, fn) — never a raw query —
      matching CLAUDE.md · ARCHITECTURE

  Scenario: Guard-of-the-guard — the session really cannot bypass RLS
    This MUST be the first scenario proven. If the connection is a superuser or has BYPASSRLS, every
    later "zero rows" result would be meaningless — RLS would not have been evaluated at all.
    Given a withContext session opened as "pgeos_rls_isolation_test"
    When the session's own identity is queried (current_user, pg_user.usesuper, pg_roles.rolbypassrls)
    Then current_user is "pgeos_rls_isolation_test"
    And usesuper is false
    And rolbypassrls is false

  Scenario: G7 — every operational table in the fourteen business schemas has RLS enabled
    Given the G7 query from database/schema/guards.sql:80-88 (doc 40 Part F row G7), run verbatim
    When it is executed
    Then it returns zero rows

  Scenario Outline: Positive control — a client sees exactly its own row
    Without this, a later "zero rows" result on tampering would prove nothing: it could just mean
    the whole query is broken, not that isolation works.
    Given client A's portal context (its own clientId, isInternal = false)
    When client A selects its own row by id from <table>
    Then exactly 1 row is returned

    Examples:
      | table                |
      | sales.accounts       |
      | wms.outbound_orders  |
      | tms.delivery_tasks   |
      | billing.invoices     |
      | wms.skus             |

  Scenario Outline: ID tampering — substituting client B's id returns nothing, and nothing throws
    Given client A's portal context (its own clientId, isInternal = false)
    When client A selects, by id, the row that belongs to client B in <table>
    Then zero rows are returned
    And no error is thrown — no permission-denied, no policy exception

    Examples:
      | table                |
      | sales.accounts       |
      | wms.outbound_orders  |
      | tms.delivery_tasks   |
      | billing.invoices     |
      | wms.skus             |

  Scenario: Symmetry — the same holds with the roles reversed
    Proves the previous result is not an artifact of which client was inserted first.
    Given client B's portal context
    When client B selects, by id, client A's row in billing.invoices and in wms.skus
    Then zero rows are returned from each, with no error
    And client B's positive control (its own row in the same two tables) still returns exactly 1 row

  Scenario: entity_scope does not leak the client boundary
    wms.outbound_orders, tms.delivery_tasks and billing.invoices carry BOTH an entity_scope policy
    (FOR ALL, permissive) and a client_portal_scope policy (FOR SELECT, permissive). Permissive
    policies are OR-ed, so entity_scope could in principle defeat client_portal_scope for a portal
    user who also happens to hold entity access. **It DOES happen** — see the SCR-RLS-01 scenario below and
    docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md; nothing in the schema forbids
    that combination. It does not happen *for the contexts asserted above*, because their
    ctxA.userId is null, so they hold no row in identity.user_entities.
    Given client A's portal context, where client A's user has no identity.user_entities row
    When platform.allowed_entities() is evaluated inside that context
    Then it returns an empty array — so the entity_scope OR-leg is always false for this user, and
      the tampering result above is not a false negative

  Scenario: An internal (back-office) context is not "deny all" — it sees both clients
    Given an internal context (isInternal = true, no clientId)
    When it selects all billing.invoices rows belonging to client A and client B
    Then both rows are returned
    This proves the policy discriminates on client identity rather than denying everything
    unconditionally, which would make the "zero rows" results above vacuous in the other direction.

  Scenario Outline: SCR-RLS-01 — KNOWN DEFECT: entity_scope OR-defeats client_portal_scope for a dual-role user
    Full write-up, options and live reproduction SQL:
    docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md. Every scenario above this one
    used a portal user with NO identity.user_entities row, so entity_scope's permissive OR-leg was
    always false and never exercised. This scenario removes that precondition on purpose, because
    nothing in the schema forbids a real client-portal user from also holding entity access.

    Review round 3 (Master-verified against live pg_policy): the SAME permissive
    `allowed_entities()` OR permissive `current_client_id()` composition affects SEVEN tables —
    billing.invoices, tms.delivery_tasks, wms.outbound_orders, wms.occupancy_snapshots,
    wms.space_allocations, wms.space_reservations, wms.work_orders. This outline runs against the
    three of the seven that already have seeded fixture rows in this suite (<table> below); the
    remaining four (wms.occupancy_snapshots, wms.space_allocations, wms.space_reservations,
    wms.work_orders) are recorded as affected in the SCR-RLS-01 note but are outside this slice's
    fixture surface and are not seeded here.

    Given client A's portal user (identity.users, user_type = 'client', client_id = client A)
    And that SAME user ALSO holds an identity.user_entities row for the entity the seeded row in
      <table> belongs to — a combination the schema does not forbid
    When that user's context selects, by id, the row that belongs to client B in <table>
    Then the acceptance criterion still demands zero rows, with no error
    But the query currently returns exactly 1 row (client B's) with no error — reproduced live
      against the applied schema, because <table> carries entity_scope (FOR ALL, permissive) OR-ed
      with client_portal_scope (FOR SELECT, permissive), and permissive policies compose with OR,
      not AND
    This is pinned as a KNOWN, OPEN defect (status: OPEN, awaiting GM/system-owner decision under
      EXECUTION-MASTER-v4 §1.11 (G-01) — the SCR note above) via a PAIRED `it.fails(...)` (the
      requirement) and a companion `it(...)` (today's reality — no throw, exactly client B's one
      row) in tests/client-isolation.test.ts, not silently accepted: the `it.fails` executable test
      will itself turn red the day the schema is fixed, and the companion turns red the moment
      either the leak or the no-throw guarantee changes, forcing this scenario and the SCR note to
      be revisited.

    Examples:
      | table                |
      | billing.invoices     |
      | tms.delivery_tasks   |
      | wms.outbound_orders  |
