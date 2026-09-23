Task: 0.17 — Identity mechanism: OTP · sessions · RBAC/SoD evaluation      Lane: M      Lock: identity

Read ONLY: CLAUDE.md · .claude/briefs/identity.brief.md · database/schema/01-Data-Model.sql:32-45,212-296
  · database/schema/13B-Schema-Reference-Consolidation.sql:440-556 · packages/db/src/with-context.ts
  · packages/db/src/client.ts · packages/events/src/outbox.ts (structural precedent only, not a dependency)
  · docs/notes/0.17-sequencing-decision-request.md (governing decision — mechanism-only scope)

Write ONLY: packages/identity/** · tests/… (none outside packages/identity/tests)

Scope (GM decision 2026-09-22, docs/notes/0.17-sequencing-decision-request.md — narrow, mechanism only):
  OTP generation/verification, session issuance/verification/revocation, RBAC permission check and
  role assignment with SoD evaluation. NO login API endpoint, NO admin UI, NO module tree
  (domain/application/infrastructure/api) — golden slice 2.9 not yet accepted. Deferred parts
  (login endpoints, structure-editor UI) are recorded in MASTER_BACKLOG.md / PROJECT_STATE.md at
  close-out, not built here.

Scenario (Gherkin — write these as the RED tests, plus property tests for the invariants noted):

  Feature: OTP login mechanism
    Scenario: a correct, unexpired, unconsumed code verifies successfully
      Given an OTP was generated for an existing active user's email
      When verifyOtp is called with that email and the correct code
      Then it reports valid and returns that user's id
      And the otp_codes row is marked consumed

    Scenario: a wrong code is rejected and increments attempts
      Given an OTP was generated for an existing active user's email
      When verifyOtp is called with the wrong code
      Then it reports invalid
      And the otp_codes row's attempts increments by 1
      And the row is NOT marked consumed

    Scenario: an expired code is rejected even if correct
      Given an OTP whose expires_at is in the past
      When verifyOtp is called with the correct code
      Then it reports invalid

    Scenario: a consumed code cannot be reused
      Given an OTP already marked consumed
      When verifyOtp is called again with the correct code
      Then it reports invalid

    Scenario: no active user for the email
      Given no identity.users row exists for an email (or the row has is_active = false)
      When generateOtp is called for that email
      Then it throws a clear, typed error — never silently creates a user (no self-registration
      rule exists in 01/13/13B/019; do not invent one)

  Feature: Session mechanism
    Scenario: a freshly issued session verifies
      Given issueSession was called for an active user
      When verifySession is called with the returned raw token
      Then it reports valid and returns that user's id and session id

    Scenario: a revoked session no longer verifies
      Given an issued session that was then revoked via revokeSession
      When verifySession is called with its raw token
      Then it reports invalid

    Scenario: an expired session no longer verifies
      Given a session row with expires_at in the past
      When verifySession is called with its raw token
      Then it reports invalid

    Scenario: the raw token is never recoverable from storage
      Given an issued session
      Then identity.sessions.token_hash does not equal the raw token, and the raw token is not
      derivable from the stored hash alone (property test: hash function is one-way / the stored
      value never equals any plaintext-token fixture used in the suite)

  Feature: RBAC / SoD evaluation
    Scenario: a user with a granted permission passes the check
      Given a user holds a role that is granted permission code X (via identity.role_permissions)
      When hasPermission is evaluated for that user and code X
      Then it returns true

    Scenario: a user without the permission fails the check
      When hasPermission is evaluated for a user/code with no granting role
      Then it returns false

    Scenario: SoD-conflicting role assignment is rejected (identity.check_sod trigger, 13B:539-555)
      Given a user already holds CFO (active, not revoked)
      When assignRole attempts to grant ACCOUNTANT to the same user
      Then the assignment is rejected (the DB trigger raises; assignRole surfaces a clear typed
      error, it does not swallow or retry around it)
      And no new identity.user_roles row exists for that pairing afterward

    Scenario: SoD check is symmetric
      Given a user already holds ACCOUNTANT
      When assignRole attempts to grant CFO to the same user
      Then it is rejected too (role_a/role_b order must not matter — trigger already checks both
      directions; the test proves it, does not re-implement it)

    Scenario: a non-conflicting role assignment succeeds
      Given a user holds no role that conflicts with WH_MGR
      When assignRole grants WH_MGR
      Then a new active identity.user_roles row exists

    Property test: for every active (role_a, role_b) pair in identity.sod_rules (currently 4 seed
    rows, EXEC-v4 §1.6 — do not hardcode the count from this brief, read it from the table),
    holding role_a then assigning role_b (and the reverse order) is always rejected. This proves
    the mechanism against the table's actual content, not a hand-picked subset.

Contract: no packages/contracts/identity/ entry exists yet and none is created — this is a
  mechanism package, not an API; its TS types ARE its contract for this task. If a later task
  wires a login endpoint, that task adds the Zod contract then.

Screen/Board spec: none (deferred to 2.9 / first slice after 2.9 per the GM decision).

Known schema gap — read before writing tests (do not treat as a blocker, design around it):
  `platform.thresholds` (13B) has NO seed rows for OTP expiry minutes, OTP max attempts, or
  session lifetime — grepped across every `insert into platform.thresholds` block in
  13B-Schema-Reference-Consolidation.sql, confirmed absent. CLAUDE.md forbids inventing a number
  ("No magic numbers — constants or platform.thresholds"; "Never fabricate a number... Numbers
  come from the system"). Design: generateOtp/issueSession read their limits via a small
  `getThreshold(pool, key): Promise<number>` helper (packages/identity/src/thresholds.ts) that
  queries `platform.thresholds` by key and throws a clear "threshold not configured: <key>" error
  if the row is absent — no embedded default. Tests seed their OWN `platform.thresholds` fixture
  rows (matching the WBS 0.12 precedent of tests seeding their own fixture data, not production
  seed data) using keys namespaced under `identity.otp.*` / `identity.session.*` (pick exact key
  names, record them in the REPORT). This IS the stop-and-report gap for this task: the Master
  will file a follow-up note that production seed rows for these keys are still needed before any
  real login flow ships (out of THIS task's write scope — 13B is frozen, database/schema/* changes
  are Master-only).

Deliver (packages/identity/, matching packages/db and packages/events structure exactly):
  package.json · tsconfig.json · tsconfig.test.json · vitest.config.ts · index.ts (barrel export)
  · src/otp.ts (generateOtp, verifyOtp) · src/session.ts (issueSession, verifySession,
  revokeSession) · src/rbac.ts (hasPermission wrapping platform.has_perm() via withContext,
  assignRole inserting into identity.user_roles and surfacing the trg_sod rejection, listRoles/
  allowedEntities wrapping platform.allowed_entities()) · src/thresholds.ts (getThreshold)
  · tests/otp.test.ts · tests/session.test.ts · tests/rbac-sod.test.ts

  All DB access goes through `withContext(ctx, fn)` from @pg-eos/db — including the pre-auth OTP
  lookup and session-token lookup, using `{ userId: null, clientId: null, isInternal: true }`
  (identity.otp_codes and identity.sessions both carry the `internal_only` RLS policy —
  `using (platform.is_internal())` — 13B:3036; no userId is known yet at that point, which the
  WithContextCtx type already allows since userId is `string | null`). No new withContext variant,
  no bypass — this is an existing, legitimate parameter combination, not an invented mechanism.

  Hash OTP codes and session tokens with a keyed HMAC (node:crypto `createHmac('sha256', secret)`),
  never a plain unsalted hash — a 6-digit OTP is a 1e6-space, brute-forceable under a bare SHA-256
  lookup if the table ever leaked; a session token is high-entropy so this is defense in depth
  there. The secret is read from an env var (e.g. `OTP_HMAC_SECRET`) — tests supply their own fixed
  test value, never a hardcoded production-shaped secret. No Math.random() — use
  `node:crypto.randomInt` / `randomBytes` for both the OTP digits and the session token. No
  `new Date()` buried in the hashing/comparison path — inject a clock function
  (`() => Date` default `() => new Date()`, overridable per call) so expiry tests are deterministic,
  matching the spirit of CLAUDE.md's domain/ clock-injection rule even though this package sits
  outside domain/.

Migration number: none — no schema change, every table already exists in 01 / 13B.

Stop-and-ask if: any table/column/rule needed beyond identity.users/roles/permissions/
  role_permissions/user_roles/sessions/otp_codes/sod_rules and platform.thresholds/has_perm/
  allowed_entities/is_internal — all already enumerated above. Do not touch identity.delegations,
  identity.check_sod_delegation(), platform.domain_owners, or platform.approval_chains — out of
  this narrow scope per the GM decision.

pg-tester: write the RED tests first (all scenarios above + the property test), confirm they fail
for the RIGHT reason (no implementation yet / missing export), then report the failing test names
back before any implementation starts.
