-- 0039_M_worker-role-outbox-relay.sql — lane M (Master), X part 5b (ADR-0006 §1, D-193).
--
-- The outbox relay worker (`apps/worker`) runs `relayOnce` (packages/events/src/relay.ts) as a
-- dedicated NON-superuser service role, `pgeos_worker` — never PGUSER=postgres (D-183: never
-- bypassrls, never superuser). This file is the G-01 decision relay.ts's header "RLS / SUPERUSER
-- GAP" asked for: a LOGIN role with `using (true)` policies scoped `to pgeos_worker` on
-- platform.outbox only (select + column-limited update), OR-ed with the generic `entity_scope`
-- policy for this role alone; `entity_scope` itself is untouched, so every other role sees exactly
-- what it saw before.
--
-- Grants = the relay's own statements and nothing else (relay.ts:136-145, :170, :174-177):
--   select … from platform.outbox where published_at is null [and event_type = $2] order by id
--   update platform.outbox set published_at = now() where id = $1
--   update platform.outbox set attempts = attempts + 1, last_error = $2 where id = $1
-- No insert/delete/truncate, no sequence, no other table, no view, no platform.thresholds.
--
-- PUBLIC EXECUTE: like every role, pgeos_worker inherits PUBLIC's default EXECUTE on platform
-- functions. The mutating SECURITY DEFINER functions are already revoked from PUBLIC
-- (0004, 0009, 0010, 0015, 0034) — e.g. platform.purge_idempotency_keys() → 42501 for this role.
--
-- Idempotent (apply.sh re-runs every file): role create-or-alter (0007:49-58), grant connect via
-- current_database() (0007:60-63), `drop policy if exists` before each `create policy`
-- (0007:248-249). No password is set here (Tier 0 credential: X part 5c). No new column →
-- identity.column_classification unchanged (G6).
--
-- RED tests (tasks/backlog/MIGRATION-REQUEST-M.md): apps/worker/tests/worker-role.test.ts,
-- apps/worker/tests/relay-loop.test.ts.

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) Role: pgeos_worker — LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB,
--    NOREPLICATION, no password, owns nothing, member of nothing.
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pgeos_worker') then
    create role pgeos_worker login nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
    raise notice '0039: created role pgeos_worker';
  else
    alter role pgeos_worker login nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
    raise notice '0039: pgeos_worker already exists — attributes re-applied';
  end if;
end $$;

do $$
begin
  execute format('grant connect on database %I to pgeos_worker', current_database());
end $$;

grant usage on schema platform to pgeos_worker;

-- ───────────────────────────────────────────────────────────────────────────
-- 2) Grants — the relay's statements only.
-- ───────────────────────────────────────────────────────────────────────────
grant select, update (published_at, attempts, last_error) on platform.outbox to pgeos_worker;

-- Stated explicitly: the worker never reads or writes the audit book (G9's audit row per outbox
-- row is the writer's duty, never the relay's — packages/events/src/outbox.ts).
revoke all on platform.audit_log from pgeos_worker;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) RLS — two permissive policies scoped to pgeos_worker (OR-ed with entity_scope for this role
--    only). An UPDATE with a WHERE also applies the SELECT policies, hence both.
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists outbox_relay on platform.outbox;
create policy outbox_relay on platform.outbox
  for select to pgeos_worker using (true);

drop policy if exists outbox_relay_update on platform.outbox;
create policy outbox_relay_update on platform.outbox
  for update to pgeos_worker using (true) with check (true);

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (trust apps/worker/tests/worker-role.test.ts):
--   select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'pgeos_worker';
--     → pgeos_worker | f | f | t
--   select count(*) from pg_auth_members
--    where member = 'pgeos_worker'::regrole or roleid = 'pgeos_worker'::regrole;
--     → 0
