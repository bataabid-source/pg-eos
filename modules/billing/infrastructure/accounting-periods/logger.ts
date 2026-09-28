// modules/billing/infrastructure/accounting-periods/logger.ts — WBS 4.19 (lane 2).
//
// infrastructure/ layer: implements ../../application/accounting-periods/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/accounting-periods/composition.ts as the
// default `logger`; a caller (tests) may inject a fixed/spy Logger instead (golden slice:
// modules/wms/infrastructure/receive-inbound/logger.ts).

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/accounting-periods/ports.js';

export const accountingPeriodsPinoLogger: Logger = portLogger({ module: 'billing', useCase: 'accounting-periods' });
