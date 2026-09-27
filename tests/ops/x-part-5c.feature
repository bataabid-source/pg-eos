# tests/ops/x-part-5c.feature — X part 5c (pg-tester).
#
# One image, `api` + `worker` compose services, gate ⑦ image build in CI (ADR-0006 §1, third of
# four parts). This is the executable spec behind tests/ops/tests/x-part-5c.test.ts. Scenario
# wording is copied verbatim from the slice brief's Scenario block
# (docs/notes/slice-briefs/_slice-X-part-5c.brief.md).

Feature: X part 5c — one image, api and worker services, gate ⑦

  Scenario: the compose file renders the documented services on one image
    When docker compose -f infra/docker/docker-compose.yml config --no-interpolate --format json is parsed
    Then services postgres, api and worker exist, pgadmin still carries profile tools, and no other service exists
    And api builds from the repository root context with dockerfile apps/api/Dockerfile and worker declares no build but the same image name as api and a command override
    And api sets PG_APP_USER=pgeos_app, PGHOST=postgres, PORT=3000, publishes only 127.0.0.1:3000, init true, restart unless-stopped
    And worker sets PG_APP_USER=pgeos_worker, PGHOST=postgres, publishes no port, has container_name pg-eos-worker, deploy.replicas = 1, stop_signal SIGTERM, init true, pull_policy never, restart unless-stopped
    And api and worker depend on postgres with condition service_healthy
    And outside pgadmin (D-108), every environment value whose key contains PASSWORD is a ${…} reference with an empty default

  Scenario: one non-root Node 22 image serves both processes
    Then apps/api/Dockerfile exists and no other Dockerfile exists under apps/
    And it starts FROM node:22-bookworm-slim, sets COREPACK_HOME to a world-readable path before corepack prepare pnpm@9.15.9, installs postgresql-client-16, runs pnpm install --frozen-lockfile and pnpm build
    And it ends with USER node and a CMD that runs node --import tsx directly (no pnpm at PID 1) from WORKDIR /app/apps/api
    And it contains no ENV or ARG whose name contains PASSWORD, SECRET or TOKEN
    And it declares a HEALTHCHECK that reads PORT from the environment and sets --start-period=30s

  Scenario: the build context leaves secrets and data out
    Then .dockerignore lists .git, **/.env, **/.env.*, **/data/, **/node_modules/, **/dist/, **/coverage/, **/.turbo/, **/reports/, **/*.pem, **/*.key, **/*.dump, **/*.bak, **/*.tgz

  Scenario: gate ⑦ builds for linux/arm64, runs the stack once on amd64 and pushes nothing
    When .github/workflows/ci.yml is read
    Then a job whose name starts with "⑦" exists with timeout-minutes set, uses docker/setup-qemu-action@v3 and docker/setup-buildx-action@v3
    And it builds apps/api/Dockerfile with platforms linux/arm64 and push: false, and once more for linux/amd64 with load: true
    And it runs docker compose config -q, starts postgres, applies the schema with docker compose run --rm -e PGUSER=postgres api bash database/schema/apply.sh, starts api and worker with up -d --wait, asserts GET http://127.0.0.1:3000/health is 200 and the worker log (retried, bounded) contains "relay loop starting", then compose down -v
    And the ②③ job carries a pnpm test:ops step
    And the header comment no longer says gate ⑦ is outside CI

  Scenario: role passwords come from the host, never from the repository or a process list
    Given scripts/set-role-passwords.sh
    Then it reads PG_APP_PASSWORD and PG_WORKER_PASSWORD only through psql \getenv on a stdin script (no -v/--set, no interpolation into SQL) and sets local log_statement = 'none' before each alter role
    When it runs with either variable unset or empty
    Then it exits 2 before any SQL, naming the missing variable
    And run against the local database (PGHOST loopback or the CI service only, PGUSER=postgres) with two random values, pg_authid.rolpassword of pgeos_app and pgeos_worker both start with SCRAM-SHA-256$, a second run succeeds, and no output line contains either value
    And afterAll restores each role's rolpassword to the value read in beforeAll (password null when it was null)
