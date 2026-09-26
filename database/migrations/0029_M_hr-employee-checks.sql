-- 0029_M_hr-employee-checks.sql — Master task P6a. Forward-only, idempotent (apply.sh re-runs
-- every file on every apply — each ALTER drops the constraint if it already exists, then adds it
-- back, so a second run produces the identical schema, not an error).
--
-- Sources (never invented, G-01):
--   - doc_type in {residency, passport, license, health_card, contract}: 01-Data-Model.sql:1303's
--     column comment on hr.employee_documents.doc_type (the five documented values).
--   - code ~ '^PG-[0-9]{4}$': 40-Build-Specification-EN.md:328 (doc 40 §C7 "code PG-####").
--   - issue_date is null or issue_date <= expiry_date: no line in 01/13/13B/019/40 states this
--     CHECK explicitly; its authority is SCR-HR-EMP-01 (docs/notes/SCR-HR-EMP-01-employee-checks.md
--     §1 row 1), approved under D-190.
--
-- Prior enforcement (SCR-HR-EMP-01 §1): only issue_date <= expiry_date was already enforced in
-- modules/hr/domain/register-employee/invariants.ts (assertDocumentDatesValid) before this
-- migration. doc_type and code were Zod-only (the hr contract's enum/regex) — domain/ gained
-- assertDocTypeAllowed / assertEmployeeCodeFormat only alongside this migration (Master task P6a),
-- so all three invariants now hold both in domain/ and as a database constraint (doc 36 §5-4 #2).
--
-- Seed impact: none. 019-Warehouse-WH1-Setup.sql seeds no hr.employees / hr.employee_documents
-- rows, and neither does 13B (verified by grep before filing SCR-HR-EMP-01) — the three CHECKs
-- validate on a fresh apply.sh --recreate with no data to correct.
--
-- No column added, no classification change, no RLS change, no audit-chain impact — this
-- migration only adds CHECK constraints to two existing columns of two existing tables.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (7 findings — applied) — plain
-- drop-if-exists-then-add shape, one transaction, matching the 0023 precedent.

begin;

alter table hr.employee_documents drop constraint if exists chk_employee_documents_dates;
alter table hr.employee_documents add constraint chk_employee_documents_dates check (issue_date is null or issue_date <= expiry_date);
alter table hr.employee_documents drop constraint if exists chk_employee_documents_doc_type;
alter table hr.employee_documents add constraint chk_employee_documents_doc_type check (doc_type = any (array['residency','passport','license','health_card','contract']));
alter table hr.employees drop constraint if exists chk_employees_code_format;
alter table hr.employees add constraint chk_employees_code_format check (code ~ '^PG-[0-9]{4}$');

commit;
