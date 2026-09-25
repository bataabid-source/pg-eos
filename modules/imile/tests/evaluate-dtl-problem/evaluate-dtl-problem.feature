# modules/imile/tests/evaluate-dtl-problem/evaluate-dtl-problem.feature — WBS 3.17 (part 1).
# Every scenario below is executed by
# modules/imile/tests/evaluate-dtl-problem/evaluate-dtl-problem.test.ts.
# Source: docs/notes/slice-briefs/_slice-3.17.brief.md "Scenario" block (verbatim);
# docs/package/07-iMile-Automation.md §5-1/§5-2 (lines 211-227); database/schema/01-Data-Model.sql:
# 1378-1398 (imile.dtl_problems); database/schema/13B-Schema-Reference-Consolidation.sql:2382-2394
# (chk_dtl_problems_engine_decision/auditor_decision — the only four allowed decision values).

Feature: DTL live audit engine evaluates a raised shipment problem within its gate pipeline

  Scenario: G0-incomplete-goes-to-human — a problem missing required evidence fails G0 (completeness) and goes to a human
    Given a raised DTL problem for tracking number "SHP-2001" with no evidence URLs and no customer or driver text
    When the engine evaluates the problem
    Then the engine_decision is "human"
    And the reason names G0 (completeness) as the failing gate
    And no content-analysis port call is made — an incomplete report never reaches gates G1-G4

  Scenario: complete-problem-delegates-to-port-verbatim — a complete problem is evaluated end to end by the content-analysis port (G1-G4)
    Given a raised DTL problem for tracking number "SHP-2002" with evidence URLs, customer text, driver text and a raised_at timestamp
    When the engine evaluates the problem
    Then G0 passes and the content-analysis port is called exactly once with the problem's evidence
    And the engine_decision, engine_confidence and engine_reason come from the port's own result, unmodified
    And one imile.dtl_problems row is inserted with gate_result recording G0 pass plus the port's G1-G4 results

  Scenario: port-decides-reject-never-auto-closed — the content-analysis port itself decides reject
    Given a complete raised DTL problem
    And the content-analysis port returns decision "reject" with its own confidence and reason
    When the engine evaluates the problem
    Then the inserted row's engine_decision is "reject"
    And closed_by stays null — this slice never auto-closes anything, "reject" or otherwise (ADR-27 autonomy is a later slice)

  Scenario: port-not-configured-throws-and-writes-nothing — the content-analysis port is not configured (production default, no OCR/handwriting vendor decision yet)
    Given a complete raised DTL problem
    And the content-analysis port is the NotConfiguredDtlContentAnalysisPort stub
    When the engine evaluates the problem
    Then the call throws PortNotConfiguredError, mapped to a 500 at the API boundary
    And no imile.dtl_problems row is written — G0 passing alone is never enough to fabricate a G1-G4 result
