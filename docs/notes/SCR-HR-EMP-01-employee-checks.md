# SCR-HR-EMP-01 — three `hr` invariants enforced in `domain/` have no database CHECK

**Status: OPEN — Master / GM decision required** (raised under EXECUTION-MASTER-v4 §1.11, G-01).
Date: 2026-09-24 · Raised by: WBS 3.3 (lane 2) on pg-reviewer finding 6 (doc 36 §5-4 #2: every invariant lives
both in `domain/invariants` and as a database constraint).
Blocks: nothing in 3.3 — the slice ships with the domain-level checks and this request filed; the CHECKs land as a
Master migration (a lane never touches `database/schema/*`, and adding a constraint is a G-01 schema change).

## 1. The three invariants (all already enforced in `modules/hr/domain/register-employee/invariants.ts` and the contract)

| # | invariant | where it is enforced today | proposed CHECK (Master migration, forward-only, idempotent) |
|---|---|---|---|
| 1 | `issue_date <= expiry_date` on `hr.employee_documents` | `DocumentDatesInvalidError` (422) in `invariants.ts`; contract accepts both dates | `alter table hr.employee_documents add constraint chk_employee_documents_dates check (issue_date is null or issue_date <= expiry_date)` |
| 2 | `doc_type` ∈ residency · passport · license · health_card · contract (the five values of the `01-Data-Model.sql:1303` column comment) | Zod enum in `packages/contracts/hr/register-employee.ts` | `alter table hr.employee_documents add constraint chk_employee_documents_doc_type check (doc_type = any (array['residency','passport','license','health_card','contract']))` |
| 3 | `employees.code` matches `^PG-\d{4}$` (doc 40 §C7 "`code PG-####`") | Zod regex in the contract (400 at the boundary) | `alter table hr.employees add constraint chk_employees_code_format check (code ~ '^PG-[0-9]{4}$')` |

Seed impact: `019-Warehouse-WH1-Setup.sql` seeds no `hr.employees` / `hr.employee_documents` rows (verified by grep before filing);
13B seeds none either. The three CHECKs therefore validate on a fresh `apply.sh --recreate` with no data correction.
Pilot synthetic data (D-127) must respect them — the generator is downstream of this request.

## 2. Decision requested

Approve the three CHECKs as one Master migration (`NNNN_M_hr-employee-checks.sql`, pre-migration review by pg-reviewer as
usual), or reject with the value to use instead (e.g. a wider `doc_type` list — the five values are the only ones the
delivered schema documents). Until then the invariants hold at the domain and contract layers only.

## 3. Related open questions (batched to the GM from the 3.3 closing report, not blocking)

- `on_leave` employees are not assignable (brief D5 default) — confirm or allow.
- "Expiring today" counts as valid (bp06 §4.3 KPI: expired ⇔ `expiry_date < current_date`) while the 13B readiness view
  (`13B-Schema-Reference-Consolidation.sql:2269`) counts only `expiry_date > current_date` as documented. The slice follows bp06;
  the view is one day stricter. Align one to the other.
