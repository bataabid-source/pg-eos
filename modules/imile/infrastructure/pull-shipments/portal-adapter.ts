// modules/imile/infrastructure/pull-shipments/portal-adapter.ts — WBS 3.14 (part 2).
//
// infrastructure/ layer: two implementations of ../../application/pull-shipments/ports.ts's
// `ImilePortalPort`.
//
// `NotConfiguredImilePortalAdapter` is the production wiring default
// (../../api/pull-shipments/composition.ts). It throws PortalNotConfiguredError, naming the
// D-149 external check as the reason the real Node+Playwright browser automation against the
// live iMile portal is not built yet: that capability check (DEL_MGR+SYSADMIN,
// docs/notes/2026-09-24-imile-agent-scenario.md §7) has not happened, so the portal's exact live
// capabilities stay unconfirmed. This is a deliberate, documented stub — not a placeholder
// pretending to work. Filed as a G-01/infra follow-up in CHANGELOG, same class as the part-1 gaps
// (e), (f).
//
// `FakeImilePortalAdapter` is a deterministic, in-memory adapter — the only adapter this slice
// can prove (brief). It is a production-code deliverable (used by any future caller that wants a
// fixed portal without standing up the live iMile session), but the RED test suites build their
// own inline fake instead of importing this class (modules/imile/tests/pull-shipments/
// pull-shipments.test.ts's own `fakePortal` helper) — this class is provided for completeness of
// the port's two documented implementations, not because the tests require it.

import { PortalNotConfiguredError } from '../../domain/pull-shipments/errors.js';
import type { ImilePortalPort } from '../../application/pull-shipments/ports.js';

const PORTAL_NOT_CONFIGURED_MESSAGE =
  'iMile live-portal adapter is not configured: the real Node+Playwright browser automation ' +
  'against the live iMile portal is out of scope for WBS 3.14 (part 2) — gated on the ' +
  'DEL_MGR+SYSADMIN capability check named in docs/notes/2026-09-24-imile-agent-scenario.md §7 ' +
  '(D-149), which has not happened yet. (Allowed: inject a FakeImilePortalAdapter, or wire the ' +
  'real adapter once D-149 lands.)';

/** Production wiring default — CLAUDE.md · AGENT CONSTRAINTS: never fabricate untested
 *  integration behaviour against a system whose capabilities are still unconfirmed. */
export class NotConfiguredImilePortalAdapter implements ImilePortalPort {
  fetchShipments(): Promise<readonly unknown[]> {
    return Promise.reject(new PortalNotConfiguredError(PORTAL_NOT_CONFIGURED_MESSAGE));
  }
}

/** Deterministic, in-memory ImilePortalPort — returns a fixed list of raw records (as-supplied,
 *  including malformed ones), never touches a network. */
export class FakeImilePortalAdapter implements ImilePortalPort {
  readonly #records: readonly unknown[];

  constructor(records: readonly unknown[] = []) {
    this.#records = records;
  }

  fetchShipments(): Promise<readonly unknown[]> {
    return Promise.resolve(this.#records);
  }
}
