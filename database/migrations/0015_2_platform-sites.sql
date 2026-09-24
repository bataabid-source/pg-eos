-- 0015_2_platform-sites.sql — Lane 2 — WBS 5.5a (part 1). Forward-only, idempotent (apply.sh
-- re-runs every file on every apply).
--
-- SCR-HR-SHIFT-01 §2.4 (docs/notes/SCR-HR-SHIFT-01-shifts-groups-sites-devices.md), resolved
-- under D-144 (GM 2026-09-24, §5 item 4: "نعم جدول واحد"): platform.sites unifies the two
-- proposals sales.account_sites (SCR-TMS-PICKUP-01 §3.3(b)) and hr.work_sites (SCR-HR-ATT-01
-- §2.4(b)) into ONE table. hr.employees.default_site_id references it (part of this same
-- migration — trivial column, no logic). hr.shifts.site_id / hr.shift_groups.site_id (WBS 5.5a
-- part 2, a later migration, number issued by the Master) will reference it too; not created
-- yet, so this migration does not forward-reference anything that does not exist.
--
-- radius_m default: platform.thresholds key att.geofence_radius_m, seeded 500 (D-141 Q30b,
-- decision sheet 2 line 132). Pattern: 0010_M_idempotency-keys-variance-photo.sql's
-- platform.idempotency_ttl() — a helper function read at column-default time, so the value is
-- never a literal in application code (CLAUDE.md · AGENT CONSTRAINTS "No magic numbers"). Unlike
-- idempotency_ttl(), this function needs no SECURITY DEFINER: is_internal() depends on a
-- per-session setting (0001:52-53), not on the pgeos_app role itself — pgeos_app also serves
-- portal sessions (0010:18-20) — but a non-internal (portal) session can never satisfy this
-- table's own entity_scope insert check anyway, because platform.allowed_entities() is empty for
-- a client caller (01:327-332, 0003's users_reject_client_with_entities trigger); so the default
-- is only ever evaluated in an internal session, which already has SELECT on platform.thresholds
-- via reference_read (13B:3069, 3117-3119). Raises if the threshold row is missing/invisible
-- rather than silently defaulting radius_m to NULL and failing on the NOT NULL constraint with an
-- unclear 23502 (0010's idempotency_ttl() precedent, 0010:36-45).
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (7 findings, all applied) — findings:
-- (1) added the missing 'id' column classification row so a clean apply.sh --recreate does not
-- leave it unclassified (G6); (2) geo_lat/geo_lng widened to numeric(10,7) to match every other
-- lat/lng column in the schema (01:883, 01:922, 13B:1189, 13B:1256); (3) this header's
-- SECURITY DEFINER reasoning corrected as above; (4) att_geofence_radius_m() rewritten
-- plpgsql, raises on a missing/null threshold instead of returning NULL; (5) the two
-- "if not exists" constraint-name lookups now also filter on conrelid = 'platform.sites'::regclass
-- (a same-named constraint on another table would otherwise make the lookup skip silently);
-- (6) the header no longer names migration "0016" for part 2 (a number the Master has not
-- issued); (7) this line replaces the earlier "<PENDING>" placeholder.

begin;

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
 ('att.geofence_radius_m', 500.000, 'm',
  'نصف قطر السياج الجغرافي الافتراضي لموقع عمل جديد — D-141 Q30b، SCR-HR-SHIFT-01 §2.4',
  '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

create or replace function platform.att_geofence_radius_m() returns numeric
language plpgsql stable as $$
declare v numeric;
begin
  select t.value into v from platform.thresholds t where t.key = 'att.geofence_radius_m';
  if v is null then
    raise exception '0015: threshold att.geofence_radius_m missing or not visible to this session';
  end if;
  return v;
end $$;

create table if not exists platform.sites (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  kind          text not null,     -- warehouse · office · client_pickup · housing · other
  account_id    uuid references sales.accounts(id),      -- required when kind = 'client_pickup'
  warehouse_id  uuid references wms.warehouses(id),
  name_ar       text not null, name_en text,
  -- one 'address' column (backlog brief tasks/backlog/5.5a-shifts-groups-sites.md line 22
  -- wording); SCR-HR-SHIFT-01 §2.4 says "address fields" (plural) — lane default, recorded in
  -- CHANGELOG, not a G-01 invention (no structured address shape exists elsewhere to copy).
  address       text,
  -- numeric(10,7): matches every existing lat/lng pair in the schema (01:883, 01:922,
  -- 13B:1189, 13B:1256) — not a new shape.
  geo_lat       numeric(10,7),
  geo_lng       numeric(10,7),
  radius_m      numeric not null default platform.att_geofence_radius_m(),
  contact_phone text,
  is_active     boolean not null default true,
  version       int not null default 1
);
comment on table platform.sites is
  'SCR-HR-SHIFT-01 §2.4, D-144 item 4: the single sites table, replacing the sales.account_sites '
  'and hr.work_sites proposals. hr.employees.default_site_id (this migration) and, from WBS 5.5a '
  'part 2, hr.shifts.site_id / hr.shift_groups.site_id reference it.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_sites_kind' and conrelid = 'platform.sites'::regclass
  ) then
    alter table platform.sites add constraint chk_sites_kind
      check (kind in ('warehouse','office','client_pickup','housing','other'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'chk_sites_client_pickup_account' and conrelid = 'platform.sites'::regclass
  ) then
    alter table platform.sites add constraint chk_sites_client_pickup_account
      check (kind <> 'client_pickup' or account_id is not null);
  end if;
end $$;

create index if not exists sites_entity_kind_idx on platform.sites (entity_id, kind);

alter table platform.sites enable row level security;

drop policy if exists entity_scope on platform.sites;
create policy entity_scope on platform.sites for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

grant select, insert, update, delete on platform.sites to pgeos_app;

revoke execute on function platform.att_geofence_radius_m() from public;
grant  execute on function platform.att_geofence_radius_m() to pgeos_app;

-- hr.employees.default_site_id — SCR-HR-SHIFT-01 §2.4: "hr.employees.default_site_id ... both
-- reference it." Nullable (not every employee has a fixed site yet); no version bump semantics
-- of its own — RecordEmployeeDocument/RegisterEmployee (WBS 3.3) do not touch it; a later 5.5a
-- part-2 command sets it.
alter table hr.employees add column if not exists default_site_id uuid references platform.sites(id);

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('platform', 'sites', 'id',            'public'),
 ('platform', 'sites', 'entity_id',     'public'),
 ('platform', 'sites', 'kind',          'public'),
 ('platform', 'sites', 'account_id',    'public'),
 ('platform', 'sites', 'warehouse_id',  'public'),
 ('platform', 'sites', 'name_ar',       'public'),
 ('platform', 'sites', 'name_en',       'public'),
 ('platform', 'sites', 'address',       'public'),
 ('platform', 'sites', 'geo_lat',       'public'),
 ('platform', 'sites', 'geo_lng',       'public'),
 ('platform', 'sites', 'radius_m',      'public'),
 ('platform', 'sites', 'contact_phone', 'personal'),
 ('platform', 'sites', 'is_active',     'public'),
 ('platform', 'sites', 'version',       'public'),
 ('hr',       'employees', 'default_site_id', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
