# SLICE BRIEF — WBS 2.16 part 1a-8 · identity.sessions / identity.otp_codes writes behind definer functions

Task: 2.16 part 1a-8 (MASTER_BACKLOG) = SCR-IDENTITY-RLS-01 delta 2 (sessions, otp_codes)      Lane: M (M-core, ADR-0007)      Lock: `packages/identity | M` + `identity | M` (held since 2026-09-28 for 2.16)
builder: pg-builder-core
Session: M-core successor (`pg-eos:core`, session_011PL2MhC8UPwG79YDwDqjAK), branch `core/2.16-1a-8` from origin/main `783acd3`.
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED, BEFORE the migration) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (backlog row 2.16 part 1a-8, verbatim)
"`pgeos_app` cannot insert/update/delete `identity.sessions` / `identity.otp_codes` directly; OTP + session tests stay green"

## Facts (verified by M-core on the live schema, `pgeos` @ 783acd3)
- Both tables carry ONE policy, `internal_only for all using (platform.is_internal())` (13B generator, `13B:3088-3145` branch ②); `pgeos_app` holds SELECT/INSERT/UPDATE/DELETE on both. No `entity_id` on either (01:277-296).
- Every production write is in `packages/identity/src/`: `otp.ts:266` (consume earlier live codes on issue) + `otp.ts:276` (insert) · `otp.ts:420` (attempts += 1 on live candidates) · `otp.ts:428` (consume matched) · `session.ts:119` (insert) · `session.ts:273` (revoke). All run under `INTERNAL_NO_ACTOR_CTX` (userId null — pre-auth, so `current_user_id()` cannot gate them). No other writer outside tests.
- Tests clean up/force rows via a separate `pg.Pool` as `PGUSER ?? 'postgres'` (superuser) — unaffected by this slice.
- `database/schema/apply.sh` applies 01 → 13 → 13B → 019 → migrations, so a migration may replace the 13B-generated policy.

## Decisions (defaults — one CHANGELOG line each)
1. **Migration 0044** (`database/migrations/0044_M_identity-write-definers.sql`): on both tables `drop policy internal_only`; `create policy internal_read for select using (platform.is_internal())`; NO insert/update/delete policy; `revoke insert, update, delete on identity.sessions, identity.otp_codes from pgeos_app` (defence in depth: a direct write fails with 42501, it is not silently filtered). Idempotent (`drop policy if exists`, `create or replace function`), forward-only, no data change, ends with a do-block self-check (as 0043).
2. **Five SECURITY DEFINER functions** in schema `identity`, each `language plpgsql volatile security definer set search_path = pg_catalog, pg_temp`, fully schema-qualified body, first statement `if not platform.is_internal() then raise exception … using errcode = '42501'`, `revoke all … from public`, `grant execute … to pgeos_app`. One function per existing write, the SQL moved verbatim — no rule moves from TS to SQL (thresholds, resend window, lockout stay in `otp.ts`):
   - `identity.otp_issue(p_email text, p_code_hash text, p_issued_at timestamptz, p_expires_at timestamptz) returns uuid` — the `otp.ts:266` update then the `otp.ts:276` insert, one call (atomic).
   - `identity.otp_record_failure(p_ids uuid[]) returns void` — `otp.ts:420`.
   - `identity.otp_consume(p_id uuid, p_at timestamptz) returns void` — `otp.ts:428`.
   - `identity.session_issue(p_user_id uuid, p_token_hash text, p_issued_at timestamptz, p_expires_at timestamptz) returns uuid` — `session.ts:119`.
   - `identity.session_revoke(p_id uuid, p_at timestamptz) returns void` — `session.ts:273` (keeps `and revoked_at is null`).
   The hashes are computed in TS as today (the HMAC key never reaches SQL). Public TS signatures of `otp.ts` / `session.ts` do not change.
3. **Schema parity:** `database/schema/*` is NOT edited — the 13B generator stays the base, 0044 is the delta (0042 precedent; 01 has no text for either policy). The SCR row 2 gets "sessions/otp_codes applied by 0044; users → 1a-9".
4. Reads (`select` on both tables in otp.ts / session.ts) stay direct under `internal_read`.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/identity.brief.md`
- `packages/identity/src/otp.ts` lines 180-435
- `packages/identity/src/session.ts` lines 90-279
- `database/schema/01-Data-Model.sql` lines 277-296
- `database/schema/13B-Schema-Reference-Consolidation.sql` lines 3088-3145
- `database/migrations/0043_M_has-perm-search-path.sql`
- `modules/identity/tests/integration/has-perm-search-path.test.ts`

Write ONLY: `packages/identity/src/{otp,session}.ts` · `database/migrations/0044_M_identity-write-definers.sql` + its `database/migrations/README.md` line · `tasks/backlog/MIGRATION-REQUEST-M.md` (0044 row, Master-issued) · `modules/identity/tests/**` + `packages/identity/tests/**` (pg-tester only). Never CLAUDE.md, `apps/**`, `database/schema/*`.
Contract: none (no endpoint changes). Screen/Board spec: none.

## RED tests (before the migration file — lane-guard)
`modules/identity/tests/identity-write-definers.feature` · `modules/identity/tests/integration/identity-write-definers.test.ts`

```gherkin
Feature: identity.sessions and identity.otp_codes are written only through definer functions (WBS 2.16 part 1a-8)
  Scenario: pgeos_app cannot insert, update or delete identity.sessions directly (42501)
  Scenario: pgeos_app cannot insert, update or delete identity.otp_codes directly (42501)
  Scenario: pgeos_app can still select both tables in an internal context
  Scenario: Each of the five identity write functions is SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp and is not executable by PUBLIC
  Scenario: Each write function refuses a non-internal context (42501)
  Scenario: The OTP issue → verify → session issue → revoke flow still succeeds as pgeos_app through withContext
  Scenario: A wrong code still increments attempts on every live candidate; a new request still consumes the earlier live code
```
Existing OTP + session + G-16a + deadlock/tx-injectable tests are the regression set and must stay green unedited.

Deliver: migration 0044 · edited `otp.ts` / `session.ts` (each write → `select identity.<fn>(…)`) · the RED files · identity package + module tests, isolation (G14) and `G16_MODULES=identity pnpm guards:run` green on a fresh DB (`createdb -T template0 pgeos_rN && PGDATABASE=pgeos_rN bash database/schema/apply.sh --no-guards`).
Migration number: **0044 — issued to lane M by Master M7, 2026-09-29.**

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40, a permission code would be needed (delta 1/3 → G-01, 1a-9), or a guard assumes the `internal_only` policy name on these tables — STOP and report.
