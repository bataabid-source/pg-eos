// modules/wms/api/receive-inbound/composition.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Composition root for the receive-inbound use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.
//
// TEMPLATE GUIDANCE: a copied slice keeps this file as-is apart from the names the rename
// changes — its own repository and ledger adapters are the only things it wires.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ReceiveInboundDeps } from '../../application/receive-inbound/ports.js';
import { inboundLedgerPort } from '../../infrastructure/receive-inbound/ledger.js';
import { inboundPinoLogger } from '../../infrastructure/receive-inbound/logger.js';
import { inboundOrderRepository } from '../../infrastructure/receive-inbound/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/receive-inbound/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createReceiveInboundDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ReceiveInboundDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: inboundOrderRepository,
    ledger: inboundLedgerPort,
    logger: clockDeps.logger ?? inboundPinoLogger,
  };
}
