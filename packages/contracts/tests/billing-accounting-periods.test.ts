// packages/contracts/tests/billing-accounting-periods.test.ts — WBS 4.19 (lane 2), contract-first
// wave 1 (Master, ADR-0005 §3). RED before pg-builder-core's handlers.ts (WBS 4.19) exists —
// these are pure Zod schema + registry tests, no DB, no I/O; precedent:
// modules/billing/tests/chart-of-accounts/contract.test.ts /
// modules/billing/tests/dimensions/contract.test.ts.
//
// Covers billing/accounting-periods.ts: FiscalYearInputSchema, AccountingPeriodInputSchema,
// OpenPeriodInputSchema, ClosePeriodInputSchema, LockPeriodInputSchema, ReopenPeriodInputSchema,
// and the 5 registered ROUTES (create-fiscal-year, open/close/lock/reopen-period).

import { describe, expect, it } from 'vitest';

import {
  ACCOUNTING_PERIOD_STATUSES,
  AccountingPeriodInputSchema,
  ClosePeriodInputSchema,
  FiscalYearInputSchema,
  LockPeriodInputSchema,
  OpenPeriodInputSchema,
  ReopenPeriodInputSchema,
  CreateFiscalYearInputSchema,
  ROUTES as BILLING_ACCOUNTING_PERIODS_ROUTES,
} from '../billing/accounting-periods.js';
import { registry } from '../index.js';

const VALID_ENTITY_ID = '00000000-0000-4000-8000-0000000419a1';
const VALID_FISCAL_YEAR_ID = '00000000-0000-4000-8000-0000000419a2';
const VALID_PERIOD_ID = '00000000-0000-4000-8000-0000000419a3';
const VALID_CORRELATION_ID = '00000000-0000-4000-8000-0000000419a4';

describe('ACCOUNTING_PERIOD_STATUSES', () => {
  it('is exactly open, closed, locked, in that order (ADR-0004 D1 5)', () => {
    expect(ACCOUNTING_PERIOD_STATUSES).toEqual(['open', 'closed', 'locked']);
  });
});

describe('FiscalYearInputSchema — valid input', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  };

  it('parses the minimal required fields successfully', () => {
    expect(FiscalYearInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly the documented column list (entityId, startDate, endDate) and no others', () => {
    const parsed = FiscalYearInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(['endDate', 'entityId', 'startDate'].sort());
  });

  it('rejects a startDate after endDate (isOrderedRange)', () => {
    const result = FiscalYearInputSchema.safeParse({
      ...minimalValidInput,
      startDate: '2026-12-31',
      endDate: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('accepts startDate equal to endDate (boundary of isOrderedRange)', () => {
    const result = FiscalYearInputSchema.safeParse({
      ...minimalValidInput,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
    });
    expect(result.success).toBe(true);
  });
});

describe('FiscalYearInputSchema — invalid input is rejected', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  };

  it.each([
    ['entityId', 'not-a-uuid'],
    ['startDate', '2026-13-01'], // month 13 does not exist
    ['startDate', 'not-a-date'],
    ['endDate', 'not-a-date'],
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidInput, [field]: badValue };
    expect(FiscalYearInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['entityId', 'startDate', 'endDate'])('rejects a missing required field %s', (field) => {
    const input = { ...minimalValidInput } as Record<string, unknown>;
    delete input[field];
    expect(FiscalYearInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('AccountingPeriodInputSchema — valid input', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    fiscalYearId: VALID_FISCAL_YEAR_ID,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'open',
  };

  it('parses the minimal required fields successfully', () => {
    expect(AccountingPeriodInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly the documented column list (entityId, fiscalYearId, startDate, endDate, status) and no others', () => {
    const parsed = AccountingPeriodInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['endDate', 'entityId', 'fiscalYearId', 'startDate', 'status'].sort(),
    );
  });

  it.each(ACCOUNTING_PERIOD_STATUSES)('accepts status value %s', (status) => {
    expect(AccountingPeriodInputSchema.safeParse({ ...minimalValidInput, status }).success).toBe(
      true,
    );
  });
});

describe('AccountingPeriodInputSchema — invalid input is rejected', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    fiscalYearId: VALID_FISCAL_YEAR_ID,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'open',
  };

  it.each([
    ['entityId', 'not-a-uuid'],
    ['fiscalYearId', 'not-a-uuid'],
    ['status', 'pending'], // not one of open|closed|locked
    ['status', 'OPEN'], // wrong case — the enum is lowercase only
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidInput, [field]: badValue };
    expect(AccountingPeriodInputSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a startDate after endDate', () => {
    const result = AccountingPeriodInputSchema.safeParse({
      ...minimalValidInput,
      startDate: '2026-01-31',
      endDate: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  it.each(['entityId', 'fiscalYearId', 'startDate', 'endDate', 'status'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(AccountingPeriodInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('OpenPeriodInputSchema — valid/invalid input', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    fiscalYearId: VALID_FISCAL_YEAR_ID,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    correlationId: VALID_CORRELATION_ID,
  };

  it('parses the minimal required fields successfully', () => {
    expect(OpenPeriodInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly the documented column list and no others', () => {
    const parsed = OpenPeriodInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'endDate', 'entityId', 'fiscalYearId', 'startDate'].sort(),
    );
  });

  it('rejects a startDate after endDate', () => {
    expect(
      OpenPeriodInputSchema.safeParse({
        ...minimalValidInput,
        startDate: '2026-01-31',
        endDate: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it.each(['entityId', 'fiscalYearId', 'startDate', 'endDate', 'correlationId'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(OpenPeriodInputSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects a non-uuid correlationId', () => {
    expect(
      OpenPeriodInputSchema.safeParse({ ...minimalValidInput, correlationId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });
});

describe.each([
  ['ClosePeriodInputSchema', ClosePeriodInputSchema],
  ['LockPeriodInputSchema', LockPeriodInputSchema],
  ['ReopenPeriodInputSchema', ReopenPeriodInputSchema],
])('%s — the shared periodId/expectedVersion/correlationId transition shape', (name, schema) => {
  const minimalValidInput = {
    periodId: VALID_PERIOD_ID,
    expectedVersion: 1,
    correlationId: VALID_CORRELATION_ID,
  };

  it(`${name}: parses the minimal required fields successfully`, () => {
    expect(schema.safeParse(minimalValidInput).success).toBe(true);
  });

  it(`${name}: accepts exactly periodId, expectedVersion, correlationId and no others`, () => {
    const parsed = schema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'expectedVersion', 'periodId'].sort(),
    );
  });

  it(`${name}: rejects expectedVersion = 0 (must be >= 1, MIN_VERSION)`, () => {
    expect(schema.safeParse({ ...minimalValidInput, expectedVersion: 0 }).success).toBe(false);
  });

  it(`${name}: rejects a non-integer expectedVersion`, () => {
    expect(schema.safeParse({ ...minimalValidInput, expectedVersion: 1.5 }).success).toBe(false);
  });

  it(`${name}: rejects a negative expectedVersion`, () => {
    expect(schema.safeParse({ ...minimalValidInput, expectedVersion: -1 }).success).toBe(false);
  });

  it(`${name}: rejects a non-uuid periodId`, () => {
    expect(schema.safeParse({ ...minimalValidInput, periodId: 'not-a-uuid' }).success).toBe(false);
  });

  it(`${name}: rejects a non-uuid correlationId`, () => {
    expect(schema.safeParse({ ...minimalValidInput, correlationId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it.each(['periodId', 'expectedVersion', 'correlationId'])(
    `${name}: rejects a missing required field %s`,
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(schema.safeParse(input).success).toBe(false);
    },
  );
});

describe('billing/accounting-periods ROUTES — registered on the shared production registry', () => {
  const expectedPaths = [
    '/billing/accounting-periods/create-fiscal-year',
    '/billing/accounting-periods/open-period',
    '/billing/accounting-periods/close-period',
    '/billing/accounting-periods/lock-period',
    '/billing/accounting-periods/reopen-period',
  ];

  it('declares exactly 5 POST routes', () => {
    expect(BILLING_ACCOUNTING_PERIODS_ROUTES.length).toBe(5);
    for (const route of BILLING_ACCOUNTING_PERIODS_ROUTES) {
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

describe('CreateFiscalYearInputSchema — FiscalYearInput plus correlationId (SCR-ACC-01 #3)', () => {
  const input = {
    entityId: '00000000-0000-4000-8000-000000041901',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    correlationId: '00000000-0000-4000-8000-000000041902',
  };

  it('parses and carries exactly entityId, startDate, endDate, correlationId', () => {
    expect(Object.keys(CreateFiscalYearInputSchema.parse(input)).sort()).toEqual(
      ['correlationId', 'endDate', 'entityId', 'startDate'],
    );
  });

  it('rejects a missing correlationId and a reversed date range', () => {
    const withoutCorrelation = { entityId: input.entityId, startDate: input.startDate, endDate: input.endDate };
    expect(CreateFiscalYearInputSchema.safeParse(withoutCorrelation).success).toBe(false);
    expect(
      CreateFiscalYearInputSchema.safeParse({ ...input, startDate: '2027-01-01' }).success,
    ).toBe(false);
  });
});
