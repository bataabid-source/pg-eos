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
    user who also happens to hold entity access. It is PREVENTED by SCR-RLS-01 Options B + C — see
    the scenarios below and docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md: Option B
    gates entity_scope on platform.is_internal(), and Option C forbids a `user_type = 'client'` user
    from holding an identity.user_entities row at all. It does not happen *for the contexts asserted
    above* even before the migration lands, because their ctxA.userId is null, so they hold no row
    in identity.user_entities.
    Given client A's portal context, where client A's user has no identity.user_entities row
    When platform.allowed_entities() is evaluated inside that context
    Then it returns an empty array — so the entity_scope OR-leg is always false for this user, and
      the tampering result above is not a false negative. Since migration 0003 (D-002, applied
      2026-09-23), Option B also gates entity_scope on platform.is_internal(), so the OR-leg is now
      structurally inert for every portal user regardless of identity.user_entities membership — the
      empty array proved here is a narrower, additional fact about this specific context, not the
      only thing preventing the leak any more

  Scenario: An internal (back-office) context is not "deny all" — it sees both clients
    Given an internal context (isInternal = true, no clientId)
    When it selects all billing.invoices rows belonging to client A and client B
    Then both rows are returned
    This proves the policy discriminates on client identity rather than denying everything
    unconditionally, which would make the "zero rows" results above vacuous in the other direction.

  Scenario Outline: SCR-RLS-01 — entity_scope must not OR-defeat client_portal_scope for a dual-role user
    Full write-up, options, live reproduction SQL and GM/system-owner APPROVAL:
    docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md (Options B + C approved, recorded
    as D-002 in docs/DECISION_LOG.md and applied by database/migrations/0003_M_rls-scr-01-02.sql on
    2026-09-23). Every scenario above this one used a portal user with NO identity.user_entities row,
    so entity_scope's permissive OR-leg was always false and never exercised. This scenario removes
    that precondition on purpose, to prove Option B holds even for a user who holds entity access
    directly — not only because Option C now makes that combination unconstructable through ordinary
    inserts. The test fixture constructs the dual-role user by bypassing origin-mode triggers for one
    insert (`session_replication_role = replica`) specifically so this proof does not depend on
    Option C being in place.

    Review round 3 (Master-verified against live pg_policy): the SAME permissive
    `allowed_entities()` OR permissive `current_client_id()` composition affected SEVEN tables before
    migration 0003 — billing.invoices, tms.delivery_tasks, wms.outbound_orders,
    wms.occupancy_snapshots, wms.space_allocations, wms.space_reservations, wms.work_orders. This
    outline runs BEHAVIORALLY against the three of the seven that already have seeded fixture rows in
    this suite (<table> below); the remaining four (wms.occupancy_snapshots, wms.space_allocations,
    wms.space_reservations, wms.work_orders) are outside this slice's fixture surface and are not
    seeded here, but get SHAPE coverage instead — see the "SCR-RLS-01 Option B — policy shape proof"
    outline below, which covers all seven via pg_policy with no fixture rows.

    Given client A's portal user (identity.users, user_type = 'client', client_id = client A)
    And that SAME user ALSO holds an identity.user_entities row for the entity the seeded row in
      <table> belongs to — constructed via the trigger-bypass fixture above
    When that user's context selects, by id, the row that belongs to client B in <table>
    Then zero rows are returned, with no error — migration 0003 (D-002) applied Option B on
      2026-09-23: entity_scope is now `platform.is_internal() and entity_id = any(allowed_entities())`,
      which is false for every portal user regardless of identity.user_entities membership

    Examples:
      | table                |
      | billing.invoices     |
      | tms.delivery_tasks   |
      | wms.outbound_orders  |

  Scenario Outline: SCR-RLS-01 Option B — policy shape proof (no fixture rows) across all seven tables
    Proves migration 0003 (D-002) landed Option B's exact predicate on every one of the seven
    affected tables, including the four that have no fixture rows in this suite (see the SCOPE note
    on the outline above for why those four are not seeded). Read directly from pg_policy via the
    superuser client — no client context, no fixture rows, no positive/negative selection — the same
    technique this suite already uses for platform.audit_log's own RLS shape (see the SCR-RLS-02 (c)
    scenario below).
    Given the pg_policy row for <table>'s entity_scope policy
    Then it is permissive, applies to all commands ('*'), and its qual is exactly
      `(platform.is_internal() AND (entity_id = ANY (platform.allowed_entities())))`
    And the pg_policy row for <table>'s client_portal_scope policy is unchanged by Option B: permissive,
      applies to SELECT only ('r'), qual exactly
      `(platform.is_internal() OR (client_id = platform.current_client_id()))`

    Examples:
      | table                     |
      | billing.invoices          |
      | tms.delivery_tasks        |
      | wms.outbound_orders       |
      | wms.occupancy_snapshots   |
      | wms.space_allocations     |
      | wms.space_reservations    |
      | wms.work_orders           |

  Scenario Outline: SCR-RLS-01 positive control — the dual-role user's own client-A row is unaffected
    Proves Option B only narrows entity_scope's OR-leg; it does not touch client_portal_scope, so the
    dual-role user's own client keeps working — true both before and after migration 0003, since
    Option B never touched client_portal_scope's predicate.
    Given the same dual-role user as the outline above
    When that user's context selects, by id, client A's OWN row in <table>
    Then exactly 1 row is returned

    Examples:
      | table                |
      | billing.invoices     |
      | tms.delivery_tasks   |
      | wms.outbound_orders  |

  Scenario: SCR-RLS-01 positive control — an internal user with real entity access still sees across clients
    Proves Option B only ADDS platform.is_internal() to entity_scope's predicate; it does not remove
    `entity_id = any(allowed_entities())`, so a genuinely internal user with entity access is
    unaffected — true both before and after migration 0003.
    Given an internal user (user_type = 'internal') holding a real identity.user_entities row for
      the PCC entity, in context { isInternal: true, clientId: null }
    When that user selects client B's billing.invoices row by id
    Then exactly 1 row is returned

  Scenario Outline: SCR-RLS-01 Option C — client users cannot hold entity access
    docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md §4, Option C — a trigger
    (identity.enforce_client_users_hold_no_entities(), triggers user_entities_reject_client_user and
    users_reject_client_with_entities) makes user_type = 'client' and an identity.user_entities row
    for that user mutually exclusive. Migration 0003 (D-002) created this trigger on 2026-09-23, so
    both operations below are now rejected, as asserted.

    Given <setup>
    When <action> is attempted via a superuser (bypasses RLS, not triggers) connection
    Then it is rejected with SQLSTATE 23514 (check_violation)

    Examples:
      | setup                                                    | action                                                       |
      | a fresh user with user_type = 'client'                   | inserting an identity.user_entities row for that user        |
      | a fresh user with user_type = 'internal' holding a real identity.user_entities row | updating that user's user_type to 'client' |

  Scenario: SCR-RLS-02 (a) — the widened G7 guard covers the partitioned parent and returns zero rows
    docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md §5, Option B: G7's query widens
    from `t.relkind = 'r'` to `t.relkind in ('r','p')`. Before migration 0003 (D-002), this widened
    query surfaced platform.audit_log (relkind 'p', relrowsecurity = false); since 0003 applied
    Option A on 2026-09-23, the parent carries RLS and this query returns zero rows — see the "G7"
    scenario above, whose executable test this rewrites in place.
    Given the widened G7 query, run verbatim as the Master has put it in database/schema/guards.sql
    When it is executed
    Then it returns zero rows

  Scenario: SCR-RLS-02 (b) — reads through the parent are scoped — the former bypass is closed
    docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md §1, §3. Before migration 0003
    (D-002), the parent had RLS disabled, so a role granted SELECT on the parent (but never any leaf
    partition) saw every row, ignoring the partitions' own entity_scope policy entirely. Since 0003
    applied Option A on 2026-09-23, the parent carries its own entity_scope policy and this scenario
    proves the bypass is closed.
    Given this scenario's own block seeded ONE platform.audit_log row via the superuser client (the
      PARENT via a plain insert — table_name '_rls_isolation_fixture', entity_id = the PCC entity —
      same column shape as modules/platform/tests/integration/schema-invariants.test.ts:97-102), so
      the scenario no longer depends on a PREVIOUS suite (WBS 0.9) having left rows behind: nothing
      in the schema writes platform.audit_log rows on its own, only `trg_audit_hash_chain` (BEFORE
      INSERT) stamps prev_hash/row_hash on a row already being inserted — confirmed to fail
      deterministically on a fresh database (`apply.sh --recreate`, single run) before this fixture
      was added
    And a portal context with no identity.user_entities row (platform.allowed_entities() = {})
    And platform.audit_log has at least one row with entity_id is not null (vacuity guard — now
      always satisfied by this block's own seeded row, kept in place as a regression guard)
    When that context selects count(*) from platform.audit_log where entity_id is not null
    Then the count is zero, and the query does not throw
    And platform.verify_audit_chain() (G8) still returns zero rows after the seeded fixture row,
      proving the fixture chained correctly and did not corrupt the hash chain
    And teardown deletes the fixture row only if it is still the TAIL of the chain (ordered by
      occurred_at, id) — a middle-row delete would break every later row's prev_hash link — leaving
      it in place, clearly marked, otherwise

  Scenario: SCR-RLS-02 (c) — the parent itself carries row security and an entity_scope policy
    docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md §5, Option A. Before migration
    0003 (D-002), the parent's pg_class.relrowsecurity was false and it carried zero policies of its
    own; migration 0003 applied Option A on 2026-09-23, which this scenario now proves.
    Given the pg_class / pg_policy rows for platform.audit_log
    Then relrowsecurity is true
    And a policy named entity_scope exists on it
