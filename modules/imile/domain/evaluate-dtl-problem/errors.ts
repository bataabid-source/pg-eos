// modules/imile/domain/evaluate-dtl-problem/errors.ts — WBS 3.17 (part 1).
//
// Typed errors for the evaluate-dtl-problem use case. Every class sets `name` explicitly
// (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free
// at runtime. The api/ layer (../../api/evaluate-dtl-problem/handlers.ts) maps these to the
// Problem envelope.

/** Thrown by ../../infrastructure/evaluate-dtl-problem/content-analysis-adapter.ts's
 *  `NotConfiguredDtlContentAnalysisPort` — the production wiring default. No OCR/handwriting-
 *  analysis vendor has been chosen yet (brief, Design: "file this as a new G-01 row"). NOT caught
 *  by the application layer — it propagates past the command boundary like any other unexpected
 *  error (api layer maps it to a generic 500), and no imile.dtl_problems row is written (brief,
 *  Scenario "port-not-configured-throws-and-writes-nothing"). */
export class PortNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortNotConfiguredError';
  }
}

/** every command's actor is `ctx.userId` ONLY — same discipline as this module's own
 *  pull-shipments/report-agent-health precedents. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log.user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** Thrown by ../../application/evaluate-dtl-problem/evaluate-dtl-problem.ts when
 *  `DtlContentAnalysisPort.evaluate`'s own `gateResult` is not a plain object — the port's only
 *  documented shape (ports.ts's `DtlContentAnalysisResult`). A non-object `gateResult` is a
 *  contract violation, not an invented shape to wrap under a made-up key: this throws before any
 *  imile.dtl_problems row is written, and the outer transaction rolls back (round-1 finding 2). */
export class InvalidPortResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPortResultError';
  }
}
