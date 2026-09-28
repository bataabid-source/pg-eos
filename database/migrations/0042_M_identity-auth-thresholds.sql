-- 0042_M_identity-auth-thresholds.sql — Lane M — WBS 2.16 part 1a-5 (G-16a authentication limits on
-- the OTP login). Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- Purpose: seed every G-16a number into platform.thresholds (13B:428-435) so the identity package
-- reads each limit from the table at call time and never from a literal (CLAUDE.md: "No magic
-- numbers — constants or platform.thresholds"; "Numbers come from the system").
--
-- G-16a (EXECUTION-MASTER-v4 §1.8, verbatim): "OTP 6 digits · TTL 5 min · single-use · 5 attempts ·
-- resend 60 s · 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert.
-- Rate limits: login 5/min/IP + 20/h/email"
--
-- Enforced by packages/identity/src/otp.ts after this slice: identity.otp.expiry_minutes,
-- identity.otp.max_attempts, identity.otp.resend_seconds, identity.otp.requests_per_email_per_hour.
--
-- The 8 identity.login.* numbers (lockout ladder, lockout alert, both login rate limits) are
-- SEEDED here but NOT ENFORCED anywhere: the schema holds no per-failure instant, no lockout
-- record and no client IP, so enforcing them would need tables/columns outside docs 01 / 13 / 13B /
-- 019 / 40 — filed as docs/notes/SCR-IDENTITY-AUTH-01.md (G-01). Seeding the numbers now means the
-- SCR's migration adds only schema, never a second copy of a G-16a value.
--
-- identity.session.lifetime_minutes is deliberately NOT seeded (not a G-16a number; its value is a
-- GM question — slice brief, Decision 1).
--
-- No DDL, no RLS change, no audit change. `on conflict (key) do nothing`, same form as the threshold
-- seeds in 0010 / 0015 / 0033 and 13B: a row a GM has already edited is never overwritten.
-- changed_by = the all-zero system user of the earlier seed migrations.
--
-- RED test paths (lane-guard): packages/identity/tests/g16a-limits.feature,
-- packages/identity/tests/g16a-limits.test.ts, packages/identity/tests/g16a-limits.property.test.ts,
-- modules/identity/tests/otp-login/g16a-refusals.test.ts.

begin;

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
  ('identity.otp.expiry_minutes', 5.000, 'minutes',
   'مدة صلاحية رمز الدخول لمرة واحدة (OTP) بالدقائق — G-16a، EXECUTION-MASTER-v4 §1.8 ("TTL 5 min") — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.otp.max_attempts', 5.000, 'count',
   'الحد الأقصى لمحاولات إدخال رمز OTP خاطئ قبل رفض الرمز حتى لو كان صحيحاً — G-16a، EXECUTION-MASTER-v4 §1.8 ("5 attempts") — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.otp.resend_seconds', 60.000, 'seconds',
   'أقل مدة بالثواني بين طلبين لرمز OTP للبريد نفسه — G-16a، EXECUTION-MASTER-v4 §1.8 ("resend 60 s") — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.otp.requests_per_email_per_hour', 5.000, 'count',
   'الحد الأقصى لطلبات رمز OTP للبريد الواحد خلال ساعة — G-16a، EXECUTION-MASTER-v4 §1.8 ("5/email/hour") — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.lockout_fail_threshold', 10.000, 'count',
   'عدد محاولات الدخول الفاشلة التي تُطلق القفل — G-16a، EXECUTION-MASTER-v4 §1.8 ("Lockout 10 fails/15 min") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.lockout_window_minutes', 15.000, 'minutes',
   'نافذة احتساب محاولات الدخول الفاشلة بالدقائق — G-16a، EXECUTION-MASTER-v4 §1.8 ("Lockout 10 fails/15 min") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.lockout_minutes_1', 15.000, 'minutes',
   'مدة القفل الأول بالدقائق — G-16a، EXECUTION-MASTER-v4 §1.8 ("→ 15→30→60 min") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.lockout_minutes_2', 30.000, 'minutes',
   'مدة القفل الثاني بالدقائق — G-16a، EXECUTION-MASTER-v4 §1.8 ("→ 15→30→60 min") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.lockout_minutes_3', 60.000, 'minutes',
   'مدة القفل الثالث بالدقائق — G-16a، EXECUTION-MASTER-v4 §1.8 ("→ 15→30→60 min") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.lockout_alert_count_24h', 3.000, 'count',
   'عدد مرات القفل خلال 24 ساعة الذي يُطلق تنبيهاً — G-16a، EXECUTION-MASTER-v4 §1.8 ("3 lockouts/24 h → alert") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.rate_per_ip_per_minute', 5.000, 'count',
   'الحد الأقصى لمحاولات الدخول من عنوان IP واحد في الدقيقة — G-16a، EXECUTION-MASTER-v4 §1.8 ("login 5/min/IP") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000'),
  ('identity.login.rate_per_email_per_hour', 20.000, 'count',
   'الحد الأقصى لمحاولات الدخول للبريد الواحد في الساعة — G-16a، EXECUTION-MASTER-v4 §1.8 ("20/h/email") — مُدرج غير مُطبَّق (SCR-IDENTITY-AUTH-01) — WBS 2.16 part 1a-5',
   '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

commit;
