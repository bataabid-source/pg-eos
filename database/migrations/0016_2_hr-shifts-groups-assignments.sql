-- 0016_2_hr-shifts-groups-assignments.sql — Lane 2 — WBS 5.5a (part 2). Forward-only, idempotent
-- (apply.sh re-runs every file on every apply).
--
-- SCR-HR-SHIFT-01 §2.1-§2.3 (docs/notes/SCR-HR-SHIFT-01-shifts-groups-sites-devices.md),
-- resolved under D-144 (GM 2026-09-24, §5 item 5: "أدرجها داخل الـpilot"). Part 1 (migration
-- 0015, applied) delivered platform.sites; this migration adds the three hr tables that
-- reference it: hr.shifts, hr.shift_groups (references hr.shifts + platform.sites), and
-- hr.shift_assignments (references hr.shifts + hr.shift_groups + hr.employees). Created in that
-- dependency order so every FK target exists before it is referenced.
--
-- Acceptance (doc 38 row 5.5a, verbatim): "One active shift assignment per employee per date
-- (exclusion constraint on the date range) ... a shift group carries its own attendance site and
-- lead driver". The exclusion constraint needs btree_gist (a uuid equality operator class usable
-- inside a GiST index alongside the daterange's range operator) — not present in 01/13/13B, added
-- here (extension, not a table — no G-01 schema-change request needed, same class of addition as
-- 01's own pgcrypto/pg_trgm).
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (6 findings, all applied) — (1) removed
-- chk_shift_groups_override_pair (not in SCR §2.3, an invented rule — a lone starts_at/ends_at
-- override is a valid reading of "override of the shift's times, nullable"); (2) grace_minutes
-- lost its `default 0` (no threshold exists for it in platform.thresholds, so a default was a
-- fabricated number — the caller must always supply it; NOT NULL kept); (3) hr.teams.shift
-- (01-Data-Model.sql:1297) now carries its own LEGACY column comment, as SCR §2.1 requires, not
-- just a comment on the new table; (4) an assignment's shift_id must match its group's shift_id
-- (SCR §1 line 4: a group is "inside a shift"; §2.3: members are the assignment rows carrying
-- group_id) — enforced with hr.shift_groups' own `unique (id, shift_id)` plus a composite FK
-- `(group_id, shift_id) references hr.shift_groups (id, shift_id)` on shift_assignments (MATCH
-- SIMPLE skips the check when group_id is NULL, which an ungrouped assignment needs); (5) this
-- line; (6) defaults recorded in the CHANGELOG (chk_shifts_dow 0=Sunday matching extract(dow),
-- chk_shifts_grace_nonneg, assigned_by -> identity.users per the art35_override_by precedent,
-- 13B:1829).

begin;

create extension if not exists "btree_gist";

-- Section 2.1 hr.shifts — replaces the free-text hr.teams.shift (01-Data-Model.sql:1297, kept,
-- marked legacy until a later migration). code/name_ar/name_en/is_active/version follow the same
-- shape as every other reference-style hr row (hr.teams, hr.employees). site_id is NOT NULL: SCR
-- section 2.1 marks group_id "(nullable)" explicitly on shift_assignments but does not mark
-- site_id nullable here, so it follows the schema's own convention that an unmarked FK is
-- required unless stated otherwise.
create table if not exists hr.shifts (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references platform.entities(id),
  code            text not null unique,
  name_ar         text not null, name_en text,
  starts_at       time not null,
  ends_at         time not null,
  crosses_midnight boolean not null default false,
  grace_minutes   int not null,
  days_of_week    int[] not null,
  site_id         uuid not null references platform.sites(id),
  is_active       boolean not null default true,
  version         int not null default 1
);
comment on table hr.shifts is
  'SCR-HR-SHIFT-01 section 2.1: replaces the free-text hr.teams.shift (01-Data-Model.sql:1297, '
  'kept, legacy until migrated).';
comment on column hr.shifts.days_of_week is
  '0=Sunday..6=Saturday; chk_shifts_dow enforces the domain.';

-- pg-reviewer finding 3: SCR §2.1 says hr.teams.shift (01-Data-Model.sql:1297) is "kept, marked
-- legacy until migrated" — the column itself needs the marker, not just this new table's comment.
comment on column hr.teams.shift is
  'LEGACY — superseded by hr.shifts (SCR-HR-SHIFT-01 section 2.1, migration 0016); kept until migrated.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_shifts_dow' and conrelid = 'hr.shifts'::regclass
  ) then
    alter table hr.shifts add constraint chk_shifts_dow
      check (cardinality(days_of_week) > 0 and days_of_week <@ array[0,1,2,3,4,5,6]);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'chk_shifts_grace_nonneg' and conrelid = 'hr.shifts'::regclass
  ) then
    alter table hr.shifts add constraint chk_shifts_grace_nonneg check (grace_minutes >= 0);
  end if;
end $$;

create index if not exists shifts_entity_active_idx on hr.shifts (entity_id, is_active);
create index if not exists shifts_site_idx on hr.shifts (site_id);

-- Section 2.3 hr.shift_groups — "the GM's transport group". Both lead_employee_id and site_id
-- are NOT NULL: doc 38 row 5.5a's acceptance criterion states, as an invariant of the row (not
-- just the transport group_type), "a shift group carries its own attendance site and lead
-- driver".
create table if not exists hr.shift_groups (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references platform.entities(id),
  shift_id         uuid not null references hr.shifts(id),
  code             text not null unique,
  name_ar          text not null,
  group_type       text not null,
  lead_employee_id uuid not null references hr.employees(id),
  vehicle_id       uuid references tms.vehicles(id),
  site_id          uuid not null references platform.sites(id),
  starts_at        time,
  ends_at          time,
  is_active        boolean not null default true,
  version          int not null default 1
);
comment on table hr.shift_groups is
  'SCR-HR-SHIFT-01 section 2.3. starts_at/ends_at override the parent shift own times when set '
  '(nullable, most groups follow the shift unmodified). Members are hr.shift_assignments rows '
  'carrying group_id.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_shift_groups_type' and conrelid = 'hr.shift_groups'::regclass
  ) then
    alter table hr.shift_groups add constraint chk_shift_groups_type
      check (group_type in ('transport','warehouse','other'));
  end if;
  -- pg-reviewer finding 4: lets shift_assignments carry a composite FK (group_id, shift_id) so a
  -- member row can never point at a group belonging to a DIFFERENT shift than the one the member
  -- itself is assigned to (SCR §1 line 4: a group is "inside a shift").
  if not exists (
    select 1 from pg_constraint where conname = 'shift_groups_id_shift_id_key' and conrelid = 'hr.shift_groups'::regclass
  ) then
    alter table hr.shift_groups add constraint shift_groups_id_shift_id_key unique (id, shift_id);
  end if;
end $$;

create index if not exists shift_groups_entity_shift_idx on hr.shift_groups (entity_id, shift_id);
create index if not exists shift_groups_site_idx on hr.shift_groups (site_id);
create index if not exists shift_groups_lead_employee_idx on hr.shift_groups (lead_employee_id);

-- Section 2.2 hr.shift_assignments — "One active assignment per employee per date (exclusion
-- constraint on the date range)" (doc 38 row 5.5a acceptance, verbatim). valid_to is nullable: an
-- open-ended assignment (still current) has no end date yet; daterange(valid_from, valid_to,
-- '[]') treats a NULL upper bound as unbounded, so the exclusion constraint still catches any
-- overlap against a later bounded or unbounded assignment for the same employee.
create table if not exists hr.shift_assignments (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references platform.entities(id),
  employee_id  uuid not null references hr.employees(id),
  shift_id     uuid not null references hr.shifts(id),
  -- group_id has no inline FK: pg-reviewer finding 4 requires the composite
  -- (group_id, shift_id) -> hr.shift_groups(id, shift_id) constraint below instead, so a member
  -- row can never disagree with its group about which shift it belongs to.
  group_id     uuid,
  valid_from   date not null,
  valid_to     date,
  assigned_by  uuid not null references identity.users(id),
  version      int not null default 1
);
comment on table hr.shift_assignments is
  'SCR-HR-SHIFT-01 section 2.2. shift_assignments_no_overlap (below) is the "one active '
  'assignment per employee per date" invariant at the database layer; modules/hr/domain '
  're-validates the same rule before ever reaching this constraint (doc 36 section 5-4 #2).';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_shift_assignments_valid_range' and conrelid = 'hr.shift_assignments'::regclass
  ) then
    alter table hr.shift_assignments add constraint chk_shift_assignments_valid_range
      check (valid_to is null or valid_to >= valid_from);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'shift_assignments_no_overlap' and conrelid = 'hr.shift_assignments'::regclass
  ) then
    alter table hr.shift_assignments add constraint shift_assignments_no_overlap
      exclude using gist (employee_id with =, daterange(valid_from, valid_to, '[]') with &&);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'shift_assignments_group_shift_fk' and conrelid = 'hr.shift_assignments'::regclass
  ) then
    -- MATCH SIMPLE (the default): skipped when group_id is NULL, which an ungrouped assignment
    -- needs. When group_id IS set, shift_id must match that group's own shift_id (pg-reviewer
    -- finding 4).
    alter table hr.shift_assignments add constraint shift_assignments_group_shift_fk
      foreign key (group_id, shift_id) references hr.shift_groups (id, shift_id);
  end if;
end $$;

create index if not exists shift_assignments_shift_idx on hr.shift_assignments (shift_id);
create index if not exists shift_assignments_group_idx on hr.shift_assignments (group_id);

-- RLS: all three tables have entity_id not null -> the same entity_scope pattern as migration
-- 0015 (platform.sites). Each needs its own explicit enable + policy + grant: the 13B blanket RLS
-- loop and 0007's grant loop both ran before this migration exists, so neither sees these tables
-- on a clean apply.sh --recreate.
alter table hr.shifts            enable row level security;
alter table hr.shift_groups      enable row level security;
alter table hr.shift_assignments enable row level security;

drop policy if exists entity_scope on hr.shifts;
create policy entity_scope on hr.shifts for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

drop policy if exists entity_scope on hr.shift_groups;
create policy entity_scope on hr.shift_groups for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

drop policy if exists entity_scope on hr.shift_assignments;
create policy entity_scope on hr.shift_assignments for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

grant select, insert, update, delete on hr.shifts            to pgeos_app;
grant select, insert, update, delete on hr.shift_groups      to pgeos_app;
grant select, insert, update, delete on hr.shift_assignments to pgeos_app;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('hr', 'shifts', 'id',               'public'),
 ('hr', 'shifts', 'entity_id',        'public'),
 ('hr', 'shifts', 'code',             'public'),
 ('hr', 'shifts', 'name_ar',          'public'),
 ('hr', 'shifts', 'name_en',          'public'),
 ('hr', 'shifts', 'starts_at',        'public'),
 ('hr', 'shifts', 'ends_at',          'public'),
 ('hr', 'shifts', 'crosses_midnight', 'public'),
 ('hr', 'shifts', 'grace_minutes',    'public'),
 ('hr', 'shifts', 'days_of_week',     'public'),
 ('hr', 'shifts', 'site_id',          'public'),
 ('hr', 'shifts', 'is_active',        'public'),
 ('hr', 'shifts', 'version',          'public'),
 ('hr', 'shift_groups', 'id',                'public'),
 ('hr', 'shift_groups', 'entity_id',         'public'),
 ('hr', 'shift_groups', 'shift_id',          'public'),
 ('hr', 'shift_groups', 'code',              'public'),
 ('hr', 'shift_groups', 'name_ar',           'public'),
 ('hr', 'shift_groups', 'group_type',        'public'),
 ('hr', 'shift_groups', 'lead_employee_id',  'public'),
 ('hr', 'shift_groups', 'vehicle_id',        'public'),
 ('hr', 'shift_groups', 'site_id',           'public'),
 ('hr', 'shift_groups', 'starts_at',         'public'),
 ('hr', 'shift_groups', 'ends_at',           'public'),
 ('hr', 'shift_groups', 'is_active',         'public'),
 ('hr', 'shift_groups', 'version',           'public'),
 ('hr', 'shift_assignments', 'id',           'public'),
 ('hr', 'shift_assignments', 'entity_id',    'public'),
 ('hr', 'shift_assignments', 'employee_id',  'public'),
 ('hr', 'shift_assignments', 'shift_id',     'public'),
 ('hr', 'shift_assignments', 'group_id',     'public'),
 ('hr', 'shift_assignments', 'valid_from',   'public'),
 ('hr', 'shift_assignments', 'valid_to',     'public'),
 ('hr', 'shift_assignments', 'assigned_by',  'public'),
 ('hr', 'shift_assignments', 'version',      'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
