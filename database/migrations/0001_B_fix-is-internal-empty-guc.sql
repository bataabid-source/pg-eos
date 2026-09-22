-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · 0001 · المسار B — إصلاح platform.is_internal() مع GUC الفارغ
-- هجرة أمامية فقط (forward-only) · PostgreSQL 16 · 22/09/2026
--
-- المصدر: WBS 0.11 (packages/db · withContext) — اكتُشف الخلل عبر مجموعة
--         اختبارات الحزمة نفسها: packages/db/tests/with-context.test.ts
--         «a connection that has never run through withContext starts with
--         nothing set (fail-closed RLS)».
-- الأساس:  database/schema/01-Data-Model.sql:32-40 (دوال سياق RLS الثلاث).
--         هذه الهجرة تُطبَّق فوق الأساس ولا تُعدّله — 01/13/13B/019 مجمَّدة.
--
-- ── الخلل ─────────────────────────────────────────────────────────────────
-- في PostgreSQL، أي GUC مخصّص (app.*) غير معرَّف في postgresql.conf يُضبَط
-- بـ SET LOCAL / set_config(name, value, true) داخل معاملة، ثم تُثبَّت المعاملة
-- (COMMIT) — يعود بعدها إلى **سلسلة فارغة** ('' بطول 0)، لا إلى NULL.
-- أما GUC لم يُمَس إطلاقاً في الجلسة فيُقرأ NULL حقيقياً. إثبات مباشر:
--
--   begin; select set_config('app.is_internal','true',true); commit;
--   select current_setting('app.is_internal', true) is null;  -- f  (ليس NULL)
--   select current_setting('app.is_internal', true) = '';     -- t  (فارغ)
--   select current_setting('app.totally_never_set_xyz', true) is null;  -- t
--
-- الدالتان الأخريان كانتا سليمتين أصلاً ولا تحتاجان هذه الهجرة:
--   · platform.current_user_id()   — nullif(current_setting(...),'')::uuid
--   · platform.current_client_id() — nullif(current_setting(...),'')::uuid
-- لأن nullif('','') = NULL و nullif(NULL,'') = NULL، فتنهار الحالتان معاً
-- («لم يُضبَط قط» و«ضُبِط ثم ثُبِّت») إلى NULL::uuid قبل أي cast.
--
-- الثغرة كانت في platform.is_internal() وحدها:
--   coalesce(current_setting('app.is_internal', true), 'false')::boolean
-- إذ لا يستبدل coalesce إلا NULL الحقيقي، لا السلسلة الفارغة؛ فيُحاول
-- ''::boolean ويرمي PostgreSQL: invalid input syntax for type boolean: "".
-- الأثر ليس تسريب صلاحية (fail-open) بل خطأ يُفشل الاستعلام، غير أن كل سياسات
-- RLS المولَّدة في 13B (reference_read · reference_write · internal_only)
-- تستدعي platform.is_internal()، فأي اتصال معاد استخدامه من تجمّع الاتصالات
-- (connection pool) سبق أن مرّ بـ withContext وثبّت معاملته كان يفشل عليها.
-- إصلاح الدالة وحدها يغطي تلك السياسات جميعاً — لا تُعاد كتابة أي سياسة.
--
-- الإصلاح: إضافة nullif(..., '') قبل coalesce، فتتطابق الدالة مع النمط الآمن
--          المستعمل في الدالتين الأخريين، ويبقى السلوك الافتراضي false.
-- التدقيق: بحث شامل في database/ — هذه الاستدعاءات الثلاثة هي كامل سطح
--          current_setting()/set_config() في الشجرة؛ ولا SQL ديناميكي يركّب
--          استدعاءً آخر (كتل execute format(...) في 13B تولّد سياسات تستدعي
--          الدوال أعلاه بالاسم، لا current_setting مباشرةً).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- WBS 0.11 · إصلاح مطابق لنمط current_user_id()/current_client_id():
--   nullif(...,'') يحوّل «الفارغ بعد COMMIT» إلى NULL، ثم coalesce يعطي 'false'.
--   الحالتان تعطيان false الآن: «لم يُضبَط قط» (NULL) و«ضُبِط ثم ثُبِّت» ('').
create or replace function platform.is_internal() returns boolean
language sql stable as $$ select coalesce(nullif(current_setting('app.is_internal', true), ''), 'false')::boolean $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد التطبيق
-- ═══════════════════════════════════════════════════════════════════════════
--   select platform.is_internal();                                  -- f
--   begin; select set_config('app.is_internal','true',true); commit;
--   select platform.is_internal();                                  -- f (لا خطأ)
--   begin; select set_config('app.is_internal','true',true);
--          select platform.is_internal();                           -- t
--   commit;
-- ═══════════════════════════════════════════════════════════════════════════
