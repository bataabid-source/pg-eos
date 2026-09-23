# tests/isolation/app-role-rls.feature — WBS 0.6a-1 (pg-tester).
#
# Source: the WBS 0.6a-1 slice brief (pg-reviewer pre-migration review, APPROVED WITH CHANGES,
# D-133) — the `pgeos_app` role and the entity_scope USING / WITH CHECK split, delivered by
# database/migrations/0007_M_pgeos-app-role-entity-scope.sql (does not exist yet — this file, and
# tests/app-role-rls.test.ts next to it, are written BEFORE that migration, per CLAUDE.md · BUILD
# METHOD: "scenario (Gherkin) → ... → tests first (RED) → domain ...").
#
# LEAN DESIGN (GM directive, this session): views are NOT altered (no security_invoker rewrite).
# Instead pgeos_app is granted NO privilege at all on any view in the fourteen schemas that lacks
# security_invoker=true — the grant loop in migration 0007 skips views (or revokes on them). G7 is
# extended to also flag any such owner-rights view on which pgeos_app still holds a privilege.
#
# This is a database-integration proof, the same shape as WBS 0.18's own
# tests/isolation/client-isolation.feature. The numbers 69 (entity_scope policies today), 14
# (business schemas, doc 40 Part F row G7) and 7 (entity_scope policies gated on
# platform.is_internal() since migration 0003 / SCR-RLS-01 Option B) are the brief's own — never
# invented here. Trimmed, per the GM's lean-design directive this session, to 10 scenarios (Master list); fix round 2 added 2 — 12 in all.

Feature: The pgeos_app runtime role and the entity_scope WITH CHECK split (WBS 0.6a-1, D-133)
  As the platform operator
  I want a single, correctly scoped, non-superuser runtime role that the application connects as,
  with every entity_scope policy carrying an explicit WITH CHECK equal to its USING clause
  So that RLS actually has teeth once the runtime stops connecting as the Postgres superuser
  (packages/db/src/client.ts's own documented KNOWN GAP), and an entity-scoped INSERT is
  rejected exactly as reliably as a SELECT is filtered.

  Background:
    Given migration 0007 has created role "pgeos_app": LOGIN, NOSUPERUSER, NOBYPASSRLS,
      NOCREATEROLE, NOCREATEDB, no password
    And every scoped query in this feature runs through a transaction that sets exactly the three
      GUCs packages/db/src/with-context.ts sets (app.user_id, app.client_id, app.is_internal) —
      never a raw, unscoped query

  Scenario: pgeos_app is a correctly de-privileged login role
    Given pg_authid for "pgeos_app"
    Then rolsuper is false, rolbypassrls is false, rolcreaterole is false (and rolcreatedb is
      false, rolcanlogin is true, and no password is set)

  Scenario: every entity_scope policy carries an explicit WITH CHECK equal to its USING
    Given every pg_policy row named "entity_scope" across the fourteen business schemas (doc 40
      Part F row G7's schema list)
    Then there are exactly 69 such rows, including exactly 7 whose USING expression is gated on
      platform.is_internal() (migration 0003, SCR-RLS-01 Option B)
    And every one of the 69 has a non-null WITH CHECK expression textually equal to its own USING
      expression

  Scenario: as pgeos_app in entity A — INSERT of an entity-B row is rejected
    Given an app-role session whose platform.allowed_entities() is exactly {entity A} (PST)
    When it inserts a wms.occupancy_snapshots row with entity_id = entity B (PDL)
    Then the insert is rejected with SQLSTATE 42501

  Scenario: as pgeos_app in entity A — SELECT returns no entity-B row
    Given one wms.occupancy_snapshots row seeded for entity A and one for entity B
    And an app-role session whose platform.allowed_entities() is exactly {entity A}
    When it selects the entity-B row by id
    Then zero rows are returned, and no error is thrown

  Scenario: as pgeos_app in a portal context — an own audit_log INSERT succeeds
    Given a new permissive policy "audit_append" on platform.audit_log FOR INSERT WITH CHECK
      (user_id is not null and user_id = platform.current_user_id())
    And an app-role PORTAL session context — the GUCs packages/db/src/with-context.ts writes for a
      client session (app.user_id, app.client_id, app.is_internal=false); no identity.users /
      sales.accounts rows are created (audit_append reads only current_user_id(), audit_log.user_id
      has no FK, pgeos_app cannot insert those rows under RLS, and the seed holds no client users —
      Master default, D-117), all inside ONE pgeos_app transaction that is ALWAYS rolled back, so
      nothing is committed and no audit hash-chain gap is possible
    When, inside that one transaction, it inserts a platform.audit_log row with a non-null
      entity_id and user_id = its own app.user_id
    Then no error is thrown — audit_append's WITH CHECK is satisfied even though entity_scope's
      own WITH CHECK (allowed_entities() is empty for this session) is not, because permissive
      policies are OR-ed (audit_append grants INSERT only, so there is no read-back to prove
      success with beyond "no error was thrown" inside the same, never-committed transaction)
    And the transaction is rolled back regardless

  Scenario: as pgeos_app — an audit_log INSERT for another user is rejected
    Given the same rolled-back portal session context as above (GUCs only, its own
      never-committed transaction)
    When it inserts a platform.audit_log row whose user_id is NOT the session's own app.user_id,
      and whose entity_id is not in the session's platform.allowed_entities()
    Then the insert is rejected with SQLSTATE 42501 — neither entity_scope nor audit_append is
      satisfied

  Scenario: audit_append is parent-only (fix round 2, Finding 3 proof)
    Given pg-backend makes audit_append a parent-only policy (the earlier per-partition
      duplication is removed)
    Then exactly one audit_append policy exists, on platform.audit_log itself
    And zero audit_append policies exist on any of its partitions
    (the portal-context INSERT scenario above, which inserts through the PARENT, passing is the
      behavioral half of this proof)

  Scenario: as pgeos_app — UPDATE/DELETE on the three append-only tables is denied
    Given the design revokes UPDATE and DELETE on platform.audit_log, wms.stock_movements and
      wms.work_order_events from pgeos_app (INSERT/SELECT remain granted)
    When pgeos_app attempts UPDATE and DELETE on each of the three tables
    Then every attempt is rejected with SQLSTATE 42501

  Scenario: as pgeos_app — direct writes to an audit_log partition are denied (fix round 2,
    Finding 4)
    Given every partition of platform.audit_log, read at run time from pg_inherits
    And audit_append is parent-only (previous scenario)
    When pgeos_app (a session with no identity.user_entities membership) attempts UPDATE, DELETE
      and INSERT directly on each partition
    Then every attempt on every partition is rejected with SQLSTATE 42501 — denied because
      pgeos_app holds no privilege on any partition (0007 §2b, checked by G7)

  Scenario: as pgeos_app — EXECUTE on the audit hash-chain functions is denied
    Given there is no blanket EXECUTE grant to pgeos_app on any schema, and 0004 defines
      platform.audit_hash_chain() (trigger function, no arguments) and
      platform.verify_audit_chain(bigint, text) (exact signature, not guessed)
    Then has_function_privilege('pgeos_app', 'platform.audit_hash_chain()', 'EXECUTE') is false
    And has_function_privilege('pgeos_app', 'platform.verify_audit_chain(bigint,text)', 'EXECUTE')
      is false

  Scenario: as pgeos_app — no privilege on any owner-rights view
    Given every pg_class row of relkind 'v' in the fourteen business schemas whose reloptions do
      NOT carry security_invoker=true (an "owner-rights" view)
    Then pgeos_app holds no SELECT, INSERT, UPDATE or DELETE privilege on any one of them

  Scenario: migration 0007 applied twice converges, and the extended G7 guard returns zero rows
    Given database/migrations/0007_M_pgeos-app-role-entity-scope.sql, applied via psql stdin (the
      WBS 0.15 rule: stdin redirection, not -f) exactly as database/schema/apply.sh applies every
      other file in this repo
    When it is applied a second time, back to back, against the same database
    Then the pg_roles / pg_policy (entity_scope WITH CHECK) / role-grant catalog snapshot taken
      after the first application is identical to the snapshot taken after the second
    And G7 extended — flagging (a) any entity_scope policy in the fourteen schemas with a null
      WITH CHECK, and (b) any view in the fourteen schemas without security_invoker=true on which
      pgeos_app holds any privilege (the "missing entity_scope policy" clause of the earlier draft
      is REMOVED, fix round 1: it flagged 9 reference/bespoke tables by 13B's own design) — returns
      zero rows
