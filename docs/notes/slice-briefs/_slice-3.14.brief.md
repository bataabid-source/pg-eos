Task: 3.14 iMile station agent — pull loop (part 2, doc 38 acceptance "Pull every 10 min; stop > 15 min alerts")
Lane: 3          Lock: imile
Read ONLY:
  - CLAUDE.md
  - .claude/briefs/imile.brief.md
  - modules/imile/application/report-agent-health/{ports.ts,report-agent-health.ts} (command + port shape, this module's own part-1 precedent)
  - modules/imile/domain/report-agent-health/{errors.ts,invariants.ts} (domain style precedent)
  - modules/imile/infrastructure/report-agent-health/repository.ts (withContext/Drizzle repository pattern, incl. its own writeAuditRow/hash-chain call — the handlers file is dropped from this list to make room, round 3; Idempotency-Key pattern already proven in round-1 tests)
  - docs/package/40-Build-Specification-EN.md lines 352-397 (§C8, M11 iMile Operations)
  - database/schema/01-Data-Model.sql lines 1315-1339 (imile.shipments), 1426-1436 (imile.agent_health)
  - docs/notes/2026-09-24-imile-agent-scenario.md (D-147/D-148/D-149; §4 rows d/e/f gaps filed with 3.14; §7 D-149 external check not yet done — live portal capabilities stay unconfirmed)
  - database/migrations/0004_M_audit-chain-seq.sql (audit hash-chain trigger definition)
  - database/schema/13B-Schema-Reference-Consolidation.sql lines 178-260 (platform.audit_log shape, changed_fields column)

(scaffold via the module's own new-slice scaffolding script, invoked as "imile pull-shipments" — the barrel, composition and logger files and the golden-slice tree shape come from that script, not from re-reading golden-slice files; the CHANGELOG's "3.14 part 1" scope and round-1 rejection of the invented single-session rule are already summarized above and in Deliver below — not re-read.)
Write ONLY: modules/imile/{domain,application,infrastructure,api,tests}/pull-shipments/** · packages/contracts/imile/pull-shipments.ts · modules/imile/index.ts (module barrel — additive named export for pull-shipments, same precedent as modules/wms/index.ts's 2.13 export; whole-module `imile` lock covers this) · tests/…
Scenario:
```gherkin
Feature: Station agent pulls shipments from the iMile portal every 10 minutes

  Scenario: A shipment appears on the portal for the first time
    Given the iMile portal reports a shipment with tracking number "SHP-1001" not yet known locally
    When the station agent runs a pull cycle
    Then a new imile.shipments row is inserted for "SHP-1001" with internal_status "expected"
    And its iMile-sourced fields (merchant, zone_code, area, recipient_phone, is_cod, cod_amount, imile_status, raw) match the portal payload
    And imile.agent_health records a successful pull with last_pull_at set to the pull time

  Scenario: A shipment already known locally has changed iMile-side status
    Given a shipment "SHP-1002" already exists locally with imile_status "created"
    And the iMile portal now reports "SHP-1002" with imile_status "picked_up"
    When the station agent runs a pull cycle
    Then the local row for "SHP-1002" is updated to imile_status "picked_up" with a bumped version
    And its internal_status, cage_code, driver_code and delivery_task_id are left untouched — those columns belong to other use cases, never to the pull loop

  Scenario: The portal is unreachable
    Given the iMile portal adapter raises a connection error
    When the station agent runs a pull cycle
    Then no imile.shipments row is written
    And imile.agent_health records the failed pull with session_valid false and the error_message set
    And the pull cycle command does not throw past its boundary — it returns a result the caller logs

  Scenario: An empty portal response is not an error
    Given the iMile portal reports zero shipments for this pull
    When the station agent runs a pull cycle
    Then imile.agent_health records a successful pull with zero shipments touched
    And no imile.shipments row is written or changed

  Scenario: A malformed portal record is skipped, not fatal
    Given the iMile portal reports one valid shipment and one record missing a tracking number
    When the station agent runs a pull cycle
    Then the valid shipment is written
    And the malformed record is skipped and counted, with the pull cycle still reporting success

  Scenario: Two concurrent pull cycles racing on the same shipment
    Given a shipment "SHP-1003" already exists locally at version 1
    And two pull cycles both read "SHP-1003" from the portal before either writes
    When both pull cycles attempt to update "SHP-1003"
    Then the first update succeeds and bumps the version to 2
    And the second update using the stale version 1 fails with a StaleVersionError, not a silent overwrite
```
Contract: packages/contracts/imile/pull-shipments.ts — one command `PullShipments`, input `{ correlationId: uuid }` (no caller-supplied shipment data — the port is the only data source, same separation `EvaluateAlertRules` uses for its job body in packages/contracts/platform/evaluate-alerts.ts); result schema `PullShipmentsResult { inserted: number, updated: number, skipped: number, unchanged: number }`. Derive shipment field shapes from `imile.shipments` (tracking_no, station_code, merchant, zone_code, area, recipient_phone, is_cod, cod_amount, is_fresh, imile_status, raw) — never invent a field not in that table.
Screen/Board spec: none (internal job/service, no UI this slice)
Deliver (mirrors report-agent-health's own file set, part 1's nearest counterpart in this module):
  - modules/imile/domain/pull-shipments/{errors.ts,invariants.ts}
  - modules/imile/application/pull-shipments/{index.ts,ports.ts,pull-shipments.ts}
  - modules/imile/infrastructure/pull-shipments/{repository.ts,logger.ts,portal-adapter.ts}
  - modules/imile/api/pull-shipments/{composition.ts,handlers.ts}
  - modules/imile/tests/pull-shipments/{pull-shipments.feature,pull-shipments.test.ts,invariants.property.test.ts,handlers.test.ts}
  - packages/contracts/imile/pull-shipments.ts
`portal-adapter.ts` implements the `ImilePortalPort` two ways: a `FakeImilePortalAdapter` (used by every test — the only adapter this slice can prove) and a `NotConfiguredImilePortalAdapter` (the production wiring default — throws `PortalNotConfiguredError` with a message pointing at the D-149 external check; this is a deliberate stub, not a placeholder pretending to work: the real Node+Playwright browser automation against the live iMile portal is out of scope for this slice — it is gated on the DEL_MGR+SYSADMIN capability check named in docs/notes/2026-09-24-imile-agent-scenario.md §7, which has not happened yet, and building it now would mean inventing untested integration behavior against a system whose exact capabilities are still unconfirmed). File this as a G-01/infra follow-up in CHANGELOG, same class as the part-1 gaps (e), (f).
No "single session" domain rule — doc 40's "single session (any other login drops it)" describes iMile's own session behavior on the station account, not a rule our domain enforces; part-1 round 1 already rejected an invented cross-account exclusivity rule for the same reason (D-148/D-149: multiple simultaneous agent sessions, one per account, are legitimate).
Migration number: requested in tasks/backlog/MIGRATION-REQUEST-3.md row 1 (`imile.shipments.version`) — **0024, issued by the Master (commit `3eb4465`), pre-migration pg-reviewer APPROVED WITH CHANGES, applied.**
Write ONLY also covers: `packages/contracts/package.json` (new-slice.sh's automatic export-registration snippet only, run verbatim — sanctioned Master-tier mechanism, same as 3.14 part 1 and WBS 2.15, not a hand-edit) and `docs/notes/2026-09-24-imile-agent-scenario.md` (G-01 rows g/h — Master-authored only, per pg-scribe's usual CHANGELOG/notes bookkeeping role, never a builder edit).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40.
