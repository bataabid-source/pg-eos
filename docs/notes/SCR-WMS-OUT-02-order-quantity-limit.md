# SCR-WMS-OUT-02 — no source for "the agreed order limit" (condition 10 of doc-38 row 2.11's ten-condition check, G-01 schema-change request)

**Status:** filed 2026-09-25 by lane 1 (WBS 2.11 part 3 bookkeeping, pg-scribe on the Master's instruction), on review of condition 10 of doc-38 row 2.11's acceptance criterion ("Each of ten conditions has a failing test with the correct message"). Not built this slice — no schema source exists to build it against. Deferred, no migration attached.

## 1 · The gap

Doc-38 row 2.11's acceptance criterion requires all ten conditions of the RunOutboundChecks gate to have a failing test with the correct message. Condition 10 of the ten-condition table — D-blueprint 03 §4.2.1 ("4.2.1 فحص الشروط العشرة قبل الاعتماد"), row 10 — reads:

| # | الشرط | الرسالة عند الفشل |
|---|---|---|
| 10 | الكمية ضمن حد الطلب | «الكمية تتجاوز الحد المتفق [كمية]» |

("quantity within the order limit" / "the quantity exceeds the agreed limit [quantity]"). The same row appears verbatim in `docs/package/03-Workflows.md:359`. This is condition 10 of the same ten-condition table that conditions 1–9 were built against in WBS 2.11 part 1 (`a96b013`).

Building condition 10 requires a **threshold to check the requested quantity against** — "the agreed order limit" — read from somewhere: a column on `sales.contracts`, a column on `wms.outbound_orders` or its lines, a `platform.thresholds` row, or a per-client/per-SKU cap table. No such column, table, or documented threshold exists.

## 2 · Confirmed by three separate searches (not assumed)

1. **Build spec (`docs/package/40-Build-Specification-EN.md`):** `grep -niE "order limit|agreed order|order_limit|qty_limit|quantity_limit"` — zero matches.
2. **D-blueprint 03 (`docs/package/D-blueprints/03-Operations-Warehouse.md`):** the ten-condition table (§4.2.1, row 10 above) states the *rule* and its *message template* but names no column, table, or numeric source for the limit itself — the "القواعد المفروضة برمجياً" (programmatically-enforced rules) table immediately following §4.2.1 lists constraints/triggers for conditions with a DB source (e.g. `chk_outbound_orders_status`) and has no row for condition 10.
3. **Data model / schema docs (`database/schema/01-Data-Model.sql`, `13-Schema-Additions.sql`, `13B-Schema-Reference-Consolidation.sql`, `019-Warehouse-WH1-Setup.sql`):** `grep -niE "order.?limit|qty_limit|quantity_limit|agreed.?order|max_qty|order_cap"` across all four — zero matches. No column on `sales.contracts`, `wms.outbound_orders`, `wms.order_lines`, or `platform.thresholds` carries anything resembling an order quantity cap.

All three searches returned zero matches. The requirement is real (it is condition 10 of the same table that produced conditions 1–9, and its message template is fully specified) but its data source is not documented anywhere in 01/13/13B/019/40.

## 3 · This slice's disposition

WBS 2.11 part 1 (`a96b013`) built conditions 1–9 only; condition 10 was never attempted, not silently dropped. WBS 2.11's doc-38 row is corrected in `tasks/MASTER_BACKLOG.md` and `docs/PROJECT_STATE.md` (2026-09-25 bookkeeping pass) from an earlier "DONE"/"closes WBS 2.11" framing to reflect 9 of 10 conditions built, condition 10 BLOCKED. No test, message, or check for condition 10 exists in `process-outbound.test.ts` or `process-outbound.feature`, and none should be written until §4 below is resolved — writing one would mean inventing the threshold source, forbidden under AGENT CONSTRAINTS ("No table, column, or business rule outside docs 01 / 13 / 13B / 019 / 40. Missing? STOP and file a schema-change request... never invent").

## 4 · What resolves this SCR

Either:
- **(a)** the GM specifies the threshold's source — which table/column carries "the agreed order limit" (per-contract? per-client? per-SKU? a flat `platform.thresholds` value?) — and a migration adds it under the normal pre-migration pg-reviewer gate, followed by the condition-10 test + implementation as a small follow-up slice under the `wms/process-outbound` lock; or
- **(b)** the condition is formally descoped from doc-38 row 2.11's acceptance criterion by the GM, and the acceptance wording is corrected to "nine of ten conditions" (or the ten-condition table in D-blueprint 03 §4.2.1 / `03-Workflows.md` is itself corrected).

## 5 · Disposition

Recorded, not built. Blocks WBS 2.11's own doc-38 row from being marked DONE until (a) or (b) above happens. Not blocking: WBS 2.11 part 4 (the two orphaned `describe` naming items) proceeds independently under the same lock; condition 10 is a separate, parallel open item on the same row.
