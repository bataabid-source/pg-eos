// modules/imile/infrastructure/evaluate-dtl-problem/content-analysis-adapter.ts — WBS 3.17
// (part 1).
//
// infrastructure/ layer: two implementations of
// ../../application/evaluate-dtl-problem/ports.ts's `DtlContentAnalysisPort` — a not-configured
// production stub plus a fixed-result fake, the same two-implementation shape this module's other
// external-integration ports already use (brief, Deliver).
//
// `NotConfiguredDtlContentAnalysisPort` is the production wiring default
// (../../api/evaluate-dtl-problem/composition.ts). It throws PortNotConfiguredError: no OCR/
// handwriting-analysis vendor has been chosen yet for G1 (type/evidence conflict), G2 (OCR with
// sender discrimination), G3 (the customer's decision written in the driver's handwriting — doc 07
// calls this "أخطر حالة", the most critical case) or G4 (driver-responsiveness measurement from
// the shipment's route). This is a deliberate, documented stub — not a placeholder pretending to
// work. Filed as a G-01 row in docs/notes/2026-09-24-imile-agent-scenario.md §4 (row j), same
// class as this module's own D-149 portal-adapter gap.
//
// `FakeDtlContentAnalysisPort` is a deterministic, fixed-result adapter — the only adapter this
// slice can prove (brief). It holds one fixed `#result` and ignores its `evaluate()` argument
// (no call-tracking), so it backs the scenario that only needs a stand-in result (port-decides-
// reject) — a scenario asserting the port was called with specific evidence still needs its own
// call-tracking fake (round-1 finding 8).

import { PortNotConfiguredError } from '../../domain/evaluate-dtl-problem/errors.js';
import type { DtlContentAnalysisPort, DtlContentAnalysisResult } from '../../application/evaluate-dtl-problem/ports.js';

const PORT_NOT_CONFIGURED_MESSAGE =
  'DtlContentAnalysisPort is not configured: no OCR/handwriting-analysis vendor has been chosen ' +
  'yet for gates G1-G4 (doc 07 §5-2) — out of scope for WBS 3.17 (part 1). (Allowed: inject a ' +
  'FakeDtlContentAnalysisPort, or wire the real adapter once a vendor decision lands.)';

/** Production wiring default — CLAUDE.md · AGENT CONSTRAINTS: never fabricate untested content-
 *  analysis behaviour against a vendor that has not been chosen. */
export class NotConfiguredDtlContentAnalysisPort implements DtlContentAnalysisPort {
  evaluate(): Promise<DtlContentAnalysisResult> {
    return Promise.reject(new PortNotConfiguredError(PORT_NOT_CONFIGURED_MESSAGE));
  }
}

/** Deterministic, fixed-result DtlContentAnalysisPort — returns the SAME result for every
 *  evidence bag it is given, never touches a network. */
export class FakeDtlContentAnalysisPort implements DtlContentAnalysisPort {
  readonly #result: DtlContentAnalysisResult;

  constructor(result: DtlContentAnalysisResult) {
    this.#result = result;
  }

  evaluate(): Promise<DtlContentAnalysisResult> {
    return Promise.resolve(this.#result);
  }
}
