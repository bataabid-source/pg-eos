-- 0030_2_dimensions.sql — Lane 2 — WBS 4.1b part 1. Forward-only, idempotent (apply.sh re-runs
-- every file on every apply).
--
-- SCR-ACC-01 §A0 #9 (docs/notes/SCR-ACC-01-accounting-core.md): "new billing.dimension_types, new
-- billing.line_dimensions — dimensions as data; backs the fixed client_id/contract_id/cost_center
-- (01:1208-1210)." This migration builds `billing.dimension_types` ONLY — the Master's scope
-- ruling after pre-migration round 1 finding 1 (a line_dimensions row without a value column is a
-- half-record, and adding a NOT-NULL value column to an already-populated table later is the wrong
-- migration order). `billing.line_dimensions`, `billing.dimension_values` and the
-- `billing.assert_dimension_value()` constraint trigger are part 2's, once the value structure
-- that gives a tagged line meaning exists.
--
-- ADR-0004 D1 6: "entity_id stays a hard column; every other axis is dimension data." ADR-0004
-- D2 (d): "entity_id stays the hard column (RLS/SoD depend on it, 0003/0025); generic dimension
-- tables (A0 §3 row 9) for every other axis; client_id/contract_id kept as derived copies (P2
-- allows derivation)." This table is that generic dimension-type registry.
--
-- kind/source_table hybrid design (list vs reference dimensions): a decision the Master relayed
-- from the evaluation session under D-190. It is NOT yet recorded in SCR-ACC-01 row 9 /
-- DECISION_LOG as of this migration — pg-scribe records it in SCR-ACC-01 row 9 and DECISION_LOG in
-- THIS SAME slice's closing commit, not before. `value_ref text` (free text) was considered and
-- dropped entirely under this same ruling (round-1 finding 1) — never built, in this part or any
-- later part; part 2 uses `value_id uuid` instead (list: FK to `dimension_values`; reference:
-- validated by a constraint trigger against the whitelisted source table below).
--
-- RLS: `dimension_types` is entity-scoped (pattern (1), entity_id hard column, D1 6), NOT a
-- reference table (pattern (3)) — each company defines its own dimension types (multi-company from
-- day one, D-127 pilot on a synthetic chart). Entity-scope only requires the caller be an internal
-- user scoped to the row's entity (platform.allowed_entities()) — unlike billing.gl_accounts's
-- reference_write, it does NOT depend on platform.has_perm('platform.reference.manage'), which
-- currently has no holder (4.1a's withdrawn-grant finding). This clears 4.1a's permission-gap wall
-- for any later write path built on this table (not built, not decided here).
--
-- NOT built this migration, and why: `billing.line_dimensions` (needs the value structure below
-- first — half-record ordering problem), `billing.dimension_values` (list-kind values, part 2),
-- any trigger (billing.assert_dimension_value() validates reference-kind values against the
-- whitelist below — needs line_dimensions.value_id to validate, part 2), `value_id` (part 2's
-- column, on line_dimensions), `value_ref` (dropped permanently, see above).
--
-- CHECK constraint three-valued-logic note (brief "Schema design", verbatim): Postgres NULL-in-OR
-- is not "reject" — `source_table in (...)` on a NULL source_table evaluates to NULL, and
-- `NULL or false` is NULL, and a CHECK constraint that evaluates to NULL PASSES. A bare
-- `kind = 'reference' and source_table in (...)` WITHOUT an explicit `source_table is not null`
-- would silently admit a 'reference' row with a NULL source_table, contradicting
-- modules/billing/domain/dimensions/invariants.ts's isValidDimensionTypeKindSourcePair (which
-- correctly rejects that pair) and one of dimensions.test.ts's own scenarios. Fixed below with an
-- explicit `source_table is not null` in the first disjunct (pre-migration round 2 finding 1).
--
-- Pre-migration pg-reviewer review history: round 1 FAIL (12 findings, broader scope — included
-- line_dimensions/dimension_values/value structure) — the Master split the slice into part 1
-- (dimension_types only, this migration) and part 2 (line_dimensions + values, later). Round 2
-- FAIL (11 findings on the narrowed part-1 draft) — findings 1 (this CHECK bug) and 2 (this header)
-- fixed in this revision; findings 3/4 (governance/G2 guard cleanup) resolved by the Master;
-- findings 5/6/7 already resolved or judged non-issues; findings 8/9/10 (test-file fixes) applied
-- in parallel to this fix round.

begin;

create table if not exists billing.dimension_types (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  code          text not null,
  name_ar       text not null,
  name_en       text,
  is_active     boolean not null default true,
  version       int not null default 1,
  kind          text not null,     -- list · reference (D-190 hybrid design)
  source_table  text               -- required (whitelisted) when kind = 'reference'; must be
                                    -- null when kind = 'list' — see CHECK below
);
comment on table billing.dimension_types is
  'SCR-ACC-01 A0 #9, ADR-0004 D1 6 / D2 (d): the generic dimension-type registry backing the '
  'fixed entity_id column — every other billing axis (cost centre, project, department, or a '
  'reference to another module''s own entity) is dimension data, not a schema column. D-190 '
  'hybrid design: kind = ''list'' types are tagged with a value from billing.dimension_values '
  '(part 2); kind = ''reference'' types are tagged with a row id from one of the source_table '
  'whitelist below (part 2''s billing.assert_dimension_value() trigger). billing.line_dimensions '
  '(part 2) is the line-tagging table that uses this registry; it does not exist yet.';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_dimension_types_kind' and conrelid = 'billing.dimension_types'::regclass
  ) then
    alter table billing.dimension_types add constraint chk_dimension_types_kind
      check (kind in ('list', 'reference'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_dimension_types_kind_source_table'
      and conrelid = 'billing.dimension_types'::regclass
  ) then
    alter table billing.dimension_types add constraint chk_dimension_types_kind_source_table
      check (
        (kind = 'reference' and source_table is not null and source_table in (
          'sales.accounts', 'partners.partners', 'hr.employees', 'tms.vehicles',
          'wms.warehouses', 'platform.sites', 'imile.shipments', 'platform.entities'
        ))
        or (kind = 'list' and source_table is null)
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'uq_dimension_types_entity_code'
      and conrelid = 'billing.dimension_types'::regclass
  ) then
    alter table billing.dimension_types add constraint uq_dimension_types_entity_code
      unique (entity_id, code);
  end if;
end $$;

create index if not exists dimension_types_entity_kind_idx
  on billing.dimension_types (entity_id, kind);

alter table billing.dimension_types enable row level security;

drop policy if exists entity_scope on billing.dimension_types;
create policy entity_scope on billing.dimension_types for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

grant select, insert, update, delete on billing.dimension_types to pgeos_app;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('billing', 'dimension_types', 'id',           'public'),
 ('billing', 'dimension_types', 'entity_id',    'public'),
 ('billing', 'dimension_types', 'code',         'public'),
 ('billing', 'dimension_types', 'name_ar',      'public'),
 ('billing', 'dimension_types', 'name_en',      'public'),
 ('billing', 'dimension_types', 'is_active',    'public'),
 ('billing', 'dimension_types', 'version',      'public'),
 ('billing', 'dimension_types', 'kind',         'public'),
 ('billing', 'dimension_types', 'source_table', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
