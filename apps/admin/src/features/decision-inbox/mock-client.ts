// WBS 0.19 — mock DecisionsClient implementation (Master decision 3). No backend endpoint exists
// yet (platform is lane 2's lock for this task) — this fixture stands in until a real
// `list-decisions` read query and an HTTP host exist.
import { MOCK_ITEM_COUNT } from './constants';
import { DecisionListSchema } from './contract';
import type { DecisionItem } from './contract';
import type { DecisionsClient } from './client';

// MOCK_ITEM_COUNT fixture items: at least one with financialImpact === null, at least one with
// urgency 'urgent'/'high', at least one with urgency 'normal' (brief requirement). Deliberately
// NOT in sorted order (fix round 2, finding 1) — the raw array must differ from the screen's
// expected sorted order so the comparator (sortDecisions) is actually exercised by the tests, not
// just reproduced by coincidence: null-impact item first, then the two impact-tied items in the
// "wrong" order relative to their urgency tie-break.
const FIXTURE: readonly DecisionItem[] = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'expense_approval',
    titleAr: 'اعتماد مصروف تشغيلي',
    context: { costCenter: 'CC-02' },
    financialImpact: null,
    urgency: 'normal',
    assignedRole: 'SYSADMIN',
    status: 'open',
    dueAt: null,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'cod_variance',
    titleAr: 'فرق تحصيل نقدي',
    context: { route: 'RT-14', variance: 500 },
    financialImpact: '500.000',
    urgency: 'high',
    assignedRole: 'SYSADMIN',
    status: 'open',
    dueAt: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'price_exception',
    titleAr: 'استثناء سعر بيع',
    context: { sku: 'SKU-8831', requestedDiscountPct: 12 },
    financialImpact: '1500.250',
    urgency: 'normal',
    assignedRole: 'SYSADMIN',
    status: 'open',
    dueAt: null,
  },
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'invoice_approval',
    titleAr: 'اعتماد فاتورة مورد',
    context: { invoiceNumber: 'INV-2044', supplier: 'شركة الخليج للتوريد' },
    financialImpact: '1500.250',
    urgency: 'urgent',
    assignedRole: 'SYSADMIN',
    status: 'open',
    dueAt: '2026-09-25T12:00:00.000Z',
  },
] as const;

if (FIXTURE.length !== MOCK_ITEM_COUNT) {
  throw new RangeError(
    `mock-client fixture length ${FIXTURE.length} does not match MOCK_ITEM_COUNT ${MOCK_ITEM_COUNT}`,
  );
}

// Dev-time contract check (Master decision 2): parse the fixture through the same schema a real
// HTTP client's response would go through, so the mock and the future real payload are validated
// identically.
export const mockClient: DecisionsClient = {
  listOpenDecisions: () => Promise.resolve(DecisionListSchema.parse([...FIXTURE])),
};

export const emptyMockClient: DecisionsClient = {
  listOpenDecisions: () => Promise.resolve(DecisionListSchema.parse([])),
};
