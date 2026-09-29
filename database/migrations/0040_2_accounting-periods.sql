-- 0040_2_accounting-periods.sql — Lane 2 — WBS 4.19 "Fiscal years + periods (open/closed/locked)".
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- SCR-ACC-01 #3 (new billing.fiscal_years, new billing.accounting_periods — "Fiscal year; periods
-- open/closed/locked per entity") and #4 (billing.journal_entries, 01:1189 — "Period link; posting to
-- closed/locked period refused"); ADR-0004 D1 5 ("Periods open/closed/locked per entity; the DB
-- refuses posting into closed/locked periods") and D3 OD-12 (CFO closes; reopen via Decision Inbox).
-- Acceptance (doc 38 row 4.19): "Posting into closed/locked period rejected by the DB".
--
-- Pre-migration review directives (pg-reviewer, binding):
--   D1  reopen approver = GM, seeded as DATA in platform.approval_chains ('accounting_period_reopen',
--       step 1) — the application and the trigger read it, never a literal role.
--   D3  both tables: id, entity_id, start_date, end_date (start <= end), version, created_at,
--       unique (entity_id, id), no overlap per entity (exclude using gist, btree_gist). Periods add
--       fiscal_year_id (composite FK to the year of the SAME entity) and status open/closed/locked.
--       A period lies inside its fiscal year (trigger, 23514). journal_entries.period_id (nullable,
--       composite FK to the period of the SAME entity). No cascade anywhere.
--   D4  billing.guard_accounting_period() (BEFORE INSERT OR UPDATE): insert only at 'open'; update
--       only open->closed, closed->locked, same status, and closed->open ONLY behind a decided,
--       approved platform.decisions row decided by the session user (an approval-chain approver) who
--       is not its requester, for the period's current version. entity_id, fiscal_year_id,
--       start_date, end_date immutable. billing.guard_fiscal_year(): entity_id, start_date, end_date
--       immutable. Every refusal is 23514.
--   D5  billing.assert_posting_period(): a journal entry (and a journal line, through its parent
--       entry) is refused (23514) when the covering period of its entity is closed or locked, when a
--       non-null period_id is not the covering period, or when a non-null period_id names a period on
--       an uncovered date. INSERT checks new, UPDATE old and new, DELETE old. The covering period is
--       read FOR SHARE, so a posting and a close of the same period serialise. Attached as
--       NOT DEFERRABLE constraint triggers (AFTER ROW, 0038 C1): they run after entity_scope WITH
--       CHECK, so a caller outside the entity gets 42501 and never a message about its periods.
--   D5  every function: SECURITY DEFINER, search_path pinned to pg_catalog, pg_temp, schema-
--       qualified, execute revoked from public, owner checked in pg_proc at the end of this file.
--       No message names data RLS hides from the caller (0038 F1): only the row's own values.
--   D6  grants to pgeos_app: select, insert on both tables; update (status, version) on
--       accounting_periods only; no delete; no update on fiscal_years.
--   D7  entity_scope RLS (0015 pattern), enable + force (13B:3158 precedent for the ledger tables);
--       one identity.column_classification row per new column, journal_entries.period_id included.
--
-- Containment note (D3 + RLS): the fiscal-year containment check must run BEFORE the row reaches
-- the no-overlap exclusion index, i.e. in the BEFORE trigger — which fires before entity_scope WITH
-- CHECK. For a row whose entity the caller cannot see, the trigger therefore returns early and lets
-- RLS refuse it (42501), so the SECURITY DEFINER read can never reveal another entity's fiscal-year
-- range. A superuser/BYPASSRLS session (migrations, fixtures) is not RLS-scoped and is always checked.
--
-- Close review round 1 (one fix round): #1 a status change bumps version by exactly one and version
-- never goes down (a spent reopen decision cannot be replayed by rewinding version); #2
-- billing.guard_period_reopen_decision() on platform.decisions pins the requester and makes a reopen
-- decision's kind/context/source/entity immutable; #3 the containment refusal carries
-- constraint name chk_accounting_periods_in_fiscal_year so the repository maps it to a typed error.
--
-- No seed row besides the D1 approval-chain row: no fiscal year and no period is created for any
-- entity (OD-12 "Ask" — the fiscal-year end per entity is a batched GM question).

begin;

create extension if not exists btree_gist;   -- present per 0016:35; kept for a fresh apply.

-- ── 1. billing.fiscal_years ──────────────────────────────────────────────────────────────────────

create table if not exists billing.fiscal_years (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references platform.entities(id),
  start_date  date not null,
  end_date    date not null,
  version     int not null default 1,
  created_at  timestamptz not null default now()
);
comment on table billing.fiscal_years is
  'SCR-ACC-01 #3, ADR-0004 D1 5: an entity''s fiscal year. No two years of one entity overlap. '
  'entity_id, start_date and end_date are immutable (billing.guard_fiscal_year()).';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_fiscal_years_date_range' and conrelid = 'billing.fiscal_years'::regclass
  ) then
    alter table billing.fiscal_years add constraint chk_fiscal_years_date_range
      check (start_date <= end_date);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'uq_fiscal_years_entity_id_id' and conrelid = 'billing.fiscal_years'::regclass
  ) then
    alter table billing.fiscal_years add constraint uq_fiscal_years_entity_id_id
      unique (entity_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ex_fiscal_years_no_overlap' and conrelid = 'billing.fiscal_years'::regclass
  ) then
    alter table billing.fiscal_years add constraint ex_fiscal_years_no_overlap
      exclude using gist (entity_id with =, daterange(start_date, end_date, '[]') with &&);
  end if;
end $$;

alter table billing.fiscal_years enable row level security;
alter table billing.fiscal_years force row level security;

drop policy if exists entity_scope on billing.fiscal_years;
create policy entity_scope on billing.fiscal_years for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

revoke all on billing.fiscal_years from pgeos_app;
grant select, insert on billing.fiscal_years to pgeos_app;

-- ── 2. billing.accounting_periods ────────────────────────────────────────────────────────────────

create table if not exists billing.accounting_periods (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references platform.entities(id),
  fiscal_year_id  uuid not null,     -- composite FK (entity_id, fiscal_year_id) below (D3)
  start_date      date not null,
  end_date        date not null,
  status          text not null default 'open',   -- ADR-0004 D1 5: open · closed · locked
  version         int not null default 1,
  created_at      timestamptz not null default now()
);
comment on table billing.accounting_periods is
  'SCR-ACC-01 #3, ADR-0004 D1 5 / OD-12: an accounting period of an entity, inside one fiscal year '
  'of that entity; no two periods of one entity overlap. Created open; open -> closed -> locked, '
  'closed -> open only through an approved Decision Inbox decision (billing.guard_accounting_period()). '
  'A posting dated inside a closed or locked period is refused (billing.assert_posting_period()).';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_accounting_periods_date_range' and conrelid = 'billing.accounting_periods'::regclass
  ) then
    alter table billing.accounting_periods add constraint chk_accounting_periods_date_range
      check (start_date <= end_date);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_accounting_periods_status' and conrelid = 'billing.accounting_periods'::regclass
  ) then
    alter table billing.accounting_periods add constraint chk_accounting_periods_status
      check (status in ('open', 'closed', 'locked'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'uq_accounting_periods_entity_id_id' and conrelid = 'billing.accounting_periods'::regclass
  ) then
    alter table billing.accounting_periods add constraint uq_accounting_periods_entity_id_id
      unique (entity_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_accounting_periods_entity_fiscal_year' and conrelid = 'billing.accounting_periods'::regclass
  ) then
    alter table billing.accounting_periods add constraint fk_accounting_periods_entity_fiscal_year
      foreign key (entity_id, fiscal_year_id) references billing.fiscal_years (entity_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ex_accounting_periods_no_overlap' and conrelid = 'billing.accounting_periods'::regclass
  ) then
    alter table billing.accounting_periods add constraint ex_accounting_periods_no_overlap
      exclude using gist (entity_id with =, daterange(start_date, end_date, '[]') with &&);
  end if;
end $$;

create index if not exists accounting_periods_entity_fiscal_year_idx
  on billing.accounting_periods (entity_id, fiscal_year_id);

alter table billing.accounting_periods enable row level security;
alter table billing.accounting_periods force row level security;

drop policy if exists entity_scope on billing.accounting_periods;
create policy entity_scope on billing.accounting_periods for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

revoke all on billing.accounting_periods from pgeos_app;
grant select, insert on billing.accounting_periods to pgeos_app;
grant update (status, version) on billing.accounting_periods to pgeos_app;

-- ── 3. billing.journal_entries.period_id (SCR-ACC-01 #4) ─────────────────────────────────────────

alter table billing.journal_entries add column if not exists period_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_journal_entries_entity_period' and conrelid = 'billing.journal_entries'::regclass
  ) then
    alter table billing.journal_entries add constraint fk_journal_entries_entity_period
      foreign key (entity_id, period_id) references billing.accounting_periods (entity_id, id);
  end if;
end $$;

create index if not exists journal_entries_entity_period_idx
  on billing.journal_entries (entity_id, period_id);

-- ── 4. platform.approval_chains row (D1 — read as DATA, never hard-coded) ────────────────────────

insert into platform.approval_chains (request_type, step_no, approver_role, is_active)
values ('accounting_period_reopen', 1, 'GM', true)
on conflict (request_type, step_no) do nothing;

-- ── 5. billing.guard_fiscal_year() — D4 ──────────────────────────────────────────────────────────

create or replace function billing.guard_fiscal_year()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if new.entity_id is distinct from old.entity_id
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date then
    raise exception using errcode = '23514', message = format(
      '0040: fiscal year %s: entity_id, start_date and end_date are immutable '
      '(Allowed: create a new fiscal year instead)', old.id);
  end if;
  return new;
end $$;
comment on function billing.guard_fiscal_year() is
  'WBS 4.19 D4: entity_id, start_date and end_date of billing.fiscal_years are immutable (23514). '
  'SECURITY DEFINER, pinned search_path.';

revoke execute on function billing.guard_fiscal_year() from public;

drop trigger if exists trg_guard_fiscal_year on billing.fiscal_years;
create trigger trg_guard_fiscal_year
  before update on billing.fiscal_years
  for each row execute function billing.guard_fiscal_year();

-- ── 6. billing.guard_accounting_period() — D3 containment + D4 status edges ─────────────────────

create or replace function billing.guard_accounting_period()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_fy_start date;
  v_fy_end   date;
  v_rls_scoped boolean;
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'open' then
      raise exception using errcode = '23514', message = format(
        '0040: an accounting period is created with status ''open'' only, not ''%s'' '
        '(Allowed: insert at ''open'', then close and lock)', new.status);
    end if;

    -- Out of the caller's RLS scope: leave it to entity_scope WITH CHECK (42501) — see header.
    select not (r.rolsuper or r.rolbypassrls) into v_rls_scoped
      from pg_catalog.pg_roles r where r.rolname = session_user;
    if coalesce(v_rls_scoped, true) and not (new.entity_id = any (platform.allowed_entities())) then
      return new;
    end if;

    select fy.start_date, fy.end_date into v_fy_start, v_fy_end
      from billing.fiscal_years fy
     where fy.id = new.fiscal_year_id and fy.entity_id = new.entity_id;
    -- Not found: fk_accounting_periods_entity_fiscal_year refuses it (23503).
    if found and (new.start_date < v_fy_start or new.end_date > v_fy_end) then
      raise exception using errcode = '23514', message = format(
        '0040: accounting period %s..%s lies outside its fiscal year %s '
        '(Allowed: a date range inside that fiscal year)', new.start_date, new.end_date, new.fiscal_year_id),
        constraint = 'chk_accounting_periods_in_fiscal_year';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.entity_id is distinct from old.entity_id
     or new.fiscal_year_id is distinct from old.fiscal_year_id
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date then
    raise exception using errcode = '23514', message = format(
      '0040: accounting period %s: entity_id, fiscal_year_id, start_date and end_date are immutable '
      '(Allowed: status and version only)', old.id);
  end if;

  -- Close review round 1 #1: version never goes down, and a status change bumps it by exactly one —
  -- so a spent reopen decision (context periodVersion) can never be matched again by rewinding it.
  if new.version < old.version
     or (new.status is distinct from old.status and new.version <> old.version + 1) then
    raise exception using errcode = '23514', message = format(
      '0040: accounting period %s: version %s -> %s with status %s -> %s is refused '
      '(Allowed: version + 1 on a status change; never lower)',
      old.id, old.version, new.version, old.status, new.status);
  end if;

  if new.status = old.status
     or (old.status = 'open' and new.status = 'closed')
     or (old.status = 'closed' and new.status = 'locked') then
    return new;
  end if;

  if old.status = 'closed' and new.status = 'open' then
    if exists (
         select 1 from platform.decisions d
          where d.kind = 'accounting_period_reopen'
            and d.source_table = 'billing.accounting_periods'
            and d.source_id = old.id
            and d.entity_id = old.entity_id
            and d.status = 'decided'
            and d.decision = 'approved'
            and d.decided_by = platform.current_user_id()
            and d.decided_by::text <> (d.context ->> 'requestedBy')
            and (d.context ->> 'periodVersion') = old.version::text
       )
       and platform.is_approval_chain_approver('accounting_period_reopen') then
      return new;
    end if;
    raise exception using errcode = '23514', message = format(
      '0040: accounting period %s: closed -> open requires an approved accounting_period_reopen '
      'decision for version %s, decided by the current user (an approval-chain approver who is not '
      'the requester) (Allowed: reopen through the Decision Inbox)', old.id, old.version);
  end if;

  raise exception using errcode = '23514', message = format(
    '0040: accounting period %s: %s -> %s is not a legal transition '
    '(Allowed: open -> closed, closed -> locked, closed -> open through the Decision Inbox)',
    old.id, old.status, new.status);
end $$;
comment on function billing.guard_accounting_period() is
  'WBS 4.19 D3/D4: insert only at open and inside the period''s fiscal year; update only '
  'open->closed, closed->locked, same status, closed->open behind an approved Decision Inbox '
  'decision (SoD: decider = session user, approver role from platform.approval_chains, not the '
  'requester, same period version); entity_id, fiscal_year_id, start_date, end_date immutable. '
  'Every refusal 23514. SECURITY DEFINER, pinned search_path.';

revoke execute on function billing.guard_accounting_period() from public;

drop trigger if exists trg_guard_accounting_period on billing.accounting_periods;
create trigger trg_guard_accounting_period
  before insert or update on billing.accounting_periods
  for each row execute function billing.guard_accounting_period();

-- ── 7. billing.assert_posting_period() — D5, the DB-side refusal (acceptance line) ──────────────

create or replace function billing.assert_posting_period(p_entity_id uuid, p_entry_date date, p_period_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_period_id uuid;
  v_status    text;
begin
  select ap.id, ap.status into v_period_id, v_status
    from billing.accounting_periods ap
   where ap.entity_id = p_entity_id
     and daterange(ap.start_date, ap.end_date, '[]') @> p_entry_date
     for share;

  if not found then
    if p_period_id is not null then
      raise exception using errcode = '23514', message = format(
        '0040: period_id %s does not cover entry date %s of entity %s '
        '(Allowed: the period covering the entry date, or null)', p_period_id, p_entry_date, p_entity_id);
    end if;
    return;
  end if;

  if p_period_id is not null and p_period_id <> v_period_id then
    raise exception using errcode = '23514', message = format(
      '0040: period_id %s does not cover entry date %s of entity %s '
      '(Allowed: the period covering the entry date, or null)', p_period_id, p_entry_date, p_entity_id);
  end if;

  if v_status <> 'open' then
    raise exception using errcode = '23514', message = format(
      '0040: entry date %s of entity %s falls in an accounting period that is not open '
      '(Allowed: a date inside an open period of that entity)', p_entry_date, p_entity_id);
  end if;
end $$;
comment on function billing.assert_posting_period(uuid, date, uuid) is
  'WBS 4.19 D5 (ADR-0004 D1 5): refuses (23514) a posting whose covering period (same entity, '
  'date inside [start_date, end_date]) is closed or locked, or whose non-null period_id is not that '
  'covering period. The covering period is read FOR SHARE (a posting and a close serialise). '
  'SECURITY DEFINER, pinned search_path; called only by the journal triggers.';

revoke execute on function billing.assert_posting_period(uuid, date, uuid) from public;

create or replace function billing.assert_journal_entry_period()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform billing.assert_posting_period(old.entity_id, old.entry_date, old.period_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform billing.assert_posting_period(new.entity_id, new.entry_date, new.period_id);
  end if;
  return null;
end $$;
comment on function billing.assert_journal_entry_period() is
  'WBS 4.19 D5: billing.journal_entries — INSERT checks new, UPDATE old and new, DELETE old, '
  'through billing.assert_posting_period(). SECURITY DEFINER, pinned search_path.';

revoke execute on function billing.assert_journal_entry_period() from public;

drop trigger if exists trg_assert_journal_entry_period on billing.journal_entries;
create constraint trigger trg_assert_journal_entry_period
  after insert or update or delete on billing.journal_entries
  not deferrable initially immediate
  for each row execute function billing.assert_journal_entry_period();

create or replace function billing.assert_journal_line_period()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_entity_id  uuid;
  v_entry_date date;
  v_period_id  uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select je.entity_id, je.entry_date, je.period_id into v_entity_id, v_entry_date, v_period_id
      from billing.journal_entries je where je.id = old.entry_id;
    -- Not found: the parent entry is being deleted in this statement (ON DELETE CASCADE); its own
    -- trigger has already checked it.
    if found then
      perform billing.assert_posting_period(v_entity_id, v_entry_date, v_period_id);
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select je.entity_id, je.entry_date, je.period_id into v_entity_id, v_entry_date, v_period_id
      from billing.journal_entries je where je.id = new.entry_id;
    -- Not found: journal_lines_entry_id_fkey refuses it (23503).
    if found then
      perform billing.assert_posting_period(v_entity_id, v_entry_date, v_period_id);
    end if;
  end if;
  return null;
end $$;
comment on function billing.assert_journal_line_period() is
  'WBS 4.19 D5: billing.journal_lines — checked through the parent entry''s entity_id, entry_date '
  'and period_id; INSERT new, UPDATE old and new, DELETE old. SECURITY DEFINER, pinned search_path.';

revoke execute on function billing.assert_journal_line_period() from public;

drop trigger if exists trg_assert_journal_line_period on billing.journal_lines;
create constraint trigger trg_assert_journal_line_period
  after insert or update or delete on billing.journal_lines
  not deferrable initially immediate
  for each row execute function billing.assert_journal_line_period();

-- ── 7A. billing.guard_period_reopen_decision() — close review round 1 #2 ─────────────────────────
-- The SoD in billing.guard_accounting_period() compares decided_by with context->>'requestedBy';
-- pgeos_app holds DML on platform.decisions, so both the requester and the decision's identity must
-- be pinned: an RLS-scoped session files a reopen request only in its own name, and nobody rewrites
-- a reopen decision's kind, context, source_table, source_id or entity_id afterwards.

create or replace function billing.guard_period_reopen_decision()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_rls_scoped boolean;
begin
  if tg_op = 'INSERT' then
    if new.kind = 'accounting_period_reopen' then
      select not (r.rolsuper or r.rolbypassrls) into v_rls_scoped
        from pg_catalog.pg_roles r where r.rolname = session_user;
      if coalesce(v_rls_scoped, true)
         and (new.context ->> 'requestedBy') is distinct from platform.current_user_id()::text then
        raise exception using errcode = '23514', message =
          '0040: an accounting_period_reopen decision is filed in the caller''s own name only '
          '(Allowed: context.requestedBy = the session user)';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if (old.kind = 'accounting_period_reopen' or new.kind = 'accounting_period_reopen')
     and (new.kind is distinct from old.kind
          or new.context is distinct from old.context
          or new.source_table is distinct from old.source_table
          or new.source_id is distinct from old.source_id
          or new.entity_id is distinct from old.entity_id) then
    raise exception using errcode = '23514', message = format(
      '0040: decision %s: kind, context, source_table, source_id and entity_id of an '
      'accounting_period_reopen decision are immutable '
      '(Allowed: status, decision, decision_note, decided_by, decided_at)', old.id);
  end if;
  return new;
end $$;
comment on function billing.guard_period_reopen_decision() is
  'WBS 4.19 close review #2: an accounting_period_reopen platform.decisions row is inserted by an '
  'RLS-scoped session only with context.requestedBy = the session user, and its kind, context, '
  'source_table, source_id and entity_id never change (23514). SECURITY DEFINER, pinned search_path.';

revoke execute on function billing.guard_period_reopen_decision() from public;

drop trigger if exists trg_guard_period_reopen_decision on platform.decisions;
create trigger trg_guard_period_reopen_decision
  before insert or update on platform.decisions
  for each row execute function billing.guard_period_reopen_decision();

-- ── 8. pg_proc self-check (D5, 0038 C1) ──────────────────────────────────────────────────────────

do $$ begin
  if exists (
    select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid in ('billing.guard_fiscal_year()'::regprocedure,
                     'billing.guard_accounting_period()'::regprocedure,
                     'billing.assert_posting_period(uuid, date, uuid)'::regprocedure,
                     'billing.assert_journal_entry_period()'::regprocedure,
                     'billing.assert_journal_line_period()'::regprocedure,
                     'billing.guard_period_reopen_decision()'::regprocedure)
       and (not p.prosecdef
            or not (r.rolsuper or r.rolbypassrls)
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false))
  ) then
    raise exception '0040: guard_fiscal_year/guard_accounting_period/assert_posting_period/'
      'assert_journal_entry_period/assert_journal_line_period/guard_period_reopen_decision must be '
      'SECURITY DEFINER, '
      'owned by a superuser or BYPASSRLS role, with search_path pinned to pg_catalog, pg_temp';
  end if;
end $$;

-- ── 9. Column classification (G6, D7) ────────────────────────────────────────────────────────────

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('billing', 'fiscal_years',       'id',             'public'),
 ('billing', 'fiscal_years',       'entity_id',      'public'),
 ('billing', 'fiscal_years',       'start_date',     'public'),
 ('billing', 'fiscal_years',       'end_date',       'public'),
 ('billing', 'fiscal_years',       'version',        'public'),
 ('billing', 'fiscal_years',       'created_at',     'public'),
 ('billing', 'accounting_periods', 'id',             'public'),
 ('billing', 'accounting_periods', 'entity_id',      'public'),
 ('billing', 'accounting_periods', 'fiscal_year_id', 'public'),
 ('billing', 'accounting_periods', 'start_date',     'public'),
 ('billing', 'accounting_periods', 'end_date',       'public'),
 ('billing', 'accounting_periods', 'status',         'public'),
 ('billing', 'accounting_periods', 'version',        'public'),
 ('billing', 'accounting_periods', 'created_at',     'public'),
 ('billing', 'journal_entries',    'period_id',      'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
