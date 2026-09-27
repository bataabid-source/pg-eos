// apps/api/src/headers.ts — X part 5a. Fastify's `string | string[] | undefined` header values
// narrowed to api-kit's `ApiHeaders` (`string | undefined`) with no cast: string values are kept
// (lower-cased names), array values are dropped, and `authorization` is stripped so the session
// token never reaches a handler.

import type { ApiHeaders } from '@pg-eos/api-kit';

export const AUTHORIZATION_HEADER = 'authorization';

export type RawHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export function normalizeHeaders(raw: RawHeaders): ApiHeaders {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const lowerName = name.toLowerCase();
    if (lowerName === AUTHORIZATION_HEADER) continue;
    if (typeof value !== 'string') continue;
    normalized[lowerName] = value;
  }
  return normalized;
}
