# SLICE BRIEF — WBS 2.6 · `wms.skus` with client ownership, dimensions, storage conditions, tracking policy (mechanism slice)

Task: 2.6 — `wms.skus` with client ownership, dimensions, storage conditions, tracking policy
Lane: M (single lane on main — GM directive 2026-09-23, no parallelism before 2.9)   Lock: wms (tasks/LANE_LOCKS.md)   Owner: WH_MGR
Deps: 1.5 READY-satisfied (`f790da7`, proof slice, ADR-0001)
**GM authorization D-103 (2026-09-23):** 2.6 starts now, ahead of its "out of scope of the current directive" note in PROJECT_STATE, because 1.2 is blocked (no apps/API for its acceptance) and the 3.x tasks lack a TMS/HR assignment path. **Constraint (same directive): Phase-0 gate stays open — no NestJS/XState/pg-boss install, no touch of 2.9.**
Model routing (docs/MODEL_ROUTING.md): pg-tester sonnet → pg-backend sonnet → pg-reviewer opus → pg-scribe sonnet. Master orchestrates only.
Type of slice: **mechanism slice** (precedent WBS 2.8, `b5da282`; WBS 0.17, `c90dd6e`): the schema ALREADY delivers `wms.skus` (01-Data-Model.sql) with its RLS policy `sku_client_scope` and its two CHECK constraints. What 2.6 builds is the **registration mechanism** — a typed application command that writes a compliant row, rejects a cross-client attempt at the application layer (the runtime connection is still superuser — PROJECT_STATE carried-forward item, 0.18 §7 — so RLS alone cannot be relied on today), and proves the RLS policy itself still holds under a genuine non-superuser role. No endpoint, no UI, no XState machine (doc 40 §C3's Commands list does not name a SKU command at all — there is no state machine to build), no hexagonal tree — `scripts/new-slice.sh` remains a no-op until 2.9 (standing substitute, CHANGELOG 0.16 / 2.1); the code lives flat under `modules/wms/src/sku-registration/`.

## Read ONLY
- CLAUDE.md · .claude/briefs/wms.brief.md (§2–§3; ignore the mojibake in obj_description)
- database/schema/01-Data-Model.sql: 638-680 (`wms.skus` DDL, its unique/index lines), 410-436 (`sales.accounts` DDL — `client_id` FK target), 1480-1487 (`sku_client_scope` RLS policy, comment "أصناف العميل — فصل صارم يمنع خلط عميلين")
- database/schema/13B-Schema-Reference-Consolidation.sql: 2421-2423 (`chk_skus_status`: active·on_hold·discontinued), 3575-3577 (`chk_skus_picking_policy`: FIFO·FEFO·LIFO, null allowed)
- Live constraint names (verified against the applied schema, `pg_constraint` on `wms.skus`): `skus_client_id_code_key` (unique violation, SQLSTATE 23505), `skus_client_id_fkey` (FK violation, SQLSTATE 23503) — use these exact names, never guess a Postgres auto-generated name.
- docs/package/40-Build-Specification-EN.md: 222-260 (§C3 M04 Warehouse — entities line naming `skus` "owned by client"; INV-C3-3 "SKU belongs to one client")
- docs/package/38-WBS.md row 2.6 (acceptance, verbatim below)
- packages/db/index.ts · packages/db/src/with-context.ts (`withContext(ctx, fn)` — the ONLY way to touch the DB from src/)
- packages/events/index.ts · packages/events/src/outbox.ts (`writeOutboxEvent(tx, input)`) · packages/events/catalog.ts
- packages/domain-kit/index.ts · packages/domain-kit/clock.ts (`Clock`, `FixedClock` — injected clock only, never `new Date()`)
- modules/wms/src/stock-ledger/{errors.ts, post-movement.ts} (style precedent: typed errors with `name` set, `withContext` usage, the outbox+audit-in-one-transaction pattern, the `cause`-chain SQLSTATE/constraint matcher `isNegativeStockViolation` at post-movement.ts:110-124 — write `isDuplicateSkuCode` / `isUnknownClient` the SAME way)
- modules/wms/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts} · modules/wms/tests/integration/stock-ledger.test.ts (connection precedent: `pg` `Pool` + `PG*` env with the same defaults; the ephemeral-role RLS-proof pattern at lines 355-424 — same shape, different policy)
- docs/package/38-WBS.md row 2.6 acceptance line + doc 38 row 2.9 "Depends on" column (confirms 2.6 is one of 2.9's four dependencies — nothing here builds toward 2.9 itself)

## Write ONLY
- pg-tester: modules/wms/tests/integration/sku-registration.feature · modules/wms/tests/integration/sku-registration.test.ts · modules/wms/tests/unit/sku-registration.domain.test.ts (fast-check property tests)
- pg-backend: modules/wms/src/sku-registration/{domain.ts, errors.ts, register-sku.ts, index.ts} · modules/wms/index.ts (add the re-export line, do not remove the existing stock-ledger export)
- **packages/events/catalog.ts is NOT touched by anyone in this slice** (decision 9 — no outbox event; the Master-only exception from the 2.8 precedent does not apply here).
- pnpm-lock.yaml regenerates via `pnpm install` only if a new dependency is added — none is expected (modules/wms already depends on `@pg-eos/db`, `@pg-eos/events`, `@pg-eos/domain-kit`, `pg`, `fast-check`); `@pg-eos/events` is read-only reference in this brief now (decision 9), not actually imported by register-sku.ts.
Forbidden for every worker: database/**, packages/**, docs/**, scripts/**, any other module, CLAUDE.md, .claude/**, and — per the GM directive — no `nest`/`xstate`/`pg-boss` package add anywhere, no file under `modules/wms/{domain,application,infrastructure,api}/` or any WBS-2.9 path.
**Migration: none expected.** The table, its RLS policy and both CHECK constraints already exist. If a table, column, constraint or event catalog entry not listed here turns out to be required, STOP and report under G-01 (EXECUTION-MASTER-v4 §1.11); never invent one.

## Acceptance criterion (doc 38 row 2.6, verbatim)
"Cross-client SKU mix rejected"
Read together with doc 40 §C3's entity line ("`skus` (**owned by client**; …)") and INV-C3-3 ("SKU belongs to one client…"). 2.6 proves this at two independent layers, both permanent regression tests:
1. **Application layer (the layer that actually protects the live system today** — the runtime DB connection is superuser, PROJECT_STATE §0.18 item 7, so RLS alone is currently bypassed): `registerSku` rejects a portal-context (`isInternal: false`) attempt to register a SKU under a `clientId` other than the caller's own, BEFORE any DB call, with a typed `CrossClientSkuError`.
2. **Database layer** (proves the policy itself is sound, independent of the application, for the day the runtime connection is no longer superuser): an ephemeral, non-superuser, NOBYPASSRLS role scoped to client A cannot INSERT a `wms.skus` row with `client_id` = client B (SQLSTATE 42501) and cannot SELECT client B's rows (filtered to zero, not an error).
Gates: build 9/9 · `pnpm --filter @pg-eos/wms test` all green · `pnpm -w test -- --force` all green · `apply.sh --recreate` still green (no migration) · `pnpm guards:run` still all zero rows.

## Master decisions that the workers copy (not re-derive)
1. **Scope is registration only, not update.** doc 40 §C3's Commands list (application/commands) does not name any SKU command — inbound/outbound/count commands only. There is nothing in 01/13/13B/40/38 to derive an "update SKU" command's rules from, so none is built; inventing one would violate CLAUDE.md's "never invent a business rule". `registerSku` is a pure INSERT mechanism. `client_id` therefore has no mutation path to guard in this slice — its immutability is structural (no command changes it), not a rule this slice enforces.
2. **No entity scoping.** `wms.skus` has no `entity_id` column and no `entity_scope` policy — only `sku_client_scope` (client-owned, not entity-owned, matching doc 40's "owned by client"). Every `entity_id` this slice writes elsewhere (outbox, audit_log) is `null`.
3. **Input shape mirrors the DDL 1:1** (01-Data-Model.sql:638-676), camelCased, nothing added and nothing dropped:
   required: `clientId`, `code`, `nameAr` (all `not null` in the DDL).
   optional passthrough (no invented validation beyond the two CHECK constraints and the required/optional split the DDL itself states): `clientSku`, `barcode`, `cartonBarcode`, `nameEn`, `category`, `subcategory`, `brand`, `originCountry`, `lengthCm`, `widthCm`, `heightCm`, `netWeightKg`, `grossWeightKg`, `volumeCbm`, `unitsPerPack`, `packsPerCarton`, `cartonsPerLayer`, `layersPerPallet`, `tempMin`, `tempMax`, `maxStackHeight`, `unClass`, `shelfLifeDays`, `minRemainingLifeReceiptDays`, `minRemainingLifeIssueDays`, `minStock`, `maxStock`, `reorderPoint`, `abcClass`, `unitValue`, `imageUrl`, `msdsUrl`.
   optional with a DDL-literal default applied explicitly by the mechanism when omitted (never left to a dynamic column list — every INSERT names every column): `stackable` (`?? true`), `isFragile` (`?? false`), `isHazmat` (`?? false`), `lightSensitive` (`?? false`), `trackBatch` (`?? false`), `trackSerial` (`?? false`), `trackExpiry` (`?? false`), `pickingPolicy` (`?? 'FIFO'`), `quarantineDays` (`?? 0`), `status` (`?? 'active'`).
   **`unitsPerPallet` is NOT an input field** — it is a `generated always as (...) stored` column (01-Data-Model.sql:648-650); including it in the INSERT column list is a Postgres error. It may be read back via `RETURNING` for the test's own descriptive assertion, never computed by domain code.
4. **`validateSkuInput(input)`** — pure, no I/O — throws one typed `InvalidSkuInputError` for: `clientId`/`code`/`nameAr` missing or empty, `status` present and outside `SKU_STATUSES`, `pickingPolicy` present and outside `PICKING_POLICIES`. One error class covering all of these (same discipline as `InvalidLedgerEntryError` in the 2.8 precedent, which groups several validation failures into one class). Called before `withContext` is even opened — no DB call for a rejected input.
5. **`CrossClientSkuError`** — thrown by `registerSku` itself (not `validateSkuInput`, since it needs `ctx`), before `withContext` is opened, when `!ctx.isInternal && ctx.clientId !== input.clientId`. An internal caller (`ctx.isInternal === true`) may register a SKU for any client — this is how the (future) admin/onboarding path works; only a portal caller is restricted to its own `clientId`.
6. **`DuplicateSkuCodeError`** — mapped from a 23505 violation of `skus_client_id_code_key` (the same `(client_id, code)` pair already exists). **A duplicate `code` under a DIFFERENT `client_id` is NOT an error** — the uniqueness is per-client by design (01-Data-Model.sql:676 `unique (client_id, code)`); write a scenario proving this explicitly, since it is the precise boundary the acceptance criterion draws ("cross-client MIX rejected", not "codes must be globally unique").
7. **`UnknownClientError`** — mapped from a 23503 violation of `skus_client_id_fkey` (`client_id` does not reference an existing `sales.accounts` row).
8. **Error-mapping style** (post-movement.ts:105-124 precedent, `isNegativeStockViolation`): walk the thrown error's `cause` chain (drizzle wraps pg's `DatabaseError`) bounded by a `seen` Set, matching on `code` AND `constraint` together — never `code` alone, so no other constraint violation on the same table is ever mistaken for the wrong typed error. Write `isDuplicateSkuCode(error)` and `isUnknownClient(error)` the same way.
9. **NO outbox event — G-01 finding (raised during pg-tester RED, confirmed live against `pg_constraint`), audit_log only.** `platform.outbox`'s check constraint `outbox_business_needs_entity` (13B:1651-1654) requires `entity_id is not null OR split_part(aggregate_type,'.',1) in ('platform','identity')`; doc 40 §B3 line 154 states the same rule in prose: "every commercial/operational event carries the entity of its aggregate; the column is nullable only for platform-level events". `wms.skus` has **no `entity_id` column at all** — a SKU is owned by a client, not an entity, by the same cross-entity design as `sales.accounts` (01-Data-Model.sql comment: "الائتمان يُضبط على مستوى المجموعة ويُستهلك من كل الكيانات" — credit is set at group level and consumed by all four entities). There is no documented entity to attribute a `wms.sku.*` event to, and doc 40 §C3's Commands list does not name a SKU event at all. Per CLAUDE.md ("Missing? STOP and file a schema-change request under G-01; never invent"), this slice does **NOT** call `writeOutboxEvent` and does **NOT** add anything to `packages/events/catalog.ts` — inventing an entity_id source (or misusing the `platform.*`/`identity.*` exemption for a `wms.*` aggregate) would be exactly the kind of invented business rule CLAUDE.md forbids. **Open G-01 item for the GM**, recorded in this slice's CHANGELOG entry: whether `wms.skus` (and any other client-owned-not-entity-owned aggregate) should ever get `entity_id`, or whether `outbox_business_needs_entity` should recognise a documented cross-entity exemption beyond `platform.*`/`identity.*`. Only the `platform.audit_log` row is written (it has no such constraint — `entity_id` is plain nullable there): `(occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation, new_value, correlation_id)` = `(clock.now(), ctx.userId, ctx.userId === null ? 'system' : 'user', null, 'wms', 'skus', <sku id>, 'insert', <validated input as jsonb>, correlationId)`. `correlationId` is still caller-supplied (decision 10) and still returned, so a future outbox write (once G-01 resolves) can reuse the same value without an API change.
10. **Idempotency / version.** No endpoint exists in 2.6, so no Idempotency-Key header; `registerSku` takes an explicit `correlationId` (uuid) supplied by the caller, same as 2.8's `postMovement`. `wms.skus.id` is `gen_random_uuid()` at the DB — never generated in domain code. No version column exists on `wms.skus`; none is added (schema change, out of scope) — recorded for the reviewer, not a deviation.
11. **RLS proof role** (stock-ledger.test.ts:355-424 precedent, adapted): `create role pgeos_t_2_6_proof_<uuid> login password '<uuid>' nosuperuser nobypassrls`; `grant usage on schema wms to <role>`; `grant select, insert on wms.skus to <role>`; also `grant select on sales.accounts to <role>` (the role's own INSERT into `wms.skus` needs the FK target readable — confirm whether the FK check itself requires table-level SELECT privilege on `sales.accounts` for a non-superuser role; if it does, this grant is required, if Postgres's FK check runs with definer-level access regardless, note that finding instead of adding an unneeded grant). Connect a second `pg.Pool` as that role; **before** each RLS-proof query, `select set_config('app.client_id', $1, false)` and `select set_config('app.is_internal', 'false', false)` on that same connection (the policy reads these GUCs regardless of the connecting role — `platform.current_client_id()` / `platform.is_internal()`, 01-Data-Model.sql:32-40). Drop the role and revoke its grants in `afterAll`, same pattern as stock-ledger.test.ts.
12. **Fixtures.** Two fixture `sales.accounts` rows (`code` prefixed `_sku_fixture_a_` / `_sku_fixture_b_`, `account_type = 'client'`, `name_ar` set), created in `beforeAll`, deleted in `afterAll` together with every fixture `wms.skus` row and the fixture outbox rows (by `correlation_id`). Audit rows stay (hash chain; the 0.18 tail-only rule) — they reference fixture ids only. Test ctx for the internal path: `{ userId: <fixture uuid>, clientId: null, isInternal: true }`; for the portal path: `{ userId: <fixture uuid>, clientId: <fixture client A id>, isInternal: false }`.

## Public surface pg-backend implements (the RED tests import exactly these names from `modules/wms/index.ts`)
```ts
// domain.ts — pure, no I/O, no Date, no random
export const SKU_STATUSES = ['active', 'on_hold', 'discontinued'] as const;      // 13B chk_skus_status (2421-2423)
export type SkuStatus = (typeof SKU_STATUSES)[number];
export const PICKING_POLICIES = ['FIFO', 'FEFO', 'LIFO'] as const;               // 13B chk_skus_picking_policy (3575-3577)
export type PickingPolicy = (typeof PICKING_POLICIES)[number];
export interface RegisterSkuInput {
  readonly clientId: string; readonly code: string; readonly nameAr: string;
  readonly clientSku?: string | null; readonly barcode?: string | null; readonly cartonBarcode?: string | null;
  readonly nameEn?: string | null; readonly category?: string | null; readonly subcategory?: string | null;
  readonly brand?: string | null; readonly originCountry?: string | null;
  readonly lengthCm?: number | null; readonly widthCm?: number | null; readonly heightCm?: number | null;
  readonly netWeightKg?: number | null; readonly grossWeightKg?: number | null; readonly volumeCbm?: number | null;
  readonly unitsPerPack?: number | null; readonly packsPerCarton?: number | null;
  readonly cartonsPerLayer?: number | null; readonly layersPerPallet?: number | null;
  readonly tempMin?: number | null; readonly tempMax?: number | null;
  readonly stackable?: boolean; readonly maxStackHeight?: number | null;
  readonly isFragile?: boolean; readonly isHazmat?: boolean; readonly unClass?: string | null;
  readonly lightSensitive?: boolean;
  readonly trackBatch?: boolean; readonly trackSerial?: boolean; readonly trackExpiry?: boolean;
  readonly pickingPolicy?: PickingPolicy;
  readonly shelfLifeDays?: number | null; readonly minRemainingLifeReceiptDays?: number | null;
  readonly minRemainingLifeIssueDays?: number | null; readonly quarantineDays?: number;
  readonly minStock?: number | null; readonly maxStock?: number | null; readonly reorderPoint?: number | null;
  readonly abcClass?: string | null; readonly unitValue?: number | null;
  readonly imageUrl?: string | null; readonly msdsUrl?: string | null;
  readonly status?: SkuStatus;
}
export function validateSkuInput(input: RegisterSkuInput): RegisterSkuInput;    // throws InvalidSkuInputError
// errors.ts
export class InvalidSkuInputError extends Error {}
export class CrossClientSkuError extends Error {}
export class DuplicateSkuCodeError extends Error {}
export class UnknownClientError extends Error {}
// register-sku.ts
export interface RegisterSkuDeps { readonly clock: Clock; }
export interface RegisterSkuCommandInput extends RegisterSkuInput { readonly correlationId: string; }
export interface RegisteredSku { readonly skuId: string; readonly correlationId: string; }
export function registerSku(ctx: WithContextCtx, input: RegisterSkuCommandInput, deps: RegisterSkuDeps): Promise<RegisteredSku>;
```
All DB access inside `withContext(ctx, tx => …)`; SQL via drizzle `sql` tags on `tx.execute` (the 0.12/0.17/2.8 style), naming every column explicitly in the INSERT (decision 3 — never a dynamic column list).

## Scenario (Gherkin first — modules/wms/tests/integration/sku-registration.feature; every clause its own step)
Feature: A SKU is always owned by exactly one client; registering it under the wrong client is rejected (WBS 2.6; doc 40 §C3, INV-C3-3)
  Background: schema applied; fixture sales.accounts rows for client A and client B exist
  Scenario: an internal caller registers a SKU for client A
    When registerSku (internal ctx) registers a SKU for client A with required fields plus dimensions, storage conditions and tracking policy
    Then wms.skus has one new row with client_id = client A and every supplied field stored as given
    And units_per_pallet on that row equals the packaging fields' product (descriptive check of the existing generated column)
    And platform.audit_log has one row (wms, skus, that record_id, insert) with the given correlation_id
    And platform.outbox has NO row for that correlation_id (decision 9 — no entity_id on wms.skus, G-01 open item)
  Scenario: a portal caller registers a SKU for their own client
    When registerSku (client A portal ctx) registers a SKU with clientId = client A
    Then the row is written (no CrossClientSkuError)
  Scenario: a portal caller cannot register a SKU for a different client
    When registerSku (client A portal ctx) is called with clientId = client B
    Then CrossClientSkuError is thrown
    And no wms.skus row, no outbox row and no audit row were written for that attempt
  Scenario: the same code is rejected only within the same client
    Given client A already has a SKU with code "SKU-001"
    When registerSku (internal ctx) registers another SKU with code "SKU-001" and clientId = client A
    Then DuplicateSkuCodeError is thrown
    When registerSku (internal ctx) registers a SKU with code "SKU-001" and clientId = client B
    Then the row is written (no error) — the same code under a different client is not a mix
  Scenario: an unknown client is rejected
    When registerSku (internal ctx) registers a SKU with clientId = a random uuid with no sales.accounts row
    Then UnknownClientError is thrown
  Scenario: invalid status or picking policy is rejected before the database
    When registerSku is called with status "closed" (outside SKU_STATUSES)
    Then InvalidSkuInputError is thrown and no DB call was made
    When registerSku is called with pickingPolicy "LEFO" (outside PICKING_POLICIES)
    Then InvalidSkuInputError is thrown and no DB call was made
  Scenario: the RLS policy itself rejects a cross-client insert under a genuine non-superuser role
    Given an ephemeral, non-superuser, NOBYPASSRLS role scoped to client A (app.client_id = client A, app.is_internal = false)
    When that role inserts a wms.skus row with client_id = client B directly
    Then the insert fails with SQLSTATE 42501
    And that role selecting wms.skus rows sees none belonging to client B

## Property tests (fast-check, pure domain — modules/wms/tests/unit/sku-registration.domain.test.ts)
- validateSkuInput accepts any input with clientId/code/nameAr non-empty and status/pickingPolicy inside (or absent from) their enums.
- validateSkuInput rejects (InvalidSkuInputError) whenever clientId, code or nameAr is empty/whitespace-only, or status/pickingPolicy is present and outside its enum — for every arbitrary combination.
- validateSkuInput never mutates its input (returns an equal, not identical, object is acceptable; no field is silently dropped for a valid input).

## Test rules
- Connect like modules/wms/tests/integration/stock-ledger.test.ts (pg Pool, PG* env, same defaults). Unit tests touch no DB.
- Numeric comparisons via `::numeric`/`::text` equality in SQL, never JS floats, same discipline as the 2.8 precedent.
- RED first: the suite must fail on `import` (module not found) / on missing behaviour — report the exact failing test names.
  pg-backend then implements until GREEN without touching the tests.
- Run: `pnpm --filter @pg-eos/wms test` · `pnpm --filter @pg-eos/wms typecheck` · `npx eslint modules/wms` · root `pnpm typecheck`,
  `pnpm lint`, `pnpm lint:boundaries` · `pnpm guards:run` · finally `pnpm -w build --force` and `pnpm -w test -- --force`.
- Constraints (CLAUDE.md · AGENT CONSTRAINTS): no any / @ts-ignore / eslint-disable / console.log / magic numbers / fabricated values.
- **GM directive constraint, re-stated for the builder:** do not add `@nestjs/*`, `xstate` or `pg-boss` to any `package.json`; do not create or edit any file under `modules/wms/{domain,application,infrastructure,api}/`; do not touch anything under a WBS-2.9 path or `.golden-slice-accepted`.

Contract: none (no endpoint in 2.6; the Zod contract arrives with the golden slice).   Screen/Board spec: none.
Migration number: none issued.
Stop-and-ask if: any table/column/rule needed is not in 01 / 13 / 13B / 019 / 40; if the FK-check privilege question in decision 11 turns out to require a grant not listed here; if RLS or the CHECK constraints disagree with this brief in a way no decision above covers.

## Report back (§5 REPORT format)
RED tests (exact names) · Files changed · Files read outside list · Tests x/y with vitest output · Guards · Open questions · Model · Tokens.
