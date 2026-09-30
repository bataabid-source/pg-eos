# MIGRATION-REQUEST — lane 1

Number issued by the Master M15 on 2026-09-30 (GM decision D-211, issue #207 07:45Z; brief `docs/notes/slice-briefs/_slice-2.9-p3-s2-qrt-quarantine.brief.md`). One row per migration; the RED test paths must exist before the file (lane-guard.sh refuses the file otherwise); pre-migration review is part of the pre-build pass.

| number | module | slug | purpose | RED tests |
|---|---|---|---|---|
| 0047 | wms | quarantine-decision-chain-threshold | 2.9 part 3 step 2 (D-211): data only — `platform.approval_chains ('quarantine_decision', 1, 'SALES_MGR')` and `platform.thresholds ('wms.quarantine.decision_due_hours', 48, 'hours')`, both `on conflict do nothing`, all-zero system `changed_by` (precedent 0045); no DDL, no RLS change | `modules/wms/tests/receive-inbound/quarantine.test.ts` · `tests/scenarios/migration-0047.spec.ts` |
