# MIGRATION-REQUEST — lane M (M-core, ADR-0007 Phase 1)

Numbers issued by the Master on 2026-09-28 (`database/migrations/README.md`). One row per migration; the RED test paths must exist before the file (lane-guard.sh, D-179).

| number | module | slug | purpose | RED tests |
|---|---|---|---|---|
| 0042 | identity | identity-auth-thresholds | WBS 2.16 part 1a-5: every G-16a number (OTP TTL/attempts/resend/hourly cap, login rate limits, lockout ladder 15→30→60 min) seeded as `platform.thresholds` rows under `identity.otp.*` / `identity.login.*` keys, idempotent `insert … on conflict (key) do nothing` (`_slice-2.16-1a-5.brief.md` Decision 1); `identity.session.lifetime_minutes` NOT seeded here | packages/identity/tests/g16a-limits.feature · packages/identity/tests/g16a-limits.test.ts · packages/identity/tests/g16a-limits.property.test.ts · modules/identity/tests/otp-login/g16a-refusals.test.ts |
