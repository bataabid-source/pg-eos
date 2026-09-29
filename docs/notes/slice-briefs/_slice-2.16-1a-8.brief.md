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
1. **Migration 0044** (`database/migrations/0044_M_identity-write-definers.sql`): on both tables `drop policy internal_only`; `create policy internal_read for select using (platform.is_internal())`; NO insert/update/delete policy; `revoke insert, update, delete on identity.sessions, identity.otp_codes from pgeos_app` (defence in depth: a direct write fails with 42501, it is not silently filtered). The header records that `0007:95` re-grants DML on every apply, so the revoke holds only because 0044 runs after 0007 (0010/0038 precedent). Idempotent (`drop policy if exists`, `create or replace function`), forward-only, no data change. It ends with a do-block self-check that raises on any miss:
   - each of the six definers has `prosecdef`, `provolatile = 'v'`, `proconfig = array['search_path=pg_catalog, pg_temp']`, and an owner with `rolsuper or rolbypassrls` (0010:86-94, 0043 pattern);
   - PUBLIC has no EXECUTE on any of them;
   - `has_table_privilege('pgeos_app', t, 'INSERT'|'UPDATE'|'DELETE')` is false on both tables;
   - `pg_policies` holds exactly one row per table: `internal_read`, cmd SELECT, qual `platform.is_internal()`.
2. **Six SECURITY DEFINER functions** in schema `identity`, each `language plpgsql volatile security definer set search_path = pg_catalog, pg_temp`, static SQL only (no EXECUTE/format), fully schema-qualified body, first statement `if not platform.is_internal() then raise exception … using errcode = '42501'`, `revoke all … from public`, `grant execute … to pgeos_app`. One function per existing write or row-locking read, the SQL moved verbatim — no rule moves from TS to SQL (thresholds, resend window, lockout stay in `otp.ts`):
   - `identity.otp_lock_candidates(p_email text, p_at timestamptz, p_max_attempts numeric) returns table(id uuid, code_hash text, user_id uuid, is_active boolean)` — the `otp.ts:380-396` candidate select verbatim, including `order by o.id for update of o` (a row lock needs UPDATE privilege, and under RLS it applies the UPDATE policies too, so it cannot stay direct; the lock lasts until the caller's transaction ends, which keeps the deadlock-regression semantics).
   - `identity.otp_issue(p_email text, p_code_hash text, p_issued_at timestamptz, p_expires_at timestamptz) returns uuid` — the `otp.ts:266` update then the `otp.ts:276` insert, one call (atomic).
   - `identity.otp_record_failure(p_ids uuid[]) returns void` — `otp.ts:420`. Called as `select identity.otp_record_failure(array[${sql.join(ids, sql`, `)}]::uuid[])`: drizzle unwraps a JS array (`otp.ts:414-417`), so never pass one array parameter.
   - `identity.otp_consume(p_id uuid, p_at timestamptz) returns void` — `otp.ts:428`.
   - `identity.session_issue(p_user_id uuid, p_token_hash text, p_issued_at timestamptz, p_expires_at timestamptz) returns uuid` — `session.ts:119`.
   - `identity.session_revoke(p_id uuid, p_at timestamptz) returns void` — `session.ts:273` (keeps `and revoked_at is null`).
   The hashes are computed in TS as today (the HMAC key never reaches SQL). Public TS signatures of `otp.ts` / `session.ts` do not change. Comments naming the `internal_only` policy (`otp.ts:173` and any others in the two files) are updated to `internal_read` plus the definers.
3. **Schema parity:** `database/schema/*` is NOT edited — the 13B generator stays the base (its loop skips a table that already has a policy, `13B:3101-3104`), 0044 is the delta (0042 precedent; 01 has no text for either policy). The M-core session (not a worker) updates SCR row 2 in the closing bookkeeping: "sessions/otp_codes applied by 0044; users → 1a-9".
4. Only plain reads (no locking clause) on both tables in otp.ts / session.ts stay direct under `internal_read`.

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
  Scenario: Each table has exactly one policy, internal_read (SELECT, platform.is_internal()), and an external context reads 0 rows
  Scenario: Each of the six identity functions is SECURITY DEFINER, volatile, owned by a superuser/bypassrls role, returns its stated type, has search_path exactly pg_catalog, pg_temp and is not executable by PUBLIC
  Scenario: Each function refuses a non-internal context (42501)
  Scenario: The OTP issue → verify → session issue → revoke flow still succeeds as pgeos_app through withContext
  Scenario: A wrong code still increments attempts on every live candidate; a new request still consumes the earlier live code at exactly its issue instant
```
Pre-build review round 1 (pg-reviewer, opus): FAIL, 2 blocking + 5 nits. All of them are applied in this brief and in the RED fix round: the sixth definer; the self-check list; a policy catalog test plus a negative read; return type, volatility, owner and a raw `proconfig` in the catalog test; an exact `consumed_at`; interval literals bound from named constants; the array binding form; SCR ownership; the 0007 re-grant note.
Existing OTP + session + G-16a + deadlock/tx-injectable tests are the regression set and must stay green unedited.

Deliver: migration 0044 · edited `otp.ts` / `session.ts` (each write → `select identity.<fn>(…)`) · the RED files · identity package + module tests, isolation (G14) and `G16_MODULES=identity pnpm guards:run` green on a fresh DB (`createdb -T template0 pgeos_rN && PGDATABASE=pgeos_rN bash database/schema/apply.sh --no-guards`).
Migration number: **0044 — issued to lane M by Master M7, 2026-09-29.**

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40, a permission code would be needed (delta 1/3 → G-01, 1a-9), or a guard assumes the `internal_only` policy name on these tables — STOP and report.
