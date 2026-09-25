-- 0026_1_contract-sku-limits.sql — Lane 1 — WBS 2.11 part 5 (condition 10). Forward-only, idempotent
-- (apply.sh re-runs every file on every apply). GM ruling D-189, SCR-WMS-OUT-02 §6: per-contract,
-- per-SKU order-quantity limit; no row = no limit. Shape precedent: wms.space_allocations (13B:998).
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (7 findings) — composite FK
-- (contract_id, entity_id) -> sales.contracts(id, entity_id) so a limit row can never sit in a
-- different entity than its contract (absent row = no limit, so a mismatch would silently fail
-- open); sku/client consistency left application-level (01/13B precedent); audit columns per
-- 13B:992 / 01:79-80; entity_scope verbatim 0016 with explicit WITH CHECK (G7, D-133).
begin;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'contracts_id_entity_id_key' and conrelid = 'sales.contracts'::regclass
  ) then
    alter table sales.contracts add constraint contracts_id_entity_id_key unique (id, entity_id);
  end if;
end $$;

create table if not exists sales.contract_sku_limits (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references platform.entities(id),
  contract_id   uuid not null,
  sku_id        uuid not null references wms.skus(id),
  max_order_qty numeric(14,3) not null,
  version       int not null default 1,
  created_at    timestamptz not null default now(),
  created_by    uuid not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  constraint contract_sku_limits_contract_entity_fk
    foreign key (contract_id, entity_id) references sales.contracts (id, entity_id),
  constraint contract_sku_limits_contract_sku_key unique (contract_id, sku_id),
  constraint chk_contract_sku_limits_qty_positive check (max_order_qty > 0)
);
comment on table sales.contract_sku_limits is
  'D-189 / SCR-WMS-OUT-02 section 6: per-contract, per-SKU maximum order quantity (condition 10 of '
  'the outbound checks). No row for (contract_id, sku_id) = no limit. sku_id must belong to the '
  'contract''s account_id — application-level invariant (writer validates).';

alter table sales.contract_sku_limits enable row level security;

drop policy if exists entity_scope on sales.contract_sku_limits;
create policy entity_scope on sales.contract_sku_limits for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

grant select, insert, update, delete on sales.contract_sku_limits to pgeos_app;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('sales', 'contract_sku_limits', 'id',            'public'),
 ('sales', 'contract_sku_limits', 'entity_id',     'public'),
 ('sales', 'contract_sku_limits', 'contract_id',   'public'),
 ('sales', 'contract_sku_limits', 'sku_id',        'public'),
 ('sales', 'contract_sku_limits', 'max_order_qty', 'public'),
 ('sales', 'contract_sku_limits', 'version',       'public'),
 ('sales', 'contract_sku_limits', 'created_at',    'public'),
 ('sales', 'contract_sku_limits', 'created_by',    'public'),
 ('sales', 'contract_sku_limits', 'updated_at',    'public'),
 ('sales', 'contract_sku_limits', 'updated_by',    'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
