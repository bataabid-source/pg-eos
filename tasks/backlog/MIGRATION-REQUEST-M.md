# MIGRATION-REQUEST — lane M (M-core, ADR-0007 Phase 1)

Number issued by the Master M2 on 2026-09-28 (commit `89f83c2`, `database/migrations/README.md`, brief `_slice-2.16-1a-5.brief.md`). One row per migration; the RED test paths must exist before the file (lane-guard.sh, D-179).

| number | module | slug | purpose | RED tests |
|---|---|---|---|---|
| 0042 | identity | identity-auth-thresholds | WBS 2.16 part 1a-5: seed every G-16a number (EXECUTION-MASTER-v4 §1.8) as a `platform.thresholds` row under `identity.otp.*` / `identity.login.*`, idempotent `on conflict (key) do nothing` | modules/identity/tests/otp-login/g16a-refusals.test.ts (+ the three package RED files below) |

Package RED files for 0042 (same slice; listed outside the row because `lane-guard.sh`'s RED-path pattern accepts only `modules|tests|apps/…` and would read `packages/identity/tests/x` as the non-existent `tests/x` — reported to the Master): `packages/identity/tests/g16a-limits.feature` · `packages/identity/tests/g16a-limits.test.ts` · `packages/identity/tests/g16a-limits.property.test.ts`.
