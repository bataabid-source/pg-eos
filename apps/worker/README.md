# @pg-eos/worker — the outbox relay worker (X part 5b, ADR-0006 §1)

One process that runs `relayOnce` (`@pg-eos/events`) on a schedule as the dedicated non-superuser
service role `pgeos_worker` (migration `0039_M_worker-role-outbox-relay.sql`).

- Start: `pnpm --filter @pg-eos/worker start` (`tsx src/main.ts`). `PG_APP_USER` must be
  `pgeos_worker`; any other value (including `postgres` or `pgeos_app`) is fatal before connecting,
  and the connected role is re-checked in `pg_roles` (not superuser, not BYPASSRLS).
- Interval: `RELAY_INTERVAL_SECONDS = 1` (doc 36 §3-1, 13B:145). The `RELAY_INTERVAL_SECONDS`
  environment override is accepted in every environment — nothing enforces "tests only"; the tests
  use it, production leaves it unset. A value that is not a finite number > 0 is fatal at startup.
- Subscribers: registered only in `src/subscribers.ts` (doc 40 §B3). None today; the worker logs
  "0 subscribers registered — relay idle" once and idles until row 4.3 adds `billing`.
- Single instance only: `relayOnce` takes no row lock (backlog "X part 5b part 2").
- Stop: SIGTERM/SIGINT finishes the in-flight tick, closes the pool and exits 0.
- Logs: pino (`@pg-eos/logger`), one line per tick.

Container (X part 5c): compose service `worker` runs the api's image (`pg-eos/app:local`, `apps/api/Dockerfile`)
with `node --import tsx src/main.ts` from `/app/apps/worker`, one replica, `init: true`, stop on SIGTERM.
Schema first: `docker compose -f infra/docker/docker-compose.yml run --rm -e PGUSER=postgres api bash database/schema/apply.sh`;
then `docker compose -f infra/docker/docker-compose.yml up -d api worker`. Password: `scripts/set-role-passwords.sh`.
