# SC-01 — Sales commission activation (SCR-SC-01)

**Status: WAITING_GM** — staged task, not in doc 38 v4.0. The model and rates are the GM's decision (BOOTSTRAP-v5 §1 item 4; PROJECT-SETUP-GUIDE §10).

| field | value |
|---|---|
| Proposed WBS id | SC-01 (cross-cutting; earliest Phase 4, after 4.9) |
| Module / lock | `hr` + `sales` |
| Default lane | 2 |
| Type | 🤖 after the GM fixes the model and the rates |

## Objective
Turn a collection, a credit note or a signed contract into a sales-commission entitlement for the owning account manager, split by the ownership history of the account, capped and windowed by the declared thresholds, and settled in a monthly statement the representative can dispute inside the dispute window.

## Source D-blueprint (binding for screens, boards and KPIs)
`docs/package/D-blueprints/14-Sales-Compensation.md` — §1 the compensation models compared · §2 the calculation rules at programmable precision · §3 the worked numeric examples · §4 the minimum schema additions · §5 the workflow · §6 the representative board and the manager board · §7 the KPIs · §8 the decisions the GM owes.

## Schema already present in 13B?
**Yes.** `hr.sales_commission_events` (entitlement per collection / credit note / contract — SCR-SC-01) · `hr.commission_rules` · `hr.commission_daily` · `sales.account_ownership_history` (dated account ownership, the basis of the split when an account moves) · the `SCM` document series in `platform.counters` · the `sales.commission.*` rows in `platform.thresholds` (rates per family, split on sign / on execute, duration, caps, minimum margin, manager override, collection window, dispute window) · the `hr.commission.read_all` permission. **The values in `platform.thresholds` are provisional and carry that label until the GM decides.**

## Acceptance criterion
For a contract signed by one representative and later executed while the account belongs to another, the monthly run produces `hr.sales_commission_events` rows that split by `sales.account_ownership_history` exactly as D-14 §3 computes them, honour the cap and the minimum-margin rule, reverse correctly on a credit note, and expose the statement only to the representative, SALES_MGR, CFO and GM (`hr.commission.read_all`) — with G2, G11 and G14 green and no number written outside `platform.thresholds`.

## Dependencies
4.9 (collections in the ledger) · 2.x sales contracts slice · **the GM's decision on the compensation model and its rates** (D-14 §8; listed in PROJECT-SETUP-GUIDE §10 as a pre-Phase-1 decision).

## Decision the GM owes before this starts
D-14 §8: the model, the four family rates, the sign/execute split, the monthly cap and the dispute window. Until each is recorded in EXECUTION-MASTER-v4 Part 1, the provisional `platform.thresholds` values stand and this task stays WAITING_GM.
