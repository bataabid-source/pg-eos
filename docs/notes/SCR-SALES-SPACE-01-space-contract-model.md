# SCR-SALES-SPACE-01 — space-contract model: fixed vs variable, weekly/monthly round-up, reservations only from signed contracts (D-141 Q4 · D-165 Q1)

**Status: APPROVED — GM D-165 (2026-09-24), sheet 5 Q1 = أ.** Raised under EXECUTION-MASTER-v4 §1.11 (G-01), criterion (iii): a GM rule not modelled. Nothing in `database/schema/*` or `database/migrations/*` is touched by this note; DDL after pg-reviewer's pre-migration review, with WBS 1.3/1.4 (contracts) or the first storage-billing slice (Phase 4), whichever comes first.

## 1. The GM rule (D-141 Q4, verbatim)
> حسب التعاقد. أنواع التعاقد: مساحة ثابتة: سواء أشغلها أو لم يشغلها · مساحات متغيرة: حسب الإشغال. طرق المحاسبة: إيجار أسبوعي ولا يحسب كسور الأيام (تجبر لأسبوع) · الحساب الشهري: يحاسب بالشهر كامل ولا يجبر أيام الشهر (يجبر الشهر). عروض الأسعار لا تحجز أي مساحة على النظام إلا إذا تم التعاقد فعلياً.

## 2. Shapes
- `sales.contracts.space_model text not null default 'variable'` — check `fixed · variable`.
- `sales.contracts.billing_period text not null default 'monthly'` — check `weekly · monthly`.
- `sales.contracts.contracted_space_qty numeric(14,3)` + `contracted_space_uom` (`pallet · position · sqm · cbm`, must match the block-type → ST map of D-141 Q5) — the quantity billed on a **fixed** contract every period regardless of occupancy.
- Rounding rule in the storage-billing job (Phase 4): weekly → any started week bills a full week; monthly → any started month bills a full month. Constants in `platform.thresholds` (`space.round_up = true`, no partial periods).
- `wms.space_reservations`: add `contract_id not null` (today nullable, created from opportunities/quotes); a reservation row can exist only for a signed contract (`sales.contracts.status = 'active'`), enforced by a check + trigger. Quotes carry a **non-reserving** `requested_space_qty` on `sales.quotes` for capacity planning only (no effect on `wms.space_availability()`).
- **ST-14** stays in the catalog (92 unchanged) but is billable **only on variable contracts** that carry the clause (`bills_reserved_unused = true`); on fixed contracts it is never generated (the contracted quantity is billed instead). EXEC §1.1 "mandatory clause in every storage contract" → **superseded for fixed contracts** by D-165 (documentary correction in EXEC-v4 §1.1 and doc 17 §7, next documentary commit).
- Event `sales.contract.space_terms_changed` (module sales) when any of the four columns change.

## 3. Superseded text
EXEC-v4 §1.1 (ST-14 mandatory), doc 17 §7 (ST-14 source = reservations), D-13 §8-3 (Gap #72), doc 04 ST-14 row note — all annotated in the next documentary pass.
