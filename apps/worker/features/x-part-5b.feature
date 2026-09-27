Feature: X part 5b — one worker drains the outbox as a service role
  Scenario: the service role is a non-superuser with the relay's privileges only
    Given migration 0039 is applied
    Then pg_roles shows pgeos_worker with rolsuper false, rolbypassrls false, rolcanlogin true
    And pg_auth_members has no row with pgeos_worker as member or as role
    And connected as pgeos_worker: select on platform.outbox and update of published_at, attempts, last_error succeed on the entity_id-SET fixture row (the row only outbox_relay_update admits)
    And update of payload (a non-granted column), insert, delete and truncate on platform.outbox fail with 42501
    And select on platform.thresholds, identity.users, wms.inbound_orders and platform.audit_log fails with 42501
    And select platform.purge_idempotency_keys() fails with 42501

  Scenario: RLS lets the worker see every pending row and nothing else changes for other roles
    Given two pending outbox rows of one fixture event_type, one with entity_id set and one with entity_id null (written as postgres)
    When pgeos_worker selects the unpublished rows of that event_type
    Then both rows are visible
    And connected as pgeos_app with no session GUCs, only the entity_id-null row of that event_type is visible (entity_scope untouched)

  Scenario: the relay loop drains rows for the registered subscribers
    Given a fresh registry (vi.resetModules) with one test subscriber and the two rows above
    When runRelayLoop is started on the pgeos_worker pool with intervalMs = TEST_INTERVAL_MS and relayOptions { eventType } and stopped after the first tick
    Then both rows (the entity_id-set one included) carry published_at and the subscriber received both events in id order
    And the tick result { processed: 2, published: 2, failed: 0 } was logged through pino

  Scenario: with no subscriber the worker is idle and says so
    Given a fresh registry with no subscriber and one pending fixture row
    When the loop runs two ticks
    Then the fixture row still has published_at null and exactly one warn line "0 subscribers registered — relay idle" was logged

  Scenario: a failing subscriber leaves its row for the next tick
    Given a subscriber that throws on the first delivery and succeeds on the second
    When two ticks run
    Then the row is published after the second tick with attempts = 1 and last_error recorded from the first

  Scenario: a failing tick does not stop the loop
    Given relayOnce is made to throw once (a stub relay injected through runRelayLoop's relay option)
    When two ticks run
    Then the error was logged with err and the second tick still ran

  Scenario: the interval is the documented one second
    When the worker resolves its interval without RELAY_INTERVAL_SECONDS
    Then the interval is RELAY_INTERVAL_SECONDS = 1 (doc 36 §3-1)
    And an override of 0, -1, "abc" or "" is refused at startup (EXIT_FAILURE)

  Scenario: startup refuses the wrong role
    When main.ts starts with PG_APP_USER=postgres, and again with PG_APP_USER=pgeos_app
    Then each exits with EXIT_FAILURE and a fatal line naming the required role pgeos_worker, before any connection
    And assertConnectedRole rejects a pool connected as postgres and accepts one connected as pgeos_worker (same it)
