Task: 3.13 Commission engine — part 1, `CalculateDailyCommission` (doc 38, owner HR_MGR, deps 3.12)
Lane: 3          Lock: hr (NEW whole-module lock — first hr work by lane 3; request via the Master before pg-tester starts)
Read ONLY:
  - CLAUDE.md
  - .claude/briefs/hr.brief.md (confirms live: `hr.commission_daily` RLS = `own_commission` ONLY — no write policy; `hr.commission_rules` RLS = `entity_scope`; status/check-constraint value lists)
  - .claude/briefs/imile.brief.md (driver_ids/driver_id_assignments/shipments tables and the `shipments_attributed` view pointer)
  - modules/hr/application/register-employee/{ports.ts,register-employee.ts} (nearest own-module precedent: idempotency-first ordering, audit-row pattern, typed-error mapping, entity resolution from ctx)
  - modules/wms/infrastructure/process-outbound/repository.ts lines 245-280 (`getContractCheck` — the established cross-schema READ-ONLY pattern: a `.ts` function issuing a plain SQL read against another module's schema, no TypeScript import across `modules/`, precedent cited by the Master for exactly this kind of read)
  - database/schema/13-Schema-Additions.sql lines 281-389 (`imile.driver_ids`, `imile.driver_id_assignments`, the `imile.shipments_attributed` VIEW — "المصدر الوحيد لنسب الشحنة لسائق. أي انضمام مباشر بـ driver_code يُحتسب خطأ حرجاً في مراجعة الشيفرة" / "the ONLY allowed view for attributing a shipment to a human driver — any direct join on driver_code is a critical review error" — THIS is doc 38's "Attribution through assignment table only" acceptance criterion, verbatim), `imile.verify_attribution()`, `hr.commission_rules`, `hr.commission_daily` (original shape))
  - database/schema/13B-Schema-Reference-Consolidation.sql lines 2035-2040 (commission_daily's four `deduction_*` columns, not used by this slice — deductions/disputes are part 2), 2449-2451 (`chk_commission_daily_status`: calculated · disputed · approved · paid — this slice only ever inserts `calculated`), 4990-5044 (`hr.commission_rules` generalized for sales commission too — `chk_commission_rules_driver_shape`: `applies_to <> 'driver' or (basis = 'per_unit' and rate_per_unit is not null)` — THIS slice reads driver rules only: `applies_to = 'driver'`, guaranteeing `rate_per_unit` is set; `chk_commission_rules_valid_window`: `valid_to is null or valid_to > valid_from`)

P7 budget: 8 files, 688 lines — at the ceiling, no further Read ONLY growth without trimming (`brief-check.sh` confirmed). **Review cap (CLAUDE.md · OPERATING RULES): round 1 FAIL → one fix round → round 2. Round 2 FAIL → STOP, commit only the PASS subset, every open finding becomes a `3.13 part 2` row — no round 3, no opus escalation unless a finding is genuinely unsplittable (security/audit-chain/RLS) and is the last round.**

**Migration 0027 issued by the Master (2026-09-26)** for the not-yet-existing file `0027_3_commission-daily-rls-version` under `database/migrations/`, precedent SCR-SALES-ACCT-01 / migration 0021, pre-migration pg-reviewer review mandatory before the file is written, RED test paths named in the lane's own migration-request row before the file exists (lane-guard enforced). Three fixes on `hr.commission_daily`, confirmed live by both this lane and the Master independently against `pg_policies`:
1. **No write policy at all** (only `own_commission`, `FOR SELECT`) — add internal-only `INSERT` and `UPDATE` policies, entity-scoped: `platform.is_internal() and entity_id = any(platform.allowed_entities())` in both `USING` and `WITH CHECK`.
2. **The existing `own_commission` SELECT policy is not entity-scoped** — a `hr.commission.read_all` holder can see every entity's rows, not just their own entity's. Recreate `own_commission` under the same name, AND-ing `entity_id = any(platform.allowed_entities())` onto the existing `has_perm(...) OR own-employee-row` condition, keeping the own-row branch intact.
3. **No `version` column** despite being a mutable aggregate (status lifecycle `calculated → disputed → approved → paid`, 48-h dispute in part 2) — add `version int not null default 1` + its `identity.column_classification` row. This slice's own INSERT sets `version` at its column default (1); no UPDATE happens in part 1, so no optimistic-lock check is exercised here — part 2 (dispute/confirm) is where `version` starts mattering.
**RED tests are expected to fail on the pre-migration RLS gap until 0027 lands — that is the correct, intentional RED state, not a test defect.** Do not invent a policy in application code or bypass RLS to work around it.

**Scope decision, read before objecting to anything "missing":** doc 38's row bundles three things — daily calculation, frozen snapshot, and 48-hour dispute window. This part 1 delivers ONLY the calculation + frozen snapshot: one command, `CalculateDailyCommission`, that computes and inserts ONE `hr.commission_daily` row (status always `calculated`) for one `(employeeId, workDate)` pair. Dispute (`DisputeCommission`, within 48h of `created_at`), confirm/approve, and the payroll-period linkage are a SEPARATE part 2 — same P7 split pattern as every other multi-facet doc-38 row this session (3.1, 3.12, 4.2, 5.13). Part 1's own acceptance is fully self-contained and testable: "Attribution through assignment table only" is proven by reading exclusively from `imile.shipments_attributed`, never joining `imile.shipments.driver_code` directly in any new code.

**Defaults taken (recorded here, batched to CHANGELOG, not invented business rules beyond the package):**
1. **Rule selection:** among `hr.commission_rules` rows where `applies_to = 'driver'`, `entity_id` = the caller's resolved entity, `valid_from <= workDate` and (`valid_to is null or valid_to >= workDate`), and the day's `delivered_count` falls in `[tier_from, tier_to)` (`tier_to is null` = open-ended top tier) — this slice ONLY considers rows where `client_id is null` (a generic, not client-specific, driver rate). A client-specific driver commission rule (`client_id` not null) is OUT OF SCOPE this part — nothing in doc 38's 3.13 acceptance names client-specific driver rates, and `imile.shipments_attributed` carries no `client_id` column to match against anyway (shipments carry `merchant`/`zone_code`, not a `sales.accounts` foreign key) — filed as an open question in the closing report, not invented.
2. **Zero or multiple matching rules:** zero matching rules → typed `NoApplicableCommissionRuleError` (422, a data-completeness problem, not a conflict); more than one matching rule for the same tier → typed `AmbiguousCommissionRuleError` (422) — the package does not specify a tie-break and none is invented.
3. **`min_daily` floor:** `gross_commission = greatest(delivered_count * rate_per_unit, coalesce(min_daily, 0))` — `min_daily`'s own column comment/precedent in 13-Schema-Additions.sql implies a per-day minimum guarantee; this is the plain reading of the two columns together, not an invented rule.
4. **No outbox event this slice** — doc 40/38 name no `hr.commission.*` event for the calculation step itself (unlike e.g. `wms.inbound.scheduled`); a commission-calculated event is a future consumer's concern (e.g. payroll WBS 5.6) if one is ever specified — default recorded, not invented.
5. **`driver_id_ref`** on the inserted row is the employee's ACTIVE `imile.driver_id_assignments` row covering `workDate` (if the employee held no active assignment that day — e.g. commission from a prior assignment already closed — `driver_id_ref` stays null; the row is still insertable since shipments were still attributed via the historical assignment row in `shipments_attributed`, which does not require the assignment to be CURRENTLY active, only active AT `ofd_at`).

Write ONLY: modules/hr/{domain,application,infrastructure,api,tests}/calculate-daily-commission/** · modules/hr/index.ts (round-1 review finding 6: the module barrel must re-export this use-case's application layer + errors, same as every other use-case already there — missing from the original Write ONLY list, added here) · packages/contracts/hr/calculate-daily-commission.ts · packages/contracts/package.json (its own export entry, additive) · database/migrations/0027_3_commission-daily-rls-version.sql · database/migrations/README.md (round-2 review finding 7: its applied-range line, bumped 0026→0027, was missing from Write ONLY, added here) · tasks/backlog/MIGRATION-REQUEST-3.md (row 2) · tasks/LANE_LOCKS.md (the new `hr` whole-module lock row, lane 3, + migration 0027 record) · tests/isolation/tests/shipments-attributed-invoker-rls.test.ts · tests/…
Scenario:
```gherkin
Feature: Calculate one employee's frozen daily commission snapshot, attributed only through the assignment table

  Scenario: A driver's delivered shipments for the day produce a calculated commission row
    Given an hr.commission_rules row for this entity, applies_to "driver", tier_from 0, tier_to null, rate_per_unit set, valid window covering today
    And an active imile.driver_id_assignments row for this employee covering today
    And three imile.shipments rows attributed to this employee's driver_id via imile.shipments_attributed, internal_status "delivered", ofd_at today
    When CalculateDailyCommission is called for this employee and today
    Then one hr.commission_daily row is inserted with delivered_count 3, status "calculated", driver_id_ref set to the active assignment's driver_id
    And gross_commission equals 3 times rate_per_unit (or min_daily if greater)
    And source_snapshot and rule_snapshot are both populated
    And one platform.audit_log row is written for the insert

  Scenario: A second calculation for the same employee and day is rejected
    Given an hr.commission_daily row already exists for this employee and today
    When CalculateDailyCommission is called again for the same employee and today
    Then the command fails with a mapped CommissionAlreadyCalculatedError (the DB's own unique (work_date, employee_id) violation, translated) and no new row is written

  Scenario: No applicable commission rule fails clearly
    Given no hr.commission_rules row matches this employee's entity, tier, and valid window for today
    When CalculateDailyCommission is called
    Then the command fails with a mapped NoApplicableCommissionRuleError and no row is written

  Scenario: A shipment attributed via a stale direct driver_code join is never counted — only the assignment-table view is trusted
    Given an imile.shipments row whose driver_code matches a driver_ids row, but that driver_id has NO imile.driver_id_assignments row covering the shipment's ofd_at (a lapsed or never-assigned code)
    When CalculateDailyCommission is called for the employee who currently holds that driver_id (if any) for today
    Then that shipment is NOT counted in delivered_count/failed_count/returned_count (it is invisible through imile.shipments_attributed, same as imile.verify_attribution() would flag it as unattributed)

  Scenario: An outsider (non-internal) cannot trigger a calculation
    Given a non-internal actor
    When CalculateDailyCommission is called
    Then the command is refused and no row is written
```
Contract: packages/contracts/hr/calculate-daily-commission.ts — one command `CalculateDailyCommission`, input `{ employeeId: uuid, workDate: string (date), correlationId: uuid }` — `entityId` resolved from ctx, never caller-supplied (same as register-vehicle/register-employee). Result schema `CalculateDailyCommissionResult { commissionDailyId: uuid, grossCommission: string, deliveredCount: number, failedCount: number, returnedCount: number }`.
Screen/Board spec: none (internal command, no UI this slice — the driver-facing commission view is a future D-blueprint 14 slice)
Deliver (mirrors register-employee's own file set, the nearest single-command precedent in this module):
  - modules/hr/domain/calculate-daily-commission/{errors.ts,invariants.ts} — `invariants.ts` exports the pure tier-match/rule-selection logic (given a list of candidate rule rows + delivered_count, return the one matching rule or a discriminated "none"/"ambiguous" result) — no state machine: this command performs one insert guarded by preconditions, not a dispatched set of transitions (same precedent as RegisterVehicle/AssignDriverId).
  - modules/hr/application/calculate-daily-commission/{index.ts,ports.ts,calculate-daily-commission.ts}
  - modules/hr/infrastructure/calculate-daily-commission/{repository.ts,logger.ts} — repository's cross-schema reads (`imile.shipments_attributed`, `imile.driver_id_assignments`) follow the `getContractCheck` pattern exactly: plain SQL via `tx.execute`, no `modules/imile` TypeScript import.
  - modules/hr/api/calculate-daily-commission/{composition.ts,handlers.ts}
  - modules/hr/tests/calculate-daily-commission/{calculate-daily-commission.feature,calculate-daily-commission.test.ts,invariants.property.test.ts,handlers.test.ts}
  - packages/contracts/hr/calculate-daily-commission.ts
`CommissionAlreadyCalculatedError` (the DB's own `unique (work_date, employee_id)` violation, translated the same way `register-vehicle`'s `DuplicatePlateNoError` translates a unique-violation — 409), `NoApplicableCommissionRuleError` (422 — zero matching rules), `AmbiguousCommissionRuleError` (422 — more than one matching rule, no tie-break specified) are the three typed errors this slice needs.
`version` column present (0027) but not exercised by an optimistic-lock check this slice — insert only, column default `1`. No XState (single guarded insert, same precedent as AssignDriverId/RegisterVehicle).
Audit row: one `platform.audit_log` insert for the `hr.commission_daily` insert, same hash-chain mechanism every prior slice already replicated.
Idempotency-Key required at the API layer, same 400/409/200 shape as every prior slice.
Migration number: **0027** — `database/migrations/0027_3_commission-daily-rls-version.sql`, issued by the Master 2026-09-26 on `tasks/backlog/MIGRATION-REQUEST-3.md` row 2; pre-migration pg-reviewer run mandatory before the file is written; RED test paths named in the request row first (`lane-guard.sh` refuses the migration file until they exist).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40.

**Round-1 review finding 8 (retroactive precedent authorization, same convention as every prior slice's "nearest precedent already authorised by the brief's own language"):** pg-backend/pg-tester additionally read, for structural precedent only — never for new business rules — modules/hr/application/register-employee/{logger.ts,handlers.ts,repository.ts} (isDuplicateEmployeeCode's real location), modules/imile/domain/evaluate-dtl-problem/invariants.ts (pure-function domain style precedent), modules/imile/{application,infrastructure,api,tests}/assign-driver-id/* (the nearest cross-module single-command precedent), packages/domain-kit/money.ts (exact-decimal arithmetic). Listed here rather than added to Read ONLY (already at the 8-file ceiling) — comments in the delivered code must cite these files by their real names/paths, never a fabricated "brief D9" or misattributed CLAUDE.md section (round-1 finding 7).
