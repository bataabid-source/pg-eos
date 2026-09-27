// apps/api/src/main.ts — X part 5a. Entry point (`pnpm start` = `tsx src/main.ts`).

import { childLogger } from '@pg-eos/logger';

import { DEFAULT_PORT } from './http-status.js';
import { buildServer } from './server.js';

const LISTEN_HOST = '0.0.0.0';
const PORT_MIN = 1;
const PORT_MAX = 65535;
const EXIT_FAILURE = 1;

const logger = childLogger({ app: 'api' });

/** PORT unset → DEFAULT_PORT; otherwise an integer in [PORT_MIN, PORT_MAX] (an empty string, which
 *  Number() turns into 0, is refused). undefined = invalid. */
function portFrom(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_PORT;
  if (raw.trim() === '') return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX ? port : undefined;
}

const port = portFrom(process.env['PORT']);

if (port === undefined) {
  logger.fatal({ port: process.env['PORT'], min: PORT_MIN, max: PORT_MAX }, 'api: PORT is not a valid port');
  process.exit(EXIT_FAILURE);
}

const app = buildServer();

try {
  await app.listen({ port, host: LISTEN_HOST });
} catch (error) {
  logger.fatal({ err: error }, 'api: startup failed');
  process.exit(EXIT_FAILURE);
}
