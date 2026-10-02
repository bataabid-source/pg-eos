# Getting Started

This document gives the shortest reliable path from a fresh clone to a working environment.

## Repository expectations

- Node.js >= 22
- pnpm 9.15.9
- Docker and Docker Compose for local database and runtime services
- PostgreSQL available through the project compose stack or a local installation compatible with the repo's migration rules

## Install

```bash
pnpm install
```

## Database initialization

Use the repository's schema and migration flow before running app processes.

```bash
docker compose -f infra/docker/docker-compose.yml run --rm -e PGUSER=postgres api bash database/schema/apply.sh
```

## Environment and role setup

Some services require app-role environment variables and role checks.

```bash
bash scripts/set-role-passwords.sh
```

## Run the API

```bash
PG_APP_USER=pgeos_app OTP_HMAC_SECRET=secret pnpm --filter @pg-eos/api start
```

The API listens on the default port configured by the app and exposes a health endpoint used during runtime checks.

## Run the worker

```bash
PG_APP_USER=pgeos_worker pnpm --filter @pg-eos/worker start
```

The worker is the dedicated outbox relay process and must run under the non-superuser service role.

## Run the admin UI

```bash
pnpm --filter @pg-eos/admin dev
```

## Validation commands

```bash
pnpm check:setup
pnpm check:locks
pnpm lint
pnpm typecheck
pnpm test
pnpm guards:run
pnpm test:scenarios
```

## Immediate priority state

The active workstreams need to stabilize the open PR queue and close the remaining S1 acceptance blockers before broadening into secondary work.

## Related docs

- README.md
- docs/IMPROVEMENT_PLAN.md
- docs/MASTER_BACKLOG.md
- docs/TROUBLESHOOTING.md
- docs/STREAMS.md
- database/migrations/README.md
