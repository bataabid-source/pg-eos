// apps/api/tests/server.test.ts — X part 5a (brief `docs/notes/slice-briefs/_slice-X-part-5a.brief.md`,
// "Tests" section). ONE `it` per Gherkin scenario of `apps/api/features/x-part-5a.feature`, titled
// verbatim — the "the route table is complete and one-to-one" scenario itself lives in
// `route-table.unit.test.ts` instead (it is about `buildRouteTable`, not `buildServer`/HTTP).
//
// RED, and why it is the right RED: `apps/api/src/server.ts`, `./auth.js` and `./http-status.js` do
// not exist yet — the imports below fail to resolve (same RED class as route-table.unit.test.ts and
// packages/identity/tests/session.test.ts).
//
// buildServer's surface fixed by this suite (the brief names the four option keys and the pipeline
// order; the exact option/return shapes are pinned here, as their first consumer):
//   buildServer({ verifySubject?, lookupEntities?, routes?, modulesRoot? }) → FastifyInstance
//   - verifySubject?: (token: string) => Promise<SubjectResult> — same shape as
//     `verifySessionSubject` from `@pg-eos/identity-mechanisms` (packages/identity/src/session.ts,
//     brief "Session subject"); default (omitted) wires the real one.
//   - lookupEntities?: (userId: string) => Promise<readonly string[]> — replaces the DB-backed
//     `createUserEntitiesLookup` the brief names (`packages/db/src/entity-scope.ts`); default
//     (omitted) wires the real one.
//   - routes?: an array of `{ method, path, handler }` — when given, IS the mounted table (bypasses
//     `ALL_ROUTES`/`buildRouteTable` entirely); the stub-route scenarios use this to capture
//     `request.ctx`/`request.headers` without a real module tree.
//   - modulesRoot?: forwarded to `buildRouteTable` when `routes` is omitted.
//
// Bucketing per the brief's Tests section: the ctx-capture, client/inactive and X-Entity-Id
// scenarios are DB-backed (real `identity.users`/`identity.user_entities` rows, real
// `issueSession`); every other scenario (framework errors, both 401-shape scenarios, the two real
// mounted-route scenarios, the two 501 scenarios, liveness) uses an injected `verifySubject` (and,
// where entity scope is reached, `lookupEntities`) stub and touches no database — a 401/501/health
// reply can never come from a real handler (PROBLEM_STATUS has no 401/501, and errorToApiFailure
// never returns them either — modules/wms/api/receive-inbound/handlers.ts:110-153), so a 401 or 501
// reply is itself the proof "no handler ran".

import { randomUUID } from 'node:crypto';

import { PROBLEM_STATUS } from '@pg-eos/contracts';
import type { Problem } from '@pg-eos/contracts';
import { HTTP_STATUS_INTERNAL_SERVER_ERROR, HTTP_STATUS_OK, UNKNOWN_ERROR_DETAIL } from '@pg-eos/api-kit';
import { issueSession } from '@pg-eos/identity-mechanisms';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The module under test — does not exist yet. This is the RED.
import { buildServer } from '../src/server.js';
import { UNAUTHORIZED_PROBLEM } from '../src/auth.js';
import {
  DEFAULT_PORT,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_NOT_IMPLEMENTED,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNAUTHORIZED,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
} from '../src/http-status.js';

// --- Fixed contract facts (brief "Facts the Master verified" — never invented) -------------------
const APPROVE_INBOUND_PATH = '/wms/receive-inbound/approve-inbound';
const SUGGEST_LOCATION_PATH = '/wms/receive-inbound/suggest-location';
const UNBUILT_POST_JOURNAL_PATH = '/billing/post-journal/post-journal';
const NOT_MOUNTED_REQUEST_OTP_PATH = '/identity/otp-login/request-otp-code';

// A stub route path outside ALL_ROUTES entirely — used only by the injected-`routes` scenarios, so
// it can never collide with a real, contract-fixed path.
const STUB_CAPTURE_PATH = '/test-fixture/capture-ctx';
const STUB_GET_CAPTURE_PATH = '/test-fixture/capture-get-body';

// Fastify's own default body limit (brief §"Fastify defaults are not RFC 9457" — 1 MiB, not tuned
// by this slice); one byte over it must trip FST_ERR_CTP_BODY_TOO_LARGE (413).
const FASTIFY_DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const ONE_BYTE_OVER_BODY_LIMIT = FASTIFY_DEFAULT_BODY_LIMIT_BYTES + 1;

interface SubjectResult {
  readonly valid: boolean;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly userType?: 'internal' | 'client' | 'agent';
  readonly clientId?: string | null;
  readonly isActive?: boolean;
}

interface CapturedCtx {
  readonly userId: string;
  readonly clientId: string | null;
  readonly isInternal: boolean;
  readonly entityId: string;
}

/** A `verifySubject` stub that recognises exactly the tokens in `table`; every other token (missing,
 *  unknown, malformed) reports invalid — never distinguishing a cause, matching `UNAUTHORIZED_PROBLEM`'s
 *  own "never reveals account state" rule. */
function stubVerifySubject(table: ReadonlyMap<string, SubjectResult>) {
  return async (token: string): Promise<SubjectResult> => table.get(token) ?? { valid: false };
}

function activeInternalSubject(userId: string): SubjectResult {
  return { valid: true, userId, sessionId: randomUUID(), userType: 'internal', clientId: null, isActive: true };
}

/** A `lookupEntities` stub reporting exactly one entity for every user — the entity-scope "exactly
 *  one entity, no header needed" case (brief, "Consequence for tests"), used by the stub-route
 *  scenarios that reach entity scope but are not themselves testing entity scope. */
function singleEntityLookup(entityId: string) {
  return async (): Promise<readonly string[]> => [entityId];
}

const ONLY_ENTITY_ID = randomUUID();

function captureStubRoute() {
  return {
    method: 'POST' as const,
    path: STUB_CAPTURE_PATH,
    handler: async (request: { readonly ctx: unknown; readonly headers: Record<string, unknown> }) => ({
      status: HTTP_STATUS_OK,
      body: { ctx: request.ctx, headers: request.headers },
    }),
  };
}

describe('Feature: X part 5a — one host serves every registered operation (stub-based scenarios, no DB)', () => {
  it('a request without a session is refused', async () => {
    const app = buildServer({ verifySubject: stubVerifySubject(new Map()) });
    const response = await app.inject({ method: 'POST', url: APPROVE_INBOUND_PATH, payload: {} });

    expect(response.statusCode).toBe(HTTP_STATUS_UNAUTHORIZED);
    const body = response.json<Problem>();
    expect(body).toEqual(UNAUTHORIZED_PROBLEM.body);

    // "no handler ran" — proven directly with a counting stub route, not merely inferred from
    // PROBLEM_STATUS's own shape (which has no 401 at all).
    let handlerCallCount = 0;
    const countingRoute = {
      method: 'POST' as const,
      path: STUB_CAPTURE_PATH,
      handler: async () => {
        handlerCallCount += 1;
        return { status: HTTP_STATUS_OK, body: {} };
      },
    };
    const countingApp = buildServer({ verifySubject: stubVerifySubject(new Map()), routes: [countingRoute] });
    const countingResponse = await countingApp.inject({ method: 'POST', url: STUB_CAPTURE_PATH, payload: {} });
    expect(countingResponse.statusCode).toBe(HTTP_STATUS_UNAUTHORIZED);
    expect(handlerCallCount).toBe(0);
  });

  it('an invalid, malformed or expired token is refused the same way', async () => {
    const agentUserId = randomUUID();
    const agentSubject: SubjectResult = {
      valid: true,
      userId: agentUserId,
      sessionId: randomUUID(),
      userType: 'agent',
      clientId: null,
      isActive: true,
    };
    // A "valid" subject with no userId at all — the host must refuse it exactly like every other
    // shape it does not accept, never trusting a subject it cannot address a ctx to.
    const noUserIdSubject: SubjectResult = {
      valid: true,
      sessionId: randomUUID(),
      userType: 'internal',
      clientId: null,
      isActive: true,
    };
    const app = buildServer({
      verifySubject: stubVerifySubject(
        new Map([
          ['agent-subject-token', agentSubject],
          ['subject-without-userid-token', noUserIdSubject],
        ]),
      ),
    });

    const cases = [
      'Bearer some-unknown-token',
      'Basic x',
      'Bearer',
      'bearer a b',
      'Bearer agent-subject-token',
      'Bearer subject-without-userid-token',
    ];
    for (const authorization of cases) {
      const response = await app.inject({
        method: 'POST',
        url: APPROVE_INBOUND_PATH,
        headers: { authorization },
        payload: {},
      });
      expect(response.statusCode).toBe(HTTP_STATUS_UNAUTHORIZED);
      expect(response.json<Problem>()).toEqual(UNAUTHORIZED_PROBLEM.body);
    }
  });

  it('an unauthenticated call to an unbuilt route is 401, not 501', async () => {
    const app = buildServer({ verifySubject: stubVerifySubject(new Map()) });
    const response = await app.inject({ method: 'POST', url: UNBUILT_POST_JOURNAL_PATH, payload: {} });

    expect(response.statusCode).toBe(HTTP_STATUS_UNAUTHORIZED);
  });

  it("a real POST handler runs with the caller's ctx", async () => {
    const userId = randomUUID();
    const token = 'token-for-a-real-post-handler';
    const app = buildServer({
      verifySubject: stubVerifySubject(new Map([[token, activeInternalSubject(userId)]])),
      lookupEntities: singleEntityLookup(ONLY_ENTITY_ID),
    });

    const response = await app.inject({
      method: 'POST',
      url: APPROVE_INBOUND_PATH,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    // requireIdempotencyKey (packages/api-kit/index.ts:63-73) — the handler's own 400 Problem,
    // proving the request reached the real handler with a ctx (not a stub).
    expect(response.statusCode).toBe(PROBLEM_STATUS.BAD_REQUEST);
    const body = response.json<{ title: string }>();
    expect(body.title).toBe('Idempotency-Key required');
  });

  it('a GET route receives its query as the handler body', async () => {
    const userId = randomUUID();
    const token = 'token-for-a-get-route';
    const subjectTable = new Map([[token, activeInternalSubject(userId)]]);

    // Proof #1 — a stub GET route captures exactly `request.body`, deep-equal to the query object
    // Fastify parses (`?qty=1` -> `{ qty: '1' }`, a string, never coerced).
    let capturedBody: unknown;
    const stubGetRoute = {
      method: 'GET' as const,
      path: STUB_GET_CAPTURE_PATH,
      handler: async (request: { readonly body: unknown }) => {
        capturedBody = request.body;
        return { status: HTTP_STATUS_OK, body: { ok: true } };
      },
    };
    const stubApp = buildServer({
      verifySubject: stubVerifySubject(subjectTable),
      lookupEntities: singleEntityLookup(ONLY_ENTITY_ID),
      routes: [stubGetRoute],
    });
    const stubResponse = await stubApp.inject({
      method: 'GET',
      url: `${STUB_GET_CAPTURE_PATH}?qty=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stubResponse.statusCode).toBe(HTTP_STATUS_OK);
    expect(capturedBody).toEqual({ qty: '1' });

    // Proof #2 — the real mounted route: the handler's own Zod parse rejects the string `qty` (the
    // recorded X part 11 gap — GET query values arrive as strings, uncoerced) with its own 400
    // ZodError Problem, never 404/501 — proving the route really is mounted with body := query.
    const realApp = buildServer({
      verifySubject: stubVerifySubject(subjectTable),
      lookupEntities: singleEntityLookup(ONLY_ENTITY_ID),
    });
    const response = await realApp.inject({
      method: 'GET',
      url: `${SUGGEST_LOCATION_PATH}?qty=1`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(PROBLEM_STATUS.BAD_REQUEST);
    const body = response.json<Problem>();
    expect(body.title).toBe('ZodError');
  });

  it('an unbuilt route answers 501', async () => {
    const userId = randomUUID();
    const token = 'token-for-an-unbuilt-route';
    const app = buildServer({
      verifySubject: stubVerifySubject(new Map([[token, activeInternalSubject(userId)]])),
      lookupEntities: singleEntityLookup(ONLY_ENTITY_ID),
    });

    const response = await app.inject({
      method: 'POST',
      url: UNBUILT_POST_JOURNAL_PATH,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(response.statusCode).toBe(HTTP_STATUS_NOT_IMPLEMENTED);
    const body = response.json<{ detail: string }>();
    expect(body.detail).toContain(UNBUILT_POST_JOURNAL_PATH);
  });

  it('the login routes are not mounted yet', async () => {
    const userId = randomUUID();
    const token = 'token-for-otp-login-not-mounted';
    const app = buildServer({
      verifySubject: stubVerifySubject(new Map([[token, activeInternalSubject(userId)]])),
      lookupEntities: singleEntityLookup(ONLY_ENTITY_ID),
    });

    const response = await app.inject({
      method: 'POST',
      url: NOT_MOUNTED_REQUEST_OTP_PATH,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(response.statusCode).toBe(HTTP_STATUS_NOT_IMPLEMENTED);
    const body = response.json<{ detail: string }>();
    expect(body.detail).toContain('2.16 part 1a-5');
  });

  it('framework errors are Problems too', async () => {
    // The builder's src change (VERIFY-round finding a): authentication now runs in an onRequest
    // hook, BEFORE Fastify's body parser — an authenticated call is required to reach the
    // 400/413/415 body-parsing Problems at all; an unauthenticated one is refused first (asserted
    // below, separately).
    const validToken = 'framework-errors-valid-token';
    const app = buildServer({
      verifySubject: stubVerifySubject(new Map([[validToken, activeInternalSubject(randomUUID())]])),
      lookupEntities: singleEntityLookup(ONLY_ENTITY_ID),
      routes: [captureStubRoute()],
    });
    const authorization = `Bearer ${validToken}`;

    const emptyJson = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization, 'content-type': 'application/json' },
      payload: '',
    });
    expect(emptyJson.statusCode).toBe(PROBLEM_STATUS.BAD_REQUEST);
    expect(emptyJson.json<Problem>()).toHaveProperty('type');

    const textPlain = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization, 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(textPlain.statusCode).toBe(HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE);
    expect(textPlain.json<Problem>()).toHaveProperty('type');

    const tooLarge = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization, 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(ONE_BYTE_OVER_BODY_LIMIT) }),
    });
    expect(tooLarge.statusCode).toBe(HTTP_STATUS_PAYLOAD_TOO_LARGE);
    expect(tooLarge.json<Problem>()).toHaveProperty('type');

    const unknownPath = await app.inject({ method: 'GET', url: '/this/path/does-not-exist' });
    expect(unknownPath.statusCode).toBe(HTTP_STATUS_NOT_FOUND);
    expect(unknownPath.json<Problem>()).toHaveProperty('type');

    // Authentication precedes body parsing: an UNauthenticated call with the same empty body gets
    // refused (401), never the 400 a body-parsing failure would otherwise produce.
    const unauthenticatedEmptyBody = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(unauthenticatedEmptyBody.statusCode).toBe(HTTP_STATUS_UNAUTHORIZED);
    expect(unauthenticatedEmptyBody.json<Problem>()).toEqual(UNAUTHORIZED_PROBLEM.body);

    const throwingApp = buildServer({
      verifySubject: async () => {
        throw new Error('a secret internal detail that must never reach the client');
      },
      routes: [captureStubRoute()],
    });
    const thrown = await throwingApp.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization: 'Bearer whatever' },
      payload: {},
    });
    expect(thrown.statusCode).toBe(HTTP_STATUS_INTERNAL_SERVER_ERROR);
    const thrownBody = thrown.json<Problem>();
    expect(thrownBody.detail).toBe(UNKNOWN_ERROR_DETAIL);
    expect(thrownBody.detail).not.toContain('secret internal detail');
    expect(JSON.stringify(thrownBody)).not.toContain('secret internal detail');
  });

  it('liveness', async () => {
    const app = buildServer({ verifySubject: stubVerifySubject(new Map()) });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(HTTP_STATUS_OK);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('DEFAULT_PORT is the nginx upstream port the brief fixes (doc 42 §5)', () => {
    expect(DEFAULT_PORT).toBe(3000);
  });
});

// --- DB-backed scenarios (brief, "DB-backed scenarios create users the way
// tests/scenarios/fixtures/actors.ts does ... plus user_type/is_active/client_id variants and an
// identity.user_entities row") ------------------------------------------------------------------

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureUserIds: string[] = [];
let entityA = '';
let entityB = '';

interface FixtureUser {
  readonly id: string;
  readonly token: string;
}

async function createFixtureUser(overrides: {
  readonly userType?: 'internal' | 'client' | 'agent';
  readonly clientId?: string | null;
  readonly isActive?: boolean;
}): Promise<{ id: string }> {
  const email = `pg-eos-x5a-server-${randomUUID()}@example.invalid`;
  const userType = overrides.userType ?? 'internal';
  const clientId = overrides.clientId ?? null;
  // issueSession requires is_active at issuance time (session.ts:106-111) — a fixture that must end
  // up inactive is created active, issued a session, THEN deactivated (mirrors
  // packages/identity/tests/session-subject.test.ts's "deactivated after issuance" fixture).
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, client_id, is_active)
     values ($1, $2, $3, $4, true) returning id`,
    [email, 'مستخدم اختبار — X part 5a server.test.ts', userType, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture user insert returned no row');
  fixtureUserIds.push(row.id);
  return { id: row.id };
}

async function addUserEntity(userId: string, entityId: string): Promise<void> {
  await pool.query('insert into identity.user_entities (user_id, entity_id) values ($1, $2)', [userId, entityId]);
}

async function deactivate(userId: string): Promise<void> {
  await pool.query('update identity.users set is_active = false where id = $1', [userId]);
}

async function issueFixtureSession(userId: string): Promise<FixtureUser> {
  const session = await issueSession(userId);
  return { id: userId, token: session.token };
}

beforeAll(async () => {
  const entities: QueryResult<{ id: string }> = await pool.query('select id from platform.entities order by id limit 2');
  const first = entities.rows[0];
  const second = entities.rows[1];
  if (!first || !second) {
    throw new Error('platform.entities needs at least 2 seeded rows for the X-Entity-Id scenarios');
  }
  entityA = first.id;
  entityB = second.id;
});

afterAll(async () => {
  if (fixtureUserIds.length > 0) {
    await pool.query('delete from platform.idempotency_keys where user_id = any($1::uuid[])', [fixtureUserIds]);
    await pool.query('delete from identity.user_entities where user_id = any($1::uuid[])', [fixtureUserIds]);
    // identity.sessions.user_id is `on delete cascade` — session rows go with the users.
    await pool.query('delete from identity.users where id = any($1::uuid[])', [fixtureUserIds]);
  }
  await pool.end();
});

describe('Feature: X part 5a — one host serves every registered operation (DB-backed scenarios)', () => {
  it('a valid internal session reaches the handler with exactly its ctx', async () => {
    const user = await createFixtureUser({ userType: 'internal', isActive: true });
    await addUserEntity(user.id, entityA);
    const session = await issueFixtureSession(user.id);

    const otherUser = await createFixtureUser({ userType: 'internal', isActive: true });
    await addUserEntity(otherUser.id, entityA);
    const otherSession = await issueFixtureSession(otherUser.id);

    const app = buildServer({ routes: [captureStubRoute()] });

    const response = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: {
        authorization: `Bearer ${session.token}`,
        ctx: 'attacker-supplied-header-must-be-ignored',
        userid: 'attacker',
        isinternal: 'true',
      },
      payload: {
        ctx: { userId: 'attacker', isInternal: false },
        userId: 'attacker',
        isInternal: false,
        userid: 'attacker',
        isinternal: 'true',
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS_OK);
    const body = response.json<{ ctx: CapturedCtx; headers: Record<string, unknown> }>();

    const expectedCtx: CapturedCtx = { userId: user.id, clientId: null, isInternal: true, entityId: entityA };
    expect(body.ctx).toEqual(expectedCtx);
    expect(body.headers['authorization']).toBeUndefined();

    // Two interleaved requests with two different sessions each capture their own userId.
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: STUB_CAPTURE_PATH, headers: { authorization: `Bearer ${session.token}` } }),
      app.inject({
        method: 'POST',
        url: STUB_CAPTURE_PATH,
        headers: { authorization: `Bearer ${otherSession.token}` },
      }),
    ]);
    const firstBody = first.json<{ ctx: CapturedCtx }>();
    const secondBody = second.json<{ ctx: CapturedCtx }>();
    expect(firstBody.ctx.userId).toBe(user.id);
    expect(secondBody.ctx.userId).toBe(otherUser.id);
  });

  it('a client-type or inactive user is refused', async () => {
    // A client-portal user cannot hold identity.user_entities access at all (SCR-RLS-01 database
    // guard, verified in the VERIFY pass) — no addUserEntity call for this fixture, unlike every
    // internal-user fixture above.
    const clientUser = await createFixtureUser({ userType: 'client', clientId: randomUUID(), isActive: true });
    const clientSession = await issueFixtureSession(clientUser.id);

    const inactiveUser = await createFixtureUser({ userType: 'internal', isActive: true });
    await addUserEntity(inactiveUser.id, entityA);
    const inactiveSession = await issueFixtureSession(inactiveUser.id);
    await deactivate(inactiveUser.id);

    const app = buildServer({ routes: [captureStubRoute()] });

    for (const token of [clientSession.token, inactiveSession.token]) {
      const response = await app.inject({
        method: 'POST',
        url: STUB_CAPTURE_PATH,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(HTTP_STATUS_UNAUTHORIZED);
      expect(response.json<Problem>()).toEqual(UNAUTHORIZED_PROBLEM.body);
    }
  });

  it('X-Entity-Id selects the active entity or is refused', async () => {
    const user = await createFixtureUser({ userType: 'internal', isActive: true });
    await addUserEntity(user.id, entityA);
    const session = await issueFixtureSession(user.id);

    const app = buildServer({ routes: [captureStubRoute()] });

    const withA = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization: `Bearer ${session.token}`, 'x-entity-id': entityA },
    });
    expect(withA.statusCode).toBe(HTTP_STATUS_OK);
    expect(withA.json<{ ctx: CapturedCtx }>().ctx.entityId).toBe(entityA);

    const withB = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization: `Bearer ${session.token}`, 'x-entity-id': entityB },
    });
    expect(withB.statusCode).toBe(PROBLEM_STATUS.FORBIDDEN);
    expect(withB.json<Problem>()).toHaveProperty('type');

    const withMalformed = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization: `Bearer ${session.token}`, 'x-entity-id': 'not-a-uuid' },
    });
    expect(withMalformed.statusCode).toBe(PROBLEM_STATUS.FORBIDDEN);
    expect(withMalformed.json<Problem>()).toHaveProperty('type');

    const twoEntityUser = await createFixtureUser({ userType: 'internal', isActive: true });
    await addUserEntity(twoEntityUser.id, entityA);
    await addUserEntity(twoEntityUser.id, entityB);
    const twoEntitySession = await issueFixtureSession(twoEntityUser.id);

    const withoutHeader = await app.inject({
      method: 'POST',
      url: STUB_CAPTURE_PATH,
      headers: { authorization: `Bearer ${twoEntitySession.token}` },
    });
    expect(withoutHeader.statusCode).toBe(PROBLEM_STATUS.UNPROCESSABLE_ENTITY);
    expect(withoutHeader.json<Problem>()).toHaveProperty('type');
  });
});

