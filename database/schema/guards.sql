-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · guards.sql — اختبارات الحراسة G1–G13 + G18
-- الإصدار 4.0 · 21/09/2026 · المصدر: 40-Build-Specification-EN.md Part F (v4.0)
--
-- كل استعلام هنا **يعيد صفوفاً عند الفشل وصفر صفوف عند السلامة**، فيكفي عدّ
-- صفوف المخرج للحكم: أي صفّ = حارس أحمر = يوقف الدمج والنشر معاً.
-- («There is no "deploy and fix".» — 40 Part F)
--
-- G14–G17 خارج SQL وليست هنا:
--   G14 `pnpm test:isolation`  — عميل أ يطلب معرّفات عميل ب مباشرةً ⇒ صفر صفوف بلا خطأ
--   G15 `pnpm playwright test tests/scenarios` — 20/20 سيناريو (S1–S20)
--   G16 `pnpm stryker run` على domain/ — درجة الطفرات ≥ 75%
--   G17 `pnpm test:trace` — رقم واحد يدخل، الخط الزمني الكامل يخرج ≤ 2 ث
-- وG13 يُشغَّل هنا بصيغة SQL خالصة؛ صيغته الحاكمة في 40 Part F تستعمل
--   `pgbench -c 100 -t 1 -f tests/guards/next_doc_no.sql` لقياس التزامن الحقيقي.
--
-- الاستعمال:  psql -d pgeos -v ON_ERROR_STOP=1 -f guards.sql
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\timing off
\pset pager off

\echo '═══════════════════════════════════════════════════════════════'
\echo ' PG-EOS — اختبارات الحراسة (40 Part F) · صفر صفوف = نجاح'
\echo '═══════════════════════════════════════════════════════════════'

-- ───────────────────────────────────────────────────────────────────────────
-- G1 · سلامة رصيد المخزون — الدفتر يُعاد بناؤه ويُقارن بالرصيد
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G1: wms.verify_balance_integrity() ---'
select 'G1' as guard, * from wms.verify_balance_integrity();

-- ───────────────────────────────────────────────────────────────────────────
-- G2 · توازن القيود المحاسبية
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G2: billing.verify_journal_balance() ---'
select 'G2' as guard, * from billing.verify_journal_balance();

-- ───────────────────────────────────────────────────────────────────────────
-- G3 · نسبة الشحنات المسلَّمة إلى سائق (آخر 30 يوماً)
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G3: imile.verify_attribution(current_date - 30, current_date) ---'
select 'G3' as guard, * from imile.verify_attribution(current_date - 30, current_date);

-- ───────────────────────────────────────────────────────────────────────────
-- G4 · لا معرّف iMile يتيم
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G4: imile.verify_no_orphan_ids() ---'
select 'G4' as guard, * from imile.verify_no_orphan_ids();

-- ───────────────────────────────────────────────────────────────────────────
-- G5 · لا فاتورة شريك مدفوعة بلا مطابقة
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G5: partners.verify_paid_matched() ---'
select 'G5' as guard, * from partners.verify_paid_matched();

-- ───────────────────────────────────────────────────────────────────────────
-- G6 · كل عمود مصنَّف (identity.column_classification)
--      40 §B1: «column_classification must cover every column; deploy fails otherwise»
--      تصنيف الكل = مهمة WBS 0.16؛ العرض identity.unclassified_columns يسرد المتبقي.
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G6: أعمدة بلا تصنيف ---'
select 'G6' as guard, c.table_schema, c.table_name, c.column_name
from information_schema.columns c
where c.table_schema in ('platform','identity','catalog','sales','wms','tms','cc',
                         'billing','hr','partners','admin','housing','imile','governance')
  and not exists (select 1 from identity.column_classification k
                   where k.schema_name = c.table_schema
                     and k.table_name  = c.table_name
                     and k.column_name = c.column_name)
order by 1,2,3;

-- ───────────────────────────────────────────────────────────────────────────
-- G7 · كل جدول أساسي في المخططات الأربعة عشر عليه RLS
--      40 Part F: «"Operational table" for G7 means any base table in the
--      fourteen business schemas … where a table has no entity_id, RLS is
--      still enabled and the policy is written against the access rule.»
--      SCR-RLS-02 (D-002, 2026-09-23): relkind in ('r','p') — a partitioned PARENT is a base
--      table for this purpose. With 'r' alone, platform.audit_log's parent had RLS off and no
--      policy while G7 returned 0; reads through the parent bypassed every partition policy.
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G7: جداول بلا RLS ---'
select 'G7' as guard, n.nspname as schema_name, t.relname as table_name
from pg_class t
join pg_namespace n on n.oid = t.relnamespace
where t.relkind in ('r','p')
  and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc',
                    'billing','hr','partners','admin','housing','imile','governance')
  and not t.relrowsecurity
order by 1,2;

-- ───────────────────────────────────────────────────────────────────────────
-- G8 · سلسلة تجزئة سجل التدقيق سليمة (31 §4 · 40 §B2)
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G8: platform.verify_audit_chain() ---'
select 'G8' as guard, * from platform.verify_audit_chain();

-- ───────────────────────────────────────────────────────────────────────────
-- G9 · لا كتابة بلا صف تدقيق (عيّنة: آخر 1,000 حدث في outbox)
--      R-02: «يُعرَّف كاستعلام عيّنة محدد — آخر 1,000 كتابة في outbox لها صف
--      audit بنفس correlation_id»
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G9: أحداث outbox بلا صف تدقيق مقابل ---'
with w as (select * from platform.outbox order by id desc limit 1000)
select 'G9' as guard, w.id, w.event_type, w.correlation_id
from w
where not exists (select 1 from platform.audit_log a
                   where a.correlation_id = w.correlation_id);

-- ───────────────────────────────────────────────────────────────────────────
-- G10 · لا رفض ولا إبطال بلا سبب (31 §2: reason إلزامي في reject · void · override)
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G10: رفض/إبطال بلا سبب ---'
select 'G10' as guard, id, occurred_at, table_name, record_id, operation
from platform.audit_log
where operation in ('reject','void','override')
  and (reason is null or btrim(reason) = '');

-- ───────────────────────────────────────────────────────────────────────────
-- G11 · لا بند فاتورة بلا حدث فوترة يسنده
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G11: بنود فواتير بلا أحداث ---'
select 'G11' as guard, l.id as invoice_line_id, l.invoice_id
from billing.invoice_lines l
where not exists (select 1 from billing.billable_events e
                   where e.invoice_line_id = l.id);

-- ───────────────────────────────────────────────────────────────────────────
-- G12 · لا مهمة مسلَّمة بلا إثبات تسليم
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G12: مهام مسلَّمة بلا POD ---'
select 'G12' as guard, t.id as task_id, t.doc_no, t.status
from tms.delivery_tasks t
where t.status = 'delivered'
  and not exists (select 1 from tms.proof_of_delivery p where p.task_id = t.id);

-- ───────────────────────────────────────────────────────────────────────────
-- G13 · next_doc_no ذرّي — 100 استدعاء ⇒ 100 رقماً فريداً
--      الصيغة الحاكمة في 40 Part F تستعمل pgbench لقياس التزامن الحقيقي؛
--      هذه الصيغة تتحقق من الذرّية داخل معاملة واحدة (لا تُبقي أثراً).
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G13: تفرّد next_doc_no عبر 100 استدعاء ---'
begin;
select 'G13' as guard,
       count(*)          as calls,
       count(distinct n) as unique_numbers
from (
  select platform.next_doc_no((select id from platform.entities where code = 'PST'),
                              'INV', 'ALL') as n
  from generate_series(1, 100)
) s
having count(distinct n) <> 100;
rollback;

-- ───────────────────────────────────────────────────────────────────────────
-- G18 · أحداث فوترة بلا سعر — **يُبلَّغ ولا يوقف النشر** (40 Part F: report only)
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G18 (تقرير فقط): billing.verify_unpriced_events() ---'
select 'G18' as guard, * from billing.verify_unpriced_events();

-- ───────────────────────────────────────────────────────────────────────────
-- G-SEED · اكتمال البذور المرجعية — **تقرير فقط، لا يمنع النشر**
--   (خارج G1–G18 في 40 Part F؛ حارس اتساق داخلي للحزمة)
--   كل صفّ هنا = بذرة ناقصة أو زائدة عن العدد المنصوص في وثيقتها.
-- ───────────────────────────────────────────────────────────────────────────
\echo '--- G-SEED (تقرير فقط): اكتمال البذور المرجعية ---'
select * from (
  select 'hr.penalty_schedule'  as seed, 77 as expected,
         (select count(*) from hr.penalty_schedule)  as actual, '15 §1 · R-05' as source
  union all
  select 'catalog.services',           92, (select count(*) from catalog.services),        '04 · ADM §1-1'
  union all
  select 'hr.recruitment_stages',      17, (select count(*) from hr.recruitment_stages),   '10 §4 · 40 §C7'
  union all
  select 'tms.failure_reasons',        32, (select count(*) from tms.failure_reasons),     '35 §4-0 (7 + 25)'
  union all
  select 'platform.alert_rules',       22, (select count(*) from platform.alert_rules),    '25 §2 · 23 §4 · R-07'
  union all
  select 'identity.roles',             26, (select count(*) from identity.roles),          '40 §B1 + DEPUTY_SYSADMIN'
  union all
  select 'identity.sod_rules',          4, (select count(*) from identity.sod_rules),      'EXEC-v4 §1.6'
  union all
  select 'hr.penalty_schedule.is_fraud', 8,
         (select count(*) from hr.penalty_schedule where is_fraud),                        'ADR-28 §9'
  union all
  select 'failure_reasons.counts_against_driver', 3,
         (select count(*) from tms.failure_reasons where counts_against_driver),           'EXEC §1.2 FIXED'
) t
where actual <> expected;

\echo '═══════════════════════════════════════════════════════════════'
\echo ' انتهت الحراسة. أي صفّ أعلاه من G1–G13 يوقف الدمج والنشر.'
\echo ' G18 و G-SEED تقرير فقط. G14–G17 خارج SQL (انظر الترويسة).'
\echo '═══════════════════════════════════════════════════════════════'
