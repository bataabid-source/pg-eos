-- 0036_2_gl-accounts-is-active.sql — Lane 2 — WBS 4.1a part 3. Forward-only, idempotent
-- (apply.sh re-runs every file on every apply).
--
-- A DELTA migration over 0034_2_gl-account-change-requests.sql (4.1a part 2). 0034 is applied and
-- is never edited; its own header/table comment note "deactivate/reactivate deferred to 4.1a part 3"
-- stays there as the historical record of that part — THIS file is the part it deferred to.
-- Brief: docs/notes/slice-briefs/_slice-4.1a-part3.brief.md, section "Schema design (this part's own
-- delta over migration 0034)". Closes SCR-ACC-01 row 1's part-3 item (gl_accounts lifecycle), doc 38
-- row 4.1a part 3: "deactivate/reactivate requests follow the same maker/checker path; a deactivation
-- with active children or a non-zero balance is rejected" — the non-zero-balance half is OUT of scope
-- here (Master ruling carried in MASTER_BACKLOG row 151: 4.20/4.23, once journal_lines postings
-- exist); this file enforces ONLY the maker/checker path for the two new change kinds and the
-- active-children rule.
--
-- Four schema changes, nothing else (no RLS change — a plain column addition and two widened CHECKs
-- need none; no platform.approval_chains change — the existing ('gl_account_change', 1, 'CFO') row
-- seeded by 0034 section 8 is request-type-keyed, and platform.is_approval_chain_approver(p_request_
-- type, p_step) takes no change_kind, so it already covers deactivate/reactivate):
--   1. billing.gl_accounts.is_active boolean not null default true (+ its identity.column_
--      classification row). A separate axis from is_postable: lifecycle (active/inactive) vs.
--      header/leaf (postable or not).
--   2. chk_glc_requests_change_kind widened to ('create','update','deactivate','reactivate').
--   3. chk_glc_requests_change_kind_target widened: create still requires a null target_account_id;
--      update, deactivate and reactivate all require a non-null one — mirrors modules/billing/domain/
--      gl-account-change-requests/invariants.ts::isValidChangeKindTargetPairing (non-null target for
--      anything that is not 'create').
--   4. billing.assert_gl_account_change_approved() (0034 section 11, the plain BEFORE INSERT OR UPDATE
--      trigger on billing.gl_accounts) is replaced with its full 0034 body plus:
--      a. a NEW UNCONDITIONAL active-children check, placed BEFORE the `current_user <> 'pgeos_app'`
--         bypass: an UPDATE flipping is_active true -> false is rejected (SQLSTATE 23514) while any
--         child (parent_id = new.id) is still is_active = true. This is a data-integrity invariant,
--         not a four-eyes rule, so seed/apply.sh/import obey it too (same precedent class as
--         identity.check_sod()'s unconditional checks; brief "Defaults taken").
--      b. the UPDATE branch's maker/checker `exists` subquery restructured into three disjuncts keyed
--         on r.change_kind: 'update' (the 0034 proposed_*-matching rule unchanged, plus is_active must
--         not change — an update request never touches is_active); 'deactivate' (is_active true ->
--         false, the five other mutable columns name_ar/name_en/account_type/parent_id/is_postable all
--         unchanged); 'reactivate' (is_active false -> true, the same five columns unchanged). The
--         0034 subquery had no change_kind key at all (it matched on target_account_id only, since
--         'update' was the only kind with a target); keying it now stops a deactivate/reactivate
--         approval from being spent on an arbitrary content edit, and an update approval from being
--         spent on a lifecycle flip.
--      c. the INSERT branch's `exists` subquery gains `new.is_active is not distinct from true`
--         (defense-in-depth — the column default already guarantees it; 0034's "every mutable column
--         written is matched" doctrine, round-2 finding 1): an account is always created active.
--      Its `comment on function` is rewritten to describe the widened behaviour.
-- The table comment on billing.gl_account_change_requests (0034 section 4, "create/update only this
-- part") is also refreshed so it does not go stale.

begin;

-- ── 1. billing.gl_accounts.is_active ─────────────────────────────────────────────────────────────────

alter table billing.gl_accounts add column if not exists is_active boolean not null default true;

comment on column billing.gl_accounts.is_active is
  'WBS 4.1a part 3 (SCR-ACC-01 row 1): lifecycle flag — changed ONLY through an approved '
  'gl_account_change_requests row of change_kind deactivate/reactivate (trigger billing.assert_gl_'
  'account_change_approved). An account cannot be deactivated while it has an active child. Separate '
  'axis from is_postable (header/leaf).';

-- ── 2. chk_glc_requests_change_kind — widened ────────────────────────────────────────────────────────

alter table billing.gl_account_change_requests drop constraint if exists chk_glc_requests_change_kind;
alter table billing.gl_account_change_requests add constraint chk_glc_requests_change_kind
  check (change_kind in ('create', 'update', 'deactivate', 'reactivate'));

-- ── 3. chk_glc_requests_change_kind_target — widened ─────────────────────────────────────────────────
-- mirrors modules/billing/domain/gl-account-change-requests/invariants.ts::isValidChangeKindTargetPairing

alter table billing.gl_account_change_requests drop constraint if exists chk_glc_requests_change_kind_target;
alter table billing.gl_account_change_requests add constraint chk_glc_requests_change_kind_target check (
  (change_kind = 'create' and target_account_id is null)
  or (change_kind <> 'create' and target_account_id is not null)
);

comment on table billing.gl_account_change_requests is
  'WBS 4.1a part 2, D-190: maker/checker write path for billing.gl_accounts. The gl_accounts row is '
  'written ONLY inside Approve (application layer), same transaction, same audit_log row. change_kind '
  'is create/update (4.1a part 2, migration 0034) or deactivate/reactivate (4.1a part 3, migration '
  '0036 — flips gl_accounts.is_active only; a deactivation with an active child is rejected).';

-- ── 4. billing.assert_gl_account_change_approved() — 0034 body + part-3 additions ───────────────────
-- Full function reproduced from 0034 section 11 (every 0034 rule kept verbatim: entity_id/code
-- immutability, the round-3 fix 1 NULL-clearing guard on name_en/parent_id/is_postable, the
-- decided_at = now() replay guard, the current_user bypass), with the part-3 additions described in
-- this file's header (4a, 4b, 4c).

create or replace function billing.assert_gl_account_change_approved()
returns trigger language plpgsql as $$
begin
  -- 4a (WBS 4.1a part 3): unconditional — runs BEFORE the pgeos_app bypass below, so seed/apply.sh/
  -- import are bound by it too. Existence only; the count is not needed.
  if TG_OP = 'UPDATE' and new.is_active = false and old.is_active = true then
    if exists (
      select 1 from billing.gl_accounts c
      where c.parent_id = new.id
        and c.is_active = true
    ) then
      raise exception using errcode = '23514', message = format(
        '0036: gl_accounts.id=%s cannot be deactivated while it has an active child account '
        '(deactivate every child first)',
        new.id
      );
    end if;
  end if;

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
          -- 'update': every mutable column matched against the proposal (0034 rule, unchanged);
          -- is_active must NOT change (4b — that is what deactivate/reactivate are for).
          (
            r.change_kind = 'update'
            and new.is_active is not distinct from old.is_active
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
          )
          -- 'deactivate' (4b): is_active true -> false ONLY; the five other mutable columns unchanged.
          or (
            r.change_kind = 'deactivate'
            and new.is_active = false and old.is_active = true
            and new.name_ar is not distinct from old.name_ar
            and new.name_en is not distinct from old.name_en
            and new.account_type is not distinct from old.account_type
            and new.parent_id is not distinct from old.parent_id
            and new.is_postable is not distinct from old.is_postable
          )
          -- 'reactivate' (4b): is_active false -> true ONLY; the five other mutable columns unchanged.
          or (
            r.change_kind = 'reactivate'
            and new.is_active = true and old.is_active = false
            and new.name_ar is not distinct from old.name_ar
            and new.name_en is not distinct from old.name_en
            and new.account_type is not distinct from old.account_type
            and new.parent_id is not distinct from old.parent_id
            and new.is_postable is not distinct from old.is_postable
          )
        )
    ) then
      raise exception using errcode = '42501', message = format(
        '0036: gl_accounts.id=%s has no approved gl_account_change_requests row (decided by the '
        'current user, in the current transaction) whose change_kind and proposed_* columns match '
        'what was written',
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
        -- 4c (WBS 4.1a part 3): an account is always created active.
        and new.is_active is not distinct from true
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
  'check_sod(). FIRST, unconditionally (before any bypass, so seed/apply.sh/import obey it too — WBS '
  '4.1a part 3, migration 0036): an UPDATE flipping is_active true -> false is rejected with SQLSTATE '
  '23514 while any child (parent_id = the row''s id) is still is_active = true. THEN the four-eyes '
  'check. Condition 1 (exact wording): bypass keyed on current_user <> ''pgeos_app'', never on '
  'app.user_id being empty — apply.sh/seed/import (superuser, no app context) stays outside it. A '
  'pgeos_app session with an empty/missing app.user_id GUC is rejected HERE (this trigger fires '
  'before RLS''s own WITH CHECK is evaluated on INSERT, so it is this trigger — not RLS — doing the '
  'rejecting; round-2 finding 5(a) correction of the prior draft''s comment). An UPDATE must match an '
  'approved request keyed on change_kind: ''update'' matches every mutable column against the '
  'request''s proposed_* columns (round-2 finding 1) and must leave is_active unchanged; '
  '''deactivate'' / ''reactivate'' flip is_active true -> false / false -> true ONLY, with name_ar, '
  'name_en, account_type, parent_id and is_postable unchanged (migration 0036). An INSERT must match '
  'an approved ''create'' request on every proposed_* column and be written with is_active = true. The '
  'matched request must satisfy decided_at = now() — now() is this transaction''s start timestamp, so '
  'this can only be true for a request decided in THIS transaction, closing replay by construction with '
  'no new column (round-2 finding 2, Master''s exact ruling). decided_at must always be set via now(), '
  'never a caller-supplied clock value.';

-- The trigger itself (trg_assert_gl_account_change_approved, before insert or update, 0034 section
-- 11) is unchanged — create or replace function above rebinds it to the new body; no drop/recreate.

-- ── 5. identity.column_classification — the one new column ──────────────────────────────────────────

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('billing', 'gl_accounts', 'is_active', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
