# SLICE BRIEF — WBS 2.16 part 1a-5 · G-16a authentication limits on the OTP login

Task: 2.16 part 1a-5 (MASTER_BACKLOG)      Lane: M (M-core, ADR-0007 Phase 1)      Lock: `packages/identity | M` + `identity | M`
builder: pg-builder-core
Session: R3 (`pg-eos:core`), branch `core/2.16-1a-5` (first command: `git fetch origin && git checkout -B core/2.16-1a-5 origin/main`), cloud lock worktree `cloud:session_<R3 id>`.
Model routing (ADR-0005 §5, D-174): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED, and BEFORE the migration) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds. `/login` is NOT mounted by this slice (apps/api keeps `NOT_MOUNTED_UNTIL_2_16_PART_1A_5`; unmounting it is a Master step after this merges).

## Acceptance (backlog row 2.16 part 1a-5, verbatim)
"Property tests: after 5 wrong codes the 6th, correct code is refused; a new request invalidates the previous live code; the 6th request in an hour for one email is refused; lockout ladder 15→30→60 min; no code appears in any log line."

G-16a (EXECUTION-MASTER-v4 §1.8, verbatim): "OTP 6 digits · TTL 5 min · single-use · 5 attempts · resend 60 s · 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert. Rate limits: login 5/min/IP + 20/h/email"

## Facts (verified by the Master on main)
- `identity.otp_codes (id, email, code_hash, expires_at, consumed_at, attempts)` (01-Data-Model.sql:289-296) — `attempts` exists and is incremented (`packages/identity/src/otp.ts:182,279`), but a verification is never refused on it (`otp.ts:223` "Still deliberately NOT implemented").
- `platform.thresholds (key, value numeric, unit, description_ar, changed_by, changed_at)` (13B:428-435); `packages/identity/src/thresholds.ts` reads keys; `identity.session.lifetime_minutes` is still unseeded (tests seed it).

## Decisions (defaults — one CHANGELOG line each)
1. Every G-16a number is a `platform.thresholds` row under `identity.otp.*` / `identity.login.*` keys, seeded by **migration 0042** (issued now to lane M; `database/migrations/0042_M_identity-auth-thresholds.sql`, idempotent `insert … on conflict (key) do nothing`, `changed_by` = the existing system user convention of earlier seed migrations). `identity.session.lifetime_minutes` is NOT seeded here (not a G-16a number; its value is a GM question).
2. Enforced inside the same transaction as the verification (`verifyOtpInTx`): attempts ≥ max → refused even for the correct code; a new request consumes (invalidates) every earlier live code for that email; resend window and per-email hourly cap counted from `otp_codes` rows; lockout ladder computed from failed attempts in the window.
3. Anything G-16a needs that the schema cannot hold — the per-IP login rate limit (no IP column), the lockout history for "3 lockouts/24 h → alert" — is NOT invented: STOP, file `docs/notes/SCR-IDENTITY-AUTH-01.md` (G-01) and build the rest; the refusal for those items is reported open in the closing report.
4. Refusals are uniform to the caller (one problem shape; no oracle between "wrong code", "locked", "capped"); no code, hash or email in any log line (pino redaction test).

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/identity.brief.md`
- `packages/identity/src/otp.ts`
- `packages/identity/src/thresholds.ts`
- `packages/identity/src/login.ts` lines 1-192
- `modules/identity/api/otp-login/handlers.ts`
- `database/schema/01-Data-Model.sql` lines 285-296
- `database/schema/13B-Schema-Reference-Consolidation.sql` lines 428-437

Write ONLY: `packages/identity/**` · `modules/identity/**` · `database/migrations/0042_M_identity-auth-thresholds.sql` + its `database/migrations/README.md` line · `tests/**` (pg-tester only) · `docs/notes/SCR-IDENTITY-AUTH-01.md` (only under Decision 3). Never CLAUDE.md, never `apps/api`, never `database/schema/*`.
Contract: `packages/contracts/identity/otp-login.ts` unchanged (a new field → STOP and report). Screen/Board spec: none.

## RED tests (before the migration file — lane-guard)
`packages/identity/tests/g16a-limits.feature` · `packages/identity/tests/g16a-limits.test.ts` · `packages/identity/tests/g16a-limits.property.test.ts` · `modules/identity/tests/otp-login/g16a-refusals.test.ts`

```gherkin
Feature: G-16a authentication limits (WBS 2.16 part 1a-5)
  Scenario: After 5 wrong codes the 6th, correct code is refused
  Scenario: A new request invalidates the previous live code
  Scenario: A resend inside 60 s is refused
  Scenario: The 6th request in an hour for one email is refused
  Scenario: 10 failures in 15 min lock the email for 15 min, then 30, then 60
  Scenario: Every refusal has the same problem shape to the caller
  Scenario: No OTP code, hash or email appears in any log line
  Scenario: Every limit is read from platform.thresholds, never a literal
```

Deliver: the edited `packages/identity/src/{otp,login,thresholds}.ts` (+ new files under `packages/identity/src/` if needed) · `modules/identity/api/otp-login/handlers.ts` (uniform refusal) · migration 0042 · the RED files; identity package + module tests, isolation (G14) and `pnpm guards:run` green.
Migration number: **0042 — issued to lane M** (Master M2, 2026-09-28).

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01, Decision 3); never invent a threshold value beyond G-16a's text.
