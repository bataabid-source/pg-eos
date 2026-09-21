-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · إضافات المخطط — الشركاء · الاستقدام · العمولات · معرّفات iMile · الإداري
-- وثيقة 13 من 13 · الإصدار 1.0 · تُطبَّق بعد 01-Data-Model.sql
--
-- تُقسَّم إلى هجرات: 011_partners · 012_hr_recruitment · 013_driver_ops · 014_admin
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists partners;
create schema if not exists admin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — الشركاء والتعاقد من الباطن
-- ═══════════════════════════════════════════════════════════════════════════

create table partners.partners (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name_ar       text not null, name_en text,
  partner_type  text not null,   -- warehouse · delivery · transport · cc · manpower · vendor · other
  cr_number text, tax_number text,
  address text, phone text, email text, contact_person text,
  bank_name text, bank_iban text,
  payment_terms_days int default 30,
  rating        numeric(3,2),
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table partners.partner_contracts (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references platform.entities(id),
  doc_no         text not null,
  partner_id     uuid not null references partners.partners(id),
  relation_type  text not null,   -- resale · committed · on_demand · agency · manpower
  title          text not null,
  status         text not null default 'draft',
  start_date date not null, end_date date,
  auto_renew boolean not null default false,
  notice_days int default 30,
  payment_terms_days int not null default 30,
  committed_qty numeric(14,3), committed_uom text,
  committed_monthly_cost numeric(14,3),
  min_utilization_pct numeric(6,3) default 70,   -- تحتها ينبّه النظام
  sla_back_to_back boolean not null default false,
  penalty_recoverable boolean not null default false,
  liability_cap numeric(14,3),
  insurance_by text,               -- partner · premium · client
  insurance_expiry date,
  audit_right boolean not null default false,    -- حق الجرد/التفتيش
  file_url text,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no)
);
create index on partners.partner_contracts (partner_id, status);

create table partners.partner_price_lines (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references partners.partner_contracts(id) on delete cascade,
  service_id   uuid not null references catalog.services(id),
  cost_price   numeric(14,3) not null,
  uom          text not null,
  tier_from numeric(14,3), tier_to numeric(14,3),
  valid_from date not null, valid_to date,
  unique (contract_id, service_id, tier_from)
);

create table partners.service_allocations (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  client_id    uuid not null references sales.accounts(id),
  service_id   uuid not null references catalog.services(id),
  partner_id   uuid not null references partners.partners(id),
  partner_contract_id uuid not null references partners.partner_contracts(id),
  location_scope text,
  valid_from date not null, valid_to date,
  priority int not null default 1,
  notes text
);
create index on partners.service_allocations (client_id, service_id, valid_from);

create table partners.payable_events (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  occurred_at   timestamptz not null,
  partner_id    uuid not null references partners.partners(id),
  contract_id   uuid not null references partners.partner_contracts(id),
  client_id     uuid references sales.accounts(id),
  service_id    uuid not null references catalog.services(id),
  qty           numeric(14,3) not null,
  uom           text not null,
  cost_price    numeric(14,3),
  amount        numeric(14,3),
  billable_event_id uuid references billing.billable_events(id),
  source_table text, source_id uuid,
  status        text not null default 'pending',
  -- pending · priced · matched · invoiced · disputed · rejected
  dispute_reason text,
  partner_invoice_id uuid,
  created_at timestamptz not null default now()
);
create index on partners.payable_events (partner_id, status, occurred_at);
create index on partners.payable_events (client_id, occurred_at);
create unique index on partners.payable_events (source_table, source_id, service_id, partner_id);

create table partners.partner_invoices (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,
  partner_ref   text not null,
  partner_id    uuid not null references partners.partners(id),
  contract_id   uuid not null references partners.partner_contracts(id),
  period_from date, period_to date,
  invoice_date date not null, due_date date,
  claimed_amount  numeric(14,3) not null,
  matched_amount  numeric(14,3) not null default 0,
  variance_amount numeric(14,3) generated always as (claimed_amount - matched_amount) stored,
  variance_pct    numeric(8,4),
  approved_amount numeric(14,3),
  paid_amount     numeric(14,3) not null default 0,
  status text not null default 'received',
  -- received · matching · variance_review · approved · paid · disputed · rejected
  matched_by uuid, approved_by uuid, approved_at timestamptz,
  dispute_note text, file_url text,
  unique (entity_id, doc_no),
  unique (partner_id, partner_ref)      -- يمنع استلام نفس الفاتورة مرتين
);

-- الهامش الحي على الخدمات المعاد بيعها
create or replace view partners.resale_margin as
select
  b.entity_id, b.client_id, b.service_id,
  date_trunc('month', b.occurred_at)::date as period,
  sum(b.amount)                    as revenue,
  sum(coalesce(p.amount, 0))       as partner_cost,
  sum(b.amount - coalesce(p.amount, 0)) as margin,
  case when sum(b.amount) > 0
       then round(100 * sum(b.amount - coalesce(p.amount,0)) / sum(b.amount), 2) end as margin_pct
from billing.billable_events b
left join partners.payable_events p on p.billable_event_id = b.id
where b.status in ('priced','invoiced')
group by 1,2,3,4;

-- تنبيه استغلال السعة المحجوزة
create or replace function partners.check_committed_utilization(p_period date)
returns table (contract_id uuid, partner_id uuid, committed numeric,
               used numeric, utilization_pct numeric, wasted_cost numeric)
language sql stable as $$
  select c.id, c.partner_id, c.committed_qty,
         coalesce(sum(p.qty), 0),
         case when c.committed_qty > 0
              then round(100 * coalesce(sum(p.qty),0) / c.committed_qty, 2) end,
         case when c.committed_qty > 0
              then round(c.committed_monthly_cost *
                   (1 - coalesce(sum(p.qty),0) / c.committed_qty), 3) end
  from partners.partner_contracts c
  left join partners.payable_events p
    on p.contract_id = c.id
   and date_trunc('month', p.occurred_at)::date = p_period
  where c.relation_type = 'committed' and c.status = 'active'
  group by c.id, c.partner_id, c.committed_qty, c.committed_monthly_cost
  having c.committed_qty > 0
     and coalesce(sum(p.qty),0) / c.committed_qty < coalesce(c.min_utilization_pct,70)/100
$$;

-- مخزن الشريك
alter table wms.warehouses add column if not exists is_partner boolean not null default false;
alter table wms.warehouses add column if not exists partner_id uuid references partners.partners(id);
alter table wms.locations  add column if not exists partner_location_ref text;

-- تنفيذ التوصيل بالباطن
alter table tms.delivery_tasks add column if not exists executed_by_partner_id
  uuid references partners.partners(id);
alter table tms.delivery_tasks add column if not exists partner_task_ref text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — الاستقدام ودورة حياة الموظف
-- ═══════════════════════════════════════════════════════════════════════════

create table hr.manpower_requests (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,
  requested_by  uuid not null references hr.employees(id),
  org_unit_id   uuid references hr.org_units(id),
  job_title_ar  text not null, job_title_en text,
  headcount     int not null,
  proposed_salary numeric(14,3),
  justification text not null,
  source_type   text not null default 'overseas',  -- overseas · local · transfer
  client_id     uuid references sales.accounts(id),
  status        text not null default 'draft',
  -- draft · pending_approval · approved · in_progress · completed · rejected · cancelled
  approved_by uuid, approved_at timestamptz, rejection_reason text,
  budget_approved numeric(14,3),
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no),
  constraint positive_headcount check (headcount > 0)
);

-- v4 fix S-02: دالة مشتركة لحساب موعد استحقاق المرحلة (بديل العمود المولَّد غير القابل للثبات)
create or replace function platform.set_stage_due_at() returns trigger
language plpgsql as $$
begin
  new.due_at := new.stage_started_at + make_interval(days => new.sla_days);
  return new;
end $$;

create table hr.recruitment_cases (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  doc_no        text not null,
  request_id    uuid not null references hr.manpower_requests(id),
  candidate_name text not null,
  nationality   text, passport_no text, date_of_birth date,
  agency_partner_id uuid references partners.partners(id),
  -- الحالة من السبعة عشر (وثيقة 10 §4)
  stage         text not null default 'work_permit',
  stage_owner   uuid not null,          -- لا حالة بلا مالك
  stage_started_at timestamptz not null default now(),
  sla_days      int not null default 7,
  -- v4 fix S-02: كان عموداً مولَّداً يستدعي now() (غير immutable → فشل إنشاء الجدول).
  -- due_at يُملأ بمُشغِّل platform.set_stage_due_at()؛ التأخر يُحسب وقت القراءة:
  --   completed_at is null and now() > due_at
  due_at        timestamptz,
  blocked_reason text, blocked_owner uuid,
  employee_id   uuid references hr.employees(id),   -- يُملأ عند المباشرة
  cost_to_date  numeric(14,3) not null default 0,
  outcome       text,       -- hired · failed_medical · withdrew · rejected · replaced
  completed_at  timestamptz,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no)
);
create trigger trg_recruitment_due_at before insert or update of stage_started_at, sla_days
  on hr.recruitment_cases for each row execute function platform.set_stage_due_at();
create index on hr.recruitment_cases (stage, stage_owner);
create index on hr.recruitment_cases (request_id);

create table hr.recruitment_stage_log (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references hr.recruitment_cases(id) on delete cascade,
  from_stage text, to_stage text not null,
  owner_id   uuid not null,
  entered_at timestamptz not null default now(),
  exited_at  timestamptz,
  duration_days numeric(8,2) generated always as (
    case when exited_at is not null
         then round(extract(epoch from (exited_at - entered_at))/86400.0, 2) end
  ) stored,
  note text
);

create table hr.recruitment_costs (
  id        uuid primary key default gen_random_uuid(),
  case_id   uuid not null references hr.recruitment_cases(id) on delete cascade,
  cost_type text not null,
  -- work_permit · visa · agency_fee · ticket · medical_abroad · medical_local
  -- · residency · civil_id · insurance · driving_license · onboarding · other
  amount    numeric(14,3) not null,
  incurred_at date not null,
  gov_transaction_id uuid,
  receipt_url text,
  recorded_by uuid not null
);

-- تكلفة الاستقدام الكاملة لكل موظف
create or replace view hr.recruitment_cost_per_employee as
select c.employee_id, c.id as case_id, c.candidate_name,
       sum(rc.amount) as total_cost,
       count(rc.id)   as cost_items,
       min(rc.incurred_at) as first_cost, max(rc.incurred_at) as last_cost
from hr.recruitment_cases c
join hr.recruitment_costs rc on rc.case_id = c.id
where c.employee_id is not null
group by 1,2,3;

-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — معرّفات iMile والعمولات
-- ═══════════════════════════════════════════════════════════════════════════

create table imile.driver_ids (
  id            uuid primary key default gen_random_uuid(),
  imile_code    text not null unique,
  allocated_at  date not null,
  status        text not null default 'available',
  -- available · assigned · suspended · blocked · returned
  suspended_at  date,
  suspension_reason text,
  suspension_category text,   -- administrative · performance · conduct · permanent
  returned_at   date,
  notes text,
  updated_at timestamptz not null default now()
);

create table imile.driver_id_assignments (
  id            uuid primary key default gen_random_uuid(),
  driver_id_ref uuid not null references imile.driver_ids(id),
  employee_id   uuid not null references hr.employees(id),
  assigned_from timestamptz not null,
  assigned_to   timestamptz,
  assigned_by   uuid not null,
  approved_by   uuid,
  handover_doc_id uuid references platform.documents(id),
  end_reason    text,
  -- resigned · terminated · suspended_by_imile · reassigned · returned_to_imile
  created_at timestamptz not null default now(),
  constraint valid_period check (assigned_to is null or assigned_to > assigned_from)
);
-- معرّف واحد نشط لسائق واحد في أي لحظة
create unique index on imile.driver_id_assignments (driver_id_ref) where assigned_to is null;
-- وسائق واحد لا يحمل معرّفين نشطين
create unique index on imile.driver_id_assignments (employee_id) where assigned_to is null;
create index on imile.driver_id_assignments (driver_id_ref, assigned_from, assigned_to);

-- ⚠️ العرض الوحيد المسموح لنسب شحنات iMile لسائق بشري
-- الربط المباشر بـ shipments.driver_code ممنوع في كل الكود
create or replace view imile.shipments_attributed as
select s.id as shipment_id, s.tracking_no, s.driver_code, s.ofd_at, s.closed_at,
       s.internal_status, s.is_cod, s.cod_amount, s.zone_code,
       a.employee_id, a.id as assignment_id, d.id as driver_id_ref
from imile.shipments s
left join imile.driver_ids d on d.imile_code = s.driver_code
left join imile.driver_id_assignments a
       on a.driver_id_ref = d.id
      and s.ofd_at >= a.assigned_from
      and (a.assigned_to is null or s.ofd_at < a.assigned_to);

comment on view imile.shipments_attributed is
  'المصدر الوحيد لنسب الشحنة لسائق. أي انضمام مباشر بـ driver_code يُحتسب خطأ حرجاً في مراجعة الشيفرة';

-- شحنات بلا سائق منسوب — يجب أن يكون صفراً
create or replace function imile.verify_attribution(p_from date, p_to date)
returns table (tracking_no text, driver_code text, ofd_at timestamptz, reason text)
language sql stable as $$
  select s.tracking_no, s.driver_code, s.ofd_at,
         case when d.id is null then 'معرّف غير مسجّل لدينا'
              else 'لا إسناد ساري في وقت التسليم' end
  from imile.shipments s
  left join imile.driver_ids d on d.imile_code = s.driver_code
  left join imile.driver_id_assignments a
         on a.driver_id_ref = d.id
        and s.ofd_at >= a.assigned_from
        and (a.assigned_to is null or s.ofd_at < a.assigned_to)
  where s.internal_status = 'delivered'
    and s.ofd_at::date between p_from and p_to
    and a.id is null
$$;

create table hr.commission_rules (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  name         text not null,
  applies_to   text not null default 'driver',
  client_id    uuid references sales.accounts(id),
  tier_from    int not null default 0,
  tier_to      int,
  rate_per_unit numeric(14,3) not null,
  min_daily    numeric(14,3) default 0,
  valid_from date not null, valid_to date,
  created_by uuid,
  constraint valid_tier check (tier_to is null or tier_to > tier_from)
);

create table hr.commission_daily (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  work_date     date not null,
  employee_id   uuid not null references hr.employees(id),
  driver_id_ref uuid references imile.driver_ids(id),
  delivered_count int not null default 0,
  failed_count    int not null default 0,
  returned_count  int not null default 0,
  gross_commission numeric(14,3) not null default 0,
  deductions       numeric(14,3) not null default 0,
  deduction_reason text,
  net_commission   numeric(14,3) generated always as (gross_commission - deductions) stored,
  source_snapshot  jsonb not null,     -- لقطة مجمَّدة من أرقام iMile
  rule_snapshot    jsonb,              -- القواعد المطبَّقة وقت الحساب
  status        text not null default 'calculated',
  -- calculated · disputed · confirmed · paid
  dispute_note  text, disputed_at timestamptz,
  confirmed_by uuid, confirmed_at timestamptz,
  payroll_period date,
  created_at timestamptz not null default now(),
  unique (work_date, employee_id),
  constraint deduction_needs_reason check (deductions = 0 or deduction_reason is not null)
);
create index on hr.commission_daily (employee_id, work_date desc);
create index on hr.commission_daily (payroll_period, status);

-- إنهاء الخدمة يغلق إسناد المعرّف آلياً
create or replace function hr.close_driver_id_on_termination()
returns trigger language plpgsql as $$
begin
  if new.status in ('terminated','resigned') and old.status not in ('terminated','resigned') then
    update imile.driver_id_assignments
       set assigned_to = now(),
           end_reason  = case when new.status = 'resigned' then 'resigned' else 'terminated' end
     where employee_id = new.id and assigned_to is null;

    update imile.driver_ids d
       set status = 'available', updated_at = now()
     where d.status = 'assigned'
       and exists (select 1 from imile.driver_id_assignments a
                    where a.driver_id_ref = d.id and a.employee_id = new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_close_driver_id on hr.employees;
create trigger trg_close_driver_id
  after update on hr.employees
  for each row execute function hr.close_driver_id_on_termination();

-- إيقاف المعرّف يغلق إسناده فوراً
create or replace function imile.close_assignment_on_suspension()
returns trigger language plpgsql as $$
begin
  if new.status in ('suspended','blocked') and old.status = 'assigned' then
    update imile.driver_id_assignments
       set assigned_to = now(), end_reason = 'suspended_by_imile'
     where driver_id_ref = new.id and assigned_to is null;
  end if;
  return new;
end $$;

drop trigger if exists trg_close_on_suspension on imile.driver_ids;
create trigger trg_close_on_suspension
  after update on imile.driver_ids
  for each row execute function imile.close_assignment_on_suspension();

-- لوحة إدارة المعرّفات
create or replace view imile.driver_id_dashboard as
select d.imile_code, d.status, d.suspension_category, d.suspended_at,
       a.employee_id, e.name_ar as driver_name, e.status as employee_status,
       a.assigned_from,
       case when d.status = 'suspended'
            then (current_date - d.suspended_at) end as days_suspended
from imile.driver_ids d
left join imile.driver_id_assignments a on a.driver_id_ref = d.id and a.assigned_to is null
left join hr.employees e on e.id = a.employee_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — الدورة الإدارية
-- ═══════════════════════════════════════════════════════════════════════════

create table admin.budget_lines (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  fiscal_year int not null,
  cost_center text not null,
  gl_account_id uuid references billing.gl_accounts(id),
  annual_amount numeric(14,3) not null,
  committed_amount numeric(14,3) not null default 0,
  spent_amount numeric(14,3) not null default 0,
  available numeric(14,3) generated always as
    (annual_amount - committed_amount - spent_amount) stored,
  unique (entity_id, fiscal_year, cost_center, gl_account_id)
);

create table admin.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  requested_by uuid not null,
  org_unit_id uuid references hr.org_units(id),
  cost_center text not null,
  client_id uuid references sales.accounts(id),
  budget_line_id uuid references admin.budget_lines(id),
  description text not null,
  estimated_amount numeric(14,3) not null,
  urgency text not null default 'normal',
  status text not null default 'draft',
  needed_by date,
  approved_by uuid, approved_at timestamptz, rejection_reason text,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no),
  constraint no_self_approval check (approved_by is null or approved_by <> requested_by)
);

create table admin.vendor_quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references admin.purchase_requests(id) on delete cascade,
  partner_id uuid references partners.partners(id),
  vendor_name text not null,
  amount numeric(14,3) not null,
  delivery_days int, validity_date date,
  is_selected boolean not null default false,
  selection_reason text,
  file_url text,
  constraint selected_needs_reason check (not is_selected or selection_reason is not null)
);

create table admin.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  request_id uuid references admin.purchase_requests(id),
  vendor_id uuid references partners.partners(id),
  vendor_name text not null,
  cost_center text not null,
  client_id uuid references sales.accounts(id),
  total_amount numeric(14,3) not null,
  status text not null default 'issued',
  expected_date date,
  received_at timestamptz, received_by uuid, received_amount numeric(14,3),
  invoice_ref text, invoice_amount numeric(14,3),
  three_way_matched boolean not null default false,
  variance_note text,
  paid_at timestamptz,
  unique (entity_id, doc_no),
  -- من يستلم ليس من يعتمد الطلب
  constraint no_pay_before_match check (paid_at is null or three_way_matched)
);

create table admin.petty_cash (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  holder_employee_id uuid not null references hr.employees(id),
  limit_amount numeric(14,3) not null,
  current_balance numeric(14,3) not null default 0,
  max_single_txn numeric(14,3) not null default 50,
  status text not null default 'active',
  approved_by uuid, opened_at date not null, closed_at date
);
create unique index on admin.petty_cash (holder_employee_id) where status = 'active';

create table admin.petty_cash_transactions (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references admin.petty_cash(id),
  occurred_at timestamptz not null default now(),
  txn_type text not null,          -- advance · expense · settlement · return
  amount numeric(14,3) not null,
  description text not null,
  cost_center text, client_id uuid references sales.accounts(id),
  gl_account_id uuid references billing.gl_accounts(id),
  receipt_url text,
  settlement_id uuid,
  recorded_by uuid not null,
  constraint expense_needs_receipt check (txn_type <> 'expense' or receipt_url is not null)
);

create table admin.assets (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  code text not null unique,
  name_ar text not null, name_en text,
  asset_type text not null,
  serial_no text,
  purchase_order_id uuid references admin.purchase_orders(id),
  purchase_value numeric(14,3), purchase_date date,
  condition text not null default 'good',
  status text not null default 'in_stock',
  current_holder_id uuid references hr.employees(id),
  cost_center text
);

create table admin.asset_custody (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references admin.assets(id),
  employee_id uuid not null references hr.employees(id),
  issued_at timestamptz not null default now(),
  issued_by uuid not null,
  condition_at_issue text,
  returned_at timestamptz, returned_to uuid, condition_at_return text,
  loss_reason text, charged_amount numeric(14,3),
  handover_doc_id uuid references platform.documents(id)
);
create unique index on admin.asset_custody (asset_id) where returned_at is null;

create table admin.gov_transactions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  transaction_type text not null,
  authority text not null,
  related_table text, related_id uuid,
  recruitment_case_id uuid references hr.recruitment_cases(id),
  stage text not null default 'requested',
  stage_owner uuid not null,
  stage_started_at timestamptz not null default now(),
  sla_days int not null default 7,
  -- v4 fix S-02 (نفس المعالجة): due_at بمُشغِّل، والتأخر يُحسب وقت القراءة
  due_at timestamptz,
  government_ref text,
  fees_paid numeric(14,3) default 0,
  cost_center text,
  receipt_url text, result_doc_url text,
  blocked_reason text, blocked_owner uuid,
  completed_at timestamptz,
  unique (entity_id, doc_no)
);
create trigger trg_gov_due_at before insert or update of stage_started_at, sla_days
  on admin.gov_transactions for each row execute function platform.set_stage_due_at();
create index on admin.gov_transactions (stage_owner, due_at) where completed_at is null;
create index on admin.gov_transactions (related_table, related_id);

create table admin.approval_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  request_type text not null,
  source_table text not null, source_id uuid not null,
  amount numeric(14,3),
  requested_by uuid not null,
  current_step int not null default 1,
  status text not null default 'pending',
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no)
);

create table admin.approval_steps (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references admin.approval_requests(id) on delete cascade,
  step_no int not null,
  approver_role text not null,
  approver_user_id uuid,
  delegated_from uuid, delegation_expires_at timestamptz,
  decision text, decision_note text, decided_at timestamptz,
  unique (request_id, step_no)
);

create table admin.correspondence (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references platform.entities(id),
  doc_no text not null,
  direction text not null,
  correspondent text not null,
  subject text not null,
  body_summary text,
  related_table text, related_id uuid,
  assigned_to uuid, due_at timestamptz,
  status text not null default 'open',
  file_url text,
  reply_to_id uuid references admin.correspondence(id),
  created_at timestamptz not null default now(),
  unique (entity_id, doc_no)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- العدّادات الجديدة
-- ═══════════════════════════════════════════════════════════════════════════

insert into platform.counters (entity_id, doc_type, period, prefix, padding)
select e.id, d.doc_type, 'ALL', e.code || '-' || d.prefix || '-', 5
from platform.entities e
cross join (values
  ('PRQ','PR'),('PO','PO'),('PINV','PI'),('PCT','PC'),
  ('MPR','MP'),('RCT','RC'),('GOV','GV'),('APR','AP'),('COR','CR')
) as d(doc_type, prefix)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- اختبارات حارسة إضافية — تمنع النشر عند الفشل
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. لا شحنة مسلَّمة بلا سائق منسوب (آخر 30 يوماً)
--    select * from imile.verify_attribution(current_date - 30, current_date);
--    الشرط: صفر صفوف

-- 2. لا موظف منتهي الخدمة بمعرّف نشط
create or replace function imile.verify_no_orphan_ids()
returns table (imile_code text, employee_id uuid, employee_status text)
language sql stable as $$
  select d.imile_code, e.id, e.status
  from imile.driver_id_assignments a
  join imile.driver_ids d on d.id = a.driver_id_ref
  join hr.employees e on e.id = a.employee_id
  where a.assigned_to is null
    and e.status in ('terminated','resigned')
$$;

-- 3. لا فاتورة شريك مدفوعة بلا مطابقة
create or replace function partners.verify_paid_matched()
returns table (doc_no text, partner_ref text, claimed numeric, matched numeric)
language sql stable as $$
  select doc_no, partner_ref, claimed_amount, matched_amount
  from partners.partner_invoices
  where paid_amount > 0 and status not in ('approved','paid')
$$;

-- 4. لا أمر شراء مدفوع بلا مطابقة ثلاثية  (مفروض بقيد no_pay_before_match)

-- 5. لا حالة استقدام أو معاملة حكومية بلا مالك (مفروض بـ not null)

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS للجداول الجديدة
-- ═══════════════════════════════════════════════════════════════════════════

alter table partners.partner_contracts enable row level security;
alter table partners.payable_events    enable row level security;
alter table partners.partner_invoices  enable row level security;
alter table admin.purchase_requests    enable row level security;
alter table admin.purchase_orders      enable row level security;
alter table admin.gov_transactions     enable row level security;
alter table hr.commission_daily        enable row level security;
alter table hr.recruitment_cases       enable row level security;

create policy entity_scope on partners.partner_contracts
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on partners.payable_events
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on admin.purchase_requests
  for all using (entity_id = any(platform.allowed_entities()));
create policy entity_scope on admin.gov_transactions
  for all using (entity_id = any(platform.allowed_entities()));

-- السائق يرى عمولته هو فقط
create policy own_commission on hr.commission_daily
  for select using (
    platform.has_perm('hr.commission.read_all')
    or employee_id = (select employee_id from identity.users
                       where id = platform.current_user_id())
  );

-- ⚠️ بيانات الشركاء لا تصل نافذة العميل إطلاقاً — لا سياسة عميل على أي جدول partners
-- ═══════════════════════════════════════════════════════════════════════════
