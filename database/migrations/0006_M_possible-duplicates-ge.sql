-- ═══════════════════════════════════════════════════════════════════════════
-- 0006_M_possible-duplicates-ge.sql — WBS 1.5 · ADR-0001 · قرار GM 23/09/2026 (المرحلة D)
-- مسار واحد (M) · ترحيل أمامي، قابل لإعادة التشغيل.
-- 13B §13B-19 sales.possible_duplicates: شرط التشابه `> 0.85` → `>= 0.85` — الوثيقة 40 §C2 INV-C2-3
-- («name similarity ≥ 0.85») مقدَّمة على المخطط؛ المعامل صار يطابق نص القاعدة. قياس PostgreSQL 16.15: similarity() تُرجع
-- real وتُقارن بـ (0.85)::double precision؛ float4(0.85) = 0.8500000238، فزوج تشابهه 17/20 بالضبط كان يُبلَّغ أصلاً مع `>`،
-- والسلوك عند 0.85 بالضبط لم يتغيّر على هذه النسخة؛ لم يعد الحدّ يعتمد على تقريب float4 إلى أعلى تقريباً صارماً.
-- كشف الأسماء العربية يتطلب قاعدة بـ lc_ctype = C.UTF-8 (SCR-TRGM-01). لا جدول ولا عمود؛ الأعمدة والترتيب دون تغيير.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

create or replace view sales.possible_duplicates as
select a.id a_id, a.code a_code, a.name_ar a_name,
       b.id b_id, b.code b_code, b.name_ar b_name,
       round(similarity(a.name_ar,b.name_ar)::numeric,3) sim
from sales.accounts a join sales.accounts b on a.id < b.id
where a.deleted_at is null and b.deleted_at is null
  and (a.cr_number = b.cr_number or similarity(a.name_ar,b.name_ar) >= 0.85);

commit;
