# tests/isolation/system-actor-rls.feature — WBS 4.3 part 1a (pg-tester).
#
# Source: docs/notes/slice-briefs/_slice-4.3-p1a-system-actor.brief.md — GM directive D-212
# (SCR-BILLING-SYSTEM-ACTOR-01): one system-actor row in identity.users, user_type 'internal',
# user_entities for every platform.entities row, and a database-level binding that lets the
# identity operate only under the pgeos_worker role. Delivered by
# database/migrations/0048_M_system-actor-identity.sql (does not exist yet — this file and
# tests/system-actor-rls.test.ts are written BEFORE it, per CLAUDE.md · BUILD METHOD).

Feature: 4.3 part 1a — the system actor identity works only under pgeos_worker (D-212)
  Scenario: the system actor row exists once, internal, active, with no session and a user_entities row for every entity
  Scenario: under pgeos_worker the system actor sees every entity (allowed_entities = all platform.entities) and an active entity narrows it (app.entity_id)
  Scenario: under pgeos_app the same GUCs resolve to no entities and an entity-scoped read returns zero rows
  Scenario: under pgeos_app an audit_log insert as the system actor is refused with 42501, under pgeos_worker audit_append admits it (actor_type system)
  Scenario: platform.system_actor_id, platform.system_actor_permitted and platform.allowed_entities are SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp
  Scenario: under pgeos_app the system actor cannot insert an idempotency key with a null entity, an ordinary user can
  Scenario: the audit_append policy requires actor_type system for the system actor's rows
  Scenario: under pgeos_app set role pgeos_worker is refused with 42501 and an active member entity still resolves to no entities for the system id
  Scenario: applying the migration twice changes nothing (idempotent) and keeps the binding on audit_append (parent only), allowed_entities and idem_own
  Scenario: pgeos_worker holds exactly the ruled minimum grants and nothing more, still without BYPASSRLS
  Scenario: under pgeos_worker the system actor can read wms.outbound_orders and catalog.services, insert a billing.billable_events row, an audit_log row with actor_type system and an outbox row inside its entity scope, and a row outside the scope is refused
