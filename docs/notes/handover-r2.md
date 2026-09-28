# Handover — R2 (integration lane 3) → R2 successor

Written 2026-09-28 by R2 at M4's rotation request (ADR-0007 context ceiling). Read with CLAUDE.md and
docs/PROJECT_STATE.md; nothing else is required to continue. Next task: **S7** (`/lane 3 — next S7`).

## 1. Branches on origin (all pushed, none merged, none rebased by the lane)

| Branch | Commit | Content | Review |
|---|---|---|---|
| `lane/3-s3` | `140efca` | S3 B2C delivery with SLA — `S3.spec.ts`, `fixtures/delivery.ts` | round 2 FAIL: only blocking item = unscoped G16 (outside slice); 5 text nits open → row **X-S3 part 2** |
| `lane/3-x5d` | `00feb4e` | **X part 5d** (x5d = 5d): S1 over HTTP via `apps/api` `buildServer` + `app.inject`, real `issueSession`, `X-Entity-Id`; `fixtures/host.ts`; S2 untouched | PASS(8, 2) — conditional on dependency adoption (§3) |
| `lane/3-s4` | `e95b7e2` | S4 Station client iMile — `S4.spec.ts`, `fixtures/imile.ts` | PASS(10, 2) |
| `lane/3-s5` | `0a56bdb` | S5 External call-center — `S5.spec.ts`, `fixtures/cc.ts` + `@pg-eos/db` dependency | PASS(6, 2) |
| `lane/3-s6` | `5241c3a` | S6 Multi-entity client — `S6.spec.ts`, `fixtures/credit.ts` | PASS(4, 2) |

`lane/3-s18` and `lane/3-s18-r1` are older S18 branches (S18 is merged), not R2's.
Merge order suggestion: x5d first (it changes S1 and adds a dependency), then S3–S6 (independent files).
Each branch was cut from main at the time; x5d and S3 predate `e2826ff`/`ba875ad`/`439d172` — rebase in the queue.

## 2. S6 status

DONE on `lane/3-s6` @ `5241c3a`. Given BACKED (client with PST/PDL/PCC contracts; credit_limit 15000 via
the real `handleSetCreditLimit`, CFO; overdue approved PST invoice 15500.000). Nightly hold NOT BUILT
(row **4.9**, TODO, depends on 4.7 — row 1.8 manual limit/hold is DONE). PST outbound: stock via the real
receive chain, real checks reach `checks_pending` (all nine non-credit conditions pass) — the missing
"credit hold" rejection is a named consequence of 4.9 only. PDL task NOT BUILT (3.4); PCC queue NOT BUILT (5.1).

## 3. Dependencies (tests/scenarios/package.json + pnpm-lock.yaml) — APPROVED by M4 2026-09-28

| Dependency | Branch | Why |
|---|---|---|
| `"@pg-eos/identity-mechanisms": "workspace:*"` | `lane/3-x5d` | `fixtures/actors.ts` imports `issueSession` to mint real Bearer tokens (the OTP login route was unmounted when 5d was written). Without it, CI ④'s `turbo run build --filter=@pg-eos/scenarios...` does not build `packages/identity`, which `apps/api/src/server.ts` needs at runtime. |
| `"@pg-eos/db": "workspace:*"` | `lane/3-s5` | S5 proves queue isolation through `withContext` (the only built path; RLS live as `PG_APP_USER`). No deep import of `packages/db/src`, no hand-rolled GUCs. |

Both were added by the lane session after pg-tester STOPPED; reviewers judged them in scope but the
lockfile delta is a Master item (doc 36 §5-4 #8 — no new library without a written reason).

## 4. Open questions (non-blocking; defaults taken and recorded in the commits)

1. **Request context for a `user_type 'agent'` subject.** `identity.users.user_type` allows `agent`, but
   `apps/api/src/auth.ts` refuses every non-internal subject and `ctxFor` always builds `isInternal: true`.
   Undecided: which ctx an external call-center agent gets. S5 default: an internal actor with role
   CC_AGENT, `isInternal: true`. The isolation proof does not depend on it — `cc.tickets` policies
   (`entity_scope` permissive + `agent_queue_scope` RESTRICTIVE, SECURITY DEFINER helpers) never read
   `is_internal`. Decide when row 5.1 is built.
2. **Row 5.2's acceptance is "Scenario S5 green"** (38-WBS.md:195). S5 therefore turns green only when
   both 5.1 (cc API + isolation) and 5.2 (CC billing) are built — the row that "closes" S5 is 5.2, not 5.1.
3. **STREAMS mapping.** docs/STREAMS.md assigns no stream to S5, S6 or S10. Proposal for the GM's
   post-streams decision: S5 → rows 5.1 + 5.2; S6 → rows 4.9 (after 4.7), 3.4, 5.1 (its hold must block
   outbound, delivery tasks and CC queues, doc 40 line 48).

## 5. CHANGELOG lines — ADDED in docs/CHANGELOG.md on this branch (five entries, newest first)

One line each, from the commit bodies: X part 5d (dependency + defaults: injected FixedClock routes,
seed 91012 folded, OTP_HMAC_SECRET test value in `fixtures/actors.ts`, session lifetime threshold SEED-ONLY
43); S3 (driver code PG-0301, task status default, pg-tester read breach); S4 (year/time-zone defaults,
doc codes PG-0231/PG-0245/D-0451, shipments driver_code/ofd_at stand-ins, ~185k tokens); S5 (`@pg-eos/db`,
validated-UUID SQL string, isInternal default); S6 (invoice 15500 = limit + 500, INV counter, local
PCC_ENTITY_CODE, ~270k tokens). Each commit body lists the reads outside its brief.

## 6. Backlog row requested

**X-S3 part 2** — the five text-only nits from S3 review round 2 (header wording "rows 3.4, 3.5 and 4.3
land", PROJECT_STATE quote "(stream B)", failure_reason message wording, comment source for the SHOP rule,
PG-0xxx comment completeness). Plus Master follow-ups from 5d: export `apps/api` route mapping
(`tableEntries`) so the scenario host reuses one implementation; move `OTP_HMAC_SECRET` to
`playwright.config.ts`; reword `ci.yml:169-170` ("in-process"); confirm the PG-0xxx employee-code range.

## 7. Known environment facts for the successor

- Unscoped `pnpm guards:run` shows G16 RED: `modules/platform` Stryker initial test run fails (known, X part 4).
  CI scopes G16 to changed `domain/`; test-only slices are green with `G16_MODULES=`.
- Lane DB: `bash scripts/lane-db.sh 3` → `pgeos_lane3`; export `PGDATABASE=pgeos_lane3 PG_LANE=3` per command.
- Briefs that kept pg-tester in budget list the handler + composition files and the fixture signatures up front;
  pg-tester still read fixtures and S1 beyond the list on most slices — include what the scenario needs.
