// modules/imile/infrastructure/report-agent-health/logger.ts — WBS 3.14.
//
// infrastructure/ layer: implements ../../application/report-agent-health/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by
// ../../api/report-agent-health/composition.ts as the default `logger` in ReportAgentHealthDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/report-agent-health/ports.js';

const child = childLogger({ module: 'imile', useCase: 'report-agent-health' });

export const agentHealthPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
