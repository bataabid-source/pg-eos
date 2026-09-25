// modules/imile/tests/pull-shipments/handlers.test.ts — WBS 3.14 (part 2).
//
// Exercises the api layer's contract (../../api/pull-shipments/handlers.ts) for the internal
// trigger endpoint that fires one pull cycle — one test per mapping:
//   - a missing Idempotency-Key header -> 400 (CLAUDE.md · ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - a body that fails the Zod contract -> 400;
//   - a replayed call that hits IdempotencyConflictError (same key, different body) -> 409;
//   - a same key / same body replay -> 200, identical response, no second write;
//   - an unexpected thrown error (e.g. the portal adapter throwing something that is not a typed
//     domain error) -> 500, generic detail, logged through deps.logger.error (pino, no console.log
//     — CLAUDE.md · AGENT CONSTRAINTS).
//
// Shape based on modules/imile/tests/report-agent-health/handlers.test.ts (read-only reference,
// same module's own part-1 precedent) and modules/wms/tests/receive-inbound/handlers.test.ts
// (golden slice). Fixture/RLS pattern: admin pool, one real identity.users row for the
// station-agent actor — same as ./pull-shipments.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createPullShipmentsDeps } from '../../api/pull-shipments/composition.js';
import type { Logger } from '../../application/pull-shipments/ports.js';
import type { ImilePortalPort, PortalShipmentRecord } from '../../application/pull-shipments/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour verified (RED).
import { handlePullShipments, type ApiRequest } from '../../api/pull-shipments/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000003140c1';

const clock = new FixedClock(new Date('2026-09-25T02:00:00.000Z'));
const ids = new SequentialIdGenerator(31402);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const usedTrackingNos: string[] = [];

/** Deep, key-order-independent canonicalization for the byte-identical replay comparison below.
 *  The idempotent-replay path round-trips the stored response through a jsonb column (packages/db
 *  idempotency store), and Postgres's jsonb representation does not preserve the original JS
 *  object key insertion order — a harmless storage-level reordering, not a content difference.
 *  Sorting keys before stringifying makes the comparison genuinely byte-for-byte on CONTENT while
 *  tolerating that reordering. */
function canonicalJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, sortKeys(val)]),
      );
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

function emptyPortal(): ImilePortalPort {
  return { fetchShipments: async () => [] };
}

/** A portal fake that returns ONE deterministic, non-empty record the first time it is called, and
 *  THROWS if it is ever called a second time. Used by the "same key, same body replay" test below
 *  (finding 10): a portal that always returns `[]` cannot tell "the command genuinely ran only
 *  once (idempotency replay served the cached response)" apart from "the command ran a second time
 *  and the second real pull also happened to see zero/matching shipments" — this fake makes a
 *  second real invocation impossible to miss. */
function singleUseNonEmptyPortal(record: PortalShipmentRecord): ImilePortalPort & { readonly callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    fetchShipments: async () => {
      calls += 1;
      if (calls > 1) {
        throw new Error('portal adapter invoked a second time — an idempotent replay must never re-run the command');
      }
      return [record];
    },
  };
}

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function validBody(): Record<string, unknown> {
  return { correlationId: randomUUID() };
}

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

beforeAll(async () => {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_imilepull_handlers_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات سحب شحنات iMile'],
  );
});

afterAll(async () => {
  if (usedTrackingNos.length > 0) {
    await pool.query(`delete from imile.shipments where tracking_no = any($1::text[])`, [usedTrackingNos]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handlePullShipments: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const deps = createPullShipmentsDeps({ clock, ids, portal: emptyPortal() });
    const result = await handlePullShipments(requestWithoutKey(validBody()), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handlePullShipments: a body missing correlationId -> 400', async () => {
    const deps = createPullShipmentsDeps({ clock, ids, portal: emptyPortal() });
    const result = await handlePullShipments(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handlePullShipments: a body carrying a non-uuid correlationId -> 400', async () => {
    const deps = createPullShipmentsDeps({ clock, ids, portal: emptyPortal() });
    const result = await handlePullShipments(requestWithKey({ correlationId: 'not-a-uuid' }), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handlePullShipments: same key, different body on the second call -> 409, title "IdempotencyConflictError"', async () => {
    const deps = createPullShipmentsDeps({ clock, ids, portal: emptyPortal() });
    const idempotencyKey = randomUUID();
    const firstBody = validBody();

    const first = await handlePullShipments(requestWithKey(firstBody, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { correlationId: randomUUID() }; // different correlationId -> different hash.
    const result = await handlePullShipments(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handlePullShipments: same key, same body on the second call -> 200, byte-identical response, portal invoked exactly once (no second pull)', async () => {
    const trackingNo = `SHP-REPLAY-${randomUUID()}`;
    usedTrackingNos.push(trackingNo);
    const record: PortalShipmentRecord = {
      tracking_no: trackingNo,
      merchant: 'Replay Merchant',
      zone_code: 'Z-77',
      area: 'Jahra',
      recipient_phone: '+96555577777',
      is_cod: false,
      cod_amount: null,
      is_fresh: false,
      imile_status: 'created',
      raw: { trackingNo, source: 'replay-fixture' },
    };
    const portal = singleUseNonEmptyPortal(record);
    const deps = createPullShipmentsDeps({ clock, ids, portal });
    const idempotencyKey = randomUUID();
    const body = validBody();

    const first = await handlePullShipments(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handlePullShipments(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    // Byte-identical (key-order-independent canonical form — the replay path round-trips through
    // a jsonb column, which reorders keys harmlessly) — not merely deep-equal to `first`, ruling
    // out a re-run that coincidentally produced the same shape.
    expect(second).toEqual(first);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(portal.callCount()).toBe(1);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handlePullShipments: the portal adapter throwing an untyped error -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const thrown = new TypeError('unexpected portal adapter failure — never sent to the client');
    const brokenPortal: ImilePortalPort = {
      fetchShipments: async () => {
        throw thrown;
      },
    };
    const deps = createPullShipmentsDeps({ clock, ids, logger, portal: brokenPortal });
    const correlationId = randomUUID();

    const result = await handlePullShipments(requestWithKey({ correlationId }), deps);

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected portal adapter failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});

describe('createPullShipmentsDeps accepts an injected logger and portal', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createPullShipmentsDeps({ clock, ids, logger, portal: emptyPortal() });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.portal defaults to the NotConfiguredImilePortalAdapter when none is injected (production wiring default)', async () => {
    const defaultDeps = createPullShipmentsDeps({ clock, ids });
    await expect(defaultDeps.portal.fetchShipments()).rejects.toThrow();
  });
});
