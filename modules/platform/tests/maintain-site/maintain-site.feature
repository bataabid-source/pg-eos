Feature: Maintain platform.sites — the single sites table (WBS 5.5a part 1, SCR-HR-SHIFT-01 §2.4)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId

  Scenario: Create a warehouse site
    Given the caller holds role "OPS_DIR"
    When CreateSite is called with kind "warehouse", name_ar, and no radiusM
    Then one platform.sites row exists with version 1, entity_id = ctx.entityId, radius_m = 500 (the threshold default)
    And exactly one "platform.site.created" row is in platform.outbox and one platform.audit_log row shares its correlation_id

  Scenario: Create a client_pickup site without an account is rejected
    Given the caller holds role "HR_MGR"
    When CreateSite is called with kind "client_pickup" and no accountId
    Then SiteAccountRequiredError (422) and no row is written

  Scenario: Create a client_pickup site with an account succeeds
    Given the caller holds role "HR_MGR" and an existing sales.accounts row
    When CreateSite is called with kind "client_pickup" and that accountId
    Then one platform.sites row exists with account_id set

  Scenario: An invalid kind is rejected at the contract
    When CreateSite is called with kind "depot"
    Then the handler returns a 400 Problem and nothing is written

  Scenario: A caller-supplied radius must be positive
    Given the caller holds role "OPS_DIR"
    When CreateSite is called with radiusM -5
    Then SiteRadiusInvalidError (422) and no row is written

  Scenario: An invalid kind is rejected by the application layer
    Given the caller holds role "OPS_DIR"
    When CreateSite is called directly (not via the HTTP contract) with an invalid kind
    Then SiteKindInvalidError (422) and no row is written

  Scenario: Update a site's fields
    Given a site at version 1
    When UpdateSite is called with a new name_en and expectedVersion 1
    Then the row's version becomes 2 and name_en is updated
    And exactly one "platform.site.updated" outbox row and its audit_log row are written

  Scenario: A stale expectedVersion is rejected
    Given a site at version 2
    When UpdateSite is called with expectedVersion 1
    Then StaleVersionError (409) and no column is written

  Scenario: UpdateSite kind-change to client_pickup without an account is rejected
    Given a site whose kind is not client_pickup and has no account_id
    When UpdateSite is called with kind "client_pickup" and no accountId
    Then SiteAccountRequiredError (422) — not a raw DB constraint error — and kind/version are unchanged

  Scenario: Deactivating a site via UpdateSite
    Given an active site at version 1
    When UpdateSite is called with isActive false and expectedVersion 1
    Then the row's is_active becomes false and version becomes 2

  Scenario: Role gates
    Given the caller holds only role "WH_OP"
    Then CreateSite and UpdateSite each throw RoleRequiredError and write nothing

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When CreateSite is called twice with K and the same body
    Then one site row exists and the second call returns the first result
    When it is called with K and a different body
    Then IdempotencyConflictError (409)

  Scenario: A site outside the caller's entity is invisible
    Given a site belonging to a different entity
    When UpdateSite is called against that site's id
    Then SiteNotFoundError (422) — RLS hides it, indistinguishable from missing (same convention as 3.3's EmployeeNotFoundError)
