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

// RESOLVED (WBS 0.6a, D-133): withContext's RLS-GUC mechanism (app.user_id / app.client_id /
// app.is_internal) only has teeth once the runtime pool connects as a non-superuser application
// role with NOBYPASSRLS (the Postgres default for a newly created role) — Postgres superusers
// unconditionally bypass RLS regardless of any GUC being set correctly, and `force row level
// security` (13B:3047-3061) only binds the table OWNER, not a superuser. Migration 0007
// (database/migrations/0007_*.sql) created exactly that role: `pgeos_app`, no SUPERUSER, no
// BYPASSRLS, no password (trust auth, Tier 0 only), scoped GRANTs, and the entity_scope
// USING/WITH CHECK split. Setting PG_APP_USER=pgeos_app makes withContext's queries actually run
// under RLS instead of silently bypassing it. CI (.github/workflows/ci.yml) sets
// PG_APP_USER=pgeos_app for every job that touches the database, so gates ②③⑤ run under RLS.
// Local dev is unchanged: PG_APP_USER is unset by default, so the pool falls back to PGUSER
// (still 'postgres' locally) — no behaviour change for a developer who has not opted in.
export const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? process.env['PGUSER'] ?? 'postgres',
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
