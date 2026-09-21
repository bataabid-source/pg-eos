# إدارة مساحات التخزين — المساحة كمنتج
**وثيقة 17 · PG-EOS · الإصدار 4.0 · 21/09/2026**

> **v4 — حالة الوثيقة:** مرجعية · **الحاكم عند التعارض:** 40 §C3 · EXECUTION-MASTER-v4 §1.1 · 19 §3-4 (الأرقام المخزنية) · 01/13/13B/019 · **التصحيحات المطبّقة في v4:** OPS-48, OPS-59, OPS-60, OPS-67 · **القرارات المفتوحة سابقاً:** مُغلقة في EXECUTION-MASTER-v4 §1.

> **الأرقام المخزنية (الطاقات والأبعاد والمواقع) مرجعها 19 §3-4 «الجدول الرقمي الحاكم»** — هذه الوثيقة تصف **النموذج التجاري للمساحة** لا أرقام المخزن.

---

# 1. الفجوة الدقيقة

| موجود بالفعل | ناقص |
|---|---|
| المواقع الـ3,330 بأكوادها وأنواعها | **المساحة كمنتج يُباع**: متاح · متعاقد · محجوز · مؤجَّر · معطّل |
| `assigned_client_id` على الموقع | الفرق بين **المتعاقد عليه** و**المشغول فعلاً** |
| لقطة الإشغال اليومية | **الشاغر القابل للبيع** — وهو غير الشاغر الفعلي |
| رسم التجاوز ST-12 | حجز مساحة لعميل قبل وصول بضاعته |

**السؤال الذي لا يستطيع النظام الإجابة عليه اليوم:**
> «عميل يريد 200 منصة من الشهر القادم — أقدر؟»

الجواب يحتاج: الطاقة − المتعاقد عليه − المحجوز − المعطّل، **لا** الطاقة − المشغول فعلاً. الفرق بينهما هو بالضبط ما يجعل شركات التخزين تبيع مساحة لا تملكها.

---

# 2. المفاهيم الخمسة — التمييز الحاكم

```
الطاقة الإجمالية (Capacity)
  │
  ├── معطّل (Blocked)          صيانة · تلف · ممر · احتياطي تشغيلي
  │
  ├── متعاقد عليه (Contracted)  ملتزَم به في عقد ساري — **سواء استُخدم أو لا**
  │     ├── مشغول فعلاً (Occupied)      فيه بضاعة الآن
  │     └── متعاقد وغير مشغول (Idle)   ← يُفوتر ولا يُستخدم
  │
  ├── محجوز (Reserved)          عرض سعر قائم · عميل قادم · موسم متوقَّع
  │
  └── متاح للبيع (Sellable)     = الطاقة − معطّل − متعاقد − محجوز
```

| المفهوم | الاستخدام |
|---|---|
| **المتعاقد عليه** | أساس الفوترة الثابتة (ST-11 الحد الأدنى) |
| **المشغول فعلاً** | أساس فوترة الاستخدام والتكلفة الحقيقية |
| **الفرق بينهما** | 🚩 عميل يدفع ولا يستخدم (فرصة بيع متقاطع) أو **يستخدم أكثر مما تعاقد** (ST-12) |
| **المحجوز** | يمنع بيع نفس المساحة مرتين |
| **المتاح للبيع** | **الرقم الوحيد الذي يبني عليه البيع قراره** |

---

# 3. المخطط

```sql
-- كتلة المساحة: وحدة البيع والتخصيص (أعلى من الموقع الفردي)
create table wms.space_blocks (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  warehouse_id uuid not null references wms.warehouses(id),
  zone_id uuid references wms.zones(id),
  code text not null,
  block_type text not null,          -- pallet_rack · floor · mezzanine · yard · cold · frozen · secure · hazmat
  -- الطاقة بثلاث وحدات — العقود تختلف
  capacity_pallets numeric(14,3) not null default 0,
  capacity_sqm     numeric(14,3) not null default 0,
  capacity_cbm     numeric(14,3) not null default 0,
  -- الشروط البيئية — تحدد ما يصلح تخزينه
  temp_min numeric(6,2), temp_max numeric(6,2),
  humidity_max numeric(6,2),
  max_stack_height int,
  hazmat_allowed boolean not null default false,
  is_secure boolean not null default false,
  -- التكلفة — أساس هامش المساحة
  monthly_cost numeric(14,3),        -- نصيبها من الإيجار والتشغيل
  status text not null default 'active',
  unique (entity_id, warehouse_id, code)
);

-- ربط المواقع بالكتلة
alter table wms.locations add column if not exists space_block_id
  uuid references wms.space_blocks(id);

-- ⚠️ v4 (OPS-59 · R-06 · R12): حبيبة لقطة الإشغال.
-- `wms.occupancy_snapshots` (01) حبيبتها (تاريخ × كيان × عميل × مستودع) — لا كتلة فيها ولا موقع.
-- وبلا الكتلة لا يمكن اشتقاق الإشغال على مستوى الكتلة إطلاقاً، وأي ربط بـ`wms.locations`
-- على `warehouse_id` يكرّر كل صف لقطة بعدد مواقع الكتلة (288 لكتلة A · 2,718 لكتلة B)
-- فيضخّم `occupied` و`utilization_pct` و`cost_per_occupied_pallet` ويُطلق تنبيه ST-12 دائماً.
-- التصحيح على مستوى الحبيبة لا على مستوى الاستعلام: لقطة لكل كتلة.
alter table wms.occupancy_snapshots add column if not exists space_block_id
  uuid references wms.space_blocks(id);
create index if not exists occupancy_snapshots_block_idx
  on wms.occupancy_snapshots (space_block_id, snapshot_date desc);
-- اللقطة اليومية 00:30 تُكتب صفاً لكل (تاريخ × كيان × عميل × مستودع × كتلة).

-- تعطيل جزء من الكتلة
create table wms.space_blocks_out_of_service (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references wms.space_blocks(id),
  qty_pallets numeric(14,3) not null default 0,
  qty_sqm numeric(14,3) not null default 0,
  reason text not null,              -- maintenance · damage · aisle · operational_buffer · safety
  from_date date not null, to_date date,
  created_by uuid not null
);

-- التخصيص التعاقدي: ما التزمنا به للعميل
create table wms.space_allocations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  contract_id uuid not null references sales.contracts(id),
  client_id uuid not null references sales.accounts(id),
  block_id uuid not null references wms.space_blocks(id),
  alloc_type text not null default 'dedicated',   -- dedicated · shared · overflow
  qty numeric(14,3) not null,
  uom text not null,                 -- pallet · sqm · cbm
  service_id uuid references catalog.services(id),
  valid_from date not null,
  valid_to date,
  min_charge_applies boolean not null default true,   -- يُفوتر حتى لو لم يُستخدم
  status text not null default 'active',
  -- active · expiring · expired · terminated
  created_by uuid not null,
  constraint positive_qty check (qty > 0)
);
create index on wms.space_allocations (block_id, valid_from, valid_to);
create index on wms.space_allocations (client_id, status);

-- الحجز: مساحة موعودة قبل التعاقد
create table wms.space_reservations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  block_id uuid not null references wms.space_blocks(id),
  client_id uuid references sales.accounts(id),
  quote_id uuid references sales.quotes(id),
  opportunity_id uuid references sales.opportunities(id),
  qty numeric(14,3) not null,
  uom text not null,
  reserved_from date not null,
  expires_at date not null,          -- 🔒 الحجز ينتهي تلقائياً
  reason text not null,              -- quote_pending · incoming_client · seasonal_peak · internal
  status text not null default 'active',
  -- active · converted · expired · cancelled
  converted_allocation_id uuid references wms.space_allocations(id),
  reserved_by uuid not null,
  approved_by uuid,
  created_at timestamptz not null default now(),
  constraint reservation_has_expiry check (expires_at > reserved_from)
);
create index on wms.space_reservations (block_id, status, reserved_from);
```

---

# 4. حساب المتاح للبيع

```sql
create or replace function wms.space_availability(
  p_block uuid, p_from date, p_to date default null
)
returns table (
  block_code text, uom text,
  capacity numeric, out_of_service numeric,
  contracted numeric, reserved numeric,
  sellable numeric, occupied_now numeric, idle_contracted numeric
)
language sql stable as $$
  with b as (
    select * from wms.space_blocks where id = p_block
  ),
  oos as (
    select coalesce(sum(qty_pallets), 0) as q
    from wms.space_blocks_out_of_service
    where block_id = p_block
      and from_date <= coalesce(p_to, p_from)
      and (to_date is null or to_date >= p_from)
  ),
  alloc as (
    select coalesce(sum(qty), 0) as q
    from wms.space_allocations
    where block_id = p_block and status = 'active'
      and valid_from <= coalesce(p_to, p_from)
      and (valid_to is null or valid_to >= p_from)
  ),
  resv as (
    select coalesce(sum(qty), 0) as q
    from wms.space_reservations
    where block_id = p_block and status = 'active'
      and reserved_from <= coalesce(p_to, p_from)
      and expires_at >= p_from
  ),
  occ as (
    -- v4 (OPS-59): الاشتقاق مباشرةً من اللقطة بالكتلة — لا ربط بـwms.locations.
    select coalesce(sum(o.pallets_occupied), 0) as q
    from wms.occupancy_snapshots o
    where o.space_block_id = p_block
      and o.snapshot_date = (
        select max(snapshot_date) from wms.occupancy_snapshots
         where space_block_id = p_block)
  )
  select b.code, 'pallet',
         b.capacity_pallets, oos.q, alloc.q, resv.q,
         b.capacity_pallets - oos.q - alloc.q - resv.q,     -- المتاح للبيع
         occ.q,
         greatest(alloc.q - occ.q, 0)                        -- متعاقد وغير مشغول
  from b, oos, alloc, resv, occ
$$;
```

> **تحقق معملي (v4):** نُفِّذ التصحيح على قاعدة `pgeos` الحيّة داخل `begin; … rollback;` بعد تطبيق 01 → 13 → 13B → 019. بلقطة واحدة قيمتها **100 منصة** على كتلة سعتها **288**، أعادت الدالة `occupied_now = 100.000` بالضبط — بينما كانت الصيغة القديمة تضاعفها بعدد مواقع الكتلة. و`sellable = 288.000` و`utilization_pct = 34.7`.

## 4-1 الحارس: لا بيع لمساحة غير موجودة

```sql
-- يُستدعى قبل اعتماد أي تخصيص أو حجز
create or replace function wms.check_space_available(
  p_block uuid, p_qty numeric, p_from date, p_to date
) returns void language plpgsql as $$
declare v_sellable numeric; v_code text;
begin
  select sellable, block_code into v_sellable, v_code
  from wms.space_availability(p_block, p_from, p_to);

  if v_sellable < p_qty then
    raise exception
      'المساحة المتاحة في الكتلة % هي % فقط، والمطلوب %. راجع التخصيصات والحجوزات القائمة.',
      v_code, v_sellable, p_qty;
  end if;
end $$;
```

**هذا الحارس هو جوهر الوثيقة.** بدونه يُباع نفس الرف لعميلين، وتُكتشف المشكلة يوم وصول البضاعة — وقتها الخيار بين إحراج مع عميل أو استئجار مساحة طارئة بخسارة.

---

# 5. المؤشرات والتنبيهات

```sql
-- v4 (OPS-59 · OPS-60): (1) الإشغال من اللقطة بالكتلة مباشرةً — لا ربط بـwms.locations؛
--                       (2) المعطّل (out_of_service) يُطرح من المتاح للبيع — كان مفقوداً
--                           في اللوحة وحدها بينما §2 و§4 يطرحانه، واللوحة هي ما يراه البيع.
drop view if exists wms.space_dashboard;
create view wms.space_dashboard as
select
  w.code as warehouse, b.code as block, b.block_type,
  b.capacity_pallets as capacity,
  coalesce(x.out_of_service, 0) as out_of_service,
  coalesce(a.contracted, 0) as contracted,
  coalesce(r.reserved, 0)   as reserved,
  coalesce(o.occupied, 0)   as occupied,
  b.capacity_pallets
    - coalesce(x.out_of_service,0)
    - coalesce(a.contracted,0)
    - coalesce(r.reserved,0)                              as sellable,
  round(100.0 * coalesce(a.contracted,0) / nullif(b.capacity_pallets,0), 1) as contracted_pct,
  round(100.0 * coalesce(o.occupied,0)   / nullif(b.capacity_pallets,0), 1) as utilization_pct,
  greatest(coalesce(a.contracted,0) - coalesce(o.occupied,0), 0) as idle_contracted,
  b.monthly_cost,
  round(b.monthly_cost / nullif(coalesce(o.occupied,0), 0), 3) as cost_per_occupied_pallet
from wms.space_blocks b
join wms.warehouses w on w.id = b.warehouse_id
left join (select block_id, sum(qty_pallets) out_of_service
             from wms.space_blocks_out_of_service
            where from_date <= current_date
              and (to_date is null or to_date >= current_date)
            group by 1) x on x.block_id = b.id
left join (select block_id, sum(qty) contracted from wms.space_allocations
            where status='active' group by 1) a on a.block_id = b.id
left join (select block_id, sum(qty) reserved from wms.space_reservations
            where status='active' and expires_at >= current_date group by 1) r on r.block_id = b.id
left join (select os.space_block_id, sum(os.pallets_occupied) occupied
             from wms.occupancy_snapshots os
            where os.snapshot_date = current_date - 1
            group by 1) o on o.space_block_id = b.id
where b.status = 'active';
```

## 5-1 الاحتياطي التشغيلي — **7%** صف دائم في `space_blocks_out_of_service` (v4)

**قرار مُغلق (EXECUTION-MASTER-v4 §1.1): «Operational buffer excluded from sale = 7% of capacity».** يُبذر لكل كتلة صف دائم:

```sql
insert into wms.space_blocks_out_of_service
  (block_id, qty_pallets, qty_sqm, reason, from_date, to_date, created_by)
select b.id,
       round(b.capacity_pallets * 0.07, 3),
       round(b.capacity_sqm     * 0.07, 3),
       'operational_buffer', current_date, null, :created_by
  from wms.space_blocks b
 where b.status = 'active';
```

بهذا يصبح **المتاح للبيع في اللوحة مطابقاً لتعريف §2 حرفياً**: الطاقة − معطّل (ومنه الاحتياطي 7%) − متعاقد − محجوز. **النسبة نفسها قابلة للتعديل من `platform.thresholds.space.buffer_pct` بلا نشر.**

> **تحقق معملي (v4):** اللوحة المصحَّحة نُفِّذت على قاعدة `pgeos` داخل `begin; … rollback;` وأعادت الكتل الأربع بأرقامها الصحيحة (`A` 288 · `A1` 12 · `B` 2,718 · `C` 135) و`occupied = 100.000` بلا تضخيم.

| المؤشر | العتبة | الإجراء |
|---|---|---|
| **المتاح للبيع** | — | الرقم الذي يعتمده البيع قبل أي وعد |
| نسبة التعاقد | < 70% | 🚩 مساحة تُدفع تكلفتها ولا تُباع → حملة بيع |
| نسبة التعاقد | > 95% | 🚩 لا مجال لنمو → خطة توسّع أو شريك |
| **متعاقد وغير مشغول** | > 20% | 🟡 فرصة بيع متقاطع · أو مراجعة حجم العقد |
| **مشغول > متعاقد** | أي تجاوز | 🔴 **ST-12 رسم التجاوز: فوترة آلية + تنبيه — لا يتطلب اعتماداً** (EXEC §1.1) |
| حجوزات تنتهي خلال 7 أيام | — | متابعة: تتحول لعقد أم تُحرَّر؟ |
| معطّل | > 10% | صيانة معطّلة تكلّف مالاً — **الاحتياطي التشغيلي 7% مستثنى من هذا القياس** |
| **تكلفة المنصة المشغولة** | مقابل السعر | هامش المساحة الحقيقي |

---

# 6. مسارات العمل

## 6-1 من الفرصة إلى التخصيص

```
فرصة بيع تخزين 200 منصة مبرَّدة
      ▼
🔍 فحص المتاح للبيع في كتل التبريد
      ▼
   ┌────────────────┬──────────────────┐
   ▼                ▼                  ▼
متاح 250        متاح 120           متاح 0
   │                │                  │
   ▼                ▼                  ▼
حجز 200        عرض 120 الآن        شريك (وثيقة 09)
30 يوماً*      + 80 بعد شهر        أو رفض
(* الحد الأقصى المعتمد — EXEC §1.1؛ ما زاد يتطلب CFO)
   │            (حجز مستقبلي)
   ▼
عرض سعر → قبول → عقد
      ▼
تحويل الحجز إلى تخصيص تعاقدي
      ▼ 🔒 الحجز status = 'converted'
التخصيص ساري → الفوترة تبدأ حسب min_charge_applies
```

## 6-2 انتهاء الحجز

```
حجز يقترب من الانتهاء (7 أيام)
      ▼ تنبيه لمسؤول الحساب ومدير المستودع
   ┌──────────┬───────────┬──────────┐
   ▼          ▼           ▼
تحوّل لعقد   تمديد      انتهى
             بسبب       ▼
                  🔓 المساحة تعود للمتاح للبيع آلياً
```

**قاعدة إلزامية: لا حجز بلا تاريخ انتهاء.** الحجز المفتوح يجمّد المساحة إلى الأبد ويظهرها غير متاحة وهي فارغة — وهذا أسوأ من عدم الحجز.

## 6-3 التجاوز (Overflow)

```
لقطة الإشغال اليومية: المشغول > المتعاقد عليه
      ▼
النظام يحسب المنصات الزائدة
      ▼
🔴 تنبيه فوري: مدير المستودع + مسؤول الحساب
      ▼
حدث فوترة تلقائي: ST-12 على الزائد
      ▼
تجاوز مستمر 3 أشهر → ملف لزيادة التعاقد
```

**هذا أحد أكبر مصادر الإيراد الضائع في التخزين.** العميل يزيد بضاعته تدريجياً ولا أحد يلاحظ حتى يمتلئ المخزن.

## 6-4 التعطيل

```
عطل أو صيانة أو تلف
      ▼
تسجيل out_of_service بكمية ومدة وسبب
      ▼ 🔓 يُخصم فوراً من المتاح للبيع
      ▼
🚩 هل هناك تخصيص قائم على الكتلة؟
      → نعم: **نقل إلزامي للبضاعة** + إشعار العميل
      ▼
انتهاء المدة → يعود للمتاح تلقائياً
```

---

# 7. الربط بالفوترة

| الحالة | الخدمة | الاحتساب |
|---|---|---|
| تخزين عادي | ST-01..ST-10 | **لقطة الإشغال اليومية** ÷ أيام الشهر |
| حد أدنى شهري | ST-11 | إن قلّ الاستهلاك عن الحد → الفرق |
| **تجاوز التعاقد** | ST-12 | (المشغول − المتعاقد) لكل يوم تجاوز — **فوترة آلية + تنبيه، بلا اعتماد** (EXEC §1.1) |
| **مساحة محجوزة غير مستخدمة** | ST-14 | **تُفوتر** — **بند إلزامي في كل عقد تخزين** (EXEC §1.1 FIXED). المصدر **`wms.space_reservations`** لا لقطة الإشغال |
| تخزين قصير (< شهر) | ST-13 | باليوم — **المصدر مدة العقد** لا لقطة الإشغال |

**نقطة تعاقدية حُسمت (v4):** إن حجزنا مساحة لعميل ولم يستخدمها **يتحمّلها العميل** — `ST-14` **مبنود إلزامياً في كل عقد تخزين** (EXEC §1.1: «Billed — mandatory clause in every storage contract»). نطاق أحداث التخزين في 03 §12 صار **`ST-01..ST-14`** تبعاً لذلك (OPS-27).

---

# 8. لوحة المساحات

| القسم | المحتوى |
|---|---|
| **نظرة عامة** | لكل مستودع: الطاقة · المتعاقد · المحجوز · المشغول · **المتاح للبيع** |
| حسب النوع | عادي · مبرَّد · مجمَّد · مؤمَّن · خطر · ساحة — كل منها على حدة |
| **الأداء التجاري** | نسبة التعاقد · نسبة الاستخدام · الإيراد لكل منصة · **الهامش** |
| التجاوزات | عملاء يتجاوزون تعاقدهم · القيمة غير المفوترة |
| الخامل | متعاقد وغير مشغول — فرص بيع متقاطع |
| الحجوزات | نشطة · تنتهي قريباً · منتهية |
| العقود | تخصيصات تنتهي خلال 90 يوماً |
| التوقّع | **الإشغال المتوقَّع 6 أشهر** من العقود والحجوزات القائمة |

**التوقّع هو المخرج الأهم إدارياً:** يجيب على «متى أحتاج مخزناً إضافياً أو شريكاً؟» قبل أن تصطدم بالحائط.

---

# 9. صلاحيات

| الدور | الصلاحية |
|---|---|
| `WH_MGR` | التعطيل والتشغيل · نقل البضاعة · **يرى المتاح ولا يرى الأسعار** |
| `SALES_MGR` | يرى المتاح للبيع · **يطلب حجزاً** |
| `CFO` | يعتمد التخصيص التعاقدي · يرى الهامش |
| `GM` | الكل · يعتمد الحجز الطويل والتجاوزات |
| ~~`OPS_DIR`~~ | **المنصب غير مشغول** (40 §B1) — صلاحية «التشغيل والتوقّع» لدى **`WH_MGR` لنطاق المستودع** حتى التعيين (v4 — OPS-67) |
| العميل | **مساحته المخصّصة فقط** — **ولا يرى المواقع التفصيلية** (الافتراض الأمني؛ إعداد لكل عميل — EXEC §1.1) |

---

# 10. القرارات — **مُغلقة في EXECUTION-MASTER-v4 §1.1** (v4)

| # | ما كان مفتوحاً | **القيمة المعتمدة** | المرجع |
|---|---|---|---|
| 1 | الحد الأقصى لمدة الحجز بلا عقد | **30 يوماً**؛ ما زاد يتطلب `CFO` | EXEC §1.1 |
| 2 | من يعتمد الحجز الطويل أو الكبير | **`CFO`** للحجز فوق 30 يوماً · **`GM`** للحجز الطويل والتجاوزات | EXEC §1.1 · §9 أعلاه |
| 3 | هل تُفوتر المساحة المحجوزة غير المستخدمة (ST-14) | **نعم — بند إلزامي في كل عقد تخزين** | EXEC §1.1 |
| 4 | نسبة الاحتياطي التشغيلي المستبعدة من البيع | **7%** من الطاقة — صف دائم `reason='operational_buffer'` (§5-1) | EXEC §1.1 |
| 5 | هل يُسمح بالتجاوز تلقائياً أم يتطلب اعتماداً | **فوترة آلية + تنبيه · لا اعتماد** (ST-12) | EXEC §1.1 |
| 6 | الحد الأدنى لهامش المساحة قبل قبول عقد | **15% تحذير · < 10% يتطلب `GM`**؛ وقاعدة الحد الأدنى للسعر `min_price = standard_cost × 1.15` | EXEC §1.1 |
| 7 | هل يرى العميل مواقع تخزينه التفصيلية | **لا** — الافتراض الأمني؛ إعداد لكل عميل | EXEC §1.1 |

**لا شيء من السبعة يوقف البناء.** وكيل البناء **لا يسأل** عن أي منها — القيمة مكتوبة أعلاه.

---

# ملحق: خريطة الحزمة الكاملة (v4)

| # | الوثيقة | النطاق |
|---|---|---|
| 00 | المخطط الرئيسي | المبادئ · الكيانات · الموديولات |
| 01 | نموذج البيانات | المخطط التنفيذي الأساسي |
| 02 | الأدوار والصلاحيات | **26 دوراً** (R-04) |
| 03 | مسارات العمل | آلات الحالات لكل قسم + **سجل الحالات المرجعي §0** |
| 04 | كتالوج الخدمات | الخدمات بالرموز والوحدات |
| 05 | سيناريوهات العملاء | ١–٨ تشغيلية |
| 06 | المبيعات والمحاسبة | CRM · دورة الإيراد · الربحية |
| 07 | أتمتة iMile | الفرز · التوزيع · التدقيق · الجرد + **ADR-27/ADR-28** |
| ~~08~~ | **متقاعدة** | دليل البناء بالذكاء الاصطناعي → **40-Build-Specification-EN** |
| 09 | الشركاء | التعاقد من الباطن · المطابقة |
| 10 | الموارد البشرية | الاختصاصات · الاستقدام (**17 مرحلة**) · العمولة · المعرّفات |
| 11 | الدورة الإدارية | المشتريات · العهد · الحكومية · الاعتمادات |
| 12 | سيناريوهات المبيعات والإدارة | ٩–٢٠ |
| 13 · 13B | إضافات المخطط · **توحيد الجداول المرجعية** | شركاء · استقدام · عمولات · إداري · قيود الحالات |
| 14 | **إدارة السكن** | العقارات · الأسرّة · الصيانة · التكلفة |
| 15 | **لائحة الجزاءات** | **77 بنداً** (R-05) · 9 فئات · قانون 6/2010 |
| ~~16~~ | **متقاعدة** | تطبيق السائقين → **35-Driver-App-v2** |
| 17 | **إدارة المساحات** | متاح · متعاقد · محجوز · تجاوز |
| 18 · 19 | تدقيق المخطط · **تهيئة المستودع (الحاكم للأرقام: 19 §3-4)** | — |
| 30 · 35 | تطبيق PDA · **تطبيق السائق v2** | — |
| 40 · 36 · 38 · 42 · 22 · EXECUTION-MASTER-v4 | الطبقة الحاكمة | — |

> **الوثائق المتقاعدة في v4 (لا يُحال إليها):** 08 · 16 · 20 · 21 · 24 · 37 · 39 · 43 · DECISIONS-ADDENDUM · BOOTSTRAP-v2/v3.
