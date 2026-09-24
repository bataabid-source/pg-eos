// modules/wms/infrastructure/receive-inbound/logger.ts — WBS 2.9, THE GOLDEN SLICE.
//
// infrastructure/ layer: implements ../../application/receive-inbound/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." REPLACE-ON-COPY: a later slice's copy passes its own
// module/useCase bindings to childLogger; it never constructs its own root pino instance
// (@pg-eos/logger is the one place that happens). Wired by
// ../../api/receive-inbound/composition.ts as the default `logger` in ReceiveInboundDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/receive-inbound/ports.js';

// REPLACE-ON-COPY: this use case's own logger bindings.
const child = childLogger({ module: 'wms', useCase: 'receive-inbound' });

export const inboundPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
