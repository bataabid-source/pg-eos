// modules/wms/infrastructure/process-outbound/logger.ts — WBS 2.11 part 1, following
// ../../infrastructure/receive-inbound/logger.ts (golden slice).
//
// infrastructure/ layer: implements ../../application/process-outbound/ports.ts's `Logger` port
// as a thin adapter over @pg-eos/logger's portLogger — CLAUDE.md · AGENT CONSTRAINTS: "No
// console.log — pino." Wired by ../../api/process-outbound/composition.ts as the default `logger`
// in ProcessOutboundDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/process-outbound/ports.js';

export const processOutboundPinoLogger: Logger = portLogger({ module: 'wms', useCase: 'process-outbound' });
