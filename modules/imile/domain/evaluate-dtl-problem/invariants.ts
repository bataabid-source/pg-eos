// modules/imile/domain/evaluate-dtl-problem/invariants.ts — WBS 3.17 (part 1).
//
// domain/ layer: pure functions only — no I/O, no Date.now()/new Date(), no Math.random()
// (CLAUDE.md · AGENT CONSTRAINTS). The application layer
// (../../application/evaluate-dtl-problem/evaluate-dtl-problem.ts) calls `isG0Complete` for every
// raised problem BEFORE the content-analysis port is ever called. pg-tester's property tests
// exercise this directly (../../tests/evaluate-dtl-problem/invariants.property.test.ts).
//
// This is the ONLY mechanical domain logic this slice builds (brief, Design: "Only G0
// (completeness) is mechanical domain logic ... G1-G4 are NOT reimplemented as domain rules" —
// each genuinely requires content understanding this slice cannot build honestly; see
// DtlContentAnalysisPort in ../../application/evaluate-dtl-problem/ports.ts).

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** doc 07 §5-2, G0: "اكتمال البيانات (صورة · نص · توقيت)" — completeness of evidence/text/timing.
 *  Completeness = evidence_urls non-empty AND (customer_text OR driver_text present) AND
 *  raised_at present (brief, Design line). Never throws for ANY input, including primitives, null,
 *  arrays and garbage objects — malformed input is data, not a crash (same discipline as
 *  ../../domain/pull-shipments/invariants.ts's `validatePortalRecord`). */
export function isG0Complete(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;

  // pg-reviewer review-round 2 finding 5: a blank string is not evidence and not a timestamp,
  // matching the contract's own non-empty rule for evidenceUrls (review-round 1 finding 10) — a
  // value that would already be rejected at the API boundary must not read as "complete" when
  // this function is called directly (e.g. from a test, or a future caller that bypasses the
  // contract).
  const evidenceUrls = raw['evidence_urls'];
  const hasEvidence =
    Array.isArray(evidenceUrls) && evidenceUrls.length > 0 && evidenceUrls.every(isNonEmptyString);

  const customerText = raw['customer_text'];
  const driverText = raw['driver_text'];
  const hasText = isNonEmptyString(customerText) || isNonEmptyString(driverText);

  const raisedAt = raw['raised_at'];
  const hasRaisedAt = isNonEmptyString(raisedAt);

  return hasEvidence && hasText && hasRaisedAt;
}
