// apps/api/src/auth.ts — X part 5a. Session token → subject → WithContextCtx, fail-closed.
//
// Only an active `internal` user gets a ctx in this part (brief default 3); every other outcome —
// missing, malformed, unknown, expired, revoked, inactive, client, agent — is the ONE
// UNAUTHORIZED_PROBLEM, so the reply never reveals account state.

import { problem, type ApiFailure } from '@pg-eos/api-kit';
import type { WithContextCtx } from '@pg-eos/db';

import { AUTHORIZATION_HEADER, type RawHeaders } from './headers.js';
import { HTTP_STATUS_UNAUTHORIZED } from './http-status.js';

export const UNAUTHORIZED_PROBLEM: ApiFailure = problem(
  HTTP_STATUS_UNAUTHORIZED,
  'Unauthorized',
  'A valid session is required. (Allowed: send Authorization: Bearer <session token>.)',
);

/** The structural shape of `verifySessionSubject`'s result (@pg-eos/identity-mechanisms). Kept
 *  structural so an injected verifier (tests) only has to report the fields the host reads. */
export interface SubjectReport {
  readonly valid: boolean;
  readonly userId?: string;
  readonly userType?: string;
  readonly clientId?: string | null;
  readonly isActive?: boolean;
}

export type VerifySubject = (token: string) => Promise<SubjectReport>;

export interface AuthenticatedSubject {
  readonly userId: string;
}

export type AuthenticationResult =
  | { readonly ok: true; readonly subject: AuthenticatedSubject }
  | { readonly ok: false; readonly problem: ApiFailure };

const INTERNAL_USER_TYPE = 'internal';

/** `Bearer <token>`: scheme case-insensitive, exactly one space, one non-empty token without
 *  whitespace. Anything else → undefined. */
const BEARER_PATTERN = /^bearer (\S+)$/i;

export function parseBearer(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) return undefined;
  const match = BEARER_PATTERN.exec(headerValue);
  return match?.[1];
}

const REFUSED: AuthenticationResult = { ok: false, problem: UNAUTHORIZED_PROBLEM };

export async function authenticate(
  headers: RawHeaders,
  verifySubject: VerifySubject,
): Promise<AuthenticationResult> {
  const raw = headers[AUTHORIZATION_HEADER];
  const token = parseBearer(typeof raw === 'string' ? raw : undefined);
  if (token === undefined) return REFUSED;

  const subject = await verifySubject(token);
  if (
    subject.valid !== true ||
    subject.userType !== INTERNAL_USER_TYPE ||
    subject.isActive !== true ||
    typeof subject.userId !== 'string'
  ) {
    return REFUSED;
  }
  return { ok: true, subject: { userId: subject.userId } };
}

/** The request ctx of an authenticated internal subject — built per request, never stored. */
export function ctxFor(subject: AuthenticatedSubject, entityId: string): WithContextCtx {
  return { userId: subject.userId, clientId: null, isInternal: true, entityId };
}

/** The ctx `createUserEntitiesLookup` needs to read the subject's own entity set. */
export function subjectCtxFor(subject: AuthenticatedSubject): WithContextCtx {
  return { userId: subject.userId, clientId: null, isInternal: true };
}
