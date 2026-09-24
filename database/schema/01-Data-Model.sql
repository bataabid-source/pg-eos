-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · نظام تشغيل بريميوم جروب — المخطط التنفيذي الكامل
-- وثيقة 01 من 09 · PostgreSQL 16 · الإصدار 1.1 · 23/09/2026
--
-- اتفاقيات تسري على كل جدول:
--   · المفتاح الأساسي: uuid
--   · رقم المستند البشري: doc_no من عدّاد ذرّي، فريد، لا يُعاد استخدامه
--   · التوقيت: timestamptz (UTC مخزَّن، Asia/Kuwait معروض)
--   · المال: numeric(14,3) — ثلاث خانات للدينار. لا float إطلاقاً
--   · الحذف: منطقي (deleted_at). لا حذف فعلي في أي نطاق مالي أو مخزني
--   · كل جدول تجاري/تشغيلي يحمل entity_id — محور المحاسبة متعددة الكيانات
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

create schema if not exists platform;
create schema if not exists identity;
create schema if not exists sales;
create schema if not exists catalog;
create schema if not exists wms;
create schema if not exists tms;
create schema if not exists cc;
create schema if not exists billing;
create schema if not exists hr;
create schema if not exists imile;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. دوال السياق — أساس RLS
-- ═══════════════════════════════════════════════════════════════════════════

-- المستخدم الحالي يُحقَن من الخدمة الخلفية في كل معاملة
create or replace function platform.current_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true),'')::uuid $$;

create or replace function platform.current_client_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.client_id', true),'')::uuid $$;

create or replace function platform.is_internal() returns boolean
language sql stable as $$ select coalesce(current_setting('app.is_internal', true),'false')::boolean $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. المنصة (platform)
-- ═══════════════════════════════════════════════════════════════════════════

-- الكيانات القانونية الأربعة — جذر بنية متعدد الكيانات
create table platform.entities (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,              -- PCC · PST · PDL · POR
  name_ar         text not null,
  name_en         text not null,
  legal_name_ar   text not null,
  legal_name_en   text,
  cr_number       text,                              -- السجل التجاري
  tax_number      text,
  license_number  text,
  address_ar      text, address_en text,
  phone           text, email text, website text,
  logo_url        text,
  base_currency   char(3) not null default 'KWD',
  fiscal_year_end date,
  entity_kind     text not null default 'operating',   -- holding · operating
  parent_id       uuid references platform.entities(id),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint holding_has_no_parent check (entity_kind <> 'holding' or parent_id is null)
);
comment on table platform.entities is 'الكيانات القانونية. الشركة القابضة (holding) جذر الشجرة وتحمل التكاليف المشتركة والعقود الإطارية فقط؛ الكيانات التشغيلية (operating) وحدها تُصدر فواتير العملاء';

-- إعدادات لكل كيان أو عامة
create table platform.settings (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid references platform.entities(id),  -- null = إعداد عام للمجموعة
  key         text not null,
  value       jsonb not null,
  data_type   text not null default 'string',
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (entity_id, key)
);

-- العدّادات — الترقيم الذرّي (P3/P10). لا يُقرأ آخر رقم من جدول أبداً
create table platform.counters (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  doc_type    text not null,           -- INV · CN · RCT · GOV · INB · OUT · QTE · CTR · TSK · TKT  (v4 SCH-2: RCP محذوفة)
  period      text not null,           -- 'ALL' أو 'YYYY' أو 'YYYY-MM' حسب سياسة النوع
  prefix      text not null,
  padding     int  not null default 5,
  current_val bigint not null default 0,
  unique (entity_id, doc_type, period)
);

-- v1.2 (migration 0009, WBS 2.9): SECURITY DEFINER + pinned search_path + entity-scope gate, so
-- operational users can allocate numbers under RLS (platform.counters' reference_write needs
-- platform.reference.manage). Revoke/grant/owner check live in 0009 (pgeos_app is created by 0007).
create or replace function platform.next_doc_no(
  p_entity uuid, p_doc_type text, p_period text default 'ALL'
) returns text language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_prefix text; v_pad int; v_val bigint;
begin
  if not exists (select 1 from pg_roles where rolname = session_user and (rolsuper or rolbypassrls))
     and not (platform.is_internal() and p_entity = any(platform.allowed_entities())) then
    raise exception using errcode = '42501',
      message = format('0009: entity %s is outside the caller''s allowed_entities()', p_entity);
  end if;

  update platform.counters
     set current_val = current_val + 1
   where entity_id = p_entity and doc_type = p_doc_type and period = p_period
  returning prefix, padding, current_val into v_prefix, v_pad, v_val;

  if not found then
    raise exception 'عدّاد غير معرّف: % / % / %', p_entity, p_doc_type, p_period;
  end if;

  return v_prefix || lpad(v_val::text, v_pad, '0');
end $$;
comment on function platform.next_doc_no is 'ترقيم ذرّي داخل معاملة. UPDATE..RETURNING يقفل الصف فلا يتكرر رقم عند التزامن';

-- سجل التدقيق — دفتر لا يُعدَّل (P3/P7)
create table platform.audit_log (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),
  user_id      uuid,
  actor_type   text not null default 'user',   -- user · agent · system · ai
  entity_id    uuid,
  schema_name  text not null,
  table_name   text not null,
  record_id    uuid,
  operation    text not null,                  -- insert · update · delete · approve · reject · login
  old_value    jsonb,                          -- الحقول المالية معقّمة قبل الكتابة
  new_value    jsonb,
  ip_address   inet,
  user_agent   text,
  context      jsonb
);
create index on platform.audit_log (table_name, record_id, occurred_at desc);
create index on platform.audit_log (user_id, occurred_at desc);
create index on platform.audit_log (occurred_at);
revoke update, delete on platform.audit_log from public;

-- v4 (ق-2 · R-02): جدول platform.domain_events أُزيل من هذا الملف — الحاكم هو platform.outbox
--   المعرَّف في 13B (40 §B3 · 36 §3-1). كان هنا جدولاً بأعمدة مختلفة (occurred_at/processed_at)
--   بلا correlation/causation ولا entity_id. 13B يحمل `drop table if exists` احترازياً للقواعد المبنية من v3.

-- محرّك الوثائق (P8) — الوثيقة مخرَج من عملية لا مدخل لها
create table platform.document_templates (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,       -- INV-01 · GRN-01 · DO-01 · POD-01 · QTE-01
  name_ar      text not null, name_en text,
  entity_id    uuid references platform.entities(id),  -- null = قالب مشترك
  body_html    text not null,              -- Handlebars/Mustache
  page_size    text not null default 'A4',
  orientation  text not null default 'portrait',
  is_bilingual boolean not null default true,
  version      int not null default 1,
  is_active    boolean not null default true
);

create table platform.document_bindings (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references platform.document_templates(id),
  source_table   text not null,      -- billing.invoices
  trigger_state  text not null,      -- approved  ← يُولَّد عند الانتقال لهذه الحالة
  auto_generate  boolean not null default true,
  unique (template_id, source_table, trigger_state)
);
comment on table platform.document_bindings is 'لا تبويب نماذج. كل مستند مربوط بعملية وانتقال حالة يولّده تلقائياً';

create table platform.documents (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  template_id   uuid not null references platform.document_templates(id),
  doc_no        text not null,
  source_table  text not null,
  source_id     uuid not null,
  rendered_data jsonb not null,      -- لقطة مجمَّدة من البيانات وقت التوليد
  file_url      text,
  version       int not null default 1,
  superseded_by uuid references platform.documents(id),
  generated_at  timestamptz not null default now(),
  generated_by  uuid,
  unique (entity_id, doc_no)
);
create index on platform.documents (source_table, source_id);

create table platform.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  entity_id   uuid,
  channel     text not null,          -- in_app · email · whatsapp · sms
  severity    text not null default 'info',
  title       text not null,
  body        text,
  link        text,
  sent_at     timestamptz,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table platform.integration_runs (
  id            uuid primary key default gen_random_uuid(),
  integration   text not null,        -- imile_agent · oula · biometric · whatsapp
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',
  records_in    int default 0,
  records_out   int default 0,
  error_message text,
  details       jsonb
);
create index on platform.integration_runs (integration, started_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. الهوية والوصول (identity) — M01
-- ═══════════════════════════════════════════════════════════════════════════

create table identity.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  full_name_ar  text not null, full_name_en text,
  phone         text,
  employee_id   uuid,                        -- ربط اختياري بـ hr.employees
  user_type     text not null default 'internal',  -- internal · client · agent
  client_id     uuid,                        -- لمستخدمي نافذة العميل فقط
  is_active     boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  constraint client_user_has_client check (user_type <> 'client' or client_id is not null)
);

create table identity.roles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_ar     text not null, name_en text,
  scope_type  text not null default 'all',   -- v4: ثمانية نطاقات — القيد valid_scope في 13B (all · entity · org_unit · subordinates · assigned · account · client · self)
  description text
);

create table identity.permissions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- wms.inbound.approve · billing.invoice.approve
  module      text not null,
  object      text not null,
  action      text not null,                 -- read · create · update · approve · delete · export
  description text
);

create table identity.role_permissions (
  role_id       uuid not null references identity.roles(id) on delete cascade,
  permission_id uuid not null references identity.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table identity.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references identity.users(id) on delete cascade,
  role_id     uuid not null references identity.roles(id),
  granted_at  timestamptz not null default now(),
  granted_by  uuid,
  revoked_at  timestamptz,
  revoked_by  uuid
);
create unique index on identity.user_roles (user_id, role_id) where revoked_at is null;

-- أي كيانات يرى المستخدم
create table identity.user_entities (
  user_id   uuid not null references identity.users(id) on delete cascade,
  entity_id uuid not null references platform.entities(id),
  primary key (user_id, entity_id)
);

create table identity.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references identity.users(id) on delete cascade,
  token_hash   text not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  ip_address   inet,
  user_agent   text
);
create index on identity.sessions (user_id, expires_at);

create table identity.otp_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  code_hash  text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts   int not null default 0
);

-- تصنيف حساسية الأعمدة (إصلاح E-02 بنيوياً: تصنيف في المخطط لا نمط نصّي)
create table identity.column_classification (
  schema_name text not null,
  table_name  text not null,
  column_name text not null,
  sensitivity text not null,   -- public · personal · payroll · commercial · secret
  primary key (schema_name, table_name, column_name)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2b. دوال الصلاحيات والنطاق — تُعرَّف بعد جداول identity لأن دوال SQL تُتحقَّق أجسامها عند الإنشاء
--     (v4 fix S-01: كانت قبل الجداول فتفشل، فتفشل كل سياسات RLS التي تعتمد عليها)
-- ═══════════════════════════════════════════════════════════════════════════

-- هل للمستخدم الحالي صلاحية معيّنة؟
create or replace function platform.has_perm(p_code text) returns boolean
language sql stable security definer as $$
  select exists (
    select 1
    from identity.user_roles ur
    join identity.role_permissions rp on rp.role_id = ur.role_id
    join identity.permissions p       on p.id = rp.permission_id
    where ur.user_id = platform.current_user_id()
      and p.code = p_code
      and ur.revoked_at is null
  )
$$;

-- نطاق الكيانات المسموح بها للمستخدم
create or replace function platform.allowed_entities() returns uuid[]
language sql stable security definer as $$
  select coalesce(array_agg(distinct ue.entity_id), '{}')
  from identity.user_entities ue
  where ue.user_id = platform.current_user_id()
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. الكتالوج والتسعير (catalog) — M03
-- ═══════════════════════════════════════════════════════════════════════════

create table catalog.service_categories (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,     -- ST · HD · OF · DL · VA · CC · IT
  name_ar  text not null, name_en text,
  sort_order int not null default 0
);

create table catalog.services (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,          -- ST-01 · HD-04 · DL-11 · CC-03
  category_id   uuid not null references catalog.service_categories(id),
  name_ar       text not null, name_en text,
  description   text,
  uom           text not null,                 -- pallet · sqm · cbm · carton · shipment · trip · km · call · minute · seat · month
  billing_basis text not null,                 -- per_unit · per_event · monthly_fixed · tiered · percentage
  entity_id     uuid references platform.entities(id),  -- الكيان الذي يقدّمها؛ null = أكثر من كيان
  min_price     numeric(14,3),                 -- الحد الأدنى — قاعدة منع البيع بالخسارة
  standard_cost numeric(14,3),                 -- التكلفة المعيارية لحساب الهامش
  requires_contract_clause boolean not null default false,  -- DL-11/12/13 تتطلب بنداً صريحاً
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
comment on column catalog.services.min_price is 'بدونه قاعدة منع البيع بالخسارة معطّلة — بوابة بيانات M03';

create table catalog.segments (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,      -- SEG-A … SEG-F
  name_ar      text not null, name_en text,
  rank         int not null,
  criteria     jsonb not null,            -- {min_monthly_revenue, min_pallets, min_shipments, ...}
  discount_pct numeric(6,3) default 0,
  review_cycle text not null default 'quarterly'
);

create table catalog.price_lists (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  code         text not null,
  name_ar      text not null,
  segment_id   uuid references catalog.segments(id),   -- قائمة شريحة
  client_id    uuid,                                   -- أو قائمة عميل بعينه
  valid_from   date not null,
  valid_to     date,
  is_internal  boolean not null default false,         -- قائمة التسعير التحويلي بين الكيانات
  status       text not null default 'draft',          -- draft · active · expired
  unique (entity_id, code)
);

create table catalog.price_list_lines (
  id            uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references catalog.price_lists(id) on delete cascade,
  service_id    uuid not null references catalog.services(id),
  price         numeric(14,3) not null,
  currency      char(3) not null default 'KWD',
  tier_from     numeric(14,3),            -- التسعير المتدرّج: احتساب تصاعدي لا بسعر الشريحة الأخيرة
  tier_to       numeric(14,3),
  free_units    numeric(14,3) default 0,  -- مثل: أيام سماح التخزين
  notes         text,
  unique (price_list_id, service_id, tier_from)
);

-- استثناء السعر تحت الحد الأدنى — بصلاحية المدير العام حصراً
create table catalog.price_exceptions (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  client_id     uuid not null,
  service_id    uuid not null references catalog.services(id),
  approved_price numeric(14,3) not null,
  min_price_at_approval numeric(14,3) not null,
  reason        text not null,
  valid_from    date not null,
  valid_to      date not null,
  approved_by   uuid not null,
  approved_at   timestamptz not null default now(),
  review_at     date not null
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. المبيعات و CRM (sales) — M02 · موحّد لكل المجموعة
-- ═══════════════════════════════════════════════════════════════════════════

-- الحساب: سجل واحد للعميل مهما تعدّدت الكيانات التي يتعامل معها
create table sales.accounts (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name_ar        text not null, name_en text,
  legal_name     text,
  cr_number      text,
  tax_number     text,
  account_type   text not null,          -- prospect · client · partner · vendor
  client_kind    text,                   -- 3pl · 2pl · delivery_b2c · delivery_b2b · cc_external · cc_internal · mixed
  industry       text,
  segment_id     uuid references catalog.segments(id),
  owner_user_id  uuid references identity.users(id),   -- مسؤول الحساب
  -- الائتمان يُضبط على مستوى المجموعة ويُستهلك من كل الكيانات
  credit_limit   numeric(14,3) default 0,
  credit_hold    boolean not null default false,
  hold_reason    text,
  hold_set_by    uuid,
  hold_set_at    timestamptz,
  payment_terms_days int default 30,
  address_ar     text, address_en text, area text, governorate text,
  phone text, email text, website text,
  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index on sales.accounts (cr_number) where cr_number is not null and deleted_at is null;
comment on column sales.accounts.credit_limit is 'على مستوى المجموعة — العميل المتعثّر متعثّر لدى الكيانات الأربعة';

create table sales.contacts (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references sales.accounts(id) on delete cascade,
  name        text not null,
  title       text,
  email       text, phone text, whatsapp text,
  role_type   text,                    -- decision_maker · operations · finance · technical
  is_primary  boolean not null default false,
  notes       text
);

create table sales.leads (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null,
  source        text,                  -- referral · website · cold_call · campaign · existing_client
  company_name  text not null,
  contact_name  text, phone text, email text,
  interest      text[],                -- ['storage','delivery','cc']
  status        text not null default 'new',  -- new · contacted · qualified · converted · lost
  lost_reason   text,
  owner_user_id uuid references identity.users(id),
  converted_account_id uuid references sales.accounts(id),
  created_at    timestamptz not null default now()
);

create table sales.opportunities (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null,
  account_id      uuid not null references sales.accounts(id),
  entity_id       uuid not null references platform.entities(id),  -- أي كيان سيقدّم الخدمة
  name            text not null,
  stage           text not null default 'qualification',
  -- qualification · needs_analysis · proposal · negotiation · won · lost
  expected_value  numeric(14,3),
  expected_margin_pct numeric(6,3),
  probability     int default 10,
  expected_close  date,
  owner_user_id   uuid references identity.users(id),
  services_scope  uuid[],              -- خدمات الكتالوج محل الفرصة
  lost_reason     text,                -- price · service · timing · competitor · no_decision
  competitor      text,
  closed_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index on sales.opportunities (account_id, stage);
create index on sales.opportunities (owner_user_id, expected_close);

create table sales.activities (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid references sales.accounts(id),
  opportunity_id uuid references sales.opportunities(id),
  activity_type text not null,         -- call · meeting · email · visit · quote_sent · follow_up
  subject       text not null,
  notes         text,
  due_at        timestamptz,
  completed_at  timestamptz,
  outcome       text,
  owner_user_id uuid references identity.users(id),
  created_at    timestamptz not null default now()
);
create index on sales.activities (owner_user_id, due_at) where completed_at is null;

create table sales.quotes (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references platform.entities(id),
  doc_no         text not null,
  account_id     uuid not null references sales.accounts(id),
  opportunity_id uuid references sales.opportunities(id),
  status         text not null default 'draft',
  -- draft · finance_review · approved · sent · accepted · rejected · expired
  valid_until    date not null,
  currency       char(3) not null default 'KWD',
  subtotal       numeric(14,3) not null default 0,
  discount_amt   numeric(14,3) not null default 0,
  total          numeric(14,3) not null default 0,
  estimated_margin_pct numeric(6,3),
  terms_ar       text, terms_en text,
  frozen_snapshot jsonb,            -- نسخة مجمَّدة عند الإرسال — لا تُعدَّل بعدها
  prepared_by    uuid, reviewed_by uuid, approved_by uuid,
  sent_at timestamptz, decided_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (entity_id, doc_no)
);

create table sales.quote_lines (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references sales.quotes(id) on delete cascade,
  service_id  uuid not null references catalog.services(id),
  description text,
  qty         numeric(14,3) not null default 1,
  uom         text not null,
  unit_price  numeric(14,3) not null,
  min_price_at_quote numeric(14,3),
  below_min   boolean generated always as (
                unit_price < coalesce(min_price_at_quote, 0)
              ) stored,
  exception_id uuid references catalog.price_exceptions(id),
  line_total  numeric(14,3) not null,
  sort_order  int not null default 0,
  -- الضابط البنيوي: لا سطر تحت الحد الأدنى بلا استثناء معتمد
  constraint below_min_needs_exception check (
    unit_price >= coalesce(min_price_at_quote, 0) or exception_id is not null
  )
);

create table sales.contracts (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references platform.entities(id),
  doc_no          text not null,
  account_id      uuid not null references sales.accounts(id),
  quote_id        uuid references sales.quotes(id),
  title           text not null,
  status          text not null default 'draft',
  -- draft · signed · active · suspended · expired · renewed · terminated
  start_date      date not null,
  end_date        date,
  auto_renew      boolean not null default false,
  notice_days     int default 30,
  billing_cycle   text not null default 'monthly',   -- monthly · semi_monthly · per_event
  payment_terms_days int not null default 30,
  price_list_id   uuid references catalog.price_lists(id),
  -- البنود التي بدونها لا تُفوتر الحالات الاستثنائية
  bills_failed_attempt boolean not null default false,
  bills_return         boolean not null default false,
  bills_waiting        boolean not null default false,
  min_monthly_charge   numeric(14,3) default 0,
  sla_enabled     boolean not null default false,
  signed_at       timestamptz, signed_by_client text,
  file_url        text,
  created_at      timestamptz not null default now(),
  unique (entity_id, doc_no)
);
create index on sales.contracts (account_id, status);

create table sales.contract_sla (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references sales.contracts(id) on delete cascade,
  metric       text not null,          -- otd_pct · inventory_accuracy · pick_time_min · damage_pct · answer_rate · aht_sec
  target_value numeric(14,3) not null,
  direction    text not null default 'min',   -- min = لا يقل عن · max = لا يزيد عن
  penalty_type text,                    -- pct_of_monthly · fixed · none
  penalty_value numeric(14,3),
  bonus_value  numeric(14,3)
);

create table sales.sla_results (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references sales.contracts(id),
  sla_id       uuid not null references sales.contract_sla(id),
  period       date not null,          -- أول يوم في الشهر المقاس
  actual_value numeric(14,3) not null,
  met          boolean not null,
  penalty_amt  numeric(14,3) default 0,
  computed_at  timestamptz not null default now(),
  unique (sla_id, period)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. المستودع (wms) — M04 · PST
-- ═══════════════════════════════════════════════════════════════════════════

create table wms.warehouses (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  code      text not null unique,
  name_ar   text not null, name_en text,
  address   text, area text,
  total_sqm numeric(14,3),
  is_active boolean not null default true
);

create table wms.zones (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references wms.warehouses(id),
  code         text not null,          -- A · A1 · B · B1 · C · C1 · E · RCV · QRT · STG · SHP · RTN · DMG
  name_ar      text not null,
  zone_type    text not null,          -- storage · receiving · quarantine · staging · shipping · returns · damaged
  temp_min     numeric(6,2), temp_max numeric(6,2),
  is_secure    boolean not null default false,
  unique (warehouse_id, code)
);

create table wms.locations (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references wms.warehouses(id),
  zone_id      uuid not null references wms.zones(id),
  code         text not null,          -- WH1-A-03-R02-L4-B007
  aisle        text, rack text, level text, bin text,
  location_type text not null default 'pallet',   -- pallet · shelf · floor · mezzanine · bulk
  capacity_pallets numeric(8,2) default 1,
  max_weight_kg numeric(10,2),
  assigned_client_id uuid references sales.accounts(id),  -- تخصيص لعميل بعينه
  barcode      text,
  is_blocked   boolean not null default false,
  block_reason text,
  unique (warehouse_id, code)
);
create index on wms.locations (zone_id, is_blocked);
create index on wms.locations (assigned_client_id);

create table wms.skus (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references sales.accounts(id),   -- الصنف مملوك لعميل — فصل إلزامي
  code          text not null,
  client_sku    text,
  barcode       text, carton_barcode text,
  name_ar       text not null, name_en text,
  category      text, subcategory text, brand text, origin_country text,
  -- القياسات
  length_cm numeric(8,2), width_cm numeric(8,2), height_cm numeric(8,2),
  net_weight_kg numeric(10,3), gross_weight_kg numeric(10,3), volume_cbm numeric(10,4),
  -- التعبئة الهرمية
  units_per_pack int, packs_per_carton int, cartons_per_layer int, layers_per_pallet int,
  units_per_pallet int generated always as (
    coalesce(units_per_pack,1)*coalesce(packs_per_carton,1)*coalesce(cartons_per_layer,1)*coalesce(layers_per_pallet,1)
  ) stored,
  -- شروط التخزين
  temp_min numeric(6,2), temp_max numeric(6,2),
  stackable boolean default true, max_stack_height int,
  is_fragile boolean default false, is_hazmat boolean default false, un_class text,
  light_sensitive boolean default false,
  -- التتبّع والصلاحية
  track_batch boolean not null default false,
  track_serial boolean not null default false,
  track_expiry boolean not null default false,
  picking_policy text not null default 'FIFO',   -- FIFO · FEFO · LIFO
  shelf_life_days int,
  min_remaining_life_receipt_days int,
  min_remaining_life_issue_days int,
  quarantine_days int default 0,
  -- المخزون
  min_stock numeric(14,3), max_stock numeric(14,3), reorder_point numeric(14,3),
  abc_class char(1),
  unit_value numeric(14,3),
  image_url text, msds_url text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (client_id, code)
);
create index on wms.skus (barcode);
create index on wms.skus (client_id, status);

-- الدفتر غير القابل للتعديل (P3)
create table wms.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  occurred_at   timestamptz not null default now(),
  movement_type text not null,
  -- receipt · putaway · pick · issue · transfer · adjust · count · damage · return · scrap
  client_id     uuid not null references sales.accounts(id),
  sku_id        uuid not null references wms.skus(id),
  from_location_id uuid references wms.locations(id),
  to_location_id   uuid references wms.locations(id),
  qty           numeric(14,3) not null,
  uom           text not null,
  batch_no      text, serial_no text, expiry_date date,
  ref_table     text, ref_id uuid,        -- الأمر الأصل
  reason_code   text, notes text,
  performed_by  uuid not null,
  device_id     text,
  constraint qty_not_zero check (qty <> 0)
);
create index on wms.stock_movements (client_id, sku_id, occurred_at desc);
create index on wms.stock_movements (ref_table, ref_id);
create index on wms.stock_movements (to_location_id, occurred_at desc);
revoke update, delete on wms.stock_movements from public;
comment on table wms.stock_movements is 'دفتر لا يُعدَّل. التصحيح بحركة تسوية مقابلة فقط';

-- الرصيد مشتقّ (P4) — يُعاد بناؤه بالكامل من الدفتر
create table wms.stock_balance (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references sales.accounts(id),
  sku_id      uuid not null references wms.skus(id),
  location_id uuid not null references wms.locations(id),
  batch_no    text not null default '',
  expiry_date date,
  qty_on_hand   numeric(14,3) not null default 0,
  qty_allocated numeric(14,3) not null default 0,
  qty_available numeric(14,3) generated always as (qty_on_hand - qty_allocated) stored,
  last_movement_at timestamptz,
  unique (client_id, sku_id, location_id, batch_no),
  constraint no_negative_stock check (qty_on_hand >= 0)
);

create table wms.inbound_orders (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,
  client_id     uuid not null references sales.accounts(id),
  contract_id   uuid references sales.contracts(id),
  warehouse_id  uuid not null references wms.warehouses(id),
  asn_ref       text,                    -- مرجع العميل
  status        text not null default 'draft',
  -- draft · approved · receiving · received · putaway · closed · cancelled
  expected_at   timestamptz,
  arrived_at    timestamptz,
  vehicle_type  text, container_no text, truck_no text, driver_name text,
  received_by   uuid, closed_at timestamptz, closed_by uuid,
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  unique (entity_id, doc_no)
);

create table wms.outbound_orders (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,
  client_id     uuid not null references sales.accounts(id),
  contract_id   uuid references sales.contracts(id),
  warehouse_id  uuid not null references wms.warehouses(id),
  client_ref    text,
  order_type    text not null default 'standard',   -- standard · rush · transfer · return_to_client
  status        text not null default 'draft',
  -- draft · approved · allocated · picking · picked · checked · packed · loaded · dispatched · delivered · cancelled
  required_by   timestamptz,
  ship_to_name text, ship_to_phone text, ship_to_address text, ship_to_area text,
  delivery_task_id uuid,                 -- ربط بـ TMS
  credit_check_passed boolean,
  credit_checked_at timestamptz,
  picked_by uuid, checked_by uuid, packed_by uuid,
  dispatched_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (entity_id, doc_no)
);
create index on wms.outbound_orders (client_id, status);

create table wms.order_lines (
  id              uuid primary key default gen_random_uuid(),
  order_table     text not null,          -- wms.inbound_orders | wms.outbound_orders
  order_id        uuid not null,
  line_no         int not null,
  sku_id          uuid not null references wms.skus(id),
  qty_ordered     numeric(14,3) not null,
  qty_actual      numeric(14,3),
  uom             text not null,
  batch_no text, serial_no text, expiry_date date,
  location_id     uuid references wms.locations(id),
  variance_reason text,
  status          text not null default 'open',   -- open · partial · complete · cancelled
  -- الضابط: فرق الكمية يتطلب سبباً إلزامياً
  constraint variance_needs_reason check (
    qty_actual is null or qty_actual = qty_ordered or variance_reason is not null
  ),
  unique (order_table, order_id, line_no)
);
create index on wms.order_lines (order_table, order_id);

create table wms.inventory_counts (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  doc_no       text not null,
  warehouse_id uuid not null references wms.warehouses(id),
  client_id    uuid references sales.accounts(id),
  count_type   text not null,       -- full · cycle · spot
  status       text not null default 'draft',   -- draft · in_progress · review · adjusted · closed
  started_at timestamptz, finished_at timestamptz,
  counted_by uuid, approved_by uuid,
  unique (entity_id, doc_no)
);

create table wms.inventory_count_lines (
  id          uuid primary key default gen_random_uuid(),
  count_id    uuid not null references wms.inventory_counts(id) on delete cascade,
  location_id uuid not null references wms.locations(id),
  sku_id      uuid not null references wms.skus(id),
  batch_no    text,
  qty_system  numeric(14,3) not null,
  qty_counted numeric(14,3),
  variance    numeric(14,3) generated always as (coalesce(qty_counted,0) - qty_system) stored,
  recount_qty numeric(14,3),
  variance_reason text,
  adjusted_movement_id uuid references wms.stock_movements(id)
);

-- لقطة الإشغال اليومية — أساس فوترة التخزين
create table wms.occupancy_snapshots (
  id           uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  entity_id    uuid not null references platform.entities(id),
  client_id    uuid not null references sales.accounts(id),
  warehouse_id uuid not null references wms.warehouses(id),
  pallets_occupied numeric(14,3) not null default 0,
  sqm_occupied     numeric(14,3) not null default 0,
  cbm_occupied     numeric(14,3) not null default 0,
  locations_used   int not null default 0,
  unique (snapshot_date, client_id, warehouse_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. التوصيل (tms) — M05 · PDL / POR
-- ═══════════════════════════════════════════════════════════════════════════

create table tms.vehicles (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  plate_no    text not null unique,
  make text, model text, year int,
  vehicle_type text not null,        -- van · pickup · truck_3t · truck_7t · refrigerated · motorcycle
  capacity_kg numeric(10,2), capacity_cbm numeric(10,3),
  is_refrigerated boolean not null default false,
  ownership   text not null default 'owned',   -- owned · leased · subcontracted
  status      text not null default 'active',  -- active · maintenance · idle · disposed
  assigned_driver_id uuid,
  assigned_client_id uuid references sales.accounts(id),  -- للباقات المخصّصة DL-04/05
  odometer_km numeric(12,1)
);

create table tms.vehicle_documents (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references tms.vehicles(id) on delete cascade,
  doc_type    text not null,     -- registration · insurance · permit · inspection
  doc_no      text,
  issue_date date, expiry_date date not null,
  file_url    text,
  alert_days_before int not null default 30
);
create index on tms.vehicle_documents (expiry_date);

create table tms.delivery_tasks (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,
  client_id     uuid not null references sales.accounts(id),
  contract_id   uuid references sales.contracts(id),
  source_type   text not null default 'internal',  -- internal · imile · oula · client_portal · api
  source_ref    text,                               -- رقم الشحنة في نظام المصدر
  outbound_order_id uuid references wms.outbound_orders(id),
  task_type     text not null default 'b2c',        -- b2c · b2b · dedicated_trip · inter_warehouse
  status        text not null default 'created',
  -- created · assigned · out_for_delivery · delivered · failed · returned · cancelled
  recipient_name text, recipient_phone text,
  address_text  text, area text, governorate text, block text, street text, building text,
  geo_lat numeric(10,7), geo_lng numeric(10,7),
  time_slot_from timestamptz, time_slot_to timestamptz,
  is_same_day boolean not null default false,
  is_cod boolean not null default false,
  cod_amount numeric(14,3) default 0,
  cod_collected numeric(14,3) default 0,
  driver_id     uuid,
  vehicle_id    uuid references tms.vehicles(id),
  route_id      uuid,
  assigned_at timestamptz, ofd_at timestamptz, completed_at timestamptz,
  attempt_no    int not null default 1,
  failure_reason text,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no)
);
create index on tms.delivery_tasks (client_id, status, created_at desc);
create index on tms.delivery_tasks (driver_id, status);
create index on tms.delivery_tasks (source_type, source_ref);

create table tms.routes (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references platform.entities(id),
  doc_no     text not null,
  route_date date not null,
  driver_id  uuid, vehicle_id uuid references tms.vehicles(id),
  zones      text[],
  planned_stops int, completed_stops int,
  planned_km numeric(10,2), actual_km numeric(10,2),
  started_at timestamptz, finished_at timestamptz,
  status     text not null default 'planned',
  unique (entity_id, doc_no)
);

create table tms.proof_of_delivery (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tms.delivery_tasks(id) on delete cascade,
  delivered_at timestamptz not null,
  receiver_name text, receiver_id_no text, relation text,
  signature_url text, photo_url text,
  geo_lat numeric(10,7), geo_lng numeric(10,7), geo_accuracy_m numeric(8,2),
  device_id text,
  captured_by uuid not null
);

create table tms.delivery_exceptions (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tms.delivery_tasks(id),
  raised_at   timestamptz not null default now(),
  exception_type text not null,      -- wrong_address · no_answer · refused · damaged · rescheduled · area_blocked
  description text,
  evidence_urls text[],
  resolution  text,
  resolved_at timestamptz, resolved_by uuid,
  is_billable boolean not null default false     -- حسب بند العقد (DL-11/12/13)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. الكول سنتر (cc) — M06 · PCC
-- ═══════════════════════════════════════════════════════════════════════════

create table cc.queues (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  code        text not null unique,
  name_ar     text not null, name_en text,
  client_id   uuid references sales.accounts(id),   -- null = طابور داخلي للمجموعة
  is_internal boolean not null default false,
  channel     text not null default 'voice',        -- voice · whatsapp · email · chat
  working_hours jsonb,
  target_answer_sec int default 20,
  target_abandon_pct numeric(6,3) default 5
);

create table cc.agents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references identity.users(id),
  employee_id uuid,
  extension   text,
  languages   text[] default '{ar,en}',
  skill_level int default 1,
  status      text not null default 'offline',
  hired_at    date
);

create table cc.agent_queues (
  agent_id uuid not null references cc.agents(id) on delete cascade,
  queue_id uuid not null references cc.queues(id) on delete cascade,
  priority int not null default 1,
  primary key (agent_id, queue_id)
);

create table cc.calls (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  queue_id      uuid not null references cc.queues(id),
  client_id     uuid references sales.accounts(id),
  agent_id      uuid references cc.agents(id),
  direction     text not null,         -- inbound · outbound
  caller_number text, called_number text,
  started_at    timestamptz not null,
  answered_at   timestamptz,
  ended_at      timestamptz,
  wait_sec      int generated always as (
                  case when answered_at is not null
                       then extract(epoch from (answered_at - started_at))::int end
                ) stored,
  talk_sec      int generated always as (
                  case when answered_at is not null and ended_at is not null
                       then extract(epoch from (ended_at - answered_at))::int end
                ) stored,
  disposition   text,                  -- answered · abandoned · voicemail · busy · failed
  recording_url text,
  ticket_id     uuid,
  external_ref  text
);
create index on cc.calls (queue_id, started_at desc);
create index on cc.calls (agent_id, started_at desc);
create index on cc.calls (client_id, started_at desc);

create table cc.tickets (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  doc_no      text not null,
  queue_id    uuid not null references cc.queues(id),
  client_id   uuid references sales.accounts(id),
  -- الربط بالتشغيل: تذكرة عن شحنة أو أمر بعينه
  related_table text, related_id uuid,
  channel     text not null default 'voice',
  category    text not null,          -- inquiry · complaint · delivery_issue · stock_issue · billing · other
  subcategory text,
  priority    text not null default 'normal',   -- low · normal · high · urgent
  subject     text not null,
  description text,
  status      text not null default 'open',
  -- open · in_progress · pending_client · pending_internal · resolved · closed · reopened
  assigned_to uuid references cc.agents(id),
  sla_due_at  timestamptz,
  first_response_at timestamptz,
  resolved_at timestamptz, closed_at timestamptz,
  resolution  text,
  satisfaction_score int,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  unique (entity_id, doc_no)
);
create index on cc.tickets (status, sla_due_at);
create index on cc.tickets (client_id, created_at desc);
create index on cc.tickets (related_table, related_id);

create table cc.ticket_events (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references cc.tickets(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  event_type text not null,       -- comment · status_change · assignment · escalation · client_reply
  from_value text, to_value text,
  body       text,
  is_internal boolean not null default false,   -- ملاحظة داخلية لا يراها العميل
  actor_id   uuid
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. المحاسبة والفوترة (billing) — M07 · موحّد
-- ═══════════════════════════════════════════════════════════════════════════

-- الحدث القابل للفوترة — يُولَّد آلياً من أحداث المجال. لا إدخال يدوي (P10)
create table billing.billable_events (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  occurred_at   timestamptz not null,
  client_id     uuid not null references sales.accounts(id),
  contract_id   uuid references sales.contracts(id),
  service_id    uuid not null references catalog.services(id),
  qty           numeric(14,3) not null,
  uom           text not null,
  -- الإثبات: كل حدث يُرَدّ إلى عمليته
  source_module text not null,          -- wms · tms · cc · imile
  source_table  text not null,
  source_id     uuid not null,
  -- التسعير يُحسب عند التجميع لا عند التوليد
  unit_price    numeric(14,3),
  price_source  text,                   -- contract · segment · exception · list
  price_ref_id  uuid,
  amount        numeric(14,3),
  status        text not null default 'pending',
  -- pending · priced · invoiced · excluded · disputed
  exclusion_reason text,
  invoice_line_id uuid,
  is_intercompany boolean not null default false,
  counterparty_entity_id uuid references platform.entities(id),
  created_at    timestamptz not null default now()
);
create index on billing.billable_events (client_id, status, occurred_at);
create index on billing.billable_events (contract_id, occurred_at);
create index on billing.billable_events (source_table, source_id);
create unique index on billing.billable_events (source_table, source_id, service_id);
comment on index billing.billable_events_source_table_source_id_service_id_idx
  is 'يمنع الفوترة المزدوجة لنفس الحدث نهائياً';

create table billing.invoices (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text,                    -- يُخصَّص لحظة الاعتماد فقط — لا قبله
  client_id     uuid not null references sales.accounts(id),
  contract_id   uuid references sales.contracts(id),
  invoice_type  text not null default 'standard',   -- standard · proforma · intercompany
  status        text not null default 'draft',
  -- draft · review · approved · sent · partially_paid · paid · overdue · void
  period_from   date, period_to date,
  issue_date    date, due_date date,
  currency      char(3) not null default 'KWD',
  subtotal      numeric(14,3) not null default 0,
  discount_amt  numeric(14,3) not null default 0,
  tax_amt       numeric(14,3) not null default 0,
  sla_penalty_amt numeric(14,3) not null default 0,
  total         numeric(14,3) not null default 0,
  paid_amount   numeric(14,3) not null default 0,
  balance       numeric(14,3) generated always as (total - paid_amount) stored,
  is_intercompany boolean not null default false,
  counterparty_entity_id uuid references platform.entities(id),
  frozen_snapshot jsonb,                 -- لقطة مجمَّدة عند الاعتماد
  prepared_by uuid, approved_by uuid, approved_at timestamptz,
  sent_at timestamptz, voided_at timestamptz, void_reason text,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no),
  -- الضابط المحاسبي: لا رقم قبل الاعتماد، ولا اعتماد بلا رقم
  constraint doc_no_only_when_approved check (
    (status in ('draft','review') and doc_no is null) or
    (status not in ('draft','review') and doc_no is not null)
  )
);
create index on billing.invoices (client_id, status, due_date);
create index on billing.invoices (entity_id, issue_date);

create table billing.invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references billing.invoices(id) on delete cascade,
  line_no     int not null,
  service_id  uuid not null references catalog.services(id),
  description_ar text not null, description_en text,
  qty         numeric(14,3) not null,
  uom         text not null,
  unit_price  numeric(14,3) not null,
  discount_pct numeric(6,3) default 0,
  line_total  numeric(14,3) not null,
  -- الإثبات الكامل لكل سطر (P10)
  price_source text not null,           -- contract · segment · exception · list
  price_ref_id uuid,
  event_count  int,                     -- كم حدثاً جُمِّع في هذا السطر
  unique (invoice_id, line_no)
);

create table billing.receipts (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  doc_no      text not null,
  client_id   uuid not null references sales.accounts(id),
  received_at date not null,
  method      text not null,            -- bank_transfer · cheque · cash · knet · link
  bank_ref    text, cheque_no text, cheque_date date,
  amount      numeric(14,3) not null,
  allocated_amount numeric(14,3) not null default 0,
  unallocated numeric(14,3) generated always as (amount - allocated_amount) stored,
  -- فصل المهام (D-03): من يسجّل السداد ليس من يعتمد الفاتورة
  recorded_by uuid not null,
  reconciled_by uuid, reconciled_at timestamptz,
  notes text,
  unique (entity_id, doc_no)
);

create table billing.receipt_allocations (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references billing.receipts(id) on delete cascade,
  invoice_id  uuid not null references billing.invoices(id),
  amount      numeric(14,3) not null,
  allocated_at timestamptz not null default now(),
  allocated_by uuid,
  constraint positive_allocation check (amount > 0)
);

create table billing.credit_notes (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  doc_no       text not null,
  client_id    uuid not null references sales.accounts(id),
  invoice_id   uuid not null references billing.invoices(id),   -- إلزامي: لا إشعار بلا فاتورة أصل
  issue_date   date not null,
  reason       text not null,
  amount       numeric(14,3) not null,
  status       text not null default 'draft',   -- draft · approved · applied
  requested_by uuid, approved_by uuid,          -- اعتماد المدير العام (D-03)
  approved_at  timestamptz,
  unique (entity_id, doc_no)
);

-- دليل الحسابات والقيود — دفتر لا يُعدَّل
create table billing.gl_accounts (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  code        text not null,
  name_ar     text not null, name_en text,
  account_type text not null,      -- asset · liability · equity · revenue · expense
  parent_id   uuid references billing.gl_accounts(id),
  is_postable boolean not null default true,
  unique (entity_id, code)
);

create table billing.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  doc_no      text not null,
  entry_date  date not null,
  description text not null,
  source_table text, source_id uuid,
  is_intercompany boolean not null default false,
  posted_at   timestamptz, posted_by uuid,
  reversed_by uuid references billing.journal_entries(id),
  unique (entity_id, doc_no)
);

create table billing.journal_lines (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references billing.journal_entries(id) on delete cascade,
  account_id  uuid not null references billing.gl_accounts(id),
  debit       numeric(14,3) not null default 0,
  credit      numeric(14,3) not null default 0,
  client_id   uuid references sales.accounts(id),
  contract_id uuid references sales.contracts(id),
  cost_center text,
  description text,
  constraint one_side_only check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);

-- تخصيص التكلفة — بدونه لا تُحسب ربحية عميل إطلاقاً
create table billing.cost_allocations (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  period      date not null,
  cost_type   text not null,        -- labour · fuel · space · vehicle · sla_penalty · damage · overhead
  client_id   uuid references sales.accounts(id),
  contract_id uuid references sales.contracts(id),
  amount      numeric(14,3) not null,
  basis       text not null,        -- direct · pallets · shipments · headcount · sqm
  source_table text, source_id uuid,
  computed_at timestamptz not null default now()
);
create index on billing.cost_allocations (period, client_id);

-- الربحية — عرض مشتقّ يُحدَّث شهرياً
create table billing.profitability (
  id          uuid primary key default gen_random_uuid(),
  period      date not null,
  entity_id   uuid not null references platform.entities(id),
  client_id   uuid not null references sales.accounts(id),
  contract_id uuid references sales.contracts(id),
  revenue     numeric(14,3) not null default 0,
  cost_labour numeric(14,3) not null default 0,
  cost_fuel   numeric(14,3) not null default 0,
  cost_space  numeric(14,3) not null default 0,
  cost_vehicle numeric(14,3) not null default 0,
  cost_other  numeric(14,3) not null default 0,
  sla_penalty numeric(14,3) not null default 0,
  margin      numeric(14,3) generated always as (
                revenue - cost_labour - cost_fuel - cost_space - cost_vehicle - cost_other - sla_penalty
              ) stored,
  margin_pct  numeric(8,4),
  computed_at timestamptz not null default now(),
  unique (period, entity_id, client_id, contract_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. الموارد البشرية (hr) — M08 · مختصر؛ التفصيل في وثيقة 03
-- ═══════════════════════════════════════════════════════════════════════════

create table hr.org_units (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  code      text not null unique,
  name_ar   text not null, name_en text,
  unit_type text not null,          -- division · department · section · team
  parent_id uuid references hr.org_units(id),
  manager_employee_id uuid,
  cost_center text
);

create table hr.employees (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  code        text not null unique,
  name_ar     text not null, name_en text,
  civil_id    text,
  nationality text, passport_no text,
  job_title_ar text, job_title_en text,
  org_unit_id uuid references hr.org_units(id),
  reports_to  uuid references hr.employees(id),
  employment_type text not null default 'full_time',
  hire_date   date not null, end_date date,
  status      text not null default 'active',
  -- التخصيص لعميل: أساس تكلفة العمالة المباشرة في الربحية
  assigned_client_id uuid references sales.accounts(id),
  phone text, email text,
  created_at timestamptz not null default now()
);
create index on hr.employees (org_unit_id, status);
create index on hr.employees (assigned_client_id);

create table hr.teams (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references platform.entities(id),
  code       text not null unique,
  name_ar    text not null,
  team_type  text not null,        -- warehouse · delivery · loading · cc · admin
  org_unit_id uuid references hr.org_units(id),
  supervisor_employee_id uuid references hr.employees(id),
  client_id  uuid references sales.accounts(id),
  shift      text
);

create table hr.employee_documents (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references hr.employees(id) on delete cascade,
  doc_type    text not null,     -- residency · passport · license · health_card · contract
  doc_no      text,
  issue_date date, expiry_date date not null,
  file_url    text,
  alert_days_before int not null default 60
);
create index on hr.employee_documents (expiry_date);

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. تشغيل iMile (imile) — M11 · التفصيل في وثيقة 07
-- ═══════════════════════════════════════════════════════════════════════════

create table imile.shipments (
  id            uuid primary key default gen_random_uuid(),
  tracking_no   text not null unique,
  station_code  text not null default 'CSP04',
  batch_id      uuid,
  merchant      text,
  zone_code     text, area text,
  recipient_phone text,
  is_cod boolean default false, cod_amount numeric(14,3),
  is_fresh boolean not null default false,
  imile_status  text,
  internal_status text not null default 'expected',
  -- expected · arrived · sorted · staged · assigned · ofd · delivered · failed · returned
  arrived_at timestamptz, sorted_at timestamptz, assigned_at timestamptz,
  ofd_at timestamptz, closed_at timestamptz,
  cage_code text,
  driver_code text,
  delivery_task_id uuid references tms.delivery_tasks(id),
  attempts int not null default 0,
  last_sync_at timestamptz,
  raw jsonb
);
create index on imile.shipments (internal_status, arrived_at);
create index on imile.shipments (driver_code, ofd_at);
create index on imile.shipments (zone_code);

create table imile.sorting_plans (
  id          uuid primary key default gen_random_uuid(),
  plan_date   date not null,
  generated_at timestamptz not null default now(),
  status      text not null default 'draft',   -- draft · review · approved · executing · closed
  total_shipments int, total_drivers int, total_zones int,
  capacity_warning text,
  approved_by uuid, approved_at timestamptz,
  unique (plan_date)
);

create table imile.plan_assignments (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references imile.sorting_plans(id) on delete cascade,
  driver_code text not null,
  driver_employee_id uuid references hr.employees(id),
  zones       text[] not null,
  cage_code   text,
  planned_count int not null,
  actual_count  int,
  sequence_no int,
  unique (plan_id, driver_code)
);

create table imile.scan_log (
  id          uuid primary key default gen_random_uuid(),
  scanned_at  timestamptz not null default now(),
  tracking_no text not null,
  scan_type   text not null,     -- inbound · sort · cage · handover · inventory · return
  location_code text, cage_code text, driver_code text,
  device_id   text, scanned_by uuid,
  result      text not null,     -- ok · unknown · duplicate · wrong_zone · blocked
  message     text
);
create index on imile.scan_log (tracking_no, scanned_at desc);
create index on imile.scan_log (scan_type, scanned_at desc);

create table imile.dtl_problems (
  id            uuid primary key default gen_random_uuid(),
  tracking_no   text not null,
  raised_at     timestamptz not null,
  driver_code   text,
  problem_type  text,
  gate_result   jsonb,              -- نتائج البوابات G0–G4
  engine_decision text,             -- accept · reject · human · reclassify
  engine_confidence numeric(5,4),
  engine_reason text,
  evidence_urls text[],
  customer_text text, driver_text text,
  auditor_decision text,
  auditor_id    uuid,
  decided_at    timestamptz,
  actual_outcome text,              -- من المصالحة الليلية
  rule_was_correct boolean,
  synced_to_imile_at timestamptz
);
create index on imile.dtl_problems (auditor_decision, raised_at) where auditor_decision is null;
create index on imile.dtl_problems (tracking_no);

create table imile.daily_inventory (
  id            uuid primary key default gen_random_uuid(),
  count_date    date not null,
  started_at timestamptz, finished_at timestamptz,
  system_count int, scanned_count int,
  missing_count int, extra_count int,
  recount_done boolean not null default false,
  unexplained_count int,
  duration_min int generated always as (
    case when finished_at is not null and started_at is not null
         then extract(epoch from (finished_at - started_at))::int / 60 end
  ) stored,
  closed_by uuid,
  unique (count_date)
);

create table imile.inventory_discrepancies (
  id          uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references imile.daily_inventory(id) on delete cascade,
  tracking_no text not null,
  discrepancy_type text not null,   -- missing · extra · wrong_status
  system_status text, physical_status text,
  explanation text,
  resolved_at timestamptz, resolved_by uuid
);

create table imile.agent_health (
  id           uuid primary key default gen_random_uuid(),
  reported_at  timestamptz not null default now(),
  agent_id     text not null,
  session_valid boolean not null,
  last_pull_at timestamptz,
  pending_pushes int default 0,
  engine_version text,
  error_message text
);
create index on imile.agent_health (reported_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. أمن مستوى الصف (RLS) — P6
--     الطبقة التي تحمي حتى عند خطأ برمجي في الواجهة
-- ═══════════════════════════════════════════════════════════════════════════

-- نمط 1: الجداول التشغيلية — حصر بالكيان المسموح للمستخدم
alter table wms.inbound_orders   enable row level security;
alter table wms.outbound_orders  enable row level security;
alter table wms.stock_movements  enable row level security;
alter table tms.delivery_tasks   enable row level security;
alter table cc.tickets           enable row level security;
alter table billing.invoices     enable row level security;
alter table billing.billable_events enable row level security;
alter table sales.accounts       enable row level security;
alter table sales.contracts      enable row level security;
alter table sales.quotes         enable row level security;

create policy entity_scope on wms.outbound_orders
  for all using (entity_id = any(platform.allowed_entities()));

create policy entity_scope on wms.inbound_orders
  for all using (entity_id = any(platform.allowed_entities()));

create policy entity_scope on tms.delivery_tasks
  for all using (entity_id = any(platform.allowed_entities()));

create policy entity_scope on cc.tickets
  for all using (entity_id = any(platform.allowed_entities()));

create policy entity_scope on billing.invoices
  for all using (entity_id = any(platform.allowed_entities()));

-- نمط 2: نافذة العميل — العميل لا يرى إلا صفوفه، مفروضاً في القاعدة
create policy client_portal_scope on wms.outbound_orders
  for select using (
    platform.is_internal() or client_id = platform.current_client_id()
  );

create policy client_portal_scope on tms.delivery_tasks
  for select using (
    platform.is_internal() or client_id = platform.current_client_id()
  );

create policy client_portal_scope on billing.invoices
  for select using (
    platform.is_internal() or client_id = platform.current_client_id()
  );

create policy client_portal_scope on sales.accounts
  for select using (
    platform.is_internal() or id = platform.current_client_id()
  );

-- نمط 3: أصناف العميل — فصل صارم يمنع خلط عميلين
alter table wms.skus enable row level security;
create policy sku_client_scope on wms.skus
  for all using (
    platform.is_internal() or client_id = platform.current_client_id()
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. اختبارات السلامة الدائمة — تُشغَّل قبل كل نشر
-- ═══════════════════════════════════════════════════════════════════════════

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

-- توازن القيود المحاسبية
create or replace function billing.verify_journal_balance()
returns table (entry_id uuid, doc_no text, total_debit numeric, total_credit numeric)
language sql stable as $$
  select e.id, e.doc_no, sum(l.debit), sum(l.credit)
  from billing.journal_entries e
  join billing.journal_lines l on l.entry_id = e.id
  group by e.id, e.doc_no
  having sum(l.debit) <> sum(l.credit)
$$;

-- أحداث فوترة بلا سعر — الإيراد الضائع الصامت
create or replace function billing.verify_unpriced_events()
returns table (client_id uuid, service_id uuid, event_count bigint, oldest timestamptz)
language sql stable as $$
  select client_id, service_id, count(*), min(occurred_at)
  from billing.billable_events
  where status = 'pending' and occurred_at < now() - interval '7 days'
  group by 1,2
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. بيانات التأسيس
-- ═══════════════════════════════════════════════════════════════════════════

insert into platform.entities (code, name_ar, name_en, legal_name_ar, base_currency, entity_kind) values
 ('PGH','بريميوم جروب القابضة','Premium Group Holding','شركة بريميوم جروب القابضة','KWD','holding')
on conflict (code) do nothing;

insert into platform.entities (code, name_ar, name_en, legal_name_ar, base_currency, entity_kind, parent_id) values
 ('PCC','بريميوم CC','Premium CC','شركة بريميوم للاتصالات','KWD','operating',(select id from platform.entities where code='PGH')),
 ('PST','بريميوم ستوراج','Premium Storage','شركة بريميوم ستوراج للمخازن العامة ذ.م.م','KWD','operating',(select id from platform.entities where code='PGH')),
 ('PDL','بريميوم دليفري','Premium Delivery','شركة بريميوم دليفري','KWD','operating',(select id from platform.entities where code='PGH')),
 ('POR','بريميوم أوردر','Premium Order','شركة بريميوم أوردر','KWD','operating',(select id from platform.entities where code='PGH'))
on conflict (code) do nothing;

-- الحارس: الكيان القابض لا يُصدر فاتورة عميل أبداً
create or replace function billing.reject_holding_invoice()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from platform.entities e where e.id = new.entity_id and e.entity_kind = 'holding')
     and new.invoice_type <> 'intercompany' then
    raise exception 'الكيان القابض لا يُصدر فواتير عملاء — الفوترة من الكيانات التشغيلية فقط';
  end if;
  return new;
end $$;
drop trigger if exists trg_no_holding_invoice on billing.invoices;
create trigger trg_no_holding_invoice before insert on billing.invoices
  for each row execute function billing.reject_holding_invoice();

-- العدّادات لكل كيان ونوع مستند
insert into platform.counters (entity_id, doc_type, period, prefix, padding)
select e.id, d.doc_type, 'ALL', e.code || '-' || d.prefix || '-', 5
from platform.entities e
cross join (values
  -- v4 (SCH-2 · R-04 · ADM §7): حُذفت السلسلة اليتيمة ('RCP','RCP').
  --   السلاسل الحاكمة: RCT إيصالات القبض (بادئة RC، تُبذر في 13) · GOV الرسوم
  --   الحكومية (13) · INV الفواتير (هنا). RCP كانت تُنتج PST-RCP- بلا مستند يقابلها.
  ('INV','INV'),('CN','CN'),('QTE','QT'),('CTR','CT'),
  ('INB','IN'),('OUT','OUT'),('CNT','CNT'),('TSK','TSK'),('RTE','RT'),
  ('TKT','TK'),('JE','JE'),('LEAD','LD'),('OPP','OP')
) as d(doc_type, prefix)
on conflict do nothing;

insert into catalog.service_categories (code, name_ar, name_en, sort_order) values
 ('ST','التخزين','Storage',1),
 ('HD','المناولة والاستلام','Handling & Inbound',2),
 ('OF','تجهيز الطلبات والصرف','Order Fulfilment',3),
 ('DL','التوصيل','Delivery & Transport',4),
 ('VA','خدمات القيمة المضافة','Value Added Services',5),
 ('CC','الكول سنتر والبدالة','Call Center & Switchboard',6),
 ('IT','التقنية والتكامل','Technology & Integration',7)
on conflict (code) do nothing;

insert into catalog.segments (code, name_ar, name_en, rank, criteria, discount_pct) values
 ('SEG-A','استراتيجي','Strategic',1,'{"min_monthly_revenue":5000}'::jsonb, 15),
 ('SEG-B','كبير','Large',2,'{"min_monthly_revenue":2000}'::jsonb, 10),
 ('SEG-C','متوسط','Medium',3,'{"min_monthly_revenue":750}'::jsonb, 5),
 ('SEG-D','صغير','Small',4,'{"min_monthly_revenue":200}'::jsonb, 0),
 ('SEG-E','موسمي','Seasonal',5,'{"seasonal":true}'::jsonb, 0),
 ('SEG-F','تجريبي','Trial',6,'{"trial":true}'::jsonb, 0)
on conflict (code) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- نهاية المخطط
-- ملاحظات للمنفّذ:
--   1. هذا الملف يُقسَّم إلى هجرات مرقّمة (001_platform.sql … 010_imile.sql)
--      قبل التطبيق. لا يُطبَّق كملف واحد على الإنتاج.
--   2. جداول hr مختصرة هنا — الحضور والرواتب والانضباط في وثيقة 03.
--   3. سياسات RLS أعلاه نماذج للنمط. تُعمَّم على كل جدول تشغيلي قبل الإطلاق.
--   4. دوال §12 تُشغَّل في خط النشر؛ أي نتيجة غير فارغة توقف النشر.
-- ═══════════════════════════════════════════════════════════════════════════
