// packages/contracts/tests/billing-post-journal.test.ts — WBS 4.20 (lane 2), contract-first wave 1
// (Master, ADR-0005 §3). RED before pg-builder-core's handlers.ts (WBS 4.20) exists — pure Zod
// schema + registry tests, no DB, no I/O; precedent:
// modules/billing/tests/chart-of-accounts/contract.test.ts /
// modules/billing/tests/dimensions/contract.test.ts.
//
// Covers billing/post-journal.ts: JOURNAL_ENTRY_TYPES, JournalLineInputSchema (one_side_only),
// PostJournalInputSchema (lines >= 2), ReverseJournalInputSchema, AdjustJournalInputSchema, and
// the 3 registered ROUTES (post/reverse/adjust-journal).
//
// The AMOUNT pattern (^\d{1,11}(?:\.\d{1,3})?$) is the same numeric(14,3)-as-decimal-string shape
// used throughout this package (e.g. packages/contracts/wms/receive-inbound.ts's
// NON_NEGATIVE_QUANTITY) — 1-11 integer digits, optional '.' plus 1-3 fractional digits, no sign.

import { describe, expect, it } from 'vitest';

import {
  AdjustJournalInputSchema,
  JOURNAL_ENTRY_TYPES,
  JournalLineInputSchema,
  PostJournalInputSchema,
  ReverseJournalInputSchema,
  ROUTES as BILLING_POST_JOURNAL_ROUTES,
} from '../billing/post-journal.js';
import { registry } from '../index.js';

const VALID_ACCOUNT_ID_1 = '00000000-0000-4000-8000-00000004201a';
const VALID_ACCOUNT_ID_2 = '00000000-0000-4000-8000-00000004201b';
const VALID_ENTITY_ID = '00000000-0000-4000-8000-00000004201c';
const VALID_PERIOD_ID = '00000000-0000-4000-8000-00000004201d';
const VALID_CORRELATION_ID = '00000000-0000-4000-8000-00000004201e';
const VALID_ENTRY_ID = '00000000-0000-4000-8000-00000004201f';

const debitLine = { accountId: VALID_ACCOUNT_ID_1, debit: '100.500' };
const creditLine = { accountId: VALID_ACCOUNT_ID_2, credit: '100.500' };

describe('JOURNAL_ENTRY_TYPES', () => {
  it('is exactly the 7 values of A0 §1 row 4, verbatim, in order', () => {
    expect(JOURNAL_ENTRY_TYPES).toEqual([
      'manual',
      'recurring',
      'reversing',
      'adjustment',
      'accrual',
      'prepayment',
      'closing',
    ]);
  });
});

describe('JournalLineInputSchema — the AMOUNT numeric(14,3) string pattern', () => {
  it.each(['100', '100.5', '100.50', '100.500', '0.001', '12345678901'])(
    'accepts a well-formed amount %s',
    (amount) => {
      expect(JournalLineInputSchema.safeParse({ accountId: VALID_ACCOUNT_ID_1, debit: amount }).success).toBe(
        true,
      );
    },
  );

  it.each(['123456789012', '100.1234', '-1', '1.', 'abc', '', '1,000'])(
    'rejects a malformed amount %s',
    (amount) => {
      expect(JournalLineInputSchema.safeParse({ accountId: VALID_ACCOUNT_ID_1, debit: amount }).success).toBe(
        false,
      );
    },
  );
});

describe('JournalLineInputSchema — one_side_only (01:1212)', () => {
  it('accepts a debit-only line', () => {
    expect(JournalLineInputSchema.safeParse(debitLine).success).toBe(true);
  });

  it('accepts a credit-only line', () => {
    expect(JournalLineInputSchema.safeParse(creditLine).success).toBe(true);
  });

  it('rejects a line with both debit and credit set (positive)', () => {
    expect(
      JournalLineInputSchema.safeParse({ accountId: VALID_ACCOUNT_ID_1, debit: '100', credit: '50' })
        .success,
    ).toBe(false);
  });

  it('rejects a line with neither debit nor credit set', () => {
    expect(JournalLineInputSchema.safeParse({ accountId: VALID_ACCOUNT_ID_1 }).success).toBe(false);
  });

  it('rejects a line with debit = "0" and no credit (not strictly positive)', () => {
    expect(JournalLineInputSchema.safeParse({ accountId: VALID_ACCOUNT_ID_1, debit: '0' }).success).toBe(
      false,
    );
  });

  it('rejects a line with debit = "0.000" and credit = "0.000" (both present, neither positive)', () => {
    expect(
      JournalLineInputSchema.safeParse({ accountId: VALID_ACCOUNT_ID_1, debit: '0.000', credit: '0.000' })
        .success,
    ).toBe(false);
  });

  it('accepts optional description and dimensions on a valid line', () => {
    const result = JournalLineInputSchema.safeParse({
      ...debitLine,
      description: 'line note',
      dimensions: [{ dimensionTypeId: VALID_ACCOUNT_ID_2, valueId: VALID_ACCOUNT_ID_1 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid accountId', () => {
    expect(JournalLineInputSchema.safeParse({ accountId: 'not-a-uuid', debit: '100' }).success).toBe(
      false,
    );
  });
});

describe('PostJournalInputSchema — lines must have at least 2 entries', () => {
  const base = {
    entityId: VALID_ENTITY_ID,
    periodId: VALID_PERIOD_ID,
    entryDate: '2026-01-15',
    entryType: 'manual',
    description: 'opening balances',
    correlationId: VALID_CORRELATION_ID,
  };

  it('rejects a single-line entry', () => {
    expect(PostJournalInputSchema.safeParse({ ...base, lines: [debitLine] }).success).toBe(false);
  });

  it('accepts a two-line entry (one debit, one credit)', () => {
    expect(
      PostJournalInputSchema.safeParse({ ...base, lines: [debitLine, creditLine] }).success,
    ).toBe(true);
  });

  it('accepts more than two lines', () => {
    const thirdLine = { accountId: VALID_ACCOUNT_ID_1, credit: '50' };
    expect(
      PostJournalInputSchema.safeParse({
        ...base,
        lines: [{ accountId: VALID_ACCOUNT_ID_1, debit: '150' }, creditLine, thirdLine],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty lines array', () => {
    expect(PostJournalInputSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
  });

  const POSTABLE_TYPES = JOURNAL_ENTRY_TYPES.filter((t) => t !== 'reversing' && t !== 'adjustment');

  it.each(POSTABLE_TYPES)('accepts entryType %s', (entryType) => {
    expect(
      PostJournalInputSchema.safeParse({ ...base, entryType, lines: [debitLine, creditLine] })
        .success,
    ).toBe(true);
  });

  it.each(['reversing', 'adjustment'] as const)(
    'rejects entryType %s — corrections go through ReverseJournal / AdjustJournal only (ADR-0004 D1 4)',
    (entryType) => {
      expect(
        PostJournalInputSchema.safeParse({ ...base, entryType, lines: [debitLine, creditLine] })
          .success,
      ).toBe(false);
    },
  );

  it('rejects an entryType not in JOURNAL_ENTRY_TYPES', () => {
    expect(
      PostJournalInputSchema.safeParse({
        ...base,
        entryType: 'not_a_real_type',
        lines: [debitLine, creditLine],
      }).success,
    ).toBe(false);
  });

  it('accepts exactly the documented column list (entityId, periodId, entryDate, entryType, description, lines, correlationId) and no others', () => {
    const parsed = PostJournalInputSchema.parse({ ...base, lines: [debitLine, creditLine] });
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'description', 'entityId', 'entryDate', 'entryType', 'lines', 'periodId'].sort(),
    );
  });

  it.each(['entityId', 'periodId', 'entryDate', 'entryType', 'description', 'lines', 'correlationId'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...base, lines: [debitLine, creditLine] } as Record<string, unknown>;
      delete input[field];
      expect(PostJournalInputSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects an empty description', () => {
    expect(
      PostJournalInputSchema.safeParse({ ...base, description: '', lines: [debitLine, creditLine] })
        .success,
    ).toBe(false);
  });
});

describe('ReverseJournalInputSchema — valid/invalid input', () => {
  const minimalValidInput = {
    entryId: VALID_ENTRY_ID,
    expectedVersion: 1,
    periodId: VALID_PERIOD_ID,
    entryDate: '2026-01-20',
    description: 'reversal of entry',
    correlationId: VALID_CORRELATION_ID,
  };

  it('parses the minimal required fields successfully', () => {
    expect(ReverseJournalInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly the documented column list and no others', () => {
    const parsed = ReverseJournalInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'description', 'entryDate', 'entryId', 'expectedVersion', 'periodId'].sort(),
    );
  });

  it('rejects expectedVersion = 0 (must be >= 1, MIN_VERSION)', () => {
    expect(
      ReverseJournalInputSchema.safeParse({ ...minimalValidInput, expectedVersion: 0 }).success,
    ).toBe(false);
  });

  it.each(['entryId', 'expectedVersion', 'periodId', 'entryDate', 'description', 'correlationId'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(ReverseJournalInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('AdjustJournalInputSchema — valid/invalid input', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    periodId: VALID_PERIOD_ID,
    entryDate: '2026-01-20',
    description: 'correction of entry',
    lines: [debitLine, creditLine],
    correlationId: VALID_CORRELATION_ID,
  };

  it('parses the minimal required fields successfully', () => {
    expect(AdjustJournalInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly the documented column list and no others', () => {
    const parsed = AdjustJournalInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'description', 'entityId', 'entryDate', 'lines', 'periodId'].sort(),
    );
  });

  it('rejects a single-line entry (same MIN_LINES rule as PostJournalInputSchema)', () => {
    expect(
      AdjustJournalInputSchema.safeParse({ ...minimalValidInput, lines: [debitLine] }).success,
    ).toBe(false);
  });

  it.each(['entityId', 'periodId', 'entryDate', 'description', 'lines', 'correlationId'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(AdjustJournalInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('billing/post-journal ROUTES — registered on the shared production registry', () => {
  const expectedPaths = [
    '/billing/post-journal/post-journal',
    '/billing/post-journal/reverse-journal',
    '/billing/post-journal/adjust-journal',
  ];

  it('declares exactly 3 POST routes', () => {
    expect(BILLING_POST_JOURNAL_ROUTES.length).toBe(3);
    for (const route of BILLING_POST_JOURNAL_ROUTES) {
      expect(route.method).toBe('POST');
    }
  });

  it.each(expectedPaths)('registers %s on the shared registry with an Idempotency-Key header', (path) => {
    const document = registry.toOpenApiDocument();
    const pathItem = document.paths?.[path] as Record<string, unknown> | undefined;
    expect(pathItem, `${path} must be registered`).toBeDefined();
    const operation = pathItem?.post as
      | { parameters?: ReadonlyArray<{ name?: string; required?: boolean }> }
      | undefined;
    expect(operation, `${path} must be a POST operation`).toBeDefined();
    const idempotencyHeader = operation?.parameters?.find(
      (parameter) => parameter.name?.toLowerCase() === 'idempotency-key',
    );
    expect(idempotencyHeader, `${path} must declare the Idempotency-Key header`).toBeDefined();
    expect(idempotencyHeader?.required).toBe(true);
  });

  it('every route carries a Problem-bodied 400/409/422 response', () => {
    const document = registry.toOpenApiDocument();
    for (const path of expectedPaths) {
      const pathItem = document.paths?.[path] as
        | { post?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } }
        | undefined;
      const responses = pathItem?.post?.responses ?? {};
      for (const status of ['400', '409', '422']) {
        const schema = responses[status]?.content?.['application/json']?.schema;
        expect(schema, `${path} status ${status}`).toEqual({ $ref: '#/components/schemas/Problem' });
      }
    }
  });

  it('registers zero invariant violations for these routes (registry.checkInvariants())', () => {
    expect(registry.checkInvariants()).toEqual([]);
  });
});
