// apps/worker/src/main.ts — X part 5b. Entry point (`pnpm start` = `tsx src/main.ts`): the outbox
// relay worker as a separate process under the service role pgeos_worker (ADR-0006 §1).
// Order: role by name → interval → pool (user set explicitly, never the PGUSER default) → role by
// pg_roles → production subscribers → loop. SIGTERM/SIGINT: abort, await the in-flight tick,
// pool.end(), exit 0. Any startup failure: fatal + EXIT_FAILURE.

import { childLogger } from '@pg-eos/logger';
import { Pool } from 'pg';

import { resolveIntervalMs } from './interval.js';
import { runRelayLoop } from './loop.js';
import { WORKER_ROLE, assertConnectedRole, assertWorkerRole } from './role.js';
import { registerProductionSubscribers } from './subscribers.js';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
// relayOnce is sequential and single-caller: one connection is all the worker ever uses.
const POOL_MAX = 1;

const logger = childLogger({ app: 'worker' });

function fail(error: unknown, msg: string): never {
  logger.fatal({ err: error, requiredRole: WORKER_ROLE }, msg);
  process.exit(EXIT_FAILURE);
}

try {
  assertWorkerRole(process.env);
} catch (error) {
  fail(error, `worker: refused to start — the required role is ${WORKER_ROLE}`);
}

const intervalMs = resolveIntervalMs(process.env);
if (intervalMs === undefined) {
  logger.fatal(
    { relayIntervalSeconds: process.env['RELAY_INTERVAL_SECONDS'] },
    'worker: RELAY_INTERVAL_SECONDS must be a finite number > 0',
  );
  process.exit(EXIT_FAILURE);
}

const pool = new Pool({ user: WORKER_ROLE, max: POOL_MAX });
pool.on('error', (error) => {
  logger.error({ err: error }, 'worker: idle pool client error');
});

try {
  await assertConnectedRole(pool);
} catch (error) {
  await pool.end().catch(() => undefined);
  fail(error, `worker: refused to start — the required role is ${WORKER_ROLE}`);
}

const subscriberCount = registerProductionSubscribers();
logger.info({ subscriberCount, intervalMs }, 'worker: relay loop starting');

const controller = new AbortController();
const stop = (signalName: NodeJS.Signals): void => {
  logger.info({ signal: signalName }, 'worker: stopping after the in-flight tick');
  controller.abort();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

await runRelayLoop({ pool, intervalMs, logger, signal: controller.signal });
await pool.end();
logger.info({}, 'worker: stopped');
process.exit(EXIT_SUCCESS);
