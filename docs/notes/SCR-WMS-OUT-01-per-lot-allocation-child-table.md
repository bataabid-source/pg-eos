# SCR-WMS-OUT-01 — no per-lot allocation record for a line split across multiple lots (G-01 schema-change request)

**Status:** filed 2026-09-25 by lane 1 (WBS 2.11 part 2, `Allocate`), on the Master's ruling after pg-reviewer round 1 found that releasing an over-multi-lot line on `CancelOutbound` could corrupt `wms.stock_balance.qty_allocated`. Not built this slice — the Master ruled the workaround out on doc 40 §A1 principles P2 ("Single source of truth; derivation allowed, duplication forbidden") and P3 ("Ledgers (stock, financial, payroll, audit) are append-only; corrections by counter-entry") — a command deriving operational allocation state from the audit log would duplicate the ledger and treat an append-only chain as a queryable source of truth — and on §B2 (the audit log is written through the sanitizer and carries its own retention schedule, not a live operational table a command reads for state) — and directed a structural single-lot rule instead (below). This request is deferred, no migration attached.

## 1 · The gap

`wms.order_lines` carries exactly ONE `(location_id, batch_no)` pair per line (`01-Data-Model.sql:786-787`). No table in 01/13/13B/019 records which specific `wms.stock_balance` lots (and how much of each) contributed to satisfying one order line's allocation. `Allocate`'s FEFO/FIFO/LIFO logic can, in principle, need to draw from more than one lot to satisfy a single line's `qty_ordered` — the schema has no way to remember that split once it happens.

## 2 · Why it matters (found while building 2.11 part 2)

`CancelOutbound`'s release-on-cancel step (part 2's own extension, releasing an allocated order back to `cancelled`) must reverse exactly what `Allocate` reserved, per lot. Without a per-lot record, a release can only act on the single `(location_id, batch_no)` the line happens to carry — which is correct only when the line was genuinely satisfied from one lot. A multi-lot split would make a release either under-reverse (leaking a permanent reservation on the un-recorded lot) or over-reverse (driving the recorded lot's `qty_allocated` negative), both silent data corruption with no DB constraint to catch it (`wms.stock_balance` only checks `qty_on_hand >= 0`, not `qty_allocated`).

## 3 · This slice's mitigation (not a fix — a scope narrowing)

Per the Master's ruling, `Allocate` for 2.11 part 2 is defined to **never split one line across two lots**: FEFO/FIFO/LIFO picks the first lot (in policy order) whose `qty_available` covers the line's entire `qty_ordered`; if none does, the best single lot (same policy order, first with `qty_available > 0`) takes `min(available, ordered)` — the line goes `'partial'`, the remainder is left unallocated, never drawn from a second lot. This makes the single recorded `(location_id, batch_no)` always correct and the release step always exact — the bug class this SCR describes cannot occur under this slice's behavior. It is a real product-capability narrowing, not merely an implementation shortcut: an order whose single largest lot can't cover a line will show a smaller partial allocation than a multi-lot-aware allocator could achieve, even when the SUM across all of that SKU's lots would have been enough.

## 4 · Proposed schema change (future, not this slice)

A child table, e.g. `wms.outbound_allocation_lots` (`id`, `order_line_id` → `wms.order_lines`, `stock_balance_id` → `wms.stock_balance`, `qty` numeric(14,3), `created_at`), one row per lot actually consumed for a line — would let `Allocate` draw from multiple lots per line and let `CancelOutbound`'s release step reverse each row exactly. Needs: RLS policy (mirrors `order_lines`' own scope), `identity.column_classification` rows, and a migration reviewed the same way every RLS/schema-touching change is (mandatory pre-migration pg-reviewer PASS). Not filed as a migration here — this SCR only records the gap and the decision to defer it; a future WBS task (2.12 or later, whichever picks up multi-lot allocation) files the actual migration when it's scheduled.

**Requested together with the child table**: a DB CHECK on `wms.stock_balance` backing `0 <= qty_allocated AND qty_allocated <= qty_on_hand` — today this invariant is enforced in domain/ only, no constraint catches a bad write at the row. Same class of gap as the `wms.space_reservations.qty > 0` item already recorded in PROJECT_STATE. Both belong in the same future migration.

## 5 · Disposition

Recorded, not built. `Allocate`'s single-lot rule (§3) is the accepted mitigation for 2.11 part 2. Re-open this SCR if a future WBS task needs genuine multi-lot allocation.
