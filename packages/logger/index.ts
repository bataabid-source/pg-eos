// packages/logger/index.ts — WBS 2.9 (golden slice): the shared logger package.
//
// A single, workspace-wide pino instance (`rootLogger`) plus `childLogger(bindings)` — every
// module gets a bound child logger instead of constructing its own root pino instance. CLAUDE.md
// · AGENT CONSTRAINTS: "No console.log — pino." This package is the ONE place pino itself is
// imported and instantiated; a module's own infrastructure/ adapter (e.g.
// modules/wms/infrastructure/receive-inbound/logger.ts) is a thin `childLogger({...})` call, never
// its own `pino({...})`.

import pino from 'pino';

const LOGGER_NAME = 'pg-eos';

export const rootLogger = pino({ name: LOGGER_NAME });

/** A child logger with `bindings` merged into every log line it writes — the pattern every
 *  module's own infrastructure/ logger adapter uses instead of instantiating pino itself. */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return rootLogger.child(bindings);
}
