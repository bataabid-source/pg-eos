# مسارات العمل — كل قسم بآلة حالات
**وثيقة 03 · PG-EOS · الإصدار 4.0 · 21/09/2026**

> **v4 — حالة الوثيقة:** مرجعية · **الحاكم عند التعارض:** 40 (Part C/E) · 36 · EXECUTION-MASTER-v4 · 01/13/13B/019 · **التصحيحات المطبّقة في v4:** OPS-16, OPS-17, OPS-18, OPS-19, OPS-20, OPS-21, OPS-22, OPS-23, OPS-24, OPS-25, OPS-26, OPS-27, OPS-28, OPS-29, OPS-30, OPS-31, OPS-67, OPS-68 · **القرارات المفتوحة سابقاً:** مُغلقة في EXECUTION-MASTER-v4 §1.

> **قواعد عامة تسري على كل مسار في هذه الوثيقة:**
> 1. كل انتقال حالة له **دور مصرّح** — الانتقال من دور آخر يُرفض برسالة تشرح المسموح
> 2. كل انتقال يُكتب في **`platform.outbox`** (جدول الأحداث الحاكم — R-02)، وما يحمل مشتركين منه هو **حدث مجال** بصيغة `<module>.<aggregate>.<past_tense>` (40 §B3)
> 3. كل انتقال يُسجَّل في التدقيق `platform.audit_log`: من · متى · من أي جهاز · القيمة قبل وبعد
> 4. **الوثيقة تُولَّد من الانتقال** (P8) — لا تبويب نماذج، وزر الطباعة في شاشة العملية نفسها
> 5. الرجوع للخلف ممنوع إلا بانتقال «إلغاء» أو «إعادة فتح» معلن له دوره وسببه الإلزامي
> 6. **مرجع الحالات الوحيد هو §0 «سجل الحالات المرجعي» أدناه.** الرسوم النصية في الأقسام 1–11 توضيحية؛ عند أي اختلاف بينها وبين §0 يحكم §0.

---

# 0. سجل الحالات المرجعي (v4)

**لماذا هذا السجل:** القاعدة الحيّة لم تكن تحمل قيد `check` واحداً على أي عمود حالة (41 عموداً `status`/`stage`/`internal_status` كلها `text` بلا قيد — OPS-31)، فكانت القوائم المسموحة موجودة في **التعليقات فقط** ولا شيء يمنع كتابة حالة مخترعة. هذا السجل هو المصدر الواحد الذي يبني منه وكيل المخطط قيود `check` على **كل** عمود حالة في `13B` (R-06).

**نسخة قابلة للقراءة الآلية:** `/home/claude/pg/v4/_changelog/STATE-REGISTER.md` — جدول واحد (`table.column | allowed states | notes`).

## 0-0 اصطلاحات السجل

| الرمز | المعنى |
|---|---|
| `DB` | الحالة موجودة في تعليق العمود في 01/13/13B — القائمة المسموحة اليوم |
| **`+DB v4`** | حالة موجودة في القاعدة وكانت **غائبة عن 03** — أُضيفت هنا بوصفها (الست: `picking` · `delivered` للصرف · `cancelled` للمهمة · `partially_paid` · `void` · `idle`) |
| **`+CHK v4`** | حالة تصفها 03 وغير مسموحة في القاعدة — **تبقى وتُضاف إلى قيد `check` في 13B (v4)** (السبع: `commercial_review` · `checks_pending` · `credit_rejected` · `partially_allocated` · `recount` · `registered` · `out_of_service`) |
| `v4` | دور أو حدث **أكملَه وكيل OPS في v4** من 40 Part C/E أو من منطق الوثيقة (الدور المسؤول عن المرحلة) — لم يكن منصوصاً |
| `⟳` | انتقال دائري (يعود إلى الحالة نفسها أو إلى سابقة) بدور وسبب معلنين |

**الأدوار غير المشغولة:** `OPS_DIR` و`HR_MGR` غير مشغولين (40 §B1) — كل انتقال مُسنَد إليهما في هذا السجل يُنفَّذه **`WH_MGR`/`DEL_MGR` كلٌّ لنطاقه** (بدل `OPS_DIR`) و**`GM`** (بدل `HR_MGR`) حتى التعيين (OPS-67).

## 0-1 عرض السعر — `sales.quotes.status`

| الحالة | الوصف العربي | الانتقال (من→إلى) | الدور المصرّح | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `draft` | مسودة | — → `draft` | `SALES_REP` | `sales.quote.drafted` (v4) | `sales.quotes.status` |
| **`commercial_review`** **`+CHK v4`** | مراجعة تجارية | `draft` → `commercial_review` | `SALES_REP` | `sales.quote.submitted` (v4) | `sales.quotes.status` |
| `finance_review` | مراجعة مالية | `commercial_review` → `finance_review` | `SALES_MGR` (40 §C2) | `sales.quote.sent_to_finance` (v4) | `sales.quotes.status` |
| `approved` | معتمد | `finance_review` → `approved` | `CFO`؛ **`GM` إن حمل أي سطر استثناءً** (40 §C2) | `sales.quote.approved` | `sales.quotes.status` |
| `sent` | مُرسَل (مجمَّد — `frozen_snapshot`) | `approved` → `sent` | `SALES_REP` (v4) | `sales.quote.sent` (v4) | `sales.quotes.status` |
| `accepted` | مقبول | `sent` → `accepted` | `SALES_MGR` (v4) | `sales.quote.accepted` (v4) | `sales.quotes.status` |
| `rejected` | مرفوض + سبب | `sent` → `rejected` | `SALES_MGR` (v4) | `sales.quote.rejected` (v4) | `sales.quotes.status` |
| `expired` | منتهٍ (تلقائي عند `valid_until`) | `sent` → `expired` | النظام (v4) | `sales.quote.expired` (v4) | `sales.quotes.status` |

> تعديل عرض `sent` **ينشئ نسخة جديدة**؛ الأصل يبقى مجمَّداً (40 §C2 · INV-C2 §1-1 أدناه).

## 0-2 العميل المحتمل والفرصة — `sales.leads.status` · `sales.opportunities.stage`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `new` | جديد | — → `new` | `SALES_REP` (v4) | `sales.lead.created` (v4) | `sales.leads.status` |
| `contacted` | تم التواصل | `new` → `contacted` | `SALES_REP` (v4) | `sales.lead.contacted` (v4) | `sales.leads.status` |
| `qualified` | مؤهَّل | `contacted` → `qualified` | `SALES_MGR` (v4) | `sales.lead.qualified` (v4) | `sales.leads.status` |
| `converted` | تحويل إلى حساب | `qualified` → `converted` | `SALES_MGR` (v4) | `sales.lead.converted` (v4) | `sales.leads.status` |
| `lost` | مفقود + **سبب إلزامي** | أي حالة → `lost` | `SALES_REP` (v4) | `sales.lead.lost` (v4) | `sales.leads.status` |
| `qualification` | تأهيل | — → `qualification` | `SALES_REP` (v4) | `sales.opportunity.created` (v4) | `sales.opportunities.stage` |
| `needs_analysis` | تحليل احتياج | `qualification` → `needs_analysis` | `SALES_REP` (v4) | `sales.opportunity.staged` (v4) | `sales.opportunities.stage` |
| `proposal` | عرض | `needs_analysis` → `proposal` | `SALES_REP` (v4) | `sales.opportunity.staged` (v4) | `sales.opportunities.stage` |
| `negotiation` | تفاوض | `proposal` → `negotiation` | `SALES_MGR` (v4) | `sales.opportunity.staged` (v4) | `sales.opportunities.stage` |
| `won` | ربح | `negotiation` → `won` | `SALES_MGR` (v4) | `sales.opportunity.won` (v4) | `sales.opportunities.stage` |
| `lost` | خسارة + سبب من قائمة مغلقة | أي حالة → `lost` | `SALES_MGR` (v4) | `sales.opportunity.lost` (v4) | `sales.opportunities.stage` |

## 0-3 العقد — `sales.contracts.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `draft` | مسودة | — → `draft` | `SALES_REP` (v4) | `sales.contract.drafted` (v4) | `sales.contracts.status` |
| `signed` | موقَّع | `draft` → `signed` | `GM` (v4) | `sales.contract.signed` | `sales.contracts.status` |
| `active` | ساري | `signed` → `active` | `CFO` (v4) — **يُرفض بلا `price_list_id`** (INV-C2-2) | `sales.contract.activated` (v4) | `sales.contracts.status` |
| `suspended` | معلَّق | `active` → `suspended` | `CFO`/`GM` + سبب (v4) | `sales.contract.suspended` (v4) | `sales.contracts.status` |
| `active` ⟳ | رفع التعليق | `suspended` → `active` | **`GM` أو `CFO` بسبب مسجَّل** (v4 — OPS-30) | `sales.contract.resumed` (v4) | `sales.contracts.status` |
| `expired` | منتهٍ | `active`/`suspended` → `expired` | النظام عند `end_date` (v4) | `sales.contract.expired` (v4) | `sales.contracts.status` |
| `renewed` | مجدَّد — **حالة نهائية**: تُنشئ **عقداً جديداً** وتُنهي القديم (v4 — OPS-30) | `expired` → `renewed` | `SALES_MGR` (v4) | `sales.contract.renewed` (v4) | `sales.contracts.status` |
| `terminated` | منهى + سبب + إشعار — **حالة نهائية** | `active`/`suspended` → `terminated` | `GM` (v4) | `sales.contract.terminated` (v4) | `sales.contracts.status` |

> تنبيه الانتهاء `sales.contract.expiring` يُطلق بمدة الإشعار في العقد (40 §C2).

## 0-4 أمر الإدخال (ASN) — `wms.inbound_orders.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `draft` | مسودة | — → `draft` | `WH_OP` / العميل من النافذة (v4) | `wms.inbound.drafted` (v4) | `wms.inbound_orders.status` |
| `approved` | معتمد | `draft` → `approved` | **`WH_MGR`** (40 §C3) | `wms.inbound.approved` (v4) | `wms.inbound_orders.status` |
| `receiving` | قيد الاستلام (وصول الشاحنة) | `approved` → `receiving` | `WH_OP` (PDA) (v4) | `wms.inbound.receiving_started` (v4) | `wms.inbound_orders.status` |
| `received` | مستلم | `receiving` → `received` | `WH_OP` (PDA) (v4) | `wms.inbound.received` | `wms.inbound_orders.status` |
| `putaway` | مخزَّن | `received` → `putaway` | `WH_OP` (PDA) (v4) | `wms.inbound.putaway` (v4) | `wms.inbound_orders.status` |
| `closed` | مقفل — **سطر مفتوح واحد يمنع الإقفال** | `putaway` → `closed` | **`WH_SUP`** (40 §C3) | `wms.inbound.closed` (v4) | `wms.inbound_orders.status` |
| `cancelled` | ملغى + سبب | أي حالة قبل `received` → `cancelled` | `WH_MGR` (v4) | `wms.inbound.cancelled` (v4) | `wms.inbound_orders.status` |

> حدث التباين `wms.inbound.variance` يُطلق من السطر لا من الأمر (`wms.order_lines`) ويُخطر العميل تلقائياً.

## 0-5 أمر الصرف — `wms.outbound_orders.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `draft` | مسودة | — → `draft` | `WH_OP` / العميل من النافذة (v4) | `wms.outbound.drafted` (v4) | `wms.outbound_orders.status` |
| **`checks_pending`** **`+CHK v4`** | فحص الشروط العشرة (§3-1) — **حارس على الانتقال لا مرحلة عمل** | `draft` → `checks_pending` | النظام (آلي) (v4) | `wms.outbound.checks_started` (v4) | `wms.outbound_orders.status` |
| **`credit_rejected`** **`+CHK v4`** | مرفوض ائتمانياً (فشل الشرط 2) | `checks_pending` → `credit_rejected` | النظام (آلي) (v4) | `wms.outbound.credit_rejected` (v4) | `wms.outbound_orders.status` |
| `approved` | معتمد | `checks_pending` → `approved` | **`WH_MGR`** (40 §C3) | `wms.outbound.approved` | `wms.outbound_orders.status` |
| `allocated` | مخصَّص (FEFO/FIFO) | `approved` → `allocated` | النظام + `WH_SUP` (v4) | `wms.outbound.allocated` (v4) | `wms.outbound_orders.status` |
| **`partially_allocated`** **`+CHK v4`** | مخصَّص جزئياً — **لا يُقفل تلقائياً · ينبّه المشرف** | `approved` → `partially_allocated` | النظام (v4) | `wms.outbound.partially_allocated` (v4) | `wms.outbound_orders.status` |
| **`picking`** **`+DB v4`** | قيد الالتقاط | `allocated` → `picking` | **`WH_OP`** (40 §C3) | `wms.outbound.picking_started` (v4) | `wms.outbound_orders.status` |
| `picked` | ملتقط | `picking` → `picked` | `WH_OP` (v4) | `wms.outbound.picked` (v4) | `wms.outbound_orders.status` |
| `checked` | مدقَّق — **المدقّق ≠ الملتقط** (INV-C3-6) | `picked` → `checked` | **`WH_OP` آخر**؛ التجاوز **بيد `WH_SUP` بسبب مسجَّل** (EXEC §1.2 FIXED) | `wms.outbound.checked` | `wms.outbound_orders.status` |
| `packed` | معبّأ | `checked` → `packed` | `WH_OP` (v4) | `wms.outbound.packed` (v4) | `wms.outbound_orders.status` |
| `loaded` | محمَّل | `packed` → `loaded` | `WH_OP` (v4) | `wms.outbound.loaded` | `wms.outbound_orders.status` |
| `dispatched` | مُرسَل → تُنشأ مهمة توصيل في TMS | `loaded` → `dispatched` | **`WH_SUP`** (v4) | `wms.outbound.dispatched` (v4) | `wms.outbound_orders.status` |
| **`delivered`** **`+DB v4`** | سُلِّم — تُغلق الدورة من `tms.task.delivered` | `dispatched` → `delivered` | النظام (من TMS) (v4) | `wms.outbound.delivered` (v4) | `wms.outbound_orders.status` |
| `cancelled` | ملغى + سبب — **من أي حالة قبل `loaded`** | → `cancelled` | `WH_MGR` (v4) | `wms.outbound.cancelled` (v4) | `wms.outbound_orders.status` |

**سطر الأمر — `wms.order_lines.status`:** `open` · `partial` · `complete` · `cancelled`. الجزئية تُمثَّل على **السطر** كما في القاعدة؛ و`partially_allocated` على الأمر مؤشر تجميعي لها (OPS-18).

## 0-6 الجرد — `wms.inventory_counts.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `draft` | مسودة | — → `draft` | `WH_SUP` (v4) | `wms.count.drafted` (v4) | `wms.inventory_counts.status` |
| `in_progress` | قيد التنفيذ — **عدّ أعمى** (INV-C3-7) | `draft` → `in_progress` | `WH_OP` (PDA) (v4) | `wms.count.started` (v4) | `wms.inventory_counts.status` |
| `review` | مراجعة الفروق | `in_progress` → `review` | `WH_SUP` (v4) | `wms.count.under_review` (v4) | `wms.inventory_counts.status` |
| **`recount`** **`+CHK v4`** | إعادة عدّ — **إلزامية لأي فرق**؛ في 40 §C3 أمر `Recount` لا حالة، وتُسجَّل على `inventory_count_lines` | `review` ⟳ `recount` → `review` | `WH_OP` (عدّاد آخر) (v4) | `wms.count.recount_ordered` (v4) | `wms.inventory_counts.status` |
| `adjusted` | تسوية — حركة `adjust` بسبب إلزامي | `review` → `adjusted` | **`WH_MGR` يعتمد** (INV-C3-7) | `wms.count.adjusted` (v4) | `wms.inventory_counts.status` |
| `closed` | مقفل | `adjusted` → `closed` | `WH_SUP` (v4) | `wms.count.closed` | `wms.inventory_counts.status` |

> فرق بلا تفسير بعد إعادة العدّ → **تصعيد إلى `WH_MGR`** (لا حالة جديدة).

## 0-7 مهمة التوصيل — `tms.delivery_tasks.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `created` | مُنشأة — **تُرفض بلا `area, block, street, phone`** (INV-C4-2) | — → `created` | النظام / `DEL_SUP` (v4) | `tms.task.created` (v4) | `tms.delivery_tasks.status` |
| `assigned` | مُسندة | `created` → `assigned` | **`DEL_MGR`** (تخطيط) — **حاجز صلب INV-C4-1**: سائق أو مركبة بوثيقة منتهية لا يُسند | `tms.task.assigned` (v4) | `tms.delivery_tasks.status` |
| `out_for_delivery` | خرجت (تلقائياً عند أول مسح) | `assigned` → `out_for_delivery` | **`DRIVER`** (v4) | `tms.task.out_for_delivery` (v4) | `tms.delivery_tasks.status` |
| `delivered` | سُلِّمت — POD: GPS + (توقيع أو صورة) + اسم المستلم + ختم الخادم | `out_for_delivery` → `delivered` | `DRIVER` (v4) | `tms.task.delivered` | `tms.delivery_tasks.status` |
| `failed` | فشلت — **بكود من `tms.failure_reasons` حصراً، لا نص حر** (INV-C4-5) | `out_for_delivery` → `failed` | `DRIVER` (v4) | `tms.task.failed` | `tms.delivery_tasks.status` |
| `assigned` ⟳ | المحاولة الثانية — **عدّاد `attempt_no` لا حالة**؛ الحلقة مشروطة بـ`attempt_no < 2` | `failed` ⟳ `assigned` | `DEL_SUP` (v4) | `tms.task.reassigned` (v4) | `tms.delivery_tasks.attempt_no` |
| `deferred` **(40 §C4)** | مؤجَّلة بطلب المستلم — تعود إلى `assigned` بتاريخ جديد | `out_for_delivery` → `deferred` → `assigned` | `DRIVER` ثم `DEL_SUP` (v4) | `tms.task.deferred` (v4) | `tms.delivery_tasks.status` |
| `returned` | مرتجعة | `failed` (بعد المحاولة 2) → `returned` | **`DEL_SUP`** (إقفال المسار) (v4) | `tms.task.returned` | `tms.delivery_tasks.status` |
| **`cancelled`** **`+DB v4`** | ملغاة — الشحنة أُلغيت قبل التسليم (إشعار N3 في 35 §6) | أي حالة قبل `delivered` → `cancelled` | `DEL_MGR` (v4) | `tms.task.cancelled` (v4) | `tms.delivery_tasks.status` |

> `deferred` مذكورة نصاً في 40 §C4 وغائبة عن تعليق 01:883 — **تُضاف إلى قيد `check` في 13B** (OPS-22).

## 0-8 المركبة والوثيقة والوقود — `tms.vehicles.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| **`registered`** **`+CHK v4`** | مسجَّلة — في 01 **فعل الإنشاء** لا حالة مخزَّنة | — → `registered` | `FLEET_MGR` (v4) | `tms.vehicle.registered` (v4) | `tms.vehicles.status` |
| `active` | نشطة | `registered` → `active` | `FLEET_MGR` (v4) | `tms.vehicle.activated` (v4) | `tms.vehicles.status` |
| `maintenance` | صيانة | `active` → `maintenance` | `FLEET_MGR` (v4) | `tms.vehicle.in_maintenance` (v4) | `tms.vehicles.status` |
| **`idle`** **`+DB v4`** | متوقفة — متاحة ولا تعمل (بلا سائق مسنَد) | `active` ⟷ `idle` | `FLEET_MGR` (v4) | `tms.vehicle.idled` (v4) | `tms.vehicles.status` |
| **`out_of_service`** **`+CHK v4`** | معطّلة — عاطلة عن العمل بعطل فني | `active` → `out_of_service` | `FLEET_MGR` (v4) | `tms.vehicle.out_of_service` (v4) | `tms.vehicles.status` |
| `active` ⟳ | العودة للخدمة | `maintenance`/`idle`/`out_of_service` → `active` | `FLEET_MGR` (v4) | `tms.vehicle.returned_to_service` (v4) | `tms.vehicles.status` |
| `disposed` | مستبعدة — **حالة نهائية** (v4 — OPS-30) | أي حالة → `disposed` | `GM` (v4) | `tms.vehicle.disposed` (v4) | `tms.vehicles.status` |

**وثيقة المركبة والموظف:** الحالات **مشتقة من `expiry_date` لا مخزَّنة** — سلّم التنبيه الواحد **90/45/30/15 يوماً** (40 §C7 · R-06). الجدولان: `tms.vehicle_documents.expiry_date` · `hr.employee_documents.expiry_date`. الحدث `hr.document.expiring` (v4) عند كل عتبة من الأربع. الدور: `FLEET_MGR` للمركبات · `GM` للموظفين (`HR_MGR` غير مشغول).

**الوقود:** `tms.fuel_ledger` — لا عمود حالة؛ **تسجيل العداد إلزامي** (INV-C4-9) وانحراف > 20% عن متوسط 90 يوماً للمركبة → `is_anomaly`. الدور: `DRIVER` يسجّل · `FLEET_MGR` يطابق شهرياً.

## 0-9 التذكرة — `cc.tickets.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `open` | مفتوحة | — → `open` | `CC_AGENT` (v4) | `cc.ticket.created` (v4) | `cc.tickets.status` |
| `in_progress` | قيد المعالجة | `open` → `in_progress` | `CC_AGENT` (v4) | `cc.ticket.started` (v4) | `cc.tickets.status` |
| `pending_client` | بانتظار العميل | `in_progress` ⟷ `pending_client` | `CC_AGENT` (v4) | `cc.ticket.waiting_client` (v4) | `cc.tickets.status` |
| `pending_internal` | بانتظار قسم داخلي | `in_progress` ⟷ `pending_internal` | `CC_AGENT` (v4) | `cc.ticket.waiting_internal` (v4) | `cc.tickets.status` |
| `resolved` | محلولة — **حقل «الحل» إلزامي** | `in_progress` → `resolved` | `CC_AGENT` (v4) | `cc.ticket.resolved` | `cc.tickets.status` |
| `closed` | مغلقة — استبيان رضا تلقائي | `resolved` → `closed` | النظام / `CC_MGR` (v4) | `cc.ticket.closed` (v4) | `cc.tickets.status` |
| `reopened` | معادة الفتح (خلال 7 أيام) — **مخرجها `in_progress`** (v4 — OPS-30) | `closed` → `reopened` → `in_progress` | `CC_MGR` (v4) | `cc.ticket.reopened` (v4) | `cc.tickets.status` |

> التصعيد عند **80% من مهلة SLA** → تنبيه `CC_MGR` (40 §C5) — تصعيد لا حالة.

## 0-10 الفوترة والتحصيل — `billing.billable_events.status` · `billing.invoices.status` · `billing.credit_notes.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `pending` | حدث قابل للفوترة بانتظار التسعير | — → `pending` | النظام (v4) | `billing.event.recorded` (v4) | `billing.billable_events.status` |
| `priced` | مُسعَّر | `pending` → `priced` | النظام (v4) | `billing.event.priced` (v4) | `billing.billable_events.status` |
| `excluded` | مستبعد + سبب | `pending` → `excluded` | `CFO` (v4) | `billing.event.excluded` (v4) | `billing.billable_events.status` |
| `disputed` | متنازع عليه | `priced`/`invoiced` → `disputed` | `CFO` (v4) | `billing.event.disputed` (v4) | `billing.billable_events.status` |
| `invoiced` | مُفوتر | `priced` → `invoiced` | النظام (v4) | `billing.event.invoiced` (v4) | `billing.billable_events.status` |
| `draft` | مسودة فاتورة | — → `draft` | النظام (v4) | `billing.invoice.drafted` (v4) | `billing.invoices.status` |
| `review` | مراجعة | `draft` → `review` | `CFO` (v4) | `billing.invoice.under_review` (v4) | `billing.invoices.status` |
| `approved` | معتمدة — **`doc_no` يُخصَّص لحظة الاعتماد فقط** (قيد `doc_no_only_when_approved`) · آلي عند `total ≤ 500 KWD` وإلا `CFO` (EXEC §1.1) | `review` → `approved` | النظام (≤ 500) · `CFO` (فوقها) | `billing.invoice.approved` | `billing.invoices.status` |
| `sent` | مُرسَلة | `approved` → `sent` | `CFO` (v4) | `billing.invoice.sent` (v4) | `billing.invoices.status` |
| **`partially_paid`** **`+DB v4`** | مسدَّدة جزئياً | `sent` → `partially_paid` | `PRO` (تسجيل القبض) (v4) | `billing.invoice.partially_paid` (v4) | `billing.invoices.status` |
| `paid` | مسدَّدة | `sent`/`partially_paid` → `paid` | `PRO` (v4) | `billing.invoice.paid` (v4) | `billing.invoices.status` |
| `overdue` | متأخرة → **حجز ائتماني تلقائي على مستوى المجموعة** | `sent`/`partially_paid` → `overdue` | النظام (v4) | `billing.invoice.overdue` (v4) · `sales.account.hold_set` | `billing.invoices.status` |
| **`void`** **`+DB v4`** | ملغاة | `draft`/`review` → `void` | `CFO` (v4) | `billing.invoice.voided` (v4) | `billing.invoices.status` |
| `draft` → `approved` → `applied` | إشعار دائن: مسودة → معتمد → مُطبَّق | — | **`GM` حصراً — لا اعتماد آلي إطلاقاً** (EXEC §1.1 FIXED) | `billing.credit_note.approved` | `billing.credit_notes.status` |

> **المطابقة البنكية حدث لا حالة فاتورة** (OPS-23): `billing.reconciliation.matched` (v4) على `billing.receipt_allocations`، ومالكها **`CFO`** (R-04). ولا حالة `مقفلة` على الفاتورة.

## 0-11 الموارد البشرية — `hr.manpower_requests.status` · `hr.recruitment_cases.stage` · `hr.disciplinary_cases.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `draft` · `pending_approval` · `approved` · `in_progress` · `completed` · `rejected` · `cancelled` | طلب قوى عاملة | متسلسل مع `rejected`/`cancelled` من أي حالة | **`GM`** يعتمد (`HR_MGR` غير مشغول — R-04) | `hr.manpower_request.*` (v4) | `hr.manpower_requests.status` |
| **17 مرحلة** تبدأ بـ`work_permit` | الاستقدام — **لكل مرحلة `stage_owner` (NOT NULL) و`sla_days`** (40 §C7) | متسلسل بين المراحل السبع عشرة | مالك المرحلة (`stage_owner`) · التصعيد إلى `GM` | `hr.recruitment.stage_changed` (v4) | `hr.recruitment_cases.stage` |
| `draft` · `issued` · `grievance_filed` · `upheld` · `cancelled` · `applied` · `carried_forward` | الانضباط — واقعة → تحقيق → قرار → تنفيذ → أرشفة | متسلسل؛ `grievance_filed` خلال **7 أيام** من `issued` | **سلطة هرمية:** مشرف D1–D2 · مدير D1–D3 · **`GM` D1–D4 (الفصل `GM` فقط)** — الموقّع خارج سلطته يُعاد توجيهه لأعلى (`routed_to`) | `hr.discipline.decided` | `hr.disciplinary_cases.status` |

**الإجازة:** لا جدول حالة مستقل في 01/13/13B — تمرّ عبر `admin.approval_requests` (`request_type = 'leave'`): `pending` → `approved`/`rejected`. الدور: المشرف ثم **مدير القسم الطالب** (R-04).

**الرواتب:** دورة لا آلة حالات مخزَّنة — الخطوات: حساب (النظام) → **مراجعة `GM`** (`HR_MGR` غير مشغول — OPS-67) → **اعتماد `CFO`** → إقفال الشهر (يجمّد الحركات ولا يحذفها) → صرف. الحدث `hr.payroll.closed` (v4).

**العمولة:** `hr.commission_daily` (`status` = `calculated` …) — `source_snapshot` مجمَّد ونافذة اعتراض **48 ساعة** (40 §C7). القيم الحاكمة: **0.300 د.ك/شحنة مسلَّمة (ثابت)** · بونص جودة **+0.050** عند أول محاولة ≥ 85% وبلا فرق COD في الشهر · خصومات شهرية **سكن 23 · هاتف 5 · إقامة 12** (EXEC §1.2 · R-05 — مفصَّلة في 35 §8-4).

## 0-12 iMile وأوامر الفرز — `imile.shipments.internal_status` · `imile.sorting_plans.status`

| الحالة | الوصف العربي | الانتقال | الدور | `event_type` | الجدول.العمود |
|---|---|---|---|---|---|
| `expected` · `arrived` · `sorted` · `staged` · `assigned` · `ofd` · `delivered` · `failed` · `returned` | دورة الشحنة في المحطة | متسلسل | وكيل المحطة (آلي) + `DEL_SUP` (v4) | `imile.shipment.*` (v4) | `imile.shipments.internal_status` |
| `draft` · `review` · `approved` · `executing` · `closed` | خطة الفرز اليومية | متسلسل | `DEL_MGR` يعتمد؛ **أو `engine` عند استحقاق الاستقلالية** (ADR-27 — 07 §4-4) | `imile.plan.approved` (v4) | `imile.sorting_plans.status` |

## 0-13 حصيلة السجل

| البند | العدد |
|---|---|
| آلات الحالات المغطّاة | **13** |
| أعمدة حالة في القاعدة مربوطة | **19** |
| حالات القاعدة الغائبة عن 03 وأُضيفت (`+DB v4`) | **6** — `picking` · `delivered` (الصرف) · `cancelled` (المهمة) · `partially_paid` · `void` · `idle` |
| حالات 03 غير المسموحة في القاعدة وتُضاف إلى قيود `check` (`+CHK v4`) | **7** — `commercial_review` · `checks_pending` · `credit_rejected` · `partially_allocated` · `recount` · `registered` · `out_of_service` |
| حالات 40 الغائبة عن 01 وتُضاف | **1** — `deferred` (`tms.delivery_tasks`) |
| انتقالات أُكملت بدورها وحدثها في v4 | كل انتقال في §0 يحمل الآن **دوراً وحدثاً**؛ ما استُنبط معلَّم `v4` |

---

# 1. المبيعات — من عميل محتمل إلى عقد

```
عميل محتمل ──► تم التواصل ──► مؤهَّل ──► تحويل إلى حساب
   (new)      (contacted)   (qualified)      (converted)
                                  │
                                  └──► مفقود (lost) + سبب إلزامي

فرصة:  تأهيل ──► تحليل احتياج ──► عرض ──► تفاوض ──► ربح | خسارة

عرض سعر:
  مسودة ──► مراجعة تجارية ──► مراجعة مالية ──► معتمد ──► مُرسَل ──► مقبول
  (draft) (commercial_review) (finance_review) (approved)  (sent)   (accepted)
   SALES_REP    SALES_MGR          CFO        CFO/GM*    SALES_REP  SALES_MGR
                                                              │
                                                              ├──► مرفوض + سبب (rejected · SALES_MGR)
                                                              └──► منتهٍ تلقائياً (expired · النظام)
   * GM إن حمل أي سطر استثناءً تحت الحد الأدنى (40 §C2)

عقد:
  مسودة ──► موقَّع ──► ساري ──► [معلَّق] ──► منتهٍ ──► مجدَّد (عقد جديد · القديم ينتهي)
  (draft)  (signed)  (active) (suspended) (expired)  (renewed — حالة نهائية)
  SALES_REP   GM       CFO     CFO/GM       النظام    SALES_MGR
                        ▲          │
                        └──────────┘ رفع التعليق: GM أو CFO بسبب مسجَّل
                        │
                        └──► منهى + سبب + إشعار (terminated · GM — حالة نهائية)
```

> **الأدوار والأحداث الكاملة لهذه الآلات في §0-1 · §0-2 · §0-3.**

## 1-1 الضوابط الإلزامية

| الضابط | السلوك عند المخالفة |
|---|---|
| لا عرض بلا حساب مؤهَّل بسجل تجاري | يُرفض الإنشاء |
| **كل سطر ≥ الحد الأدنى للخدمة** | يُرفض الحفظ · يُعرض الحد الأدنى · يُعرض مسار طلب استثناء |
| استثناء تحت الحد الأدنى | يتطلب: سبب · مدة · موعد مراجعة · **اعتماد GM حصراً** |
| العرض المُرسَل لا يُعدَّل | التعديل ينشئ **نسخة جديدة**؛ الأصل يبقى مجمَّداً |
| لا عقد بلا قائمة أسعار مرتبطة | يُرفض التفعيل |
| بنود **DL-11/12/13/14/18** (محاولة فاشلة · إرجاع · انتظار · إعادة جدولة بطلب المستلم · تسليم جزئي) | **عَلَم عقد، افتراضه OFF** (EXEC §1.1 · 40 §C4 INV-C4-8). إن لم يُعلَّم، **لا تُفوتر** — وتظهر كإيراد ضائع في تقرير الاستثناءات.<br>الأعلام في `sales.contracts`: `bills_failed_attempt` · `bills_return` · `bills_waiting` (موجودة في 01) + **`bills_reschedule` · `bills_partial_delivery` (تُضاف في 13B — v4)** |
| عقد منتهٍ | لا أوامر جديدة · تنبيه قبل الانتهاء بمدة الإشعار |

## 1-2 الوثائق المولَّدة

| الانتقال | الوثيقة |
|---|---|
| عرض ← معتمد | عرض السعر PDF بترويسة الكيان + ملحق الأسعار |
| عقد ← موقَّع | نسخة العقد + ملحق الأسعار المجمَّد |
| عميل ← نشط تشغيلياً | **بطاقة تعريف العميل** (كود · خدماته · مسؤول حسابه · أرقام الطوارئ) |

---

# 2. المستودع (PST) — دورة الاستلام

```
أمر إدخال (ASN):
 مسودة ──► معتمد ──► قيد الاستلام ──► مستلم ──► مخزَّن ──► مقفل
 (draft)  (approved)  (receiving)  (received) (putaway)  (closed)
 WH_OP    WH_MGR      WH_OP/PDA    WH_OP/PDA  WH_OP/PDA  WH_SUP
        │                                                  │
        └──► ملغى + سبب (cancelled · WH_MGR)   حدث فوترة: HD-01..HD-10
```

> **الأدوار والأحداث الكاملة في §0-4.**

## 2-1 خطوات التنفيذ بالـ PDA

| # | الشاشة | المسح | الضابط |
|---|---|---|---|
| 1 | استلام | مسح رقم الأمر | الأمر معتمد؟ وإلا رفض |
| 2 | — | مسح الصنف (باركود) | الصنف يخص هذا العميل؟ **خلط عميلين مرفوض** |
| 3 | — | كمية · دفعة · صلاحية | صلاحية متبقية ≥ الحد الأدنى للاستلام؟ وإلا حجر |
| 4 | — | التقاط صورة | إلزامي عند وجود فرق أو تلف |
| 5 | تخزين | مسح المنصة → النظام يقترح الموقع | يراعي: شروط التخزين · تخصيص العميل · السعة |
| 6 | — | مسح الموقع للتأكيد | موقع غير مطابق للاقتراح → يتطلب سبباً |
| 7 | إقفال | — | **سطر مفتوح واحد يمنع الإقفال** مع ذكر عددها |

## 2-2 الحالات الاستثنائية

| الحالة | المعالجة |
|---|---|
| كمية تخالف المطلوب | **سبب الفرق إلزامي** · السطر لا يُحفظ بدونه · يُبلَّغ العميل تلقائياً |
| بضاعة تالفة عند الوصول | إلى منطقة التالف · صورة إلزامية · تقرير تلف يُولَّد ويُرسل |
| صنف غير مسجَّل | إلى الحجر · يُفتح طلب تسجيل صنف · لا يدخل المخزون قبل اكتماله |
| صلاحية أقل من الحد | حجر + قرار العميل خلال 48 ساعة، وإلا إرجاع |
| وصول بلا أمر مسبق | يُنشأ أمر طارئ بعلامة `unplanned` · يُخطَر مدير المستودع |

## 2-3 الوثائق المولَّدة

| الانتقال | الوثيقة |
|---|---|
| ← مستلم | **إشعار استلام بضاعة (GRN)** بالكميات الفعلية والفروق |
| فرق أو تلف | **تقرير تباين** يُرسل للعميل تلقائياً |
| ← مقفل | تحديث كشف مخزون العميل في نافذته |

---

# 3. المستودع — دورة الصرف

```
أمر صرف:
 مسودة ──► فحص الشروط ──► معتمد ──► مخصَّص ──► قيد الالتقاط ──► ملتقط ──► مدقَّق ──► معبّأ ──► محمَّل ──► مُرسَل ──► سُلِّم
 (draft) (checks_pending)(approved)(allocated) (picking)    (picked) (checked) (packed) (loaded)(dispatched)(delivered)
 WH_OP    النظام آلياً    WH_MGR   النظام+WH_SUP  WH_OP      WH_OP   WH_OP آخر*  WH_OP   WH_OP   WH_SUP    النظام (من TMS)
                │              │                                                                      │
                ├─► مرفوض ائتمانياً (credit_rejected · النظام)                       حدث فوترة: OF-01..OF-11
                │              └─► مخصَّص جزئياً (partially_allocated · النظام)       → مهمة توصيل في TMS
                └─► ملغى + سبب (cancelled · WH_MGR — من أي حالة قبل «محمَّل»)

 * المدقّق ≠ الملتقط (INV-C3-6) — التجاوز بيد WH_SUP بسبب مسجَّل يظهر في تقرير شهري (EXEC §1.2 FIXED)
```

> **«فحص الشروط العشرة» حارس على الانتقال `مسودة→معتمد`، والرفض الائتماني سببُ فشلِ الحارس** — وقد أُبقيتا حالتين مرئيتين هنا وتُضافان إلى قيد `check` في 13B (v4). الأدوار والأحداث الكاملة في **§0-5**.

## 3-1 فحص الشروط العشرة قبل الاعتماد

كل شرط يُفحص آلياً؛ الفشل يوقف الأمر **ويذكر السبب المحدد**:

| # | الشرط | الرسالة عند الفشل |
|---|---|---|
| 1 | العقد ساري | «عقد العميل منتهٍ في [تاريخ] — يلزم التجديد» |
| 2 | لا حجز ائتماني | «العميل تحت حجز ائتماني: [السبب]» |
| 3 | الرصيد كافٍ | «المتاح [كمية] فقط من المطلوب [كمية] في [موقع]» |
| 4 | الصنف يخص العميل | «الصنف [كود] مسجَّل لعميل آخر» |
| 5 | الصلاحية المتبقية كافية | «الدفعة [رقم] صلاحيتها [أيام] أقل من الحد [أيام]» |
| 6 | الصنف غير موقوف | «الصنف موقوف: [السبب]» |
| 7 | الموقع غير محجوب | «الموقع [كود] محجوب: [السبب]» |
| 8 | العنوان مكتمل (إن كان للتوصيل) | «عنوان التسليم ناقص: [الحقول]» |
| 9 | سعر الخدمة موجود | «لا سعر لخدمة [كود] في عقد العميل» |
| 10 | الكمية ضمن حد الطلب | «الكمية تتجاوز الحد المتفق [كمية]» |

## 3-2 التخصيص (Allocation)

| القاعدة | التطبيق |
|---|---|
| سياسة الصرف | FEFO افتراضياً للأصناف ذات الصلاحية · FIFO لغيرها · LIFO باستثناء معتمد |
| الحجز | التخصيص يرفع `qty_allocated` — الكمية محجوزة ولا تُصرف لأمر آخر |
| تسلسل الالتقاط | يُرتَّب بالمسار الأقصر في المستودع لا بترتيب السطور |
| الفشل الجزئي | الأمر يبقى **«مخصَّص جزئياً» (`partially_allocated`)** · ينبّه المشرف · لا يُقفل تلقائياً. **الجزئية تُمثَّل على السطر** في `wms.order_lines.status = 'partial'` (موجود في 01)، و`partially_allocated` على الأمر مؤشر تجميعي لها (v4 — OPS-18) |

## 3-3 الوثائق المولَّدة

| الانتقال | الوثيقة |
|---|---|
| ← معتمد | **قائمة التقاط** (Pick List) بالتسلسل الأمثل |
| ← مدقَّق | **إذن صرف / بوليصة تسليم** برقمها |
| ← محمَّل | **مانيفست الحمولة** للسائق |
| ← مُرسَل | إشعار في نافذة العميل + رابط تتبّع |

---

# 4. المستودع — الجرد

```
جرد: مسودة ──► قيد التنفيذ ──► مراجعة الفروق ──► تسوية ──► مقفل
    (draft)  (in_progress)     (review)      (adjusted)  (closed)
    WH_SUP    WH_OP/PDA         WH_SUP       WH_MGR يعتمد  WH_SUP
                                   ▲   │
                    إعادة عدّ ⟳ ────┘   └──► فرق بلا تفسير → تصعيد إلى WH_MGR
                    (recount · WH_OP — عدّاد آخر)
```

> **إعادة العدّ انتقال دائري إلزامي على `review`** — وهي في 40 §C3 **أمر `Recount` لا حالة**، وتُسجَّل على `wms.inventory_count_lines`. أُبقيت مرئية هنا وتُضاف إلى قيد `check` في 13B (v4 — OPS-21). الأدوار والأحداث في **§0-6**.

| البند | القاعدة |
|---|---|
| أنواع الجرد | كامل (سنوي) · دوري (Cycle — يومي/أسبوعي حسب تصنيف ABC) · موضعي |
| تجميد الحركة | الموقع قيد العدّ محجوب عن الصرف حتى الإقفال |
| العدّ الأعمى | العدّاد **لا يرى الرصيد النظامي** — يمنع التحيّز |
| إعادة العدّ | إلزامية لأي فرق قبل التسوية |
| التسوية | حركة `adjust` في الدفتر بسبب إلزامي + **اعتماد WH_MGR** — لا تعديل رصيد مباشر |
| مؤشرات | دقة الجرد % · عدد الفروق بلا تفسير · مدة الجرد |

---

# 5. التوصيل (PDL / POR)

```
مهمة توصيل:
 مُنشأة ──► مُسندة ──► خرجت ──► سُلِّمت ✓
 (created) (assigned)(out_for_delivery)(delivered)
 النظام/DEL_SUP  DEL_MGR   DRIVER        DRIVER
                   ▲    │
                   │    ├──► فشلت (failed · DRIVER) ──⟳── مُسندة (attempt_no < 2 · DEL_SUP)
                   │    │         └──► فشلت مرة ثانية ──► مرتجعة (returned · DEL_SUP)
                   │    └──► مؤجَّلة بطلب المستلم (deferred · DRIVER)
                   └───────────── مُسندة بتاريخ جديد (DEL_SUP)

 ──► ملغاة (cancelled · DEL_MGR) — من أي حالة قبل «سُلِّمت»
```

> **«محاولة 2» عدّاد `attempt_no` لا حالة** (v4 — OPS-22). و`deferred` مذكورة في 40 §C4 وتُضاف إلى قيد `check` في 13B. **حاجز صلب INV-C4-1:** سائق بإقامة/رخصة منتهية أو مركبة بوثيقة منتهية **لا يُسند**. الأدوار والأحداث في **§0-7**.

## 5-1 دورة اليوم

| الوقت | الخطوة | المنفّذ |
|---|---|---|
| مساء اليوم السابق | بناء خطة التوزيع (مناطق · أحمال · تدوير) | النظام + DEL_MGR |
| صباحاً | تسليم الأقفاص بالمسح | DEL_SUP + السائق |
| — | بدء المسار — الحالة «خرجت» تلقائياً عند أول مسح | السائق |
| أثناء اليوم | تحديث كل محاولة لحظياً | السائق (PDA) |
| مساءً | إقفال المسار · معالجة الفشل · تسليم COD | DEL_SUP |
| ليلاً | مصالحة + توليد أحداث الفوترة | النظام |

## 5-2 ضوابط إثبات التسليم (POD)

| الضابط | لماذا |
|---|---|
| إحداثيات GPS إلزامية عند التسليم | إثبات الموقع |
| توقيع المستلم أو صورة — أحدهما إلزامي | إثبات الاستلام |
| اسم المستلم وصلته | إثبات الشخص |
| ختم زمني من الخادم لا من الجهاز | يمنع التلاعب بساعة الجهاز |
| **فشل بلا سبب من القائمة مرفوض** | يمنع «فشل» بلا تفسير |
| COD: المبلغ المحصَّل = المستحق وإلا فرق مفتوح | يمنع ضياع النقد |

## 5-3 الفوترة من التوصيل

| الحدث | الخدمة | شرط الفوترة |
|---|---|---|
| تسليم ناجح | DL-01 / DL-02 | دائماً |
| نفس اليوم | DL-07 | إضافي |
| موعد محدد | DL-08 | إضافي |
| خارج الدوام | DL-09 | إضافي |
| **محاولة فاشلة** | DL-11 | **فقط إن `bills_failed_attempt = true` في العقد** |
| **إرجاع** | DL-12 | **فقط إن `bills_return = true`** |
| **انتظار** | DL-13 | **فقط إن `bills_waiting = true`** |
| **إعادة جدولة بطلب المستلم** (`deferred`) | **DL-14** | **فقط إن `bills_reschedule = true`** (عَلَم يُضاف في 13B — v4) |
| **تسليم جزئي** | **DL-18** | **فقط إن `bills_partial_delivery = true`** (عَلَم يُضاف في 13B — v4) |
| COD | DL-10 | حسب العقد: مبلغ ثابت أو نسبة |

**تقرير الإيراد الضائع الشهري:** يحصر كل حدث لم يُفوتر لغياب بند تعاقدي، بقيمته التقديرية. هذا التقرير وحده يبرّر إعادة التفاوض على العقود.

---

# 6. الكول سنتر (PCC)

## 6-1 نوعا العميل

| النوع | الوصف | الفوترة |
|---|---|---|
| **داخلي** | طوابير لكيانات المجموعة (استفسارات الشحنات · شكاوى التوصيل) | سعر تحويلي داخلي · معاملة بينية |
| **خارجي** | عميل يشتري خدمة كول سنتر/بدالة فقط | حسب نموذج التسعير المعتمد |

## 6-2 دورة التذكرة

```
مفتوحة ──► قيد المعالجة ──► [بانتظار العميل | بانتظار قسم داخلي] ──► محلولة ──► مغلقة
 (open)    (in_progress)   (pending_client | pending_internal)   (resolved)  (closed)
 CC_AGENT    CC_AGENT              CC_AGENT                       CC_AGENT  النظام/CC_MGR
                  ▲                         │                                     │
                  │                   تصعيد عند 80% من SLA → CC_MGR                │
                  └──── إعادة فتح (reopened · CC_MGR · خلال 7 أيام) ◄──────────────┘
                        ثم تعود إلى «قيد المعالجة»
```

> **`reopened` ليست حالة نهائية — مخرجها `in_progress`** (v4 — OPS-30). الأدوار والأحداث في **§0-9**.

| الضابط | القاعدة |
|---|---|
| زمن الاستجابة الأولى | حسب الأولوية: عاجل 15 د · عالٍ ساعة · عادي 4 ساعات |
| التصعيد التلقائي | عند تجاوز 80% من مهلة SLA → تنبيه المشرف |
| الربط بالتشغيل | التذكرة عن شحنة تُربط بـ `delivery_tasks` — **الوكيل يرى حالة الشحنة الحقيقية لا يسأل عنها** |
| الإقفال | يتطلب حقل «الحل» — لا إقفال بلا نص |
| الرضا | استبيان تلقائي بعد الإقفال |

## 6-3 مؤشرات وفوترة PCC

| المؤشر | الخدمة المرتبطة |
|---|---|
| عدد المكالمات المُجابة | CC-01 بالمكالمة |
| دقائق المحادثة | CC-02 بالدقيقة |
| عدد المقاعد المخصّصة | CC-03 بالمقعد/شهر |
| التذاكر المعالَجة | CC-04 بالتذكرة |
| المكالمات الصادرة (حملات) | CC-05 بالمكالمة |
| نسبة الرد · متوسط زمن المعالجة · نسبة التخلي | مقاييس SLA |

---

# 7. الموارد البشرية

```
طلب قوى عاملة: مسودة ──► بانتظار الاعتماد ──► معتمد ──► قيد التنفيذ ──► مكتمل
   (hr.manpower_requests.status: draft · pending_approval · approved · in_progress · completed · rejected · cancelled)
   الطالب              مدير القسم               GM*          النظام        GM

استقدام: 17 مرحلة تبدأ بـ work_permit — لكل مرحلة stage_owner (NOT NULL) و sla_days
   (hr.recruitment_cases.stage — 40 §C7 · 10 §الاستقدام · القائمة الإنجليزية الثابتة يضبطها 13B)
   المالك = stage_owner · التأخر = completed_at is null and now() > due_at · التصعيد إلى GM

إجازة: طلب ──► موافقة المشرف ──► موافقة مدير القسم ──► معتمدة ──► منفَّذة
   (admin.approval_requests · request_type = 'leave': pending → approved | rejected)

انضباط: واقعة ──► تحقيق ──► قرار (تنبيه · إنذار · خصم · إنهاء) ──► تنفيذ ──► أرشفة
   (hr.disciplinary_cases.status: draft · issued · grievance_filed · upheld · cancelled · applied · carried_forward)
   سلطة التوقيع هرمية: مشرف D1–D2 · مدير D1–D3 · GM D1–D4 (الفصل GM فقط)
   التظلّم خلال 7 أيام ويُرفع إلى المستوى الأعلى من الموقّع

رواتب: حساب ──► مراجعة GM* ──► اعتماد CFO ──► إقفال الشهر ──► صرف
   النظام      GM*            CFO             CFO            CFO

 * `HR_MGR` غير مشغول (40 §B1) — الصلاحية لدى `GM` حتى التعيين (v4 — OPS-67)
```

> الاستقدام في 03 كان **ثماني مراحل** والحاكم **17 مرحلة** (40 §C7) — صُحِّح في v4 (OPS-68). الحالات والأدوار الكاملة في **§0-11**.

| الضابط | القاعدة |
|---|---|
| إقفال الشهر | يجمّد الحركات ولا يحذفها · لا تعديل بأثر رجعي بعد الإقفال |
| **تجديد الوثائق** | **سلّم التنبيه الواحد: 90 · 45 · 30 · 15 يوماً** قبل الانتهاء (40 §C7 — الحاكم · R-06) · **موظف بوثيقة منتهية لا يُسند لمهمة** (حاجز صلب INV-C4-1). الحالات **مشتقة من `expiry_date` لا مخزَّنة** |
| تخصيص العميل | كل موظف تشغيلي له `assigned_client_id` — أساس تكلفة العمالة المباشرة في الربحية |
| الانضباط | كل قرار مرتبط بواقعة موثّقة — لا خصم بلا سجل |

---

# 8. الأسطول

```
مركبة: مسجَّلة ──► نشطة ──► [صيانة | متوقفة | معطّلة] ──► نشطة ──► مستبعدة
     (registered)(active) (maintenance|idle|out_of_service)(active)(disposed — نهائية)
      FLEET_MGR  FLEET_MGR         FLEET_MGR              FLEET_MGR     GM

وثيقة (مركبة أو موظف): حالات **مشتقة من expiry_date لا مخزَّنة**
       سارية ──► تنبيه 90 ──► 45 ──► 30 ──► 15 ──► منتهية ──► مجدَّدة
       سلّم واحد: 90/45/30/15 يوماً (40 §C7 — الحاكم)
       FLEET_MGR للمركبات · GM للموظفين (HR_MGR غير مشغول)

وقود: طلب ──► صرف ──► تسجيل العداد (إلزامي — INV-C4-9) ──► مطابقة شهرية
      DRIVER    DRIVER        DRIVER                        FLEET_MGR
      (tms.fuel_ledger — لا عمود حالة · انحراف > 20% عن متوسط 90 يوماً ⇒ is_anomaly)
```

> «مسجَّلة» فعل الإنشاء و«معطّلة» عطل فني — **تبقيان مرئيتين هنا وتُضافان إلى قيد `check` في 13B (v4)**؛ و`idle` (متوقفة) كانت في القاعدة وغائبة عن 03 وأُضيفت (OPS-19). الأدوار والأحداث في **§0-8**.

| الضابط | القاعدة |
|---|---|
| **مركبة بوثيقة منتهية لا تُسند لمهمة** | حاجز صلب — ليس تنبيهاً |
| تسجيل العداد إلزامي مع كل تعبئة | يكشف الاستهلاك الشاذ |
| استهلاك شاذ | انحراف > 20% عن معدل المركبة → تنبيه + تحقيق |
| الصيانة الدورية | بالكيلومترات لا بالتاريخ · تنبيه قبل 500 كم |

---

# 9. المحاسبة — دورة الإيراد

```
حدث تشغيلي مُقفل
      ▼ (تلقائي)
حدث قابل للفوترة ──► مُسعَّر ──► مسودة فاتورة ──► مراجعة ──► معتمدة* ──► مُرسَلة ──► مسدَّدة جزئياً ──► مسدَّدة
   (pending)      (priced)     (draft)      (review)  (approved)   (sent)  (partially_paid)   (paid)
    النظام         النظام        النظام        CFO    النظام ≤500 · CFO فوقها  CFO      PRO           PRO
      │                  │                     │                   │
      ├─► مستبعد        └─► بلا سعر → تقرير    └─► ملغاة (void·CFO) └─► متأخرة (overdue) → حجز ائتماني
      │   (excluded·CFO)     الاستثناءات (CFO)
      └─► متنازع عليه (disputed · CFO)
```

> **`partially_paid` و`void` موجودتان في القاعدة وكانتا غائبتين عن 03 — أُضيفتا في v4** (OPS-23). الأدوار والأحداث في **§0-10**.

`*` **الاعتماد آلي عند `total ≤ 500 KWD`** (سقف `thresholds.invoice.auto_approve_max` — EXEC §1.1)، وما فوقه **قرار `CFO`**. وإشعار الدائن **`GM` حصراً ولا يُعتمد آلياً أبداً**.

`*` **رقم الفاتورة يُخصَّص لحظة الاعتماد فقط.** لا رقم قبله، ولا اعتماد بلا رقم — مفروض بقيد في القاعدة.

## 9-1 الضوابط غير القابلة للتفاوض

| الضابط | لماذا |
|---|---|
| الفاتورة من أحداث مسجَّلة فقط — **لا إدخال يدوي** | الفاتورة اليدوية غير قابلة للإثبات أمام العميل |
| رقم الفاتورة ذرّي ولا يُعاد استخدامه | متطلب محاسبي وضريبي |
| الفاتورة المعتمدة لا تُعدَّل | التصحيح **بإشعار دائن فقط** — يمنع التلاعب بأثر رجعي |
| كل سطر يحمل مصدر سعره | يحسم أي نزاع في ثوانٍ |
| **لا فوترة بسعر صفر أو مفقود** | تتوقف الدورة وتُرفع للمدير المالي — يمنع الإيراد الضائع الصامت |
| المعاملة البينية معلَّمة | تُحذف عند تجميع حسابات المجموعة |

## 9-2 دورة الشهر

| # | الخطوة | المسؤول |
|---|---|---|
| 1 | إقفال أحداث الشهر · لقطة الإشغال الأخيرة | النظام |
| 2 | تسعير الأحداث · تقرير الاستثناءات | النظام |
| 3 | معالجة الاستثناءات (بلا سعر · بلا عقد · تحت الحد) | CFO |
| 4 | احتساب غرامات SLA | النظام |
| 5 | توليد المسودات لكل عميل ولكل كيان | النظام |
| 6 | مراجعة ومطابقة بالتقارير التشغيلية | CFO |
| 7 | **الاعتماد** → تخصيص الأرقام → توليد PDF | CFO |
| 8 | الإرسال + الإشعار في نافذة العميل | CFO |
| 9 | تخصيص التكاليف · احتساب الربحية | COST_ANALYST |
| 10 | مراجعة العقود تحت حد الهامش | GM |

---

# 10. المحاسبة — التحصيل والائتمان

```
فاتورة مُرسَلة ──► مستحقة ──► [تذكير 1 · تذكير 2 · تذكير نهائي] ──► متأخرة
      │                                                                  │
      ▼                                                                  ▼
  سداد جزئي ──► سداد كامل ──► مطابقة بنكية (حدث لا حالة)         حجز ائتماني تلقائي
 (partially_paid) (paid)      billing.reconciliation.matched       sales.account.hold_set
     PRO            PRO              **CFO** (مالك I-08 — R-04)        النظام
```

> **المطابقة البنكية ليست حالة فاتورة** — هي حدث على `billing.receipt_allocations` مالكه **`CFO`**؛ وحالة «مقفلة» حُذفت من آلة الفاتورة في v4 (OPS-23).

| البند | القاعدة |
|---|---|
| التذكيرات | آلية: قبل الاستحقاق 3 أيام · عند الاستحقاق · +7 · +15 · +30 |
| الحجز الائتماني | تلقائي عند تجاوز الحد أو تأخر > المدة المتفقة · **يمنع أوامر الصرف الجديدة فوراً** |
| رفع الحجز | **GM أو CFO فقط** · بسبب مسجَّل · بمدة محددة |
| **الحجز على مستوى المجموعة** | العميل المحجوز محجوز لدى الكيانات الأربعة — لا يلتف عبر كيان آخر |
| أعمار الذمم | 0-30 · 31-60 · 61-90 · +90 — محدَّثة يومياً |
| تخصيص السداد | ضد فواتير محددة · لا سداد «عائم» بلا تخصيص أكثر من 7 أيام |

---

# 11. نافذة العميل

```
طلب من العميل ──► مُستلم في النظام ──► فحص الشروط ──► مقبول ──► تنفيذ ──► إثبات
                                            │
                                            └──► مرفوض + سبب واضح للعميل
```

| ما يفعله العميل | القيد |
|---|---|
| إنشاء أمر استلام (ASN) | يمر بنفس فحص الشروط الداخلي |
| إنشاء أمر صرف | يُرفض فوراً عند الحجز الائتماني مع ذكر السبب |
| متابعة المخزون والحركات | بياناته فقط — مفروض بـ RLS |
| تتبّع الشحنات وإثبات التسليم | — |
| الفواتير وكشف الحساب وأعمار الذمم | لكيانه المتعاقد معه + كشف موحّد |
| فتح شكوى | تُنشئ تذكرة في PCC تلقائياً |
| تصدير التقارير | — |

**لا يرى أبداً:** عملاء آخرين · تكاليفكم أو هوامشكم · بيانات الموظفين · أسعار غيره.

---

# 12. جدول الأحداث والوثائق الموحّد

**القاعدة 2 بصيغتها الدقيقة (v4):** **كل انتقال يُكتب في `platform.outbox`** (الجدول الحاكم للأحداث — R-02؛ `platform.domain_events` محذوف)، وما يلي منه هو **الأحداث ذات المشتركين** (فوترة · وثائق · تنبيهات · تدقيق). التسمية `<module>.<aggregate>.<past_tense>` (40 §B3). ما أُكمل في v4 معلَّم `v4` — سابقاً كان الجدول يحصي **19 حدثاً فقط لأكثر من 45 انتقالاً** (OPS-25).

| الحدث | الوثيقة المولَّدة | حدث الفوترة |
|---|---|---|
| `sales.lead.created` · `contacted` · `qualified` · `converted` · `lost` (v4) | — | — |
| `sales.opportunity.created` · `staged` · `won` · `lost` (v4) | — | — |
| `sales.quote.drafted` · `submitted` · `sent_to_finance` (v4) | — | — |
| `sales.quote.approved` | عرض سعر PDF | — |
| `sales.quote.sent` · `accepted` · `rejected` · `expired` (v4) | — | — |
| `sales.contract.signed` | العقد + ملحق الأسعار | — |
| `sales.contract.activated` · `suspended` · `resumed` · `expired` · `renewed` · `terminated` (v4) | بطاقة تعريف العميل عند التفعيل | — |
| `sales.contract.expiring` | إشعار تجديد | — |
| `sales.account.hold_set` | إشعار حجز ائتماني | — |
| `wms.inbound.drafted` · `approved` · `receiving_started` (v4) | قائمة استلام | — |
| `wms.inbound.received` | إشعار استلام GRN | HD-01..HD-10 |
| `wms.inbound.putaway` · `closed` · `cancelled` (v4) | تحديث كشف مخزون العميل | — |
| `wms.inbound.variance` | تقرير تباين | — |
| `wms.outbound.drafted` · `checks_started` · `credit_rejected` (v4) | — | — |
| `wms.outbound.approved` | قائمة التقاط | — |
| `wms.outbound.allocated` · `partially_allocated` · `picking_started` · `picked` (v4) | — | — |
| `wms.outbound.checked` | إذن صرف / بوليصة تسليم | OF-01..OF-11 |
| `wms.outbound.packed` (v4) | — | — |
| `wms.outbound.loaded` | مانيفست الحمولة | — |
| `wms.outbound.dispatched` · `delivered` · `cancelled` (v4) | إشعار في نافذة العميل + رابط تتبّع | — |
| `wms.count.drafted` · `started` · `under_review` · `recount_ordered` · `adjusted` (v4) | — | — |
| `wms.count.closed` | تقرير الجرد | — |
| `wms.occupancy.snapshot` | — | **ST-01..ST-14 (يومي)** — `ST-13` من **مدة العقد** لا من اللقطة · **`ST-14` من `wms.space_reservations`** لا من اللقطة (v4 — OPS-27) |
| `tms.task.created` · `assigned` · `out_for_delivery` · `reassigned` · `deferred` · `cancelled` (v4) | مانيفست السائق عند الإسناد | **DL-14** عند `deferred` (بشرط العقد) |
| `tms.task.delivered` | إثبات تسليم POD | **DL-01/02 (+ DL-07 · DL-08 · DL-09 · DL-10 حسب خصائص المهمة)** — مطابقةً لـ40 §C4 (v4 — OPS-28) |
| `tms.task.failed` | تقرير محاولة فاشلة | DL-11 (بشرط العقد) |
| `tms.task.returned` | إشعار إرجاع | DL-12 (بشرط العقد) |
| `tms.vehicle.registered` · `activated` · `in_maintenance` · `idled` · `out_of_service` · `returned_to_service` · `disposed` (v4) | — | — |
| **`tms.vehicle.handed_over`** (v4 — كان `fleet.handover`؛ `fleet` ليس موديولاً والأسطول M09 داخل `tms` · OPS-26) | نموذج تسليم مركبة | — |
| `cc.ticket.created` · `started` · `waiting_client` · `waiting_internal` · `closed` · `reopened` (v4) | — | — |
| `cc.ticket.resolved` | ملخص التذكرة | CC-01..CC-05 |
| `billing.event.recorded` · `priced` · `excluded` · `disputed` · `invoiced` (v4) | تقرير الاستثناءات | — |
| `billing.invoice.drafted` · `under_review` (v4) | — | — |
| `billing.invoice.approved` | **الفاتورة + ورقة التفصيل** | — |
| `billing.invoice.sent` · `partially_paid` · `paid` · `overdue` · `voided` (v4) | كشف حساب · إشعار تأخر | — |
| `billing.receipt.recorded` | سند قبض (سلسلة `RCT`) | — |
| `billing.reconciliation.matched` (v4) | كشف مطابقة بنكية — مالكه **`CFO`** | — |
| `billing.credit_note.approved` | إشعار دائن (**`GM` حصراً**) | — |
| `hr.manpower_request.*` (v4) | نموذج طلب قوى عاملة | — |
| `hr.recruitment.stage_changed` (v4) | ملف المرحلة + مهلتها | — |
| `hr.leave.approved` | نموذج إجازة | — |
| `hr.discipline.decided` | إنذار / إخطار خصم | — |
| `hr.document.expiring` (v4) | تنبيه تجديد — **90/45/30/15 يوماً** | — |
| `hr.payroll.closed` (v4) | كشف الرواتب المعتمد | — |
| `imile.shipment.*` · `imile.plan.approved` (v4) | خطة الفرز اليومية | — |

**ورقة التفصيل مع الفاتورة** هي ما يمنع النزاعات: تحصر كل حدث بتاريخه ومرجعه وسعره المطبَّق ومصدر ذلك السعر.
