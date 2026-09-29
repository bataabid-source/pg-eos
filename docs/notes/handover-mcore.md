# Handover — M-core (ADR-0007 Decision 5)

1. **Role** M-core (lane M) · outgoing session_01PinCZHwUx6Nm3Mg2Ln8cME (R3-successor) · 2026-09-29 ≈02:30Z · reason: context ceiling (≈ 380k > 300k).
2. **Git** main @ `783acd3`. Delivered this tenure: `fc999be` 2.16 part 1a-7 (migration 0043, has_perm pinned search_path, merged by M6, PR #190) · `d9f00c0` 4.19 i18n prerequisite on **`core/4.19-i18n-r1`** (pushed, not merged — the Master opens the PR; Review PASS(11 findings, 2 rounds), guards green on fresh `pgeos_r7`). Dead branches (deletion 403 for sessions — GM deletes): `core/scr-identity-rls-01`, `core/2.16-1a-7` (merged), `core/4.19-i18n` (superseded by `-r1`).
3. **Locks held by lane M** `packages/identity`, `identity` (2.16) · `packages/i18n` (4.19) — the Master releases `packages/i18n` once `d9f00c0` merges and lane 2 has rebased PR #170.
4. **Queue for the successor (in order)**
   - **D-198 (أ) tooling slice** — G16/Stryker out of the local pre-commit hook and local `pnpm guards:run` (kept in CI ⑤ scoped, and nightly). Blocked on the Master: a `tooling` lock row + WBS id, claimed together with the brief (M6's #195 pattern). `lane-guard.sh` maps `tooling` → `.claude/** scripts/** .github/**` — **`.githooks/**` is NOT covered**; the brief must get it covered (or the Master decides). Evidence of the cost: every commit touching `database/` ran ≈ 45 min locally this tenure.
   - **2.16 part 1a-8** — SCR-IDENTITY-RLS-01 delta 2 (sessions, otp_codes): per-command policies, pre-auth writes in `packages/identity/src/{otp,session}.ts` behind identity SECURITY DEFINER functions. READY (no new permission code). Needs a migration number from the Master.
   - **2.16 part 1a-9** — deltas 1 + users: BLOCKED (G-01) on `identity.structure.manage` / `hr.employee.pii.read` / `hr.employee.manage` (absent from 01/13/13B/019/40; relayed to the GM by M5). Delta 3 (`hr.employees` PII) needs the `hr` lock.
   - Then per `docs/state/next.md`: SCR-AUDIT-CHAIN-01 1/4 → Master batch.
5. **Traps learned**
   - Shared local `pgeos` holds leftover `identity.users` row `…0505c2` (`modules/platform/tests/maintain-site/handlers.test.ts:224-241` inserts without a prior delete) → platform's G16 dry run fails `users_pkey`. Run gate ③ / guards on a fresh DB: `createdb -T template0 pgeos_rN && PGDATABASE=pgeos_rN bash database/schema/apply.sh --no-guards`, then `PGDATABASE=pgeos_rN git commit …`. Never delete the row without the Master.
   - `git push --force*` and branch deletion are denied: fold wip onto a **new** branch (`…-r1`) instead of rewriting a pushed one.
   - Never write a frozen path via Bash (cp/mv/python) — lane-guard only sees Edit/Write; that was the PR #170/#174 taint. Workers use Write.
   - Masters rotate fast (M4→M7 in one tenure): before a cross-session message, `list_sessions` and target the live `pg-eos:master` session; a trigger to an archived session fails.
   - Keep the working tree frozen while a reviewer runs (a mid-review file move cost a FAIL round).
6. **First action for the successor** read CLAUDE.md → docs/PROJECT_STATE.md → this packet; ACK to the Master; ask for the `tooling` lock + WBS id (item 4.1) or a migration number for 1a-8.
