-- ═══════════════════════════════════════════════════════════════════════════
-- 0005_M_balance-integrity-batch.sql — SCR-WMS-01 · قرار GM 23/09/2026 (المرحلة H)
-- مسار واحد (M) · WBS 2.8 · ترحيل أمامي، قابل لإعادة التشغيل.
-- wms.verify_balance_integrity() (الحارس G1، 01:1493) كانت تجمّع الدفتر بلا batch_no ثم تربطه برصيد مفتاحه
-- يتضمن batch_no ⇒ دفعتان في الموقع نفسه تُبلَّغان انحرافاً زائفاً؛ وكانت تقارن من الدفتر إلى الرصيد فقط.
-- الآن: التجميع بمفتاح stock_balance الكامل، والمقارنة في الاتجاهين. نوع الإرجاع يكسب batch_no ⇒ حذف ثم إنشاء.
-- لا جدول ولا عمود جديد (G-01)؛ لا بيانات تُعدَّل.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

drop function if exists wms.verify_balance_integrity();

-- إعادة بناء رصيد المخزون من الدفتر ومقارنته (P4) — v1.1 · SCR-WMS-01 (قرار GM 23/09/2026):
--   التجميع بمفتاح wms.stock_balance الكامل (client_id, sku_id, location_id, batch_no) — batch_no الدفتر
--   الفارغ يطابق '' في الرصيد — والمقارنة في الاتجاهين: صف رصيد بلا حركات وكميته ≠ 0 يُبلَّغ أيضاً
--   (40 INV-C3-2: «Rebuilt balance from ledger equals stored balance»).
--   صلاحية الاستدعاء: الدالة بحقوق المستدعي (invoker). stock_movements تحت entity_scope وstock_balance تحت
--   internal_only، فمستدعٍ داخلي مقيَّد بكيانات يرى كل الرصيد وبعض الدفتر ⇒ «يتامى» زائفون. نتيجة G1 صالحة فقط
--   لمستدعٍ يتجاوز RLS (superuser/BYPASSRLS) — كما تشغّلها guards.sql وapply.sh والاختبارات (postgres).
create or replace function wms.verify_balance_integrity()
returns table (client_id uuid, sku_id uuid, location_id uuid, batch_no text,
               ledger_qty numeric, balance_qty numeric, diff numeric)
language sql stable as $$
  with ledger as (
    select m.client_id, m.sku_id,
           coalesce(m.to_location_id, m.from_location_id) as loc,
           coalesce(m.batch_no, '')                      as batch_no,
           sum(case when m.to_location_id is not null then m.qty else -m.qty end) as qty
    from wms.stock_movements m
    group by 1,2,3,4
  )
  select coalesce(l.client_id, b.client_id),
         coalesce(l.sku_id,    b.sku_id),
         coalesce(l.loc,       b.location_id),
         coalesce(l.batch_no,  b.batch_no),
         coalesce(l.qty, 0),
         coalesce(b.qty_on_hand, 0),
         coalesce(l.qty, 0) - coalesce(b.qty_on_hand, 0)
  from ledger l
  full join wms.stock_balance b
    on  b.client_id   = l.client_id
    and b.sku_id      = l.sku_id
    and b.location_id = l.loc
    and b.batch_no    = l.batch_no
  where coalesce(l.qty, 0) <> coalesce(b.qty_on_hand, 0)
$$;
comment on function wms.verify_balance_integrity is 'يجب أن يعيد صفر صفوف. أي صف = يوقف النشر (G1). المفتاح: (client_id, sku_id, location_id, batch_no)، والمقارنة في الاتجاهين (INV-C3-2) — SCR-WMS-01. تُشغَّل بدور يتجاوز RLS، وإلا فالنتيجة غير صالحة.';

commit;
