-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · الهجرة 019 — تهيئة مخزن WH1 (ميناء عبدالله)
-- الإصدار 4.0 · 21/09/2026 · PostgreSQL 16
--
-- الحاكم: الوثيقة 19 §2 (الترميز) · §2-0 (قاعدة التوليد) · §3-2 (الكتل)
--         · §3-4 (الجدول الرقمي الحاكم) · §4 (التنفيذ) · 40 §C3 · 38 §2.1
-- المرجع: RESOLUTIONS-v4 R-06 · OPS-SCHEMA-NEEDS §2 · 40 Part I
--
-- v4 — ما تغيّر عن 019-Warehouse-Main-Abdullah.sql (الذي يحلّ هذا محلّه):
--   · الكود `MAB` → **`WH1`** (40 §C3 «WH1 fixed data» · 38 §2.1)
--   · المناطق 9 → **11** بأكواد حرف واحد للتخزينية (P · G · M · T) لأن حرف
--     القسم يُشتق بـ`left(zone.code,1)`؛ `PLT`/`MEZ`/`STR` كانت تنتج P/M/S
--     وتكسر الترميز (OPS-05)
--   · الكتل 4 → **8** — الفصل بالطابق (G-B · M-B · T-B) وحدة بيع لا تسمية (OPS-06)
--   · صيغة الكود: `MAB-A-001-L0-P1` (متغيّرة الطول) → **سبع خانات ثابتة**
--     `P3-14-5` (19 §2-0 · OPS-07)
--   · مستويات المنصات `generate_series(0,5)` → **1–6**، المستوى 1 عند القدم (OPS-15ب)
--   · الإنشائية `MAB-B1-001-T1` → **`X-B101-1`** ببادئة `X-` (40 §C3 · OPS-08)
--   · التوليد عبر `wms.generate_locations` (19 §4 بند 5) لا `generate_series` مباشر
--   · الدالة `wms.verify_main_abdullah()` → **`wms.verify_wh1()`**
--
-- الأرقام المحقَّقة — لا يتغيّر منها رقم (19 §3-4):
--   3,153 موقع تخزين (A 288 · A1 12 · B 2,718 · C 135)
--   +  30 منطقة تشغيل أرضية
--   + 147 موقعاً إنشائياً محجوباً (B1 27 · C1 81 · E 39)
--   = 3,330 كوداً · 3,301.641 م³ · 3,830.895 م² · 2,439,750 كجم
--
-- يُطبَّق بعد: 01-Data-Model.sql · 13-Schema-Additions.sql · 13B-Schema-Reference-Consolidation.sql
--   (wms.space_blocks و wms.locations.space_block_id مُعرَّفان في 13B — وبدونهما يفشل §3 و§5)
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. أعمدة الترميز الجديد على wms.locations
--    المصدر: 19 §4 بند 4 · OPS §2-4 · 40 §C3
-- ───────────────────────────────────────────────────────────────────────────

alter table wms.locations add column if not exists section        char(1);      -- P · G · M · T
alter table wms.locations add column if not exists aisle_no       int;          -- 1–9 حصراً
alter table wms.locations add column if not exists position_no    int;          -- 01–99
alter table wms.locations add column if not exists level_no       int;          -- P: 1–6 · G/M/T: 1–3
alter table wms.locations add column if not exists global_level   int;          -- 1–9 مشتق
alter table wms.locations add column if not exists max_volume_cbm numeric(10,5);
alter table wms.locations add column if not exists legacy_code    text;         -- الكود القديم للمطابقة (19 §6)
-- v4: العمودان التاليان يحملان مجاميع 19 §3-4 (الحيّز والسطح) ويقرؤهما verify_wh1
alter table wms.locations add column if not exists volume_m3      numeric(10,5);
alter table wms.locations add column if not exists area_m2        numeric(10,4);

comment on column wms.locations.volume_m3 is
  'حيّز الموقع = الارتفاع الصافي × العرض الصافي × العمق. أساس فوترة ST-03 (19 §3-4-4)';
comment on column wms.locations.global_level is
  '19 §2-0: مشتق ولا يظهر في الكود — P→lvl · G→lvl · M→lvl+3 · T→lvl+6';
comment on column wms.locations.max_weight_kg is
  'حاجز صلب (19 §3-3): 1,000 كجم لموقع المنصة · 750 كجم لموقع الرف. يُفحص عند كل إدخال';

-- v4 (19 §2 «الطول ثابت = 7 خانات دائماً · أي كود بطول مختلف كود خاطئ»)
do $$ begin
  alter table wms.locations add constraint chk_locations_code_format
    check (
      location_type not in ('pallet','shelf')
      or code ~ '^[PGMT][1-9]-[0-9]{2}-[1-9]$'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table wms.locations add constraint chk_locations_structural_prefix
    check (location_type <> 'structural' or code like 'X-%');
exception when duplicate_object then null; end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. المستودع — صفّ واحد
--    المصدر: 19 §4 بند 1 · OPS §2-1 · 19 §3-4-4 (1,423.404 م² هي القيمة الدقيقة)
-- ───────────────────────────────────────────────────────────────────────────

insert into wms.warehouses (entity_id, code, name_ar, name_en, address, area, total_sqm, is_active)
select e.id, 'WH1', 'مخزن ميناء عبدالله', 'Main Abdullah Warehouse',
       'ميناء عبدالله', 'الأحمدي', 1423.404, true
from platform.entities e where e.code = 'PST'
on conflict (code) do nothing;
-- ملاحظة 019 v1 بقيت صالحة: المخطط صادر باسم PREMIUM DELIVERY والتشغيل المخزني
-- تحت PST. القرار المعتمد: PST (19 §4 بند 1 · OPS §2-1).

-- ───────────────────────────────────────────────────────────────────────────
-- 3. المناطق — 11 منطقة
--    المصدر: 19 §4 بند 2 · OPS §2-2
--    ⚠️ أكواد المناطق التخزينية بحرف واحد لأن section = left(zone.code, 1)
-- ───────────────────────────────────────────────────────────────────────────

insert into wms.zones (warehouse_id, code, name_ar, zone_type, is_secure)
select w.id, z.code, z.name_ar, z.zone_type, false
from wms.warehouses w
cross join (values
  ('P',  'قسم المنصات',                 'storage'),
  ('G',  'الميزانين — الدور الأرضي',     'storage'),
  ('M',  'الميزانين — الدور الأول',      'storage'),
  ('T',  'الميزانين — الدور الثاني',     'storage'),
  ('RCV','الاستلام',                     'receiving'),
  ('QRT','الحجر',                        'quarantine'),
  ('STG','التجهيز',                      'staging'),
  ('SHP','الشحن',                        'shipping'),
  ('RTN','المرتجعات',                    'returns'),
  ('DMG','التالف',                       'damaged'),
  ('X',  'إنشائي — درج وممرات',          'structural')
) as z(code, name_ar, zone_type)
where w.code = 'WH1'
on conflict (warehouse_id, code) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. كتل المساحة — 8 كتل
--    المصدر: 19 §3-2 · §4 بند 3 · OPS §2-3
--    ⚠️ `cross join (values …) as b` يسبق `join wms.zones … = b.zone`
--       وإلا: ERROR: invalid reference to FROM-clause entry for table "b" (OPS-61)
--    ⚠️ 54.675 لا 54.68 (45 × 1.215) — وإلا لا يعود المجموع 3,830.895 (OPS-64)
-- ───────────────────────────────────────────────────────────────────────────

insert into wms.space_blocks
  (entity_id, warehouse_id, zone_id, code, block_type,
   capacity_pallets, capacity_sqm, capacity_cbm, uom,
   max_stack_height, hazmat_allowed, is_secure, monthly_cost, status)
select e.id, w.id, z.id, b.code, b.block_type,
       b.positions, b.sqm, b.cbm, b.uom,
       null,            -- v4 (OPS-12): رفوف انتقائية لا تستيف — العمود يعني ارتفاع
                        --   التستيف المسموح لا عدد المستويات
       false, false, null, 'active'
from platform.entities e
join wms.warehouses w on w.code = 'WH1'
cross join (values
  -- كود  | منطقة | نوع          | مواضع | م²       | م³       | وحدة الطاقة
  ('P-A' ,'P','pallet_rack', 288,  349.920,  507.384, 'pallet'),
  ('P-A1','P','pallet_rack',  12,   14.580,   21.141, 'pallet'),
  ('G-B' ,'G','shelf'      , 906, 1100.790,  880.632, 'position'),
  ('G-C' ,'G','shelf'      ,  45,   54.675,   43.740, 'position'),
  ('M-B' ,'M','shelf'      , 906, 1100.790,  880.632, 'position'),
  ('M-C' ,'M','shelf'      ,  45,   54.675,   43.740, 'position'),
  ('T-B' ,'T','shelf'      , 906, 1100.790,  880.632, 'position'),
  ('T-C' ,'T','shelf'      ,  45,   54.675,   43.740, 'position')
) as b(code, zone, block_type, positions, sqm, cbm, uom)
join wms.zones z on z.warehouse_id = w.id and z.code = b.zone
where e.code = 'PST'
on conflict (entity_id, warehouse_id, code) do nothing;
-- المجموع: 3,153 موضعاً · 3,830.895 م² · 3,301.641 م³ — صفر انحراف (19 §3-4-1)

-- ───────────────────────────────────────────────────────────────────────────
-- 5. مولّد المواقع
--    المصدر: 19 §4 بند 5 — منقول بتوقيعه وحارسيه حرفياً
--    v4 (ق-18): أُضيف ملء area_m2 و volume_m3 و capacity_pallets و barcode —
--    مشتقة من الكتلة نفسها لا مخترعة، وإلا استحال أن تعيد verify_wh1 مجاميع 19 §3-4.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function wms.generate_locations(
  p_block_code  text,
  p_aisle_map   jsonb,     -- {"1": 40, "2": 40, ...}  رقم الممر → عدد المواقع فيه
  p_levels      int,
  p_max_weight  numeric,
  p_max_volume  numeric
) returns int language plpgsql as $$
declare
  v_block   record;
  v_aisle   text;
  v_count   int;
  v_section char(1);
  v_area    numeric(10,4);
  v_cap     numeric(8,2);
  v_code    text;
  v_made    int := 0;
begin
  select b.*, z.code as zone_code
    into v_block
    from wms.space_blocks b
    join wms.zones z on z.id = b.zone_id
   where b.code = p_block_code;

  if not found then raise exception 'كتلة غير موجودة: %', p_block_code; end if;
  v_section := left(v_block.zone_code, 1);

  -- v4 (OPS-62): الصيغة سبع خانات — رقم ممر من خانتين يكسرها ('P10-01-1' بطول 8).
  if exists (
    select 1 from jsonb_object_keys(p_aisle_map) k
     where k !~ '^[1-9]$'
  ) then
    raise exception 'رقم الممر يجب أن يكون 1–9 — الصيغة سبع خانات (القسم %)', v_section;
  end if;

  -- v4 (OPS-15ب): المستويات داخل الطابق — P: 1..6 · G/M/T: 1..3
  if (v_section = 'P' and p_levels <> 6) or (v_section in ('G','M','T') and p_levels <> 3) then
    raise exception 'عدد المستويات % لا يطابق القسم % (P=6 · G/M/T=3)', p_levels, v_section;
  end if;

  -- v4 (ق-18): سطح الموضع الواحد = طاقة الكتلة بالمتر المربع ÷ عدد مواضعها
  v_area := round(v_block.capacity_sqm / nullif(v_block.capacity_pallets, 0), 4);
  v_cap  := case when v_section = 'P' then 1 else 0 end;   -- موضع منصة = 1 · موضع رف = 0

  for v_aisle, v_count in select * from jsonb_each_text(p_aisle_map) loop
    for pos in 1 .. v_count::int loop
      for lvl in 1 .. p_levels loop
        v_code := v_section || v_aisle || '-' || lpad(pos::text, 2, '0') || '-' || lvl;
        insert into wms.locations
          (warehouse_id, zone_id, space_block_id, code,
           section, aisle_no, position_no, level_no, global_level,
           location_type, max_weight_kg, max_volume_cbm,
           volume_m3, area_m2, capacity_pallets, barcode, is_blocked)
        values
          (v_block.warehouse_id, v_block.zone_id, v_block.id, v_code,
           v_section, v_aisle::int, pos, lvl,
           case when v_section = 'P' then lvl
                when v_section = 'G' then lvl
                when v_section = 'M' then lvl + 3
                when v_section = 'T' then lvl + 6 end,
           case when v_section = 'P' then 'pallet' else 'shelf' end,
           p_max_weight, p_max_volume,
           p_max_volume, v_area, v_cap, v_code, false)
        on conflict (warehouse_id, code) do nothing;
        v_made := v_made + 1;
      end loop;
    end loop;
  end loop;

  return v_made;
end $$;

comment on function wms.generate_locations is
  '19 §4 بند 5. الحارسان يمنعان كسر الصيغة السباعية قبل كتابة صفّ واحد. '
  'خريطة الممرات مدخَل بشري من المسح الميداني (19 §7 · §9 بند 4).';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. توليد مواقع التخزين — 3,153
--    ⚠️ خرائط الممرات أدناه **قيم مسبقة قابلة للاستبدال** بعد المسح الميداني
--       (19 §9 بند 4: «بلا خريطة الممرات لا يعمل المولّد»). وُضعت هنا لأن
--       الحزمة تشترط خروج الأرقام 3,153/3,330 من هذه الهجرة (40 Part I)،
--       ومجاميعها مطابقة للجدول الرقمي الحاكم 19 §3-4 موضعاً بموضع.
--       عند ورود الخريطة الحقيقية: يُستبدل JSON وحده — ولا يتغيّر أي مجموع.
-- ───────────────────────────────────────────────────────────────────────────

-- قسم P — المنصات · 6 مستويات · 1,000 كجم · 1.76175 م³
select wms.generate_locations('P-A' , '{"1":24,"2":24}'::jsonb, 6, 1000, 1.76175);  -- 48 × 6 = 288
select wms.generate_locations('P-A1', '{"3":2}'::jsonb,        6, 1000, 1.76175);  --  2 × 6 =  12

-- أقسام G · M · T — الرفوف · 3 مستويات · 750 كجم · 0.97200 م³
select wms.generate_locations('G-B' , '{"1":76,"2":76,"3":75,"4":75}'::jsonb, 3, 750, 0.97200);  -- 302 × 3 = 906
select wms.generate_locations('G-C' , '{"5":15}'::jsonb,                      3, 750, 0.97200);  --  15 × 3 =  45
select wms.generate_locations('M-B' , '{"1":76,"2":76,"3":75,"4":75}'::jsonb, 3, 750, 0.97200);  -- 906
select wms.generate_locations('M-C' , '{"5":15}'::jsonb,                      3, 750, 0.97200);  --  45
select wms.generate_locations('T-B' , '{"1":76,"2":76,"3":75,"4":75}'::jsonb, 3, 750, 0.97200);  -- 906
select wms.generate_locations('T-C' , '{"5":15}'::jsonb,                      3, 750, 0.97200);  --  45
-- المجموع: 288 + 12 + (906 + 45) × 3 = 3,153

-- ───────────────────────────────────────────────────────────────────────────
-- 7. المواقع الإنشائية — 147 محجوبة
--    المصدر: 19 §2-0 (بادئة X-) · §3-4-2 · 40 §C3 · OPS §2-8
--    B1 9×3 = 27 · C1 27×3 = 81 · E 13×3 = 39
--    space_block_id يبقى null — الكتل الثماني طاقتها 3,153 ولا تتضمّن الإنشائية (OPS-66)
-- ───────────────────────────────────────────────────────────────────────────

insert into wms.locations
  (warehouse_id, zone_id, code, location_type,
   volume_m3, area_m2, capacity_pallets, max_weight_kg, max_volume_cbm,
   is_blocked, block_reason)
select w.id, z.id,
       'X-' || t.blk || lpad(bay::text, 2, '0') || '-' || tier,
       'structural',
       0, 0, 0, 0, 0,
       true,
       'إطار إنشائي — ميزانين/درج/ممر · لا تخزين (مخطط SG-2024-06-0133)'
from wms.warehouses w
join wms.zones z on z.warehouse_id = w.id and z.code = 'X'
cross join (values ('B1', 9), ('C1', 27), ('E', 13)) as t(blk, bays)
cross join lateral generate_series(1, t.bays) as bay
cross join lateral generate_series(1, 3)      as tier
where w.code = 'WH1'
on conflict (warehouse_id, code) do nothing;
-- الناتج: 9×3 + 27×3 + 13×3 = 27 + 81 + 39 = 147
-- صيغة الكود: X-B101-1 … X-B109-3 · X-C101-1 … X-C127-3 · X-E01-1 … X-E13-3

-- ───────────────────────────────────────────────────────────────────────────
-- 8. المواقع التشغيلية — 30
--    المصدر: 19 §2-0 · §2-4 · §3-4-2 · OPS §2-7
--    location_type = 'operational' · is_blocked = false · بلا space_block_id
-- ───────────────────────────────────────────────────────────────────────────

insert into wms.locations
  (warehouse_id, zone_id, code, location_type,
   capacity_pallets, max_weight_kg, is_blocked, block_reason)
select w.id, z.id,
       t.zcode || '-' || n,
       'operational',
       1, 1000, false, null
from wms.warehouses w
cross join (values
  ('RCV', 6), ('QRT', 4), ('STG', 8), ('SHP', 6), ('RTN', 4), ('DMG', 2)
) as t(zcode, qty)
join wms.zones z on z.warehouse_id = w.id and z.code = t.zcode
cross join lateral generate_series(1, t.qty) as n
where w.code = 'WH1'
on conflict (warehouse_id, code) do nothing;
-- الناتج: 6+4+8+6+4+2 = 30 — RCV-1…RCV-6 · QRT-1…QRT-4 · STG-1…STG-8 …

-- ───────────────────────────────────────────────────────────────────────────
-- 9. العازل التشغيلي — 7% من طاقة كل كتلة
--    المصدر: 17 §5-1 · EXECUTION-MASTER-v4 §1.1 · OPS §3
-- ───────────────────────────────────────────────────────────────────────────

insert into wms.space_blocks_out_of_service
  (block_id, qty_pallets, qty_sqm, reason, from_date, to_date, created_by)
select b.id,
       round(b.capacity_pallets * 0.07, 3),
       round(b.capacity_sqm     * 0.07, 3),
       'operational_buffer', current_date, null,
       '00000000-0000-0000-0000-000000000000'
from wms.space_blocks b
join wms.warehouses w on w.id = b.warehouse_id and w.code = 'WH1'
where b.status = 'active'
  and not exists (select 1 from wms.space_blocks_out_of_service x
                   where x.block_id = b.id and x.reason = 'operational_buffer');

-- ───────────────────────────────────────────────────────────────────────────
-- 10. أساس فوترة التخزين بالحجم — قرار المدير العام
--     المصدر: 19 §3-4-4 · 019 v1 §8 (منقول كما هو)
-- ───────────────────────────────────────────────────────────────────────────

insert into platform.settings (entity_id, key, value, data_type, description)
select e.id, 'storage_cbm_basis', '"envelope"'::jsonb, 'string',
       'أساس احتساب ST-03: envelope = حيّز الرف · goods = حجم بضاعة العميل. القرار: envelope'
from platform.entities e where e.code = 'PST'
on conflict (entity_id, key) do update set value = excluded.value;

insert into platform.settings (entity_id, key, value, data_type, description)
select e.id, 'pallet_max_weight_kg', '1000'::jsonb, 'number',
       'الحد الأقصى لوزن المنصة — رافدة النوع A مصنَّفة 2,000 كجم لمنصتين'
from platform.entities e where e.code = 'PST'
on conflict (entity_id, key) do update set value = excluded.value;

insert into platform.settings (entity_id, key, value, data_type, description)
select e.id, 'shelf_max_weight_kg', '750'::jsonb, 'number',
       'الحد الأقصى لوزن موقع الرف — كثافة موحّدة 617.3 كجم/م²'
from platform.entities e where e.code = 'PST'
on conflict (entity_id, key) do update set value = excluded.value;

-- ───────────────────────────────────────────────────────────────────────────
-- 11. حاجز الوزن والحجم — المصدر: 19 §4 بند 7
-- ───────────────────────────────────────────────────────────────────────────

create or replace function wms.check_location_limits(
  p_location uuid, p_weight numeric, p_volume numeric
) returns void language plpgsql as $$
declare v record;
begin
  select code, max_weight_kg, max_volume_cbm, is_blocked, block_reason
    into v from wms.locations where id = p_location;

  if v.is_blocked then
    raise exception 'الموقع % محجوب: %', v.code, coalesce(v.block_reason,'—');
  end if;
  if p_weight > v.max_weight_kg then
    raise exception 'الموقع % يتحمل % كجم فقط، والمطلوب % كجم',
      v.code, v.max_weight_kg, p_weight;
  end if;
  if p_volume is not null and p_volume > v.max_volume_cbm then
    raise exception 'الموقع % يتسع % م³ فقط، والمطلوب % م³',
      v.code, v.max_volume_cbm, p_volume;
  end if;
end $$;

comment on function wms.check_location_limits is
  'حاجز صلب (19 §3-3) — لا تنبيه. رافدة النوع A عند 100% من المصنَّف بلا هامش';

-- ───────────────────────────────────────────────────────────────────────────
-- 12. عرض الطاقة القابلة للبيع
-- ───────────────────────────────────────────────────────────────────────────

create or replace view wms.warehouse_capacity as
select
  w.code                                             as warehouse,
  sb.code                                            as block,
  sb.block_type,
  sb.uom,
  count(l.id)                                        as positions,
  round(sum(l.volume_m3), 3)                         as volume_m3,
  round(sum(l.area_m2), 3)                           as area_m2,
  sum(l.max_weight_kg)                               as max_load_kg,
  count(*) filter (where l.assigned_client_id is not null) as assigned,
  count(*) filter (where l.is_blocked)                as blocked,
  count(*) filter (where not l.is_blocked
                     and l.assigned_client_id is null) as free
from wms.warehouses w
join wms.space_blocks sb on sb.warehouse_id = w.id
join wms.locations    l  on l.space_block_id = sb.id
group by w.code, sb.code, sb.block_type, sb.uom
order by sb.code;

-- ───────────────────────────────────────────────────────────────────────────
-- 13. الاختبارات الحارسة — أي فشل يوقف النشر
--     المصدر: القيم من 19 §3-4 · OPS §2-9 (الأحد عشر + فحص الصيغة)
-- ───────────────────────────────────────────────────────────────────────────

create or replace function wms.verify_wh1()
returns table (check_name text, expected numeric, actual numeric, passed boolean)
language sql stable as $$
with l as (
  select lo.* from wms.locations lo
  join wms.warehouses w on w.id = lo.warehouse_id and w.code = 'WH1'
)
select 'مواقع التخزين',          3153,     count(*)::numeric,
       count(*) = 3153     from l where location_type in ('pallet','shelf')
union all
select 'مواقع المنصات',           300,     count(*)::numeric,
       count(*) = 300      from l where location_type = 'pallet'
union all
select 'مواقع الرفوف',           2853,     count(*)::numeric,
       count(*) = 2853     from l where location_type = 'shelf'
union all
select 'مناطق تشغيل',              30,     count(*)::numeric,
       count(*) = 30       from l where location_type = 'operational'
union all
select 'مواقع إنشائية محجوبة',    147,     count(*)::numeric,
       count(*) = 147      from l where location_type = 'structural'
union all
select 'إجمالي الأكواد',         3330,     count(*)::numeric,
       count(*) = 3330     from l
union all
select 'الحيّز الإجمالي م³',  3301.641, round(sum(volume_m3),3),
       round(sum(volume_m3),3) = 3301.641
       from l where location_type in ('pallet','shelf')
union all
select 'سطح التخزين م²',      3830.895, round(sum(area_m2),3),
       round(sum(area_m2),3) = 3830.895
       from l where location_type in ('pallet','shelf')
union all
select 'الحمل الأقصى كجم',    2439750, sum(max_weight_kg)::numeric,
       sum(max_weight_kg) = 2439750
       from l where location_type in ('pallet','shelf')
union all
select 'حد وزن المنصة',          1000, max(max_weight_kg)::numeric,
       bool_and(max_weight_kg = 1000) from l where location_type = 'pallet'
union all
select 'حد وزن الرف',             750, max(max_weight_kg)::numeric,
       bool_and(max_weight_kg = 750)  from l where location_type = 'shelf'
union all
select 'طول كل كود تخزين = 7',      7, max(length(code))::numeric,
       bool_and(length(code) = 7) from l where location_type in ('pallet','shelf')
union all
select 'صيغة الكود السباعية',       0, count(*)::numeric,
       count(*) = 0 from l
       where location_type in ('pallet','shelf')
         and code !~ '^[PGMT][1-9]-[0-9]{2}-[1-9]$'
union all
select 'بادئة X- للإنشائي',         0, count(*)::numeric,
       count(*) = 0 from l where location_type = 'structural' and code not like 'X-%'
union all
select 'لا موقع إنشائي غير محجوب',  0, count(*)::numeric,
       count(*) = 0        from l where location_type = 'structural' and not is_blocked
union all
select 'لا موقع تخزين بلا حد وزن',  0, count(*)::numeric,
       count(*) = 0        from l
       where location_type in ('pallet','shelf')
         and coalesce(max_weight_kg,0) = 0
union all
select 'لا كود مكرر',               0, count(*)::numeric,
       count(*) = 0
       from (select code from l group by code having count(*) > 1) d
union all
select 'الكتل',                     8, count(*)::numeric, count(*) = 8
       from wms.space_blocks sb
       join wms.warehouses w on w.id = sb.warehouse_id and w.code = 'WH1'
union all
select 'المناطق',                  11, count(*)::numeric, count(*) = 11
       from wms.zones z
       join wms.warehouses w on w.id = z.warehouse_id and w.code = 'WH1'
union all
select 'طاقة الكتل م²',      3830.895, round(sum(sb.capacity_sqm),3),
       round(sum(sb.capacity_sqm),3) = 3830.895
       from wms.space_blocks sb
       join wms.warehouses w on w.id = sb.warehouse_id and w.code = 'WH1'
union all
select 'طاقة الكتل م³',      3301.641, round(sum(sb.capacity_cbm),3),
       round(sum(sb.capacity_cbm),3) = 3301.641
       from wms.space_blocks sb
       join wms.warehouses w on w.id = sb.warehouse_id and w.code = 'WH1'
$$;

comment on function wms.verify_wh1 is
  'الواحد والعشرون اختباراً يجب أن تمر كلها (19 §3-4). أي فشل = خطأ في التوليد أو تعديل غير مصرّح';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد التطبيق
-- ═══════════════════════════════════════════════════════════════════════════
--   select * from wms.verify_wh1();            -- 21 صفاً · passed = true
--   select bool_and(passed) from wms.verify_wh1();   -- true
--   select * from wms.warehouse_capacity;      -- 8 كتل
--
-- الناتج المتوقع من warehouse_capacity:
--   block | uom      | positions | volume_m3  | area_m2   | max_load_kg
--   P-A   | pallet   |       288 |  507.38400 |  349.9200 |     288,000
--   P-A1  | pallet   |        12 |   21.14100 |   14.5800 |      12,000
--   G-B   | position |       906 |  880.63200 | 1100.7900 |     679,500
--   G-C   | position |        45 |   43.74000 |   54.6750 |      33,750
--   M-B · M-C · T-B · T-C  — مطابقة لـ G-B · G-C
--   ──────────────────────────────────────────────────────────────────
--   المجموع    3,153   3301.64100   3830.8950    2,439,750
--
-- ═══════════════════════════════════════════════════════════════════════════
-- بنود لاحقة على هذه الهجرة
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. **البوابة البشرية (19 §9 بند 4 · 38 §2.2):** خرائط الممرات في §6 قيم مسبقة
--    مجاميعها مطابقة للجدول الرقمي الحاكم. بعد المسح الميداني تُستبدل خرائط JSON
--    وحدها (وتُعاد الهجرة على قاعدة نظيفة) — ولا يتغيّر أي مجموع. **لا تُطبع
--    لافتة واحدة قبل اعتماد الخريطة الحقيقية.**
-- 2. اللافتات: **3,330** (3,153 تخزين + 30 تشغيلية + 147 إنشائية سوداء).
--    الرقم 3,183 مُلغى (19 §3-4-3).
-- 3. الارتفاع الصافي للمبنى يُقاس ويُسجَّل في wms.warehouses (أعلى حمولة 8,495 مم).
-- 4. لا مناطق مبرَّدة ولا مجمَّدة ولا خطرة ولا مؤمَّنة في هذا المخزن —
--    ST-05 · ST-06 · ST-07 · ST-08 · ST-09 · ST-10 غير قابلة للتقديم منه (19 §3-4-4).
-- 5. بند سلامة إنشائية مفتوح (18 §4 خطر 2): 2,439.75 طن أم 1,420.5 طن؟
--    يبقى مفتوحاً حتى تأكيد كتابي من مهندس إنشائي معتمد.
-- ═══════════════════════════════════════════════════════════════════════════
