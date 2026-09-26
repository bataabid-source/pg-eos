-- 0028_2_chart-of-accounts.sql — Lane 2 — WBS 4.1a (part 1). Forward-only, idempotent (apply.sh
-- re-runs every file on every apply).
--
-- SCR-ACC-01 #1 (01:1181): CHECK on billing.gl_accounts.code for X-XX-XXX-XXX, class 1-9 from the
-- first segment. SCR-ACC-01 #2 (docs/notes/SCR-ACC-01-accounting-core.md:17, 01:1183): CHECK on
-- billing.gl_accounts.account_type restricted to the existing 5 (asset/liability/equity/revenue/
-- expense) plus 4 new values named verbatim by SCR-ACC-01 #2 — "Values for Cost of Revenue, Other
-- Income/Expense, Tax, Control/Memorandum" — spelled cost_of_revenue/other_income_expense/tax/
-- control_memorandum, snake_case matching the existing 5's lower-case style (pre-migration review
-- round 1, confirmed against 01:1183 and doc 06 §6 lines 149-159, which names no mapping of its
-- own — D3 OD-10 "Adopt the spec format"). No new column — no identity.column_classification row
-- (0002 already classified every existing billing.gl_accounts column; G6 confirmed green on
-- pgeos_lane2). RLS unchanged — billing.gl_accounts is already in platform.is_reference_table
-- (13B:3078); reference_read/reference_write apply generically, no new policy.
--
-- WITHDRAWN (pre-migration review round 2, findings 2/3; Master ruling): this migration originally
-- also seeded identity.role_permissions (platform.reference.manage -> SYSADMIN). Withdrawn — that
-- permission governs reference_write on every reference table (identity.roles, .permissions,
-- .role_permissions, .sod_rules, platform.approval_chains, .thresholds, .feature_flags, not only
-- billing.gl_accounts), so the grant would let SYSADMIN escalate its own role with no second
-- approver, against doc 22:186. The cited source (SCR-ACC-01 row 29) was also mis-applied: that row
-- asks for new identity.roles seed ROWS, not a role_permissions GRANT. WBS 4.1a part 1 therefore
-- ships the two CHECK constraints only — no write path for billing.gl_accounts exists yet (no
-- caller, no permission model). Part 2 (open, MASTER_BACKLOG) designs a narrow
-- billing.gl_accounts.manage permission with its own policy, four-eyes per doc 22:186, and a real
-- caller identity for the audit row.
--
-- pg-reviewer pre-migration review: round 1 FAIL(10 findings) -> fixed (3,5,6,7 test-only; 8-10
-- recorded as defaults) -> round 2 FAIL(8: findings 1/2/6 non-splittable/blocking, write path and
-- SYSADMIN grant withdrawn and deferred to part 2; findings 4/5/7/8 mechanical, closed in part 1's
-- own commit) -> PASS on the part-1 subset (domain invariants + contract + these two CHECKs only).

begin;

alter table billing.gl_accounts drop constraint if exists chk_gl_accounts_code_format;
alter table billing.gl_accounts add constraint chk_gl_accounts_code_format
  check (code ~ '^[1-9]-[0-9]{2}-[0-9]{3}-[0-9]{3}$');

alter table billing.gl_accounts drop constraint if exists chk_gl_accounts_account_type;
alter table billing.gl_accounts add constraint chk_gl_accounts_account_type
  check (account_type in (
    'asset', 'liability', 'equity', 'revenue', 'expense',
    'cost_of_revenue', 'other_income_expense', 'tax', 'control_memorandum'
  ));

commit;
