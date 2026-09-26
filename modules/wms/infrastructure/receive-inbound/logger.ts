// modules/wms/infrastructure/receive-inbound/logger.ts — WBS 2.9, THE GOLDEN SLICE.
//
// infrastructure/ layer: implements ../../application/receive-inbound/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." REPLACE-ON-COPY: a later slice's copy passes its own
// module/useCase bindings to portLogger; it never constructs its own root pino instance
// (@pg-eos/logger is the one place that happens). Wired by
// ../../api/receive-inbound/composition.ts as the default `logger` in ReceiveInboundDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/receive-inbound/ports.js';

export const inboundPinoLogger: Logger = portLogger({ module: 'wms', useCase: 'receive-inbound' });
