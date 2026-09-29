// modules/billing/infrastructure/post-journal/logger.ts — WBS 4.20 (lane 2).
//
// infrastructure/ layer: implements ../../application/post-journal/ports.ts's `Logger` port as a
// thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/post-journal/composition.ts as the
// default `logger`; a caller (tests) may inject a fixed/spy Logger instead (golden slice:
// modules/wms/infrastructure/receive-inbound/logger.ts).

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/post-journal/ports.js';

export const postJournalPinoLogger: Logger = portLogger({ module: 'billing', useCase: 'post-journal' });
