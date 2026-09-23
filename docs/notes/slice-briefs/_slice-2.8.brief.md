# SLICE BRIEF — WBS 2.8 · Stock ledger + derived balance + `verify_balance_integrity()` (mechanism slice)

Task: 2.8 — Stock ledger + derived balance + `wms.verify_balance_integrity()`      Lane: M (single lane on main — GM directive 2026-09-23, no parallelism before 2.9)
Lock: wms (tasks/LANE_LOCKS.md)      Owner: WH_MGR      Deps: 0.12 DONE (`4164eb0`)
Model routing (GM 2026-09-23): pg-tester sonnet → pg-backend sonnet → pg-reviewer opus → pg-scribe sonnet. Master orchestrates only.
Type of slice: **mechanism slice** (precedent WBS 0.17, `c90dd6e`): the schema ALREADY delivers the three artefacts —
`wms.stock_movements` (append-only ledger, 01 wms.stock_movements), `wms.stock_balance` (derived balance, 01 wms.stock_balance) and
`wms.verify_balance_integrity()` (01 §wms.verify_balance_integrity (v1.1), guard G1). What 2.8 builds is the **posting mechanism** that writes the
ledger and maintains the derived balance so that the guard stays at zero rows, plus the permanent proof suite.
No endpoint, no UI, no XState machine (no state transitions exist in a ledger), no hexagonal tree — `scripts/new-slice.sh`
is a no-op until 2.9 (standing substitute, CHANGELOG 0.16 / 2.1); the code lives flat under `modules/wms/src/stock-ledger/`.

## Read ONLY
- CLAUDE.md · .claude/briefs/wms.brief.md (§2–§3; ignore the mojibake in obj_description)
- database/schema/01-Data-Model.sql: 675-720 (skus tail, `stock_movements`, `stock_balance`), 01 §wms.verify_balance_integrity (v1.1),
  and the `sales.accounts` / `wms.skus` / `wms.locations` DDL (grep `create table sales.accounts`, `create table wms.skus`,
  `create table wms.locations`) — fixture columns only
- database/schema/13B-Schema-Reference-Consolidation.sql: `13B chk_stock_movements_type (§13B-24)` (the ONLY legal movement_type
  list), the `entered_offline` loop (`entered_offline` / `original_occurred_at` columns added to stock_movements), `§13B-2 platform.audit_log` (DDL)
- database/schema/guards.sql: 31-32 (G1 is exactly `select * from wms.verify_balance_integrity()`)
- docs/package/40-Build-Specification-EN.md: 30-31 (P3 append-only ledgers · P4 derived balances rebuildable with zero diff),
  244-245 (INV-C3-1, INV-C3-2), 639 (G9: every outbox row has an audit_log row with the same correlation_id), 631 (G1)
- docs/package/38-WBS.md row 2.8 (acceptance, verbatim below)
- packages/db/index.ts · packages/db/src/with-context.ts (`withContext(ctx, fn)` — the ONLY way to touch the DB from src/)
- packages/events/index.ts · packages/events/src/outbox.ts (`writeOutboxEvent(tx, input)`) · packages/events/catalog.ts
- packages/domain-kit/index.ts · quantity.ts · clock.ts · id-generator.ts (Quantity for numeric(14,3) arithmetic; Clock and
  IdGenerator are injected — no `new Date()` / `Math.random()` in domain code)
- modules/wms/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts} · modules/wms/tests/integration/wh1-setup.test.ts
  (connection precedent: pg Pool + PG* env with the same defaults) · modules/platform/tests/integration/schema-invariants.test.ts:90-110
  (the audit_log insert shape) · packages/identity/tests/rbac-sod.test.ts (fixture create/cleanup precedent, afterAll)
- packages/identity/src/*.ts (structural precedent for a mechanism package: typed errors, injected clock, withContext use)

## Write ONLY
- pg-tester: modules/wms/tests/integration/stock-ledger.feature · modules/wms/tests/integration/stock-ledger.test.ts ·
  modules/wms/tests/unit/stock-ledger.domain.test.ts (fast-check property tests) · modules/wms/vitest.config.ts (only to widen
  `include` to `tests/**/*.test.ts`) · modules/wms/package.json (only to add the `fast-check` devDependency, then `pnpm install`)
  · modules/wms/tests/integration/{rebuild-balance-scope, rebuild-balance-scope-full, rebuild-balance-lock, balance-integrity-batch}.{feature,test.ts}
- pg-backend: modules/wms/src/stock-ledger/{domain.ts, errors.ts, post-movement.ts, rebuild-balance.ts, index.ts} ·
  modules/wms/index.ts (re-export the public surface) · modules/wms/package.json (workspace deps `@pg-eos/db`, `@pg-eos/events`,
  `@pg-eos/domain-kit`; then `pnpm install`) · modules/wms/tsconfig.json (only if `src/` must be added to `include`)
- Master only: packages/events/catalog.ts (adds the event name `wms.stock.moved` in the same commit — frozen path, never a worker)
- pnpm-lock.yaml regenerates via `pnpm install` — never hand-edited.
Forbidden for every worker: database/**, packages/**, docs/**, scripts/**, any other module, CLAUDE.md, .claude/**.
**Migration: none expected.** If a table, column, constraint or function change turns out to be required, STOP and report
under G-01 (EXECUTION-MASTER-v4 §1.11); a new migration would be `0004_M_<slug>.sql` and needs the Master's number.

## Acceptance criterion (doc 38 row 2.8, verbatim)
"Zero rows after 1,000 random movements; property test green"
Plus the GM directive 2026-09-23 phase C: RED tests first covering (a) the append-only ledger, (b) derived balance = sum of
movements, (c) `verify_balance_integrity()` detects any deviation, (d) edge cases: zero quantity, reversal, concurrency.
Gates: build 9/9 · `pnpm -w test -- --force` all green · `apply.sh --recreate` green with G1–G13 = 0.

## Master decisions that the workers copy (not re-derive)
1. **Single-sided ledger rows.** `verify_balance_integrity()` (01 §wms.verify_balance_integrity (v1.1)) attributes each row to `coalesce(to_location_id,
   from_location_id)` with sign `+` when `to_location_id` is set, else `−`. A row carrying BOTH sides would therefore count only
   the `to` side. To keep the guard at zero without touching the schema, every ledger row written by this mechanism has
   **exactly one** of `from_location_id` / `to_location_id` set, and `qty > 0` (direction comes from the side). A **transfer**
   is two rows in the same transaction — an out-row at `from` and an in-row at `to`, same `client_id/sku_id/qty/batch_no`,
   both `movement_type = 'transfer'`, sharing `ref_table/ref_id` and the outbox `correlation_id`. Recorded as an open question
   for the GM (a two-sided row is representable in 01 but not in the guard); no schema change is proposed here.
2. **Balance key.** `wms.stock_balance` upsert key is `(client_id, sku_id, location_id, batch_no)` with `batch_no` default `''`
   (01 wms.stock_balance.batch_no default ''). The mechanism upserts `qty_on_hand = qty_on_hand ± qty` atomically (`on conflict … do update`) and sets
   `last_movement_at` from the injected Clock. `qty_allocated` is NOT touched by 2.8 (allocation belongs to 2.11).
3. **Negative stock.** `no_negative_stock` (01 wms.stock_balance constraint no_negative_stock) is the authority. A movement that would drive `qty_on_hand` below zero is
   rejected by the constraint (SQLSTATE 23514); the transaction rolls back, so no ledger row, no outbox row, no audit row remain.
   The mechanism surfaces this as a typed `NegativeStockError`; it does not pre-check with a racy read.
4. **Zero / negative quantity.** `qty_not_zero` (01 wms.stock_movements constraint qty_not_zero) plus decision 1 (`qty > 0`): the domain rejects `qty <= 0` before any
   DB call with a typed `InvalidQuantityError`. Quantity arithmetic uses `@pg-eos/domain-kit` `Quantity` (numeric(14,3)), never JS floats.
5. **Reversal = counter-entry only** (01 comment on wms.stock_movements "التصحيح بحركة تسوية مقابلة فقط"; doc 40 P3). `reverseMovement` posts one
   row with `movement_type = 'adjust'`, the opposite side, the same qty and batch, `ref_table = 'wms.stock_movements'`,
   `ref_id = <original id>`, `reason_code = 'reversal'`. The original row is never updated or deleted. Reversing a reversal is
   allowed (it is just another counter-entry). Reversing a non-existent id → typed `MovementNotFoundError`.
6. **Append-only proof.** `revoke update, delete on wms.stock_movements from public` (01 revoke update, delete on wms.stock_movements) does not bind a superuser, and
   the runtime still connects as superuser (carried-forward 0.18 item 7). The proof therefore creates a temporary
   NOBYPASSRLS, non-superuser role with `select, insert` on the table (and `usage` on schema wms), attempts `update` and
   `delete` through it, and expects SQLSTATE 42501 with the row unchanged. The role is dropped in afterAll.
7. **Event + audit in the same transaction** (CLAUDE.md ARCHITECTURE; G9 doc 40:639). Per posted movement (both rows of a
   transfer share one correlation): `writeOutboxEvent(tx, { entityId, aggregateType: 'wms.stock_movements', aggregateId: <movement id>,
   eventType: 'wms.stock.moved', payload: <the ledger entry as written>, correlationId, actorId: ctx.userId })` AND one
   `platform.audit_log` row: `(occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
   new_value, correlation_id)` = `(clock.now(), ctx.userId, 'user' | 'system' when userId is null, entityId, 'wms',
   'stock_movements', <movement id>, 'insert', <entry jsonb>, correlationId)`. The hash-chain trigger fills prev/row hash.
   Event name `wms.stock.moved` follows doc 40 §B3 `<module>.<aggregate>.<past_tense>`; the Master adds it to `EVENT_CATALOG`.
8. **Rebuild.** doc 40 P4: balances are derived and rebuildable with zero diff. `rebuildBalance(ctx, { clientId, skuId })`
   recomputes `qty_on_hand` per `(location_id, batch_no)` from the ledger with the SAME fold as `verify_balance_integrity()`
   and overwrites `wms.stock_balance` for that (client, sku) inside one transaction (rows absent from the ledger → deleted;
   `qty_allocated` preserved). After a rebuild the guard returns zero rows for that pair.
9. **Idempotency / version.** No endpoint exists in 2.8, so no Idempotency-Key header; `postMovement` takes an explicit
   `correlationId` (uuid) supplied by the caller and returns it. `wms.stock_balance` is derived, not an aggregate → no version
   column is added (would be a schema change). Recorded for the reviewer, not a deviation.
10. **Fixtures.** Entity = `platform.entities` where `code = 'PST'`; locations = existing `wms.locations` of warehouse `WH1`
    with `is_blocked = false` and zone_type `storage` (from `019`); fixture client `sales.accounts` (`code` prefixed
    `_ledger_fixture_`, `account_type = 'client'`, `name_ar` set) and fixture `wms.skus` rows (client_id, code, name_ar) created
    in beforeAll and deleted in afterAll together with the fixture `stock_balance` and `stock_movements` rows (the test pool is
    superuser, so it may delete ledger rows — production never does) and the fixture outbox rows (by `correlation_id`).
    Audit rows stay (hash chain; the 0.18 tail-only rule) — they reference fixture ids only. `performed_by` = a fixed uuid
    constant named in the test (no FK on that column, 01 wms.stock_movements.performed_by).
11. **Randomness in tests.** The 1,000-movement run uses fast-check with an explicit, printed seed (`fc.assert(..., { seed })`
    or a seeded generator) so a failure is reproducible; movements are drawn from decisions 1–5 (receipt/putaway/pick/transfer/
    adjust/count/damage/return/scrap/issue/pack/ship as the 13B list allows), against ≥ 3 SKUs × ≥ 5 locations, executed with
    real concurrency (≥ 20 in flight via `Promise.all` batches). Expected rejections (NegativeStockError) are counted, not
    failures. At the end: `select * from wms.verify_balance_integrity()` returns **zero rows** (whole-table, the acceptance
    wording) and, for each fixture (client, sku, location), `qty_on_hand` equals the fold of the fixture's ledger rows.

12. **Rebuild scope (review finding 9, 2026-09-23).** rebuildBalance first checks, in its transaction, `select (r.rolsuper or r.rolbypassrls) as bypass, platform.is_internal() as internal, not exists (select 1 from platform.entities e where not (e.id = any(platform.allowed_entities()))) as all_entities from pg_roles r where r.rolname = current_user`; allowed = bypass OR (internal AND all_entities); otherwise RebuildScopeError and nothing is read or written.
13. **Rebuild/posting serialisation (review finding 1, 2026-09-23).** Every posting takes `pg_advisory_xact_lock_shared(hashtextextended(balanceRebuildLockKey(client, sku), 0))` before its per-balance-key locks; rebuildBalance takes the exclusive `pg_advisory_xact_lock` on the same key before folding. Postings never block each other on it; a rebuild waits for in-flight postings and blocks new ones until it commits.

Runner config: modules/wms/vitest.config.ts `fileParallelism: false` — Master direct (shared DB, grant/revoke catalog contention, global audit-chain lock).

**SCR-WMS-01 (2026-09-23): the guard now keys by batch_no and compares both directions — decision 1's single-sided rows still hold.**

## Public surface pg-backend implements (the RED tests import exactly these names from `modules/wms/index.ts`)
```ts
// domain.ts — pure, no I/O, no Date, no random
export const MOVEMENT_TYPES = ['receipt','putaway','pick','pack','ship','issue','transfer','adjust','count','damage','return','scrap'] as const; // 13B chk_stock_movements_type (§13B-24) verbatim
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export interface LedgerEntry { readonly clientId: string; readonly skuId: string; readonly fromLocationId: string | null;
  readonly toLocationId: string | null; readonly qty: Quantity; readonly batchNo: string; readonly movementType: MovementType; readonly uom: string; }
export function validateEntry(entry: LedgerEntry): LedgerEntry;                 // throws InvalidLedgerEntryError | InvalidQuantityError
export function deriveBalances(entries: readonly LedgerEntry[]): ReadonlyMap<string, Quantity>; // key `${clientId}|${skuId}|${locationId}|${batchNo}`, same fold as 01 §wms.verify_balance_integrity (v1.1)
export function balanceKey(clientId: string, skuId: string, locationId: string, batchNo: string): string;
export function planTransfer(base: Omit<LedgerEntry,'fromLocationId'|'toLocationId'|'movementType'>, from: string, to: string): readonly [LedgerEntry, LedgerEntry];
export function planReversal(original: LedgerEntry): LedgerEntry;               // decision 5
// errors.ts
export class InvalidLedgerEntryError extends Error {}  export class InvalidQuantityError extends Error {}
export class NegativeStockError extends Error {}       export class MovementNotFoundError extends Error {}
// post-movement.ts
export interface PostMovementInput { readonly entityId: string; readonly entry: LedgerEntry; readonly correlationId: string;
  readonly performedBy: string; readonly refTable?: string | null; readonly refId?: string | null; readonly reasonCode?: string | null; readonly deviceId?: string | null; }
export interface LedgerDeps { readonly clock: Clock; readonly ids: IdGenerator; }
export interface PostedMovement { readonly movementIds: readonly string[]; readonly correlationId: string; }
export function postMovement(ctx: WithContextCtx, input: PostMovementInput, deps: LedgerDeps): Promise<PostedMovement>;
export function postTransfer(ctx: WithContextCtx, input: Omit<PostMovementInput,'entry'> & { readonly base: Parameters<typeof planTransfer>[0]; readonly fromLocationId: string; readonly toLocationId: string }, deps: LedgerDeps): Promise<PostedMovement>;
export function reverseMovement(ctx: WithContextCtx, input: { readonly movementId: string; readonly correlationId: string; readonly performedBy: string }, deps: LedgerDeps): Promise<PostedMovement>;
// rebuild-balance.ts
export function rebuildBalance(ctx: WithContextCtx, input: { readonly clientId: string; readonly skuId: string }, deps: LedgerDeps): Promise<{ readonly rowsWritten: number }>;
// errors.ts (review finding 8)
export class RebuildScopeError extends Error {}
// domain.ts (review finding 8)
export function balanceRebuildLockKey(clientId: string, skuId: string): string; // returns 'wms.stock_balance.rebuild|' + clientId + '|' + skuId
```
All DB access inside `withContext(ctx, tx => …)`; SQL via drizzle `sql` tags on `tx.execute` (the 0.12/0.17 style). Test ctx:
`{ userId: <fixture uuid>, clientId: null, isInternal: true }`.

## Scenario (Gherkin first — modules/wms/tests/integration/stock-ledger.feature; every clause its own step)
Feature: Stock ledger is append-only and the derived balance always equals the ledger (WBS 2.8; doc 40 P3/P4, INV-C3-1/2)
  Background: schema applied; fixture entity PST, warehouse WH1 storage locations, fixture client and SKUs exist
  Scenario: a receipt is written to the ledger and raises the balance at its location
    When postMovement posts a receipt of 12.500 to location L1
    Then wms.stock_movements has one new row with to_location_id L1, from_location_id null, qty 12.500
    And wms.stock_balance (client, sku, L1, '') has qty_on_hand 12.500 and last_movement_at set
    And platform.outbox has one row wms.stock.moved for that movement with the given correlation_id
    And platform.audit_log has one row (wms, stock_movements, that record_id, insert) with the same correlation_id
    And wms.verify_balance_integrity() returns zero rows
  Scenario: the ledger cannot be edited (append-only)
    Given a non-superuser, NOBYPASSRLS role with select and insert on wms.stock_movements
    When that role updates the receipt row's qty / deletes the receipt row
    Then both statements fail with SQLSTATE 42501
    And the row is unchanged
  Scenario: a zero quantity is rejected before the database
    When postMovement is called with qty 0 (and again with a negative qty)
    Then InvalidQuantityError is thrown
    And no ledger row, no outbox row and no audit row were written
  Scenario: a movement that would make stock negative is rejected atomically
    Given on-hand 12.500 at L1
    When postMovement posts a pick of 20.000 from L1
    Then NegativeStockError is thrown
    And on-hand at L1 is still 12.500
    And no ledger row / outbox row / audit row exists for that attempt
  Scenario: a transfer moves stock between locations as two single-sided rows
    When postTransfer moves 5.000 from L1 to L2
    Then two ledger rows exist (out at L1, in at L2), both transfer, same correlation_id
    And on-hand is 7.500 at L1 and 5.000 at L2
    And wms.verify_balance_integrity() returns zero rows
  Scenario: a reversal is a counter-entry, never an edit
    When reverseMovement is called for the transfer's in-row at L2
    Then one adjust row exists with from_location_id L2, qty 5.000, ref_table wms.stock_movements, ref_id the original, reason_code reversal
    And the original row is unchanged
    And on-hand at L2 is 0.000
    And reverseMovement for a random unknown id throws MovementNotFoundError
  Scenario: the guard detects any deviation and the balance is rebuildable
    Given the balance row at L1 is tampered (+1.000) directly
    Then wms.verify_balance_integrity() returns exactly one row for (client, sku, L1) with diff −1.000
    When rebuildBalance runs for (client, sku)
    Then wms.verify_balance_integrity() returns zero rows and on-hand at L1 equals the ledger fold
  Scenario: 1,000 random movements under concurrency leave zero rows (doc 38 acceptance, verbatim)
    Given a printed fast-check seed and ≥ 3 SKUs × ≥ 5 locations
    When 1,000 random movements (decisions 1–5) are posted with ≥ 20 in flight
    Then every rejection is a NegativeStockError (counted) and no other error occurred
    And wms.verify_balance_integrity() returns zero rows
    And for every fixture (client, sku, location, batch) qty_on_hand equals deriveBalances(ledger rows)
  Scenario: G1 stays green after the suite
    Then select count(*) from wms.verify_balance_integrity() = 0 (whole table)

## Property tests (fast-check, pure domain — modules/wms/tests/unit/stock-ledger.domain.test.ts)
- deriveBalances is permutation-invariant (any order of the same entries → the same map).
- Conservation: for any base entry and any (from, to), deriveBalances(planTransfer(...)) sums to zero per (client, sku, batch).
- Cancellation: deriveBalances([e, planReversal(e)]) is all-zero.
- validateEntry rejects qty ≤ 0, both sides set, neither side set, movementType outside MOVEMENT_TYPES; accepts otherwise.
- Quantity scale: every derived value has ≤ 3 decimals (numeric(14,3)).

## Test rules
- Connect like modules/wms/tests/integration/wh1-setup.test.ts (pg Pool, PG* env, same defaults). Unit tests touch no DB.
- Expected numbers are literals in the test with the decision they come from; nothing is computed from a query except the
  fold that the acceptance itself defines (compare `qty_on_hand` to `deriveBalances(...)` — that IS the invariant).
- Numeric comparisons via `::numeric` equality in SQL or `Quantity.equals`, never JS floats.
- RED first: the suite must fail on `import` (module not found) / on missing behaviour — report the exact failing test names.
  pg-backend then implements until GREEN without touching the tests.
- Run: `pnpm --filter @pg-eos/wms test` · `pnpm --filter @pg-eos/wms typecheck` · `npx eslint modules/wms` · root `pnpm typecheck`,
  `pnpm lint`, `pnpm lint:boundaries` · `pnpm guards:run` · finally `pnpm -w build --force` and `pnpm -w test -- --force`.
- Constraints (CLAUDE.md · AGENT CONSTRAINTS): no any / @ts-ignore / eslint-disable / console.log / magic numbers / fabricated values.

Contract: none (no endpoint in 2.8; the Zod contract arrives with the golden slice's inbound receive).   Screen/Board spec: none.
Migration number: none issued.
Stop-and-ask if: any table/column/rule needed is not in 01 / 13 / 13B / 019 / 40; if the guard function and the schema disagree
in a way decision 1 does not cover; if RLS blocks the mechanism under `isInternal: true`.

## Report back (§5 REPORT format)
RED tests (exact names) · Files changed · Files read outside list · Tests x/y with vitest output · Guards · Open questions · Model · Tokens.
