# modules/imile/tests/pull-shipments/pull-shipments.feature — WBS 3.14 (part 2).
# Every scenario below is executed by modules/imile/tests/pull-shipments/pull-shipments.test.ts.
# Source: docs/notes/slice-briefs/_slice-3.14.brief.md "Scenario" block (verbatim);
# docs/package/40-Build-Specification-EN.md lines 352-397 (§C8, M11 iMile Operations — station
# agent pulls every 10 min); database/schema/01-Data-Model.sql:1315-1339 (imile.shipments),
# 1426-1436 (imile.agent_health). `imile.shipments.version` (optimistic lock) is migration 0024
# (tasks/backlog/MIGRATION-REQUEST-3.md row 1, issued as commit 3eb4465, applied). Every scenario
# below is exercised against the real, migrated schema.

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
