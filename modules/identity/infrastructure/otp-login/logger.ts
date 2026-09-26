// modules/identity/infrastructure/otp-login/logger.ts — WBS 2.16 part 1a-3.
//
// infrastructure/ layer: implements ../../application/otp-login/ports.ts's `Logger` port as a thin
// adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT CONSTRAINTS:
// "No console.log — pino." Same shape as modules/wms/infrastructure/receive-inbound/logger.ts; it
// never constructs its own root pino instance (@pg-eos/logger is the one place that happens).
// Wired by ../../api/otp-login/composition.ts as the default `logger` in OtpLoginDeps; a caller
// (tests) may inject a spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/otp-login/ports.js';

const child = childLogger({ module: 'identity', useCase: 'otp-login' });

export const otpLoginPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
