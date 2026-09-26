// packages/db/tests/client-app-user.test.ts — ADR-0005 §7 (security finding, audit 2026-09-26).
//
// withContext must never run as a superuser or BYPASSRLS role: PG_APP_USER is REQUIRED, `postgres`
// is refused by name, and any other privileged role is refused by the catalog on first connect.
// The catalog-check case (a BYPASSRLS fixture role, random name, dropped only in afterAll — D-183)
// is backlogged as `X part 2`; the check itself is exercised indirectly by case 4 (pgeos_app passes).
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = { ...process.env };
const CTX = { userId: randomUUID(), clientId: null, isInternal: true } as const;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
}

async function freshWithContext(): Promise<typeof import('../src/with-context.js')> {
  vi.resetModules();
  return import('../src/with-context.js');
}

describe('withContext — pool role is the application role, never a superuser (ADR-0005 §7)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('refuses to connect when PG_APP_USER is unset', async () => {
    delete process.env['PG_APP_USER'];
    process.env['PGUSER'] = 'postgres';
    const { withContext } = await freshWithContext();
    await expect(withContext(CTX, async () => 'ran')).rejects.toThrow(/PG_APP_USER/);
  });

  it('refuses PG_APP_USER=postgres by name', async () => {
    process.env['PG_APP_USER'] = 'postgres';
    const { withContext } = await freshWithContext();
    await expect(withContext(CTX, async () => 'ran')).rejects.toThrow(/PG_APP_USER/);
  });

  it('runs as the application role and the callback executes', async () => {
    process.env['PG_APP_USER'] = 'pgeos_app';
    const { withContext } = await freshWithContext();
    const user = await withContext(CTX, async (tx) => {
      const { sql } = await import('drizzle-orm');
      const r = await tx.execute(sql`select current_user as u`);
      return (r.rows[0] as { u: string }).u;
    });
    expect(user).toBe('pgeos_app');
  });
});
