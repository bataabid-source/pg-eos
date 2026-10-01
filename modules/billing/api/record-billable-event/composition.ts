// modules/billing/api/record-billable-event/composition.ts — WBS 4.3 part 1 (lane 2).
//
// Composition root for the record-billable-event subscribers: the ONE place the real
// infrastructure adapters are wired to the application ports (golden slice:
// modules/wms/api/receive-inbound/composition.ts), and the ONE place the system actor's identity
// is decided.
//
// PRODUCTION POOL: the handler's withContext uses @pg-eos/db's shared pool, whose login role is
// PG_APP_USER. In apps/worker that role is pgeos_worker — the only role 0048 lets act as the system
// actor (session_user binding). packages/db and apps/worker are not this lane's files; running this
// subscriber under pgeos_app (the API role) is refused by the database, fail-closed.

import type { WithContextCtx } from '@pg-eos/db';

import type { Logger, RecordBillableEventDeps, SystemActorPort } from '../../application/record-billable-event/ports.js';
import { recordBillableEventPinoLogger } from '../../infrastructure/record-billable-event/logger.js';
import {
  findActiveServicesByCode,
  findBilledServiceIds,
  insertBillableEvent,
  resolveBillableSource,
} from '../../infrastructure/record-billable-event/repository.js';

/** The system actor's identity.users id — D-212 (GM 2026-09-30) / migration 0048. The DB function
 *  `platform.system_actor_id()` is the source of truth; this constant mirrors it (nil uuid). It is
 *  usable ONLY when the login role is pgeos_worker (0048 `platform.system_actor_permitted()`): under
 *  any other role allowed_entities() is empty and every write is refused with 42501. */
export const SYSTEM_ACTOR_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Precedent: modules/platform/application/evaluate-alerts/evaluate-alert-rules.ts — internal,
 *  no client, scoped to the event's entity. */
export const systemActor: SystemActorPort = {
  actorId: SYSTEM_ACTOR_USER_ID,
  contextFor(entityId: string): WithContextCtx {
    return { userId: SYSTEM_ACTOR_USER_ID, clientId: null, isInternal: true, entityId };
  },
};

/** `logger` / `systemActor` default to the real adapters — a caller (tests) may inject its own. */
export function createRecordBillableEventDeps(overrides?: {
  readonly logger?: Logger;
  readonly systemActor?: SystemActorPort;
}): RecordBillableEventDeps {
  return {
    repo: {
      resolveSource: resolveBillableSource,
      findBilledServiceIds,
      findActiveServicesByCode,
      insert: (tx, params) => insertBillableEvent(tx, params),
    },
    systemActor: overrides?.systemActor ?? systemActor,
    logger: overrides?.logger ?? recordBillableEventPinoLogger,
  };
}
