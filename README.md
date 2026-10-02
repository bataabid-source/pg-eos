# pg-eos

Premium Group — Enterprise Operating System.

pg-eos is a modular monolith built in TypeScript for enterprise operations spanning sales, warehouse operations, delivery, billing, HR, fleet, identity, and platform governance. The repository follows a strict hexagonal architecture, database-first governance, and a gate-based delivery process enforced by scripts and CI.

## Stack

- TypeScript, Node.js >= 22
- Fastify for HTTP APIs
- PostgreSQL with RLS and DB-level invariants
- Drizzle for schema and migrations
- React + TanStack Router for admin UI
- Expo + PWA for PDA workflows
- XState v5 for explicit state transitions
- pnpm + Turbo for workspace orchestration
- Docker Compose for Tier 0 local execution

## Repository structure

```text
apps/
  admin/       Admin UI
  api/         Fastify host
  pda/         PDA app
  worker/      Outbox relay worker

modules/
  billing/
  catalog/
  fleet/
  hr/
  identity/
  imile/
  platform/
  sales/
  tms/
  wms/

packages/
  api-kit/
  contracts/
  db/
  domain-kit/
  events/
  i18n/
  identity/
  logger/
  documents/

database/
  migrations/
  schema/

docs/
  adr/
  notes/
  package/
  state/

scripts/
  ... repository tooling and enforcement

tests/
  hooks/
  isolation/
  ops/
  scenarios/
```

## Core operational rules

- All DB access goes through withContext(ctx, fn)
- Every write endpoint requires an Idempotency-Key
- Every mutable aggregate includes a version column
- Domain events are written to platform.outbox in the same transaction
- All operational tables enforce RLS
- The project enforces lock ownership via tasks/LANE_LOCKS.md
- Migrations are numbered and tracked in database/migrations/README.md

## Quick start

```bash
pnpm install

# apply schema
# use the repo's local database setup as defined in the compose + schema scripts

# API
PG_APP_USER=pgeos_app OTP_HMAC_SECRET=secret pnpm --filter @pg-eos/api start

# Worker
PG_APP_USER=pgeos_worker pnpm --filter @pg-eos/worker start

# Admin
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

## Delivery flow

The project is intentionally strict:

1. brief
2. pre-build review
3. scenario + contract
4. migration + RLS review
5. RED tests
6. domain implementation
7. application integration
8. UI acceptance
9. close review
10. one commit

## Priority focus

The immediate work is to stabilize the active PR queue, finish the remaining S1 acceptance steps, and clear the guard and backlog priorities before broadening scope.

## Related docs

- docs/GETTING_STARTED.md
- docs/IMPROVEMENT_PLAN.md
- docs/MASTER_BACKLOG.md
- docs/TROUBLESHOOTING.md
- docs/STREAMS.md
- docs/PROJECT_STATE.md
- database/migrations/README.md
- tasks/LANE_LOCKS.md
