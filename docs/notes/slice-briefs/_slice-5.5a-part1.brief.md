# SLICE BRIEF — WBS 5.5a part 1 (lane 2 → pg-tester → pg-backend)

Task: 5.5a part 1 "`platform.sites` (SCR-HR-SHIFT-01 §2.4)"      Lane: 2      Lock: `platform` (`platform.sites` ONLY) + `hr` (LANE_LOCKS rows `platform | 2 | 5.5a`, `hr | 2 | 5.5a`).
Acceptance (doc 38 row 5.5a, the slice this part contributes): "`platform.sites` is the single sites table (`kind ∈ {warehouse · office · client_pickup · housing · other}`, `radius_m` defaulting from `platform.thresholds` `att.geofence_radius_m`) referenced by `hr.employees.default_site_id`; every state change → outbox + audit in one transaction." Owner: HR_MGR.   Depends: none (first slice to touch `platform.sites`).
**Split from the full 5.5a scope** (precedent: WBS 5.13 part 1/part 2) to stay inside the 12-file Read-ONLY budget (CLAUDE.md · SPEED AND QUALITY). Part 2 (a later slice, its own migration number) delivers `hr.shifts` / `hr.shift_assignments` / `hr.shift_groups`, which reference `platform.sites(id)`; **5.5a stays NOT DONE until part 2 lands** (Master-confirmed).

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/platform.brief.md`
- golden slice (shape only): `modules/wms/domain/receive-inbound/{errors.ts,invariants.ts}` — **no `machine.ts`**: `is_active` is a plain boolean, not a multi-edge lifecycle (no XState edges to encode; D1 below), so `modules/platform/domain/maintain-site/machine.ts` is deleted, same as 3.3 deleted `suggest-location-ranking.ts` for an unused golden file.
- `modules/hr/application/register-employee/{ports.ts,register-employee.ts}` (nearest precedent: single entity-scoped aggregate, audit + outbox in one transaction, fail-closed entity resolution)
- `modules/hr/api/register-employee/handlers.ts` (Problem envelope / Idempotency-Key / role-gate shape to replicate)
- `docs/notes/SCR-HR-SHIFT-01-shifts-groups-sites-devices.md` §2.4 (quoted verbatim below — do not re-read the document)
- schema: `database/migrations/0015_2_platform-sites.sql` (the delivered table, already applied locally and verified: 14/14 columns classified, RLS `entity_scope` active, grants correct, threshold seeded)
- `packages/contracts/hr/register-employee.ts` (contract shape: one `<Command>InputSchema` per command, `.meta({id})`, no `entityId`/`performedBy` fields)
- `packages/contracts/_shared/{problem.ts,headers.ts}` (Problem envelope, `Idempotency-Key` header)
- `packages/events/catalog.ts` (frozen — requested additions `platform.site.created` / `platform.site.updated`, Master notified; if not yet merged when pg-backend starts, write the outbox call with the literal string and a `// TODO(Master): CatalogedEventType once packages/events/catalog.ts is updated` comment, same recovery 3.3 needed)
- Scaffold already run: `scripts/new-slice.sh platform maintain-site` (files listed under Deliver; renamed copies of the golden slice, logic to be replaced)

Write ONLY: `modules/platform/**` (this slice's own `maintain-site` use case only — do not touch `modules/platform/{domain,application,infrastructure,api,tests}/evaluate-alerts` or its `index.ts` barrel except to ADD the new use case's export) · `packages/contracts/platform/maintain-site.ts` · `tests/**` ·
`database/migrations/0015_2_platform-sites.sql` — **already written, reviewed and applied; do not edit it** (forward-only; a fix is a NEW migration).
pg-tester writes ONLY test files (`modules/platform/tests/maintain-site/**`, `*.feature`). pg-backend never edits a test.

## Facts (verified by the lane against the schema and the package — quote, do not re-derive)

- `platform.sites` columns (migration 0015, applied): `id, entity_id, kind, account_id, warehouse_id, name_ar, name_en, address, geo_lat numeric(10,7), geo_lng numeric(10,7), radius_m, contact_phone, is_active, version`. RLS `entity_scope` (non-nullable `entity_id`). CHECK `chk_sites_kind` (5-value enum) and `chk_sites_client_pickup_account` (`kind = 'client_pickup' ⇒ account_id is not null`) already enforce at the DB layer — the domain/contract layer enforces the SAME rules (doc 36 §5-4 #2: every invariant lives in both places), not new ones.
- SCR-HR-SHIFT-01 §2.4 (verbatim, already GM-approved under D-144 item 4 "نعم جدول واحد" — quoting so the worker never re-reads the SCR): "`platform.sites`: `id · entity_id · kind ∈ {warehouse · office · client_pickup · housing · other} · account_id → sales.accounts (required when kind = client_pickup) · warehouse_id → wms.warehouses (nullable) · name_ar · name_en · address fields · geo_lat · geo_lng · radius_m (default from platform.thresholds att.geofence_radius_m = 500, D-141 Q30b) · contact_phone · is_active · version`. `hr.employees.default_site_id` and `tms.delivery_tasks.pickup_site_id` both reference it."
- `radius_m` has a DB-level default (`platform.att_geofence_radius_m()`, reads `platform.thresholds`) — the contract's `radiusM` field is OPTIONAL; when omitted, the INSERT statement must not set the column at all (so the DB default fires), never compute/pass 500 from application code (CLAUDE.md · AGENT CONSTRAINTS "No magic numbers").
- Roles (identity.roles, 13B:556-572): no role is named specifically for "sites". `HR_MGR` (all-scope) owns the SCR this table originates from; `OPS_DIR` (all-scope) is the broadest operational role, since a site can be a warehouse or office outside HR's remit. `GM` per the standing convention (3.3 D6) always included.
- `writeOutboxEvent(tx, { entityId, aggregateType, aggregateId, eventType, payload, correlationId, actorId })` (`@pg-eos/events`); outbox row in the SAME transaction as the state change; matching `platform.audit_log` row (G9), same as the golden slice and 3.3.
- Entity resolution is fail-closed (3.3 precedent, D9 there): `cardinality(platform.allowed_entities()) = 1` else `EntityScopeAmbiguousError` 422 (`WithContextCtx` has no `entityId` — still a batched Master task, `packages/db` frozen).
- `tms.delivery_tasks.pickup_site_id` (mentioned in §2.4) is **WBS 3.7, NOT this slice** — do not add it, do not reference `tms` from this module.

## Defaults taken by the lane (CHANGELOG lines; batched to the GM in the closing report)

D1. No XState machine: `is_active` is a plain boolean flag (schema precedent: `wms.warehouses.is_active`, `hr.teams` has no such column at all — no table in 01/13/13B models a site-like row with a multi-state lifecycle), so `UpdateSite` sets it directly under optimistic lock; `modules/platform/domain/maintain-site/machine.ts` is deleted.
D2. Two commands: `CreateSite`, `UpdateSite` (covers create + every mutable field, including `isActive`, in one command — no separate Activate/Deactivate command; lean design, GM speed directive). No read command in this slice (no screen/board spec exists yet for sites; a later UI slice adds one, same as 3.3's precedent of shipping backend-only).
D3. Role gate: `CreateSite` / `UpdateSite` → `HR_MGR`, `OPS_DIR`, or `GM` (Facts above; question to the GM, batched: should `WH_MGR`/`FLEET_MGR` also write sites for their own warehouse/office rows?).
D4. `kind` and the `client_pickup ⇒ account_id` rule are re-validated in `domain/invariants.ts` even though the DB CHECK already enforces them (doc 36 §5-4 #2: dual enforcement, not redundant — the domain layer must reject before ever reaching the DB, with a typed error the API can map to 422, not a raw `23514` constraint-violation Problem).
D5. `radius_m`: contract accepts an optional `radiusM: z.number().positive().optional()` — a caller-supplied value must be `> 0` (domain invariant `SiteRadiusInvalidError`); omitted means "use the column default", so `insertSite` must build its INSERT column list conditionally (no `radius_m` key at all when omitted), same technique 3.3 used for optional document fields.
D6. `entity_id` = `ctx.entityId` (never caller-supplied, same as 3.3 D9); actor = `ctx.userId`.
D7. Events: `platform.site.created` (once per `CreateSite`) and `platform.site.updated` (once per `UpdateSite` call that writes a changed column — a no-op update, i.e. every field equal to the current row, still bumps `version`? **No** — brief default: an `UpdateSite` call is always treated as a real change once it passes validation; it always bumps version and always emits the event, matching 3.3's `RecordEmployeeDocument`/`ChangeEmployeeStatus` unconditional-bump precedent. No "no-op" detection is added — lean design).
D8. `UpdateSite` requires `expectedVersion` (optimistic lock, `StaleVersionError` 409 on mismatch — identical mechanics to 3.3's `RecordEmployeeDocument`). `CreateSite` requires none (new row, `version` starts at 1 per the migration's column default).

## Scenario (Gherkin — pg-tester pastes into `modules/platform/tests/maintain-site/maintain-site.feature`)

```gherkin
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

  Scenario: Update a site's fields
    Given a site at version 1
    When UpdateSite is called with a new name_en and expectedVersion 1
    Then the row's version becomes 2 and name_en is updated
    And exactly one "platform.site.updated" outbox row and its audit_log row are written

  Scenario: A stale expectedVersion is rejected
    Given a site at version 2
    When UpdateSite is called with expectedVersion 1
    Then StaleVersionError (409) and no column is written

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
```

Property tests (fast-check, `invariants.property.test.ts`):
- P1 for any `kind` string: `isValidKind(kind) ⇔ kind ∈ {warehouse, office, client_pickup, housing, other}`.
- P2 for any `(kind, accountId)` pair: `requiresAccount(kind, accountId) ⇔ kind = 'client_pickup' ∧ accountId is null` throws.
- P3 for any numeric `radiusM` (including undefined): `isValidRadius(radiusM) ⇔ radiusM is undefined ∨ radiusM > 0`.
No machine unit test (D1 — no machine).

## Contract (`packages/contracts/platform/maintain-site.ts`)

`CreateSiteInputSchema`, `UpdateSiteInputSchema` (`.meta({id})` each). `kind` enum (5 values). `accountId`/`warehouseId` optional UUIDs. `nameAr` required, `nameEn` optional. `address` optional. `geoLat`/`geoLng` optional numbers (no explicit range validation beyond the DB column's own precision — lean design, not a G-01 invention). `radiusM: z.number().positive().optional()`. `contactPhone` optional. `isActive` optional boolean (Update only — Create always inserts `true`, the column default). `expectedVersion` on Update only. `correlationId` on every command. No `entityId`, no `performedBy`.

Screen/Board spec: none (backend only, like 3.3 and the golden slice).

## Deliver (from `new-slice.sh`, rename the golden-only files to the counterparts below; delete files with no counterpart)

```
modules/platform/domain/maintain-site/{errors.ts,invariants.ts}                      (delete machine.ts — D1 — and suggest-location-ranking.ts)
modules/platform/application/maintain-site/{ports.ts,index.ts,create-site.ts,update-site.ts}   (delete approve-inbound.ts, cancel-inbound.ts, close-inbound.ts, confirm-putaway.ts, receive-line.ts, suggest-location.ts)
modules/platform/infrastructure/maintain-site/{repository.ts,logger.ts}              (delete ledger.ts)
modules/platform/api/maintain-site/{composition.ts,handlers.ts}
modules/platform/tests/maintain-site/{maintain-site.feature,maintain-site.test.ts,invariants.property.test.ts,handlers.test.ts}   (delete inbound-machine.unit.test.ts — D1 — and suggest-location-ranking.property.test.ts)
packages/contracts/platform/maintain-site.ts
modules/platform/index.ts   (ADD an export line for maintain-site's application barrel, alongside the existing evaluate-alerts export — do not remove that line)
```

Migration number: **issued — 0015** (`database/migrations/0015_2_platform-sites.sql`, Master 2026-09-24, pre-migration review APPROVED WITH CHANGES, 7 findings applied, applied locally and verified).

Test run: `pnpm --filter @pg-eos/platform test` (vitest per module, low memory — never the full suite) with `PG_APP_USER=pgeos_app`, admin pool from PGUSER for fixtures. Guards: `pnpm guards:run`.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 / SCR-HR-SHIFT-01 §2.4 (D-144-approved) or in the Facts above.
Agent tiers (docs/MODEL_ROUTING.md): pg-tester sonnet ≤ 30k · pg-backend sonnet ≤ 40k · pg-reviewer opus ≤ 30k · pg-scribe sonnet ≤ 10k.
