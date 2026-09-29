-- 0041_2_post-journal.sql — Lane 2 — WBS 4.20 "Posting engine: entry types, reversal/adjustment,
-- balance at commit, posted immutable". Forward-only, idempotent (apply.sh re-runs every file on
-- every apply: `add column if not exists`, guarded constraint adds, `drop … if exists` + create,
-- `create or replace function`, revoke/grant, a read-only pg_proc self-check). One transaction.
--
-- SOURCES: SCR-ACC-01 #5 (billing.journal_entries, 01:1189 — "Entry type; approved by/at
-- (posted_at/by exist, 01:1197)"), #6 ("Balance enforced at commit (constraint trigger), not only
-- G2"), #7 (01:1204 `journal_lines.entry_id … on delete cascade`; no REVOKE on journals — "Posted
-- entries immutable (doc 40 P3); cascade removed"), #8 (01:1205 — "Account in the entry's entity and
-- `is_postable`"). ADR-0004 D1 3 / D1 4 / D3 OD-15 and Consequences 4. Entry types: A0 §1 row 4,
-- verbatim. The `version` column follows the settled design (pre-migration review, F2 — Master SCR
-- row pending).
--
-- ORDERING (0010 / 0038 / 0044 precedent): 0007_M_pgeos-app-role-entity-scope.sql re-grants
-- `select, insert, update, delete` on EVERY table of the schema to pgeos_app on every apply. The
-- revoke in §5 holds only because 0041 sorts (and runs) after 0007; a later migration that
-- re-grants DML on billing.* must restate it.
--
-- SCHEMA PARITY: database/schema/* is not edited; 01:1204 (the cascade) is corrected here, forward.
--
-- DEFINER DISCIPLINE (0040 §8, 0044): every function is `security definer set search_path =
-- pg_catalog, pg_temp`, static SQL, schema-qualified, execute revoked from public; only
-- billing.mark_journal_reversed() is granted to pgeos_app. Every refusal is SQLSTATE 23514 and its
-- message names only the row's own values (0038 F1).
--
-- ROLLBACK: forward-only. A later forward migration would drop the triggers/function and re-grant.

begin;

-- ── 0. 0-rows guard: entry_type is NOT NULL and no default is invented ──────────────────────────

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'billing' and table_name = 'journal_entries' and column_name = 'entry_type'
  ) and exists (select 1 from billing.journal_entries) then
    raise exception '0041: billing.journal_entries must hold 0 rows before entry_type (NOT NULL, no '
      'default) is added (ADR-0004 Consequences 4: "0 journal rows")';
  end if;
end $$;

-- ── 1. SCR-ACC-01 #5 — entry type, approval, version ─────────────────────────────────────────────

alter table billing.journal_entries add column if not exists entry_type  text;
alter table billing.journal_entries alter column entry_type set not null;
alter table billing.journal_entries add column if not exists approved_by uuid;          -- no FK, like posted_by
alter table billing.journal_entries add column if not exists approved_at timestamptz;
alter table billing.journal_entries add column if not exists version     int not null default 1;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_journal_entries_entry_type'
                   and conrelid = 'billing.journal_entries'::regclass) then
    alter table billing.journal_entries add constraint chk_journal_entries_entry_type check (
      entry_type in ('manual', 'recurring', 'reversing', 'adjustment', 'accrual', 'prepayment', 'closing'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_journal_entries_manual_approved'
                   and conrelid = 'billing.journal_entries'::regclass) then
    -- D3 OD-15: "Manual journals allowed except revenue accounts; CFO approval".
    alter table billing.journal_entries add constraint chk_journal_entries_manual_approved
      check (entry_type <> 'manual' or approved_by is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_journal_entries_approval_pair'
                   and conrelid = 'billing.journal_entries'::regclass) then
    alter table billing.journal_entries add constraint chk_journal_entries_approval_pair
      check ((approved_by is null) = (approved_at is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_journal_entries_version'
                   and conrelid = 'billing.journal_entries'::regclass) then
    alter table billing.journal_entries add constraint chk_journal_entries_version check (version >= 1);
  end if;
end $$;

-- An entry is reversed by at most one reversing entry, and a reversing entry reverses at most one.
create unique index if not exists journal_entries_reversed_by_key
  on billing.journal_entries (reversed_by) where reversed_by is not null;

-- ── 2. SCR-ACC-01 #7 — journal_lines.entry_id FK without on delete cascade (01:1204) ────────────

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'journal_lines_entry_id_fkey'
               and conrelid = 'billing.journal_lines'::regclass and confdeltype = 'c') then
    alter table billing.journal_lines drop constraint journal_lines_entry_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journal_lines_entry_id_fkey'
                   and conrelid = 'billing.journal_lines'::regclass) then
    alter table billing.journal_lines add constraint journal_lines_entry_id_fkey
      foreign key (entry_id) references billing.journal_entries (id);
  end if;
end $$;

create index if not exists journal_lines_entry_idx on billing.journal_lines (entry_id);

-- ── 3. journal_lines RLS — scoped through the parent entry (replaces internal_only) ─────────────
-- The subquery runs under billing.journal_entries' own entity_scope policy, so a line is visible and
-- writable only when its entry is in the caller's allowed_entities().

alter table billing.journal_lines enable row level security;
alter table billing.journal_lines force row level security;

drop policy if exists internal_only on billing.journal_lines;
drop policy if exists entry_scope on billing.journal_lines;
create policy entry_scope on billing.journal_lines for all
  using (platform.is_internal()
         and exists (select 1 from billing.journal_entries e where e.id = journal_lines.entry_id))
  with check (platform.is_internal()
              and exists (select 1 from billing.journal_entries e where e.id = journal_lines.entry_id));

-- ── 4. T1/T2 — SCR-ACC-01 #6: balance enforced at COMMIT (deferred constraint triggers) ─────────

create or replace function billing.assert_journal_entry_balanced()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_entry_id uuid;
  v_lines    bigint;
  v_debit    numeric;
  v_credit   numeric;
begin
  if tg_table_name = 'journal_entries' then
    v_entry_id := new.id;
  elsif tg_op = 'DELETE' then
    v_entry_id := old.entry_id;
  else
    v_entry_id := new.entry_id;
  end if;

  -- The entry no longer exists (removed later in the same transaction): nothing left to balance.
  if not exists (select 1 from billing.journal_entries je where je.id = v_entry_id) then
    return null;
  end if;

  select count(*), coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_lines, v_debit, v_credit
    from billing.journal_lines jl where jl.entry_id = v_entry_id;

  if v_lines < 2 or v_debit <> v_credit then
    raise exception using errcode = '23514', constraint = 'chk_journal_entry_balanced', message = format(
      '0041 chk_journal_entry_balanced: journal entry %s has %s line(s), debit %s, credit %s '
      '(Allowed: at least 2 lines and sum(debit) = sum(credit))', v_entry_id, v_lines, v_debit, v_credit);
  end if;
  return null;
end $$;
comment on function billing.assert_journal_entry_balanced() is
  'WBS 4.20 T1/T2 (SCR-ACC-01 #6, ADR-0004 D1 3): at COMMIT an entry has >= 2 lines and '
  'sum(debit) = sum(credit), else 23514 chk_journal_entry_balanced. G2 stays as backstop. '
  'SECURITY DEFINER, pinned search_path.';
revoke execute on function billing.assert_journal_entry_balanced() from public;

drop trigger if exists trg_journal_entry_balanced on billing.journal_entries;
create constraint trigger trg_journal_entry_balanced
  after insert on billing.journal_entries
  deferrable initially deferred
  for each row execute function billing.assert_journal_entry_balanced();

drop trigger if exists trg_journal_lines_balanced on billing.journal_lines;
create constraint trigger trg_journal_lines_balanced
  after insert or update or delete on billing.journal_lines
  deferrable initially deferred
  for each row execute function billing.assert_journal_entry_balanced();

-- ── 5. SCR-ACC-01 #7 — REVOKE (0007:114-116 pattern) ─────────────────────────────────────────────

revoke update, delete, truncate on billing.journal_entries, billing.journal_lines from pgeos_app;

-- ── 6. T3 — SCR-ACC-01 #8 + OD-15: line account in the entry's entity, postable; manual ≠ revenue ─

create or replace function billing.assert_journal_line_account()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_entry_entity uuid;
  v_entry_type   text;
  v_acct_entity  uuid;
  v_postable     boolean;
  v_acct_type    text;
  v_rls_scoped   boolean;
begin
  select je.entity_id, je.entry_type into v_entry_entity, v_entry_type
    from billing.journal_entries je where je.id = new.entry_id;
  if not found then
    return new; -- journal_lines_entry_id_fkey refuses it (23503).
  end if;

  -- An RLS-scoped caller outside the entry's entity is refused by entry_scope (42501); this
  -- definer read must reveal nothing about that entry (0040 containment note).
  select not (r.rolsuper or r.rolbypassrls) into v_rls_scoped
    from pg_catalog.pg_roles r where r.rolname = session_user;
  if coalesce(v_rls_scoped, true) and not (v_entry_entity = any (platform.allowed_entities())) then
    return new;
  end if;

  select ga.entity_id, ga.is_postable, ga.account_type into v_acct_entity, v_postable, v_acct_type
    from billing.gl_accounts ga where ga.id = new.account_id;
  if not found then
    return new; -- journal_lines_account_id_fkey refuses it (23503).
  end if;

  if v_acct_entity <> v_entry_entity then
    raise exception using errcode = '23514', constraint = 'chk_journal_line_account_entity', message = format(
      '0041: account %s of journal line is not an account of the entry''s entity %s '
      '(Allowed: an account of the same entity)', new.account_id, v_entry_entity);
  end if;
  if not v_postable then
    raise exception using errcode = '23514', constraint = 'chk_journal_line_account_postable', message = format(
      '0041: account %s is not postable (Allowed: an account with is_postable = true)', new.account_id);
  end if;
  if v_entry_type = 'manual' and v_acct_type = 'revenue' then
    raise exception using errcode = '23514', constraint = 'chk_journal_line_manual_revenue', message = format(
      '0041: a manual journal may not post to revenue account %s (OD-15; Allowed: a non-revenue '
      'account)', new.account_id);
  end if;
  return new;
end $$;
comment on function billing.assert_journal_line_account() is
  'WBS 4.20 T3 (SCR-ACC-01 #8, OD-15): a journal line''s account belongs to the entry''s entity and '
  'is postable; a manual entry never touches a revenue account. 23514. SECURITY DEFINER, pinned '
  'search_path.';
revoke execute on function billing.assert_journal_line_account() from public;

drop trigger if exists trg_journal_line_account on billing.journal_lines;
create trigger trg_journal_line_account
  before insert or update on billing.journal_lines
  for each row execute function billing.assert_journal_line_account();

-- ── 7. T4 — posted entries immutable (ADR-0004 D1 4) ─────────────────────────────────────────────
-- The only in-place change ever allowed: reversed_by null -> value together with version + 1, every
-- other column unchanged (billing.mark_journal_reversed() makes it). DELETE of a posted entry and
-- TRUNCATE are refused.

create or replace function billing.guard_journal_entry_immutable()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if old.reversed_by is null
       and new.reversed_by is not null
       and new.version = old.version + 1
       and (to_jsonb(new) - 'reversed_by' - 'version') = (to_jsonb(old) - 'reversed_by' - 'version') then
      return new;
    end if;
    raise exception using errcode = '23514', constraint = 'chk_journal_entry_immutable', message = format(
      '0041: journal entry %s is immutable (Allowed: a reversal or adjustment entry; the only in-place '
      'change is reversed_by null -> value with version + 1)', old.id);
  end if;
  if old.posted_at is not null then
    raise exception using errcode = '23514', constraint = 'chk_journal_entry_immutable', message = format(
      '0041: posted journal entry %s cannot be deleted (Allowed: a reversal or adjustment entry)', old.id);
  end if;
  return old;
end $$;
comment on function billing.guard_journal_entry_immutable() is
  'WBS 4.20 T4 (SCR-ACC-01 #7, ADR-0004 D1 4): UPDATE only reversed_by null -> value with '
  'version + 1; DELETE refused once posted. 23514. SECURITY DEFINER, pinned search_path.';
revoke execute on function billing.guard_journal_entry_immutable() from public;

drop trigger if exists trg_journal_entry_immutable on billing.journal_entries;
create trigger trg_journal_entry_immutable
  before update or delete on billing.journal_entries
  for each row execute function billing.guard_journal_entry_immutable();

create or replace function billing.refuse_journal_truncate()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = '23514', constraint = 'chk_journal_entry_immutable', message = format(
    '0041: TRUNCATE on billing.%s is refused (posted journals are immutable)', tg_table_name);
end $$;
comment on function billing.refuse_journal_truncate() is
  'WBS 4.20 T4/T5: TRUNCATE on the journal tables is refused (23514). SECURITY DEFINER, pinned search_path.';
revoke execute on function billing.refuse_journal_truncate() from public;

drop trigger if exists trg_journal_entries_no_truncate on billing.journal_entries;
create trigger trg_journal_entries_no_truncate
  before truncate on billing.journal_entries
  for each statement execute function billing.refuse_journal_truncate();

drop trigger if exists trg_journal_lines_no_truncate on billing.journal_lines;
create trigger trg_journal_lines_no_truncate
  before truncate on billing.journal_lines
  for each statement execute function billing.refuse_journal_truncate();

-- ── 8. T5 — lines of a posted entry immutable ────────────────────────────────────────────────────
-- UPDATE/DELETE of a line of a posted entry is refused, and so is an INSERT of a line into an entry
-- posted by an EARLIER transaction (a balanced pair would otherwise pass the deferred T2 check —
-- PR #214 review). An entry is "created by the current transaction" iff its visible row version was
-- written by this transaction or one of its subtransactions AND reversed_by is still null:
--   * reversed_by null means the row was never updated (T4 allows only reversed_by null -> value), so
--     its xmin is the inserting xid; a reversed entry never takes new lines;
--   * xmin = the top-level xid, or xmin is newer than it (< 2^31 ahead, epoch-extended to xid8) and
--     pg_xact_status() says 'in progress' — a visible row whose writer is still in progress can only
--     be this transaction's own (another transaction's uncommitted row is not visible). This covers
--     rows written inside a SAVEPOINT (subtransaction xids are assigned after the top-level xid).
-- Nothing here reads a GUC or any session state the caller could set; xmin is a system column.

create or replace function billing.guard_journal_line_immutable()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  c_xid_span    constant bigint := 4294967296;   -- 2^32: one xid epoch
  c_xid_horizon constant bigint := 2147483648;   -- 2^31: xid comparison horizon
  c_first_normal_xid constant bigint := 3;       -- xids 0-2 are invalid/bootstrap/frozen
  v_posted_at   timestamptz;
  v_reversed_by uuid;
  v_entity_id   uuid;
  v_xmin        bigint;
  v_top         bigint;
  v_ahead       bigint;
  v_own         boolean := false;
  v_rls_scoped  boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from billing.journal_entries je where je.id = old.entry_id and je.posted_at is not null) then
      raise exception using errcode = '23514', constraint = 'chk_journal_entry_immutable', message = format(
        '0041: journal line %s belongs to a posted entry and is immutable (Allowed: a reversal or '
        'adjustment entry)', old.id);
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- INSERT
  select je.posted_at, je.reversed_by, je.entity_id, je.xmin::text::bigint
    into v_posted_at, v_reversed_by, v_entity_id, v_xmin
    from billing.journal_entries je where je.id = new.entry_id;
  if not found or v_posted_at is null then
    return new; -- missing parent: journal_lines_entry_id_fkey refuses it (23503); unposted: T2 at COMMIT.
  end if;

  -- An RLS-scoped caller outside the entry's entity is refused by entry_scope (42501); this definer
  -- read reveals nothing about that entry (0040 containment note).
  select not (r.rolsuper or r.rolbypassrls) into v_rls_scoped
    from pg_catalog.pg_roles r where r.rolname = session_user;
  if coalesce(v_rls_scoped, true) and not (v_entity_id = any (platform.allowed_entities())) then
    return new;
  end if;

  if v_reversed_by is null and v_xmin >= c_first_normal_xid then
    v_top := pg_catalog.pg_current_xact_id()::text::bigint;
    v_ahead := ((v_xmin - (v_top % c_xid_span)) % c_xid_span + c_xid_span) % c_xid_span;
    if v_ahead = 0 then
      v_own := true;
    elsif v_ahead < c_xid_horizon then
      v_own := pg_catalog.pg_xact_status((v_top + v_ahead)::text::xid8) = 'in progress';
    end if;
  end if;

  if not v_own then
    raise exception using errcode = '23514', constraint = 'chk_journal_entry_immutable', message = format(
      '0041: journal entry %s was posted by an earlier transaction and takes no new lines '
      '(Allowed: a reversal or adjustment entry)', new.entry_id);
  end if;
  return new;
end $$;
comment on function billing.guard_journal_line_immutable() is
  'WBS 4.20 T5 (SCR-ACC-01 #7, ADR-0004 D1 4): UPDATE/DELETE of a line of a posted entry refused; '
  'INSERT of a line into an entry posted by an earlier transaction refused (the entry row''s xmin is '
  'not this transaction or one of its subtransactions, or the entry is reversed). 23514 '
  'chk_journal_entry_immutable. SECURITY DEFINER, pinned search_path.';
revoke execute on function billing.guard_journal_line_immutable() from public;

drop trigger if exists trg_journal_line_immutable on billing.journal_lines;
create trigger trg_journal_line_immutable
  before insert or update or delete on billing.journal_lines
  for each row execute function billing.guard_journal_line_immutable();

-- ── 9. T6 — billing.mark_journal_reversed(): the one in-place write (reversed_by, version) ───────

create or replace function billing.mark_journal_reversed(
  p_entry_id uuid, p_reversing_id uuid, p_expected_version int)
returns int language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_entity      uuid;
  v_reversed_by uuid;
  v_version     int;
  v_rev_entity  uuid;
  v_rev_type    text;
  v_rev_posted  timestamptz;
  v_new_version int;
begin
  if not platform.is_internal() then
    raise exception using errcode = '42501', message =
      'billing.mark_journal_reversed: internal context required';
  end if;

  select je.entity_id, je.reversed_by, je.version into v_entity, v_reversed_by, v_version
    from billing.journal_entries je where je.id = p_entry_id for update;
  if not found or not (v_entity = any (platform.allowed_entities())) then
    raise exception using errcode = '23514', constraint = 'chk_journal_reversal_scope', message = format(
      '0041: journal entry %s cannot be reversed by the caller (Allowed: a posted entry of the '
      'caller''s entities)', p_entry_id);
  end if;

  if p_reversing_id = p_entry_id then
    raise exception using errcode = '23514', constraint = 'chk_journal_reversal_entry', message = format(
      '0041: journal entry %s cannot reverse itself', p_entry_id);
  end if;

  select je.entity_id, je.entry_type, je.posted_at into v_rev_entity, v_rev_type, v_rev_posted
    from billing.journal_entries je where je.id = p_reversing_id;
  if not found or v_rev_type <> 'reversing' or v_rev_posted is null or v_rev_entity <> v_entity then
    raise exception using errcode = '23514', constraint = 'chk_journal_reversal_entry', message = format(
      '0041: entry %s is not a posted reversing entry of the same entity as %s '
      '(Allowed: entry_type ''reversing'', posted, same entity)', p_reversing_id, p_entry_id);
  end if;

  if exists (
       select jl.account_id, jl.debit, jl.credit from billing.journal_lines jl where jl.entry_id = p_entry_id
       except all
       select rl.account_id, rl.credit, rl.debit from billing.journal_lines rl where rl.entry_id = p_reversing_id)
     or exists (
       select rl.account_id, rl.credit, rl.debit from billing.journal_lines rl where rl.entry_id = p_reversing_id
       except all
       select jl.account_id, jl.debit, jl.credit from billing.journal_lines jl where jl.entry_id = p_entry_id) then
    raise exception using errcode = '23514', constraint = 'chk_journal_reversal_mirror', message = format(
      '0041: the lines of entry %s do not mirror the lines of entry %s '
      '(Allowed: the same accounts and amounts with debit and credit swapped)', p_reversing_id, p_entry_id);
  end if;

  if v_reversed_by is not null then
    raise exception using errcode = '23514', constraint = 'chk_journal_reversal_once', message = format(
      '0041: journal entry %s is already reversed (Allowed: one reversal per entry)', p_entry_id);
  end if;

  if v_version <> p_expected_version then
    raise exception using errcode = '23514', constraint = 'chk_journal_reversal_version', message = format(
      '0041: journal entry %s is at version %s, not %s (optimistic lock)', p_entry_id, v_version, p_expected_version);
  end if;

  update billing.journal_entries
     set reversed_by = p_reversing_id, version = version + 1
   where id = p_entry_id
  returning version into v_new_version;
  return v_new_version;
end $$;
comment on function billing.mark_journal_reversed(uuid, uuid, int) is
  'WBS 4.20 T6 (ADR-0004 D1 4): sets reversed_by and version + 1 on an original entry of the '
  'caller''s entities, once, at the expected version, when the reversing entry is a posted '
  '''reversing'' entry of the same entity whose lines mirror the original''s. Every refusal 23514. '
  'SECURITY DEFINER, pinned search_path; the only UPDATE path on billing.journal_entries.';
revoke all on function billing.mark_journal_reversed(uuid, uuid, int) from public;
grant execute on function billing.mark_journal_reversed(uuid, uuid, int) to pgeos_app;

-- ── 10. T7 — 0040's period check skips the reversal mark (reversed_by + version only) ───────────
-- Reversing an entry of a since-closed period must succeed; the reversing entry itself is checked
-- on its own insert.

create or replace function billing.assert_journal_entry_period()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'reversed_by' - 'version') = (to_jsonb(old) - 'reversed_by' - 'version') then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform billing.assert_posting_period(old.entity_id, old.entry_date, old.period_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform billing.assert_posting_period(new.entity_id, new.entry_date, new.period_id);
  end if;
  return null;
end $$;
comment on function billing.assert_journal_entry_period() is
  'WBS 4.19 D5 + WBS 4.20 T7: billing.journal_entries — INSERT checks new, UPDATE old and new, DELETE '
  'old, through billing.assert_posting_period(); an UPDATE changing only reversed_by and version '
  '(billing.mark_journal_reversed()) is not a posting and is skipped. SECURITY DEFINER, pinned search_path.';
revoke execute on function billing.assert_journal_entry_period() from public;

-- ── 11. pg_proc self-check (0040 §8) ─────────────────────────────────────────────────────────────

do $$ begin
  if exists (
    select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid in ('billing.assert_journal_entry_balanced()'::regprocedure,
                     'billing.assert_journal_line_account()'::regprocedure,
                     'billing.guard_journal_entry_immutable()'::regprocedure,
                     'billing.refuse_journal_truncate()'::regprocedure,
                     'billing.guard_journal_line_immutable()'::regprocedure,
                     'billing.mark_journal_reversed(uuid, uuid, int)'::regprocedure,
                     'billing.assert_journal_entry_period()'::regprocedure)
       and (not p.prosecdef
            or not (r.rolsuper or r.rolbypassrls)
            or not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false))
  ) then
    raise exception '0041: the 4.20 journal functions must be SECURITY DEFINER, owned by a superuser '
      'or BYPASSRLS role, with search_path pinned to pg_catalog, pg_temp';
  end if;
end $$;

-- ── 12. Column classification (G6) ───────────────────────────────────────────────────────────────

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('billing', 'journal_entries', 'entry_type',  'public'),
 ('billing', 'journal_entries', 'approved_by', 'public'),
 ('billing', 'journal_entries', 'approved_at', 'public'),
 ('billing', 'journal_entries', 'version',     'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
