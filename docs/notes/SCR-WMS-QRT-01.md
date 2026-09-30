# SCR-WMS-QRT-01 — quarantine of a short-shelf-life receipt: decision owner, due time, hold and release (G-01, open)

Filed by the Master M15 on 2026-09-30 while briefing 2.9 part 3 step 2 (doc 40 Part E S1 scenario 1, lines 433-439). Raised by claude[bot] on PR #228 (findings 3 and 4, round 3): the brief defaulted values that no permitted document carries. CLAUDE.md ARCHITECTURE: missing rule → STOP and file this request, never invent. The brief is withdrawn until the GM answers; the lock `wms | 1 | 2.9` is released.

## What doc 40 asserts (verbatim, lines 433-439)
"Given client "GULF" has active PST contract with min receipt shelf life 180 days / And an approved inbound order for SKU "GULF-0137" / When the PDA receives batch "B2409-7" with expiry 120 days from today / Then the line is placed in zone QRT / And a decision item "quarantine_decision" is created for client contact within 48 h / And no stock_movement to a storage location exists for that batch".

## What the schema requires and no document supplies
`platform.decisions` (13B:440-456): `title_ar text not null`, `context jsonb not null`, `assigned_role text not null`; `platform.approval_chains` (13B:589-597, seed 13B:3938-3947) has no `request_type = 'quarantine_decision'` row, so the precedent `modules/billing/infrastructure/accounting-periods/repository.ts:320-343` (role read from the chain) cannot be reused.

## Questions for the GM (one batch; answer = one CHANGELOG line each or a D-id)
1. **Assigned role** for `quarantine_decision`: which role code (doc 27 role list) — or an `approval_chains` row `('quarantine_decision', 1, <role>)` to be seeded by a numbered migration?
2. **Due time**: "within 48 h" — a named constant citing doc 40 line 438, or a `platform.thresholds` row (key to be named by the GM)?
3. **Title**: the Arabic `title_ar` wording for the item (a DB value, not UI text) — or is `platform.decisions.title_ar` to be derived from a template the GM names?
4. **Hold and release**: while the item is `open`, may put-away move the batch to a storage location? Doc 40 asserts only that no such movement exists in the scenario; it names no refusal, no outcomes (release · return to client · destroy) and no role that decides. Without an answer the slice creates the item and routes to QRT only; nothing blocks or releases the batch.
5. **Rule source**: the minimum is `wms.skus.min_remaining_life_receipt_days` (01:677; the S1 Given reads it) — confirm that no per-contract minimum is intended (none exists in 01 / 13 / 13B).

## Effect
2.9 part 3 step 2 is re-briefed by the Master after the answers (routing to a `zone_type = 'quarantine'` operational location + the decision row, nothing else); S1 steps 3–4 stay RED until then (integration lane 2.18 informed).
