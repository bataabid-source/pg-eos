-- 0045_3_identity-session-lifetime.sql — Lane 3 (integration) — X part 5d part 2 item (2)
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- Purpose: seed identity.session.lifetime_minutes into platform.thresholds. packages/identity/src/
-- session.ts reads it via getThreshold with no default, so without this row session issue has no
-- lifetime (CLAUDE.md: "No magic numbers — constants or platform.thresholds"; "Numbers come from
-- the system").
--
-- Value source — docs/DECISION_LOG.md D-203 (verbatim): "[GM directive 2026-09-29 11:40Z]
-- `identity.session.lifetime_minutes` = **720** (12 hours; GM verbatim «١٢»)."
--
-- No DDL, no RLS change, no audit change. `on conflict (key) do nothing`, same form as the threshold
-- seeds in 0010 / 0015 / 0033 / 0042: a row a GM has already edited is never overwritten.
-- changed_by = the all-zero system user of the earlier seed migrations.
--
-- RED test path (lane-guard): tests/scenarios/migration-0045.spec.ts.

begin;

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
  ('identity.session.lifetime_minutes', 720.000, 'minutes',
   'مدة صلاحية جلسة الدخول بالدقائق — D-203 (توجيه GM ‏«١٢» ساعة) — X part 5d part 2',
   '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

commit;
