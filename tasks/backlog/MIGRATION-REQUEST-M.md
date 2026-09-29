# MIGRATION-REQUEST — lane M (M-core, ADR-0007 Phase 1)

Numbers issued by the Master on 2026-09-28 (`database/migrations/README.md`). One row per migration; the RED test paths must exist before the file (lane-guard.sh, D-179).

| number | module | slug | purpose | RED tests |
|---|---|---|---|---|
| 0042 | identity | identity-auth-thresholds | WBS 2.16 part 1a-5: every G-16a number (OTP TTL/attempts/resend/hourly cap, login rate limits, lockout ladder 15→30→60 min) seeded as `platform.thresholds` rows under `identity.otp.*` / `identity.login.*` keys, idempotent `insert … on conflict (key) do nothing` (`_slice-2.16-1a-5.brief.md` Decision 1); `identity.session.lifetime_minutes` NOT seeded here | packages/identity/tests/g16a-limits.feature · packages/identity/tests/g16a-limits.test.ts · packages/identity/tests/g16a-limits.property.test.ts · modules/identity/tests/otp-login/g16a-refusals.test.ts |
| 0043 | identity | has-perm-search-path | WBS 2.16 part 1a-7 = SCR-IDENTITY-RLS-01 delta 4: `create or replace function platform.has_perm` with the body unchanged plus `set search_path = pg_catalog, pg_temp` (`_slice-2.16-1a-7.brief.md` Decision 1) | modules/identity/tests/integration/has-perm-search-path.test.ts · modules/identity/tests/has-perm-search-path.feature |
| 0044 | identity | identity-write-definers | WBS 2.16 part 1a-8 = SCR-IDENTITY-RLS-01 delta 2 (sessions, otp_codes): `internal_only` replaced by a select-only `internal_read`, INSERT/UPDATE/DELETE revoked from `pgeos_app`, five `identity.*` SECURITY DEFINER write functions (`_slice-2.16-1a-8.brief.md` Decisions 1-2); issued by Master M7, 2026-09-29 | modules/identity/tests/integration/identity-write-definers.test.ts · modules/identity/tests/identity-write-definers.feature |

Note (R3, 2.16 part 1a-5): `lane-guard.sh`'s RED-path pattern accepts only `modules|tests|apps/…`, so the three `packages/identity/tests/…` paths above are read as `tests/…` and refused; only `modules/identity/tests/otp-login/g16a-refusals.test.ts` satisfied the hook when 0042 was written (after all four existed) → X part 15.
