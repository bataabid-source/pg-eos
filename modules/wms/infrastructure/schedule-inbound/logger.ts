// modules/wms/infrastructure/schedule-inbound/logger.ts — WBS 2.9b (lane 2).
//
// infrastructure/ layer: implements ../../application/schedule-inbound/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." It never constructs its own root pino instance
// (@pg-eos/logger is the one place that happens). Wired by
// ../../api/schedule-inbound/composition.ts as the default `logger` in ScheduleInboundDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/schedule-inbound/ports.js';

export const scheduleInboundPinoLogger: Logger = portLogger({ module: 'wms', useCase: 'schedule-inbound' });
