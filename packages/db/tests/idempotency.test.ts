// packages/db/tests/idempotency.test.ts — WBS 2.9 (pg-tester).
//
// Contract under test — withIdempotentContext(ctx, idem, fn), against platform.idempotency_keys
// (database/migrations/0010_M_idempotency-keys-variance-photo.sql).
//
// Runs as pgeos_app through withContext's own pool (packages/db/src/client.ts honours
// PG_APP_USER) — every withIdempotentContext(...) call below goes through the real RLS policies
// (idem_own / idem_entity_scope) migration 0010 wrote, never bypassed. Fixture users are real
// identity.users rows (the FK platform.idempotency_keys.user_id references), created/removed via a
// separate ADMIN pool (PGUSER) — the only pool in this file allowed to see across users or DELETE.
//
// CLAUDE.md "NEVER delete from platform.audit_log" — this suite never touches that table.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The package under test, exported from the barrel. Imported via the relative barrel path — same
// convention as this package's own with-context.test.ts
// (`import { withContext } from '../index.js'`).
import { withIdempotentContext, IdempotencyConflictError, type WithContextCtx } from '../index.js';

// Admin (superuser) pool — fixture setup/teardown ONLY, and the handful of assertions that must
// see across users or run a DELETE (pgeos_app is proven below to have neither privilege).
const adminPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// A dedicated pgeos_app-role pool, used only for the raw-SQL RLS/privilege probes (own-rows-only,
// no-DELETE) that need a bare connection rather than withIdempotentContext's own transaction.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const ENDPOINT = 'wms.receive-inbound.approve';
const OTHER_ENDPOINT = 'wms.receive-inbound.close';

function sha256Hex(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function makeCtx(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}

/** A portal (client-facing) caller's shape — isInternal false, a real clientId set, the idem's own
 *  entityId left null (the same portal-context GUCs packages/db/src/with-context.ts sets for a
 *  client session). */
function makePortalCtx(userId: string, clientId: string): WithContextCtx {
  return { userId, clientId, isInternal: false };
}

async function createFixtureUser(userId: string): Promise<void> {
  await adminPool.query(`delete from identity.users where id = $1`, [userId]);
  await adminPool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_idem_fixture_${userId}_${randomUUID()}@test.invalid`, 'مستخدم اختبار Idempotency-Key'],
  );
}

async function getKeyRowAdmin(
  userId: string,
  key: string,
): Promise<
  | {
      response_status: number | null;
      response_body: unknown;
      created_at: string;
      expires_at: string;
      endpoint: string;
      request_hash: string;
    }
  | undefined
> {
  const result: QueryResult<{
    response_status: number | null;
    response_body: unknown;
    created_at: string;
    expires_at: string;
    endpoint: string;
    request_hash: string;
  }> = await adminPool.query(
    `select response_status, response_body, created_at, expires_at, endpoint, request_hash
       from platform.idempotency_keys where user_id = $1 and key = $2`,
    [userId, key],
  );
  return result.rows[0];
}

async function deleteKeyAdmin(userId: string, key: string): Promise<void> {
  await adminPool.query(`delete from platform.idempotency_keys where user_id = $1 and key = $2`, [userId, key]);
}

const fixtureUserIds: string[] = [];

beforeAll(async () => {
  // nothing global — each describe block creates its own fixture user id(s), tracked for teardown.
});

afterAll(async () => {
  for (const userId of fixtureUserIds) {
    await adminPool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await adminPool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await adminPool.end();
  await appPool.end();
});

async function fixtureUser(): Promise<string> {
  const id = randomUUID();
  fixtureUserIds.push(id);
  await createFixtureUser(id);
  return id;
}

describe('withIdempotentContext — fresh key: fn runs exactly once, the row stores status + body', () => {
  it('inserts a claimed row and persists response_status/response_body after fn resolves', async () => {
    const userId = await fixtureUser();
    const key = `fresh-${randomUUID()}`;
    const body = { orderId: randomUUID(), expectedVersion: 1 };
    let calls = 0;

    const result = await withIdempotentContext(
      makeCtx(userId),
      { key, endpoint: ENDPOINT, requestHash: sha256Hex(body), entityId: null, successStatus: 200 },
      async () => {
        calls += 1;
        return { orderStatus: 'approved', version: 2 };
      },
    );

    expect(calls).toBe(1);
    expect(result).toEqual({ orderStatus: 'approved', version: 2 });

    const row = await getKeyRowAdmin(userId, key);
    expect(row).toBeDefined();
    expect(row?.response_status).toBe(200);
    expect(row?.response_body).toEqual({ orderStatus: 'approved', version: 2 });
  });
});

describe('withIdempotentContext — replay: same key + same hash returns the stored result without calling fn again', () => {
  it('the second call does not invoke fn and returns the exact first result', async () => {
    const userId = await fixtureUser();
    const key = `replay-${randomUUID()}`;
    const body = { orderId: randomUUID(), expectedVersion: 1 };
    const requestHash = sha256Hex(body);
    let calls = 0;

    const idem = { key, endpoint: ENDPOINT, requestHash, entityId: null, successStatus: 200 };
    const first = await withIdempotentContext(makeCtx(userId), idem, async () => {
      calls += 1;
      return { orderStatus: 'approved', version: 2 };
    });

    const second = await withIdempotentContext(makeCtx(userId), idem, async () => {
      calls += 1;
      return { orderStatus: 'SHOULD_NOT_HAPPEN', version: 999 };
    });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});

describe('withIdempotentContext — a portal caller (isInternal false, clientId set) — fresh then replay', () => {
  it('a portal-shaped ctx runs fn once on the fresh call, and replays without calling fn again on the second', async () => {
    const userId = await fixtureUser();
    const clientId = randomUUID();
    const key = `portal-${randomUUID()}`;
    const body = { orderId: randomUUID(), expectedVersion: 1 };
    // entityId left null in the idem itself — same as every other case in this suite.
    const idem = { key, endpoint: ENDPOINT, requestHash: sha256Hex(body), entityId: null, successStatus: 200 };
    let calls = 0;

    const first = await withIdempotentContext(makePortalCtx(userId, clientId), idem, async () => {
      calls += 1;
      return { orderStatus: 'approved', version: 2 };
    });
    expect(calls).toBe(1);
    expect(first).toEqual({ orderStatus: 'approved', version: 2 });

    const second = await withIdempotentContext(makePortalCtx(userId, clientId), idem, async () => {
      calls += 1;
      return { orderStatus: 'SHOULD_NOT_HAPPEN', version: 999 };
    });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});

describe('withIdempotentContext — mismatch: same key, different request hash', () => {
  it('rejects with IdempotencyConflictError reason "mismatch"', async () => {
    const userId = await fixtureUser();
    const key = `mismatch-hash-${randomUUID()}`;
    const idemA = { key, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 };
    const idemB = { key, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 2 }), entityId: null, successStatus: 200 };

    await withIdempotentContext(makeCtx(userId), idemA, async () => ({ ok: true }));

    await expect(
      withIdempotentContext(makeCtx(userId), idemB, async () => ({ ok: 'wrong' })),
    ).rejects.toMatchObject({ name: 'IdempotencyConflictError', reason: 'mismatch' });
    await expect(withIdempotentContext(makeCtx(userId), idemB, async () => ({ ok: 'wrong' }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('the same key with a different endpoint is also a "mismatch"', async () => {
    const userId = await fixtureUser();
    const key = `mismatch-endpoint-${randomUUID()}`;
    const requestHash = sha256Hex({ a: 1 });
    const idemA = { key, endpoint: ENDPOINT, requestHash, entityId: null, successStatus: 200 };
    const idemB = { key, endpoint: OTHER_ENDPOINT, requestHash, entityId: null, successStatus: 200 };

    await withIdempotentContext(makeCtx(userId), idemA, async () => ({ ok: true }));

    await expect(
      withIdempotentContext(makeCtx(userId), idemB, async () => ({ ok: 'wrong' })),
    ).rejects.toMatchObject({ name: 'IdempotencyConflictError', reason: 'mismatch' });
  });
});

describe('withIdempotentContext — in_flight: two concurrent calls with the same key', () => {
  it('exactly one call runs fn; the other observes "in_flight" (or a post-commit replay)', async () => {
    const userId = await fixtureUser();
    const key = `inflight-${randomUUID()}`;
    const requestHash = sha256Hex({ a: 1 });
    const idem = { key, endpoint: ENDPOINT, requestHash, entityId: null, successStatus: 200 };
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withIdempotentContext(makeCtx(userId), idem, async () => {
      calls += 1;
      await gate;
      return { ok: 'first' };
    });

    // Give the first call time to acquire the advisory xact lock and claim the row before the
    // second call starts — proves the race is genuine, not a lucky ordering.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = withIdempotentContext(makeCtx(userId), idem, async () => {
      calls += 1;
      return { ok: 'second-should-not-run' };
    });
    // Attach a synchronous no-op rejection handler immediately — Promise.allSettled below still
    // observes the real outcome, this just stops Node from flagging a transient unhandled
    // rejection during the 50ms window before allSettled itself subscribes.
    second.catch(() => undefined);

    // Let the second call resolve (either reject in_flight, or block on the advisory lock and
    // then replay once the first commits) before releasing the first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst?.();

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    expect(calls).toBe(1);
    expect(firstResult.status).toBe('fulfilled');
    if (secondResult.status === 'rejected') {
      expect(secondResult.reason).toBeInstanceOf(IdempotencyConflictError);
      expect((secondResult.reason as IdempotencyConflictError).reason).toBe('in_flight');
    } else {
      expect(secondResult.value).toEqual((firstResult as PromiseFulfilledResult<unknown>).value);
    }
  });
});

describe('withIdempotentContext — an expired key is reclaimed', () => {
  it('a new call with a different hash runs fn once the stored row has expired', async () => {
    const userId = await fixtureUser();
    const key = `expired-${randomUUID()}`;
    const idemOriginal = { key, endpoint: ENDPOINT, requestHash: sha256Hex({ v: 1 }), entityId: null, successStatus: 200 };
    let calls = 0;

    await withIdempotentContext(makeCtx(userId), idemOriginal, async () => {
      calls += 1;
      return { ok: 'original' };
    });
    expect(calls).toBe(1);

    // Admin forces the row into the past — proving reclaim, not merely "it happened to still work".
    await adminPool.query(
      `update platform.idempotency_keys set expires_at = now() - interval '1 second' where user_id = $1 and key = $2`,
      [userId, key],
    );

    const idemNew = { key, endpoint: ENDPOINT, requestHash: sha256Hex({ v: 2 }), entityId: null, successStatus: 200 };
    const result = await withIdempotentContext(makeCtx(userId), idemNew, async () => {
      calls += 1;
      return { ok: 'reclaimed' };
    });

    expect(calls).toBe(2);
    expect(result).toEqual({ ok: 'reclaimed' });
  });
});

describe('withIdempotentContext — fn throws: no row is stored', () => {
  it('rolls back the whole transaction; platform.idempotency_keys has no row for this key', async () => {
    const userId = await fixtureUser();
    const key = `throws-${randomUUID()}`;
    const marker = new Error('intentional-throw-for-no-row-proof');

    await expect(
      withIdempotentContext(
        makeCtx(userId),
        { key, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 },
        async () => {
          throw marker;
        },
      ),
    ).rejects.toBe(marker);

    const row = await getKeyRowAdmin(userId, key);
    expect(row).toBeUndefined();
  });
});

describe('withIdempotentContext — own rows only: RLS hides another user\'s key from pgeos_app', () => {
  it('user B cannot read user A\'s idempotency_keys row through a pgeos_app connection', async () => {
    const userA = await fixtureUser();
    const userB = await fixtureUser();
    const key = `ownrows-${randomUUID()}`;

    await withIdempotentContext(
      makeCtx(userA),
      { key, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 },
      async () => ({ ok: true }),
    );

    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [userB]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      const visible: QueryResult<{ key: string }> = await client.query(
        `select key from platform.idempotency_keys where user_id = $1 and key = $2`,
        [userA, key],
      );
      expect(visible.rows).toHaveLength(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('withIdempotentContext — expires_at is read from platform.thresholds, never a literal', () => {
  it('expires_at - created_at equals the live idempotency.retention_days threshold', async () => {
    const userId = await fixtureUser();
    const key = `ttl-${randomUUID()}`;

    const thresholdResult: QueryResult<{ value: string }> = await adminPool.query(
      `select value from platform.thresholds where key = 'idempotency.retention_days'`,
    );
    const thresholdDays = thresholdResult.rows[0]?.value;
    if (thresholdDays === undefined) {
      throw new Error(
        "seed threshold 'idempotency.retention_days' not found — is migration 0010 applied?",
      );
    }

    await withIdempotentContext(
      makeCtx(userId),
      { key, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 },
      async () => ({ ok: true }),
    );

    const row = await getKeyRowAdmin(userId, key);
    if (!row) throw new Error('fresh-key row missing after withIdempotentContext resolved');
    const actualDays =
      (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / (24 * 60 * 60 * 1000);
    expect(actualDays).toBeCloseTo(Number(thresholdDays), 1);
  });
});

describe('platform.idempotency_keys — pgeos_app has no DELETE privilege', () => {
  it('a DELETE attempt as pgeos_app is rejected (insufficient_privilege)', async () => {
    const userId = await fixtureUser();
    const key = `nodelete-${randomUUID()}`;
    await withIdempotentContext(
      makeCtx(userId),
      { key, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 },
      async () => ({ ok: true }),
    );

    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [userId]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      await expect(
        client.query(`delete from platform.idempotency_keys where user_id = $1 and key = $2`, [userId, key]),
      ).rejects.toThrow(/permission denied|insufficient_privilege/i);
      await client.query('rollback');
    } finally {
      client.release();
    }

    // The row still exists — the rejected DELETE never took effect.
    expect(await getKeyRowAdmin(userId, key)).toBeDefined();
  });
});

describe('platform.purge_idempotency_keys() deletes only expired rows', () => {
  it('removes the row whose expires_at is in the past, leaves the still-live row untouched', async () => {
    const userId = await fixtureUser();
    const expiredKey = `purge-expired-${randomUUID()}`;
    const liveKey = `purge-live-${randomUUID()}`;

    await withIdempotentContext(
      makeCtx(userId),
      { key: expiredKey, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 },
      async () => ({ ok: true }),
    );
    await withIdempotentContext(
      makeCtx(userId),
      { key: liveKey, endpoint: ENDPOINT, requestHash: sha256Hex({ a: 1 }), entityId: null, successStatus: 200 },
      async () => ({ ok: true }),
    );
    await adminPool.query(
      `update platform.idempotency_keys set expires_at = now() - interval '1 second' where user_id = $1 and key = $2`,
      [userId, expiredKey],
    );

    await adminPool.query(`select platform.purge_idempotency_keys()`);

    expect(await getKeyRowAdmin(userId, expiredKey)).toBeUndefined();
    expect(await getKeyRowAdmin(userId, liveKey)).toBeDefined();

    await deleteKeyAdmin(userId, liveKey);
  });
});
