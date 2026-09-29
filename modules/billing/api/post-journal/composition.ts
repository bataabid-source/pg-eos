// modules/billing/api/post-journal/composition.ts — WBS 4.20 (lane 2).
//
// Composition root for the post-journal use case: the ONE place the real infrastructure adapters
// are wired to the application ports (golden slice: modules/wms/api/receive-inbound/composition.ts).
// The application layer programs only against ports; the api layer (./handlers.ts), the apps/api
// host and tests build their deps here.

import type { Clock } from '@pg-eos/domain-kit';

import type { Logger, PostJournalDeps } from '../../application/post-journal/ports.js';
import { journalLedgerPort } from '../../infrastructure/post-journal/ledger.js';
import { postJournalPinoLogger } from '../../infrastructure/post-journal/logger.js';
import { createJournalRepository } from '../../infrastructure/post-journal/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/post-journal/logger.ts) — a caller
 *  (tests) may inject a fixed/spy Logger instead, same pattern as `clock`. */
export function createPostJournalDeps(clockDeps: { readonly clock: Clock; readonly logger?: Logger }): PostJournalDeps {
  return {
    clock: clockDeps.clock,
    repo: createJournalRepository(),
    ledger: journalLedgerPort,
    logger: clockDeps.logger ?? postJournalPinoLogger,
  };
}
