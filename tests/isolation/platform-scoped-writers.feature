Feature: D-213 step 1 — platform-scoped audit and outbox rows are written only through named definer functions
  Scenario: write_platform_audit under pgeos_app (internal) writes one audit row with entity_id null, the caller's user_id and actor_type user, for a table without entity_id
  Scenario: write_platform_audit refuses with 42501 a table that has an entity_id column, an unknown table, and a non-internal caller
  Scenario: write_platform_audit with no user in context writes actor_type system
  Scenario: write_platform_event under pgeos_app (internal) writes one outbox row with entity_id null and actor_id = the caller for a platform.* aggregate type
  Scenario: write_platform_event refuses with 42501 a business aggregate type and a non-internal caller
  Scenario: both functions are SECURITY DEFINER with search_path pinned, executable by pgeos_app and not by PUBLIC or pgeos_worker
  Scenario: both functions refuse with 42501 under pgeos_app when app.user_id is the system actor id
  Scenario: write_platform_audit refuses with 42501 a no-entity_id table that is not on the allowlist, a view, a pg_temp table, and null arguments
  Scenario: write_platform_audit writes schema, table, record_id, operation, old and new values and correlation_id as passed, and the audit hash chain fills its columns
  Scenario: applying the migration twice changes nothing
