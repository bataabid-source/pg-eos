// modules/hr/infrastructure/register-employee/logger.ts — WBS 3.3.
//
// infrastructure/ layer: implements ../../application/register-employee/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Shape copied from the golden slice's own logger.ts
// (modules/wms/infrastructure/receive-inbound/logger.ts). Wired by
// ../../api/register-employee/composition.ts as the default `logger` in RegisterEmployeeDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/register-employee/ports.js';

const child = childLogger({ module: 'hr', useCase: 'register-employee' });

export const registerEmployeePinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
