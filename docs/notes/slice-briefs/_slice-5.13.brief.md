# SLICE BRIEF — WBS 5.13 part 1 (Master → pg-tester → pg-backend)

Task: 5.13 "Alerts engine (22 rules), report catalog (24), scheduled delivery" — **part 1: alert
evaluation mechanism only** (SCOPE DEFAULT taken by the Master, recorded in CHANGELOG; part 2
covers report catalog + scheduled delivery + channel dispatch under the same WBS id, next session).
Lane: M            Lock: `platform` + `database/migrations` (0011)

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/platform.brief.md`
- golden slice: `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound/*` (shape only — this use case's actual logic is unrelated to inbound receiving; do not port business rules, only the layering/port/composition pattern)
- `docs/package/40-Build-Specification-EN.md` §B6 (Alerts and Reports — already read by Master, quoted below)
- `docs/package/25-Alerts-Reports-NFR.md` §1, §1-1, §1-2, §2, §2-1 (the 22 alert rules, their `source_query`, `action_label`, `action_link` — Arabic; the SQL blocks are the authoritative source, already verified by the Master to run against current schema)
- schema: `platform.alert_rules`, `platform.alert_log`, `platform.integration_config` (`owner_role`), `platform.domain_owners` (`owner_role`), `platform.approval_chains` (`approver_role`), `admin.approval_requests` (`current_step`) — all in `database/schema/13B-Schema-Reference-Consolidation.sql` / `13-Schema-Additions.sql`
- Scaffold already run: `scripts/new-slice.sh platform evaluate-alerts` (files listed below already exist, pre-renamed, logic empty/TODO)

Write ONLY: `modules/platform/{domain,application,infrastructure,api,tests}/evaluate-alerts/*` ·
`packages/contracts/platform/evaluate-alerts.ts` · `packages/events/catalog.ts` (add one line) ·
`database/migrations/0011_M_alert-log-version-seed-rules.sql` · `tests/**`

## Scenario (Gherkin, paste into `modules/platform/tests/evaluate-alerts/evaluate-alerts.feature`)

```gherkin
Feature: Evaluate alert rules (doc 40 §B6, doc 25 §1-§2)

  Scenario: An alert without an action link is impossible
    Given every row in platform.alert_rules
    Then action_label and action_link are both non-null and non-empty

  Scenario: A rule fires when its source_query returns a row
    Given an active alert rule "N-13" whose source_query returns one unexplained count variance
    When EvaluateAlertRules runs
    Then one platform.alert_log row is written with rule_code "N-13" and the row's entity_ref
    And a "platform.alert.fired" event is written to platform.outbox in the same transaction

  Scenario: A rule does not fire twice inside its dedupe window
    Given rule "N-13" already fired for entity_ref "loc-1" within its dedupe_window_hours
    When EvaluateAlertRules runs again for the same source_query result
    Then no new platform.alert_log row is written for that entity_ref

  Scenario: dedupe_window_hours = 0 means no suppression
    Given rule "N-03" (dedupe_window_hours = 0) already fired for entity_ref "trip-1" one minute ago
    When EvaluateAlertRules runs again with the same result row
    Then a new platform.alert_log row IS written (zero means no suppression, doc 25 §1)

  Scenario: Quiet hours suppress a non-exempt rule
    Given the clock reads 23:00 and rule "N-02" has quiet_hours = true
    When EvaluateAlertRules runs and N-02's source_query would fire
    Then no platform.alert_log row is written for N-02
    And the same evaluation fires normally once the clock reads 08:00

  Scenario: Quiet hours never suppress the two emergency-exempt rules
    Given the clock reads 23:00
    When EvaluateAlertRules runs and rule "N-01" or "N-03" would fire
    Then the platform.alert_log row IS written (doc 25 §1: N-01 and N-03 are the only exemptions)

  Scenario: An alert never targets an unfilled position
    Given identity.roles contains OPS_DIR and HR_MGR with zero active identity.user_roles holders
    Then no seeded platform.alert_rules.target_roles or escalate_to_roles array contains
      "OPS_DIR" or "HR_MGR" (doc 25 §1-2: OPS_DIR reads WH_MGR+DEL_MGR by scope; HR_MGR reads GM)

  Scenario: Acknowledging an alert is idempotent
    Given a fired, unacknowledged platform.alert_log row and an Idempotency-Key
    When AcknowledgeAlert is called twice with the same Idempotency-Key
    Then the row is acknowledged exactly once and the second call returns the first result

  Property test: for every row seeded into platform.alert_rules, action_label <> '' and
    action_link starts with '/' (doc 40 §B6 invariant, domain-level, not just the DB NOT NULL).

  Property test: for every rule whose code is NOT "N-01" or "N-03", quiet_hours = true
    (doc 25 §1: those two are the ONLY exemptions in the record).

  Scenario: The superseded rule never fires
    Given rule "N-16" (is_active = false after migration 0011) and no biometric integration run
    When EvaluateAlertRules runs
    Then no platform.alert_log row is written for "N-16" (inactive rules are never evaluated)
```

## Contract (`packages/contracts/platform/evaluate-alerts.ts`)

Zod schemas for: `EvaluateAlertRulesInput` (optional `ruleCode` to run one rule; defaults to all
active rules — this is the pg-boss job body), `EvaluateAlertRulesResult` (`fired: AlertFired[]`),
`AcknowledgeAlertInput` (`alertLogId`, Idempotency-Key per header, not body), `AcknowledgeAlertResult`.
Derive field shapes from `platform.alert_rules` / `platform.alert_log` columns (13B §13B-4) — do not
invent a column. OpenAPI is generated from this contract per CLAUDE.md.

## Event

Add to `packages/events/catalog.ts`, same commit as the publisher, with a comment block matching
the existing two entries' style:
`'platform.alert.fired'` — aggregate `platform.alert_log`, written once per fired alert, same
transaction as the `alert_log` insert.

## Migration `database/migrations/0011_M_alert-log-version-seed-rules.sql` (pre-reviewed, round 1 FAIL(11) applied)

Two statements, one file (precedent: 0010):

1. `alter table platform.alert_log add column if not exists version integer not null default 1;`
   + its `identity.column_classification` row. CLAUDE.md: "every mutable aggregate has a version
   column"; `alert_log` rows are mutated by acknowledge/escalate/resolve.
2. `update platform.alert_rules set is_active = false where code = 'N-16' and is_active;`

**13B already seeds all 22 `platform.alert_rules` rows** (`13B-Schema-Reference-Consolidation.sql`
L2839-3043, `on conflict (code) do nothing`; apply.sh runs 01 → 13 → 13B → 019 before migrations).
G-SEED is already 22/22. The migration seeds NOTHING. 13B's seed values GOVERN — the brief's
earlier plan to re-seed with `'{}'` target_roles is WITHDRAWN (pg-reviewer finding 3: an empty
recipient list breaks doc 25 §1 "every alert has a recipient by role"; overriding 13B from doc 25
would need a G-01 request). Read the seed from 13B, not from doc 25, for: `target_roles`,
`channels`, `schedule` (13B uses real cron strings — `'realtime'`, `'0 9 * * *'`, `'0 8 * * 0'`,
`'0 8 1 * *'`; the contract/scheduler parses THAT format), `dedupe_window_hours`,
`escalate_after_hours`, `escalate_to_roles`. Doc 25 §2-1 remains the readable reference for what
each rule means and for `source_query`/`action_label`/`action_link` (identical text in 13B).

Facts pg-tester and pg-backend rely on (verified by pg-reviewer against 13B):
- `quiet_hours = false` ONLY for N-01 and N-03; every other row `true`.
- `dedupe_window_hours = 0` for N-03, N-06, N-10, N-13, N-14 (13B values; N-06 "once" vs 0 is a
  known 13B-vs-doc-25 difference — 13B stands, CHANGELOG line).
- `action_label` and `action_link` non-empty on all 22 rows; every link starts with `/`.
- No row's `target_roles`/`escalate_to_roles` contains `OPS_DIR` or `HR_MGR` (doc 25 §1-2 already
  applied in 13B: N-04 → GM, N-13 → WH_MGR).
- N-16 is the only `is_active = false` row after 0011 (superseded, ADR-0003); `mute_*` stay null.
- N-17/N-18/N-19/N-22 carry 13B's STATIC roles (e.g. N-17 `{GM,CFO,WH_MGR,DEL_MGR,SALES_MGR,FLEET_MGR}`,
  N-19 `{SYSADMIN,DEL_MGR,FLEET_MGR,CFO}`). Their per-row dynamic co-recipient
  (`platform.approval_chains.approver_role` via `admin.approval_requests.current_step`;
  `platform.domain_owners.owner_role`; `platform.integration_config.owner_role` — the column doc 25
  §2 names, NOT `alert_roles`) is part 2 work. Part 1 writes `alert_log.recipients` from the STATIC
  roles only (role code → active `identity.user_roles` holders).

## Migration `database/migrations/0012_M_space-dashboard-invoker-grant.sql` (pre-reviewed: APPROVED WITH CHANGES, header only)

N-11 is the only rule whose `source_query` reads a view (`wms.space_dashboard`). 0007 (D-133) leaves
`pgeos_app` no privilege on owner-rights views, so the rule could not run. 0012 sets the view
`security_invoker = true` and grants SELECT — a single-view exception to 0007's "views are never
altered", within D-133's rule (strip loop and G7 both exempt invoker views). Master default, CHANGELOG.
Two reviewer notes that bind later work: (1) any redefinition of `wms.space_dashboard` must carry
`with (security_invoker = true)` or G7 turns red; (2) under invoker rights N-11 counts only what the
caller's `allowed_entities()` can see — the part-2 pg-boss job must run `EvaluateAlertRules` under an
internal system context covering every entity.

## Explicitly OUT of scope for this session (part 1) — record in CHANGELOG and PROJECT_STATE

- Actual channel delivery (email / WhatsApp / SMS / in-app push) — "scheduled delivery" in the
  WBS row title.
- Escalation EXECUTION (the cron/pg-boss job that checks `escalate_after_hours` elapsed and
  notifies `escalate_to_roles`) — only the column data is seeded; no job runs it yet.
- Dynamic recipient resolution for N-17/18/19/22 beyond what's noted above.
- Report catalog (24 reports, doc 25 §5) — a separate, later use case (`generate-report` or similar).
- pg-boss job registration to run `EvaluateAlertRules` on a schedule (`realtime` vs `cron` per
  `alert_rules.schedule`) — the command itself must be schedulable, but wiring the actual pg-boss
  recurring job is part 2, alongside delivery.

`EvaluateAlertRules` and `AcknowledgeAlert` must be fully correct, tested, reviewed and DONE-quality
for what they DO cover (evaluate → dedupe → quiet-hours → fire → log → outbox event; acknowledge).
5.13 as a whole stays NOT DONE until part 2 lands — same pattern as WBS 2.9 (part 1 → part 2 → final).

## Deliver (file list — from `new-slice.sh`, already renamed, empty logic)

```
modules/platform/domain/evaluate-alerts/{errors.ts,invariants.ts,machine.ts}
modules/platform/application/evaluate-alerts/{ports.ts,index.ts,evaluate-alert-rules.ts,acknowledge-alert.ts}
modules/platform/infrastructure/evaluate-alerts/{repository.ts,logger.ts}
modules/platform/api/evaluate-alerts/{composition.ts,handlers.ts}
modules/platform/tests/evaluate-alerts/{evaluate-alerts.feature,evaluate-alerts.test.ts}
packages/contracts/platform/evaluate-alerts.ts
database/migrations/0011_M_alert-log-version-seed-rules.sql
packages/events/catalog.ts (append)
```

(`suggest-location-ranking.ts` / extra receive-inbound-only files with no counterpart here: delete
after the rename if `new-slice.sh` copied them — this use case has no ranking/suggestion step.)

Migration number: **0011**, issued by the Master, recorded in `tasks/LANE_LOCKS.md` under
"Migrations issued" once applied.

Stop-and-ask if: any table/column/rule needed and not in 01 / 13 / 13B / 019 / 40 / doc 25. (None
expected — the Master verified every referenced table/column exists in the current schema before
writing this brief.)
