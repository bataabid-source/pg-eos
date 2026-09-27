// packages/events/tests/catalog.test.ts — contract-first wave 1 (Master, ADR-0005 §3), WBS 4.1b
// part 2 / 4.19 / 4.20. Asserts the 9 new event names the Master added ahead of their publishers
// (billing/dimensions part 2, billing/accounting-periods, billing/post-journal) are present exactly
// once in EVENT_CATALOG and match the doc 40 §B3 naming convention
// `<module>.<aggregate>.<past_tense>`.

import { describe, expect, it } from 'vitest';

import { EVENT_CATALOG } from '../catalog.js';

const NEW_EVENT_NAMES = [
  'billing.dimension_value.created',
  'billing.dimension_value.deactivated',
  'billing.fiscal_year.created',
  'billing.accounting_period.opened',
  'billing.accounting_period.closed',
  'billing.accounting_period.locked',
  'billing.accounting_period.reopened',
  'billing.journal_entry.posted',
  'billing.journal_entry.reversed',
  'billing.journal_entry.adjusted',
] as const;

const EVENT_NAME_PATTERN = /^billing\.[a-z_]+\.[a-z_]+$/;

describe('EVENT_CATALOG — wave-1 contract-first billing events', () => {
  it.each(NEW_EVENT_NAMES)('contains %s exactly once', (eventName) => {
    const occurrences = EVENT_CATALOG.filter((entry) => entry === eventName);
    expect(occurrences).toHaveLength(1);
  });

  it.each(NEW_EVENT_NAMES)('%s matches the doc 40 §B3 naming convention', (eventName) => {
    expect(eventName).toMatch(EVENT_NAME_PATTERN);
  });

  it('declares no duplicate event name anywhere in the catalog', () => {
    const unique = new Set(EVENT_CATALOG);
    expect(unique.size).toBe(EVENT_CATALOG.length);
  });
});
