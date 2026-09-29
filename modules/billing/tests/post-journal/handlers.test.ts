// modules/billing/tests/post-journal/handlers.test.ts — WBS 4.20 (lane 2).
//
// The api layer's contract (modules/billing/api/post-journal/handlers.ts): one handler per FROZEN
// contract route (packages/contracts/billing/post-journal.ts ROUTES: post-journal, reverse-journal,
// adjust-journal). Same api-mapping discipline as ../accounting-periods/handlers.test.ts: missing
// Idempotency-Key -> 400, invalid body -> 400, StaleVersionError and IdempotencyConflictError -> 409,
// every other typed domain refusal -> 422 (title = error.name), unknown error -> 500 with a generic
// detail logged through deps.logger.error, idempotent replay returns the identical response.
// Business-rule depth is in ./post-journal.test.ts. Run with PGDATABASE=pgeos_lane2.
//
// STATUS: RED — modules/billing/api/post-journal/* still hold the golden-slice wms content.
//
// Surface (builder to provide, names verbatim):
//   modules/billing/api/post-journal/handlers.ts:
//     handlePostJournal, handleReverseJournal, handleAdjustJournal, type ApiRequest<TBody>
//       — each `(request: ApiRequest<TBody>, deps: PostJournalDeps) => Promise<{ status: number; body?: unknown }>`;
//       ApiRequest = { headers: Record<string, string>; body: TBody; ctx: WithContextCtx }.
//   modules/billing/api/post-journal/composition.ts: createPostJournalDeps({ clock, logger? }) -> deps with
//     `repo` exposing `getPostedEntry(...)` (the reverse path's first read; replaced here by a throwing stub).
//   modules/billing/application/post-journal/ports.ts: type Logger = { error(obj, msg): void; info(obj, msg): void }.
//   200 body: PostJournal/AdjustJournal -> { id, docNo, version }; ReverseJournal -> { id, docNo, reversedEntryId, originalVersion }.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import type { Logger } from '../../application/post-journal/ports.js';
import { createPostJournalDeps } from '../../api/post-journal/composition.js';
import { handleAdjustJournal, handlePostJournal, handleReverseJournal, type ApiRequest } from '../../api/post-journal/handlers.js';
import { adjustBody, createFixtures, type Fixtures } from './fixtures.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 6,
});

const FILE_NO = '02';
const AMOUNT = '100.000';
const clock = new FixedClock(new Date('2026-09-29T00:00:00.000Z'));
const deps = createPostJournalDeps({ clock });

let fx: Fixtures;

type Ctx = ReturnType<Fixtures['ctx']>;

function requestWithKey<TBody>(body: TBody, ctx: Ctx, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody, ctx: Ctx): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function lines(): Array<{ accountId: string; debit?: string; credit?: string }> {
  return [
    { accountId: fx.accounts.debit, debit: AMOUNT },
    { accountId: fx.accounts.credit, credit: AMOUNT },
  ];
}

async function postBody(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const period = await fx.nextPeriod();
  return {
    entityId: fx.entityId,
    periodId: period.id,
    entryDate: period.startDate,
    entryType: 'accrual',
    description: 'قيد اختبار معالج الترحيل — WBS 4.20',
    lines: lines(),
    correlationId: randomUUID(),
    ...overrides,
  };
}

async function freshPosted(): Promise<{ id: string; version: number }> {
  const result = await handlePostJournal(requestWithKey(await postBody(), fx.ctx(fx.posterId)), deps);
  if (result.status !== 200) throw new Error(`fixture handlePostJournal did not return 200: ${JSON.stringify(result)}`);
  const body = result.body as { id: string; version: number };
  fx.trackEntry(body.id);
  return body;
}

async function reverseBody(entryId: string, expectedVersion: number): Promise<Record<string, unknown>> {
  const period = await fx.nextPeriod();
  return { entryId, expectedVersion, periodId: period.id, entryDate: period.startDate, description: 'عكس قيد — معالج', correlationId: randomUUID() };
}

beforeAll(async () => {
  fx = await createFixtures(pool, { tag: 'handlers.test', fileNo: FILE_NO });
});

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
});

describe('a missing Idempotency-Key is rejected with a 400 Problem, for every write route', () => {
  it('handlePostJournal', async () => {
    expect((await handlePostJournal(requestWithoutKey(await postBody(), fx.ctx(fx.posterId)), deps)).status).toBe(400);
  });
  it('handleReverseJournal', async () => {
    expect((await handleReverseJournal(requestWithoutKey(await reverseBody(randomUUID(), 1), fx.ctx(fx.posterId)), deps)).status).toBe(400);
  });
  it('handleAdjustJournal', async () => {
    const adjustPayload = adjustBody(await postBody());
    expect((await handleAdjustJournal(requestWithoutKey(adjustPayload, fx.ctx(fx.posterId)), deps)).status).toBe(400);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handlePostJournal: an empty body, a single line, and the excluded entry types "reversing" / "adjustment" -> 400', async () => {
    const ctx = fx.ctx(fx.posterId);
    expect((await handlePostJournal(requestWithKey({}, ctx), deps)).status).toBe(400);
    expect((await handlePostJournal(requestWithKey(await postBody({ lines: [lines()[0]] }), ctx), deps)).status).toBe(400);
    expect((await handlePostJournal(requestWithKey(await postBody({ entryType: 'reversing' }), ctx), deps)).status).toBe(400);
    expect((await handlePostJournal(requestWithKey(await postBody({ entryType: 'adjustment' }), ctx), deps)).status).toBe(400);
  });
  it('handleReverseJournal: a body missing required fields -> 400', async () => {
    expect((await handleReverseJournal(requestWithKey({}, fx.ctx(fx.posterId)), deps)).status).toBe(400);
  });
  it('handleAdjustJournal: a body missing required fields -> 400', async () => {
    expect((await handleAdjustJournal(requestWithKey({}, fx.ctx(fx.posterId)), deps)).status).toBe(400);
  });
});

describe('every 3 contract routes: the happy path returns 200 with the documented body', () => {
  it('handlePostJournal -> 200 { id, docNo, version: 1 }', async () => {
    const result = await handlePostJournal(requestWithKey(await postBody(), fx.ctx(fx.posterId)), deps);
    expect(result.status).toBe(200);
    const body = result.body as { id: string; docNo: string; version: number };
    fx.trackEntry(body.id);
    expect(typeof body.id).toBe('string');
    expect(typeof body.docNo).toBe('string');
    expect(body.version).toBe(1);
  });

  it('handleReverseJournal -> 200 { id, docNo, reversedEntryId, originalVersion }', async () => {
    const posted = await freshPosted();
    const result = await handleReverseJournal(requestWithKey(await reverseBody(posted.id, posted.version), fx.ctx(fx.posterId)), deps);
    expect(result.status).toBe(200);
    const body = result.body as { id: string; docNo: string; reversedEntryId: string; originalVersion: number };
    fx.trackEntry(body.id);
    expect(body.reversedEntryId).toBe(posted.id);
    expect(body.originalVersion).toBe(posted.version + 1);
  });

  it('handleAdjustJournal -> 200 { id, docNo, version: 1 }', async () => {
    const adjustPayload = adjustBody(await postBody());
    const result = await handleAdjustJournal(requestWithKey(adjustPayload, fx.ctx(fx.posterId)), deps);
    expect(result.status).toBe(200);
    const body = result.body as { id: string; version: number };
    fx.trackEntry(body.id);
    expect(body.version).toBe(1);
  });
});

describe('typed domain refusals map to 422, title = error.name', () => {
  it('handlePostJournal: unbalanced -> UnbalancedEntryError', async () => {
    const result = await handlePostJournal(
      requestWithKey(await postBody({ lines: [{ accountId: fx.accounts.debit, debit: AMOUNT }, { accountId: fx.accounts.credit, credit: '99.999' }] }), fx.ctx(fx.posterId)),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'UnbalancedEntryError' });
  });

  it('handlePostJournal: a manual journal -> ManualJournalApprovalRequiredError; manual on revenue -> ManualRevenueJournalRefusedError', async () => {
    const approval = await handlePostJournal(requestWithKey(await postBody({ entryType: 'manual' }), fx.ctx(fx.posterId)), deps);
    expect(approval.status).toBe(422);
    expect(approval.body).toMatchObject({ title: 'ManualJournalApprovalRequiredError' });
    const revenue = await handlePostJournal(
      requestWithKey(await postBody({ entryType: 'manual', lines: [{ accountId: fx.accounts.debit, debit: AMOUNT }, { accountId: fx.accounts.revenue, credit: AMOUNT }] }), fx.ctx(fx.posterId)),
      deps,
    );
    expect(revenue.status).toBe(422);
    expect(revenue.body).toMatchObject({ title: 'ManualRevenueJournalRefusedError' });
  });

  it('handlePostJournal: a caller not scoped to the entity -> EntityNotInScopeError; a closed period -> PeriodNotOpenError', async () => {
    const outsider = await handlePostJournal(requestWithKey(await postBody(), fx.ctx(fx.outsiderId)), deps);
    expect(outsider.status).toBe(422);
    expect(outsider.body).toMatchObject({ title: 'EntityNotInScopeError' });

    const period = await fx.nextPeriod();
    await fx.setPeriodStatus(period.id, 'closed');
    const closed = await handlePostJournal(requestWithKey(await postBody({ periodId: period.id, entryDate: period.startDate }), fx.ctx(fx.posterId)), deps);
    expect(closed.status).toBe(422);
    expect(closed.body).toMatchObject({ title: 'PeriodNotOpenError' });
  });

  it('handleReverseJournal: a nonexistent entry -> JournalEntryNotFoundError; a second reversal -> AlreadyReversedError', async () => {
    const missing = await handleReverseJournal(requestWithKey(await reverseBody(randomUUID(), 1), fx.ctx(fx.posterId)), deps);
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ title: 'JournalEntryNotFoundError' });

    const posted = await freshPosted();
    const first = await handleReverseJournal(requestWithKey(await reverseBody(posted.id, posted.version), fx.ctx(fx.posterId)), deps);
    expect(first.status).toBe(200);
    fx.trackEntry((first.body as { id: string }).id);
    const second = await handleReverseJournal(requestWithKey(await reverseBody(posted.id, posted.version + 1), fx.ctx(fx.posterId)), deps);
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ title: 'AlreadyReversedError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleReverseJournal: a stale expectedVersion -> 409', async () => {
    const posted = await freshPosted();
    const result = await handleReverseJournal(requestWithKey(await reverseBody(posted.id, posted.version + 999), fx.ctx(fx.posterId)), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('idempotent replay: the same Idempotency-Key and body twice returns the identical response', () => {
  it('handlePostJournal: identical key + body -> identical response, exactly one entry', async () => {
    const idempotencyKey = randomUUID();
    const body = await postBody({ description: `قيد إعادة تشغيل ${randomUUID()}` });
    const first = await handlePostJournal(requestWithKey(body, fx.ctx(fx.posterId), idempotencyKey), deps);
    expect(first.status).toBe(200);
    fx.trackEntry((first.body as { id: string }).id);
    const second = await handlePostJournal(requestWithKey(body, fx.ctx(fx.posterId), idempotencyKey), deps);
    expect(second).toEqual(first);
    const count: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from billing.journal_entries where entity_id = $1 and description = $2`, [
      fx.entityId,
      body['description'],
    ]);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });
});

describe('IdempotencyConflictError maps to 409, title = error.name', () => {
  it('handlePostJournal: the same Idempotency-Key with a DIFFERENT body -> 409', async () => {
    const idempotencyKey = randomUUID();
    const first = await handlePostJournal(requestWithKey(await postBody(), fx.ctx(fx.posterId), idempotencyKey), deps);
    expect(first.status).toBe(200);
    fx.trackEntry((first.body as { id: string }).id);
    const conflict = await handlePostJournal(requestWithKey(await postBody(), fx.ctx(fx.posterId), idempotencyKey), deps);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

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

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleReverseJournal: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err }', async () => {
    const posted = await freshPosted();
    const logger = spyLogger();
    const withSpy = createPostJournalDeps({ clock, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...withSpy,
      repo: {
        ...withSpy.repo,
        getPostedEntry: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const body = await reverseBody(posted.id, posted.version);

    const result = await handleReverseJournal(requestWithKey(body, fx.ctx(fx.posterId)), brokenDeps);

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);
    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(body['correlationId']);
    expect(loggedObj['err']).toBe(thrown);
  });
});
