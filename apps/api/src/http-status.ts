// apps/api/src/http-status.ts — X part 5a. The host's own HTTP statuses, named once (CLAUDE.md ·
// AGENT CONSTRAINTS "no magic numbers"). PROBLEM_STATUS (@pg-eos/contracts) carries 400/403/409/422
// and api-kit carries 200/500; these are the statuses only the host itself answers.

export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
export const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
export const HTTP_STATUS_NOT_IMPLEMENTED = 501;

/** doc 42 §5: nginx `proxy_pass http://api:3000` — the port the host listens on when PORT is unset. */
export const DEFAULT_PORT = 3000;

const BYTES_PER_KIB = 1024;

/** The request body limit, passed to Fastify explicitly: Fastify's own default (1 MiB), named so
 *  the 413 Problem can state it. Below nginx's `client_max_body_size 25m` (doc 42) — recorded. */
export const BODY_LIMIT_BYTES = BYTES_PER_KIB * BYTES_PER_KIB;
