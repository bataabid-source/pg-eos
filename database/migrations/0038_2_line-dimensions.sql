-- 0038_2_line-dimensions.sql — Lane 2 — WBS 4.1b part 2. Forward-only, idempotent (apply.sh re-runs
-- every file on every apply).
--
-- SCR-ACC-01 §A0 #9 (docs/notes/SCR-ACC-01-accounting-core.md), D-190 hybrid design: part 1 (0030)
-- built `billing.dimension_types`; this part builds the value structure and the line-tagging table:
--   - `billing.dimension_values` (entity_id, dimension_type_id, code, name, is_active, version) —
--     list-kind values, one row per value per entity.
--   - `billing.line_dimensions` (journal_line_id, entity_id, dimension_type_id, value_id) — a
--     journal line's dimension tag. `value_ref text` is never built (D-190).
--   - `billing.assert_dimension_value()` — ONE constraint trigger validating BOTH kinds (lane default
--     R1, brief "Lane defaults after pre-build review round 1"): the declarative composite FK
--     `(dimension_type_id, value_id) -> dimension_values` in D-190's wording cannot coexist with
--     reference-kind rows on one NOT NULL `value_id` (every reference tag would be refused) and
--     cannot express "inactive value refused, existing tags stay". The FK-vs-trigger wording is the
--     Master's question (option B = `kind` + generated `list_value_id`, needs a row-9 amendment).
--       list:      a `dimension_values` row with the SAME dimension_type_id must exist (else 23503)
--                  and be active and belong to the line's entity (else 23514).
--       reference: the row must exist in the type's whitelisted source_table (else 23503) and, where
--                  that source has entity_id, belong to the line's entity (else 23514). Static
--                  branches mirroring 0030's CHECK whitelist — no dynamic SQL from source_table (C2).
--   - `billing.assert_line_dimension_entity()` — the entity-deriving trigger carried from part 1's
--     review: line_dimensions.entity_id must equal journal_lines -> journal_entries.entity_id (23514).
--
-- R2 (RLS, finding 2): composite FKs `(entity_id, dimension_type_id) -> dimension_types (entity_id,
-- id)` on BOTH dimension_values and line_dimensions (needs `unique (entity_id, id)` on
-- dimension_types — a constraint, no column), so neither a value nor a tag can use a dimension type
-- of another entity.
--
-- Close review round 1 (one fix round): F1 — no SECURITY DEFINER message names data RLS hides from
-- the caller (no other entity's id; only new.* values the caller supplied). F2 — pgeos_app UPDATE on
-- billing.dimension_types is limited to (code, name_ar, name_en, is_active, version): entity_id, kind
-- and source_table are immutable for the app role, so a type cannot change kind or entity under its
-- existing values and tags. F4 — billing.assert_dimension_value_list_type(): a dimension_values row
-- may only reference a list-kind dimension type (23514).
--
-- C1: every validating function is plpgsql SECURITY DEFINER with `search_path = pg_catalog,
-- pg_temp`, fully qualified, read-only, owner checked in pg_proc at the end of this file; attached as
-- non-deferrable AFTER INSERT OR UPDATE row constraint triggers. C4 grants: line_dimensions is
-- append-only (select, insert; update/delete/truncate revoked — default privileges from 0007 grant
-- arwd); dimension_values is select, insert, update (is_active, version) only, no delete — with no FK
-- on value_id (R1), the missing DELETE and the column-limited UPDATE are what keep every list-kind
-- tag pointing at the value it was made with. C5: no cascade on any FK (a tagged journal line cannot
-- be deleted). C6: entity_scope RLS on both tables, 0030 pattern. C7: version on dimension_values
-- only; no version and no created_at on line_dimensions (append-only). C8: one column_classification
-- row per column. C9: no seed rows. C10: platform.audit_log is never touched here — the application
-- writes the audit row in the outbox transaction.

begin;

-- ── 1. dimension_types: unique (entity_id, id) — the R2 FK target ────────────────────────────────

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'uq_dimension_types_entity_id_id' and conrelid = 'billing.dimension_types'::regclass
  ) then
    alter table billing.dimension_types add constraint uq_dimension_types_entity_id_id
      unique (entity_id, id);
  end if;
end $$;

-- F2 (close review round 1): 0030 granted table-level UPDATE; entity_id, kind and source_table
-- become immutable for the app role (the columns values and tags depend on).
revoke update on billing.dimension_types from pgeos_app;
grant update (code, name_ar, name_en, is_active, version) on billing.dimension_types to pgeos_app;

-- ── 2. billing.dimension_values ──────────────────────────────────────────────────────────────────

create table if not exists billing.dimension_values (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references platform.entities(id),
  dimension_type_id  uuid not null,     -- composite FK (entity_id, dimension_type_id) below (R2)
  code               text not null,
  name               text not null,
  is_active          boolean not null default true,   -- deactivate is the only edge (D-190)
  version            int not null default 1
);
comment on table billing.dimension_values is
  'SCR-ACC-01 A0 #9, D-190 hybrid design: list-kind dimension values, per entity. Created active; '
  'deactivation (is_active true -> false, version + 1) is the only edge. A deactivated value keeps '
  'its code and every existing tag; billing.assert_dimension_value() refuses it on a new tag.';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_dimension_values_entity_type' and conrelid = 'billing.dimension_values'::regclass
  ) then
    alter table billing.dimension_values add constraint fk_dimension_values_entity_type
      foreign key (entity_id, dimension_type_id) references billing.dimension_types (entity_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'uq_dimension_values_entity_type_code' and conrelid = 'billing.dimension_values'::regclass
  ) then
    alter table billing.dimension_values add constraint uq_dimension_values_entity_type_code
      unique (entity_id, dimension_type_id, code);
  end if;
end $$;

create index if not exists dimension_values_type_idx on billing.dimension_values (dimension_type_id);

alter table billing.dimension_values enable row level security;

drop policy if exists entity_scope on billing.dimension_values;
create policy entity_scope on billing.dimension_values for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

revoke all on billing.dimension_values from pgeos_app;
grant select, insert on billing.dimension_values to pgeos_app;
grant update (is_active, version) on billing.dimension_values to pgeos_app;

-- ── 3. billing.line_dimensions ───────────────────────────────────────────────────────────────────

create table if not exists billing.line_dimensions (
  id                 uuid primary key default gen_random_uuid(),
  journal_line_id    uuid not null references billing.journal_lines(id),   -- no cascade (C5)
  entity_id          uuid not null references platform.entities(id),
  dimension_type_id  uuid not null,     -- composite FK (entity_id, dimension_type_id) below (R2)
  value_id           uuid not null      -- validated by billing.assert_dimension_value() (R1)
);
comment on table billing.line_dimensions is
  'SCR-ACC-01 A0 #9, D-190 hybrid design: a journal line''s dimension tag, append-only. value_id is '
  'a billing.dimension_values id (list kind) or a row id of the type''s whitelisted source_table '
  '(reference kind), validated by billing.assert_dimension_value(); entity_id must equal the entity '
  'of the journal entry (billing.assert_line_dimension_entity()).';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_line_dimensions_entity_type' and conrelid = 'billing.line_dimensions'::regclass
  ) then
    alter table billing.line_dimensions add constraint fk_line_dimensions_entity_type
      foreign key (entity_id, dimension_type_id) references billing.dimension_types (entity_id, id);
  end if;
end $$;

create index if not exists line_dimensions_journal_line_idx on billing.line_dimensions (journal_line_id);
create index if not exists line_dimensions_type_value_idx on billing.line_dimensions (dimension_type_id, value_id);

alter table billing.line_dimensions enable row level security;

drop policy if exists entity_scope on billing.line_dimensions;
create policy entity_scope on billing.line_dimensions for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

revoke all on billing.line_dimensions from pgeos_app;
grant select, insert on billing.line_dimensions to pgeos_app;
revoke update, delete, truncate on billing.line_dimensions from pgeos_app;

-- ── 4. billing.assert_dimension_value() — both kinds (R1, C1-C3) ─────────────────────────────────

create or replace function billing.assert_dimension_value()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_kind          text;
  v_source_table  text;
  v_value_entity  uuid;
  v_value_active  boolean;
  v_source_entity uuid;
  v_found         boolean;
begin
  select dt.kind, dt.source_table into v_kind, v_source_table
    from billing.dimension_types dt
   where dt.id = new.dimension_type_id;
  if not found then
    raise exception using errcode = '23503', message = format(
      '0038: dimension type %s does not exist (Allowed: a billing.dimension_types id of entity %s)',
      new.dimension_type_id, new.entity_id);
  end if;

  if v_kind = 'list' then
    select dv.entity_id, dv.is_active into v_value_entity, v_value_active
      from billing.dimension_values dv
     where dv.id = new.value_id and dv.dimension_type_id = new.dimension_type_id;
    if not found then
      raise exception using errcode = '23503', message = format(
        '0038: value %s is not defined for list dimension type %s (Allowed: a billing.dimension_values '
        'id of that dimension type)', new.value_id, new.dimension_type_id);
    end if;
    if not v_value_active then
      raise exception using errcode = '23514', message = format(
        '0038: value %s of dimension type %s is inactive (Allowed: an active billing.dimension_values '
        'id; existing tags stay)', new.value_id, new.dimension_type_id);
    end if;
    if v_value_entity <> new.entity_id then
      raise exception using errcode = '23514', message = format(
        '0038: value %s does not belong to the line''s entity (Allowed: a billing.dimension_values row '
        'of entity %s)', new.value_id, new.entity_id);
    end if;
    return null;
  end if;

  -- kind = 'reference': static branches over 0030's closed whitelist (C2) — never dynamic SQL.
  v_found := false;
  v_source_entity := null;
  if v_source_table = 'hr.employees' then
    select e.entity_id, true into v_source_entity, v_found from hr.employees e where e.id = new.value_id;
  elsif v_source_table = 'tms.vehicles' then
    select v.entity_id, true into v_source_entity, v_found from tms.vehicles v where v.id = new.value_id;
  elsif v_source_table = 'wms.warehouses' then
    select w.entity_id, true into v_source_entity, v_found from wms.warehouses w where w.id = new.value_id;
  elsif v_source_table = 'platform.sites' then
    select s.entity_id, true into v_source_entity, v_found from platform.sites s where s.id = new.value_id;
  elsif v_source_table = 'sales.accounts' then
    v_found := exists (select 1 from sales.accounts a where a.id = new.value_id);
  elsif v_source_table = 'partners.partners' then
    v_found := exists (select 1 from partners.partners p where p.id = new.value_id);
  elsif v_source_table = 'imile.shipments' then
    v_found := exists (select 1 from imile.shipments sh where sh.id = new.value_id);
  elsif v_source_table = 'platform.entities' then
    v_found := exists (select 1 from platform.entities en where en.id = new.value_id);
  else
    raise exception using errcode = '23514', message = format(
      '0038: dimension type %s has source_table %L outside the whitelist (Allowed: sales.accounts, '
      'partners.partners, hr.employees, tms.vehicles, wms.warehouses, platform.sites, imile.shipments, '
      'platform.entities)', new.dimension_type_id, v_source_table);
  end if;

  if not coalesce(v_found, false) then
    raise exception using errcode = '23503', message = format(
      '0038: value %s does not exist in %s (Allowed: an id of a row of %s)',
      new.value_id, v_source_table, v_source_table);
  end if;
  if v_source_entity is not null and v_source_entity <> new.entity_id then
    raise exception using errcode = '23514', message = format(
      '0038: %s row %s does not belong to the line''s entity (Allowed: a %s row of entity %s)',
      v_source_table, new.value_id, v_source_table, new.entity_id);
  end if;
  return null;
end $$;
comment on function billing.assert_dimension_value() is
  'SCR-ACC-01 A0 #9, D-190, lane default R1: validates billing.line_dimensions.value_id for both '
  'dimension kinds. list: an active billing.dimension_values row of the same dimension type and '
  'entity; reference: a row of the whitelisted source_table, of the line''s entity where the source '
  'has entity_id. Missing -> 23503; inactive or entity mismatch -> 23514. SECURITY DEFINER, pinned '
  'search_path, read-only.';

revoke execute on function billing.assert_dimension_value() from public;

drop trigger if exists trg_assert_dimension_value on billing.line_dimensions;
create constraint trigger trg_assert_dimension_value
  after insert or update on billing.line_dimensions
  not deferrable initially immediate
  for each row execute function billing.assert_dimension_value();

-- ── 5. billing.assert_line_dimension_entity() — the entity-deriving trigger ──────────────────────

create or replace function billing.assert_line_dimension_entity()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_entry_entity uuid;
begin
  select je.entity_id into v_entry_entity
    from billing.journal_lines jl
    join billing.journal_entries je on je.id = jl.entry_id
   where jl.id = new.journal_line_id;
  if not found then
    raise exception using errcode = '23503', message = format(
      '0038: journal line %s does not exist (Allowed: a billing.journal_lines id)', new.journal_line_id);
  end if;
  if v_entry_entity <> new.entity_id then
    raise exception using errcode = '23514', message = format(
      '0038: line_dimensions.entity_id %s does not match the entity of journal line %s (Allowed: a '
      'billing.journal_lines row of entity %s)', new.entity_id, new.journal_line_id, new.entity_id);
  end if;
  return null;
end $$;
comment on function billing.assert_line_dimension_entity() is
  'SCR-ACC-01 A0 #9 (carried from 4.1b part 1 review): billing.line_dimensions.entity_id must equal '
  'billing.journal_lines -> billing.journal_entries.entity_id (23514). SECURITY DEFINER, pinned '
  'search_path, read-only.';

revoke execute on function billing.assert_line_dimension_entity() from public;

drop trigger if exists trg_assert_line_dimension_entity on billing.line_dimensions;
create constraint trigger trg_assert_line_dimension_entity
  after insert or update on billing.line_dimensions
  not deferrable initially immediate
  for each row execute function billing.assert_line_dimension_entity();

-- ── 5A. billing.assert_dimension_value_list_type() — F4 ──────────────────────────────────────────
-- A dimension_values row may only reference a list-kind dimension type (D-190: list kind gets
-- dimension_values; a reference type's tags never read them). Fires on insert and on any update
-- (pgeos_app cannot update dimension_type_id — C4 — the admin path is covered too).

create or replace function billing.assert_dimension_value_list_type()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_kind text;
begin
  select dt.kind into v_kind
    from billing.dimension_types dt
   where dt.id = new.dimension_type_id and dt.entity_id = new.entity_id;
  if not found then
    raise exception using errcode = '23503', message = format(
      '0038: dimension type %s does not exist (Allowed: a billing.dimension_types id of entity %s)',
      new.dimension_type_id, new.entity_id);
  end if;
  if v_kind <> 'list' then
    raise exception using errcode = '23514', message = format(
      '0038: dimension type %s is not a list-kind type (Allowed: a billing.dimension_types id of '
      'kind ''list'' of entity %s; reference-kind types take no billing.dimension_values rows)',
      new.dimension_type_id, new.entity_id);
  end if;
  return null;
end $$;
comment on function billing.assert_dimension_value_list_type() is
  'SCR-ACC-01 A0 #9, D-190 (4.1b part 2 close review F4): a billing.dimension_values row may only '
  'reference a list-kind billing.dimension_types row (23514). SECURITY DEFINER, pinned search_path, '
  'read-only.';

revoke execute on function billing.assert_dimension_value_list_type() from public;

drop trigger if exists trg_assert_dimension_value_list_type on billing.dimension_values;
create constraint trigger trg_assert_dimension_value_list_type
  after insert or update on billing.dimension_values
  not deferrable initially immediate
  for each row execute function billing.assert_dimension_value_list_type();

-- ── 6. pg_proc self-check (C1) ───────────────────────────────────────────────────────────────────

do $$ begin
  if exists (
    select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid in ('billing.assert_dimension_value()'::regprocedure,
                     'billing.assert_line_dimension_entity()'::regprocedure,
                     'billing.assert_dimension_value_list_type()'::regprocedure)
       and (not p.prosecdef
            or not (r.rolsuper or r.rolbypassrls)
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false))
  ) then
    raise exception '0038: assert_dimension_value/assert_line_dimension_entity/assert_dimension_value_list_type '
      'must be SECURITY DEFINER, '
      'owned by a superuser or BYPASSRLS role, with search_path pinned to pg_catalog, pg_temp';
  end if;
end $$;

-- ── 7. Column classification (G6, C8) ────────────────────────────────────────────────────────────

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('billing', 'dimension_values', 'id',                'public'),
 ('billing', 'dimension_values', 'entity_id',         'public'),
 ('billing', 'dimension_values', 'dimension_type_id', 'public'),
 ('billing', 'dimension_values', 'code',              'public'),
 ('billing', 'dimension_values', 'name',              'public'),
 ('billing', 'dimension_values', 'is_active',         'public'),
 ('billing', 'dimension_values', 'version',           'public'),
 ('billing', 'line_dimensions',  'id',                'public'),
 ('billing', 'line_dimensions',  'journal_line_id',   'public'),
 ('billing', 'line_dimensions',  'entity_id',         'public'),
 ('billing', 'line_dimensions',  'dimension_type_id', 'public'),
 ('billing', 'line_dimensions',  'value_id',          'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
