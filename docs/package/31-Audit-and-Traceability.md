# السجل والتتبّع — لكل معاملة
**وثيقة 31 · PG-EOS · الإصدار 4.0 · 21/09/2026**

> **v4 — حالة الوثيقة:** مرجعية (**تصميم — بلا DDL تنفيذي**) · **الحاكم عند التعارض:** 40 (§B2 · §B3 · Part F · Part G) · 36 (§3-1) · **13B هو المخطط الوحيد** لكل ما في هذه الوثيقة · **التصحيحات المطبّقة في v4:** PLT-01, PLT-02, PLT-03, PLT-04, PLT-05, PLT-28 · **القرارات المفتوحة سابقاً:** مُغلقة في EXECUTION-MASTER-v4 §1.

> ⚠️ **قاعدة v4 الحاكمة لهذه الوثيقة:** كانت 31 تُصدر `create table platform.audit_log` و`create table platform.audit_log_2026_10 partition of …` و`alter table platform.domain_events …` — وقد **فشلت الثلاثة فعلياً** على PostgreSQL 16 (`relation "audit_log" already exists` · `"audit_log" is not partitioned` · `unique constraint on partitioned table must include all partitioning columns`). **لا يُنفَّذ أي DDL من هذه الوثيقة.** المخطط النهائي في `A-governing/database/13B-Schema-Reference-Consolidation.sql` (القسم **13B-2**). ما يرد هنا من SQL هو **اقتباس مطابق للمخطط الحاكم بغرض الشرح**.

> الموضوع مذكور في عشر وثائق ولم يُفرد له تصميم. هذه هي الطبقة التي تجعل كل رقم في النظام **قابلاً للإثبات** — وهي الفرق بين نظام يُحتجّ به ونظام يُتنازع عليه.

---

# 1. الأسئلة التي يجب أن يجيب عليها النظام في ثوانٍ

| # | السؤال | الطبقة التي تجيب |
|---|---|---|
| 1 | هذه الشحنة — **من فرزها ومن حمّلها ومن وصّلها ومتى وأين؟** | تتبّع الشحنة |
| 2 | هذه الدفعة تالفة — **لأي عملاء صُرفت وبأي شحنات؟** (سحب من السوق) | تتبّع الدفعة |
| 3 | هذا السطر في الفاتورة — **من أي حدث جاء وبأي سعر ولماذا؟** | سلسلة الإثبات المالي |
| 4 | هذا الفرق في الجرد — **متى ظهر وبين أي حركتين؟** | دفتر المخزون |
| 5 | هذا الموظف — **ماذا فعل في النظام آخر ٣٠ يوماً؟** | سجل التدقيق |
| 6 | هذه العمولة — **من أي شحنات وبأي معرّف وأي سائق كان يحمله؟** | الإسناد الزمني |
| 7 | هذا السعر — **من اعتمده ومتى وبأي مبرر؟** | سجل الاعتمادات |
| 8 | هذا الموقع — **ما دخله وما خرج منه هذا الشهر؟** | دفتر المخزون |
| 9 | هذا العميل — **كل ما حدث معه منذ التعاقد** | خط زمني موحّد |
| 10 | هذه القيمة تغيّرت — **من غيّرها ومن ماذا إلى ماذا؟** | سجل التدقيق |

**معيار القبول:** كل سؤال من العشرة يُجاب من **شاشة واحدة بنقرة واحدة** — لا باستعلام يكتبه مبرمج.

---

# 2. الطبقات الأربع

```
① سجل التدقيق        من فعل ماذا · متى · من أين · القيمة قبل وبعد
② أحداث المجال       ماذا حدث في العمل — لا من ضغط الزر   (platform.outbox)
③ الدفاتر            المخزون · المال · الرواتب — لا تُعدَّل
④ سلاسل التتبّع      الروابط التي تصل الأربعة ببعضها
```

| الطبقة | الجدول الحاكم | تجيب على | مثال |
|---|---|---|---|
| **التدقيق** | `platform.audit_log` (مجزّأ · 13B-2) | مسؤولية بشرية | «ناريش غيّر الكمية من ١٢ إلى ١٠ الساعة ٠٩:١٤ من جهاز PDA-07» |
| **الأحداث** | **`platform.outbox`** (13B-1) | ما جرى في العمل | `wms.outbound.checked` · `tms.task.delivered` |
| **الدفاتر** | `wms.stock_movements` · `billing.journal_lines` | الأرصدة والمبالغ | حركة −١٢ من `B3-14-2` |
| **السلاسل** | عروض مُجسَّدة فوق الثلاثة | الربط الكامل | الشحنة ← الأمر ← الدفعة ← المورّد ← الفاتورة |

**الفرق الجوهري بين ① و②:** التدقيق يسجّل **الضغطة**، والحدث يسجّل **الواقعة**. حذف صف وإضافته من جديد يُنتج ضغطتين وحدثاً واحداً. كلاهما مطلوب.

---

# 3. سجل التدقيق — `platform.audit_log`

> **المخطط الحاكم: 13B-2.** الجدول **مُجزَّأ شهرياً حسب `occurred_at`**، ومفتاحه الأساسي **`(id, occurred_at)`** لا `id` وحده — وهذا إلزام PostgreSQL على الجداول المجزّأة: `unique constraint on partitioned table must include all partitioning columns`. **v4 · PLT-01 · PLT-02**

```sql
-- اقتباس من 13B-2 — لا يُنفَّذ من هنا
create table platform.audit_log (
  id            bigserial,
  occurred_at   timestamptz not null default now(),
  -- الفاعل
  user_id       uuid,
  actor_type    text not null default 'user',    -- user · agent · system · ai · client
  on_behalf_of  uuid,                            -- عند التفويض
  -- الهدف
  entity_id     uuid,
  schema_name   text not null,
  table_name    text not null,
  record_id     uuid,
  doc_no        text,                            -- الرقم البشري — للبحث
  -- الفعل
  operation     text not null,
  -- insert · update · delete · approve · reject · void · login · export · print · read_secret
  changed_fields text[],                         -- الحقول المتغيّرة فقط
  old_value     jsonb,                           -- معقّمة — §3-2
  new_value     jsonb,
  reason        text,                            -- إلزامي في: reject · void · override
  -- السياق
  ip_address    inet,
  device_id     text,
  user_agent    text,
  session_id    uuid,
  request_id    uuid,                            -- يربط كل ما جرى في طلب واحد
  correlation_id uuid,                           -- يربط عملية أعمال كاملة عبر عدة طلبات
  -- سلسلة التجزئة — §3-3
  prev_hash     text,
  row_hash      text,
  primary key (id, occurred_at)                  -- إلزام التقسيم
) partition by range (occurred_at);
```

**الأعمدة الإحدى عشرة التي يوجبها 40 §B2 وكانت غائبة عن نسخة 01:** `on_behalf_of · doc_no · changed_fields · reason · device_id · session_id · request_id · correlation_id · prev_hash · row_hash` (+ `actor_type`). **كلها موجودة في 13B-2.**

**الفهارس (كما في 13B-2):** `(table_name, record_id, occurred_at desc)` · `(user_id, occurred_at desc)` · `(doc_no) where doc_no is not null` · `(correlation_id)` · `(occurred_at desc)`.
**الصلاحية:** `revoke update, delete on platform.audit_log from public;` — **السجل يُكتب ولا يُعدَّل ولا يُحذف.**

## 3-1 ما يُسجَّل — بلا استثناء

| الفئة | الأمثلة |
|---|---|
| كل كتابة | إنشاء · تعديل · حذف منطقي |
| كل اعتماد ورفض | **الرفض بسبب إلزامي** (`reason`) |
| كل تجاوز (override) | **بسبب إلزامي** — تجاوز الحد · تجاوز ١٥ يوماً · موقع مختلف |
| الدخول والخروج | ناجح وفاشل |
| **تصدير وطباعة** | من صدّر أي بيانات ومتى — تسريب محتمل |
| قراءة سرّ | مفاتيح التكاملات (`operation = 'read_secret'`) |
| تغيير دور أو صلاحية | |
| تغيير حد آلي | `platform.thresholds` |
| نداء ذكاء اصطناعي | المهمة · الحجم · الزمن |

## 3-2 التعقيم — إصلاح الثغرة المرصودة

في النظام السابق كان التدقيق يخزّن القيم كاملة، **فصار طريقاً التفافياً لقراءة الرواتب** لمن له صلاحية على السجل.

```sql
-- اقتباس من 13B-2 (الدالة نفسها حرفياً) — لا يُنفَّذ من هنا
create or replace function platform.sanitize_audit(p_schema text, p_table text, p_data jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k,
           case when c.sensitivity in ('payroll','commercial','secret','personal')
                then to_jsonb('•••'::text) else v end), '{}'::jsonb)
  from jsonb_each(p_data) as e(k,v)
  left join identity.column_classification c
    on c.schema_name=p_schema and c.table_name=p_table and c.column_name=e.k
$$;
```

**القاعدة:** الحقل المصنَّف يُخزَّن في التدقيق **كعلامة تغيّر لا كقيمة**. يُعرف *أن* الراتب تغيّر ومن غيّره — ولا تُقرأ القيمة إلا من الجدول الأصلي بصلاحيته.

## 3-3 كشف العبث — سلسلة التجزئة المنفَّذة · **v4 · PLT-03**

> كانت الصيغة مذكورة **في تعليق SQL فقط** بلا دالة ولا مشغّل ولا ضابط تزامن — فالحارس G8 «Audit hash chain breaks = 0» كان غير قابل للتنفيذ. **13B-2 ينفّذها.**

**المشغّل — يملأ `prev_hash`/`row_hash` قبل كل إدراج:**

```sql
-- اقتباس من 13B-2
create or replace function platform.audit_hash_chain()
returns trigger language plpgsql as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('platform.audit_log'));
  select a.row_hash into v_prev
  from platform.audit_log a
  order by a.occurred_at desc, a.id desc
  limit 1;

  new.prev_hash := v_prev;
  new.row_hash  := encode(sha256(convert_to(
      coalesce(v_prev,'')
      || coalesce(new.occurred_at::text,'')
      || coalesce(new.user_id::text,'')
      || coalesce(new.table_name,'')
      || coalesce(new.record_id::text,'')
      || coalesce(new.operation,''), 'UTF8')), 'hex');
  return new;
end $$;

create trigger trg_audit_hash_chain before insert on platform.audit_log
  for each row execute function platform.audit_hash_chain();
```

| البند | كيف حُسم |
|---|---|
| **الصيغة** | `row_hash = sha256(prev_hash ‖ occurred_at ‖ user_id ‖ table_name ‖ record_id ‖ operation)` بترميز `hex`، و`coalesce(…, '')` على كل حقل حتى لا تُنتج القيمة العدمية تجزئة مختلفة. الدالة `sha256()` المدمجة في PostgreSQL 16 — **لا حاجة لـ`pgcrypto`**. |
| **التزامن** | `pg_advisory_xact_lock` على مفتاح الجدول: كاتبان متزامنان لا يقرآن نفس `prev_hash` فلا تنشأ **شوكة صامتة**. القفل يُحرَّر بانتهاء المعاملة، والإدراج قصير فالتنازع محدود. |
| **مدى السلسلة** | **سلسلة واحدة عالمية** عبر كل الأقسام — الترتيب `(occurred_at, id)` لا يتأثر بحدود التقسيم الشهري. |

**دالة التحقق — هي حرفياً الحارس G8:**

```sql
-- اقتباس من 13B-2
create or replace function platform.verify_audit_chain()
returns table (id bigint, occurred_at timestamptz, expected_hash text, actual_hash text)
language sql stable as $$
  with ordered as (
    select a.id, a.occurred_at, a.user_id, a.table_name, a.record_id,
           a.operation, a.prev_hash, a.row_hash,
           lag(a.row_hash) over (order by a.occurred_at, a.id) as chain_prev
    from platform.audit_log a
  )
  select o.id, o.occurred_at,
         encode(sha256(convert_to( coalesce(o.chain_prev,'') || … , 'UTF8')), 'hex'),
         o.row_hash
  from ordered o
  where o.row_hash is distinct from encode(sha256(convert_to( coalesce(o.chain_prev,'') || … , 'UTF8')), 'hex')
     or o.prev_hash is distinct from o.chain_prev
$$;
```

**كيف تعمل:** تعيد ترتيب السجل كله بـ`(occurred_at, id)`، وتأخذ لكل صف **تجزئة الصف الذي يسبقه فعلياً** (`lag`) ثم تعيد حساب `row_hash` منه. تُرجع الصف في حالتين: (أ) `row_hash` المخزَّن لا يطابق المُعاد حسابه — **الصف عُدِّل**؛ (ب) `prev_hash` المخزَّن لا يطابق تجزئة سابقه — **صف حُذف من بين الصفين**. `stable` فتُستدعى داخل الاستعلامات بحرية.

> **الشرط:** `select * from platform.verify_audit_chain();` يجب أن يعيد **صفر صفوف**. أي صف = كسر في السلسلة → تنبيه فوري لـGM و`SYSADMIN`. *اختُبرت حيّاً في وكيل المخطط: السلسلة سليمة (0)، وبعد عبث متعمَّد بصفٍّ واحد كُشف الكسر (1).*

**هذا يحوّل السجل من «قابل للثقة» إلى «قابل للإثبات» — وهو الفرق عند النزاع.**

## 3-4 التقسيم الشهري

```sql
-- اقتباس من 13B-2 — أقسام مُنشأة مسبقاً + قسم افتراضي
create table platform.audit_log_2026_10 partition of platform.audit_log
  for values from ('2026-10-01') to ('2026-11-01');
create table platform.audit_log_default partition of platform.audit_log default;
```

**قاعدة تشغيلية:** القسم الشهري المقبل يُنشأ **مسبقاً** بمهمة مجدولة (`pg_boss`)؛ والقسم الافتراضي `audit_log_default` شبكة أمان تمنع فشل الإدراج لو تأخّرت المهمة — لا بديلاً عنها. **راقب `audit_log_default`: أي صف فيه = المهمة الشهرية لم تعمل.**

---

# 4. أحداث المجال — `platform.outbox` · **v4 · PLT-04 · R-02**

> **قرار حاكم:** `platform.outbox` هو **الجدول الوحيد للأحداث** (40 §B3 · 36 §3-1). `platform.domain_events` **متقاعد ومحذوف في 13B** (القرار ق-2) — 36 §3-1 يصفه حرفياً بأنه «الثغرة السابقة… بلا ضمان أن الحدث يُكتب **في نفس معاملة** تغيير الحالة». كل ما كانت هذه الوثيقة تضيفه إلى `domain_events` انتقل إلى `outbox`.

```sql
-- اقتباس من 13B-1 — لا يُنفَّذ من هنا
create table platform.outbox (
  id bigserial primary key,
  aggregate_type text not null, aggregate_id uuid not null,
  event_type text not null, payload jsonb not null,
  correlation_id uuid not null, causation_id uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts int not null default 0, last_error text,
  actor_id uuid                       -- من 31 §5 — الفاعل المسبِّب للحدث
  -- entity_id uuid not null           -- مطلوب (40 §A2 + RLS) — انظر PLT-SCHEMA-NEEDS
);
create index on platform.outbox (published_at) where published_at is null;
create index on platform.outbox (correlation_id);
```

| الحقل | الغرض |
|---|---|
| `correlation_id` | يربط كل أحداث عملية أعمال واحدة من بدايتها لنهايتها · **`not null`** · مفهرس (هدف التتبّع ≤ ٢ ث — §7) |
| `causation_id` | **يبني شجرة السببية** — أي حدث ولّد أيّ |
| `actor_id` | الفاعل المسبِّب — كان على `domain_events` وانتقل إلى `outbox` |
| `entity_id` | **إلزامي** — 40 §A2 «Every commercial/operational row carries `entity_id`»؛ بدونه لا RLS على مستوى الكيان |
| ~~`sequence_no`~~ | **حُذف نهائياً** — `outbox.id bigserial` هو **الترتيب القاطع**، وعمود تسلسل ثانٍ ازدواج يولّد ترتيبين متعارضين |

**الضمان المعامَلاتي:** الحدث يُكتب في **نفس معاملة** تغيير الحالة (40 §A4)، وناقل مستقل ينشر كل ثانية ويملأ `published_at`. الفهرس الجزئي `where published_at is null` هو طابور النشر.

## 4-1 شجرة السببية — مثال حقيقي

```
sales.contract.activated            ← الجذر
 └─ wms.outbound.created
     ├─ wms.outbound.credit_checked
     ├─ wms.outbound.allocated       (FEFO)
     ├─ wms.outbound.picked
     ├─ wms.outbound.checked
     ├─ wms.outbound.loaded
     │   └─ tms.task.created
     │       ├─ tms.task.assigned
     │       ├─ tms.task.ofd
     │       └─ tms.task.delivered
     │           ├─ billing.event.created   (DL-01)
     │           └─ billing.event.created   (DL-10 · COD)
     └─ billing.event.created × 4           (OF-01 · OF-02 · OF-06 · OF-07)
          └─ billing.invoice.line.created
               └─ billing.invoice.approved
                    └─ billing.receipt.allocated
```

**من أي عقدة تصعد للجذر أو تنزل للأوراق.** سطر الفاتورة يُرَدّ إلى لحظة التسليم وإلى من سلّم وأين.
الصعود والنزول بـ`causation_id`؛ والمقطع الأفقي (كل أحداث العملية) بـ`correlation_id`.

---

# 5. سلاسل التتبّع الست

## T-1 · تتبّع الشحنة

```
أمر الصرف → السطور → الدفعات → المواقع → من التقط
→ من دقّق → من عبّأ → من حمّل → المركبة → السائق
→ المعرّف وقت التسليم → إثبات التسليم (GPS · توقيع · صورة)
→ حدث الفوترة → سطر الفاتورة → الفاتورة → السداد
```
**نقرة واحدة من رقم الشحنة إلى السداد.** الوصلة التقنية: `platform.outbox.correlation_id` واحد يمرّ بالسلسلة كلها.

## T-2 · تتبّع الدفعة — سحب من السوق

```
رقم الدفعة → أمر الإدخال → المورّد
           → كل حركات الصرف منها
           → العملاء والشحنات والمستلمين
```
**الاختبار الحاسم:** «الدفعة B2409-7 تالفة» → قائمة العملاء والشحنات والهواتف **في أقل من ٥ ثوانٍ**. هذا ليس ترفاً — قد يكون التزاماً قانونياً.

## T-3 · سلسلة الإثبات المالي

كل سطر فاتورة يحمل:

| الحقل | المحتوى |
|---|---|
| الخدمة والكمية | من الحدث |
| السعر المطبَّق | الرقم |
| **مصدر السعر** | `contract` · `segment` · `exception` · `list` |
| **مرجع المصدر** | معرّف العقد أو الشريحة أو الاستثناء |
| عدد الأحداث المجمّعة | |
| **رابط لكل حدث** | تاريخه · منفّذه · موقعه |

> العميل يعترض على سطر → تفتح السطر → ترى ١٢ حدثاً بتواريخها ومنفّذيها وإثباتاتها. **النزاع ينتهي في دقيقة.**

## T-4 · فرق الجرد

```
الموقع + الصنف → كل الحركات بينهما
→ آخر جرد مطابق → أول حركة بعده
→ نافذة الفرق: بين أي حركتين ظهر
→ من نفّذ كل حركة
```

## T-5 · نشاط الموظف

```
الموظف → كل عملياته (تدقيق: platform.audit_log.user_id)
        + كل أحداثه (مجال: platform.outbox.actor_id)
→ خط زمني موحّد · فلترة بالنوع والتاريخ
→ التجاوزات التي طلبها ومن اعتمدها
```
**استخدامان:** التحقيق الانضباطي · وتقييم الأداء بالبيانات لا بالانطباع.

## T-6 · الخط الزمني للعميل

```
العميل → عرض · عقد · أوامر · شحنات · تذاكر
       · فواتير · مدفوعات · شكاوى · تغيير شريحة
       → خط زمني واحد قابل للفلترة
```
**تُفتح قبل كل اجتماع تجديد.**

---

# 6. شاشة التتبّع الموحّدة

```
┌────────────────────────────────────────────────────┐
│  🔎  تتبّع                                          │
│  [ الصق أو امسح: رقم شحنة · فاتورة · دفعة · أمر ]  │
├────────────────────────────────────────────────────┤
│  OUT-00317 · شركة الخليج · 17/09/2026              │
│  ════════════════════════════════════════          │
│  ● 08:12  أُنشئ            نافذة العميل            │
│  ● 08:12  فحص ائتماني ✓    آلي                     │
│  ● 08:13  خُصّص FEFO        آلي                     │
│  ● 09:04  التُقط 9/9       ناريش · PDA-07          │
│  ● 09:31  دُقّق             مصطفى · PDA-02          │
│  ● 09:48  حُمّل             مركبة 4471              │
│  ● 10:02  خرج              أحمد · معرّف D-0451     │
│  ● 11:47  سُلِّم            📍 📷 ✍️ COD 12.500      │
│  ● 23:50  حدث فوترة        DL-01 · OF-01×1 · OF-02×4│
│  ● 30/09  سطر فاتورة       PST-INV-00317 · 18.400  │
│  ● 05/10  سُدِّد             RCT-00088               │
├────────────────────────────────────────────────────┤
│ [شجرة السببية] [سجل التدقيق] [الإثباتات] [تصدير]   │
└────────────────────────────────────────────────────┘
```

> **v4:** سلسلة إيصالات القبض هي **`RCT`** حصراً (R-04 · `platform.counters`) — `RCP`/`RC` محذوفتان.

| القاعدة | التطبيق |
|---|---|
| مدخل واحد | أي رقم — النظام يستنتج النوع · `Ctrl+K` من أي شاشة (40 §D1) |
| الخط الزمني افتراضي | التفاصيل بالنقر |
| **كل عقدة تُظهر الفاعل** | بشر أم آلي — **الآلي معلَّم صراحةً** (`audit_log.actor_type`) |
| الإثباتات مرفقة | الصور والتواقيع في مكانها |
| التصدير | PDF موقّع — **صالح للاحتجاج** · التصدير نفسه يُسجَّل في التدقيق |
| الصلاحية | يرى ما يراه دوره · العميل يرى شحناته فقط |

---

# 7. الأداء

| البند | المعالجة |
|---|---|
| حجم التدقيق | ~٢ مليون صف سنوياً — **تقسيم شهري** (§3-4 · منفَّذ في 13B-2) |
| التتبّع | **عرض مُجسَّد (Materialized)** يُحدَّث بالأحداث لا بالاستعلام |
| الهدف | **تتبّع كامل ≤ ٢ ثانية** مهما بلغ عمر السجل (الحارس G17) |
| الأرشفة | ما تجاوز مدة الاحتفاظ ينتقل لجداول أرشيف — **يبقى قابلاً للبحث**. مع التقسيم يصير الأرشفة `detach partition` لا `delete` |
| الفهارس | على `doc_no` · `correlation_id` · (`table_name`, `record_id`) · `occurred_at` — و`outbox(correlation_id)` |

---

# 8. الاحتفاظ

| الطبقة | المدة | الأساس |
|---|---|---|
| سجل التدقيق — تشغيلي | **١٨ شهراً** | قرارك |
| سجل التدقيق — مالي واعتمادات | **١٠ سنوات** | قانوني |
| أحداث المجال (`platform.outbox`) | ٥ سنوات | تشغيلي |
| **دفتر المخزون** | ٥ سنوات | **لا يُحذف — يُؤرشف** |
| **الدفتر المالي والقيود** | **١٠ سنوات** | قانوني |
| إثباتات التسليم (السجل) | ٥ سنوات | |
| **صور إثبات التسليم** | **٦٠ يوماً** — مع `legal_hold` تلقائي | قرارك ⚠️ |
| سلاسل التتبّع المجسّدة | تُعاد بناؤها من الدفاتر | |

## 8-1 سياسة الصور — من نيّة إلى حاجز · **v4 · PLT-05 · R-07**

> **المشكلة التي كانت:** القرار الحاكم «حذف بعد ٦٠ يوماً مع `legal_hold` تلقائي» كان **بلا محل تطبيق**: `legal_hold` معرَّف فقط على `platform.documents`، بينما صور إثبات التسليم تعيش في `tms.proof_of_delivery.photo_url` **بلا عمود احتفاظ ولا حجز قانوني ولا `sha256`** الذي يوجبه 40 §C4.

**ما يفرضه v4 على المخطط (13B — انظر `_changelog/PLT-SCHEMA-NEEDS.md`):**

| الجدول | الأعمدة | الغرض |
|---|---|---|
| `tms.proof_of_delivery` | `photo_sha256 text` · `signature_sha256 text` · `legal_hold boolean not null default false` · `hold_reason text` · `retain_until date` | **v4 مطلوب** — بدونها لا تُنفَّذ سياسة الـ٦٠ يوماً ولا يُستوفى 40 §C4 «SHA-256 stored» |
| `platform.documents` | `legal_hold boolean` · `retain_until date` · `checksum text` (SHA-256) · `frozen boolean` | **موجودة في 13B** |

**قاعدة الحجز التلقائي:** يُرفع `legal_hold = true` (مع `hold_reason`) على كل صورة/توقيع مرتبط بمهمة لها صف في:
`tms.delivery_exceptions` · `cc.tickets` (`related_table = 'tms.delivery_tasks'`) · `hr.disciplinary_cases` المرتبطة بالسائق والتاريخ — **بمشغّل، لا بإجراء بشري**.

**ثلاثة قيود تشغيلية:**
1. **الحذف لا يُفعَّل قبل المرحلة ٦** (EXECUTION-MASTER-v4 §1.4) — حتى يُختبر الحجز التلقائي على بيانات حقيقية.
2. `sha256` يُحسب **عند الالتقاط على الجهاز** ويُخزَّن مع الصف — فالصورة تبقى قابلة للإثبات حتى بعد نقل الملف.
3. رفع `legal_hold` (من true إلى false) **فعل يتطلب سبباً ويُسجَّل في التدقيق** — كالتجاوز تماماً (§3-1).

⚠️ **تعارض معالج:** حذف الصور بعد ٦٠ يوماً كان يكسر سلسلة T-1 بعدها. مع `legal_hold` + `retain_until` تبقى السلسلة كاملة لكل ما هو محل نزاع، ويُحذف ما لا أثر له.

---

# 9. الاختبارات الحارسة

> **v4 · R-02:** هذه العشرة تغذّي **G8–G12** في 40 Part F. الحارسان G8 و G10 لهما الآن تنفيذ محدَّد، و G9 صار **استعلام عيّنة معرَّفاً** بدل وصف عام.

| # | الاختبار | الشرط | الحارس / التنفيذ |
|---|---|---|---|
| 1 | سلسلة التجزئة سليمة | **صفر انقطاع** | **G8** = `select * from platform.verify_audit_chain();` — صفر صفوف (§3-3) |
| 2 | كل كتابة لها صف تدقيق | صفر كتابة بلا سجل | **G9** — §9-1 |
| 3 | كل رفض/تجاوز له سبب | صفر بلا سبب | **G10** — §9-2 |
| 4 | لا قيمة مصنَّفة نصاً في التدقيق | **صفر** | G11 · عبر `platform.sanitize_audit` (§3-2) |
| 5 | كل سطر فاتورة له أحداث | صفر سطر يتيم | G12 |
| 6 | كل حدث فوترة له عملية مصدر | صفر حدث يتيم | G12 |
| 7 | كل شحنة مسلَّمة لها إثبات | صفر بلا POD | G5 |
| 8 | كل شحنة لها سائق منسوب | **صفر** | G3 = `imile.verify_attribution(current_date - 30, current_date)` |
| 9 | التتبّع الكامل | ≤ ٢ ثانية | G17 |
| 10 | إعادة بناء الرصيد من الدفتر | **فرق صفر** | G6 |

**أي نتيجة غير فارغة تمنع النشر.**

## 9-1 G9 — كل حدث في `outbox` له صف تدقيق بنفس `correlation_id`

> **v4 · R-02:** «كل كتابة لها صف تدقيق» غير قابل للقياس على الجدول كله. التعريف المعتمد **عيّنة محدَّدة: آخر ١,٠٠٠ كتابة في `outbox`**.

```sql
-- G9 — يجب أن يعيد صفر صفوف
select o.id, o.event_type, o.correlation_id, o.created_at
from (
  select * from platform.outbox order by id desc limit 1000
) o
where not exists (
  select 1 from platform.audit_log a
  where a.correlation_id = o.correlation_id
);
```

## 9-2 G10 — لا رفض ولا تجاوز بلا سبب

```sql
-- G10 — يجب أن يعيد صفر صفوف
select a.id, a.occurred_at, a.operation, a.table_name, a.record_id, a.user_id
from platform.audit_log a
where a.operation in ('reject','override')
  and (a.reason is null or btrim(a.reason) = '');
```

> `override` و`reject` هما الفعلان اللذان يوجب §3-1 لهما سبباً؛ و`void` يخضع لقيد منفصل في `billing`.

---

# 10. الصلاحية على التتبّع

| الدور | ما يراه |
|---|---|
| GM · SYSADMIN | الكل — **والقيم المالية معقّمة في التدقيق** |
| CFO | المالي كاملاً + التشغيلي المرتبط |
| مديرو الوحدات | نطاقهم فقط |
| المشرف | فريقه ومهامه |
| الموظف | **عملياته هو فقط** |
| العميل | شحناته وأوامره وفواتيره — **بلا أسماء موظفينا** |

**نقطة حساسة:** العميل يرى «سُلِّم الساعة ١١:٤٧ مع الإثبات» — **لا يرى اسم السائق**. وهذا قرار خصوصية، ويُراجَع إن طلب عميل خلافه تعاقدياً.

---

# 11. القرارات المسجَّلة

> ⚠️ **مُغلق.** كل قرارات هذا القسم محسومة في **EXECUTION-MASTER-v4 §1** (وسجل القرارات الموحّد R-02 · R-07). يُقرأ هذا الجدول **تاريخياً فقط**. **v4 · PLT-28**

| # | القرار (كما طُرح) | **القرار المسجَّل** | المرجع |
|---|---|---|---|
| 1 | اعتماد سلسلة التجزئة | **مفعَّلة** — مشغّل `platform.audit_hash_chain()` + دالة `platform.verify_audit_chain()` في 13B-2 · الحارس G8 | EXECUTION-MASTER-v4 §1.4 · §3-3 |
| 2 | هل يرى العميل اسم السائق في التتبّع؟ | **لا** | §10 · EXECUTION-MASTER-v4 §1.4 |
| 3 | مدة الاحتفاظ بالتدقيق المالي | **١٠ سنوات** (والتشغيلي ١٨ شهراً) | 40 Part G · §8 |
| 4 | آلية `legal_hold` التلقائي على صور النزاعات | **معتمدة** — أعمدة `legal_hold`/`retain_until`/`sha256` على `tms.proof_of_delivery` (13B) + مشغّل الحجز · **الحذف لا يُفعَّل قبل المرحلة ٦** | R-07 · §8-1 |
| 5 | من يملك صلاحية تصدير سجل التدقيق | **GM و`SYSADMIN` فقط** — وكل تصدير يُسجَّل بنفسه (`operation='export'`) | §3-1 · §10 |
