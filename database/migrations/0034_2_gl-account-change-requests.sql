-- 0034_2_gl-account-change-requests.sql — Lane 2 — WBS 4.1a part 2. Forward-only, idempotent
-- (apply.sh re-runs every file on every apply).
--
-- D-190 hybrid ruling (SCR-ACC-01 row 9 / DECISION_LOG's D-190 appendix, 4.1a part 1's own commit):
-- billing.gl_account_change_requests is the maker/checker write path for billing.gl_accounts —
-- pattern of hr.manpower_requests (13-Schema-Additions.sql:180-199). change_kind IN
-- ('create','update') only this part — deactivate/reactivate deferred to 4.1a part 3 (needs its own
-- gl_accounts.is_active column, G-01, SCR-ACC-01). doc_no via platform.next_doc_no (new GLC counter,
-- seeded per entity below).
--
-- Shared pure-rule validation (Master ruling — ONE function, not a copy): billing.is_valid_gl_
-- account_code/is_valid_gl_account_type, immutable, called from BOTH gl_accounts' CHECKs (0028's two
-- CHECKs refactored below) and this table's proposed_code/proposed_account_type CHECKs.
--
-- Parent-in-same-entity is a composite FK, not a function/trigger (Master ruling, precedent 0026):
--   1. unique (id, entity_id) added to billing.gl_accounts (idempotent guard).
--   2. gl_account_change_requests(proposed_parent_id, entity_id) -> gl_accounts(id, entity_id).
--   3. gl_account_change_requests(target_account_id, entity_id) -> gl_accounts(id, entity_id) —
--      round-1 findings 5/6/7/13/14: the UPDATE target must also structurally belong to the
--      request's own entity, same composite-FK discipline as proposed_parent_id.
--   4. Retrofit gl_accounts(parent_id, entity_id) -> gl_accounts(id, entity_id) — closes a
--      pre-existing gap; safe, nothing seeded in gl_accounts (D3, D-127).
-- Three composite FKs (glc target-entity, glc parent-entity, gl_accounts parent-entity retrofit)
-- PLUS one plain unique key (gl_accounts_id_entity_id_key, not a fourth FK — it is the pair the
-- three FKs above reference) — round-2 finding 5(b) correction; the previous draft's comment
-- miscounted this as "four composite FKs". All FKs use Postgres's default MATCH SIMPLE, so a NULL
-- target_account_id (change_kind='create') or NULL proposed_parent_id (no parent proposed) trivially
-- satisfies its FK.
--
-- Table CHECKs mirror modules/billing/domain/gl-account-change-requests/invariants.ts EXACTLY (the
-- property test proves domain <-> DB agreement on every generated tuple) — names below match that
-- file's own doc-comments verbatim: chk_glc_requests_change_kind_target, chk_glc_requests_
-- approver_ne_requester, chk_glc_requests_rejection_reason, chk_glc_requests_create_complete,
-- chk_glc_requests_decision_complete. Round-1 findings 5/6/7/13/14 already folded into this shape
-- (created_at column, unique(entity_id, doc_no)). chk_glc_requests_decision_complete itself is
-- keyed on approved_by only — NOT decided_at/approved_at (decided_at stays DB-only by design, see
-- Part 11 below). The domain's isDecisionComplete (slice-close round 1 finding 4) now ALSO requires
-- approved_at non-null when approved — that fuller rule is enforced by this CHECK together with
-- glc_approver_update's own WITH CHECK (Part 5 below, which already requires approved_at when
-- approved), not by this CHECK alone; the two layers agree only in combination, not line-for-line.
--
-- Approver mechanism (SCR-PLAT-APPR-01, D-190, round-1 finding 2's resolution — the FIRST consumer of
-- a generic primitive the Master records separately in .claude/briefs/platform.brief.md for 4.19/
-- 4.20/4.22/5.11b to reuse):
--   platform.is_approval_chain_approver(p_request_type text, p_step int default 1) — stable,
--   SECURITY DEFINER, pinned search_path (0009's exact style) — a narrow, READ-ONLY definition
--   lookup against platform.approval_chains/identity.roles/identity.user_roles, same class of
--   exception as platform.allowed_entities()/platform.next_doc_no (SECURITY DEFINER banned for a
--   bypass, accepted here for a read-only role-membership check).
--
-- RLS layering on gl_account_change_requests: ONE RESTRICTIVE `glc_entity_scope` policy — named
-- glc_entity_scope, NOT the bare literal `entity_scope` — migration 0007's own self-healing loop
-- (0007_M_pgeos-app-role-entity-scope.sql:190-199) walks EVERY policy literally named `entity_scope`
-- across all 14 schemas on every apply and raises an exception if it finds one that isn't PERMISSIVE
-- FOR ALL; a bare-named RESTRICTIVE policy here would collide with that loop. Same fix as platform.
-- idempotency_keys' idem_entity_scope, 0010 — a module/table-specific prefix, not the bare name 0007
-- hunts for. The P5 catalog-driven isolation matrix's NAMED_ENTITY_SCOPE_EXCEPTIONS map (pg-tester's
-- job, not this file's) lists this table alongside platform.idempotency_keys. This RESTRICTIVE policy
-- ANDs against the OR of five PERMISSIVE
-- policies — maker INSERT, maker UPDATE (own row, locked to draft/pending_approval/cancelled, decision
-- columns forced null), maker SELECT (own row — a one-line default beyond the brief's explicit text,
-- see closing report), approver SELECT (any pending row, any requester), approver UPDATE (pending ->
-- approved|rejected only, decision columns set in the same statement, approver != requester both in
-- the policy's own WITH CHECK and the table CHECK). Precedent for RESTRICTIVE+PERMISSIVE layering:
-- platform.idempotency_keys' idem_entity_scope (0010) — Postgres ANDs every RESTRICTIVE policy
-- together, then ANDs that against the OR of every PERMISSIVE policy for the same command.
--
-- Round-2 finding 3 (cross-policy self-approval hole): Postgres ORs every PERMISSIVE policy's USING
-- and WITH CHECK independently PER COMMAND, not per-policy-pair — a session holding both
-- billing.gl_accounts.manage and the approver role could otherwise satisfy the maker policy's USING
-- (own draft row) together with the approver policy's WITH CHECK (after rewriting requested_by) in
-- ONE UPDATE. RLS cannot compare OLD vs NEW across policies, so a SECOND trigger — separate from the
-- gl_accounts-side trigger below — locks the row's immutable fields once submitted (Part 5A below).
--
-- gl_accounts write path: a NEW permissive policy OR-ed with the existing reference_write (13B:3121,
-- unchanged) — is_internal() and entity boundary and (has_perm('platform.reference.manage') [no
-- holder, 4.1a part 1] or is_approval_chain_approver('gl_account_change')) — round-2 finding 4 adds
-- the entity boundary predicate that round 1's draft omitted — PLUS the trigger billing.assert_gl_
-- account_change_approved() (before insert or update, per row; a PLAIN trigger, not a true Postgres
-- CONSTRAINT TRIGGER — round-2 finding 5(c) correction, same style as identity.check_sod()) binding
-- every gl_accounts write made BY THE APP ROLE to an approved gl_account_change_requests row decided
-- by the SAME user, matching every proposed column against what was actually written (round-2
-- finding 1) and consumed by construction so it cannot be replayed (round-2 finding 2). Bypass
-- (Condition 1, exact wording): keyed on `current_user <> 'pgeos_app'`, never on the app.user_id GUC
-- being empty — apply.sh/seed/import stays outside it. Round-2 finding 5(a) correction: a `pgeos_app`
-- session with an empty/missing app.user_id GUC is rejected by THIS TRIGGER (a BEFORE ROW trigger
-- fires before the RLS WITH CHECK is evaluated on INSERT, so the trigger's own NOT EXISTS check — no
-- request row can ever be decided by a null/empty user — is what rejects it here, not RLS "before or
-- regardless of" the trigger as the previous draft's comment incorrectly claimed).
--
-- Catalog events (billing.gl_account_change.{requested,approved,rejected}) are NOT added here — the
-- Master adds them to the frozen packages/events/catalog.ts before merge (brief, "gl_accounts write").
--
-- Pre-migration pg-reviewer review, full history: round 1 FAIL(17) -> Master/evaluation-session
-- ruling (SCR-PLAT-APPR-01) -> round 2 FAIL(13) -> D-117 last round (round 3) FAIL(8, incl. the
-- NULL-clearing gap, the replay guard not enforced by RLS itself, and the maker draft-rewind
-- loophole, all fixed here) -> confirmation pass FAIL(2, mechanical: a combined test split into two
-- column-isolated tests, a brief-wording correction) -> confirmation pass PASS(0). Also fixed via
-- live testing (not review): a statement-ordering bug (this file's own function-before-use fix,
-- section 3A) and the glc_entity_scope naming collision with migration 0007 (above). Renumbered
-- 0032 -> 0034 (0032/0033 claimed by other lanes) after the D-117 round closed. Total: 40 findings
-- across 4 review rounds.

begin;

-- ── 1. Shared pure-rule validation functions (Master ruling: ONE function, called from BOTH tables) ─

create or replace function billing.is_valid_gl_account_code(p_code text)
returns boolean language sql immutable as $$
  select p_code ~ '^[1-9]-[0-9]{2}-[0-9]{3}-[0-9]{3}$'
$$;

create or replace function billing.is_valid_gl_account_type(p_account_type text)
returns boolean language sql immutable as $$
  select p_account_type in (
    'asset', 'liability', 'equity', 'revenue', 'expense',
    'cost_of_revenue', 'other_income_expense', 'tax', 'control_memorandum'
  )
$$;

-- ── 2. Refactor 0028's two inline CHECKs on gl_accounts to call the shared functions ────────────────

alter table billing.gl_accounts drop constraint if exists chk_gl_accounts_code_format;
alter table billing.gl_accounts add constraint chk_gl_accounts_code_format
  check (billing.is_valid_gl_account_code(code));

alter table billing.gl_accounts drop constraint if exists chk_gl_accounts_account_type;
alter table billing.gl_accounts add constraint chk_gl_accounts_account_type
  check (billing.is_valid_gl_account_type(account_type));

-- ── 3. Composite-FK scaffolding on gl_accounts (Master ruling — declarative, precedent 0026) ────────

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gl_accounts_id_entity_id_key' and conrelid = 'billing.gl_accounts'::regclass
  ) then
    alter table billing.gl_accounts add constraint gl_accounts_id_entity_id_key unique (id, entity_id);
  end if;
end $$;

-- Retrofit: parent_id must belong to the same entity as the child (pre-existing gap, closed here —
-- safe, nothing seeded in gl_accounts, D3/D-127).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gl_accounts_parent_entity_fk' and conrelid = 'billing.gl_accounts'::regclass
  ) then
    alter table billing.gl_accounts add constraint gl_accounts_parent_entity_fk
      foreign key (parent_id, entity_id) references billing.gl_accounts (id, entity_id);
  end if;
end $$;

-- ── 3A. platform.is_approval_chain_approver (moved before its first use in section 5 RLS policies below — round-3 confirmation-pass ordering fix, no logic change) — SCR-PLAT-APPR-01, the shared approval-chain primitive ──
-- (Master's note: this becomes the shared primitive; 4.19/4.20/4.22/5.11b reuse it once the Master
-- records it in .claude/briefs/platform.brief.md — not built here beyond this function itself.)

create or replace function platform.is_approval_chain_approver(p_request_type text, p_step int default 1)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1
    from platform.approval_chains ac
    join identity.roles r on r.code = ac.approver_role
    join identity.user_roles ur on ur.role_id = r.id
    where ur.user_id = platform.current_user_id()
      and ur.revoked_at is null
      and ac.request_type = p_request_type
      and ac.step_no = p_step
      and ac.is_active
  )
$$;
comment on function platform.is_approval_chain_approver is
  'SCR-PLAT-APPR-01 (D-190): true iff the calling session holds the identity.roles code that '
  'platform.approval_chains names as approver_role for (request_type, step_no). SECURITY DEFINER, '
  'pinned search_path (0009 style) — a narrow, read-only role-membership lookup, same class of '
  'exception as platform.allowed_entities()/platform.next_doc_no. First consumer: gl_account_change '
  '(this migration). Reused by 4.19/4.20/4.22/5.11b per the Master.';

revoke execute on function platform.is_approval_chain_approver(text, int) from public;
grant  execute on function platform.is_approval_chain_approver(text, int) to pgeos_app;

do $$ begin
  if exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
              where p.oid = 'platform.is_approval_chain_approver(text,int)'::regprocedure
                and not (r.rolsuper or r.rolbypassrls)) then
    raise exception '0034: is_approval_chain_approver owner must be superuser or BYPASSRLS (ADR-0002)';
  end if;
end $$;


-- ── 4. billing.gl_account_change_requests ────────────────────────────────────────────────────────

create table if not exists billing.gl_account_change_requests (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references platform.entities(id),
  doc_no                text not null,
  change_kind           text not null,     -- create · update (deactivate/reactivate: 4.1a part 3, G-01)
  target_account_id     uuid,              -- null for create, required for update — composite FK below
  proposed_code         text,
  proposed_name_ar      text,
  proposed_name_en      text,
  proposed_account_type text,
  proposed_parent_id    uuid,
  proposed_is_postable  boolean,
  status                text not null default 'draft',
  -- draft · pending_approval · approved · rejected · cancelled (XState machine in domain/ is the
  -- single source of truth for legal transitions — this CHECK is the backstop, per CLAUDE.md)
  requested_by          uuid not null,
  approved_by           uuid,
  submitted_at          timestamptz,
  approved_at           timestamptz,
  decided_at            timestamptz,     -- must be set via now() in the SAME statement/transaction as
                                          -- the decision, NEVER a caller-supplied clock value — the
                                          -- replay guard in billing.assert_gl_account_change_approved()
                                          -- (Part 11 below) relies on decided_at = now() to prove "this
                                          -- request was decided in THIS transaction" (round-2 finding 2).
  rejection_reason      text,
  version               int not null default 1,
  created_at            timestamptz not null default now(),

  constraint gl_account_change_requests_entity_doc_no_key unique (entity_id, doc_no),

  constraint chk_glc_requests_change_kind check (change_kind in ('create', 'update')),
  constraint chk_glc_requests_status check (
    status in ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled')
  ),

  -- mirrors modules/billing/domain/gl-account-change-requests/invariants.ts::isValidChangeKindTargetPairing
  constraint chk_glc_requests_change_kind_target check (
    (change_kind = 'create' and target_account_id is null)
    or (change_kind = 'update' and target_account_id is not null)
  ),

  -- mirrors invariants.ts::isApproverDistinctFromRequester — defense-in-depth alongside the
  -- pre-existing identity.sod_rules (CFO,ACCOUNTANT) row (13B:632).
  constraint chk_glc_requests_approver_ne_requester check (
    approved_by is null or approved_by <> requested_by
  ),

  -- mirrors invariants.ts::isRejectionReasonPresentWhenRejected
  constraint chk_glc_requests_rejection_reason check (
    status <> 'rejected' or rejection_reason is not null
  ),

  -- mirrors invariants.ts::isCreateRequestComplete (unconditional on status — gl_accounts declares
  -- code/name_ar/account_type NOT NULL, so an incomplete create request must never be insertable)
  constraint chk_glc_requests_create_complete check (
    change_kind <> 'create'
    or (proposed_code is not null and proposed_name_ar is not null and proposed_account_type is not null)
  ),

  -- partially mirrors invariants.ts::isDecisionComplete (approved_by half only — the fuller rule,
  -- also requiring approved_at when approved, is completed by glc_approver_update's own WITH CHECK
  -- below, not by this CHECK alone; slice-close round 1 finding 4 / round 2 finding 1 correction)
  constraint chk_glc_requests_decision_complete check (
    status <> 'approved' or approved_by is not null
  ),

  -- shared pure-rule functions (Master ruling) — only enforced when the proposed column is non-null.
  constraint chk_glc_requests_proposed_code_format check (
    proposed_code is null or billing.is_valid_gl_account_code(proposed_code)
  ),
  constraint chk_glc_requests_proposed_account_type check (
    proposed_account_type is null or billing.is_valid_gl_account_type(proposed_account_type)
  ),

  -- Round-3 fix 4 (last-round FAIL(8) item 4): billing.assert_gl_account_change_approved()'s UPDATE
  -- branch REQUIRES new.code = old.code (code is immutable post-creation) and never reads
  -- proposed_code at all on update — so an update request carrying a non-null proposed_code would
  -- either never be approvable-and-applied against a matching gl_accounts write (silently useless) or,
  -- worse, be silently ignored at Approve time while looking meaningful on the request row. Rejected
  -- up front, at INSERT/UPDATE of the request row itself, mirroring chk_glc_requests_create_complete's
  -- own change_kind-gated style.
  constraint chk_glc_requests_update_no_code check (
    change_kind = 'create' or proposed_code is null
  ),

  -- composite FKs (Master ruling — declarative, not a function/trigger): structurally impossible to
  -- target/propose-parent an account in a different entity than the request's own.
  constraint gl_account_change_requests_target_entity_fk
    foreign key (target_account_id, entity_id) references billing.gl_accounts (id, entity_id),
  constraint gl_account_change_requests_parent_entity_fk
    foreign key (proposed_parent_id, entity_id) references billing.gl_accounts (id, entity_id)
);

comment on table billing.gl_account_change_requests is
  'WBS 4.1a part 2, D-190: maker/checker write path for billing.gl_accounts. The gl_accounts row is '
  'written ONLY inside Approve (application layer), same transaction, same audit_log row. change_kind '
  'is create/update only this part — deactivate/reactivate is WBS 4.1a part 3 (G-01, needs gl_accounts.'
  'is_active).';

-- Partial unique indexes: at most one pending_approval request per target_account_id / per
-- (entity_id, proposed_code) create.
create unique index if not exists uq_glc_requests_pending_target
  on billing.gl_account_change_requests (target_account_id)
  where status = 'pending_approval' and target_account_id is not null;

create unique index if not exists uq_glc_requests_pending_create_code
  on billing.gl_account_change_requests (entity_id, proposed_code)
  where status = 'pending_approval' and change_kind = 'create';

-- ── 5. RLS on gl_account_change_requests ─────────────────────────────────────────────────────────

alter table billing.gl_account_change_requests enable row level security;

-- RESTRICTIVE entity boundary — ANDs against every PERMISSIVE policy below. Named glc_entity_scope,
-- NOT the bare literal `entity_scope`, to avoid colliding with migration 0007's self-healing loop
-- (0007_M_pgeos-app-role-entity-scope.sql:190-199), which raises an exception on any policy literally
-- named `entity_scope` that isn't PERMISSIVE FOR ALL — same precedent as platform.idempotency_keys'
-- idem_entity_scope (0010). The P5 isolation matrix lists this table in its
-- NAMED_ENTITY_SCOPE_EXCEPTIONS map (pg-tester's job) instead of matching it by the literal name.
drop policy if exists glc_entity_scope on billing.gl_account_change_requests;
create policy glc_entity_scope on billing.gl_account_change_requests as restrictive for all
  using (entity_id = any (platform.allowed_entities()))
  with check (entity_id = any (platform.allowed_entities()));

-- Maker (ACCOUNTANT, billing.gl_accounts.manage) — own row, INSERT.
drop policy if exists glc_maker_insert on billing.gl_account_change_requests;
create policy glc_maker_insert on billing.gl_account_change_requests for insert
  with check (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.has_perm('billing.gl_accounts.manage')
    and requested_by = platform.current_user_id()
    and status in ('draft', 'pending_approval')
    and approved_by is null and approved_at is null and decided_at is null
    and rejection_reason is null
  );

-- Maker — own row, UPDATE (submit / cancel; never approve/reject; decision columns stay null).
drop policy if exists glc_maker_update on billing.gl_account_change_requests;
create policy glc_maker_update on billing.gl_account_change_requests for update
  using (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.has_perm('billing.gl_accounts.manage')
    and requested_by = platform.current_user_id()
    and status in ('draft', 'pending_approval')
  )
  with check (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.has_perm('billing.gl_accounts.manage')
    and requested_by = platform.current_user_id()
    and status in ('draft', 'pending_approval', 'cancelled')
    and approved_by is null and approved_at is null and decided_at is null
    and rejection_reason is null
  );

-- Maker — own row, SELECT (one-line default beyond the brief's explicit text — flagged in the
-- closing report; safe, own-row only, does not affect any RED test's expected row count). Reviewer
-- round 2 confirmed this policy stays as-is (required, not scope creep) — no change this round.
drop policy if exists glc_maker_select on billing.gl_account_change_requests;
create policy glc_maker_select on billing.gl_account_change_requests for select
  using (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.has_perm('billing.gl_accounts.manage')
    and requested_by = platform.current_user_id()
  );

-- Approver (whoever platform.approval_chains names for 'gl_account_change', read as data) — SELECT
-- any in-entity pending (or any-status) row regardless of who made it.
drop policy if exists glc_approver_select on billing.gl_account_change_requests;
create policy glc_approver_select on billing.gl_account_change_requests for select
  using (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.is_approval_chain_approver('gl_account_change')
  );

-- Approver — UPDATE a pending row to approved|rejected only; decision columns set in the SAME
-- statement; approver != requester enforced again here (defense-in-depth alongside the table CHECK).
-- Round-3 fix 2 (last-round FAIL(8) item 2): `decided_at is not null` alone let an approver set
-- decided_at to an arbitrary future value via a raw UPDATE — if some later transaction's now() ever
-- coincidentally matched it, the gl_accounts-side replay guard (Part 11, decided_at = now()) would be
-- bypassed. Adding `decided_at = now()` HERE, in the policy's own WITH CHECK, forces the DB to accept
-- only a decided_at equal to THIS transaction's own start timestamp — a real Approve/Reject sets
-- decided_at via now() in the same UPDATE statement, so it satisfies this naturally.
drop policy if exists glc_approver_update on billing.gl_account_change_requests;
create policy glc_approver_update on billing.gl_account_change_requests for update
  using (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.is_approval_chain_approver('gl_account_change')
    and status = 'pending_approval'
  )
  with check (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and platform.is_approval_chain_approver('gl_account_change')
    and status in ('approved', 'rejected')
    and approved_by = platform.current_user_id()
    and approved_by <> requested_by
    and decided_at is not null
    and decided_at = now()
    and (status <> 'approved' or approved_at is not null)
    and (status <> 'rejected' or rejection_reason is not null)
  );

grant select, insert, update on billing.gl_account_change_requests to pgeos_app;

-- Round-2 finding 11: alter default privileges (0007) grants DELETE by default to every new table's
-- owner-role grant; the explicit grant above is select/insert/update only and RLS already blocks a
-- pgeos_app DELETE (no delete policy exists), but the effective GRANT should say so explicitly too —
-- make the actual privilege match the stated intent.
revoke delete on billing.gl_account_change_requests from pgeos_app;

-- ── 5A. billing.assert_gl_account_change_immutable_fields() — round-2 finding 3 ─────────────────────
-- A SEPARATE trigger from Part 11's gl_accounts-side trigger, on THIS table (gl_account_change_
-- requests) itself. Closes the cross-policy self-approval hole: Postgres ORs every PERMISSIVE
-- policy's USING/WITH CHECK independently per command, not per-policy-pair, so a session holding
-- BOTH billing.gl_accounts.manage and the approver role could otherwise satisfy glc_maker_update's
-- USING (own draft row) together with glc_approver_update's WITH CHECK (after rewriting
-- requested_by) in one UPDATE — RLS cannot compare OLD vs NEW across two different policies. This
-- plain trigger (not a true Postgres CONSTRAINT TRIGGER — see round-2 finding 5(c)) can, and does.

create or replace function billing.assert_gl_account_change_immutable_fields()
returns trigger language plpgsql as $$
begin
  if current_user <> 'pgeos_app' then
    return new;
  end if;

  -- Immutable for the row's whole life, any status.
  if new.id is distinct from old.id
    or new.entity_id is distinct from old.entity_id
    or new.doc_no is distinct from old.doc_no
    or new.requested_by is distinct from old.requested_by
  then
    raise exception using errcode = '42501', message =
      '0034: id, entity_id, doc_no and requested_by are immutable on billing.gl_account_change_requests';
  end if;

  -- Round-3 fix 3 (last-round FAIL(8) item 3): the maker UPDATE policy's WITH CHECK allows
  -- pending_approval -> draft (part of its `status in ('draft','pending_approval','cancelled')`
  -- clause) — without this guard a maker could do pending -> draft, rewrite proposed_*, then
  -- draft -> pending again, defeating the CFO's review of the original content, since the immutable-
  -- fields check below only locks proposed_*/change_kind/target_account_id once `old.status <>
  -- 'draft'`. Confirmed against modules/billing/domain/gl-account-change-requests/machine.ts: the
  -- pure state chart's only edge out of 'pending_approval' toward a non-terminal state is CANCEL (to
  -- 'cancelled', itself type:'final') — pending_approval -> draft is not a machine transition at all,
  -- so rejecting it here does not contradict the domain machine (CLAUDE.md: the machine is the single
  -- source of truth for legal transitions; this trigger is its DB-level backstop, same as the status
  -- CHECK).
  if old.status = 'pending_approval' and new.status = 'draft' then
    raise exception using errcode = '42501', message =
      '0034: pending_approval -> draft is not a legal transition on billing.gl_account_change_requests '
      '(not a state the domain machine allows; the maker may CANCEL a pending request, never rewind it '
      'to draft — cancel and submit a fresh request instead)';
  end if;

  -- Round-3 fix 3, second half: the machine's only edge out of 'draft' is SUBMIT (to
  -- 'pending_approval'); 'draft' has no CANCEL edge at all (CANCEL is only legal from
  -- 'pending_approval' per machine.ts), so draft -> cancelled is likewise not a machine transition.
  if old.status = 'draft' and new.status = 'cancelled' then
    raise exception using errcode = '42501', message =
      '0034: draft -> cancelled is not a legal transition on billing.gl_account_change_requests (not a '
      'state the domain machine allows; only a pending_approval request may be cancelled — a draft row '
      'may only move to pending_approval via SUBMIT, or be left as draft)';
  end if;

  -- Once the maker has submitted (left draft), the proposal itself is locked — prevents the maker
  -- rewriting it mid-review (the TOCTOU behind round-2 finding 3) and closes the self-approval hole
  -- described above.
  if old.status <> 'draft' then
    if new.change_kind is distinct from old.change_kind
      or new.target_account_id is distinct from old.target_account_id
      or new.proposed_code is distinct from old.proposed_code
      or new.proposed_name_ar is distinct from old.proposed_name_ar
      or new.proposed_name_en is distinct from old.proposed_name_en
      or new.proposed_account_type is distinct from old.proposed_account_type
      or new.proposed_parent_id is distinct from old.proposed_parent_id
      or new.proposed_is_postable is distinct from old.proposed_is_postable
      or new.created_at is distinct from old.created_at
      or new.submitted_at is distinct from old.submitted_at
    then
      raise exception using errcode = '42501', message =
        '0034: the proposal (change_kind/target_account_id/proposed_*/created_at/submitted_at) on '
        'billing.gl_account_change_requests may only be edited while status=''draft''; this row is '
        'already submitted — cancel it and start a fresh draft to change the proposal';
    end if;
  end if;

  return new;
end $$;
comment on function billing.assert_gl_account_change_immutable_fields is
  'Round-2 finding 3: a plain BEFORE UPDATE trigger (not a Postgres CONSTRAINT TRIGGER) on '
  'gl_account_change_requests itself, separate from billing.assert_gl_account_change_approved() on '
  'gl_accounts. RLS cannot compare OLD vs NEW across two different PERMISSIVE policies (Postgres ORs '
  'them independently per command), so this trigger closes the hole where a session holding both '
  'billing.gl_accounts.manage and the approver role could rewrite requested_by/the proposal in one '
  'UPDATE that separately satisfies each policy''s own USING/WITH CHECK. Bypass keyed on current_user '
  '<> ''pgeos_app'' (Condition 1, same as the gl_accounts-side trigger).';

drop trigger if exists trg_assert_gl_account_change_immutable_fields on billing.gl_account_change_requests;
create trigger trg_assert_gl_account_change_immutable_fields
  before update on billing.gl_account_change_requests
  for each row execute function billing.assert_gl_account_change_immutable_fields();

-- ── 6. platform.counters GLC seed (one per entity — platform.next_doc_no's own doc_type row) ────────

insert into platform.counters (entity_id, doc_type, period, prefix, padding)
select id, 'GLC', 'ALL', code || '-GLC-', 5
from platform.entities
on conflict (entity_id, doc_type, period) do nothing;

-- ── 7. New permission + role grant (D-190: ACCOUNTANT only, the maker) ──────────────────────────────

insert into identity.permissions (code, module, object, action, description) values
 ('billing.gl_accounts.manage', 'billing', 'gl_accounts', 'manage',
  'تقديم طلب تعديل/إنشاء حساب في دليل الحسابات (المُعِدّ) — المسار الوحيد لتعديل billing.gl_accounts')
on conflict (code) do nothing;

insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
from identity.roles r
cross join identity.permissions p
where p.code = 'billing.gl_accounts.manage'
  and r.code = 'ACCOUNTANT'
on conflict do nothing;

-- ── 8. platform.approval_chains row (read as DATA — never hard-code 'CFO' in code) ──────────────────

insert into platform.approval_chains (request_type, step_no, approver_role, is_active)
values ('gl_account_change', 1, 'CFO', true)
on conflict (request_type, step_no) do nothing;

-- ── 10. gl_accounts approver write policy — OR-ed with the existing reference_write (13B:3121) ──────
-- (Postgres ORs every PERMISSIVE policy for a given command together; reference_write is untouched.)
-- Round-2 finding 4: both policies below were missing the entity-boundary predicate — added here.

drop policy if exists gl_account_change_write_insert on billing.gl_accounts;
create policy gl_account_change_write_insert on billing.gl_accounts for insert
  with check (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and (platform.has_perm('platform.reference.manage') or platform.is_approval_chain_approver('gl_account_change'))
  );

drop policy if exists gl_account_change_write_update on billing.gl_accounts;
create policy gl_account_change_write_update on billing.gl_accounts for update
  using (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and (platform.has_perm('platform.reference.manage') or platform.is_approval_chain_approver('gl_account_change'))
  )
  with check (
    platform.is_internal()
    and entity_id = any (platform.allowed_entities())
    and (platform.has_perm('platform.reference.manage') or platform.is_approval_chain_approver('gl_account_change'))
  );

-- ── 11. billing.assert_gl_account_change_approved() — the real DB-enforced four-eyes backstop ───────
-- (RLS alone cannot correlate two tables' write history — Condition 1, exact wording: bypass keyed on
-- current_user, never on the app.user_id GUC being empty. Style precedent: identity.check_sod(),
-- 13B:639-655. This is a PLAIN before-row trigger, not a true Postgres CONSTRAINT TRIGGER — round-2
-- finding 5(c); Postgres CONSTRAINT TRIGGERs can only fire AFTER, and this must fire BEFORE the row
-- is written, same style as identity.check_sod().)
--
-- Master's confirmation-pass note: NO SECURITY DEFINER function may write billing.gl_accounts —
-- doing so would bypass four-eyes (current_user would become the function's OWNER, e.g. postgres,
-- satisfying this trigger's `current_user <> 'pgeos_app'` bypass unintentionally, letting an insert/
-- update through with no approved gl_account_change_requests row behind it at all). None exists today
-- (platform.is_approval_chain_approver, the only SECURITY DEFINER function this migration adds, is a
-- read-only lookup — it never writes gl_accounts). A cheap pg_proc/prosrc sanity guard for this was
-- considered (Master's note) and deferred, not added, here: doc 40 Part F's G1-G18 set is closed and
-- database/schema/guards.sql is frozen during the parallel lane phase (CLAUDE.md "Frozen during any
-- parallel phase") — inventing a new guard number or editing that file is out of scope for this
-- migration. The header line above is the accepted fallback per the Master's own instruction
-- ("otherwise the header line is enough"); a G-numbered pg_proc check, if wanted, is a Master task
-- against guards.sql, not this lane's.
--
-- Round-2 finding 1: matching only on (entity_id, proposed_code) / target_account_id let an approved
-- "rename" request be followed by writing arbitrary other columns — every mutable column is now
-- checked against what the request actually proposed. On UPDATE, a NULL proposed_* column means
-- "leave unchanged": the request never proposed touching it, so the column must be unchanged from
-- OLD; this part cannot clear name_en/parent_id to null (matches the reviewer's confirmed default).
-- code is immutable post-creation (brief/tests confirm no update path changes it), so on UPDATE it
-- is simply required to equal OLD, not matched against any proposed_code (update requests don't
-- carry one).
--
-- Round-3 fix 1 (last-round FAIL(8) item 1): the "or new.x is not distinct from r.proposed_x" second
-- disjunct let new.x=NULL through even when r.proposed_x was NULL (NULL "is not distinct from" NULL
-- is true) — a CFO could null out a nullable column with no maker proposal to do so. The two nullable
-- mutable columns (name_en, parent_id — per 01-Data-Model.sql:1178-1187, name_ar/account_type/
-- is_postable are all NOT NULL there so the same hole cannot manifest through them) now use
-- `(r.proposed_x is not null and new.x = r.proposed_x)` for that branch — ordinary `=`, not
-- `is not distinct from`, since this branch only fires once proposed_x is proven non-null. is_postable
-- gets the same treatment for defense-in-depth/consistency even though its NOT NULL constraint already
-- makes the hole unreachable through it. name_ar/account_type are left as `is not distinct from`
-- (unchanged) since they are NOT NULL columns the hole cannot reach.
--
-- Round-2 finding 2 (replay), Master's exact ruling: `r.decided_at = now()`, not xmin/xact_id. In
-- Postgres, now() returns the CURRENT TRANSACTION's start timestamp — stable within one transaction,
-- however many statements it runs. Approve sets decided_at = now() in the SAME transaction that then
-- writes gl_accounts (brief, "The gl_accounts write — ONLY inside Approve, same transaction"), so
-- requiring the matched request's decided_at to equal THIS transaction's now() can only be true if the
-- request was decided (decided_at set) in THIS exact transaction — any earlier transaction's now() is
-- a different (earlier) timestamp. This makes each approval single-use by construction: no new column,
-- no xmin/xact_id cast gymnastics. decided_at must always be set via now() — never a caller-supplied
-- clock value — see the column definition and this trigger for the enforced assumption.

create or replace function billing.assert_gl_account_change_approved()
returns trigger language plpgsql as $$
begin
  if current_user <> 'pgeos_app' then
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    if new.entity_id is distinct from old.entity_id then
      raise exception using errcode = '42501', message =
        '0034: gl_accounts.entity_id cannot change via the maker/checker write path';
    end if;

    if new.code is distinct from old.code then
      raise exception using errcode = '42501', message =
        '0034: gl_accounts.code is immutable once created (no update request proposes it)';
    end if;

    if not exists (
      select 1 from billing.gl_account_change_requests r
      where r.status = 'approved'
        and r.target_account_id = new.id
        and r.approved_by = platform.current_user_id()
        and r.decided_at = now()
        and (
          (r.proposed_name_ar is null and new.name_ar is not distinct from old.name_ar)
          or new.name_ar is not distinct from r.proposed_name_ar
        )
        and (
          (r.proposed_name_en is null and new.name_en is not distinct from old.name_en)
          or (r.proposed_name_en is not null and new.name_en = r.proposed_name_en)
        )
        and (
          (r.proposed_account_type is null and new.account_type is not distinct from old.account_type)
          or new.account_type is not distinct from r.proposed_account_type
        )
        and (
          (r.proposed_parent_id is null and new.parent_id is not distinct from old.parent_id)
          or (r.proposed_parent_id is not null and new.parent_id = r.proposed_parent_id)
        )
        and (
          (r.proposed_is_postable is null and new.is_postable is not distinct from old.is_postable)
          or (r.proposed_is_postable is not null and new.is_postable = r.proposed_is_postable)
        )
    ) then
      raise exception using errcode = '42501', message = format(
        '0034: gl_accounts.id=%s has no approved gl_account_change_requests row (decided by the '
        'current user, in the current transaction) whose proposed_* columns match what was written',
        new.id
      );
    end if;
  elsif TG_OP = 'INSERT' then
    if not exists (
      select 1 from billing.gl_account_change_requests r
      where r.status = 'approved'
        and r.change_kind = 'create'
        and r.entity_id = new.entity_id
        and r.proposed_code = new.code
        and r.approved_by = platform.current_user_id()
        and r.decided_at = now()
        and new.name_ar is not distinct from r.proposed_name_ar
        and new.name_en is not distinct from r.proposed_name_en
        and new.account_type is not distinct from r.proposed_account_type
        and new.parent_id is not distinct from r.proposed_parent_id
        and new.is_postable is not distinct from coalesce(r.proposed_is_postable, true)
    ) then
      raise exception using errcode = '42501', message = format(
        '0034: gl_accounts (entity_id=%s, code=%s) has no approved create request (decided by the '
        'current user, in the current transaction) whose proposed_* columns match what was written',
        new.entity_id, new.code
      );
    end if;
  end if;

  return new;
end $$;
comment on function billing.assert_gl_account_change_approved is
  'Plain BEFORE INSERT OR UPDATE trigger (per row) on billing.gl_accounts — NOT a true Postgres '
  'CONSTRAINT TRIGGER (those can only fire AFTER; round-2 finding 5(c)), same style as identity.'
  'check_sod(). Condition 1 (exact wording): bypass keyed on current_user <> ''pgeos_app'', never on '
  'app.user_id being empty — apply.sh/seed/import (superuser, no app context) stays outside it. A '
  'pgeos_app session with an empty/missing app.user_id GUC is rejected HERE (this trigger fires '
  'before RLS''s own WITH CHECK is evaluated on INSERT, so it is this trigger — not RLS — doing the '
  'rejecting; round-2 finding 5(a) correction of the prior draft''s comment). Every mutable column '
  'written is matched against the approved request''s proposed_* columns (round-2 finding 1) and the '
  'matched request must satisfy decided_at = now() — now() is this transaction''s start timestamp, so '
  'this can only be true for a request decided in THIS transaction, closing replay by construction with '
  'no new column (round-2 finding 2, Master''s exact ruling). decided_at must always be set via now(), '
  'never a caller-supplied clock value.';

drop trigger if exists trg_assert_gl_account_change_approved on billing.gl_accounts;
create trigger trg_assert_gl_account_change_approved
  before insert or update on billing.gl_accounts
  for each row execute function billing.assert_gl_account_change_approved();

-- ── 12. identity.column_classification — every new column ───────────────────────────────────────────

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('billing', 'gl_account_change_requests', 'id',                    'public'),
 ('billing', 'gl_account_change_requests', 'entity_id',              'public'),
 ('billing', 'gl_account_change_requests', 'doc_no',                 'public'),
 ('billing', 'gl_account_change_requests', 'change_kind',            'public'),
 ('billing', 'gl_account_change_requests', 'target_account_id',      'public'),
 ('billing', 'gl_account_change_requests', 'proposed_code',          'public'),
 ('billing', 'gl_account_change_requests', 'proposed_name_ar',       'public'),
 ('billing', 'gl_account_change_requests', 'proposed_name_en',       'public'),
 ('billing', 'gl_account_change_requests', 'proposed_account_type',  'public'),
 ('billing', 'gl_account_change_requests', 'proposed_parent_id',     'public'),
 ('billing', 'gl_account_change_requests', 'proposed_is_postable',   'public'),
 ('billing', 'gl_account_change_requests', 'status',                 'public'),
 ('billing', 'gl_account_change_requests', 'requested_by',           'public'),
 ('billing', 'gl_account_change_requests', 'approved_by',            'public'),
 ('billing', 'gl_account_change_requests', 'submitted_at',           'public'),
 ('billing', 'gl_account_change_requests', 'approved_at',            'public'),
 ('billing', 'gl_account_change_requests', 'decided_at',             'public'),
 ('billing', 'gl_account_change_requests', 'rejection_reason',       'public'),
 ('billing', 'gl_account_change_requests', 'version',                'public'),
 ('billing', 'gl_account_change_requests', 'created_at',             'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
