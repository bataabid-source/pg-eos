# SCR-IDENTITY-AUTH-01 — G-16a lockout, login rate limits and OTP issue instant (G-01 schema-change request)

**Status:** REQUESTED — filed 2026-09-28 by lane M (pg-builder-core) under **EXECUTION-MASTER-v4 §1.11 (G-01)**, slice brief WBS 2.16 part 1a-5, Decision 3. Nothing in `database/schema/*` or `database/migrations/*` changes for these items until the GM approves them and a numbered migration applies them with a pre-migration review. Every column/table below is a **PROPOSAL for the GM**, never applied.

## 1 · Context (verified on branch `core/2.16-1a-5`)
- G-16a (EXECUTION-MASTER-v4 §1.8, verbatim): "OTP 6 digits · TTL 5 min · single-use · 5 attempts · resend 60 s · 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert. Rate limits: login 5/min/IP + 20/h/email"
- Enforced after WBS 2.16 part 1a-5 (`packages/identity/src/otp.ts`): TTL, single-use, 5 attempts, resend 60 s, 5/email/hour, a new request invalidates every earlier live code.
- `identity.otp_codes (id, email, code_hash, expires_at, consumed_at, attempts)` (`01-Data-Model.sql:289-296`) holds a per-code attempts COUNTER only — no instant per failure, no issue instant, no client IP. No lockout table or login-attempt table exists in docs 01 / 13 / 13B / 019 / 40.
- Migration `0042_M_identity-auth-thresholds.sql` ALREADY seeds every number below in `platform.thresholds` (`identity.login.*`), so applying this SCR adds schema only — never a second copy of a G-16a value.

## 2 · Requested deltas
| # | G-16a text (verbatim) | Missing in 01 / 13 / 13B / 019 / 40 | PROPOSAL (not applied) | Thresholds already seeded by 0042 | status |
|---|---|---|---|---|---|
| 1 | "Lockout 10 fails/15 min → 15→30→60 min" | no instant per failed verification (only `otp_codes.attempts`, a counter per code) and no lockout record, so "10 fails in 15 min" and the ladder step cannot be computed | `identity.login_failures (id, email, failed_at timestamptz)` — or `identity.lockouts (id, email, locked_at, locked_until, step smallint)`; RLS `internal_only`, columns classified (G6) | `identity.login.lockout_fail_threshold` 10 · `identity.login.lockout_window_minutes` 15 · `identity.login.lockout_minutes_1/_2/_3` 15/30/60 | requested |
| 2 | "3 lockouts/24 h → alert" | no lockout history to count, no alert target defined for it | the `identity.lockouts` rows of item 1 (counted over 24 h); the alert as a `platform.outbox` event in the same transaction — event name to be added to the catalog by the GM, not invented | `identity.login.lockout_alert_count_24h` 3 | requested |
| 3 | "Rate limits: login 5/min/IP" | no client IP column anywhere on the login path | `identity.login_attempts (id, email, client_ip inet, attempted_at timestamptz)`; the transport must pass the client IP (contract change — Master) | `identity.login.rate_per_ip_per_minute` 5 | requested |
| 4 | "+ 20/h/email" | no instant per login attempt (verification), only per-code counters | the `identity.login_attempts` rows of item 3, counted per email over one hour | `identity.login.rate_per_email_per_hour` 20 | requested |
| 5 | "resend 60 s · 5/email/hour" (issue instant) | `identity.otp_codes` has no `created_at`; the issue instant is derived as `expires_at − identity.otp.expiry_minutes`, skewed by any GM edit of `expiry_minutes` (lowering fails closed; raising fails open on resend for at most one old TTL — `otp.ts` D4 note) | `identity.otp_codes.created_at timestamptz not null default now()` (column classified, G6) | `identity.otp.resend_seconds` 60 · `identity.otp.requests_per_email_per_hour` 5 · `identity.otp.expiry_minutes` 5 | requested |

## 3 · Open items
- Items 1–4 are reported OPEN in the WBS 2.16 part 1a-5 closing report; `/login` mounting (Master step) should weigh them.
- Item 2's alert event name and recipient are a GM decision (catalog entry), never invented by a lane.
