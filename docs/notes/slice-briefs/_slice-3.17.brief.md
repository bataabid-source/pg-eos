Task: 3.17 DTL live audit engine — gate evaluation mechanism (part 1, doc 38 acceptance "Rule accuracy tracked; open > 24 h escalates; reject is never auto-closed")
Lane: 3          Lock: imile (existing whole-module lock, no new claim — D-186)
Read ONLY:
  - CLAUDE.md
  - .claude/briefs/imile.brief.md
  - modules/imile/application/pull-shipments/{ports.ts,pull-shipments.ts} (nearest own-module precedent: command shape, idempotency-first ordering, audit-row pattern)
  - modules/imile/domain/pull-shipments/invariants.ts (domain style precedent — errors.ts's pattern is trivial/inferable, dropped to hold the D-186 ceiling)
  - docs/package/07-iMile-Automation.md lines 211-227 (§5-1/§5-2 — the five gates G0-G4 in the GM's own words, output shape)
  - database/schema/01-Data-Model.sql lines 1378-1398 (imile.dtl_problems)
  - database/schema/13B-Schema-Reference-Consolidation.sql lines 2382-2394 (chk_dtl_problems_engine_decision/auditor_decision CHECK constraints — the only four allowed decision values)

D-186 budget (GM, self-enforced until the budget-gate script is updated): 8 files here, at the new ≤ 8 file ceiling. Two review rounds max on the same worker for this slice; a third round escalates to the Master directly, same as 3.14 part 2's own precedent (session-tier fixes, no re-delegation).

Write ONLY: modules/imile/{domain,application,infrastructure,api,tests}/evaluate-dtl-problem/** · packages/contracts/imile/evaluate-dtl-problem.ts · modules/imile/index.ts (module barrel — additive named export, same precedent as pull-shipments's own; **review-round 1 finding 12: this was missing from Write ONLY, added here, already fixed directly by the Master**) · packages/contracts/package.json (new-slice.sh's automatic export-registration snippet only, run verbatim — sanctioned Master-tier mechanism, same as pull-shipments/3.14 part 1/WBS 2.15, not a hand-edit; **review-round 2 finding 11: this was missing from Write ONLY, added here**) · docs/notes/2026-09-24-imile-agent-scenario.md (G-01 rows j/k — content-analysis vendor decision needed, imile.dtl_problems has no entity_id — same descriptive-gap class as pull-shipments' own rows g/h/i; **review-round 2 finding 11: this was missing from Write ONLY, added here**) · tests/…
Scenario:
```gherkin
Feature: DTL live audit engine evaluates a raised shipment problem within its gate pipeline

  Scenario: A problem missing required evidence fails G0 (completeness) and goes to a human
    Given a raised DTL problem for tracking number "SHP-2001" with no evidence URLs and no customer or driver text
    When the engine evaluates the problem
    Then the engine_decision is "human"
    And the reason names G0 (completeness) as the failing gate
    And no content-analysis port call is made — an incomplete report never reaches gates G1-G4

  Scenario: A complete problem is evaluated end to end by the content-analysis port (G1-G4)
    Given a raised DTL problem for tracking number "SHP-2002" with evidence URLs, customer text, driver text and a raised_at timestamp
    When the engine evaluates the problem
    Then G0 passes and the content-analysis port is called exactly once with the problem's evidence
    And the engine_decision, engine_confidence and engine_reason come from the port's own result, unmodified
    And one imile.dtl_problems row is inserted with gate_result recording G0 pass plus the port's G1-G4 results

  Scenario: The content-analysis port itself decides reject
    Given a complete raised DTL problem
    And the content-analysis port returns decision "reject" with its own confidence and reason
    When the engine evaluates the problem
    Then the inserted row's engine_decision is "reject"
    And closed_by stays null — this slice never auto-closes anything, "reject" or otherwise (ADR-27 autonomy is a later slice)

  Scenario: The content-analysis port is not configured (production default, no OCR/handwriting vendor decision yet)
    Given a complete raised DTL problem
    And the content-analysis port is the NotConfiguredDtlContentAnalysisPort stub
    When the engine evaluates the problem
    Then the call throws PortNotConfiguredError, mapped to a 500 at the API boundary
    And no imile.dtl_problems row is written — G0 passing alone is never enough to fabricate a G1-G4 result
```
Contract: packages/contracts/imile/evaluate-dtl-problem.ts — one command `EvaluateDtlProblem`, input `{ trackingNo: string (non-empty), driverCode: string | null, problemType: string (non-empty), evidenceUrls: string[], customerText: string | null, driverText: string | null, raisedAt: ISO datetime, correlationId: uuid }` — derive every field from `imile.dtl_problems` (tracking_no, driver_code, problem_type, evidence_urls, customer_text, driver_text, raised_at) — never invent a field not in that table. Result schema `EvaluateDtlProblemResult { id: uuid, engineDecision: 'accept'|'reject'|'human'|'reclassify', engineConfidence: number | null, engineReason: string }`. **Round-1 finding 3, Master decision:** `engineConfidence` is nullable — a G0 failure never computes a confidence score (there is nothing in doc 07 §5-2 or doc 40 to derive one from; `imile.dtl_problems.engine_confidence numeric(5,4)` already allows null, 01:1386), so the G0-fail path stores/returns `null`, never a fabricated `0`. Only the port's own G1-G4 result ever supplies a real confidence number.
Screen/Board spec: none (§5-3 auditor screen is doc 38's own separate acceptance surface, out of scope this slice — no UI)
Deliver (mirrors pull-shipments' own file set, this module's nearest counterpart):
  - modules/imile/domain/evaluate-dtl-problem/{errors.ts,invariants.ts}
  - modules/imile/application/evaluate-dtl-problem/{index.ts,ports.ts,evaluate-dtl-problem.ts}
  - modules/imile/infrastructure/evaluate-dtl-problem/{repository.ts,logger.ts,content-analysis-adapter.ts}
  - modules/imile/api/evaluate-dtl-problem/{composition.ts,handlers.ts}
  - modules/imile/tests/evaluate-dtl-problem/{evaluate-dtl-problem.feature,evaluate-dtl-problem.test.ts,invariants.property.test.ts,handlers.test.ts}
  - packages/contracts/imile/evaluate-dtl-problem.ts
Design (decided here, not re-derived by the worker):
  - **Only G0 (completeness) is mechanical domain logic** — doc 07 §5-2's own words: "ناقص → بشري فوراً" (incomplete → human immediately). Completeness = evidence_urls non-empty AND (customer_text OR driver_text present) AND raised_at present. Fail → engine_decision 'human', no port call, gate_result records only G0 (G1-G4 never evaluated).
  - **G1-G4 are NOT reimplemented as domain rules** — each genuinely requires content understanding this slice cannot build honestly: G1 ("type/evidence conflict → rejected") needs reading the evidence to know if it matches the claimed problem_type; G2 is OCR with sender discrimination; G3 is reading a customer's decision in the driver's handwriting — doc 07 calls this "أخطر حالة" (the most critical case) precisely because it needs real evidence FROM the customer; G4 measures driver responsiveness from the shipment's route/trajectory ("بطء متكرر → علامة" — repeated slowness → a flag, no defined numeric threshold anywhere in the package). Building any of these as invented business rules would violate "never invent a business rule not in the docs." Instead: a `DtlContentAnalysisPort.evaluate(evidence)` port, called only when G0 passes, returns the G1-G4 gate_result plus the final `accept|reject|human|reclassify` + confidence + reason — the engine trusts the port's decision verbatim, exactly as `PullShipments` trusted its portal port's data verbatim.
  - `content-analysis-adapter.ts` implements the port two ways, same shape as `portal-adapter.ts`: a `FakeDtlContentAnalysisPort` (every test) and `NotConfiguredDtlContentAnalysisPort` (production default — throws `PortNotConfiguredError`; no OCR/handwriting-analysis vendor has been chosen, file this as a new G-01 row in `docs/notes/2026-09-24-imile-agent-scenario.md` §4, same class as the D-149 portal-adapter gap, requesting a GM decision on the vendor before a real implementation is buildable).
  - **Never sets `closed_by`.** ADR-27 auto-close needs a `level = 1` row in `imile.dtl_rule_autonomy` for the (problem_type, decision_kind) pair — every row starts at `level = 0` (13B, no promotion mechanism built anywhere yet) — so auto-close is unreachable today regardless; this slice writes `closed_by = null` unconditionally and does not touch `imile.dtl_rule_autonomy` at all. `reject` is never auto-closed by rule (13B `reject_never_auto` CHECK) — this slice's own behavior (never auto-closes anything) is consistent with, not a violation of, that rule.
  - **No update path.** `imile.dtl_problems` has no `version` column and this slice never needs one — it only INSERTs (`auditor_decision`/`decided_at`/`actual_outcome`/`rule_was_correct`/`closed_by`/`re_reviewed_at`/`re_review_agreed` all stay their column defaults, i.e. null — the auditor-decision update path is §5-3's own future slice).
  - **No entity_id / outbox write** — `imile.dtl_problems` has no `entity_id` column, same class as the already-filed rows e/g on `imile.agent_health`/`imile.shipments`; file a new G-01 row for this table too, don't invent a workaround.
  - **Audit row** — one `platform.audit_log` insert per `dtl_problems` row, same hash-chain mechanism `pull-shipments` already replicated from `report-agent-health`.
  - **Idempotency-Key required** on the API layer, same 400/409/200 shape as `pull-shipments`.
Migration number: none — no schema change this slice (no version column needed, see above).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 / 07.
