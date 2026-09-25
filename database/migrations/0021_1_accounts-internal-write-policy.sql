-- 0021_1_accounts-internal-write-policy.sql — Lane 1 — WBS 1.8 (group-level credit limit and
-- hold). Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- D-177 (GM/Master ruling, docs/notes/SCR-SALES-ACCT-01-accounts-write-policy.md): sales.accounts
-- had only ONE RLS policy — client_portal_scope, SELECT only — confirmed empirically to make
-- every write from pgeos_app a silent no-op (`UPDATE 0`, no error). Root cause (corrected per
-- pg-reviewer's catch on the first draft of this note): the 13B dynamic policy-generation loop
-- `continue`s for any table that ALREADY has a policy, and 01-Data-Model.sql:1486 had already
-- created client_portal_scope on sales.accounts, so the loop skipped the table entirely before
-- its own internal_only (no-entity_id) branch ever ran — an authoring oversight, not a deliberate
-- restriction. This file adds exactly the internal_only policy that branch would have produced,
-- verbatim to the existing pattern (13B: wms.work_order_tasks / wms.work_order_events). Permissive
-- policies OR together, so this is additive: internal staff gain full read/write, the existing
-- client-portal SELECT scoping for external callers is untouched.
--
-- Idempotent guard (pg-reviewer round 1: a bare `create policy` has no `if not exists` and fails
-- on the second apply): drop-then-create, the repo's own pattern for re-runnable policies
-- (13B-SP-3).
--
-- Ruled explicitly (D-177): RLS stays entity/internal scoping ONLY here — role authorization
-- (CFO/GM gates on SetCreditLimit, SetCreditHold, ReleaseCreditHold) belongs in application code,
-- same layering as every other slice's domain-level role checks. This migration grants no
-- role-specific access; it only lets internal users through RLS at all.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (drop-then-create guard added; header
-- root-cause text corrected to match the corrected SCR note) — WBS 1.8 slice brief
-- (docs/notes/slice-briefs/_slice-1.8.brief.md), D-177.

begin;

drop policy if exists internal_only on sales.accounts;
create policy internal_only on sales.accounts
  for all using (platform.is_internal());

commit;
