// tests/scenarios/fixtures/pool.ts — enablement item 3a (Master decision 3 / Read ONLY item 3).
//
// Admin `pg.Pool` factory, same connection shape as
// modules/wms/tests/receive-inbound/handlers.test.ts:48-54 — bypasses RLS for fixture setup/teardown
// only. Every handler call under test still goes through `withContext(ctx, fn)` as `pgeos_app`
// inside the module's own composition (createReceiveInboundDeps / createProcessOutboundDeps); this
// pool is never used to call a command directly.
//
// A FACTORY, not a shared singleton: `workers: 1` (playwright.config.ts) reuses one Node process
// across BOTH spec files, which would share one module-level pool instance and its lifecycle — one
// spec file's own `afterAll` ending a shared pool would break the other spec file running
// afterwards in the same worker. Each spec file creates and ends its own pool instance instead.

import { Pool } from 'pg';

const DEFAULT_PG_PORT = 5432;
const POOL_MAX_CONNECTIONS = 10;

export function createPool(): Pool {
  return new Pool({
    host: process.env['PGHOST'] ?? 'localhost',
    port: Number(process.env['PGPORT'] ?? String(DEFAULT_PG_PORT)),
    user: process.env['PGUSER'] ?? 'postgres',
    database: process.env['PGDATABASE'] ?? 'pgeos',
    max: POOL_MAX_CONNECTIONS,
  });
}
