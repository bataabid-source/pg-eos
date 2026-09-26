# PROJECT_STATE — PG-EOS

**Hard limit: 40 lines.** Older history lives in `docs/CHANGELOG.md` (CLAUDE.md · OPERATING RULES · BRIEFS). Maintained by pg-scribe only, in the same commit as the task it records.

| field | value |
|---|---|
| Phase | 0 CLOSED · 1 Commercial Core (done except 1.11, BLOCKED D-178) · 2 Warehouse (9/19) · pilot-first (D-127): seed 019 + synthetic data. Doc 38 **v4.6 (154 rows, D-187/ADR-0004)**. |
| Current task | Lane 1: **2.12 part 1 DONE-in-part; part 2 open (4 items) — 2.12 DONE when part 2 lands** (PickLine + CheckOrder committed @ `3edf84b`; part 2 = 4 deferred items + Pack/Load) in `wms/process-outbound` — 2.11 DONE @ `f9aeecc`. Lane 2: **WBS 4.1a part 1 DONE-in-part; part 2 open (write path + `billing.gl_account_change_requests`, design ruled D-190) — 4.1a DONE when part 2 lands @ `<this commit>`** — CoA structure/class CHECKs, no write path (deferred, see part 2 below); `billing` lock held, next: 4.1b. Lane 3: **3.13 part 1 DONE-in-part @ `<this commit>`** — `CalculateDailyCommission` command, migration 0027 applied; round 2 FAILED(7 findings, one a real Kuwait-midnight timezone bug), no round 3 (REVIEW CAP), part 2 filed in MASTER_BACKLOG, `hr`+`imile` locks held (3.12 part 1 DONE-in-part @ `b9c3b1d`, part 2 also open). One DB per lane (`bash scripts/lane-db.sh <id>`, P4a @ `436be60`). |
| Golden slice / tier / schema / session model | 2.9 ACCEPTED (`.golden-slice-accepted`, `scripts/new-slice.sh` active) · Pilot Tier 0 = local Docker `postgres:16` (D-129), Oracle DEFERRED-POST-PILOT · migrations 0001–0028 applied (0022 withdrawn), next free **0029** · D-174/D-180 session model: lane sessions sonnet/medium, Master sonnet/medium (opus only ADR/security/D-117), pg-reviewer opus, no haiku |

## Lanes

| lane | task | module lock | worktree |
|---|---|---|---|
| 1 | 2.12 part 1 DONE-in-part; part 2 open (4 items) — 2.12 DONE when part 2 lands (2.11 DONE, all ten conditions) | `wms/process-outbound` (`wms/receive-inbound` released this commit — 183/183 clean on `pgeos_lane1`, orphans confirmed, nothing to carry) | `../pg-eos-lane-1` |
| 2 | 4.1a part 1 DONE-in-part; part 2 open (write path + `billing.gl_account_change_requests`, design ruled D-190) — 4.1a DONE when part 2 lands; 4.1b next | `billing` | `../pg-eos-lane-2` |
| 3 | 3.13 part 1 DONE-in-part @ `6c16c41`; part 2 open (7 round-2 findings incl. timezone bug, MASTER_BACKLOG); 3.12 part 1 DONE-in-part @ `b9c3b1d`, part 2 also open (8 round-2 findings); `hr`+`imile` held; then 3.4 once 2.12 DONE | `hr`, `imile` | `../pg-eos-lane-3` |

## Last 5 DONE (newest first)
| task | commit |
|---|---|
| 4.1a part 1 — CoA structure X-XX-XXX-XXX + class 1-9; domain + contract + two DB CHECKs, migration 0028 (lane 2), no write path (deferred to part 2) — PASS(18 findings, 2 rounds: round 1 FAIL(10) → round 2 FAIL(8, SoD/citation correction — SYSADMIN grant withdrawn) → confirmation PASS(0)) | `<this commit>` |
| 3.13 part 1 — `CalculateDailyCommission` command, migration 0027 (lane 3), DONE-in-part — round-1 fixes applied; round 2 FAIL(7 findings incl. a real Kuwait-midnight timezone bug), no round 3 (REVIEW CAP), part 2 opened | `6c16c41` |
| 2.12 part 1 — PickLine + CheckOrder (lane 1), DONE-in-part; part 2 open (4 items) — 2.12 DONE when part 2 lands — PASS(6 findings clean of 9, 3 deferred, 2 rounds); `wms/receive-inbound` released, 183/183 clean on `pgeos_lane1` | `3edf84b` |
| 4.2 part 3 — close deferred findings: stale test comments, non-canonical-qty regression test (lane 2) — **WBS 4.2 DONE @ `4ba65a4` — all three parts** — PASS(0 findings, 1 rounds) | `4ba65a4` |
| 3.12 part 1 — `AssignDriverId` command, no migration (lane 3), DONE-in-part — round-1 fixes applied; round 2 FAIL(8 findings), no round 3 (REVIEW CAP), part 2 opened | `b9c3b1d` |

## Blockers

- `scripts/deploy.sh` missing (G15–G17 NOT RUNNABLE, non-blocking, 0.6b DEFERRED-POST-PILOT). Open G-01 items: G8 anchor storage (≥2028-03, D-115); 3.12/3.14/3.17 imile tables missing `entity_id`/CHECKs/outbox, row m (over-broad termination-trigger reset) (`docs/notes/2026-09-24-imile-agent-scenario.md` §4); 2.15 `space_reservations.qty` no DB CHECK; 3.1 `hr.shift_groups.vehicle_id` pre-existing assignment column the new gate doesn't cover (GM call, `tasks/backlog/MIGRATION-REQUEST-3.md`); INV-C4-1 DB-level enforcement on `tms.delivery_tasks`/`tms.routes.vehicle_id`, required before WBS 3.4, same pattern as `wms.check_space_available()`; 4.2's round-2 G14 red is external — lane 1's own uncommitted migration 0026 on the shared dev DB, not lane 2's to fix; CI's ephemeral DB is the real merge gate.
- 3.12 part 2 (lane 3, `imile`): 8 round-2 findings (schema-line citations, dead-trigger-name comment, nil-UUID domain/contract mismatch, two untested race-condition branches, missing audit assertion, weak RLS-outsider assertion, 2 G-01 rows, G14 rebase-blocked on migration 0026 — now resolved by this rebase) — see MASTER_BACKLOG. 3.13 part 2 (lane 3, `hr`): 7 round-2 findings, most importantly a REAL BUG — work_date/assignment-window comparisons use the session's implicit TimeZone, not an explicit Asia/Kuwait business-day boundary, causing wrong commission money around Kuwait midnight (doc 40 §A3); plus a raw-RLS-500 vs typed-error gap, a missing property test on `computeGrossCommission`, a weak isolation-test positive control, and stale RED comments — see MASTER_BACKLOG. · 4.1a part 2 (lane 2, `billing`): design ruled (D-190): `billing.gl_accounts.manage` (four-eyes via `platform.approval_chains`, CFO approval); `platform.reference.manage` stays holderless (doc 22:186); also carries SCR-ACC-01 §5 row 29 (`identity.roles` seed, cross-module) — see MASTER_BACKLOG. 3.12 part 2 (lane 3, `imile`): 8 round-2 findings (schema-line citations, dead-trigger-name comment, nil-UUID domain/contract mismatch, two untested race-condition branches, missing audit assertion, weak RLS-outsider assertion, 2 G-01 rows, G14 rebase-blocked on migration 0026 — now resolved by this rebase) — see MASTER_BACKLOG.
- The two 0.9 WIP branches (`claude/postgresql-16-254336` @ `0217e85`, `claude/resume-4c8ecc` @ `f127ab2`) are never merged, never deleted.
- Batched Master tasks (frozen paths): `entityId` on `WithContextCtx`; SCR-HR-EMP-01 three DB CHECKs; `packages/domain-kit` browser break (node:crypto in browser bundle); root `eslint.config.mjs` cwd bug; X part 2 — resolve-hashes attributes a placeholder to the last commit that edited its line (blame), not the one that introduced it; fix via `git log -L`. Also (P2 review round 2 #3): `scripts/new-slice.sh:11,205` + template text in `modules/{catalog,fleet,hr,imile}/index.ts` cite the retired "SPEED AND QUALITY (v5)" → "OPERATING RULES · REPLICATE"; `packages/i18n` bootstrap (never created — SCR-I18N-01 §1; 2.11/2.9b keys code-referenced only). D-125 cleanup still open (D-132 disposition, `docs/DECISION_LOG.md`): G1/G2 biometric-retention wording (doc 40:668, doc 25:429) needs a GM-set value, none invented; G3 diagram `01-08.mmd/.svg` not regenerated (needs the mermaid renderer).
- WBS 1.11 BLOCKED (D-178) — see `docs/notes/2026-09-25-wbs-1.11-premature.md`. Pre-existing, untouched: ~7 failures in `tests/evaluate-alerts/**` + `tests/integration/{schema-invariants,audit-chain-*}.test.ts`; 8 `tests/receive-inbound` failures from orphaned `wms.locations` (`T9-*`) fixtures.

## Next 3 tasks

1. Lane 1: 2.12 part 2 (4 deferred items + Pack/Load) → 2.16 part 1a (PDA shell + 72-h offline queue + kiosk, OTP login) → 1b (PIN, after SCR-IDN-01) → 2.18 (D-190)
2. Lane 2: 4.1b → 4.19 → 4.20 (ADR-0004); 4.1a part 2 (gl_account_change_requests, ruled) once its RED is written
2. Lane 2: 4.1a → 4.1b → 4.19 → 4.20 (ADR-0004)
