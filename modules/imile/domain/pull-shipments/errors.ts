// modules/imile/domain/pull-shipments/errors.ts — WBS 3.14 (part 2).
//
// Typed errors for the pull-shipments use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS; same discipline as modules/wms/domain/receive-inbound/errors.ts) — an
// `Error` subclass does NOT get its constructor name for free at runtime. The api/ layer
// (../../api/pull-shipments/handlers.ts) maps these to the Problem envelope.

/** Optimistic-lock conflict: `UPDATE imile.shipments ... WHERE id=$1 AND version=$2` matched zero
 *  rows — another concurrent pull cycle already advanced the shipment's version. Thrown from
 *  inside the write transaction; NOT caught internally (unlike PortalUnreachableError) — it
 *  propagates past the command's own boundary, same as the golden slice's own StaleVersionError.
 *  Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The injected ImilePortalPort could not reach the iMile portal (connection refused, timeout,
 *  session drop, etc). Caught INSIDE the pullShipments command: the pull cycle does not throw
 *  past its own boundary — it records a failed imile.agent_health row instead and returns a
 *  PullShipmentsResult of all-zero counts (brief, Scenario "The portal is unreachable"). */
export class PortalUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalUnreachableError';
  }
}

/** Thrown by ../../infrastructure/pull-shipments/portal-adapter.ts's
 *  `NotConfiguredImilePortalAdapter` — the production wiring default. The real Node+Playwright
 *  browser automation against the live iMile portal is out of scope for this slice: it is gated
 *  on the DEL_MGR+SYSADMIN capability check named in
 *  docs/notes/2026-09-24-imile-agent-scenario.md §7 (D-149), which has not happened yet. This is
 *  a deliberate, documented stub — not a placeholder pretending to work, and NOT caught by the
 *  application layer's PortalUnreachableError handling (it is a configuration/programming error,
 *  not a transient portal-reachability failure), so it propagates past the command boundary like
 *  any other unexpected error (api layer maps it to a generic 500). */
export class PortalNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortalNotConfiguredError';
  }
}

/** Every audit row this command writes (reviewer finding 5) needs an actor — `ctx.userId` ONLY,
 *  same discipline as this module's own report-agent-health part 1
 *  (../report-agent-health/errors.ts's own MissingActorError). A null/missing userId is a typed
 *  error, not a silent `null` written to platform.audit_log.user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
