// tests/scenarios/host/health-and-auth.spec.ts — X part 5e, project `host` (request fixture, baseURL
// = the apps/api TCP host booted by the webServer entry). Titles carry no scenario-id token
// (scripts/scenarios-verdict.mjs keys on it).

import { expect, test } from '@playwright/test';

import { HTTP_STATUS_OK } from '@pg-eos/api-kit';

const HEALTH_PATH = '/health';
const HTTP_STATUS_UNAUTHORIZED = 401;
const HEALTH_STATUS_OK = 'ok';
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_KEY_VALUE = 'x-part-5e-host-401-probe';
// packages/contracts/wms/receive-inbound.ts:140-141 (a mounted, parameterless, non-contractFirst route).
const AUTH_PROBE_METHOD = 'POST';
const AUTH_PROBE_PATH = '/wms/receive-inbound/approve-inbound';

test.describe('api host over TCP', () => {
  test('the api host answers GET /health with 200 and status ok over TCP', async ({ request }) => {
    const response = await request.get(HEALTH_PATH);
    expect(response.status()).toBe(HTTP_STATUS_OK);
    expect(await response.json()).toEqual({ status: HEALTH_STATUS_OK });
  });

  test('a mounted route without a Bearer token answers 401 over TCP', async ({ request }) => {
    // The route's OWN method (a wrong method is 404), a static path, no Authorization header.
    const response = await request.fetch(AUTH_PROBE_PATH, {
      method: AUTH_PROBE_METHOD,
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_KEY_VALUE },
      data: {},
    });
    expect(response.status()).toBe(HTTP_STATUS_UNAUTHORIZED);
  });
});
