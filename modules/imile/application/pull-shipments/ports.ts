// modules/imile/application/pull-shipments/ports.ts — WBS 3.14 (part 2).
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: PullShipmentsDeps` (clock, ids, portal, repo, logger) and never imports infrastructure/.
// ../../infrastructure/pull-shipments/{repository,portal-adapter}.ts implement these;
// ../../api/pull-shipments/composition.ts wires them.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its
// own aggregate — do not import this file from another use case.
//
// `InsertAgentHealthParams`/`InsertedAgentHealthRow` below are declared LOCALLY, not imported
// from ../report-agent-health/ports.ts, even though the shape happens to match (brief: "writes
// one imile.agent_health row via the same repository pattern as report-agent-health part 1") —
// report-agent-health/ports.ts's own header says "do not import this file from another use case"
// and this module's own repository.ts already avoids the same cross-import for exactly this
// reason (reviewer finding 8, 2026-09-25).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PortalShipmentRecord } from '../../domain/pull-shipments/invariants.js';

export {
  IMILE_SOURCED_FIELD_KEYS,
  IS_FRESH_DEFAULT,
  iMileChangedFieldKeys,
  type IMileSourcedFieldKey,
  type IMileSourcedFields,
} from '../../domain/pull-shipments/invariants.js';
export type { PortalShipmentRecord };

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/pull-shipments/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** The ONLY data source for shipment fields (brief, Contract line) — the injected port over the
 *  iMile portal. `fetchShipments` returns raw, untrusted records (`unknown[]`): the application
 *  layer validates each one via ../../domain/pull-shipments/invariants.ts's
 *  `validatePortalRecord` before ever touching the database. Implemented by
 *  ../../infrastructure/pull-shipments/portal-adapter.ts (`FakeImilePortalAdapter` for every
 *  test, `NotConfiguredImilePortalAdapter` as the production wiring default). A connection/
 *  session failure is surfaced as a thrown `PortalUnreachableError`
 *  (../../domain/pull-shipments/errors.ts). */
export interface ImilePortalPort {
  fetchShipments(): Promise<readonly unknown[]>;
}

/** The existing `imile.shipments` row this use case is allowed to see/compare against — the
 *  iMile-sourced columns plus the identity/lock columns it needs (`id`, `version`). Never carries
 *  internal_status/cage_code/driver_code/delivery_task_id — this use case never reads or writes
 *  those (brief, Contract line). `raw`/`lastSyncAt` are the pre-update values of the two columns
 *  `updateShipmentIMileFields` writes on every call it makes — and it is only ever called when
 *  `iMileChangedFieldKeys` found a real iMile-sourced field difference (`pullShipments` never
 *  calls it otherwise) — carried here so the update's before/after audit row can compare them
 *  too and include only the ones whose VALUES actually changed (reviewer finding 3 round 2 +
 *  finding 2 round 3, 2026-09-25). */
export interface ExistingShipmentRow {
  readonly id: string;
  readonly version: number;
  readonly merchant: string | null;
  readonly zoneCode: string | null;
  readonly area: string | null;
  readonly recipientPhone: string | null;
  readonly isCod: boolean | null;
  readonly codAmount: string | null;
  readonly isFresh: boolean | null;
  readonly imileStatus: string | null;
  readonly raw: unknown;
  readonly lastSyncAt: Date | null;
}

export interface InsertShipmentParams {
  readonly trackingNo: string;
  readonly merchant: string | null;
  readonly zoneCode: string | null;
  readonly area: string | null;
  readonly recipientPhone: string | null;
  readonly isCod: boolean | null;
  readonly codAmount: string | null;
  readonly isFresh: boolean;
  readonly imileStatus: string | null;
  readonly raw: unknown;
  readonly lastSyncAt: Date;
}

export interface UpdateShipmentIMileFieldsParams {
  readonly id: string;
  readonly expectedVersion: number;
  readonly merchant: string | null;
  readonly zoneCode: string | null;
  readonly area: string | null;
  readonly recipientPhone: string | null;
  readonly isCod: boolean | null;
  readonly codAmount: string | null;
  readonly isFresh: boolean;
  readonly imileStatus: string | null;
  readonly raw: unknown;
  readonly lastSyncAt: Date;
}

/** append-only imile.agent_health insert — declared locally (not imported from
 *  ../report-agent-health/ports.ts, reviewer finding 8). The shape matches that use case's own
 *  InsertAgentHealthParams/InsertedAgentHealthRow because both commands write the same table, but
 *  each use case owns its own copy of the type per the golden-slice "do not import this file from
 *  another use case" discipline. */
export interface InsertAgentHealthParams {
  readonly agentId: string;
  readonly sessionValid: boolean;
  readonly lastPullAt: Date | null;
  readonly pendingPushes: number;
  readonly engineVersion: string;
  readonly errorMessage: string | null;
  readonly reportedAt: Date;
}

export interface InsertedAgentHealthRow {
  readonly id: string;
  readonly reportedAt: Date;
}

/** Every DB statement the pull-shipments use case needs against `imile.shipments`, as an
 *  interface — the port the application layer programs against. Implemented by
 *  ../../infrastructure/pull-shipments/repository.ts. */
export interface ShipmentsRepository {
  findShipmentByTrackingNo(tx: NodePgDatabase, trackingNo: string): Promise<ExistingShipmentRow | null>;
  /** internal_status/station_code are NEVER passed here — they stay at their table defaults
   *  ('expected' / 'CSP04'), untouched by this use case (brief, Contract line). */
  insertShipment(tx: NodePgDatabase, params: InsertShipmentParams): Promise<{ readonly id: string }>;
  /** `WHERE id=$1 AND version=$2` (optimistic lock, migration 0024) — returns `null` when zero
   *  rows matched (another concurrent pull already advanced the version); the application layer
   *  turns that into a thrown StaleVersionError. Never touches internal_status/cage_code/
   *  driver_code/delivery_task_id. */
  updateShipmentIMileFields(
    tx: NodePgDatabase,
    params: UpdateShipmentIMileFieldsParams,
  ): Promise<{ readonly version: number } | null>;
  /** append-only INSERT into imile.agent_health — same repository pattern as
   *  ../../infrastructure/report-agent-health/repository.ts's own `insertAgentHealth` (brief). */
  insertAgentHealth(tx: NodePgDatabase, params: InsertAgentHealthParams): Promise<InsertedAgentHealthRow>;
  /** doc 40 P3/P7: one append-only platform.audit_log row per write this use case makes — same
   *  hash-chain mechanism (a DB trigger, not application code — see
   *  database/schema/13B-Schema-Reference-Consolidation.sql's trg_audit_hash_chain) as
   *  ../../infrastructure/report-agent-health/repository.ts's own `writeAuditRow`. Unlike that
   *  use case (which only ever writes imile.agent_health), this one writes to TWO tables
   *  (imile.shipments on insert/update, imile.agent_health on every pull cycle), so `schemaName`/
   *  `tableName` are parameters here rather than fixed module constants. `oldValue` is present
   *  only for an update — a genuine before/after of the columns this write's VALUES actually
   *  changed (reviewer finding 3 round 2, finding 2 round 3, 2026-09-25): the iMile-sourced
   *  fields `iMileChangedFieldKeys` found changed, PLUS `raw`/`last_sync_at` whenever THEIR
   *  values also differ (checked independently — the UPDATE statement names both columns on
   *  every call, but `changed_fields` reflects the actual diff, not which columns the SQL
   *  happened to name; see ../pull-shipments.ts's `rawChanged`/`lastSyncAtChanged`).
   *  `changedFields` is `platform.audit_log.changed_fields text[]` — the same set of keys, so the
   *  audited row is self-describing without a reader having to diff old_value/new_value itself. */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly schemaName: string;
      readonly tableName: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly oldValue?: unknown;
      readonly newValue: unknown;
      readonly changedFields?: readonly string[];
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/pull-shipments/composition.ts). The command programs only against these ports —
 *  the application layer never imports infrastructure/. */
export interface PullShipmentsDeps extends ClockDeps {
  readonly portal: ImilePortalPort;
  readonly repo: ShipmentsRepository;
  readonly logger: Logger;
  /** Test-only seam (reviewer finding 9 round 1, finding 1 round 3, 2026-09-25): when set,
   *  `pullShipments` awaits it for every matched record WHOSE iMile-sourced fields actually
   *  differ (i.e. after the `iMileChangedFieldKeys` comparison finds a real change), immediately
   *  before `repo.updateShipmentIMileFields` runs — the only way to deterministically force two
   *  concurrent `pullShipments` calls to both complete their SELECT before either does its
   *  UPDATE, without relying on connection-pool warm-up timing luck.
   *  Production wiring (../../api/pull-shipments/composition.ts) never sets this — it defaults to
   *  `undefined` and `createPullShipmentsDeps` never provides one; only a test builds a
   *  `PullShipmentsDeps` with this field set. Never changes the optimistic-lock logic itself —
   *  the `WHERE id=$1 AND version=$2` clause in ../../infrastructure/pull-shipments/repository.ts
   *  and its outcome (a thrown StaleVersionError on zero rows) are completely untouched by it. */
  readonly onBeforeUpdate?: (() => Promise<void>) | undefined;
}
