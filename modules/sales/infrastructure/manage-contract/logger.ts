// modules/sales/infrastructure/manage-contract/logger.ts — WBS 1.7, M02 sales.
//
// infrastructure/ layer: implements ../../application/manage-contract/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/manage-contract/composition.ts as the
// default `logger` in ManageContractDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/manage-contract/ports.js';

export const manageContractPinoLogger: Logger = portLogger({ module: 'sales', useCase: 'manage-contract' });
