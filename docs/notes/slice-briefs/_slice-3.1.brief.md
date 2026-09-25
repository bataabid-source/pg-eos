Task: 3.1 `tms.vehicles`, documents, hard gate on expired docs (doc 38, owner FLEET_MGR, deps 0.9 DONE)
Lane: 3          Lock: fleet (whole-module lock, new module — D-184/GM, corrected from an initial `tms` mis-naming)
Read ONLY:
  - CLAUDE.md
  - .claude/briefs/fleet.brief.md
  - docs/package/40-Build-Specification-EN.md lines 266-278 (§C4, entities + INV-C4-1 through INV-C4-9 — only INV-C4-1's vehicle half is in scope)
  - database/schema/01-Data-Model.sql lines 843-866 (tms.vehicles, tms.vehicle_documents)
  - database/schema/13B-Schema-Reference-Consolidation.sql lines 2340-2344 (chk_vehicles_status, extended enum) and lines 1646-1656 (platform.outbox.entity_id + outbox_business_needs_entity CHECK)
  - modules/imile/application/pull-shipments/pull-shipments.ts (nearest cross-module precedent: insert-only command with an audit row and an outbox write in the same transaction — this module has no sibling use-case of its own yet, so this is read-only reference, never imported)
  - modules/hr/domain/register-employee/invariants.ts (round-1 finding 1: `BUSINESS_TIME_ZONE = 'Asia/Kuwait'` and the Kuwait-local-date comparison this file already established for the SAME class of rule — INV-C4-1's driver half, expired residency/licence — after its own past reviewer FAIL on this exact UTC-midnight defect; 01-Data-Model.sql:8 "التوقيت: timestamptz (UTC مخزَّن، Asia/Kuwait معروض)")
  - modules/hr/infrastructure/register-employee/repository.ts (round-1 finding 7: the entity-resolution pattern this slice's own repository.ts replicates — `WithContextCtx` has no `entityId` field, a known frozen-path gap, "batched Master tasks" in PROJECT_STATE.md — HR's own `resolveCallerEntityId`/`EntityScopeAmbiguousError` against `identity.user_entities` is the already-established cross-module answer to that gap, not an invented rule; this slice's comments must say so honestly instead of falsely claiming "this module's own precedent")

D-186 budget: 7 files here, well under the 8-file/1,000-line self-enforced ceiling. **D-186 review-round rule for THIS slice (Master directive, 2026-09-25): two rounds only — if round 2 is FAIL, STOP and report to the Master, no session-tier Master fix, no third round. The 3.14/3.17 pattern (escalating past the cap) is with the GM for a ruling and does not apply here.**

Write ONLY: modules/fleet/{domain,application,infrastructure,api,tests}/{register-vehicle,assert-vehicle-assignable}/** · packages/contracts/fleet/{register-vehicle,assert-vehicle-assignable}.ts · modules/fleet/index.ts (module barrel, first two use cases — plain `export *`, aliased only where two use cases' own exports collide, e.g. `ClockDeps`/`Logger`, same discipline pull-shipments/evaluate-dtl-problem already established inside `imile`) · tasks/backlog/MIGRATION-REQUEST-3.md (Master-authored bookkeeping row only, filing the future DB-level-enforcement G-01 candidate, not building it) · the mechanical `scripts/new-slice.sh` scaffold edits it makes on its own on a first `fleet` use case — `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `pnpm-lock.yaml`, `modules/fleet/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts}` (**review-round 1 finding 12: these were missing from Write ONLY, added here** — sanctioned Master-tier mechanism, same precedent as every prior slice's first-use-case scaffold, not a hand-edit) · tests/…

**Master design correction (2026-09-25, before round 2 review): a returned `canBeAssigned` flag does not meet doc 38 row 3.1's acceptance ("Expired-doc vehicle cannot be assigned") or doc 40 INV-C4-1 ("Hard gate … cannot be assigned") — a flag gates nothing; the actual assignment writes (`tms.delivery_tasks.vehicle_id`, `tms.routes.vehicle_id`, 01:890/907) live in a `delivery`-module slice that doesn't exist yet and cannot import `fleet`. This slice therefore delivers a SECOND use case, `assert-vehicle-assignable`, alongside `register-vehicle` (registration itself stays unblocked, as already agreed and built):**
  - `AssertVehicleAssignable(vehicleId: uuid, at: ISO datetime)` — a first-class command. Reads the vehicle's current `tms.vehicle_documents` rows and calls the SAME `hasExpiredDocument` pure predicate `register-vehicle` already built (no second implementation of the comparison). If any document is expired as of `at`, THROWS `VehicleNotAssignableError` (i18n key `fleet.vehicle.notAssignable`, params: vehicle `plateNo`, the expired documents' `docType`/`expiryDate` pairs — code-referenced only, same "i18n package bootstrap still pending" precedent 2.11/2.9b already recorded, no translation invented here). Otherwise resolves with no value — passing is the absence of a throw, not a returned boolean, so a future caller (the delivery module) cannot accidentally ignore a `false`.
  - This is the acceptance test's real subject: "Expired-doc vehicle cannot be assigned" is proven by `AssertVehicleAssignable` throwing, not by reading a flag.
  - **G-01 row filed, not built this slice:** DB-level enforcement of INV-C4-1 on the assignment columns (a trigger on `tms.delivery_tasks`/`tms.routes`, or a `fleet.assert_vehicle_assignable(uuid)` SQL function those triggers/the delivery module call) — required before WBS 3.4 (or whichever slice first writes `vehicle_id` on those tables) — same pattern as `wms.check_space_available()`. Filed as a row in `tasks/backlog/MIGRATION-REQUEST-3.md`, not a migration written now (no schema change this slice).
Scenario:
```gherkin
Feature: Register a vehicle and its documents, computing the expired-document assignment gate

  Scenario: A vehicle registered with no expired documents can be assigned
    Given a new vehicle with plate number "KWT-12345" and two documents, both with a future expiry_date
    When the vehicle is registered
    Then a new tms.vehicles row is inserted with status at its own column default
    And both tms.vehicle_documents rows are inserted, linked to the new vehicle
    And the result's canBeAssigned is true

  Scenario: A vehicle registered with one expired document cannot be assigned
    Given a new vehicle with plate number "KWT-67890" and two documents, one with a past expiry_date and one with a future expiry_date
    When the vehicle is registered
    Then both documents are still inserted as given — registration itself is never blocked by an expired document
    And the result's canBeAssigned is false — the hard gate (doc 38 acceptance; doc 40 INV-C4-1) fires on ANY expired document, not just all of them

  Scenario: A vehicle registered with zero documents can be assigned
    Given a new vehicle with plate number "KWT-00000" and no documents
    When the vehicle is registered
    Then the vehicle is inserted with no tms.vehicle_documents rows
    And the result's canBeAssigned is true — vacuously true, doc 40 INV-C4-1 has nothing to gate on

  Scenario: Registration publishes one domain event carrying the vehicle's entity
    Given a new vehicle with a valid entity context
    When the vehicle is registered
    Then one platform.outbox row is written in the same transaction, event_type "fleet.vehicle.registered", aggregate_type "fleet.vehicles", aggregate_id the new vehicle's id, entity_id the vehicle's own entity_id
    And one platform.audit_log row is written for the vehicle insert, recording every field actually written

  Scenario: A duplicate plate number is rejected
    Given a vehicle already registered with plate number "KWT-12345"
    When another registration is attempted with the same plate number
    Then the command fails with a mapped error (tms.vehicles.plate_no is UNIQUE, doc 07/40 give no other business rule for the collision — the DB constraint is the source of truth) and no row is written

  Scenario: A non-internal actor cannot write vehicle_documents (RLS, not application logic)
    Given a registration attempt by an actor whose session is not internal
    And the vehicle carries at least one document
    When the vehicle is registered
    Then the command fails — tms.vehicle_documents' own internal_only RLS policy (`using (platform.is_internal())`) rejects the write; this is NOT reimplemented as an application-level check, the database is the enforcement layer (CLAUDE.md ARCHITECTURE: "All DB access goes through withContext(ctx, fn), which sets RLS session variables")

Feature: Assert a vehicle is assignable — the real hard gate on expired documents

  Scenario: A vehicle with no expired documents passes the gate
    Given a registered vehicle whose documents all have a future expiry_date
    When AssertVehicleAssignable is called for that vehicle at the current time
    Then it resolves with no value — no error is thrown

  Scenario: A vehicle with any expired document fails the gate
    Given a registered vehicle with one document whose expiry_date is in the past
    When AssertVehicleAssignable is called for that vehicle at the current time
    Then it throws VehicleNotAssignableError
    And the error carries the vehicle's plateNo and the expired document's docType and expiryDate as params, never a hardcoded message

  Scenario: A vehicle with zero documents passes the gate
    Given a registered vehicle with no documents at all
    When AssertVehicleAssignable is called for that vehicle at the current time
    Then it resolves with no value — vacuously true, same as registration's own canBeAssigned

  Scenario: The gate is evaluated at the given instant, not "now" implicitly
    Given a registered vehicle with one document expiring at a specific future date
    When AssertVehicleAssignable is called for that vehicle at an instant AFTER that expiry date
    Then it throws VehicleNotAssignableError — the caller's own `at` governs, the command never reads the wall clock itself
```
Contract: packages/contracts/fleet/register-vehicle.ts — one command `RegisterVehicle`, input `{ plateNo: string (non-empty), make: string | null, model: string | null, year: number | null, vehicleType: string (non-empty), capacityKg: number | null, capacityCbm: number | null, isRefrigerated: boolean, ownership: string (non-empty), assignedClientId: uuid | null, documents: Array<{ docType: string (non-empty), docNo: string | null, issueDate: ISO date | null, expiryDate: ISO date (required, matches tms.vehicle_documents.expiry_date not null), fileUrl: string | null, alertDaysBefore: number }>, correlationId: uuid }` — `entityId` and `actorId` come from `ctx`, never the caller (same discipline as every prior slice). Derive every field from `tms.vehicles`/`tms.vehicle_documents` (01-Data-Model.sql:843-866) — never invent a field not in those tables; `status` and `ownership` are NOT settable by the caller beyond what the column defaults already are (`status` stays at its own column default `'active'` — the CHECK's extended `'registered'` value is 13B's own unconfirmed technical inference, "v4 (استنباط — يحتاج تحكيم)", not a settled business decision, so this slice does not invent a registration workflow around it). Result schema `RegisterVehicleResult { id: uuid, documentIds: uuid[], canBeAssigned: boolean }` — `canBeAssigned` stays (it's still a legitimate, honest snapshot of the documents just inserted), but it is NOT the acceptance-criterion mechanism any more; `AssertVehicleAssignable` is.

Contract (second use case): packages/contracts/fleet/assert-vehicle-assignable.ts — one command `AssertVehicleAssignable`, input `{ vehicleId: uuid, at: ISO datetime, correlationId: uuid }`. `at` is caller-supplied, never read from a wall clock inside this command (CLAUDE.md domain/ clock-injection rule extends naturally here — the caller decides "as of when", this command has no opinion). Result: resolves with no value on success; throws `VehicleNotAssignableError` (its own file, `domain/assert-vehicle-assignable/errors.ts`, D-179 use-case isolation, never imported cross-use-case) carrying `plateNo: string` and `expiredDocuments: Array<{ docType: string, expiryDate: string }>` as structured params for the i18n key `fleet.vehicle.notAssignable`. No Idempotency-Key — this is a pure read-and-assert, no write, no side effect.

**Review-round 1 (final scope) finding 1, Master correction — the gate must fail CLOSED, not open, for a non-internal caller.** `tms.vehicles`' own `entity_scope` RLS has no `is_internal()` guard, but `tms.vehicle_documents`' `internal_only` policy DOES — so a non-internal `ctx` reading a vehicle's documents silently sees ZERO rows, and `expiredDocumentsOf([], at)` is always empty, meaning the "hard gate" would trivially pass for every vehicle when called by a non-internal session, regardless of its real document state. This is the opposite of "hard gate". Fix (domain rule, not RLS reimplementation): `AssertVehicleAssignable`'s application layer checks `ctx.isInternal` BEFORE trusting an empty document read as "no expired documents" — if `ctx.isInternal` is false, throw a typed refusal (e.g. `VehicleDocumentAccessDeniedError`, reusing register-vehicle's own class rather than inventing a third) rather than resolving successfully. This is not a new "is internal" business rule invented from nothing — it is the command correctly refusing to draw a conclusion from data it knows it cannot see, which is different in kind from register-vehicle's own case (where the non-internal actor's OWN insert attempt fails loudly via RLS) — here a SELECT under RLS fails silently (zero rows, no error), so the command must add the explicit check RLS itself cannot provide for a read path.

**Review-round 1 (final scope) finding 5, Master correction — the i18n key/params must reach the API response, not stay comment-only.** Follow the established `wms/process-outbound` Problem-body precedent (a typed error carries a `readonly i18nKey` string; the API handler's Problem-details response body includes `i18nKey` and `params` fields alongside the human-readable `detail` fallback) — `VehicleNotAssignableError` needs a `readonly i18nKey = 'fleet.vehicle.notAssignable'` property, and the 422 handler must surface `i18nKey`/`params` (plateNo, expiredDocuments) in the response body, not just an English `detail` string.

Every domain error message in this slice ends with an "(Allowed: …)" clause stating what is allowed — including `VehicleNotAssignableError`'s own message (e.g. "(Allowed: a vehicle whose every document's expiry_date is on or after <Kuwait date>)"), matching every other error in this module.
Screen/Board spec: none (internal command, no UI this slice — D-blueprint 04's fleet screens are a later slice)
Deliver (mirrors evaluate-dtl-problem's own file set, the nearest single-command precedent — now two use cases):
  - modules/fleet/domain/register-vehicle/{errors.ts,invariants.ts} — `invariants.ts` exports `hasExpiredDocument(documents: readonly { expiryDate: string }[], asOf: Date): boolean` (pure, never throws, doc 40 INV-C4-1's vehicle half: true if ANY document's expiryDate is strictly before asOf) — ALREADY BUILT, already fixed round 1 (Kuwait-local date comparison), reused by assert-vehicle-assignable, not duplicated. **Review-round 1 (final scope) finding 2:** it must ALSO export `expiredDocumentsOf(documents: readonly { docType: string, expiryDate: string }[], asOf: Date): Array<{ docType: string, expiryDate: string }>` — the same Kuwait-local-date comparison, returning the actual expired subset instead of a boolean; `hasExpiredDocument` becomes a one-line delegate (`expiredDocumentsOf(documents, asOf).length > 0`), so there is exactly ONE comparison implementation, not two. The internal Kuwait-date-derivation helper (`businessDateOf` or equivalent) stays module-private — it is NOT exported for reuse; only `hasExpiredDocument` and `expiredDocumentsOf` are the module's public surface for this rule.
  - modules/fleet/application/register-vehicle/{index.ts,ports.ts,register-vehicle.ts} — already built
  - modules/fleet/infrastructure/register-vehicle/{repository.ts,logger.ts} — already built
  - modules/fleet/api/register-vehicle/{composition.ts,handlers.ts} — already built
  - modules/fleet/tests/register-vehicle/{register-vehicle.feature,register-vehicle.test.ts,invariants.property.test.ts,handlers.test.ts} — already built
  - packages/contracts/fleet/register-vehicle.ts — already built
  - modules/fleet/domain/assert-vehicle-assignable/errors.ts — new (`VehicleNotAssignableError`, its own file, never imports register-vehicle's errors.ts — its owning command imports `expiredDocumentsOf` from register-vehicle's invariants.ts, the one legitimate cross-use-case reuse this brief explicitly authorizes since it's the exact same pure predicate, not a second implementation; never `businessDateOf` or any other internal helper)
  - modules/fleet/application/assert-vehicle-assignable/{index.ts,ports.ts,assert-vehicle-assignable.ts} — new
  - modules/fleet/infrastructure/assert-vehicle-assignable/{repository.ts,logger.ts} — new (repository here is read-only: fetch a vehicle's plateNo + its vehicle_documents rows by vehicleId)
  - modules/fleet/api/assert-vehicle-assignable/{composition.ts,handlers.ts} — new
  - modules/fleet/tests/assert-vehicle-assignable/{assert-vehicle-assignable.feature,assert-vehicle-assignable.test.ts,handlers.test.ts} — new (no separate invariants.property.test.ts — hasExpiredDocument's own property tests in register-vehicle's test directory already cover the predicate exhaustively; a second copy would be a duplicate, not new coverage)
  - packages/contracts/fleet/assert-vehicle-assignable.ts — new
No `content-analysis-adapter.ts`/external-port equivalent this slice — everything RegisterVehicle needs (plate uniqueness, expiry comparison) is already fully computable from data already in the input and the database; there is no external/unbuildable dependency the way 3.14's portal or 3.17's OCR were.
`canBeAssigned` is computed ONCE, from the exact documents this call just inserted, using `hasExpiredDocument` — it is NOT a stored column (no `tms.vehicles`/`tms.vehicle_documents` column holds it; recomputing it from live `expiry_date` values whenever actually needed — e.g. a future assignment-time check — is deliberate, not a gap: a cached boolean would go stale the moment a document's expiry_date passes without any write happening).
No `version` column, no migration this slice — `tms.vehicles`/`tms.vehicle_documents` already exist (01-Data-Model.sql), already have `entity_scope`/`internal_only` RLS (verified live against `pg_policies`, not just the static schema files — a claimed gap here was checked and withdrawn, see `tasks/backlog/MIGRATION-REQUEST-3.md`), and this command is insert-only (no update path this slice).
Event: `fleet.vehicle.registered` — reported to the Master for `packages/events/catalog.ts` (frozen path, lane may publish its own module's new events without waiting, per CLAUDE.md · PARALLEL LANES — CONFLICT-FREE MECHANISM, "a lane may publish new events of its own module"); `aggregate_type` "fleet.vehicles", `entity_id` populated from the vehicle's own `entity_id` (required — `platform.outbox`'s `outbox_business_needs_entity` CHECK, 13B:1651-1656 — `fleet.*` is not `platform.*`/`identity.*` so this is mandatory, not optional, and this table genuinely HAS `entity_id` to supply it, unlike imile.shipments/dtl_problems in the prior two slices).
Audit row: one `platform.audit_log` insert for the vehicle, same hash-chain mechanism every prior slice already replicated — `new_value` carries every field the insert actually wrote (learn from 3.17's own round-1/round-2 cascade: get this right from the start, not narrowed after a finding).
Idempotency-Key required at the API layer, same 400/409/200 shape as every prior slice.
Migration number: none.
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40.
