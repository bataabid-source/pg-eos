// modules/billing/application/record-billable-event/ports.ts — WBS 4.3 part 1 (lane 2).
//
// application/ layer: the ports the record-billable-event subscribers program against (golden
// slice: modules/wms/application/receive-inbound/ports.ts). Every handler takes ONE
// `deps: RecordBillableEventDeps` and never imports infrastructure/.
// ../../infrastructure/record-billable-event/repository.ts implements `BillableEventRepository`
// (the 4.2 port plus its 4.3 lookups); ../../api/record-billable-event/composition.ts wires it and
// provides the `SystemActorPort`.

import type { WithContextCtx } from '@pg-eos/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/record-billable-event/logger.ts. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** The source row's own entity / client / contract as the caller's tx sees it under RLS. */
export interface BillableSource {
  readonly entityId: string;
  readonly clientId: string | null;
  readonly contractId: string | null;
}

/** An active `catalog.services` row: the id to bill and its own `uom`. */
export interface BillableServiceRow {
  readonly id: string;
  readonly code: string;
  readonly uom: string;
}

/** What one billable-event insert needs (mirrors the 4.2 port's `InsertBillableEventParams`). */
export interface BillableEventInsert {
  readonly occurredAt: string;
  readonly clientId: string;
  readonly contractId: string | null;
  readonly serviceId: string;
  readonly qty: string;
  readonly uom: string;
  readonly sourceModule: string;
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly correlationId: string;
  readonly actorId: string | null;
}

/** The billing repository port — every call runs inside the ONE tx the handler's withContext
 *  opened. `insert` writes the billable row + its outbox + audit rows (4.2 port). */
export interface BillableEventRepository {
  resolveSource(tx: NodePgDatabase, sourceTable: string, sourceId: string): Promise<BillableSource | null>;
  findBilledServiceIds(tx: NodePgDatabase, sourceTable: string, sourceId: string): Promise<readonly string[]>;
  findActiveServicesByCode(tx: NodePgDatabase, codes: readonly string[]): Promise<readonly BillableServiceRow[]>;
  insert(tx: NodePgDatabase, params: BillableEventInsert): Promise<{ readonly id: string; readonly status: string }>;
}

/** THE single seam for the identity a system-actor subscriber runs as (Master review default).
 *  The composition returns `{ userId: SYSTEM_ACTOR_USER_ID, clientId: null, isInternal: true,
 *  entityId }` — the D-212 / 0048 system actor (platform.system_actor_id()), pgeos_worker only. */
export interface SystemActorPort {
  contextFor(entityId: string): WithContextCtx;
  /** The `actor_id` / audit `user_id` the subscriber records — the system actor id, equal to
   *  contextFor's userId (audit actor_type 'system'). */
  readonly actorId: string | null;
}

/** Everything a subscriber handler needs, injected by ../../api/record-billable-event/composition.ts. */
export interface RecordBillableEventDeps {
  readonly repo: BillableEventRepository;
  readonly systemActor: SystemActorPort;
  readonly logger: Logger;
}
