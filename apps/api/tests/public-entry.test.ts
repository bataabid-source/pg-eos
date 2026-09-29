// apps/api/tests/public-entry.test.ts — X part 5d part 2, item (1)
// (brief `docs/notes/slice-briefs/_slice-X-part-5d-p2-1.brief.md`; Gherkin in
// `apps/api/features/x-part-5d-p2-1.feature`). ONE `it` per scenario, titled verbatim.
//
// The imports below prove the public surface: the barrel `../src/index.js` exports `buildServer`,
// `buildRouteTable`, `hostRoutesFrom` and `isHostResult`, and `../src/host-routes.js` exports
// `mountedHostRoutes`.

import type { ApiRequest } from '@pg-eos/api-kit';
import { HTTP_STATUS_OK } from '@pg-eos/api-kit';
import { describe, expect, it } from 'vitest';

// Imports the public barrel and the host-routes module under test.
import { buildRouteTable, buildServer, hostRoutesFrom, isHostResult } from '../src/index.js';
import type { RouteTable } from '../src/index.js';
import { mountedHostRoutes } from '../src/host-routes.js';

const STUB_PATH = '/test-fixture/echo-deps';
const OTHER_STUB_PATH = '/test-fixture/echo-other';
const STUB_HANDLER_NAME = 'handleEchoDeps';
const OTHER_HANDLER_NAME = 'handleEchoOther';
const STATUS_CREATED = 201;
const STATUS_AS_STRING = '200';
const DEPS_MARKER = { marker: 'deps-bound' };
const OTHER_DEPS_MARKER = { marker: 'other-deps-bound' };
const SUBJECT_USER_ID = '00000000-0000-4000-8000-000000000001';
const ONLY_ENTITY_ID = '00000000-0000-4000-8000-0000000000e1';

/** A request stand-in — the stub handlers read nothing from it. */
const FAKE_REQUEST = {} as unknown as ApiRequest<unknown>;

const echoDepsHandler = async (_request: ApiRequest<unknown>, deps: unknown): Promise<unknown> => ({
  status: STATUS_CREATED,
  body: { deps },
});

function table(mounted: RouteTable['mounted']): RouteTable {
  return { mounted, unimplemented: [] };
}

describe('Feature: apps/api public entry (X part 5d part 2, item 1)', () => {
  it('the public entry exports buildServer, buildRouteTable, hostRoutesFrom and isHostResult', () => {
    expect(typeof buildServer).toBe('function');
    expect(typeof buildRouteTable).toBe('function');
    expect(typeof hostRoutesFrom).toBe('function');
    expect(typeof isHostResult).toBe('function');
  });

  it('isHostResult accepts { status: number, body } and refuses null, a string, { status: "200", body }, and { status } without body', () => {
    expect(isHostResult({ status: HTTP_STATUS_OK, body: {} })).toBe(true);
    expect(isHostResult({ status: STATUS_CREATED, body: undefined })).toBe(true);
    expect(isHostResult(null)).toBe(false);
    expect(isHostResult('a string')).toBe(false);
    expect(isHostResult({ status: STATUS_AS_STRING, body: {} })).toBe(false);
    expect(isHostResult({ status: HTTP_STATUS_OK })).toBe(false);
  });

  it('hostRoutesFrom binds each mounted handler to its deps and returns its { status, body }', async () => {
    const { routes } = hostRoutesFrom(
      table([
        { method: 'POST', path: STUB_PATH, handlerName: STUB_HANDLER_NAME, handler: echoDepsHandler, deps: DEPS_MARKER },
        { method: 'GET', path: OTHER_STUB_PATH, handlerName: OTHER_HANDLER_NAME, handler: echoDepsHandler, deps: OTHER_DEPS_MARKER },
      ]),
    );

    expect(routes).toHaveLength(2);
    const [first, second] = routes;
    expect(first?.method).toBe('POST');
    expect(first?.path).toBe(STUB_PATH);
    expect(second?.method).toBe('GET');
    expect(second?.path).toBe(OTHER_STUB_PATH);
    // Each route answers with ITS OWN entry deps, never the first entry's.
    expect(await first?.handler(FAKE_REQUEST)).toEqual({ status: STATUS_CREATED, body: { deps: DEPS_MARKER } });
    expect(await second?.handler(FAKE_REQUEST)).toEqual({ status: STATUS_CREATED, body: { deps: OTHER_DEPS_MARKER } });
  });

  it('hostRoutesFrom throws when a handler returns no { status, body }', async () => {
    const { routes } = hostRoutesFrom(
      table([
        {
          method: 'POST',
          path: STUB_PATH,
          handlerName: STUB_HANDLER_NAME,
          handler: async () => ({ status: STATUS_AS_STRING }),
          deps: undefined,
        },
      ]),
    );

    await expect(routes[0]?.handler(FAKE_REQUEST)).rejects.toThrow(new RegExp(`${STUB_HANDLER_NAME}.*${STUB_PATH}`));
  });

  it('hostRoutesFrom indexes every mounted route by handler name (method + path) and throws on a duplicate handler name', () => {
    const first = { method: 'POST' as const, path: STUB_PATH, handlerName: STUB_HANDLER_NAME, handler: echoDepsHandler, deps: undefined };
    const second = { method: 'GET' as const, path: OTHER_STUB_PATH, handlerName: OTHER_HANDLER_NAME, handler: echoDepsHandler, deps: undefined };

    const { routeByHandlerName } = hostRoutesFrom(table([first, second]));
    expect(routeByHandlerName.size).toBe(2);
    expect(routeByHandlerName.get(STUB_HANDLER_NAME)).toEqual({ method: 'POST', path: STUB_PATH });
    expect(routeByHandlerName.get(OTHER_HANDLER_NAME)).toEqual({ method: 'GET', path: OTHER_STUB_PATH });

    const duplicate = { ...second, handlerName: STUB_HANDLER_NAME };
    expect(() => hostRoutesFrom(table([first, duplicate]))).toThrow(new RegExp(STUB_HANDLER_NAME));
  });

  it('buildServer({ routes: hostRoutesFrom(table).routes }) serves a mounted route with the stub handler status and body', async () => {
    const mountedTable = table([
      { method: 'POST', path: STUB_PATH, handlerName: STUB_HANDLER_NAME, handler: echoDepsHandler, deps: DEPS_MARKER },
    ]);
    const verifySubject = async () => ({
      valid: true,
      userId: SUBJECT_USER_ID,
      sessionId: SUBJECT_USER_ID,
      userType: 'internal' as const,
      clientId: null,
      isActive: true,
    });
    const lookupEntities = async (): Promise<readonly string[]> => [ONLY_ENTITY_ID];

    const app = buildServer({ verifySubject, lookupEntities, routes: hostRoutesFrom(mountedTable).routes });
    const response = await app.inject({
      method: 'POST',
      url: STUB_PATH,
      headers: { authorization: 'Bearer any-token' },
      payload: {},
    });

    expect(response.statusCode).toBe(STATUS_CREATED);
    expect(response.json()).toEqual({ deps: DEPS_MARKER });
    await app.close();
  });

  // Covers `mountedHostRoutes` through an explicit `routes:`; the default ALL_ROUTES path in server.ts is
  // checked at close review, not here.
  it('buildServer({ routes: mountedHostRoutes(table) }) with two routes sharing one handler name still starts and serves both', async () => {
    const sharedTable = table([
      { method: 'POST', path: STUB_PATH, handlerName: STUB_HANDLER_NAME, handler: echoDepsHandler, deps: DEPS_MARKER },
      { method: 'POST', path: OTHER_STUB_PATH, handlerName: STUB_HANDLER_NAME, handler: echoDepsHandler, deps: DEPS_MARKER },
    ]);
    const verifySubject = async () => ({
      valid: true,
      userId: SUBJECT_USER_ID,
      sessionId: SUBJECT_USER_ID,
      userType: 'internal' as const,
      clientId: null,
      isActive: true,
    });
    const lookupEntities = async (): Promise<readonly string[]> => [ONLY_ENTITY_ID];

    const app = buildServer({ verifySubject, lookupEntities, routes: mountedHostRoutes(sharedTable) });
    for (const url of [STUB_PATH, OTHER_STUB_PATH]) {
      const response = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer any-token' }, payload: {} });
      expect(response.statusCode).toBe(STATUS_CREATED);
      expect(response.json()).toEqual({ deps: DEPS_MARKER });
    }
    await app.close();
  });
});
