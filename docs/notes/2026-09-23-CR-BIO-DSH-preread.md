# CR-BIO-DSH (biometric attendance + role dashboards) — Master pre-read

**Status:** pre-read only. The CR input `docs/notes/CR-BIO-DSH-v3.md` was **absent** when this Task X ran
(2026-09-23, HEAD `f30baf8`). Everything below comes from the repo alone: briefs, doc 38, doc 23, schema
files. Nothing here uses or guesses at the CR's content. Part 1 steps 3–6 (ADR draft, G-01, 38-WBS
insertion, D15/D16, KPI mapping, pg-reviewer) need the CR's §1, §2, §4 and Appendix A, and are **not done**.

## Part 0 — D-122 / D-123 / D-124 (checked, already done in `f30baf8`)

| Decision | Evidence | Re-check today |
|---|---|---|
| D-122 | `.gitattributes` holds `* text=auto eol=lf` · `*.ps1 text eol=crlf` | `git add --renormalize .` → zero staged changes |
| D-123 | SC-01 bound to WBS **1.7** (`docs/package/38-WBS.md:68`); `tasks/MASTER_BACKLOG.md` SC-01 row deps `4.9, 1.7` | the sales-contracts task exists, so no insertion draft is needed |
| D-124 | `docs/notes/2026-09-23-38-wbs-0.6-split-draft.md` (0.6a deps 0.4, lane M, SYSADMIN, acceptance with the six gates, Postgres 16 service container, any red step blocks merge; 0.6b deps 0.5, 0.6a); DECISION_LOG row D-124; CHANGELOG-v4 §20; MASTER_BACKLOG row 0.6 annotated | complete |

## Part 1 step 1 — schema facts from the briefs (`hr.brief.md`, `tms.brief.md`)

- `hr` (14 tables): commission_daily · commission_rules · disciplinary_cases · employee_documents ·
  employees · manpower_requests · org_units · penalty_schedule · recruitment_cases · recruitment_costs ·
  recruitment_stage_log · recruitment_stages · sales_commission_events · teams.
- `tms` (7 tables): contact_log · delivery_exceptions · delivery_tasks · failure_reasons ·
  payment_attempts · proof_of_delivery · routes.
- **No attendance, punch, shift, roster, device or biometric-enrolment table exists in either brief**
  (grep of all 15 briefs for attendance|biometric|shift|clock|timesheet|check_in|device finds only
  `penalty_schedule.category = 'attendance'`).
- Attendance-related schema outside the briefs:
  - `platform.integration_runs.integration` accepts `'biometric'` (`01-Data-Model.sql:197`).
  - 13B `:2978` reads the last successful `'biometric'` run (freshness).
  - Penalty codes ATT-01…ATT-10 (13B `:2650-2659`); ATT-07 is buddy-punching, ATT-08 is biometric tampering.
  - `biometrics_security` is a recruitment/PRO stage (13B `:1982`). This is residency biometrics, not attendance.
- `employees.status`: active · on_leave · suspended · terminated. No leave table is listed in the brief.
- **Likely gap for G-01 (to confirm against CR §2 Q1–2):** 38-WBS 5.3 promises "attendance from biometrics
  (I-04) … unmatched to manual queue", but the approved schema has **no table** for imported punches or
  the manual match queue. When the CR arrives, raise it through EXECUTION-MASTER-v4 §1.11. Do not touch
  `database/schema/*`.

## Part 1 step 2 — existing doc-38 tasks the CR must fold into (never duplicate)

| WBS | Task (doc 38) | Relevance |
|---|---|---|
| 5.3 | M08 HR: org units, teams, attendance from biometrics (I-04), leaves — acceptance "Attendance auto-imported; unmatched to manual queue" | **direct overlap**: biometric attendance import |
| 5.4 | Biometric credentials entered by GM; hourly sync — "auto-absence disabled until data complete" | **direct overlap**: I-04 sync + gate |
| 0.19 | Admin app shell: navigation, Decision Inbox, empty-state, design system | dashboard/shell overlap |
| 5.14 | M13 Governance: KPI tree, OKRs, board pack | KPI/dashboard overlap |
| 6.1 | Client Portal (separate app): 12 screens, 4 client roles | portal overlap |
| 6.3 | Premium Decisions app: inbox, six KPI cards | role-dashboard / mobile overlap |
| 3.7–3.11 | Driver app (core, contact, payment, custody/earnings, ranking) | mobile field-app shell overlap (APP-1 candidate) |
| 2.16 | PDA app: offline queue 72 h, kiosk, shared-device PIN login | field-app shell overlap |
| 2.17 · X.3 | Grafana board per module | ops dashboards (not role dashboards) |

Binding constraint already in the package (doc 23 I-04, PLT-50): automatic absence and lateness detection stays off
until attendance data is ≥ 95% complete for 30 consecutive days. The flag is in `platform.feature_flags`.
Photos are kept in Firebase and deleted after 60 days. Unmatched punches go to a manual queue and are never
dropped. Any BIO task in the CR must inherit these rules unchanged.

## For the resumed run

- Next ADR number: **ADR-0003** (`docs/adr/`: 0001, 0002 exist) → `docs/adr/ADR-0003-biometric-attendance.md`.
- Resume Part 1 steps 3–6 once `docs/notes/CR-BIO-DSH-v3.md` is present.
