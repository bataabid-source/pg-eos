// packages/db/index.ts — WBS 0.11 (review round 2, finding 4).
//
// Barrel: `withContext`, the only sanctioned way to run a query (CLAUDE.md · ARCHITECTURE), plus
// the raw `db` handle it wraps — exported so the lint rule
// (eslint-rules/no-db-outside-with-context.js) has a tracked `db` binding to guard against direct
// use outside a withContext(...) callback.
//
// `pool` is deliberately NOT re-exported here. Nothing outside this package needs raw pool
// access, and exporting it from the public barrel would defeat the whole point of the lint rule
// above (which only ever tracks `db`, never `pool`) — a caller could otherwise
// `import { pool } from '@pg-eos/db'; pool.query(...)` and bypass RLS with zero lint coverage.
// `pool` stays a named export of src/client.ts for module-internal use (with-context.ts) and for
// tests that need to reach it directly (`import { pool } from '../src/client.js'`), just never
// through this barrel.

export type { WithContextCtx } from './src/with-context.js';
export { withContext } from './src/with-context.js';
export { db } from './src/client.js';
export type { IdempotencyInput, JsonValue } from './src/idempotency.js';
export { IdempotencyConflictError, withIdempotentContext } from './src/idempotency.js';
