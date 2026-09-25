# MIGRATION-REQUEST-1 — lane 1

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | catalog | `price-lists-version` | (applied — 0013) | 2026-09-24 | 0013 |
| 2 | sales | `quotes-version` | (applied — 0017) | 2026-09-25 | 0017 |
| 3 | sales | `contracts-version` | (applied — 0019) | 2026-09-25 | 0019 |
| 4 | sales | `accounts-version` | (applied — 0020) | 2026-09-25 | 0020 |
| 5 | sales | `accounts-internal-write-policy` | (applied — 0021, D-177) | 2026-09-25 | 0021 |
| 6 | wms | `outbound-orders-version` | ~~WITHDRAWN 2026-09-25 (pg-reviewer pre-migration FAIL, finding 3)~~ — `wms.outbound_orders.version` already exists, added by 13B-Schema-Reference-Consolidation.sql lines 164-166 (`alter table ... add column if not exists`, same statement 0008/0013/0017/0019/0020 all cite as precedent — this row duplicated a column 13B already carries). Number 0022 is returned to the Master, unused; no `database/migrations/0022_*` file is written. | 2026-09-25 | 0022 issued, then withdrawn — returned unused |
| 7 | sales | `contract-sku-limits` | `sales.contract_sku_limits` (id, entity_id, contract_id, sku_id, max_order_qty, version, audit columns) + `unique (contract_id, sku_id)` + `entity_scope` RLS + `identity.column_classification` rows — WBS 2.11 part 5's condition 10, GM ruling D-189 (SCR-WMS-OUT-02 §6). RED test paths: `modules/wms/tests/process-outbound/process-outbound.test.ts` (condition-10 integration tests), `modules/wms/tests/process-outbound/invariants.property.test.ts` (condition-10 property test) — named here once pg-tester writes them, per D-179. | 2026-09-26 | 0026 issued (D-189) |
