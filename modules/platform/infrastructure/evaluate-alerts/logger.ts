// modules/platform/infrastructure/evaluate-alerts/logger.ts — WBS 5.13 part 1, replicated from
// the golden slice's logger.ts (modules/wms/infrastructure/receive-inbound/logger.ts).
//
// infrastructure/ layer: implements ../../application/evaluate-alerts/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/evaluate-alerts/composition.ts as the
// default `logger` in EvaluateAlertsDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/evaluate-alerts/ports.js';

const child = childLogger({ module: 'platform', useCase: 'evaluate-alerts' });

export const alertsPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
  warn(obj, msg) {
    child.warn(obj, msg);
  },
};
