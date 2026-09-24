// modules/platform/domain/maintain-site/invariants.ts — WBS 5.5a part 1 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/maintain-site/{create-site.ts,update-site.ts}) calls these BEFORE any DB
// write; a failed invariant throws a typed error from ./errors.ts. pg-tester adds property tests
// against these functions directly (P1, P2, P3 — see
// modules/platform/tests/maintain-site/invariants.property.test.ts).
//
// doc 36 §5-4 #2: chk_sites_kind and chk_sites_client_pickup_account (migration 0015) already
// enforce these two rules at the DB layer — this file enforces the SAME rules at the domain layer
// too (dual enforcement, not a new rule), so a caller gets a typed 422 instead of a raw `23514`
// constraint-violation Problem.

import { SiteAccountRequiredError } from './errors.js';

// migration 0015 chk_sites_kind — the five values SCR-HR-SHIFT-01 §2.4 names.
const VALID_SITE_KINDS = ['warehouse', 'office', 'client_pickup', 'housing', 'other'] as const;
const CLIENT_PICKUP_KIND = 'client_pickup';

/** P1: true iff `kind` is one of the five values `chk_sites_kind` allows. */
export function isValidKind(kind: string): boolean {
  return (VALID_SITE_KINDS as readonly string[]).includes(kind);
}

/** The five values `chk_sites_kind` allows, joined for a typed error's message — never
 *  hand-typed as a literal string that could drift from VALID_SITE_KINDS. */
export const VALID_SITE_KINDS_LIST = VALID_SITE_KINDS.join(', ');

/** P2 / chk_sites_client_pickup_account: throws SiteAccountRequiredError iff `kind ===
 *  'client_pickup'` and `accountId` is null/undefined. Never throws for any other kind,
 *  regardless of accountId. */
export function requiresAccount(kind: string, accountId: string | null | undefined): void {
  if (kind === CLIENT_PICKUP_KIND && (accountId === null || accountId === undefined)) {
    throw new SiteAccountRequiredError(
      `kind "${CLIENT_PICKUP_KIND}" requires accountId (chk_sites_client_pickup_account). ` +
        `(Allowed: a non-null accountId)`,
    );
  }
}

/** P3 / brief D5: true iff `radiusM` is undefined (the DB column default fires) or strictly
 *  positive. */
export function isValidRadius(radiusM: number | undefined): boolean {
  return radiusM === undefined || radiusM > 0;
}
