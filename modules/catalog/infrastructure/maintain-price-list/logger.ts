// modules/catalog/infrastructure/maintain-price-list/logger.ts — WBS 1.2, M03 catalog.
//
// infrastructure/ layer: implements ../../application/maintain-price-list/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/maintain-price-list/composition.ts as
// the default `logger` in MaintainPriceListDeps; a caller (tests) may inject a fixed/spy Logger
// instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/maintain-price-list/ports.js';

const child = childLogger({ module: 'catalog', useCase: 'maintain-price-list' });

export const priceListPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
