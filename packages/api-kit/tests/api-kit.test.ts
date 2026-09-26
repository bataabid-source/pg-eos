// packages/api-kit/tests/api-kit.test.ts — pure tests of the shared api/ helper set; no database.

import { describe, expect, it } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS } from '@pg-eos/contracts';

import {
  HTTP_STATUS_OK,
  PROBLEM_TYPE_BASE,
  buildIdem,
  canonicalize,
  findHeader,
  requestHashOf,
  requireIdempotencyKey,
} from '../index.js';

const KEY = 'key-1';
const ENDPOINT = 'test.api-kit.endpoint';

describe('@pg-eos/api-kit', () => {
  it('findHeader matches the header name case-insensitively', () => {
    const headers = { 'IDEMPOTENCY-key': KEY, other: 'x' };
    expect(findHeader(headers, 'idempotency-key')).toBe(KEY);
    expect(findHeader(headers, IDEMPOTENCY_KEY_HEADER_NAME)).toBe(KEY);
    expect(findHeader(headers, 'absent')).toBeUndefined();
  });

  it('requireIdempotencyKey returns a 400 Problem when the header is absent', () => {
    const failure = requireIdempotencyKey({});
    expect(failure).toEqual({
      status: PROBLEM_STATUS.BAD_REQUEST,
      body: {
        type: `${PROBLEM_TYPE_BASE}idempotency-key-required`,
        title: 'Idempotency-Key required',
        status: PROBLEM_STATUS.BAD_REQUEST,
        detail: `every write endpoint requires the ${IDEMPOTENCY_KEY_HEADER_NAME} header (doc 40 §A4).`,
        instance: '',
      },
    });
  });

  it('requireIdempotencyKey returns undefined when the header is present', () => {
    expect(requireIdempotencyKey({ [IDEMPOTENCY_KEY_HEADER_NAME]: KEY })).toBeUndefined();
  });

  it('canonicalize is key-order stable, so reordered bodies hash the same', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const reordered = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(reordered)));
    expect(requestHashOf(a)).toBe(requestHashOf(reordered));
    expect(requestHashOf({ list: [1, 2] })).not.toBe(requestHashOf({ list: [2, 1] }));
  });

  it('buildIdem returns the IdempotencyInput with a null entity and the OK success status', () => {
    const body = { z: 1, a: 2 };
    const idem = buildIdem({ headers: { 'idempotency-key': KEY } }, ENDPOINT, body);
    expect(idem).toEqual({
      key: KEY,
      endpoint: ENDPOINT,
      requestHash: requestHashOf(body),
      entityId: null,
      successStatus: HTTP_STATUS_OK,
    });
    expect(idem.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('buildIdem throws when the header is missing', () => {
    expect(() => buildIdem({ headers: {} }, ENDPOINT, {})).toThrow(/Idempotency-Key header missing/);
  });
});
