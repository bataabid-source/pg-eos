# SLICE BRIEF — WBS 2.11 part 4 · two remaining orphaned describes

Task: 2.11 part 4 — the two describe/scenario naming items deferred from part 3      Lane: 1      Lock: `wms/process-outbound` + `wms/receive-inbound` (both already held, test-files-only)
Owner: WH_MGR      Deps: 2.11 part 3 DONE (`f30f7c7`)      Worktree: `../pg-eos-lane-1`, branch `lane/1-2.11p4` (on origin/main `f30f7c7`)
Model routing: pg-tester sonnet, ONE review round. Lane session sonnet, effort medium — orchestrates only.
No new use case, no migration, no builder delegation — both items are test-files-only, same discipline as part 3.

## Item A — `describe('Scenario: Allocate writes outbox + audit, never a stock_movements row (WBS 2.11 part 2, Master decision 2)', ...)` (process-outbound.test.ts, ~line 1966)
Content is correct (verified this session: two `it`s covering full allocation → one `wms.outbound.allocated` event + one audit row + no stock_movements row, and partial allocation → one `wms.outbound.partially_allocated` event + one audit row + no stock_movements row). The ONLY problem is the disallowed suffix. Fix:
1. Strip the suffix from the `describe` title in process-outbound.test.ts: `Scenario: Allocate writes outbox + audit, never a stock_movements row` (no suffix).
2. Add a matching `Scenario:` block to process-outbound.feature (no suffix), Given/When/Then describing exactly the two `it`s' existing behavior — full allocation and partial allocation each write exactly one correctly-typed outbox event + one audit row + zero stock_movements rows.

## Item B — `describe('Scenario: Condition 1 fails — the client has no active contract at all', ...)` (process-outbound.test.ts, ~line 968)
Two `it`s: (1) no `sales.contracts` row at all — correctly asserts `ContractNotActiveError`, NOT `ContractExpiredError`, status stays draft, zero outbox/audit rows. (2) client's only contract is `status='draft'` — currently asserts only `ContractNotActiveError` + i18nKey + status draft, MISSING the `not.toBeInstanceOf(ContractExpiredError)` and zero-outbox/zero-audit assertions test (1) has. Fix (the more thorough option, not narrowing scope): add the two missing assertions to test (2) so BOTH branches genuinely satisfy the same claim, THEN add a matching `Scenario:` block to process-outbound.feature (title unchanged, no suffix issue here) whose Then clause accurately covers both Given branches — do not narrow the Given/Then to one branch, since after this fix both branches will genuinely support the full claim.

## Read ONLY (workers)
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. `modules/wms/tests/process-outbound/process-outbound.test.ts` lines 960-1030 (item B's two `it`s, verbatim, already quoted above) and lines 1964-2015 (item A's two `it`s, verbatim, already quoted above)

## Not separately read (viewed directly when editing)
`modules/wms/tests/process-outbound/process-outbound.feature` (both items add a Scenario block here, view directly, this lock already grants write access to this file per part 3's amendment).

## Write ONLY
- pg-tester: `modules/wms/tests/process-outbound/process-outbound.test.ts` (item A's rename, item B's two new assertions) · `modules/wms/tests/process-outbound/process-outbound.feature` (item A's new scenario, item B's new scenario).
Forbidden for every worker: any domain/application/infrastructure/api file, `database/schema/**`, `packages/**`, other modules, `docs/**`, `scripts/**`, `CLAUDE.md`, `.claude/**`.

## Acceptance criterion — closes WBS 2.11's naming discipline item (condition 10 remains separately BLOCKED, G-01, SCR-WMS-OUT-02 — this part does NOT close WBS 2.11's row)
Every `describe('Scenario: ...', ...)` in process-outbound.test.ts has an exact matching title in process-outbound.feature, and both items' test content genuinely supports their scenario's full Given/When/Then claim.
Gates: `pnpm --filter @pg-eos/wms typecheck && lint` (root eslint workaround) green · `PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos PG_APP_USER=pgeos_app pnpm --filter @pg-eos/wms test -- process-outbound` green · guards green · pg-reviewer PASS, ONE round.

## Deliver
- `modules/wms/tests/process-outbound/process-outbound.test.ts` (edited)
- `modules/wms/tests/process-outbound/process-outbound.feature` (edited)

Migration number: none.
Stop-and-ask if: a genuine content mismatch beyond what's described above is found — report, don't silently paper over it.
