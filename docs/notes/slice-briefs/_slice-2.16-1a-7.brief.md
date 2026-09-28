# SLICE BRIEF — WBS 2.16 part 1a-7 · SCR-IDENTITY-RLS-01 part 1 — `platform.has_perm` search_path (delta 4)

Task: 2.16 part 1a-7 (proposed row id — Master confirms) = SCR-IDENTITY-RLS-01 delta 4      Lane: M (M-core, ADR-0007)      Lock: `packages/identity | M` + `identity | M`
builder: pg-builder-core
Session: M-core R6 (successor of R3), branch `core/scr-identity-rls-01`. Routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED, BEFORE the migration) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Why this slice is only delta 4 (split before, not after — facts verified on main @ 8a68e79)
- Deltas 1–3 gate on `identity.structure.manage`, `hr.employee.pii.read`, `hr.employee.manage`. None is seeded (`identity.permissions` holds 5 codes: `hr.commission.confirm`, `hr.commission.read_all`, `hr.driver_commission.read_all`, `platform.reference.manage`, `billing.gl_accounts.manage`) and none appears in 01 / 13 / 13B / 019 / 40. `identity.structure.manage` is named only in doc 22 (`22-Master-Data-Governance.md:194`, holders "مدير النظام والمدير العام" → SYSADMIN, GM?), which is not a schema source. SCR §3: a missing code is a second G-01 item, never invented → **GM ruling needed** (parts 1a-8 / 1a-9 below).
- Delta 3 writes RLS on `hr.employees`; `modules/hr/infrastructure/register-employee/repository.ts` reads/writes `civil_id`/`passport_no` — outside this lock (`hr`).
- Delta 2 for `sessions`/`otp_codes` needs no new code but moves every pre-auth write in `packages/identity/src/{otp,session}.ts` (750 lines) behind SECURITY DEFINER functions — its own slice.
- Delta 4 needs nothing new: `platform.has_perm` (01-Data-Model.sql:313-325) is today the ONLY `prosecdef` function in the database without a pinned `search_path` (catalog query, 2026-09-28).

## Decisions (defaults — one CHANGELOG line each)
1. `create or replace function platform.has_perm(p_code text)` with the body byte-identical, adding `set search_path = pg_catalog, pg_temp` — the pin every other definer in this repo uses (0031 `allowed_entities`), not the SCR's `pg_catalog, platform`: the body is fully schema-qualified, and naming `pg_temp` last stops the implicit temp-schema-first lookup. Owner, grants, `stable`, `security definer` unchanged.
2. The schema-file parity edit of `01-Data-Model.sql:313-314` (0031 precedent) is a Master step (database/schema/* is refused to every session by lane-guard).
3. A catalog invariant — zero SECURITY DEFINER functions without `search_path=` in `proconfig`, in every non-system schema — becomes a permanent test so a future definer cannot regress.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/identity.brief.md`
- `database/schema/01-Data-Model.sql` lines 300-330
- `database/migrations/0031_M_active-entity-rls.sql`
- `modules/platform/tests/integration/schema-invariants.test.ts` lines 240-303
- `tests/isolation/tests/hr-commission-confirm-sod.test.ts` lines 1-80

Write ONLY: `database/migrations/<issued>_M_has-perm-search-path.sql` + its `database/migrations/README.md` line · `tests/isolation/tests/**` and `modules/identity/tests/**` (pg-tester only) · `tasks/backlog/MIGRATION-REQUEST-M.md`. Never CLAUDE.md, never `database/schema/*`, never `packages/*` outside `packages/identity`.
Contract: none (no endpoint). Screen/Board spec: none.

## RED tests (before the migration file — lane-guard)
`modules/identity/tests/integration/has-perm-search-path.test.ts` · `modules/identity/tests/has-perm-search-path.feature`

```gherkin
Feature: platform.has_perm runs with a pinned search_path (SCR-IDENTITY-RLS-01 delta 4)
  Scenario: has_perm carries search_path=pg_catalog, pg_temp in proconfig
  Scenario: No SECURITY DEFINER function in the database lacks a pinned search_path
  Scenario: has_perm still returns true for a held permission and false otherwise, under pgeos_app via withContext
  Scenario: A temp-schema object named like has_perm's dependencies cannot change its answer
```

Deliver: migration + README line · the two RED files green · isolation project + `G16_MODULES=identity pnpm guards:run` green.
Migration number: **requested — 0043 is the next free number** (Master issues).

## Follow-up rows (proposed, BLOCKED until the GM rules)
- **2.16 part 1a-8** — delta 2 (sessions, otp_codes): per-command policies + identity definer functions for the pre-auth writes. Needs no new code; after 1a-7.
- **2.16 part 1a-9** — deltas 1 + 2 (users): `identity.grant_role`/`revoke_role` definers gated on `identity.structure.manage` — **G-01: adopt the code from doc 22 §194 and name the holders (SYSADMIN, GM?)**.
- **hr part (lock `hr`)** — delta 3: column-level PII on `hr.employees` — **G-01: `hr.employee.pii.read` / `hr.employee.manage` codes + holders**.

Stop-and-ask if: any table/column/rule/permission code not in 01 / 13 / 13B / 019 / 40.
