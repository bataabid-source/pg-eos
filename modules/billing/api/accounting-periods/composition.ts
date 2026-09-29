// modules/billing/api/accounting-periods/composition.ts — WBS 4.19 (lane 2).
//
// Composition root for the accounting-periods use case: the ONE place the real infrastructure
// adapters are wired to the application ports (golden slice:
// modules/wms/api/receive-inbound/composition.ts). The application layer programs only against
// ports; the api layer (./handlers.ts), the apps/api host and tests build their deps here.

import type { Clock } from '@pg-eos/domain-kit';

import type { AccountingPeriodsDeps, Logger } from '../../application/accounting-periods/ports.js';
import { accountingPeriodsPinoLogger } from '../../infrastructure/accounting-periods/logger.js';
import {
  createAccountingPeriodRepository,
  loadReopenDecisionTitleAr,
} from '../../infrastructure/accounting-periods/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/accounting-periods/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`. The Arabic
 *  reopen-decision title is loaded HERE, eagerly: the apps/api host builds these deps once at boot,
 *  so a missing packages/i18n/ar/billing.json key fails startup (ReopenDecisionTitleMissingError),
 *  never a request. */
export function createAccountingPeriodsDeps(clockDeps: {
  readonly clock: Clock;
  readonly logger?: Logger;
}): AccountingPeriodsDeps {
  return {
    clock: clockDeps.clock,
    repo: createAccountingPeriodRepository(loadReopenDecisionTitleAr()),
    logger: clockDeps.logger ?? accountingPeriodsPinoLogger,
  };
}
