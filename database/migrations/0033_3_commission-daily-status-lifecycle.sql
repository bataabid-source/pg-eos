-- 0033_3_commission-daily-status-lifecycle.sql — Lane 3 — WBS 3.13 part 4 (commission dispute +
-- confirm mechanism). Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- (1) hr.commission_daily's own live chk_commission_daily_status CHECK
-- (13B-Schema-Reference-Consolidation.sql:2449-2450) says
-- `status = any(array['calculated','disputed','approved','paid'])`, with its own inline comment
-- flagging it "استنباط — يحتاج تحكيم" (inferred, needs arbitration) — the table's own column
-- comment (13-Schema-Additions.sql:379-380) and its `confirmed_by`/`confirmed_at` columns instead
-- name the third state 'confirmed'. Doc 10:275 (a governing package document) also names
-- `calculated · disputed · confirmed · paid`. GM/evaluation-session ruling (D-190, appended
-- 2026-09-26, docs/DECISION_LOG.md — "Further ruling ... WBS 3.13 part 4") resolves the
-- discrepancy: the third state is 'confirmed'. Read-only verification, both by lane
-- 3 and independently before this file was written: `select status, count(*) from
-- hr.commission_daily group by status` returns ZERO rows on the live dev database — the table is
-- still empty, so this CHECK correction carries no data-migration risk either way. Idempotent
-- guard: drop-then-create (bare `add constraint` fails on a second apply if already present under
-- the same name).
--
-- (2) hr.guard_commission_daily_status() + trg_guard_commission_daily_status — the DB-backstop
-- transition guard, verbatim pattern of hr.guard_sales_commission_status() /
-- trg_guard_sales_commission_status (13B:5164-5183), which guards the sister table
-- hr.sales_commission_events. Edges allowed: calculated -> disputed (DisputeCommission) ·
-- calculated -> confirmed (ConfirmCommission, the window-expiry path, skipping 'disputed'
-- entirely) · disputed -> confirmed (ConfirmCommission, DEL_SUP resolves the dispute). No edge
-- reaches 'paid' — that transition belongs to WBS 5.6 (Payroll ledger), a separate, dependent
-- slice, out of scope here; the CHECK constraint still allows 'paid' as a value (matching the
-- doc-38/doc-10 status vocabulary) but this trigger does not yet authorize entering it.
--
-- PLUS an SoD check the sales precedent does not need (doc 10:300, "نافذة اعتراض 48 ساعة →
-- مراجعة مشرف التوصيل" — the 48-hour dispute window is reviewed by the Delivery Supervisor,
-- DEL_SUP, 13B:561 — never by the disputing driver themselves): whenever a row becomes or stays
-- 'confirmed' with a non-null `confirmed_by` that resolves (via `identity.users.id =
-- confirmed_by and identity.users.employee_id = the row's own employee_id`, an EXISTS check, not
-- a `select into` — employee_id carries no unique constraint, so a naive single-row lookup could
-- silently pick the wrong account) to the SAME employee as the row's own `employee_id`, the
-- trigger raises — on INSERT as well as UPDATE (round-1 review finding 4), and on any UPDATE that
-- reassigns `confirmed_by` even without a status change (round-1 review finding 3). A NULL
-- `confirmed_by` is NOT rejected by this backstop (round-1 review finding 5: that is the
-- not-yet-built scheduler's own auto-confirm path, brief scope note 4 — the application layer is
-- solely responsible for always setting `confirmed_by` to a real actor before this backstop can
-- catch a genuine self-review attempt; no CHECK enforces "confirmed_by is required", since that
-- would be inventing a rule beyond doc 40/38/10 and 13/13B name no such requirement — file an SCR
-- if one is ever wanted). The function runs `security definer` (round-1 review finding 1, same
-- pattern as `identity.enforce_client_users_hold_no_entities()`, migration 0003) so its own
-- `identity.users` lookup never depends on the caller's own RLS/grants on that table staying wide
-- enough — a narrower `identity.users` policy added later must not silently let self-review
-- through. This is a DB-level backstop — the application layer's own ConfirmCommission command
-- performs the identical check first and throws a typed, actionable SelfReviewNotAllowedError;
-- this trigger exists so the invariant holds even if a future caller writes to
-- hr.commission_daily some other way.
--
-- (3) platform.thresholds seed hr.commission.dispute_window_hours = 48 (hours) — verbatim pattern
-- of the sibling sales.commission.dispute_window_hours seed (13B:5199), GM-decided per doc
-- 10:434 / doc 40 §C7 ("48 ساعة" — closed, not an open question). Application code reads this
-- threshold at runtime; CLAUDE.md AGENT CONSTRAINTS forbids a magic `48` literal anywhere in
-- domain/application code.
--
-- Idempotent guards: drop-then-create for the constraint and the trigger (same pattern as 0021/
-- 0027); `on conflict do nothing` on the threshold insert (matches every other threshold seed in
-- 13B).
--
-- RED test paths (lane-guard): modules/hr/tests/dispute-commission/dispute-commission.feature,
-- modules/hr/tests/dispute-commission/dispute-commission.test.ts,
-- modules/hr/tests/dispute-commission/invariants.property.test.ts,
-- modules/hr/tests/dispute-commission/handlers.test.ts,
-- modules/hr/tests/confirm-commission/confirm-commission.feature,
-- modules/hr/tests/confirm-commission/confirm-commission.test.ts,
-- modules/hr/tests/confirm-commission/handlers.test.ts — all 7 files exist, RED confirmed
-- 2026-09-26 (module/contract not found; the CHECK-constraint RED layer triggers once
-- pg-backend's implementation exists, before this migration applies).
--
-- pg-reviewer pre-migration review: round 1 FAIL (8 findings — 4 required SQL changes: security
-- definer + search_path on the guard function; EXISTS-based self-review check instead of a
-- non-unique `select into`; the self-review check now fires on any confirmed_by reassignment,
-- not only a status change; the trigger now fires on INSERT too, not only UPDATE — all four
-- applied above; plus header/bookkeeping fixes: the NULL-confirmed_by default now stated
-- explicitly, the D-190 citation appended to docs/DECISION_LOG.md, the RED-path/file-count
-- wording reconciled). Round 2 FAIL (3 findings, comment/bookkeeping only, SQL body unchanged
-- and re-confirmed correct on independent re-derivation): MIGRATION-REQUEST-3.md row 3's missing
-- `|` and brace-notation RED paths (unparseable by lane-guard.sh) fixed, here and there, to full
-- paths; this file's own "round-2" mislabels of round-1's own findings corrected to "round-1"
-- throughout; docs/DECISION_LOG.md's D-190 append corrected to not overstate what the DB
-- backstop trigger enforces (self-review only, for a non-null confirmed_by — the DEL_SUP-role
-- check itself is the application layer's own responsibility, ConfirmCommission, not yet built).
-- **This was accurate as of round 2 only** — item (5) below adds the DEL_SUP-role check to the
-- DB trigger itself (round-3 review, after pg-backend's own build found DEL_SUP had zero seeded
-- permissions at all); the trigger now enforces both self-review AND role membership, bound to
-- the session actor, not the application layer alone.
--
-- (4) Renumbered from 0032 to 0033 after the Master flagged that 0032 was already lane 1's own
-- number (order_lines.picked_by) — a race in reading LANE_LOCKS.md's "next free number" line
-- before requesting it properly; corrected before this file (or any bookkeeping citing it) was
-- ever committed or pushed, no shared state affected.
--
-- (5) pg-backend's own build (application layer, this same slice) found DEL_SUP holds ZERO
-- permissions in the live seed data at all — so ConfirmCommission's "DEL_SUP resolves a dispute"
-- scenarios were structurally unbuildable: `own_commission`'s SELECT policy (0027) hides every
-- row from an internal actor unless they are the row's own employee OR hold
-- `hr.commission.read_all` — and DEL_SUP holds neither. Master ruling (D-190): seed the EXISTING
-- `hr.commission.read_all` permission to DEL_SUP for VISIBILITY only (added below) — but that
-- permission must NEVER be treated as the WRITE authority for confirming a dispute (a role that
-- can only read shouldn't therefore be able to write). Since no dedicated write permission exists
-- anywhere in 01/13/13B, the guard trigger's SoD check (item 2 above) now ALSO requires the
-- confirming actor to hold the DEL_SUP ROLE directly (identity.user_roles/identity.roles), not
-- any permission — an interim, role-based authorization, until a G-01-proposed
-- `hr.commission.confirm` write-permission is reviewed and, if accepted, replaces it. Filed as
-- docs/notes/SCR-HR-COMM-01-commission-confirm-permission.md (round-3 review finding 5 — an
-- unresolved G-01 candidate belongs in an SCR note with its own Master/GM decision, never as
-- commented-out SQL sitting inside a forward-only migration file), which also records the
-- unresolved cross-domain visibility question round-3 review finding 3 raised: seeding
-- `hr.commission.read_all` to DEL_SUP also grants visibility into `hr.sales_commission_events`
-- (the sister table's own `own_sales_commission` policy gates on the SAME permission code,
-- 13B:5124-5127) — sales reps' commission accrual data, unrelated to driver disputes, not named
-- as an intended DEL_SUP holder anywhere in 13B ق-45's own list. NOT resolved here; recorded and
-- deferred to the SCR, not silently accepted or silently withdrawn.
--
-- Round 3 pre-migration review: FAIL (8 findings — 2 SECURITY, applied above: the self-review
-- and DEL_SUP-role checks now bind to platform.current_user_id(), never to a client-supplied
-- confirmed_by value alone; a disputed row can no longer be confirmed with a NULL confirmed_by,
-- only the calculated-window-expiry auto-confirm edge stays exempt; 1 self-check added on the
-- DEL_SUP/read_all seed insert; the commented-out permission SQL replaced by the SCR note above;
-- this header and docs/DECISION_LOG.md's D-190 append corrected for staleness; the cross-domain
-- read_all exposure recorded, not resolved, at the same SCR).
--
-- (6) SCR-HR-COMM-01 APPROVED (D-190, same day): item (5) above is now HISTORY, superseded — the
-- interim "seed hr.commission.read_all to DEL_SUP" / "DEL_SUP-role-code check" design was NEVER
-- applied to any shared database and is fully replaced by: a NEW `hr.driver_commission.read_all`
-- permission (commission_daily-only visibility, `own_commission` recreated to check it instead
-- of `hr.commission.read_all`, seeded to DEL_SUP + every role that already held
-- `hr.commission.read_all` so none of them loses visibility) and a NEW `hr.commission.confirm`
-- permission (the real write authority, seeded to DEL_SUP, checked via `platform.has_perm()`,
-- scoped to the disputed -> confirmed edge only). The cross-domain exposure question is now
-- CLOSED, not merely deferred — `hr.sales_commission_events` is untouched by either new
-- permission. `docs/CHANGELOG.md` records: "hr.commission.read_all gated two unrelated commission
-- tables — found by the 0033 pre-migration review; split per D-190."
--
-- Round 4 pre-migration review: FAIL (6 findings, all applied above before this text was
-- written — SECURITY/state-integrity, cannot be split): (1) the NULL-confirmed_by exemption was
-- narrowed from "anything not disputed" to EXACTLY "UPDATE, FROM calculated, TO confirmed" — an
-- INSERT-as-confirmed or an UPDATE nulling out an already-confirmed row's confirmed_by are both
-- now rejected; (2) INSERT is now pinned to status='calculated', doc 10:275's own lifecycle
-- start, closing the gap where an INSERT could otherwise skip straight to disputed/confirmed/paid
-- with no transition check ever running; (3) the `hr.commission.confirm` permission check is
-- scoped to `old.status='disputed'` only, since no document makes DEL_SUP a gate on the plain
-- window-expiry auto-confirm path. Findings 4 (pg-backend's ConfirmCommission needs its own
-- matching role/permission check, and its stale "migration 0032" citation) and 6 (further header
-- staleness) were routed back to pg-backend; finding 5 (RED test coverage) stayed routed to
-- pg-tester.
--
-- Round 5 pre-migration review: FAIL (2 findings, SECURITY, applied above): `confirmed_by`
-- made IMMUTABLE once a row reaches 'confirmed' (no reassignment or nulling-out afterward,
-- checked before everything else); the NULL-confirmed_by rejection no longer catches an UPDATE
-- that leaves an already-auto-confirmed row's NULL confirmed_by untouched (e.g. writing
-- `payroll_period` later). This WAS the escalated final round per the review cap and D-117 for
-- this migration's own pre-migration review cycle — re-confirmed PASS at the slice-close review's
-- own independent re-derivation of the trigger's full if/elsif chain (WBS 3.13 part 4 slice-close
-- round 2). The migration's own SQL body carries no further open finding as of that round; the
-- slice-close review's own remaining findings are tracked separately in "3.13 part 5"
-- (MASTER_BACKLOG), not in this file.

begin;

alter table hr.commission_daily drop constraint if exists chk_commission_daily_status;
alter table hr.commission_daily add constraint chk_commission_daily_status
  check (status = any (array['calculated', 'disputed', 'confirmed', 'paid']));

create or replace function hr.guard_commission_daily_status() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Round-4 review finding 2: an INSERT has no prior state to transition FROM, so the
  -- state-machine check above never ran for one — an INSERT could carry status='disputed',
  -- 'confirmed' or even 'paid' directly, contradicting doc 10:275's own lifecycle start
  -- (`calculated`, always written first by CalculateDailyCommission) and this trigger's own
  -- header claim that no path reaches 'paid' yet.
  if tg_op = 'INSERT' and new.status <> 'calculated' then
    raise exception 'صف عمولة يومية جديد يجب أن يبدأ بحالة calculated، لا % — WBS 3.13 part 4', new.status
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
         (old.status = 'calculated' and new.status in ('disputed', 'confirmed'))
      or (old.status = 'disputed'   and new.status = 'confirmed')
    ) then
      raise exception 'انتقال حالة عمولة يومية غير مسموح: % ⇒ % — WBS 3.13 part 4', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- SoD (doc 10:300): checked whenever a row becomes/stays 'confirmed' with a confirmer set,
  -- not only on a status change — an UPDATE that merely changes confirmed_by on an
  -- already-confirmed row must not be able to quietly reassign it to the driver themselves.
  -- Fires on INSERT too (round-1 review finding 4, though INSERT is now pinned to 'calculated'
  -- above, round-4 finding 2, so this specific INSERT case is currently unreachable — the check
  -- stays as defense in depth). Current, final state (superseding two now-stale earlier
  -- descriptions of this same block, left as history above in the header, not restated here):
  -- `hr.commission.read_all` is VISIBILITY-only and does not gate this table at all any more —
  -- `own_commission` (below, in the SQL body) now checks the NEW `hr.driver_commission.read_all`
  -- permission instead (SCR-HR-COMM-01, APPROVED). The WRITE authority for resolving a dispute is
  -- the NEW `hr.commission.confirm` permission (seeded to DEL_SUP below), checked via
  -- `platform.has_perm()` — the same mechanism every other authorization check in this codebase
  -- uses — scoped to the disputed -> confirmed edge only (round-4 finding 3). No role-code check
  -- remains anywhere in this function.
  --
  -- Round-3 review findings 1/2 (SECURITY, applied): the checks below must bind to the ACTING
  -- session user (platform.current_user_id()), never to the client-supplied `new.confirmed_by`
  -- column alone — otherwise any internal actor visible to `internal_update` (e.g. a read_all
  -- holder who is not DEL_SUP) could name an arbitrary real DEL_SUP user id in `confirmed_by` and
  -- pass both EXISTS checks despite never having authenticated as that user. Every OTHER
  -- authorization check in this codebase (has_perm(), my_employee_id()) binds to the session actor
  -- for exactly this reason. Also: a NULL `confirmed_by` is the exempted path ONLY for the
  -- `calculated -> confirmed` window-expiry auto-confirm edge (round-1 finding 5) — a
  -- `disputed -> confirmed` transition, which doc 10:300 says is ALWAYS a DEL_SUP human review,
  -- must never leave `confirmed_by` null.
  -- Round-4 review finding 1: the previous "old.status is distinct from 'disputed'" exemption
  -- was too wide — it also silently allowed (i) an INSERT with status='confirmed' and a NULL
  -- confirmer (bypassing any window/dispute check entirely — now moot anyway, INSERT is pinned
  -- to 'calculated' above) and (ii) an UPDATE on an ALREADY-confirmed row that nulls out its own
  -- confirmed_by, erasing who confirmed it. The auto-confirm NULL exemption is now scoped to
  -- EXACTLY the one edge round-1 finding 5 approved: an UPDATE, FROM 'calculated', TO 'confirmed'.
  -- Round-5 review finding 1 (SECURITY, applied): once a row IS 'confirmed', `confirmed_by`
  -- becomes IMMUTABLE — no actor, DEL_SUP or otherwise, may reassign or null out who resolved a
  -- dispute after the fact (doc 10:300's record of who reviewed it must not be erasable). This
  -- also closes finding 2's root cause: any later UPDATE that does NOT touch `confirmed_by` on an
  -- already-confirmed row (e.g. writing `payroll_period`, WBS 5.6's own future consumer) must not
  -- be caught by the exemption/rejection logic below at all — checked first, before it.
  if tg_op = 'UPDATE' and old.status = 'confirmed' and new.status = 'confirmed'
     and new.confirmed_by is distinct from old.confirmed_by
  then
    raise exception 'confirmed_by غير قابل للتعديل بعد الاعتماد — WBS 3.13 part 4'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'confirmed' and tg_op = 'UPDATE' and old.status = 'calculated'
     and new.confirmed_by is null
  then
    null; -- the window-expiry auto-confirm path (round-1 finding 5) — intentionally exempt.
  elsif new.status = 'confirmed' and new.confirmed_by is null
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
  then
    -- Round-5 review finding 2: an UPDATE that leaves an already-confirmed row's NULL
    -- confirmed_by untouched (old.status = 'confirmed', both old and new confirmed_by null) must
    -- NOT reach this rejection — the immutability check above already lets it through
    -- unmolested (confirmed_by is distinct from confirmed_by is false), so it never gets here.
    -- Every other way to reach 'confirmed' with no confirmer is rejected: a disputed row
    -- (doc 10:300 — always a DEL_SUP human review), and (defensively, though INSERT is already
    -- pinned above) any other path.
    raise exception 'اعتماد عمولة يتطلب مشرف توصيل محدد (DEL_SUP) — لا يجوز ترك confirmed_by فارغاً هنا — doc 10 §14 (l.300), WBS 3.13 part 4'
      using errcode = 'not_null_violation';
  elsif new.status = 'confirmed'
     and new.confirmed_by is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
  then
    -- The immutability check above already handles old.status = 'confirmed' with a CHANGED
    -- confirmed_by (rejected before this point) — so by construction, reaching this branch with
    -- old.status = 'confirmed' is impossible; this branch only ever runs for a FRESH transition
    -- into 'confirmed' (from calculated or disputed) or an INSERT.
    if new.confirmed_by is distinct from platform.current_user_id() then
      raise exception 'confirmed_by يجب أن يطابق هوية الجلسة الفعلية — لا يجوز انتحال معتمِد آخر — WBS 3.13 part 4'
        using errcode = 'insufficient_privilege';
    end if;

    if exists (
      select 1 from identity.users u
       where u.id = platform.current_user_id() and u.employee_id = new.employee_id
    ) then
      raise exception 'لا يجوز للسائق اعتماد اعتراضه بنفسه — مشرف التوصيل (DEL_SUP) فقط — doc 10 §14, WBS 3.13 part 4'
        using errcode = 'insufficient_privilege';
    end if;

    -- D-190 ruling (round-3 review, permission split): the interim DEL_SUP-role-code check is
    -- REPLACED by the real, permanent write permission `hr.commission.confirm` (seeded below to
    -- DEL_SUP) — checked via `platform.has_perm()`, the SAME mechanism every other authorization
    -- check in this codebase uses. Round-4 review finding 3: no document (01/13/13B/40/10) makes
    -- DEL_SUP a gate on the plain window-expiry auto-confirm path (`old.status = 'calculated'`,
    -- e.g. a manual early confirm of an undisputed row by any authorized internal actor) — doc
    -- 10:300 names DEL_SUP only for reviewing an actual DISPUTE. The permission check is therefore
    -- scoped to exactly that: resolving a dispute (`old.status = 'disputed'`). The self-review and
    -- session-actor-binding checks above still apply unconditionally either way.
    if old.status = 'disputed' and not platform.has_perm('hr.commission.confirm') then
      raise exception 'حل اعتراض عمولة يتطلب صلاحية hr.commission.confirm (مشرف التوصيل DEL_SUP) — doc 10 §14 (l.300), WBS 3.13 part 4'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_commission_daily_status on hr.commission_daily;
create trigger trg_guard_commission_daily_status
  before insert or update on hr.commission_daily
  for each row execute function hr.guard_commission_daily_status();

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
  ('hr.commission.dispute_window_hours', 48.000, 'hours',
   'نافذة اعتراض السائق على عمولته اليومية — doc 10 §14/§15، 48 ساعة (قرار GM، مغلق) — WBS 3.13 part 4',
   '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

-- D-190 ruling (round-3 review finding 3, SCR-HR-COMM-01 APPROVED): `hr.commission.read_all`
-- (0027's own_commission policy) turned out to ALSO gate `hr.sales_commission_events`'s own
-- `own_sales_commission` policy (13B:5124-5127) — sales reps' commission accrual data, unrelated
-- to driver disputes. Seeding it to DEL_SUP (the lane's first attempt, never applied to any
-- shared database) would have given DEL_SUP that unrelated visibility too. Fix: a NEW,
-- commission_daily-only permission, `hr.driver_commission.read_all` — `own_commission` is
-- recreated to check it INSTEAD of `hr.commission.read_all`, keeping the entity scope and the
-- own-row branch (`platform.my_employee_id()`) exactly as 0027 left them. `hr.commission.read_all`
-- itself, and `hr.sales_commission_events`'s own policy, are untouched.
drop policy if exists own_commission on hr.commission_daily;
create policy own_commission on hr.commission_daily
  for select using (
    entity_id = any(platform.allowed_entities())
    and (
      platform.has_perm('hr.driver_commission.read_all')
      or employee_id = platform.my_employee_id()
    )
  );

insert into identity.permissions (code, module, object, action, description) values
  ('hr.driver_commission.read_all', 'hr', 'commission_daily', 'read',
   'رؤية عمولات كل السائقين اليومية (لا عمولات المبيعات) — يحل محل استخدام hr.commission.read_all هنا — SCR-HR-COMM-01, WBS 3.13 part 4')
on conflict (code) do nothing;

-- Seeded to DEL_SUP (the new dispute-review holder) PLUS every role that already held
-- hr.commission.read_all (SALES_MGR, CFO, GM — 13B ق-45/13B:5211-5222), so none of them loses
-- driver-commission visibility they already had; only the PERMISSION CODE checked changes.
insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id
  from identity.roles r, identity.permissions p
 where r.code in ('DEL_SUP', 'SALES_MGR', 'CFO', 'GM')
   and p.code = 'hr.driver_commission.read_all'
on conflict (role_id, permission_id) do nothing;

do $$ declare v_missing text; begin
  select string_agg(expected.code, ', ') into v_missing
    from (values ('DEL_SUP'), ('SALES_MGR'), ('CFO'), ('GM')) as expected(code)
    left join identity.roles r on r.code = expected.code
   where r.id is null
      or not exists (
           select 1 from identity.role_permissions rp
           join identity.permissions p on p.id = rp.permission_id
          where rp.role_id = r.id and p.code = 'hr.driver_commission.read_all'
         );
  if v_missing is not null then
    raise exception '0033: hr.driver_commission.read_all is not held by: % — a role or the permission row is missing', v_missing;
  end if;
end $$;

-- D-190 ruling (round-3 review finding 5, SCR-HR-COMM-01 APPROVED): the real, permanent WRITE
-- permission for confirming a commission dispute — REPLACES the interim DEL_SUP-role-code check
-- in the trigger above entirely, not "both": `has_perm()` is this codebase's uniform
-- authorization pattern everywhere else, and a parallel role-code check would just be a second,
-- weaker copy of the same rule. Scoped in the trigger (round-4 review finding 3) to the
-- disputed -> confirmed edge only — no document requires DEL_SUP to gate the plain
-- window-expiry auto-confirm path.
insert into identity.permissions (code, module, object, action, description) values
  ('hr.commission.confirm', 'hr', 'commission_daily', 'approve',
   'اعتماد/حل اعتراض العمولة اليومية — مشرف التوصيل (DEL_SUP) فقط — SCR-HR-COMM-01, WBS 3.13 part 4')
on conflict (code) do nothing;

insert into identity.role_permissions (role_id, permission_id)
select r.id, p.id from identity.roles r, identity.permissions p
 where r.code = 'DEL_SUP' and p.code = 'hr.commission.confirm'
on conflict (role_id, permission_id) do nothing;

do $$ begin
  if not exists (
    select 1 from identity.roles r
    join identity.role_permissions rp on rp.role_id = r.id
    join identity.permissions p on p.id = rp.permission_id
   where r.code = 'DEL_SUP' and p.code = 'hr.commission.confirm'
  ) then
    raise exception '0033: DEL_SUP does not hold hr.commission.confirm after the seed — the DEL_SUP role or the hr.commission.confirm permission row is missing';
  end if;
end $$;

commit;
