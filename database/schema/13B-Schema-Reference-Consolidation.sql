-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · 13B — توحيد المخطط المرجعي (Schema Reference Consolidation)
-- وثيقة 13B · PostgreSQL 16 · الإصدار 4.4 · 23/09/2026
--
-- > **v4 — حالة الوثيقة:** حاكمة · **الحاكم عند التعارض:** 40 · 36 ·
-- > EXECUTION-MASTER-v4 · 22 · **التصحيحات المطبّقة في v4:** SCR-1…SCR-7 ·
-- > R-02 · R-04 · R-05 · R-06 · R-07 · **القرارات المفتوحة سابقاً:** مُغلقة في
-- > EXECUTION-MASTER-v4 §1.
--
-- الملف مرحلتان:
--   · **المرحلة الأولى (SCH)** — رفع 39 جدولاً كانت حبيسة كتل ```sql في
--     الوثائق المرجعية. سجل قراراتها ق-1…ق-9 أدناه.
--   · **المرحلة الثانية (SCH-2)** — SCR-1…SCR-7 · قيود الحالات الاثنان
--     والخمسون · RLS الشامل (G7 = 0) · البذور الست. سجل قراراتها ق-10…ق-18
--     في الترويسة الثانية (ابحث عن «المرحلة الثانية من توحيد المخطط»).
--
-- الغرض:
--   البوتستراب يقرّر أن 01 · 13 · 019 هي المخطط الوحيد المسموح، وأي جدول
--   خارجها = توقف واسأل. لكن 37 جدولاً تعتمد عليها الوثائق الحاكمة نفسها
--   (40 · 36 · EXECUTION-MASTER-v4 §1.5–§1.15 (ex DECISIONS-ADDENDUM) · 22) كانت معرَّفة فقط داخل كتل ```sql
--   في الوثائق المرجعية (14 · 15 · 17 · 22 · 23 · 25 · 27 · 29 · 31 · 35 · 36)
--   ولا وجود لها في أي ملف SQL. هذا الملف يرفعها إلى ملف حاكم واحد.
--
--   كل DDL هنا منسوخ حرفياً من وثيقته المصدر، فوقه تعليق `-- المصدر: وثيقة NN §x`.
--   أي تعديل لزم ليعمل الملف أو ليتسق مع اتفاقيات 01/13 مُعلَّم بـ `-- v4:`.
--   أي عمود لا يسنده نص الوثيقة مُعلَّم بـ `-- v4 (استنباط تقني، يحتاج تأكيد GM)`.
--
-- الترتيب الإلزامي للتطبيق:
--   01-Data-Model.sql  →  13-Schema-Additions.sql  →  **13B (هذا الملف)**
--   →  019-Warehouse-WH1-Setup.sql   (ثم guards.sql — انظر apply.sh)
--   سبب الموضع: 13B يعتمد على hr.employees و platform.documents (01)
--   وعلى hr.recruitment_cases و partners.partners و admin.purchase_orders (13)؛
--   و019 يفشل بدون wms.space_blocks و wms.locations.space_block_id المعرَّفين هنا.
--
-- اتفاقيات موروثة من 01 (تسري على كل جدول في هذا الملف):
--   · المفتاح الأساسي uuid  · المال numeric(14,3)  · التوقيت timestamptz
--   · كل جدول تشغيلي يحمل entity_id — محور المحاسبة متعددة الكيانات
--
-- ═══════════════════════════════════════════════════════════════════════════
-- سجل قرارات التوحيد — كل تعارض، كيف حُلّ، ولماذا
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-1 · platform.audit_log — 01 يُنشئه جدولاً عادياً (سطر 115)، و31 §2 يعيد
--       تعريفه بأعمدة أوسع (on_behalf_of · doc_no · changed_fields · reason ·
--       device_id · session_id · request_id · correlation_id) و§7 يفرض تقسيماً
--       شهرياً و§4 يفرض سلسلة تجزئة prev_hash/row_hash. و40 §B2 (الحاكم الأعلى)
--       يقول حرفياً: "Monthly partitions" و"prev_hash, row_hash (SHA-256 chain)".
--       القرار: يُحذف الجدول العادي ويُعاد إنشاؤه مقسَّماً حسب 31 + 40.
--       آمن لأن الحذف يقع في مرحلة البناء والجدول فارغ ولا يشير إليه أي مفتاح
--       أجنبي في 01 ولا 13 ولا 019 (تُحُقِّق بالبحث النصّي في الثلاثة).
--       ⚠️ إن طُبِّق 13B على قاعدة تحمل بيانات تدقيق فعلية، يُستبدل الحذف بهجرة
--          نسخ (create ... partitioned → insert select → rename). لا تنفّذه أعمى.
--
-- ق-2 · platform.outbox (36 §3-1) مقابل platform.domain_events (01 سطر 137).
--       40 §B3 "Events & Outbox" يسمّي platform.outbox وحده ولا يذكر
--       domain_events إطلاقاً؛ و40 §A4 يقول "written to platform.outbox in the
--       same transaction as the state change"؛ و38 مهمة 0.9 تطلب "outbox"؛
--       و36 §3-1 يصف domain_events صراحةً بأنه "الثغرة السابقة… بلا ضمان أن
--       الحدث يُكتب في نفس معاملة تغيير الحالة".
--       القرار: يُنشأ platform.outbox، ويُحذف platform.domain_events (متقاعد —
--       لا يذكره أعلى وثيقة، ولا يشير إليه أي مفتاح أجنبي في 01/13/019).
--       أعمدة 31 §5 على domain_events (correlation_id · causation_id · actor_id ·
--       sequence_no) تُستوعَب في outbox: correlation_id و causation_id موجودان
--       أصلاً، و id bigserial يقوم مقام sequence_no، ويُضاف actor_id.
--
-- ق-3 · platform.thresholds (29) مقابل platform.settings (01 سطر ~60).
--       40 §B5 يفصل بينهما بوضوح: thresholds = حدود عددية يحرّرها المدير العام
--       بلا نشر (invoice.auto_approve_max · purchase.auto_max …) وقيمتها
--       numeric(14,3)؛ settings = إعدادات عامة بقيمة jsonb وأنواع مختلطة
--       (نصوص ومنطقيات مثل storage_cbm_basis في 019 §8 و driver.ranking.* في 35).
--       القرار: كلاهما يبقى بدوره. لا دمج. الحد العددي ⇒ thresholds؛ الإعداد
--       غير العددي ⇒ settings.
--
-- ق-4 · أعمدة تضيفها وثيقة على جدول قائم ⇒ `alter table … add column if not exists`
--       دائماً (27 §… على platform.documents · 17 §2 على wms.locations ·
--       36 §3-3 على wms.outbound_orders)، حتى حيث كتبتها الوثيقة بلا الشرط،
--       ليبقى الملف قابلاً لإعادة التشغيل (idempotent).
--
-- ق-5 · identity.roles لا يبذرها 01 ولا 13 (تُحُقِّق بالبحث). ومع ذلك
--       platform.domain_owners و platform.approval_chains و identity.sod_rules
--       و identity.delegations (22 §3) كلها تحمل مفاتيح أجنبية إلى
--       identity.roles(code) — فبذور SoD الأربعة في EXECUTION-MASTER-v4 §1.6 (ex DECISIONS-ADDENDUM §2) تفشل
--       بلا بذرة أدوار. القرار: تُبذَر الأدوار الخمسة والعشرون من 40 §B1 حرفياً
--       + DEPUTY_SYSADMIN من EXECUTION-MASTER-v4 §1.7 (ex DECISIONS-ADDENDUM §3) = 26 دوراً. هذه بذرة
--       تمكينية للمفاتيح الأجنبية، ومصفوفة الصلاحيات تبقى مهمة WBS.
--
-- ق-6 · imile.sorting_plans.approved_by موجود في 01 بنوع uuid، لكن
--       EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8) يقول `approved_by = 'engine'` (قيمة نصية).
--       تغيير النوع uuid→text يكسر 01. القرار: يبقى approved_by uuid لمعتمِد
--       بشري، ويُضاف approved_by_kind text ('human' · 'engine') للتفريق.
--       مسجَّل أدناه كاستنباط يحتاج تأكيد GM.
--
-- ق-7 · عدد عتبات ADR-27: EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8) يقول "14 thresholds"، لكن
--       الاستخراج الحرفي لكل قيمة عددية واردة نصاً في §8 يعطي 16 عتبة
--       (8 لـ dtl.* و8 لـ dispatch.*). بُذِرت الست عشرة كما وردت نصاً — لم
--       تُخترَع قيمة ولم تُحذف — والفارق مسجَّل للمدير العام.
--
-- ق-8 · تصنيف الأعمدة identity.column_classification: 01 يُنشئ الجدول (سطر 301)
--       لكنه **لا يبذر فيه أي صف**، ولا 13. فلا نمط بذر قائم يُحتذى، ولأن
--       40 §B1 يشترط "column_classification must cover every column; deploy
--       fails otherwise" فإن التصنيف الشامل (حارس G6) **مهمة WBS مستقلة**
--       تشمل 01 و13 و13B معاً — ولا يُنفَّذ جزئياً هنا لئلا يوهم بتغطية كاملة.
--
-- ق-9 · RLS: تُفعَّل على كل جدول تشغيلي جديد **يحمل entity_id** بنمط 01
--       (entity_scope عبر platform.allowed_entities())، مع سياسة عميل
--       client_portal_scope حيث للعميل حق نظر مباشر فقط. لا سياسة عميل على
--       housing.* ولا partners.* ولا hr.* — العميل لا يصلها إطلاقاً.
--       الجداول المرجعية/الإعدادية بلا entity_id (thresholds · feature_flags ·
--       alert_rules · integration_config · penalty_schedule · failure_reasons …)
--       لا تُفعَّل عليها RLS: هي بيانات مرجعية للمجموعة كلها، وتعميم RLS على
--       بقية الجداول التشغيلية (حارس G7) مهمة WBS كما نصّت ملاحظة 01 رقم 3.
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-0 · المخططات الجديدة
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 14 §2
create schema if not exists housing;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-1 · المنصة — الأحداث والأعلام (40 §B3 · §B5 · 36 §3-1 · §3-3)
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 36 §3-1 (ومطابق لنص 40 §B3 حرفاً بحرف)
-- الضمان: الحدث يُكتب أو لا يُكتب مع الحالة — لا حالة ثالثة.
create table platform.outbox (
  id bigserial primary key,
  aggregate_type text not null, aggregate_id uuid not null,
  event_type text not null, payload jsonb not null,
  correlation_id uuid not null, causation_id uuid,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts int not null default 0, last_error text,
  actor_id uuid   -- v4: من 31 §5 (كان على domain_events المتقاعد) — الفاعل المسبِّب للحدث
);
create index on platform.outbox (published_at) where published_at is null;
-- v4: فهرس الارتباط — 31 §7 يفرض فهرساً على correlation_id لهدف "تتبّع ≤ ٢ ثانية"
create index on platform.outbox (correlation_id);
comment on table platform.outbox is
  'صندوق صادر معامَلاتي — 40 §B3. يُكتب في نفس معاملة تغيير الحالة؛ ناقل ينشر كل ثانية. يحل محل platform.domain_events (ق-2)';

-- ق-2: تقاعُد platform.domain_events — 40 §B3 لا يذكره، و36 §3-1 يصفه بالثغرة.
-- ⚠️ سطر واحد قابل للعكس: احذف هذا السطر وحده إن قرّر المدير العام إبقاء الجدول.
drop table if exists platform.domain_events;

-- المصدر: وثيقة 36 §3-4 (وثيقة 40 §B5)
create table platform.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  rollout_pct int not null default 100,        -- إطلاق تدريجي
  enabled_for_roles text[],
  kill_switch boolean not null default false,  -- إيقاف طارئ يتجاوز كل شيء
  changed_by uuid, changed_at timestamptz
);

-- المصدر: وثيقة 36 §3-3 — التزامن التفاؤلي
-- v4: أُضيف `if not exists` (ق-4). الوثيقة تقول "كل كيان قابل للتعديل يحمل version"؛
--     هنا يُطبَّق حرفياً على الجدول المذكور فقط، والتعميم مهمة WBS.
alter table wms.outbound_orders add column if not exists version int not null default 1;
comment on column wms.outbound_orders.version is
  'تزامن تفاؤلي 36 §3-3: WHERE id=$1 AND version=$2 → SET version=version+1. صفر صفوف = تعارض → 409';


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-2 · المنصة — سجل التدقيق المقسَّم وسلسلة التجزئة (ق-1 · 31 §2 §4 §7 · 40 §B2)
-- ═══════════════════════════════════════════════════════════════════════════

-- ق-1: الجدول فارغ في مرحلة البناء ولا يشير إليه أي مفتاح أجنبي — يُحذف ويُعاد
-- إنشاؤه مقسَّماً. لا تنفّذ هذا على قاعدة تحمل بيانات تدقيق فعلية (انظر ق-1).
drop table if exists platform.audit_log;

-- المصدر: وثيقة 31 §2 (منسوخ حرفياً) + §7 التقسيم + 40 §B2
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
  -- المصدر: وثيقة 31 §3-3 — سلسلة التجزئة
  prev_hash     text,
  row_hash      text,
  -- v4.3 · SCR-AUDIT-01 / ADR-0002: ترتيب السلسلة — يملؤه المشغّل وحده (السابق + 1 تحت القفل)؛ أي قيمة من المستدعي تُستبدل.
  chain_seq     bigint not null,
  -- v4: المفتاح الأساسي في جدول مقسَّم يجب أن يتضمّن مفتاح التقسيم؛
  --     31 كتب `id bigserial primary key` وهو غير صالح على جدول مقسَّم.
  primary key (id, occurred_at)
) partition by range (occurred_at);

-- المصدر: وثيقة 31 §2 — الفهارس كما وردت
create index on platform.audit_log (table_name, record_id, occurred_at desc);
create index on platform.audit_log (user_id, occurred_at desc);
create index on platform.audit_log (doc_no) where doc_no is not null;
create index on platform.audit_log (correlation_id);
create index on platform.audit_log (occurred_at desc);

revoke update, delete on platform.audit_log from public;

-- المصدر: وثيقة 31 §7 — تقسيم شهري (المثال الوارد نصاً هو 2026_10)
create table platform.audit_log_2026_10 partition of platform.audit_log
  for values from ('2026-10-01') to ('2026-11-01');
-- v4: أقسام الأشهر المجاورة + قسم افتراضي، وإلا فشل كل إدراج خارج أكتوبر 2026.
--     إنشاء القسم الشهري المقبل مهمة مجدولة (WBS) — القسم الافتراضي شبكة أمان.
create table platform.audit_log_2026_09 partition of platform.audit_log
  for values from ('2026-09-01') to ('2026-10-01');
create table platform.audit_log_2026_11 partition of platform.audit_log
  for values from ('2026-11-01') to ('2026-12-01');
create table platform.audit_log_2026_12 partition of platform.audit_log
  for values from ('2026-12-01') to ('2027-01-01');
create table platform.audit_log_default partition of platform.audit_log default;

-- v4.3 · SCR-AUDIT-01 / ADR-0002 (قرار GM 23/09/2026): فهرس فريد على chain_seq في كل قسم — الافتراضي ضمناً.
--   لا قيد فريداً ممكناً على الأب المقسَّم (يجب أن يتضمّن occurred_at). التفرّد الكلي يضمنه القفل الاستشاري،
--   والتكرار عبر الأقسام تكشفه verify_audit_chain(). كل قسم جديد يحمل هذا الفهرس، وG8 يفشل إن غاب.
create unique index audit_log_2026_09_chain_seq_key on platform.audit_log_2026_09 (chain_seq);
create unique index audit_log_2026_10_chain_seq_key on platform.audit_log_2026_10 (chain_seq);
create unique index audit_log_2026_11_chain_seq_key on platform.audit_log_2026_11 (chain_seq);
create unique index audit_log_2026_12_chain_seq_key on platform.audit_log_2026_12 (chain_seq);
create unique index audit_log_default_chain_seq_key on platform.audit_log_default (chain_seq);

-- v4.3: الدالة القديمة بلا معاملات تُحذف قبل إنشاء النسخة ذات معاملات الارتكاز — وإلا صار
--       الاستدعاء بلا معاملات ملتبساً عند إعادة تطبيق 13B على قاعدة قائمة.
drop function if exists platform.verify_audit_chain();

-- المصدر: وثيقة 31 §3-3 — row_hash = sha256(prev_hash || occurred_at || user_id || table_name || record_id || operation)
-- v4.3 · SCR-AUDIT-01 / ADR-0002 (قرار GM 23/09/2026): ترتيب السلسلة = chain_seq = السابق + 1، يُحسب هنا بعد
--   القفل الاستشاري في الاستعلام نفسه الذي يجلب التجزئة السابقة (بلا كائن تسلسل؛ التراجع لا يترك فجوة).
--   · القفل محجوز حتى الالتزام أو التراجع ⇒ كل كتابات التدقيق متسلسلة (ADR-0002 §الأثر).
--   · security definer: audit_log تحت FORCE RLS وentity_scope على الأب (D-002) — الرأس يُقرأ كاملاً.
--     يشترط أن يكون مالك الدالة superuser أو BYPASSRLS (يتحقق الترحيل 0004 من ذلك).
--   · READ COMMITTED فقط: تحت REPEATABLE READ/SERIALIZABLE لا يرى الاستعلام صف حامل القفل السابق فيتكرر الرقم.
--   · timezone/datestyle مثبّتان: تمثيل occurred_at::text في الصيغة لا يتبع إعدادات جلسة الكاتب.
create or replace function platform.audit_hash_chain()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
declare
  v_prev text;
  v_seq  bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'platform.audit_hash_chain: audited writes must run under READ COMMITTED (current: %)',
      current_setting('transaction_isolation')
      using errcode = '25001';
  end if;

  perform pg_advisory_xact_lock(hashtext('platform.audit_log'));
  select a.chain_seq, a.row_hash
    into v_seq, v_prev
    from platform.audit_log a
   order by a.chain_seq desc
   limit 1;

  new.chain_seq := coalesce(v_seq, 0) + 1;
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

-- G8 (40 Part F): يجب أن تعيد صفر صفوف. ترتّب بـ chain_seq فقط. نقطة الارتكاز (ADR-0002): بعد فصل أقسام
-- قديمة أو أرشفتها تُستدعى بأول chain_seq محتفَظ به وبتجزئته السابقة. security definer للسبب نفسه أعلاه:
-- مستدعٍ لا يتجاوز RLS سيرى جزءاً من السلسلة فتظهر فجوات زائفة.
create or replace function platform.verify_audit_chain(
  p_anchor_seq       bigint default 1,
  p_anchor_prev_hash text   default null)
returns table (chain_seq bigint, id bigint, occurred_at timestamptz, problem text, detail text,
               expected_hash text, actual_hash text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
  with ordered as (
    select a.chain_seq, a.id, a.occurred_at, a.user_id, a.table_name, a.record_id, a.operation,
           a.prev_hash, a.row_hash,
           row_number()     over w as rn,
           lag(a.chain_seq) over w as seq_prev,
           lag(a.row_hash)  over w as hash_prev
      from platform.audit_log a
     where a.chain_seq >= p_anchor_seq
    window w as (order by a.chain_seq, a.id)
  ), checked as (
    select o.*,
           case when o.rn = 1 then p_anchor_prev_hash else o.hash_prev    end as expected_prev,
           case when o.rn = 1 then p_anchor_seq       else o.seq_prev + 1 end as expected_seq,
           (o.rn > 1 and o.chain_seq = o.seq_prev)                           as is_duplicate
      from ordered o
  ), hashed as (
    select c.*,
           encode(sha256(convert_to(
             coalesce(c.expected_prev,'')
             || coalesce(c.occurred_at::text,'')
             || coalesce(c.user_id::text,'')
             || coalesce(c.table_name,'')
             || coalesce(c.record_id::text,'')
             || coalesce(c.operation,''), 'UTF8')), 'hex') as expected_row_hash
      from checked c
  )
  select h.chain_seq, h.id, h.occurred_at, p.problem, p.detail, p.expected, p.actual
    from hashed h
   cross join lateral (values
     ('duplicate_chain_seq', 'chain_seq repeated', null::text, null::text,
        h.is_duplicate),
     ('chain_seq_gap', 'expected chain_seq ' || h.expected_seq, null, null,
        h.chain_seq <> h.expected_seq and not h.is_duplicate),
     ('prev_hash_mismatch', 'expected/actual are prev_hash values', h.expected_prev, h.prev_hash,
        h.prev_hash is distinct from h.expected_prev),
     ('hash_mismatch', 'expected/actual are row_hash values', h.expected_row_hash, h.row_hash,
        h.row_hash is distinct from h.expected_row_hash)
   ) as p(problem, detail, expected, actual, failed)
   where p.failed
  union all
  -- نقطة ارتكاز فارغة أو أعلى من رأس السلسلة لا تُرجع «سليم» بصمت (مراجعة الجولة 2، الملاحظة 3).
  select null, null, null, 'anchor_invalid', 'p_anchor_seq is null', null, null
   where p_anchor_seq is null
  union all
  select null, null, null, 'anchor_not_found', 'no row with chain_seq >= ' || p_anchor_seq, null, null
   where p_anchor_seq is not null
     and exists (select 1 from platform.audit_log)
     and not exists (select 1 from platform.audit_log a where a.chain_seq >= p_anchor_seq)
  union all
  -- الدالتان security definer: مالكهما يجب أن يتجاوز FORCE RLS، وإلا رأت الدالتان جزءاً من السلسلة
  -- وأعاد G8 «صفر» على سلسلة مكسورة. يُفحص في كل تشغيل لا عند الترحيل فقط (الملاحظة 2).
  select null, null, null, 'definer_owner_cannot_bypass_rls', 'platform.' || p.proname || ' owned by ' || r.rolname, null, null
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.pronamespace = 'platform'::regnamespace
     and p.proname in ('audit_hash_chain', 'verify_audit_chain')
     and not (r.rolsuper or r.rolbypassrls)
  union all
  -- شرط GM (1): كل قسم — الافتراضي ضمناً — يحمل فهرساً فريداً صالحاً، بلا شرط ولا تعبير، مفتاحه chain_seq وحده.
  -- الفحص بخصائص pg_index لا باسم الفهرس.
  select null, null, null, 'partition_missing_chain_seq_unique_index', n.nspname || '.' || c.relname, null, null
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c     on c.oid = i.inhrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where i.inhparent = 'platform.audit_log'::regclass
     and not exists (
       select 1
         from pg_catalog.pg_index x
         join pg_catalog.pg_attribute att
           on att.attrelid = c.oid and att.attname = 'chain_seq' and att.attnum = x.indkey[0]
        where x.indrelid = c.oid
          and x.indisunique and x.indisvalid
          and x.indpred is null and x.indexprs is null
          and x.indnatts = 1)
$$;

comment on function platform.verify_audit_chain(bigint, text) is
  'G8 (40 Part F): صفر صفوف. ترتيب chain_seq فقط؛ يكشف عدم تطابق row_hash وprev_hash والتكرار والفجوات وقسماً بلا فهرس chain_seq الفريد ونقطة ارتكاز فارغة أو غائبة ومالكاً لا يتجاوز RLS. الارتكاز بعد فصل الأقسام: ADR-0002.';
revoke all on function platform.verify_audit_chain(bigint, text) from public;
-- الملاحظة 1: دالة المشغّل security definer — لا تُتاح لأي دور لإلحاقها بجدول آخر. المشغّل القائم يعمل
-- لأن صلاحية EXECUTE تُفحص عند create trigger فقط.
revoke all on function platform.audit_hash_chain() from public;

create trigger trg_audit_hash_chain before insert on platform.audit_log
  for each row execute function platform.audit_hash_chain();

-- المصدر: وثيقة 31 §3-2 — المعقِّم
create or replace function platform.sanitize_audit(p_schema text, p_table text, p_data jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k,
           case when c.sensitivity in ('payroll','commercial','secret','personal')
                then to_jsonb('•••'::text) else v end), '{}'::jsonb)
  from jsonb_each(p_data) as e(k,v)
  left join identity.column_classification c
    on c.schema_name=p_schema and c.table_name=p_table and c.column_name=e.k
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-3 · المنصة — القرارات والأتمتة والعتبات (29 §… · 40 §B5)
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 29 §8
create table platform.automation_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  process text not null,
  level char(2) not null,              -- A0 · A1 · A2 · A3
  auto_condition text,                 -- شرط التنفيذ الآلي
  exception_condition text,            -- ما يُرفع للبشر
  escalate_to_roles text[],
  threshold_key text,                  -- مفتاح في platform.thresholds
  owner_role text not null,
  is_active boolean not null default true,
  changed_by uuid, changed_at timestamptz
);

-- المصدر: وثيقة 29 §8 (وثيقة 40 §B5) — ق-3: منفصل عن platform.settings بدور مختلف
create table platform.thresholds (
  key text primary key,                -- invoice.auto_approve_max · purchase.auto_max …
  value numeric(14,3) not null,
  unit text,
  description_ar text not null,
  changed_by uuid not null,
  changed_at timestamptz not null default now()
);
comment on table platform.thresholds is
  'الحدود العددية التي يحرّرها المدير العام بلا نشر (40 §B5). الإعداد غير العددي في platform.settings — ق-3';

-- المصدر: وثيقة 29 §8 — صندوق القرارات (40 §B5)
create table platform.decisions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references platform.entities(id),
  kind text not null,                  -- price_exception · invoice_approval · cod_variance …
  title_ar text not null,
  context jsonb not null,              -- الوقائع المحسوبة — لا نص حر
  financial_impact numeric(14,3),
  urgency text not null default 'normal',
  source_table text, source_id uuid,
  assigned_role text not null,
  assigned_user_id uuid,
  status text not null default 'open', -- open · decided · expired · auto_resolved
  decision text, decision_note text,
  decided_by uuid, decided_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now()
);
create index on platform.decisions (assigned_role, status, urgency, financial_impact desc);


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-4 · المنصة — التكامل والتنبيهات (23 §2 · 25 §3 · 40 §B6)
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 23 §2
create table platform.integration_config (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- I-01 …
  name_ar text not null,
  direction text not null,                   -- inbound · outbound · both
  transport text not null,                   -- agent · rest · file · smtp
  schedule text,                             -- cron أو 'realtime'
  owner_user_id uuid not null,
  idempotency_key text not null,             -- الحقل الذي يمنع التكرار
  retry_max int not null default 3,
  retry_backoff_sec int not null default 60,
  on_failure text not null,                  -- halt · skip_log · manual_queue
  alert_after_failures int not null default 2,
  alert_roles text[] not null,
  raw_retention_days int not null default 90,
  manual_fallback text not null,             -- الإجراء اليدوي البديل
  is_active boolean not null default true
);

-- المصدر: وثيقة 23 §2
create table platform.integration_queue (      -- ما فشل ويحتاج تدخلاً
  id uuid primary key default gen_random_uuid(),
  integration text not null,
  payload jsonb not null,
  error text,
  attempts int not null default 0,
  status text not null default 'pending',     -- pending · resolved · discarded
  created_at timestamptz not null default now(),
  resolved_by uuid, resolved_at timestamptz, resolution_note text
);
-- v4: فهرس على حالة الطابور — الشاشة التشغيلية تقرأ pending وحدها
create index on platform.integration_queue (status, created_at);

-- المصدر: وثيقة 25 §3
-- 40 §B6: "An alert without an action link is invalid" — action_label و action_link not null
create table platform.alert_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  source_query text not null,              -- الاستعلام الذي يرصد الحالة
  target_roles text[] not null,
  channels text[] not null,                -- in_app · email · whatsapp · sms
  schedule text not null,                  -- realtime أو cron
  dedupe_window_hours int not null default 24,
  quiet_hours boolean not null default true,
  escalate_after_hours int,
  escalate_to_roles text[],
  action_label text not null,              -- نص الزر
  action_link text not null,               -- الشاشة التي يفتحها
  is_active boolean not null default true,
  muted_until timestamptz, muted_by uuid, mute_reason text
);

-- المصدر: وثيقة 25 §3
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


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-5 · الحوكمة — الملكية وسلاسل الاعتماد والإنابة وفصل المهام (22 §3 · 40 §B1)
-- ═══════════════════════════════════════════════════════════════════════════

-- ق-5: بذرة الأدوار أولاً — كل ما يليها يرتبط بها بمفاتيح أجنبية.
-- المصدر: وثيقة 40 §B1 "Roles (codes)" — الخمسة والعشرون حرفياً بترتيبها
--         + DEPUTY_SYSADMIN من EXECUTION-MASTER-v4 §1.7 (ex DECISIONS-ADDENDUM §3).
-- v4 ADM-15: النطاقات ثمانية حصراً (02 §x) — قيد على identity.roles.scope_type
do $$ begin
  alter table identity.roles add constraint valid_scope
    check (scope_type in ('all','entity','org_unit','subordinates','assigned','account','client','self'));
exception when duplicate_object then null; end $$;

insert into identity.roles (code, name_ar, name_en, scope_type) values
 ('GM',             'المدير العام',              'General Manager',        'all'),
 ('OWNER',          'المالك',                    'Owner',                  'all'),
 ('SYSADMIN',       'مدير النظام',               'System Administrator',   'all'),
 ('DEPUTY_SYSADMIN','نائب مدير النظام',          'Deputy System Admin',    'all'),
 ('CFO',            'المدير المالي',             'Chief Financial Officer','all'),
 ('ACCOUNTANT',     'المحاسب',                   'Accountant',             'entity'),
 ('COST_ANALYST',   'محلل التكاليف',             'Cost Analyst',           'all'),
 ('SALES_MGR',      'مدير المبيعات',             'Sales Manager',          'all'),
 ('SALES_REP',      'مندوب المبيعات',            'Sales Representative',   'assigned'),
 ('OPS_DIR',        'مدير العمليات',             'Operations Director',    'all'),
 ('WH_MGR',         'مدير المستودع',             'Warehouse Manager',      'entity'),
 ('WH_SUP',         'مشرف المستودع',             'Warehouse Supervisor',   'org_unit'),
 ('WH_OP',          'عامل المستودع',             'Warehouse Operator',     'self'),
 ('DEL_MGR',        'مدير التوصيل',              'Delivery Manager',       'entity'),
 ('DEL_SUP',        'مشرف التوصيل',              'Delivery Supervisor',    'org_unit'),
 ('DRIVER',         'السائق',                    'Driver',                 'self'),
 ('FLEET_MGR',      'مدير الأسطول',              'Fleet Manager',          'all'),
 ('CC_MGR',         'مدير الكول سنتر',           'Call Center Manager',    'entity'),
 ('CC_AGENT',       'وكيل الكول سنتر',           'Call Center Agent',      'self'),
 ('HR_MGR',         'مدير الموارد البشرية',      'HR Manager',             'all'),
 ('PRO',            'المندوب الحكومي والتحصيل',  'PRO / Collections',      'all'),
 ('HOUSING_SUP',    'مشرف السكن',                'Housing Supervisor',     'all'),
 ('CLIENT_ADMIN',   'مسؤول العميل',              'Client Administrator',   'client'),
 ('CLIENT_CREATOR', 'منشئ طلبات العميل',         'Client Creator',         'client'),
 ('CLIENT_VIEWER',  'مطالع العميل',              'Client Viewer',          'client'),
 ('CLIENT_FINANCE', 'مالية العميل',              'Client Finance',         'client')
on conflict (code) do nothing;
-- ملاحظة 40 §B1: "Current staffing collapses some: GM = SYSADMIN; PRO = ACCOUNTANT;
-- no OPS_DIR/HR_MGR". الأدوار تبقى معرَّفة، والإسناد بيانات — لذا تُبذَر كلها.

-- المصدر: وثيقة 22 §3 (وثيقة 40 §B5)
create table platform.domain_owners (
  domain_code text primary key,            -- D01 … D12
  owner_role text not null references identity.roles(code),
  approver_role text references identity.roles(code),
  gate_target_pct numeric(5,2) not null default 100,
  changed_by uuid not null, changed_at timestamptz not null default now()
);

-- المصدر: وثيقة 22 §3 (وثيقة 40 §B5)
create table platform.approval_chains (
  id uuid primary key default gen_random_uuid(),
  request_type text not null,              -- invoice · purchase · price_exception · credit_note · leave · penalty
  step_no int not null,
  approver_role text not null references identity.roles(code),
  min_amount numeric(14,3),                -- الخطوة تنطبق فوق هذا المبلغ
  max_amount numeric(14,3),
  auto_approve_below numeric(14,3),        -- اعتماد آلي تحته
  is_active boolean not null default true,
  changed_by uuid, changed_at timestamptz,
  unique (request_type, step_no)
);

-- المصدر: وثيقة 22 §3 — الإنابة ≤ 90 يوماً بنهاية إلزامية (40 §B1)
create table identity.delegations (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references identity.users(id),
  to_user_id uuid not null references identity.users(id),
  role_code text not null references identity.roles(code),
  scope jsonb,                             -- تقييد اختياري
  valid_from timestamptz not null,
  valid_to timestamptz not null,           -- إلزامي — لا إنابة مفتوحة
  reason text not null,
  approved_by uuid not null,
  constraint bounded check (valid_to > valid_from and valid_to <= valid_from + interval '90 days')
);
comment on table identity.delegations is
  'EXECUTION-MASTER-v4 §1.6 (ex DECISIONS-ADDENDUM §2) (ADR-16c): الإنابة لا تتجاوز فصل المهام أبداً';

-- المصدر: وثيقة 22 §3
create table identity.sod_rules (
  id uuid primary key default gen_random_uuid(),
  role_a text not null references identity.roles(code),
  role_b text not null references identity.roles(code),
  reason_ar text not null,
  is_active boolean not null default true,
  unique (role_a, role_b)
);

-- القواعد الافتراضية — المصدر: وثيقة 22 §3 (ثلاث قواعد)
-- v4: EXECUTION-MASTER-v4 §1.6 (ex DECISIONS-ADDENDUM §2) (الأعلى أسبقية) يفرض **أربعاً** بإضافة (PRO, CFO):
--     "identity.sod_rules defaults: (CFO,ACCOUNTANT) · (SALES_MGR,CFO) ·
--      (WH_OP,WH_SUP) · **(PRO,CFO)**". وسبب الرابعة في §3: "PRO = ACCOUNTANT:
--      PRO never holds CFO; separate receipt series; CFO reconciles both cash streams".
insert into identity.sod_rules (role_a, role_b, reason_ar) values
 ('CFO','ACCOUNTANT','معتمِد الفاتورة لا يسجّل السداد'),
 ('SALES_MGR','CFO','من يبيع لا يحدّد الحد الأدنى'),
 ('WH_OP','WH_SUP','الملتقط لا يدقّق التقاطه'),
 ('PRO','CFO','المحصِّل لا يطابق الحسابات البنكية — EXECUTION-MASTER-v4 §1.6 (ex DECISIONS-ADDENDUM §2)')
on conflict (role_a, role_b) do nothing;

-- حارس: إسناد دور يخالف قاعدة فصل يُرفض — المصدر: وثيقة 22 §3
create or replace function identity.check_sod()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from identity.user_roles ur
    join identity.roles r on r.id = ur.role_id
    join identity.sod_rules s on (s.role_a = r.code and s.role_b = (select code from identity.roles where id = new.role_id))
                              or (s.role_b = r.code and s.role_a = (select code from identity.roles where id = new.role_id))
    where ur.user_id = new.user_id and ur.revoked_at is null and s.is_active
  ) then
    raise exception 'إسناد الدور يخالف قاعدة فصل المهام';
  end if;
  return new;
end $$;
drop trigger if exists trg_sod on identity.user_roles;   -- v4: ليبقى الملف قابلاً لإعادة التشغيل
create trigger trg_sod before insert or update of role_id, user_id, revoked_at on identity.user_roles
  for each row execute function identity.check_sod();   -- v4 ADM-25: يشمل التحديث لا الإدراج فقط


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-6 · الموارد البشرية — لائحة الجزاءات والقضايا التأديبية (15 §6)
--          قانون العمل الكويتي 6/2010 — م.35 · م.37 · م.41
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 15 §6
create table hr.penalty_schedule (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,              -- ATT-01 … SYS-04
  category text not null,                 -- attendance · work · vehicle · client · safety · conduct · housing · custody · system
  offence_ar text not null, offence_en text,
  degree_1 text not null, degree_1_days numeric(4,2) default 0,
  degree_2 text not null, degree_2_days numeric(4,2) default 0,
  degree_3 text not null, degree_3_days numeric(4,2) default 0,
  degree_4 text not null, degree_4_days numeric(4,2) default 0,
  allows_dismissal boolean not null default false,
  dismissal_article text,                 -- 41/a · 41/b
  charges_damage boolean not null default false,
  is_active boolean not null default true,
  sort_order int
);
comment on table hr.penalty_schedule is
  'لائحة الجزاءات — البنود نفسها في وثيقة 15 §2..§5 وتُبذَر كمهمة WBS (بيانات مرجعية، ليست DDL)';

-- المصدر: وثيقة 15 §6
create table hr.disciplinary_cases (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  employee_id uuid not null references hr.employees(id),
  penalty_code text not null references hr.penalty_schedule(code),
  incident_date date not null,
  proven_date date not null,              -- تاريخ ثبوت الواقعة
  reported_by uuid not null,
  description text not null,
  evidence_urls text[],
  occurrence_no int not null,             -- محسوب: رقم المرة خلال 12 شهراً
  applied_degree int not null,            -- 1..4
  penalty_type text not null,             -- verbal · written · deduction · dismissal
  deduction_days numeric(4,2) default 0,
  deduction_amount numeric(14,3) default 0,
  damage_amount numeric(14,3) default 0,
  -- إجراءات المادة 37
  notified_at date, statement_heard boolean default false,
  defence_investigated boolean default false,
  investigation_minutes_url text,
  decision_notified_at date,
  -- التوقيع والامتناع
  signed_at date, refused_to_sign boolean default false,
  witness1_name text, witness1_civil_id text,
  witness2_name text, witness2_civil_id text,
  -- التظلّم
  status text not null default 'draft',
  -- draft · issued · grievance_filed · upheld · cancelled · applied · carried_forward
  grievance_filed_at date, grievance_note text,
  grievance_decided_at date, grievance_decided_by uuid,
  grievance_outcome text,                 -- upheld · cancelled · reduced
  -- الترحيل
  payroll_period date, carried_forward_amount numeric(14,3) default 0,
  approved_by uuid, approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no),
  -- م.35: لا جزاء بعد 15 يوماً من الثبوت
  constraint art35_15_days check (incident_date >= proven_date - interval '15 days'),
  -- م.37: لا خصم بلا استيفاء الإجراءات
  constraint art37_due_process check (
    penalty_type <> 'deduction'
    or (notified_at is not null and statement_heard
        and defence_investigated and decision_notified_at is not null)
  ),
  -- الامتناع يتطلب شاهدين مختلفين
  constraint witnesses_required check (
    not refused_to_sign
    or (witness1_civil_id is not null and witness2_civil_id is not null
        and witness1_civil_id <> witness2_civil_id)
  )
);
create index on hr.disciplinary_cases (employee_id, penalty_code, incident_date desc);

-- عدّاد التكرار خلال 12 شهراً — يحدد الدرجة المستحقة — المصدر: وثيقة 15 §6
create or replace function hr.next_penalty_degree(p_employee uuid, p_code text)
returns int language sql stable as $$
  select least(4, 1 + count(*)::int)
  from hr.disciplinary_cases
  where employee_id = p_employee
    and penalty_code = p_code
    and incident_date >= current_date - interval '12 months'
    and status in ('issued','upheld','applied','carried_forward')
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-7 · السكن (housing) — 14 §2 · §5
--          العميل لا يصل هذا المخطط إطلاقاً (ق-9) — لا سياسة عميل
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 14 §2
create table housing.properties (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  code text not null unique,
  name text not null,
  property_type text not null,        -- building · villa · apartment_block
  governorate text, area text, block text, street text, building_no text,
  landlord_name text, landlord_phone text,
  lease_start date, lease_end date,
  monthly_rent numeric(14,3),
  deposit_amount numeric(14,3),
  notice_days int default 60,
  utilities_included boolean not null default false,
  lease_file_url text,
  status text not null default 'active',
  cost_center text,
  created_at timestamptz not null default now()
);
create index on housing.properties (lease_end);

-- المصدر: وثيقة 14 §2
create table housing.units (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references housing.properties(id),
  code text not null,
  floor text, unit_no text,
  unit_type text not null default 'apartment',
  monthly_rent numeric(14,3),         -- إن كانت مؤجَّرة منفردة
  electricity_meter text, water_meter text,
  status text not null default 'active',   -- active · maintenance · vacant · closed
  unique (property_id, code)
);

-- المصدر: وثيقة 14 §2
create table housing.rooms (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references housing.units(id),
  code text not null,
  room_type text not null default 'bedroom',  -- bedroom · shared · supervisor
  area_sqm numeric(8,2),
  bed_capacity int not null,
  has_ac boolean default true,
  status text not null default 'active',
  unique (unit_id, code),
  constraint positive_capacity check (bed_capacity > 0)
);

-- المصدر: وثيقة 14 §2
create table housing.beds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references housing.rooms(id),
  code text not null,                  -- HS-A-101-B3
  bed_type text default 'single',      -- single · bunk_upper · bunk_lower
  status text not null default 'available',
  -- available · occupied · reserved · maintenance · blocked
  block_reason text,
  unique (room_id, code)
);
create index on housing.beds (status);

-- الإسناد — محدود بالزمن كإسناد معرّفات السائقين — المصدر: وثيقة 14 §2
create table housing.bed_assignments (
  id uuid primary key default gen_random_uuid(),
  bed_id uuid not null references housing.beds(id),
  employee_id uuid not null references hr.employees(id),
  assigned_from date not null,
  assigned_to date,
  assigned_by uuid not null,
  monthly_charge numeric(14,3) not null default 0,   -- خصم السكن
  charge_waived boolean not null default false,
  waiver_reason text,
  end_reason text,      -- transferred · resigned · terminated · vacated · disciplinary
  handover_doc_id uuid references platform.documents(id),
  created_at timestamptz not null default now(),
  constraint valid_period check (assigned_to is null or assigned_to >= assigned_from)
);
-- سرير واحد لساكن واحد في أي لحظة
create unique index on housing.bed_assignments (bed_id) where assigned_to is null;
-- موظف واحد في سرير واحد
create unique index on housing.bed_assignments (employee_id) where assigned_to is null;
create index on housing.bed_assignments (bed_id, assigned_from, assigned_to);

-- حجز مسبق للمستقدَمين قبل وصولهم — المصدر: وثيقة 14 §2
create table housing.bed_reservations (
  id uuid primary key default gen_random_uuid(),
  bed_id uuid not null references housing.beds(id),
  recruitment_case_id uuid references hr.recruitment_cases(id),
  reserved_for text,                 -- اسم المرشح قبل إنشاء ملف الموظف
  reserved_from date not null,
  expires_at date not null,
  reserved_by uuid not null,
  status text not null default 'active',   -- active · converted · expired · cancelled
  notes text
);

-- المصدر: وثيقة 14 §2
create table housing.assets (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references housing.units(id),
  room_id uuid references housing.rooms(id),
  asset_type text not null,     -- ac · fridge · washer · heater · bed · mattress · cooker
  brand text, serial_no text,
  purchase_date date, purchase_value numeric(14,3),
  condition text not null default 'good',
  last_service_date date, next_service_date date,
  status text not null default 'working'
);

-- المصدر: وثيقة 14 §2
create table housing.maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  property_id uuid references housing.properties(id),
  unit_id uuid references housing.units(id),
  room_id uuid references housing.rooms(id),
  housing_asset_id uuid references housing.assets(id),
  reported_by uuid,
  category text not null,       -- ac · plumbing · electrical · appliance · pest · cleaning · structural
  priority text not null default 'normal',   -- low · normal · high · emergency
  description text not null,
  photo_urls text[],
  status text not null default 'open',
  -- open · assigned · in_progress · resolved · closed · rejected
  assigned_to uuid, vendor_id uuid references partners.partners(id),
  purchase_order_id uuid references admin.purchase_orders(id),
  cost numeric(14,3) default 0,
  charged_to_resident boolean not null default false,   -- إتلاف متعمَّد
  resolved_at timestamptz, closed_at timestamptz,
  sla_hours int not null default 48,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no)
);
create index on housing.maintenance_requests (status, priority, created_at);

-- المصدر: وثيقة 14 §2
create table housing.inspections (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  unit_id uuid not null references housing.units(id),
  inspected_at timestamptz not null default now(),
  inspected_by uuid not null,
  cleanliness_score int,        -- 1-5
  safety_score int,
  occupancy_matches boolean,    -- الساكنون الفعليون = المسجَّلون؟
  unauthorized_occupants int default 0,
  findings text,
  photo_urls text[],
  violations_raised uuid[],     -- تُربط ببنود لائحة الجزاءات
  follow_up_date date,
  unique (entity_id, doc_no)
);

-- المصدر: وثيقة 14 §2
create table housing.utility_bills (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  property_id uuid not null references housing.properties(id),
  unit_id uuid references housing.units(id),
  bill_type text not null,      -- electricity · water · internet · gas
  period_from date not null, period_to date not null,
  consumption numeric(14,3),
  amount numeric(14,3) not null,
  due_date date, paid_at date,
  bill_ref text, file_url text,
  purchase_order_id uuid references admin.purchase_orders(id)
);
create index on housing.utility_bills (property_id, period_from);

-- الطاقة والإشغال الحي — المصدر: وثيقة 14 §5
create or replace view housing.capacity_overview as
select
  p.id as property_id, p.code as property_code, p.area,
  count(b.id)                                           as total_beds,
  count(*) filter (where b.status = 'occupied')          as occupied,
  count(*) filter (where b.status = 'reserved')          as reserved,
  count(*) filter (where b.status = 'available')         as available,
  count(*) filter (where b.status in ('maintenance','blocked')) as out_of_service,
  round(100.0 * count(*) filter (where b.status = 'occupied')
        / nullif(count(b.id), 0), 1)                     as occupancy_pct,
  p.monthly_rent,
  round(p.monthly_rent / nullif(count(*) filter (where b.status='occupied'), 0), 3)
                                                         as cost_per_occupied_bed
from housing.properties p
join housing.units u on u.property_id = p.id
join housing.rooms r on r.unit_id = u.id
join housing.beds  b on b.room_id = r.id
where p.status = 'active'
group by p.id, p.code, p.area, p.monthly_rent;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-8 · المستودع — إدارة المساحة (17 §2 · §4 · §5)
--          ⚠️ 019 يفشل بدون هذا القسم
-- ═══════════════════════════════════════════════════════════════════════════

-- كتلة المساحة: وحدة البيع والتخصيص (أعلى من الموقع الفردي)
-- المصدر: وثيقة 17 §2
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
-- ملاحظة: 019 §3 يعتمد على `on conflict (entity_id, warehouse_id, code)` أعلاه.

-- ربط المواقع بالكتلة — المصدر: وثيقة 17 §2
alter table wms.locations add column if not exists space_block_id
  uuid references wms.space_blocks(id);
-- v4: فهرس — 019 §10 (wms.warehouse_capacity) و17 §4 يجمعان بهذا العمود
create index if not exists locations_space_block_idx on wms.locations (space_block_id);

-- تعطيل جزء من الكتلة — المصدر: وثيقة 17 §2
create table wms.space_blocks_out_of_service (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references wms.space_blocks(id),
  qty_pallets numeric(14,3) not null default 0,
  qty_sqm numeric(14,3) not null default 0,
  reason text not null,              -- maintenance · damage · aisle · operational_buffer · safety
  from_date date not null, to_date date,
  created_by uuid not null
);
-- v4: فهرس — دالة 17 §4 (space_availability) ترشّح بـ block_id + المدى الزمني
create index on wms.space_blocks_out_of_service (block_id, from_date, to_date);

-- التخصيص التعاقدي: ما التزمنا به للعميل — المصدر: وثيقة 17 §2
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

-- الحجز: مساحة موعودة قبل التعاقد — المصدر: وثيقة 17 §2
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

-- المصدر: وثيقة 17 §4 — المتاح للبيع
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
    select coalesce(sum(o.pallets_occupied), 0) as q
    from wms.occupancy_snapshots o
    join wms.locations l on l.warehouse_id = o.warehouse_id
    where l.space_block_id = p_block
      and o.snapshot_date = (select max(snapshot_date) from wms.occupancy_snapshots)
  )
  select b.code, 'pallet'::text,   -- v4: تحديد النوع صراحةً — الحرف غير المحدَّد unknown لا text
         b.capacity_pallets, oos.q, alloc.q, resv.q,
         b.capacity_pallets - oos.q - alloc.q - resv.q,     -- المتاح للبيع
         occ.q,
         greatest(alloc.q - occ.q, 0)                        -- متعاقد وغير مشغول
  from b, oos, alloc, resv, occ
$$;

-- يُستدعى قبل اعتماد أي تخصيص أو حجز — المصدر: وثيقة 17 §4
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

-- المصدر: وثيقة 17 §5
create or replace view wms.space_dashboard as
select
  w.code as warehouse, b.code as block, b.block_type,
  b.capacity_pallets as capacity,
  coalesce(a.contracted, 0) as contracted,
  coalesce(r.reserved, 0)   as reserved,
  coalesce(o.occupied, 0)   as occupied,
  b.capacity_pallets - coalesce(a.contracted,0) - coalesce(r.reserved,0) as sellable,
  round(100.0 * coalesce(a.contracted,0) / nullif(b.capacity_pallets,0), 1) as contracted_pct,
  round(100.0 * coalesce(o.occupied,0)   / nullif(b.capacity_pallets,0), 1) as utilization_pct,
  greatest(coalesce(a.contracted,0) - coalesce(o.occupied,0), 0) as idle_contracted,
  b.monthly_cost,
  round(b.monthly_cost / nullif(coalesce(o.occupied,0), 0), 3) as cost_per_occupied_pallet
from wms.space_blocks b
join wms.warehouses w on w.id = b.warehouse_id
left join (select block_id, sum(qty) contracted from wms.space_allocations
            where status='active' group by 1) a on a.block_id = b.id
left join (select block_id, sum(qty) reserved from wms.space_reservations
            where status='active' and expires_at >= current_date group by 1) r on r.block_id = b.id
left join (select l.space_block_id, sum(os.pallets_occupied) occupied
             from wms.occupancy_snapshots os
             join wms.locations l on l.warehouse_id = os.warehouse_id
            where os.snapshot_date = current_date - 1
            group by 1) o on o.space_block_id = b.id
where b.status = 'active';


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-9 · الأسطول — الصيانة والحوادث والوقود (27 §1 · §2 · §3)
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 27 §1
create table tms.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  vehicle_type text not null,
  task text not null,                    -- زيت · فلاتر · إطارات · فرامل · فحص دوري
  interval_km int,                       -- بالكيلومترات — الأساس المعتمد
  interval_days int,                     -- أو بالزمن، أيهما أسبق
  alert_before_km int default 500,
  alert_before_days int default 14,
  estimated_cost numeric(14,3),
  estimated_hours numeric(5,2)
);

-- المصدر: وثيقة 27 §1
create table tms.maintenance_orders (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  vehicle_id uuid not null references tms.vehicles(id),
  plan_id uuid references tms.maintenance_plans(id),
  kind text not null,                    -- preventive · corrective · accident
  odometer_km numeric(12,1) not null,
  reported_issue text,
  workshop_partner_id uuid references partners.partners(id),
  purchase_order_id uuid references admin.purchase_orders(id),
  status text not null default 'planned',
  -- planned · in_workshop · awaiting_parts · done · cancelled
  in_at timestamptz, out_at timestamptz,
  downtime_hours numeric(8,2) generated always as (
    case when out_at is not null and in_at is not null
         then round((extract(epoch from (out_at-in_at))/3600.0)::numeric,2) end) stored,
  -- v4: أُضيف ::numeric — extract يعيد numeric في PG14+، لكن round(double,int) غير معرّفة
  --     وبعض المسارات تُحوّل القسمة إلى double precision. التحويل الصريح يضمن العمل.
  parts_cost numeric(14,3) default 0,
  labour_cost numeric(14,3) default 0,
  total_cost numeric(14,3) generated always as (parts_cost+labour_cost) stored,
  next_due_km numeric(12,1), next_due_date date,
  approved_by uuid,
  unique (entity_id, doc_no)
);

-- المصدر: وثيقة 27 §2 — يعتمد على hr.disciplinary_cases (13B-6 قبله)
create table tms.accidents (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  vehicle_id uuid not null references tms.vehicles(id),
  driver_employee_id uuid references hr.employees(id),
  occurred_at timestamptz not null,
  location text, geo_lat numeric(10,7), geo_lng numeric(10,7),
  severity text not null,                -- minor · major · total_loss
  third_party boolean default false, third_party_details text,
  police_report_no text,
  photo_urls text[],
  insurance_claim_no text,
  claim_status text,                     -- filed · under_review · approved · rejected · paid
  claim_amount numeric(14,3), deductible numeric(14,3),
  driver_at_fault boolean,
  disciplinary_case_id uuid references hr.disciplinary_cases(id),
  charged_to_driver numeric(14,3) default 0,
  repair_order_id uuid references tms.maintenance_orders(id),
  closed_at timestamptz,
  unique (entity_id, doc_no)
);

-- المصدر: وثيقة 27 §3
create table tms.fuel_ledger (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  card_asset_id uuid references admin.assets(id),
  vehicle_id uuid references tms.vehicles(id),
  driver_employee_id uuid references hr.employees(id),
  filled_at timestamptz not null,
  litres numeric(10,3) not null,
  amount numeric(14,3) not null,
  odometer_km numeric(12,1) not null,      -- إلزامي
  station text,
  km_since_last numeric(12,1),
  km_per_litre numeric(8,3),
  is_anomaly boolean default false,
  anomaly_reason text,
  source text not null default 'oula_import',
  external_ref text,
  unique (card_asset_id, filled_at, amount)   -- يمنع الاستيراد المزدوج
);

-- المصدر: وثيقة 27 §7 — أعمدة سجلّ المستندات (ق-4: كلها if not exists أصلاً)
alter table platform.documents add column if not exists status text not null default 'issued';
-- issued · superseded · void
alter table platform.documents add column if not exists frozen boolean not null default false;
alter table platform.documents add column if not exists legal_hold boolean not null default false;
alter table platform.documents add column if not exists signed_at timestamptz;
alter table platform.documents add column if not exists signed_by text;
alter table platform.documents add column if not exists signature_url text;
alter table platform.documents add column if not exists retain_until date;
alter table platform.documents add column if not exists checksum text;   -- SHA-256 للنسخة


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-10 · تطبيق السائق v2 — الاتصال والدفع وأسباب الفشل (35 §2 · §4 · §6)
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: وثيقة 35 §2
create table tms.contact_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tms.delivery_tasks(id),
  driver_employee_id uuid not null references hr.employees(id),
  channel text not null,            -- call · whatsapp · sms
  direction text not null default 'outbound',
  attempted_at timestamptz not null default now(),
  answered boolean,                 -- للمكالمات
  duration_sec int,                 -- المدة الفعلية من المزوّد
  template_code text,               -- للرسائل
  delivered_at timestamptz,         -- تسليم الرسالة
  read_at timestamptz,              -- ✓✓ واتساب
  provider_ref text,
  geo_lat numeric(10,7), geo_lng numeric(10,7),
  cost numeric(14,3)                -- د.ك — كل المبالغ numeric(14,3) (قرار GM 23/09/2026، B2)
);
create index on tms.contact_log (task_id, attempted_at);
create index on tms.contact_log (driver_employee_id, attempted_at desc);

-- المصدر: وثيقة 35 §4
create table tms.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tms.delivery_tasks(id),
  method text not null,              -- cash · link · pos
  amount_due numeric(14,3) not null,
  amount_paid numeric(14,3),
  link_url text, link_expires_at timestamptz,
  gateway_ref text, gateway_status text,
  confirmed_at timestamptz,
  confirmed_by text,                 -- gateway · driver_cash · supervisor
  created_at timestamptz not null default now(),
  constraint link_needs_gateway check (
    method <> 'link' or confirmed_at is null or gateway_ref is not null)
);
-- v4: فهرس — شاشة المهمة تقرأ محاولات المهمة الواحدة
create index on tms.payment_attempts (task_id, created_at);

-- المصدر: وثيقة 35 §6
create table tms.failure_reasons (
  code text primary key,
  parent_code text references tms.failure_reasons(code),
  name_ar text not null, name_en text,
  requires_photo boolean not null default false,
  requires_contact_attempts int not null default 0,
  requires_note boolean not null default false,
  is_billable boolean not null default false,   -- DL-11 حسب العقد
  counts_against_driver boolean not null default false,
  sort_order int
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-11 · EXECUTION-MASTER-v4 §1.5–§1.15 (ex DECISIONS-ADDENDUM) — جداول وأعمدة وبذور
--          §8 ADR-27 الاستقلالية المكتسبة · §9 ADR-28 ثقة السائق
--
--   ⚠️ لا DDL لهذه الجداول في أي وثيقة. كل عمود هنا مستنبط **حصراً** من نص
--      §8–§9، والنص المُسنِد مقتبس فوق كل عمود أو مجموعة. ما لا يسنده نص
--      مُعلَّم `-- v4 (استنباط تقني، يحتاج تأكيد GM)`.
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8) (ADR-27) — "Tables: imile.dtl_rule_autonomy"
-- النص: "accept/reclassify auto-closable; reject always human … rule at level 1.
--        Promotion 0→1: 14 consecutive days accuracy ≥ 0.97 on ≥ 50 cases.
--        Demotion: any day < 0.95."
create table imile.dtl_rule_autonomy (
  id uuid primary key default gen_random_uuid(),
  problem_type text not null,             -- نوع مشكلة DTL — يطابق imile.dtl_problems.problem_type
  decision_kind text not null,            -- accept · reclassify  (reject بشري دائماً — §8)
  level int not null default 0,           -- 0 = بشري · 1 = إغلاق آلي مسموح ("rule at level 1")
  -- قياس الاستحقاق — "14 consecutive days accuracy ≥ 0.97 on ≥ 50 cases"
  consecutive_days int not null default 0,
  cases_in_window int not null default 0,
  accuracy numeric(5,4),                  -- النسبة المقيسة آخر نافذة
  measured_on date,
  promoted_at timestamptz, promoted_by uuid,
  demoted_at timestamptz, demotion_reason text,   -- "any day < 0.95"
  is_active boolean not null default true,
  changed_at timestamptz not null default now(),
  unique (problem_type, decision_kind),
  constraint level_0_or_1 check (level in (0,1)),
  constraint reject_never_auto check (decision_kind in ('accept','reclassify'))
);
comment on table imile.dtl_rule_autonomy is
  'ADR-27 §8: الاستقلالية تُكتسب لكل (نوع مشكلة × نوع قرار). reject لا يُؤتمت أبداً. العتبات في platform.thresholds تحت dtl.*';

-- المصدر: EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8) — "columns dtl_problems.closed_by"
-- النص: "closed_by = 'engine' marked." + "Daily 5% random re-review."
alter table imile.dtl_problems add column if not exists closed_by text;
comment on column imile.dtl_problems.closed_by is
  'ADR-27 §8: ''engine'' للإغلاق الآلي، وإلا المدقّق البشري (auditor_id). القيمة نصية كما وردت في النص حرفياً';
-- v4 (استنباط تقني، يحتاج تأكيد GM): §8 يذكر "Daily 5% random re-review" بلا عمود
--   يحمل نتيجة المراجعة — بلا عَلَم لا سبيل لقياس دقة المحرّك ولا لتطبيق الترقية/التنزيل.
alter table imile.dtl_problems add column if not exists re_reviewed_at timestamptz;
alter table imile.dtl_problems add column if not exists re_review_agreed boolean;

-- المصدر: EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8) (ADR-27) — "Tables: imile.dispatch_autonomy"
-- النص: "auto-approve when 7-check quality gate passes … AND earned (14 plans,
--        ≥ 90% unchanged acceptance). Demotion: 2 consecutive plans > 20% edited,
--        or first-attempt rate drops > 10 pts vs 30-day mean."
create table imile.dispatch_autonomy (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'global',   -- v4 (استنباط تقني، يحتاج تأكيد GM): §8 لا يحدد
                                          -- نطاق الاستقلالية (عام أم لكل منطقة) — 'global' افتراض
  level int not null default 0,           -- 0 = اعتماد بشري · 1 = اعتماد آلي
  -- قياس الاستحقاق — "14 plans, ≥ 90% unchanged acceptance"
  plans_evaluated int not null default 0,
  unchanged_acceptance_pct numeric(5,2),
  measured_on date,
  promoted_at timestamptz, promoted_by uuid,
  -- التنزيل — "2 consecutive plans > 20% edited" · "first-attempt drops > 10 pts"
  consecutive_edited_plans int not null default 0,
  first_attempt_pct numeric(5,2),
  first_attempt_mean_30d numeric(5,2),
  demoted_at timestamptz, demotion_reason text,
  is_active boolean not null default true,
  changed_at timestamptz not null default now(),
  unique (scope),
  constraint level_0_or_1 check (level in (0,1))
);

-- المصدر: EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8) — "columns sorting_plans.approved_by/quality_gate/edits_pct"
-- ق-6: approved_by موجود في 01 بنوع uuid؛ النص يريد القيمة 'engine'.
--      يبقى uuid للمعتمِد البشري، ويُضاف approved_by_kind للتفريق.
alter table imile.sorting_plans add column if not exists approved_by_kind text not null default 'human';
-- v4 (استنباط تقني، يحتاج تأكيد GM): ق-6 — النص يريد approved_by = 'engine' نصاً،
--   وتغيير نوع العمود في 01 من uuid إلى text يكسر المخطط القائم.
alter table imile.sorting_plans add column if not exists quality_gate jsonb;
comment on column imile.sorting_plans.quality_gate is
  'ADR-27 §8: نتيجة بوابة الجودة السباعية — 100% مُسنَد أو فائض ≤ 3% بقائمة مُرحَّلة · ≥ 95% من السائقين ≤ 3 مناطق · صفر مخالفة استثناء/طاقة · التدوير · التجاور · وثائق سارية + معرّف نشط';
alter table imile.sorting_plans add column if not exists edits_pct numeric(5,2);
comment on column imile.sorting_plans.edits_pct is
  'ADR-27 §8: نسبة تعديل الخطة — أساس التنزيل عند تجاوز 20% في خطتين متتاليتين';
do $$ begin
  alter table imile.sorting_plans
    add constraint approved_by_kind_valid check (approved_by_kind in ('human','engine'));
exception when duplicate_object then null; end $$;

-- المصدر: EXECUTION-MASTER-v4 §1.13 (ex DECISIONS-ADDENDUM §9) (ADR-28) — "Table imile.driver_trust (history 24 months)"
-- النص: "trust = 1 − (0.35·p1 + 0.25·p2 + 0.20·p3 + 0.10·p4 + 0.10·p5) clamped [0,1];
--        trailing 90 days; nightly 01:40. p1 DTL rejection rate (den ≥10) ·
--        p2 attributed-failure rate (≥10) · p3 no-answer claims with < 2 contacts (≥5) ·
--        p4 deliveries > 300 m (≥20) · p5 COD-variance days (≥10).
--        Hard rules: open fraud-type case → 0; cold start < 30 deliveries → 0.70.
--        Weights sum to 1.00 (checked on save)."
create table imile.driver_trust (
  id uuid primary key default gen_random_uuid(),
  driver_code text not null,              -- يطابق imile.dtl_problems.driver_code (نص في 01)
  computed_at timestamptz not null default now(),   -- "nightly 01:40"
  window_days int not null default 90,    -- "trailing 90 days"
  -- المكوّنات الخمسة
  p1 numeric(6,4), p1_denominator int,    -- DTL rejection rate — den ≥ 10
  p2 numeric(6,4), p2_denominator int,    -- attributed-failure rate — ≥ 10
  p3 numeric(6,4), p3_denominator int,    -- no-answer claims with < 2 contacts — ≥ 5
  p4 numeric(6,4), p4_denominator int,    -- deliveries > 300 m — ≥ 20
  p5 numeric(6,4), p5_denominator int,    -- COD-variance days — ≥ 10
  -- الأوزان — تُحفظ مع الصف ليبقى الحساب قابلاً للتفسير بعد أي تغيير
  weights jsonb not null
    default '{"p1":0.35,"p2":0.25,"p3":0.20,"p4":0.10,"p5":0.10}'::jsonb,
  driver_trust numeric(4,3) not null,     -- clamped [0,1]
  deliveries_count int,                   -- "cold start < 30 deliveries → 0.70"
  is_cold_start boolean not null default false,
  hard_rule_applied text,                 -- open_fraud_case · cold_start · null
  constraint trust_clamped check (driver_trust >= 0 and driver_trust <= 1),
  -- "Weights sum to 1.00 (checked on save)"
  constraint weights_sum_one check (
    round(((weights->>'p1')::numeric + (weights->>'p2')::numeric
         + (weights->>'p3')::numeric + (weights->>'p4')::numeric
         + (weights->>'p5')::numeric), 4) = 1.0000
  ),
  unique (driver_code, computed_at)
);
create index on imile.driver_trust (driver_code, computed_at desc);
comment on table imile.driver_trust is
  'ADR-28 §9. الاحتفاظ 24 شهراً (تاريخ). لا يُعرض للسائق كقيمة مركّبة أبداً، ولا يُربط بأجر ولا بجزاء — EXECUTION-MASTER-v4 §1.13 (ex DECISIONS-ADDENDUM §9) و§11';

-- ───────────────────────────────────────────────────────────────────────────
-- بذور العتبات — ق-7: §8 يقول "14 thresholds"، والاستخراج الحرفي يعطي 16.
--   كل قيمة أدناه واردة **نصاً** في EXECUTION-MASTER-v4 §1.12 (ex DECISIONS-ADDENDUM §8). لم تُخترع قيمة.
--   الفارق (16 مقابل 14) مرفوع للمدير العام.
-- ───────────────────────────────────────────────────────────────────────────
insert into platform.thresholds (key, value, unit, description_ar, changed_by, changed_at) values
 ('dtl.auto_close.min_confidence',        0.900,  'ratio',   'ADR-27: الإغلاق الآلي يشترط ثقة المحرّك ≥ 0.90',                               '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.auto_close.max_cod_kwd',          20.000,  'KWD',     'ADR-27: الإغلاق الآلي يشترط قيمة تحصيل ≤ 20.000 د.ك',                          '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.auto_close.min_driver_trust',      0.800,  'ratio',   'ADR-27: الإغلاق الآلي يشترط ثقة السائق ≥ 0.80',                                '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.promotion.consecutive_days',      14.000,  'days',    'ADR-27: الترقية 0→1 تتطلب 14 يوماً متتالياً',                                  '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.promotion.min_accuracy',           0.970,  'ratio',   'ADR-27: الترقية تتطلب دقة ≥ 0.97',                                             '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.promotion.min_cases',             50.000,  'count',   'ADR-27: الترقية تتطلب ≥ 50 حالة في النافذة',                                   '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.demotion.accuracy_floor',          0.950,  'ratio',   'ADR-27: أي يوم دقته < 0.95 ⇒ تنزيل فوري',                                      '00000000-0000-0000-0000-000000000000', now()),
 ('dtl.review.random_sample_pct',         5.000,  'pct',     'ADR-27: إعادة مراجعة عشوائية يومية لـ 5% من الإغلاقات الآلية',                  '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.gate.max_overflow_pct',       3.000,  'pct',     'ADR-27: بوابة الجودة — فائض غير مُسنَد ≤ 3% مع قائمة مُرحَّلة',                 '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.gate.min_drivers_zone_cap_pct',95.000,'pct',     'ADR-27: بوابة الجودة — ≥ 95% من السائقين ضمن حد المناطق',                      '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.gate.max_zones_per_driver',   3.000,  'count',   'ADR-27: بوابة الجودة — ≤ 3 مناطق للسائق',                                      '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.promotion.min_plans',        14.000,  'count',   'ADR-27: الاستقلالية تُكتسب بعد 14 خطة',                                        '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.promotion.min_unchanged_pct',90.000,  'pct',     'ADR-27: الترقية تتطلب قبولاً بلا تعديل ≥ 90%',                                 '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.demotion.consecutive_plans',  2.000,  'count',   'ADR-27: خطتان متتاليتان تجاوزتا حد التعديل ⇒ تنزيل',                            '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.demotion.max_edits_pct',     20.000,  'pct',     'ADR-27: حد التعديل على الخطة 20%',                                             '00000000-0000-0000-0000-000000000000', now()),
 ('dispatch.demotion.first_attempt_drop_pts',10.000,'points','ADR-27: هبوط معدّل النجاح من أول محاولة > 10 نقاط عن متوسط 30 يوماً ⇒ تنزيل',   '00000000-0000-0000-0000-000000000000', now())
on conflict (key) do nothing;
-- ملاحظة: changed_by صفري لأن العمود not null ولا مستخدم مؤسِّس في 01.
--         يُستبدل بمعرّف المدير العام عند أول تحرير من الواجهة.

-- ───────────────────────────────────────────────────────────────────────────
-- كيان PGH · دور DEPUTY_SYSADMIN · حارس فاتورة القابضة — تحقّق لا تكرار
-- ───────────────────────────────────────────────────────────────────────────
-- تُحُقِّق: EXECUTION-MASTER-v4 §1.5 (ex DECISIONS-ADDENDUM §1) (كيان PGH بـ entity_kind='holding' و parent_id
--   للأبناء الأربعة) مُطبَّق أصلاً في 01 §13 — لا يُكرَّر هنا.
-- تُحُقِّق: billing.reject_holding_invoice() والمشغّل عليه مُطبَّقان أصلاً في 01 §13.
-- تُحُقِّق: دور DEPUTY_SYSADMIN (EXECUTION-MASTER-v4 §1.7 (ex DECISIONS-ADDENDUM §3)) مبذور في 13B-5 أعلاه.
-- المتبقي مهمةً للـ WBS: صلاحيات الأدوار الأربعة في §3 (HOUSING_SUP · CLIENT_ADMIN ·
--   CLIENT_CREATOR · CLIENT_VIEWER · CLIENT_FINANCE) تحتاج بذر identity.permissions
--   و identity.role_permissions — وهي مصفوفة صلاحيات كاملة لا DDL.


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-12 · أمن مستوى الصف للجداول الجديدة (ق-9 · نمط 01 §11)
-- ═══════════════════════════════════════════════════════════════════════════

-- نمط 1: الجداول التشغيلية الحاملة entity_id — حصر بالكيان المسموح للمستخدم
alter table housing.properties           enable row level security;
alter table housing.maintenance_requests enable row level security;
alter table housing.inspections          enable row level security;
alter table housing.utility_bills        enable row level security;
alter table hr.disciplinary_cases        enable row level security;
alter table wms.space_blocks             enable row level security;
alter table wms.space_allocations        enable row level security;
alter table wms.space_reservations       enable row level security;
alter table tms.maintenance_orders       enable row level security;
alter table tms.accidents                enable row level security;
alter table tms.fuel_ledger              enable row level security;
alter table platform.decisions           enable row level security;

create policy entity_scope on housing.properties
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on housing.maintenance_requests
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on housing.inspections
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on housing.utility_bills
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on hr.disciplinary_cases
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on wms.space_blocks
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on wms.space_allocations
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on wms.space_reservations
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on tms.maintenance_orders
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on tms.accidents
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on tms.fuel_ledger
  for all using (entity_id = any(platform.allowed_entities()));
-- v4: platform.decisions.entity_id قابل للعدم (قرار على مستوى المجموعة) — يُسمح بالصف العام
create policy entity_scope on platform.decisions
  for all using (entity_id is null or entity_id = any(platform.allowed_entities()));

-- نمط 2: نافذة العميل — الجدول الوحيد الجديد الذي يراه العميل مباشرةً هو
--         تخصيص المساحة (مساحته هو، بعقده هو). ولا سياسة عميل على housing.*
--         ولا partners.* ولا hr.* — العميل لا يصلها إطلاقاً (ق-9).
create policy client_portal_scope on wms.space_allocations
  for select using (
    platform.is_internal() or client_id = platform.current_client_id()
  );

-- ملاحظة G7 (40 Part F "Operational tables without RLS = 0"):
--   الجداول المرجعية/الإعدادية بلا entity_id (thresholds · feature_flags ·
--   automation_rules · alert_rules · alert_log · integration_config ·
--   integration_queue · outbox · domain_owners · approval_chains · sod_rules ·
--   delegations · penalty_schedule · failure_reasons · maintenance_plans ·
--   housing.units/rooms/beds/bed_assignments/bed_reservations/assets ·
--   space_blocks_out_of_service · contact_log · payment_attempts ·
--   dtl_rule_autonomy · dispatch_autonomy · driver_trust) لم تُفعَّل عليها RLS.
--   تعميم RLS على بقية الجداول التشغيلية في 01 و13 و13B مهمة WBS واحدة،
--   كما نصّت ملاحظة 01 رقم 3: "سياسات RLS أعلاه نماذج للنمط. تُعمَّم على كل
--   جدول تشغيلي قبل الإطلاق".

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد التطبيق
-- ═══════════════════════════════════════════════════════════════════════════
--   select count(*) from information_schema.tables
--    where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema');
--   select * from platform.verify_audit_chain();     -- صفر صفوف (G8)
--   select count(*) from identity.sod_rules;          -- 4
--   select count(*) from platform.thresholds;         -- 16 (ق-7)
--   select count(*) from identity.roles;              -- 26
--   -- ثم يُطبَّق 019-Warehouse-WH1-Setup.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ما بقي مهمةً للـ WBS (ليس نقصاً في هذا الملف)
-- ═══════════════════════════════════════════════════════════════════════════
--   1. identity.column_classification: تغطية كل عمود في 01 و13 و13B (حارس G6) — ق-8.
--   2. تعميم RLS على كل جدول تشغيلي (حارس G7) — ق-9.
--   3. بذر مصفوفة الصلاحيات identity.permissions/role_permissions
--      وصلاحيات الأدوار الأربعة في EXECUTION-MASTER-v4 §1.7 (ex DECISIONS-ADDENDUM §3).
--   4. بذر platform.domain_owners للمجالات D01–D12 من وثيقة 22 §2.
--   5. بذر بنود hr.penalty_schedule من وثيقة 15 §2..§5.
--   6. بذر 18 قاعدة تنبيه (platform.alert_rules) من وثيقة 25 §2،
--      وسجل التكاملات (platform.integration_config) من وثيقة 23 §1.
--   7. مهمة مجدولة تنشئ قسم audit_log الشهري المقبل قبل بدايته — ومعه (v4.3 · ADR-0002):
--      create unique index <القسم>_chain_seq_key on platform.<القسم> (chain_seq)؛
--      enable + force row level security وسياسة entity_scope كالأقسام القائمة (G7)؛
--      صفوف identity.column_classification لكل أعمدة القسم (G6). غياب الفهرس يُسقط G8.
-- ═══════════════════════════════════════════════════════════════════════════

-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  المرحلة الثانية من توحيد المخطط (SCH-2) — 21/09/2026                   ║
-- ║  المصادر: RESOLUTIONS-v4 · CHANGELOG-GOV-B §4 (SCR-1…SCR-7) ·           ║
-- ║           STATE-REGISTER.md · OPS/ADM/PLT-SCHEMA-NEEDS ·                 ║
-- ║           RECRUITMENT-STAGES.md · النسخ v4 من 04 · 10 · 11 · 14 · 15 ·   ║
-- ║           17 · 19 · 22 · 25 · 35 · 40 Part F/I                           ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- سجل قرارات SCH-2 (يُقرأ مع ق-1…ق-9 في ترويسة المرحلة الأولى أعلاه)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-10 · platform.outbox.entity_id — SCR-1 يطلبه `not null`. لكن أحداث المنصة
--        العابرة للكيانات (تغيير صلاحية · قاعدة SoD · عَلَم ميزة · قرار على
--        مستوى المجموعة) لا كيان لها، و40 §A2 يقصر القاعدة على الصف
--        «التجاري/التشغيلي». القرار: العمود **nullable** مع قيد يمنع الصف
--        التجاري من إغفاله عبر قائمة مخططات مغلقة، وسياسة RLS تسمح بالصف
--        المنصّي للداخلي فقط. مسجَّل في «يحتاج تحكيم».
--
-- ق-11 · قيود الحالات (STATE-REGISTER): تُكتب بصيغة
--        `alter table … add constraint chk_<table>_<col> check (<col> = any (array[…]))`
--        على كل عمود حالة في القسمين 1 و3 من السجل. القيم المعلَّمة
--        «v4 (استنباط)» في السجل تُكتب كما هي وتبقى في «يحتاج تحكيم».
--        القيم التي تستعملها بذرة 019 أو دالة قائمة وغير مذكورة في السجل
--        تُضاف وتُسجَّل (انظر ق-12).
--
-- ق-12 · حالات أضيفت إلى قيود السجل لأن كائناً قائماً يستعملها:
--        · `hr.disciplinary_cases.status`: **`pending_authority`** و**`signed`** —
--          يفرضهما مشغّل السلطة الهرمية (ADM §4-2 بندا 4 و6).
--        · `wms.space_blocks.status`: السجل يقول `active, inactive`؛ و019 يبذر
--          `'active'` فقط — متوافق.
--        · `platform.decisions.status`: السجل يقول `open, decided, expired,
--          cancelled` بينما تعليق 29 §8 في المرحلة الأولى يقول `auto_resolved`
--          بدل `cancelled`. **السجل يحكم** (R-06) — والقيمتان مجموعتان معاً
--          لئلا يُكسر صفّ مكتوب بالتعليق الأول.
--
-- ق-13 · RLS شامل (G7 في 40 Part F v4 = **كل جدول أساسي** في المخططات الأربعة
--        عشر، لا الحاملة entity_id وحدها). ثلاثة أنماط:
--        ① `entity_scope` لكل جدول يحمل entity_id (مع السماح بـnull حيث العمود
--           قابل للعدم — صفّ على مستوى المجموعة).
--        ② `internal_only` بـ`platform.is_internal()` للجداول التشغيلية بلا
--           entity_id وللمخطط identity وسجلات النظام.
--        ③ `reference_read` للجداول المرجعية العامة: قراءة للداخلي، وكتابة
--           بصلاحية (`platform.has_perm`) — كي لا تُقفل بيانات الكتالوج والعتبات.
--        أقسام audit_log تُفعَّل عليها RLS صراحةً — الوراثة لا تنقل
--        `relrowsecurity` إلى القسم، وG7 يقرأ pg_class لكل جدول أساسي.
--        `force row level security` يُطبَّق على الجداول التي يفرض 40 §B2/§C6
--        عدم تجاوزها من المالك: audit_log وأقسامه · outbox · الفواتير والقيود.
--
-- ق-14 · لائحة الجزاءات: **77 بنداً** — الرقم في R-05 و15 §1 صحيح.
--        (SCH-3) كان استخراج SCH-2 يعطي 73 لأنه يبحث عن `CUS` بينما رمز فئة
--        العهد والأصول في 15 §2-ح هو **`CST`** (CST-01…CST-04). صُحِّح الاستخراج
--        فعادت الفئات التسع كاملة: attendance 10 · work 11 · vehicle 11 ·
--        client 10 · safety 8 · conduct 10 · housing 9 · custody 4 · system 4 = 77.
--        `min_degree > 1` في **15 بنداً** (ADM-19 يقول 16) — الفارق مسجَّل في «يحتاج تحكيم».
--
-- ق-15 · مراحل الاستقدام: يُنشأ `hr.recruitment_stages` مرجعياً ويُبذر بالسبعة
--        عشر من RECRUITMENT-STAGES.md، ويُربط `hr.recruitment_cases.stage` به
--        بمفتاح أجنبي (المفضَّل في RECRUITMENT-STAGES §1) **وقيد check** معاً
--        كما يطلب البريف. و`default` يُصحَّح من `work_permit` إلى
--        `manpower_request` (المرحلة الأولى نصاً في 10 §4؛ `work_permit` هي
--        seq = 3 — انظر RECRUITMENT-STAGES §5 و«يحتاج تحكيم»).
--
-- ق-16 · صيغة كود المواقع الإنشائية: OPS §2-8 و19 §2-0 يقولان `X-<blk><bay2d>-<tier>`
--        (`X-B101-1`)، بينما PLT §د يقول إن الأداة ثلاثية الأبعاد تعرض
--        `X-B1-01-1`. **19 §2-0 يحكم** (R-06: الحاكم للترميز هو 19) — والأداة
--        تُطابَق. مسجَّل في «يحتاج تحكيم» لتنبيه وكيل الأدوات.
--
-- ق-17 · `platform.counters`: حُذفت بذرة `('RCP','RCP')` **من 01 نفسه** (السطر
--        ~1580) بتعليق v4، لأن الحذف من 13B وحده يترك 01 يبذرها عند كل بناء
--        نظيف. السلاسل الحاكمة: `RCT` (بادئة `RC`) · `GOV` · `INV`.
--
-- ق-18 · `wms.generate_locations`: 19 §4 بند 5 هو النص الحاكم، ويُنسخ بتوقيعه
--        وحارسيه كما هو. أُضيف إليه ملء `area_m2` و`volume_m3` و`capacity_pallets`
--        و`barcode` — مشتقة من الكتلة نفسها (`capacity_sqm / capacity_pallets`)
--        لا مخترعة — وإلا استحال أن تعيد `wms.verify_wh1()` مجاميع 19 §3-4.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- قائمة SCR المنفَّذة (CHANGELOG-GOV-B §4)
-- ═══════════════════════════════════════════════════════════════════════════
--   SCR-1  platform.outbox.entity_id + entity_scope ................ 13B-13
--   SCR-2  tms.proof_of_delivery: sha256 · legal_hold · retain_until  13B-14
--   SCR-3  imile.coverage_areas + driver_zone_exclusions ........... 13B-15
--   SCR-4  hr.penalty_schedule.is_fraud (+ min_degree + البذرة) .... 13B-16
--   SCR-5  hr.disciplinary_cases.signed_by/routed_to + المشغّل +
--          قيدا م.35 و م.37 ....................................... 13B-16
--   SCR-6  قيد check على hr.recruitment_cases.stage + due_at ....... 13B-17
--   SCR-7  sales.possible_duplicates · platform.mdm_scorecard ...... 13B-19
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-13 · المنصة — outbox · التكاملات · جودة المجالات · الإشعارات
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 SCR-1 · المصدر: 40 §A2 + §B3 · R-02 · PLT N-1 · ق-10
alter table platform.outbox add column if not exists entity_id uuid references platform.entities(id);
create index if not exists outbox_entity_created_idx on platform.outbox (entity_id, created_at desc);
comment on column platform.outbox.entity_id is
  'محور المحاسبة متعدد الكيانات (40 §A2). null = حدث منصّي عابر للكيانات (صلاحية · SoD · عَلَم ميزة) — يراه الداخلي فقط. ق-10';

-- v4 (ق-10): الحدث التجاري/التشغيلي لا يمرّ بلا كيان؛ الحدث المنصّي يمرّ.
do $$ begin
  alter table platform.outbox add constraint outbox_business_needs_entity
    check (entity_id is not null
           or split_part(aggregate_type, '.', 1) in ('platform','identity'));
exception when duplicate_object then null; end $$;

-- v4 PLT N-4 · المصدر: 23 §2-2 — القاموس المشترك I-01…I-11
alter table platform.integration_runs  add column if not exists integration_code text;
alter table platform.integration_queue add column if not exists integration_code text;
do $$ begin
  alter table platform.integration_runs add constraint integration_runs_code_fkey
    foreign key (integration_code) references platform.integration_config(code);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table platform.integration_queue add constraint integration_queue_code_fkey
    foreign key (integration_code) references platform.integration_config(code);
exception when duplicate_object then null; end $$;
create index if not exists integration_runs_code_idx
  on platform.integration_runs (integration_code, started_at desc);
create index if not exists integration_queue_code_idx
  on platform.integration_queue (integration_code, created_at desc);

-- v4 PLT N-5 · المصدر: 23 §1 · §2 الحقل 5 — الملكية بالمنصب + الاسم القديم
alter table platform.integration_config add column if not exists owner_role text references identity.roles(code);
alter table platform.integration_config add column if not exists legacy_name text;
comment on column platform.integration_config.legacy_name is
  'القيمة النصية الحرّة في platform.integration_runs.integration قبل v4: imile_agent · oula · biometric · whatsapp';

-- v4 PLT N-6 · المصدر: 25 §2-1 (التنبيه N-18) · PLT-14 — مصدر نسبة جودة المجال
create table if not exists platform.domain_quality_monthly (
  domain_code text not null references platform.domain_owners(domain_code),
  month       date not null,
  score_pct   numeric(5,2) not null,
  measured_at timestamptz not null default now(),
  primary key (domain_code, month)
);
comment on table platform.domain_quality_monthly is
  'بطاقة جودة البيانات الشهرية لكل مجال D01–D12 — مصدر التنبيه N-18 وتقرير R-20 (25 §2-1)';

-- v4 PLT N-8 · المصدر: 25 §2-1 (التنبيه N-20) — دقة الارتداد على مستوى الرسالة
alter table platform.notifications add column if not exists delivery_status text;
do $$ begin
  alter table platform.notifications add constraint chk_notifications_delivery_status
    check (delivery_status is null or delivery_status = any (array['sent','delivered','bounced','failed']));
exception when duplicate_object then null; end $$;

-- v4 OPS §6 · المصدر: 35 §8-3 · §12-1 — NULL متمايزة في PostgreSQL 16 فلا يكبح
--   `on conflict do nothing` تكرار الإعداد العام. الفهرس الجزئي يجعله ممكناً.
create unique index if not exists settings_global_key_uq
  on platform.settings (key) where entity_id is null;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-14 · التوصيل — إثبات التسليم والحفظ القانوني (SCR-2 · R-07 · 31 §8-1)
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 SCR-2 · المصدر: 40 §C4 «SHA-256 stored» · 31 §8-1 · PLT N-2 · ADM §11
alter table tms.proof_of_delivery add column if not exists sha256           text;
alter table tms.proof_of_delivery add column if not exists photo_sha256     text;
alter table tms.proof_of_delivery add column if not exists signature_sha256 text;
alter table tms.proof_of_delivery add column if not exists legal_hold  boolean not null default false;
alter table tms.proof_of_delivery add column if not exists hold_reason text;
alter table tms.proof_of_delivery add column if not exists retain_until date;
create index if not exists pod_legal_hold_idx on tms.proof_of_delivery (legal_hold) where legal_hold;
comment on column tms.proof_of_delivery.retain_until is
  'سجلّ POD (الحقول والإحداثيات والتوقيع) 5 سنوات · ملف الصورة 60 يوماً (R-07). الحذف لا يُفعَّل قبل المرحلة 6';

-- v4 PLT N-3 · المصدر: 31 §8-1 — الحجز القانوني تلقائي لا إجراء بشري
create or replace function tms.raise_legal_hold()
returns trigger language plpgsql as $$
declare v_task uuid; v_reason text;
begin
  if tg_table_name = 'delivery_exceptions' then
    v_task := new.task_id;
    v_reason := 'استثناء توصيل — ' || coalesce(new.exception_type, '—');
  else
    if new.related_table is distinct from 'tms.delivery_tasks' then return new; end if;
    v_task := new.related_id;
    v_reason := 'تذكرة عميل — ' || coalesce(new.doc_no, new.id::text);
  end if;
  if v_task is null then return new; end if;

  update tms.proof_of_delivery p
     set legal_hold = true,
         hold_reason = coalesce(p.hold_reason, v_reason)
   where p.task_id = v_task and not p.legal_hold;
  return new;
end $$;
comment on function tms.raise_legal_hold is
  '31 §8-1: أي نزاع أو شكوى أو جزاء مرتبط بمهمة يرفع legal_hold على إثبات تسليمها تلقائياً';

drop trigger if exists trg_pod_hold_exception on tms.delivery_exceptions;
create trigger trg_pod_hold_exception after insert on tms.delivery_exceptions
  for each row execute function tms.raise_legal_hold();

drop trigger if exists trg_pod_hold_ticket on cc.tickets;
create trigger trg_pod_hold_ticket after insert on cc.tickets
  for each row execute function tms.raise_legal_hold();

-- v4 ADM §11 · المصدر: 27 §2 — سقف التحمّل مفروض لا موصوف
do $$ begin
  alter table tms.accidents add constraint charge_within_deductible
    check (charged_to_driver <= coalesce(deductible, 0));
exception when duplicate_object then null; end $$;

-- v4 OPS §8 · المصدر: EXEC §1.1 · 40 §C4 INV-C4-8 · 03 §5-3
alter table sales.contracts add column if not exists bills_reschedule        boolean not null default false;  -- DL-14
alter table sales.contracts add column if not exists bills_partial_delivery  boolean not null default false;  -- DL-18


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-15 · iMile — مناطق التغطية واستثناءات السائقين (SCR-3 · OPS §1 · 07 §3-3)
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 SCR-3 · المصدر: 07 §3-3 · §4-1 · §4-2 (الاسم Coverage_Areas صُحِّح إلى snake_case)
create table imile.coverage_areas (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- مفتاح المطابقة من عنوان الشحنة (07 §3-3)
  name_ar text not null,                     -- الاسم الميداني: صباح السالم · صباح الأحمد …
  governorate text,                          -- المحافظة — للتقارير
  adjacent_codes text[] not null default '{}',  -- التجاور: «مناطق متجاورة فقط» (07 §4-2 ③)
  is_rotation boolean not null default false,   -- «مناطق محددة بالتدوير لعدالة الأحمال» (07 §3-3)
  last_rotated_driver_code text,                -- «وآخر من غطّاها» (07 §4-1)
  last_rotated_on date,
  daily_capacity_hint int,                      -- مدخل ترتيب المناطق بالحجم تنازلياً (07 §4-2 ②)
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on imile.coverage_areas using gin (adjacent_codes);
comment on table imile.coverage_areas is
  'بلا بذرة عمداً: قائمة المناطق بيانات تشغيلية يُدخلها مشرف التوصيل (07 §10 بند 6) — لا تُخترع أسماء مناطق';

-- v4 SCR-3 · المصدر: 07 §4-1 «شكوى سابقة · عدم إلمام»
create table imile.driver_zone_exclusions (
  id uuid primary key default gen_random_uuid(),
  driver_code text not null,                 -- يطابق imile.shipments.driver_code (نص في 01)
  zone_code text not null references imile.coverage_areas(code),
  reason text not null,
  valid_from date not null default current_date,
  valid_to date,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index on imile.driver_zone_exclusions (driver_code, zone_code);


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-16 · الموارد البشرية — لائحة الجزاءات والسلطة الهرمية (SCR-4 · SCR-5)
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 SCR-4 · المصدر: 15 §6 (v4) · EXECUTION-MASTER-v4 §1.13 ADR-28 · ADM §3
alter table hr.penalty_schedule add column if not exists is_fraud   boolean not null default false;
alter table hr.penalty_schedule add column if not exists min_degree int not null default 1;
comment on column hr.penalty_schedule.is_fraud is
  'ADR-28: قضية احتيال مفتوحة ⇒ driver_trust = 0. يقرؤها محرّك الثقة من هنا لا من أكواد مكتوبة في الكود (40 §A5)';
comment on column hr.penalty_schedule.min_degree is
  'أدنى درجة تُطبَّق على أول واقعة — للبنود التي خانة D1 فيها «—» (ADM-19)';

-- v4 · المصدر: 15 §6 (v4) — تسع فئات مغلقة
do $$ begin
  alter table hr.penalty_schedule add constraint valid_category
    check (category in ('attendance','work','vehicle','client',
                        'safety','conduct','housing','custody','system'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hr.penalty_schedule add constraint chk_penalty_min_degree
    check (min_degree between 1 and 4);
exception when duplicate_object then null; end $$;

-- v4 SCR-5 · المصدر: ADM §4-1 — الموقّع وإعادة التوجيه
-- ملاحظة: `signed_by` يبقى nullable خلافاً لـADM §4-1 («not null») لأن الحالة
--   `draft` تسبق التوقيع نصّاً (15 §3 · STATE-REGISTER) — قيد not null يمنع
--   إنشاء المسودة أصلاً. المشغّل يفرض السلطة عند ورود الموقّع. ق-12
alter table hr.disciplinary_cases add column if not exists signed_by         uuid references hr.employees(id);
alter table hr.disciplinary_cases add column if not exists signer_role       text references identity.roles(code);
alter table hr.disciplinary_cases add column if not exists routed_to         uuid references hr.employees(id);
alter table hr.disciplinary_cases add column if not exists routed_reason     text;
alter table hr.disciplinary_cases add column if not exists art35_override_by uuid references identity.users(id);

-- v4 · المصدر: 15 §6 (v4) — القيد القديم يقيس المسافة الخطأ
alter table hr.disciplinary_cases drop constraint if exists art35_15_days;
alter table hr.disciplinary_cases drop constraint if exists art37_due_process;

-- (أ) قيد منطقي مساند: لا يسبق الثبوتُ الواقعةَ — المصدر: 15 §6 (v4)
alter table hr.disciplinary_cases
  add constraint art35_incident_before_proof
  check (proven_date >= incident_date);

-- (ب) م.35 — توقيع الجزاء خلال 15 يوماً من ثبوت المخالفة — المصدر: 15 §6 (v4)
alter table hr.disciplinary_cases
  add constraint art35_15_days
  check (
    signed_at is null                 -- لم يُوقَّع بعد
    or art35_override_by is not null  -- تجاوز GM مسجَّل
    or signed_at <= proven_date + 15
  );

-- (ج) م.37 — خمسة إجراءات إلزامية لا أربعة — المصدر: 15 §6 (v4)
alter table hr.disciplinary_cases
  add constraint art37_due_process
  check (
    penalty_type <> 'deduction'
    or (
      notified_at              is not null   -- إبلاغ كتابي
      and statement_heard                    -- سماع الأقوال
      and defence_investigated               -- تحقيق الدفاع
      and investigation_minutes_url is not null  -- محضر التحقيق بالملف
      and decision_notified_at is not null   -- إبلاغ كتابي بالجزاء
    )
  );

-- v4 SCR-5 · المصدر: ADM §4-2 بند 6 — سقف الدرجة بحسب المنصب
create or replace function hr.max_degree_for_role(p_role text)
returns int language sql immutable as $$
  select case
    when p_role = 'GM' then 4
    when p_role in ('WH_MGR','DEL_MGR','SALES_MGR','FLEET_MGR','HOUSING_SUP','CFO','OPS_DIR','HR_MGR','CC_MGR') then 3
    when p_role in ('WH_SUP','DEL_SUP') then 2
    else 0
  end
$$;
comment on function hr.max_degree_for_role is
  'EXECUTION-MASTER-v4 §1.6 · 15 §3: مشرف D1–D2 · مدير D1–D3 · GM D1–D4. الفصل GM حصراً';

-- v4 SCR-5 · المصدر: ADM §4-2 — إعادة توجيه لأعلى لا رفض صامت
create or replace function hr.check_penalty_authority()
returns trigger language plpgsql as $$
declare
  v_cap int;
  v_target uuid;
begin
  if new.signed_by is null or new.signer_role is null then
    return new;                                   -- مسودة قبل التوقيع — لا فحص
  end if;

  v_cap := hr.max_degree_for_role(new.signer_role);

  -- بند 3: الفصل (أو الدرجة الرابعة) للمدير العام حصراً
  if (new.penalty_type = 'dismissal' or new.applied_degree = 4)
     and new.signer_role <> 'GM' then
    v_cap := least(v_cap, 3);
  end if;

  if new.applied_degree > v_cap then
    -- بند 4: لا يُرفض الصفّ — يُحال آلياً لأقرب مخوَّل في سلسلة reports_to الصاعدة
    with recursive chain as (
      select e.id, e.reports_to, 1 as depth
      from hr.employees e where e.id = new.signed_by
      union all
      select e.id, e.reports_to, c.depth + 1
      from hr.employees e join chain c on e.id = c.reports_to
      where c.depth < 10
    )
    select c.id into v_target
    from chain c
    join hr.employees em on em.id = c.id
    join identity.users u on u.employee_id = em.id
    join identity.user_roles ur on ur.user_id = u.id and ur.revoked_at is null
    join identity.roles r on r.id = ur.role_id
    where hr.max_degree_for_role(r.code) >= new.applied_degree
      and c.depth > 1
    order by c.depth
    limit 1;

    new.routed_to := v_target;
    new.routed_reason := format(
      'الدرجة %s تتجاوز سقف الدور %s (%s). أُحيلت آلياً للمستوى المخوَّل — 15 §3',
      new.applied_degree, new.signer_role, v_cap);
    new.status := 'pending_authority';
  elsif new.status = 'draft' then
    new.status := 'signed';
  end if;

  -- بند 5: التظلّم يبتّه مستوى أعلى من الموقّع
  if new.grievance_decided_by is not null and new.grievance_decided_by = new.signed_by then
    raise exception 'التظلّم يبتّه مستوى أعلى من الموقّع (15 §3)';
  end if;

  return new;
end $$;

drop trigger if exists trg_penalty_authority on hr.disciplinary_cases;
create trigger trg_penalty_authority
  before insert or update of applied_degree, signed_by, signer_role, penalty_type
  on hr.disciplinary_cases
  for each row execute function hr.check_penalty_authority();

-- v4 · المصدر: 15 §6 (v4) — الدالة تحترم min_degree
create or replace function hr.next_penalty_degree(p_employee uuid, p_code text)
returns int language sql stable as $$
  select least(
           4,
           greatest(
             (select min_degree from hr.penalty_schedule where code = p_code),
             1 + count(*)::int
           )
         )
  from hr.disciplinary_cases
  where employee_id  = p_employee
    and penalty_code = p_code
    and incident_date >= current_date - interval '12 months'
    and status in ('issued','upheld','applied','carried_forward')
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-17 · الاستقدام — المراحل السبع عشرة (SCR-6 · RECRUITMENT-STAGES · ق-15)
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 SCR-6 · المصدر: RECRUITMENT-STAGES.md §1 (المستنبَط من 10 §4 · §4-1)
create table hr.recruitment_stages (
  code               text primary key,
  seq                int  not null unique,
  name_ar            text not null,
  default_owner_role text not null references identity.roles(code),
  default_sla_days   int  not null default 7,
  is_active          boolean not null default true
);

-- v4 SCR-6 · المصدر: RECRUITMENT-STAGES.md §2 — السبعة عشر بترتيبها
insert into hr.recruitment_stages (seq, code, name_ar, default_owner_role, default_sla_days) values
 ( 1,'manpower_request',    'طلب قوى عاملة',                              'GM',   7),
 ( 2,'sourcing_route',      'تحديد مسار الاستقدام',                        'PRO',  7),
 ( 3,'work_permit',         'الحصول على إذن العمل من الجهة المختصة',        'PRO',  7),
 ( 4,'visa_issue',          'إصدار التأشيرة',                              'PRO',  7),
 ( 5,'agency_contract',     'التعاقد مع مكتب الاستقدام (بلد المصدر)',       'PRO',  7),
 ( 6,'candidate_shortlist', 'ترشيح المرشحين وفحص المستندات',                'GM',   7),
 ( 7,'medical_origin',      'الفحص الطبي في بلد المصدر',                    'PRO',  7),
 ( 8,'visa_stamp_ticket',   'ختم التأشيرة وحجز التذكرة',                    'PRO',  7),
 ( 9,'arrival',             'الوصول والاستقبال',                            'GM',   7),
 (10,'medical_local',       'الفحص الطبي المحلي',                           'PRO',  7),
 (11,'biometrics_security', 'البصمة والإجراءات الأمنية',                     'PRO',  7),
 (12,'residency_issue',     'إصدار الإقامة',                                'PRO',  7),
 (13,'civil_id',            'البطاقة المدنية',                              'PRO',  7),
 (14,'driving_licence',     'تحويل أو إصدار رخصة القيادة (للسائقين)',        'PRO',  7),
 (15,'onboarding_setup',    'التهيئة: سكن وزي وشريحة وحساب بنكي وتدريب',    'GM',   7),
 (16,'probation_start',     'المباشرة الرسمية وبدء فترة التجربة',            'GM',   7),
 (17,'probation_review',    'تقييم نهاية فترة التجربة: تثبيت أو إنهاء',      'GM',   7)
on conflict (code) do nothing;

-- v4 SCR-6 · ق-15: الافتراضي كان 'work_permit' وهي seq = 3 — يُصحَّح إلى الأولى نصاً.
alter table hr.recruitment_cases alter column stage set default 'manpower_request';

-- v4 SCR-6 · RECRUITMENT-STAGES §1 يفضّل المفتاح الأجنبي، والبريف يطلب قيد check — الاثنان معاً
do $$ begin
  alter table hr.recruitment_cases add constraint recruitment_cases_stage_fkey
    foreign key (stage) references hr.recruitment_stages(code);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hr.recruitment_cases add constraint chk_recruitment_cases_stage
    check (stage = any (array[
      'manpower_request','sourcing_route','work_permit','visa_issue','agency_contract',
      'candidate_shortlist','medical_origin','visa_stamp_ticket','arrival','medical_local',
      'biometrics_security','residency_issue','civil_id','driving_licence',
      'onboarding_setup','probation_start','probation_review']));
exception when duplicate_object then null; end $$;
-- ملاحظة: مشغّل due_at (platform.set_stage_due_at) قائم أصلاً في 13 سطر 234
--   على hr.recruitment_cases و13 سطر 593 على admin.gov_transactions — لا تكرار.

-- v4 ADM §6 · المصدر: 11 §… (v4) — «لا اعتماد ذاتي» مشغّلاً لا check(true)
create or replace function admin.reject_self_approval()
returns trigger language plpgsql as $$
declare v_requester uuid;
begin
  if new.approver_user_id is null or new.decision is null then
    return new;
  end if;
  select requested_by into v_requester
    from admin.approval_requests where id = new.request_id;
  if new.approver_user_id = v_requester then
    raise exception 'no_self_approval: الطالب لا يعتمد طلبه (request_id=%)', new.request_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_no_self_approval on admin.approval_steps;
create trigger trg_no_self_approval
  before insert or update of approver_user_id, decision on admin.approval_steps
  for each row execute function admin.reject_self_approval();
-- ملاحظة: قيد admin.purchase_requests.no_self_approval الفعلي قائم في 13 سطر 478
--   (`check (approved_by is null or approved_by <> requested_by)`) — لا قيد صوري ليُحذف.

-- v4 ADM §9 · المصدر: EXEC §1.2 — تفكيك الخصومات المسمّاة
alter table hr.commission_rules  add column if not exists bonus_rate      numeric(14,3);
alter table hr.commission_rules  add column if not exists bonus_condition jsonb;
alter table hr.commission_daily  add column if not exists deduction_housing   numeric(14,3) not null default 0;
alter table hr.commission_daily  add column if not exists deduction_phone     numeric(14,3) not null default 0;
alter table hr.commission_daily  add column if not exists deduction_residency numeric(14,3) not null default 0;
alter table hr.commission_daily  add column if not exists deduction_other     numeric(14,3) not null default 0;

-- v4 ADM §10 · المصدر: 09 §مطابقة — فصل المطابقة عن الاعتماد
alter table partners.partner_invoices add column if not exists matched_by uuid;
do $$ begin
  alter table partners.partner_invoices add constraint matcher_ne_approver
    check (matched_by is null or approved_by is null or matched_by <> approved_by);
exception when duplicate_object then null; end $$;

-- v4 OPS §4 · المصدر: 26 §5 · 29 — المعاملة اليدوية تُعلَّم بتاريخها الأصلي
do $$
declare t text;
begin
  foreach t in array array[
    'wms.stock_movements','wms.order_lines','wms.inbound_orders','wms.outbound_orders',
    'tms.proof_of_delivery','tms.delivery_tasks','tms.fuel_ledger','imile.scan_log',
    'billing.receipts','housing.bed_assignments','housing.maintenance_requests']
  loop
    execute format('alter table %s add column if not exists entered_offline boolean not null default false', t);
    execute format('alter table %s add column if not exists original_occurred_at timestamptz', t);
    begin
      execute format('alter table %s add constraint chk_%s_offline_has_date '
                     'check (entered_offline = false or original_occurred_at is not null)',
                     t, replace(t,'.','_'));
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
-- ملاحظة: «جدول الحضور في hr» في OPS §4 غير موجود في 01/13 — يُضاف عند إنشائه.


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-18 · المستودع — الإشغال بالكتلة والدوال المصحَّحة (OPS §3 · 17 §4 §5 v4)
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 OPS-59 · المصدر: OPS §3 · 17 §3 (v4)
alter table wms.occupancy_snapshots add column if not exists space_block_id
  uuid references wms.space_blocks(id);
create index if not exists occupancy_snapshots_block_idx
  on wms.occupancy_snapshots (space_block_id, snapshot_date desc);

-- v4 OPS-11 · المصدر: OPS §2-3 — وحدة طاقة الكتلة (موضع رف ≠ منصة قابلة للبيع)
alter table wms.space_blocks add column if not exists uom text not null default 'pallet';
do $$ begin
  alter table wms.space_blocks add constraint chk_space_blocks_uom
    check (uom = any (array['pallet','sqm','cbm','position']));
exception when duplicate_object then null; end $$;
comment on column wms.space_blocks.uom is
  'v4 (استنباط تقني، يحتاج تأكيد GM — OPS-11): كتل الرفوف طاقتها مواضع لا منصات. 17 §4 يحسب sellable من capacity_pallets';

-- المصدر: 17 §4 (v4) — الإشغال من اللقطة بالكتلة مباشرةً، لا ربط بـwms.locations
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
  select b.code, b.uom,   -- v4: uom من الكتلة بدل الحرف الثابت 'pallet' (OPS-11)
         b.capacity_pallets, oos.q, alloc.q, resv.q,
         b.capacity_pallets - oos.q - alloc.q - resv.q,     -- المتاح للبيع
         occ.q,
         greatest(alloc.q - occ.q, 0)                        -- متعاقد وغير مشغول
  from b, oos, alloc, resv, occ
$$;

-- المصدر: 17 §5 (v4) — اللوحة تطرح out_of_service (كان مفقوداً — OPS-60)
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

-- المصدر: 14 §6 (v4) — الإشغال من bed_assignments لا من beds.status (ADM §5)
-- v4: `drop` أولاً — العرض يكتسب عموداً جديداً (status_mismatch) و`create or replace`
--     لا يقبل تغيير قائمة الأعمدة (ERROR: cannot change name of view column).
drop view if exists housing.capacity_overview;
create view housing.capacity_overview as
select
  p.id   as property_id,
  p.code as property_code,
  p.area,
  count(b.id) as total_beds,
  count(*) filter (
    where exists (select 1 from housing.bed_assignments a
                  where a.bed_id = b.id and a.assigned_to is null)
  ) as occupied,
  count(*) filter (
    where b.status = 'reserved'
      and not exists (select 1 from housing.bed_assignments a
                      where a.bed_id = b.id and a.assigned_to is null)
  ) as reserved,
  count(*) filter (
    where b.status in ('available','reserved')
      and not exists (select 1 from housing.bed_assignments a
                      where a.bed_id = b.id and a.assigned_to is null)
  ) as available,
  count(*) filter (where b.status in ('maintenance','blocked')) as out_of_service,
  -- حارس تناقض: سرير معلَّم مشغولاً وليس عليه إسناد نشط
  count(*) filter (
    where b.status = 'occupied'
      and not exists (select 1 from housing.bed_assignments a
                      where a.bed_id = b.id and a.assigned_to is null)
  ) as status_mismatch,
  round(100.0 * count(*) filter (
    where exists (select 1 from housing.bed_assignments a
                  where a.bed_id = b.id and a.assigned_to is null)
  )::numeric / nullif(count(b.id), 0)::numeric, 1) as occupancy_pct,
  p.monthly_rent,
  round(p.monthly_rent / nullif(count(*) filter (
    where exists (select 1 from housing.bed_assignments a
                  where a.bed_id = b.id and a.assigned_to is null)
  ), 0)::numeric, 3) as cost_per_occupied_bed
from      housing.properties p
left join housing.units u on u.property_id = p.id
left join housing.rooms r on r.unit_id     = u.id
left join housing.beds  b on b.room_id     = r.id
where p.status = 'active'
group by p.id, p.code, p.area, p.monthly_rent;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-19 · الحوكمة — عرضا كشف التكرار وبطاقة الجودة (SCR-7 · 22 §5 · §7)
-- ═══════════════════════════════════════════════════════════════════════════

-- v4 SCR-7 · المصدر: 22 §5 (v4) — فحص دوري أسبوعي يُرفع لمالك المجال
create extension if not exists pg_trgm;
create or replace view sales.possible_duplicates as
select a.id a_id, a.code a_code, a.name_ar a_name,
       b.id b_id, b.code b_code, b.name_ar b_name,
       round(similarity(a.name_ar,b.name_ar)::numeric,3) sim
from sales.accounts a join sales.accounts b on a.id < b.id
where a.deleted_at is null and b.deleted_at is null
  and (a.cr_number = b.cr_number or similarity(a.name_ar,b.name_ar) >= 0.85);
-- v4.4 · قرار GM 23/09/2026 (WBS 1.5، المرحلة D): `> 0.85` → `>= 0.85` كما في 40 §C2 INV-C2-3 — الترحيل 0006.

-- v4 SCR-7 · المصدر: 22 §7 (v4)
create or replace view platform.mdm_scorecard as
select 'العملاء' domain, 'المدير المالي' owner,
       count(*) total,
       count(*) filter (where cr_number is not null and credit_limit > 0
                          and segment_id is not null and payment_terms_days is not null) complete,
       round(100.0*count(*) filter (where cr_number is not null and credit_limit > 0
                          and segment_id is not null and payment_terms_days is not null)
             / nullif(count(*),0),1) pct
from sales.accounts where deleted_at is null
union all
select 'الخدمات','المدير المالي', count(*),
       count(*) filter (where min_price is not null and standard_cost is not null),
       round(100.0*count(*) filter (where min_price is not null and standard_cost is not null)/nullif(count(*),0),1)
from catalog.services where is_active
union all
select 'الأصناف','مدير المستودع', count(*),
       count(*) filter (where barcode is not null and length_cm is not null and gross_weight_kg is not null),
       round(100.0*count(*) filter (where barcode is not null and length_cm is not null and gross_weight_kg is not null)/nullif(count(*),0),1)
from wms.skus where status='active'
union all
select 'المواقع','مدير المستودع', count(*),
       count(*) filter (where barcode is not null and not is_blocked),
       round(100.0*count(*) filter (where barcode is not null and not is_blocked)/nullif(count(*),0),1)
from wms.locations
union all
select 'وثائق الموظفين','الموارد البشرية', count(*),
       count(*) filter (where exists(select 1 from hr.employee_documents d
                                      where d.employee_id=e.id and d.expiry_date > current_date)),
       round(100.0*count(*) filter (where exists(select 1 from hr.employee_documents d
                                      where d.employee_id=e.id and d.expiry_date > current_date))/nullif(count(*),0),1)
from hr.employees e where status='active'
union all
select 'وثائق المركبات','مدير الأسطول', count(*),
       count(*) filter (where exists(select 1 from tms.vehicle_documents d
                                      where d.vehicle_id=v.id and d.expiry_date > current_date)),
       round(100.0*count(*) filter (where exists(select 1 from tms.vehicle_documents d
                                      where d.vehicle_id=v.id and d.expiry_date > current_date))/nullif(count(*),0),1)
from tms.vehicles v where status='active';

-- v4 · يسهّل مهمة WBS 0.16 (حارس G6) — 40 Part F
create or replace view identity.unclassified_columns as
select c.table_schema, c.table_name, c.column_name, c.data_type
from information_schema.columns c
join pg_class t on t.relname = c.table_name
join pg_namespace n on n.oid = t.relnamespace and n.nspname = c.table_schema
where t.relkind = 'r'
  and c.table_schema in ('platform','identity','catalog','sales','wms','tms','cc',
                         'billing','hr','partners','admin','housing','imile','governance')
  and not exists (select 1 from identity.column_classification k
                   where k.schema_name = c.table_schema
                     and k.table_name  = c.table_name
                     and k.column_name = c.column_name)
order by 1,2,3;
comment on view identity.unclassified_columns is
  'حارس G6 (40 Part F): كل عمود غير مصنَّف. تصنيف الكل مهمة WBS 0.16 — ق-8';

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-20 · قيود الحالات — كل عمود حالة في القاعدة (ق-11 · ق-12)
--   المصدر: _changelog/STATE-REGISTER.md (المستخرَج من 03 §0 v4)
--   القسم 1 = أعمدة مسارات 03 · القسم 3 = بقية أعمدة الحالة في القاعدة.
--   52 عموداً — كل صفّ معلَّم «v4 (استنباط)» في السجل مسجَّل في «يحتاج تحكيم»
--   ولا يُعتمد قيمةً نهائية قبل إقرار GM.
-- ═══════════════════════════════════════════════════════════════════════════
do $$ begin
  alter table sales.leads add constraint chk_leads_status
    check (status = any (array['new', 'contacted', 'qualified', 'converted', 'lost']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sales.opportunities add constraint chk_opportunities_stage
    check (stage = any (array['qualification', 'needs_analysis', 'proposal', 'negotiation', 'won', 'lost']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sales.quotes add constraint chk_quotes_status
    check (status = any (array['draft', 'commercial_review', 'finance_review', 'approved', 'sent', 'accepted', 'rejected', 'expired']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sales.contracts add constraint chk_contracts_status
    check (status = any (array['draft', 'signed', 'active', 'suspended', 'expired', 'renewed', 'terminated']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.inbound_orders add constraint chk_inbound_orders_status
    check (status = any (array['draft', 'approved', 'receiving', 'received', 'putaway', 'closed', 'cancelled']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.outbound_orders add constraint chk_outbound_orders_status
    check (status = any (array['draft', 'checks_pending', 'credit_rejected', 'approved', 'allocated', 'partially_allocated', 'picking', 'picked', 'checked', 'packed', 'loaded', 'dispatched', 'delivered', 'cancelled']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.order_lines add constraint chk_order_lines_status
    check (status = any (array['open', 'partial', 'complete', 'cancelled']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.inventory_counts add constraint chk_inventory_counts_status
    check (status = any (array['draft', 'in_progress', 'review', 'recount', 'adjusted', 'closed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tms.delivery_tasks add constraint chk_delivery_tasks_status
    check (status = any (array['created', 'assigned', 'out_for_delivery', 'delivered', 'failed', 'deferred', 'returned', 'cancelled']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tms.vehicles add constraint chk_vehicles_status
    check (status = any (array['registered', 'active', 'maintenance', 'idle', 'out_of_service', 'disposed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tms.routes add constraint chk_routes_status
    check (status = any (array['planned', 'active', 'closed', 'cancelled']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table cc.tickets add constraint chk_tickets_status
    check (status = any (array['open', 'in_progress', 'pending_client', 'pending_internal', 'resolved', 'closed', 'reopened']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table billing.billable_events add constraint chk_billable_events_status
    check (status = any (array['pending', 'priced', 'invoiced', 'excluded', 'disputed']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table billing.invoices add constraint chk_invoices_status
    check (status = any (array['draft', 'review', 'approved', 'sent', 'partially_paid', 'paid', 'overdue', 'void']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table billing.credit_notes add constraint chk_credit_notes_status
    check (status = any (array['draft', 'approved', 'applied']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hr.manpower_requests add constraint chk_manpower_requests_status
    check (status = any (array['draft', 'pending_approval', 'approved', 'in_progress', 'completed', 'rejected', 'cancelled']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hr.disciplinary_cases add constraint chk_disciplinary_cases_status
    check (status = any (array['draft', 'issued', 'grievance_filed', 'upheld', 'cancelled', 'applied', 'carried_forward',
                               'pending_authority', 'signed']));   -- v4 ق-12: يفرضهما مشغّل السلطة الهرمية
exception when duplicate_object then null; end $$;
do $$ begin
  alter table imile.shipments add constraint chk_shipments_internal_status
    check (internal_status = any (array['expected', 'arrived', 'sorted', 'staged', 'assigned', 'ofd', 'delivered', 'failed', 'returned']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table imile.sorting_plans add constraint chk_sorting_plans_status
    check (status = any (array['draft', 'review', 'approved', 'executing', 'closed']));
exception when duplicate_object then null; end $$;
-- v4 ق-12: `imile.dtl_problems.gate_result` نوعه **jsonb** في 01 سطر 1386
--   («نتائج البوابات G0–G4») لا عمود حالة قياسي، فلا يقبل قيد قائمة.
--   السجل نفسه يقول «المخرج منفصل: accept · reject · human · reclassify» —
--   والقيد يُكتب على عمودَي القرار النصيَّين بدلاً منه.
do $$ begin
  alter table imile.dtl_problems add constraint chk_dtl_problems_engine_decision
    check (engine_decision is null
           or engine_decision = any (array['accept', 'reject', 'human', 'reclassify']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table imile.dtl_problems add constraint chk_dtl_problems_auditor_decision
    check (auditor_decision is null
           or auditor_decision = any (array['accept', 'reject', 'human', 'reclassify']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table platform.integration_runs add constraint chk_integration_runs_status
    check (status = any (array['running', 'success', 'failed', 'partial']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table platform.integration_queue add constraint chk_integration_queue_status
    check (status = any (array['pending', 'processing', 'done', 'failed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table platform.decisions add constraint chk_decisions_status
    check (status = any (array['open', 'decided', 'expired', 'cancelled', 'auto_resolved']));   -- v4 ق-12: السجل + تعليق 29 §8   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table platform.documents add constraint chk_documents_status
    check (status = any (array['issued', 'superseded', 'void']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table catalog.price_lists add constraint chk_price_lists_status
    check (status = any (array['draft', 'active', 'expired']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sales.accounts add constraint chk_accounts_status
    check (status = any (array['active', 'suspended', 'closed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.skus add constraint chk_skus_status
    check (status = any (array['active', 'on_hold', 'discontinued']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_allocations add constraint chk_space_allocations_status
    check (status = any (array['active', 'expiring', 'expired', 'terminated']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_reservations add constraint chk_space_reservations_status
    check (status = any (array['active', 'converted', 'expired', 'cancelled']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_blocks add constraint chk_space_blocks_status
    check (status = any (array['active', 'inactive']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tms.maintenance_orders add constraint chk_maintenance_orders_status
    check (status = any (array['planned', 'in_progress', 'in_workshop', 'awaiting_parts', 'done', 'cancelled']));   -- v4 ق-12: السجل + تعليق 27 §1   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table cc.agents add constraint chk_agents_status
    check (status = any (array['offline', 'available', 'busy', 'break']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hr.employees add constraint chk_employees_status
    check (status = any (array['active', 'on_leave', 'suspended', 'terminated']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table hr.commission_daily add constraint chk_commission_daily_status
    check (status = any (array['calculated', 'disputed', 'approved', 'paid']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table housing.beds add constraint chk_beds_status
    check (status = any (array['available', 'occupied', 'reserved', 'maintenance']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table housing.bed_reservations add constraint chk_bed_reservations_status
    check (status = any (array['active', 'converted', 'expired', 'cancelled']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table housing.maintenance_requests add constraint chk_maintenance_requests_status
    check (status = any (array['open', 'assigned', 'in_progress', 'resolved', 'done', 'closed', 'rejected', 'cancelled']));   -- v4 ق-12: السجل + تعليق 14 §2
exception when duplicate_object then null; end $$;
do $$ begin
  alter table housing.assets add constraint chk_assets_status
    check (status = any (array['working', 'faulty', 'replaced']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.purchase_requests add constraint chk_purchase_requests_status
    check (status = any (array['draft', 'pending_approval', 'approved', 'rejected', 'ordered', 'cancelled']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.purchase_orders add constraint chk_purchase_orders_status
    check (status = any (array['issued', 'received', 'matched', 'paid', 'cancelled']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.approval_requests add constraint chk_approval_requests_status
    check (status = any (array['pending', 'approved', 'rejected', 'expired', 'delegated']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.assets add constraint chk_assets_status
    check (status = any (array['in_stock', 'in_custody', 'maintenance', 'disposed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.petty_cash add constraint chk_petty_cash_status
    check (status = any (array['active', 'closed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.correspondence add constraint chk_correspondence_status
    check (status = any (array['open', 'replied', 'closed']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table admin.gov_transactions add constraint chk_gov_transactions_stage
    check (stage = any (array['requested', 'submitted', 'in_progress', 'completed', 'rejected']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table partners.partners add constraint chk_partners_status
    check (status = any (array['active', 'suspended', 'terminated']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table partners.partner_contracts add constraint chk_partner_contracts_status
    check (status = any (array['draft', 'active', 'expired', 'terminated']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table partners.partner_invoices add constraint chk_partner_invoices_status
    check (status = any (array['received', 'matched', 'frozen', 'approved', 'paid', 'rejected']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table partners.payable_events add constraint chk_payable_events_status
    check (status = any (array['pending', 'priced', 'invoiced', 'excluded', 'disputed']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table imile.driver_ids add constraint chk_driver_ids_status
    check (status = any (array['available', 'assigned', 'suspended']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table housing.units add constraint chk_units_status
    check (status = any (array['active', 'inactive']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table housing.rooms add constraint chk_rooms_status
    check (status = any (array['active', 'inactive']));   -- v4 (استنباط — يحتاج تحكيم)
exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-21 · البذور — الخدمات · اللائحة · أسباب الفشل · التنبيهات · العتبات
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- بذرة catalog.services — 92 خدمة · 7 فئات
-- المصدر: الوثيقة 04 حصراً (منقولة عبر ADM-SCHEMA-NEEDS §1-1 و§1-2)
-- min_price و standard_cost تبقى فارغة عمداً: تُعبّأ بياناتٍ في مرحلتها من 38
-- وفق EXEC §1.1 (min_price = standard_cost × 1.15).
-- عدّ التحقق: ST 14 · HD 13 · OF 13 · DL 18 · VA 13 · CC 15 · IT 6 = 92
-- ───────────────────────────────────────────────────────────────────────────
insert into catalog.services
  (code, category_id, name_ar, name_en, uom, billing_basis, requires_contract_clause)
values
 ('ST-01',(select id from catalog.service_categories where code='ST'),'تخزين على منصات (رفوف)','Racked pallet storage','منصة / شهر','monthly',false),
 ('ST-02',(select id from catalog.service_categories where code='ST'),'تخزين أرضي (Bulk / Floor)','Bulk / floor storage','متر مربع / شهر','monthly',false),
 ('ST-03',(select id from catalog.service_categories where code='ST'),'تخزين بالحجم','Storage by volume','متر مكعب / شهر','monthly',false),
 ('ST-04',(select id from catalog.service_categories where code='ST'),'تخزين ميزانين','Mezzanine storage','خانة / شهر','monthly',false),
 ('ST-05',(select id from catalog.service_categories where code='ST'),'تخزين مبرَّد (2–8 م)','Chilled storage (2–8 C)','منصة / شهر','monthly',false),
 ('ST-06',(select id from catalog.service_categories where code='ST'),'تخزين مجمَّد (−18 م)','Frozen storage (−18 C)','منصة / شهر','monthly',false),
 ('ST-07',(select id from catalog.service_categories where code='ST'),'تخزين مكيّف (15–25 م)','Air-conditioned storage (15–25 C)','منصة / شهر','monthly',false),
 ('ST-08',(select id from catalog.service_categories where code='ST'),'تخزين مواد خطرة (فئة UN)','Hazardous goods storage (UN class)','منصة / شهر','monthly',false),
 ('ST-09',(select id from catalog.service_categories where code='ST'),'تخزين مؤمَّن (قفص / غرفة مغلقة)','Secured storage (cage / locked room)','منصة / شهر','monthly',false),
 ('ST-10',(select id from catalog.service_categories where code='ST'),'تخزين ساحة خارجية','Outdoor yard storage','متر مربع / شهر','monthly',false),
 ('ST-11',(select id from catalog.service_categories where code='ST'),'حد أدنى شهري للتخزين','Monthly storage minimum','عقد','monthly_fixed',false),
 ('ST-12',(select id from catalog.service_categories where code='ST'),'رسم إشغال فوق المتعاقد عليه (Overflow)','Overflow occupancy charge','منصة زائدة / شهر','monthly',false),
 ('ST-13',(select id from catalog.service_categories where code='ST'),'تخزين قصير الأمد (أقل من شهر)','Short-term storage (under one month)','منصة / يوم','daily',false),
 ('ST-14',(select id from catalog.service_categories where code='ST'),'حجز مساحة مضمونة غير مستخدمة','Guaranteed reserved unused space','منصة / شهر','monthly',false),
 ('HD-01',(select id from catalog.service_categories where code='HD'),'استلام وتفريغ حاوية 20 قدم','Receive and unload 20 ft container','حاوية','per_event',false),
 ('HD-02',(select id from catalog.service_categories where code='HD'),'استلام وتفريغ حاوية 40 قدم','Receive and unload 40 ft container','حاوية','per_event',false),
 ('HD-03',(select id from catalog.service_categories where code='HD'),'استلام شاحنة / مقطورة','Receive truck / trailer','شاحنة','per_event',false),
 ('HD-04',(select id from catalog.service_categories where code='HD'),'استلام بالمنصة (بضاعة مرصوصة)','Palletised receiving','منصة','per_unit',false),
 ('HD-05',(select id from catalog.service_categories where code='HD'),'استلام بالكرتون (تفريغ يدوي)','Carton receiving (manual unload)','كرتون','per_unit',false),
 ('HD-06',(select id from catalog.service_categories where code='HD'),'فرز وترصيص على منصات','Sort and stack onto pallets','منصة','per_unit',false),
 ('HD-07',(select id from catalog.service_categories where code='HD'),'فحص جودة عند الاستلام','Quality check on receipt','منصة / كرتون','per_unit',false),
 ('HD-08',(select id from catalog.service_categories where code='HD'),'إدخال وتخزين (Put-away)','Put-away','منصة','per_unit',false),
 ('HD-09',(select id from catalog.service_categories where code='HD'),'مناولة بضاعة ثقيلة أو غير قياسية','Heavy or non-standard goods handling','قطعة','per_event',false),
 ('HD-10',(select id from catalog.service_categories where code='HD'),'استلام مرتجعات','Returns receiving','كرتون / قطعة','per_unit',false),
 ('HD-11',(select id from catalog.service_categories where code='HD'),'تحويل داخلي بين المواقع بطلب العميل','Internal transfer between locations on client request','منصة','per_unit',false),
 ('HD-12',(select id from catalog.service_categories where code='HD'),'جرد استثنائي بطلب العميل','Ad-hoc stock count on client request','ساعة','hourly',false),
 ('HD-13',(select id from catalog.service_categories where code='HD'),'مناولة خارج ساعات الدوام','Out-of-hours handling','ساعة','hourly',false),
 ('OF-01',(select id from catalog.service_categories where code='OF'),'رسم الطلب الأساسي','Base order fee','طلب','per_event',false),
 ('OF-02',(select id from catalog.service_categories where code='OF'),'التقاط بند داخل الطلب (Pick Line)','Pick line','بند','per_unit',false),
 ('OF-03',(select id from catalog.service_categories where code='OF'),'التقاط بالقطعة (Each Pick)','Each pick','قطعة','per_unit',false),
 ('OF-04',(select id from catalog.service_categories where code='OF'),'التقاط بالكرتون','Carton pick','كرتون','per_unit',false),
 ('OF-05',(select id from catalog.service_categories where code='OF'),'التقاط بالمنصة الكاملة','Full pallet pick','منصة','per_unit',false),
 ('OF-06',(select id from catalog.service_categories where code='OF'),'تدقيق ومطابقة قبل الشحن','Pre-dispatch check and match','طلب','per_event',false),
 ('OF-07',(select id from catalog.service_categories where code='OF'),'تغليف وتعبئة','Packing','طلب / كرتون','per_unit',false),
 ('OF-08',(select id from catalog.service_categories where code='OF'),'لصق ملصقات / باركود','Label / barcode application','قطعة / كرتون','per_unit',false),
 ('OF-09',(select id from catalog.service_categories where code='OF'),'تحميل على المركبة','Loading onto vehicle','شحنة / منصة','per_unit',false),
 ('OF-10',(select id from catalog.service_categories where code='OF'),'صرف منصة كاملة','Full pallet outbound','منصة','per_unit',false),
 ('OF-11',(select id from catalog.service_categories where code='OF'),'تجهيز عاجل خارج الدور (Rush)','Rush order handling','طلب','per_event',false),
 ('OF-12',(select id from catalog.service_categories where code='OF'),'إعادة تجهيز بسبب خطأ العميل','Re-pick due to client error','طلب','per_event',false),
 ('OF-13',(select id from catalog.service_categories where code='OF'),'تجهيز طلب تجزئة متعدد الأصناف','Multi-SKU retail order picking','طلب','per_event',false),
 ('DL-01',(select id from catalog.service_categories where code='DL'),'توصيل شحنة استهلاكية (B2C)','B2C shipment delivery','شحنة','per_unit',false),
 ('DL-02',(select id from catalog.service_categories where code='DL'),'توصيل شحنة تجارية (B2B)','B2B shipment delivery','شحنة','per_unit',false),
 ('DL-03',(select id from catalog.service_categories where code='DL'),'رحلة مخصصة','Dedicated trip','رحلة','per_event',false),
 ('DL-04',(select id from catalog.service_categories where code='DL'),'سائق ومركبة مخصصان — باقة يومية','Dedicated driver and vehicle — daily package','يوم','daily',false),
 ('DL-05',(select id from catalog.service_categories where code='DL'),'سائق ومركبة مخصصان — باقة شهرية','Dedicated driver and vehicle — monthly package','شهر','monthly_fixed',false),
 ('DL-06',(select id from catalog.service_categories where code='DL'),'توصيل بالمسافة','Distance-based delivery','كيلومتر','per_unit',false),
 ('DL-07',(select id from catalog.service_categories where code='DL'),'توصيل في نفس اليوم','Same-day delivery','شحنة','per_unit',false),
 ('DL-08',(select id from catalog.service_categories where code='DL'),'توصيل بموعد محدد (Time Slot)','Time-slot delivery','شحنة','per_unit',false),
 ('DL-09',(select id from catalog.service_categories where code='DL'),'توصيل خارج الدوام أو في العطل','Out-of-hours or holiday delivery','شحنة / رحلة','per_event',false),
 ('DL-10',(select id from catalog.service_categories where code='DL'),'تحصيل نقدي عند التسليم (COD)','Cash on delivery collection','شحنة','per_unit_or_pct',false),
 ('DL-11',(select id from catalog.service_categories where code='DL'),'محاولة توصيل فاشلة','Failed delivery attempt','محاولة','per_event',true),
 ('DL-12',(select id from catalog.service_categories where code='DL'),'إرجاع شحنة إلى المستودع','Shipment return to warehouse','شحنة','per_unit',true),
 ('DL-13',(select id from catalog.service_categories where code='DL'),'انتظار المركبة فوق المدة المسموحة','Vehicle waiting beyond allowance','ساعة','hourly',true),
 ('DL-14',(select id from catalog.service_categories where code='DL'),'إعادة جدولة بطلب المستلم','Reschedule at consignee request','شحنة','per_event',true),
 ('DL-15',(select id from catalog.service_categories where code='DL'),'توصيل بمركبة مبرَّدة','Refrigerated vehicle delivery','شحنة / رحلة','per_unit',false),
 ('DL-16',(select id from catalog.service_categories where code='DL'),'نقل بين المستودعات','Inter-warehouse transfer','رحلة','per_event',false),
 ('DL-17',(select id from catalog.service_categories where code='DL'),'توصيل لمناطق نائية / خارج النطاق','Remote / out-of-zone delivery','شحنة','surcharge',false),
 ('DL-18',(select id from catalog.service_categories where code='DL'),'تسليم جزئي بموافقة المستلم','Partial delivery with consignee consent','شحنة','per_event',true),
 ('VA-01',(select id from catalog.service_categories where code='VA'),'إعادة تغليف / إعادة تعبئة','Re-packing / re-bagging','قطعة / كرتون','per_unit',false),
 ('VA-02',(select id from catalog.service_categories where code='VA'),'تجميع عروض (Kitting / Bundling)','Kitting / bundling','طقم','per_unit',false),
 ('VA-03',(select id from catalog.service_categories where code='VA'),'تفكيك أطقم','De-kitting','طقم','per_unit',false),
 ('VA-04',(select id from catalog.service_categories where code='VA'),'لصق ملصقات ترويجية','Promotional labelling','قطعة','per_unit',false),
 ('VA-05',(select id from catalog.service_categories where code='VA'),'طباعة ولصق باركود','Barcode printing and application','قطعة','per_unit',false),
 ('VA-06',(select id from catalog.service_categories where code='VA'),'فحص وفرز مرتجعات وتصنيف حالتها','Returns inspection grading and sorting','قطعة','per_unit',false),
 ('VA-07',(select id from catalog.service_categories where code='VA'),'إتلاف بضاعة منتهية أو تالفة','Disposal of expired or damaged goods','منصة / كرتون','per_unit',false),
 ('VA-08',(select id from catalog.service_categories where code='VA'),'تغليف انكماشي (Shrink Wrap)','Shrink wrapping','منصة','per_unit',false),
 ('VA-09',(select id from catalog.service_categories where code='VA'),'وزن وقياس الأصناف وتسجيلها','SKU weighing measuring and recording','صنف','per_unit',false),
 ('VA-10',(select id from catalog.service_categories where code='VA'),'تصوير المنتجات','Product photography','قطعة','per_unit',false),
 ('VA-11',(select id from catalog.service_categories where code='VA'),'جرد دوري إضافي بطلب العميل','Additional cycle count on client request','ساعة','hourly',false),
 ('VA-12',(select id from catalog.service_categories where code='VA'),'إعداد تقارير مخصصة','Custom report preparation','تقرير','per_event',false),
 ('VA-13',(select id from catalog.service_categories where code='VA'),'مناولة الحجر الصحي والإفراج','Quarantine handling and release','منصة','per_unit',false),
 ('CC-01',(select id from catalog.service_categories where code='CC'),'استقبال مكالمات واردة','Inbound call handling','مكالمة مُجابة','per_unit',false),
 ('CC-02',(select id from catalog.service_categories where code='CC'),'استقبال مكالمات — بالدقيقة','Inbound calls — per minute','دقيقة محادثة','per_unit',false),
 ('CC-03',(select id from catalog.service_categories where code='CC'),'مقعد وكيل مخصّص','Dedicated agent seat','مقعد / شهر','monthly_fixed',false),
 ('CC-04',(select id from catalog.service_categories where code='CC'),'معالجة تذكرة / شكوى','Ticket / complaint handling','تذكرة','per_unit',false),
 ('CC-05',(select id from catalog.service_categories where code='CC'),'مكالمات صادرة (حملة)','Outbound calls (campaign)','مكالمة','per_unit',false),
 ('CC-06',(select id from catalog.service_categories where code='CC'),'خدمة واتساب / دردشة','WhatsApp / chat service','محادثة','per_unit',false),
 ('CC-07',(select id from catalog.service_categories where code='CC'),'معالجة بريد إلكتروني','Email handling','رسالة','per_unit',false),
 ('CC-08',(select id from catalog.service_categories where code='CC'),'تأكيد الطلبات قبل التوصيل','Order confirmation before delivery','طلب','per_unit',false),
 ('CC-09',(select id from catalog.service_categories where code='CC'),'متابعة الشحنات الفاشلة وإعادة الجدولة','Failed-shipment follow-up and rescheduling','شحنة','per_unit',false),
 ('CC-10',(select id from catalog.service_categories where code='CC'),'خدمة خارج ساعات الدوام (24/7)','Out-of-hours service (24/7)','شهر','monthly_fixed',false),
 ('CC-11',(select id from catalog.service_categories where code='CC'),'بدالة / رقم افتراضي','Switchboard / virtual number','رقم / شهر','monthly_fixed',false),
 ('CC-12',(select id from catalog.service_categories where code='CC'),'تسجيل المكالمات وأرشفتها','Call recording and archiving','مقعد / شهر','monthly_fixed',false),
 ('CC-13',(select id from catalog.service_categories where code='CC'),'تقارير وتحليلات مخصّصة','Custom reports and analytics','تقرير / شهر','monthly_fixed',false),
 ('CC-14',(select id from catalog.service_categories where code='CC'),'إعداد وتهيئة حساب عميل جديد','New client account setup','مرة واحدة','per_event',false),
 ('CC-15',(select id from catalog.service_categories where code='CC'),'تدريب وكلاء على منتج العميل','Agent training on client product','ساعة','hourly',false),
 ('IT-01',(select id from catalog.service_categories where code='IT'),'نافذة عميل (حسابات وصلاحيات)','Client portal (accounts and permissions)','عقد','monthly_fixed',false),
 ('IT-02',(select id from catalog.service_categories where code='IT'),'تكامل API مع نظام العميل','API integration with client system','مرة واحدة','per_event',false),
 ('IT-03',(select id from catalog.service_categories where code='IT'),'صيانة التكامل','Integration maintenance','شهر','monthly_fixed',false),
 ('IT-04',(select id from catalog.service_categories where code='IT'),'تقارير مجدولة مخصّصة','Custom scheduled reports','تقرير / شهر','monthly_fixed',false),
 ('IT-05',(select id from catalog.service_categories where code='IT'),'استيراد بيانات وتنظيفها','Data import and cleansing','ملف / سجل','per_unit',false),
 ('IT-06',(select id from catalog.service_categories where code='IT'),'لوحة مؤشرات مخصّصة','Custom dashboard','لوحة / شهر','monthly_fixed',false)
on conflict (code) do nothing;
-- ───────────────────────────────────────────────────────────────────────────
-- بذرة hr.penalty_schedule — **77 بنداً** (ق-14 · صُحِّح في SCH-3)
-- المصدر: جداول الوثيقة 15 §2-أ..§2-ط حرفياً (استُخرجت آلياً من صفوف الجدول).
-- التسع فئات وأعدادها: attendance 10 · work 11 · vehicle 11 · client 10 ·
--   safety 8 · conduct 10 · housing 9 · **custody 4 (`CST`)** · system 4 = 77
-- v4 SCH-3: فئة العهد والأصول رمزها **`CST`** لا `CUS` (15 §2-ح، الأسطر ~150–158)،
--   وكان استخراج SCH-2 يفوّتها فيعطي 73. الرقم 77 في R-05 و15 §1 **صحيح**.
-- is_fraud = true على الثمانية (EXECUTION-MASTER-v4 §1.13 ADR-28):
--   CLI-02 · CLI-03 · CLI-04 · CLI-06 · CLI-09 · ATT-07 · ATT-08 · WRK-08
-- min_degree مشتق من خانة D1 = «—» (15 بنداً؛ ADM-19 يقول 16 — في «يحتاج تحكيم»)
-- degree_N_days مشتقة من نص الدرجة: ¼ → 0.25 · ½ → 0.50 · يوم → 1 · يومين → 2 · N أيام → N
-- ───────────────────────────────────────────────────────────────────────────
insert into hr.penalty_schedule
  (code, category, offence_ar,
   degree_1, degree_1_days, degree_2, degree_2_days,
   degree_3, degree_3_days, degree_4, degree_4_days,
   allows_dismissal, dismissal_article, charges_damage, is_fraud, min_degree, sort_order)
values
 ('ATT-01','attendance','التأخر عن موعد العمل حتى 30 دقيقة بلا إذن', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ¼ يوم',0.25, 'خصم ½ يوم',0.50, false,null,false,false,1,1),
 ('ATT-02','attendance','التأخر أكثر من 30 دقيقة وحتى ساعتين', 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, 'خصم يومين',2.00, false,null,false,false,1,2),
 ('ATT-03','attendance','الغياب يوماً واحداً بلا إذن أو عذر مقبول', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,3),
 ('ATT-04','attendance','الغياب أكثر من 7 أيام متتالية أو 20 يوماً متفرقة في السنة بلا عذر', '—',0.00, '—',0.00, '—',0.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,4,4),
 ('ATT-05','attendance','مغادرة موقع العمل أثناء الدوام بلا إذن', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,5),
 ('ATT-06','attendance','الانصراف قبل نهاية الدوام بلا إذن', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,6),
 ('ATT-07','attendance','التوقيع أو البصمة نيابة عن زميل أو تمكينه من ذلك', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل — غش',0.00, true,null,false,true,1,7),
 ('ATT-08','attendance','التلاعب في نظام البصمة أو تعطيله عمداً', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,true,1,8),
 ('ATT-09','attendance','عدم الالتزام بجدول الراحات أو أخذ راحة بلا اعتماد', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,9),
 ('ATT-10','attendance','النوم أثناء ساعات العمل', 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, 'خصم يومين',2.00, false,null,false,false,1,10),
 ('WRK-01','work','التقصير في أداء المهام الموكلة', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يومين',2.00, false,null,false,false,1,11),
 ('WRK-02','work','رفض تنفيذ تعليمات مشروعة من الرئيس المباشر', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم 3 أيام',3.00, 'فصل — م.41',0.00, true,'41',false,false,1,12),
 ('WRK-03','work','مخالفة إجراءات العمل المعتمدة (فرز · مسح · تسليم)', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يومين',2.00, false,null,false,false,1,13),
 ('WRK-04','work','إفشاء أسرار العمل أو بيانات العملاء', '—',0.00, '—',0.00, '—',0.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,4,14),
 ('WRK-05','work','إهمال يترتب عليه ضرر مادي للشركة أو العميل', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل + تحميل قيمة الضرر',0.00, true,null,true,false,1,15),
 ('WRK-06','work','عدم تسليم المستندات أو النماذج في موعدها', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,16),
 ('WRK-07','work','إدخال بيانات غير صحيحة في النظام', 'تنبيه',0.00, 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, false,null,false,false,1,17),
 ('WRK-08','work','التلاعب في البيانات أو المستندات', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,true,2,18),
 ('WRK-09','work','العمل لدى الغير أثناء ساعات العمل', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,19),
 ('WRK-10','work','عدم ارتداء الزي الرسمي أو بطاقة التعريف', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ¼ يوم',0.25, 'خصم ½ يوم',0.50, false,null,false,false,1,20),
 ('WRK-11','work','استخدام الهاتف الشخصي بما يعطّل العمل', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ¼ يوم',0.25, 'خصم ½ يوم',0.50, false,null,false,false,1,21),
 ('VEH-01','vehicle','القيادة بلا رخصة سارية أو بوثائق منتهية', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,22),
 ('VEH-02','vehicle','القيادة تحت تأثير مسكر أو مادة مؤثرة', '—',0.00, '—',0.00, '—',0.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,4,23),
 ('VEH-03','vehicle','مخالفة مرورية بسبب إهمال السائق', 'تحميل المخالفة',0.00, 'تحميل + إنذار',0.00, 'تحميل + خصم يوم',1.00, 'تحميل + خصم يومين',2.00, false,null,true,false,1,24),
 ('VEH-04','vehicle','حادث بسبب إهمال أو تهور', 'إنذار + تحميل',0.00, 'خصم يومين + تحميل',2.00, 'خصم 3 أيام + تحميل',3.00, 'فصل + تحميل',0.00, true,null,true,false,1,25),
 ('VEH-05','vehicle','استخدام مركبة الشركة لأغراض شخصية بلا إذن', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,26),
 ('VEH-06','vehicle','عدم الإبلاغ عن حادث أو عطل فوراً', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,27),
 ('VEH-07','vehicle','إهمال نظافة المركبة أو صيانتها الدورية', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,28),
 ('VEH-08','vehicle','تعبئة وقود في غير مركبة الشركة أو إساءة استخدام البطاقة', 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'فصل — م.41/أ',0.00, true,'41/a',false,false,1,29),
 ('VEH-09','vehicle','عدم تسجيل قراءة العداد عند التعبئة', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ¼ يوم',0.25, 'خصم ½ يوم',0.50, false,null,false,false,1,30),
 ('VEH-10','vehicle','تسليم المركبة لغير المصرّح له', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,31),
 ('VEH-11','vehicle','تجاوز نطاق التشغيل المحدد بلا إذن', 'تنبيه',0.00, 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, false,null,false,false,1,32),
 ('CLI-01','client','سوء معاملة العميل أو المستلم', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,33),
 ('CLI-02','client','تسجيل محاولة توصيل فاشلة بلا محاولة فعلية', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل — غش',0.00, true,null,false,true,1,34),
 ('CLI-03','client','إثبات تسليم غير صحيح (توقيع أو صورة غير مطابقة)', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل — غش',0.00, true,null,false,true,1,35),
 ('CLI-04','client','عدم توريد مبلغ الدفع عند الاستلام (COD) في موعده', 'خصم يومين + التوريد',2.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',true,true,1,36),
 ('CLI-05','client','فقد شحنة أو تلفها بإهمال', 'إنذار + تحميل',0.00, 'خصم يومين + تحميل',2.00, 'خصم 3 أيام + تحميل',3.00, 'فصل + تحميل',0.00, true,null,true,false,1,37),
 ('CLI-06','client','فتح شحنة أو العبث بمحتواها', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,true,2,38),
 ('CLI-07','client','تأخير التسليم بلا مبرر مقبول', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,39),
 ('CLI-08','client','عدم إعادة الشحنة المرتجعة للمستودع في يومها', 'تنبيه',0.00, 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, false,null,false,false,1,40),
 ('CLI-09','client','طلب مبلغ إضافي من المستلم', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل بلا مكافأة',0.00, true,null,false,true,2,41),
 ('CLI-10','client','رفض استلام مهمة موزَّعة بلا سبب مقبول', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,42),
 ('SAF-01','safety','عدم استخدام معدات الوقاية الشخصية', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,43),
 ('SAF-02','safety','تشغيل رافعة أو معدة بلا تصريح أو تدريب', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,44),
 ('SAF-03','safety','التدخين في المواقع الممنوعة', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,45),
 ('SAF-04','safety','عدم الإبلاغ عن إصابة أو حادث عمل', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,46),
 ('SAF-05','safety','العبث بأجهزة الإطفاء أو مخارج الطوارئ', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل — م.41',0.00, true,'41',false,false,2,47),
 ('SAF-06','safety','تخزين بضاعة بما يخالف شروطها أو يعرّضها للتلف', 'تنبيه',0.00, 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, false,null,false,false,1,48),
 ('SAF-07','safety','عدم الالتزام بضوابط المواد الخطرة', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,49),
 ('SAF-08','safety','خلط بضاعة عميل بعميل آخر', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,50),
 ('CON-01','conduct','إساءة التعامل مع الزملاء أو إثارة الفوضى', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,51),
 ('CON-02','conduct','الاعتداء بالضرب على زميل أو رئيس', '—',0.00, '—',0.00, '—',0.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,4,52),
 ('CON-03','conduct','السرقة أو الاستيلاء على مال أو ممتلكات', '—',0.00, '—',0.00, '—',0.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,4,53),
 ('CON-04','conduct','الحضور تحت تأثير مسكر أو مادة مؤثرة', '—',0.00, '—',0.00, '—',0.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,4,54),
 ('CON-05','conduct','التحريض على الإضراب أو تعطيل العمل', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل — م.41',0.00, true,'41',false,false,2,55),
 ('CON-06','conduct','إساءة استخدام اسم الشركة أو شعارها', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,56),
 ('CON-07','conduct','نشر محتوى يسيء للشركة أو عملائها', 'إنذار',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'فصل',0.00, true,null,false,false,1,57),
 ('CON-08','conduct','الامتناع عن التوقيع على إخطار رسمي', 'محضر شاهدين',0.00, 'محضر + إنذار',0.00, 'محضر + خصم يوم',1.00, 'محضر + خصم يومين',2.00, false,null,false,false,1,58),
 ('CON-09','conduct','تقديم مستندات أو معلومات غير صحيحة للشركة', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,2,59),
 ('CON-10','conduct','قبول هدية أو منفعة من عميل أو مورّد بلا إفصاح', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'فصل',0.00, true,null,false,false,2,60),
 ('HOU-01','housing','الإخلال بنظافة السكن أو الغرفة', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,61),
 ('HOU-02','housing','إتلاف أثاث أو أجهزة السكن', 'تحميل القيمة',0.00, 'تحميل + إنذار',0.00, 'تحميل + خصم يوم',1.00, 'تحميل + خصم يومين',2.00, false,null,true,false,1,62),
 ('HOU-03','housing','إثارة الإزعاج أو المشاجرة في السكن', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'فصل عند الاعتداء (م.41)',0.00, true,'41',false,false,1,63),
 ('HOU-04','housing','التدخين أو الطبخ في غير الأماكن المخصّصة', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,64),
 ('HOU-05','housing','إيواء شخص غير مسجَّل في السكن', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,65),
 ('HOU-06','housing','تغيير السرير أو الغرفة بلا إذن', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,66),
 ('HOU-07','housing','إدخال أو حيازة مواد ممنوعة في السكن', '—',0.00, '—',0.00, '—',0.00, 'الفصل + إبلاغ الجهات — م.41',0.00, true,'41',false,false,4,67),
 ('HOU-08','housing','الامتناع عن إخلاء السكن بعد انتهاء الخدمة', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'إجراء قانوني',0.00, false,null,false,false,1,68),
 ('HOU-09','housing','منع لجنة التفتيش من أداء عملها', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,69),
 ('CST-01','custody','فقد عهدة أو إتلافها بإهمال', 'تحميل القيمة',0.00, 'تحميل + إنذار',0.00, 'تحميل + خصم يوم',1.00, 'تحميل + خصم يومين',2.00, false,null,true,false,1,70),
 ('CST-02','custody','عدم إعادة العهدة عند الطلب أو انتهاء الخدمة', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'تحميل + إجراء قانوني',0.00, false,null,true,false,1,71),
 ('CST-03','custody','إعارة العهدة للغير بلا إذن', 'إنذار',0.00, 'خصم يوم',1.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, false,null,false,false,1,72),
 ('CST-04','custody','استخدام أجهزة الشركة لأغراض غير العمل', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,73),
 ('SYS-01','system','مشاركة بيانات الدخول مع الغير', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,74),
 ('SYS-02','system','محاولة الوصول لبيانات خارج الصلاحية', 'إنذار',0.00, 'خصم يومين',2.00, 'خصم 3 أيام',3.00, 'فصل',0.00, true,null,false,false,1,75),
 ('SYS-03','system','تصدير أو نسخ بيانات عملاء بلا إذن', '—',0.00, 'خصم 3 أيام',3.00, 'خصم 5 أيام',5.00, 'الفصل بلا مكافأة — م.41/أ',0.00, true,'41/a',false,false,2,76),
 ('SYS-04','system','عدم استخدام النظام في تسجيل العمليات', 'تنبيه',0.00, 'إنذار',0.00, 'خصم ½ يوم',0.50, 'خصم يوم',1.00, false,null,false,false,1,77)
on conflict (code) do nothing;
-- ───────────────────────────────────────────────────────────────────────────
-- بذرة tms.failure_reasons — 7 آباء + 25 ابناً = 32 صفاً
-- المصدر: 35 §4-0 (v4) حرفياً · counts_against_driver = true على ثلاثة فقط
-- (EXEC §1.2 FIXED · 40 §C4): no_answer.door_not_opened ·
-- address.building_not_found · driver.shift_time_exhausted
-- ───────────────────────────────────────────────────────────────────────────
insert into tms.failure_reasons
  (code, parent_code, name_ar, requires_photo, requires_contact_attempts,
   requires_note, is_billable, counts_against_driver, sort_order)
values
 ('no_answer', null,'لا يوجد رد',                false,2,false,true ,false, 10),
 ('address',   null,'العنوان',                   false,0,false,true ,false, 20),
 ('recipient', null,'المستلم',                   false,0,false,true ,false, 30),
 ('payment',   null,'الدفع',                     false,0,false,true ,false, 40),
 ('shipment',  null,'الشحنة',                    true ,0,true ,false,false, 50),
 ('access',    null,'الوصول',                    true ,0,true ,false,false, 60),
 ('driver',    null,'السائق',                    false,0,true ,false,false, 70),
 ('no_answer.no_response',        'no_answer','لم يرد على الهاتف',        false,2,false,true ,false, 11),
 ('no_answer.phone_off',          'no_answer','الهاتف مغلق',              false,2,false,true ,false, 12),
 ('no_answer.wrong_number',       'no_answer','الرقم خطأ',                false,2,false,true ,false, 13),
 ('no_answer.door_not_opened',    'no_answer','لم يفتح الباب',            false,2,false,true ,true , 14),
 ('address.incorrect',            'address',  'غير صحيح',                 false,0,false,true ,false, 21),
 ('address.incomplete',           'address',  'غير مكتمل',                false,0,false,true ,false, 22),
 ('address.building_not_found',   'address',  'لم أجد المبنى',            false,0,true ,true ,true , 23),
 ('address.out_of_coverage',      'address',  'منطقة خارج التغطية',       false,0,false,true ,false, 24),
 ('recipient.refused',            'recipient','رفض الاستلام',             false,0,false,true ,false, 31),
 ('recipient.requested_defer',    'recipient','طلب التأجيل',              false,0,false,true ,false, 32),
 ('recipient.absent',             'recipient','غير موجود',                false,0,false,true ,false, 33),
 ('recipient.not_authorised',     'recipient','غير مخوّل',                false,0,false,true ,false, 34),
 ('payment.no_funds',             'payment',  'المبلغ غير متوفر',         false,0,false,true ,false, 41),
 ('payment.refused',              'payment',  'رفض الدفع',                false,0,false,true ,false, 42),
 ('payment.method_mismatch',      'payment',  'يريد دفعاً مختلفاً',        false,0,false,true ,false, 43),
 ('shipment.damaged',             'shipment', 'تالفة',                    true ,0,true ,false,false, 51),
 ('shipment.short',               'shipment', 'ناقصة',                    true ,0,true ,false,false, 52),
 ('shipment.mismatch',            'shipment', 'غير مطابقة للطلب',         true ,0,true ,false,false, 53),
 ('access.area_closed',           'access',   'منطقة مغلقة',              true ,0,true ,false,false, 61),
 ('access.security_block',        'access',   'منع أمني',                 true ,0,true ,false,false, 62),
 ('access.road_blocked',          'access',   'طريق مسدود',               true ,0,true ,false,false, 63),
 ('access.weather',               'access',   'ظرف جوي',                  true ,0,true ,false,false, 64),
 ('driver.vehicle_breakdown',     'driver',   'عطل مركبة',                false,0,true ,false,false, 71),
 ('driver.accident',              'driver',   'حادث',                     true ,0,true ,false,false, 72),
 ('driver.shift_time_exhausted',  'driver',   'نفاد وقت الوردية',         false,0,true ,false,true , 73)
on conflict (code) do nothing;
-- ملاحظة 35 §4-1: door_not_opened و building_not_found «مشروطتان» (محاولتا اتصال ·
--   بُعد > 300 م). الشرط يُقيَّم في طبقة الأعمال من tms.contact_log والإحداثيات؛
--   العَلَم هنا يقول «قابلة للاحتساب» لا «محتسَبة حتماً».
-- ملاحظة R-06: driver.vehicle_breakdown و driver.accident **لا** تُحتسبان على
--   السائق — مسار الأسطول (VEH-07) ومسار التحقيق (VEH-04) على الترتيب.

-- ───────────────────────────────────────────────────────────────────────────
-- بذرة hr.commission_rules — الهيكل المحسوم (EXEC §1.2 · R-05)
-- 0.300 د.ك لكل شحنة مسلَّمة (ثابت) + بونص جودة 0.050 عند first_attempt ≥ 85%
-- وبلا فرق COD في الشهر. الخصومات الشهرية عتبات: سكن 23 · هاتف 5 · إقامة 12.
-- ───────────────────────────────────────────────────────────────────────────
insert into hr.commission_rules
  (entity_id, name, applies_to, rate_per_unit, bonus_rate, bonus_condition, valid_from, created_by)
select e.id, 'عمولة السائق — الهيكل المحسوم (EXEC §1.2)', 'driver',
       0.300, 0.050,
       '{"first_attempt_pct_min": 85, "cod_variance": 0, "window": "month"}'::jsonb,
       current_date, '00000000-0000-0000-0000-000000000000'
from platform.entities e where e.code = 'PDL'
on conflict do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- بذور platform.thresholds — مفاتيح OPS §7 و ADM §8 (بالإضافة إلى عتبات ADR-27 الـ16)
-- كل قيمة منصوصة في EXEC §1.1/§1.2/§1.3 أو 40 §B5 أو 11 §3 أو 35 §7 أو 17 §5-1.
-- ───────────────────────────────────────────────────────────────────────────
insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
 ('driver.payment.link_ttl_min',       30.000,'minutes','مهلة رابط الدفع — 40 §B5',                              '00000000-0000-0000-0000-000000000000'),
 ('driver.custody.alert_hours',        24.000,'hours',  'تنبيه العهدة الفاشلة — 35 §7 (v4: فُصل عن التصعيد)',    '00000000-0000-0000-0000-000000000000'),
 ('driver.custody.escalate_hours',     48.000,'hours',  'تصعيد العهدة الفاشلة — 35 §7',                          '00000000-0000-0000-0000-000000000000'),
 ('driver.commission_base',             0.300,'KWD',    'عمولة الشحنة المسلَّمة — EXEC §1.2',                    '00000000-0000-0000-0000-000000000000'),
 ('driver.commission_bonus',            0.050,'KWD',    'بونص الجودة للشحنة — EXEC §1.2',                        '00000000-0000-0000-0000-000000000000'),
 ('driver.bonus_first_attempt_pct',    85.000,'pct',    'عتبة النجاح من أول محاولة لاستحقاق البونص — EXEC §1.2', '00000000-0000-0000-0000-000000000000'),
 ('housing.deduction',                 23.000,'KWD',    'خصم السكن الشهري — EXEC §1.2/§1.3',                     '00000000-0000-0000-0000-000000000000'),
 ('housing.phone_deduction',            5.000,'KWD',    'خصم الهاتف الشهري — EXEC §1.2',                         '00000000-0000-0000-0000-000000000000'),
 ('housing.residency_deduction',       12.000,'KWD',    'خصم الإقامة الشهري — EXEC §1.2',                        '00000000-0000-0000-0000-000000000000'),
 ('housing.min_occupancy_pct',         70.000,'pct',    'إشغال السكن قبل مراجعة الإيجار — EXEC §1.3',            '00000000-0000-0000-0000-000000000000'),
 ('space.reservation_max_days',        30.000,'days',   'أقصى مدة حجز مساحة — EXEC §1.1',                        '00000000-0000-0000-0000-000000000000'),
 ('space.buffer_pct',                   7.000,'pct',    'العازل التشغيلي من طاقة الكتلة — EXEC §1.1 · 17 §5-1',  '00000000-0000-0000-0000-000000000000'),
 ('invoice.auto_approve_max',         500.000,'KWD',    'سقف الاعتماد الآلي للفاتورة — EXEC §1.1',               '00000000-0000-0000-0000-000000000000'),
 ('purchase.auto_max',                100.000,'KWD',    'شراء ≤ 100 يُعتمد آلياً — EXEC §1.1',                   '00000000-0000-0000-0000-000000000000'),
 ('purchase.manager_max',             500.000,'KWD',    'شراء 100–500 مدير القسم — EXEC §1.1',                   '00000000-0000-0000-0000-000000000000'),
 ('purchase.cfo_max',                2000.000,'KWD',    'شراء 500–2,000 المدير المالي · فوقها GM — EXEC §1.1',   '00000000-0000-0000-0000-000000000000'),
 ('purchase.three_quotes_min',        500.000,'KWD',    'ثلاثة عروض أسعار فوق هذا المبلغ — 11 §3 · 12 س14',      '00000000-0000-0000-0000-000000000000'),
 ('contract.min_margin_pct',           15.000,'pct',    'هامش العقد — تحته تحذير — EXEC §1.1',                   '00000000-0000-0000-0000-000000000000'),
 ('contract.gm_margin_pct',            10.000,'pct',    'هامش العقد — تحته اعتماد GM — EXEC §1.1',               '00000000-0000-0000-0000-000000000000'),
 ('catalog.min_price_markup_pct',      15.000,'pct',    'min_price = standard_cost × 1.15 — EXEC §1.1',          '00000000-0000-0000-0000-000000000000'),
 ('partner.match_tolerance_pct',        2.000,'pct',    'تفاوت مطابقة فاتورة الشريك — 40 §C6 · 09 §5-1 (مُسجَّل في EXECUTION-MASTER-v4 §1.1)','00000000-0000-0000-0000-000000000000'),
 ('partner.liability_cap_months',       3.000,'months', 'سقف المسؤولية = min(3 × الفوترة الشهرية، قيمة العقد) — EXEC §1.1','00000000-0000-0000-0000-000000000000'),
 ('recruitment.escalate_days',         11.000,'days',   'تصعيد مرحلة الاستقدام — 40 Part E S13 (7 + 50%)',       '00000000-0000-0000-0000-000000000000'),
 ('recruitment.escalate_pct',          50.000,'pct',    'نسبة تجاوز SLA الموجبة للتصعيد — 10 §5 (للعرض)',        '00000000-0000-0000-0000-000000000000'),
 ('fleet.pm_oil_km',                 5000.000,'km',     'صيانة وقائية — الزيت — EXEC §1.3',                      '00000000-0000-0000-0000-000000000000'),
 ('fleet.pm_oil_days',                 90.000,'days',   'صيانة وقائية — الزيت بالزمن — EXEC §1.3',               '00000000-0000-0000-0000-000000000000'),
 ('fleet.pm_brakes_km',             20000.000,'km',     'صيانة وقائية — الفرامل — EXEC §1.3',                    '00000000-0000-0000-0000-000000000000'),
 ('fleet.pm_tyres_km',              40000.000,'km',     'صيانة وقائية — الإطارات — EXEC §1.3',                   '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- بذرة platform.alert_rules — 22 تنبيهاً (R-07 · PLT §ب)
-- N-01…N-18 من 25 §2 · N-19…N-22 من 23 §4. منقولة حرفياً من PLT-SCHEMA-NEEDS §ب.
-- ───────────────────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════════
-- بذر platform.alert_rules — 22 تنبيهاً (وثيقة 25 §2 و§2-1 · R-07)
-- N-01…N-18 من 25 §2 · N-19…N-22 من 23 §4 (v4 · PLT-12)
-- كل source_query يعيد صفر صفوف عند السلامة؛ عموده الأول entity_ref أساس الكبح.
-- dedupe_window_hours = 0 تعني «بلا كبح» (v4 · PLT-48).
-- quiet_hours = false للطوارئ فقط: N-01 (توقف الوكيل) و N-03 (فرق COD).
-- ⚠️ N-18 يتطلب platform.domain_quality_monthly · N-22 يتطلب integration_runs.integration_code
-- ═══════════════════════════════════════════════════════════════════════════

insert into platform.alert_rules
  (code, name_ar, source_query, target_roles, channels, schedule,
   dedupe_window_hours, quiet_hours, escalate_after_hours, escalate_to_roles,
   action_label, action_link)
values

('N-01','وكيل iMile متوقف > ١٥ دقيقة', $q$
select 'imile_agent' as entity_ref, max(h.last_pull_at) as last_pull
from imile.agent_health h
having max(h.last_pull_at) < now() - interval '15 minutes'
$q$, '{DEL_MGR}', '{in_app,whatsapp}', 'realtime', 60, false, 1, '{GM}',
 'افتح لوحة التكاملات', '/platform/integrations'),

('N-02','مشكلة تدقيق حي بلا بتّ > ٢٤ ساعة', $q$
select p.id::text as entity_ref, p.tracking_no, p.raised_at
from imile.dtl_problems p
where p.auditor_decision is null and p.closed_by is null
  and p.raised_at < now() - interval '24 hours'
$q$, '{DEL_MGR}', '{in_app,email}', '0 9 * * *', 24, true, 48, '{GM}',
 'افتح التدقيق الحي', '/imile/dtl'),

('N-03','فرق COD غير مسوّى', $q$
select t.doc_no as entity_ref, t.driver_id,
       coalesce(t.cod_collected,0) - coalesce(t.cod_amount,0) as variance
from tms.delivery_tasks t
where t.is_cod and t.status = 'delivered'
  and coalesce(t.cod_collected,0) <> coalesce(t.cod_amount,0)
  and t.completed_at >= current_date - 7
$q$, '{CFO,DEL_MGR}', '{in_app,whatsapp}', 'realtime', 0, false, 48, '{GM}',
 'سوِّ فرق COD', '/inbox?kind=cod_variance'),

('N-04','وثيقة موظف على سلّم الانتهاء 90/45/30/15 يوماً', $q$
select d.id::text as entity_ref, e.name_ar, d.doc_type, d.expiry_date,
       case when d.expiry_date - current_date <= 15 then 'D15'
            when d.expiry_date - current_date <= 30 then 'D30'
            when d.expiry_date - current_date <= 45 then 'D45' else 'D90' end as rung  -- v4: سلّم 90/45/30/15
from hr.employee_documents d
join hr.employees e on e.id = d.employee_id
where e.status = 'active'
  and d.expiry_date between current_date and current_date + 90
$q$, '{GM,PRO}', '{in_app,email}', '0 8 * * 0', 168, true, null, null,
 'جدول تجديد الوثائق', '/hr/documents?expiring=90'),

('N-05','وثيقة مركبة على سلّم الانتهاء 90/45/30/15 يوماً', $q$
select vd.id::text as entity_ref, v.plate_no, vd.doc_type, vd.expiry_date,
       case when vd.expiry_date - current_date <= 15 then 'D15'
            when vd.expiry_date - current_date <= 30 then 'D30'
            when vd.expiry_date - current_date <= 45 then 'D45' else 'D90' end as rung  -- v4: سلّم 90/45/30/15
from tms.vehicle_documents vd
join tms.vehicles v on v.id = vd.vehicle_id
where vd.expiry_date between current_date and current_date + 90
$q$, '{FLEET_MGR}', '{in_app,email}', '0 8 * * 0', 168, true, null, null,
 'جدول تجديد وثائق المركبات', '/fleet/documents?expiring=90'),

('N-06','عقد عميل ينتهي خلال مدة الإشعار', $q$
select c.doc_no as entity_ref, a.name_ar, c.end_date, c.notice_days
from sales.contracts c
join sales.accounts a on a.id = c.account_id
where c.status = 'active' and c.end_date is not null
  and c.end_date - coalesce(c.notice_days, 30) <= current_date
$q$, '{CFO,SALES_MGR}', '{in_app,email}', '0 8 * * *', 0, true, 360, '{GM}',
 'افتح ملف التجديد', '/sales/contracts?ending=notice'),

('N-07','عميل بلغ ٨٠٪ من حده الائتماني', $q$
select a.code as entity_ref, a.name_ar, a.credit_limit, sum(i.balance) as outstanding
from sales.accounts a
join billing.invoices i on i.client_id = a.id and i.status not in ('paid','void')
where a.credit_limit > 0
group by a.id, a.code, a.name_ar, a.credit_limit
having sum(i.balance) >= 0.80 * a.credit_limit
$q$, '{CFO}', '{in_app,email}', '0 8 * * *', 24, true, null, '{GM}',
 'افتح أعمار الذمم', '/billing/ar-aging'),

('N-08','حدث فوترة بلا سعر > ٧ أيام', $q$
select be.id::text as entity_ref, be.client_id, be.occurred_at, be.qty
from billing.billable_events be
where be.invoice_line_id is null
  and (be.unit_price is null or be.status = 'pending')
  and be.occurred_at < now() - interval '7 days'
$q$, '{CFO}', '{in_app,email}', '0 8 * * 0', 168, true, 720, '{GM}',
 'سعِّر الأحداث المعلّقة', '/billing/events?status=pending'),

('N-09','فاتورة متأخرة', $q$
select i.doc_no as entity_ref, i.client_id, i.due_date, i.balance,
       current_date - i.due_date as days_overdue
from billing.invoices i
where i.status not in ('paid','void','draft')
  and i.balance > 0 and i.due_date < current_date
$q$, '{CFO,ACCOUNTANT}', '{in_app,email}', '0 8 * * *', 24, true, 720, '{GM}',
 'افتح خطة التحصيل', '/billing/invoices?overdue=1'),

('N-10','فاتورة شريك بفرق > ٢٪', $q$
select pi.doc_no as entity_ref, pi.partner_id, pi.variance_pct, pi.variance_amount
from partners.partner_invoices pi
where pi.approved_at is null and abs(coalesce(pi.variance_pct,0)) > 2
$q$, '{CFO}', '{in_app}', 'realtime', 0, true, 168, '{GM}',
 'طابق فاتورة الشريك', '/partners/invoices?variance=1'),

('N-11','تجاوز مساحة متعاقدة', $q$
select sd.block as entity_ref, sd.warehouse, sd.contracted, sd.occupied
from wms.space_dashboard sd
where sd.contracted > 0 and sd.occupied > sd.contracted
$q$, '{WH_MGR,SALES_MGR}', '{in_app,email}', '0 8 * * *', 24, true, 2160, '{GM}',
 'افتح لوحة المساحات', '/wms/space'),

('N-12','حجز مساحة ينتهي خلال ٧ أيام', $q$
select r.id::text as entity_ref, r.client_id, r.block_id, r.expires_at
from wms.space_reservations r
where r.status = 'active'
  and r.expires_at between current_date and current_date + 7
$q$, '{SALES_MGR}', '{in_app}', '0 8 * * *', 24, true, null, null,
 'حوِّل الحجز أو أفرج عنه', '/wms/space/reservations'),

('N-13','فرق جرد بلا تفسير', $q$
select l.id::text as entity_ref, c.doc_no, l.location_id, l.variance
from wms.inventory_count_lines l
join wms.inventory_counts c on c.id = l.count_id
where c.finished_at is not null
  and coalesce(l.variance,0) <> 0 and l.variance_reason is null
$q$, '{WH_MGR}', '{in_app}', 'realtime', 0, true, 24, '{WH_MGR,GM}',
 'فسِّر فرق الجرد', '/wms/counts?variance=unexplained'),

('N-14','تذكرة تتجاوز ٨٠٪ من SLA', $q$
select t.doc_no as entity_ref, t.queue_id, t.priority, t.sla_due_at
from cc.tickets t
where t.status not in ('resolved','closed')
  and t.sla_due_at is not null
  and now() >= t.created_at + (t.sla_due_at - t.created_at) * 0.80
$q$, '{CC_MGR}', '{in_app}', 'realtime', 0, true, null, '{GM}',
 'افتح التذكرة', '/cc/tickets?sla=at_risk'),

('N-15','معاملة حكومية متأخرة عن SLA', $q$
select g.doc_no as entity_ref, g.transaction_type, g.authority, g.due_at
from admin.gov_transactions g
where g.completed_at is null and g.due_at is not null and g.due_at < now()
$q$, '{PRO}', '{in_app,email}', '0 8 * * *', 24, true, null, '{GM}',
 'افتح المعاملة الحكومية', '/admin/gov?overdue=1'),

('N-16','مزامنة البصمة فاشلة يومين', $q$
select 'biometric' as entity_ref, max(r.finished_at) as last_success
from platform.integration_runs r
where r.integration = 'biometric' and r.status = 'success'
having coalesce(max(r.finished_at), '-infinity'::timestamptz) < now() - interval '48 hours'
$q$, '{SYSADMIN}', '{in_app,whatsapp}', 'realtime', 24, true, 72, '{GM}',
 'افتح لوحة التكاملات', '/platform/integrations'),

('N-17','طلب اعتماد بلا بتّ > مهلته', $q$
select ar.doc_no as entity_ref, ar.request_type, ar.amount, ar.due_at
from admin.approval_requests ar
where ar.status = 'pending' and ar.due_at is not null and ar.due_at < now()
$q$, '{GM,CFO,WH_MGR,DEL_MGR,SALES_MGR,FLEET_MGR}', '{in_app,email}', '0 8 * * *', 24, true, 24, '{GM}',
 'ابتّ في الاعتماد', '/inbox?kind=approval'),

('N-18','مجال بيانات تحت هدفه شهرين', $q$
select o.domain_code as entity_ref, o.owner_role, min(q.score_pct) as worst_pct
from platform.domain_owners o
join platform.domain_quality_monthly q on q.domain_code = o.domain_code
where q.month >= (date_trunc('month', current_date) - interval '2 months')::date
  and q.score_pct < coalesce(o.gate_target_pct, 80)
group by o.domain_code, o.owner_role
having count(distinct q.month) >= 2
$q$, '{GM}', '{in_app,email}', '0 8 1 * *', 720, true, null, null,
 'افتح بطاقة جودة البيانات', '/platform/data-quality'),

-- ─── v4 · مضافة من وثيقة 23 §4 (PLT-12 · R-07) ───

('N-19','طابور المعالجة اليدوية > ٢٠ سجلاً أو عمر > ٤٨ ساعة', $q$
select q.integration as entity_ref, count(*) as pending_rows, min(q.created_at) as oldest
from platform.integration_queue q
where q.status = 'pending'
group by q.integration
having count(*) > 20 or min(q.created_at) < now() - interval '48 hours'
$q$, '{SYSADMIN,DEL_MGR,FLEET_MGR,CFO}', '{in_app,email}', 'realtime', 6, true, 72, '{SYSADMIN,GM}',
 'افتح الطابور اليدوي', '/platform/integrations/queue'),

('N-20','رسائل واتساب مرتدّة > ٥٪ في ٢٤ ساعة', $q$
select 'whatsapp' as entity_ref,
       round(100.0 * (sum(r.records_in) - sum(r.records_out))
             / nullif(sum(r.records_in),0), 2) as bounce_pct
from platform.integration_runs r
where r.integration = 'whatsapp' and r.started_at >= now() - interval '24 hours'
having round(100.0 * (sum(r.records_in) - sum(r.records_out))
             / nullif(sum(r.records_in),0), 2) > 5
$q$, '{SYSADMIN}', '{in_app,email}', '0 9 * * *', 24, true, null, '{GM}',
 'راجع قوالب الرسائل', '/platform/integrations?code=I-05'),

('N-21','مطابقة بنكية غير مكتملة > ٧ أيام', $q$
select rc.doc_no as entity_ref, rc.received_at, rc.amount, rc.bank_ref
from billing.receipts rc
where rc.reconciled_at is null and rc.received_at < current_date - 7
$q$, '{CFO}', '{in_app,email}', '0 8 * * *', 24, true, 168, '{GM}',
 'افتح المطابقة البنكية', '/billing/bank-reconciliation'),

('N-22','تكامل بلا تشغيل ناجح ٢٤ ساعة', $q$
select c.code as entity_ref, c.name_ar, max(r.finished_at) as last_success
from platform.integration_config c
left join platform.integration_runs r
       on r.integration_code = c.code and r.status = 'success'
where c.is_active
group by c.code, c.name_ar
having coalesce(max(r.finished_at), '-infinity'::timestamptz) < now() - interval '24 hours'
$q$, '{SYSADMIN}', '{in_app,email}', 'realtime', 12, true, 48, '{GM}',
 'افتح لوحة التكاملات', '/platform/integrations')

on conflict (code) do nothing;
-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-22 · أمن مستوى الصف الشامل — حارس G7 = 0 (40 Part F v4 · ق-13)
--
--   40 Part F: «"Operational table" for G7 means **any base table** in the
--   fourteen business schemas. Fixed reference tables and system logs are not
--   exempt by category: where a table has no entity_id, RLS is still enabled
--   and the policy is written against the access rule that applies to it
--   (internal-only, owner-role-only, or unrestricted read).»
--
--   ثلاثة أنماط (ق-13):
--     ① entity_scope   — كل جدول يحمل entity_id (null مسموح = صفّ على مستوى المجموعة)
--     ② internal_only  — جداول تشغيلية/نظامية بلا entity_id: الداخلي فقط
--     ③ reference_read — بيانات مرجعية عامة: قراءة للداخلي · كتابة بصلاحية
--
--   الكتلة أدناه تمشي على كل جدول أساسي في المخططات الأربعة عشر وتطبّق النمط
--   المناسب آلياً — فلا يبقى جدول بلا RLS مهما أُضيف لاحقاً في 01 أو 13 أو هنا.
--   الجداول التي أنشأت لها المرحلة الأولى سياسة صريحة تُترك كما هي (القفزة على
--   pg_policies تمنع التكرار).
-- ═══════════════════════════════════════════════════════════════════════════

-- الجداول المرجعية العامة: يقرؤها كل داخلي، ويكتبها صاحب الصلاحية (النمط ③)
create or replace function platform.is_reference_table(p_schema text, p_table text)
returns boolean language sql immutable as $$
  select (p_schema || '.' || p_table) = any (array[
    'catalog.service_categories','catalog.services','catalog.segments',
    'platform.thresholds','platform.feature_flags','platform.automation_rules',
    'platform.alert_rules','platform.integration_config','platform.domain_owners',
    'platform.approval_chains','platform.document_templates','platform.document_bindings',
    'platform.counters','platform.settings',
    'identity.roles','identity.permissions','identity.role_permissions',
    'identity.sod_rules','identity.column_classification',
    'hr.penalty_schedule','hr.recruitment_stages','hr.org_units','hr.teams',
    'tms.failure_reasons','tms.maintenance_plans',
    'imile.coverage_areas','wms.warehouses','wms.zones','wms.locations',
    'billing.gl_accounts'
  ])
$$;

do $$
declare
  r record;
  v_has_entity boolean;
  v_nullable   boolean;
begin
  for r in
    select n.nspname as sch, c.relname as tab
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p')   -- D-002 / SCR-RLS-02: الأب المُقسَّم أيضاً — سياسة الأب هي التي تحكم القراءة عبره
      and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc',
                        'billing','hr','partners','admin','housing','imile','governance')
    order by 1,2
  loop
    -- ① تفعيل RLS على كل جدول أساسي (أقسام audit_log وأبوها ضمناً — الوراثة لا تنقل relrowsecurity،
    --    وسياسة الأب المُقسَّم تُطبَّق على كل أقسامه تلقائياً؛ D-002)
    execute format('alter table %I.%I enable row level security', r.sch, r.tab);

    -- إن كانت للجدول سياسة قائمة (من 01 أو من المرحلة الأولى) فلا تُكرَّر
    if exists (select 1 from pg_policies p
                where p.schemaname = r.sch and p.tablename = r.tab) then
      continue;
    end if;

    select true, a.attnotnull = false
      into v_has_entity, v_nullable
      from pg_attribute a
      join pg_class c2 on c2.oid = a.attrelid
      join pg_namespace n2 on n2.oid = c2.relnamespace
     where n2.nspname = r.sch and c2.relname = r.tab
       and a.attname = 'entity_id' and a.attnum > 0 and not a.attisdropped;

    if platform.is_reference_table(r.sch, r.tab) then
      -- ③ مرجعي: قراءة لكل داخلي · كتابة بصلاحية إدارة البيانات المرجعية
      execute format(
        'create policy reference_read on %I.%I for select using (platform.is_internal())',
        r.sch, r.tab);
      execute format(
        'create policy reference_write on %I.%I for all to public '
        'using (platform.is_internal() and platform.has_perm(%L)) '
        'with check (platform.is_internal() and platform.has_perm(%L))',
        r.sch, r.tab, 'platform.reference.manage', 'platform.reference.manage');
    elsif coalesce(v_has_entity, false) then
      -- ① نطاق الكيان
      if coalesce(v_nullable, false) then
        execute format(
          'create policy entity_scope on %I.%I for all using '
          '(entity_id is null or entity_id = any(platform.allowed_entities())) '
          'with check (entity_id is null or entity_id = any(platform.allowed_entities()))',
          r.sch, r.tab);
      else
        execute format(
          'create policy entity_scope on %I.%I for all using '
          '(entity_id = any(platform.allowed_entities())) '
          'with check (entity_id = any(platform.allowed_entities()))',
          r.sch, r.tab);
      end if;
    else
      -- ② داخلي فقط
      execute format(
        'create policy internal_only on %I.%I for all using (platform.is_internal())',
        r.sch, r.tab);
    end if;
  end loop;
end $$;

-- v4 · صلاحية إدارة البيانات المرجعية — يشير إليها نمط ③ أعلاه
insert into identity.permissions (code, module, object, action, description) values
 ('platform.reference.manage','platform','reference','update','تحرير البيانات المرجعية العامة: الكتالوج · العتبات · الأعلام · قواعد التنبيه · اللوائح')
on conflict (code) do nothing;

-- v4 ق-13 · `force row level security` حيث يفرض 40 §B2/§C6 ألا يتجاوزها المالك
alter table platform.audit_log     force row level security;
alter table platform.outbox        force row level security;
alter table billing.invoices       force row level security;
alter table billing.journal_entries force row level security;
alter table billing.journal_lines  force row level security;
do $$
declare r record;
begin
  for r in select c.relname from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'platform' and c.relkind = 'r'
             and c.relname like 'audit_log_%'
  loop
    execute format('alter table platform.%I force row level security', r.relname);
  end loop;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد تطبيق المرحلة الثانية
-- ═══════════════════════════════════════════════════════════════════════════
--   select count(*) from catalog.services;                -- 92
--   select count(*) from hr.penalty_schedule;             -- 77 (ق-14 · SCH-3)
--   select count(*) from hr.penalty_schedule where is_fraud;  -- 8
--   select count(*) from hr.recruitment_stages;           -- 17
--   select count(*) from tms.failure_reasons;             -- 32 (7 + 25)
--   select count(*) from tms.failure_reasons where counts_against_driver;  -- 3
--   select count(*) from platform.alert_rules;            -- 22
--   select count(*) from platform.thresholds;             -- 16 (ADR-27) + 28 = 44
--   select count(*) from pg_constraint where conname like 'chk\_%';  -- قيود الحالات
--   -- G7: يجب أن يعيد صفراً
--   select count(*) from pg_class t join pg_namespace n on n.oid=t.relnamespace
--    where t.relkind in ('r','p') and n.nspname in ('platform','identity','catalog','sales','wms',
--      'tms','cc','billing','hr','partners','admin','housing','imile','governance')
--      and not t.relrowsecurity;
--   -- ثم يُطبَّق 019-Warehouse-WH1-Setup.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ما بقي مهمةً للـ WBS بعد SCH-2
-- ═══════════════════════════════════════════════════════════════════════════
--   0.16 · تصنيف كل عمود في identity.column_classification (حارس G6) —
--          العرض identity.unclassified_columns يسرد المتبقي.
--   0.18 · [نُفِّذ 2026-09-23 — D-002: SCR-RLS-01 (entity_scope مقيَّدة بـ is_internal على سبعة
--          جداول + قيد التنافي في identity) و SCR-RLS-02 (RLS على أب audit_log، G7 يشمل 'p') —
--          الترحيل 0003] مراجعة سياسات RLS المولَّدة آلياً في 13B-22: النمط صحيح، لكن بعض
--          الجداول تحتاج سياسة عميل (client_portal_scope) أو سياسة دور أضيق.
--   ·     · بذر platform.domain_owners للمجالات D01–D12 من 22 §2.
--   ·     · بذر platform.integration_config بـ I-01…I-11 من 23 §1 (PLT N-5)
--          — الأعمدة جاهزة، والقائمة بيانات مرجعية لا DDL.
--   ·     · بذر imile.coverage_areas ميدانياً (07 §10 بند 6) — لا تُخترع مناطق.
--   ·     · مهمة مجدولة تنشئ قسم audit_log الشهري المقبل قبل بدايته — مع فهرس chain_seq الفريد
--          وRLS (enable + force + entity_scope) وتصنيف الأعمدة (v4.3 · ADR-0002؛ G6 · G7 · G8).
-- ═══════════════════════════════════════════════════════════════════════════

-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  المرحلة الرابعة (SCH-4) — إغلاق فجوات خرائط النظام (D-blueprints)      ║
-- ║  21/09/2026 · المصدر: §13 «فجوات مرصودة» في D-blueprints/01…07 ·        ║
-- ║           36 §6-2 · 40 §C9 (موديول الحوكمة M13) · 40 §C5 + S5 ·         ║
-- ║           22 §2 · 11 §6-1 · 09 §7-1 · 14 §2 · 17 §3 · 29 §5-5 · 35 §8-3 ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- سجل قرارات SCH-4 (يُقرأ مع ق-1…ق-18 أعلاه)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-19 · `wms.occupancy_snapshots`: القيد الفريد كان `(snapshot_date, client_id,
--        warehouse_id)` فيمنع العميل الواحد من إشغال أكثر من كتلة في اليوم نفسه،
--        ويُبطل تصحيح OPS-59 لأن `space_availability()` و`space_dashboard`
--        يجمعان بـ`space_block_id`. 17 §3 ينص: «صفاً لكل (تاريخ × كيان × عميل ×
--        مستودع × **كتلة**)». يُستبدل بقيد يشمل `entity_id` و`space_block_id`.
--        (blueprint 03 §13 بند 2)
--
-- ق-20 · سلاسل الترقيم: سبعة جداول تحمل `doc_no not null` بلا سلسلة في
--        `platform.counters`، فأي إدراج فيها يفشل بـ«عدّاد غير معرّف» من
--        `platform.next_doc_no` نفسها. تُبذر بأكواد على أسلوب 01/13
--        (`doc_type` ثلاثي · `prefix` حرفان أو ثلاثة):
--          MNT ← tms.maintenance_orders      ACC ← tms.accidents
--          RCR ← hr.recruitment_cases        DSC ← hr.disciplinary_cases
--          HMR ← housing.maintenance_requests HIN ← housing.inspections
--          DOC ← platform.documents  **v4 (استنباط)** — 40 §B4 لا يسمّي سلسلة
--          للمستند المولَّد، لكن العمود `not null` بتفرّد `(entity_id, doc_no)`.
--        (blueprint 04 §13 بند 5)
--
-- ق-21 · `admin.gov_transactions.fee_voucher_no`: إلزامي بنصّ 11 §6-1 كرقم سند
--        من سلسلة `GOV`، وغير موجود. بدونه «عهدة الرسوم بلا رقم سند» —
--        وهو الضابط التعويضي الوحيد لتجميع `PRO = ACCOUNTANT` (DECISIONS §3).
--        يُضاف مع قيد يفصل سلسلتي `GOV` و`RCT`. (blueprint 02 §13-2 بند 4)
--
-- ق-22 · `trg_no_holding_invoice` كان `before insert` وحده، فتحويل
--        `invoice_type` من `intercompany` إلى `standard` **بعد** الإدراج يلتفّ
--        على منع الفوترة على القابضة. يُعاد إنشاؤه
--        `before insert or update of invoice_type, entity_id`.
--        (blueprint 02 §13-2 بند 10)
--
-- ق-23 · `identity.check_sod()` كان على `user_roles` وحده، فالإنابة تلتفّ على
--        أزواج SoD الأربعة. 22 §2-3 و EXEC §1.6 (ADR-16c): «الإنابة لا تلتفّ
--        على فصل المهام — الفحص نفسه يُطبَّق على `identity.delegations`».
--        تُضاف دالة `identity.check_sod_delegation()` ومشغّلها.
--        (blueprint 02 §13-2 بند 11)
--
-- ق-24 · `housing.beds.status`: 14 §2 سطر 48 ينص على أن الحالة «تخدم الخارج عن
--        الخدمة (`maintenance`/`blocked`)»، و`capacity_overview` في 14 §6 يقرأ
--        `in ('maintenance','blocked')`. فالقيمة `blocked` **منصوصة** —
--        يُوسَّع القيد ليقبلها بدل حذف الفرع من العرض.
--        (البريف بند 7 · blueprint 06)
--
-- ق-25 · عزل طوابير الكول سنتر (40 §C5 «RLS on `queue_id`» · S5): سياسات `cc`
--        اليوم `entity_scope` و`internal_only` فقط، فوكيل العيادة يرى تذاكر
--        المتجر. تُضاف سياسة **`as restrictive`** — لأن السياسات المسموحة
--        تُجمع بـOR فتوسّع لا تضيّق — تقصر الوكيل على طوابيره المسنَدة، وتترك
--        غير الوكلاء (المديرين) على نطاق الكيان. الدالتان المساعدتان
--        `security definer` لتقرآ `cc.agents`/`agent_queues` بلا ارتداد RLS.
--        (blueprint 05 §13 بند 2 — «S5 يفشل كما هي القاعدة»)
--
-- ق-26 · `hr.check_penalty_authority` البند 1 (سلسلة الإشراف): كان المشغّل
--        ينفّذ البنود 2–6 ولا يتحقق أن الموظَّف المعاقَب يقع في سلسلة
--        `reports_to` الصاعدة من الموقّع. يُضاف الفحص: خارجها ⇒ `routed_to` =
--        أقرب مدير مشترك و`status = 'pending_authority'` (ADM §4-2 بند 1).
--
-- ق-27 · مخطط `governance` (M13): 36 §6-2 و40 §C9 يسمّيان **أربعة عشر جدولاً**
--        بالاسم. تُنشأ كلها بأعمدة من نصّ الوثيقتين؛ وما لزم تقنياً ولم يُذكر
--        نصاً معلَّم `-- v4 (استنباط)`. **لا جدول خارج الأربعة عشر.**
--        `governance.decisions` هو «سجل القرارات المركزي» (36 §6-2) وهو غير
--        `platform.decisions` (صندوق قرارات التشغيل اليومي — 40 §B5):
--        الأول سجل حوكمة دائم، والثاني بند عمل يختفي بالبتّ.
--
-- ق-28 · `partners.partner_invoices.variance_pct`: كان عموداً حرّاً بينما
--        `variance_amount` مولَّد — فالنسبة التي تقرّر التجميد عند 2% قابلة
--        للكتابة يدوياً. يُحوَّل إلى عمود مولَّد. (blueprint 02 §13-2 بند 16)
--
-- ق-29 · `billing.profitability`: 09 §6 و11 §9 و14 §6-2 وEXEC §1.3 تجعل تكلفة
--        الشريك والسكن والاستقدام **بنوداً مستقلة**، وكلها تنزل اليوم في
--        `cost_other` بلا تمييز. تُضاف الأعمدة الثلاثة ويبقى `cost_other`
--        متبقّياً. (blueprint 02 §13-2 بند 13)
--
-- ق-30 · بذرة `platform.domain_owners`: 22 §2 يسرد المجالات الاثني عشر بمالك
--        لكلٍّ وببوابة — فالبذر ممكن بلا اختراع. تعارض 22 الداخلي في
--        D03·D04·D05·D11 (§2 يقول «المدير المالي» و§2-1 يسندها لمدير المبيعات)
--        يُحسم على **`CFO` مالكاً** — وهو ما يقوله §2 وهو الجدول الحاكم،
--        ويتسق مع زوج SoD `(SALES_MGR, CFO)`. مسجَّل في «يحتاج قرار GM».
--
-- ق-31 · بذرة `platform.approval_chains`: الحدود محسومة رقمياً في EXEC §1.1
--        (≤ 100 آلي · 100–500 مدير القسم · 500–2,000 CFO · > 2,000 GM) وسقف
--        الفاتورة 500 والإشعار الدائن GM حصراً — فالسلاسل تُبذر منها مباشرةً.
--
-- ق-32 · بذرة `platform.automation_rules`: 29 §5-5 يسرد **تسع** عمليات تبقى
--        بشرية عمداً (لا ستاً كما تقول خرائط 01 و07) — تُبذر التسع بمستوى
--        **A1** بأسمائها كما وردت. الفارق 9/6 في «يحتاج قرار GM».
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-23 · إصلاحات مرصودة في القاعدة الحيّة
-- ═══════════════════════════════════════════════════════════════════════════

-- ق-19 · المصدر: 17 §3 — صفّ لكل (تاريخ × كيان × عميل × مستودع × كتلة)
alter table wms.occupancy_snapshots
  drop constraint if exists occupancy_snapshots_snapshot_date_client_id_warehouse_id_key;
do $$ begin
  alter table wms.occupancy_snapshots
    add constraint occupancy_snapshots_grain_uq
    unique (snapshot_date, entity_id, client_id, warehouse_id, space_block_id);
exception when duplicate_object then null; end $$;
comment on constraint occupancy_snapshots_grain_uq on wms.occupancy_snapshots is
  '17 §3: حبيبة اللقطة اليومية 00:30. القيد السابق كان يمنع العميل من إشغال كتلتين في اليوم نفسه (SCH-4 ق-19)';

-- ق-20 · المصدر: blueprint 04 §13 بند 5 — سلاسل ترقيم مفقودة
insert into platform.counters (entity_id, doc_type, period, prefix, padding)
select e.id, d.doc_type, 'ALL', e.code || '-' || d.prefix || '-', 5
from platform.entities e
cross join (values
  ('MNT','MN'),   -- tms.maintenance_orders        (27 §1)
  ('ACC','AC'),   -- tms.accidents                 (27 §2)
  ('RCR','RQ'),   -- hr.recruitment_cases          (10 §4) — RC مأخوذة لسلسلة RCT
  ('DSC','DS'),   -- hr.disciplinary_cases         (15 §6)
  ('HMR','HM'),   -- housing.maintenance_requests  (14 §2)
  ('HIN','HI'),   -- housing.inspections           (14 §2)
  ('DOC','DC')    -- platform.documents — v4 (استنباط): 40 §B4 لا يسمّي سلسلة
) as d(doc_type, prefix)
on conflict do nothing;

-- ق-21 · المصدر: 11 §6-1 — سند صرف الرسوم الحكومية من سلسلة GOV
alter table admin.gov_transactions add column if not exists fee_voucher_no text;
comment on column admin.gov_transactions.fee_voucher_no is
  '11 §6-1: رقم سند صرف الرسوم من سلسلة GOV — منفصلة عن RCT (إيصالات القبض). '
  'الضابط التعويضي لتجميع PRO = ACCOUNTANT (DECISIONS §3): CFO يطابق التيارين';
do $$ begin
  alter table admin.gov_transactions add constraint chk_gov_voucher_series
    check (fee_voucher_no is null or fee_voucher_no ~ '-GV-[0-9]+$');
exception when duplicate_object then null; end $$;
-- v4 (استنباط تقني): الرسوم المدفوعة تستوجب سنداً — يُفرض عند الإقفال لا عند الإنشاء
do $$ begin
  alter table admin.gov_transactions add constraint chk_gov_fees_need_voucher
    check (completed_at is null or coalesce(fees_paid,0) = 0 or fee_voucher_no is not null);
exception when duplicate_object then null; end $$;
create index if not exists gov_transactions_voucher_idx
  on admin.gov_transactions (fee_voucher_no) where fee_voucher_no is not null;

-- ق-22 · المصدر: blueprint 02 §13-2 بند 10 — الالتفاف بالتحديث بعد الإدراج
drop trigger if exists trg_no_holding_invoice on billing.invoices;
create trigger trg_no_holding_invoice
  before insert or update of invoice_type, entity_id on billing.invoices
  for each row execute function billing.reject_holding_invoice();

-- ق-23 · المصدر: 22 §2-3 · EXEC §1.6 (ADR-16c) — الإنابة لا تتجاوز SoD
create or replace function identity.check_sod_delegation()
returns trigger language plpgsql as $$
begin
  -- الدور المُناب به يخالف دوراً قائماً للمُناب إليه؟
  if exists (
    select 1
    from identity.user_roles ur
    join identity.roles r on r.id = ur.role_id
    join identity.sod_rules s
      on (s.role_a = r.code and s.role_b = new.role_code)
      or (s.role_b = r.code and s.role_a = new.role_code)
    where ur.user_id = new.to_user_id and ur.revoked_at is null and s.is_active
  ) then
    raise exception 'الإنابة تخالف قاعدة فصل المهام: الدور % يتعارض مع دور قائم للمُناب إليه (ADR-16c)',
      new.role_code;
  end if;

  -- أو يخالف إنابة سارية أخرى إلى الشخص نفسه؟
  if exists (
    select 1
    from identity.delegations d
    join identity.sod_rules s
      on (s.role_a = d.role_code and s.role_b = new.role_code)
      or (s.role_b = d.role_code and s.role_a = new.role_code)
    where d.to_user_id = new.to_user_id
      and d.id is distinct from new.id
      and s.is_active
      and tstzrange(d.valid_from, d.valid_to) && tstzrange(new.valid_from, new.valid_to)
  ) then
    raise exception 'الإنابة تخالف قاعدة فصل المهام: تعارض مع إنابة سارية أخرى (ADR-16c)';
  end if;

  return new;
end $$;
comment on function identity.check_sod_delegation is
  '22 §2-3 · ADR-16c: «الإنابة لا تلتفّ على فصل المهام — الفحص نفسه يُطبَّق على identity.delegations»';

drop trigger if exists trg_sod_delegation on identity.delegations;
create trigger trg_sod_delegation
  before insert or update of to_user_id, role_code, valid_from, valid_to
  on identity.delegations
  for each row execute function identity.check_sod_delegation();

-- ق-24 · المصدر: 14 §2 سطر 48 — الحالة تخدم الخارج عن الخدمة (maintenance/blocked)
alter table housing.beds drop constraint if exists chk_beds_status;
alter table housing.beds add constraint chk_beds_status
  check (status = any (array['available','occupied','reserved','maintenance','blocked']));

-- ق-26 · المصدر: ADM §4-2 بند 1 — سلسلة الإشراف
create or replace function hr.check_penalty_authority()
returns trigger language plpgsql as $$
declare
  v_cap int;
  v_target uuid;
  v_in_chain boolean;
begin
  if new.signed_by is null or new.signer_role is null then
    return new;                                   -- مسودة قبل التوقيع — لا فحص
  end if;

  -- بند 1 (SCH-4 ق-26): الموظَّف المعاقَب يجب أن يقع في سلسلة reports_to
  --   الصاعدة من الموقّع — أو أن يكون الموقّع GM.
  if new.signer_role = 'GM' then
    v_in_chain := true;
  else
    with recursive up as (
      select e.id, e.reports_to, 1 as depth
      from hr.employees e where e.id = new.employee_id
      union all
      select e.id, e.reports_to, u.depth + 1
      from hr.employees e join up u on e.id = u.reports_to
      where u.depth < 10
    )
    select exists (select 1 from up where up.id = new.signed_by and up.depth > 1)
      into v_in_chain;
  end if;

  v_cap := hr.max_degree_for_role(new.signer_role);

  -- بند 3: الفصل (أو الدرجة الرابعة) للمدير العام حصراً
  if (new.penalty_type = 'dismissal' or new.applied_degree = 4)
     and new.signer_role <> 'GM' then
    v_cap := least(v_cap, 3);
  end if;

  if not v_in_chain or new.applied_degree > v_cap then
    -- بند 4: لا يُرفض الصفّ — يُحال آلياً لأقرب مخوَّل في سلسلة reports_to الصاعدة
    with recursive chain as (
      select e.id, e.reports_to, 1 as depth
      from hr.employees e where e.id = new.employee_id
      union all
      select e.id, e.reports_to, c.depth + 1
      from hr.employees e join chain c on e.id = c.reports_to
      where c.depth < 10
    )
    select c.id into v_target
    from chain c
    join hr.employees em on em.id = c.id
    join identity.users u on u.employee_id = em.id
    join identity.user_roles ur on ur.user_id = u.id and ur.revoked_at is null
    join identity.roles r on r.id = ur.role_id
    where hr.max_degree_for_role(r.code) >= new.applied_degree
      and c.depth > 1
    order by c.depth
    limit 1;

    new.routed_to := v_target;
    new.routed_reason := case
      when not v_in_chain then format(
        'الموقّع (%s) خارج سلسلة الإشراف الصاعدة للموظَّف. أُحيلت آلياً للمدير المخوَّل — 15 §3 · ADM §4-2 بند 1',
        new.signer_role)
      else format(
        'الدرجة %s تتجاوز سقف الدور %s (%s). أُحيلت آلياً للمستوى المخوَّل — 15 §3',
        new.applied_degree, new.signer_role, v_cap)
    end;
    new.status := 'pending_authority';
  elsif new.status = 'draft' then
    new.status := 'signed';
  end if;

  -- بند 5: التظلّم يبتّه مستوى أعلى من الموقّع
  if new.grievance_decided_by is not null and new.grievance_decided_by = new.signed_by then
    raise exception 'التظلّم يبتّه مستوى أعلى من الموقّع (15 §3)';
  end if;

  return new;
end $$;

-- ق-28 · المصدر: blueprint 02 §13-2 بند 16 — النسبة مولَّدة لا حرّة
do $$
declare v_expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into v_expr
  from pg_attrdef d
  join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = 'partners.partner_invoices'::regclass and a.attname = 'variance_amount';

  if v_expr is not null then
    -- variance_amount مولَّد ⇒ variance_pct يُولَّد بالنسبة نفسها
    alter table partners.partner_invoices drop column if exists variance_pct;
    alter table partners.partner_invoices
      add column variance_pct numeric(8,4)
      generated always as (
        case when coalesce(matched_amount,0) = 0 then null
             else round(100.0 * (claimed_amount - matched_amount) / matched_amount, 4)
        end) stored;
    comment on column partners.partner_invoices.variance_pct is
      'SCH-4 ق-28: مولَّد بنفس أساس variance_amount (claimed − matched). '
      'كان عموداً حرّاً فالنسبة التي تقرّر التجميد عند partner.match_tolerance_pct = 2 قابلة للكتابة يدوياً';
  end if;
end $$;

-- ق-29 · المصدر: 09 §6 · 11 §9 · 14 §6-2 · EXEC §1.3 — بنود تكلفة مستقلة
alter table billing.profitability add column if not exists cost_partner     numeric(14,3) not null default 0;
alter table billing.profitability add column if not exists cost_housing     numeric(14,3) not null default 0;
alter table billing.profitability add column if not exists cost_recruitment numeric(14,3) not null default 0;
-- v4 SCH-4 ق-29 (تصحيح): العمود المولَّد margin في 01 لا يطرح الأعمدة الثلاثة الجديدة ⇒ يُعاد تعريفه
alter table billing.profitability drop column if exists margin;
alter table billing.profitability add column margin numeric(14,3) generated always as (
  revenue - cost_labour - cost_fuel - cost_space - cost_vehicle - cost_other
          - cost_partner - cost_housing - cost_recruitment - sla_penalty
) stored;
comment on column billing.profitability.cost_other is
  'المتبقّي بعد فصل cost_partner و cost_housing و cost_recruitment (SCH-4 ق-29)';

-- المصدر: 09 §7-1 «أعمدة يُضيفها v4»
alter table partners.partner_contracts add column if not exists liability_basis   text;
alter table partners.partner_contracts add column if not exists liability_calc_at date;
do $$ begin
  alter table partners.partner_contracts add constraint chk_liability_basis
    check (liability_basis is null or liability_basis = any (array['3x_monthly','contract_value']));
exception when duplicate_object then null; end $$;
comment on column partners.partner_contracts.liability_basis is
  '09 §7-1: الأساس الذي حُسب منه liability_cap — min(3 × الفوترة الشهرية، قيمة العقد) في EXEC §1.1';

-- المصدر: EXEC §1.7 — HOUSING_SUP يقرأ من hr.employees الكود والاسم والوحدة فقط
create or replace view hr.employees_basic as
select e.id, e.entity_id, e.code, e.name_ar, e.org_unit_id
from hr.employees e
where e.status = 'active';
comment on view hr.employees_basic is
  'EXEC §1.7: «HOUSING_SUP … hr.employees read code/name/unit; no payroll/commercial». '
  'ثلاثة أعمدة فقط زائد المفاتيح — لا راتب ولا مدني ولا جواز ولا هاتف';


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-24 · قيود الأعمدة التعدادية (blueprint 03 §13 بند 3 · 04 §13 بند 7 ·
--          05 §13 بنود 5 و6 · 07 §13 GC-09) — بالقيم المنصوصة حصراً
-- ═══════════════════════════════════════════════════════════════════════════

-- المصدر: 01:685 وتعليقات 01 · 19 §4 (blueprint 03 §13 بند 3)
do $$ begin
  alter table wms.stock_movements add constraint chk_stock_movements_type
    check (movement_type = any (array['receipt','putaway','pick','pack','ship','issue','transfer','adjust','count','damage','return','scrap']));
  -- v4 (تصحيح بعد D-10 §6-7): اتحاد قائمة تعليق 01 (issue · damage) وقيمتي دورة الصرف (pack · ship)
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.locations add constraint chk_locations_type
    check (location_type = any (array['pallet','shelf','operational','structural']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.zones add constraint chk_zones_type
    check (zone_type = any (array['storage','receiving','quarantine','staging','shipping',
                                  'returns','damaged','structural']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_blocks add constraint chk_space_blocks_type
    check (block_type = any (array['pallet_rack','shelf','floor','mezzanine','yard',
                                   'cold','frozen','secure','hazmat']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_allocations add constraint chk_space_allocations_type
    check (alloc_type = any (array['dedicated','shared','overflow']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.skus add constraint chk_skus_picking_policy
    check (picking_policy is null or picking_policy = any (array['FIFO','FEFO','LIFO']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_reservations add constraint chk_space_reservations_reason
    check (reason = any (array['quote_pending','incoming_client','seasonal_peak','internal']));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table wms.space_blocks_out_of_service add constraint chk_space_oos_reason
    check (reason = any (array['maintenance','damage','aisle','operational_buffer','safety']));
exception when duplicate_object then null; end $$;

-- المصدر: 35 §4 · 40 §C4 — نوع استثناء التوصيل يولّد حدث الفوترة DL-13
-- v4 (استنباط): القائمة من أنواع الاستثناء المذكورة في 27 §4 و35 §4 و40 §C4
do $$ begin
  alter table tms.delivery_exceptions add constraint chk_delivery_exceptions_type
    check (exception_type = any (array['waiting_time','failed_attempt','damage','shortage',
                                       'wrong_address','refused','return','other']));
exception when duplicate_object then null; end $$;

-- المصدر: 10 §17 — الفئات الأربع لإيقاف المعرّف (blueprint 05 §13 بند 5)
do $$ begin
  alter table imile.driver_ids add constraint chk_driver_ids_suspension_category
    check (suspension_category is null
           or suspension_category = any (array['administrative','performance','conduct','permanent_ban']));
exception when duplicate_object then null; end $$;
comment on column imile.driver_ids.suspension_category is
  '10 §17: إداري · أداء · سلوكي · محظور نهائياً. القيمة conduct تمنع إعادة التخصيص نهائياً (S16)';

-- المصدر: 40 §C5 — عاجل 15 د · عالٍ ساعة · عادي 4 ساعات (blueprint 05 §13 بند 6)
do $$ begin
  alter table cc.tickets add constraint chk_tickets_priority
    check (priority = any (array['urgent','high','normal','low']));
exception when duplicate_object then null; end $$;

-- المصدر: 29 §8 · 40 §B5 (blueprint 07 §13 GC-09)
do $$ begin
  alter table platform.automation_rules add constraint chk_automation_rules_level
    check (level = any (array['A0','A1','A2','A3']));
exception when duplicate_object then null; end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-25 · عزل طوابير الكول سنتر — S5 (40 §C5 · ق-25)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function cc.is_agent() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from cc.agents a where a.user_id = platform.current_user_id())
$$;

create or replace function cc.current_agent_queues() returns uuid[]
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(array_agg(distinct aq.queue_id), '{}')
  from cc.agents a
  join cc.agent_queues aq on aq.agent_id = a.id
  where a.user_id = platform.current_user_id()
$$;
comment on function cc.current_agent_queues is
  '40 §C5: «agent sees only assigned queues (RLS on queue_id)». security definer لتقرأ '
  'cc.agents و agent_queues بلا ارتداد على سياساتهما';

-- ⚠️ `as restrictive` لا `permissive`: السياسات المسموحة تُجمع بـOR فتوسّع؛
--    والمطلوب تضييق ما يراه الوكيل داخل نطاق كيانه.
--    غير الوكلاء (المديرون · SYSADMIN) لا يتأثرون — الشرط الأول يصدق لهم.
drop policy if exists agent_queue_scope on cc.tickets;
create policy agent_queue_scope on cc.tickets as restrictive for all
  using (not cc.is_agent() or queue_id = any (cc.current_agent_queues()));

drop policy if exists agent_queue_scope on cc.calls;
create policy agent_queue_scope on cc.calls as restrictive for all
  using (not cc.is_agent() or queue_id = any (cc.current_agent_queues()));

drop policy if exists agent_queue_scope on cc.queues;
create policy agent_queue_scope on cc.queues as restrictive for all
  using (not cc.is_agent() or id = any (cc.current_agent_queues()));

drop policy if exists agent_queue_scope on cc.ticket_events;
create policy agent_queue_scope on cc.ticket_events as restrictive for all
  using (not cc.is_agent()
         or exists (select 1 from cc.tickets t
                     where t.id = ticket_id
                       and t.queue_id = any (cc.current_agent_queues())));


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-26 · موديول الحوكمة M13 — مخطط `governance` (ق-27)
--   المصدر: 36 §6-2 (الجدول: القدرة · الوصف · التصميم) · 40 §C9 (قائمة الجداول)
--   أربعة عشر جدولاً بالاسم — لا واحد خارجها.
--   كل عمود إما مذكور نصاً في الوثيقتين أو معلَّم `-- v4 (استنباط)`.
--   الحارسان G6 و G7 يسمّيان `governance` ضمن المخططات الأربعة عشر (40 Part F).
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists governance;

-- ── الموازنة والانحراف ─────────────────────────────────────────────────────
-- 36 §6-2: «موازنة سنوية لكل كيان ومركز تكلفة · الفعلي مقابل المخطط شهرياً»
create table governance.budgets (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  fiscal_year int  not null,
  cost_center text,                                  -- «لكل كيان ومركز تكلفة»
  status      text not null default 'draft',         -- v4 (استنباط): دورة اعتماد الموازنة
  approved_by uuid, approved_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (entity_id, fiscal_year, cost_center)
);

-- 40 §C9: «budget_lines (variance computed monthly)»
create table governance.budget_lines (
  id              uuid primary key default gen_random_uuid(),
  budget_id       uuid not null references governance.budgets(id) on delete cascade,
  gl_account_id   uuid references billing.gl_accounts(id),
  month           date not null,                     -- «شهرياً»
  planned_amount  numeric(14,3) not null default 0,  -- المخطط
  actual_amount   numeric(14,3) not null default 0,  -- الفعلي
  -- «انحراف آلي» (36 §6-2) · «variance computed monthly» (40 §C9)
  variance_amount numeric(14,3) generated always as (actual_amount - planned_amount) stored,
  variance_pct    numeric(8,4)  generated always as (
                    case when planned_amount = 0 then null
                         else round(100.0 * (actual_amount - planned_amount) / planned_amount, 4)
                    end) stored,
  note            text,
  unique (budget_id, gl_account_id, month)
);
create index on governance.budget_lines (budget_id, month);

-- ── شجرة المؤشرات ──────────────────────────────────────────────────────────
-- 36 §6-2: «مؤشرات المجموعة ← الكيان ← الموديول · بمستهدفات وملّاك»
-- 40 §C9: «kpis (tree: group → entity → module)»
create table governance.kpis (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_ar     text not null, name_en text,
  level       text not null,                         -- group · entity · module
  parent_id   uuid references governance.kpis(id),   -- «شجرة»
  entity_id   uuid references platform.entities(id), -- للمستوى entity
  module      text,                                  -- للمستوى module
  owner_role  text references identity.roles(code),  -- «وملّاك»
  unit        text,                                  -- v4 (استنباط): وحدة القياس
  direction   text not null default 'higher_better', -- v4 (استنباط): اتجاه التحسّن
  source_query text,                                 -- v4 (استنباط): مصدر الفعلي
  is_active   boolean not null default true,
  constraint chk_kpis_level check (level = any (array['group','entity','module'])),
  constraint chk_kpis_direction check (direction = any (array['higher_better','lower_better']))
);

-- 36 §6-2: «بمستهدفات»
create table governance.kpi_targets (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       uuid not null references governance.kpis(id) on delete cascade,
  period_start date not null, period_end date not null,
  target_value numeric(14,3) not null,
  set_by       uuid, set_at timestamptz not null default now(),
  unique (kpi_id, period_start, period_end)
);

create table governance.kpi_actuals (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       uuid not null references governance.kpis(id) on delete cascade,
  period       date not null,
  actual_value numeric(14,3) not null,
  measured_at  timestamptz not null default now(),
  unique (kpi_id, period)
);

-- ── الأهداف OKR ────────────────────────────────────────────────────────────
-- 36 §6-2: «ربعية · قابلة للقياس · مربوطة بالمؤشرات»
create table governance.objectives (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid references platform.entities(id),
  code        text not null unique,
  title_ar    text not null,
  quarter     text not null,                         -- «ربعية» — 2026-Q4
  owner_role  text references identity.roles(code),
  status      text not null default 'draft',
  created_at  timestamptz not null default now(),
  constraint chk_objectives_status
    check (status = any (array['draft','active','achieved','missed','cancelled']))  -- v4 (استنباط)
);

create table governance.key_results (
  id           uuid primary key default gen_random_uuid(),
  objective_id uuid not null references governance.objectives(id) on delete cascade,
  title_ar     text not null,
  kpi_id       uuid references governance.kpis(id),  -- «مربوطة بالمؤشرات»
  baseline_value numeric(14,3),                      -- «قابلة للقياس»
  target_value   numeric(14,3) not null,
  current_value  numeric(14,3),
  progress_pct   numeric(5,2) generated always as (  -- v4 (استنباط)
                   case when target_value = baseline_value then null
                        else round(least(100, greatest(0,
                          100.0 * (coalesce(current_value, baseline_value, 0) - coalesce(baseline_value,0))
                          / nullif(target_value - coalesce(baseline_value,0), 0))), 2)
                   end) stored,
  updated_at   timestamptz not null default now()
);

-- ── سجل المخاطر ────────────────────────────────────────────────────────────
-- 36 §6-2: «المخاطر التشغيلية والمالية · الاحتمال والأثر · المعالجة · المالك»
create table governance.risks (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid references platform.entities(id),
  code          text not null unique,
  title_ar      text not null,
  category      text not null,                       -- «التشغيلية والمالية»
  likelihood    int  not null,                       -- «الاحتمال»
  impact        int  not null,                       -- «الأثر»
  score         int  generated always as (likelihood * impact) stored,  -- v4 (استنباط)
  treatment     text,                                -- «المعالجة»
  owner_role    text references identity.roles(code),-- «المالك»
  status        text not null default 'open',
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  constraint chk_risks_category
    check (category = any (array['operational','financial','legal','safety','technology','commercial'])),
  constraint chk_risks_status
    check (status = any (array['open','mitigating','accepted','closed'])),  -- v4 (استنباط)
  constraint chk_risks_scale check (likelihood between 1 and 5 and impact between 1 and 5)
);

create table governance.risk_reviews (
  id           uuid primary key default gen_random_uuid(),
  risk_id      uuid not null references governance.risks(id) on delete cascade,
  reviewed_at  timestamptz not null default now(),
  reviewed_by  uuid,
  likelihood   int, impact int,
  finding      text,
  next_review_date date
);
create index on governance.risk_reviews (risk_id, reviewed_at desc);

-- ── الجودة وعدم المطابقة ───────────────────────────────────────────────────
-- 36 §6-2: «تسجيل عدم المطابقة · التحقيق · الإجراء التصحيحي · التحقق»
create table governance.ncr (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  doc_no       text not null,
  title_ar     text not null,
  source       text,                                 -- v4 (استنباط): من أين رُصدت
  description  text not null,                        -- «تسجيل عدم المطابقة»
  investigation text,                                -- «التحقيق»
  root_cause   text,
  raised_by    uuid, raised_at timestamptz not null default now(),
  owner_role   text references identity.roles(code),
  status       text not null default 'open',
  closed_at    timestamptz,
  unique (entity_id, doc_no),
  constraint chk_ncr_status
    check (status = any (array['open','investigating','action_pending','verifying','closed']))  -- v4 (استنباط)
);

create table governance.corrective_actions (
  id           uuid primary key default gen_random_uuid(),
  ncr_id       uuid not null references governance.ncr(id) on delete cascade,
  action_ar    text not null,                        -- «الإجراء التصحيحي»
  owner_role   text references identity.roles(code),
  due_date     date,
  completed_at timestamptz,
  verified_by  uuid, verified_at timestamptz,        -- «التحقق»
  verification_note text,
  status       text not null default 'open',
  constraint chk_corrective_actions_status
    check (status = any (array['open','in_progress','done','verified','cancelled']))  -- v4 (استنباط)
);
create index on governance.corrective_actions (ncr_id, status);

-- ── سجل السياسات ───────────────────────────────────────────────────────────
-- 36 §6-2: «كل سياسة معتمدة · إصدارها · من قرأها ووقّع»
create table governance.policies (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  title_ar    text not null,
  version     int  not null default 1,               -- «إصدارها»
  body_url    text,
  effective_from date,
  approved_by uuid, approved_at timestamptz,         -- «معتمدة»
  requires_ack_roles text[],                         -- v4 (استنباط): من يلزمه التوقيع
  is_active   boolean not null default true,
  unique (code, version)
);

create table governance.policy_acknowledgements (
  id          uuid primary key default gen_random_uuid(),
  policy_id   uuid not null references governance.policies(id) on delete cascade,
  user_id     uuid not null references identity.users(id),
  acknowledged_at timestamptz not null default now(),  -- «من قرأها ووقّع»
  ip_address  inet,                                    -- v4 (استنباط): أثر التوقيع
  unique (policy_id, user_id)
);

-- ── سجل القرارات المركزي ───────────────────────────────────────────────────
-- 36 §6-2: «مركزي — كان موزّعاً في الوثائق» · 40 §C9: «decisions (central log)»
-- ق-27: غير platform.decisions (صندوق قرارات التشغيل اليومي — 40 §B5).
create table governance.decisions (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,                 -- ADR-27 · EXEC §1.1 …
  title_ar     text not null,
  decision_ar  text not null,
  rationale_ar text,
  decided_by   uuid, decided_at date not null,
  source_doc   text,                                 -- «كان موزّعاً في الوثائق»
  supersedes_id uuid references governance.decisions(id),  -- v4 (استنباط)
  status       text not null default 'active',
  constraint chk_gov_decisions_status
    check (status = any (array['active','superseded','revoked']))  -- v4 (استنباط)
);
comment on table governance.decisions is
  '36 §6-2 · 40 §C9: سجل القرارات المركزي الدائم. غير platform.decisions الذي هو '
  'صندوق قرارات التشغيل اليومي ويختفي بنده بالبتّ (40 §B5) — SCH-4 ق-27';

-- «حزمة الملّاك: تقرير شهري/ربعي مولَّد آلياً — من التقارير 13–24» (36 §6-2)
-- ⚠️ لا جدول لها: 40 §C9 يقول «board pack **generated from** reports R-13…R-24»
--    فهي مخرَج تقارير لا كيان مخزَّن. لا يُخترع جدول.


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-27 · سلاسل ترقيم الحوكمة + قيود حالة جداولها
-- ═══════════════════════════════════════════════════════════════════════════

-- governance.ncr.doc_no not null ⇒ يحتاج سلسلة (ق-20)
insert into platform.counters (entity_id, doc_type, period, prefix, padding)
select e.id, 'NCR', 'ALL', e.code || '-NC-', 5
from platform.entities e
on conflict do nothing;

do $$ begin
  alter table governance.budgets add constraint chk_budgets_status
    check (status = any (array['draft','approved','locked','closed']));  -- v4 (استنباط)
exception when duplicate_object then null; end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-28 · بذور الحوكمة (ق-30 · ق-31 · ق-32)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── ق-30 · platform.domain_owners — المجالات الاثنا عشر (22 §2) ────────────
-- عمود «البوابة» في 22 §2 نصّي؛ الرقم المستخرج منه: 100% لكل مجال عدا D06
-- («≥ ٩٥٪ من الأصناف النشطة مكتملة»).
-- تعارض 22 الداخلي في D03·D04·D05·D11 حُسم على CFO مالكاً (ق-30).
insert into platform.domain_owners (domain_code, owner_role, approver_role, gate_target_pct, changed_by) values
 ('D01','GM',         null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- الكيانات وبيانات الشركة
 ('D02','SYSADMIN',   'GM',  100.00,'00000000-0000-0000-0000-000000000000'),  -- المستخدمون والأدوار
 ('D03','CFO',        null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- العملاء
 ('D04','CFO',        null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- العقود وملاحق الأسعار
 ('D05','CFO',        'GM',  100.00,'00000000-0000-0000-0000-000000000000'),  -- الكتالوج — «الأسعار مع GM» (EXEC §1.7)
 ('D06','WH_MGR',     null,   95.00,'00000000-0000-0000-0000-000000000000'),  -- الأصناف — «≥ ٩٥٪»
 ('D07','WH_MGR',     null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- المواقع
 ('D08','GM',         null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- الموظفون والهيكل
 ('D09','FLEET_MGR',  null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- المركبات والوثائق
 ('D10','DEL_MGR',    null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- معرّفات iMile
 ('D11','CFO',        null,  100.00,'00000000-0000-0000-0000-000000000000'),  -- الشركاء والموردون
 ('D12','HOUSING_SUP',null,  100.00,'00000000-0000-0000-0000-000000000000')   -- السكن
on conflict (domain_code) do nothing;

-- ── ق-31 · platform.approval_chains — من EXEC §1.1 ─────────────────────────
-- الشراء: ≤ 100 آلي · 100–500 مدير القسم · 500–2,000 CFO · > 2,000 GM
-- الفاتورة: ≤ 500 آلي ثم CFO ثم GM · الإشعار الدائن: GM حصراً
-- ملاحظة: «مدير القسم الطالب» يُشتق وقت التنفيذ من القسم (R-04)؛ الدور المبذور
--   هنا هو WH_MGR كقيمة قابلة للاستبدال لكل طلب — v4 (استنباط تقني).
insert into platform.approval_chains
  (request_type, step_no, approver_role, min_amount, max_amount, auto_approve_below, changed_by) values
 ('purchase',    1,'WH_MGR',    100.000,  500.000, 100.000,'00000000-0000-0000-0000-000000000000'),
 ('purchase',    2,'CFO',       500.000, 2000.000, null,   '00000000-0000-0000-0000-000000000000'),
 ('purchase',    3,'GM',       2000.000, null,     null,   '00000000-0000-0000-0000-000000000000'),
 ('invoice',     1,'CFO',        500.000, null,    500.000,'00000000-0000-0000-0000-000000000000'),
 ('invoice',     2,'GM',            null, null,    null,   '00000000-0000-0000-0000-000000000000'),
 ('credit_note', 1,'GM',            null, null,    null,   '00000000-0000-0000-0000-000000000000'),
 ('price_exception',1,'GM',         null, null,    null,   '00000000-0000-0000-0000-000000000000'),
 ('penalty',     1,'GM',            null, null,    null,   '00000000-0000-0000-0000-000000000000')
on conflict (request_type, step_no) do nothing;

-- ── ق-32 · platform.automation_rules — التسع البشرية عمداً (29 §5-5) ───────
-- 29 §5-5 يسرد **تسع** عمليات (خرائط 01 و07 تقولان «ست» — الفارق مسجَّل).
-- تُبذر بمستوى A1 بأسمائها كما وردت، وإلا سقطت من البناء (29 نفسه ينبّه).
insert into platform.automation_rules
  (code, process, level, auto_condition, exception_condition, escalate_to_roles, owner_role) values
 ('AR-H01','تسوية فرق الجرد',                'A1', null,'مسؤولية مالية عن بضاعة الغير','{WH_MGR,GM}','WH_MGR'),
 ('AR-H02','رفع الحجز الائتماني',             'A1', null,'قرار تجاري بمخاطرة',          '{CFO,GM}',  'CFO'),
 ('AR-H03','الاستثناء السعري',                'A1', null,'التزام مالي طويل',            '{GM}',      'GM'),
 ('AR-H04','الإشعار الدائن',                  'A1', null,'تخفيض إيراد معتمد',           '{GM}',      'GM'),
 ('AR-H05','الجزاءات والإنذارات',             'A1', null,'مسؤولية قانونية — قانون العمل','{GM}',     'GM'),
 ('AR-H06','قرار التدقيق الحي المتنازع عليه', 'A1', null,'نزاع مع طرف ثالث',            '{DEL_MGR,GM}','DEL_MGR'),
 ('AR-H07','إسناد سائق لمنطقة حساسة',         'A1', null,'معرفة ميدانية لا تُشفَّر',     '{DEL_MGR}', 'DEL_MGR'),
 ('AR-H08','اعتماد مسير الرواتب',             'A1', null,'التزام مالي شهري',            '{CFO,GM}',  'GM'),
 ('AR-H09','التفاوض مع iMile',                'A1', null,'علاقة تجارية',                '{GM}',      'GM')
on conflict (code) do nothing;

-- ── platform.settings — إعدادات السائق التسعة (35 §8-3 · §12-1) ────────────
-- blueprint 04 §13 بند 10: «البذرة موصوفة حرفياً في 35 §8-3 و§12-1 ولم تُطبَّق».
-- الفهرس الفريد الجزئي settings_global_key_uq (13B-13) يجعل on conflict ممكناً.
insert into platform.settings (entity_id, key, value, data_type, description) values
 (null,'driver.ranking.enabled',         'true',           'boolean','إظهار ترتيب السائق بين زملائه'),
 (null,'driver.ranking.mode',            '"band"',         'string', 'band نطاق مئوي · exact ترتيب رقمي'),
 (null,'driver.ranking.show_peer_names', 'false',          'boolean','إظهار أسماء الزملاء'),
 (null,'driver.ranking.basis',           '"success_rate"', 'string', 'success_rate · volume · composite'),
 (null,'driver.ranking.linked_to_bonus', 'false',          'boolean','ربط الترتيب بالمكافأة'),
 (null,'driver.ranking.linked_to_penalty','false',         'boolean','ربط الترتيب بالجزاء'),
 (null,'driver.contact.provider',        '"direct"',       'string', 'direct · masked — 35 §12-1 قرار 1'),
 (null,'driver.payment.gateway',         '"none"',         'string', 'مزوّد بوابة الدفع — 35 §12-1 قرار 2'),
 (null,'driver.payment.allow_partial',   'false',          'boolean','الدفع الجزئي — 35 §12-1 قرار 3 · لا يُفعَّل')
on conflict (key) where entity_id is null do nothing;

-- «هل يرى العميل مواقعه التفصيلية» — EXEC §1.1 · 17 §9: «لا — إعداد لكل عميل»
-- المفتاح عام بقيمة false، ويُفتح لعميل بعينه بصفّ على مستوى كيانه.
-- v4 (استنباط): اسم المفتاح غير منصوص؛ الحبيبة «لكل عميل» تُنفَّذ في طبقة
--   التطبيق لأن platform.settings حبيبته (كيان × مفتاح) لا (عميل × مفتاح).
insert into platform.settings (entity_id, key, value, data_type, description) values
 (null,'wms.client_sees_detailed_locations','false','boolean',
  'EXEC §1.1 · 17 §9: لا يرى العميل مواقعه التفصيلية افتراضياً — يُفتح لكل عميل على حدة')
on conflict (key) where entity_id is null do nothing;

-- 15 §6: بانر تحذير على كل جزاء حتى اعتماد الهيئة للائحة (م.36) — GC-11
insert into platform.settings (entity_id, key, value, data_type, description) values
 (null,'hr.penalty_schedule_approved','false','boolean',
  '15 §6 · م.36: اعتماد الهيئة العامة للقوى العاملة للائحة الجزاءات. حتى يُرفع العلم '
  'يظهر بانر تحذير قانوني على كل جزاء')
on conflict (key) where entity_id is null do nothing;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-29 · إعادة تشغيل حلقة RLS بعد إنشاء `governance` — حارس G7 = 0
--   الحلقة نفسها الواردة في 13B-22 (ق-13): تتخطّى كل جدول له سياسة قائمة،
--   فتغطّي الجديد وحده. 40 Part F يسمّي `governance` ضمن المخططات الأربعة عشر.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
  v_has_entity boolean;
  v_nullable   boolean;
begin
  for r in
    select n.nspname as sch, c.relname as tab
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc',
                        'billing','hr','partners','admin','housing','imile','governance')
    order by 1,2
  loop
    -- ① تفعيل RLS على كل جدول أساسي (أقسام audit_log ضمناً — الوراثة لا تنقل relrowsecurity)
    execute format('alter table %I.%I enable row level security', r.sch, r.tab);

    -- إن كانت للجدول سياسة قائمة (من 01 أو من المرحلة الأولى) فلا تُكرَّر
    if exists (select 1 from pg_policies p
                where p.schemaname = r.sch and p.tablename = r.tab) then
      continue;
    end if;

    select true, a.attnotnull = false
      into v_has_entity, v_nullable
      from pg_attribute a
      join pg_class c2 on c2.oid = a.attrelid
      join pg_namespace n2 on n2.oid = c2.relnamespace
     where n2.nspname = r.sch and c2.relname = r.tab
       and a.attname = 'entity_id' and a.attnum > 0 and not a.attisdropped;

    if platform.is_reference_table(r.sch, r.tab) then
      -- ③ مرجعي: قراءة لكل داخلي · كتابة بصلاحية إدارة البيانات المرجعية
      execute format(
        'create policy reference_read on %I.%I for select using (platform.is_internal())',
        r.sch, r.tab);
      execute format(
        'create policy reference_write on %I.%I for all to public '
        'using (platform.is_internal() and platform.has_perm(%L)) '
        'with check (platform.is_internal() and platform.has_perm(%L))',
        r.sch, r.tab, 'platform.reference.manage', 'platform.reference.manage');
    elsif coalesce(v_has_entity, false) then
      -- ① نطاق الكيان
      if coalesce(v_nullable, false) then
        execute format(
          'create policy entity_scope on %I.%I for all using '
          '(entity_id is null or entity_id = any(platform.allowed_entities())) '
          'with check (entity_id is null or entity_id = any(platform.allowed_entities()))',
          r.sch, r.tab);
      else
        execute format(
          'create policy entity_scope on %I.%I for all using '
          '(entity_id = any(platform.allowed_entities())) '
          'with check (entity_id = any(platform.allowed_entities()))',
          r.sch, r.tab);
      end if;
    else
      -- ② داخلي فقط
      execute format(
        'create policy internal_only on %I.%I for all using (platform.is_internal())',
        r.sch, r.tab);
    end if;
  end loop;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد المرحلة الرابعة
-- ═══════════════════════════════════════════════════════════════════════════
--   select count(*) from information_schema.tables where table_schema='governance';  -- 14
--   select count(*) from platform.domain_owners;      -- 12
--   select count(*) from platform.approval_chains;    -- 8
--   select count(*) from platform.automation_rules;   -- 9
--   select count(*) from platform.settings;           -- 3 (019) + 11 (SCH-4)
--   select count(*) from platform.counters where doc_type in
--     ('MNT','ACC','RCR','DSC','HMR','HIN','DOC','NCR');   -- 8 × 5 كيانات = 40
--   -- G7 يجب أن يبقى صفراً بعد إضافة governance
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  13B-WO · أوامر العمل داخل المستودع (SCR-WO · طلب المدير العام 21/09)   ║
-- ║  المصدر: D-blueprints/12-Warehouse-Work-Orders-VAS.md                    ║
-- ║          §3-5 (الـDDL المختبَر) · §1 (خريطة الخدمات الـ39) · §9 (C-1…C-15)║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- سجل قرارات SCH-5 (يُقرأ مع ق-1…ق-32 أعلاه)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-33 · الجداول الثلاثة منقولة **حرفياً** من 12 §3-5، وهي الكتلة نفسها التي
--        نُفِّذت على `pgeos` داخل `begin; … rollback;` في 21/09 ونجحت فيها
--        اثنا عشر اختباراً (12 §3-6). التعديلات على النص الأصلي ثلاثة فقط،
--        كلها موسومة `-- v4` في موضعها:
--          ① `changed_by` في بذرة العتبات كان `'<gm_user_id>'` وهو نصّ لا uuid —
--             استُبدل بالمعرّف الصفري كما في كل بذور 13B (ق-13 في SCH-2).
--          ② أُضيف `on conflict do nothing` لبذرتَي العتبات والعدّاد ليبقى
--             الملف قابلاً لإعادة التشغيل.
--          ③ سياسة `client_portal_scope` على `work_orders` جاءت في §3-5
--             بـ`for select` — أُبقيت كما هي: العميل **يرى** تقدّم أوامره
--             ولا يكتب. ولا سياسة عميل على `tasks` ولا `events` (نمط ق-9).
--
-- ق-34 · `wms.work_order_task_types` — جدول مرجعي **يُضيفه SCH-5** (لم يرد في
--        §3-5): يربط كل خدمة داخلية بنوع المهمة ودورها ومعدّتها وأساس فوترتها.
--        بذرته خريطة §1 حرفاً بحرف: **33 خدمة قابلة للإسناد** في **35 صفاً** —
--        لأن `OF-12` («إعادة تجهيز») و`VA-13` («الحجر والإفراج») لكلٍّ منهما
--        نوعان (`pick`+`check` و`transfer`+`qc`). والستّ الباقية من الـ39
--        (`HD-13` · `OF-01` · `OF-11` · `OF-13` · `VA-12` + سمة `HD-09`)
--        **لا تُبذر**: رسوم على مستوى الأمر أو سمات لا عمل يُسنَد لعامل.
--
-- ق-35 · أنواع المهام خمسة عشر كما في قيد §3-5 — `HD-06` تُسنَد `putaway`
--        و`VA-03` تُسنَد `kit`. القرار **D-3** في 12 §10-3 (إضافة `sort_stack`
--        و`de_kit` أم الاكتفاء بعلَم) **مفتوح لـ`WH_MGR`** ومسجَّل؛ ولا يُخترع
--        نوع قبل حسمه. الملاحظة مكتوبة في صفّ الخدمتين في الجدول المرجعي.
--
-- ق-36 · العتبات السبع: 12 §10-3 D-1 ينص صراحةً أن قيمها «**ابتدائية مقترحة
--        ولا سند لها في الحزمة**». بُذرت كما وردت مع وسم
--        `(ابتدائية — قرار GM)` في `description_ar` لكل صفّ، فلا تُقرأ يوماً
--        كقيمة محسومة. تُضبط بعد أول شهر قياس فعلي (D-1).
--
-- ق-37 · حارس `trg_wo_checker_not_picker` ينفّذ `INV-C3-6` في القاعدة بعد أن
--        كان 40 §C3 يصفه «enforced in command». هذا هو التصحيح **C-1** في
--        12 §9 — يُطبَّق هنا ويبقى تعديل نصّ 40 لوكيل الوثائق الحاكمة.
--        وزوج SoD `(WH_OP, WH_SUP)` يبقى كما هو (C-15: «لا تعديل»).
--
-- ق-38 · الفهرس الفريد الذي يمنع ازدواج حدث الفوترة (اختبار T10)
--        `billable_events_source_table_source_id_service_id_idx` **قائم أصلاً**
--        في القاعدة — لا يُعاد إنشاؤه.
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- SCR-WO-01 · طبقة أوامر العمل داخل المستودع — منقول من 12 §3-5
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) أمر العمل — الرأس
create table wms.work_orders (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,                          -- سلسلة WO من platform.counters
  warehouse_id  uuid not null references wms.warehouses(id),
  client_id     uuid not null references sales.accounts(id),
  contract_id   uuid references sales.contracts(id),
  -- المرجع متعدد الأشكال — نفس نمط billing.billable_events
  source_table  text,        -- wms.inbound_orders · wms.outbound_orders · wms.inventory_counts · null = طلب VAS مباشر
  source_id     uuid,
  task_type     text not null,
  service_id    uuid references catalog.services(id),   -- كود الخدمة المفوتر عنها
  priority      int  not null default 5,                -- 1 = الأعلى
  is_rush       boolean not null default false,         -- OF-11
  sla_minutes   int,
  due_at        timestamptz,
  qty_planned   numeric(14,3) not null default 0,
  qty_done      numeric(14,3) not null default 0,
  uom           text not null,                          -- من catalog.services.uom
  status        text not null default 'draft',
  requested_by  uuid,
  approved_by   uuid,
  released_at   timestamptz,
  completed_at  timestamptz,
  cancel_reason text,
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  unique (entity_id, doc_no),
  constraint chk_work_orders_status check (status in
    ('draft','released','in_progress','on_hold','completed','cancelled')),
  constraint chk_work_orders_task_type check (task_type in
    ('receive','putaway','pick','check','pack','label','kit','load',
     'return_sort','count','weigh','photo','transfer','scrap','qc')),
  constraint chk_work_orders_source_pair check ((source_table is null) = (source_id is null)),
  constraint chk_work_orders_qty check (qty_planned >= 0 and qty_done >= 0),
  constraint chk_work_orders_completed_has_time check (status <> 'completed' or completed_at is not null),
  constraint chk_work_orders_cancel_has_reason check (status <> 'cancelled' or cancel_reason is not null)
);
create index on wms.work_orders (warehouse_id, status, priority, due_at);
create index on wms.work_orders (source_table, source_id);
create index on wms.work_orders (client_id, status);

comment on table wms.work_orders is
  'أمر عمل داخل المستودع — الوحدة القابلة للإسناد والتتبّع والفوترة لخدمات HD/OF/VA';

-- 2) المهمة — تقسيم أمر العمل على العمال
create table wms.work_order_tasks (
  id               uuid primary key default gen_random_uuid(),
  work_order_id    uuid not null references wms.work_orders(id) on delete cascade,
  line_no          int  not null,
  worker_id        uuid references hr.employees(id),
  team_id          uuid references hr.teams(id),
  assigned_by      uuid,
  assigned_at      timestamptz,
  accepted_at      timestamptz,
  started_at       timestamptz,
  paused_at        timestamptz,
  resumed_at       timestamptz,
  paused_minutes   int  not null default 0,
  completed_at     timestamptz,
  qty_assigned     numeric(14,3) not null default 0,
  qty_done         numeric(14,3) not null default 0,
  sku_id           uuid references wms.skus(id),
  location_from_id uuid references wms.locations(id),
  location_to_id   uuid references wms.locations(id),
  device_id        text,
  exception_code   text,   -- قائمة مغلقة: not_found · short_qty · damaged · blocked_location · wrong_client · equipment_down
  exception_note   text,
  quality_check_by uuid references hr.employees(id),
  quality_result   text,   -- pass · fail
  reassigned_from  uuid references wms.work_order_tasks(id),
  reassign_reason  text,
  status           text not null default 'queued',
  entered_offline  boolean not null default false,
  original_occurred_at timestamptz,
  created_at       timestamptz not null default now(),
  unique (work_order_id, line_no),
  constraint chk_wo_tasks_status check (status in
    ('queued','assigned','accepted','in_progress','paused','done','rejected','reassigned')),
  constraint chk_wo_tasks_assigned_has_worker
    check (status = 'queued' or worker_id is not null),
  constraint chk_wo_tasks_done_has_times
    check (status <> 'done' or (started_at is not null and completed_at is not null)),
  constraint chk_wo_tasks_qc_not_self
    check (quality_check_by is null or worker_id is null or quality_check_by <> worker_id),
  constraint chk_wo_tasks_exception_has_code
    check (exception_note is null or exception_code is not null),
  constraint chk_wo_tasks_reassign_has_reason
    check (status <> 'reassigned' or reassign_reason is not null),
  constraint chk_wo_tasks_quality_result check (quality_result is null or quality_result in ('pass','fail')),
  constraint chk_wms_wo_tasks_offline_has_date
    check (entered_offline = false or original_occurred_at is not null),
  constraint chk_wo_tasks_qty check (qty_assigned >= 0 and qty_done >= 0)
);
create index on wms.work_order_tasks (worker_id, status);
create index on wms.work_order_tasks (work_order_id, status);
create index on wms.work_order_tasks (status, assigned_at);

comment on table wms.work_order_tasks is
  'المهمة المسنَدة لعامل بعينه — بوقت بدء وانتهاء وكمية منجزة وجهاز وسبب استثناء';
-- v4 (SCH-5 · 12 §10-2 W-5): قائمة `exception_code` الستة اجتهادُ الوثيقة لا نصّ
--   حاكم، فلم يُكتب لها قيد `check` — تنتظر اعتماد WH_MGR أو جدولاً مرجعياً
--   نظير `tms.failure_reasons`. مسجَّل في «يحتاج قرار GM».

-- 3) السجل الزمني — دفتر لا يُعدَّل
create table wms.work_order_events (
  id            bigserial primary key,
  work_order_id uuid not null references wms.work_orders(id) on delete cascade,
  task_id       uuid references wms.work_order_tasks(id) on delete cascade,
  occurred_at   timestamptz not null default now(),
  event_type    text not null,  -- released·assigned·accepted·started·paused·resumed·completed·rejected·reassigned·exception·on_hold·cancelled
  actor_id      uuid,
  from_status   text,
  to_status     text,
  qty           numeric(14,3),
  device_id     text,
  note          text,
  payload       jsonb
);
create index on wms.work_order_events (work_order_id, occurred_at);
create index on wms.work_order_events (task_id, occurred_at);

comment on table wms.work_order_events is
  'سجل زمني لأوامر العمل ومهامها — دفتر لا يُعدَّل. التصحيح بحدث مقابل فقط';
-- v4 (SCH-5 · نمط P3 في 01): الدفتر لا يُعدَّل — تُسحب صلاحيتا التعديل والحذف
revoke update, delete on wms.work_order_events from public;

-- 4) RLS — نمط 01/13B
alter table wms.work_orders       enable row level security;
alter table wms.work_order_tasks  enable row level security;
alter table wms.work_order_events enable row level security;

create policy entity_scope on wms.work_orders
  for all using (entity_id = any(platform.allowed_entities()));
-- ق-33 ③: العميل يرى تقدّم أوامره ولا يكتب (12 §3-5 · §6). ولا سياسة عميل
--   على المهام ولا السجل الزمني — إسناد العمال شأن داخلي (نمط ق-9).
create policy client_portal_scope on wms.work_orders
  for select using (platform.is_internal() or client_id = platform.current_client_id());
create policy internal_only on wms.work_order_tasks
  for all using (platform.is_internal());
create policy internal_only on wms.work_order_events
  for all using (platform.is_internal());

-- 5) الحارس 1 — المدقّق ≠ الملتقط على الأمر نفسه (INV-C3-6 · EXEC §1.2 FIXED)
create or replace function wms.enforce_checker_not_picker() returns trigger
language plpgsql as $fn$
declare v_src_table text; v_src_id uuid; v_type text; v_n int;
begin
  if new.worker_id is null then return new; end if;
  select wo.source_table, wo.source_id, wo.task_type
    into v_src_table, v_src_id, v_type
    from wms.work_orders wo where wo.id = new.work_order_id;
  if v_type is distinct from 'check' or v_src_id is null then return new; end if;
  select count(*) into v_n
    from wms.work_order_tasks t
    join wms.work_orders w on w.id = t.work_order_id
   where w.source_table = v_src_table
     and w.source_id    = v_src_id
     and w.task_type    = 'pick'
     and t.worker_id    = new.worker_id
     and t.status in ('accepted','in_progress','paused','done');
  if v_n > 0 then
    raise exception 'المدقّق لا يدقّق التقاطه — INV-C3-6 · EXEC §1.2 FIXED (العامل %)', new.worker_id
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;
comment on function wms.enforce_checker_not_picker is
  '12 §9 C-1: ينقل INV-C3-6 من «enforced in command» إلى قيد في القاعدة. اختبار T4';

drop trigger if exists trg_wo_checker_not_picker on wms.work_order_tasks;   -- v4: قابلية إعادة التشغيل
create trigger trg_wo_checker_not_picker
  before insert or update of worker_id on wms.work_order_tasks
  for each row execute function wms.enforce_checker_not_picker();

-- 6) الحارس 2 — حدّ المهام النشطة لكل عامل (platform.thresholds)
create or replace function wms.enforce_worker_task_cap() returns trigger
language plpgsql as $fn$
declare v_cap int; v_n int;
begin
  if new.worker_id is null or new.status not in ('assigned','accepted','in_progress','paused')
    then return new; end if;
  select value::int into v_cap from platform.thresholds
   where key = 'wo.max_active_tasks_per_worker';
  if v_cap is null then return new; end if;
  select count(*) into v_n from wms.work_order_tasks t
   where t.worker_id = new.worker_id
     and t.id <> new.id
     and t.status in ('assigned','accepted','in_progress','paused');
  if v_n >= v_cap then
    raise exception 'العامل % يحمل % مهام نشطة والحد % — wo.max_active_tasks_per_worker',
      new.worker_id, v_n, v_cap using errcode = 'check_violation';
  end if;
  return new;
end $fn$;
comment on function wms.enforce_worker_task_cap is
  '12 §3-4: حدّ الحمل الفردي يُقرأ من platform.thresholds لا من رقم في الكود. اختبار T6';

drop trigger if exists trg_wo_worker_task_cap on wms.work_order_tasks;      -- v4: قابلية إعادة التشغيل
create trigger trg_wo_worker_task_cap
  before insert or update of worker_id, status on wms.work_order_tasks
  for each row execute function wms.enforce_worker_task_cap();

-- 7) العتبات السبع — القيم ابتدائية بنصّ 12 §10-3 D-1 (ق-36)
-- v4 ①: changed_by كان '<gm_user_id>' وهو نصّ لا uuid — المعرّف الصفري كنظيراته.
-- v4 ②: on conflict do nothing.
insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
 ('wo.max_active_tasks_per_worker', 3,   'count',   'أقصى مهام نشطة لعامل واحد في آن — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)', '00000000-0000-0000-0000-000000000000'),
 ('wo.sla.pick_min',                60,  'minutes', 'SLA مهمة الالتقاط — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)',              '00000000-0000-0000-0000-000000000000'),
 ('wo.sla.check_min',               30,  'minutes', 'SLA مهمة التدقيق — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)',               '00000000-0000-0000-0000-000000000000'),
 ('wo.sla.pack_min',                30,  'minutes', 'SLA مهمة التغليف — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)',               '00000000-0000-0000-0000-000000000000'),
 ('wo.sla.putaway_min',             120, 'minutes', 'SLA مهمة التخزين — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)',               '00000000-0000-0000-0000-000000000000'),
 ('wo.sla.receive_min',             240, 'minutes', 'SLA مهمة الاستلام — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)',              '00000000-0000-0000-0000-000000000000'),
 ('wo.sla.vas_min',                 480, 'minutes', 'SLA مهمة القيمة المضافة — SCR-WO-01 (ابتدائية — قرار GM · 12 §10-3 D-1)',        '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

-- 8) سلسلة الترقيم WO لكل كيان — نمط INB/OUT/CNT/TSK
insert into platform.counters (entity_id, doc_type, period, prefix, padding, current_val)
select id, 'WO', 'ALL', code||'-WO-', 5, 0 from platform.entities
on conflict do nothing;   -- v4 ②


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-WO-1b · تجميع qty_done على أمر العمل من مهامه (12 §9 C-4: الفوترة بالكمية المنجزة) — v4
create or replace function wms.wo_rollup_qty_done() returns trigger
language plpgsql as $$
declare v_wo uuid := coalesce(new.work_order_id, old.work_order_id);
begin
  update wms.work_orders w
     set qty_done = coalesce((select sum(t.qty_done) from wms.work_order_tasks t
                              where t.work_order_id = v_wo and t.status = 'done'), 0)
   where w.id = v_wo;
  return null;
end $$;
drop trigger if exists trg_wo_rollup_qty_done on wms.work_order_tasks;
create trigger trg_wo_rollup_qty_done
  after insert or update of qty_done, status or delete on wms.work_order_tasks
  for each row execute function wms.wo_rollup_qty_done();

-- 13B-WO-2 · الجدول المرجعي: الخدمة → نوع المهمة (ق-34)
--   المصدر: 12 §1-1 · §1-2 · §1-3 — منقول عموداً بعمود.
--   33 خدمة قابلة للإسناد في 35 صفاً (OF-12 و VA-13 لكلٍّ نوعان).
--   الستّ الباقية من الـ39 لا تُبذر: HD-13 · OF-01 · OF-11 · OF-13 · VA-12
--   + سمة HD-09 — رسوم على مستوى الأمر أو سمات لا عمل يُسنَد لعامل.
-- ═══════════════════════════════════════════════════════════════════════════

create table wms.work_order_task_types (
  service_code       text not null references catalog.services(code),
  task_type          text not null,
  service_id         uuid references catalog.services(id),   -- يُملأ أدناه من service_code
  default_role       text not null references identity.roles(code),
  requires_equipment boolean not null default false,
  equipment_note     text,          -- عمود «المهارة/المعدّة» في 12 §1 حرفياً
  billable           boolean not null default true,
  billing_trigger    text not null, -- per_event · per_qty · per_contract (عمود «تُفوتر» في 12 §1)
  note               text,
  primary key (service_code, task_type),
  constraint chk_wo_task_types_type check (task_type in
    ('receive','putaway','pick','check','pack','label','kit','load',
     'return_sort','count','weigh','photo','transfer','scrap','qc')),
  constraint chk_wo_task_types_trigger check (billing_trigger in
    ('per_event','per_qty','per_contract'))
);
create index on wms.work_order_task_types (task_type);

comment on table wms.work_order_task_types is
  '12 §1: خريطة الخدمات الداخلية الـ39 إلى أنواع المهام الخمسة عشر. '
  '33 خدمة قابلة للإسناد · 6 رسوم أو سمات لا تُبذر. billing_trigger من عمود «تُفوتر»';
comment on column wms.work_order_task_types.billing_trigger is
  '12 §9 C-4: per_qty ⇒ يُولَّد الحدث من wms.wo.completed بالكمية المنجزة · '
  'per_event ⇒ يبقى على مصدره الحالي (outbound.checked / inbound.received) · '
  'per_contract ⇒ خدمات VA حسب بند العقد';

insert into wms.work_order_task_types
  (service_code, task_type, default_role, requires_equipment, equipment_note, billing_trigger, note)
values
 ('HD-01','receive','WH_OP',true,'رافعة شوكية + فريق تفريغ','per_event',null),
 ('HD-02','receive','WH_OP',true,'رافعة شوكية + فريق ≥ 3','per_event',null),
 ('HD-03','receive','WH_OP',true,'رافعة شوكية','per_event',null),
 ('HD-04','receive','WH_OP',true,'رافعة شوكية','per_qty',null),
 ('HD-05','receive','WH_OP',false,'يدوي','per_qty',null),
 ('HD-06','putaway','WH_OP',true,'رافعة + ترصيص','per_qty','§1-1 هامش 1: لا نوع مطابق واحد — الترصيص خطوة داخل التخزين. قرار D-3 مفتوح (sort_stack؟)'),
 ('HD-07','qc','WH_OP',false,'تدريب فحص','per_qty','الدور في §1-1: WH_OP + WH_SUP'),
 ('HD-08','putaway','WH_OP',true,'رافعة شوكية','per_qty',null),
 ('HD-10','return_sort','WH_OP',false,null,'per_qty',null),
 ('HD-11','transfer','WH_OP',true,'رافعة شوكية','per_qty',null),
 ('HD-12','count','WH_OP',false,'عدّ أعمى','per_qty',null),
 ('OF-02','pick','WH_OP',true,'PDA','per_qty',null),
 ('OF-03','pick','WH_OP',true,'PDA','per_qty',null),
 ('OF-04','pick','WH_OP',true,'عربة','per_qty',null),
 ('OF-05','pick','WH_OP',true,'رافعة شوكية','per_qty',null),
 ('OF-06','check','WH_OP',true,'PDA','per_event','§1-2: «لعامل غير الملتقط» — يفرضه trg_wo_checker_not_picker'),
 ('OF-07','pack','WH_OP',true,'محطة تغليف','per_qty',null),
 ('OF-08','label','WH_OP',true,'طابعة ملصقات','per_qty',null),
 ('OF-09','load','WH_OP',true,'رافعة شوكية','per_qty',null),
 ('OF-10','pick','WH_OP',true,'رافعة شوكية','per_qty',null),
 ('OF-12','pick','WH_OP',true,'PDA','per_event','§1-2: OF-12 نوعان — pick ثم check بنفس source_id'),
 ('OF-12','check','WH_OP',true,'PDA','per_event','§1-2: OF-12 نوعان — pick ثم check بنفس source_id'),
 ('VA-01','pack','WH_OP',true,'محطة تغليف','per_contract',null),
 ('VA-02','kit','WH_OP',true,'طاولة تجميع','per_contract',null),
 ('VA-03','kit','WH_OP',true,'طاولة تجميع','per_contract','§1-3 هامش 6: تفكيك — نفس النوع بعلَم اتجاه عكسي. قرار D-3 مفتوح (de_kit؟)'),
 ('VA-04','label','WH_OP',false,null,'per_contract',null),
 ('VA-05','label','WH_OP',true,'طابعة باركود','per_contract',null),
 ('VA-06','return_sort','WH_OP',false,'تدريب تصنيف','per_contract',null),
 ('VA-07','scrap','WH_OP',false,'محضر إتلاف','per_contract','§1-3: بعد موافقة العميل + WH_MGR'),
 ('VA-08','pack','WH_OP',true,'آلة تغليف','per_contract',null),
 ('VA-09','weigh','WH_OP',true,'ميزان + قدمة','per_contract',null),
 ('VA-10','photo','WH_OP',true,'استوديو مصغّر','per_contract',null),
 ('VA-11','count','WH_OP',false,'عدّ أعمى','per_contract',null),
 ('VA-13','transfer','WH_OP',true,'إذن WH_MGR','per_contract','§1-3: VA-13 نوعان — transfer ثم qc'),
 ('VA-13','qc','WH_OP',false,'إذن WH_MGR','per_contract','§1-3: VA-13 نوعان — transfer ثم qc')
on conflict (service_code, task_type) do nothing;
-- v4: service_id يُشتق من service_code بعد البذر — عمود مساعد للانضمام المباشر
update wms.work_order_task_types t
   set service_id = s.id
  from catalog.services s
 where s.code = t.service_code and t.service_id is null;

-- حارس عدّي: 33 خدمة قابلة للإسناد من الـ39 (12 §1 الخلاصة العددية)
do $$
declare v_svc int; v_rows int;
begin
  select count(distinct service_code), count(*) into v_svc, v_rows
    from wms.work_order_task_types;
  if v_svc <> 33 or v_rows <> 35 then
    raise exception 'خريطة 12 §1: المتوقع 33 خدمة في 35 صفاً — الموجود % خدمة في % صفاً', v_svc, v_rows;
  end if;
end $$;

-- قيدا الحالة في STATE-REGISTER (12 §9 C-7) مفروضان أصلاً داخل تعريفَي الجدولين:
--   wms.work_orders.status      — 6 حالات (chk_work_orders_status)
--   wms.work_order_tasks.status — 8 حالات (chk_wo_tasks_status)
-- يبقى تحديث `_changelog/STATE-REGISTER.md` (41 → 43 عمود حالة) لوكيل السجل.


-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-WO-3 · إعادة تشغيل حلقة RLS بعد جداول أوامر العمل — حارس G7 = 0
--   الحلقة نفسها الواردة في 13B-22 (ق-13): تتخطّى كل جدول له سياسة قائمة،
--   فتغطّي `wms.work_order_task_types` وحده (الثلاثة الأخرى لها سياساتها أعلاه).
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
  v_has_entity boolean;
  v_nullable   boolean;
begin
  for r in
    select n.nspname as sch, c.relname as tab
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc',
                        'billing','hr','partners','admin','housing','imile','governance')
    order by 1,2
  loop
    -- ① تفعيل RLS على كل جدول أساسي (أقسام audit_log ضمناً — الوراثة لا تنقل relrowsecurity)
    execute format('alter table %I.%I enable row level security', r.sch, r.tab);

    -- إن كانت للجدول سياسة قائمة (من 01 أو من المرحلة الأولى) فلا تُكرَّر
    if exists (select 1 from pg_policies p
                where p.schemaname = r.sch and p.tablename = r.tab) then
      continue;
    end if;

    select true, a.attnotnull = false
      into v_has_entity, v_nullable
      from pg_attribute a
      join pg_class c2 on c2.oid = a.attrelid
      join pg_namespace n2 on n2.oid = c2.relnamespace
     where n2.nspname = r.sch and c2.relname = r.tab
       and a.attname = 'entity_id' and a.attnum > 0 and not a.attisdropped;

    if platform.is_reference_table(r.sch, r.tab) then
      -- ③ مرجعي: قراءة لكل داخلي · كتابة بصلاحية إدارة البيانات المرجعية
      execute format(
        'create policy reference_read on %I.%I for select using (platform.is_internal())',
        r.sch, r.tab);
      execute format(
        'create policy reference_write on %I.%I for all to public '
        'using (platform.is_internal() and platform.has_perm(%L)) '
        'with check (platform.is_internal() and platform.has_perm(%L))',
        r.sch, r.tab, 'platform.reference.manage', 'platform.reference.manage');
    elsif coalesce(v_has_entity, false) then
      -- ① نطاق الكيان
      if coalesce(v_nullable, false) then
        execute format(
          'create policy entity_scope on %I.%I for all using '
          '(entity_id is null or entity_id = any(platform.allowed_entities())) '
          'with check (entity_id is null or entity_id = any(platform.allowed_entities()))',
          r.sch, r.tab);
      else
        execute format(
          'create policy entity_scope on %I.%I for all using '
          '(entity_id = any(platform.allowed_entities())) '
          'with check (entity_id = any(platform.allowed_entities()))',
          r.sch, r.tab);
      end if;
    else
      -- ② داخلي فقط
      execute format(
        'create policy internal_only on %I.%I for all using (platform.is_internal())',
        r.sch, r.tab);
    end if;
  end loop;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد طبقة أوامر العمل
-- ═══════════════════════════════════════════════════════════════════════════
--   select count(*) from information_schema.tables
--    where table_schema='wms' and table_name like 'work_order%';        -- 4
--   select count(distinct service_code), count(*) from wms.work_order_task_types;  -- 33 | 35
--   select count(*) from platform.thresholds where key like 'wo.%';     -- 7
--   select count(*) from platform.counters where doc_type='WO';         -- 5
--   select platform.next_doc_no((select id from platform.entities where code='PST'),'WO','ALL');
--        -- PST-WO-00001  (اختبار T1)
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  13B-SP · مؤشرات إشغال المساحة (طلب المدير العام 21/09)                 ║
-- ║  المصدر: D-blueprints/13-Space-Occupancy-Indicators.md §5-ب · §6 · §8   ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- سجل قرارات SCH-6 · الحزمة الأولى (يُقرأ مع ق-1…ق-38 أعلاه)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-39 · العروض الأربعة والمشغّل الحارس ودالة التحويل منقولة **حرفياً** من
--        13 §5-ب — وهي الكتلة التي نُفِّذت على `pgeos` داخل `begin; … rollback;`
--        ونجح فيها أربعة عشر اختباراً (13 §0 بند 3 · §9).
--        `wms.client_space_overview` تُنشأ بـ`security_invoker = true` كما في
--        النصّ: العرض ينفَّذ بصلاحية القارئ لا بصلاحية مالكه، فسياسات RLS
--        على جداوله تسري على العميل فعلاً — ومعها شرط `where` الصريح
--        `platform.is_internal() or c.id = platform.current_client_id()`.
--
-- ق-40 · تصحيح `wms.space_dashboard` (فجوتا 13 §8-1 و§8-2):
--        ① كان يقرأ `snapshot_date = current_date - 1` بينما العروض الجديدة
--           تقرأ **آخر لقطة ≤ اليوم**. أعاد اختبار T12 رقمين مختلفين للمشغول
--           نفسه (157.500 مقابل 160.000) على شاشة واحدة. يُوحَّد على «آخر لقطة».
--        ② كان يجمع التخصيصات بـ`status='active'` وحدها بلا ترشيح بمدى
--           السريان، بينما `wms.space_availability()` ترشّح بـ`valid_from`
--           و`valid_to`. الأثر: تخصيص يبدأ الشهر القادم يُخصم من المتاح اليوم
--           ⇒ **تقليل المبيعات بلا سبب**. يُرشَّح كما ترشّح الدالة.
--        وبهذين يطابق `space_dashboard` مجاميعَ `space_by_type` (اختبار T14).
--
-- ق-41 · سياسات العميل على جدولَي الإشغال والحجز (فجوة 13 §8-4): كان على
--        `wms.occupancy_snapshots` و`wms.space_reservations` نطاق الكيان وحده،
--        فأي استعلام خارج العرض الجديد يصل إلى لقطات عملاء آخرين.
--        تُضاف `client_portal_scope` للقراءة على الاثنين بنمط 01.
--        ⚠️ `space_reservations.client_id` قابل للعدم (حجز على فرصة قبل إنشاء
--        الحساب) — والصفّ بلا عميل لا يراه أحد من الخارج، وهو المطلوب.
--        وسؤال «هل يرى العميل المحجوز له؟» (13 §8-5) قرار تجاري لـGM ولا
--        يغيّره هذا القسم: السياسة تسمح بالصفّ المملوك له فقط.
--
-- ق-42 · القرارات المفتوحة في 13 §8 **لا تُنفَّذ هنا**: مصدر `ST-14` (§8-3) ·
--        `monthly_cost` الفارغ (§8-6) · وحدة بيع الأرفف (§8-7) · خريطة
--        `block_type → ST-xx` (§8-8) · البيع بالم²/م³ (§8-9) · مشغّل تعطيل
--        كتلة عليها تخصيص (§8-11). كلها قرارات GM/CFO/WH_MGR مسجَّلة.
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-SP-1 · العروض الأربعة الجديدة — 13 §5-ب (منقولة حرفياً)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view wms.space_by_type as
with snap as (
  select max(snapshot_date) as d from wms.occupancy_snapshots where snapshot_date <= current_date),
oos as (
  select block_id, sum(qty_pallets) as q_pos, sum(qty_sqm) as q_sqm
  from wms.space_blocks_out_of_service
  where from_date <= current_date and (to_date is null or to_date >= current_date)
  group by 1),
alloc as (
  select block_id, sum(qty) as q from wms.space_allocations
  where status = 'active' and valid_from <= current_date
    and (valid_to is null or valid_to >= current_date)
  group by 1),
resv as (
  select block_id, sum(qty) as q from wms.space_reservations
  where status = 'active' and reserved_from <= current_date and expires_at >= current_date
  group by 1),
occ as (
  select o.space_block_id as bid,
         sum(o.pallets_occupied) as p, sum(o.sqm_occupied) as s, sum(o.cbm_occupied) as c
  from wms.occupancy_snapshots o, snap
  where o.snapshot_date = snap.d
  group by 1)
select
  w.code                                   as warehouse,
  b.block_type,
  b.uom,
  (select d from snap)                     as as_of,
  count(*)                                 as blocks,
  sum(b.capacity_pallets)                  as capacity_positions,
  sum(b.capacity_sqm)                      as capacity_sqm,
  sum(b.capacity_cbm)                      as capacity_cbm,
  sum(coalesce(x.q_pos,0))                 as out_of_service_positions,
  sum(coalesce(a.q,0))                     as contracted_positions,
  sum(coalesce(r.q,0))                     as reserved_positions,
  sum(coalesce(o.p,0))                     as occupied_positions,
  sum(b.capacity_pallets - coalesce(x.q_pos,0) - coalesce(a.q,0) - coalesce(r.q,0))
                                           as sellable_positions,
  round(sum((b.capacity_pallets - coalesce(x.q_pos,0) - coalesce(a.q,0) - coalesce(r.q,0))
            * b.capacity_sqm / nullif(b.capacity_pallets,0)), 3) as sellable_sqm,
  round(sum((b.capacity_pallets - coalesce(x.q_pos,0) - coalesce(a.q,0) - coalesce(r.q,0))
            * b.capacity_cbm / nullif(b.capacity_pallets,0)), 3) as sellable_cbm,
  round(100.0 * sum(coalesce(a.q,0)) / nullif(sum(b.capacity_pallets),0), 1) as contracted_pct,
  round(100.0 * sum(coalesce(o.p,0)) / nullif(sum(b.capacity_pallets),0), 1) as utilization_pct,
  sum(greatest(coalesce(a.q,0) - coalesce(o.p,0), 0))            as idle_contracted_positions
from wms.space_blocks b
join wms.warehouses w on w.id = b.warehouse_id
left join oos   x on x.block_id = b.id
left join alloc a on a.block_id = b.id
left join resv  r on r.block_id = b.id
left join occ   o on o.bid      = b.id
where b.status = 'active'
group by w.code, b.block_type, b.uom;

comment on view wms.space_by_type is
 'إشغال المساحة مجمّعاً بحسب نوع الكتلة ووحدة القياس — بالمواضع والم² والم³ (v4 · D-13)';

create or replace view wms.client_space_overview
  with (security_invoker = true) as
with snap as (
  select max(snapshot_date) as d from wms.occupancy_snapshots where snapshot_date <= current_date),
alloc as (
  select a.client_id, (array_agg(a.entity_id))[1] as entity_id, sum(a.qty) as contracted
  from wms.space_allocations a
  where a.status = 'active' and a.valid_from <= current_date
    and (a.valid_to is null or a.valid_to >= current_date)
  group by 1),
occ as (
  select o.client_id, (array_agg(o.entity_id))[1] as entity_id,
         sum(o.pallets_occupied) as occupied, sum(o.sqm_occupied) as occupied_sqm,
         sum(o.cbm_occupied) as occupied_cbm, sum(o.locations_used) as locations_used
  from wms.occupancy_snapshots o, snap
  where o.snapshot_date = snap.d
  group by 1),
resv as (
  select r.client_id, sum(r.qty) as reserved, min(r.expires_at) as next_expiry
  from wms.space_reservations r
  where r.status = 'active' and r.expires_at >= current_date and r.client_id is not null
  group by 1)
select
  c.id            as client_id,
  c.code          as client_code,
  c.name_ar       as client_name,
  coalesce(al.entity_id, oc.entity_id)                     as entity_id,
  (select d from snap)                                     as as_of,
  coalesce(al.contracted, 0)                               as contracted_positions,
  coalesce(oc.occupied, 0)                                 as occupied_positions,
  coalesce(oc.occupied_sqm, 0)                             as occupied_sqm,
  coalesce(oc.occupied_cbm, 0)                             as occupied_cbm,
  coalesce(oc.locations_used, 0)                           as locations_used,
  greatest(coalesce(al.contracted,0) - coalesce(oc.occupied,0), 0) as remaining_positions,
  greatest(coalesce(oc.occupied,0) - coalesce(al.contracted,0), 0) as overage_positions,
  round(100.0 * coalesce(oc.occupied,0) / nullif(coalesce(al.contracted,0),0), 1) as utilization_pct,
  coalesce(rs.reserved, 0)                                 as reserved_positions,
  rs.next_expiry                                           as reservation_next_expiry
from sales.accounts c
left join alloc al on al.client_id = c.id
left join occ   oc on oc.client_id = c.id
left join resv  rs on rs.client_id = c.id
where (al.client_id is not null or oc.client_id is not null or rs.client_id is not null)
  and (platform.is_internal() or c.id = platform.current_client_id());

comment on view wms.client_space_overview is
 'مساحة العميل: المتعاقد/المشغول/المتبقي/التجاوز — بلا مواقع تفصيلية · security_invoker (v4 · D-13)';

create or replace view wms.space_trend_30d as
with d as (
  select o.snapshot_date, o.space_block_id,
         sum(o.pallets_occupied) as p, sum(o.sqm_occupied) as s,
         sum(o.cbm_occupied) as c, sum(o.locations_used) as lu,
         count(distinct o.client_id) as clients
  from wms.occupancy_snapshots o
  where o.snapshot_date > current_date - 30 and o.snapshot_date <= current_date
  group by 1,2)
select
  d.snapshot_date,
  w.code             as warehouse,
  b.code             as block,
  b.block_type,
  b.uom,
  b.capacity_pallets as capacity_positions,
  d.p                as occupied_positions,
  d.s                as occupied_sqm,
  d.c                as occupied_cbm,
  d.lu               as locations_used,
  d.clients          as clients_in_block,
  round(100.0 * d.p / nullif(b.capacity_pallets,0), 1) as utilization_pct
from d
join wms.space_blocks b on b.id = d.space_block_id
join wms.warehouses  w on w.id = b.warehouse_id;

comment on view wms.space_trend_30d is
 'اتجاه الإشغال 30 يوماً لكل كتلة من occupancy_snapshots — مُدخل توقّع الامتلاء (v4 · D-13)';

create or replace view wms.reservations_aging as
select
  r.id                             as reservation_id,
  w.code                           as warehouse,
  b.code                           as block,
  b.block_type,
  r.uom,
  c.code                           as client_code,
  c.name_ar                        as client_name,
  r.quote_id, r.opportunity_id, r.qty, r.reason,
  r.reserved_from, r.expires_at,
  (current_date - r.reserved_from) as age_days,
  (r.expires_at - current_date)    as days_to_expiry,
  (r.expires_at - r.reserved_from) as duration_days,
  ((r.expires_at - r.reserved_from)
    > (select t.value from platform.thresholds t where t.key = 'space.reservation_max_days')::int)
                                   as exceeds_max_days,
  case when r.expires_at <  current_date     then 'expired'
       when r.expires_at - current_date <= 3 then 'le_3_days'
       when r.expires_at - current_date <= 7 then 'le_7_days'
       else                                       'gt_7_days' end as expiry_bucket,
  r.reserved_by, r.approved_by, r.created_at
from wms.space_reservations r
join wms.space_blocks b on b.id = r.block_id
join wms.warehouses  w on w.id = b.warehouse_id
left join sales.accounts c on c.id = r.client_id
where r.status = 'active';

comment on view wms.reservations_aging is
 'أعمار الحجوزات النشطة وقرب انتهائها ومخالفة حد 30 يوماً (v4 · D-13)';

create or replace function wms.trg_space_reservation_guard()
returns trigger language plpgsql as $fn$
declare v_max int; v_sellable numeric; v_code text; v_delta numeric;
begin
  select t.value::int into v_max
    from platform.thresholds t where t.key = 'space.reservation_max_days';
  v_max := coalesce(v_max, 30);

  if (new.expires_at - new.reserved_from) > v_max then
    raise exception
      'مدة الحجز % يوماً تتجاوز الحد المعتمد % يوماً — ما زاد يتطلب اعتماد CFO (EXEC §1.1)',
      (new.expires_at - new.reserved_from), v_max;
  end if;

  if new.status = 'active' then
    v_delta := new.qty - case when tg_op = 'UPDATE' and old.status = 'active'
                              then old.qty else 0 end;
    if v_delta > 0 then
      select sa.sellable, sa.block_code into v_sellable, v_code
        from wms.space_availability(new.block_id, new.reserved_from, new.expires_at) sa;
      if v_sellable < v_delta then
        raise exception
          'المتاح للبيع في الكتلة % هو % فقط والمطلوب حجزه % — لا بيع لمساحة غير موجودة (17 §4-1)',
          v_code, v_sellable, v_delta;
      end if;
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists space_reservation_guard on wms.space_reservations;
create trigger space_reservation_guard
  before insert or update on wms.space_reservations
  for each row execute function wms.trg_space_reservation_guard();

create or replace function wms.convert_reservation(
  p_reservation uuid, p_contract uuid, p_service uuid,
  p_valid_from date, p_valid_to date, p_actor uuid)
returns uuid language plpgsql as $fn$
declare v_r wms.space_reservations; v_alloc uuid;
begin
  select * into v_r from wms.space_reservations where id = p_reservation for update;
  if not found then raise exception 'الحجز % غير موجود', p_reservation; end if;
  if v_r.status <> 'active' then
    raise exception 'الحجز % حالته % — لا يُحوَّل إلا الحجز النشط', p_reservation, v_r.status;
  end if;
  if v_r.client_id is null then
    raise exception 'الحجز % بلا عميل — لا يمكن تحويله إلى تخصيص تعاقدي', p_reservation;
  end if;

  -- 1) يُقفَل الحجز أولاً حتى لا تُحتسب كميته مرتين داخل sellable
  update wms.space_reservations set status = 'converted' where id = p_reservation;

  -- 2) الحارس القائم على التخصيص
  perform wms.check_space_available(v_r.block_id, v_r.qty, p_valid_from, p_valid_to);

  insert into wms.space_allocations
    (entity_id, contract_id, client_id, block_id, alloc_type, qty, uom,
     service_id, valid_from, valid_to, status, created_by)
  values (v_r.entity_id, p_contract, v_r.client_id, v_r.block_id, 'dedicated',
          v_r.qty, v_r.uom, p_service, p_valid_from, p_valid_to, 'active', p_actor)
  returning id into v_alloc;

  update wms.space_reservations
     set converted_allocation_id = v_alloc where id = p_reservation;
  return v_alloc;
end $fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-SP-2 · تصحيح `wms.space_dashboard` — ق-40 (13 §8-1 · §8-2)
--   يُعاد تعريفه ليقرأ **آخر لقطة ≤ اليوم** وليرشّح التخصيصات والحجوزات
--   بمدى السريان تماماً كما يفعل `wms.space_availability()` و`space_by_type`،
--   فيطابق مجاميعَهما (اختبار T14). بقية الأعمدة كما في 17 §5 (v4).
-- ═══════════════════════════════════════════════════════════════════════════

drop view if exists wms.space_dashboard;
create view wms.space_dashboard as
with snap as (
  select max(snapshot_date) as d from wms.occupancy_snapshots where snapshot_date <= current_date)
select
  w.code as warehouse, b.code as block, b.block_type,
  b.uom,                                        -- v4 (13 §8-7): لا جمع عبر وحدات مختلفة
  (select d from snap)          as as_of,       -- v4 ق-40 ①: تاريخ اللقطة معلن على اللوحة
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
-- v4 ق-40 ②: التخصيص يُرشَّح بمدى السريان كما في wms.space_availability()
left join (select block_id, sum(qty) contracted from wms.space_allocations
            where status='active'
              and valid_from <= current_date
              and (valid_to is null or valid_to >= current_date)
            group by 1) a on a.block_id = b.id
left join (select block_id, sum(qty) reserved from wms.space_reservations
            where status='active'
              and reserved_from <= current_date
              and expires_at >= current_date
            group by 1) r on r.block_id = b.id
-- v4 ق-40 ①: آخر لقطة ≤ اليوم بدل current_date - 1
left join (select os.space_block_id, sum(os.pallets_occupied) occupied
             from wms.occupancy_snapshots os, snap
            where os.snapshot_date = snap.d
            group by 1) o on o.space_block_id = b.id
where b.status = 'active';

comment on view wms.space_dashboard is
  'المصدر الرسمي للمتاح للبيع (17 §5). v4 SCH-6 ق-40: آخر لقطة ≤ اليوم + ترشيح '
  'التخصيصات بمدى السريان — فيطابق wms.space_by_type (13 §8-1 · §8-2 · اختبار T14)';

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-SP-3 · سياسات العميل على الإشغال والحجز — ق-41 (13 §8-4)
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists client_portal_scope on wms.occupancy_snapshots;
create policy client_portal_scope on wms.occupancy_snapshots
  for select using (platform.is_internal() or client_id = platform.current_client_id());

drop policy if exists client_portal_scope on wms.space_reservations;
create policy client_portal_scope on wms.space_reservations
  for select using (platform.is_internal() or client_id = platform.current_client_id());
-- ملاحظة ق-41: الحجز بلا عميل (client_id is null) لا يراه أحد من الخارج.
--   وإظهار «محجوز لك» في نافذة العميل قرار تجاري مفتوح (13 §8-5).

commit;

-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  13B-SC · عمولة المبيعات — SCR-SC-01 (طلب المدير العام 21/09)           ║
-- ║  المصدر: D-blueprints/14-Sales-Compensation.md §4                       ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- سجل قرارات SCH-6 · الحزمة الثانية
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-43 · الكتلة منقولة **حرفياً** من 14 §4: تعميم `hr.commission_rules`
--        بالأعمدة الستة عشر وقيودها العشرة · `hr.sales_commission_events`
--        بقيوده التسعة وحارس الانتقالات والفهرس الفريد · و
--        `sales.account_ownership_history`. أربعة تعديلات `-- v4` فقط:
--        ① `changed_by = '<gm_user_id>'` نصّ لا uuid ⇒ المعرّف الصفري.
--        ② `on conflict do nothing` لبذرتَي العتبات والعدّاد.
--        ③ `own_sales_commission` تصير `as restrictive` (انظر ق-44).
--        ④ صلاحية `hr.commission.read_all` تُبذر وتُمنح لثلاثة أدوار (ق-45).
--
-- ق-44 · عزل صفوف العمولة: النصّ الأصلي يكتب `own_sales_commission`
--        **permissive**، وسياسات PostgreSQL المسموحة تُجمع بـ**OR** — فكان
--        `entity_scope` وحده يكفي أي مستخدم في الكيان ليرى عمولات زملائه،
--        وهي بيانات أجور. جُعلت **`as restrictive`** فتُجمع بـAND:
--        **الموظف يرى صفوفه، وحامل `hr.commission.read_all` يرى الكل.**
--        (النمط نفسه المستعمل في عزل طوابير الكول سنتر — ق-25.)
--
-- ق-45 · الصلاحية `hr.commission.read_all` تُبذر في `identity.permissions`
--        وتُمنح لـ**`SALES_MGR` · `CFO` · `GM`** عبر `identity.role_permissions`
--        — وهم من يقرأ كشوف العمولة كاملةً (14 §5 · R-04). بلا هذه البذرة
--        تعيد `platform.has_perm()` القيمةَ false دائماً فلا يرى أحد إلا صفّه.
--
-- ق-46 · **لا تُبذر أي قاعدة عمولة مبيعات.** 14 §1 يعرض أربعة نماذج
--        (متكررة · مرة واحدة · مختلط · راتب فقط) و§8 يجعل اختيار النموذج
--        والنِّسَب **قرار GM (D-14)**. الجدول والقيود جاهزة، والصفّ الأول
--        يكتبه GM. وقاعدة السائق المبذورة في SCH-2 تبقى كما هي وتمرّ بقيد
--        `chk_commission_rules_driver_shape` بلا تعديل.
--
-- ق-47 · العتبات الثلاث عشرة بُذرت بقيمها الابتدائية، وكلٌّ موسومة في
--        `description_ar` بـ**`(ابتدائية — قرار GM · D-14 §8)`** فلا تُقرأ
--        يوماً كقيمة محسومة. ومنها `max_monthly_kwd = 0` و
--        `duration_months = 24` — و`0` تعني «بلا سقف» بنصّ الوثيقة.
--
-- ق-48 · `applies_to` يقبل `'driver' · 'sales_rep' · 'sales_mgr'` كما في نصّ
--        14 §4-2 — لا `'sales'` مجرّدة: الوثيقة تفرّق بين المندوب والمدير
--        لأن `manager_override_pct` نسبة إشرافية مستقلة.
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-SC-0 · الدالتان المساعدتان — تُعرَّفان هنا لأن سياسة ق-44 تستعملهما
--   (قرارهما وتسميتهما موثّقان في ق-50 ضمن 13B-FB · المصدر 15 §8)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function platform.my_roles() returns text[]
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(array_agg(distinct r.code), '{}')
  from identity.user_roles ur
  join identity.roles r on r.id = ur.role_id
  where ur.user_id = platform.current_user_id()
    and ur.revoked_at is null
$$;
comment on function platform.my_roles is
  '15 §8: أدوار المستخدم الحالي — أساس ترشيح بنود platform.my_work بالدور (SCR-FB-01)';

create or replace function platform.my_employee_id() returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select u.employee_id from identity.users u where u.id = platform.current_user_id()
$$;
comment on function platform.my_employee_id is
  '15 §8: معرّف الموظف المرتبط بالمستخدم الحالي — أساس ترشيح البنود المكلَّف بها (SCR-FB-01)';

-- ═══════════════════════════════════════════════════════════════════
-- SCR-SC-01 · عمولة المبيعات — تعميم قواعد العمولة + سجل الاستحقاق
-- ═══════════════════════════════════════════════════════════════════

-- 1) تعميم hr.commission_rules ليقبل قواعد المبيعات
alter table hr.commission_rules
  alter column rate_per_unit drop not null,
  add column basis                   text not null default 'per_unit',
  add column revenue_basis           text not null default 'collected',
  add column service_category        text not null default 'all',
  add column rate_pct                numeric(6,3),
  add column one_time_multiplier     numeric(6,3),
  add column split_on_sign_pct       numeric(6,3),
  add column split_on_execute_pct    numeric(6,3),
  add column duration_months         integer,
  add column max_monthly             numeric(14,3),
  add column min_margin_pct          numeric(6,3),
  add column clawback_on_credit_note boolean not null default true,
  add column collection_max_days     integer,
  add column manager_override_pct    numeric(6,3),
  add column approved_by             uuid,
  add column approved_at             timestamptz;

alter table hr.commission_rules
  add constraint chk_commission_rules_applies_to
    check (applies_to in ('driver','sales_rep','sales_mgr')),
  add constraint chk_commission_rules_basis
    check (basis in ('per_unit','recurring','one_time','hybrid')),
  add constraint chk_commission_rules_revenue_basis
    check (revenue_basis in ('collected','invoiced')),
  add constraint chk_commission_rules_category
    check (service_category in ('ST','HD','OF','VA','DL','CC','IT','all')),
  -- قاعدة السائق تبقى كما هي: سعر بالوحدة إلزامي
  add constraint chk_commission_rules_driver_shape
    check (applies_to <> 'driver' or (basis = 'per_unit' and rate_per_unit is not null)),
  -- قاعدة المبيعات: نسبة مئوية إلزامية
  add constraint chk_commission_rules_sales_shape
    check (applies_to = 'driver' or (basis <> 'per_unit' and rate_pct is not null)),
  -- المرة الواحدة: مجموع الشريحتين = 100
  add constraint chk_commission_rules_split_sum
    check (basis not in ('one_time','hybrid')
           or (coalesce(split_on_sign_pct,0) + coalesce(split_on_execute_pct,0) = 100)),
  add constraint chk_commission_rules_one_time_mult
    check (basis not in ('one_time','hybrid') or one_time_multiplier is not null),
  add constraint chk_commission_rules_duration
    check (duration_months is null or duration_months > 0),
  add constraint chk_commission_rules_rate_pct_range
    check (rate_pct is null or (rate_pct >= 0 and rate_pct <= 100)),
  add constraint chk_commission_rules_valid_window
    check (valid_to is null or valid_to > valid_from);

comment on column hr.commission_rules.basis is
  'per_unit سائق · recurring متكررة ما استمر العميل · one_time مرة واحدة عند التعاقد والتنفيذ · hybrid مختلط — SCR-SC-01';
comment on column hr.commission_rules.revenue_basis is
  'collected المحصَّل فعلاً وهو الافتراضي · invoiced المفوتر — قرار GM · SCR-SC-01';

-- 2) سجل استحقاق عمولة المبيعات
create table hr.sales_commission_events (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references platform.entities(id),
  period             date not null,                        -- أول يوم من شهر الاستحقاق
  employee_id        uuid not null references hr.employees(id),
  user_id            uuid references identity.users(id),
  role_kind          text not null default 'sales_rep',
  client_id          uuid not null references sales.accounts(id),
  contract_id        uuid references sales.contracts(id),
  rule_id            uuid not null references hr.commission_rules(id),
  event_kind         text not null,
  service_category   text,
  source_table       text not null,                        -- نفس نمط billing.billable_events
  source_id          uuid not null,
  base_amount        numeric(14,3) not null,
  rate_pct           numeric(6,3),
  amount             numeric(14,3) not null,               -- موجب استحقاق · سالب استرداد
  currency           char(3) not null default 'KWD',
  margin_pct_at_calc numeric(8,4),
  share_pct          numeric(6,3) not null default 100,    -- حصة المندوب عند نقل الحساب
  status             text not null default 'accrued',
  rule_snapshot      jsonb not null,
  calc_snapshot      jsonb not null,
  dispute_note       text,
  disputed_at        timestamptz,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  approved_by        uuid,
  approved_at        timestamptz,
  payroll_period     date,
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  constraint chk_sce_status
    check (status in ('accrued','under_review','disputed','approved','paid','clawed_back','rejected')),
  constraint chk_sce_event_kind
    check (event_kind in ('recurring_collection','one_time_sign','one_time_execute',
                          'clawback_credit_note','manager_override','adjustment')),
  constraint chk_sce_clawback_sign
    check ((event_kind = 'clawback_credit_note' and amount <= 0)
        or (event_kind <> 'clawback_credit_note' and event_kind <> 'adjustment' and amount >= 0)
        or  event_kind = 'adjustment'),
  constraint chk_sce_approved_has_approver
    check (status not in ('approved','paid') or (approved_by is not null and approved_at is not null)),
  constraint chk_sce_paid_has_period
    check (status <> 'paid' or payroll_period is not null),
  constraint chk_sce_dispute_has_note
    check (status <> 'disputed' or dispute_note is not null),
  constraint chk_sce_period_first_day
    check (period = date_trunc('month', period)::date),
  constraint chk_sce_share_pct
    check (share_pct > 0 and share_pct <= 100)
);

-- لا استحقاق مزدوج على المصدر نفسه لنفس المندوب ونفس نوع الحدث ونفس فئة الخدمة
create unique index sales_commission_events_source_uniq
  on hr.sales_commission_events
     (source_table, source_id, employee_id, event_kind, coalesce(service_category,'-'));
create index sales_commission_events_emp_period_idx
  on hr.sales_commission_events (employee_id, period desc);
create index sales_commission_events_period_status_idx
  on hr.sales_commission_events (period, status);
create index sales_commission_events_client_idx
  on hr.sales_commission_events (client_id, period desc);

comment on table hr.sales_commission_events is
  'استحقاق عمولة المبيعات لكل تحصيل أو إشعار دائن أو عقد — SCR-SC-01';

alter table hr.sales_commission_events enable row level security;
create policy entity_scope on hr.sales_commission_events
  using (entity_id = any (platform.allowed_entities()));
-- v4 ③ (SCH-6 ق-44): `as restrictive` — السياسات المسموحة تُجمع بـOR، فلو بقيت
--   permissive لأتاح `entity_scope` وحده لكل مستخدم في الكيان رؤية عمولات زملائه.
--   restrictive تُجمع بـAND فتضيّق: الموظف يرى صفوفه، وحامل الصلاحية يرى الكل.
-- v4 ⑤ (SCH-6 ق-44): الاستعلام الفرعي الأصلي على identity.users يُنفَّذ بصلاحية
--   القارئ لا بصلاحية مالك السياسة، فيتطلب منح select على identity.users لكل دور
--   تطبيق — أُثبت معملياً بـ«permission denied for table users». البديل:
--   platform.my_employee_id() وهي security definer (ق-50) فتعمل بلا منح إضافي.
create policy own_sales_commission on hr.sales_commission_events
  as restrictive for select
  using (platform.has_perm('hr.commission.read_all')
      or employee_id = platform.my_employee_id());

-- 3) تاريخ ملكية الحساب — نقل الحساب بين المندوبين
create table sales.account_ownership_history (
  id                   uuid primary key default gen_random_uuid(),
  entity_id            uuid not null references platform.entities(id),
  account_id           uuid not null references sales.accounts(id),
  owner_user_id        uuid not null references identity.users(id),
  employee_id          uuid references hr.employees(id),
  role_kind            text not null default 'sales_rep',
  valid_from           date not null,
  valid_to             date,                              -- null = المالك الحالي
  commission_share_pct numeric(6,3) not null default 100,
  transfer_reason      text,
  changed_by           uuid,
  created_at           timestamptz not null default now(),
  constraint chk_aoh_role_kind check (role_kind in ('sales_rep','sales_mgr')),
  constraint chk_aoh_window    check (valid_to is null or valid_to > valid_from),
  constraint chk_aoh_share     check (commission_share_pct > 0 and commission_share_pct <= 100),
  constraint chk_aoh_transfer_has_reason
    check (valid_to is null or transfer_reason is not null)
);

create unique index account_ownership_current_uniq
  on sales.account_ownership_history (account_id, role_kind)
  where valid_to is null;
create index account_ownership_owner_idx
  on sales.account_ownership_history (owner_user_id, valid_from desc);

comment on table sales.account_ownership_history is
  'سجل ملكية حساب العميل بتاريخ — أساس تقسيم العمولة عند نقل الحساب — SCR-SC-01';

alter table sales.account_ownership_history enable row level security;
create policy entity_scope on sales.account_ownership_history
  using (entity_id = any (platform.allowed_entities()));

-- 4) حارس انتقالات الحالة
create or replace function hr.guard_sales_commission_status() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
         (old.status = 'accrued'      and new.status in ('under_review','disputed','rejected'))
      or (old.status = 'under_review' and new.status in ('approved','disputed','rejected'))
      or (old.status = 'disputed'     and new.status in ('under_review','rejected'))
      or (old.status = 'approved'     and new.status in ('paid','clawed_back'))
      or (old.status = 'paid'         and new.status = 'clawed_back')
    ) then
      raise exception 'انتقال حالة عمولة غير مسموح: % ⇒ % — SCR-SC-01', old.status, new.status;
    end if;
  end if;
  return new;
end $$;

create trigger trg_guard_sales_commission_status
  before update on hr.sales_commission_events
  for each row execute function hr.guard_sales_commission_status();

-- 5) العتبات الابتدائية — كلها معلَّمة «قرار GM»
insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
 ('sales.commission.rate_storage_pct', 3.000, 'pct', 'نسبة عمولة التخزين ST — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.rate_services_pct', 5.000, 'pct', 'نسبة عمولة الخدمات HD/OF/VA — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.rate_delivery_pct', 2.000, 'pct', 'نسبة عمولة التوصيل DL — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.rate_cc_pct', 3.000, 'pct', 'نسبة عمولة الكول سنتر CC — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.one_time_multiplier', 1.000, 'ratio', 'مضاعف عمولة المرة الواحدة من متوسط الفوترة الشهرية — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.split_on_sign_pct', 50.000, 'pct', 'حصة دفعة التوقيع من عمولة المرة الواحدة — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.split_on_execute_pct', 50.000, 'pct', 'حصة دفعة بدء التنفيذ الفعلي — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.duration_months', 24.000, 'months', 'مدة استمرار العمولة المتكررة — 0 = بلا نهاية — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.max_monthly_kwd',      0.000,  'KWD',    'سقف العمولة الشهرية للمندوب — 0 = بلا سقف — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)',          '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.collection_max_days', 60.000, 'days', 'لا عمولة على تحصيل تأخّر أكثر من هذه المدة — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.manager_override_pct', 0.500, 'pct', 'النسبة الإشرافية لمدير المبيعات — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.min_margin_pct', 15.000, 'pct', 'لا عمولة على عقد تحت هذا الهامش إلا بموافقة GM — EXEC §1.1 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000'),
 ('sales.commission.dispute_window_hours', 48.000, 'hours', 'نافذة اعتراض المندوب على كشف العمولة — SCR-SC-01 (ابتدائية — قرار GM · D-14 §8)', '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;   -- v4 ②

-- 6) عدّاد مستند كشف العمولة لكل كيان
insert into platform.counters (entity_id, doc_type, period, prefix, padding)
select id, 'SCM', 'ALL', code || '-SCM-', 5 from platform.entities
on conflict do nothing;   -- v4 ②

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-SC-2 · صلاحية قراءة كشوف العمولة كاملةً — ق-45
-- ═══════════════════════════════════════════════════════════════════════════

insert into identity.permissions (code, module, object, action, description) values
 ('hr.commission.read_all','hr','commission','read',
  'قراءة كشوف عمولة المبيعات لكل المندوبين — SALES_MGR · CFO · GM (SCR-SC-01)')
on conflict (code) do nothing;

insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
from identity.roles r
cross join identity.permissions p
where p.code = 'hr.commission.read_all'
  and r.code in ('SALES_MGR','CFO','GM')
on conflict do nothing;

-- ملاحظة ق-46: لا صفّ في hr.commission_rules بـapplies_to in ('sales_rep','sales_mgr').
--   النموذج والنِّسَب قرار GM (D-14) — الجدول جاهز والصفّ الأول يكتبه GM.

commit;

-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  13B-FB · لوحات التركيز — SCR-FB-01 (طلب المدير العام 21/09)            ║
-- ║  المصدر: D-blueprints/15-Focus-Boards-UX.md §1-4 · §8                   ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- سجل قرارات SCH-6 · الحزمة الثالثة
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ق-49 · `platform.my_work` منقول **حرفياً** من 15 §1-4: أحد عشر مصدراً
--        بـ`union all` في ستة عشر عموداً موحّداً. المصادر الأحد عشر:
--        صندوق القرارات · التنبيهات غير المُقرّة · مهام أوامر العمل ·
--        مهام التوصيل · تذاكر الكول سنتر · ملفات الاستقدام · المعاملات
--        الحكومية · طلبات الشراء · خطوات سلاسل الاعتماد · حجوزات المساحة
--        المقاربة للانتهاء · القضايا التأديبية الموجَّهة لصاحب سلطة أعلى.
--
-- ق-50 · الدالتان المساعدتان: 15 §8 يسمّيهما **`platform.my_roles()`** و
--        **`platform.my_employee_id()`** — في مخطط `platform` نظير
--        `current_user_id()` و`current_client_id()` و`allowed_entities()`
--        الموجودة أصلاً في 01 §0، لا في `identity`. أُنشئتا هناك التزاماً
--        بالنصّ، وكلتاهما `security definer` لتقرآ `identity.user_roles`
--        و`identity.users` بلا ارتداد على سياساتهما (نمط `platform.has_perm`).
--        العرض نفسه لا يستدعيهما — الترشيح يقع فوقه كما في 15 §7 F-2:
--        `where (owner_kind='employee' and owner_id = platform.my_employee_id())
--            or (owner_kind='role'     and owner_role = any(platform.my_roles()))`
--
-- ق-51 · العتبة `work.at_risk_pct = 80`: النسبة الوحيدة المنصوصة في الحزمة
--        هي 80% للتنبيه **N-14** وحده (تذكرة تتجاوز 80% من SLA)، وتعميمها
--        على المصادر الأحد عشر **اجتهاد** أقرّته 15 §1-3 و§8 (B-7). بُذرت
--        موسومة `(ابتدائية — قرار GM)`. ⚠️ العرض يحسب الـ80% **مضمَّنة في
--        تعبيره** (`>= 0.80 * …`) كما في النصّ — فالعتبة اليوم **معلَنة لا
--        نافذة**؛ ربطها بالعرض يحتاج إعادة كتابته بدالة، وهو تغيير لم تنصّ
--        عليه الوثيقة. مسجَّل في «ما لم يُنفَّذ».
--
-- ق-52 · العرض بلا RLS خاصة به: هو `security definer` بحكم الافتراض ويقرأ
--        جداول كلها عليها RLS. الأمان يأتي من الجداول المصدر ومن ترشيح
--        الدور فوق العرض (ق-50). والحارس G7 لا يعدّ العروض — يعدّ
--        `relkind = 'r'` وحدها.
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-FB-1 · الدالتان المساعدتان — 15 §8 (ق-50)
--   عُرِّفتا فعلاً في 13B-SC-0 لأن سياسة ق-44 تسبقهما في الملف؛ تُعاد هنا
--   بـ`create or replace` تثبيتاً للمصدر ولقابلية إعادة التشغيل.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function platform.my_roles() returns text[]
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(array_agg(distinct r.code), '{}')
  from identity.user_roles ur
  join identity.roles r on r.id = ur.role_id
  where ur.user_id = platform.current_user_id()
    and ur.revoked_at is null
$$;
comment on function platform.my_roles is
  '15 §8: أدوار المستخدم الحالي — أساس ترشيح بنود platform.my_work بالدور (SCR-FB-01)';

create or replace function platform.my_employee_id() returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select u.employee_id from identity.users u where u.id = platform.current_user_id()
$$;
comment on function platform.my_employee_id is
  '15 §8: معرّف الموظف المرتبط بالمستخدم الحالي — أساس ترشيح البنود المكلَّف بها (SCR-FB-01)';

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-FB-2 · العرض الموحّد — 15 §1-4 (منقول حرفياً)
-- ═══════════════════════════════════════════════════════════════════════════

drop view if exists platform.my_work;   -- v4: قابلية إعادة التشغيل (16 عموداً قد تتغيّر)
-- platform.my_work — العرض الموحّد لبنود العمل (SCR-FB-01)
create or replace view platform.my_work as
with src as (

  -- 1) بنود صندوق القرارات
  select 'decision'::text                                   as kind,
         'DEC-'||left(d.id::text,8)                          as ref,
         d.title_ar                                          as title,
         case
           when d.source_table in ('wms.outbound_orders','wms.order_lines') then 'fulfilment'
           when d.source_table = 'wms.inbound_orders'        then 'inbound'
           when d.source_table like 'wms.%'                  then 'storage'
           when d.source_table like 'tms.%'                  then 'delivery'
           when d.source_table like 'imile.%'                then 'imile'
           when d.source_table like 'cc.%'                   then 'callcenter'
           when d.source_table like 'sales.%'                then 'sales'
           when d.source_table like 'catalog.%'              then 'sales'
           when d.source_table like 'billing.%'              then 'billing'
           when d.source_table like 'partners.%'             then 'billing'
           when d.source_table like 'hr.%'                   then 'hr'
           when d.source_table like 'admin.%'                then 'admin_gov'
           when d.source_table like 'housing.%'              then 'housing'
           else 'governance'
         end                                                 as process_group,
         'role'::text                                        as owner_kind,
         d.assigned_role                                     as owner_role,
         d.assigned_user_id                                  as owner_id,
         d.created_at                                        as started_at,
         d.due_at                                            as due_at,
         d.urgency                                           as priority,
         '/inbox?kind='||d.kind                              as action_link,
         'platform.decisions'::text                          as source_table,
         d.id                                                as source_id,
         d.entity_id                                         as entity_id
  from platform.decisions d
  where d.status = 'open'

  union all

  -- 2) تنبيهات غير مُقرّة ولا محلولة
  select 'alert',
         a.rule_code,
         r.name_ar,
         case a.rule_code
           when 'N-01' then 'imile'      when 'N-02' then 'imile'
           when 'N-03' then 'delivery'   when 'N-04' then 'hr'
           when 'N-05' then 'fleet'      when 'N-06' then 'sales'
           when 'N-07' then 'billing'    when 'N-08' then 'billing'
           when 'N-09' then 'billing'    when 'N-10' then 'billing'
           when 'N-11' then 'storage'    when 'N-12' then 'sales'
           when 'N-13' then 'storage'    when 'N-14' then 'callcenter'
           when 'N-15' then 'admin_gov'  when 'N-16' then 'hr'
           when 'N-17' then 'approvals'  when 'N-21' then 'billing'
           else 'governance'
         end,
         'role',
         r.target_roles[1],
         null::uuid,
         a.fired_at,
         case when r.escalate_after_hours is not null
              then a.fired_at + make_interval(hours => r.escalate_after_hours) end,
         case when r.escalate_after_hours is not null and r.escalate_after_hours <= 24
              then 'high' else 'normal' end,
         r.action_link,
         'platform.alert_log',
         null::uuid,
         null::uuid
  from platform.alert_log a
  join platform.alert_rules r on r.code = a.rule_code
  where a.acknowledged_at is null
    and a.resolved_at is null
    and r.is_active

  union all

  -- 3) مهام أوامر العمل داخل المستودع
  select 'wo_task',
         wo.doc_no||'/'||t.line_no::text,
         wo.task_type||' · '||coalesce(acc.name_ar, wo.doc_no),
         case wo.task_type
           when 'receive'  then 'inbound'
           when 'putaway'  then 'storage'  when 'transfer' then 'storage'
           when 'count'    then 'storage'  when 'scrap'    then 'storage'
           else 'fulfilment'
         end,
         case when t.worker_id is not null then 'employee' else 'role' end,
         coalesce(tty.default_role, 'WH_OP'),
         t.worker_id,
         coalesce(t.assigned_at, t.created_at),
         wo.due_at,
         case when wo.is_rush then 'urgent'
              when wo.priority <= 3 then 'high'
              else 'normal' end,
         '/wms/work-orders/'||wo.id::text,
         'wms.work_order_tasks',
         t.id,
         wo.entity_id
  from wms.work_order_tasks t
  join wms.work_orders wo on wo.id = t.work_order_id
  left join sales.accounts acc on acc.id = wo.client_id
  left join lateral (
        select min(k.default_role) as default_role
        from wms.work_order_task_types k
        where k.task_type = wo.task_type) tty on true
  where t.status in ('queued','assigned','accepted','in_progress','paused')
    and wo.status in ('released','in_progress','on_hold')

  union all

  -- 4) مهام التوصيل
  select 'delivery_task',
         dt.doc_no,
         coalesce(dt.recipient_name,'—')||' · '||coalesce(dt.area,'—'),
         'delivery',
         case when dt.driver_id is not null then 'employee' else 'role' end,
         case when dt.driver_id is not null then 'DRIVER' else 'DEL_MGR' end,
         dt.driver_id,
         coalesce(dt.assigned_at, dt.created_at),
         dt.time_slot_to,
         case when dt.attempt_no > 1 then 'high'
              when dt.is_same_day then 'high'
              else 'normal' end,
         '/tms/tasks/'||dt.id::text,
         'tms.delivery_tasks',
         dt.id,
         dt.entity_id
  from tms.delivery_tasks dt
  where dt.status in ('created','assigned','out_for_delivery','deferred')

  union all

  -- 5) تذاكر الكول سنتر
  select 'ticket',
         tk.doc_no,
         tk.subject,
         'callcenter',
         case when ag.employee_id is not null then 'employee' else 'role' end,
         case when tk.assigned_to is not null then 'CC_AGENT' else 'CC_MGR' end,
         ag.employee_id,
         tk.created_at,
         tk.sla_due_at,
         tk.priority,
         '/cc/tickets/'||tk.id::text,
         'cc.tickets',
         tk.id,
         tk.entity_id
  from cc.tickets tk
  left join cc.agents ag on ag.id = tk.assigned_to
  where tk.status in ('open','in_progress','pending_client','pending_internal','reopened')

  union all

  -- 6) ملفات الاستقدام — مالك المرحلة
  select 'recruitment_stage',
         rc.doc_no,
         rc.candidate_name||' · '||coalesce(rs.name_ar, rc.stage),
         'hr',
         'employee',
         coalesce(rs.default_owner_role,'PRO'),
         rc.stage_owner,
         rc.stage_started_at,
         rc.due_at,
         case when rc.blocked_reason is not null then 'high' else 'normal' end,
         '/hr/recruitment/'||rc.id::text,
         'hr.recruitment_cases',
         rc.id,
         rc.entity_id
  from hr.recruitment_cases rc
  left join hr.recruitment_stages rs on rs.code = rc.stage
  where rc.completed_at is null
    and rc.outcome is null

  union all

  -- 7) المعاملات الحكومية
  select 'gov_transaction',
         gt.doc_no,
         gt.transaction_type||' · '||gt.authority,
         'admin_gov',
         'employee',
         'PRO',
         gt.stage_owner,
         gt.stage_started_at,
         gt.due_at,
         case when gt.blocked_reason is not null then 'high' else 'normal' end,
         '/admin/gov/'||gt.id::text,
         'admin.gov_transactions',
         gt.id,
         gt.entity_id
  from admin.gov_transactions gt
  where gt.stage in ('requested','submitted','in_progress')

  union all

  -- 8) طلبات الشراء بانتظار الاعتماد
  select 'purchase_request',
         pr.doc_no,
         pr.description,
         'approvals',
         'role',
         coalesce((select ch.approver_role
                   from platform.approval_chains ch
                   where ch.request_type = 'purchase' and ch.is_active
                     and pr.estimated_amount >= coalesce(ch.min_amount, 0)
                     and pr.estimated_amount <  coalesce(ch.max_amount, 1e15)
                   order by ch.step_no limit 1), 'GM'),
         null::uuid,
         pr.created_at,
         pr.needed_by::timestamptz,
         pr.urgency,
         '/inbox?kind=purchase_approval',
         'admin.purchase_requests',
         pr.id,
         pr.entity_id
  from admin.purchase_requests pr
  where pr.status = 'pending_approval'

  union all

  -- 9) خطوات سلاسل الاعتماد المفتوحة
  select 'approval_step',
         ar.doc_no||'/'||st.step_no::text,
         ar.request_type||' · '||coalesce(ar.amount::text,'—'),
         'approvals',
         case when st.approver_user_id is not null then 'user' else 'role' end,
         st.approver_role,
         st.approver_user_id,
         ar.created_at,
         ar.due_at,
         case when coalesce(ar.amount,0) >= 2000 then 'high' else 'normal' end,
         '/inbox?kind=approval',
         'admin.approval_steps',
         st.id,
         ar.entity_id
  from admin.approval_requests ar
  join admin.approval_steps st
    on st.request_id = ar.id and st.step_no = ar.current_step
  where ar.status = 'pending'
    and st.decision is null

  union all

  -- 10) حجوزات المساحة المقاربة للانتهاء
  select 'space_reservation',
         'RSV-'||left(sr.id::text,8),
         coalesce(acc.name_ar,'—')||' · '||sr.qty::text||' '||sr.uom,
         'sales',
         'role',
         'SALES_MGR',
         sr.reserved_by,
         sr.created_at,
         sr.expires_at::timestamptz,
         'normal',
         '/wms/space/reservations',
         'wms.space_reservations',
         sr.id,
         sr.entity_id
  from wms.space_reservations sr
  left join sales.accounts acc on acc.id = sr.client_id
  where sr.status = 'active'
    and sr.expires_at <= current_date + 7

  union all

  -- 11) القضايا التأديبية الموجَّهة لصاحب سلطة أعلى
  select 'disciplinary_case',
         dc.doc_no,
         coalesce(emp.name_ar,'—')||' · '||dc.penalty_code,
         'hr',
         'employee',
         coalesce(dc.signer_role,'HR_MGR'),
         dc.routed_to,
         dc.created_at,
         null::timestamptz,
         'high',
         '/hr/disciplinary/'||dc.id::text,
         'hr.disciplinary_cases',
         dc.id,
         dc.entity_id
  from hr.disciplinary_cases dc
  left join hr.employees emp on emp.id = dc.employee_id
  where dc.status in ('draft','pending_authority','grievance_filed')
    and dc.routed_to is not null
)
select s.kind,
       s.ref,
       s.title,
       s.process_group,
       s.owner_kind,
       s.owner_role,
       s.owner_id,
       s.due_at,
       s.priority,
       case
         when s.due_at is null then 'no_sla'
         when now() > s.due_at then 'overdue'
         when s.started_at is not null
              and extract(epoch from (now() - s.started_at))
                  >= 0.80 * nullif(extract(epoch from (s.due_at - s.started_at)), 0)
           then 'at_risk'
         else 'on_time'
       end                                                     as sla_state,
       s.action_link,
       s.source_table,
       s.source_id,
       s.entity_id,
       s.started_at,
       (case when s.due_at is not null and now() > s.due_at then 0 else 1 end) * 1000
         + case s.priority when 'urgent' then 0 when 'high' then 1
                           when 'normal' then 2 else 3 end      as sort_bucket
from src s;

comment on view platform.my_work is
 'بنود العمل المفتوحة موحَّدة من أحد عشر مصدراً — أساس لوحات التركيز (SCR-FB-01)';

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-FB-3 · الفهارس الأربعة — 15 §1-4
--   (فهرس platform.decisions موجود أصلاً من 29 §7 — لا يُعاد إنشاؤه)
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists ix_wo_tasks_worker_open  on wms.work_order_tasks (worker_id, status);
create index if not exists ix_del_tasks_driver_open on tms.delivery_tasks   (driver_id, status);
create index if not exists ix_tickets_assigned_open on cc.tickets           (assigned_to, status, sla_due_at);
create index if not exists ix_alert_log_unack       on platform.alert_log   (rule_code, fired_at)
       where acknowledged_at is null and resolved_at is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13B-FB-4 · عتبة نسبة الخطر — ق-51 (15 §1-3 · §8 B-7)
-- ═══════════════════════════════════════════════════════════════════════════

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
 ('work.at_risk_pct', 80.000, 'pct',
  'نسبة انقضاء نافذة SLA التي يصير عندها البند at_risk في لوحات التركيز — '
  'مأخوذة من منطق N-14 ومعمَّمة على المصادر الأحد عشر (ابتدائية — قرار GM · 15 §8 B-7)',
  '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- التحقق بعد حزم SCH-6
-- ═══════════════════════════════════════════════════════════════════════════
--   select count(*) from information_schema.views
--    where table_schema='wms' and table_name in
--      ('space_by_type','client_space_overview','space_trend_30d','reservations_aging');  -- 4
--   select count(*) from platform.thresholds where key like 'sales.commission.%';         -- 13
--   select count(*) from platform.thresholds where key = 'work.at_risk_pct';              -- 1
--   select count(*) from platform.counters   where doc_type = 'SCM';                      -- 5
--   select count(*) from platform.my_work;   -- يعمل بلا خطأ (قاعدة فارغة ⇒ 0)
--   -- اتساق T14: مجموع sellable في العرضين متطابق
--   select (select sum(sellable_positions) from wms.space_by_type)
--        = (select sum(sellable)           from wms.space_dashboard) as t14_match;
-- ═══════════════════════════════════════════════════════════════════════════
