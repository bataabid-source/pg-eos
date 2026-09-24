-- 0011_M_alert-log-version-seed-rules.sql — Lane M — WBS 5.13 part 1 (alert evaluation
-- mechanism). Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- Two changes, one file (0010 precedent):
--
--   1. platform.alert_log gains a `version` column. CLAUDE.md: "every mutable aggregate has
--      a version column" — alert_log rows are mutated by AcknowledgeAlert (and, in a later
--      part, escalate/resolve), so it is a mutable aggregate. RLS is untouched: alert_log
--      already carries the generic `internal_only` policy from 13B's per-table loop
--      (13B-Schema-Reference-Consolidation.sql L3082-3134), which covers every column of the
--      row, not a named column list — a new column needs no new policy. Same pattern as
--      0008 (wms.inbound_orders.version).
--
--   2. N-16 is deactivated. 13B L2839-3043 ALREADY seeds all 22 platform.alert_rules rows
--      (on conflict (code) do nothing) and apply.sh runs 01 → 13 → 13B → 019 before any
--      migration, so this file seeds nothing — the guard G-SEED row for alert_rules (guards.sql
--      L214) is already 22/22. The one seed change this slice needs is N-16: doc 25 §2 L59 and
--      §2-1 L206 mark it SUPERSEDED (ADR-0003 · D-126/D-125), but 13B still seeds it active,
--      and its aggregate `having` with no `group by` returns one row whenever no biometric run
--      exists — it would fire SYSADMIN on every EvaluateAlertRules run. Deactivated, not
--      deleted: G-SEED still counts 22; row removal is SCR-HR-ATT-01 §4's own migration
--      (PROJECT_STATE: "migration number not yet issued"). The mute_* fields stay null — doc
--      25 §1 defines muting as owner-only, with a reason and a duration; this is a supersession,
--      not a mute.
--
--   Not changed here (13B's seed governs; doc 25 is not in CLAUDE.md's governing list, so a
--   value change would be a G-01 request, not a migration): N-17/N-18/N-19/N-22 keep 13B's
--   static target_roles; their per-row dynamic recipient (approval_chains.approver_role,
--   domain_owners.owner_role, integration_config.owner_role) is application-layer work for
--   WBS 5.13 part 2. Known 13B-vs-doc-25 differences the Master accepts as 13B's values,
--   listed in CHANGELOG: N-06 dedupe 0 vs "once" · N-21 escalate 168 h vs 14 d · N-13
--   escalate {WH_MGR,GM} vs WH_MGR · N-14 escalate {GM} vs "call-center manager".
--
-- pg-reviewer pre-migration review (opus): round 1 FAIL(11) — seed block deleted (13B already
-- seeds), N-16 handled as an update, dynamic-recipient defaults withdrawn; round 2 PASS(0) —
-- this text. Reviewer notes kept: file name keeps `seed-rules` because number 0011 was issued
-- under it in tasks/LANE_LOCKS.md; platform.alert_rules has no FORCE RLS (13B L3154-3170), so the
-- owner's update is not filtered.

begin;

alter table platform.alert_log add column if not exists version integer not null default 1;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('platform', 'alert_log', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

-- N-16 SUPERSEDED — doc 25 §2 L59 / §2-1 L206, ADR-0003 (D-126/D-125). Deactivated, not
-- deleted: G-SEED still counts 22; row removal is SCR-HR-ATT-01 §4's own migration.
update platform.alert_rules set is_active = false where code = 'N-16' and is_active;

commit;
