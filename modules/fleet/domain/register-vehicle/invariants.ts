// modules/fleet/domain/register-vehicle/invariants.ts — WBS 3.1.
//
// domain/ layer: pure invariant checks — no I/O, no Date.now()/new Date(), no Math.random()
// (CLAUDE.md · AGENT CONSTRAINTS). The application layer
// (../../application/register-vehicle/register-vehicle.ts) calls `hasExpiredDocument` AFTER the
// documents are inserted (registration itself is never blocked by an expired document — brief,
// Scenario "A vehicle registered with one expired document cannot be assigned"), to compute the
// result's `canBeAssigned`. pg-tester's property tests exercise this function directly
// (../../tests/register-vehicle/invariants.property.test.ts).
//
// pg-reviewer round 1, Finding 1: `new Date('YYYY-MM-DD')` parses to midnight UTC, so comparing it
// against the clock's raw instant reads a document expiring "today" as already-expired hours
// before Kuwait's own midnight. D-blueprint 06 line 1042 defines expired as
// `expiry_date < current_date` — today is NOT expired. Fixed the same way
// modules/hr/domain/register-employee/invariants.ts already fixed the driver half of this exact
// rule (INV-C4-1) after its own past reviewer FAIL: derive asOf's Kuwait-local calendar date as a
// plain `YYYY-MM-DD` string (pure `Intl.DateTimeFormat` call, no I/O) and compare it against each
// document's expiryDate as plain date strings — 01-Data-Model.sql:8 "التوقيت: timestamptz (UTC
// مخزَّن، Asia/Kuwait معروض)".

/** The one field this invariant needs from a document — a structural subset, not the full
 *  contract shape, so this file stays independent of packages/contracts. */
export interface ExpiryDated {
  readonly expiryDate: string;
}

const BUSINESS_TIME_ZONE = 'Asia/Kuwait' as const;

/** Pure: the Kuwait (business) calendar date of `instant`, as ISO `YYYY-MM-DD` — same technique as
 *  modules/hr/domain/register-employee/invariants.ts's own `businessDateOf`. `en-CA` is the
 *  shortest built-in Intl locale that formats as `YYYY-MM-DD` directly. Review-round 2 finding 2:
 *  this stays module-PRIVATE (not exported) — `hasExpiredDocument` and `expiredDocumentsOf` below
 *  are this module's only public surface for the Kuwait-date rule; a caller needing the expired
 *  subset uses `expiredDocumentsOf`, never re-derives the date itself. */
function businessDateOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The subset a document-typed caller needs to name the expired documents (assert-vehicle-
 *  assignable's own VehicleNotAssignableError params) — a structural superset of ExpiryDated.
 *  `docType` is optional here (not every caller of `hasExpiredDocument`, e.g. its own property
 *  tests, carries one) — the comparison itself never depends on it, only the returned label does. */
export interface DocTypeAndExpiry extends ExpiryDated {
  readonly docType?: string;
}

const UNKNOWN_DOC_TYPE = '' as const;

/** doc 40 INV-C4-1's vehicle half, review-round 2 finding 2: the ONE comparison implementation —
 *  returns every document whose expiryDate is strictly before `asOf`'s Kuwait-local calendar date
 *  (plain ISO `YYYY-MM-DD` string comparison, date-only, no time-of-day effect — D-blueprint 06
 *  line 1042: `expiry_date < current_date`; a document expiring exactly "today" in Kuwait is NOT
 *  expired). An empty array (or a non-array/garbage `documents` value) yields an empty result —
 *  never throws for any input, including malformed elements (a non-string expiryDate is skipped,
 *  not fatal). A document with no `docType` is still compared and, if expired, reported with
 *  `docType: ''` — the caller is `hasExpiredDocument`'s own boolean-only use, which never reads it.
 *  `hasExpiredDocument` below delegates to this. */
export function expiredDocumentsOf(
  documents: readonly DocTypeAndExpiry[],
  asOf: Date,
): Array<{ readonly docType: string; readonly expiryDate: string }> {
  if (!Array.isArray(documents)) return [];

  const today = businessDateOf(asOf);
  const expired: Array<{ readonly docType: string; readonly expiryDate: string }> = [];

  for (const document of documents) {
    if (document === null || typeof document !== 'object') continue;
    const expiryDate = (document as { readonly expiryDate?: unknown }).expiryDate;
    if (typeof expiryDate !== 'string') continue;
    const rawDocType = (document as { readonly docType?: unknown }).docType;
    const docType = typeof rawDocType === 'string' ? rawDocType : UNKNOWN_DOC_TYPE;
    if (expiryDate < today) expired.push({ docType, expiryDate });
  }

  return expired;
}

/** doc 40 INV-C4-1's vehicle half: true iff ANY document's expiryDate is strictly before `asOf`'s
 *  Kuwait-local calendar date. A one-line delegate to `expiredDocumentsOf` (review-round 2 finding
 *  2) — exactly ONE comparison implementation, not two. */
export function hasExpiredDocument(documents: readonly ExpiryDated[], asOf: Date): boolean {
  if (!Array.isArray(documents)) return false;
  return expiredDocumentsOf(documents, asOf).length > 0;
}
