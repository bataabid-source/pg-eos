# @pg-eos/api — the Fastify host (X part 5a, ADR-0006 §1)

Run: `PG_APP_USER=pgeos_app OTP_HMAC_SECRET=… pnpm --filter @pg-eos/api start` (`tsx src/main.ts`, from source; listens on `PORT`, default 3000, host `0.0.0.0`). Liveness: `GET /health → 200 { "status": "ok" }`.

Convention: every `ALL_ROUTES` entry `/<module>/<use-case>/<operation>` is mounted once, on
`modules/<module>/api/<use-case>/handlers` → `handle<Operation>` (else `handle<UseCase>`), with deps
from `composition` → `create<UseCase>Deps({ clock, ids })`, built once at startup. Any mismatch fails startup.

Pipeline: `Authorization: Bearer <session token>` → `verifySessionSubject` in `onRequest`, before the body is parsed (only an active `internal`
user passes; every other cause is the one `UNAUTHORIZED_PROBLEM`, 401) → 501 sets → `X-Entity-Id`
entity scope (403 / 422) → handler with `{ headers (no authorization), body (GET: query), ctx }`.

501 sets: routes marked `contractFirst` in `packages/contracts` (ADR-0006 §4, X part 12) answer 501
until their `handlers` file exists and are mounted as soon as it does (one startup warning per
stale mark); `NOT_MOUNTED_UNTIL_2_16_PART_1A_5` in `src/route-table.ts` (the two otp-login routes)
is a security hold. No public routes.

Recorded gaps:
- GET query values arrive as strings; numeric contract fields need coercion in the contracts.
- The unimplemented mark belongs in `packages/contracts`; 401/404/413/415/501 are not in the OpenAPI document.
- Body limit `BODY_LIMIT_BYTES` = Fastify's default 1 MiB (nginx allows 25m); JSON bodies only; no HEAD routes. `/ready` deferred.
- No `build` script: the host runs from source under `tsx` (5c's image runs the same command).

Container (X part 5c): `apps/api/Dockerfile` is the one image for `api` and `worker` (`infra/docker/docker-compose.yml`).
Schema: `docker compose -f infra/docker/docker-compose.yml run --rm -e PGUSER=postgres api bash database/schema/apply.sh`;
start: `docker compose -f infra/docker/docker-compose.yml up -d api worker` (api on `127.0.0.1:3000`).
Role passwords (Tier 0): `scripts/set-role-passwords.sh` from the host env; locally empty (trust).
