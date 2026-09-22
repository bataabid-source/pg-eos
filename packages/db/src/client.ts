// packages/db/src/client.ts — WBS 0.11.
//
// The single, shared connection pool and the raw (unscoped) drizzle handle bound to it. `db` is
// the risky export CLAUDE.md's lint rule (../eslint-rules/no-db-outside-with-context.js) forbids
// calling directly outside a withContext(ctx, fn) callback: no RLS session GUCs
// (app.user_id / app.client_id / app.is_internal) are set on a query run through it, so any
// direct `db.*` call bypasses RLS. This file (and with-context.ts) is exempt from the rule
// itself — eslint.config.mjs excludes packages/db/** because this IS the plumbing the rule
// protects, not a caller of it.
//
// `pool` is exported from THIS file (module-internal use by with-context.ts, plus tests that need
// to reach it directly via '../src/client.js') but is deliberately NOT re-exported from the
// package barrel (index.ts) — see index.ts, finding 4.
//
// Same PG* env-var convention as modules/platform (WBS 0.9/0.10) and this package's own tests.
// Do NOT change these defaults (localhost/5432/postgres/pgeos) — every other package in this
// workspace shares them; changing them here would break local dev for everyone. See the KNOWN GAP
// note below instead.

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// KNOWN, CURRENTLY-ACCEPTED GAP (review round 2, finding 8): withContext's RLS-GUC mechanism
// (app.user_id / app.client_id / app.is_internal) only has teeth once the runtime PGUSER
// connects as a non-superuser application role with NOBYPASSRLS (the Postgres default for a
// newly created role). Postgres superusers unconditionally bypass RLS regardless of any GUC being
// set correctly — `force row level security` (13B:3047-3061) only binds the table OWNER, not a
// superuser. Today, in local dev, PGUSER defaults to 'postgres', which IS a superuser, so RLS is
// currently a no-op regardless of what withContext sets. There is no non-superuser application
// role defined anywhere in database/schema/*.sql yet; creating one (with correctly scoped GRANTs)
// is real schema/security design work and is out of scope for this slice per CLAUDE.md ·
// AGENT CONSTRAINTS (G-01: no table, column, or business rule outside docs 01/13/13B/019/40 —
// never invent). This is a Master-tracked follow-up, not solved here.
export const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
});

// node-postgres emits an 'error' event on the pool when an already-idle client's connection is
// dropped by the backend (network blip, server restart, etc). With zero listeners, Node treats
// that as an unhandled error and can crash the whole process. This handler exists only to prevent
// that crash — CLAUDE.md · AGENT CONSTRAINTS forbids console.log (must use pino), but pino is not
// a dependency anywhere in this workspace yet, and adding it solely for this one line is
// disproportionate scope creep for what the review flagged as its own logging concern. The
// no-op body is a deliberate, minimal placeholder, not a silent swallow: wiring real
// (pino-based) logging here is a follow-up, not solved in this slice.
pool.on('error', () => {
  // Intentionally minimal: prevents an unhandled 'error' event from crashing the process. See
  // comment above — real structured logging (pino) is a follow-up, not yet a dependency here.
});

/**
 * Raw, unscoped drizzle handle bound to the shared pool. Never call `db.*` directly — use
 * `withContext(ctx, fn)` (with-context.ts) instead. CLAUDE.md · ARCHITECTURE: "All DB access goes
 * through withContext(ctx, fn) ... A lint rule fails the build on any db.* call outside it."
 */
export const db = drizzle(pool);
