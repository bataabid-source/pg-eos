# التنبيهات والتقارير والمتطلبات غير الوظيفية
**وثيقة 25 · PG-EOS · الإصدار 4.0 · 21/09/2026**

> **v4 — حالة الوثيقة:** مرجعية · **الحاكم عند التعارض:** 40 (§B6 · Part G) · 36 (§5-5 · §7) · 42 (§6 · §11) · EXECUTION-MASTER-v4 · 13B (المخطط) · **التصحيحات المطبّقة في v4:** PLT-08, PLT-12, PLT-13, PLT-14, PLT-15, PLT-16, PLT-17, PLT-18, PLT-21, PLT-22, PLT-28, PLT-45, PLT-48, PLT-49 · **القرارات المفتوحة سابقاً:** مُغلقة في EXECUTION-MASTER-v4 §1.

---

# القسم الأول: محرّك التنبيهات والتصعيد

## 1. المبدأ

**تنبيه لا يقود إلى إجراء = ضوضاء.** والضوضاء تُعلّم الناس تجاهل التنبيهات — فتضيع الحرجة معها.

| القاعدة | التطبيق |
|---|---|
| لكل تنبيه **إجراء واحد** واضح | وإلا لا يُرسَل |
| لكل تنبيه **مستقبِل بالدور** | لا إرسال جماعي |
| **كبح التكرار** | نفس التنبيه لنفس الكيان مرة واحدة في نافذة معلنة · **٠ = بلا كبح** |
| **ساعات الهدوء ٢٢:٠٠–٠٧:٠٠** | عدا الطوارئ: **توقف الوكيل (N-01) · فرق COD (N-03)** — هما الاستثناءان الوحيدان في السجل |
| **التجميع** | ١٠ وثائق تنتهي = رسالة واحدة بجدول، لا عشر رسائل |
| الإيقاف | مالك التنبيه وحده · بسبب · بمدة · يُسجَّل |
| **لكل تنبيه `source_query` و`action_label` و`action_link`** | 40 §B6: «An alert without an action link is invalid» — الثلاثة `not null` في `platform.alert_rules` |

### 1-1 «حريق» — استثناء تشغيلي لا تنبيه نظام · **v4 · PLT-13**

الاستثناء الثالث الذي ورد في النسخ السابقة («حريق») **ليس تنبيهاً يولّده النظام** ولا يقابله `alert_rules.code`: النظام لا يملك مصدر بيانات لإنذار الحريق (لا لوحة إنذار موصولة ولا مستشعر).

> **القراءة الصحيحة:** الحريق — وكل طارئ سلامة — **استثناء تشغيلي يُدار بإعلان الوضع اليدوي** (وثيقة 26): يعلنه GM أو WH_MGR/DEL_MGR لنطاقه، على قناة واتساب `PG-EOS-OPS`. إعلان الوضع اليدوي **يرفع ساعات الهدوء عن كل تنبيهات النطاق المعلَن** تلقائياً. لا يُخترع له تنبيه ولا يبقى استثناءً معلَّقاً بلا محل.

### 1-2 المناصب غير المشغولة — قراءة المستقبِل · **v4 · PLT-16**

40 §B1 ينصّ على أن `OPS_DIR` و`HR_MGR` **غير مشغولين**؛ ومستقبِل لا وجود له = تنبيه لا يصل.

> حيث يرد **«مدير العمليات»** في هذه الوثيقة يُقرأ **`WH_MGR` + `DEL_MGR`** بحسب النطاق (مستودع / توصيل).
> وحيث ترد **«الموارد»** يُقرأ **`GM`** إلى أن يُشغل `HR_MGR`.
> `alert_rules.target_roles text[]` تُبذر بالبدائل الفعلية لا بالمنصب الشاغر.

## 2. السجل — اثنان وعشرون تنبيهاً

> **v4 · PLT-12 · R-07:** N-01…N-18 كما هي بلا تغيير في شروطها ولا في جداول تصعيدها. **N-19…N-22 أضيفت** من مؤشرات وثيقة 23 §4 التي كانت بلا رمز. العدد المعتمد في 40 §B6 و38 §5.13 وEXECUTION-MASTER-v4: **٢٢ تنبيهاً · ٢٤ تقريراً**.

| # | الحدث | لمن (الدور) | القناة | الكبح (ساعة) | ساعات الهدوء | التصعيد |
|---|---|---|---|---|---|---|
| N-01 | وكيل iMile متوقف > ١٥ د | `DEL_MGR` مدير التوصيل | فوري + واتساب | ٦٠ | **مستثنى** (طوارئ) | > ٦٠ د → GM |
| N-02 | مشكلة تدقيق حي بلا بتّ > ٢٤ س | `DEL_MGR` مدير التوصيل | يومي ٠٩:٠٠ | ٢٤ (يومي) | تُطبَّق | > ٤٨ س → GM |
| N-03 | فرق COD غير مسوّى | `CFO` + `DEL_MGR` | فوري | **٠ (بلا كبح)** | **مستثنى** (طوارئ) | > ٤٨ س → GM |
| N-04 | وثيقة موظف تدخل درجة من سلّم الانتهاء 90/45/30/15 يوماً (v4 — R-06) | الموارد (**= GM**) + المندوب `PRO` | أسبوعي مجمّع | ١٦٨ (أسبوعي) | تُطبَّق | ≤ ١٥ يوماً → يومي |
| N-05 | وثيقة مركبة تدخل درجة من سلّم الانتهاء 90/45/30/15 يوماً (v4 — R-06) | `FLEET_MGR` الأسطول | أسبوعي مجمّع | ١٦٨ (أسبوعي) | تُطبَّق | ≤ ٧ أيام → يومي |
| N-06 | عقد عميل ينتهي خلال مدة الإشعار | `CFO` + `SALES_MGR` | عند البلوغ | مرة (٠ تكرار) | تُطبَّق | ≤ ١٥ يوماً → GM |
| N-07 | عميل بلغ ٨٠٪ من حده الائتماني | `CFO` | يومي | ٢٤ | تُطبَّق | تجاوز → حجز آلي + GM |
| N-08 | **حدث فوترة بلا سعر > ٧ أيام** | `CFO` | أسبوعي | ١٦٨ | تُطبَّق | > ٣٠ يوماً → GM |
| N-09 | فاتورة متأخرة | `CFO` + `ACCOUNTANT` | ٣ · ٠ · +٧ · +١٥ · +٣٠ | حسب الجدول | تُطبَّق | +٣٠ → GM |
| N-10 | فاتورة شريك بفرق > ٢٪ | `CFO` | فوري | **٠ (بلا كبح)** | تُطبَّق | > ٧ أيام → GM |
| N-11 | تجاوز مساحة متعاقدة | `WH_MGR` + `SALES_MGR` | يومي | ٢٤ | تُطبَّق | ٣ أشهر → GM |
| N-12 | حجز مساحة ينتهي خلال ٧ أيام | `SALES_MGR` | يومي | ٢٤ | تُطبَّق | — |
| N-13 | فرق جرد بلا تفسير | `WH_MGR` المستودع | فوري عند الإقفال | **٠ (بلا كبح)** | تُطبَّق | > ٢٤ س → **`WH_MGR`** (كان «مدير العمليات» — §1-2) |
| N-14 | تذكرة تتجاوز ٨٠٪ من SLA | `CC_MGR` مشرف الكول سنتر | فوري | **٠ (بلا كبح)** | تُطبَّق | تجاوز → مدير الكول |
| N-15 | معاملة حكومية متأخرة عن SLA | `PRO` المندوب | يومي | ٢٤ | تُطبَّق | +٥٠٪ → GM |
| N-16 | مزامنة البصمة فاشلة يومين | `SYSADMIN` مالك النظام | فوري | ٢٤ | تُطبَّق | ٣ أيام → GM |
| N-17 | طلب اعتماد بلا بتّ > مهلته | المعتمِد (`approval_chains`) | يومي | ٢٤ | تُطبَّق | → المستوى الأعلى |
| N-18 | **مجال بيانات تحت ٨٠٪ شهرين** | مالك المجال + GM | شهري | ٧٢٠ (شهري) | تُطبَّق | — |
| **N-19** ✳ | **طابور المعالجة اليدوية > ٢٠ سجلاً أو عمر > ٤٨ س** | مالك التكامل (`integration_config.owner_role`) | فوري + بريد | ٦ | تُطبَّق | > ٧٢ س → `SYSADMIN` ثم GM |
| **N-20** ✳ | **رسائل واتساب مرتدّة > ٥٪ في ٢٤ س** | `SYSADMIN` | يومي | ٢٤ | تُطبَّق | > ١٠٪ → GM (مراجعة قوالب 35 §1-3) |
| **N-21** ✳ | **مطابقة بنكية غير مكتملة > ٧ أيام** | `CFO` | يومي | ٢٤ | تُطبَّق | > ١٤ يوماً → GM |
| **N-22** ✳ | **تكامل بلا تشغيل ناجح ٢٤ ساعة** | مالك التكامل + `SYSADMIN` | فوري | ١٢ | تُطبَّق | > ٤٨ س → GM |

✳ = **مضاف في v4** من وثيقة 23 §4 (PLT-12 · R-07).

## 2-1 الاستعلام والإجراء لكل تنبيه — **v4 (كامل الجدول مضاف)**

> **لماذا:** `platform.alert_rules` يجعل `source_query` و`action_label` و`action_link` **`not null`**، و40 §B6 يقول «An alert without an action link is invalid». بدون الأعمدة الثلاثة كانت المهمة 5.13 محجوبة تماماً (PLT-14).
> **حالة التحقق:** كل استعلام من الاثنين والعشرين **نُفِّذ فعلياً** على قاعدة `pgeos` (PostgreSQL 16 · 01+13+13B+019) داخل `begin; … rollback;` ونجح نحوياً — النتائج في `_changelog/CHANGELOG-PLT.md`.
> **اصطلاح `action_link`:** مسار الشاشة من جرد 29 §6-3 بالصيغة `/<الموديول>/<الشاشة>`؛ وصندوق القرارات هو `/inbox` (الصفحة الرئيسية لكل دور — 29 §6-2 · 40 §D1). أي تنبيه يبتّ فيه المستخدم مباشرة يُوجَّه إلى `/inbox?kind=…`.
> **اصطلاح `source_query`:** يعيد **صفراً من الصفوف عند السلامة**؛ كل صف = حالة تستوجب تنبيهاً، وعموده الأول `entity_ref` هو أساس الكبح في `platform.alert_log`.

| # | `action_label` | `action_link` |
|---|---|---|
| N-01 | افتح لوحة التكاملات | `/platform/integrations` |
| N-02 | افتح التدقيق الحي | `/imile/dtl` |
| N-03 | سوِّ فرق COD | `/inbox?kind=cod_variance` |
| N-04 | جدول تجديد الوثائق | `/hr/documents?expiring=90` |
| N-05 | جدول تجديد وثائق المركبات | `/fleet/documents?expiring=90` |
| N-06 | افتح ملف التجديد | `/sales/contracts?ending=notice` |
| N-07 | افتح أعمار الذمم | `/billing/ar-aging` |
| N-08 | سعِّر الأحداث المعلّقة | `/billing/events?status=pending` |
| N-09 | افتح خطة التحصيل | `/billing/invoices?overdue=1` |
| N-10 | طابق فاتورة الشريك | `/partners/invoices?variance=1` |
| N-11 | افتح لوحة المساحات | `/wms/space` |
| N-12 | حوِّل الحجز أو أفرج عنه | `/wms/space/reservations` |
| N-13 | فسِّر فرق الجرد | `/wms/counts?variance=unexplained` |
| N-14 | افتح التذكرة | `/cc/tickets?sla=at_risk` |
| N-15 | افتح المعاملة الحكومية | `/admin/gov?overdue=1` |
| N-16 | افتح لوحة التكاملات | `/platform/integrations` |
| N-17 | ابتّ في الاعتماد | `/inbox?kind=approval` |
| N-18 | افتح بطاقة جودة البيانات | `/platform/data-quality` |
| **N-19** ✳ | افتح الطابور اليدوي | `/platform/integrations/queue` |
| **N-20** ✳ | راجع قوالب الرسائل | `/platform/integrations?code=I-05` |
| **N-21** ✳ | افتح المطابقة البنكية | `/billing/bank-reconciliation` |
| **N-22** ✳ | افتح لوحة التكاملات | `/platform/integrations` |

### `source_query` — الاثنان والعشرون

```sql
-- N-01 · وكيل iMile متوقف > ١٥ د
select 'imile_agent' as entity_ref, max(h.last_pull_at) as last_pull
from imile.agent_health h
having max(h.last_pull_at) < now() - interval '15 minutes';

-- N-02 · مشكلة تدقيق حي بلا بتّ > ٢٤ س
select p.id::text as entity_ref, p.tracking_no, p.raised_at
from imile.dtl_problems p
where p.auditor_decision is null and p.closed_by is null
  and p.raised_at < now() - interval '24 hours';

-- N-03 · فرق COD غير مسوّى
select t.doc_no as entity_ref, t.driver_id,
       coalesce(t.cod_collected,0) - coalesce(t.cod_amount,0) as variance
from tms.delivery_tasks t
where t.is_cod and t.status = 'delivered'
  and coalesce(t.cod_collected,0) <> coalesce(t.cod_amount,0)
  and t.completed_at >= current_date - 7;

-- N-04 · وثيقة موظف تدخل درجة من السلّم 90/45/30/15 (v4)
select d.id::text as entity_ref, e.name_ar, d.doc_type, d.expiry_date,
       case when d.expiry_date - current_date <= 15 then 'D15'
            when d.expiry_date - current_date <= 30 then 'D30'
            when d.expiry_date - current_date <= 45 then 'D45' else 'D90' end as rung  -- v4: سلّم 90/45/30/15
from hr.employee_documents d
join hr.employees e on e.id = d.employee_id
where e.status = 'active'
  and d.expiry_date between current_date and current_date + 90;

-- N-05 · وثيقة مركبة تدخل درجة من السلّم 90/45/30/15 (v4)
select vd.id::text as entity_ref, v.plate_no, vd.doc_type, vd.expiry_date,
       case when vd.expiry_date - current_date <= 15 then 'D15'
            when vd.expiry_date - current_date <= 30 then 'D30'
            when vd.expiry_date - current_date <= 45 then 'D45' else 'D90' end as rung  -- v4: سلّم 90/45/30/15
from tms.vehicle_documents vd
join tms.vehicles v on v.id = vd.vehicle_id
where vd.expiry_date between current_date and current_date + 90;

-- N-06 · عقد عميل ينتهي خلال مدة الإشعار
select c.doc_no as entity_ref, a.name_ar, c.end_date, c.notice_days
from sales.contracts c
join sales.accounts a on a.id = c.account_id
where c.status = 'active' and c.end_date is not null
  and c.end_date - coalesce(c.notice_days, 30) <= current_date;

-- N-07 · عميل بلغ ٨٠٪ من حده الائتماني
select a.code as entity_ref, a.name_ar, a.credit_limit, sum(i.balance) as outstanding
from sales.accounts a
join billing.invoices i on i.client_id = a.id and i.status not in ('paid','void')
where a.credit_limit > 0
group by a.id, a.code, a.name_ar, a.credit_limit
having sum(i.balance) >= 0.80 * a.credit_limit;

-- N-08 · حدث فوترة بلا سعر > ٧ أيام
select be.id::text as entity_ref, be.client_id, be.occurred_at, be.qty
from billing.billable_events be
where be.invoice_line_id is null
  and (be.unit_price is null or be.status = 'pending')
  and be.occurred_at < now() - interval '7 days';

-- N-09 · فاتورة متأخرة
select i.doc_no as entity_ref, i.client_id, i.due_date, i.balance,
       current_date - i.due_date as days_overdue
from billing.invoices i
where i.status not in ('paid','void','draft')
  and i.balance > 0 and i.due_date < current_date;

-- N-10 · فاتورة شريك بفرق > ٢٪
select pi.doc_no as entity_ref, pi.partner_id, pi.variance_pct, pi.variance_amount
from partners.partner_invoices pi
where pi.approved_at is null and abs(coalesce(pi.variance_pct,0)) > 2;

-- N-11 · تجاوز مساحة متعاقدة
select sd.block as entity_ref, sd.warehouse, sd.contracted, sd.occupied
from wms.space_dashboard sd
where sd.contracted > 0 and sd.occupied > sd.contracted;

-- N-12 · حجز مساحة ينتهي خلال ٧ أيام
select r.id::text as entity_ref, r.client_id, r.block_id, r.expires_at
from wms.space_reservations r
where r.status = 'active'
  and r.expires_at between current_date and current_date + 7;

-- N-13 · فرق جرد بلا تفسير
select l.id::text as entity_ref, c.doc_no, l.location_id, l.variance
from wms.inventory_count_lines l
join wms.inventory_counts c on c.id = l.count_id
where c.finished_at is not null
  and coalesce(l.variance,0) <> 0 and l.variance_reason is null;

-- N-14 · تذكرة تتجاوز ٨٠٪ من SLA
select t.doc_no as entity_ref, t.queue_id, t.priority, t.sla_due_at
from cc.tickets t
where t.status not in ('resolved','closed')
  and t.sla_due_at is not null
  and now() >= t.created_at + (t.sla_due_at - t.created_at) * 0.80;

-- N-15 · معاملة حكومية متأخرة عن SLA
select g.doc_no as entity_ref, g.transaction_type, g.authority, g.due_at
from admin.gov_transactions g
where g.completed_at is null and g.due_at is not null and g.due_at < now();

-- N-16 · مزامنة البصمة فاشلة يومين
select 'biometric' as entity_ref, max(r.finished_at) as last_success
from platform.integration_runs r
where r.integration = 'biometric' and r.status = 'success'
having coalesce(max(r.finished_at), '-infinity'::timestamptz) < now() - interval '48 hours';

-- N-17 · طلب اعتماد بلا بتّ > مهلته
select ar.doc_no as entity_ref, ar.request_type, ar.amount, ar.due_at
from admin.approval_requests ar
where ar.status = 'pending' and ar.due_at is not null and ar.due_at < now();

-- N-18 · مجال بيانات تحت هدفه شهرين
--   ⚠️ يعتمد على platform.domain_quality_monthly — جدول مطلوب في 13B
--      (انظر _changelog/PLT-SCHEMA-NEEDS.md). اختُبر بإنشائه داخل المعاملة.
select o.domain_code as entity_ref, o.owner_role, min(q.score_pct) as worst_pct
from platform.domain_owners o
join platform.domain_quality_monthly q on q.domain_code = o.domain_code
where q.month >= (date_trunc('month', current_date) - interval '2 months')::date
  and q.score_pct < coalesce(o.gate_target_pct, 80)
group by o.domain_code, o.owner_role
having count(distinct q.month) >= 2;

-- N-19 ✳ v4 · طابور المعالجة اليدوية > ٢٠ سجلاً أو عمر > ٤٨ س   (23 §4)
select q.integration as entity_ref, count(*) as pending_rows, min(q.created_at) as oldest
from platform.integration_queue q
where q.status = 'pending'
group by q.integration
having count(*) > 20 or min(q.created_at) < now() - interval '48 hours';

-- N-20 ✳ v4 · رسائل واتساب مرتدّة > ٥٪ في ٢٤ س                  (23 §4)
--   records_in = المُرسَل · records_out = المقبول من Twilio؛ الفارق = الارتداد.
select 'whatsapp' as entity_ref,
       round(100.0 * (sum(r.records_in) - sum(r.records_out))
             / nullif(sum(r.records_in),0), 2) as bounce_pct
from platform.integration_runs r
where r.integration = 'whatsapp' and r.started_at >= now() - interval '24 hours'
having round(100.0 * (sum(r.records_in) - sum(r.records_out))
             / nullif(sum(r.records_in),0), 2) > 5;

-- N-21 ✳ v4 · مطابقة بنكية غير مكتملة > ٧ أيام                   (23 §4 · I-08)
select rc.doc_no as entity_ref, rc.received_at, rc.amount, rc.bank_ref
from billing.receipts rc
where rc.reconciled_at is null and rc.received_at < current_date - 7;

-- N-22 ✳ v4 · تكامل بلا تشغيل ناجح ٢٤ ساعة                      (23 §4)
--   ⚠️ يعتمد على integration_runs.integration_code (PLT-26 · مطلوب في 13B).
select c.code as entity_ref, c.name_ar, max(r.finished_at) as last_success
from platform.integration_config c
left join platform.integration_runs r
       on r.integration_code = c.code and r.status = 'success'
where c.is_active
group by c.code, c.name_ar
having coalesce(max(r.finished_at), '-infinity'::timestamptz) < now() - interval '24 hours';
```

> **بذرة `platform.alert_rules` الكاملة (٢٢ صفاً) مكتوبة كـSQL جاهز في `_changelog/PLT-SCHEMA-NEEDS.md`** — لوكيل المخطط، لتُدرج في 13B.

## 3. المخطط

> **v4 · R-09 §4:** الـDDL الحاكم لـ`platform.alert_rules` و`platform.alert_log` في **13B (القسم 13B-4)**. ما يلي نسخة مرجعية مطابقة للحقول:

```sql
create table platform.alert_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  source_query text not null,              -- الاستعلام الذي يرصد الحالة — §2-1
  target_roles text[] not null,
  channels text[] not null,                -- in_app · email · whatsapp · sms
  schedule text not null,                  -- realtime أو cron
  dedupe_window_hours int not null default 24,   -- ٠ = بلا كبح (v4 · PLT-48)
  quiet_hours boolean not null default true,
  escalate_after_hours int,
  escalate_to_roles text[],
  action_label text not null,              -- نص الزر — §2-1
  action_link text not null,               -- الشاشة التي يفتحها — §2-1
  is_active boolean not null default true,
  muted_until timestamptz, muted_by uuid, mute_reason text
);

create table platform.alert_log (
  id bigserial primary key,
  rule_code text not null,
  entity_ref text,                          -- الكيان المعني — أساس الكبح
  fired_at timestamptz not null default now(),
  recipients uuid[],
  channel text,
  acknowledged_at timestamptz, acknowledged_by uuid,
  escalated_at timestamptz,
  resolved_at timestamptz
);
create index on platform.alert_log (rule_code, entity_ref, fired_at desc);
```

**مؤشر صحة النظام نفسه:** نسبة التنبيهات المُقرّة (acknowledged) خلال مهلتها. أقل من ٧٠٪ = التنبيهات صارت ضوضاء، **يُراجَع السجل ويُحذف ما لا يقود لإجراء**.

---

# القسم الثاني: كتالوج التقارير

## 4. القاعدة

**لكل تقرير قرار يدعمه.** تقرير لا يُذكر القرار الذي يدعمه — يُحذف.

## 5. السجل — أربعة وعشرون تقريراً

### تشغيلية — يومية

| الرمز | التقرير | المصدر | الدورية | الجمهور (الدور) | القرار الذي يدعمه |
|---|---|---|---|---|---|
| R-01 | الرسالة الصباحية | تجميع من `platform.decisions` + `tms` + `billing` | يومي ٠٧:٠٠ | GM | أولويات اليوم |
| R-02 | أوامر اليوم والمتأخر | `wms.outbound_orders` · `tms.delivery_tasks` | يومي | **`WH_MGR` + `DEL_MGR`** (كان «مدير العمليات» — §1-2) | إعادة توزيع الموارد |
| R-03 | **مطابقة COD** | `tms.delivery_tasks` · `tms.payment_attempts` · `billing.receipts` | يومي | `CFO` | إقفال يوم السائق |
| R-04 | التدقيق الحي المعلّق | `imile.dtl_problems` | يومي | `DEL_MGR` | البتّ في ١٥ دقيقة |
| R-05 | جرد iMile والفروق | `imile.daily_inventory` · `imile.inventory_discrepancies` | يومي | `DEL_MGR` | تصعيد المفقود |
| R-06 | حالة التكاملات | `platform.integration_runs` · `integration_queue` | يومي | `SYSADMIN` | تدخّل فني |
| R-07 | **عمولة السائقين أمس** | `hr.commission_daily` | يومي | السائق + المشرف | الاعتراض خلال ٤٨ س |

### تشغيلية — أسبوعية

| الرمز | التقرير | المصدر | الدورية | الجمهور (الدور) | القرار الذي يدعمه |
|---|---|---|---|---|---|
| R-08 | إشغال المساحات والتجاوزات | `wms.space_dashboard` · `occupancy_snapshots` | أسبوعي | `WH_MGR` + `SALES_MGR` | بيع أو تفاوض |
| R-09 | الوثائق المنتهية والقريبة | `hr.employee_documents` · `tms.vehicle_documents` | أسبوعي | الموارد (**= GM**) + `FLEET_MGR` + `PRO` | جدولة التجديد |
| R-10 | **رسالة الطاقة لـ iMile** | `imile.shipments_attributed` · `wms.warehouse_capacity` | أسبوعي | GM | التفاوض على الحجم |
| R-11 | أداء SLA لكل عقد | `sales.sla_results` · `sales.contract_sla` | أسبوعي | **`WH_MGR` + `DEL_MGR`** (§1-2) | معالجة قبل الشهر |
| R-12 | الراحات والاستثناءات لكل مشرف | `hr.disciplinary_cases` · سجل الاستثناءات (`audit_log`) | أسبوعي | GM | كشف المحاباة |

### تجارية ومالية — شهرية

| الرمز | التقرير | المصدر | الدورية | الجمهور (الدور) | القرار الذي يدعمه |
|---|---|---|---|---|---|
| R-13 | **الربحية لكل عميل وعقد** | `billing.profitability` · `cost_allocations` | شهري | GM + `CFO` | إعادة تفاوض أو إنهاء |
| R-14 | **الإيراد الضائع** | `billing.billable_events` (`status='pending'` · `exclusion_reason`) | شهري | GM + `CFO` | إدراج بنود تعاقدية |
| R-15 | أعمار الذمم | `billing.invoices` · `receipt_allocations` | شهري | `CFO` | التحصيل والحجز |
| R-16 | قائمة الدخل لكل كيان | `billing.journal_entries` · `journal_lines` · `gl_accounts` | شهري | `CFO` | **إقفال الشهر لكل كيان واعتماد القيود قبل التجميع (مُدخَل R-17)** — **v4 · PLT-15** |
| R-17 | **قائمة الدخل المجمّعة** (بعد حذف البينية) | `billing.journal_lines` (`is_intercompany`) | شهري | GM + الملّاك | صورة المجموعة |
| R-18 | قمع المبيعات وأسباب الخسارة | `sales.opportunities` · `sales.quotes` | شهري | GM + `SALES_MGR` | تعديل التسعير أو المنتج |
| R-19 | تقييم الشركاء | `partners.partner_invoices` · `service_allocations` · `resale_margin` | شهري | `CFO` + العمليات (§1-2) | التجديد |
| R-20 | **بطاقة جودة البيانات** | `platform.domain_owners` + قياس الجودة الشهري | شهري | GM + مُلاك المجالات | مساءلة |
| R-21 | حصيلة الجزاءات (م.٤٠) | `hr.disciplinary_cases` · `hr.penalty_schedule` | شهري | GM + `CFO` | متطلب قانوني |
| R-22 | تكلفة الاستقدام لكل موظف | `hr.recruitment_cost_per_employee` | شهري | الموارد (**= GM**) + `CFO` | تقييم الدوران |

### ربعية

| الرمز | التقرير | المصدر | الدورية | الجمهور (الدور) | القرار الذي يدعمه |
|---|---|---|---|---|---|
| R-23 | ربحية كل خدمة | `billing.profitability` · `catalog.services` | ربعي | GM | تعديل الكتالوج |
| R-24 | مراجعة الشرائح والترقيات | `catalog.segments` · `price_lists` · `price_exceptions` | ربعي | `CFO` | تحديث الأسعار |

## 6. القواعد

| البند | القاعدة |
|---|---|
| المصدر | **قاعدة البيانات مباشرة** — لا يُبنى تقرير على تقرير |
| الصيغة | شاشة + PDF + Excel · الأرقام `tabular-nums` |
| الترويسة | بيانات الكيان تلقائياً |
| المجدولة | تُرسل بريداً في موعدها · الفشل يُنبّه |
| **الأرقام المالية** | مصنّفة — لا تُرسل لمن لا يراها |
| التراجع | كل رقم في تقرير قابل للنقر للوصول لمصدره |
| **نسخة القراءة · v4 · PLT-22** | 40 §B6 يوجب «Reports read from the read replica». **في Tier 0 (المراحل ٠–٣) لا توجد نسخة قراءة**: التقارير تقرأ القاعدة الأساسية بـ`statement_timeout` وبنافذة خارج الذروة، والتقارير الثقيلة (**R-13 · R-14 · R-17 · R-23**) تُجدول ليلاً في `pg_boss`. شرط نسخة القراءة **يُفعَّل عند Tier 1** (R-03). |

---

# القسم الثالث: المتطلبات غير الوظيفية

## 7. أهداف الأداء (SLO)

| المؤشر | الهدف | القياس |
|---|---|---|
| فتح شاشة قائمة (p95) | ≤ ١.٢ ث | من الخادم |
| فتح شاشة ملف (p95) | ≤ ١.٥ ث | |
| حفظ عملية (p95) | ≤ ٠.٨ ث | |
| **استجابة مسح PDA** | **≤ ١.٠ ث** | حرج ميدانياً |
| بناء لوحة الدور | ≤ ٢.٠ ث | |
| تقرير شهري (١٢ شهراً) | ≤ ٨ ث | |
| تصدير ١٠ آلاف صف | ≤ ١٥ ث | |
| **التوافر في ساعات العمل** | **≥ ٩٩.٥٪** | ≈ ساعتان/شهر |
| التوافر خارج الدوام | ≥ ٩٨٪ | **هدف إرشادي — غير مُلزم عند Tier 0** (42 §0: خادم واحد بلا HA). **v4 · PLT-49** |

### 7-1 الاستمرارية بالطبقة — **v4 · PLT-18 · R-03 (مضاف؛ لم يكن في الوثيقة)**

> السبب: 42 §6.4 كان ينسب إلى هذه الوثيقة هدف RPO/RTO **وهي لا تذكرهما إطلاقاً**. المصدر الحقيقي 40 Part G و36 §7؛ والقيم صارت **بالطبقة** في R-03.

| البند | **Tier 0** (المراحل ٠–٣ · Oracle Always Free) | **Tier 2** (من المرحلة ٤ · GCP أو OCI مدفوع) |
|---|---|---|
| **RPO** | **≤ ٢٤ ساعة** (نسخة يومية) | **≤ ١ ساعة** (أرشفة WAL) |
| **RTO** | **≤ ٤ ساعات** | **≤ ٤ ساعات** |
| **الاحتفاظ بالنسخ** | **١٤ يومي · ٨ أسبوعي · ٦ شهري** (المنفَّذ في `backup.sh` · سعة OCI المجانية ٢٠ ج.ب) | **٣٠ · ١٢ · ١٢** |
| التوافر | ≥ ٩٩.٥٪ ساعات العمل | ≥ ٩٩.٥٪ ساعات العمل |
| الشكل | ARM A1 · ٤ OCPU / ٢٤ ج.ب — VM واحد | يُحدَّد عند المحفّز · لا مورد مدفوع بلا أمر GM |
| نسخة القراءة للتقارير | **لا توجد** — §6 | **موجودة** (Tier 1/2) |

**محفّز الانتقال:** قبل المرحلة ٤ · أو > ٤٠ مستخدماً متزامناً · أو خرق p95 لسبعة أيام متصلة.
**Tier 1** = موارد OCI مدفوعة على نفس الحساب PAYG (فصل قاعدة البيانات في VM مستقل + نسخة قراءة)؛ الحجم يُقرَّر عند المحفّز.

## 8. السعة والنمو

| البند | اليوم | سنة ١ | سنة ٣ |
|---|---|---|---|
| **مستخدمون داخليون مكتبيون** | ١٥ | ٤٥ | ٨٠ |
| **مستخدمو التطبيقات الميدانية** (سائقون + عمال مستودع) | **٦٥** (٤٥ سائقاً + ٢٠ عاملاً) | يُعاد التقدير سنوياً | يُعاد التقدير سنوياً |
| مستخدمون متزامنون | ٥ | ٢٠ | ٤٠ |
| مستخدمو نافذة العميل | ٠ | ٣٠ | ١٠٠ |
| عملاء نشطون | ١ | ٢٥ | ٦٠ |
| أصناف | ٨ | ٥,٠٠٠ | ٢٠,٠٠٠ |
| حركات مخزون/شهر | ٠ | ١٥,٠٠٠ | ٦٠,٠٠٠ |
| شحنات/شهر | ~١٢,٠٠٠ | ٢٥,٠٠٠ | ٦٠,٠٠٠ |
| مكالمات/شهر | — | ٨,٠٠٠ | ٢٥,٠٠٠ |
| **حجم القاعدة** | — | ~٨ ج.ب | ~٤٠ ج.ب |

> **v4 · PLT-30:** «مستخدمون داخليون» = **المكتبيون فقط**؛ صفّ التطبيقات الميدانية أُضيف كي لا يُقرأ الرقم ١٥ على أنه كل المستخدمين. وحجم الشحنات المسجَّل هنا (~١٢,٠٠٠/شهر) هو **الأساس الوحيد لأي حساب أثر** — انظر تصحيح 32 §2 و34 §3.

**قاعدة التصميم:** كل استعلام يُختبر على **بيانات ثلاث سنوات** لا على بيانات اليوم. استعلام يعمل على ١٠ آلاف صف ويفشل على مليون = عيب تصميم لا مشكلة أداء.

## 9. الاحتفاظ بالبيانات

| البيانات | المدة | الأساس |
|---|---|---|
| الفواتير والقيود | **١٠ سنوات** | قانوني |
| العقود | ١٠ سنوات بعد الانتهاء | قانوني |
| ملفات الموظفين | ٥ سنوات بعد انتهاء الخدمة | قانوني |
| سجل التدقيق | **١٨ شهراً** (المالي والاعتمادات **١٠ سنوات**) | قرارك + قانوني |
| البصمات الخام | **١٢ شهراً** | قرارك |
| الصور | **٦٠ يوماً** — مع **`legal_hold` تلقائي** لأي صورة مرتبطة بنزاع أو شكوى أو جزاء (31 §8) | قرارك |
| حركات المخزون | ٥ سنوات | أرشفة لا حذف |
| المكالمات والتسجيلات | ٦ أشهر | |
| سجلات التكاملات الخام | ٩٠ يوماً | |
| **النسخ الاحتياطية** | **Tier 0: ١٤ يومي · ٨ أسبوعي · ٦ شهري** · **Tier 1+: ٣٠ · ١٢ · ١٢** — §7-1 | **v4 · PLT-17 · R-03** |

⚠️ **٦٠ يوماً للصور أقصر من المدة التي قد تُطلب كدليل في نزاع عمالي.** لذلك: `legal_hold` + `retain_until` على `tms.proof_of_delivery` و`platform.documents` (13B)، و**الحذف لا يُفعَّل قبل المرحلة ٦** (EXECUTION-MASTER-v4 §1.4).

## 10. الأمن

| البند | المعيار |
|---|---|
| الجلسة | ٦ ساعات · تجديد بالنشاط · إبطال فوري عند تغيير الدور |
| المصادقة — **الويب الداخلي** | رمز لمرة واحدة · **لا كلمات مرور مخزّنة على الخادم** |
| **المصادقة — التطبيقات الميدانية · v4 · PLT-08** | **استثناء معلَن (40 §B1 المعدَّل · EXECUTION-MASTER-v4 §1):** **PDA = جهاز مشترك مسجَّل** — رقم الموظف + **PIN من ٦ أرقام تُخزَّن تجزئته محلياً على الجهاز بعد أول دخول متصل** · إعادة تحقق OTP أسبوعية · نافذة عمل دون اتصال ٧٢ ساعة. **السائق = جهاز شخصي** — OTP مرة واحدة ثم `refresh` مربوط بالجهاز ٣٠ يوماً · جهاز جديد = موافقة مشرف · دون اتصال ٧ أيام. **لا تجزئة PIN ولا كلمة مرور على الخادم.** |
| ربط الجهاز | جهاز واحد لكل سائق · جهاز جديد باعتماد المشرف · PDA مسجَّل بالجهاز لا بالمستخدم |
| OTP والقفل وحدود المعدّل | **المصدر الوحيد: EXECUTION-MASTER-v4 §1** (OTP ٦ خانات · TTL ٥ د · ٥ محاولات · إعادة إرسال ٦٠ ث · قفل ١٠/١٥ د تصاعدي · دخول ٥/د/IP · داخلي ٣٠٠/د/مستخدم · مزامنة ميدانية ٦٠/د/جهاز) |
| التشفير | نقلاً (TLS 1.3) وسكوناً (القاعدة والنسخ) |
| RLS | **على كل جدول تشغيلي** — بلا استثناء · وعلى `platform.outbox` |
| تصنيف الأعمدة | **إلزامي** — عمود بلا تصنيف يُفشل النشر |
| الأسرار | مدير أسرار · تدوير ٩٠ يوماً · **أربع أعين على كل تغيير سر** (23 §5) |
| التدقيق | كل كتابة واعتماد وقراءة سرّ — `platform.audit_log` المجزّأ بسلسلة التجزئة (31) |
| اختبار اختراق | قبل الإطلاق · ثم سنوياً |
| **عزل العميل** | اختبار آلي دائم: مستخدم A لا يصل لصف من B (الحارس G14) |

## 11. البيئات وخط النشر

| البيئة | الغرض | البيانات |
|---|---|---|
| `dev` | التطوير | نموذجية |
| `staging` | **كل تغيير يمر بها** | نسخة إنتاج مقنّعة |
| `prod` | الإنتاج | حقيقية |

**قواعد غير قابلة للتفاوض:**
- كل تغيير مخطط عبر **ملف هجرة مُصدَّر ومراجَع** في `database/migrations` — لا تعديل مباشر على الإنتاج
- الاختبار الذاتي يعمل قبل كل نشر · **الفشل يمنع النشر**
- كل نشر قابل للاسترجاع بأمر واحد
- **الاختبارات الحارسة G1–G18** (**وثيقة 40 Part F** · 13 · 13B · 31) تمنع النشر: كل حارس يعيد صفر صفوف أو يستوفي شرطه المعلن (G13 ١٠٠ فريداً · G15 ٢٠/٢٠ · G16 ≥ ٧٥٪ · G17 ≤ ٢ ث). **v4 · PLT-45** (كانت الإحالة إلى وثيقة 08 المتقاعدة)
- خط النشر **سبع بوابات مسمّاة ①–⑦** (36 §4-3 · §7 · 38 §0.6)

## 12. الاستراتيجية الاختبارية

| المستوى | التغطية المستهدفة |
|---|---|
| **وحدات — المجال وقواعد الأعمال والحسابات** | **≥ ٩٠٪ من `domain/`** (وثيقة 36 §5-5 — الأعلى في السلّم). **v4 · PLT-21** |
| **اختبار الطفرة (Mutation · Stryker)** | **≥ ٧٥٪ على `domain/`** — شرط حاكم (40 Part F · G16). **v4 (مضاف)** |
| تكامل — كل مسار كتابة عبر طبقة التحقق | ١٠٠٪ من المسارات |
| آلات الحالات | **كل انتقال مسموح وممنوع** |
| الصلاحيات | كل دور × كل جدول |
| **السيناريوهات العشرون (S1–S20)** | ١٠٠٪ — شرط الإطلاق (G15) |
| الأداء | على بيانات ٣ سنوات |
| الأمن | عزل العميل · تصعيد الصلاحية |
| قبول المستخدم (UAT) | مالك كل موديول يوقّع |

---

# 13. القرارات المسجَّلة

> ⚠️ **مُغلق.** كل قرارات هذا القسم محسومة في **EXECUTION-MASTER-v4 §1** (وسجل القرارات الموحّد R-03 · R-07). يُقرأ هذا الجدول **تاريخياً فقط** ولا يوقف أي مهمة WBS. **v4 · PLT-28**

| # | القرار (كما طُرح) | **القرار المسجَّل** | المرجع |
|---|---|---|---|
| 1 | اعتماد التنبيهات الثمانية عشر — إضافة أو حذف | **٢٢ تنبيهاً** (N-01…N-18 + N-19…N-22 من 23 §4) | R-07 · PLT-12 · §2 |
| 2 | ساعات الهدوء | **٢٢:٠٠–٠٧:٠٠** · الاستثناءان: توقف الوكيل · فرق COD · و«حريق» يُدار بالوضع اليدوي (§1-1) | EXECUTION-MASTER-v4 §1.4 · PLT-13 |
| 3 | اعتماد التقارير الأربعة والعشرين | **٢٤ تقريراً** R-01…R-24 · وR-16 له قرار مسجَّل الآن (§5) | EXECUTION-MASTER-v4 §1.4 · PLT-15 |
| 4 | هدف التوافر | **≥ ٩٩.٥٪ في ساعات العمل** · وخارج الدوام هدف إرشادي عند Tier 0 | 40 Part G · PLT-49 |
| 5 | إجراء استخراج الأدلة قبل تفعيل حذف الصور ٦٠ يوماً | **`legal_hold` تلقائي** على أي صورة مرتبطة بنزاع/شكوى/جزاء + `retain_until` · **الحذف لا يُفعَّل قبل المرحلة ٦** | EXECUTION-MASTER-v4 §1.4 · 31 §8 · R-07 |
| 6 | من يوقّع قبول كل موديول (UAT) | **مالك المجال بالمنصب** (`platform.domain_owners.owner_role`) ومعه `approver_role` | وثيقة 22 · R-04 |
