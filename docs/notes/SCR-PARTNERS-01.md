# SCR-PARTNERS-01 — `partners.partner_invoices.status` has no `variance_review` value (doc 40 Part E S18 vs 13B CHECK)

Filed by the integration lane, 2026-09-27, while writing `tests/scenarios/S18.spec.ts` (CLAUDE.md ·
ARCHITECTURE: a rule outside 01 / 13 / 13B / 019 / 40 is filed, never invented). Open item — the GM
or the Master decides; the spec asserts only the schema-legal state until then.

## The gap

| Source | Says |
|---|---|
| doc 40 Part E, feature S18 line 579 | `Then the invoice status is variance_review and payment is frozen` |
| doc 40 §C6 line 324 | `partner_invoices` (auto-match; variance ≤ `thresholds.partner.match_tolerance_pct` auto-approve; else freeze + Decision item; line without our event → rejected) |
| 13B, live CHECK on `partners.partner_invoices.status` | `received · matched · frozen · approved · paid · rejected` |

`variance_review` is not a legal status. The state doc 40 §C6 describes for the same situation
("freeze + Decision item") exists as `frozen`. The scenario's numbers also do not close: one
payable event of 200 × 1.800 = 360.000 cannot produce `matched 7,900` — S18 reuses the monthly
totals of S20 (doc 12 س20, doc 40 lines 605-608).

## What the spec asserts meanwhile (S18, last step)

`matched_amount = 7900.000`, `variance_amount = 500.000`, `variance_pct` above
`platform.thresholds` `partner.match_tolerance_pct`, `status = 'frozen'`, nothing paid, and one
`platform.decisions` row for the invoice. All RED until row 4.15 (invoice matching) is built.

## Decision requested (one of)

1. Amend doc 40 line 579 to the schema's `frozen` (+ Decision item) — no schema change; or
2. Add `variance_review` to the CHECK (migration, Master-numbered) and define its transition from
   `received` and into `frozen`/`approved`/`rejected`; or
3. Keep both: `variance_review` as the Decision-item state, `frozen` as the payment state — then
   the two are different columns/rows and doc 40 line 579 needs rewording.

Resolved when the chosen option lands; the resolving commit deletes this note.
