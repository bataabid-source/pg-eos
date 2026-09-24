// WBS 0.19 — named constants (CLAUDE.md AGENT CONSTRAINTS: no magic numbers).

// Fixed urgency rank order (Master decision 5): urgent > high > normal > everything else.
export const URGENCY_RANK: Readonly<Record<string, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
};

// Any urgency value not in URGENCY_RANK ranks after every named one.
export const UNKNOWN_URGENCY_RANK = Object.keys(URGENCY_RANK).length;

// Urgency values that get the warm/destructive presentational accent (Master decision 5, 2).
export const ACCENTED_URGENCIES: ReadonlySet<string> = new Set(['urgent', 'high']);

// KWD is a fixed 3-decimal currency (numeric(14,3), 01-Data-Model.sql's `char(3) default 'KWD'`
// convention) — cited here, not invented.
export const CURRENCY_CODE = 'KWD';

// The fixture item count for the populated mock client (Master decision 11).
export const MOCK_ITEM_COUNT = 4;

// TanStack Query cache key root for the Decision Inbox query.
export const DECISION_INBOX_QUERY_KEY = 'decision-inbox' as const;
