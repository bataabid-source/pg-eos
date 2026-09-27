# ADR-0006 — One API host, one outbox worker and one image before wave 1

**Status:** Accepted
**Date:** 2026-09-27
**Approved by:** GM (D-193, decision D2 أ: "استضافة API قبل الموجة 1: أ" — option أ of the deep-review questionnaire, "مهمة Master قبل إطلاق الموجة 1")
**Reviewed & accepted: opus** (architecture reviewer of the 2026-09-27 deep review; static reading of `origin/main @ fc4c6d4`)
**References:** CLAUDE.md · ARCHITECTURE (NestJS (Fastify) · pg-boss · Docker Compose Tier 0) and DEPLOYMENT PIPELINE (gate ⑦) · `modules/wms/api/receive-inbound/handlers.ts:3-7` ("No NestJS app exists yet") · `packages/api-kit/index.ts:14-18` (`ctx` supplied by the caller) · `packages/events/src/relay.ts` (`relayOnce`, `registerSubscriber` — no production caller) · `packages/contracts/_shared/registry.ts` + `packages/contracts/openapi/openapi.json` (82 operations, 72 handlers) · `infra/docker/docker-compose.yml` (services: postgres, pgadmin) · `tests/scenarios/S1.spec.ts:21-22` (scenarios import handlers in-process) · `tests/scenarios/playwright.config.ts` (no browser project) · `docs/STREAMS.md` (wave 1) · ADR-0005 §3 (contracts frozen before a wave).

## Context (السياق)
- No process serves the system: the repository has no `@nestjs/*` or `fastify` dependency, no `listen(` call, and no file that maps the contract `ROUTES` to the 72 exported handlers in `modules/*/api/*/handlers.ts`. Every handler takes a `WithContextCtx` from its caller (`packages/api-kit/index.ts:14-18`); nothing derives one from a session token.
- Nothing drains `platform.outbox`: 31 files write it, `relayOnce` and `registerSubscriber` have zero production callers, and pg-boss is absent (six comments mention it).
- Nothing builds an image: `infra/` holds one compose file with postgres and pgadmin; there is no Dockerfile, and `.github/workflows/ci.yml:1-2` states that gate ⑦ is not part of CI.
- Acceptance is in-process: `tests/scenarios/S1.spec.ts` and `S2.spec.ts` call the wms handlers directly under a Playwright runner with no browser and no HTTP; `tests/scenarios/green.json` is empty, so gate ④ and G15 pass without exercising the system (`scripts/scenarios-verdict.mjs:95-105`).
- ADR-0005 defines DONE as "scenario green in Playwright" and plans wave 1 (2.16→2.18, 4.1b p2→4.19→4.20). Without a host, a wave can only add more handlers that no scenario can reach over HTTP.

## Decision (القرار)
1. Before wave 1 starts, the Master builds one cross-cutting slice (backlog row **X part 5**): `apps/api`, a Fastify host that mounts every `ALL_ROUTES` entry on its handler one-to-one from the registry (no second routing table), derives `WithContextCtx` from the session token through `packages/identity` and refuses a request that carries none; one worker process that runs `relayOnce` on a schedule under a dedicated non-superuser service role; one Dockerfile and `app` + `worker` services in `infra/docker/docker-compose.yml`; gate ⑦ (image build) in CI.
2. S1 and S2 are rewired to call the host over HTTP in the same slice; `green.json` receives the first scenario id the day it is green.
3. NestJS stays the target framework of CLAUDE.md · ARCHITECTURE; the first host is the Fastify adapter alone (the layer NestJS itself runs on) so that the slice is one file tree and one review. Moving the host under NestJS modules is a later, separate ADR if wave 2 needs it; pg-boss replaces the scheduled `relayOnce` loop when a second job type appears.
4. Every route the registry lists without a handler (10 operations today: accounting periods, post-journal, dimension values) is marked unimplemented in the registry and answers 501 until its row is built; `ALL_ROUTES` never mounts a route whose handler does not exist.

## Alternatives rejected (البدائل المرفوضة)
| Alternative | Why rejected |
|---|---|
| Start wave 1 first, host later (D2 ب / ج) | Every wave-1 row would be DONE only by in-process tests; ADR-0005's "scenario green" would keep meaning "function called", and the pilot could still not be started. |
| Full NestJS application now | Doubles the slice (modules, providers, DI) before any route is served; the Fastify host is the same runtime and can be wrapped later without touching handlers. |
| Drain the outbox from a cron in CI | Not a runtime; the pilot needs the relay running next to the database. |

## Consequences (الأثر)
- Positive: the first HTTP-served scenario within the enablement week; gate ④/G15 become real; S1–S20 can be written against the system instead of its functions; gate ⑦ exists.
- Negative / risks: one Master slice (≈ 2 days) before wave 1; a session→ctx guard is security-relevant and is reviewed on opus before merge; the 2.16 login endpoint is not mounted until 2.16 part 1a-5 (G-16a limits) is DONE.
- Unchanged: handlers, contracts, RLS, the golden slice, the twelve-step loop, migrations.
- Open items for the GM: none; the wave-1 start date moves by the slice's duration.

## Status (الحالة)
Accepted — 2026-09-27 (D-193 D2 أ).
